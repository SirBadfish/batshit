import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSkill: vi.fn(),
  commands: new Map<string, Record<string, unknown>>()
}))

vi.mock('../skillRegistry', () => ({
  getSkill: mocks.getSkill,
  evaluateSkillDependencies: vi.fn()
}))

// The real access gate runs (BL-75); only the command records it reads are faked.
vi.mock('$lib/server/redis', () => ({
  redis: {
    keys: vi.fn(async (pattern: string) =>
      Array.from(mocks.commands.keys()).filter((key) => key.startsWith(pattern.replace(/\*$/, '')))
    ),
    json: {
      get: vi.fn(async (key: string) => mocks.commands.get(key) ?? null)
    }
  }
}))

import {
  buildSkillScriptCommand,
  executeSkillRuntimeAction,
  findBundleFileByPath,
  readSkillBundleFileText,
  resolveBundleFileAbsolutePath,
  resolveSkillRuntimeForTool
} from '../skillRuntimeToolService'

const PRIMARY = { kind: 'agent', agentId: 'agent-1' } as const

function seedSkillCommand(skillId: string, access: Record<string, unknown>) {
  mocks.commands.set(`slash_command:josh:${skillId}`, {
    id: skillId,
    name: skillId,
    displayName: 'Skill Alpha',
    type: 'skill',
    is_active: true,
    can_be_invoked_in_chat: true,
    skill_id: skillId,
    enabled_for_all_agents: false,
    enabled_agent_ids: [],
    ...access
  })
}

describe('skillRuntimeToolService', () => {
  beforeEach(() => {
    mocks.getSkill.mockReset()
    mocks.commands.clear()
    seedSkillCommand('skill_alpha', { enabled_agent_ids: ['agent-1'] })
    seedSkillCommand('nonexistent', { enabled_agent_ids: ['agent-1'] })
  })

  it('resolves skill runtime for tool with references/scripts in bundleFiles', async () => {
    mocks.getSkill.mockResolvedValue({
      id: 'skill-alpha',
      name: 'skill-alpha',
      user_id: 'josh',
      skill_markdown: '# Skill',
      created_at: '2026-02-20T00:00:00.000Z',
      updated_at: '2026-02-20T00:00:00.000Z',
      bundle_files: [
        {
          path: 'references/guide.md',
          kind: 'reference',
          encoding: 'utf8',
          content: 'Guide',
          sha256: 'x',
          size: 5
        },
        {
          path: 'scripts/run.sh',
          kind: 'script',
          encoding: 'utf8',
          content: 'echo hi',
          sha256: 'y',
          size: 7
        }
      ]
    })

    const result = await resolveSkillRuntimeForTool('josh', 'skill-alpha', PRIMARY)

    expect(result.runtime).not.toBeNull()
    expect(result.error).toBeNull()
    const refs = result.runtime!.bundleFiles.filter((f) => f.kind === 'reference')
    const scripts = result.runtime!.bundleFiles.filter((f) => f.kind === 'script')
    expect(refs.map((f) => f.path)).toEqual(['references/guide.md'])
    expect(scripts.map((f) => f.path)).toEqual(['scripts/run.sh'])
    // The id that passed the gate is the id that loads (BL-75).
    expect(mocks.getSkill).toHaveBeenCalledWith('josh', 'skill_alpha')
  })

  it('returns error when skill is not found', async () => {
    mocks.getSkill.mockResolvedValue(null)

    const result = await resolveSkillRuntimeForTool('josh', 'nonexistent', PRIMARY)

    expect(result.runtime).toBeNull()
    expect(result.error).toContain('nonexistent')
  })

  it("returns the reason when a skill's files are missing, instead of throwing (BL-369)", async () => {
    mocks.getSkill.mockRejectedValue(new Error('The files for skill "Skill Alpha" are missing from /tmp/zc/skills/skill_alpha.'))

    const result = await resolveSkillRuntimeForTool('josh', 'skill_alpha', PRIMARY)

    expect(result.runtime).toBeNull()
    expect(result.error).toContain('are missing from /tmp/zc/skills/skill_alpha')
  })

  it('refuses a skill that is off for the agent before it loads anything (BL-75)', async () => {
    seedSkillCommand('skill_alpha', { enabled_agent_ids: ['agent-2'] })

    const result = await resolveSkillRuntimeForTool('josh', 'skill_alpha', PRIMARY)

    expect(result).toEqual({
      runtime: null,
      error: expect.stringContaining('is not enabled for this agent'),
      errorCode: 'SKILL_NOT_ENABLED',
      blocked: true,
      skillId: 'skill_alpha'
    })
    expect(mocks.getSkill).not.toHaveBeenCalled()
  })

  it('refuses a skill no command lists, and a caller with no agent (BL-75)', async () => {
    const unlisted = await resolveSkillRuntimeForTool('josh', 'secret_skill', PRIMARY)
    expect(unlisted).toEqual(expect.objectContaining({ errorCode: 'SKILL_NOT_LISTED', blocked: true }))

    const anonymous = await resolveSkillRuntimeForTool('josh', 'skill_alpha', {
      kind: 'none',
      lane: 'service'
    })
    expect(anonymous).toEqual(
      expect.objectContaining({ errorCode: 'AGENT_IDENTITY_REQUIRED', blocked: true })
    )
    expect(mocks.getSkill).not.toHaveBeenCalled()
  })

  it('returns the refusal from every invoke/list/read action (BL-75)', async () => {
    seedSkillCommand('skill_alpha', { enabled_agent_ids: [] })

    for (const action of ['invoke', 'list', 'read'] as const) {
      const result = await executeSkillRuntimeAction({
        userId: 'josh',
        skillId: 'skill_alpha',
        actor: PRIMARY,
        action,
        path: 'SKILL.md'
      })
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          action,
          blocked: true,
          errorCode: 'SKILL_NOT_ENABLED',
          skillId: 'skill_alpha'
        })
      )
    }
    expect(mocks.getSkill).not.toHaveBeenCalled()
  })

  it('reads bundle text safely and supports truncation', () => {
    const file = {
      path: 'references/guide.md',
      kind: 'reference',
      encoding: 'utf8',
      content: 'a'.repeat(300),
      sha256: 'x',
      size: 300
    } as const

    const decoded = readSkillBundleFileText(file, 120)
    expect(decoded.truncated).toBe(true)
    expect(decoded.content.length).toBe(120)

    const found = findBundleFileByPath([file as any], 'references/guide.md')
    expect(found?.path).toBe('references/guide.md')
    expect(findBundleFileByPath([file as any], '../etc/passwd')).toBeNull()
  })

  it('resolves bundle file absolute paths within cache dir', () => {
    const file = {
      path: 'scripts/run.sh',
      kind: 'script',
      encoding: 'utf8',
      content: 'echo hi',
      sha256: 'y',
      size: 7
    } as const

    const absolutePath = resolveBundleFileAbsolutePath('/tmp/skill-alpha', file as any)
    expect(absolutePath).toBe('/tmp/skill-alpha/scripts/run.sh')

    const escapedFile = { ...file, path: '../../../etc/passwd' } as any
    const blocked = resolveBundleFileAbsolutePath('/tmp/skill-alpha', escapedFile)
    expect(blocked).toBeNull()
  })

  it('builds quoted script commands', () => {
    const command = buildSkillScriptCommand('/tmp/skill scripts/run.sh', ['--name', "O'Reilly"])
    expect(command).toContain("bash '/tmp/skill scripts/run.sh'")
    expect(command).toContain("'--name'")
    expect(command).toContain("'O'\"'\"'Reilly'")
  })
})

/**
 * Find 1 (bug batch 2026-09-22): a skill read is cut at 12,000 characters, and a cut read used to
 * end in a bare `[truncated]` with no sizes and no way on, so an agent silently worked from the
 * first part of a long reference. Every read now returns a window (`offset`, `maxChars`), and a
 * read that did not return the whole file says, in plain words, what it showed and the exact
 * next call. A whole read is unchanged, field for field.
 */
describe('a partial skill read says what it showed and how to read on (find 1)', () => {
  const BIG = Array.from({ length: 38_635 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('')
  const SKILL_MD = `# Skill Alpha\n${'s'.repeat(13_000)}`

  beforeEach(() => {
    mocks.getSkill.mockReset()
    mocks.commands.clear()
    seedSkillCommand('skill_alpha', { enabled_agent_ids: ['agent-1'] })
    mocks.getSkill.mockResolvedValue({
      id: 'skill_alpha',
      name: 'skill_alpha',
      displayName: 'Skill Alpha',
      user_id: 'josh',
      skill_markdown: SKILL_MD,
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
      bundle_files: [
        { path: 'references/big.md', kind: 'reference', encoding: 'utf8', content: BIG, sha256: 'x', size: BIG.length },
        { path: 'references/small.md', kind: 'reference', encoding: 'utf8', content: 'Small guide', sha256: 'y', size: 11 }
      ]
    })
  })

  const read = (extra: Record<string, unknown>) =>
    executeSkillRuntimeAction({
      userId: 'josh',
      skillId: 'skill_alpha',
      actor: PRIMARY,
      action: 'read',
      ...extra
    } as any) as Promise<Record<string, any>>

  it('a cut read names its sizes and the exact next call', async () => {
    const result = await read({ path: 'references/big.md' })

    expect(result.content).toBe(BIG.slice(0, 12_000))
    expect(result).toMatchObject({
      success: true,
      contentTruncated: true,
      originalChars: 38_635,
      returnedChars: 12_000,
      offset: 0,
      nextOffset: 12_000
    })
    expect(result.readMore).toBe(
      'Showing characters 1 to 12,000 of 38,635. To read on, call native_skill again with skillId "skill_alpha", action "read", path "references/big.md", and offset 12000.'
    )
  })

  it('offset reads the next part, the last part says it is the end, and the parts make the whole file', async () => {
    const second = await read({ path: 'references/big.md', offset: 12_000 })
    expect(second.content).toBe(BIG.slice(12_000, 24_000))
    expect(second).toMatchObject({ offset: 12_000, nextOffset: 24_000, contentTruncated: true })

    const last = await read({ path: 'references/big.md', offset: 36_000 })
    expect(last.content).toBe(BIG.slice(36_000))
    expect(last.contentTruncated).toBe(false)
    expect(last.nextOffset).toBeUndefined()
    expect(last.readMore).toBe('Showing characters 36,001 to 38,635 of 38,635: the end of references/big.md.')

    let whole = ''
    let offset: number | undefined = 0
    for (let part = 0; part < 10 && offset !== undefined; part += 1) {
      const window: Record<string, any> = await read({ path: 'references/big.md', offset })
      whole += window.content
      offset = window.nextOffset
    }
    expect(whole).toBe(BIG)
  })

  it('maxChars still sets the size of each part', async () => {
    const result = await read({ path: 'references/big.md', offset: 100, maxChars: 500 })
    expect(result.content).toBe(BIG.slice(100, 600))
    expect(result.nextOffset).toBe(600)
    expect(result.readMore).toContain('Showing characters 101 to 600 of 38,635.')
  })

  it('a whole read is exactly what it was before', async () => {
    const result = await read({ path: 'references/small.md' })
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        success: true,
        action: 'read',
        skillId: 'skill_alpha',
        skillName: 'Skill Alpha',
        path: 'references/small.md',
        content: 'Small guide',
        contentTruncated: false,
        originalChars: 11,
        returnedChars: 11
      })
    )
  })

  it('SKILL.md reads in parts the same way', async () => {
    const first = await read({ path: 'SKILL.md' })
    expect(first.content).toBe(SKILL_MD.slice(0, 12_000))
    expect(first.readMore).toBe(
      'Showing characters 1 to 12,000 of 13,014. To read on, call native_skill again with skillId "skill_alpha", action "read", path "SKILL.md", and offset 12000.'
    )
    const rest = await read({ path: 'SKILL.md', offset: 12_000 })
    expect(rest.content).toBe(SKILL_MD.slice(12_000))
    expect(rest.readMore).toBe('Showing characters 12,001 to 13,014 of 13,014: the end of SKILL.md.')
  })

  it('refuses an offset past the end, or one that is not a whole number of characters', async () => {
    const past = await read({ path: 'references/small.md', offset: 11 })
    expect(past).toMatchObject({ success: false, action: 'read' })
    expect(past.error).toBe('offset 11 is past the end of references/small.md, which has 11 characters.')

    for (const offset of [-5, 1.5]) {
      const bad = await read({ path: 'references/small.md', offset })
      expect(bad.success, String(offset)).toBe(false)
      expect(bad.error).toBe('offset must be a whole number of characters, 0 or more.')
    }
  })
})

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

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSkill: vi.fn()
}))

vi.mock('../skillRegistry', () => ({
  getSkill: mocks.getSkill,
  evaluateSkillDependencies: vi.fn()
}))

import {
  buildSkillScriptCommand,
  findBundleFileByPath,
  readSkillBundleFileText,
  resolveBundleFileAbsolutePath,
  resolveSkillRuntimeForTool
} from '../skillRuntimeToolService'

describe('skillRuntimeToolService', () => {
  beforeEach(() => {
    mocks.getSkill.mockReset()
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

    const result = await resolveSkillRuntimeForTool('josh', 'skill-alpha')

    expect(result.runtime).not.toBeNull()
    expect(result.error).toBeNull()
    const refs = result.runtime!.bundleFiles.filter((f) => f.kind === 'reference')
    const scripts = result.runtime!.bundleFiles.filter((f) => f.kind === 'script')
    expect(refs.map((f) => f.path)).toEqual(['references/guide.md'])
    expect(scripts.map((f) => f.path)).toEqual(['scripts/run.sh'])
  })

  it('returns error when skill is not found', async () => {
    mocks.getSkill.mockResolvedValue(null)

    const result = await resolveSkillRuntimeForTool('josh', 'nonexistent')

    expect(result.runtime).toBeNull()
    expect(result.error).toContain('nonexistent')
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

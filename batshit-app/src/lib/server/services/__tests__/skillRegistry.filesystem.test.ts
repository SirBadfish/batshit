import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => {
  return {
    store: new Map<string, any>(),
    userSettings: {} as Record<string, any>
  }
})

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

vi.mock('$lib/server/redis', () => {
  const get = vi.fn(async (key: string) => {
    return mockState.store.get(key) ?? null
  })

  const set = vi.fn(async (key: string, redisPath: string, value: any) => {
    if (redisPath === '$') {
      mockState.store.set(key, value)
      return true
    }

    if (redisPath.startsWith('$.')) {
      const existing = (mockState.store.get(key) ?? {}) as Record<string, any>
      const field = redisPath.slice(2)
      existing[field] = value
      mockState.store.set(key, existing)
      return true
    }

    throw new Error(`Unsupported JSON path in mock: ${redisPath}`)
  })

  const keys = vi.fn(async (pattern: string) => {
    const matcher = patternToRegex(pattern)
    return Array.from(mockState.store.keys()).filter((key) => matcher.test(key))
  })

  const del = vi.fn(async (key: string) => {
    mockState.store.delete(key)
    return true
  })

  const getUserSettings = vi.fn(async () => mockState.userSettings)

  return {
    redis: {
      json: {
        get,
        set
      },
      keys,
      del,
      getUserSettings
    }
  }
})

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: {
    list: vi.fn(async () => [])
  }
}))

let originalHome = process.env.HOME
let tempHome = ''

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  mockState.store = new Map<string, any>()
  mockState.userSettings = {}
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-registry-test-'))
  process.env.HOME = tempHome
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true })
  }
  tempHome = ''
})

describe('skillRegistry filesystem-first canonical behavior', () => {
  it('clears prior standards issues when refreshed markdown becomes spec-compliant', async () => {
    const { upsertSkill } = await import('../skillRegistry')

    const degraded = await upsertSkill({
      userId: 'user-1',
      commandId: 'artifact_cmd',
      nowIso: '2026-02-22T08:00:00.000Z',
      skill: {
        id: 'artifacts_general',
        name: 'artifacts-general',
        markdown: '# Artifacts General\n\nLegacy skill body without frontmatter.'
      }
    })

    expect(degraded.standards_status).toBe('degraded')
    expect(degraded.standards_issues.length).toBeGreaterThan(0)

    const refreshed = await upsertSkill({
      userId: 'user-1',
      commandId: 'artifact_cmd',
      nowIso: '2026-02-22T08:05:00.000Z',
      skill: {
        id: 'artifacts_general',
        name: 'artifacts-general',
        markdown:
          '---\nname: artifacts-general\ndescription: Spec-compliant artifact skill.\n---\n# Artifacts General\n\nSpec-compliant body.\n'
      }
    })

    expect(refreshed.standards_status).toBe('full')
    expect(refreshed.standards_issues).toEqual([])

    const redisRecord = mockState.store.get('skill:user-1:artifacts_general')
    expect(redisRecord.standards_status).toBe('full')
    expect(redisRecord.standards_issues).toEqual([])
  })

  it('writes canonical skill content to disk and stores metadata-only content in Redis', async () => {
    const { upsertSkill } = await import('../skillRegistry')

    const saved = await upsertSkill({
      userId: 'user-1',
      commandId: 'alpha_cmd',
      nowIso: '2026-02-22T08:00:00.000Z',
      skill: {
        id: 'alpha_skill',
        name: 'alpha-skill',
        markdown: `---\nname: alpha-skill\ndescription: Alpha skill description\n---\n# Alpha Skill\n\nRun alpha tasks.\n`,
        bundleFiles: [
          {
            path: 'scripts/run.sh',
            kind: 'script',
            encoding: 'utf8',
            content: 'echo alpha\n',
            sha256: 'placeholder',
            size: 11
          }
        ]
      }
    })

    expect(saved.skill_markdown).toContain('# Alpha Skill')
    expect(saved.bundle_files?.map((file) => file.path)).toEqual(['scripts/run.sh'])

    const redisRecord = mockState.store.get('skill:user-1:alpha_skill')
    expect(redisRecord.skill_markdown).toBe('')
    expect(redisRecord.bundle_files).toEqual([])

    const skillDir = path.join(tempHome, '.batshit', 'skills', 'alpha_skill')
    const markdown = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
    const script = await fs.readFile(path.join(skillDir, 'scripts', 'run.sh'), 'utf8')

    expect(markdown).toContain('Alpha skill description')
    expect(script).toBe('echo alpha\n')
  })

  it('rescans filesystem on getSkill and refreshes Redis metadata from SKILL.md + bundle folders', async () => {
    const { upsertSkill, getSkill } = await import('../skillRegistry')

    await upsertSkill({
      userId: 'user-1',
      commandId: 'alpha_cmd',
      nowIso: '2026-02-22T08:05:00.000Z',
      skill: {
        id: 'alpha_skill',
        name: 'alpha-skill',
        markdown: `---\nname: alpha-skill\ndescription: Original description\n---\n# Alpha Skill\n\nOriginal body.\n`
      }
    })

    const skillDir = path.join(tempHome, '.batshit', 'skills', 'alpha_skill')
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true })
    await fs.writeFile(path.join(skillDir, 'references', 'guide.md'), '# Guide\n', 'utf8')
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: alpha-skill\ndescription: Refreshed description\ndependencies: [web_search]\nallowed-tools: native_bash_execute\n---\n# Alpha Skill\n\nRefreshed body.\n`,
      'utf8'
    )

    const refreshed = await getSkill('user-1', 'alpha_skill')

    expect(refreshed).not.toBeNull()
    expect(refreshed?.description).toBe('Refreshed description')
    expect(refreshed?.dependencies?.map((dep) => dep.id)).toEqual(['web_search'])
    expect(refreshed?.allowed_tools).toEqual(['native_bash_execute'])
    expect(refreshed?.has_references).toBe(true)
    expect(refreshed?.bundle_files?.map((file) => file.path)).toContain('references/guide.md')

    const redisRecord = mockState.store.get('skill:user-1:alpha_skill')
    expect(redisRecord.description).toBe('Refreshed description')
    expect(redisRecord.has_references).toBe(true)
    expect(redisRecord.skill_markdown).toBe('')
    expect(redisRecord.bundle_files).toEqual([])
  })

  it('migrates legacy Redis skill content to filesystem and strips content blobs from Redis records', async () => {
    const { getSkill, runSkillFilesystemMigrationPass } = await import('../skillRegistry')

    mockState.store.set('skill:user-1:legacy_skill', {
      id: 'legacy_skill',
      user_id: 'user-1',
      name: 'legacy-skill',
      displayName: 'Legacy Skill',
      description: 'Legacy description',
      skill_markdown: `---\nname: legacy-skill\ndescription: Legacy description\n---\n# Legacy Skill\n\nLegacy body.\n`,
      source: 'custom',
      source_ref: undefined,
      dependencies: [],
      license: undefined,
      compatibility: undefined,
      metadata: {},
      allowed_tools: [],
      standards_status: 'full',
      standards_issues: [],
      trust_level: 'untrusted',
      has_scripts: true,
      has_references: false,
      has_assets: false,
      bundle_manifest: {
        version: 1,
        checksum: 'legacy',
        file_count: 1,
        script_count: 1,
        reference_count: 0,
        asset_count: 0,
        generated_at: '2026-02-22T08:10:00.000Z'
      },
      bundle_files: [
        {
          path: 'scripts/run.sh',
          kind: 'script',
          encoding: 'utf8',
          content: 'echo legacy\n',
          sha256: 'legacy',
          size: 12
        }
      ],
      cache_path: path.join(tempHome, '.batshit', 'skills', 'legacy_skill', 'SKILL.md'),
      is_system: false,
      is_active: true,
      created_at: '2026-02-22T08:10:00.000Z',
      updated_at: '2026-02-22T08:10:00.000Z'
    })

    mockState.store.set('slash_command:user-1:legacy_cmd', {
      id: 'legacy_cmd',
      user_id: 'user-1',
      name: 'legacy-cmd',
      type: 'skill',
      description: 'legacy',
      instructions: '',
      skill_id: 'legacy_skill',
      skill_bundle_files: [
        {
          path: 'scripts/run.sh',
          kind: 'script',
          encoding: 'utf8',
          content: 'echo legacy\n',
          sha256: 'legacy',
          size: 12
        }
      ],
      created_at: '2026-02-22T08:10:00.000Z',
      updated_at: '2026-02-22T08:10:00.000Z'
    })

    await runSkillFilesystemMigrationPass({ userId: 'user-1' })

    const skillDir = path.join(tempHome, '.batshit', 'skills', 'legacy_skill')
    const markdown = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
    const script = await fs.readFile(path.join(skillDir, 'scripts', 'run.sh'), 'utf8')

    expect(markdown).toContain('# Legacy Skill')
    expect(script).toBe('echo legacy\n')

    const redisRecord = mockState.store.get('skill:user-1:legacy_skill')
    expect(redisRecord.skill_markdown).toBe('')
    expect(redisRecord.bundle_files).toEqual([])

    const commandRecord = mockState.store.get('slash_command:user-1:legacy_cmd')
    expect(commandRecord.skill_bundle_files).toBeUndefined()

    const hydrated = await getSkill('user-1', 'legacy_skill')
    expect(hydrated?.skill_markdown).toContain('Legacy body')
    expect(hydrated?.bundle_files?.map((file) => file.path)).toEqual(['scripts/run.sh'])
  })

  it('reads repo-backed system skills directly from the repo instead of ~/.batshit/skills', async () => {
    const { getSkill } = await import('../skillRegistry')

    mockState.store.set('skill:user-1:speech_setup', {
      id: 'speech_setup',
      user_id: 'user-1',
      name: 'speech-setup',
      displayName: 'Speech Setup',
      description: 'Install, verify, and register Batshit TTS/STT speech engines through the server-owned Engine Manager.',
      skill_markdown: '',
      source: 'system',
      source_ref: undefined,
      dependencies: [],
      license: 'Proprietary (Batshit system skill)',
      compatibility: 'batshit-prelaunch',
      metadata: {
        system: 'true'
      },
      allowed_tools: [
        'native_fabric_find',
        'native_fabric_use',
        'native_bash_execute',
        'native_skill'
      ],
      standards_status: 'full',
      standards_issues: [],
      trust_level: 'trusted',
      has_scripts: false,
      has_references: true,
      has_assets: false,
      bundle_manifest: undefined,
      bundle_files: [],
      cache_path: path.join(tempHome, '.batshit', 'skills', 'speech_setup', 'SKILL.md'),
      is_system: true,
      is_active: true,
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z'
    })

    const hydrated = await getSkill('user-1', 'speech_setup')

    expect(hydrated).not.toBeNull()
    expect(hydrated?.skill_markdown).toContain('# TTS/STT Engine Installer')
    expect(hydrated?.cache_path).toContain('/batshit-app/src/lib/server/system-skills/speech-setup/SKILL.md')
    expect(hydrated?.source_ref).toContain('/batshit-app/src/lib/server/system-skills/speech-setup')
    expect(hydrated?.bundle_files?.map((file) => file.path)).toContain('references/runtime-preflight.md')
    expect(await pathExists(path.join(tempHome, '.batshit', 'skills', 'speech_setup'))).toBe(false)

    const redisRecord = mockState.store.get('skill:user-1:speech_setup')
    expect(redisRecord.cache_path).toContain('/batshit-app/src/lib/server/system-skills/speech-setup/SKILL.md')
    expect(redisRecord.source_ref).toContain('/batshit-app/src/lib/server/system-skills/speech-setup')
  })

  it('never deletes the repo bundle when removing a system skill record', async () => {
    const { deleteSkill } = await import('../skillRegistry')

    mockState.store.set('skill:user-1:speech_setup', {
      id: 'speech_setup',
      user_id: 'user-1',
      name: 'speech-setup',
      displayName: 'Speech Setup',
      description: 'Install, verify, and register Batshit TTS/STT speech engines through the server-owned Engine Manager.',
      skill_markdown: '',
      source: 'system',
      source_ref: undefined,
      dependencies: [],
      license: 'Proprietary (Batshit system skill)',
      compatibility: 'batshit-prelaunch',
      metadata: {},
      allowed_tools: [],
      standards_status: 'full',
      standards_issues: [],
      trust_level: 'trusted',
      has_scripts: false,
      has_references: true,
      has_assets: false,
      bundle_manifest: undefined,
      bundle_files: [],
      cache_path: '/Users/example/batshit/batshit-app/src/lib/server/system-skills/speech-setup/SKILL.md',
      is_system: true,
      is_active: true,
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z'
    })

    await deleteSkill('user-1', 'speech_setup')

    expect(mockState.store.has('skill:user-1:speech_setup')).toBe(false)
    await expect(
      fs.readFile(
        path.resolve(process.cwd(), 'src/lib/server/system-skills/speech-setup/SKILL.md'),
        'utf8'
      )
    ).resolves.toContain('# TTS/STT Engine Installer')
  })
})

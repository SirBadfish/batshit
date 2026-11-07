import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const upsertSkillMock = vi.hoisted(() => vi.fn())
const redisJsonGetMock = vi.hoisted(() => vi.fn())
const redisJsonSetMock = vi.hoisted(() => vi.fn())
const redisDelMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/services/skillRegistry', () => ({
  upsertSkill: upsertSkillMock
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    json: {
      get: redisJsonGetMock,
      set: redisJsonSetMock
    },
    del: redisDelMock
  }
}))
// Bundle/bootstrap projection only; physical batch/revision behavior has its real Redis owner.
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/slashCommandRevision')>(),
  captureSlashCommandWriteBasis: vi.fn(async () => Object.freeze({})),
  saveSlashCommandBatch: vi.fn(async (userId: string, writes: Array<{ record: { id: string } }>) => {
    for (const write of writes) await redisJsonSetMock(`slash_command:${userId}:${write.record.id}`, '$', write.record)
    return { records: writes.map(write => write.record), deleted: 0 }
  }),
  deleteSlashCommandRecord: vi.fn(async (userId: string, id: string) => (await redisDelMock(`slash_command:${userId}:${id}`)) === 1)
}))

// Migration is qualified with actual Lua in agentPlugins.redis.test; this fixture owns package projection.
vi.mock('$lib/server/services/agentPlugins', () => ({ ensureBuiltinAgentPlugin: vi.fn() }))

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function toPosixPath(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '/')
}

describe('slash command bootstrap system skills', () => {
  const originalHome = process.env.HOME
  const originalBatshitHome = process.env.BATSHIT_HOME_DIR
  let tempHome = ''

  beforeEach(async () => {
    vi.resetModules()
    upsertSkillMock.mockReset()
    redisJsonGetMock.mockReset()
    redisJsonSetMock.mockReset()
    redisDelMock.mockReset()
    redisJsonGetMock.mockResolvedValue(null)
    redisJsonSetMock.mockResolvedValue(true)
    redisDelMock.mockResolvedValue(1)
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-bootstrap-test-'))
    process.env.HOME = tempHome
    process.env.BATSHIT_HOME_DIR = path.join(tempHome, '.batshit')
    upsertSkillMock.mockImplementation(async (input: any) => ({
      id: input.skill.id.replace(/-/g, '_'),
      source: 'system',
      source_ref: input.skill.sourceRef,
      description: input.skill.description,
      dependencies: input.skill.dependencies ?? [],
      allowed_tools: input.skill.allowedTools ?? [],
      trust_level: 'trusted',
      has_scripts: false,
      has_references: input.skill.hasReferences ?? false,
      has_assets: input.skill.hasAssets ?? false
    }))
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    if (originalBatshitHome === undefined) delete process.env.BATSHIT_HOME_DIR
    else process.env.BATSHIT_HOME_DIR = originalBatshitHome
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true })
    }
    tempHome = ''
  })

  it('keeps the repo source ref and removes stale runtime copies', async () => {
    const staleAliasDir = path.join(tempHome, '.batshit', 'skills', 'speech-setup', 'references')
    await fs.mkdir(staleAliasDir, { recursive: true })
    await fs.writeFile(path.join(staleAliasDir, 'stale.md'), 'stale\n', 'utf8')

    const staleRuntimeDir = path.join(tempHome, '.batshit', 'skills', 'speech_setup', 'references')
    await fs.mkdir(staleRuntimeDir, { recursive: true })
    await fs.writeFile(path.join(staleRuntimeDir, 'stale.md'), 'stale\n', 'utf8')

    const { buildSpeechSetupSkillCommand } = await import('$lib/server/services/systemSlashCommands')

    const command = await buildSpeechSetupSkillCommand('user-1', '2026-03-08T09:00:00.000Z')

    expect(command.id).toBe('voice-engine-installer')
    expect(command.skill_id).toBe('voice_engine_installer')
    expect(command.invocation_pattern).toBe('/batshit:voice-engine-installer')
    const upsertInput = upsertSkillMock.mock.calls[0]?.[0]
    expect(upsertInput).toEqual(
      expect.objectContaining({
        commandId: 'voice-engine-installer',
        skill: expect.objectContaining({ hasReferences: true })
      })
    )
    expect(toPosixPath(upsertInput?.skill?.sourceRef)).toContain(
      '/batshit-app/src/lib/server/system-plugins/batshit/skills/voice-engine-installer'
    )

    expect(await pathExists(path.join(tempHome, '.batshit', 'skills', 'speech-setup'))).toBe(false)
    expect(await pathExists(path.join(tempHome, '.batshit', 'skills', 'speech_setup'))).toBe(false)
  })

  it('builds the cli-tools system skill command from the repo-backed bundle', async () => {
    const { buildCliToolsSkillCommand } = await import('$lib/server/services/systemSlashCommands')

    const command = await buildCliToolsSkillCommand('user-1', '2026-03-13T21:00:00.000Z')

    expect(command.id).toBe('cli-tool-creator')
    expect(command.skill_id).toBe('cli_tool_creator')
    expect(command.invocation_pattern).toBe('/batshit:cli-tool-creator')
    expect(command.is_system).toBe(true)
    const upsertInput = upsertSkillMock.mock.calls[0]?.[0]
    expect(upsertInput).toEqual(
      expect.objectContaining({
        commandId: 'cli-tool-creator',
        skill: expect.objectContaining({ hasReferences: true })
      })
    )
    expect(toPosixPath(upsertInput?.skill?.sourceRef)).toContain(
      '/batshit-app/src/lib/server/system-plugins/batshit/skills/cli-tool-creator'
    )
  })

  it('builds the goon scene creator system skill command from the repo-backed bundle', async () => {
    const { buildGoonSceneCreatorSkillCommand } = await import(
      '$lib/server/services/systemSlashCommands'
    )

    const command = await buildGoonSceneCreatorSkillCommand('user-1', '2026-07-07T15:00:00.000Z')

    expect(command.id).toBe('goon-scene-creator')
    expect(command.skill_id).toBe('goon_scene_creator')
    expect(command.invocation_pattern).toBe('/batshit:goon-scene-creator')
    expect(command.is_system).toBe(true)
    expect(command.icon_ref).toEqual({ kind: 'batshit', id: 'scenes' })
    expect(command.has_assets).toBe(true)
    const upsertInput = upsertSkillMock.mock.calls[0]?.[0]
    expect(upsertInput).toEqual(
      expect.objectContaining({
        commandId: 'goon-scene-creator',
        skill: expect.objectContaining({
          dependencies: [{ id: 'comfyui_mcp', label: 'ComfyUI MCP', required: false }],
          hasReferences: true,
          hasAssets: true
        })
      })
    )
    expect(toPosixPath(upsertInput?.skill?.sourceRef)).toContain(
      '/batshit-app/src/lib/server/system-plugins/batshit/skills/goon-scene-creator'
    )
  })

  it('builds the batshit guide system skill command from the repo-backed bundle', async () => {
    const { buildBatshitGuideSkillCommand } = await import(
      '$lib/server/services/systemSlashCommands'
    )

    const command = await buildBatshitGuideSkillCommand('user-1', '2026-07-14T09:00:00.000Z')

    expect(command.id).toBe('batshit-guide')
    expect(command.skill_id).toBe('batshit_guide')
    expect(command.invocation_pattern).toBe('/batshit:batshit-guide')
    expect(command.is_system).toBe(true)
    expect(command.icon_ref).toEqual({ kind: 'lucide', id: 'book-open' })
    // BL-69 (Josh, 2026-09-21): a new install starts Batshit Guide on for all agents.
    expect(command.enabled_for_all_agents).toBe(true)
    expect(command.can_be_attached_to_agents).toBe(true)
    expect(command.enabled_agent_ids).toEqual([])
    const upsertInput = upsertSkillMock.mock.calls[0]?.[0]
    expect(upsertInput).toEqual(
      expect.objectContaining({
        commandId: 'batshit-guide',
        skill: expect.objectContaining({
          hasReferences: true,
          allowedTools: ['native_batshit_tool_search', 'native_batshit_tool_use', 'native_skill']
        })
      })
    )
    expect(toPosixPath(upsertInput?.skill?.sourceRef)).toContain(
      '/batshit-app/src/lib/server/system-plugins/batshit/skills/batshit-guide'
    )
  })

  it('builds App Actions with explicit package ownership and the existing search/use allowance', async () => {
    const { buildAppActionsSkillCommand } = await import('$lib/server/services/systemSlashCommands')
    const command = await buildAppActionsSkillCommand('user-1', '2026-10-26T12:00:00.000Z')
    expect(command).toMatchObject({ id: 'app-actions', skill_id: 'app_actions', plugin_id: 'batshit', is_system: true,
      invocation_pattern: '/batshit:app-actions', enabled_for_all_agents: false, enabled_agent_ids: [] })
    expect(upsertSkillMock).toHaveBeenCalledWith(expect.objectContaining({ builtinAppActionsSeed: true, commandId: 'app-actions',
      skill: expect.objectContaining({ id: 'app_actions', isSystem: true, source: 'system',
        allowedTools: ['native_batshit_tool_search', 'native_batshit_tool_use'] }) }))
    expect(toPosixPath(upsertSkillMock.mock.calls[0]?.[0]?.skill?.sourceRef)).toContain('/system-plugins/batshit/skills/app-actions')
  })

  it('starts only Artifact Creator and Batshit Guide on for all agents on a new install (BL-69)', async () => {
    const services = await import('$lib/server/services/systemSlashCommands')
    const now = '2026-09-21T12:00:00.000Z'

    const onByDefault = [
      await services.buildUnifiedArtifactSkillCommand('user-1', now),
      await services.buildBatshitGuideSkillCommand('user-1', now)
    ]
    for (const command of onByDefault) {
      expect(command.enabled_for_all_agents).toBe(true)
      expect(command.enabled_agent_ids).toEqual([])
      expect(command.can_be_attached_to_agents).toBe(true)
    }

    const offByDefault = [
      await services.buildSkillCreatorSkillCommand('user-1', now),
      await services.buildSpeechSetupSkillCommand('user-1', now),
      await services.buildCliToolsSkillCommand('user-1', now),
      await services.buildGoonSceneCreatorSkillCommand('user-1', now),
      await services.buildAppActionsSkillCommand('user-1', now)
    ]
    for (const command of offByDefault) {
      expect(command.enabled_for_all_agents).toBe(false)
      expect(command.enabled_agent_ids).toEqual([])
      expect(command.can_be_attached_to_agents).toBe(false)
    }
  })

  it('keeps the agent access of an existing record, even an empty one (BL-69)', async () => {
    const services = await import('$lib/server/services/systemSlashCommands')
    const now = '2026-09-21T12:00:00.000Z'

    // The old default and a deliberate "no agents" look the same on disk, so neither is migrated.
    const keptOff = await services.buildUnifiedArtifactSkillCommand('user-1', now, {
      id: 'artifact-creator',
      type: 'skill',
      enabled_for_all_agents: false,
      enabled_agent_ids: []
    } as any)
    expect(keptOff.enabled_for_all_agents).toBe(false)
    expect(keptOff.enabled_agent_ids).toEqual([])
    expect(keptOff.can_be_attached_to_agents).toBe(false)

    const keptSelected = await services.buildBatshitGuideSkillCommand('user-1', now, {
      id: 'batshit-guide',
      type: 'skill',
      enabled_for_all_agents: false,
      enabled_agent_ids: ['agent-a', 'agent-a', ' agent-b ']
    } as any)
    expect(keptSelected.enabled_for_all_agents).toBe(false)
    expect(keptSelected.enabled_agent_ids).toEqual(['agent-a', 'agent-b'])
    expect(keptSelected.can_be_attached_to_agents).toBe(true)
  })

  it('rebuilds system slash commands when backing skill records are missing', async () => {
    const existingCommands = new Map<string, Record<string, unknown>>([
      [
        'skill-creator',
        { id: 'skill-creator', type: 'skill', skill_id: 'skill_creator' }
      ],
      [
        'voice-engine-installer',
        { id: 'voice-engine-installer', type: 'skill', skill_id: 'voice_engine_installer' }
      ],
      [
        'artifact-creator',
        { id: 'artifact-creator', type: 'skill', skill_id: 'artifact_creator' }
      ],
      [
        'cli-tool-creator',
        { id: 'cli-tool-creator', type: 'skill', skill_id: 'cli_tool_creator' }
      ],
      [
        'goon-scene-creator',
        { id: 'goon-scene-creator', type: 'skill', skill_id: 'goon_scene_creator' }
      ]
    ])

    redisJsonGetMock.mockImplementation(async (key: string) => {
      const commandPrefix = 'slash_command:user-1:'
      if (key.startsWith(commandPrefix)) {
        return existingCommands.get(key.slice(commandPrefix.length)) ?? null
      }
      if (key.startsWith('skill:user-1:')) return null
      return null
    })

    const { ensureSystemSlashCommands } = await import('$lib/server/services/systemSlashCommands')

    await ensureSystemSlashCommands('user-1')

    expect(upsertSkillMock).toHaveBeenCalledTimes(8)
    expect(redisJsonSetMock).not.toHaveBeenCalledWith(
      'slash_command:user-1:artifact-creator',
      '$',
      expect.objectContaining({
        id: 'artifact-creator',
        skill_id: 'artifact_creator'
      })
    )
    // Existing legacy rows remain unchanged; absent plugin members are repaired.
    expect(redisJsonSetMock).toHaveBeenCalledWith(
      'slash_command:user-1:batshit-guide',
      '$',
      expect.objectContaining({
        id: 'batshit-guide',
        skill_id: 'batshit_guide'
      })
    )
  })
})

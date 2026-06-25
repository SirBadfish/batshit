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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

describe('slash command bootstrap system skills', () => {
  const originalHome = process.env.HOME
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
    upsertSkillMock.mockImplementation(async (input: any) => ({
      id: input.skill.id.replace(/-/g, '_'),
      source: 'system',
      source_ref: input.skill.sourceRef,
      description: input.skill.description,
      dependencies: input.skill.dependencies ?? [],
      allowed_tools: input.skill.allowedTools ?? [],
      trust_level: 'trusted',
      has_scripts: false,
      has_references: input.skill.hasReferences ?? false
    }))
  })

  afterEach(async () => {
    process.env.HOME = originalHome
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
    expect(command.invocation_pattern).toBe('/voice-engine-installer')
    expect(upsertSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'voice-engine-installer',
        skill: expect.objectContaining({
          sourceRef: expect.stringContaining('/batshit-app/src/lib/server/system-skills/speech-setup'),
          hasReferences: true
        })
      })
    )

    expect(await pathExists(path.join(tempHome, '.batshit', 'skills', 'speech-setup'))).toBe(false)
    expect(await pathExists(path.join(tempHome, '.batshit', 'skills', 'speech_setup'))).toBe(false)
  })

  it('builds the cli-tools system skill command from the repo-backed bundle', async () => {
    const { buildCliToolsSkillCommand } = await import('$lib/server/services/systemSlashCommands')

    const command = await buildCliToolsSkillCommand('user-1', '2026-03-13T21:00:00.000Z')

    expect(command.id).toBe('cli-tool-creator')
    expect(command.skill_id).toBe('cli_tool_creator')
    expect(command.invocation_pattern).toBe('/cli-tool-creator')
    expect(command.is_system).toBe(true)
    expect(upsertSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'cli-tool-creator',
        skill: expect.objectContaining({
          sourceRef: expect.stringContaining('/batshit-app/src/lib/server/system-skills/cli-tools'),
          hasReferences: false
        })
      })
    )
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

    expect(upsertSkillMock).toHaveBeenCalledTimes(4)
    expect(redisJsonSetMock).toHaveBeenCalledWith(
      'slash_command:user-1:artifact-creator',
      '$',
      expect.objectContaining({
        id: 'artifact-creator',
        skill_id: 'artifact_creator'
      })
    )
  })
})

/**
 * BL-369 review 5: creating a command for an existing skill whose files are missing answers 409
 * with the reason (the folder it looked in), never a generic 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

// This fixture owns route/file-error handling; grouped persistence and actor authority use actual Redis in agentPlugins.redis.test.
vi.mock('$lib/server/services/agentPlugins', async original => {
  const actual = await original<typeof import('$lib/server/services/agentPlugins')>()
  return { ...actual, listAgentPlugins: async () => [], pluginForCommand: async () => null,
    projectPluginCommand: async (_user: string, command: unknown) => command,
    refusePluginMemberWrite: async (_user: string, command: { id: string; skill_id?: string; plugin_id?: string }) => {
      if (command.plugin_id !== undefined || actual.isBuiltinPluginMember(command)) throw new actual.AgentPluginError('PLUGIN_MEMBER_USER_MANAGED', 'Manage this member through its plugin.')
    }
  }
})

vi.mock('$lib/server/redis', () => ({
  redis: {
    exists: vi.fn(async () => 0),
    json: { get: vi.fn(), set: vi.fn() }
  }
}))

vi.mock('$lib/server/services/skillRegistry', () => ({
  getSkill: vi.fn(),
  normalizeSkillId: vi.fn((value: string) => value),
  upsertSkill: vi.fn()
}))

vi.mock('$lib/server/services/systemSlashCommands', () => ({
  ensureSystemSlashCommands: vi.fn()
}))

// b34b0e201: the create captures its slash-command write basis (one EVAL) before reading the
// skill. This stub has no Redis client for it, so the capture is held, as in
// `[id]/command-update.test.ts`; the skill's missing files still decide the answer.
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/slashCommandRevision')>(),
  captureSlashCommandWriteBasis: vi.fn(async () => Object.freeze({})),
  // The create's only record writer (`+server.ts` saveSlashCommandRecord): "writes nothing" means it never runs.
  saveSlashCommandRecord: vi.fn(async () => null)
}))

import { POST } from './+server'
import { redis } from '$lib/server/redis'
import { getSkill } from '$lib/server/services/skillRegistry'
import { saveSlashCommandRecord } from '$lib/server/services/slashCommandRevision'

function buildEvent(body: Record<string, unknown>): RequestEvent {
  return {
    request: new Request('http://localhost/api/slash-commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: 'user-1' } }
  } as unknown as RequestEvent
}

describe('POST /api/slash-commands for a skill whose files are missing (BL-369)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers 409 with the reason and writes nothing', async () => {
    vi.mocked(getSkill).mockRejectedValue(
      Object.assign(new Error('The files for skill "zc_notes" are missing from /tmp/zc/skills/zc_notes.'), {
        code: 'SKILL_FILES_MISSING'
      })
    )

    const response = await POST(buildEvent({ name: 'zc-notes', type: 'skill', skill_id: 'zc_notes' }))

    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload).toMatchObject({ code: 'SKILL_FILES_MISSING' })
    expect(payload.error).toContain('are missing from /tmp/zc/skills/zc_notes')
    expect(redis.json.set).not.toHaveBeenCalled()
    expect(saveSlashCommandRecord).not.toHaveBeenCalled()
  })
})

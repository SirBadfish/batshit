import { describe, expect, it, vi } from 'vitest'

// BL-544: the real RedisService, even if other suites mocked the module earlier.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'
import { PUT as skillAccessPut } from '../../../routes/api/slash-commands/[id]/agent-access/+server'
import { PUT as artifactAccessPut } from '../../../routes/api/artifacts/[id]/agent-access/+server'

/**
 * BL-544: Settings > Agents > Access turns ONE agent on or off, and the server adds or removes
 * that id against the access list as stored at that moment. The toggles used to send the whole
 * list from the copy Access loaded once per Settings visit, and the routes replaced the stored
 * list with it, undoing every change made elsewhere since (Skills & Prompts, Artifacts, another
 * agent's toggle). Drives the two real routes on Redis 8 (the skill side is one Lua step; the
 * artifact side is the artifact write lock and its check-and-set write).
 *
 * Real-Redis suite (G-0228): it runs only under `npm run test:redis` and reports as skipped in
 * the default lane.
 */

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'ssacc_access_user'
const OTHER_USER = 'ssacc_access_other'
const COMMAND = 'ssacc-notes'
const KEY = `slash_command:${USER}:${COMMAND}`

async function seedAgents() {
  for (const id of ['ssacc_nova', 'ssacc_orla', 'ssacc_pax']) {
    await redis.json.set(`agent:${id}`, '$', { id, user_id: USER, displayName: id } as any)
    await redis.sAdd(`user:${USER}:agents`, id)
  }
  await redis.json.set('subagent:ssacc_scout', '$', { id: 'ssacc_scout', user_id: USER, displayName: 'scout' } as any)
  await redis.sAdd(`user:${USER}:subagents`, 'ssacc_scout')
  await redis.json.set('agent:ssacc_foreign', '$', { id: 'ssacc_foreign', user_id: OTHER_USER } as any)
  await redis.sAdd(`user:${OTHER_USER}:agents`, 'ssacc_foreign')
}

async function seedCommand(overrides: Record<string, unknown> = {}) {
  await redis.json.set(KEY, '$', {
    id: COMMAND,
    user_id: USER,
    name: COMMAND,
    displayName: 'Ssacc Notes',
    type: 'skill',
    skill_id: 'ssacc_notes',
    trust_level: 'untrusted',
    invocation_pattern: '/ssacc-notes',
    enabled_for_all_agents: false,
    enabled_agent_ids: ['ssacc_nova'],
    can_be_attached_to_agents: true,
    is_active: true,
    is_system: false,
    created_at: '2026-09-28T10:00:00.000Z',
    updated_at: '2026-09-28T10:00:00.000Z',
    ...overrides
  } as any)
}

async function toggleSkill(agentId: unknown, enabled: unknown, options: { user?: string | null; command?: string } = {}) {
  const command = options.command ?? COMMAND
  const request = new Request(`http://localhost/api/slash-commands/${command}/agent-access`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, enabled })
  })
  const user = options.user === undefined ? USER : options.user
  const response = (await (skillAccessPut as any)({
    params: { id: command },
    request,
    locals: { user: user ? { id: user } : null }
  })) as Response
  return { status: response.status, body: await response.json() }
}

async function storedCommand() {
  return (await redis.json.get(KEY)) as Record<string, any> | null
}

async function toggleArtifact(artifactId: string, agentId: unknown, enabled: unknown, user: string | null = USER) {
  const request = new Request(`http://localhost/api/artifacts/${artifactId}/agent-access`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, enabled })
  })
  const response = (await (artifactAccessPut as any)({
    params: { id: artifactId },
    request,
    locals: { user: user ? { id: user } : null }
  })) as Response
  return { status: response.status, body: await response.json() }
}

describe.runIf(REAL_REDIS_LANE)('Access turns one agent on or off (BL-544)', () => {
  useRedisTestServer()

  describe('PUT /api/slash-commands/[id]/agent-access', () => {
    it('adds and removes one id from the list as stored, and leaves the rest of the command alone', async () => {
      await seedAgents()
      await seedCommand()
      // Another writer added Pax after Access loaded its copy (which still says only Nova).
      await redis.json.set(KEY, '$.enabled_agent_ids', ['ssacc_nova', 'ssacc_pax'] as any)

      const added = await toggleSkill('ssacc_orla', true)
      expect(added.status).toBe(200)
      expect(added.body.changed).toBe(true)
      expect(added.body.slashCommand.enabled_agent_ids).toEqual(['ssacc_nova', 'ssacc_pax', 'ssacc_orla'])

      const removed = await toggleSkill('ssacc_nova', false)
      expect(removed.status).toBe(200)
      expect(removed.body.slashCommand.enabled_agent_ids).toEqual(['ssacc_pax', 'ssacc_orla'])

      const stored = await storedCommand()
      expect(stored?.enabled_agent_ids).toEqual(['ssacc_pax', 'ssacc_orla'])
      expect(stored?.enabled_for_all_agents).toBe(false)
      expect(stored?.can_be_attached_to_agents).toBe(true)
      expect(stored?.trust_level).toBe('untrusted')
      expect(stored?.displayName).toBe('Ssacc Notes')
    })

    it('an agent already on, or one already off, changes nothing', async () => {
      await seedAgents()
      await seedCommand()

      const again = await toggleSkill('ssacc_nova', true)
      const absent = await toggleSkill('ssacc_orla', false)

      expect(again.body.changed).toBe(false)
      expect(absent.body.changed).toBe(false)
      const stored = await storedCommand()
      expect(stored?.enabled_agent_ids).toEqual(['ssacc_nova'])
      expect(stored?.updated_at).toBe('2026-09-28T10:00:00.000Z')
    })

    it('taking out the last agent leaves an empty list and the command no longer attachable', async () => {
      await seedAgents()
      await seedCommand()

      await toggleSkill('ssacc_nova', false)

      const stored = await storedCommand()
      expect(stored?.enabled_agent_ids).toEqual([])
      expect(stored?.can_be_attached_to_agents).toBe(false)
    })

    it('keeps Enable For All Agents as it is (Access used to switch it off with every toggle)', async () => {
      await seedAgents()
      await seedCommand({ enabled_for_all_agents: true })

      await toggleSkill('ssacc_orla', true)
      await toggleSkill('ssacc_nova', false)
      await toggleSkill('ssacc_orla', false)

      const stored = await storedCommand()
      expect(stored?.enabled_for_all_agents).toBe(true)
      expect(stored?.enabled_agent_ids).toEqual([])
      expect(stored?.can_be_attached_to_agents).toBe(true)
    })

    it('turns a Subagent on too, and two toggles at the same moment both land', async () => {
      await seedAgents()
      await seedCommand({ enabled_agent_ids: [] })

      const results = await Promise.all([toggleSkill('ssacc_scout', true), toggleSkill('ssacc_orla', true)])

      expect(results.map((result) => result.status)).toEqual([200, 200])
      expect([...((await storedCommand())?.enabled_agent_ids ?? [])].sort()).toEqual(['ssacc_orla', 'ssacc_scout'])
    })

    it('a skill with no list is on for every agent: turning one on changes nothing, turning one off keeps every other agent and Subagent on', async () => {
      await seedAgents()
      await seedCommand()
      const legacy = { ...(await storedCommand()) }
      delete legacy.enabled_agent_ids
      await redis.json.set(KEY, '$', legacy as any)
      expect(Object.prototype.hasOwnProperty.call(await storedCommand(), 'enabled_agent_ids')).toBe(false)

      const on = await toggleSkill('ssacc_orla', true)
      expect(on.status).toBe(200)
      expect(on.body.changed).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(await storedCommand(), 'enabled_agent_ids')).toBe(false)

      const off = await toggleSkill('ssacc_orla', false)
      expect(off.status).toBe(200)
      expect(off.body.changed).toBe(true)
      const stored = await storedCommand()
      expect([...(stored?.enabled_agent_ids ?? [])].sort()).toEqual(['ssacc_nova', 'ssacc_pax', 'ssacc_scout'])
      expect(stored?.enabled_agent_ids).not.toContain('ssacc_foreign')
      expect(stored?.can_be_attached_to_agents).toBe(true)

      // From here on the list is explicit: the next toggle is the ordinary one-id change.
      await toggleSkill('ssacc_orla', true)
      expect([...((await storedCommand())?.enabled_agent_ids ?? [])].sort()).toEqual([
        'ssacc_nova',
        'ssacc_orla',
        'ssacc_pax',
        'ssacc_scout'
      ])
    })

    it('an empty list stays an empty list (on for nobody): turning one agent off changes nothing', async () => {
      await seedAgents()
      await seedCommand({ enabled_agent_ids: [] })

      const off = await toggleSkill('ssacc_orla', false)

      expect(off.body.changed).toBe(false)
      expect((await storedCommand())?.enabled_agent_ids).toEqual([])
    })

    it('refuses to turn a skill on for an id that is not one of your agents; turning it off is allowed', async () => {
      await seedAgents()
      await seedCommand({ enabled_agent_ids: ['ssacc_nova', 'ssacc_gone'] })

      const unknown = await toggleSkill('ssacc_ghost', true)
      const foreign = await toggleSkill('ssacc_foreign', true)
      expect(unknown.status).toBe(404)
      expect(unknown.body.error).toContain('ssacc_ghost')
      expect(foreign.status).toBe(404)

      const cleaned = await toggleSkill('ssacc_gone', false)
      expect(cleaned.status).toBe(200)
      expect((await storedCommand())?.enabled_agent_ids).toEqual(['ssacc_nova'])
    })

    it('answers 400 for a bad body, 404 for a missing command, 401 when signed out', async () => {
      await seedAgents()
      await seedCommand()

      expect((await toggleSkill('ssacc_orla', 'yes')).status).toBe(400)
      expect((await toggleSkill('', true)).status).toBe(400)
      expect((await toggleSkill('ssacc_orla', true, { command: 'ssacc-missing' })).status).toBe(404)
      expect((await toggleSkill('ssacc_orla', true, { user: null })).status).toBe(401)
      expect(await redis.json.get(`slash_command:${USER}:ssacc-missing`)).toBeNull()
      expect((await storedCommand())?.enabled_agent_ids).toEqual(['ssacc_nova'])
    })
  })

  describe('PUT /api/artifacts/[id]/agent-access', () => {
    const service = new ArtifactsService()

    async function createArtifact(extra: Record<string, unknown> = {}) {
      return await service.create(USER, {
        name: 'Ssacc Access Artifact',
        content: '<div>ssacc access probe</div>',
        agent_use_enabled: true,
        agent_access_scope: 'selected',
        agent_allowlist: ['ssacc_nova'],
        metadata: { enforce_batshit_artifact_structure: false },
        ...extra
      } as any)
    }

    it('adds and removes one id against the stored list; Agent Use and the scope stay', async () => {
      await seedAgents()
      const created = await createArtifact()
      // The Artifacts panel or another toggle added Pax after Access loaded the artifact.
      await service.setAgentAccess(created.id, USER, 'ssacc_pax', true)

      const added = await toggleArtifact(created.id, 'ssacc_orla', true)
      expect(added.status).toBe(200)
      expect(added.body.agent_allowlist).toEqual(['ssacc_nova', 'ssacc_pax', 'ssacc_orla'])

      const removed = await toggleArtifact(created.id, 'ssacc_nova', false)
      expect(removed.body.agent_allowlist).toEqual(['ssacc_pax', 'ssacc_orla'])
      expect(removed.body.agent_use_enabled).toBe(true)
      expect(removed.body.agent_access_scope).toBe('selected')
      expect((await service.getOwned(created.id, USER)).agent_allowlist).toEqual(['ssacc_pax', 'ssacc_orla'])
    })

    it('refuses an unknown agent, another user, a bad body, and a signed-out caller', async () => {
      await seedAgents()
      const created = await createArtifact()

      expect((await toggleArtifact(created.id, 'ssacc_ghost', true)).status).toBe(404)
      expect((await toggleArtifact(created.id, 'ssacc_orla', true, OTHER_USER)).status).toBe(404)
      expect((await toggleArtifact(created.id, 'ssacc_orla', 1)).status).toBe(400)
      expect((await toggleArtifact(created.id, 'ssacc_orla', true, null)).status).toBe(401)
      expect((await toggleArtifact('artifact_ssacc_missing', 'ssacc_orla', true)).status).toBe(404)
      expect((await service.getOwned(created.id, USER)).agent_allowlist).toEqual(['ssacc_nova'])
    })
  })
})

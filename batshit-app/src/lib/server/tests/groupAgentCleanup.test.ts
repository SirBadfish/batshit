import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import {
  createSchedule,
  getSchedule
} from '$lib/server/services/schedules/scheduleStore'
import { schedulesIndexKey } from '$lib/server/services/schedules/scheduleKeys'
import {
  agentRunCredentialsIndexKey,
  getRunCredential,
  mintRunCredential,
  validateRunCredential
} from '$lib/server/services/agentRunCredentials'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

useRedisTestServer()

const userId = 'group-cleanup-user'

async function seedAgent(id: string, displayName: string, overrides: Record<string, any> = {}) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName,
    agentType: 'API',
    ...overrides
  })
}

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('group cleanup after agent deletion', () => {
  beforeEach(async () => {
    await seedAgent('agent-a', 'Agent A')
    await seedAgent('agent-b', 'Agent B')
    await seedAgent('agent-c', 'Agent C')
  })

  it('scrubs the deleted agent from skill enable-lists and artifact allow-lists, touching nothing else (2026-09-19)', async () => {
    await redis.json.set(`slash_command:${userId}:batshit-guide`, '$', {
      id: 'batshit-guide',
      user_id: userId,
      enabled_for_all_agents: false,
      enabled_agent_ids: ['agent-a', 'agent-b'],
      is_active: true
    } as never)
    await redis.json.set(`slash_command:${userId}:all-agents`, '$', {
      id: 'all-agents',
      user_id: userId,
      enabled_for_all_agents: true,
      enabled_agent_ids: [],
      is_active: true
    } as never)
    await redis.json.set('artifact:art-1', '$', {
      id: 'art-1',
      user_id: userId,
      name: 'Nano',
      agent_access_scope: 'all',
      agent_allowlist: ['agent-a'],
      agent_use_enabled: true
    } as never)
    await redis.json.set('artifact:art-2', '$', {
      id: 'art-2',
      user_id: userId,
      name: 'Other',
      agent_allowlist: null
    } as never)
    await redis.sAdd(`user:${userId}:artifacts`, ['art-1', 'art-2'])

    await redis.deleteAgent('agent-a')

    expect(await redis.json.get(`slash_command:${userId}:batshit-guide`)).toMatchObject({
      enabled_agent_ids: ['agent-b'],
      enabled_for_all_agents: false,
      is_active: true
    })
    expect(await redis.json.get(`slash_command:${userId}:all-agents`)).toMatchObject({
      enabled_agent_ids: []
    })
    expect(await redis.json.get('artifact:art-1')).toMatchObject({
      agent_allowlist: [],
      agent_use_enabled: true,
      name: 'Nano'
    })
    expect(await redis.json.get('artifact:art-2')).toMatchObject({ agent_allowlist: null })
    expect(await redis.get('agent:agent-b')).toMatchObject({ id: 'agent-b' })
  })

  it('scrubs deleted agents from saved groups and repairs driver fallback', async () => {
    await redis.createGroup({
      id: 'group-cleanup-1',
      user_id: userId,
      name: 'Cleanup Group',
      agent_ids: ['agent-a', 'agent-b', 'agent-c'],
      agent_settings: {
        'agent-a': { speak_policy: 'balanced' },
        'agent-b': { speak_policy: 'quiet' },
        'agent-c': { speak_policy: 'topic_only', speak_topics: ['redis'] }
      },
      driver_mode: true,
      driver_agent_id: 'agent-b'
    })

    await redis.deleteAgent('agent-b')

    const group = await redis.getGroup('group-cleanup-1')

    expect(group).not.toBeNull()
    expect(group?.agent_ids).toEqual(['agent-a', 'agent-c'])
    expect(group?.agent_settings).toEqual({
      'agent-a': { speak_policy: 'balanced' },
      'agent-c': { speak_policy: 'topic_only', speak_topics: ['redis'] }
    })
    expect(group?.driver_agent_id).toBe('agent-a')
  })
})

/**
 * SA-115 P3 (DL-115-12) — the third sweep `deleteAgent` owes.
 *
 * `sweepAgentSchedules` existing is not the same as it being CALLED, and the difference is
 * invisible: an unswept schedule keeps its index member, so `listSchedules` prunes a ghost
 * on every read while the ticker's recipient check quietly fails once a minute forever.
 * This lives here rather than beside the store because the store's own suite runs against
 * the in-memory fake, which has no `deleteAgent` — the claim is about the real method.
 */
describe.runIf(REAL_REDIS_LANE)('schedule cleanup after agent deletion (SA-115)', () => {
  beforeEach(async () => {
    // Both need Agent DMs on: a schedule's recipient must be able to see the DM it writes
    // (DL-115-01, the AMD-113-05 parity rule), so `createSchedule` refuses otherwise.
    await seedAgent('agent-sched-a', 'Sched A', { dms_enabled: true })
    await seedAgent('agent-sched-b', 'Sched B', { dms_enabled: true })
  })

  async function indexMembers(): Promise<string[]> {
    const members = await redis.execute(async (client) =>
      client.sMembers(schedulesIndexKey(userId))
    )
    return (Array.isArray(members) ? (members as string[]) : []).sort()
  }

  it('deletes that agent’s schedules and their index members, and only theirs', async () => {
    const doomed = await createSchedule({
      userId,
      agentId: 'agent-sched-a',
      name: 'Morning check',
      cadence: { type: 'daily', at: '09:00' },
      timeZone: 'America/Chicago',
      message: 'Say good morning.'
    })
    const survivor = await createSchedule({
      userId,
      agentId: 'agent-sched-b',
      name: 'Evening check',
      cadence: { type: 'daily', at: '17:00' },
      timeZone: 'America/Chicago',
      message: 'Say good night.'
    })

    await redis.deleteAgent('agent-sched-a')

    expect(await getSchedule(doomed.id)).toBeNull()
    // The index member goes too — a dangling member is a ghost row on every list read.
    expect(await indexMembers()).toEqual([survivor.id])
    // The other agent's clock keeps ticking.
    expect(await getSchedule(survivor.id)).not.toBeNull()
  })
})

/**
 * SA-117 P1 (DL-117-09) — the fourth sweep `deleteAgent` owes.
 *
 * `sweepAgentRunCredentials` existing is not the same as it being CALLED, and the store's own
 * suite cannot tell the difference: it runs against the in-memory fake, which has no
 * `deleteAgent`. The claim here is about the real method, so it lives beside the other three.
 *
 * What an unswept credential is, plainly: a live secret that authenticates as an agent that no
 * longer exists. Every route that acts on it would then look the agent up and fail, or worse,
 * act on whatever a re-created agent of the same id turns out to be.
 */
describe.runIf(REAL_REDIS_LANE)('run credential cleanup after agent deletion (SA-117)', () => {
  beforeEach(async () => {
    await seedAgent('agent-cred-a', 'Cred A')
    await seedAgent('agent-cred-b', 'Cred B')
  })

  async function credentialIndexMembers(agentId: string): Promise<string[]> {
    const members = await redis.execute(async (client) =>
      client.sMembers(agentRunCredentialsIndexKey(agentId))
    )
    return (Array.isArray(members) ? (members as string[]) : []).sort()
  }

  it('deletes that agent\u2019s run credentials and their index, and only theirs', async () => {
    const doomed = await mintRunCredential({
      userId,
      agentId: 'agent-cred-a',
      sessionId: 'sess-cred-a',
      runtime: 'codex'
    })
    const survivor = await mintRunCredential({
      userId,
      agentId: 'agent-cred-b',
      sessionId: 'sess-cred-b',
      runtime: 'claude'
    })

    await redis.deleteAgent('agent-cred-a')

    expect(await getRunCredential(doomed.credentialId)).toBeNull()
    // The secret itself stops working, which is the property that actually matters.
    expect(await validateRunCredential(doomed.token)).toMatchObject({ valid: false })
    expect(await credentialIndexMembers('agent-cred-a')).toEqual([])

    // The other agent's live run is untouched.
    expect(await getRunCredential(survivor.credentialId)).not.toBeNull()
    expect(await validateRunCredential(survivor.token)).toMatchObject({ valid: true })
    expect(await credentialIndexMembers('agent-cred-b')).toEqual([survivor.credentialId])
  })
})

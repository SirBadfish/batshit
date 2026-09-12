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

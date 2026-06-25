import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

useRedisTestServer()

const userId = 'group-cleanup-user'

async function seedAgent(id: string, displayName: string) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName,
    agentType: 'API'
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

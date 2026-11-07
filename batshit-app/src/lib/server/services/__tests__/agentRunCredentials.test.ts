import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { agentRunCredentialKey, agentRunCredentialsIndexKey, sweepAgentRunCredentials } from '../agentRunCredentials'

useRedisTestServer()

describe('retired credential cleanup on agent deletion', () => {
  it('removes only the deleted agent’s indexed records and index, including expired members', async () => {
    const doomed = 'arc_old_first'
    const survivor = 'arc_old_other'
    await redis.json.set(agentRunCredentialKey(doomed), '$', { id: doomed, agentId: 'first' } as never)
    await redis.json.set(agentRunCredentialKey(survivor), '$', { id: survivor, agentId: 'other' } as never)
    await redis.execute(async client => {
      await client.sAdd(agentRunCredentialsIndexKey('first'), [doomed, 'arc_old_expired'])
      await client.sAdd(agentRunCredentialsIndexKey('other'), [survivor])
    })
    expect(await sweepAgentRunCredentials('first')).toBe(1)
    expect(await redis.json.get(agentRunCredentialKey(doomed))).toBeNull()
    expect(await redis.exists(agentRunCredentialsIndexKey('first'))).toBe(false)
    expect(await redis.json.get(agentRunCredentialKey(survivor))).not.toBeNull()
    expect(await redis.execute(client => client.sMembers(agentRunCredentialsIndexKey('other')))).toEqual([survivor])
    expect(await sweepAgentRunCredentials('first')).toBe(0)
    expect(await sweepAgentRunCredentials('')).toBe(0)
    await sweepAgentRunCredentials('other')
  })
})

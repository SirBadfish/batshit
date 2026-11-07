import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  agentRunCredentialKey,
  agentRunCredentialsIndexKey,
  removeRetiredCliCredentialIndexSets,
} from '../agentRunCredentials'

/**
 * SA-139 R5: the startup step that removes the CLI Subagent and Worker runs' credential index
 * sets (keyed by a runtime id no stored record names, so no delete swept them). Real Redis only:
 * it is a SCAN, type checks and deletes, which the default lane's fake does not model.
 */

useRedisTestServer()

const SUBAGENT_SET = agentRunCredentialsIndexKey('subagent_cli_rcis_old_helper')
const WORKER_SET = agentRunCredentialsIndexKey('subagent_cli-worker_rcis_parent_1')
const PRIMARY_SET = agentRunCredentialsIndexKey('rcis_live_primary')
const ODD_KEY = agentRunCredentialsIndexKey('subagent_cli_rcis_not_a_set')

async function cleanup() {
  for (const key of await redis.keys('agent_run_credential*:*rcis*')) await redis.del(key)
  for (const id of ['rcis-a', 'rcis-b', 'rcis-c', 'rcis-live']) await redis.del(agentRunCredentialKey(id))
}

beforeEach(async () => {
  await cleanup()
  await redis.execute(async (client) => {
    await client.sAdd(SUBAGENT_SET, ['rcis-a', 'rcis-b'])
    await client.sAdd(WORKER_SET, ['rcis-c'])
    await client.sAdd(PRIMARY_SET, ['rcis-live'])
    await client.set(ODD_KEY, 'not a set')
    for (const id of ['rcis-a', 'rcis-c', 'rcis-live']) await client.json.set(agentRunCredentialKey(id), '$', { id })
  })
})

afterEach(cleanup)

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('the R5 startup removal of retired CLI credential index sets', () => {
  it('removes every CLI Subagent and Worker index set and the records they list; leaves a Primary set and a key of another type', async () => {
    const result = await removeRetiredCliCredentialIndexSets()

    expect(result).toEqual({ sets: 2, records: 2 })
    for (const key of [SUBAGENT_SET, WORKER_SET, agentRunCredentialKey('rcis-a'), agentRunCredentialKey('rcis-c')]) {
      expect(await redis.exists(key), key).toBe(false)
    }
    expect(await redis.execute((client) => client.sMembers(PRIMARY_SET))).toEqual(['rcis-live'])
    expect(await redis.exists(agentRunCredentialKey('rcis-live'))).toBe(true)
    expect(await redis.execute((client) => client.get(ODD_KEY))).toBe('not a set')

    expect(await removeRetiredCliCredentialIndexSets()).toEqual({ sets: 0, records: 0 })
  })
})

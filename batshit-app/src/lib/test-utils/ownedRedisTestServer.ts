import path from 'node:path'
import { afterAll, beforeAll, expect } from 'vitest'
import type { redis as service } from '$lib/server/redis'
import { clearRedisTestDatabase, useRedisTestServer, type RedisTestServerOptions } from './redis-memory'

// Opt-in admission for the existing packet's ONE server, not a runtime allocator.
// Import first; ordinary/default and separately allocation-gated callers keep their owners.
const ownedRedisRunId = process.env.COOPER_FIXTURE_REDIS_RUN_ID
const ownedRedisDir = process.env.COOPER_FIXTURE_REDIS_DIR
const ownedRedisLane = ownedRedisRunId !== undefined || ownedRedisDir !== undefined
const ownedRedisUrl = 'redis://127.0.0.1:6393/15'
function checkOwnedRedisIntent() {
  if (!ownedRedisLane) return
  if (process.env.VITEST_USE_REAL_REDIS !== 'true' || !ownedRedisRunId || !/^[a-f0-9]{40}$/.test(ownedRedisRunId) ||
      !ownedRedisDir || !path.isAbsolute(ownedRedisDir) || path.normalize(ownedRedisDir) !== ownedRedisDir ||
      ['BATSHIT_REDIS_TEST_URL', 'VITEST_REDIS_URL', 'REDIS_URL'].some(key => process.env[key] !== ownedRedisUrl)) {
    throw new Error('The owned Redis packet needs its fresh run/directory and three exact DB15 URLs before admission.')
  }
}
checkOwnedRedisIntent()

export function useOwnedRedisTestServer(redis: Pick<typeof service, 'execute' | 'disconnect'>, options: RedisTestServerOptions = {}) {
  const ownedRedisPreviousPool = process.env.VITEST_POOL_ID
  let ownedRedisClient: any
  let ownedRedisAdmitted = false
  let ownedRedisRetired = false
  let ownedRedisAcquisition: Promise<unknown> | undefined
  beforeAll(() => { if (ownedRedisLane) process.env.VITEST_POOL_ID = '0' })
  async function checkOwnedRedisClient(client: any, empty: boolean) {
    checkOwnedRedisIntent()
    expect(client.isOpen && client.isReady).toBe(true)
    const connection = await client.clientInfo()
    expect(connection.db).toBe(15)
    expect(connection.laddr).toBe('127.0.0.1:6393')
    expect(Number.isSafeInteger(connection.id) && connection.id > 0).toBe(true)
    const server: string = await client.info('server')
    const field = (name: string) => {
      const lines = server.split(/\r?\n/).filter(line => line.startsWith(`${name}:`))
      expect(lines).toHaveLength(1)
      return lines[0].slice(name.length + 1)
    }
    expect(field('run_id')).toBe(ownedRedisRunId)
    expect(field('redis_version')).toBe('8.10.1')
    expect(field('tcp_port')).toBe('6393')
    expect((await client.configGet('dir')).dir).toBe(ownedRedisDir)
    expect((await client.configGet('save')).save).toBe('')
    expect((await client.configGet('appendonly')).appendonly).toBe('no')
    const modules: unknown = await client.sendCommand(['MODULE', 'LIST'])
    if (!Array.isArray(modules) || modules.some(row => !Array.isArray(row))) throw new Error('Owned Redis modules are unreadable.')
    expect(modules.map(row => row[row.indexOf('name') + 1])).toEqual(expect.arrayContaining(['ReJSON', 'search']))
    for (const command of ['JSON.GET', 'FT.SEARCH']) {
      expect(await client.sendCommand(['COMMAND', 'INFO', command])).toEqual([expect.any(Array)])
    }
    expect(await client.sendCommand(['JSON.GET', 'cooper:fixture:admission:missing', '$'])).toBeNull()
    const keyspace: string = await client.info('keyspace')
    expect(keyspace.split(/\r?\n/).filter(line => /^db\d+:/.test(line) && !line.startsWith('db15:'))).toEqual([])
    if (empty) expect(await client.dbSize()).toBe(0)
    return connection.id as number
  }
  async function admitOwnedRedis({ adminClient, resolvedUrl }: { adminClient: any; resolvedUrl: string }) {
    if (!ownedRedisLane) return
    checkOwnedRedisIntent()
    expect(resolvedUrl).toBe(ownedRedisUrl)
    const adminId = await checkOwnedRedisClient(adminClient, true)
    ownedRedisAcquisition = redis.execute(async (client: any) => {
      ownedRedisClient = client
      if (ownedRedisRetired) { if (client.isOpen) await client.disconnect(); throw new Error('Owned Redis acquisition settled after retirement.') }
      const appId = await checkOwnedRedisClient(client, true)
      if (ownedRedisRetired) { if (client.isOpen) await client.disconnect(); throw new Error('Owned Redis admission settled after retirement.') }
      expect(appId).not.toBe(adminId)
    })
    try {
      await ownedRedisAcquisition
      if (ownedRedisRetired) throw new Error('Owned Redis admission was retired.')
      ownedRedisAdmitted = true
    } catch (error) {
      try { await redis.disconnect() } catch (closeError) {
        throw new AggregateError([error, closeError], 'Owned Redis admission and app closure failed.')
      }
      throw error
    }
  }
  async function retireOwnedRedis() {
    if (!ownedRedisLane) return
    ownedRedisRetired = true
    const errors: unknown[] = []
    try {
      if (ownedRedisAdmitted && ownedRedisAdmission.isAdmitted() && ownedRedisClient) {
        await checkOwnedRedisClient(ownedRedisClient, false)
        await clearRedisTestDatabase(ownedRedisClient)
      }
    } catch (error) { errors.push(error) }
    finally {
      // Public disconnect acquires no new connection and resets this fixture's facade.
      try { await redis.disconnect() } catch (error) { errors.push(error) }
      if (ownedRedisAcquisition) {
        try { await ownedRedisAcquisition } catch (error) { if (!errors.includes(error)) errors.push(error) }
      }
      if (ownedRedisPreviousPool === undefined) delete process.env.VITEST_POOL_ID
      else process.env.VITEST_POOL_ID = ownedRedisPreviousPool
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Owned Redis cleanup and closure failed.')
  }

  const ownedRedisAdmission = useRedisTestServer({ beforeCleanupAdmission: async context => {
    await admitOwnedRedis(context)
    await options.beforeCleanupAdmission?.(context)
  } })
  afterAll(retireOwnedRedis)
  return { ...ownedRedisAdmission, ownedLane: ownedRedisLane }
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type RedisClientType } from 'redis'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'
import { clearRedisTestDatabase } from '$lib/test-utils/redis-memory'

/**
 * BL-135 — the real-Redis test lane clears its own database and nothing else.
 *
 * A search index is not stored in a database: flushing ANY database drops every Redis Search
 * index on the whole server (measured on Redis 8.10.1). The real-Redis lane (`npm run
 * test:redis`) runs on DB15 of the developer's own Redis, whose DB0 holds the Native lane's
 * `batshit_memory_idx` and `batshit_memseg_idx`, so the harness's FLUSHDB before every test
 * deleted them, and memory recall answered `SEARCH_INDEX_NOT_FOUND` until the lane restarted.
 * The harness now clears its database with SCAN + UNLINK (`clearRedisTestDatabase`).
 *
 * This lives on the memory lane (`npm run test:memory`) because only a disposable server whose
 * DB0 belongs to the suite can hold a search index: FT.CREATE refuses any database but 0, and
 * the normal harness refuses DB0.
 */

const harness = useMemorySearchTestServer()

describe.runIf(memorySearchLaneActive())('the real-Redis lane clears only its own database (BL-135)', () => {
  const TEST_DB = 15
  let testDb: RedisClientType
  let index = ''

  beforeAll(async () => {
    testDb = createClient({ url: harness.url(), database: TEST_DB })
    testDb.on('error', () => undefined)
    await testDb.connect()
  })

  afterAll(async () => {
    if (testDb?.isOpen) await testDb.quit()
  })

  /** DB0 gets a search index over one JSON record; the test database gets one key of each type. */
  async function seedIndexAndTestKeys() {
    const admin = harness.adminClient()
    index = `bl135_idx_${Date.now().toString(36)}`
    await admin.sendCommand([
      'FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', 'bl135:', 'SCHEMA', '$.name', 'AS', 'name', 'TEXT'
    ])
    await admin.json.set('bl135:memory:1', '$', { name: 'a memory that must stay findable' })

    await testDb.json.set('message:bl135-session:msg-1', '$', { id: 'msg-1', content: 'test data' })
    await testDb.set('bl135:string', 'value')
    await testDb.sAdd('bl135:set', ['a', 'b'])
    await testDb.rPush('bl135:list', ['a', 'b'])
    await testDb.zAdd('bl135:zset', [{ score: 1, value: 'a' }])
    await testDb.hSet('bl135:hash', { field: 'value' })
    expect(await testDb.dbSize()).toBe(6)
  }

  async function indexNames(): Promise<string[]> {
    return (await harness.adminClient().sendCommand(['FT._LIST'])) as string[]
  }

  async function searchHits(): Promise<number> {
    const reply = (await harness.adminClient().sendCommand([
      'FT.SEARCH', index, 'findable', 'NOCONTENT'
    ])) as unknown[]
    return Number(reply[0])
  }

  it('empties the test database and leaves the search indexes on DB0 in place', async () => {
    await seedIndexAndTestKeys()
    expect(await searchHits()).toBe(1)

    expect(await clearRedisTestDatabase(testDb)).toBe(6)

    expect(await testDb.dbSize()).toBe(0)
    expect(await indexNames()).toContain(index)
    expect(await searchHits()).toBe(1)
    expect(await harness.adminClient().exists('bl135:memory:1')).toBe(1)
  })

  it('clears a database larger than one SCAN batch', async () => {
    const ids = Array.from({ length: 2500 }, (_, n) => `bl135:bulk:${n}`)
    for (let start = 0; start < ids.length; start += 500) {
      await Promise.all(ids.slice(start, start + 500).map((key) => testDb.set(key, 'v')))
    }
    expect(await testDb.dbSize()).toBe(2500)

    expect(await clearRedisTestDatabase(testDb)).toBe(2500)
    expect(await testDb.dbSize()).toBe(0)
  })

  it('refuses database 0 and deletes nothing there', async () => {
    const admin = harness.adminClient()
    await admin.set('bl135:db0-key', 'value')

    await expect(clearRedisTestDatabase(admin)).rejects.toThrow(/database 0/)
    expect(await admin.exists('bl135:db0-key')).toBe(1)
  })

  it('the reason: FLUSHDB on the test database drops that DB0 index (Redis 8.10.1)', async () => {
    await seedIndexAndTestKeys()
    expect(await indexNames()).toContain(index)

    // The command the harness used to run before every test. If Redis ever makes FLUSHDB
    // database-local for search indexes, this fails, and BL-135's premise needs rereading.
    await testDb.flushDb()

    expect(await indexNames()).not.toContain(index)
    // The record itself survives on DB0; only the index that finds it is gone.
    expect(await harness.adminClient().exists('bl135:memory:1')).toBe(1)
  })
})

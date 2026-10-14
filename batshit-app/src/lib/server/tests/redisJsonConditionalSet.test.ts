import { afterEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * The facade's conditional JSON writes, on both lanes (real Redis 8 under `npm run test:redis`, the
 * fake twin under plain `npm test`): `setIfAbsent` is `JSON.SET … NX` (BL-516: a preset create makes
 * its record only while no record has that id), `setIfExists` is `JSON.SET … XX` (BL-753).
 */

useRedisTestServer()

const KEY = 'zjcond_record'

afterEach(async () => {
  await redis.del(KEY)
})

describe('redis.json conditional writes', () => {
  it('setIfAbsent writes a new key once; a second write finds it and changes nothing', async () => {
    expect(await redis.json.setIfAbsent(KEY, '$', { first: true })).toBe(true)
    expect(await redis.json.setIfAbsent(KEY, '$', { second: true })).toBe(false)
    expect(await redis.json.get(KEY)).toEqual({ first: true })
  })

  it('setIfExists writes only an existing key', async () => {
    expect(await redis.json.setIfExists(KEY, '$', { made: true })).toBe(false)
    expect(await redis.exists(KEY)).toBe(false)
    await redis.json.set(KEY, '$', { v: 1 })
    expect(await redis.json.setIfExists(KEY, '$', { v: 2 })).toBe(true)
    expect(await redis.json.get(KEY)).toEqual({ v: 2 })
  })
})

// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  acquireSubagentRunLock,
  buildSubagentRunLockKey,
  releaseSubagentRunLock,
  stillHoldsSubagentRunLock,
} from '../subagentThreads'

/**
 * Delegation limits (Josh, 2026-10-24) — the same-subagent run lock's heartbeat on REAL Redis.
 * A call has no time limit by default, so the lock lives a short TTL its holder refreshes with a
 * compare-and-PEXPIRE script; the release is a compare-and-delete script. Lua atomicity and
 * Redis' own expiry are the claims here, so this suite runs only under `npm run test:redis`
 * (DB 15); the default lane covers the same rules against `subagent-redis-mock`.
 */

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const admission = useRedisTestServer()
beforeEach(() => {
  if (REAL) admission.requireAdmission()
})
afterAll(async () => {
  if (REAL) await redis.disconnect()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const pttl = (key: string) => redis.execute((client: any) => client.pTTL(key)) as Promise<number>

describe.runIf(REAL)('subagent run lock heartbeat (real Redis)', () => {
  it('a live holder keeps its lock well past one TTL, and its release frees it at once', async () => {
    const handle = await acquireSubagentRunLock({
      sessionId: 'lock-real',
      slug: 'builder',
      subagentLabel: 'Builder',
      ttlMs: 1_000,
      heartbeatMs: 200,
    })
    const key = buildSubagentRunLockKey('lock-real', 'builder')
    await sleep(2_500)
    expect(await stillHoldsSubagentRunLock(handle)).toBe(true)
    expect(handle.lost).toBe(false)
    // The refresh keeps the remaining TTL near the full TTL.
    expect(await pttl(key)).toBeGreaterThan(600)
    expect(await releaseSubagentRunLock(handle)).toBe(true)
    expect(await redis.execute((client: any) => client.exists(key))).toBe(0)
  })

  it('a crashed holder (no more beats, no release) frees the lock by Redis expiry within one TTL', async () => {
    const crashed = await acquireSubagentRunLock({
      sessionId: 'lock-real',
      slug: 'builder',
      subagentLabel: 'Builder',
      ttlMs: 1_000,
      heartbeatMs: 200,
    })
    crashed.stopHeartbeat()
    const startedAt = Date.now()
    const next = await acquireSubagentRunLock({
      sessionId: 'lock-real',
      slug: 'builder',
      subagentLabel: 'Builder',
      ttlMs: 1_000,
      heartbeatMs: 200,
    })
    expect(Date.now() - startedAt).toBeLessThan(1_700)
    expect(await releaseSubagentRunLock(crashed)).toBe(false)
    expect(await releaseSubagentRunLock(next)).toBe(true)
  })

  it('a stale holder\'s heartbeat never extends the newer holder\'s lock (compare-and-PEXPIRE)', async () => {
    const stale = await acquireSubagentRunLock({
      sessionId: 'lock-real',
      slug: 'builder',
      subagentLabel: 'Builder',
      ttlMs: 1_000,
      heartbeatMs: 200,
    })
    const key = buildSubagentRunLockKey('lock-real', 'builder')
    // The lock lapses under the stale holder and another call takes it.
    await redis.execute((client: any) => client.del(key))
    const newer = await acquireSubagentRunLock({
      sessionId: 'lock-real',
      slug: 'builder',
      subagentLabel: 'Builder',
      ttlMs: 1_000,
      heartbeatMs: 200,
    })
    newer.stopHeartbeat()
    await sleep(500)
    expect(stale.lost).toBe(true)
    // Had the stale beat refreshed it, the newer lock would still be near its full TTL.
    await sleep(700)
    expect(await stillHoldsSubagentRunLock(newer)).toBe(false)
    expect(await releaseSubagentRunLock(stale)).toBe(false)
  })
})

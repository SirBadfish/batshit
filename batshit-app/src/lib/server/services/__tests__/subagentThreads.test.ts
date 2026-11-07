import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-111 P2 (DL-111-04, DL-111-05, DL-111-06) — the thread-control primitives on their own,
 * against a real in-memory store so `SET … NX`, TTL expiry, and compare-and-delete are
 * genuinely exercised rather than stubbed.
 */

const threadMocks = vi.hoisted(() => ({
  redisStore: { current: null as any },
}))

vi.mock('$lib/server/redis', () => ({
  redis: new Proxy({} as Record<string, any>, {
    get(_target, prop: string) {
      return threadMocks.redisStore.current.redis[prop]
    },
  }),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import {
  acquireSubagentRunLock,
  buildSubagentRunLockKey,
  buildSubagentThreadKey,
  isSubagentBusyError,
  isSubagentCallCancelledError,
  normalizeSubagentThreadMode,
  releaseSubagentRunLock,
  resetManagedSubagentThread,
  stillHoldsSubagentRunLock,
  SUBAGENT_LOCK_HEARTBEAT_MS,
  SUBAGENT_LOCK_TTL_MS,
  SubagentBusyError,
} from '../subagentThreads'

const subagentRedis = createSubagentRedisMock()
threadMocks.redisStore.current = subagentRedis

beforeEach(() => {
  subagentRedis.clear()
})

describe('subagent thread keys', () => {
  it('keeps the exchange key and the run-lock key distinct', () => {
    expect(buildSubagentThreadKey('s1', 'helper')).toBe(
      'subagent_sessions:s1:subagent:helper'
    )
    expect(buildSubagentRunLockKey('s1', 'helper')).toBe('subagent_lock:s1:helper')
  })

  it('defaults every unrecognised thread value to fresh', () => {
    // Josh's decision #3: fresh unless the agent explicitly asks to resume.
    expect(normalizeSubagentThreadMode('resume')).toBe('resume')
    for (const value of [undefined, null, '', 'RESUME', 'continue', 'fresh', 7, {}]) {
      expect(normalizeSubagentThreadMode(value)).toBe('fresh')
    }
  })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('subagent run lock (DL-111-05, heartbeat since the delegation limits 2026-10-24)', () => {
  it('pins the production TTL and heartbeat: a short lock the holder refreshes', () => {
    // A call has no time limit by default, so the lock cannot be sized to one call any more.
    // It lives 30 s and its holder refreshes it every 10 s: three chances per TTL.
    expect(SUBAGENT_LOCK_TTL_MS).toBe(30_000)
    expect(SUBAGENT_LOCK_HEARTBEAT_MS).toBe(10_000)
    expect(SUBAGENT_LOCK_HEARTBEAT_MS * 3).toBeLessThanOrEqual(SUBAGENT_LOCK_TTL_MS)
  })

  it('keeps a live holder\'s lock past its TTL, and hands the turn on at its release', async () => {
    // The holder runs far longer than one TTL; its heartbeat keeps the lock, so the queued
    // call waits (it would have barged in on the old fixed-TTL lock) and goes on release.
    const first = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 300,
      heartbeatMs: 100,
    })
    let secondToken: string | null = null
    const queued = acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 300,
      heartbeatMs: 100,
    }).then((handle) => {
      secondToken = handle.token
      return handle
    })

    await sleep(1_000)
    expect(secondToken).toBeNull()
    expect(await stillHoldsSubagentRunLock(first)).toBe(true)
    expect(first.lost).toBe(false)

    expect(await releaseSubagentRunLock(first)).toBe(true)
    const second = await queued
    expect(second.token).not.toBe(first.token)
    expect(second.waitedMs).toBeGreaterThanOrEqual(900)
    expect(await releaseSubagentRunLock(second)).toBe(true)
  })

  it('frees a crashed holder\'s lock within one TTL', async () => {
    // A holder that dies never releases and never beats again. Its lock must not block the
    // Subagent for hours: it lapses one TTL after the last beat and the waiter goes. (A TTL
    // under 1 s is raised to 1 s, so this test's lock lives 1 s.)
    const crashed = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 1_000,
      heartbeatMs: 100,
    })
    crashed.stopHeartbeat()
    const startedAt = Date.now()
    const next = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 1_000,
      heartbeatMs: 100,
    })
    // One TTL, plus at most one poll interval (500 ms).
    expect(Date.now() - startedAt).toBeLessThan(1_000 + 600)
    expect(next.token).not.toBe(crashed.token)
    // The crashed handle is stale now, so releasing it must not steal the new lock.
    expect(await releaseSubagentRunLock(crashed)).toBe(false)
    expect(await releaseSubagentRunLock(next)).toBe(true)
  })

  it('a waiter with no budget waits while the holder lives, and its Stop ends the wait', async () => {
    const holder = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 300,
      heartbeatMs: 100,
    })
    const controller = new AbortController()
    const waiting = acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      abortSignal: controller.signal,
    }).catch((error: unknown) => error)
    await sleep(700)
    controller.abort()

    const rejection = await waiting
    expect(isSubagentCallCancelledError(rejection)).toBe(true)
    expect(isSubagentBusyError(rejection)).toBe(false)
    expect((rejection as Error).message).toBe('Subagent call was cancelled while waiting for its turn.')
    expect(await releaseSubagentRunLock(holder)).toBe(true)
  })

  it('reports busy only to a caller that set an explicit budget', async () => {
    const holder = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 300,
      heartbeatMs: 100,
    })

    await expect(
      acquireSubagentRunLock({
        sessionId: 's1',
        slug: 'helper',
        subagentLabel: 'Long Runner',
        waitBudgetMs: 500,
      })
    ).rejects.toBeInstanceOf(SubagentBusyError)
    await releaseSubagentRunLock(holder)
  })

  it('BL-643: a caller stopped before it queues gets the cancelled error, not busy', async () => {
    const holder = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
    })
    const controller = new AbortController()
    controller.abort()

    const rejection = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      abortSignal: controller.signal,
    }).catch((error: unknown) => error)

    expect(isSubagentCallCancelledError(rejection)).toBe(true)
    expect(isSubagentBusyError(rejection)).toBe(false)
    await releaseSubagentRunLock(holder)
  })

  it('lets a queued caller take its turn once the holder releases', async () => {
    const first = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
    })

    const queued = acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
    })

    await releaseSubagentRunLock(first)
    const second = await queued

    expect(second.token).not.toBe(first.token)
    expect(await releaseSubagentRunLock(second)).toBe(true)
  })

  it('never blocks calls to different subagents', async () => {
    const a = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'alpha',
      subagentLabel: 'Alpha',
    })
    const b = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'beta',
      subagentLabel: 'Beta',
    })

    expect(a.key).not.toBe(b.key)
    await releaseSubagentRunLock(a)
    await releaseSubagentRunLock(b)
  })

  it('reports lock loss instead of stealing the release or refreshing the newer lock', async () => {
    // The whole point of compare-and-delete (and of compare-and-refresh): if our lock lapsed
    // and someone else took the turn, we must NOT delete their lock, must NOT keep it alive on
    // our clock, and must NOT write our thread over theirs.
    const handle = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 300,
      heartbeatMs: 100,
    })

    subagentRedis.expireNow(handle.key)
    const other = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 300,
      heartbeatMs: 100,
    })
    other.stopHeartbeat()
    await sleep(250)

    expect(handle.lost).toBe(true)
    // The runner stops the call on this signal, so the two never run at once.
    expect(handle.lostSignal.aborted).toBe(true)
    expect(other.lostSignal.aborted).toBe(false)
    expect(await stillHoldsSubagentRunLock(handle)).toBe(false)
    expect(await releaseSubagentRunLock(handle)).toBe(false)
    // The stale heartbeat did not extend the newer lock: it lapses on its own clock (1 s, the
    // floor a shorter TTL is raised to).
    await sleep(900)
    expect(await stillHoldsSubagentRunLock(other)).toBe(false)
  })

  it('refuses a malformed budget or a heartbeat that cannot keep up', async () => {
    // Fail loudly, not open: NaN would make every `waited >= NaN` false and queue forever.
    for (const waitBudgetMs of [-1, Number.NaN]) {
      await expect(
        acquireSubagentRunLock({
          sessionId: 's1',
          slug: 'helper',
          subagentLabel: 'Helper',
          waitBudgetMs,
        })
      ).rejects.toThrow('resolved non-negative wait budget')
    }
    await expect(
      acquireSubagentRunLock({
        sessionId: 's1',
        slug: 'helper',
        subagentLabel: 'Helper',
        ttlMs: 1_000,
        heartbeatMs: 1_000,
      })
    ).rejects.toThrow('heartbeat must be shorter than its TTL')
  })

  it('reports how long a call queued, so the extra wall clock is explainable', async () => {
    const straightThrough = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
    })
    // Nothing held the turn, so there is nothing to explain.
    expect(straightThrough.waitedMs).toBeLessThan(50)

    const queued = acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
    })
    await sleep(200)
    await releaseSubagentRunLock(straightThrough)
    const second = await queued
    expect(second.token).not.toBe(straightThrough.token)
    expect(second.waitedMs).toBeGreaterThanOrEqual(150)
    await releaseSubagentRunLock(second)
  })

  it('recognises its own busy error', () => {
    expect(isSubagentBusyError(new SubagentBusyError('Helper', 3_000))).toBe(true)
    expect(isSubagentBusyError(new Error('something else'))).toBe(false)
    expect(new SubagentBusyError('Helper', 3_000).message).toContain('Helper')
  })
})

describe('managed thread reset', () => {
  it('discards the stored exchanges', async () => {
    subagentRedis.seed(buildSubagentThreadKey('s1', 'helper'), [
      { role: 'user', content: 'hi' },
    ])

    await resetManagedSubagentThread('s1', 'helper')

    expect(subagentRedis.snapshot()[buildSubagentThreadKey('s1', 'helper')]).toBeUndefined()
  })
})

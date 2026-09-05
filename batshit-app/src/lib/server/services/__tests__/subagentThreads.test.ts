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
  buildSubagentN8nThreadIdKey,
  buildSubagentRunLockKey,
  buildSubagentThreadKey,
  buildSubagentThreadStateKey,
  isSubagentBusyError,
  N8N_SUBAGENT_THREAD_TTL_SECONDS,
  normalizeSubagentThreadMode,
  releaseSubagentRunLock,
  resetManagedSubagentThread,
  resolveSubagentLockTtlMs,
  resolveSubagentLockWaitMs,
  selectN8nSubagentThreadId,
  stillHoldsSubagentRunLock,
  SubagentBusyError,
} from '../subagentThreads'

const subagentRedis = createSubagentRedisMock()
threadMocks.redisStore.current = subagentRedis

beforeEach(() => {
  subagentRedis.clear()
})

describe('subagent thread keys', () => {
  it('keeps the managed exchange key and the n8n thread-id key distinct', () => {
    // Two owners, two keys (DL-111-06). Batshit stores a managed subagent's exchanges; for
    // an n8n Workflow Subagent it stores only the id that names n8n's own conversation.
    expect(buildSubagentThreadKey('s1', 'helper')).toBe(
      'subagent_sessions:s1:subagent:helper'
    )
    expect(buildSubagentN8nThreadIdKey('s1', 'helper')).toBe('subagent_thread:s1:helper')
    expect(buildSubagentRunLockKey('s1', 'helper')).toBe('subagent_lock:s1:helper')
  })

  it('answers the roster\u2019s thread question from the key its owner actually writes', () => {
    // Reading the managed exchange key for an n8n Workflow Subagent would report `none`
    // whenever n8n runs on its own Redis — a confidently-wrong roster fact the primary acts
    // on. Each type is asked about the key someone actually writes.
    expect(buildSubagentThreadStateKey('s1', 'flow', 'n8n-workflow')).toBe(
      'subagent_thread:s1:flow'
    )
    for (const type of ['api', 'cli']) {
      expect(buildSubagentThreadStateKey('s1', 'helper', type)).toBe(
        'subagent_sessions:s1:subagent:helper'
      )
    }
  })

  it('defaults every unrecognised thread value to fresh', () => {
    // Josh's decision #3: fresh unless the agent explicitly asks to resume.
    expect(normalizeSubagentThreadMode('resume')).toBe('resume')
    for (const value of [undefined, null, '', 'RESUME', 'continue', 'fresh', 7, {}]) {
      expect(normalizeSubagentThreadMode(value)).toBe('fresh')
    }
  })
})

describe('subagent run lock (DL-111-05)', () => {
  it('waits out a holder whose turn ends before the waiter gives up', async () => {
    // Equal budgets is the normal case: the holder's lock cannot outlive its own TTL, and
    // `resolveSubagentLockWaitMs` gives the waiter that whole lifetime plus grace, so the
    // waiter always gets its turn rather than failing spuriously.
    const first = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 200,
      waitBudgetMs: 2200,
    })

    const second = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 200,
      waitBudgetMs: 2200,
    })

    expect(second.token).not.toBe(first.token)
    // The first handle is stale now, so releasing it must not steal the second's lock.
    expect(await releaseSubagentRunLock(first)).toBe(false)
    expect(await releaseSubagentRunLock(second)).toBe(true)
  })

  it('reports busy when the holder outlasts the waiter\'s whole budget', async () => {
    // The asymmetric-budget case: the waiter's budget is smaller than the holder's whole
    // lifetime, which happens when the subagent's stored Call Timeout changed between the
    // holder starting and the waiter arriving. Then busy is the honest answer.
    await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 60_000,
      waitBudgetMs: 62000,
    })

    await expect(
      acquireSubagentRunLock({
        sessionId: 's1',
        slug: 'helper',
        subagentLabel: 'Long Runner',
        ttlMs: 100,
        waitBudgetMs: 2100,
      })
    ).rejects.toBeInstanceOf(SubagentBusyError)
  })

  it('lets a queued caller take its turn once the holder releases', async () => {
    const first = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 5_000,
      waitBudgetMs: 7000,
    })

    const queued = acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 5_000,
      waitBudgetMs: 7000,
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
      ttlMs: 5_000,
      waitBudgetMs: 7000,
    })
    const b = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'beta',
      subagentLabel: 'Beta',
      ttlMs: 5_000,
      waitBudgetMs: 7000,
    })

    expect(a.key).not.toBe(b.key)
    await releaseSubagentRunLock(a)
    await releaseSubagentRunLock(b)
  })

  it('reports lock loss instead of stealing the release', async () => {
    // The whole point of compare-and-delete: if our TTL lapsed and someone else took the
    // turn, we must NOT delete their lock and must NOT write our thread over theirs.
    const handle = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 5_000,
      waitBudgetMs: 7000,
    })

    subagentRedis.expireNow(handle.key)
    const other = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 5_000,
      waitBudgetMs: 7000,
    })

    expect(await stillHoldsSubagentRunLock(handle)).toBe(false)
    expect(await releaseSubagentRunLock(handle)).toBe(false)
    // The newer holder still owns its lock.
    expect(await stillHoldsSubagentRunLock(other)).toBe(true)
  })

  it('sizes the TTL as the already-resolved call timeout + 5 s', () => {
    expect(resolveSubagentLockTtlMs(120_000)).toBe(125_000)
    expect(() => resolveSubagentLockTtlMs(0)).toThrow('resolved positive call timeout')
    expect(() => resolveSubagentLockTtlMs(Number.NaN)).toThrow(
      'resolved positive call timeout'
    )
  })

  it('sizes the queue budget as a full holder lifetime, and pins the 2x wall clock', () => {
    // The queue budget is its OWN decision, not a side effect of the TTL: a waiter gets the
    // holder's whole lifetime plus slack so a legitimate second call to the same subagent
    // never fails spuriously and never runs on a partial budget.
    expect(resolveSubagentLockWaitMs(120_000)).toBe(127_000)
    expect(resolveSubagentLockWaitMs(300_000)).toBe(307_000)

    // The deliberate, documented cost of that choice: a QUEUED call's wall clock is the wait
    // plus its own full run, i.e. a bit over twice the Call Timeout. This assertion exists so
    // that number can only change on purpose — Agent Settings -> Call Timeout and
    // `primary-agent-types.md` both state it, and the runner reports the wait in `threadNote`.
    const callTimeoutMs = 300_000
    const worstCaseMs = resolveSubagentLockWaitMs(callTimeoutMs) + callTimeoutMs
    expect(worstCaseMs).toBe(607_000)
    expect(worstCaseMs).toBeLessThanOrEqual(callTimeoutMs * 2 + 10_000)
  })

  it('refuses a missing or negative queue budget instead of waiting forever', async () => {
    // Fail loudly, not open. `Math.floor(undefined)` is NaN and every `waited >= NaN` is
    // false, so a caller that forgot the budget would queue until the process died.
    await expect(
      acquireSubagentRunLock({
        sessionId: 's1',
        slug: 'helper',
        subagentLabel: 'Helper',
        ttlMs: 5_000,
        waitBudgetMs: undefined as unknown as number,
      })
    ).rejects.toThrow('resolved non-negative wait budget')

    await expect(
      acquireSubagentRunLock({
        sessionId: 's1',
        slug: 'helper',
        subagentLabel: 'Helper',
        ttlMs: 5_000,
        waitBudgetMs: -1,
      })
    ).rejects.toThrow('resolved non-negative wait budget')
  })

  it('reports how long a call queued, so the extra wall clock is explainable', async () => {
    const straightThrough = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 200,
      waitBudgetMs: 2_200,
    })
    // Nothing held the turn, so there is nothing to explain.
    expect(straightThrough.waitedMs).toBeLessThan(50)

    // The holder's own TTL is what frees the turn here, so the waiter genuinely queues.
    const queued = await acquireSubagentRunLock({
      sessionId: 's1',
      slug: 'helper',
      subagentLabel: 'Helper',
      ttlMs: 200,
      waitBudgetMs: 2_200,
    })
    expect(queued.token).not.toBe(straightThrough.token)
    expect(queued.waitedMs).toBeGreaterThanOrEqual(150)
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

describe('n8n thread ids (DL-111-06)', () => {
  it('mints a new id for fresh and stores it with the template TTL', async () => {
    const first = await selectN8nSubagentThreadId({
      sessionId: 's1',
      slug: 'flow',
      mode: 'fresh',
    })

    expect(first.outcome).toBe('fresh')
    expect(first.threadId).toMatch(/^[0-9a-f-]{36}$/)
    expect(subagentRedis.snapshot()[buildSubagentN8nThreadIdKey('s1', 'flow')]).toBe(
      first.threadId
    )

    // "Fresh resets" through the only lever Batshit has over n8n-owned memory: a new key.
    const second = await selectN8nSubagentThreadId({
      sessionId: 's1',
      slug: 'flow',
      mode: 'fresh',
    })
    expect(second.threadId).not.toBe(first.threadId)
  })

  it('reuses the stored id on resume', async () => {
    const first = await selectN8nSubagentThreadId({
      sessionId: 's1',
      slug: 'flow',
      mode: 'fresh',
    })
    const resumed = await selectN8nSubagentThreadId({
      sessionId: 's1',
      slug: 'flow',
      mode: 'resume',
    })

    expect(resumed.outcome).toBe('resumed')
    expect(resumed.threadId).toBe(first.threadId)
  })

  it('says resumed-empty honestly when there was nothing to resume', async () => {
    const resumed = await selectN8nSubagentThreadId({
      sessionId: 's1',
      slug: 'flow',
      mode: 'resume',
    })

    expect(resumed.outcome).toBe('resumed-empty')
    expect(resumed.threadId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('ages on the same 7-day clock as the official template sessionTTL', () => {
    expect(N8N_SUBAGENT_THREAD_TTL_SECONDS).toBe(604800)
  })
})

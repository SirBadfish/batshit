import { beforeEach, describe, expect, it } from 'vitest'

/**
 * SA-111 P4 (DL-111-09) — the three Worker caps.
 *
 * These are the only thing standing between a primary agent and an unbounded fan-out, and
 * they must refuse rather than throw, so the model can adapt instead of seeing a tool
 * error. Both lanes share this module, so proving it here proves it for both.
 */

import {
  WORKERS_MAX_CONCURRENT,
  WORKERS_MAX_PER_CALL,
  WORKERS_MAX_RUNS_PER_TURN,
} from '$lib/utils/delegationCapabilities'
import {
  __resetWorkerTurnBudgetForTests,
  reserveWorkerRuns,
  type WorkerTurnKey,
} from '../workerTurnBudget'

const TURN: WorkerTurnKey = {
  sessionId: 'session-1',
  agentId: 'primary-agent',
  parentMessageId: 'msg-1',
}

beforeEach(() => {
  __resetWorkerTurnBudgetForTests()
})

describe('worker turn budget (DL-111-09)', () => {
  it('allows a batch at the per-call limit and refuses one over it', () => {
    const ok = reserveWorkerRuns(TURN, WORKERS_MAX_PER_CALL)
    expect(ok.ok).toBe(true)

    const over = reserveWorkerRuns(TURN, WORKERS_MAX_PER_CALL + 1)
    expect(over).toMatchObject({ ok: false, code: 'worker_batch_too_large' })
    // The refusal names the real number so the model can retry correctly.
    expect((over as any).message).toContain(String(WORKERS_MAX_PER_CALL))
  })

  it('refuses a batch that would exceed the concurrency cap while others run', () => {
    const first = reserveWorkerRuns(TURN, WORKERS_MAX_CONCURRENT)
    expect(first.ok).toBe(true)

    const second = reserveWorkerRuns(TURN, 1)
    expect(second).toMatchObject({ ok: false, code: 'worker_concurrency_limit' })

    // Releasing the in-flight batch frees the slots again.
    ;(first as any).release()
    expect(reserveWorkerRuns(TURN, 1).ok).toBe(true)
  })

  it('counts every run against the turn total, released or not', () => {
    let used = 0
    while (used + WORKERS_MAX_PER_CALL <= WORKERS_MAX_RUNS_PER_TURN) {
      const reservation = reserveWorkerRuns(TURN, WORKERS_MAX_PER_CALL)
      expect(reservation.ok).toBe(true)
      ;(reservation as any).release()
      used += WORKERS_MAX_PER_CALL
    }

    expect(used).toBe(WORKERS_MAX_RUNS_PER_TURN)
    const over = reserveWorkerRuns(TURN, 1)
    expect(over).toMatchObject({ ok: false, code: 'worker_turn_limit' })
  })

  it('gives each parent turn its own budget', () => {
    const first = reserveWorkerRuns(TURN, WORKERS_MAX_PER_CALL)
    ;(first as any).release()

    // A different message id is a different turn — the user's next question must not
    // inherit a spent budget, which is exactly why the cap keys on the message.
    const nextTurn = reserveWorkerRuns({ ...TURN, parentMessageId: 'msg-2' }, WORKERS_MAX_PER_CALL)
    expect(nextTurn.ok).toBe(true)

    // ...and so is a different agent in the same session (group chat).
    const otherAgent = reserveWorkerRuns({ ...TURN, agentId: 'other-agent' }, WORKERS_MAX_PER_CALL)
    expect(otherAgent.ok).toBe(true)
  })

  it('releases idempotently so a double release cannot inflate the budget', () => {
    const reservation = reserveWorkerRuns(TURN, WORKERS_MAX_CONCURRENT)
    expect(reservation.ok).toBe(true)
    ;(reservation as any).release()
    ;(reservation as any).release()

    // Only WORKERS_MAX_CONCURRENT slots exist; a double release must not create more.
    const next = reserveWorkerRuns(TURN, WORKERS_MAX_CONCURRENT)
    expect(next.ok).toBe(true)
    expect(reserveWorkerRuns(TURN, 1)).toMatchObject({ ok: false, code: 'worker_concurrency_limit' })
  })

  it('refuses a non-positive batch instead of silently reserving nothing', () => {
    expect(reserveWorkerRuns(TURN, 0)).toMatchObject({ ok: false, code: 'worker_batch_too_large' })
    expect(reserveWorkerRuns(TURN, -1)).toMatchObject({ ok: false, code: 'worker_batch_too_large' })
  })
})

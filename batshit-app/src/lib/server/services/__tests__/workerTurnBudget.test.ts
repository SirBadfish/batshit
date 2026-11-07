import { beforeEach, describe, expect, it } from 'vitest'

/**
 * SA-111 P4 (DL-111-09), delegation limits (Josh, 2026-10-24, decision 6) — the Worker caps:
 * six per call and six at a time, Codex's default, with no per-turn total.
 *
 * These are the only thing standing between a primary agent and an unbounded fan-out, and
 * they must refuse rather than throw, so the model can adapt instead of seeing a tool
 * error. SA-139 R5 removed the CLI Worker and its profile-slot pool, so Workers run on one lane;
 * `WORKER_PROFILE_SLOTS` stays as the number of leftover slot folders an agent's delete removes.
 */

import {
  WORKER_PROFILE_SLOTS,
  WORKERS_MAX_CONCURRENT,
  WORKERS_MAX_PER_CALL,
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

  it('pins the caps Josh chose: six per call, six at a time', () => {
    expect(WORKERS_MAX_PER_CALL).toBe(6)
    expect(WORKERS_MAX_CONCURRENT).toBe(6)
    expect(WORKER_PROFILE_SLOTS).toBe(WORKERS_MAX_CONCURRENT)
  })

  it('runs six at once and refuses a seventh with a readable result', () => {
    const six = reserveWorkerRuns(TURN, 6)
    expect(six.ok).toBe(true)
    const seventh = reserveWorkerRuns(TURN, 1)
    expect(seventh).toMatchObject({ ok: false, code: 'worker_concurrency_limit' })
    expect((seventh as any).message).toContain('6 worker(s) are already running')
    expect((seventh as any).message).toContain('6 at a time')
  })

  it('has no per-turn total: a turn may start batch after batch as each returns', () => {
    // DL-111-09's nine-per-turn cap is gone (decision 6). Twenty full batches in one turn.
    for (let batch = 0; batch < 20; batch += 1) {
      const reservation = reserveWorkerRuns(TURN, WORKERS_MAX_PER_CALL)
      expect(reservation.ok, `batch ${batch + 1}`).toBe(true)
      ;(reservation as any).release()
    }
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

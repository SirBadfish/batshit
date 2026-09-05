/**
 * SA-111 P4 (DL-111-09) — the three Worker caps, enforced in ONE place for both lanes.
 *
 *   3 per call · 3 concurrent per parent turn · 9 worker runs per parent turn
 *
 * Why in-process rather than Redis: both lanes land in this same SvelteKit process. The
 * API lane calls `native_spawn_workers` inside the brain; the managed CLI lane's MCP
 * bridge is a child process that POSTs back to `/api/subagents/managed-execute` here. So
 * one module-level map covers both, with no new Redis key to enumerate in `deleteSession`
 * and no backup-inventory decision. It resets on restart, which is the same posture the
 * in-process API rate limiter already takes for a single-instance self-hosted app.
 *
 * The turn key is `(sessionId, agentId, parentMessageId)`. The parent message id is what
 * makes "per turn" real: without it, a per-`(session, agent)` window would either leak a
 * spent budget into the user's NEXT message or need a timer that guesses when a turn
 * ended. Both lanes supply it — the API lane from `request.messageId`, the CLI lane from
 * `BATSHIT_MESSAGE_ID` exported into the bridge's environment — and a call that arrives
 * without one is REFUSED rather than silently given an unbounded budget.
 */

import {
  WORKERS_MAX_CONCURRENT,
  WORKERS_MAX_PER_CALL,
  WORKERS_MAX_RUNS_PER_TURN,
} from '$lib/utils/delegationCapabilities'

/**
 * How long a turn's counters survive with no activity. Generous on purpose: a parent turn
 * can legitimately run long, and the entry is only a few numbers. Eviction exists to stop
 * unbounded growth across a long-lived process, not to expire a live turn.
 */
const TURN_ENTRY_TTL_MS = 60 * 60 * 1000

type TurnCounters = {
  /** Worker runs started in this turn, completed or not. */
  used: number
  /** Worker runs currently in flight. */
  active: number
  touchedAt: number
}

const turnCounters = new Map<string, TurnCounters>()

export type WorkerTurnKey = {
  sessionId: string
  agentId: string
  parentMessageId: string
}

export type WorkerBudgetRefusal = {
  ok: false
  /** Stable machine code the tool result carries so the model can tell the caps apart. */
  code: 'worker_batch_too_large' | 'worker_concurrency_limit' | 'worker_turn_limit'
  message: string
}

export type WorkerBudgetReservation = {
  ok: true
  release: () => void
}

export type WorkerBudgetResult = WorkerBudgetReservation | WorkerBudgetRefusal

function buildKey(key: WorkerTurnKey): string {
  return `${key.sessionId}::${key.agentId}::${key.parentMessageId}`
}

function evictExpired(now: number) {
  for (const [key, counters] of turnCounters) {
    if (now - counters.touchedAt > TURN_ENTRY_TTL_MS) turnCounters.delete(key)
  }
}

/**
 * Reserve `count` worker runs against this parent turn. Returns a refusal (never a throw)
 * so the batch tool can hand the model a readable result it can adapt to — call fewer
 * workers, wait for the running ones, or do the work itself.
 */
export function reserveWorkerRuns(key: WorkerTurnKey, count: number): WorkerBudgetResult {
  if (!Number.isInteger(count) || count < 1) {
    return {
      ok: false,
      code: 'worker_batch_too_large',
      message: 'A worker batch needs at least one worker.',
    }
  }

  if (count > WORKERS_MAX_PER_CALL) {
    return {
      ok: false,
      code: 'worker_batch_too_large',
      message: `You asked for ${count} workers in one call; Batshit runs at most ${WORKERS_MAX_PER_CALL} per call. Send ${WORKERS_MAX_PER_CALL} or fewer.`,
    }
  }

  const now = Date.now()
  evictExpired(now)

  const mapKey = buildKey(key)
  const counters = turnCounters.get(mapKey) ?? { used: 0, active: 0, touchedAt: now }

  if (counters.used + count > WORKERS_MAX_RUNS_PER_TURN) {
    return {
      ok: false,
      code: 'worker_turn_limit',
      message: `This response has already started ${counters.used} of its ${WORKERS_MAX_RUNS_PER_TURN} allowed worker runs, so ${count} more would go over. Use the results you have, or do the rest yourself.`,
    }
  }

  if (counters.active + count > WORKERS_MAX_CONCURRENT) {
    return {
      ok: false,
      code: 'worker_concurrency_limit',
      message: `${counters.active} worker(s) are already running and Batshit allows ${WORKERS_MAX_CONCURRENT} at a time, so ${count} more cannot start. Wait for the running batch to return first.`,
    }
  }

  counters.used += count
  counters.active += count
  counters.touchedAt = now
  turnCounters.set(mapKey, counters)

  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      const current = turnCounters.get(mapKey)
      if (!current) return
      current.active = Math.max(0, current.active - count)
      current.touchedAt = Date.now()
    },
  }
}

/** Test-only reset so one suite's counters cannot leak into the next. */
export function __resetWorkerTurnBudgetForTests() {
  turnCounters.clear()
}

/**
 * SA-113 P1 (DL-113-05, DL-113-12) — the in-process record of woken turns.
 *
 * A "woken turn" is a chat turn Batshit started with nobody typing: a DM whose sender
 * asked for `wake`, or a wake-up webhook. This module is the single source of truth for
 *
 *   - which sessions currently hold a server-started turn (so `/api/sse` knows to buffer
 *     its events even when no tab is watching — AMD-113-01),
 *   - the `AbortController` for each woken turn's internal `send-routed` request, which
 *     Stop and the hard timeout abort FIRST (AMD-113-02),
 *   - the running caps (one per agent, three per instance),
 *   - the rolling-hour wake budgets.
 *
 * Why in-process rather than Redis, matching `workerTurnBudget.ts`: every wake-up is
 * started and consumed inside this one SvelteKit process, so a module-level map needs no
 * new Redis key in `deleteSession`, no backup-inventory decision, and no cross-process
 * coordination Batshit does not have. It resets on restart, which is the same posture the
 * in-process API rate limiter and the session-turn lock already take for a single-instance
 * self-hosted app — and a restart also kills every in-flight turn the counters describe,
 * so the reset is honest rather than a leak.
 *
 * This module deliberately imports nothing but the shared caps. `/api/sse` and
 * `agentWakeups.ts` both depend on it, so keeping it leaf-level is what stops the two
 * from importing each other.
 */

import {
  MAX_RUNNING_WOKEN_TURNS,
  MAX_RUNNING_WOKEN_TURNS_PER_AGENT,
  MAX_WAKES_PER_AGENT_PER_HOUR,
  MAX_WAKES_PER_INSTANCE_PER_HOUR
} from '$lib/utils/dmControl'
import type { SessionOrigin } from '$lib/utils/sessionOrigin'

const HOUR_MS = 60 * 60 * 1000

/**
 * Why a woken turn ended. Stamped onto the DM's `delivery` by `stampWakeDeliveryOutcome`.
 *
 * `agent_busy` is not a failure (F-P1-4): the user can start a turn in the window between
 * the primitive's busy check and its POST, and send-routed then answers 409
 * `session_turn_in_progress`. Nothing broke — the wake simply becomes a `wait`, the
 * message is already in the chat, and the DM shows on that chat's next turn.
 */
export type WakeRunEndReason =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'timed_out'
  | 'agent_busy'

export interface WakeRunEntry {
  sessionId: string
  agentId: string
  userId: string
  origin: SessionOrigin
  startedAt: number
  /** Aborts the internal `send-routed` request. Stop and the timeout both use it. */
  controller: AbortController
  /** The hard-stop timer, cleared on every terminal path. */
  timer: ReturnType<typeof setTimeout>
  /** Set once a terminal path has run, so a late finish cannot re-report. */
  endReason?: WakeRunEndReason
}

const runsBySession = new Map<string, WakeRunEntry>()

/** Rolling-hour wake START timestamps, for the two rate caps. */
const wakeStartsByAgent = new Map<string, number[]>()
let instanceWakeStarts: number[] = []

/**
 * F-P1-3 — synchronous holds on a running slot.
 *
 * `requestAgentWakeup` checks the caps and then does several awaited Redis calls (read the
 * session list, create the session, save the message) before it can register the run. Two
 * wakes for one agent arriving in the same tick would both pass the one-per-agent cap and
 * both start. A reservation is taken in the SAME synchronous step as the check, so the
 * second caller sees the slot as taken, and it is released on every refusal path.
 *
 * Reservations count toward the running caps AND the rolling-hour budgets, because a
 * reservation is a wake that is about to start; `registerWakeRun` converts one into a real
 * run and stamps the rate timestamp then.
 */
interface WakeReservation {
  agentId: string
  at: number
}

const reservations = new Map<string, WakeReservation>()
let reservationCounter = 0

/**
 * A reservation that is never released would hold its slot forever. Every real path
 * releases explicitly; this bound only exists so an unforeseen throw between reserve and
 * register cannot wedge an agent's wake slot until the next restart.
 */
const RESERVATION_MAX_AGE_MS = 60_000

function pruneReservations(now: number) {
  for (const [id, reservation] of reservations) {
    if (now - reservation.at > RESERVATION_MAX_AGE_MS) {
      console.warn('[Wake-up] Releasing a stale wake reservation:', {
        reservationId: id,
        agentId: reservation.agentId,
        ageMs: now - reservation.at
      })
      reservations.delete(id)
    }
  }
}

function prune(list: number[], now: number): number[] {
  const cutoff = now - HOUR_MS
  return list.filter((at) => at > cutoff)
}

function pruneAllRates(now: number) {
  instanceWakeStarts = prune(instanceWakeStarts, now)
  for (const [agentId, list] of wakeStartsByAgent) {
    const kept = prune(list, now)
    if (kept.length === 0) wakeStartsByAgent.delete(agentId)
    else wakeStartsByAgent.set(agentId, kept)
  }
}

export type WakeCapRefusal = {
  code:
    | 'wake_rate_limit_agent'
    | 'wake_rate_limit_instance'
    | 'wake_running_limit_agent'
    | 'wake_running_limit_instance'
  reason: string
}

/**
 * The four cap checks, read-only. Reservations count as running wakes (F-P1-3), so a
 * second caller in the same tick sees the slot the first one is holding.
 */
export function checkWakeCaps(agentId: string, now = Date.now()): WakeCapRefusal | null {
  pruneAllRates(now)
  pruneReservations(now)

  let runningForAgent = 0
  for (const entry of runsBySession.values()) {
    if (entry.agentId === agentId) runningForAgent += 1
  }
  let reservedForAgent = 0
  for (const reservation of reservations.values()) {
    if (reservation.agentId === agentId) reservedForAgent += 1
  }

  if (runningForAgent + reservedForAgent >= MAX_RUNNING_WOKEN_TURNS_PER_AGENT) {
    return {
      code: 'wake_running_limit_agent',
      reason: `That agent already has a woken turn running (Batshit runs ${MAX_RUNNING_WOKEN_TURNS_PER_AGENT} at a time per agent).`
    }
  }

  const running = runsBySession.size + reservations.size
  if (running >= MAX_RUNNING_WOKEN_TURNS) {
    return {
      code: 'wake_running_limit_instance',
      reason: `${running} woken turns are already running and Batshit allows ${MAX_RUNNING_WOKEN_TURNS} at a time.`
    }
  }

  const agentStarts = (wakeStartsByAgent.get(agentId) ?? []).length + reservedForAgent
  if (agentStarts >= MAX_WAKES_PER_AGENT_PER_HOUR) {
    return {
      code: 'wake_rate_limit_agent',
      reason: `That agent has been woken ${agentStarts} times in the last hour (limit ${MAX_WAKES_PER_AGENT_PER_HOUR}).`
    }
  }

  const instanceStarts = instanceWakeStarts.length + reservations.size
  if (instanceStarts >= MAX_WAKES_PER_INSTANCE_PER_HOUR) {
    return {
      code: 'wake_rate_limit_instance',
      reason: `Batshit has started ${instanceStarts} wake-ups in the last hour (limit ${MAX_WAKES_PER_INSTANCE_PER_HOUR}).`
    }
  }

  return null
}

export type WakeSlotReservation =
  | { ok: true; reservationId: string }
  | ({ ok: false } & WakeCapRefusal)

/**
 * F-P1-3 — check the caps and take the slot in ONE synchronous step.
 *
 * The caller must release on every refusal path that follows (`releaseWakeSlot`) and hand
 * the id to `registerWakeRun` on the accept path, which converts it into a real run.
 */
export function reserveWakeSlot(agentId: string, now = Date.now()): WakeSlotReservation {
  const refusal = checkWakeCaps(agentId, now)
  if (refusal) return { ok: false, ...refusal }

  reservationCounter += 1
  const reservationId = `wakeres_${now}_${reservationCounter}`
  reservations.set(reservationId, { agentId, at: now })
  return { ok: true, reservationId }
}

/** Give a reserved slot back. Idempotent, so a refusal path can call it unconditionally. */
export function releaseWakeSlot(reservationId: string | null | undefined): void {
  if (!reservationId) return
  reservations.delete(reservationId)
}

/**
 * Record a woken turn as running. Called once the primitive has passed every check and
 * is about to POST to send-routed, so the rate counters measure wakes actually started.
 * Consumes the reservation taken at cap-check time, so the slot never double-counts.
 */
export function registerWakeRun(
  entry: Omit<WakeRunEntry, 'endReason'>,
  reservationId?: string | null
): void {
  const now = Date.now()
  releaseWakeSlot(reservationId)
  runsBySession.set(entry.sessionId, { ...entry })
  wakeStartsByAgent.set(entry.agentId, [
    ...prune(wakeStartsByAgent.get(entry.agentId) ?? [], now),
    now
  ])
  instanceWakeStarts = [...prune(instanceWakeStarts, now), now]
}

/**
 * AMD-113-01: `/api/sse` POST asks this before it drops an event for a session with no
 * listener. A session with a woken turn in flight keeps filling the replay buffer, so a
 * tab opened mid-turn sees the whole stream instead of joining mid-sentence.
 */
export function hasActiveWakeRun(sessionId: string): boolean {
  return runsBySession.has(sessionId)
}

export function getWakeRun(sessionId: string): WakeRunEntry | null {
  return runsBySession.get(sessionId) ?? null
}

/**
 * AMD-113-02 — the in-process Stop signal for a woken turn.
 *
 * `send-routed` wires this alongside the group-chat `externalAbortSignal` so a Stop
 * reaches a woken turn no matter where it is in its run. Aborting the primitive's own
 * HTTP request is NOT enough on its own: the P1 live run measured that a client-side
 * fetch abort does not reach `request.signal` inside send-routed, so the turn carried on
 * and produced a full answer after Stop was pressed. Both paths abort the SAME
 * `AbortController`, so this direct wiring makes delivery certain rather than adding a
 * second mechanism to keep in step.
 */
export function getWakeAbortSignal(sessionId: string): AbortSignal | null {
  return runsBySession.get(sessionId)?.controller.signal ?? null
}

export function listWakeRuns(): WakeRunEntry[] {
  return [...runsBySession.values()]
}

/** Presence (DL-113-16, P2) and the drawer both ask "is this agent mid-woken-turn?". */
export function findWakeRunForAgent(agentId: string): WakeRunEntry | null {
  for (const entry of runsBySession.values()) {
    if (entry.agentId === agentId) return entry
  }
  return null
}

/**
 * Clear a woken turn and report how it ended. Idempotent: completion, failure, Stop, and
 * the timeout can all race, and only the first one wins, so `delivery.actual` is stamped
 * once. Returns the entry when this call was the one that ended it, else null.
 */
export function clearWakeRun(
  sessionId: string,
  reason: WakeRunEndReason
): WakeRunEntry | null {
  const entry = runsBySession.get(sessionId)
  if (!entry) return null
  runsBySession.delete(sessionId)
  clearTimeout(entry.timer)
  return { ...entry, endReason: reason }
}

/**
 * AMD-113-02: Stop, or the hard timeout, for a woken turn.
 *
 * Aborting this controller does two things at once, and both matter. It aborts the
 * primitive's own HTTP request, so the client half stops waiting; and, because
 * `send-routed` wires `getWakeAbortSignal` into its stream controller, it reaches the run
 * itself — including during the 3-9 second setup window, where there is no stream
 * controller for the interrupt route to find.
 *
 * The caller still calls the interrupt route afterwards so an already-streaming turn goes
 * through the same path a browser Stop uses.
 */
export function abortWakeRun(sessionId: string, reason: WakeRunEndReason): boolean {
  const entry = runsBySession.get(sessionId)
  if (!entry) return false
  try {
    entry.controller.abort(reason === 'timed_out' ? 'wake_timeout' : 'wake_stop')
  } catch {
    // Already aborted — nothing to do.
  }
  return true
}

/** Test-only reset so one suite's counters and timers cannot leak into the next. */
export function __resetWakeRunRegistryForTests(): void {
  for (const entry of runsBySession.values()) clearTimeout(entry.timer)
  runsBySession.clear()
  wakeStartsByAgent.clear()
  instanceWakeStarts = []
  reservations.clear()
}

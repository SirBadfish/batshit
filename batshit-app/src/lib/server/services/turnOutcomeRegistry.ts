/**
 * The final answer of a send that was answered early (2026-09-18).
 *
 * A browser send asks send-routed to answer once the server owns its turn
 * (`Prefer: respond-async`, `respondAsyncSend.ts`), so its request no longer holds one of the
 * browser's six HTTP/1.1 connections for the whole reply. The answer the route used to give at
 * the END of the turn (its status, content type, and body, byte for byte) is kept here under a
 * fresh id, and the tab that sent reads it over the live hub (`{scope: 'turn', turnId}` in
 * `/api/sse`). A watcher that comes after the turn ended gets the answer at once: a hub that
 * reconnected mid-reply re-adds every subscription, and a tab can be slow to subscribe, so a
 * late watcher is normal, not an error.
 *
 * In-process, like `wakeRunRegistry.ts`: the turn it describes runs in this process and dies
 * with it, so after a restart the id is unknown and the tab is told its send failed. No Redis
 * key, no `deleteSession` sweep, no backup row: an entry holds only the route's answer (the
 * reply's message id and usage, or an error sentence), never chat content, and ends on its own.
 *
 * Shutdown waits for running turns (`waitForRunningTurns`). The server used to drain a running
 * reply as an in-flight request (adapter-node waits up to `SHUTDOWN_TIMEOUT`, 30 s, before it
 * closes, and only then does Batshit disconnect Redis), so the reply could save its end and the
 * tab heard it; a turn answered early is no request, so `/api/sse` waits for it instead, before
 * it closes the live hubs, and Redis stays up until that wait is over.
 */

import { randomUUID } from 'node:crypto'

/** What send-routed answered at the end of the turn, exactly. */
export type TurnOutcome = { status: number; contentType: string | null; body: string }

/** How long an ended turn's answer is kept for a tab that has not read it yet. */
export const TURN_OUTCOME_RETENTION_MS = 6 * 60 * 60 * 1000
/** At most this many ENDED answers are kept; past it the oldest go first. */
export const TURN_OUTCOME_MAX_SETTLED = 2000
/** How long shutdown waits for running turns: adapter-node's default `SHUTDOWN_TIMEOUT`. */
export const TURN_SHUTDOWN_WAIT_MS = 30_000

type Watcher = (outcome: TurnOutcome) => void

type Entry = {
  userId: string
  settledAt: number | null
  outcome: TurnOutcome | null
  watchers: Set<Watcher>
}

const entries = new Map<string, Entry>()
/** Called whenever the last running turn ends (`waitForRunningTurns`). */
const idleWaiters = new Set<() => void>()

function runningCount(): number {
  let running = 0
  for (const entry of entries.values()) if (entry.settledAt === null) running += 1
  return running
}

function prune(now: number) {
  let settled = 0
  for (const [turnId, entry] of entries) {
    if (entry.settledAt === null) continue
    if (now - entry.settledAt > TURN_OUTCOME_RETENTION_MS) {
      entries.delete(turnId)
      continue
    }
    settled += 1
  }
  if (settled <= TURN_OUTCOME_MAX_SETTLED) return
  const oldestFirst = [...entries.entries()]
    .filter(([, entry]) => entry.settledAt !== null)
    .sort(([, a], [, b]) => (a.settledAt as number) - (b.settledAt as number))
  for (const [turnId] of oldestFirst.slice(0, settled - TURN_OUTCOME_MAX_SETTLED)) entries.delete(turnId)
}

/**
 * A turn was accepted: give it an id nobody could guess or see again. Not the session-turn
 * lock's number, which starts over when the process restarts: a tab re-adding its turn after a
 * restart would then be handed another turn's answer.
 */
export function openTurnOutcome(owner: { userId: string }): string {
  prune(Date.now())
  const turnId = `turn_${randomUUID().replace(/-/g, '')}`
  entries.set(turnId, {
    userId: owner.userId,
    settledAt: null,
    outcome: null,
    watchers: new Set()
  })
  return turnId
}

/** The turn ended with this answer: hand it to every watcher, once. `false` if unknown or already ended. */
export function settleTurnOutcome(turnId: string, outcome: TurnOutcome): boolean {
  const entry = entries.get(turnId)
  if (!entry || entry.settledAt !== null) return false
  entry.settledAt = Date.now()
  entry.outcome = outcome
  const watchers = [...entry.watchers]
  entry.watchers.clear()
  for (const watcher of watchers) {
    try {
      watcher(outcome)
    } catch (error) {
      console.warn('[TurnOutcome] A watcher could not take a turn’s answer:', error)
    }
  }
  prune(entry.settledAt)
  if (idleWaiters.size > 0 && runningCount() === 0) {
    for (const waiter of [...idleWaiters]) waiter()
  }
  return true
}

/**
 * Resolve once no turn is running (`true`), or when `timeoutMs` has passed with some still
 * running (`false`). Shutdown's wait, so a turn answered early can still save its end and be
 * heard before the live hubs close and Redis disconnects.
 */
export function waitForRunningTurns(timeoutMs: number): Promise<boolean> {
  if (runningCount() === 0) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const done = (idle: boolean) => {
      clearTimeout(timer)
      idleWaiters.delete(onIdle)
      resolve(idle)
    }
    const onIdle = () => done(true)
    const timer = setTimeout(() => done(false), timeoutMs)
    idleWaiters.add(onIdle)
  })
}

/** Is this this user's turn, still known? */
export function hasTurnOutcome(turnId: string, userId: string): boolean {
  return entries.get(turnId)?.userId === userId
}

/**
 * Hear this turn's answer: at once if it has ended, else when it does. Returns the way to stop
 * listening, or `null` for a turn this process does not know or that is another user's (the
 * caller says "not found" either way).
 */
export function watchTurnOutcome(turnId: string, userId: string, watcher: Watcher): (() => void) | null {
  const entry = entries.get(turnId)
  if (!entry || entry.userId !== userId) return null
  if (entry.outcome) {
    watcher(entry.outcome)
    return () => {}
  }
  entry.watchers.add(watcher)
  return () => {
    entry.watchers.delete(watcher)
  }
}

/** How many turns are running and ended, and how many listeners wait on them (tests, diagnostics). */
export function inspectTurnOutcomes() {
  let running = 0
  let settled = 0
  let watchers = 0
  for (const entry of entries.values()) {
    if (entry.settledAt === null) running += 1
    else settled += 1
    watchers += entry.watchers.size
  }
  return { running, settled, watchers }
}

/** Test-only reset, like `__resetWakeRunRegistryForTests`. */
export function __resetTurnOutcomesForTests(): void {
  entries.clear()
  idleWaiters.clear()
}

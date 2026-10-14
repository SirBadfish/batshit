/**
 * BL-549 and BL-622: a background job in a chat (a nap, a Compact) yields to a turn.
 *
 * The user's message always goes first. A nap or a Compact takes no lock and never holds the
 * chat; it asks this module before it starts and before it writes, and ends early when a turn
 * meets it (`Plans/2026-09-27-bl549-a-nap-yields-to-a-turn.md`,
 * `Plans/2026-09-27-bl622-a-compact-yields-to-a-turn.md`). One module serves both, so the two
 * jobs cannot come to read "a turn runs" differently.
 *
 * A pure read of the in-process turn registry (`streamAbortRegistry.ts`); Batshit is one app
 * process per instance, so every send-routed turn registers there.
 */

import { hasRunningRequest } from './streamAbortRegistry'

/**
 * Does a turn run in this chat now: is a request of the chat registered and not yet released by
 * itself? That covers every held lock (a registration is running from `registerSessionTurn` to
 * its own `releaseSessionTurn`), and also a request that still writes after its lock went (a lock
 * is not a request: the grace after a Stop or an aborted stream ends the lock early).
 */
export function isTurnRunning(sessionId: string): boolean {
  return hasRunningRequest(sessionId)
}

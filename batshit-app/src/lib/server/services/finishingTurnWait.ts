/**
 * A new turn waits for the previous one to FINISH instead of being refused (2026-09-18).
 *
 * send-routed holds the chat's session-turn lock from the top of a request to the end of its
 * `finally`, and `end` reaches the browser before that request's after-reply work — the
 * Execution Viewer snapshot, the Jev Juice after-reply steps, the run-end sandbox sweep. A
 * message the browser QUEUES (one carrying a Clip or an `@file` mention, which cannot be
 * steered) is sent the moment `end` arrives, so it lands inside that work. Measured on the
 * smoke stack (`_local/queued-send-proof/`): it reached send-routed 0.8 to 1.6 s before the
 * reply's request had finished and was refused `session_turn_in_progress` in 9 runs out of 9,
 * on the Codex lane and the API lane alike. The user's words were stored and never answered,
 * beside an error bubble and a "Response already in progress" toast.
 *
 * So a new turn waits while the chat's turn is only finishing (`isSessionTurnFinishing`):
 * the same shape as an approval click waiting for the reply that raised its card, and the
 * steer route waiting through a reply's setup. It stops the moment the lock is released, and
 * also when the finishing request starts another run under its lock (a context-exhaustion
 * continuation or a promoted steer), which is a whole new reply: the caller's lock check then
 * refuses as it did before. The caller's check and registration run AFTER the wait, as one
 * synchronous block, so two turns that both waited cannot both start.
 *
 * An Approve or Deny click never uses this wait. A click waits only for the reply that raised
 * its card (`approvalClickWait.ts`), and never behind a lock that is itself answering an
 * approval; this wait has no such rule, so a second click on the same card would wait out the
 * first click's after-reply work and then run the approved command a second time.
 */

import { isSessionTurnFinishing } from '$lib/server/services/streamAbortRegistry'

export const FINISHING_TURN_WAIT_MS = 15_000
export const FINISHING_TURN_POLL_MS = 100

/**
 * Wait while the chat's turn is finishing.
 *
 * `no_wait`: nothing was finishing. `released`: it let go, or started running again.
 * `timed_out`: the bound passed with it still finishing. The wait never takes or clears a lock.
 */
export async function waitForFinishingTurn(
  sessionId: string
): Promise<'no_wait' | 'released' | 'timed_out'> {
  if (!isSessionTurnFinishing(sessionId)) return 'no_wait'
  const deadline = Date.now() + FINISHING_TURN_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, FINISHING_TURN_POLL_MS))
    if (!isSessionTurnFinishing(sessionId)) return 'released'
  }
  return 'timed_out'
}

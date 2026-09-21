/**
 * How long a message the BROWSER queued waits for the reply it queued behind (2026-09-18).
 *
 * A message carrying a Clip or an `@file` mention cannot be steered, so Queue holds it in the
 * page and sends it as an ordinary message once the reply is over (SA-119 DL-119-06). "Over"
 * means the chat is no longer busy, and the chat stays busy after the reply's message has
 * ended: the tab that sent the reply keeps its send open until the server says the turn is
 * over, after its after-reply work, about a second on the smoke stack. Since 2026-09-18 that is
 * the server's `turn_over` over the live hub (`postSendRouted`), not an open request that held
 * one of the browser's six connections for the whole reply. The page's old loop stopped as
 * soon as there was no message left to wait on, so in exactly that second it gave up, and the
 * queued message was parked as "Not sent — the reply ran too long to wait for" after a
 * 20-second reply (measured, `_local/queued-send-proof/`). This waits on the message while one
 * is streaming, polls while the chat is busy with none, and gives up only at the ceiling.
 */

export const REPLY_END_POLL_MS = 150

export type ReplyEndWaitDeps = {
  /** Is the chat still busy: a message streaming, a tool running, or this tab's send not yet told the turn is over? */
  isBusy: () => boolean
  /** The message the run is streaming now, if any (a continuation moves it on). */
  nextTarget: () => string | null
  /** Resolves when that message ends, or at its own short ceiling. */
  waitForMessageEnd: (messageId: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * A group reply has no message id until its first `start` event (bug sweep, 2026-09-18).
 *
 * The page gives a group send no assistant id (the speakers make their own), so a message the
 * browser queued in the moment between Enter and that event had nothing to wait on: it skipped
 * the wait, went straight into the running turn, and send-routed refused it
 * (`session_turn_in_progress`), leaving the user's message saved and unanswered. This waits for
 * the reply's first message id, or for the chat to stop being busy, whichever comes first.
 *
 * `busy: true` with no target means the reply is still starting at the ceiling.
 */
export async function waitForReplyTarget(
  deps: Pick<ReplyEndWaitDeps, 'isBusy' | 'nextTarget' | 'sleep' | 'now'>,
  maxWaitMs: number
): Promise<{ target: string | null; busy: boolean }> {
  const deadline = deps.now() + maxWaitMs
  for (;;) {
    const target = deps.nextTarget()
    if (target) return { target, busy: true }
    if (!deps.isBusy()) return { target: null, busy: false }
    if (deps.now() >= deadline) return { target: null, busy: true }
    await deps.sleep(REPLY_END_POLL_MS)
  }
}

/** `true` once the chat is no longer busy; `false` if it still is at the ceiling. */
export async function waitUntilReplyIsOver(
  firstMessageId: string,
  deps: ReplyEndWaitDeps,
  maxWaitMs: number
): Promise<boolean> {
  const deadline = deps.now() + maxWaitMs
  let target: string | null = firstMessageId
  let waitedOn: string | null = null
  while (deps.now() < deadline) {
    if (target && target !== waitedOn) {
      await deps.waitForMessageEnd(target)
      waitedOn = target
    } else {
      // Busy with no NEW message to wait on: this tab's send has not been told the turn is over
      // yet, or a message is still listed as active after its wait. Poll rather than spin.
      await deps.sleep(REPLY_END_POLL_MS)
    }
    if (!deps.isBusy()) return true
    target = deps.nextTarget()
  }
  return !deps.isBusy()
}

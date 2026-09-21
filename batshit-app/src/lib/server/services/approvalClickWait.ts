/**
 * An approval click belongs to the reply that raised its card (2026-09-18).
 *
 * send-routed holds the chat's session-turn lock from the top of a request to the end of its
 * `finally`, and a reply that pauses for an approval keeps it through its after-reply work —
 * the Execution Viewer snapshot, the Jev Juice after-reply steps, the sandbox cleanup — while
 * the card is already on screen, because the card arrives with `end`. A click in that window
 * was refused as a second turn ("Another response is already in progress for this session").
 * Measured live (`_local/approval-early-click-proof/before-fix.json`): Approve clicked the
 * moment the card appeared, refused 66 ms later, and the reply's own request finished 118 ms
 * after the card appeared. The browser then showed "Approved" with nothing sent.
 *
 * So a click waits for THAT reply, the way a steer waits for a reply still in setup
 * (`waitForStreamRegistration`): only while the lock names the card's own message, and never
 * behind a lock that is itself answering an approval. That lock is another click on the same
 * card (another tab, or a second click), and waiting it out and then running would spend the
 * approval twice. The caller's own lock check and registration run AFTER the wait, as one
 * synchronous block, so two clicks that both waited cannot both get through: the first
 * registers, the second finds a lock that answers an approval and is refused.
 *
 * The bound covers after-reply work that is running normally, including two Jev Juice
 * after-reply judgments (2 s each) and a slow Docker listing. Past it the click is refused as
 * before, and the card goes back to its buttons (`toolApprovalSubmit.ts` in the browser).
 */

import { getActiveSessionTurn } from '$lib/server/services/streamAbortRegistry'
import { hasUserTurnContent } from '$lib/server/services/approvalResumeMessage'

export const APPROVAL_CLICK_WAIT_MS = 15_000
export const APPROVAL_CLICK_POLL_MS = 100

type LockedTurn = {
  kind: string
  messageId?: string | null
  answersApproval?: boolean
}

/**
 * Is this request an Approve or Deny click: answers to approval cards and no user turn of its
 * own? The stream handler ignores an approval payload that arrives with real text, so a send
 * with words is never a click.
 */
export function isApprovalClick(input: { approvalResponseCount: number; content: unknown }): boolean {
  return input.approvalResponseCount > 0 && !hasUserTurnContent(input.content)
}

/** Does a click on the card that sits on `cardMessageId` wait for this lock to go? */
export function approvalClickWaitsForTurn(
  lockedTurn: LockedTurn | null | undefined,
  cardMessageId: string | null | undefined
): boolean {
  const card = typeof cardMessageId === 'string' ? cardMessageId.trim() : ''
  if (!card || !lockedTurn) return false
  if (lockedTurn.kind !== 'single') return false
  if (lockedTurn.answersApproval === true) return false
  return lockedTurn.messageId === card
}

/**
 * Wait while the reply that raised the card still holds the chat's turn lock.
 *
 * `no_wait`: nothing of the card's own reply was holding it. `released`: it let go (or the
 * lock is no longer one worth waiting for). `timed_out`: the bound passed with it still held.
 * The wait never takes or clears a lock.
 */
export async function waitForCardReplyToFinish(
  sessionId: string,
  cardMessageId: string | null | undefined
): Promise<'no_wait' | 'released' | 'timed_out'> {
  if (!approvalClickWaitsForTurn(getActiveSessionTurn(sessionId), cardMessageId)) return 'no_wait'
  const deadline = Date.now() + APPROVAL_CLICK_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_CLICK_POLL_MS))
    if (!approvalClickWaitsForTurn(getActiveSessionTurn(sessionId), cardMessageId)) return 'released'
  }
  return 'timed_out'
}

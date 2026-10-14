/**
 * BL-4 — a queued send that will not run keeps its words, at the end of the chat, unanswered.
 *
 * A send waiting in the chat's line (`streamAbortRegistry.ts`) is kept instead of run when the
 * user presses Stop (Stop stops everything, a waiting message included: AMD-119-04), when
 * Batshit shuts down or a backup restore drains, when it arrived over the line's cap, and (BL-713)
 * when the line held it for an approval card for 15 minutes (`approval_wait`) or the page's own
 * Deny of that expired card answered it (`approval_expired`). Its message was saved by the page
 * before it posted, and it is NEVER deleted: the line hands the kept send the chat in its turn,
 * once the request it waited behind has let go (that request writes its reply first; one stuck
 * longer than `QUEUED_HANDOVER_REQUEST_WAIT_MS` after its lock went is passed over), and this
 * moves the message to the end of the chat (so it reads after that reply, in the order the sends
 * were made), shows it again, tells every tab, and lets the chat go to the next send in line.
 *
 * It releases the registration the line handed it by that registration's own id, the rule every
 * request follows (`releaseSessionTurn`). It lives here, not in send-routed, because a send over
 * the cap is answered at once and kept later, when no request of its own is left to do it.
 */

import { redis } from '$lib/server/redis'
import { publishUserEvent } from '$lib/server/ssePublisher'
import {
  releaseSessionTurn,
  revealQueuedUserMessage,
  type SessionTurnEntry
} from '$lib/server/services/streamAbortRegistry'

export type SessionEventForwarder = (event: Record<string, unknown>) => Promise<void>

export async function keepQueuedSendAtEnd(params: {
  sessionId: string
  userId: string
  userMessageId: string
  /** The lock the line handed this kept send. Released here, always. */
  entry: Pick<SessionTurnEntry, 'turnId'>
  /** Posts a session event to `/api/sse` for every tab on the chat (send-routed's own forward). */
  forwardSessionEvent: SessionEventForwarder
  /** The send's "Queued" forward: the kept message's events go to the tabs after it. */
  after?: Promise<unknown> | null
}): Promise<void> {
  const { sessionId, userId, userMessageId, entry, forwardSessionEvent } = params
  try {
    await params.after
    const moved = await redis.moveMessageToEnd(sessionId, userMessageId)
    revealQueuedUserMessage(sessionId, userMessageId)
    if (!moved) return
    // A tab that took the message out of its list while it waited gets it back at the end; a
    // tab that kept it where it was saved (the send over the cap was refused, so no tab moved
    // it) re-reads the chat and finds it at the end.
    try {
      await forwardSessionEvent({ type: 'user_message', sessionId, message: moved })
    } catch (error) {
      console.warn('[BL-4] Could not tell the tabs about a kept message:', {
        sessionId,
        userMessageId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    await publishUserEvent(userId, {
      type: 'session_messages_changed',
      sessionId,
      reason: 'queued_send_kept'
    })
  } catch (error) {
    console.error('[BL-4] Could not move a kept message to the end of its chat:', {
      sessionId,
      userMessageId,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    revealQueuedUserMessage(sessionId, userMessageId)
    releaseSessionTurn(sessionId, entry.turnId)
  }
}

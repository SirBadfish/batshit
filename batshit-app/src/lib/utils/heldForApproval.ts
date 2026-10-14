/**
 * BL-455 — words that wait when a reply stops at an approval card.
 *
 * A reply that stops at an approval card has not ended: it waits for the user. The words the user
 * typed while it ran (a steer that found no tool boundary before the card, a queued message) wait
 * with it. The server writes them as ONE saved user message below the reply, marked
 * `metadata.waitsForApproval: { messageId }` with the id of the message the card is on, and runs no
 * turn (`holdSteersForApprovalCard` in `steerPromotion.ts`). The click's request answers that
 * message when the resumed reply ends, if no reply has followed it yet.
 *
 * These are the shared reads of that one fact. Client-safe: the server and the chat page both use
 * them, so the two cannot disagree about what "held" and "pending" mean.
 */

export type WaitsForApproval = { messageId: string }

/** The one line a held message shows while its card waits. */
export const WAITS_FOR_APPROVAL_SENTENCE = 'Waits for your answer to the approval card.'

/**
 * The line a held message shows after the user stopped the resumed reply. The kept send's receipt
 * sentence, word for word (`steerBubbleStatusLabel`); a test holds the two together.
 */
export const HELD_STOPPED_SENTENCE = 'Not sent — you stopped the reply'

/**
 * Faye, 2026-09-27: only the user's own click on the card lets the agent answer the held words. The
 * page's automatic Deny of an expired card ends the card and its tool call, as always, and nothing
 * more: the words stay, and say so.
 */
export const HELD_CARD_EXPIRED_SENTENCE = 'Not sent — the approval card expired'

/** After the reply that would have answered it failed: the backstop's own sentence. */
export const HELD_REPLY_FAILED_SENTENCE = 'Not sent — the reply ended before it could land. Send it again.'

/**
 * The reason the chat page gives an expired card's answer (`buildToolApprovalResponses`), and the
 * reason send-routed gives a late Approve it turns into a Deny. One string, so the server can tell
 * the page's own expiry answer from the user's click.
 */
export const APPROVAL_EXPIRED_REASON = 'Approval expired after 3 minutes'

/**
 * Is this card answer ONLY the page's own expiry of the card, with no click of the user in it? A tab
 * that shows a card past its three minutes answers it as a Deny by itself; that ends the card and
 * the tool call, and must not also release the words held for the card (Faye, 2026-09-27). A late
 * Approve the user did click carries the user's own reason, so it is a click (send-routed turns it
 * into a Deny).
 */
export function isExpiryOnlyAnswer(
  responses: ReadonlyArray<{ approved?: unknown; reason?: unknown }> | null | undefined
): boolean {
  if (!Array.isArray(responses) || responses.length === 0) return false
  return responses.every(
    (response) => response?.approved !== true && response?.reason === APPROVAL_EXPIRED_REASON
  )
}

/** `metadata.waitsForApproval` of a message, if it names a card's message. */
export function readWaitsForApproval(metadata: unknown): WaitsForApproval | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>).waitsForApproval
  if (!raw || typeof raw !== 'object') return null
  const messageId = (raw as Record<string, unknown>).messageId
  return typeof messageId === 'string' && messageId.trim() ? { messageId: messageId.trim() } : null
}

/** Is this a user message held for the card on `cardMessageId`? */
export function isHeldForApprovalCard(message: unknown, cardMessageId: string | null | undefined): boolean {
  const card = typeof cardMessageId === 'string' ? cardMessageId.trim() : ''
  if (!card || !message || typeof message !== 'object') return false
  const record = message as Record<string, unknown>
  if (record.role !== 'user') return false
  return readWaitsForApproval(record.metadata)?.messageId === card
}

/**
 * Does a stored `toolApprovals` summary still wait for the user?
 *
 * The stored shape is `{ mode, approvals[], source }`; a bare array is accepted because older
 * messages carry it. An entry waits while it is `pending` (or has no status yet, written before
 * `status` existed) and the page has not sent an answer for it. `approved`, `denied`, and `expired`
 * entries are answered.
 */
export function approvalSummaryIsPending(summary: unknown): boolean {
  if (!summary || typeof summary !== 'object') return false
  const approvals = Array.isArray(summary)
    ? summary
    : (summary as Record<string, unknown>).approvals
  if (!Array.isArray(approvals)) return false
  return approvals.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const record = entry as Record<string, unknown>
    if (record.submitted === true) return false
    return record.status === undefined || record.status === 'pending'
  })
}

type MessageLike = { id?: unknown; role?: unknown; metadata?: unknown }

function metadataOf(message: MessageLike | null | undefined): Record<string, unknown> {
  const metadata = message?.metadata
  return metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
}

/**
 * BL-905 — the held message that still waits for its card's answer, if any.
 *
 * Held words wait until a reply follows them: the answer after the click, a Send now's reply, or
 * any later turn, which reads them. A user message after them is not a reply: it is a send the
 * chat's line kept at the same card (the 15-minute bound, the page's expiry Deny, a restore, a
 * clean stop, Stop), which moves to the end of the chat unanswered (`queuedSendKeeper.ts`), or a
 * message whose own turn never answered. So this looks back past the user messages at the end of
 * the chat that no reply follows, and finds the held one among them (for `cardMessageId`, when
 * given). The server's answer and expiry mark and the page's receipt all ask this, so they agree.
 */
export function findHeldMessageAwaitingAnswer<T extends MessageLike>(
  messages: readonly T[] | null | undefined,
  cardMessageId?: string | null
): { message: T; index: number } | null {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') return null
    if (typeof message.id !== 'string') continue
    const held = readWaitsForApproval(message.metadata)
    if (!held) continue
    if (cardMessageId === undefined || cardMessageId === null) return { message, index }
    if (isHeldForApprovalCard(message, cardMessageId)) return { message, index }
  }
  return null
}

export type HeldMessageReceipt = {
  messageId: string
  state: 'waiting' | 'expired' | 'stopped' | 'failed'
  label: string
}

/**
 * The receipt line under a held message, in the words of the kept send, with **Send now**.
 *
 * Only a held message that no reply follows can have one (`findHeldMessageAwaitingAnswer`): a
 * reply after it (the follow-up and its placeholder, a new message's or a Send now's reply) has
 * answered or read it, while a send kept at the same card may stand after it (BL-905). While its card waits it
 * says so. If the card expired and only the page's own Deny answered it, the words were never sent,
 * and it says so (`approvalCardExpired`, written by the server). Otherwise, while a reply runs (the
 * resume, or the follow-up that answers it) there is nothing to say. After it, a Stop means stop,
 * and a failed reply left the words unanswered: both say not sent. An answered card with nothing
 * else to say leaves an ordinary message.
 */
export function resolveHeldMessageReceipt(input: {
  messages: readonly MessageLike[] | null | undefined
  busy: boolean
}): HeldMessageReceipt | null {
  const messages = Array.isArray(input.messages) ? input.messages : []
  const found = findHeldMessageAwaitingAnswer(messages)
  if (!found) return null
  const heldMessage = found.message as MessageLike & { id: string }
  const held = readWaitsForApproval(heldMessage.metadata) as WaitsForApproval

  const card = messages.find((message) => message?.id === held.messageId)
  const cardMetadata = metadataOf(card)
  if (card && approvalSummaryIsPending(cardMetadata.toolApprovals)) {
    return { messageId: heldMessage.id, state: 'waiting', label: WAITS_FOR_APPROVAL_SENTENCE }
  }
  if (metadataOf(heldMessage).approvalCardExpired === true) {
    return { messageId: heldMessage.id, state: 'expired', label: HELD_CARD_EXPIRED_SENTENCE }
  }
  if (input.busy) return null
  if (cardMetadata.interrupted === true) {
    return { messageId: heldMessage.id, state: 'stopped', label: HELD_STOPPED_SENTENCE }
  }
  if (cardMetadata.response_failed === true) {
    return { messageId: heldMessage.id, state: 'failed', label: HELD_REPLY_FAILED_SENTENCE }
  }
  return null
}

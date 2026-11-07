/**
 * BL-903 (a) — a kept send's receipt, from the message itself.
 *
 * A send that waited in the chat's line and did not run (the user's Stop, Batshit shutting down
 * or a restore, the line's cap, an approval card left unanswered or answered only by the page's
 * own expiry Deny, a deleted agent) is kept: its message moves to the end of the chat, unanswered
 * (`queuedSendKeeper.ts`). The tabs were told with `queued_send_dropped`, so the tab that sent it
 * showed a "Not sent" receipt with **Send now**; a reload, or any other tab, lost it, and the words
 * stood at the end with nothing to say they were never sent.
 *
 * The keeper now saves the reason with the words, in the same one-step move
 * (`metadata.keptSend: { reason }`), and every tab draws the receipt from that record while no
 * reply follows the message, like a held message's (`resolveHeldMessageReceipt`). Nothing clears
 * the mark: a reply after the message (its Send now's, or a later turn's, which read it) ends the
 * receipt. The compiler never reads it.
 */
import {
  HELD_CARD_EXPIRED_SENTENCE,
  HELD_REPLY_FAILED_SENTENCE,
  HELD_STOPPED_SENTENCE,
  type HeldMessageReceipt
} from '$lib/utils/heldForApproval'
import { MESSAGE_FACT_KEYS, pickSendFacts } from '$lib/utils/sendFacts'

/**
 * Why a send was not sent, in the words the tabs show (`queued_send_dropped`'s reasons, read once).
 * `unanswered` is the page's own backstop (a steer the server never placed or promoted), never a
 * reason the server gives; `not_sent` is every reason Batshit itself kept a send for.
 */
export type DroppedSendReason = 'stopped' | 'unanswered' | 'approval_wait' | 'approval_expired' | 'not_sent'

/**
 * The sentence for a card that held a send for 15 minutes and stopped waiting. It stays true after
 * the card is answered: a reload draws it from the message, and only a reply after it ends it.
 */
export const APPROVAL_WAIT_DROPPED_SENTENCE =
  'Not sent — it stopped waiting for the approval card. Send it when you are ready.'

/**
 * BL-903 (c) — the plain receipt: Batshit kept the send itself (it was stopping or a backup restore
 * began, the line already held five, the agent was deleted while it waited). No reply ended for
 * it, so it does not say one did; the receipt's Send now sends it.
 */
export const NOT_SENT_SENTENCE = 'Not sent'

/**
 * The line's reason, as the tabs say it: a Stop, the card's 15-minute bound, and the card's
 * expiry each have their own words; every other reason (shutdown, which a restore uses too, the
 * cap, a deleted agent) is the plain "Not sent".
 */
export function toDroppedSendReason(reason: unknown): DroppedSendReason {
  return reason === 'stopped' || reason === 'approval_wait' || reason === 'approval_expired'
    ? reason
    : 'not_sent'
}

/** One sentence per reason: the steer bubble's receipt and the record's say the same. */
export function droppedSendSentence(reason: DroppedSendReason): string {
  switch (reason) {
    case 'unanswered':
      return HELD_REPLY_FAILED_SENTENCE
    case 'approval_wait':
      return APPROVAL_WAIT_DROPPED_SENTENCE
    case 'approval_expired':
      return HELD_CARD_EXPIRED_SENTENCE
    case 'not_sent':
      return NOT_SENT_SENTENCE
    default:
      return HELD_STOPPED_SENTENCE
  }
}

/** `metadata.keptSend` of a message, if the line kept it. */
export function readKeptSend(metadata: unknown): { reason: string } | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as Record<string, unknown>).keptSend
  if (!raw || typeof raw !== 'object') return null
  const reason = (raw as Record<string, unknown>).reason
  return typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : null
}

const RECEIPT_STATE: Record<DroppedSendReason, HeldMessageReceipt['state']> = {
  stopped: 'stopped',
  unanswered: 'failed',
  approval_wait: 'not_sent',
  approval_expired: 'expired',
  not_sent: 'not_sent'
}

type MessageLike = { id?: unknown; role?: unknown; metadata?: unknown }

/**
 * The receipts the chat draws from its records: each kept message at the end of the chat that no
 * reply follows. None while the chat is busy (a Send now's run, or a reply that will read them).
 */
export function resolveKeptSendReceipts(input: {
  messages: readonly MessageLike[] | null | undefined
  busy: boolean
}): HeldMessageReceipt[] {
  if (input.busy || !Array.isArray(input.messages)) return []
  const receipts: HeldMessageReceipt[] = []
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]
    if (!message || message.role !== 'user') break
    if (typeof message.id !== 'string') continue
    const kept = readKeptSend(message.metadata)
    if (!kept) continue
    const reason = toDroppedSendReason(kept.reason)
    receipts.unshift({ messageId: message.id, state: RECEIPT_STATE[reason], label: droppedSendSentence(reason) })
  }
  return receipts
}

/**
 * What a kept message's **Send now** sends with it, the facts the sending tab's bubble replays
 * (`replayableSendMetadata`, the whole send it made): the send facts its request carried, which
 * the keeper saved in the mark (`keptSend.sendFacts`, `SEND_FACT_KEYS`; the message itself keeps
 * only its project and voice, which stand in for a mark saved without them), and the message's
 * own (`MESSAGE_FACT_KEYS`: spoken, Clips, files, skill).
 */
export function keptSendReplayMetadata(metadata: unknown): Record<string, unknown> {
  const source = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  const mark = source.keptSend && typeof source.keptSend === 'object' ? (source.keptSend as Record<string, unknown>) : {}
  const savedFacts = mark.sendFacts && typeof mark.sendFacts === 'object' ? mark.sendFacts : source
  const facts = pickSendFacts(savedFacts)
  for (const key of MESSAGE_FACT_KEYS) {
    if (source[key] !== undefined && source[key] !== null) facts[key] = source[key]
  }
  return facts
}

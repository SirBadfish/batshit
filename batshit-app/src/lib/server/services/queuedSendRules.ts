/**
 * BL-4 — a send that meets another turn waits for it instead of being refused.
 *
 * The page saves the user's message BEFORE it posts to send-routed. A send that met a reply
 * another tab had started (in its first seconds, before that tab's reply had sent any event, so
 * this tab did not know) used to be refused `session_turn_in_progress`, and its words stayed in
 * the chat unanswered. Now the page's own send waits in the chat's line (`streamAbortRegistry.ts`)
 * and runs, as itself, when the chat is free: its own agent, clips, files, assistant id, Stop
 * signal and final answer, with the message it already saved. Nothing is ever written twice.
 *
 * The decisions live here, where a test can reach them; send-routed only wires them.
 */

import type { QueuedSendKeepReason } from './streamAbortRegistry'

/**
 * How many sends may wait to RUN behind one chat's turn. The sixth gets today's refusal (and its
 * saved words still end up after the replies ahead of it, unanswered). Kept sends, which will
 * never run, do not count. The same number as `MAX_PENDING_STEERS`: five messages waiting for one
 * chat is already a lot to take in.
 */
export const QUEUED_SEND_CAP = 5

/**
 * How long a queued send's event forward to `/api/sse` may take (BL-204). The send's later events
 * and its final answer wait for its "Queued" forward, and a Stop's "Not sent" notice waits for it
 * too, so a forward that never answered held the chat until a Stop or the two-minute orphan rule.
 * An in-process post that normally answers in milliseconds; five seconds is the same grace a
 * stopped request gets before its lock goes.
 */
export const QUEUED_SEND_FORWARD_LIMIT_MS = 5_000

/** The answer a queued send gets when it will not run (Stop, shutdown). */
export const QUEUED_SEND_KEPT_CODE = 'queued_send_kept'

/**
 * Only the page's own ordinary send waits in the line:
 *
 * - it asked to be answered early (`Prefer: respond-async`), so waiting holds no connection of
 *   the browser's, and its tab hears the end over the live hub;
 * - it names the message it saved (`userMessageId`), which is what lets the line reuse that
 *   message instead of writing a second one;
 * - it carries words.
 *
 * An approval click never waits here (it answers one card, and has its own wait for the reply
 * that raised it). A woken turn never does (`metadata.wake`): the wake registry is keyed by chat,
 * so a woken turn waiting behind another turn would lend that turn its hard time limit, its
 * "woken" standing for approvals, and its zip ownership; it keeps today's `agent_busy`. Callers
 * that wait for the end of their own turn (the voice turn route, artifact share, isolated test driver, the
 * proof drivers) keep today's refusal as well.
 */
export function isQueueableSend(input: {
  prefersRespondAsync: boolean
  approvalClick: boolean
  hasUserContent: boolean
  userMessageId: unknown
  wake: unknown
}): boolean {
  if (!input.prefersRespondAsync) return false
  if (input.approvalClick) return false
  if (input.wake) return false
  if (!input.hasUserContent) return false
  return typeof input.userMessageId === 'string' && input.userMessageId.trim().length > 0
}

/**
 * What a queueable send does about its chat, read in the same synchronous step that registers it
 * if the chat is free: `free` (go on as always), `queue` (wait in the line: behind a held lock,
 * or behind sends already waiting even while the chat is free for a moment), or `overflow` (the
 * line already holds `QUEUED_SEND_CAP` sends that will run).
 */
export function decideQueuedSend(input: {
  lockHeld: boolean
  queuedTurns: number
  runnableQueuedTurns: number
}): 'free' | 'queue' | 'overflow' {
  if (!input.lockHeld && input.queuedTurns === 0) return 'free'
  if (input.runnableQueuedTurns >= QUEUED_SEND_CAP) return 'overflow'
  return 'queue'
}

/** The message a send names must be the same user's own saved user message, in this chat. */
export function isSavedUserMessageForSend(
  record: unknown,
  context: { sessionId: string; userId: string; userMessageId: string }
): boolean {
  if (!record || typeof record !== 'object') return false
  const message = record as Record<string, unknown>
  return (
    message.id === context.userMessageId &&
    message.role === 'user' &&
    message.session_id === context.sessionId &&
    message.user_id === context.userId
  )
}

type HistoryMessage = { id?: unknown; role?: unknown; status?: unknown; content?: unknown; metadata?: unknown }

/** A reply the browser was still drawing: its finished form, if any, is in the store. */
function isReplyPlaceholder(message: HistoryMessage | null | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  const metadata =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as Record<string, unknown>)
      : {}
  return metadata.client_waiting_placeholder === true || message.status === 'in_progress'
}

/**
 * The history a queued send's turn compiles.
 *
 * The request carries the browser's history from the moment the user pressed Enter: its view of
 * the chat, with the user's manual trim and compaction applied, but without the reply the send
 * then waited for. So the turn keeps every message of that view, drops reply placeholders the
 * browser was still drawing, and adds each message the chat stored after the last one the
 * browser had (the reply it waited behind, a continuation, a promoted steer). The send itself
 * goes LAST, as the browser's own copy (the one whose words the request carries), wherever it
 * sat before: the current turn is always the last message, exactly as for any send. Other sends
 * still waiting in the line are left out from both sources. No message appears twice.
 *
 * BL-904: a message the browser knew can be stored AFTER the reply it was still drawing: words
 * held for an approval card (BL-455) below a reply that then resumed, or a first waiting send
 * the tab still listed when it posted a second. That reply's finished form then sits before the
 * last known message, where "what the chat stored after it" never reaches. So each dropped
 * placeholder's stored copy comes back at its stored place, before the first kept message stored
 * after it. A placeholder with no stored copy (a crash) adds nothing.
 */
export function mergeQueuedSendHistory<T extends HistoryMessage>(input: {
  requestHistory: T[] | unknown
  storedRecent: T[] | unknown
  userMessageId: string
  isStillQueued?: (messageId: unknown) => boolean
}): T[] {
  const request = Array.isArray(input.requestHistory) ? (input.requestHistory as T[]) : []
  const stored = Array.isArray(input.storedRecent) ? (input.storedRecent as T[]) : []
  const isStillQueued = input.isStillQueued ?? (() => false)
  const ownCopy =
    request.find((message) => message?.id === input.userMessageId) ??
    stored.find((message) => message?.id === input.userMessageId) ??
    null

  const kept = request.filter(
    (message) =>
      message?.id !== input.userMessageId &&
      !isReplyPlaceholder(message) &&
      !isStillQueued(message?.id)
  )
  const known = new Set<unknown>(kept.map((message) => message?.id).filter((id) => id != null))
  let anchor = -1
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    if (known.has(stored[index]?.id)) {
      anchor = index
      break
    }
  }
  // BL-904: the stored copy of a dropped placeholder that sits before the anchor. One after it
  // arrives with everything else stored after the anchor, as before.
  const storedIndex = new Map<unknown, number>()
  stored.forEach((message, index) => {
    if (message?.id != null && !storedIndex.has(message.id)) storedIndex.set(message.id, index)
  })
  const placeholderIds = new Set<unknown>(
    request
      .filter((message) => isReplyPlaceholder(message) && !known.has(message?.id))
      .map((message) => message?.id)
  )
  const restored = [...placeholderIds]
    .map((id) => storedIndex.get(id))
    .filter((index): index is number => index !== undefined && index < anchor)
    .sort((a, b) => a - b)
  const withRestored: T[] = []
  let next = 0
  for (const message of kept) {
    const index = storedIndex.get(message?.id)
    while (next < restored.length && index !== undefined && restored[next] < index) {
      withRestored.push(stored[restored[next]])
      next += 1
    }
    withRestored.push(message)
  }
  for (; next < restored.length; next += 1) withRestored.push(stored[restored[next]])
  const present = new Set<unknown>(withRestored.map((message) => message?.id))

  const arrived = stored
    .slice(anchor + 1)
    .filter(
      (message) =>
        message?.id !== input.userMessageId &&
        !present.has(message?.id) &&
        !isStillQueued(message?.id)
    )
  return ownCopy ? [...withRestored, ...arrived, ownCopy] : [...withRestored, ...arrived]
}

/**
 * BL-906 (b) — was this send made while its tab still drew a reply?
 *
 * Its history then holds that reply as a placeholder (the tab had not seen its `end`). Such a
 * send belongs behind that reply: it joins the chat's line even while the reply's request is only
 * finishing, so a card that reply raised holds it (BL-713). A send made after its tab saw the
 * reply end is the user's new message, and waits for a finishing turn as any send does (BL-455).
 * The send's own reply placeholder (`ownReplyId`, the body's `messageId`) does not count: an
 * idle tab draws it before it builds the history (the review of BL-906, 2026-09-29).
 */
export function sentWhileReplyRan(requestHistory: unknown, ownReplyId?: unknown): boolean {
  if (!Array.isArray(requestHistory)) return false
  const own = typeof ownReplyId === 'string' && ownReplyId.trim() ? ownReplyId.trim() : null
  return requestHistory.some((message) => {
    const entry = message as HistoryMessage
    return isReplyPlaceholder(entry) && (own === null || entry?.id !== own)
  })
}

/**
 * Does a send of a message already saved in the chat move that message to the end first?
 *
 * A fresh send's message is the newest thing its tab knows: it moves only when the tab knew of
 * messages stored after it, which is a Send now on a kept message's receipt after the user said
 * more. A message the tab did not know (another tab's send saved a moment later, racing this
 * one) or one still waiting in the line came after it and stays after it. Measured live: moving
 * a fresh send after another tab's message restamped it later than the reply its own tab had
 * already added, and that tab drew its reply above its question.
 */
export function shouldMoveSentMessageToEnd(input: {
  idsAfter: unknown
  requestHistory: unknown
  userMessageId: string
  isStillQueued?: (messageId: unknown) => boolean
}): boolean {
  if (!Array.isArray(input.idsAfter) || !Array.isArray(input.requestHistory)) return false
  const isStillQueued = input.isStillQueued ?? (() => false)
  const known = new Set<unknown>(
    (input.requestHistory as HistoryMessage[])
      .map((message) => message?.id)
      .filter((id) => id != null && id !== input.userMessageId)
  )
  return input.idsAfter.some((id) => known.has(id) && !isStillQueued(id))
}

/**
 * The time a resent message is stamped with when it moves to the end: its tab's own time of
 * sending (the copy the tab posted), so the reply that tab adds next, stamped later by the same
 * clock, sorts after it. `null` (the server's clock) when that time is missing, unreadable, or
 * older than the stored message, and when it is later than the server's own clock (BL-197): every
 * reply is dated by the server's clock, so a resent message dated by a tab running ahead of it
 * sorted after its own reply in every reader that orders a chat by time. Always taking the
 * server's clock is not the answer either: the move happens after the tab has drawn its reply
 * placeholder, so a tab merging by time drew the reply above the question (measured on BL-4, when
 * a moved fresh send was dated by the server).
 */
export function resentMessageCreatedAt(
  requestCopy: unknown,
  storedCreatedAt: unknown,
  serverNow: number = Date.now()
): string | null {
  if (!requestCopy || typeof requestCopy !== 'object') return null
  const sentAt = (requestCopy as Record<string, unknown>).created_at
  if (typeof sentAt !== 'string') return null
  const sentMs = Date.parse(sentAt)
  if (!Number.isFinite(sentMs)) return null
  const storedMs = typeof storedCreatedAt === 'string' ? Date.parse(storedCreatedAt) : Number.NaN
  if (Number.isFinite(storedMs) && sentMs < storedMs) return null
  if (sentMs > serverNow) return null
  return new Date(sentMs).toISOString()
}

const KEPT_DETAILS: Record<QueuedSendKeepReason, string> = {
  stopped: 'You stopped the reply it was waiting for. Your message is in the chat, unanswered.',
  shutdown: 'Batshit stopped before its turn came. Your message is in the chat, unanswered.',
  overflow: 'Five messages were already waiting for this chat. Yours is in the chat, unanswered.',
  // BL-713: the line held for an approval card (BL-455's words for the same two moments).
  approval_wait:
    'The approval card is still waiting for your answer. Your message is in the chat, unanswered.',
  approval_expired: 'The approval card expired. Your message is in the chat, unanswered.',
  // BL-965: read again under the chat's lock, the agent was gone.
  agent_deleted: 'The agent was deleted before its turn came. Your message is in the chat, unanswered.'
}

/** The final answer of a queued send that was kept instead of run. */
export function buildQueuedSendKeptAnswer(reason: QueuedSendKeepReason) {
  return {
    error: 'Not sent.',
    code: QUEUED_SEND_KEPT_CODE,
    reason,
    details: KEPT_DETAILS[reason]
  }
}

/**
 * The sixth send's answer: today's refusal, with details that say where its words went (they
 * stay saved, and land after the replies ahead of them, unanswered).
 */
export function buildQueuedSendOverflowAnswer(options: { keptInLine?: boolean } = {}) {
  // While a restore drains, the send is not kept in the line, so nothing will move its words.
  const where =
    options.keptInLine === false
      ? 'Yours is saved where you sent it, unanswered.'
      : 'Yours is saved and will show after them, unanswered.'
  return {
    error: 'Another response is already in progress for this session.',
    code: 'session_turn_in_progress',
    details: `${QUEUED_SEND_CAP} messages are already waiting for this chat. ${where}`
  }
}

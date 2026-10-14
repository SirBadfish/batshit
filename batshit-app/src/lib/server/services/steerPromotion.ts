import { redis } from '$lib/server/redis'
import { generateMessageId } from '$lib/utils/messageId'
import { internalServiceHeaders } from '$lib/server/services/internalRequestAuth'
import type { ChatMessage } from '$lib/types/database'
import type { SteerEntry } from '$lib/utils/steerControl'
import { findHeldMessageAwaitingAnswer, type WaitsForApproval } from '$lib/utils/heldForApproval'

/**
 * SA-114 P1 (DL-114-07) — the server-owned promotion of a steer that could not land.
 *
 * A reply with no tool boundary left — a plain text answer, or an agent already wrapping
 * up — cannot carry a steer inside it. Rather than dropping it, or leaving it to a tab that
 * may already be closed, the server sends it as the user's next message. That is Claude
 * Code's own rule ("sends only the oldest as the next turn"), done server-side.
 */

/**
 * How many chained promotions ONE request performs.
 *
 * The loop terminates on its own: each pass empties the inbox, and only a new HTTP request
 * from the user can refill it. This bound is a safety net against an unforeseen refill
 * loop, not a product limit, and matches `MAX_CONTEXT_CONTINUATIONS` beside it.
 */
export const MAX_STEER_PROMOTIONS = 3

export type SteerNoAnswerReason = 'promotion_limit' | 'promotion_failed' | 'stopped' | 'reply_failed'

/** Exact server outcome; no answer is scheduled for these ids by this operation. */
export async function publishUnansweredSteers(params: {
  sessionId: string; steerIds: string[]; reason: SteerNoAnswerReason
  eventFetch: typeof fetch; request: Request
}) {
  if (params.steerIds.length === 0) return
  try {
    await params.eventFetch(new URL('/api/sse', params.request.url).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-sse-forward': '1', ...internalServiceHeaders() },
      body: JSON.stringify({ type: 'steer_promoted', sessionId: params.sessionId, steerIds: params.steerIds,
        metadata: { steerPromoted: { steerIds: params.steerIds, disposition: 'unanswered', reason: params.reason } } }),
    })
  } catch (error) {
    console.warn('[BL-1291] Could not forward an exact unanswered steer disposition:', { sessionId: params.sessionId, error })
  }
}

/** The promotion-limit save is deliberately NOT a runnable promotion. */
export async function saveSteersWithoutAnswer(params: Parameters<typeof writeSteersAsUserMessage>[0]) {
  const saved = await writeSteersAsUserMessage({ ...params, disposition: 'unanswered', noAnswerReason: 'promotion_limit' })
  if (!saved) await publishUnansweredSteers({ ...params, steerIds: params.steers.map((entry) => entry.steerId), reason: 'promotion_failed' })
  return saved
}

/**
 * BL-905 — how far back the expiry mark looks for held words behind the sends the chat's line
 * kept at the same card. The line runs at most `QUEUED_SEND_CAP` (5) sends, and each send over the
 * cap is kept one by one, so a few dozen messages cover every real end of a chat.
 */
const HELD_MESSAGE_LOOKBACK = 50

/**
 * Write the promoted user message and get the follow-up turn's inputs (DL-114-07).
 *
 * Several undelivered steers become ONE message, blank-line separated in acceptance order,
 * carrying the FIRST steer's id — so the optimistic bubble the client already drew becomes
 * the real message instead of a second one appearing beneath it.
 *
 * Returns null if the message could not be written, which is a reason to stop rather than
 * to run a turn with nothing in front of it.
 */
export async function promoteSteersToNextTurn(params: {
  sessionId: string
  userId: string
  agentId: string
  steers: SteerEntry[]
  eventFetch: typeof fetch
  request: Request
  /** BL-455 review: the send's facts, kept on the message (`pickSendFacts`). */
  sendFacts?: Record<string, unknown>
}): Promise<{
  content: string
  assistantMessageId: string
  history: ChatMessage[]
} | null> {
  const { sessionId, steers } = params

  const assistantMessageId = await generateMessageId(sessionId)
  if (!assistantMessageId) {
    console.error('[SA-114] Could not allocate an id for a promoted steer turn', {
      sessionId,
      steerIds: steers.map((entry) => entry.steerId),
    })
    return null
  }

  const userMessage = await writeSteersAsUserMessage(params)
  if (!userMessage) return null

  try {
    return {
      content: String(userMessage.content ?? ''),
      assistantMessageId,
      history: await readFollowUpHistory(sessionId),
    }
  } catch (error) {
    // The words were saved, but their run cannot be compiled without authoritative
    // history. Preserve that exact no-answer fact instead of an empty-history run.
    await writeSteersAsUserMessage({ ...params, disposition: 'unanswered', noAnswerReason: 'promotion_failed' })
    throw error
  }
}

/**
 * The metadata a follow-up turn runs with: the request's own (the send's tools, voice, project,
 * approval mode), minus everything that belonged to the run before it, plus the ids of the steers
 * it answers.
 *
 * A promoted message is the USER's words, so it carries no `wake` and no `source`: those mark the
 * current message as Batshit's (a woken turn's DM text, the artifact share follow-up), and
 * `resolveCurrentMessageFrom` would compile the user's steer as a Batshit `<note>`. They were spread
 * in with the rest until 2026-09-27, so a steer typed during a woken turn was compiled as
 * Batshit's own words. The approval answer, the expired-approval notice, the Stop note, and a
 * context continuation belong to the run before; `contextContinuation` also adds its addendum to
 * any compile that carries it.
 */
export function followUpTurnMetadata(metadata: unknown, steerIds: string[]): Record<string, any> {
  const {
    toolApprovalResponse: _approvals,
    tool_approval_response: _approvalsSnake,
    expiredToolApprovals: _expired,
    interruption: _interruption,
    contextContinuation: _continuation,
    wake: _wake,
    source: _source,
    ...rest
  } = metadata && typeof metadata === 'object' ? (metadata as Record<string, any>) : {}
  return { ...rest, steerPromoted: { steerIds } }
}

/**
 * BL-455 review (D1) — the facts of the send a turn belongs to, which a follow-up turn must run with.
 *
 * A follow-up in the request of an approval CLICK cannot take them from the request: a click posts
 * the paused REPLY's metadata (the card's message), which has no project, no voice mode, and no
 * tool choice. So every user message the server writes (a promoted or a held one) carries them at
 * the top of its metadata, as the page's own messages carry `projectPath`, `stt` and `tts`, and a
 * click recovers them from the user message of the turn that raised the card (`findPausedApprovalTurn`,
 * as the resume itself does for its project). A NEW send fact that a follow-up must keep is added
 * here; anything not named here does not follow the words.
 */
export const SEND_FACT_KEYS = [
  'projectPath',
  'projectRules',
  // Not `stt`: that says THIS message was spoken, and the words that wait were typed.
  'tts',
  'voiceMode',
  'realtime',
  'goonsEnabled',
  'goonPresentationMode',
  'selectedTools',
  'selectedGateways',
  'selectedMCPs',
  'mcpToolSelections',
  'toolApprovalMode',
  'codexPermissionMode',
  'claudePermissionMode',
] as const

export function pickSendFacts(metadata: unknown): Record<string, unknown> {
  const source = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  const facts: Record<string, unknown> = {}
  for (const key of SEND_FACT_KEYS) {
    if (source[key] !== undefined && source[key] !== null) facts[key] = source[key]
  }
  // The page stores `voiceMode` on its own user message as a boolean (`tts || false`); a send and a
  // run read it as 'voice' or 'text'.
  if ('voiceMode' in facts && typeof facts.voiceMode !== 'string') {
    facts.voiceMode = facts.voiceMode === true || facts.tts === true ? 'voice' : 'text'
  }
  return facts
}

/**
 * BL-455 — the reply stopped at an approval card, so the words wait for the user's click.
 *
 * A reply that stops at a card has not ended: it waits for the user, and the words the user typed
 * while it ran wait with it. Promoting them started a whole new turn beside the waiting card: that
 * turn answered the words without the approved action (and could ask for the same tool again), an
 * Approve click waited up to 15 s for it and was then refused, and a later resume compiled only the
 * history before the card, so it never saw the words (which may have said stop).
 *
 * So the steers become the same ONE saved user message a promotion writes (the first steer's id,
 * `metadata.steerPromoted`), marked `metadata.waitsForApproval` with the id of the message the card
 * is on, and every tab hears `user_message` and `steer_promoted` as it does for a promotion. No
 * turn runs. The click's request answers it when the resumed reply ends (send-routed), a later
 * message reads it in its history, and it survives a restart, a closed tab, and a backup, because
 * it is an ordinary chat message: no new Redis key.
 */
export async function holdSteersForApprovalCard(params: {
  sessionId: string
  userId: string
  agentId: string
  steers: SteerEntry[]
  cardMessageId: string
  /** The server run's exact paused version; never request metadata. */
  cardVersion?: number
  eventFetch: typeof fetch
  request: Request
  /** The send's facts (`pickSendFacts`), kept on the message for the turn that answers it. */
  sendFacts?: Record<string, unknown>
}): Promise<ChatMessage | null> {
  const saved = await writeSteersAsUserMessage({
    ...params,
    waitsForApproval: { messageId: params.cardMessageId },
    disposition: 'awaiting_approval',
    approvalResumeVersion: params.cardVersion ?? 0,
  })
  if (!saved) await publishUnansweredSteers({ ...params, steerIds: params.steers.map((entry) => entry.steerId), reason: 'promotion_failed' })
  return saved
}

/**
 * BL-455 — the resumed reply is over: the message held for its card, if it is still to answer.
 *
 * Only while no reply follows it (`findHeldMessageAwaitingAnswer`; a message still waiting in the
 * chat's line is not part of the chat yet, so it does not count). A reply after it means a later
 * turn has read the words already; on a CLI lane the click's own resume message and its reply come
 * after it, and that turn's compile read it too. A send the line kept at the same card may stand
 * after it unanswered (BL-905): the held words were typed first, so they are answered first, and
 * their turn's history ends with them; the kept send waits for its own Send now. The follow-up
 * turn's inputs, in a promotion's shape: the held words, a new assistant id, and the history
 * re-read from Redis. Null means nothing to answer.
 */
export async function readHeldMessageToAnswer(params: {
  sessionId: string
  cardMessageId: string
}): Promise<{
  content: string
  assistantMessageId: string
  history: ChatMessage[]
  steerIds: string[]
  /** The send facts the hold kept on the message (empty for a message held before they were). */
  sendFacts: Record<string, unknown>
} | null> {
  const stored = await readFollowUpHistory(params.sessionId)
  const found = findHeldMessageAwaitingAnswer(stored, params.cardMessageId)
  if (!found) return null
  const last = found.message
  const history = stored.slice(0, found.index + 1)
  const content = typeof last.content === 'string' ? last.content : ''
  if (!content.trim()) return null

  const assistantMessageId = await generateMessageId(params.sessionId)
  if (!assistantMessageId) {
    console.error('[BL-455] Could not allocate an id to answer a message held for an approval card', {
      sessionId: params.sessionId,
      userMessageId: last.id,
    })
    return null
  }
  return {
    content,
    assistantMessageId,
    history,
    // More than one saved hold can name this card; this compile includes all of them.
    steerIds: heldSteerIds(history, params.cardMessageId),
    sendFacts: pickSendFacts(last.metadata),
  }
}

/** The held server record, read BEFORE a CLI approval turn writes its new user message. */
export async function readHeldSteerIds(params: { sessionId: string; cardMessageId: string }): Promise<string[]> {
  const history = await readFollowUpHistory(params.sessionId)
  const found = findHeldMessageAwaitingAnswer(history, params.cardMessageId)
  return found ? heldSteerIds(history.slice(0, found.index + 1), params.cardMessageId) : []
}

/** Only a run whose actual compile history contains these server-saved words owns them. */
export async function readHeldSteerIdsForHistory(sessionId: string, compileHistory: ChatMessage[]): Promise<string[]> {
  const stored = trailingUserBlock(await readFollowUpHistory(sessionId))
  const included = stored.filter((message) => compileHistory.some((entry) => entry.id === message.id &&
    entry.role === 'user' && entry.content === message.content))
  return heldSteerIds(included)
}

function trailingUserBlock(history: ChatMessage[]): ChatMessage[] {
  let start = history.length
  while (start > 0 && history[start - 1].role === 'user') start--
  return history.slice(start)
}

function heldSteerIds(history: ChatMessage[], cardMessageId?: string): string[] {
  return [...new Set(trailingUserBlock(history).flatMap((message) => {
    const metadata = message.metadata as Record<string, any> | undefined
    if (message.role !== 'user' || typeof metadata?.waitsForApproval?.messageId !== 'string' ||
      (cardMessageId && metadata.waitsForApproval.messageId !== cardMessageId) ||
      metadata.approvalCardExpired === true || metadata.steerPromoted?.disposition === 'unanswered') return []
    const ids = metadata.steerPromoted?.steerIds
    return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? ids : [String(message.id)]
  }))]
}

/**
 * BL-455 (Faye, 2026-09-27) — the card ran out of time and only the page's own Deny answered it.
 *
 * That ends the card and its tool call, and nothing more: the words held for it are NOT answered.
 * The held message, if no reply follows it yet (sends the line kept at the same card may stand
 * after it, BL-905), is marked `approvalCardExpired` (a top-level key, so a tab's later save of an
 * older copy keeps it) and every tab is told, so it says "Not sent — the approval card expired"
 * with Send now. Never throws: the answer is recorded and the resume runs either way.
 */
export async function markHeldMessageCardExpired(params: {
  sessionId: string
  userId: string
  cardMessageId: string
  eventFetch: typeof fetch
  request: Request
}): Promise<boolean> {
  return markHeldMessageUnanswered({ ...params, reason: 'approval_expired' })
}

/** A recorded CLI Deny/expiry with no run terminates only the card's exact steers. */
export async function markApprovalCardWithoutAnswer(params: {
  sessionId: string; userId: string; cardMessageId: string; eventFetch: typeof fetch; request: Request
  reason: 'approval_denied' | 'approval_expired'
}): Promise<void> {
  const card = await redis.execute((client) => client.json.get(`message:${params.sessionId}:${params.cardMessageId}`)) as ChatMessage | null
  if (!card || card.role !== 'assistant' || card.session_id !== params.sessionId || card.user_id !== params.userId) {
    throw new Error('Could not confirm the answered approval card')
  }
  const metadata = card.metadata as Record<string, any> | undefined
  const steerIds = [...new Set([
    ...(Array.isArray(metadata?.steerPromoted?.steerIds) ? metadata.steerPromoted.steerIds : []),
    ...(Array.isArray(metadata?.steers) ? metadata.steers.filter((entry: any) => entry?.source !== 'dm').map((entry: any) => entry.steerId) : []),
  ].filter((id): id is string => typeof id === 'string'))]
  if (!steerIds.length) return
  const marked = { ...card, metadata: { ...metadata,
    steerPromoted: { steerIds, disposition: 'unanswered', reason: params.reason } } }
  await redis.updateMessage(String(card.id), params.sessionId, { metadata: marked.metadata }, params.userId)
  try {
    await params.eventFetch(new URL('/api/sse', params.request.url).toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-sse-forward': '1', ...internalServiceHeaders() },
      body: JSON.stringify({ type: 'complete_message', sessionId: params.sessionId, message: marked }),
    })
  } catch (error) {
    console.warn('[BL-1291] Could not forward the saved no-resume disposition:', { sessionId: params.sessionId, error })
  }
}

/** A failed/stopped resume leaves these exact saved words unanswered, without replay. */
export async function markHeldMessageUnanswered(params: {
  sessionId: string; userId: string; cardMessageId: string
  reason: 'approval_expired' | 'stopped' | 'reply_failed'
  eventFetch: typeof fetch; request: Request
}): Promise<boolean> {
  try {
    const history = await redis.getRecentMessages(params.sessionId, HELD_MESSAGE_LOOKBACK)
    const found = findHeldMessageAwaitingAnswer(history, params.cardMessageId)
    if (!found) return false
    // Every still-unanswered hold for this card shares the same exact disposition.
    // A kept send or another card's words are untouched.
    for (const held of trailingUserBlock(history.slice(0, found.index + 1))) {
      const metadata = held.metadata as Record<string, any> | undefined
      if (held.role !== 'user' || metadata?.waitsForApproval?.messageId !== params.cardMessageId ||
        metadata.steerPromoted?.disposition === 'unanswered') continue
      const steerIds = Array.isArray(metadata.steerPromoted?.steerIds)
        ? metadata.steerPromoted.steerIds.filter((id: unknown): id is string => typeof id === 'string') : [String(held.id)]
      const marked = { ...held, metadata: { ...metadata,
        ...(params.reason === 'approval_expired' ? { approvalCardExpired: true } : {}),
        steerPromoted: { steerIds, disposition: 'unanswered', reason: params.reason } } }
      // updateMessage replaces metadata whole; return all the stored siblings with the mark.
      await redis.updateMessage(String(held.id), params.sessionId, { metadata: marked.metadata }, params.userId)
      await params.eventFetch(new URL('/api/sse', params.request.url).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-sse-forward': '1', ...internalServiceHeaders() },
        body: JSON.stringify({ type: 'user_message', sessionId: params.sessionId, message: marked }),
      })
    }
    return true
  } catch (error) {
    console.warn('[BL-1291] Could not mark an unanswered held message:', {
      sessionId: params.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * History re-read from Redis so a follow-up turn sees the reply it is answering and the message
 * it answers, rather than the browser's copy from before the steer.
 */
export async function readFollowUpHistory(sessionId: string): Promise<ChatMessage[]> {
  try {
    return await redis.getRecentMessages(sessionId, 300)
  } catch (error) {
    console.error('[SA-114] Could not reload history for a promoted steer turn:', {
      sessionId,
      error,
    })
    throw error
  }
}

/**
 * The saved user message a promotion and a hold both write (DL-114-07, BL-455), forwarded to
 * every tab. Null if it could not be written.
 */
async function writeSteersAsUserMessage(params: {
  sessionId: string
  userId: string
  agentId: string
  steers: SteerEntry[]
  eventFetch: typeof fetch
  request: Request
  waitsForApproval?: WaitsForApproval
  sendFacts?: Record<string, unknown>
  disposition?: 'awaiting_approval' | 'unanswered'
  noAnswerReason?: SteerNoAnswerReason
  approvalResumeVersion?: number
}): Promise<ChatMessage | null> {
  const { sessionId, userId, agentId, steers, eventFetch, request } = params
  const content = steers.map((entry) => entry.text.trim()).join('\n\n')
  const steerIds = steers.map((entry) => entry.steerId)

  const userMessage = {
    id: steers[0].steerId,
    session_id: sessionId,
    user_id: userId,
    agent_id: agentId,
    role: 'user' as const,
    status: 'complete',
    content,
    created_at: new Date().toISOString(),
    metadata: {
      // BL-455 review: the send's own facts (project, voice, tool choice), at the top like the
      // page's messages, so the turn that answers this message runs as that send did.
      ...pickSendFacts(params.sendFacts),
      // NO `metadata.wake`: a human typed this, which is what lets a woken chat read as
      // human from here on, exactly as SA-116's approval resume does.
      steerPromoted: { steerIds,
        ...(params.approvalResumeVersion !== undefined ? { approvalResumeVersion: params.approvalResumeVersion } : {}),
        ...(params.disposition ? { disposition: params.disposition } : {}),
        ...(params.noAnswerReason ? { reason: params.noAnswerReason } : {}) },
      // BL-455: top-level, so a tab's later save of this message (which merges metadata one level
      // deep) keeps it.
      ...(params.waitsForApproval ? { waitsForApproval: params.waitsForApproval } : {}),
    },
  }

  try {
    await redis.saveMessage(userMessage as any)
  } catch (error) {
    console.error('[SA-114] Could not persist a promoted steer message:', {
      sessionId,
      steerIds,
      error,
    })
    return null
  }

  // Show it in the chat the way a woken turn's message appears. No top-level messageId on
  // EITHER event: the replay buffer is keyed on the ASSISTANT id, and an event carrying any
  // other id is pinned in that buffer for the life of the process (PR #106 review, F-22 —
  // the promoted event used to carry the steer id, so the session's buffer never drained and
  // every later listener replayed a stale `steer_promoted` on connect). The client settles
  // the bubbles by `steerIds` alone.
  for (const body of [
    { type: 'user_message', sessionId, message: userMessage },
    { type: 'steer_promoted', sessionId, steerIds, savedRecord: true, metadata: { steerPromoted: userMessage.metadata.steerPromoted } },
  ]) {
    try {
      await eventFetch(new URL('/api/sse', request.url).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-sse-forward': '1',
          ...internalServiceHeaders(),
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      console.warn('[SA-114] Could not forward a promoted steer to SSE:', {
        sessionId,
        type: body.type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return userMessage as unknown as ChatMessage
}

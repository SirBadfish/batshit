import { redis } from '$lib/server/redis'
import { withoutServerReplayFields } from '$lib/utils/serverReplayFields'
import { internalServiceHeaders } from '$lib/server/services/internalRequestAuth'
import type { ChatMessage } from '$lib/types/database'
import { findAnsweredApprovalIds, readAnsweredApprovalIds } from './toolApprovalState'
import { heldClaudePlanRunWaitsFor, type ClaudePlanHoldKey } from './claudePlanRunRegistry'

/**
 * SA-139 D6: what an approval click on a Claude plan reply's card meets, decided before anything is
 * recorded (review B M1, S1). A click that names an answered approval is the duplicate the answer
 * record refuses; a click whose cards a held run still waits for claims that run (under the click's
 * lock, in `beforeRecord`); anything else finds no run: its answer is recorded as not run ("the run
 * ended") and nothing runs, since no other Claude Code process may start in that run's place.
 */
export type ClaudePlanClick =
  | { kind: 'already_answered' }
  | { kind: 'live'; key: ClaudePlanHoldKey; toolCallIds: string[] }
  | { kind: 'gone'; why: ClaudePlanGoneReason }

export type ClaudePlanGoneReason = 'run_ended' | 'other_connection' | 'switched_away'

/** The reason a gone run's answer records, the card shows and the person reads. */
export const CLAUDE_PLAN_RUN_ENDED_REASON = 'The Claude Code run behind this card had ended (its time ran out, it was stopped, or Batshit restarted), so nothing ran. Ask the agent again.'

/** Faye's P3 Part 3 read, S1: a card from another connection's reply, clicked with the agent now on the Claude plan. */
export const CLAUDE_PLAN_OTHER_CONNECTION_REASON = 'This card came from a reply on another model connection, and the Claude plan connection can carry on only its own replies, so nothing ran. Ask the agent again.'

/**
 * Review A M1 (P3 Part 4): a Claude plan card, the agent moved to another connection while it waited. The API
 * lane cannot carry the reply on either (its replay refuses a changed connection after the answer is recorded,
 * `APPROVAL_RESUME_MODEL_CHANGED`), so the click is answered as not run, and the held run ends.
 */
export const CLAUDE_PLAN_SWITCHED_AWAY_REASON = 'The agent moved off the Claude plan connection while this card waited, so the Claude Code run behind it ended and nothing ran. Ask the agent again.'

export function claudePlanGoneReason(why: ClaudePlanGoneReason): string {
  return why === 'other_connection' ? CLAUDE_PLAN_OTHER_CONNECTION_REASON : why === 'switched_away' ? CLAUDE_PLAN_SWITCHED_AWAY_REASON : CLAUDE_PLAN_RUN_ENDED_REASON
}

/**
 * Faye's P3 Part 3 read, S1: only a Claude plan reply's record (`metadata.claudePlanReply`, written by
 * send-routed) has a Claude Code run behind its card. `current` says whether the agent is on the Claude
 * plan connection now. Neither: nothing to plan (the API lane's own resume). A card whose reply's connection
 * is not the agent's now cannot be carried on either way: gone, by its own reason (the caller ends a held run
 * the agent moved away from).
 */
export function planClaudePlanClick(input: {
  record: unknown
  responses: ReadonlyArray<{ approvalId?: unknown }>
  sessionId: string
  messageId: string
  current: boolean
}): ClaudePlanClick | null {
  const metadata = ((input.record as { metadata?: unknown } | null)?.metadata ?? {}) as Record<string, any>
  const claudePlanReply = metadata.claudePlanReply === true
  if (!claudePlanReply && !input.current) return null
  if (findAnsweredApprovalIds(input.responses, readAnsweredApprovalIds(metadata)).length > 0) return { kind: 'already_answered' }
  if (!claudePlanReply) return { kind: 'gone', why: 'other_connection' }
  if (!input.current) return { kind: 'gone', why: 'switched_away' }
  const version = Number.isSafeInteger(metadata.approvalResumeVersion) ? metadata.approvalResumeVersion : 0
  const key: ClaudePlanHoldKey = { sessionId: input.sessionId, replyId: input.messageId.trim(), version: String(version) }
  const entries: any[] = Array.isArray(metadata.toolApprovals?.approvals) ? metadata.toolApprovals.approvals : []
  const toolCallIds: string[] = []
  for (const response of input.responses) {
    const approvalId = typeof response?.approvalId === 'string' ? response.approvalId.trim() : ''
    const entry = entries.find(item => item?.approvalId === approvalId)
    // Every spelling a saved card uses for its call (as `brokerControlApprovals.readEntryToolCallId` reads it).
    const toolCallId = entry?.toolCall?.toolCallId ?? entry?.toolCall?.tool_call_id ?? entry?.toolCallId
    if (typeof toolCallId !== 'string' || !toolCallId) return { kind: 'gone', why: 'run_ended' }
    toolCallIds.push(toolCallId)
  }
  return heldClaudePlanRunWaitsFor(key, toolCallIds) ? { kind: 'live', key, toolCallIds } : { kind: 'gone', why: 'run_ended' }
}

/**
 * D6 (review B delta M1): the card of a click that found no run reads "Expired: the reply ended" (the
 * existing `expiryReason: 'run_ended'`), not the answer the person sent, and every tab is told. The answer
 * stays recorded, so the card cannot be answered again. Never throws: the click's answer is recorded.
 */
export async function markClaudePlanCardRunEnded(params: {
  sessionId: string; userId: string; messageId: string; approvalIds: readonly string[]
  eventFetch: typeof fetch; request: Request
}): Promise<void> {
  try {
    const card = await redis.execute(client => client.json.get(`message:${params.sessionId}:${params.messageId}`)) as ChatMessage | null
    if (!card || card.role !== 'assistant' || card.session_id !== params.sessionId || card.user_id !== params.userId) return
    const metadata = (card.metadata ?? {}) as Record<string, any>
    const summary = metadata.toolApprovals
    if (!summary || !Array.isArray(summary.approvals)) return
    const at = new Date().toISOString()
    const approvals = summary.approvals.map((entry: any) => params.approvalIds.includes(entry?.approvalId)
      // Faye's read N1 (review A N1): an entry the page already expired stays as it was, its reason or none ("Expired (3m)").
      ? { ...entry, status: 'expired', expiryReason: entry.status === 'expired' ? entry.expiryReason : 'run_ended', expiredAt: entry.expiredAt ?? at } : entry)
    const marked = { ...card, metadata: { ...metadata, toolApprovals: { ...summary, approvals } } }
    await redis.updateMessage(String(card.id), params.sessionId, { metadata: marked.metadata }, params.userId)
    await params.eventFetch(new URL('/api/sse', params.request.url).toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-sse-forward': '1', ...internalServiceHeaders() },
      body: JSON.stringify({ type: 'complete_message', sessionId: params.sessionId, message: withoutServerReplayFields(marked) })
    })
  } catch (error) {
    console.warn('[SA-139] Could not mark a Claude plan card whose run ended:', { sessionId: params.sessionId, error })
  }
}

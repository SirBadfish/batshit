import { redis } from '$lib/server/redis'
import { generateMessageId } from '$lib/utils/messageId'
import { internalServiceHeaders } from '$lib/server/services/internalRequestAuth'
import type { ChatMessage } from '$lib/types/database'
import type { SteerEntry } from '$lib/utils/steerControl'

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
}): Promise<{
  content: string
  assistantMessageId: string
  history: ChatMessage[]
} | null> {
  const { sessionId, userId, agentId, steers, eventFetch, request } = params
  const content = steers.map((entry) => entry.text.trim()).join('\n\n')
  const steerIds = steers.map((entry) => entry.steerId)

  const assistantMessageId = await generateMessageId(sessionId)
  if (!assistantMessageId) {
    console.error('[SA-114] Could not allocate an id for a promoted steer turn', {
      sessionId,
      steerIds,
    })
    return null
  }

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
      // NO `metadata.wake`: a human typed this, which is what lets a woken chat read as
      // human from here on, exactly as SA-116's approval resume does.
      steerPromoted: { steerIds },
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
    { type: 'steer_promoted', sessionId, steerIds },
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

  // History re-read from Redis so the follow-up turn sees the reply it is answering and
  // the message just written, rather than the browser's copy from before the steer.
  let history: ChatMessage[] = []
  try {
    history = await redis.getRecentMessages(sessionId, 300)
  } catch (error) {
    console.error('[SA-114] Could not reload history for a promoted steer turn:', {
      sessionId,
      error,
    })
    history = []
  }

  return { content, assistantMessageId, history }
}

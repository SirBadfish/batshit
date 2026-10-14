import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import {
  abortGroupChat,
  abortStream,
  clearSessionTurn,
  getActiveGroupAbort,
  getActiveSessionTurn,
  getActiveStream,
  keepQueuedSessionTurns,
  queuedSendNotices,
  stopSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import { abortWokenTurnForInterrupt } from '$lib/server/services/agentWakeups'
import { QUEUED_SEND_FORWARD_LIMIT_MS } from '$lib/server/services/queuedSendRules'
import {
  internalServiceHeaders,
  isTrustedInternalRequest
} from '$lib/server/services/internalRequestAuth'

/**
 * BL-4 — tell every tab on the chat that its waiting sends will not be sent.
 *
 * Posted through `/api/sse` like the other chat events, so each tab turns its "Queued" bubble
 * into the "Not sent — you stopped the reply" receipt at once, without waiting for the stopped
 * reply to let go. A failed post only means the tabs learn it a little later, from the stopped
 * reply's own end: it never fails the Stop.
 *
 * It goes out after each kept send's own "Queued" forward (BL-203): arriving first, it named a
 * bubble no tab had yet, and the late "Queued" then showed a waiting bubble for a send the Stop
 * had kept. Each forward has its own time limit and never rejects, and so does this post.
 */
async function announceKeptQueuedSends(
  request: Request,
  sessionId: string,
  userMessageIds: string[],
  queuedBubbles: Promise<unknown>[]
) {
  if (userMessageIds.length === 0) return
  await Promise.allSettled(queuedBubbles)
  try {
    await fetch(new URL('/api/sse', request.url).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-sse-forward': '1',
        ...internalServiceHeaders()
      },
      body: JSON.stringify({ type: 'queued_send_dropped', sessionId, userMessageIds, reason: 'stopped' }),
      // The page waits for this route's answer before it clears its Stop state, so this post has
      // the same time limit as a queued send's own forwards (BL-204).
      signal: AbortSignal.timeout(QUEUED_SEND_FORWARD_LIMIT_MS)
    })
  } catch (error) {
    console.warn('[BL-4] Could not tell the tabs that the waiting sends were stopped:', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  // SA-113 AMD-113-02 — Batshit itself calls this route.
  //
  // `endWokenTurn` posts here with `internalServiceHeaders()` when a wake-up hits its hard
  // time limit, and this handler used to accept a session COOKIE only. A server-to-server
  // fetch carries no cookie, so that call answered 401 every time; `fetch` does not throw
  // on 4xx and the status was never read, so the whole second half of the documented
  // Stop/timeout sequence was a silent no-op. The service-token lane is the same one
  // `/api/sse` POST and `send-routed` already accept.
  const internal = isTrustedInternalRequest(request)
  if (!internal && !locals.user?.id) {
    return apiFailure('Unauthorized', 401)
  }

  const body = await request.json().catch(() => ({}))
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const requestedMessageId =
    typeof body?.messageId === 'string' ? body.messageId.trim() : null

  if (!sessionId) {
    return json({ success: false, error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  // The internal caller names the session it just started, so ownership is checked against
  // the session's own user rather than a browser identity it does not have.
  if (!session || (!internal && session.user_id !== locals.user?.id)) {
    return json({ success: false, error: 'Session not found or unauthorized' }, { status: 404 })
  }

  // SA-113 P1 / AMD-113-02 — a woken turn's Stop has to abort the request Batshit itself
  // made, BEFORE the registries are inspected. During a woken turn's setup there is no
  // stream controller to abort, so without this the branch below would answer
  // `stale_turn_cleared` and the run would carry on to a full answer. Aborting the
  // request makes SvelteKit fire `request.signal` inside send-routed, which is the one
  // signal that reaches a turn still in setup. No-op for ordinary browser turns.
  const abortedWokenTurn = abortWokenTurnForInterrupt(sessionId)

  // BL-4: the chat's own Stop stops everything, a waiting message included (AMD-119-04). Every
  // send waiting in the chat's line is kept, BEFORE the running turn is touched, so the lock it
  // lets go of is handed on only to kept sends: each moves its saved message to the end of the
  // chat, unanswered, in the order it was sent (`queuedSendKeeper.ts`). Never deleted. Only that
  // Stop says so (`stopsWaitingSends`): a woken turn's time limit (Batshit's own call) and the DM
  // drawer's Stop of a woken run end that run, and the sends waiting behind it then run.
  const stopsWaitingSends = !internal && body?.stopsWaitingSends === true
  const keptQueuedSendIds = stopsWaitingSends ? keepQueuedSessionTurns(sessionId, 'stopped') : []
  // Beside the keep, while every kept send is still in the line (a handover takes it out).
  const keptQueuedBubbles = queuedSendNotices(sessionId, keptQueuedSendIds)
  const keptQueuedSends = keptQueuedSendIds.length
  const answer = async (body: Record<string, unknown>) => {
    await announceKeptQueuedSends(request, sessionId, keptQueuedSendIds, keptQueuedBubbles)
    return json({ ...body, keptQueuedSends })
  }

  const active = getActiveStream(sessionId)
  const activeGroup = getActiveGroupAbort(sessionId)
  const activeSessionTurn = getActiveSessionTurn(sessionId)
  if (!active && !activeGroup && !activeSessionTurn) {
    return answer({
      success: abortedWokenTurn || keptQueuedSends > 0,
      reason: abortedWokenTurn ? 'wake_run_aborted' : 'no_active_stream',
      abortedWokenTurn
    })
  }

  if (!active && !activeGroup && activeSessionTurn) {
    // A turn still SETTING UP (its compile, snapshot, and bridge run before anything is
    // registered to abort) is stopped through the turn itself: send-routed carries this into
    // the run, and the setup checkpoint ends it before the provider call. Clearing its lock, as
    // this branch used to, deleted a LIVE lock and the reply ran on to a full answer (measured
    // in a real page, Stop 150 ms after the send, 2026-09-18). The request lets go of its own
    // lock when it is done; a stuck one loses it 5 s after this Stop (`stopSessionTurn`).
    if (!activeSessionTurn.runEnded) {
      stopSessionTurn(sessionId, 'user')
      return answer({
        success: true,
        reason: abortedWokenTurn ? 'wake_run_aborted' : 'setup_stopped',
        abortedWokenTurn,
        messageId: requestedMessageId,
        requestedMessageId,
        activeMessageId: activeSessionTurn.messageId ?? null,
        activeTurnKind: activeSessionTurn.kind
      })
    }
    // The reply is over (its request is doing its after-reply work) or its request is stuck.
    clearSessionTurn(sessionId, requestedMessageId)
    return answer({
      success: true,
      reason: abortedWokenTurn ? 'wake_run_aborted' : 'stale_turn_cleared',
      abortedWokenTurn,
      messageId: requestedMessageId,
      requestedMessageId,
      activeMessageId: activeSessionTurn.messageId ?? null,
      activeTurnKind: activeSessionTurn.kind
    })
  }

  const aborted = abortStream(sessionId, 'user')
  const abortedGroup = abortGroupChat(sessionId, 'user')

  return answer({
    success: aborted.ok || abortedGroup.ok || abortedWokenTurn,
    reason: aborted.ok || abortedGroup.ok ? 'aborted' : abortedWokenTurn ? 'wake_run_aborted' : 'no_active_stream',
    abortedWokenTurn,
    messageId: aborted.messageId ?? active?.messageId ?? requestedMessageId,
    requestedMessageId,
    activeMessageId: active?.messageId ?? null,
    activeTurnKind: activeSessionTurn?.kind ?? null
  })
}

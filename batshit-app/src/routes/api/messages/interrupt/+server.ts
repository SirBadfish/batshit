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
  getActiveStream
} from '$lib/server/services/streamAbortRegistry'
import { abortWokenTurnForInterrupt } from '$lib/server/services/agentWakeups'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
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
  if (!session || session.user_id !== locals.user.id) {
    return json({ success: false, error: 'Session not found or unauthorized' }, { status: 404 })
  }

  // SA-113 P1 / AMD-113-02 — a woken turn's Stop has to abort the request Batshit itself
  // made, BEFORE the registries are inspected. During a woken turn's setup there is no
  // stream controller to abort, so without this the branch below would answer
  // `stale_turn_cleared` and the run would carry on to a full answer. Aborting the
  // request makes SvelteKit fire `request.signal` inside send-routed, which is the one
  // signal that reaches a turn still in setup. No-op for ordinary browser turns.
  const abortedWokenTurn = abortWokenTurnForInterrupt(sessionId)

  const active = getActiveStream(sessionId)
  const activeGroup = getActiveGroupAbort(sessionId)
  const activeSessionTurn = getActiveSessionTurn(sessionId)
  if (!active && !activeGroup && !activeSessionTurn) {
    return json({
      success: abortedWokenTurn,
      reason: abortedWokenTurn ? 'wake_run_aborted' : 'no_active_stream',
      abortedWokenTurn
    })
  }

  if (!active && !activeGroup && activeSessionTurn) {
    clearSessionTurn(sessionId, requestedMessageId)
    return json({
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

  return json({
    success: aborted.ok || abortedGroup.ok || abortedWokenTurn,
    abortedWokenTurn,
    messageId: aborted.messageId ?? active?.messageId ?? requestedMessageId,
    requestedMessageId,
    activeMessageId: active?.messageId ?? null,
    activeTurnKind: activeSessionTurn?.kind ?? null
  })
}

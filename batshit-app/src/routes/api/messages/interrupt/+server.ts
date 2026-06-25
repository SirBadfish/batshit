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

  const active = getActiveStream(sessionId)
  const activeGroup = getActiveGroupAbort(sessionId)
  const activeSessionTurn = getActiveSessionTurn(sessionId)
  if (!active && !activeGroup && !activeSessionTurn) {
    return json({ success: false, reason: 'no_active_stream' })
  }

  if (!active && !activeGroup && activeSessionTurn) {
    clearSessionTurn(sessionId, requestedMessageId)
    return json({
      success: true,
      reason: 'stale_turn_cleared',
      messageId: requestedMessageId,
      requestedMessageId,
      activeMessageId: activeSessionTurn.messageId ?? null,
      activeTurnKind: activeSessionTurn.kind
    })
  }

  const aborted = abortStream(sessionId, 'user')
  const abortedGroup = abortGroupChat(sessionId, 'user')

  return json({
    success: aborted.ok || abortedGroup.ok,
    messageId: aborted.messageId ?? active?.messageId ?? requestedMessageId,
    requestedMessageId,
    activeMessageId: active?.messageId ?? null,
    activeTurnKind: activeSessionTurn?.kind ?? null
  })
}

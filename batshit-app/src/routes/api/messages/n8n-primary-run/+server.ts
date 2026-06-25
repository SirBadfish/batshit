import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import {
  clearN8nPrimaryRun,
  getActiveN8nPrimaryRun,
  registerN8nPrimaryRun
} from '$lib/server/services/streamAbortRegistry'

const N8N_PRIMARY_BUSY_MESSAGE =
  'n8n Primary Agent chats need to run by themselves right now. Stop or finish the active chat first, then send this n8n message.'

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return apiFailure('Unauthorized', 401)
  }

  const body = await request.json().catch(() => ({}))
  const action = typeof body?.action === 'string' ? body.action.trim() : 'register'
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const messageId =
    typeof body?.messageId === 'string' && body.messageId.trim().length > 0
      ? body.messageId.trim()
      : null
  const agentId =
    typeof body?.agentId === 'string' && body.agentId.trim().length > 0
      ? body.agentId.trim()
      : null

  if (!sessionId) {
    return json({ success: false, error: 'Session ID is required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ success: false, error: 'Session not found or unauthorized' }, { status: 404 })
  }

  if (action === 'clear') {
    clearN8nPrimaryRun(userId, sessionId)
    return json({ success: true })
  }

  if (action === 'status') {
    return json({
      success: true,
      activeRun: getActiveN8nPrimaryRun(userId)
    })
  }

  const registered = registerN8nPrimaryRun({
    userId,
    sessionId,
    messageId,
    agentId
  })

  if (!registered.ok) {
    return json(
      {
        success: false,
        error: 'An n8n agent is already running in another chat.',
        details: N8N_PRIMARY_BUSY_MESSAGE,
        code: 'n8n_primary_in_progress',
        activeRun: registered.existing
      },
      { status: 409 }
    )
  }

  return json({ success: true, activeRun: registered.entry })
}

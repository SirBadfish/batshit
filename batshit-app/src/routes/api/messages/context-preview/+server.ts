import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  estimateCurrentContextTokens,
  resolveContextPreviewMessages
} from '$lib/server/services/contextTokenPreview'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

export const POST: RequestHandler = async ({ request, locals, fetch: eventFetch }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const body = await request.json()
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''

    if (!sessionId || !agentId) {
      return json({ error: 'Session ID and agent ID are required' }, { status: 400 })
    }

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    const agent = await redis.get(`agent:${agentId}`) as Record<string, any> | null
    if (!agent || agent.user_id !== user.value.id) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    const messages = await resolveContextPreviewMessages({
      sessionId,
      providedMessages: body?.messages,
      useStoredMessages: body?.useStoredMessages === true
    })
    const estimate = await estimateCurrentContextTokens({
      sessionId,
      messages,
      agent,
      userId: user.value.id,
      agentTypeHint: typeof body?.agentType === 'string' ? body.agentType : undefined,
      trimmedMessageIds: Array.isArray(body?.trimmedMessageIds) ? body.trimmedMessageIds : [],
      eventFetch
    })

    return json({
      tokens: estimate.tokens,
      budget: estimate.budget,
      wrapperOverheadTokens: estimate.wrapperOverheadTokens,
      trimmedMessageCount: estimate.trimmedMessageCount
    })
  } catch (error) {
    console.error('[context-preview] Failed to build context preview:', error)
    return json({ error: 'Failed to build context preview' }, { status: 500 })
  }
}

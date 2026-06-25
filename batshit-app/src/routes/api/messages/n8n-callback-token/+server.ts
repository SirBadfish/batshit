import { json, type RequestHandler } from '@sveltejs/kit'

import { requireOwnedSession } from '$lib/server/services/routeSecurity'
import {
  createN8nSseCallbackToken,
  N8N_SSE_CALLBACK_TOKEN_HEADER,
} from '$lib/server/services/n8nCallbackTokens'

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(
      { error: 'n8n callback token payload must be an object.' },
      { status: 400 },
    )
  }

  const sessionId =
    typeof (body as Record<string, unknown>).sessionId === 'string'
      ? String((body as Record<string, unknown>).sessionId).trim()
      : ''
  const messageId =
    typeof (body as Record<string, unknown>).messageId === 'string'
      ? String((body as Record<string, unknown>).messageId).trim()
      : ''
  const agentId =
    typeof (body as Record<string, unknown>).agentId === 'string'
      ? String((body as Record<string, unknown>).agentId).trim()
      : ''
  const projectPath =
    typeof (body as Record<string, unknown>).projectPath === 'string'
      ? String((body as Record<string, unknown>).projectPath).trim()
      : ''

  if (!messageId) {
    return json({ error: 'Message ID is required.' }, { status: 400 })
  }

  const sessionCheck = await requireOwnedSession(sessionId, userId)
  if (!sessionCheck.ok) return sessionCheck.response

  const callback = await createN8nSseCallbackToken({
    sessionId,
    messageId,
    userId,
    agentId,
    projectPath,
  })

  return json({
    callbackToken: callback.token,
    expiresAt: callback.expiresAt,
    headerName: N8N_SSE_CALLBACK_TOKEN_HEADER,
  })
}

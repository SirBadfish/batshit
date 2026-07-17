import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  getInternalBatshitServerUrl,
  getInternalBatshitServerAuthHeaders,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'

const AVATAR_ENTITY_TYPES = new Set(['user', 'group', 'agent', 'subagent'])

// POST /api/uploads/avatar — session-authed proxy for browser avatar uploads
// (user, group, and agent settings panels). batshit-server's upload routes are
// service-token-gated, so the browser can no longer call them directly.
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let incoming: FormData
  try {
    incoming = await request.formData()
  } catch {
    return json({ error: 'Expected multipart form data' }, { status: 400 })
  }

  const entityType = incoming.get('entityType')
  if (typeof entityType !== 'string' || !AVATAR_ENTITY_TYPES.has(entityType)) {
    return json({ error: 'Unsupported avatar entityType' }, { status: 400 })
  }

  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/avatar`, {
    method: 'POST',
    headers: getInternalBatshitServerAuthHeaders(),
    body: incoming
  })

  const payloadText = await response.text()
  try {
    return json(resolveUploadUrlsForBrowserInPayload(JSON.parse(payloadText)), {
      status: response.status
    })
  } catch {
    // Preserve non-JSON batshit-server errors exactly for troubleshooting.
  }

  return new Response(payloadText, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' }
  })
}

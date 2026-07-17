import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  getInternalBatshitServerUrl,
  getInternalBatshitServerAuthHeaders,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'

// POST /api/uploads/clips — session-authed proxy for browser clip uploads.
// batshit-server's upload routes are service-token-gated; the proxy attaches
// the token and asserts the upload owner from the authenticated session
// instead of trusting a client-supplied userId (G-0238).
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let incoming: FormData
  try {
    incoming = await request.formData()
  } catch {
    return json({ error: 'Expected multipart form data' }, { status: 400 })
  }

  const outgoing = new FormData()
  for (const [key, value] of incoming.entries()) {
    if (key === 'userId') continue
    outgoing.append(key, value)
  }
  outgoing.append('userId', user.value.id)

  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload`, {
    method: 'POST',
    headers: getInternalBatshitServerAuthHeaders(),
    body: outgoing
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

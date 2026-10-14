/**
 * BL-622 (rule C7): Stop stops what runs. While a Compact runs in a chat, the chat's Stop button
 * ends the Compact through this route, never through the reply's Stop.
 *
 * The Compact's own request cannot be ended from the browser (SvelteKit's request signal fires only
 * before the body is read), so each running Compact is registered in `compactRunRegistry.ts`, and
 * this route aborts the chat's Compacts there. Their summary call ends, and the Compact route
 * writes nothing and answers `ended_early` with `reason: 'stopped'`. Only the owner of the chat
 * may stop its Compact, and only that chat's Compact stops.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { stopCompactRuns } from '$lib/server/services/compactRunRegistry'

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { sessionId?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!sessionId) return json({ error: 'sessionId is required' }, { status: 400 })

  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response

  return json({ success: true, stopped: stopCompactRuns(sessionId, 'stopped') })
}

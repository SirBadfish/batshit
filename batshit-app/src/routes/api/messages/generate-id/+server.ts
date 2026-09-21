import { json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { isSessionDeleting } from '$lib/server/services/streamAbortRegistry'
import { generateMessageId } from '$lib/utils/messageId'

/**
 * POST /api/messages/generate-id - Generate a new message ID
 * Used by frontend to create user message IDs before sending
 *
 * Only for the caller's own chat, and not while it is being deleted (bug sweep #20,
 * 2026-09-18). An id bumps `message_counter:{sessionId}`, and `INCR` creates that key for any
 * string: a send into a deleted chat put the counter back after the delete had swept it, where
 * nothing sweeps it again, and a caller could bump another user's counter. A chat being deleted
 * is refused the way `POST /api/messages` refuses it, so no id is handed out during the sweep.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const { sessionId } = await request.json()

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    const ownedSessionId = String(sessionId).trim()
    if (isSessionDeleting(ownedSessionId)) {
      return apiError('Session not found', 404)
    }

    const messageId = await generateMessageId(ownedSessionId)

    if (!messageId) {
      return json({ error: 'Failed to generate message ID' }, { status: 500 })
    }

    return json({ id: messageId })
  } catch (error) {
    console.error('Error generating message ID:', error)
    return json({ error: 'Failed to generate message ID' }, { status: 500 })
  }
}

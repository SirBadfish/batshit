import { json, type RequestHandler } from '@sveltejs/kit'
import { generateMessageId } from '$lib/utils/messageId'

/**
 * POST /api/messages/generate-id - Generate a new message ID
 * Used by frontend to create user message IDs before sending
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { sessionId } = await request.json()

    if (!sessionId) {
      return json({ error: 'sessionId is required' }, { status: 400 })
    }

    const messageId = await generateMessageId(sessionId)

    if (!messageId) {
      return json({ error: 'Failed to generate message ID' }, { status: 500 })
    }

    return json({ id: messageId })
  } catch (error) {
    console.error('Error generating message ID:', error)
    return json({ error: 'Failed to generate message ID' }, { status: 500 })
  }
}

import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

// PUT /api/messages/[sessionId]/[messageId] - Update a message
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const updates = await request.json()
    await redis.updateMessage(params.messageId!, params.sessionId!, updates, locals.user.id)
    return json({ success: true })
  } catch (error) {
    console.error('Error updating message:', error)
    return json({ error: error instanceof Error ? error.message : 'Failed to update message' }, { status: 500 })
  }
}

// DELETE /api/messages/[sessionId]/[messageId] - Delete a message
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    await redis.deleteMessage(params.messageId!, params.sessionId!, locals.user.id)
    return json({ success: true })
  } catch (error) {
    console.error('Error deleting message:', error)
    return json({ error: error instanceof Error ? error.message : 'Failed to delete message' }, { status: 500 })
  }
}
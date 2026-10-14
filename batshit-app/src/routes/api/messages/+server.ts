import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { isSessionDeleting } from '$lib/server/services/streamAbortRegistry'
import { generateMessageId } from '$lib/utils/messageId'
import { isUserMessageRecord, preserveServerSteerMetadata, replySavedByServerResponse } from '$lib/server/replySavedByServer'
import { BrowserMessageMutationError } from '$lib/server/browserMessageMutation'

// POST /api/messages - Create a new message
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const messageData = await request.json()

    // A chat being deleted takes no more messages: a save that landed while the delete sweeps
    // would put the message and its list entry back after the sweep passed them
    // (`sessionDeleteTurnStop.ts`, 2026-09-18).
    if (isSessionDeleting(messageData.session_id)) {
      return json({ error: 'Session not found' }, { status: 404 })
    }

    // Verify session belongs to user
    const session = await redis.get(`session:${messageData.session_id}`)
    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    
    if (session.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }
    
    // BL-775, BL-776: a tab saves only the user's own messages (an allow-list). The server owns
    // every other message: an agent's reply (send-routed's finalize saves it whole, from the
    // stream's record; a tab's copy could be shorter or stale), a summary, a note. A save may not
    // replace a stored message of another role either, whatever role it claims.
    if (!isUserMessageRecord(messageData)) {
      return replySavedByServerResponse()
    }
    let stored: any = null
    if (messageData.id) {
      stored = await redis.execute((client: any) => client.json.get(`message:${messageData.session_id}:${messageData.id}`))
      if (stored && !isUserMessageRecord(stored)) return replySavedByServerResponse()
      if (stored && (stored.id !== messageData.id || stored.session_id !== messageData.session_id ||
        stored.user_id !== locals.user.id)) return json({ error: 'Unauthorized' }, { status: 403 })
    }
    messageData.metadata = preserveServerSteerMetadata(messageData.metadata, stored?.metadata)

    // Generate message ID if not provided
    if (!messageData.id) {
      messageData.id = await generateMessageId(messageData.session_id)
      if (!messageData.id) {
        return json({ error: 'Failed to generate message ID' }, { status: 500 })
      }
    }

    messageData.user_id = locals.user.id
    await redis.saveMessage(messageData, { browserMutation: {
      sessionId: messageData.session_id, messageId: messageData.id,
      userId: locals.user.id, expectedExists: Boolean(stored)
    } })
    return json({ success: true, id: messageData.id })
  } catch (error) {
    if (error instanceof BrowserMessageMutationError) return json({ error: error.message, code: error.code }, { status: error.status })
    console.error('Error saving message:', error)
    return json({ error: 'Failed to save message' }, { status: 500 })
  }
}

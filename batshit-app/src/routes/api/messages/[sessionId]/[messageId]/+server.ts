import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { isMessageOfRunningRequest } from '$lib/server/services/streamAbortRegistry'
import {
  MESSAGE_STILL_RUNNING_CODE,
  MESSAGE_STILL_RUNNING_TEXT,
  MessageStillRunningError
} from '$lib/server/messageStillRunningError'
import { isUserMessageRecord, preserveServerSteerMetadata, replySavedByServerResponse } from '$lib/server/replySavedByServer'
import { BrowserMessageMutationError } from '$lib/server/browserMessageMutation'
import { noteMessageDeleted } from '$lib/server/services/deletedMessageRegistry'

// PUT /api/messages/[sessionId]/[messageId] - Update a message
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const updates = await request.json()
    // BL-775, BL-776: the server owns an agent's reply, so a tab can neither rewrite one nor
    // turn another message into one. The chat is checked first, so another user's chat learns
    // nothing about its messages.
    const session = await redis.get(`session:${params.sessionId}`)
    if (!session) return json({ error: 'Session not found' }, { status: 404 })
    if (session.user_id !== locals.user.id) return json({ error: 'Unauthorized' }, { status: 403 })
    const stored: any = await redis.execute((client: any) => client.json.get(`message:${params.sessionId}:${params.messageId}`))
    if (!stored || typeof stored !== 'object') return json({ error: 'Message not found' }, { status: 404 })
    if (!isUserMessageRecord(stored) || (Object.prototype.hasOwnProperty.call(updates, 'role') && !isUserMessageRecord(updates))) {
      return replySavedByServerResponse()
    }
    if (stored.id !== params.messageId || stored.session_id !== params.sessionId ||
      stored.user_id !== locals.user.id) return json({ error: 'Unauthorized' }, { status: 403 })
    if (Object.prototype.hasOwnProperty.call(updates, 'metadata')) {
      updates.metadata = preserveServerSteerMetadata(updates.metadata, stored.metadata)
    }
    await redis.updateMessage(params.messageId!, params.sessionId!, updates, locals.user.id, { browserMutation: {
      sessionId: params.sessionId!, messageId: params.messageId!, userId: locals.user.id, expectedExists: true
    } })
    return json({ success: true })
  } catch (error) {
    if (error instanceof BrowserMessageMutationError) return json({ error: error.message, code: error.code }, { status: error.status })
    console.error('Error updating message:', error)
    return json({ error: error instanceof Error ? error.message : 'Failed to update message' }, { status: 500 })
  }
}

// DELETE /api/messages/[sessionId]/[messageId] - Delete a message
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  // BL-381: a reply its request is still writing cannot be deleted. The next chunk re-created
  // it in the tab and the finalize saved it back onto the chat's list, so "Message deleted"
  // was untrue. The page offers no Delete on a reply in progress; this covers every other tab.
  // `redis.deleteMessage` asks again inside the chat's zip state lock, right before its write,
  // so a turn that starts on this message in between is refused the same way.
  const stillRunning = () => isMessageOfRunningRequest(params.sessionId!, params.messageId!)
  const stillRunningResponse = () =>
    json({ error: MESSAGE_STILL_RUNNING_TEXT, code: MESSAGE_STILL_RUNNING_CODE }, { status: 409 })
  if (stillRunning()) return stillRunningResponse()

  try {
    await redis.deleteMessage(params.messageId!, params.sessionId!, locals.user.id, { stillRunning })
    // BL-776: a late server save of this id (a realtime voice transcript) must not bring it back.
    noteMessageDeleted(params.sessionId!, params.messageId!)
    // Another tab showing this chat has no other way to hear that the message is gone.
    // The chat page's old ten-times-a-second refetch used to cover it (2026-09-18).
    await publishUserEvent(locals.user.id, {
      type: 'session_messages_changed',
      sessionId: params.sessionId!,
      reason: 'message_deleted'
    })
    return json({ success: true })
  } catch (error) {
    if (error instanceof MessageStillRunningError) return stillRunningResponse()
    console.error('Error deleting message:', error)
    return json({ error: error instanceof Error ? error.message : 'Failed to delete message' }, { status: 500 })
  }
}

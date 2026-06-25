import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { generateMessageId } from '$lib/utils/messageId'

// POST /api/messages - Create a new message
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const messageData = await request.json()
    
    // Verify session belongs to user
    const session = await redis.get(`session:${messageData.session_id}`)
    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    
    if (session.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }
    
    // Generate message ID if not provided
    if (!messageData.id) {
      messageData.id = await generateMessageId(messageData.session_id)
      if (!messageData.id) {
        return json({ error: 'Failed to generate message ID' }, { status: 500 })
      }
    }

    // Guardrail: never persist raw tool payloads in assistant messages.
    // Sometimes intermediateSteps/toolResult blobs get appended to content
    // (e.g., Mode 2 webhook). Strip any trailing segment starting at "toolCallId".
    if (messageData.role === 'assistant' && typeof messageData.content === 'string') {
      const toolIdx = messageData.content.indexOf('"toolCallId"')
      if (toolIdx !== -1) {
        messageData.content = messageData.content.slice(0, toolIdx).trimEnd()
      }
    }
    
    await redis.saveMessage(messageData)
    return json({ success: true, id: messageData.id })
  } catch (error) {
    console.error('Error saving message:', error)
    return json({ error: 'Failed to save message' }, { status: 500 })
  }
}

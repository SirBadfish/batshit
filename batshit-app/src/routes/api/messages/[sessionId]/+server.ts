import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { enrichMessagesWithTrustedZipMetadata } from '$lib/server/services/messageZipTrust'

// GET /api/messages/[sessionId] - Get messages for a session
export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    // Verify session belongs to user
    const session = await redis.get(`session:${params.sessionId}`)
    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    
    if (session.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }
    
    const limit = parseInt(url.searchParams.get('limit') || '100')
    const messages = await redis.getMessages(params.sessionId!, limit)
    const trustedMessages = await enrichMessagesWithTrustedZipMetadata(messages, locals.user.id)
    
    return json(trustedMessages)
  } catch (error) {
    console.error('Error getting messages:', error)
    return json({ error: 'Failed to get messages' }, { status: 500 })
  }
}

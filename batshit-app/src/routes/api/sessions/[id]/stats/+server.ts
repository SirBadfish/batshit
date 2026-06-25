import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

// GET /api/sessions/[id]/stats
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const session = await redis.getSession(params.id!)

    // Verify session belongs to user
    if (session?.user_id !== locals.user.id) {
      return json({ error: 'Forbidden' }, { status: 403 })
    }

    // Get message count and calculate stats
    const messages = await redis.getMessages(params.id!)
    const messageCount = messages.length
    const totalTokens = messages.reduce((sum, msg) => sum + ((msg as any).tokens || 0), 0)

    return json({
      messageCount,
      totalTokens,
      createdAt: session.created_at,
      lastActivity: session.last_modified_at || session.created_at
    })
  } catch (error) {
    console.error('Error getting session stats:', error)
    return json(null)
  }
}
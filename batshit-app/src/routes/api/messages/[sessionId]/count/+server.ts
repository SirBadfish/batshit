import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

// GET /api/messages/[sessionId]/count
export const GET: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const sessionCheck = await requireOwnedSession(params.sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response

  try {
    const messages = await redis.getMessages(params.sessionId!)
    return json({ count: messages.length })
  } catch (error) {
    console.error('Error getting message count:', error)
    return json({ count: 0 })
  }
}

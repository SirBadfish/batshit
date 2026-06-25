import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

// GET /api/session-clips/state/{sessionId} - Get session's clip state
export const GET: RequestHandler = async ({ params, locals }) => {
  try {
    const user = requireUser(locals)
    if (!user.ok) return user.response

    const { sessionId } = params
    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    // Get session clip state from Redis
    const stateKey = `session:${sessionId}:clip_state`
    const stateData = await redis.get(stateKey)

    if (!stateData) {
      // Initialize empty state
      return json({
        sessionId,
        clips: []
      })
    }

    const state = stateData
    return json(state)
  } catch (error) {
    console.error('Error fetching session clip state:', error)
    return json({ error: 'Failed to fetch clip state' }, { status: 500 })
  }
}

// DELETE /api/session-clips/state/{sessionId} - Clear all clips from session
export const DELETE: RequestHandler = async ({ params, locals }) => {
  try {
    const user = requireUser(locals)
    if (!user.ok) return user.response

    const { sessionId } = params
    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    // Clear session clip state
    await redis.del(`session:${sessionId}:clip_state`)
    await redis.del(`session:${sessionId}:active_clips`)

    return json({ success: true })
  } catch (error) {
    console.error('Error clearing session clip state:', error)
    return json({ error: 'Failed to clear clip state' }, { status: 500 })
  }
}

import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { SessionClipRow } from '$lib/types/database'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

// PUT /api/session-clips/[sessionId]/[clipId] - Update clip attachment status
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  try {
    const { sessionId, clipId } = params
    const updates = await request.json()

    const user = requireUser(locals)
    if (!user.ok) return user.response

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    const id = `${sessionId}:${clipId}`
    
    // Get existing session clip
    const existingData = await redis.get(`session_clip:${id}`)
    
    if (!existingData) {
      return json({ error: 'Session clip not found' }, { status: 404 })
    }

    // RedisJSON returns objects directly
    const existingSessionClip = existingData as SessionClipRow
    
    // Update the session clip
    const updatedSessionClip: SessionClipRow = {
      ...existingSessionClip,
      ...updates,
      id, // Ensure ID doesn't change
      session_id: sessionId, // Ensure session ID doesn't change
      clip_id: clipId // Ensure clip ID doesn't change
    }

    // Save updated session clip
    await redis.set(`session_clip:${id}`, updatedSessionClip)
    
    // If unclipping, remove from session's active clips
    if (updates.is_clipped === false) {
      await redis.sRem(`session:${sessionId}:active_clips`, clipId)
    } else if (updates.is_clipped === true) {
      await redis.sAdd(`session:${sessionId}:active_clips`, clipId)
    }

    return json(updatedSessionClip)
  } catch (error) {
    console.error('Error updating session clip:', error)
    return json({ error: 'Failed to update session clip' }, { status: 500 })
  }
}

// DELETE /api/session-clips/[sessionId]/[clipId] - Remove clip from session
export const DELETE: RequestHandler = async ({ params, locals }) => {
  try {
    const { sessionId, clipId } = params

    const user = requireUser(locals)
    if (!user.ok) return user.response

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    const id = `${sessionId}:${clipId}`
    
    // Remove from session's clip set
    await redis.sRem(`session:${sessionId}:clips`, clipId)
    await redis.sRem(`session:${sessionId}:active_clips`, clipId)
    
    // Delete the session-clip relationship
    await redis.del(`session_clip:${id}`)

    return json({ success: true })
  } catch (error) {
    console.error('Error removing clip from session:', error)
    return json({ error: 'Failed to remove clip' }, { status: 500 })
  }
}

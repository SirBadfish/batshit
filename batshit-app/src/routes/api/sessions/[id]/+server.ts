import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

// GET /api/sessions/[id] - Get a specific session
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    // Get user's sessions to verify ownership
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found or unauthorized' }, { status: 404 })
    }
    
    return json(session)
  } catch (error) {
    console.error('Error getting session:', error)
    return json({ error: 'Failed to get session' }, { status: 500 })
  }
}

// PUT /api/sessions/[id] - Update a session
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const updates = await request.json()
    
    // Get user's sessions to verify ownership
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found or unauthorized' }, { status: 404 })
    }
    
    await redis.updateSession(params.id!, updates)
    return json({ success: true })
  } catch (error) {
    console.error('Error updating session:', error)
    return json({ error: 'Failed to update session' }, { status: 500 })
  }
}

// DELETE /api/sessions/[id] - Delete a session
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    // Get user's sessions to verify ownership
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found or unauthorized' }, { status: 404 })
    }

    if (session.locked) {
      return json({ error: 'Session is locked. Unlock it before deleting.' }, { status: 409 })
    }
    
    // Delete the session and all related data
    await redis.deleteSession(params.id!)
    return json({ success: true })
  } catch (error) {
    console.error('Error deleting session:', error)
    return json({ error: 'Failed to delete session' }, { status: 500 })
  }
}

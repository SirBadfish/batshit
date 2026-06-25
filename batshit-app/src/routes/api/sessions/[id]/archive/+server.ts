import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'

// POST /api/sessions/[id]/archive - Archive a session
export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Verify session belongs to user
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    
    await redis.archiveSession(params.id)
    
    return json({ success: true })
  } catch (error) {
    console.error('Failed to archive session:', error)
    return json({ error: 'Failed to archive session' }, { status: 500 })
  }
}

// DELETE /api/sessions/[id]/archive - Unarchive a session
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Verify session belongs to user
    const sessions = await redis.getSessions(locals.user.id, true)
    const session = sessions.find(s => s.id === params.id)
    
    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    
    await redis.unarchiveSession(params.id)
    
    return json({ success: true })
  } catch (error) {
    console.error('Failed to unarchive session:', error)
    return json({ error: 'Failed to unarchive session' }, { status: 500 })
  }
}
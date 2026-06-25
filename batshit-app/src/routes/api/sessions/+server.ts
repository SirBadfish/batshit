import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

// GET /api/sessions - List all sessions for the current user
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  const includeArchived = url.searchParams.get('includeArchived') === 'true'
  
  try {
    const sessions = await redis.getSessions(locals.user.id, includeArchived)
    return json(sessions)
  } catch (error) {
    console.error('Error getting sessions:', error)
    return json({ error: 'Failed to get sessions' }, { status: 500 })
  }
}

// POST /api/sessions - Create a new session
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const body = await request.json()
    
    // Generate session ID if not provided
    const sessionId = body.id || `${new Date().toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: '2-digit'
    }).replace(/\//g, '-')}-${new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).replace(/:/g, '_').replace(/ /g, '-').toLowerCase()}-and-${new Date().getMilliseconds()}S-${new Date().toLocaleTimeString('en-US', { hour12: true }).includes('PM') ? 'pm' : 'am'}`

    const existingSessions = await redis.getSessions(locals.user.id, true)
    if (existingSessions.some((session) => session.id === sessionId)) {
      return json({ error: 'Session ID already exists' }, { status: 409 })
    }
    
    const session = await redis.createSession({
      ...body,
      id: sessionId,
      user_id: locals.user.id
    })
    
    return json(session)
  } catch (error) {
    console.error('Error creating session:', error)
    return json({ error: 'Failed to create session' }, { status: 500 })
  }
}

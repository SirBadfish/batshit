import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'

// POST /api/folders/{id}/sessions - Move session(s) to folder
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.session?.user_id || locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const targetFolderId = params.id
  
  try {
    // Verify target folder exists
    const targetFolder = await redis.getFolder(userId, targetFolderId)
    
    if (!targetFolder) {
      return json({ error: 'Target folder not found' }, { status: 404 })
    }
    
    const { sessionIds } = await request.json()
    
    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      return json({ error: 'Session IDs are required' }, { status: 400 })
    }
    
    const movedSessions = []
    
    for (const sessionId of sessionIds) {
      // Get session data to find current folder
      const sessionData = await redis.getSession(sessionId)
      
      if (!sessionData || sessionData.user_id !== userId) {
        continue // Skip sessions that don't exist or don't belong to user
      }
      
      // Move session to new folder
      const moved = await redis.moveSessionToFolder(
        sessionId, 
        sessionData.folder_id || null, 
        targetFolderId, 
        userId
      )
      
      if (moved) {
        movedSessions.push(sessionId)
      }
    }
    
    return json({ 
      success: true, 
      moved_count: movedSessions.length,
      moved_sessions: movedSessions 
    })
  } catch (error) {
    console.error('Error moving sessions to folder:', error)
    return json({ error: 'Failed to move sessions' }, { status: 500 })
  }
}
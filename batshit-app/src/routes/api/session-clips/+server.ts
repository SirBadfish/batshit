import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { SessionClipRow } from '$lib/types/database'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { normalizeUploadUrlsForStorageInPayload } from '$lib/server/services/batshitServerUrls'

// POST /api/session-clips - Attach a clip to a session
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const data = await request.json()
    const user = requireUser(locals)
    if (!user.ok) return user.response

    const { session_id, clip_id, message_id, is_clipped, clipped_at } = data
    
    if (!session_id || !clip_id) {
      return json({ error: 'Session ID and Clip ID required' }, { status: 400 })
    }

    const sessionCheck = await requireOwnedSession(session_id, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    // Generate ID for the session-clip relationship
    const id = `${session_id}:${clip_id}`
    
    // Create session clip object
    const sessionClip: SessionClipRow = {
      id,
      session_id,
      clip_id,
      is_clipped: is_clipped !== false, // Default to true
      clipped_at: clipped_at || new Date().toISOString(),
      message_id,
      created_at: new Date().toISOString()
    }

    // Store in Redis
    await redis.set(`session_clip:${id}`, sessionClip)
    
    // Add to session's clip set
    await redis.sAdd(`session:${session_id}:clips`, clip_id)
    
    // Update clip's usage tracking
    const clipData = await redis.get(`clip:${user.value.id}:${clip_id}`)
    if (clipData) {
      try {
        // Handle case where clipData might already be an object or a malformed string
        let clip
        if (typeof clipData === 'string' && clipData !== '[object Object]') {
          clip = JSON.parse(clipData)
        } else if (typeof clipData === 'object') {
          clip = clipData
        } else {
          console.warn(`Invalid clip data for ${clip_id}, skipping usage tracking`)
          return json(sessionClip)
        }
        
        const usedInSessions = clip.usedInSessions || []
        if (!usedInSessions.includes(session_id)) {
          usedInSessions.push(session_id)
          clip.usedInSessions = usedInSessions
          clip.lastUsedAt = new Date().toISOString()
          await redis.set(
            `clip:${user.value.id}:${clip_id}`,
            normalizeUploadUrlsForStorageInPayload(clip)
          )
        }
      } catch (parseError) {
        console.error(`Error parsing clip data for ${clip_id}:`, parseError)
        // Continue without updating usage tracking
      }
    }

    return json(sessionClip)
  } catch (error) {
    console.error('Error attaching clip to session:', error)
    return json({ error: 'Failed to attach clip' }, { status: 500 })
  }
}

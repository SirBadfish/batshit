import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { SessionClipRow } from '$lib/types/database'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

// GET /api/session-clips/[sessionId] - Get all clips for a session
export const GET: RequestHandler = async ({ params, url, locals }) => {
  try {
    const sessionId = params.sessionId
    const user = requireUser(locals)
    if (!user.ok) return user.response

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    // Get clip IDs for this session
    const clipIds = await redis.sMembers(`session:${sessionId}:clips`)
    
    if (!clipIds || clipIds.length === 0) {
      return json([])
    }

    // Fetch all session-clip relationships
    const sessionClips: SessionClipRow[] = []
    for (const clipId of clipIds) {
      const sessionClipData = await redis.get(`session_clip:${sessionId}:${clipId}`)
      if (sessionClipData) {
        try {
          // Handle case where data might already be an object or malformed
          let sessionClip: SessionClipRow
          if (typeof sessionClipData === 'string' && sessionClipData !== '[object Object]') {
            sessionClip = JSON.parse(sessionClipData) as SessionClipRow
          } else if (typeof sessionClipData === 'object') {
            sessionClip = sessionClipData as SessionClipRow
          } else {
            console.warn(`Invalid session clip data for ${sessionId}:${clipId}, skipping`)
            continue
          }
          sessionClips.push(sessionClip)
        } catch (error) {
          console.error(`Error parsing session clip ${sessionId}:${clipId}:`, error)
        }
      }
    }

    // Filter to only show currently clipped items if requested
    const onlyClipped = url.searchParams.get('clipped') === 'true'
    if (onlyClipped) {
      return json(sessionClips.filter(sc => sc.is_clipped))
    }

    return json(sessionClips)
  } catch (error) {
    console.error('Error fetching session clips:', error)
    return json({ error: 'Failed to fetch session clips' }, { status: 500 })
  }
}

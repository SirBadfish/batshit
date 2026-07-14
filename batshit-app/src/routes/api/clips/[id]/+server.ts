import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { ClipRow } from '$lib/types/database'
import { deleteUserClip } from '$lib/server/services/clipDeletion'
import { resolveClipPreferredUrl } from '$lib/server/services/clipUploadPayload'
import { logger } from '$lib/utils/logger'
import {
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'

// GET /api/clips/[id] - Get a specific clip
export const GET: RequestHandler = async ({ params, locals, url }) => {
  try {
    const clipId = params.id

    if (!locals.user) {
      return json({ error: 'Not authenticated' }, { status: 401 })
    }

    const userId = locals.user.id

    // Opt-in late tunnel resolution for prompt compilation (G-0063): computes the
    // model-facing URL with the same resolver the server-side compiler uses. Explicit
    // opt-in so ordinary UI clip fetches never auto-start tunnels.
    const resolveModelUrl = url.searchParams.get('resolve_model_url') === '1'
    const withModelUrl = async (clip: ClipRow) => {
      if (!resolveModelUrl) return {}
      const settings = await redis.getUserSettings(userId)
      return {
        modelFacingUrl: await resolveClipPreferredUrl(clip, settings, { allowAutoStart: true })
      }
    }

    // Try user clip first
    const clipKey = `clip:${userId}:${clipId}`
    let clipData = await redis.get(clipKey)

    // Fallback: system clip (for built-in Batshit clips)
    if (!clipData) {
      clipData = await redis.get(`clip:system:${clipId}`)
      if (clipData) {
        const systemClipRow = clipData as ClipRow
        return json(
          resolveUploadUrlsForBrowserInPayload({
            ...systemClipRow,
            systemClip: true,
            ...(await withModelUrl(systemClipRow))
          })
        )
      }
    }

    if (!clipData) {
      return json({ error: 'Clip not found' }, { status: 404 })
    }

    // RedisJSON returns objects directly
    let clip = clipData as ClipRow

    // Decode legacy base64 for text clips so clients get plain content
    const isText = clip.mimeType?.startsWith('text/') || clip.fileType === 'text' || clip.mimeType === 'application/json'
    if (isText && !clip.content && clip.localBase64) {
      const base64Part = clip.localBase64.startsWith('data:')
        ? clip.localBase64.split(',')[1] || ''
        : clip.localBase64
      try {
        const { Buffer } = await import('buffer')
        clip.content = Buffer.from(base64Part, 'base64').toString('utf-8')
        if (!clip.localTokens && clip.content) {
          clip.localTokens = Math.ceil(clip.content.length / 4)
        }
      } catch (err) {
        console.warn('Failed to decode clip content', err)
      }
    }

    return json(
      resolveUploadUrlsForBrowserInPayload({
        ...clip,
        systemClip: false,
        ...(await withModelUrl(clip))
      })
    )
  } catch (error) {
    console.error('Error fetching clip:', error)
    return json(
      {
        error: `Failed to fetch clip: ${error instanceof Error ? error.message : String(error)}`
      },
      { status: 500 }
    )
  }
}

// PUT /api/clips/[id] - Update a clip
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  try {
    const clipId = params.id
    const userId = locals.user?.id
    const updates = await request.json()
    
    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get existing clip
    const existingData = await redis.get(`clip:${userId}:${clipId}`)
    
    if (!existingData) {
      return json({ error: 'Clip not found' }, { status: 404 })
    }

    // RedisJSON returns objects directly
    const existingClip = existingData as ClipRow
    
    // Merge updates with existing data
    const updatedClip: ClipRow = {
      ...existingClip,
      ...updates,
      id: clipId, // Ensure ID doesn't change
      user_id: userId, // Ensure user ID doesn't change
      updated_at: new Date().toISOString()
    }

    // Save updated clip using RedisJSON (the set method will handle it)
    const storageClip = normalizeUploadUrlsForStorageInPayload(updatedClip)
    await redis.set(`clip:${userId}:${clipId}`, storageClip)

    return json(resolveUploadUrlsForBrowserInPayload(storageClip))
  } catch (error) {
    console.error('Error updating clip:', error)
    return json({ error: 'Failed to update clip' }, { status: 500 })
  }
}

// DELETE /api/clips/[id] - Delete a clip
export const DELETE: RequestHandler = async ({ params, locals }) => {
  try {
    const clipId = params.id
    const userId = locals.user?.id
    
    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }

    const result = await deleteUserClip(userId, clipId)
    logger.debug(`Successfully deleted clip ${clipId} and associated upload files`)
    return json({ success: true, result })
  } catch (error) {
    console.error('Error deleting clip:', error)
    return json({ error: 'Failed to delete clip' }, { status: 500 })
  }
}

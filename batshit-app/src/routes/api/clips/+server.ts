import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { ClipRow } from '$lib/types/database'
import { requireUser } from '$lib/server/services/routeSecurity'
import { deleteUserClips } from '$lib/server/services/clipDeletion'
import {
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'

// GET /api/clips - Get all clips for a user
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const userId = user.value.id

    // Get user's clip IDs
    const userClipIds = await redis.sMembers(`user:${userId}:clips`)
    const systemClipIds = await redis.sMembers(`user:system:clips`)

    // Fetch all clips (user + system)
    const clips: (ClipRow & { systemClip?: boolean })[] = []

    for (const clipId of userClipIds) {
      const clipData = await redis.get(`clip:${userId}:${clipId}`)
      if (clipData) {
        clips.push({ ...(clipData as ClipRow), systemClip: false })
      }
    }

    for (const clipId of systemClipIds) {
      const clipData = await redis.get(`clip:system:${clipId}`)
      if (clipData) {
        clips.push({ ...(clipData as ClipRow), systemClip: true })
      }
    }

    // Sort by created_at descending (newest first)
    clips.sort((a, b) => {
      const dateA = new Date(a.created_at).getTime()
      const dateB = new Date(b.created_at).getTime()
      return dateB - dateA
    })

    return json(resolveUploadUrlsForBrowserInPayload(clips))
  } catch (error) {
    console.error('Error fetching clips:', error)
    return json({ error: 'Failed to fetch clips' }, { status: 500 })
  }
}

// POST /api/clips - Create a new clip
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const data = await request.json()
    const userId = user.value.id

    // Generate clip ID if not provided
    const clipId = data.id || `clip_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    
    // Create clip object
    const clip: ClipRow = {
      id: clipId,
      user_id: userId,
      filename: data.filename,
      fileType: data.fileType,
      mimeType: data.mimeType,
      content: data.content,
      externalUrl: data.externalUrl,
      displayUrl: data.displayUrl, // Add displayUrl for frontend rendering
      localUrl: data.localUrl,
      tunnelPath: data.tunnelPath,
      externalTokens: data.externalTokens,
      localTokens: data.localTokens,
      storageMode: data.storageMode || 'local',
      localBase64: data.localBase64,
      fileSize: data.fileSize,
      uploadSettings: data.uploadSettings,
      usedInSessions: data.usedInSessions || [],
      lastUsedAt: data.lastUsedAt,
      thumbnailUrl: data.thumbnailUrl,
      description: data.description,
      tags: data.tags || [],
      created_at: data.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    // Store clip in Redis using RedisJSON
    const storageClip = normalizeUploadUrlsForStorageInPayload(clip)
    await redis.set(`clip:${userId}:${clipId}`, storageClip)
    
    // Add to user's clip set
    await redis.sAdd(`user:${userId}:clips`, clipId)

    return json(resolveUploadUrlsForBrowserInPayload(storageClip))
  } catch (error) {
    console.error('Error creating clip:', error)
    return json({ error: 'Failed to create clip' }, { status: 500 })
  }
}

// DELETE /api/clips - Bulk delete user clips
export const DELETE: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const body = (await request.json().catch(() => ({}))) as { clipIds?: unknown }
    const clipIds = Array.isArray(body.clipIds)
      ? body.clipIds
          .map((clipId) => (typeof clipId === 'string' ? clipId.trim() : ''))
          .filter(Boolean)
      : []

    if (clipIds.length === 0) {
      return json({ error: 'No clip IDs provided' }, { status: 400 })
    }

    if (clipIds.length > 200) {
      return json({ error: 'Too many clips requested; maximum is 200' }, { status: 400 })
    }

    const results = await deleteUserClips(user.value.id, clipIds)
    return json({
      success: true,
      deleted: results.filter((result) => result.deleted).length,
      missing: results.filter((result) => result.missing).map((result) => result.clipId),
      results
    })
  } catch (error) {
    console.error('Error bulk deleting clips:', error)
    return json({ error: 'Failed to delete clips' }, { status: 500 })
  }
}

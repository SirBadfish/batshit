import { redis } from '$lib/server/redis'
import type { ClipRow } from '$lib/types/database'
import {
  detachSessionClip,
  listActiveClipIds,
  normalizeSessionClipState
} from '$lib/server/services/sessionClipState'
import { resolveClipUploadLocator } from '$lib/server/services/clipUploadPayload'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl
} from '$lib/server/services/batshitServerUrls'

export interface ClipDeletionResult {
  clipId: string
  deleted: boolean
  missing: boolean
}

async function deleteUploadReferences(clip: ClipRow) {
  const locator = resolveClipUploadLocator(clip)
  if (locator) {
    await deleteUploadAsset(locator.uploadType, locator.filename)
    return
  }

  // Legacy clips can predate persisted /uploads/{type}/{filename} URLs.
  if (clip.filename) {
    await deleteUploadAsset('images', clip.filename)
    await deleteUploadAsset('documents', clip.filename)
  }
}

async function deleteUploadAsset(uploadType: string, filename: string) {
  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/asset`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
    body: JSON.stringify({ uploadType, filename })
  })
  if (response.ok) return

  const details = (await response.text().catch(() => '')).replace(/<[^>]+>/g, ' ').trim()
  throw new Error(
    `Failed to delete clip upload ${uploadType}/${filename}${details ? `: ${details}` : ''}`
  )
}

export async function removeClipFromSessionState(sessionId: string, clipId: string) {
  await redis.sRem(`session:${sessionId}:clips`, clipId)
  await redis.sRem(`session:${sessionId}:active_clips`, clipId)
  await redis.del(`session_clip:${sessionId}:${clipId}`)

  const stateKey = `session:${sessionId}:clip_state`
  const existingState = await redis.get(stateKey)
  if (!existingState) return

  const state = normalizeSessionClipState(sessionId, existingState)
  if (!state.clips.some((entry) => entry.clipId === clipId)) return

  const nextState = detachSessionClip(state, clipId)
  await redis.set(stateKey, nextState)

  const activeKey = `session:${sessionId}:active_clips`
  await redis.del(activeKey)
  for (const activeClipId of listActiveClipIds(nextState)) {
    await redis.sAdd(activeKey, activeClipId)
  }
}

async function removeClipFromAllUserSessions(userId: string, clipId: string) {
  const sessionIds = await redis.sMembers(`user:${userId}:sessions`).catch(() => [])
  await Promise.all(sessionIds.map((sessionId) => removeClipFromSessionState(sessionId, clipId)))
}

export async function deleteUserClip(userId: string, clipId: string): Promise<ClipDeletionResult> {
  const clipData = await redis.get(`clip:${userId}:${clipId}`)
  if (clipData) {
    await deleteUploadReferences(clipData as ClipRow)
  }

  await removeClipFromAllUserSessions(userId, clipId)
  await redis.sRem(`user:${userId}:clips`, clipId)
  await redis.del(`clip:${userId}:${clipId}`)

  return {
    clipId,
    deleted: true,
    missing: !clipData
  }
}

export async function deleteUserClips(userId: string, clipIds: string[]): Promise<ClipDeletionResult[]> {
  const uniqueClipIds = Array.from(new Set(clipIds.map((id) => id.trim()).filter(Boolean)))
  const results: ClipDeletionResult[] = []

  for (const clipId of uniqueClipIds) {
    results.push(await deleteUserClip(userId, clipId))
  }

  return results
}

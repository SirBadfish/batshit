import type { ClipRow } from '$lib/types/database'
import { redis } from '$lib/server/redis'

function decodeBase64Text(value: string): string {
  const raw = value.startsWith('data:') ? value.split(',', 2)[1] ?? '' : value
  return Buffer.from(raw, 'base64').toString('utf8')
}

async function ensureTextContent(
  clip: ClipRow,
  redisKey: string
): Promise<ClipRow> {
  const isText =
    clip.mimeType?.startsWith('text/') ||
    clip.fileType === 'text' ||
    clip.mimeType === 'application/json'
  if (!isText || clip.content || !clip.localBase64) return clip

  const content = decodeBase64Text(clip.localBase64)
  const updated: ClipRow = {
    ...clip,
    content,
    localTokens: clip.localTokens ?? Math.ceil(content.length / 4)
  }
  await redis.set(redisKey, updated)
  return updated
}

/**
 * Server-owned Clip reader shared by chat compilation and memory-media copying.
 * User scope wins; packaged system Clips remain the explicit fallback.
 */
export async function loadClipRow(userId: string | undefined, clipId: string): Promise<ClipRow | null> {
  const normalizedId = clipId.trim()
  if (!normalizedId) return null

  const keys = [
    ...(userId?.trim() ? [`clip:${userId.trim()}:${normalizedId}`] : []),
    `clip:system:${normalizedId}`
  ]
  for (const key of keys) {
    const stored = await redis.get(key)
    if (!stored || typeof stored !== 'object') continue
    const clip = await ensureTextContent(stored as ClipRow, key)
    return key.startsWith('clip:system:') ? ({ ...clip, systemClip: true } as ClipRow) : clip
  }
  return null
}

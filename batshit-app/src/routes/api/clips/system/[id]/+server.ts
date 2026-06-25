import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { ClipRow } from '$lib/types/database'
import { requireAdmin } from '$lib/server/services/routeSecurity'
import { Buffer } from 'buffer'

// Admin-only endpoint to update system clips (clip:system:<id>)
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  const clipId = params.id
  const body = await request.json()

  const key = `clip:system:${clipId}`
  const existing = (await redis.get(key)) as ClipRow | null

  const filename = body?.filename ?? existing?.filename
  if (!filename) {
    return json({ error: 'Filename required' }, { status: 400 })
  }

  const description = body?.description ?? existing?.description ?? ''
  const content = typeof body?.content === 'string' ? body.content : existing?.content ?? ''
  const now = new Date().toISOString()
  const encoded = Buffer.from(content, 'utf-8').toString('base64')

  const updated: ClipRow = {
    id: clipId,
    user_id: 'system',
    filename,
    description,
    fileType: body?.fileType ?? existing?.fileType ?? 'text',
    mimeType: body?.mimeType ?? existing?.mimeType ?? 'text/markdown',
    content,
    storageMode: 'local',
    localBase64: encoded,
    localTokens: Math.ceil(content.length / 4),
    externalUrl: existing?.externalUrl,
    displayUrl: existing?.displayUrl,
    localUrl: existing?.localUrl,
    externalTokens: existing?.externalTokens,
    tags: Array.isArray(body?.tags) ? body.tags : existing?.tags ?? ['batshit', 'system', 'helper'],
    created_at: existing?.created_at ?? now,
    updated_at: now
  }

  await redis.set(key, updated)
  await redis.sAdd('user:system:clips', clipId)

  return json(updated)
}

import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import {
  canAccessZipData,
  normalizeZipIds,
  requireOwnedSession,
  requireUser
} from '$lib/server/services/routeSecurity'
import { enrichCoolToolPromptTokens } from '$lib/server/services/coolToolPromptTokens'

// GET /api/zips - Get multiple zips by IDs
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  
  try {
    const zipIds = normalizeZipIds(url.searchParams.get('ids'))
    if (!zipIds.ok) return zipIds.response

    const zips = await redis.getZips(zipIds.value)
    
    // Convert Map to object for JSON response
    const result: Record<string, any> = {}
    for (const [id, data] of zips) {
      if (await canAccessZipData({ id, ...data }, user.value.id)) {
        result[id] = await enrichCoolToolPromptTokens({ id, ...data }, (zipId) => redis.getZip(zipId))
      }
    }
    
    return json(result)
  } catch (error) {
    console.error('Error fetching zips:', error)
    return json({ error: 'Failed to fetch zips' }, { status: 500 })
  }
}

// POST /api/zips - Create a new zip
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  
  try {
    const zip = await request.json()
    
    // Validate required fields
    if (!zip.id || !zip.content || !zip.type) {
      return json({ error: 'Missing required fields: id, content, type' }, { status: 400 })
    }

    const sessionId = zip.sessionId || zip.metadata?.sessionId
    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response
    
    // Create the zip in Redis
    await redis.createZip({
      id: zip.id,
      content: zip.content,
      type: zip.type,
      tokens:
        zip.metadata?.promptTokens ||
        zip.metadata?.aiTokens ||
        zip.tokens ||
        Math.ceil(zip.content.length / 4),
      description: zip.description || '',
      metadata: {
        ...zip.metadata,
        userId: user.value.id,
        sessionId,
        messageId: zip.messageId || zip.metadata?.messageId
      }
    })
    
    return json({ success: true, id: zip.id })
  } catch (error) {
    console.error('Error creating zip:', error)
    return json({ error: 'Failed to create zip' }, { status: 500 })
  }
}

// DELETE /api/zips - Delete a zip
export const DELETE: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  
  try {
    const zipId = url.searchParams.get('id')
    if (!zipId) {
      return json({ error: 'No zip ID provided' }, { status: 400 })
    }
    const zipData = await redis.getZip(zipId)
    if (!zipData) {
      return json({ error: 'Zip not found' }, { status: 404 })
    }
    if (!(await canAccessZipData(zipData, user.value.id))) {
      return json({ error: 'Forbidden' }, { status: 403 })
    }

    await redis.deleteZip(zipId)
    return json({ success: true })
  } catch (error) {
    console.error('Error deleting zip:', error)
    return json({ error: 'Failed to delete zip' }, { status: 500 })
  }
}

import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import {
  canAccessZipData,
  normalizeZipIds,
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

// BL-1997 (BL-1825): no POST. Every zip is written by the server that produced it (the stream
// adapter, the managed helpers, backup restore). The old browser create took an id, content and
// metadata from the request and overwrote any zip with JSON.SET; no app code called it.

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

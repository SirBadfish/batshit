import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { canAccessZipData, normalizeZipIds, requireUser } from '$lib/server/services/routeSecurity'
import { enrichCoolToolPromptTokens } from '$lib/server/services/coolToolPromptTokens'

/**
 * Batch fetch zip metadata from Redis
 * This is MUCH more efficient than individual fetches
 * Redis pipeline operations are incredibly fast
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const { ids } = await request.json()
    const zipIds = normalizeZipIds(ids)
    if (!zipIds.ok) return zipIds.response

    // Use the getZips method which already handles batch operations efficiently
    const zipMap = await redis.getZips(zipIds.value)
    
    // Convert map to array of zip data
    const zipData = []
    for (const id of zipIds.value) {
      const data = zipMap.get(id)
      if (!data) continue
      if (await canAccessZipData({ id, ...data }, user.value.id)) {
        zipData.push(await enrichCoolToolPromptTokens({ id, ...data }, (zipId) => redis.getZip(zipId)))
      }
    }

    return json(zipData)
    
  } catch (error) {
    console.error('Batch zip fetch error:', error)
    console.error('Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    })
    return json({ 
      error: 'Failed to fetch zip metadata',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

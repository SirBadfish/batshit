import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { canAccessZipData, requireUser } from '$lib/server/services/routeSecurity'
import { enrichCoolToolPromptTokens } from '$lib/server/services/coolToolPromptTokens'

// GET /api/zips/[id] - Get a single zip
export const GET: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  
  try {
    const zipData = await redis.getZip(params.id)
    
    if (!zipData) {
      console.warn('[api/zips/:id] Zip not found for id:', params.id)
      return json({ error: 'Zip not found' }, { status: 404 })
    }

    if (!(await canAccessZipData(zipData, user.value.id))) {
      return json({ error: 'Forbidden' }, { status: 403 })
    }
    
    return json(await enrichCoolToolPromptTokens(zipData, (zipId) => redis.getZip(zipId)))
  } catch (error) {
    console.error(`Error fetching zip ${params.id}:`, error)
    return json({ error: 'Failed to fetch zip' }, { status: 500 })
  }
}

// DELETE /api/zips/[id] - Delete a specific zip
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  
  try {
    const zipData = await redis.getZip(params.id)
    if (!zipData) {
      return json({ error: 'Zip not found' }, { status: 404 })
    }
    if (!(await canAccessZipData(zipData, user.value.id))) {
      return json({ error: 'Forbidden' }, { status: 403 })
    }

    await redis.deleteZip(params.id)
    return json({ success: true })
  } catch (error) {
    console.error(`Error deleting zip ${params.id}:`, error)
    return json({ error: 'Failed to delete zip' }, { status: 500 })
  }
}

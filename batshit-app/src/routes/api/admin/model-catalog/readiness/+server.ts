import { error, json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { getModelCatalogReadiness } from '$lib/server/services/modelCatalogReadiness'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  try {
    const readiness = await getModelCatalogReadiness()
    return json(readiness)
  } catch (err) {
    console.error('[model-catalog-readiness] failed', err)
    const message = err instanceof Error ? err.message : 'Failed to load model catalog readiness'
    throw error(500, message)
  }
}

import { error, json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { listCatalogSyncReports } from '$lib/server/services/modelCatalogReportStore'

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  const limitParam = url.searchParams.get('limit')
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 20
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 20

  try {
    const reports = await listCatalogSyncReports(limit)
    return json({ reports })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load catalog sync reports'
    const status = message.includes('KV_REST') ? 503 : 500
    console.error('[catalog-reports] failed to load reports', err)
    throw error(status, message)
  }
}


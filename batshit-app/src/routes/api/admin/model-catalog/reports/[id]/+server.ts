import { error, json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { getCatalogSyncReport } from '$lib/server/services/modelCatalogReportStore'

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  const id = params.id
  if (!id) {
    throw error(400, 'Missing report id')
  }

  try {
    const report = await getCatalogSyncReport(id)
    if (!report) {
      throw error(404, 'Report not found')
    }
    return json({ report })
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err) {
      throw err
    }
    const message = err instanceof Error ? err.message : 'Failed to load catalog sync report'
    const status = message.includes('KV_REST') ? 503 : 500
    console.error('[catalog-reports] failed to load report', err)
    throw error(status, message)
  }
}


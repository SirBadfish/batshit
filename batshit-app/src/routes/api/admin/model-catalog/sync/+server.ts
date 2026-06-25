import { error, json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { runModelCatalogSync } from '$lib/server/services/modelCatalogSync'

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  try {
    const result = await runModelCatalogSync({
      trigger: 'admin-ui',
      initiatedBy: locals.user.id
    })

    return json({
      status: result.report.status,
      fetchedAt: result.payload.fetchedAt,
      previousFetchedAt: result.report.previousFetchedAt,
      counts: result.payload.counts,
      models: result.payload.models.length,
      sources: result.sources,
      diff: result.report.diff,
      warningStreak: result.report.warningStreak,
      warningAlert: result.report.warningAlert ?? null
    })
  } catch (err) {
    console.error('[catalog-sync] sync failed', err)
    const message = err instanceof Error ? err.message : 'Catalog sync failed'
    const status =
      message.startsWith('Missing required environment variable:') || message.includes('KV_REST')
        ? 503
        : 500
    throw error(status, message)
  }
}

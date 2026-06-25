import { json, error } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { logger } from '$lib/utils/logger'
import { runModelCatalogSync } from '$lib/server/services/modelCatalogSync'
import {
  buildCronProofRequestMetadata,
  storeRegistryCronProof
} from '$lib/server/services/registryCronProofStore'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'

const HEADER_KEY = 'x-cron-secret'
const ROUTE_PATH = '/api/admin/cron/model-catalog'

function normalizeCronError(err: unknown) {
  return err instanceof Error ? err.message : 'Unknown cron error'
}

async function persistCronProof(input: Parameters<typeof storeRegistryCronProof>[0]) {
  try {
    const proof = await storeRegistryCronProof(input)
    return {
      stored: true,
      id: proof.id,
      completedAt: proof.completedAt,
      vercelCron: proof.vercelCron
    }
  } catch (err) {
    const message = normalizeCronError(err)
    console.warn('[catalog-cron] failed to persist cron proof', message)
    return {
      stored: false,
      error: message
    }
  }
}

export const GET = async ({ request }) => {
  const configured = await getRuntimeEnv('CRON_SECRET')
  if (!configured) {
    throw error(503, 'Cron secret not configured')
  }

  const providedHeader = request.headers.get(HEADER_KEY)
  const authHeader = request.headers.get('authorization')
  const bearer = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7)
    : null

  const provided = providedHeader || bearer

  if (!provided || provided !== configured) {
    return apiError('Unauthorized', 401)
  }

  const startedAt = new Date().toISOString()
  const requestProof = buildCronProofRequestMetadata(request)

  try {
    logger.debug('[catalog-cron] invoked', {
      userAgent: request.headers.get('user-agent') ?? null
    })
    const result = await runModelCatalogSync({ trigger: 'cron' })
    const completedAt = new Date().toISOString()
    const cronProof = await persistCronProof({
      name: 'model-catalog',
      route: ROUTE_PATH,
      status: result.report.status,
      startedAt,
      completedAt,
      ...requestProof,
      summary: {
        fetchedAt: result.payload.fetchedAt,
        previousFetchedAt: result.report.previousFetchedAt ?? null,
        counts: result.payload.counts,
        models: result.payload.models.length,
        warningStreak: result.report.warningStreak,
        warningAlert: result.report.warningAlert ?? null
      },
      error: null
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
      warningAlert: result.report.warningAlert ?? null,
      cronProof
    })
  } catch (err) {
    const completedAt = new Date().toISOString()
    const message = normalizeCronError(err)
    await persistCronProof({
      name: 'model-catalog',
      route: ROUTE_PATH,
      status: 'failed',
      startedAt,
      completedAt,
      ...requestProof,
      summary: {},
      error: message
    })
    console.error('[catalog-cron] sync failed', err)
    throw error(500, 'Catalog sync failed')
  }
}

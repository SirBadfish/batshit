import { json, error } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { logger } from '$lib/utils/logger'
import {
  loadPublishedCompatibilityMatrix,
  publishCompatibilityMatrix
} from '$lib/server/services/compatibilityMatrixAdmin'
import { runN8nCompatibilitySync } from '$lib/server/services/n8nParameterCompatibility'
import {
  buildCronProofRequestMetadata,
  storeRegistryCronProof
} from '$lib/server/services/registryCronProofStore'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'

const HEADER_KEY = 'x-cron-secret'
const ROUTE_PATH = '/api/admin/cron/compatibility-matrix'

async function shouldSkipHostedCompatibilitySync() {
  if (process.env.VERCEL !== '1') return false
  const hostedSyncEnabled = await getRuntimeEnv('BATSHIT_HOSTED_COMPATIBILITY_SYNC')
  return hostedSyncEnabled !== '1'
}

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
    console.warn('[compatibility-matrix-cron] failed to persist cron proof', message)
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
  const warnings: string[] = []

  let syncStatus: 'ok' | 'degraded' | 'skipped' = 'ok'
  let syncEntries = 0
  let syncError: string | null = null

  let publishedSnapshotEntries = 0
  let previousFetchedAt: string | null = null

  try {
    logger.debug('[compatibility-matrix-cron] invoked', {
      userAgent: request.headers.get('user-agent') ?? null
    })
    const publishedSnapshot = await loadPublishedCompatibilityMatrix()
    previousFetchedAt = publishedSnapshot.fetchedAt ?? null
    publishedSnapshotEntries = publishedSnapshot.entries.length
  } catch (err) {
    warnings.push('Failed to load previously published compatibility matrix before sync.')
    console.warn(
      '[compatibility-matrix-cron] could not load published compatibility matrix before sync',
      err
    )
  }

  if (await shouldSkipHostedCompatibilitySync()) {
    syncStatus = 'skipped'
    const completedAt = new Date().toISOString()
    const notes = [
      'Hosted Vercel skipped live n8n compatibility sync by design; refresh and publish the matrix from a local Batshit automation lane.'
    ]
    const proofStatus = warnings.length ? 'degraded' : 'ok'
    const cronProof = await persistCronProof({
      name: 'compatibility-matrix',
      route: ROUTE_PATH,
      status: proofStatus,
      startedAt,
      completedAt,
      ...requestProof,
      summary: {
        fetchedAt: previousFetchedAt,
        previousFetchedAt,
        entries: publishedSnapshotEntries,
        syncEntries,
        hostedCompatibilitySync: syncStatus,
        warnings,
        notes
      },
      error: null
    })

    return json({
      status: proofStatus,
      fetchedAt: previousFetchedAt,
      previousFetchedAt,
      entries: publishedSnapshotEntries,
      source: 'published-unchanged',
      sync: {
        status: syncStatus,
        entries: syncEntries,
        error: syncError
      },
      warnings,
      notes,
      cronProof
    })
  }

  try {
    const synced = await runN8nCompatibilitySync()
    syncEntries = synced.entries.length

    const published = await publishCompatibilityMatrix(synced)
    const completedAt = new Date().toISOString()
    const proofStatus = warnings.length ? 'degraded' : 'ok'
    const cronProof = await persistCronProof({
      name: 'compatibility-matrix',
      route: ROUTE_PATH,
      status: proofStatus,
      startedAt,
      completedAt,
      ...requestProof,
      summary: {
        fetchedAt: published.fetchedAt,
        previousFetchedAt,
        entries: published.entries.length,
        syncEntries,
        warnings
      },
      error: null
    })

    return json({
      status: 'published',
      fetchedAt: published.fetchedAt,
      previousFetchedAt,
      entries: published.entries.length,
      source: 'n8n-sync',
      sync: {
        status: syncStatus,
        entries: syncEntries,
        error: syncError
      },
      warnings,
      cronProof
    })
  } catch (err) {
    syncStatus = 'degraded'
    syncError = err instanceof Error ? err.message : 'n8n compatibility sync failed'
    warnings.push(`n8n compatibility sync failed; published snapshot was left unchanged (${syncError})`)
    console.warn('[compatibility-matrix-cron] n8n sync failed; published snapshot left unchanged', err)
    const completedAt = new Date().toISOString()
    const cronProof = await persistCronProof({
      name: 'compatibility-matrix',
      route: ROUTE_PATH,
      status: 'degraded',
      startedAt,
      completedAt,
      ...requestProof,
      summary: {
        fetchedAt: previousFetchedAt,
        previousFetchedAt,
        entries: publishedSnapshotEntries,
        syncEntries,
        warnings
      },
      error: syncError
    })

    return json({
      status: 'degraded',
      fetchedAt: previousFetchedAt,
      previousFetchedAt,
      entries: publishedSnapshotEntries,
      source: 'published-unchanged',
      sync: {
        status: syncStatus,
        entries: syncEntries,
        error: syncError
      },
      warnings,
      cronProof
    })
  }
}

import { error, json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import type { CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'
import {
  publishCompatibilityMatrix
} from '$lib/server/services/compatibilityMatrixAdmin'

function normalizeSnapshot(payload: any): CompatibilityMatrixSnapshot | null {
  if (!payload || typeof payload !== 'object') return null
  const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : payload
  if (!snapshot || !Array.isArray(snapshot.entries)) return null

  return {
    version: typeof snapshot.version === 'number' ? snapshot.version : 1,
    fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : new Date().toISOString(),
    entries: snapshot.entries
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  const payload = await request.json().catch(() => null)
  const snapshot = normalizeSnapshot(payload)

  if (!snapshot) {
    throw error(400, 'Invalid compatibility matrix payload')
  }

  try {
    const published = await publishCompatibilityMatrix(snapshot)
    return json({ published })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to publish compatibility matrix'
    const status = message.includes('KV_REST') ? 503 : 500
    console.error('[compatibility-matrix] publish failed', err)
    throw error(status, message)
  }
}

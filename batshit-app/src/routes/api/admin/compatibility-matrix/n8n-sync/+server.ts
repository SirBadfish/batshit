import { error, json } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { runN8nCompatibilitySync } from '$lib/server/services/n8nParameterCompatibility'

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  try {
    const snapshot = await runN8nCompatibilitySync({ userId: locals.user.id })
    return json({
      snapshot,
      entries: snapshot.entries.length
    })
  } catch (err) {
    console.error('[compatibility-matrix] n8n sync failed', err)
    const message = err instanceof Error ? err.message : 'Failed to sync n8n compatibility'
    throw error(500, message)
  }
}

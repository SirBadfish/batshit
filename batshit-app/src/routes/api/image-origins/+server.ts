import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { apiError } from '$lib/server/services/apiResponses'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { loadImageOrigins } from '$lib/server/services/imageAddressOrigins'

/**
 * BL-474 step 2: read-only, owner-scoped records of where each reply's outside pictures came from.
 * The server writes them at each reply's end; no route writes them.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const sessionId = url.searchParams.get('sessionId')
  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response
  try {
    return json({ records: await loadImageOrigins(sessionId as string) }, {
      headers: { 'Cache-Control': 'no-store' }
    })
  } catch (error) {
    console.error('[Image origin] Failed to read the records:', error)
    return apiError('Failed to read where the pictures came from.', 500)
  }
}

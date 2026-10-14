import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { apiError } from '$lib/server/services/apiResponses'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { loadCodexCleanupWarnings } from '$lib/server/services/codexCleanupWarnings'

/** Read-only, owner-scoped annotations of Codex replies whose command cleanup was unconfirmed. */
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const sessionId = url.searchParams.get('sessionId')
  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response
  try {
    return json({ records: await loadCodexCleanupWarnings(sessionId as string) }, {
      headers: { 'Cache-Control': 'no-store' }
    })
  } catch (error) {
    console.error('[Codex cleanup] Failed to read warning records:', error)
    return apiError('Failed to read Codex cleanup warnings.', 500)
  }
}

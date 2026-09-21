import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { apiError } from '$lib/server/services/apiResponses'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { loadPostTurnRecords } from '$lib/server/services/postTurnCheckState'

/**
 * SA-120 P6 — what the Jev Juice after-reply check noticed about a chat's replies, keyed by
 * message id. READ ONLY: the records are written by the server alone, after a reply is
 * complete (`postTurnCheckState.ts`), which is why the chat page reads them from here instead
 * of from message metadata. A chat with nothing flagged answers `{ records: {} }`.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const sessionId = url.searchParams.get('sessionId')
  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response

  try {
    return json({ records: await loadPostTurnRecords(sessionId as string) })
  } catch (error) {
    console.error('[Jev Juice] Failed to read after-reply records:', error)
    return apiError('Failed to read Jev Juice after-reply records.', 500)
  }
}

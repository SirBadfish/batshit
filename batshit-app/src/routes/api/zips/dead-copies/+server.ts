/**
 * SA-129 P2 (BL-333): which of a chat's file reads are dead copies (a later whole read superseded
 * them, or the agent edited the file since). The chat's zip badges and the Zip Manager read this,
 * so they show such a copy compressed, with its reason, exactly as the model sees it. Computed on
 * the server by the compile's own ledger (`findSessionDeadCopies`); nothing is stored.
 */

import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { DatabaseService } from '$lib/services/databaseRedis.server'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ url, locals, fetch }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const sessionId = url.searchParams.get('sessionId')
  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response

  try {
    const reasons = await new DatabaseService(fetch).findSessionDeadCopies(sessionId as string, user.value.id)
    return json({ deadCopies: Object.fromEntries(reasons) })
  } catch (error) {
    console.error('[DeadCopiesAPI] Failed to read the chat dead copies:', error)
    return json({ error: 'Failed to read dead copies' }, { status: 500 })
  }
}

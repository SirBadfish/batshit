/**
 * SA-129 P2 (BL-333): which of a chat's file reads are dead copies (a later whole read superseded
 * them, or the agent edited the file since). The chat's zip badges and the Zip Manager read this,
 * so they show such a copy compressed, with its reason, exactly as the model sees it. Computed on
 * the server by the compile's own ledger (`findSessionZipFacts`); nothing is stored. SA-137 P4 adds
 * what live file reads did for the chat's newest turn (`liveReads`), from its receipt; no file is read.
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
    const facts = await new DatabaseService(fetch).findSessionZipFacts(sessionId as string, user.value.id)
    // SA-137 P4 (D10): what live file reads did for the chat's newest turn (null when none).
    return json({ deadCopies: Object.fromEntries(facts.deadCopies), liveReads: facts.liveReads })
  } catch (error) {
    console.error('[DeadCopiesAPI] Failed to read the chat dead copies:', error)
    return json({ error: 'Failed to read dead copies' }, { status: 500 })
  }
}

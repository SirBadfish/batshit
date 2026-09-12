import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { listSessionApprovals } from '$lib/server/services/controlApprovals'

/**
 * SA-116 P2 (DL-116-12) — what the user approved, denied, or let expire in this chat.
 *
 * The Execution Viewer cannot answer that from the message it is showing: the moment a
 * resume lands, send-routed clears `metadata.toolApprovals` so a spent card cannot reappear
 * on refresh. Three of the four statuses the lock names — approved, denied, expired — only
 * exist AFTER that clear, so the durable answer has to come from the approval records.
 *
 * Read-only, session-scoped, and owner-checked exactly like the execution-log route beside
 * it. It returns no input values, only the summary the card already showed.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = locals.user?.id
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 })

  const sessionId = params.sessionId
  if (!sessionId) return json({ error: 'Session ID is required' }, { status: 400 })

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found' }, { status: 404 })
  }

  const approvals = await listSessionApprovals(sessionId, userId)
  return json({ approvals })
}

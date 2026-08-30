/**
 * SA-104 P6 — regular-session graduation for memory-enabled agents (DL-104-12/-16).
 *
 * Strictly additive: the completed tail of a regular session becomes a searchable
 * `memseg:` record through the shared graduation writer; the session's window,
 * compaction, and trim behavior stay byte-identical. The client calls this when a
 * regular session of a memory-enabled agent is opened (`reason: 'idle'` — the server
 * verifies the idle gap and no-ops otherwise) and when one is archived
 * (`reason: 'close'`). The durable background sweep is P7 dreaming's job.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import { isFixedSession } from '$lib/utils/fixedSession'
import { graduateRegularSessionTail } from '$lib/server/services/memory/memoryGraduation'

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { sessionId?: string; agentId?: string; reason?: string }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const reason: 'idle' | 'close' = body.reason === 'close' ? 'close' : 'idle'
  if (!sessionId) {
    return json({ error: 'sessionId is required' }, { status: 400 })
  }

  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response
  const session = sessionCheck.value

  if (isFixedSession(session)) {
    return json({ status: 'skipped', reason: 'fixed_session' })
  }
  if ((session.metadata as Record<string, any> | undefined)?.group_chat) {
    return json({ status: 'skipped', reason: 'group_session' })
  }

  const agentId =
    typeof body.agentId === 'string' && body.agentId.trim()
      ? body.agentId.trim()
      : typeof (session as Record<string, any>).agent_id === 'string'
        ? ((session as Record<string, any>).agent_id as string)
        : ''
  if (!agentId) {
    return json({ status: 'skipped', reason: 'no_agent' })
  }

  const agent = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  if (!agent || (typeof agent.user_id === 'string' && agent.user_id !== user.value.id)) {
    return json({ status: 'skipped', reason: 'agent_not_found' })
  }
  if (!resolveAgentMemoryEnabled(agent)) {
    return json({ status: 'skipped', reason: 'memory_disabled' })
  }

  try {
    const outcome = await graduateRegularSessionTail({
      userId: user.value.id,
      agent,
      sessionId,
      reason
    })
    return json(outcome)
  } catch (error) {
    console.error('[Memory Graduate Session] Failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Session graduation failed.',
        code: 'GRADUATION_FAILED'
      },
      { status: 500 }
    )
  }
}

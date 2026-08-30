/**
 * SA-104 P6 — the Infinite-Session nap (DL-104-07 / DL-104-15).
 *
 * Triggered by the client when the compiled window crosses the nap threshold (the
 * auto-compact trigger pattern) or manually from the Token Panel. Runs strictly
 * between turns: the session-turn registry is the server-side interlock (every
 * send-routed lane registers there; the native n8n lane is covered by the client's
 * busy gate, exactly like Auto Compact). The relief order and all pin/hold honoring
 * live in `runFixedSessionNap`; failures are loud and recorded on the visible nap
 * history.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { getActiveSessionTurn } from '$lib/server/services/streamAbortRegistry'
import { isFixedSession } from '$lib/utils/fixedSession'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import { runFixedSessionNap } from '$lib/server/services/memory/memoryGraduation'

export const POST: RequestHandler = async ({ request, locals, fetch: eventFetch }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { sessionId?: string; agentId?: string; trigger?: string }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const trigger: 'threshold' | 'manual' = body.trigger === 'manual' ? 'manual' : 'threshold'
  if (!sessionId || !agentId) {
    return json({ error: 'sessionId and agentId are required' }, { status: 400 })
  }

  const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
  if (!sessionCheck.ok) return sessionCheck.response
  const session = sessionCheck.value

  if (!isFixedSession(session)) {
    return json(
      { error: 'Naps only run in Infinite Sessions.', code: 'NOT_FIXED_SESSION' },
      { status: 400 }
    )
  }
  if ((session.metadata as Record<string, any> | undefined)?.group_chat) {
    return json({ error: 'Group sessions do not nap.', code: 'GROUP_SESSION' }, { status: 400 })
  }

  const agent = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  if (!agent || (typeof agent.user_id === 'string' && agent.user_id !== user.value.id)) {
    return json({ error: 'Agent not found' }, { status: 404 })
  }
  if (!resolveAgentMemoryEnabled(agent)) {
    return json(
      {
        error: 'Naps require agent memory to be enabled.',
        code: 'MEMORY_DISABLED'
      },
      { status: 400 }
    )
  }

  // DL-104-15: naps run between turns only. The registry covers every send-routed
  // lane; a live turn refuses the nap outright (the client retries at the next idle
  // threshold check).
  if (getActiveSessionTurn(sessionId)) {
    return json(
      {
        error: 'A response is in progress for this session; naps run between turns.',
        code: 'session_turn_in_progress'
      },
      { status: 409 }
    )
  }

  try {
    const outcome = await runFixedSessionNap({
      userId: user.value.id,
      agent,
      sessionId,
      trigger,
      eventFetch
    })
    if (outcome.status === 'failed') {
      return json(
        {
          error: outcome.error ?? 'Nap failed.',
          code: 'NAP_FAILED',
          record: outcome.record,
          metadata: outcome.metadata
        },
        { status: 500 }
      )
    }
    return json({
      status: outcome.status,
      record: outcome.record,
      metadata: outcome.metadata,
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
      napAtTokens: outcome.window?.napAtTokens ?? null
    })
  } catch (error) {
    console.error('[Memory Nap] Failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Nap failed.' },
      { status: 500 }
    )
  }
}

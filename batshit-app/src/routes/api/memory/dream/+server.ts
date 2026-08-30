/**
 * SA-104 P7 — the manual "Dream now" trigger (DL-104-15; p7 packet doc §1.3).
 *
 * A USER control, deliberately not a Fabric control: an agent-invocable dream would
 * interleave with its own live turn. Ownership + memory-enablement gated; 409 while
 * the agent is already dreaming. The run itself checks the session-turn registry
 * before every session-touching phase and skips live sessions with a logged reason,
 * so a manual dream during active chatting stays safe. Runs synchronously (bounded
 * item counts keep it tolerable) and returns the finished, visible run record.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { requireUser } from '$lib/server/services/routeSecurity'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import {
  DreamingBusyError,
  isAgentDreaming,
  runDreamingPass
} from '$lib/server/services/memory/memoryDreaming'

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { agentId?: string }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  if (!agentId) {
    return json({ error: 'agentId is required' }, { status: 400 })
  }

  const agent = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  if (!agent || (typeof agent.user_id === 'string' && agent.user_id !== user.value.id)) {
    return json({ error: 'Agent not found' }, { status: 404 })
  }
  if (!resolveAgentMemoryEnabled(agent)) {
    return json(
      {
        error: 'Dreaming requires agent memory to be enabled.',
        code: 'MEMORY_DISABLED'
      },
      { status: 400 }
    )
  }
  if (isAgentDreaming(agentId)) {
    return json(
      { error: 'This agent is already dreaming; one pass runs at a time.', code: 'DREAM_IN_PROGRESS' },
      { status: 409 }
    )
  }

  try {
    const run = await runDreamingPass({
      userId: user.value.id,
      agent,
      trigger: 'manual'
    })
    if (run.status === 'failed') {
      return json({ error: run.error ?? 'Dreaming failed.', code: 'DREAM_FAILED', run }, { status: 500 })
    }
    return json({ run })
  } catch (error) {
    if (error instanceof DreamingBusyError) {
      return json({ error: error.message, code: 'DREAM_IN_PROGRESS' }, { status: 409 })
    }
    console.error('[Memory Dream] Failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Dreaming failed.' },
      { status: 500 }
    )
  }
}

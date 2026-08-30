/**
 * SA-104 P7 — the visible dreaming log (DL-104-02 honesty; p7 packet doc §1.5/§1.9).
 *
 * Ownership-gated like every manage route — a memory-DISABLED agent's log stays
 * readable (only dreaming NOW requires enablement, because it creates new memory
 * activity). Without `runId`: summary rows, newest first. With `runId`: the full run
 * record including every action's WHY.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { MemoryManageError, requireOwnedAgent } from '$lib/server/services/memory/memoryManage'
import {
  getDreamRun,
  getDreamRunSummaries,
  isAgentDreaming
} from '$lib/server/services/memory/memoryDreaming'

export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const agentId = url.searchParams.get('agentId') ?? ''
    await requireOwnedAgent(user.value.id, agentId)

    const runId = url.searchParams.get('runId')
    if (runId) {
      const run = await getDreamRun(agentId, runId)
      if (!run) {
        return json({ error: `Dreaming run "${runId}" was not found for this agent.` }, { status: 404 })
      }
      return json({ run })
    }

    const limitParam = url.searchParams.get('limit')
    const runs = await getDreamRunSummaries(agentId, limitParam ? Number(limitParam) : undefined)
    return json({ runs, dreaming: isAgentDreaming(agentId) })
  } catch (error) {
    if (error instanceof MemoryManageError) {
      return json({ error: error.message }, { status: error.status })
    }
    console.error('[Memory Manage] Dream log failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load the dreaming log' },
      { status: 500 }
    )
  }
}

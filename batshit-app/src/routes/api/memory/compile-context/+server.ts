/**
 * SA-104 P4 — memory compile context for the n8n client compilation twin.
 *
 * The recall engine is one server-side implementation (`memoryRecall.ts`). The server
 * twin calls it directly; the client twin calls this route during compile and splices
 * the returned strings verbatim, so both lanes present byte-identical memory context
 * (DL-104-11 / P0 §1.1: compute once server-side, never implement ranking twice).
 *
 * This is a READ-ONLY computation: no linger state, recall counters, or agent stamps
 * change here. The state commit happens in send-routed at the accepted-send boundary.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { computeMemoryCompileContext } from '$lib/server/services/memory/memoryRecall'

type CompileContextRequest = {
  sessionId?: string
  agentId?: string
  currentUserMessage?: string
  historyMessageIds?: unknown[]
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: CompileContextRequest
  try {
    body = (await request.json()) as CompileContextRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  if (!sessionId || !agentId) {
    return json({ error: 'sessionId and agentId are required' }, { status: 400 })
  }

  const session = await redis.getSession(sessionId).catch(() => null)
  if (!session || (typeof session.user_id === 'string' && session.user_id !== locals.user.id)) {
    return json({ error: 'Session not found for this user' }, { status: 404 })
  }

  const historyMessageIds = Array.isArray(body.historyMessageIds)
    ? body.historyMessageIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []

  // No try/catch demotion here: a failing memory read must fail the compile loudly
  // (DL-104-05 / FM "DCM build failure must be loud"), matching the server twin.
  const context = await computeMemoryCompileContext({
    userId: locals.user.id,
    agentId,
    sessionId,
    currentUserMessage: typeof body.currentUserMessage === 'string' ? body.currentUserMessage : '',
    historyMessageIds
  })

  return json(context)
}

import cluster from 'node:cluster'
import { isMainThread } from 'node:worker_threads'
import { env } from '$env/dynamic/private'
import { authService } from '$lib/services/auth.server'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { requireOwnedSession } from '$lib/server/services/routeSecurity'
import { AppActionRefusal, refuse } from '$lib/appActions/catalog'
import { createAppActionRegistry } from './registry'
import type { AppActionIntent } from './registry'
import { processTopologyRefusal } from './policy'

/** Existing Mac, Docker and strict-port dev launchers each own one adapter-node/Vite process. */
export function appActionTopologyRefusal(configuration: Record<string, string | undefined>, worker = !isMainThread || cluster.isWorker): string | null {
  return processTopologyRefusal(configuration, worker)
}
export function requireAppActionTopology() {
  const reason = appActionTopologyRefusal(env)
  if (reason) refuse(reason)
}
export const appActionRegistry = createAppActionRegistry({
  publish: publishUserEvent,
  validAuthentication: async binding => {
    const authenticated = await authService.validateSession(binding.authenticationSession)
    return authenticated?.user.id === binding.userId
  }
})
export async function requireAppActionSession(userId: string, sessionId: string | null) {
  if (sessionId === null) return
  const result = await requireOwnedSession(sessionId, userId)
  if (!result.ok) refuse('session_not_owned')
}
/** Fabric context is server-owned. Tool arguments cannot supply an acting identity/session. */
export async function executeAgentAppAction(context: {
  userId: string; agentId?: string | null; sessionId?: string | null; abortSignal?: AbortSignal
}, intent: Omit<AppActionIntent, 'expectedSessionId'>) {
  try {
    requireAppActionTopology()
    if (!context.agentId || !context.sessionId) refuse('agent_session_required')
    if (context.abortSignal?.aborted) refuse('caller_stopped')
    await requireAppActionSession(context.userId, context.sessionId)
    if (context.abortSignal?.aborted) refuse('caller_stopped')
    const caller = { userId: context.userId, scopeId: `agent:${context.agentId}:${context.sessionId}`, signal: context.abortSignal }
    const dispatched = await appActionRegistry.dispatch(caller, { ...intent, expectedSessionId: context.sessionId })
    return await dispatched.result
  } catch (error) {
    if (error instanceof AppActionRefusal) {
      return { status: 'blocked', reason: error.reason,
        ...(error.reason === 'ambiguous_target' ? { documents: appActionRegistry.listDocuments(context.userId, context.sessionId) } : {}) }
    }
    throw error
  }
}

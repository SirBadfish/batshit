import type { ChatSession } from '$lib/stores/session.svelte'

type ResolveSessionTargetAgentIdParams = {
  session: Pick<ChatSession, 'agent_id' | 'metadata'> | null | undefined
  availableAgentIds: string[]
  currentAgentId?: string | null
}

type ResolveSessionStoredAgentIdParams = Omit<ResolveSessionTargetAgentIdParams, 'currentAgentId'>

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

export function shouldAutoSyncSessionTarget(
  sessionId: string | null | undefined,
  lastAutoSyncedSessionId: string | null | undefined
): boolean {
  if (!sessionId) return false
  return sessionId !== lastAutoSyncedSessionId
}

export function resolveSessionStoredAgentId({
  session,
  availableAgentIds
}: ResolveSessionStoredAgentIdParams): string | null {
  if (!session) return null
  if (session?.metadata?.group_chat?.group_id) return null

  const sessionAgentId = readString(
    session.agent_id,
    session?.metadata?.last_agent_id,
    session?.metadata?.lastAgentId,
    session?.metadata?.agent_id,
    session?.metadata?.agentId
  )
  if (!sessionAgentId) return null
  if (!availableAgentIds.includes(sessionAgentId)) return null

  return sessionAgentId
}

export function resolveSessionTargetAgentId({
  session,
  availableAgentIds,
  currentAgentId = null
}: ResolveSessionTargetAgentIdParams): string | null {
  const sessionAgentId = resolveSessionStoredAgentId({ session, availableAgentIds })
  if (!sessionAgentId) return null
  if (currentAgentId === sessionAgentId) return null

  return sessionAgentId
}

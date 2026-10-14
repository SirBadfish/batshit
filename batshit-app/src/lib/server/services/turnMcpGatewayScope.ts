import type { AgentRow } from '$lib/types/database'
import { resolveDynamicMcpGatewayScope } from './mcpSelectionResolver'

/** Created by send-routed from request authentication, never request metadata. */
export interface TurnMcpGatewayAuthority {
  humanSelection: boolean
  /** An approval continues the server-recorded scope, including an empty scope. */
  resumedScope?: string[]
}

export function readTurnMcpGatewaySnapshot(
  snapshot: unknown,
  owner: { userId: string; sessionId: string; agentId: string }
): string[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const saved = snapshot as Record<string, unknown>
  if (saved.userId !== owner.userId || saved.sessionId !== owner.sessionId || saved.agentId !== owner.agentId ||
      !Array.isArray(saved.selectedGateways)) return []
  return [...new Set(saved.selectedGateways.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()))]
}

/** Only a signed-in send may widen defaults. Service and resume lists only narrow. */
export async function resolveTurnMcpGatewaySelection(options: {
  userId: string
  agent: AgentRow
  requestedGateways?: string[]
  authority?: TurnMcpGatewayAuthority
}): Promise<string[] | undefined> {
  if (options.authority?.resumedScope !== undefined) {
    const saved = options.authority.resumedScope
    if (!Array.isArray(options.requestedGateways)) return [...saved]
    const allowed = new Set(saved)
    return options.requestedGateways.filter(id => typeof id === 'string' && allowed.has(id.trim())).map(id => id.trim())
  }
  if (options.authority?.humanSelection === true) return options.requestedGateways
  return (await resolveDynamicMcpGatewayScope({
    userId: options.userId,
    agentId: options.agent.id,
    agent: options.agent,
    selectedGateways: options.requestedGateways
  })).resolvedGateways
}

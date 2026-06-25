import { normalizeSubagentSlugValue, resolveSubagentSlug } from './subagentSlug'

type CliAgentToolNameRecord = {
  id?: string | null
  slug?: string | null
}

type CliSubagentToolNameRecord = {
  slug?: string | null
  id?: string | null
  displayName?: string | null
  display_name?: string | null
  name?: string | null
  description?: string | null
}

const MANAGED_GATEWAY_PREFIX = 'batshit_gateway_'

function sanitizeManagedGatewaySegment(value: string | null | undefined) {
  const source = (value ?? '').trim().toLowerCase()
  return (
    source
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '') || 'gateway'
  )
}

export type CliSubagentMcpToolReference = {
  serverName: string
  toolName: string
  fullToolName: string
}

export function buildCliSubagentMcpToolReference(
  agent: CliAgentToolNameRecord | null | undefined,
  subagent: CliSubagentToolNameRecord | null | undefined
): CliSubagentMcpToolReference | null {
  const agentId = agent?.id?.trim()
  if (!agentId || !subagent) return null

  const agentSlug = agent?.slug?.trim()
  const gatewaySource = agentSlug ? `${agentSlug}-subagents` : `${agentId}-subagents`
  const serverName = `${MANAGED_GATEWAY_PREFIX}${sanitizeManagedGatewaySegment(gatewaySource)}`
  const toolKey = subagent.id
    ? normalizeSubagentSlugValue(subagent.id)
    : resolveSubagentSlug(subagent)
  const toolId = `subagent_${toolKey}`

  return {
    serverName,
    toolName: toolId,
    fullToolName: `mcp__${serverName}__${toolId}`
  }
}

export function buildCliSubagentMcpToolName(
  agent: CliAgentToolNameRecord | null | undefined,
  subagent: CliSubagentToolNameRecord | null | undefined
) {
  return buildCliSubagentMcpToolReference(agent, subagent)?.fullToolName ?? null
}

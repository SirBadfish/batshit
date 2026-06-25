import { redis } from '$lib/server/redis'
import type { AgentRow, MCPToolSelections } from '$lib/types/database'
import { isManagedPrimaryAgentType, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { mcpGatewayService } from './mcpGatewayService'
import { mcpGatewayDiscovery } from './mcpGatewayDiscovery'
import type { ToolMetadataMap } from './mcpGatewayTypes'
import {
  LEGACY_AGENT_MCP_SELECTION_FIELDS,
  buildDynamicOnlySelectionResetKey
} from './mcpRuntimePolicy'

interface MCPSelectionResolverOptions {
  userId: string
  agentId?: string | null
  agent?: AgentRow | null
  agentMetadata?: Record<string, any> | null
  selectedGateways?: string[] | null
  toolSelections?: MCPToolSelections | null
  includeGatewayToolMap?: boolean
  /** SA-009: When true, this is a Codex/Mode 4 agent - inject artifact/Dynamic MCP tools but NOT file ops */
  isCodexMode?: boolean
}

export interface MCPSelectionResolution {
  resolvedGateways: string[]
  defaultGateways: string[] | null
  resolvedToolSelections: MCPToolSelections | undefined
  tools: ToolMetadataMap['tools']
  toolMetadata: ToolMetadataMap['metadata']
  gatewayToolMap: Record<string, string[]>
}

export interface DynamicMcpGatewayScopeResolution {
  resolvedGateways: string[]
  defaultGateways: string[] | null
  source: 'selected' | 'agent' | 'user-global'
}

/**
 * Merge agent defaults and chat overrides for MCP selections, then discover tools.
 * SA-009: MCPToolSelections is now a flat string[] of enabled tool names.
 */
export async function resolveMCPSelections(
  options: MCPSelectionResolverOptions
): Promise<MCPSelectionResolution> {
  const {
    userId,
    agentId,
    agent: preloadedAgent,
    agentMetadata,
    selectedGateways,
    toolSelections,
    includeGatewayToolMap,
    isCodexMode
  } = options

  if (!userId) {
    throw new Error('Cannot resolve MCP selections without a userId')
  }

  // Dynamic-only migration (one-time): clear legacy direct tool lists.
  await runDynamicOnlySelectionReset(userId)

  let agent: AgentRow | null | undefined = preloadedAgent
  if (!agent && agentId) {
    agent = (await redis.get(`agent:${agentId}`)) as AgentRow | null
  }

  const scopeResolution = await resolveDynamicMcpGatewayScope({
    userId,
    agentId,
    agent,
    agentMetadata,
    selectedGateways
  })
  const { resolvedGateways, defaultGateways } = scopeResolution
  // SA-009: Tool selections are now flat string arrays
  const defaultSelections = normalizeToolSelectionsInput(
    agentMetadata?.defaultMCPToolSelections ?? agent?.defaultMCPToolSelections
  )
  const overrideSelections = normalizeToolSelectionsInput(toolSelections)
  let resolvedToolSelections = mergeToolSelections(defaultSelections, overrideSelections)

  if (agent && !isBatshitAgent(agent)) {
    resolvedToolSelections = filterBlockedTools(resolvedToolSelections)
  }

  const gatewayToolMap =
    includeGatewayToolMap === true
      ? await mcpGatewayDiscovery.buildGatewayToolMap({
          userId,
          selectedGatewayIds: resolvedGateways,
          toolSelections: resolvedToolSelections
        })
      : {}

  // Dynamic MCP-only runtime: gateway tools are never directly preloaded/injected.
  return {
    resolvedGateways,
    defaultGateways,
    resolvedToolSelections,
    tools: {},
    toolMetadata: new Map(),
    gatewayToolMap
  }
}

export async function resolveDynamicMcpGatewayScope(
  options: Pick<
    MCPSelectionResolverOptions,
    'userId' | 'agentId' | 'agent' | 'agentMetadata' | 'selectedGateways'
  >
): Promise<DynamicMcpGatewayScopeResolution> {
  const { userId, agentId, agent: preloadedAgent, agentMetadata, selectedGateways } = options
  const hasScopedAgent =
    (typeof agentId === 'string' && agentId.trim().length > 0) ||
    preloadedAgent !== undefined ||
    agentMetadata !== undefined
  const overrideGateways = sanitizeStringArray(selectedGateways)
  if (overrideGateways !== undefined) {
    return {
      resolvedGateways: overrideGateways,
      defaultGateways: null,
      source: 'selected'
    }
  }

  let agent: AgentRow | null | undefined = preloadedAgent
  if (!agent && agentId) {
    agent = (await redis.get(`agent:${agentId}`)) as AgentRow | null
  }

  const defaultGateways = extractDefaultGateways(agentMetadata, agent)
  if (Array.isArray(defaultGateways)) {
    return {
      resolvedGateways: defaultGateways,
      defaultGateways,
      source: 'agent'
    }
  }

  if (hasScopedAgent) {
    return {
      resolvedGateways: [],
      defaultGateways: [],
      source: 'agent'
    }
  }

  const enabledGateways = await mcpGatewayService.listEnabled(userId)
  const fallbackGateways = Array.from(
    new Set(
      enabledGateways
        .map((gateway) => (typeof gateway?.id === 'string' ? gateway.id.trim() : ''))
        .filter((gatewayId) => gatewayId.length > 0)
    )
  )

  return {
    resolvedGateways: fallbackGateways,
    defaultGateways: null,
    source: 'user-global'
  }
}

function isBatshitAgent(agent: AgentRow | null) {
  if (!agent) return false
  return isManagedPrimaryAgentType(normalizePrimaryAgentType(agent))
}

function filterBlockedTools(selections: MCPToolSelections | undefined) {
  if (!Array.isArray(selections)) return selections
  return selections.filter((tool) => {
    const normalized = tool?.toLowerCase?.() ?? ''
    if (!normalized) return false
    return !normalized.includes('code-mode') && !normalized.includes('code_mode')
  })
}

function extractDefaultGateways(
  agentMetadata?: Record<string, any> | null,
  agent?: AgentRow | null
): string[] | null {
  const metadataValue = agentMetadata?.defaultMCPGateways ?? agentMetadata?.default_mcp_gateways
  const agentValue = agent?.defaultMCPGateways ?? (agent as any)?.default_mcp_gateways

  if (Array.isArray(metadataValue)) {
    return sanitizeStringArray(metadataValue) ?? []
  }
  if (Array.isArray(agentValue)) {
    return sanitizeStringArray(agentValue) ?? []
  }
  return null
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)

  // Preserve empty arrays to represent "disable all"
  return Array.from(new Set(normalized))
}

/**
 * SA-009: Normalize tool selections - now just a flat string array
 */
function normalizeToolSelectionsInput(
  selections?: MCPToolSelections | null
): MCPToolSelections | undefined {
  // SA-009: MCPToolSelections is now string[]
  if (!selections) {
    return undefined
  }

  // Handle new format (flat array)
  if (Array.isArray(selections)) {
    const cleaned = selections
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
    return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined
  }

  // Legacy format (nested object) - extract all tool names and flatten
  // This handles any old data that might still be in the nested format
  if (typeof selections === 'object') {
    const allTools: string[] = []
    for (const mcpSelections of Object.values(selections)) {
      if (!mcpSelections || typeof mcpSelections !== 'object') continue
      for (const toolList of Object.values(mcpSelections as Record<string, string[] | undefined>)) {
        if (Array.isArray(toolList)) {
          toolList.forEach((t) => {
            if (typeof t === 'string' && t.trim().length > 0) {
              allTools.push(t.trim())
            }
          })
        }
      }
    }
    if (allTools.length > 0) {
      return Array.from(new Set(allTools))
    }
  }

  return undefined
}

/**
 * SA-009: Merge tool selections - just combine two string arrays
 */
export function mergeToolSelections(
  defaults?: MCPToolSelections,
  overrides?: MCPToolSelections
): MCPToolSelections | undefined {
  const defaultSet = new Set(Array.isArray(defaults) ? defaults : [])
  const hasOverrideInput = Array.isArray(overrides)
  const overrideSet = new Set(Array.isArray(overrides) ? overrides : [])

  // If overrides are provided (even an empty array), treat them as explicit.
  if (hasOverrideInput) {
    return Array.from(overrideSet).sort()
  }

  // Otherwise use defaults
  if (defaultSet.size > 0) {
    return Array.from(defaultSet).sort()
  }

  return undefined
}

async function runDynamicOnlySelectionReset(userId: string): Promise<void> {
  const markerKey = buildDynamicOnlySelectionResetKey(userId)

  const alreadyReset = await redis.execute(async (client) => {
    const marker = await client.get(markerKey)
    return typeof marker === 'string' && marker.trim().length > 0
  })
  if (alreadyReset) return

  const agents = await redis.getAgents(userId)

  for (const agent of agents) {
    if (!agent?.id) continue
    const hasCamelSelections =
      Array.isArray((agent as any)[LEGACY_AGENT_MCP_SELECTION_FIELDS[0]]) &&
      (agent as any)[LEGACY_AGENT_MCP_SELECTION_FIELDS[0]].length > 0
    const hasSnakeSelections =
      Array.isArray((agent as any)[LEGACY_AGENT_MCP_SELECTION_FIELDS[1]]) &&
      (agent as any)[LEGACY_AGENT_MCP_SELECTION_FIELDS[1]].length > 0

    if (!hasCamelSelections && !hasSnakeSelections) continue

    const nextAgent = {
      ...agent,
      [LEGACY_AGENT_MCP_SELECTION_FIELDS[0]]: [],
      [LEGACY_AGENT_MCP_SELECTION_FIELDS[1]]: []
    }
    await redis.set(`agent:${agent.id}`, nextAgent)
  }

  await redis.execute(async (client) => {
    await client.set(markerKey, new Date().toISOString())
  })
}

// Export helpers for unit tests
export const __testUtils = {
  sanitizeStringArray,
  normalizeToolSelectionsInput
}

import { createDefaultGatewayDcmDisplaySettings } from '$lib/utils/dcmDisplaySettings'
// SA-096: visibility comes from the shared leaf module, not the index. Importing these
// from `dynamicMcpIndex` re-closes the cycle CI blocks at a zero budget.
import {
  resolveAgentDcmDisplaySettings,
  resolveGatewayDisplayDefaults,
  resolveMcpToolDcmVisibility
} from './dynamicMcpVisibility'
import { mcpGatewayDiscovery } from './mcpGatewayDiscovery'
import { resolveDynamicMcpGatewayScope } from './mcpSelectionResolver'
import { shouldHideInternalMcpTool } from './nativeToolConstants'
import type { AgentDcmDisplaySettings } from '$lib/types/database'

export const MAX_DYNAMIC_MCP_RESULTS = 20
export const DEFAULT_DYNAMIC_MCP_RESULTS = 5

export type GatewayToolsLoadResult = {
  tools: Record<string, any>
  metadata: Map<string, any>
}

export type GatewayToolsCache = Map<string, Promise<GatewayToolsLoadResult>>

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return normalized.length > 0 ? Array.from(new Set(normalized)) : []
}

function normalizeGroupFilters(group: unknown): string[] {
  if (Array.isArray(group)) {
    return group
      .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
      .filter(Boolean)
  }
  if (typeof group === 'string' && group.trim().length > 0) {
    return [group.trim().toLowerCase()]
  }
  return []
}

function extractSchema(toolDef: any): Record<string, any> | null {
  if (!toolDef || typeof toolDef !== 'object') return null
  const schema =
    toolDef.inputSchema?.jsonSchema || toolDef.inputSchema || toolDef.parameters || toolDef.schema
  return schema && typeof schema === 'object' ? schema : null
}

function scoreDynamicMatch(options: {
  query: string
  toolName: string
  originalToolName?: string | null
  description: string
  groupName: string
}): number {
  const query = options.query.toLowerCase().trim()
  if (!query) return 1

  const name = options.toolName.toLowerCase()
  const originalName = options.originalToolName?.toLowerCase()?.trim() ?? ''
  const description = options.description.toLowerCase()
  const group = options.groupName.toLowerCase()

  if (name === query) return 120
  if (originalName && originalName === query) return 115
  if (name.startsWith(query)) return 90
  if (originalName && originalName.startsWith(query)) return 85
  if (name.includes(query)) return 70
  if (originalName && originalName.includes(query)) return 65
  if (group.includes(query)) return 50
  if (description.includes(query)) return 30

  const tokens = query.split(/\s+/).filter(Boolean)
  let score = 0
  for (const token of tokens) {
    if (name.includes(token)) score += 10
    else if (originalName && originalName.includes(token)) score += 9
    else if (group.includes(token)) score += 6
    else if (description.includes(token)) score += 4
  }

  return score
}

function sanitizeDynamicLookupName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function resolveToolKeyByName(options: {
  tools: Record<string, any>
  metadata: Map<string, any>
  requestedToolName: string
}): string | null {
  const requested = options.requestedToolName.trim()
  if (!requested) return null
  const toolNames = Object.keys(options.tools)

  if (options.tools[requested]) return requested

  const requestedLower = requested.toLowerCase()
  const directInsensitive = toolNames.find((name) => name.toLowerCase() === requestedLower)
  if (directInsensitive) return directInsensitive

  const sanitizedRequested = sanitizeDynamicLookupName(requested)
  if (options.tools[sanitizedRequested]) return sanitizedRequested

  const sanitizedLower = sanitizedRequested.toLowerCase()
  const sanitizedInsensitive = toolNames.find((name) => name.toLowerCase() === sanitizedLower)
  if (sanitizedInsensitive) return sanitizedInsensitive

  for (const [toolName, meta] of options.metadata.entries()) {
    const original = typeof meta?.originalToolName === 'string' ? meta.originalToolName.trim() : ''
    if (!original) continue
    if (original.toLowerCase() === requestedLower) return toolName
    if (sanitizeDynamicLookupName(original).toLowerCase() === sanitizedLower) return toolName
  }

  const suffixMatch = toolNames.find((name) => name.toLowerCase().endsWith(`_${sanitizedLower}`))
  if (suffixMatch) return suffixMatch

  return null
}

async function loadGatewayToolsUncached(options: {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  selectedGateways?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  projectPath?: string | null
}): Promise<GatewayToolsLoadResult> {
  const scopeResolution = await resolveDynamicMcpGatewayScope({
    userId: options.userId,
    agentId: options.agentId ?? null,
    agentMetadata: options.agentMetadata ?? null,
    selectedGateways: normalizeStringArray(options.selectedGateways)
  })

  const result = await mcpGatewayDiscovery.loadToolsForUser(
    options.userId,
    Array.from(new Set(scopeResolution.resolvedGateways)),
    undefined,
    {
      skipFiltering: true,
      projectPath: options.projectPath ?? null
    }
  )

  const dcmDisplaySettings = await resolveAgentDcmDisplaySettings({
    agentId: options.agentId ?? null,
    dcmDisplaySettings: options.dcmDisplaySettings ?? null
  })
  const gatewayDefaults = await resolveGatewayDisplayDefaults(options.userId)

  const filteredTools: Record<string, any> = {}
  const filteredMetadata = new Map<string, any>()

  for (const [toolName, toolDef] of Object.entries(result.tools)) {
    if (shouldHideInternalMcpTool(toolName)) continue

    const toolMeta = result.metadata.get(toolName)
    const gatewayId = toolMeta?.gatewayId || 'unknown'
    const baseGroupName = (toolMeta?.mcpServerName || 'Ungrouped Tools').trim() || 'Ungrouped Tools'
    const gatewayDcmDefaults =
      gatewayDefaults.get(gatewayId) ?? createDefaultGatewayDcmDisplaySettings()

    const visibility = resolveMcpToolDcmVisibility({
      agentSettings: dcmDisplaySettings,
      gatewayDefaults: gatewayDcmDefaults,
      gatewayId,
      groupName: baseGroupName,
      toolNameVariants: [toolMeta?.originalToolName || '', toolName]
    })

    if (!visibility.isToolDiscoverable) continue

    filteredTools[toolName] = toolDef
    if (toolMeta) filteredMetadata.set(toolName, toolMeta)
  }

  return { tools: filteredTools, metadata: filteredMetadata }
}

export async function loadDynamicMcpGatewayTools(options: {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  selectedGateways?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  projectPath?: string | null
  cache?: GatewayToolsCache
}): Promise<GatewayToolsLoadResult> {
  const cacheKey = options.cache
    ? JSON.stringify({
        userId: options.userId,
        agentId: options.agentId ?? null,
        agentMetadata: options.agentMetadata ?? null,
        selectedGateways: normalizeStringArray(options.selectedGateways),
        dcmDisplaySettings: options.dcmDisplaySettings ?? null,
        projectPath: options.projectPath ?? null
      })
    : null

  if (options.cache && cacheKey) {
    const cached = options.cache.get(cacheKey)
    if (cached) return cached
  }

  const loadPromise = loadGatewayToolsUncached(options)
  if (options.cache && cacheKey) {
    options.cache.set(
      cacheKey,
      loadPromise.catch((error) => {
        options.cache?.delete(cacheKey)
        throw error
      })
    )
  }

  return loadPromise
}

export async function executeDynamicMcpFind(input: {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  query?: string
  tool?: string
  group?: string | string[]
  exact?: boolean
  limit?: number | string
  selectedGateways?: string[]
  includeSchema?: boolean
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  projectPath?: string | null
  gatewayToolsCache?: GatewayToolsCache
}): Promise<Record<string, any>> {
  const normalizedLimit = clamp(
    parseInteger(input.limit) ?? DEFAULT_DYNAMIC_MCP_RESULTS,
    1,
    MAX_DYNAMIC_MCP_RESULTS
  )
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const exact = input.exact === true
  const targetTool = typeof input.tool === 'string' ? input.tool.trim() : ''
  const groupFilters = normalizeGroupFilters(input.group)
  const includeSchema = input.includeSchema === true

  const { tools, metadata } = await loadDynamicMcpGatewayTools({
    userId: input.userId,
    agentId: input.agentId ?? null,
    agentMetadata: input.agentMetadata ?? null,
    selectedGateways: input.selectedGateways,
    dcmDisplaySettings: input.dcmDisplaySettings ?? null,
    projectPath: input.projectPath ?? null,
    cache: input.gatewayToolsCache
  })

  const allEntries = Object.entries(tools)
    .map(([toolName, toolDef]) => {
      const meta = metadata.get(toolName)
      const groupName = meta?.mcpServerName || 'Ungrouped Tools'
      const originalToolName =
        typeof meta?.originalToolName === 'string' && meta.originalToolName.trim().length > 0
          ? meta.originalToolName.trim()
          : null
      const description = (toolDef as any)?.description || ''
      const score = scoreDynamicMatch({
        query: targetTool || query,
        toolName,
        originalToolName,
        description,
        groupName
      })

      return {
        toolName,
        originalToolName,
        description,
        groupName,
        gatewayId: meta?.gatewayId ?? null,
        gatewayName: meta?.gatewayName ?? null,
        score,
        ...(includeSchema ? { inputSchema: extractSchema(toolDef) } : {})
      }
    })
    .filter((entry) => {
      if (targetTool) {
        const targetLower = targetTool.toLowerCase()
        const originalLower = entry.originalToolName?.toLowerCase() ?? ''
        const sanitizedOriginal = entry.originalToolName
          ? sanitizeDynamicLookupName(entry.originalToolName).toLowerCase()
          : ''
        if (exact) {
          return (
            entry.toolName.toLowerCase() === targetLower ||
            originalLower === targetLower ||
            sanitizedOriginal === targetLower
          )
        }
        return (
          entry.toolName.toLowerCase().includes(targetLower) ||
          originalLower.includes(targetLower) ||
          (sanitizedOriginal ? sanitizedOriginal.includes(targetLower) : false)
        )
      }

      if (groupFilters.length > 0) {
        const groupName = entry.groupName.toLowerCase()
        const matchesGroup = groupFilters.some((filter) => groupName.includes(filter))
        if (!matchesGroup) return false
      }

      if (!query) return true
      return entry.score > 0
    })
    .sort((left, right) => right.score - left.score || left.toolName.localeCompare(right.toolName))

  return {
    results: allEntries.slice(0, normalizedLimit),
    totalMatches: allEntries.length,
    query: targetTool || query,
    limit: normalizedLimit
  }
}

export async function executeDynamicMcpUse(input: {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  toolName: string
  params?: Record<string, any>
  selectedGateways?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  projectPath?: string | null
  gatewayToolsCache?: GatewayToolsCache
  internalToolError?: string
}): Promise<Record<string, any>> {
  const toolName = input.toolName.trim()
  const params = input.params && typeof input.params === 'object' ? input.params : {}

  if (shouldHideInternalMcpTool(toolName)) {
    return {
      success: false,
      toolName,
      error: input.internalToolError ?? `Tool "${toolName}" is internal-only and not callable.`
    }
  }

  const startedAt = Date.now()
  const { tools, metadata } = await loadDynamicMcpGatewayTools({
    userId: input.userId,
    agentId: input.agentId ?? null,
    agentMetadata: input.agentMetadata ?? null,
    selectedGateways: input.selectedGateways,
    dcmDisplaySettings: input.dcmDisplaySettings ?? null,
    projectPath: input.projectPath ?? null,
    cache: input.gatewayToolsCache
  })

  const resolvedToolName = resolveToolKeyByName({
    tools,
    metadata,
    requestedToolName: toolName
  })
  const toolDef = resolvedToolName ? tools[resolvedToolName] : undefined
  if (!resolvedToolName || !toolDef) {
    const requestedSanitized = sanitizeDynamicLookupName(toolName).toLowerCase()
    const suggestions = Object.keys(tools)
      .filter((candidate) => {
        const lower = candidate.toLowerCase()
        return lower.includes(toolName.toLowerCase()) || (requestedSanitized && lower.includes(requestedSanitized))
      })
      .slice(0, 5)

    return {
      success: false,
      toolName,
      error:
        suggestions.length > 0
          ? `Tool "${toolName}" not found. Did you mean: ${suggestions.join(', ')}?`
          : `Tool "${toolName}" not found.`
    }
  }

  const execute = (toolDef as any).execute
  if (typeof execute !== 'function') {
    return {
      success: false,
      toolName: resolvedToolName,
      error: `Tool "${resolvedToolName}" does not expose an execute() function.`
    }
  }

  const result = await execute(params)
  const meta = metadata.get(resolvedToolName)

  return {
    success: true,
    toolName: resolvedToolName,
    requestedToolName: toolName,
    result,
    executionTimeMs: Date.now() - startedAt,
    gatewayId: meta?.gatewayId ?? null,
    gatewayName: meta?.gatewayName ?? null,
    groupName: meta?.mcpServerName ?? null,
    originalToolName: meta?.originalToolName ?? null
  }
}

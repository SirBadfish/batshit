/**
 * Dynamic MCP Tool Find API
 * SA-009: Batshit Dynamic MCP
 *
 * POST /api/mcp/tools/find - Search all gateways for tools matching a query
 *
 * Supports:
 * - Session auth (normal user session)
 * - Service token auth (batshit-server tool calls via x-batshit-service-token header)
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { logger } from '$lib/utils/logger'
import { mcpGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import { resolveDynamicMcpGatewayScope } from '$lib/server/services/mcpSelectionResolver'
import { redis } from '$lib/server/redis'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import {
  buildSchemaSummary,
  getSchemaHintText,
  normalizeSchemaHintCaps
} from '$lib/server/services/dynamicMcpSchema'
import {
  buildCompositeKey,
  createDefaultGatewayDcmDisplaySettings,
  resolveAgentDcmDisplaySettings,
  resolveMcpToolDcmVisibility,
  resolveGatewayDisplayDefaults
} from '$lib/server/services/dynamicMcpIndex'
import type { AgentDcmDisplaySettings } from '$lib/types/database'

interface FindRequest {
  userId?: string        // Required for service token auth
  agentId?: string       // Optional: exclude enabled tools for this agent
  query?: string         // Search term (optional when tool/group provided)
  tool?: string          // Exact tool name (skips search)
  group?: string | string[] // MCP group filter(s)
  exact?: boolean        // If true, only exact tool name matches
  limit?: number         // Optional: max results (default 5, max 20)
  schema?: 'compact' | 'full' | 'none'
  includeEnabled?: boolean
  toolSelections?: string[]
  selectedGateways?: string[]
  gatewayFilter?: string[] // Legacy alias for selectedGateways
  dcmDisplaySettings?: AgentDcmDisplaySettings
}

interface ToolResult {
  toolName: string
  description: string    // Truncated to ~150 chars
  groupName: string | null  // MCP group name (user-defined)
  schemaHint?: string | null
  inputSchema?: Record<string, any> | null
}

interface FindResponse {
  results: ToolResult[]
  totalMatches: number
  query: string
}

const UNGROUPED_GROUP = 'Ungrouped Tools'
const UNKNOWN_GATEWAY = 'unknown_gateway'

/**
 * Truncate description to ~150 chars
 */
function truncateDescription(desc: string | undefined, maxLen: number = 150): string {
  if (!desc) return ''
  if (desc.length <= maxLen) return desc
  return desc.slice(0, maxLen - 3) + '...'
}

/**
 * Search matches against a query (case-insensitive)
 */
const SYNONYM_TABLE: Record<string, string[]> = {
  'search': ['find', 'lookup', 'query'],
  'web search': ['websearch', 'browser', 'internet', 'serp', 'google', 'bing', 'duckduckgo', 'tavily', 'firecrawl'],
  'read': ['view', 'open', 'cat'],
  'write': ['save', 'create', 'overwrite'],
  'edit': ['modify', 'update', 'patch'],
  'file': ['fs', 'filesystem', 'path', 'document'],
  'list': ['ls', 'dir', 'directory'],
  'command': ['run', 'shell', 'bash', 'execute', 'terminal'],
  'execute': ['run', 'shell', 'bash', 'command'],
  'database': ['db', 'sql', 'postgres', 'mysql', 'sqlite'],
  'http': ['fetch', 'request', 'api', 'url'],
  'redis': ['cache', 'json'],
  'workflow': ['n8n', 'flow'],
  'artifact': ['widget', 'miniapp'],
  'mcp': ['tool']
}

type SearchContext = {
  normalizedQuery: string
  tokens: string[]
}

type SearchFields = {
  name: string
  nameTokens: string[]
  description: string
  group: string
  propertyBlob: string
}

function tokenize(str: string): string[] {
  return str
    .split(/[^a-z0-9]+/i)
    .map(s => s.toLowerCase())
    .filter(Boolean)
}

function expandTokens(query: string): string[] {
  const normalized = query.toLowerCase().trim()
  const tokens = tokenize(normalized)
  const expanded = new Set<string>(tokens)

  const addSynonyms = (key: string) => {
    const syns = SYNONYM_TABLE[key]
    if (syns) syns.forEach(s => expanded.add(s))
  }

  // Phrase-level synonyms (e.g., "web search")
  addSynonyms(normalized)

  // Token-level synonyms
  tokens.forEach(token => addSynonyms(token))

  return Array.from(expanded)
}

function scoreMatch(search: SearchContext, fields: SearchFields): number {
  const { normalizedQuery, tokens } = search
  const { name, nameTokens, description, group, propertyBlob } = fields

  let score = 0

  if (normalizedQuery && name === normalizedQuery) score += 120
  else if (normalizedQuery && name.startsWith(normalizedQuery)) score += 90
  else if (normalizedQuery && name.includes(normalizedQuery)) score += 70

  if (normalizedQuery && description.includes(normalizedQuery)) score += 25
  if (normalizedQuery && group.includes(normalizedQuery)) score += 30

  let tokenHits = 0

  for (const token of tokens) {
    if (!token) continue

    if (nameTokens.includes(token)) {
      score += 14
      tokenHits++
      continue
    }

    if (name.includes(token)) {
      score += 12
      tokenHits++
      continue
    }

    if (description.includes(token)) {
      score += 8
      tokenHits++
      continue
    }

    if (group.includes(token)) {
      score += 6
      tokenHits++
      continue
    }

    if (propertyBlob.includes(token)) {
      score += 4
      tokenHits++
    }
  }

  // Filter out extremely weak matches
  if (tokenHits === 0 && score < 40) {
    return 0
  }

  return score
}

function normalizeSchemaMode(value: unknown): 'compact' | 'full' | 'none' {
  if (value === 'full' || value === 'none' || value === 'compact') return value
  return 'compact'
}

function normalizeGroupFilters(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((entry) => String(entry).trim()).filter(Boolean)
  }
  if (typeof input === 'string') {
    const trimmed = input.trim()
    return trimmed ? [trimmed] : []
  }
  return []
}

function extractSchema(tool: any): Record<string, any> | null {
  if (!tool || typeof tool !== 'object') return null
  return tool.inputSchema?.jsonSchema || tool.inputSchema || tool.parameters || tool.schema || null
}

export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    const body = await request.json() as FindRequest
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const toolFilter = typeof body.tool === 'string' ? body.tool.trim() : ''
    const groupFilters = normalizeGroupFilters(body.group)
    const exact = body.exact === true
    const schemaMode = normalizeSchemaMode(body.schema)
    const limit = typeof body.limit === 'number' ? body.limit : 5

    // Validate query
    if (!toolFilter && !query && groupFilters.length === 0) {
      return json({ error: 'query, tool, or group is required' }, { status: 400 })
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })
    if (!auth) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userId = auth.userId
    if (auth.auth === 'service') {
      logger.debug(`[MCP Tools Find] Service auth for user ${userId}`)
    }

    // Clamp limit
    const effectiveLimit = toolFilter ? 1 : Math.min(Math.max(1, limit), 20)

    // Dynamic MCP scope precedence:
    // explicit selectedGateways -> agent defaults -> user-global enabled gateways.
    const selectedGateways = Array.isArray(body.selectedGateways)
      ? body.selectedGateways
      : Array.isArray(body.gatewayFilter)
        ? body.gatewayFilter
        : undefined
    const scopeResolution = await resolveDynamicMcpGatewayScope({
      userId,
      agentId: body.agentId ?? null,
      selectedGateways
    })
    const resolvedGateways = scopeResolution.resolvedGateways

    // Load all tools from all gateways
    // SA-009: Use skipFiltering to get ALL tools regardless of agent settings
    const { tools, metadata } = await mcpGatewayDiscovery.loadToolsForUser(
      userId,
      resolvedGateways,
      undefined,     // No tool selections
      { skipFiltering: true }  // SA-009: Dynamic MCP find needs ALL tools
    )

    const normalizedGroupFilters = groupFilters.map((value) => value.toLowerCase())
    const dcmDisplaySettings = await resolveAgentDcmDisplaySettings({
      agentId: body.agentId ?? null,
      dcmDisplaySettings: body.dcmDisplaySettings
    })
    const gatewayDefaults = await resolveGatewayDisplayDefaults(userId)
    const baseGroupGatewayKeysByName = new Map<string, Set<string>>()

    for (const [toolName] of Object.entries(tools)) {
      const meta = metadata.get(toolName)
      if (!meta) continue
      const gatewayId = meta.gatewayId || UNKNOWN_GATEWAY
      const baseGroupName = (meta.mcpServerName || UNGROUPED_GROUP).trim() || UNGROUPED_GROUP
      const normalizedBase = baseGroupName.toLowerCase()
      const groupGatewayKey = buildCompositeKey(gatewayId, baseGroupName)
      if (!baseGroupGatewayKeysByName.has(normalizedBase)) {
        baseGroupGatewayKeysByName.set(normalizedBase, new Set<string>())
      }
      baseGroupGatewayKeysByName.get(normalizedBase)!.add(groupGatewayKey)
    }

    const userSettings = await redis.getUserSettings(userId)
    const admin = (userSettings?.admin_settings as Record<string, any>) ?? {}
    const schemaHintCaps = normalizeSchemaHintCaps({
      requiredLimit: admin.dcm_schema_hint_required_limit,
      optionalLimit: admin.dcm_schema_hint_optional_limit,
      maxChars: admin.dcm_schema_hint_max_chars
    })

    // Search and filter
    const searchQuery = query
    const searchContext: SearchContext = {
      normalizedQuery: searchQuery.toLowerCase(),
      tokens: searchQuery ? expandTokens(searchQuery) : []
    }

    const matches: Array<ToolResult & { _score: number }> = []

    for (const [toolName, tool] of Object.entries(tools)) {
      if (toolFilter && toolName.toLowerCase() !== toolFilter.toLowerCase()) {
        continue
      }

      const meta = metadata.get(toolName)
      if (!meta) continue

      const gatewayId = meta.gatewayId || UNKNOWN_GATEWAY
      const baseGroupName = (meta.mcpServerName || UNGROUPED_GROUP).trim() || UNGROUPED_GROUP
      const normalizedBaseGroupName = baseGroupName.toLowerCase()
      const isDisambiguated =
        (baseGroupGatewayKeysByName.get(normalizedBaseGroupName)?.size ?? 0) > 1
      const groupName = isDisambiguated ? `${baseGroupName} [${meta.gatewayName}]` : baseGroupName
      const gatewayDcmDefaults =
        gatewayDefaults.get(gatewayId) ?? createDefaultGatewayDcmDisplaySettings()
      const visibility = resolveMcpToolDcmVisibility({
        agentSettings: dcmDisplaySettings,
        gatewayDefaults: gatewayDcmDefaults,
        gatewayId,
        groupName: baseGroupName,
        toolNameVariants: [meta.originalToolName || '', toolName]
      })

      if (!visibility.isToolDiscoverable) {
        continue
      }

      // Get tool description
      const description = (tool as any).description || ''

      if (normalizedGroupFilters.length > 0) {
        const normalizedDisplayGroupName = groupName.toLowerCase()
        const matchesGroupFilter = normalizedGroupFilters.some(
          (filter) =>
            normalizedDisplayGroupName === filter || normalizedBaseGroupName === filter
        )
        if (!matchesGroupFilter) {
          continue
        }
      }

      const inputSchema = extractSchema(tool)
      const propertyNames = inputSchema?.properties ? Object.keys(inputSchema.properties) : []

      const fields: SearchFields = {
        name: toolName.toLowerCase(),
        nameTokens: tokenize(toolName),
        description: description.toLowerCase(),
        group: (groupName || '').toLowerCase(),
        propertyBlob: propertyNames.join(' ').toLowerCase()
      }

      let score = 0
      if (toolFilter) {
        score = 200
      } else if (searchQuery) {
        if (exact && toolName.toLowerCase() !== searchContext.normalizedQuery) {
          score = 0
        } else {
          score = scoreMatch(searchContext, fields)
        }
      } else {
        score = 1
      }

      if (score > 0) {
        let schemaHint: string | null = null
        let schemaPayload: Record<string, any> | null = null

        if (schemaMode === 'full') {
          schemaPayload = inputSchema
        } else if (schemaMode === 'compact') {
          const summary = buildSchemaSummary(inputSchema, schemaHintCaps)
          schemaHint = getSchemaHintText(summary)
        }

        matches.push({
          toolName,
          description: truncateDescription(description),
          groupName,
          schemaHint,
          inputSchema: schemaMode === 'full' ? schemaPayload : undefined,
          _score: score
        })
      }
    }

    // Sort by score desc, then exact match, then name
    matches.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score
      const aExact = a.toolName.toLowerCase() === searchContext.normalizedQuery
      const bExact = b.toolName.toLowerCase() === searchContext.normalizedQuery
      if (aExact && !bExact) return -1
      if (bExact && !aExact) return 1
      return a.toolName.localeCompare(b.toolName)
    })

    // Limit results
    const limitedResults = matches.slice(0, effectiveLimit).map(({ _score, ...rest }) => rest)

    const response: FindResponse = {
      results: limitedResults,
      totalMatches: matches.length,
      query: searchQuery
    }

    logger.debug(
      `[MCP Tools Find] Found ${matches.length} matches for "${searchQuery}", returning ${limitedResults.length} (scope=${scopeResolution.source}, gateways=${resolvedGateways.length})`
    )

    return json(response)

  } catch (error) {
    console.error('[MCP Tools Find] Error:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to search tools' },
      { status: 500 }
    )
  }
}

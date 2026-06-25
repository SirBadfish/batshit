import { redis } from '$lib/server/redis'
import { mcpGatewayDiscovery } from './mcpGatewayDiscovery'
import { resolveMCPSelections } from './mcpSelectionResolver'
import type {
  AgentDcmDisplaySettings,
  AgentDcmGroupDisplayMode,
  DcmGroupDisplayMode,
  DcmToolDisplayMode,
  GatewayDcmDisplaySettings,
  MCPToolSelections
} from '$lib/types/database'
import {
  buildSchemaSummary,
  getSchemaHintText,
  normalizeSchemaHintCaps,
  type SchemaHintCaps
} from './dynamicMcpSchema'
import { shouldHideInternalMcpTool } from './nativeToolConstants'
import { listCliTools, resolveCliToolSelectionScope } from './cliToolRegistry'
import {
  CLI_TOOL_GRID_GROUP_NAME,
  CLI_TOOL_GRID_ID,
  normalizeCliToolGridSettings
} from '$lib/utils/toolGridCli'
import {
  createDefaultDcmDisplaySettings,
  createDefaultGatewayDcmDisplaySettings,
  normalizeDcmDisplaySettings,
  normalizeGatewayDcmDisplaySettings,
  normalizeLegacyDcmGroupMode as normalizeLegacyGroupMode,
  normalizeLegacyDcmToolMode as normalizeLegacyToolMode
} from '$lib/utils/dcmDisplaySettings'

export {
  createDefaultDcmDisplaySettings,
  createDefaultGatewayDcmDisplaySettings,
  normalizeDcmDisplaySettings,
  normalizeGatewayDcmDisplaySettings
}

export type DcmGroupVisibility = 'hidden' | 'group-only' | 'group+tools'
export type DcmToolVisibility = 'hidden' | 'name-only' | 'name+hint'

export interface DynamicMcpIndexTool {
  name: string
  visibility: DcmToolVisibility
  schemaHint?: string | null
}

export interface DynamicMcpIndexGroup {
  name: string
  toolCount: number
  visibility: DcmGroupVisibility
  tools?: DynamicMcpIndexTool[]
}

export interface DynamicMcpIndexResult {
  groups: DynamicMcpIndexGroup[]
  text: string
  tokenEstimates: {
    enabled: number
    dcm: number
    total: number
  }
  counts: {
    enabledTools: number
    availableTools: number
    dcmTools: number
    groups: number
  }
  threshold: number
  schemaHintCaps: SchemaHintCaps
}

interface DynamicMcpIndexOptions {
  userId: string
  agentId?: string | null
  toolSelections?: MCPToolSelections | null
  selectedGateways?: string[] | null
  selectedCliToolIds?: string[] | null
  projectPath?: string | null
  nativeDynamicMcpEnabled?: boolean | null
  cliToolsEnabled?: boolean | null
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  isCodexMode?: boolean
  includeEnabledTools?: boolean
  toolNameThreshold?: number
}

interface WorkingGroup extends DynamicMcpIndexGroup {
  gatewayId: string
  gatewayName: string
  baseName: string
  forceToolList?: boolean
}

const UNGROUPED_GROUP = 'Ungrouped Tools'
const UNKNOWN_GATEWAY = 'unknown_gateway'
const UNKNOWN_GATEWAY_LABEL = 'Unknown Gateway'
const DEFAULT_TOOL_NAME_THRESHOLD = 6
const MIN_TOOL_NAME_THRESHOLD = 1
const MAX_TOOL_NAME_THRESHOLD = 100
const REQUIRED_DYNAMIC_TOOLS = ['batshit_server_dynamic_mcp_find', 'batshit_server_dynamic_mcp_use']

export function buildCompositeKey(left: string, right: string): string {
  return `${left}::${right}`
}

export function mapGroupModeToVisibility(mode: DcmGroupDisplayMode): DcmGroupVisibility {
  if (mode === 'hidden') return 'hidden'
  if (mode === 'group-only') return 'group-only'
  return 'group+tools'
}

function mapGroupModeToDefaultToolVisibility(mode: DcmGroupDisplayMode): DcmToolVisibility {
  return mode === 'group+tools+names' ? 'name-only' : 'name+hint'
}

function mapToolModeToVisibility(mode: DcmToolDisplayMode): DcmToolVisibility {
  if (mode === 'name-only') return 'name-only'
  if (mode === 'hidden') return 'hidden'
  return 'name+hint'
}

function isExplicitAgentToolListMode(mode: AgentDcmGroupDisplayMode | undefined): boolean {
  return mode === 'group+tools+hints' || mode === 'group+tools+names'
}

export function resolveEffectiveGroupMode(options: {
  agentSettings: AgentDcmDisplaySettings
  gatewayDefaults: GatewayDcmDisplaySettings
  gatewayId: string
  groupName: string
}): DcmGroupDisplayMode {
  const { agentSettings, gatewayDefaults, gatewayId, groupName } = options
  const agentMode = agentSettings.groups[buildCompositeKey(gatewayId, groupName)]
  if (agentMode && agentMode !== 'use-global') {
    return normalizeLegacyGroupMode(agentMode) ?? 'group+tools+hints'
  }

  const gatewayMode = gatewayDefaults.groups[groupName]
  return normalizeLegacyGroupMode(gatewayMode) ?? 'group+tools+hints'
}

export function resolveEffectiveToolVisibility(options: {
  agentSettings: AgentDcmDisplaySettings
  gatewayDefaults: GatewayDcmDisplaySettings
  gatewayId: string
  toolNameVariants: string[]
  groupMode: DcmGroupDisplayMode
  agentGroupMode: AgentDcmGroupDisplayMode | undefined
}): DcmToolVisibility {
  const { agentSettings, gatewayDefaults, gatewayId, toolNameVariants, groupMode, agentGroupMode } =
    options

  const keys = toolNameVariants
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  let agentToolMode: DcmToolDisplayMode | null = null
  for (const name of keys) {
    const value = agentSettings.tools[buildCompositeKey(gatewayId, name)]
    const normalized = normalizeLegacyToolMode(value)
    if (normalized) {
      agentToolMode = normalized
      break
    }
  }

  if (agentToolMode && agentToolMode !== 'inherit') {
    return mapToolModeToVisibility(agentToolMode)
  }

  const agentGroupOverride = Boolean(agentGroupMode && agentGroupMode !== 'use-global')
  if (agentGroupOverride) {
    return mapGroupModeToDefaultToolVisibility(groupMode)
  }

  let gatewayToolMode: DcmToolDisplayMode | null = null
  for (const name of keys) {
    const value = gatewayDefaults.tools[name]
    const normalized = normalizeLegacyToolMode(value)
    if (normalized) {
      gatewayToolMode = normalized
      break
    }
  }

  if (gatewayToolMode && gatewayToolMode !== 'inherit') {
    return mapToolModeToVisibility(gatewayToolMode)
  }

  return mapGroupModeToDefaultToolVisibility(groupMode)
}

export function resolveMcpToolDcmVisibility(options: {
  agentSettings: AgentDcmDisplaySettings
  gatewayDefaults: GatewayDcmDisplaySettings
  gatewayId: string
  groupName: string
  toolNameVariants: string[]
}): {
  agentGroupMode: AgentDcmGroupDisplayMode | undefined
  effectiveGroupMode: DcmGroupDisplayMode
  groupVisibility: DcmGroupVisibility
  toolVisibility: DcmToolVisibility | null
  isGroupVisible: boolean
  isToolVisibleInDcm: boolean
  isToolDiscoverable: boolean
} {
  const agentGroupMode = options.agentSettings.groups[buildCompositeKey(options.gatewayId, options.groupName)]
  const effectiveGroupMode = resolveEffectiveGroupMode({
    agentSettings: options.agentSettings,
    gatewayDefaults: options.gatewayDefaults,
    gatewayId: options.gatewayId,
    groupName: options.groupName
  })
  const groupVisibility = mapGroupModeToVisibility(effectiveGroupMode)

  if (groupVisibility === 'hidden') {
    return {
      agentGroupMode,
      effectiveGroupMode,
      groupVisibility,
      toolVisibility: null,
      isGroupVisible: false,
      isToolVisibleInDcm: false,
      isToolDiscoverable: false
    }
  }

  if (groupVisibility === 'group-only') {
    return {
      agentGroupMode,
      effectiveGroupMode,
      groupVisibility,
      toolVisibility: null,
      isGroupVisible: true,
      isToolVisibleInDcm: false,
      isToolDiscoverable: true
    }
  }

  const toolVisibility = resolveEffectiveToolVisibility({
    agentSettings: options.agentSettings,
    gatewayDefaults: options.gatewayDefaults,
    gatewayId: options.gatewayId,
    toolNameVariants: options.toolNameVariants,
    groupMode: effectiveGroupMode,
    agentGroupMode
  })

  return {
    agentGroupMode,
    effectiveGroupMode,
    groupVisibility,
    toolVisibility,
    isGroupVisible: true,
    isToolVisibleInDcm: toolVisibility !== 'hidden',
    isToolDiscoverable: toolVisibility !== 'hidden'
  }
}

function hasRequiredDynamicTools(enabledNames: Set<string>): boolean {
  const normalized = new Set([...enabledNames].map((name) => name.toLowerCase()))
  const hasFind =
    normalized.has(REQUIRED_DYNAMIC_TOOLS[0]) ||
    normalized.has('dynamic_mcp_find') ||
    normalized.has('native_dynamic_mcp_find')
  const hasUse =
    normalized.has(REQUIRED_DYNAMIC_TOOLS[1]) ||
    normalized.has('dynamic_mcp_use') ||
    normalized.has('native_dynamic_mcp_use')
  return hasFind && hasUse
}

function isDynamicMcpEnabled(
  options: DynamicMcpIndexOptions,
  enabledNames: Set<string>
): boolean {
  if (typeof options.nativeDynamicMcpEnabled === 'boolean') {
    return options.nativeDynamicMcpEnabled
  }
  if (options.isCodexMode === true) {
    return true
  }
  return hasRequiredDynamicTools(enabledNames)
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

function normalizeToolNameThreshold(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  return Math.min(MAX_TOOL_NAME_THRESHOLD, Math.max(MIN_TOOL_NAME_THRESHOLD, rounded))
}

function extractSchema(tool: any): any {
  if (!tool || typeof tool !== 'object') return null
  return tool.inputSchema?.jsonSchema || tool.inputSchema || tool.parameters || tool.schema || null
}

function formatGroupLine(name: string, count: number): string {
  const label = count === 1 ? 'tool' : 'tools'
  return `- ${name} (${count} ${label})`
}

function buildDcmText(groups: DynamicMcpIndexGroup[]): string {
  const lines: string[] = []
  lines.push('tool_discovery')
  lines.push('(current discoverable tools and hints for this agent)')

  for (const group of groups) {
    if (group.visibility === 'hidden') continue
    if (!group.toolCount) continue

    if (
      group.visibility === 'group+tools' &&
      Array.isArray(group.tools) &&
      group.tools.length > 0
    ) {
      lines.push(`${formatGroupLine(group.name, group.toolCount)}:`)
      for (const tool of group.tools) {
        const hint =
          tool.visibility === 'name+hint' && tool.schemaHint
            ? ` — ${tool.schemaHint}`
            : ''
        lines.push(`  - ${tool.name}${hint}`)
      }
    } else {
      lines.push(formatGroupLine(group.name, group.toolCount))
    }
  }

  return lines.join('\n')
}

function buildCliFieldSummary(inputSchema: Record<string, any> | undefined): string {
  if (!inputSchema || typeof inputSchema !== 'object') return ''
  const properties =
    inputSchema.properties && typeof inputSchema.properties === 'object'
      ? Object.entries(inputSchema.properties as Record<string, any>)
      : []
  if (properties.length === 0) return ''

  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((value: unknown): value is string => typeof value === 'string')
      : []
  )

  return properties
    .slice(0, 4)
    .map(([fieldName, field]) => {
      const type =
        typeof field?.type === 'string'
          ? field.type
          : field?.type === 'array' && typeof field?.items?.type === 'string'
            ? `array<${field.items.type}>`
            : 'value'
      return required.has(fieldName) ? `${fieldName}:${type}*` : `${fieldName}:${type}`
    })
    .join(', ')
}

function buildCliToolHint(record: Record<string, any>): string {
  const parts: string[] = []
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const schemaSummary = buildCliFieldSummary(record.inputSchema)

  if (title) parts.push(title)
  if (description) parts.push(description)
  if (schemaSummary) parts.push(schemaSummary)

  return parts.join(' — ')
}

async function resolveEnabledTools(
  options: DynamicMcpIndexOptions
): Promise<{ names: Set<string>; tools: Record<string, any>; resolvedGateways?: string[] }> {
  const {
    userId,
    agentId,
    toolSelections,
    selectedGateways,
    isCodexMode
  } = options

  if (!userId) return { names: new Set<string>(), tools: {}, resolvedGateways: undefined }

  if (
    !agentId &&
    (!toolSelections || toolSelections.length === 0) &&
    (!selectedGateways || selectedGateways.length === 0)
  ) {
    return { names: new Set<string>(), tools: {}, resolvedGateways: undefined }
  }

  const resolution = await resolveMCPSelections({
    userId,
    agentId: agentId ?? undefined,
    selectedGateways: selectedGateways ?? undefined,
    toolSelections: toolSelections ?? undefined,
    isCodexMode: isCodexMode ?? false
  })

  const names = new Set<string>(
    Array.isArray(resolution.resolvedToolSelections) ? resolution.resolvedToolSelections : []
  )
  return {
    names,
    tools: {},
    resolvedGateways: resolution.resolvedGateways
  }
}

export async function resolveAgentDcmDisplaySettings(options: {
  agentId?: string | null
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
}): Promise<AgentDcmDisplaySettings> {
  if (options.dcmDisplaySettings) {
    return normalizeDcmDisplaySettings(options.dcmDisplaySettings)
  }

  const agentId = options.agentId?.trim()
  if (!agentId) {
    return createDefaultDcmDisplaySettings()
  }

  try {
    const agent = (await redis.get(`agent:${agentId}`)) as Record<string, unknown> | null
    return normalizeDcmDisplaySettings(
      agent?.dcmDisplaySettings ?? agent?.dcm_display_settings ?? null
    )
  } catch (error) {
    console.warn('[Dynamic MCP DCM] Failed to resolve agent DCM display settings:', error)
    return createDefaultDcmDisplaySettings()
  }
}

export async function resolveGatewayDisplayDefaults(
  userId: string
): Promise<Map<string, GatewayDcmDisplaySettings>> {
  try {
    const gateways = await redis.execute(async (client) => {
      const data = await client.json.get(`mcp_gateways:${userId}`)
      const value = Array.isArray(data) ? data[0] : data
      const registry = (value || {}) as { gateways?: Array<Record<string, unknown>> }
      return Array.isArray(registry.gateways) ? registry.gateways : []
    })

    const map = new Map<string, GatewayDcmDisplaySettings>()
    for (const gateway of gateways) {
      const id = typeof gateway?.id === 'string' ? gateway.id : ''
      if (!id) continue
      map.set(
        id,
        normalizeGatewayDcmDisplaySettings(
          (gateway as Record<string, unknown>).dcmDisplayDefaults
        )
      )
    }

    return map
  } catch (error) {
    console.warn('[Dynamic MCP DCM] Failed to resolve gateway defaults:', error)
    return new Map<string, GatewayDcmDisplaySettings>()
  }
}

function applyDuplicateGroupDisambiguation(groups: WorkingGroup[]) {
  const counts = new Map<string, number>()
  for (const group of groups) {
    const normalized = group.baseName.trim().toLowerCase()
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }

  for (const group of groups) {
    const normalized = group.baseName.trim().toLowerCase()
    if ((counts.get(normalized) ?? 0) > 1) {
      group.name = `${group.baseName} [${group.gatewayName}]`
    }
  }
}

export async function buildDynamicMcpIndex(
  options: DynamicMcpIndexOptions
): Promise<DynamicMcpIndexResult> {
  const { userId, includeEnabledTools = false } = options

  const userSettings = await redis.getUserSettings(userId)
  const admin = (userSettings?.admin_settings as Record<string, any>) ?? {}
  const cliToolGridSettings = normalizeCliToolGridSettings(
    userSettings?.global_tool_grid_settings?.cli ?? null
  )
  const adminToolNameThreshold = normalizeToolNameThreshold(
    admin.dcm_tool_name_threshold,
    DEFAULT_TOOL_NAME_THRESHOLD
  )
  const toolNameThreshold = normalizeToolNameThreshold(options.toolNameThreshold, adminToolNameThreshold)
  const schemaHintCaps = normalizeSchemaHintCaps({
    requiredLimit: admin.dcm_schema_hint_required_limit,
    optionalLimit: admin.dcm_schema_hint_optional_limit,
    maxChars: admin.dcm_schema_hint_max_chars
  })

  const enabled = await resolveEnabledTools(options)
  const enabledToolNames = enabled.names
  const dynamicMcpEnabled = isDynamicMcpEnabled(options, enabledToolNames)
  const cliScope = await resolveCliToolSelectionScope({
    userId,
    agentId: options.agentId ?? null,
    selectedToolIds: options.selectedCliToolIds
  })
  const selectedCliToolIds = new Set(cliScope.toolIds)
  const cliToolsEnabled = options.cliToolsEnabled !== false
  const cliTools = cliToolsEnabled
    ? (await listCliTools(userId))
        .filter((record) => record.status === 'active')
        .filter((record) => selectedCliToolIds.has(record.toolId))
    : []

  if (!dynamicMcpEnabled && cliTools.length === 0) {
    let enabledTokens = 0
    let enabledToolCount = 0

    for (const [name, tool] of Object.entries(enabled.tools || {})) {
      enabledToolCount += 1
      const schema = extractSchema(tool)
      const description = (tool as any)?.description || ''
      const payload = `${name}\n${description}\n${schema ? JSON.stringify(schema) : ''}`
      enabledTokens += estimateTokens(payload)
    }

    return {
      groups: [],
      text: '',
      tokenEstimates: {
        enabled: enabledTokens,
        dcm: 0,
        total: enabledTokens
      },
      counts: {
        enabledTools: enabledToolCount,
        availableTools: 0,
        dcmTools: 0,
        groups: 0
      },
      threshold: toolNameThreshold,
      schemaHintCaps
    }
  }

  const dcmDisplaySettings = await resolveAgentDcmDisplaySettings({
    agentId: options.agentId,
    dcmDisplaySettings: options.dcmDisplaySettings
  })
  const gatewayDefaults = await resolveGatewayDisplayDefaults(userId)
  let allTools: Record<string, any> = {}
  let metadata = new Map<string, any>()
  if (dynamicMcpEnabled) {
    const mcpData = await mcpGatewayDiscovery.loadToolsForUser(
      userId,
      enabled.resolvedGateways,
      undefined,
      { skipFiltering: true, projectPath: options.projectPath ?? null }
    )
    allTools = mcpData.tools
    metadata = mcpData.metadata
  }

  const groups = new Map<string, WorkingGroup>()
  let dcmToolCount = 0
  let availableToolCount = 0

  if (dynamicMcpEnabled) {
    for (const [toolName] of Object.entries(allTools)) {
      if (shouldHideInternalMcpTool(toolName)) {
        continue
      }
      availableToolCount += 1

      if (!includeEnabledTools && enabledToolNames.has(toolName)) {
        continue
      }

      const toolMeta = metadata.get(toolName)
      const gatewayId = toolMeta?.gatewayId || UNKNOWN_GATEWAY
      const gatewayName = toolMeta?.gatewayName || UNKNOWN_GATEWAY_LABEL
      const gatewayDcmDefaults =
        gatewayDefaults.get(gatewayId) ?? createDefaultGatewayDcmDisplaySettings()
      const baseGroupName = (toolMeta?.mcpServerName || UNGROUPED_GROUP).trim() || UNGROUPED_GROUP
      const visibility = resolveMcpToolDcmVisibility({
        agentSettings: dcmDisplaySettings,
        gatewayDefaults: gatewayDcmDefaults,
        gatewayId,
        groupName: baseGroupName,
        toolNameVariants: [toolMeta?.originalToolName || '', toolName]
      })

      if (!visibility.isToolDiscoverable) {
        continue
      }

      const groupKey = buildCompositeKey(gatewayId, baseGroupName)

      if (visibility.groupVisibility === 'group-only') {
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            gatewayId,
            gatewayName,
            baseName: baseGroupName,
            name: baseGroupName,
            toolCount: 0,
            visibility: 'group-only',
            tools: undefined
          })
        }

        const group = groups.get(groupKey)!
        group.toolCount += 1
        dcmToolCount += 1
        continue
      }

      if (!visibility.toolVisibility || !visibility.isToolVisibleInDcm) {
        continue
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          gatewayId,
          gatewayName,
          baseName: baseGroupName,
          name: baseGroupName,
          toolCount: 0,
          visibility: 'group+tools',
          tools: [],
          forceToolList: isExplicitAgentToolListMode(visibility.agentGroupMode)
        })
      }

      const group = groups.get(groupKey)!
      if (isExplicitAgentToolListMode(visibility.agentGroupMode)) {
        group.forceToolList = true
      }
      group.toolCount += 1
      dcmToolCount += 1
      group.tools = group.tools || []
      group.tools.push({
        name: toolName,
        visibility: visibility.toolVisibility,
        schemaHint: null
      })
    }
  }

  if (cliTools.length > 0) {
    availableToolCount += cliTools.length
    const gatewayId = CLI_TOOL_GRID_ID
    const gatewayName = CLI_TOOL_GRID_GROUP_NAME
    const baseGroupName = CLI_TOOL_GRID_GROUP_NAME
    const groupKey = buildCompositeKey(gatewayId, baseGroupName)
    const agentGroupMode = dcmDisplaySettings.groups[groupKey]
    const effectiveGroupMode = resolveEffectiveGroupMode({
      agentSettings: dcmDisplaySettings,
      gatewayDefaults: cliToolGridSettings.dcmDisplayDefaults,
      gatewayId,
      groupName: baseGroupName
    })
    const groupVisibility = mapGroupModeToVisibility(effectiveGroupMode)

    if (groupVisibility !== 'hidden') {
      const cliGroup: WorkingGroup = {
        gatewayId,
        gatewayName,
        baseName: baseGroupName,
        name: baseGroupName,
        toolCount: 0,
        visibility: groupVisibility,
        tools: groupVisibility === 'group-only' ? undefined : [],
        forceToolList: isExplicitAgentToolListMode(agentGroupMode)
      }

      for (const record of cliTools.sort((left, right) => left.toolId.localeCompare(right.toolId))) {
        const toolVisibility = resolveEffectiveToolVisibility({
          agentSettings: dcmDisplaySettings,
          gatewayDefaults: cliToolGridSettings.dcmDisplayDefaults,
          gatewayId,
          toolNameVariants: [record.toolId],
          groupMode: effectiveGroupMode,
          agentGroupMode
        })

        if (toolVisibility === 'hidden') continue

        cliGroup.toolCount += 1
        dcmToolCount += 1

        if (groupVisibility === 'group+tools') {
          cliGroup.tools = cliGroup.tools || []
          cliGroup.tools.push({
            name: record.toolId,
            visibility: toolVisibility,
            schemaHint: toolVisibility === 'name+hint' ? buildCliToolHint(record as Record<string, any>) : null
          })
        }
      }

      if (cliGroup.toolCount > 0) {
        groups.set(groupKey, cliGroup)
      }
    }
  }

  const workingGroups = Array.from(groups.values())
  applyDuplicateGroupDisambiguation(workingGroups)

  const sortedGroups = workingGroups
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((group) => ({
      name: group.name,
      toolCount: group.toolCount,
      visibility: group.visibility,
      tools: group.tools,
      forceToolList: group.forceToolList
    }))

  for (const group of sortedGroups) {
    if (group.visibility !== 'group+tools') {
      group.tools = undefined
      continue
    }

    if (group.toolCount > toolNameThreshold && !group.forceToolList) {
      group.tools = undefined
      continue
    }

    const toolEntries = Array.isArray(group.tools)
      ? [...group.tools].sort((left, right) => left.name.localeCompare(right.name))
      : []

    for (const entry of toolEntries) {
      if (entry.visibility !== 'name+hint') {
        entry.schemaHint = null
        continue
      }

      if (entry.schemaHint) {
        continue
      }

      const tool = allTools[entry.name]
      const schema = extractSchema(tool)
      const summary = buildSchemaSummary(schema, schemaHintCaps)
      entry.schemaHint = getSchemaHintText(summary)
    }

    group.tools = toolEntries
  }

  const resultGroups = sortedGroups.map(({ forceToolList, ...group }) => group)
  const dcmText = buildDcmText(resultGroups)

  // Approx token estimation for enabled tools
  let enabledTokens = 0
  let enabledToolCount = 0
  for (const [name, tool] of Object.entries(enabled.tools || {})) {
    if (shouldHideInternalMcpTool(name)) continue
    enabledToolCount += 1
    const schema = extractSchema(tool)
    const description = (tool as any)?.description || ''
    const payload = `${name}\n${description}\n${schema ? JSON.stringify(schema) : ''}`
    enabledTokens += estimateTokens(payload)
  }

  const dcmTokens = estimateTokens(dcmText)

  return {
    groups: resultGroups,
    text: dcmText,
    tokenEstimates: {
      enabled: enabledTokens,
      dcm: dcmTokens,
      total: enabledTokens + dcmTokens
    },
    counts: {
      enabledTools: enabledToolCount,
      availableTools: availableToolCount,
      dcmTools: dcmToolCount,
      groups: resultGroups.length
    },
    threshold: toolNameThreshold,
    schemaHintCaps
  }
}

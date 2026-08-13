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
import { listVisibleControls, type ControlRuntimeMode } from './fabricRegistry'
import { NATIVE_FABRIC_HELPER_CONTROL_META } from './nativeFabricHelperCatalog'
import {
  BROKER_ARTIFACT_ALLOWED_CONTROL_IDS,
  isControlIdAllowedByList,
  resolveBrokerFabricAllowedControlIds,
  resolveBrokerFamilies,
  resolveBrokerToolToggles,
  type BrokerRuntime,
  type BrokerToolToggles
} from '$lib/utils/brokerAvailability'
import {
  ARTIFACT_TOOL_GRID_GROUP_NAME,
  ARTIFACT_TOOL_GRID_ID,
  FABRIC_TOOL_GRID_GROUP_NAME,
  FABRIC_TOOL_GRID_ID,
  normalizeArtifactToolGridSettings,
  normalizeFabricToolGridSettings
} from '$lib/utils/toolGridBrokerFamilies'
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
  /** Rendered once under the group. Used for family-level rules that are not per-tool. */
  note?: string | null
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
  /**
   * Which runtime's broker registration rules decide which families are reachable.
   * SA-096 P4: `api` and `n8n` open Fabric on fetch-zip, `cli` does not — the index must
   * not advertise a family the broker would refuse for this lane.
   */
  runtime?: BrokerRuntime | null
  /** Explicit broker toggles. When omitted they are read from the agent record. */
  brokerToggles?: BrokerToolToggles | null
  /**
   * Actor id used for Fabric/Artifact control visibility only. The subagent lane resolves
   * MCP selections from an explicit gateway/tool scope rather than from `agentId`, but its
   * controls still have to be filtered by the subagent's own allowlists.
   */
  controlAgentId?: string | null
  /** Raw `provider_specific_settings`, used when the caller already has the record. */
  providerSettings?: unknown
  allowArtifactRuntimeTools?: boolean
  allowFabricControlTools?: boolean
}

interface WorkingGroup extends DynamicMcpIndexGroup {
  gatewayId: string
  gatewayName: string
  baseName: string
  forceToolList?: boolean
}

const UNGROUPED_GROUP = 'Ungrouped Tools'
// Exported so `mcpGatewayReferenceCleanup` can pin its reserved-ID list against
// the real placeholder instead of a copied literal (SA-096 P6).
export const UNKNOWN_GATEWAY = 'unknown_gateway'
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

/**
 * SA-096 P4: returns an empty string rather than a bare `tool_discovery` header when no
 * family has anything to show. The orphaned header — a heading with nothing under it —
 * is the defect that opened this story.
 */
function buildDcmText(groups: DynamicMcpIndexGroup[]): string {
  const body: string[] = []

  for (const group of groups) {
    if (group.visibility === 'hidden') continue
    if (!group.toolCount) continue

    if (
      group.visibility === 'group+tools' &&
      Array.isArray(group.tools) &&
      group.tools.length > 0
    ) {
      body.push(`${formatGroupLine(group.name, group.toolCount)}:`)
      for (const tool of group.tools) {
        const hint =
          tool.visibility === 'name+hint' && tool.schemaHint
            ? ` — ${tool.schemaHint}`
            : ''
        body.push(`  - ${tool.name}${hint}`)
      }
    } else {
      body.push(formatGroupLine(group.name, group.toolCount))
    }

    if (group.note) {
      body.push(`  ${group.note}`)
    }
  }

  if (body.length === 0) return ''

  return ['tool_discovery', '(current discoverable tools and hints for this agent)', ...body].join(
    '\n'
  )
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

function truncateHint(value: string, maxChars: number): string {
  const trimmed = value.trim()
  if (!Number.isFinite(maxChars) || maxChars <= 0) return trimmed
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

interface BrokerFamilyEntry {
  name: string
  hint: string | null
}

/**
 * Applies the Tool Grid contract to one synthetic-gateway family (Fabric or Artifact).
 *
 * SA-096 P3/P4: this is the same resolution the CLI Tools row already uses — agent
 * override, then the family's global defaults, then the group mode's implied tool
 * visibility. Nothing family-specific happens here, which is the point: Fabric and
 * Artifact are configured with exactly the vocabulary MCP and CLI already use.
 */
function buildBrokerFamilyGroup(input: {
  gatewayId: string
  groupName: string
  gatewayDefaults: GatewayDcmDisplaySettings
  agentSettings: AgentDcmDisplaySettings
  entries: BrokerFamilyEntry[]
  note?: string | null
}): WorkingGroup | null {
  if (input.entries.length === 0) return null

  const agentGroupMode = input.agentSettings.groups[buildCompositeKey(input.gatewayId, input.groupName)]
  const effectiveGroupMode = resolveEffectiveGroupMode({
    agentSettings: input.agentSettings,
    gatewayDefaults: input.gatewayDefaults,
    gatewayId: input.gatewayId,
    groupName: input.groupName
  })
  const groupVisibility = mapGroupModeToVisibility(effectiveGroupMode)
  if (groupVisibility === 'hidden') return null

  const group: WorkingGroup = {
    gatewayId: input.gatewayId,
    gatewayName: input.groupName,
    baseName: input.groupName,
    name: input.groupName,
    toolCount: 0,
    visibility: groupVisibility,
    tools: groupVisibility === 'group-only' ? undefined : [],
    forceToolList: isExplicitAgentToolListMode(agentGroupMode),
    note: input.note ?? null
  }

  for (const entry of input.entries) {
    const toolVisibility = resolveEffectiveToolVisibility({
      agentSettings: input.agentSettings,
      gatewayDefaults: input.gatewayDefaults,
      gatewayId: input.gatewayId,
      toolNameVariants: [entry.name],
      groupMode: effectiveGroupMode,
      agentGroupMode
    })

    if (toolVisibility === 'hidden') continue

    group.toolCount += 1

    if (groupVisibility === 'group+tools') {
      group.tools = group.tools || []
      group.tools.push({
        name: entry.name,
        visibility: toolVisibility,
        schemaHint: toolVisibility === 'name+hint' ? entry.hint ?? null : null
      })
    }
  }

  if (group.toolCount === 0) return null
  return group
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

/**
 * The broker toggles this agent runs with.
 *
 * Explicit input wins, then the caller's raw provider settings, then the stored agent
 * record. `dynamicMcpEnabled` and `cliToolsEnabled` are overwritten afterwards by the
 * values this index already resolved, so the Fabric scope's `sys.mcp.dynamic.*` entries
 * agree with the MCP section rather than being read twice from different places.
 */
async function resolveIndexBrokerToggles(
  options: DynamicMcpIndexOptions
): Promise<BrokerToolToggles> {
  if (options.brokerToggles) {
    return { ...options.brokerToggles }
  }

  if (options.providerSettings !== undefined) {
    return resolveBrokerToolToggles(options.providerSettings)
  }

  const agentId = options.agentId?.trim()
  if (!agentId) {
    return resolveBrokerToolToggles(null)
  }

  try {
    const agent = (await redis.get(`agent:${agentId}`)) as Record<string, unknown> | null
    return resolveBrokerToolToggles(
      agent?.provider_specific_settings ?? agent?.providerSpecificSettings ?? null
    )
  } catch (error) {
    console.warn('[Dynamic MCP DCM] Failed to resolve broker toggles:', error)
    return resolveBrokerToolToggles(null)
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
  const fabricToolGridSettings = normalizeFabricToolGridSettings(
    userSettings?.global_tool_grid_settings?.fabric ?? null
  )
  const artifactToolGridSettings = normalizeArtifactToolGridSettings(
    userSettings?.global_tool_grid_settings?.artifact ?? null
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

  // SA-096 P4: Fabric and Artifact are broker families with no gateway and no CLI record,
  // so their reachability comes from the same shared rules tool registration uses. The
  // index must never claim a family the broker would refuse on this runtime.
  const controlAgentId = (options.controlAgentId ?? options.agentId) ?? null
  const brokerToggles = await resolveIndexBrokerToggles(options)
  brokerToggles.dynamicMcpEnabled = dynamicMcpEnabled
  brokerToggles.cliToolsEnabled = cliToolsEnabled
  const brokerRuntime: BrokerRuntime =
    options.runtime ?? (options.isCodexMode === true ? 'cli' : 'api')
  const controlRuntimeMode: ControlRuntimeMode = brokerRuntime === 'cli' ? 'mode4' : 'mode3'
  const allowFabricControlTools = options.allowFabricControlTools !== false
  const brokerFamilies = resolveBrokerFamilies({
    runtime: brokerRuntime,
    toggles: brokerToggles,
    hasCliTools: selectedCliToolIds.size > 0,
    allowArtifactRuntimeTools: options.allowArtifactRuntimeTools,
    allowFabricControlTools: options.allowFabricControlTools
  })
  const fabricReachable = brokerFamilies.includes('fabric')
  const artifactReachable = brokerFamilies.includes('artifact')

  if (!dynamicMcpEnabled && cliTools.length === 0 && !fabricReachable && !artifactReachable) {
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

  // SA-096 P4: Fabric controls. `listVisibleControls` applies the same per-agent and
  // per-runtime visibility filter the broker's own search applies, and the allowlist is
  // the one tool registration builds, so the count here is the count the agent can reach.
  const fabricAllowedControlIds = fabricReachable
    ? resolveBrokerFabricAllowedControlIds({
        toggles: brokerToggles,
        allowFabricControlTools: options.allowFabricControlTools
      })
    : []
  const fabricControls = fabricReachable
    ? await listVisibleControls({
        userId,
        agentId: controlAgentId,
        runtimeMode: controlRuntimeMode,
        allowedControlIds: fabricAllowedControlIds
      })
    : []

  if (fabricReachable) {
    const nativeHelperIds = new Set(
      NATIVE_FABRIC_HELPER_CONTROL_META.map((meta) => meta.controlId)
    )
    const entries: BrokerFamilyEntry[] = [
      ...NATIVE_FABRIC_HELPER_CONTROL_META.filter((meta) =>
        isControlIdAllowedByList(meta.controlId, fabricAllowedControlIds)
      ).map((meta) => ({
        name: meta.controlId,
        hint: truncateHint(
          [meta.title, meta.schemaHint].filter(Boolean).join(' — '),
          schemaHintCaps.maxChars
        )
      })),
      ...fabricControls
        .filter((control) => !nativeHelperIds.has(control.controlId))
        .map((control) => ({
          name: control.controlId,
          hint: truncateHint(
            [control.title, control.schemaHint].filter(Boolean).join(' — '),
            schemaHintCaps.maxChars
          )
        }))
    ].sort((left, right) => left.name.localeCompare(right.name))

    availableToolCount += entries.length
    const fabricGroup = buildBrokerFamilyGroup({
      gatewayId: FABRIC_TOOL_GRID_ID,
      groupName: FABRIC_TOOL_GRID_GROUP_NAME,
      gatewayDefaults: fabricToolGridSettings.dcmDisplayDefaults,
      agentSettings: dcmDisplaySettings,
      entries
    })
    if (fabricGroup) {
      dcmToolCount += fabricGroup.toolCount
      groups.set(buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME), fabricGroup)
    }
  }

  // SA-096 P4: published agent-usable artifacts. Only the `use.artifact.{slug}` aliases are
  // agent-runnable; the per-artifact `artifact.<id>.*` config controls belong to the Fabric
  // family, so they are reported here as a count and only when Fabric is actually reachable.
  if (artifactReachable) {
    const artifactControls = await listVisibleControls({
      userId,
      agentId: controlAgentId,
      runtimeMode: controlRuntimeMode,
      allowedControlIds: Array.from(BROKER_ARTIFACT_ALLOWED_CONTROL_IDS)
    })

    const configCounts = new Map<string, number>()
    for (const control of fabricControls) {
      if (!control.controlId.startsWith('artifact.')) continue
      if (control.controlId.endsWith('.typed.invoke')) continue
      if (!control.artifactId) continue
      configCounts.set(control.artifactId, (configCounts.get(control.artifactId) ?? 0) + 1)
    }

    const entries: BrokerFamilyEntry[] = artifactControls.map((control) => {
      const fields = control.schemaHint?.trim()
      const configCount = control.artifactId ? configCounts.get(control.artifactId) : undefined
      const parts: string[] = []
      if (fields) parts.push(`fields: ${fields}`)
      if (typeof configCount === 'number') parts.push(`${configCount} config controls`)
      return {
        name: control.controlId,
        hint: parts.length > 0 ? truncateHint(parts.join(' | '), schemaHintCaps.maxChars) : null
      }
    })

    availableToolCount += entries.length
    const artifactGroup = buildBrokerFamilyGroup({
      gatewayId: ARTIFACT_TOOL_GRID_ID,
      groupName: ARTIFACT_TOOL_GRID_GROUP_NAME,
      gatewayDefaults: artifactToolGridSettings.dcmDisplayDefaults,
      agentSettings: dcmDisplaySettings,
      entries,
      note: 'artifact_hint: run these with the exact artifact:use.artifact.{slug} ref and structured field input. User-only panel artifacts such as Gradio/HuggingFace embeds and ComfyUI panel artifacts are not agent-runnable; tell the user instead of changing an artifact brain type or power source.'
    })
    if (artifactGroup) {
      dcmToolCount += artifactGroup.toolCount
      groups.set(
        buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME),
        artifactGroup
      )
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
      note: group.note ?? null,
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

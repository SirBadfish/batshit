import { redis } from '$lib/server/redis'
import { DEFAULT_DCM_TOOL_NAME_THRESHOLD, normalizeTotalHintTokens } from '$lib/utils/dynamicSchemaHintSettings'
import { AGENT_SETUP_FEATURES } from '$lib/utils/agentSetupFeatures'
import { setupMetadata, type AgentSetupBlock, type AgentSetupSource } from './agentSetupCache'
import type { ActingAgentLane as ControlActorType } from './actingAgentIdentity'
import { readApiUtilities, type ApiUtilityScope } from './apiUtilityRuntime'
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
  buildSchemaHintSummary,
  formatCliSchemaHint,
  getSchemaHintText,
  normalizeSchemaHintCaps,
  type SchemaHintCaps
} from './dynamicMcpSchema'
import { shouldHideInternalMcpTool } from './nativeToolConstants'
import { listCliTools, resolveCliToolSelectionScope } from './cliToolRegistry'
import type { ControlRuntimeMode } from './fabricControlModes'
import { NATIVE_FABRIC_HELPER_CONTROL_META } from './nativeFabricHelperCatalog'
import {
  buildCompositeKey,
  mapGroupModeToVisibility,
  resolveAgentDcmDisplaySettings,
  resolveEffectiveGroupMode,
  resolveEffectiveToolVisibility,
  resolveGatewayDisplayDefaults,
  resolveMcpToolDcmVisibility,
  isExplicitAgentToolListMode,
  type DcmGroupVisibility,
  type DcmToolVisibility
} from './dynamicMcpVisibility'
import {
  BROKER_ARTIFACT_ALLOWED_CONTROL_IDS,
  isControlIdAllowedByList,
  resolveBrokerRuntimeAllowedControlIds,
  brokerControlRef,
  isBatshitUtilityControlId,
  resolveBrokerFamilies,
  resolveBrokerToolToggles,
  type BrokerRuntime,
  type BrokerToolToggles
} from '$lib/utils/brokerAvailability'
import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import { resolveAgentJevJudgeToolEnabled } from '$lib/utils/jevJuiceControl'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import {
  ARTIFACT_TOOL_GRID_GROUP_NAME,
  ARTIFACT_TOOL_GRID_ID,
  FABRIC_TOOL_GRID_GROUP_NAME,
  FABRIC_TOOL_GRID_DISPLAY_NAME,
  FABRIC_TOOL_GRID_ID,
  describeFabricControlFamilies,
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

// SA-096: visibility resolution moved to `dynamicMcpVisibility` to break the
// dynamicMcpTools -> dynamicMcpIndex -> fabricRegistry -> dynamicMcpTools cycle.
// Re-exported so existing import paths keep working.
export {
  buildCompositeKey,
  mapGroupModeToVisibility,
  resolveAgentDcmDisplaySettings,
  resolveEffectiveGroupMode,
  resolveEffectiveToolVisibility,
  resolveGatewayDisplayDefaults,
  resolveMcpToolDcmVisibility
}
export type { DcmGroupVisibility, DcmToolVisibility }


export interface DynamicMcpIndexTool {
  name: string
  /** Canonical typed ref when a runtime utility is directly callable from its hint. */
  ref?: string
  visibility: DcmToolVisibility
  schemaHint?: string | null
}

export interface DynamicMcpIndexGroup {
  /** Stable identity survives duplicate display-name disambiguation. */
  id?: string
  source?: string
  name: string
  toolCount: number
  visibility: DcmGroupVisibility
  tools?: DynamicMcpIndexTool[]
  /** Rendered once under the group. Used for family-level rules that are not per-tool. */
  note?: string | null
  /**
   * SA-072 P2 step 0: the plain words for the families this group's counted entries belong
   * to, printed inside the group line (`- Fabric Controls (65 tools: agent DMs, …)`). Only
   * the Fabric group sets it.
   */
  families?: string[]
  /** The remaining operational families are explained by their Batshit plugin skills. */
  skillGuidance?: boolean
}

export type DynamicMcpDiscoverableFamily = 'mcp' | 'cli' | 'fabric' | 'batshit' | 'artifact'

/**
 * SA-120 P1: one discoverable capability the agent can reach through the broker, in
 * the exact typed-ref form `tool_use` accepts. This is the list the Judge Juice skill and
 * tool hint judges over, so it follows the SAME visibility and allowlist rules the DCM
 * text and `_find` follow: a hidden tool is not here, and a family the broker would
 * refuse on this runtime is not here. Unlike the rendered text, it is not collapsed by
 * the tool-name threshold, and it includes MCP tools already in the runtime tool list
 * (flagged `enabled`) because a hint may point at either.
 */
export interface DynamicMcpDiscoverableRef {
  ref: string
  family: DynamicMcpDiscoverableFamily
  name: string
  group: string
  description: string | null
  hint: string | null
  /** MCP only: already registered in the agent's runtime tool list (no discovery needed). */
  enabled: boolean
  groupKey?: string
}

export interface DynamicMcpIndexResult {
  groups: DynamicMcpIndexGroup[]
  text: string
  /** SA-120 P1: every typed ref the agent could reach, regardless of how the text collapsed it. */
  discoverable: DynamicMcpDiscoverableRef[]
  /** The gateway ids the agent's MCP scope resolved to (`null` when Dynamic MCP is off). */
  resolvedGatewayIds: string[] | null
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
  setupBlocks: AgentSetupBlock[]
  sources: AgentSetupSource[]
  hintBudget: { limit: number; budgetedTokens: number; featureTokens: number }
  apiUtilityProjection: 'registered' | 'unprepared' | 'not-applicable'
  /** Current allowance before presentation filtering; absent only on an unprepared projection. */
  allowedSkillToolHints?: import('$lib/utils/skillToolGroups').AllowedSkillToolHint[]
  /** Only complete, uncapped fixed Setup hints may suppress the same opened-skill guidance. */
  completeFeatureHintRefs?: string[]
}

interface DynamicMcpIndexOptions {
  /** Actual final API registrations, server-private; previews never mint this handle. */
  apiUtilityScope?: ApiUtilityScope
  p5McpOwner?: import('./appActions/mcp/originalTask').P5OriginalPreparation
  userId: string
  /** Set only by the Primary compiler; delegated/preview indexes do not infer actor identity. */
  primarySettingsActor?: boolean
  agentId?: string | null
  toolSelections?: MCPToolSelections | null
  selectedGateways?: string[] | null
  selectedCliToolIds?: string[] | null
  projectPath?: string | null
  nativeDynamicMcpEnabled?: boolean | null
  cliToolsEnabled?: boolean | null
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  includeEnabledTools?: boolean
  /** Verified server producer lane, never accepted from Tool Grid request data. */
  controlActorType?: ControlActorType
  toolNameThreshold?: number
  /** Actual emitted guidance gates, intersected with the permitted live controls. */
  featureHintGates?: Partial<Record<'memory' | 'dm' | 'schedule' | 'judge' | 'whiteboard' | 'zip' | 'skill', boolean>>
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
  /**
   * SA-104 P3: PRIMARY actor + agent `memory_enabled`. When omitted the index resolves it
   * from `agent:{agentId}` (route callers); subagent callers pass explicit false.
   */
  memoryControlsEnabled?: boolean
  whiteboardControlsEnabled?: boolean
  /** SA-113 P2 (DL-113-03): explicit value wins; subagent scopes pass false. */
  dmControlsEnabled?: boolean
  /** SA-115 P2 (DL-115-10): explicit value wins; subagent scopes pass false. */
  scheduleControlsEnabled?: boolean
  /** SA-120 P2 (DL-120-06): explicit value wins; subagent scopes pass false. */
  judgeControlsEnabled?: boolean
}

interface WorkingGroup extends DynamicMcpIndexGroup {
  gatewayId: string
  gatewayName: string
  baseName: string
  forceToolList?: boolean
}

export class ToolHintBudgetError extends Error {
  readonly code = 'TOOL_HINT_BUDGET_TOO_SMALL'
  readonly status = 400
  constructor(readonly budgetTokens: number, readonly minimumRequiredTokens: number) {
    super(`The Total Hint Budget is ${budgetTokens} estimated tokens, but enabled group names and counts need at least ${minimumRequiredTokens}. Increase the budget or reduce/shorten enabled group metadata. Saved settings were kept.`)
    this.name = 'ToolHintBudgetError'
  }
}

const UNGROUPED_GROUP = 'Ungrouped Tools'
// Exported so `mcpGatewayReferenceCleanup` can pin its reserved-ID list against
// the real placeholder instead of a copied literal (SA-096 P6).
export const UNKNOWN_GATEWAY = 'unknown_gateway'
const UNKNOWN_GATEWAY_LABEL = 'Unknown Gateway'
const DEFAULT_TOOL_NAME_THRESHOLD = DEFAULT_DCM_TOOL_NAME_THRESHOLD
const MIN_TOOL_NAME_THRESHOLD = 1
const MAX_TOOL_NAME_THRESHOLD = 100
const REQUIRED_DYNAMIC_TOOLS = ['batshit_server_dynamic_mcp_find', 'batshit_server_dynamic_mcp_use']


/**
 * `fabricRegistry` is loaded on demand rather than imported at module scope.
 *
 * SA-096 P4 added this module's dependency on the Fabric registry so the capability
 * index could report a truthful Fabric count. That closed a cycle:
 * `dynamicMcpTools` -> `dynamicMcpIndex` -> `fabricRegistry` -> `dynamicMcpTools`,
 * because the registry's `sys.mcp.dynamic.*` controls delegate to the shared Dynamic
 * MCP executor by design (see `fabric-registry.md`). CI enforces a zero circular-import
 * budget, and `npm run check` cannot see cycles, so this is the guard that matters.
 *
 * The dependency is genuinely lazy — `listVisibleControls` is only ever called from
 * inside an async index build, never at module init — so deferring it removes the cycle
 * without weakening the delegation the registry contract requires. Node caches the
 * module after the first call. Extracting `listVisibleControls` into a leaf module was
 * rejected: it resolves through the registry's full control store, so the extraction
 * would mean refactoring an FM-listed 6k-line module to fix an import edge.
 *
 * Keep this lazy. A static import here fails the `Circular imports (zero budget)` CI job.
 */
async function loadListVisibleControls() {
  const { listVisibleControls } = await import('./fabricRegistry')
  return listVisibleControls
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

function formatGroupLine(name: string, count: number, families?: string[], skillGuidance = false): string {
  const label = count === 1 ? 'tool' : 'tools'
  const familyText = families && families.length > 0 ? `: ${families.join(', ')}` : ''
  const guidance = skillGuidance ? '; the Batshit skills explain them' : ''
  return `- ${setupMetadata(name)} (${count} ${label}${setupMetadata(familyText)}${guidance})`
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
      body.push(`${formatGroupLine(group.name, group.toolCount, group.families, group.skillGuidance)}:`)
      for (const tool of group.tools) {
        const hint =
          tool.visibility === 'name+hint' && tool.schemaHint
            ? ` — ${tool.schemaHint}`
            : ''
        body.push(`  - ${setupMetadata(tool.ref ?? tool.name)}${setupMetadata(hint)}`)
      }
    } else {
      body.push(formatGroupLine(group.name, group.toolCount, group.families, group.skillGuidance))
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

function buildCliFieldSummary(inputSchema: Record<string, any> | undefined, caps: SchemaHintCaps): string {
  return formatCliSchemaHint(inputSchema, caps)
}

function truncateHint(value: string, maxChars: number): string {
  const trimmed = setupMetadata(value.trim())
  if (!Number.isFinite(maxChars) || maxChars <= 0) return trimmed
  if (trimmed.length <= maxChars) return trimmed
  const notice = '… (full schema required)'
  return `${trimmed.slice(0, Math.max(0, maxChars - notice.length)).trimEnd()}${notice}`
}

interface BrokerFamilyEntry {
  name: string
  hint: string | null
}

const DISCOVERABLE_DESCRIPTION_MAX_CHARS = 200

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  return oneLine.length > DISCOVERABLE_DESCRIPTION_MAX_CHARS
    ? `${oneLine.slice(0, DISCOVERABLE_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
    : oneLine
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
  displayName?: string
  gatewayDefaults: GatewayDcmDisplaySettings
  agentSettings: AgentDcmDisplaySettings
  entries: BrokerFamilyEntry[]
  note?: string | null
  /** SA-072 P2 step 0: derives the group line's family words from the COUNTED entries. */
  describeFamilies?: (countedNames: string[]) => string[]
  /** Fabric's enabled line is fixed; retired presentation choices no longer hide controls. */
  alwaysOneLine?: boolean
  alwaysDiscoverable?: boolean
}): WorkingGroup | null {
  if (input.entries.length === 0) return null

  const agentGroupMode = input.agentSettings.groups[buildCompositeKey(input.gatewayId, input.groupName)]
  const savedGroupMode = resolveEffectiveGroupMode({
    agentSettings: input.agentSettings,
    gatewayDefaults: input.gatewayDefaults,
    gatewayId: input.gatewayId,
    groupName: input.groupName
  })
  const retainedPreference = normalizeLegacyGroupMode(input.agentSettings.groupDisplayPreferences?.[buildCompositeKey(input.gatewayId, input.groupName)])
  const inheritedPreference = normalizeLegacyGroupMode(input.gatewayDefaults.groups[input.groupName])
  const unhiddenPreference = retainedPreference && retainedPreference !== 'hidden' ? retainedPreference
    : inheritedPreference && inheritedPreference !== 'hidden' ? inheritedPreference : 'group+tools+hints'
  const restoredAgentMode = input.alwaysDiscoverable && savedGroupMode === 'hidden' && retainedPreference && retainedPreference !== 'hidden'
    ? retainedPreference : agentGroupMode
  const effectiveGroupMode = input.alwaysOneLine ? 'group-only'
    : input.alwaysDiscoverable && savedGroupMode === 'hidden' ? unhiddenPreference : savedGroupMode
  const groupVisibility = mapGroupModeToVisibility(effectiveGroupMode)
  if (groupVisibility === 'hidden') return null

  const group: WorkingGroup = {
    gatewayId: input.gatewayId,
    gatewayName: input.displayName ?? input.groupName,
    baseName: input.displayName ?? input.groupName,
    name: input.displayName ?? input.groupName,
    toolCount: 0,
    visibility: groupVisibility,
    tools: groupVisibility === 'group-only' ? undefined : [],
    forceToolList: !input.alwaysOneLine && isExplicitAgentToolListMode(restoredAgentMode),
    note: input.note ?? null
  }
  const countedNames: string[] = []

  for (const entry of input.entries) {
    const toolVisibility = input.alwaysOneLine ? 'name-only' : input.alwaysDiscoverable ? effectiveGroupMode === 'group+tools+hints' ? 'name+hint' : 'name-only' : resolveEffectiveToolVisibility({
      agentSettings: input.agentSettings,
      gatewayDefaults: input.gatewayDefaults,
      gatewayId: input.gatewayId,
      toolNameVariants: [entry.name],
      groupMode: effectiveGroupMode,
      agentGroupMode
    })

    if (toolVisibility === 'hidden') continue

    group.toolCount += 1
    countedNames.push(entry.name)

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
  // Only families with a control this agent can actually see: a hidden control never names
  // its family, and a Subagent with no Pinokio controls never reads "Pinokio".
  if (input.describeFamilies) {
    group.families = input.describeFamilies(countedNames)
  }
  return group
}

function buildCliToolHint(record: Record<string, any>, caps: SchemaHintCaps): string {
  const parts: string[] = []
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const schemaSummary = buildCliFieldSummary(record.inputSchema, caps)

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
    selectedGateways
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
    toolSelections: toolSelections ?? undefined
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

/**
 * SA-104 P3: mirrors `resolveIndexBrokerToggles` — explicit caller value wins, otherwise
 * the agent record decides. Callers for subagent scopes pass explicit false.
 */
async function resolveIndexMemoryControlsEnabled(
  options: DynamicMcpIndexOptions
): Promise<boolean> {
  if (typeof options.memoryControlsEnabled === 'boolean') {
    return options.memoryControlsEnabled
  }
  const agentId = options.agentId?.trim()
  if (!agentId) return false
  try {
    const agent = (await redis.get(`agent:${agentId}`, { throwOnError: true })) as Record<string, unknown> | null
    return resolveAgentMemoryEnabled(agent)
  } catch (error) {
    console.warn('[Dynamic MCP DCM] Failed to resolve memory enablement:', error)
    throw error
  }
}

/** SA-113 P2: the DM twin of `resolveIndexMemoryControlsEnabled`, same precedence. */
async function resolveIndexDmControlsEnabled(
  options: DynamicMcpIndexOptions
): Promise<boolean> {
  if (typeof options.dmControlsEnabled === 'boolean') {
    return options.dmControlsEnabled
  }
  const agentId = options.agentId?.trim()
  if (!agentId) return false
  try {
    const agent = (await redis.get(`agent:${agentId}`, { throwOnError: true })) as Record<string, unknown> | null
    return resolveAgentDmsEnabled(agent)
  } catch (error) {
    console.warn('[Dynamic MCP DCM] Failed to resolve Agent DM enablement:', error)
    throw error
  }
}

/** SA-120 P2: the judgment-tool twin of `resolveIndexDmControlsEnabled`, same precedence. */
async function resolveIndexJudgeControlsEnabled(
  options: DynamicMcpIndexOptions
): Promise<boolean> {
  if (typeof options.judgeControlsEnabled === 'boolean') {
    return options.judgeControlsEnabled
  }
  const agentId = options.agentId?.trim()
  if (!agentId) return false
  try {
    const agent = (await redis.get(`agent:${agentId}`, { throwOnError: true })) as Record<string, unknown> | null
    return resolveAgentJevJudgeToolEnabled(agent)
  } catch (error) {
    console.warn('[Dynamic MCP DCM] Failed to resolve Judge Juice judgment-tool enablement:', error)
    throw error
  }
}

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
    const agent = (await redis.get(`agent:${agentId}`, { throwOnError: true })) as Record<string, unknown> | null
    if (!agent) throw new Error('The agent whose tool scope was requested no longer exists.')
    return resolveBrokerToolToggles(
      agent?.provider_specific_settings ?? agent?.providerSpecificSettings ?? null
    )
  } catch (error) {
    console.warn('[Dynamic MCP DCM] Failed to resolve broker toggles:', error)
    throw error
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
  const totalHintTokens = normalizeTotalHintTokens(admin.dcm_schema_hint_total_tokens)

  const enabled = await resolveEnabledTools(options)
  const enabledToolNames = enabled.names
  const dynamicMcpEnabled = isDynamicMcpEnabled(options, enabledToolNames)
  const cliScope = await resolveCliToolSelectionScope({
    userId,
    agentId: options.agentId ?? null,
    // The index's caller resolved this list on the server (BL-686); absent reads the agent's.
    cliToolScope: options.selectedCliToolIds ?? undefined
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
  const brokerRuntime: BrokerRuntime = options.runtime ?? 'api'
  // SA-139 P7: `mode4` was the removed managed CLI lanes' control mode; every index is `mode3` now.
  const controlRuntimeMode: ControlRuntimeMode = 'mode3'
  const allowFabricControlTools = options.allowFabricControlTools !== false
  const memoryControlsEnabled = await resolveIndexMemoryControlsEnabled(options)
  const whiteboardControlsEnabled = options.whiteboardControlsEnabled === true
  const dmControlsEnabled = await resolveIndexDmControlsEnabled(options)
  // SA-115 P2: schedules ride the same per-agent switch as DMs, so they resolve from it
  // rather than adding a second read of the same agent record.
  const scheduleControlsEnabled =
    typeof options.scheduleControlsEnabled === 'boolean'
      ? options.scheduleControlsEnabled
      : dmControlsEnabled
  const judgeControlsEnabled = await resolveIndexJudgeControlsEnabled(options)
  const brokerFamilies = resolveBrokerFamilies({
    runtime: brokerRuntime,
    toggles: brokerToggles,
    hasCliTools: selectedCliToolIds.size > 0,
    allowArtifactRuntimeTools: options.allowArtifactRuntimeTools,
    allowFabricControlTools: options.allowFabricControlTools,
    memoryControlsEnabled,
    whiteboardControlsEnabled,
    dmControlsEnabled,
    scheduleControlsEnabled,
    judgeControlsEnabled
  })
  const fabricReachable = brokerFamilies.includes('fabric') || brokerFamilies.includes('batshit')
  const apiUtilities = readApiUtilities(options.apiUtilityScope, { userId, agentId: options.agentId ?? controlAgentId })
  const apiReady = !!options.apiUtilityScope
  // SA-139 P7: every index is on `api` now, so the utilities source always applies.
  const apiUtilityProjection = apiReady ? 'registered' as const : 'unprepared' as const
  const apiSource: AgentSetupSource = { id: 'api-utilities', label: 'Batshit Utilities', available: apiReady,
    ...(!apiReady ? { unavailableReason: 'unprepared' as const } : {}) }
  const artifactReachable = brokerFamilies.includes('artifact')

  if (!dynamicMcpEnabled && cliTools.length === 0 && !fabricReachable && !artifactReachable && !apiUtilities.length) {
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
      discoverable: [],
      resolvedGatewayIds: dynamicMcpEnabled ? (enabled.resolvedGateways ?? null) : null,
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
      schemaHintCaps,
      setupBlocks: [], sources: [apiSource], apiUtilityProjection,
      allowedSkillToolHints: [], completeFeatureHintRefs: [],
      hintBudget: { limit: totalHintTokens, budgetedTokens: 0, featureTokens: 0 }
    }
  }

  const dcmDisplaySettings = await resolveAgentDcmDisplaySettings({
    agentId: options.agentId,
    dcmDisplaySettings: options.dcmDisplaySettings
  })
  const gatewayDefaults = await resolveGatewayDisplayDefaults(userId)
  let allTools: Record<string, any> = {}
  let metadata = new Map<string, any>()
  const sources: AgentSetupSource[] = [
    { id: 'controls', label: 'Batshit controls', available: true },
    { id: 'cli', label: 'CLI Tools', available: true }
  ]
  sources.push(apiSource)
  if (dynamicMcpEnabled && enabled.resolvedGateways?.length !== 0) {
    const mcpData = await mcpGatewayDiscovery.loadToolsForUser(
      userId,
      enabled.resolvedGateways,
      undefined,
      { skipFiltering: true, projectPath: options.projectPath ?? null, p5Owner: options.p5McpOwner }
    )
    if (mcpData.unavailable) throw new Error('The current MCP tool catalogue could not be read; Agent Setup was not changed.')
    allTools = mcpData.tools
    metadata = mcpData.metadata
    const availability = mcpData.gatewayAvailability ?? []
    for (const gatewayId of enabled.resolvedGateways ?? [...new Set([...metadata.values()].map(meta => meta.gatewayId))]) {
      const status = availability.find(row => row.gatewayId === gatewayId)
      sources.push({ id: `mcp:${gatewayId}`, label: status?.gatewayName ?? gatewayId, available: status?.available !== false })
    }
  }

  const groups = new Map<string, WorkingGroup>()
  const discoverable: DynamicMcpDiscoverableRef[] = []
  let dcmToolCount = 0
  let availableToolCount = 0
  if (apiUtilities.length) {
    const groupKey = buildCompositeKey('__api_utilities__', 'Batshit Utilities')
    const tools = apiUtilities.map(entry => {
      const hint = getSchemaHintText(buildSchemaHintSummary(entry.schemaHintFields, schemaHintCaps))
      discoverable.push({ ref: brokerControlRef(entry.controlId), family: 'batshit', name: entry.controlId,
        group: 'Batshit Utilities', groupKey, description: normalizeDescription(entry.description), hint, enabled: false })
      return { name: entry.controlId, ref: brokerControlRef(entry.controlId), visibility: 'name+hint' as const, schemaHint: hint }
    })
    groups.set(groupKey, { gatewayId: '__api_utilities__', gatewayName: 'Batshit Utilities', baseName: 'Batshit Utilities',
      name: 'Batshit Utilities', source: 'api-utilities', toolCount: tools.length, visibility: 'group+tools', tools })
    dcmToolCount += tools.length
    availableToolCount += tools.length
  }

  if (dynamicMcpEnabled) {
    for (const [toolName, tool] of Object.entries(allTools)) {
      if (shouldHideInternalMcpTool(toolName)) {
        continue
      }
      availableToolCount += 1

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

      // SA-120 P1: the discoverable list follows discoverability, not the DCM listing —
      // an enabled tool is skipped from the text below but is still a valid hint target.
      discoverable.push({
        ref: `mcp:${toolName}`,
        family: 'mcp',
        name: toolName,
        group: baseGroupName,
        groupKey: buildCompositeKey(gatewayId, baseGroupName),
        description: normalizeDescription((tool as any)?.description),
        hint: getSchemaHintText(buildSchemaSummary(extractSchema(tool), schemaHintCaps)) || null,
        enabled: enabledToolNames.has(toolName)
      })

      if (!includeEnabledTools && enabledToolNames.has(toolName)) {
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

        discoverable.push({
          ref: `cli:${record.toolId}`,
          family: 'cli',
          name: record.toolId,
          group: CLI_TOOL_GRID_GROUP_NAME,
          groupKey,
          description: normalizeDescription(
            [record.title, record.description].filter(Boolean).join(' — ')
          ),
          hint: buildCliFieldSummary((record as Record<string, any>).inputSchema, schemaHintCaps) || null,
          enabled: false
        })

        cliGroup.toolCount += 1
        dcmToolCount += 1

        if (groupVisibility === 'group+tools') {
          cliGroup.tools = cliGroup.tools || []
          cliGroup.tools.push({
            name: record.toolId,
            visibility: toolVisibility,
            schemaHint: toolVisibility === 'name+hint'
              ? truncateHint(buildCliToolHint(record as Record<string, any>, schemaHintCaps), schemaHintCaps.maxChars)
              : null
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
    ? resolveBrokerRuntimeAllowedControlIds({
        runtime: brokerRuntime,
        toggles: brokerToggles,
        allowFabricControlTools: options.allowFabricControlTools,
        memoryControlsEnabled,
        whiteboardControlsEnabled,
        dmControlsEnabled,
        scheduleControlsEnabled,
        judgeControlsEnabled
      })
    : []
  const fabricControls = fabricReachable
    ? await (await loadListVisibleControls())({
        p5McpOwner: options.p5McpOwner,
        actorType: options.controlActorType ?? (options.primarySettingsActor === true ? 'in-process' : undefined),
        ownedPrimaryPreview: options.primarySettingsActor === true && options.controlActorType === 'session',
        userId,
        agentId: controlAgentId,
        runtimeMode: controlRuntimeMode,
        allowedControlIds: fabricAllowedControlIds
      })
    : []

  const featureBlocks: AgentSetupBlock[] = []
  const featureRefs = new Set<string>()
  const completeFeatureHintRefs = new Set<string>()
  // This is the exact actor/runtime allowance already used by broker registration/search.
  // Metadata contributes relevance only; display-only hiding and Admin caps cannot remove
  // fields from a deliberately opened skill.
  const nativeSkillControls = fabricReachable ? NATIVE_FABRIC_HELPER_CONTROL_META.filter(meta =>
    isControlIdAllowedByList(meta.controlId, fabricAllowedControlIds)) : []
  const nativeSkillControlIds = new Set(nativeSkillControls.map(meta => meta.controlId))
  const allowedSkillToolHints = [
    ...nativeSkillControls,
    ...fabricControls.filter(control => !nativeSkillControlIds.has(control.controlId)),
    ...apiUtilities
  ].map(control => ({ controlId: control.controlId, ref: brokerControlRef(control.controlId),
    schemaHint: control.schemaHint?.trim() || null }))
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

    // Display-only Fabric choices cannot hide the hints replacing emitted guidance.
    // `entries` has already passed the exact live actor/runtime/control allowance.
    const gates: NonNullable<DynamicMcpIndexOptions['featureHintGates']> = options.featureHintGates ?? (options.primarySettingsActor ? {
      memory: memoryControlsEnabled, dm: dmControlsEnabled, schedule: scheduleControlsEnabled,
      judge: judgeControlsEnabled, whiteboard: whiteboardControlsEnabled,
      zip: brokerToggles.fetchZipEnabled, skill: true
    } : {})
    const fixedDefinitions = [
      ...NATIVE_FABRIC_HELPER_CONTROL_META.filter(meta => meta.controlId === 'sys.zip.fetch' &&
        isControlIdAllowedByList(meta.controlId, fabricAllowedControlIds)),
      ...fabricControls.filter(control => control.sourceType === 'core' && !nativeHelperIds.has(control.controlId))
    ]
    for (const [index, { id: gate, label, controls }] of AGENT_SETUP_FEATURES.entries()) {
      if (!gates[gate]) continue
      const selected = fixedDefinitions.filter(entry => (controls as readonly string[]).includes(entry.controlId))
        .map(entry => ({ name: entry.controlId, hint: entry.schemaHint }))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      if (!selected.length) continue
      for (const entry of selected) {
        featureRefs.add(brokerControlRef(entry.name))
        if (entry.hint?.trim()) completeFeatureHintRefs.add(brokerControlRef(entry.name))
      }
      featureBlocks.push({
        key: `feature:${gate}`, source: 'controls', order: index, section: 'tools', hintClass: 'fixed-feature',
        text: `- ${label}:\n` + selected.map(entry => `  - ${brokerControlRef(entry.name)}${entry.hint ? ` — ${setupMetadata(entry.hint)}` : ''}`).join('\n'),
        items: selected.map(entry => ({ key: brokerControlRef(entry.name), label: brokerControlRef(entry.name),
          text: `${brokerControlRef(entry.name)}${entry.hint ? ` — ${entry.hint}` : ''}` }))
      })
      for (const entry of selected) {
        if (discoverable.some(row => row.ref === brokerControlRef(entry.name))) continue
        discoverable.push({ ref: brokerControlRef(entry.name), family: isBatshitUtilityControlId(entry.name) ? 'batshit' : 'fabric',
          name: entry.name, group: FABRIC_TOOL_GRID_DISPLAY_NAME, description: null,
          hint: entry.hint, enabled: false, groupKey: buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME) })
      }
    }

    availableToolCount += entries.length
    // These exact tools already have their full always-on Setup lines. The retained
    // family/count line describes only the remaining searchable operational tools.
    const remainingEntries = entries.filter(entry => !featureRefs.has(brokerControlRef(entry.name)))
    const fabricGroup = buildBrokerFamilyGroup({
      gatewayId: FABRIC_TOOL_GRID_ID,
      groupName: FABRIC_TOOL_GRID_GROUP_NAME,
      displayName: FABRIC_TOOL_GRID_DISPLAY_NAME,
      gatewayDefaults: fabricToolGridSettings.dcmDisplayDefaults,
      agentSettings: dcmDisplaySettings,
      entries: remainingEntries,
      describeFamilies: describeFabricControlFamilies,
      alwaysOneLine: true
    })
    if (fabricGroup) {
      fabricGroup.skillGuidance = true
      dcmToolCount += fabricGroup.toolCount
      groups.set(buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME), fabricGroup)
      // Same per-entry visibility the group applied: hidden controls never become hints.
      const visibleNames = new Set(
        (fabricGroup.tools ?? entries.map((entry) => ({ name: entry.name }))).map((tool) => tool.name)
      )
      for (const entry of entries) {
        if (fabricGroup.tools && !visibleNames.has(entry.name)) continue
        if (featureRefs.has(brokerControlRef(entry.name))) continue
        discoverable.push({
          ref: brokerControlRef(entry.name),
          family: isBatshitUtilityControlId(entry.name) ? 'batshit' : 'fabric',
          name: entry.name,
          group: FABRIC_TOOL_GRID_DISPLAY_NAME,
          groupKey: buildCompositeKey(FABRIC_TOOL_GRID_ID, FABRIC_TOOL_GRID_GROUP_NAME),
          description: null,
          hint: entry.hint,
          enabled: false
        })
      }
    }
  }

  // SA-096 P4: published agent-usable artifacts. Only the `use.artifact.{slug}` aliases are
  // agent-runnable; the per-artifact `artifact.<id>.*` config controls belong to the Fabric
  // family, so they are reported here as a count and only when Fabric is actually reachable.
  if (artifactReachable) {
    const artifactControls = await (await loadListVisibleControls())({
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
      alwaysDiscoverable: true,
      groupName: ARTIFACT_TOOL_GRID_GROUP_NAME,
      gatewayDefaults: artifactToolGridSettings.dcmDisplayDefaults,
      agentSettings: dcmDisplaySettings,
      entries,
      note: 'artifact_hint: run these with the exact artifact:use.artifact.{slug} ref and structured field input. User-only artifacts (Static / No AI tools, Gradio/HuggingFace embeds, ComfyUI panel artifacts) are not agent-runnable; tell the user instead of changing an artifact brain type or power source.'
    })
    if (artifactGroup) {
      dcmToolCount += artifactGroup.toolCount
      groups.set(
        buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME),
        artifactGroup
      )
      const visibleNames = new Set(
        (artifactGroup.tools ?? entries.map((entry) => ({ name: entry.name }))).map((tool) => tool.name)
      )
      for (const entry of entries) {
        if (artifactGroup.tools && !visibleNames.has(entry.name)) continue
        discoverable.push({
          ref: `artifact:${entry.name}`,
          family: 'artifact',
          name: entry.name,
          group: ARTIFACT_TOOL_GRID_GROUP_NAME,
          groupKey: buildCompositeKey(ARTIFACT_TOOL_GRID_ID, ARTIFACT_TOOL_GRID_GROUP_NAME),
          description: null,
          hint: entry.hint,
          enabled: false
        })
      }
    }
  }

  const workingGroups = Array.from(groups.values())
  applyDuplicateGroupDisambiguation(workingGroups)

  const sortedGroups = Array.from(groups.entries())
    .sort(([, left], [, right]) => left.name.localeCompare(right.name))
    .map(([id, group]) => ({
      id,
      source: group.source ?? (group.gatewayId === CLI_TOOL_GRID_ID ? 'cli'
        : group.gatewayId === FABRIC_TOOL_GRID_ID || group.gatewayId === ARTIFACT_TOOL_GRID_ID ? 'controls' : `mcp:${group.gatewayId}`),
      name: group.name,
      toolCount: group.toolCount,
      visibility: group.visibility,
      tools: group.tools,
      note: group.note ?? null,
      ...(group.families ? { families: group.families } : {}),
      ...(group.skillGuidance ? { skillGuidance: true } : {}),
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
      ? [...group.tools].filter(entry => group.source !== 'controls' || !featureRefs.has(brokerControlRef(entry.name))).sort((left, right) => left.name.localeCompare(right.name))
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
  const groupBody = (group: DynamicMcpIndexGroup) => buildDcmText([group]).split('\n').slice(2).join('\n')
  const bodyTokens = () => estimateTokens(resultGroups.map(groupBody).join('\n'))
  // Exact display choices still respect the total budget. Collapse the largest
  // complete groups, with stable IDs breaking ties; never drop identities.
  for (const group of [...resultGroups].filter(group => group.tools?.length || group.note).sort((a, b) => {
    const cost = estimateTokens(groupBody(b)) - estimateTokens(groupBody(a))
    return cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })) {
    if (bodyTokens() <= totalHintTokens) break
    group.tools = undefined
    group.note = null
  }
  if (bodyTokens() > totalHintTokens) throw new ToolHintBudgetError(totalHintTokens, bodyTokens())
  const setupBlocks: AgentSetupBlock[] = [...featureBlocks, ...resultGroups.map((group, index) => ({
    key: group.id, source: group.source, order: 100 + index, section: 'tools' as const, hintClass: 'scalable-tools' as const,
    text: groupBody(group),
    items: [
      { key: `group:${group.id}`, label: group.name, text: formatGroupLine(group.name, group.toolCount, group.families, group.skillGuidance) +
        (group.tools?.length ? `; listed tools: ${group.tools.map(tool => `${setupMetadata(tool.ref ?? tool.name)}${tool.visibility === 'name+hint' && tool.schemaHint ? ' (hint)' : ''}`).join(', ')}` : '; names and count only') },
      ...(group.note ? [{ key: `group-note:${group.id}`, label: `${group.name} note`, text: group.note }] : []),
      ...discoverable.filter(entry => entry.groupKey === group.id && !featureRefs.has(entry.ref))
        .map(entry => {
          const displayed = group.tools?.find(tool => tool.name === entry.name)
          const detail = !displayed ? ' (details not listed in Agent Setup)'
            : displayed.visibility === 'name+hint' && displayed.schemaHint ? ` — ${displayed.schemaHint}` : ' (name only)'
          return { key: entry.ref, label: entry.ref, text: entry.ref + detail }
        })
    ]
  }))]
  const body = setupBlocks.map(block => block.text).filter(Boolean).join('\n')
  const dcmText = body ? ['tool_discovery', '(current discoverable tools and hints for this agent)', body].join('\n') : ''

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
    discoverable: discoverable.sort((left, right) => left.ref.localeCompare(right.ref)),
    resolvedGatewayIds: dynamicMcpEnabled ? (enabled.resolvedGateways ?? null) : null,
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
    schemaHintCaps,
    setupBlocks, sources, allowedSkillToolHints, completeFeatureHintRefs: [...completeFeatureHintRefs],
    hintBudget: { limit: totalHintTokens, budgetedTokens: bodyTokens(), featureTokens: estimateTokens(featureBlocks.map(block => block.text).join('\n')) },
    apiUtilityProjection
  }
}

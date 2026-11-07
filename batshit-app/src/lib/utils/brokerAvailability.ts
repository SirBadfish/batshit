/**
 * Shared truth about whether the Batshit Tool Search/Use broker is actually reachable.
 *
 * SA-096 P5. Three runtimes register the broker under three different conditions:
 *
 *   - `api`  — `buildMode3NativeTools` registers `native_batshit_tool_search` /
 *              `native_batshit_tool_use` when at least one family is allowed.
 *   - `cli`  — the managed STDIO helper bridge exposed `batshit_tool_search` /
 *              `batshit_tool_use` (removed with the CLI Subagent in SA-139 R5).
 *
 * Before this module, the compiled system prompt gated its broker guidance on the Dynamic
 * MCP toggle alone. An agent with Dynamic MCP off but a live Fabric or artifact family got
 * the broker tools registered and no instructions for them, and an agent with Dynamic MCP
 * on but nothing reachable paid ~900 tokens explaining a broker that would return nothing.
 *
 * Every one of those call sites now derives its families here, so registration and prompt
 * guidance cannot drift. Re-implementing any of these conditions elsewhere reintroduces a
 * Fragility-Map-class divergence — extend this module instead.
 *
 * This file must stay pure and free of `$lib/server` imports. SA-106 retired the n8n
 * compile twin that first imposed that rule, but the constraint DID NOT lift: the Tool
 * Grid reaches this module from the browser (`toolGridConfig.ts`, `GlobalToolGrid.svelte`,
 * `AgentMcpDefaultsCard.svelte`). Adding a server import here breaks the client bundle.
 *
 * SA-139: `BROKER_RUNTIMES` is `api` alone. Its `n8n` member served only the n8n Workflow
 * Subagent's Tool Grid and went with that type (R2); its `cli` member served the managed CLI
 * lanes, which went in R4 and R5, and was removed in P7. (The `cli` broker FAMILY below is
 * Batshit's saved CLI Tools, a live feature, not that lane.)
 */

import { API_UTILITY_CONTROL_IDS } from '$lib/utils/apiUtilityControls'

export const BROKER_TOOL_FAMILIES = [
  'mcp',
  'cli',
  'artifact',
  'fabric',
  'batshit',
  'agent_browser'
] as const

export type BrokerToolFamily = (typeof BROKER_TOOL_FAMILIES)[number]

/**
 * Which runtime's registration rules to apply: `api`, the one live lane (SA-139 P7 removed
 * `cli`; see the header). Stored `runtime:cli` prompt sections are parsed by
 * `promptRuntimeScope.ts`, not here.
 */
export const TOOL_HOST_SCOPES = ['api'] as const

/** Runtime boundary for Tool Grid and model-compatibility decisions. */
export type ToolHostScope = (typeof TOOL_HOST_SCOPES)[number]

export const BROKER_RUNTIMES = TOOL_HOST_SCOPES

export type BrokerRuntime = ToolHostScope

/**
 * The six agent toggles that decide broker reachability, already resolved to definite
 * booleans with their product defaults applied.
 */
export interface BrokerToolToggles {
  fetchZipEnabled: boolean
  dynamicMcpEnabled: boolean
  cliToolsEnabled: boolean
  artifactRuntimeEnabled: boolean
  batshitToolsEnabled: boolean
  agentBrowserEnabled: boolean
}

function parseBrokerToggleValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
  }
  return undefined
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {}
}

/**
 * Reads the broker-relevant toggles out of an agent's `provider_specific_settings`.
 *
 * Settings may live nested under `nativeTools` / `batshitNativeTools` or flat on the
 * provider settings object, and each toggle has a legacy `native*` alias. Nested wins over
 * flat, and an unparseable value falls through to the next candidate key rather than
 * counting as "set". This mirrors what `resolveNativeToolSettings` has always done — that
 * function now delegates these six fields here so the registration path and the prompt
 * path read agent settings identically.
 */
export function resolveBrokerToolToggles(providerSettings?: unknown): BrokerToolToggles {
  const settings = asRecord(providerSettings)
  const nested = settings.nativeTools && typeof settings.nativeTools === 'object'
    ? asRecord(settings.nativeTools)
    : asRecord(settings.batshitNativeTools)

  const getToggle = (...keys: string[]): boolean | undefined => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(nested, key)) {
        const parsed = parseBrokerToggleValue(nested[key])
        if (parsed !== undefined) return parsed
      }
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        const parsed = parseBrokerToggleValue(settings[key])
        if (parsed !== undefined) return parsed
      }
    }
    return undefined
  }

  return {
    fetchZipEnabled: getToggle('fetchZipEnabled', 'nativeFetchZipEnabled') ?? true,
    dynamicMcpEnabled: getToggle('dynamicMcpEnabled', 'nativeDynamicMcpEnabled') ?? true,
    cliToolsEnabled: getToggle('cliToolsEnabled', 'nativeCliToolsEnabled') ?? true,
    // Artifact runtime predates its own toggle; agents saved before it existed inherit the
    // Batshit Tools toggle rather than silently defaulting on.
    artifactRuntimeEnabled:
      getToggle('artifactRuntimeEnabled', 'nativeArtifactRuntimeEnabled') ??
      getToggle('batshitToolsEnabled', 'nativeBatshitToolsEnabled') ??
      true,
    batshitToolsEnabled: getToggle('batshitToolsEnabled', 'nativeBatshitToolsEnabled') ?? true,
    agentBrowserEnabled: getToggle('agentBrowserEnabled', 'nativeAgentBrowserEnabled') ?? true
  }
}

/**
 * THE rule for "is this agent's Fabric & Utilities switch on?" — the Settings switch saved as
 * `provider_specific_settings.nativeTools.batshitToolsEnabled` (default ON). The DM, schedule
 * and Judge Juice judgment tools are Fabric controls served only with it on, so their own
 * switches resolve through this too (`resolveAgentDmsEnabled`, `resolveAgentJevJudgeToolEnabled`;
 * Josh, 2026-10-24): an agent with it off is never taught tools it cannot call.
 */
export function resolveAgentFabricUtilitiesEnabled(agent: unknown): boolean {
  const record = agent && typeof agent === 'object' ? (agent as Record<string, unknown>) : null
  return resolveBrokerToolToggles(record?.provider_specific_settings).batshitToolsEnabled
}

export interface BrokerAvailabilityInput {
  runtime: BrokerRuntime
  toggles: BrokerToolToggles
  /**
   * Whether the agent has at least one saved CLI Tool selected.
   *
   * `undefined` means "not resolved here". The `api` and `cli` runtimes require a real
   * selection before registering the `cli` family, but a caller that cannot reach the CLI
   * tool registry (the Tool Grid runs in the browser) must not be able to make the gate
   * narrower than registration. Unresolved therefore counts as reachable: over-shipping
   * guidance is recoverable, withholding it from an agent that has the tools is not.
   */
  hasCliTools?: boolean
  /** Subagent scoping. Subagents may keep artifact runtime while losing Fabric control. */
  allowArtifactRuntimeTools?: boolean
  allowFabricControlTools?: boolean
  /**
   * SA-104 P3: true only for PRIMARY actors whose agent has `memory_enabled`. Memory
   * controls (`sys.memory.*`) are a scoped first-party allowance for memory-enabled
   * API/CLI Primary Agents. Default false: memory is opt-in.
   */
  memoryControlsEnabled?: boolean
  /** SA-133: exact API-primary whiteboard allowance, independent of Memory. */
  whiteboardControlsEnabled?: boolean
  /**
   * SA-113 P2 (DL-113-03): true only for PRIMARY actors whose agent has `dms_enabled`.
   * Same shape as `memoryControlsEnabled`, and default false for the same reason — DMs
   * are opt-in per agent, and an agent without them pays no bytes and sees no tools.
   */
  dmControlsEnabled?: boolean
  /**
   * SA-115 P2 (DL-115-10): true only for PRIMARY actors whose agent has `dms_enabled` —
   * the SAME switch as `dmControlsEnabled`, because a schedule's only output is a DM and
   * an agent with DMs off could build a clock whose alarm it can never hear.
   */
  scheduleControlsEnabled?: boolean
  /**
   * SA-120 P2 (DL-120-06): true only for PRIMARY actors whose agent has
   * `jev_juice_judge_tool` ON. Same shape as memory and DMs, default false: the judgment
   * tool is opt-in per agent, and a delegated run never receives it.
   */
  judgeControlsEnabled?: boolean
}

/**
 * The families the broker will actually serve for this agent on this runtime.
 *
 * Each branch mirrors one registration site exactly. Keep them in sync in the same commit.
 */
export function resolveBrokerFamilies(input: BrokerAvailabilityInput): BrokerToolFamily[] {
  const { toggles } = input
  const allowArtifact = input.allowArtifactRuntimeTools !== false
  const cliReachable = toggles.cliToolsEnabled && input.hasCliTools !== false
  // Classify only the control scope this runtime already grants.
  const controlFamilies = resolveBrokerControlFamilies(resolveBrokerRuntimeAllowedControlIds(input))

  const families: BrokerToolFamily[] = []

  // Mirrors buildMode3NativeTools' apiBrokerAllowedFamilies. Agent Browser is a separate
  // native tool on this lane, not a broker family.
  if (toggles.dynamicMcpEnabled) families.push('mcp')
  if (cliReachable) families.push('cli')
  if (toggles.artifactRuntimeEnabled && allowArtifact) families.push('artifact')
  families.push(...controlFamilies)
  return families
}

/** The existing control scope after tool-host restrictions, shared with discovery. */
export function resolveBrokerRuntimeAllowedControlIds(input: BrokerAvailabilityInput): string[] {
  return resolveBrokerFabricAllowedControlIds({
    ...input,
    allowFabricControlTools: input.allowFabricControlTools !== false,
    allowFetchZip: true,
    whiteboardControlsEnabled: input.whiteboardControlsEnabled === true
  })
}

/** True when the broker tool pair is registered for this agent on this runtime. */
export function isBrokerAvailable(input: BrokerAvailabilityInput): boolean {
  return resolveBrokerFamilies(input).length > 0
}

/** The `sys.zip.fetch` control the fetch-zip toggle opens on the Fabric lane. */
export const BROKER_FABRIC_FETCH_ZIP_CONTROL_ID = 'sys.zip.fetch'

/**
 * The Fabric control-id scope the Batshit Tools toggle opens, minus the two entries that
 * follow their own toggles (`sys.zip.fetch` and the Dynamic MCP pair).
 */
export const BROKER_FABRIC_BATSHIT_TOOLS_CONTROL_IDS = [
  'sys.ui.*',
  'sys.app_settings.native.report',
  'sys.app_settings.native.change',
  'sys.comfyui.*',
  'sys.artifact.*',
  'artifact.*',
  'sys.model_catalog.search',
  'sys.cli_tool.*',
  'sys.skill.save',
  'sys.skill.import',
  'sys.runtime_addon.*',
  // SA-072 P1 (DL-08): broad scope, no allowance constant of its own, so Subagents and Workers
  // (which lose the Fabric control plane) never get it.
  'sys.pinokio.*',
  'sys.voice.engine.register',
  'sys.voice.engine.update',
  'sys.voice.engine.health_check',
  'sys.voice.engine.complete_local_setup',
  'sys.voice.engine.enable',
  'sys.voice.engine.delete'
] as const

/**
 * SA-104 P3: the memory tool family. A scoped first-party allowance for PRIMARY actors on
 * every runtime when the agent has memory enabled — deliberately outside
 * the broad-control-plane gate, like `sys.zip.fetch`. Subagents never receive these
 * (subagent memory access is a deferred product decision; memory is PA-owned state).
 */
export const BROKER_FABRIC_MEMORY_CONTROL_IDS = ['sys.memory.*'] as const

/**
 * SA-113 P2 (DL-113-03): the Agent DM family. One constant, one boolean, three
 * registration sites — the same shape as memory, deliberately, so there is one place to
 * audit "who can DM". Subagents and Workers never receive these: a delegated run has no
 * inbox and no identity of its own to write from.
 */
export const BROKER_FABRIC_DM_CONTROL_IDS = ['sys.dm.*'] as const

/**
 * SA-115 P2 (DL-115-10): the Schedules family — an agent's own hand on the clock. Same
 * shape again, and gated on the SAME per-agent switch as DMs, because a schedule's only
 * output is a DM. Subagents and Workers never receive these: a delegated run is over in a
 * moment and has no business creating something that outlives it.
 */
export const BROKER_FABRIC_SCHEDULE_CONTROL_IDS = ['sys.schedule.*'] as const

/**
 * SA-120 P2 (DL-120-06): the Judge Juice judgment tool family (`sys.judge.ask`). Same shape
 * once more: one constant, one boolean, PRIMARY actors only, opened at the same
 * registration sites and passed explicit `false` from every subagent and Worker scope. A
 * delegated run never judges through Jev on the user's key; the primary decides for it.
 */
export const BROKER_FABRIC_JUDGE_CONTROL_IDS = ['sys.judge.ask'] as const

export interface BrokerFabricScopeInput {
  toggles: BrokerToolToggles
  /**
   * False for actors that keep artifact runtime but lose the Fabric control plane
   * (subagents, and the automation lane's non-primary/non-mode3/4 actors).
   */
  allowFabricControlTools?: boolean
  /**
   * False where fetch-zip is not served through the broker for this actor. The automation
   * lane only opens it for primary actors; mode 3 opens it whenever the toggle is on.
   */
  allowFetchZip?: boolean
  /** SA-104 P3: PRIMARY actor + agent `memory_enabled`. Default false (opt-in). */
  memoryControlsEnabled?: boolean
  whiteboardControlsEnabled?: boolean
  /** SA-113 P2: PRIMARY actor + agent `dms_enabled`. Default false (opt-in). */
  dmControlsEnabled?: boolean
  /** SA-115 P2: PRIMARY actor + agent `dms_enabled`. Default false (opt-in). */
  scheduleControlsEnabled?: boolean
  /** SA-120 P2: PRIMARY actor + agent `jev_juice_judge_tool`. Default false (opt-in). */
  judgeControlsEnabled?: boolean
}

/**
 * The exact Fabric control ids the broker will serve for this agent.
 *
 * SA-096 P4. Both broker registration sites built this set inline, which made the DCM
 * capability index unable to state a truthful Fabric count without a third copy. The
 * count is the whole point of the Fabric Tool Grid row, so the set moved here.
 */
export function resolveBrokerFabricAllowedControlIds(input: BrokerFabricScopeInput): string[] {
  const allowFabric = input.allowFabricControlTools !== false
  const allowFetchZip = input.allowFetchZip !== false
  const allowed = new Set<string>()

  if (input.toggles.fetchZipEnabled && allowFetchZip) {
    allowed.add(BROKER_FABRIC_FETCH_ZIP_CONTROL_ID)
  }

  if (input.toggles.batshitToolsEnabled && allowFabric) {
    if (input.toggles.dynamicMcpEnabled) {
      allowed.add('sys.mcp.dynamic.find')
      allowed.add('sys.mcp.dynamic.use')
    }
    for (const controlId of BROKER_FABRIC_BATSHIT_TOOLS_CONTROL_IDS) {
      allowed.add(controlId)
    }
  }

  // SA-104 P3: memory controls follow the Batshit Tools toggle plus per-agent memory
  // enablement, independent of the broad-control-plane gate.
  if (input.toggles.batshitToolsEnabled && input.memoryControlsEnabled === true) {
    for (const controlId of BROKER_FABRIC_MEMORY_CONTROL_IDS) {
      allowed.add(controlId)
    }
  }
  if (input.toggles.batshitToolsEnabled && input.whiteboardControlsEnabled === true) {
    allowed.add('sys.whiteboard.update')
  }

  // SA-113 P2: DM controls, same rule.
  if (input.toggles.batshitToolsEnabled && input.dmControlsEnabled === true) {
    for (const controlId of BROKER_FABRIC_DM_CONTROL_IDS) {
      allowed.add(controlId)
    }
  }

  // SA-115 P2: schedule controls, same rule again.
  if (input.toggles.batshitToolsEnabled && input.scheduleControlsEnabled === true) {
    for (const controlId of BROKER_FABRIC_SCHEDULE_CONTROL_IDS) {
      allowed.add(controlId)
    }
  }

  // SA-120 P2: the Judge Juice judgment tool, same rule again.
  if (input.toggles.batshitToolsEnabled && input.judgeControlsEnabled === true) {
    for (const controlId of BROKER_FABRIC_JUDGE_CONTROL_IDS) {
      allowed.add(controlId)
    }
  }

  return Array.from(allowed)
}

/** Generic utilities share the control executor, but do not operate Batshit itself. */
export const BROKER_BATSHIT_UTILITY_CONTROL_IDS = [
  ...Object.values(API_UTILITY_CONTROL_IDS),
  'sys.judge.ask',
  'sys.mcp.dynamic.find',
  'sys.mcp.dynamic.use'
] as const

export function isBatshitUtilityControlId(controlId: string): boolean {
  return (BROKER_BATSHIT_UTILITY_CONTROL_IDS as readonly string[]).includes(controlId)
}

export function brokerControlRef(controlId: string): string {
  return `${isBatshitUtilityControlId(controlId) ? 'batshit' : 'fabric'}:${controlId}`
}

/** Partition the already actor/runtime-resolved allowlist, never rebuild its gates. */
export function resolveBrokerControlFamilies(allowedControlIds: readonly string[]): Array<'fabric' | 'batshit'> {
  const families: Array<'fabric' | 'batshit'> = []
  if (allowedControlIds.some((id) => !isBatshitUtilityControlId(id))) families.push('fabric')
  if (BROKER_BATSHIT_UTILITY_CONTROL_IDS.some((id) =>
    isControlIdAllowedByList(id, [...allowedControlIds])
  )) families.push('batshit')
  return families
}

/** The artifact family's control-id scope. Typed invoke aliases only. */
export const BROKER_ARTIFACT_ALLOWED_CONTROL_IDS = ['use.artifact.*'] as const

/**
 * The flags every Subagent and Worker scope passes to the two functions above: the published
 * artifact tools stay, the broad Fabric control plane is primary-only (SA-064), and each
 * agent-owned family is primary-only too (memory SA-104, DMs SA-113, schedules SA-115, the
 * judgment tool SA-120). One constant, read by the Subagent DCM index and the Settings DCM
 * preview, so they cannot drift apart.
 */
export const DELEGATED_RUN_BROKER_SCOPE = {
  allowArtifactRuntimeTools: true,
  allowFabricControlTools: false,
  memoryControlsEnabled: false,
  whiteboardControlsEnabled: false,
  dmControlsEnabled: false,
  scheduleControlsEnabled: false,
  judgeControlsEnabled: false
} as const

/**
 * BL-81 — the broker inputs a Subagent or Worker run is offered through: the API runtime
 * and the six toggles from its resolved native tool settings.
 *
 * The Subagent DCM index (`buildManagedSubagentDynamicInfo`) reads the run this way, from the
 * resolved scope its in-process broker registers from. (Its other reader, the control scope
 * minted onto a delegated CLI run's credential, went with the CLI Subagent in SA-139 R5.)
 */
export function resolveDelegatedRunBrokerInputs(scope: {
  nativeToolSettings: BrokerToolToggles
}): { runtime: BrokerRuntime; toggles: BrokerToolToggles } {
  const settings = scope.nativeToolSettings
  return {
    // A retired Subagent type never runs (SA-139 R2, R5), so every delegated run is on `api`.
    runtime: 'api',
    toggles: {
      fetchZipEnabled: settings.fetchZipEnabled,
      dynamicMcpEnabled: settings.dynamicMcpEnabled,
      cliToolsEnabled: settings.cliToolsEnabled,
      artifactRuntimeEnabled: settings.artifactRuntimeEnabled,
      batshitToolsEnabled: settings.batshitToolsEnabled,
      agentBrowserEnabled: settings.agentBrowserEnabled
    }
  }
}

/** Matches one control id against one allowlist entry, which may contain `*` wildcards. */
export function controlIdMatchesAllowedEntry(controlId: string, allowedEntry: string): boolean {
  const normalizedControlId = controlId.trim()
  const normalizedAllowed = allowedEntry.trim()
  if (!normalizedControlId || !normalizedAllowed) return false
  if (normalizedAllowed === normalizedControlId) return true
  if (!normalizedAllowed.includes('*')) return false
  const escaped = normalizedAllowed
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(normalizedControlId)
}

/** True when the control id is inside a broker allowlist. An empty list allows nothing. */
export function isControlIdAllowedByList(
  controlId: string,
  allowedControlIds?: string[] | null
): boolean {
  if (!Array.isArray(allowedControlIds) || allowedControlIds.length === 0) return false
  return allowedControlIds.some((entry) => controlIdMatchesAllowedEntry(controlId, entry))
}

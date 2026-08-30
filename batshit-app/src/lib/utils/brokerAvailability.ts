/**
 * Shared truth about whether the Batshit Tool Search/Use broker is actually reachable.
 *
 * SA-096 P5. Three runtimes register the broker under three different conditions:
 *
 *   - `api`  — `buildMode3NativeTools` registers `native_batshit_tool_search` /
 *              `native_batshit_tool_use` when at least one family is allowed.
 *   - `cli`  — `resolveEnabledMode4InternalHelperTools` exposes `batshit_tool_search` /
 *              `batshit_tool_use` over the managed STDIO bridge.
 *   - `n8n`  — the Batshit Tools automation pack advertises the same action pair in DCM.
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
 * This file must stay pure and free of `$lib/server` imports: `databaseRedis.client.ts`
 * (the n8n compile twin) is client-reachable and imports it.
 */

export const BROKER_TOOL_FAMILIES = [
  'mcp',
  'cli',
  'artifact',
  'fabric',
  'agent_browser'
] as const

export type BrokerToolFamily = (typeof BROKER_TOOL_FAMILIES)[number]

/** Which runtime's registration rules to apply. Matches `PromptRuntimeScope`. */
export const BROKER_RUNTIMES = ['api', 'cli', 'n8n'] as const

export type BrokerRuntime = (typeof BROKER_RUNTIMES)[number]

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

export interface BrokerAvailabilityInput {
  runtime: BrokerRuntime
  toggles: BrokerToolToggles
  /**
   * Whether the agent has at least one saved CLI Tool selected.
   *
   * `undefined` means "not resolved here". The `api` and `cli` runtimes require a real
   * selection before registering the `cli` family, but a caller that cannot reach the CLI
   * tool registry (the n8n compile twin is client-side) must not be able to make the gate
   * narrower than registration. Unresolved therefore counts as reachable: over-shipping
   * guidance is recoverable, withholding it from an agent that has the tools is not.
   */
  hasCliTools?: boolean
  /** Subagent scoping. Subagents may keep artifact runtime while losing Fabric control. */
  allowArtifactRuntimeTools?: boolean
  allowFabricControlTools?: boolean
  /**
   * SA-104 P3: true only for PRIMARY actors whose agent has `memory_enabled`. Memory
   * controls (`sys.memory.*`) are a scoped first-party allowance on every runtime —
   * the `sys.zip.fetch` precedent — so they can open the fabric family even where the
   * broad control plane stays closed (n8n). Default false: memory is opt-in.
   */
  memoryControlsEnabled?: boolean
}

/**
 * The families the broker will actually serve for this agent on this runtime.
 *
 * Each branch mirrors one registration site exactly. Keep them in sync in the same commit.
 */
export function resolveBrokerFamilies(input: BrokerAvailabilityInput): BrokerToolFamily[] {
  const { toggles } = input
  const allowArtifact = input.allowArtifactRuntimeTools !== false
  const allowFabric = input.allowFabricControlTools !== false
  const cliReachable = toggles.cliToolsEnabled && input.hasCliTools !== false
  // Memory controls ride the Batshit Tools toggle but not the broad-control-plane gate,
  // so a memory-enabled n8n primary reaches the fabric family even with fetch-zip off.
  const memoryReachable = toggles.batshitToolsEnabled && input.memoryControlsEnabled === true

  const families: BrokerToolFamily[] = []

  if (input.runtime === 'n8n') {
    // Mirrors the Batshit Tools automation pack DCM. n8n advertises the CLI family from
    // the toggle alone; the pack resolves selections server-side at call time.
    if (toggles.dynamicMcpEnabled) families.push('mcp')
    if (toggles.cliToolsEnabled) families.push('cli')
    if (toggles.artifactRuntimeEnabled) families.push('artifact')
    if (toggles.agentBrowserEnabled) families.push('agent_browser')
    if (toggles.fetchZipEnabled || memoryReachable) families.push('fabric')
    return families
  }

  if (input.runtime === 'cli') {
    // Mirrors resolveEnabledMode4InternalHelperTools. Fetch-zip is its own helper tool on
    // this lane (`batshit_server_fetch_zip`), so it does not open the Fabric family.
    if (toggles.dynamicMcpEnabled) families.push('mcp')
    if (cliReachable) families.push('cli')
    if (toggles.artifactRuntimeEnabled) families.push('artifact')
    if (toggles.agentBrowserEnabled) families.push('agent_browser')
    if (toggles.batshitToolsEnabled) families.push('fabric')
    return families
  }

  // Mirrors buildMode3NativeTools' apiBrokerAllowedFamilies. Agent Browser is a separate
  // native tool on this lane, not a broker family.
  if (toggles.dynamicMcpEnabled) families.push('mcp')
  if (cliReachable) families.push('cli')
  if (toggles.artifactRuntimeEnabled && allowArtifact) families.push('artifact')
  if (toggles.fetchZipEnabled || (toggles.batshitToolsEnabled && allowFabric) || memoryReachable) {
    families.push('fabric')
  }
  return families
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
  'sys.comfyui.*',
  'sys.artifact.*',
  'artifact.*',
  'sys.model_catalog.search',
  'sys.cli_tool.*',
  'sys.skill.save',
  'sys.skill.import',
  'sys.runtime_addon.*',
  'sys.voice.engine.register',
  'sys.voice.engine.update',
  'sys.voice.engine.health_check',
  'sys.voice.engine.complete_local_setup',
  'sys.voice.engine.enable',
  'sys.voice.engine.delete'
] as const

/**
 * SA-104 P3: the memory tool family. A scoped first-party allowance for PRIMARY actors on
 * every runtime (n8n included) when the agent has memory enabled — deliberately outside
 * the broad-control-plane gate, like `sys.zip.fetch`. Subagents never receive these
 * (subagent memory access is a deferred product decision; memory is PA-owned state).
 */
export const BROKER_FABRIC_MEMORY_CONTROL_IDS = ['sys.memory.*'] as const

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
  // enablement, independent of the broad-control-plane gate (n8n primaries included).
  if (input.toggles.batshitToolsEnabled && input.memoryControlsEnabled === true) {
    for (const controlId of BROKER_FABRIC_MEMORY_CONTROL_IDS) {
      allowed.add(controlId)
    }
  }

  return Array.from(allowed)
}

/** The artifact family's control-id scope. Typed invoke aliases only. */
export const BROKER_ARTIFACT_ALLOWED_CONTROL_IDS = ['use.artifact.*'] as const

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

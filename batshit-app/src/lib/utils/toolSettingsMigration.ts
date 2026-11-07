import { resolveBrokerToolToggles } from './brokerAvailability'
import { readTypedFileToolsValue, TYPED_FILE_TOOLS_FACTORY_DEFAULT } from './typedFileToolsGrant'

/** Only these per-agent operational preferences move. Enable/host/Bash grants do not. */
export const RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS = Object.freeze([
  'webSearchProvider', 'nativeWebSearchProvider', 'webSearchExaSearchType', 'webSearchExaType',
  'nativeWebSearchExaSearchType', 'webSearchPerplexityMaxTokensPerPage', 'nativeWebSearchPerplexityMaxTokensPerPage',
  'agentBrowserLiveViewEnabled', 'nativeAgentBrowserLiveViewEnabled',
  'agentBrowserRuntimeMode', 'nativeAgentBrowserRuntimeMode', 'agentBrowserMode',
  'agentBrowserProvider', 'nativeAgentBrowserProvider', 'agentBrowserCdpPort', 'nativeAgentBrowserCdpPort',
  'agentBrowserTimeoutMs', 'nativeAgentBrowserTimeoutMs', 'agentBrowserExecutablePath', 'nativeAgentBrowserExecutablePath',
  'agentBrowserSession', 'nativeAgentBrowserSession', 'agentBrowserProfilePath', 'agentBrowserProfile',
  'nativeAgentBrowserProfilePath', 'nativeAgentBrowserProfile', 'agentBrowserExtraFlags', 'nativeAgentBrowserExtraFlags'
] as const)

/** An access failure is not a snapshot. The physical read owner must establish this cut. */
export type TypedFileToolsGlobalSnapshot = { kind: 'absent' } | { kind: 'known'; value: unknown }
export interface TypedFileToolsMaterializationPlan {
  value: boolean
  artifactRuntimeEnabled: boolean
  source: 'agent' | 'global' | 'factory'
  agentSource: 'nativeTools' | 'batshitNativeTools' | null
  promoteAlias: boolean
  ensureProviderBag: boolean
  ensureNativeTools: boolean
}
export class ToolSettingsMigrationRefusal extends Error {
  constructor(path: string) {
    super(`Saved tool settings at ${path} are unavailable or malformed. Nothing was converted.`)
    this.name = 'ToolSettingsMigrationRefusal'
  }
}
const own = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key)
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ToolSettingsMigrationRefusal(path)
  return value as Record<string, unknown>
}
function choice(value: unknown, path: string): boolean | null {
  if (value === null || value === undefined) return null
  const parsed = readTypedFileToolsValue(value)
  if (parsed === null) throw new ToolSettingsMigrationRefusal(path)
  return parsed
}
function globalChoice(snapshot: TypedFileToolsGlobalSnapshot): boolean | null {
  if (!snapshot || typeof snapshot !== 'object') throw new ToolSettingsMigrationRefusal('Global Tool Grid source')
  if (snapshot.kind === 'absent') return null
  if (snapshot.kind !== 'known' || !own(snapshot as unknown as Record<string, unknown>, 'value')) {
    throw new ToolSettingsMigrationRefusal('Global Tool Grid source')
  }
  if (snapshot.value === null) return null
  const grid = object(snapshot.value, 'global_tool_grid_settings')
  return own(grid, 'typed_file_tools') ? choice(grid.typed_file_tools, 'global_tool_grid_settings.typed_file_tools') : null
}

/**
 * Return intent only. The physical owner later copies an active alias using its ORIGINAL
 * raw JSON and writes the boolean by leaf; copying only this key would shadow alias siblings.
 * This planner never serializes, copies, removes or modifies a provider/model record.
 */
export function planTypedFileToolsGrantMaterialization(
  providerSettings: unknown,
  globalSnapshot: TypedFileToolsGlobalSnapshot
): TypedFileToolsMaterializationPlan {
  const inherited = globalChoice(globalSnapshot)
  const ensureProviderBag = providerSettings === null || providerSettings === undefined
  const provider = ensureProviderBag ? {} : object(providerSettings, 'provider_specific_settings')
  const canonical = own(provider, 'nativeTools') ? provider.nativeTools : undefined
  const ensureNativeTools = canonical === null || canonical === undefined
  let nested: Record<string, unknown> | undefined
  let agentSource: TypedFileToolsMaterializationPlan['agentSource'] = null
  if (!ensureNativeTools) {
    nested = object(canonical, 'provider_specific_settings.nativeTools')
    agentSource = 'nativeTools'
  } else if (own(provider, 'batshitNativeTools') && provider.batshitNativeTools !== undefined && provider.batshitNativeTools !== null) {
    nested = object(provider.batshitNativeTools, 'provider_specific_settings.batshitNativeTools')
    agentSource = 'batshitNativeTools'
  }
  const explicit = nested && own(nested, 'typedFileToolsEnabled')
    ? choice(nested.typedFileToolsEnabled, `provider_specific_settings.${agentSource}.typedFileToolsEnabled`) : null
  return {
    value: explicit ?? inherited ?? TYPED_FILE_TOOLS_FACTORY_DEFAULT,
    artifactRuntimeEnabled: resolveBrokerToolToggles(provider).artifactRuntimeEnabled,
    source: explicit !== null ? 'agent' : inherited !== null ? 'global' : 'factory',
    agentSource,
    promoteAlias: agentSource === 'batshitNativeTools',
    ensureProviderBag,
    ensureNativeTools
  }
}

/** In-memory create/archive transformation only; physical live records use RAW leaf publication. */
export function materializedToolSettingsProvider(
  providerSettings: unknown,
  globalSnapshot: TypedFileToolsGlobalSnapshot
): Record<string, unknown> {
  const plan = planTypedFileToolsGrantMaterialization(providerSettings, globalSnapshot)
  const provider = plan.ensureProviderBag ? {} : object(providerSettings, 'provider_specific_settings')
  const active = plan.agentSource ? object(provider[plan.agentSource], `provider_specific_settings.${plan.agentSource}`) : {}
  const strip = (source: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...source }
    for (const field of RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS) delete next[field]
    return next
  }
  const next = strip(provider)
  if (provider.batshitNativeTools && typeof provider.batshitNativeTools === 'object' && !Array.isArray(provider.batshitNativeTools)) {
    next.batshitNativeTools = strip(provider.batshitNativeTools as Record<string, unknown>)
  }
  next.nativeTools = { ...strip(active), typedFileToolsEnabled: plan.value, artifactRuntimeEnabled: plan.artifactRuntimeEnabled }
  return next
}

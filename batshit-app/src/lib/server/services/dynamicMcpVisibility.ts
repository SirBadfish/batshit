/**
 * Dynamic MCP visibility resolution.
 *
 * The shared rules that decide whether a group or tool is discoverable and how much
 * detail it shows. Both the capability index (`dynamicMcpIndex`) and the Dynamic MCP
 * find/use executor (`dynamicMcpTools`) resolve visibility through exactly these
 * functions, which is the contract that keeps `_find` results and DCM text agreeing.
 *
 * This lives in its own leaf module for that reason and for a structural one. SA-096 P4
 * gave `dynamicMcpIndex` a dependency on `fabricRegistry` so the index could report a
 * truthful Fabric count, which closed a cycle:
 *   `dynamicMcpTools` -> `dynamicMcpIndex` -> `fabricRegistry` -> `dynamicMcpTools`
 * (the registry\'s `sys.mcp.dynamic.*` controls delegate to the shared Dynamic MCP
 * executor by design — see `fabric-registry.md`). CI enforces a zero circular-import
 * budget. Deferring an import does not help: madge counts dynamic `import()` and even
 * `import type` as real edges, so the dependency had to actually move.
 *
 * `dynamicMcpTools` now imports visibility from here instead of from the index, which
 * removes its edge to the index and breaks the cycle. `dynamicMcpIndex` re-exports every
 * name below, so existing import paths keep working.
 *
 * Keep this module free of `fabricRegistry` and `dynamicMcpTools` imports.
 */

import { redis } from '$lib/server/redis'
import type {
  AgentDcmDisplaySettings,
  AgentDcmGroupDisplayMode,
  DcmGroupDisplayMode,
  DcmToolDisplayMode,
  GatewayDcmDisplaySettings
} from '$lib/types/database'
import {
  createDefaultDcmDisplaySettings,
  createDefaultGatewayDcmDisplaySettings,
  normalizeDcmDisplaySettings,
  normalizeGatewayDcmDisplaySettings,
  normalizeLegacyDcmGroupMode as normalizeLegacyGroupMode,
  normalizeLegacyDcmToolMode as normalizeLegacyToolMode
} from '$lib/utils/dcmDisplaySettings'

export type DcmGroupVisibility = 'hidden' | 'group-only' | 'group+tools'
export type DcmToolVisibility = 'hidden' | 'name-only' | 'name+hint'

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

export function isExplicitAgentToolListMode(mode: AgentDcmGroupDisplayMode | undefined): boolean {
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


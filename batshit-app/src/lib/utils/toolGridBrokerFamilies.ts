/**
 * Tool Grid rows for the two broker families that are not gateways and not CLI tools:
 * Fabric controls and published agent-usable Artifact runtime tools.
 *
 * SA-096 P3. Both families were already reachable through the Batshit Tool Search/Use
 * broker but had no row in the Tool Grid, so a user could not say how much of either
 * family should appear in the capability index. They now use the same synthetic-gateway
 * shape `toolGridCli.ts` established: a fixed id, one group name, and a
 * `GatewayDcmDisplaySettings` bag that `resolveEffectiveGroupMode` /
 * `resolveEffectiveToolVisibility` read exactly as they read a real gateway's defaults.
 *
 * The defaults are seeded into `dcmDisplayDefaults.groups` by the normalizer rather than
 * expressed as a fallback in the resolver (DL-6: the untouched state must be the right
 * state). Seeding keeps the default in one place and survives a partial settings object
 * being saved by an unrelated Tool Grid edit — a resolver-side fallback would silently
 * flip Fabric to `group+tools+hints` the first time some other row wrote settings.
 *
 * This file must stay free of `$lib/server` imports: `databaseRedis.client.ts` reaches it
 * through the shared Tool Grid components.
 */

import type { IconRef } from '$lib/icons/iconTypes'
import type {
  DcmGroupDisplayMode,
  DcmToolDisplayMode,
  GatewayDcmDisplaySettings,
  GlobalBrokerFamilyToolGridSettings
} from '$lib/types/database'
import {
  normalizeLegacyDcmGroupMode,
  normalizeLegacyDcmToolMode
} from './dcmDisplaySettings'

export const FABRIC_TOOL_GRID_ID = '__fabric_controls__'
export const FABRIC_TOOL_GRID_GROUP_NAME = 'Fabric Controls'

/**
 * SA-072 P2 step 0: the plain words the Fabric line in `tool_discovery` uses for each control
 * family, so `- Fabric Controls (65 tools: agent DMs, artifacts, …, Pinokio, …)` tells an
 * agent WHAT it can reach, not just how many. Without them a plain-words ask ("which apps do
 * I have in Pinokio?") never triggers a search, because nothing in the index names Pinokio.
 *
 * Keyed by the family segment `fabricControlFamilyKey` derives from a control id. A family
 * missing from this map still prints, as its raw segment, so a new family can never hide.
 * Add a row when a family's raw segment reads wrong to a person.
 */
export const FABRIC_CONTROL_FAMILY_LABELS: Readonly<Record<string, string>> = {
  ui: 'App Actions',
  artifact: 'artifacts',
  cli_tool: 'CLI tools',
  comfyui: 'ComfyUI',
  dm: 'agent DMs',
  goon_scene: 'Goon scenes',
  judge: 'Judge Juice',
  mcp: 'MCP tools',
  memory: 'memory',
  model_catalog: 'model catalog',
  pinokio: 'Pinokio',
  runtime_addon: 'runtime add-ons',
  schedule: 'schedules',
  skill: 'skills',
  voice: 'voice engines',
  zip: 'zips'
}

/**
 * The family segment of one Fabric control id: `sys.<family>.…` gives `<family>`, and any
 * other id gives its first segment (the per-artifact `artifact.<id>.…` config controls land
 * in `artifact`, beside `sys.artifact.*`).
 */
export function fabricControlFamilyKey(controlId: string): string {
  const segments = controlId.trim().split('.')
  if (segments[0] === 'sys' && segments[1]) return segments[1]
  return segments[0] ?? ''
}

/**
 * The distinct family words for a set of Fabric control ids, in a fixed order (plain
 * lower-case comparison, never a locale, so the bytes are the same on every machine). The
 * list changes only when the set of families changes.
 */
export function describeFabricControlFamilies(controlIds: Iterable<string>): string[] {
  const labels = new Set<string>()
  for (const controlId of controlIds) {
    const key = fabricControlFamilyKey(controlId)
    if (!key) continue
    labels.add(FABRIC_CONTROL_FAMILY_LABELS[key] ?? key)
  }
  return Array.from(labels).sort((left, right) => {
    const a = left.toLowerCase()
    const b = right.toLowerCase()
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export const ARTIFACT_TOOL_GRID_ID = '__artifact_runtime__'
export const ARTIFACT_TOOL_GRID_GROUP_NAME = 'Artifact Tools'

// Same marks the zip rows for these families already use, so one family reads as one thing
// across both halves of the grid.
export const TOOL_GRID_FABRIC_ICON_REF: IconRef = { kind: 'batshit', id: 'fabric' }
export const TOOL_GRID_ARTIFACT_ICON_REF: IconRef = { kind: 'batshit', id: 'artifacts' }

export type BrokerFamilyToolGridKey = 'fabric' | 'artifact'

interface BrokerFamilyToolGridDefinition {
  key: BrokerFamilyToolGridKey
  gatewayId: string
  groupName: string
  /**
   * The mode an untouched install resolves to.
   *
   * Fabric ships 60+ controls in one group, which is over the DCM tool-name threshold on
   * its own, so listing them is both noisy and pointless — the threshold would suppress
   * the list anyway. `group-only` states that intent instead of leaving it to arithmetic;
   * the line still names the families (`describeFabricControlFamilies`).
   *
   * Artifacts are a small, user-created family where a schema hint is what buys the agent
   * a direct call instead of a search round trip, so hints are on by default.
   */
  defaultGroupMode: DcmGroupDisplayMode
}

export const BROKER_FAMILY_TOOL_GRID_DEFINITIONS: Record<
  BrokerFamilyToolGridKey,
  BrokerFamilyToolGridDefinition
> = {
  fabric: {
    key: 'fabric',
    gatewayId: FABRIC_TOOL_GRID_ID,
    groupName: FABRIC_TOOL_GRID_GROUP_NAME,
    defaultGroupMode: 'group-only'
  },
  artifact: {
    key: 'artifact',
    gatewayId: ARTIFACT_TOOL_GRID_ID,
    groupName: ARTIFACT_TOOL_GRID_GROUP_NAME,
    defaultGroupMode: 'group+tools+hints'
  }
}

/**
 * Plain-language help for each row (DL-6). Most users never open these rows, so the copy
 * has to say what the family is, what the row does and does not change, and why the
 * default is what it is.
 */
export const FABRIC_TOOL_GRID_INFO_PARAGRAPHS = [
  "Fabric controls are Batshit's own built-in actions, such as publishing an artifact, registering a voice engine, or starting a runtime add-on.",
  'This row only changes how much of that list appears in the capability index the agent receives with each message. The agent can search for these controls and run them either way.',
  'There are more than sixty of them, so by default Batshit shows the group, its count, and the kinds of control it holds (such as artifacts, memory, or Pinokio) instead of naming every control. Choose a Tools option if you want the names or input hints in every message.'
]

export const ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS = [
  'Artifact tools are the published artifacts you marked as agent-usable. Each one gets a ref the agent can run directly.',
  'Hints are on by default because there are usually only a few, and showing their input fields lets the agent run one without spending a turn searching for it first.',
  'User-only panel artifacts, such as embedded Gradio or ComfyUI pages, are never agent-runnable and never appear here.'
]

export function getBrokerFamilyToolGridDefinition(
  key: BrokerFamilyToolGridKey
): BrokerFamilyToolGridDefinition {
  return BROKER_FAMILY_TOOL_GRID_DEFINITIONS[key]
}

export function createDefaultBrokerFamilyDcmDefaults(
  key: BrokerFamilyToolGridKey
): GatewayDcmDisplaySettings {
  const definition = BROKER_FAMILY_TOOL_GRID_DEFINITIONS[key]
  return {
    version: 1,
    groups: { [definition.groupName]: definition.defaultGroupMode },
    tools: {}
  }
}

export function normalizeBrokerFamilyDcmDefaults(
  key: BrokerFamilyToolGridKey,
  value?: GatewayDcmDisplaySettings | Record<string, unknown> | null
): GatewayDcmDisplaySettings {
  const definition = BROKER_FAMILY_TOOL_GRID_DEFINITIONS[key]
  if (!value || typeof value !== 'object') {
    return createDefaultBrokerFamilyDcmDefaults(key)
  }

  const raw = value as Record<string, unknown>
  const groups: Record<string, DcmGroupDisplayMode> = {}
  const tools: Record<string, DcmToolDisplayMode> = {}

  if (raw.groups && typeof raw.groups === 'object') {
    for (const [groupKey, mode] of Object.entries(raw.groups as Record<string, unknown>)) {
      const normalized = normalizeLegacyDcmGroupMode(mode)
      if (normalized && groupKey.trim().length > 0) {
        groups[groupKey] = normalized
      }
    }
  }

  if (raw.tools && typeof raw.tools === 'object') {
    for (const [toolKey, mode] of Object.entries(raw.tools as Record<string, unknown>)) {
      const normalized = normalizeLegacyDcmToolMode(mode)
      if (normalized && toolKey.trim().length > 0) {
        tools[toolKey] = normalized
      }
    }
  }

  // Seed the family default when the stored bag says nothing about this family's group.
  if (!groups[definition.groupName]) {
    groups[definition.groupName] = definition.defaultGroupMode
  }

  return {
    version: 1,
    groups,
    tools
  }
}

export function createDefaultBrokerFamilyToolGridSettings(
  key: BrokerFamilyToolGridKey
): Required<GlobalBrokerFamilyToolGridSettings> {
  return {
    dcmDisplayDefaults: createDefaultBrokerFamilyDcmDefaults(key)
  }
}

export function normalizeBrokerFamilyToolGridSettings(
  key: BrokerFamilyToolGridKey,
  value?: GlobalBrokerFamilyToolGridSettings | Record<string, unknown> | null
): Required<GlobalBrokerFamilyToolGridSettings> {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  return {
    dcmDisplayDefaults: normalizeBrokerFamilyDcmDefaults(
      key,
      raw?.dcmDisplayDefaults as GatewayDcmDisplaySettings | Record<string, unknown> | null | undefined
    )
  }
}

export function createDefaultFabricToolGridSettings() {
  return createDefaultBrokerFamilyToolGridSettings('fabric')
}

export function normalizeFabricToolGridSettings(
  value?: GlobalBrokerFamilyToolGridSettings | Record<string, unknown> | null
) {
  return normalizeBrokerFamilyToolGridSettings('fabric', value)
}

export function createDefaultArtifactToolGridSettings() {
  return createDefaultBrokerFamilyToolGridSettings('artifact')
}

export function normalizeArtifactToolGridSettings(
  value?: GlobalBrokerFamilyToolGridSettings | Record<string, unknown> | null
) {
  return normalizeBrokerFamilyToolGridSettings('artifact', value)
}

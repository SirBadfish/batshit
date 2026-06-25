import type {
  AgentDcmDisplaySettings,
  AgentDcmGroupDisplayMode,
  AgentDcmGroupDisplayPreference,
  AgentDcmToolDisplayPreference,
  DcmGroupDisplayMode,
  DcmToolDisplayMode,
  GatewayDcmDisplaySettings
} from '$lib/types/database'

export const VALID_AGENT_DCM_GROUP_MODES = new Set<AgentDcmGroupDisplayMode>([
  'use-global',
  'group+tools+hints',
  'group+tools+names',
  'group-only',
  'hidden'
])

export const VALID_DCM_GROUP_DISPLAY_PREFERENCES =
  new Set<AgentDcmGroupDisplayPreference>([
    'use-global',
    'group+tools+hints',
    'group+tools+names',
    'group-only'
  ])

export const VALID_DCM_GLOBAL_GROUP_MODES = new Set<DcmGroupDisplayMode>([
  'group+tools+hints',
  'group+tools+names',
  'group-only',
  'hidden'
])

export const VALID_DCM_TOOL_DISPLAY_MODES = new Set<DcmToolDisplayMode>([
  'inherit',
  'name+hint',
  'name-only',
  'hidden'
])

export const VALID_DCM_TOOL_DISPLAY_PREFERENCES =
  new Set<AgentDcmToolDisplayPreference>(['inherit', 'name+hint', 'name-only'])

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function sortStringRecord<T extends string>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, T>
}

export function createDefaultDcmDisplaySettings(): AgentDcmDisplaySettings {
  return {
    version: 1,
    groups: {},
    tools: {},
    groupDisplayPreferences: {},
    toolDisplayPreferences: {}
  }
}

export function createDefaultGatewayDcmDisplaySettings(): GatewayDcmDisplaySettings {
  return {
    version: 1,
    groups: {},
    tools: {}
  }
}

export function normalizeLegacyDcmGroupMode(value: unknown): DcmGroupDisplayMode | null {
  if (value === 'group+tools') return 'group+tools+hints'
  if (
    typeof value === 'string' &&
    VALID_DCM_GLOBAL_GROUP_MODES.has(value as DcmGroupDisplayMode)
  ) {
    return value as DcmGroupDisplayMode
  }
  return null
}

export function normalizeLegacyDcmToolMode(value: unknown): DcmToolDisplayMode | null {
  if (value === 'group+tools') return 'name+hint'
  if (
    typeof value === 'string' &&
    VALID_DCM_TOOL_DISPLAY_MODES.has(value as DcmToolDisplayMode)
  ) {
    return value as DcmToolDisplayMode
  }
  return null
}

export function normalizeDcmDisplaySettings(source: unknown): AgentDcmDisplaySettings {
  const raw = recordFrom(source)
  if (Object.keys(raw).length === 0) {
    return createDefaultDcmDisplaySettings()
  }

  const groups: Record<string, AgentDcmGroupDisplayMode> = {}
  const tools: Record<string, DcmToolDisplayMode> = {}
  const groupDisplayPreferences: Record<string, AgentDcmGroupDisplayPreference> = {}
  const toolDisplayPreferences: Record<string, AgentDcmToolDisplayPreference> = {}

  for (const [key, value] of Object.entries(recordFrom(raw.groups))) {
    if (value === 'use-global') {
      groups[key] = 'use-global'
      continue
    }
    const normalized = normalizeLegacyDcmGroupMode(value)
    if (normalized) {
      groups[key] = normalized
    }
  }

  for (const [key, value] of Object.entries(recordFrom(raw.tools))) {
    const normalized = normalizeLegacyDcmToolMode(value)
    if (normalized) {
      tools[key] = normalized
    }
  }

  for (const [key, value] of Object.entries(recordFrom(raw.groupDisplayPreferences))) {
    if (
      typeof value === 'string' &&
      VALID_DCM_GROUP_DISPLAY_PREFERENCES.has(value as AgentDcmGroupDisplayPreference)
    ) {
      groupDisplayPreferences[key] = value as AgentDcmGroupDisplayPreference
    }
  }

  for (const [key, value] of Object.entries(recordFrom(raw.toolDisplayPreferences))) {
    if (
      typeof value === 'string' &&
      VALID_DCM_TOOL_DISPLAY_PREFERENCES.has(value as AgentDcmToolDisplayPreference)
    ) {
      toolDisplayPreferences[key] = value as AgentDcmToolDisplayPreference
    }
  }

  for (const [key, mode] of Object.entries(groups)) {
    if (mode !== 'hidden' && VALID_DCM_GROUP_DISPLAY_PREFERENCES.has(mode)) {
      groupDisplayPreferences[key] = mode
    } else if (mode === 'hidden' && !groupDisplayPreferences[key]) {
      groupDisplayPreferences[key] = 'use-global'
    }
  }

  for (const [key, mode] of Object.entries(tools)) {
    if (mode !== 'hidden' && VALID_DCM_TOOL_DISPLAY_PREFERENCES.has(mode)) {
      toolDisplayPreferences[key] = mode
    } else if (mode === 'hidden' && !toolDisplayPreferences[key]) {
      toolDisplayPreferences[key] = 'inherit'
    }
  }

  return {
    version: 1,
    groups,
    tools,
    groupDisplayPreferences,
    toolDisplayPreferences
  }
}

export function cloneDcmDisplaySettings(source: unknown): AgentDcmDisplaySettings {
  return normalizeDcmDisplaySettings(source)
}

export function normalizeGatewayDcmDisplaySettings(source: unknown): GatewayDcmDisplaySettings {
  const raw = recordFrom(source)
  if (Object.keys(raw).length === 0) {
    return createDefaultGatewayDcmDisplaySettings()
  }

  const groups: Record<string, DcmGroupDisplayMode> = {}
  const tools: Record<string, DcmToolDisplayMode> = {}

  for (const [key, value] of Object.entries(recordFrom(raw.groups))) {
    const normalized = normalizeLegacyDcmGroupMode(value)
    if (normalized && key.trim().length > 0) {
      groups[key] = normalized
    }
  }

  for (const [key, value] of Object.entries(recordFrom(raw.tools))) {
    const normalized = normalizeLegacyDcmToolMode(value)
    if (normalized && key.trim().length > 0) {
      tools[key] = normalized
    }
  }

  return {
    version: 1,
    groups,
    tools
  }
}

export function buildDcmDisplaySettingsSignature(source: unknown): string {
  const normalized = normalizeDcmDisplaySettings(source)
  return JSON.stringify({
    version: 1,
    groups: sortStringRecord(normalized.groups ?? {}),
    tools: sortStringRecord(normalized.tools ?? {}),
    groupDisplayPreferences: sortStringRecord(normalized.groupDisplayPreferences ?? {}),
    toolDisplayPreferences: sortStringRecord(normalized.toolDisplayPreferences ?? {})
  })
}

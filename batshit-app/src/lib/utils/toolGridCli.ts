import type {
  DcmGroupDisplayMode,
  DcmToolDisplayMode,
  GlobalCliToolGridSettings,
  GatewayDcmDisplaySettings
} from '$lib/types/database'

export const CLI_TOOL_GRID_ID = '__cli_tools__'
export const CLI_TOOL_GRID_GROUP_NAME = 'CLI Tools'

const VALID_GROUP_MODES = new Set<DcmGroupDisplayMode>([
  'group+tools+hints',
  'group+tools+names',
  'group-only',
  'hidden'
])

const VALID_TOOL_MODES = new Set<DcmToolDisplayMode>([
  'inherit',
  'name+hint',
  'name-only',
  'hidden'
])

function normalizeLegacyGroupMode(value: unknown): DcmGroupDisplayMode | null {
  if (value === 'group+tools') return 'group+tools+hints'
  if (typeof value === 'string' && VALID_GROUP_MODES.has(value as DcmGroupDisplayMode)) {
    return value as DcmGroupDisplayMode
  }
  return null
}

function normalizeLegacyToolMode(value: unknown): DcmToolDisplayMode | null {
  if (value === 'group+tools') return 'name+hint'
  if (typeof value === 'string' && VALID_TOOL_MODES.has(value as DcmToolDisplayMode)) {
    return value as DcmToolDisplayMode
  }
  return null
}

export function createDefaultCliToolGridDcmDefaults(): GatewayDcmDisplaySettings {
  return {
    version: 1,
    groups: {},
    tools: {}
  }
}

export function normalizeCliToolIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right))
}

export function normalizeCliToolGridDcmDefaults(
  value?: GatewayDcmDisplaySettings | Record<string, unknown> | null
): GatewayDcmDisplaySettings {
  if (!value || typeof value !== 'object') {
    return createDefaultCliToolGridDcmDefaults()
  }

  const raw = value as Record<string, unknown>
  const groups: Record<string, DcmGroupDisplayMode> = {}
  const tools: Record<string, DcmToolDisplayMode> = {}

  if (raw.groups && typeof raw.groups === 'object') {
    for (const [key, mode] of Object.entries(raw.groups)) {
      const normalized = normalizeLegacyGroupMode(mode)
      if (normalized && key.trim().length > 0) {
        groups[key] = normalized
      }
    }
  }

  if (raw.tools && typeof raw.tools === 'object') {
    for (const [key, mode] of Object.entries(raw.tools)) {
      const normalized = normalizeLegacyToolMode(mode)
      if (normalized && key.trim().length > 0) {
        tools[key] = normalized
      }
    }
  }

  return {
    version: 1,
    groups,
    tools
  }
}

export function createDefaultCliToolGridSettings(): Required<GlobalCliToolGridSettings> {
  return {
    discoverableToolIds: [],
    dcmDisplayDefaults: createDefaultCliToolGridDcmDefaults()
  }
}

export function normalizeCliToolGridSettings(
  value?: GlobalCliToolGridSettings | Record<string, unknown> | null
): Required<GlobalCliToolGridSettings> {
  if (!value || typeof value !== 'object') {
    return createDefaultCliToolGridSettings()
  }

  const raw = value as Record<string, unknown>
  return {
    discoverableToolIds: normalizeCliToolIdList(raw.discoverableToolIds),
    dcmDisplayDefaults: normalizeCliToolGridDcmDefaults(
      raw.dcmDisplayDefaults as GatewayDcmDisplaySettings | Record<string, unknown> | null | undefined
    )
  }
}

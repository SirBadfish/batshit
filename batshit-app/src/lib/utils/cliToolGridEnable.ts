import type { AgentDcmDisplaySettings, DcmGroupDisplayMode } from '$lib/types/database'
import { applyAgentBlockUpdate, type AgentDcmDisplaySettingsSave } from './agentBlockFieldSettings'
import { normalizeDcmDisplaySettings, VALID_DCM_GLOBAL_GROUP_MODES } from './dcmDisplaySettings'
import { CLI_TOOL_GRID_GROUP_NAME, CLI_TOOL_GRID_ID } from './toolGridCli'

export const CLI_GROUP_KEY = `${CLI_TOOL_GRID_ID}::${CLI_TOOL_GRID_GROUP_NAME}`
// The existing family default used by Tool Grid/DCM readers when no group mode is saved.
export const CLI_GROUP_DEFAULT_MODE = 'group+tools+hints' as const

export function assertCliGlobalSettingsRead(payload: unknown): void {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  if (!record(payload) || payload.success === false || !Object.hasOwn(payload, 'settings') || payload.settings !== null && !record(payload.settings)) throw new Error('Could not read saved global Tool Grid defaults.')
  let value: unknown = payload.settings
  for (const key of ['global_tool_grid_settings', 'cli', 'dcmDisplayDefaults', 'groups']) {
    value = record(value) ? value[key] : null
    if (value != null && !record(value)) throw new Error('The saved global CLI Tools defaults are unavailable.')
  }
  const mode = record(value) ? value[CLI_TOOL_GRID_GROUP_NAME] : null
  if (mode != null && mode !== 'group+tools' && !VALID_DCM_GLOBAL_GROUP_MODES.has(mode as DcmGroupDisplayMode)) throw new Error('The saved global CLI Tools display choice is unavailable.')
}

export function assertCliNativeValue(value: unknown): void {
  if (value == null || typeof value === 'boolean' || typeof value === 'string' && ['true', '1', 'yes', 'on', 'enabled', 'false', '0', 'no', 'off', 'disabled'].includes(value.trim().toLowerCase())) return
  throw new Error('The saved CLI Tools choice is unavailable.')
}

export function readCliNativeChoice(record: { provider_specific_settings?: unknown }): unknown {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const provider = record.provider_specific_settings
  if (provider != null && !object(provider)) throw new Error('The saved CLI Tools choice is unavailable.')
  const native = object(provider) ? provider.nativeTools : null
  if (native != null && !object(native)) throw new Error('The saved CLI Tools choice is unavailable.')
  const value = object(native) ? native.cliToolsEnabled : undefined
  assertCliNativeValue(value)
  return value
}

export function effectiveCliGroupMode(source: unknown, globalMode: DcmGroupDisplayMode): DcmGroupDisplayMode {
  const mode = normalizeDcmDisplaySettings(source).groups[CLI_GROUP_KEY]
  return mode && mode !== 'use-global' ? mode : globalMode
}

/** Only an explicit ON can repair a hidden group. OFF never changes discovery or members. */
export function cliGroupEnablePatch(source: unknown, globalMode: DcmGroupDisplayMode): AgentDcmDisplaySettingsSave | undefined {
  if (effectiveCliGroupMode(source, globalMode) !== 'hidden') return undefined
  const preference = normalizeDcmDisplaySettings(source).groupDisplayPreferences?.[CLI_GROUP_KEY]
  const mode = preference && preference !== 'use-global' ? preference : globalMode !== 'hidden' ? 'use-global' : CLI_GROUP_DEFAULT_MODE
  return { groups: { [CLI_GROUP_KEY]: mode === 'use-global' ? null : mode }, groupDisplayPreferences: { [CLI_GROUP_KEY]: mode } }
}

export function applyCliDcmPatch(source: unknown, patch: AgentDcmDisplaySettingsSave): AgentDcmDisplaySettings {
  return { version: 1, groups: {}, tools: {}, ...applyAgentBlockUpdate('dcmDisplaySettings', source, patch) } as unknown as AgentDcmDisplaySettings
}

/** Keep the existing first-canonical-write promotion of a complete legacy display block. */
export function captureCliDcmWrite(record: { dcmDisplaySettings?: unknown; dcm_display_settings?: unknown }, patch?: AgentDcmDisplaySettingsSave): AgentDcmDisplaySettingsSave | undefined {
  if (!patch) return undefined
  return record.dcmDisplaySettings == null && record.dcm_display_settings != null
    ? applyCliDcmPatch(normalizeDcmDisplaySettings(record.dcm_display_settings), patch)
    : patch
}

/** A deliberate saved-choice read adopts only this pair, never another tool's draft. */
export function readCliDcmPair(record: { dcmDisplaySettings?: unknown; dcm_display_settings?: unknown }): AgentDcmDisplaySettingsSave {
  const raw = record.dcmDisplaySettings ?? record.dcm_display_settings
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('The saved CLI display choice is unavailable.')
  const source = (raw ?? {}) as Record<string, unknown>
  for (const field of ['groups', 'groupDisplayPreferences']) {
    const map = source[field]
    if (map != null && (typeof map !== 'object' || Array.isArray(map))) throw new Error('The saved CLI display choice is unavailable.')
    const value = (map as Record<string, unknown> | null)?.[CLI_GROUP_KEY]
    if (value != null && value !== 'use-global' && value !== 'group+tools' && (!VALID_DCM_GLOBAL_GROUP_MODES.has(value as DcmGroupDisplayMode) || field === 'groupDisplayPreferences' && value === 'hidden')) throw new Error('The saved CLI display choice is unavailable.')
  }
  const normalized = normalizeDcmDisplaySettings(source)
  return { groups: { [CLI_GROUP_KEY]: normalized.groups[CLI_GROUP_KEY] ?? null }, groupDisplayPreferences: { [CLI_GROUP_KEY]: normalized.groupDisplayPreferences?.[CLI_GROUP_KEY] ?? null } }
}

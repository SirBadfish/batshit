import type { SettingsReportId, SettingsReportValue } from '$lib/appActions/settings/reportContract'
import type { SettingsSubjectEntry } from './subjects'
import type { BoundedInstructionTextDescriptor } from './instructionTextSnapshot'
import { memoryWindowModes } from '$lib/appActions/settings/memoryPreferences'
import {
  MEMORY_MAX_LINGER_TURNS, resolveAgentMemoryEnabled, resolveMemoryLaneBudgets, resolveMemoryLingerTurns, resolveMemoryRecallLingerTurns
} from '$lib/utils/memoryControl'

export type Fields = Readonly<Record<string, SettingsReportValue | BoundedInstructionTextDescriptor>>
export type Group = Readonly<{ id: SettingsReportId; status: 'available'; fields: Fields; readiness?: Readonly<{ status: string; reason: string }> } | { id: SettingsReportId; status: 'unavailable'; reason: string }>
function frozenValue(value: SettingsReportValue): SettingsReportValue {
  return Object.freeze({ ...value, stored: Object.freeze(value.stored), effective: Object.freeze(value.effective) })
}
export function valueState(raw: unknown, effective: string | number | boolean, valid: (value: unknown) => boolean): SettingsReportValue {
  if (raw === undefined || raw === null) return frozenValue({ stored: { state: 'unset' }, effective: { state: 'known', value: effective }, source: 'factory' })
  if (!valid(raw)) return frozenValue({ stored: { state: 'invalid' }, effective: { state: 'unknown', reason: 'unsupported_saved_value' }, source: 'none' })
  return frozenValue({ stored: { state: 'set', value: raw as string | number | boolean }, effective: { state: 'known', value: effective }, source: 'agent' })
}
export function unknownState(unset: boolean): SettingsReportValue {
  return frozenValue({ stored: { state: unset ? 'unset' : 'invalid' }, effective: { state: 'unknown', reason: 'unsupported_saved_value' }, source: 'none' })
}
/** Fixed projections only. Neither unknown keys nor prompt/provider/credential blocks are copied. */
export function projectIdentity(_entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  const id = 'agent.identity'
  const raw = record.displayName
  const valid = typeof raw === 'string' && !!raw.trim() && raw.length <= 200 && raw.isWellFormed()
  return Object.freeze({ id, status: 'available', fields: Object.freeze({
    displayName: valid ? valueState(raw, raw, value => typeof value === 'string') : unknownState(raw === undefined || raw === null)
  }) })
}
export function projectMemory(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  const id = 'agent.memory.preferences'
  if (entry.subject.kind !== 'primary') return Object.freeze({ id, status: 'unavailable', reason: 'memory_is_primary_only' })
  const budgetsRaw = record.memory_lane_budgets ?? record.memoryLaneBudgets
  if (budgetsRaw !== undefined && budgetsRaw !== null && (typeof budgetsRaw !== 'object' || Array.isArray(budgetsRaw))) {
    return Object.freeze({ id, status: 'unavailable', reason: 'invalid_memory_budget_container' })
  }
  const savedBudgets = budgetsRaw as Record<string, unknown> | null | undefined
  const effectiveBudgets = resolveMemoryLaneBudgets(record)
  const integer = (max: number) => (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
  // The enabled resolver deliberately chooses a valid boolean alias before defaulting.
  const enabledRaw = typeof record.memory_enabled === 'boolean' ? record.memory_enabled :
    typeof record.memoryEnabled === 'boolean' ? record.memoryEnabled : record.memory_enabled ?? record.memoryEnabled
  const parentType = (field: string) => !Object.hasOwn(record, field) ? '' : record[field] === null ? 'null' : Array.isArray(record[field]) ? 'array' : typeof record[field]
  const canonical = record.memory_window as Record<string, unknown> | null | undefined
  const legacy = record.memoryWindow as Record<string, unknown> | null | undefined
  let windowFields: Fields
  try {
    const modes = memoryWindowModes([parentType('memory_window'), parentType('memoryWindow')], [canonical?.floor_mode, canonical?.ceiling_headroom_mode, legacy?.floor_mode, legacy?.ceiling_headroom_mode])
    const active = (record.memory_window ?? record.memoryWindow) as Record<string, unknown> | null | undefined
    const valid = (value: unknown) => value === 'auto' || value === 'custom'
    windowFields = { floorMode: valueState(active?.floor_mode, modes.floorMode, valid), ceilingHeadroomMode: valueState(active?.ceiling_headroom_mode, modes.ceilingHeadroomMode, valid) }
  } catch { windowFields = { floorMode: unknownState(false), ceilingHeadroomMode: unknownState(false) } }
  const readiness = record.__memoryReadiness as { status: string; reason: string } | undefined
  return Object.freeze({ id, status: 'available', ...(readiness ? { readiness: Object.freeze({ status: readiness.status, reason: readiness.reason }) } : {}), fields: Object.freeze({
    ...windowFields,
    enabled: valueState(enabledRaw, resolveAgentMemoryEnabled(record), value => typeof value === 'boolean'),
    onMyMind: valueState(savedBudgets?.on_my_mind, effectiveBudgets.onMyMind, integer(20000)),
    triggers: valueState(savedBudgets?.triggers, effectiveBudgets.triggers, integer(20000)),
    recalled: valueState(savedBudgets?.recalled, effectiveBudgets.recalled, integer(20000)),
    triggerLingerTurns: valueState(record.memory_linger_turns ?? record.memoryLingerTurns, resolveMemoryLingerTurns(record), integer(MEMORY_MAX_LINGER_TURNS)),
    recallLingerTurns: valueState(record.memory_recall_linger_turns ?? record.memoryRecallLingerTurns, resolveMemoryRecallLingerTurns(record), integer(MEMORY_MAX_LINGER_TURNS))
  }) })
}

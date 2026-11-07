import { AUTO_COMPACT_SEMANTIC_ID, AUTO_COMPACT_COMMON_FIELDS, validAutoCompactField, validateAutoCompactChanges, type AutoCompactChanges, type AutoCompactField } from '$lib/appActions/settings/autoCompactPreferences'
import type { SettingsReportValue } from '$lib/appActions/settings/reportContract'
import { resolveEffectiveAutoCompactSettings } from '$lib/utils/contextCompaction'
import type { SettingsSubjectEntry } from './subjects'
import type { Group } from './scalarProjection'

function common(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_auto_compact_container')
  return Object.fromEntries(AUTO_COMPACT_COMMON_FIELDS.filter(field => Object.hasOwn(value, field)).map(field => [field, (value as Record<string, unknown>)[field]]))
}
function applicable(entry: SettingsSubjectEntry) {
  return entry.status === 'available' && entry.subject.kind === 'primary' && entry.type === 'api'
}
export function autoCompactGlobalFields(agent: Record<string, unknown>, global: Record<string, unknown>): AutoCompactField[] {
  const fields: AutoCompactField[] = []
  if (agent.mode === undefined || agent.mode === 'inherit') fields.push('mode')
  if (agent.triggerMode === undefined || agent.triggerMode === 'inherit') {
    fields.push('triggerMode')
    if (global.triggerMode === 'remaining_tokens') fields.push('remainingTokens')
  }
  return fields
}
function resolve(record: Record<string, unknown>) {
  const agent = common(record.auto_compact_settings)
  const usesGlobal = agent.mode === undefined || agent.mode === 'inherit' || agent.triggerMode === undefined || agent.triggerMode === 'inherit'
  const global = usesGlobal ? common(record.__autoCompactGlobal) : {}
  if (AUTO_COMPACT_COMMON_FIELDS.some(field => Object.hasOwn(agent, field) && !validAutoCompactField(field, agent[field]))) throw new Error('invalid_saved_auto_compact')
  const dependencies = autoCompactGlobalFields(agent, global)
  if (dependencies.some(field => Object.hasOwn(global, field) && !validAutoCompactField(field, global[field], true))) throw new Error('invalid_saved_global_auto_compact')
  return { agent, global, dependencies, effective: resolveEffectiveAutoCompactSettings({ agent, global }) }
}
function projection(record: Record<string, unknown>): Group {
  const { agent, global, effective } = resolve(record)
  const fields = Object.fromEntries(AUTO_COMPACT_COMMON_FIELDS.map(field => {
    const raw = agent[field]
    const inherited = field === 'mode' ? raw === undefined || raw === 'inherit' : agent.triggerMode === undefined || agent.triggerMode === 'inherit'
    const source: SettingsReportValue['source'] = inherited ? Object.hasOwn(global, field) ? 'global' : 'factory' : 'agent'
    const stored: SettingsReportValue['stored'] = Object.hasOwn(agent, field) ? { state: 'set', value: raw as string | number | null } : { state: 'unset' }
    const value = effective[field]
    const fact: SettingsReportValue = { stored, effective: value === null ? { state: 'unknown', reason: 'smart_threshold_uses_runtime_context_window' } : { state: 'known', value }, source }
    return [field, Object.freeze(fact)]
  }))
  return Object.freeze({ id: AUTO_COMPACT_SEMANTIC_ID, status: 'available', fields: Object.freeze(fields) })
}
export function projectAutoCompact(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  if (!applicable(entry)) return { id: AUTO_COMPACT_SEMANTIC_ID, status: 'unavailable', reason: 'auto_compact_primary_only' }
  try { return projection(record) } catch { return { id: AUTO_COMPACT_SEMANTIC_ID, status: 'unavailable', reason: 'invalid_saved_auto_compact' } }
}
/** Only requested raw changes; advanced and unknown members never enter this plan. */
export function planAutoCompactChanges(entry: SettingsSubjectEntry, record: Record<string, unknown>, input: unknown) {
  if (!applicable(entry)) throw new Error('auto_compact_primary_only')
  const requested = validateAutoCompactChanges(input), before = resolve(record)
  const changes = Object.freeze(Object.fromEntries(Object.entries(requested).filter(([field, value]) => !Object.hasOwn(before.agent, field) || before.agent[field] !== value))) as AutoCompactChanges
  const next = { ...record, auto_compact_settings: { ...before.agent, ...changes } }, after = resolve(next)
  return Object.freeze({ changes, before: projection(record), after: projection(next), globalFields: Object.freeze([...new Set([...before.dependencies, ...after.dependencies])]) })
}

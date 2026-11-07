import { buildPickedPresetSelection } from '$lib/utils/modelPresetPick'
import { buildAgentProviderSettingsPatch } from '$lib/utils/agentProviderSettings'
import { planAgentRecordUpdate } from '$lib/server/agentRecordUpdate'
import { planSubagentRecordUpdate } from '$lib/server/subagentRecordUpdate'
import type { OwnedModelPresetSelection } from '$lib/server/services/modelPresetSelectionOwner'
import { prepareModelSelectionClear, type ModelSelectionSnapshot, type ModelSelectionRawGuard, type SelectionSourceProof } from '$lib/server/modelSelectionGuard'
import type { ModelSelectionFact, ModelSelectionReview, ModelSelectionVoiceFacts } from '$lib/appActions/settings/modelSelectionPreferences'
import type { SettingsLifecycleSnapshot } from './lifecycle'
import type { SavedModel } from '$lib/types/savedModels'
import type { SettingsSubjectEntry } from './subjects'
import { valueState, unknownState, type Group } from './scalarProjection'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { normalizeSubagentType } from '$lib/utils/subagentType'

export type OriginalModelSelectionCut = Readonly<{ key: string; lifecycle: SettingsLifecycleSnapshot
  guard: Pick<ModelSelectionRawGuard, 'paths' | 'raw' | 'providerKeys' | 'containers'>
  sources: readonly SelectionSourceProof[] }>
/** Compare-only cut extracted once from the genuine original A3 reader. It grants no
 * issue/source capability and never captures a later target or broadens its field ownership. */
export function originalModelSelectionCut(kind: 'agent' | 'subagent', id: string, snapshot: ModelSelectionSnapshot): OriginalModelSelectionCut {
  const guard = snapshot
  if (snapshot.record.id !== id) throw new Error('The original model target cut is unavailable.')
  const cut: OriginalModelSelectionCut = structuredClone({ key: `${kind}:${id}`, lifecycle: snapshot.lifecycle,
    guard: { paths: guard.paths, raw: guard.raw, ...(guard.providerKeys ? { providerKeys: guard.providerKeys } : {}), ...(guard.containers ? { containers: guard.containers } : {}) },
    sources: [] })
  const freeze = (value: unknown) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } }
  freeze(cut)
  return cut
}

export function projectModelSelection(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  const id = 'agent.model.selection'
  if (entry.type !== 'api') return Object.freeze({ id, status: 'unavailable', reason: 'unsupported_model_selection_type' })
  const value = record.primary_model_preset_id
  return Object.freeze({ id, status: 'available', fields: Object.freeze({ presetId:
    typeof value === 'string' && value ? valueState(value, value, item => typeof item === 'string') : value === undefined || value === null || value === ''
      ? Object.freeze({ stored: Object.freeze({ state: 'unset' as const }), effective: Object.freeze({ state: 'unknown' as const,
        reason: entry.type === 'api' && entry.subject.kind === 'subagent' && record.__apiSubagentInherits === true
          ? 'inherits_parent_model_and_connection_at_run' : 'no_saved_preset_selected' }), source: 'none' as const })
      : unknownState(false) }) })
}
/** The admitted owner supplied this opaque preset; this leaf never discovers a connection or model. */
export function planModelSelection(kind: 'agent' | 'subagent', target: ModelSelectionSnapshot, source: OwnedModelPresetSelection) {
  if (source.choice.voiceSession && kind !== 'agent') throw new Error('Speech-to-speech selection is Primary configuration only.')
  if (target.record[kind === 'agent' ? 'agentType' : 'subagentType'] !== 'api' || !source.choice.available) throw new Error('API model selection is unavailable for this target.')
  return planModelSelectionCandidate(kind, target, source.preset)
}
/** Pure future postimage only. This is never a source capability or permission to issue. */
export function planModelSelectionCandidate(kind: 'agent' | 'subagent', target: ModelSelectionSnapshot, preset: SavedModel) {
  if (target.record[kind === 'agent' ? 'agentType' : 'subagentType'] !== 'api') throw new Error('API model selection is unavailable for this target.')
  const picked = buildPickedPresetSelection(preset)
  const stored = target.record.provider_specific_settings
  const patch = buildAgentProviderSettingsPatch(stored, picked.provider_specific_settings)
  const modelPatch = patch ? Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== null ||
    !!stored && typeof stored === 'object' && Object.hasOwn(stored, key))) : {}
  const { provider_specific_settings: _settings, ...fields } = picked
  const updates: Record<string, unknown> = kind === 'agent' ? { ...fields,
    ...(Object.keys(modelPatch).length ? { provider_specific_settings: modelPatch } : {}) } : {
    primary_model_preset_id: picked.primary_model_preset_id, primary_model_connection: picked.primary_model_connection,
    primary_model_provider: picked.primary_model_provider, primary_model_name: picked.primary_model_name }
  // Existing domain planners prevalidate every value/container before the same sparse script issues.
  if (kind === 'agent') planAgentRecordUpdate({ updates, now: new Date().toISOString() })
  else planSubagentRecordUpdate({ writes: updates, now: new Date().toISOString() })
  return updates
}

export const planModelSelectionClear = prepareModelSelectionClear
function selectionFact(record: Readonly<Record<string, unknown>> | undefined, field: string): ModelSelectionFact {
  if (!record) return { state: 'unknown' }
  if (!Object.hasOwn(record, field) || record[field] === undefined) return { state: 'absent' }
  const value = record[field]
  return value === null ? { state: 'null' } : typeof value === 'string' && value.length <= 2048 && value.isWellFormed()
    ? { state: 'set', value } : { state: 'unknown' }
}
/** Fixed human-only facts from the original cut, never a replacement source/authority. */
export function modelSelectionReview(kind: 'agent' | 'subagent', target: ModelSelectionSnapshot, updates: Readonly<Record<string, unknown>>, clearing: boolean, voice?: ModelSelectionVoiceFacts): ModelSelectionReview {
  const type = kind === 'agent' ? normalizePrimaryAgentType(target.record) : normalizeSubagentType(target.record)
  // SA-139 R4/R5: only the API type is a selection subject; a retired `cli` record has no role.
  if (type !== 'api') throw new Error('The original selection role is unavailable.')
  const after = { ...target.record, ...updates }
  const hasOwnModel = [after.primary_model_name, after.model].some(value => typeof value === 'string' && !!value.trim())
  const knownOwnModel = [after.primary_model_name, after.model].every(value => value == null || typeof value === 'string')
  const selected = after.primary_model_preset_id
  const empty = selected == null || selected === ''
  return { intent: clearing ? 'clear' : 'select', role: kind === 'agent' ? 'api-primary' : 'api-subagent',
    presetBefore: selectionFact(target.record, 'primary_model_preset_id'), presetAfter: selectionFact(after, 'primary_model_preset_id'),
    legacyModel: kind === 'subagent' ? selectionFact(target.record, 'model') : { state: 'unknown' },
    inheritance: kind === 'subagent' && empty && knownOwnModel ? hasOwnModel ? 'legacy-model-requires-selection' : 'parent-model-and-connection-at-run' : 'no-replacement-promised',
    native: null,
    voice: voice ?? null }
}

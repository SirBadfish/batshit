import { LIVEKIT_SPEECH_TO_SPEECH_PROVIDER_PLAN } from '$lib/utils/modelVoiceSession'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
/** A3 selects one already-owned preset or explicitly clears it. No raw provider/model input. */
export type ModelSelectionChanges = { presetId: string; clear?: never } | { clear: true; presetId?: never }
export type ModelSelectionVoiceFacts = { runtime: 'livekit'; mode: 'speech-to-speech'; providerId: string; adapterId: string;
  supportStatus: 'supported'; locksVoiceModeSettings: boolean }
export type ModelSelectionFact = { state: 'absent' | 'null' | 'unknown' } | { state: 'set'; value: string }
export type ModelSelectionNativeFacts = { claudeModel: ModelSelectionFact; claudeLegacyModel: ModelSelectionFact }
export type ModelSelectionReview = {
  intent: 'select' | 'clear'; role: 'api-primary' | 'api-subagent' | 'cli-primary' | 'cli-subagent'
  presetBefore: ModelSelectionFact; presetAfter: ModelSelectionFact; legacyModel: ModelSelectionFact
  inheritance: 'parent-model-and-connection-at-run' | 'legacy-model-requires-selection' | 'no-replacement-promised'
  native: { before: ModelSelectionNativeFacts; after: ModelSelectionNativeFacts } | null
  voice: ModelSelectionVoiceFacts | null
}
export const MODEL_PRESET_COPY_ID = 'agent.model.preset-copy' as const
export type PresetParameterValue = string | number | boolean | string[] | number[]
export type PresetParameterEdit = { name: string; op: 'unset' } | { name: string; op: 'set'; value: PresetParameterValue }
export type ModelPresetCopyChanges = { sourcePresetId: string; copyName: string; parameters: PresetParameterEdit[] }
export type PresetParameterFact = { state: 'unset' | 'null' } | { state: 'set'; value: PresetParameterValue }
export type ModelPresetCopyReview = {
  planId: string; sourcePresetId: string; copyPresetId: string; copyName: string
  parameters: Array<{ name: string; label: string; before: PresetParameterFact; after: PresetParameterFact }>
}
export type ModelPresetCopyOutcome = {
  presetId: string; name: string; creation: 'not_requested' | 'saved' | 'unknown'
  source: 'not_requested' | 'confirmed' | 'unavailable'; assignment: 'not_started' | 'finished' | 'partial' | 'blocked'
  reason?: string
}
function copyText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && !!value && value === value.trim() && value.isWellFormed() &&
    new TextEncoder().encode(value).length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
}
function copyValue(value: unknown): value is PresetParameterValue {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (typeof value === 'string') return value.isWellFormed() && new TextEncoder().encode(value).length <= 2048
  if (Array.isArray(value)) return value.length <= 64 && (value.every(item => typeof item === 'string' && item.isWellFormed() && new TextEncoder().encode(item).length <= 2048) || value.every(item => typeof item === 'number' && Number.isFinite(item)))
  // A12 does not manufacture a schema for opaque JSON/native/custom parameters.
  return false
}
export function validateModelPresetCopyChanges(input: unknown): ModelPresetCopyChanges {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join() !== 'copyName,parameters,sourcePresetId') throw new Error('Choose one named model preset copy and typed parameter patch.')
  const value = input as Record<string, unknown>
  validateModelSelectionChanges({ presetId: value.sourcePresetId })
  if (!copyText(value.copyName, 200) || !Array.isArray(value.parameters) || !value.parameters.length || value.parameters.length > 32) throw new Error('A named preset copy requires a bounded typed patch.')
  const seen = new Set<string>()
  for (const edit of value.parameters) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) || !copyText(edit.name, 128) || seen.has(edit.name) ||
      (edit.op === 'unset' ? Object.keys(edit).sort().join() !== 'name,op' : edit.op !== 'set' || Object.keys(edit).sort().join() !== 'name,op,value' || !copyValue(edit.value))) throw new Error('Invalid typed preset parameter edit.')
    seen.add(edit.name)
  }
  if (new TextEncoder().encode(JSON.stringify(input)).length > 8192) throw new Error('The preset parameter patch is too large.')
  return input as ModelPresetCopyChanges
}
export function isModelPresetCopyReview(value: unknown): value is ModelPresetCopyReview {
  try {
    const row = value as ModelPresetCopyReview
    if (!row || Object.keys(row).sort().join() !== 'copyName,copyPresetId,parameters,planId,sourcePresetId' || !/^[a-f0-9]{32}$/.test(row.planId) || !copyText(row.copyName, 200)) return false
    validateModelSelectionChanges({ presetId: row.sourcePresetId }); validateModelSelectionChanges({ presetId: row.copyPresetId })
    if (row.copyPresetId === row.sourcePresetId || !Array.isArray(row.parameters) || !row.parameters.length || row.parameters.length > 32) return false
    const seen = new Set<string>()
    return row.parameters.every(edit => {
      if (!edit || Object.keys(edit).sort().join() !== 'after,before,label,name' || !copyText(edit.name, 128) || !copyText(edit.label, 200) || seen.has(edit.name)) return false
      seen.add(edit.name)
      return [edit.before, edit.after].every(isPresetParameterFact)
    })
  } catch { return false }
}
export function isPresetParameterFact(value: unknown): value is PresetParameterFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fact = value as Record<string, unknown>
  return fact.state === 'unset' || fact.state === 'null' ? Object.keys(fact).join() === 'state' :
    fact.state === 'set' && Object.keys(fact).sort().join() === 'state,value' && copyValue(fact.value)
}
export function isModelPresetCopyOutcome(value: unknown): value is ModelPresetCopyOutcome {
  try {
    const row = value as ModelPresetCopyOutcome
    if (!row || Object.keys(row).some(key => !['presetId', 'name', 'creation', 'source', 'assignment', 'reason'].includes(key))) return false
    validateModelSelectionChanges({ presetId: row.presetId })
    return copyText(row.name, 200) && ['not_requested', 'saved', 'unknown'].includes(row.creation) && ['not_requested', 'confirmed', 'unavailable'].includes(row.source) &&
      ['not_started', 'finished', 'partial', 'blocked'].includes(row.assignment) && (row.reason === undefined || copyText(row.reason, 200)) && (row.source !== 'confirmed' || row.creation === 'saved')
  } catch { return false }
}
export function validateModelSelectionChanges(input: unknown): ModelSelectionChanges {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1) throw new Error('Choose one existing saved model preset or explicitly clear it.')
  if (Object.hasOwn(input, 'clear')) {
    if ((input as Record<string, unknown>).clear !== true) throw new Error('Clear must be explicitly true.')
    return { clear: true }
  }
  if (!Object.hasOwn(input, 'presetId')) throw new Error('Choose one existing saved model preset.')
  const presetId = (input as Record<string, unknown>).presetId
  if (typeof presetId !== 'string' || !presetId || presetId !== presetId.trim() || presetId.length > 256 || !presetId.isWellFormed() || /[\u0000-\u001f\u007f]/.test(presetId)) throw new Error('The saved model preset ID is invalid.')
  return { presetId }
}

/** Human presentation only. The four native facts are never reparsed as mutation input. */
export function isModelSelectionReviewChanges(changes: unknown, clearing = false): boolean {
  if (!Array.isArray(changes) || changes.length !== 1 && changes.length !== 5) return false
  const fields = ['presetId', 'program', 'nativeStorage', 'nativeModel', 'fast']
  if (new Set(changes.map(change => change?.field)).size !== changes.length || changes.some(change => !change || !fields.includes(change.field) ||
    typeof change.label !== 'string' || change.label.length > 200 || !change.label.isWellFormed())) return false
  const values = Object.fromEntries(changes.map(change => [change.field, change]))
  try { if (clearing) { if (values.presetId?.after !== null || changes.length !== 1) return false } else validateModelSelectionChanges({ presetId: values.presetId?.after }) } catch { return false }
  const literal = (value: unknown) => value === null || typeof value === 'string' && value.isWellFormed()
  if (!literal(values.presetId.before)) return false
  if (changes.length === 1) return true
  return fields.every(field => Object.hasOwn(values, field)) &&
    [null, 'claude'].includes(values.program.before) && values.program.after === 'claude' &&
    values.nativeStorage.before === 'retained' && ['retained', 'model-patched', 'promoted'].includes(values.nativeStorage.after) &&
    literal(values.nativeModel.before) && literal(values.nativeModel.after) &&
    [null, 'standard', 'fast'].includes(values.fast.before) && [null, 'standard', 'fast'].includes(values.fast.after)
}

function selectionFact(value: unknown): value is ModelSelectionFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fact = value as Record<string, unknown>
  return fact.state === 'set' ? Object.keys(fact).sort().join() === 'state,value' && typeof fact.value === 'string' && fact.value.length <= 2048 && fact.value.isWellFormed()
    : ['absent', 'null', 'unknown'].includes(String(fact.state)) && Object.keys(fact).join() === 'state'
}
export function isModelSelectionReview(value: unknown): value is ModelSelectionReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as ModelSelectionReview
  if (Object.keys(row).sort().join() !== 'inheritance,intent,legacyModel,native,presetAfter,presetBefore,role,voice' || !['select', 'clear'].includes(row.intent) ||
    !['api-primary', 'api-subagent', 'cli-primary', 'cli-subagent'].includes(row.role) ||
    ![row.presetBefore, row.presetAfter, row.legacyModel].every(selectionFact) ||
    !['parent-model-and-connection-at-run', 'legacy-model-requires-selection', 'no-replacement-promised'].includes(row.inheritance)) return false
  if (row.presetBefore.state === 'unknown' || row.presetAfter.state === 'unknown' || row.intent === 'select' && (row.presetAfter.state !== 'set' || !row.presetAfter.value) || row.intent === 'clear' && row.presetAfter.state === 'set' && row.presetAfter.value !== '') return false
  if (row.role.startsWith('cli-')) {
    if (!row.native || Object.keys(row.native).sort().join() !== 'after,before' || ![row.native.before, row.native.after].every(facts =>
      facts && Object.keys(facts).sort().join() === 'claudeLegacyModel,claudeModel' && Object.values(facts).every(selectionFact))) return false
    if (row.intent === 'clear' && !sameJsonValue(row.native.before, row.native.after)) return false
  } else if (row.native !== null) return false
  if (row.inheritance !== 'no-replacement-promised' && (row.role !== 'api-subagent' || row.presetAfter.state === 'set' && row.presetAfter.value !== '')) return false
  if (row.voice !== null && (row.role !== 'api-primary' || row.intent !== 'select' || !isModelSelectionVoiceFacts(row.voice))) return false
  return true
}
export function isModelSelectionVoiceFacts(value: unknown): value is ModelSelectionVoiceFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const voice = value as ModelSelectionVoiceFacts
  return Object.keys(voice).sort().join() === 'adapterId,locksVoiceModeSettings,mode,providerId,runtime,supportStatus' &&
    voice.runtime === 'livekit' && voice.mode === 'speech-to-speech' && voice.supportStatus === 'supported' &&
    LIVEKIT_SPEECH_TO_SPEECH_PROVIDER_PLAN.some(plan => plan.providerId === voice.providerId && plan.adapterId === voice.adapterId && plan.supportStatus === 'supported') && typeof voice.locksVoiceModeSettings === 'boolean'
}
export function modelSelectionFactText(fact: ModelSelectionFact): string {
  return fact.state === 'set' ? fact.value || 'Empty (no saved selection)' : fact.state === 'absent' ? 'Not stored' : fact.state === 'null' ? 'Explicit null' : 'Unobserved, preserved'
}

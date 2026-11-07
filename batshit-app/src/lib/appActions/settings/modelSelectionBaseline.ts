import { presetModelSettings, applyAgentProviderSettingsUpdate, namesOnlyOwnKeys } from '$lib/utils/agentProviderSettings'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'

/** Request precondition only, never a stored field or an authority grant. */
export const MODEL_SELECTION_REVISION_HEADER = 'X-Batshit-Model-Selection-Revision'
export const MODEL_SELECTION_IDENTITY_FIELDS = ['primary_model_preset_id', 'primary_model_connection', 'primary_model_provider', 'primary_model_name'] as const
export const MODEL_SELECTION_FIELDS = [...MODEL_SELECTION_IDENTITY_FIELDS, 'primary_model_temperature', 'primary_model_max_tokens',
  'primary_model_top_p', 'primary_model_top_k', 'primary_model_frequency_penalty', 'primary_model_presence_penalty',
  'primary_model_seed', 'primary_model_stop_sequences', 'primary_model_reasoning_effort', 'primary_model_capabilities'] as const
export type ModelSelectionKind = 'agent' | 'subagent'
export type ModelSelectionBaseline = Readonly<{ revision: string; kind: ModelSelectionKind; id: string;
  type: 'api'; group: Readonly<Record<string, unknown>> }>
export function isModelSelectionRevision(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}
export function modelSelectionProjection(kind: ModelSelectionKind, row: Record<string, unknown>): Record<string, unknown> {
  const fields = kind === 'agent' ? MODEL_SELECTION_FIELDS : MODEL_SELECTION_IDENTITY_FIELDS
  return { ...Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])),
    ...(kind === 'agent' ? { provider_specific_settings: presetModelSettings(row.provider_specific_settings) } : {}) }
}
export function captureModelSelectionBaseline(kind: ModelSelectionKind, row: Record<string, unknown>, revision: unknown): ModelSelectionBaseline | null {
  const type = kind === 'agent' ? row.agentType : row.subagentType
  // SA-139 R4/R5: only the live API type holds a model selection; a retired `cli` record has none.
  if (!isModelSelectionRevision(revision) || typeof row.id !== 'string' || !row.id || type !== 'api') return null
  // The snapshot is detached from rows/forms, including nested settings and capabilities.
  const group = JSON.parse(JSON.stringify(modelSelectionProjection(kind, row))) as Record<string, unknown>
  return Object.freeze({ revision, kind, id: row.id, type, group: Object.freeze(group) })
}
export function isModelSelectionWrite(kind: ModelSelectionKind, body: Record<string, unknown>): boolean {
  if ((kind === 'agent' ? MODEL_SELECTION_FIELDS : MODEL_SELECTION_IDENTITY_FIELDS).some(key => Object.hasOwn(body, key))) return true
  if (kind !== 'agent' || !Object.hasOwn(body, 'provider_specific_settings')) return false
  const block = body.provider_specific_settings
  return block === null || Boolean(block && typeof block === 'object' && !Array.isArray(block) && !namesOnlyOwnKeys(block as Record<string, unknown>))
}
export function sameModelSelection(kind: ModelSelectionKind, left: object, right: object): boolean {
  return sameJsonValue(modelSelectionProjection(kind, left as Record<string, unknown>), modelSelectionProjection(kind, right as Record<string, unknown>))
}
/** Replace only this group's leaves. Runtime/native provider keys remain owned by their writers. */
export function withModelSelection<T extends object>(kind: ModelSelectionKind, row: T, incoming: object): T {
  const fields = kind === 'agent' ? MODEL_SELECTION_FIELDS : MODEL_SELECTION_IDENTITY_FIELDS
  const current = row as Record<string, unknown>, next = incoming as Record<string, unknown>
  const result = { ...row, ...Object.fromEntries(fields.map(key => [key, next[key]])), ...(kind === 'agent' ? {
    provider_specific_settings: applyAgentProviderSettingsUpdate(current.provider_specific_settings, presetModelSettings(next.provider_specific_settings))
  } : {}) } as Record<string, unknown>
  return result as T
}

import type { SavedModel } from '$lib/types/savedModels'
import { isParameterSuppressedForModel } from '$lib/utils/parameterFilter'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { presetModelSettings, buildAgentProviderSettingsPatch } from '$lib/utils/agentProviderSettings'
import { AGENT_MODEL_FIELDS } from '$lib/utils/agentSettingsSavePatch'

/**
 * BL-515: the agent's `primary_model_*` fields a chat-bar preset pick saves. A value the preset
 * does not set (or a parameter this model does not take) is sent as `null`, which the agent PUT
 * stores as absent (`redis.updateAgent`'s nullable list); `undefined` vanished from the JSON body,
 * so preset B kept preset A's temperature on the record. A real 0 is kept.
 */
export interface PickedPresetModelFields {
  primary_model_preset_id: string
  primary_model_name: string
  primary_model_provider: string
  primary_model_temperature: number | null
  primary_model_max_tokens: number | null
  primary_model_top_p: number | null
  primary_model_top_k: number | null
  primary_model_frequency_penalty: number | null
  primary_model_presence_penalty: number | null
  primary_model_seed: number | null
  primary_model_stop_sequences: string[] | null
  primary_model_reasoning_effort: string | null
  primary_model_capabilities: NonNullable<SavedModel['capabilities']> | null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function buildPickedPresetModelFields(model: SavedModel): PickedPresetModelFields {
  const settings = model.settings ?? {}
  const suppressed = (name: string) =>
    isParameterSuppressedForModel(name, {
      provider: model.provider,
      modelId: model.modelId,
      vercelId: model.catalogModelId ?? model.vercelSourceId
    })
  const sampling = (name: string, value: unknown) => (suppressed(name) ? null : numberOrNull(value))

  return {
    primary_model_preset_id: model.id,
    primary_model_name: model.effectiveModelId ?? model.modelId,
    primary_model_provider: model.provider,
    primary_model_capabilities: model.capabilities ?? null,
    primary_model_temperature: sampling('temperature', settings.temperature),
    primary_model_max_tokens: numberOrNull(settings.maxTokens),
    primary_model_top_p: sampling('topP', settings.topP),
    primary_model_top_k: sampling('topK', settings.topK),
    primary_model_frequency_penalty: sampling('frequencyPenalty', settings.frequencyPenalty),
    primary_model_presence_penalty: sampling('presencePenalty', settings.presencePenalty),
    primary_model_seed: numberOrNull(settings.seed),
    primary_model_stop_sequences: Array.isArray(settings.stopSequences)
      ? settings.stopSequences.map((entry: unknown) => String(entry))
      : null,
    primary_model_reasoning_effort:
      typeof settings.reasoningEffort === 'string' && settings.reasoningEffort.trim()
        ? settings.reasoningEffort
        : null
  }
}

/** One selected-preset payload for the human pickers and admitted API owner.
 * Unknown capability metadata belongs to this preset; an older agent copy is never evidence.
 * The caller's existing sparse provider owner preserves agent/native keys separately. */
export function buildPickedPresetSelection(model: SavedModel) {
  return { ...buildPickedPresetModelFields(model),
    primary_model_connection: resolveSavedModelConnection(model),
    provider_specific_settings: presetModelSettings(model.settings) }
}

/** The existing human clear, restricted to values actually stored in the owned group.
 * Missing/null/empty leaves are not normalized. Native/legacy/Voice fields are untouched. */
export function buildClearedPresetSelection(kind: 'agent' | 'subagent', record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const updates: Record<string, unknown> = {}
  for (const field of AGENT_MODEL_FIELDS.slice(0, 4)) {
    const value = record[field]
    if (value === undefined || value === null || value === '') continue
    if (field === 'primary_model_connection') {
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The saved model connection is unreadable.')
      updates[field] = null
    } else {
      if (typeof value !== 'string') throw new Error('The saved model selection is unreadable.')
      updates[field] = ''
    }
  }
  if (kind === 'agent') {
    for (const field of AGENT_MODEL_FIELDS.slice(4)) if (record[field] !== undefined && record[field] !== null) updates[field] = null
    const stored = presetModelSettings(record.provider_specific_settings)
    const patch = Object.fromEntries(Object.entries(buildAgentProviderSettingsPatch(record.provider_specific_settings, null) ?? {}).filter(([key]) => stored[key] != null))
    if (Object.keys(patch).length) updates.provider_specific_settings = patch
  }
  return updates
}

/** Human DTO intent only; the server still requires the original atomic header/CAS. */
export function isCompleteEmptyModelSelection(updates: Readonly<Record<string, unknown>>): boolean {
  return AGENT_MODEL_FIELDS.slice(0, 4).every(field => Object.hasOwn(updates, field) &&
    (field === 'primary_model_connection' ? updates[field] === null : updates[field] === null || updates[field] === '')) &&
    AGENT_MODEL_FIELDS.slice(4).every(field => updates[field] == null) &&
    Object.values(presetModelSettings(updates.provider_specific_settings)).every(value => value == null)
}

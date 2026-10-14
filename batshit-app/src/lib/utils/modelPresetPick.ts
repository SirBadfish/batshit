import type { SavedModel } from '$lib/types/savedModels'
import { isParameterSuppressedForModel } from '$lib/utils/parameterFilter'

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

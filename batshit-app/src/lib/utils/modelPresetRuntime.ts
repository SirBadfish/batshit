import type {
  ModelCapabilities,
  ModelConnectionInfo,
  SavedModel,
} from '$lib/types/savedModels'
import {
  isAgentRuntimeSettingKey,
  type RuntimeModelStandardSettings,
} from '$lib/utils/modelSettingsMapper'

type ProviderSettings = Record<string, any> | null | undefined

export interface RuntimeModelSelectionArgs {
  preset?: SavedModel | null
  presetId?: string | null
  provider?: string | null
  modelId?: string | null
  effectiveModelId?: string | null
  connection?: ModelConnectionInfo | null
  contextWindow?: number | null
  capabilities?: ModelCapabilities | null
  settings?: ProviderSettings
}

export interface RuntimeModelSelection {
  preset: SavedModel | null
  presetId: string | null
  provider: string | null
  modelId: string | null
  effectiveModelId: string | null
  connection: ModelConnectionInfo | null
  contextWindow: number | null
  capabilities: ModelCapabilities | null
  settings: Record<string, any> | null
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function cloneRecord(value: ProviderSettings): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return { ...value }
}

function nonEmptyRecord(value: ProviderSettings): Record<string, any> | null {
  const copy = cloneRecord(value)
  return copy && Object.keys(copy).length > 0 ? copy : null
}

/**
 * BL-515: the runtime settings of an agent (or Subagent) that names a preset: the live preset's
 * settings plus only the agent's OWN keys (`isAgentRuntimeSettingKey`: the native-tool block and
 * its legacy keys, `codex_*`, `claude_*`, `batshit_*`). The agent's copy of an older preset's
 * values (what the picker stored when the preset was picked) is not read, so a value later
 * cleared in the preset is not sent, and preset B never inherits preset A's temperature. Where
 * both hold a key, the preset's value wins, as before.
 */
export function mergePresetRuntimeSettings(
  agentSettings: ProviderSettings,
  presetSettings: ProviderSettings,
): Record<string, any> | null {
  const agentOwned = Object.fromEntries(
    Object.entries(cloneRecord(agentSettings) ?? {}).filter(([key]) => isAgentRuntimeSettingKey(key)),
  )
  const merged = {
    ...agentOwned,
    ...(cloneRecord(presetSettings) ?? {}),
  }

  return Object.keys(merged).length > 0 ? merged : null
}

type AgentModelFallbackFields = {
  primary_model_temperature?: number | null
  primary_model_max_tokens?: number | null
  primary_model_top_p?: number | null
  primary_model_top_k?: number | null
  primary_model_presence_penalty?: number | null
  primary_model_frequency_penalty?: number | null
  primary_model_seed?: number | null
  primary_model_stop_sequences?: string[] | null
}

/**
 * BL-515: the agent's `primary_model_*` sampling copies as runtime fallbacks, only for an agent
 * that names no preset (a record from before presets). An agent that names a preset takes its
 * values from the preset alone: blank sends nothing, zero is real. A stored null is absent.
 */
export function resolveAgentModelFallbacks({
  preset,
  agent,
}: {
  preset: SavedModel | null
  agent: AgentModelFallbackFields | null | undefined
}): RuntimeModelStandardSettings | undefined {
  if (preset) return undefined
  const fallbacks: RuntimeModelStandardSettings = {}
  const assign = <K extends keyof RuntimeModelStandardSettings>(
    key: K,
    value: RuntimeModelStandardSettings[K] | null | undefined,
  ) => {
    if (value !== undefined && value !== null) fallbacks[key] = value
  }
  assign('temperature', agent?.primary_model_temperature)
  assign('maxTokens', agent?.primary_model_max_tokens)
  assign('topP', agent?.primary_model_top_p)
  assign('topK', agent?.primary_model_top_k)
  assign('presencePenalty', agent?.primary_model_presence_penalty)
  assign('frequencyPenalty', agent?.primary_model_frequency_penalty)
  assign('seed', agent?.primary_model_seed)
  assign('stopSequences', agent?.primary_model_stop_sequences)
  return fallbacks
}

export function resolveRuntimeModelSelection({
  preset = null,
  presetId = null,
  provider = null,
  modelId = null,
  effectiveModelId = null,
  connection = null,
  contextWindow = null,
  capabilities = null,
  settings = null,
}: RuntimeModelSelectionArgs): RuntimeModelSelection {
  return {
    preset,
    presetId: normalizeString(preset?.id) ?? normalizeString(presetId),
    provider: normalizeString(preset?.provider) ?? normalizeString(provider),
    modelId: normalizeString(preset?.modelId) ?? normalizeString(modelId),
    effectiveModelId:
      normalizeString(preset?.effectiveModelId) ?? normalizeString(effectiveModelId),
    connection: preset?.connection ?? connection ?? null,
    contextWindow:
      typeof preset?.contextWindow === 'number'
        ? preset.contextWindow
        : typeof contextWindow === 'number'
          ? contextWindow
          : null,
    capabilities: preset?.capabilities ?? capabilities ?? null,
    settings: preset
      ? mergePresetRuntimeSettings(settings, preset.settings ?? null)
      : nonEmptyRecord(settings),
  }
}

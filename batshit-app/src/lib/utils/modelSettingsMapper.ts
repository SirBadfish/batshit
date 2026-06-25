import { filterParameters, isParameterSuppressedForModel } from '$lib/utils/parameterFilter'
import type { ModelCapabilities, ModelConnectionInfo, ModelPurpose } from '$lib/types/savedModels'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  normalizeRuntimeMaxOutputTokens
} from '$lib/utils/modelOutputTokens'

export type StandardKey = keyof RuntimeModelStandardSettings

export const OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = DEFAULT_MODEL_MAX_OUTPUT_TOKENS
const OPENROUTER_CONTEXT_WINDOW_OUTPUT_RATIO = 0.8
const OPENROUTER_UNKNOWN_CONTEXT_MAX_OUTPUT_TOKENS = 64_000
const OPENROUTER_MIN_CLAMPED_MAX_OUTPUT_TOKENS = 1_024

export interface RuntimeModelStandardSettings {
  temperature?: number
  maxTokens?: number
  topP?: number
  topK?: number
  presencePenalty?: number
  frequencyPenalty?: number
  seed?: number
  stopSequences?: string[]
}

export interface RuntimeModelSettings {
  standard: RuntimeModelStandardSettings
  providerOptions: Record<string, Record<string, any>>
}

export interface RuntimeSettingsArgs {
  provider?: string | null
  modelId?: string | null
  vercelId?: string | null
  connection?: ModelConnectionInfo | null
  contextWindow?: number | null
  capabilities?: ModelCapabilities | null
  purpose?: ModelPurpose | null
  settings?: Record<string, ParameterValue> | null
  fallbacks?: RuntimeModelStandardSettings
}

export function buildRuntimeModelSettings({
  provider,
  modelId,
  vercelId,
  connection,
  contextWindow,
  capabilities,
  purpose,
  settings,
  fallbacks
}: RuntimeSettingsArgs): RuntimeModelSettings {
  const definitions = filterParameters({
    provider: provider ?? undefined,
    modelId: modelId ?? undefined,
    vercelId: vercelId ?? undefined,
    capabilities: capabilities ?? null,
    purpose: purpose ?? 'chat'
  })
  const knownKeys = new Set(definitions.map((definition) => definition.name))

  const standard: RuntimeModelStandardSettings = {}
  const providerOptions: Record<string, Record<string, any>> = {}

  for (const definition of definitions) {
    const value = settings?.[definition.name]
    if (value === undefined || value === null) continue

    if (applySpecialProviderMapping(definition.name, value, providerOptions, provider)) {
      continue
    }

    if (definition.standardKey) {
      assignStandardValue(standard, definition.standardKey, value)
      continue
    }

    if (definition.providerOptionKey) {
      assignProviderOption(providerOptions, definition.providerOptionKey, value)
    }
  }

  if (settings) {
    for (const [key, value] of Object.entries(settings)) {
      if (knownKeys.has(key)) continue
      if (value === undefined || value === null) continue
      if (isParameterSuppressedForModel(key, { provider, modelId, vercelId })) {
        continue
      }

      if (applySpecialProviderMapping(key, value, providerOptions, provider)) {
        continue
      }

      const standardKey = STANDARD_KEY_MAP[key]
      if (standardKey) {
        assignStandardValue(standard, standardKey, value)
        continue
      }

      if (key.includes('.')) {
        assignProviderOption(providerOptions, key, value)
        continue
      }

      if (provider) {
        assignProviderOption(providerOptions, `${provider}.${key}`, value)
      }
    }
  }

  if (fallbacks) {
    for (const [key, fallbackValue] of Object.entries(fallbacks)) {
      const typedKey = key as keyof RuntimeModelStandardSettings
      if (isParameterSuppressedForModel(typedKey, { provider, modelId, vercelId })) {
        continue
      }
      if (standard[typedKey] === undefined && fallbackValue !== undefined) {
        // Clone arrays to avoid accidental mutation
        if (Array.isArray(fallbackValue)) {
          standard[typedKey] = [...fallbackValue] as any
        } else {
          standard[typedKey] = fallbackValue
        }
      }
    }
  }

  standard.maxTokens = normalizeRuntimeMaxTokens({
    maxTokens: standard.maxTokens,
    provider,
    modelId,
    connection,
    contextWindow
  })

  return {
    standard,
    providerOptions
  }
}

export function normalizeRuntimeMaxTokens({
  maxTokens,
  provider,
  modelId,
  connection,
  contextWindow
}: {
  maxTokens?: number
  provider?: string | null
  modelId?: string | null
  connection?: ModelConnectionInfo | null
  contextWindow?: number | null
}): number | undefined {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return undefined
  }

  const normalizedMaxTokens = normalizeRuntimeMaxOutputTokens({
    maxOutputTokens: maxTokens,
    contextWindow
  })
  if (normalizedMaxTokens === undefined) {
    return undefined
  }

  if (normalizedMaxTokens !== Math.floor(maxTokens)) {
    console.warn('[model-settings] Clamped context-sized max output tokens', {
      provider,
      modelId,
      requestedMaxOutputTokens: Math.floor(maxTokens),
      contextWindow,
      maxOutputTokens: normalizedMaxTokens
    })
    return normalizedMaxTokens
  }

  if (!isOpenRouterRuntime(provider, connection)) {
    return normalizedMaxTokens
  }

  if (!shouldClampOpenRouterMaxOutput(normalizedMaxTokens, contextWindow)) {
    return normalizedMaxTokens
  }

  const clampedMaxTokens = getOpenRouterClampedMaxOutput(contextWindow)
  console.warn('[model-settings] Clamped stale OpenRouter max output tokens', {
    provider,
    modelId,
    requestedMaxOutputTokens: normalizedMaxTokens,
    contextWindow,
    maxOutputTokens: clampedMaxTokens
  })
  return clampedMaxTokens
}

function isOpenRouterRuntime(provider?: string | null, connection?: ModelConnectionInfo | null) {
  const normalizedProvider = provider?.trim().toLowerCase()
  const connectionType = connection?.type?.trim().toLowerCase()
  const connectionId = connection?.id?.trim().toLowerCase()
  const service = connection?.service?.trim().toLowerCase()

  return (
    normalizedProvider === 'openrouter' ||
    connectionType === 'openrouter' ||
    connectionId === 'openrouter' ||
    service === 'openrouter'
  )
}

function shouldClampOpenRouterMaxOutput(maxTokens: number, contextWindow?: number | null) {
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    return maxTokens >= Math.floor(contextWindow * OPENROUTER_CONTEXT_WINDOW_OUTPUT_RATIO)
  }

  return maxTokens > OPENROUTER_UNKNOWN_CONTEXT_MAX_OUTPUT_TOKENS
}

function getOpenRouterClampedMaxOutput(contextWindow?: number | null) {
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.min(
      OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
      Math.max(
        OPENROUTER_MIN_CLAMPED_MAX_OUTPUT_TOKENS,
        Math.floor(contextWindow / 2)
      )
    )
  }

  return OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS
}

const STANDARD_KEY_MAP: Record<string, StandardKey> = {
  temperature: 'temperature',
  maxTokens: 'maxTokens',
  topP: 'topP',
  topK: 'topK',
  presencePenalty: 'presencePenalty',
  frequencyPenalty: 'frequencyPenalty',
  seed: 'seed',
  stopSequences: 'stopSequences'
}

function assignStandardValue(
  target: RuntimeModelStandardSettings,
  key: StandardKey,
  rawValue: ParameterValue
) {
  switch (key) {
    case 'temperature':
    case 'topP':
    case 'topK':
    case 'presencePenalty':
    case 'frequencyPenalty':
      if (typeof rawValue === 'number') {
        target[key] = rawValue
      }
      break
    case 'maxTokens':
      if (typeof rawValue === 'number') {
        target.maxTokens = Math.floor(rawValue)
      }
      break
    case 'seed':
      if (typeof rawValue === 'number') {
        target.seed = Math.floor(rawValue)
      }
      break
    case 'stopSequences':
      if (Array.isArray(rawValue)) {
        target.stopSequences = rawValue.map((entry) => String(entry))
      }
      break
    default:
      break
  }
}

function assignProviderOption(
  providerOptions: Record<string, Record<string, any>>,
  key: string,
  value: ParameterValue
) {
  const segments = key.split('.')
  if (segments.length === 0) return
  const provider = segments.shift()!
  if (!providerOptions[provider]) {
    providerOptions[provider] = {}
  }

  let cursor = providerOptions[provider]
  while (segments.length > 1) {
    const segment = segments.shift()!
    if (!cursor[segment]) {
      cursor[segment] = {}
    }
    cursor = cursor[segment]
  }

  const finalKey = segments.shift()!
  cursor[finalKey] = value
}

function applySpecialProviderMapping(
  name: string,
  value: ParameterValue,
  providerOptions: Record<string, Record<string, any>>,
  provider?: string | null
) {
  const normalizedProvider = provider?.toLowerCase() ?? ''
  switch (name) {
    case 'cacheControl': {
      if (normalizedProvider && normalizedProvider !== 'anthropic') {
        return false
      }
      if (typeof value !== 'string' || !value.length) {
        return true
      }
      if (!providerOptions.anthropic) {
        providerOptions.anthropic = {}
      }
      providerOptions.anthropic.cacheControl = {
        type: 'ephemeral',
        ttl: value
      }
      return true
    }
    case 'thinkingMode': {
      if (normalizedProvider && normalizedProvider !== 'anthropic') {
        return false
      }
      if (!providerOptions.anthropic) {
        providerOptions.anthropic = {}
      }
      if (!providerOptions.anthropic.thinking) {
        providerOptions.anthropic.thinking = {}
      }
      providerOptions.anthropic.thinking.type = value
      return true
    }
    case 'thinkingBudget': {
      if (normalizedProvider && normalizedProvider !== 'anthropic') {
        return false
      }
      if (typeof value !== 'number') return true
      if (!providerOptions.anthropic) {
        providerOptions.anthropic = {}
      }
      if (!providerOptions.anthropic.thinking) {
        providerOptions.anthropic.thinking = {}
      }
      providerOptions.anthropic.thinking.budgetTokens = Math.floor(value)
      return true
    }
    default:
      return false
  }
}

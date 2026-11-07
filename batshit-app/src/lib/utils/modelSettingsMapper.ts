import { filterParameters, isParameterSuppressedForModel, resolveParameterProvider } from '$lib/utils/parameterFilter'
import {
  LOCAL_AI_SERVER_IDS,
  resolveLocalProviderOptionsSegment
} from '$lib/data/localAiServers'
import type { ModelCapabilities, ModelConnectionInfo, ModelPurpose } from '$lib/types/savedModels'
import {
  ALL_DEFINED_PARAMETER_NAMES,
  type ParameterDefinition,
  type ParameterValue
} from '$lib/data/parameter-schemas'
import { describeUnlistedSelectValue, resolveSavedSelectValue } from '$lib/utils/parameterValueAdapter'
import { REVIEWED_REASONING_SETTING_OWNERS, reviewedReasoningBinding, isOllamaReasoningConnection } from '$lib/data/reasoning-controls'
import { CLAUDE_PLAN_REASONING_ADAPTER, ClaudePlanSettingsError, isClaudePlanSelection, readClaudePlanSettings } from '$lib/utils/claudePlanConnection'
import type { LocalReasoningContract, ExplicitReasoningSnapshot } from '$lib/types/reasoningControls'
import { ModelReasoningSettingError, reasoningProviderValue, validateReviewedReasoningSettings } from '$lib/utils/modelReasoningControls'
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  normalizeRuntimeMaxOutputTokens
} from '$lib/utils/modelOutputTokens'

import {
  AnthropicThinkingRefusedError,
  refuseAnthropicThinkingTheModelRejects,
  sendsAnthropicOptions
} from '$lib/utils/anthropicThinkingGuard'

export type StandardKey = keyof RuntimeModelStandardSettings

/**
 * SA-102 P2: the `providerOptions` segment a LOCAL runtime's settings travel
 * under.
 *
 * `@ai-sdk/openai-compatible` reads both `providerOptions[name]` and
 * `providerOptions[camelCase(name)]`, but it marks the raw hyphenated form
 * DEPRECATED — measured on 3.0.43: `Deprecated: "providerOptions key
 * 'llama-cpp'". Use 'llamaCpp' instead.` `llama-cpp` is Batshit's only
 * hyphenated runtime id, so without this every llama.cpp send would ship a
 * deprecation warning today and break outright when the SDK drops the alias.
 *
 * Narrow on purpose: cloud provider ids are not touched, because their
 * providerOptions keys are an external contract (`openai`, `anthropic`, …) and
 * some carry underscores that must stay literal.
 */
export function resolveProviderOptionsSegment(provider: string): string {
  if (!LOCAL_AI_SERVER_IDS.has(provider as any)) return provider
  return resolveLocalProviderOptionsSegment(provider)
}

/**
 * SA-102 P2: Batshit-internal runtime settings that live in the same bag as
 * model parameters and must never reach a provider's request body.
 *
 * `provider_specific_settings` on an agent carries `nativeTools` (execution
 * backend, bash access mode) and the whole `codex_*` / `claude_*` managed-CLI
 * configuration. That bag is merged with the preset's settings before it
 * reaches this mapper. The strict OpenAI provider used to hide the problem by
 * validating `providerOptions.openai` against a closed schema; the
 * openai-compatible transport local runtimes now use spreads providerOptions
 * into the body verbatim, so an unguarded catch-all would ship Batshit's
 * internal configuration to a third-party server. Measured on the wire during
 * P2: a local send carried `"nativeTools":{"executionBackend":"local",
 * "bashAccessMode":"plan"}` in the chat-completions body.
 */
export const INTERNAL_SETTING_PREFIXES = ['codex_', 'claude_', 'batshit_'] as const
/**
 * BL-515: also the agent-owned keys a preset never holds, which is why they survive when an
 * agent's runtime settings are rebuilt from the preset it names (`mergePresetRuntimeSettings`):
 * the native-tool block and its legacy alias (`batshitNativeTools`), and the legacy top-level
 * native-tool keys `resolveNativeToolSettings` and `resolveBrokerToolToggles` still read (every
 * `native<Name>` key, plus the unprefixed names below). Dropping one would quietly turn a tool
 * setting such as `bashEnabled: false` back to its default.
 */
export const INTERNAL_SETTING_NAMES: ReadonlySet<string> = new Set([
  'nativeTools',
  'batshitNativeTools',
  'bashEnabled',
  'bashPolicyMode',
  'bashExecutionBackend',
  'bashAgentApprovalCardsEnabled',
  'bashApprovalCardsEnabled',
  'webSearchEnabled',
  'agentBrowserEnabled',
  'agentBrowserLiveViewEnabled',
  'fetchZipEnabled',
  'dynamicMcpEnabled',
  'cliToolsEnabled',
  'artifactRuntimeEnabled',
  'batshitToolsEnabled'
])
const LEGACY_NATIVE_SETTING_PATTERN = /^native[A-Z]/

/**
 * Batshit's own runtime configuration in an agent's `provider_specific_settings`: never a model
 * parameter, never sent to a provider, and kept from the agent when its settings come from a
 * preset (BL-515).
 */
export function isAgentRuntimeSettingKey(key: string): boolean {
  if (INTERNAL_SETTING_NAMES.has(key)) return true
  if (LEGACY_NATIVE_SETTING_PATTERN.test(key)) return true
  return INTERNAL_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export const OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = DEFAULT_MODEL_MAX_OUTPUT_TOKENS
export const MIMO_V25_XIAOMI_MAX_OUTPUT_TOKENS = 131_072
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
  localReasoning?: LocalReasoningContract | null
  /** Server-only identity proof. Preview never exposes wire options or needs this value. */
  localReasoningConnectionKey?: string
  explicitReasoning?: ExplicitReasoningSnapshot[]
}

function mapRuntimeModelSettings({
  provider,
  modelId,
  vercelId,
  connection,
  contextWindow,
  capabilities,
  purpose,
  settings,
  fallbacks, localReasoning, localReasoningConnectionKey, explicitReasoning
}: RuntimeSettingsArgs): RuntimeModelSettings {
  const parameterProvider = resolveParameterProvider(provider, connection)
  const definitions = filterParameters({
    provider: parameterProvider ?? undefined,
    modelId: modelId ?? undefined,
    vercelId: vercelId ?? undefined,
    capabilities: capabilities ?? null,
    connectionInfo: connection,
    purpose: purpose ?? 'chat'
  })
  const knownKeys = new Set(definitions.map((definition) => definition.name))

  const standard: RuntimeModelStandardSettings = {}
  const providerOptions: Record<string, Record<string, any>> = {}

  for (const definition of definitions) {
    const value = settings?.[definition.name]
    if (value === undefined || value === null) continue

    if (
      applySpecialProviderMapping(definition.name, value, providerOptions, parameterProvider, {
        definition,
        modelId,
        connection
      })
    ) {
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
      // SA-102 P2: Batshit's own runtime configuration is not a model parameter.
      if (isAgentRuntimeSettingKey(key)) continue
      // SA-102 P2: a parameter Batshit defines but did NOT offer for this model
      // was excluded on purpose. Only genuine user-authored Custom Parameters
      // reach the passthrough below.
      if (ALL_DEFINED_PARAMETER_NAMES.has(key) && (!REVIEWED_REASONING_SETTING_OWNERS[key] || REVIEWED_REASONING_SETTING_OWNERS[key] === parameterProvider)) continue
      if (isParameterSuppressedForModel(key, { provider: parameterProvider, modelId, vercelId })) {
        continue
      }

      if (applySpecialProviderMapping(key, value, providerOptions, parameterProvider)) {
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

      if (parameterProvider) {
        assignProviderOption(
          providerOptions,
          `${resolveProviderOptionsSegment(parameterProvider)}.${key}`,
          value
        )
      }
    }
  }

  if (fallbacks) {
    for (const [key, fallbackValue] of Object.entries(fallbacks)) {
      const typedKey = key as keyof RuntimeModelStandardSettings
      if (isParameterSuppressedForModel(typedKey, { provider: parameterProvider, modelId, vercelId })) {
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

  const explicit = localReasoningSelection({ modelId, connection, explicitReasoning })
  if (explicit) {
    if (!reviewedReasoningBinding({ modelId, connection, localReasoning })) throw new ModelReasoningSettingError('Ollama Thinking options could not be verified. Your saved choice was kept.')
    const ollama = { ...providerOptions.ollama }
    if (explicit.selection.mode === 'provider-default') delete ollama.think
    else if (typeof explicit.selection.value === 'boolean') ollama.think = explicit.selection.value
    else throw new ModelReasoningSettingError('Ollama Thinking requires On or Off.')
    providerOptions.ollama = ollama
    providerOptions.batshit_reasoning = { ...providerOptions.batshit_reasoning, ollama: {
      modelId, adapterVersion: localReasoning!.adapterVersion, runtimeVersion: localReasoning!.runtimeVersion,
      connectionKey: localReasoningConnectionKey ?? '', ...explicit.selection
    } }
  }
  return { standard, providerOptions }
}

function localReasoningSelection(args: Pick<RuntimeSettingsArgs, 'connection' | 'modelId' | 'explicitReasoning'>) {
  if (!isOllamaReasoningConnection(args.connection)) return undefined
  return args.explicitReasoning?.find(entry => entry.control === 'thinking' && isOllamaReasoningConnection(entry.identity.connection) && entry.identity.effectiveModelId === args.modelId)
}
function validateRuntimeReasoning(args: RuntimeSettingsArgs, mapped: RuntimeModelSettings, requireServerIdentity = true) {
  if (requireServerIdentity && localReasoningSelection(args) && !/^[a-f0-9]{64}$/.test(args.localReasoningConnectionKey ?? '')) {
    throw new ModelReasoningSettingError('The server-owned Ollama connection could not be verified. Your saved choice was kept.')
  }
  refuseAnthropicThinkingTheModelRejects({ ...args, providerOptions: mapped.providerOptions })
  // SA-139: a Claude plan selection's settings never become provider options, so the reviewed check
  // below sees nothing; Send and the chat-bar preview run the plan's own check instead (same words as admission).
  if (isClaudePlanSelection(args.connection) && args.modelId) {
    try { readClaudePlanSettings(args.settings, args.modelId, { where: 'run', allowKey: isAgentRuntimeSettingKey }) }
    catch (error) { if (error instanceof ClaudePlanSettingsError) throw new ModelReasoningSettingError(error.message); throw error }
  }
  validateReviewedReasoningSettings({ ...args, providerOptions: mapped.providerOptions })
}

export function buildRuntimeModelSettings(args: RuntimeSettingsArgs): RuntimeModelSettings {
  const mapped = mapRuntimeModelSettings(args)
  validateRuntimeReasoning(args, mapped)
  return mapped
}

/** UI gets only control values and the same refusal as Send, never unchecked wire options. */
export function previewRuntimeReasoningSettings(args: RuntimeSettingsArgs): { values: Record<string, unknown>; error: string | null } {
  const binding = reviewedReasoningBinding(args)
  const values: Record<string, unknown> = {}
  try {
    const mapped = mapRuntimeModelSettings(args)
    // SA-139: the Claude plan's controls never become provider options; their value is the setting itself.
    for (const control of binding?.controls ?? []) values[control.id] = binding!.adapter.package === CLAUDE_PLAN_REASONING_ADAPTER
      ? args.settings?.[control.setting] ?? undefined : reasoningProviderValue(mapped.providerOptions, control.providerPath)
    validateRuntimeReasoning(args, mapped, false)
    return { values, error: null }
  } catch (error) {
    return { values, error: error instanceof Error ? error.message : 'This reasoning configuration cannot be sent.' }
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

  if (
    isMimoV25TextModel(modelId) &&
    normalizedMaxTokens > MIMO_V25_XIAOMI_MAX_OUTPUT_TOKENS
  ) {
    console.warn('[model-settings] Clamped MiMo V2.5 Xiaomi max output tokens', {
      provider,
      modelId,
      requestedMaxOutputTokens: normalizedMaxTokens,
      maxOutputTokens: MIMO_V25_XIAOMI_MAX_OUTPUT_TOKENS
    })
    return MIMO_V25_XIAOMI_MAX_OUTPUT_TOKENS
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

function isMimoV25TextModel(modelId?: string | null) {
  const normalizedModelId = modelId?.trim().toLowerCase() ?? ''
  return /^(?:xiaomi\/)?mimo-v2\.5(?:-pro)?$/.test(normalizedModelId)
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
    const previous = cursor[segment]
    cursor[segment] = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : previous || {}
    cursor = cursor[segment]
  }

  const finalKey = segments.shift()!
  cursor[finalKey] = value
}

function applySpecialProviderMapping(
  name: string,
  value: ParameterValue,
  providerOptions: Record<string, Record<string, any>>,
  provider?: string | null,
  model?: {
    definition: ParameterDefinition
    modelId?: string | null
    connection?: ModelConnectionInfo | null
  }
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
      providerOptions.anthropic.thinking.type =
        typeof value === 'string' && model
          ? resolveThinkingModeForModel(value, model.definition, model.modelId, model.connection)
          : value
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

/**
 * BL-866: the `thinking.type` a saved Thinking mode becomes for this model. The definition the
 * model's filter picked decides: a saved choice it replaces (Sonnet 5.5's Disabled becomes
 * `between_tools`) is sent as the replacement, and a choice it does not offer is refused, on a
 * lane that sends `providerOptions.anthropic` (the Thinking guard's own lane check: OpenRouter and
 * a direct connection to another service never send it, so nothing there can fail and nothing is
 * refused). A definition with neither rule sends the saved value, as it always has.
 */
function resolveThinkingModeForModel(
  value: string,
  definition: ParameterDefinition,
  modelId?: string | null,
  connection?: ModelConnectionInfo | null
): string {
  const unlisted = sendsAnthropicOptions(connection)
    ? describeUnlistedSelectValue(definition, value, modelId)
    : null
  if (unlisted) {
    throw new AnthropicThinkingRefusedError(
      `${unlisted} Open Settings → Models, edit this model preset, and change it. Batshit does not send a value the model refuses, and does not change it for you.`
    )
  }
  return resolveSavedSelectValue(definition, value)
}

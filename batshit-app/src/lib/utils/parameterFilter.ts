import type { ModelCapabilities, ModelConnectionInfo, ModelPurpose } from '$lib/types/savedModels'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
import { CLAUDE_PLAN_SERVICE } from '$lib/utils/claudePlanConnection'
import { REVIEWED_OPENAI_REASONING_MODELS } from '$lib/data/reviewed-public-reasoning-facts'
import { reviewedReasoningBinding } from '$lib/data/reasoning-controls'
import type { CompatibilityMatrixEntry, MatrixConnectionId } from '$lib/types/compatibilityMatrix'
import {
  getParameterSchema,
  type ParameterDefinition,
  type ParameterValue
} from '$lib/data/parameter-schemas'
import {
  buildMatrixScope,
  isParameterAllowed,
  resolveMatrixFor,
  summarizeMatrixSupport
} from '$lib/utils/compatibilityMatrix'

export interface ParameterFilterArgs {
  provider?: string | null
  modelId?: string | null
  vercelId?: string | null
  capabilities?: ModelCapabilities | null
  connection?: MatrixConnectionId | null
  /** Exact transport identity for model controls whose adapter has been qualified. */
  connectionInfo?: ModelConnectionInfo | null
  /** Saved-value projection retains dormant fields hidden only by the direct adapter control rule. */
  projection?: 'controls' | 'saved'
  purpose?: ModelPurpose | null
  matrixEntries?: CompatibilityMatrixEntry[] | null
}

const LOCAL_PARAMETER_PROVIDERS: ReadonlySet<string> = LOCAL_AI_SERVER_IDS
const DIRECT_ANTHROPIC_INACTIVE_PARAMETERS = new Set(['presencePenalty', 'frequencyPenalty', 'seed'])

/** Local programs own their request parameters even when the model has a separate developer. */
export function resolveParameterProvider(
  provider?: string | null,
  connection?: {
    type?: ModelConnectionInfo['type'] | null
    service?: string | null
  } | null,
): string | null | undefined {
  const service = connection?.service?.trim().toLowerCase()
  // SA-139: the Claude plan has its own short parameter list, whatever the model's developer.
  return connection?.type === 'direct' && service && (LOCAL_PARAMETER_PROVIDERS.has(service) || service === CLAUDE_PLAN_SERVICE)
    ? service
    : provider
}

function normalize(value?: string | null) {
  return value?.toLowerCase().trim() ?? ''
}

const OPENAI_REASONING_UNSUPPORTED_SAMPLING_PARAMETERS = new Set([
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
  'stopSequences'
])

export function isOpenAIReasoningParameterRestrictedModelId(
  modelId?: string | null,
  vercelId?: string | null
) {
  const tokens = [
    normalize(modelId),
    normalize(modelId?.split('/').pop() ?? ''),
    normalize(vercelId),
    normalize(vercelId?.split('/').pop() ?? '')
  ].filter(Boolean)

  return tokens.some((token) => /^gpt-5(?:[.-]|$)/.test(token) || /^o\d(?:[.-]|$)/.test(token))
}

// BL-926: the Claude models for which `@ai-sdk/anthropic` discards temperature, topP and topK (its
// `rejectsSamplingParameters` flag; it reports each only as an SDK warning nobody reads, measured
// on 4.0.67): Claude Opus 5.5 / 5 / 4.8 / 4.7, Sonnet 5.5 / 5, and Fable 5.1 / 5. A saved value
// does nothing and nothing says so, so they are not offered and not sent. The id is the bare model
// id: a vendor prefix is cut and dots become dashes (`anthropic/claude-opus-5.5`), so Anthropic's
// own, a gateway's and a routed id are the same model. Older Claude models (4.6 and before) take
// sampling and are left alone.
const ANTHROPIC_UNSUPPORTED_SAMPLING_PARAMETERS = new Set(['temperature', 'topP', 'topK'])
const ANTHROPIC_SAMPLING_REJECTING_MODEL = /claude-(?:opus-4-[78]|opus-5|sonnet-5|fable-5)(?!\d)/

export function isAnthropicSamplingRejectedModelId(modelId?: string | null, vercelId?: string | null) {
  return [modelId, vercelId].some((id) => {
    const bare = normalize(id?.split('/').pop() ?? '').replace(/\./g, '-')
    return ANTHROPIC_SAMPLING_REJECTING_MODEL.test(bare)
  })
}

export function isParameterSuppressedForModel(
  parameterName: string,
  options: {
    provider?: string | null
    modelId?: string | null
    vercelId?: string | null
  }
) {
  const provider = normalize(options.provider)
  if (provider === 'openai') {
    return (
      OPENAI_REASONING_UNSUPPORTED_SAMPLING_PARAMETERS.has(parameterName) &&
      isOpenAIReasoningParameterRestrictedModelId(options.modelId, options.vercelId)
    )
  }
  if (provider === 'anthropic') {
    return (
      ANTHROPIC_UNSUPPORTED_SAMPLING_PARAMETERS.has(parameterName) &&
      isAnthropicSamplingRejectedModelId(options.modelId, options.vercelId)
    )
  }
  return false
}

function matchesModel(target: string, tokens: string[]) {
  const normalizedTarget = target.toLowerCase().trim()
  if (!normalizedTarget) return false
  const wild = normalizedTarget.endsWith('*')
  const needle = wild ? normalizedTarget.slice(0, -1) : normalizedTarget
  if (!needle) return false

  return tokens.some((token) => {
    if (!token) return false
    return wild ? token.startsWith(needle) : token === needle
  })
}

function definitionApplies(
  definition: ParameterDefinition,
  tokens: string[],
  capabilities?: ModelCapabilities | null,
  provider?: string | null,
  purpose?: ModelPurpose | null,
  connectionInfo?: ModelConnectionInfo | null,
  projection: ParameterFilterArgs['projection'] = 'controls'
) {
  // The installed direct SDK drops these for every model. Do not infer that
  // contract for gateways/custom routes, or erase dormant saved values.
  if (projection !== 'saved' && DIRECT_ANTHROPIC_INACTIVE_PARAMETERS.has(definition.name) &&
    connectionInfo?.type === 'direct' && connectionInfo.service === 'anthropic' &&
    (!connectionInfo.id || connectionInfo.id === 'direct:anthropic')) return false
  const reviewedModel = REVIEWED_OPENAI_REASONING_MODELS.find(id => tokens.includes(id))
  if (reviewedModel && (definition.name === 'reasoningEffort' || definition.name === 'reasoningSummary') &&
    !reviewedReasoningBinding({ modelId: reviewedModel, connection: connectionInfo })) return false
  if (definition.reviewedReasoningControl && !tokens.some(modelId => reviewedReasoningBinding({ modelId, connection: connectionInfo })?.controls.some(control => control.setting === definition.name))) return false
  if (definition.roles?.length) {
    if (!purpose || !definition.roles.includes(purpose)) {
      return false
    }
  }

  if (definition.excludeRoles?.length && purpose) {
    if (definition.excludeRoles.includes(purpose)) {
      return false
    }
  }

  if (definition.onlyProviders?.length) {
    const normalizedProvider = normalize(provider)
    if (!definition.onlyProviders.some((entry) => normalize(entry) === normalizedProvider)) {
      return false
    }
  }

  if (definition.excludeProviders?.length) {
    const normalizedProvider = normalize(provider)
    if (definition.excludeProviders.some((entry) => normalize(entry) === normalizedProvider)) {
      return false
    }
  }

  if (definition.onlyModels?.length) {
    const matches = definition.onlyModels.some((model) => matchesModel(model, tokens))
    if (!matches) return false
  }

  if (definition.excludeModels?.length) {
    const excluded = definition.excludeModels.some((model) => matchesModel(model, tokens))
    if (excluded) return false
  }

  if (definition.requiresCapability) {
    if (!capabilities || capabilities[definition.requiresCapability] !== true) {
      return false
    }
  }

  return true
}

export function filterParameters({
  provider,
  modelId,
  vercelId,
  capabilities,
  connection,
  connectionInfo,
  projection,
  purpose,
  matrixEntries
}: ParameterFilterArgs): ParameterDefinition[] {
  const resolvedPurpose = purpose ?? 'chat'
  const tokens = Array.from(
    new Set(
      [
        normalize(modelId),
        normalize(modelId?.split('/').pop() ?? ''),
        normalize(vercelId),
        normalize(vercelId?.split('/').pop() ?? '')
      ].filter(Boolean)
    )
  )

  const schema = getParameterSchema(provider ?? undefined)
  const matrixSupport =
    connection && matrixEntries?.length
      ? summarizeMatrixSupport(
          resolveMatrixFor(
            matrixEntries,
            buildMatrixScope({
              connection,
              provider: provider ?? undefined,
              model: modelId ?? vercelId ?? undefined
            })
          )
        )
      : null
  const deduped = new Map<string, ParameterDefinition>()
  // Add only the reviewed H2 controls; inherited developer/custom parameter ownership stays unchanged.
  const nativeService = connectionInfo?.type === 'direct' && ['mimo', 'qwencloud'].includes(connectionInfo.service ?? '') ? connectionInfo.service : null
  const nativeSchema = nativeService && nativeService !== provider ? getParameterSchema(nativeService) : null

  for (const definition of schema.base) {
    if (definitionApplies(definition, tokens, capabilities, provider, resolvedPurpose, connectionInfo, projection)) {
      if (isParameterSuppressedForModel(definition.name, { provider, modelId, vercelId })) {
        continue
      }
      if (matrixSupport && !isParameterAllowed(definition.name, matrixSupport)) {
        continue
      }
      deduped.set(definition.name, definition)
    }
  }

  for (const overridesByModel of [schema.modelOverrides, nativeSchema?.modelOverrides]) {
    if (!overridesByModel || tokens.length === 0) continue
    for (const [modelKey, overrides] of Object.entries(overridesByModel)) {
      if (!matchesModel(modelKey, tokens)) continue
      overrides.forEach((definition) => {
        if (definitionApplies(definition, tokens, capabilities, provider, resolvedPurpose, connectionInfo, projection)) {
          if (isParameterSuppressedForModel(definition.name, { provider, modelId, vercelId })) return
          if (matrixSupport && !isParameterAllowed(definition.name, matrixSupport)) return
          deduped.set(definition.name, definition)
        }
      })
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const left = a.order ?? 999
    const right = b.order ?? 999
    if (left === right) return a.label.localeCompare(b.label)
    return left - right
  })
}

export function buildDefaultParameterValues(definitions: ParameterDefinition[]) {
  return definitions.reduce<Record<string, ParameterValue | undefined>>((acc, definition) => {
    if (definition.defaultValue !== undefined) {
      acc[definition.name] = definition.defaultValue
    }
    return acc
  }, {})
}

export type ParameterFilter = typeof filterParameters

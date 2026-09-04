import type { ModelCapabilities, ModelConnectionInfo, ModelPurpose } from '$lib/types/savedModels'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
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
  purpose?: ModelPurpose | null
  matrixEntries?: CompatibilityMatrixEntry[] | null
}

const LOCAL_PARAMETER_PROVIDERS: ReadonlySet<string> = LOCAL_AI_SERVER_IDS

/** Local programs own their request parameters even when the model has a separate developer. */
export function resolveParameterProvider(
  provider?: string | null,
  connection?: {
    type?: ModelConnectionInfo['type'] | null
    service?: string | null
  } | null,
): string | null | undefined {
  const service = connection?.service?.trim().toLowerCase()
  return connection?.type === 'direct' && service && LOCAL_PARAMETER_PROVIDERS.has(service)
    ? service
    : provider
}

export function isParameterSupportedInN8N(
  definition: ParameterDefinition,
  options?: {
    provider?: string | null
    model?: string | null
    matrixEntries?: CompatibilityMatrixEntry[] | null
  }
): boolean {
  if (options?.matrixEntries?.length) {
    const scope = buildMatrixScope({
      connection: 'n8n',
      provider: options.provider ?? undefined,
      model: options.model ?? undefined
    })
    const support = summarizeMatrixSupport(resolveMatrixFor(options.matrixEntries, scope))
    if (support.hasAllow || support.deny.size > 0) {
      return isParameterAllowed(definition.name, support)
    }
  }
  if (typeof definition.n8nSupported === 'boolean') {
    return definition.n8nSupported
  }
  return Boolean(definition.standardKey)
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

export function isParameterSuppressedForModel(
  parameterName: string,
  options: {
    provider?: string | null
    modelId?: string | null
    vercelId?: string | null
  }
) {
  if (!OPENAI_REASONING_UNSUPPORTED_SAMPLING_PARAMETERS.has(parameterName)) return false
  if (normalize(options.provider) !== 'openai') return false
  return isOpenAIReasoningParameterRestrictedModelId(options.modelId, options.vercelId)
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
  purpose?: ModelPurpose | null
) {
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

  for (const definition of schema.base) {
    if (definitionApplies(definition, tokens, capabilities, provider, resolvedPurpose)) {
      if (isParameterSuppressedForModel(definition.name, { provider, modelId, vercelId })) {
        continue
      }
      if (matrixSupport && !isParameterAllowed(definition.name, matrixSupport)) {
        continue
      }
      deduped.set(definition.name, definition)
    }
  }

  if (schema.modelOverrides && tokens.length > 0) {
    for (const [modelKey, overrides] of Object.entries(schema.modelOverrides)) {
      if (!matchesModel(modelKey, tokens)) continue
      overrides.forEach((definition) => {
        if (definitionApplies(definition, tokens, capabilities, provider, resolvedPurpose)) {
          if (isParameterSuppressedForModel(definition.name, { provider, modelId, vercelId })) {
            return
          }
          if (matrixSupport && !isParameterAllowed(definition.name, matrixSupport)) {
            return
          }
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

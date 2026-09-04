import type { ModelCapabilities, ModelConnectionInfo, ModelPurpose } from '$lib/types/savedModels'
import type { ParameterDefinition, ParameterValue } from '$lib/data/parameter-schemas'
import type { ProviderFeatures } from './providers'
import { filterParameters, isParameterSuppressedForModel, resolveParameterProvider } from '$lib/utils/parameterFilter'

const CLI_SETTING_PREFIXES = ['codex_']

export function providerFeaturesToCapabilities(
  features?: ProviderFeatures
): ModelCapabilities | undefined {
  if (!features) return undefined
  const capabilities: ModelCapabilities = {}

  if (features.streaming) capabilities.streaming = true
  if (features.tools) capabilities.tools = true
  if (features.vision) capabilities.vision = true
  if (features.reasoning) capabilities.reasoning = true
  if (features.cacheControl) capabilities.cacheControl = true
  if (features.longContext) capabilities.longContext = true
  if (features.code) capabilities.code = true
  if (features.fast) capabilities.fast = true

  return Object.keys(capabilities).length ? capabilities : undefined
}

export function mergeCapabilities(
  base?: ModelCapabilities,
  override?: ModelCapabilities
): ModelCapabilities | undefined {
  if (!base && !override) return undefined
  const merged: ModelCapabilities = { ...(base ?? {}) }

  if (override) {
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue
      merged[key as keyof ModelCapabilities] = value
    }
  }

  return Object.keys(merged).length ? merged : undefined
}

function coerceSettingValue(definition: ParameterDefinition, value: unknown): ParameterValue | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  switch (definition.inputType) {
    case 'boolean':
      return Boolean(value)
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'integer': {
      const parsed = typeof value === 'number' ? Math.trunc(value) : parseInt(String(value), 10)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'string-array': {
      if (Array.isArray(value)) {
        const items = value.map((entry) => String(entry).trim()).filter(Boolean)
        return items.length ? items : undefined
      }
      if (typeof value === 'string') {
        const delimiter = definition.arrayDelimiter === 'comma' ? /[,;]/ : /\r?\n/
        const items = value
          .split(delimiter)
          .map((entry) => entry.trim())
          .filter(Boolean)
        return items.length ? items : undefined
      }
      return undefined
    }
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return undefined
        }
      }
      return value as Record<string, unknown>
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

export function normaliseModelSettings(options: {
  settings?: Record<string, unknown> | null
  provider?: string | null
  connection?: ModelConnectionInfo | null
  modelId?: string | null
  vercelId?: string | null
  capabilities?: ModelCapabilities | null
  purpose?: ModelPurpose | null
}) {
  if (!options.settings) return undefined
  const parameterProvider = resolveParameterProvider(options.provider, options.connection)

  const extraSettings: Record<string, ParameterValue> = {}
  for (const [key, value] of Object.entries(options.settings)) {
    if (CLI_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      if (value !== undefined) {
        extraSettings[key] = value as ParameterValue
      }
    }
  }

  const definitions = filterParameters({
    provider: parameterProvider ?? undefined,
    modelId: options.modelId ?? undefined,
    vercelId: options.vercelId ?? undefined,
    capabilities: options.capabilities ?? null,
    purpose: options.purpose ?? 'chat'
  })
  const knownKeys = new Set(definitions.map((definition) => definition.name))

  if (!definitions.length) {
    const customSettings = Object.fromEntries(
      Object.entries(options.settings).filter(([key, value]) => {
        if (CLI_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) return false
        return value !== undefined
      })
    ) as Record<string, ParameterValue>
    const merged = { ...extraSettings, ...customSettings }
    return Object.keys(merged).length ? merged : undefined
  }

  const normalised: Record<string, ParameterValue> = {}
  for (const definition of definitions) {
    if (!(definition.name in options.settings!)) continue
    const coerced = coerceSettingValue(definition, options.settings![definition.name])
    if (coerced !== undefined) {
      normalised[definition.name] = coerced
    }
  }

  const customSettings: Record<string, ParameterValue> = {}
  for (const [key, value] of Object.entries(options.settings)) {
    if (CLI_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    if (knownKeys.has(key)) continue
    if (
      isParameterSuppressedForModel(key, {
        provider: parameterProvider,
        modelId: options.modelId,
        vercelId: options.vercelId
      })
    ) {
      continue
    }
    if (value !== undefined) {
      customSettings[key] = value as ParameterValue
    }
  }

  const merged = { ...extraSettings, ...normalised, ...customSettings }
  return Object.keys(merged).length ? merged : undefined
}

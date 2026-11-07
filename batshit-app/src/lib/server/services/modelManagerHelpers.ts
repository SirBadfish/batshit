import type { ModelCapabilities, ModelConnectionInfo, ModelPurpose, SavedModel } from '$lib/types/savedModels'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import { inferModelPurpose } from '$lib/utils/modelPurpose'
import { validateModelPresetCopyChanges, isPresetParameterFact, type ModelPresetCopyChanges, type ModelPresetCopyReview, type PresetParameterValue } from '$lib/appActions/settings/modelSelectionPreferences'
import type { ParameterDefinition, ParameterValue } from '$lib/data/parameter-schemas'
import type { ProviderFeatures } from './providers'
import { filterParameters, isParameterSuppressedForModel, resolveParameterProvider } from '$lib/utils/parameterFilter'

/** Shared pure human-create identity. Supplying it to HTTP POST still means update. */
export function buildModelPresetId(options: { displayName?: string; modelId?: string; provider?: string; connection?: ModelConnectionInfo | null }): string {
  const displayName = options.displayName?.trim() || '', modelId = options.modelId?.trim() || '', provider = options.provider?.trim() || ''
  const connection = options.connection ?? null
  const namePart = sanitizeId(displayName || modelId)
  const identityPart = sanitizeId([provider, modelId, connection?.type || '', connection?.service || ''].filter(Boolean).join('_'))
  return namePart && identityPart && namePart !== identityPart ? `${namePart}_${identityPart}` : namePart || identityPart
}
export function presetCopyParameters(source: SavedModel): ParameterDefinition[] {
  return filterParameters({ provider: resolveParameterProvider(source.provider, source.connection), modelId: source.modelId,
    vercelId: source.catalogModelId ?? source.vercelSourceId, capabilities: source.capabilities, connectionInfo: source.connection, purpose: source.purpose ?? 'chat' })
    .filter(field => !isAgentRuntimeSettingKey(field.name) && !['json', 'sampler-order'].includes(field.inputType))
}
/** A12 validates new intent strictly; it never runs permissive whole-source normalization. */
export function planModelPresetCopy(source: SavedModel, changes: ModelPresetCopyChanges, planId: string) {
  validateModelPresetCopyChanges(changes)
  const purpose = source.purpose ?? inferModelPurpose({ id: source.catalogModelId ?? `${source.provider}/${source.modelId}`, name: source.modelId ?? source.modelName })
  if (source.id !== changes.sourcePresetId || purpose !== 'chat' || source.voiceSession) throw new Error('preset_copy_source_unavailable')
  const definitions = presetCopyParameters(source)
  const candidate = structuredClone(source)
  candidate.id = buildModelPresetId({ displayName: changes.copyName, modelId: source.modelId, provider: source.provider, connection: source.connection })
  if (!candidate.id || candidate.id === source.id) throw new Error('preset_copy_identity_conflict')
  candidate.modelName = changes.copyName
  candidate.settings = structuredClone(source.settings ?? {})
  delete candidate.unavailableReason; delete candidate.reasoningEvidence
  const review: ModelPresetCopyReview = { planId, sourcePresetId: source.id, copyPresetId: candidate.id, copyName: changes.copyName, parameters: [] }
  for (const edit of changes.parameters) {
    const definition = definitions.find(field => field.name === edit.name)
    if (!definition) throw new Error('preset_parameter_unsupported')
    if (edit.op === 'set') {
      const value = edit.value
      const valid = definition.booleanTriState ? typeof value === 'boolean' : definition.inputType === 'boolean' ? typeof value === 'boolean' :
        definition.inputType === 'number' || definition.inputType === 'integer' ? typeof value === 'number' && Number.isFinite(value) &&
          (definition.inputType !== 'integer' || Number.isSafeInteger(value)) && (definition.min === undefined || value >= definition.min) && (definition.max === undefined || value <= definition.max) :
          definition.inputType === 'string-array' ? Array.isArray(value) && value.every(item => typeof item === 'string') :
            typeof value === 'string' && (definition.inputType !== 'select' || !!definition.options?.some(option => option.value !== '' && option.value === value))
      if (!valid) throw new Error('preset_parameter_value_unsupported')
    }
    const before = Object.hasOwn(candidate.settings, edit.name) ? candidate.settings[edit.name] === null ? { state: 'null' as const }
      : { state: 'set' as const, value: candidate.settings[edit.name] as PresetParameterValue } : { state: 'unset' as const }
    if (!isPresetParameterFact(before)) throw new Error('preset_parameter_original_value_unavailable')
    if (edit.op === 'unset') delete candidate.settings[edit.name]
    else candidate.settings[edit.name] = structuredClone(edit.value)
    review.parameters.push({ name: edit.name, label: definition.label, before, after: edit.op === 'unset' ? { state: 'unset' } : { state: 'set', value: structuredClone(edit.value) } })
  }
  if (source.settings == null && changes.parameters.every(edit => edit.op === 'unset')) {
    if (Object.hasOwn(source, 'settings')) candidate.settings = source.settings
    else delete candidate.settings
  }
  return { candidate, review }
}

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

  const definitions = filterParameters({
    provider: parameterProvider ?? undefined,
    modelId: options.modelId ?? undefined,
    vercelId: options.vercelId ?? undefined,
    capabilities: options.capabilities ?? null,
    connectionInfo: options.connection,
    purpose: options.purpose ?? 'chat'
  })
  const knownKeys = new Set(definitions.map((definition) => definition.name))

  if (!definitions.length) {
    const customSettings = Object.fromEntries(
      Object.entries(options.settings).filter(([, value]) => value !== undefined)
    ) as Record<string, ParameterValue>
    return Object.keys(customSettings).length ? customSettings : undefined
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

  const merged = { ...normalised, ...customSettings }
  return Object.keys(merged).length ? merged : undefined
}

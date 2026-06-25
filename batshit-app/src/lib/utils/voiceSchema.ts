import type {
  AgentVoiceProfile,
  GoonLipSyncMode,
  GoonLipSyncPremiumAnalyzerId,
  VoiceByoAuthMode,
  VoiceByoProviderConfig,
  VoiceEngineSttDefaults,
  VoiceEngineTtsDefaults,
  VoiceEngineUiField,
  VoiceEngineUiSchema,
  VoiceEngineUiSection,
  VoiceItalicNarrationBehavior,
  VoiceModeInputMode,
  VoiceModeSubmitMode,
  VoiceSessionRuntime,
  VoiceModeTurnSettings,
  VoiceProviderId,
  VoiceProviderOptionBlock,
  VoiceProviderOptionValue,
  VoiceProviderOptionsMap,
  VoiceSettings,
  VoiceSttEngineSettings,
  VoiceSttConfig,
  VoiceTtsEngineSettings,
  VoiceTtsConfig
} from '$lib/types/voice'
import {
  DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER,
  normalizePremiumGoonLipSyncAnalyzerId
} from '$lib/goons/lipSyncLab'
import { normalizeGoonLipSyncVisemeBlendMs } from '$lib/utils/goonLipSync'

const BUILTIN_PROVIDER_IDS: VoiceProviderId[] = [
  'browser',
  'google',
  'openai',
  'elevenlabs',
  'deepgram',
  'fish',
  'mistral',
  'minimax',
  'mimo',
  'alibaba',
  'inworld',
  'cartesia',
  'async',
  'stepfun',
  'azure'
]

const VALID_PROVIDER_ID_SET = new Set<string>(BUILTIN_PROVIDER_IDS)
const DEFAULT_LEGACY_BYO_PROVIDER_ID = 'legacy'
const DEFAULT_LEGACY_BYO_PROVIDER_NAME = 'Legacy BYO Provider'
export const DEFAULT_VOICE_MODE_INPUT_MODE: VoiceModeInputMode = 'stt'
export const DEFAULT_VOICE_MODE_SUBMIT_MODE: VoiceModeSubmitMode = 'auto'
export const DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS = 1000
export const MIN_VOICE_MODE_AUTO_SUBMIT_DELAY_MS = 500
export const MAX_VOICE_MODE_AUTO_SUBMIT_DELAY_MS = 5000
export const DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD = 0.7
export const MIN_VOICE_MODE_END_OF_TURN_THRESHOLD = 0.5
export const MAX_VOICE_MODE_END_OF_TURN_THRESHOLD = 0.9
export const DEFAULT_TTS_ITALIC_NARRATION_BEHAVIOR: VoiceItalicNarrationBehavior = 'speak'
export const MAX_TTS_ENGINE_PROMPT_CHARS = 4000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeClampedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  options: { integer?: boolean } = {}
): number {
  const parsed = normalizeNumber(value)
  const normalized = parsed === undefined ? fallback : parsed
  const clamped = Math.min(Math.max(normalized, min), max)
  return options.integer ? Math.round(clamped) : clamped
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeGoonLipSyncMode(value: unknown): GoonLipSyncMode {
  return value === 'viseme' ? 'viseme' : 'amplitude'
}

function normalizeGoonLipSyncAnalyzerId(value: unknown): GoonLipSyncPremiumAnalyzerId {
  return normalizePremiumGoonLipSyncAnalyzerId(value)
}

function normalizeVoiceModeSubmitMode(value: unknown): VoiceModeSubmitMode {
  return value === 'manual' ? 'manual' : DEFAULT_VOICE_MODE_SUBMIT_MODE
}

function normalizeVoiceModeInputMode(value: unknown): VoiceModeInputMode {
  return value === 'text' ? 'text' : DEFAULT_VOICE_MODE_INPUT_MODE
}

function normalizeOptionalVoiceModeInputMode(value: unknown): VoiceModeInputMode | undefined {
  if (value === 'stt' || value === 'text') return value
  return undefined
}

export function normalizeVoiceModeTurnSettings(value: unknown): VoiceModeTurnSettings {
  const source = isObject(value) ? value : {}
  return {
    inputMode: normalizeVoiceModeInputMode(source.inputMode ?? source.input ?? source.inputType),
    submitMode: normalizeVoiceModeSubmitMode(source.submitMode ?? source.mode),
    autoSubmitDelayMs: normalizeClampedNumber(
      source.autoSubmitDelayMs ?? source.pauseBeforeSendMs ?? source.eotTimeoutMs,
      DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
      MIN_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
      MAX_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
      { integer: true }
    ),
    endOfTurnThreshold: normalizeClampedNumber(
      source.endOfTurnThreshold ?? source.eotThreshold,
      DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD,
      MIN_VOICE_MODE_END_OF_TURN_THRESHOLD,
      MAX_VOICE_MODE_END_OF_TURN_THRESHOLD
    )
  }
}

export function normalizeVoiceSessionRuntime(value: unknown): VoiceSessionRuntime {
  return value === 'livekit' ? 'livekit' : 'direct'
}

function normalizeOptionalVoiceSessionRuntime(value: unknown): VoiceSessionRuntime | undefined {
  if (value === 'direct' || value === 'livekit') return value
  return undefined
}

export function normalizeVoiceItalicNarrationBehavior(
  value: unknown
): VoiceItalicNarrationBehavior {
  return value === 'silent' ? 'silent' : DEFAULT_TTS_ITALIC_NARRATION_BEHAVIOR
}

function normalizeVoiceTtsNarrationSettings(value: unknown): VoiceTtsConfig['narration'] | undefined {
  const source = isObject(value) ? value : {}
  const rawItalicBehavior = source.italicBehavior ?? source.italics ?? source.italicNarration
  if (rawItalicBehavior === undefined) return undefined
  const italicBehavior = normalizeVoiceItalicNarrationBehavior(rawItalicBehavior)

  return {
    italicBehavior
  }
}

function normalizeVoiceRuntimes(value: unknown): VoiceSettings['voiceRuntimes'] | undefined {
  if (!isObject(value)) return undefined

  const livekitSource = isObject(value.livekit) ? value.livekit : {}
  const startupSource = isObject(livekitSource.startup) ? livekitSource.startup : {}
  const autoStartOnLaunch = normalizeBoolean(startupSource.autoStartOnLaunch)

  if (autoStartOnLaunch === undefined) return undefined

  return {
    livekit: {
      startup: {
        autoStartOnLaunch
      }
    }
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry))
  return normalized.length > 0 ? normalized : undefined
}

function normalizeByoAuthMode(value: unknown): VoiceByoAuthMode | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'none' || normalized === 'bearer' || normalized === 'header') {
    return normalized
  }
  return undefined
}

function normalizeByoProviderKey(value: unknown): string | undefined {
  const normalized = normalizeString(value)?.toLowerCase()
  if (!normalized) return undefined
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) return undefined
  return normalized
}

function normalizeProviderOptionBlock(value: unknown): VoiceProviderOptionBlock | undefined {
  if (!isObject(value)) return undefined
  const block: VoiceProviderOptionBlock = {}
  for (const [key, rawValue] of Object.entries(value)) {
    const normalized = normalizeOptionValue(rawValue)
    if (normalized === undefined) continue
    block[key] = normalized
  }
  return Object.keys(block).length > 0 ? block : undefined
}

function normalizeByoUiField(value: unknown): VoiceEngineUiField | undefined {
  if (!isObject(value)) return undefined
  const id = normalizeString(value.id)
  const label = normalizeString(value.label)
  const type = normalizeString(value.type)?.toLowerCase()
  if (!id || !label || !type) return undefined
  if (!['string', 'number', 'boolean', 'select', 'textarea'].includes(type)) return undefined

  const options = Array.isArray(value.options)
    ? value.options
        .map((option) => {
          if (!isObject(option)) return undefined
          const optionLabel = normalizeString(option.label)
          const optionValue = option.value
          const normalizedOptionValue =
            optionValue === null
              ? null
              : normalizeOptionValue(optionValue)
          if (!optionLabel || normalizedOptionValue === undefined) return undefined
          return { label: optionLabel, value: normalizedOptionValue }
        })
        .filter((option): option is { label: string; value: string | number | boolean | null } =>
          Boolean(option)
        )
    : undefined

  const field: VoiceEngineUiField = {
    id,
    type: type as VoiceEngineUiField['type'],
    label
  }

  const path = normalizeString(value.path)
  if (path) field.path = path
  const help = normalizeString(value.help)
  if (help) field.help = help
  const placeholder = normalizeString(value.placeholder)
  if (placeholder) field.placeholder = placeholder
  const required = normalizeBoolean(value.required)
  if (required !== undefined) field.required = required

  const defaultValue = normalizeOptionValue(value.defaultValue)
  if (defaultValue !== undefined) field.defaultValue = defaultValue

  const min = normalizeNumber(value.min)
  if (min !== undefined) field.min = min
  const max = normalizeNumber(value.max)
  if (max !== undefined) field.max = max
  const step = normalizeNumber(value.step)
  if (step !== undefined) field.step = step
  if (options && options.length > 0) field.options = options

  return field
}

function normalizeByoUiSection(value: unknown): VoiceEngineUiSection | undefined {
  if (!isObject(value)) return undefined
  const id = normalizeString(value.id)
  const title = normalizeString(value.title)
  if (!id || !title) return undefined

  const fields = Array.isArray(value.fields)
    ? value.fields
        .map((field) => normalizeByoUiField(field))
        .filter((field): field is VoiceEngineUiField => Boolean(field))
    : []

  if (fields.length === 0) return undefined

  const section: VoiceEngineUiSection = {
    id,
    title,
    fields
  }

  const description = normalizeString(value.description)
  if (description) section.description = description

  return section
}

function normalizeByoUiSchema(value: unknown): VoiceEngineUiSchema | undefined {
  if (!isObject(value)) return undefined

  const sections = Array.isArray(value.sections)
    ? value.sections
        .map((section) => normalizeByoUiSection(section))
        .filter((section): section is VoiceEngineUiSection => Boolean(section))
    : undefined

  const fields = Array.isArray(value.fields)
    ? value.fields
        .map((field) => normalizeByoUiField(field))
        .filter((field): field is VoiceEngineUiField => Boolean(field))
    : undefined

  if ((!sections || sections.length === 0) && (!fields || fields.length === 0)) {
    return undefined
  }

  const schema: VoiceEngineUiSchema = {}
  const panelTitle = normalizeString(value.panelTitle)
  if (panelTitle) schema.panelTitle = panelTitle
  if (sections && sections.length > 0) schema.sections = sections
  if (fields && fields.length > 0) schema.fields = fields
  return schema
}

function normalizeByoTtsDefaults(value: unknown): VoiceEngineTtsDefaults | undefined {
  if (!isObject(value)) return undefined

  const commonSource = isObject(value.common) ? value.common : {}
  const common = {
    speed: normalizeNumber(commonSource.speed),
    volume: normalizeNumber(commonSource.volume),
    language: normalizeString(commonSource.language),
    instructions: normalizeString(commonSource.instructions)
  }

  const providerOptions = normalizeProviderOptionBlock(value.providerOptions)
  const normalized: VoiceEngineTtsDefaults = {}

  if (common.speed !== undefined || common.volume !== undefined || common.language || common.instructions) {
    normalized.common = {
      ...(common.speed !== undefined ? { speed: common.speed } : {}),
      ...(common.volume !== undefined ? { volume: common.volume } : {}),
      ...(common.language ? { language: common.language } : {}),
      ...(common.instructions ? { instructions: common.instructions } : {})
    }
  }

  if (providerOptions) {
    normalized.providerOptions = providerOptions
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeByoSttDefaults(value: unknown): VoiceEngineSttDefaults | undefined {
  if (!isObject(value)) return undefined
  const language = normalizeString(value.language)
  const providerOptions = normalizeProviderOptionBlock(value.providerOptions)

  const normalized: VoiceEngineSttDefaults = {}
  if (language) normalized.language = language
  if (providerOptions) normalized.providerOptions = providerOptions
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeByoProviderConfig(
  value: unknown,
  defaults?: { id?: string; name?: string }
): VoiceByoProviderConfig | undefined {
  if (!isObject(value)) return undefined

  const id = normalizeByoProviderKey(value.id) ?? normalizeByoProviderKey(defaults?.id)
  const name = normalizeString(value.name) ?? normalizeString(defaults?.name)
  if (!id || !name) return undefined

  const timeoutRaw = normalizeNumber(value.timeoutMs)
  const timeoutMs =
    timeoutRaw !== undefined
      ? Math.min(Math.max(Math.floor(timeoutRaw), 500), 120_000)
      : undefined

  const enabled = normalizeBoolean(value.enabled)
  const supportsTts = normalizeBoolean(value.supportsTts)
  const supportsStt = normalizeBoolean(value.supportsStt)
  const supportsClone = normalizeBoolean(value.supportsClone)
  const tags = normalizeStringArray(value.tags)
  const ttsDefaults = normalizeByoTtsDefaults(value.ttsDefaults)
  const sttDefaults = normalizeByoSttDefaults(value.sttDefaults)
  const uiSchema = normalizeByoUiSchema(value.uiSchema)

  const normalized: VoiceByoProviderConfig = {
    id,
    name,
    enabled,
    supportsTts,
    supportsStt,
    supportsClone,
    adapterId: normalizeString(value.adapterId),
    endpointId: normalizeString(value.endpointId),
    baseUrl: normalizeString(value.baseUrl),
    ttsPath: normalizeString(value.ttsPath),
    sttPath: normalizeString(value.sttPath),
    healthPath: normalizeString(value.healthPath),
    authMode: normalizeByoAuthMode(value.authMode),
    authHeader: normalizeString(value.authHeader),
    authToken: normalizeString(value.authToken),
    timeoutMs,
    tags,
    ttsDefaults,
    sttDefaults,
    uiSchema
  }

  return normalized
}

function normalizeByoProviders(value: unknown): VoiceByoProviderConfig[] | undefined {
  if (!Array.isArray(value)) return undefined

  const deduped = new Map<string, VoiceByoProviderConfig>()
  for (const entry of value) {
    const normalized = normalizeByoProviderConfig(entry)
    if (!normalized) continue
    deduped.set(normalized.id, normalized)
  }

  return deduped.size > 0 ? Array.from(deduped.values()) : undefined
}

function normalizeLegacyByoProvider(value: unknown): VoiceByoProviderConfig | undefined {
  return normalizeByoProviderConfig(value, {
    id: DEFAULT_LEGACY_BYO_PROVIDER_ID,
    name: DEFAULT_LEGACY_BYO_PROVIDER_NAME
  })
}

function normalizeOptionValue(value: unknown): VoiceProviderOptionValue | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'boolean') {
    return value
  }
  return undefined
}

export function normalizeVoiceProviderId(value: unknown): VoiceProviderId | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined

  if (normalized === 'webapi') return 'browser'
  if (normalized === 'gemini') return 'google'

  if (normalized.startsWith('local:') && normalized.length > 'local:'.length) {
    return normalized as VoiceProviderId
  }

  if (normalized.startsWith('byo:') && normalized.length > 'byo:'.length) {
    return normalized as VoiceProviderId
  }

  if (VALID_PROVIDER_ID_SET.has(normalized)) {
    return normalized as VoiceProviderId
  }

  return undefined
}

function normalizeProviderOptionsMap(value: unknown): VoiceProviderOptionsMap | undefined {
  if (!isObject(value)) return undefined

  const output: VoiceProviderOptionsMap = {}

  for (const [provider, rawBlock] of Object.entries(value)) {
    if (!isObject(rawBlock)) continue
    const block: VoiceProviderOptionBlock = {}

    for (const [key, rawValue] of Object.entries(rawBlock)) {
      const normalized = normalizeOptionValue(rawValue)
      if (normalized === undefined) continue
      block[key] = normalized
    }

    if (Object.keys(block).length > 0) {
      output[provider] = block
    }
  }

  return Object.keys(output).length > 0 ? output : undefined
}

export function normalizeTtsEnginePromptText(value: unknown): string | undefined {
  const normalized = normalizeString(value)
  if (!normalized) return undefined
  return normalized.slice(0, MAX_TTS_ENGINE_PROMPT_CHARS)
}

function normalizeTtsEnginePrompts(value: unknown): VoiceSettings['ttsEnginePrompts'] | undefined {
  if (!isObject(value)) return undefined

  const output: NonNullable<VoiceSettings['ttsEnginePrompts']> = {}
  for (const [rawProviderId, rawPromptConfig] of Object.entries(value)) {
    const providerId = normalizeVoiceProviderId(rawProviderId)
    if (!providerId) continue

    const prompt = isObject(rawPromptConfig)
      ? normalizeTtsEnginePromptText(rawPromptConfig.prompt)
      : normalizeTtsEnginePromptText(rawPromptConfig)
    if (!prompt) continue

    output[providerId] = { prompt }
  }

  return Object.keys(output).length > 0 ? output : undefined
}

function normalizeTtsEngineSettings(value: unknown): VoiceSettings['ttsEngineSettings'] | undefined {
  if (!isObject(value)) return undefined

  const output: NonNullable<VoiceSettings['ttsEngineSettings']> = {}
  for (const [rawProviderId, rawConfig] of Object.entries(value)) {
    const providerId = normalizeVoiceProviderId(rawProviderId)
    if (!providerId || !isObject(rawConfig)) continue

    const common = normalizeByoTtsDefaults({ common: rawConfig.common })?.common
    const providerOptions = normalizeProviderOptionBlock(rawConfig.providerOptions)
    const settings: VoiceTtsEngineSettings = {}
    if (common) settings.common = common
    if (providerOptions) settings.providerOptions = providerOptions
    if (Object.keys(settings).length > 0) {
      output[providerId] = settings
    }
  }

  return Object.keys(output).length > 0 ? output : undefined
}

function normalizeSttEngineSettings(value: unknown): VoiceSettings['sttEngineSettings'] | undefined {
  if (!isObject(value)) return undefined

  const output: NonNullable<VoiceSettings['sttEngineSettings']> = {}
  for (const [rawProviderId, rawConfig] of Object.entries(value)) {
    const providerId = normalizeVoiceProviderId(rawProviderId)
    if (!providerId || !isObject(rawConfig)) continue

    const language = normalizeString(rawConfig.language)
    const providerOptions = normalizeProviderOptionBlock(rawConfig.providerOptions)
    const settings: VoiceSttEngineSettings = {}
    if (language) settings.language = language
    if (providerOptions) settings.providerOptions = providerOptions
    if (Object.keys(settings).length > 0) {
      output[providerId] = settings
    }
  }

  return Object.keys(output).length > 0 ? output : undefined
}

function mergeTtsEngineSettings(
  ...sources: Array<VoiceSettings['ttsEngineSettings'] | undefined>
): VoiceSettings['ttsEngineSettings'] | undefined {
  const output: NonNullable<VoiceSettings['ttsEngineSettings']> = {}
  for (const source of sources) {
    if (!source) continue
    for (const [providerId, settings] of Object.entries(source)) {
      const existing = output[providerId] ?? {}
      output[providerId] = {
        ...(existing.common || settings.common
          ? { common: { ...(existing.common ?? {}), ...(settings.common ?? {}) } }
          : {}),
        ...(existing.providerOptions || settings.providerOptions
          ? {
              providerOptions: {
                ...(existing.providerOptions ?? {}),
                ...(settings.providerOptions ?? {})
              }
            }
          : {})
      }
    }
  }

  return Object.keys(output).length > 0 ? output : undefined
}

function mergeSttEngineSettings(
  ...sources: Array<VoiceSettings['sttEngineSettings'] | undefined>
): VoiceSettings['sttEngineSettings'] | undefined {
  const output: NonNullable<VoiceSettings['sttEngineSettings']> = {}
  for (const source of sources) {
    if (!source) continue
    for (const [providerId, settings] of Object.entries(source)) {
      const existing = output[providerId] ?? {}
      output[providerId] = {
        ...(existing.language || settings.language
          ? { language: settings.language ?? existing.language }
          : {}),
        ...(existing.providerOptions || settings.providerOptions
          ? {
              providerOptions: {
                ...(existing.providerOptions ?? {}),
                ...(settings.providerOptions ?? {})
              }
            }
          : {})
      }
    }
  }

  return Object.keys(output).length > 0 ? output : undefined
}

function legacyTtsConfigToEngineSettings(
  tts: VoiceTtsConfig | undefined
): VoiceSettings['ttsEngineSettings'] | undefined {
  const providerId = tts?.providerId
  if (!providerId) return undefined
  const providerOptions = getProviderOptionsFor(tts.providerOptions, providerId)
  if (!tts.common && !providerOptions) return undefined
  return {
    [providerId]: {
      ...(tts.common ? { common: tts.common } : {}),
      ...(providerOptions ? { providerOptions } : {})
    }
  }
}

function legacySttConfigToEngineSettings(
  ...configs: Array<VoiceSttConfig | undefined>
): VoiceSettings['sttEngineSettings'] | undefined {
  const output: NonNullable<VoiceSettings['sttEngineSettings']> = {}
  for (const config of configs) {
    const providerId = config?.providerId
    if (!providerId) continue
    const providerOptions = getProviderOptionsFor(config.providerOptions, providerId)
    if (!config.language && !providerOptions) continue
    output[providerId] = {
      ...(output[providerId] ?? {}),
      ...(config.language ? { language: config.language } : {}),
      ...(providerOptions
        ? {
            providerOptions: {
              ...(output[providerId]?.providerOptions ?? {}),
              ...providerOptions
            }
          }
        : {})
    }
  }

  return Object.keys(output).length > 0 ? output : undefined
}

function legacyStyleToCommon(style: Record<string, unknown>): VoiceTtsConfig['common'] | undefined {
  const common: NonNullable<VoiceTtsConfig['common']> = {}

  const speed = normalizeNumber(style.speed)
  const volume = normalizeNumber(style.volume)
  const language = normalizeString(style.language)
  const instructions = normalizeString(style.instructions)

  if (speed !== undefined) common.speed = speed
  if (volume !== undefined) common.volume = volume
  if (language) common.language = language
  if (instructions) common.instructions = instructions

  return Object.keys(common).length > 0 ? common : undefined
}

function legacyStyleToProviderBlock(
  providerId: VoiceProviderId | undefined,
  style: Record<string, unknown>
): VoiceProviderOptionBlock | undefined {
  if (!providerId) return undefined

  const block: VoiceProviderOptionBlock = {}

  if (providerId === 'openai') {
    const format = normalizeString(style.format)
    if (format) block.format = format
  }

  if (providerId === 'elevenlabs') {
    const stability = normalizeNumber(style.stability)
    const similarityBoost = normalizeNumber(style.similarityBoost ?? style.similarity)
    const styleAmount = normalizeNumber(style.style)
    const speakerBoost = normalizeBoolean(style.speakerBoost)

    if (stability !== undefined) block.stability = stability
    if (similarityBoost !== undefined) block.similarityBoost = similarityBoost
    if (styleAmount !== undefined) block.style = styleAmount
    if (speakerBoost !== undefined) block.speakerBoost = speakerBoost
  }

  if (providerId === 'deepgram') {
    const encoding = normalizeString(style.encoding)
    const container = normalizeString(style.container)
    if (encoding) block.encoding = encoding
    if (container) block.container = container
  }

  if (providerId.startsWith('local:')) {
    const format = normalizeString(style.format)
    if (format) block.format = format
  }

  return Object.keys(block).length > 0 ? block : undefined
}

function ensureProviderBlock(
  providerOptions: VoiceProviderOptionsMap | undefined,
  providerId: VoiceProviderId | undefined,
  block: VoiceProviderOptionBlock | undefined
): VoiceProviderOptionsMap | undefined {
  if (!providerId || !block || Object.keys(block).length === 0) {
    return providerOptions
  }

  const merged: VoiceProviderOptionsMap = {
    ...(providerOptions ?? {})
  }

  merged[providerId] = {
    ...(providerOptions?.[providerId] ?? {}),
    ...block
  }

  return merged
}

function removeFishReferenceIdOption(
  providerOptions: VoiceProviderOptionsMap | undefined
): VoiceProviderOptionsMap | undefined {
  if (!providerOptions?.fish || !('reference_id' in providerOptions.fish)) return providerOptions

  const fishOptions = { ...providerOptions.fish }
  delete fishOptions.reference_id

  const nextProviderOptions: VoiceProviderOptionsMap = { ...providerOptions }
  if (Object.keys(fishOptions).length > 0) {
    nextProviderOptions.fish = fishOptions
  } else {
    delete nextProviderOptions.fish
  }

  return Object.keys(nextProviderOptions).length > 0 ? nextProviderOptions : undefined
}

export function getProviderOptionsFor(
  providerOptions: VoiceProviderOptionsMap | undefined,
  providerId: string | undefined
): VoiceProviderOptionBlock | undefined {
  if (!providerOptions || !providerId) return undefined
  const block = providerOptions[providerId]
  return block && Object.keys(block).length > 0 ? block : undefined
}

export function getTtsEngineSettingsFor(
  settings: VoiceSettings | undefined | null,
  providerId: string | undefined
): VoiceTtsEngineSettings | undefined {
  if (!settings?.ttsEngineSettings || !providerId) return undefined
  return settings.ttsEngineSettings[providerId]
}

export function getSttEngineSettingsFor(
  settings: VoiceSettings | undefined | null,
  providerId: string | undefined
): VoiceSttEngineSettings | undefined {
  if (!settings?.sttEngineSettings || !providerId) return undefined
  return settings.sttEngineSettings[providerId]
}

export function normalizeVoiceTtsConfig(value: unknown): VoiceTtsConfig | undefined {
  const source = isObject(value) ? value : {}

  const providerId = normalizeVoiceProviderId(source.providerId ?? source.provider)
  const modelId = normalizeString(source.modelId ?? source.model)
  const voiceId = normalizeString(source.voiceId)
  const profileId = normalizeString(source.profileId)

  const commonFromShape = isObject(source.common)
    ? {
        speed: normalizeNumber(source.common.speed),
        volume: normalizeNumber(source.common.volume),
        language: normalizeString(source.common.language),
        instructions: normalizeString(source.common.instructions)
      }
    : undefined

  const common: VoiceTtsConfig['common'] = (() => {
    const merged: NonNullable<VoiceTtsConfig['common']> = {}
    if (commonFromShape?.speed !== undefined) merged.speed = commonFromShape.speed
    if (commonFromShape?.volume !== undefined) merged.volume = commonFromShape.volume
    if (commonFromShape?.language) merged.language = commonFromShape.language
    if (commonFromShape?.instructions) merged.instructions = commonFromShape.instructions

    if (isObject(source.style)) {
      const legacy = legacyStyleToCommon(source.style)
      if (legacy?.speed !== undefined && merged.speed === undefined) merged.speed = legacy.speed
      if (legacy?.volume !== undefined && merged.volume === undefined) merged.volume = legacy.volume
      if (legacy?.language && !merged.language) merged.language = legacy.language
      if (legacy?.instructions && !merged.instructions) merged.instructions = legacy.instructions
    }

    return Object.keys(merged).length > 0 ? merged : undefined
  })()

  let providerOptions = normalizeProviderOptionsMap(source.providerOptions)

  if (isObject(source.style)) {
    const legacyBlock = legacyStyleToProviderBlock(providerId, source.style)
    providerOptions = ensureProviderBlock(providerOptions, providerId, legacyBlock)
  }

  const normalizedVoiceId =
    voiceId ??
    (providerId === 'fish' ? normalizeString(providerOptions?.fish?.reference_id) : undefined)
  if (providerId === 'fish') {
    providerOptions = removeFishReferenceIdOption(providerOptions)
  }

  const narration = normalizeVoiceTtsNarrationSettings(
    source.narration ?? {
      italicBehavior: source.italicBehavior ?? source.italicNarrationBehavior
    }
  )

  if (
    !providerId &&
    !modelId &&
    !normalizedVoiceId &&
    !profileId &&
    !common &&
    !narration &&
    !providerOptions
  ) {
    return undefined
  }

  return {
    providerId,
    modelId,
    voiceId: normalizedVoiceId,
    profileId,
    common,
    narration,
    providerOptions
  }
}

export function normalizeVoiceSttConfig(value: unknown): VoiceSttConfig | undefined {
  const source = isObject(value) ? value : {}

  const providerId = normalizeVoiceProviderId(source.providerId ?? source.provider)
  const modelId = normalizeString(source.modelId ?? source.model)
  const language = normalizeString(source.language)
  const providerOptions = normalizeProviderOptionsMap(source.providerOptions)

  if (!providerId && !modelId && !language && !providerOptions) {
    return undefined
  }

  return {
    providerId,
    modelId,
    language,
    providerOptions
  }
}

export function normalizeVoiceSettings(settingsValue: unknown): VoiceSettings {
  const source = isObject(settingsValue) ? settingsValue : {}
  const defaultLegacyByoProvider = normalizeLegacyByoProvider(source.byo)
  const byoProvidersFromArray = normalizeByoProviders(source.byoProviders) ?? []
  const byoProvidersMap = new Map<string, VoiceByoProviderConfig>()
  for (const provider of byoProvidersFromArray) {
    byoProvidersMap.set(provider.id, provider)
  }
  if (defaultLegacyByoProvider && !byoProvidersMap.has(defaultLegacyByoProvider.id)) {
    byoProvidersMap.set(defaultLegacyByoProvider.id, defaultLegacyByoProvider)
  }
  const byoProviders = byoProvidersMap.size > 0 ? Array.from(byoProvidersMap.values()) : undefined
  const defaultByoProviderId = byoProviders?.[0]
    ? (`byo:${byoProviders[0].id}` as VoiceProviderId)
    : undefined

  const tts = normalizeVoiceTtsConfig(
    source.tts ?? {
      providerId: source.ttsProvider,
      modelId: source.ttsModel,
      voiceId: source.ttsVoiceId,
      narration: {
        italicBehavior: source.ttsItalicNarrationBehavior ?? source.italicNarrationBehavior
      }
    }
  )

  const stt = normalizeVoiceSttConfig(
    source.stt ?? {
      providerId: source.sttProvider,
      modelId: source.sttModel
    }
  )
  const realtimeStt = normalizeVoiceSttConfig(
    source.realtimeStt ?? source.voiceModeStt ?? {
      providerId: source.realtimeSttProvider,
      modelId: source.realtimeSttModel,
      language: source.realtimeSttLanguage
    }
  )

  const rawTtsProvider =
    normalizeString(
      isObject(source.tts) ? source.tts.providerId ?? source.tts.provider : source.ttsProvider
    )?.toLowerCase() ?? ''
  const rawSttProvider =
    normalizeString(
      isObject(source.stt) ? source.stt.providerId ?? source.stt.provider : source.sttProvider
    )?.toLowerCase() ?? ''
  const rawRealtimeSttProvider =
    normalizeString(
      isObject(source.realtimeStt)
        ? source.realtimeStt.providerId ?? source.realtimeStt.provider
        : source.realtimeSttProvider
    )?.toLowerCase() ?? ''

  if (tts && rawTtsProvider === 'byo' && defaultByoProviderId) {
    tts.providerId = defaultByoProviderId
  }
  if (stt && rawSttProvider === 'byo' && defaultByoProviderId) {
    stt.providerId = defaultByoProviderId
  }
  if (realtimeStt && rawRealtimeSttProvider === 'byo' && defaultByoProviderId) {
    realtimeStt.providerId = defaultByoProviderId
  }

  if (tts?.providerId?.startsWith('byo:') && tts.providerOptions?.byo) {
    const providerOptions: VoiceProviderOptionsMap = { ...tts.providerOptions }
    if (!providerOptions[tts.providerId]) {
      providerOptions[tts.providerId] = providerOptions.byo
    }
    delete providerOptions.byo
    tts.providerOptions = providerOptions
  }

  if (stt?.providerId?.startsWith('byo:') && stt.providerOptions?.byo) {
    const providerOptions: VoiceProviderOptionsMap = { ...stt.providerOptions }
    if (!providerOptions[stt.providerId]) {
      providerOptions[stt.providerId] = providerOptions.byo
    }
    delete providerOptions.byo
    stt.providerOptions = providerOptions
  }

  if (realtimeStt?.providerId?.startsWith('byo:') && realtimeStt.providerOptions?.byo) {
    const providerOptions: VoiceProviderOptionsMap = { ...realtimeStt.providerOptions }
    if (!providerOptions[realtimeStt.providerId]) {
      providerOptions[realtimeStt.providerId] = providerOptions.byo
    }
    delete providerOptions.byo
    realtimeStt.providerOptions = providerOptions
  }

  const ttsEngineSettings = mergeTtsEngineSettings(
    legacyTtsConfigToEngineSettings(tts),
    normalizeTtsEngineSettings(
      source.ttsEngineSettings ?? source.ttsProviderSettings ?? source.ttsEngineDefaults
    )
  )
  const sttEngineSettings = mergeSttEngineSettings(
    legacySttConfigToEngineSettings(stt, realtimeStt),
    normalizeSttEngineSettings(
      source.sttEngineSettings ?? source.sttProviderSettings ?? source.sttEngineDefaults
    )
  )

  return {
    schemaVersion: 2,
    inputDeviceId: normalizeString(source.inputDeviceId) ?? null,
    voiceSessionRuntime: normalizeVoiceSessionRuntime(
      source.voiceSessionRuntime ?? source.voiceRuntime ?? source.realtimeVoiceRuntime
    ),
    voiceRuntimes: normalizeVoiceRuntimes(source.voiceRuntimes),
    goonLipSync: {
      mode: normalizeGoonLipSyncMode(
        isObject(source.goonLipSync) ? source.goonLipSync.mode : source.goonLipSyncMode
      ),
      analyzerId: normalizeGoonLipSyncAnalyzerId(
        isObject(source.goonLipSync)
          ? source.goonLipSync.analyzerId
          : source.goonLipSyncAnalyzerId ?? DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER
      ),
      visemeBlendMs: normalizeGoonLipSyncVisemeBlendMs(
        isObject(source.goonLipSync)
          ? source.goonLipSync.visemeBlendMs
          : source.goonLipSyncVisemeBlendMs
      )
    },
    tts,
    stt,
    realtimeStt,
    voiceMode: normalizeVoiceModeTurnSettings(source.voiceMode ?? source.voiceModeTurn),
    ttsEnginePrompts: normalizeTtsEnginePrompts(
      source.ttsEnginePrompts ?? source.ttsProviderPrompts ?? source.enginePrompts
    ),
    ttsEngineSettings,
    sttEngineSettings,
    byoProviders
  }
}

export function normalizeAgentVoiceProfile(value: unknown): AgentVoiceProfile | null {
  const source = isObject(value) ? value : {}
  const voiceSessionRuntime = normalizeOptionalVoiceSessionRuntime(
    source.voiceSessionRuntime ?? source.voiceRuntime ?? source.realtimeVoiceRuntime
  )
  const voiceModeInputMode = normalizeOptionalVoiceModeInputMode(
    source.voiceModeInputMode ??
      source.voiceInputMode ??
      (isObject(source.voiceMode) ? source.voiceMode.inputMode : undefined)
  )
  const rawVoiceMode = source.voiceMode ?? source.voiceModeTurn
  const voiceMode = isObject(rawVoiceMode)
    ? normalizeVoiceModeTurnSettings({
        ...rawVoiceMode,
        inputMode: voiceModeInputMode ?? rawVoiceMode.inputMode
      })
    : undefined

  const tts = normalizeVoiceTtsConfig(
    source.tts ?? {
      providerId: source.provider,
      modelId: source.model,
      voiceId: source.voiceId,
      profileId: source.profileId,
      narration: {
        italicBehavior: source.ttsItalicNarrationBehavior ?? source.italicNarrationBehavior
      },
      style: source.style
    }
  )
  const stt = normalizeVoiceSttConfig(
    source.stt ?? {
      providerId: source.sttProvider,
      modelId: source.sttModel,
      language: source.sttLanguage
    }
  )
  const realtimeStt = normalizeVoiceSttConfig(
    source.realtimeStt ?? source.voiceModeStt ?? {
      providerId: source.realtimeSttProvider,
      modelId: source.realtimeSttModel,
      language: source.realtimeSttLanguage
    }
  )

  if (!voiceSessionRuntime && !voiceModeInputMode && !voiceMode && !tts && !stt && !realtimeStt) {
    return null
  }

  return {
    schemaVersion: 2,
    voiceSessionRuntime,
    voiceModeInputMode,
    voiceMode,
    tts,
    stt,
    realtimeStt
  }
}

export function flattenLegacyVoiceStyle(tts: VoiceTtsConfig | undefined): Record<string, unknown> | undefined {
  if (!tts) return undefined

  const providerId = tts.providerId
  const style: Record<string, unknown> = {}

  if (tts.common?.speed !== undefined) style.speed = tts.common.speed
  if (tts.common?.volume !== undefined) style.volume = tts.common.volume
  if (tts.common?.language) style.language = tts.common.language
  if (tts.common?.instructions) style.instructions = tts.common.instructions

  const providerBlock = getProviderOptionsFor(tts.providerOptions, providerId)
  if (providerId === 'openai') {
    if (providerBlock?.format) style.format = providerBlock.format
  }
  if (providerId === 'elevenlabs') {
    if (providerBlock?.stability !== undefined) style.stability = providerBlock.stability
    if (providerBlock?.similarityBoost !== undefined) {
      style.similarityBoost = providerBlock.similarityBoost
      style.similarity = providerBlock.similarityBoost
    }
    if (providerBlock?.style !== undefined) style.style = providerBlock.style
    if (providerBlock?.speakerBoost !== undefined) style.speakerBoost = providerBlock.speakerBoost
  }
  if (providerId === 'deepgram') {
    if (providerBlock?.encoding) style.encoding = providerBlock.encoding
    if (providerBlock?.container) style.container = providerBlock.container
  }
  if (providerId?.startsWith('local:')) {
    if (providerBlock?.format) style.format = providerBlock.format
  }

  return Object.keys(style).length > 0 ? style : undefined
}

export function mergeVoiceProviderBlocks(
  ...blocks: Array<VoiceProviderOptionBlock | undefined>
): VoiceProviderOptionBlock | undefined {
  const merged: VoiceProviderOptionBlock = {}
  for (const block of blocks) {
    if (!block) continue
    for (const [key, value] of Object.entries(block)) {
      merged[key] = value
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export function mergeVoiceCommon(
  ...blocks: Array<VoiceTtsConfig['common'] | undefined>
): VoiceTtsConfig['common'] | undefined {
  const merged: NonNullable<VoiceTtsConfig['common']> = {}
  for (const block of blocks) {
    if (!block) continue
    if (block.speed !== undefined) merged.speed = block.speed
    if (block.volume !== undefined) merged.volume = block.volume
    if (block.language) merged.language = block.language
    if (block.instructions) merged.instructions = block.instructions
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

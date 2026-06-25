import { rm, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { cloneIconRef, isIconRef, type IconRef } from '$lib/icons/iconTypes'
import { redis } from '$lib/server/redis'
import {
  resolveLocalVoiceRuntimeStateDir,
  resolveManagedInstallsRoot
} from '$lib/server/services/voiceLocalRuntimePaths'
import { deleteVoiceProfilesForProvider } from '$lib/server/services/voiceProfileRecords'
import {
  isUserFacingApiKeyService,
  normalizeApiKeyServiceName
} from '$lib/services/apiKey.server'
import {
  normalizeAgentVoiceProfile,
  normalizeVoiceSettings,
  normalizeVoiceProviderId
} from '$lib/utils/voiceSchema'
import type {
  LocalVoiceEngineInstallOwnership,
  VoiceByoAuthMode,
  VoiceEngineClientSummary,
  VoiceEngineExpressionContract,
  VoiceEngineLaunchConfig,
  VoiceEngineLocalRuntimeConfig,
  VoiceEngineLocalRuntimeSummary,
  VoiceEngineModelCatalog,
  VoiceEngineReadinessContract,
  VoiceEngineRealtimeSttConfig,
  VoiceEngineRecord,
  VoiceEngineRuntimeCompatibility,
  VoiceEngineRuntimeStartupConfig,
  VoiceEngineSuiteConfig,
  VoiceEngineSuiteRole,
  VoiceEngineVoiceSurface,
  VoiceEngineSttDefaults,
  VoiceEngineTtsDefaults,
  VoiceEngineUiSchema,
  VoiceEngineVoiceDiscovery,
  VoiceProviderOptionBlock,
  VoiceProviderOptionValue,
  VoiceProviderId,
  VoiceSettings,
  AgentVoiceProfile
} from '$lib/types/voice'

export const VOICE_ENGINE_REGISTRY_SCHEMA_VERSION = 1 as const

const RESERVED_BUILT_IN_VOICE_ENGINE_IDS = new Set([
  'browser',
  'google',
  'openai',
  'elevenlabs',
  'deepgram',
  'fish',
  'mistral'
])

export function buildVoiceEngineRegistryKey(userId: string): string {
  return `voice_engine_registry:${userId}`
}

const voiceProviderOptionValueSchema = z.union([z.string(), z.number(), z.boolean()])
const voiceProviderOptionBlockSchema = z.record(z.string(), voiceProviderOptionValueSchema)

const voiceEngineUiOptionSchema = z
  .object({
    label: z.string().trim().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()])
  })
  .strict()

const voiceEngineUiFieldSchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.enum(['string', 'number', 'boolean', 'select', 'textarea']),
    label: z.string().trim().min(1),
    path: z.string().trim().min(1).optional(),
    help: z.string().trim().min(1).optional(),
    placeholder: z.string().trim().min(1).optional(),
    required: z.boolean().optional(),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(voiceEngineUiOptionSchema).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional()
  })
  .strict()

const voiceEngineUiSectionSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    fields: z.array(voiceEngineUiFieldSchema)
  })
  .strict()

const voiceEngineUiSchema = z
  .object({
    panelTitle: z.string().trim().min(1).optional(),
    sections: z.array(voiceEngineUiSectionSchema).optional(),
    fields: z.array(voiceEngineUiFieldSchema).optional()
  })
  .strict()

export const voiceEngineTtsDefaultsSchema = z
  .object({
    modelId: z.string().trim().min(1).optional(),
    voiceId: z.string().trim().min(1).optional(),
    common: z
      .object({
        speed: z.number().optional(),
        volume: z.number().optional(),
        language: z.string().trim().min(1).optional(),
        instructions: z.string().trim().min(1).optional()
      })
      .strict()
      .optional(),
    providerOptions: voiceProviderOptionBlockSchema.optional()
  })
  .strict()

export const voiceEngineSttDefaultsSchema = z
  .object({
    modelId: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional(),
    providerOptions: voiceProviderOptionBlockSchema.optional()
  })
  .strict()

export const voiceEngineModelCatalogEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    capability: z.enum(['stt', 'tts']).optional(),
    language: z.string().trim().min(1).optional(),
    filename: z.string().trim().min(1).optional(),
    requestModel: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    sha256: z.string().trim().min(1).optional(),
    installed: z.boolean().optional(),
    failedReason: z.string().trim().min(1).optional(),
    recommended: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1)).optional()
  })
  .strict()

export const voiceEngineModelCatalogSchema = z
  .object({
    kind: z.enum(['file-download', 'whisper.cpp', 'custom']).optional(),
    capability: z.enum(['stt', 'tts']).optional(),
    modelDir: z.string().trim().min(1).optional(),
    activeModelId: z.string().trim().min(1).optional(),
    requiresRestartOnModelChange: z.boolean().optional(),
    models: z.array(voiceEngineModelCatalogEntrySchema)
  })
  .strict()

const voiceEngineExpressionSchema = z
  .object({
    strategy: z.enum(['none', 'instructions', 'inline_tokens', 'request_options']),
    guidance: z.string().trim().min(1).optional(),
    requestOptionKey: z.string().trim().min(1).optional(),
    supportedTokens: z.array(z.string().trim().min(1)).optional()
  })
  .strict()

const voiceEngineVoiceDiscoverySchema = z
  .object({
    mode: z.enum(['none', 'http']).optional(),
    path: z.string().trim().min(1).optional(),
    responsePath: z.string().trim().min(1).optional(),
    idField: z.string().trim().min(1).optional(),
    nameField: z.string().trim().min(1).optional(),
    languageField: z.string().trim().min(1).optional(),
    categoryField: z.string().trim().min(1).optional()
  })
  .strict()

const voiceEngineReadinessSchema = z
  .object({
    mode: z.enum(['health', 'health_and_voice_list']).optional(),
    requireVoices: z.boolean().optional()
  })
  .strict()

const voiceEngineVoiceSurfaceSchema = z
  .object({
    kind: z.enum(['unknown', 'single_voice', 'static_catalog', 'dynamic_catalog', 'clone_profiles', 'hybrid']),
    summary: z.string().trim().min(1).optional(),
    voices: z.array(z.string().trim().min(1)).optional(),
    requiresDiscussion: z.boolean().optional()
  })
  .strict()

const voiceEngineSuiteSchema = z
  .object({
    id: z.string().trim().min(1),
    role: z.enum(['primary', 'clone', 'voice_design', 'support']).optional(),
    hidden: z.boolean().optional()
  })
  .strict()

const voiceEngineRuntimeCompatibilitySchema = z
  .object({
    os: z.array(z.string().trim().min(1)).optional(),
    arch: z.array(z.string().trim().min(1)).optional(),
    gpu: z.array(z.string().trim().min(1)).optional(),
    docker: z.enum(['required', 'optional', 'not_needed']).optional(),
    notes: z.string().trim().min(1).optional()
  })
  .strict()

const voiceEngineLaunchSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string().trim().min(1)).optional(),
    cwd: z.string().trim().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    unsetEnv: z.array(z.string().trim().min(1)).optional(),
    envFromApiKeys: z.record(z.string(), z.string()).optional(),
    logPath: z.string().trim().min(1).optional()
  })
  .strict()

const voiceEngineRuntimeStartupSchema = z
  .object({
    autoStartOnLaunch: z.boolean().optional()
  })
  .strict()

const voiceEngineRealtimeSttSchema = z
  .object({
    enabled: z.boolean().optional(),
    transport: z.enum(['websocket']).optional(),
    path: z.string().trim().min(1).optional(),
    encoding: z.string().trim().min(1).optional(),
    sampleRate: z.number().int().min(1).optional(),
    channels: z.number().int().min(1).optional(),
    chunkMs: z.number().int().min(1).optional(),
    partialResults: z.boolean().optional(),
    finalResults: z.boolean().optional(),
    turnDetection: z.boolean().optional(),
    vad: z.boolean().optional(),
    closeMessageType: z.string().trim().min(1).optional(),
    notes: z.array(z.string().trim().min(1)).optional()
  })
  .strict()

const voiceEngineLocalRuntimeSchema = z
  .object({
    installRoot: z.string().trim().min(1).optional(),
    installOwnership: z.enum(['batshit-managed', 'user-managed']).optional(),
    launch: voiceEngineLaunchSchema.optional(),
    startup: voiceEngineRuntimeStartupSchema.optional()
  })
  .strict()

const iconRefSchema = z.custom<IconRef>((value) => isIconRef(value), 'Invalid iconRef')

const voiceEngineRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    enabled: z.boolean().optional(),
    supportsTts: z.boolean().optional(),
    supportsStt: z.boolean().optional(),
    supportsClone: z.boolean().optional(),
    adapterId: z.string().trim().min(1).optional(),
    endpointId: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    ttsPath: z.string().trim().min(1).optional(),
    sttPath: z.string().trim().min(1).optional(),
    healthPath: z.string().trim().min(1).optional(),
    voicesPath: z.string().trim().min(1).optional(),
    authMode: z.enum(['none', 'bearer', 'header']).optional(),
    authHeader: z.string().trim().min(1).optional(),
    authToken: z.string().trim().min(1).optional(),
    authSavedKeyRef: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(500).max(120_000).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    iconRef: iconRefSchema.nullable().optional(),
    requestFormat: z.enum(['batshit-byo', 'openai-compatible']).optional(),
    ttsDefaults: voiceEngineTtsDefaultsSchema.optional(),
    sttDefaults: voiceEngineSttDefaultsSchema.optional(),
    uiSchema: voiceEngineUiSchema.optional(),
    expression: voiceEngineExpressionSchema.optional(),
    voiceDiscovery: voiceEngineVoiceDiscoverySchema.optional(),
    voiceSurface: voiceEngineVoiceSurfaceSchema.optional(),
    suite: voiceEngineSuiteSchema.optional(),
    readiness: voiceEngineReadinessSchema.optional(),
    runtimeCompatibility: voiceEngineRuntimeCompatibilitySchema.optional(),
    localRuntime: voiceEngineLocalRuntimeSchema.optional(),
    sttModelCatalog: voiceEngineModelCatalogSchema.optional(),
    realtimeStt: voiceEngineRealtimeSttSchema.optional()
  })
  .strict()

const voiceEngineRegistryStoreSchema = z
  .object({
    version: z.literal(VOICE_ENGINE_REGISTRY_SCHEMA_VERSION),
    records: z.array(voiceEngineRecordSchema).default([])
  })
  .strict()

type VoiceEngineRegistryStore = z.infer<typeof voiceEngineRegistryStoreSchema>

export type VoiceEnginePublicUpdate = {
  id: string
  enabled?: boolean
  iconRef?: IconRef | null
  ttsDefaults?: VoiceEngineTtsDefaults
  sttDefaults?: VoiceEngineSttDefaults
  localRuntime?: {
    startup?: VoiceEngineRuntimeStartupConfig
  }
}

function normalizeVoiceEngineId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('engineId is required')
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    throw new Error('engineId is required')
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error('engineId must be lowercase letters, numbers, dot, dash, or underscore.')
  }

  return normalized
}

function assertVoiceEngineIdIsNotReserved(engineId: string): void {
  if (!RESERVED_BUILT_IN_VOICE_ENGINE_IDS.has(engineId)) return

  throw new Error(
    `Voice engine id "${engineId}" is reserved for Batshit's built-in provider. Use the built-in provider instead of registering a BYO engine with that id.`
  )
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function resolveConfiguredDefaultVoiceId(engine: VoiceEngineRecord): string | undefined {
  return normalizeOptionalString(engine.ttsDefaults?.voiceId)
}

function uniqueStrings(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined
  const next = values
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  if (next.length === 0) return undefined
  return Array.from(new Set(next))
}

export function getVoiceEngineSuiteId(engine: Pick<VoiceEngineRecord, 'id' | 'suite'>): string {
  return normalizeOptionalString(engine.suite?.id) ?? engine.id
}

export function getVoiceEngineSuiteRole(engine: Pick<VoiceEngineRecord, 'suite'>): VoiceEngineSuiteRole {
  return engine.suite?.role ?? 'primary'
}

export function isVoiceEngineHidden(engine: Pick<VoiceEngineRecord, 'suite'>): boolean {
  return engine.suite?.hidden === true
}

function inferVoiceSurface(engine: VoiceEngineRecord): VoiceEngineVoiceSurface | undefined {
  if (engine.supportsTts === false) {
    return engine.voiceSurface
  }

  if (engine.voiceSurface?.kind) {
    return engine.voiceSurface
  }

  if (engine.voiceDiscovery?.mode === 'http' || engine.voicesPath) {
    return {
      kind: 'dynamic_catalog',
      summary: 'Voice catalog available from the engine.',
      requiresDiscussion: false
    }
  }

  if (engine.supportsClone === true) {
    return {
      kind: 'clone_profiles',
      summary:
        'No remote voice catalog is published here; voice variety comes from Batshit voice profiles or engine-specific cloning flows.',
      requiresDiscussion: false
    }
  }

  const defaultVoice = resolveConfiguredDefaultVoiceId(engine)
  if (defaultVoice) {
    return {
      kind: 'single_voice',
      summary: `Only one configured default voice is currently available here (${defaultVoice}).`,
      requiresDiscussion: true,
      voices: [defaultVoice]
    }
  }

  return undefined
}

function resolveSuiteAwareVoiceSurface(
  engine: VoiceEngineRecord,
  allRecords: VoiceEngineRecord[]
): VoiceEngineVoiceSurface | undefined {
  const suiteId = getVoiceEngineSuiteId(engine)
  const suiteMembers = allRecords.filter((record) => getVoiceEngineSuiteId(record) === suiteId)
  const baseSurface = inferVoiceSurface(engine)
  const hasHiddenCloneLane = suiteMembers.some(
    (record) => record.id !== engine.id && getVoiceEngineSuiteRole(record) === 'clone'
  )
  const hasHiddenVoiceDesignLane = suiteMembers.some(
    (record) => record.id !== engine.id && getVoiceEngineSuiteRole(record) === 'voice_design'
  )

  if (!hasHiddenCloneLane && !hasHiddenVoiceDesignLane) {
    return baseSurface
  }

  const voices = Array.from(
    new Set([
      ...(baseSurface?.voices ?? []),
      ...(engine.voiceSurface?.voices ?? []),
      ...(resolveConfiguredDefaultVoiceId(engine) ? [resolveConfiguredDefaultVoiceId(engine)!] : [])
    ])
  )
  const notes: string[] = []

  if (voices.length > 0) {
    const preview = voices.slice(0, 6)
    const suffix = voices.length > preview.length ? ', ...' : ''
    notes.push(`Preset speakers available (${preview.join(', ')}${suffix}).`)
  } else if (baseSurface?.summary) {
    notes.push(baseSurface.summary.replace(/\.$/, '') + '.')
  }

  if (hasHiddenCloneLane) {
    notes.push("Clone profiles route through Batshit's hidden clone lane.")
  }
  if (hasHiddenVoiceDesignLane) {
    notes.push("Voice design routes through Batshit's hidden voice-design lane.")
  }

  return {
    kind: 'hybrid',
    summary: notes.join(' ').trim(),
    voices: voices.length > 0 ? voices : undefined,
    requiresDiscussion: false
  }
}

const WHISPER_CPP_DEFAULT_MODELS: VoiceEngineModelCatalog['models'] = [
  {
    id: 'tiny.en',
    label: 'tiny.en',
    description: 'Fastest English-only starter model; useful for smoke tests and low-latency checks.',
    capability: 'stt',
    language: 'en',
    filename: 'ggml-tiny.en.bin',
    requestModel: 'ggml-tiny.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    sizeBytes: 78_643_200
  },
  {
    id: 'base.en',
    label: 'base.en',
    description: 'Better English accuracy while still staying quick on Apple Silicon.',
    capability: 'stt',
    language: 'en',
    filename: 'ggml-base.en.bin',
    requestModel: 'ggml-base.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    sizeBytes: 148_897_792,
    recommended: true
  },
  {
    id: 'small.en',
    label: 'small.en',
    description: 'Stronger English accuracy; a practical local upgrade when the machine can spare more memory.',
    capability: 'stt',
    language: 'en',
    filename: 'ggml-small.en.bin',
    requestModel: 'ggml-small.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    sizeBytes: 488_636_416
  },
  {
    id: 'medium.en',
    label: 'medium.en',
    description: 'High-accuracy English model; heavier and best treated as an advanced optional download.',
    capability: 'stt',
    language: 'en',
    filename: 'ggml-medium.en.bin',
    requestModel: 'ggml-medium.en.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
    sizeBytes: 1_610_612_736
  },
  {
    id: 'large-v3',
    label: 'large-v3',
    description:
      'Full Whisper large-v3 model for the highest local accuracy; use with language set to English when English-only transcription is desired.',
    capability: 'stt',
    language: 'en',
    filename: 'ggml-large-v3.bin',
    requestModel: 'ggml-large-v3.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    sizeBytes: 3_168_979_584
  }
]

function looksLikeWhisperCppEngine(engine: VoiceEngineRecord): boolean {
  if (engine.supportsStt !== true) return false
  const haystack = `${engine.id} ${engine.name} ${engine.tags?.join(' ') ?? ''}`.toLowerCase()
  return haystack.includes('whisper.cpp') || haystack.includes('whisper-cpp')
}

export function resolveVoiceEngineSttModelCatalog(
  engine: VoiceEngineRecord
): VoiceEngineModelCatalog | undefined {
  if (engine.sttModelCatalog) return engine.sttModelCatalog
  if (!looksLikeWhisperCppEngine(engine)) return undefined

  const configuredModel = normalizeOptionalString(engine.sttDefaults?.modelId)
  const activeEntry = WHISPER_CPP_DEFAULT_MODELS.find(
    (model) =>
      configuredModel &&
      (model.id === configuredModel ||
        model.filename === configuredModel ||
        model.requestModel === configuredModel)
  )

  const catalog: VoiceEngineModelCatalog = {
    kind: 'whisper.cpp',
    capability: 'stt',
    modelDir: 'models',
    requiresRestartOnModelChange: true,
    models: WHISPER_CPP_DEFAULT_MODELS.map((model) => ({
      ...model,
      ...(activeEntry && model.id === activeEntry.id ? { installed: true } : {})
    }))
  }
  if (activeEntry) {
    catalog.activeModelId = activeEntry.id
  }
  return catalog
}

function sanitizeModelCatalogForClient(
  catalog: VoiceEngineModelCatalog | undefined
): VoiceEngineModelCatalog | undefined {
  if (!catalog) return undefined
  return {
    ...catalog,
    models: catalog.models.map(({ url: _url, sha256: _sha256, ...model }) => model)
  }
}

function normalizeSavedApiKeyRef(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)
  if (!normalized) return undefined

  const service = normalizeApiKeyServiceName(normalized)
  if (!isUserFacingApiKeyService(service)) {
    throw new Error(`Saved API key reference "${normalized}" is not a supported user-facing API key.`)
  }

  return service
}

function normalizeInstallOwnership(value: unknown): LocalVoiceEngineInstallOwnership | undefined {
  return value === 'batshit-managed' || value === 'user-managed' ? value : undefined
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const next: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizeOptionalString(key)
    if (!normalizedKey) continue
    const normalizedValue = normalizeOptionalString(entry)
    if (!normalizedValue) continue
    next[normalizedKey] = normalizedValue
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function mergeLaunchConfig(
  existing: VoiceEngineLaunchConfig | undefined,
  incoming: unknown
): VoiceEngineLaunchConfig | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return existing
  }

  const source = incoming as Record<string, unknown>
  const next: Partial<VoiceEngineLaunchConfig> = {
    ...(existing ?? {})
  }

  const command = normalizeOptionalString(source.command)
  if (command) {
    next.command = command
  }

  const args = uniqueStrings(source.args)
  if (args) {
    next.args = args
  }

  const cwd = normalizeOptionalString(source.cwd)
  if (cwd) {
    next.cwd = cwd
  }

  const env = toStringRecord(source.env)
  if (env) {
    next.env = env
  }

  const unsetEnv = uniqueStrings(source.unsetEnv)
  if (unsetEnv) {
    next.unsetEnv = unsetEnv
  }

  const envFromApiKeys = toStringRecord(source.envFromApiKeys)
  if (envFromApiKeys) {
    next.envFromApiKeys = envFromApiKeys
  }

  const logPath = normalizeOptionalString(source.logPath)
  if (logPath) {
    next.logPath = logPath
  }

  return typeof next.command === 'string' && next.command.trim().length > 0
    ? (next as VoiceEngineLaunchConfig)
    : existing
}

function mergeRuntimeStartup(
  existing: VoiceEngineRuntimeStartupConfig | undefined,
  incoming: unknown
): VoiceEngineRuntimeStartupConfig | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return existing
  }

  const source = incoming as Record<string, unknown>
  const next: VoiceEngineRuntimeStartupConfig = {
    ...(existing ?? {})
  }

  if (typeof source.autoStartOnLaunch === 'boolean') {
    next.autoStartOnLaunch = source.autoStartOnLaunch
  }

  return Object.keys(next).length > 0 ? next : existing
}

function mergeLocalRuntime(
  existing: VoiceEngineLocalRuntimeConfig | undefined,
  incoming: unknown
): VoiceEngineLocalRuntimeConfig | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return existing
  }

  const source = incoming as Record<string, unknown>
  const next: VoiceEngineLocalRuntimeConfig = {
    ...(existing ?? {})
  }

  const installRoot = normalizeOptionalString(source.installRoot)
  if (installRoot) {
    next.installRoot = installRoot
  }

  const installOwnership = normalizeInstallOwnership(source.installOwnership)
  if (installOwnership) {
    next.installOwnership = installOwnership
  }

  const launch = mergeLaunchConfig(existing?.launch, source.launch)
  if (launch) {
    next.launch = launch
  }

  const startup = mergeRuntimeStartup(existing?.startup, source.startup)
  if (startup) {
    next.startup = startup
  }

  return Object.keys(next).length > 0 ? next : existing
}

function mergeRealtimeSttConfig(
  existing: VoiceEngineRealtimeSttConfig | undefined,
  incoming: unknown
): VoiceEngineRealtimeSttConfig | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return existing
  }

  const source = incoming as Record<string, unknown>
  const next: VoiceEngineRealtimeSttConfig = {
    ...(existing ?? {})
  }

  if (typeof source.enabled === 'boolean') {
    next.enabled = source.enabled
  }
  if (source.transport === 'websocket') {
    next.transport = source.transport
  }
  const realtimePath = normalizeOptionalString(source.path)
  if (realtimePath) {
    next.path = normalizePathWithDefault(realtimePath, '/stream')
  }
  const encoding = normalizeOptionalString(source.encoding)
  if (encoding) {
    next.encoding = encoding
  }
  for (const field of ['sampleRate', 'channels', 'chunkMs'] as const) {
    const value = source[field]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      next[field] = Math.floor(value)
    }
  }
  for (const field of ['partialResults', 'finalResults', 'turnDetection', 'vad'] as const) {
    if (typeof source[field] === 'boolean') {
      next[field] = source[field]
    }
  }
  const closeMessageType = normalizeOptionalString(source.closeMessageType)
  if (closeMessageType) {
    next.closeMessageType = closeMessageType
  }
  const notes = uniqueStrings(source.notes)
  if (notes) {
    next.notes = notes
  }

  return Object.keys(next).length > 0 ? next : existing
}

function normalizePathWithDefault(value: unknown, fallback: string): string {
  const trimmed = normalizeOptionalString(value)
  if (!trimmed) return fallback
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function toVoiceProviderOptionBlock(value: unknown): VoiceProviderOptionBlock | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const next: VoiceProviderOptionBlock = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) continue
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (!trimmed) continue
      next[key] = trimmed
      continue
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      next[key] = entry
      continue
    }
    if (typeof entry === 'boolean') {
      next[key] = entry
    }
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function mergeTtsDefaults(
  existing: VoiceEngineTtsDefaults | undefined,
  incoming: unknown
): VoiceEngineTtsDefaults | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return existing
  }

  const source = incoming as Record<string, unknown>
  const nextCommon: Record<string, VoiceProviderOptionValue> = {
    ...(existing?.common ?? {})
  }
  const next: VoiceEngineTtsDefaults = {
    ...(existing ?? {})
  }
  const incomingCommon =
    source.common && typeof source.common === 'object' && !Array.isArray(source.common)
      ? (source.common as Record<string, unknown>)
      : null

  if (typeof source.modelId === 'string' && source.modelId.trim()) {
    next.modelId = source.modelId.trim()
  }
  if (typeof source.voiceId === 'string' && source.voiceId.trim()) {
    next.voiceId = source.voiceId.trim()
  }

  if (incomingCommon) {
    if (typeof incomingCommon.speed === 'number' && Number.isFinite(incomingCommon.speed)) {
      nextCommon.speed = incomingCommon.speed
    }
    if (typeof incomingCommon.volume === 'number' && Number.isFinite(incomingCommon.volume)) {
      nextCommon.volume = incomingCommon.volume
    }
    if (typeof incomingCommon.language === 'string' && incomingCommon.language.trim()) {
      nextCommon.language = incomingCommon.language.trim()
    }
    if (typeof incomingCommon.instructions === 'string' && incomingCommon.instructions.trim()) {
      nextCommon.instructions = incomingCommon.instructions.trim()
    }
  }

  const mergedProviderOptions = {
    ...(existing?.providerOptions ?? {}),
    ...(toVoiceProviderOptionBlock(source.providerOptions) ?? {})
  }

  if (Object.keys(nextCommon).length > 0) {
    next.common = nextCommon
  }
  if (Object.keys(mergedProviderOptions).length > 0) {
    next.providerOptions = mergedProviderOptions
  }

  return Object.keys(next).length > 0 ? next : undefined
}

function mergeSttDefaults(
  existing: VoiceEngineSttDefaults | undefined,
  incoming: unknown
): VoiceEngineSttDefaults | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return existing
  }

  const source = incoming as Record<string, unknown>
  const next: VoiceEngineSttDefaults = {
    ...(existing ?? {})
  }

  if (typeof source.modelId === 'string' && source.modelId.trim()) {
    next.modelId = source.modelId.trim()
  }
  if (typeof source.language === 'string' && source.language.trim()) {
    next.language = source.language.trim()
  }

  const mergedProviderOptions = {
    ...(existing?.providerOptions ?? {}),
    ...(toVoiceProviderOptionBlock(source.providerOptions) ?? {})
  }
  next.providerOptions =
    Object.keys(mergedProviderOptions).length > 0 ? mergedProviderOptions : undefined

  return Object.keys(next).length > 0 ? next : undefined
}

function mergeModelCatalog(
  existing: VoiceEngineModelCatalog | undefined,
  incoming: unknown
): VoiceEngineModelCatalog | undefined {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return existing
  }

  const source = incoming as Record<string, unknown>
  const sourceModels = Array.isArray(source.models) ? source.models : []
  if (sourceModels.length === 0) {
    return existing
  }

  const existingModelsById = new Map((existing?.models ?? []).map((model) => [model.id, model]))
  const models: VoiceEngineModelCatalog['models'] = []
  const seen = new Set<string>()

  for (const rawModel of sourceModels) {
    if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) continue
    const entry = rawModel as Record<string, unknown>
    const id = normalizeOptionalString(entry.id)
    if (!id || seen.has(id)) continue
    seen.add(id)

    const previous = existingModelsById.get(id)
    const nextModel: VoiceEngineModelCatalog['models'][number] = { id }

    const label = normalizeOptionalString(entry.label)
    if (label) nextModel.label = label
    const description = normalizeOptionalString(entry.description)
    if (description) nextModel.description = description
    if (entry.capability === 'stt' || entry.capability === 'tts') {
      nextModel.capability = entry.capability
    }
    const language = normalizeOptionalString(entry.language)
    if (language) nextModel.language = language
    const filename = normalizeOptionalString(entry.filename)
    if (filename) nextModel.filename = filename
    const requestModel = normalizeOptionalString(entry.requestModel)
    if (requestModel) nextModel.requestModel = requestModel
    const url = normalizeOptionalString(entry.url)
    if (url) nextModel.url = url
    if (typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes) && entry.sizeBytes >= 0) {
      nextModel.sizeBytes = Math.floor(entry.sizeBytes)
    }
    const sha256 = normalizeOptionalString(entry.sha256)
    if (sha256) nextModel.sha256 = sha256
    const installed = typeof entry.installed === 'boolean' ? entry.installed : previous?.installed
    if (typeof installed === 'boolean') nextModel.installed = installed
    const failedReason = normalizeOptionalString(entry.failedReason)
    if (failedReason) nextModel.failedReason = failedReason
    if (typeof entry.recommended === 'boolean') nextModel.recommended = entry.recommended
    const tags = uniqueStrings(entry.tags)
    if (tags) nextModel.tags = tags

    models.push(nextModel)
  }

  if (models.length === 0) {
    return existing
  }

  const next: VoiceEngineModelCatalog = {
    ...(existing ?? {}),
    models
  }
  if (source.kind === 'file-download' || source.kind === 'whisper.cpp' || source.kind === 'custom') {
    next.kind = source.kind
  }
  if (source.capability === 'stt' || source.capability === 'tts') {
    next.capability = source.capability
  }
  const modelDir = normalizeOptionalString(source.modelDir)
  if (modelDir) next.modelDir = modelDir
  const activeModelId = normalizeOptionalString(source.activeModelId)
  if (activeModelId) next.activeModelId = activeModelId
  if (typeof source.requiresRestartOnModelChange === 'boolean') {
    next.requiresRestartOnModelChange = source.requiresRestartOnModelChange
  }

  return next
}

function sanitizeVoiceSettingsForStorage(settingsValue: unknown): VoiceSettings {
  const normalized = normalizeVoiceSettings(settingsValue)
  const { byoProviders: _ignored, ...rest } = normalized
  return rest
}

async function readVoiceEngineRegistryStore(userId: string): Promise<VoiceEngineRegistryStore> {
  const key = buildVoiceEngineRegistryKey(userId)
  try {
    const raw = await redis.execute(async (client) => {
      return (await client.json.get(key)) as VoiceEngineRegistryStore | null
    })

    if (!raw) {
      return {
        version: VOICE_ENGINE_REGISTRY_SCHEMA_VERSION,
        records: []
      }
    }

    const parsed = voiceEngineRegistryStoreSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn('[VoiceEngineRegistry] Invalid registry payload. Resetting store.', parsed.error.flatten())
      return {
        version: VOICE_ENGINE_REGISTRY_SCHEMA_VERSION,
        records: []
      }
    }

    return parsed.data
  } catch (error) {
    console.warn('[VoiceEngineRegistry] Failed to read registry store:', error)
    return {
      version: VOICE_ENGINE_REGISTRY_SCHEMA_VERSION,
      records: []
    }
  }
}

async function writeVoiceEngineRegistryStore(
  userId: string,
  store: VoiceEngineRegistryStore
): Promise<void> {
  const key = buildVoiceEngineRegistryKey(userId)
  await redis.execute(async (client) => {
    await client.json.set(key, '$', store as any)
  })
}

function mergeVoiceEnginePayload(
  engineId: string,
  payload: Record<string, any> | undefined,
  existing?: VoiceEngineRecord
): VoiceEngineRecord {
  const source = payload ?? {}
  const next: VoiceEngineRecord = {
    ...(existing ?? {}),
    id: engineId,
    name:
      (typeof source.name === 'string' && source.name.trim()) ||
      existing?.name ||
      `BYO ${engineId}`,
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : (existing?.enabled ?? true),
    supportsTts:
      typeof source.supports?.tts === 'boolean'
        ? source.supports.tts
        : (existing?.supportsTts ?? true),
    supportsStt:
      typeof source.supports?.stt === 'boolean'
        ? source.supports.stt
        : (existing?.supportsStt ?? true),
    supportsClone:
      typeof source.supports?.clone === 'boolean'
        ? source.supports.clone
        : (existing?.supportsClone ?? false)
  }

  const setStringField = (
    field:
      | 'adapterId'
      | 'endpointId'
      | 'baseUrl'
      | 'ttsPath'
      | 'sttPath'
      | 'healthPath'
      | 'voicesPath'
      | 'authHeader'
      | 'authToken'
  ) => {
    const raw = source[field]
    if (typeof raw !== 'string') return
    const trimmed = raw.trim()
    if (!trimmed) return
    ;(next as any)[field] = trimmed
  }

  setStringField('adapterId')
  setStringField('endpointId')
  setStringField('baseUrl')
  setStringField('ttsPath')
  setStringField('sttPath')
  setStringField('healthPath')
  setStringField('voicesPath')
  setStringField('authHeader')
  setStringField('authToken')

  // Prefer a saved-key reference when one is supplied so hosted auth stays server-side.
  const authSavedKeyRef =
    normalizeSavedApiKeyRef(source.authSavedKeyRef) ??
    normalizeSavedApiKeyRef(source.authTokenFromSavedKey) ??
    normalizeSavedApiKeyRef(source.authTokenFromApiKey)
  if (authSavedKeyRef) {
    next.authSavedKeyRef = authSavedKeyRef
    delete next.authToken
  } else if (normalizeOptionalString(source.authToken)) {
    delete next.authSavedKeyRef
  }

  if (source.authMode === 'none' || source.authMode === 'bearer' || source.authMode === 'header') {
    next.authMode = source.authMode as VoiceByoAuthMode
  }

  if (typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs)) {
    next.timeoutMs = Math.min(Math.max(Math.floor(source.timeoutMs), 500), 120_000)
  }

  const tags = uniqueStrings(source.tags)
  if (tags) {
    next.tags = tags
  }

  if (source.iconRef === null) {
    next.iconRef = null
  } else if (source.iconRef !== undefined) {
    if (!isIconRef(source.iconRef)) {
      throw new Error('iconRef must be a valid icon picker reference')
    }
    next.iconRef = cloneIconRef(source.iconRef)
  }

  if (source.requestFormat === 'batshit-byo' || source.requestFormat === 'openai-compatible') {
    next.requestFormat = source.requestFormat
  }

  next.ttsDefaults = mergeTtsDefaults(existing?.ttsDefaults, source.ttsDefaults)
  next.sttDefaults = mergeSttDefaults(existing?.sttDefaults, source.sttDefaults)

  if (source.uiSchema && typeof source.uiSchema === 'object' && !Array.isArray(source.uiSchema)) {
    next.uiSchema = source.uiSchema as VoiceEngineUiSchema
  }

  if (source.expression && typeof source.expression === 'object' && !Array.isArray(source.expression)) {
    const nextExpression: Partial<VoiceEngineExpressionContract> = {
      ...(existing?.expression ?? {})
    }
    if (
      source.expression.strategy === 'none' ||
      source.expression.strategy === 'instructions' ||
      source.expression.strategy === 'inline_tokens' ||
      source.expression.strategy === 'request_options'
    ) {
      nextExpression.strategy = source.expression.strategy
    }
    const guidance = normalizeOptionalString(source.expression.guidance)
    if (guidance) {
      nextExpression.guidance = guidance
    }
    const requestOptionKey = normalizeOptionalString(source.expression.requestOptionKey)
    if (requestOptionKey) {
      nextExpression.requestOptionKey = requestOptionKey
    }
    const supportedTokens = uniqueStrings(source.expression.supportedTokens)
    if (supportedTokens) {
      nextExpression.supportedTokens = supportedTokens
    }
    next.expression = nextExpression.strategy
      ? (nextExpression as VoiceEngineExpressionContract)
      : existing?.expression
  }

  if (source.voiceDiscovery && typeof source.voiceDiscovery === 'object' && !Array.isArray(source.voiceDiscovery)) {
    const nextDiscovery: VoiceEngineVoiceDiscovery = {
      ...(existing?.voiceDiscovery ?? {})
    }
    if (source.voiceDiscovery.mode === 'none' || source.voiceDiscovery.mode === 'http') {
      nextDiscovery.mode = source.voiceDiscovery.mode
    }
    const path = normalizeOptionalString(source.voiceDiscovery.path)
    if (path) {
      nextDiscovery.path = path
    }
    const responsePath = normalizeOptionalString(source.voiceDiscovery.responsePath)
    if (responsePath) {
      nextDiscovery.responsePath = responsePath
    }
    const idField = normalizeOptionalString(source.voiceDiscovery.idField)
    if (idField) {
      nextDiscovery.idField = idField
    }
    const nameField = normalizeOptionalString(source.voiceDiscovery.nameField)
    if (nameField) {
      nextDiscovery.nameField = nameField
    }
    const languageField = normalizeOptionalString(source.voiceDiscovery.languageField)
    if (languageField) {
      nextDiscovery.languageField = languageField
    }
    const categoryField = normalizeOptionalString(source.voiceDiscovery.categoryField)
    if (categoryField) {
      nextDiscovery.categoryField = categoryField
    }
    next.voiceDiscovery = nextDiscovery
  }

  if (source.voiceSurface && typeof source.voiceSurface === 'object' && !Array.isArray(source.voiceSurface)) {
    const nextVoiceSurface: Partial<VoiceEngineVoiceSurface> = {
      ...(existing?.voiceSurface ?? {})
    }

    if (
      source.voiceSurface.kind === 'unknown' ||
      source.voiceSurface.kind === 'single_voice' ||
      source.voiceSurface.kind === 'static_catalog' ||
      source.voiceSurface.kind === 'dynamic_catalog' ||
      source.voiceSurface.kind === 'clone_profiles' ||
      source.voiceSurface.kind === 'hybrid'
    ) {
      nextVoiceSurface.kind = source.voiceSurface.kind
    }

    const summary = normalizeOptionalString(source.voiceSurface.summary)
    if (summary) {
      nextVoiceSurface.summary = summary
    }

    const voices = uniqueStrings(source.voiceSurface.voices)
    if (voices) {
      nextVoiceSurface.voices = voices
    }

    if (typeof source.voiceSurface.requiresDiscussion === 'boolean') {
      nextVoiceSurface.requiresDiscussion = source.voiceSurface.requiresDiscussion
    }

    next.voiceSurface = nextVoiceSurface.kind
      ? (nextVoiceSurface as VoiceEngineVoiceSurface)
      : existing?.voiceSurface
  }

  if (source.suite && typeof source.suite === 'object' && !Array.isArray(source.suite)) {
    const nextSuite: Partial<VoiceEngineSuiteConfig> = {
      ...(existing?.suite ?? {})
    }

    const suiteId = normalizeOptionalString(source.suite.id)
    if (suiteId) {
      nextSuite.id = suiteId
    }

    if (
      source.suite.role === 'primary' ||
      source.suite.role === 'clone' ||
      source.suite.role === 'voice_design' ||
      source.suite.role === 'support'
    ) {
      nextSuite.role = source.suite.role
    }

    if (typeof source.suite.hidden === 'boolean') {
      nextSuite.hidden = source.suite.hidden
    }

    next.suite = nextSuite.id ? (nextSuite as VoiceEngineSuiteConfig) : existing?.suite
  }

  if (source.readiness && typeof source.readiness === 'object' && !Array.isArray(source.readiness)) {
    const nextReadiness: VoiceEngineReadinessContract = {
      ...(existing?.readiness ?? {})
    }
    if (source.readiness.mode === 'health' || source.readiness.mode === 'health_and_voice_list') {
      nextReadiness.mode = source.readiness.mode
    }
    if (typeof source.readiness.requireVoices === 'boolean') {
      nextReadiness.requireVoices = source.readiness.requireVoices
    }
    next.readiness = nextReadiness
  }

  if (
    source.runtimeCompatibility &&
    typeof source.runtimeCompatibility === 'object' &&
    !Array.isArray(source.runtimeCompatibility)
  ) {
    const nextCompatibility: VoiceEngineRuntimeCompatibility = {
      ...(existing?.runtimeCompatibility ?? {})
    }
    const os = uniqueStrings(source.runtimeCompatibility.os)
    const arch = uniqueStrings(source.runtimeCompatibility.arch)
    const gpu = uniqueStrings(source.runtimeCompatibility.gpu)
    if (os) nextCompatibility.os = os
    if (arch) nextCompatibility.arch = arch
    if (gpu) nextCompatibility.gpu = gpu
    if (
      source.runtimeCompatibility.docker === 'required' ||
      source.runtimeCompatibility.docker === 'optional' ||
      source.runtimeCompatibility.docker === 'not_needed'
    ) {
      nextCompatibility.docker = source.runtimeCompatibility.docker
    }
    const notes = normalizeOptionalString(source.runtimeCompatibility.notes)
    if (notes) {
      nextCompatibility.notes = notes
    }
    next.runtimeCompatibility = nextCompatibility
  }

  if (source.localRuntime && typeof source.localRuntime === 'object' && !Array.isArray(source.localRuntime)) {
    next.localRuntime = mergeLocalRuntime(existing?.localRuntime, source.localRuntime)
  }

  if (
    source.sttModelCatalog &&
    typeof source.sttModelCatalog === 'object' &&
    !Array.isArray(source.sttModelCatalog)
  ) {
    next.sttModelCatalog = mergeModelCatalog(existing?.sttModelCatalog, source.sttModelCatalog)
  }

  if (source.realtimeStt && typeof source.realtimeStt === 'object' && !Array.isArray(source.realtimeStt)) {
    next.realtimeStt = mergeRealtimeSttConfig(existing?.realtimeStt, source.realtimeStt)
  }

  if (!next.requestFormat) {
    next.requestFormat = 'batshit-byo'
  }
  next.ttsPath = normalizePathWithDefault(next.ttsPath, '/tts')
  next.sttPath = normalizePathWithDefault(next.sttPath, '/stt')
  next.healthPath = normalizePathWithDefault(next.healthPath, '/health')
  if (next.voicesPath) {
    next.voicesPath = normalizePathWithDefault(next.voicesPath, '/voices')
  }
  if (next.realtimeStt?.enabled && !next.realtimeStt.path) {
    next.realtimeStt = {
      ...next.realtimeStt,
      transport: next.realtimeStt.transport ?? 'websocket',
      path: '/stream'
    }
  }
  if (!next.expression?.strategy) {
    next.expression = {
      strategy: 'none'
    }
  }
  if (!next.voiceDiscovery?.mode) {
    next.voiceDiscovery = next.voicesPath
      ? {
          ...(next.voiceDiscovery ?? {}),
          mode: 'http',
          path: next.voiceDiscovery?.path ?? next.voicesPath
        }
      : undefined
  }
  if (!next.readiness?.mode) {
    next.readiness = next.voiceDiscovery?.mode === 'http'
      ? {
          ...(next.readiness ?? {}),
          mode: 'health_and_voice_list',
          requireVoices: next.readiness?.requireVoices ?? false
        }
      : {
          ...(next.readiness ?? {}),
          mode: 'health'
        }
  }

  return voiceEngineRecordSchema.parse(next)
}

function sanitizeVoiceEngineForClient(
  engine: VoiceEngineRecord,
  allRecords: VoiceEngineRecord[]
): VoiceEngineClientSummary {
  const suiteId = getVoiceEngineSuiteId(engine)
  const suiteMembers = allRecords.filter((record) => getVoiceEngineSuiteId(record) === suiteId)
  const supportsTts =
    engine.supportsTts !== false || suiteMembers.some((record) => record.supportsTts !== false)
  const supportsStt =
    engine.supportsStt === true || suiteMembers.some((record) => record.supportsStt === true)
  const supportsClone =
    engine.supportsClone === true || suiteMembers.some((record) => record.supportsClone === true)

  const localRuntime: VoiceEngineLocalRuntimeSummary | undefined = engine.localRuntime
    ? {
        installOwnership: engine.localRuntime.installOwnership,
        startup: engine.localRuntime.startup
      }
    : undefined

  return {
    id: engine.id,
    providerId: `byo:${engine.id}`,
    name: engine.name,
    enabled: engine.enabled !== false,
    supportsTts,
    supportsStt,
    supportsClone,
    tags: engine.tags,
    iconRef: engine.iconRef ? cloneIconRef(engine.iconRef) : engine.iconRef,
    requestFormat: engine.requestFormat,
    ttsDefaults: engine.ttsDefaults,
    sttDefaults: engine.sttDefaults,
    uiSchema: engine.uiSchema,
    expression: engine.expression,
    voiceDiscovery: engine.voiceDiscovery,
    voiceSurface: resolveSuiteAwareVoiceSurface(engine, allRecords),
    suite: engine.suite,
    readiness: engine.readiness,
    runtimeCompatibility: engine.runtimeCompatibility,
    voicesPath: engine.voicesPath,
    sttModelCatalog: sanitizeModelCatalogForClient(resolveVoiceEngineSttModelCatalog(engine)),
    realtimeStt: engine.realtimeStt,
    hasAuthToken: Boolean(engine.authToken?.trim() || engine.authSavedKeyRef?.trim()),
    localRuntime
  }
}

async function migrateLegacyVoiceSettings(userId: string): Promise<VoiceEngineRegistryStore> {
  const store = await readVoiceEngineRegistryStore(userId)
  const settings = await redis.getUserSettings(userId)
  const normalizedVoiceSettings = normalizeVoiceSettings(settings?.voice_settings)
  const legacyProviders = Array.isArray(normalizedVoiceSettings.byoProviders)
    ? normalizedVoiceSettings.byoProviders
    : []

  if (legacyProviders.length === 0) {
    return store
  }

  const recordsById = new Map(store.records.map((record) => [record.id, record]))
  let changed = false

  for (const provider of legacyProviders) {
    const engineId = normalizeVoiceEngineId(provider.id)
    const merged = mergeVoiceEnginePayload(engineId, provider, recordsById.get(engineId))
    const previous = recordsById.get(engineId)
    if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
      changed = true
    }
    recordsById.set(engineId, merged)
  }

  const nextStore: VoiceEngineRegistryStore = {
    version: VOICE_ENGINE_REGISTRY_SCHEMA_VERSION,
    records: Array.from(recordsById.values()).sort((left, right) => left.name.localeCompare(right.name))
  }

  if (changed) {
    await writeVoiceEngineRegistryStore(userId, nextStore)
  }

  await redis.updateUserSettings(userId, {
    voice_settings: sanitizeVoiceSettingsForStorage(settings?.voice_settings)
  })

  return nextStore
}

async function loadRegistry(userId: string): Promise<VoiceEngineRegistryStore> {
  return migrateLegacyVoiceSettings(userId)
}

export async function listVoiceEngineRecords(userId: string): Promise<VoiceEngineRecord[]> {
  const store = await loadRegistry(userId)
  return [...store.records].sort((left, right) => left.name.localeCompare(right.name))
}

export async function listVoiceEngineSummaries(userId: string): Promise<VoiceEngineClientSummary[]> {
  const records = await listVoiceEngineRecords(userId)
  return records
    .filter((record) => !isVoiceEngineHidden(record))
    .map((record) => sanitizeVoiceEngineForClient(record, records))
}

export async function getVoiceEngineRecord(
  userId: string,
  engineId: string
): Promise<VoiceEngineRecord | null> {
  const normalized = normalizeVoiceEngineId(engineId)
  const records = await listVoiceEngineRecords(userId)
  return records.find((record) => record.id === normalized) ?? null
}

export async function getVoiceEngineRecordByProviderId(
  userId: string,
  providerId: VoiceProviderId | string | null | undefined
): Promise<VoiceEngineRecord | null> {
  const normalizedProvider = normalizeVoiceProviderId(providerId)
  if (!normalizedProvider || !normalizedProvider.startsWith('byo:')) {
    return null
  }
  return getVoiceEngineRecord(userId, normalizedProvider.replace(/^byo:/, ''))
}

export async function getVoiceEngineSummaryByProviderId(
  userId: string,
  providerId: VoiceProviderId | string | null | undefined
): Promise<VoiceEngineClientSummary | null> {
  const records = await listVoiceEngineRecords(userId)
  const normalizedProvider = normalizeVoiceProviderId(providerId)
  if (!normalizedProvider?.startsWith('byo:')) {
    return null
  }
  const engineId = normalizedProvider.replace(/^byo:/, '')
  const record = records.find((entry) => entry.id === engineId) ?? null
  return record ? sanitizeVoiceEngineForClient(record, records) : null
}

export async function upsertVoiceEngineRecord(
  userId: string,
  engineId: string,
  payload?: Record<string, any>
): Promise<{ created: boolean; record: VoiceEngineRecord; summary: VoiceEngineClientSummary }> {
  const normalizedId = normalizeVoiceEngineId(engineId)
  assertVoiceEngineIdIsNotReserved(normalizedId)
  const store = await loadRegistry(userId)
  const records = [...store.records]
  const existingIndex = records.findIndex((record) => record.id === normalizedId)
  const existing = existingIndex >= 0 ? records[existingIndex] : undefined
  const merged = mergeVoiceEnginePayload(normalizedId, payload, existing)

  if (existingIndex >= 0) {
    records[existingIndex] = merged
  } else {
    records.push(merged)
  }

  const nextStore: VoiceEngineRegistryStore = {
    version: VOICE_ENGINE_REGISTRY_SCHEMA_VERSION,
    records: records.sort((left, right) => left.name.localeCompare(right.name))
  }
  await writeVoiceEngineRegistryStore(userId, nextStore)

  return {
    created: existingIndex < 0,
    record: merged,
    summary: sanitizeVoiceEngineForClient(merged, nextStore.records)
  }
}

export async function setVoiceEngineEnabled(
  userId: string,
  engineId: string,
  enabled: boolean
): Promise<VoiceEngineClientSummary> {
  const { summary } = await upsertVoiceEngineRecord(userId, engineId, { enabled })
  return summary
}

export async function applyVoiceEnginePublicUpdates(
  userId: string,
  updates: VoiceEnginePublicUpdate[]
): Promise<VoiceEngineClientSummary[]> {
  const store = await loadRegistry(userId)
  const recordsById = new Map(store.records.map((record) => [record.id, record]))

  for (const update of updates) {
    const engineId = normalizeVoiceEngineId(update.id)
    const existing = recordsById.get(engineId)
    if (!existing) {
      continue
    }
    const merged = mergeVoiceEnginePayload(engineId, update as Record<string, any>, existing)

    if (Object.prototype.hasOwnProperty.call(update, 'ttsDefaults')) {
      merged.ttsDefaults = mergeTtsDefaults(undefined, update.ttsDefaults)
    }

    if (Object.prototype.hasOwnProperty.call(update, 'sttDefaults')) {
      merged.sttDefaults = mergeSttDefaults(undefined, update.sttDefaults)
    }

    recordsById.set(engineId, merged)
  }

  const nextStore: VoiceEngineRegistryStore = {
    version: VOICE_ENGINE_REGISTRY_SCHEMA_VERSION,
    records: Array.from(recordsById.values()).sort((left, right) => left.name.localeCompare(right.name))
  }
  await writeVoiceEngineRegistryStore(userId, nextStore)

  return nextStore.records
    .filter((record) => !isVoiceEngineHidden(record))
    .map((record) => sanitizeVoiceEngineForClient(record, nextStore.records))
}

export type DeleteVoiceEngineRecordOptions = {
  deleteLocalFiles?: boolean
}

export type VoiceEngineLocalFileCleanupResult = {
  requested: boolean
  deleted: boolean
  deletedInstallRoots: string[]
  deletedStateRoots: string[]
  skipped: Array<{ engineId: string; reason: string }>
  errors: Array<{ engineId: string; message: string }>
}

function createLocalFileCleanupResult(requested: boolean): VoiceEngineLocalFileCleanupResult {
  return {
    requested,
    deleted: false,
    deletedInstallRoots: [],
    deletedStateRoots: [],
    skipped: [],
    errors: []
  }
}

function expandUserHomePath(targetPath: string): string {
  if (targetPath === '~') {
    return process.env.HOME || targetPath
  }

  if (targetPath.startsWith('~/')) {
    const home = process.env.HOME
    return home ? path.join(home, targetPath.slice(2)) : targetPath
  }

  return targetPath
}

async function pathExists(targetPath: string): Promise<boolean> {
  const details = await stat(targetPath).catch(() => null)
  return Boolean(details)
}

async function canonicalPath(targetPath: string): Promise<string> {
  const resolved = path.resolve(expandUserHomePath(targetPath))
  return await realpath(resolved).catch(() => resolved)
}

async function deleteManagedLocalVoiceEngineFiles(
  records: VoiceEngineRecord[],
  requested: boolean
): Promise<VoiceEngineLocalFileCleanupResult> {
  const result = createLocalFileCleanupResult(requested)
  if (!requested) return result

  for (const record of records) {
    if (record.localRuntime?.installOwnership !== 'batshit-managed') {
      result.skipped.push({
        engineId: record.id,
        reason: 'Engine is not marked as a Batshit-managed local install.'
      })
      continue
    }

    const expectedInstallRoot = path.join(resolveManagedInstallsRoot(), record.id)
    const configuredInstallRoot = record.localRuntime.installRoot?.trim() || expectedInstallRoot

    try {
      const managedRootCanonical = await canonicalPath(resolveManagedInstallsRoot())
      const expectedCanonical = await canonicalPath(expectedInstallRoot)
      const configuredResolved = path.resolve(expandUserHomePath(configuredInstallRoot))
      const configuredCanonical = await canonicalPath(configuredInstallRoot)
      if (configuredCanonical !== expectedCanonical) {
        result.skipped.push({
          engineId: record.id,
          reason: 'Saved install root does not match the Batshit-managed install root.'
        })
        continue
      }
      if (
        expectedCanonical === managedRootCanonical ||
        !expectedCanonical.startsWith(`${managedRootCanonical}${path.sep}`)
      ) {
        result.skipped.push({
          engineId: record.id,
          reason: 'Saved install root is outside the Batshit-managed installs root.'
        })
        continue
      }

      const stateRoot = resolveLocalVoiceRuntimeStateDir(record.id)
      const installRootExists = await pathExists(configuredResolved)
      const stateRootExists = await pathExists(stateRoot)

      await rm(configuredResolved, { recursive: true, force: true })
      await rm(stateRoot, { recursive: true, force: true })

      if (installRootExists) result.deletedInstallRoots.push(configuredResolved)
      if (stateRootExists) result.deletedStateRoots.push(path.resolve(stateRoot))
    } catch (error) {
      result.errors.push({
        engineId: record.id,
        message: error instanceof Error ? error.message : 'Failed to delete local engine files.'
      })
    }
  }

  result.deleted = result.deletedInstallRoots.length > 0 || result.deletedStateRoots.length > 0
  return result
}

export async function deleteVoiceEngineRecord(
  userId: string,
  engineId: string,
  options: DeleteVoiceEngineRecordOptions = {}
): Promise<{
  deletedEngineId: string
  deletedProviderId: `byo:${string}`
  deletedProviderIds: `byo:${string}`[]
  clearedUserDefaults: boolean
  clearedAgentIds: string[]
  deletedVoiceProfileIds: string[]
  localFiles: VoiceEngineLocalFileCleanupResult
}> {
  const normalizedId = normalizeVoiceEngineId(engineId)
  const providerId = `byo:${normalizedId}` as const
  const store = await loadRegistry(userId)
  const targetRecord = store.records.find((record) => record.id === normalizedId)
  const deleteIds = new Set<string>([normalizedId])

  if (targetRecord && !isVoiceEngineHidden(targetRecord)) {
    const suiteId = getVoiceEngineSuiteId(targetRecord)
    for (const record of store.records) {
      if (record.id === normalizedId) continue
      if (getVoiceEngineSuiteId(record) !== suiteId) continue
      if (!isVoiceEngineHidden(record)) continue
      deleteIds.add(record.id)
    }
  }

  const recordsToDelete = store.records.filter((record) => deleteIds.has(record.id))
  const deletedProviderIds = Array.from(deleteIds).map((id) => `byo:${id}` as const)
  const deletedProviderIdSet = new Set<string>(deletedProviderIds)
  const nextRecords = store.records.filter((record) => !deleteIds.has(record.id))
  if (nextRecords.length === store.records.length) {
    throw new Error(`Voice engine "${normalizedId}" is not registered.`)
  }

  await writeVoiceEngineRegistryStore(userId, {
    version: VOICE_ENGINE_REGISTRY_SCHEMA_VERSION,
    records: nextRecords
  })

  const settings = await redis.getUserSettings(userId)
  const normalizedSettings = sanitizeVoiceSettingsForStorage(settings?.voice_settings)
  let clearedUserDefaults = false
  const nextSettings: VoiceSettings = {
    ...normalizedSettings
  }

  if (nextSettings.tts?.providerId && deletedProviderIdSet.has(nextSettings.tts.providerId)) {
    nextSettings.tts = {
      providerId: 'browser'
    }
    clearedUserDefaults = true
  }
  if (nextSettings.stt?.providerId && deletedProviderIdSet.has(nextSettings.stt.providerId)) {
    nextSettings.stt = {
      providerId: 'browser'
    }
    clearedUserDefaults = true
  }
  if (nextSettings.realtimeStt?.providerId && deletedProviderIdSet.has(nextSettings.realtimeStt.providerId)) {
    nextSettings.realtimeStt = {
      providerId: 'browser'
    }
    clearedUserDefaults = true
  }
  if (nextSettings.ttsEnginePrompts) {
    const nextPrompts = { ...nextSettings.ttsEnginePrompts }
    let removedPrompt = false
    for (const deletedProviderId of deletedProviderIds) {
      if (deletedProviderId in nextPrompts) {
        delete nextPrompts[deletedProviderId]
        removedPrompt = true
      }
    }
    if (removedPrompt) {
      nextSettings.ttsEnginePrompts =
        Object.keys(nextPrompts).length > 0 ? nextPrompts : undefined
      clearedUserDefaults = true
    }
  }
  if (nextSettings.ttsEngineSettings) {
    const nextTtsEngineSettings = { ...nextSettings.ttsEngineSettings }
    let removedTtsEngineSettings = false
    for (const deletedProviderId of deletedProviderIds) {
      if (deletedProviderId in nextTtsEngineSettings) {
        delete nextTtsEngineSettings[deletedProviderId]
        removedTtsEngineSettings = true
      }
    }
    if (removedTtsEngineSettings) {
      nextSettings.ttsEngineSettings =
        Object.keys(nextTtsEngineSettings).length > 0 ? nextTtsEngineSettings : undefined
      clearedUserDefaults = true
    }
  }
  if (nextSettings.sttEngineSettings) {
    const nextSttEngineSettings = { ...nextSettings.sttEngineSettings }
    let removedSttEngineSettings = false
    for (const deletedProviderId of deletedProviderIds) {
      if (deletedProviderId in nextSttEngineSettings) {
        delete nextSttEngineSettings[deletedProviderId]
        removedSttEngineSettings = true
      }
    }
    if (removedSttEngineSettings) {
      nextSettings.sttEngineSettings =
        Object.keys(nextSttEngineSettings).length > 0 ? nextSttEngineSettings : undefined
      clearedUserDefaults = true
    }
  }

  if (clearedUserDefaults) {
    await redis.updateUserSettings(userId, {
      voice_settings: nextSettings
    })
  }

  const clearedAgentIds: string[] = []
  const agents = await redis.getAgents(userId)
  for (const agent of agents) {
    const voiceProfile = normalizeAgentVoiceProfile(agent.voice_profile)
    if (!voiceProfile) {
      continue
    }
    const nextProfile: AgentVoiceProfile = { ...voiceProfile }
    let clearedAgentVoice = false
    if (nextProfile.tts?.providerId && deletedProviderIdSet.has(nextProfile.tts.providerId)) {
      delete nextProfile.tts
      clearedAgentVoice = true
    }
    if (nextProfile.stt?.providerId && deletedProviderIdSet.has(nextProfile.stt.providerId)) {
      delete nextProfile.stt
      clearedAgentVoice = true
    }
    if (
      nextProfile.realtimeStt?.providerId &&
      deletedProviderIdSet.has(nextProfile.realtimeStt.providerId)
    ) {
      delete nextProfile.realtimeStt
      clearedAgentVoice = true
    }
    if (!clearedAgentVoice) continue

    const hasRemainingProfile =
      Boolean(nextProfile.tts) ||
      Boolean(nextProfile.stt) ||
      Boolean(nextProfile.realtimeStt) ||
      Boolean(nextProfile.voiceModeInputMode) ||
      Boolean(nextProfile.voiceSessionRuntime)

    await redis.updateAgent(agent.id, {
      voice_profile: hasRemainingProfile ? nextProfile : null as any
    })
    clearedAgentIds.push(agent.id)
  }

  const deletedVoiceProfileIds: string[] = []
  for (const deletedProviderId of deletedProviderIds) {
    const deletedProfiles = await deleteVoiceProfilesForProvider(userId, deletedProviderId)
    deletedVoiceProfileIds.push(...deletedProfiles.deletedProfileIds)
  }

  const localFiles = await deleteManagedLocalVoiceEngineFiles(
    recordsToDelete,
    options.deleteLocalFiles === true
  )

  return {
    deletedEngineId: normalizedId,
    deletedProviderId: providerId,
    deletedProviderIds,
    clearedUserDefaults,
    clearedAgentIds,
    deletedVoiceProfileIds,
    localFiles
  }
}

export function buildVoiceEngineGuidance(summary: VoiceEngineClientSummary | null): string[] {
  if (!summary) return []

  const lines = [`Voice engine: ${summary.name} (${summary.providerId})`]
  const expression = summary.expression
  if (expression) {
    lines.push(`Expression support: ${expression.strategy}`)
    if (expression.guidance) {
      lines.push(`Expression rule: ${expression.guidance}`)
    } else if (expression.strategy === 'instructions') {
      lines.push('Expression rule: use voice instructions/common.instructions instead of inline tags.')
    } else if (expression.strategy === 'inline_tokens') {
      lines.push('Expression rule: preserve supported inline tokens exactly; do not invent XML tags.')
    } else if (expression.strategy === 'request_options') {
      lines.push('Expression rule: use explicit request options only; do not embed expression markup in text.')
    } else {
      lines.push('Expression rule: unsupported XML is stripped before TTS, so avoid expressive markup.')
    }
    if (expression.supportedTokens && expression.supportedTokens.length > 0) {
      lines.push(`Supported inline tokens: ${expression.supportedTokens.join(', ')}`)
    }
    if (expression.requestOptionKey) {
      lines.push(`Expression request option key: ${expression.requestOptionKey}`)
    }
  }

  const discoveryMode = summary.voiceDiscovery?.mode ?? 'none'
  lines.push(`Voice discovery: ${discoveryMode === 'http' ? 'remote list available' : 'manual entry'}`)

  const readinessMode = summary.readiness?.mode ?? 'health'
  lines.push(`Readiness contract: ${readinessMode}`)

  const compatibility = summary.runtimeCompatibility
  if (compatibility) {
    const parts: string[] = []
    if (compatibility.os?.length) parts.push(`OS=${compatibility.os.join('/')}`)
    if (compatibility.arch?.length) parts.push(`Arch=${compatibility.arch.join('/')}`)
    if (compatibility.gpu?.length) parts.push(`GPU=${compatibility.gpu.join('/')}`)
    if (compatibility.docker) parts.push(`Docker=${compatibility.docker}`)
    if (parts.length > 0) {
      lines.push(`Runtime compatibility: ${parts.join(', ')}`)
    }
    if (compatibility.notes) {
      lines.push(`Runtime notes: ${compatibility.notes}`)
    }
  }

  return lines
}

export async function getVoiceEngineGuidanceForProviderId(
  userId: string,
  providerId: VoiceProviderId | string | null | undefined
): Promise<string[]> {
  const summary = await getVoiceEngineSummaryByProviderId(userId, providerId)
  return buildVoiceEngineGuidance(summary)
}

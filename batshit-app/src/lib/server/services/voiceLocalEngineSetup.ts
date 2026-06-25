import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  LocalVoiceEngineInstallOwnership,
  VoiceEngineClientSummary,
  VoiceEngineLaunchConfig,
  VoiceEngineLocalRuntimeConfig,
  VoiceEngineRecord,
  VoiceProviderId
} from '$lib/types/voice'
import {
  checkByoSpeechStatus,
  inspectByoSpeechRuntimeForRecord,
  listByoVoicesForRecord,
  synthesizeByoSpeechForRecord,
  transcribeByoSpeechForRecord,
  type ByoSpeechRuntimeOptions,
  type ByoSpeechRuntimeStatus
} from '$lib/server/services/voiceService'
import {
  setVoiceEngineEnabled,
  upsertVoiceEngineRecord
} from '$lib/server/services/voiceEngineRegistry'
import {
  resolveLocalVoiceRuntimeLaunchRecordPath,
  resolveLocalVoiceRuntimeLogPath,
  resolveLocalVoiceRuntimeStatePath,
  resolveManagedInstallsRoot
} from '$lib/server/services/voiceLocalRuntimePaths'
export {
  resolveLocalVoiceRuntimeLaunchRecordPath,
  resolveLocalVoiceRuntimeLogPath,
  resolveLocalVoiceRuntimeStatePath,
  resolveManagedInstallsRoot
} from '$lib/server/services/voiceLocalRuntimePaths'
import {
  apiKeyService,
  isUserFacingApiKeyService,
  normalizeApiKeyServiceName
} from '$lib/services/apiKey.server'

const DEFAULT_READINESS_TIMEOUT_MS = 240_000
const DEFAULT_POLL_INTERVAL_MS = 2_500
const DEFAULT_SMOKE_TEXT = 'This is a Batshit local engine smoke test.'
const DEFAULT_STT_SMOKE_CONTENT_TYPE = 'audio/wav'
const MAX_LOG_EXCERPT_CHARS = 4_000
const SHELL_LAUNCH_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish'])
const SCRIPT_PATH_EXTENSIONS = new Set([
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.command',
  '.js',
  '.mjs',
  '.cjs'
])
const HUGGING_FACE_CACHE_ENV_VARS = ['HF_HOME', 'HF_HUB_CACHE'] as const
const HUGGING_FACE_TOKEN_ENV_VARS = new Set(['HF_TOKEN', 'HUGGINGFACE_HUB_TOKEN'])
const HUGGING_FACE_SHARED_CACHE_ACK_ENV = 'BATSHIT_ALLOW_SHARED_HF_CACHE'
const DOCKER_LOCAL_VOICE_RUNTIME_UNAVAILABLE_MESSAGE =
  'Dockerized Batshit cannot launch host-style local voice runtimes from inside the core app container. Use a connect-existing service or a supported Docker runtime add-on route.'

export type LocalVoiceEngineSetupStage =
  | 'preflight'
  | 'launch'
  | 'health'
  | 'smoke'
  | 'register'
  | 'enable'
  | 'complete'

export type LocalVoiceEngineLaunchSpec = VoiceEngineLaunchConfig

export type LocalVoiceEngineSmokeMode = 'tts' | 'stt'

export type LocalVoiceEngineSmokeSpec = {
  mode?: LocalVoiceEngineSmokeMode
  text?: string
  model?: string
  voiceId?: string | null
  profileId?: string | null
  options?: ByoSpeechRuntimeOptions
  audioBase64?: string
  audioContentType?: string
  expectedText?: string
  language?: string
}

export type LocalVoiceEngineSetupInput = {
  engineId: string
  installRoot: string
  installOwnership?: LocalVoiceEngineInstallOwnership
  launch: LocalVoiceEngineLaunchSpec
  payload: Record<string, any>
  smoke?: LocalVoiceEngineSmokeSpec
  readinessTimeoutMs?: number
  pollIntervalMs?: number
}

export type LocalVoiceEngineSmokeResult = {
  mode: LocalVoiceEngineSmokeMode
  text?: string
  transcript?: string
  expectedText?: string | null
  matchedExpectedText?: boolean | null
  voiceId?: string | null
  model: string | null
  mediaType?: string
  contentType?: string | null
  language?: string | null
  audioBytes: number
}

export type LocalVoiceEngineSetupResult = {
  completed: boolean
  blocked: boolean
  stage: LocalVoiceEngineSetupStage
  engineId: string
  providerId: `byo:${string}`
  installRoot: string
  installOwnership: LocalVoiceEngineInstallOwnership
  launchCwd: string
  logPath: string
  statePath: string
  launched: boolean
  alreadyRunning: boolean
  pid: number | null
  registered: boolean
  enabled: boolean
  health: ByoSpeechRuntimeStatus
  postRegisterHealth?: {
    ready: boolean
    statusHint?: string
  }
  smoke?: LocalVoiceEngineSmokeResult
  engine?: VoiceEngineClientSummary
  blocker?: string
  logExcerpt?: string
}

type NormalizedVoiceEnginePayload = Record<string, any> & {
  name: string
  baseUrl: string
  supports: {
    tts: boolean
    stt: boolean
    clone: boolean
  }
}

export type PreparedLocalVoiceRuntimeLaunch = {
  installRoot: string
  installOwnership: LocalVoiceEngineInstallOwnership
  launchCwd: string
  logPath: string
  launchCommand: string
  launchArgs: string[]
  launchEnv: Record<string, string>
  launchUnsetEnv: string[]
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`)
  }

  return trimmed
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const next = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)

  return next.length > 0 ? Array.from(new Set(next)) : undefined
}

function toPlainObject<T extends Record<string, unknown>>(value: unknown): T | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined
}

function normalizeEngineId(value: unknown): string {
  const trimmed = normalizeRequiredString(value, 'engineId').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
    throw new Error('engineId must use lowercase letters, numbers, dots, underscores, or dashes.')
  }
  return trimmed
}

function expandUserHomePath(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir()
  }

  if (targetPath.startsWith('~/')) {
    return path.join(os.homedir(), targetPath.slice(2))
  }

  return targetPath
}

// Durable record of every detached local runtime launch (voice engines, native
// LiveKit server, LiveKit sidecar). The Mac runtime supervisor reads these files
// to stop the runtimes on app quit, since detached processes live in their own
// process groups and would otherwise outlive Batshit.
async function writeLocalRuntimeLaunchRecord(options: {
  engineId: string
  pid: number
  command: string
  args: string[]
  cwd: string
  logPath: string
}): Promise<void> {
  const recordPath = resolveLocalVoiceRuntimeLaunchRecordPath(options.engineId)
  await mkdir(path.dirname(recordPath), { recursive: true })
  await writeFile(
    recordPath,
    `${JSON.stringify(
      {
        engineId: options.engineId,
        pid: options.pid,
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        logPath: options.logPath,
        launchedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

function isLikelyScriptPath(value: string): boolean {
  return SCRIPT_PATH_EXTENSIONS.has(path.extname(value).toLowerCase())
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeLaunchEnvSource(launch: LocalVoiceEngineLaunchSpec): Record<string, string> {
  const launchEnvSource = toPlainObject<Record<string, unknown>>(launch.env) ?? {}
  return Object.fromEntries(
    Object.entries(launchEnvSource).map(([key, value]) => [key, String(value)])
  )
}

function launchConfigReferencesHuggingFace(launch: LocalVoiceEngineLaunchSpec): boolean {
  const launchEnvSource = normalizeLaunchEnvSource(launch)
  if (
    Object.keys(launchEnvSource).some((envVarName) =>
      HUGGING_FACE_TOKEN_ENV_VARS.has(envVarName) ||
      HUGGING_FACE_CACHE_ENV_VARS.some((cacheEnvVarName) => cacheEnvVarName === envVarName)
    )
  ) {
    return true
  }

  const envFromApiKeys = toPlainObject<Record<string, unknown>>(launch.envFromApiKeys) ?? {}
  return Object.entries(envFromApiKeys).some(([envVarName, serviceValue]) => {
    if (HUGGING_FACE_TOKEN_ENV_VARS.has(envVarName)) return true
    if (typeof serviceValue !== 'string') return false
    return normalizeApiKeyServiceName(serviceValue) === 'huggingface'
  })
}

function isLikelyHuggingFaceModelId(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('://')) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return false
  if (trimmed.startsWith('~/') || trimmed.includes('\\') || trimmed.includes(':')) return false
  if (/\s/.test(trimmed)) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
}

function valueContainsHuggingFaceUrl(value: unknown): boolean {
  if (typeof value === 'string') {
    return /https?:\/\/(?:www\.)?huggingface\.co\//i.test(value)
  }

  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsHuggingFaceUrl(entry))
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) => valueContainsHuggingFaceUrl(entry))
  }

  return false
}

function recordReferencesHuggingFace(
  record: VoiceEngineRecord,
  smoke?: LocalVoiceEngineSmokeSpec
): boolean {
  return (
    isLikelyHuggingFaceModelId(smoke?.model) ||
    isLikelyHuggingFaceModelId(resolveConfiguredDefaultModel(record.ttsDefaults)) ||
    isLikelyHuggingFaceModelId(resolveConfiguredDefaultModel(record.sttDefaults)) ||
    valueContainsHuggingFaceUrl(record.ttsDefaults) ||
    valueContainsHuggingFaceUrl(record.sttDefaults) ||
    valueContainsHuggingFaceUrl(record.sttModelCatalog)
  )
}

function resolveHuggingFaceCachePathForPolicy(options: {
  value: string
  launchCwd: string
  fieldName: string
}): string {
  const trimmed = normalizeRequiredString(options.value, options.fieldName)
  if (trimmed.includes('$')) {
    throw new Error(
      `${options.fieldName} must be a literal path, not a shell variable. Use an absolute path, a tilde path, or a path relative to launch.cwd.`
    )
  }

  const expanded = expandUserHomePath(trimmed)
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(options.launchCwd, expanded)
}

function assertManagedHuggingFaceCachePolicy(options: {
  installRoot: string
  installOwnership: LocalVoiceEngineInstallOwnership
  launchCwd: string
  launch: LocalVoiceEngineLaunchSpec
  huggingFaceBacked: boolean
}): void {
  if (options.installOwnership !== 'batshit-managed' || !options.huggingFaceBacked) return

  const launchEnvSource = normalizeLaunchEnvSource(options.launch)
  const explicitCacheEntries = HUGGING_FACE_CACHE_ENV_VARS
    .map((envVarName) => ({
      envVarName,
      value: normalizeOptionalString(launchEnvSource[envVarName])
    }))
    .filter((entry): entry is { envVarName: typeof HUGGING_FACE_CACHE_ENV_VARS[number]; value: string } =>
      typeof entry.value === 'string'
    )

  if (explicitCacheEntries.length === 0) {
    throw new Error(
      `Batshit-managed Hugging Face voice installs must set launch.env.HF_HOME inside the engine install root, for example "${path.join(options.installRoot, 'hf-home')}". ` +
      `To intentionally reuse an existing shared cache, set launch.env.HF_HOME or launch.env.HF_HUB_CACHE to that cache path and set launch.env.${HUGGING_FACE_SHARED_CACHE_ACK_ENV} = "true" after user approval.`
    )
  }

  const sharedCacheApproved =
    normalizeOptionalString(launchEnvSource[HUGGING_FACE_SHARED_CACHE_ACK_ENV])?.toLowerCase() === 'true'

  for (const entry of explicitCacheEntries) {
    const resolvedCachePath = resolveHuggingFaceCachePathForPolicy({
      value: entry.value,
      launchCwd: options.launchCwd,
      fieldName: `launch.env.${entry.envVarName}`
    })
    if (isPathWithinRoot(resolvedCachePath, options.installRoot)) continue

    if (!sharedCacheApproved) {
      throw new Error(
        `launch.env.${entry.envVarName} points outside this Batshit-managed engine install root. Keep Hugging Face caches under "${options.installRoot}", or set launch.env.${HUGGING_FACE_SHARED_CACHE_ACK_ENV} = "true" after user approval to record an intentional shared cache.`
      )
    }
  }
}

async function resolveExistingDirectory(targetPath: string, fieldName: string): Promise<string> {
  const resolved = path.resolve(expandUserHomePath(targetPath))
  const details = await stat(resolved).catch(() => null)
  if (!details?.isDirectory()) {
    throw new Error(`${fieldName} must point to an existing directory.`)
  }
  return await realpath(resolved).catch(() => resolved)
}

async function resolvePathWithinRoot(options: {
  root: string
  value?: string
  fallbackRelative: string
  fieldName: string
}): Promise<string> {
  const rawValue = typeof options.value === 'string' && options.value.trim().length > 0
    ? options.value.trim()
    : options.fallbackRelative
  const expandedValue = expandUserHomePath(rawValue)
  const resolved = path.isAbsolute(expandedValue)
    ? path.resolve(expandedValue)
    : path.resolve(options.root, expandedValue)

  if (!isPathWithinRoot(resolved, options.root)) {
    throw new Error(`${options.fieldName} must stay inside the verified install root.`)
  }

  return resolved
}

function resolveLaunchCommand(command: string, cwd: string, installRoot: string): string {
  const trimmed = expandUserHomePath(normalizeRequiredString(command, 'launch.command'))
  const basename = path.basename(trimmed).toLowerCase()

  if (!trimmed.includes('/') && SHELL_LAUNCH_COMMANDS.has(basename)) {
    throw new Error(
      'launch.command must be the engine runtime or a launcher script, not a shell interpreter.'
    )
  }

  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed)
    if (isLikelyScriptPath(resolved) && !isPathWithinRoot(resolved, installRoot)) {
      throw new Error(
        'launch.command must stay inside the verified install root when using a script path.'
      )
    }
    return resolved
  }

  if (trimmed.includes('/') || trimmed.startsWith('.')) {
    const resolved = path.resolve(cwd, trimmed)
    if (!isPathWithinRoot(resolved, installRoot)) {
      throw new Error('launch.command must stay inside the verified install root when using a file path.')
    }
    return resolved
  }

  return trimmed
}

function splitFlagAssignmentArgument(argument: string): { prefix: string; value: string } | null {
  if (!argument.startsWith('-')) return null
  const equalsIndex = argument.indexOf('=')
  if (equalsIndex <= 0 || equalsIndex === argument.length - 1) {
    return null
  }

  return {
    prefix: argument.slice(0, equalsIndex + 1),
    value: argument.slice(equalsIndex + 1)
  }
}

function shouldResolveLaunchArgumentPath(argument: string): boolean {
  if (!argument || argument.includes('://')) return false
  if (argument.startsWith('-')) return false
  if (path.isAbsolute(argument) || argument.startsWith('~/') || argument === '~') return true
  if (argument.startsWith('./') || argument.startsWith('../')) return true
  if (argument.includes('/')) return true
  return isLikelyScriptPath(argument)
}

function resolveLaunchArgumentPath(
  argument: string,
  launchCwd: string,
  installRoot: string,
  fieldName: string
): string {
  const expanded = expandUserHomePath(argument)
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(launchCwd, expanded)

  if (!isPathWithinRoot(resolved, installRoot)) {
    throw new Error(`${fieldName} must stay inside the verified install root.`)
  }

  return resolved
}

function resolveLaunchArgs(args: string[], launchCwd: string, installRoot: string): string[] {
  return args.map((argument, index) => {
    const trimmed = argument.trim()
    const flagAssignment = splitFlagAssignmentArgument(trimmed)

    if (flagAssignment && shouldResolveLaunchArgumentPath(flagAssignment.value)) {
      const resolvedValue = resolveLaunchArgumentPath(
        flagAssignment.value,
        launchCwd,
        installRoot,
        `launch.args[${index}]`
      )
      return `${flagAssignment.prefix}${resolvedValue}`
    }

    if (!shouldResolveLaunchArgumentPath(trimmed)) {
      return argument
    }

    return resolveLaunchArgumentPath(trimmed, launchCwd, installRoot, `launch.args[${index}]`)
  })
}

function clampDuration(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

function isContainerizedRuntime(): boolean {
  return process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
}

function assertCanLaunchLocalVoiceRuntimeInCurrentRuntime() {
  if (!isContainerizedRuntime()) return
  throw new Error(DOCKER_LOCAL_VOICE_RUNTIME_UNAVAILABLE_MESSAGE)
}

function normalizeEnvVarName(value: string, fieldName: string): string {
  const trimmed = normalizeRequiredString(value, fieldName)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`${fieldName} must use a valid environment variable name.`)
  }
  return trimmed
}

async function resolveLaunchEnvFromApiKeys(
  userId: string,
  envFromApiKeys: unknown
): Promise<Record<string, string>> {
  const mapping = toPlainObject<Record<string, unknown>>(envFromApiKeys) ?? {}
  const resolved: Record<string, string> = {}

  for (const [envVarName, serviceValue] of Object.entries(mapping)) {
    const normalizedEnvVar = normalizeEnvVarName(envVarName, `launch.envFromApiKeys.${envVarName}`)
    const requestedService = normalizeRequiredString(
      serviceValue,
      `launch.envFromApiKeys.${normalizedEnvVar}`
    )
    const normalizedService = normalizeApiKeyServiceName(requestedService)

    if (!isUserFacingApiKeyService(normalizedService)) {
      throw new Error(
        `launch.envFromApiKeys.${normalizedEnvVar} must reference a user-facing Settings -> API Keys service.`
      )
    }

    const storedValue = await apiKeyService.retrieve(normalizedService, userId).catch(() => null)
    if (!storedValue?.trim()) {
      throw new Error(
        `Saved API key '${normalizedService}' is not configured in Settings -> API Keys.`
      )
    }

    resolved[normalizedEnvVar] = storedValue.trim()
  }

  return resolved
}

function normalizeLaunchEnvFromApiKeysForStorage(
  envFromApiKeys: unknown
): Record<string, string> | undefined {
  const mapping = toPlainObject<Record<string, unknown>>(envFromApiKeys) ?? {}
  const normalized: Record<string, string> = {}

  for (const [envVarName, serviceValue] of Object.entries(mapping)) {
    const normalizedEnvVar = normalizeEnvVarName(envVarName, `launch.envFromApiKeys.${envVarName}`)
    const requestedService = normalizeRequiredString(
      serviceValue,
      `launch.envFromApiKeys.${normalizedEnvVar}`
    )
    const normalizedService = normalizeApiKeyServiceName(requestedService)

    if (!isUserFacingApiKeyService(normalizedService)) {
      throw new Error(
        `launch.envFromApiKeys.${normalizedEnvVar} must reference a user-facing Settings -> API Keys service.`
      )
    }

    normalized[normalizedEnvVar] = normalizedService
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function buildTemporaryVoiceEngineRecord(
  engineId: string,
  payload: Record<string, any>
): { normalizedPayload: NormalizedVoiceEnginePayload; record: VoiceEngineRecord } {
  const name = normalizeRequiredString(payload.name, 'payload.name')
  const baseUrl = normalizeRequiredString(payload.baseUrl, 'payload.baseUrl')
  const supportsSource = toPlainObject<Record<string, unknown>>(payload.supports) ?? {}
  const normalizedSupports = {
    tts:
      typeof supportsSource.tts === 'boolean'
        ? supportsSource.tts
        : payload.supportsTts !== false,
    stt:
      typeof supportsSource.stt === 'boolean'
        ? supportsSource.stt
        : payload.supportsStt === true,
    clone:
      typeof supportsSource.clone === 'boolean'
        ? supportsSource.clone
        : payload.supportsClone === true
  }

  const normalizedPayload: NormalizedVoiceEnginePayload = {
    ...payload,
    name,
    baseUrl,
    enabled: false,
    supports: normalizedSupports
  }

  const record: VoiceEngineRecord = {
    id: engineId,
    name,
    enabled: false,
    supportsTts: normalizedSupports.tts,
    supportsStt: normalizedSupports.stt,
    supportsClone: normalizedSupports.clone,
    adapterId: normalizeOptionalString(payload.adapterId),
    endpointId: normalizeOptionalString(payload.endpointId),
    baseUrl,
    ttsPath: normalizeOptionalString(payload.ttsPath),
    sttPath: normalizeOptionalString(payload.sttPath),
    healthPath: normalizeOptionalString(payload.healthPath),
    voicesPath: normalizeOptionalString(payload.voicesPath),
    authMode: payload.authMode,
    authHeader: normalizeOptionalString(payload.authHeader),
    authToken: normalizeOptionalString(payload.authToken),
    timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
    tags: normalizeStringArray(payload.tags),
    requestFormat: payload.requestFormat,
    ttsDefaults: toPlainObject(payload.ttsDefaults) as VoiceEngineRecord['ttsDefaults'],
    sttDefaults: toPlainObject(payload.sttDefaults) as VoiceEngineRecord['sttDefaults'],
    uiSchema: toPlainObject(payload.uiSchema) as VoiceEngineRecord['uiSchema'],
    expression: toPlainObject(payload.expression) as VoiceEngineRecord['expression'],
    voiceDiscovery: toPlainObject(payload.voiceDiscovery) as VoiceEngineRecord['voiceDiscovery'],
    voiceSurface: toPlainObject(payload.voiceSurface) as VoiceEngineRecord['voiceSurface'],
    suite: toPlainObject(payload.suite) as VoiceEngineRecord['suite'],
    readiness: toPlainObject(payload.readiness) as VoiceEngineRecord['readiness'],
    runtimeCompatibility: toPlainObject(
      payload.runtimeCompatibility
    ) as VoiceEngineRecord['runtimeCompatibility'],
    sttModelCatalog: toPlainObject(payload.sttModelCatalog) as VoiceEngineRecord['sttModelCatalog']
  }

  return { normalizedPayload, record }
}

function resolveConfiguredDefaultModel(
  defaults?: VoiceEngineRecord['ttsDefaults'] | VoiceEngineRecord['sttDefaults'] | null
): string | undefined {
  return normalizeOptionalString(defaults?.modelId)
    ?? normalizeOptionalString(
      typeof defaults?.providerOptions?.model === 'string' ? defaults.providerOptions.model : undefined
    )
}

function normalizeSmokeMode(value: unknown): LocalVoiceEngineSmokeMode | undefined {
  if (value === 'tts' || value === 'stt') return value
  return undefined
}

function resolveSmokeMode(
  record: VoiceEngineRecord,
  requestedMode?: LocalVoiceEngineSmokeMode
): LocalVoiceEngineSmokeMode | null {
  if (requestedMode === 'tts') return record.supportsTts === true ? 'tts' : null
  if (requestedMode === 'stt') return record.supportsStt === true ? 'stt' : null
  if (record.supportsTts === true) return 'tts'
  if (record.supportsStt === true) return 'stt'
  return null
}

function parseSmokeAudioBase64(value: unknown): {
  audio: Uint8Array
  contentType?: string
} {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Local STT smoke tests require smoke.audioBase64 with a real audio sample.')
  }

  const trimmed = value.trim()
  const dataUrlMatch = /^data:([^;,]+)?;base64,(.+)$/is.exec(trimmed)
  const rawBase64 = (dataUrlMatch?.[2] ?? trimmed).replace(/\s+/g, '')
  if (!rawBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawBase64)) {
    throw new Error('smoke.audioBase64 must be valid base64 audio data.')
  }

  const buffer = Buffer.from(rawBase64, 'base64')
  if (buffer.length === 0) {
    throw new Error('smoke.audioBase64 decoded to an empty audio sample.')
  }

  return {
    audio: Uint8Array.from(buffer),
    contentType: normalizeOptionalString(dataUrlMatch?.[1])
  }
}

function normalizeTranscriptForComparison(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function transcriptContainsExpectedText(transcript: string, expectedText: string): boolean {
  const normalizedTranscript = normalizeTranscriptForComparison(transcript)
  const normalizedExpected = normalizeTranscriptForComparison(expectedText)
  return normalizedExpected.length > 0 && normalizedTranscript.includes(normalizedExpected)
}

function getOpenAICompatibleRegisterBlocker(options: {
  record: VoiceEngineRecord
  smokeMode: LocalVoiceEngineSmokeMode
  smokeModel?: string | null
}): string | null {
  if (options.record.requestFormat !== 'openai-compatible') return null

  const missingDefaults: Array<{ mode: LocalVoiceEngineSmokeMode; field: string; label: string }> = []
  if (options.record.supportsTts === true && !resolveConfiguredDefaultModel(options.record.ttsDefaults)) {
    missingDefaults.push({
      mode: 'tts',
      field: 'payload.ttsDefaults.modelId',
      label: 'TTS'
    })
  }
  if (options.record.supportsStt === true && !resolveConfiguredDefaultModel(options.record.sttDefaults)) {
    missingDefaults.push({
      mode: 'stt',
      field: 'payload.sttDefaults.modelId',
      label: 'STT'
    })
  }
  if (missingDefaults.length === 0) return null

  const provenSmokeModel = normalizeOptionalString(options.smokeModel)
  const matchingMissingDefault = missingDefaults.find((entry) => entry.mode === options.smokeMode)
  if (provenSmokeModel && matchingMissingDefault) {
    return (
      `The local ${matchingMissingDefault.label} smoke test succeeded with model "${provenSmokeModel}", but the saved engine payload is still missing ` +
      `${matchingMissingDefault.field}. Save that default model before registration so Batshit can make real requests after setup.`
    )
  }

  if (missingDefaults.length > 1) {
    return (
      'OpenAI-compatible engines must save a default model for every supported speech capability before registration. Missing: ' +
      `${missingDefaults.map((entry) => entry.field).join(', ')}.`
    )
  }

  const [missingDefault] = missingDefaults
  const action = missingDefault.mode === 'tts' ? 'synth requests' : 'transcription requests'

  return (
    `OpenAI-compatible ${missingDefault.label} engines must save ${missingDefault.field} before registration. ` +
    `Without a saved default model, Batshit cannot make real ${action} after setup.`
  )
}

async function readLogExcerpt(logPath: string): Promise<string | undefined> {
  const text = await readFile(logPath, 'utf8').catch(() => '')
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.slice(-MAX_LOG_EXCERPT_CHARS)
}

async function writeStateSnapshot(result: LocalVoiceEngineSetupResult): Promise<void> {
  await mkdir(path.dirname(result.statePath), { recursive: true })
  await writeFile(result.statePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

function buildProviderId(engineId: string): `byo:${string}` {
  return `byo:${engineId}`
}

function createBaseResult(options: {
  engineId: string
  installRoot: string
  installOwnership: LocalVoiceEngineInstallOwnership
  launchCwd: string
  logPath: string
  statePath: string
  health: ByoSpeechRuntimeStatus
  launched?: boolean
  alreadyRunning?: boolean
  pid?: number | null
  registered?: boolean
  enabled?: boolean
}): LocalVoiceEngineSetupResult {
  return {
    completed: false,
    blocked: false,
    stage: 'preflight',
    engineId: options.engineId,
    providerId: buildProviderId(options.engineId),
    installRoot: options.installRoot,
    installOwnership: options.installOwnership,
    launchCwd: options.launchCwd,
    logPath: options.logPath,
    statePath: options.statePath,
    launched: options.launched === true,
    alreadyRunning: options.alreadyRunning === true,
    pid: options.pid ?? null,
    registered: options.registered === true,
    enabled: options.enabled === true,
    health: options.health
  }
}

async function finalizeResult(result: LocalVoiceEngineSetupResult): Promise<LocalVoiceEngineSetupResult> {
  await writeStateSnapshot(result)
  return result
}

async function blockResult(
  result: LocalVoiceEngineSetupResult,
  stage: LocalVoiceEngineSetupStage,
  blocker: string
): Promise<LocalVoiceEngineSetupResult> {
  result.completed = false
  result.blocked = true
  result.stage = stage
  result.blocker = blocker
  result.logExcerpt = await readLogExcerpt(result.logPath)
  return finalizeResult(result)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForRuntimeReady(options: {
  record: VoiceEngineRecord
  timeoutMs: number
  pollIntervalMs: number
}): Promise<ByoSpeechRuntimeStatus> {
  const deadline = Date.now() + options.timeoutMs
  let status = await inspectByoSpeechRuntimeForRecord(options.record, { allowDisabled: true })

  while (!status.ready && status.state !== 'error' && Date.now() < deadline) {
    await sleep(options.pollIntervalMs)
    status = await inspectByoSpeechRuntimeForRecord(options.record, { allowDisabled: true })
  }

  return status
}

async function chooseSmokeVoiceId(
  record: VoiceEngineRecord,
  requestedVoiceId?: string | null
): Promise<string | null> {
  const direct = normalizeOptionalString(requestedVoiceId)
  if (direct) return direct

  const voices = await listByoVoicesForRecord(record, { allowDisabled: true }).catch(() => [])
  return voices[0]?.id ?? null
}

async function spawnDetachedRuntime(options: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  unsetEnv?: string[]
  logPath: string
}): Promise<number> {
  await mkdir(path.dirname(options.logPath), { recursive: true })

  // The log path is a Batshit-owned runtime file opened for detached child stdout.
  // codeql[js/file-system-race]
  const stdoutFd = openSync(options.logPath, 'a')
  // The log path is a Batshit-owned runtime file opened for detached child stderr.
  // codeql[js/file-system-race]
  const stderrFd = openSync(options.logPath, 'a')

  return await new Promise<number>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      try {
        closeSync(stdoutFd)
      } catch {}
      try {
        closeSync(stderrFd)
      } catch {}
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const childEnv = { ...process.env }
    for (const envName of options.unsetEnv ?? []) {
      delete childEnv[envName]
    }

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...childEnv,
        ...options.env
      },
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd]
    })

    child.once('error', (error) => {
      fail(error instanceof Error ? error : new Error('Local engine launch failed.'))
    })

    child.once('exit', (code, signal) => {
      fail(
        new Error(
          `Local engine launch exited immediately (${code !== null ? `code ${code}` : signal ?? 'unknown'}).`
        )
      )
    })

    child.once('spawn', () => {
      setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        child.unref()
        resolve(child.pid ?? 0)
      }, 200)
    })
  })
}

export async function prepareLocalVoiceRuntimeLaunch(options: {
  userId: string
  engineId: string
  installRoot: string
  installOwnership?: LocalVoiceEngineInstallOwnership
  launch: LocalVoiceEngineLaunchSpec
}): Promise<PreparedLocalVoiceRuntimeLaunch> {
  const engineId = normalizeEngineId(options.engineId)
  const installOwnership = options.installOwnership ?? 'batshit-managed'
  const installRoot = await resolveExistingDirectory(options.installRoot, 'installRoot')

  if (installOwnership === 'batshit-managed') {
    const expectedInstallRoot = path.join(resolveManagedInstallsRoot(), engineId)
    const resolvedExpectedRoot = path.resolve(expectedInstallRoot)
    const canonicalExpectedRoot = await realpath(resolvedExpectedRoot).catch(
      () => resolvedExpectedRoot
    )
    if (installRoot !== canonicalExpectedRoot) {
      throw new Error(
        `Batshit-managed local installs must use ${canonicalExpectedRoot} as the install root.`
      )
    }
  }

  const launchCwd = await resolvePathWithinRoot({
    root: installRoot,
    value: options.launch.cwd,
    fallbackRelative: '.',
    fieldName: 'launch.cwd'
  })
  const explicitLogPath = normalizeOptionalString(options.launch.logPath)
  const logPath = explicitLogPath
    ? await resolvePathWithinRoot({
        root: installRoot,
        value: explicitLogPath,
        fallbackRelative: explicitLogPath,
        fieldName: 'launch.logPath'
      })
    : resolveLocalVoiceRuntimeLogPath(engineId)
  assertManagedHuggingFaceCachePolicy({
    installRoot,
    installOwnership,
    launchCwd,
    launch: options.launch,
    huggingFaceBacked: launchConfigReferencesHuggingFace(options.launch)
  })
  const args = Array.isArray(options.launch.args)
    ? options.launch.args.map((entry) => String(entry))
    : []
  const launchCommand = resolveLaunchCommand(options.launch.command, launchCwd, installRoot)
  const launchArgs = resolveLaunchArgs(args, launchCwd, installRoot)
  const launchEnv = normalizeLaunchEnvSource(options.launch)
  const launchEnvFromApiKeys = await resolveLaunchEnvFromApiKeys(
    options.userId,
    options.launch.envFromApiKeys
  )
  const launchUnsetEnv = normalizeStringArray(options.launch.unsetEnv)?.map((entry, index) =>
    normalizeEnvVarName(entry, `launch.unsetEnv[${index}]`)
  ) ?? []

  return {
    installRoot,
    installOwnership,
    launchCwd,
    logPath,
    launchCommand,
    launchArgs,
    launchEnv: {
      ...launchEnv,
      ...launchEnvFromApiKeys
    },
    launchUnsetEnv
  }
}

export async function startLocalVoiceRuntime(options: {
  userId: string
  engineId: string
  installRoot: string
  installOwnership?: LocalVoiceEngineInstallOwnership
  launch: LocalVoiceEngineLaunchSpec
}): Promise<PreparedLocalVoiceRuntimeLaunch & { pid: number }> {
  assertCanLaunchLocalVoiceRuntimeInCurrentRuntime()

  const prepared = await prepareLocalVoiceRuntimeLaunch(options)
  const pid = await spawnDetachedRuntime({
    command: prepared.launchCommand,
    args: prepared.launchArgs,
    cwd: prepared.launchCwd,
    env: prepared.launchEnv,
    unsetEnv: prepared.launchUnsetEnv,
    logPath: prepared.logPath
  })

  await writeLocalRuntimeLaunchRecord({
    engineId: normalizeEngineId(options.engineId),
    pid,
    command: prepared.launchCommand,
    args: prepared.launchArgs,
    cwd: prepared.launchCwd,
    logPath: prepared.logPath
  })

  return {
    ...prepared,
    pid
  }
}

export async function completeLocalVoiceEngineSetup(
  userId: string,
  input: LocalVoiceEngineSetupInput
): Promise<LocalVoiceEngineSetupResult> {
  assertCanLaunchLocalVoiceRuntimeInCurrentRuntime()

  const engineId = normalizeEngineId(input.engineId)
  const preparedLaunch = await prepareLocalVoiceRuntimeLaunch({
    userId,
    engineId,
    installRoot: input.installRoot,
    installOwnership: input.installOwnership,
    launch: input.launch
  })
  const installOwnership = preparedLaunch.installOwnership
  const installRoot = preparedLaunch.installRoot
  const launchCwd = preparedLaunch.launchCwd
  const logPath = preparedLaunch.logPath
  const statePath = resolveLocalVoiceRuntimeStatePath(engineId)
  const readinessTimeoutMs = clampDuration(
    input.readinessTimeoutMs,
    DEFAULT_READINESS_TIMEOUT_MS,
    5_000,
    900_000
  )
  const pollIntervalMs = clampDuration(
    input.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    250,
    30_000
  )

  const { normalizedPayload, record } = buildTemporaryVoiceEngineRecord(engineId, input.payload)
  assertManagedHuggingFaceCachePolicy({
    installRoot,
    installOwnership,
    launchCwd,
    launch: input.launch,
    huggingFaceBacked:
      launchConfigReferencesHuggingFace(input.launch) ||
      recordReferencesHuggingFace(record, input.smoke)
  })
  const requestedSmokeMode = normalizeSmokeMode(input.smoke?.mode)
  const smokeMode = resolveSmokeMode(record, requestedSmokeMode)
  if (!smokeMode) {
    const modeSpecificBlocker = requestedSmokeMode
      ? `The payload does not support ${requestedSmokeMode.toUpperCase()}, so the requested local ${requestedSmokeMode.toUpperCase()} smoke test cannot run.`
      : 'This helper requires an engine payload that supports TTS or STT.'
    const unsupportedResult = createBaseResult({
      engineId,
      installRoot,
      installOwnership,
      launchCwd,
      logPath,
      statePath,
      health: {
        ready: false,
        reachable: false,
        state: 'error',
        statusHint: modeSpecificBlocker
      }
    })

    return blockResult(
      unsupportedResult,
      'preflight',
      modeSpecificBlocker
    )
  }

  let health = await inspectByoSpeechRuntimeForRecord(record, { allowDisabled: true })
  let alreadyRunning = health.state !== 'unreachable'
  let launched = false
  let pid: number | null = null

  const result = createBaseResult({
    engineId,
    installRoot,
    installOwnership,
    launchCwd,
    logPath,
    statePath,
    health,
    alreadyRunning
  })

  if (health.state === 'error') {
    return blockResult(
      result,
      'health',
      health.statusHint ?? 'The local engine runtime reported an error before setup could continue.'
    )
  }

  if (health.state === 'unreachable') {
    result.stage = 'launch'
    await writeStateSnapshot(result)

    try {
      pid = await spawnDetachedRuntime({
        command: preparedLaunch.launchCommand,
        args: preparedLaunch.launchArgs,
        cwd: preparedLaunch.launchCwd,
        env: preparedLaunch.launchEnv,
        unsetEnv: preparedLaunch.launchUnsetEnv,
        logPath: preparedLaunch.logPath
      })
      await writeLocalRuntimeLaunchRecord({
        engineId,
        pid,
        command: preparedLaunch.launchCommand,
        args: preparedLaunch.launchArgs,
        cwd: preparedLaunch.launchCwd,
        logPath: preparedLaunch.logPath
      })
    } catch (error) {
      return blockResult(
        result,
        'launch',
        error instanceof Error ? error.message : 'Failed to launch the local engine runtime.'
      )
    }

    launched = true
    alreadyRunning = false
    result.launched = true
    result.pid = pid
  }

  result.stage = 'health'
  result.alreadyRunning = alreadyRunning
  result.health = health
  await writeStateSnapshot(result)

  health =
    health.ready
      ? health
      : await waitForRuntimeReady({
          record,
          timeoutMs: readinessTimeoutMs,
          pollIntervalMs
        })
  result.health = health

  if (!health.ready) {
    const blocker =
      health.state === 'error'
        ? health.statusHint ?? 'The local engine runtime reported an error during readiness polling.'
        : health.statusHint ??
          'Timed out waiting for the local engine runtime to become ready.'

    return blockResult(result, 'health', blocker)
  }

  result.stage = 'smoke'
  await writeStateSnapshot(result)

  try {
    if (smokeMode === 'tts') {
      const smokeText = normalizeOptionalString(input.smoke?.text) ?? DEFAULT_SMOKE_TEXT
      const smokeVoiceId = await chooseSmokeVoiceId(record, input.smoke?.voiceId)
      const smoke = await synthesizeByoSpeechForRecord({
        record,
        text: smokeText,
        providerId: result.providerId,
        model: normalizeOptionalString(input.smoke?.model),
        voiceId: smokeVoiceId,
        profileId: normalizeOptionalString(input.smoke?.profileId),
        options: input.smoke?.options
      })

      result.smoke = {
        mode: 'tts',
        text: smokeText,
        voiceId: smoke.voiceId ?? smokeVoiceId,
        model: smoke.model ?? normalizeOptionalString(input.smoke?.model) ?? null,
        mediaType: smoke.mediaType,
        audioBytes: smoke.audio.length
      }
    } else {
      const parsedAudio = parseSmokeAudioBase64(input.smoke?.audioBase64)
      const contentType =
        normalizeOptionalString(input.smoke?.audioContentType) ??
        parsedAudio.contentType ??
        DEFAULT_STT_SMOKE_CONTENT_TYPE
      const requestedModel = normalizeOptionalString(input.smoke?.model)
      const requestedLanguage = normalizeOptionalString(input.smoke?.language)
      const expectedText =
        normalizeOptionalString(input.smoke?.expectedText) ??
        normalizeOptionalString(input.smoke?.text) ??
        null
      const smoke = await transcribeByoSpeechForRecord({
        record,
        audio: parsedAudio.audio,
        providerId: result.providerId,
        model: requestedModel,
        language: requestedLanguage,
        contentType,
        userId
      })
      const transcript = smoke.text.trim()
      if (!transcript) {
        throw new Error('The local STT smoke test returned an empty transcript.')
      }
      const matchedExpectedText = expectedText
        ? transcriptContainsExpectedText(transcript, expectedText)
        : null
      if (expectedText && matchedExpectedText !== true) {
        throw new Error(
          `The local STT smoke test transcript did not contain the expected text. Expected "${expectedText}", got "${transcript}".`
        )
      }

      result.smoke = {
        mode: 'stt',
        transcript,
        expectedText,
        matchedExpectedText,
        model: requestedModel ?? resolveConfiguredDefaultModel(record.sttDefaults) ?? null,
        contentType,
        language: smoke.language ?? requestedLanguage ?? null,
        audioBytes: parsedAudio.audio.length
      }
    }
  } catch (error) {
    return blockResult(
      result,
      'smoke',
      error instanceof Error ? error.message : 'The local engine smoke test failed.'
    )
  }

  result.stage = 'register'
  await writeStateSnapshot(result)

  const registerBlocker = getOpenAICompatibleRegisterBlocker({
    record,
    smokeMode,
    smokeModel: result.smoke?.model ?? normalizeOptionalString(input.smoke?.model) ?? null
  })
  if (registerBlocker) {
    return blockResult(result, 'register', registerBlocker)
  }

  const storedLaunchEnvSource = toPlainObject<Record<string, unknown>>(input.launch.env) ?? {}
  const storedLocalRuntime: VoiceEngineLocalRuntimeConfig = {
    installRoot,
    installOwnership,
    launch: {
      command: preparedLaunch.launchCommand,
      args: preparedLaunch.launchArgs,
      cwd: preparedLaunch.launchCwd,
      env:
        Object.keys(storedLaunchEnvSource).length > 0
          ? Object.fromEntries(
              Object.entries(storedLaunchEnvSource).map(([key, value]) => [key, String(value)])
            )
          : undefined,
      unsetEnv: preparedLaunch.launchUnsetEnv.length > 0 ? preparedLaunch.launchUnsetEnv : undefined,
      envFromApiKeys: normalizeLaunchEnvFromApiKeysForStorage(input.launch.envFromApiKeys),
      logPath: preparedLaunch.logPath
    }
  }

  const upserted = await upsertVoiceEngineRecord(userId, engineId, {
    ...normalizedPayload,
    enabled: false,
    localRuntime: storedLocalRuntime
  })
  result.registered = true

  const postRegisterHealth = await checkByoSpeechStatus(userId, result.providerId)
  result.postRegisterHealth = postRegisterHealth
  if (!postRegisterHealth.ready) {
    result.engine = upserted.summary
    return blockResult(
      result,
      'register',
      postRegisterHealth.statusHint ??
        'The engine registered, but the server-side health check did not pass.'
    )
  }

  result.stage = 'enable'
  await writeStateSnapshot(result)

  try {
    result.engine = await setVoiceEngineEnabled(userId, engineId, true)
    result.enabled = true
  } catch (error) {
    result.engine = upserted.summary
    return blockResult(
      result,
      'enable',
      error instanceof Error ? error.message : 'The engine could not be enabled after registration.'
    )
  }

  result.completed = true
  result.blocked = false
  result.stage = 'complete'
  return finalizeResult(result)
}

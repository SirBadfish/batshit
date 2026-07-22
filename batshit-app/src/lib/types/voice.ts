import type { IconRef } from '$lib/icons/iconTypes'

export type VoiceProviderId =
  | 'browser'
  | 'google'
  | 'openai'
  | 'elevenlabs'
  | 'deepgram'
  | 'fish'
  | 'mistral'
  | 'minimax'
  | 'mimo'
  | 'alibaba'
  | 'inworld'
  | 'cartesia'
  | 'async'
  | 'stepfun'
  | 'azure'
  | 'byo'
  | `local:${string}`
  | `byo:${string}`

export type LocalVoiceEngineInstallOwnership = 'batshit-managed' | 'user-managed'

export type VoiceMode = 'text' | 'voice' | 'hybrid'
export type VoiceSessionRuntime = 'direct' | 'livekit'

export type VoiceProviderOptionValue = string | number | boolean

export type VoiceProviderOptionBlock = Record<string, VoiceProviderOptionValue>

export type VoiceProviderOptionsMap = Record<string, VoiceProviderOptionBlock>

export type VoiceByoAuthMode = 'none' | 'bearer' | 'header'

export interface VoiceCommonOptions {
  speed?: number
  volume?: number
  language?: string
  instructions?: string
}

export type VoiceItalicNarrationBehavior = 'speak' | 'silent'

export interface VoiceTtsNarrationSettings {
  italicBehavior?: VoiceItalicNarrationBehavior
}

export type GoonLipSyncMode = 'amplitude' | 'viseme'
export type GoonLipSyncPremiumAnalyzerId = 'rhubarb-wasm' | 'audio2face-3d'

export interface GoonLipSyncSettings {
  mode?: GoonLipSyncMode
  analyzerId?: GoonLipSyncPremiumAnalyzerId
  visemeBlendMs?: number
}

export type VoiceEngineUiFieldType = 'string' | 'number' | 'boolean' | 'select' | 'textarea'

export interface VoiceEngineUiOption {
  label: string
  value: string | number | boolean | null
}

export interface VoiceEngineUiField {
  id: string
  type: VoiceEngineUiFieldType
  label: string
  path?: string
  help?: string
  placeholder?: string
  required?: boolean
  defaultValue?: string | number | boolean
  options?: VoiceEngineUiOption[]
  min?: number
  max?: number
  step?: number
}

export interface VoiceEngineUiSection {
  id: string
  title: string
  description?: string
  fields: VoiceEngineUiField[]
}

export interface VoiceEngineUiSchema {
  panelTitle?: string
  sections?: VoiceEngineUiSection[]
  fields?: VoiceEngineUiField[]
}

export interface VoiceEngineTtsDefaults {
  modelId?: string
  voiceId?: string
  common?: VoiceCommonOptions
  providerOptions?: VoiceProviderOptionBlock
}

export interface VoiceEngineSttDefaults {
  modelId?: string
  language?: string
  providerOptions?: VoiceProviderOptionBlock
}

export type VoiceEngineModelCapability = 'stt' | 'tts'
export type VoiceEngineModelCatalogKind = 'file-download' | 'whisper.cpp' | 'custom'

export interface VoiceEngineModelCatalogEntry {
  id: string
  label?: string
  description?: string
  capability?: VoiceEngineModelCapability
  language?: string
  filename?: string
  requestModel?: string
  url?: string
  sizeBytes?: number
  sha256?: string
  installed?: boolean
  failedReason?: string
  recommended?: boolean
  tags?: string[]
}

export interface VoiceEngineModelCatalog {
  kind?: VoiceEngineModelCatalogKind
  capability?: VoiceEngineModelCapability
  modelDir?: string
  activeModelId?: string
  requiresRestartOnModelChange?: boolean
  models: VoiceEngineModelCatalogEntry[]
}

export type VoiceEngineRequestFormat = 'batshit-byo' | 'openai-compatible'

export type VoiceEngineExpressionStrategy = 'none' | 'instructions' | 'inline_tokens' | 'request_options'

export interface VoiceEngineExpressionContract {
  strategy: VoiceEngineExpressionStrategy
  guidance?: string
  requestOptionKey?: string
  supportedTokens?: string[]
}

export interface VoiceEngineVoiceDiscovery {
  mode?: 'none' | 'http'
  path?: string
  responsePath?: string
  idField?: string
  nameField?: string
  languageField?: string
  categoryField?: string
}

export type VoiceEngineVoiceSurfaceKind =
  | 'unknown'
  | 'single_voice'
  | 'static_catalog'
  | 'dynamic_catalog'
  | 'clone_profiles'
  | 'hybrid'

export interface VoiceEngineVoiceSurface {
  kind: VoiceEngineVoiceSurfaceKind
  summary?: string
  voices?: string[]
  requiresDiscussion?: boolean
}

export type VoiceEngineSuiteRole = 'primary' | 'clone' | 'voice_design' | 'support'

export interface VoiceEngineSuiteConfig {
  id: string
  role?: VoiceEngineSuiteRole
  hidden?: boolean
}

export interface VoiceEngineReadinessContract {
  mode?: 'health' | 'health_and_voice_list'
  requireVoices?: boolean
}

export interface VoiceEngineRuntimeCompatibility {
  os?: string[]
  arch?: string[]
  gpu?: string[]
  docker?: 'required' | 'optional' | 'not_needed'
  notes?: string
}

export interface VoiceEngineLaunchConfig {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  unsetEnv?: string[]
  envFromApiKeys?: Record<string, string>
  logPath?: string
}

export interface VoiceEngineRuntimeStartupConfig {
  autoStartOnLaunch?: boolean
}

export interface VoiceRuntimeStartupConfig {
  autoStartOnLaunch?: boolean
}

export interface LiveKitVoiceRuntimeSettings {
  startup?: VoiceRuntimeStartupConfig
}

export interface VoiceRuntimeSettings {
  livekit?: LiveKitVoiceRuntimeSettings
}

export interface VoiceEngineLocalRuntimeConfig {
  installRoot?: string
  installOwnership?: LocalVoiceEngineInstallOwnership
  launch?: VoiceEngineLaunchConfig
  startup?: VoiceEngineRuntimeStartupConfig
}

export interface VoiceEngineLocalRuntimeSummary {
  installOwnership?: LocalVoiceEngineInstallOwnership
  startup?: VoiceEngineRuntimeStartupConfig
}

export type VoiceEngineRealtimeSttTransport = 'websocket'

export interface VoiceEngineRealtimeSttConfig {
  enabled?: boolean
  transport?: VoiceEngineRealtimeSttTransport
  path?: string
  encoding?: string
  sampleRate?: number
  channels?: number
  chunkMs?: number
  partialResults?: boolean
  finalResults?: boolean
  turnDetection?: boolean
  vad?: boolean
  closeMessageType?: string
  notes?: string[]
}

export interface VoiceByoProviderConfig {
  id: string
  name: string
  enabled?: boolean
  supportsTts?: boolean
  supportsStt?: boolean
  supportsClone?: boolean
  adapterId?: string
  endpointId?: string
  baseUrl?: string
  ttsPath?: string
  sttPath?: string
  healthPath?: string
  authMode?: VoiceByoAuthMode
  authHeader?: string
  authToken?: string
  authSavedKeyRef?: string
  timeoutMs?: number
  tags?: string[]
  iconRef?: IconRef | null
  ttsDefaults?: VoiceEngineTtsDefaults
  sttDefaults?: VoiceEngineSttDefaults
  uiSchema?: VoiceEngineUiSchema
}

export interface VoiceEngineRecord extends VoiceByoProviderConfig {
  requestFormat?: VoiceEngineRequestFormat
  voicesPath?: string
  expression?: VoiceEngineExpressionContract
  voiceDiscovery?: VoiceEngineVoiceDiscovery
  voiceSurface?: VoiceEngineVoiceSurface
  suite?: VoiceEngineSuiteConfig
  readiness?: VoiceEngineReadinessContract
  runtimeCompatibility?: VoiceEngineRuntimeCompatibility
  localRuntime?: VoiceEngineLocalRuntimeConfig
  sttModelCatalog?: VoiceEngineModelCatalog
  realtimeStt?: VoiceEngineRealtimeSttConfig
}

export interface VoiceEngineClientSummary
  extends Omit<
    VoiceEngineRecord,
    | 'adapterId'
    | 'endpointId'
    | 'baseUrl'
    | 'ttsPath'
    | 'sttPath'
    | 'healthPath'
    | 'authMode'
    | 'authHeader'
    | 'authToken'
    | 'authSavedKeyRef'
    | 'timeoutMs'
    | 'localRuntime'
  > {
  providerId: `byo:${string}`
  hasAuthToken?: boolean
  localRuntime?: VoiceEngineLocalRuntimeSummary
}

export interface VoiceTtsConfig {
  providerId?: VoiceProviderId
  modelId?: string
  voiceId?: string
  profileId?: string
  common?: VoiceCommonOptions
  narration?: VoiceTtsNarrationSettings
  providerOptions?: VoiceProviderOptionsMap
}

export interface VoiceSttConfig {
  providerId?: VoiceProviderId
  modelId?: string
  language?: string
  providerOptions?: VoiceProviderOptionsMap
}

export type VoiceModeSubmitMode = 'auto' | 'manual'
export type VoiceModeInputMode = 'stt' | 'text'

export interface VoiceModeTurnSettings {
  inputMode?: VoiceModeInputMode
  submitMode?: VoiceModeSubmitMode
  autoSubmitDelayMs?: number
  endOfTurnThreshold?: number
}

export interface VoiceTtsEnginePromptSettings {
  prompt?: string
}

export type VoiceTtsEnginePromptMap = Record<string, VoiceTtsEnginePromptSettings>

export interface VoiceTtsEngineSettings {
  common?: VoiceCommonOptions
  providerOptions?: VoiceProviderOptionBlock
}

export interface VoiceSttEngineSettings {
  language?: string
  providerOptions?: VoiceProviderOptionBlock
}

export type VoiceTtsEngineSettingsMap = Record<string, VoiceTtsEngineSettings>
export type VoiceSttEngineSettingsMap = Record<string, VoiceSttEngineSettings>

export interface VoiceSettings {
  schemaVersion?: number
  inputDeviceId?: string | null
  voiceSessionRuntime?: VoiceSessionRuntime
  voiceRuntimes?: VoiceRuntimeSettings
  goonLipSync?: GoonLipSyncSettings
  tts?: VoiceTtsConfig
  // Normal transcription lane: mic dictation and uploaded-audio STT.
  stt?: VoiceSttConfig
  // Voice Mode conversation lane: realtime when supported, recorded-turn STT otherwise.
  realtimeStt?: VoiceSttConfig
  voiceMode?: VoiceModeTurnSettings
  ttsEnginePrompts?: VoiceTtsEnginePromptMap
  ttsEngineSettings?: VoiceTtsEngineSettingsMap
  sttEngineSettings?: VoiceSttEngineSettingsMap
  // Legacy-only: server-owned engine registry now lives outside normal settings hydration.
  byoProviders?: VoiceByoProviderConfig[]
}

export interface AgentVoiceProfile {
  schemaVersion?: number
  voiceSessionRuntime?: VoiceSessionRuntime
  voiceModeInputMode?: VoiceModeInputMode
  voiceMode?: VoiceModeTurnSettings
  tts?: VoiceTtsConfig
  // Normal transcription lane: mic dictation and uploaded-audio STT.
  stt?: VoiceSttConfig
  // Voice Mode conversation lane: realtime when supported, recorded-turn STT otherwise.
  realtimeStt?: VoiceSttConfig
}

export interface VoiceProfileRecord {
  id: string
  user_id: string
  name: string
  provider: VoiceProviderId
  voiceId: string
  model?: string
  description?: string
  isClone?: boolean
  settings?: Record<string, any>
  created_at: string
  updated_at: string
}

export interface VoiceProviderCapabilities {
  tts: boolean
  stt: boolean
  listVoices: boolean
  clone: boolean
  streaming: boolean
  styles: boolean
  emotions: boolean
}

export type VoiceSttRuntimeSupport = 'supported' | 'candidate' | 'unsupported' | 'not_applicable'
export type VoiceSttTransport =
  | 'browser-api'
  | 'http-upload'
  | 'provider-websocket'
  | 'provider-realtime-session'
  | 'local-runtime'
  | 'byo-runtime'
  | 'none'

export type VoiceSttCostClass = 'free' | 'paid' | 'local' | 'varies'
export type VoiceSttPrivacyClass = 'browser-dependent' | 'cloud' | 'local' | 'byo'
export type VoiceSttSetupWeight = 'none' | 'light' | 'medium' | 'heavy' | 'advanced'

export interface VoiceSttCapabilityProfile {
  recorded: boolean
  realtime: boolean
  turnDetection: boolean
  vad: boolean
  partialResults: boolean
  finalResults: boolean
  wordTimestamps: boolean
  diarization: boolean
  languageDetection: boolean
  keyterms: boolean
  transport: VoiceSttTransport
  runtimeSupport: VoiceSttRuntimeSupport
  cost: VoiceSttCostClass
  privacy: VoiceSttPrivacyClass
  setupWeight: VoiceSttSetupWeight
  runtimeLabel?: string
  unsupportedReason?: string
  notes?: string[]
}

export interface VoiceProviderSummary {
  id: VoiceProviderId
  label: string
  type: 'cloud' | 'local' | 'browser' | 'byo'
  requiresKey?: boolean
  supports: VoiceProviderCapabilities
  defaultModel?: string
  defaultTtsModel?: string
  defaultSttModel?: string
  defaultRealtimeSttModel?: string
  defaultVoice?: string
  ttsModels?: string[]
  sttModels?: string[]
  realtimeSttModels?: string[]
  ready?: boolean
  statusHint?: string
  sttCapabilities?: VoiceSttCapabilityProfile
  voiceSurface?: VoiceEngineVoiceSurface
  suite?: VoiceEngineSuiteConfig
}

export interface VoiceSummary {
  id: string
  name: string
  category?: string
  language?: string
  previewUrl?: string
  isDefault?: boolean
  isClone?: boolean
  provider?: VoiceProviderId
}

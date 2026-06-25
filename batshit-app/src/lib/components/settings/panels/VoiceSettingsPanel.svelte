<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import * as Label from '$lib/components/ui/label'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import * as Tabs from '$lib/components/ui/tabs'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { Slider } from '$lib/components/ui/slider'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
  import CreateVoiceCloneCard from '$lib/components/settings/voice/CreateVoiceCloneCard.svelte'
  import SavedVoiceClonesPanel from '$lib/components/settings/voice/SavedVoiceClonesPanel.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import type { UserSettingsRow } from '$lib/types/database'
  import type {
    GoonLipSyncMode,
    GoonLipSyncPremiumAnalyzerId,
    VoiceItalicNarrationBehavior,
    VoiceModeInputMode,
    VoiceModeSubmitMode,
    VoiceSessionRuntime,
    VoiceProviderId,
    VoiceProviderSummary,
    VoiceSettings,
    VoiceSummary,
    VoiceProfileRecord,
    VoiceEngineClientSummary,
    VoiceEngineModelCatalogEntry,
    VoiceEngineUiField,
    VoiceEngineUiSchema
  } from '$lib/types/voice'
  import {
    BROWSER_STT_CAPABILITIES,
    DEEPGRAM_STT_CAPABILITIES,
    ELEVENLABS_STT_CAPABILITIES,
    FISH_STT_CAPABILITIES,
    MISTRAL_STT_CAPABILITIES,
    OPENAI_STT_CAPABILITIES,
    getVoiceCapabilityFields,
    type VoiceCapabilityField
  } from '$lib/data/voiceCapabilityRegistry'
  import { voiceService, type VoiceConfig } from '$lib/services/voice'
  import {
    DEFAULT_TTS_ITALIC_NARRATION_BEHAVIOR,
    DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
    DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD,
    DEFAULT_VOICE_MODE_INPUT_MODE,
    DEFAULT_VOICE_MODE_SUBMIT_MODE,
    MAX_TTS_ENGINE_PROMPT_CHARS,
    MAX_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
    MAX_VOICE_MODE_END_OF_TURN_THRESHOLD,
    MIN_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
    MIN_VOICE_MODE_END_OF_TURN_THRESHOLD,
    normalizeAgentVoiceProfile,
    normalizeTtsEnginePromptText,
    normalizeVoiceModeTurnSettings,
    normalizeVoiceSettings
  } from '$lib/utils/voiceSchema'
  import {
    DEFAULT_GOON_LIP_SYNC_VISEME_BLEND_MS,
    MAX_GOON_LIP_SYNC_VISEME_BLEND_MS,
    MIN_GOON_LIP_SYNC_VISEME_BLEND_MS,
    normalizeGoonLipSyncVisemeBlendMs
  } from '$lib/utils/goonLipSync'
  import { VOICE_ENGINES_UPDATED_EVENT } from '$lib/utils/voiceEngineEvents'
  import { DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER } from '$lib/goons/lipSyncLab'
  import { DEFAULT_VOICE_ENGINE_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import { loadMicrophoneDeviceOptions } from '$lib/utils/microphoneDevices'
  import type { IconRef } from '$lib/icons/iconTypes'
  import {
    AlertCircle,
    AudioLines,
    Check,
    ChevronDown,
    Download,
    Loader2,
    Mic,
    Pencil,
    Plus,
    RefreshCcw,
    Settings2,
    Trash2,
    Play,
    Radio,
    Waves
  } from '@lucide/svelte'

  const SAVE_DEBOUNCE_MS = 600
  const DEFAULT_TEST_PHRASE = 'Hey! This is a quick voice test from Batshit.'
  const LIVEKIT_DOCKER_PROFILE_COMMAND = './start-docker.sh --profile livekit'
  const LIVEKIT_DOCKER_COMPOSE_COMMAND =
    'docker compose --env-file .env.docker --profile livekit up -d --build livekit livekit-agent'
  const DEFAULT_EXISTING_ENGINE_FORM: ExistingEngineForm = {
    name: '',
    engineId: '',
    baseUrl: '',
    supportsTts: true,
    supportsStt: false,
    requestFormat: 'openai-compatible',
    healthPath: '/health',
    ttsPath: '/v1/audio/speech',
    sttPath: '/v1/audio/transcriptions',
    modelId: '',
    voiceId: '',
    language: ''
  }

  type PanelData = {
    user?: { id: string } | null
    userSettings?: UserSettingsRow | null
  } | null

  let { data = null }: { data?: PanelData } = $props()

  type VoiceCommonForm = {
    speed?: string
    volume?: string
    language?: string
    instructions?: string
  }

  type VoiceTtsEngineSettingsForm = {
    common?: VoiceCommonForm
    providerOptions?: Record<string, string | boolean>
  }

  type VoiceSttEngineSettingsForm = {
    language?: string
    providerOptions?: Record<string, string | boolean>
  }

  type VoiceSettingsForm = {
    inputDeviceId?: string | null
    voiceSessionRuntime?: VoiceSessionRuntime
    liveKitAutoStartOnLaunch?: boolean
    goonLipSyncMode?: GoonLipSyncMode
    goonLipSyncAnalyzerId?: GoonLipSyncPremiumAnalyzerId
    goonLipSyncBlendMs?: number
    sttProvider?: VoiceProviderId
    sttModel?: string
    realtimeSttProvider?: VoiceProviderId
    realtimeSttModel?: string
    voiceModeInputMode?: VoiceModeInputMode
    voiceModeSubmitMode?: VoiceModeSubmitMode
    voiceModeAutoSubmitDelayMs?: number
    voiceModeEndOfTurnThreshold?: number
    ttsProvider?: VoiceProviderId
    ttsModel?: string
    ttsVoiceId?: string
    ttsProfileId?: string
    ttsItalicNarrationBehavior?: VoiceItalicNarrationBehavior
    ttsEnginePrompts?: Record<string, string>
    ttsEngineSettings?: Record<string, VoiceTtsEngineSettingsForm>
    sttEngineSettings?: Record<string, VoiceSttEngineSettingsForm>
  }

  type VoiceSettingsTab = 'global' | 'studio' | 'engine-manager'
  type VoiceEngineSectionId = 'runtimes' | 'tts' | 'stt' | 'installed'
  type ExistingEngineRequestFormat = 'openai-compatible' | 'batshit-byo'
  type ExistingEngineForm = {
    name: string
    engineId: string
    baseUrl: string
    supportsTts: boolean
    supportsStt: boolean
    requestFormat: ExistingEngineRequestFormat
    healthPath: string
    ttsPath: string
    sttPath: string
    modelId: string
    voiceId: string
    language: string
  }
  type ProviderModelOption = {
    value: string
    isDefault: boolean
  }
  type LiveKitRuntimeManagerStatus = {
    id: 'livekit'
    name: 'LiveKit'
    installed: boolean
    selected: boolean
    autoStartOnLaunch: boolean
    status: 'ready' | 'not-installed' | 'not-configured' | 'unreachable' | 'starting' | 'error'
    statusHint: string
    healthUrl: string
    agentName: string | null
    activeJobs?: number | null
    logPath?: string | null
    pid?: number | null
    server?: {
      managed: boolean
      status: 'ready' | 'not-managed' | 'not-installed' | 'unreachable' | 'starting' | 'error'
      statusHint: string
      url: string | null
      containerName: string | null
      image: string | null
      installScope?: 'native-managed' | 'docker-sidecar' | 'external'
      version?: string | null
      binaryPath?: string | null
      logPath?: string | null
      pid?: number | null
      started?: boolean
      alreadyRunning?: boolean
    }
    started?: boolean
    alreadyRunning?: boolean
    restarted?: boolean
  }

  function resolveProviderSetupHint(
    provider: VoiceProviderSummary | null,
    mode: 'tts' | 'stt'
  ): string | null {
    if (!provider || provider.ready !== false) return null

    const statusHint = provider.statusHint?.trim()
    if (statusHint?.toLowerCase().includes('api key missing')) {
      const action = mode === 'tts' ? 'voice preview/playback' : 'transcription'
      return `${provider.label} requires an API key. Add it in Settings -> API Keys, then retry ${action}.`
    }

    if (provider.type === 'byo') {
      return (
        statusHint ??
        'This BYO engine needs attention. Ask your agent to verify wiring/health and publish updates.'
      )
    }

    return statusHint ?? `${provider.label} is not ready yet.`
  }

  let settings = $state<VoiceSettingsForm>(normaliseSettings(null))
  let persistedSignature = $state(makeSignature(normaliseSettings(null)))
  let byoEngines = $state<VoiceEngineClientSummary[]>([])
  let persistedEngineSignature = $state(makeEngineSignature([]))
  let isLoading = $state(true)
  let settingsSaveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle')
  let settingsSaveError = $state<string | null>(null)
  let engineSaveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle')
  let engineSaveError = $state<string | null>(null)

  let providerSummaries = $state<VoiceProviderSummary[]>([])
  let providersLoading = $state(false)
  let providersError = $state<string | null>(null)

  let voices = $state<VoiceSummary[]>([])
  let voicesLoading = $state(false)
  let voicesError = $state<string | null>(null)
  let voiceListKey = $state('')

  $effect(() => {
    if (!isLoading) return
    const next = normaliseSettings(data?.userSettings?.voice_settings)
    settings = { ...next }
    persistedSignature = makeSignature(next)
  })

  let profiles = $state<VoiceProfileRecord[]>([])
  let profilesLoading = $state(false)
  let profilesError = $state<string | null>(null)

  let inputDevices = $state<Array<{ id: string; label: string }>>([])
  let inputDevicesLoading = $state(false)
  let inputDevicesError = $state<string | null>(null)

  let testPhrase = $state(DEFAULT_TEST_PHRASE)
  let previewBusy = $state(false)

  let cloneProvider = $state<string>('')
  let cloneName = $state('')
  let cloneReferenceText = $state('')
  let cloneConsent = $state(false)
  let cloneFile = $state<File | null>(null)
  let clonePreviewUrl = $state<string | null>(null)
  let cloneBusy = $state(false)
  let cloneError = $state<string | null>(null)
  let cloneTranscribeProvider = $state<string>('')
  let cloneTranscribeBusy = $state(false)
  let cloneTranscribeError = $state<string | null>(null)
  let selectedCloneId = $state<string | null>(null)
  let activeTab = $state<VoiceSettingsTab>('global')
  let ttsEnginePromptEditorOpen = $state(false)
  let ttsEnginePromptEditorProvider = $state<VoiceProviderSummary | null>(null)
  let openVoiceEngineSectionId = $state<VoiceEngineSectionId | null>('tts')
  let openTtsEngineAccordionId = $state<string | null>(null)
  let openSttEngineAccordionId = $state<string | null>(null)

  let sttModelManual = $state(false)
  let realtimeSttModelManual = $state(false)
  let ttsModelManual = $state(false)
  let ttsVoiceManual = $state(false)
  const goonLipSyncOptions: Array<{
    value: 'amplitude' | GoonLipSyncPremiumAnalyzerId
    label: string
    mode: GoonLipSyncMode
    analyzerId: GoonLipSyncPremiumAnalyzerId
  }> = [
    {
      value: 'amplitude',
      label: 'Shitty but Fast',
      mode: 'amplitude',
      analyzerId: DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER
    },
    {
      value: 'rhubarb-wasm',
      label: 'Rhubarb WASM',
      mode: 'viseme',
      analyzerId: 'rhubarb-wasm'
    }
  ]
  const selectedGoonLipSyncOption = $derived.by(() => {
    const selectedValue =
      settings.goonLipSyncMode === 'viseme'
        ? (settings.goonLipSyncAnalyzerId ?? DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER)
        : 'amplitude'

    return goonLipSyncOptions.find((option) => option.value === selectedValue) ?? goonLipSyncOptions[0]
  })
  const selectedGoonLipSyncBadgeClass = $derived(
    settings.goonLipSyncMode === 'viseme'
      ? 'batshit-settings-pill is-info'
      : 'batshit-settings-pill'
  )
  const selectedInputDeviceLabel = $derived.by(() => {
    if (settings.inputDeviceId) {
      return (
        inputDevices.find((device) => device.id === settings.inputDeviceId)?.label ??
        'Selected microphone'
      )
    }

    const defaultDevice = inputDevices.find((device) => device.id === 'default')
    return defaultDevice?.label ? `System default (${defaultDevice.label})` : 'System default'
  })
  const selectedInputDeviceBadgeLabel = $derived(
    settings.inputDeviceId ? 'Selected mic' : 'System default'
  )
  const goonLipSyncBlendMs = $derived(
    normalizeGoonLipSyncVisemeBlendMs(
      settings.goonLipSyncBlendMs,
      DEFAULT_GOON_LIP_SYNC_VISEME_BLEND_MS
    )
  )

  function handleGoonLipSyncChange(value: string) {
    const nextOption = goonLipSyncOptions.find((option) => option.value === value)
    if (!nextOption) return
    handleSettingsChange({
      goonLipSyncMode: nextOption.mode,
      goonLipSyncAnalyzerId: nextOption.analyzerId
    })
  }

  function handleGoonLipSyncBlendChange(value: number | number[]) {
    const nextValue = Array.isArray(value) ? value[0] : value
    handleSettingsChange({
      goonLipSyncBlendMs: normalizeGoonLipSyncVisemeBlendMs(nextValue)
    })
  }

  function buildProviderModelOptions(models: string[], defaultModel?: string | null): ProviderModelOption[] {
    const merged = new Map<string, ProviderModelOption>()
    const trimmedDefault = defaultModel?.trim()

    for (const model of models) {
      const trimmed = model.trim()
      if (!trimmed) continue
      merged.set(trimmed, {
        value: trimmed,
        isDefault: trimmedDefault === trimmed
      })
    }

    if (trimmedDefault && !merged.has(trimmedDefault)) {
      merged.set(trimmedDefault, {
        value: trimmedDefault,
        isDefault: true
      })
    }

    return Array.from(merged.values())
  }

  function resolveDisplayedModel(
    selectedModel: string | undefined,
    options: ProviderModelOption[],
    defaultModel?: string | null
  ) {
    const trimmedSelected = selectedModel?.trim()
    if (trimmedSelected) return trimmedSelected
    const trimmedDefault = defaultModel?.trim()
    if (trimmedDefault) return trimmedDefault
    if (options.length > 0) return options[0]?.value ?? ''
    return ''
  }

  function formatSttCostLabel(cost?: string) {
    if (cost === 'free') return 'Free'
    if (cost === 'paid') return 'Paid'
    if (cost === 'local') return 'Local'
    return 'Varies'
  }

  function formatSttPrivacyLabel(privacy?: string) {
    if (privacy === 'browser-dependent') return 'Browser'
    if (privacy === 'cloud') return 'Cloud'
    if (privacy === 'local') return 'Local'
    if (privacy === 'byo') return 'BYO'
    return 'Provider'
  }

  function getLiveKitRuntimeStatusLabel(runtime: LiveKitRuntimeManagerStatus | null) {
    if (liveKitRuntimeLoading && liveKitRuntimeAction === 'refresh') return 'Checking'
    if (liveKitRuntimeLoading && liveKitRuntimeAction === 'install') return 'Installing'
    if (!runtime) return 'Unknown'
    if (runtime.status === 'ready') return 'Ready'
    if (runtime.status === 'not-installed') return 'Not installed'
    if (runtime.status === 'not-configured') return 'Needs setup'
    if (runtime.status === 'starting') return 'Starting'
    if (runtime.status === 'error') return 'Error'
    return 'Offline'
  }

  function getLiveKitRuntimeBadgeClass(runtime: LiveKitRuntimeManagerStatus | null) {
    if (liveKitRuntimeLoading && liveKitRuntimeAction === 'refresh') return 'batshit-settings-pill'
    if (runtime?.status === 'ready') return 'batshit-settings-pill is-success'
    if (runtime?.status === 'not-installed' || runtime?.status === 'not-configured') {
      return 'batshit-settings-pill is-warning'
    }
    if (runtime?.status === 'error') return 'batshit-settings-pill is-danger'
    return 'batshit-settings-pill'
  }

  function isDockerLiveKitRuntime(runtime: LiveKitRuntimeManagerStatus | null) {
    if (runtime?.server?.installScope === 'docker-sidecar') return true
    const serverContainer = runtime?.server?.containerName?.toLowerCase().trim()
    const healthUrl = runtime?.healthUrl?.toLowerCase() ?? ''
    const statusHint = runtime?.statusHint?.toLowerCase() ?? ''
    return (
      serverContainer === 'livekit' ||
      healthUrl.includes('livekit-agent') ||
      statusHint.includes('docker runtime add-on')
    )
  }

  function shouldShowLiveKitSetupPanel(runtime: LiveKitRuntimeManagerStatus | null) {
    if (liveKitRuntimeLoading && !runtime) return false
    return !runtime || runtime.status !== 'ready'
  }

  function getLiveKitRuntimeStartLabel(runtime: LiveKitRuntimeManagerStatus | null) {
    if (runtime?.status === 'ready') return 'Restart'
    if (isDockerLiveKitRuntime(runtime)) return 'Start Add-on'
    if (runtime?.status === 'not-installed' || runtime?.status === 'not-configured') {
      return 'Install'
    }
    return 'Start'
  }

  function shouldInstallNativeLiveKitRuntime(runtime: LiveKitRuntimeManagerStatus | null) {
    return (
      runtime !== null &&
      !isDockerLiveKitRuntime(runtime) &&
      (runtime.status === 'not-installed' || runtime.status === 'not-configured')
    )
  }

  function liveKitRuntimeStartDisabled(runtime: LiveKitRuntimeManagerStatus | null) {
    return liveKitRuntimeLoading || runtime?.status === 'starting'
  }

  function getLiveKitSetupTitle(runtime: LiveKitRuntimeManagerStatus | null) {
    if (isDockerLiveKitRuntime(runtime)) return 'Optional Docker add-on'
    if (runtime?.status === 'not-installed') return 'Native local install'
    if (runtime?.status === 'not-configured') return 'Native local install or external server'
    return 'LiveKit needs attention'
  }

  function getLiveKitSetupBody(runtime: LiveKitRuntimeManagerStatus | null) {
    if (isDockerLiveKitRuntime(runtime)) {
      return 'LiveKit runs outside the core Batshit app container. Use Start Add-on when the Docker operator is available, or start Docker with the LiveKit profile.'
    }
    if (runtime?.status === 'not-installed') {
      return 'Install downloads the verified LiveKit Server runtime, installs the Batshit sidecar under the managed runtime folder, saves local Voice Runtime credentials, and starts both services.'
    }
    if (runtime?.status === 'not-configured') {
      return 'Click Install for Batshit to create a local managed LiveKit runtime, or save an external LiveKit URL, API key, and API secret in API Keys -> Voice Runtime.'
    }
    return 'Save the LiveKit URL, API key, and API secret in API Keys -> Voice Runtime, then refresh this row.'
  }

  function providerSupportsTranscribe(provider: VoiceProviderSummary): boolean {
    if (!provider.supports.stt) return false
    if (provider.id === 'browser') return true
    const capabilities = provider.sttCapabilities
    return capabilities ? capabilities.recorded : true
  }

  function providerSupportsVoiceModeStt(provider: VoiceProviderSummary): boolean {
    if (!provider.supports.stt) return false
    const capabilities = provider.sttCapabilities
    if (!capabilities) return provider.id === 'browser'
    return capabilities.recorded || (capabilities.realtime && capabilities.runtimeSupport === 'supported')
  }

  function providerHasRealtimeVoiceMode(provider: VoiceProviderSummary): boolean {
    const capabilities = provider.sttCapabilities
    if (!capabilities) return provider.id === 'browser'
    return capabilities.realtime && capabilities.runtimeSupport === 'supported'
  }

  function providerUsesRecordedVoiceMode(provider: VoiceProviderSummary | null): boolean {
    if (!provider) return false
    const capabilities = provider.sttCapabilities
    if (!capabilities) return false
    return capabilities.recorded && !(capabilities.realtime && capabilities.runtimeSupport === 'supported')
  }

  function getVoiceModeSubmitModeLabel(mode?: VoiceModeSubmitMode | null) {
    return mode === 'manual' ? 'Manual Turn' : 'Auto Listen'
  }

  function getManualTurnUnavailableReason({
    runtime,
    inputMode,
    provider
  }: {
    runtime: VoiceSessionRuntime
    inputMode: VoiceModeInputMode
    provider: VoiceProviderSummary | null
  }) {
    if (runtime === 'livekit') {
      return 'Manual Turn is for Direct Voice Mode recorded-turn STT. LiveKit manages the microphone room continuously.'
    }
    if (inputMode === 'text') {
      return 'Manual Turn is not used with Text Input because you send composer text yourself.'
    }
    if (provider && providerHasRealtimeVoiceMode(provider)) {
      return 'Manual Turn is disabled because Voice Mode STT is a realtime mic provider.'
    }
    return 'Manual Turn is only available for Direct Voice Mode with a recorded-turn STT provider.'
  }

  function getSttModelsForLane(
    provider: VoiceProviderSummary | null,
    lane: 'transcribe' | 'realtime'
  ): string[] {
    if (!provider) return []
    if (lane === 'realtime' && providerHasRealtimeVoiceMode(provider)) {
      return provider.realtimeSttModels?.length ? provider.realtimeSttModels : (provider.sttModels ?? [])
    }
    return provider.sttModels ?? []
  }

  function getDefaultSttModelForLane(
    provider: VoiceProviderSummary | null,
    lane: 'transcribe' | 'realtime'
  ): string | null {
    if (!provider) return null
    if (lane === 'realtime' && providerHasRealtimeVoiceMode(provider)) {
      return provider.defaultRealtimeSttModel ?? provider.realtimeSttModels?.[0] ?? null
    }
    return provider.defaultSttModel ?? (!provider.supports.tts ? provider.defaultModel ?? null : null)
  }

  function getVoiceRuntimeLabel(runtime?: VoiceSessionRuntime | null) {
    return runtime === 'livekit' ? 'LiveKit Bridge (room + sidecar)' : 'Direct Voice Mode (STT + TTS)'
  }

  function getVoiceRuntimeBadgeClass(runtime?: VoiceSessionRuntime | null) {
    return runtime === 'livekit'
      ? 'batshit-settings-pill is-info'
      : 'batshit-settings-pill is-success'
  }

  function getVoiceRuntimeSummary(runtime?: VoiceSessionRuntime | null) {
    if (runtime === 'livekit') {
      return 'The ChatBar Voice button opens a LiveKit room. Bridge mode still uses the Voice Mode STT and TTS choices below.'
    }
    return 'The ChatBar Voice button uses Batshit STT for listening and TTS for spoken replies.'
  }

  function getVoiceModeInputLabel(mode?: VoiceModeInputMode | null) {
    return mode === 'text' ? 'Text Input' : 'Mic STT'
  }

  function resolveProviderById(providerId?: string | null): VoiceProviderSummary | null {
    if (!providerId) return null
    return providerOptions.find((provider) => provider.id === providerId) ?? null
  }

  function resolveProviderLabel(providerId?: string | null) {
    return resolveProviderById(providerId)?.label ?? providerId ?? 'Not configured'
  }

  function getTranscribeSttLaneLabel(provider: VoiceProviderSummary | null) {
    if (!provider) return 'Not configured'
    if (provider.id === 'browser') return 'Dictation'
    return provider.sttCapabilities?.recorded ? 'Recorded audio' : 'Dictation'
  }

  function getVoiceModeSttLaneLabel(provider: VoiceProviderSummary | null) {
    if (!provider) return 'Not configured'
    const capabilities = provider.sttCapabilities
    if (!capabilities) return provider.id === 'browser' ? 'Realtime mic' : 'Unknown'
    if (capabilities.realtime && capabilities.runtimeSupport === 'supported') return 'Realtime mic'
    if (capabilities.recorded) return 'Recorded turn'
    if (capabilities.runtimeSupport === 'candidate') return 'Realtime candidate'
    return 'Unavailable'
  }

  function getVoiceModeSttBadgeClass(provider: VoiceProviderSummary | null) {
    const capabilities = provider?.sttCapabilities
    if (!provider) return 'batshit-settings-pill'
    if (!capabilities && provider.id === 'browser') return 'batshit-settings-pill is-success'
    if (capabilities?.realtime && capabilities.runtimeSupport === 'supported') {
      return 'batshit-settings-pill is-success'
    }
    if (capabilities?.recorded) return 'batshit-settings-pill is-warning'
    if (capabilities?.runtimeSupport === 'candidate') return 'batshit-settings-pill is-info'
    return 'batshit-settings-pill is-danger'
  }

  function getVoiceModeSttNotice(provider: VoiceProviderSummary | null) {
    if (!provider) return null
    const capabilities = provider.sttCapabilities
    if (!capabilities) return null
    if (capabilities.realtime && capabilities.runtimeSupport === 'supported') return null
    if (capabilities.recorded) {
      return `${provider.label} records one turn at a time in Voice Mode. It is not continuous microphone STT.`
    }
    if (capabilities.runtimeSupport === 'candidate') {
      return `${provider.label} is tracked as a realtime candidate, but it is not wired for Voice Mode yet.`
    }
    return `${provider.label} is not available for Voice Mode STT.`
  }

  function getTtsLaneLabel(provider: VoiceProviderSummary | null) {
    if (!provider) return 'Not configured'
    return provider.supports.streaming ? 'Realtime TTS' : 'Batch TTS'
  }

  function getTtsBadgeClass(provider: VoiceProviderSummary | null) {
    if (!provider) return 'batshit-settings-pill'
    return provider.supports.streaming ? 'batshit-settings-pill is-success' : 'batshit-settings-pill'
  }

  let openEngineAccordionId = $state<string | null>(null)
  let existingEngineFormOpen = $state(false)
  let existingEngineForm = $state<ExistingEngineForm>({ ...DEFAULT_EXISTING_ENGINE_FORM })
  let existingEngineIdTouched = $state(false)
  let existingEngineSaving = $state(false)
  let existingEngineError = $state<string | null>(null)
  let byoEngineHealth = $state<Record<string, { loading: boolean; ready?: boolean; statusHint?: string }>>({})
  let engineModelJobs = $state<Record<string, 'download' | 'use' | 'delete'>>({})
  let deleteLocalFilesByEngineId = $state<Record<string, boolean>>({})
  let liveKitRuntime = $state<LiveKitRuntimeManagerStatus | null>(null)
  let liveKitRuntimeLoading = $state(false)
  let liveKitRuntimeAction = $state<'start' | 'refresh' | 'install' | null>(null)
  let liveKitRuntimeError = $state<string | null>(null)
  let externalVoiceEngineRefreshTimer: ReturnType<typeof setTimeout> | null = null

  const fallbackProviders: VoiceProviderSummary[] = [
    {
      id: 'browser',
      label: 'Browser (Web Speech API)',
      type: 'browser',
      supports: {
        tts: true,
        stt: true,
        listVoices: false,
        clone: false,
        streaming: false,
        styles: false,
        emotions: false
      },
      sttCapabilities: BROWSER_STT_CAPABILITIES,
      sttModels: [],
      ttsModels: []
    },
    {
      id: 'google',
      label: 'Google Gemini (TTS)',
      type: 'cloud',
      requiresKey: true,
      supports: {
        tts: true,
        stt: false,
        listVoices: true,
        clone: false,
        streaming: false,
        styles: false,
        emotions: false
      },
      defaultTtsModel: 'gemini-3.1-flash-tts-preview',
      defaultModel: 'gemini-3.1-flash-tts-preview',
      defaultVoice: 'Kore',
      ttsModels: [
        'gemini-3.1-flash-tts-preview',
        'gemini-2.5-flash-preview-tts',
        'gemini-2.5-pro-preview-tts'
      ]
    },
    {
      id: 'openai',
      label: 'OpenAI',
      type: 'cloud',
      requiresKey: true,
      supports: {
        tts: true,
        stt: true,
        listVoices: true,
        clone: false,
        streaming: false,
        styles: true,
        emotions: false
      },
      defaultTtsModel: 'gpt-4o-mini-tts',
      defaultSttModel: 'gpt-4o-mini-transcribe',
      defaultRealtimeSttModel: 'gpt-realtime-whisper',
      defaultModel: 'gpt-4o-mini-tts',
      sttModels: [
        'gpt-4o-mini-transcribe',
        'gpt-4o-transcribe',
        'gpt-4o-transcribe-diarize',
        'whisper-1'
      ],
      realtimeSttModels: ['gpt-realtime-whisper'],
      sttCapabilities: OPENAI_STT_CAPABILITIES,
      ttsModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']
    },
    {
      id: 'elevenlabs',
      label: 'ElevenLabs',
      type: 'cloud',
      requiresKey: true,
      supports: {
        tts: true,
        stt: true,
        listVoices: true,
        clone: true,
        streaming: false,
        styles: true,
        emotions: true
      },
      defaultSttModel: 'scribe_v2',
      defaultTtsModel: 'eleven_multilingual_v2',
      defaultModel: 'eleven_multilingual_v2',
      sttModels: ['scribe_v2'],
      defaultRealtimeSttModel: 'scribe_v2_realtime',
      realtimeSttModels: ['scribe_v2_realtime'],
      sttCapabilities: ELEVENLABS_STT_CAPABILITIES,
      ttsModels: [
        'eleven_v3',
        'eleven_multilingual_v2',
        'eleven_flash_v2_5',
        'eleven_flash_v2'
      ]
    },
    {
      id: 'deepgram',
      label: 'Deepgram',
      type: 'cloud',
      requiresKey: true,
      supports: {
        tts: true,
        stt: true,
        listVoices: true,
        clone: false,
        streaming: false,
        styles: false,
        emotions: false
      },
      sttModels: [
        'nova-3',
        'nova-3-general',
        'nova-3-medical',
        'nova-2',
        'nova-2-general',
        'nova-2-meeting',
        'nova-2-phonecall',
        'nova-2-finance',
        'nova-2-conversationalai',
        'nova-2-voicemail',
        'nova-2-video',
        'nova-2-medical',
        'nova-2-drivethru',
        'nova-2-automotive',
        'nova-2-atc',
        'whisper',
        'whisper-tiny',
        'whisper-base',
        'whisper-small',
        'whisper-medium',
        'whisper-large'
      ],
      realtimeSttModels: ['flux-general-en', 'flux-general-multi'],
      defaultTtsModel: 'aura-2-asteria-en',
      defaultSttModel: 'nova-3',
      defaultRealtimeSttModel: 'flux-general-en',
      defaultModel: 'aura-2-asteria-en',
      defaultVoice: 'aura-2-asteria-en',
      ttsModels: ['aura-2-asteria-en', 'aura-asteria-en'],
      sttCapabilities: DEEPGRAM_STT_CAPABILITIES
    },
    {
      id: 'fish',
      label: 'Fish Audio',
      type: 'cloud',
      requiresKey: true,
      supports: {
        tts: true,
        stt: true,
        listVoices: true,
        clone: false,
        streaming: true,
        styles: false,
        emotions: false
      },
      defaultSttModel: 'transcribe-1',
      defaultTtsModel: 's2-pro',
      defaultModel: 's2-pro',
      sttModels: ['transcribe-1'],
      ttsModels: ['s2-pro', 's1'],
      sttCapabilities: FISH_STT_CAPABILITIES
    },
    {
      id: 'mistral',
      label: 'Mistral Voxtral',
      type: 'cloud',
      requiresKey: true,
      supports: {
        tts: true,
        stt: true,
        listVoices: true,
        clone: true,
        streaming: false,
        styles: false,
        emotions: false
      },
      defaultTtsModel: 'voxtral-mini-tts-2603',
      defaultSttModel: 'voxtral-mini-latest',
      defaultRealtimeSttModel: 'voxtral-mini-transcribe-realtime-2602',
      defaultModel: 'voxtral-mini-tts-2603',
      ttsModels: ['voxtral-mini-tts-2603'],
      sttModels: ['voxtral-mini-latest', 'voxtral-mini-2602'],
      realtimeSttModels: ['voxtral-mini-transcribe-realtime-2602'],
      sttCapabilities: MISTRAL_STT_CAPABILITIES
    },
  ]

  const providerOptions = $derived(
    providerSummaries.length > 0 ? providerSummaries : fallbackProviders
  )
  const sttProviderOptions = $derived(
    providerOptions.filter(providerSupportsTranscribe)
  )
  const realtimeSttProviderOptions = $derived(
    providerOptions.filter(providerSupportsVoiceModeStt)
  )
  const cloneTranscribeProviderOptions = $derived(
    sttProviderOptions.filter((provider) => provider.id !== 'browser')
  )
  const ttsProviderOptions = $derived(
    providerOptions.filter((provider) => provider.supports.tts)
  )
  const cloneProviderOptions = $derived(
    providerOptions.filter((provider) => provider.supports.clone)
  )

  const selectedTtsProvider = $derived(
    ttsProviderOptions.find((provider) => provider.id === (settings.ttsProvider ?? 'browser')) ?? null
  )

  const selectedSttProvider = $derived(
    sttProviderOptions.find((provider) => provider.id === (settings.sttProvider ?? 'browser')) ?? null
  )
  const selectedRealtimeSttProvider = $derived(
    realtimeSttProviderOptions.find((provider) => provider.id === (settings.realtimeSttProvider ?? 'browser')) ?? null
  )
  const selectedSttProviderSetupHint = $derived(resolveProviderSetupHint(selectedSttProvider, 'stt'))
  const selectedRealtimeSttProviderSetupHint = $derived(
    resolveProviderSetupHint(selectedRealtimeSttProvider, 'stt')
  )
  const selectedTtsProviderSetupHint = $derived(resolveProviderSetupHint(selectedTtsProvider, 'tts'))
  const selectedSttDefaultModel = $derived(getDefaultSttModelForLane(selectedSttProvider, 'transcribe'))
  const selectedRealtimeSttDefaultModel = $derived(
    getDefaultSttModelForLane(selectedRealtimeSttProvider, 'realtime')
  )
  const selectedTtsDefaultModel = $derived(
    selectedTtsProvider?.defaultTtsModel ?? selectedTtsProvider?.defaultModel ?? null
  )
  const selectedSttCapabilities = $derived(selectedSttProvider?.sttCapabilities ?? null)
  const selectedRealtimeSttCapabilities = $derived(selectedRealtimeSttProvider?.sttCapabilities ?? null)
  const selectedVoiceRuntimeLabel = $derived(
    getVoiceRuntimeLabel(settings.voiceSessionRuntime ?? 'direct')
  )
  const selectedVoiceRuntimeSummary = $derived(
    getVoiceRuntimeSummary(settings.voiceSessionRuntime ?? 'direct')
  )
  const selectedVoiceRuntimeBadgeClass = $derived(
    getVoiceRuntimeBadgeClass(settings.voiceSessionRuntime ?? 'direct')
  )
  const selectedTranscribeLaneLabel = $derived(getTranscribeSttLaneLabel(selectedSttProvider))
  const selectedVoiceModeSttLaneLabel = $derived(
    getVoiceModeSttLaneLabel(selectedRealtimeSttProvider)
  )
  const selectedVoiceModeSttBadgeClass = $derived(
    getVoiceModeSttBadgeClass(selectedRealtimeSttProvider)
  )
  const selectedVoiceModeSttNotice = $derived(getVoiceModeSttNotice(selectedRealtimeSttProvider))
  const selectedTtsLaneLabel = $derived(getTtsLaneLabel(selectedTtsProvider))
  const selectedTtsBadgeClass = $derived(getTtsBadgeClass(selectedTtsProvider))
  const currentAgent = $derived(agentStore.getCurrentAgent())
  const currentAgentVoiceProfile = $derived(normalizeAgentVoiceProfile(currentAgent?.voice_profile))
  const currentAgentVoiceOverrideParts = $derived.by(() => {
    const profile = currentAgentVoiceProfile
    const parts: string[] = []
    if (profile?.voiceSessionRuntime) {
      parts.push(`Runtime ${getVoiceRuntimeLabel(profile.voiceSessionRuntime)}`)
    }
    if (profile?.voiceModeInputMode) {
      parts.push(`Voice Mode Input ${getVoiceModeInputLabel(profile.voiceModeInputMode)}`)
    }
    if (profile?.voiceMode?.submitMode) {
      parts.push(`Turn Mode ${getVoiceModeSubmitModeLabel(profile.voiceMode.submitMode)}`)
    }
    if (profile?.realtimeStt?.providerId) {
      const provider = resolveProviderById(profile.realtimeStt.providerId)
      parts.push(
        `Voice Mode STT ${resolveProviderLabel(profile.realtimeStt.providerId)}${
          provider ? ` (${getVoiceModeSttLaneLabel(provider)})` : ''
        }`
      )
    }
    if (profile?.tts?.providerId) {
      parts.push(`TTS ${resolveProviderLabel(profile.tts.providerId)}`)
    }
    if (profile?.stt?.providerId) {
      parts.push(`Transcribe STT ${resolveProviderLabel(profile.stt.providerId)}`)
    }
    return parts
  })
  const currentAgentVoiceOverrideText = $derived(currentAgentVoiceOverrideParts.join(', '))

  const sttModelOptions = $derived(getSttModelsForLane(selectedSttProvider, 'transcribe'))
  const realtimeSttModelOptions = $derived(getSttModelsForLane(selectedRealtimeSttProvider, 'realtime'))
  const ttsModelOptions = $derived(selectedTtsProvider?.ttsModels ?? [])
  const sttProviderModelOptions = $derived.by(() =>
    buildProviderModelOptions(sttModelOptions, selectedSttDefaultModel)
  )
  const realtimeSttProviderModelOptions = $derived.by(() =>
    buildProviderModelOptions(realtimeSttModelOptions, selectedRealtimeSttDefaultModel)
  )
  const ttsProviderModelOptions = $derived.by(() =>
    buildProviderModelOptions(ttsModelOptions, selectedTtsDefaultModel)
  )
  const selectedSttNeedsModel = $derived(
    Boolean(settings.sttModel?.trim()) ||
      sttProviderModelOptions.length > 0 ||
      selectedSttProvider?.type === 'byo' ||
      selectedSttProvider?.type === 'local'
  )
  const sttHasSingleModelOption = $derived(sttProviderModelOptions.length === 1)
  const realtimeSttHasSingleModelOption = $derived(realtimeSttProviderModelOptions.length === 1)
  const ttsHasSingleModelOption = $derived(ttsProviderModelOptions.length === 1)
  const sttDisplayedModel = $derived.by(() =>
    resolveDisplayedModel(settings.sttModel, sttProviderModelOptions, selectedSttDefaultModel)
  )
  const realtimeSttDisplayedModel = $derived.by(() =>
    resolveDisplayedModel(
      settings.realtimeSttModel,
      realtimeSttProviderModelOptions,
      selectedRealtimeSttDefaultModel
    )
  )
  const ttsDisplayedModel = $derived.by(() =>
    resolveDisplayedModel(settings.ttsModel, ttsProviderModelOptions, selectedTtsDefaultModel)
  )
  const selectedRealtimeSttNeedsModel = $derived(
    Boolean(settings.realtimeSttModel?.trim()) || realtimeSttProviderModelOptions.length > 0
  )
  const voiceModeUsesSttInput = $derived(
    (settings.voiceModeInputMode ?? DEFAULT_VOICE_MODE_INPUT_MODE) !== 'text'
  )
  const voiceModeTurnSettings = $derived(
    normalizeVoiceModeTurnSettings({
      inputMode: settings.voiceModeInputMode,
      submitMode: settings.voiceModeSubmitMode,
      autoSubmitDelayMs: settings.voiceModeAutoSubmitDelayMs,
      endOfTurnThreshold: settings.voiceModeEndOfTurnThreshold
    })
  )
  const manualTurnAvailable = $derived(
    (settings.voiceSessionRuntime ?? 'direct') === 'direct' &&
      voiceModeUsesSttInput &&
      providerUsesRecordedVoiceMode(selectedRealtimeSttProvider)
  )
  const effectiveVoiceModeSubmitMode = $derived(
    voiceModeTurnSettings.submitMode === 'manual' && manualTurnAvailable ? 'manual' : 'auto'
  )
  const effectiveVoiceModeSubmitModeLabel = $derived(
    getVoiceModeSubmitModeLabel(effectiveVoiceModeSubmitMode)
  )
  const effectiveVoiceModeSubmitBadgeClass = $derived(
    effectiveVoiceModeSubmitMode === 'manual'
      ? 'batshit-settings-pill is-warning'
      : 'batshit-settings-pill is-success'
  )
  const manualTurnUnavailableReason = $derived(
    getManualTurnUnavailableReason({
      runtime: settings.voiceSessionRuntime ?? 'direct',
      inputMode: settings.voiceModeInputMode ?? DEFAULT_VOICE_MODE_INPUT_MODE,
      provider: selectedRealtimeSttProvider
    })
  )
  const ttsVoiceOptions = $derived.by(() => {
    const provider = settings.ttsProvider ?? 'browser'
    const merged = new Map<string, VoiceSummary>()
    const defaultVoiceId = selectedTtsProvider?.defaultVoice?.trim()
    if (defaultVoiceId) {
      merged.set(defaultVoiceId, {
        id: defaultVoiceId,
        name: defaultVoiceId,
        provider,
        isDefault: true
      })
    }
    selectedTtsProvider?.voiceSurface?.voices?.forEach((voiceId) => {
      const trimmed = voiceId.trim()
      if (!trimmed || merged.has(trimmed)) return
      merged.set(trimmed, {
        id: trimmed,
        name: trimmed,
        provider,
        isDefault: trimmed === defaultVoiceId
      })
    })
    voices.forEach((voice) => {
      const existing = merged.get(voice.id)
      merged.set(voice.id, {
        ...voice,
        isDefault: voice.isDefault ?? existing?.isDefault ?? voice.id === defaultVoiceId
      })
    })
    profiles
      .filter((profile) => profile.provider === provider)
      .forEach((profile) => {
        if (!merged.has(profile.voiceId)) {
          merged.set(profile.voiceId, {
            id: profile.voiceId,
            name: profile.name,
            provider: profile.provider,
            isClone: true,
            isDefault: profile.voiceId === defaultVoiceId
          })
        }
      })
    return Array.from(merged.values())
  })
  const canUseTtsVoiceDropdown = $derived(
    (selectedTtsProvider?.supports.listVoices ?? false) || ttsVoiceOptions.length > 0
  )
  const displayedTtsVoiceId = $derived.by(() => {
    const selected = settings.ttsVoiceId?.trim()
    if (selected) return selected
    const provider = settings.ttsProvider ?? 'browser'
    const selectedProfileId = settings.ttsProfileId?.trim()
    const selectedProfile = selectedProfileId
      ? profiles.find((profile) => profile.id === selectedProfileId && profile.provider === provider)
      : null
    if (selectedProfile?.voiceId) return selectedProfile.voiceId
    return selectedTtsProvider?.defaultVoice?.trim() ?? ''
  })
  const displayedTtsVoiceName = $derived.by(() => {
    if (!displayedTtsVoiceId) return 'Select voice'
    return ttsVoiceOptions.find((voice) => voice.id === displayedTtsVoiceId)?.name ?? displayedTtsVoiceId
  })

  const cloneProviderReady = $derived(
    cloneProviderOptions.find((provider) => provider.id === cloneProvider) ?? null
  )
  const selectedCloneTranscribeProvider = $derived(
    cloneTranscribeProviderOptions.find((provider) => provider.id === cloneTranscribeProvider) ?? null
  )
  const selectedClone = $derived(
    profiles.find((profile) => profile.id === selectedCloneId) ?? null
  )
  const byoEngineProviders = $derived.by(() => {
    return [...byoEngines].sort((left, right) => left.name.localeCompare(right.name))
  })
  const ttsEngineProviders = $derived.by(() => {
    return providerOptions
      .filter((provider) => provider.supports.tts)
      .sort((left, right) => left.label.localeCompare(right.label))
  })
  const sttEngineProviders = $derived.by(() => {
    return providerOptions
      .filter((provider) => provider.supports.stt)
      .sort((left, right) => left.label.localeCompare(right.label))
  })

  $effect(() => {
    if (profiles.length === 0) {
      selectedCloneId = null
      return
    }

    if (!selectedCloneId || !profiles.some((profile) => profile.id === selectedCloneId)) {
      selectedCloneId = profiles[0]?.id ?? null
    }
  })

  $effect(() => {
    if (openTtsEngineAccordionId && !ttsEngineProviders.some((provider) => provider.id === openTtsEngineAccordionId)) {
      openTtsEngineAccordionId = null
    }
  })

  $effect(() => {
    if (openSttEngineAccordionId && !sttEngineProviders.some((provider) => provider.id === openSttEngineAccordionId)) {
      openSttEngineAccordionId = null
    }
  })

  $effect(() => {
    if (!openEngineAccordionId) return
    if (!byoEngines.some((provider) => provider.id === openEngineAccordionId)) {
      openEngineAccordionId = null
    }
  })

  $effect(() => {
    const defaultProvider =
      cloneTranscribeProviderOptions.some((provider) => provider.id === (settings.sttProvider ?? ''))
        ? (settings.sttProvider ?? '')
        : (cloneTranscribeProviderOptions[0]?.id ?? '')

    if (
      !cloneTranscribeProvider ||
      !cloneTranscribeProviderOptions.some((provider) => provider.id === cloneTranscribeProvider)
    ) {
      cloneTranscribeProvider = defaultProvider
    }
  })

  onMount(() => {
    const handleVoiceEnginesUpdated = () => {
      if (externalVoiceEngineRefreshTimer) {
        clearTimeout(externalVoiceEngineRefreshTimer)
      }

      externalVoiceEngineRefreshTimer = setTimeout(() => {
        externalVoiceEngineRefreshTimer = null
        void refreshVoiceEngineState().catch((error) => {
          console.error('Failed to refresh voice engine state after external update:', error)
        })
      }, 250)
    }

    window.addEventListener(VOICE_ENGINES_UPDATED_EVENT, handleVoiceEnginesUpdated as EventListener)

    void (async () => {
      const tasks: Array<Promise<unknown>> = [
        loadSettings(),
        loadByoEngines(),
        loadLiveKitRuntime(),
        loadProviders(),
        loadProfiles(),
        loadInputDevices()
      ]

      await Promise.all(tasks)
    })()

    return () => {
      window.removeEventListener(VOICE_ENGINES_UPDATED_EVENT, handleVoiceEnginesUpdated as EventListener)
      if (externalVoiceEngineRefreshTimer) {
        clearTimeout(externalVoiceEngineRefreshTimer)
        externalVoiceEngineRefreshTimer = null
      }
      clearClonePreviewUrl()
    }
  })

  const debouncedSave = debounce(async (payload: VoiceSettings) => {
    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_settings: payload })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save voice settings')
        throw new Error(message)
      }

      const result = await response.json()
      const updated: UserSettingsRow | null = result?.settings ?? null

      untrack(() => {
        persistedSignature = makeSignature(payload)
        settingsSaveState = 'saved'
        settingsSaveError = null
      })

      if (updated) {
        setUserSettings(updated)
      }
    } catch (error) {
      console.error('Voice settings save failed:', error)
      untrack(() => {
        settingsSaveState = 'error'
        settingsSaveError = error instanceof Error ? error.message : 'Failed to save voice settings'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (settingsSaveState === 'saved') {
            settingsSaveState = 'idle'
          }
        })
      }, 2000)
    }
  }, SAVE_DEBOUNCE_MS)

  const debouncedEngineSave = debounce(async (engines: VoiceEngineClientSummary[]) => {
    try {
      const response = await fetch('/api/voice/byo/engines', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engines: buildEnginePublicPayload(engines) })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save Engine Manager changes')
        throw new Error(message)
      }

      const result = await response.json()
      const updated = Array.isArray(result?.engines) ? result.engines : []

      untrack(() => {
        byoEngines = updated
        persistedEngineSignature = makeEngineSignature(updated)
        engineSaveState = 'saved'
        engineSaveError = null
      })

      await loadProviders()
    } catch (error) {
      console.error('Voice engine registry save failed:', error)
      untrack(() => {
        engineSaveState = 'error'
        engineSaveError = error instanceof Error ? error.message : 'Failed to save Engine Manager changes'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (engineSaveState === 'saved') {
            engineSaveState = 'idle'
          }
        })
      }, 2000)
    }
  }, SAVE_DEBOUNCE_MS)

  $effect(() => {
    if (isLoading) return

    const payload = buildVoiceSettingsPayload(settings)
    const signature = makeSignature(payload)
    if (signature === persistedSignature) {
      return
    }

    settingsSaveState = 'saving'
    settingsSaveError = null
    debouncedSave(payload)
  })

  $effect(() => {
    if (isLoading) return

    const signature = makeEngineSignature(byoEngines)
    if (signature === persistedEngineSignature) {
      return
    }

    engineSaveState = 'saving'
    engineSaveError = null
    debouncedEngineSave(byoEngines)
  })

  $effect(() => {
    const provider = settings.ttsProvider ?? 'browser'
    const model = settings.ttsModel ?? ''
    const current = ttsProviderOptions.find((item) => item.id === provider)

    if (!current?.supports.listVoices) {
      voices = []
      voicesError = null
      voicesLoading = false
      voiceListKey = ''
      return
    }

    const key = `${provider}:${model}`
    if (key === voiceListKey) return

    voiceListKey = key
    void loadVoices(provider, model)
  })

  function toFormTtsEnginePrompts(
    prompts?: VoiceSettings['ttsEnginePrompts']
  ): Record<string, string> | undefined {
    if (!prompts) return undefined

    const output: Record<string, string> = {}
    for (const [providerId, config] of Object.entries(prompts)) {
      const prompt = normalizeTtsEnginePromptText(config?.prompt)
      if (prompt) {
        output[providerId] = prompt
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function buildTtsEnginePromptPayload(
    prompts?: Record<string, string>
  ): VoiceSettings['ttsEnginePrompts'] | undefined {
    if (!prompts) return undefined

    const output: NonNullable<VoiceSettings['ttsEnginePrompts']> = {}
    for (const [providerId, rawPrompt] of Object.entries(prompts)) {
      const prompt = normalizeTtsEnginePromptText(rawPrompt)
      if (prompt) {
        output[providerId] = { prompt }
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function toFormProviderOptionBlock(
    providerOptions?: Record<string, string | number | boolean>
  ): Record<string, string | boolean> | undefined {
    if (!providerOptions) return undefined

    const output: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(providerOptions)) {
      if (typeof value === 'boolean') {
        output[key] = value
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        output[key] = String(value)
      } else if (typeof value === 'string' && value.trim()) {
        output[key] = value
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function toFormTtsEngineSettings(
    engineSettings?: VoiceSettings['ttsEngineSettings']
  ): Record<string, VoiceTtsEngineSettingsForm> | undefined {
    if (!engineSettings) return undefined

    const output: Record<string, VoiceTtsEngineSettingsForm> = {}
    for (const [providerId, config] of Object.entries(engineSettings)) {
      const common: VoiceCommonForm = {
        speed: config.common?.speed != null ? String(config.common.speed) : '',
        volume: config.common?.volume != null ? String(config.common.volume) : '',
        language: config.common?.language ?? '',
        instructions: config.common?.instructions ?? ''
      }
      const providerOptions = toFormProviderOptionBlock(config.providerOptions)
      const hasCommon = Object.values(common).some((value) => value.trim() !== '')

      if (hasCommon || providerOptions) {
        output[providerId] = {
          ...(hasCommon ? { common } : {}),
          ...(providerOptions ? { providerOptions } : {})
        }
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function toFormSttEngineSettings(
    engineSettings?: VoiceSettings['sttEngineSettings']
  ): Record<string, VoiceSttEngineSettingsForm> | undefined {
    if (!engineSettings) return undefined

    const output: Record<string, VoiceSttEngineSettingsForm> = {}
    for (const [providerId, config] of Object.entries(engineSettings)) {
      const providerOptions = toFormProviderOptionBlock(config.providerOptions)
      const language = config.language ?? ''
      if (language.trim() || providerOptions) {
        output[providerId] = {
          ...(language.trim() ? { language } : {}),
          ...(providerOptions ? { providerOptions } : {})
        }
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function buildTtsCommonPayload(
    common?: VoiceCommonForm
  ): NonNullable<VoiceSettings['tts']>['common'] | undefined {
    if (!common) return undefined

    const output: Record<string, string | number> = {}
    const speed = common.speed?.trim() ? Number(common.speed) : undefined
    const volume = common.volume?.trim() ? Number(common.volume) : undefined
    if (typeof speed === 'number' && Number.isFinite(speed)) output.speed = speed
    if (typeof volume === 'number' && Number.isFinite(volume)) output.volume = volume

    const language = normaliseString(common.language)
    const instructions = normaliseString(common.instructions)
    if (language) output.language = language
    if (instructions) output.instructions = instructions

    return Object.keys(output).length > 0
      ? (output as NonNullable<VoiceSettings['tts']>['common'])
      : undefined
  }

  function buildRawProviderOptionPayload(
    providerOptions?: Record<string, string | boolean>
  ): Record<string, string | boolean> | undefined {
    if (!providerOptions) return undefined

    const output: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(providerOptions)) {
      if (typeof value === 'boolean') {
        output[key] = value
      } else if (value.trim()) {
        output[key] = value.trim()
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function getProviderOptionKeyForCapabilityField(providerId: string, field: VoiceCapabilityField) {
    const prefix = `providerOptions.${providerId}.`
    return field.path.startsWith(prefix) ? field.path.replace(prefix, '') : null
  }

  function getCommonKeyForCapabilityField(field: VoiceCapabilityField): keyof VoiceCommonForm | null {
    if (!field.path.startsWith('common.')) return null
    const key = field.path.replace('common.', '')
    return ['speed', 'volume', 'language', 'instructions'].includes(key)
      ? (key as keyof VoiceCommonForm)
      : null
  }

  function getProviderOptionKeyForByoField(field: VoiceEngineUiField) {
    const segments = field.path?.split('.').filter(Boolean) ?? []
    if (segments[1] !== 'providerOptions' || segments.length < 3) return null
    return segments.slice(2).join('.')
  }

  function parseByoUiFieldValue(
    field: VoiceEngineUiField,
    rawInput: string | boolean | undefined
  ): string | number | boolean | undefined {
    if (field.type === 'boolean') return rawInput === true
    if (typeof rawInput !== 'string') return undefined

    if (field.type === 'number') {
      if (!rawInput.trim()) return undefined
      const parsed = Number(rawInput)
      if (!Number.isFinite(parsed)) return undefined
      const min = typeof field.min === 'number' ? field.min : parsed
      const max = typeof field.max === 'number' ? field.max : parsed
      return Math.min(Math.max(parsed, min), max)
    }

    if (field.type === 'select') {
      if (!rawInput.trim()) return undefined
      const decoded = decodeSelectFieldValue(field, rawInput)
      return typeof decoded === 'string' ? decoded.trim() || undefined : decoded ?? undefined
    }

    const trimmed = rawInput.trim()
    return trimmed ? trimmed : undefined
  }

  function buildTtsEngineSettingsPayload(
    engineSettings?: Record<string, VoiceTtsEngineSettingsForm>
  ): VoiceSettings['ttsEngineSettings'] | undefined {
    if (!engineSettings) return undefined

    const output: NonNullable<VoiceSettings['ttsEngineSettings']> = {}
    for (const [providerId, config] of Object.entries(engineSettings)) {
      const common = buildTtsCommonPayload(config.common)
      const providerOptions: Record<string, string | number | boolean> = {}

      const capabilityFields = getBuiltInTtsEngineAdvancedFields(providerId)
      const byoFields = getByoEngineAdvancedFields(providerId, 'tts')

      for (const field of capabilityFields) {
        const key = getProviderOptionKeyForCapabilityField(providerId, field)
        if (!key) continue
        const parsed = parseCapabilityFieldValue(field, config.providerOptions?.[key])
        if (parsed !== undefined) providerOptions[key] = parsed
      }

      for (const field of byoFields) {
        const key = getProviderOptionKeyForByoField(field)
        if (!key) continue
        const parsed = parseByoUiFieldValue(field, config.providerOptions?.[key])
        if (parsed !== undefined) providerOptions[key] = parsed
      }

      if (capabilityFields.length === 0 && byoFields.length === 0) {
        Object.assign(providerOptions, buildRawProviderOptionPayload(config.providerOptions))
      }

      if (common || Object.keys(providerOptions).length > 0) {
        output[providerId] = {
          ...(common ? { common } : {}),
          ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {})
        }
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function buildSttEngineSettingsPayload(
    engineSettings?: Record<string, VoiceSttEngineSettingsForm>
  ): VoiceSettings['sttEngineSettings'] | undefined {
    if (!engineSettings) return undefined

    const output: NonNullable<VoiceSettings['sttEngineSettings']> = {}
    for (const [providerId, config] of Object.entries(engineSettings)) {
      let language = normaliseString(config.language)
      const providerOptions: Record<string, string | number | boolean> = {}

      const capabilityFields = getBuiltInSttEngineAdvancedFields(providerId)
      const byoFields = getByoEngineAdvancedFields(providerId, 'stt')

      for (const field of capabilityFields) {
        if (field.path === 'language') {
          const parsed = parseCapabilityFieldValue(field, config.language)
          if (typeof parsed === 'string') language = parsed
          continue
        }

        const key = getProviderOptionKeyForCapabilityField(providerId, field)
        if (!key) continue
        const parsed = parseCapabilityFieldValue(field, config.providerOptions?.[key])
        if (parsed !== undefined) providerOptions[key] = parsed
      }

      for (const field of byoFields) {
        if (field.path === 'stt.language') {
          const parsed = parseByoUiFieldValue(field, config.language)
          if (typeof parsed === 'string') language = parsed
          continue
        }

        const key = getProviderOptionKeyForByoField(field)
        if (!key) continue
        const parsed = parseByoUiFieldValue(field, config.providerOptions?.[key])
        if (parsed !== undefined) providerOptions[key] = parsed
      }

      if (capabilityFields.length === 0 && byoFields.length === 0) {
        Object.assign(providerOptions, buildRawProviderOptionPayload(config.providerOptions))
      }

      if (language || Object.keys(providerOptions).length > 0) {
        output[providerId] = {
          ...(language ? { language } : {}),
          ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {})
        }
      }
    }

    return Object.keys(output).length > 0 ? output : undefined
  }

  function normaliseSettings(settingsValue: VoiceSettings | undefined | null): VoiceSettingsForm {
    const normalized = normalizeVoiceSettings(settingsValue)
    const tts = normalized.tts
    const stt = normalized.stt
    const realtimeStt = normalized.realtimeStt
    const voiceMode = normalized.voiceMode
    const ttsProvider = tts?.providerId ?? 'browser'

    return {
      inputDeviceId: normalized.inputDeviceId ?? null,
      voiceSessionRuntime: normalized.voiceSessionRuntime ?? 'direct',
      liveKitAutoStartOnLaunch:
        normalized.voiceRuntimes?.livekit?.startup?.autoStartOnLaunch === true,
      goonLipSyncMode: normalized.goonLipSync?.mode ?? 'amplitude',
      goonLipSyncAnalyzerId:
        normalized.goonLipSync?.analyzerId ?? DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER,
      goonLipSyncBlendMs:
        normalized.goonLipSync?.visemeBlendMs ?? DEFAULT_GOON_LIP_SYNC_VISEME_BLEND_MS,
      sttProvider: stt?.providerId ?? 'browser',
      sttModel: stt?.modelId ?? '',
      realtimeSttProvider: realtimeStt?.providerId ?? 'browser',
      realtimeSttModel: realtimeStt?.modelId ?? '',
      voiceModeInputMode: voiceMode?.inputMode ?? DEFAULT_VOICE_MODE_INPUT_MODE,
      voiceModeSubmitMode: voiceMode?.submitMode ?? DEFAULT_VOICE_MODE_SUBMIT_MODE,
      voiceModeAutoSubmitDelayMs:
        voiceMode?.autoSubmitDelayMs ?? DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
      voiceModeEndOfTurnThreshold:
        voiceMode?.endOfTurnThreshold ?? DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD,
      ttsProvider,
      ttsModel: tts?.modelId ?? '',
      ttsVoiceId: tts?.voiceId ?? '',
      ttsProfileId: tts?.profileId ?? '',
      ttsItalicNarrationBehavior:
        tts?.narration?.italicBehavior ?? DEFAULT_TTS_ITALIC_NARRATION_BEHAVIOR,
      ttsEnginePrompts: toFormTtsEnginePrompts(normalized.ttsEnginePrompts),
      ttsEngineSettings: toFormTtsEngineSettings(normalized.ttsEngineSettings),
      sttEngineSettings: toFormSttEngineSettings(normalized.sttEngineSettings)
    }
  }

  function parseCapabilityFieldValue(
    field: VoiceCapabilityField,
    raw: unknown
  ): string | number | boolean | undefined {
    if (field.type === 'boolean') {
      return typeof raw === 'boolean' ? raw : undefined
    }

    if (field.type === 'number') {
      if (typeof raw === 'string' && raw.trim() === '') return undefined
      const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
      if (!Number.isFinite(parsed)) return undefined
      const min = typeof field.min === 'number' ? field.min : parsed
      const max = typeof field.max === 'number' ? field.max : parsed
      return Math.min(Math.max(parsed, min), max)
    }

    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    if (!trimmed) return undefined

    if (field.type === 'select' && Array.isArray(field.options) && !field.options.includes(trimmed)) {
      return undefined
    }

    return trimmed
  }

  function buildVoiceSettingsPayload(form: VoiceSettingsForm): VoiceSettings {
    const ttsProvider = (form.ttsProvider ?? 'browser') as VoiceProviderId
    const sttProvider = (form.sttProvider ?? 'browser') as VoiceProviderId
    const realtimeSttProvider = (form.realtimeSttProvider ?? 'browser') as VoiceProviderId

    const normalizedVoiceMode = normalizeVoiceModeTurnSettings({
      inputMode: form.voiceModeInputMode,
      submitMode: form.voiceModeSubmitMode,
      autoSubmitDelayMs: form.voiceModeAutoSubmitDelayMs,
      endOfTurnThreshold: form.voiceModeEndOfTurnThreshold
    })

    const payload: VoiceSettings = {
      schemaVersion: 2,
      inputDeviceId: form.inputDeviceId || null,
      voiceSessionRuntime: form.voiceSessionRuntime === 'livekit' ? 'livekit' : 'direct',
      voiceRuntimes: {
        livekit: {
          startup: {
            autoStartOnLaunch: form.liveKitAutoStartOnLaunch === true
          }
        }
      },
      goonLipSync: {
        mode: form.goonLipSyncMode ?? 'amplitude',
        analyzerId: form.goonLipSyncAnalyzerId ?? DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER,
        visemeBlendMs: normalizeGoonLipSyncVisemeBlendMs(form.goonLipSyncBlendMs)
      },
      tts: {
        providerId: ttsProvider,
        modelId: normaliseString(form.ttsModel),
        voiceId: normaliseString(form.ttsVoiceId),
        profileId: normaliseString(form.ttsProfileId),
        narration: {
          italicBehavior:
            form.ttsItalicNarrationBehavior ?? DEFAULT_TTS_ITALIC_NARRATION_BEHAVIOR
        }
      },
      stt: {
        providerId: sttProvider,
        modelId: normaliseString(form.sttModel)
      },
      realtimeStt: {
        providerId: realtimeSttProvider,
        modelId: normaliseString(form.realtimeSttModel)
      },
      voiceMode: {
        inputMode: normalizedVoiceMode.inputMode,
        submitMode: normalizedVoiceMode.submitMode,
        autoSubmitDelayMs: normalizedVoiceMode.autoSubmitDelayMs,
        endOfTurnThreshold: normalizedVoiceMode.endOfTurnThreshold
      },
      ttsEnginePrompts: buildTtsEnginePromptPayload(form.ttsEnginePrompts),
      ttsEngineSettings: buildTtsEngineSettingsPayload(form.ttsEngineSettings),
      sttEngineSettings: buildSttEngineSettingsPayload(form.sttEngineSettings)
    }

    return payload
  }

  function makeSignature(value: VoiceSettingsForm | VoiceSettings) {
    const payload =
      ('tts' in value && value.tts !== undefined) ||
      ('stt' in value && value.stt !== undefined) ||
      ('goonLipSync' in value && value.goonLipSync !== undefined)
        ? normalizeVoiceSettings(value)
        : buildVoiceSettingsPayload(value as VoiceSettingsForm)

    return JSON.stringify(payload)
  }

  function buildEnginePublicPayload(engines: VoiceEngineClientSummary[]) {
    return engines.map((engine) => ({
      id: engine.id,
      enabled: engine.enabled !== false,
      iconRef: engine.iconRef ?? null,
      ttsDefaults: engine.ttsDefaults,
      sttDefaults: engine.sttDefaults,
      localRuntime:
        engine.localRuntime?.startup
          ? {
              startup: {
                autoStartOnLaunch: engine.localRuntime.startup.autoStartOnLaunch === true
              }
            }
          : undefined
    }))
  }

  function makeEngineSignature(engines: VoiceEngineClientSummary[]) {
    return JSON.stringify(buildEnginePublicPayload(engines))
  }

  function normaliseString(value?: string | null) {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
  }

  function resolvePreviewVoiceProfile(
    provider: VoiceProviderId,
    voiceId?: string,
    clone?: VoiceProfileRecord | null
  ): VoiceProfileRecord | null {
    if (clone) return clone

    const selectedProfileId = settings.ttsProfileId?.trim()
    if (selectedProfileId) {
      const selectedProfile = profiles.find(
        (profile) => profile.id === selectedProfileId && profile.provider === provider
      )
      if (selectedProfile) return selectedProfile
    }

    if (voiceId) {
      return profiles.find(
        (profile) => profile.provider === provider && profile.voiceId === voiceId
      ) ?? null
    }

    return null
  }

  function makeEngineIdFromName(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .replace(/[-_]{2,}/g, '-')
  }

  function existingEngineDefaultTtsPath(format: ExistingEngineRequestFormat) {
    return format === 'openai-compatible' ? '/v1/audio/speech' : '/tts'
  }

  function existingEngineDefaultSttPath(format: ExistingEngineRequestFormat) {
    return format === 'openai-compatible' ? '/v1/audio/transcriptions' : '/stt'
  }

  function resetExistingEngineForm() {
    existingEngineForm = { ...DEFAULT_EXISTING_ENGINE_FORM }
    existingEngineIdTouched = false
    existingEngineError = null
  }

  function updateExistingEngineForm(updates: Partial<ExistingEngineForm>) {
    existingEngineForm = {
      ...existingEngineForm,
      ...updates
    }
  }

  function handleExistingEngineNameInput(value: string) {
    updateExistingEngineForm({
      name: value,
      engineId: existingEngineIdTouched ? existingEngineForm.engineId : makeEngineIdFromName(value)
    })
  }

  function handleExistingEngineIdInput(value: string) {
    existingEngineIdTouched = true
    updateExistingEngineForm({ engineId: makeEngineIdFromName(value) })
  }

  function handleExistingEngineFormatChange(value: string | string[]) {
    const nextFormat = (Array.isArray(value) ? value[0] : value) as ExistingEngineRequestFormat
    if (nextFormat !== 'openai-compatible' && nextFormat !== 'batshit-byo') return
    updateExistingEngineForm({
      requestFormat: nextFormat,
      ttsPath: existingEngineDefaultTtsPath(nextFormat),
      sttPath: existingEngineDefaultSttPath(nextFormat)
    })
  }

  function toggleExistingEngineCapability(capability: 'tts' | 'stt', value: boolean) {
    const next = {
      ...existingEngineForm,
      ...(capability === 'tts' ? { supportsTts: value } : { supportsStt: value })
    }
    if (!next.supportsTts && !next.supportsStt) {
      next[capability === 'tts' ? 'supportsStt' : 'supportsTts'] = true
    }
    existingEngineForm = next
  }

  async function handleConnectExistingEngine() {
    const engineId = makeEngineIdFromName(existingEngineForm.engineId)
    if (!engineId) {
      existingEngineError = 'Add an engine ID.'
      return
    }
    if (!existingEngineForm.name.trim()) {
      existingEngineError = 'Add an engine name.'
      return
    }
    if (!existingEngineForm.baseUrl.trim()) {
      existingEngineError = 'Add the engine base URL.'
      return
    }

    existingEngineSaving = true
    existingEngineError = null
    try {
      const response = await fetch('/api/voice/byo/engines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engineId,
          payload: {
            name: existingEngineForm.name,
            baseUrl: existingEngineForm.baseUrl,
            supportsTts: existingEngineForm.supportsTts,
            supportsStt: existingEngineForm.supportsStt,
            requestFormat: existingEngineForm.requestFormat,
            healthPath: existingEngineForm.healthPath,
            ttsPath: existingEngineForm.ttsPath,
            sttPath: existingEngineForm.sttPath,
            modelId: existingEngineForm.modelId,
            voiceId: existingEngineForm.voiceId,
            language: existingEngineForm.language,
            enabled: false
          }
        })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to connect existing engine')
        throw new Error(message)
      }

      const result = await response.json()
      const updated = Array.isArray(result?.engines) ? result.engines : []
      untrack(() => {
        byoEngines = updated
        persistedEngineSignature = makeEngineSignature(updated)
        existingEngineFormOpen = false
        resetExistingEngineForm()
      })
      await loadProviders()
      await checkByoEngineHealth(engineId)
      toast.success('Existing voice engine connected')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect existing engine'
      existingEngineError = message
      toast.error(message)
    } finally {
      existingEngineSaving = false
    }
  }

  async function loadSettings() {
    try {
      const response = await fetch('/api/user/settings')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load voice settings')
        throw new Error(message)
      }

      const result = await response.json()
      const remoteSettings: UserSettingsRow | null = result?.settings ?? null
      const next = normaliseSettings(remoteSettings?.voice_settings)

      untrack(() => {
        settings = { ...next }
        persistedSignature = makeSignature(next)
        isLoading = false
      })

      if (remoteSettings) {
        setUserSettings(remoteSettings)
      }
    } catch (error) {
      console.error('Failed to load voice settings:', error)
      const fallback = normaliseSettings(data?.userSettings?.voice_settings)
      untrack(() => {
        settings = { ...fallback }
        persistedSignature = makeSignature(fallback)
        isLoading = false
        settingsSaveState = 'error'
        settingsSaveError = error instanceof Error ? error.message : 'Failed to load voice settings'
      })
    }
  }

  async function loadByoEngines() {
    try {
      const response = await fetch('/api/voice/byo/engines')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load Engine Manager')
        throw new Error(message)
      }

      const result = await response.json()
      const engines = Array.isArray(result?.engines) ? result.engines : []

      untrack(() => {
        byoEngines = engines
        persistedEngineSignature = makeEngineSignature(engines)
      })
    } catch (error) {
      console.error('Failed to load Engine Manager:', error)
      untrack(() => {
        engineSaveState = 'error'
        engineSaveError = error instanceof Error ? error.message : 'Failed to load Engine Manager'
      })
    }
  }

  async function loadLiveKitRuntime() {
    liveKitRuntimeLoading = true
    liveKitRuntimeError = null
    liveKitRuntimeAction = 'refresh'
    try {
      const response = await fetch('/api/voice/runtime/livekit')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load LiveKit runtime')
        throw new Error(message)
      }

      const result = await response.json()
      liveKitRuntime = result?.runtime ?? null
    } catch (error) {
      console.error('Failed to load LiveKit runtime:', error)
      liveKitRuntimeError = error instanceof Error ? error.message : 'Failed to load LiveKit runtime'
    } finally {
      liveKitRuntimeLoading = false
      liveKitRuntimeAction = null
    }
  }

  async function startLiveKitRuntime() {
    const install = shouldInstallNativeLiveKitRuntime(liveKitRuntime)
    const forceRestart = liveKitRuntime?.status === 'ready'
    liveKitRuntimeLoading = true
    liveKitRuntimeError = null
    liveKitRuntimeAction = install ? 'install' : 'start'
    try {
      const response = await fetch('/api/voice/runtime/livekit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: install ? 'install' : 'start',
          forceRestart
        })
      })
      if (!response.ok) {
        const message = await extractError(
          response,
          install ? 'Failed to install LiveKit runtime' : 'Failed to start LiveKit runtime'
        )
        throw new Error(message)
      }

      const result = await response.json()
      liveKitRuntime = result?.runtime ?? null
      const started = liveKitRuntime?.started === true
      const restarted = liveKitRuntime?.restarted === true
      let successMessage = 'LiveKit runtime is already running'
      if (install) {
        successMessage = 'LiveKit native runtime installed'
      } else if (restarted) {
        successMessage = 'LiveKit runtime restarted'
      } else if (started) {
        successMessage = 'LiveKit runtime started'
      }
      toast.success(successMessage)
    } catch (error) {
      console.error('Failed to start LiveKit runtime:', error)
      liveKitRuntimeError = error instanceof Error
        ? error.message
        : install
          ? 'Failed to install LiveKit runtime'
          : 'Failed to start LiveKit runtime'
      toast.error(liveKitRuntimeError)
    } finally {
      liveKitRuntimeLoading = false
      liveKitRuntimeAction = null
    }
  }

  async function refreshVoiceEngineState() {
    await Promise.all([loadByoEngines(), loadLiveKitRuntime(), loadProviders(), loadSettings()])
  }

  async function loadProviders() {
    providersLoading = true
    providersError = null

    try {
      const response = await fetch('/api/voice/providers')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load voice providers')
        throw new Error(message)
      }

      const result = await response.json()
      const items = Array.isArray(result?.providers) ? result.providers : []
      providerSummaries = items
    } catch (error) {
      console.error('Failed to load voice providers:', error)
      providersError = error instanceof Error ? error.message : 'Failed to load voice providers'
    } finally {
      providersLoading = false
    }
  }

  async function loadVoices(provider: string, model: string) {
    voicesLoading = true
    voicesError = null

    try {
      const params = new URLSearchParams({ provider })
      if (model) params.set('model', model)
      const response = await fetch(`/api/voice/voices?${params.toString()}`)

      if (!response.ok) {
        const message = await extractError(response, 'Failed to load voices')
        throw new Error(message)
      }

      const result = await response.json()
      voices = Array.isArray(result?.voices) ? result.voices : []
    } catch (error) {
      console.error('Failed to load voices:', error)
      voicesError = error instanceof Error ? error.message : 'Failed to load voices'
      voices = []
    } finally {
      voicesLoading = false
    }
  }

  async function loadProfiles() {
    profilesLoading = true
    profilesError = null
    try {
      const response = await fetch('/api/voice/profiles')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load voice clones')
        throw new Error(message)
      }

      const result = await response.json()
      profiles = Array.isArray(result?.profiles) ? result.profiles : []
    } catch (error) {
      console.error('Failed to load voice clones:', error)
      profilesError = error instanceof Error ? error.message : 'Failed to load voice clones'
    } finally {
      profilesLoading = false
    }
  }

  async function loadInputDevices(options: { requestPermission?: boolean } = {}) {
    if (!navigator?.mediaDevices?.enumerateDevices) return
    inputDevicesLoading = true
    inputDevicesError = null
    try {
      inputDevices = await loadMicrophoneDeviceOptions({
        mediaDevices: navigator.mediaDevices,
        requestPermission: options.requestPermission === true
      })
    } catch (error) {
      console.warn('Failed to enumerate microphones:', error)
      inputDevicesError =
        error instanceof Error ? error.message : 'Failed to access microphones'
    } finally {
      inputDevicesLoading = false
    }
  }

  function handleSettingsChange(next: Partial<VoiceSettingsForm>) {
    settings = { ...settings, ...next }
  }

  function handleSttProviderChange(provider: string) {
    sttModelManual = false
    handleSettingsChange({
      sttProvider: provider as VoiceProviderId,
      sttModel: ''
    })
  }

  function handleRealtimeSttProviderChange(provider: string) {
    realtimeSttModelManual = false
    handleSettingsChange({
      realtimeSttProvider: provider as VoiceProviderId,
      realtimeSttModel: ''
    })
  }

  async function handleSttModelChange(modelValue: string) {
    const selectedModel = modelValue.trim()
    const byoEngine = resolveSelectedByoSttEngine()
    const catalogModel = byoEngine
      ? findInstalledSttCatalogModelForRequest(byoEngine, selectedModel)
      : null

    if (byoEngine && catalogModel && !isByoSttModelActive(byoEngine, catalogModel)) {
      const result = await handleByoEngineModelAction(byoEngine, catalogModel, 'use')
      if (!result?.success) return
      const activatedModel =
        result.engine?.sttDefaults?.modelId?.trim() || resolveModelRequestValue(catalogModel)
      handleSettingsChange({ sttModel: activatedModel })
      return
    }

    handleSettingsChange({ sttModel: selectedModel })
  }

  function handleRealtimeSttModelChange(modelValue: string) {
    handleSettingsChange({ realtimeSttModel: modelValue.trim() })
  }

  function handleVoiceModeInputModeChange(value: string) {
    handleSettingsChange({
      voiceModeInputMode: value === 'text' ? 'text' : 'stt'
    })
  }

  function handleVoiceModeSubmitModeChange(value: string) {
    handleSettingsChange({
      voiceModeSubmitMode: value === 'manual' ? 'manual' : 'auto'
    })
  }

  function handleVoiceModeAutoSubmitDelayChange(value: number | number[]) {
    const nextValue = Array.isArray(value) ? value[0] : value
    handleSettingsChange({
      voiceModeAutoSubmitDelayMs: normalizeVoiceModeTurnSettings({
        autoSubmitDelayMs: nextValue
      }).autoSubmitDelayMs
    })
  }

  function handleVoiceModeEndOfTurnThresholdChange(value: number | number[]) {
    const nextValue = Array.isArray(value) ? value[0] : value
    handleSettingsChange({
      voiceModeEndOfTurnThreshold: normalizeVoiceModeTurnSettings({
        endOfTurnThreshold: nextValue
      }).endOfTurnThreshold
    })
  }


  function handleTtsProviderChange(provider: string) {
    ttsModelManual = false
    ttsVoiceManual = false
    voices = []
    voicesError = null
    voicesLoading = false
    voiceListKey = ''
    handleSettingsChange({
      ttsProvider: provider as VoiceProviderId,
      ttsModel: '',
      ttsVoiceId: '',
      ttsProfileId: ''
    })
  }

  function handleVoiceEngineSectionToggle(sectionId: VoiceEngineSectionId, event: Event) {
    const target = event.currentTarget as HTMLDetailsElement
    if (target.open) {
      openVoiceEngineSectionId = sectionId
    } else if (openVoiceEngineSectionId === sectionId) {
      openVoiceEngineSectionId = null
    }
  }

  function toggleTtsEngineAccordion(providerId: string) {
    openTtsEngineAccordionId = openTtsEngineAccordionId === providerId ? null : providerId
  }

  function toggleSttEngineAccordion(providerId: string) {
    openSttEngineAccordionId = openSttEngineAccordionId === providerId ? null : providerId
  }

  function toggleEngineAccordion(providerId: string) {
    openEngineAccordionId = openEngineAccordionId === providerId ? null : providerId
  }

  function pruneTtsEngineSettingsMap(
    map: Record<string, VoiceTtsEngineSettingsForm>
  ): Record<string, VoiceTtsEngineSettingsForm> | undefined {
    const output: Record<string, VoiceTtsEngineSettingsForm> = {}
    for (const [providerId, config] of Object.entries(map)) {
      const common = config.common
      const providerOptions = config.providerOptions
      const hasCommon = common
        ? Object.values(common).some((value) => typeof value === 'string' && value.trim() !== '')
        : false
      const hasProviderOptions = providerOptions
        ? Object.values(providerOptions).some(
            (value) => typeof value === 'boolean' || (typeof value === 'string' && value.trim() !== '')
          )
        : false
      if (hasCommon || hasProviderOptions) {
        output[providerId] = {
          ...(hasCommon ? { common } : {}),
          ...(hasProviderOptions ? { providerOptions } : {})
        }
      }
    }
    return Object.keys(output).length > 0 ? output : undefined
  }

  function pruneSttEngineSettingsMap(
    map: Record<string, VoiceSttEngineSettingsForm>
  ): Record<string, VoiceSttEngineSettingsForm> | undefined {
    const output: Record<string, VoiceSttEngineSettingsForm> = {}
    for (const [providerId, config] of Object.entries(map)) {
      const providerOptions = config.providerOptions
      const language = config.language?.trim() ?? ''
      const hasProviderOptions = providerOptions
        ? Object.values(providerOptions).some(
            (value) => typeof value === 'boolean' || (typeof value === 'string' && value.trim() !== '')
          )
        : false
      if (language || hasProviderOptions) {
        output[providerId] = {
          ...(language ? { language: config.language } : {}),
          ...(hasProviderOptions ? { providerOptions } : {})
        }
      }
    }
    return Object.keys(output).length > 0 ? output : undefined
  }

  function setTtsEngineCommonFieldValue(providerId: string, key: keyof VoiceCommonForm, rawValue: string) {
    const nextMap = { ...(settings.ttsEngineSettings ?? {}) }
    const nextConfig = { ...(nextMap[providerId] ?? {}) }
    const nextCommon = { ...(nextConfig.common ?? {}) }
    if (rawValue.trim()) nextCommon[key] = rawValue
    else delete nextCommon[key]

    nextMap[providerId] = {
      ...nextConfig,
      common: Object.keys(nextCommon).length > 0 ? nextCommon : undefined
    }

    settings = {
      ...settings,
      ttsEngineSettings: pruneTtsEngineSettingsMap(nextMap)
    }
  }

  function setTtsEngineProviderOptionValue(
    providerId: string,
    key: string,
    rawValue: string | boolean
  ) {
    const nextMap = { ...(settings.ttsEngineSettings ?? {}) }
    const nextConfig = { ...(nextMap[providerId] ?? {}) }
    const nextProviderOptions = { ...(nextConfig.providerOptions ?? {}) }
    if (typeof rawValue === 'boolean') nextProviderOptions[key] = rawValue
    else if (rawValue.trim()) nextProviderOptions[key] = rawValue
    else delete nextProviderOptions[key]

    nextMap[providerId] = {
      ...nextConfig,
      providerOptions:
        Object.keys(nextProviderOptions).length > 0 ? nextProviderOptions : undefined
    }

    settings = {
      ...settings,
      ttsEngineSettings: pruneTtsEngineSettingsMap(nextMap)
    }
  }

  function setSttEngineLanguageValue(providerId: string, rawValue: string) {
    const nextMap = { ...(settings.sttEngineSettings ?? {}) }
    const nextConfig = { ...(nextMap[providerId] ?? {}) }
    if (rawValue.trim()) nextConfig.language = rawValue
    else delete nextConfig.language
    nextMap[providerId] = nextConfig

    settings = {
      ...settings,
      sttEngineSettings: pruneSttEngineSettingsMap(nextMap)
    }
  }

  function setSttEngineProviderOptionValue(
    providerId: string,
    key: string,
    rawValue: string | boolean
  ) {
    const nextMap = { ...(settings.sttEngineSettings ?? {}) }
    const nextConfig = { ...(nextMap[providerId] ?? {}) }
    const nextProviderOptions = { ...(nextConfig.providerOptions ?? {}) }
    if (typeof rawValue === 'boolean') nextProviderOptions[key] = rawValue
    else if (rawValue.trim()) nextProviderOptions[key] = rawValue
    else delete nextProviderOptions[key]

    nextMap[providerId] = {
      ...nextConfig,
      providerOptions:
        Object.keys(nextProviderOptions).length > 0 ? nextProviderOptions : undefined
    }

    settings = {
      ...settings,
      sttEngineSettings: pruneSttEngineSettingsMap(nextMap)
    }
  }

  function getTtsEngineCommonFieldValue(providerId: string, field: VoiceCapabilityField): string {
    if (!field.path.startsWith('common.')) return ''
    const key = field.path.replace('common.', '') as keyof VoiceCommonForm
    const value = settings.ttsEngineSettings?.[providerId]?.common?.[key]
    return typeof value === 'string' ? value : ''
  }

  function getTtsEngineProviderOptionValue(
    providerId: string,
    field: VoiceCapabilityField
  ): string | boolean {
    const key = getProviderOptionKeyForCapabilityField(providerId, field)
    if (!key) return field.type === 'boolean' ? false : ''
    const value = settings.ttsEngineSettings?.[providerId]?.providerOptions?.[key]
    return field.type === 'boolean' ? value === true : typeof value === 'string' ? value : ''
  }

  function getSttEngineFieldValue(providerId: string, field: VoiceCapabilityField): string | boolean {
    if (field.path === 'language') return settings.sttEngineSettings?.[providerId]?.language ?? ''
    const key = getProviderOptionKeyForCapabilityField(providerId, field)
    if (!key) return field.type === 'boolean' ? false : ''
    const value = settings.sttEngineSettings?.[providerId]?.providerOptions?.[key]
    return field.type === 'boolean' ? value === true : typeof value === 'string' ? value : ''
  }

  function setSttEngineFieldValue(
    providerId: string,
    field: VoiceCapabilityField,
    rawValue: string | boolean
  ) {
    if (field.path === 'language') {
      setSttEngineLanguageValue(providerId, typeof rawValue === 'string' ? rawValue : '')
      return
    }

    const key = getProviderOptionKeyForCapabilityField(providerId, field)
    if (key) setSttEngineProviderOptionValue(providerId, key, rawValue)
  }

  function updateByoProvider(
    providerId: string,
    updater: (provider: VoiceEngineClientSummary) => VoiceEngineClientSummary
  ) {
    const providers = [...byoEngines]
    const index = providers.findIndex((provider) => provider.id === providerId)
    if (index < 0) return
    providers[index] = updater(providers[index])
    byoEngines = providers
  }

  function getByoEngineIconRef(provider: VoiceEngineClientSummary): IconRef {
    return normalizeIconRef(provider.iconRef, DEFAULT_VOICE_ENGINE_ICON_REF)
  }

  function isBatshitManagedLocalEngine(provider: VoiceEngineClientSummary) {
    return provider.localRuntime?.installOwnership === 'batshit-managed'
  }

  function getDeleteLocalFilesForEngine(providerId: string) {
    return deleteLocalFilesByEngineId[providerId] === true
  }

  function setDeleteLocalFilesForEngine(providerId: string, value: boolean) {
    deleteLocalFilesByEngineId = {
      ...deleteLocalFilesByEngineId,
      [providerId]: value
    }
  }

  function setByoEngineIconRef(providerId: string, iconRef: IconRef) {
    updateByoProvider(providerId, (provider) => ({
      ...provider,
      iconRef
    }))
  }

  function getTtsEnginePrompt(providerId: string) {
    return settings.ttsEnginePrompts?.[providerId] ?? ''
  }

  function setTtsEnginePrompt(providerId: string, value: string) {
    const prompt = normalizeTtsEnginePromptText(value)
    const nextPrompts = { ...(settings.ttsEnginePrompts ?? {}) }

    if (prompt) {
      nextPrompts[providerId] = prompt
    } else {
      delete nextPrompts[providerId]
    }

    settings = {
      ...settings,
      ttsEnginePrompts: Object.keys(nextPrompts).length > 0 ? nextPrompts : undefined
    }
  }

  function openTtsEnginePromptEditor(provider: VoiceProviderSummary) {
    ttsEnginePromptEditorProvider = provider
    ttsEnginePromptEditorOpen = true
  }

  async function saveTtsEnginePromptFromEditor(value: string) {
    if (!ttsEnginePromptEditorProvider) return
    setTtsEnginePrompt(ttsEnginePromptEditorProvider.id, value)
  }

  function getVoiceProviderTypeLabel(provider: VoiceProviderSummary) {
    if (provider.type === 'byo') return 'BYO'
    if (provider.type === 'browser') return 'Browser'
    if (provider.type === 'local') return 'Local'
    return 'Cloud'
  }

  function getVoiceProviderStatusLabel(provider: VoiceProviderSummary) {
    if (provider.ready === true) return 'Ready'
    if (provider.ready === false) return provider.statusHint ?? 'Needs setup'
    if (provider.requiresKey) return 'Needs key'
    return 'Available'
  }

  function getVoiceProviderStatusClass(provider: VoiceProviderSummary) {
    if (provider.ready === true) return 'batshit-settings-pill is-success'
    if (provider.ready === false || provider.requiresKey) return 'batshit-settings-pill is-warning'
    return 'batshit-settings-child-label'
  }

  function buildEngineModelJobKey(providerId: string, modelId: string) {
    return `${providerId}:${modelId}`
  }

  function getEngineModelJob(providerId: string, modelId: string) {
    return engineModelJobs[buildEngineModelJobKey(providerId, modelId)]
  }

  function setEngineModelJob(providerId: string, modelId: string, action: 'download' | 'use' | 'delete' | null) {
    const key = buildEngineModelJobKey(providerId, modelId)
    if (!action) {
      const { [key]: _removed, ...rest } = engineModelJobs
      engineModelJobs = rest
      return
    }
    engineModelJobs = {
      ...engineModelJobs,
      [key]: action
    }
  }

  function formatModelSize(bytes?: number) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
    return `${bytes} B`
  }

  function resolveModelRequestValue(model: VoiceEngineModelCatalogEntry) {
    return model.requestModel?.trim() || model.filename?.trim() || model.id
  }

  function isByoSttModelActive(provider: VoiceEngineClientSummary, model: VoiceEngineModelCatalogEntry) {
    const activeModelId = provider.sttModelCatalog?.activeModelId?.trim()
    if (activeModelId) return activeModelId === model.id
    const configuredModel = provider.sttDefaults?.modelId?.trim()
    return Boolean(configuredModel && configuredModel === resolveModelRequestValue(model))
  }

  function isByoSttModelInstalled(provider: VoiceEngineClientSummary, model: VoiceEngineModelCatalogEntry) {
    return model.installed === true || isByoSttModelActive(provider, model)
  }

  function resolveSelectedByoSttEngine() {
    const providerId = selectedSttProvider?.id
    if (!providerId?.startsWith('byo:')) return null
    const engineId = providerId.slice('byo:'.length)
    return byoEngines.find((engine) => engine.id === engineId) ?? null
  }

  function findInstalledSttCatalogModelForRequest(
    provider: VoiceEngineClientSummary,
    requestModel: string
  ) {
    const normalizedRequest = requestModel.trim()
    if (!normalizedRequest) return null
    return (
      provider.sttModelCatalog?.models.find(
        (model) =>
          isByoSttModelInstalled(provider, model) &&
          resolveModelRequestValue(model) === normalizedRequest
      ) ?? null
    )
  }

  async function handleByoEngineModelAction(
    provider: VoiceEngineClientSummary,
    model: VoiceEngineModelCatalogEntry,
    action: 'download' | 'use' | 'delete'
  ) {
    setEngineModelJob(provider.id, model.id, action)
    try {
      const response = await fetch(`/api/voice/byo/engines/${encodeURIComponent(provider.id)}/models`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          action,
          modelId: model.id
        })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(result?.error ?? 'Failed to update STT model')
      }

      if (result?.engine) {
        updateByoProvider(provider.id, () => result.engine as VoiceEngineClientSummary)
        persistedEngineSignature = makeEngineSignature(
          byoEngines.map((engine) => (engine.id === provider.id ? result.engine : engine))
        )
        await loadProviders()
      }

      if (action === 'download') {
        toast.success(`${model.label ?? model.id} downloaded`)
      } else if (action === 'use') {
        toast.success(
          result?.restartRequired
            ? `${model.label ?? model.id} selected. Restart the engine to load it.`
            : `${model.label ?? model.id} selected`
        )
      } else {
        toast.success(`${model.label ?? model.id} deleted`)
      }
      return result
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update STT model')
      return null
    } finally {
      setEngineModelJob(provider.id, model.id, null)
    }
  }

  function resolveByoUiSections(schema?: VoiceEngineUiSchema) {
    const sectionsFromSchema = Array.isArray(schema?.sections)
      ? schema.sections
          .filter((section) => Array.isArray(section.fields) && section.fields.length > 0)
          .map((section) => ({
            id: section.id,
            title: section.title,
            description: section.description,
            fields: section.fields
          }))
      : []

    if (sectionsFromSchema.length > 0) {
      return sectionsFromSchema
    }

    const fields = Array.isArray(schema?.fields) ? schema.fields : []
    if (fields.length === 0) {
      return []
    }

    return [
      {
        id: 'controls',
        title: schema?.panelTitle ?? 'Controls',
        description: undefined,
        fields
      }
    ]
  }

  function getByoEngineForProviderId(providerId: string) {
    if (!providerId.startsWith('byo:')) return null
    const engineId = providerId.slice('byo:'.length)
    return byoEngines.find((engine) => engine.id === engineId) ?? null
  }

  function getBuiltInTtsEngineAdvancedFields(providerId: string) {
    const provider = resolveProviderById(providerId)
    if (!provider || provider.type === 'byo') return []
    return getVoiceCapabilityFields(providerId, 'tts', 'global')
  }

  function getBuiltInSttEngineAdvancedFields(providerId: string) {
    const provider = resolveProviderById(providerId)
    if (!provider || provider.type === 'byo') return []
    return getVoiceCapabilityFields(providerId, 'stt', 'global')
  }

  function getByoEngineAdvancedSections(providerId: string, scope: 'tts' | 'stt') {
    const engine = getByoEngineForProviderId(providerId)
    if (!engine) return []

    return resolveByoUiSections(engine.uiSchema)
      .map((section) => ({
        ...section,
        fields: section.fields.filter((field) => isByoEngineAdvancedField(scope, field))
      }))
      .filter((section) => section.fields.length > 0)
  }

  function getByoEngineAdvancedFields(providerId: string, scope: 'tts' | 'stt') {
    return getByoEngineAdvancedSections(providerId, scope).flatMap((section) => section.fields)
  }

  function isByoEngineAdvancedField(scope: 'tts' | 'stt', field: VoiceEngineUiField) {
    const path = field.path?.trim()
    if (!path) return false
    if (scope === 'tts') {
      return path.startsWith('tts.common.') || path.startsWith('tts.providerOptions.')
    }
    return path === 'stt.language' || path.startsWith('stt.providerOptions.')
  }

  function getByoEngineFieldDefaultValue(
    providerId: string,
    field: VoiceEngineUiField
  ): string | number | boolean | undefined {
    const provider = getByoEngineForProviderId(providerId)
    const segments = field.path?.split('.').filter(Boolean) ?? []
    if (!provider || segments.length < 2) return field.defaultValue

    if (segments[0] === 'tts' && segments[1] === 'common' && segments[2]) {
      return (
        provider.ttsDefaults?.common?.[
          segments[2] as keyof NonNullable<typeof provider.ttsDefaults>['common']
        ] ?? field.defaultValue
      )
    }

    if (segments[0] === 'tts' && segments[1] === 'providerOptions' && segments.length >= 3) {
      return provider.ttsDefaults?.providerOptions?.[segments.slice(2).join('.')] ?? field.defaultValue
    }

    if (segments[0] === 'stt' && segments[1] === 'language') {
      return provider.sttDefaults?.language ?? field.defaultValue
    }

    if (segments[0] === 'stt' && segments[1] === 'providerOptions' && segments.length >= 3) {
      return provider.sttDefaults?.providerOptions?.[segments.slice(2).join('.')] ?? field.defaultValue
    }

    return field.defaultValue
  }

  function formatEngineFieldDefault(value: unknown) {
    if (value === null || value === undefined || value === '') return null
    if (typeof value === 'boolean') return value ? 'On' : 'Off'
    return String(value)
  }

  function getCapabilityFieldDefaultLabel(field: VoiceCapabilityField) {
    const defaultLabel = formatEngineFieldDefault(field.defaultValue)
    return defaultLabel ? `Use default (${defaultLabel})` : 'Use default'
  }

  function getByoFieldDefaultLabel(providerId: string, field: VoiceEngineUiField) {
    const defaultLabel = formatEngineFieldDefault(getByoEngineFieldDefaultValue(providerId, field))
    return defaultLabel ? `Use default (${defaultLabel})` : 'Use default'
  }

  function getCapabilityFieldPlaceholder(field: VoiceCapabilityField): string | undefined {
    if (field.path === 'language') return 'en, es, fr (optional)'
    const defaultLabel = formatEngineFieldDefault(field.defaultValue)
    return defaultLabel ? `Default: ${defaultLabel}` : undefined
  }

  function getByoFieldPlaceholder(providerId: string, field: VoiceEngineUiField): string | undefined {
    if (field.placeholder) return field.placeholder
    const defaultLabel = formatEngineFieldDefault(getByoEngineFieldDefaultValue(providerId, field))
    return defaultLabel ? `Default: ${defaultLabel}` : undefined
  }

  function getByoEngineFieldValue(
    providerId: string,
    field: VoiceEngineUiField
  ): string | boolean {
    const segments = field.path?.split('.').filter(Boolean) ?? []
    if (segments[0] === 'tts' && segments[1] === 'common' && segments[2]) {
      const value =
        settings.ttsEngineSettings?.[providerId]?.common?.[
          segments[2] as keyof VoiceCommonForm
        ]
      return typeof value === 'string' ? value : ''
    }

    if (segments[0] === 'tts' && segments[1] === 'providerOptions' && segments.length >= 3) {
      const key = segments.slice(2).join('.')
      const value = settings.ttsEngineSettings?.[providerId]?.providerOptions?.[key]
      return field.type === 'boolean' ? value === true : typeof value === 'string' ? value : ''
    }

    if (segments[0] === 'stt' && segments[1] === 'language') {
      return settings.sttEngineSettings?.[providerId]?.language ?? ''
    }

    if (segments[0] === 'stt' && segments[1] === 'providerOptions' && segments.length >= 3) {
      const key = segments.slice(2).join('.')
      const value = settings.sttEngineSettings?.[providerId]?.providerOptions?.[key]
      return field.type === 'boolean' ? value === true : typeof value === 'string' ? value : ''
    }

    return field.type === 'boolean' ? false : ''
  }

  function setByoEngineFieldValue(
    providerId: string,
    field: VoiceEngineUiField,
    rawValue: string | boolean
  ) {
    const segments = field.path?.split('.').filter(Boolean) ?? []
    if (segments[0] === 'tts' && segments[1] === 'common' && segments[2]) {
      setTtsEngineCommonFieldValue(providerId, segments[2] as keyof VoiceCommonForm, String(rawValue))
      return
    }

    if (segments[0] === 'tts' && segments[1] === 'providerOptions' && segments.length >= 3) {
      setTtsEngineProviderOptionValue(providerId, segments.slice(2).join('.'), rawValue)
      return
    }

    if (segments[0] === 'stt' && segments[1] === 'language') {
      setSttEngineLanguageValue(providerId, typeof rawValue === 'string' ? rawValue : '')
      return
    }

    if (segments[0] === 'stt' && segments[1] === 'providerOptions' && segments.length >= 3) {
      setSttEngineProviderOptionValue(providerId, segments.slice(2).join('.'), rawValue)
    }
  }

  function decodeSelectFieldValue(field: VoiceEngineUiField, rawValue: string): string | number | boolean {
    const options = Array.isArray(field.options) ? field.options : []
    const matched = options.find((option) => String(option.value) === rawValue)
    if (matched) return matched.value as string | number | boolean
    return rawValue
  }

  async function checkByoEngineHealth(providerId: string) {
    byoEngineHealth = {
      ...byoEngineHealth,
      [providerId]: {
        loading: true
      }
    }

    try {
      const providerParam = `byo:${providerId}`
      const response = await fetch(`/api/voice/byo/health?provider=${encodeURIComponent(providerParam)}`)
      if (!response.ok) {
        const message = await extractError(response, 'Failed to check BYO engine')
        throw new Error(message)
      }

      const result = await response.json()
      byoEngineHealth = {
        ...byoEngineHealth,
        [providerId]: {
          loading: false,
          ready: result?.ready === true,
          statusHint: result?.statusHint
        }
      }
    } catch (error) {
      byoEngineHealth = {
        ...byoEngineHealth,
        [providerId]: {
          loading: false,
          ready: false,
          statusHint: error instanceof Error ? error.message : 'Health check failed'
        }
      }
      toast.error(error instanceof Error ? error.message : 'Health check failed')
    }
  }

  async function handleDeleteByoEngine(provider: VoiceEngineClientSummary) {
    const deleteLocalFiles =
      isBatshitManagedLocalEngine(provider) && getDeleteLocalFilesForEngine(provider.id)
    const description = [
      'This removes the engine record, clears current defaults that still point at it, and deletes saved voice clones created with this engine.'
    ]
    if (isBatshitManagedLocalEngine(provider)) {
      description.push(
        deleteLocalFiles
          ? 'The Batshit-managed install folder and runtime logs/state for this engine will also be deleted from disk.'
          : 'The Batshit-managed install folder and runtime logs/state will stay on disk unless you turn on "Delete local files too."'
      )
    }

    const confirmed = await confirmDialog({
      title: `Delete "${provider.name}" from Engine Manager?`,
      description,
      confirmLabel: 'Delete Engine',
      tone: 'destructive'
    })
    if (!confirmed) return

    try {
      const response = await fetch(`/api/voice/byo/engines/${encodeURIComponent(provider.id)}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deleteLocalFiles
        })
      })
      if (!response.ok) {
        const message = await extractError(response, 'Failed to delete BYO engine')
        throw new Error(message)
      }

      const result = await response.json()
      await refreshVoiceEngineState()
      await loadProfiles()
      setDeleteLocalFilesForEngine(provider.id, false)
      if (Array.isArray(result?.clearedAgentIds) && result.clearedAgentIds.length > 0) {
        await Promise.all(
          result.clearedAgentIds.map(async (agentId: unknown) => {
            if (typeof agentId !== 'string' || !agentId.trim()) return
            const agentResponse = await fetch(`/api/agents/${encodeURIComponent(agentId)}`)
            if (!agentResponse.ok) return
            const agent = await agentResponse.json().catch(() => null)
            if (agent?.id) {
              agentStore.updateAgent(agent.id, agent)
            }
          })
        )
      }
      toast.success(`${provider.name} deleted`)
      if (Array.isArray(result?.deletedVoiceProfileIds) && result.deletedVoiceProfileIds.length > 0) {
        toast.message(
          `Deleted ${result.deletedVoiceProfileIds.length} saved voice clone${result.deletedVoiceProfileIds.length === 1 ? '' : 's'} for that engine.`
        )
      }
      if (result?.localFiles?.requested) {
        const deletedCount =
          Number(result.localFiles.deletedInstallRoots?.length ?? 0) +
          Number(result.localFiles.deletedStateRoots?.length ?? 0)
        if (deletedCount > 0) {
          toast.message('Deleted Batshit-managed local engine files.')
        }
        if (Array.isArray(result.localFiles.errors) && result.localFiles.errors.length > 0) {
          toast.warning('Engine deleted, but some local files were not removed.', {
            description: result.localFiles.errors
              .map((entry: any) => entry?.message)
              .filter(Boolean)
              .join(' ')
          })
        }
        if (
          deletedCount === 0 &&
          Array.isArray(result.localFiles.skipped) &&
          result.localFiles.skipped.length > 0
        ) {
          toast.warning('Engine deleted, but local files were left in place.', {
            description: result.localFiles.skipped
              .map((entry: any) => entry?.reason)
              .filter(Boolean)
              .join(' ')
          })
        }
      }
      if (Array.isArray(result?.clearedAgentIds) && result.clearedAgentIds.length > 0) {
        toast.message(
          `Cleared deleted voice engine from ${result.clearedAgentIds.length} agent profile${result.clearedAgentIds.length === 1 ? '' : 's'}.`
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete BYO engine')
    }
  }

  async function handlePreview(options?: { clone?: VoiceProfileRecord | null }) {
    const text = testPhrase.trim()
    if (!text) {
      toast.error('Enter a test phrase first.')
      return
    }

    const previewProvider = options?.clone?.provider ?? (settings.ttsProvider ?? 'browser')
    const engineTtsSettings = settings.ttsEngineSettings?.[previewProvider]
    const speed = engineTtsSettings?.common?.speed ? Number(engineTtsSettings.common.speed) : undefined
    const volume = engineTtsSettings?.common?.volume ? Number(engineTtsSettings.common.volume) : undefined
    const common: Record<string, any> = {
      language: normaliseString(engineTtsSettings?.common?.language),
      instructions: normaliseString(engineTtsSettings?.common?.instructions)
    }
    if (typeof speed === 'number' && Number.isFinite(speed)) common.speed = speed
    if (typeof volume === 'number' && Number.isFinite(volume)) common.volume = volume

    const selectedVoiceId =
      options?.clone?.voiceId ??
      normaliseString(settings.ttsVoiceId) ??
      normaliseString(displayedTtsVoiceId)
    const selectedProfile = resolvePreviewVoiceProfile(
      previewProvider as VoiceProviderId,
      selectedVoiceId,
      options?.clone
    )
    const voiceConfig: VoiceConfig = {
      provider: previewProvider,
      model: selectedProfile?.model ?? normaliseString(settings.ttsModel),
      voiceId: selectedProfile?.voiceId ?? selectedVoiceId,
      profileId: selectedProfile?.id ?? normaliseString(settings.ttsProfileId),
      common,
      providerOptions: engineTtsSettings?.providerOptions
    }

    previewBusy = true
    try {
      await voiceService.speak(text, {
        manual: true,
        voice: voiceConfig,
        voiceSettings: buildVoiceSettingsPayload(settings)
      })
    } catch (error) {
      console.error('Voice preview failed:', error)
      toast.error(error instanceof Error ? error.message : 'Voice preview failed')
    } finally {
      previewBusy = false
    }
  }

  function clearClonePreviewUrl() {
    if (clonePreviewUrl) {
      URL.revokeObjectURL(clonePreviewUrl)
      clonePreviewUrl = null
    }
  }

  function setCloneFile(file: File | null) {
    clearClonePreviewUrl()
    cloneFile = file
    cloneTranscribeError = null
    if (file) {
      clonePreviewUrl = URL.createObjectURL(file)
    }
  }

  function handleCloneFileChange(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) {
      setCloneFile(null)
      return
    }
    setCloneFile(file)
  }

  async function handleTranscribeCloneReference() {
    if (!cloneFile) {
      cloneTranscribeError = 'Upload reference audio before transcribing it.'
      return
    }

    const provider = cloneTranscribeProvider.trim()
    if (!provider) {
      cloneTranscribeError = 'Choose a speech-to-text provider first.'
      return
    }

    cloneTranscribeBusy = true
    cloneTranscribeError = null

    try {
      const form = new FormData()
      form.append('audio', cloneFile)
      form.append('provider', provider)

      if (provider === (settings.sttProvider ?? 'browser')) {
        const selectedModel = normaliseString(settings.sttModel)
        if (selectedModel) form.append('model', selectedModel)
      }
      const selectedLanguage = normaliseString(settings.sttEngineSettings?.[provider]?.language)
      if (selectedLanguage) form.append('language', selectedLanguage)

      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        body: form
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to transcribe reference audio')
        throw new Error(message)
      }

      const result = await response.json()
      const transcript = typeof result?.text === 'string' ? result.text.trim() : ''
      if (!transcript) {
        throw new Error('No transcript was returned for this clip.')
      }

      cloneReferenceText = transcript
      toast.success('Reference transcript added')
    } catch (error) {
      console.error('Reference transcription failed:', error)
      cloneTranscribeError =
        error instanceof Error ? error.message : 'Failed to transcribe reference audio'
      toast.error(cloneTranscribeError)
    } finally {
      cloneTranscribeBusy = false
    }
  }

  async function handleCloneVoice() {
    if (!cloneFile || !cloneName.trim() || !cloneProvider || !cloneConsent) {
      cloneError = 'Provide a name, audio file, provider, and consent.'
      return
    }

    cloneBusy = true
    cloneError = null

    try {
      const form = new FormData()
      form.append('audio', cloneFile)
      form.append('provider', cloneProvider)
      form.append('name', cloneName.trim())
      if (cloneReferenceText.trim()) {
        form.append('refText', cloneReferenceText.trim())
      }

      const response = await fetch('/api/voice/clone', {
        method: 'POST',
        body: form
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to clone voice')
        throw new Error(message)
      }

      const result = await response.json()
      const profile = result?.profile as VoiceProfileRecord | undefined
      if (profile) {
        profiles = [profile, ...profiles]
        selectedCloneId = profile.id
      }

      toast.success('Voice clone created')
      cloneName = ''
      cloneReferenceText = ''
      setCloneFile(null)
      cloneConsent = false
    } catch (error) {
      console.error('Voice clone failed:', error)
      cloneError = error instanceof Error ? error.message : 'Failed to clone voice'
    } finally {
      cloneBusy = false
    }
  }

  async function handleDeleteProfile(profileId: string) {
    try {
      const response = await fetch(`/api/voice/profiles/${profileId}`, {
        method: 'DELETE'
      })
      if (!response.ok) {
        const message = await extractError(response, 'Failed to delete voice clone')
        throw new Error(message)
      }
      profiles = profiles.filter((profile) => profile.id !== profileId)
      toast.success('Voice clone deleted')
    } catch (error) {
      console.error('Failed to delete voice clone:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete voice clone')
    }
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const data = await response.json()
      const message =
        typeof data?.error === 'string' && data.error.trim()
          ? data.error.trim()
          : typeof data?.message === 'string' && data.message.trim()
            ? data.message.trim()
            : fallback
      if (typeof data?.setupHint === 'string' && data.setupHint.trim()) {
        return `${message} ${data.setupHint.trim()}`.trim()
      }
      return message
    } catch {
      return fallback
    }
  }
</script>

<div class="space-y-6">
      <Tabs.Root bind:value={activeTab} class="w-full">
        <Tabs.List class="flex w-full flex-wrap gap-2">
          <Tabs.Trigger value="global" class="min-w-[180px] flex-1 gap-2 sm:flex-none">
            <Mic class="h-3.5 w-3.5" />
            <span>Global Voice Settings</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="studio" class="min-w-[120px] flex-1 gap-2 sm:flex-none">
            <BatshitIcon id="voice-studio" class="h-3.5 w-3.5" />
            <span>Voice Studio</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="engine-manager" class="min-w-[140px] flex-1 gap-2 sm:flex-none">
            <BatshitIcon id="voice-engine-manager" class="h-3.5 w-3.5" />
            <span>Voice Engines</span>
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      {#if activeTab === 'global'}
        <div class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-1.5">
              <Mic class="h-5 w-5 text-muted-foreground" />
              <h3 class="batshit-settings-section-title">Global Voice Settings</h3>
              <SettingsInfoMenu ariaLabel="About Global Voice Settings" contentClass="w-80">
                <p>
                  Choose the global microphone, lip-sync quality, and default STT/TTS settings.
                  Auto-speak now follows the ChatBar TTS toggle instead of living in Voice Settings.
                </p>
              </SettingsInfoMenu>
            </div>
            <SettingsSaveStatus
              state={settingsSaveState}
              error={settingsSaveError}
              sticky={false}
              savedLabel="Saved"
            />
          </div>

          {#if currentAgentVoiceOverrideParts.length > 0}
            <div class="batshit-settings-inline-alert is-info">
              <span class="batshit-settings-inline-strong">
                Current chat uses agent voice overrides.
              </span>
              <span>
                {currentAgent?.name ?? 'The current agent'} overrides {currentAgentVoiceOverrideText}.
                The ChatBar Voice button checks those before these global defaults.
              </span>
            </div>
          {/if}

          <div class="batshit-settings-muted-panel is-loose batshit-voice-lane-map space-y-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <p class="batshit-settings-form-label">Voice Lane Map</p>
                <p class="batshit-settings-caption">{selectedVoiceRuntimeSummary}</p>
              </div>
              <Badge variant="outline" class={`${selectedVoiceRuntimeBadgeClass} shrink-0`}>
                {selectedVoiceRuntimeLabel}
              </Badge>
            </div>

            <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Microphone</p>
                  <Badge variant="outline" class="batshit-settings-pill shrink-0">
                    {selectedInputDeviceBadgeLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {selectedInputDeviceLabel}
                </p>
                <p class="batshit-settings-caption">Capture input for dictation and Voice Mode.</p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Voice Mode Input</p>
                  <Badge
                    variant="outline"
                    class={`batshit-settings-pill ${voiceModeUsesSttInput ? 'is-success' : 'is-info'} shrink-0`}
                  >
                    {getVoiceModeInputLabel(settings.voiceModeInputMode)}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {voiceModeUsesSttInput ? 'Voice Mode STT' : 'Composer text'}
                </p>
                <p class="batshit-settings-caption">User input source for the Voice button.</p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Turn Mode</p>
                  <Badge
                    variant="outline"
                    class={`${effectiveVoiceModeSubmitBadgeClass} shrink-0`}
                  >
                    {effectiveVoiceModeSubmitModeLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {voiceModeTurnSettings.submitMode === 'manual' && !manualTurnAvailable
                    ? 'Manual Turn disabled'
                    : effectiveVoiceModeSubmitModeLabel}
                </p>
                <p class="batshit-settings-caption">
                  {voiceModeTurnSettings.submitMode === 'manual' && !manualTurnAvailable
                    ? 'Unavailable for this lane.'
                    : 'Recorded-turn handoff behavior.'}
                </p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Transcribe</p>
                  <Badge variant="outline" class="batshit-settings-pill shrink-0">
                    {selectedTranscribeLaneLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {selectedSttProvider?.label ?? 'Browser (Web Speech API)'}
                </p>
                <p class="batshit-settings-caption">Composer dictation and uploaded audio.</p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Voice Mode STT</p>
                  <Badge variant="outline" class={`${selectedVoiceModeSttBadgeClass} shrink-0`}>
                    {selectedVoiceModeSttLaneLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {selectedRealtimeSttProvider?.label ?? 'Browser (Web Speech API)'}
                </p>
                <p class="batshit-settings-caption">Listening lane for the Voice button.</p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Reply Voice</p>
                  <Badge variant="outline" class={`${selectedTtsBadgeClass} shrink-0`}>
                    {selectedTtsLaneLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {selectedTtsProvider?.label ?? 'Browser (Web Speech API)'}
                </p>
                <p class="batshit-settings-caption">Spoken assistant responses.</p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">3D Goon Lip Sync</p>
                  <Badge variant="outline" class={`${selectedGoonLipSyncBadgeClass} shrink-0`}>
                    {settings.goonLipSyncMode === 'viseme' ? 'Viseme' : 'Amplitude'}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {selectedGoonLipSyncOption.label}
                </p>
                <p class="batshit-settings-caption">Mouth animation lane for spoken replies.</p>
              </div>
            </div>

            {#if settings.voiceSessionRuntime === 'livekit'}
              <p class="batshit-settings-inline-alert is-info">
                LiveKit Bridge is room transport for Batshit STT/TTS. True speech-to-speech comes from a LiveKit-enabled model preset.
              </p>
            {/if}
          </div>

          <SettingsAccordionCard
            name="voice-global-cards"
            title="Voice Behavior"
            icon={Settings2}
          >
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Voice Behavior" contentClass="w-80">
                  <p>
                    These are the shared voice defaults used across Batshit. The saved lip-sync
                    choice here is the same source of truth used by the Dock lab.
                  </p>
                </SettingsInfoMenu>
            {/snippet}
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Microphone Input</Label.Label>
                      <SettingsInfoMenu ariaLabel="About Microphone Input" contentClass="w-72">
                        <p>
                          Pick the default microphone Batshit should use for voice capture and voice
                          mode. Refresh if you plugged in a new device after opening Settings.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <div class="flex items-center gap-2">
                      <div class="min-w-0 flex-1">
                        <Select.Root
                          type="single"
                          value={(settings.inputDeviceId ?? '') as unknown as string}
                          onValueChange={(value) =>
                            handleSettingsChange({
                              inputDeviceId: Array.isArray(value) ? value[0] || null : value || null
                            })}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {#if settings.inputDeviceId}
                                {inputDevices.find((device) => device.id === settings.inputDeviceId)?.label ?? 'Custom device'}
                              {:else}
                                Default microphone
                              {/if}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="">Default microphone</Select.Item>
                            {#each inputDevices as device (device.id)}
                              <Select.Item value={device.id}>{device.label}</Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      </div>
                      {#if inputDevicesLoading}
                        <div class="batshit-settings-form-meta">
                          <Loader2 class="h-3 w-3 animate-spin" />
                          <span>Scanning microphones…</span>
                        </div>
                      {:else}
                        <Button
                          variant="ghost"
                          size="sm"
                          onclick={() => loadInputDevices({ requestPermission: true })}
                        >
                          <RefreshCcw  />
                          Refresh
                        </Button>
                      {/if}
                    </div>
                    {#if inputDevicesError}
                      <div class="batshit-settings-form-meta text-destructive">
                        {inputDevicesError}
                      </div>
                    {/if}
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">3D Goon Lip Sync</Label.Label>
                      <SettingsInfoMenu ariaLabel="About 3D Goon Lip Sync" contentClass="w-80">
                        <p>
                          Shitty but Fast uses Batshit&apos;s quick fallback lane. Rhubarb WASM uses the
                          premium analyzer lane, and this single dropdown is the saved global source of
                          truth for both Voice Settings and the Dock lab.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={selectedGoonLipSyncOption.value as unknown as string}
                      onValueChange={(value) => handleGoonLipSyncChange(Array.isArray(value) ? value[0] : value)}
                    >
                      <Select.Trigger class="w-full justify-between">
                        <span class="truncate">{selectedGoonLipSyncOption.label}</span>
                      </Select.Trigger>
                      <Select.Content>
                        {#each goonLipSyncOptions as option (option.value)}
                          <Select.Item value={option.value}>{option.label}</Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>

                {#if settings.goonLipSyncMode === 'viseme'}
                  <div class="batshit-settings-form-row is-compact">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Viseme Blend</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Viseme Blend" contentClass="w-72">
                          <p>
                            Adds a tiny crossfade at hard Rhubarb mouth-shape boundaries. Lower is
                            sharper; higher is smoother.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control-group">
                      <div class="flex items-center justify-between gap-3">
                        <span class="batshit-settings-child-label">
                          {MIN_GOON_LIP_SYNC_VISEME_BLEND_MS}ms
                        </span>
                        <span class="batshit-settings-caption tabular-nums">
                          {goonLipSyncBlendMs}ms
                        </span>
                        <span class="batshit-settings-child-label">
                          {MAX_GOON_LIP_SYNC_VISEME_BLEND_MS}ms
                        </span>
                      </div>
                      <Slider
                        type="single"
                        value={goonLipSyncBlendMs}
                        onValueChange={handleGoonLipSyncBlendChange}
                        min={MIN_GOON_LIP_SYNC_VISEME_BLEND_MS}
                        max={MAX_GOON_LIP_SYNC_VISEME_BLEND_MS}
                        step={5}
                      />
                    </div>
                  </div>
                {/if}
              </div>
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="voice-global-cards"
            title="Transcribe Mode (STT)"
            icon={Mic}
            contentClass="space-y-6"
          >
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Transcribe Mode" contentClass="w-80">
                  <p>
                    Choose the default speech-to-text provider for mic dictation and uploaded-audio transcription.
                    Per-agent overrides still live in Agent Settings.
                  </p>
                </SettingsInfoMenu>
            {/snippet}
              {#if providersLoading}
                <div class="batshit-settings-caption flex items-center gap-2">
                  <Loader2 class="h-3 w-3 animate-spin" />
                  Loading providers…
                </div>
              {/if}

              <div class="space-y-4">
                <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
                  <div class="flex items-center justify-between gap-2">
                    <p class="batshit-settings-form-label">Transcribe STT</p>
                    {#if selectedSttProvider?.ready === false}
                      <Badge variant="outline" class="batshit-settings-pill is-warning">
                        {selectedSttProvider?.statusHint ?? 'Not ready'}
                      </Badge>
                    {/if}
                  </div>
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Provider</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={(settings.sttProvider ?? 'browser') as unknown as string}
                          onValueChange={(value) =>
                            handleSttProviderChange((Array.isArray(value) ? value[0] : value) as string)}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {selectedSttProvider?.label ?? 'Browser (Web Speech API)'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each sttProviderOptions as provider (provider.id)}
                              <Select.Item value={provider.id}>
                                <div class="flex items-center justify-between gap-2">
                                  <span>{provider.label}</span>
                                  <div class="flex shrink-0 items-center gap-1.5">
                                    {#if provider.ready === false}
                                      <Badge variant="outline" class="batshit-settings-pill is-warning">
                                        {provider.statusHint ?? 'Not ready'}
                                      </Badge>
                                    {/if}
                                  </div>
                                </div>
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                        {#if selectedSttProviderSetupHint}
                          <p class="batshit-settings-inline-alert is-warning">
                            {selectedSttProviderSetupHint}
                          </p>
                        {/if}
                        {#if selectedSttCapabilities}
                          <div class="flex flex-wrap items-center gap-1.5 pt-1">
                            {#if selectedSttCapabilities.recorded}
                              <Badge variant="outline" class="batshit-settings-child-label">Uploaded audio</Badge>
                            {/if}
                            {#if selectedSttCapabilities.cost}
                              <Badge variant="outline" class="batshit-settings-child-label">
                                {formatSttCostLabel(selectedSttCapabilities.cost)}
                              </Badge>
                            {/if}
                            {#if selectedSttCapabilities.privacy}
                              <Badge variant="outline" class="batshit-settings-child-label">
                                {formatSttPrivacyLabel(selectedSttCapabilities.privacy)}
                              </Badge>
                            {/if}
                            {#if selectedSttCapabilities.runtimeLabel || selectedSttCapabilities.unsupportedReason}
                              <SettingsInfoMenu ariaLabel="About selected STT capability" contentClass="w-80">
                                {#if selectedSttCapabilities.runtimeLabel}
                                  <p>{selectedSttCapabilities.runtimeLabel}</p>
                                {/if}
                                {#if selectedSttCapabilities.unsupportedReason}
                                  <p>{selectedSttCapabilities.unsupportedReason}</p>
                                {/if}
                              </SettingsInfoMenu>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    </div>

                    {#if selectedSttNeedsModel}
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Model</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <div class="flex items-center gap-2">
                          <div class="min-w-0 flex-1">
                            {#if sttHasSingleModelOption}
                              <div class="flex min-w-0 items-center gap-2">
                                <Input class="min-w-0 flex-1" value={sttDisplayedModel} disabled />
                                <Badge variant="outline" class="batshit-settings-pill shrink-0">
                                  {selectedTranscribeLaneLabel}
                                </Badge>
                              </div>
                            {:else if !sttModelManual && sttProviderModelOptions.length > 0}
                              <Select.Root
                                type="single"
                                value={sttDisplayedModel as unknown as string}
                                onValueChange={(value) =>
                                  handleSttModelChange(Array.isArray(value) ? value[0] : value)}
                              >
                                <Select.Trigger class="w-full justify-between">
                                  <span class="truncate">{sttDisplayedModel || 'Select model'}</span>
                                  <Badge variant="outline" class="batshit-settings-pill shrink-0">
                                    {selectedTranscribeLaneLabel}
                                  </Badge>
                                </Select.Trigger>
                                <Select.Content>
                                  {#each sttProviderModelOptions as model (model.value)}
                                    <Select.Item value={model.value}>
                                      <div class="flex items-center justify-between gap-2">
                                        <span>{model.value}</span>
                                        <div class="flex shrink-0 items-center gap-1.5">
                                          <Badge variant="outline" class="batshit-settings-pill">
                                            {getTranscribeSttLaneLabel(selectedSttProvider)}
                                          </Badge>
                                          {#if model.isDefault}
                                            <Badge variant="outline" class="batshit-settings-child-label">Default</Badge>
                                          {/if}
                                        </div>
                                      </div>
                                    </Select.Item>
                                  {/each}
                                </Select.Content>
                              </Select.Root>
                            {:else}
                              <div class="flex min-w-0 items-center gap-2">
                                <Input
                                  id="stt-model"
                                  class="min-w-0 flex-1"
                                  placeholder={selectedSttDefaultModel ?? 'Model ID'}
                                  bind:value={settings.sttModel}
                                />
                                <Badge variant="outline" class="batshit-settings-pill shrink-0">
                                  {selectedTranscribeLaneLabel}
                                </Badge>
                              </div>
                            {/if}
                          </div>
                          {#if !sttHasSingleModelOption}
                            <Button
                              variant="ghost"
                              size="sm"
                              class="batshit-button-shrink-0"
                              onclick={() => (sttModelManual = !sttModelManual)}
                            >
                              <Pencil aria-hidden="true" />
                              {sttModelManual ? 'Use list' : 'Enter manually'}
                            </Button>
                          {/if}
                        </div>
                      </div>
                    </div>
                    {/if}
                  </div>
                </div>

              </div>
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="voice-global-cards"
            title="Voice Mode (Input/STT + TTS)"
            icon={AudioLines}
            contentClass="space-y-6"
            open
          >
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Voice Mode" contentClass="w-80">
                  <p>
                    Choose the runtime, input mode, listening engine, and text-to-speech defaults for phone-style Voice Mode.
                    Per-agent TTS and listener overrides still live in Agent Settings.
                  </p>
                </SettingsInfoMenu>
            {/snippet}
              {#if providersLoading}
                <div class="batshit-settings-caption flex items-center gap-2">
                  <Loader2 class="h-3 w-3 animate-spin" />
                  Loading providers…
                </div>
              {/if}

              <div class="space-y-4">
                <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-form-label">Voice Runtime</p>
                      <SettingsInfoMenu ariaLabel="About Voice Runtime" contentClass="w-80">
                        <p>
                          Direct Voice Mode uses Batshit STT and TTS directly. LiveKit Bridge starts a LiveKit room from the main Voice button; it is separate from true speech-to-speech model presets.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                    {#if settings.voiceSessionRuntime === 'livekit'}
                      <Badge variant="outline" class="batshit-settings-pill is-info">Experimental</Badge>
                    {/if}
                  </div>
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Runtime</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={(settings.voiceSessionRuntime ?? 'direct') as unknown as string}
                          onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value
                            handleSettingsChange({
                              voiceSessionRuntime: next === 'livekit' ? 'livekit' : 'direct'
                            })
                          }}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {settings.voiceSessionRuntime === 'livekit'
                                ? 'LiveKit Bridge (room + sidecar)'
                                : 'Direct Voice Mode (STT + TTS)'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="direct">Direct Voice Mode (STT + TTS)</Select.Item>
                            <Select.Item value="livekit">LiveKit Bridge (room + sidecar)</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-form-label">Voice Mode Input</p>
                      <SettingsInfoMenu ariaLabel="About Voice Mode Input" contentClass="w-80">
                        <p>
                          Mic STT lets Batshit listen through the selected Voice Mode STT provider.
                          Text Input keeps Voice Mode active for spoken replies while you type or use
                          system dictation in the composer.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                    <Badge
                      variant="outline"
                      class={`batshit-settings-pill ${voiceModeUsesSttInput ? 'is-success' : 'is-info'}`}
                    >
                      {voiceModeUsesSttInput ? 'Mic STT' : 'Text Input'}
                    </Badge>
                  </div>
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Input</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={(settings.voiceModeInputMode ?? DEFAULT_VOICE_MODE_INPUT_MODE) as unknown as string}
                          onValueChange={(value) =>
                            handleVoiceModeInputModeChange((Array.isArray(value) ? value[0] : value) as string)}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {voiceModeUsesSttInput ? 'Mic STT' : 'Text Input'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="stt">Mic STT</Select.Item>
                            <Select.Item value="text">Text Input</Select.Item>
                          </Select.Content>
                        </Select.Root>
                        {#if !voiceModeUsesSttInput}
                          <p class="batshit-settings-inline-alert is-info">
                            Voice Mode will speak replies and keep voice context active, but it will
                            not use the Voice Mode STT provider while Text Input is selected.
                          </p>
                        {/if}
                      </div>
                    </div>
                  </div>
                </div>

                <div class={`batshit-settings-card-subtle-frame is-spacious space-y-3 ${voiceModeUsesSttInput ? '' : 'opacity-75'}`}>
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-form-label">Voice Mode STT</p>
                      <SettingsInfoMenu ariaLabel="About Voice Mode STT" contentClass="w-80">
                        <p>
                          This is the listening engine for phone-style two-way voice chat. It can use
                          realtime microphone input when supported, or recorded-turn transcription
                          when the provider works from uploaded audio.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                    {#if !voiceModeUsesSttInput}
                      <Badge variant="outline" class="batshit-settings-pill is-info">
                        Not used in Text Input
                      </Badge>
                    {:else if selectedRealtimeSttProvider?.ready === false}
                      <Badge variant="outline" class="batshit-settings-pill is-warning">
                        {selectedRealtimeSttProvider?.statusHint ?? 'Not ready'}
                      </Badge>
                    {/if}
                  </div>
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Provider</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={(settings.realtimeSttProvider ?? 'browser') as unknown as string}
                          onValueChange={(value) =>
                            handleRealtimeSttProviderChange((Array.isArray(value) ? value[0] : value) as string)}
                          disabled={!voiceModeUsesSttInput}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {selectedRealtimeSttProvider?.label ?? 'Browser (Web Speech API)'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each realtimeSttProviderOptions as provider (provider.id)}
                              <Select.Item value={provider.id}>
                                <div class="flex items-center justify-between gap-2">
                                  <span>{provider.label}</span>
                                  <div class="flex shrink-0 items-center gap-1.5">
                                    {#if provider.ready === false}
                                      <Badge variant="outline" class="batshit-settings-pill is-warning">
                                        {provider.statusHint ?? 'Not ready'}
                                      </Badge>
                                    {/if}
                                  </div>
                                </div>
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                        {#if selectedRealtimeSttProviderSetupHint}
                          <p class="batshit-settings-inline-alert is-warning">
                            {selectedRealtimeSttProviderSetupHint}
                          </p>
                        {/if}
                        {#if !voiceModeUsesSttInput}
                          <p class="batshit-settings-inline-alert is-info">
                            Saved for Mic STT, but ignored while Voice Mode Input is Text Input.
                          </p>
                        {/if}
                        {#if selectedVoiceModeSttNotice}
                          <p class="batshit-settings-inline-alert is-warning">
                            {selectedVoiceModeSttNotice}
                          </p>
                        {/if}
                        {#if selectedRealtimeSttCapabilities}
                          <div class="flex flex-wrap items-center gap-1.5 pt-1">
                            {#if selectedRealtimeSttCapabilities.realtime}
                              <Badge variant="outline" class="batshit-settings-child-label">Realtime</Badge>
                            {:else if selectedRealtimeSttCapabilities.runtimeSupport === 'candidate'}
                              <Badge variant="outline" class="batshit-settings-child-label">Realtime planned</Badge>
                            {/if}
                            {#if selectedRealtimeSttCapabilities.turnDetection}
                              <Badge variant="outline" class="batshit-settings-child-label">Turn detection</Badge>
                            {/if}
                            {#if selectedRealtimeSttCapabilities.cost}
                              <Badge variant="outline" class="batshit-settings-child-label">
                                {formatSttCostLabel(selectedRealtimeSttCapabilities.cost)}
                              </Badge>
                            {/if}
                            {#if selectedRealtimeSttCapabilities.privacy}
                              <Badge variant="outline" class="batshit-settings-child-label">
                                {formatSttPrivacyLabel(selectedRealtimeSttCapabilities.privacy)}
                              </Badge>
                            {/if}
                            {#if selectedRealtimeSttCapabilities.runtimeLabel || selectedRealtimeSttCapabilities.unsupportedReason}
                              <SettingsInfoMenu ariaLabel="About selected Voice Mode STT capability" contentClass="w-80">
                                {#if selectedRealtimeSttCapabilities.runtimeLabel}
                                  <p>{selectedRealtimeSttCapabilities.runtimeLabel}</p>
                                {/if}
                                {#if selectedRealtimeSttCapabilities.unsupportedReason}
                                  <p>{selectedRealtimeSttCapabilities.unsupportedReason}</p>
                                {/if}
                              </SettingsInfoMenu>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    </div>

                    {#if selectedRealtimeSttNeedsModel}
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <Label.Label class="batshit-settings-form-label">Model</Label.Label>
                          </div>
                        </div>
                        <div class="batshit-settings-form-control">
                          <div class="flex items-center gap-2">
                            <div class="min-w-0 flex-1">
                              {#if realtimeSttHasSingleModelOption}
                                <div class="flex min-w-0 items-center gap-2">
                                  <Input class="min-w-0 flex-1" value={realtimeSttDisplayedModel} disabled />
                                  <Badge variant="outline" class={`${selectedVoiceModeSttBadgeClass} shrink-0`}>
                                    {selectedVoiceModeSttLaneLabel}
                                  </Badge>
                                </div>
                              {:else if !realtimeSttModelManual && realtimeSttProviderModelOptions.length > 0}
                                <Select.Root
                                  type="single"
                                  value={realtimeSttDisplayedModel as unknown as string}
                                  onValueChange={(value) =>
                                    handleRealtimeSttModelChange(Array.isArray(value) ? value[0] : value)}
                                  disabled={!voiceModeUsesSttInput}
                                >
                                  <Select.Trigger class="w-full justify-between">
                                    <span class="truncate">{realtimeSttDisplayedModel || 'Select model'}</span>
                                    <Badge variant="outline" class={`${selectedVoiceModeSttBadgeClass} shrink-0`}>
                                      {selectedVoiceModeSttLaneLabel}
                                    </Badge>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each realtimeSttProviderModelOptions as model (model.value)}
                                      <Select.Item value={model.value}>
                                        <div class="flex items-center justify-between gap-2">
                                          <span>{model.value}</span>
                                          <div class="flex shrink-0 items-center gap-1.5">
                                            <Badge variant="outline" class={getVoiceModeSttBadgeClass(selectedRealtimeSttProvider)}>
                                              {getVoiceModeSttLaneLabel(selectedRealtimeSttProvider)}
                                            </Badge>
                                            {#if model.isDefault}
                                              <Badge variant="outline" class="batshit-settings-child-label">Default</Badge>
                                            {/if}
                                          </div>
                                        </div>
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              {:else}
                                <div class="flex min-w-0 items-center gap-2">
                                  <Input
                                    id="realtime-stt-model"
                                    class="min-w-0 flex-1"
                                    placeholder={selectedRealtimeSttDefaultModel ?? 'Model ID'}
                                    bind:value={settings.realtimeSttModel}
                                    disabled={!voiceModeUsesSttInput}
                                  />
                                  <Badge variant="outline" class={`${selectedVoiceModeSttBadgeClass} shrink-0`}>
                                    {selectedVoiceModeSttLaneLabel}
                                  </Badge>
                                </div>
                              {/if}
                            </div>
                            {#if !realtimeSttHasSingleModelOption}
                              <Button
                                variant="ghost"
                                size="sm"
                                class="batshit-button-shrink-0"
                                onclick={() => (realtimeSttModelManual = !realtimeSttModelManual)}
                                disabled={!voiceModeUsesSttInput}
                              >
                                <Pencil aria-hidden="true" />
                                {realtimeSttModelManual ? 'Use list' : 'Enter manually'}
                              </Button>
                            {/if}
                          </div>
                        </div>
                      </div>
                    {/if}

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Turn Mode</Label.Label>
                          <SettingsInfoMenu ariaLabel="About Voice Mode Turn Mode" contentClass="w-80">
                            <p>
                              Auto Listen starts the next recorded turn when Batshit is ready for
                              you. Manual Turn lets you start each recorded Direct Voice Mode turn
                              yourself, then stop it to send.
                            </p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={(voiceModeTurnSettings.submitMode ?? DEFAULT_VOICE_MODE_SUBMIT_MODE) as unknown as string}
                          onValueChange={(value) => {
                            const next = (Array.isArray(value) ? value[0] : value) as string
                            if (next === 'manual' && !manualTurnAvailable) return
                            handleVoiceModeSubmitModeChange(next)
                          }}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {voiceModeTurnSettings.submitMode === 'manual' && !manualTurnAvailable
                                ? 'Auto Listen (Manual disabled)'
                                : effectiveVoiceModeSubmitModeLabel}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="auto">Auto Listen</Select.Item>
                            <Select.Item value="manual" disabled={!manualTurnAvailable}>
                              <div class="flex items-center justify-between gap-2">
                                <span>Manual Turn</span>
                                {#if !manualTurnAvailable}
                                  <Badge variant="outline" class="batshit-settings-pill is-warning">
                                    Unavailable
                                  </Badge>
                                {/if}
                              </div>
                            </Select.Item>
                          </Select.Content>
                        </Select.Root>
                        {#if !manualTurnAvailable}
                          <p class="batshit-settings-inline-alert is-info">
                            {manualTurnUnavailableReason}
                          </p>
                        {/if}
                      </div>
                    </div>

                    {#if effectiveVoiceModeSubmitMode !== 'manual'}
                      <div class="batshit-settings-form-row is-compact">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <Label.Label class="batshit-settings-form-label">Pause Before Send</Label.Label>
                            <SettingsInfoMenu ariaLabel="About Pause Before Send" contentClass="w-80">
                              <p>
                                Controls how long a quiet pause should be before Voice Mode treats the
                                turn as finished. For recorded-turn providers, Auto Listen uses this
                                pause to stop the current recording and send it to the selected STT
                                provider.
                              </p>
                            </SettingsInfoMenu>
                          </div>
                        </div>
                        <div class="batshit-settings-form-control-group">
                          <div class="flex items-center justify-between gap-3">
                            <span class="batshit-settings-child-label">
                              {(MIN_VOICE_MODE_AUTO_SUBMIT_DELAY_MS / 1000).toFixed(1)}s
                            </span>
                            <span class="batshit-settings-caption tabular-nums">
                              {((voiceModeTurnSettings.autoSubmitDelayMs ?? DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS) / 1000).toFixed(1)}s
                            </span>
                            <span class="batshit-settings-child-label">
                              {(MAX_VOICE_MODE_AUTO_SUBMIT_DELAY_MS / 1000).toFixed(1)}s
                            </span>
                          </div>
                          <Slider
                            type="single"
                            value={voiceModeTurnSettings.autoSubmitDelayMs ?? DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS}
                            onValueChange={handleVoiceModeAutoSubmitDelayChange}
                            min={MIN_VOICE_MODE_AUTO_SUBMIT_DELAY_MS}
                            max={MAX_VOICE_MODE_AUTO_SUBMIT_DELAY_MS}
                            step={100}
                            disabled={!voiceModeUsesSttInput}
                          />
                        </div>
                      </div>
                    {/if}

                    <div class="batshit-settings-form-row is-compact">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">End Confidence</Label.Label>
                          <SettingsInfoMenu ariaLabel="About End Confidence" contentClass="w-80">
                            <p>
                              Higher values make Voice Mode more cautious before deciding you are
                              done, which can help around noise or tiny pauses but may wait longer.
                            </p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control-group">
                        <div class="flex items-center justify-between gap-3">
                          <span class="batshit-settings-child-label">
                            {MIN_VOICE_MODE_END_OF_TURN_THRESHOLD.toFixed(2)}
                          </span>
                          <span class="batshit-settings-caption tabular-nums">
                            {(voiceModeTurnSettings.endOfTurnThreshold ?? DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD).toFixed(2)}
                          </span>
                          <span class="batshit-settings-child-label">
                            {MAX_VOICE_MODE_END_OF_TURN_THRESHOLD.toFixed(2)}
                          </span>
                        </div>
                        <Slider
                          type="single"
                          value={voiceModeTurnSettings.endOfTurnThreshold ?? DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD}
                          onValueChange={handleVoiceModeEndOfTurnThresholdChange}
                          min={MIN_VOICE_MODE_END_OF_TURN_THRESHOLD}
                          max={MAX_VOICE_MODE_END_OF_TURN_THRESHOLD}
                          step={0.05}
                          disabled={!voiceModeUsesSttInput}
                        />
                      </div>
                    </div>
                  </div>

                </div>

                <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
                  <div class="flex items-center justify-between gap-2">
                    <p class="batshit-settings-form-label">Text-to-Speech (TTS)</p>
                    {#if selectedTtsProvider?.ready === false}
                      <Badge variant="outline" class="batshit-settings-pill is-warning">
                        {selectedTtsProvider?.statusHint ?? 'Not ready'}
                      </Badge>
                    {/if}
                  </div>
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Provider</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={(settings.ttsProvider ?? 'browser') as unknown as string}
                          onValueChange={(value) =>
                            handleTtsProviderChange((Array.isArray(value) ? value[0] : value) as string)}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {selectedTtsProvider?.label ?? 'Browser (Web Speech API)'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each ttsProviderOptions as provider (provider.id)}
                              <Select.Item value={provider.id}>
                                <div class="flex items-center justify-between gap-2">
                                  <span>{provider.label}</span>
                                  <div class="flex shrink-0 items-center gap-1.5">
                                    {#if provider.ready === false}
                                      <Badge variant="outline" class="batshit-settings-pill is-warning">
                                        {provider.statusHint ?? 'Not ready'}
                                      </Badge>
                                    {/if}
                                  </div>
                                </div>
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                        {#if selectedTtsProviderSetupHint}
                          <p class="batshit-settings-inline-alert is-warning">
                            {selectedTtsProviderSetupHint}
                          </p>
                        {/if}
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Model</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <div class="flex items-center gap-2">
                          <div class="min-w-0 flex-1">
                            {#if ttsHasSingleModelOption}
                              <div class="flex min-w-0 items-center gap-2">
                                <Input class="min-w-0 flex-1" value={ttsDisplayedModel} disabled />
                                <Badge variant="outline" class={`${selectedTtsBadgeClass} shrink-0`}>
                                  {selectedTtsLaneLabel}
                                </Badge>
                              </div>
                            {:else if !ttsModelManual && ttsProviderModelOptions.length > 0}
                              <Select.Root
                                type="single"
                                value={ttsDisplayedModel as unknown as string}
                                onValueChange={(value) =>
                                  handleSettingsChange({ ttsModel: Array.isArray(value) ? value[0] : value })}
                              >
                                <Select.Trigger class="w-full justify-between">
                                  <span class="truncate">{ttsDisplayedModel || 'Select model'}</span>
                                  <Badge variant="outline" class={`${selectedTtsBadgeClass} shrink-0`}>
                                    {selectedTtsLaneLabel}
                                  </Badge>
                                </Select.Trigger>
                                <Select.Content>
                                  {#each ttsProviderModelOptions as model (model.value)}
                                    <Select.Item value={model.value}>
                                      <div class="flex items-center justify-between gap-2">
                                        <span>{model.value}</span>
                                        <div class="flex shrink-0 items-center gap-1.5">
                                          <Badge variant="outline" class={getTtsBadgeClass(selectedTtsProvider)}>
                                            {getTtsLaneLabel(selectedTtsProvider)}
                                          </Badge>
                                          {#if model.isDefault}
                                            <Badge variant="outline" class="batshit-settings-child-label">Default</Badge>
                                          {/if}
                                        </div>
                                      </div>
                                    </Select.Item>
                                  {/each}
                                </Select.Content>
                              </Select.Root>
                            {:else}
                              <div class="flex min-w-0 items-center gap-2">
                                <Input
                                  id="tts-model"
                                  class="min-w-0 flex-1"
                                  placeholder={selectedTtsDefaultModel ?? 'gpt-4o-mini-tts'}
                                  bind:value={settings.ttsModel}
                                />
                                <Badge variant="outline" class={`${selectedTtsBadgeClass} shrink-0`}>
                                  {selectedTtsLaneLabel}
                                </Badge>
                              </div>
                            {/if}
                          </div>
                          {#if !ttsHasSingleModelOption}
                            <Button
                              variant="ghost"
                              size="sm"
                              class="batshit-button-shrink-0"
                              onclick={() => (ttsModelManual = !ttsModelManual)}
                            >
                              <Pencil aria-hidden="true" />
                              {ttsModelManual ? 'Use list' : 'Enter manually'}
                            </Button>
                          {/if}
                        </div>
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Voice</Label.Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control-group">
                        <div class="flex items-center gap-2">
                          <div class="min-w-0 flex-1">
                            {#if canUseTtsVoiceDropdown && !ttsVoiceManual}
                              <Select.Root
                                type="single"
                                value={displayedTtsVoiceId as unknown as string}
                                onValueChange={(value) => {
                                  const nextVoiceId = Array.isArray(value) ? value[0] : value
                                  const selectedProfile = profiles.find(
                                    (profile) =>
                                      profile.provider === (settings.ttsProvider ?? 'browser') &&
                                      profile.voiceId === nextVoiceId
                                  )
                                  handleSettingsChange({
                                    ttsVoiceId: nextVoiceId,
                                    ttsProfileId: selectedProfile?.id ?? ''
                                  })
                                }}
                              >
                                <Select.Trigger class="w-full justify-between">
                                  <span class="truncate">{displayedTtsVoiceName}</span>
                                </Select.Trigger>
                                <Select.Content>
                                  {#each ttsVoiceOptions as voice (voice.id)}
                                    <Select.Item value={voice.id}>
                                      <div class="flex items-center justify-between gap-2">
                                        <span>{voice.name}</span>
                                        <div class="flex items-center gap-1">
                                          {#if voice.isDefault}
                                            <Badge variant="outline" class="batshit-settings-child-label">Default</Badge>
                                          {/if}
                                          {#if voice.isClone}
                                            <Badge variant="outline" class="batshit-settings-child-label">Clone</Badge>
                                          {/if}
                                        </div>
                                      </div>
                                    </Select.Item>
                                  {/each}
                                </Select.Content>
                              </Select.Root>
                            {:else}
                              <Input
                                placeholder={selectedTtsProvider?.defaultVoice ?? 'Voice ID (if supported)'}
                                value={settings.ttsVoiceId}
                                oninput={(event) =>
                                  handleSettingsChange({
                                    ttsVoiceId: (event.currentTarget as HTMLInputElement).value,
                                    ttsProfileId: ''
                                  })}
                              />
                            {/if}
                          </div>
                          {#if canUseTtsVoiceDropdown}
                            <div class="flex shrink-0 items-center gap-2">
                              {#if selectedTtsProvider?.supports.listVoices}
                                <Button
                                  variant="ghost"
                                  size="sm"

                                  onclick={() => loadVoices(settings.ttsProvider ?? 'browser', settings.ttsModel ?? '')}
                                  disabled={voicesLoading}
                                >
                                  <RefreshCcw class={`${voicesLoading ? 'animate-spin' : ''}`} />
                                  Refresh
                                </Button>
                              {/if}
                              <Button
                                variant="ghost"
                                size="sm"

                                onclick={() => (ttsVoiceManual = !ttsVoiceManual)}
                              >
                                {ttsVoiceManual ? 'Use list' : 'Enter manually'}
                              </Button>
                            </div>
                          {/if}
                        </div>
                        {#if voicesError}
                          <p class="batshit-settings-form-help text-amber-600">{voicesError}</p>
                        {/if}
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label">Italic narration</Label.Label>
                          <SettingsInfoMenu ariaLabel="About italic narration">
                            <p>
                              When this is silent, Batshit keeps italic text visible in chat but
                              removes it from Batshit-owned TTS playback.
                            </p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <div class="batshit-settings-muted-panel flex items-center justify-between">
                          <span class="batshit-settings-form-label">
                            {settings.ttsItalicNarrationBehavior === 'silent' ? 'Silent' : 'Spoken'}
                          </span>
                          <Switch.Root
                            checked={settings.ttsItalicNarrationBehavior !== 'silent'}
                            onCheckedChange={(value) =>
                              handleSettingsChange({
                                ttsItalicNarrationBehavior: value === true ? 'speak' : 'silent'
                              })}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label class="batshit-settings-form-label" for="global-voice-preview">
                            Voice Preview
                          </Label.Label>
                          <SettingsInfoMenu ariaLabel="About Global Voice Preview" contentClass="w-72">
                            <p>
                              Preview the currently selected default TTS provider, model, and voice
                              right here while you are changing them.
                            </p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <div class="flex items-center gap-2 no-lastpass">
                          <Input
                            id="global-voice-preview"
                            name="voice-preview-phrase"
                            type="text"
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck={false}
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-form-type="other"
                            bind:value={testPhrase}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onclick={handlePreview}
                            disabled={previewBusy}
                          >
                            {#if previewBusy}
                              <Loader2 class="animate-spin" />
                            {:else}
                              <Play  />
                            {/if}
                            Play
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {#if providersError}
                <div class="batshit-settings-inline-alert is-warning">
                  {providersError}
                </div>
              {/if}
          </SettingsAccordionCard>
        </div>
      {/if}

      {#if activeTab === 'studio'}
        <div class="space-y-4">
          <div class="flex items-center gap-1.5">
            <BatshitIcon id="voice-studio" class="h-5 w-5 text-muted-foreground" />
            <h3 class="batshit-settings-section-title">Voice Studio</h3>
            <SettingsInfoMenu ariaLabel="About Voice Studio" contentClass="w-80">
              <p>
                Use Voice Studio for creating and managing saved voice clones, and for previewing
                the saved clones you want to test.
              </p>
            </SettingsInfoMenu>
          </div>

          <SettingsAccordionCard
            name="voice-studio-cards"
            title="Voice Clones"
            batshitIcon="voice-studio"
            contentClass="space-y-4"
            open
          >
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Voice Clones" contentClass="w-80">
                  <p>
                    Create reusable cloned voices from reference audio and reuse them across Batshit.
                    Clone-capable BYO engines store the sample locally and replay it through the
                    engine&apos;s normal TTS path.
                  </p>
                </SettingsInfoMenu>
            {/snippet}
              {#if cloneProviderOptions.length === 0}
                <div class="batshit-settings-muted-panel batshit-settings-caption">
                  No clone-capable providers are available right now. Install or enable a provider
                  with truthful clone support first.
                </div>
              {:else}
                <div class="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                  <CreateVoiceCloneCard
                    {cloneProviderOptions}
                    {cloneProviderReady}
                    {cloneTranscribeProviderOptions}
                    {selectedCloneTranscribeProvider}
                    {cloneFile}
                    {clonePreviewUrl}
                    {cloneTranscribeBusy}
                    {cloneTranscribeError}
                    {cloneError}
                    {cloneBusy}
                    bind:cloneProvider
                    bind:cloneName
                    bind:cloneReferenceText
                    bind:cloneTranscribeProvider
                    bind:cloneConsent
                    onCloneFileChange={handleCloneFileChange}
                    onTranscribeCloneReference={handleTranscribeCloneReference}
                    onCloneVoice={handleCloneVoice}
                  />

                  <SavedVoiceClonesPanel
                    {profiles}
                    {profilesLoading}
                    {profilesError}
                    {selectedClone}
                    bind:selectedCloneId
                    bind:testPhrase
                    {previewBusy}
                    onDeleteProfile={handleDeleteProfile}
                    onPreview={(clone) => handlePreview({ clone })}
                  />
                </div>
              {/if}
          </SettingsAccordionCard>
        </div>
      {/if}

      {#if activeTab === 'engine-manager'}
        <div class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-1.5">
              <BatshitIcon id="voice-engine-manager" class="h-5 w-5 text-muted-foreground" />
              <h3 class="batshit-settings-section-title">Voice Engine Manager</h3>
              <SettingsInfoMenu ariaLabel="About Voice Engine Manager" contentClass="w-80">
                <p>
                  Speech engines are managed by your agent using Batshit tools. TTS prompts, STT
                  capability status, and installed-engine controls are separated here so each lane
                  is easier to audit.
                </p>
              </SettingsInfoMenu>
            </div>
            <div class="flex flex-wrap items-center justify-end gap-2">
              <SettingsSaveStatus
                state={settingsSaveState}
                error={settingsSaveError}
                sticky={false}
                savedLabel="Settings saved"
              />
              <SettingsSaveStatus
                state={engineSaveState}
                error={engineSaveError}
                sticky={false}
                savedLabel="Engines saved"
              />
            </div>
          </div>

          <SettingsAccordionCard
            name="voice-engine-manager-sections"
            title="Voice Runtimes"
            icon={Radio}
            contentClass="space-y-4"
            open={openVoiceEngineSectionId === 'runtimes'}
            ontoggle={(event) => handleVoiceEngineSectionToggle('runtimes', event)}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Voice Runtimes" contentClass="w-80">
                <p>
                  Voice runtimes manage live conversation transports such as LiveKit. They sit above
                  normal TTS/STT engines and can own room audio, sidecars, startup, and health.
                </p>
              </SettingsInfoMenu>
            {/snippet}

            <div class="batshit-settings-muted-panel is-loose space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <div class="batshit-settings-icon-frame h-9 w-9 shrink-0">
                    <Radio class="h-5 w-5" />
                  </div>
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="batshit-settings-form-label">LiveKit</p>
                      {#if settings.voiceSessionRuntime === 'livekit'}
                        <Badge variant="outline" class="batshit-settings-pill is-info">Selected</Badge>
                      {/if}
                    </div>
                    <p class="truncate text-xs text-muted-foreground">
                      Runtime: voice-session transport
                    </p>
                  </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" class={getLiveKitRuntimeBadgeClass(liveKitRuntime)}>
                    {#if liveKitRuntimeLoading && liveKitRuntimeAction === 'refresh'}
                      <Loader2 class="mr-1 h-3 w-3 animate-spin" />
                    {/if}
                    {getLiveKitRuntimeStatusLabel(liveKitRuntime)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={() => loadLiveKitRuntime()}
                    disabled={liveKitRuntimeLoading}
                  >
                    {#if liveKitRuntimeLoading && liveKitRuntimeAction === 'refresh'}
                      <Loader2 class="animate-spin" />
                    {:else}
                      <RefreshCcw />
                    {/if}
                    Refresh
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={() => startLiveKitRuntime()}
                    disabled={liveKitRuntimeStartDisabled(liveKitRuntime)}
                  >
                    {#if liveKitRuntimeLoading && (liveKitRuntimeAction === 'start' || liveKitRuntimeAction === 'install')}
                      <Loader2 class="animate-spin" />
                    {:else if liveKitRuntime?.status === 'ready'}
                      <RefreshCcw />
                    {:else if shouldInstallNativeLiveKitRuntime(liveKitRuntime)}
                      <Download />
                    {:else}
                      <Play />
                    {/if}
                    {getLiveKitRuntimeStartLabel(liveKitRuntime)}
                  </Button>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-between gap-3 batshit-settings-muted-panel">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="batshit-settings-form-label">Start with Batshit</span>
                  <SettingsInfoMenu ariaLabel="About LiveKit Start with Batshit" contentClass="w-80">
                    <p>
                      When this is on, native Batshit starts the managed local LiveKit server and
                      sidecar after you sign in. In Docker installs, this uses the approved LiveKit
                      runtime add-on.
                    </p>
                  </SettingsInfoMenu>
                </div>
                <Switch.Root
                  checked={settings.liveKitAutoStartOnLaunch === true}
                  onCheckedChange={(value) =>
                    handleSettingsChange({
                      liveKitAutoStartOnLaunch: value === true
                    })}
                />
              </div>

              {#if liveKitRuntime?.statusHint || liveKitRuntimeError}
                <p
                  class={`batshit-settings-inline-alert ${
                    liveKitRuntime?.status === 'ready' ? 'is-info' : 'is-warning'
                  }`}
                >
                  {liveKitRuntimeError ?? liveKitRuntime?.statusHint}
                </p>
              {/if}

              {#if shouldShowLiveKitSetupPanel(liveKitRuntime)}
                <div class="batshit-settings-card-subtle-frame is-compact space-y-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="batshit-settings-child-label">
                      {getLiveKitSetupTitle(liveKitRuntime)}
                    </p>
                    <Badge variant="outline" class="batshit-settings-pill">Optional</Badge>
                  </div>
                  <p class="text-xs leading-5 text-muted-foreground">
                    {getLiveKitSetupBody(liveKitRuntime)}
                  </p>
                  {#if isDockerLiveKitRuntime(liveKitRuntime)}
                    <div class="rounded-md border border-border/50 bg-background/60 px-3 py-2">
                      <code class="batshit-settings-code-caption">
                        {LIVEKIT_DOCKER_PROFILE_COMMAND}
                      </code>
                    </div>
                    <SettingsInfoMenu
                      ariaLabel="Advanced LiveKit Docker command"
                      contentClass="w-80 sm:w-96"
                    >
                      <p>
                        Advanced Compose path:
                        <code>{LIVEKIT_DOCKER_COMPOSE_COMMAND}</code>
                      </p>
                    </SettingsInfoMenu>
                  {/if}
                </div>
              {/if}

              {#if liveKitRuntime?.agentName || liveKitRuntime?.healthUrl || liveKitRuntime?.server?.url}
                <div class="grid gap-2 sm:grid-cols-2">
                  <div class="batshit-settings-card-subtle-frame is-compact">
                    <p class="batshit-settings-child-label">Agent</p>
                    <p class="truncate text-xs text-muted-foreground">
                      {liveKitRuntime?.agentName ?? 'Not registered yet'}
                    </p>
                  </div>
                  <div class="batshit-settings-card-subtle-frame is-compact">
                    <p class="batshit-settings-child-label">Health</p>
                    <p class="truncate text-xs text-muted-foreground">{liveKitRuntime?.healthUrl}</p>
                  </div>
                  {#if liveKitRuntime?.server?.url}
                    <div class="batshit-settings-card-subtle-frame is-compact">
                      <p class="batshit-settings-child-label">Server</p>
                      <p class="truncate text-xs text-muted-foreground">
                        {liveKitRuntime.server.url}
                      </p>
                    </div>
                  {/if}
                  {#if liveKitRuntime?.server?.containerName}
                    <div class="batshit-settings-card-subtle-frame is-compact">
                      <p class="batshit-settings-child-label">Container</p>
                      <p class="truncate text-xs text-muted-foreground">
                        {liveKitRuntime.server.containerName}
                      </p>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="voice-engine-manager-sections"
            title="Text-to-Speech Engines"
            icon={AudioLines}
            contentClass="space-y-4"
            open={openVoiceEngineSectionId === 'tts'}
            ontoggle={(event) => handleVoiceEngineSectionToggle('tts', event)}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Text-to-Speech Engines" contentClass="w-80">
                <p>
                  Engine prompts are added to the current message only when Batshit will speak the
                  assistant reply with that TTS provider. Use them for provider-specific expression
                  syntax, pronunciation rules, or style limits.
                </p>
              </SettingsInfoMenu>
            {/snippet}

            {#if ttsEngineProviders.length === 0}
              <div class="batshit-settings-muted-panel batshit-settings-caption">
                No TTS providers are available yet.
              </div>
            {:else}
              <div class="space-y-3">
                {#each ttsEngineProviders as provider (provider.id)}
                  {@const promptValue = getTtsEnginePrompt(provider.id)}
                  <Collapsible.Root open={openTtsEngineAccordionId === provider.id}>
                    <div class="batshit-settings-muted-panel is-loose space-y-3">
                      <button
                        type="button"
                        class="batshit-settings-option-card w-full"
                        aria-expanded={openTtsEngineAccordionId === provider.id}
                        onclick={() => toggleTtsEngineAccordion(provider.id)}
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="flex min-w-0 items-center gap-3">
                            <div class="batshit-settings-icon-frame h-9 w-9 shrink-0">
                              <AudioLines class="h-5 w-5" />
                            </div>
                            <div class="min-w-0">
                              <div class="flex flex-wrap items-center gap-2">
                                <p class="batshit-settings-form-label truncate">{provider.label}</p>
                                {#if provider.id === (settings.ttsProvider ?? 'browser')}
                                  <Badge variant="outline" class="batshit-settings-pill is-info">Selected</Badge>
                                {/if}
                              </div>
                              <p class="truncate text-xs text-muted-foreground">Provider ID: {provider.id}</p>
                            </div>
                          </div>
                          <div class="flex items-center gap-2">
                            <Badge variant="outline" class="batshit-settings-child-label">
                              {getVoiceProviderTypeLabel(provider)}
                            </Badge>
                            {#if provider.supports.streaming}
                              <Badge variant="outline" class="batshit-settings-child-label">Realtime TTS</Badge>
                            {:else}
                              <Badge variant="outline" class="batshit-settings-child-label">Batch TTS</Badge>
                            {/if}
                            {#if provider.supports.styles || provider.supports.emotions}
                              <Badge variant="outline" class="batshit-settings-child-label">Expressive</Badge>
                            {/if}
                            <Badge variant="outline" class={getVoiceProviderStatusClass(provider)}>
                              {getVoiceProviderStatusLabel(provider)}
                            </Badge>
                            <ChevronDown
                              class={`h-4 w-4 transition-transform ${openTtsEngineAccordionId === provider.id ? 'rotate-180' : ''}`}
                            />
                          </div>
                        </div>
                      </button>
                      <Collapsible.Content class="space-y-3 pt-2">

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Label
                            class="batshit-settings-form-label"
                          >
                            TTS Engine Prompt
                          </Label.Label>
                          <SettingsInfoMenu ariaLabel={`About ${provider.label} TTS engine prompt`} contentClass="w-80">
                            <p>
                              This is prompt guidance for the AI before it writes text that Batshit
                              sends to this TTS engine. It does not change saved chat text, provider
                              credentials, or STT transcription.
                            </p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control is-inline-status">
                        <Badge
                          variant="outline"
                          class={`batshit-settings-pill ${promptValue ? 'is-info' : ''}`}
                        >
                          {promptValue ? 'Custom prompt' : 'No custom prompt'}
                        </Badge>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Edit ${provider.label} TTS engine prompt`}
                          onclick={() => openTtsEnginePromptEditor(provider)}
                        >
                          <Pencil aria-hidden="true" />
                          Edit
	                        </Button>
	                      </div>
	                    </div>

	                    {#if getBuiltInTtsEngineAdvancedFields(provider.id).length > 0 || getByoEngineAdvancedSections(provider.id, 'tts').length > 0}
	                      <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
	                        <div class="flex items-center gap-1.5">
	                          <p class="batshit-settings-form-label">Advanced Settings</p>
	                          <SettingsInfoMenu ariaLabel={`About ${provider.label} advanced TTS settings`} contentClass="w-80">
	                            <p>
	                              These settings are saved for this engine and reused anywhere Batshit
	                              speaks through it.
	                            </p>
	                          </SettingsInfoMenu>
	                        </div>
	                        <div class="batshit-settings-form-stack">
	                          {#each getBuiltInTtsEngineAdvancedFields(provider.id) as field (field.id)}
	                            {@const commonKey = getCommonKeyForCapabilityField(field)}
	                            {@const optionKey = getProviderOptionKeyForCapabilityField(provider.id, field)}
	                            <div class="batshit-settings-form-row">
	                              <div class="batshit-settings-form-copy">
	                                <div class="batshit-settings-form-label-line">
	                                  <Label.Label class="batshit-settings-form-label">{field.label}</Label.Label>
	                                  {#if field.help}
	                                    <SettingsInfoMenu ariaLabel={`About ${field.label}`}>
	                                      <p>{field.help}</p>
	                                    </SettingsInfoMenu>
	                                  {/if}
	                                </div>
	                              </div>
	                              <div class="batshit-settings-form-control">
	                                {#if commonKey}
	                                  <Input
	                                    type={field.type === 'number' ? 'number' : 'text'}
	                                    step={field.type === 'number' ? String(field.step ?? 0.01) : undefined}
	                                    min={field.type === 'number' && field.min != null ? String(field.min) : undefined}
	                                    max={field.type === 'number' && field.max != null ? String(field.max) : undefined}
	                                    placeholder={getCapabilityFieldPlaceholder(field)}
	                                    value={getTtsEngineCommonFieldValue(provider.id, field)}
	                                    oninput={(event) =>
	                                      setTtsEngineCommonFieldValue(
	                                        provider.id,
	                                        commonKey,
	                                        (event.currentTarget as HTMLInputElement).value
	                                      )}
	                                  />
	                                {:else if optionKey}
	                                  {#if field.type === 'boolean'}
	                                    <div class="batshit-settings-muted-panel flex items-center justify-between">
	                                      <span class="batshit-settings-form-label">
	                                        {getTtsEngineProviderOptionValue(provider.id, field) === true ? 'On' : 'Off'}
	                                      </span>
	                                      <Switch.Root
	                                        checked={getTtsEngineProviderOptionValue(provider.id, field) === true}
	                                        onCheckedChange={(value) =>
	                                          setTtsEngineProviderOptionValue(provider.id, optionKey, value === true)}
	                                      />
	                                    </div>
	                                  {:else if field.type === 'select'}
	                                    <Select.Root
	                                      type="single"
	                                      value={String(getTtsEngineProviderOptionValue(provider.id, field))}
	                                      onValueChange={(value) =>
	                                        setTtsEngineProviderOptionValue(
	                                          provider.id,
	                                          optionKey,
	                                          Array.isArray(value) ? value[0] : value
	                                        )}
	                                    >
	                                      <Select.Trigger class="w-full justify-between">
	                                        <span class="truncate">
	                                          {String(getTtsEngineProviderOptionValue(provider.id, field)) ||
	                                            getCapabilityFieldDefaultLabel(field)}
	                                        </span>
	                                      </Select.Trigger>
	                                      <Select.Content>
	                                        <Select.Item value="">{getCapabilityFieldDefaultLabel(field)}</Select.Item>
	                                        {#each field.options ?? [] as option (option)}
	                                          <Select.Item value={option}>{option}</Select.Item>
	                                        {/each}
	                                      </Select.Content>
	                                    </Select.Root>
	                                  {:else}
	                                    <Input
	                                      type={field.type === 'number' ? 'number' : 'text'}
	                                      step={field.type === 'number' ? String(field.step ?? 0.01) : undefined}
	                                      min={field.type === 'number' && field.min != null ? String(field.min) : undefined}
	                                      max={field.type === 'number' && field.max != null ? String(field.max) : undefined}
	                                      placeholder={getCapabilityFieldPlaceholder(field)}
	                                      value={String(getTtsEngineProviderOptionValue(provider.id, field))}
	                                      oninput={(event) =>
	                                        setTtsEngineProviderOptionValue(
	                                          provider.id,
	                                          optionKey,
	                                          (event.currentTarget as HTMLInputElement).value
	                                        )}
	                                    />
	                                  {/if}
	                                {/if}
	                              </div>
	                            </div>
	                          {/each}

	                          {#each getByoEngineAdvancedSections(provider.id, 'tts') as section (section.id)}
	                            {#if section.title && getByoEngineAdvancedSections(provider.id, 'tts').length > 1}
	                              <p class="batshit-settings-child-label">{section.title}</p>
	                            {/if}
	                            {#each section.fields as field (field.id)}
	                              <div class={`batshit-settings-form-row ${field.type === 'textarea' ? 'is-tall' : ''}`}>
	                                <div class="batshit-settings-form-copy">
	                                  <div class="batshit-settings-form-label-line">
	                                    <Label.Label class="batshit-settings-form-label">{field.label}</Label.Label>
	                                    {#if field.help}
	                                      <SettingsInfoMenu ariaLabel={`About ${field.label}`}>
	                                        <p>{field.help}</p>
	                                      </SettingsInfoMenu>
	                                    {/if}
	                                  </div>
	                                </div>
	                                <div class="batshit-settings-form-control">
	                                  {#if field.type === 'boolean'}
	                                    <div class="batshit-settings-muted-panel flex items-center justify-between">
	                                      <span class="batshit-settings-form-label">
	                                        {getByoEngineFieldValue(provider.id, field) === true ? 'On' : 'Off'}
	                                      </span>
	                                      <Switch.Root
	                                        checked={getByoEngineFieldValue(provider.id, field) === true}
	                                        onCheckedChange={(value) =>
	                                          setByoEngineFieldValue(provider.id, field, value === true)}
	                                      />
	                                    </div>
	                                  {:else if field.type === 'select'}
	                                    <Select.Root
	                                      type="single"
	                                      value={String(getByoEngineFieldValue(provider.id, field))}
	                                      onValueChange={(value) =>
	                                        setByoEngineFieldValue(provider.id, field, Array.isArray(value) ? value[0] : value)}
	                                    >
	                                      <Select.Trigger class="w-full justify-between">
	                                        <span class="truncate">
	                                          {String(getByoEngineFieldValue(provider.id, field)) ||
	                                            getByoFieldDefaultLabel(provider.id, field)}
	                                        </span>
	                                      </Select.Trigger>
	                                      <Select.Content>
	                                        <Select.Item value="">{getByoFieldDefaultLabel(provider.id, field)}</Select.Item>
	                                        {#each (field.options ?? []).filter((option) => option.value !== null) as option (`${field.id}-${String(option.value)}`)}
	                                          <Select.Item value={String(option.value)}>{option.label}</Select.Item>
	                                        {/each}
	                                      </Select.Content>
	                                    </Select.Root>
	                                  {:else if field.type === 'textarea'}
	                                    <textarea
	                                      class="batshit-settings-textarea min-h-24"
	                                      placeholder={getByoFieldPlaceholder(provider.id, field)}
	                                      value={String(getByoEngineFieldValue(provider.id, field))}
	                                      oninput={(event) =>
	                                        setByoEngineFieldValue(
	                                          provider.id,
	                                          field,
	                                          (event.currentTarget as HTMLTextAreaElement).value
	                                        )}
	                                    ></textarea>
	                                  {:else}
	                                    <Input
	                                      type={field.type === 'number' ? 'number' : 'text'}
	                                      step={field.type === 'number' && field.step != null ? String(field.step) : undefined}
	                                      min={field.type === 'number' && field.min != null ? String(field.min) : undefined}
	                                      max={field.type === 'number' && field.max != null ? String(field.max) : undefined}
	                                      placeholder={getByoFieldPlaceholder(provider.id, field)}
	                                      value={String(getByoEngineFieldValue(provider.id, field))}
	                                      oninput={(event) =>
	                                        setByoEngineFieldValue(
	                                          provider.id,
	                                          field,
	                                          (event.currentTarget as HTMLInputElement).value
	                                        )}
	                                    />
	                                  {/if}
	                                </div>
	                              </div>
	                            {/each}
	                          {/each}
	                        </div>
	                      </div>
                    {/if}
                      </Collapsible.Content>
                    </div>
                  </Collapsible.Root>
                {/each}
              </div>
            {/if}
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="voice-engine-manager-sections"
            title="Speech-to-Text Engines"
            icon={Mic}
            contentClass="space-y-4"
            open={openVoiceEngineSectionId === 'stt'}
            ontoggle={(event) => handleVoiceEngineSectionToggle('stt', event)}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Speech-to-Text Engines" contentClass="w-80">
                <p>
                  STT engines turn speech into text. Advanced language and provider options are
                  saved per engine here; BYO install, health, and startup controls live in
                  Installed Engine Controls.
                </p>
              </SettingsInfoMenu>
            {/snippet}

            {#if sttEngineProviders.length === 0}
              <div class="batshit-settings-muted-panel batshit-settings-caption">
                No STT providers are available yet.
              </div>
            {:else}
              <div class="space-y-3">
                {#each sttEngineProviders as provider (provider.id)}
                  <Collapsible.Root open={openSttEngineAccordionId === provider.id}>
                    <div class="batshit-settings-muted-panel is-loose space-y-3">
                      <button
                        type="button"
                        class="batshit-settings-option-card w-full"
                        aria-expanded={openSttEngineAccordionId === provider.id}
                        onclick={() => toggleSttEngineAccordion(provider.id)}
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="flex min-w-0 items-center gap-3">
                            <div class="batshit-settings-icon-frame h-9 w-9 shrink-0">
                              <Mic class="h-5 w-5" />
                            </div>
                            <div class="min-w-0">
                              <div class="flex flex-wrap items-center gap-2">
                                <p class="batshit-settings-form-label truncate">{provider.label}</p>
                                {#if provider.id === (settings.sttProvider ?? 'browser')}
                                  <Badge variant="outline" class="batshit-settings-pill is-info">Transcribe</Badge>
                                {/if}
                                {#if provider.id === (settings.realtimeSttProvider ?? 'browser')}
                                  <Badge variant="outline" class="batshit-settings-pill is-info">Voice Mode</Badge>
                                {/if}
                              </div>
                              <p class="truncate text-xs text-muted-foreground">Provider ID: {provider.id}</p>
                            </div>
                          </div>
                          <div class="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" class="batshit-settings-child-label">
                              {getVoiceProviderTypeLabel(provider)}
                            </Badge>
                            {#if provider.sttCapabilities?.realtime}
                              <Badge variant="outline" class="batshit-settings-child-label">Realtime mic</Badge>
                            {:else}
                              <Badge variant="outline" class="batshit-settings-child-label">Recorded audio</Badge>
                            {/if}
                            <Badge variant="outline" class={getVoiceProviderStatusClass(provider)}>
                              {getVoiceProviderStatusLabel(provider)}
                            </Badge>
                            <ChevronDown
                              class={`h-4 w-4 transition-transform ${openSttEngineAccordionId === provider.id ? 'rotate-180' : ''}`}
                            />
                          </div>
                        </div>
                      </button>
                      <Collapsible.Content class="space-y-3 pt-2">
                        {#if getBuiltInSttEngineAdvancedFields(provider.id).length > 0 || getByoEngineAdvancedSections(provider.id, 'stt').length > 0}
	                      <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
	                        <div class="flex items-center gap-1.5">
	                          <p class="batshit-settings-form-label">Advanced Settings</p>
	                          <SettingsInfoMenu ariaLabel={`About ${provider.label} advanced STT settings`} contentClass="w-80">
	                            <p>
	                              These settings are saved for this engine and reused anywhere Batshit
	                              sends audio to it.
	                            </p>
	                          </SettingsInfoMenu>
	                        </div>
	                        <div class="batshit-settings-form-stack">
	                          {#each getBuiltInSttEngineAdvancedFields(provider.id) as field (field.id)}
	                            {@const optionKey = getProviderOptionKeyForCapabilityField(provider.id, field)}
	                            <div class="batshit-settings-form-row">
	                              <div class="batshit-settings-form-copy">
	                                <div class="batshit-settings-form-label-line">
	                                  <Label.Label class="batshit-settings-form-label">{field.label}</Label.Label>
	                                  {#if field.help}
	                                    <SettingsInfoMenu ariaLabel={`About ${field.label}`}>
	                                      <p>{field.help}</p>
	                                    </SettingsInfoMenu>
	                                  {/if}
	                                </div>
	                              </div>
	                              <div class="batshit-settings-form-control">
	                                {#if field.path === 'language'}
	                                  <Input
	                                    type="text"
	                                    placeholder={getCapabilityFieldPlaceholder(field)}
	                                    value={String(getSttEngineFieldValue(provider.id, field))}
	                                    oninput={(event) =>
	                                      setSttEngineFieldValue(
	                                        provider.id,
	                                        field,
	                                        (event.currentTarget as HTMLInputElement).value
	                                      )}
	                                  />
	                                {:else if optionKey}
	                                  {#if field.type === 'boolean'}
	                                    <div class="batshit-settings-muted-panel flex items-center justify-between">
	                                      <span class="batshit-settings-form-label">
	                                        {getSttEngineFieldValue(provider.id, field) === true ? 'On' : 'Off'}
	                                      </span>
	                                      <Switch.Root
	                                        checked={getSttEngineFieldValue(provider.id, field) === true}
	                                        onCheckedChange={(value) =>
	                                          setSttEngineFieldValue(provider.id, field, value === true)}
	                                      />
	                                    </div>
	                                  {:else if field.type === 'select'}
	                                    <Select.Root
	                                      type="single"
	                                      value={String(getSttEngineFieldValue(provider.id, field))}
	                                      onValueChange={(value) =>
	                                        setSttEngineFieldValue(provider.id, field, Array.isArray(value) ? value[0] : value)}
	                                    >
	                                      <Select.Trigger class="w-full justify-between">
	                                        <span class="truncate">
	                                          {String(getSttEngineFieldValue(provider.id, field)) ||
	                                            getCapabilityFieldDefaultLabel(field)}
	                                        </span>
	                                      </Select.Trigger>
	                                      <Select.Content>
	                                        <Select.Item value="">{getCapabilityFieldDefaultLabel(field)}</Select.Item>
	                                        {#each field.options ?? [] as option (option)}
	                                          <Select.Item value={option}>{option}</Select.Item>
	                                        {/each}
	                                      </Select.Content>
	                                    </Select.Root>
	                                  {:else}
	                                    <Input
	                                      type={field.type === 'number' ? 'number' : 'text'}
	                                      step={field.type === 'number' ? String(field.step ?? 0.01) : undefined}
	                                      min={field.type === 'number' && field.min != null ? String(field.min) : undefined}
	                                      max={field.type === 'number' && field.max != null ? String(field.max) : undefined}
	                                      placeholder={getCapabilityFieldPlaceholder(field)}
	                                      value={String(getSttEngineFieldValue(provider.id, field))}
	                                      oninput={(event) =>
	                                        setSttEngineFieldValue(
	                                          provider.id,
	                                          field,
	                                          (event.currentTarget as HTMLInputElement).value
	                                        )}
	                                    />
	                                  {/if}
	                                {/if}
	                              </div>
	                            </div>
	                          {/each}

	                          {#each getByoEngineAdvancedSections(provider.id, 'stt') as section (section.id)}
	                            {#if section.title && getByoEngineAdvancedSections(provider.id, 'stt').length > 1}
	                              <p class="batshit-settings-child-label">{section.title}</p>
	                            {/if}
	                            {#each section.fields as field (field.id)}
	                              <div class={`batshit-settings-form-row ${field.type === 'textarea' ? 'is-tall' : ''}`}>
	                                <div class="batshit-settings-form-copy">
	                                  <div class="batshit-settings-form-label-line">
	                                    <Label.Label class="batshit-settings-form-label">{field.label}</Label.Label>
	                                    {#if field.help}
	                                      <SettingsInfoMenu ariaLabel={`About ${field.label}`}>
	                                        <p>{field.help}</p>
	                                      </SettingsInfoMenu>
	                                    {/if}
	                                  </div>
	                                </div>
	                                <div class="batshit-settings-form-control">
	                                  {#if field.type === 'boolean'}
	                                    <div class="batshit-settings-muted-panel flex items-center justify-between">
	                                      <span class="batshit-settings-form-label">
	                                        {getByoEngineFieldValue(provider.id, field) === true ? 'On' : 'Off'}
	                                      </span>
	                                      <Switch.Root
	                                        checked={getByoEngineFieldValue(provider.id, field) === true}
	                                        onCheckedChange={(value) =>
	                                          setByoEngineFieldValue(provider.id, field, value === true)}
	                                      />
	                                    </div>
	                                  {:else if field.type === 'select'}
	                                    <Select.Root
	                                      type="single"
	                                      value={String(getByoEngineFieldValue(provider.id, field))}
	                                      onValueChange={(value) =>
	                                        setByoEngineFieldValue(provider.id, field, Array.isArray(value) ? value[0] : value)}
	                                    >
	                                      <Select.Trigger class="w-full justify-between">
	                                        <span class="truncate">
	                                          {String(getByoEngineFieldValue(provider.id, field)) ||
	                                            getByoFieldDefaultLabel(provider.id, field)}
	                                        </span>
	                                      </Select.Trigger>
	                                      <Select.Content>
	                                        <Select.Item value="">{getByoFieldDefaultLabel(provider.id, field)}</Select.Item>
	                                        {#each (field.options ?? []).filter((option) => option.value !== null) as option (`${field.id}-${String(option.value)}`)}
	                                          <Select.Item value={String(option.value)}>{option.label}</Select.Item>
	                                        {/each}
	                                      </Select.Content>
	                                    </Select.Root>
	                                  {:else if field.type === 'textarea'}
	                                    <textarea
	                                      class="batshit-settings-textarea min-h-24"
	                                      placeholder={getByoFieldPlaceholder(provider.id, field)}
	                                      value={String(getByoEngineFieldValue(provider.id, field))}
	                                      oninput={(event) =>
	                                        setByoEngineFieldValue(
	                                          provider.id,
	                                          field,
	                                          (event.currentTarget as HTMLTextAreaElement).value
	                                        )}
	                                    ></textarea>
	                                  {:else}
	                                    <Input
	                                      type={field.type === 'number' ? 'number' : 'text'}
	                                      step={field.type === 'number' && field.step != null ? String(field.step) : undefined}
	                                      min={field.type === 'number' && field.min != null ? String(field.min) : undefined}
	                                      max={field.type === 'number' && field.max != null ? String(field.max) : undefined}
	                                      placeholder={getByoFieldPlaceholder(provider.id, field)}
	                                      value={String(getByoEngineFieldValue(provider.id, field))}
	                                      oninput={(event) =>
	                                        setByoEngineFieldValue(
	                                          provider.id,
	                                          field,
	                                          (event.currentTarget as HTMLInputElement).value
	                                        )}
	                                    />
	                                  {/if}
	                                </div>
	                              </div>
	                            {/each}
	                          {/each}
	                        </div>
	                      </div>
                        {/if}
                      </Collapsible.Content>
                    </div>
                  </Collapsible.Root>
                {/each}
              </div>
            {/if}
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="voice-engine-manager-sections"
            title="Installed Engine Controls"
            batshitIcon="voice-engine-manager"
            contentClass="space-y-4"
            open={openVoiceEngineSectionId === 'installed'}
            ontoggle={(event) => handleVoiceEngineSectionToggle('installed', event)}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Installed Engine Controls" contentClass="w-80">
                <p>
                  Registered BYO engines expose health, model-management, startup, and delete
                  controls here. TTS/STT advanced settings live in their engine accordions above.
                </p>
              </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
              <Button
                size="sm"
                variant="outline"
                onclick={() => {
                  existingEngineFormOpen = !existingEngineFormOpen
                  if (!existingEngineFormOpen) resetExistingEngineForm()
                }}
              >
                <Plus />
                Connect Existing
              </Button>
            {/snippet}
              {#if existingEngineFormOpen}
                <div class="batshit-settings-muted-panel is-loose space-y-4">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-form-label">Connect Existing Engine</p>
                      <SettingsInfoMenu ariaLabel="About connecting existing voice engines" contentClass="w-80">
                        <p>
                          Use this for a TTS/STT server that is already running. Docker users usually
                          point host services at <code>http://host.docker.internal:PORT</code>.
                          Native users can use <code>http://localhost:PORT</code>.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                    <Badge variant="outline" class="batshit-settings-child-label">Saved disabled first</Badge>
                  </div>

                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <Label.Label class="batshit-settings-form-label" for="existing-engine-name">
                          Name
                        </Label.Label>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          id="existing-engine-name"
                          value={existingEngineForm.name}
                          placeholder="Kokoro TTS"
                          oninput={(event) =>
                            handleExistingEngineNameInput((event.currentTarget as HTMLInputElement).value)}
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <Label.Label class="batshit-settings-form-label" for="existing-engine-id">
                          Engine ID
                        </Label.Label>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          id="existing-engine-id"
                          value={existingEngineForm.engineId}
                          placeholder="kokoro-tts"
                          oninput={(event) =>
                            handleExistingEngineIdInput((event.currentTarget as HTMLInputElement).value)}
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <Label.Label class="batshit-settings-form-label" for="existing-engine-base-url">
                          Base URL
                        </Label.Label>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          id="existing-engine-base-url"
                          bind:value={existingEngineForm.baseUrl}
                          placeholder="http://host.docker.internal:8010"
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <Label.Label class="batshit-settings-form-label">Capabilities</Label.Label>
                      </div>
                      <div class="batshit-settings-form-control">
                        <div class="flex flex-wrap gap-2">
                          <div class="flex items-center gap-2 batshit-settings-pill">
                            <span class="batshit-settings-form-label">TTS</span>
                            <Switch.Root
                              checked={existingEngineForm.supportsTts}
                              onCheckedChange={(value) => toggleExistingEngineCapability('tts', value === true)}
                            />
                          </div>
                          <div class="flex items-center gap-2 batshit-settings-pill">
                            <span class="batshit-settings-form-label">STT</span>
                            <Switch.Root
                              checked={existingEngineForm.supportsStt}
                              onCheckedChange={(value) => toggleExistingEngineCapability('stt', value === true)}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <Label.Label class="batshit-settings-form-label">Request Format</Label.Label>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={existingEngineForm.requestFormat}
                          onValueChange={handleExistingEngineFormatChange}
                        >
                          <Select.Trigger class="w-full justify-between">
                            <span class="truncate">
                              {existingEngineForm.requestFormat === 'openai-compatible'
                                ? 'OpenAI-compatible'
                                : 'Batshit BYO'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="openai-compatible">OpenAI-compatible</Select.Item>
                            <Select.Item value="batshit-byo">Batshit BYO</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <Label.Label class="batshit-settings-form-label" for="existing-engine-health-path">
                          Health Path
                        </Label.Label>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          id="existing-engine-health-path"
                          bind:value={existingEngineForm.healthPath}
                          placeholder="/health"
                        />
                      </div>
                    </div>

                    {#if existingEngineForm.supportsTts}
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <Label.Label class="batshit-settings-form-label" for="existing-engine-tts-path">
                            TTS Path
                          </Label.Label>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Input
                            id="existing-engine-tts-path"
                            bind:value={existingEngineForm.ttsPath}
                            placeholder={existingEngineDefaultTtsPath(existingEngineForm.requestFormat)}
                          />
                        </div>
                      </div>
                    {/if}

                    {#if existingEngineForm.supportsStt}
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <Label.Label class="batshit-settings-form-label" for="existing-engine-stt-path">
                            STT Path
                          </Label.Label>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Input
                            id="existing-engine-stt-path"
                            bind:value={existingEngineForm.sttPath}
                            placeholder={existingEngineDefaultSttPath(existingEngineForm.requestFormat)}
                          />
                        </div>
                      </div>
                    {/if}

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <Label.Label class="batshit-settings-form-label" for="existing-engine-model">
                          Model
                        </Label.Label>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          id="existing-engine-model"
                          bind:value={existingEngineForm.modelId}
                          placeholder="Optional"
                        />
                      </div>
                    </div>

                    {#if existingEngineForm.supportsTts}
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <Label.Label class="batshit-settings-form-label" for="existing-engine-voice">
                            Voice
                          </Label.Label>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Input
                            id="existing-engine-voice"
                            bind:value={existingEngineForm.voiceId}
                            placeholder="Optional"
                          />
                        </div>
                      </div>
                    {/if}

                    {#if existingEngineForm.supportsStt}
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <Label.Label class="batshit-settings-form-label" for="existing-engine-language">
                            Language
                          </Label.Label>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Input
                            id="existing-engine-language"
                            bind:value={existingEngineForm.language}
                            placeholder="Optional"
                          />
                        </div>
                      </div>
                    {/if}
                  </div>

                  {#if existingEngineError}
                    <p class="batshit-settings-inline-alert is-warning">{existingEngineError}</p>
                  {/if}

                  <div class="batshit-settings-action-row">
                    <Button
                      size="sm"
                      onclick={handleConnectExistingEngine}
                      disabled={existingEngineSaving}
                    >
                      {#if existingEngineSaving}
                        <Loader2 class="animate-spin" />
                      {:else}
                        <Check />
                      {/if}
                      Save & Check
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onclick={() => {
                        existingEngineFormOpen = false
                        resetExistingEngineForm()
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              {/if}
              {#if byoEngineProviders.length === 0}
                <div class="batshit-settings-muted-panel batshit-settings-caption">
                  No BYO engines registered yet.
                </div>
              {:else}
	                {#each byoEngineProviders as provider (provider.id)}
	                  {@const health = byoEngineHealth[provider.id]}
	                  {@const canDeleteLocalFiles = isBatshitManagedLocalEngine(provider)}
                  <Collapsible.Root open={openEngineAccordionId === provider.id}>
                    <div class="batshit-settings-muted-panel is-loose space-y-3">
                      <button
                        type="button"
                        class="batshit-settings-option-card w-full"
                        aria-expanded={openEngineAccordionId === provider.id}
                        onclick={() => toggleEngineAccordion(provider.id)}
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="flex min-w-0 items-center gap-3">
                            <IconRenderer
                              ref={getByoEngineIconRef(provider)}
                              class="batshit-settings-icon-frame h-9 w-9 shrink-0"
                              iconClass="h-5 w-5"
                              label={provider.name}
                            />
                            <div class="min-w-0">
                              <p class="batshit-settings-form-label truncate">{provider.name}</p>
                              <p class="truncate text-xs text-muted-foreground">ID: {provider.id}</p>
                            </div>
                          </div>
                          <div class="flex items-center gap-2">
                            {#if provider.supportsTts !== false}
                              <Badge variant="outline" class="batshit-settings-child-label">TTS</Badge>
                            {/if}
                            {#if provider.supportsStt !== false}
                              <Badge variant="outline" class="batshit-settings-child-label">STT</Badge>
                            {/if}
                            {#if provider.supportsClone === true}
                              <Badge variant="outline" class="batshit-settings-child-label">Cloning</Badge>
                            {/if}
                            {#if provider.voiceSurface?.requiresDiscussion}
                              <Badge variant="outline" class="batshit-settings-pill is-warning">
                                Discuss voices
                              </Badge>
                            {/if}
                            {#if provider.enabled === false}
                              <Badge variant="outline" class="batshit-settings-pill is-warning">Disabled</Badge>
                            {:else if health?.loading}
                              <Badge variant="outline" class="batshit-settings-child-label">
                                <Loader2 class="mr-1 h-3 w-3 animate-spin" />
                                Checking
                              </Badge>
                            {:else if health?.ready === true}
                              <Badge class="batshit-settings-pill is-success">Ready</Badge>
                            {:else if health?.ready === false}
                              <Badge variant="outline" class="batshit-settings-pill is-warning">Needs attention</Badge>
                            {/if}
                            <ChevronDown
                              class={`h-4 w-4 transition-transform ${openEngineAccordionId === provider.id ? 'rotate-180' : ''}`}
                            />
                          </div>
                        </div>
                      </button>
                      <Collapsible.Content class="space-y-4 pt-2">
                        <div class="flex flex-wrap items-center justify-between gap-3 batshit-settings-muted-panel">
                          <div class="flex items-center gap-1.5">
                            <p class="batshit-settings-form-label">Engine Controls</p>
                            <SettingsInfoMenu ariaLabel={`About ${provider.name} engine controls`} contentClass="w-80">
                              <p>
                                Engine wiring stays agent-managed. Use these controls for
                                enablement, health checks, startup behavior, model downloads, and
                                deletion.
                              </p>
                            </SettingsInfoMenu>
                          </div>
                          <div class="flex flex-wrap items-center gap-2">
                            <IconPicker
                              value={getByoEngineIconRef(provider)}
                              triggerLabel="Choose Icon"
                              onSelect={(iconRef) => setByoEngineIconRef(provider.id, iconRef)}
                            />
                            <Button
                              size="sm"
                              variant="outline"

                              onclick={() => checkByoEngineHealth(provider.id)}
                              disabled={health?.loading}
                            >
                              {#if health?.loading}
                                <Loader2 class="animate-spin" />
                              {:else}
                                <RefreshCcw  />
                              {/if}
                              Health Check
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              class="is-danger"
                              onclick={() => handleDeleteByoEngine(provider)}
                            >
                              <Trash2  />
                              Delete
                            </Button>
                            {#if canDeleteLocalFiles}
                              <label class="flex items-center gap-2 batshit-settings-pill">
                                <input
                                  type="checkbox"
                                  class="h-4 w-4"
                                  checked={getDeleteLocalFilesForEngine(provider.id)}
                                  onchange={(event) =>
                                    setDeleteLocalFilesForEngine(
                                      provider.id,
                                      (event.currentTarget as HTMLInputElement).checked
                                    )}
                                />
                                <span class="batshit-settings-form-label">Delete local files too</span>
                                <SettingsInfoMenu ariaLabel="About deleting local engine files" contentClass="w-80">
                                  <p>
                                    When this is checked, deleting the engine also removes the
                                    Batshit-managed install folder plus this engine's runtime logs
                                    and launch state. It is only available for engines Batshit
                                    installed under its managed installs folder.
                                  </p>
                                </SettingsInfoMenu>
                              </label>
                            {/if}
                            <div class="flex items-center gap-2 batshit-settings-pill">
                              <span class="batshit-settings-form-label">Enabled</span>
                              <Switch.Root
                                checked={provider.enabled !== false}
                                onCheckedChange={(value) =>
                                  updateByoProvider(provider.id, (current) => ({
                                    ...current,
                                    enabled: value === true
                                  }))}
                              />
                            </div>
                            <div class="flex items-center gap-2 batshit-settings-pill">
                              <span class="batshit-settings-form-label">Start with Batshit</span>
                              <SettingsInfoMenu ariaLabel="About Start with Batshit" contentClass="w-80">
                                <p>
                                  When this is on, Batshit tries to launch the engine during app
                                  startup. Core stack services still belong to the active Batshit
                                  launcher or packaged runtime; per-engine runtime launch lives
                                  here.
                                </p>
                              </SettingsInfoMenu>
                              <Switch.Root
                                checked={provider.localRuntime?.startup?.autoStartOnLaunch === true}
                                onCheckedChange={(value) =>
                                  updateByoProvider(provider.id, (current) => ({
                                    ...current,
                                    localRuntime: {
                                      ...(current.localRuntime ?? {}),
                                      startup: {
                                        ...(current.localRuntime?.startup ?? {}),
                                        autoStartOnLaunch: value === true
                                      }
                                    }
                                  }))}
                              />
                            </div>
                          </div>
                        </div>

                        {#if health?.statusHint}
                          <p class="batshit-settings-form-label">{health.statusHint}</p>
                        {/if}

                        {#if provider.voiceSurface?.summary}
                          <div
                            class={`batshit-settings-inline-alert ${
                              provider.voiceSurface.requiresDiscussion
                                ? 'is-warning'
                                : 'is-info'
                            }`}
                          >
                            {#if provider.voiceSurface.requiresDiscussion}
                              <p class="batshit-settings-form-label mb-1 flex items-center gap-1">
                                <AlertCircle class="h-3.5 w-3.5" />
                                Voice Coverage Note
                              </p>
                            {/if}
                            <p>{provider.voiceSurface.summary}</p>
                          </div>
                        {/if}

                        {#if provider.sttModelCatalog?.models?.length}
                          <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
                            <div class="flex items-center gap-1.5">
                              <p class="batshit-settings-form-label">STT Models</p>
                              <SettingsInfoMenu ariaLabel={`About ${provider.name} STT models`} contentClass="w-80">
                                <p>
                                  Download larger local speech-to-text models only when you need
                                  them. Batshit keeps the current model active until a new model is
                                  fully downloaded and selected.
                                </p>
                              </SettingsInfoMenu>
                            </div>
                            <div class="space-y-2">
                              {#each provider.sttModelCatalog.models as model (model.id)}
                                {@const isActiveModel = isByoSttModelActive(provider, model)}
                                {@const isInstalledModel = isByoSttModelInstalled(provider, model)}
                                {@const modelJob = getEngineModelJob(provider.id, model.id)}
                                {@const sizeLabel = formatModelSize(model.sizeBytes)}
                                <div class="batshit-settings-option-card flex flex-wrap items-center justify-between gap-3">
                                  <div class="min-w-0 flex-1">
                                    <div class="flex flex-wrap items-center gap-2">
                                      <p class="batshit-settings-form-label truncate">
                                        {model.label ?? model.id}
                                      </p>
                                      {#if isActiveModel}
                                        <Badge class="batshit-settings-pill is-success">
                                          <Check class="mr-1 h-3 w-3" />
                                          In use
                                        </Badge>
                                      {:else if isInstalledModel}
                                        <Badge variant="outline" class="batshit-settings-child-label">Installed</Badge>
                                      {:else}
                                        <Badge variant="outline" class="batshit-settings-child-label">Downloadable</Badge>
                                      {/if}
                                      {#if model.recommended}
                                        <Badge variant="outline" class="batshit-settings-child-label">Recommended</Badge>
                                      {/if}
                                    </div>
                                    {#if model.description}
                                      <p class="mt-1 text-xs text-muted-foreground">{model.description}</p>
                                    {/if}
                                    <p class="mt-1 text-xs text-muted-foreground">
                                      {[model.language, sizeLabel, model.filename ?? model.requestModel]
                                        .filter(Boolean)
                                        .join(' / ')}
                                    </p>
                                    {#if model.failedReason}
                                      <p class="mt-1 text-xs text-destructive">{model.failedReason}</p>
                                    {/if}
                                  </div>
                                  <div class="flex flex-wrap items-center gap-2">
                                    {#if !isInstalledModel}
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onclick={() => handleByoEngineModelAction(provider, model, 'download')}
                                        disabled={Boolean(modelJob)}
                                      >
                                        {#if modelJob === 'download'}
                                          <Loader2 class="animate-spin" />
                                        {:else}
                                          <Download />
                                        {/if}
                                        Download
                                      </Button>
                                    {:else if !isActiveModel}
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onclick={() => handleByoEngineModelAction(provider, model, 'use')}
                                        disabled={Boolean(modelJob)}
                                      >
                                        {#if modelJob === 'use'}
                                          <Loader2 class="animate-spin" />
                                        {:else}
                                          <Check />
                                        {/if}
                                        Use
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        class="is-danger"
                                        onclick={() => handleByoEngineModelAction(provider, model, 'delete')}
                                        disabled={Boolean(modelJob)}
                                      >
                                        {#if modelJob === 'delete'}
                                          <Loader2 class="animate-spin" />
                                        {:else}
                                          <Trash2 />
                                        {/if}
                                        Delete
                                      </Button>
                                    {/if}
                                  </div>
                                </div>
                              {/each}
                            </div>
                            {#if provider.sttModelCatalog.requiresRestartOnModelChange}
                              <p class="batshit-settings-caption">
                                Switching models updates the launch defaults. If this local engine
                                is already running, restart it before expecting the new model to
                                handle transcription.
                              </p>
                            {/if}
                          </div>
                        {/if}

	                      </Collapsible.Content>
                    </div>
                  </Collapsible.Root>
                {/each}
              {/if}
          </SettingsAccordionCard>
        </div>
      {/if}
</div>

<SettingsTextEditor
  bind:open={ttsEnginePromptEditorOpen}
  title={ttsEnginePromptEditorProvider
    ? `${ttsEnginePromptEditorProvider.label} TTS Engine Prompt`
    : 'TTS Engine Prompt'}
  description="Provider-specific prompt guidance for the AI before Batshit sends text to this TTS engine."
  value={ttsEnginePromptEditorProvider
    ? getTtsEnginePrompt(ttsEnginePromptEditorProvider.id)
    : ''}
  placeholder="Example: Use [laughs] only when it naturally fits. Avoid XML tags. Keep stage directions short."
  maxLength={MAX_TTS_ENGINE_PROMPT_CHARS}
  width="large"
  saveLabel="Save Prompt"
  onSave={saveTtsEnginePromptFromEditor}
/>

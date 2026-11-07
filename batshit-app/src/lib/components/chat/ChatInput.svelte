<script lang="ts">
  import { readVoiceProviderEnvelope } from '$lib/utils/voiceProviderEnvelope'
  import { Button } from '$lib/components/ui/button'
  import {
    Mic,
    AudioLines,
    Send,
    Square,
    Pause,
    PhoneOff,
    CircleDot,
    FileText,
    ChevronDown,
    MessageCircle,
    Shield,
    ShieldPlus,
    Loader2
  } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import ZipsManagerDropdown from '$lib/components/zips/ZipsManagerDropdown.svelte'
  import ClipsManagerDropdown from '$lib/components/clips/ClipsManagerDropdown.svelte'
  import ChatClipHanger from '$lib/components/chat/ChatClipHanger.svelte'
  import ChatDragOverlay from '$lib/components/chat/ChatDragOverlay.svelte'
  import ChatMentionAutocomplete from '$lib/components/chat/ChatMentionAutocomplete.svelte'
  import ChatSlashAutocomplete from '$lib/components/chat/ChatSlashAutocomplete.svelte'
  import MCPsDropdown from '$lib/components/mcps/MCPsDropdown.svelte'
  import AgentSelector from '$lib/components/agents/AgentSelector.svelte'
  import ModelSelector from '$lib/components/models/ModelSelector.svelte'
  import ModelReasoningControl from '$lib/components/models/ModelReasoningControl.svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { voiceService, type VoiceInputConfig } from '$lib/services/voice'
  import {
    connectLiveKitVoiceRoom,
    publishMicrophoneToLiveKitRoom,
    type LiveKitPublishedMicrophoneTrackHandle,
    type LiveKitTranscriptionDetail,
    type LiveKitVoiceRoomHandle
  } from '$lib/services/liveKitVoiceClient'
  import { getUserSettings } from '$lib/stores/userSettings.svelte'
  import {
    QUICK_ACTION_EVENT,
    quickActionToastText,
    quickActionMarkOf,
    quickActionSettingsTabTarget,
    readQuickActionVerdict,
    resolveJevQuickActionsEnabled,
    resolveQuickActionWakeGate,
    type QuickActionMark,
    type QuickActionVerdict
  } from '$lib/utils/jevJuiceQuickActions'
  import { executeVoiceQuickAction } from '$lib/appActions/voice/quickActionExecutor'
  import { getPlaybackState } from '$lib/stores/voicePlayback.svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { applyAgentProviderSettingsUpdate, chatBarWorkModeSave } from '$lib/utils/agentProviderSettings'
  import { refreshedFileReadsRecordInputs } from '$lib/utils/refreshedFileReadsSettings'
  import { refreshAllDeadCopies } from '$lib/stores/zipDeadCopies.svelte'
  import * as sessionStore from '$lib/stores/session.svelte'
  import * as projectStore from '$lib/stores/projects.svelte'
  import * as savedModelsStore from '$lib/stores/savedModels.svelte'
  import { foldersStore } from '$lib/stores/folders.svelte'
  import {
    buildMentionSegments,
    filterMentionOptions,
    getActiveMention,
    mapMentionsToFileReferences,
    validateMentions,
    type MentionMatch
  } from '$lib/utils/fileMentions'
  import {
    formatSkillInlineDisplayName,
    stripSkillInlineMetadata
  } from '$lib/utils/skillInlineNotes'
  import {
    isRetiredPrimaryAgentType,
    normalizePrimaryAgentType,
    primaryAgentAllowsNativeBash
  } from '$lib/utils/primaryAgentType'
  import { cleanSpeechTranscript } from '$lib/utils/speechTranscript'
  import {
    createVoiceQuickActionCommitCoordinator,
    createVoiceNoReplyCompletion,
    createVoiceQueuedReplyWait,
    runVoiceQuickActionCommit,
    voiceQuickActionSnapshotMatches,
    type VoiceQuickActionCommitToken
  } from '$lib/utils/voiceQuickActionCommit'
  import {
    resolveModelVoiceSessionConfig,
    findChatVoicePresetFallback,
    shouldRouteLiveKitRemoteAudioToGoon
  } from '$lib/utils/modelVoiceSession'
  import {
    DEFAULT_VOICE_MODE_INPUT_MODE,
    normalizeAgentVoiceProfile,
    normalizeVoiceModeTurnSettings,
    normalizeVoiceSettings
  } from '$lib/utils/voiceSchema'
  import { VOICE_ENGINES_UPDATED_EVENT } from '$lib/utils/voiceEngineEvents'
  import { onMount, tick, untrack } from 'svelte'
  import type { SlashCommandRow } from '$lib/types/database'
  import type { SlashCommandDescriptor } from '$lib/types/slashCommands'
  import type { SavedModel } from '$lib/types/savedModels'
  import type { VoiceModeInputMode, VoiceProviderSummary } from '$lib/types/voice'
  import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
  import { isSlashCommandEnabledForAgent } from '$lib/utils/slashCommandAccess'
  import { neutralizeAllClipReferenceSyntax } from '$lib/utils/zipReferenceSafety'
  import { ProjectService } from '$lib/services/projects'
  import { SessionService } from '$lib/services/sessions'
  import {
    desktopControlsVoiceCoordinator,
    type DesktopControlsVoiceOwner,
    type DesktopControlsVoiceOwnerState
  } from '$lib/services/desktopControlsVoice'
  import type { DesktopGoonPresentationMode } from '$lib/goons/desktopGoonPresentation'
  import { detectDesktopShortcutPlatform } from '$lib/goons/desktopShortcut'
  import {
    busySendModeLabel,
    resolveBusySendActions,
    type BusySendMode
  } from '$lib/utils/steerControl'
  import * as Tooltip from '$lib/components/ui/tooltip'
  
  type BatshitSlashExpandResult = {
    text: string
    blocked: boolean
    expandedPrompts: SlashCommandRow[]
  }
  type ComposerHighlightSegment =
    | { type: 'text'; value: string }
    | { type: 'mention'; value: string; mention: MentionMatch }
    | { type: 'skill'; value: string; label: string }

  type ComposerClip = {
    id: string
    filename: string
    mimeType?: string
    fileType?: string
    thumbnailUrl?: string
    displayUrl?: string
    externalUrl?: string
    localUrl?: string
    unclipAfter?: number | null
    messagesUntilUnclip?: number | null
  }

  let {
    onSend = (message: string, metadata?: any, completion?: { onNoReplyCompleted?: () => void; onReplyAdmitted?: (kind: 'direct' | 'steer' | 'queued') => void; onSteerPrepared?: (identity: { steerId: string; sessionId: string; targetMessageId?: string }) => void; onComposerSessionCreated?: (identity: { sessionId: string; agentId: string }) => boolean }) => {},
    disabled = false,
    voiceMode = $bindable(false),
    onVoiceModeChange = (enabled: boolean) => {},
    sessionId = null,
    data = null,
    goonsPanelOpen = false,
    goonPresentationMode = null,
    showExecutionViewer = $bindable(false),
    onOpenExecutionViewer = (sessionId?: string | null) => {},
    workBusy = false,
    onStopWork = async () => {},
    onClippedItemsChange = (_clips: ComposerClip[]) => {},
    busySendMode = 'steer' as BusySendMode,
    steerable = true,
    steerReason = null,
    onQuickActionMessage = async (_content: string, _mark: QuickActionMark) => { throw new Error('No voice-action message save owner is available.') }
  } = $props<{
    onSend?: (message: string, metadata?: any, completion?: { onNoReplyCompleted?: () => void; onReplyAdmitted?: (kind: 'direct' | 'steer' | 'queued') => void; onSteerPrepared?: (identity: { steerId: string; sessionId: string; targetMessageId?: string }) => void; onComposerSessionCreated?: (identity: { sessionId: string; agentId: string }) => boolean }) => boolean | void | Promise<boolean | void>
    disabled?: boolean
    voiceMode?: boolean
    onVoiceModeChange?: (enabled: boolean) => void
    sessionId?: string | null
    data?: any
    goonsPanelOpen?: boolean
    goonPresentationMode?: DesktopGoonPresentationMode | null
    showExecutionViewer?: boolean
    onOpenExecutionViewer?: (sessionId?: string | null) => void
    workBusy?: boolean
    onStopWork?: () => void | Promise<void>
    onClippedItemsChange?: (clips: ComposerClip[]) => void
    /** SA-114 P3 (DL-114-01): the per-user default, already resolved by the page. */
    busySendMode?: BusySendMode
    /** SA-114 P3 (DL-114-09): the server's verdict for the reply running right now. */
    steerable?: boolean
    steerReason?: string | null
    /**
     * SA-120 P9: a spoken turn that was ONLY a quick action is stored by the page as a user
     * message with the mark, and no agent turn runs. The page owns message persistence.
     */
    onQuickActionMessage?: (content: string, mark: QuickActionMark) => Promise<void> | void
  }>()
  
  let message = $state('')
  let composerDraftRevision = 0
  function setComposerMessage(text: string) {
    composerDraftRevision += 1
    message = text
  }
  let textarea = $state<HTMLTextAreaElement | null>(null)
  let highlightLayer = $state<HTMLDivElement | null>(null)
  let autoResizeQueued = false
  const COMPOSER_MAX_VIEWPORT_RATIO = 0.5
  let isListening = $state(false)
  let isVoiceMode = $state(false)
  let voiceModeInputKind = $state<'continuous' | 'recorded' | 'text' | null>(null)
  let liveKitVoiceStatus = $state<'disconnected' | 'connecting' | 'connected' | 'error'>(
    'disconnected'
  )
  let liveKitVoiceError = $state<string | null>(null)
  let liveKitVoiceRoomName = $state<string | null>(null)
  let liveKitVoiceRoomHandle: LiveKitVoiceRoomHandle | null = null
  let liveKitMicrophoneHandle: LiveKitPublishedMicrophoneTrackHandle | null = null
  let liveKitVoiceAbortController: AbortController | null = null
  let liveKitVoiceConnectSerial = 0
  let liveKitRemoteGoonAudioElements = new Set<HTMLMediaElement>()
  let desktopControlsVoiceOwner: DesktopControlsVoiceOwner | null = null
  let waitingForAI = $state(false)
  let stoppingWork = $state(false)
  let finalizingDictation = $state(false)
  const sendDisabled = $derived(disabled || !message.trim() || finalizingDictation)

  /**
   * SA-119 P2 (DL-119-02, DL-119-03) — the composer while the agent is replying.
   *
   * SA-118's F-25 put a third send state behind a hover tooltip, and Josh's finding
   * (2026-09-13) was that people press Enter and nobody hovers — and that the tooltip was
   * the browser's own plain one, not the app's. So the choice is two visible badges beside
   * Stop, and ONE rule answers for both of them and for both keys:
   * `resolveBusySendActions`. Nothing here decides anything itself.
   */
  const shortcutModifierLabel = detectDesktopShortcutPlatform() === 'darwin' ? 'Cmd' : 'Ctrl'
  /**
   * SA-118 (DL-118-09), split in two for DL-119-02.
   *
   * The rule needs clips and `@file` mentions APART, because they are not the same case: a
   * clip can stay in the composer while the words steer (DL-119-04), and a mention cannot —
   * the path is inline in the text being sent, and it travels as `metadata.fileReferences`,
   * which the steer route cannot carry (PR #106 review F-23).
   *
   * `validateMentions` is called with `activeMentionExclusions`, which is what
   * `sendMessageWithText` passes — not the narrower list the highlighter uses — so the
   * badges and the send cannot disagree about whether a mention counts.
   */
  const composerHasClips = $derived.by(() => composerClippedItems.length > 0)
  const composerHasMentions = $derived.by(
    () =>
      mapMentionsToFileReferences(validateMentions(message, flatFiles, activeMentionExclusions))
        .length > 0
  )
  /** F-25's claim, kept: the button and the send read the SAME two facts. */
  const composerCarriesAttachments = $derived(composerHasClips || composerHasMentions)
  const busySendActions = $derived(
    resolveBusySendActions({
      mode: busySendMode,
      steerable,
      steerReason,
      hasClips: composerHasClips,
      hasMentions: composerHasMentions
    })
  )
  const composerBusy = $derived(workBusy || waitingForAI)
  /** DL-119-03: the send icon does what Enter does, and says so. */
  const sendButtonLabel = $derived(
    finalizingDictation
      ? 'Finalizing dictation'
      : composerBusy
        ? busySendModeLabel(busySendActions.enter)
        : 'Send message'
  )
  /**
   * DL-119-02/03 — one sentence per mode, plus the other key only when it does something.
   *
   * With Steer unavailable both keys queue (`enter === other`), so the shortcut line is
   * dropped rather than advertising a key that changes nothing — measured on a group chat,
   * where the old tooltip offered "Cmd+Enter sends as steer" beside its own sentence
   * explaining that groups cannot be steered.
   */
  const busySendShortcutHint = $derived(
    busySendActions.other === busySendActions.enter
      ? ''
      : ` ${shortcutModifierLabel}+Enter ${busySendModeLabel(busySendActions.other).toLowerCase()}s instead.`
  )
  const sendButtonTooltip = $derived.by(() => {
    if (finalizingDictation) return 'Finalizing dictation...'
    if (!composerBusy) return 'Send message'
    if (busySendActions.enter === 'steer') {
      return `Steer: your message waits for the agent's next tool call, then lands inside this reply.${busySendShortcutHint}`
    }
    const why = busySendActions.steer.note ? ` ${busySendActions.steer.note}` : ''
    return `Queue: your message is held and sent the moment this reply ends.${why}${busySendShortcutHint}`
  })
  /** The Steer badge's own sentence. It is never the only place a disabled reason is shown. */
  const steerBadgeTooltip = $derived(
    busySendActions.steer.enabled
      ? `Steer: your message waits for the agent's next tool call, then lands inside this reply.${busySendActions.steer.note ? ` ${busySendActions.steer.note}` : ''}`
      : (busySendActions.steer.note ?? 'This reply can’t take a steer.')
  )
  const queueBadgeTooltip = 'Queue: your message is held and sent the moment this reply ends.'
  let interimTranscript = $state('')
  let dictationPromise: Promise<void> | null = null
  let dictationBaseMessage = ''
  let dictationPreviewTranscript = $state('')
  let dictationActivityPreviewPending = $state(false)
  let dictationLiveTranscriptVisible = $state(false)
  let composerHasSttTranscript = $state(false)
  let voiceModeSendTimer: ReturnType<typeof setTimeout> | null = null
  let voiceModeTurnSendPending = $state(false)
  let recordedVoiceModeAutoStartInFlight = $state(false)
  let recordedVoiceModeCaptureFinalizing = $state(false)
  let recordedVoiceModeSpeechSeen = false
  let recordedVoiceModeAutoStopTimer: ReturnType<typeof setTimeout> | null = null
  let voiceModeActivityPreviewActive = $state(false)
  let voiceModeActivityPreviewTimer: ReturnType<typeof setTimeout> | null = null
  let voiceModeCommittedTranscript = ''
  const voiceQuickActionCommits = createVoiceQuickActionCommitCoordinator()
  let voiceProviderSummaryCache: { loadedAt: number; providers: VoiceProviderSummary[] } | null = null
  const voiceModeActivityBars = Array.from({ length: 28 }, (_, index) => index)
  // Files now handled through ClipsManager component
  // let selectedFiles = $state<File[]>([])
  // let fileInput = $state<HTMLInputElement | null>(null)
  let isDragging = $state(false)
  let dragMode = $state<'upload' | 'mention'>('upload')
  let dragMentionPath = $state<string | null>(null)
  const projectService = new ProjectService()
  const sessionService = new SessionService()
  const playbackState = $derived(getPlaybackState())
  const isSpeaking = $derived(playbackState.isPlaying)
  const hasQueuedSpeech = $derived(
    Object.values(playbackState.queueByAgent).some((count) => count > 0)
  )
  const voiceReplyActive = $derived(isSpeaking || hasQueuedSpeech)
  const isLiveKitVoiceConnecting = $derived(liveKitVoiceStatus === 'connecting')
  const isLiveKitVoiceConnected = $derived(liveKitVoiceStatus === 'connected')
  let creatingSlashSession = $state(false)

  type NativeBashAccessMode = 'plan' | 'agent' | 'dangerous'

  const NATIVE_BASH_MODE_OPTIONS: Array<{
    value: NativeBashAccessMode
    triggerLabel: string
    menuLabel: string
    description: string
    icon: typeof MessageCircle
  }> = [
    {
      value: 'plan',
      triggerLabel: 'Plan',
      menuLabel: 'Plan',
      description: 'Plan only (read/search + markdown notes)',
      icon: MessageCircle
    },
    {
      value: 'agent',
      triggerLabel: 'Agent',
      menuLabel: 'Agent',
      description: 'Edit project files (sandbox default)',
      icon: Shield
    },
    {
      value: 'dangerous',
      triggerLabel: 'Crazy',
      menuLabel: 'Batshit Crazy (Dangerous)',
      description: 'Full local machine access (least safe)',
      icon: ShieldPlus
    }
  ]

  // Reference to ClipsManagerDropdown
  let clipsManager: any
  let composerClippedItems = $state<ComposerClip[]>([])

  const savedModels = $derived(savedModelsStore.getSavedModels())
  const currentAgent = $derived(agentStore.getCurrentAgent())
  // Only the normalized voice inputs belong to this lifetime. A send's equal
  // same-agent GET refresh must not retire its accepted composer draft.
  const voiceQuickActionLifetimeKey = $derived.by(() => JSON.stringify([
    currentAgent?.created_at ?? null,
    normalizeAgentVoiceProfile(currentAgent?.voice_profile), activeModelVoiceSession ?? null
  ]))
  const voiceQuickActionCommitContextKey = $derived(JSON.stringify([
    sessionId ?? null, currentAgent?.id ?? null, voiceQuickActionLifetimeKey
  ]))
  const directVoiceCaptureContextKey = $derived(JSON.stringify([
    sessionId ?? null, currentAgent?.id ?? null, currentAgent?.created_at ?? null
  ]))
  let directVoiceCapture: { contextKey: string } | null = null

  function currentVoiceQuickActionContext() {
    return { sessionId: sessionId ?? null, agentId: currentAgent?.id ?? null, voiceLifetimeKey: voiceQuickActionLifetimeKey }
  }

  let voiceQueuedReplyWait: ReturnType<typeof createVoiceQueuedReplyWait> | null = null

  function invalidatePendingVoiceQuickActionCommit(context?: ReturnType<typeof currentVoiceQuickActionContext>) {
    if (!context) directVoiceCapture = null
    const invalidated = context
      ? voiceQuickActionCommits.invalidateContext(context)
      : voiceQuickActionCommits.invalidate()
    if (invalidated) waitingForAI = false
  }

  $effect(() => {
    voiceQuickActionCommitContextKey
    const ownedContext = untrack(currentVoiceQuickActionContext)
    return () => invalidatePendingVoiceQuickActionCommit(ownedContext)
  })
  // A started capture keeps its transport across semantic Voice setting changes.
  // Only its actual actor/chat incarnation, End or a newer capture retires callbacks.
  $effect(() => {
    const contextKey = directVoiceCaptureContextKey
    return () => {
      if (directVoiceCapture?.contextKey === contextKey) directVoiceCapture = null
    }
  })
  const activeAgentVoiceSessionRuntime = $derived(
    normalizeAgentVoiceProfile(currentAgent?.voice_profile)?.voiceSessionRuntime
  )
  const activeAgentVoiceModeInputMode = $derived(
    normalizeAgentVoiceProfile(currentAgent?.voice_profile)?.voiceModeInputMode
  )
  const voiceSessionRuntime = $derived(
    activeAgentVoiceSessionRuntime ??
      normalizeVoiceSettings(getUserSettings()?.voice_settings).voiceSessionRuntime ??
      'direct'
  )
  const voiceModeInputMode = $derived(
    (activeAgentVoiceModeInputMode ??
      normalizeVoiceSettings(getUserSettings()?.voice_settings).voiceMode?.inputMode ??
      DEFAULT_VOICE_MODE_INPUT_MODE) as VoiceModeInputMode
  )
  const currentSession = $derived(sessionStore.getCurrentSession())
  const projects = $derived(projectStore.getProjects())
  // BL-2372: the current project is the agent's, chosen by `watchAgentProjectSelection`
  // (ProjectsSidebar) whether or not the sidebar is open; a newer saved default replaces a
  // sidebar pick. BL-2373: it may be the Default Project, whose folder is the Default Project Path.
  const currentProject = $derived(projectStore.getCurrentProject())
  // The Default Project Path, held by the project store so the sidebar and chat read one value.
  const defaultWorkspacePath = $derived(projectStore.getDefaultProjectPath())
  const flatFiles = $derived(projectStore.getFlatFileList())
  const mentionIndexStatus = $derived(projectStore.getMentionIndexStatus())
  const mentionIndexError = $derived(projectStore.getMentionIndexError())

  function getCurrentAgentSttConfig(lane: 'transcribe' | 'realtime'): VoiceInputConfig | undefined {
    const profile = normalizeAgentVoiceProfile(currentAgent?.voice_profile)
    const stt = lane === 'realtime' ? profile?.realtimeStt : profile?.stt
    if (!stt) return undefined

    const config: VoiceInputConfig = {}
    if (stt.providerId) config.provider = stt.providerId
    if (stt.modelId) config.model = stt.modelId
    if (stt.language) config.language = stt.language

    return Object.keys(config).length > 0 ? config : undefined
  }

  function getEffectiveTranscribeSttProvider(input?: VoiceInputConfig): VoiceInputConfig['provider'] {
    const settings = normalizeVoiceSettings(getUserSettings()?.voice_settings)
    return input?.provider ?? settings.stt?.providerId ?? 'browser'
  }

  function getEffectiveVoiceModeSttProvider(input?: VoiceInputConfig): VoiceInputConfig['provider'] {
    const settings = normalizeVoiceSettings(getUserSettings()?.voice_settings)
    return input?.provider ?? settings.realtimeStt?.providerId ?? 'browser'
  }

  async function usesContinuousVoiceModeStt(provider?: VoiceInputConfig['provider']): Promise<boolean> {
    if (provider === 'browser' || provider === 'deepgram') return true
    if (!provider?.startsWith('byo:') && !provider?.startsWith('local:')) return false

    const summary = await getVoiceProviderSummary(provider)
    const capabilities = summary?.sttCapabilities
    return Boolean(capabilities?.realtime && capabilities.runtimeSupport === 'supported')
  }

  async function getVoiceProviderSummary(provider: VoiceInputConfig['provider']): Promise<VoiceProviderSummary | null> {
    if (!provider) return null
    const now = Date.now()
    if (!voiceProviderSummaryCache || now - voiceProviderSummaryCache.loadedAt > 10_000) {
      const response = await fetch('/api/voice/providers')
      if (!response.ok) {
        throw new Error('Failed to load voice providers')
      }
      const data = await response.json()
      voiceProviderSummaryCache = {
        loadedAt: now,
        providers: readVoiceProviderEnvelope(data)
      }
    }
    return voiceProviderSummaryCache.providers.find((entry) => entry.id === provider) ?? null
  }

  function getVoiceModeTurnSettings() {
    const settings = normalizeVoiceSettings(getUserSettings()?.voice_settings)
    const profile = normalizeAgentVoiceProfile(currentAgent?.voice_profile)
    return normalizeVoiceModeTurnSettings({
      ...settings.voiceMode,
      ...profile?.voiceMode,
      inputMode:
        profile?.voiceModeInputMode ?? settings.voiceMode?.inputMode ?? DEFAULT_VOICE_MODE_INPUT_MODE
    })
  }

  function getLiveKitParticipantName(): string {
    const rawName =
      typeof data?.user?.name === 'string'
        ? data.user.name
        : typeof data?.user?.email === 'string'
          ? data.user.email
          : ''
    const trimmed = rawName.trim()
    return trimmed || 'Batshit User'
  }

  function buildLiveKitSpeechToSpeechConfig() {
    const voiceSession = activeModelVoiceSession
    if (voiceSession?.runtime !== 'livekit' || voiceSession.mode !== 'speech-to-speech') {
      return null
    }

    const modelId = agentDefaultModelPreset?.modelId?.trim() || voiceSession.defaultModelId || null
    const voiceId = voiceSession.defaultVoiceId || null

    return {
      enabled: true,
      providerId: voiceSession.providerId,
      providerLabel: voiceSession.providerLabel ?? null,
      adapterId: voiceSession.adapterId ?? null,
      modelId,
      voiceId
    }
  }

  function buildLiveKitBridgeSttConfig() {
    const settings = normalizeVoiceSettings(getUserSettings()?.voice_settings)
    const agentStt = getCurrentAgentSttConfig('realtime')
    const globalStt = settings.realtimeStt
    const providerId = agentStt?.provider ?? globalStt?.providerId ?? null
    const modelId = agentStt?.model ?? globalStt?.modelId ?? null
    const language = agentStt?.language ?? globalStt?.language ?? null
    const voiceMode = getVoiceModeTurnSettings()

    if (!providerId && !modelId && !language) return null

    return {
      providerId,
      modelId,
      language,
      voiceMode
    }
  }

  function buildLiveKitVoiceRoomRequest() {
    const speechToSpeech = buildLiveKitSpeechToSpeechConfig()
    const bridgeStt = speechToSpeech ? null : buildLiveKitBridgeSttConfig()
    const mode = speechToSpeech ? 'speech-to-speech' : 'batshit-bridge'

    return {
      sessionId: resolveSessionId(sessionStore.getCurrentSessionId()) ?? resolveSessionId(sessionId),
      agentId: currentAgent?.id ?? null,
      participantName: getLiveKitParticipantName(),
      metadata: {
        surface: 'chat-input',
        ui: 'main-chatbar',
        mode,
        goonsEnabled: goonsPanelOpen,
        goonPresentationMode,
        ...(speechToSpeech
          ? {
              providerId: speechToSpeech.providerId,
              modelId: speechToSpeech.modelId,
              voiceId: speechToSpeech.voiceId
            }
          : bridgeStt
            ? {
                bridgeSttProviderId: bridgeStt.providerId,
                bridgeSttModelId: bridgeStt.modelId,
                bridgeSttLanguage: bridgeStt.language,
                bridgeSttSubmitMode: bridgeStt.voiceMode?.submitMode,
                bridgeSttAutoSubmitDelayMs: bridgeStt.voiceMode?.autoSubmitDelayMs,
                bridgeSttEndOfTurnThreshold: bridgeStt.voiceMode?.endOfTurnThreshold
              }
          : {})
      },
      speechToSpeech,
      agentDispatch: {
        enabled: true,
        required: true,
        metadata: {
          surface: 'chat-input',
          ui: 'main-chatbar',
          mode,
          goonsEnabled: goonsPanelOpen,
          goonPresentationMode,
          ...(speechToSpeech
            ? {
                providerId: speechToSpeech.providerId,
                modelId: speechToSpeech.modelId,
                voiceId: speechToSpeech.voiceId
              }
            : bridgeStt
              ? {
                  bridgeSttProviderId: bridgeStt.providerId,
                  bridgeSttModelId: bridgeStt.modelId,
                  bridgeSttLanguage: bridgeStt.language,
                  bridgeSttSubmitMode: bridgeStt.voiceMode?.submitMode,
                  bridgeSttAutoSubmitDelayMs: bridgeStt.voiceMode?.autoSubmitDelayMs,
                  bridgeSttEndOfTurnThreshold: bridgeStt.voiceMode?.endOfTurnThreshold
                }
            : {})
        }
      }
    }
  }

  function formatLiveKitVoiceError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim()
    }
    return 'Failed to connect LiveKit bridge room.'
  }

  function dispatchLiveKitRemoteAudioStart(audio: HTMLMediaElement) {
    if (!shouldRouteLiveKitRemoteAudioToGoon(activeModelVoiceSession)) return
    liveKitRemoteGoonAudioElements.add(audio)
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('batshit:voice-playback-start', {
        detail: {
          mode: 'livekit',
          audio,
          messageId: null,
          agentId: currentAgent?.id ?? null,
          durationMs: null,
          lipSyncAnalyzerId: 'batshit-text-timing'
        }
      })
    )
  }

  function dispatchLiveKitRemoteAudioEnd(audio?: HTMLMediaElement | null) {
    const shouldDispatchEnd = audio
      ? liveKitRemoteGoonAudioElements.has(audio)
      : liveKitRemoteGoonAudioElements.size > 0
    if (audio) {
      liveKitRemoteGoonAudioElements.delete(audio)
    } else {
      liveKitRemoteGoonAudioElements.clear()
    }
    if (!shouldDispatchEnd) return
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('batshit:voice-playback-end', {
        detail: {
          mode: 'livekit',
          audio: audio ?? null,
          messageId: null,
          agentId: currentAgent?.id ?? null
        }
      })
    )
  }

  function dispatchLiveKitTranscriptionCue(detail: LiveKitTranscriptionDetail) {
    if (typeof window === 'undefined') return
    if (activeModelVoiceSession?.mode !== 'speech-to-speech') return
    if (detail.isLocalParticipant) return
    if (!goonsPanelOpen) return

    for (const segment of detail.segments) {
      const content = segment?.text?.trim()
      if (!content) continue
      window.dispatchEvent(
        new CustomEvent('batshit:goon-message', {
          detail: {
            messageId: `livekit-transcription-${segment.id}`,
            agentId: currentAgent?.id ?? null,
            content,
            speechPlanned: true,
            source: 'livekit-transcription',
            transcriptFinal: segment.final,
            transcriptParticipantIdentity: detail.participantIdentity
          }
        })
      )
    }
  }

  function stopDirectVoiceModeForLiveKit() {
    if (!isListening && !isVoiceMode) return
    invalidatePendingVoiceQuickActionCommit()
    voiceService.stopListening()
    resetVoiceModeTranscriptBuffer()
    isListening = false
    if (isVoiceMode) {
      isVoiceMode = false
      voiceModeInputKind = null
      voiceMode = false
      onVoiceModeChange(false)
      toast.info('Voice mode paused for LiveKit')
    }
  }

  function endDirectVoiceMode(options: { notify?: boolean; preservePendingCommit?: boolean } = {}) {
    directVoiceCapture = null
    if (!options.preservePendingCommit) invalidatePendingVoiceQuickActionCommit()
    voiceService.stopAll()
    voiceService.stopListening()
    resetVoiceModeTranscriptBuffer()
    isVoiceMode = false
    isListening = false
    voiceModeInputKind = null
    voiceMode = false
    onVoiceModeChange(false)
    if (options.notify !== false) {
      toast.success('Voice Mode ended')
    }
  }

  function releaseLiveKitMicrophone() {
    const microphoneHandle = liveKitMicrophoneHandle
    liveKitMicrophoneHandle = null
    if (!microphoneHandle) return
    void microphoneHandle.stop().catch((error) => {
      console.warn('[LiveKit voice] Failed to stop microphone track:', error)
    })
  }

  function disconnectLiveKitVoiceRoom(options: { notify?: boolean } = {}) {
    liveKitVoiceConnectSerial += 1
    liveKitVoiceAbortController?.abort()
    liveKitVoiceAbortController = null
    releaseLiveKitMicrophone()
    dispatchLiveKitRemoteAudioEnd()
    voiceService.setLiveKitVoiceRoomHandle(null)
    liveKitVoiceRoomHandle?.disconnect()
    liveKitVoiceRoomHandle = null
    liveKitVoiceRoomName = null
    liveKitVoiceError = null
    liveKitVoiceStatus = 'disconnected'
    if (options.notify) {
      toast.success('LiveKit room disconnected')
    }
  }

  $effect(() => {
    if (!goonsPanelOpen || !isLiveKitVoiceConnected) return
    if (!shouldRouteLiveKitRemoteAudioToGoon(activeModelVoiceSession)) return
    const replayLiveKitAudio = () => {
      for (const audio of liveKitRemoteGoonAudioElements) {
        dispatchLiveKitRemoteAudioStart(audio)
      }
    }
    replayLiveKitAudio()
    const replayTimer = setInterval(replayLiveKitAudio, 750)
    return () => clearInterval(replayTimer)
  })

  async function connectLiveKitVoiceRoomFromChat() {
    if (liveKitVoiceStatus === 'connecting') return

    stopDirectVoiceModeForLiveKit()
    voiceService.stopAll()

    const connectSerial = liveKitVoiceConnectSerial + 1
    liveKitVoiceConnectSerial = connectSerial
    const abortController = new AbortController()
    liveKitVoiceAbortController = abortController
    liveKitVoiceStatus = 'connecting'
    liveKitVoiceError = null
    liveKitVoiceRoomName = null

    let connectedHandle: LiveKitVoiceRoomHandle | null = null
    let connectedMicrophoneHandle: LiveKitPublishedMicrophoneTrackHandle | null = null

    try {
      const handle = await connectLiveKitVoiceRoom(buildLiveKitVoiceRoomRequest(), {
        signal: abortController.signal,
        onRemoteAudioTrack: ({ audio }) => {
          dispatchLiveKitRemoteAudioStart(audio)
        },
        onTranscription: (detail) => {
          dispatchLiveKitTranscriptionCue(detail)
        },
        onDisconnected: () => {
          if (liveKitVoiceConnectSerial !== connectSerial) return
          if (liveKitVoiceRoomHandle !== connectedHandle) return
          releaseLiveKitMicrophone()
          dispatchLiveKitRemoteAudioEnd()
          connectedHandle?.disconnect()
          voiceService.setLiveKitVoiceRoomHandle(null)
          liveKitVoiceRoomHandle = null
          liveKitVoiceRoomName = null
          liveKitVoiceAbortController = null
          liveKitVoiceStatus = 'disconnected'
        }
      })
      connectedHandle = handle
      const microphoneHandle = await publishMicrophoneToLiveKitRoom(handle, {
        streamName: 'batshit-sidecar'
      })
      connectedMicrophoneHandle = microphoneHandle

      if (liveKitVoiceConnectSerial !== connectSerial || abortController.signal.aborted) {
        await microphoneHandle.stop()
        dispatchLiveKitRemoteAudioEnd()
        handle.disconnect()
        return
      }

      liveKitVoiceRoomHandle = handle
      liveKitMicrophoneHandle = microphoneHandle
      liveKitVoiceRoomName = handle.session.roomName
      liveKitVoiceAbortController = null
      liveKitVoiceStatus = 'connected'
      toast.success(
        activeModelVoiceSession?.mode === 'speech-to-speech'
          ? 'LiveKit speech-to-speech connected'
          : 'LiveKit bridge connected'
      )
    } catch (error) {
      if (connectedMicrophoneHandle) {
        await connectedMicrophoneHandle.stop().catch((stopError) => {
          console.warn('[LiveKit voice] Failed to stop microphone after connect error:', stopError)
        })
      }
      dispatchLiveKitRemoteAudioEnd()
      connectedHandle?.disconnect()
      if (abortController.signal.aborted) {
        if (liveKitVoiceConnectSerial === connectSerial) {
          liveKitVoiceStatus = 'disconnected'
        }
        return
      }

      const message = formatLiveKitVoiceError(error)
      liveKitVoiceStatus = 'error'
      liveKitVoiceError = message
      liveKitVoiceRoomName = null
      liveKitVoiceAbortController = null
      voiceService.setLiveKitVoiceRoomHandle(null)
      toast.error(message)
    }
  }

  async function handleLiveKitVoiceRoomClick() {
    if (isLiveKitVoiceConnected) {
      disconnectLiveKitVoiceRoom({ notify: true })
      return
    }

    if (liveKitVoiceStatus === 'error') {
      disconnectLiveKitVoiceRoom()
    }

    await connectLiveKitVoiceRoomFromChat()
  }

  async function handleVoiceModeButtonClick() {
    if (useLiveKitVoiceButton) {
      await handleLiveKitVoiceRoomClick()
      return
    }

    await handlePhoneClick()
  }

  function handleVoiceSessionEndClick() {
    if (liveKitVoiceModeActive) {
      disconnectLiveKitVoiceRoom({ notify: true })
      return
    }

    endDirectVoiceMode({ notify: true })
  }

  async function loadDefaultWorkspacePreference() {
    try {
      // A save in Settings that lands while this read is on its way is newer and is kept.
      await projectStore.loadDefaultProjectPath(() => projectService.loadPreferences())
    } catch (error) {
      console.error('Failed to load project preferences for chat input:', error)
      toast.error('Default project directory is unavailable. Check Projects settings and try again.')
    }
  }

  async function loadProjectsForContext() {
    const userId = data?.user?.id
    if (!userId) return
    if (projectStore.getProjects().length > 0) return

    try {
      const loadedProjects = await projectService.loadProjects(userId)
      if (loadedProjects.length > 0) {
        projectStore.setProjects(loadedProjects)
      }
    } catch (error) {
      console.error('Failed to load projects for chat context:', error)
    }
  }

  const agentDefaultProject = $derived.by(() => {
    const defaultProjectId = currentAgent?.default_project_id?.trim()
    if (!defaultProjectId) return null
    return projects.find((project) => project.id === defaultProjectId) ?? null
  })

  const agentDefaultModelPreset = $derived.by<SavedModel | null>(() => {
    if (!currentAgent) return null

    const presetId = currentAgent.primary_model_preset_id?.trim()
    if (presetId) {
      return savedModels.find((model) => model.id === presetId) ?? null
    }

    return findChatVoicePresetFallback(savedModels, currentAgent)
  })

  const activeModelVoiceSession = $derived(resolveModelVoiceSessionConfig(agentDefaultModelPreset))
  const voiceModeTextInputSelected = $derived(voiceModeInputMode === 'text')
  const useLiveKitVoiceButton = $derived(
    activeModelVoiceSession?.runtime === 'livekit' ||
      liveKitVoiceStatus !== 'disconnected' ||
      (voiceSessionRuntime === 'livekit' && !voiceModeTextInputSelected)
  )
  const voiceModeTurnSettings = $derived(getVoiceModeTurnSettings())
  const recordedVoiceModeTapToTalk = $derived(voiceModeTurnSettings?.submitMode === 'manual')
  const directVoiceModeActive = $derived(!useLiveKitVoiceButton && isVoiceMode)
  const liveKitVoiceModeActive = $derived(useLiveKitVoiceButton && liveKitVoiceStatus !== 'disconnected')
  const voiceModeSessionPillActive = $derived(directVoiceModeActive || liveKitVoiceModeActive)
  const directRecordedVoiceModeActive = $derived(
    directVoiceModeActive && voiceModeInputKind === 'recorded'
  )
  const directTextVoiceModeActive = $derived(
    directVoiceModeActive && voiceModeInputKind === 'text'
  )
  const voiceModeActivityPreviewVisible = $derived(
    !message.trim() && ((directVoiceModeActive && isListening) || isLiveKitVoiceConnected)
  )
  const dictationActivityPreviewVisible = $derived(
    !isVoiceMode &&
      dictationActivityPreviewPending &&
      !dictationLiveTranscriptVisible &&
      !message.trim()
  )
  const composerVoiceActivityPreviewVisible = $derived(
    voiceModeActivityPreviewVisible || dictationActivityPreviewVisible
  )
  const recordedVoiceModeReadyForInput = $derived(
    directRecordedVoiceModeActive &&
      !isListening &&
      !waitingForAI &&
      !recordedVoiceModeCaptureFinalizing &&
      !voiceModeTurnSendPending &&
      !voiceReplyActive
  )
  const voiceButtonActive = $derived(
    useLiveKitVoiceButton ? isLiveKitVoiceConnected : isVoiceMode
  )
  const voiceButtonPulsing = $derived(
    useLiveKitVoiceButton ? isLiveKitVoiceConnecting : isVoiceMode && isListening
  )
  const directVoiceButtonStateClass = $derived.by(() => {
    if (!directVoiceModeActive) return ''
    if (voiceReplyActive) return 'is-voice-speaking'
    if (directRecordedVoiceModeActive && isListening) return 'is-voice-recording'
    if (
      directRecordedVoiceModeActive &&
      (recordedVoiceModeCaptureFinalizing || voiceModeTurnSendPending || waitingForAI)
    ) {
      return 'is-voice-processing'
    }
    return 'is-voice-active'
  })
  const liveKitVoiceButtonLabel = $derived.by(() => {
    if (isLiveKitVoiceConnected) return 'Disconnect LiveKit bridge'
    if (isLiveKitVoiceConnecting) return 'Connecting LiveKit bridge'
    return activeModelVoiceSession?.mode === 'speech-to-speech'
      ? `Connect ${activeModelVoiceSession.providerLabel ?? 'speech-to-speech'} voice`
      : 'Connect LiveKit bridge'
  })
  const liveKitVoiceButtonTitle = $derived.by(() => {
    if (isLiveKitVoiceConnected) {
      return liveKitVoiceRoomName
        ? `LiveKit bridge connected: ${liveKitVoiceRoomName}`
        : 'LiveKit bridge connected'
    }
    if (isLiveKitVoiceConnecting) return 'Connecting LiveKit bridge...'
    if (liveKitVoiceStatus === 'error' && liveKitVoiceError) {
      return `LiveKit bridge failed: ${liveKitVoiceError}`
    }
    if (activeModelVoiceSession?.mode === 'speech-to-speech') {
      return `${activeModelVoiceSession.providerLabel ?? 'Speech-to-speech'} via LiveKit`
    }
    return 'LiveKit bridge: room audio with Batshit STT/TTS'
  })
  const voiceModeButtonLabel = $derived.by(() => {
    if (useLiveKitVoiceButton) return liveKitVoiceButtonLabel
    if (!isVoiceMode) {
      return voiceModeTextInputSelected ? 'Start Text Input Voice Mode' : 'Start Voice Mode'
    }
    if (voiceReplyActive) return 'Stop spoken reply'
    if (directTextVoiceModeActive) {
      return waitingForAI ? 'Voice reply pending' : 'Text Input Voice Mode active'
    }
    if (voiceModeInputKind === 'recorded') {
      if (isListening) return 'Stop and send voice turn'
      if (recordedVoiceModeCaptureFinalizing || waitingForAI || voiceModeTurnSendPending) {
        return 'Voice turn sending'
      }
      return recordedVoiceModeTapToTalk ? 'Record voice turn' : 'Voice Mode ready'
    }
    return 'Voice Mode listening'
  })
  const voiceModeButtonTitle = $derived.by(() => {
    if (useLiveKitVoiceButton) return liveKitVoiceButtonTitle
    if (!isVoiceMode) {
      return voiceModeTextInputSelected
        ? 'Start Voice Mode with composer text input and spoken replies'
        : 'Start Voice Mode'
    }
    if (voiceReplyActive) return 'Stop the spoken reply and keep Voice Mode on'
    if (directTextVoiceModeActive) {
      return 'Type or use system dictation in the composer, then send. Use the End control to leave Voice Mode.'
    }
    if (voiceModeInputKind === 'recorded' && isListening) {
      return 'Stop recording this voice turn and send it'
    }
    if (
      voiceModeInputKind === 'recorded' &&
      (recordedVoiceModeCaptureFinalizing || waitingForAI || voiceModeTurnSendPending)
    ) {
      return 'Batshit is sending this voice turn'
    }
    if (voiceModeInputKind === 'recorded' && isVoiceMode) {
      return recordedVoiceModeTapToTalk
        ? 'Tap to record your next voice turn. Use the End control to leave Voice Mode.'
        : 'Auto Listen is on. Batshit will listen when it is your turn. Use the End control to leave Voice Mode.'
    }
    return 'Continuous Voice Mode is listening. Use the End control to leave Voice Mode.'
  })
  const voiceModeSessionLabel = $derived.by(() => {
    if (liveKitVoiceModeActive) {
      if (isLiveKitVoiceConnecting) return 'Connecting'
      if (voiceReplyActive) return 'Speaking'
      if (voiceModeActivityPreviewActive) return 'Hearing you'
      return 'Listening'
    }
    if (voiceReplyActive) return 'Speaking'
    if (directTextVoiceModeActive) {
      if (waitingForAI || voiceModeTurnSendPending) return 'Sending'
      return 'Voice replies'
    }
    if (voiceModeInputKind === 'recorded') {
      if (isListening) return 'Recording'
      if (recordedVoiceModeCaptureFinalizing || waitingForAI || voiceModeTurnSendPending) {
        return 'Sending'
      }
      return recordedVoiceModeTapToTalk ? 'Ready' : 'Listening next'
    }
    return isListening ? 'Listening' : 'Voice Mode'
  })
  const voiceModeSessionModeLabel = $derived.by(() => {
    if (liveKitVoiceModeActive) {
      return activeModelVoiceSession?.mode === 'speech-to-speech'
        ? 'Speech-to-speech'
        : 'LiveKit Bridge'
    }
    if (voiceModeInputKind === 'recorded') {
      return recordedVoiceModeTapToTalk ? 'Manual Turn' : 'Auto Listen'
    }
    if (voiceModeInputKind === 'text') return 'Text Input'
    return 'Live Mic'
  })
  const voiceModeSessionStateClass = $derived.by(() => {
    if (liveKitVoiceModeActive) {
      if (isLiveKitVoiceConnecting) return 'is-processing'
      if (voiceReplyActive) return 'is-speaking'
      return voiceModeActivityPreviewActive ? 'is-recording' : 'is-listening'
    }
    if (voiceReplyActive) return 'is-speaking'
    if (directTextVoiceModeActive) {
      return waitingForAI || voiceModeTurnSendPending ? 'is-processing' : 'is-ready'
    }
    if (voiceModeInputKind === 'recorded') {
      if (isListening) return 'is-recording'
      if (recordedVoiceModeCaptureFinalizing || waitingForAI || voiceModeTurnSendPending) {
        return 'is-processing'
      }
      return 'is-ready'
    }
    return isListening ? 'is-listening' : 'is-ready'
  })
  const desktopControlsVoiceOwnerState = $derived.by<DesktopControlsVoiceOwnerState>(() => {
    const active = voiceModeSessionPillActive
    const runtime = useLiveKitVoiceButton ? 'livekit' : 'direct'
    const processing =
      recordedVoiceModeCaptureFinalizing || voiceModeTurnSendPending || waitingForAI
    const phase: DesktopControlsVoiceOwnerState['phase'] =
      liveKitVoiceStatus === 'error'
        ? 'error'
        : isLiveKitVoiceConnecting
          ? 'starting'
          : !active
            ? 'inactive'
            : voiceReplyActive
              ? 'speaking'
              : processing
                ? 'processing'
                : runtime === 'livekit' || isListening
                  ? 'listening'
                  : 'ready'
    const allowedIntents: DesktopControlsVoiceOwnerState['allowedIntents'] = active
      ? [
          'end',
          ...(runtime === 'direct' && voiceModeInputKind === 'recorded' && !processing
            ? (['toggle-listening'] as const)
            : [])
        ]
      : liveKitVoiceStatus === 'connecting'
        ? []
        : ['start']
    return {
      active,
      listening: active && (runtime === 'livekit' ? isLiveKitVoiceConnected : isListening),
      runtime,
      inputKind: runtime === 'livekit' && active ? 'livekit' : voiceModeInputKind,
      phase,
      label: active ? voiceModeSessionLabel : 'Voice Mode off',
      modeLabel: active ? voiceModeSessionModeLabel : runtime === 'livekit' ? 'LiveKit' : 'Voice Mode',
      error: liveKitVoiceError,
      allowedIntents
    }
  })

  $effect(() => {
    const state = desktopControlsVoiceOwnerState
    desktopControlsVoiceOwner?.publish(state)
  })

function parseBooleanSetting(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
  }
  return null
}

function getNativeToolsSettingsFromAgent(
  agent: agentStore.Agent | null | undefined
): Record<string, any> {
  const providerSettings = agent?.provider_specific_settings
  if (!providerSettings || typeof providerSettings !== 'object') return {}
  const nested =
    providerSettings.nativeTools && typeof providerSettings.nativeTools === 'object'
      ? providerSettings.nativeTools
      : providerSettings.batshitNativeTools && typeof providerSettings.batshitNativeTools === 'object'
        ? providerSettings.batshitNativeTools
        : {}
  return nested as Record<string, any>
}

function normalizeNativeBashAccessMode(value: unknown): NativeBashAccessMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'plan' || normalized === 'read_only' || normalized === 'readonly') {
    return 'plan'
  }
  if (normalized === 'agent' || normalized === 'workspace') {
    return 'agent'
  }
  if (normalized === 'dangerous' || normalized === 'unrestricted') {
    return 'dangerous'
  }
  return null
}

function isNativeBashEnabled(agent: agentStore.Agent | null | undefined): boolean {
  const settings = getNativeToolsSettingsFromAgent(agent)
  const parsed =
    parseBooleanSetting(settings.bashEnabled ?? settings.nativeBashEnabled) ??
    parseBooleanSetting((agent?.provider_specific_settings as any)?.bashEnabled) ??
    parseBooleanSetting((agent?.provider_specific_settings as any)?.nativeBashEnabled)
  return parsed ?? true
}

function resolveNativeBashAccessMode(
  agent: agentStore.Agent | null | undefined
): NativeBashAccessMode {
  const settings = getNativeToolsSettingsFromAgent(agent)
  return (
    normalizeNativeBashAccessMode(
      settings.bashAccessMode ?? settings.nativeBashAccessMode ?? settings.bashPolicyMode
    ) ?? 'agent'
  )
}

const primaryAgentType = $derived.by(() => normalizePrimaryAgentType(currentAgent))

  const groupSelected = $derived.by(() => {
    return Boolean(currentSession?.metadata?.group_chat?.group_id)
  })

  // SA-139 R1/R4: a leftover Primary of a retired type (the Claude Code CLI lane, Codex CLI or
  // n8n) has no live lane. The server refuses its send with a readable 409, so the chat bar shows
  // it no model control.
  const isRetiredPrimaryAgent = $derived(isRetiredPrimaryAgentType(primaryAgentType))

  function normalizeProjectRules(value: unknown): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, any>
  }

  const mode123ProjectContext = $derived.by(() => {
    if (currentProject?.root_path) return currentProject
    if (agentDefaultProject?.root_path) return agentDefaultProject
    return null
  })

  const mode123ProjectPath = $derived.by(() => {
    if (mode123ProjectContext?.root_path) return mode123ProjectContext.root_path
    if (currentAgent?.default_project_id?.trim()) return null
    return defaultWorkspacePath
  })

  const resolvedProjectRules = $derived.by(() => {
    return normalizeProjectRules(mode123ProjectContext?.rules_json)
  })

  const activeMentionExclusions = $derived.by(() => {
    if (currentProject?.custom_exclusions?.length) return currentProject.custom_exclusions
    if (mode123ProjectContext?.custom_exclusions?.length) {
      return mode123ProjectContext.custom_exclusions
    }
    return []
  })

  const uploadProjectRootPath = $derived.by(() => {
    if (currentProject?.root_path) return currentProject.root_path
    if (mode123ProjectContext?.root_path) return mode123ProjectContext.root_path
    return null
  })

  const bashModeSelectorVisible = $derived.by(() =>
    Boolean(primaryAgentAllowsNativeBash(primaryAgentType) && isNativeBashEnabled(currentAgent))
  )
  const nativeBashAccessModeActive = $derived.by<NativeBashAccessMode>(() =>
    resolveNativeBashAccessMode(currentAgent)
  )
  const activeNativeBashModeOption = $derived.by<(typeof NATIVE_BASH_MODE_OPTIONS)[number]>(() => {
    return (
      NATIVE_BASH_MODE_OPTIONS.find((option) => option.value === nativeBashAccessModeActive) ??
      NATIVE_BASH_MODE_OPTIONS[1]
    )
  })

  let batshitSlashCommands = $state<SlashCommandRow[]>([])
  let slashCommandsLoading = $state(false)
  let slashCommandsReloadQueued = false
  let slashCommandCacheKey = $state<string | null>(null)

  let slashOpen = $state(false)
  let slashQuery = $state('')
  let slashStart = $state<number | null>(null)
  let slashHighlightIndex = $state(0)

  let mentionOpen = $state(false)
  let mentionQuery = $state('')
  let mentionStart = $state<number | null>(null)
  let mentionHighlightIndex = $state(0)

  const mentionMatches = $derived.by(() =>
    validateMentions(message, flatFiles, currentProject?.custom_exclusions ?? [])
  )
  const mentionSegments = $derived.by(() => buildMentionSegments(message, mentionMatches))
  const composerHighlightSegments = $derived.by<ComposerHighlightSegment[]>(() =>
    buildComposerHighlightSegments(mentionSegments)
  )
  const mentionOptions = $derived.by(() => {
    if (!mentionOpen) return []
    return filterMentionOptions(mentionQuery, flatFiles).slice(0, 8)
  })
  // Subtle surface for the background @ mention index: only shown when the user
  // actually opens autocomplete while the index is empty (still hydrating or failed).
  const mentionIndexNotice = $derived.by(() => {
    if (!mentionOpen || flatFiles.length > 0) return null
    if (mentionIndexStatus === 'loading') return 'Indexing project files for @ mentions...'
    if (mentionIndexStatus === 'error') {
      return mentionIndexError || 'Project file index unavailable'
    }
    return null
  })

  const batshitSlashCommandOptions = $derived.by(() => {
    return batshitSlashCommands
      .filter((command) => command.is_active !== false && command.can_be_invoked_in_chat !== false)
      .filter((command) => isCommandEnabledForCurrentAgent(command))
      .map((command) => {
        const invocation = normalizeBatshitInvocation(command)
        return {
          id: `batshit:${command.id}`,
          name: invocation.slice(1),
          invocation,
          description:
            command.type === 'skill'
              ? command.description || command.skill_summary || ''
              : '',
          displayName: command.displayName || command.name,
          source: 'batshit' as const,
          scope: 'global' as const
        }
      })
  })
  const slashOptions = $derived.by(() => {
    if (!slashOpen) return []
    return filterSlashOptions(slashQuery, batshitSlashCommandOptions).slice(0, 8)
  })
  
  function formatMentionsForSend(text: string, _mentions: MentionMatch[]) {
    return text
  }

  function buildSkillInlineLabel(value: string) {
    return `Skill: ${formatSkillInlineDisplayName(value)}`
  }

  function buildSkillInlineNote(value: string) {
    return `[${buildSkillInlineLabel(value)}]`
  }

  function normalizeSkillInlineLabel(value: string) {
    return stripSkillInlineMetadata(value)
      .toLowerCase()
      .replace(/\s+/g, ' ')
  }

  function splitSkillHighlightSegments(text: string): ComposerHighlightSegment[] {
    const segments: ComposerHighlightSegment[] = []
    const regex = /\[(Skill|Invoked skill):\s*([^\]]+)\]/gi
    let cursor = 0
    for (const match of text.matchAll(regex)) {
      const full = match[0] ?? ''
      const labelRaw = String(match[2] ?? '').trim()
      const index = typeof match.index === 'number' ? match.index : -1
      if (!full || index < 0) continue
      if (index > cursor) {
        segments.push({ type: 'text', value: text.slice(cursor, index) })
      }
      const formattedLabel = buildSkillInlineLabel(labelRaw)
      segments.push({
        type: 'skill',
        value: `[${formattedLabel}]`,
        label: formattedLabel
      })
      cursor = index + full.length
    }
    if (cursor < text.length) {
      segments.push({ type: 'text', value: text.slice(cursor) })
    }
    return segments.length > 0 ? segments : [{ type: 'text', value: text }]
  }

  function buildComposerHighlightSegments(
    segments: Array<{ type: 'text' | 'mention'; value: string; mention?: MentionMatch }>
  ): ComposerHighlightSegment[] {
    const output: ComposerHighlightSegment[] = []
    for (const segment of segments) {
      if (segment.type === 'mention' && segment.mention) {
        output.push({
          type: 'mention',
          value: segment.value,
          mention: segment.mention
        })
        continue
      }
      output.push(...splitSkillHighlightSegments(segment.value))
    }
    return output
  }

  function normalizeInvocation(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return ''
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  }

  function resolveSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  function resolveAgentId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  function hasSlashToken(text: string): boolean {
    return /(^|\s)\/[\w.:-]+/.test(text)
  }

  function hasSkillNoteToken(text: string): boolean {
    return /\[(Skill|Invoked skill):\s*[^\]]+\]/i.test(text)
  }

  function getInlineSkillTokenMatches(text: string): Array<{
    start: number
    end: number
    raw: string
    label: string
  }> {
    const matches: Array<{ start: number; end: number; raw: string; label: string }> = []
    const regex = /\[(Skill|Invoked skill):\s*([^\]]+)\]/gi
    for (const match of text.matchAll(regex)) {
      const raw = match[0] ?? ''
      const label = formatSkillInlineDisplayName(String(match[2] ?? ''))
      if (!raw || !label || typeof match.index !== 'number') continue
      matches.push({
        start: match.index,
        end: match.index + raw.length,
        raw,
        label
      })
    }
    return matches
  }

  async function ensureSessionForSlashInvocation(onCreated?: (identity: { sessionId: string; agentId: string }) => boolean) {
    const activeSessionId = resolveSessionId(sessionStore.getCurrentSessionId()) ?? resolveSessionId(sessionId)
    if (activeSessionId) return onCreated ? null : activeSessionId

    if (creatingSlashSession) {
      return onCreated ? null : resolveSessionId(sessionStore.getCurrentSessionId())
    }

    const userId = resolveSessionId(data?.user?.id)
    if (!userId) return null

    const creatingAgentId = currentAgent?.id ?? null
    if (onCreated && !creatingAgentId) return null
    creatingSlashSession = true
    try {
      if (foldersStore.folders.length === 0) {
        await foldersStore.loadFolders()
      }
      const folderId = foldersStore.defaultFolder?.id
      let adopted = true
      const created = await sessionService.createSession(userId, folderId, onCreated ? creatingAgentId : undefined, {
        beforeSelect: row => {
          if (!onCreated) return
          adopted = sessionStore.getCurrentSessionId() === null && currentAgent?.id === creatingAgentId &&
            onCreated({ sessionId: row.id, agentId: creatingAgentId! })
          return adopted
        }
      })
      if (!adopted) return null
      return resolveSessionId(created?.id) ?? resolveSessionId(sessionStore.getCurrentSessionId())
    } catch (error) {
      console.error('Failed to create session before slash invocation:', error)
      toast.error('Failed to create session before slash command execution')
      return null
    } finally {
      creatingSlashSession = false
    }
  }

  function normalizeBatshitInvocation(command: SlashCommandRow) {
    const fromPattern = command.invocation_pattern?.trim()
    const fallback = command.id || command.name
    return normalizeInvocation(fromPattern && fromPattern.length > 0 ? fromPattern : `/${fallback}`)
  }

  function resolveBatshitCommandByOption(option: SlashCommandDescriptor): SlashCommandRow | null {
    if (option.source !== 'batshit') return null
    const optionId = String(option.id ?? '')
    const prefixedId = optionId.startsWith('batshit:') ? optionId.slice('batshit:'.length) : optionId
    const byId = batshitSlashCommands.find((command) => command.id === prefixedId)
    if (byId) return byId

    const invocation = normalizeInvocation(option.invocation)
    if (!invocation) return null
    const commandMap = buildBatshitSlashCommandMap({ ignoreAgentEnablement: true })
    return commandMap.get(invocation) ?? null
  }

  function resolveSkillCommandByInlineLabel(label: string): SlashCommandRow | null {
    const normalizedLabel = normalizeSkillInlineLabel(label)
    if (!normalizedLabel) return null

    const candidates = batshitSlashCommands.filter((command) => {
      if (command.type !== 'skill') return false
      if (command.is_active === false || command.can_be_invoked_in_chat === false) return false
      if (!isCommandEnabledForCurrentAgent(command)) return false
      return true
    })

    const matched = candidates.filter((command) => {
      const displayName = command.displayName || command.name || command.id
      const aliases = [
        displayName,
        command.name,
        command.id,
        formatSkillInlineDisplayName(displayName),
        formatSkillInlineDisplayName(command.name || ''),
        formatSkillInlineDisplayName(command.id || '')
      ]
      return aliases.some((alias) => normalizeSkillInlineLabel(alias) === normalizedLabel)
    })

    return matched.length === 1 ? matched[0] : null
  }

  function isCommandEnabledForCurrentAgent(command: SlashCommandRow) {
    return isSlashCommandEnabledForAgent(command, currentAgent?.id ?? null)
  }

  function filterSlashOptions(query: string, options: SlashCommandDescriptor[]) {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return options
    return options.filter((option) => {
      const haystack = [
        option.invocation,
        option.name,
        option.displayName,
        option.description,
        option.plugin,
        option.argumentHint
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(trimmed)
    })
  }

  function getModeItemClass(isActive: boolean) {
    return `chat-mode-menu-item ${isActive ? 'is-active' : 'is-muted'}`
  }

  const slashCommandContextKey = $derived.by(() => {
    const agentId = currentAgent?.id
    if (!agentId) return null
    return `${agentId}|${mode123ProjectPath ?? ''}`
  })

  $effect(() => {
    const key = slashCommandContextKey
    if (!key) {
      batshitSlashCommands = []
      slashCommandCacheKey = null
      return
    }
    if (slashCommandCacheKey === key) return
    slashCommandCacheKey = key
    void loadSlashCommands()
  })

  async function loadSlashCommands() {
    if (slashCommandsLoading) {
      slashCommandsReloadQueued = true
      return
    }
    slashCommandsLoading = true

    try {
      const batshitResponse = await fetch('/api/slash-commands')
      const batshitData = await batshitResponse.json()
      batshitSlashCommands = Array.isArray(batshitData.slashCommands) ? batshitData.slashCommands : []
    } catch (error) {
      console.error('Failed to load slash commands', error)
    } finally {
      slashCommandsLoading = false
      if (slashCommandsReloadQueued) {
        slashCommandsReloadQueued = false
        void loadSlashCommands()
      }
    }
  }

  function resetComposer() {
    setComposerMessage('')
    composerHasSttTranscript = false
    slashOpen = false
    slashQuery = ''
    slashStart = null
    slashHighlightIndex = 0
    mentionOpen = false
    mentionQuery = ''
    mentionStart = null
    mentionHighlightIndex = 0

    if (textarea) {
      textarea.style.height = 'auto'
    }
  }

  function getActiveSlashCommand(text: string, caretIndex: number) {
    const beforeCaret = text.slice(0, caretIndex)
    const match = beforeCaret.match(/(^|\s)\/([\w.:-]*)$/)
    if (!match || match.index === undefined) return null
    const query = match[2] ?? ''
    const start = match.index + match[1].length
    return { start, query }
  }

  function syncSlashState() {
    if (!textarea) return
    const caretIndex = textarea.selectionStart ?? message.length
    const active = getActiveSlashCommand(message, caretIndex)
    if (!active) {
      slashOpen = false
      slashQuery = ''
      slashStart = null
      slashHighlightIndex = 0
      return
    }

    const nextQuery = active.query
    const nextStart = active.start
    const shouldReset = nextQuery !== slashQuery || nextStart !== slashStart

    slashOpen = true
    slashQuery = nextQuery
    slashStart = nextStart
    if (shouldReset) {
      slashHighlightIndex = 0
    }

    if (mentionOpen) {
      mentionOpen = false
      mentionQuery = ''
      mentionStart = null
      mentionHighlightIndex = 0
    }
  }

  function handleSlashSelect(command: SlashCommandDescriptor) {
    if (slashStart === null || !textarea) return
    const afterStart = message.slice(slashStart + 1)
    const match = afterStart.match(/^[\w.:-]*/)
    const slashEnd = slashStart + 1 + (match ? match[0].length : 0)
    const before = message.slice(0, slashStart)
    const after = message.slice(slashEnd)
    const batshitCommand = resolveBatshitCommandByOption(command)
    const insertion =
      batshitCommand?.type === 'skill'
        ? `${buildSkillInlineNote(batshitCommand.name || batshitCommand.id || batshitCommand.displayName || 'skill')} `
        : `${command.invocation} `

    setComposerMessage(`${before}${insertion}${after}`)
    slashOpen = false
    slashQuery = ''
    slashStart = null
    slashHighlightIndex = 0

    requestAnimationFrame(() => {
      if (!textarea) return
      const nextCaret = before.length + insertion.length
      textarea.focus()
      textarea.setSelectionRange(nextCaret, nextCaret)
      autoResize()
    })
  }

  function buildBatshitSlashCommandMap(options?: { ignoreAgentEnablement?: boolean }) {
    const map = new Map<string, SlashCommandRow>()
    for (const command of batshitSlashCommands) {
      if (command.is_active === false || command.can_be_invoked_in_chat === false) continue
      if (!options?.ignoreAgentEnablement && !isCommandEnabledForCurrentAgent(command)) continue
      const invocation = normalizeBatshitInvocation(command)
      if (invocation) map.set(invocation, command)
      const nameInvocation = normalizeInvocation(command.name || command.id)
      if (nameInvocation && !map.has(nameInvocation)) map.set(nameInvocation, command)
    }
    return map
  }

  async function expandSlashCommands(
    text: string,
    invocationSessionId: string | null = sessionId
  ): Promise<BatshitSlashExpandResult> {
    const map = buildBatshitSlashCommandMap()
    const mapAllAgents = buildBatshitSlashCommandMap({ ignoreAgentEnablement: true })
    const inlineSkillMatches = getInlineSkillTokenMatches(text)

    if (map.size === 0 && inlineSkillMatches.length === 0) {
      return {
        text,
        blocked: false,
        expandedPrompts: []
      }
    }

    const initialSlashRegex = /(^|\s)(\/[\w.:-]+)/g
    const initialSlashMatches = Array.from(text.matchAll(initialSlashRegex))
    if (initialSlashMatches.length === 0 && inlineSkillMatches.length === 0) {
      return {
        text,
        blocked: false,
        expandedPrompts: []
      }
    }

    const slashSkillInvocationCount = initialSlashMatches.reduce((count, match) => {
      const token = match?.[2] ?? ''
      const command = token ? map.get(token) : null
      return command?.type === 'skill' ? count + 1 : count
    }, 0)
    const skillInvocationCount = slashSkillInvocationCount + inlineSkillMatches.length
    if (skillInvocationCount > 1) {
      toast.error('one skill invocation per message')
      return {
        text,
        blocked: true,
        expandedPrompts: []
      }
    }

    const expandedPrompts: SlashCommandRow[] = []
    let result = text

    const invokeBatshitCommand = async (command: SlashCommandRow, rawArgs: string) => {
      const response = await fetch(`/api/slash-commands/${command.id}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawArgs,
          agentId: currentAgent?.id ?? null,
          sessionId: invocationSessionId ?? null
        })
      })

      const payload = await response.json()
      const expansion = typeof payload?.expansion === 'string' ? payload.expansion : ''
      const expansionKind = payload?.expansionKind === 'prompt_inline' ? 'prompt_inline' : null

      if (!response.ok || !expansion.trim() || !expansionKind) {
        return {
          ok: false as const,
          error: payload?.error || `Failed to invoke /${command.name}`
        }
      }

      const warnings = Array.isArray(payload?.warnings)
        ? payload.warnings.map((entry: unknown) => String(entry ?? '').trim()).filter(Boolean)
        : []
      if (warnings.length > 0) {
        toast.warning(warnings[0])
      }

      return {
        ok: true as const,
        expansion
      }
    }

    for (let i = inlineSkillMatches.length - 1; i >= 0; i -= 1) {
      const tokenMatch = inlineSkillMatches[i]
      const command = resolveSkillCommandByInlineLabel(tokenMatch.label)
      if (!command || command.type !== 'skill') {
        toast.error(`Unknown skill token: ${tokenMatch.raw}`)
        return {
          text,
          blocked: true,
          expandedPrompts: []
        }
      }

      try {
        const invocation = await invokeBatshitCommand(command, '')
        if (!invocation.ok) {
          toast.error(invocation.error)
          return {
            text,
            blocked: true,
            expandedPrompts: []
          }
        }

        result = `${result.slice(0, tokenMatch.start)}${invocation.expansion}${result.slice(tokenMatch.end)}`
        expandedPrompts.push(command)
      } catch (error) {
        console.error('Skill token invocation failed', error)
        toast.error(`Failed to activate /${command.name}`)
        return {
          text,
          blocked: true,
          expandedPrompts: []
        }
      }
    }

    const slashRegex = /(^|\s)(\/[\w.:-]+)/g
    const matches = Array.from(result.matchAll(slashRegex))
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i]
      if (!match || match.index === undefined) continue
      const prefix = match[1] ?? ''
      const token = match[2] ?? ''
      if (!token) continue

      const start = match.index + prefix.length
      const tokenEnd = start + token.length

      let replacementEnd = result.length
      const nextMatch = matches[i + 1]
      if (nextMatch && nextMatch.index !== undefined) {
        const nextPrefix = nextMatch[1] ?? ''
        replacementEnd = nextMatch.index + nextPrefix.length
      }

      const remainder = result.slice(tokenEnd, replacementEnd)
      const newlineIndex = remainder.indexOf('\n')
      const argsEnd = newlineIndex >= 0 ? tokenEnd + newlineIndex : replacementEnd
      const rawArgs = result.slice(tokenEnd, argsEnd).trim()
      const replacementStop = rawArgs.length > 0 ? argsEnd : tokenEnd

      const command = map.get(token)
      if (command) {
        try {
          const invocation = await invokeBatshitCommand(command, rawArgs)
          if (!invocation.ok) {
            toast.error(invocation.error)
            return {
              text,
              blocked: true,
              expandedPrompts: []
            }
          }
          const trailingArgs = command.type === 'skill' && rawArgs ? ` ${rawArgs}` : ''
          result = `${result.slice(0, start)}${invocation.expansion}${trailingArgs}${result.slice(replacementStop)}`
          expandedPrompts.push(command)
          continue
        } catch (error) {
          console.error('Slash invocation failed', error)
          toast.error(`Failed to invoke /${command.name}`)
          return {
            text,
            blocked: true,
            expandedPrompts: []
          }
        }
      }

      const agentDisabledCommand = mapAllAgents.get(token)
      if (agentDisabledCommand && !isCommandEnabledForCurrentAgent(agentDisabledCommand)) {
        toast.error(`${token} is not enabled for this agent`)
        return {
          text,
          blocked: true,
          expandedPrompts: []
        }
      }
    }

    return {
      text: result,
      blocked: false,
      expandedPrompts
    }
  }

  async function sendMessageWithText(
    rawText: string,
    overrides?: {
      stt?: boolean
      tts?: boolean
      busySendModeOverride?: BusySendMode
      quickAction?: QuickActionMark | null
      /** A pending Voice Mode verdict must still belong to the selected chat at commit time. */
      beforeSend?: () => boolean
      /** Preserve the chat that owned a delayed Voice Mode turn throughout send preparation. */
      composerSessionId?: string | null
      /** A newer live transcript must survive acceptance of the older delayed turn. */
      mayResetComposer?: () => boolean
      /** Local page completion, never message/provider metadata. */
      onNoReplyCompleted?: () => void
      /** The page chooses the local completion owner; never message/provider metadata. */
      onReplyAdmitted?: (kind: 'direct' | 'steer' | 'queued') => void
      onSteerPrepared?: (identity: { steerId: string; sessionId: string; targetMessageId?: string }) => void
      /** Exact page-created session, before its selection is published. Local only. */
      onComposerSessionCreated?: (identity: { sessionId: string; agentId: string }) => boolean
    }
  ): Promise<boolean> {
    if (!rawText.trim() || disabled) return false

    const currentMentions = validateMentions(
      rawText,
      flatFiles,
      activeMentionExclusions
    )

    let finalMessage = neutralizeAllClipReferenceSyntax(
      formatMentionsForSend(rawText, currentMentions).trim()
    )

    const missingMentions = currentMentions.filter((mention) => mention.status === 'missing')
    const excludedMentions = currentMentions.filter((mention) => mention.status === 'excluded')
    const binaryMentions = currentMentions.filter((mention) =>
      mention.status === 'binary' || mention.status === 'image'
    )
    if (missingMentions.length > 0) {
      toast.warning(
        `${missingMentions.length} file reference${missingMentions.length > 1 ? 's' : ''} not found`
      )
    }
    if (excludedMentions.length > 0) {
      toast.warning(
        `${excludedMentions.length} file reference${excludedMentions.length > 1 ? 's' : ''} blocked by project exclusions`
      )
    }
    if (binaryMentions.length > 0) {
      toast.warning(
        `${binaryMentions.length} file reference${binaryMentions.length > 1 ? 's' : ''} look binary or image-based`,
        {
          action: {
            label: 'Upload',
            onClick: () => uploadMentionFiles(binaryMentions)
          }
        }
      )
    }
    
    /**
     * SA-119 P2 (DL-119-04) — a Steer sends the WORDS, and the file stays in the box.
     *
     * Josh's rule is that nothing typed or attached is ever thrown away. The steer route
     * cannot carry a clip (it takes `{sessionId, messageId, steerId, text, deliver}` and
     * nothing else), so a Steer with a clip attached has two honest options: refuse, or
     * send the words now and leave the clip where it is for the next send. DL-119-04 picks
     * the second, and that means this send must carry NO clip at all — not the syntax
     * appended to the text, and not the ids in the metadata. Appending the syntax anyway
     * would hand the model a reference to a clip the server was never given, and then send
     * the same clip again with the next message.
     *
     * Enter never reaches here with a clip (DL-119-02 makes Enter queue whenever the box
     * carries a file), so this is the Steer badge and Cmd/Ctrl+Enter.
     */
    const steeringKeepsClips = overrides?.busySendModeOverride === 'steer'

    // Get the clips that are being sent with this message
    const clippedItems = steeringKeepsClips
      ? []
      : clipsManager?.getClippedItems
        ? clipsManager.getClippedItems()
        : []

    // TEMPORARY: Still embed clips during transition period
    // Once backend is fully migrated, we can remove this
    if (!steeringKeepsClips && clipsManager?.getClippedItemsSyntax) {
      const clipsSyntax = clipsManager.getClippedItemsSyntax()
      if (clipsSyntax) {
        finalMessage = `${finalMessage}\n\n${clipsSyntax}`
      }
    }

    const hasCapturedComposerSession = overrides?.composerSessionId !== undefined
    let slashInvocationSessionId = hasCapturedComposerSession
      ? resolveSessionId(overrides?.composerSessionId)
      : resolveSessionId(sessionId) ?? resolveSessionId(sessionStore.getCurrentSessionId())

    if ((hasSlashToken(finalMessage) || hasSkillNoteToken(finalMessage)) && !slashInvocationSessionId) {
      slashInvocationSessionId = await ensureSessionForSlashInvocation(overrides?.onComposerSessionCreated)
      if (!slashInvocationSessionId) {
        return false
      }
    }

    const slashResult = await expandSlashCommands(finalMessage, slashInvocationSessionId)
    if (slashResult.blocked) return false
    finalMessage = slashResult.text
    if (slashResult.expandedPrompts.length > 0) {
      const expandedNames = slashResult.expandedPrompts.map((command) => command.name).join(', ')
      toast.success(
        `Expanded ${slashResult.expandedPrompts.length} slash command${slashResult.expandedPrompts.length > 1 ? 's' : ''}: ${expandedNames}`
      )
    }
    const fileReferences = mapMentionsToFileReferences(currentMentions)

    // Send with appropriate metadata for voice mode
    const shouldSpeak = overrides?.tts ?? voiceMode
    const messageIncludesStt = overrides?.stt ?? composerHasSttTranscript
    const sentClipIds = clippedItems
      .map((clip: { id?: string }) => clip.id)
      .filter((id: string | undefined): id is string => Boolean(id))
    const resetAcceptedComposer = () => {
      if (overrides?.mayResetComposer && !overrides.mayResetComposer()) return
      resetComposer()
    }
    let acceptedHandled = false
    const handleAccepted = async (waitForServer = false) => {
      if (acceptedHandled) return
      acceptedHandled = true
      resetAcceptedComposer()

      // DL-119-04: the text-only reset. `resetComposer` has only ever cleared the TEXT —
      // the clips are cleared here, by telling the clips manager the message was accepted —
      // so "keep the clips" is this call being skipped, and nothing else.
      if (!steeringKeepsClips && clipsManager?.handleMessageAccepted) {
        await clipsManager.handleMessageAccepted({
          waitForServer,
          ...(overrides?.mayResetComposer ? { clipIds: sentClipIds } : {})
        })
      }

    }

    const composerSessionId = hasCapturedComposerSession
      ? resolveSessionId(overrides?.composerSessionId) ?? slashInvocationSessionId
      : resolveSessionId(sessionId) ?? resolveSessionId(sessionStore.getCurrentSessionId())
    const metadata: Record<string, any> = {
      stt: Boolean(messageIncludesStt),
      tts: Boolean(shouldSpeak),
      voiceMode: shouldSpeak ? 'voice' : 'text',
      realtime: false,
      composerSessionId: composerSessionId ?? undefined,
      fileReferences: fileReferences.length ? fileReferences : undefined,
      clipIds: sentClipIds,
      // SA-120 P9: a quick action that ran on this turn AND left something for the agent.
      quickAction: overrides?.quickAction ?? undefined,
      onAccepted: () => handleAccepted(false),
      /**
       * SA-119 review F-P3b-2 — the one callback a receipt's **Send now** may replay.
       *
       * `onAccepted` above closes over the composer's LIVE state: it clears the text and
       * unclips whatever one-time clips are attached when it runs. A replay minutes later
       * must do neither to a box the user has typed into since. This closes over THIS
       * message's clip ids and nothing else, so the one-time clip it carried is released
       * when it finally goes and a clip attached since is left alone.
       * `replayableSendMetadata` swaps it in for `onAccepted` on the replay and drops it
       * everywhere else; the page never calls it by this name.
       */
      onReplayAccepted: () =>
        clipsManager?.handleMessageAccepted?.({ waitForServer: false, clipIds: sentClipIds }),
      // SA-114 P3 (DL-114-01): present only when Cmd/Ctrl+Enter asked for the other mode.
      busySendModeOverride: overrides?.busySendModeOverride
    }
    if (mode123ProjectPath) {
      metadata.projectPath = mode123ProjectPath
    }
    if (resolvedProjectRules) {
      metadata.projectRules = resolvedProjectRules
    }
    if (overrides?.beforeSend && !overrides.beforeSend()) return false
    const sendAccepted = await Promise.resolve(onSend(finalMessage, metadata, {
      onNoReplyCompleted: overrides?.onNoReplyCompleted,
      onReplyAdmitted: overrides?.onReplyAdmitted,
      onSteerPrepared: overrides?.onSteerPrepared,
      onComposerSessionCreated: overrides?.onComposerSessionCreated
    }))
    if (sendAccepted === false) {
      return false
    }
    await handleAccepted(true)
    return true
  }

  async function stopDictationBeforeSend(): Promise<boolean> {
    if (isVoiceMode) return true

    const pendingDictation = dictationPromise
    if (!isListening && !pendingDictation) return true

    if (isListening) {
      voiceService.stopListening()
      isListening = false
    }

    if (!pendingDictation) return true

    try {
      finalizingDictation = true
      await pendingDictation
      await tick()
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Voice recognition failed'
      toast.error(errorMessage)
      return false
    } finally {
      finalizingDictation = false
    }
  }

  async function handleSend(busySendModeOverride: BusySendMode | null = null) {
    if (finalizingDictation) return
    const dictationReady = await stopDictationBeforeSend()
    if (!dictationReady) return
    await sendMessageWithText(message, busySendModeOverride ? { busySendModeOverride } : undefined)
  }

  async function handleStopWorkClick() {
    if (stoppingWork) return
    stoppingWork = true
    try {
      await onStopWork()
    } finally {
      stoppingWork = false
    }
  }

  function handleClippedItemsChange(nextClips: ComposerClip[]) {
    composerClippedItems = nextClips
    onClippedItemsChange(nextClips.map((clip) => ({ ...clip })))
  }

  async function detachComposerClip(clipId: string) {
    if (!clipsManager?.detachClipById) return
    await clipsManager.detachClipById(clipId)
  }

  async function toggleComposerClipUseOnce(clip: ComposerClip) {
    if (!clipsManager?.setClipOneTime) return
    const isOneTime = (clip.messagesUntilUnclip ?? clip.unclipAfter ?? null) === 1
    await clipsManager.setClipOneTime(clip.id, !isOneTime)
  }
  
  function syncMentionState() {
    if (!textarea) return
    const caretIndex = textarea.selectionStart ?? message.length
    const active = getActiveMention(message, caretIndex)
    if (!active) {
      mentionOpen = false
      mentionQuery = ''
      mentionStart = null
      mentionHighlightIndex = 0
      return
    }

    const nextQuery = active.query
    const nextStart = active.start
    const shouldReset = nextQuery !== mentionQuery || nextStart !== mentionStart

    mentionOpen = true
    mentionQuery = nextQuery
    mentionStart = nextStart
    if (shouldReset) {
      mentionHighlightIndex = 0
    }
  }

  function syncComposerState() {
    syncMentionState()
    syncSlashState()
  }

  function handleMentionSelect(entry: { path: string }) {
    if (mentionStart === null || !textarea) return
    const afterStart = message.slice(mentionStart + 1)
    const match = afterStart.match(/^[A-Za-z0-9_./-]*/)
    const mentionEnd = mentionStart + 1 + (match ? match[0].length : 0)
    const before = message.slice(0, mentionStart)
    const after = message.slice(mentionEnd)
    const spacerAfter = /^\s/.test(after) ? '' : ' '
    const updated = `${before}@${entry.path}${spacerAfter}${after}`
    setComposerMessage(updated)
    mentionOpen = false
    mentionQuery = ''
    mentionStart = null
    mentionHighlightIndex = 0

    requestAnimationFrame(() => {
      if (!textarea) return
      const nextCaret = before.length + entry.path.length + 1 + spacerAfter.length
      textarea.focus()
      textarea.setSelectionRange(nextCaret, nextCaret)
      autoResize()
    })
  }

  function insertMentionAtCaret(path: string) {
    if (!textarea) {
      const spacerBefore = message.endsWith(' ') || message.length === 0 ? '' : ' '
      setComposerMessage(`${message}${spacerBefore}@${path} `)
      mentionOpen = false
      mentionQuery = ''
      mentionStart = null
      mentionHighlightIndex = 0
      return
    }
    const caretIndex = textarea.selectionStart ?? message.length
    const before = message.slice(0, caretIndex)
    const after = message.slice(caretIndex)
    const spacerBefore = before && !before.endsWith(' ') ? ' ' : ''
    const spacerAfter = /^\s/.test(after) ? '' : ' '
    setComposerMessage(`${before}${spacerBefore}@${path}${spacerAfter}${after}`)
    mentionOpen = false
    mentionQuery = ''
    mentionStart = null
    mentionHighlightIndex = 0
    requestAnimationFrame(() => {
      if (!textarea) return
      const nextCaret = before.length + spacerBefore.length + path.length + 1 + spacerAfter.length
      textarea.focus()
      textarea.setSelectionRange(nextCaret, nextCaret)
      autoResize()
    })
  }

  function handleKeydown(e: KeyboardEvent) {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        if (slashOptions.length === 0) return
        e.preventDefault()
        slashHighlightIndex = Math.min(slashHighlightIndex + 1, slashOptions.length - 1)
        return
      }
      if (e.key === 'ArrowUp') {
        if (slashOptions.length === 0) return
        e.preventDefault()
        slashHighlightIndex = Math.max(slashHighlightIndex - 1, 0)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        slashOpen = false
        slashQuery = ''
        slashStart = null
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        if (slashOptions.length > 0) {
          e.preventDefault()
          handleSlashSelect(slashOptions[slashHighlightIndex] ?? slashOptions[0])
          return
        }
      }
    }

    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        if (mentionOptions.length === 0) return
        e.preventDefault()
        mentionHighlightIndex = Math.min(mentionHighlightIndex + 1, mentionOptions.length - 1)
        return
      }
      if (e.key === 'ArrowUp') {
        if (mentionOptions.length === 0) return
        e.preventDefault()
        mentionHighlightIndex = Math.max(mentionHighlightIndex - 1, 0)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        mentionOpen = false
        mentionQuery = ''
        mentionStart = null
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        if (mentionOptions.length > 0) {
          e.preventDefault()
          handleMentionSelect(mentionOptions[mentionHighlightIndex] ?? mentionOptions[0])
          return
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // SA-119 P2 (DL-119-02): while the agent is busy BOTH keys answer from the same rule
      // the badges draw themselves from — Enter does `enter`, Cmd/Ctrl+Enter does `other`.
      // The mode is passed EXPLICITLY rather than left for the page to re-derive, because
      // the composer is the only place that knows what is in the box; the page recomputes
      // the same answer from the metadata only when no key gave it one (a voice send).
      const busyMode = (e.metaKey || e.ctrlKey) ? busySendActions.other : busySendActions.enter
      handleSend(composerBusy ? busyMode : null)
    }
  }

  function handlePaste(e: ClipboardEvent) {
    if (!textarea) return
    const text = e.clipboardData?.getData('text')
    if (!text) return
    const normalized = text.replace(/`@([A-Za-z0-9_./-]+)`/g, '@$1')
    if (normalized === text) return

    e.preventDefault()
    const start = textarea.selectionStart ?? message.length
    const end = textarea.selectionEnd ?? message.length
    const before = message.slice(0, start)
    const after = message.slice(end)
    setComposerMessage(`${before}${normalized}${after}`)

    requestAnimationFrame(() => {
      if (!textarea) return
      const nextCaret = before.length + normalized.length
      textarea.setSelectionRange(nextCaret, nextCaret)
      autoResize()
      syncMentionState()
      syncSlashState()
    })
  }

  function handleInput() {
    composerDraftRevision += 1
    if (!message.trim()) {
      composerHasSttTranscript = false
    }
    autoResize()
    syncMentionState()
    syncSlashState()
  }

  // Auto-resize textarea
  function getComposerMaxHeight() {
    if (typeof window === 'undefined') return 200
    return Math.max(200, Math.floor(window.innerHeight * COMPOSER_MAX_VIEWPORT_RATIO))
  }

  function autoResize() {
    if (!textarea) return
    textarea.style.height = 'auto'
    const maxHeight = getComposerMaxHeight()
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }

  function scheduleAutoResize() {
    if (autoResizeQueued) return
    autoResizeQueued = true
    void tick().then(() => {
      autoResizeQueued = false
      autoResize()
    })
  }

  $effect(() => {
    message
    scheduleAutoResize()
  })

  function handleTextareaScroll() {
    if (!textarea || !highlightLayer) return
    highlightLayer.scrollTop = textarea.scrollTop
    highlightLayer.scrollLeft = textarea.scrollLeft
  }

  $effect(() => {
    if (!mentionOpen || mentionOptions.length === 0) {
      mentionHighlightIndex = 0
      return
    }
    if (mentionHighlightIndex >= mentionOptions.length) {
      mentionHighlightIndex = 0
    }
  })

  $effect(() => {
    if (!slashOpen || slashOptions.length === 0) {
      slashHighlightIndex = 0
      return
    }
    if (slashHighlightIndex >= slashOptions.length) {
      slashHighlightIndex = 0
    }
  })

  async function uploadMentionFiles(targets: MentionMatch[]) {
    if (!uploadProjectRootPath || targets.length === 0) return
    for (const mention of targets) {
      try {
        await uploadProjectFile(mention.path)
      } catch (error) {
        console.error('Failed to upload mention file', error)
      }
    }
  }

  async function uploadProjectFile(relativePath: string) {
    if (!uploadProjectRootPath) {
      toast.error('Select a project or set an agent Default Project before uploading files')
      return
    }
    try {
      const response = await fetch('/api/projects/upload-from-tree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: uploadProjectRootPath,
          relativePath,
          sessionId
        })
      })
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`)
      }
      const result = await response.json()
      if (result?.clip) {
        window.dispatchEvent(
          new CustomEvent('batshit:clip-uploaded', {
            detail: {
              clip: result.clip,
              autoClip: true,
              sessionId: sessionId
            }
          })
        )
        toast.success(`Uploaded ${result.clip.filename}`)
      }
    } catch (error) {
      console.error('Upload failed', error)
      toast.error('Failed to upload file')
    }
  }

  onMount(() => {
    desktopControlsVoiceOwner = desktopControlsVoiceCoordinator.attachOwner({
      initialState: desktopControlsVoiceOwnerState,
      handleIntent: async (intent) => {
        if (intent.type === 'end') {
          handleVoiceSessionEndClick()
          return
        }
        await handleVoiceModeButtonClick()
      }
    })
    void loadDefaultWorkspacePreference()
    void loadProjectsForContext()

    const handleInsert = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string }
      if (!detail?.path) return
      insertMentionAtCaret(detail.path)
    }
    const handleUpload = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string }
      if (!detail?.path) return
      uploadProjectFile(detail.path)
    }
    const handleProjectPreferencesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ defaultWorkspacePath?: string | null }>).detail
      projectStore.setDefaultProjectPath(detail?.defaultWorkspacePath ?? null)
    }
    const handlePrefillChatInput = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; mode?: 'replace' | 'append' }>).detail
      const rawText = typeof detail?.text === 'string' ? detail.text : ''
      const normalized = rawText.trim()
      if (!normalized) return

      const mode = detail?.mode === 'append' ? 'append' : 'replace'
      if (mode === 'append' && message.trim().length > 0) {
        setComposerMessage(`${message.trimEnd()}\n\n${normalized}`)
      } else {
        setComposerMessage(normalized)
      }

      requestAnimationFrame(() => {
        if (!textarea) return
        textarea.focus()
        const caret = message.length
        textarea.setSelectionRange(caret, caret)
        autoResize()
        syncMentionState()
        syncSlashState()
      })
    }
    const handleVoiceModeEnded = () => {
      endDirectVoiceMode({ notify: false })
    }
    const handleVoiceInputActivity = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; active?: boolean }>).detail
      if (detail?.active === false) return
      if (
        detail?.source !== 'voice-mode' &&
        detail?.source !== 'livekit' &&
        detail?.source !== 'dictation'
      ) {
        return
      }
      handleVoiceModeInputActivity(detail.source)
    }
    const handleVoiceEnginesUpdated = () => {
      voiceProviderSummaryCache = null
    }
    const handleSlashCommandsUpdated = () => {
      void loadSlashCommands()
    }
    const handleViewportResize = () => autoResize()

    window.addEventListener('batshit:insert-project-mention', handleInsert as EventListener)
    window.addEventListener('batshit:upload-project-file', handleUpload as EventListener)
    window.addEventListener(
      LIVE_SETTINGS_EVENTS.projectPreferencesUpdated,
      handleProjectPreferencesUpdated as EventListener
    )
    window.addEventListener('batshit:prefill-chat-input', handlePrefillChatInput as EventListener)
    window.addEventListener('batshit:voice-mode-end', handleVoiceModeEnded as EventListener)
    window.addEventListener('batshit:voice-input-activity', handleVoiceInputActivity as EventListener)
    window.addEventListener(VOICE_ENGINES_UPDATED_EVENT, handleVoiceEnginesUpdated)
    window.addEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, handleSlashCommandsUpdated)
    window.addEventListener('resize', handleViewportResize)

    return () => {
      window.removeEventListener('batshit:insert-project-mention', handleInsert as EventListener)
      window.removeEventListener('batshit:upload-project-file', handleUpload as EventListener)
      window.removeEventListener(
        LIVE_SETTINGS_EVENTS.projectPreferencesUpdated,
        handleProjectPreferencesUpdated as EventListener
      )
      window.removeEventListener('batshit:prefill-chat-input', handlePrefillChatInput as EventListener)
      window.removeEventListener('batshit:voice-mode-end', handleVoiceModeEnded as EventListener)
      window.removeEventListener(
        'batshit:voice-input-activity',
        handleVoiceInputActivity as EventListener
      )
      window.removeEventListener(VOICE_ENGINES_UPDATED_EVENT, handleVoiceEnginesUpdated)
      window.removeEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, handleSlashCommandsUpdated)
      window.removeEventListener('resize', handleViewportResize)
      resetVoiceModeActivityFeedback()
      disconnectLiveKitVoiceRoom()
      desktopControlsVoiceOwner?.detach()
      desktopControlsVoiceOwner = null
      invalidatePendingVoiceQuickActionCommit()
    }
  })
  
  // File upload now handled through ClipsManager
  // function handleFileUpload() {
  //   fileInput?.click()
  // }
  
  async function handleNativeBashModeSelect(mode: NativeBashAccessMode) {
    if (!currentAgent) return
    // BL-833, BL-841: only the nativeTools fields this control changes (the mode, the command
    // location it moves, the retired legacy alias); the server writes nativeTools field by
    // field, so a never-allow list or web search choice saved elsewhere since stays.
    const change = chatBarWorkModeSave(currentAgent.provider_specific_settings, mode)
    // BL-2048: whether Refreshed File Reads can run reads the agent's Bash mode and command
    // location, so a landed save that moves either asks every open chat's badge facts again
    // (this save's own result, not the store's copy, which a later pick may already hold).
    const movesRefreshInputs = refreshedFileReadsRecordInputs(currentAgent) !== refreshedFileReadsRecordInputs({
      agentType: currentAgent.agentType,
      provider_specific_settings: applyAgentProviderSettingsUpdate(currentAgent.provider_specific_settings, change)
    })
    try {
      await agentStore.updateAgentSettings(currentAgent.id, { provider_specific_settings: change })
      if (movesRefreshInputs) void refreshAllDeadCopies()
    } catch (error) {
      console.error('Failed to update bash mode', error)
      toast.error('Could not save bash mode')
    }
  }
  
  // removeFile function removed - files now handled through ClipsManager
  
  // Drag and drop handlers
  function handleDragOver(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    isDragging = true
    dragMode = 'upload'
    dragMentionPath = null

    const payloadRaw = e.dataTransfer?.getData('application/x-batshit-project-file')
    if (payloadRaw) {
      try {
        const payload = JSON.parse(payloadRaw) as { relativePath?: string; mode?: string }
        if (payload.mode === 'mention') {
          dragMode = 'mention'
          dragMentionPath = payload.relativePath ?? null
        }
      } catch {
        dragMode = 'upload'
      }
    }
  }
  
  function handleDragLeave(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    
    // Only set isDragging to false if we're leaving the main container
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY
    
    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      isDragging = false
      dragMode = 'upload'
      dragMentionPath = null
    }
  }
  
  async function handleDrop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    isDragging = false
    dragMode = 'upload'
    dragMentionPath = null
    
    const customData = e.dataTransfer?.getData('application/x-batshit-project-file')
    if (customData) {
      try {
        const payload = JSON.parse(customData) as { relativePath?: string; mode?: string }
        if (payload.relativePath) {
          if (payload.mode === 'mention') {
            insertMentionAtCaret(payload.relativePath)
          } else {
            uploadProjectFile(payload.relativePath)
          }
          return
        }
      } catch (error) {
        console.error('Invalid project file drag payload', error)
      }
    }

    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      if (clipsManager?.uploadFiles) {
        await clipsManager.uploadFiles(Array.from(e.dataTransfer.files))
      } else {
        toast.error('Clip uploader not ready yet')
      }
    }
  }
  
  function cleanTranscript(value: string): string {
    return cleanSpeechTranscript(value)
  }

  function appendTranscript(base: string, next: string): string {
    const cleanedBase = base.trimEnd()
    const cleanedNext = cleanTranscript(next)
    if (!cleanedBase) return cleanedNext
    if (!cleanedNext) return cleanedBase
    return `${cleanedBase} ${cleanedNext}`.trim()
  }

  function stripDictationPreview(current: string, previousTranscript: string): string {
    const cleanedPrevious = cleanTranscript(previousTranscript)
    if (!cleanedPrevious) return current

    const trimmedCurrent = current.trimEnd()
    if (!trimmedCurrent.endsWith(cleanedPrevious)) return current
    return trimmedCurrent.slice(0, trimmedCurrent.length - cleanedPrevious.length).trimEnd()
  }

  function mergeDictationTranscript(transcript: string): string {
    const liveBase = stripDictationPreview(message || dictationBaseMessage, dictationPreviewTranscript)
    dictationBaseMessage = liveBase
    dictationPreviewTranscript = transcript
    if (transcript.trim()) {
      composerHasSttTranscript = true
    }
    return appendTranscript(liveBase, transcript)
  }

  function clearVoiceModeSendTimer() {
    if (voiceModeSendTimer) {
      clearTimeout(voiceModeSendTimer)
      voiceModeSendTimer = null
    }
    voiceModeTurnSendPending = false
  }

  function clearRecordedVoiceModeAutoStopTimer() {
    if (!recordedVoiceModeAutoStopTimer) return
    clearTimeout(recordedVoiceModeAutoStopTimer)
    recordedVoiceModeAutoStopTimer = null
  }

  function clearVoiceModeActivityPreviewTimer() {
    if (!voiceModeActivityPreviewTimer) return
    clearTimeout(voiceModeActivityPreviewTimer)
    voiceModeActivityPreviewTimer = null
  }

  function resetVoiceModeActivityFeedback() {
    clearRecordedVoiceModeAutoStopTimer()
    clearVoiceModeActivityPreviewTimer()
    recordedVoiceModeSpeechSeen = false
    voiceModeActivityPreviewActive = false
  }

  function resetVoiceModeTranscriptBuffer() {
    clearVoiceModeSendTimer()
    resetVoiceModeActivityFeedback()
    recordedVoiceModeCaptureFinalizing = false
    voiceModeCommittedTranscript = ''
  }

  function markVoiceModeActivityPreview() {
    voiceModeActivityPreviewActive = true
    clearVoiceModeActivityPreviewTimer()
    voiceModeActivityPreviewTimer = setTimeout(() => {
      voiceModeActivityPreviewTimer = null
      voiceModeActivityPreviewActive = false
    }, 500)
  }

  function handleVoiceModeInputActivity(source?: string) {
    const isDictationActivity =
      source === 'dictation' && !isVoiceMode && dictationActivityPreviewPending
    if (!voiceModeSessionPillActive && source !== 'voice-mode' && !isDictationActivity) return
    markVoiceModeActivityPreview()

    if (isDictationActivity) return
    if (voiceModeInputKind !== 'recorded' || !isListening || source === 'livekit') return
    recordedVoiceModeSpeechSeen = true

    if (recordedVoiceModeTapToTalk || waitingForAI || voiceModeTurnSendPending) return

    clearRecordedVoiceModeAutoStopTimer()
    const delayMs = voiceModeTurnSettings?.autoSubmitDelayMs ?? 1000
    recordedVoiceModeAutoStopTimer = setTimeout(() => {
      recordedVoiceModeAutoStopTimer = null
      if (
        !isVoiceMode ||
        voiceModeInputKind !== 'recorded' ||
        recordedVoiceModeTapToTalk ||
        !isListening ||
        waitingForAI ||
        voiceModeTurnSendPending ||
        !recordedVoiceModeSpeechSeen
      ) {
        return
      }

      voiceService.stopListening()
      isListening = false
      recordedVoiceModeCaptureFinalizing = true
      voiceModeActivityPreviewActive = false
    }, delayMs)
  }

  function scheduleVoiceModeSend(provider?: VoiceInputConfig['provider']) {
    clearVoiceModeSendTimer()
    const turnSettings = getVoiceModeTurnSettings()
    const isRecordedTurn = voiceModeInputKind === 'recorded'
    const delayMs =
      isRecordedTurn || (provider && provider !== 'browser')
        ? 0
        : turnSettings?.autoSubmitDelayMs ?? 1000
    voiceModeTurnSendPending = true

    voiceModeSendTimer = setTimeout(() => {
      voiceModeSendTimer = null
      if (!isVoiceMode || waitingForAI) {
        voiceModeTurnSendPending = false
        return
      }
      const finalMessage = cleanTranscript(message)
      if (!finalMessage) {
        voiceModeTurnSendPending = false
        return
      }
      waitingForAI = true
      voiceModeTurnSendPending = false
      voiceModeCommittedTranscript = ''
      setComposerMessage(finalMessage)
      void commitVoiceModeTurn(finalMessage)
    }, delayMs)
  }

  /**
   * SA-120 P9: the one place a spoken turn is committed. With Quick Actions on, Batshit first
   * asks whether the turn is a small request to the app itself; if so it acts at once and,
   * when that was the whole turn, sends nothing to the agent. Any failure or slowness in the
   * check means "no quick action": the turn is sent exactly as it always was.
   */
  async function commitVoiceModeTurn(finalMessage: string) {
    const draftRevision = composerDraftRevision
    const capturedVoiceCapture = directVoiceCapture
    const capturedVoiceActorKey = directVoiceCaptureContextKey
    const pending = voiceQuickActionCommits.begin(currentVoiceQuickActionContext())
    const replyWait = createVoiceQueuedReplyWait({
      coordinator: voiceQuickActionCommits, token: pending, currentContext: currentVoiceQuickActionContext,
      releaseWaiting: () => { waitingForAI = false }
    })
    voiceQueuedReplyWait = replyWait
    // P9b: with a wake word required (the default, "Yo"), a turn that does not start with it is
    // never judged: no Jev call, no wait. Jev sees the words after the wake word.
    const gate = quickActionsEnabled() ? resolveQuickActionWakeGate(finalMessage, quickActionVoiceModeSettings()) : null
    const snapshotStillOwnsComposer = () =>
      composerDraftRevision === draftRevision &&
      voiceQuickActionCommits.ownsLatestGeneration(pending) &&
      voiceQuickActionSnapshotMatches(
        pending.context,
        currentVoiceQuickActionContext(),
        finalMessage,
        message
      )

    try {
      await runVoiceQuickActionCommit<QuickActionVerdict, QuickActionMark>({
        coordinator: voiceQuickActionCommits,
        token: pending,
        currentContext: currentVoiceQuickActionContext,
        requestVerdict: () => gate
          ? requestQuickActionVerdict(gate.said, finalMessage, pending)
          : Promise.resolve(null),
        decide: (verdict) => {
          const mark = verdict?.action ? quickActionMarkOf(verdict) : null
          return { mark, onlyThis: Boolean(verdict?.onlyThis && mark) }
        },
        applyAction: (verdict, mark) => {
          runQuickAction(verdict)
          toast.info(quickActionToastText(mark))
        },
        persistOnly: async (mark) => {
          // A live-transcript lane may already have printed the user's NEXT words while Jev
          // was deciding. Persist first so a storage failure leaves the words recoverable, then
          // clear only the captured generation and snapshot that were actually stored.
          try {
            await onQuickActionMessage(finalMessage, mark)
          } catch (error) {
            const current = currentVoiceQuickActionContext()
            const ownsVoice = composerDraftRevision === draftRevision &&
              directVoiceCapture === capturedVoiceCapture &&
              voiceQuickActionCommits.ownsLatestGeneration(pending) &&
              pending.context.sessionId === current.sessionId && pending.context.agentId === current.agentId &&
              pending.context.voiceLifetimeKey === current.voiceLifetimeKey
            if (ownsVoice) endDirectVoiceMode({ notify: false })
            toast.error(ownsVoice
              ? 'The voice action ran, but its words were not confirmed saved. Voice Mode is paused; your composer was not cleared.'
              : 'The voice action ran, but its words were not confirmed saved. Your composer was not cleared.')
            throw error
          }
          if (snapshotStillOwnsComposer()) setComposerMessage('')
        },
        send: async (mark, beforeSend) => {
          try {
            const accepted = await sendMessageWithText(finalMessage, {
              stt: true,
              tts: true,
              quickAction: mark,
              composerSessionId: pending.context.sessionId,
              beforeSend,
              mayResetComposer: snapshotStillOwnsComposer,
              onNoReplyCompleted: createVoiceNoReplyCompletion({
                coordinator: voiceQuickActionCommits, token: pending, currentContext: currentVoiceQuickActionContext,
                releaseWaiting: () => { waitingForAI = false }
              }),
              onComposerSessionCreated: ({ sessionId: createdId, agentId }) => {
                if (agentId !== pending.context.agentId ||
                  !voiceQuickActionCommits.adoptCreatedSession(pending, currentVoiceQuickActionContext(), createdId)) return false
                if (directVoiceCapture === capturedVoiceCapture && capturedVoiceCapture?.contextKey === capturedVoiceActorKey) {
                  capturedVoiceCapture.contextKey = JSON.stringify([createdId, agentId, currentAgent?.created_at ?? null])
                }
                return true
              },
              onReplyAdmitted: replyWait.onReplyAdmitted,
              onSteerPrepared: replyWait.onSteerPrepared
            })
            if (accepted) replyWait.finishSend()
            else replyWait.abandonSend()
            return accepted
          } catch (error) {
            replyWait.abandonSend()
            throw error
          }
        },
        releasePending: () => {
          waitingForAI = false
        }
      })
    } catch (error) {
      console.error('[Judge Juice] could not commit the voice turn:', error)
    }
  }

  /** The switch and the wake word are global (LS-060): read from the user's voice settings, never from an agent profile. */
  function quickActionVoiceModeSettings() {
    return normalizeVoiceSettings(getUserSettings()?.voice_settings).voiceMode
  }
  function quickActionsEnabled(): boolean {
    return resolveJevQuickActionsEnabled(quickActionVoiceModeSettings())
  }

  async function requestQuickActionVerdict(
    said: string,
    spoken: string,
    pending: VoiceQuickActionCommitToken
  ): Promise<QuickActionVerdict | null> {
    try {
      const response = await fetch('/api/jev-juice/quick-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          said,
          spoken,
          sessionId: pending.context.sessionId,
          agentId: pending.context.agentId
        }),
        signal: pending.signal
      })
      if (!response.ok) return null
      return readQuickActionVerdict(await response.json().catch(() => null))
    } catch (error) {
      if (!pending.signal.aborted) {
        console.warn('[Judge Juice] quick-action check failed; the turn is sent as usual:', error)
      }
      return null
    }
  }

  /** The fixed speech projection shares action names while retaining each current click owner. */
  function runQuickAction(verdict: QuickActionVerdict) {
    executeVoiceQuickAction(verdict, {
      stopPlayback: () => voiceService.stopAll(),
      workBusy: () => workBusy,
      requestWorkStop: () => { void handleStopWorkClick() },
      endVoiceMode: options => endDirectVoiceMode(options),
      openExecutionViewer: () => onOpenExecutionViewer(sessionId),
      openSettings: selectedTab => {
        const tab = quickActionSettingsTabTarget(selectedTab)
        window.dispatchEvent(new CustomEvent('batshit:open-settings', { detail: tab ? { tab } : {} }))
      },
      requestDock: id => window.dispatchEvent(new CustomEvent(QUICK_ACTION_EVENT, { detail: { id } }))
    })
  }

  // Handle mic button (manual dictation STT)
  function handleMicClick() {
    if (isListening || waitingForAI) {
      if (isListening) {
        voiceService.stopListening()
        isListening = false
      }
      return
    }

    isListening = true
    interimTranscript = ''
    dictationBaseMessage = message
    dictationPreviewTranscript = ''
    const transcribeSttConfig = getCurrentAgentSttConfig('transcribe')
    const transcribeSttProvider = getEffectiveTranscribeSttProvider(transcribeSttConfig)
    const dictationShowsLiveTranscript = transcribeSttProvider === 'browser'
    dictationLiveTranscriptVisible = dictationShowsLiveTranscript
    dictationActivityPreviewPending = !dictationShowsLiveTranscript
    if (!dictationShowsLiveTranscript) {
      markVoiceModeActivityPreview()
    }

    const handleDictationInterim = dictationShowsLiveTranscript
      ? (interim: string) => {
          const transcript = cleanTranscript(interim)
          if (transcript) {
            interimTranscript = transcript
            setComposerMessage(mergeDictationTranscript(transcript))
          }
        }
      : undefined

    const pendingDictation = voiceService.startListening(
      // Final result callback: fill the composer, never auto-send.
      (text) => {
        const transcript = cleanTranscript(text)
        if (transcript) {
          setComposerMessage(mergeDictationTranscript(transcript))
        }
      },
      handleDictationInterim,
      transcribeSttConfig
    )

    const trackedDictation = pendingDictation
      .catch((error) => {
        console.error('Voice recognition error:', error)
        const errorMessage =
          error instanceof Error ? error.message : 'Voice recognition failed'
        toast.error(errorMessage)
      })
      .finally(() => {
        if (dictationPromise === trackedDictation) {
          dictationPromise = null
        }
        isListening = false
        interimTranscript = ''
        dictationActivityPreviewPending = false
        dictationLiveTranscriptVisible = false
        dictationBaseMessage = ''
        dictationPreviewTranscript = ''
      })
    dictationPromise = trackedDictation
  }

  async function startDirectTextInputVoiceMode() {
    voiceService.stopListening()
    resetVoiceModeTranscriptBuffer()
    recordedVoiceModeAutoStartInFlight = false
    recordedVoiceModeCaptureFinalizing = false
    isVoiceMode = true
    isListening = false
    voiceModeInputKind = 'text'
    voiceMode = true
    onVoiceModeChange(true)
    toast.success('Text Input Voice Mode enabled. Replies will be spoken.')
    await tick()
    textarea?.focus()
  }
  
  // Handle Voice Mode button (continuous or recorded-turn STT/TTS)
  async function handlePhoneClick() {
    if (isVoiceMode) {
      if (voiceReplyActive) {
        voiceService.stopAll()
        toast.success('Stopped spoken reply')
        return
      }

      if (voiceModeInputKind === 'recorded') {
        if (isListening) {
          voiceService.stopListening()
          isListening = false
          resetVoiceModeActivityFeedback()
          recordedVoiceModeCaptureFinalizing = true
          toast.success('Voice turn captured')
          return
        }

        if (!waitingForAI) {
          await startDirectVoiceModeCapture()
          return
        }
      }

      toast.info('Voice Mode is on. Use End to leave Voice Mode.')
    } else if (!waitingForAI) {
      if (voiceModeTextInputSelected) {
        await startDirectTextInputVoiceMode()
        return
      }
      await startDirectVoiceModeCapture()
    }
  }

  async function startDirectVoiceModeCapture(options: { announce?: boolean } = {}) {
    const capture = { contextKey: directVoiceCaptureContextKey }
    directVoiceCapture = capture
    const ownsCapture = () => directVoiceCapture === capture && isVoiceMode &&
      capture.contextKey === directVoiceCaptureContextKey
    try {
      const wasVoiceModeActive = isVoiceMode
      isVoiceMode = true
      isListening = true
      voiceMode = true
      onVoiceModeChange(true)
      voiceModeCommittedTranscript = message.trim()
      recordedVoiceModeCaptureFinalizing = false
      resetVoiceModeActivityFeedback()
      const realtimeSttConfig = getCurrentAgentSttConfig('realtime')
      const voiceModeSttProvider = getEffectiveVoiceModeSttProvider(realtimeSttConfig)
      const continuous = await usesContinuousVoiceModeStt(voiceModeSttProvider)
      if (!ownsCapture()) return
      voiceModeInputKind = continuous ? 'continuous' : 'recorded'
      if (options.announce !== false && !wasVoiceModeActive) {
        toast.success(
          voiceModeInputKind === 'recorded'
            ? recordedVoiceModeTapToTalk
              ? 'Manual Turn Voice Mode enabled. Stop the turn to send.'
              : 'Auto Listen Voice Mode enabled.'
            : 'Continuous Voice Mode enabled. Responses will be spoken.'
        )
      }

      await voiceService.startVoiceMode(
        // Final result callback
        (text) => {
          if (ownsCapture() && text.trim() && !waitingForAI) {
            recordedVoiceModeCaptureFinalizing = false
            resetVoiceModeActivityFeedback()
            voiceModeCommittedTranscript = appendTranscript(voiceModeCommittedTranscript, text)
            setComposerMessage(voiceModeCommittedTranscript)
            scheduleVoiceModeSend(voiceModeSttProvider)
          }
        },
        // Interim result callback
        (interim) => {
          if (!ownsCapture() || voiceModeInputKind === 'recorded') {
            return
          }

          if (!waitingForAI) {
            clearVoiceModeSendTimer()
            const interimText = cleanTranscript(interim)
            setComposerMessage(appendTranscript(voiceModeCommittedTranscript, interimText))
          }
        },
        realtimeSttConfig
      )

      if (!ownsCapture()) return
      if (voiceModeInputKind === 'recorded') {
        isListening = false
        recordedVoiceModeCaptureFinalizing = false
      }
    } catch (error) {
      if (!ownsCapture()) return
      console.error('Voice mode error:', error)
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to enable voice mode'
      toast.error(errorMessage)
      isVoiceMode = false
      isListening = false
      voiceModeInputKind = null
      voiceMode = false
      recordedVoiceModeAutoStartInFlight = false
      recordedVoiceModeCaptureFinalizing = false
      resetVoiceModeTranscriptBuffer()
      onVoiceModeChange(false)
    }
  }

  $effect(() => {
    if (
      useLiveKitVoiceButton ||
      !isVoiceMode ||
      voiceModeInputKind !== 'recorded' ||
      recordedVoiceModeTapToTalk ||
      isListening ||
      waitingForAI ||
      recordedVoiceModeCaptureFinalizing ||
      voiceModeTurnSendPending ||
      voiceReplyActive ||
      recordedVoiceModeAutoStartInFlight
    ) {
      return
    }

    const timer = setTimeout(() => {
      if (
        useLiveKitVoiceButton ||
        !isVoiceMode ||
        voiceModeInputKind !== 'recorded' ||
        recordedVoiceModeTapToTalk ||
        isListening ||
        waitingForAI ||
        recordedVoiceModeCaptureFinalizing ||
        voiceModeTurnSendPending ||
        voiceReplyActive ||
        recordedVoiceModeAutoStartInFlight
      ) {
        return
      }

      recordedVoiceModeAutoStartInFlight = true
      void startDirectVoiceModeCapture({ announce: false }).finally(() => {
        recordedVoiceModeAutoStartInFlight = false
      })
    }, 300)

    return () => clearTimeout(timer)
  })
  
  // Reset waiting state when we receive a response
  $effect(() => {
    // This should be connected to when AI finishes responding
    // For now, we'll expose a method that the parent can call
    return () => {
      waitingForAI = false
    }
  })
  
  // Exact server receipt/answer observations stay local to the captured Voice owner.
  export function observeVoiceReply(observation: import('$lib/utils/voiceQuickActionCommit').VoiceReplyObservation) {
    voiceQueuedReplyWait?.observeReply(observation)
  }

  export function voiceSteerTargetStopped(sessionId: string, messageId: string) {
    voiceQueuedReplyWait?.onTargetStopped(sessionId, messageId)
  }

  // Expose method to reset waiting state
  export function aiResponseReceived() {
    if (voiceQueuedReplyWait?.holdGenericReplyCompletion()) return
    waitingForAI = false
  }
</script>

<!-- File input now handled through ClipsManager component -->

<div 
  class="chat-input-root"
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  role="region"
  aria-label="Chat input with file upload"
>
  <ChatDragOverlay {isDragging} {dragMode} {dragMentionPath} />
  
  <div class="chat-composer-shell">
    <!-- Files now displayed in ClipsManager -->
    
    <!-- Main input area -->
    <div class="chat-composer-main">
      <!-- Message input -->
      <div class="chat-composer-field">
        <div class="mention-input">
          <div
            class="mention-highlight-layer"
            bind:this={highlightLayer}
            aria-hidden="true"
          >
            {#each composerHighlightSegments as segment}
              {#if segment.type === 'text'}
                {segment.value}
              {:else if segment.type === 'mention' && segment.mention}
                <span
                  class={`mention-highlight mention-${segment.mention.status}`}
                  data-status={segment.mention.status}
                >
                  {segment.value}
                </span>
              {:else if segment.type === 'skill'}
                <span class="skill-inline-highlight" aria-hidden="true">{segment.value}</span>
              {:else}
                {segment.value}
              {/if}
            {/each}
          </div>
          <textarea
            bind:this={textarea}
            bind:value={message}
            onkeydown={handleKeydown}
            oninput={handleInput}
            onkeyup={syncComposerState}
            onclick={syncComposerState}
            onpaste={handlePaste}
            onscroll={handleTextareaScroll}
            placeholder={composerVoiceActivityPreviewVisible ? '' : 'Type a message...'}
            class="chat-composer-textarea"
            aria-label="Message composer"
            data-testid="message-input"
            data-ab-control="message-input"
            {disabled}
          ></textarea>

          {#if composerVoiceActivityPreviewVisible}
            <div
              class="chat-voice-activity-preview {voiceModeActivityPreviewActive ? 'is-active' : ''}"
              aria-hidden="true"
            >
              <div class="chat-voice-activity-bars">
                {#each voiceModeActivityBars as index}
                  <span style={`--voice-bar-index: ${index}`}></span>
                {/each}
              </div>
            </div>
          {/if}

          <ChatSlashAutocomplete
            options={slashOptions}
            highlightIndex={slashHighlightIndex}
            onSelect={handleSlashSelect}
          />

          <ChatMentionAutocomplete
            options={mentionOptions}
            highlightIndex={mentionHighlightIndex}
            onSelect={handleMentionSelect}
            notice={mentionIndexNotice}
          />
        </div>
      </div>
    </div>

    <ChatClipHanger
      clips={composerClippedItems}
      onDetachClip={detachComposerClip}
      onToggleUseOnce={toggleComposerClipUseOnce}
    />

    <!--
      SA-119 P2 (DL-119-03) — the two choices, visible, beside Stop.

      Stop is unchanged in place, icon and behaviour; the badges sit to its LEFT in the same
      float, so the cluster reads left to right as "what your words do" then "stop the
      reply". The one Enter will do is filled and the other is an outline, because the
      question the user is actually asking is "what does Enter do right now" — and a hover
      could not answer it (SA-118 F-25). A disabled Steer prints its reason as plain text
      beside the pair, never only in the tooltip.
    -->
    {#if workBusy}
      <div class="chat-busy-send-float" data-testid="busy-send-cluster">
        <Tooltip.Provider delayDuration={250} skipDelayDuration={0}>
          <div class="chat-busy-send-badges">
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    onclick={() => handleSend('steer')}
                    disabled={disabled || sendDisabled || !busySendActions.steer.enabled}
                    class="bs-badge chat-busy-send-badge"
                    class:is-default={busySendActions.enter === 'steer'}
                    aria-label={steerBadgeTooltip}
                    data-testid="busy-send-steer-badge"
                    data-ab-control="busy-send-steer"
                    data-busy-send-default={busySendActions.enter === 'steer' ? 'true' : 'false'}
                  >
                    Steer
                  </button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>{steerBadgeTooltip}</p>
              </Tooltip.Content>
            </Tooltip.Root>

            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    onclick={() => handleSend('queue')}
                    disabled={disabled || sendDisabled}
                    class="bs-badge chat-busy-send-badge"
                    class:is-default={busySendActions.enter === 'queue'}
                    aria-label={queueBadgeTooltip}
                    data-testid="busy-send-queue-badge"
                    data-ab-control="busy-send-queue"
                    data-busy-send-default={busySendActions.enter === 'queue' ? 'true' : 'false'}
                  >
                    Queue
                  </button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>{queueBadgeTooltip}</p>
              </Tooltip.Content>
            </Tooltip.Root>
          </div>
        </Tooltip.Provider>

        <button
          type="button"
          onclick={handleStopWorkClick}
          disabled={disabled || stoppingWork}
          class="chat-stop-work-float"
          aria-label="Stop current run"
          title="Stop current run"
          data-testid="stop-current-run-button"
          data-ab-control="stop-current-run"
        >
          <span class="chat-sr-only">Stop current run</span>
          <Square class="chat-stop-work-icon" />
        </button>
      </div>

      {#if busySendActions.steer.note}
        <p class="chat-busy-send-note" data-testid="busy-send-note">
          {busySendActions.steer.note}
        </p>
      {/if}
    {/if}

    {#if voiceModeSessionPillActive}
      <div
        class="chat-voice-session-pill {voiceModeSessionStateClass} {workBusy ? 'has-stop-work' : ''}"
        data-testid="voice-mode-session-pill"
        data-ab-control="voice-mode-session"
        aria-label={`Voice Mode active: ${voiceModeSessionLabel}, ${voiceModeSessionModeLabel}`}
      >
        <span class="chat-voice-session-dot" aria-hidden="true"></span>
        <span class="chat-voice-session-label">{voiceModeSessionLabel}</span>
        <span class="chat-voice-session-mode">{voiceModeSessionModeLabel}</span>
        <button
          type="button"
          class="chat-voice-session-end"
          onclick={handleVoiceSessionEndClick}
          aria-label="End Voice Mode"
          title="End Voice Mode"
        >
          <PhoneOff class="chat-voice-session-end-icon" />
        </button>
      </div>
    {/if}
    
    <!-- Bottom row for all buttons including send -->
    <div class="chat-bottom-row">
      <!-- Left side icons -->
      <div class="chat-bottom-cluster">
        <!-- Clips & Zips paired button -->
        <div class="chatbar-panel-pair">
          <!-- Clips Manager - handles uploads and clipping -->
          <div class="chatbar-control-slot">
            <ClipsManagerDropdown
              bind:this={clipsManager}
              {sessionId}
              pageData={data}
              onClippedItemsChange={handleClippedItemsChange}
            />
          </div>

          <!-- Divider -->
          <div class="chatbar-divider"></div>

          <!-- Zips Manager (formerly Pin Manager) - per-session -->
          <div class="chatbar-control-slot">
            <ZipsManagerDropdown {sessionId} />
          </div>
        </div>

        {#if !groupSelected}
          <!-- MCPs Dropdown -->
          <div class="chatbar-tool-shell">
            <MCPsDropdown
              userId={data?.user?.id}
              settingsData={data}
            />
          </div>
        {/if}

        {#if sessionId && showExecutionViewer}
          <div class="chatbar-tool-shell execution-viewer-button">
            <button
              class="chatbar-split-action"
              onclick={() => onOpenExecutionViewer(sessionId)}
              aria-label="Open execution viewer"
              title="View compiled execution data"
              data-testid="open-execution-viewer-button"
              data-ab-control="open-execution-viewer"
            >
              <FileText class="chatbar-icon" />
            </button>
          </div>
        {/if}
      </div>
      
      <!-- Center selectors -->
      <div class="chat-selector-cluster">
        <AgentSelector {data} />
        {#if !groupSelected}
          {#if !isRetiredPrimaryAgent}
            <ModelSelector {sessionId} {data} />
            <ModelReasoningControl />
          {/if}
          {#if bashModeSelectorVisible}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="chat-mode-selector-trigger mode-selector-trigger bash-mode-selector"
                aria-label="Work mode"
                title="Work mode"
                data-ab-control="work-mode"
              >
                {@const TriggerIcon = activeNativeBashModeOption.icon}
                <div class="mode-selector-inner">
                  <TriggerIcon class="chat-mode-selector-icon" />
                  <span class="mode-selector-label">{activeNativeBashModeOption.triggerLabel}</span>
                </div>
                <ChevronDown class="chat-mode-selector-chevron" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" class="chat-mode-menu-content">
                <DropdownMenu.Label>Switch Work Mode</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={nativeBashAccessModeActive}>
                  {#each NATIVE_BASH_MODE_OPTIONS as option}
                    <DropdownMenu.RadioItem
                      value={option.value}
                      onSelect={() => handleNativeBashModeSelect(option.value)}
                      class={getModeItemClass(option.value === nativeBashAccessModeActive)}
                    >
                      {@const OptionIcon = option.icon}
                      <OptionIcon class="chat-mode-menu-icon" />
                      <div class="chat-mode-menu-copy">
                        <span class="chat-mode-menu-title">{option.menuLabel.split('(')[0]?.trim() || option.menuLabel}</span>
                      </div>
                    </DropdownMenu.RadioItem>
                  {/each}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {/if}
        {/if}
      </div>
      
      <!-- Right side buttons -->
      <div class="chat-send-cluster">
        <!-- Mic button (one-time STT) -->
        <Button
          onclick={handleMicClick}
          disabled={disabled || waitingForAI || isVoiceMode || isLiveKitVoiceConnected || isLiveKitVoiceConnecting}
          size="icon"
          variant={isListening && !isVoiceMode ? 'default' : 'outline'}
          class="chat-input-icon-lg {isListening && !isVoiceMode ? 'is-listening' : ''}"
          aria-label={isListening && !isVoiceMode ? 'Stop dictation' : waitingForAI ? 'Voice input unavailable while waiting for AI response' : 'Voice input one message'}
          title={isListening && !isVoiceMode ? 'Stop dictation and keep text' : waitingForAI ? 'Waiting for AI response...' : 'Voice input (one message)'}
          data-testid="voice-input-once-button"
          data-ab-control="voice-input-once"
        >
          {#if isListening && !isVoiceMode}
            <Square class="chat-input-action-icon" />
          {:else}
            <Mic class="chat-input-action-icon" />
          {/if}
        </Button>
        
        <!-- Voice Mode button (continuous STT/TTS or LiveKit when selected) -->
        <Button
          onclick={handleVoiceModeButtonClick}
          disabled={useLiveKitVoiceButton ? isLiveKitVoiceConnecting || (disabled && !isLiveKitVoiceConnected) : disabled || (waitingForAI && !isVoiceMode)}
          size="icon"
          variant={voiceButtonActive ? 'default' : 'outline'}
          class="chat-input-icon-lg {directVoiceButtonStateClass} {isLiveKitVoiceConnected ? 'is-livekit-connected' : ''} {voiceButtonPulsing ? 'is-pulsing' : ''} {liveKitVoiceStatus === 'error' ? 'is-livekit-error' : ''}"
          aria-label={voiceModeButtonLabel}
          title={voiceModeButtonTitle}
          data-testid="voice-mode-toggle-button"
          data-ab-control="voice-mode-toggle"
        >
          {#if !useLiveKitVoiceButton && voiceReplyActive}
            <Pause class="chat-input-action-icon" />
          {:else if !useLiveKitVoiceButton && voiceModeInputKind === 'recorded' && isListening}
            <Square class="chat-input-action-icon" />
          {:else if !useLiveKitVoiceButton && voiceModeInputKind === 'recorded' && (recordedVoiceModeCaptureFinalizing || waitingForAI || voiceModeTurnSendPending)}
            <Loader2 class="chat-input-action-icon animate-spin" />
          {:else if !useLiveKitVoiceButton && recordedVoiceModeReadyForInput}
            <CircleDot class="chat-input-action-icon" />
          {:else}
            <AudioLines class="chat-input-action-icon" />
          {/if}
        </Button>
        
        <!--
          DL-119-03: the send icon stays and does what Enter does. Its hover text is the
          app's Tooltip, not the browser's `title` — the browser's plain one was half of
          Josh's original finding, because it looks like nothing else in Batshit and it
          cannot be styled, delayed, or read on a touch screen.
        -->
        <Tooltip.Provider delayDuration={250} skipDelayDuration={0}>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  onclick={() => handleSend(composerBusy ? busySendActions.enter : null)}
                  disabled={sendDisabled}
                  size="icon"
                  class="chat-input-icon-lg"
                  aria-label={sendButtonLabel}
                  data-testid="send-button"
                  data-busy-send-mode={composerBusy ? busySendActions.enter : undefined}
                  data-ab-control="send-message"
                >
                  <span class="chat-sr-only">{sendButtonLabel}</span>
                  {#if finalizingDictation}
                    <Loader2 class="chat-input-action-icon animate-spin" />
                  {:else}
                    <Send class="chat-input-action-icon" />
                  {/if}
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{sendButtonTooltip}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
      </div>
    </div>
  </div>
</div>

<!-- Execution viewer sheet now lives in parent (passed via onOpenExecutionViewer) -->

<style>
  .chat-input-root {
    position: relative;
  }

  .chat-composer-shell {
    position: relative;
    border: 1px solid var(--bs-app-inner-line);
    border-radius: 8px;
    background: var(--bs-app-inset-surface);
    color: var(--bs-app-text);
  }

  .chat-composer-main {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.5rem;
    padding-bottom: 40px;
  }

  .chat-composer-field {
    flex: 1 1 0;
  }

  .mention-input {
    position: relative;
  }

  .mention-highlight-layer,
  .chat-composer-textarea {
    position: relative;
    width: 100%;
    min-height: 40px;
    max-height: 50dvh;
    padding: 0.5rem 0.75rem;
    font-size: 1rem;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  @media (min-width: 768px) {
    .mention-highlight-layer,
    .chat-composer-textarea {
      font-size: 0.875rem;
    }
  }

  .mention-highlight-layer {
    position: absolute;
    inset: 0;
    color: transparent;
    pointer-events: none;
  }

  .chat-composer-textarea {
    resize: none;
    overflow-y: hidden;
    border: 0;
    background: transparent;
    color: var(--bs-app-field-text);
    outline: none;
  }

  .chat-composer-textarea:focus {
    box-shadow: none;
  }

  .chat-composer-textarea::placeholder {
    color: var(--bs-app-muted-text);
  }

  .chat-voice-activity-preview {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    padding: 0.5rem 0.85rem;
    pointer-events: none;
  }

  .chat-voice-activity-bars {
    display: flex;
    width: min(25rem, 78%);
    height: 1.8rem;
    align-items: center;
    gap: 0.11rem;
  }

  .chat-voice-activity-bars span {
    width: 0.13rem;
    min-width: 0.13rem;
    height: 0.25rem;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--bs-app-muted-text) 72%, var(--bs-app-title));
    opacity: 0.46;
    transform-origin: center;
    animation: chat-voice-activity-wave 1300ms ease-in-out infinite;
    animation-delay: calc(var(--voice-bar-index) * -48ms);
  }

  .chat-voice-activity-preview.is-active .chat-voice-activity-bars span {
    background: oklch(0.88 0.03 185);
    opacity: 0.92;
    animation-duration: 740ms;
  }

  .chat-voice-activity-bars span:nth-child(4n + 1) {
    height: 0.62rem;
  }

  .chat-voice-activity-bars span:nth-child(4n + 2) {
    height: 1.35rem;
  }

  .chat-voice-activity-bars span:nth-child(4n + 3) {
    height: 0.95rem;
  }

  @keyframes chat-voice-activity-wave {
    0%,
    100% {
      transform: scaleY(0.42);
    }

    35% {
      transform: scaleY(1);
    }

    65% {
      transform: scaleY(0.58);
    }
  }

  .chat-mode-menu-description {
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
  }

  .chat-bottom-row {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding-inline: 0.5rem;
    overflow: visible;
  }

  .chat-bottom-cluster,
  .chat-selector-cluster,
  .chat-send-cluster {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .chat-bottom-cluster,
  .chat-send-cluster {
    flex: 0 0 auto;
  }

  .chat-selector-cluster {
    min-width: 0;
    flex: 1 1 auto;
    justify-content: center;
  }

  /*
   * SA-119 P2 (DL-119-03) — the busy cluster.
   *
   * Stop kept its exact float (`right: 0.55rem; bottom: 3.15rem`); the cluster took the
   * position over so the two badges could sit beside it without either moving. Stop itself
   * is unchanged in size, colour and behaviour — only its `position` moved from the button
   * to its parent, because two absolutely-positioned siblings would stack on each other.
   */
  .chat-busy-send-float {
    position: absolute;
    right: 0.55rem;
    bottom: 3.15rem;
    z-index: 8;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .chat-busy-send-badges {
    /* The documented override hook on `.bs-badge`: 24px so a text badge stays a real tap
     * target beside a 2.15rem button, without inventing a second badge size. */
    --bs-badge-height: 1.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .chat-busy-send-badge {
    border-color: var(--bs-app-field-line);
    background: var(--bs-app-field);
    color: var(--bs-app-muted-text);
    cursor: pointer;
  }

  .chat-busy-send-badge:hover:not(:disabled) {
    border-color: var(--bs-app-field-line-hover);
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  /* Filled = the one plain Enter will do. Outline = the one Cmd/Ctrl+Enter will do. */
  .chat-busy-send-badge.is-default {
    border-color: var(--bs-app-primary-line);
    background: var(--bs-app-primary);
    color: var(--bs-app-primary-foreground);
  }

  .chat-busy-send-badge.is-default:hover:not(:disabled) {
    border-color: var(--bs-app-primary-line);
    background: color-mix(in oklab, var(--bs-app-primary) 82%, var(--bs-app-title));
    color: var(--bs-app-primary-foreground);
  }

  .chat-busy-send-badge:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .chat-busy-send-badge:disabled {
    border-color: var(--bs-app-line);
    background: transparent;
    color: var(--bs-app-faint-text);
    cursor: not-allowed;
  }

  /*
   * DL-119-03: the reason a badge is greyed out is PLAIN TEXT, not only a tooltip. The
   * whole story exists because a state behind a hover is a state nobody reads.
   */
  .chat-busy-send-note {
    position: absolute;
    right: 0.55rem;
    bottom: 5.35rem;
    z-index: 8;
    max-width: min(22rem, calc(100% - 1.1rem));
    margin: 0;
    border-radius: 6px;
    background: var(--bs-app-inset-surface);
    padding: 0.1rem 0.4rem;
    color: var(--bs-app-muted-text);
    font-size: 0.6875rem;
    line-height: 1.35;
    text-align: right;
  }

  .chat-stop-work-float {
    display: inline-flex;
    width: 2.15rem;
    height: 2.15rem;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in oklab, var(--destructive) 48%, var(--bs-app-field-line));
    border-radius: 9999px;
    background: color-mix(in oklab, var(--destructive) 12%, var(--bs-app-field));
    box-shadow:
      0 8px 18px oklch(0 0 0 / 0.28),
      0 0 0 1px color-mix(in oklab, var(--destructive) 12%, transparent);
    color: color-mix(in oklab, var(--destructive) 86%, var(--bs-app-title));
    cursor: pointer;
    transition:
      background-color 150ms ease-out,
      border-color 150ms ease-out,
      box-shadow 150ms ease-out,
      transform 150ms ease-out,
      opacity 150ms ease-out;
  }

  .chat-stop-work-float:hover:not(:disabled) {
    border-color: color-mix(in oklab, var(--destructive) 64%, var(--bs-app-field-line));
    background: color-mix(in oklab, var(--destructive) 18%, var(--bs-app-field-hover));
    box-shadow:
      0 10px 22px oklch(0 0 0 / 0.32),
      0 0 0 2px color-mix(in oklab, var(--destructive) 16%, transparent);
    transform: translateY(-1px);
  }

  .chat-stop-work-float:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--destructive) 72%, var(--foreground));
    outline-offset: 2px;
  }

  .chat-stop-work-float:disabled {
    cursor: wait;
    opacity: 0.72;
  }

  :global(.chat-stop-work-icon) {
    width: 0.82rem;
    height: 0.82rem;
    fill: currentColor;
    stroke-width: 2.4;
  }

  .chat-voice-session-pill {
    position: absolute;
    right: 0.55rem;
    bottom: 3.15rem;
    z-index: 8;
    display: inline-flex;
    max-width: min(24rem, calc(100% - 1.1rem));
    height: 2rem;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid color-mix(in oklab, var(--bs-app-field-line) 76%, transparent);
    border-radius: 9999px;
    background: color-mix(in oklab, var(--bs-app-field) 88%, oklch(0 0 0 / 0.24));
    box-shadow:
      0 10px 24px oklch(0 0 0 / 0.3),
      0 0 0 1px color-mix(in oklab, var(--bs-app-title) 5%, transparent);
    color: var(--bs-app-text);
    padding: 0.2rem 0.22rem 0.2rem 0.65rem;
    backdrop-filter: blur(12px);
  }

  .chat-voice-session-pill.has-stop-work {
    right: 3.05rem;
    max-width: min(22rem, calc(100% - 3.6rem));
  }

  .chat-voice-session-dot {
    width: 0.5rem;
    height: 0.5rem;
    flex: 0 0 auto;
    border-radius: 9999px;
    background: oklch(0.68 0.12 185);
    box-shadow: 0 0 0 3px oklch(0.68 0.12 185 / 0.16);
  }

  .chat-voice-session-label {
    min-width: 0;
    overflow: hidden;
    color: var(--bs-app-title);
    font-size: 0.76rem;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-voice-session-mode {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid color-mix(in oklab, var(--bs-app-field-line) 74%, transparent);
    color: var(--bs-app-muted-text);
    font-size: 0.68rem;
    line-height: 1;
    padding-left: 0.45rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-voice-session-end {
    display: inline-flex;
    width: 1.45rem;
    height: 1.45rem;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in oklab, var(--destructive) 42%, transparent);
    border-radius: 9999px;
    background: color-mix(in oklab, var(--destructive) 10%, transparent);
    color: color-mix(in oklab, var(--destructive) 80%, var(--bs-app-title));
    transition:
      background-color 150ms ease-out,
      border-color 150ms ease-out,
      color 150ms ease-out,
      transform 150ms ease-out;
  }

  .chat-voice-session-end:hover {
    border-color: color-mix(in oklab, var(--destructive) 62%, transparent);
    background: color-mix(in oklab, var(--destructive) 18%, transparent);
    color: color-mix(in oklab, var(--destructive) 92%, var(--bs-app-title));
    transform: translateY(-1px);
  }

  .chat-voice-session-end:focus-visible {
    outline: 2px solid color-mix(in oklab, var(--destructive) 72%, var(--foreground));
    outline-offset: 2px;
  }

  .chat-voice-session-end-icon {
    width: 0.82rem;
    height: 0.82rem;
    stroke-width: 2.3;
  }

  .chat-voice-session-pill.is-speaking {
    border-color: oklch(0.78 0.11 78 / 0.64);
  }

  .chat-voice-session-pill.is-speaking .chat-voice-session-dot {
    background: oklch(0.86 0.1 78);
    box-shadow: 0 0 0 3px oklch(0.86 0.1 78 / 0.18);
  }

  .chat-voice-session-pill.is-recording {
    border-color: oklch(0.68 0.18 20 / 0.62);
  }

  .chat-voice-session-pill.is-recording .chat-voice-session-dot {
    background: oklch(0.72 0.19 20);
    box-shadow: 0 0 0 3px oklch(0.72 0.19 20 / 0.18);
    animation: chat-input-pulse 1.2s ease-in-out infinite;
  }

  .chat-voice-session-pill.is-processing {
    border-color: oklch(0.66 0.12 265 / 0.62);
  }

  .chat-voice-session-pill.is-processing .chat-voice-session-dot {
    background: oklch(0.68 0.12 265);
    box-shadow: 0 0 0 3px oklch(0.68 0.12 265 / 0.18);
  }

  .chatbar-panel-pair,
  .chatbar-split-button,
  .chatbar-tool-shell {
    height: 2rem;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 8px;
    background: var(--bs-app-field);
    color: var(--bs-app-field-text);
  }

  .chatbar-panel-pair,
  .chatbar-split-button {
    display: flex;
    overflow: hidden;
  }

  .chatbar-panel-pair {
    overflow: visible;
  }

  .chatbar-tool-shell {
    position: relative;
    min-width: 2rem;
    overflow: visible;
  }

  .chatbar-control-slot {
    position: relative;
  }

  .chatbar-divider {
    width: 1px;
    background: var(--bs-app-inner-line);
  }

  .chatbar-split-action {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding-inline: 0.5rem;
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      opacity 0.15s ease;
  }

  .chatbar-split-action:hover {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  .chatbar-split-action:disabled {
    opacity: 0.5;
  }

  :global(.chatbar-icon),
  :global(.chat-input-action-icon) {
    width: 1rem;
    height: 1rem;
  }

  :global(.chat-mode-selector-trigger) {
    display: inline-flex;
    height: 2rem;
    min-width: 0;
    max-width: 8.5rem;
    flex: 0 1 auto;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 9999px;
    background: var(--bs-app-field);
    color: var(--bs-app-field-text);
    padding-inline: 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  :global(.chat-mode-selector-trigger:hover) {
    border-color: var(--bs-app-field-line-hover);
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.chat-mode-selector-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 1px var(--bs-app-primary-soft);
  }

  .mode-selector-inner {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
  }

  :global(.chat-mode-selector-icon),
  :global(.chat-mode-selector-chevron),
  :global(.chat-mode-menu-icon) {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  :global(.chat-mode-selector-icon),
  :global(.chat-mode-selector-chevron) {
    color: var(--bs-app-muted-text);
  }

  :global(.chat-mode-menu-content) {
    width: max-content;
    min-width: 13.75rem;
    max-width: min(20rem, calc(100vw - 2rem));
  }

  :global(.chat-mode-menu-content .bs-dropdown-item.is-checkable) {
    padding-left: 0.5rem;
  }

  :global(.chat-mode-menu-content .bs-dropdown-indicator) {
    display: none;
  }

  :global(.chat-mode-menu-item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid transparent;
    border-radius: 5px;
    padding-inline: 0.5rem;
  }

  :global(.chat-mode-menu-item.is-active) {
    border-color: var(--bs-app-primary-soft);
    background: var(--bs-app-primary-faint);
    color: var(--bs-app-title);
  }

  :global(.chat-mode-menu-item.is-muted) {
    color: var(--bs-app-muted-text);
  }

  .chat-mode-menu-copy {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-mode-menu-copy.is-stacked {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }

  .chat-mode-menu-title,
  .mode-selector-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.chat-input-icon-lg) {
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    margin-bottom: 0.25rem;
    padding: 0.35rem;
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      opacity 0.15s ease;
  }

  :global(.chat-input-icon-lg.is-listening) {
    background: oklch(0.52 0.11 185);
    border-color: oklch(0.68 0.12 185 / 0.55);
    color: oklch(0.96 0.006 185);
    animation: chat-input-pulse 1.5s ease-in-out infinite;
  }

  :global(.chat-input-icon-lg.is-listening:hover) {
    background: oklch(0.47 0.11 185);
  }

  :global(.chat-input-icon-lg.is-voice-active) {
    background: oklch(0.52 0.11 185);
    border-color: oklch(0.68 0.12 185 / 0.55);
    color: oklch(0.96 0.006 185);
  }

  :global(.chat-input-icon-lg.is-voice-active:hover) {
    background: oklch(0.47 0.11 185);
  }

  :global(.chat-input-icon-lg.is-voice-speaking) {
    border-color: oklch(0.78 0.11 78 / 0.72);
    background: oklch(0.24 0.07 78 / 0.72);
    color: oklch(0.92 0.08 78);
  }

  :global(.chat-input-icon-lg.is-voice-speaking:hover) {
    background: oklch(0.29 0.08 78 / 0.82);
    color: oklch(0.92 0.08 78);
  }

  :global(.chat-input-icon-lg.is-voice-recording) {
    border-color: oklch(0.68 0.18 20 / 0.72);
    background: oklch(0.32 0.11 20 / 0.78);
    color: oklch(0.94 0.035 20);
  }

  :global(.chat-input-icon-lg.is-voice-recording:hover) {
    background: oklch(0.37 0.12 20 / 0.88);
  }

  :global(.chat-input-icon-lg.is-voice-processing) {
    border-color: oklch(0.66 0.12 265 / 0.72);
    background: oklch(0.27 0.08 265 / 0.78);
    color: oklch(0.91 0.035 265);
  }

  :global(.chat-input-icon-lg.is-voice-processing:hover) {
    background: oklch(0.31 0.09 265 / 0.88);
  }

  :global(.chat-input-icon-lg.is-livekit-connected) {
    background: oklch(0.52 0.11 185);
    border-color: oklch(0.68 0.12 185 / 0.55);
    color: oklch(0.96 0.006 185);
  }

  :global(.chat-input-icon-lg.is-livekit-connected:hover) {
    background: oklch(0.47 0.11 185);
  }

  :global(.chat-input-icon-lg.is-livekit-error) {
    border-color: oklch(0.64 0.275 358 / 0.7);
    color: oklch(0.78 0.18 358);
  }

  :global(.chat-input-icon-lg.is-pulsing) {
    animation: chat-input-pulse 1.5s ease-in-out infinite;
  }

  :global(body.goon-immersive) .chat-composer-shell {
    border-color: oklch(0.92 0.006 289.95 / 0.22);
    background: oklch(0.11 0.02 276 / 0.58);
    color: oklch(0.96 0.006 289.95 / 0.92);
    backdrop-filter: blur(10px);
    box-shadow: 0 12px 30px oklch(0 0 0 / 0.24);
  }

  :global(body.goon-immersive) .chat-composer-textarea {
    color: oklch(0.96 0.006 289.95 / 0.92);
  }

  :global(body.goon-immersive) .chat-composer-textarea::placeholder {
    color: oklch(0.86 0.012 289.95 / 0.68);
  }

  :global(body.goon-immersive) .mention-highlight {
    color: transparent;
  }

  :global(body.goon-immersive) .chatbar-panel-pair,
  :global(body.goon-immersive) .chatbar-split-button,
  :global(body.goon-immersive) .chatbar-tool-shell,
  :global(body.goon-immersive .chat-mode-selector-trigger),
  :global(body.goon-immersive .chat-input-icon-lg) {
    border-color: oklch(0.92 0.006 289.95 / 0.22);
    background: oklch(0.13 0.02 276 / 0.48);
    color: oklch(0.96 0.006 289.95 / 0.88);
    backdrop-filter: blur(8px);
  }

  :global(body.goon-immersive .chatbar-icon),
  :global(body.goon-immersive .chat-input-action-icon),
  :global(body.goon-immersive .chat-mode-selector-icon),
  :global(body.goon-immersive .chat-mode-selector-chevron) {
    color: oklch(0.96 0.006 289.95 / 0.9);
  }

  :global(body.goon-immersive) .chatbar-divider {
    background: oklch(0.92 0.006 289.95 / 0.18);
  }

  :global(body.goon-immersive) .chatbar-split-action:hover,
  :global(body.goon-immersive .chat-mode-selector-trigger:hover),
  :global(body.goon-immersive .chat-input-icon-lg:hover) {
    border-color: oklch(0.96 0.006 289.95 / 0.32);
    background: oklch(0.18 0.025 276 / 0.66);
    color: oklch(0.99 0.002 289.95);
  }

  .chat-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes chat-input-pulse {
    50% {
      opacity: 0.72;
    }
  }

  .mention-highlight {
    border-radius: 0.25rem;
    padding: 0.05rem 0.15rem;
    box-decoration-break: clone;
  }

  .skill-inline-highlight {
    border-radius: 9999px;
    padding: 0;
    box-decoration-break: clone;
    background: var(--bs-app-primary-faint);
    box-shadow: 0 0 0 3px var(--bs-app-primary-faint);
  }

  .mention-valid {
    background: color-mix(in oklab, var(--batshit-success, var(--success-color)) 15%, transparent);
  }

  .mention-missing {
    background: color-mix(in oklab, var(--batshit-muted, #94a3b8) 18%, transparent);
    border-bottom: 1px dashed color-mix(in oklab, var(--batshit-muted, #94a3b8) 65%, transparent);
  }

  .mention-excluded {
    background: color-mix(in oklab, var(--batshit-warning, #f59e0b) 20%, transparent);
    border-bottom: 1px solid color-mix(in oklab, var(--batshit-warning, #f59e0b) 75%, transparent);
  }

  .mention-binary,
  .mention-image {
    background: color-mix(in oklab, var(--batshit-danger, #ef4444) 18%, transparent);
    border-bottom: 1px solid color-mix(in oklab, var(--batshit-danger, #ef4444) 75%, transparent);
  }

	  :global(.mode-item span svg) {
	    display: none;
	  }

	  :global(.mode-selector-trigger) {
	    width: 60px;
	    min-width: 60px;
	    max-width: 60px;
	    padding-left: 0.5rem;
	    padding-right: 0.5rem;
	  }

	  :global(.mode-selector-trigger .mode-selector-label) {
	    display: none;
	  }

	  :global(.mode-selector-inner) {
	    gap: 0.35rem;
	  }

	  /* Chat column container queries (container defined on chat column in +page.svelte) */
	  @container chat-column (max-width: 750px) {
	    :global(.model-selector-trigger) {
	      width: 55px;
	      min-width: 55px;
      max-width: 55px;
      padding-left: 0.4rem;
      padding-right: 0.4rem;
    }

    :global(.model-selector-trigger .model-selector-label) {
      display: none;
    }
  }

  @container chat-column (max-width: 650px) {
    :global(.agent-selector-trigger) {
      width: 60px;
      min-width: 60px;
      max-width: 60px;
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }

    :global(.agent-selector-label) {
      display: none;
    }
  }

  /* Base size for the last three icons (always small) */
  :global(.chat-input-icon-lg) {
    width: 2.25rem;
    height: 2.25rem;
    padding: 0.35rem;
  }

	  @container chat-column (max-width: 550px) {
	    :global(.execution-viewer-button) {
	      display: none;
	    }

      :global(.api-reasoning-selector),
      :global(.bash-mode-selector) {
	      display: none;
	    }

	    :global(.chat-bottom-row) {
	      gap: 0.35rem;
	    }

      .chat-voice-session-mode {
        display: none;
      }

  }
</style>

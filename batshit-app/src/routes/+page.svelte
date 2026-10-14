<script lang="ts">
  import { isAcceptedGroupNoReplyCompletion } from '$lib/utils/groupNoReplyCompletion'
  import { cliContextSettingsKey, resolveEffectiveAgentCliModel } from '$lib/utils/cliContextWindow'
  import type { LocalContextBudgetEvidence } from '$lib/types/localContextBudget'
  import { buildContextPreviewIdentity } from '$lib/utils/contextPreviewIdentity'
  import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
  import { page } from '$app/state'
  import { readApprovalResumeStart, isNewApprovalResume, approvalResumeStartPatch } from '$lib/utils/approvalResumeStream'
  import { goto } from '$app/navigation'
  import ChatArea from '$lib/components/chat/ChatArea.svelte'
  import ChatInput from '$lib/components/chat/ChatInput.svelte'
  import TokenPanel from '$lib/components/tokens/TokenPanel.svelte'
  import { isChatgptPlanConnection } from '$lib/utils/chatgptPlanConnection'
  import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
  import CompactArtifactShelf from '$lib/components/artifacts/CompactArtifactShelf.svelte'
  import ProjectsSidebar from '$lib/components/projects/ProjectsSidebar.svelte'
  import ArtifactsSidebar from '$lib/components/artifacts/ArtifactsSidebar.svelte'
  import IconColumn from '$lib/components/artifacts/IconColumn.svelte'
  import GoonDock from '$lib/components/goons/GoonDock.svelte'
  import ExecutionViewerSheet from '$lib/components/chat/ExecutionViewerSheet.svelte'
  import { createAppActionsDocument, type AppActionsAPI, type AppActionsDocument } from '$lib/appActions/document'
  import { createAppActionsBrowserTransport } from '$lib/appActions/browserTransport'
  import { APP_ACTION_FILE_DEADLINE_MS } from '$lib/appActions/fileProtocol'
  import { dispatchVoiceDockQuickAction } from '$lib/appActions/voice/dockProjection'
  import {
    appActionAvailability, appActionHandler, appActionObservation, performDockAction,
    registerAppAction, registerAppActionObservation, retireAppActionNavigation,
    type ActionContext
  } from '$lib/appActions/owners'
  import DmInboxDrawer from '$lib/components/chat/DmInboxDrawer.svelte'
  import MissedSchedulesDialog from '$lib/components/schedules/MissedSchedulesDialog.svelte'
  import DmInboxIndicator from '$lib/components/chat/DmInboxIndicator.svelte'
  import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
  import HeaderBarIcons from '$lib/components/artifacts/HeaderBarIcons.svelte'
  import HeaderOverlay from '$lib/components/artifacts/HeaderOverlay.svelte'
  import UpdateAvailableIndicator from '$lib/components/update/UpdateAvailableIndicator.svelte'
  import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte'
  import FirstRunSetupWizard from '$lib/components/onboarding/FirstRunSetupWizard.svelte'
  import { Button } from '$lib/components/ui/button'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import { ChevronRight, Sparkles } from '@lucide/svelte'
  import { useSidebar } from '$lib/components/ui/sidebar/context.svelte'
  import * as messageStore from '$lib/stores/messages.svelte'
  import type { Message } from '$lib/stores/messages.svelte'
  import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte'
  import * as sessionStore from '$lib/stores/session.svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import * as groupStore from '$lib/stores/groups.svelte'
  import { foldersStore } from '$lib/stores/folders.svelte'
  import { generateSessionId } from '$lib/utils/sessionId'
  import { computeCacheHitRatePercent, computeSessionCacheAggregate } from '$lib/utils/cacheHitRate'
  import { api } from '$lib/services/api'
  import { SSEService } from '$lib/services/sse'
  import {
    parseParameterError,
    buildParameterErrorToast
  } from '$lib/utils/parameterErrorHints'
  import type { MatrixConnectionId } from '$lib/types/compatibilityMatrix'
  import { DatabaseService } from '$lib/services/databaseRedis.client'
  import { ProjectService } from '$lib/services/projects'
  import { SessionService } from '$lib/services/sessions'
  import { artifactService } from '$lib/services/artifactService'
  import { onMount, onDestroy, tick, untrack } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { scopeToastOptions } from '$lib/components/ui/sonner/toast-scope'
  import { QUICK_ACTION_EVENT, type QuickActionMark } from '$lib/utils/jevJuiceQuickActions'
  import * as savedModelsStore from '$lib/stores/savedModels.svelte'
  import * as projectStore from '$lib/stores/projects.svelte'
  import {
    resolveVoiceSettingsForSpeech,
    resolveVoiceSpeakableTextOptions,
    voiceService
  } from '$lib/services/voice'
  import type { VoiceConfig } from '$lib/services/voice'
  import {
    sampleGoonLipSyncTimeline,
    type GoonLipSyncAnalyzerId,
    type GoonLipSyncTimeline
  } from '$lib/utils/goonLipSync'
  import {
    flattenLegacyVoiceStyle,
    getProviderOptionsFor,
    mergeVoiceCommon,
    mergeVoiceProviderBlocks,
    normalizeAgentVoiceProfile,
    normalizeVoiceSettings,
    normalizeVoiceTtsConfig
  } from '$lib/utils/voiceSchema'
  import { getPlaybackState } from '$lib/stores/voicePlayback.svelte'
  import { loadGoons, loadGoonAnimationLibrary, updateGoon as updateGoonRecord } from '$lib/services/goons'
  import {
    persistGoonsSettingsPatchRequest,
    refreshUserSettingsRequest
  } from '$lib/services/goonsSettingsPersistence'
  import { getGoons } from '$lib/stores/goons.svelte'
  import { getGoonAnimationLibrary } from '$lib/stores/goonAnimationLibrary.svelte'
  import { isGoonRuntimeReady } from '$lib/goons/recipe'
  import { resolveGoonLiveActivationKey } from '$lib/goons/recipe'
  import {
    normalizeDesktopGoonPreferences,
    normalizeGoonsSettings,
    resolveGoonCues
  } from '$lib/goons/resolve'
  import {
    createDesktopGoonPresentationState,
    beginDesktopGoonPresentationTransition,
    commitDesktopGoonPresentationTransition,
    rollbackDesktopGoonPresentationTransition,
    resolveVisibleGoonPresentationMode,
    type DesktopGoonPresentationMode,
    type DesktopGoonPresentationState
  } from '$lib/goons/desktopGoonPresentation'
  import { resolveDesktopGoonActiveSpeaker } from '$lib/goons/desktopGoonActiveSpeaker'
  import {
    DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
    type DesktopGoonJsonValue,
    type DesktopGoonRuntimeDeltaV1,
    type DesktopGoonRuntimeGoonRefV1,
    type DesktopGoonRuntimeSnapshotV1
  } from '$lib/goons/desktopGoonContracts'
  import {
    DesktopGoonMainStatePublisher,
    type DesktopGoonBridgeFailure
  } from '$lib/goons/desktopGoonStateBridge'
  import {
    adaptDesktopGoonStatePort,
    getDesktopGoonNativeBridge,
    type DesktopGoonNativeBridge,
    type DesktopGoonShellStatus,
    type DesktopGoonStatePortFacade
  } from '$lib/goons/desktopGoonNativeBridge'
  import {
    getDesktopControlsNativeBridge,
    type DesktopControlsNativeBridge,
    type DesktopControlsStateEvent
  } from '$lib/goons/desktopControlsNativeBridge'
  import {
    buildGoonQuickControlPatch,
    buildGoonQuickControlsProjection,
    normalizeGoonQuickControlAction,
    normalizeGoonQuickControlRuntimeContext,
    type GoonQuickControlAction,
    type GoonQuickControlRuntimeContext
  } from '$lib/goons/goonQuickControls'
  import {
    desktopControlsVoiceCoordinator,
    type DesktopControlsVoiceState
  } from '$lib/services/desktopControlsVoice'
  import type { GoonMountedRuntimeState } from '$lib/goons/engine'
  import { parseGoonCues, parseLiveKitNaturalGoonCues } from '$lib/goons/cueParser'
  import type {
    DesktopGoonPreferences,
    GoonsSettings,
    GoonCamera,
    GoonDefaults
  } from '$lib/types/goons'
  import {
    LIVE_SETTINGS_EVENTS,
    dispatchSessionClipStateChanged,
    resolveServerClipStateSource,
    type DesktopGoonPreferencesUpdatedDetail
  } from '$lib/utils/liveSettingsEvents'
  import { logger } from '$lib/utils/logger'
  import {
    isManagedPrimaryAgentType,
    normalizePrimaryAgentType,
    shouldShowReasoningByDefaultForPrimaryAgent
  } from '$lib/utils/primaryAgentType'
  import { confirmUserSettings, failUserSettingsRead, getUserSettings, getUserSettingsReadState, resetUserSettings } from '$lib/stores/userSettings.svelte'
  import { applyClaudeApprovalCardEvent, settleClaudeApprovalCard } from '$lib/utils/claudeApprovalCard'
  import {
    buildStopFallbackContent,
    shouldAcceptLateEndAfterStopFallback,
    stripUnfinalizedReplyControl
  } from '$lib/utils/replyEndSave'
  import { sanitizeFinishedReplyContent } from '$lib/utils/replyEndContent'
  import { postSendRouted } from '$lib/services/sendRoutedClient'
  import {
    classifySteerRefusal,
    isQuietQueuedSendAnswer,
    isSteerDeliver,
    placeUserMessageLast,
    readHeldForApprovalCard,
    readQueuedSendNotice,
    replayableSendMetadata,
    resolveBusySendActions,
    resolveBusySendMode,
    resolveStopInterruptionStamp,
    restampResentMessage,
    shouldClearKeptReceipt,
    STEER_REFUSED_GROUP_SENTENCE,
    STEER_REFUSED_UNKNOWN_SENTENCE,
    type BusySendMode,
    type SteerDeliver,
    type StopInterruptionRecord
  } from '$lib/utils/steerControl'
  import * as steerInbox from '$lib/stores/steerInbox.svelte'
  import {
    forgetJevJuicePostTurnRecords,
    refreshJevJuicePostTurnRecords
  } from '$lib/stores/jevJuicePostTurn.svelte'
  import {
    forgetCodexCleanupWarnings,
    refreshCodexCleanupWarnings
  } from '$lib/stores/codexCleanupWarnings.svelte'
  import { forgetImageOrigins, refreshImageOrigins, markImageOriginExpected } from '$lib/stores/imageAddressOrigins.svelte'
  import { stripGatewayPrefix } from '$lib/utils/toolNameFormatter'
  import { THINKING_INDICATOR, isThinkingIndicator } from '$lib/utils/thinkingIndicator'
  import type { ExecutionSnapshot } from '$lib/types/executionViewer'
  import {
    applyManualTrimToMessages,
    calculateTrimmedTokens,
    isMessageProtectedFromManualTrim,
    resolveAgentPrimarySavedModel,
    summarizeContextUsage,
    summarizeRunningCost
  } from '$lib/utils/tokenPanel'
  import { createContextPreviewGate } from '$lib/utils/contextPreviewGate'
  import {
    applyContextCompactionToMessages,
    calculateCompactedTokens,
    getCompactedMessageIds,
    getContextCompactionState,
    resolveAutoCompactTriggerTokens,
    resolveEffectiveAutoCompactSettings,
    selectMessagesForCompaction,
    hasPendingCompactApproval,
    COMPACT_PENDING_APPROVAL_MESSAGE
  } from '$lib/utils/contextCompaction'
  import {
    STOPPED_COMPACT_MESSAGE,
    createCompactStopTracker,
    holdAutoCompactAfterStop,
    isAutoCompactHeldAfterStop,
    isStoppedCompactAnswer,
    releaseAutoCompactHoldOnReplyEnd,
    resolveStopTarget,
    type AutoCompactStopHolds
  } from '$lib/utils/compactStopTarget'
  import {
    resolveChatsToCatchUpAfterUserChannelReturn,
    resolveRepliesEndedWhileAway,
    shouldCatchUpChatAfterReconnect
  } from '$lib/utils/reconnectCatchUp'
  import {
    COMPACT_TURN_RUNNING_RETRY_MS,
    resolveCompactTurnRunning,
    type CompactTurnRunningHandling
  } from '$lib/utils/compactTurnRunning'
  import { resolveCompactEndedEarly } from '$lib/utils/compactEndedEarly'
  import { isSilentAutoCompactNoCandidates } from '$lib/utils/compactNoCandidates'
  import {
    applyFixedSessionGraduationToMessages,
    describeNapEndedEarly
  } from '$lib/utils/fixedSessionGraduation'
  import { isFixedSession } from '$lib/utils/fixedSession'
  import { describeSessionOrigin, resolveSessionOrigin } from '$lib/utils/sessionOrigin'
  import { sessionOriginIcon } from '$lib/utils/sessionOriginIcons'
  import { onUserChannelEvent, isUserChannelConnected } from '$lib/services/userChannel'
  import { buildSessionMessagesForSend } from '$lib/utils/sessionSendMessages'
  import { createChatLoadQueue, watchSelectedSessionLoad } from '$lib/utils/selectedSessionLoad.svelte'
  import {
    hasInterruptibleActiveResponse,
    INTERRUPTED_SEND_RETRY_DELAYS_MS,
    isLatestSendRun,
    shouldRetryInterruptedSendAfterSessionTurnInProgress,
    shouldBlockSendWhileInFlight
  } from '$lib/utils/sendInFlightGuards'
  import { evaluateActiveChatCapacity } from '$lib/utils/activeChatCapacity'
  import { dispatchVoiceEnginesUpdated } from '$lib/utils/voiceEngineEvents'
  import { refreshDeadCopies } from '$lib/stores/zipDeadCopies.svelte'
  import {
    isMemoryControlToolStep,
    resolveAgentMemoryEnabled,
    resolveEffectiveMemoryWindow,
    resolveMemoryWindowSettings
  } from '$lib/utils/memoryControl'
  import { RealtimeSpeechCoordinator } from '$lib/services/realtimeSpeechCoordinator'
  import { resolveSseEventSessionId } from '$lib/utils/sseSessionGuard'
  import { SseEventDeduper } from '$lib/utils/sseEventDedupe'
  import {
    collectTrustedClipIdsFromMetadata,
    neutralizeAllZipReferenceSyntax,
    neutralizeUntrustedClipReferenceSyntax
  } from '$lib/utils/zipReferenceSafety'
  import {
    buildToolStreamStateFromContent,
    composeToolStreamContent as composeToolStreamContentBase,
    resetToolStreamStateFromContent,
    type ToolStreamState
  } from '$lib/utils/toolStreamState'
  import { subagentStore } from '$lib/stores/subagents.svelte'
  import { zippingService } from '$lib/services/zipping'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import { DEFAULT_AGENT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'

  const { data } = $props()

  // Get current messages
  const messages = $derived(messageStore.getMessages())
  const hasMessages = $derived(messages.length > 0)
  const savedModels = $derived(savedModelsStore.getSavedModels())
  const MANUAL_TRIM_STORAGE_KEY = 'batshit.manualContextTrim.v1'
  const sseEventDeduper = new SseEventDeduper()

  // Welcome messages
  const welcomeMessages = [
    "Summon your AI demon",
    "Ready to raise a little hell?",
    "Let's brew up some trouble",
    "Speak, and let chaos unfold",
    "Ready to corrupt some data?",
    "Your AI familiar is ready to serve",
    "Let's get wicked",
    "Let's push buttons and break shit",
    "Oh hell yes, there you are!"
  ]

  // Select random welcome message on mount
  let welcomeMessage = $state('')
  let showWelcome = $state(false)
  const currentWelcomeAgent = $derived(agentStore.getCurrentAgent())

  const RIGHT_RAIL_FALLBACK_WIDTH = 48

  function parseCssLengthToPx(value: string, fallback: number) {
    const trimmed = value.trim()
    if (!trimmed) return fallback
    const numeric = Number.parseFloat(trimmed)
    if (!Number.isFinite(numeric)) return fallback
    if (trimmed.endsWith('rem')) {
      const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      return numeric * rootSize
    }
    if (trimmed.endsWith('px')) return numeric
    return numeric
  }

  function getInheritedCssLengthPx(name: string, fallback: number) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
    const source = document.querySelector('.chat-workspace') ?? document.documentElement
    const value =
      getComputedStyle(source).getPropertyValue(name) ||
      getComputedStyle(document.documentElement).getPropertyValue(name)
    return parseCssLengthToPx(value, fallback)
  }

  function getRightRailWidth() {
    if (typeof document === 'undefined') return RIGHT_RAIL_FALLBACK_WIDTH
    const rail = document.querySelector('.artifact-icon-column') as HTMLElement | null
    const railWidth = rail?.getBoundingClientRect().width ?? 0
    if (railWidth > 0) return railWidth
    return getInheritedCssLengthPx('--sidebar-width-icon', RIGHT_RAIL_FALLBACK_WIDTH)
  }

  function getWelcomeAgentAvatarUrl(agent: agentStore.Agent) {
    return agent.avatar_url || agent.avatar || (agent.avatar_icon_ref ? null : '/assets/batshit_default_AI_Avatar_1.png')
  }

  function getWelcomeAgentAvatarIconRef(agent: agentStore.Agent) {
    return agent.avatar_icon_ref ? normalizeIconRef(agent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF) : null
  }

  function getWelcomeAgentAvatarKey(agent: agentStore.Agent) {
    return [
      agent.id,
      agent.avatar_url ?? '',
      agent.avatar ?? '',
      JSON.stringify(agent.avatar_icon_ref ?? null),
      agent.avatar_icon_fit ?? ''
    ].join(':')
  }

  function getInlineMainSidebarWidth() {
    if (typeof document === 'undefined') return 0
    if (document.body.classList.contains('sidebar-overlay')) return 0
    const sidebarGap = document.querySelector('[data-slot="sidebar-gap"]') as HTMLElement | null
    const gapWidth = sidebarGap?.getBoundingClientRect().width ?? 0
    if (gapWidth > 0) return gapWidth
    const mainSidebar = document.querySelector('.batshit-sidebar') as HTMLElement | null
    return mainSidebar?.getBoundingClientRect().width ?? 0
  }

  function getRightPanelMaxWidth() {
    if (typeof window === 'undefined') return RIGHT_PANEL_MAX_WIDTH

    const projectsSidebar = document.querySelector('.projects-sidebar')
    const projectsSidebarWidth = projectsSidebar?.getBoundingClientRect().width || 0

    const availableWidth =
      window.innerWidth -
      getInlineMainSidebarWidth() -
      projectsSidebarWidth -
      RIGHT_PANEL_MIN_CHAT_WIDTH -
      getRightRailWidth()

    return Math.min(
      RIGHT_PANEL_MAX_WIDTH,
      Math.max(RIGHT_PANEL_MIN_WIDTH, availableWidth)
    )
  }

  function clampRightPanelWidth(value: number) {
    return Math.min(Math.max(RIGHT_PANEL_MIN_WIDTH, value), getRightPanelMaxWidth())
  }

  onMount(() => {
    trimmedMessageIdsBySession = loadStoredManualTrimState()

    const handleZipStateChanged = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null
      const eventSessionId =
        typeof detail?.sessionId === 'string' && detail.sessionId.trim()
          ? detail.sessionId.trim()
          : null
      if (eventSessionId && eventSessionId !== currentSessionId) return
      manualTrimProtectionVersion += 1
      scheduleLiveContextPreview('zip-state', 250, { ignoreBusy: true })
    }
    window.addEventListener('batshit:zip-state-changed', handleZipStateChanged)
    const refreshLocalContext = () => {
      localConnectionRevision += 1
      localContextClock = Date.now()
      if (activeLocalProgramDefinition) scheduleLiveContextPreview('local-model', 0)
    }
    window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, refreshLocalContext)
    window.addEventListener('focus', refreshLocalContext)
    const localContextTimer = setInterval(() => {
      localContextClock = Date.now()
      if (activeLocalProgramDefinition && document.visibilityState === 'visible') {
        scheduleLiveContextPreview('local-model', 0)
      }
    }, 15_000)

    // SA-113 P1 (DL-113-06): a woken turn streams into a session the browser never sent
    // to, so nothing here knows when it finished. The user channel says so; refetch the
    // finished messages when the chat on screen is the one that just ended.
    const stopUserChannelListener = onUserChannelEvent((event) => {
      // BL-382: the user channel came back; what it said meanwhile is gone (a woken turn's end,
      // for one). Catch up each chat still streaming that has no chat subscription of its own (a
      // chat with one catches up on that subscription's return, so none is read twice).
      if (event?.type === 'reconnected') {
        for (const sessionId of resolveChatsToCatchUpAfterUserChannelReturn({
          runStates: Object.values(chatRunRegistry.getRunStates()),
          chatsWithOwnSubscription: new Set(sseServices.keys())
        })) {
          void catchUpAfterReconnect(sessionId)
        }
        return
      }
      // The SERVER changed zip state for a session (Judge Juice smart zip, SA-120 P5; an agent's
      // hold or release, or the countdown, SA-129 P2). Re-read it from Redis when that chat is on
      // screen, in every tab.
      if (event?.type === 'zip_state_changed') {
        const changedSessionId =
          typeof (event as any).sessionId === 'string' ? (event as any).sessionId : null
        if (!changedSessionId || changedSessionId !== currentSessionId) return
        // SA-129 P2: a reply that ended with no page (a woken turn) can make copies dead too.
        void refreshDeadCopies(changedSessionId)
        void import('$lib/services/zipping')
          .then(({ zippingService }) => zippingService.refreshFromServer(changedSessionId))
          .then(() => {
            window.dispatchEvent(new CustomEvent('checkZipActivity', { detail: { sessionId: changedSessionId } }))
          })
          .catch((error) => console.warn('[Judge Juice] Failed to re-read zip state:', error))
        return
      }
      // SA-120 P6: the after-reply check stored something about a finished reply. It happens
      // after the session stream's `end`, so this channel carries it; re-read the chat's notes
      // when that chat is on screen (any other chat reads them when it is opened).
      if (event?.type === 'jev_juice_post_turn') {
        const checkedSessionId =
          typeof (event as any).sessionId === 'string' ? (event as any).sessionId : null
        if (!checkedSessionId || checkedSessionId !== currentSessionId) return
        void refreshJevJuicePostTurnRecords(checkedSessionId)
        return
      }
      if (event?.type === 'image_origin_changed') {
        const originSessionId = event.sessionId
        if (originSessionId === currentSessionId) void refreshImageOrigins(originSessionId)
        return
      }
      if (event?.type === 'codex_cleanup_warning') {
        const warningSessionId =
          typeof (event as any).sessionId === 'string' ? (event as any).sessionId : null
        if (!warningSessionId || warningSessionId !== currentSessionId) return
        void refreshCodexCleanupWarnings(warningSessionId)
        return
      }
      // The SERVER changed this chat's stored messages in a way no stream event could show
      // this tab: a reply resumed into a message the tab had already finished (an approval),
      // an approval card the server settled, or a message deleted in another tab. Re-read the
      // chat on screen. Until 2026-09-18 the page re-fetched every open chat ten times a
      // second, so none of these needed saying.
      if (event?.type === 'session_messages_changed') {
        const changedSessionId =
          typeof (event as any).sessionId === 'string' ? (event as any).sessionId : null
        if (!changedSessionId || changedSessionId !== currentSessionId) return
        logger.debug('[UserChannel] Re-reading the chat the server changed', {
          sessionId: changedSessionId,
          reason: (event as any).reason
        })
        void loadMessagesForSession(changedSessionId)
        return
      }
      // A chat was deleted, in this tab or another one (2026-09-18). The user channel has
      // already taken it out of the sidebar; forget its messages and its live connection
      // too, and leave it if this tab still shows it. Before this, it stayed in every other
      // tab, on screen as well, until that tab reloaded.
      if (event?.type === 'session_deleted') {
        const deletedSessionId =
          typeof (event as any).sessionId === 'string' ? (event as any).sessionId : null
        if (!deletedSessionId) return
        clearMissingSelectedSession(deletedSessionId, 'session_deleted')
        return
      }
      if (event?.type !== 'session_run_status') return
      const eventSessionId =
        typeof (event as any).sessionId === 'string' ? (event as any).sessionId : null
      const status = (event as any).status
      if (!eventSessionId || eventSessionId !== currentSessionId) return
      if (status !== 'complete' && status !== 'failed' && status !== 'stopped') return
      void loadMessagesForSession(eventSessionId)
    })

    // Initialize user settings store
    if (data?.user?.id) {
      if (data.userSettingsReadSucceeded === true) {
        confirmUserSettings(data.userSettings)
      } else {
        failUserSettingsRead(new Error(data.userSettingsReadError || 'User settings could not load'))
      }
      refreshUserSettingsRequest(fetch)
        .then((freshSettings) => {
          confirmUserSettings(freshSettings)
        })
        .catch((error) => {
          console.error('[Settings] Failed to refresh user settings:', error)
          failUserSettingsRead(error)
        })
    } else {
      resetUserSettings()
    }

    if (!savedModelsStore.isInitialized()) {
      savedModelsStore.loadSavedModels().catch((error) => {
        console.error('[SavedModels] Failed to load model presets:', error)
      })
    }

    if (data?.user?.id) {
      loadGoons().catch((error) => {
        console.error('[Goons] Failed to load goons:', error)
      })
      loadGoonAnimationLibrary().catch((error) => {
        console.error('[Goons] Failed to load animation library:', error)
      })
    }

    welcomeMessage = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)]
    // Wait for everything to settle before showing welcome animation
    setTimeout(() => {
      showWelcome = true
    }, 100)

    const savedWidth =
      typeof window !== 'undefined' ? localStorage.getItem('artifactsPanelWidth') : null
    if (savedWidth) {
      const parsed = parseInt(savedWidth, 10)
      if (!Number.isNaN(parsed)) {
        artifactsPanelWidth = clampRightPanelWidth(parsed)
        rightPanelWidthInitialized = true
      }
    }

    return () => {
      stopUserChannelListener()
      window.removeEventListener('batshit:zip-state-changed', handleZipStateChanged)
      window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, refreshLocalContext)
      window.removeEventListener('focus', refreshLocalContext)
      clearInterval(localContextTimer)
      if (contextPreviewTimer) {
        clearTimeout(contextPreviewTimer)
        contextPreviewTimer = null
      }
    }
  })

  // Reserved for the future compact artifact widget zone. Disabled for launch so the
  // top pull-down does not duplicate the right-side Artifacts rail.
  const COMPACT_ARTIFACT_WIDGET_ZONE_ENABLED = false
  let tokenPanelOpen = $state(false)
  let trimmedMessageIdsBySession = $state<Record<string, string[]>>({})
  let manualTrimEstimateBySession = $state<Record<string, { afterTokens: number; freedTokens: number }>>({})
  let manualTrimProtectionVersion = $state(0)
  let trimPreviewBusy = $state(false)
  let compactBusy = $state(false)
  // BL-653: the chat whose Compact runs, and a Stop pressed during it (not rendered, so not $state).
  const compactStopTracker = createCompactStopTracker()
  let compactStatus = $state<string | null>(null)
  let autoCompactLastPromptKeyBySession = $state<Record<string, string>>({})
  // BL-653: chats whose Auto Compact the user stopped; Auto Compact waits there for a reply's end.
  let autoCompactStopHolds = $state<AutoCompactStopHolds>({})
  // SA-104 P6: Infinite-Session nap state (the compact-state pattern).
  let napBusy = $state(false)
  let napStatus = $state<string | null>(null)
  let napLastAttemptKeyBySession = $state<Record<string, string>>({})
  // One actionable graduation-config warning per session per app run (packet doc §1.7).
  const graduationWarnedSessions = new Set<string>()
  const graduationCheckedSessions = new Set<string>()
  let executionSnapshots = $state<ExecutionSnapshot[]>([])
  let executionSnapshotsLoading = $state(false)
  let executionSnapshotsError = $state<string | null>(null)
  let executionBusyPrev = $state(false)
  type ContextPreviewRefreshOptions = {
    useStoredMessages?: boolean
    ignoreBusy?: boolean
    keepExistingTimer?: boolean
  }
  let liveContextEstimateBySession = $state<Record<string, {
    tokens: number
    contextLimit: number | null
    contextWindowWarning?: string | null
    contextWindowCheckedAt?: number | null
    localContext?: LocalContextBudgetEvidence | null
    settingsKey: string
    reason: string
    updatedAt: number
  }>>({})
  let contextPreviewTimer: ReturnType<typeof setTimeout> | null = null
  let localConnectionRevision = $state(0)
  let localContextClock = $state(Date.now())
  let contextPreviewSerial = 0
  let contextPreviewSettingsKey: string | null = null
  let contextPreviewSettingsSessionId: string | null = null
  let currentSessionIdState = $state<string | null>(sessionStore.getCurrentSessionId())
  const currentSessionId = $derived(currentSessionIdState)
  const currentLiveContextEstimate = $derived.by(() => {
    const sessionId = currentSessionId
    if (!sessionId) return null
    return liveContextEstimateBySession[sessionId] ?? null
  })
  // One preview request in flight per chat, plus one trailing refresh (`contextPreviewGate.ts`).
  // Every ask used to start its own request: a reply's end opened three or four at once, which
  // beside the page's two event streams filled Chrome's six connections and held the next send.
  const contextPreviewGate = createContextPreviewGate<{
    reason: string
    options: ContextPreviewRefreshOptions
  }>({
    run: (sessionId, ask) => runLiveContextPreview(ask.reason, sessionId, ask.options),
    isOnScreen: (sessionId) => sessionId === currentSessionId
  })

	  let realtimeSpeechSessionScopeId = sessionStore.getCurrentSessionId()

	  const sseServices = new Map<string, SSEService>()
	  const sseDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
	  const missingSessionIds = new Set<string>()
	  let connectedSseSessionIds = $state<string[]>([])
	  let connectingSseSessionIds = $state<string[]>([])
	  let eventSessionContext: string | null = null
	  let lastConversationLoadToastAt = 0
  let voiceMode = $state(false)
  let activeComposerClipIds = $state<string[]>([])
  let activeComposerClipScopeId = $state<string | null>(null)
  let desktopControlsComposerClipSignature = ''
  let chatInputRef: any = null

  $effect(() => {
    const sessionId = currentSessionId
    if (activeComposerClipScopeId === sessionId) return
    activeComposerClipScopeId = sessionId
    activeComposerClipIds = []
  })

  $effect(() => {
    const sessionId = currentSessionId
    const key = getContextPreviewSettingsKey()
    if (contextPreviewSettingsSessionId !== sessionId) {
      contextPreviewSettingsSessionId = sessionId
      contextPreviewSettingsKey = key
      if (activeLocalProgramDefinition) scheduleLiveContextPreview('local-model', 0)
      return
    }

    if (contextPreviewSettingsKey === null) {
      contextPreviewSettingsKey = key
      return
    }

    if (key !== contextPreviewSettingsKey) {
      contextPreviewSettingsKey = key
      scheduleLiveContextPreview('zip-settings', 500)
    }
  })
  let shouldCreateSession = $state(false)
  let creatingSessionIds = $state<string[]>([])
  const creatingSessionId = $derived(creatingSessionIds[0] ?? null)

  function isSessionCreating(sessionId: string | null | undefined) {
    return Boolean(sessionId && creatingSessionIds.includes(sessionId))
  }

  function markCreatingSession(sessionId: string | null | undefined) {
    if (!sessionId || creatingSessionIds.includes(sessionId)) return
    creatingSessionIds = [...creatingSessionIds, sessionId]
  }

  function clearCreatingSession(sessionId?: string | null) {
    if (!sessionId) {
      creatingSessionIds = []
      return
    }
    creatingSessionIds = creatingSessionIds.filter((id) => id !== sessionId)
  }
  let artifactsPanelOpen = $state(false)
  let goonsPanelOpen = $state(false)
  type GoonDockHandoffHandle = {
    captureMountedRuntimeState(): GoonMountedRuntimeState | null
    captureQuickControlRuntimeContext(): GoonQuickControlRuntimeContext
    isMountedRendererReady(): boolean
    releaseMountedRenderer(): GoonMountedRuntimeState | null
  }
  let goonDockRef = $state<GoonDockHandoffHandle | null>(null)
  let desktopNativeBridge: DesktopGoonNativeBridge | null = null
  let desktopControlsBridge: DesktopControlsNativeBridge | null = null
  let desktopShellStatus = $state<DesktopGoonShellStatus | null>(null)
  let desktopPresentation = $state<DesktopGoonPresentationState>(
    createDesktopGoonPresentationState('dock')
  )
  // Mounted renderer snapshots are opaque transfer values. Deep Svelte proxies
  // are not structured-cloneable and must never cross the Dock/Desktop bridge.
  let desktopHandoffState = $state.raw<GoonMountedRuntimeState | null>(null)
  let desktopPublisher: DesktopGoonMainStatePublisher | null = null
  let desktopBridgeError = $state<string | null>(null)
  let desktopEpoch = ''
  let desktopEpochCounter = 0
  let desktopExitInProgress = false
  let desktopStatusUnsubscribe: (() => void) | null = null
  let desktopPortUnsubscribe: (() => void) | null = null
  let desktopControlsUnsubscribe: (() => void) | null = null
  let desktopControlsVoiceUnsubscribe: (() => void) | null = null
  let desktopControlsVoiceState = $state<DesktopControlsVoiceState>(
    desktopControlsVoiceCoordinator.getState()
  )
  let desktopControlsClipRevision = $state(0)
  let desktopControlsProjectionSignature = ''
  let desktopQuickControlContext = $state.raw<GoonQuickControlRuntimeContext | null>(null)
  let desktopQuickControlPending = $state<string | null>(null)
  let desktopQuickControlError = $state<string | null>(null)
  let desktopReplaceableFlushTimer: ReturnType<typeof setInterval> | null = null
  let desktopLastVoiceVisual: DesktopGoonRuntimeSnapshotV1['voiceVisual'] = null
  let desktopVoiceFrameTimer: ReturnType<typeof setInterval> | null = null
  let desktopVoiceGeneration = ''
  type DesktopVoicePlaybackDetail = {
    messageId?: string | null
    agentId?: string | null
    audio?: HTMLMediaElement | null
    durationMs?: number | null
    lipSyncAnalyzerId?: GoonLipSyncAnalyzerId | null
    lipSyncTimeline?: GoonLipSyncTimeline | null
  }
  let desktopActiveVoiceDetail: DesktopVoicePlaybackDetail | null = null
  let desktopVoiceAudioContext: AudioContext | null = null
  let desktopVoiceAudioSource: MediaStreamAudioSourceNode | null = null
  let desktopVoiceAudioAnalyser: AnalyserNode | null = null
  let desktopVoiceAudioSamples: Uint8Array<ArrayBuffer> | null = null
  let desktopCueTimers = new Set<ReturnType<typeof setTimeout>>()
  let desktopSessionSignature = ''
  let desktopSpeakerSignature = ''
  let desktopGoonSignature = ''
  let desktopPreferencesSignature = ''
  let desktopPresentationSignature = ''
  const desktopTransitionBusy = $derived(Boolean(desktopPresentation.transition))
  const desktopModeActive = $derived(
    desktopPresentation.mode === 'desktop' || desktopPresentation.transition?.to === 'desktop'
  )
  const desktopModeAvailable = $derived(Boolean(desktopShellStatus?.supported))
  const desktopModeUnavailableReason = $derived.by(() => {
    if (!desktopNativeBridge) return 'Desktop Mode requires the managed Batshit desktop app.'
    return typeof desktopShellStatus?.unavailableReason === 'string'
      ? desktopShellStatus.unavailableReason
      : null
  })
  const RIGHT_PANEL_MIN_WIDTH = 480
  const RIGHT_PANEL_MAX_WIDTH = 1200
  const RIGHT_PANEL_MIN_CHAT_WIDTH = 480
  // Derived: either right panel is open (for sidebar collapse logic)
  const rightPanelOpen = $derived(artifactsPanelOpen || goonsPanelOpen)
  let rightPanelPrev = $state(false)
  // Calculate default artifacts panel width: 50% of (viewport - 50px collapsed sidebar - projects sidebar if open)
  let artifactsPanelWidth = $state(RIGHT_PANEL_MIN_WIDTH)
  let rightPanelWidthInitialized = $state(false)
  let rightPanelDragging = $state(false)
  let rightPanelDragStartX = $state(0)
  let rightPanelDragStartWidth = $state(0)
  let rightRailWidth = $state(RIGHT_RAIL_FALLBACK_WIDTH)
  let shellViewportWidth = $state(0)
  const rightPanelOverlayMode = $derived(
    rightPanelOpen &&
    shellViewportWidth > 0 &&
    shellViewportWidth < RIGHT_PANEL_MIN_CHAT_WIDTH + RIGHT_PANEL_MIN_WIDTH + rightRailWidth
  )
  let headerOverlayOpen = $state(false)
  let headerOverlayArtifact: any | null = $state(null)
  let artifactsSidebarRef: any = $state(null)
  let draftPreviewArtifactId = $state<string | null>(null)
  let executionViewerOpen = $state(false)
  let appActionsDocument: AppActionsDocument | null = null
  let appActionsTransport: ReturnType<typeof createAppActionsBrowserTransport> | null = null
  let appActionsSessionId: string | null = null
  $effect(() => {
    const selected = sessionStore.getCurrentSessionId()
    if (appActionsDocument && selected !== appActionsSessionId) {
      retireAppActionNavigation()
      const transport = appActionsTransport
      // refresh() joins the single maintenance flight; it is a no-op before the first pass starts (BL-1273).
      if (transport) void transport.refresh().catch(() => {})
    }
    appActionsSessionId = selected
  })

  onMount(() => {
    if (!data.user) return
    const doc = createAppActionsDocument({
      documentId: crypto.randomUUID(), documentEpoch: crypto.randomUUID(),
      session: () => sessionStore.getCurrentSessionId(),
      handler: id => currentSessionId === sessionStore.getCurrentSessionId() ? appActionHandler(id) : undefined,
      availability: appActionAvailability,
      observation: appActionObservation,
      feedback: receipt => {
        let label = 'App Action'
        if (receipt.actionId) {
          try { label = doc.describeFamily(receipt.actionId).label } catch { /* Refused unknown action. */ }
        }
        const detail = receipt.import ? receipt.detail ?? [
          `Upload: ${receipt.import.uploaded}`, `Staged: ${receipt.import.staged}`,
          `Saved: ${receipt.import.saved}`, `Ready: ${receipt.import.ready}`,
          receipt.reason?.replaceAll('_', ' ')
        ].filter(Boolean).join('. ')
          : receipt.saved === 'failed' || receipt.saved === 'unknown'
          ? `${receipt.visible === 'applied' ? 'Visibility changed. ' : ''}The Dock preference ${receipt.saved === 'failed' ? 'was not saved' : 'could not be confirmed saved'}.`
          : receipt.viewer === 'empty' ? 'This session has no execution records.'
          : receipt.viewer === 'no_session' ? 'No session is selected.'
          : receipt.reason?.replaceAll('_', ' ')
        const scope = (appActionObservation().settings as { open?: boolean } | undefined)?.open ? 'settings' : 'app'
        const options = scopeToastOptions({ description: detail, class: '' }, scope)
        if (receipt.status === 'completed' || receipt.status === 'no_op') {
          toast.success(`${label}: ${receipt.status === 'no_op' ? 'already matches' : 'completed'}`, options)
        } else toast.error(`${label}: ${receipt.status.replaceAll('_', ' ')}`, options)
      }
    })
    const setDock = (open: boolean, context: ActionContext) => performDockAction(open, {
      desktop: () => desktopTransitionBusy ? 'transitioning' : desktopModeActive ? 'active' : 'inactive',
      confirmed: () => getUserSettingsReadState() === 'confirmed',
      visible: () => goonsPanelOpen,
      apply: visible => { goonsPanelOpen = visible; if (visible) artifactsPanelOpen = false },
      persist: persistAppActionDock,
      mounted: visible => visible ? Boolean(goonDockRef) && !artifactsPanelOpen : !goonDockRef
    }, context)
    const cleanup = [
      registerAppActionObservation('dock', () => ({ open: goonsPanelOpen, mounted: Boolean(goonDockRef),
        settingsConfirmed: getUserSettingsReadState() === 'confirmed',
        desktop: desktopTransitionBusy ? 'transitioning' : desktopModeActive ? 'active' : 'inactive' })),
      registerAppAction('goon.show', (_, context) => setDock(true, context), () => dockAppActionAvailability(true)),
      registerAppAction('goon.hide', (_, context) => setDock(false, context), () => dockAppActionAvailability(false))
    ]
    appActionsDocument = doc
    appActionsSessionId = currentSessionId
    const transport = createAppActionsBrowserTransport(doc, { fetch: window.fetch.bind(window), crypto: window.crypto,
      onEvent: onUserChannelEvent, connected: isUserChannelConnected,
      feedback: reason => toast.error('App Actions unavailable', scopeToastOptions({ description: reason.replaceAll('_', ' '), class: '' }, 'app')) })
    appActionsTransport = transport
    const localWindow = window as Window & { batshitAppActions?: AppActionsAPI }
    localWindow.batshitAppActions = Object.freeze({
      state: () => ({ ...doc.state(), transport: transport.state(), fileDeadlineMaxMs: APP_ACTION_FILE_DEADLINE_MS }),
      discover: doc.discover, describe: doc.describe, execute: doc.execute, executeFile: doc.executeFile,
      discoverFamilies: doc.discoverFamilies, describeFamily: doc.describeFamily, receipt: doc.receipt,
      inspectSettings: async (args: unknown) => {
        const response = await fetch('/api/app/actions', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: 'settings.inspect', args }) })
        return response.json()
      }
    })
    const interrupt = (event: Event) => { if (event.isTrusted) retireAppActionNavigation() }
    window.addEventListener('pointerdown', interrupt, { capture: true })
    window.addEventListener('keydown', interrupt, { capture: true })
    // BL-1273: a page that is visible again may have slept past its lease; refresh reconciles it.
    const resume = () => { if (document.visibilityState === 'visible') void transport.refresh().catch(() => {}) }
    document.addEventListener('visibilitychange', resume)
    return () => {
      transport.retire()
      appActionsTransport = null
      doc.retire()
      appActionsDocument = null
      for (const remove of cleanup) remove()
      delete localWindow.batshitAppActions
      window.removeEventListener('pointerdown', interrupt, { capture: true })
      window.removeEventListener('keydown', interrupt, { capture: true })
      document.removeEventListener('visibilitychange', resume)
    }
  })

  function dockAppActionAvailability(open: boolean) {
    if (desktopTransitionBusy) return 'desktop_transitioning'
    if (desktopModeActive) return 'desktop_mode_active'
    if (goonsPanelOpen === open) return 'available'
    return getUserSettingsReadState() === 'confirmed' ? 'available' : 'settings_unconfirmed'
  }

  async function persistAppActionDock(open: boolean, context: ActionContext): Promise<'saved' | 'failed' | 'unknown'> {
    context.check()
    if (getUserSettingsReadState() !== 'confirmed' || desktopModeActive || desktopTransitionBusy) {
      return 'failed'
    }
    let rejected = false
    try {
      // The existing owning serializer admits only this one key; never reuse the blind toggle.
      const saved = await persistGoonsSettingsPatchRequest(async (input, init) => {
        context.check()
        const response = await fetch(input, init)
        rejected = !response.ok
        return response
      }, { dockOpen: open })
      confirmUserSettings(saved)
      context.report({ status: 'unknown_outcome', visible: 'applied', saved: 'unknown' })
      context.check()
      const readBack = await refreshUserSettingsRequest(async (input, init) => {
        context.check()
        return fetch(input, { ...init, signal: context.signal })
      })
      confirmUserSettings(readBack)
      return readBack.goons_settings?.dockOpen === open ? 'saved' : 'unknown'
    } catch {
      return rejected ? 'failed' : 'unknown'
    }
  }
  // SA-113 P4 (DL-113-10a): the Agent DMs drawer. The envelope that opens it renders only
  // for an agent with Agent DMs on, so an instance that never turned them on gains nothing.
  let dmDrawerOpen = $state(false)
  const sidebar = useSidebar()
  let sidebarWasOpen: boolean | null = null
  let overlayListenerCleanup: (() => void) | null = null
  let goonStageEl = $state<HTMLDivElement | null>(null)
  let goonStageRect = $state<{ left: number; top: number; width: number; height: number } | null>(null)
  let goonStageObserver: ResizeObserver | null = null
  let sidebarOverlayPointerCleanup: (() => void) | null = null

const userSettings = $derived(getUserSettings())
const voiceSettings = $derived(normalizeVoiceSettings(userSettings?.voice_settings))
const goons = $derived(getGoons())
const goonAnimationLibrary = $derived(getGoonAnimationLibrary())
const playbackState = $derived(getPlaybackState())
const goonsSettings = $derived.by<GoonsSettings>(() =>
  normalizeGoonsSettings(userSettings?.goons_settings ?? null)
)
const desktopGoonPreferences = $derived(
  normalizeDesktopGoonPreferences(goonsSettings.desktop)
)
const goonLipSyncMode = $derived(voiceSettings.goonLipSync?.mode ?? 'amplitude')
const premiumGoonLipSyncAnalyzer = $derived(voiceSettings.goonLipSync?.analyzerId ?? 'rhubarb-wasm')
const goonLipSyncLabEnabled = $derived(Boolean(userSettings?.admin_settings?.goon_lip_sync_lab_enabled))
const immersiveMode = $derived.by(() => Boolean(goonsSettings?.immersiveMode))
const goonDcmPresentationMode = $derived(
  resolveVisibleGoonPresentationMode({
    dockOpen: goonsPanelOpen,
    immersiveMode,
    desktopModeActive
  })
)
const goonPresentationVisible = $derived(Boolean(goonDcmPresentationMode))
const sharedGoonAnimations = $derived.by(() =>
  Array.isArray(goonAnimationLibrary?.vrma) ? goonAnimationLibrary.vrma : []
)
let streamingSpeakerId = $state<string | null>(null)

function resolveSpeechVoiceSettings(agentId?: string | null) {
  const agentVoiceProfile = agentId ? agentStore.getAgentById(agentId)?.voice_profile : null
  return resolveVoiceSettingsForSpeech(voiceSettings, agentVoiceProfile ?? null)
}
const currentSession = $derived(sessionStore.getCurrentSession())
const currentRunState = $derived(chatRunRegistry.getRunState(currentSessionId))
const currentAIMessageId = $derived(currentRunState.activeMessageId ?? null)
const activeStreamCount = $derived(currentRunState.activeStreamMessageIds.length)
const activeToolMessageIds = $derived(currentRunState.activeToolMessageIds)
const activeToolCallNamesByMessageId = $derived(currentRunState.activeToolCallNamesByMessageId)
const currentTrimmedMessageIds = $derived.by(() => {
  const sessionId = currentSessionId
  if (!sessionId) return []
  return trimmedMessageIdsBySession[sessionId] ?? []
})
const currentManualTrimEstimate = $derived.by(() => {
  const sessionId = currentSessionId
  if (!sessionId) return null
  return manualTrimEstimateBySession[sessionId] ?? null
})
const currentManualTrimProtections = $derived.by(() => {
  manualTrimProtectionVersion
  return getCurrentManualTrimProtections()
})
const currentCompactionEvents = $derived.by(() =>
  getContextCompactionState(currentSession?.metadata ?? null).events
)
const currentCompactedMessageIds = $derived.by(() =>
  getCompactedMessageIds(currentCompactionEvents)
)
const currentCompactedMessageIdSet = $derived.by(() => new Set(currentCompactedMessageIds))
const compactedMessages = $derived.by<Message[]>(() =>
  // SA-104 P6: Infinite-Session graduation joins the compaction application so the chat
  // view, token math, and every send path see the graduated window (no-op for
  // regular sessions — DL-104-12).
  applyFixedSessionGraduationToMessages(
    applyContextCompactionToMessages(messages, currentCompactionEvents),
    currentSession
  )
)
const currentEffectiveTrimmedMessageIds = $derived.by(() => {
  if (currentTrimmedMessageIds.length === 0) return []
  const trimmedSet = new Set(currentTrimmedMessageIds)
  return messages
    .filter(
      (message) =>
        trimmedSet.has(message.id) &&
        !currentCompactedMessageIdSet.has(message.id) &&
        !isMessageProtectedFromManualTrim(message, currentManualTrimProtections)
    )
    .map((message) => message.id)
})
const effectiveMessages = $derived.by<Message[]>(() =>
  applyManualTrimToMessages(compactedMessages, currentEffectiveTrimmedMessageIds, {
    protections: currentManualTrimProtections,
    sessionId: currentSessionId ?? undefined,
    userId: data.user?.id
  })
)
const trimmedTokens = $derived(calculateTrimmedTokens(messages, currentEffectiveTrimmedMessageIds))
const compactedTokens = $derived(calculateCompactedTokens(messages, currentCompactionEvents))
const activeGroupId = $derived.by(() => currentSession?.metadata?.group_chat?.group_id ?? null)
const groupChatActive = $derived(Boolean(activeGroupId))
const activeGroup = $derived.by(() =>
  activeGroupId ? groupStore.getGroupById(activeGroupId) : null
)
// Match the group runner's threshold, not merely the presence of group metadata.
// Such chats cannot resume old/converted approval cards and hold no steer words.
const compactGroupRunnerSession = $derived.by(() => {
  const agentIds = Array.isArray(activeGroup?.agent_ids)
    ? activeGroup.agent_ids
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    : []
  return new Set(agentIds).size >= 2
})
function getGroupChatIdForSession(sessionId?: string | null) {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalized) return null
  const session =
    currentSession?.id === normalized
      ? currentSession
      : sessionStore.getSessions().find((candidate) => candidate.id === normalized)
  const groupId = session?.metadata?.group_chat?.group_id
  return typeof groupId === 'string' && groupId.trim().length > 0 ? groupId.trim() : null
}
const activeGroupDriverAgentId = $derived.by(() => {
  const group = activeGroup
  if (!group) return null
  const driverId =
    typeof group.driver_agent_id === 'string' ? group.driver_agent_id.trim() : ''
  if (!driverId) return null
  if (!group.agent_ids?.includes(driverId)) return null
  return driverId
})
const resolvedDesktopGoonSpeaker = $derived.by(() =>
  resolveDesktopGoonActiveSpeaker({
    audiblePlaybackAgentId: playbackState.activeAgentId,
    currentSessionId,
    activeStream: {
      active: activeStreamCount > 0,
      agentId: streamingSpeakerId,
      sessionId: currentSessionId
    },
    groupDriverAgentId: activeGroupDriverAgentId,
    groupAgentIds: activeGroup?.agent_ids ?? [],
    currentAgentId: agentStore.getCurrentAgentId()
  })
)
const dockAgentId = $derived(resolvedDesktopGoonSpeaker?.agentId ?? null)
const dockAgent = $derived.by(() =>
  dockAgentId ? agentStore.getAgentById(dockAgentId) : agentStore.getCurrentAgent()
)
const activeSpeakerId = $derived(resolvedDesktopGoonSpeaker?.agentId ?? null)
const activeSpeaker = $derived.by(() =>
  activeSpeakerId ? agentStore.getAgentById(activeSpeakerId) : agentStore.getCurrentAgent()
)
const activeModelPreset = $derived.by(() =>
  resolveAgentPrimarySavedModel(agentStore.getCurrentAgent(), savedModels)
)
const effectiveAutoCompactSettings = $derived.by(() =>
  resolveEffectiveAutoCompactSettings({
    global: userSettings?.global_auto_compact_settings,
    agent: agentStore.getCurrentAgent()?.auto_compact_settings
  })
)
const contextUsage = $derived.by(() => {
  const settingsKey = getContextPreviewSettingsKey()
  const matchingPreview = settingsKey && currentLiveContextEstimate?.settingsKey === settingsKey
    ? currentLiveContextEstimate : null
  return summarizeContextUsage({
    messages: effectiveMessages,
    snapshots: executionSnapshots,
    activeModel: activeModelPreset,
    agent: agentStore.getCurrentAgent(),
    manualTrimActive: currentEffectiveTrimmedMessageIds.length > 0,
    manualTrimEstimateTokens: currentManualTrimEstimate?.afterTokens ?? null,
    liveContextEstimateTokens: matchingPreview?.tokens ?? null,
    liveContextEstimateReason: matchingPreview?.reason ?? null,
    liveContextLimit: matchingPreview?.contextLimit ?? null,
    liveLocalContext: matchingPreview?.localContext ?? null,
    now: localContextClock,
    liveContextWindowWarning: matchingPreview?.contextWindowWarning ?? null,
    liveContextCheckedAt: matchingPreview?.contextWindowCheckedAt ?? null,
    claudeContextEnvironment: data.claudeContextEnvironment
  })
})
const currentTokens = $derived(contextUsage.displayTokens)
const contextLimit = $derived(contextUsage.contextLimit)
const autoCompactTriggerTokens = $derived(
  resolveAutoCompactTriggerTokens(effectiveAutoCompactSettings, contextLimit)
)
// SA-104 P6: Infinite Sessions replace Compact with the nap (DL-104-07).
const currentSessionFixed = $derived(isFixedSession(currentSession))

// SA-113 P1 (DL-113-08): null for every chat the user started, so the banner never
// renders for an ordinary session.
const currentSessionOrigin = $derived(resolveSessionOrigin(currentSession))
// DL-115-09: keyed by kind, with a neutral fallback. The binary if/else this replaced
// would have labelled every schedule-started chat with a webhook icon.
const ChatOriginIcon = $derived(
  currentSessionOrigin ? sessionOriginIcon(currentSessionOrigin) : Sparkles
)
const currentMemoryWindow = $derived.by(() => {
  if (!currentSessionFixed) return null
  const agent = agentStore.getCurrentAgent()
  if (!agent || !resolveAgentMemoryEnabled(agent)) return null
  return resolveEffectiveMemoryWindow(resolveMemoryWindowSettings(agent), contextLimit)
})
const napAvailable = $derived.by(() =>
  Boolean(
    currentSessionFixed &&
      currentSessionId &&
      agentStore.getCurrentAgent()?.id &&
      resolveAgentMemoryEnabled(agentStore.getCurrentAgent())
  )
)
const napUnavailableReason = $derived.by(() => {
  if (!currentSessionFixed) return 'Naps run only in Infinite Sessions.'
  if (!resolveAgentMemoryEnabled(agentStore.getCurrentAgent())) {
    return 'Naps need agent memory enabled (Agent Settings → Memory).'
  }
  if (!currentMemoryWindow) {
    return 'Batshit could not resolve a model context limit for this agent, so the nap threshold is unknown. Manual naps still work.'
  }
  return 'Nap is available.'
})
const compactAvailable = $derived.by(() => {
  if (!currentSessionId || !agentStore.getCurrentAgent()?.id) return false
  if (currentSessionFixed) return false
  if (!compactGroupRunnerSession && hasPendingCompactApproval(messages, currentCompactionEvents)) return false
  const selection = selectMessagesForCompaction(messages, currentCompactionEvents, {
    protections: currentManualTrimProtections
  })
  return selection.compactedMessageCount > 0
})
const compactUnavailableReason = $derived.by(() => {
  if (!currentSessionId || !agentStore.getCurrentAgent()?.id) {
    return 'Compact needs an active chat session and agent.'
  }
  if (currentSessionFixed) {
    return 'Infinite Sessions do not use Compact — context relief happens through episode graduation and naps.'
  }
  if (!compactGroupRunnerSession && hasPendingCompactApproval(messages, currentCompactionEvents)) return COMPACT_PENDING_APPROVAL_MESSAGE
  const selection = selectMessagesForCompaction(messages, currentCompactionEvents, {
    protections: currentManualTrimProtections
  })
  if (selection.compactedMessageCount <= 0) {
    return 'No older unprotected messages are available to compact.'
  }
  return 'Compact is available.'
})
const runningCost = $derived.by(() =>
  summarizeRunningCost(
    executionSnapshots,
    activeModelPreset,
    agentStore.getCurrentAgent(),
    savedModels
  )
)
const delegatedCostDetail = $derived.by(() => {
  if (runningCost.delegatedRunCount <= 0) return null
  const tokens =
    runningCost.delegatedTokens === null
      ? 'Unknown tokens'
      : `${Math.round(runningCost.delegatedTokens).toLocaleString()} tokens`
  const cost =
    runningCost.delegatedCost === null
      ? 'Unknown cost'
      : runningCost.delegatedCost.toLocaleString(undefined, {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        })
  const unknownRuns = Math.max(
    runningCost.delegatedUsageUnknownRuns,
    runningCost.delegatedCostUnknownRuns
  )
  const incomplete =
    unknownRuns > 0
      ? ` (${unknownRuns} ${unknownRuns === 1 ? 'run has' : 'runs have'} incomplete usage or pricing)`
      : ''
  return `Delegated (subagents/workers): ${tokens} · ${cost}${incomplete}`
})
// SA-093 P7: cache/speed strip stats from the LATEST assistant message only.
// Older responses never stand in for the latest one (DL-093-14 honesty rule);
// a missing metric renders as an explicit unknown in TokenPanel.
const latestResponseStats = $derived.by(() => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; metadata?: Record<string, any> }
    if (message?.role !== 'assistant') continue
    const metadata =
      message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
    const usage =
      metadata.usage && typeof metadata.usage === 'object' ? metadata.usage : null
    const performance =
      metadata.performance && typeof metadata.performance === 'object'
        ? metadata.performance
        : null
    return { found: true, usage, performance }
  }
  return { found: false, usage: null, performance: null }
})
const latestCacheHitPercent = $derived(
  computeCacheHitRatePercent(latestResponseStats.usage)
)
/**
 * SA-102 P4 (DL-102-13): which local AI program this chat is talking to, by
 * name, and whether it reports cached prompt tokens at all. The Token Panel
 * needs both so it can say "LM Studio does not report this" instead of showing
 * a dash that reads like a cache miss.
 */
const activeLocalProgramDefinition = $derived.by(() => {
  const provider = (
    activeModelPreset?.connection?.service ??
    activeModelPreset?.provider ??
    ''
  )
    .trim()
    .toLowerCase()
  if (!provider) return null
  return LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === provider) ?? null
})
const activeLocalProgramLabel = $derived(activeLocalProgramDefinition?.label ?? null)
const activeLocalCacheReporting = $derived(
  activeLocalProgramDefinition?.supports.promptCacheReporting ?? null
)
const latestCacheCachedTokens = $derived.by(() => {
  const usage = latestResponseStats.usage
  const cached = usage?.cachedInputTokens ?? usage?.inputTokenDetails?.cacheReadTokens
  return typeof cached === 'number' && Number.isFinite(cached) ? cached : null
})
const latestCacheInputTokens = $derived.by(() => {
  const inputTokens = latestResponseStats.usage?.inputTokens
  return typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? inputTokens : null
})
const latestCacheCreationTokens = $derived.by(() => {
  const created = latestResponseStats.usage?.cacheCreationInputTokens
  return typeof created === 'number' && Number.isFinite(created) ? created : null
})
const latestPerformanceStat = (key: 'outputTokensPerSecond' | 'timeToFirstOutputMs' | 'responseTimeMs' | 'modelCalls') => {
  const value = latestResponseStats.performance?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
// SA-093 P7: whole-chat token-weighted cache aggregate for the strip popover.
// Only responses that reported cache usage count; the popover names the count.
const sessionCacheStats = $derived.by(() => {
  const usages: Array<Record<string, any>> = []
  for (const message of messages) {
    const entry = message as { role?: string; metadata?: Record<string, any> }
    if (entry?.role !== 'assistant') continue
    const usage =
      entry.metadata && typeof entry.metadata === 'object' && entry.metadata.usage &&
      typeof entry.metadata.usage === 'object'
        ? entry.metadata.usage
        : null
    if (usage) usages.push(usage)
  }
  return computeSessionCacheAggregate(usages)
})
const activeGoon = $derived.by(() => {
  const goonId = dockAgent?.goon_id
  if (!goonId) return null
  const assigned = goons.find((entry) => entry.id === goonId) || null
  return isGoonRuntimeReady(assigned) ? assigned : null
})
const dockAgentSpeaking = $derived.by(
  () =>
    Boolean(dockAgentId) &&
    (playbackState.activeAgentId === dockAgentId || streamingSpeakerId === dockAgentId)
)
const goonSpeaking = $derived(Boolean(playbackState.activeAgentId) || activeStreamCount > 0)
const immersiveActive = $derived.by(
  () => goonsPanelOpen && immersiveMode && Boolean(goonStageRect?.width) && Boolean(goonStageRect?.height)
)

  // Tool results now come as XML inline - no need for separate tracking

  // Loading state tracking
  let isWaitingForResponse = $state(false)
  let isWaitingForToolCall = $state(false)
  let thinkingSubjects = $state<Record<string, string>>({})
  let planSubjects = $state<Record<string, { content?: string; items?: any[] }>>({})
  let objectSubjects = $state<Record<string, any>>({})

	  // SA-911: Option D "Pause and Process" state
	  // When a tool-call arrives, we pause text streaming and buffer chunks until tool-result
	  let isProcessingTool = $state(false)
	  const activeToolProcessingIds = new Set<string>()
  const toolOrderDebugCounts = new Map<string, number>()
  type ToolProcessingState = {
    isProcessing: boolean
    pendingChunks: string[]
  }
  let toolInsertionSequence = 0
  const toolStreamStates = new Map<string, ToolStreamState>()
  const toolProcessingStates = new Map<string, ToolProcessingState>()

	  // SA-081: active run state is keyed by session, not by the page.
	  function resolveOwningSessionId(messageId?: string | null, fallbackSessionId?: string | null) {
	    if (fallbackSessionId) return fallbackSessionId
	    if (eventSessionContext) return eventSessionContext
	    if (messageId) {
	      const message = messageStore.getMessage(messageId)
	      if (message?.session_id) return message.session_id
	    }
	    return sessionStore.getCurrentSessionId()
	  }

	  function registerActiveMessage(messageId: string, sessionId?: string | null) {
	    const ownerSessionId = resolveOwningSessionId(messageId, sessionId)
	    if (!ownerSessionId) {
	      logger.warn('[run-state] Cannot register active message without session owner', { messageId })
	      return
	    }
	    chatRunRegistry.markStreaming(ownerSessionId, messageId)
	  }

	  function unregisterActiveMessage(messageId: string, sessionId?: string | null) {
	    const ownerSessionId = resolveOwningSessionId(messageId, sessionId)
	    if (!ownerSessionId) return
	    chatRunRegistry.removeActiveMessage(ownerSessionId, messageId)
	    scheduleSseDisconnectIfIdle(ownerSessionId)
	  }

	  function resolveStreamMessageId(messageId?: string | null, sessionId?: string | null) {
	    if (messageId) return messageId
	    const ownerSessionId = resolveOwningSessionId(null, sessionId)
	    if (!ownerSessionId) return null
	    return chatRunRegistry.getRunState(ownerSessionId).activeMessageId ?? null
	  }

	  function isMessageActive(messageId: string, sessionId?: string | null) {
	    const ownerSessionId = resolveOwningSessionId(messageId, sessionId)
	    return ownerSessionId
	      ? chatRunRegistry.getRunState(ownerSessionId).activeStreamMessageIds.includes(messageId)
	      : false
	  }

  const interruptWaiters = new Map<
    string,
    { resolve: () => void; timeout: ReturnType<typeof setTimeout> }
  >()
  /**
   * BL-361: replies this tab drew itself after a Stop (the 1.5 s wait for `end` ran out). A
   * late `end` for one of them that the server finalized is taken, not ignored
   * (`shouldAcceptLateEndAfterStopFallback`). Plain Set: nothing renders from it.
   */
  const savedByStopFallbackMessageIds = new Set<string>()

  function resolveStreamCompletion(messageId: string) {
    const waiter = interruptWaiters.get(messageId)
    if (!waiter) return
    clearTimeout(waiter.timeout)
    waiter.resolve()
    interruptWaiters.delete(messageId)
  }

  function waitForStreamCompletion(messageId: string, timeoutMs = 8000) {
    const existing = messageStore.getMessage(messageId)
    if (existing && (existing.status === 'complete' || existing.status === 'error')) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        interruptWaiters.delete(messageId)
        resolve()
      }, timeoutMs)

      interruptWaiters.set(messageId, { resolve, timeout })
    })
  }

  function wait(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  async function parseJsonResponse(response: Response): Promise<Record<string, any>> {
    const payload = await response.json().catch(() => ({}))
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  }

  /**
   * The send, and its retry after a Stop. Resolves with the turn's FINAL answer: since 2026-09-18
   * `postSendRouted` is answered once the server owns the turn and waits for the answer over the
   * live hub, so a running reply no longer holds one of the browser's six connections (five
   * replies at once froze every other request of every tab, Stop included).
   */
  async function postSendRoutedWithInterruptRetry(params: {
    body: Record<string, any>
    signal: AbortSignal
    wasInterrupting: boolean
    /** Called once the server owns the send (its 202), before the turn's final answer. */
    onAccepted?: () => void
  }): Promise<{ response: Response; errorPayload?: Record<string, any> }> {
    const bodyText = JSON.stringify(params.body)
    let attemptIndex = 0

    while (true) {
      const response = await postSendRouted(bodyText, {
        signal: params.signal,
        onAccepted: params.onAccepted
      })

      if (response.ok) {
        return { response }
      }

      const errorPayload = await parseJsonResponse(response)
      const shouldRetry = shouldRetryInterruptedSendAfterSessionTurnInProgress({
        wasInterrupting: params.wasInterrupting,
        status: response.status,
        payload: errorPayload,
        attemptIndex,
        maxAttempts: INTERRUPTED_SEND_RETRY_DELAYS_MS.length
      })

      if (!shouldRetry) {
        return { response, errorPayload }
      }

      const delayMs = INTERRUPTED_SEND_RETRY_DELAYS_MS[attemptIndex] ?? 0
      attemptIndex += 1
      logger.debug('[handleSendMessage] Waiting for interrupted session turn to release', {
        attemptIndex,
        delayMs
      })
      await wait(delayMs)
    }
  }

  /**
   * SA-114 P3 (DL-114-14) — hand a steer to the server.
   *
   * Three answers matter and they are genuinely different:
   *
   * - `accepted` — 202. The server owns the text now; nothing else on the client runs.
   * - `already_finished` — the reply ended between the button and the route. There is
   *   nothing to interrupt, so the caller sends it as an ordinary message rather than
   *   stopping a turn that already stopped.
   * - `queue` — this agent, or this transport, cannot carry a mid-reply message. SA-119
   *   (DL-119-07) renamed this outcome from `not_steerable`: the words now wait for the
   *   reply to end rather than stopping it, which is what the user asked for rather than
   *   the Stop they did not: the send goes as an ordinary message and waits in the chat's
   *   line (BL-713).
   *
   * A network failure is `refused`, with a plain sentence.
   */
  async function postSteer(params: {
    sessionId: string
    messageId: string
    steerId: string
    text: string
    /** DL-119-05: `now` lands inside this reply; `end` is held until the reply finishes. */
    deliver: SteerDeliver
  }): Promise<
    | { kind: 'accepted' }
    | { kind: 'already_finished' }
    | { kind: 'queue'; reason: string }
    | { kind: 'refused'; reason: string }
  > {
    try {
      const response = await fetch('/api/messages/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      })

      if (response.ok) return { kind: 'accepted' }

      const payload = await parseJsonResponse(response)
      const reason =
        typeof payload?.reason === 'string' && payload.reason.trim()
          ? payload.reason.trim()
          : typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            // F-P1-2: this used to be a hand-copy of the module's sentence, which is how the
            // two came to disagree the moment DL-119-07 changed one of them.
            : STEER_REFUSED_UNKNOWN_SENTENCE

      // PR #106 review F-4: `classifySteerRefusal` is THE rule. Only `reply_finished` (send
      // normally) and `not_steerable` (DL-119-07: queue) may escalate; the cap, a waiting DM,
      // a bad request and a lost server all `refuse` — the reply keeps running and nothing is
      // lost.
      const kind = classifySteerRefusal(response.status, payload)
      if (kind === 'already_finished') return { kind: 'already_finished' }
      return { kind, reason }
    } catch (error) {
      console.error('[handleSendMessage] Failed to steer:', error)
      return {
        kind: 'refused',
        reason: 'Batshit could not reach the server to steer. Your message was not sent — try again.'
      }
    }
  }

  const CLAUDE_APPROVAL_TOOL_SLUG = 'batshit_permission_prompt'

  function isClaudeApprovalTool(toolName?: string | null) {
    if (!toolName) return false
    return toolName.toLowerCase().includes(CLAUDE_APPROVAL_TOOL_SLUG)
  }

  function extractClaudeApprovalDetails(data: any) {
    const args =
      data && typeof data.args === 'object' && data.args
        ? data.args
        : (data && typeof data.input === 'object' ? data.input : {})
    const approvalId =
      (typeof data?.approvalId === 'string' && data.approvalId.trim().length > 0
        ? data.approvalId.trim()
        : typeof data?.approval_id === 'string' && data.approval_id.trim().length > 0
          ? data.approval_id.trim()
          : typeof args.approvalId === 'string' && args.approvalId.trim().length > 0
        ? args.approvalId.trim()
        : typeof args.requestId === 'string' && args.requestId.trim().length > 0
          ? args.requestId.trim()
          : typeof args.id === 'string' && args.id.trim().length > 0
            ? args.id.trim()
            : typeof data?.toolCallId === 'string' && data.toolCallId.trim().length > 0
              ? data.toolCallId.trim()
              : crypto.randomUUID())
    const toolName =
      (typeof args.toolName === 'string' && args.toolName.trim().length > 0
        ? args.toolName.trim()
        : typeof args.tool === 'string' && args.tool.trim().length > 0
          ? args.tool.trim()
          : typeof args.name === 'string' && args.name.trim().length > 0
            ? args.name.trim()
            : typeof args.tool_name === 'string' && args.tool_name.trim().length > 0
              ? args.tool_name.trim()
              : typeof data?.toolName === 'string' && data.toolName.trim().length > 0
                ? data.toolName.trim()
                : typeof data?.tool_name === 'string' && data.tool_name.trim().length > 0
                  ? data.tool_name.trim()
                  : undefined)
    const input =
      args.toolInput ??
      args.input ??
      args.arguments ??
      args.params ??
      data?.input ??
      data?.args ??
      args
    const toolCall =
      args.toolCall ??
      data?.toolCall ??
      data?.tool_call ??
      (toolName ? { toolName, input } : undefined)
    return { approvalId, toolName, input, toolCall }
  }

  function extractApprovalTimestamps(data: any) {
    const requestedAt =
      typeof data?.requestedAt === 'string' && data.requestedAt.trim().length > 0
        ? data.requestedAt.trim()
        : undefined
    const expiresAt =
      typeof data?.expiresAt === 'string' && data.expiresAt.trim().length > 0
        ? data.expiresAt.trim()
        : undefined
    return { requestedAt, expiresAt }
  }

  function resolveAgentIdFromEvent(data: any) {
    return (
      data?.metadata?.agentId ||
      data?.metadata?.agent_id ||
      data?.agentId ||
      agentStore.getCurrentAgentId() ||
      undefined
    )
  }

  function resolveMessage(messageId?: string | null) {
    messageId = resolveStreamMessageId(messageId)
    if (!messageId) return undefined
    return messageStore.getMessage(messageId) ?? undefined
  }

  function logToolOrderEvent(
    tag: string,
    messageId: string,
    content: string,
    extra: Record<string, any> = {}
  ) {
    const currentCount = toolOrderDebugCounts.get(messageId) ?? 0
    if (currentCount >= 12) return
    toolOrderDebugCounts.set(messageId, currentCount + 1)

    const toolIndex = content.lastIndexOf('batshit-zip:cool_tool_')
    const snippet =
      toolIndex === -1
        ? ''
        : content.slice(Math.max(0, toolIndex - 40), Math.min(content.length, toolIndex + 60))
    const payload = {
      tag,
      seq: currentCount + 1,
      messageId,
      length: content.length,
      toolIndex,
      snippet,
      ...extra
    }
    logger.debug('[ToolOrder]', JSON.stringify(payload))
  }

  function normalizePlanItems(raw: any): Array<{ text: string; completed?: boolean }> {
    const source =
      Array.isArray(raw) ? raw :
      Array.isArray(raw?.items) ? raw.items :
      Array.isArray(raw?.item?.items) ? raw.item.items :
      Array.isArray(raw?.todo) ? raw.todo :
      Array.isArray(raw?.list) ? raw.list :
      []

    if (!Array.isArray(source)) return []

    return source
      .map((entry: any) => {
        const text =
          typeof entry?.text === 'string'
            ? entry.text
            : typeof entry?.content === 'string'
              ? entry.content
              : typeof entry?.title === 'string'
                ? entry.title
                : ''
        if (!text) return null
        return {
          text,
          completed: Boolean(entry?.completed)
        }
      })
      .filter(Boolean) as Array<{ text: string; completed?: boolean }>
  }

  function formatPlanSummary(items: Array<{ text: string; completed?: boolean }>) {
    return items
      .map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`)
      .join('\n')
  }

  function resolveReasoningFlags(messageId?: string | null) {
    const targetMessage = messageId ? resolveMessage(messageId) : undefined
    const agentForMessage = targetMessage?.agent_id
      ? agentStore.getAgentById(targetMessage.agent_id)
      : agentStore.getCurrentAgent()
    const showReasoning =
      typeof (agentForMessage as any)?.show_reasoning === 'boolean'
        ? Boolean((agentForMessage as any).show_reasoning)
        : shouldShowReasoningByDefaultForPrimaryAgent(
            normalizePrimaryAgentType(agentForMessage as any)
          )
    const preserveReasoning =
      typeof (agentForMessage as any)?.preserve_reasoning === 'boolean'
        ? Boolean((agentForMessage as any).preserve_reasoning)
        : false
    return { showReasoning, preserveReasoning }
  }

  function clearThinkingIndicator(messageId: string) {
    if (!isThinkingIndicator(thinkingSubjects[messageId])) return
    const updatedSubjects = { ...thinkingSubjects }
    delete updatedSubjects[messageId]
    thinkingSubjects = updatedSubjects
  }

  async function generateClientMessageId(sessionId: string, fallbackPrefix = 'msg_client') {
    try {
      const idResponse = await fetch('/api/messages/generate-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      })

      if (!idResponse.ok) {
        throw new Error('Failed to generate message ID')
      }

      const { id } = await idResponse.json()
      if (typeof id === 'string' && id.trim().length > 0) {
        return id.trim()
      }
      throw new Error('Message ID response was empty')
    } catch (error) {
      console.error('Failed to generate message ID, falling back to UUID:', error)
      return `${fallbackPrefix}_${crypto.randomUUID()}`
    }
  }

  function createAssistantWaitingPlaceholder({
    messageId,
    sessionId,
    agentId,
    userId,
    metadata = {}
  }: {
    messageId: string
    sessionId: string
    agentId: string
    userId: string
    metadata?: Record<string, any>
  }) {
    messageStore.addMessage({
      id: messageId,
      content: '',
      role: 'assistant',
      session_id: sessionId,
      agent_id: agentId,
      user_id: userId,
      status: 'in_progress',
      metadata: {
        ...metadata,
        client_waiting_placeholder: true
      }
    })
    registerActiveMessage(messageId)
    resetToolStateForMessage(messageId)
    thinkingSubjects = {
      ...thinkingSubjects,
      [messageId]: THINKING_INDICATOR
    }
  }

  function markAssistantWaitingPlaceholderError(messageId: string | null, message: string) {
    if (!messageId) return
    const existing = messageStore.getMessage(messageId)
    if (!existing || existing.status !== 'in_progress' || existing.content) return

    messageStore.updateMessage(messageId, {
      content: message,
      status: 'error'
    })
    clearThinkingIndicator(messageId)
    unregisterActiveMessage(messageId)
    resetToolStateForMessage(messageId)
    resolveStreamCompletion(messageId)
  }

  function isFinalizedMessage(messageId: string | null | undefined) {
    if (!messageId) return false
    const existing = messageStore.getMessage(messageId)
    return existing?.status === 'complete' || existing?.status === 'error'
  }

  function ignoreLateEventForFinalizedMessage(messageId: string | null | undefined, eventType: string) {
    if (!isFinalizedMessage(messageId)) return false
    logger.debug('[SSE] Ignoring late event for finalized message', { messageId, eventType })
    if (messageId) {
      unregisterActiveMessage(messageId)
      resetToolStateForMessage(messageId)
      resolveStreamCompletion(messageId)
    }
    return true
  }

  async function finalizeActiveAssistantMessageAsInterrupted(messageId: string | null) {
    if (!messageId) return false

    const existing = messageStore.getMessage(messageId)
    if (!existing) {
      unregisterActiveMessage(messageId)
      resetToolStateForMessage(messageId)
      resolveStreamCompletion(messageId)
      return false
    }

    if (existing.status === 'complete' || existing.status === 'error') {
      unregisterActiveMessage(messageId)
      resetToolStateForMessage(messageId)
      resolveStreamCompletion(messageId)
      return false
    }

    // BL-361: remembered, so a late `end` the server finalized replaces this copy on screen.
    savedByStopFallbackMessageIds.add(messageId)

    messageStore.updateMessage(messageId, {
      // BL-361: the streamed copy can still hold raw control blocks the server strips at its
      // reply end; the fallback save strips them with the server's own reader.
      content: buildStopFallbackContent(existing.content),
      status: 'complete',
      metadata: {
        ...(existing.metadata || {}),
        interrupted: true,
        interruptionReason: 'user',
        interruptedAt: new Date().toISOString()
      }
    })

    // SA-114 P3: a stopped turn promotes nothing, so anything still waiting is gone.
    settleSteerBubblesForMessage(existing.session_id, messageId, { interrupted: true })

    clearThinkingIndicator(messageId)
    unregisterActiveMessage(messageId)
    resetToolStateForMessage(messageId)
    resolveStreamCompletion(messageId)
    isWaitingForResponse = false
    syncActiveToolProcessingState()
    if (chatInputRef?.aiResponseReceived) {
      chatInputRef.aiResponseReceived()
    }

    // BL-775: the server saves a stopped reply itself (its finalize, one retry, then a plain
    // error to the tabs); this copy is only what the tab shows until the server's `end` arrives.
    return true
  }

  function resolveToolKey(data: any, messageId?: string | null) {
    const toolCallId = typeof data?.toolCallId === 'string' ? data.toolCallId : ''
    if (toolCallId) return toolCallId
    const placeholderId = typeof data?.placeholderId === 'string' ? data.placeholderId : ''
    if (placeholderId) return placeholderId
    const order = typeof data?.order === 'number' ? data.order : null
    if (messageId && order !== null) return `${messageId}-order-${order}`
    return null
  }

  const buildToolStreamState = (content: string) =>
    buildToolStreamStateFromContent(content, () => toolInsertionSequence++)

  function getOrCreateToolStreamState(messageId: string, initialContent = '') {
    let state = toolStreamStates.get(messageId)
    if (!state) {
      state = buildToolStreamState(initialContent)
      toolStreamStates.set(messageId, state)
    }
    return state
  }

  const composeToolStreamContent = (state: ToolStreamState) =>
    composeToolStreamContentBase(state)

  function getToolProcessingState(messageId: string) {
    let state = toolProcessingStates.get(messageId)
    if (!state) {
      state = { isProcessing: false, pendingChunks: [] }
      toolProcessingStates.set(messageId, state)
    }
    return state
  }

	  function syncActiveToolProcessingState() {
	    const selectedSessionId = sessionStore.getCurrentSessionId()
	    const activeIds = selectedSessionId
	      ? chatRunRegistry.getRunState(selectedSessionId).activeToolMessageIds
	      : []
	    const hasActiveTools = activeIds.length > 0
	    isProcessingTool = hasActiveTools
	    isWaitingForToolCall = hasActiveTools
	  }

	  function setActiveToolCallName(messageId: string, toolName: string) {
	    if (!toolName.trim()) return
	    const ownerSessionId = resolveOwningSessionId(messageId)
	    if (!ownerSessionId) return
	    chatRunRegistry.setToolProcessing(ownerSessionId, messageId, toolName)
	  }

	  function clearActiveToolCallName(messageId: string) {
	    const ownerSessionId = resolveOwningSessionId(messageId)
	    if (!ownerSessionId) return
	    chatRunRegistry.clearToolProcessing(ownerSessionId, messageId)
	  }

	  function clearActiveToolProcessingState(sessionId?: string | null) {
	    const ownerSessionId = resolveOwningSessionId(null, sessionId)
	    if (ownerSessionId) {
	      for (const messageId of chatRunRegistry.getRunState(ownerSessionId).activeToolMessageIds) {
	        activeToolProcessingIds.delete(messageId)
	      }
	      chatRunRegistry.clearAllToolProcessing(ownerSessionId)
	    } else {
	      activeToolProcessingIds.clear()
	    }
	    isProcessingTool = false
	    isWaitingForToolCall = false
	  }

	  function setToolProcessing(messageId: string, isProcessing: boolean) {
	    const ownerSessionId = resolveOwningSessionId(messageId)
	    const state = getToolProcessingState(messageId)
	    state.isProcessing = isProcessing

	    if (isProcessing) {
	      activeToolProcessingIds.add(messageId)
	      if (ownerSessionId) {
	        chatRunRegistry.setToolProcessing(ownerSessionId, messageId)
	      }
	    } else {
	      activeToolProcessingIds.delete(messageId)
	      clearActiveToolCallName(messageId)
	    }

    syncActiveToolProcessingState()
  }

  // SA-911: Flush buffered chunks for a single message after tool processing completes
  function flushPendingChunks(messageId: string) {
    const state = toolProcessingStates.get(messageId)
    if (!state || state.pendingChunks.length === 0) return

    logger.debug(`[SA-911] Flushing ${state.pendingChunks.length} buffered chunks`, { messageId })

    const combinedText = state.pendingChunks.join('')
    state.pendingChunks = []

    const targetMessage = resolveMessage(messageId)
    if (!targetMessage || targetMessage.status === 'complete') return

    const toolState = toolStreamStates.get(messageId)
    if (toolState) {
      toolState.textBuffer += combinedText
      const newContent = composeToolStreamContent(toolState)
      messageStore.updateMessage(messageId, { content: newContent })
    } else {
      const newContent = (targetMessage.content || '') + combinedText
      messageStore.updateMessage(messageId, { content: newContent })
    }

    appendRealtimeSpeechChunk(
      messageId,
      targetMessage.agent_id ?? null,
      targetMessage.metadata || {},
      combinedText
    )
  }

  // SA-911: Reset tool processing state for a message
  function resetToolStateForMessage(messageId: string) {
    toolStreamStates.delete(messageId)
    toolProcessingStates.delete(messageId)
    activeToolProcessingIds.delete(messageId)
    clearActiveToolCallName(messageId)
    toolOrderDebugCounts.delete(messageId)

    syncActiveToolProcessingState()
  }

  /**
   * SA-114 P3 (DL-114-14) — what happens to a steer's bubble when its reply ends.
   *
   * Three outcomes, and the reply itself says which:
   *
   * - **Delivered.** The steer now lives inside the assistant record and renders inline, so
   *   the optimistic bubble is removed. Leaving it would show the same words twice.
   * - **Stopped.** `Stop` does not promote (DL-114-07), so anything still waiting is gone.
   *   The bubble says so instead of quietly re-sending it, which is what "Stop means stop"
   *   has to mean from the user's side too.
   * - **Ended normally.** The server promotes what is still waiting, which arrives as
   *   `steer_promoted` about a second later — the bubble becomes the promoted user message
   *   on its own. The timer below is only the backstop for a promotion that never comes.
   */
  const steerSettleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const STEER_PROMOTION_GRACE_MS = 10_000

  function settleSteerBubblesForMessage(
    sessionId: string | null | undefined,
    messageId: string | null | undefined,
    options: { interrupted: boolean }
  ) {
    if (!sessionId || !messageId) return
    steerInbox.clearDeliveredSteersForMessage(sessionId, messageId)

    const stillWaiting = steerInbox
      .getSteersForMessage(sessionId, messageId)
      .filter((entry) => entry.state === 'queued')
    if (stillWaiting.length === 0) return

    if (options.interrupted) {
      for (const entry of stillWaiting) steerInbox.markSteerDropped(entry.steerId)
      return
    }

    // BL-455, BL-713: only what the SERVER still has to place inside the reply or promote. A send
    // waiting in the chat's line is settled by the server itself (it runs, is kept with its own
    // receipt, or its chat goes), and it can wait out an approval card long past this backstop.
    const awaitingServer = steerInbox.getSteersAwaitingServerForMessage(sessionId, messageId)
    if (awaitingServer.length === 0) return

    const armDropBackstop = (entry: { steerId: string }) => {
      const existingTimer = steerSettleTimers.get(entry.steerId)
      if (existingTimer) clearTimeout(existingTimer)
      steerSettleTimers.set(
        entry.steerId,
        setTimeout(() => {
          steerSettleTimers.delete(entry.steerId)
          // F-P3-4: a promotion can still be on its way behind a context-exhaustion
          // auto-continue chain, or behind the promoted turn itself — while this chat is
          // busy the words are late, not lost. Only a chat that has gone quiet with the
          // steer still waiting means the server never wrote it, and that is not a Stop.
          if (chatRunRegistry.isSessionBusy(sessionId)) {
            armDropBackstop(entry)
            return
          }
          steerInbox.markSteerDropped(entry.steerId, 'unanswered')
        }, STEER_PROMOTION_GRACE_MS)
      )
    }
    for (const entry of awaitingServer) armDropBackstop(entry)
  }

  /**
   * SA-119 P3b (AMD-119-05) — the two actions on a dropped bubble.
   *
   * A dropped bubble is a receipt for a message that never went. Josh's rule: the user must
   * not have to retype it, and the composer must not be refilled behind their back. So the
   * receipt itself carries **Send now** and **Dismiss**.
   */
  /**
   * The map is keyed by a bubble that may be gone. Pruned at the two places the store
   * clears dropped bubbles, so it can never outlive what it describes.
   */
  function prunePayloadsForForgottenSteers() {
    for (const steerId of [...resendableSteerPayloads.keys()]) {
      if (!steerInbox.getSteer(steerId)) resendableSteerPayloads.delete(steerId)
    }
  }

  function resendDroppedSteer(steerId: string) {
    const payload = resendableSteerPayloads.get(steerId)
    // No payload means this bubble came back from the replay buffer after a reload. The
    // button is not offered in that case; this is the belt to that braces.
    if (!payload) return
    // Review F-P3b-3: the button was drawn for a `dropped` bubble. If the bubble moved on
    // between the draw and the click, there is nothing left to re-send.
    if (steerInbox.getSteer(steerId)?.state !== 'dropped') return
    resendableSteerPayloads.delete(steerId)
    // The receipt goes first: the words are about to exist as a real message, and leaving
    // the bubble would show them twice — the duplicate this packet exists to remove.
    // CLEARED, not forgotten (review F-P3b-3): a forgotten id is free for the session
    // replay to rebuild on the next resubscribe, as a `queued` promise about a reply that
    // is over (AMD-118-08).
    steerInbox.clearDroppedSteer(steerId)
    // Exactly what was queued — the send's own facts, with the composer's closures already
    // stripped (review F-P3b-2). If the chat is busy again it queues again, which is the
    // same promise it made the first time. `fromDroppedReceipt` keeps the OTHER receipts in
    // the chat (review F-P3b-1): this click acts on one of them, not on all of them.
    void handleSendMessage(payload.content, payload.metadata, {
      fromDroppedReceipt: true,
      // BL-4: a queued send's receipt names the message it saved, which is still in the chat.
      // Send now sends THAT message (no second save), wherever the chat is by now.
      existingUserMessageId: payload.userMessageId
    })
  }

  /**
   * BL-4 — the server is holding this send until the chat is free (a reply another tab started
   * was already running). The words show once, as the Queue bubble after everything else, so
   * every tab takes the message out of its list until the send runs and the message comes back
   * at the end of the chat. The tab that sent it also drops its own reply placeholder (the reply
   * will open where it belongs, after the message) and keeps the exact send beside the bubble,
   * so a "Not sent" receipt for it can offer Send now.
   */
  function takeQueuedSendOutOfTheList(
    sessionId: string | null | undefined,
    notice: { userMessageId: string; assistantMessageId: string | null }
  ) {
    const targetSessionId = sessionId ?? null
    if (notice.assistantMessageId) {
      const placeholder = messageStore.getMessage(notice.assistantMessageId, targetSessionId)
      if (placeholder?.metadata?.client_waiting_placeholder === true && !placeholder.content) {
        clearThinkingIndicator(notice.assistantMessageId)
        unregisterActiveMessage(notice.assistantMessageId, targetSessionId)
        resetToolStateForMessage(notice.assistantMessageId)
        resolveStreamCompletion(notice.assistantMessageId)
        messageStore.deleteMessage(notice.assistantMessageId, targetSessionId)
      }
    }
    messageStore.deleteMessage(notice.userMessageId, targetSessionId)
    const ownSend = inFlightSendPayloads.get(notice.userMessageId)
    if (ownSend) {
      resendableSteerPayloads.set(notice.userMessageId, {
        ...ownSend,
        userMessageId: notice.userMessageId
      })
    }
  }

  /**
   * BL-4: a Send now sends a kept message now, so in this tab it becomes the chat's latest
   * message, dated this send, before the reply's placeholder is added after it. Nothing is
   * written: send-routed moves the stored copy when anything was said after it.
   */
  function moveResentMessageToEnd(sessionId: string, messageId: string, sentAt: string) {
    const kept = messageStore.getMessages(sessionId).find((message) => message.id === messageId)
    if (!kept) return
    messageStore.deleteMessage(messageId, sessionId)
    messageStore.addMessage(restampResentMessage(kept, sentAt))
  }

  /**
   * BL-4 — a kept message is back in the chat, at its end, unanswered. Its "Not sent" receipt
   * stays only in the tab that can Send it now; every other tab shows the words in the chat.
   */
  function settleKeptReceipt(messageId: string) {
    if (
      shouldClearKeptReceipt({
        bubbleState: steerInbox.getSteer(messageId)?.state,
        canSendNow: canResendDroppedSteer(messageId)
      })
    ) {
      steerInbox.clearDroppedSteer(messageId)
    }
  }

  function dismissDroppedSteer(steerId: string) {
    resendableSteerPayloads.delete(steerId)
    // Same reason as above (review F-P3b-3): remembered, so the replay cannot bring it back.
    steerInbox.clearDroppedSteer(steerId)
  }

  /** Whether a bubble can still be sent exactly as it was written. */
  function canResendDroppedSteer(steerId: string) {
    return resendableSteerPayloads.has(steerId)
  }

  /**
   * BL-455 — Send now on a message held for an approval card.
   *
   * The server wrote the words as a real message when the reply stopped at the card, so this is
   * the kept send's path (`existingUserMessageId`): the same message is sent by its id, nothing is
   * saved twice, and the card stays as it is. The user chose not to wait for it.
   */
  function sendHeldMessageNow(messageId: string) {
    const sessionId = sessionStore.getCurrentSessionId()
    if (!sessionId) return
    const held = messageStore.getMessages(sessionId).find((message) => message.id === messageId)
    if (held?.role !== 'user' || typeof held.content !== 'string' || !held.content.trim()) return
    void handleSendMessage(
      held.content,
      { composerSessionId: sessionId },
      { fromDroppedReceipt: true, existingUserMessageId: messageId }
    )
  }

  /**
   * BL-713 — Send now on a message that waits in the chat's line while the line holds for an
   * approval card (its bubble says `Waits for your answer to the approval card.`).
   *
   * The server sends that same message by its id: it adds no second entry, the hold ends, and the
   * line runs in order (the user chose not to wait for the card, as for a held message, BL-455).
   * Every tab offers it, because the server needs only the id; a second press after the message
   * went is refused (`queued_send_not_waiting`) and changes nothing.
   */
  async function sendWaitingSendNow(steerId: string) {
    const steer = steerInbox.getSteer(steerId)
    if (!steer || steer.state !== 'queued' || !steer.queuedSend || !steer.heldForApprovalCard) return
    const agent = agentStore.getCurrentAgent()
    if (!agent) return
    try {
      const response = await postSendRouted(
        JSON.stringify({
          content: steer.text,
          sessionId: steer.sessionId,
          agentId: agent.id,
          agentType: normalizePrimaryAgentType(agent),
          userMessageId: steerId,
          waitingSendNow: true,
          messages: []
        })
      )
      if (response.ok) return
      const payload = await parseJsonResponse(response)
      if (payload.code === 'queued_send_not_waiting') {
        // It already went, or it was kept, or Batshit restarted and its line is gone: the bubble
        // is stale. Say so plainly and take it away (the line never replays a send that is not
        // waiting, so nothing brings it back).
        steerInbox.forgetSteer(steerId)
        toast.info(typeof payload.error === 'string' && payload.error ? payload.error : 'This message is no longer waiting.', {
          description: typeof payload.details === 'string' && payload.details ? payload.details : undefined
        })
        return
      }
      toast.error(typeof payload.error === 'string' && payload.error ? payload.error : 'Failed to send message')
    } catch (error) {
      console.error('[sendWaitingSendNow] Failed to send the waiting message now:', error)
      toast.error('Failed to send message')
    }
  }

	  // Abort controller for cancelling the selected session's managed API/CLI send.
	  const currentAbortController = $derived(currentRunState.abortController ?? null)
	  const chatWorkBusy = $derived(chatRunRegistry.isSessionBusy(currentSessionId))

	  /**
	   * SA-114 P3 (DL-114-01, DL-114-09, DL-114-12) — what the send button promises right now.
	   *
	   * `resolveBusySendMode` is THE rule and is read here once; the label, the shortcut's
	   * opposite, and the branch `handleSendMessage` takes all come from this one value, so
	   * the button cannot say one thing while the send does another. Reading it through
	   * `$derived` off the settings store is also what makes the setting LIVE (LS-047):
	   * saving in Settings writes the store, and this recomputes with no reload.
	   *
	   * Group chats are interrupt-only in v1 and are decided here rather than waited for:
	   * the server refuses them too, but a group's label must not read "Steer" for the
	   * moment before a reply's `start` event lands.
	   */
	  const busySendMode = $derived(resolveBusySendMode(userSettings))
	  const chatSteerable = $derived.by(() => {
	    if (activeGroupId) return false
	    const verdict = currentRunState.steerable
	    // `null` means the run has not told us yet. Treat that as steerable and let the
	    // route's 409 be the backstop, rather than labelling every fresh reply "Interrupt".
	    return verdict !== false
	  })
	  const chatSteerReason = $derived.by(() => {
	    if (activeGroupId) {
	      // F-P1-2: imported, not copied. The badge beside Stop prints this as plain text.
	      return STEER_REFUSED_GROUP_SENTENCE
	    }
	    return currentRunState.steerable === false ? (currentRunState.steerReason ?? null) : null
	  })

	  const sendInFlightBySession = new Map<string, boolean>()
	  const sendInFlightSerialBySession = new Map<string, number>()
	  const lastManualInterruptAtBySession = new Map<string, number>()

	  /**
	   * SA-119 P2b (F-P2-7) — what Stop leaves behind for the next ordinary send.
	   *
	   * `metadata.interruption` is what send-routed turns into the model's
	   * `==== INTERRUPTION NOTE ====`, and DL-119-07 deleted its only writer along with
	   * interrupt-and-send. Stop, then Enter, is the whole gesture now, so Stop is what has
	   * to record it: which reply it cut, and when.
	   *
	   * Kept apart from `lastManualInterruptAtBySession`, which is a retry WINDOW — eight
	   * seconds, read repeatedly, never consumed. Folding the two together would make
	   * consuming the stamp silently close the session-turn retry as well.
	   */
	  const pendingStopInterruptionBySession = new Map<string, StopInterruptionRecord>()

	  /**
	   * SA-119 P3b (AMD-119-05) — the exact send behind a bubble, for its **Send now**.
	   *
	   * Josh, 2026-09-13: a dropped message should be one click from going, and the composer
	   * must never be refilled — a user who spent the wait typing paragraphs would lose them
	   * to a receipt.
	   *
	   * The bubble's own text cannot be that click. It is display text: F-P2-6 strips the
	   * `{{batshit-clip:…}}` syntax out of it for reading, and the clip ids and file
	   * references live in the send's METADATA, not in the words. Re-sending from what is on
	   * screen would send a message that names a clip it does not carry, or quietly drops the
	   * file — the one thing this story exists to prevent. So the exact `(content, metadata)`
	   * is kept beside the bubble and replayed — minus the composer's own closures, which
	   * `replayableSendMetadata` strips (review F-P3b-2): `onAccepted` would clear whatever
	   * the user has typed since, which is the loss the refill was rejected for.
	   *
	   * Tab-local and deliberately so: a bubble restored from the replay buffer after a
	   * reload has no payload here, and **Send now** is simply not offered for it. An
	   * approximate resend would be worse than none, and the words are still on screen.
	   */
	  const resendableSteerPayloads = new Map<
	    string,
	    { content: string; metadata: Record<string, any>; userMessageId?: string }
	  >()

	  /**
	   * BL-4 — this tab's own sends that are still waiting for their final answer, by the id of the
	   * message each saved. When the server says one is queued behind another turn, its exact send
	   * moves beside the Queue bubble (`resendableSteerPayloads`), so a "Not sent" receipt can Send
	   * it now. Cleared when the send's final answer arrives.
	   */
	  const inFlightSendPayloads = new Map<
	    string,
	    { content: string; metadata: Record<string, any> }
	  >()

	  function isSendInFlight(sessionId: string) {
	    return sendInFlightBySession.get(sessionId) === true
	  }

	  function setSendInFlight(sessionId: string, value: boolean) {
	    if (value) {
	      sendInFlightBySession.set(sessionId, true)
	    } else {
	      sendInFlightBySession.delete(sessionId)
	    }
	  }

	  function nextSendSerial(sessionId: string) {
	    const next = (sendInFlightSerialBySession.get(sessionId) ?? 0) + 1
	    sendInFlightSerialBySession.set(sessionId, next)
	    return next
	  }

		  function isLatestSendSerial(sessionId: string, runId: number) {
		    return isLatestSendRun({
		      runId,
		      latestRunId: sendInFlightSerialBySession.get(sessionId) ?? 0
		    })
		  }

		  function normalizeComposerSessionId(value: unknown) {
		    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
		  }

  // Artifacts state - loaded from new artifact service
  let artifacts = $state<any[]>([])
  let currentArtifact = $state<any>(null)
  let artifactRefreshTimer: ReturnType<typeof setTimeout> | null = null

  // Track if component is mounted to avoid SSR hydration issues
  let isMounted = $state(false)

  // Icon column state for panel artifacts
  let activePanelArtifactId = $state<string | null>(null)
  const mapLegacyZone = (legacy?: string | null) => {
    switch (legacy) {
      case 'header-icon':
        return 'header'
      case 'header-dropdown':
        return 'trigger'
      case 'panel-tab':
        return 'panel'
      default:
        return null
    }
  }
  const resolveZone = (artifact: any) => artifact.zone || mapLegacyZone(artifact.widget_position) || null
  const isLiveMode = (artifact: any) => artifact.mode === 'published'
  const getDraftPreviewArtifact = () => {
    if (!draftPreviewArtifactId) return null
    const artifact = artifacts.find((item) => item.id === draftPreviewArtifactId) ?? null
    if (!artifact) return null
    if (artifact.mode === 'published') return null
    if (!resolveZone(artifact)) return null
    return artifact
  }
  const mergeZoneArtifacts = (zoneName: 'header' | 'trigger' | 'panel') => {
    const published = artifacts.filter((artifact) => isLiveMode(artifact) && resolveZone(artifact) === zoneName)
    const draftArtifact = getDraftPreviewArtifact()
    if (!draftArtifact || resolveZone(draftArtifact) !== zoneName) return published

    const existingIndex = published.findIndex((artifact) => artifact.id === draftArtifact.id)
    if (existingIndex === -1) {
      return [...published, draftArtifact]
    }

    const next = [...published]
    next[existingIndex] = draftArtifact
    return next
  }
  let headerArtifacts = $derived.by(() => mergeZoneArtifacts('header'))
  let triggerArtifacts = $derived.by(() => mergeZoneArtifacts('trigger'))
  let panelArtifacts = $derived.by(() => mergeZoneArtifacts('panel'))

  $effect(() => {
    if (activePanelArtifactId && !panelArtifacts.some((a) => a.id === activePanelArtifactId)) {
      activePanelArtifactId = null
    }
  })

	  async function loadExecutionSnapshots(sessionId: string | null) {
    if (!sessionId) {
      executionSnapshots = []
      executionSnapshotsError = null
      executionSnapshotsLoading = false
      return
    }
    if (missingSessionIds.has(sessionId)) {
      executionSnapshots = []
      executionSnapshotsError = null
      executionSnapshotsLoading = false
      return
    }

    executionSnapshotsLoading = true
    executionSnapshotsError = null

    try {
      const response = await fetch(`/api/sessions/${sessionId}/execution-log`)
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed to load execution log' }))
        throw new Error(payload.error || 'Failed to load execution log')
      }

      const payload = await response.json()
      executionSnapshots = Array.isArray(payload?.entries) ? payload.entries : []
	    } catch (error) {
	      const message = error instanceof Error ? error.message : 'Failed to load execution log'
	      if (message.includes('Session not found')) {
	        clearMissingSelectedSession(sessionId, 'execution-log')
	        executionSnapshotsError = null
	      } else {
	        console.error('[TokenPanel] Failed to load execution snapshots:', error)
	        executionSnapshotsError = message
	      }
	      executionSnapshots = []
	    } finally {
      executionSnapshotsLoading = false
    }
	  }

	  function clearMissingSelectedSession(sessionId: string | null, source: string) {
	    if (!sessionId) return
	    // On screen: the selected chat, or the chat the message view still holds. A chat deleted
	    // in another tab has already left the session store by the time the page hears of it (the
	    // user channel applies `session_deleted` first), so asking the store alone would leave the
	    // page's per-chat state below (the message view's active chat, the thinking indicators,
	    // the Execution Viewer snapshots) pointing at a chat that is gone. The view itself clears
	    // either way: the chat's messages are dropped above and nothing is selected.
	    const wasSelected =
	      sessionStore.getCurrentSessionId() === sessionId ||
	      messageStore.getActiveSessionId() === sessionId
	    missingSessionIds.add(sessionId)
	    chatLoadQueue.forget(sessionId)
	    messageStore.clearMessages(sessionId)
	    forgetJevJuicePostTurnRecords(sessionId)
	    forgetCodexCleanupWarnings(sessionId)
	    forgetImageOrigins(sessionId)
	    clearCreatingSession(sessionId)
	    chatRunRegistry.resetRunState(sessionId)
	    if (sseServices.has(sessionId)) {
	      disconnectSSE(sessionId)
	    }
	    sessionStore.deleteSession(sessionId)
	    if (!wasSelected) return

	    logger.debug('[session-cleanup] Clearing missing selected session', {
	      sessionId,
	      source
	    })
	    messageStore.setActiveSession(null)
	    thinkingSubjects = {}
	    executionSnapshots = []
	    executionSnapshotsError = null
	  }

	  function sanitizeStoredTrimState(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const sanitized: Record<string, string[]> = {}
    for (const [sessionId, ids] of Object.entries(value as Record<string, unknown>)) {
      if (!sessionId || !Array.isArray(ids)) continue
      const cleanIds = ids
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
      if (cleanIds.length > 0) {
        sanitized[sessionId] = Array.from(new Set(cleanIds))
      }
    }
    return sanitized
  }

  function loadStoredManualTrimState() {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(MANUAL_TRIM_STORAGE_KEY)
      if (!raw) return {}
      return sanitizeStoredTrimState(JSON.parse(raw))
    } catch (error) {
      console.warn('[TokenPanel] Failed to load manual trim state:', error)
      return {}
    }
  }

  function persistManualTrimState(nextState: Record<string, string[]>) {
    if (typeof window === 'undefined') return
    const sanitized = sanitizeStoredTrimState(nextState)
    try {
      if (Object.keys(sanitized).length === 0) {
        window.localStorage.removeItem(MANUAL_TRIM_STORAGE_KEY)
      } else {
        window.localStorage.setItem(MANUAL_TRIM_STORAGE_KEY, JSON.stringify(sanitized))
      }
    } catch (error) {
      console.warn('[TokenPanel] Failed to save manual trim state:', error)
    }
  }

  function setTrimmedIdsForCurrentSession(nextIds: string[]) {
    const sessionId = currentSessionId
    if (!sessionId) return
    const nextState = {
      ...trimmedMessageIdsBySession,
      [sessionId]: nextIds
    }
    if (nextIds.length === 0) {
      delete nextState[sessionId]
    }
    trimmedMessageIdsBySession = nextState
    persistManualTrimState(nextState)
  }

  // Load the selected chat when it changes, and once more when a new chat's creating hold
  // lifts. The rule and its tests live in `selectedSessionLoad.svelte.ts`: nothing these
  // handlers read may re-run the load, or the open chat is re-fetched in a loop (it was,
  // about ten times a second, from 2026-06-06 until this moved there).
  watchSelectedSessionLoad({
    selectedSessionId: () => currentSessionId,
    isCreating: isSessionCreating,
    isMissing: (sessionId) => missingSessionIds.has(sessionId),
    clearMissing: (sessionId) => clearMissingSelectedSession(sessionId, 'session-effect'),
    holdForCreation: (sessionId) => {
      messageStore.setActiveSession(sessionId)
      logger.debug('[Session Effect] Skipping load while new session finalizes', {
        sessionId,
        creatingSessionId
      })
    },
    load: (sessionId) => {
      messageStore.setActiveSession(sessionId)
      syncActiveToolProcessingState()
      logger.debug('[Session Effect] Loading messages for session', { sessionId })
      void loadMessagesForSession(sessionId)
      // Non-critical: the zip badges follow the selected chat.
      zippingService.setCurrentSession(sessionId).catch((error) => {
        console.error('[Session Switch] Error updating zipping service:', error)
      })
      // SA-129 P2 (BL-333): which reads the prompt compresses as dead copies.
      void refreshDeadCopies(sessionId)
      void loadExecutionSnapshots(sessionId)
    }
  })

  // The tool busy flags mirror the selected chat's tool state in the run registry. This
  // effect, not the load above, is the one that follows the registry: a run-state write
  // re-syncs the flags (for example after another chat's send clears its own tools) and
  // loads nothing.
  $effect(() => {
    const sessionId = currentSessionId
    void chatRunRegistry.getRunState(sessionId).activeToolMessageIds
    untrack(syncActiveToolProcessingState)
  })

  $effect(() => {
    const sessionId = currentSessionId
    if (sessionId === realtimeSpeechSessionScopeId) return

    if (realtimeSpeechSessionScopeId !== null || sessionId !== null) {
      stopRealtimeSpeechPlayback()
    }
    realtimeSpeechSessionScopeId = sessionId
  })

  $effect(() => {
    const sessionId = currentSessionId
    if (!sessionId) return

    const validIds = new Set(messages.map((message) => message.id))
    const currentIds = trimmedMessageIdsBySession[sessionId] ?? []
    const compactedSet = currentCompactedMessageIdSet
    const nextIds = currentIds.filter((id) => validIds.has(id) && !compactedSet.has(id))
    if (nextIds.length === currentIds.length) return

    const nextState = {
      ...trimmedMessageIdsBySession,
      [sessionId]: nextIds
    }
    if (nextIds.length === 0) {
      delete nextState[sessionId]
    }
    trimmedMessageIdsBySession = nextState
    persistManualTrimState(nextState)
  })

  $effect(() => {
    manualTrimProtectionVersion
    const sessionId = currentSessionId
    if (!sessionId) return

    const currentIds = trimmedMessageIdsBySession[sessionId] ?? []
    if (currentIds.length === 0) return

    const messagesById = new Map(messages.map((message) => [message.id, message]))
    const protections = getCurrentManualTrimProtections()
    const nextIds = currentIds.filter((id) => {
      const message = messagesById.get(id)
      return message && !isMessageProtectedFromManualTrim(message, protections)
    })
    if (nextIds.length === currentIds.length) return

    setTrimmedIdsForCurrentSession(nextIds)
  })

  $effect(() => {
    const busy = Boolean(isWaitingForResponse || isWaitingForToolCall || activeStreamCount > 0)
    const sessionId = currentSessionId

    if (!busy && executionBusyPrev && sessionId) {
      void loadExecutionSnapshots(sessionId)
    }

    executionBusyPrev = busy
  })

  $effect(() => {
    const sessionId = currentSessionId
    const currentAgent = agentStore.getCurrentAgent()
    const settings = effectiveAutoCompactSettings
    const tokens = currentTokens
    const limit = contextLimit
    const triggerTokens = autoCompactTriggerTokens
    // BL-622 (C3): `chatWorkBusy` holds while this tab's send is still open (until `turn_over`,
    // after the server let the chat go), so Auto Compact does not ask beside the reply's after-reply work.
    const busy = Boolean(chatWorkBusy || isWaitingForResponse || isWaitingForToolCall || activeStreamCount > 0 || compactBusy)

    if (!sessionId || !currentAgent?.id || busy || settings.mode === 'off') return
    // BL-711: keep the waiting card mounted, including its expiry-Deny handler. A resolved
    // card changes `messages`, so this idle check resumes without a separate timer or hold.
    if (!compactGroupRunnerSession && hasPendingCompactApproval(messages, currentCompactionEvents)) return
    // BL-653: the user stopped this chat's Auto Compact; it waits for the chat's next reply to end
    // (the key below holds the token count, so any estimate update would start it again).
    if (isAutoCompactHeldAfterStop(autoCompactStopHolds, sessionId)) return
    // SA-104 P6: Infinite Sessions never auto-compact — the nap owns context relief.
    if (currentSessionFixed) return
    if (!limit || typeof tokens !== 'number' || !Number.isFinite(tokens)) return

    const remaining = limit - tokens
    if (remaining > triggerTokens) return

    const selection = selectMessagesForCompaction(messages, currentCompactionEvents, {
      protections: currentManualTrimProtections
    })
    if (selection.compactedMessageCount <= 0) return

    const promptKey = [
      currentAgent.id,
      selection.compactedThroughMessageId ?? 'none',
      Math.round(tokens),
      settings.mode
    ].join(':')
    if (autoCompactLastPromptKeyBySession[sessionId] === promptKey) return

    autoCompactLastPromptKeyBySession = {
      ...autoCompactLastPromptKeyBySession,
      [sessionId]: promptKey
    }

    void handleCompact({
      mode: 'auto',
      confirmFirst: settings.mode === 'ask'
    })
  })

  // SA-104 P6: on opening a regular session of a memory-enabled agent, offer its idle
  // tail to the graduation writer (server verifies the idle gap; cheap no-op
  // otherwise). Once per session per app run.
  $effect(() => {
    const sessionId = currentSessionId
    if (!sessionId || graduationCheckedSessions.has(sessionId)) return
    graduationCheckedSessions.add(sessionId)
    void requestRegularSessionGraduation(sessionId, 'idle')
  })

  // SA-104 P6: the Infinite-Session nap trigger — the auto-compact pattern (busy guard,
  // per-session dedup key). Fires the nap route when the compiled window crosses the
  // configured threshold; the server re-verifies the threshold and the between-turns
  // interlock (DL-104-15).
  $effect(() => {
    const sessionId = currentSessionId
    const currentAgent = agentStore.getCurrentAgent()
    const window = currentMemoryWindow
    const tokens = currentTokens
    const busy = Boolean(
      isWaitingForResponse || isWaitingForToolCall || activeStreamCount > 0 || compactBusy || napBusy
    )

    if (!sessionId || !currentAgent?.id || busy || !currentSessionFixed || !window) return
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return
    if (tokens < window.napAtTokens) return

    const attemptKey = [currentAgent.id, Math.round(tokens), window.napAtTokens].join(':')
    if (napLastAttemptKeyBySession[sessionId] === attemptKey) return
    napLastAttemptKeyBySession = {
      ...napLastAttemptKeyBySession,
      [sessionId]: attemptKey
    }

    void handleNap({ trigger: 'threshold' })
  })

  // Initialize on mount
  onMount(() => {
    const unsubscribeSession = sessionStore.subscribe((state) => {
      const leavingSessionId = currentSessionIdState
      currentSessionIdState = state.currentSessionId
      // SA-118 (DL-118-08): the one chokepoint every session change passes through. A
      // `dropped` bubble in the chat being LEFT has already told the user their steer was
      // not sent, and it used to come back every time they returned to that chat. Only
      // `dropped` is cleared, and only for the session being left: a `queued` or `waiting`
      // bubble belongs to a reply that is still running, and losing it on navigation would
      // take away the only sign that a steer is still pending.
      if (leavingSessionId && leavingSessionId !== state.currentSessionId) {
        steerInbox.clearDroppedSteersForSession(leavingSessionId)
        prunePayloadsForForgottenSteers()
      }
    })

    ;(async () => {
      // Load folders early to ensure they're available for session creation
      if (data.user) {
        await foldersStore.loadFolders()
      }

      // Ensure subagents (and their avatars) are available in chat views
      if (data.user) {
        subagentStore.init(data.user.id)
        await subagentStore.load()
      }

      // Load last selected agent from localStorage
      const lastAgentId = localStorage.getItem('lastSelectedAgent')
      if (lastAgentId) {
        const agents = agentStore.getAgents()
        const lastAgent = agents.find(w => w.id === lastAgentId)
        if (lastAgent) {
          agentStore.setCurrentAgent(lastAgentId)
        }
      }

      // Load projects
      if (data.user) {
        try {
          const projectService = new ProjectService()
          const projects = await projectService.loadProjects(data.user.id)
          projectStore.setProjects(projects)

          // Don't auto-select any project on launch - let user choose when to load files
          // This keeps app launch fast and avoids unnecessary batshit-server calls
        } catch (error) {
          console.error('Failed to load projects:', error)
          toast.error('Failed to load projects')
        }
      }

      // Load artifacts
      await loadArtifacts()

      // Mark as mounted to enable client-only components
      isMounted = true
    })()

    return () => {
      unsubscribeSession()
    }
  })

  onMount(() => {
    const handleSettingsOpened = () => {
      const shouldPersistClosed = goonsPanelOpen || Boolean(userSettings?.goons_settings?.dockOpen)
      if (goonsPanelOpen) {
        goonsPanelOpen = false
      }
      if (shouldPersistClosed) {
        updateGoonsSettings({ dockOpen: false })
      }
    }

    const handleArtifactOpen = async (event: Event) => {
      const detail = (event as CustomEvent).detail as { artifactId?: string }
      if (!detail?.artifactId || !data.user) return

      try {
        const artifact = await artifactService.getArtifact(detail.artifactId)
        if (!artifact) return

        const exists = artifacts.find((item) => item.id === artifact.id)
        if (!exists) {
          artifacts = [artifact, ...artifacts]
        }
        currentArtifact = artifact
        artifactsPanelOpen = true
        if (goonsPanelOpen) {
          goonsPanelOpen = false
          updateGoonsSettings({ dockOpen: false })
        }
        if (resolveZone(artifact) === 'panel') {
          activePanelArtifactId = artifact.id
        }

      } catch (error) {
        console.error('Failed to open artifact', error)
      }
    }

    const handleArtifactUpdated = async (event: Event) => {
      const detail = (event as CustomEvent).detail as { artifactId?: string } | undefined
      if (!detail?.artifactId || !data.user) return

      try {
        const artifact = await artifactService.getArtifact(detail.artifactId)
        if (!artifact) return

        const index = artifacts.findIndex((item) => item.id === artifact.id)
        if (index === -1) {
          artifacts = [artifact, ...artifacts]
        } else {
          const next = [...artifacts]
          next[index] = artifact
          artifacts = next
        }

        if (currentArtifact?.id === artifact.id) {
          currentArtifact = artifact
        }
      } catch (error) {
        console.error('Failed to sync updated artifact', error)
      }
    }

    const handleArtifactDeleted = (event: Event) => {
      const detail = (event as CustomEvent).detail as { artifactId?: string } | undefined
      if (!detail?.artifactId) return

      artifacts = artifacts.filter((item) => item.id !== detail.artifactId)
      if (currentArtifact?.id === detail.artifactId) {
        currentArtifact = null
      }
      if (activePanelArtifactId === detail.artifactId) {
        activePanelArtifactId = null
        artifactsPanelOpen = false
      }
      if (draftPreviewArtifactId === detail.artifactId) {
        draftPreviewArtifactId = null
      }
    }

    const handleDraftPreview = (event: Event) => {
      const detail = (event as CustomEvent).detail as { artifactId?: string | null } | undefined
      draftPreviewArtifactId = detail?.artifactId || null
    }

    // SA-120 P9: the two quick actions the page owns (the Goon Dock). Desktop Mode already shows
    // the Goon, so "open" is a no-op there and "close" leaves Desktop Mode, as the Dock toggle does.
    const handleQuickActionEvent = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      dispatchVoiceDockQuickAction(id, { visible: () => goonsPanelOpen,
        desktopActive: () => desktopModeActive, toggleDockOrExitDesktop: () => toggleGoonsPanel() })
    }
    window.addEventListener(QUICK_ACTION_EVENT, handleQuickActionEvent as EventListener)
    window.addEventListener('batshit:settings-opened', handleSettingsOpened as EventListener)
    window.addEventListener('batshit:artifact-open', handleArtifactOpen as EventListener)
    window.addEventListener(LIVE_SETTINGS_EVENTS.artifactUpdated, handleArtifactUpdated as EventListener)
    window.addEventListener(LIVE_SETTINGS_EVENTS.artifactDeleted, handleArtifactDeleted as EventListener)
    window.addEventListener(LIVE_SETTINGS_EVENTS.artifactDraftPreview, handleDraftPreview as EventListener)
    return () => {
      window.removeEventListener(QUICK_ACTION_EVENT, handleQuickActionEvent as EventListener)
      window.removeEventListener('batshit:settings-opened', handleSettingsOpened as EventListener)
      window.removeEventListener('batshit:artifact-open', handleArtifactOpen as EventListener)
      window.removeEventListener(LIVE_SETTINGS_EVENTS.artifactUpdated, handleArtifactUpdated as EventListener)
      window.removeEventListener(LIVE_SETTINGS_EVENTS.artifactDeleted, handleArtifactDeleted as EventListener)
      window.removeEventListener(LIVE_SETTINGS_EVENTS.artifactDraftPreview, handleDraftPreview as EventListener)
    }
  })

  // Load artifacts from the new artifact service
  async function loadArtifacts(preserveSelection: boolean = true) {
    if (!data.user) return

    try {
      const userArtifacts = await artifactService.getArtifacts(data.user.id)
      const previousId = preserveSelection ? currentArtifact?.id : null
      artifacts = userArtifacts

      if (preserveSelection && previousId) {
        const updated = userArtifacts.find((a) => a.id === previousId)
        currentArtifact = updated
          ? (await artifactService.getArtifact(previousId)) ?? updated
          : null
      }
    } catch (error) {
      console.error('Failed to load artifacts:', error)
      // Don't show error toast - artifacts are optional
    }
  }

  function scheduleArtifactRefresh(reason = 'artifact-change') {
    if (artifactRefreshTimer) {
      clearTimeout(artifactRefreshTimer)
    }

    artifactRefreshTimer = setTimeout(() => {
      loadArtifacts().catch((error) => console.error(`[Artifacts] Failed to refresh after ${reason}:`, error))
      artifactRefreshTimer = null
    }, 250)
  }

  const ARTIFACT_PANEL_REFRESH_CONTROLS = new Set([
    'sys.artifact.create',
    'sys.artifact.update',
    'sys.artifact.apply_patch',
    'sys.artifact.publish',
    'sys.artifact.add_version',
    'sys.artifact.rollback',
    'sys.artifact.delete_version',
    'sys.artifact.set_webhook',
    'sys.artifact.set_zone'
  ])

  function shouldRefreshArtifactPanelForControl(controlId: string) {
    return ARTIFACT_PANEL_REFRESH_CONTROLS.has(controlId)
  }

	  // Don't auto-connect SSE on mount anymore - wait for first message / session change effect
	  async function connectSSE(sessionId: string): Promise<void> {
	    const existingService = sseServices.get(sessionId)
	    if (existingService?.isConnected()) {
	      logger.debug('[connectSSE] Already connected to session, skipping:', sessionId)
	      return
	    }
	    if (connectingSseSessionIds.includes(sessionId)) {
	      logger.debug('[connectSSE] Already connecting to session, skipping:', sessionId)
	      return
	    }

	    logger.debug('[connectSSE] Connecting SSE for session:', sessionId)

	    const disconnectTimer = sseDisconnectTimers.get(sessionId)
	    if (disconnectTimer) {
	      clearTimeout(disconnectTimer)
	      sseDisconnectTimers.delete(sessionId)
	    }

	    connectingSseSessionIds = [...new Set([...connectingSseSessionIds, sessionId])]

	    // A service that is not connected is replaced, never left behind: over the shared live
	    // connection a forgotten one stays subscribed and every event of this chat arrives twice.
	    existingService?.disconnect()
	    const service = new SSEService(sessionId)
	    sseServices.set(sessionId, service)
	    try {
	      await service.connect(
	        (event) => handleSSEMessage(event, sessionId),
	        (error) => handleSSEError(error, sessionId),
	        () => handleSSEReconnected(sessionId)
	      )
	      toast.dismiss(SSE_RECONNECT_TOAST_ID)
	      connectedSseSessionIds = [...new Set([...connectedSseSessionIds, sessionId])]
	      logger.debug('[connectSSE] SSE connection established for session:', sessionId)
	    } catch (error) {
	      service.disconnect()
	      if (sseServices.get(sessionId) === service) {
	        sseServices.delete(sessionId)
	      }
	      connectedSseSessionIds = connectedSseSessionIds.filter((id) => id !== sessionId)
	      throw error
	    } finally {
	      connectingSseSessionIds = connectingSseSessionIds.filter((id) => id !== sessionId)
	    }
	  }

	  function disconnectSSE(sessionId: string) {
	    const service = sseServices.get(sessionId)
	    if (service) {
	      service.disconnect()
	      sseServices.delete(sessionId)
	    }
	    sseEventDeduper.clearSession(sessionId)
	    connectedSseSessionIds = connectedSseSessionIds.filter((id) => id !== sessionId)
	    connectingSseSessionIds = connectingSseSessionIds.filter((id) => id !== sessionId)
	    if (currentSSESessionId === sessionId) {
	      currentSSESessionId = null
	    }
	  }

	  function scheduleSseDisconnectIfIdle(sessionId: string, delayMs = 8000) {
	    if (sessionId === sessionStore.getCurrentSessionId()) return
	    if (chatRunRegistry.isSessionBusy(sessionId)) return
	    if (sseDisconnectTimers.has(sessionId)) return

	    const timer = setTimeout(() => {
	      sseDisconnectTimers.delete(sessionId)
	      if (sessionId !== sessionStore.getCurrentSessionId() && !chatRunRegistry.isSessionBusy(sessionId)) {
	        disconnectSSE(sessionId)
	      }
	    }, delayMs)
	    sseDisconnectTimers.set(sessionId, timer)
	  }

	  function shouldAutoConnectSseForSession(sessionId: string) {
	    // The chat ON SCREEN always listens, empty or not. Batshit writes into a chat the
	    // browser never sent to — a LiveKit voice turn, an artifact shared to chat, a wake-up —
	    // and an event for a session with no listener is DROPPED by `/api/sse`. An empty chat
	    // used to stay unsubscribed and only caught up because the page re-fetched it ten times
	    // a second; now it hears the first message live like any other chat.
	    if (sessionId === sessionStore.getCurrentSessionId()) return true
	    if (chatRunRegistry.isSessionBusy(sessionId)) return true
	    if (messageStore.getMessageCount(sessionId) > 0) return true
	    return false
	  }

  // Track the current SSE session ID
  let currentSSESessionId = $state<string | null>(null)
  let trackedSessionId = $state<string | null>(null)
	  let sseRetryUntil = $state<number | null>(null)
  let sseRetryDelayMs = $state(1000)
  let sseRetrySessionId = $state<string | null>(null)
  let sseRetryTimeout: ReturnType<typeof setTimeout> | null = null
  let lastSseToastAt = $state(0)
  let lastStreamRuntimeErrorAt = 0
  const SSE_RECONNECT_TOAST_ID = 'sse-reconnect'
  let lastParamToastAt = 0
  let lastParamToastMessage: string | null = null

  function normalizeMatrixConnection(value?: string | null): MatrixConnectionId | null {
    if (!value) return null
    if (value === 'openrouter') return 'openrouter'
    if (value === 'vercel-gateway') return 'vercel-gateway'
    if (value.startsWith('direct')) return 'direct'
    if (value === 'n8n') return 'n8n'
    return null
  }

  function clearSseRetry() {
    if (sseRetryTimeout) {
      clearTimeout(sseRetryTimeout)
      sseRetryTimeout = null
    }
    sseRetryUntil = null
    sseRetryDelayMs = 1000
    sseRetrySessionId = null
  }

  function scheduleSseRetry(sessionId: string) {
    if (sseRetryTimeout) {
      clearTimeout(sseRetryTimeout)
    }
    const nextDelay = Math.min(sseRetryDelayMs * 2, 30000)
    sseRetryDelayMs = nextDelay
    sseRetryUntil = Date.now() + nextDelay
    sseRetrySessionId = sessionId
    sseRetryTimeout = setTimeout(() => {
      if (sseRetrySessionId === sessionId) {
        sseRetryUntil = null
      }
      sseRetryTimeout = null
    }, nextDelay)
  }

  // Connect SSE if we already have a session (from clicking New Chat)
  $effect(() => {
    const sessionId = currentSessionId
    trackedSessionId = sessionId  // Update the reactive variable
    logger.debug('[SSE Effect] Session ID:', sessionId, 'Current SSE Session:', currentSSESessionId)

    // Connect SSE if:
    // 1. We have a session ID
    // 2. We're not in the middle of creating a new session
    // 3. Either we don't have SSE connected OR the session ID has changed
	    const isConnected = !!sessionId && sseServices.get(sessionId)?.isConnected()
	    const isConnecting = !!sessionId && connectingSseSessionIds.includes(sessionId)
    const now = Date.now()
    if (sessionId && sseRetrySessionId && sseRetrySessionId !== sessionId) {
      clearSseRetry()
    }
    const isInBackoff =
      typeof sseRetryUntil === 'number' &&
      sessionId === sseRetrySessionId &&
      now < sseRetryUntil

    const shouldConnect =
      sessionId &&
      !isSessionCreating(sessionId) &&
      !isConnected &&
      !isConnecting &&
      !isInBackoff &&
      shouldAutoConnectSseForSession(sessionId)

    if (shouldConnect && sessionId) {
      logger.debug('[SSE Effect] Session changed, reconnecting SSE')
      connectSSE(sessionId)
        .then(() => {
          logger.debug('[SSE Effect] SSE connection established for session', sessionId)
          if (sessionStore.getCurrentSessionId() === sessionId) {
            currentSSESessionId = sessionId
            clearSseRetry()
          } else {
            logger.debug('[SSE Effect] Ignoring stale SSE connection for session', sessionId)
          }
        })
        .catch((err) => {
          console.error('[SSE Effect] Failed to connect SSE:', err)
          if (sessionStore.getCurrentSessionId() === sessionId) {
            currentSSESessionId = null
            scheduleSseRetry(sessionId)
          }
        })
    }
  })

	  $effect(() => {
	    const selectedSessionId = currentSessionId
	    const trackedIds = [...new Set([...connectedSseSessionIds, ...connectingSseSessionIds])]

	    for (const sessionId of trackedIds) {
	      if (sessionId === selectedSessionId) continue
	      if (chatRunRegistry.isSessionBusy(sessionId)) continue
	      logger.debug('[SSE Effect] Disconnecting idle background SSE', { sessionId })
	      disconnectSSE(sessionId)
	    }
	  })

  // Clean up SSE on unmount
	  onDestroy(() => {
	    stopRealtimeSpeechPlayback()
	    for (const timer of sseDisconnectTimers.values()) {
	      clearTimeout(timer)
	    }
	    sseDisconnectTimers.clear()
	    for (const sessionId of Array.from(sseServices.keys())) {
	      disconnectSSE(sessionId)
	    }
	  })

  // Also clean up SSE when session is cleared (e.g., after deletion)
	  $effect(() => {
	    const sessionId = currentSessionId
	    if (!sessionId && sseServices.size > 0) {
	      logger.debug('[SSE Effect] Session cleared, disconnecting SSE')
	      for (const activeSessionId of Array.from(sseServices.keys())) {
	        disconnectSSE(activeSessionId)
	      }
	      currentSSESessionId = null
	      // Also clear messages to show welcome screen
	      messageStore.setActiveSession(null)
	      thinkingSubjects = {}
	    }
	  })

  // One load at a time per chat, plus one catch-up load for anything asked while it ran.
  const chatLoadQueue = createChatLoadQueue((sessionId: string) => loadMessagesFromServer(sessionId))

  function loadMessagesForSession(sessionId: string) {
    return chatLoadQueue.request(sessionId)
  }

  async function loadMessagesFromServer(sessionId: string) {
    if (missingSessionIds.has(sessionId)) return

    try {
      logger.debug('[loadMessagesForSession] Loading messages for session:', sessionId)
      const dbService = new DatabaseService()
      const messages = await dbService.getSessionMessages(sessionId)
      logger.debug('[loadMessagesForSession] Loaded messages:', messages.length, messages)
      missingSessionIds.delete(sessionId)

      const sanitizedMessages = messages.map((msg) => ({
        ...msg,
        content: sanitizeFinishedReplyContent(msg.content || '')
      }))

	      messageStore.setMessagesForSession(sessionId, sanitizedMessages, {
	        preserveLocalInProgress: chatRunRegistry.isSessionBusy(sessionId)
	      })
	      if (sessionStore.getCurrentSessionId() === sessionId) {
	        messageStore.setActiveSession(sessionId)
        for (const record of sanitizedMessages) {
          chatInputRef?.observeVoiceReply?.({ sessionId, type: 'record', messageId: record.id,
            role: record.role, status: record.status, metadata: record.metadata })
          if (record.role === 'user' && Array.isArray(record.metadata?.steerPromoted?.steerIds)) {
            steerInbox.applySteerPromoted({ steerIds: record.metadata.steerPromoted.steerIds })
          }
        }
	      }
	      // SA-120 P6: the Judge Juice after-reply notes live beside the messages, not inside them
	      // (the server writes them after a reply's `end`). Never awaited: a chip must not be
	      // able to delay or fail a chat's load.
	      void refreshJevJuicePostTurnRecords(sessionId)
	      void refreshCodexCleanupWarnings(sessionId)
	      void refreshImageOrigins(sessionId)
	    } catch (error) {
	      const message = error instanceof Error ? error.message : String(error)
	      if (message.includes('Session not found')) {
	        logger.warn('[loadMessagesForSession] Session not found, clearing session reference', {
	          sessionId
	        })
	        clearMissingSelectedSession(sessionId, 'messages')
		        return
		      }
	      console.error('[loadMessagesForSession] Failed to load messages:', error)
	      messageStore.clearMessages(sessionId)
	      if (sessionStore.getCurrentSessionId() === sessionId) {
	        const now = Date.now()
	        if (now - lastConversationLoadToastAt > 5000) {
	          toast.error('Failed to load conversation. Please try again.')
	          lastConversationLoadToastAt = now
	        }
	      }
	    }
	  }

  function resolveVoiceConfig(metadata: Record<string, any>, agentId?: string | null): VoiceConfig | undefined {
    if (!metadata || typeof metadata !== 'object') {
      const agentVoice = normalizeAgentVoiceProfile(
        agentId ? agentStore.getAgentById(agentId)?.voice_profile : null
      )
      const agentTts = agentVoice?.tts
      if (!agentTts) return undefined
      return {
        provider: agentTts.providerId,
        model: agentTts.modelId,
        voiceId: agentTts.voiceId,
        profileId: agentTts.profileId,
        common: agentTts.common,
        providerOptions: getProviderOptionsFor(agentTts.providerOptions, agentTts.providerId),
        style: flattenLegacyVoiceStyle(agentTts)
      }
    }

    const voiceMeta =
      typeof metadata.voice === 'object' && metadata.voice ? metadata.voice : {}
    const agentVoice = normalizeAgentVoiceProfile(
      agentId ? agentStore.getAgentById(agentId)?.voice_profile : null
    )
    const agentTts = agentVoice?.tts

    const resolvedProvider =
      voiceMeta.provider ??
      metadata.voiceProvider ??
      metadata.ttsProvider ??
      metadata.voice_provider ??
      agentTts?.providerId

    const metadataTts = normalizeVoiceTtsConfig({
      providerId: resolvedProvider,
      modelId:
        voiceMeta.model ??
        metadata.voiceModel ??
        metadata.ttsModel ??
        metadata.voice_model ??
        agentTts?.modelId,
      voiceId:
        voiceMeta.voiceId ??
        metadata.voiceId ??
        metadata.ttsVoiceId ??
        metadata.voice_id ??
        agentTts?.voiceId,
      profileId:
        voiceMeta.profileId ??
        metadata.voiceProfileId ??
        metadata.voice_profile_id ??
        agentTts?.profileId,
      common: typeof voiceMeta.common === 'object' ? voiceMeta.common : undefined,
      providerOptions: typeof voiceMeta.providerOptions === 'object' ? voiceMeta.providerOptions : undefined,
      style: voiceMeta.style ?? metadata.voiceStyle ?? metadata.voice_style
    })

    if (!metadataTts) {
      return undefined
    }

    const provider = metadataTts.providerId ?? agentTts?.providerId
    const common = mergeVoiceCommon(agentTts?.common, metadataTts.common)
    const providerOptions = mergeVoiceProviderBlocks(
      getProviderOptionsFor(agentTts?.providerOptions, provider),
      getProviderOptionsFor(metadataTts.providerOptions, provider)
    )
    const style = flattenLegacyVoiceStyle({
      providerId: provider,
      common,
      providerOptions: provider && providerOptions ? { [provider]: providerOptions } : undefined
    })

    return {
      provider,
      model: metadataTts.modelId,
      voiceId: metadataTts.voiceId,
      profileId: metadataTts.profileId,
      common,
      providerOptions,
      style
    }
  }

  function isSpeechRequested(metadata: Record<string, any> | null | undefined): boolean {
    return Boolean(voiceMode || metadata?.tts)
  }

  function dispatchGoonSpeechMessage(
    messageId: string,
    agentId: string | null | undefined,
    content: string,
    speechPlanned: boolean,
    source?: string
  ) {
    window.dispatchEvent(
      new CustomEvent('batshit:goon-message', {
        detail: {
          messageId,
          agentId: agentId ?? null,
          content,
          speechPlanned,
          source
        }
      })
    )
  }

  const realtimeSpeechCoordinator = new RealtimeSpeechCoordinator({
    getCurrentSessionId: () => currentSessionId,
    isSpeechRequested,
    resolveVoiceConfig,
    resolveSpeakableTextOptions: (_metadata, agentId) =>
      resolveVoiceSpeakableTextOptions(resolveSpeechVoiceSettings(agentId)),
    usesRealtimeTts: (voice?: VoiceConfig) => voiceService.usesRealtimeTts(voice),
    willSpeakText: (text, options) =>
      voiceService.willSpeakText(text, {
        manual: options?.manual,
        voiceSettings: resolveSpeechVoiceSettings(options?.agentId ?? null)
      }),
    speak: (text, options) =>
      voiceService.speak(text, {
        ...options,
        voiceSettings: resolveSpeechVoiceSettings(options.agentId ?? null)
      }),
    dispatchGoonSpeechMessage,
    stopAll: () => voiceService.stopAll()
  })

  function appendRealtimeSpeechChunk(
    messageId: string,
    agentId: string | null,
    metadata: Record<string, any>,
    chunkText: string
  ) {
    realtimeSpeechCoordinator.append(messageId, agentId, metadata, chunkText)
  }

  async function finishRealtimeSpeech(
    messageId: string,
    agentId: string | null,
    metadata: Record<string, any>
  ): Promise<boolean> {
    return realtimeSpeechCoordinator.finish(messageId, agentId, metadata)
  }

  function cancelRealtimeSpeechSessions(messageId?: string | null) {
    realtimeSpeechCoordinator.cancel(messageId)
  }

  function stopRealtimeSpeechPlayback(messageId?: string | null) {
    realtimeSpeechCoordinator.stopPlayback(messageId)
  }

  onMount(() => {
    const handleVoiceInputSpeechStart = () => {
      stopRealtimeSpeechPlayback()
    }
    window.addEventListener('batshit:voice-input-speech-start', handleVoiceInputSpeechStart)
    return () => window.removeEventListener('batshit:voice-input-speech-start', handleVoiceInputSpeechStart)
  })

  async function handleSSEMessage(data: any, sourceSessionId?: string | null) {
    const eventSessionId = resolveSseEventSessionId(data) ?? sourceSessionId ?? null
    if (!eventSessionId) {
      logger.warn('[SSE] Ignoring event without a session owner', {
        type: data?.type ?? null,
        messageId: data?.messageId ?? data?.message?.id ?? null
      })
      return
    }
    eventSessionContext = eventSessionId
    try {
      if (!sseEventDeduper.shouldProcess(eventSessionId, data)) {
        logger.debug('[SSE] Ignoring duplicate replayed event', {
          sessionId: eventSessionId,
          messageId: data?.messageId ?? data?.message?.id ?? null,
          type: data?.type ?? null,
          sseEventId: data?.sseEventId ?? data?.metadata?.sseEventId ?? null
        })
        return
      }

      if (eventSessionId === currentSessionId) {
        const record = data.type === 'user_message' || data.type === 'complete_message' ? data.message : null
        chatInputRef?.observeVoiceReply?.({
          sessionId: eventSessionId, type: data.type,
          messageId: record?.id ?? data.messageId, steerId: data.steerId,
          role: record?.role, status: record?.status, metadata: record?.metadata ?? data.metadata
        })
      }

      // Handle different SSE message types
    if (data.type === 'connected') {
      logger.debug('[SSE] Connected to session:', data.sessionId)
    } else if (data.type === 'voice_interruption') {
      stopRealtimeSpeechPlayback()
    } else if (data.type === 'voice_goon_cue') {
      const cueName = typeof data.cueName === 'string' ? data.cueName.trim() : ''
      const content =
        typeof data.content === 'string' && data.content.trim()
          ? data.content.trim()
          : cueName
            ? `<batshit-cue>${JSON.stringify({ goon_cue: cueName })}</batshit-cue>`
            : ''
      if (content) {
        dispatchGoonSpeechMessage(
          data.messageId || `livekit-goon-cue-${crypto.randomUUID()}`,
          data.agentId || resolveAgentIdFromEvent(data) || agentStore.getCurrentAgentId(),
          content,
          true,
          'livekit-tool'
        )
      }
    } else if (data.type === 'zip_activity_change') {
      // Handle zip activity changes from Redis keyspace notifications!
      logger.debug('[SSE] Zip activity change detected! 🚀', data)

      // Dispatch custom event that MessageContent components will listen to
      window.dispatchEvent(new CustomEvent('zipActivityChanged', {
        detail: {
          sessionId: data.sessionId,
          eventType: data.eventType,
          zipId: data.zipId,
          operation: data.operation,
          timestamp: data.timestamp
        }
      }))
      manualTrimProtectionVersion += 1
      if (eventSessionId === currentSessionId) {
        scheduleLiveContextPreview('zip-state', 250, { ignoreBusy: true })
      }
    } else if (data.type === 'clip_state_changed') {
      dispatchSessionClipStateChanged({
        sessionId: eventSessionId,
        clipId: typeof data.clipId === 'string' ? data.clipId : undefined,
        source: resolveServerClipStateSource(data.source)
      })
    } else if (data.type === 'user_message' && data.message) {
      const incoming = data.message
      if (!incoming?.id) {
        logger.warn('[SSE] Received user_message without id, skipping', incoming)
        return
      }

      if (Array.isArray(incoming.metadata?.steerPromoted?.steerIds)) {
        steerInbox.applySteerPromoted({ steerIds: incoming.metadata.steerPromoted.steerIds })
      }
      const normalizedUserMessage = {
        ...incoming,
        role: incoming.role || 'user',
        status: incoming.status ?? 'complete'
      }
      const exists = Boolean(
        messageStore.getMessage(incoming.id, incoming.session_id || eventSessionContext)
      )
      if (exists) {
        logger.debug('[SSE] user_message already exists locally, updating:', incoming.id)
        messageStore.updateMessage(incoming.id, normalizedUserMessage)
        settleKeptReceipt(incoming.id)
        return
      }

      logger.debug('[SSE] Inserting user_message from SSE broadcast:', incoming.id)
      messageStore.addMessage(normalizedUserMessage)
      settleKeptReceipt(incoming.id)
    } else if (data.type === 'steer_queued') {
      // SA-114 P3 (DL-114-14). This is also how a tab that did NOT send learns the words:
      // the steer events ride the session replay buffer, so a tab opened mid-reply sees the
      // queue, the delivery, and the inset in order rather than an unexplained bubble.
      // BL-4: a send that met another turn waits in the chat's line, and the server says so
      // here with a notice: its saved message leaves the list and shows as this bubble.
      const queuedSendNotice = readQueuedSendNotice(data)
      if (queuedSendNotice) takeQueuedSendOutOfTheList(eventSessionContext, queuedSendNotice)
      steerInbox.applySteerQueued({
        sessionId: eventSessionContext ?? '',
        messageId: typeof data.messageId === 'string' ? data.messageId : '',
        steerId: typeof data.steerId === 'string' ? data.steerId : '',
        text: typeof data.text === 'string' ? data.text : '',
        // DL-119-05: the route has carried this since P1. Without it a tab that did not
        // send — a spectator, or one reopened mid-reply — would be told a held message is
        // about to land inside this reply.
        deliver: isSteerDeliver(data.deliver) ? data.deliver : undefined,
        queuedSend: queuedSendNotice !== null,
        // BL-713: a joining tab learns that the line holds this send for an approval card.
        heldForApprovalCard: readHeldForApprovalCard(data)
      })
    } else if (data.type === 'queued_send_hold') {
      // BL-713: the chat's line starts holding its waiting sends for the user's answer to an
      // approval card, or stops (the click, a new message, Send now). Their bubbles say so.
      steerInbox.applyQueuedSendHold({
        sessionId: eventSessionContext,
        heldForApprovalCard: readHeldForApprovalCard(data)
      })
    } else if (data.type === 'queued_send_dropped') {
      // BL-4: the server will not send these queued messages (Stop, Batshit stopping or a restore,
      // the line's cap, and since BL-713 an approval card left unanswered for 15 minutes or
      // answered only by the page's own expiry Deny). Their bubbles become "Not sent" receipts;
      // the words come back into the chat, at its end.
      steerInbox.applySteerDropped({
        steerIds: Array.isArray(data.userMessageIds) ? data.userMessageIds : [],
        reason: typeof data.reason === 'string' ? data.reason : undefined
      })
    } else if (data.type === 'steer_delivered') {
      const steerSessionId = eventSessionContext ?? ''
      const steerMessageId = typeof data.messageId === 'string' ? data.messageId : ''
      const steerId = typeof data.steerId === 'string' ? data.steerId : ''
      // The marker itself arrives as an ordinary content chunk, emitted by the server at
      // the same point it writes the marker into the record (F-P3-A). Nothing to insert
      // here: one owner for where a steer sits in the reply, and it is the server.
      steerInbox.applySteerDelivered({
        sessionId: steerSessionId,
        messageId: steerMessageId,
        steerId,
        lane: data.lane,
        source: data.source
      })
    } else if (data.type === 'steer_promoted') {
      // The server has written the promoted user message and forwarded it as `user_message`
      // just before this; the bubble with the same id has already become that message
      // (AMD-114-04: the promoted id IS the first steer's id), so this only settles state.
      const promotedIds = Array.isArray(data.steerIds) ? data.steerIds : []
      const savedPromotion = promotedIds.some((id: string) => {
        const record = messageStore.getMessage(id, eventSessionContext)
        const savedSteerIds = record?.metadata?.steerPromoted?.steerIds
        return record?.role === 'user' && Array.isArray(savedSteerIds) &&
          promotedIds.every((steerId: string) => savedSteerIds.includes(steerId))
      })
      if (data.metadata?.steerPromoted?.disposition === 'unanswered' && data.savedRecord !== true && !savedPromotion) {
        for (const steerId of data.steerIds ?? []) {
          steerInbox.markSteerDropped(steerId, data.metadata.steerPromoted.reason === 'stopped' ? 'stopped' : 'unanswered')
        }
      } else {
        steerInbox.applySteerPromoted({
          steerIds: Array.isArray(data.steerIds) ? data.steerIds : [],
          messageId: typeof data.messageId === 'string' ? data.messageId : undefined
        })
      }
	    } else if (data.type === 'complete_message' && data.message) {
	      // Handle complete message from SSE
	      const message = data.message
	      const sessionId = eventSessionContext
      const agentId =
        message.agent_id ||
        resolveAgentIdFromEvent(data) ||
        agentStore.getCurrentAgentId()
      if (agentId) {
        streamingSpeakerId = agentId
      }
      let currentAgent = agentStore.getCurrentAgent()
      const resolvedMessageId =
        message.id || data.messageId || resolveStreamMessageId(data.messageId)
      if (!resolvedMessageId) {
        logger.warn('[SSE] complete_message missing id, skipping to avoid duplicates')
        return
      }

      // FIXED: Save raw content AS-IS, never modify before storage!
      // Zipping happens ONLY during formatting for AI (in formatMessageForAI)

      // Create the AI message with raw content
      const aiMessage = {
        id: resolvedMessageId,
        content: message.content || '',
        role: 'assistant' as const,
	        session_id: message.session_id || sessionId!,
        agent_id: agentId || undefined,
        user_id: data.user?.id || '',
        timestamp: message.timestamp || new Date().toISOString(),
        created_at: message.timestamp || new Date().toISOString(),
        metadata: message.metadata || {},
        structured: message.structured || {},
        responseType: message.responseType || 'message',
        status: 'complete' as const,
        intermediateSteps: message.intermediateSteps || undefined
      }

      // Check if message with this ID already exists to prevent duplicates
      const existingMessage = messageStore.getMessage(aiMessage.id, aiMessage.session_id)
      if (existingMessage) {
        logger.warn('[SSE] Duplicate message ID detected, updating instead:', aiMessage.id)
        messageStore.updateMessage(aiMessage.id, aiMessage)
      } else {
        // Add to message store
        messageStore.addMessage(aiMessage)
      }

      // SA-114 P3 (DL-114-14): the reply is finished, so its delivered steers now render
      // inline from `metadata.steers` and their optimistic bubbles go. Anything still
      // waiting is the server's to promote — unless the turn was stopped, which promotes
      // nothing.
      settleSteerBubblesForMessage(aiMessage.session_id, aiMessage.id, {
        interrupted: aiMessage.metadata?.interrupted === true
      })

      const isSpeechToSpeechAssistant =
        Boolean(aiMessage.metadata?.speechToSpeech && aiMessage.metadata?.voiceRuntime === 'livekit')
      if (isSpeechToSpeechAssistant) {
        dispatchGoonSpeechMessage(
          aiMessage.id,
          aiMessage.agent_id ?? agentId ?? null,
          aiMessage.content,
          true,
          'livekit-final-transcript'
        )
      }

      // BL-775: the LiveKit turn route saved this reply before it sent it; the tab only shows it.
      if (aiMessage.session_id) {
        void refreshLiveContextPreview('message-finalized', aiMessage.session_id, {
          useStoredMessages: true,
          ignoreBusy: true
        })
      }

      // Reset waiting state in ChatInput
      if (chatInputRef?.aiResponseReceived) {
        chatInputRef.aiResponseReceived()
      }
	    } else if (data.type === 'start') {
	      const sessionId = eventSessionContext
      const pageData = page.data

      const realMessageId = data.messageId || crypto.randomUUID()
      const agentId = resolveAgentIdFromEvent(data)
      if (agentId) {
        streamingSpeakerId = agentId
      }

      // SA-114 P3 (DL-114-09): the server decided whether this reply can be steered when it
      // registered the run, because a Codex turn's answer depends on the transport lane it
      // actually got. The client only reports it — one place, read by the send button.
      if (sessionId && typeof data?.metadata?.steerable === 'boolean') {
        chatRunRegistry.updateRunState(sessionId, {
          steerable: data.metadata.steerable,
          steerReason:
            typeof data.metadata.steerReason === 'string' ? data.metadata.steerReason : null
        })
      }

      const existingStreamMessage = messageStore.getMessage(realMessageId, sessionId)
      const approvalResume = readApprovalResumeStart(data.metadata)
      if (approvalResume && existingStreamMessage && !isNewApprovalResume(existingStreamMessage.metadata, approvalResume)) return
      if (!approvalResume && existingStreamMessage && ignoreLateEventForFinalizedMessage(realMessageId, 'start')) return
      if (sessionId) markImageOriginExpected(sessionId, realMessageId)

      registerActiveMessage(realMessageId)
      resetToolStateForMessage(realMessageId)

      if (approvalResume) {
        // A fresh, server-owned continuation can reopen this one finished message. An
        // old start replay cannot: its monotonic version is already on the saved record.
        const patch = approvalResumeStartPatch(approvalResume, data.metadata)
        if (existingStreamMessage) {
          messageStore.updateMessage(realMessageId, patch)
        } else {
          messageStore.addMessage({
            id: realMessageId, role: 'assistant', session_id: sessionId!,
            agent_id: agentId || undefined, user_id: pageData.user?.id || data.userId,
            ...patch
          })
        }
        return
      }
      if (existingStreamMessage) {
        if (ignoreLateEventForFinalizedMessage(realMessageId, 'start')) {
          return
        }
        messageStore.updateMessage(realMessageId, {
          status: 'in_progress',
          metadata: {
            ...(existingStreamMessage.metadata || {}),
            ...(data.metadata || {})
          },
          ...(agentId ? { agent_id: agentId } : {})
        })
        return
      }

      logger.debug('[SSE start] Creating new message placeholder:', realMessageId)

      messageStore.addMessage({
        id: realMessageId,
        content: '',
        role: 'assistant',
	        session_id: sessionId!,
        agent_id: agentId || agentStore.getCurrentAgentId() || undefined,
        user_id: pageData.user?.id || data.userId,
        status: 'in_progress',
        metadata: data.metadata || {}
      })
    } else if (data.type === 'thinking') {
      const targetMessageId = resolveStreamMessageId(data.messageId)
      if (!targetMessageId) {
        return
      }
      if (ignoreLateEventForFinalizedMessage(targetMessageId, data.type)) {
        return
      }

      const thinkingContent = data.content ?? data.text ?? ''
      const indicatorRequested =
        data?.metadata?.kind === 'reasoning_indicator' || isThinkingIndicator(thinkingContent)
      const indicatorStop = data?.metadata?.kind === 'reasoning_indicator' && data?.metadata?.op === 'stop'
      const { showReasoning } = resolveReasoningFlags(targetMessageId)

      if (indicatorStop) {
        clearThinkingIndicator(targetMessageId)
        return
      }

	      if (indicatorRequested) {
	        const existing = thinkingSubjects[targetMessageId]
	        if (!existing || isThinkingIndicator(existing)) {
	          thinkingSubjects = {
	            ...thinkingSubjects,
	            [targetMessageId]: THINKING_INDICATOR
	          }
	        }
	        return
	      }

      if (!showReasoning) {
        if (!thinkingContent) {
          return
        }
        if (!isThinkingIndicator(thinkingSubjects[targetMessageId])) {
          thinkingSubjects = {
            ...thinkingSubjects,
            [targetMessageId]: THINKING_INDICATOR
          }
        }
        return
      }

      if (!thinkingContent) {
        return
      }

      const op = data?.metadata?.op ?? 'replace'
      const existingValue = thinkingSubjects[targetMessageId] ?? ''
      const existing = isThinkingIndicator(existingValue) ? '' : existingValue
      const nextValue =
        op === 'append'
          ? `${existing}${thinkingContent}`
          : thinkingContent

      thinkingSubjects = {
        ...thinkingSubjects,
        [targetMessageId]: nextValue
      }

    } else if (data.type === 'plan_update') {
      const targetMessageId = resolveStreamMessageId(data.messageId)
      if (!targetMessageId) {
        return
      }
      if (ignoreLateEventForFinalizedMessage(targetMessageId, data.type)) {
        return
      }

      const { showReasoning } = resolveReasoningFlags(targetMessageId)
      if (!showReasoning) {
        return
      }

      const items = normalizePlanItems(data.items ?? data.content ?? data)
      const content =
        typeof data.content === 'string'
          ? data.content
          : items.length > 0
            ? formatPlanSummary(items)
            : ''

      planSubjects = {
        ...planSubjects,
        [targetMessageId]: {
          content,
          ...(items.length > 0 ? { items } : {})
        }
      }

      const targetMessage = resolveMessage(targetMessageId)
      if (targetMessage && showReasoning) {
        messageStore.updateMessage(targetMessageId, {
          metadata: {
            ...(targetMessage.metadata || {}),
            ...(content ? { planSummary: content } : {}),
            ...(items.length > 0 ? { planItems: items } : {})
          }
        })
      }

    } else if (data.type === 'object_partial' || data.type === 'object_final') {
      const payload = data.object ?? data.output ?? data.value ?? data.data
      if (!payload) {
        return
      }

      const targetMessageId = resolveStreamMessageId(data.messageId)
      if (!targetMessageId) {
        return
      }
      if (ignoreLateEventForFinalizedMessage(targetMessageId, data.type)) {
        return
      }

      objectSubjects = {
        ...objectSubjects,
        [targetMessageId]: payload
      }

      if (data.type === 'object_final') {
        const targetMessage = resolveMessage(targetMessageId)
        if (targetMessage) {
          messageStore.updateMessage(targetMessageId, {
            metadata: {
              ...(targetMessage.metadata || {}),
              structuredOutput: payload
            }
          })
        }
      }

    } else if (data.type === 'chunk' || data.type === 'text-delta') {
      // SA-911: Simplified chunk handler with Option D buffering
      const targetMessageId = resolveStreamMessageId(data.messageId)
      const chunkText = data.content ?? data.text ?? ''

      if (!targetMessageId) {
        logger.debug('[SA-911 chunk] No message ID, skipping')
        return
      }
      if (ignoreLateEventForFinalizedMessage(targetMessageId, data.type)) {
        return
      }

      if (!chunkText) {
        return
      }

	      if (!isMessageActive(targetMessageId)) {
	        registerActiveMessage(targetMessageId)
	      }

      // SA-911 Option D: If a tool is being processed for this message, buffer this chunk
      const processingState = getToolProcessingState(targetMessageId)
      if (processingState.isProcessing) {
        logger.debug('[SA-911 chunk] Tool processing in progress, buffering chunk', {
          messageId: targetMessageId
        })
        processingState.pendingChunks.push(chunkText)
        return
      }

      // Get or create the message
      let currentMessage = messageStore.getMessage(targetMessageId)
      if (!currentMessage) {
	        const sessionId = eventSessionContext
        const agentId = agentStore.getCurrentAgentId()
        if (!sessionId) {
          logger.warn('[SA-911 chunk] No session, skipping')
          return
        }

        messageStore.addMessage({
          id: targetMessageId,
          content: '',
          role: 'assistant',
          session_id: sessionId,
          agent_id: resolveAgentIdFromEvent(data) || agentId || undefined,
          user_id: data.userId || page.data.user?.id || '',
          status: 'in_progress',
          metadata: data.metadata || {}
        })
        currentMessage = messageStore.getMessage(targetMessageId)
      }

      if (currentMessage) {
        // Skip if message already finalized
        if (currentMessage.status === 'complete' || currentMessage.status === 'error') {
          unregisterActiveMessage(targetMessageId)
          return
        }

        clearThinkingIndicator(targetMessageId)

        // Clear waiting state on first content
        if (!currentMessage.content && chunkText) {
          isWaitingForResponse = false
        }

        // SA-911: Append streamed text while preserving tool insertion order
        const toolState = toolStreamStates.get(targetMessageId)
        let newContent = ''

        if (toolState) {
          toolState.textBuffer += chunkText
          newContent = composeToolStreamContent(toolState)
        } else {
          newContent = (currentMessage.content || '') + chunkText
        }

        messageStore.updateMessage(targetMessageId, { content: newContent })
        if (eventSessionContext === currentSessionId) {
          scheduleLiveContextPreview('active-stream', 1500, {
            ignoreBusy: true,
            keepExistingTimer: true
          })
        }

        const chunkMetadata =
          data.metadata && typeof data.metadata === 'object'
            ? { ...(currentMessage.metadata || {}), ...data.metadata }
            : (currentMessage.metadata || {})
        appendRealtimeSpeechChunk(
          targetMessageId,
          currentMessage.agent_id ?? resolveAgentIdFromEvent(data) ?? null,
          chunkMetadata,
          chunkText
        )

        if (newContent.includes('batshit-zip:cool_tool_')) {
          logToolOrderEvent('chunk', targetMessageId, newContent, {
            isProcessingTool,
            pendingChunks: processingState.pendingChunks.length,
            chunkLength: chunkText.length
          })
        }
      }

    } else if (data.type === 'content_reset') {
      // BL-759: the agent's program lost its connection mid-answer and started the answer again
      // (Codex's app-server lane); the server took the unfinished first try out of the reply's
      // record and sends the reply's text as it now reads. The live text becomes that text, its
      // tool cards stay where they were, the words buffered while a tool ran are already in it,
      // and words not spoken yet in Voice Mode go. The reply says what happened once it is saved
      // (`restartedAfterLostConnection`); it says so here too while it streams.
      const targetMessageId = resolveStreamMessageId(data.messageId)
      if (!targetMessageId || typeof data.content !== 'string') {
        return
      }
      if (ignoreLateEventForFinalizedMessage(targetMessageId, data.type)) {
        return
      }
      const currentMessage = messageStore.getMessage(targetMessageId)
      if (!currentMessage || currentMessage.status === 'complete' || currentMessage.status === 'error') {
        return
      }
      const processingState = toolProcessingStates.get(targetMessageId)
      if (processingState) processingState.pendingChunks = []
      const previousToolState = toolStreamStates.get(targetMessageId)
      let resetContent = data.content
      if (previousToolState) {
        const resetToolState = resetToolStreamStateFromContent(
          previousToolState,
          data.content,
          () => toolInsertionSequence++
        )
        toolStreamStates.set(targetMessageId, resetToolState)
        resetContent = composeToolStreamContent(resetToolState)
      }
      messageStore.updateMessage(targetMessageId, {
        content: resetContent,
        metadata: {
          ...(currentMessage.metadata || {}),
          restartedAfterLostConnection: {
            program:
              typeof data.metadata?.program === 'string' && data.metadata.program
                ? data.metadata.program
                : 'The agent'
          }
        }
      })
      realtimeSpeechCoordinator.discardUnspoken(
        targetMessageId,
        data.content,
        typeof data.metadata?.removedText === 'string' ? data.metadata.removedText : null
      )
    } else if (data.type === 'finish') {
      const targetMessageId = resolveStreamMessageId(data.messageId)
      if (!targetMessageId) {
        return
      }
      if (ignoreLateEventForFinalizedMessage(targetMessageId, 'finish')) {
        return
      }

      clearThinkingIndicator(targetMessageId)

      if (!data.usage) {
        return
      }

      const currentMessage = messageStore.getMessage(targetMessageId)
      if (currentMessage) {
        messageStore.updateMessage(targetMessageId, {
          metadata: {
            ...currentMessage.metadata,
            usage: data.usage
          }
        })
      }
    } else if (data.type === 'end') {
      // SA-911: Simplified end event handler
      // Tools are now processed inline during streaming via tool-result events
      const targetMessageId = resolveStreamMessageId(data.messageId)
      if (!targetMessageId) {
        return
      }
      // BL-361: every late event for a finalized message is ignored, except the `end` of a reply
      // this tab's Stop fallback drew, still finalized, when the server finalized that reply: its
      // content and metadata replace the fallback copy on screen (the server saved them, BL-775).
      // Every `end` for the message clears its id, so a reply reopened later ends normally.
      const lateEndAfterStopFallback = shouldAcceptLateEndAfterStopFallback({
        savedByStopFallback: savedByStopFallbackMessageIds.has(targetMessageId),
        isFinalized: isFinalizedMessage(targetMessageId),
        endMetadata: data.metadata
      })
      savedByStopFallbackMessageIds.delete(targetMessageId)
      if (!lateEndAfterStopFallback && ignoreLateEventForFinalizedMessage(targetMessageId, 'end')) {
        return
      }

      const currentMessage = messageStore.getMessage(targetMessageId)
      if (!currentMessage) {
        unregisterActiveMessage(targetMessageId)
        resetToolStateForMessage(targetMessageId)
        return
      }
      markImageOriginExpected(currentMessage.session_id, targetMessageId)
      void refreshImageOrigins(currentMessage.session_id)
      // BL-653: a reply of this chat ended, so a stopped Auto Compact may run again here.
      autoCompactStopHolds = releaseAutoCompactHoldOnReplyEnd(autoCompactStopHolds, currentMessage.session_id)

      clearThinkingIndicator(targetMessageId)

      // BL-775: the server owns the reply's saved record. Its finalize saved this reply and only
      // then published `end`, with the saved bytes: the text (the rebuild of the stream, with the
      // edits this page used to make), the allow-list, the model, the cards. So this tab shows it
      // exactly as it came and saves nothing: what it shows, what is stored, and what the agent
      // reads next are the same bytes.
      const finalContent = typeof data.content === 'string' ? data.content : ''
      const metadata: any =
        data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
          ? data.metadata
          : {}
      logger.debug('[SA-911 End] Final content length:', finalContent.length)

      // Reset tool state for this message
      resetToolStateForMessage(targetMessageId)

      // SA-120 P5: Judge Juice smart zip opened zipped results for this send. The SERVER wrote
      // that state (source `inferred`) at the accepted-send boundary, so this tab re-reads zip
      // state from Redis: the badge then shows the Judge Juice mark and the ordinary countdown
      // closes it.
      const inferredZipChanges = (metadata as any)?.jevJuice?.zips
      if (
        eventSessionContext &&
        Array.isArray(inferredZipChanges?.opened) &&
        inferredZipChanges.opened.length > 0
      ) {
        try {
          const { zippingService } = await import('$lib/services/zipping')
          await zippingService.refreshFromServer(eventSessionContext)
          window.dispatchEvent(
            new CustomEvent('checkZipActivity', { detail: { sessionId: eventSessionContext } })
          )
        } catch (error) {
          console.warn('[Judge Juice] Failed to re-read zip state after a smart zip change:', error)
        }
      }

      messageStore.updateMessage(targetMessageId, {
        status: 'complete',
        content: finalContent,
        metadata,
        intermediateSteps: Array.isArray(data.intermediateSteps) ? data.intermediateSteps : undefined,
        toolPreface: undefined
      })

      // BL-361: a late `end` after a Stop only replaces the copy on screen; the user stopped it, so it
      // is not spoken, not handed to the Goon, and does not reset the composer.
      const forceSpeak = !lateEndAfterStopFallback && isSpeechRequested(metadata)
      const goonAgentId = currentMessage.agent_id ?? resolveAgentIdFromEvent(data)
      if (!forceSpeak) {
        cancelRealtimeSpeechSessions(targetMessageId)
      }
      const speechAgentId = goonAgentId ?? null
      const voiceConfig = resolveVoiceConfig(metadata, speechAgentId)
      const speechVoiceSettings = resolveSpeechVoiceSettings(speechAgentId)
      const realtimeSpeechHandled =
        forceSpeak && voiceService.usesRealtimeTts(voiceConfig)
          ? await finishRealtimeSpeech(targetMessageId, speechAgentId, metadata)
          : false

      if (!realtimeSpeechHandled && !lateEndAfterStopFallback) {
        dispatchGoonSpeechMessage(
          targetMessageId,
          goonAgentId,
          finalContent,
          forceSpeak && voiceService.willSpeakText(finalContent, {
            manual: true,
            voiceSettings: speechVoiceSettings
          })
        )
      }

      if (forceSpeak && !realtimeSpeechHandled) {
        await voiceService.speak(finalContent, {
          voice: voiceConfig,
          voiceSettings: speechVoiceSettings,
          agentId: speechAgentId,
          messageId: targetMessageId,
          goonLipSyncActive: goonPresentationVisible && (activeGoon?.defaults?.lipSync ?? true),
          manual: true
        })
      }

      // AI pinning removed - users can manually pin important content

      // SA-114 P3 (F-P3-B): settle the steer bubbles here too. `end` is the finalise every
      // managed reply reaches; `complete_message` is not — a stopped turn aborts the fetch
      // that carries it, which is how a queued bubble sat at "Queued" for good.
      settleSteerBubblesForMessage(currentMessage.session_id, targetMessageId, {
        interrupted: metadata?.interrupted === true
      })

	      resolveStreamCompletion(targetMessageId)
      unregisterActiveMessage(targetMessageId)
	        const finalizedSessionId = messageStore.getMessage(targetMessageId)?.session_id ?? eventSessionContext
      if (finalizedSessionId) {
        void refreshLiveContextPreview('message-finalized', finalizedSessionId, {
          useStoredMessages: true,
          ignoreBusy: true
        })
        // SA-129 P2 (BL-333): a reply may have made earlier reads dead copies.
        void refreshDeadCopies(finalizedSessionId)
      }

      // Clear the creating session flag now that the response is complete
      // This was preventing loadMessagesForSession from being called too early
      // Clear message ID to indicate completion
      if (finalizedSessionId && isSessionCreating(finalizedSessionId)) {
        logger.debug('[SSE] Clearing creating-session flag - AI response complete', {
          sessionId: finalizedSessionId
        })
        clearCreatingSession(finalizedSessionId)
      }

      // Clear tool call waiting state when message is complete
      syncActiveToolProcessingState()

      // Reset waiting state in ChatInput
      if (!lateEndAfterStopFallback && chatInputRef?.aiResponseReceived) {
        chatInputRef.aiResponseReceived()
      }
    } else if (data.type === 'complete') {
      const targetMessageId = resolveStreamMessageId(data.messageId)
      const isSilent = Boolean(data?.metadata?.silent)
      if (targetMessageId) {
        if (isSilent) {
          if (thinkingSubjects[targetMessageId]) {
            const updatedThinking = { ...thinkingSubjects }
            delete updatedThinking[targetMessageId]
            thinkingSubjects = updatedThinking
          }
          if (planSubjects[targetMessageId]) {
            const updatedPlan = { ...planSubjects }
            delete updatedPlan[targetMessageId]
            planSubjects = updatedPlan
          }
          if (objectSubjects[targetMessageId]) {
            const updatedObject = { ...objectSubjects }
            delete updatedObject[targetMessageId]
            objectSubjects = updatedObject
          }
          messageStore.deleteMessage(targetMessageId)
        } else {
          const currentMessage = messageStore.getMessage(targetMessageId)

          if (currentMessage && currentMessage.status !== 'complete' && data?.metadata?.chatDeleted !== true) {
            // No `end` reached this tab, so its copy can still hold raw control blocks, closed or
            // not; they are hidden (BL-361 review). The server saved the reply (BL-775).
            messageStore.updateMessage(targetMessageId, {
              status: 'complete',
              content: stripUnfinalizedReplyControl(currentMessage.content)
            })
          }
        }

        clearThinkingIndicator(targetMessageId)
        resolveStreamCompletion(targetMessageId)
        unregisterActiveMessage(targetMessageId)
        resetToolStateForMessage(targetMessageId)
	        const finalizedSessionId = messageStore.getMessage(targetMessageId)?.session_id ?? eventSessionContext
        if (finalizedSessionId) {
          void refreshLiveContextPreview('message-finalized', finalizedSessionId, {
            useStoredMessages: true,
            ignoreBusy: true
          })
          void refreshDeadCopies(finalizedSessionId)
        }
      }

      isWaitingForResponse = false
      syncActiveToolProcessingState()
      if (chatInputRef?.aiResponseReceived) {
        chatInputRef.aiResponseReceived()
      }
    } else if (data.type === 'stream_complete') {
      logger.debug('[SSE] Stream complete for session:', data.sessionId)
    } else if (data.type === 'tool_approval_request' || data.type === 'tool-approval-request') {
      const messageId = resolveStreamMessageId(data.messageId)
      if (ignoreLateEventForFinalizedMessage(messageId, data.type)) {
        return
      }
      const targetMessage = resolveMessage(messageId)
      if (messageId && targetMessage) {
        clearThinkingIndicator(messageId)
        const details = extractClaudeApprovalDetails(data)
        const { requestedAt, expiresAt } = extractApprovalTimestamps(data)
        const existingSummary = (targetMessage.metadata as any)?.toolApprovals
        const existingApprovals = Array.isArray(existingSummary?.approvals)
          ? existingSummary.approvals
          : []
        const alreadyTracked = existingApprovals.some(
          (entry: any) => entry?.approvalId === details.approvalId
        )
        if (!alreadyTracked) {
          const approvalSource =
            typeof data?.source === 'string' && data.source.trim().length > 0
              ? data.source.trim()
              : (existingSummary?.source ?? 'vercel')
          const nextApprovals = [
            ...existingApprovals,
	      {
              approvalId: details.approvalId,
              status: 'pending',
              submitted: false,
              ...(requestedAt ? { requestedAt } : {}),
              ...(expiresAt ? { expiresAt } : {}),
              toolName: details.toolName,
              toolCall: details.toolCall,
              input: details.input,
              source: approvalSource
            }
          ]
          messageStore.updateMessage(messageId, {
            metadata: {
              ...(targetMessage.metadata || {}),
              toolApprovals: {
                mode: existingSummary?.mode ?? 'all',
                source: approvalSource,
                approvals: nextApprovals
              }
            }
          })
        }
        setToolProcessing(messageId, true)
      }
    } else if (data.type === 'tool_start' || data.type === 'tool-call') {
      // SA-911 Option D: Pause text streaming when tool execution starts
      const messageId = resolveStreamMessageId(data.messageId)
      if (ignoreLateEventForFinalizedMessage(messageId, data.type)) {
        return
      }
      const targetMessage = resolveMessage(messageId)
      const isApprovalPrompt = isClaudeApprovalTool(data.toolName)
      if (isApprovalPrompt && messageId && targetMessage) {
        // BL-636: only the helper's complete `tool-call` makes or completes the card
        // (`applyClaudeApprovalCardEvent`); its bare `tool_start` changes nothing.
        const existingSummary = (targetMessage.metadata as any)?.toolApprovals
        const nextApprovals = applyClaudeApprovalCardEvent(
          Array.isArray(existingSummary?.approvals) ? existingSummary.approvals : [],
          data,
          extractClaudeApprovalDetails(data),
          extractApprovalTimestamps(data)
        )
        if (nextApprovals) {
          messageStore.updateMessage(messageId, {
            metadata: {
              ...(targetMessage.metadata || {}),
              toolApprovals: {
                mode: 'all',
                source: 'claude',
                approvals: nextApprovals
              }
            }
          })
        }
      }
      if (messageId && targetMessage) {
        clearThinkingIndicator(messageId)
        const toolState = getOrCreateToolStreamState(messageId, targetMessage.content || '')
        const toolKey = resolveToolKey(data, messageId)
        if (toolKey && !toolState.toolPositions.has(toolKey)) {
          toolState.toolPositions.set(toolKey, {
            pos: toolState.textBuffer.length,
            order: toolInsertionSequence++
          })
        }
      }
      logger.debug('[SA-911] Tool call - pausing text streaming', {
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        messageId
      })

      if (messageId) {
        logToolOrderEvent('tool-start', messageId, targetMessage?.content || '', {})
      }

      if (messageId) {
        setToolProcessing(messageId, true)
      }
      const cleanToolName = stripGatewayPrefix(data.toolName || '', data.gatewayName || data.gateway)
      const isImageTool = cleanToolName.toLowerCase().includes('image_generation')
        || cleanToolName.toLowerCase().includes('image-generation')
        || cleanToolName.toLowerCase().includes('generate_image')
      if (isImageTool) {
        logger.debug('[SSE Image Tool] tool-call', {
          toolCallId: data.toolCallId,
          placeholderId: data.placeholderId,
          order: data.order,
          toolName: data.toolName,
          messageId
        })
      }
      if (messageId) {
        setActiveToolCallName(messageId, cleanToolName)
      }

    } else if (data.type === 'tool-result') {
      // SA-911 Option D: Process tool result, insert marker, flush buffered chunks, resume streaming
      const messageId = resolveStreamMessageId(data.messageId)
      if (!messageId) {
        logger.warn('[SA-911] tool-result without messageId, skipping')
        return
      }
      if (ignoreLateEventForFinalizedMessage(messageId, 'tool-result')) {
        return
      }

      if (isClaudeApprovalTool(data.toolName)) {
        const targetMessage = resolveMessage(messageId)
        if (targetMessage) {
          const details = extractClaudeApprovalDetails(data)
          const summary = (targetMessage.metadata as any)?.toolApprovals
          const approvals = Array.isArray(summary?.approvals) ? summary.approvals : []
          const normalizedResult = (() => {
            const raw = data.result ?? data.output ?? data.response
            if (!raw) return null
            if (typeof raw === 'string') {
              try {
                return JSON.parse(raw)
              } catch {
                return raw
              }
            }
            return raw
          })()
          const approved =
            normalizedResult?.behavior === 'allow' ||
            normalizedResult?.decision === 'allow' ||
            normalizedResult?.approved === true ||
            (typeof normalizedResult === 'string' && normalizedResult.toLowerCase().includes('allow'))
          // BL-496 (A6): a card nobody answered ends expired, with its reason, not denied.
          const nextApprovals = settleClaudeApprovalCard(approvals, details.approvalId, data, approved)

          if (nextApprovals.length > 0) {
            messageStore.updateMessage(messageId, {
              metadata: {
                ...(targetMessage.metadata || {}),
                toolApprovals: {
                  mode: summary?.mode ?? 'all',
                  source: summary?.source ?? 'claude',
                  approvals: nextApprovals
                }
              }
            })
          }
        }

        setToolProcessing(messageId, false)
        resetToolStateForMessage(messageId)
        return
      }

      const targetMessage = resolveMessage(messageId)
      if (!targetMessage) {
        logger.warn('[SA-911] No message found for tool-result', { messageId })
        setToolProcessing(messageId, false)
        resetToolStateForMessage(messageId)
        return
      }

	      clearThinkingIndicator(messageId)

	      const cleanToolName = (data.toolName || '').toString()
	      const batshitToolRef =
	        typeof data.args?.ref === 'string' ? data.args.ref.trim() : ''
	      const batshitToolRefSeparatorIndex = batshitToolRef.indexOf(':')
	      const batshitToolRefFamily =
	        batshitToolRefSeparatorIndex > 0
	          ? batshitToolRef.slice(0, batshitToolRefSeparatorIndex).trim()
	          : ''
	      const batshitToolRefTarget =
	        batshitToolRefSeparatorIndex > 0
	          ? batshitToolRef.slice(batshitToolRefSeparatorIndex + 1).trim()
	          : ''
	      const controlUseId =
	        typeof data.args?.controlId === 'string'
	          ? data.args.controlId
	          : typeof data.args?.control_id === 'string'
	            ? data.args.control_id
	            : batshitToolRefFamily === 'artifact' || batshitToolRefFamily === 'fabric'
	              ? batshitToolRefTarget
	              : ''
	      const normalizedToolName = stripGatewayPrefix(cleanToolName, data.gatewayName || data.gateway)
	      const isBatshitToolUse =
	        normalizedToolName === 'batshit_tool_use' || normalizedToolName === 'native_batshit_tool_use'
	      const isArtifactRuntimeWrapper =
	        normalizedToolName === 'mcp_artifact_use' ||
	        normalizedToolName === 'native_artifact_use' ||
	        (isBatshitToolUse && batshitToolRefFamily === 'artifact')
	      const isFabricControlWrapper =
	        normalizedToolName === 'mcp_fabric_use' ||
	        normalizedToolName === 'native_fabric_use' ||
	        (isBatshitToolUse && batshitToolRefFamily === 'fabric')
	      const isArtifactControlUse =
	        (isArtifactRuntimeWrapper || isFabricControlWrapper) &&
	        (controlUseId.startsWith('sys.artifact.') || controlUseId.startsWith('use.artifact.'))
	      const shouldRefreshArtifactPanel =
	        isArtifactControlUse && shouldRefreshArtifactPanelForControl(controlUseId)
	      const isVoiceEngineControlUse =
	        isFabricControlWrapper &&
	        controlUseId.startsWith('sys.voice.engine.')
      const isImageTool = cleanToolName.toLowerCase().includes('image_generation')
        || cleanToolName.toLowerCase().includes('image-generation')
        || cleanToolName.toLowerCase().includes('generate_image')
      if (isImageTool) {
        logger.debug('[SSE Image Tool] tool-result', {
          toolCallId: data.toolCallId,
          placeholderId: data.placeholderId,
          order: data.order,
          zipReferences: Array.isArray(data.zipReferences) ? data.zipReferences.length : 0,
          messageId
        })
      }

      const toolZipRefs = Array.isArray(data.zipReferences) ? data.zipReferences : []
      const toolZipStrings = toolZipRefs
        .map((ref: any) => ref?.reference)
        .filter((ref: any) => typeof ref === 'string' && ref.length > 0)

      // Always prefer zip references. If none arrive, insert a missing-zip
      // placeholder so we never fall back to inline markers — EXCEPT for memory
      // tool steps (DL-104-17): those are deliberately zip-free (summary-first;
      // remembered content rides the DCM channel), so "no zip" is their healthy
      // state. Without this guard the fallback minted an untrusted ref that
      // flashed "[zip reference omitted]" mid-stream and glued the surrounding
      // text together when cleanup removed it (found live 2026-08-29).
      const toolState = getOrCreateToolStreamState(messageId, targetMessage.content || '')
      const toolKey = resolveToolKey(data, messageId)
      const isZipFreeMemoryStep = toolZipStrings.length === 0 && isMemoryControlToolStep(data)
      if (isZipFreeMemoryStep) {
        if (toolKey) {
          toolState.toolPositions.delete(toolKey)
        }
      } else {
        const insertionPosition = toolKey && toolState.toolPositions.has(toolKey)
          ? toolState.toolPositions.get(toolKey)?.pos ?? toolState.textBuffer.length
          : toolState.textBuffer.length
        const toolBlock = toolZipStrings.length > 0
          ? toolZipStrings.join('\n\n')
          : (() => {
              const fallbackToolName = cleanToolName || 'tool'
              const fallbackIdBase =
                typeof data.toolCallId === 'string' && data.toolCallId.length > 0
                  ? data.toolCallId
                  : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
              const fallbackZipId = `cool_tool_missing_${fallbackIdBase}`
              const fallbackReference = `{{batshit-zip:${fallbackZipId}:::Tool execution: ${fallbackToolName}}}`
              return fallbackReference
            })()

        if (toolKey) {
          toolState.toolPositions.delete(toolKey)
        }

        const toolRefs = toolZipStrings.length > 0 ? toolZipStrings : [toolBlock]
        for (const ref of toolRefs) {
          toolState.insertions.push({
            pos: insertionPosition,
            ref,
            order: toolInsertionSequence++
          })
        }
      }

      const updatedContent = composeToolStreamContent(toolState)

      messageStore.updateMessage(targetMessage.id, { content: updatedContent })
      if (eventSessionContext === currentSessionId) {
        scheduleLiveContextPreview('tool-result', 250, { ignoreBusy: true })
      }

      logger.debug('[SA-911] Tool reference inserted', {
        messageId: targetMessage.id,
        toolName: data.toolName,
        zipRefs: toolZipStrings.length,
        usedZipFallback: toolZipStrings.length === 0
      })

      const pendingCount = toolProcessingStates.get(messageId)?.pendingChunks.length ?? 0
      logToolOrderEvent('tool-result', targetMessage.id, updatedContent, {
        zipRefs: toolZipStrings.length,
        usedZipFallback: toolZipStrings.length === 0,
        pendingChunks: pendingCount
      })

      if (shouldRefreshArtifactPanel) {
        scheduleArtifactRefresh('tool-result')
      }

      if (isVoiceEngineControlUse) {
        dispatchVoiceEnginesUpdated({
          source: 'tool-result',
          controlId: controlUseId,
          messageId: targetMessage.id,
          toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : null
        })
      }

      // Flush any buffered chunks that arrived during tool processing
      flushPendingChunks(messageId)
      setToolProcessing(messageId, false)

    } else if (data.type === 'tool_end') {
      // SA-911: tool_end is now handled by tool-result, just clear state if needed
      // n8n streams can emit tool_end without a preceding tool-result; in that case
      // we must resume streaming and flush anything buffered or the stream will stall.
      const messageId = resolveStreamMessageId(data.messageId)
      if (ignoreLateEventForFinalizedMessage(messageId, 'tool_end')) {
        return
      }
      if (messageId) {
        const processingState = toolProcessingStates.get(messageId)
        if (processingState?.isProcessing) {
          flushPendingChunks(messageId)
        }
        setToolProcessing(messageId, false)
      }
      logger.debug('[SA-911] tool_end received')

    } else if (data.type === 'cool_tool' && resolveStreamMessageId(data.messageId)) {
      // Legacy path - Cool Tools now come via tool-result events
      logger.debug('[SA-911] Ignoring legacy cool_tool event - handled via tool-result')

    } else if (data.type === 'error') {
      const rawMessage = data.message || data.error || 'Unknown error'
      lastStreamRuntimeErrorAt = Date.now()
      const context = {
        provider: data?.metadata?.provider ?? null,
        connection: data?.metadata?.connection ?? null,
        model: data?.metadata?.model ?? null
      }
      const parsed = parseParameterError(rawMessage)
      if (parsed) {
        const now = Date.now()
        if (lastParamToastMessage !== parsed.message || now - lastParamToastAt > 2000) {
          const toastInfo = buildParameterErrorToast(parsed, context)
          toast.error(toastInfo.title, { description: toastInfo.description })
          lastParamToastMessage = parsed.message
          lastParamToastAt = now
        }
      } else {
        toast.error('Error: ' + rawMessage)
      }
      const targetMessageId = resolveStreamMessageId(data.messageId)
      if (ignoreLateEventForFinalizedMessage(targetMessageId, 'error')) {
        return
      }
      if (targetMessageId) {
        const existing = messageStore.getMessage(targetMessageId)
        const existingContent =
          typeof existing?.content === 'string' ? existing.content.trim() : ''
        messageStore.updateMessage(targetMessageId, {
          content: existingContent || rawMessage,
          status: 'error',
          metadata: {
            ...(existing?.metadata || {}),
            ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}),
            error_message: rawMessage
          }
        })
        if (thinkingSubjects[targetMessageId]) {
          const updatedSubjects = { ...thinkingSubjects }
          delete updatedSubjects[targetMessageId]
          thinkingSubjects = updatedSubjects
        }
        unregisterActiveMessage(targetMessageId)
        resetToolStateForMessage(targetMessageId)
        resolveStreamCompletion(targetMessageId)
      }
	      // Clear waiting states on error
	      isWaitingForResponse = false
	      syncActiveToolProcessingState()
	    }
	    } finally {
	      eventSessionContext = null
	    }
	  }

  /**
   * BL-382: the server added this chat's listener again (the live connection came back, or the hub
   * took back a silent tab). It replays only a turn still running, so a reply that ended while the
   * tab was away (its buffer goes 5 s after `end`) is read from the server here, once per return,
   * for the chat on screen and for a chat still streaming a reply in this tab (an idle chat in the
   * background is read when it is opened; `shouldCatchUpChatAfterReconnect`). The replay was written
   * before this `open`, and the order does not matter: a reply still streaming has no stored copy
   * yet, and the load keeps this tab's in-progress copy while the chat is busy
   * (`preserveLocalInProgress`), so it is neither cut nor doubled; a reply the server finished
   * replaces the half-written copy.
   */
  function handleSSEReconnected(sessionId: string) {
    toast.dismiss(SSE_RECONNECT_TOAST_ID)
    const catchUp = shouldCatchUpChatAfterReconnect({
      onScreen: sessionId === sessionStore.getCurrentSessionId(),
      streamingReplyIds: chatRunRegistry.getRunState(sessionId).activeStreamMessageIds
    })
    if (!catchUp) return
    void catchUpAfterReconnect(sessionId)
  }

  /**
   * BL-382: read the chat again, then end this tab's busy state for each reply that ended on the
   * server while the tab was away (it never heard that `end`), taking the steps `end` takes: no
   * save, the server already stored the reply. A reply still running keeps its busy state, and its
   * replay goes on (`resolveRepliesEndedWhileAway` says why the reload is the answer). This also
   * covers a replayed `end` that arrives after the reload: the reload marked its message finished,
   * so `ignoreLateEventForFinalizedMessage` drops it.
   */
  async function catchUpAfterReconnect(sessionId: string) {
    await loadMessagesForSession(sessionId)
    const ended = resolveRepliesEndedWhileAway({
      activeMessageIds: chatRunRegistry.getRunState(sessionId).activeStreamMessageIds,
      messages: messageStore.getMessages(sessionId)
    })
    for (const messageId of ended) {
      clearThinkingIndicator(messageId)
      settleSteerBubblesForMessage(sessionId, messageId, {
        interrupted: messageStore.getMessage(messageId)?.metadata?.interrupted === true
      })
      resetToolStateForMessage(messageId)
      resolveStreamCompletion(messageId)
      unregisterActiveMessage(messageId, sessionId)
    }
    if (ended.length === 0) return
    autoCompactStopHolds = releaseAutoCompactHoldOnReplyEnd(autoCompactStopHolds, sessionId)
    void refreshLiveContextPreview('message-finalized', sessionId, {
      useStoredMessages: true,
      ignoreBusy: true
    })
    void refreshDeadCopies(sessionId)
    if (isSessionCreating(sessionId)) clearCreatingSession(sessionId)
    syncActiveToolProcessingState()
    if (sessionId === sessionStore.getCurrentSessionId()) chatInputRef?.aiResponseReceived?.()
  }

	  function handleSSEError(error: any, sourceSessionId?: string | null) {
	    console.error('[SSE] Error:', error)
	    const now = Date.now()
	    const isSelectedSession = !sourceSessionId || sourceSessionId === sessionStore.getCurrentSessionId()
	    if (isSelectedSession && now - lastSseToastAt > 5000) {
	      lastSseToastAt = now
	      toast.error('Connection lost. Reconnecting...', {
	        id: SSE_RECONNECT_TOAST_ID,
        description: 'Batshit will keep trying to restore the live stream until the connection comes back.'
      })
    }

    // Clear the creating session flag on error
  if (sourceSessionId && isSessionCreating(sourceSessionId)) {
    logger.debug('[SSE Error] Clearing creating-session flag due to error', {
      sessionId: sourceSessionId
    })
    clearCreatingSession(sourceSessionId)
  }
}


  /**
   * SA-120 P9: a spoken turn that was ONLY a quick action (DL-120-15). The words are stored as a
   * user message with the mark, so the user sees what was said and what Batshit did, and so the
   * next turn's DCM can tell the agent; no agent turn runs. Same three writes as a send (the
   * store, the spectator broadcast, the record), no `send-routed`.
   */
  async function handleQuickActionMessage(content: string, mark: QuickActionMark) {
    const sessionIdForMark = sessionStore.getCurrentSessionId()
    const agent = agentStore.getCurrentAgent()
    if (!sessionIdForMark || !agent || !data.user) return
    const id = await generateClientMessageId(sessionIdForMark, 'msg_user_client')
    const now = new Date().toISOString()
    const userMessage = {
      id,
      content,
      role: 'user' as const,
      session_id: sessionIdForMark,
      agent_id: agent.id,
      user_id: data.user.id,
      created_at: now,
      timestamp: now,
      status: 'complete' as const,
      metadata: {
        client_sent: true,
        error_message: null,
        hasAttachments: false,
        attachmentCount: 0,
        stt: true,
        tts: true,
        voiceMode: true,
        fileReferences: [],
        clipIds: [],
        quickAction: mark,
        zipIds: []
      }
    }
    messageStore.addMessage(userMessage)
    try {
      await fetch('/api/sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-sse-forward': '1' },
        body: JSON.stringify({ type: 'user_message', sessionId: sessionIdForMark, message: userMessage })
      })
    } catch (error) {
      console.error('[handleQuickActionMessage] Failed to broadcast the quick-action turn via SSE:', error)
    }
    await new DatabaseService().saveMessage(userMessage, agent)
  }

		  async function handleSendMessage(
		    content: string,
		    metadata: any = {},
		    // Review F-P3b-1: a replay from a receipt's Send now. Not metadata, because
		    // `requestMetadata` spreads metadata into the request body and a placeholder record.
		    sendOptions: { fromDroppedReceipt?: boolean; existingUserMessageId?: string; onNoReplyCompleted?: () => void; onReplyAdmitted?: (kind: 'direct' | 'steer' | 'queued') => void; onSteerPrepared?: (identity: { steerId: string; sessionId: string; targetMessageId?: string }) => void } = {}
		  ) {
		    const goonPresentationMode: DesktopGoonPresentationMode | null = goonDcmPresentationMode
		    metadata = {
		      ...metadata,
		      goonsEnabled: goonPresentationMode !== null,
		      goonPresentationMode: goonPresentationMode ?? undefined
		    }
		    const sendChatInput = chatInputRef
		    const composerSessionId = normalizeComposerSessionId(metadata?.composerSessionId)
		    if (composerSessionId && sessionStore.getCurrentSessionId() !== composerSessionId) {
		      logger.debug('[handleSendMessage] Aligning store to composer session before send', {
		        composerSessionId,
		        storeSessionId: sessionStore.getCurrentSessionId()
		      })
		      sessionStore.setCurrentSessionId(composerSessionId)
		    }

		    let sendSessionId = composerSessionId ?? sessionStore.getCurrentSessionId() ?? '__new_session__'
	    const selectedRunState = chatRunRegistry.getRunState(sendSessionId)
	    const canInterruptInFlightResponse = hasInterruptibleActiveResponse({
	      activeStreamCount: selectedRunState.activeStreamMessageIds.length,
	      hasAbortController: Boolean(selectedRunState.abortController)
	    })

	    if (
	      shouldBlockSendWhileInFlight({
	        sendInFlight: isSendInFlight(sendSessionId),
	        hasInterruptibleActiveResponse: canInterruptInFlightResponse
	      })
	    ) {
	      logger.debug('[handleSendMessage] Ignoring duplicate send while request setup is already in flight')
	      return false
	    }

	    setSendInFlight(sendSessionId, true)
	    const sendRunId = nextSendSerial(sendSessionId)
	    let managedAssistantMessageId: string | null = null

	    try {
      if (!content.trim()) return false
      content = neutralizeAllZipReferenceSyntax(content)
      content = neutralizeUntrustedClipReferenceSyntax(content, {
        trustedClipIds: collectTrustedClipIdsFromMetadata(metadata)
      })

      // SA-118 (DL-118-08): a "Not sent — you stopped the reply" bubble is a receipt, and
      // the user acting again is what it was waiting for. Cleared HERE — after the empty
      // and duplicate guards, so a stray keypress does not wipe it, and before the steer
      // branch, so this send's own bubble is never the one removed. Only `dropped` goes:
      // a `queued` or `waiting` bubble belongs to a reply that is still running.
      // Review F-P3b-1: a receipt's own Send now is the user acting on THAT receipt, not on
      // the others in the chat — each of those is still waiting for its own button, and the
      // composer no longer holds their words (AMD-119-05), so clearing them here would be
      // the loss this story exists to prevent.
      if (!sendOptions.fromDroppedReceipt) {
        steerInbox.clearDroppedSteersForSession(sendSessionId)
        prunePayloadsForForgottenSteers()
      }

      // SA-114 P3 (DL-114-11, AMD-114-07): a send stops any speech still playing — UNLESS
      // it turns out to be a steer, which does not stop the reply and so must not stop its
      // voice. The decision needs the session, the agent and the run's steerability, none
      // of which are resolved yet here, so the stop moves DOWN into the two branches that
      // keep it: the interrupt branch below, and the ordinary send after it.
      // This is a correction to the lock's premise, not to its rule: the lock said only the
      // Stop button called `stopRealtimeSpeechPlayback` and an interrupt-mode send had to
      // gain it, but every send already called it, unconditionally, right here.

      logger.debug('[handleSendMessage] Starting - setting isWaitingForResponse to true')

	      let currentSessionId = composerSessionId ?? sessionStore.getCurrentSessionId()
      let currentAgent = agentStore.getCurrentAgent()
      // Keep the last trusted zip-aware estimate visible while a send is in flight.
      // The finalized response refresh below replaces it after the message is saved.

    // Guard against stale selected session IDs (for example, deleted sessions still in localStorage)
    if (currentSessionId) {
      const knownSessions = sessionStore.getSessions()
      const isKnownSession = knownSessions.some((session) => session.id === currentSessionId)

      if (!isKnownSession) {
	        try {
	          const sessionCheck = await fetch(`/api/sessions/${currentSessionId}`)
	          if (!sessionCheck.ok) {
	            logger.debug('[handleSendMessage] Clearing stale session ID before send', { currentSessionId })
	            if (sessionCheck.status === 404) {
	              clearMissingSelectedSession(currentSessionId, 'send-validation')
	            } else {
	              sessionStore.setCurrentSessionId(null)
	            }
	            currentSessionId = null
	          }
        } catch (error) {
          logger.warn('[handleSendMessage] Failed to validate current session, forcing auto-create path', {
            currentSessionId,
            error
          })
          sessionStore.setCurrentSessionId(null)
          currentSessionId = null
        }
      }
    }

	    if (!currentAgent) {
	      toast.error('Please select a agent first')
	      return false
    }
      let currentAgentForSend: agentStore.Agent = currentAgent

      try {
        const response = await fetch(`/api/agents/${currentAgentForSend.id}`)
        const payload = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to refresh selected agent')
        }
        currentAgentForSend = {
          ...currentAgentForSend,
          ...payload
        }
        agentStore.updateAgent(currentAgentForSend.id, currentAgentForSend)
      } catch (error) {
        console.error('[handleSendMessage] Failed to refresh selected agent before send:', error)
        toast.error(
          error instanceof Error
            ? error.message
            : 'Failed to refresh selected agent before send'
        )
        return false
      }

	    const agentType = normalizePrimaryAgentType(currentAgentForSend)
	    const activeRunsBeforeSend = chatRunRegistry.getActiveRunStates()

	    const activeChatCapacity = evaluateActiveChatCapacity({
	      activeRuns: activeRunsBeforeSend,
	      currentSessionId
	    })
	    if (!activeChatCapacity.allowed) {
	      toast.info(activeChatCapacity.title, {
	        description: activeChatCapacity.description
	      })
	      return false
	    }

    // If no session exists (app was just launched), create one now
    if (!currentSessionId) {
      // Check again in case it was just created by the New Chat button
      currentSessionId = sessionStore.getCurrentSessionId()
      logger.debug('[handleSendMessage] Double-checking session ID after potential New Chat:', currentSessionId)

      if (!currentSessionId) {
        // Make sure we have a user before creating session
        if (!data.user?.id) {
          toast.error('User not authenticated')
          return false
        }

        const sessionService = new SessionService()

        try {
	          // Get default folder for the new session
          if (foldersStore.folders.length === 0) {
            await foldersStore.loadFolders()
          }
          const defaultFolder = foldersStore.defaultFolder
          const folderId = defaultFolder?.id

	          const newSession = await sessionService.createSession(data.user.id, folderId, currentAgentForSend.id)
	          currentSessionId = newSession.id
	          logger.debug('[handleSendMessage] Created new session:', currentSessionId, 'in folder:', folderId)
	          markCreatingSession(currentSessionId)

          // Reload sessions to update the sidebar UI
          await sessionService.loadSessions(data.user.id, false)

          // Connect SSE for the new session and wait for it to be ready
          try {
            await connectSSE(currentSessionId)
            logger.debug('[handleSendMessage] SSE connection ready for new session')
            if (sessionStore.getCurrentSessionId() === currentSessionId) {
              currentSSESessionId = currentSessionId
            }
	          } catch (error) {
	            console.error('[handleSendMessage] Failed to connect SSE:', error)
	            toast.error('Failed to establish connection. Please try again.')
	            clearCreatingSession(currentSessionId)
	            return false
	          }

          // Don't clear the flag here - wait until the AI response is complete
          // This prevents loadMessagesForSession from clearing the AI placeholder
	        } catch (error) {
	          console.error('Failed to create session:', error)
	          // Clear the flag on error
	          clearCreatingSession(currentSessionId)
	          // Log more details about the error
	          if (error instanceof Error && error.message) {
            console.error('Error message:', error.message)
            toast.error(`Failed to create session: ${error.message}`)
          } else {
            toast.error('Failed to create session')
          }
          return false
        }
	      } else {
	        // Session was created by New Chat button, ensure SSE is connected
	        const existingSseService = sseServices.get(currentSessionId)
	        if (!existingSseService || !existingSseService.isConnected()) {
	          logger.debug('[handleSendMessage] Session exists but SSE not connected, connecting now')
          try {
            await connectSSE(currentSessionId)
            logger.debug('[handleSendMessage] SSE connection ready for existing session')
            if (sessionStore.getCurrentSessionId() === currentSessionId) {
              currentSSESessionId = currentSessionId
            }
          } catch (error) {
            console.error('[handleSendMessage] Failed to connect SSE:', error)
            toast.error('Failed to establish connection. Please try again.')
            return false
          }
        }
      }
	    }

	    if (currentSessionId && sendSessionId !== currentSessionId) {
	      setSendInFlight(sendSessionId, false)
	      sendSessionId = currentSessionId
	      setSendInFlight(sendSessionId, true)
	      sendInFlightSerialBySession.set(sendSessionId, sendRunId)
	    }

	    const fileReferences = Array.isArray(metadata?.fileReferences) ? metadata.fileReferences : []
	    const sendManualTrimProtections = getCurrentManualTrimProtections(
	      collectTrustedClipIdsFromMetadata(metadata)
	    )
    const subagentSnapshot = Array.isArray(currentAgentForSend.assigned_subagent_ids)
      ? [...currentAgentForSend.assigned_subagent_ids]
      : Array.isArray((currentAgentForSend as any).assignedSubagents)
        ? (currentAgentForSend as any).assignedSubagents
            .map((sw: any) => sw?.id ?? sw)
            .filter((id: any) => typeof id === 'string')
        : []
	    /**
	     * DL-119-07: the interruption stamp is gone with the branch that wrote it. A SEND
	     * never interrupts any more, so the field it filled was always going to be absent;
	     * leaving the variable behind would have left a permanently-null value two message
	     * records read.
	     *
	     * `postSendRoutedWithInterruptRetry` still needs to know a Stop may have just run —
	     * that is `lastManualInterruptAtBySession`, written by `handleStopStream`, which does
	     * not change.
	     */
	    const hasActiveStream = chatRunRegistry.isSessionBusy(currentSessionId)

	    /**
	     * SA-119 P2 (DL-119-02, DL-119-05, DL-119-06, DL-119-07) — steer or queue.
	     *
	     * Two outcomes, never three. **Steer** hands the words to the server, which places
	     * them inside this reply at the agent's next tool boundary. **Queue** sends them the
	     * moment the reply ends, and has two holders under one word, both on the server: the
	     * steer inbox holds a text-only message on a steerable turn (`deliver: 'end'`, promoted
	     * into the next turn's user message), and the chat's line holds anything else (files, a
	     * group chat, an unmanaged profile, a Codex exec lane), sent at once (BL-713, below).
	     *
	     * **Interrupt-and-send is gone** (DL-119-07). Stop, then Enter, is that job, and it
	     * is one gesture the user chose rather than a side effect of a send. Nothing here may
	     * stop a running reply.
	     *
	     * `busySendModeOverride` is the composer's own answer — a badge click, or whichever
	     * key was pressed. It is trusted because only the composer knows what is in the box;
	     * when it is absent (a Voice Mode send, a programmatic one) the same rule is read
	     * here from the metadata this send is about to post, so the two cannot disagree.
	     */
	    const busySendOverride: BusySendMode | null =
	      metadata?.busySendModeOverride === 'steer' || metadata?.busySendModeOverride === 'queue'
	        ? metadata.busySendModeOverride
	        : null

	    // DL-114-10 says files are never steered. PR #106 review F-23: an `@file` mention is a
	    // file too — it travels as `metadata.fileReferences`, which the steer route cannot carry,
	    // so steering it handed the model the bare path with no content behind it and no error.
	    // DL-119-02 needs the two APART: a clip may stay in the composer while the words steer,
	    // and a mention may not, because the path is inline in the text being sent.
	    const sendCarriesClips = collectTrustedClipIdsFromMetadata(metadata).length > 0
	    const sendCarriesMentions =
	      Array.isArray(metadata?.fileReferences) && metadata.fileReferences.length > 0
	    const sendCarriesAttachments = sendCarriesClips || sendCarriesMentions

	    const runSteerable = activeGroupId
	      ? false
	      : chatRunRegistry.getRunState(currentSessionId).steerable
	    // The SAME rule the badges read, so the badge cannot promise one thing while the send
	    // does another — the failure SA-114 built `resolveEffectiveBusySendMode` to remove and
	    // DL-119-02 replaced it to keep removing.
	    const busySendActions = resolveBusySendActions({
	      mode: busySendMode,
	      steerable: runSteerable,
	      hasClips: sendCarriesClips,
	      hasMentions: sendCarriesMentions
	    })
	    const busySendAction: BusySendMode = busySendOverride ?? busySendActions.enter

	    // BL-4: a Send now of a message already in the chat goes the ordinary way even while the
	    // agent is busy: the server queues it behind the running turn, reusing that message. The
	    // steer route would write it again as a new message.
	    const managedBusy =
	      isManagedPrimaryAgentType(agentType) && hasActiveStream && !sendOptions.existingUserMessageId
	    /**
	     * Can this turn hold the words on the SERVER's steer inbox at all?
	     *
	     * Both doors go through one answer because they are one route: a steer and a
	     * server-held queue differ only in `deliver`. A send that fails this test waits in the
	     * chat's line instead (BL-713, below), which is why nothing below falls through to a
	     * send into a live reply.
	     */
	    const turnCanHoldText = managedBusy && runSteerable !== false && !sendCarriesAttachments
	    const steerBranchEligible = turnCanHoldText && busySendAction === 'steer'
	    const serverQueueEligible = turnCanHoldText && busySendAction === 'queue'

	    if (steerBranchEligible || serverQueueEligible) {
	      // DL-119-05: one field decides which promise was made. `now` lands inside this
	      // reply; `end` is held by the server and becomes the next turn's user message.
	      const deliver: SteerDeliver = steerBranchEligible ? 'now' : 'end'
	      const steerRunState = chatRunRegistry.getRunState(currentSessionId)
	      const steerTargetMessageId =
	        steerRunState.activeMessageId ?? steerRunState.activeStreamMessageIds[0] ?? null

	      if (!steerTargetMessageId) {
	        // F-P3-2: a reply Batshit started on its own tells this tab its assistant id on
	        // `session_run_status`, but only once send-routed has registered the run; before
	        // that there is nothing to aim a steer at. A click that promised to steer must
	        // never fall through to something else, so say so and keep the words where they are.
	        toast.info('The reply is still starting. Send again in a moment.')
	        return false
	      }

	      {
	        const steerId = `steer_${crypto.randomUUID().replace(/-/g, '')}`
	        // Optimistic, as DL-114-14 describes: the bubble is drawn BEFORE the round trip
	        // and removed if the route refuses. The route can now hold a steer for a few
	        // seconds while send-routed is still compiling (F-P3-1), and that wait must not
	        // look like a dead button.
	        steerInbox.noteLocalSteer({
	          steerId,
	          sessionId: currentSessionId,
	          messageId: steerTargetMessageId,
	          text: content,
	          deliver
	        })
	        // AMD-119-05: kept before the round trip, like the bubble, so a refusal or a Stop
	        // arriving mid-flight still finds it.
	        resendableSteerPayloads.set(steerId, { content, metadata: replayableSendMetadata(metadata) })
	        sendOptions.onSteerPrepared?.({ steerId, sessionId: currentSessionId, targetMessageId: steerTargetMessageId })
        const outcome = await postSteer({
	          sessionId: currentSessionId,
	          messageId: steerTargetMessageId,
	          steerId,
	          text: content,
	          deliver
	        })

	        if (outcome.kind === 'accepted') {
            sendOptions.onReplyAdmitted?.('steer')
	          // The server owns the text from here: it either lands inside this reply or
	          // becomes the next message when the reply ends (DL-114-07, DL-119-05). Nothing
	          // else in this function runs — no user record is written (DL-114-04), no turn
	          // starts, and the voice keeps playing, because neither a steer nor a queued
	          // message stops the reply.
	          if (typeof metadata?.onAccepted === 'function') {
	            await metadata.onAccepted()
	          }
	          return true
	        }

	        steerInbox.forgetSteer(steerId)
	        if (outcome.kind === 'already_finished') {
	          // The reply ended between the button and the route (a simulated-streaming reply
	          // finishes SERVER-side while the tab is still typing it out; measured on BSMS,
	          // 2026-09-11). The words go as an ordinary send below: the chat's line holds them
	          // if the reply's request still has the chat (BL-4), and they run at once if not.
	          logger.debug('[handleSendMessage] Steer refused: that reply had already finished')
	        } else if (outcome.kind === 'queue') {
	          // DL-119-07: the server says this reply cannot take a steer at all. That answer
	          // is QUEUE, not a stop the user never asked for — the words are sent below and
	          // wait in the chat's line until the reply ends (BL-713).
	          logger.debug('[handleSendMessage] Steer refused as not steerable; the send waits in the line')
	        } else {
	          // PR #106 review F-4: the server said no WITHOUT ending the reply — the cap, a
	          // waiting DM, a bad request, an outage. The reply keeps running and the steers it
	          // already accepted stay; nothing here may fall through to a send the user never
	          // asked for, so the words stay in the composer.
	          toast.info(outcome.reason)
	          return false
	        }
	      }
	    }

	    /**
	     * BL-713 — the page keeps no queue of its own.
	     *
	     * A send while a reply runs that the steer route did not take (a Clip, an `@file`
	     * mention, a group chat, a lane that cannot take a steer, a steer refused as not
	     * steerable or as too late) is saved and posted at once, like any send. The server holds
	     * it in the chat's line (BL-4) and runs it as itself when the reply ends, with its own
	     * Clips, files and send options, tab or no tab; at an approval card the line waits for
	     * the user's answer. Every tab shows it as the line's Queued bubble (`steer_queued`), so a
	     * reload, a closed tab or a second window loses nothing. Until BL-713 the page held these
	     * in the tab (DL-119-06) and saved them only when the reply ended: a reload lost them.
	     *
	     * Such a send starts no run here and draws no reply placeholder: the reply that is
	     * running keeps this tab's run state (its busy state, its Stop, its voice). The send's
	     * own reply appears when it starts, like a reply another tab started.
	     */
	    const sendWaitsInLine = isManagedPrimaryAgentType(agentType) && hasActiveStream
      // BL-1291/1295: the page's actual local admission ends Voice preparation. Direct
      // keeps its own stream completion; queued waits for its own terminal response.
      sendOptions.onReplyAdmitted?.(sendWaitsInLine ? 'queued' : 'direct')

	    // Nothing below stops a reply: DL-119-07 retired interrupt-and-send, and Stop is the only
	    // thing that interrupts. A send that waits in the line leaves the running reply's voice
	    // alone, as a steer and a queued text do (DL-114-11).
	    if (!sendWaitsInLine) stopRealtimeSpeechPlayback()

	    /**
	     * SA-119 P2b (F-P2-7) — the interruption note, written from Stop's record alone.
	     *
	     * The record is CONSUMED here whatever happens next, so one Stop can only ever
	     * colour the one send that follows it. Whether it then becomes a stamp is
	     * `resolveStopInterruptionStamp`'s decision, in the rules module beside
	     * `resolveBusySendActions`, because it has real behaviour and belongs where a test
	     * can mutate it — this file can only be pinned on order and reachability. A steer and a
	     * server-held queued text return far above; every other send, one that waits in the
	     * chat's line included (BL-713), reads the record here, as it was when Enter was pressed.
	     */
	    const stopInterruptionRecord =
	      pendingStopInterruptionBySession.get(currentSessionId) ?? null
	    pendingStopInterruptionBySession.delete(currentSessionId)
	    const latestAssistantMessageId = (() => {
	      const sessionMessages = messageStore.getMessages(currentSessionId)
	      for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
	        const candidate = sessionMessages[index]
	        if (candidate?.role === 'assistant') return candidate.id ?? null
	      }
	      return null
	    })()
	    const stopInterruption = resolveStopInterruptionStamp({
	      record: stopInterruptionRecord,
	      latestAssistantMessageId
	    })

	    // Generate standardized message ID (Story 6.9b)
	    // BL-4: a Send now of a kept message reuses it: same id, nothing written again.
	    let userId =
	      sendOptions.existingUserMessageId ??
	      (await generateClientMessageId(currentSessionId, 'msg_user_client'))

	    // Create user message with agent_id for consistency
    const userMessage = {
      id: userId,
      content,
      role: 'user' as const,
      session_id: currentSessionId,
      agent_id: currentAgentForSend.id,
      user_id: data.user!.id, // We already checked this exists above
      created_at: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      status: 'complete' as const,
      metadata: {
        client_sent: true,
        error_message: null,
        hasAttachments: false,
        attachmentCount: 0,
        stt: metadata.stt || false,
        tts: metadata.tts || false,
        voiceMode: metadata.tts || false,
        fileReferences,
        clipIds: collectTrustedClipIdsFromMetadata(metadata),
        projectPath: metadata.projectPath ?? null,
        subagentSnapshot,
        skillInvocation:
          metadata?.skillInvocation && typeof metadata.skillInvocation === 'object'
            ? metadata.skillInvocation
            : undefined,
        // F-P2-7: both write sites, as `metadata.wake` learned to be — send-routed reads
        // the request body first and this record second, and a recompile only has this one.
        interruption: stopInterruption ?? undefined,
        // SA-120 P9: a quick action ran on this spoken turn and the rest went to the agent.
        quickAction: metadata?.quickAction && typeof metadata.quickAction === 'object' ? metadata.quickAction : undefined,
        zipIds: []
      }
    }

    // Note: Visual indicators now fetch metadata directly from Redis
    // don't appear immediately anyway due to the compilation architecture.
    // The tags are embedded in content and will be detected after the next message.

    // BL-4: a Send now of a kept message is already in the chat and in every tab's list.
    if (!sendOptions.existingUserMessageId) {
      // Add user message to store
      messageStore.addMessage(userMessage)

      // Broadcast user message so spectator tabs update immediately
      try {
        await fetch('/api/sse', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-sse-forward': '1'
          },
          body: JSON.stringify({
            type: 'user_message',
            sessionId: currentSessionId,
            message: userMessage
          })
        })
      } catch (error) {
        console.error('[handleSendMessage] Failed to broadcast user message via SSE:', error)
      }

      // Save user message to database
      const dbService = new DatabaseService()
      await dbService.saveMessage(userMessage, currentAgentForSend)
    } else {
      moveResentMessageToEnd(currentSessionId, userId, userMessage.created_at)
    }
    sessionStore.updateSession(currentSessionId, { agent_id: currentAgentForSend.id })

    if (typeof metadata?.onAccepted === 'function') {
      await metadata.onAccepted()
    }

    // Trigger zip activity check immediately after adding message
    // This ensures visual indicators update right away when buffer thresholds are reached
    window.dispatchEvent(new CustomEvent('checkZipActivity', {
      detail: {
        sessionId: currentSessionId,
        trigger: 'user_message_added',
        timestamp: Date.now()
      }
    }))

    try {
      logger.debug('[handleSendMessage] Sending with session ID:', currentSessionId)

	      // Set waiting state. BL-713: not for a send that waits in the chat's line: the reply
	      // that is running owns this tab's waiting and tool state.
	      if (!sendWaitsInLine) {
	        isWaitingForResponse = true
	        clearActiveToolProcessingState(currentSessionId)
	      }
      logger.debug('[handleSendMessage] States set:', { isWaitingForResponse, isWaitingForToolCall })

      // Force a tick to ensure state update propagates
      await tick()

      const agentWithOverride = currentAgentForSend

      // SA-106: `api` and `cli` are the only primary-agent types, and both use the
      // managed send-routed lane. A stored agent still carrying the retired `n8n`
      // type comes through here too and is rejected loudly by send-routed's
      // retirement guard — the browser no longer owns a second send path.
      {
	        const liveAgentType: 'api' | 'cli' = agentType === 'cli' ? 'cli' : 'api'
        const groupChatSendId = getGroupChatIdForSession(currentSessionId)
        managedAssistantMessageId = groupChatSendId
          ? null
          : await generateClientMessageId(currentSessionId, 'msg_assistant_client')
        // BL-713: a send that waits in the chat's line draws no reply placeholder and starts no
        // run: the running reply keeps this tab's run state, so its Stop and busy state stay its
        // own (`startRun` replaces the chat's run state whole). Its reply opens when it starts.
        if (managedAssistantMessageId && !sendWaitsInLine) {
          createAssistantWaitingPlaceholder({
            messageId: managedAssistantMessageId,
            sessionId: currentSessionId,
            agentId: agentWithOverride.id,
            userId: data.user!.id,
            metadata: {
              voiceMode: metadata?.voiceMode ?? (voiceMode ? 'voice' : 'text')
            }
          })
        }

	        const abortController = new AbortController();
	        if (!sendWaitsInLine) {
	          chatRunRegistry.startRun({
	            sessionId: currentSessionId,
	            transport: liveAgentType,
	            activeMessageId: managedAssistantMessageId,
	            abortController
	          })
	        }

          const requestMetadata = {
            ...metadata,
            agent: agentWithOverride,
            sessionId: currentSessionId,
            selectedTools: metadata?.selectedTools,
            selectedGateways: metadata?.selectedMCPs || metadata?.selectedGateways,
            mcpToolSelections: metadata?.mcpToolSelections,
            stt: metadata?.stt ?? false,
            tts: metadata?.tts ?? false,
            voiceMode: metadata?.voiceMode ?? (voiceMode ? 'voice' : 'text'),
            realtime: metadata?.realtime ?? false,
            interruption: stopInterruption ?? undefined
          };

        try {
	          const messagesForSend = getMessagesForSend(currentSessionId, sendManualTrimProtections)
          const routedRequestBody = {
            content,
            sessionId: currentSessionId,
            agentId: agentWithOverride.id,
            messageId: managedAssistantMessageId ?? undefined,
            // BL-4: the message this send saved. If the chat is busy, the server holds the send
            // until it is free and reuses this message (never a second copy).
            userMessageId: userId,
            messages: (() => {
              // A Send now of a kept message: it is the current turn, so it goes last.
              const allMsgs = sendOptions.existingUserMessageId
                ? placeUserMessageLast(messagesForSend, userId, managedAssistantMessageId)
                : messagesForSend
              // Strip large fields to prevent oversized request payloads.
              // intermediateSteps (400KB+ for artifact builds) are never needed by the server from the client.
              // providerMessages (375KB+) are only needed from the last few assistant messages for continuation.
              const lastAssistantIdx = allMsgs.reduce((acc, m, i) => m.role === 'assistant' ? i : acc, -1)
              return allMsgs.map((m, i) => ({
                ...m,
                intermediateSteps: undefined,
                metadata: m.metadata
                  ? { ...m.metadata, providerMessages: i >= lastAssistantIdx - 1 ? m.metadata.providerMessages : undefined }
                  : undefined
              }))
            })(),
            agentType,
            metadata: requestMetadata
          }
          inFlightSendPayloads.set(userId, { content, metadata: replayableSendMetadata(metadata) })
          const routedSend = await postSendRoutedWithInterruptRetry({
            body: routedRequestBody,
            signal: abortController.signal,
	            wasInterrupting:
	              Date.now() - (lastManualInterruptAtBySession.get(currentSessionId) ?? 0) < 8_000,
	            // BL-713: the server owns a send that waits in the line from its 202; this tab's
	            // next send must not be ignored as a duplicate while it waits (the line may wait
	            // for an approval card with no reply running, and a new message ends that wait).
	            onAccepted: sendWaitsInLine
	              ? () => {
	                  if (isLatestSendSerial(sendSessionId, sendRunId)) setSendInFlight(sendSessionId, false)
	                }
	              : undefined
          })
          const response = routedSend.response

		          if (!response.ok) {
		            const errorPayload = routedSend.errorPayload ?? {};
		            const sendError = new Error(errorPayload.error || 'Failed to send message') as Error & {
		              code?: string
		              details?: string
		              status?: number
		            }
		            if (typeof errorPayload.code === 'string' && errorPayload.code.trim().length > 0) {
		              sendError.code = errorPayload.code.trim()
		            }
		            if (typeof errorPayload.details === 'string' && errorPayload.details.trim().length > 0) {
		              sendError.details = errorPayload.details.trim()
		            }
		            sendError.status = response.status
		            throw sendError
		          }

          const completed = await response.json().catch(() => null)
          // A group may complete without a stream (Smart skip or no eligible speaker).
          // Reload the server receipt directly too: the user-channel event can be missed.
          if (groupChatSendId && isAcceptedGroupNoReplyCompletion(completed, userId)) {
            // The accepted terminal response owns completion; a slow reload must not keep
            // Voice waiting. The existing per-chat load queue owns this independent refresh.
            void loadMessagesForSession(currentSessionId)
            const run = chatRunRegistry.getRunState(currentSessionId)
            if (!abortController.signal.aborted && !sendWaitsInLine &&
              isLatestSendSerial(currentSessionId, sendRunId) && run.abortController === abortController &&
              run.activeStreamMessageIds.length === 0 && run.activeToolMessageIds.length === 0 &&
              currentSessionId === sessionStore.getCurrentSessionId() &&
              agentStore.getCurrentAgentId() === agentWithOverride.id && chatInputRef === sendChatInput) {
              if (completed.replyOutcome === 'unconfirmed') {
                toast.error('Batshit could not confirm that it saved the judge\'s decision. No agent answered. You can send again or name an agent to ask for a reply. The Execution Viewer shows what is known.')
              }
              if (sendOptions.onNoReplyCompleted) sendOptions.onNoReplyCompleted()
              else sendChatInput?.aiResponseReceived?.()
            }
          }
        } catch (error: any) {
          if (error.name === 'AbortError') {
            logger.debug('[handleSendMessage] Stream aborted by user');
          } else {
            throw error;
          }
        } finally {
	          inFlightSendPayloads.delete(userId)
	          if (chatRunRegistry.getRunState(currentSessionId).abortController === abortController) {
	            chatRunRegistry.releaseAbortController(currentSessionId, abortController)
	          }
	          // BL-713: a send that waited in the line never took this tab's waiting and tool state;
	          // the reply that owns it may still be running when this send's answer comes.
	          if (isLatestSendSerial(currentSessionId, sendRunId) && !sendWaitsInLine) {
	            clearActiveToolProcessingState(currentSessionId)
	            isWaitingForResponse = false
	          }
        }
      }
      return true
	    } catch (error) {
	      console.error('Failed to send message:', error)
	      const message = error instanceof Error ? error.message : String(error ?? '')
	      const details =
	        typeof (error as any)?.details === 'string' ? String((error as any).details).trim() : ''
	      const errorCode =
	        typeof (error as any)?.code === 'string' ? String((error as any).code).trim() : ''
	      const isImageDataUrlContextError =
	        errorCode === 'IMAGE_DATA_URL_IN_TEXT' ||
	        /Image data URLs are not allowed in text context/i.test(message)
		      const isSessionTurnInProgress = errorCode === 'session_turn_in_progress'

	      if (isQuietQueuedSendAnswer(errorCode)) {
	        // BL-4: a queued send the server kept (Stop, or Batshit stopping) or whose message was
	        // deleted while it waited. Its receipt already says so, and its words are in the chat.
	        if (!sendWaitsInLine) isWaitingForResponse = false
	        if (isSessionCreating(currentSessionId)) {
	          clearCreatingSession(currentSessionId)
	        }
	        return false
	      }

	      if (errorCode === 'session_deleted') {
	        // The chat was deleted, here or in another tab, while this reply ran or waited. Say so
	        // once: the generic error toast below printed the sentence as its title AND its
	        // description (bug sweep, 2026-09-18). Nothing to retry and nothing to save.
	        toast.info(details || message || 'This chat was deleted.')
	        if (!sendWaitsInLine) isWaitingForResponse = false
	        if (isSessionCreating(currentSessionId)) {
	          clearCreatingSession(currentSessionId)
	        }
	        return false
	      }

		      if (isSessionTurnInProgress) {
	        toast.info('Response already in progress', {
	          description:
	            details || 'Batshit ignored the extra send so this chat keeps a single active response.'
	        })
	        markAssistantWaitingPlaceholderError(
	          managedAssistantMessageId,
	          details || 'Response already in progress.'
	        )
	        if (!sendWaitsInLine) isWaitingForResponse = false
	        if (isSessionCreating(currentSessionId)) {
	          logger.debug(
	            '[handleSendMessage] Clearing creating-session flag due to in-flight session turn'
	          )
	          clearCreatingSession(currentSessionId)
	        }
		        return false
		      }

	      if (isImageDataUrlContextError) {
	        toast.error('Inline image detected', {
	          description:
	            'One message in this session contains an embedded image data URL. Re-attach the image as a clip/input (URL-based) and send again.'
	        })
	        markAssistantWaitingPlaceholderError(
	          managedAssistantMessageId,
	          'Inline image detected. Re-attach the image as a clip/input and send again.'
	        )
	        if (!sendWaitsInLine) isWaitingForResponse = false
	        if (isSessionCreating(currentSessionId)) {
	          logger.debug('[handleSendMessage] Clearing creating-session flag due to send error')
	          clearCreatingSession(currentSessionId)
	        }
	        return false
	      }

	      const parsed = parseParameterError(message)
	      if (parsed) {
	        const now = Date.now()
	        if (lastParamToastMessage !== parsed.message || now - lastParamToastAt > 2000) {
	          const toastInfo = buildParameterErrorToast(parsed, {
	            provider: currentAgent?.primary_model_provider ?? null,
	            connection: normalizeMatrixConnection(
	              currentAgent?.primary_model_connection?.id ??
	                currentAgent?.primary_model_connection?.service ??
	                null
	            ),
	            model: currentAgent?.primary_model_name ?? null
	          })
	          toast.error(toastInfo.title, { description: toastInfo.description })
	          lastParamToastMessage = parsed.message
	          lastParamToastAt = now
	        }
	      } else {
	        const genericMessage =
	          /^failed to (?:stream response|send message)$/i.test(message) ||
	          /^failed to send message\./i.test(message)
	        const recentlySurfacedRuntimeError = Date.now() - lastStreamRuntimeErrorAt < 5000
	        if (!genericMessage || !recentlySurfacedRuntimeError) {
	          const description =
	            details && details !== message
	              ? details
	              : !genericMessage && message
	                ? message
	                : 'Please try again.'
	          toast.error(genericMessage ? 'Failed to send message' : message || 'Failed to send message', {
	            description
	          })
	        }
	      }

	      markAssistantWaitingPlaceholderError(
	        managedAssistantMessageId,
	        details && details !== message
	          ? details
	          : message || 'The response failed before streaming started.'
	      )
	      if (!sendWaitsInLine) isWaitingForResponse = false

	      // Clear the creating session flag on send error
	      if (isSessionCreating(currentSessionId)) {
	        logger.debug('[handleSendMessage] Clearing creating-session flag due to send error')
	        clearCreatingSession(currentSessionId)
	      }
	      return false
	    }
	    } finally {
	      if (isLatestSendSerial(sendSessionId, sendRunId)) {
	        setSendInFlight(sendSessionId, false)
	      }
	    }
  }

  // Stop the current stream
	  async function handleStopStream() {
	    const sessionId = sessionStore.getCurrentSessionId()
	    if (!sessionId) return
	    lastManualInterruptAtBySession.set(sessionId, Date.now())

	    const runState = chatRunRegistry.getRunState(sessionId)
	    const previousMessageId =
	      runState.activeMessageId ?? runState.activeStreamMessageIds[0] ?? null

	    // F-P2-7: written here, above everything that can throw, time out or be aborted,
	    // because the note on the next send is now the only thing that tells the model the
	    // user cut this reply short. No id means nothing to name — an addendum about "the
	    // previous response" that cannot say which one is not worth writing — so no record
	    // is left and no note is stamped.
	    if (previousMessageId) {
	      pendingStopInterruptionBySession.set(sessionId, {
	        messageId: previousMessageId,
	        interruptedAt: new Date().toISOString()
	      })
	    }

	    stopRealtimeSpeechPlayback(previousMessageId)
	    // SA-114 P3 (F-P3-B): Stop promotes nothing (DL-114-07), so anything still waiting is
	    // gone. Said here rather than waited for: a stopped turn may deliver no finalise
	    // event to this tab at all, because Stop aborts the fetch that would carry it.
	    settleSteerBubblesForMessage(sessionId, previousMessageId, { interrupted: true })
	    chatRunRegistry.markStopping(sessionId)

    try {
      const interrupted = await fetch('/api/messages/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messageId: previousMessageId,
          // BL-4: this Stop stops the sends waiting in the chat's line too (AMD-119-04).
          stopsWaitingSends: true
        })
      })
      const result = interrupted.ok ? await interrupted.json() : null
      if (result?.success === true && previousMessageId && result.messageId === previousMessageId &&
        (result.reason === 'aborted' || result.reason === 'setup_stopped')) {
        chatInputRef?.voiceSteerTargetStopped?.(sessionId, previousMessageId)
      }
    } catch (error) {
      console.error('[handleStopStream] Failed to interrupt stream:', error)
    }

	    if (runState.abortController) {
	      runState.abortController.abort()
	      chatRunRegistry.setAbortController(sessionId, null)
	    }

	    if (previousMessageId) {
	      await waitForStreamCompletion(previousMessageId, 1500)
	      if (isMessageActive(previousMessageId, sessionId)) {
	        await finalizeActiveAssistantMessageAsInterrupted(previousMessageId)
	      }
	    }

	    isWaitingForResponse = false
	    clearActiveToolProcessingState(sessionId)
	    if (previousMessageId && thinkingSubjects[previousMessageId]) {
	      const nextThinkingSubjects = { ...thinkingSubjects }
	      delete nextThinkingSubjects[previousMessageId]
	      thinkingSubjects = nextThinkingSubjects
	    }
	    toast.info('Stream stopped')
	  }

  function formatTokenCount(value: number | null | undefined): string {
    if (!Number.isFinite(value)) return 'unknown'
    const safeValue = Math.max(0, Math.round(value as number))
    if (safeValue < 1000) return `${safeValue} tokens`
    const roundedThousands = Math.round(safeValue / 1000)
    if (roundedThousands < 1000) return `${roundedThousands}K tokens`
    const roundedMillions = Math.round((safeValue / 1_000_000) * 10) / 10
    return `${roundedMillions.toFixed(Number.isInteger(roundedMillions) ? 0 : 1)}M tokens`
  }

  function formatCharacterCount(value: number | null | undefined): string {
    if (!Number.isFinite(value)) return 'unknown'
    const safeValue = Math.max(0, Math.round(value as number))
    if (safeValue < 1000) return `${safeValue} chars`
    const roundedThousands = Math.round(safeValue / 1000)
    if (roundedThousands < 1000) return `${roundedThousands}K chars`
    const roundedMillions = Math.round((safeValue / 1_000_000) * 10) / 10
    return `${roundedMillions.toFixed(Number.isInteger(roundedMillions) ? 0 : 1)}M chars`
  }

  function getCurrentManualTrimProtections(extraClipIds: string[] = []) {
    // SA-120 P5: a result Judge Juice opened (source `inferred`) is Batshit's guess, not a pin.
    // It never shields a message from the user's own Manual Trim or Compact.
    const protectedUnzippedZipIds = zippingService
      .getAllUnzipped()
      .filter((item) => item?.source !== 'inferred')
      .map((item) => item.zipId)
      .filter(Boolean)
    return {
      protectedUnzippedZipIds,
      userUnzippedZipIds: protectedUnzippedZipIds,
      activeClipIds: Array.from(new Set([
        ...activeComposerClipIds,
        ...extraClipIds
      ])).filter(Boolean)
    }
  }

  function handleComposerClippedItemsChange(clips: Array<{ id?: string | null }>) {
    const nextClipIds = Array.from(
      new Set(
        clips
          .map((clip) => (typeof clip?.id === 'string' ? clip.id.trim() : ''))
          .filter(Boolean)
      )
    )
    activeComposerClipIds = nextClipIds
    const signature = JSON.stringify(nextClipIds)
    if (signature === desktopControlsComposerClipSignature) return
    desktopControlsComposerClipSignature = signature
    desktopControlsClipRevision += 1
  }

  function stripMessagesForContextRequest(sourceMessages: Message[]) {
    const lastAssistantIdx = sourceMessages.reduce(
      (acc, message, index) => (message.role === 'assistant' ? index : acc),
      -1
    )
    return sourceMessages.map((message, index) => ({
      ...message,
      intermediateSteps: undefined,
      metadata: message.metadata
        ? {
            ...message.metadata,
            providerMessages:
              index >= lastAssistantIdx - 1 ? message.metadata.providerMessages : undefined
          }
        : undefined
    }))
  }

  function describeContextPreviewReason(reason: string) {
    switch (reason) {
      case 'active-stream':
        return 'the active response'
      case 'tool-result':
        return 'a tool result'
      case 'zip-state':
        return 'zip state'
      case 'zip-settings':
        return 'zip settings'
      case 'message-finalized':
        return 'the saved response'
      case 'manual-trim':
        return 'Manual Trim'
      case 'reset-trim':
        return 'Reset Trim'
      case 'compact':
        return 'Compact'
      case 'nap':
        return 'the nap'
      default:
        return 'context controls'
    }
  }

  function getZipContextSettingsPayload(value: Record<string, any> | null | undefined) {
    if (!value || typeof value !== 'object') return null
    const payload: Record<string, unknown> = {}
    for (const [key, setting] of Object.entries(value)) {
      if (
        key === 'custom_tool_settings' ||
        key === 'zip_ai_view_mode' ||
        key === 'zip_agent_control_experiment' ||
        key === 'zip_tool_notes_enabled' ||
        key.startsWith('zip_threshold_') ||
        key.startsWith('zip_disabled_') ||
        key.startsWith('auto_zip_')
      ) {
        payload[key] = setting
      }
    }
    return payload
  }

  function getContextPreviewSettingsKey() {
    const agent = agentStore.getCurrentAgent() as Record<string, any> | null
    const selection = agent ? resolveRuntimeModelSelection({
      preset: activeModelPreset, provider: agent.primary_model_provider,
      connection: agent.primary_model_connection, modelId: agent.primary_model_name,
      settings: agent.provider_specific_settings ?? null
    }) : null
    const codexContext = agent ? cliContextSettingsKey('codex', agent, selection?.contextWindow,
      selection?.settings, selection?.modelId) : null
    const service = selection?.connection?.service ?? agent?.primary_model_connection?.service ??
      agent?.primary_model_provider ?? null
    const activeCodexSettings = agent?.codex_settings ?? selection?.settings ?? agent?.provider_specific_settings
    return buildContextPreviewIdentity({
      agentId: agent?.id ?? null,
      isCodex: service === 'codex' || service === 'openai-codex',
      codexContext,
      codexModel: agent ? resolveEffectiveAgentCliModel('codex', agent, selection?.settings, selection?.modelId) : null,
      presetId: agent?.primary_model_preset_id ?? null,
      presetContextWindow: selection?.contextWindow ?? null,
      apiProvider: selection?.provider,
      apiModelId: selection?.modelId,
      apiConnection: selection?.connection,
      apiSettings: selection?.settings,
      localConnectionRevision,
      claudeContextEnvironment: data.claudeContextEnvironment,
      codexOverrides: activeCodexSettings?.configOverrides ?? activeCodexSettings?.codex_config_overrides,
      claudeContext: agent ? cliContextSettingsKey('claude', agent, selection?.contextWindow,
        selection?.settings, selection?.modelId) : null,
      agentZip: getZipContextSettingsPayload(agent),
      globalZip: getZipContextSettingsPayload(userSettings?.global_zip_settings as any)
    })
  }

  function clearLiveContextEstimate(sessionId = currentSessionId) {
    if (!sessionId) return
    if (contextPreviewTimer) {
      clearTimeout(contextPreviewTimer)
      contextPreviewTimer = null
    }
    const next = { ...liveContextEstimateBySession }
    delete next[sessionId]
    liveContextEstimateBySession = next
    contextPreviewSerial += 1
    contextPreviewGate.forget(sessionId)
  }

  function scheduleLiveContextPreview(
    reason: string,
    delay = 300,
    options: ContextPreviewRefreshOptions = {}
  ) {
    if (typeof window === 'undefined') return
    const sessionId = currentSessionId
    const currentAgent = agentStore.getCurrentAgent()
    if (!sessionId || !currentAgent?.id) return
    if (!options.ignoreBusy && (chatWorkBusy || compactBusy)) return
    if (!options.useStoredMessages && messageStore.getMessages().length === 0 && !activeLocalProgramDefinition) {
      clearLiveContextEstimate(sessionId)
      return
    }

    if (contextPreviewTimer) {
      if (options.keepExistingTimer) return
      clearTimeout(contextPreviewTimer)
    }
    contextPreviewTimer = setTimeout(() => {
      contextPreviewTimer = null
      void refreshLiveContextPreview(reason, sessionId, options)
    }, delay)
  }

  function refreshLiveContextPreview(
    reason: string,
    scheduledSessionId = currentSessionId,
    options: ContextPreviewRefreshOptions = {}
  ) {
    if (!scheduledSessionId) return
    contextPreviewGate.request(scheduledSessionId, { reason, options })
  }

  // Runs only through `contextPreviewGate`, which sends it when the chat has no preview in
  // flight. Every guard is read again here because a trailing refresh runs later than its ask.
  async function runLiveContextPreview(
    reason: string,
    sessionId: string,
    options: ContextPreviewRefreshOptions
  ) {
    const currentAgent = agentStore.getCurrentAgent()
    if (!sessionId || !currentAgent?.id) return
    if (!options.ignoreBusy && (chatWorkBusy || compactBusy)) return

    const currentMessages = messageStore.getMessages()
    if (!options.useStoredMessages && currentMessages.length === 0 && !activeLocalProgramDefinition) {
      clearLiveContextEstimate(sessionId)
      return
    }

    const requestBody: Record<string, unknown> = {
      sessionId,
      agentId: currentAgent.id,
      agentType: normalizePrimaryAgentType(currentAgent),
      trimmedMessageIds: currentTrimmedMessageIds
    }
    if (options.useStoredMessages) {
      requestBody.useStoredMessages = true
    } else {
      requestBody.messages = stripMessagesForContextRequest(currentMessages)
    }

    const requestSerial = ++contextPreviewSerial
    const settingsKey = getContextPreviewSettingsKey()
    try {
      const response = await fetch('/api/messages/context-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to refresh context preview')
      }

      if (requestSerial !== contextPreviewSerial || currentSessionId !== sessionId || getContextPreviewSettingsKey() !== settingsKey) return
      if (typeof payload?.tokens !== 'number' || !Number.isFinite(payload.tokens)) return

      liveContextEstimateBySession = {
        ...liveContextEstimateBySession,
        [sessionId]: {
          tokens: Math.max(0, Math.round(payload.tokens)),
          contextLimit: typeof payload?.budget?.contextLimit === 'number'
            ? payload.budget.contextLimit : null,
          contextWindowWarning: typeof payload?.budget?.contextWindowWarning === 'string'
            ? payload.budget.contextWindowWarning : null,
          contextWindowCheckedAt: typeof payload?.budget?.contextWindowCheckedAt === 'number'
            ? payload.budget.contextWindowCheckedAt : null,
          localContext: payload?.budget?.localContext ?? null,
          settingsKey: settingsKey ?? `unreusable:${crypto.randomUUID()}`,
          reason: describeContextPreviewReason(reason),
          updatedAt: Date.now()
        }
      }
    } catch (error) {
      if (activeLocalProgramDefinition && requestSerial === contextPreviewSerial && currentSessionId === sessionId) {
        const prior = liveContextEstimateBySession[sessionId]
        if (prior) liveContextEstimateBySession = { ...liveContextEstimateBySession,
          [sessionId]: { ...prior, contextLimit: null, localContext: null } }
      }
      console.warn('[TokenPanel] Failed to refresh live context preview:', error)
    }
  }

  // Token management functions
  async function handleTrim(tokensToTrim: number) {
    if (!contextUsage.trimAvailable) {
      toast.error(contextUsage.trimUnavailableReason)
      return
    }

    const sessionId = currentSessionId
    const currentAgent = agentStore.getCurrentAgent()
    if (!sessionId || !currentAgent?.id) {
      toast.error('Cannot trim until a chat session and agent are selected')
      return
    }

    const currentMessages = messageStore.getMessages()
    if (currentMessages.length <= 1) {
      toast.error('Cannot trim - need at least one message to keep')
      return
    }

    trimPreviewBusy = true
    try {
      const response = await fetch('/api/messages/trim-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          agentId: currentAgent.id,
          agentType: normalizePrimaryAgentType(currentAgent),
          tokensToTrim,
          trimmedMessageIds: currentTrimmedMessageIds,
          messages: stripMessagesForContextRequest(currentMessages)
        })
      })

      const preview = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(preview?.error || 'Failed to calculate trim preview')
      }

      const nextIds = Array.isArray(preview?.nextTrimmedMessageIds)
        ? preview.nextTrimmedMessageIds.filter((id: unknown): id is string => typeof id === 'string')
        : currentTrimmedMessageIds
      const newlyTrimmedCount =
        typeof preview?.newlyTrimmedMessageCount === 'number'
          ? preview.newlyTrimmedMessageCount
          : Math.max(0, nextIds.length - currentTrimmedMessageIds.length)

      if (newlyTrimmedCount <= 0) {
        if (nextIds.length !== currentTrimmedMessageIds.length) {
          setTrimmedIdsForCurrentSession(nextIds)
        }
        toast.info('Nothing older is left to trim from the active send context')
        return
      }

      const freedTokens =
        typeof preview?.estimatedFreedTokens === 'number'
          ? Math.max(0, Math.round(preview.estimatedFreedTokens))
          : 0
      if (freedTokens <= 0) {
        toast.info('This trim would not free meaningful context after zips and the trim notice')
        return
      }

      const totalTrimmedCount =
        typeof preview?.totalTrimmedMessageCount === 'number'
          ? preview.totalTrimmedMessageCount
          : nextIds.length
      const protectedCount =
        typeof preview?.protectedMessageCount === 'number'
          ? preview.protectedMessageCount
          : 0
      const confirmed = await confirmDialog({
        title: 'Apply Manual Context Trim?',
        description: [
          `Batshit calculated this from the compiled send payload after zip decisions, not from the visible chat alone.`,
          `This will exclude ${newlyTrimmedCount} more older message${newlyTrimmedCount === 1 ? '' : 's'} from future sends in this chat, for ${totalTrimmedCount} total trimmed.`,
          `Estimated context freed: ${formatTokenCount(freedTokens)}. New send estimate: ${formatTokenCount(preview?.afterTokens)}.`,
          protectedCount > 0
            ? `${protectedCount} older message${protectedCount === 1 ? '' : 's'} with manually unzipped or active clipped context stayed protected.`
            : 'No manually unzipped or active clipped context was selected for trimming.',
          'Visible chat stays unchanged. Reset Trim reverses this.'
        ],
        confirmLabel: 'Apply Trim',
        cancelLabel: 'Cancel'
      })

      if (!confirmed) return

      setTrimmedIdsForCurrentSession(nextIds)
      manualTrimEstimateBySession = {
        ...manualTrimEstimateBySession,
        [sessionId]: {
          afterTokens:
            typeof preview?.afterTokens === 'number'
              ? Math.max(0, Math.round(preview.afterTokens))
              : Math.max(0, contextUsage.displayTokens ?? 0),
          freedTokens
        }
      }
      scheduleLiveContextPreview('manual-trim', 0)

      toast.success(
        `Manual trim active: ${newlyTrimmedCount} older message${newlyTrimmedCount === 1 ? '' : 's'} excluded from sends`
      )
    } catch (error) {
      console.error('[TokenPanel] Failed to calculate manual trim preview:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to calculate trim preview')
    } finally {
      trimPreviewBusy = false
    }
  }

  function handleResetTrim() {
    if (currentTrimmedMessageIds.length === 0) return
    const sessionId = currentSessionId
    setTrimmedIdsForCurrentSession([])
    if (sessionId) {
      const nextEstimates = { ...manualTrimEstimateBySession }
      delete nextEstimates[sessionId]
      manualTrimEstimateBySession = nextEstimates
    }
    scheduleLiveContextPreview('reset-trim', 0)
    toast.success('Manual trim cleared')
  }

  /**
   * BL-622 (C3): the server refused a Compact because a reply is running in the chat. Auto Compact
   * stays quiet and runs again after the reply: its once-per-state key is cleared after a wait, never
   * at once (its trigger reads that key, so clearing it now would ask the server again in a loop).
   * A pressed Compact is told, in the server's words.
   */
  function handleCompactTurnRunning(
    sessionId: string,
    handling: CompactTurnRunningHandling,
    payload: Record<string, any> | null
  ) {
    if (handling === 'tell_user') {
      toast.info(payload?.error || 'A reply is running in this chat. Compact runs after it.')
      return
    }
    const refusedKey = autoCompactLastPromptKeyBySession[sessionId]
    setTimeout(() => {
      if (autoCompactLastPromptKeyBySession[sessionId] !== refusedKey) return
      const next = { ...autoCompactLastPromptKeyBySession }
      delete next[sessionId]
      autoCompactLastPromptKeyBySession = next
    }, COMPACT_TURN_RUNNING_RETRY_MS)
  }

  /**
   * BL-755: `compaction_changed` means another Compact's event already landed in the chat's
   * record while this tab still holds the copy it read before the summary call. Auto Compact's
   * quiet retry must see the winning event, not this tab's stale `contextCompaction`, or it
   * either summarizes what little is left or meets a `no_compaction_candidates` refusal. Refetches
   * the chat's current record and applies its metadata before the retry fires.
   */
  async function refreshSessionMetadataAfterCompactionChanged(sessionId: string) {
    try {
      const response = await fetch(`/api/sessions/${sessionId}`)
      if (!response.ok) return
      const session = await response.json().catch(() => null)
      if (session?.metadata) sessionStore.updateSession(sessionId, { metadata: session.metadata })
    } catch (error) {
      console.warn('[TokenPanel] Failed to refresh chat metadata after a Compact conflict:', error)
    }
  }

  /**
   * BL-622 (C7), BL-653: the composer's Stop. While only a Compact runs, it ends the Compact through
   * the Compact's own Stop route; otherwise it is the reply's Stop, as before.
   */
  function handleStopWork() {
    if (resolveStopTarget({ compactBusy, replyBusy: chatWorkBusy }) === 'compact') {
      void stopRunningCompact()
      return
    }
    return handleStopStream()
  }

  async function stopRunningCompact() {
    // BL-653: the chat whose Compact runs, not the open chat (the user may have opened another).
    const sessionId = compactStopTracker.requestStop()
    if (!sessionId) return
    try {
      const response = await fetch('/api/messages/compact/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error || 'Could not stop the Compact')
      }
    } catch (error) {
      console.error('[TokenPanel] Failed to stop the Compact:', error)
      toast.error(error instanceof Error ? error.message : 'Could not stop the Compact')
    }
  }

  async function handleCompact(options: { mode?: 'manual' | 'auto'; confirmFirst?: boolean } = {}) {
    const mode = options.mode ?? 'manual'
    const confirmFirst = options.confirmFirst ?? true
    if (compactBusy) return
    compactStopTracker.begin()

    const sessionId = currentSessionId
    const currentAgent = agentStore.getCurrentAgent()
    if (!sessionId || !currentAgent?.id) {
      toast.error('Cannot compact until a chat session and agent are selected')
      return
    }

    // SA-104 P6 (DL-104-07): Infinite Sessions relieve context through graduation/naps.
    if (currentSessionFixed) {
      toast.info('Infinite Sessions do not use Compact', {
        description:
          'Context relief happens through episode graduation and naps, which keep the originals searchable.'
      })
      return
    }

    const currentMessages = messageStore.getMessages()
    if (!compactGroupRunnerSession && hasPendingCompactApproval(currentMessages, currentCompactionEvents)) {
      if (mode === 'manual') toast.info(COMPACT_PENDING_APPROVAL_MESSAGE)
      return
    }
    const localSelection = selectMessagesForCompaction(currentMessages, currentCompactionEvents, {
      protections: currentManualTrimProtections
    })
    if (localSelection.compactedMessageCount <= 0) {
      toast.info('No older unprotected messages are available to compact')
      return
    }

    let preview: Record<string, any> | null = null
    compactBusy = true
    compactStopTracker.enterPhase(sessionId)
    compactStatus = 'Calculating compact plan...'
    try {
      const response = await fetch('/api/messages/compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          agentId: currentAgent.id,
          agentType: normalizePrimaryAgentType(currentAgent),
          mode,
          previewOnly: true,
          trimmedMessageIds: currentTrimmedMessageIds,
          messages: stripMessagesForContextRequest(currentMessages)
        })
      })

      preview = await response.json().catch(() => null)
      // BL-653: the plan never reads its run's stop, so a Stop pressed during it ends the Compact
      // here, before the summary request (in auto mode without a confirm, it would start at once).
      if (compactStopTracker.stopRequested) {
        autoCompactStopHolds = holdAutoCompactAfterStop(autoCompactStopHolds, sessionId, mode)
        toast.info(STOPPED_COMPACT_MESSAGE)
        return
      }
      if (!response.ok) {
        const turnRunning = resolveCompactTurnRunning(mode, response.status, preview)
        if (turnRunning) {
          handleCompactTurnRunning(sessionId, turnRunning, preview)
          return
        }
        // BL-755: nothing left to compact is not an error; only a pressed Compact hears about it.
        if (isSilentAutoCompactNoCandidates(mode, response.status, preview)) return
        throw new Error(preview?.error || 'Failed to calculate compact plan')
      }
    } catch (error) {
      console.error('[TokenPanel] Failed to calculate compact plan:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to calculate compact plan')
      return
    } finally {
      compactBusy = false
      compactStopTracker.leavePhase()
      compactStatus = null
    }

    const selection = preview?.selection ?? localSelection
    const sourceMessageIds = Array.isArray(selection?.sourceMessageIds)
      ? selection.sourceMessageIds.filter((id: unknown): id is string => typeof id === 'string')
      : localSelection.sourceMessageIds
    const compactedMessageCount =
      typeof selection?.compactedMessageCount === 'number'
        ? Math.max(0, Math.round(selection.compactedMessageCount))
        : localSelection.compactedMessageCount
    if (compactedMessageCount <= 0) {
      toast.info('No older unprotected messages are available to compact')
      return
    }
    const protectedMessageCount =
      typeof preview?.protectedMessageCount === 'number'
        ? Math.max(0, Math.round(preview.protectedMessageCount))
        : typeof selection?.protectedMessageCount === 'number'
          ? Math.max(0, Math.round(selection.protectedMessageCount))
          : localSelection.protectedMessageCount
    const trimmedOverlapCount = currentEffectiveTrimmedMessageIds.filter((id) =>
      sourceMessageIds.includes(id)
    ).length
    const beforeBudget = preview?.beforeBudget
    const summaryBudget = preview?.summaryBudget
    const beforeLine =
      beforeBudget && typeof beforeBudget.estimatedRuntimeTokens === 'number'
        ? beforeBudget.contextLimit
          ? `Compiled send estimate now: ${formatTokenCount(beforeBudget.estimatedRuntimeTokens)} of ${formatTokenCount(beforeBudget.contextLimit)}, with ${formatTokenCount(beforeBudget.contextRemainingTokens)} remaining.`
          : `Compiled send estimate now: ${formatTokenCount(beforeBudget.estimatedRuntimeTokens)}. Batshit could not resolve a model context limit for this runtime.`
        : `Compiled send estimate now: ${formatTokenCount(preview?.beforeTokens)}.`
    const codexHardLimitLine =
      beforeBudget && typeof beforeBudget.packagedInputChars === 'number'
        ? `Codex packaged input: ${formatCharacterCount(beforeBudget.packagedInputChars)} of ${formatCharacterCount(beforeBudget.packagedInputSafeCharLimit)} safe launch budget.`
        : null
    const summaryBudgetLine =
      summaryBudget && typeof summaryBudget.softTargetTokens === 'number'
        ? `Compact summary target: about ${formatTokenCount(summaryBudget.softTargetTokens)}, with a hard ceiling near ${formatTokenCount(summaryBudget.hardMaxTokens)}.`
        : null
    const budgetStatusLine =
      beforeBudget?.status && beforeBudget.status !== 'safe'
        ? beforeBudget.reason
        : 'The compact plan is based on the server-compiled prompt, not visible chat length alone.'

    if (confirmFirst) {
      const confirmed = await confirmDialog({
        title: mode === 'auto' ? 'Compact Context Now?' : 'Compact Context?',
        description: [
          `Batshit will summarize ${compactedMessageCount} eligible message${compactedMessageCount === 1 ? '' : 's'} and permanently replace those originals in future agent context with one compact summary.`,
          trimmedOverlapCount > 0
            ? `${trimmedOverlapCount} currently trimmed message${trimmedOverlapCount === 1 ? '' : 's'} will become part of the permanent compact summary, so Reset Trim will not restore them to agent context later.`
            : 'Manual Trim remains separate and reversible for any messages not compacted.',
          protectedMessageCount > 0
            ? `${protectedMessageCount} message${protectedMessageCount === 1 ? '' : 's'} with manually unzipped zip-control items or active clips will stay live and un-compacted.`
            : 'No manually unzipped zip-control items or active clips are inside the compact target.',
          beforeLine,
          codexHardLimitLine,
          summaryBudgetLine,
          budgetStatusLine,
          'The chat view will show one expandable compact summary row in place of the compacted originals.'
        ].filter((line): line is string => Boolean(line)),
        confirmLabel: 'Compact',
        cancelLabel: 'Cancel'
      })

      if (!confirmed) return
    }

    compactBusy = true
    compactStopTracker.enterPhase(sessionId)
    compactStatus = 'Generating compact summary...'
    let shouldRefreshContextAfterCompact = false
    try {
      const response = await fetch('/api/messages/compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          agentId: currentAgent.id,
          agentType: normalizePrimaryAgentType(currentAgent),
          mode,
          trimmedMessageIds: currentTrimmedMessageIds,
          messages: stripMessagesForContextRequest(currentMessages)
        })
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        if (isStoppedCompactAnswer(response.status, payload)) {
          autoCompactStopHolds = holdAutoCompactAfterStop(autoCompactStopHolds, sessionId, mode)
          toast.info(payload?.error || STOPPED_COMPACT_MESSAGE)
          return
        }
        const turnRunning = resolveCompactTurnRunning(mode, response.status, payload)
        if (turnRunning) {
          handleCompactTurnRunning(sessionId, turnRunning, payload)
          return
        }
        // BL-622 (C5): the Compact looked again after its summary call and wrote nothing. A pressed
        // Compact says why; an Auto Compact stays quiet and runs again after the same wait — except
        // a Stop, which needs no retry (BL-756), and a `compaction_changed` retry, which first
        // refreshes this tab's stale copy of the chat's metadata (BL-755).
        const endedEarly = resolveCompactEndedEarly(mode, response.status, payload)
        if (endedEarly) {
          if (endedEarly.kind === 'tell_user') toast.info(endedEarly.message)
          else if (endedEarly.kind === 'retry_quietly') {
            if (endedEarly.refreshMetadata) void refreshSessionMetadataAfterCompactionChanged(sessionId)
            handleCompactTurnRunning(sessionId, 'retry_quietly', payload)
          }
          return
        }
        // BL-755: nothing left to compact is not an error; only a pressed Compact hears about it.
        if (isSilentAutoCompactNoCandidates(mode, response.status, payload)) return
        throw new Error(payload?.error || 'Failed to compact context')
      }

      const nextMetadata = {
        ...(sessionStore.getCurrentSession()?.metadata ?? {}),
        contextCompaction: payload.contextCompaction
      }
      sessionStore.updateSession(sessionId, { metadata: nextMetadata })

      const compactedIds = Array.isArray(payload?.compactedMessageIds)
        ? payload.compactedMessageIds.filter((id: unknown): id is string => typeof id === 'string')
        : []
      if (compactedIds.length > 0 && currentTrimmedMessageIds.length > 0) {
        const compactedSet = new Set(compactedIds)
        const nextTrimmedIds = currentTrimmedMessageIds.filter((id) => !compactedSet.has(id))
        setTrimmedIdsForCurrentSession(nextTrimmedIds)
        const nextEstimates = { ...manualTrimEstimateBySession }
        delete nextEstimates[sessionId]
        manualTrimEstimateBySession = nextEstimates
      }
      const afterTokens =
        typeof payload?.afterTokens === 'number'
          ? Math.max(0, Math.round(payload.afterTokens))
          : typeof payload?.afterBudget?.estimatedRuntimeTokens === 'number'
            ? Math.max(0, Math.round(payload.afterBudget.estimatedRuntimeTokens))
            : null
      if (afterTokens !== null) {
        liveContextEstimateBySession = {
          ...liveContextEstimateBySession,
          [sessionId]: {
            tokens: afterTokens,
            contextLimit: typeof payload?.afterBudget?.contextLimit === 'number'
              ? payload.afterBudget.contextLimit : null,
            settingsKey: getContextPreviewSettingsKey() ?? `unreusable:${crypto.randomUUID()}`,
            reason: describeContextPreviewReason('compact'),
            updatedAt: Date.now()
          }
        }
      } else {
        shouldRefreshContextAfterCompact = true
      }

      if (payload?.afterBudget?.status === 'blocked') {
        toast.warning('Context compacted, but send preflight is still blocked', {
          description: payload.afterBudget.reason
        })
      } else {
        toast.success(
          `Context compacted: ${compactedMessageCount} message${compactedMessageCount === 1 ? '' : 's'} summarized`
        )
      }
    } catch (error) {
      console.error('[TokenPanel] Failed to compact context:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to compact context')
    } finally {
      compactBusy = false
      compactStopTracker.leavePhase()
      compactStatus = null
      if (shouldRefreshContextAfterCompact) {
        scheduleLiveContextPreview('compact', 0)
      }
    }
  }

  /**
   * SA-104 P6 — run the Infinite-Session nap (threshold-triggered or the Token Panel's
   * manual button). The route re-verifies the threshold, ownership, and the
   * between-turns interlock; the local session store picks up the fresh metadata
   * (graduation events + nap record) from the response.
   */
  async function handleNap(options: { trigger?: 'threshold' | 'manual' } = {}) {
    const trigger = options.trigger ?? 'manual'
    if (napBusy) return

    const sessionId = currentSessionId
    const currentAgent = agentStore.getCurrentAgent()
    if (!sessionId || !currentAgent?.id) {
      toast.error('Nap needs an active chat session and agent')
      return
    }
    if (!currentSessionFixed) {
      toast.info('Naps run only in Infinite Sessions')
      return
    }

    napBusy = true
    napStatus = 'Napping: graduating episodes and tidying context...'
    if (trigger === 'threshold') {
      toast.info('Batshit is napping', {
        description:
          'The context window crossed the nap threshold. Closed episodes graduate to memory and stale bulk compresses — originals stay searchable.'
      })
    }
    try {
      const response = await fetch('/api/memory/nap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, agentId: currentAgent.id, trigger })
      })
      const payload = await response.json().catch(() => null)

      if (payload?.metadata) {
        sessionStore.updateSession(sessionId, { metadata: payload.metadata })
      }
      if (!response.ok) {
        if (payload?.code === 'session_turn_in_progress') {
          // A turn started while we queued the nap; the next idle threshold check retries.
          return
        }
        throw new Error(payload?.error || 'Nap failed')
      }
      if (payload?.status === 'not_needed') {
        if (trigger === 'manual') {
          toast.info('No nap needed', {
            description: `The window is below the nap threshold (${formatTokenCount(payload?.napAtTokens)} tokens).`
          })
        }
        return
      }

      // BL-549 N6: an early end is not a completion. A pressed nap that stopped because a
      // message arrived is told so; the idle auto-nap, and a nap that ended because the
      // chat is gone, say nothing.
      if (payload?.status === 'ended_early') {
        const message = describeNapEndedEarly(trigger, payload?.endedEarly)
        if (message) toast.info(message)
        // What it finished before the message arrived stays (option A), so the window's
        // preview is refreshed as after a completed nap; a deleted chat has none to refresh.
        if (payload?.endedEarly !== 'chat_deleted') scheduleLiveContextPreview('nap', 0)
        return
      }

      const record = payload?.record
      const graduated = Array.isArray(record?.graduatedEpisodeIds)
        ? record.graduatedEpisodeIds.length
        : 0
      const rezipped = typeof record?.rezippedZipCount === 'number' ? record.rezippedZipCount : 0
      const compacted = record?.compaction?.compactedMessageCount ?? 0
      const parts: string[] = []
      if (graduated > 0) parts.push(`${graduated} episode${graduated === 1 ? '' : 's'} graduated`)
      if (rezipped > 0) parts.push(`${rezipped} zip${rezipped === 1 ? '' : 's'} compressed`)
      if (compacted > 0) parts.push(`${compacted} older message${compacted === 1 ? '' : 's'} summarized with a whiteboard refresh`)
      const tokensLine =
        typeof payload?.tokensBefore === 'number' && typeof payload?.tokensAfter === 'number'
          ? `Context: ${formatTokenCount(payload.tokensBefore)} → ${formatTokenCount(payload.tokensAfter)}.`
          : null
      toast.success('Nap complete', {
        description: [parts.length > 0 ? parts.join(', ') + '.' : 'Nothing needed relief.', tokensLine]
          .filter(Boolean)
          .join(' ')
      })
      scheduleLiveContextPreview('nap', 0)
    } catch (error) {
      console.error('[Nap] Failed:', error)
      toast.error('Nap failed', {
        description: error instanceof Error ? error.message : 'Nap failed'
      })
    } finally {
      napBusy = false
      napStatus = null
    }
  }

  /**
   * SA-104 P6 — regular-session graduation hooks (DL-104-12/-16: strictly additive).
   * Called on session open (`reason: 'idle'` — the server verifies the idle gap and
   * no-ops otherwise) and on archive (`reason: 'close'`). Failures surface one
   * actionable toast per session per app run; a missing summary-model preset names
   * the Agent Settings fix.
   */
  async function requestRegularSessionGraduation(sessionId: string, reason: 'idle' | 'close') {
    if (!sessionId) return
    const session = sessionStore.getSessions().find((entry) => entry.id === sessionId) ?? null
    if (!session || isFixedSession(session)) return
    if (session.metadata?.group_chat) return
    const agentId = session.agent_id || agentStore.getCurrentAgent()?.id || ''
    const agent = agentId ? agentStore.getAgentById(agentId) : null
    if (!agent?.id || !resolveAgentMemoryEnabled(agent)) return

    try {
      const response = await fetch('/api/memory/graduate-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, agentId: agent.id, reason })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const message = payload?.error || 'Session graduation failed'
        if (!graduationWarnedSessions.has(sessionId)) {
          graduationWarnedSessions.add(sessionId)
          toast.warning('Memory graduation needs attention', {
            description: `${message} You can pick a summary model in Agent Settings → Memory.`
          })
        } else {
          console.warn('[Memory] Session graduation failed:', message)
        }
        return
      }
      if (payload?.status === 'graduated') {
        toast.success('Session graduated to memory', {
          description: `${payload.messageCount ?? ''} message${payload?.messageCount === 1 ? '' : 's'} summarized into searchable memory.`.trim()
        })
      }
    } catch (error) {
      console.warn('[Memory] Session graduation request failed:', error)
    }
  }

  function getMessagesForSend(
    sessionId = currentSessionId,
    manualTrimProtections = currentManualTrimProtections
  ) {
    if (!sessionId) return []
    return buildSessionMessagesForSend({
      sessionId,
      messages: messageStore.getMessages(sessionId),
      sessions: sessionStore.getSessions(),
      trimmedMessageIdsBySession,
      manualTrimProtections,
      userId: data.user?.id
    })
  }

  async function updateGoonsSettings(patch: Partial<GoonsSettings>) {
    if (getUserSettingsReadState() !== 'confirmed') {
      toast.error('Goon settings could not load. Open Settings and press Retry before changing them.')
      return
    }
    try {
      const persistedSettings = await persistGoonsSettingsPatchRequest(fetch, patch)
      confirmUserSettings(persistedSettings)
    } catch (error) {
      console.error('[Goons] Failed to persist settings:', error)
      toast.error('Goon preferences could not be confirmed saved.', {
        description: error instanceof Error ? error.message : 'The settings request failed.'
      })
    }
  }

  function updateGoonStageRect() {
    if (typeof window !== 'undefined') {
      shellViewportWidth = window.innerWidth
    }
    if (!goonStageEl) return
    rightRailWidth = getRightRailWidth()
    const rect = goonStageEl.getBoundingClientRect()
    goonStageRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    }
  }

  async function updateActiveGoonDefaults(patch: Partial<GoonDefaults>) {
    if (!activeGoon) return
    try {
      await updateGoonRecord(activeGoon.id, {
        defaults: {
          ...(activeGoon.defaults ?? {}),
          ...patch
        }
      })
    } catch (error) {
      console.error('[Goons] Failed to update goon defaults:', error)
    }
  }

  $effect(() => {
    if (!goonStageEl || typeof ResizeObserver === 'undefined') return
    goonStageObserver?.disconnect()
    goonStageObserver = new ResizeObserver(() => updateGoonStageRect())
    goonStageObserver.observe(goonStageEl)
    updateGoonStageRect()
    return () => {
      goonStageObserver?.disconnect()
      goonStageObserver = null
    }
  })

  $effect(() => {
    if (rightPanelWidthInitialized) return
    if (!goonStageRect?.width) return
    const availableWidth = Math.max(0, goonStageRect.width - getRightRailWidth())
    artifactsPanelWidth = clampRightPanelWidth(Math.floor(availableWidth * 0.5))
    rightPanelWidthInitialized = true
  })

  $effect(() => {
    rightRailWidth
    if (!rightPanelOpen) return
    const nextWidth = clampRightPanelWidth(artifactsPanelWidth)
    if (nextWidth !== artifactsPanelWidth) {
      artifactsPanelWidth = nextWidth
    }
  })

  $effect(() => {
    if (typeof window === 'undefined') return
    const handleResize = () => updateGoonStageRect()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  })

  function handleRightPanelDragStart(event: PointerEvent) {
    event.preventDefault()
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    rightPanelDragging = true
    rightPanelDragStartX = event.clientX
    rightPanelDragStartWidth = artifactsPanelWidth
    document.body.classList.add('dragging-right-panel')
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  function handleRightPanelDragMove(event: PointerEvent) {
    if (!rightPanelDragging) return
    const deltaX = rightPanelDragStartX - event.clientX
    const nextWidth = rightPanelDragStartWidth + deltaX
    artifactsPanelWidth = clampRightPanelWidth(nextWidth)
  }

  function handleRightPanelDragEnd() {
    if (!rightPanelDragging) return
    rightPanelDragging = false
    document.body.classList.remove('dragging-right-panel')
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    if (typeof window !== 'undefined') {
      localStorage.setItem('artifactsPanelWidth', artifactsPanelWidth.toString())
    }
  }

  function desktopPlainJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

  function latestDesktopShellStatus(value: DesktopGoonShellStatus) {
    return value.status && typeof value.status === 'object' ? value.status : value
  }

  function buildDesktopGoonRef(): DesktopGoonRuntimeGoonRefV1 | null {
    if (!activeGoon) return null
    const activationKey = resolveGoonLiveActivationKey(activeGoon)
    if (!activationKey) return null
    return {
      goonId: activeGoon.id,
      activationKey,
      recordUpdatedAt: activeGoon.updated_at,
      packageRevision: null
    }
  }

  function buildDesktopCameraState(state: GoonMountedRuntimeState | null) {
    if (!state?.camera) return null
    return {
      schemaVersion: 'desktop-goon-camera/v1' as const,
      camera: { ...state.camera, mode: 'free' as const },
      goonRotation: state.goonRotation
    }
  }

  function buildDesktopRuntimeSnapshot(): DesktopGoonRuntimeSnapshotV1 | null {
    if (!desktopEpoch || !desktopHandoffState) return null
    return {
      schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
      epoch: desktopEpoch,
      sequence: 0,
      createdAtMs: Date.now(),
      presentation: desktopPlainJson(desktopPresentation),
      sessionId: currentSessionId ?? null,
      activeAgentId: dockAgentId,
      activeSpeaker: resolvedDesktopGoonSpeaker,
      goon: buildDesktopGoonRef(),
      mountedRuntimeState: desktopPlainJson(
        desktopHandoffState
      ) as unknown as { [key: string]: DesktopGoonJsonValue },
      voiceVisual: desktopLastVoiceVisual,
      camera: buildDesktopCameraState(desktopHandoffState),
      preferences: desktopPlainJson(desktopGoonPreferences)
    }
  }

  function publishDesktopDelta(delta: DesktopGoonRuntimeDeltaV1) {
    const result = desktopPublisher?.publishDelta(delta)
    if (result && !result.ok) desktopBridgeError = result.failure.message
    return result
  }

  function clearDesktopVoiceFrames() {
    if (!desktopVoiceFrameTimer) return
    clearInterval(desktopVoiceFrameTimer)
    desktopVoiceFrameTimer = null
  }

  function clearDesktopVoiceAudioProjection() {
    desktopVoiceAudioSource?.disconnect()
    desktopVoiceAudioAnalyser?.disconnect()
    desktopVoiceAudioSource = null
    desktopVoiceAudioAnalyser = null
    desktopVoiceAudioSamples = null
    const context = desktopVoiceAudioContext
    desktopVoiceAudioContext = null
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }

  function startDesktopVoiceAudioProjection(audio?: HTMLMediaElement | null) {
    clearDesktopVoiceAudioProjection()
    if (!audio || typeof window === 'undefined') return
    const captureStream = (audio as HTMLMediaElement & { captureStream?: () => MediaStream })
      .captureStream
    const AudioContextConstructor = window.AudioContext
    if (typeof captureStream !== 'function' || !AudioContextConstructor) return
    try {
      const stream = captureStream.call(audio)
      const context = new AudioContextConstructor()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      desktopVoiceAudioContext = context
      desktopVoiceAudioSource = source
      desktopVoiceAudioAnalyser = analyser
      desktopVoiceAudioSamples = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    } catch (error) {
      console.warn('[Desktop Goon] Audio projection unavailable; using timeline or procedural lip sync.', error)
      clearDesktopVoiceAudioProjection()
    }
  }

  function measureDesktopVoiceAudioLevel() {
    const analyser = desktopVoiceAudioAnalyser
    const samples = desktopVoiceAudioSamples
    if (!analyser || !samples) return null
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) {
      const normalized = (sample - 128) / 128
      sum += normalized * normalized
    }
    return Math.min(1, Math.sqrt(sum / samples.length) * 4)
  }

  function beginDesktopVoiceProjection(
    detail: DesktopVoicePlaybackDetail,
    generation = `voice-${Date.now()}-${detail.messageId ?? 'live'}`,
    publishStart = true
  ) {
    clearDesktopVoiceFrames()
    desktopVoiceGeneration = generation
    startDesktopVoiceAudioProjection(detail.audio)
    const initialElapsedMs =
      detail.audio && Number.isFinite(detail.audio.currentTime)
        ? Math.max(0, detail.audio.currentTime * 1000)
        : 0
    if (publishStart) {
      const visual = desktopPlainJson({
        kind: 'start' as const,
        generation,
        agentId: detail.agentId ?? null,
        messageId: detail.messageId ?? null,
        startedAtMs: Math.max(0, Date.now() - initialElapsedMs),
        durationMs: detail.durationMs ?? null,
        analyzerId: detail.lipSyncAnalyzerId ?? null,
        timeline: detail.lipSyncTimeline ?? null
      })
      desktopLastVoiceVisual = visual
      if (desktopPublisher) publishDesktopDelta({ type: 'voice.visual', visual })
    }

    const projectionStartedAt = performance.now() - initialElapsedMs
    desktopVoiceFrameTimer = setInterval(() => {
      const elapsedMs =
        detail.audio && Number.isFinite(detail.audio.currentTime)
          ? Math.max(0, detail.audio.currentTime * 1000)
          : Math.max(0, performance.now() - projectionStartedAt)
      const frame = detail.lipSyncTimeline
        ? sampleGoonLipSyncTimeline(detail.lipSyncTimeline, elapsedMs)
        : null
      const audioLevel = measureDesktopVoiceAudioLevel()
      if (!frame && audioLevel === null) return
      const next = desktopPlainJson({
        kind: 'frame' as const,
        generation,
        agentId: detail.agentId ?? null,
        messageId: detail.messageId ?? null,
        atMs: Date.now(),
        elapsedMs,
        frame,
        audioLevel
      })
      desktopLastVoiceVisual = next
      if (desktopPublisher) publishDesktopDelta({ type: 'voice.visual', visual: next })
    }, 40)
  }

  function clearDesktopCueTimers() {
    for (const timer of desktopCueTimers) clearTimeout(timer)
    desktopCueTimers.clear()
  }

  function restoreDesktopGoonToDock(reason: string, error?: string | null) {
    if (desktopExitInProgress) return
    const involvedDesktop =
      desktopPresentation.mode === 'desktop' ||
      desktopPresentation.transition?.to === 'desktop' ||
      desktopPresentation.transition?.from === 'desktop'
    if (!involvedDesktop) return
    desktopExitInProgress = true
    const transition = desktopPresentation.transition
    if (transition) {
      desktopPresentation = rollbackDesktopGoonPresentationTransition(
        desktopPresentation,
        transition.id,
        error || reason
      )
    } else {
      const id = `desktop-return-${Date.now()}`
      desktopPresentation = beginDesktopGoonPresentationTransition(desktopPresentation, 'dock', id)
      desktopPresentation = commitDesktopGoonPresentationTransition(desktopPresentation, id)
      if (error) desktopPresentation = { ...desktopPresentation, lastError: error }
    }
    desktopBridgeError = error ?? null
    desktopPublisher?.close()
    desktopPublisher = null
    clearDesktopVoiceFrames()
    clearDesktopVoiceAudioProjection()
    clearDesktopCueTimers()
    goonsPanelOpen = true
    artifactsPanelOpen = false
    void updateGoonsSettings({ dockOpen: true, immersiveMode: false })
    void tick().then(() => {
      desktopExitInProgress = false
    })
  }

  function handleDesktopBridgeFailure(failure: DesktopGoonBridgeFailure) {
    desktopBridgeError = failure.message
    restoreDesktopGoonToDock('Desktop state bridge disconnected.', failure.message)
  }

  function handleDesktopStatePort(facade: DesktopGoonStatePortFacade) {
    const snapshot = buildDesktopRuntimeSnapshot()
    if (!snapshot) {
      desktopBridgeError = 'Desktop Mode could not build its initial Goon snapshot.'
      restoreDesktopGoonToDock('Desktop snapshot unavailable.', desktopBridgeError)
      return
    }
    desktopPublisher?.close()
    desktopPublisher = new DesktopGoonMainStatePublisher({
      port: adaptDesktopGoonStatePort(facade),
      onSnapshotRequired: () => buildDesktopRuntimeSnapshot(),
      onTerminal: handleDesktopBridgeFailure
    })
    desktopSessionSignature = JSON.stringify([currentSessionId, dockAgentId])
    desktopSpeakerSignature = JSON.stringify(resolvedDesktopGoonSpeaker)
    desktopGoonSignature = JSON.stringify(buildDesktopGoonRef())
    desktopPreferencesSignature = JSON.stringify(desktopGoonPreferences)
    desktopPresentationSignature = JSON.stringify(desktopPresentation)
    const result = desktopPublisher.publishInitialSnapshot(snapshot)
    if (!result.ok) handleDesktopBridgeFailure(result.failure)
  }

  function handleDesktopShellStatus(value: DesktopGoonShellStatus) {
    desktopShellStatus = latestDesktopShellStatus(value)
    const type = value.type
    if (type === 'renderer-ready' && desktopPresentation.transition?.to === 'desktop') {
      desktopPresentation = commitDesktopGoonPresentationTransition(
        desktopPresentation,
        desktopPresentation.transition.id
      )
      desktopBridgeError = null
      return
    }
    if (type === 'shortcut-conflict') {
      const message =
        typeof value.detail?.message === 'string'
          ? value.detail.message
          : 'The Desktop Controls shortcut is already in use.'
      desktopBridgeError = message
      toast.error(message)
      return
    }
    if (type === 'return-to-batshit-requested') {
      restoreDesktopGoonToDock('The Goon returned to Batshit.')
      return
    }
    const failureTypes = new Set([
      'desktop-renderer-initialization-failed',
      'desktop-renderer-ready-timeout',
      'desktop-renderer-unresponsive',
      'desktop-renderer-stopped',
      'desktop-route-load-failed',
      'desktop-bridge-ready-timeout',
      'state-port-transfer-failed'
    ])
    if (type && failureTypes.has(type)) {
      const message =
        typeof value.detail?.message === 'string'
          ? value.detail.message
          : 'Desktop Mode stopped unexpectedly.'
      restoreDesktopGoonToDock('Desktop Mode failed.', message)
    }
  }

  async function enterDesktopGoonMode() {
    if (desktopTransitionBusy || desktopPresentation.mode === 'desktop') return
    if (!desktopNativeBridge || !desktopModeAvailable) {
      toast.error(desktopModeUnavailableReason ?? 'Desktop Mode is unavailable.')
      return
    }
    if (!activeGoon || !goonDockRef) {
      toast.error('Open a ready Goon in the Dock before starting Desktop Mode.')
      return
    }
    if (!goonDockRef.isMountedRendererReady()) {
      toast.error('The Goon is still preparing. Try Desktop Mode again in a moment.')
      return
    }
    const transitionId = `desktop-enter-${Date.now()}`
    let nativeWindowOpened = false
    try {
      desktopPresentation = beginDesktopGoonPresentationTransition(
        desktopPresentation,
        'desktop',
        transitionId
      )
      desktopBridgeError = null
      desktopQuickControlContext = normalizeGoonQuickControlRuntimeContext(
        goonDockRef.captureQuickControlRuntimeContext()
      )
      desktopQuickControlPending = null
      desktopQuickControlError = null
      const released = goonDockRef.releaseMountedRenderer()
      if (!released) throw new Error('The Dock renderer was not ready to transfer.')
      desktopHandoffState = desktopPlainJson(released)
      desktopEpoch = `desktop-${Date.now()}-${++desktopEpochCounter}`
      if (desktopActiveVoiceDetail) beginDesktopVoiceProjection(desktopActiveVoiceDetail)
      goonsPanelOpen = false
      await updateGoonsSettings({ dockOpen: false, immersiveMode: false })
      await tick()
      await desktopNativeBridge.invoke('desktopGoon.open', {
        preferences: desktopPlainJson(desktopGoonPreferences)
      })
      nativeWindowOpened = true
      await desktopNativeBridge.invoke('desktopGoon.connectStatePort')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop Mode failed to start.'
      if (nativeWindowOpened) {
        try {
          await desktopNativeBridge.invoke('desktopGoon.close', { reason: 'enter-failed' })
        } catch {
          // The Dock rollback below remains available when the native close also fails.
        }
      }
      if (desktopPresentation.transition?.id === transitionId) {
        desktopPresentation = rollbackDesktopGoonPresentationTransition(
          desktopPresentation,
          transitionId,
          message
        )
      }
      desktopBridgeError = message
      goonsPanelOpen = true
      await updateGoonsSettings({ dockOpen: true, immersiveMode: false })
      toast.error(message)
    }
  }

  async function closeDesktopGoonMode(reason = 'main-window') {
    if (desktopExitInProgress || !desktopNativeBridge) return
    desktopExitInProgress = true
    try {
      desktopShellStatus = latestDesktopShellStatus(
        await desktopNativeBridge.invoke('desktopGoon.close', { reason })
      )
      const transitionId = `desktop-close-${Date.now()}`
      desktopPresentation = commitDesktopGoonPresentationTransition(
        beginDesktopGoonPresentationTransition(desktopPresentation, 'dock', transitionId),
        transitionId
      )
      desktopBridgeError = null
      desktopPublisher?.close()
      desktopPublisher = null
      clearDesktopVoiceFrames()
      clearDesktopVoiceAudioProjection()
      clearDesktopCueTimers()
      desktopHandoffState = null
      desktopEpoch = ''
      desktopQuickControlContext = null
      desktopQuickControlPending = null
      desktopQuickControlError = null
      goonsPanelOpen = false
      artifactsPanelOpen = false
      await updateGoonsSettings({ dockOpen: false, immersiveMode: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop Mode could not close.'
      desktopBridgeError = message
      toast.error(message)
    } finally {
      desktopExitInProgress = false
    }
  }

  function applyDesktopGoonPreferencesLive(preferencesInput: DesktopGoonPreferences) {
    if (!desktopNativeBridge) return
    const preferences = desktopPlainJson(normalizeDesktopGoonPreferences(preferencesInput))
    const signature = JSON.stringify(preferences)
    if (signature === desktopPreferencesSignature) return
    desktopPreferencesSignature = signature
    if (desktopPublisher) {
      publishDesktopDelta({ type: 'settings.changed', preferences })
    }
    void desktopNativeBridge
      .invoke('desktopGoon.updatePreferences', { preferences })
      .then((status) => {
        desktopShellStatus = latestDesktopShellStatus(status)
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : 'Desktop Mode preferences could not be updated.'
        desktopBridgeError = message
        toast.error(message)
      })
  }

  function publishDesktopControlsProjection() {
    if (!desktopControlsBridge) return
    const goonControls = desktopQuickControlContext
      ? buildGoonQuickControlsProjection(activeGoon, goonsSettings, desktopQuickControlContext)
      : null
    const projection = desktopPlainJson({
      sessionId: currentSessionId ?? null,
      clipRevision: desktopControlsClipRevision,
      preferences: desktopGoonPreferences,
      voice: desktopControlsVoiceState,
      goonControls: {
        state: goonControls,
        pendingAction: desktopQuickControlPending,
        error: desktopQuickControlError
      }
    })
    const signature = JSON.stringify(projection)
    if (signature === desktopControlsProjectionSignature) return
    void desktopControlsBridge
      .invoke('desktopControls.updateState', { state: projection })
      .then(() => {
        desktopControlsProjectionSignature = signature
      })
      .catch((error) => {
        // Keep the old signature so the next canonical state change retries this projection.
        const message =
          error instanceof Error ? error.message : 'Desktop Controls state could not update.'
        desktopBridgeError = message
        toast.error(message)
      })
  }

  async function persistDesktopControlsPreferences(patch: Partial<DesktopGoonPreferences>) {
    if (getUserSettingsReadState() !== 'confirmed') {
      throw new Error('Goon settings could not load. Open Settings and press Retry before changing Desktop preferences.')
    }
    const persistedSettings = await persistGoonsSettingsPatchRequest(fetch, {
      desktop: patch
    })
    confirmUserSettings(persistedSettings)
    applyDesktopGoonPreferencesLive(normalizeDesktopGoonPreferences(persistedSettings.goons_settings?.desktop))
  }

  function updateDesktopHandoffEyeContact(enabled: boolean) {
    if (!desktopHandoffState?.eyeContact) return
    desktopHandoffState = desktopPlainJson({
      ...desktopHandoffState,
      eyeContact: {
        ...desktopHandoffState.eyeContact,
        enabled
      }
    })
  }

  async function applyDesktopQuickControl(action: GoonQuickControlAction) {
    if (desktopQuickControlPending) return
    desktopQuickControlPending = action.kind
    desktopQuickControlError = null
    try {
      const targetGoon = activeGoon
      const context = desktopQuickControlContext
      if (!targetGoon || !context || desktopPresentation.mode !== 'desktop') {
        throw new Error('Desktop Goon quick controls are unavailable.')
      }
      if (action.kind === 'eye-contact') {
        desktopQuickControlContext = normalizeGoonQuickControlRuntimeContext({
          ...context,
          eyeContactEnabled: action.enabled
        })
        updateDesktopHandoffEyeContact(action.enabled)
        publishDesktopDelta({
          type: 'quick-control.changed',
          value: { kind: 'eye-contact', enabled: action.enabled }
        })
        return
      }

      const patch = buildGoonQuickControlPatch(
        targetGoon,
        goonsSettings,
        context.materialNames,
        action
      )
      if (!patch) return
      const updatedGoon = await updateGoonRecord(targetGoon.id, patch)

      if (action.kind === 'mood') {
        const cueMap = resolveGoonCues(targetGoon, goonsSettings).cueMap
        const definition =
          cueMap[action.cueName] ??
          Object.values(cueMap).find((entry) => entry.name === action.cueName)
        if (!definition || definition.kind !== 'mood') {
          throw new Error('The selected Mood is no longer available.')
        }
        publishDesktopDelta({
          type: 'quick-control.changed',
          value: {
            kind: 'mood',
            name: definition.name,
            definition: desktopPlainJson(definition) as unknown as {
              [key: string]: DesktopGoonJsonValue
            }
          }
        })
      } else if (action.kind === 'quality') {
        publishDesktopDelta({
          type: 'quick-control.changed',
          value: { kind: 'quality', quality: action.value }
        })
      } else {
        publishDesktopDelta({
          type: 'quick-control.changed',
          value: {
            kind: 'closet',
            goonId: updatedGoon.id,
            recordUpdatedAt: updatedGoon.updated_at
          }
        })
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The Desktop Goon control could not update.'
      desktopQuickControlError = message
      toast.error(message)
    } finally {
      desktopQuickControlPending = null
    }
  }

  function handleDesktopControlsState(event: DesktopControlsStateEvent) {
    if (event.type !== 'renderer-intent') return
    const intent = typeof event.detail?.intent === 'string' ? event.detail.intent : ''
    const payload =
      event.detail?.payload && typeof event.detail.payload === 'object' && !Array.isArray(event.detail.payload)
        ? (event.detail.payload as Record<string, unknown>)
        : {}
    if (intent === 'voice.start') {
      void desktopControlsVoiceCoordinator.requestStart().catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Voice Mode could not start.')
      })
      return
    }
    if (intent === 'voice.end') {
      void desktopControlsVoiceCoordinator.requestEnd().catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Voice Mode could not end.')
      })
      return
    }
    if (intent === 'voice.toggle-listening') {
      void desktopControlsVoiceCoordinator.requestListeningToggle().catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Voice listening could not change.')
      })
      return
    }
    if (intent === 'clips.changed') {
      desktopControlsClipRevision += 1
      if (currentSessionId) {
        dispatchSessionClipStateChanged({ sessionId: currentSessionId, source: 'runtime' })
      }
      return
    }
    if (intent === 'goon.quick-control') {
      try {
        const action = normalizeGoonQuickControlAction(payload.action)
        void applyDesktopQuickControl(action)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'The Desktop Goon control is invalid.'
        desktopQuickControlError = message
        toast.error(message)
      }
      return
    }
    if (intent === 'desktop.close') {
      void closeDesktopGoonMode(
        typeof payload.reason === 'string' ? payload.reason : 'controls-island'
      )
      return
    }
    if (intent === 'preferences.update') {
      const patch: Partial<DesktopGoonPreferences> = {}
      if (typeof payload.stayOnTop === 'boolean') patch.stayOnTop = payload.stayOnTop
      if (typeof payload.clickThrough === 'boolean') patch.clickThrough = payload.clickThrough
      if (Object.keys(patch).length === 0) return
      void persistDesktopControlsPreferences(patch).catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Desktop Mode settings could not update.')
      })
    }
  }

  onMount(() => {
    desktopNativeBridge = getDesktopGoonNativeBridge('main')
    if (!desktopNativeBridge) return
    desktopControlsBridge = getDesktopControlsNativeBridge('main')
    if (desktopControlsBridge) {
      desktopControlsUnsubscribe = desktopControlsBridge.onState(handleDesktopControlsState)
      desktopControlsVoiceUnsubscribe = desktopControlsVoiceCoordinator.subscribe((state) => {
        desktopControlsVoiceState = state
      })
      void desktopControlsBridge.invoke('desktopControls.getState').catch(() => {
        // Desktop Goon availability remains authoritative; projection resumes when its window exists.
      })
    }

    desktopStatusUnsubscribe = desktopNativeBridge.onStatus(handleDesktopShellStatus)
    desktopPortUnsubscribe = desktopNativeBridge.onStatePort(handleDesktopStatePort)
    void desktopNativeBridge
      .invoke('desktopGoon.getStatus')
      .then((status) => {
        desktopShellStatus = latestDesktopShellStatus(status)
      })
      .catch((error) => {
        desktopBridgeError =
          error instanceof Error ? error.message : 'Desktop Mode status is unavailable.'
      })

    desktopReplaceableFlushTimer = setInterval(() => {
      desktopPublisher?.flushReplaceable()
    }, 40)

    const handleVoiceStart = (event: Event) => {
      const detail = (event as CustomEvent).detail as DesktopVoicePlaybackDetail
      desktopActiveVoiceDetail = detail
      if (!desktopModeActive) return
      if (dockAgentId && detail?.agentId && detail.agentId !== dockAgentId) return
      beginDesktopVoiceProjection(detail)
    }

    const handleVoiceAlignment = (event: Event) => {
      const detail = (event as CustomEvent).detail as DesktopVoicePlaybackDetail
      if (desktopActiveVoiceDetail && detail?.messageId === desktopActiveVoiceDetail.messageId) {
        desktopActiveVoiceDetail = {
          ...desktopActiveVoiceDetail,
          ...detail,
          audio: desktopActiveVoiceDetail.audio
        }
      }
      if (!desktopModeActive || !desktopPublisher || !desktopVoiceGeneration) return
      if (!detail?.lipSyncTimeline || !detail.lipSyncAnalyzerId) return
      if (dockAgentId && detail.agentId && detail.agentId !== dockAgentId) return
      const visual = desktopPlainJson({
        kind: 'alignment' as const,
        generation: desktopVoiceGeneration,
        agentId: detail.agentId ?? null,
        messageId: detail.messageId ?? null,
        atMs: Date.now(),
        durationMs: detail.durationMs ?? null,
        analyzerId: detail.lipSyncAnalyzerId,
        timeline: detail.lipSyncTimeline
      })
      desktopLastVoiceVisual = visual
      publishDesktopDelta({ type: 'voice.visual', visual })
      beginDesktopVoiceProjection(
        {
          ...(desktopActiveVoiceDetail ?? {}),
          ...detail,
          audio: desktopActiveVoiceDetail?.audio ?? null
        },
        desktopVoiceGeneration,
        false
      )
    }

    const handleVoiceEnd = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        messageId?: string | null
        agentId?: string | null
      }
      if (
        desktopActiveVoiceDetail &&
        ((detail?.messageId && desktopActiveVoiceDetail.messageId !== detail.messageId) ||
          (detail?.agentId && desktopActiveVoiceDetail.agentId !== detail.agentId))
      ) {
        return
      }
      desktopActiveVoiceDetail = null
      if (!desktopModeActive || !desktopPublisher || !desktopVoiceGeneration) return
      if (dockAgentId && detail?.agentId && detail.agentId !== dockAgentId) return
      clearDesktopVoiceFrames()
      clearDesktopVoiceAudioProjection()
      const visual = {
        kind: 'end' as const,
        generation: desktopVoiceGeneration,
        agentId: detail?.agentId ?? null,
        messageId: detail?.messageId ?? null,
        endedAtMs: Date.now()
      }
      desktopLastVoiceVisual = visual
      publishDesktopDelta({ type: 'voice.visual', visual })
      desktopVoiceGeneration = ''
    }

    const handleGoonMessage = (event: Event) => {
      if (!desktopModeActive || !desktopPublisher || !activeGoon) return
      const detail = (event as CustomEvent).detail as {
        messageId?: string
        agentId?: string | null
        content?: string
        source?: string
      }
      if (!detail?.messageId || !detail.content) return
      if (dockAgentId && detail.agentId && detail.agentId !== dockAgentId) return
      const { cueMap, emojiMap } = resolveGoonCues(activeGoon, goonsSettings)
      const parsed = parseGoonCues(detail.content, emojiMap, cueMap)
      const natural =
        parsed.length === 0 && detail.source?.startsWith('livekit')
          ? parseLiveKitNaturalGoonCues(detail.content, cueMap)
          : []
      const cues = parsed.length > 0 ? parsed : natural
      cues.forEach((cue, index) => {
        const publish = () => {
          publishDesktopDelta({
            type: 'cue',
            cueId: `${detail.messageId}:${index}:${cue.name}`,
            name: cue.name,
            payload: desktopPlainJson(cue.definition ?? {}) as {
              [key: string]: DesktopGoonJsonValue
            }
          })
        }
        if (cue.definition?.kind === 'mood' || cue.definition?.playback === 'loop') {
          publish()
          return
        }
        const timer = setTimeout(() => {
          desktopCueTimers.delete(timer)
          publish()
        }, index * 650)
        desktopCueTimers.add(timer)
      })
    }

    const handleDesktopGoonPreferencesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<DesktopGoonPreferencesUpdatedDetail>).detail
      if (!detail?.preferences) return
      applyDesktopGoonPreferencesLive(detail.preferences)
    }

    window.addEventListener('batshit:voice-playback-start', handleVoiceStart as EventListener)
    window.addEventListener('batshit:voice-alignment-update', handleVoiceAlignment as EventListener)
    window.addEventListener('batshit:voice-playback-end', handleVoiceEnd as EventListener)
    window.addEventListener('batshit:goon-message', handleGoonMessage as EventListener)
    window.addEventListener(
      LIVE_SETTINGS_EVENTS.desktopGoonPreferencesUpdated,
      handleDesktopGoonPreferencesUpdated as EventListener
    )

    return () => {
      desktopStatusUnsubscribe?.()
      desktopStatusUnsubscribe = null
      desktopPortUnsubscribe?.()
      desktopPortUnsubscribe = null
      desktopControlsUnsubscribe?.()
      desktopControlsUnsubscribe = null
      desktopControlsVoiceUnsubscribe?.()
      desktopControlsVoiceUnsubscribe = null
      desktopControlsBridge = null
      desktopPublisher?.close()
      desktopPublisher = null
      if (desktopReplaceableFlushTimer) clearInterval(desktopReplaceableFlushTimer)
      desktopReplaceableFlushTimer = null
      clearDesktopVoiceFrames()
      clearDesktopVoiceAudioProjection()
      clearDesktopCueTimers()
      window.removeEventListener('batshit:voice-playback-start', handleVoiceStart as EventListener)
      window.removeEventListener('batshit:voice-alignment-update', handleVoiceAlignment as EventListener)
      window.removeEventListener('batshit:voice-playback-end', handleVoiceEnd as EventListener)
      window.removeEventListener('batshit:goon-message', handleGoonMessage as EventListener)
      window.removeEventListener(
        LIVE_SETTINGS_EVENTS.desktopGoonPreferencesUpdated,
        handleDesktopGoonPreferencesUpdated as EventListener
      )
    }
  })

  $effect(() => {
    if (desktopPresentation.transition || desktopPresentation.mode === 'desktop') return
    const target = immersiveActive ? 'immersive' : 'dock'
    if (desktopPresentation.mode === target) return
    const transitionId = `desktop-presentation-sync-${Date.now()}`
    desktopPresentation = commitDesktopGoonPresentationTransition(
      beginDesktopGoonPresentationTransition(desktopPresentation, target, transitionId),
      transitionId
    )
  })

  $effect(() => {
    if (!desktopPublisher) return
    const signature = JSON.stringify(desktopPresentation)
    if (signature === desktopPresentationSignature) return
    desktopPresentationSignature = signature
    publishDesktopDelta({
      type: 'presentation.changed',
      presentation: desktopPlainJson(desktopPresentation)
    })
  })

  $effect(() => {
    if (!desktopPublisher) return
    const signature = JSON.stringify([currentSessionId, dockAgentId])
    if (signature === desktopSessionSignature) return
    desktopSessionSignature = signature
    publishDesktopDelta({
      type: 'session-agent.changed',
      sessionId: currentSessionId ?? null,
      activeAgentId: dockAgentId
    })
  })

  $effect(() => {
    if (!desktopPublisher) return
    const signature = JSON.stringify(resolvedDesktopGoonSpeaker)
    if (signature === desktopSpeakerSignature) return
    desktopSpeakerSignature = signature
    publishDesktopDelta({
      type: 'speaker.changed',
      activeSpeaker: desktopPlainJson(resolvedDesktopGoonSpeaker)
    })
  })

  $effect(() => {
    if (!desktopPublisher) return
    const goon = buildDesktopGoonRef()
    const signature = JSON.stringify(goon)
    if (signature === desktopGoonSignature) return
    desktopGoonSignature = signature
    publishDesktopDelta({ type: 'goon.invalidated', goon: desktopPlainJson(goon) })
  })

  $effect(() => {
    if (!desktopNativeBridge) return
    applyDesktopGoonPreferencesLive(desktopGoonPreferences)
  })

  $effect(() => {
    if (!desktopControlsBridge) return
    currentSessionId
    desktopControlsClipRevision
    desktopGoonPreferences
    desktopControlsVoiceState
    desktopQuickControlContext
    desktopQuickControlPending
    desktopQuickControlError
    activeGoon
    goonsSettings
    publishDesktopControlsProjection()
  })

  $effect(() => {
    if (typeof window === 'undefined') return
    if (!rightPanelDragging) return

    const handleMove = (event: PointerEvent) => handleRightPanelDragMove(event)
    const handleEnd = () => handleRightPanelDragEnd()

    window.addEventListener('pointermove', handleMove, { capture: true })
    window.addEventListener('pointerup', handleEnd, { capture: true })
    window.addEventListener('pointercancel', handleEnd, { capture: true })
    window.addEventListener('blur', handleEnd)

    return () => {
      window.removeEventListener('pointermove', handleMove, { capture: true })
      window.removeEventListener('pointerup', handleEnd, { capture: true })
      window.removeEventListener('pointercancel', handleEnd, { capture: true })
      window.removeEventListener('blur', handleEnd)
    }
  })

  function toggleGoonsPanel() {
    if (desktopModeActive) {
      void closeDesktopGoonMode('main-goon-tab')
      return
    }
    const next = !goonsPanelOpen
    goonsPanelOpen = next
    if (next) {
      artifactsPanelOpen = false
    }
    updateGoonsSettings({ dockOpen: next })
  }

  function closeArtifactsPanel() {
    artifactsPanelOpen = false
  }

  function isSidebarOverlaySafeElement(target: EventTarget | null) {
    if (!(target instanceof Element)) return false
    return Boolean(
      target.closest(
        '[data-slot="sidebar-container"], [data-sidebar-overlay-popover="true"], .session-menu-content, .folder-row-menu-content'
      )
    )
  }

  function cleanupSidebarOverlayPointerListener() {
    if (sidebarOverlayPointerCleanup) {
      sidebarOverlayPointerCleanup()
      sidebarOverlayPointerCleanup = null
    }
  }

  function closeSidebarOverlayIfPointerLeaves(event: MouseEvent) {
    if (!rightPanelOpen || !sidebar?.open) {
      cleanupSidebarOverlayPointerListener()
      return
    }
    if (isSidebarOverlaySafeElement(event.target)) return
    sidebar.setOpen(false)
    cleanupSidebarOverlayPointerListener()
  }

  function trackSidebarOverlayPopoverHover() {
    if (typeof window === 'undefined' || sidebarOverlayPointerCleanup) return
    window.addEventListener('mousemove', closeSidebarOverlayIfPointerLeaves)
    sidebarOverlayPointerCleanup = () =>
      window.removeEventListener('mousemove', closeSidebarOverlayIfPointerLeaves)
  }

  async function handleGoonCompatibility(report: any) {
    if (!activeGoon) return
    try {
      await updateGoonRecord(activeGoon.id, { compatibility: report })
    } catch (error) {
      console.error('[Goons] Failed to update compatibility:', error)
    }
  }

  async function handleGoonCamera(camera: GoonCamera) {
    if (!activeGoon) return
    try {
      await updateGoonRecord(activeGoon.id, { camera })
    } catch (error) {
      console.error('[Goons] Failed to update camera settings:', error)
    }
  }

  let goonsPanelHydrated = $state(false)
  let goonsPanelLaunchResetPersisted = $state(false)
  $effect(() => {
    if (!goonsPanelHydrated) {
      goonsPanelOpen = false
      goonsPanelHydrated = true
    }
    if (goonsPanelLaunchResetPersisted || !userSettings) return
    goonsPanelLaunchResetPersisted = true
    if (Boolean(userSettings.goons_settings?.dockOpen)) {
      updateGoonsSettings({ dockOpen: false })
    }
    // Launch always starts closed. After that, local state is source of truth
    // and persists through toggleGoonsPanel/handleArtifactSelect for this session.
  })

  $effect(() => {
    if (!sidebar) return

    // Rising edge: any right panel just opened → collapse sidebar once but remember state
    if (rightPanelOpen && !rightPanelPrev) {
      if (sidebarWasOpen === null) sidebarWasOpen = sidebar.open
      if (sidebar.open) sidebar.setOpen(false)
    }

    // Falling edge: all right panels closed → restore sidebar to previous state
    if (!rightPanelOpen && rightPanelPrev) {
      if (sidebarWasOpen !== null) {
        sidebar.setOpen(sidebarWasOpen)
        sidebarWasOpen = null
      }
    }

    rightPanelPrev = rightPanelOpen
  })

  $effect(() => {
    if (typeof document === 'undefined') return

    if (rightPanelOpen) {
      document.body.classList.add('sidebar-overlay')
    } else {
      document.body.classList.remove('sidebar-overlay')
    }

    // Auto-close sidebar on mouseleave when overlaying, while treating
    // sidebar-owned portal popovers as part of the same hover zone.
    if (rightPanelOpen && sidebar?.open) {
      const container = document.querySelector('[data-slot="sidebar-container"]') as HTMLElement | null
      const handleLeave = (event: MouseEvent) => {
        if (isSidebarOverlaySafeElement(event.relatedTarget)) {
          trackSidebarOverlayPopoverHover()
          return
        }
        sidebar.setOpen(false)
        cleanupSidebarOverlayPointerListener()
      }
      if (container) {
        container.addEventListener('mouseleave', handleLeave)
        overlayListenerCleanup = () => {
          container.removeEventListener('mouseleave', handleLeave)
          cleanupSidebarOverlayPointerListener()
        }
      }
    } else {
      if (overlayListenerCleanup) overlayListenerCleanup()
      overlayListenerCleanup = null
      cleanupSidebarOverlayPointerListener()
    }
  })

  $effect(() => {
    if (typeof document === 'undefined') return
    if (immersiveActive) {
      document.body.classList.add('goon-immersive')
    } else {
      document.body.classList.remove('goon-immersive')
    }
  })

  // Artifact management functions
  async function handleArtifactSelect(artifact: any) {
    const detailedArtifact = artifact?.id
      ? (await artifactService.getArtifact(artifact.id)) ?? artifact
      : artifact
    currentArtifact = detailedArtifact
    artifactsPanelOpen = true
    if (goonsPanelOpen) {
      goonsPanelOpen = false
      updateGoonsSettings({ dockOpen: false })
    }
    if (resolveZone(detailedArtifact) === 'panel') {
      activePanelArtifactId = detailedArtifact.id
    }

    // Set as active artifact for the current session
  }

  async function openArtifactOverlay(artifact: any) {
    headerOverlayArtifact = artifact
    headerOverlayOpen = true

  }

  async function handleArtifactCreate() {
    if (!data.user) return

    const sessionId = sessionStore.getCurrentSessionId()
    if (!sessionId) {
      toast.error('Please start a chat session first')
      return
    }

    try {
      const newArtifact = await artifactService.createArtifact({
        name: 'New Artifact',
        type: 'html',
        content: '<!-- New artifact - ready for AI to create! -->',
        mode: 'edit'
      })

      // Reload artifacts and select the new one
      await loadArtifacts()
      currentArtifact = newArtifact

      window.dispatchEvent(new CustomEvent('batshit:open-settings', { detail: { tab: 'artifacts' } }))
      toast.success('New artifact created! Use Settings -> Artifacts to configure and publish it.')
    } catch (error) {
      console.error('Failed to create artifact:', error)
      toast.error('Failed to create artifact')
    }
  }

  async function handleArtifactRefresh(artifactId: string) {
    try {
      const refreshedArtifact = await artifactService.getArtifact(artifactId)
      if (refreshedArtifact) {
        // Update in artifacts list
        const index = artifacts.findIndex(a => a.id === artifactId)
        if (index !== -1) {
          artifacts[index] = refreshedArtifact
        }

        // Update current artifact if it's the one being refreshed
        if (currentArtifact?.id === artifactId) {
          currentArtifact = refreshedArtifact
        }

        toast.success('Artifact refreshed!')
      }
    } catch (error) {
      console.error('Failed to refresh artifact:', error)
      toast.error('Failed to refresh artifact')
    }
  }

  async function handleModeChange(artifactId: string, mode: 'edit' | 'published') {
    try {
      const updatedArtifact = await artifactService.changeMode(artifactId, mode)

      // Update in artifacts list
      const index = artifacts.findIndex(a => a.id === artifactId)
      if (index !== -1) {
        artifacts[index] = updatedArtifact
      }

      // Update current artifact if it's the one being changed
      if (currentArtifact?.id === artifactId) {
        currentArtifact = updatedArtifact
      }

    } catch (error) {
      console.error('Failed to change artifact mode:', error)
      throw error // Let the caller handle the error message
    }
  }

  async function handleVersionSelect(artifactId: string, versionId: string) {
    logger.debug('Version selected:', artifactId, versionId)
    // TODO: Implement version switching
    toast.info('Version switching coming soon!')
  }

  // Handle panel artifact icon clicks (right rail)
  async function handlePanelArtifactSelect(artifactId: string | null) {
    logger.debug('Panel artifact select:', artifactId)
    if (!artifactId) return
    // Toggle: clicking the already-active icon while panel is open closes it
    if (artifactsPanelOpen && activePanelArtifactId === artifactId) {
      artifactsPanelOpen = false
      return
    }
    const artifact = panelArtifacts.find((a) => a.id === artifactId) || artifacts.find((a) => a.id === artifactId)
    if (artifact) {
      activePanelArtifactId = artifact.id
      await handleArtifactSelect(artifact)
    }
  }

  function openDiagnosticsPanel() {
    window.dispatchEvent(
      new CustomEvent('batshit:open-settings', {
        detail: {
          tab: 'admin',
          section: 'diagnostics',
          diagnosticsAction: 'preview'
        }
      })
    )
  }
</script>

<div class="chat-workspace">
  <!-- Projects Sidebar -->
  <ProjectsSidebar
    {data}
    isTokenPanelOpen={tokenPanelOpen}
    {rightPanelOpen}
    rightPanelMinWidth={RIGHT_PANEL_MIN_WIDTH}
    chatMinWidth={RIGHT_PANEL_MIN_CHAT_WIDTH}
    {rightRailWidth}
  />

  <div
    bind:this={goonStageEl}
    class={`chat-stage ${rightPanelOverlayMode ? 'is-right-panel-overlay' : ''}`}
  >
    <!-- Main Chat Area (container-queries target) -->
    <div
      class={`chat-column ${immersiveActive ? 'goon-chat-overlay' : ''}`}
      style="container-type: inline-size; container-name: chat-column;"
    >
      <!-- Future compact artifact widget zone. Kept disabled until the artifact skill owns this zone. -->
      {#if COMPACT_ARTIFACT_WIDGET_ZONE_ENABLED}
        <CompactArtifactShelf bind:isOpen={tokenPanelOpen} />
      {/if}

      <!-- SA-113 P1 (DL-113-08): one line saying a wake-up started this chat, not the user. -->
      {#if currentSessionOrigin}
        <div class="chat-origin-banner" data-testid="chat-origin-banner">
          <ChatOriginIcon class="chat-origin-banner-icon" aria-hidden="true" />
          <span>{describeSessionOrigin(currentSessionOrigin)}</span>
          <!-- P4: the banner is where a user first wonders "what DM was that?", so it is
               also the shortest way into the drawer. Offered only when the agent has Agent
               DMs on, so it can never point at a drawer that has nothing to show. -->
          {#if resolveAgentDmsEnabled(agentStore.getCurrentAgent())}
            <button
              type="button"
              class="chat-origin-banner-link"
              onclick={() => (dmDrawerOpen = true)}
            >
              Open inbox
            </button>
          {/if}
        </div>
      {/if}

      <!-- Chat Messages Area or Welcome Screen -->
      {#if hasMessages}
        <ChatArea
          messages={compactedMessages}
          trimmedMessageIds={currentEffectiveTrimmedMessageIds}
          compactedMessageIds={currentCompactedMessageIds}
          sessionId={sessionStore.getCurrentSessionId()}
          {isWaitingForResponse}
          {isWaitingForToolCall}
          {activeToolMessageIds}
          toolCallNamesByMessageId={activeToolCallNamesByMessageId}
          thinkingSubjects={thinkingSubjects}
          planSubjects={planSubjects}
          {voiceSettings}
          composerClipCount={activeComposerClipIds.length}
          onResendDroppedSteer={resendDroppedSteer}
          onDismissDroppedSteer={dismissDroppedSteer}
          canResendDroppedSteer={canResendDroppedSteer}
          sessionBusy={chatWorkBusy}
          onSendHeldMessage={sendHeldMessageNow}
          onSendWaitingSendNow={sendWaitingSendNow}
        />
      {:else}
        <!-- Centered Welcome Layout -->
        <div class="chat-welcome">
          {#if showWelcome}
            <div class="chat-welcome-card">
              <!-- Agent Avatar -->
              {#if currentWelcomeAgent}
                {#key getWelcomeAgentAvatarKey(currentWelcomeAgent)}
                <EntityAvatar
                  avatarUrl={getWelcomeAgentAvatarUrl(currentWelcomeAgent)}
                  iconRef={getWelcomeAgentAvatarIconRef(currentWelcomeAgent)}
                  iconFit={currentWelcomeAgent.avatar_icon_fit}
                  label={currentWelcomeAgent.displayName}
                  fallback="AI"
                  class="chat-welcome-avatar"
                />
                {/key}
                <!-- Agent Name -->
                <h2 class="chat-welcome-title">
                  {currentWelcomeAgent.displayName || 'Select an agent'}
                </h2>
              {/if}
              <!-- Welcome Message -->
              <p class="chat-welcome-message">
                {welcomeMessage}
              </p>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Chat Input Area -->
      <div class="chat-input-shell">
        <div class="chat-input-frame">
          <ChatInput
            bind:this={chatInputRef}
            onSend={handleSendMessage}
            bind:voiceMode
            sessionId={currentSessionId}
            goonsPanelOpen={goonPresentationVisible}
            goonPresentationMode={goonDcmPresentationMode}
            onVoiceModeChange={(enabled) => voiceMode = enabled}
            showExecutionViewer={false}
            workBusy={chatWorkBusy || compactBusy}
            onStopWork={handleStopWork}
            onOpenExecutionViewer={() => {
              executionViewerOpen = true
            }}
            onQuickActionMessage={handleQuickActionMessage}
            onClippedItemsChange={handleComposerClippedItemsChange}
            busySendMode={busySendMode}
            steerable={chatSteerable}
            steerReason={chatSteerReason}
            {data}
          />
        </div>

        <TokenPanel
          chatgptPlan={isChatgptPlanConnection(activeModelPreset?.connection?.id ?? agentStore.getCurrentAgent()?.primary_model_connection?.id)}
          {currentTokens}
          {contextLimit}
          contextPercent={contextUsage.contextPercent}
          contextState={contextUsage.state}
          contextLabel={contextUsage.label}
          contextDetail={contextUsage.detail}
          contextUnknownHint={contextLimit === null && normalizePrimaryAgentType(agentStore.getCurrentAgent()) === 'cli'
            ? 'The active CLI model\'s context limit is unknown. Batshit will show a percentage when a reliable limit is available.'
            : null}
          trimAvailable={contextUsage.trimAvailable}
          trimUnavailableReason={contextUsage.trimUnavailableReason}
          trimBusy={trimPreviewBusy}
          trimmedTokens={trimmedTokens}
          compactAvailable={compactAvailable}
          compactUnavailableReason={compactUnavailableReason}
          compactBusy={compactBusy}
          compactStatus={compactStatus}
          compactedTokens={compactedTokens}
          napMode={currentSessionFixed}
          napAvailable={napAvailable}
          napUnavailableReason={napUnavailableReason}
          napBusy={napBusy}
          napStatus={napStatus}
          onNap={() => handleNap({ trigger: 'manual' })}
          hasLatestResponse={latestResponseStats.found}
          cacheHitPercent={latestCacheHitPercent}
          localProgramLabel={activeLocalProgramLabel}
          localCacheReporting={activeLocalCacheReporting}
          cacheCachedTokens={latestCacheCachedTokens}
          cacheInputTokens={latestCacheInputTokens}
          cacheCreationTokens={latestCacheCreationTokens}
          sessionCacheHitPercent={sessionCacheStats?.percent ?? null}
          sessionCacheCachedTokens={sessionCacheStats?.cachedTokens ?? null}
          sessionCacheInputTokens={sessionCacheStats?.inputTokens ?? null}
          sessionCacheResponseCount={sessionCacheStats?.responseCount ?? null}
          outputTokensPerSecond={latestPerformanceStat('outputTokensPerSecond')}
          timeToFirstOutputMs={latestPerformanceStat('timeToFirstOutputMs')}
          responseTimeMs={latestPerformanceStat('responseTimeMs')}
          responseModelCalls={latestPerformanceStat('modelCalls')}
          performanceSource={latestResponseStats.performance?.source === 'measured' ||
          latestResponseStats.performance?.source === 'ai-sdk'
            ? latestResponseStats.performance.source
            : null}
          costLabel={
            runningCost.cost === null
              ? 'Unknown'
              : runningCost.cost.toLocaleString(undefined, {
                  style: 'currency',
                  currency: 'USD',
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
          }
          costDetail={
            executionSnapshotsError
              ? executionSnapshotsError
              : executionSnapshotsLoading && executionSnapshots.length === 0 && runningCost.cost === null
                ? 'Refreshing execution totals...'
                : runningCost.note
          }
          costState={runningCost.state}
          delegatedDetail={delegatedCostDetail}
          onTrim={handleTrim}
          onResetTrim={handleResetTrim}
          onCompact={() => handleCompact()}
          onOpenDiagnostics={openDiagnosticsPanel}
          onOpenExecutionViewer={() => {
            executionViewerOpen = true
          }}
        />
      </div>
    </div>


    <!-- Right Panel Slot -->
    <div
      class={`right-panel-slot ${immersiveActive ? 'goon-right-panel' : ''} ${rightPanelOverlayMode ? 'is-overlay' : ''}`}
      style="margin-right: var(--sidebar-width-icon);"
    >
    {#if !immersiveActive}
      <!-- Goon Dock toggle tab -->
      <button
        type="button"
        class="goon-dock-tab-trigger"
        style="top: {tokenPanelOpen ? '115px' : '14px'};"
        aria-expanded={goonsPanelOpen || desktopModeActive}
        aria-label={desktopModeActive ? 'Close Desktop Goon' : goonsPanelOpen ? 'Close Goon Dock' : 'Open Goon Dock'}
        title={desktopBridgeError ?? (desktopModeActive ? 'Close Desktop Goon' : 'Goon Dock')}
        onclick={() => toggleGoonsPanel()}
      >
        <BatshitIcon id="goons" class="goon-dock-tab-icon" />
      </button>
      {#if artifactsPanelOpen && !goonsPanelOpen}
        <button
          type="button"
          class="artifact-panel-close-tab-trigger"
          style="top: {tokenPanelOpen ? '153px' : '52px'};"
          aria-label="Close artifact panel"
          title="Close artifact panel"
          onclick={closeArtifactsPanel}
        >
          <ChevronRight class="artifact-panel-close-tab-icon" />
        </button>
      {/if}
    {/if}
    {#if goonsPanelOpen}
      <div
        class={`right-panel-frame ${immersiveActive ? 'is-immersive' : ''}`}
        style={`width: ${artifactsPanelWidth}px;`}
      >
        <!-- Resize handle -->
        <button
          type="button"
          aria-label="Resize right panel"
          class="right-panel-resize-handle is-goon"
          onpointerdown={handleRightPanelDragStart}
        >
          <div class="right-panel-resize-grip">
            <div></div>
            <div></div>
            <div></div>
          </div>
        </button>
        <GoonDock
          bind:this={goonDockRef}
          open={goonsPanelOpen}
          goon={activeGoon}
          speakerName={dockAgent?.displayName || 'Unknown speaker'}
          activeSpeakerId={dockAgentId}
          isSpeaking={dockAgentSpeaking}
          sharedAnimations={sharedGoonAnimations}
          quality={activeGoon?.defaults?.quality ?? 'auto'}
          lipSyncEnabled={activeGoon?.defaults?.lipSync ?? true}
          lipSyncMode={goonLipSyncMode}
          premiumLipSyncAnalyzer={premiumGoonLipSyncAnalyzer}
          lipSyncLabEnabled={goonLipSyncLabEnabled}
          goonsSettings={goonsSettings}
          immersiveMode={immersiveMode}
          immersiveStage={goonStageRect}
          {desktopModeAvailable}
          desktopModeBusy={desktopTransitionBusy}
          {desktopModeUnavailableReason}
          handoffMountedState={desktopHandoffState}
          onImmersiveChange={(value) => updateGoonsSettings({ immersiveMode: value })}
          onDesktopModeChange={() => enterDesktopGoonMode()}
          onQualityChange={(value) => updateActiveGoonDefaults({ quality: value })}
          onLipSyncChange={(value) => updateActiveGoonDefaults({ lipSync: value })}
          onCompatibilityReport={handleGoonCompatibility}
          onCameraChange={handleGoonCamera}
          onHandoffMountedStateConsumed={() => {
            desktopHandoffState = null
          }}
        />
      </div>
    {:else}
      {#if artifactsPanelOpen}
        <!-- Resize handle -->
        <button
          type="button"
          aria-label="Resize right panel"
          class="right-panel-resize-handle"
          onpointerdown={handleRightPanelDragStart}
        >
          <div class="right-panel-resize-grip">
            <div></div>
            <div></div>
            <div></div>
          </div>
        </button>
      {/if}
      <!-- Artifacts Sidebar -->
      <ArtifactsSidebar
        bind:this={artifactsSidebarRef}
        bind:open={artifactsPanelOpen}
        bind:artifacts
        bind:currentArtifact
        activeSessionId={currentSessionId ?? null}
        bind:width={artifactsPanelWidth}
        onArtifactSelect={handleArtifactSelect}
        onVersionSelect={handleVersionSelect}
        onArtifactRefresh={handleArtifactRefresh}
        onModeChange={handleModeChange}
        onDrag={(w: number) => artifactsPanelWidth = w}
      />
    {/if}
  </div>
</div>
</div>

<FirstRunSetupWizard {data} />

{#if isMounted}
  <div class="chat-header-actions-slot">
    <DmInboxIndicator
      agentId={agentStore.getCurrentAgentId()}
      dmsEnabled={resolveAgentDmsEnabled(agentStore.getCurrentAgent())}
      onOpen={() => (dmDrawerOpen = true)}
    />
    <UpdateAvailableIndicator />
    {#if headerArtifacts.length > 0 || triggerArtifacts.length > 0}
      <HeaderBarIcons
        artifacts={[...headerArtifacts, ...triggerArtifacts]}
        onOpenOverlay={openArtifactOverlay}
      />
    {/if}
  </div>
{/if}

<!-- Icon Column (fixed on far right) -->
<!-- Only render after mount to avoid SSR hydration issues -->
{#if isMounted}
  <IconColumn
    bind:activeArtifactId={activePanelArtifactId}
    panelOpen={artifactsPanelOpen && !goonsPanelOpen}
    artifacts={panelArtifacts}
    onSelect={handlePanelArtifactSelect}
  />
{/if}

<ExecutionViewerSheet bind:open={executionViewerOpen} sessionId={currentSessionId ?? undefined} />

<DmInboxDrawer bind:open={dmDrawerOpen} currentAgentId={agentStore.getCurrentAgentId()} />

<!-- SA-115 P2 (DL-115-07): the ONLY place a missed run can start. It owns its own open
     state because it opens on a live event and on load, not from a button anywhere. -->
<MissedSchedulesDialog />

<!-- Header Overlay for header/trigger widgets -->
<HeaderOverlay bind:open={headerOverlayOpen} bind:artifact={headerOverlayArtifact} />

<style>
  .chat-workspace,
  .chat-stage,
  .right-panel-slot,
  .right-panel-frame {
    height: 100%;
    min-height: 0;
  }

  .chat-workspace,
  .chat-stage {
    display: flex;
  }

  .chat-workspace {
    width: 100%;
    background: var(--background);
    color: var(--bs-app-text);
  }

  .chat-stage {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    background: var(--background);
  }

  /* Chat column responsive container for selector breakpoints */
  .chat-column {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 480px;
    min-height: 0;
    background: var(--bs-chat-canvas);
  }

  :global(body.sidebar-overlay [data-slot="sidebar-gap"]) {
    width: 0 !important;
    display: none !important;
  }

  :global(body.sidebar-overlay [data-slot="sidebar"]) {
    min-width: var(--sidebar-width-icon);
  }

  :global(body.sidebar-overlay [data-slot="sidebar-container"]) {
    position: fixed !important;
    inset: 0 auto auto 0 !important;
    width: var(--sidebar-width) !important;
    left: 0 !important;
    right: auto !important;
    z-index: var(--z-rail) !important;
    pointer-events: auto !important;
  }

  :global(body.sidebar-overlay [data-slot="sidebar"][data-state="collapsed"] [data-slot="sidebar-container"]) {
    width: var(--sidebar-width-icon) !important;
  }

  :global(body.sidebar-overlay [data-slot="sidebar"][data-state="collapsed"] [data-sidebar="sidebar"]) {
    --sidebar-width: var(--sidebar-width-icon) !important;
    --sidebar-width-mobile: var(--sidebar-width-icon) !important;
  }

  :global(body.sidebar-overlay [data-slot="sidebar-inner"]) {
    background: var(--background);
    box-shadow: 4px 0 18px oklch(0 0 0 / 0.25);
  }

  @container chat-column (max-width: 550px) {
    .chat-input-shell {
      padding: 0.75rem 0.75rem 0;
    }
  }

  /* SA-113 P1 (DL-113-08): one quiet line above the messages saying a wake-up, not the
     user, started this chat. Uses the shared surface tokens, no new colors. */
  .chat-origin-banner {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0 auto;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--bs-app-primary-soft);
    border-radius: 999px;
    background: var(--bs-app-primary-faint);
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    line-height: 1.2;
    width: fit-content;
    max-width: 100%;
  }

  :global(.chat-origin-banner-icon) {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
  }

  .chat-origin-banner-link {
    border: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    font-size: inherit;
    line-height: inherit;
    text-decoration: underline;
  }

  .chat-origin-banner-link:hover {
    color: var(--foreground);
  }

  .chat-welcome {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
  }

  .chat-welcome-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
    text-align: center;
    animation: fade-in 250ms ease-out both;
  }

  :global(.chat-welcome-avatar) {
    width: 128px;
    height: 128px;
    border-radius: 999px;
    box-shadow: 0 10px 24px color-mix(in oklab, black 35%, transparent);
  }

  .chat-welcome-title {
    margin: 0;
    color: var(--bs-app-title);
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.25;
  }

  .chat-welcome-message {
    margin: 0;
    color: var(--bs-app-muted-text);
    font-size: 1.125rem;
    line-height: 1.5;
    animation: fade-in 350ms ease-out 120ms both;
  }

  .chat-input-shell {
    position: relative;
    z-index: var(--z-chat);
    flex: 0 0 auto;
    padding: 0;
    background: transparent;
  }

  .chat-input-frame {
    width: 100%;
    max-width: 56rem;
    margin: 0 auto;
    padding: 0 1rem;
  }

  .right-panel-slot {
    position: relative;
    flex: 0 0 auto;
  }

  .right-panel-slot.is-overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: var(--z-surface);
    flex: none;
  }

  .right-panel-frame {
    position: relative;
    border-left: 1px solid var(--bs-app-shell-line);
    background: var(--bs-app-inset-surface);
  }

  .right-panel-slot.is-overlay .right-panel-frame {
    box-shadow: -18px 0 30px oklch(0 0 0 / 0.32);
  }

  .right-panel-frame.is-immersive {
    border-left: 0;
    background: transparent;
  }

  .right-panel-resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    z-index: var(--z-controls);
    width: 8px;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
    pointer-events: auto;
  }

  :global(body.dragging-right-panel .artifact-sidebar-shell iframe),
  :global(body.dragging-right-panel .artifact-sidebar-panel iframe),
  :global(body.dragging-right-panel .artifact-sidebar-main iframe),
  :global(body.dragging-right-panel .artifact-sidebar-detail iframe) {
    pointer-events: none;
  }

  .right-panel-resize-handle.is-goon {
    left: -4px;
  }

  .right-panel-resize-handle:hover,
  .right-panel-resize-handle:focus-visible {
    background: var(--bs-app-primary-faint);
    outline: none;
  }

  .right-panel-resize-handle:focus-visible {
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
  }

  .right-panel-resize-grip {
    position: absolute;
    left: 50%;
    top: 50%;
    display: flex;
    flex-direction: column;
    gap: 2px;
    transform: translate(-50%, -50%);
  }

  .right-panel-resize-grip div {
    width: 2px;
    height: 2px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--bs-app-muted-text) 60%, transparent);
  }

  .chat-header-actions-slot {
    position: fixed;
    top: 0;
    left: calc(var(--sidebar-width, 16rem) + 2.5rem);
    right: calc(var(--sidebar-width-icon, 3rem) + 0.25rem);
    z-index: var(--z-rail);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    height: var(--app-header-height);
    min-width: 0;
    pointer-events: none;
  }

  .chat-header-actions-slot :global(*) {
    pointer-events: auto;
  }

  .goon-chat-overlay {
    position: relative;
    z-index: var(--z-chat);
    background: transparent;
  }

  :global(body.goon-immersive .chat-column) {
    background: transparent;
  }

  :global(body.goon-immersive .chat-workspace),
  :global(body.goon-immersive .chat-stage) {
    background: transparent;
  }

  .goon-right-panel {
    position: relative;
    z-index: var(--z-dock);
  }

  .goon-dock-tab-trigger,
  .artifact-panel-close-tab-trigger {
    position: absolute;
    left: -32px;
    z-index: var(--z-controls);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border-width: 1px 0 1px 1px;
    border-style: solid;
    border-color: var(--bs-app-shell-line);
    border-radius: 6px 0 0 6px;
    background: var(--background);
    color: var(--muted-foreground);
    cursor: pointer;
    box-shadow: none;
    transition:
      top 200ms ease-out,
      background-color 150ms ease-out,
      border-color 150ms ease-out,
      color 150ms ease-out;
  }

  .goon-dock-tab-trigger:hover,
  .goon-dock-tab-trigger:focus-visible,
  .artifact-panel-close-tab-trigger:hover,
  .artifact-panel-close-tab-trigger:focus-visible {
    background: var(--bs-app-inset-surface-hover);
    color: var(--bs-app-title);
    outline: none;
  }

  .goon-dock-tab-trigger:focus-visible,
  .artifact-panel-close-tab-trigger:focus-visible {
    border-color: var(--bs-app-primary-soft);
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
  }

  :global(.goon-dock-tab-icon),
  :global(.artifact-panel-close-tab-icon) {
    width: 16px;
    height: 16px;
  }

  :global(body.goon-immersive .chat-input-shell) {
    background: transparent;
    border-right: 0;
    border-top: 0;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>

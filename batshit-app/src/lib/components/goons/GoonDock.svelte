<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Slider } from '$lib/components/ui/slider'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import {
    Maximize2,
    Camera,
    Eye,
    Edit,
    House,
    MonitorUp,
    RotateCcw,
    Settings2,
    Sparkles
  } from '@lucide/svelte'
  import type {
    GoonRecord,
    GoonCompatibilityReport,
    GoonCueDefinition,
    GoonCamera,
    GoonCameraMode,
    GoonSceneDefinition,
    GoonFileRef,
    GoonClosetAssignment,
    GoonClosetOriginalSource,
    GoonGuidedOutfitPiece,
    GoonWardrobeOutfit,
    GoonsSettings
  } from '$lib/types/goons'
  import type {
    GoonEngine,
    GoonEngineQuality,
    GoonMountedRuntimeState,
    GoonRendererRuntime
  } from '$lib/goons/engine'
  import type { GoonFramingPreset } from '$lib/goons/cameraNavigation'
  import type { GoonClosetItem } from '$lib/types/goons'
  import {
    filterGoonAnimationFilesForLane,
    resolveGoonAnimationName
  } from '$lib/goons/animationLoadPlan'
  import {
    hasRenderableGoonAvatar,
    isGuidedCustomVrmGoon,
    resolveGoonEyeContactMode,
    resolveGoonEyeContactTuning,
    resolveGoonKind
  } from '$lib/goons/customAvatar'
  import { buildGuidedPieceOriginalClosetSlot } from '$lib/goons/concealRegions'
  import {
    buildGuidedOutfitPieceStates,
    listStandaloneGuidedOutfitPieces,
    resolveGuidedOutfitManagedSlotName,
    resolveGuidedOutfitPieceVisible
  } from '$lib/goons/guidedOutfits'
  import {
    ALL_ORIGINAL_WARDROBE_OUTFIT_ID,
    NO_WARDROBE_OUTFIT_ID,
    cloneWardrobeGuidedPieceStates,
    cloneWardrobeOutfitAssignments,
    sanitizeWardrobeOutfits
  } from '$lib/goons/wardrobeOutfits'
  import { countPaintedConcealTriangles } from '$lib/goons/paintedConcealMasks'
  import { applyGoonSceneDefinition, buildGoonSceneSignature } from '$lib/goons/stageScene'
  import { getPostureLabel, resolveStagePostures } from '$lib/goons/postures'
  import {
    estimateCueTimingFraction,
    estimateCueTimingMsFromAlignment,
    usesAnalyzerOwnedCueProgress
  } from '$lib/goons/cueTiming'
  import { applyClosetSelectionChange } from '$lib/goons/closetAssignments'
  import { parseGoonCues, parseLiveKitNaturalGoonCues } from '$lib/goons/cueParser'
  import { resolveGoonCues, resolvePreviewAnimationDefinition } from '$lib/goons/resolve'
  import { logClientEvent } from '$lib/services/clientTelemetry'
  import {
    buildClosetSlotNames,
    getDefaultClosetSlotLabel,
    isSkinOverlayClosetSlotKey
  } from '$lib/goons/closetMaterials'
  import {
    applyMountedLiveGoonClosetAssignments,
    buildMountedLiveGoonAnimationPlan,
    buildMountedLiveGoonAnimationSignature,
    buildMountedLiveGoonBaseLoopSignature,
    buildMountedLiveGoonClosetSignature,
    buildMountedLiveGoonLoadPlan,
    loadMountedLiveGoon,
    resolveMountedLiveGoonScene
  } from '$lib/goons/mountedLiveGoon'
  import { voiceService } from '$lib/services/voice'
  import { updateGoon as updateGoonRecord } from '$lib/services/goons'
  import { getGoons } from '$lib/stores/goons.svelte'
  import { getUserSettings, setUserSettings } from '$lib/stores/userSettings.svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { toast } from 'svelte-sonner'
  import type { GoonLipSyncMode, GoonLipSyncPremiumAnalyzerId } from '$lib/types/voice'
  import type { VoiceRealtimeTtsAlignmentSegment } from '$lib/types/voiceRealtime'
  import type {
    GoonLipSyncAnalyzerId,
    GoonLipSyncPlaybackMetrics,
    GoonLipSyncTimeline
  } from '$lib/utils/goonLipSync'
  import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'
  import {
    GoonLiveActivationGate,
    type GoonLiveActivationTicket
  } from '$lib/goons/liveActivation'
  import {
    isGoonRuntimeReady,
    isMountedRecipeLiveGoon,
    resolveGoonLiveActivationKey
  } from '$lib/goons/recipe'
  import {
    DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER,
    PREMIUM_GOON_LIP_SYNC_ANALYZER_OPTIONS
  } from '$lib/goons/lipSyncLab'

  const LIVEKIT_TRANSCRIPTION_CUE_DEDUPE_MS = 30_000

  type PendingGoonCueSchedule = {
    cues: ReturnType<typeof parseGoonCues>
    content: string
    alignmentSegments?: VoiceRealtimeTtsAlignmentSegment[]
    playbackStartedAtMs?: number
    scheduledCueKeys: Set<string>
    firedCueKeys: Set<string>
  }
  type CueTimer = ReturnType<typeof setTimeout>

  let {
    open = $bindable(false),
    goon = null,
    speakerName = 'No speaker',
    activeSpeakerId = null,
    isSpeaking = false,
    sharedAnimations = [],
    quality = 'auto',
    lipSyncEnabled = true,
    lipSyncMode = 'amplitude',
    premiumLipSyncAnalyzer = DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER,
    lipSyncLabEnabled = false,
    goonsSettings = null,
    immersiveMode = false,
    immersiveStage = null,
    desktopModeAvailable = false,
    desktopModeBusy = false,
    desktopModeUnavailableReason = null,
    handoffMountedState = null,
    onImmersiveChange = (_value: boolean) => {},
    onDesktopModeChange = () => {},
    onQualityChange = (_value: GoonEngineQuality) => {},
    onLipSyncChange = (_value: boolean) => {},
    onCompatibilityReport = (_report: GoonCompatibilityReport) => {},
    onCameraChange = (_camera: GoonCamera) => {},
    onHandoffMountedStateConsumed = (_state: GoonMountedRuntimeState) => {}
  } = $props<{
    open?: boolean
    goon?: GoonRecord | null
    speakerName?: string
    activeSpeakerId?: string | null
    isSpeaking?: boolean
    sharedAnimations?: GoonFileRef[]
    quality?: GoonEngineQuality
    lipSyncEnabled?: boolean
    lipSyncMode?: GoonLipSyncMode
    premiumLipSyncAnalyzer?: GoonLipSyncPremiumAnalyzerId
    lipSyncLabEnabled?: boolean
    goonsSettings?: GoonsSettings | null
    immersiveMode?: boolean
    immersiveStage?: { left: number; top: number; width: number; height: number } | null
    desktopModeAvailable?: boolean
    desktopModeBusy?: boolean
    desktopModeUnavailableReason?: string | null
    handoffMountedState?: GoonMountedRuntimeState | null
    onImmersiveChange?: (value: boolean) => void
    onDesktopModeChange?: () => void
    onQualityChange?: (value: GoonEngineQuality) => void
    onLipSyncChange?: (value: boolean) => void
    onCompatibilityReport?: (report: GoonCompatibilityReport) => void
    onCameraChange?: (camera: GoonCamera) => void
    onHandoffMountedStateConsumed?: (state: GoonMountedRuntimeState) => void
  }>()

  const goons = $derived(getGoons())
  const readyGoons = $derived.by(() => goons.filter(isGoonRuntimeReady))
  const dockAgent = $derived.by(() =>
    activeSpeakerId ? agentStore.getAgentById(activeSpeakerId) : agentStore.getCurrentAgent()
  )

  let viewportWrapperEl: HTMLDivElement | null = $state(null)
  let primaryViewportEl: HTMLDivElement | null = $state(null)
  let secondaryViewportEl: HTMLDivElement | null = $state(null)
  let goonMenuOpen = $state(false)
  let engine = $state<GoonEngine | null>(null)
  let swapEngine = $state<GoonEngine | null>(null)
  const loadingEngines = new Set<GoonEngine>()
  let activeSlot = $state<0 | 1>(0)
  let swapFromSlot = $state<0 | 1>(0)
  let swapToSlot = $state<0 | 1>(1)
  let swapReady = $state(false)
  let currentGoonId = $state<string | null>(null)
  let failedLiveActivationKey = $state('')
  let liveActivationRetryVersion = $state(0)
  let liveActivationGate = new GoonLiveActivationGate()
  let animationSignature = $state('')
  let swapActive = $state(false)
  let swapToken = 0
  let handoffMountedStateInFlight: GoonMountedRuntimeState | null = null
  let consumedHandoffMountedState: GoonMountedRuntimeState | null = null
  let isDocumentHidden = $state(false)
  let viewportVisible = $state(true)
  let cueTimersByMessage = new Map<string, Set<CueTimer>>()
  let pendingCues = new Map<string, PendingGoonCueSchedule>()
  let pendingAudio = new Map<string, HTMLAudioElement>()
  let recentLiveKitTranscriptionCueKeys = new Map<string, number>()
  let voicePlaying = $state(false)
  let voicePausedForCue = $state(false)
  let voicePauseCueTimer: ReturnType<typeof setTimeout> | null = null
  let perfHint = $state(false)
  let lastFps = $state<number | null>(null)
  let lowFpsStreak = 0
  let autoLowStreak = 0
  let autoHighStreak = 0
  let autoQuality = $state<'low' | 'high' | 'ultra'>('high')
  let eyeContactEnabled = $state(true)
  let cameraTouched = $state(false)
  const mountedRendererReadyForDesktop = $derived(
    Boolean(engine && currentGoonId && !swapActive)
  )
  let dockRect = $state<{ left: number; top: number; width: number; height: number } | null>(null)
  let dockObserver: ResizeObserver | null = null
  let dockAnimationName = $state('')
  let dockAnimationCatalog = $state<Array<{ name: string; source: 'vrm' | 'goon' | 'vrma' }>>([])
  let dockPreviewActive = $state(false)
  let dockPreviewRestore = $state<{ name: string; definition?: GoonCueDefinition | null } | null>(null)
  let dockPreviewTimer: ReturnType<typeof setTimeout> | null = null
  let dockPreviewStatusTimer: ReturnType<typeof setInterval> | null = null
  let dockPreviewStatusKind = $state<'motion' | 'emote' | null>(null)
  let dockPreviewStatusRemainingMs = $state(0)
  let dockSaveStatusMessage = $state('')
  let dockSaveStatusTimer: ReturnType<typeof setTimeout> | null = null
  let dockMaterialNames = $state<string[]>([])
  let runtimeStatus = $state<GoonRendererRuntime | null>(null)
  let runtimeError = $state<string | null>(null)
  let lipSyncLabOpen = $state(false)
  let lipSyncLabMode = $state<GoonLipSyncMode>('amplitude')
  let lipSyncLabAnalyzer = $state<GoonLipSyncPremiumAnalyzerId>(
    DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER
  )
  let lipSyncLabSaving = $state(false)
  let lipSyncLabError = $state<string | null>(null)
  let lipSyncLabLastMetrics = $state<GoonLipSyncPlaybackMetrics | null>(null)
  let lipSyncLabHistory = $state<GoonLipSyncPlaybackMetrics[]>([])
  let externalPauseSources = $state<Record<string, true>>({})
  const externallyPaused = $derived.by(() => Object.keys(externalPauseSources).length > 0)
  const DOCK_PREVIEW_MAX_MS = 10000
  const showLipSyncLab = $derived(Boolean(lipSyncLabEnabled))
  type DockMotionOption = {
    name: string
    label: string
    source: 'vrm' | 'goon' | 'vrma'
    posture: string
    postureLabel: string
    tags: string[]
  }
  type DockMotionGroup = {
    id: string
    label: string
    motions: DockMotionOption[]
  }

  const resolvedCues = $derived.by(() => resolveGoonCues(goon, goonsSettings))
  const cueMap = $derived(resolvedCues.cueMap)
  const emojiMap = $derived(resolvedCues.emojiMap)
  const currentEyeContactMode = $derived.by(() => resolveGoonEyeContactMode(goon, goonsSettings))
  const currentEyeContactTuning = $derived.by(() => resolveGoonEyeContactTuning(goon, goonsSettings))
  const currentSocketEyeContact = $derived(goon?.defaults?.socketEyeContact ?? null)

  $effect(() => {
    if (showLipSyncLab) return
    lipSyncLabOpen = false
  })
  const dockMoodOptions = $derived.by(() =>
    Object.values(cueMap)
      .filter((cue) => cue.kind === 'mood')
      .sort((a, b) => a.name.localeCompare(b.name))
  )
  const dockEmoteOptions = $derived.by(() =>
    Object.values(cueMap)
      .filter((cue) => cue.kind === 'emote')
      .sort((a, b) => a.name.localeCompare(b.name))
  )
  const dockSceneOptions = $derived.by(() =>
    (Object.values(goonsSettings?.kitchen?.scenes ?? {}) as GoonSceneDefinition[]).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  )
  const stagePostures = $derived.by(() => resolveStagePostures(goonsSettings))
  const dockClosetItems = $derived.by(() => {
    const localItems = (Object.values(goon?.closet?.items ?? {}) as GoonClosetItem[]).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    const globalItems = (Object.values(goonsSettings?.globalCloset?.items ?? {}) as GoonClosetItem[]).sort(
      (a, b) => a.name.localeCompare(b.name)
    )
    return [...localItems, ...globalItems]
  })
  const dockClosetItemsById = $derived.by(() => new Map(dockClosetItems.map((item) => [item.id, item])))
  const dockWardrobeOutfits = $derived.by<Record<string, GoonWardrobeOutfit>>(() =>
    sanitizeWardrobeOutfits(goon?.closet?.outfits ?? {}, {
      resolveItem: (itemId) => resolveClosetItem(goon, itemId)
    })
  )
  const dockWardrobeOutfitList = $derived.by(() =>
    Object.values(dockWardrobeOutfits).sort((a, b) => a.name.localeCompare(b.name))
  )
  const dockClosetSlotNames = $derived.by(() => buildDockClosetSlotNames(goon))
  const dockStandaloneGuidedOutfitPieces = $derived.by(() =>
    listStandaloneGuidedOutfitPieces(
      goon?.guidedAvatar?.outfitPieces ?? [],
      dockClosetSlotNames
    ).sort((a, b) => resolveDockGuidedPieceLabel(a).localeCompare(resolveDockGuidedPieceLabel(b)))
  )
  const dockClosetAvailable = $derived.by(
    () => dockClosetSlotNames.length > 0 || dockStandaloneGuidedOutfitPieces.length > 0
  )
  const dockClosetQuickAccessAvailable = $derived.by(
    () => dockClosetAvailable || dockWardrobeOutfitList.length > 0
  )
  const resolvedQuality = $derived(quality === 'auto' ? autoQuality : quality)
  const immersiveActive = $derived.by(() =>
    Boolean(open && immersiveMode && immersiveStage && immersiveStage.width && immersiveStage.height)
  )
  const immersiveLayerStyle = $derived.by(() => {
    if (!immersiveActive || !immersiveStage) return ''
    return `left: ${immersiveStage.left}px; top: ${immersiveStage.top}px; width: ${immersiveStage.width}px; height: ${immersiveStage.height}px;`
  })
  const dockAnimationNames = $derived.by(() => {
    const names = new Set<string>()
    for (const entry of dockAnimationCatalog) {
      if (entry?.name) names.add(entry.name)
    }
    for (const file of collectDockAnimationFilesForLane(goon)) {
      const name = resolveAnimationName(file)
      if (name) names.add(name)
    }
    return Array.from(names).sort()
  })
  const dockMotionOptions = $derived.by(() => buildDockMotionOptions())
  const dockMotionPostureGroups = $derived.by(() => buildDockMotionPostureGroups())
  const dockMotionTagGroups = $derived.by(() => buildDockMotionTagGroups())
  const dockMotionUntaggedOptions = $derived.by(() =>
    dockMotionOptions.filter((motion) => motion.tags.length === 0)
  )
  const dockPreviewCountdownLabel = $derived.by(() => {
    if (!dockPreviewStatusKind || dockPreviewStatusRemainingMs <= 0) return ''
    return `${Math.max(1, Math.ceil(dockPreviewStatusRemainingMs / 1000))}s`
  })
  const dockPreviewCountdownTitle = $derived.by(() => {
    if (!dockPreviewStatusKind || dockPreviewStatusRemainingMs <= 0) return ''
    const seconds = Math.max(1, Math.ceil(dockPreviewStatusRemainingMs / 1000))
    return dockPreviewStatusKind === 'motion'
      ? `Motion preview resets in ${seconds}s`
      : `Emote preview ends in ${seconds}s`
  })
  const primaryVisible = $derived.by(() => {
    if (!swapActive) return activeSlot === 0
    if (!swapReady) return swapFromSlot === 0
    return swapToSlot === 0
  })
  const secondaryVisible = $derived.by(() => {
    if (!swapActive) return activeSlot === 1
    if (!swapReady) return swapFromSlot === 1
    return swapToSlot === 1
  })

  const qualityOptions: Array<{ value: GoonEngineQuality; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'ultra', label: 'Ultra' }
  ]
  const DEFAULT_VIEW_FOV = 50
  const MIN_VIEW_FOV = 15
  const MAX_VIEW_FOV = 100
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  let GoonEngineCtor: typeof import('$lib/goons/engine').GoonEngine | null = null
  let lastBaseLoopSignature = ''
  let lastSceneSignature = ''
  let lastClosetSignature = ''
  let lastAppearanceDialsSignature = ''
  let lastFacialArtworkSignature = ''
  let lastEyeAppearanceSignature = ''
  let lastOralAppearanceSignature = ''
  let skyboxPitchOffset = $state(0)
  let viewFov = $state(DEFAULT_VIEW_FOV)
  let cameraMode = $state<GoonCameraMode>('free')

  function handleSkyboxOffsetChange(value: number | number[]) {
    if (Array.isArray(value)) {
      skyboxPitchOffset = value[0] ?? skyboxPitchOffset
    } else if (typeof value === 'number') {
      skyboxPitchOffset = value
    }
  }

  function handleFovChange(value: number | number[]) {
    if (Array.isArray(value)) {
      viewFov = value[0] ?? viewFov
    } else if (typeof value === 'number') {
      viewFov = value
    }
    applyViewFov()
  }

  function applyViewFov() {
    engine?.setCameraFov(viewFov)
    swapEngine?.setCameraFov(viewFov)
  }

  function clampViewFov(value: number) {
    return Math.max(MIN_VIEW_FOV, Math.min(MAX_VIEW_FOV, value))
  }

  function adjustViewFovByScrollDelta(rawDelta: number) {
    const direction = Math.sign(rawDelta)
    if (!direction) return
    viewFov = clampViewFov(viewFov + direction * 2)
    applyViewFov()
  }

  function handleViewportFovWheel(event: WheelEvent) {
    if (!event.shiftKey || event.metaKey || event.altKey || event.ctrlKey) return
    const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!rawDelta) return
    adjustViewFovByScrollDelta(rawDelta)
    event.preventDefault()
    event.stopPropagation()
  }

  async function getGoonEngineCtor() {
    if (GoonEngineCtor) return GoonEngineCtor
    const module = await import('$lib/goons/engine')
    GoonEngineCtor = module.GoonEngine
    return GoonEngineCtor
  }

  export function captureMountedRuntimeState(): GoonMountedRuntimeState | null {
    return engine?.captureMountedRuntimeState() ?? null
  }

  export function isMountedRendererReady(): boolean {
    return mountedRendererReadyForDesktop
  }

  export function releaseMountedRenderer(): GoonMountedRuntimeState | null {
    if (!mountedRendererReadyForDesktop) return null
    const mountedState = captureMountedRuntimeState()
    swapToken += 1
    liveActivationGate = new GoonLiveActivationGate()
    handoffMountedStateInFlight = null
    failedLiveActivationKey = ''
    swapActive = false
    swapReady = false
    currentGoonId = null
    clearCueTimers()
    clearVoicePauseCueTimer()
    clearDockPreviewTimer()
    clearDockPreviewStatus()
    clearDockSaveStatusTimer()
    dockSaveStatusMessage = ''
    dockPreviewActive = false
    dockPreviewRestore = null

    const ownedEngines = new Set<GoonEngine>()
    if (engine) ownedEngines.add(engine)
    if (swapEngine) ownedEngines.add(swapEngine)
    for (const loadingEngine of loadingEngines) ownedEngines.add(loadingEngine)
    engine = null
    swapEngine = null
    loadingEngines.clear()
    for (const ownedEngine of ownedEngines) {
      ownedEngine.dispose()
    }

    return mountedState
  }

  function claimHandoffMountedState() {
    if (!handoffMountedState) return null
    if (handoffMountedState === consumedHandoffMountedState) return null
    if (handoffMountedStateInFlight) return null
    handoffMountedStateInFlight = handoffMountedState
    return handoffMountedState
  }

  function releaseHandoffMountedStateClaim(state: GoonMountedRuntimeState | null) {
    if (state && handoffMountedStateInFlight === state) {
      handoffMountedStateInFlight = null
    }
  }

  function consumeHandoffMountedState(state: GoonMountedRuntimeState | null) {
    if (!state || handoffMountedStateInFlight !== state) return
    consumedHandoffMountedState = state
    handoffMountedStateInFlight = null
    try {
      onHandoffMountedStateConsumed(state)
    } catch (error) {
      console.error('[GoonDock] Mounted renderer handoff callback failed:', error)
    }
  }

  function disposeLoadingEngine(loadingEngine: GoonEngine) {
    if (!loadingEngines.delete(loadingEngine)) return
    loadingEngine.dispose()
  }

  function handleDockCameraChange(camera: GoonCamera) {
    cameraTouched = true
    onCameraChange(camera)
  }

  function handleCameraModeChange(mode: GoonCameraMode) {
    const targetEngine = engine
    if (!targetEngine?.setCameraMode(mode)) return
    cameraMode = mode
    swapEngine?.setCameraMode(mode)
    const camera = targetEngine.getCameraState()
    if (camera) handleDockCameraChange(camera)
  }

  function handleDockFramePreset(preset: GoonFramingPreset) {
    if (!engine?.frameAvatar(preset)) return
    const camera = engine.getCameraState()
    if (camera) {
      handleDockCameraChange(camera)
    }
  }

  function handleRuntimeStatus(status: GoonRendererRuntime) {
    runtimeStatus = status
    logClientEvent({
      kind: 'goon-renderer-runtime',
      scope: 'goons',
      details: {
        surface: 'dock',
        backend: status.backend,
        label: status.label,
        navigatorGpuAvailable: status.environment?.navigatorGpuAvailable ?? null,
        embeddedWebKitRuntime: status.environment?.embeddedWebKitRuntime ?? null
      }
    })
  }

  function resolveRuntimeBadge(status: GoonRendererRuntime | null) {
    if (!status) return null
    return status.label || 'Renderer'
  }

  function toGoonRuntimeError(error: unknown) {
    if (error instanceof Error && error.message) return error.message
    return 'Goon rendering is unavailable in this browser.'
  }
  let viewportObserver: IntersectionObserver | null = null

  function handleVisibilityChange() {
    if (typeof document === 'undefined') return
    isDocumentHidden = document.hidden
  }

  // Preview and catalog helpers still need an eagerly filtered per-avatar lane;
  // mounted loading performs the same filter inside its shared load planner.
  function collectDockAnimationFilesForLane(targetGoon?: GoonRecord | null) {
    const lane = resolveGoonKind(targetGoon) === 'custom' ? 'glb' : 'vrm'
    return filterGoonAnimationFilesForLane(collectDockAnimationFiles(), lane)
  }

  function buildAnimationLoadPlan(targetGoon?: GoonRecord | null) {
    return buildMountedLiveGoonAnimationPlan(
      targetGoon,
      collectDockAnimationFiles(),
      goonsSettings
    )
  }

  function buildAnimationSignature(plan: { eager: GoonFileRef[]; deferred: GoonFileRef[] }) {
    return buildMountedLiveGoonAnimationSignature(plan)
  }

  function resolveAnimationName(file: GoonFileRef) {
    return resolveGoonAnimationName(file, 'animation')
  }

  function collectDockAnimationFiles() {
    const files: GoonFileRef[] = []
    const seen = new Set<string>()
    const addFile = (file?: GoonFileRef | null) => {
      if (!file) return
      const key = file.url || file.filename
      if (!key || seen.has(key)) return
      seen.add(key)
      files.push(file)
    }
    for (const file of Array.isArray(sharedAnimations) ? sharedAnimations : []) {
      addFile(file)
    }
    for (const entry of goons) {
      for (const file of Array.isArray(entry.files?.animations) ? entry.files?.animations ?? [] : []) {
        addFile(file)
      }
    }
    return files
  }

  function normalizeDockMotionTags(tags: string[] = []) {
    return Array.from(
      new Set(
        tags
          .map((tag) => tag.trim())
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right))
  }

  function resolveDockMotionLabel(file: GoonFileRef | null | undefined, animationName: string) {
    return file?.displayName?.trim() || animationName
  }

  function resolveDockMotionPostureLabel(posture: string) {
    return posture ? getPostureLabel(posture, goonsSettings, stagePostures) : 'Any Posture'
  }

  function buildDockMotionOptions(): DockMotionOption[] {
    const fileByAnimationName = new Map<string, GoonFileRef>()
    for (const file of collectDockAnimationFilesForLane(goon)) {
      const name = resolveAnimationName(file)
      if (name && !fileByAnimationName.has(name)) {
        fileByAnimationName.set(name, file)
      }
    }

    const catalogSourceByName = new Map(dockAnimationCatalog.map((entry) => [entry.name, entry.source]))
    return dockAnimationNames
      .map((name) => {
        const file = fileByAnimationName.get(name)
        const source = catalogSourceByName.get(name) ?? (file ? 'vrma' : 'goon')
        const savedPosture = file?.motionMeta?.posture ?? ''
        const posture = savedPosture && stagePostures[savedPosture] ? savedPosture : ''
        return {
          name,
          label: resolveDockMotionLabel(file, name),
          source,
          posture,
          postureLabel: resolveDockMotionPostureLabel(posture),
          tags: normalizeDockMotionTags(file?.tags ?? [])
        } satisfies DockMotionOption
      })
      .sort((left, right) => left.label.localeCompare(right.label))
  }

  function buildDockMotionPostureGroups(): DockMotionGroup[] {
    const groups = new Map<string, DockMotionGroup>()
    const ensureGroup = (id: string, label: string) => {
      const existing = groups.get(id)
      if (existing) return existing
      const next = { id, label, motions: [] }
      groups.set(id, next)
      return next
    }

    ensureGroup('__any_posture__', 'Any Posture')
    for (const posture of Object.values(stagePostures)) {
      ensureGroup(posture.id, posture.name)
    }
    for (const motion of dockMotionOptions) {
      ensureGroup(motion.posture || '__any_posture__', motion.postureLabel).motions.push(motion)
    }

    return Array.from(groups.values())
      .filter((group) => group.motions.length > 0)
      .sort((left, right) => {
        if (left.id === '__any_posture__') return -1
        if (right.id === '__any_posture__') return 1
        return left.label.localeCompare(right.label)
      })
  }

  function buildDockMotionTagGroups(): DockMotionGroup[] {
    const groups = new Map<string, DockMotionGroup>()
    for (const motion of dockMotionOptions) {
      for (const tag of motion.tags) {
        const existing = groups.get(tag) ?? { id: tag, label: tag, motions: [] }
        existing.motions.push(motion)
        groups.set(tag, existing)
      }
    }
    return Array.from(groups.values()).sort((left, right) => left.label.localeCompare(right.label))
  }

  function resolveDockPreviewDefinition(animationName: string) {
    return resolvePreviewAnimationDefinition(animationName, cueMap, collectDockAnimationFilesForLane(goon))
  }

  function getCurrentMoodLabel() {
    const baseLoop = goon?.defaults?.baseLoop
    return baseLoop ? cueMap[baseLoop]?.name ?? baseLoop : 'No mood'
  }

  function getCurrentSceneLabel() {
    const sceneId = goon?.defaults?.sceneId
    if (!sceneId) return 'No scene'
    return goonsSettings?.kitchen?.scenes?.[sceneId]?.name ?? 'No scene'
  }

  function buildAvailableClosetSlotNames(sourceNames: string[], assignmentNames: string[] = []) {
    const names = new Set<string>()
    for (const name of buildClosetSlotNames(sourceNames)) {
      names.add(name)
    }
    for (const name of sourceNames) {
      if (isSkinOverlayClosetSlotKey(name)) names.add(name)
    }
    for (const name of buildClosetSlotNames(assignmentNames)) {
      names.add(name)
    }
    for (const name of assignmentNames) {
      if (isSkinOverlayClosetSlotKey(name)) names.add(name)
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }

  function buildDockClosetSlotNames(targetGoon: GoonRecord | null | undefined = goon) {
    const guidedMaterialNames = (targetGoon?.guidedAvatar?.outfitPieces ?? []).flatMap(
      (piece) => piece.materialNames ?? []
    )
    return buildAvailableClosetSlotNames(
      [...dockMaterialNames, ...guidedMaterialNames],
      Object.keys(targetGoon?.closetAssignments ?? {})
    )
  }

  function getClosetSlotTypeLabel(slotName: string) {
    if (isSkinOverlayClosetSlotKey(slotName)) return 'Skin Overlay'
    const lower = slotName.toLowerCase()
    if (lower.includes('_tops_')) return 'Tops/Dresses'
    if (lower.includes('_bottoms_')) return 'Bottoms'
    if (lower.includes('_shoes_')) return 'Shoes'
    if (lower.includes('accessory_tie')) return 'Ties'
    if (lower.includes('_onepiece_')) return 'Body Suit'
    return 'Other'
  }

  function resolveDockClosetSlotNickname(slotName: string) {
    const assignment = goon?.closetAssignments?.[slotName]
    return assignment?.label?.trim() || getDefaultClosetSlotLabel(slotName)
  }

  function isDockWardrobeItemEdited(item?: GoonClosetItem | null) {
    if (!item) return false
    return Boolean(
      item.materialColors || countPaintedConcealTriangles(item.paintedConcealMask) > 0
    )
  }

  function getDockWardrobeItemDisplayName(item: GoonClosetItem) {
    if (item.originalSource && isDockWardrobeItemEdited(item)) {
      return `${item.name} (edited)`
    }
    return item.name
  }

  function resolveDockEditedOriginalItem(source: GoonClosetOriginalSource) {
    const item = resolveSavedOriginalClosetItem(goon, source)
    return item && isDockWardrobeItemEdited(item) ? item : null
  }

  function resolveDockEditedOriginalForSlot(slotName: string) {
    return resolveDockEditedOriginalItem({ kind: 'slot-original', slotName })
  }

  function resolveDockEditedOriginalForGuidedPiece(pieceId: string) {
    return resolveDockEditedOriginalItem({ kind: 'guided-piece-original', pieceId })
  }

  function buildDockClosetSlotWorkingAssignment(slotName: string): GoonClosetAssignment {
    const assignment = goon?.closetAssignments?.[slotName] ?? ({ mode: 'original' } satisfies GoonClosetAssignment)
    if (assignment.mode === 'original') {
      const editedOriginal = resolveDockEditedOriginalForSlot(slotName)
      if (editedOriginal) {
        return {
          mode: 'item',
          itemId: editedOriginal.id,
          label: assignment.label
        }
      }
    }
    return assignment
  }

  function getDockClosetSlotValue(slotName: string) {
    const assignment = buildDockClosetSlotWorkingAssignment(slotName)
    if (assignment.mode === 'item' && assignment.itemId) {
      return resolveClosetItem(goon, assignment.itemId)?.id ?? assignment.itemId
    }
    if (assignment.mode === 'none') return '__none__'
    return getDockGuidedSlotOriginalState(slotName) ? '__original__' : '__none__'
  }

  function getDockClosetSlotLabel(slotName: string) {
    const assignment = buildDockClosetSlotWorkingAssignment(slotName)
    if (!assignment || assignment.mode === 'original') {
      return getDockGuidedSlotOriginalState(slotName) ? 'Original' : 'None'
    }
    if (assignment.mode === 'none') return 'None'
    if (assignment.mode === 'item' && assignment.itemId) {
      const item = resolveClosetItem(goon, assignment.itemId) ?? dockClosetItemsById.get(assignment.itemId)
      return item ? getDockWardrobeItemDisplayName(item) : 'Custom'
    }
    return getDockGuidedSlotOriginalState(slotName) ? 'Original' : 'None'
  }

  function getDockClosetItemsForSlot(slotName: string): GoonClosetItem[] {
    const availableItems = dockClosetItems.filter((item) => {
      if (item.originalSource?.kind === 'guided-piece-original') return false
      if (item.originalSource?.kind === 'slot-original') {
        return item.originalSource.slotName === slotName
      }
      return true
    })
    const currentValue = getDockClosetSlotValue(slotName)
    const currentItem = currentValue && !currentValue.startsWith('__')
      ? resolveClosetItem(goon, currentValue) ?? dockClosetItemsById.get(currentValue)
      : null
    if (
      !currentItem ||
      availableItems.some((item) => item.id === currentItem.id || item.id === currentValue)
    ) {
      return availableItems
    }

    return [currentItem, ...availableItems].sort((left, right) => left.name.localeCompare(right.name))
  }

  function openGoonsSettings() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('batshit:open-settings', { detail: { tab: '3d-goons' } }))
  }

  function dispatchGoonsSettingsAction(type: 'batshit:goons-manage' | 'batshit:goons-create' | 'batshit:goons-edit', detail?: { goonId?: string }) {
    if (typeof window === 'undefined') return
    openGoonsSettings()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent(type, detail ? { detail } : undefined))
      })
    })
  }

  function handleManageGoons() {
    goonMenuOpen = false
    dispatchGoonsSettingsAction('batshit:goons-manage')
  }

  function handleCreateGoon() {
    goonMenuOpen = false
    dispatchGoonsSettingsAction('batshit:goons-create')
  }

  function handleEditGoon(event: Event, goonId: string) {
    event.stopPropagation()
    goonMenuOpen = false
    dispatchGoonsSettingsAction('batshit:goons-edit', { goonId })
  }

  function resolveDockEmotePreviewDuration(definition?: GoonCueDefinition | null) {
    if (definition?.steps?.length) {
      return definition.steps.reduce(
        (sum, step) =>
          sum +
          Math.max(0, step.attackMs ?? 120) +
          Math.max(0, step.holdMs ?? 200) +
          Math.max(0, step.releaseMs ?? 180),
        0
      )
    }

    const hasEnvelope =
      definition?.attackMs !== undefined ||
      definition?.holdMs !== undefined ||
      definition?.releaseMs !== undefined

    let expressionDurationMs = 0
    if (hasEnvelope) {
      const attackMs = Math.max(0, definition?.attackMs ?? 120)
      const releaseMs = Math.max(0, definition?.releaseMs ?? 180)
      const providedHold = definition?.holdMs
      const holdMs =
        typeof providedHold === 'number'
          ? Math.max(0, providedHold)
          : definition?.durationMs
            ? Math.max(0, definition.durationMs - attackMs - releaseMs)
            : 200
      expressionDurationMs = attackMs + holdMs + releaseMs
    } else {
      expressionDurationMs = Math.max(0, definition?.durationMs ?? 800)
    }

    return expressionDurationMs
  }

  function buildBaseLoopSignature(baseLoop: string, definition?: GoonCueDefinition) {
    return buildMountedLiveGoonBaseLoopSignature(baseLoop, definition)
  }

  function resolveSceneForGoon(targetGoon?: GoonRecord | null): GoonSceneDefinition | null {
    return resolveMountedLiveGoonScene(targetGoon, goonsSettings, 'saved')
  }

	  function resolveClosetItem(targetGoon: GoonRecord | null | undefined, itemId?: string | null): GoonClosetItem | null {
	    if (!itemId) return null
	    const localItem = targetGoon?.closet?.items?.[itemId]
	    if (localItem) return localItem
	    const globalItem = goonsSettings?.globalCloset?.items?.[itemId]
	    if (!globalItem) return null
	    return (
	      Object.values(targetGoon?.closet?.items ?? {}).find(
	        (item) => item.sourceItemId === globalItem.id && !item.originalSource
	      ) ?? globalItem
	    )
	  }

	  function originalSourceMatches(
	    source: GoonClosetItem['originalSource'] | null | undefined,
	    target: GoonClosetOriginalSource
	  ) {
	    if (!source || source.kind !== target.kind) return false
	    if (source.kind === 'slot-original' && target.kind === 'slot-original') {
	      return source.slotName === target.slotName
	    }
	    if (source.kind === 'guided-piece-original' && target.kind === 'guided-piece-original') {
	      return source.pieceId === target.pieceId
	    }
	    return false
	  }

	  function resolveSavedOriginalClosetItem(
	    targetGoon: GoonRecord | null | undefined,
	    source: GoonClosetOriginalSource
	  ) {
	    return (
	      Object.values(targetGoon?.closet?.items ?? {}).find((item) =>
	        originalSourceMatches(item.originalSource, source)
	      ) ?? null
	    )
	  }

  function resolveDockGuidedPieceLabel(piece: GoonGuidedOutfitPiece) {
    return piece.label?.trim() || 'Blender Outfit Slot'
  }

  function resolveDockGuidedManagedSlotName(
    piece: GoonGuidedOutfitPiece,
    targetGoon: GoonRecord | null | undefined = goon
  ) {
    return resolveGuidedOutfitManagedSlotName(piece, buildDockClosetSlotNames(targetGoon))
  }

  function resolveDockGuidedPiecesForSlot(
    slotName: string,
    targetGoon: GoonRecord | null | undefined = goon
  ): GoonGuidedOutfitPiece[] {
    return (targetGoon?.guidedAvatar?.outfitPieces ?? []).filter(
      (piece) =>
        piece.source !== 'duf-overlay' &&
        resolveDockGuidedManagedSlotName(piece, targetGoon) === slotName
    )
  }

  function resolveDockGuidedPieceVisible(
    piece: GoonGuidedOutfitPiece,
    targetGoon: GoonRecord | null | undefined = goon,
    assignments: Record<string, GoonClosetAssignment> = targetGoon?.closetAssignments ?? {}
  ) {
    return resolveGuidedOutfitPieceVisible(piece, {
      availableSlotNames: buildDockClosetSlotNames(targetGoon),
      pieceStates: targetGoon?.guidedAvatar?.pieceStates ?? {},
      assignments
    })
  }

  function getDockGuidedSlotOriginalState(slotName: string) {
    const pieces = resolveDockGuidedPiecesForSlot(slotName)
    if (pieces.length === 0) return true
    return pieces.every((piece) => resolveDockGuidedPieceVisible(piece))
  }

  function resolveDockGuidedPieceSelectedItem(piece: GoonGuidedOutfitPiece) {
    const assignment = goon?.closetAssignments?.[buildGuidedPieceOriginalClosetSlot(piece.id)]
    if (assignment?.mode !== 'item') return null
    const item = resolveClosetItem(goon, assignment.itemId)
    if (
      !item ||
      item.originalSource?.kind !== 'guided-piece-original' ||
      item.originalSource.pieceId !== piece.id
    ) {
      return null
    }
    return item
  }

  function getDockGuidedPieceValue(piece: GoonGuidedOutfitPiece) {
    const selectedItem = resolveDockGuidedPieceSelectedItem(piece)
    if (selectedItem) return selectedItem.id
    const editedOriginal = resolveDockEditedOriginalForGuidedPiece(piece.id)
    if (editedOriginal && resolveDockGuidedPieceVisible(piece)) return editedOriginal.id
    return resolveDockGuidedPieceVisible(piece) ? '__original__' : '__none__'
  }

  function getDockGuidedPieceSelectionLabel(piece: GoonGuidedOutfitPiece) {
    const value = getDockGuidedPieceValue(piece)
    if (value === '__none__') return 'None'
    if (value === '__original__') return 'Original'
    const item = resolveClosetItem(goon, value)
    return item ? getDockWardrobeItemDisplayName(item) : 'Edited Original'
  }

  function getDockGuidedPieceSavedItems(piece: GoonGuidedOutfitPiece) {
    return dockClosetItems
      .filter(
        (item) =>
          item.originalSource?.kind === 'guided-piece-original' &&
          item.originalSource.pieceId === piece.id
      )
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  function buildDockGuidedAvatarForAssignments(
    targetGoon: GoonRecord,
    nextAssignments: Record<string, GoonClosetAssignment>,
    options: {
      pieceStates?: Record<string, boolean>
      clearActivePreset?: boolean
    } = {}
  ): GoonRecord['guidedAvatar'] | undefined {
    if (!isGuidedCustomVrmGoon(targetGoon) || !targetGoon.guidedAvatar) return undefined
    const pieces = targetGoon.guidedAvatar.outfitPieces ?? []
    return {
      ...targetGoon.guidedAvatar,
      pieceStates: buildGuidedOutfitPieceStates(pieces, {
        availableSlotNames: buildDockClosetSlotNames(targetGoon),
        pieceStates: options.pieceStates ?? targetGoon.guidedAvatar.pieceStates ?? {},
        assignments: nextAssignments
      }),
      activePresetId: options.clearActivePreset
        ? null
        : targetGoon.guidedAvatar.activePresetId ?? null
    }
  }

  function buildDockWardrobeAssignmentKeys(targetGoon: GoonRecord | null | undefined = goon) {
    const keys = new Set<string>()
    for (const slotName of buildDockClosetSlotNames(targetGoon)) {
      keys.add(slotName)
    }
    const availableSlotNames = buildDockClosetSlotNames(targetGoon)
    for (const piece of listStandaloneGuidedOutfitPieces(
      targetGoon?.guidedAvatar?.outfitPieces ?? [],
      availableSlotNames
    )) {
      keys.add(buildGuidedPieceOriginalClosetSlot(piece.id))
    }
    return keys
  }

  function clearDockWardrobeOutfitDefault(targetGoon: GoonRecord) {
    const nextDefaults = { ...(targetGoon.defaults ?? {}) }
    delete (nextDefaults as Record<string, unknown>).closetOutfitId
    return nextDefaults
  }

  function buildDockBuiltInWardrobeOutfit(
    outfitId: string
  ): Pick<GoonWardrobeOutfit, 'assignments' | 'guidedPieceStates'> | null {
    if (!goon) return null
    if (
      outfitId !== ALL_ORIGINAL_WARDROBE_OUTFIT_ID &&
      outfitId !== NO_WARDROBE_OUTFIT_ID
    ) {
      return null
    }
    const mode = outfitId === NO_WARDROBE_OUTFIT_ID ? 'none' : 'original'
    const assignments: Record<string, GoonClosetAssignment> = {}
    for (const slotName of dockClosetSlotNames) {
      const label = goon.closetAssignments?.[slotName]?.label?.trim()
      assignments[slotName] = {
        mode,
        ...(label ? { label } : {})
      }
    }
    const guidedPieceStates = Object.fromEntries(
      dockStandaloneGuidedOutfitPieces.map((piece) => [
        piece.id,
        outfitId === ALL_ORIGINAL_WARDROBE_OUTFIT_ID
      ])
    )
    return { assignments, guidedPieceStates }
  }

  async function applyDockWardrobeOutfitState(
    outfit: Pick<GoonWardrobeOutfit, 'assignments' | 'guidedPieceStates'>,
    activeOutfitId: string | null
  ) {
    if (!goon) return
    if (dockPreviewActive) {
      clearDockPreview()
    }
    const outfitAssignments = cloneWardrobeOutfitAssignments(outfit.assignments)
    const nextAssignments = { ...(goon.closetAssignments ?? {}) }
    for (const key of buildDockWardrobeAssignmentKeys(goon)) {
      delete nextAssignments[key]
    }
    for (const [slotName, assignment] of Object.entries(outfitAssignments)) {
      if (assignment.mode === 'item' && !resolveClosetItem(goon, assignment.itemId)) {
        nextAssignments[slotName] = {
          mode: 'original',
          ...(assignment.label?.trim() ? { label: assignment.label.trim() } : {})
        }
        continue
      }
      if (assignment.mode === 'original' && !assignment.label) {
        continue
      }
      nextAssignments[slotName] = assignment
    }

    const guidedAvatar = buildDockGuidedAvatarForAssignments(goon, nextAssignments, {
      pieceStates: {
        ...(goon.guidedAvatar?.pieceStates ?? {}),
        ...cloneWardrobeGuidedPieceStates(outfit.guidedPieceStates)
      },
      clearActivePreset: true
    })
    const nextDefaults = clearDockWardrobeOutfitDefault(goon)
    if (activeOutfitId && dockWardrobeOutfits[activeOutfitId]) {
      nextDefaults.closetOutfitId = activeOutfitId
    }
    const patch: Partial<GoonRecord> = {
      closetAssignments: nextAssignments,
      defaults: nextDefaults
    }
    if (guidedAvatar) {
      patch.guidedAvatar = guidedAvatar
    }

    try {
      await updateGoonRecord(goon.id, patch)
      showDockSaveStatus('Outfit Applied ✓')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to apply Outfit')
    }
  }

  async function applyDockBuiltInWardrobeOutfit(outfitId: string) {
    const outfit = buildDockBuiltInWardrobeOutfit(outfitId)
    if (!outfit) return
    await applyDockWardrobeOutfitState(outfit, outfitId)
  }

  async function applyDockSavedWardrobeOutfit(outfitId: string) {
    const outfit = dockWardrobeOutfits[outfitId]
    if (!outfit) return
    await applyDockWardrobeOutfitState(outfit, outfit.id)
  }

  function buildClosetRuntimeSignature(targetGoon: GoonRecord) {
    return buildMountedLiveGoonClosetSignature(targetGoon, goonsSettings)
  }

  async function applyClosetAssignments(targetEngine: GoonEngine, targetGoon: GoonRecord) {
    await applyMountedLiveGoonClosetAssignments(targetEngine, {
      goon: targetGoon,
      goonsSettings: goonsSettings ?? null
    })
  }

  async function loadGoonWithTransition(
    nextGoon: GoonRecord,
    activation: GoonLiveActivationTicket
  ) {
    if (!hasRenderableGoonAvatar(nextGoon)) return
    const activationKey = activation.key
    const token = ++swapToken
    const replacingSameGoon = currentGoonId === nextGoon.id && Boolean(engine)
    const claimedHandoffMountedState = claimHandoffMountedState()
    const mountedState =
      claimedHandoffMountedState ??
      (replacingSameGoon ? engine?.captureMountedRuntimeState() ?? null : null)
    if (!replacingSameGoon) cameraTouched = false
    const incomingSlot = activeSlot === 0 ? 1 : 0
    swapFromSlot = activeSlot
    swapToSlot = incomingSlot
    swapReady = false
    swapActive = true

    const targetEl = incomingSlot === 0 ? primaryViewportEl : secondaryViewportEl
    if (!targetEl) {
      swapActive = false
      swapReady = false
      if (liveActivationGate.fail(activation)) {
        failedLiveActivationKey = activationKey
      }
      releaseHandoffMountedStateClaim(claimedHandoffMountedState)
      runtimeError = 'The Goon viewport is unavailable for Live activation.'
      return
    }

    let EngineCtor: Awaited<ReturnType<typeof getGoonEngineCtor>>
    try {
      EngineCtor = await getGoonEngineCtor()
    } catch (error) {
      runtimeError = toGoonRuntimeError(error)
      if (token === swapToken && liveActivationGate.fail(activation)) {
        swapActive = false
        swapReady = false
        failedLiveActivationKey = activationKey
      }
      releaseHandoffMountedStateClaim(claimedHandoffMountedState)
      return
    }

    if (swapEngine) {
      swapEngine.dispose()
      swapEngine = null
    }

    let incomingEngine: GoonEngine
    try {
      incomingEngine = new EngineCtor(targetEl, {
        quality: resolvedQuality,
        lipSyncEnabled,
        eyeContactMode: resolveGoonEyeContactMode(nextGoon, goonsSettings),
        eyeContactTuning: resolveGoonEyeContactTuning(nextGoon, goonsSettings),
        onRuntimeStatus: (status) => handleRuntimeStatus(status),
        onCompatibility: (report) => onCompatibilityReport(report),
        onPerformance: (stats) => handlePerformance(stats),
        onCameraChange: (camera) => handleDockCameraChange(camera)
      })
      loadingEngines.add(incomingEngine)
    } catch (error) {
      runtimeError = toGoonRuntimeError(error)
      if (token === swapToken && liveActivationGate.fail(activation)) {
        swapActive = false
        swapReady = false
        failedLiveActivationKey = activationKey
      }
      releaseHandoffMountedStateClaim(claimedHandoffMountedState)
      return
    }
    let incomingSceneSignature = ''
    let incomingBaseLoopSignature = ''
    let incomingAnimationSignature = ''
    let incomingClosetSignature = ''
    let incomingAnimationCatalog: Array<{ name: string; source: 'vrm' | 'goon' | 'vrma' }> = []
    let incomingMaterialNames: string[] = []
    let incomingAppearanceDialsSignature = ''
    let incomingFacialArtworkSignature = ''
    let incomingEyeAppearanceSignature = ''
    let incomingOralAppearanceSignature = ''

    try {
      const loadPlan = buildMountedLiveGoonLoadPlan(nextGoon, {
        goonsSettings,
        animationFiles: collectDockAnimationFiles(),
        stagePostures,
        sceneMode: 'saved',
        initialFov: viewFov,
        mountedState
      })
      const loadResult = await loadMountedLiveGoon(incomingEngine, loadPlan)
      incomingSceneSignature = loadResult.sceneSignature
      incomingBaseLoopSignature = loadResult.baseLoopSignature
      incomingAnimationSignature = loadResult.animationSignature
      incomingClosetSignature = loadResult.closetSignature
      incomingAnimationCatalog = loadResult.animationCatalog
      incomingMaterialNames = loadResult.materialNames
      incomingAppearanceDialsSignature = loadResult.appearanceDialsSignature
      incomingFacialArtworkSignature = loadResult.facialArtworkSignature
      incomingEyeAppearanceSignature = loadResult.eyeAppearanceSignature
      incomingOralAppearanceSignature = loadResult.oralAppearanceSignature
      viewFov = loadResult.viewFov
      cameraMode = loadResult.cameraMode
      runtimeError = null
    } catch (error) {
      console.error('[GoonDock] Failed to load goon:', error)
      disposeLoadingEngine(incomingEngine)
      if (token === swapToken) {
        runtimeError = toGoonRuntimeError(error)
        swapActive = false
        swapReady = false
        if (liveActivationGate.fail(activation)) {
          failedLiveActivationKey = activationKey
        }
      }
      releaseHandoffMountedStateClaim(claimedHandoffMountedState)
      return
    }

    if (token !== swapToken) {
      disposeLoadingEngine(incomingEngine)
      releaseHandoffMountedStateClaim(claimedHandoffMountedState)
      return
    }
    if (!liveActivationGate.accept(activation)) {
      disposeLoadingEngine(incomingEngine)
      releaseHandoffMountedStateClaim(claimedHandoffMountedState)
      return
    }

    if (engine) {
      engine.setCompatibilityHandler(undefined)
      engine.setPerformanceHandler(undefined)
    }

    loadingEngines.delete(incomingEngine)
    swapEngine = engine
    engine = incomingEngine
    activeSlot = incomingSlot
    swapReady = true
    currentGoonId = nextGoon.id
    lastSceneSignature = incomingSceneSignature
    lastBaseLoopSignature = incomingBaseLoopSignature
    animationSignature = incomingAnimationSignature
    lastClosetSignature = incomingClosetSignature
    lastAppearanceDialsSignature = incomingAppearanceDialsSignature
    lastFacialArtworkSignature = incomingFacialArtworkSignature
    lastEyeAppearanceSignature = incomingEyeAppearanceSignature
    lastOralAppearanceSignature = incomingOralAppearanceSignature
    dockAnimationCatalog = incomingAnimationCatalog
    dockMaterialNames = incomingMaterialNames
    failedLiveActivationKey = ''
    consumeHandoffMountedState(claimedHandoffMountedState)
    if (!replacingSameGoon) {
      dockAnimationName = ''
      dockPreviewActive = false
      dockPreviewRestore = null
      clearDockPreviewTimer()
      clearDockPreviewStatus()
    }

    await wait(320)
    if (token !== swapToken) return
    swapActive = false
    swapReady = false
    swapEngine?.dispose()
    swapEngine = null
  }

  function retryFailedLiveActivation() {
    if (!goon) return
    const activationKey = resolveGoonLiveActivationKey(goon)
    if (!activationKey || activationKey !== failedLiveActivationKey) return
    if (!liveActivationGate.retry(activationKey)) return
    failedLiveActivationKey = ''
    liveActivationRetryVersion += 1
  }

  function trackCueTimer(messageId: string, timer: CueTimer) {
    const timers = cueTimersByMessage.get(messageId) ?? new Set<CueTimer>()
    timers.add(timer)
    cueTimersByMessage.set(messageId, timers)
  }

  function untrackCueTimer(messageId: string, timer: CueTimer) {
    const timers = cueTimersByMessage.get(messageId)
    if (!timers) return
    timers.delete(timer)
    if (timers.size === 0) {
      cueTimersByMessage.delete(messageId)
    }
  }

  function scheduleCueTimeout(messageId: string, callback: () => void, delay: number) {
    const timer = setTimeout(() => {
      untrackCueTimer(messageId, timer)
      callback()
    }, delay)
    trackCueTimer(messageId, timer)
  }

  function scheduleCueInterval(messageId: string, callback: () => void, delay: number) {
    const timer = setInterval(callback, delay) as CueTimer
    trackCueTimer(messageId, timer)
  }

  function clearCueTimers(messageId?: string | null) {
    if (messageId) {
      const timers = cueTimersByMessage.get(messageId)
      timers?.forEach((timer) => clearTimeout(timer))
      cueTimersByMessage.delete(messageId)
      return
    }

    cueTimersByMessage.forEach((timers) => {
      timers.forEach((timer) => clearTimeout(timer))
    })
    cueTimersByMessage.clear()
  }

  function clearVoicePauseCueTimer() {
    if (!voicePauseCueTimer) return
    clearTimeout(voicePauseCueTimer)
    voicePauseCueTimer = null
  }

  function pauseSpeechForCue(durationMs: number) {
    if (durationMs <= 0) return
    voiceService.pauseFor(durationMs)
    voicePausedForCue = true
    clearVoicePauseCueTimer()
    voicePauseCueTimer = setTimeout(() => {
      voicePausedForCue = false
      voicePauseCueTimer = null
    }, durationMs)
  }

  function triggerScheduledCue(cue: ReturnType<typeof parseGoonCues>[number]) {
    const def = cue.definition as GoonCueDefinition | undefined
    engine?.playCue(cue.name, def)
    if (cue.source === 'cue' && (def?.kind === 'mood' || def?.playback === 'loop')) {
      void persistDockCurrentMood(cue.name, { showStatus: true })
    }
    if (def?.blocking) {
      pauseSpeechForCue(def.durationMs ?? 800)
    }
  }

  function getCueScheduleKey(cue: ReturnType<typeof parseGoonCues>[number]) {
    return `${cue.source}:${cue.name}:${cue.index}:${cue.spanStart ?? ''}:${cue.spanEnd ?? ''}`
  }

  function getLiveKitTranscriptionCueKey(
    agentId: string | null | undefined,
    cue: ReturnType<typeof parseGoonCues>[number]
  ) {
    return `${agentId ?? activeSpeakerId ?? 'agent'}:${getCueScheduleKey(cue)}`
  }

  function pruneRecentLiveKitTranscriptionCues(now = Date.now()) {
    for (const [key, firedAt] of recentLiveKitTranscriptionCueKeys.entries()) {
      if (now - firedAt > LIVEKIT_TRANSCRIPTION_CUE_DEDUPE_MS) {
        recentLiveKitTranscriptionCueKeys.delete(key)
      }
    }
  }

  function filterLiveKitDuplicateCues(
    cues: ReturnType<typeof parseGoonCues>,
    agentId: string | null | undefined,
    source?: string
  ) {
    const now = Date.now()
    pruneRecentLiveKitTranscriptionCues(now)
    const filtered = cues.filter((cue) => {
      const key = getLiveKitTranscriptionCueKey(agentId, cue)
      return !recentLiveKitTranscriptionCueKeys.has(key)
    })
    if (source === 'livekit-transcription') {
      for (const cue of filtered) {
        recentLiveKitTranscriptionCueKeys.set(getLiveKitTranscriptionCueKey(agentId, cue), now)
      }
    }
    return filtered
  }

  function triggerScheduledCueForMessage(
    messageId: string,
    cue: ReturnType<typeof parseGoonCues>[number]
  ) {
    const schedule = pendingCues.get(messageId)
    schedule?.firedCueKeys.add(getCueScheduleKey(cue))
    triggerScheduledCue(cue)
  }

  function createPendingCueSchedule(
    cues: ReturnType<typeof parseGoonCues>,
    content: string
  ): PendingGoonCueSchedule {
    return {
      cues,
      content,
      scheduledCueKeys: new Set(),
      firedCueKeys: new Set()
    }
  }

  function scheduleAudioLedCuePlayback(
    messageId: string,
    cues: ReturnType<typeof parseGoonCues>,
    content: string,
    audio: HTMLAudioElement,
    analyzerId: Exclude<GoonLipSyncAnalyzerId, 'batshit-text-timing'>
  ) {
    const queue = cues
      .map((cue) => ({
        cue,
        fraction: estimateCueTimingFraction(content, cue, { analyzerId })
      }))
      .sort((a, b) => a.fraction - b.fraction)

    if (queue.length === 0) {
      pendingCues.delete(messageId)
      return
    }

    const tick = () => {
      const duration =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : null

      if (!duration) {
        if (audio.ended) {
          pendingCues.delete(messageId)
          clearCueTimers(messageId)
        }
        return
      }

      const progress =
        engine?.getAudioLedCueProgress() ?? Math.max(0, Math.min(1, (audio.currentTime * 1000) / duration))
      while (queue.length > 0 && progress >= queue[0].fraction) {
        const next = queue.shift()
        if (!next) break
        triggerScheduledCueForMessage(messageId, next.cue)
      }

      if (queue.length === 0 || audio.ended) {
        pendingCues.delete(messageId)
        clearCueTimers(messageId)
      }
    }

    scheduleCueInterval(messageId, tick, 40)
    tick()
  }

  function scheduleAlignmentLedCuePlayback(
    messageId: string,
    cues: ReturnType<typeof parseGoonCues>,
    content: string,
    alignmentSegments: VoiceRealtimeTtsAlignmentSegment[]
  ) {
    const schedule = pendingCues.get(messageId)
    if (!schedule || alignmentSegments.length === 0) return false

    const startedAtMs = schedule.playbackStartedAtMs ?? performance.now()
    schedule.playbackStartedAtMs = startedAtMs
    schedule.alignmentSegments = alignmentSegments

    let scheduledAny = false
    for (const cue of cues) {
      const cueKey = getCueScheduleKey(cue)
      if (schedule.firedCueKeys.has(cueKey) || schedule.scheduledCueKeys.has(cueKey)) continue

      const targetMs = estimateCueTimingMsFromAlignment(content, cue, alignmentSegments)
      if (targetMs === null) continue

      const elapsedMs = Math.max(0, performance.now() - startedAtMs)
      const delay = Math.max(0, Math.floor(targetMs - elapsedMs))
      schedule.scheduledCueKeys.add(cueKey)
      scheduledAny = true
      scheduleCueTimeout(messageId, () => {
        triggerScheduledCueForMessage(messageId, cue)
      }, delay)
    }

    return scheduledAny
  }

  function scheduleCuePlayback(
    messageId: string,
    cues: ReturnType<typeof parseGoonCues>,
    content: string,
    audio?: HTMLAudioElement,
    durationMs?: number | null,
    analyzerId?: GoonLipSyncAnalyzerId | null,
    alignmentSegments?: VoiceRealtimeTtsAlignmentSegment[] | null
  ) {
    if (!engine || cues.length === 0) return

    const aligned = alignmentSegments?.length
      ? scheduleAlignmentLedCuePlayback(messageId, cues, content, alignmentSegments)
      : false
    if (aligned) return

    clearCueTimers(messageId)
    if (audio && usesAnalyzerOwnedCueProgress(analyzerId)) {
      scheduleAudioLedCuePlayback(messageId, cues, content, audio, analyzerId)
      return
    }
    const duration =
      typeof durationMs === 'number' && durationMs > 0
        ? durationMs
        : audio && Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : null

    cues.forEach((cue, index) => {
      const schedule = pendingCues.get(messageId)
      const cueKey = getCueScheduleKey(cue)
      if (schedule?.firedCueKeys.has(cueKey) || schedule?.scheduledCueKeys.has(cueKey)) return
      const fraction = estimateCueTimingFraction(content, cue, {
        analyzerId:
          analyzerId && analyzerId !== 'batshit-text-timing' ? analyzerId : undefined
      })
      const delay = duration ? Math.max(0, Math.floor(duration * fraction)) : index * 650

      schedule?.scheduledCueKeys.add(cueKey)
      scheduleCueTimeout(messageId, () => {
        triggerScheduledCueForMessage(messageId, cue)
      }, delay)
    })
  }

  function handleGoonMessage(event: Event) {
    if (!open || !hasRenderableGoonAvatar(goon)) return
    const detail = (event as CustomEvent).detail as {
      messageId?: string
      agentId?: string | null
      content?: string
      speechPlanned?: boolean
      source?: string
    }

    if (!detail?.messageId || !detail.content) return
    if (activeSpeakerId && detail.agentId && detail.agentId !== activeSpeakerId) return

    const parsedCues = parseGoonCues(detail.content, emojiMap, cueMap)
    const liveKitNaturalCues =
      parsedCues.length === 0 && detail.source?.startsWith('livekit')
        ? parseLiveKitNaturalGoonCues(detail.content, cueMap)
        : []
    const allParsedCues = parsedCues.length > 0 ? parsedCues : liveKitNaturalCues
    const immediateCues = parsedCues.filter(
      (cue) => cue.source === 'cue' && (cue.definition?.kind === 'mood' || cue.definition?.playback === 'loop')
    )
    const deferredCues = filterLiveKitDuplicateCues(
      allParsedCues.filter((cue) => !immediateCues.includes(cue)),
      detail.agentId,
      detail.source
    )

    immediateCues.forEach((cue) => {
      engine?.playCue(cue.name, cue.definition)
      void persistDockCurrentMood(cue.name, { showStatus: true })
    })

    if (deferredCues.length === 0) {
      pendingCues.delete(detail.messageId)
      return
    }

    pendingCues.set(detail.messageId, createPendingCueSchedule(deferredCues, detail.content))

    const audio = pendingAudio.get(detail.messageId)
    const shouldScheduleBeforePlayback = detail.source?.startsWith('livekit') === true
    if (audio) {
      scheduleCuePlayback(
        detail.messageId,
        deferredCues,
        detail.content,
        audio,
        null,
        lipSyncMode === 'viseme' ? premiumLipSyncAnalyzer : 'batshit-text-timing'
      )
    } else if (detail.speechPlanned && shouldScheduleBeforePlayback) {
      // LiveKit speech-to-speech transcription arrives while the provider audio is already being spoken.
      // Batshit TTS/bridge chunks arrive before playback exists, so they wait for voice-playback-start/alignment.
      scheduleCuePlayback(
        detail.messageId,
        deferredCues,
        detail.content,
        undefined,
        null,
        'batshit-text-timing'
      )
    }
  }

  function handleVoiceStart(event: Event) {
    if (!open || !hasRenderableGoonAvatar(goon)) return
    const detail = (event as CustomEvent).detail as {
      messageId?: string | null
      agentId?: string | null
      audio?: HTMLAudioElement
      durationMs?: number | null
      mode?: string | null
      lipSyncAnalyzerId?: GoonLipSyncAnalyzerId | null
      lipSyncTimeline?: GoonLipSyncTimeline | null
      playbackMetrics?: GoonLipSyncPlaybackMetrics | null
      alignmentSegments?: VoiceRealtimeTtsAlignmentSegment[] | null
    }

    if (!detail) return
    if (activeSpeakerId && detail.agentId && detail.agentId !== activeSpeakerId) return

    voicePlaying = true
    engine?.setSpeechPlayback(
      detail.lipSyncTimeline ?? null,
      detail.durationMs ?? null,
      detail.lipSyncAnalyzerId ?? undefined
    )
    if (detail.audio) {
      if (detail.messageId) {
        pendingAudio.set(detail.messageId, detail.audio)
      }
      engine?.attachAudio(detail.audio)
    } else {
      engine?.attachAudio(null)
    }

    if (detail.messageId) {
      const pending = pendingCues.get(detail.messageId)
      if (pending) {
        pending.playbackStartedAtMs = performance.now()
        pending.alignmentSegments = detail.alignmentSegments ?? pending.alignmentSegments
        // Realtime TTS bridge cues need provider alignment; estimated text timing fires semantic emotes too early.
        if (detail.mode !== 'realtime' || pending.alignmentSegments?.length) {
          scheduleCuePlayback(
            detail.messageId,
            pending.cues,
            pending.content,
            detail.audio,
            detail.durationMs,
            detail.lipSyncAnalyzerId ?? null,
            pending.alignmentSegments
          )
        }
      }
    }

    if (detail.playbackMetrics) {
      lipSyncLabLastMetrics = detail.playbackMetrics
      lipSyncLabHistory = [detail.playbackMetrics, ...lipSyncLabHistory].slice(0, 6)
    }
  }

  function handleVoiceEnd(event: Event) {
    const detail = (event as CustomEvent).detail as {
      messageId?: string | null
      agentId?: string | null
    }
    if (activeSpeakerId && detail?.agentId && detail.agentId !== activeSpeakerId) return
    if (detail?.messageId) {
      pendingAudio.delete(detail.messageId)
      pendingCues.delete(detail.messageId)
      clearCueTimers(detail.messageId)
    } else {
      pendingAudio.clear()
      pendingCues.clear()
      clearCueTimers()
    }
    if (pendingAudio.size === 0) {
      clearVoicePauseCueTimer()
      voicePausedForCue = false
      engine?.attachAudio(null)
      engine?.clearSpeechPlayback()
      voicePlaying = false
    }
  }

  function handleVoiceAlignmentUpdate(event: Event) {
    if (!open || !hasRenderableGoonAvatar(goon)) return
    const detail = (event as CustomEvent).detail as {
      messageId?: string | null
      agentId?: string | null
      durationMs?: number | null
      lipSyncAnalyzerId?: GoonLipSyncAnalyzerId | null
      lipSyncTimeline?: GoonLipSyncTimeline | null
      alignmentSegments?: VoiceRealtimeTtsAlignmentSegment[] | null
    }
    if (!detail?.messageId) return
    if (activeSpeakerId && detail.agentId && detail.agentId !== activeSpeakerId) return

    if (detail.lipSyncTimeline) {
      engine?.updateSpeechLipSyncTimeline(
        detail.lipSyncTimeline,
        detail.durationMs ?? null,
        detail.lipSyncAnalyzerId ?? detail.lipSyncTimeline.analyzerId
      )
    }

    if (!detail.alignmentSegments?.length) return

    const pending = pendingCues.get(detail.messageId)
    if (!pending) return
    pending.alignmentSegments = detail.alignmentSegments
    if (!pending.playbackStartedAtMs) {
      pending.playbackStartedAtMs = performance.now()
    }
    clearCueTimers(detail.messageId)
    pending.scheduledCueKeys.clear()
    scheduleCuePlayback(
      detail.messageId,
      pending.cues,
      pending.content,
      pendingAudio.get(detail.messageId),
      detail.durationMs ?? null,
      detail.lipSyncAnalyzerId ?? 'batshit-text-timing',
      pending.alignmentSegments
    )
  }

  function handleTestCue(event: Event) {
    const detail = (event as CustomEvent).detail as {
      goonId?: string
      cueName?: string
      preserveCamera?: boolean
      preservePlacement?: boolean
    }
    if (!detail?.cueName) return
    if (detail.goonId && goon?.id && detail.goonId !== goon.id) return
    engine?.playCue(detail.cueName, cueMap[detail.cueName], {
      preserveCamera: detail.preserveCamera,
      preservePlacement: detail.preservePlacement
    })
  }

  function handlePreviewCamera(event: Event) {
    const detail = (event as CustomEvent).detail as {
      goonId?: string
      camera?: GoonCamera
    }
    if (!detail?.camera) return
    if (detail.goonId && goon?.id && detail.goonId !== goon.id) return
    engine?.applyCamera(detail.camera)
  }

  function handlePreviewAnimation(event: Event) {
    const detail = (event as CustomEvent).detail as {
      goonId?: string
      animationName?: string
    }
    if (!detail?.animationName) return
    if (detail.goonId && goon?.id && detail.goonId !== goon.id) return
    if (engine && !dockPreviewActive) {
      dockPreviewRestore = engine.getBaseLoopState()
    }
    dockAnimationName = detail.animationName
    engine?.previewLoopAnimation(detail.animationName, resolveDockPreviewDefinition(detail.animationName))
    dockPreviewActive = true
    scheduleDockPreviewReset()
  }

  function handlePreviewClear(event: Event) {
    const detail = (event as CustomEvent).detail as {
      goonId?: string
    }
    if (detail?.goonId && goon?.id && detail.goonId !== goon.id) return
    clearDockPreview()
  }

  function handleExternalPause(event: Event) {
    const detail = (event as CustomEvent).detail as {
      source?: string
      paused?: boolean
    }
    const source = detail?.source?.trim()
    if (!source) return
    if (detail.paused) {
      if (externalPauseSources[source]) return
      externalPauseSources = {
        ...externalPauseSources,
        [source]: true
      }
      return
    }
    if (!externalPauseSources[source]) return
    const next = { ...externalPauseSources }
    delete next[source]
    externalPauseSources = next
  }

  function startDockPreview() {
    if (!engine || !dockAnimationName) return
    if (!dockPreviewActive) {
      dockPreviewRestore = engine.getBaseLoopState()
    }
    engine.previewLoopAnimation(dockAnimationName, resolveDockPreviewDefinition(dockAnimationName))
    dockPreviewActive = true
    startDockPreviewStatus('motion', DOCK_PREVIEW_MAX_MS)
    scheduleDockPreviewReset()
  }

  function previewDockMotion(animationName: string) {
    dockAnimationName = animationName
    startDockPreview()
  }

  function clearDockPreviewTimer() {
    if (dockPreviewTimer) {
      clearTimeout(dockPreviewTimer)
      dockPreviewTimer = null
    }
  }

  function clearDockSaveStatusTimer() {
    if (dockSaveStatusTimer) {
      clearTimeout(dockSaveStatusTimer)
      dockSaveStatusTimer = null
    }
  }

  function showDockSaveStatus(message: string) {
    clearDockSaveStatusTimer()
    dockSaveStatusMessage = message
    dockSaveStatusTimer = setTimeout(() => {
      dockSaveStatusMessage = ''
      dockSaveStatusTimer = null
    }, 2200)
  }

  function clearDockPreviewStatusTimer() {
    if (dockPreviewStatusTimer) {
      clearInterval(dockPreviewStatusTimer)
      dockPreviewStatusTimer = null
    }
  }

  function clearDockPreviewStatus() {
    clearDockPreviewStatusTimer()
    dockPreviewStatusKind = null
    dockPreviewStatusRemainingMs = 0
  }

  function updateDockPreviewStatus(deadlineMs: number) {
    const remainingMs = Math.max(0, deadlineMs - Date.now())
    dockPreviewStatusRemainingMs = remainingMs
    if (remainingMs <= 0) {
      clearDockPreviewStatus()
    }
  }

  function startDockPreviewStatus(kind: 'motion' | 'emote', durationMs: number) {
    const clampedDurationMs = Math.max(250, durationMs)
    const deadlineMs = Date.now() + clampedDurationMs
    clearDockPreviewStatusTimer()
    dockPreviewStatusKind = kind
    updateDockPreviewStatus(deadlineMs)
    dockPreviewStatusTimer = setInterval(() => {
      updateDockPreviewStatus(deadlineMs)
    }, 250)
  }

  function scheduleDockPreviewReset() {
    clearDockPreviewTimer()
    dockPreviewTimer = setTimeout(() => {
      clearDockPreview()
    }, DOCK_PREVIEW_MAX_MS)
  }

  function clearDockPreview() {
    clearDockPreviewTimer()
    clearDockPreviewStatus()
    if (!engine) return
    const restore = dockPreviewRestore ?? engine.getBaseLoopState()
    engine.clearPreviewAnimation()
    if (restore?.name) {
      engine.setMood(restore.name, restore.definition ?? undefined)
    }
    dockPreviewActive = false
    dockPreviewRestore = null
    dockAnimationName = ''
  }

  async function handleGoonSelect(nextGoonId: string | null) {
    if (!dockAgent) return
    const trimmed = nextGoonId?.trim() || null
    if (trimmed) {
      const selected = goons.find((entry) => entry.id === trimmed)
      if (!selected || !isGoonRuntimeReady(selected)) {
        toast.error('That Goon is still preparing. Finish it in Settings → 3D Goons first.')
        return
      }
    }
    if (dockAgent.goon_id === trimmed) return
    try {
      await agentStore.updateAgentSettings(dockAgent.id, {
        goon_id: trimmed || null
      })
      showDockSaveStatus('Goon selected ✓')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update default Goon')
    }
  }

  async function persistDockCurrentMood(cueName: string, options?: { showStatus?: boolean }) {
    if (!goon) return
    const trimmedCueName = cueName.trim()
    if (!trimmedCueName || goon.defaults?.baseLoop === trimmedCueName) return
    if (dockPreviewActive) {
      clearDockPreview()
    }
    try {
      await updateGoonRecord(goon.id, {
        defaults: {
          ...(goon.defaults ?? {}),
          baseLoop: trimmedCueName
        }
      })
      if (options?.showStatus) {
        showDockSaveStatus('Current Mood Saved ✓')
      }
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update Current Mood')
    }
  }

  async function updateDockMood(cueName: string) {
    await persistDockCurrentMood(cueName, { showStatus: true })
  }

  async function updateDockScene(sceneId: string | null) {
    if (!goon) return
    if (dockPreviewActive) {
      clearDockPreview()
    }
    try {
      await updateGoonRecord(goon.id, {
        defaults: {
          ...(goon.defaults ?? {}),
          sceneId: sceneId || undefined
        }
      })
      showDockSaveStatus('Default Scene Saved ✓')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update default Scene')
    }
  }

  function triggerDockEmote(cueName: string) {
    if (!engine) return
    if (dockPreviewActive) {
      clearDockPreview()
    } else {
      clearDockPreviewStatus()
    }
    const definition = cueMap[cueName]
    engine.playCue(cueName, definition)
    startDockPreviewStatus('emote', resolveDockEmotePreviewDuration(definition))
    if (definition?.blocking) {
      pauseSpeechForCue(definition.durationMs ?? 800)
    }
  }

  async function updateDockClosetSlot(slotName: string, nextValue: string) {
    if (!goon) return
    if (dockPreviewActive) {
      clearDockPreview()
    }
    const editedOriginal = nextValue === '__original__'
      ? resolveDockEditedOriginalForSlot(slotName)
      : null
    const nextAssignments = applyClosetSelectionChange(
      goon.closetAssignments ?? {},
      slotName,
      (editedOriginal?.id ?? nextValue) as '__original__' | '__none__' | string,
      (itemId) => resolveClosetItem(goon, itemId),
      dockClosetSlotNames
    )
    const guidedAvatar = buildDockGuidedAvatarForAssignments(goon, nextAssignments, {
      clearActivePreset: resolveDockGuidedPiecesForSlot(slotName, goon).length > 0
    })
    const patch: Partial<GoonRecord> = {
      closetAssignments: nextAssignments,
      defaults: clearDockWardrobeOutfitDefault(goon)
    }
    if (guidedAvatar) {
      patch.guidedAvatar = guidedAvatar
    }

    try {
      await updateGoonRecord(goon.id, patch)
      showDockSaveStatus('Closet Saved ✓')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update Closet')
    }
  }

  async function updateDockGuidedPiece(piece: GoonGuidedOutfitPiece, nextValue: string) {
    if (!goon) return
    if (dockPreviewActive) {
      clearDockPreview()
    }
    const virtualSlotName = buildGuidedPieceOriginalClosetSlot(piece.id)
    const nextAssignments = { ...(goon.closetAssignments ?? {}) }
    const nextPieceStates = { ...(goon.guidedAvatar?.pieceStates ?? {}) }

    if (nextValue === '__none__') {
      delete nextAssignments[virtualSlotName]
      nextPieceStates[piece.id] = false
    } else if (nextValue === '__original__') {
      const editedOriginal = resolveDockEditedOriginalForGuidedPiece(piece.id)
      if (editedOriginal) {
        nextAssignments[virtualSlotName] = {
          mode: 'item',
          itemId: editedOriginal.id
        }
      } else {
        delete nextAssignments[virtualSlotName]
      }
      nextPieceStates[piece.id] = true
    } else {
      const item = resolveClosetItem(goon, nextValue)
      if (
        !item ||
        item.originalSource?.kind !== 'guided-piece-original' ||
        item.originalSource.pieceId !== piece.id
      ) {
        return
      }
      nextAssignments[virtualSlotName] = {
        mode: 'item',
        itemId: item.id
      }
      nextPieceStates[piece.id] = true
    }

    const guidedAvatar = buildDockGuidedAvatarForAssignments(goon, nextAssignments, {
      pieceStates: nextPieceStates,
      clearActivePreset: true
    })
    const patch: Partial<GoonRecord> = {
      closetAssignments: nextAssignments,
      defaults: clearDockWardrobeOutfitDefault(goon)
    }
    if (guidedAvatar) {
      patch.guidedAvatar = guidedAvatar
    }

    try {
      await updateGoonRecord(goon.id, patch)
      showDockSaveStatus('Closet Saved ✓')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update Closet')
    }
  }

  function resetDockAll() {
    if (dockPreviewActive) {
      clearDockPreview()
    }
    skyboxPitchOffset = 0
    viewFov = DEFAULT_VIEW_FOV
    cameraMode = 'free'
    eyeContactEnabled = true
    if (goon && engine) {
      const baseLoop = goon.defaults?.baseLoop ?? 'base_stand'
      const baseLoopDefinition = cueMap?.[baseLoop]
      engine.setMood(baseLoop, baseLoopDefinition)
      cameraTouched = false
      engine.resetView()
      engine.setCameraMode('free')
      const camera = engine.getCameraState()
      if (camera) {
        onCameraChange(camera)
      }
    }
  }

  function handlePerformance(stats: { fps: number }) {
    lastFps = stats.fps
    if (!open || !hasRenderableGoonAvatar(goon)) {
      lowFpsStreak = 0
      autoLowStreak = 0
      autoHighStreak = 0
      perfHint = false
      return
    }

    if (quality === 'auto') {
      if (stats.fps < 24) {
        autoLowStreak += 1
        autoHighStreak = 0
      } else if (stats.fps > 42) {
        autoHighStreak += 1
        autoLowStreak = 0
      } else {
        autoLowStreak = 0
        autoHighStreak = 0
      }

      if (autoLowStreak >= 3 && autoQuality !== 'low') {
        autoQuality = 'low'
        autoLowStreak = 0
      }

      if (autoHighStreak >= 6 && autoQuality !== 'high') {
        autoQuality = 'high'
        autoHighStreak = 0
      }

      perfHint = false
      return
    }

    if (stats.fps < 24) {
      lowFpsStreak += 1
    } else {
      lowFpsStreak = 0
      if (stats.fps >= 30) {
        perfHint = false
      }
    }

    if (lowFpsStreak >= 3 && quality !== 'low') {
      perfHint = true
    }
  }

  onMount(async () => {
    if (!primaryViewportEl) return
    const EngineCtor = await getGoonEngineCtor()
    const mountedEngine = new EngineCtor(primaryViewportEl, {
      quality: resolvedQuality,
      lipSyncEnabled,
      eyeContactMode: currentEyeContactMode,
      eyeContactTuning: currentEyeContactTuning,
      onRuntimeStatus: (status) => handleRuntimeStatus(status),
      onCompatibility: (report) => onCompatibilityReport(report),
      onPerformance: (stats) => handlePerformance(stats),
      onCameraChange: (camera) => handleDockCameraChange(camera)
    })
    engine = mountedEngine
    try {
      await mountedEngine.init()
      if (engine === mountedEngine) {
        mountedEngine.setCameraFov(viewFov)
        runtimeError = null
      }
    } catch (error) {
      if (engine === mountedEngine) {
        runtimeError = toGoonRuntimeError(error)
      }
    }

    handleVisibilityChange()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    if (viewportWrapperEl && typeof IntersectionObserver !== 'undefined') {
      viewportObserver = new IntersectionObserver(
        (entries) => {
          const entry = entries[0]
          viewportVisible = entry ? entry.isIntersecting : true
        },
        { threshold: 0.1 }
      )
      viewportObserver.observe(viewportWrapperEl)
    }

    window.addEventListener('batshit:goon-message', handleGoonMessage as EventListener)
    window.addEventListener('batshit:voice-playback-start', handleVoiceStart as EventListener)
    window.addEventListener('batshit:voice-alignment-update', handleVoiceAlignmentUpdate as EventListener)
    window.addEventListener('batshit:voice-playback-end', handleVoiceEnd as EventListener)
    window.addEventListener('batshit:goon-test-cue', handleTestCue as EventListener)
    window.addEventListener('batshit:goon-preview-camera', handlePreviewCamera as EventListener)
    window.addEventListener('batshit:goon-preview-animation', handlePreviewAnimation as EventListener)
    window.addEventListener('batshit:goon-preview-clear', handlePreviewClear as EventListener)
    window.addEventListener('batshit:goon-dock-pause', handleExternalPause as EventListener)
  })

  onDestroy(() => {
    swapToken += 1
    clearCueTimers()
    clearVoicePauseCueTimer()
    clearDockPreviewTimer()
    clearDockPreviewStatusTimer()
    clearDockSaveStatusTimer()
    pendingCues.clear()
    pendingAudio.clear()
    engine?.dispose()
    swapEngine?.dispose()
    for (const loadingEngine of loadingEngines) loadingEngine.dispose()
    loadingEngines.clear()
    engine = null
    swapEngine = null
    viewportObserver?.disconnect()
    viewportObserver = null
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    window.removeEventListener('batshit:goon-message', handleGoonMessage as EventListener)
    window.removeEventListener('batshit:voice-playback-start', handleVoiceStart as EventListener)
    window.removeEventListener('batshit:voice-alignment-update', handleVoiceAlignmentUpdate as EventListener)
    window.removeEventListener('batshit:voice-playback-end', handleVoiceEnd as EventListener)
    window.removeEventListener('batshit:goon-test-cue', handleTestCue as EventListener)
    window.removeEventListener('batshit:goon-preview-camera', handlePreviewCamera as EventListener)
    window.removeEventListener('batshit:goon-preview-animation', handlePreviewAnimation as EventListener)
    window.removeEventListener('batshit:goon-preview-clear', handlePreviewClear as EventListener)
    window.removeEventListener('batshit:goon-dock-pause', handleExternalPause as EventListener)
    dockObserver?.disconnect()
    dockObserver = null
  })

  $effect(() => {
    if (!viewportWrapperEl || typeof ResizeObserver === 'undefined') return
    dockObserver?.disconnect()
    dockObserver = new ResizeObserver(() => {
      const rect = viewportWrapperEl?.getBoundingClientRect()
      if (!rect) return
      dockRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    })
    dockObserver.observe(viewportWrapperEl)
    const rect = viewportWrapperEl.getBoundingClientRect()
    dockRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    return () => {
      dockObserver?.disconnect()
      dockObserver = null
    }
  })

  $effect(() => {
    if (!viewportWrapperEl) return
    const element = viewportWrapperEl
    element.addEventListener('wheel', handleViewportFovWheel, { capture: true, passive: false })
    return () => {
      element.removeEventListener('wheel', handleViewportFovWheel, true)
    }
  })

  $effect(() => {
    if (engine) {
      engine.setQuality(resolvedQuality)
    }
    if (swapEngine) {
      swapEngine.setQuality(resolvedQuality)
    }
  })

  $effect(() => {
    if (engine) {
      engine.setEyeContactEnabled(eyeContactEnabled)
    }
    if (swapEngine) {
      swapEngine.setEyeContactEnabled(eyeContactEnabled)
    }
  })

  $effect(() => {
    if (engine) {
      engine.setEyeContactMode(currentEyeContactMode)
      engine.setEyeContactTuning(currentEyeContactTuning)
      engine.setSocketEyeContactSettings(currentSocketEyeContact)
    }
    if (swapEngine) {
      swapEngine.setEyeContactMode(currentEyeContactMode)
      swapEngine.setEyeContactTuning(currentEyeContactTuning)
      swapEngine.setSocketEyeContactSettings(currentSocketEyeContact)
    }
  })

  $effect(() => {
    const stage = immersiveStage
    if (engine) {
      if (immersiveActive && stage) {
        const rect = dockRect
        const centerX = rect
          ? rect.left + rect.width / 2 - stage.left
          : stage.width / 2
        const clampedCenter = Math.max(0, Math.min(stage.width, centerX))
        const extraWidth = Math.abs(stage.width - clampedCenter * 2)
        const fullWidth = stage.width + extraWidth
        const offsetX = Math.max(0, Math.round(fullWidth / 2 - clampedCenter))
        engine.setViewOffset({
          fullWidth,
          fullHeight: stage.height,
          offsetX,
          offsetY: 0
        })
      } else {
        engine.clearViewOffset()
      }
    }
    if (swapEngine) {
      if (immersiveActive && stage) {
        const rect = dockRect
        const centerX = rect
          ? rect.left + rect.width / 2 - stage.left
          : stage.width / 2
        const clampedCenter = Math.max(0, Math.min(stage.width, centerX))
        const extraWidth = Math.abs(stage.width - clampedCenter * 2)
        const fullWidth = stage.width + extraWidth
        const offsetX = Math.max(0, Math.round(fullWidth / 2 - clampedCenter))
        swapEngine.setViewOffset({
          fullWidth,
          fullHeight: stage.height,
          offsetX,
          offsetY: 0
        })
      } else {
        swapEngine.clearViewOffset()
      }
    }
  })

  $effect(() => {
    if (engine) {
      engine.setSkyboxPitchOffset(skyboxPitchOffset)
    }
    if (swapEngine) {
      swapEngine.setSkyboxPitchOffset(skyboxPitchOffset)
    }
  })

  $effect(() => {
    const shouldRun = Boolean(
      hasRenderableGoonAvatar(goon) && !isDocumentHidden && viewportVisible && !externallyPaused
    )
    if (engine) {
      engine.setPaused(!shouldRun)
    }
    if (swapEngine) {
      swapEngine.setPaused(!shouldRun)
    }
  })

  $effect(() => {
    if (engine) {
      engine.setLipSyncEnabled(lipSyncEnabled)
      engine.setLipSyncMode(lipSyncMode)
    }
    if (swapEngine) {
      swapEngine.setLipSyncEnabled(false)
      swapEngine.setLipSyncMode(lipSyncMode)
    }
  })

  $effect(() => {
    if (quality === 'auto') return
    if (quality === 'low' || quality === 'high' || quality === 'ultra') {
      autoQuality = quality
    }
    autoLowStreak = 0
    autoHighStreak = 0
  })

  $effect(() => {
    if (engine) {
      const speaking = hasRenderableGoonAvatar(goon) && (lipSyncEnabled ? voicePlaying : isSpeaking)
      engine.setSpeaking(speaking)
      engine.setSpeechPausedForCue(voicePausedForCue)
    }
    if (swapEngine) {
      swapEngine.setSpeaking(false)
      swapEngine.setSpeechPausedForCue(false)
    }
  })

  $effect(() => {
    if (!hasRenderableGoonAvatar(goon)) {
      perfHint = false
      lowFpsStreak = 0
      voicePlaying = false
      runtimeError = null
    }
  })

  $effect(() => {
    if (handoffMountedState) return
    consumedHandoffMountedState = null
  })

  $effect(() => {
    if (!engine || !hasRenderableGoonAvatar(goon)) return
    liveActivationRetryVersion
    const activationKey = resolveGoonLiveActivationKey(goon)
    if (!activationKey) return
    const activation = liveActivationGate.request(activationKey)
    if (!activation) return
    void loadGoonWithTransition(goon, activation)
  })

  $effect(() => {
    if (!engine) return
    const plan = buildAnimationLoadPlan(goon)
    const signature = buildAnimationSignature(plan)
    if (signature === animationSignature) return
    animationSignature = signature
    void engine.syncAnimations(plan.eager, { deferredFiles: plan.deferred }).then(() => {
      if (!engine) return
      dockAnimationCatalog = engine.getAnimationCatalog()
    })
  })

  $effect(() => {
    if (!engine) {
      dockAnimationCatalog = []
    }
  })

  $effect(() => {
    if (!goon) {
      dockAnimationName = ''
      return
    }
    if (dockAnimationNames.length === 0) {
      dockAnimationName = ''
      return
    }
    if (dockAnimationName && !dockAnimationNames.includes(dockAnimationName)) {
      dockAnimationName = ''
    }
  })

  $effect(() => {
    if (!engine || !goon) return
  })

  $effect(() => {
    if (!engine || !goon) return
    if (resolveGoonKind(goon) === 'custom') {
      lastClosetSignature = ''
      dockMaterialNames = []
      return
    }
    const signature = buildClosetRuntimeSignature(goon)
    if (signature === lastClosetSignature) return
    lastClosetSignature = signature
    engine.resetMaterialOverrides()
    void applyClosetAssignments(engine, goon)
  })

  // Legacy/non-Recipe authoring packages remain live-editable. Durable Recipe
  // dials never enter a lean Live engine; successful activation replaces it.
  $effect(() => {
    if (!engine || !goon) return
    if (resolveGoonKind(goon) !== 'custom') return
    if (isMountedRecipeLiveGoon(goon)) return
    const signature = JSON.stringify(goon.appearanceDials ?? null)
    if (signature === lastAppearanceDialsSignature) return
    lastAppearanceDialsSignature = signature
    engine.setAppearanceDialValues(goon.appearanceDials ?? null)
  })

  // Legacy/non-Recipe artwork remains live-editable. Recipe-v2 artwork is
  // installed atomically beside Eye/Oral state during Live activation.
  $effect(() => {
    if (!engine || !goon) return
    if (resolveGoonKind(goon) !== 'custom') return
    if (isMountedRecipeLiveGoon(goon)) return
    const signature = JSON.stringify(goon.facialArtwork ?? null)
    if (signature === lastFacialArtworkSignature) return
    lastFacialArtworkSignature = signature
    void engine.setFacialArtworkState(goon.facialArtwork ?? null).catch((error) => {
      console.error('[GoonDock] Failed to apply facial artwork:', error)
      runtimeError = toGoonRuntimeError(error)
    })
  })

  // Non-Recipe custom packages remain live-editable. Recipe-v2 sibling state
  // is activated only with its exact Live revision in the replacement path.
  $effect(() => {
    if (!engine || !goon) return
    if (resolveGoonKind(goon) !== 'custom') return
    if (isMountedRecipeLiveGoon(goon)) return
    const signature = JSON.stringify(goon.eyeAppearance ?? null)
    if (signature === lastEyeAppearanceSignature) return
    lastEyeAppearanceSignature = signature
    engine.setEyeAppearanceState(goon.eyeAppearance ?? null)
  })

  // Oral material controls follow the same exact-package ownership boundary:
  // direct live edits for legacy packages, atomic activation for Recipe Live.
  $effect(() => {
    if (!engine || !goon) return
    if (resolveGoonKind(goon) !== 'custom') return
    if (isMountedRecipeLiveGoon(goon)) return
    const signature = JSON.stringify(goon.oralAppearance ?? null)
    if (signature === lastOralAppearanceSignature) return
    lastOralAppearanceSignature = signature
    engine.setOralAppearanceState(goon.oralAppearance ?? null)
  })

  $effect(() => {
    if (!engine || !goon) return
    const scene = resolveSceneForGoon(goon)
    const sceneSignature = buildGoonSceneSignature(scene)
    if (sceneSignature === lastSceneSignature) return
    lastSceneSignature = sceneSignature
    void applyGoonSceneDefinition(engine, scene, stagePostures)
  })

  $effect(() => {
    if (!engine || !goon) return
    const baseLoop = goon.defaults?.baseLoop ?? 'base_stand'
    const baseLoopDefinition = cueMap?.[baseLoop]
    const signature = buildBaseLoopSignature(baseLoop, baseLoopDefinition)
    const shouldUpdateBaseLoop = signature !== lastBaseLoopSignature
    if (shouldUpdateBaseLoop) {
      lastBaseLoopSignature = signature
      engine.setMood(baseLoop, baseLoopDefinition)
    }
  })

  async function saveLipSyncLabSettings(
    nextMode: GoonLipSyncMode,
    nextAnalyzer: GoonLipSyncPremiumAnalyzerId = lipSyncLabAnalyzer
  ) {
    const currentUserSettings = getUserSettings()
    const normalizedVoiceSettings = normalizeVoiceSettings(currentUserSettings?.voice_settings)
    const voiceSettings = {
      ...normalizedVoiceSettings,
      goonLipSync: {
        ...normalizedVoiceSettings.goonLipSync,
        mode: nextMode,
        analyzerId: nextAnalyzer
      }
    }

    lipSyncLabMode = nextMode
    lipSyncLabAnalyzer = nextAnalyzer
    lipSyncLabSaving = true
    lipSyncLabError = null

    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          voice_settings: voiceSettings
        })
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error || 'Failed to save lip sync settings.')
      }

      const payload = await response.json().catch(() => null)
      const updated = payload?.settings ?? payload?.userSettings ?? null
      if (updated) {
        setUserSettings(updated)
      }

    } catch (error) {
      lipSyncLabMode = lipSyncMode
      lipSyncLabAnalyzer = premiumLipSyncAnalyzer
      lipSyncLabError = error instanceof Error ? error.message : 'Failed to save lip sync settings.'
      toast.error(lipSyncLabError)
    } finally {
      lipSyncLabSaving = false
    }
  }

  function handleLipSyncLabModeSelect(nextMode: GoonLipSyncMode) {
    void saveLipSyncLabSettings(nextMode, lipSyncLabAnalyzer)
  }

  function handleLipSyncLabAnalyzerSelect(analyzerId: GoonLipSyncPremiumAnalyzerId) {
    void saveLipSyncLabSettings('viseme', analyzerId)
  }

  function formatPlaybackMetricMs(value?: number | null) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
    return `${Math.round(value)} ms`
  }

  function formatPlaybackAnalyzerLabel(entry: GoonLipSyncPlaybackMetrics) {
    switch (entry.analyzerId) {
      case 'audio2face-3d':
        return 'NVIDIA Audio2Face'
      case 'rhubarb-wasm':
        return 'Rhubarb WASM'
      case 'batshit-text-timing':
      default:
        return 'Text Timing'
    }
  }

  function formatPlaybackLipSyncExtra(entry: GoonLipSyncPlaybackMetrics) {
    return formatPlaybackMetricMs(entry.lipSyncTotalMs)
  }

  $effect(() => {
    lipSyncLabMode = lipSyncMode
    lipSyncLabAnalyzer = premiumLipSyncAnalyzer
  })
</script>

{#if open}
  <div class={`goon-dock-shell ${externallyPaused ? 'is-paused' : ''}`}>
    <div class="goon-dock-main">
      <div bind:this={viewportWrapperEl} class="goon-dock-viewport">
        <div
          class={`${immersiveActive ? 'goon-immersive-layer' : 'goon-dock-viewport-layer'} goon-dock-viewport-transition ${primaryVisible ? 'is-visible' : 'is-hidden'}`}
          style={immersiveActive ? immersiveLayerStyle : undefined}
        >
          <div bind:this={primaryViewportEl} class="goon-dock-viewport-host"></div>
        </div>
        <div
          class={`${immersiveActive ? 'goon-immersive-layer' : 'goon-dock-viewport-layer'} goon-dock-viewport-transition ${secondaryVisible ? 'is-visible' : 'is-hidden'}`}
          style={immersiveActive ? immersiveLayerStyle : undefined}
        >
          <div bind:this={secondaryViewportEl} class="goon-dock-viewport-host"></div>
        </div>
        {#if swapActive && !swapReady}
          <div class="goon-dock-status-overlay is-passive">
            <span class="goon-dock-status-pill">
              Loading Goon…
            </span>
          </div>
        {/if}
        {#if goon && resolveRuntimeBadge(runtimeStatus)}
          <div class="goon-dock-runtime-badge">
            {resolveRuntimeBadge(runtimeStatus)}
          </div>
        {/if}
        {#if showLipSyncLab && goon}
          <div class="goon-lip-sync-lab">
            <button
              class="goon-lip-sync-lab-trigger"
              onclick={() => (lipSyncLabOpen = !lipSyncLabOpen)}
              type="button"
            >
              <Sparkles class="goon-lip-sync-lab-icon" />
              Lip Sync Lab
            </button>
            {#if lipSyncLabOpen}
              <div class="goon-lip-sync-lab-panel">
                <div class="goon-lip-sync-lab-stack">
                  <div>
                    <p class="goon-lip-sync-lab-title">Global lip sync</p>
                    <p class="goon-lip-sync-lab-copy">
                      This edits the same saved Voice setting as the full Settings panel.
                    </p>
                  </div>
                  <div class="goon-lip-sync-lab-grid is-two">
                    {#each [
                      { value: 'amplitude', label: 'Shitty but Fast' },
                      { value: 'viseme', label: 'Premium' }
                    ] as option (option.value)}
                      <Button
                        variant={lipSyncLabMode === option.value ? 'default' : 'outline'}
                        size="sm"
                        class="goon-lip-sync-lab-option"
                        disabled={lipSyncLabSaving}
                        onclick={() => handleLipSyncLabModeSelect(option.value as GoonLipSyncMode)}
                      >
                        {option.label}
                      </Button>
                    {/each}
                  </div>
                  {#if lipSyncLabMode === 'viseme'}
                    <div class="goon-lip-sync-lab-stack is-tight">
                      <p class="goon-lip-sync-lab-title">Premium analyzer</p>
                      <div class="goon-lip-sync-lab-grid">
                        {#each PREMIUM_GOON_LIP_SYNC_ANALYZER_OPTIONS as option (option.value)}
                          <Button
                            variant={lipSyncLabAnalyzer === option.value ? 'default' : 'outline'}
                            size="sm"
                            class="goon-lip-sync-lab-option"
                            disabled={lipSyncLabSaving}
                            onclick={() => handleLipSyncLabAnalyzerSelect(option.value)}
                          >
                            {option.shortLabel}
                          </Button>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  {#if lipSyncLabSaving}
                    <p class="goon-lip-sync-lab-copy">Saving global lip sync setting…</p>
                  {/if}
                  {#if lipSyncLabError}
                    <p class="goon-lip-sync-lab-error">{lipSyncLabError}</p>
                  {/if}
                  {#if lipSyncLabLastMetrics}
                    <div class="goon-lip-sync-lab-metrics">
                      <div class="goon-lip-sync-lab-metrics-header">
                        <span class="goon-lip-sync-lab-title">Last replay</span>
                        <span class="goon-lip-sync-lab-copy">{formatPlaybackAnalyzerLabel(lipSyncLabLastMetrics)}</span>
                      </div>
                      <div class="goon-lip-sync-lab-metric-grid">
                        <span>TTS</span>
                        <span>{formatPlaybackMetricMs(lipSyncLabLastMetrics.ttsTotalMs)}</span>
                        <span>Lip sync</span>
                        <span>{formatPlaybackLipSyncExtra(lipSyncLabLastMetrics)}</span>
                        <span>Preplay</span>
                        <span>{formatPlaybackMetricMs(lipSyncLabLastMetrics.prePlaybackTotalMs)}</span>
                        <span>Audio</span>
                        <span>{formatPlaybackMetricMs(lipSyncLabLastMetrics.audioDurationMs)}</span>
                      </div>
                      {#if lipSyncLabLastMetrics.textPreview}
                        <p class="goon-lip-sync-lab-copy is-spaced">"{lipSyncLabLastMetrics.textPreview}"</p>
                      {/if}
                      {#if lipSyncLabLastMetrics.notes && lipSyncLabLastMetrics.notes.length > 0}
                        <p class="goon-lip-sync-lab-copy is-spaced">{lipSyncLabLastMetrics.notes.join(' ')}</p>
                      {/if}
                    </div>
                    {#if lipSyncLabHistory.length > 1}
                      <div class="goon-lip-sync-lab-stack is-tight">
                        <p class="goon-lip-sync-lab-title">Recent replays</p>
                        {#each lipSyncLabHistory as entry, index (`${entry.capturedAt}-${index}`)}
                          <div class="goon-lip-sync-lab-history-row">
                            <span class="goon-lip-sync-lab-history-label">{formatPlaybackAnalyzerLabel(entry)}</span>
                            <span class="goon-lip-sync-lab-history-value">{formatPlaybackMetricMs(entry.prePlaybackTotalMs)}</span>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  {:else}
                    <p class="goon-lip-sync-lab-copy">
                      Replay a message to capture TTS time versus lip-sync-added time.
                    </p>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        {#if goon && runtimeError}
          <div class="goon-dock-status-overlay">
            <span class="goon-dock-error-pill">
              {runtimeError}
            </span>
            {#if failedLiveActivationKey === resolveGoonLiveActivationKey(goon)}
              <button
                type="button"
                class="goon-dock-error-retry"
                onclick={retryFailedLiveActivation}
              >
                Retry Live Goon
              </button>
            {/if}
          </div>
        {/if}
        {#if !goon}
          <div class="goon-dock-empty">
            Assign a Goon in Settings → Agents.
          </div>
        {/if}
      </div>

      <div class="goon-dock-footer">
        <div class="goon-dock-footer-primary">
          <DropdownMenu.Root bind:open={goonMenuOpen}>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!open || readyGoons.length === 0}
              aria-label="Select Goon"
              title={`Goon: ${goon?.name || 'None'}`}
            >
              <BatshitIcon id="goons" class="goon-dock-control-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="goon-dock-menu is-wide">
              {#if readyGoons.length > 0}
                {#each readyGoons as goonEntry (goonEntry.id)}
                  <div class="goon-dock-menu-row">
                    <DropdownMenu.Item
                      onSelect={() => void handleGoonSelect(goonEntry.id)}
                      class="goon-dock-menu-item"
                    >
                      <span class="goon-dock-menu-label">
                        {goonEntry.name || 'Unnamed Goon'}{dockAgent?.goon_id === goonEntry.id
                          ? ' • Current'
                          : ''}
                      </span>
                    </DropdownMenu.Item>
                    <button
                      type="button"
                      class="goon-dock-menu-edit"
                      onclick={(event) => handleEditGoon(event, goonEntry.id)}
                    >
                      <Edit class="goon-dock-small-icon" />
                    </button>
                  </div>
                {/each}
              {:else}
                <DropdownMenu.Item disabled>
                  <span class="goon-dock-menu-muted">No goons available</span>
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={handleManageGoons}>Manage Goons...</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={handleCreateGoon}>Create New Goon...</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!goon}
              aria-label="Select Scene"
              title={`Scene: ${getCurrentSceneLabel()}`}
            >
              <BatshitIcon id="scenes" class="goon-dock-control-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="goon-dock-menu is-scroll">
              <DropdownMenu.Item onSelect={() => void updateDockScene(null)}>
                <span>No scene{!goon?.defaults?.sceneId ? ' • Current' : ''}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              {#if dockSceneOptions.length > 0}
                {#each dockSceneOptions as sceneOption (sceneOption.id)}
                  <DropdownMenu.Item onSelect={() => void updateDockScene(sceneOption.id)}>
                    <span class="goon-dock-menu-label">
                      {sceneOption.name}{goon?.defaults?.sceneId === sceneOption.id ? ' • Current' : ''}
                    </span>
                  </DropdownMenu.Item>
                {/each}
              {:else}
                <DropdownMenu.Item disabled>
                  <span class="goon-dock-menu-muted">No scenes available</span>
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!goon || dockMoodOptions.length === 0}
              aria-label="Select Mood"
              title={`Mood: ${getCurrentMoodLabel()}`}
            >
              <BatshitIcon id="moods" class="goon-dock-control-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="goon-dock-menu is-scroll">
              {#if dockMoodOptions.length > 0}
                {#each dockMoodOptions as moodOption (moodOption.name)}
                  <DropdownMenu.Item onSelect={() => void updateDockMood(moodOption.name)}>
                    <span class="goon-dock-menu-label">
                      {moodOption.name}{goon?.defaults?.baseLoop === moodOption.name ? ' • Current' : ''}
                    </span>
                  </DropdownMenu.Item>
                {/each}
              {:else}
                <DropdownMenu.Item disabled>
                  <span class="goon-dock-menu-muted">No moods enabled</span>
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!goon || !dockClosetQuickAccessAvailable}
              aria-label="Closet quick access"
              title="Closet quick access"
            >
              <BatshitIcon id="closet" class="goon-dock-control-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="goon-dock-menu is-closet">
              {#if dockClosetQuickAccessAvailable}
                {#if dockClosetAvailable}
                  <DropdownMenu.Item
                    onSelect={() =>
                      void applyDockBuiltInWardrobeOutfit(ALL_ORIGINAL_WARDROBE_OUTFIT_ID)}
                  >
                    All Original
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => void applyDockBuiltInWardrobeOutfit(NO_WARDROBE_OUTFIT_ID)}
                  >
                    None
                  </DropdownMenu.Item>
                {/if}
                {#if dockWardrobeOutfitList.length > 0}
                  {#if dockClosetAvailable}
                    <DropdownMenu.Separator />
                  {/if}
                  {#each dockWardrobeOutfitList as outfit (outfit.id)}
                    <DropdownMenu.Item onSelect={() => void applyDockSavedWardrobeOutfit(outfit.id)}>
                      <span class="goon-dock-menu-label">
                        {outfit.name}{goon?.defaults?.closetOutfitId === outfit.id ? ' • Current' : ''}
                      </span>
                    </DropdownMenu.Item>
                  {/each}
                {/if}
                {#if dockClosetAvailable && (dockWardrobeOutfitList.length > 0 || dockClosetSlotNames.length > 0 || dockStandaloneGuidedOutfitPieces.length > 0)}
                  <DropdownMenu.Separator />
                {/if}
                {#each dockClosetSlotNames as slotName (slotName)}
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger class="goon-dock-subtrigger">
                      <span class="goon-dock-menu-label">{resolveDockClosetSlotNickname(slotName)}</span>
                      <span class="goon-dock-menu-count">
                        {getDockClosetSlotLabel(slotName)}
                      </span>
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.SubContent class="goon-dock-submenu is-scroll">
                      {#if !resolveDockEditedOriginalForSlot(slotName)}
                        <DropdownMenu.Item onSelect={() => void updateDockClosetSlot(slotName, '__original__')}>
                          Original
                        </DropdownMenu.Item>
                      {/if}
                      <DropdownMenu.Item onSelect={() => void updateDockClosetSlot(slotName, '__none__')}>
                        None
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      {#each getDockClosetItemsForSlot(slotName) as item (item.id)}
                        <DropdownMenu.Item onSelect={() => void updateDockClosetSlot(slotName, item.id)}>
                          <span class="goon-dock-menu-label">
                            {getDockWardrobeItemDisplayName(item)}
                            {getDockClosetSlotValue(slotName) === item.id
                              ? ' • Current'
                              : ''}
                          </span>
                        </DropdownMenu.Item>
                      {/each}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Sub>
                {/each}
                {#if dockClosetSlotNames.length > 0 && dockStandaloneGuidedOutfitPieces.length > 0}
                  <DropdownMenu.Separator />
                {/if}
                {#each dockStandaloneGuidedOutfitPieces as piece (piece.id)}
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger class="goon-dock-subtrigger">
                      <span class="goon-dock-menu-label">{resolveDockGuidedPieceLabel(piece)}</span>
                      <span class="goon-dock-menu-count">
                        {getDockGuidedPieceSelectionLabel(piece)}
                      </span>
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.SubContent class="goon-dock-submenu is-scroll">
                      {#if !resolveDockEditedOriginalForGuidedPiece(piece.id)}
                        <DropdownMenu.Item onSelect={() => void updateDockGuidedPiece(piece, '__original__')}>
                          Original
                        </DropdownMenu.Item>
                      {/if}
                      <DropdownMenu.Item onSelect={() => void updateDockGuidedPiece(piece, '__none__')}>
                        None
                      </DropdownMenu.Item>
                      {#if getDockGuidedPieceSavedItems(piece).length > 0}
                        <DropdownMenu.Separator />
                        {#each getDockGuidedPieceSavedItems(piece) as item (item.id)}
                          <DropdownMenu.Item onSelect={() => void updateDockGuidedPiece(piece, item.id)}>
                            <span class="goon-dock-menu-label">
                              {getDockWardrobeItemDisplayName(item)}
                              {getDockGuidedPieceValue(piece) === item.id ? ' • Current' : ''}
                            </span>
                          </DropdownMenu.Item>
                        {/each}
                      {/if}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Sub>
                {/each}
              {:else}
                <DropdownMenu.Item disabled>
                  <span class="goon-dock-menu-muted">No closet slots available</span>
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <div class="goon-dock-footer-divider"></div>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!goon || dockEmoteOptions.length === 0}
              aria-label="Quick view Emote"
              title="Quick view Emote"
            >
              <BatshitIcon id="emotes" class="goon-dock-control-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="goon-dock-menu is-scroll">
              {#if dockEmoteOptions.length > 0}
                {#each dockEmoteOptions as emoteOption (emoteOption.name)}
                  <DropdownMenu.Item onSelect={() => triggerDockEmote(emoteOption.name)}>
                    <span class="goon-dock-menu-label">
                      {emoteOption.name}
                      {emoteOption.description ? ` — ${emoteOption.description}` : ''}
                    </span>
                  </DropdownMenu.Item>
                {/each}
              {:else}
                <DropdownMenu.Item disabled>
                  <span class="goon-dock-menu-muted">No emotes enabled</span>
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!goon || dockAnimationNames.length === 0}
              aria-label="Quick view Motion"
              title={dockPreviewActive && dockAnimationName ? `Quick view Motion: ${dockAnimationName}` : 'Quick view Motion'}
            >
              <BatshitIcon id="motions" class="goon-dock-control-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="goon-dock-menu is-motion">
              {#if dockMotionOptions.length > 0}
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger class="goon-dock-subtrigger is-wide-gap">
                    <span>All Motions</span>
                    <span class="goon-dock-menu-count">{dockMotionOptions.length}</span>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent class="goon-dock-submenu is-motion">
                    {#each dockMotionOptions as motion (motion.name)}
                      <DropdownMenu.Item onSelect={() => previewDockMotion(motion.name)}>
                        <span class="goon-dock-menu-label is-flex">
                          {motion.label}{dockPreviewActive && dockAnimationName === motion.name ? ' • Previewing' : ''}
                        </span>
                        <span class="goon-dock-menu-count is-offset">
                          {motion.postureLabel}
                        </span>
                      </DropdownMenu.Item>
                    {/each}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>

                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger class="goon-dock-subtrigger is-wide-gap">
                    <span>By Posture</span>
                    <span class="goon-dock-menu-count">{dockMotionPostureGroups.length}</span>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent class="goon-dock-submenu is-visible-overflow">
                    {#each dockMotionPostureGroups as group (group.id)}
                      <DropdownMenu.Sub>
                        <DropdownMenu.SubTrigger class="goon-dock-subtrigger is-wide-gap">
                          <span class="goon-dock-menu-label">{group.label}</span>
                          <span class="goon-dock-menu-count">{group.motions.length}</span>
                        </DropdownMenu.SubTrigger>
                        <DropdownMenu.SubContent class="goon-dock-submenu is-motion">
                          {#each group.motions as motion (motion.name)}
                            <DropdownMenu.Item onSelect={() => previewDockMotion(motion.name)}>
                              <span class="goon-dock-menu-label">
                                {motion.label}{dockPreviewActive && dockAnimationName === motion.name ? ' • Previewing' : ''}
                              </span>
                            </DropdownMenu.Item>
                          {/each}
                        </DropdownMenu.SubContent>
                      </DropdownMenu.Sub>
                    {/each}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>

                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger class="goon-dock-subtrigger is-wide-gap">
                    <span>By Tag</span>
                    <span class="goon-dock-menu-count">
                      {dockMotionTagGroups.length + (dockMotionUntaggedOptions.length > 0 ? 1 : 0)}
                    </span>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent class="goon-dock-submenu is-visible-overflow">
                    {#if dockMotionTagGroups.length > 0 || dockMotionUntaggedOptions.length > 0}
                      {#each dockMotionTagGroups as group (group.id)}
                        <DropdownMenu.Sub>
                          <DropdownMenu.SubTrigger class="goon-dock-subtrigger is-wide-gap">
                            <span class="goon-dock-menu-label">{group.label}</span>
                            <span class="goon-dock-menu-count">{group.motions.length}</span>
                          </DropdownMenu.SubTrigger>
                          <DropdownMenu.SubContent class="goon-dock-submenu is-motion">
                            {#each group.motions as motion (motion.name)}
                              <DropdownMenu.Item onSelect={() => previewDockMotion(motion.name)}>
                                <span class="goon-dock-menu-label">
                                  {motion.label}{dockPreviewActive && dockAnimationName === motion.name ? ' • Previewing' : ''}
                                </span>
                              </DropdownMenu.Item>
                            {/each}
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Sub>
                      {/each}
                      {#if dockMotionTagGroups.length > 0 && dockMotionUntaggedOptions.length > 0}
                        <DropdownMenu.Separator />
                      {/if}
                      {#if dockMotionUntaggedOptions.length > 0}
                        <DropdownMenu.Sub>
                          <DropdownMenu.SubTrigger class="goon-dock-subtrigger is-wide-gap">
                            <span>Untagged</span>
                            <span class="goon-dock-menu-count">{dockMotionUntaggedOptions.length}</span>
                          </DropdownMenu.SubTrigger>
                          <DropdownMenu.SubContent class="goon-dock-submenu is-motion">
                            {#each dockMotionUntaggedOptions as motion (motion.name)}
                              <DropdownMenu.Item onSelect={() => previewDockMotion(motion.name)}>
                                <span class="goon-dock-menu-label">
                                  {motion.label}{dockPreviewActive && dockAnimationName === motion.name ? ' • Previewing' : ''}
                                </span>
                              </DropdownMenu.Item>
                            {/each}
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Sub>
                      {/if}
                    {:else}
                      <DropdownMenu.Item disabled>
                        <span class="goon-dock-menu-muted">No tags yet</span>
                      </DropdownMenu.Item>
                    {/if}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>
              {:else}
                <DropdownMenu.Item disabled>
                  <span class="goon-dock-menu-muted">No motions available</span>
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <Button
            variant="ghost"
            size="sm"
            class="goon-dock-icon-button"
            onclick={resetDockAll}
            disabled={!goon}
            aria-label="Reset dock view controls and clear preview"
            title="Reset dock view controls and clear preview"
          >
            <RotateCcw class="goon-dock-control-icon" />
          </Button>
          {#if dockPreviewCountdownLabel}
            <span
              class="goon-dock-countdown"
              title={dockPreviewCountdownTitle}
            >
              {dockPreviewCountdownLabel}
            </span>
          {:else if dockSaveStatusMessage}
            <span class="goon-dock-save-status">
              {dockSaveStatusMessage}
            </span>
          {/if}
        </div>
        <div class="goon-dock-footer-secondary">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!goon}
              aria-label={cameraMode === 'indoor' ? 'Indoor Camera' : 'Free Camera'}
              title={cameraMode === 'indoor' ? 'Indoor Camera' : 'Free Camera'}
            >
              {#if cameraMode === 'indoor'}
                <House class="goon-dock-control-icon" />
              {:else}
                <Camera class="goon-dock-control-icon" />
              {/if}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="goon-dock-popover is-compact is-camera">
              <div class="goon-dock-popover-stack">
                <div class="goon-dock-popover-label">Camera</div>
                <div class="goon-dock-quality-grid">
                  <Button
                    variant={cameraMode === 'indoor' ? 'default' : 'outline'}
                    size="sm"
                    class="goon-dock-quality-option"
                    disabled={!engine?.canUseIndoorCamera()}
                    title={engine?.canUseIndoorCamera()
                      ? 'Stay inside the room while orbiting and zooming'
                      : 'This scene needs a room boundary before Indoor Camera can be used'}
                    onclick={() => handleCameraModeChange('indoor')}
                  >
                    <House class="goon-dock-control-icon" /> Indoor Camera
                  </Button>
                  <Button
                    variant={cameraMode === 'free' ? 'default' : 'outline'}
                    size="sm"
                    class="goon-dock-quality-option"
                    onclick={() => handleCameraModeChange('free')}
                  >
                    <Camera class="goon-dock-control-icon" /> Free Camera
                  </Button>
                </div>
                <p class="goon-dock-popover-help">Indoor stays within the room. Free allows exterior cinematic views.</p>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-fov-trigger"
              disabled={!goon}
              aria-label={`Field of view: ${Math.round(viewFov)}`}
              title={`Field of view: ${Math.round(viewFov)} (Shift + Scroll)`}
            >
              FOV
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="goon-dock-popover">
              <div class="goon-dock-popover-stack">
                <div class="goon-dock-popover-header">
                  <span class="goon-dock-popover-label">
                    Field of View
                  </span>
                  <span class="goon-dock-popover-value">{Math.round(viewFov)}</span>
                </div>
                <Slider
                  type="single"
                  value={viewFov}
                  onValueChange={handleFovChange}
                  min={MIN_VIEW_FOV}
                  max={MAX_VIEW_FOV}
                  step={1}
                  class="goon-dock-slider"
                />
                <div class="goon-dock-framing-block">
                  <span class="goon-dock-popover-label">Framing</span>
                  <div class="goon-dock-framing-grid" role="group" aria-label="Goon framing">
                    <Button
                      variant="outline"
                      size="sm"
                      class="goon-dock-framing-button"
                      onclick={() => handleDockFramePreset('headshot')}
                    >Headshot</Button>
                    <Button
                      variant="outline"
                      size="sm"
                      class="goon-dock-framing-button"
                      onclick={() => handleDockFramePreset('portrait')}
                    >Portrait</Button>
                    <Button
                      variant="outline"
                      size="sm"
                      class="goon-dock-framing-button"
                      onclick={() => handleDockFramePreset('full-body')}
                    >Full Body</Button>
                  </div>
                </div>
                <p class="goon-dock-popover-help">Scroll covers the full close-to-exterior range. FOV remains available for manual lens control.</p>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="goon-dock-icon-trigger"
              disabled={!goon}
              aria-label={`Quality: ${qualityOptions.find((option) => option.value === quality)?.label || 'Auto'}`}
              title={`Quality: ${qualityOptions.find((option) => option.value === quality)?.label || 'Auto'}`}
            >
              <Settings2 class="goon-dock-control-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="goon-dock-popover is-compact">
              <div class="goon-dock-popover-stack">
                <div class="goon-dock-popover-label">Quality</div>
                <div class="goon-dock-quality-grid">
                  {#each qualityOptions as option}
                    <Button
                      variant={quality === option.value ? 'default' : 'outline'}
                      size="sm"
                      class="goon-dock-quality-option"
                      onclick={() => onQualityChange(option.value)}
                    >
                      {option.label}
                    </Button>
                  {/each}
                </div>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <Button
            variant={eyeContactEnabled ? 'default' : 'ghost'}
            size="sm"
            class="goon-dock-icon-button"
            onclick={() => (eyeContactEnabled = !eyeContactEnabled)}
            disabled={!goon}
            aria-label={eyeContactEnabled ? 'Disable eye contact' : 'Enable eye contact'}
            title={eyeContactEnabled ? 'Disable eye contact' : 'Enable eye contact'}
          >
            <Eye class="goon-dock-control-icon" />
          </Button>

          <Button
            variant={immersiveMode ? 'secondary' : 'ghost'}
            size="sm"
            class="goon-dock-icon-button"
            onclick={() => onImmersiveChange(!immersiveMode)}
            disabled={!goon}
            aria-label={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
            title={immersiveMode ? 'Disable immersive mode' : 'Enable immersive mode'}
          >
            <Maximize2 class="goon-dock-control-icon" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            class="goon-dock-icon-button"
            onclick={onDesktopModeChange}
            disabled={
              !goon ||
              !desktopModeAvailable ||
              desktopModeBusy ||
              !mountedRendererReadyForDesktop
            }
            aria-label={desktopModeBusy ? 'Moving Goon to Desktop Mode' : 'Move Goon to Desktop Mode'}
            title={
              desktopModeAvailable
                ? desktopModeBusy
                  ? 'Moving Goon to Desktop Mode…'
                  : !mountedRendererReadyForDesktop
                    ? 'The Goon renderer is still preparing…'
                  : 'Move Goon to Desktop Mode'
                : desktopModeUnavailableReason ?? 'Desktop Mode requires the managed Batshit desktop app.'
            }
          >
            <MonitorUp class="goon-dock-control-icon" />
          </Button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .goon-dock-shell,
  .goon-dock-main {
    display: flex;
    flex-direction: column;
  }

  .goon-dock-shell {
    width: 100%;
    height: 100%;
  }

  .goon-dock-shell.is-paused {
    pointer-events: none;
    visibility: hidden;
  }

  .goon-dock-main {
    flex: 1 1 auto;
  }

  .goon-dock-viewport {
    position: relative;
    z-index: var(--z-dock);
    flex: 1 1 auto;
    min-height: 360px;
    background: color-mix(in oklab, var(--muted) 20%, transparent);
  }

  .goon-dock-viewport-layer,
  .goon-dock-viewport-host {
    position: absolute;
    inset: 0;
  }

  .goon-dock-viewport-transition {
    transition: opacity 300ms ease-out;
  }

  .goon-dock-viewport-transition.is-visible {
    opacity: 1;
  }

  .goon-dock-viewport-transition.is-hidden {
    pointer-events: none;
    opacity: 0;
  }

  .goon-immersive-layer {
    position: fixed;
    z-index: var(--z-canvas);
    pointer-events: auto;
  }

  .goon-dock-status-overlay,
  .goon-dock-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .goon-dock-status-overlay {
    flex-direction: column;
    gap: 0.5rem;
    padding: 0 1rem;
    text-align: center;
  }

  .goon-dock-status-overlay.is-passive {
    pointer-events: none;
  }

  .goon-dock-status-pill,
  .goon-dock-error-pill,
  .goon-dock-runtime-badge,
  .goon-lip-sync-lab-trigger,
  .goon-lip-sync-lab-panel {
    backdrop-filter: blur(4px);
  }

  .goon-dock-status-pill {
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--bs-app-card) 70%, transparent);
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .goon-dock-error-pill {
    padding: 0.5rem 0.75rem;
    border: 1px solid color-mix(in oklab, var(--destructive) 30%, transparent);
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--background) 85%, transparent);
    color: var(--destructive);
    font-size: 0.75rem;
  }

  .goon-dock-error-retry {
    padding: 0.35rem 0.65rem;
    border: 1px solid var(--bs-app-border);
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--bs-app-card) 88%, transparent);
    color: var(--bs-app-text);
    cursor: pointer;
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .goon-dock-error-retry:hover {
    background: var(--bs-app-field-hover);
  }

  .goon-dock-error-retry:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
  }

  .goon-dock-empty {
    color: var(--bs-app-muted-text);
    font-size: 0.875rem;
  }

  .goon-dock-runtime-badge {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--bs-app-card) 80%, transparent);
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
  }

  .goon-lip-sync-lab {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .goon-lip-sync-lab-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--bs-app-card) 85%, transparent);
    color: var(--bs-app-title);
    box-shadow: 0 1px 3px color-mix(in oklab, black 20%, transparent);
    font-size: 0.625rem;
    font-weight: 500;
    cursor: pointer;
  }

  .goon-lip-sync-lab-trigger:hover {
    background: var(--bs-app-inset-surface-hover);
  }

  :global(.goon-lip-sync-lab-icon) {
    width: 12px;
    height: 12px;
  }

  .goon-lip-sync-lab-panel {
    width: 300px;
    padding: 0.75rem;
    border: 1px solid var(--bs-app-popover-line);
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--bs-app-card) 90%, transparent);
    box-shadow: 0 12px 24px color-mix(in oklab, black 26%, transparent);
    font-size: 0.625rem;
  }

  .goon-lip-sync-lab-stack {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .goon-lip-sync-lab-stack.is-tight {
    gap: 0.25rem;
  }

  .goon-lip-sync-lab-title {
    margin: 0;
    color: var(--bs-app-title);
    font-weight: 600;
  }

  .goon-lip-sync-lab-copy,
  .goon-lip-sync-lab-metric-grid,
  .goon-lip-sync-lab-history-row {
    color: var(--bs-app-muted-text);
  }

  .goon-lip-sync-lab-copy {
    margin: 0;
  }

  .goon-lip-sync-lab-copy.is-spaced {
    margin-top: 0.5rem;
  }

  .goon-lip-sync-lab-error {
    margin: 0;
    color: var(--destructive);
  }

  .goon-lip-sync-lab-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }

  .goon-lip-sync-lab-grid.is-two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  :global(.goon-lip-sync-lab-option) {
    height: 28px;
    padding: 0 0.5rem;
    font-size: 0.625rem;
  }

  .goon-lip-sync-lab-metrics {
    padding: 0.5rem;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 0.25rem;
    background: var(--bs-app-field);
  }

  .goon-lip-sync-lab-metrics-header,
  .goon-lip-sync-lab-history-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .goon-lip-sync-lab-metrics-header {
    margin-bottom: 0.25rem;
  }

  .goon-lip-sync-lab-metric-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.75rem;
    row-gap: 0.25rem;
  }

  .goon-lip-sync-lab-history-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goon-lip-sync-lab-history-value {
    flex-shrink: 0;
  }

  .goon-dock-footer {
    position: relative;
    z-index: var(--z-dock);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 48px;
    padding: 0 1rem;
    border-top: 1px solid var(--bs-app-inner-line);
    background: color-mix(in oklab, var(--bs-app-card) 70%, transparent);
  }

  .goon-dock-footer-primary {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .goon-dock-footer-secondary {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    padding-left: 0.5rem;
    border-left: 1px solid var(--bs-app-inner-line);
  }

  :global(.goon-dock-icon-trigger),
  :global(.goon-dock-icon-button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: transparent;
    color: var(--bs-app-text);
    transition:
      background-color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.goon-dock-icon-trigger:hover),
  :global(.goon-dock-icon-button:hover) {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.goon-dock-icon-trigger:focus-visible),
  :global(.goon-dock-icon-button:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
  }

  :global(.goon-dock-control-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.goon-dock-small-icon) {
    width: 12px;
    height: 12px;
  }

  :global(.goon-dock-menu) {
    min-width: 220px;
  }

  :global(.goon-dock-menu.is-wide) {
    max-width: 360px;
  }

  :global(.goon-dock-menu.is-scroll) {
    max-height: 320px;
    overflow-y: auto;
  }

  :global(.goon-dock-menu.is-closet) {
    min-width: 240px;
    max-height: 360px;
    overflow-y: auto;
  }

  :global(.goon-dock-menu.is-motion) {
    min-width: 260px;
    max-height: 360px;
    overflow-y: auto;
  }

  .goon-dock-menu-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.5rem;
  }

  :global(.goon-dock-menu-item) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .goon-dock-menu-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goon-dock-menu-label.is-flex {
    flex: 1 1 auto;
  }

  .goon-dock-menu-muted,
  .goon-dock-menu-count,
  .goon-dock-popover-help,
  .goon-dock-popover-label {
    color: var(--bs-app-muted-text);
  }

  .goon-dock-menu-count,
  .goon-dock-popover-label,
  .goon-dock-popover-help {
    font-size: 0.625rem;
  }

  .goon-dock-menu-count {
    flex-shrink: 0;
  }

  .goon-dock-menu-count.is-offset {
    margin-left: 0.5rem;
  }

  .goon-dock-menu-edit {
    margin-left: auto;
    padding: 0.25rem;
    border: 0;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--bs-app-text);
    cursor: pointer;
    transition: background-color 150ms ease-out;
  }

  .goon-dock-menu-edit:hover {
    background: var(--bs-app-field-hover);
  }

  :global(.goon-dock-subtrigger) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  :global(.goon-dock-subtrigger.is-wide-gap) {
    gap: 0.75rem;
  }

  :global(.goon-dock-submenu) {
    min-width: 240px;
  }

  :global(.goon-dock-submenu.is-scroll) {
    max-height: 320px;
    overflow-y: auto;
  }

  :global(.goon-dock-submenu.is-motion) {
    min-width: 280px;
    max-height: 360px;
    overflow-y: auto;
  }

  :global(.goon-dock-submenu.is-visible-overflow) {
    overflow: visible;
  }

  .goon-dock-footer-divider {
    width: 1px;
    height: 20px;
    margin: 0 0.25rem;
    background: var(--bs-app-inner-line);
  }

  .goon-dock-countdown,
  .goon-dock-save-status {
    min-width: 2rem;
    text-align: right;
    font-size: 0.6875rem;
    font-weight: 500;
  }

  .goon-dock-countdown {
    color: #f59e0b;
  }

  .goon-dock-save-status {
    min-width: 7rem;
    color: var(--success-color);
  }

  :global(.goon-dock-fov-trigger) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    height: 32px;
    padding: 0 0.5rem;
    border-radius: 0.375rem;
    background: transparent;
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    transition:
      background-color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.goon-dock-fov-trigger:hover) {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.goon-dock-fov-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
  }

  :global(.goon-dock-popover) {
    width: 220px;
    padding: 0.75rem;
  }

  :global(.goon-dock-popover.is-compact) {
    padding: 0.5rem;
  }

  :global(.goon-dock-popover.is-camera) {
    width: 292px;
  }

  .goon-dock-popover-stack {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .goon-dock-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .goon-dock-popover-label {
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .goon-dock-popover-value {
    color: var(--bs-app-title);
    font-size: 0.625rem;
    font-weight: 500;
  }

  :global(.goon-dock-slider) {
    flex: 1 1 auto;
  }

  .goon-dock-popover-help {
    margin: 0;
  }

  .goon-dock-framing-block {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding-top: 0.125rem;
  }

  .goon-dock-framing-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.375rem;
  }

  :global(.goon-dock-framing-button) {
    width: 100%;
    height: 28px;
    padding-inline: 0.375rem;
    font-size: 0.5625rem;
  }

  .goon-dock-quality-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
  }

  :global(.goon-dock-quality-option) {
    width: 100%;
    height: 28px;
    padding: 0 0.5rem;
    font-size: 0.625rem;
    white-space: nowrap;
  }

  .goon-dock-screen-reader {
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

  :global(body.goon-immersive .goon-dock-footer) {
    background: transparent;
    backdrop-filter: blur(6px);
    border-left: 0;
    border-top: 0;
  }
</style>

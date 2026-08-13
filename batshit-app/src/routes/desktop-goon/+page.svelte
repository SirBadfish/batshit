<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { loadGoonAnimationLibrary, loadGoons } from '$lib/services/goons'
  import { refreshUserSettingsRequest } from '$lib/services/goonsSettingsPersistence'
  import { normalizeGoonsSettings } from '$lib/goons/resolve'
  import {
    resolveGoonEyeContactMode,
    resolveGoonEyeContactTuning
  } from '$lib/goons/customAvatar'
  import { resolveGoonLiveActivationKey } from '$lib/goons/recipe'
  import { buildMountedLiveGoonLoadPlan, loadMountedLiveGoon } from '$lib/goons/mountedLiveGoon'
  import {
    adaptDesktopGoonStatePort,
    getDesktopGoonNativeBridge,
    type DesktopGoonNativeBridge,
    type DesktopGoonShellStatus,
    type DesktopGoonStatePortFacade
  } from '$lib/goons/desktopGoonNativeBridge'
  import {
    DesktopGoonDesktopStateConsumer,
    type DesktopGoonBridgeFailure
  } from '$lib/goons/desktopGoonStateBridge'
  import { applyDesktopGoonEngineCameraCommand } from '$lib/goons/desktopGoonEngineCamera'
  import type {
    DesktopGoonDeltaEnvelopeV1,
    DesktopGoonJsonValue,
    DesktopGoonRuntimeSnapshotV1
  } from '$lib/goons/desktopGoonContracts'
  import type { GoonEngine, GoonMountedRuntimeState } from '$lib/goons/engine'
  import type { GoonCueDefinition, GoonRecord } from '$lib/types/goons'

  let viewport: HTMLDivElement | null = $state(null)
  let bridge: DesktopGoonNativeBridge | null = null
  let consumer: DesktopGoonDesktopStateConsumer | null = null
  let engine: GoonEngine | null = null
  let snapshot: DesktopGoonRuntimeSnapshotV1 | null = null
  let loadGeneration = 0
  let rendererReportedReady = false
  let statusMessage = $state('Connecting Desktop Mode…')
  let errorMessage = $state<string | null>(null)
  let adjustMode = $state(false)
  let shellStatus = $state<DesktopGoonShellStatus | null>(null)
  let statusUnsubscribe: (() => void) | null = null
  let portUnsubscribe: (() => void) | null = null
  let returnRequested = false
  let drag:
    | {
        mode: 'move' | 'resize-left' | 'resize-right'
        pointerId: number
        startX: number
        startY: number
        bounds: { x: number; y: number; width: number; height: number }
      }
    | null = null
  let pendingBounds: { x: number; y: number; width: number; height: number } | null = null
  let boundsFrame = 0

  function plainJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

  function latestStatus(value: DesktopGoonShellStatus): DesktopGoonShellStatus {
    return value.status && typeof value.status === 'object' ? value.status : value
  }

  function readBounds() {
    const value = shellStatus?.bounds
    if (!value || typeof value !== 'object') return null
    const bounds = value as Record<string, unknown>
    if (
      !['x', 'y', 'width', 'height'].every(
        (key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key])
      )
    ) {
      return null
    }
    return bounds as { x: number; y: number; width: number; height: number }
  }

  async function failRenderer(error: unknown) {
    const message = error instanceof Error ? error.message : 'Desktop Goon renderer failed.'
    errorMessage = message
    statusMessage = 'Desktop Mode could not start.'
    try {
      await bridge?.invoke('desktopGoon.rendererFailed', { message })
    } catch (reportError) {
      console.error('[Desktop Goon] Failed to report renderer failure:', reportError)
    }
  }

  async function resolveSnapshotGoon(value: DesktopGoonRuntimeSnapshotV1) {
    if (!value.goon) throw new Error('No Live Goon is assigned to the active Desktop speaker.')
    const [goons, animationLibrary, userSettings] = await Promise.all([
      loadGoons(),
      loadGoonAnimationLibrary(),
      refreshUserSettingsRequest(fetch)
    ])
    const goon = goons.find((entry) => entry.id === value.goon?.goonId)
    if (!goon) throw new Error('The Desktop Goon record is no longer available.')
    if (resolveGoonLiveActivationKey(goon) !== value.goon.activationKey) {
      throw new Error('The Desktop Goon package changed before renderer ownership was transferred.')
    }
    if (goon.updated_at !== value.goon.recordUpdatedAt) {
      throw new Error('The Desktop Goon record changed before renderer ownership was transferred.')
    }
    return {
      goon,
      animations: Array.isArray(animationLibrary.vrma) ? animationLibrary.vrma : [],
      goonsSettings: normalizeGoonsSettings(userSettings.goons_settings)
    }
  }

  function applyVoiceVisual(value: DesktopGoonRuntimeSnapshotV1['voiceVisual']) {
    if (!engine || !value) return
    if (value.kind === 'start') {
      engine.setLipSyncMode(value.timeline ? 'viseme' : 'amplitude')
      engine.setSpeechPlayback(value.timeline, value.durationMs, value.analyzerId ?? undefined)
      engine.setSpeaking(true)
      return
    }
    if (value.kind === 'alignment') {
      engine.setLipSyncMode('viseme')
      engine.updateSpeechLipSyncTimeline(value.timeline, value.durationMs, value.analyzerId)
      return
    }
    if (value.kind === 'frame') {
      engine.setDesktopSpeechVisualFrame(value.frame, value.audioLevel)
      engine.setSpeaking(true)
      return
    }
    engine.clearDesktopSpeechVisualFrame()
    engine.clearSpeechPlayback()
    engine.setSpeaking(false)
  }

  async function mountSnapshot(value: DesktopGoonRuntimeSnapshotV1) {
    if (!viewport) throw new Error('The Desktop Goon viewport is unavailable.')
    const generation = ++loadGeneration
    statusMessage = 'Loading the active Goon…'
    errorMessage = null
    if (!value.goon && rendererReportedReady) {
      const previous = engine
      engine = null
      previous?.dispose()
      snapshot = value
      statusMessage = 'The active speaker does not have a ready Goon assigned.'
      return
    }
    const resolved = await resolveSnapshotGoon(value)
    if (generation !== loadGeneration) return

    // Renderer ownership is exclusive across every Desktop reload. Dispose the
    // prior owner before constructing the replacement, even if that means a
    // brief transparent frame while the new package loads.
    const previous = engine
    engine = null
    previous?.dispose()

    const Engine = (await import('$lib/goons/engine')).GoonEngine
    const incoming = new Engine(viewport, {
      quality: resolved.goon.defaults?.quality ?? 'auto',
      lipSyncEnabled: resolved.goon.defaults?.lipSync ?? true,
      eyeContactMode: resolveGoonEyeContactMode(resolved.goon, resolved.goonsSettings),
      eyeContactTuning: resolveGoonEyeContactTuning(resolved.goon, resolved.goonsSettings),
      socketEyeContact: resolved.goon.defaults?.socketEyeContact ?? null,
      surfaceProfile: 'desktop-transparent'
    })
    try {
      const plan = buildMountedLiveGoonLoadPlan(resolved.goon, {
        goonsSettings: resolved.goonsSettings,
        animationFiles: resolved.animations,
        sceneMode: 'none',
        mountedState: value.mountedRuntimeState as GoonMountedRuntimeState | null
      })
      await loadMountedLiveGoon(incoming, plan)
      if (generation !== loadGeneration) {
        incoming.dispose()
        return
      }
      engine = incoming
      snapshot = value
      if (value.camera) {
        applyDesktopGoonEngineCameraCommand(engine, {
          schemaVersion: value.camera.schemaVersion,
          kind: 'apply-state',
          state: value.camera
        })
      }
      applyVoiceVisual(value.voiceVisual)
      statusMessage = ''
      if (!rendererReportedReady) {
        await bridge?.invoke('desktopGoon.rendererReady')
        rendererReportedReady = true
      }
    } catch (error) {
      incoming.dispose()
      throw error
    }
  }

  function handleDelta(envelope: DesktopGoonDeltaEnvelopeV1) {
    const delta = envelope.delta
    if (delta.type === 'goon.invalidated') {
      if (!snapshot) return
      const isSameMountedGoon =
        Boolean(snapshot.goon && delta.goon) &&
        snapshot.goon?.goonId === delta.goon?.goonId &&
        snapshot.goon?.activationKey === delta.goon?.activationKey
      const mountedRuntimeState = isSameMountedGoon && engine
        ? (plainJson(engine.captureMountedRuntimeState()) as unknown as {
            [key: string]: DesktopGoonJsonValue
          })
        : isSameMountedGoon
          ? snapshot.mountedRuntimeState
          : null
      void mountSnapshot({ ...snapshot, goon: delta.goon, mountedRuntimeState }).catch(failRenderer)
      return
    }
    if (delta.type === 'presentation.changed') {
      if (snapshot) snapshot = { ...snapshot, presentation: delta.presentation }
      return
    }
    if (delta.type === 'session-agent.changed') {
      if (snapshot) {
        snapshot = {
          ...snapshot,
          sessionId: delta.sessionId,
          activeAgentId: delta.activeAgentId
        }
      }
      return
    }
    if (delta.type === 'speaker.changed') {
      if (snapshot) snapshot = { ...snapshot, activeSpeaker: delta.activeSpeaker }
      return
    }
    if (delta.type === 'settings.changed') {
      if (snapshot) snapshot = { ...snapshot, preferences: delta.preferences }
      return
    }
    if (delta.type === 'voice.visual') {
      applyVoiceVisual(delta.visual)
      return
    }
    if (delta.type === 'camera.command') {
      if (!engine) return
      const result = applyDesktopGoonEngineCameraCommand(engine, delta.value)
      if (result.status === 'captured') {
        // Capture remains local to the active Desktop session.
      }
      return
    }
    if (delta.type === 'camera.state') {
      if (!engine) return
      applyDesktopGoonEngineCameraCommand(engine, {
        schemaVersion: delta.camera.schemaVersion,
        kind: 'apply-state',
        state: delta.camera
      })
      if (snapshot) snapshot = { ...snapshot, camera: delta.camera }
      return
    }
    if (delta.type === 'cue') {
      engine?.playCue(delta.name, delta.payload as GoonCueDefinition)
      return
    }
    if (delta.type === 'terminal.error') {
      errorMessage = delta.message
      statusMessage = 'Desktop Mode disconnected.'
    }
  }

  function handleBridgeFailure(failure: DesktopGoonBridgeFailure) {
    errorMessage = failure.message
    statusMessage = 'Desktop Mode disconnected.'
  }

  function recoverDockAfterBridgeFailure() {
    if (!returnRequested) {
      returnRequested = true
      void bridge
        ?.invoke('desktopGoon.returnToBatshit', { reason: 'state-bridge-disconnected' })
        .catch((error) => {
          console.error('[Desktop Goon] Failed to recover the Dock after disconnect:', error)
        })
    }
  }

  async function handleStatePort(portFacade: DesktopGoonStatePortFacade) {
    const port = adaptDesktopGoonStatePort(portFacade)
    if (consumer) consumer.replacePort(port)
    else {
      consumer = new DesktopGoonDesktopStateConsumer({
        port,
        onSnapshot: (value) => void mountSnapshot(value).catch(failRenderer),
        onDelta: handleDelta,
        onDisconnected: handleBridgeFailure,
        onRecovery: recoverDockAfterBridgeFailure
      })
    }
  }

  function scheduleBounds(value: { x: number; y: number; width: number; height: number }) {
    pendingBounds = value
    if (boundsFrame) return
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = 0
      const next = pendingBounds
      pendingBounds = null
      if (!next) return
      void bridge?.invoke('desktopGoon.setBounds', { bounds: next }).then((status) => {
        shellStatus = latestStatus(status)
      })
    })
  }

  function beginFrameDrag(event: PointerEvent, mode: NonNullable<typeof drag>['mode']) {
    if (!adjustMode) return
    const bounds = readBounds()
    if (!bounds) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    drag = {
      mode,
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      bounds
    }
  }

  function moveFrame(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.screenX - drag.startX
    const dy = event.screenY - drag.startY
    if (drag.mode === 'move') {
      scheduleBounds({ ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy })
    } else if (drag.mode === 'resize-left') {
      const boundedDx = Math.min(dx, drag.bounds.width - 240)
      scheduleBounds({
        ...drag.bounds,
        x: drag.bounds.x + boundedDx,
        width: drag.bounds.width - boundedDx
      })
    } else {
      scheduleBounds({ ...drag.bounds, width: Math.max(240, drag.bounds.width + dx) })
    }
  }

  function endFrameDrag(event: PointerEvent) {
    if (drag?.pointerId === event.pointerId) drag = null
  }

  function handleShiftWheel(event: WheelEvent) {
    if (!event.shiftKey || !engine) return
    const camera = engine.getCameraState()
    if (!camera) return
    event.preventDefault()
    event.stopPropagation()
    engine.setCameraFov((camera.fov ?? 50) + Math.sign(event.deltaY || event.deltaX) * 2)
  }

  onMount(async () => {
    bridge = getDesktopGoonNativeBridge('desktop')
    if (!bridge) {
      errorMessage = 'Desktop Mode is available only in the managed Batshit desktop app.'
      statusMessage = 'Desktop Mode unavailable.'
      return
    }
    try {
      statusUnsubscribe = bridge.onStatus((value) => {
        const next = latestStatus(value)
        shellStatus = next
        adjustMode = Boolean(next.adjustMode)
      })
      portUnsubscribe = bridge.onStatePort((port) => void handleStatePort(port))
      shellStatus = latestStatus(await bridge.invoke('desktopGoon.getStatus'))
      adjustMode = Boolean(shellStatus.adjustMode)
      await bridge.invoke('desktopGoon.bridgeReady')
    } catch (error) {
      await failRenderer(error)
    }
  })

  onDestroy(() => {
    loadGeneration += 1
    if (boundsFrame) cancelAnimationFrame(boundsFrame)
    statusUnsubscribe?.()
    portUnsubscribe?.()
    consumer?.close()
    consumer = null
    engine?.dispose()
    engine = null
  })
</script>

<svelte:head>
  <title>Batshit Desktop Goon</title>
</svelte:head>

<main
  class:adjust-view={adjustMode}
  class:error={Boolean(errorMessage)}
  class="desktop-goon-surface"
  aria-live="polite"
  onwheel={handleShiftWheel}
>
  <div bind:this={viewport} class="desktop-goon-viewport"></div>

  {#if adjustMode}
    <button
      type="button"
      class="frame-move"
      aria-label="Move Desktop Goon window"
      title="Drag to move"
      onpointerdown={(event) => beginFrameDrag(event, 'move')}
      onpointermove={moveFrame}
      onpointerup={endFrameDrag}
      onpointercancel={endFrameDrag}
    >
      <span></span><span></span><span></span>
    </button>
    <button
      type="button"
      class="frame-resize left"
      aria-label="Resize Desktop Goon from left edge"
      onpointerdown={(event) => beginFrameDrag(event, 'resize-left')}
      onpointermove={moveFrame}
      onpointerup={endFrameDrag}
      onpointercancel={endFrameDrag}
    ></button>
    <button
      type="button"
      class="frame-resize right"
      aria-label="Resize Desktop Goon from right edge"
      onpointerdown={(event) => beginFrameDrag(event, 'resize-right')}
      onpointermove={moveFrame}
      onpointerup={endFrameDrag}
      onpointercancel={endFrameDrag}
    ></button>
  {/if}

  {#if statusMessage || errorMessage}
    <div class:error={Boolean(errorMessage)} class="desktop-goon-status">
      {errorMessage ?? statusMessage}
    </div>
  {/if}
</main>

<style>
  .desktop-goon-surface,
  .desktop-goon-viewport {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: transparent;
  }

  .desktop-goon-surface.adjust-view {
    box-shadow: inset 0 0 0 1px rgb(188 147 255 / 56%);
  }

  .desktop-goon-surface.error {
    box-shadow: inset 0 0 0 1px rgb(248 113 113 / 50%);
  }

  .frame-move,
  .frame-resize {
    position: absolute;
    z-index: 3;
    border: 1px solid rgb(255 255 255 / 15%);
    background: rgb(9 9 18 / 78%);
    color: rgb(244 240 255 / 92%);
    backdrop-filter: blur(8px);
  }

  .frame-move {
    top: 8px;
    left: 50%;
    display: flex;
    gap: 3px;
    padding: 7px 10px;
    transform: translateX(-50%);
    border-radius: 999px;
    cursor: move;
    touch-action: none;
  }

  .frame-move span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: currentColor;
  }

  .frame-resize {
    top: 25%;
    bottom: 25%;
    width: 10px;
    padding: 0;
    cursor: ew-resize;
    touch-action: none;
  }

  .frame-resize.left {
    left: 0;
    border-left: 0;
    border-radius: 0 7px 7px 0;
  }

  .frame-resize.right {
    right: 0;
    border-right: 0;
    border-radius: 7px 0 0 7px;
  }

  .desktop-goon-status {
    position: absolute;
    z-index: 4;
    left: 50%;
    bottom: 1rem;
    max-width: min(28rem, calc(100% - 2rem));
    padding: 0.5rem 0.75rem;
    transform: translateX(-50%);
    border: 1px solid rgb(255 255 255 / 14%);
    border-radius: 0.5rem;
    background: rgb(8 8 16 / 84%);
    color: rgb(232 232 240 / 88%);
    font-size: 0.75rem;
    line-height: 1.35;
    text-align: center;
    backdrop-filter: blur(8px);
  }

  .desktop-goon-status.error {
    border-color: rgb(248 113 113 / 38%);
    color: rgb(254 202 202 / 96%);
  }
</style>

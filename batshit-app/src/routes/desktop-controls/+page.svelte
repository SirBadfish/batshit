<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    AudioLines,
    ArrowDownToLine,
    Eye,
    Hand,
    LayersArrowDown,
    LayersArrowUp,
    Lock,
    MonitorX,
    Move3d,
    Paperclip,
    PhoneOff,
    Settings2,
    X
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import {
    DesktopControlsClipStateController,
    type DesktopControlsClip,
    type DesktopControlsClipState
  } from '$lib/services/desktopControlsClips'
  import type { DesktopControlsVoiceState } from '$lib/services/desktopControlsVoice'
  import {
    getDesktopControlsNativeBridge,
    type DesktopControlsNativeBridge,
    type DesktopControlsShellState,
    type DesktopControlsStateEvent
  } from '$lib/goons/desktopControlsNativeBridge'
  import { dispatchSessionClipStateChanged } from '$lib/utils/liveSettingsEvents'
  import {
    GOON_QUICK_CONTROLS_SCHEMA_VERSION,
    normalizeGoonQuickControlAction,
    type GoonQuickControlAction,
    type GoonQuickControlClosetAction,
    type GoonQuickControlsProjection
  } from '$lib/goons/goonQuickControls'

  type ProjectedPreferences = {
    stayOnTop: boolean
    clickThrough: boolean
  }

  const clipController = new DesktopControlsClipStateController()
  let bridge: DesktopControlsNativeBridge | null = null
  let shellState = $state<DesktopControlsShellState | null>(null)
  let clipState = $state<DesktopControlsClipState>(clipController.getState())
  let busy = $state<string | null>(null)
  let error = $state<string | null>(null)
  let draggingFiles = $state(false)
  let fileInput: HTMLInputElement | null = $state(null)
  let shellUnsubscribe: (() => void) | null = null
  let clipUnsubscribe: (() => void) | null = null
  let projectedSessionId: string | null = null
  let projectedClipRevision = -1
  let moodSelection = $state('')
  let closetSelection = $state('')
  let qualitySelection = $state('')

  const preferences = $derived.by<ProjectedPreferences>(() => {
    const projection = shellState?.projection
    const value = projection?.preferences
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { stayOnTop: true, clickThrough: false }
    }
    const record = value as Record<string, unknown>
    return {
      stayOnTop: record.stayOnTop !== false,
      clickThrough: record.clickThrough === true
    }
  })
  const voiceState = $derived.by<DesktopControlsVoiceState>(() => {
    const value = shellState?.projection?.voice
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as DesktopControlsVoiceState
    }
    return {
      active: false,
      listening: false,
      runtime: 'direct',
      inputKind: null,
      phase: 'inactive',
      label: 'Voice Mode off',
      modeLabel: 'Voice Mode',
      error: null,
      allowedIntents: [],
      ownerAvailable: false,
      revision: 0,
      pendingIntent: null,
      intentError: null
    }
  })
  const goonControlsEnvelope = $derived.by(() => {
    const value = shellState?.projection?.goonControls
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { state: null, pendingAction: null, error: null }
    }
    const record = value as Record<string, unknown>
    const state = record.state
    const validState =
      state &&
      typeof state === 'object' &&
      !Array.isArray(state) &&
      (state as Record<string, unknown>).schemaVersion === GOON_QUICK_CONTROLS_SCHEMA_VERSION
        ? (state as GoonQuickControlsProjection)
        : null
    return {
      state: validState,
      pendingAction:
        typeof record.pendingAction === 'string' ? record.pendingAction : null,
      error: typeof record.error === 'string' ? record.error : null
    }
  })
  const goonControls = $derived(goonControlsEnvelope.state)
  const closetActionsByKey = $derived.by(() => {
    const entries =
      goonControls?.closet.groups.flatMap((group) =>
        group.options.map((option) => [option.key, option.action] as const)
      ) ?? []
    return new Map<string, GoonQuickControlClosetAction>(entries)
  })

  function clipPreviewUrl(clip: DesktopControlsClip) {
    return clip.thumbnailUrl || clip.displayUrl || clip.localUrl || ''
  }

  function updateShellState(event: DesktopControlsStateEvent | DesktopControlsShellState) {
    shellState = 'state' in event ? event.state : event
    const projection = shellState.projection
    const sessionId = typeof projection?.sessionId === 'string' ? projection.sessionId : null
    const revision =
      typeof projection?.clipRevision === 'number' && Number.isSafeInteger(projection.clipRevision)
        ? projection.clipRevision
        : 0
    if (sessionId === projectedSessionId && revision === projectedClipRevision) return
    projectedSessionId = sessionId
    projectedClipRevision = revision
    void clipController.setSession(sessionId).catch(() => {
      // The controller publishes the explicit error state; no hidden retry is used.
    })
  }

  async function invoke(command: Parameters<DesktopControlsNativeBridge['invoke']>[0], payload = {}) {
    if (!bridge) throw new Error('Desktop Controls bridge is unavailable.')
    return bridge.invoke(command, payload)
  }

  async function runAction(label: string, action: () => Promise<void>) {
    if (busy) return
    busy = label
    error = null
    try {
      await action()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : `${label} failed.`
    } finally {
      busy = null
    }
  }

  async function toggleAdjust() {
    await runAction('Adjust', async () => {
      updateShellState(
        await invoke('desktopControls.setAdjust', { enabled: !shellState?.adjustActive })
      )
    })
  }

  function setStayOnTop(value: string) {
    if (value !== 'off' && value !== 'on') return
    const stayOnTop = value === 'on'
    if (stayOnTop === preferences.stayOnTop) return
    void runAction('Stay on Top', () =>
      sendIntent('preferences.update', { stayOnTop })
    )
  }

  function setClickThrough(value: string) {
    if (value !== 'off' && value !== 'on') return
    const clickThrough = value === 'on'
    if (clickThrough === preferences.clickThrough) return
    void runAction('Click-Through', () =>
      sendIntent('preferences.update', { clickThrough })
    )
  }

  async function sendIntent(intent: string, payload: Record<string, unknown> = {}) {
    updateShellState(await invoke('desktopControls.sendIntent', { intent, payload }))
  }

  async function handleVoicePrimary() {
    await runAction('Voice Mode', async () => {
      if (!voiceState.active) await sendIntent('voice.start')
      else if (voiceState.allowedIntents.includes('toggle-listening')) {
        await sendIntent('voice.toggle-listening')
      }
    })
  }

  async function endVoice() {
    await runAction('End Voice Mode', () => sendIntent('voice.end'))
  }

  async function runGoonQuickControl(action: GoonQuickControlAction) {
    // Closet actions originate inside a reactive projection, so their objects can be
    // Svelte proxies. Rebuild every action as a bounded plain object before Electron
    // tries to structured-clone the renderer intent across the native bridge.
    const normalizedAction = normalizeGoonQuickControlAction(action)
    await runAction('Goon Control', () =>
      sendIntent('goon.quick-control', { action: normalizedAction })
    )
  }

  function selectMood(cueName: string) {
    queueMicrotask(() => (moodSelection = ''))
    if (!cueName) return
    void runGoonQuickControl({ kind: 'mood', cueName })
  }

  function selectCloset(key: string) {
    queueMicrotask(() => (closetSelection = ''))
    const action = closetActionsByKey.get(key)
    if (!action) return
    void runGoonQuickControl(action)
  }

  function selectQuality(value: string) {
    queueMicrotask(() => (qualitySelection = ''))
    if (!['auto', 'low', 'high', 'ultra'].includes(value)) return
    void runGoonQuickControl({
      kind: 'quality',
      value: value as 'auto' | 'low' | 'high' | 'ultra'
    })
  }

  async function detachClip(clipId: string) {
    await runAction('Unclip', async () => {
      await clipController.detach(clipId)
      await sendIntent('clips.changed', { sessionId: clipState.sessionId, clipId })
    })
  }

  async function getClipCompressionSettings() {
    const response = await fetch('/api/user/settings')
    if (!response.ok) {
      throw new Error(`Clip upload settings are unavailable (${response.status}).`)
    }
    const payload = await response.json().catch(() => null)
    const settings = payload?.settings?.ui_settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Clip compression settings are unavailable.')
    }
    return {
      compress_images: settings.compress_images !== false,
      compression_quality: settings.compression_quality || 40,
      max_image_size: settings.max_image_size || '1024',
      force_jpeg: settings.force_jpeg !== false
    }
  }

  async function uploadFiles(files: File[]) {
    if (!files.length) return
    await runAction('Upload Clips', async () => {
      const sessionId = clipState.sessionId
      if (!sessionId) throw new Error('Open a chat before attaching files.')
      const compressionSettings = await getClipCompressionSettings()
      const formData = new FormData()
      files.forEach((file) => formData.append('files', file))
      formData.append('sessionId', sessionId)
      formData.append('compressionSettings', JSON.stringify(compressionSettings))
      formData.append(
        'uploadSettings',
        JSON.stringify({
          strategy: 'local',
          storage_mode: 'local',
          webhookUrl: '',
          webhookAuth: '',
          tunnel_url: '',
          use_https: false,
          tunnel_provider: 'none',
          cloudflared_auto_start: false,
          cloudflared_target_url: ''
        })
      )
      const response = await fetch('/api/uploads/clips', { method: 'POST', body: formData })
      const result = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(
          typeof result?.error === 'string' ? result.error : `Clip upload failed (${response.status}).`
        )
      }
      const clipIds = Array.isArray(result?.files)
        ? result.files
            .map((entry: any) => entry?.clipData?.id)
            .filter((clipId: unknown): clipId is string => typeof clipId === 'string' && Boolean(clipId))
        : []
      if (!clipIds.length) throw new Error('Clip upload returned no attachable files.')
      await clipController.refresh()
      for (const clipId of clipIds) await clipController.attach(clipId)
      dispatchSessionClipStateChanged({ sessionId, source: 'upload' })
      await sendIntent('clips.changed', { sessionId, clipIds })
    })
  }

  function collectDroppedFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.files ?? []).filter((file) => file.size >= 0)
  }

  onMount(() => {
    bridge = getDesktopControlsNativeBridge('controls')
    if (!bridge) {
      error = 'Desktop Controls are available only in the managed Batshit desktop app.'
      return
    }
    shellUnsubscribe = bridge.onState(updateShellState)
    clipUnsubscribe = clipController.subscribe((state) => (clipState = state))
    void bridge
      .invoke('desktopControls.getState')
      .then(updateShellState)
      .then(() => bridge?.invoke('desktopControls.rendererReady'))
      .then((state) => state && updateShellState(state))
      .catch((cause) => {
        error = cause instanceof Error ? cause.message : 'Desktop Controls failed to start.'
      })
  })

  onDestroy(() => {
    shellUnsubscribe?.()
    clipUnsubscribe?.()
    clipController.close()
  })
</script>

<svelte:window
  ondragenter={(event) => {
    if (event.dataTransfer?.types.includes('Files')) draggingFiles = true
  }}
  ondragover={(event) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    draggingFiles = true
  }}
  ondragleave={(event) => {
    if (event.relatedTarget === null) draggingFiles = false
  }}
  ondrop={(event) => {
    event.preventDefault()
    draggingFiles = false
    void uploadFiles(collectDroppedFiles(event))
  }}
/>

<main class:dragging={draggingFiles} class="desktop-controls-root" aria-label="Desktop Controls">
  <div class="desktop-controls-island">
    <div class="desktop-controls-grabber" aria-hidden="true"></div>

    <div class="desktop-controls-clips" aria-label="Attached Clips">
      <input
        bind:this={fileInput}
        class="sr-only"
        type="file"
        multiple
        onchange={(event) => {
          const input = event.currentTarget
          void uploadFiles(Array.from(input.files ?? []))
          input.value = ''
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        disabled={Boolean(busy)}
        aria-label="Attach files to the active chat"
        title="Attach files"
        onclick={() => fileInput?.click()}
      >
        <Paperclip aria-hidden="true" />
      </Button>
      <div class="desktop-controls-clip-list">
        {#if clipState.attachedClips.length}
          {#each clipState.attachedClips.slice(0, 4) as clip (clip.id)}
            <div class="desktop-clip-token" title={clip.filename}>
              {#if clipPreviewUrl(clip)}
                <img src={clipPreviewUrl(clip)} alt="" />
              {:else}
                <Paperclip aria-hidden="true" />
              {/if}
              <button
                type="button"
                aria-label={`Unclip ${clip.filename}`}
                onclick={() => void detachClip(clip.id)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          {/each}
          {#if clipState.attachedClips.length > 4}
            <Badge variant="secondary">+{clipState.attachedClips.length - 4}</Badge>
          {/if}
        {/if}
      </div>
      <div class="desktop-goon-quick-controls" aria-label="Goon quick controls">
        <label
          class:disabled={!goonControls || goonControls.mood.options.length === 0}
          class="desktop-goon-quick-select"
          title={goonControls ? `Mood: ${goonControls.mood.currentLabel}` : 'Mood unavailable'}
        >
          <BatshitIcon id="moods" />
          <select
            bind:value={moodSelection}
            disabled={Boolean(busy) || Boolean(goonControlsEnvelope.pendingAction) || !goonControls || goonControls.mood.options.length === 0}
            aria-label="Select Mood"
            onchange={(event) => selectMood(event.currentTarget.value)}
          >
            <option value="" disabled>Mood</option>
            {#each goonControls?.mood.options ?? [] as option (option.name)}
              <option value={option.name}>
                {option.label}{option.current ? ' • Current' : ''}
              </option>
            {/each}
          </select>
        </label>

        <label
          class:disabled={!goonControls?.closet.available}
          class="desktop-goon-quick-select"
          title={goonControls?.closet.available ? 'Closet quick access' : 'Closet unavailable'}
        >
          <BatshitIcon id="closet" />
          <select
            bind:value={closetSelection}
            disabled={Boolean(busy) || Boolean(goonControlsEnvelope.pendingAction) || !goonControls?.closet.available}
            aria-label="Closet quick access"
            onchange={(event) => selectCloset(event.currentTarget.value)}
          >
            <option value="" disabled>Closet</option>
            {#each goonControls?.closet.groups ?? [] as group (group.key)}
              <optgroup label={group.label}>
                {#each group.options as option (option.key)}
                  <option value={option.key}>
                    {option.label}{option.current ? ' • Current' : ''}
                  </option>
                {/each}
              </optgroup>
            {/each}
          </select>
        </label>

        <label
          class:disabled={!goonControls}
          class="desktop-goon-quick-select"
          title={goonControls
            ? `Quality: ${goonControls.quality.options.find((option) => option.value === goonControls?.quality.current)?.label ?? 'Auto'}`
            : 'Quality unavailable'}
        >
          <Settings2 aria-hidden="true" />
          <select
            bind:value={qualitySelection}
            disabled={Boolean(busy) || Boolean(goonControlsEnvelope.pendingAction) || !goonControls}
            aria-label="Select Goon Quality"
            onchange={(event) => selectQuality(event.currentTarget.value)}
          >
            <option value="" disabled>Quality</option>
            {#each goonControls?.quality.options ?? [] as option (option.value)}
              <option value={option.value}>
                {option.label}{option.value === goonControls?.quality.current ? ' • Current' : ''}
              </option>
            {/each}
          </select>
        </label>

        <Button
          variant={goonControls?.eyeContactEnabled ? 'default' : 'ghost'}
          size="icon"
          disabled={Boolean(busy) || Boolean(goonControlsEnvelope.pendingAction) || !goonControls}
          aria-pressed={goonControls?.eyeContactEnabled ?? false}
          aria-label={goonControls?.eyeContactEnabled ? 'Disable eye contact' : 'Enable eye contact'}
          title={goonControls?.eyeContactEnabled ? 'Disable eye contact' : 'Enable eye contact'}
          onclick={() =>
            void runGoonQuickControl({
              kind: 'eye-contact',
              enabled: !(goonControls?.eyeContactEnabled ?? false)
            })}
        >
          <Eye aria-hidden="true" />
        </Button>
      </div>
    </div>

    <div class="desktop-controls-divider"></div>

    <div class="desktop-controls-voice">
      <Button
        variant={voiceState.active ? 'secondary' : 'ghost'}
        size="icon"
        disabled={Boolean(busy) || !voiceState.ownerAvailable || (!voiceState.active && !voiceState.allowedIntents.includes('start'))}
        aria-label={voiceState.active ? voiceState.label : 'Start Voice Mode'}
        title={voiceState.active ? voiceState.modeLabel : 'Start Voice Mode'}
        onclick={() => void handleVoicePrimary()}
      >
        <AudioLines aria-hidden="true" />
      </Button>
      {#if voiceState.active}
        <Button
          variant="ghost"
          size="icon"
          disabled={Boolean(busy) || !voiceState.allowedIntents.includes('end')}
          aria-label="End Voice Mode"
          title="End Voice Mode"
          onclick={() => void endVoice()}
        >
          <PhoneOff aria-hidden="true" />
        </Button>
      {/if}
    </div>

    <div class="desktop-controls-divider"></div>

    <div class="desktop-controls-segment" role="group" aria-label="Keep the Goon on top">
      <button
        type="button"
        class:is-selected={!preferences.stayOnTop}
        disabled={Boolean(busy)}
        aria-pressed={!preferences.stayOnTop}
        aria-label="Goon stay on top off"
        title="Stay on Top off"
        onclick={() => setStayOnTop('off')}
      >
        <LayersArrowDown aria-hidden="true" />
      </button>
      <button
        type="button"
        class:is-selected={preferences.stayOnTop}
        disabled={Boolean(busy)}
        aria-pressed={preferences.stayOnTop}
        aria-label="Goon stay on top on"
        title="Stay on Top on"
        onclick={() => setStayOnTop('on')}
      >
        <LayersArrowUp aria-hidden="true" />
      </button>
    </div>
    <div
      class="desktop-controls-segment"
      role="group"
      aria-label="Let clicks pass through the Goon"
    >
      <button
        type="button"
        class:is-selected={!preferences.clickThrough}
        disabled={Boolean(busy)}
        aria-pressed={!preferences.clickThrough}
        aria-label="Adjust the Goon"
        title="Adjust Goon"
        onclick={() => setClickThrough('off')}
      >
        <Hand aria-hidden="true" />
      </button>
      <button
        type="button"
        class:is-selected={preferences.clickThrough}
        disabled={Boolean(busy)}
        aria-pressed={preferences.clickThrough}
        aria-label="Lock the Goon and let clicks pass through"
        title="Lock Goon"
        onclick={() => setClickThrough('on')}
      >
        <Lock aria-hidden="true" />
      </button>
    </div>
    <Button
      variant={shellState?.adjustActive ? 'default' : 'ghost'}
      size="icon"
      disabled={Boolean(busy)}
      aria-pressed={shellState?.adjustActive ?? false}
      aria-label="Adjust the Desktop Goon"
      title="Adjust Goon position, size, and camera"
      onclick={() => void toggleAdjust()}
    >
      <Move3d aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      disabled={Boolean(busy)}
      aria-label="Close the Desktop Goon"
      title="Close Desktop Goon"
      onclick={() => void runAction('Close Desktop Goon', async () => {
        await sendIntent('desktop.close', { reason: 'controls-island' })
      })}
    >
      <MonitorX aria-hidden="true" />
    </Button>
  </div>

  {#if draggingFiles}
    <div class="desktop-controls-drop-overlay">
      <ArrowDownToLine aria-hidden="true" />
      <span>Clip to chat</span>
    </div>
  {/if}
  {#if error || clipState.error || voiceState.intentError || goonControlsEnvelope.error}
    <div class="desktop-controls-error" role="alert">
      {error ?? clipState.error?.message ?? voiceState.intentError?.message ?? goonControlsEnvelope.error}
    </div>
  {/if}
</main>

<style>
  :global(html.batshit-desktop-controls-surface),
  :global(body.batshit-desktop-controls-surface) {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent !important;
  }

  .desktop-controls-root {
    position: relative;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    color: hsl(var(--foreground));
    user-select: none;
  }

  .desktop-controls-island {
    position: relative;
    width: 100%;
    min-width: 0;
    height: 60px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 8px 8px 11px;
    border: 1px solid color-mix(in srgb, hsl(var(--border)) 78%, transparent);
    border-radius: 20px;
    background: color-mix(in srgb, hsl(var(--background)) 93%, transparent);
    box-shadow: 0 16px 36px rgb(0 0 0 / 0.35), inset 0 1px rgb(255 255 255 / 0.04);
    backdrop-filter: blur(24px) saturate(135%);
    -webkit-app-region: drag;
  }

  .desktop-controls-island :global(button),
  .desktop-controls-island :global(input),
  .desktop-controls-island :global(select) {
    -webkit-app-region: no-drag;
  }

  .desktop-controls-grabber {
    width: 4px;
    height: 22px;
    border-radius: 999px;
    background: hsl(var(--muted-foreground) / 0.28);
    flex: 0 0 auto;
  }

  .desktop-controls-clips,
  .desktop-controls-voice {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .desktop-controls-clips {
    flex: 1 1 auto;
  }

  .desktop-controls-voice {
    flex: 0 1 auto;
  }

  .desktop-controls-clip-list {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }

  .desktop-goon-quick-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }

  .desktop-goon-quick-select {
    position: relative;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    border-radius: 0.375rem;
    color: hsl(var(--foreground));
  }

  .desktop-goon-quick-select:hover:not(.disabled) {
    background: hsl(var(--accent));
    color: hsl(var(--accent-foreground));
  }

  .desktop-goon-quick-select.disabled {
    opacity: 0.5;
  }

  .desktop-goon-quick-select > :global(svg) {
    width: 16px;
    height: 16px;
    pointer-events: none;
  }

  .desktop-goon-quick-select > select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    appearance: none;
    border: 0;
    border-radius: inherit;
    background: transparent;
    color: transparent;
    font-size: 0;
    cursor: pointer;
  }

  .desktop-goon-quick-select > select:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px hsl(var(--ring));
  }

  .desktop-goon-quick-select > select:disabled {
    cursor: not-allowed;
  }

  .desktop-goon-quick-select > select option,
  .desktop-goon-quick-select > select optgroup {
    color: CanvasText;
    font-size: 13px;
  }

  .desktop-controls-divider {
    width: 1px;
    height: 24px;
    background: hsl(var(--border) / 0.8);
    flex: 0 0 auto;
    margin: 0 2px;
  }

  .desktop-clip-token {
    position: relative;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    overflow: visible;
    border-radius: 10px;
    border: 1px solid hsl(var(--border));
    background: hsl(var(--muted));
  }

  .desktop-clip-token > img,
  .desktop-clip-token > :global(svg) {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 9px;
    padding: 0;
  }

  .desktop-clip-token > :global(svg) {
    padding: 8px;
  }

  .desktop-clip-token > button {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 15px;
    height: 15px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: hsl(var(--destructive));
    color: hsl(var(--destructive-foreground));
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.35);
  }

  .desktop-clip-token > button :global(svg) {
    width: 10px;
    height: 10px;
  }

  .desktop-controls-drop-overlay {
    position: absolute;
    inset: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px dashed hsl(var(--primary));
    border-radius: 20px;
    background: hsl(var(--background) / 0.94);
    color: hsl(var(--primary));
    font-size: 13px;
    font-weight: 650;
    pointer-events: none;
  }

  .desktop-controls-error {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: hsl(var(--destructive));
    pointer-events: none;
  }

  :global(.desktop-controls-island .bs-button) {
    min-width: 34px;
    height: 34px;
    padding: 0 9px;
    border-radius: 11px;
  }

  :global(.desktop-controls-island .bs-button svg) {
    width: 15px;
    height: 15px;
  }

  :global(.desktop-controls-island .desktop-controls-segment) {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    overflow: hidden;
    border: 1px solid var(--input);
    border-radius: 11px;
    background: color-mix(in oklab, var(--background) 72%, transparent);
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.16),
      inset 0 1px rgb(255 255 255 / 0.025);
    -webkit-app-region: no-drag;
  }

  .desktop-controls-segment > button {
    width: 27px;
    min-width: 27px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-left: 1px solid var(--input);
    border-radius: 0;
    background: transparent;
    color: var(--muted-foreground);
    transition:
      color 150ms ease-out,
      background-color 150ms ease-out;
  }

  .desktop-controls-segment > button:first-child {
    border-left: 0;
  }

  .desktop-controls-segment > button:hover:not(:disabled) {
    background: var(--accent);
    color: var(--foreground);
  }

  .desktop-controls-segment > button.is-selected {
    background: color-mix(in oklab, var(--primary) 52%, var(--secondary));
    color: var(--primary-foreground);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 72%, transparent);
  }

  .desktop-controls-segment > button:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  .desktop-controls-segment > button:disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .desktop-controls-segment > button :global(svg) {
    width: 15px;
    height: 15px;
  }
</style>

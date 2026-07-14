<script module lang="ts">
  import type { GoonFileRef as PreviewVideoFileRef, GoonRecord as PreviewGoonRecord } from '$lib/types/goons'
  import type { GoonEngine as PreviewGenerationEngine } from '$lib/goons/engine'
  import {
    loadAvatarIntoEngine,
    loadCustomAvatarManifest,
    resolveGoonAvatarUrl
  } from '$lib/goons/customAvatar'

  // Per-lane preview target: .vrma clips preview on a VRM goon URL (stunt
  // dummy), .glb clips bind by skeleton node names, so they need either the
  // bundled BSRigV2 GLB stunt dummy ('custom-url') or a real GLB-lane custom
  // Goon record ('custom'). No cross-lane fallback — a missing target must
  // surface as an explicit error, never a frozen wrong-lane video.
  export type MotionPreviewTarget =
    | { kind: 'vrm'; url: string }
    | { kind: 'custom'; goon: PreviewGoonRecord }
    | { kind: 'custom-url'; modelUrl: string; manifestUrl: string }

  export function resolveMotionPreviewTargetKey(target: MotionPreviewTarget | null | undefined) {
    if (!target) return ''
    if (target.kind === 'vrm') return target.url
    if (target.kind === 'custom-url') return target.modelUrl
    return resolveGoonAvatarUrl(target.goon) ?? ''
  }

  const PREVIEW_THUMB_WIDTH = 120
  const PREVIEW_THUMB_HEIGHT = 164
  const previewGenerationJobs = new Map<string, Promise<PreviewVideoFileRef | null>>()
  let previewGenerationQueue: Promise<void> = Promise.resolve()
  let previewGenerationHost: HTMLDivElement | null = null
  let previewGenerationEngine: PreviewGenerationEngine | null = null
  let previewGenerationEnginePromise: Promise<PreviewGenerationEngine> | null = null
  let previewGenerationLoadedGoonUrl = ''
  let previewGenerationDisposeTimer: ReturnType<typeof setTimeout> | null = null

  function clearPreviewGenerationDisposeTimer() {
    if (previewGenerationDisposeTimer) {
      clearTimeout(previewGenerationDisposeTimer)
      previewGenerationDisposeTimer = null
    }
  }

  function schedulePreviewGenerationEngineDispose() {
    clearPreviewGenerationDisposeTimer()
    if (previewGenerationJobs.size > 0) return
    previewGenerationDisposeTimer = setTimeout(() => {
      previewGenerationDisposeTimer = null
      if (previewGenerationJobs.size > 0) return
      previewGenerationEngine?.dispose()
      previewGenerationEngine = null
      previewGenerationEnginePromise = null
      previewGenerationLoadedGoonUrl = ''
      previewGenerationHost?.remove()
      previewGenerationHost = null
    }, 5000)
  }

  function ensurePreviewGenerationHost() {
    if (previewGenerationHost) return previewGenerationHost
    const host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.left = '-9999px'
    host.style.top = '-9999px'
    host.style.width = `${PREVIEW_THUMB_WIDTH}px`
    host.style.height = `${PREVIEW_THUMB_HEIGHT}px`
    host.style.opacity = '0'
    host.style.pointerEvents = 'none'
    document.body.appendChild(host)
    previewGenerationHost = host
    return host
  }

  async function ensureSharedPreviewGenerationEngine(target: MotionPreviewTarget) {
    clearPreviewGenerationDisposeTimer()

    if (!previewGenerationEnginePromise) {
      previewGenerationEnginePromise = (async () => {
        const host = ensurePreviewGenerationHost()
        const module = await import('$lib/goons/engine')
        const engine = new module.GoonEngine(host, {
          quality: 'low',
          lipSyncEnabled: false
        })
        await engine.init()
        previewGenerationEngine = engine
        return engine
      })().catch((error) => {
        previewGenerationEngine?.dispose()
        previewGenerationEngine = null
        previewGenerationEnginePromise = null
        previewGenerationLoadedGoonUrl = ''
        previewGenerationHost?.remove()
        previewGenerationHost = null
        throw error
      })
    }

    const engine = previewGenerationEngine ?? await previewGenerationEnginePromise
    const targetKey = resolveMotionPreviewTargetKey(target)
    if (!targetKey) {
      throw new Error('Preview Goon is missing its model file')
    }
    if (previewGenerationLoadedGoonUrl !== targetKey) {
      if (target.kind === 'custom') {
        await loadAvatarIntoEngine(engine, target.goon)
      } else if (target.kind === 'custom-url') {
        const manifest = await loadCustomAvatarManifest({
          url: target.manifestUrl,
          filename: target.manifestUrl.split('/').pop() || 'avatar.json'
        })
        await engine.loadCustomGoon(target.modelUrl, manifest)
      } else {
        await engine.loadGoon(target.url)
      }
      previewGenerationLoadedGoonUrl = targetKey
    }
    return engine
  }

  function queuePreviewGeneration<T>(task: () => Promise<T>): Promise<T> {
    const next = previewGenerationQueue.then(task, task)
    previewGenerationQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  export function getQueuedPreviewGeneration(
    key: string,
    task: () => Promise<PreviewVideoFileRef | null>
  ): Promise<PreviewVideoFileRef | null> {
    clearPreviewGenerationDisposeTimer()
    const existing = previewGenerationJobs.get(key)
    if (existing) return existing

    const job = queuePreviewGeneration(async () => {
      try {
        return await task()
      } finally {
        previewGenerationJobs.delete(key)
        schedulePreviewGenerationEngineDispose()
      }
    })

    previewGenerationJobs.set(key, job)
    return job
  }
</script>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { RefreshCw } from '@lucide/svelte'
  import { uploadGoonAnimationPreview } from '$lib/services/goons'
  import {
    GOON_MOTION_PREVIEW_GENERATION_LIMIT,
    endGoonMotionPreviewGeneration,
    goonMotionPreviewGenerationCount,
    tryBeginGoonMotionPreviewGeneration
  } from '$lib/stores/goonMotionPreviewGeneration'
  import { sanitizeGoonAnimationName } from '$lib/goons/animationLoadPlan'
  import type { GoonFileRef } from '$lib/types/goons'

  const previewThumbWidth = 120
  const previewThumbHeight = 164

  let {
    previewTarget = null,
    previewUnavailableReason = '',
    animationFile = null,
    animationName = '',
    active = false,
    previewId = '',
    containerOpen = true,
    warmOnOpen = false,
    onRequestPlay = (_id: string) => {}
  } = $props<{
    previewTarget?: MotionPreviewTarget | null
    previewUnavailableReason?: string
    animationFile?: GoonFileRef | null
    animationName?: string
    active?: boolean
    previewId?: string
    containerOpen?: boolean
    warmOnOpen?: boolean
    onRequestPlay?: (id: string) => void
  }>()

  let cardEl = $state<HTMLDivElement | null>(null)
  let videoEl = $state<HTMLVideoElement | null>(null)
  let visible = $state(false)
  let loading = $state(false)
  let generating = $state(false)
  let error = $state<string | null>(null)
  let previewVideoUrl = $state('')
  let previewVideoFilename = $state('')
  let observer: IntersectionObserver | null = null
  let destroyed = false
  const shouldWarmPreview = $derived(containerOpen && warmOnOpen)

  function syncPreviewVideoFromRecord() {
    const nextUrl = animationFile?.previewVideo?.url ?? ''
    const nextFilename = animationFile?.previewVideo?.filename ?? ''
    if (nextUrl && nextUrl !== previewVideoUrl) {
      previewVideoUrl = nextUrl
      previewVideoFilename = nextFilename
      error = null
    } else if (!nextUrl && previewVideoFilename === nextFilename) {
      previewVideoUrl = ''
      previewVideoFilename = ''
    }
  }

  function resolveRecorderMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ]

    for (const candidate of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
        return candidate
      }
    }
    return null
  }

  function sanitizePreviewBaseName(value: string) {
    return sanitizeGoonAnimationName(value, 'motion_preview').slice(0, 80)
  }

  async function waitForAnimationWarmup() {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
  }

  async function recordPreviewBlob(canvas: HTMLCanvasElement) {
    if (typeof canvas.captureStream !== 'function') {
      throw new Error('Preview capture is not supported in this browser')
    }

    const mimeType = resolveRecorderMimeType()
    if (!mimeType) {
      throw new Error('Video recording is not supported in this browser')
    }

    const stream = canvas.captureStream(24)
    const chunks: BlobPart[] = []

    try {
      await new Promise<void>((resolve, reject) => {
        const recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 900_000
        })

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data)
          }
        }
        recorder.onerror = () => {
          reject(new Error('Preview recording failed'))
        }
        recorder.onstop = () => resolve()

        recorder.start()
        setTimeout(() => recorder.stop(), 2200)
      })
    } finally {
      for (const track of stream.getTracks()) {
        track.stop()
      }
    }

    if (chunks.length === 0) {
      throw new Error('Preview recording produced no video data')
    }

    return {
      blob: new Blob(chunks, { type: mimeType }),
      mimeType
    }
  }

  const previewTargetKey = $derived.by(() => resolveMotionPreviewTargetKey(previewTarget))

  async function buildPreviewVideoFile() {
    if (!previewTarget || !previewTargetKey || !animationFile?.url || !animationFile.filename) {
      throw new Error(previewUnavailableReason || 'Preview source is missing')
    }

    const engine = await ensureSharedPreviewGenerationEngine(previewTarget)
    await engine.syncAnimations([animationFile])
    engine.setGoonVisible(true)

    const availableNames = engine.getAnimationNames()
    const nameToPlay =
      (animationName && availableNames.includes(animationName) && animationName) ||
      availableNames[0] ||
      ''

    if (!nameToPlay) {
      throw new Error('No preview animation available')
    }

    engine.previewLoopAnimation(nameToPlay)
    await waitForAnimationWarmup()

    const canvas = engine.getCanvasElement()
    if (!canvas) {
      throw new Error('Preview canvas unavailable')
    }

    const { blob, mimeType } = await recordPreviewBlob(canvas)
    const extension = mimeType.includes('mp4') ? '.mp4' : '.webm'
    const previewFile = new File(
      [blob],
      `${sanitizePreviewBaseName(animationFile.originalName || animationFile.filename || animationName)}${extension}`,
      { type: mimeType }
    )

    const { previewVideo } = await uploadGoonAnimationPreview(animationFile.filename, previewFile)
    return previewVideo
  }

  async function ensurePreviewVideo() {
    syncPreviewVideoFromRecord()
    if (previewVideoUrl || generating || (!visible && !shouldWarmPreview) || !animationFile?.url) {
      return
    }
    if (!previewTargetKey) {
      error = previewUnavailableReason || 'Preview Goon unavailable'
      return
    }
    if (!tryBeginGoonMotionPreviewGeneration()) return

    const previewKey = `${previewTargetKey}::${animationFile.url}::${animationFile.filename || animationName}`
    generating = true
    loading = true
    error = null

    try {
      const previewVideo = await getQueuedPreviewGeneration(previewKey, async () => {
        if (destroyed || (!visible && !shouldWarmPreview) || previewVideoUrl) {
          return null
        }
        return await buildPreviewVideoFile()
      })
      if (!previewVideo?.url) {
        syncPreviewVideoFromRecord()
        return
      }
      previewVideoUrl = previewVideo.url
      previewVideoFilename = previewVideo.filename
      error = null
    } catch (err) {
      error = err instanceof Error ? err.message : 'Preview unavailable'
    } finally {
      endGoonMotionPreviewGeneration()
      generating = false
      loading = false
    }
  }

  async function regeneratePreviewVideo() {
    syncPreviewVideoFromRecord()
    if (generating || !animationFile?.url || !animationFile?.filename) return
    if (!previewTargetKey) {
      error = previewUnavailableReason || 'Preview Goon unavailable'
      return
    }
    if (!tryBeginGoonMotionPreviewGeneration()) return

    generating = true
    loading = true
    error = null
    previewVideoUrl = ''
    previewVideoFilename = ''

    try {
      const previewKey = `${previewTargetKey}::${animationFile.url}::${animationFile.filename || animationName}::refresh`
      const previewVideo = await getQueuedPreviewGeneration(previewKey, async () => {
        if (destroyed || !visible) {
          return null
        }
        return await buildPreviewVideoFile()
      })
      if (!previewVideo?.url) {
        syncPreviewVideoFromRecord()
        return
      }
      previewVideoUrl = previewVideo.url
      previewVideoFilename = previewVideo.filename
      error = null
    } catch (err) {
      error = err instanceof Error ? err.message : 'Preview unavailable'
    } finally {
      endGoonMotionPreviewGeneration()
      generating = false
      loading = false
    }
  }

  function handleSelect() {
    if (!previewId) return
    onRequestPlay(previewId)
  }

  function handleRefreshClick(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    void regeneratePreviewVideo()
  }

  function updateVisibleFromViewport() {
    if (!cardEl || !containerOpen) {
      visible = false
      return
    }

    const rect = cardEl.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const intersects =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth

    visible = intersects
  }

  onMount(() => {
    if (!cardEl) return
    observer = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting)
      },
      { threshold: 0.15 }
    )
    observer.observe(cardEl)
  })

  onDestroy(() => {
    destroyed = true
    observer?.disconnect()
  })

  $effect(() => {
    syncPreviewVideoFromRecord()
  })

  $effect(() => {
    if (!containerOpen) {
      visible = false
      return
    }

    let cancelled = false
    const run = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (cancelled) return
      updateVisibleFromViewport()
    }

    void run()

    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const pendingGenerationCount = $goonMotionPreviewGenerationCount
    if (!visible) {
      videoEl?.pause()
      return
    }
    if (!previewVideoUrl) {
      const previewGenerationCapacityReached =
        pendingGenerationCount >= GOON_MOTION_PREVIEW_GENERATION_LIMIT
      if (previewGenerationCapacityReached && !generating) {
        return
      }
      void ensurePreviewVideo()
      return
    }
    const video = videoEl
    if (!video) return
    video.currentTime = 0
    void video.play().catch(() => {})
  })
</script>

<div
  bind:this={cardEl}
  class="animation-preview-thumb"
  data-active={active}
  style={`width:${previewThumbWidth}px;height:${previewThumbHeight}px;`}
>
  {#if (visible || shouldWarmPreview) && previewVideoUrl}
    <video
      bind:this={videoEl}
      class="animation-preview-thumb-video"
      src={previewVideoUrl}
      autoplay
      loop
      muted
      playsinline
      preload="metadata"
    ></video>
  {/if}

  {#if loading || generating}
    <div class="animation-preview-thumb-overlay animation-preview-thumb-overlay-loading">
      Preparing…
    </div>
  {:else if error}
    <div class="animation-preview-thumb-overlay animation-preview-thumb-overlay-error" title={error}>
      {previewUnavailableReason && error === previewUnavailableReason ? error : 'Preview unavailable'}
    </div>
  {:else if !previewVideoUrl && !previewTargetKey}
    <div
      class="animation-preview-thumb-overlay animation-preview-thumb-overlay-error"
      title={previewUnavailableReason || 'Preview Goon unavailable'}
    >
      {previewUnavailableReason || 'Preview Goon unavailable'}
    </div>
  {:else if !previewVideoUrl}
    <div class="animation-preview-thumb-overlay animation-preview-thumb-overlay-waiting">
      Waiting…
    </div>
  {/if}

  {#if animationFile?.url}
    <button
      type="button"
      class="animation-preview-thumb-refresh"
      aria-label="Recreate motion preview video"
      title="Recreate preview video"
      onclick={handleRefreshClick}
      disabled={generating || !previewTargetKey}
    >
      <RefreshCw class="animation-preview-thumb-refresh-icon" data-spinning={generating} />
    </button>
  {/if}

  <button
    type="button"
    class="animation-preview-thumb-select"
    onclick={handleSelect}
    aria-label="Select motion preview"
    disabled={!animationFile}
  ></button>
</div>

<style>
  .animation-preview-thumb {
    position: relative;
    flex-shrink: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: oklch(from var(--muted) l c h / 0.3);
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
  }

  .animation-preview-thumb:hover {
    border-color: oklch(from var(--primary) l c h / 0.5);
  }

  .animation-preview-thumb[data-active="true"] {
    box-shadow:
      0 0 0 2px var(--primary),
      0 0 0 4px var(--background);
  }

  .animation-preview-thumb-video,
  .animation-preview-thumb-overlay,
  .animation-preview-thumb-select {
    position: absolute;
    inset: 0;
  }

  .animation-preview-thumb-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .animation-preview-thumb-overlay {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.625rem;
  }

  .animation-preview-thumb-overlay-loading {
    background: oklch(0.05 0 0 / 0.2);
    color: oklch(0.92 0.006 289 / 0.8);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .animation-preview-thumb-overlay-error {
    background: oklch(0.05 0 0 / 0.2);
    color: oklch(0.72 0.16 20);
    padding-inline: 8px;
    text-align: center;
  }

  .animation-preview-thumb-overlay-waiting {
    background: oklch(0.05 0 0 / 0.1);
    color: var(--muted-foreground);
  }

  .animation-preview-thumb-refresh {
    position: absolute;
    right: 4px;
    bottom: 4px;
    z-index: 20;
    display: inline-flex;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    border: 1px solid oklch(from var(--border) l c h / 0.7);
    border-radius: 999px;
    background: oklch(from var(--background) l c h / 0.85);
    color: var(--foreground);
    opacity: 0;
    box-shadow: 0 1px 2px oklch(from var(--background) l c h / 0.35);
    transition: background-color 0.16s ease, opacity 0.16s ease;
  }

  .animation-preview-thumb:hover .animation-preview-thumb-refresh,
  .animation-preview-thumb-refresh:focus-visible {
    opacity: 1;
  }

  .animation-preview-thumb-refresh:hover {
    background: var(--background);
  }

  :global(.animation-preview-thumb-refresh-icon) {
    width: 14px;
    height: 14px;
  }

  :global(.animation-preview-thumb-refresh-icon[data-spinning="true"]) {
    animation: animation-preview-spin 1s linear infinite;
  }

  .animation-preview-thumb-select {
    z-index: 10;
  }

  @keyframes animation-preview-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

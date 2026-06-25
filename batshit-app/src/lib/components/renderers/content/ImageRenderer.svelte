<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { page } from '$app/state'
  import { toast } from 'svelte-sonner'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { downloadBlob } from '$lib/utils/download'
  import { Copy, Download, ImageOff, Loader2, Maximize2, Plus } from '@lucide/svelte'
  
  let { 
    src, 
    alt = '', 
    title,
    width,
    height,
    clipId,
    sessionId,
    fullResolutionSrc,
    filename
  } = $props<{ 
    src: string
    alt?: string
    title?: string
    width?: number
    height?: number
    clipId?: string
    sessionId?: string
    fullResolutionSrc?: string
    filename?: string
  }>()
  
  let loading = $state(true)
  let error = $state(false)
  let naturalWidth = $state(0)
  let naturalHeight = $state(0)
  let actualSrc = $state('')
  let resolvedFullResolutionSrc = $state('')
  let isSaving = $state(false)
  let savedClipId = $state<string | null>(null)
  let previewOpen = $state(false)

  function extractUrlScheme(value: string): string | null {
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(value)
    return match?.[1]?.toLowerCase() ?? null
  }

  function isLikelyFilesystemPath(value: string): boolean {
    const trimmed = value.trim()
    const lower = trimmed.toLowerCase()

    if (!trimmed) return false
    if (/^[a-z]:[\\/]/i.test(trimmed)) return true
    if (lower.startsWith('\\\\')) return true
    if (lower.startsWith('file://')) return true
    if (
      lower.startsWith('/var/') ||
      lower.startsWith('/private/') ||
      lower.startsWith('/tmp/') ||
      lower.startsWith('/users/') ||
      lower.startsWith('/volumes/') ||
      lower.startsWith('/home/') ||
      lower.startsWith('/root/')
    ) {
      return true
    }
    return false
  }

  function isUnsupportedImageScheme(value: string | null | undefined): boolean {
    if (!value || typeof value !== 'string') return false
    const trimmed = value.trim()
    if (isLikelyFilesystemPath(trimmed)) return true
    const scheme = extractUrlScheme(trimmed)
    if (!scheme) return false
    return !['http', 'https', 'data', 'blob'].includes(scheme)
  }
  
  // Check if this is an SVG (by URL extension or data URI)
  const isSvg = $derived(
    actualSrc?.toLowerCase().endsWith('.svg') || 
    actualSrc?.startsWith('data:image/svg+xml')
  )
  const canSaveToClip = $derived(
    !clipId &&
    !savedClipId &&
    typeof actualSrc === 'string' &&
    actualSrc.startsWith('data:image/')
  )

  const actionSrc = $derived.by(() => fullResolutionSrc || resolvedFullResolutionSrc || actualSrc)

  function applyImageSource(value: string) {
    actualSrc = value
    const unsupported = isUnsupportedImageScheme(value)
    error = unsupported
    loading = !unsupported
  }
  
  $effect(() => {
    if (src && src !== '') {
      applyImageSource(src)
      return
    }

    if (!clipId) {
      loading = false
      error = true
    }
  })

  // If this image is backed by a Clip, fetch the clip record so hover actions can
  // use the original/full-resolution URL even when the displayed preview is resized.
  $effect(() => {
    const id = clipId
    const userId = page.data.user?.id
    if (!id || !userId || (src && fullResolutionSrc)) return

    const controller = new AbortController()

    fetch(`/api/clips/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Clip fetch failed: ${response.status}`)
        }
        const clipData = await response.json()
        resolvedFullResolutionSrc = clipData.fullResolutionUrl || ''

        if (!src || src === '') {
          const clipUrl = clipData.displayUrl || clipData.externalUrl || clipData.localUrl || ''
          if (clipUrl) {
            applyImageSource(clipUrl)
          } else {
            loading = false
            error = true
          }
        }
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        console.error('[ImageRenderer] Failed to fetch clip:', e)
        if (!src || src === '') {
          loading = false
          error = true
        }
      })

    return () => controller.abort()
  })
  
  function handleLoad(e: Event) {
    const img = e.target as HTMLImageElement
    naturalWidth = img.naturalWidth
    naturalHeight = img.naturalHeight
    loading = false
  }
  
  function handleError(e: Event) {
    console.error('[ImageRenderer] Failed to load image:', actualSrc)
    console.error('[ImageRenderer] Error event:', e)
    console.error('[ImageRenderer] Debug info:', {
      srcLength: actualSrc?.length,
      srcStart: actualSrc?.substring(0, 100),
      srcType: typeof actualSrc,
      hasDataUrl: actualSrc?.startsWith('data:'),
      hasHttp: actualSrc?.startsWith('http'),
      isEmpty: !actualSrc || actualSrc === '',
      clipId: clipId
    })
    loading = false
    error = true
  }
  
  function openQuickView() {
    if (!actionSrc) return
    previewOpen = true
  }
  
  async function copyImageUrl() {
    try {
      await copyTextToClipboard(actionSrc || actualSrc)
      toast.success('Image URL copied')
    } catch (err) {
      console.error('Failed to copy URL:', err)
      toast.error('Failed to copy image URL')
    }
  }

  function resolveExtension(mimeType: string) {
    const normalized = mimeType.toLowerCase()
    if (normalized.includes('png')) return 'png'
    if (normalized.includes('jpeg')) return 'jpg'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('gif')) return 'gif'
    if (normalized.includes('svg')) return 'svg'
    return 'png'
  }

  function resolveMimeFromDataUrl(value: string) {
    const match = /^data:([^;,]+)[;,]/i.exec(value)
    return match?.[1] || ''
  }

  function resolveExtensionFromUrl(value: string) {
    try {
      const pathname = value.startsWith('data:') ? '' : new URL(value, window.location.href).pathname
      const extension = pathname.split('.').pop()?.toLowerCase() || ''
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp'].includes(extension)) {
        return extension === 'jpeg' ? 'jpg' : extension
      }
    } catch {
      // Fall back to MIME/data handling below.
    }
    const mimeType = resolveMimeFromDataUrl(value)
    return mimeType ? resolveExtension(mimeType) : 'png'
  }

  function resolveDownloadName(source: string) {
    const rawBase = filename || title || alt || 'batshit-image'
    const safeBase = rawBase
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'batshit-image'
    return `${safeBase}.${resolveExtensionFromUrl(source)}`
  }

  function triggerDownload(url: string, downloadName: string) {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = downloadName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  }

  async function downloadImage() {
    const source = actionSrc || actualSrc
    if (!source) return
    const downloadName = resolveDownloadName(source)

    try {
      const response = await fetch(source)
      if (!response.ok) throw new Error(`Download failed: ${response.status}`)
      const blob = await response.blob()
      await downloadBlob(blob, downloadName, {
        title: 'Download Image',
        mimeType: blob.type || 'image/png'
      })
    } catch (err) {
      console.error('[ImageRenderer] Falling back to direct image download link:', err)
      triggerDownload(source, downloadName)
    }
  }

  async function saveToClipVault() {
    if (!canSaveToClip || isSaving) return

    const pageData = page.data
    const userId = pageData?.user?.id
    if (!userId) {
      toast.error('Please sign in to save to the Clip Vault.')
      return
    }

    isSaving = true
    const savingToast = toast.loading('Uploading image to Clip Vault...')

    try {
      const response = await fetch(actualSrc)
      const blob = await response.blob()
      const mimeType = blob.type || 'image/png'
      const extension = resolveExtension(mimeType)
      const filename = `batshit-image-${Date.now()}.${extension}`

      const file = new File([blob], filename, { type: mimeType })
      const formData = new FormData()
      formData.append('files', file)

      if (sessionId) {
        formData.append('sessionId', sessionId)
      }
      formData.append('userId', userId)

      const uiSettings = pageData?.userSettings?.ui_settings || {}
      const compressionSettings = {
        compress_images: uiSettings.compress_images !== false,
        compression_quality: uiSettings.compression_quality || 40,
        max_image_size: uiSettings.max_image_size || '1024',
        force_jpeg: uiSettings.force_jpeg !== false
      }

      formData.append('compressionSettings', JSON.stringify(compressionSettings))
      formData.append('uploadSettings', JSON.stringify({
        strategy: 'local',
        storage_mode: 'local',
        webhookUrl: '',
        webhookAuth: '',
        tunnel_url: '',
        use_https: false,
        tunnel_provider: 'none',
        cloudflared_auto_start: false,
        cloudflared_target_url: ''
      }))

      const uploadResponse = await fetch('/api/uploads/clips', {
        method: 'POST',
        body: formData
      })

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.statusText}`)
      }

      const result = await uploadResponse.json()
      const savedClip = Array.isArray(result?.files)
        ? result.files.find((file: any) => file?.clipData?.id)
        : null

      if (!savedClip?.clipData?.id) {
        throw new Error('Clip Vault did not return a clip ID')
      }

      savedClipId = savedClip.clipData.id
      const clipStorageMode = savedClip.clipData.storageMode || 'local'
      const returnedTokens = savedClip.clipData.tokens
      const clip = {
        id: savedClip.clipData.id,
        filename: savedClip.originalName || filename,
        externalUrl: savedClip.externalUrl,
        displayUrl: savedClip.displayUrl,
        localUrl: savedClip.localUrl || savedClip.url,
        externalTokens:
          savedClip.externalTokens ??
          savedClip.clipData.externalTokens ??
          returnedTokens ??
          765,
        localTokens:
          savedClip.localTokens ??
          savedClip.clipData.localTokens ??
          returnedTokens ??
          765,
        storageMode: clipStorageMode,
        uploadedAt: new Date().toISOString(),
        isClipped: Boolean(sessionId)
      }

      if (sessionId) {
        try {
          await fetch('/api/session-clips/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              clipId: clip.id,
              action: 'attach'
            })
          })
        } catch (attachError) {
          console.error('[ImageRenderer] Failed to auto-clip upload:', attachError)
        }
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('batshit:clip-uploaded', {
          detail: {
            clip,
            sessionId,
            autoClip: Boolean(sessionId)
          }
        }))
      }
      toast.dismiss(savingToast)
      toast.success('Uploaded to Clip Vault')
    } catch (err) {
      console.error('[ImageRenderer] Failed to save image to clip vault:', err)
      toast.dismiss(savingToast)
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      isSaving = false
    }
  }
</script>

<div class="image-container">
  {#if loading && !error}
    <div class="loading-placeholder">
      <div class="spinner"></div>
      <span>Loading image...</span>
    </div>
  {/if}
  
  {#if error}
    <div class="error-placeholder">
      <ImageOff size={48} />
      <span>Failed to load image</span>
      {#if actualSrc && !isUnsupportedImageScheme(actualSrc)}
        <a href={actualSrc} target="_blank" class="error-link">Open URL</a>
      {:else if actualSrc && isUnsupportedImageScheme(actualSrc)}
        <span class="error-link">Unsupported image URL scheme</span>
      {/if}
    </div>
  {/if}

  {#if !error && actualSrc && !isUnsupportedImageScheme(actualSrc)}
    <img 
      src={actualSrc} 
      {alt}
      {title}
      {width}
      {height}
      onload={handleLoad}
      onerror={handleError}
      class:loading
      class:svg-image={isSvg && !width && !height}
    />
    
    {#if !loading}
      <div class="image-overlay">
        <div class="image-info">
          {naturalWidth} × {naturalHeight}
        </div>
        <div class="image-actions">
          <Button
            variant="ghost"
            size="sm"
            onclick={openQuickView}
            class="action-button"
            aria-label="Quick view image"
            title="Quick view image"
          >
            <Maximize2 size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onclick={copyImageUrl}
            class="action-button"
            aria-label="Copy full-resolution image URL"
            title="Copy full-resolution image URL"
          >
            <Copy size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onclick={downloadImage}
            class="action-button"
            aria-label="Download full-resolution image"
            title="Download full-resolution image"
          >
            <Download size={16} />
          </Button>
          {#if canSaveToClip}
            <Button
              variant="ghost"
              size="sm"
              onclick={saveToClipVault}
              class="action-button"
              disabled={isSaving}
              aria-label="Upload to Clip Vault"
            >
              {#if isSaving}
                <Loader2 size={16} class="animate-spin" />
              {:else}
                <Plus size={16} />
              {/if}
            </Button>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<Dialog.Root bind:open={previewOpen}>
  <Dialog.Content class="image-preview-dialog">
    <Dialog.Header>
      <Dialog.Title>{title || alt || filename || 'Image'}</Dialog.Title>
      <Dialog.Description>
        {#if naturalWidth && naturalHeight}
          {naturalWidth} × {naturalHeight}
        {:else}
          Full-resolution image preview
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if actionSrc}
      <div class="image-preview-shell">
        <img src={actionSrc} alt={alt || title || filename || 'Image'} class="image-preview-full" />
      </div>
    {/if}

    <Dialog.Footer class="image-preview-footer">
      <Button variant="outline" onclick={copyImageUrl}>
        <Copy size={15} />
        Copy URL
      </Button>
      <Button variant="outline" onclick={downloadImage}>
        <Download size={15} />
        Download
      </Button>
      <Button onclick={() => (previewOpen = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .image-container {
    position: relative;
    display: inline-block;
    max-width: 100%;
    margin: 0.75rem 0;
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--muted);
  }
  
  img {
    display: block;
    max-width: 100%;
    height: auto;
    border-radius: var(--radius);
    transition: opacity 0.2s ease;
  }
  
  img.loading {
    opacity: 0;
  }
  
  /* SVG specific styling when no dimensions provided */
  img.svg-image {
    min-width: 200px;
    max-width: 100%;
    width: auto;
    height: auto;
  }
  
  /* For small icons, AI should specify width/height */
  img.svg-image:hover {
    /* Subtle indication that SVGs can be resized */
    cursor: zoom-in;
  }
  
  /* Loading state */
  .loading-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 3rem;
    color: var(--muted-foreground);
  }
  
  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--muted-foreground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  /* Error state */
  .error-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem;
    color: var(--muted-foreground);
    background: var(--muted);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
  }
  
  .error-link {
    color: var(--primary);
    text-decoration: underline;
    font-size: 0.875rem;
  }
  
  /* Overlay with actions */
  .image-overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 0.5rem;
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  
  .image-container:hover .image-overlay {
    opacity: 1;
    pointer-events: auto;
  }
  
  .image-info {
    background: rgba(0, 0, 0, 0.7);
    color: white;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius);
    font-size: 0.75rem;
    font-family: monospace;
  }
  
  .image-actions {
    display: flex;
    gap: 0.25rem;
  }
  
  :global(.image-actions .action-button) {
    background: oklch(0.08 0.012 276 / 0.72);
    color: oklch(0.96 0.006 289.95);
    backdrop-filter: blur(8px);
    width: 32px;
    height: 32px;
    padding: 0;
  }
  
  :global(.image-actions .action-button:hover) {
    background: oklch(0.12 0.018 281 / 0.92);
  }

  :global(.image-preview-dialog) {
    width: min(1100px, 92vw);
    max-width: min(1100px, 92vw);
    max-height: min(88vh, calc(100vh - 2rem));
    overflow: hidden;
    border-color: oklch(0.62 0.15 303 / 0.44);
  }

  .image-preview-shell {
    display: grid;
    place-items: center;
    min-height: min(60vh, 640px);
    overflow: auto;
    border: 1px solid oklch(0.62 0.024 282 / 0.18);
    border-radius: var(--radius);
    background: oklch(0.055 0.012 276);
  }

  .image-preview-full {
    display: block;
    width: auto;
    max-width: 100%;
    max-height: 72vh;
    object-fit: contain;
    border-radius: calc(var(--radius) - 2px);
  }

  :global(.image-preview-footer) {
    align-items: center;
    gap: 0.5rem;
  }
</style>

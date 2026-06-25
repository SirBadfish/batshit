<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { getProjectTreeIconRef } from '$lib/icons/fileTypeIcons'
  import PrismCodeBlock from '$lib/components/renderers/shared/PrismCodeBlock.svelte'
  import {
    getClipFileIconName,
    isClipImage,
    isClipTextLike,
    resolveClipContextTokens,
    resolveClipPreviewUrl,
    type ClipPresentationSource
  } from '$lib/utils/clipPresentation'
  import { estimateTokens, formatTokenCount } from '$lib/utils/tokens'

  type PreviewClip = ClipPresentationSource & {
    id?: string
    clipId?: string
    content?: string | null
    fileSize?: number | null
  }

  let {
    open = $bindable(false),
    clip = null
  }: {
    open?: boolean
    clip?: PreviewClip | null
  } = $props()

  let loadedClip = $state<PreviewClip | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)

  function resolveClipId(value: PreviewClip | null) {
    return value?.clipId || value?.id || ''
  }

  function formatTokens(tokens: number | undefined) {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return ''
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`
  }

  function formatFileSize(value?: number | null) {
    if (!value && value !== 0) return ''
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  function getLanguage(filename?: string | null) {
    const extension = filename?.split('.').pop()?.toLowerCase() || ''
    const languageMap: Record<string, string> = {
      bash: 'bash',
      css: 'css',
      html: 'html',
      js: 'javascript',
      json: 'json',
      jsonl: 'json',
      jsx: 'jsx',
      md: 'markdown',
      markdown: 'markdown',
      mjs: 'javascript',
      py: 'python',
      sh: 'bash',
      svelte: 'svelte',
      ts: 'typescript',
      tsx: 'tsx',
      txt: 'text',
      yaml: 'yaml',
      yml: 'yaml',
      zsh: 'bash'
    }
    return languageMap[extension] || extension || 'text'
  }

  function openSourceUrl() {
    const url = previewUrl || displayClip?.localUrl || displayClip?.externalUrl || ''
    if (!url) return
    window.open(url, '_blank')
  }

  const clipId = $derived(resolveClipId(clip))
  const displayClip = $derived(loadedClip ?? clip)
  const filename = $derived(displayClip?.filename || 'Clip')
  const previewUrl = $derived(displayClip ? resolveClipPreviewUrl(displayClip) : null)
  const imagePreview = $derived(Boolean(displayClip && isClipImage(displayClip) && previewUrl))
  const textPreview = $derived(Boolean(displayClip?.content && (!imagePreview || isClipTextLike(displayClip))))
  const tokenLabel = $derived(formatTokens(displayClip ? resolveClipContextTokens(displayClip) : undefined))
  const contentTokenLabel = $derived(
    displayClip?.content ? formatTokenCount(estimateTokens(displayClip.content)) : ''
  )
  const fileIconRef = $derived(
    getProjectTreeIconRef({
      name: getClipFileIconName(displayClip || { filename }),
      type: 'file'
    })
  )
  const language = $derived(getLanguage(filename))

  $effect(() => {
    if (!open || !clipId) {
      loadedClip = null
      loading = false
      error = null
      return
    }

    const controller = new AbortController()
    loading = true
    error = null

    fetch(`/api/clips/${encodeURIComponent(clipId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load clip preview')
        }
        loadedClip = await response.json()
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        error = err instanceof Error ? err.message : 'Failed to load clip preview'
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false
      })

    return () => controller.abort()
  })
</script>

<Dialog.Root bind:open>
  <Dialog.Content class={`clip-preview-dialog ${imagePreview ? 'is-image' : 'is-file'}`}>
    <Dialog.Header>
      <Dialog.Title>Quick View</Dialog.Title>
      <Dialog.Description class="clip-preview-path">{filename}</Dialog.Description>
    </Dialog.Header>

    {#if loading && !displayClip}
      <div class="clip-preview-loading">Loading preview...</div>
    {:else if imagePreview && previewUrl}
      <div class="clip-preview-image-shell">
        <img src={previewUrl} alt={filename} class="clip-preview-image" />
      </div>
    {:else}
      <div class="clip-preview-file-shell">
        <div class="clip-preview-file-heading">
          <div class="clip-preview-file-icon">
            <IconRenderer
              ref={fileIconRef}
              label={filename}
              iconClass="clip-preview-file-type-icon"
              imageClass="clip-preview-file-type-icon"
            />
          </div>
          <div class="clip-preview-file-copy">
            <div class="clip-preview-file-name">{filename}</div>
            {#if error}
              <div class="clip-preview-file-meta is-error">{error}</div>
            {:else}
              <div class="clip-preview-file-meta">
                {#if displayClip?.fileSize}
                  <span>Size: {formatFileSize(displayClip.fileSize)}</span>
                {/if}
                {#if contentTokenLabel}
                  <span>Tokens: {contentTokenLabel}</span>
                {:else if tokenLabel}
                  <span>{tokenLabel}</span>
                {/if}
              </div>
            {/if}
          </div>
        </div>

        {#if textPreview && displayClip?.content}
          <div class="clip-preview-code">
            <PrismCodeBlock content={displayClip.content} {language} />
          </div>
        {:else if error}
          <div class="clip-preview-note is-error">{error}</div>
        {:else}
          <div class="clip-preview-note">No inline preview is available for this file.</div>
        {/if}
      </div>
    {/if}

    <Dialog.Footer class="clip-preview-footer">
      <div class="clip-preview-note">{contentTokenLabel ? `~ ${contentTokenLabel} tokens` : ''}</div>
      <div class="clip-preview-actions">
        {#if previewUrl && !textPreview && !imagePreview}
          <Button variant="outline" onclick={openSourceUrl}>Open Source URL</Button>
        {/if}
        <Button onclick={() => (open = false)}>Close</Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(.clip-preview-dialog) {
    display: flex;
    flex-direction: column;
    width: min(980px, 90vw);
    max-width: min(980px, 90vw);
    max-height: min(86vh, calc(100vh - 2rem));
    overflow: hidden;
    border-color: oklch(0.62 0.15 303 / 0.5);
  }

  :global(.clip-preview-dialog.is-image) {
    width: min(980px, 90vw);
    max-width: min(980px, 90vw);
  }

  :global(.clip-preview-path) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .clip-preview-loading,
  .clip-preview-file-shell {
    min-height: 9rem;
  }

  .clip-preview-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    font-size: 0.875rem;
  }

  .clip-preview-image-shell {
    display: flex;
    flex: 1 1 auto;
    min-height: 12rem;
    max-height: calc(86vh - 9rem);
    align-items: center;
    justify-content: center;
    overflow: auto;
    border: 1px solid oklch(0.62 0.15 303 / 0.32);
    border-radius: 0.65rem;
    background: color-mix(in oklab, var(--background) 76%, black);
  }

  .clip-preview-image {
    max-width: 100%;
    max-height: calc(86vh - 10rem);
    object-fit: contain;
    display: block;
  }

  .clip-preview-file-shell {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    gap: 0.75rem;
    overflow: hidden;
  }

  .clip-preview-file-heading {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
    border: 1px solid oklch(0.62 0.15 303 / 0.32);
    border-radius: 0.65rem;
    background: color-mix(in oklab, var(--muted) 24%, transparent);
    padding: 0.7rem;
  }

  .clip-preview-file-icon {
    width: 2.4rem;
    height: 2.4rem;
    flex: 0 0 2.4rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid oklch(0.62 0.15 303 / 0.7);
    border-radius: 0.65rem;
    background:
      radial-gradient(circle at 50% 35%, oklch(0.31 0.075 298 / 0.9), oklch(0.15 0.032 286) 74%),
      oklch(0.15 0.032 286);
    box-shadow: 0 0 0 2px oklch(0.56 0.16 304 / 0.22);
  }

  :global(.clip-preview-file-type-icon) {
    width: 1.35rem;
    height: 1.35rem;
  }

  .clip-preview-file-copy {
    flex: 1 1 auto;
    min-width: 0;
  }

  .clip-preview-file-name {
    overflow: hidden;
    color: var(--foreground);
    font-size: 0.95rem;
    font-weight: 650;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .clip-preview-file-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 0.2rem;
    color: var(--muted-foreground);
    font-size: 0.78rem;
  }

  .clip-preview-file-meta.is-error {
    color: var(--destructive);
  }

  .clip-preview-code {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    overflow: hidden;
  }

  .clip-preview-code :global(.prism-code-block) {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
  }

  .clip-preview-code :global(.prism-pre) {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .clip-preview-note {
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .clip-preview-note.is-error {
    color: var(--destructive);
  }

  :global(.clip-preview-footer) {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .clip-preview-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>

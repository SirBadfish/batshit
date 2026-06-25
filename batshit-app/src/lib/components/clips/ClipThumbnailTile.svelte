<script lang="ts">
  import { Paperclip } from '@lucide/svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { getProjectTreeIconRef } from '$lib/icons/fileTypeIcons'
  import {
    getClipTileDescriptor,
    getClipFileIconName,
    isClipImage,
    resolveClipPreviewUrl,
    type ClipPresentationSource,
  } from '$lib/utils/clipPresentation'

  let {
    clip,
    size = 'sm',
    showPaperclip = false,
    label = '',
  } = $props<{
    clip: ClipPresentationSource
    size?: 'sm' | 'md'
    showPaperclip?: boolean
    label?: string
  }>()

  const descriptor = $derived(getClipTileDescriptor(clip))
  const previewUrl = $derived(resolveClipPreviewUrl(clip))
  const showImage = $derived(isClipImage(clip) && Boolean(previewUrl))
  const fileIconRef = $derived(
    getProjectTreeIconRef({
      name: getClipFileIconName(clip),
      type: 'file'
    })
  )
</script>

<div
  class={`clip-thumbnail-tile ${size} ${!showImage ? 'has-fallback' : ''}`}
  style={`--clip-tile-bg:${descriptor.background};--clip-tile-fg:${descriptor.foreground};--clip-tile-border:${descriptor.border};`}
  aria-label={label || clip.filename || descriptor.label}
  title={label || clip.filename || descriptor.label}
>
  {#if showImage && previewUrl}
    <img src={previewUrl} alt={clip.filename || descriptor.label} class="clip-thumbnail-image" />
  {:else}
    <div class="clip-thumbnail-fallback">
      <IconRenderer
        ref={fileIconRef}
        label={clip.filename || descriptor.label}
        class="clip-thumbnail-file-icon-shell"
        iconClass="clip-thumbnail-file-icon"
        imageClass="clip-thumbnail-file-icon"
      />
    </div>
  {/if}

  {#if showPaperclip}
    <div class="clip-paperclip">
      <Paperclip class="h-4 w-4" />
    </div>
  {/if}
</div>

<style>
  .clip-thumbnail-tile {
    position: relative;
    aspect-ratio: 1 / 1;
    border-radius: 0.85rem;
    overflow: visible;
    border: 1px solid oklch(0.62 0.15 303 / 0.68);
    background: var(--clip-tile-bg);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.14),
      0 0 0 2px oklch(0.56 0.16 304 / 0.22),
      0 10px 18px rgba(15, 23, 42, 0.18);
  }

  .clip-thumbnail-tile.has-fallback {
    border-color: oklch(0.62 0.15 303 / 0.72);
    background:
      radial-gradient(circle at 50% 35%, oklch(0.34 0.08 298 / 0.9), oklch(0.17 0.035 286) 74%),
      oklch(0.16 0.032 286);
    box-shadow:
      inset 0 1px 0 oklch(0.92 0.02 300 / 0.12),
      0 0 0 2px oklch(0.56 0.16 304 / 0.24),
      0 10px 18px rgba(15, 23, 42, 0.22);
  }

  .clip-thumbnail-tile.sm {
    width: 36px;
  }

  .clip-thumbnail-tile.md {
    width: 42px;
  }

  .clip-thumbnail-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: 0.85rem;
  }

  .clip-thumbnail-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.3rem;
    color: var(--clip-tile-fg);
    text-align: center;
    background: transparent;
  }

  :global(.clip-thumbnail-file-icon-shell) {
    width: 16px;
    height: 16px;
  }

  :global(.clip-thumbnail-file-icon) {
    width: 16px;
    height: 16px;
  }

  .clip-paperclip {
    position: absolute;
    top: -5px;
    left: -1px;
    z-index: 2;
    display: inline-flex;
    color: white;
    filter:
      drop-shadow(0 2px 2px rgba(15, 23, 42, 0.45))
      drop-shadow(1px 1px 0 rgba(0, 0, 0, 0.5));
    transform: rotate(-12deg);
  }

  .clip-thumbnail-tile.md .clip-paperclip {
    top: -4px;
    left: 0;
  }
</style>

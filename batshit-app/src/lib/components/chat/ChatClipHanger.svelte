<script lang="ts">
  import { X } from '@lucide/svelte'
  import ClipThumbnailTile from '$lib/components/clips/ClipThumbnailTile.svelte'
  import ClipPreviewDialog from '$lib/components/clips/ClipPreviewDialog.svelte'

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

  interface Props {
    clips: ComposerClip[]
    onDetachClip: (clipId: string) => void | Promise<void>
    onToggleUseOnce?: (clip: ComposerClip) => void | Promise<void>
  }

  let { clips, onDetachClip, onToggleUseOnce }: Props = $props()
  let previewClip = $state<ComposerClip | null>(null)
  let previewOpen = $state(false)

  function isClipOneTime(clip: ComposerClip) {
    return (clip.messagesUntilUnclip ?? clip.unclipAfter ?? null) === 1
  }

  function openClipPreview(clip: ComposerClip) {
    previewClip = clip
    previewOpen = true
  }
</script>

{#if clips.length > 0}
  <div class="chatbar-clip-hanger" aria-label="Currently clipped items">
    {#each clips as clip, index (clip.id)}
      <div
        class={`chatbar-clip-item ${isClipOneTime(clip) ? 'one-time' : ''}`}
        style={`--clip-rotation:${8 + index}deg`}
      >
        <button
          type="button"
          class="chatbar-clip-preview-button"
          onclick={() => openClipPreview(clip)}
          aria-label={`Preview ${clip.filename}`}
          title={clip.filename}
        >
          <ClipThumbnailTile clip={clip} size="md" showPaperclip={true} />
        </button>

        <div class="chatbar-clip-actions">
          {#if onToggleUseOnce}
            <button
              type="button"
              class:active={isClipOneTime(clip)}
              class="chatbar-clip-action once"
              onclick={(event) => {
                event.stopPropagation()
                void onToggleUseOnce?.(clip)
              }}
              aria-label={isClipOneTime(clip)
                ? `Keep ${clip.filename} clipped after sends`
                : `Use ${clip.filename} for next message only`}
              aria-pressed={isClipOneTime(clip)}
              title={isClipOneTime(clip) ? 'Keep clipped' : 'Next message only'}
            >
              <span class="chatbar-clip-one-badge" aria-hidden="true">1</span>
            </button>
          {/if}
          <button
            type="button"
            class="chatbar-clip-action danger"
            onclick={(event) => {
              event.stopPropagation()
              void onDetachClip(clip.id)
            }}
            aria-label={`Unclip ${clip.filename}`}
            title="Unclip"
          >
            <X class="chatbar-clip-action-icon" />
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<ClipPreviewDialog bind:open={previewOpen} clip={previewClip} />

<style>
  :global(.chatbar-clip-action-icon) {
    width: 0.75rem;
    height: 0.75rem;
  }

  .chatbar-clip-one-badge {
    font-size: 0.64rem;
    font-weight: 700;
    line-height: 1;
  }

  .chatbar-clip-hanger {
    position: absolute;
    left: 0.9rem;
    bottom: calc(100% + 1px);
    width: max-content;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.55rem;
    padding: 0.15rem 0.8rem 0.2rem;
    min-height: 2.55rem;
    max-width: calc(100% - 1.8rem);
    overflow: visible;
    z-index: 2;
    background: color-mix(in oklab, var(--bs-app-inset-surface) 88%, var(--bs-app-card));
    border: 1px solid var(--bs-app-inner-line);
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
  }

  .chatbar-clip-item {
    position: relative;
    flex: 0 0 auto;
    transform: rotate(var(--clip-rotation, 8deg));
    transition: transform 0.18s ease;
  }

  .chatbar-clip-preview-button {
    position: relative;
    display: block;
    border: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    cursor: pointer;
  }

  .chatbar-clip-item.one-time .chatbar-clip-preview-button::after {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: 1rem;
    border: 1px solid color-mix(in oklab, var(--accent) 68%, transparent);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 16%, transparent);
    pointer-events: none;
  }

  .chatbar-clip-preview-button:focus-visible {
    border-radius: 0.85rem;
    outline: 2px solid color-mix(in oklab, var(--foreground) 34%, transparent);
    outline-offset: 3px;
  }

  .chatbar-clip-item:hover {
    transform: rotate(calc(var(--clip-rotation, 8deg) - 3deg)) translateY(2px) scale(1.04);
  }

  .chatbar-clip-actions {
    position: absolute;
    top: -0.35rem;
    right: -0.3rem;
    z-index: 4;
    display: flex;
    gap: 0.25rem;
    opacity: 0;
    pointer-events: none;
    transform: translateY(-2px);
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
  }

  .chatbar-clip-item.one-time .chatbar-clip-actions {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  .chatbar-clip-item:hover .chatbar-clip-actions,
  .chatbar-clip-item:focus-within .chatbar-clip-actions {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  .chatbar-clip-action {
    width: 1.15rem;
    height: 1.15rem;
    border-radius: 9999px;
    border: 1px solid var(--bs-app-field-line);
    background: var(--bs-app-popover);
    color: var(--bs-app-title);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 6px 14px oklch(0 0 0 / 0.3);
    transition:
      background 0.16s ease,
      border-color 0.16s ease,
      color 0.16s ease,
      opacity 0.16s ease,
      transform 0.16s ease;
  }

  .chatbar-clip-action.danger:hover {
    background: color-mix(in oklab, var(--destructive) 24%, var(--bs-app-popover));
  }

  .chatbar-clip-item.one-time .chatbar-clip-action.danger {
    opacity: 0;
    pointer-events: none;
    transform: scale(0.9);
  }

  .chatbar-clip-item.one-time:hover .chatbar-clip-action.danger,
  .chatbar-clip-item.one-time:focus-within .chatbar-clip-action.danger {
    opacity: 1;
    pointer-events: auto;
    transform: scale(1);
  }

  .chatbar-clip-action.once:hover,
  .chatbar-clip-action.once.active {
    border-color: color-mix(in oklab, var(--accent) 72%, var(--bs-app-field-line));
    background: color-mix(in oklab, var(--accent) 58%, var(--bs-app-popover));
    color: var(--accent-foreground);
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--accent) 34%, transparent),
      0 8px 16px oklch(0 0 0 / 0.34);
  }

  @container chat-column (max-width: 550px) {
    .chatbar-clip-hanger {
      gap: 0.45rem;
      padding-left: 0.55rem;
      padding-right: 0.55rem;
    }
  }
</style>

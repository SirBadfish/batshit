<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '$lib/utils'

  type SettingsLivePreviewPaneProps = {
    width: number
    host?: HTMLDivElement | null
    resizing?: boolean
    resizeAriaLabel?: string
    onResizeStart?: ((event: PointerEvent) => void) | undefined
    runtimeBadge?: string | null
    loading?: boolean
    error?: string | null
    emptyMessage?: string | null
    wrapperClass?: string
    panelStyle?: string
    overlay?: Snippet
    children?: Snippet
  }

  let {
    width,
    host = $bindable(null),
    resizing = false,
    resizeAriaLabel = 'Resize live preview',
    onResizeStart = undefined,
    runtimeBadge = null,
    loading = false,
    error = null,
    emptyMessage = null,
    wrapperClass = '',
    panelStyle = '',
    overlay,
    children
  }: SettingsLivePreviewPaneProps = $props()
</script>

<div
  class={cn(
    'settings-live-preview-resize-handle',
    resizing && 'settings-live-preview-resize-handle-active'
  )}
  role="separator"
  aria-orientation="vertical"
  aria-label={resizeAriaLabel}
  onpointerdown={onResizeStart}
></div>

<div
  class={cn('settings-live-preview-pane', wrapperClass)}
  style={`width: ${width}px;${panelStyle ? ` ${panelStyle}` : ''}`}
>
  <div class="settings-live-preview-viewport">
    <div class="settings-live-preview-host" bind:this={host}></div>
    {#if runtimeBadge}
      <div class="settings-live-preview-badge">
        {runtimeBadge}
      </div>
    {/if}
    {#if loading}
      <div class="settings-live-preview-state">
        Loading Goon...
      </div>
    {:else if error}
      <div class="settings-live-preview-state settings-live-preview-state-error">
        {error}
      </div>
    {:else if emptyMessage}
      <div class="settings-live-preview-state">
        {emptyMessage}
      </div>
    {/if}
    {@render overlay?.()}
  </div>
  <div class="settings-live-preview-toolbar">
    {@render children?.()}
  </div>
</div>

<style>
  .settings-live-preview-resize-handle {
    width: 6px;
    cursor: col-resize;
    touch-action: none;
    background: oklch(from var(--border) l c h / 0.7);
  }

  .settings-live-preview-resize-handle:hover {
    background: var(--border);
  }

  .settings-live-preview-resize-handle-active {
    background: oklch(from var(--primary) l c h / 0.4);
  }

  .settings-live-preview-pane {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    overflow: hidden;
  }

  .settings-live-preview-viewport {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    background: oklch(from var(--muted) l c h / 0.2);
  }

  .settings-live-preview-host,
  .settings-live-preview-state {
    position: absolute;
    inset: 0;
  }

  .settings-live-preview-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    border-radius: 4px;
    background: oklch(from var(--background) l c h / 0.8);
    padding: 4px 8px;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    backdrop-filter: blur(4px);
  }

  .settings-live-preview-state {
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(from var(--background) l c h / 0.7);
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .settings-live-preview-state-error {
    color: var(--destructive);
  }

  .settings-live-preview-toolbar {
    display: flex;
    height: 56px;
    align-items: center;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding-inline: 16px;
  }
</style>

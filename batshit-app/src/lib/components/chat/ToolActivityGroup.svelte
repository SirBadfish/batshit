<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { AlertCircle, CheckCircle2, ChevronRight, LoaderCircle, Wrench } from '@lucide/svelte'

  type ToolActivitySummaryItem = {
    label: string
    status: 'success' | 'error' | 'loading'
  }

  const MAX_PREVIEW_LABELS = 3

  let {
    items = [],
    isStreaming = false,
    zipIds = [],
    children
  }: {
    items?: ToolActivitySummaryItem[]
    isStreaming?: boolean
    zipIds?: string[]
    children?: any
  } = $props()

  let uniqueLabels = $derived(Array.from(new Set(items.map((item) => item.label).filter(Boolean))))
  let previewLabels = $derived(uniqueLabels.slice(0, MAX_PREVIEW_LABELS))
  let hiddenLabelCount = $derived(Math.max(0, uniqueLabels.length - previewLabels.length))
  let hiddenLabelTitle = $derived(uniqueLabels.slice(MAX_PREVIEW_LABELS).join(', '))
  let errorCount = $derived(items.filter((item) => item.status === 'error').length)
  let loadingCount = $derived(items.filter((item) => item.status === 'loading').length)
  let isGroupLive = $derived(loadingCount > 0)
  let summaryLabel = $derived(
    items.length === 1 ? 'Tool activity' : `${items.length} tool actions`
  )
  let statusIcon = $derived.by(() => {
    if (errorCount > 0) return AlertCircle
    if (isGroupLive) return LoaderCircle
    return CheckCircle2
  })
  let StatusIcon = $derived(statusIcon)
  let zipIdTokens = $derived(
    Array.from(new Set(zipIds.map((id) => String(id || '').trim()).filter(Boolean))).join(' ')
  )
  let collapsed = $state(true)

  function toggleCollapsed() {
    collapsed = !collapsed
  }
</script>

<div
  class="tool-activity-group"
  class:is-collapsed={collapsed}
  data-tool-activity-zip-ids={zipIdTokens || undefined}
>
  <button
    class="tool-activity-strip"
    class:is-collapsed={collapsed}
    type="button"
    aria-expanded={!collapsed}
    onclick={toggleCollapsed}
  >
    <span class="tool-activity-summary">
      <StatusIcon
        class="tool-activity-icon"
        style={isGroupLive ? 'animation: spin 1.2s linear infinite;' : undefined}
        size={13}
      />
      <span class="tool-activity-label">{summaryLabel}</span>
    </span>

    <span
      class="tool-activity-badges"
      aria-label={uniqueLabels.length > 0 ? `Tool types: ${uniqueLabels.join(', ')}` : undefined}
    >
      {#each previewLabels as label}
        <Badge variant="secondary" class="tool-activity-badge">
          <Wrench size={12} />
          <span>{label}</span>
        </Badge>
      {/each}

      {#if hiddenLabelCount > 0}
        <Badge
          variant="outline"
          class="tool-activity-badge tool-activity-more-badge"
          title={hiddenLabelTitle}
        >
          +{hiddenLabelCount}
        </Badge>
      {/if}

      {#if errorCount > 0}
        <Badge variant="destructive" class="tool-activity-badge tool-activity-status-badge">
          {errorCount} error{errorCount === 1 ? '' : 's'}
        </Badge>
      {:else if isGroupLive}
        <Badge variant="outline" class="tool-activity-badge tool-activity-status-badge">
          Live
        </Badge>
      {/if}
    </span>

    <ChevronRight
      class="tool-activity-chevron"
      data-open={!collapsed}
      size={13}
      aria-hidden="true"
    />
  </button>

  {#if !collapsed}
    <div class="tool-activity-body">
      {@render children?.()}
    </div>
  {/if}
</div>

<style>
  .tool-activity-group {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--bs-app-inner-line);
    border-radius: 0.5rem;
    background: oklch(0.11 0.014 278 / 0.36);
    padding: 0.35rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    overflow: hidden;
  }

  .tool-activity-group.is-collapsed {
    gap: 0;
    padding: 0.22rem 0.28rem;
  }

  .tool-activity-strip {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    padding: 0.25rem 0.35rem;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out;
  }

  .tool-activity-strip.is-collapsed {
    gap: 0.55rem;
    min-height: 1.45rem;
    padding: 0.1rem 0.25rem;
  }

  .tool-activity-strip:hover,
  .tool-activity-strip:focus-visible {
    background: var(--bs-app-field);
  }

  .tool-activity-strip:focus-visible {
    outline: 1px solid var(--bs-app-field-line);
    outline-offset: 1px;
  }

  .tool-activity-summary {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    max-width: 10rem;
    color: var(--muted-foreground);
    font-size: 0.74rem;
    font-weight: 500;
    line-height: 1.12;
  }

  .tool-activity-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-activity-badges {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: nowrap;
    min-width: 0;
    justify-content: flex-end;
    overflow: hidden;
    white-space: nowrap;
  }

  :global(.tool-activity-badge) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex: 0 1 auto;
    border: 1px solid var(--bs-app-inner-line);
    background: color-mix(in oklab, var(--bs-app-field) 58%, transparent);
    color: var(--bs-app-muted-text);
    font-size: 0.68rem;
    font-weight: 500;
    line-height: 1;
    min-width: 0;
    max-width: min(11rem, 38%);
  }

  :global(.tool-activity-badge span) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.tool-activity-badge svg) {
    flex: 0 0 auto;
    color: var(--bs-app-muted-text);
  }

  :global(.tool-activity-more-badge),
  :global(.tool-activity-status-badge) {
    flex: 0 0 auto;
    max-width: none;
  }

  :global(.tool-activity-chevron) {
    justify-self: end;
    flex: 0 0 auto;
    color: var(--bs-app-muted-text);
    transition: transform 150ms ease-out;
  }

  :global(.tool-activity-chevron[data-open='true']) {
    transform: rotate(90deg);
  }

  .tool-activity-body {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.15rem 0.1rem 0.1rem;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .tool-activity-body :global(.batshit-zip-wrapper > .zip-content > .full-tool),
  .tool-activity-body :global(.batshit-zip-wrapper > .zip-content > .compact-tool),
  .tool-activity-body :global(.batshit-zip-wrapper > .zip-content > .image-tool) {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    margin: 0;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }
</style>

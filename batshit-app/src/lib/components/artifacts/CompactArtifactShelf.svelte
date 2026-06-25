<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Layers } from '@lucide/svelte'

  let {
    isOpen = $bindable(false)
  } = $props<{
    isOpen?: boolean
  }>()
</script>

<div class="compact-artifact-shelf">
  <div
    class={`compact-artifact-shelf-panel ${isOpen ? 'is-open' : ''}`}
    style={`max-height: ${isOpen ? '120px' : '0px'}`}
  >
    <div class="compact-artifact-shelf-content">
      <div class="compact-artifact-shelf-header">
        <div class="compact-artifact-shelf-title">Artifact Widgets</div>
        <div class="compact-artifact-shelf-meta">Future compact widget zone</div>
      </div>

      <p class="compact-artifact-shelf-empty">
        Future artifact widget position for small pinned controls.
      </p>
    </div>
  </div>

  <Button
    variant="ghost"
    onclick={() => (isOpen = !isOpen)}
    class="compact-artifact-shelf-toggle"
    aria-label={isOpen ? 'Collapse compact artifact shelf' : 'Open compact artifact shelf'}
    title={isOpen ? 'Collapse compact artifact shelf' : 'Open compact artifact shelf'}
    data-testid="compact-artifact-shelf-toggle"
    data-ab-control="compact-artifact-shelf-toggle"
  >
    <Layers class="compact-artifact-shelf-toggle-icon" />
    <span class="compact-artifact-shelf-screen-reader">
      {isOpen ? 'Collapse compact artifact shelf' : 'Open compact artifact shelf'}
    </span>
  </Button>
</div>

<style>
  .compact-artifact-shelf {
    position: relative;
  }

  .compact-artifact-shelf-panel {
    position: relative;
    overflow: hidden;
    background: color-mix(in oklab, var(--background) 95%, transparent);
    transition:
      max-height 300ms ease-in-out,
      background-color 300ms ease-in-out,
      border-color 300ms ease-in-out;
  }

  @supports (backdrop-filter: blur(6px)) {
    .compact-artifact-shelf-panel {
      background: color-mix(in oklab, var(--background) 60%, transparent);
      backdrop-filter: blur(6px);
    }
  }

  .compact-artifact-shelf-panel.is-open {
    border-bottom: 1px solid var(--border);
  }

  .compact-artifact-shelf-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
  }

  .compact-artifact-shelf-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .compact-artifact-shelf-title {
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .compact-artifact-shelf-meta {
    color: var(--muted-foreground);
    font-size: 0.6875rem;
  }

  .compact-artifact-shelf-empty {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  :global(.compact-artifact-shelf-toggle) {
    position: absolute;
    left: 50%;
    bottom: -24px;
    z-index: var(--z-surface);
    width: 48px;
    height: 24px;
    padding: 0;
    transform: translateX(-50%);
    border-width: 0 1px 1px;
    border-style: solid;
    border-color: var(--bs-app-shell-line);
    border-radius: 0 0 6px 6px;
    background: var(--background);
    color: var(--muted-foreground);
    box-shadow: none;
    transition:
      background-color 150ms ease-out,
      border-color 150ms ease-out,
      color 150ms ease-out;
  }

  :global(.compact-artifact-shelf-toggle:hover) {
    background: var(--bs-app-inset-surface-hover);
    color: var(--bs-app-title);
  }

  :global(.compact-artifact-shelf-toggle:focus-visible) {
    border-color: var(--bs-app-primary-soft);
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
  }

  :global(.compact-artifact-shelf-toggle-icon) {
    width: 14px;
    height: 14px;
  }

  .compact-artifact-shelf-screen-reader {
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
</style>

<script lang="ts">
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { getArtifactSourceBadge } from '$lib/artifacts/artifactSourceBadge'

  let {
    artifact,
    size = 'xs',
    showLabel = false,
    class: className = ''
  } = $props<{
    artifact: any
    size?: 'xs' | 'sm'
    showLabel?: boolean
    class?: string
  }>()

  const badge = $derived(getArtifactSourceBadge(artifact))
  const sizeClass = $derived(size === 'sm' ? 'is-sm' : 'is-xs')
</script>

<span
  class={`batshit-artifact-source-badge ${sizeClass} ${showLabel ? 'has-label' : 'is-icon-only'} ${className}`}
  title={`${badge.label} artifact`}
  aria-label={`${badge.label} artifact`}
>
  <IconRenderer
    ref={badge.iconRef}
    label={badge.label}
    class={`artifact-source-badge-icon-frame ${sizeClass}`}
    iconClass={`artifact-source-badge-icon ${sizeClass}`}
  />
  {#if showLabel}
    <span class={`artifact-source-badge-label ${sizeClass}`}>{badge.label}</span>
  {/if}
</span>

<style>
  .batshit-artifact-source-badge {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
    border-radius: 999px;
    background: color-mix(in oklab, var(--background) 95%, transparent);
    color: var(--muted-foreground);
    box-shadow: 0 1px 2px color-mix(in oklab, black 12%, transparent);
  }

  .batshit-artifact-source-badge.has-label {
    padding: 0.125rem 0.375rem;
  }

  .batshit-artifact-source-badge.is-icon-only {
    padding: 0;
  }

  :global(.artifact-source-badge-icon-frame.is-sm) {
    width: 20px;
    height: 20px;
  }

  :global(.artifact-source-badge-icon-frame.is-xs) {
    width: 10px;
    height: 10px;
  }

  :global(.artifact-source-badge-icon.is-sm) {
    width: 16px;
    height: 16px;
  }

  :global(.artifact-source-badge-icon.is-xs) {
    width: 8px;
    height: 8px;
  }

  .artifact-source-badge-label {
    font-weight: 500;
    line-height: 1;
  }

  .artifact-source-badge-label.is-sm {
    font-size: 0.6875rem;
  }

  .artifact-source-badge-label.is-xs {
    font-size: 0.625rem;
  }
</style>

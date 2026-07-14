<script lang="ts">
  import type { Snippet } from 'svelte'
  import { ChevronDown, RotateCcw } from '@lucide/svelte'

  type Props = {
    id: string
    title: string
    summary: string
    open: boolean
    changed?: boolean
    disabled?: boolean
    onToggle: () => void
    onReset: () => void
    children?: Snippet
  }

  let {
    id,
    title,
    summary,
    open,
    changed = false,
    disabled = false,
    onToggle,
    onReset,
    children
  }: Props = $props()

  const triggerId = $derived(`facial-artwork-${id}-trigger`)
  const panelId = $derived(`facial-artwork-${id}-panel`)
</script>

<section class="facial-artwork-accordion" data-state={open ? 'open' : 'closed'}>
  <div class="facial-artwork-accordion-heading">
    <button
      id={triggerId}
      type="button"
      class="facial-artwork-accordion-trigger"
      aria-expanded={open}
      aria-controls={panelId}
      onclick={onToggle}
    >
      <span class="facial-artwork-accordion-copy">
        <span class="facial-artwork-accordion-title">{title}</span>
        <span class="facial-artwork-accordion-summary">{summary}</span>
      </span>
      <span class="facial-artwork-accordion-meta">
        {#if changed}<span class="facial-artwork-changed">Changed</span>{/if}
        <ChevronDown aria-hidden="true" class={open ? 'open' : ''} />
      </span>
    </button>
    {#if changed}
      <button
        type="button"
        class="facial-artwork-accordion-reset"
        aria-label={`Reset ${title}`}
        title={`Reset ${title}`}
        disabled={disabled}
        onclick={onReset}
      >
        <RotateCcw aria-hidden="true" />
      </button>
    {/if}
  </div>

  {#if open}
    <div
      id={panelId}
      class="facial-artwork-accordion-panel"
      role="region"
      aria-labelledby={triggerId}
    >
      {@render children?.()}
    </div>
  {/if}
</section>

<style>
  .facial-artwork-accordion {
    overflow: hidden;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--background);
  }

  .facial-artwork-accordion[data-state='open'] {
    border-color: color-mix(in oklch, var(--primary) 32%, var(--border));
  }

  .facial-artwork-accordion-heading,
  .facial-artwork-accordion-trigger,
  .facial-artwork-accordion-meta {
    display: flex;
    align-items: center;
  }

  .facial-artwork-accordion-heading {
    min-width: 0;
  }

  .facial-artwork-accordion-trigger {
    flex: 1;
    min-width: 0;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 10px;
    text-align: left;
  }

  .facial-artwork-accordion-trigger:hover,
  .facial-artwork-accordion-reset:hover:not(:disabled) {
    background: var(--muted);
  }

  .facial-artwork-accordion-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .facial-artwork-accordion-title {
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 650;
  }

  .facial-artwork-accordion-summary {
    overflow: hidden;
    max-width: 34ch;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .facial-artwork-accordion-meta {
    flex-shrink: 0;
    gap: 7px;
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .facial-artwork-changed {
    color: var(--primary);
    font-weight: 650;
  }

  .facial-artwork-accordion-meta :global(svg),
  .facial-artwork-accordion-reset :global(svg) {
    width: 14px;
    height: 14px;
  }

  .facial-artwork-accordion-meta :global(svg) {
    transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .facial-artwork-accordion-meta :global(svg.open) {
    transform: rotate(180deg);
  }

  .facial-artwork-accordion-reset {
    align-self: stretch;
    width: 34px;
    border-left: 1px solid var(--border);
    color: var(--muted-foreground);
  }

  .facial-artwork-accordion-reset:disabled {
    opacity: 0.45;
  }

  .facial-artwork-accordion-trigger:focus-visible,
  .facial-artwork-accordion-reset:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  .facial-artwork-accordion-panel {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 12px;
    padding: 10px;
    border-top: 1px solid var(--border);
  }

  @media (prefers-reduced-motion: reduce) {
    .facial-artwork-accordion-meta :global(svg) {
      transition: none;
    }
  }
</style>

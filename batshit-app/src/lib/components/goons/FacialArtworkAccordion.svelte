<script lang="ts">
  import type { Snippet } from 'svelte'
  import { ChevronDown, RotateCcw } from '@lucide/svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'

  type Props = {
    id: string
    title: string
    info?: string | string[]
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
    info = [],
    open,
    changed = false,
    disabled = false,
    onToggle,
    onReset,
    children
  }: Props = $props()

  const triggerId = $derived(`facial-artwork-${id}-trigger`)
  const panelId = $derived(`facial-artwork-${id}-panel`)
  const infoLines = $derived(Array.isArray(info) ? info : [info])
</script>

<Collapsible.Root {open} class="goon-level-3-accordion facial-artwork-accordion">
  <div class="goon-level-3-accordion-header facial-artwork-accordion-heading">
    <button
      id={triggerId}
      type="button"
      class="facial-artwork-accordion-trigger"
      aria-label={title}
      aria-expanded={open}
      aria-controls={panelId}
      onclick={onToggle}
    ></button>
    <span class="facial-artwork-accordion-title-line">
      <span class="goon-level-3-accordion-title">{title}</span>
      {#if infoLines.length > 0}
        <span class="facial-artwork-accordion-info">
          <SettingsInfoMenu ariaLabel={`About ${title}`} contentClass="w-80">
            {#each infoLines as line}
              <p>{line}</p>
            {/each}
          </SettingsInfoMenu>
        </span>
      {/if}
    </span>
    <span class="facial-artwork-accordion-meta">
      {#if changed}<span class="facial-artwork-changed">Changed</span>{/if}
      <ChevronDown aria-hidden="true" class="facial-artwork-chevron" data-open={open} />
    </span>
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

  <Collapsible.Content
    id={panelId}
    class="goon-level-3-accordion-content facial-artwork-accordion-panel"
    role="region"
    aria-labelledby={triggerId}
  >
    {@render children?.()}
  </Collapsible.Content>
</Collapsible.Root>

<style>
  :global(.facial-artwork-accordion) {
    min-width: 0;
  }

  .facial-artwork-accordion-heading,
  .facial-artwork-accordion-trigger,
  .facial-artwork-accordion-title-line,
  .facial-artwork-accordion-meta {
    display: flex;
    align-items: center;
  }

  .facial-artwork-accordion-heading {
    position: relative;
    min-height: 2.14rem;
    padding: 0;
  }

  .facial-artwork-accordion-trigger {
    position: absolute;
    z-index: 0;
    inset: 0;
    width: 100%;
    padding: 0;
    color: inherit;
    text-align: left;
  }

  .facial-artwork-accordion-title-line {
    position: relative;
    z-index: 1;
    min-width: 0;
    flex: 1;
    gap: 6px;
    padding: 0.46rem 0 0.46rem 0.62rem;
    pointer-events: none;
  }

  .facial-artwork-accordion-info {
    display: inline-flex;
    flex-shrink: 0;
    pointer-events: auto;
  }

  .facial-artwork-accordion-meta {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    gap: 7px;
    padding: 0.46rem 0.62rem;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    pointer-events: none;
  }

  .facial-artwork-changed {
    color: var(--primary);
    font-weight: 650;
  }

  :global(.facial-artwork-chevron),
  .facial-artwork-accordion-reset :global(svg) {
    width: 14px;
    height: 14px;
  }

  :global(.facial-artwork-chevron) {
    transition: transform 180ms ease-out;
  }

  :global(.facial-artwork-chevron[data-open='true']) {
    transform: rotate(180deg);
  }

  .facial-artwork-accordion-reset {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-self: stretch;
    width: 40px;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-left: 1px solid var(--bs-settings-inner-line);
    color: var(--muted-foreground);
  }

  .facial-artwork-accordion-reset:hover:not(:disabled) {
    background: var(--bs-settings-hover);
    color: var(--foreground);
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

  @media (prefers-reduced-motion: reduce) {
    :global(.facial-artwork-chevron) {
      transition: none;
    }
  }
</style>

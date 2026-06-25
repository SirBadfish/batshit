<script lang="ts">
  import { ChevronDown, ChevronUp } from '@lucide/svelte'

  let { items = [], content = '', isStreaming = false } = $props<{ 
    items?: Array<{ text: string; completed?: boolean }>
    content?: string
    isStreaming?: boolean
  }>()

  const hasItems = $derived(Array.isArray(items) && items.length > 0)
  let isCollapsed = $state(false)

  function toggle() {
    isCollapsed = !isCollapsed
  }
</script>

<div class="summary-wrapper">
  <button
    class="summary-header"
    onclick={toggle}
    type="button"
    aria-expanded={!isCollapsed}
  >
    <span class="summary-chevron">
      {#if isCollapsed}
        <ChevronDown class="h-3.5 w-3.5" />
      {:else}
        <ChevronUp class="h-3.5 w-3.5" />
      {/if}
    </span>
    <span class="summary-title">Plan</span>
  </button>

  {#if !isCollapsed}
    <div class="summary-body">
      {#if hasItems}
        <ul class="plan-list">
          {#each items as item}
            <li class:completed={item.completed}>
              <span class="plan-status">[{item.completed ? 'x' : ' '}]</span>
              <span class="plan-text">{item.text}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <pre class="summary-text">{content}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .summary-wrapper {
    margin: 0.15rem 0;
  }

  .summary-header {
    width: 100%;
    padding: 0.1rem 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--foreground);
    font-size: 0.8rem;
    opacity: 0.7;
  }

  .summary-title {
    font-weight: 500;
    letter-spacing: 0.01em;
  }

  .summary-chevron {
    display: inline-flex;
    align-items: center;
  }

  .summary-body {
    padding: 0.25rem 0 0.2rem;
  }

  .summary-text {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    font-size: 0.78rem;
    opacity: 0.6;
  }

  .plan-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .plan-list li {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    font-size: 0.78rem;
    line-height: 1.4;
    opacity: 0.6;
  }

  .plan-status {
    font-family: var(--font-mono, monospace);
    color: var(--foreground);
    opacity: 0.6;
    min-width: 2.2rem;
  }

  .plan-list li.completed {
    opacity: 0.4;
  }

  .plan-list li.completed .plan-text {
    text-decoration: line-through;
  }
</style>

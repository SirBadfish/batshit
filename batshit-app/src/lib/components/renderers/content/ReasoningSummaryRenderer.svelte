<script lang="ts">
  import { ChevronDown, ChevronUp } from '@lucide/svelte'
  import { escapeHtml } from '$lib/utils/htmlEntities'

  let { content, isStreaming = false } = $props<{ content: string; isStreaming?: boolean }>()

  let isCollapsed = $state(true)

  function formatInlineText(value: string) {
    if (!value) return ''
    const escaped = escapeHtml(value)
    const withBold = escaped.replace(/\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*/g, '<strong>$1</strong>')
    return withBold.replace(/\*([^\s](?:[\s\S]*?[^\s])?)\*/g, '<em>$1</em>')
  }

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
    <span class="summary-title">Reasoning</span>
  </button>

  {#if !isCollapsed}
    <div class="summary-body">
      <pre class="summary-text">{@html formatInlineText(content)}</pre>
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
    font-family: inherit;
  }
</style>

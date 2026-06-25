<script lang="ts">
  import { Search } from '@lucide/svelte'

  import CompactTool from '$lib/components/renderers/tools/templates/CompactTool.svelte'
  import type { ToolData } from '../toolRendererRegistry'

  let { tool }: { tool: ToolData } = $props()

  function parsePayload(value: unknown): Record<string, any> {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch {
        return {}
      }
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, any>
    }
    return {}
  }

  const payload = $derived(parsePayload(tool.toolResult))
  const results = $derived(
    Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.items)
        ? payload.items
        : []
  )
  const totalMatches = $derived(
    typeof payload.totalMatches === 'number' ? payload.totalMatches : results.length
  )
  const query = $derived(typeof payload.query === 'string' ? payload.query : tool.toolInput?.query)
  const summary = $derived(
    [
      `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`,
      query ? `query: ${query}` : null
    ]
      .filter(Boolean)
      .join(' • ')
  )
</script>

<CompactTool
  icon={Search}
  title="Dynamic Tool Search"
  summary={summary || 'Dynamic Tool Search'}
  status={tool.success ? 'success' : 'error'}
  expandable={true}
  error={tool.error}
>
  {#snippet children()}
    {#if results.length === 0}
      <div class="empty">No tools found.</div>
    {:else}
      <div class="list">
        {#each results as item}
          <div class="card">
            <div class="card-title">{item.title || item.toolId || item.id || 'Tool'}</div>
            <div class="meta">
              {#if item.toolId || item.id}
                <span class="tag monospace">{item.toolId || item.id}</span>
              {/if}
              {#if item.riskLevel}
                <span class="tag">{item.riskLevel}</span>
              {/if}
              {#if item.lastValidationStatus}
                <span class="tag">{item.lastValidationStatus}</span>
              {/if}
            </div>
            {#if item.description}
              <p class="desc">{item.description}</p>
            {/if}
            {#if item.executable}
              <p class="schema">Executable: {item.executable}</p>
            {/if}
            {#if item.schemaHint}
              <p class="schema">Schema: {item.schemaHint}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/snippet}
</CompactTool>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.65rem;
    background: var(--muted);
  }
  .card-title {
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 0.25rem;
  }
  .desc {
    margin: 0.25rem 0 0;
    color: var(--muted-foreground);
    font-size: 0.85rem;
  }
  .schema {
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    color: var(--muted-foreground);
  }
  .meta {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .tag {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.15rem 0.5rem;
    font-size: 0.75rem;
  }
  .monospace {
    font-family: var(--font-mono, monospace);
  }
</style>

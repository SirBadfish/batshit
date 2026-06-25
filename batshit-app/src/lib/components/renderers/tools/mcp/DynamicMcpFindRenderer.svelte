<script lang="ts">
import CompactTool from '$lib/components/renderers/tools/templates/CompactTool.svelte'
  import { Search } from '@lucide/svelte'
  import type { ToolData } from '../toolRendererRegistry'

  let { tool }: { tool: ToolData } = $props()

  const parsePayload = (val: any): any => {
    if (!val) return {}

    // Helper to parse JSON strings safely
    const tryParse = (input: any) => {
      if (typeof input !== 'string') return input
      try {
        return JSON.parse(input)
      } catch {
        return input
      }
    }

    const parsed = tryParse(val)

    // Object with numeric keys (e.g., {"0": {...}, "1": {...}}) → treat as array
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).every((k) => /^\d+$/.test(k))
    ) {
      const asArray = Object.entries(parsed)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, v]) => v)
      return parsePayload(asArray)
    }

    // Array shape (e.g., [{ type: 'text', text: '{...json...}' }])
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0]
      if (typeof first === 'string') return tryParse(first)
      if (first?.text) return tryParse(first.text)
    }

    // Object with nested result/output/toolResult
    if (parsed && typeof parsed === 'object') {
      const nested =
        parsed.result ||
        parsed.output ||
        parsed.toolResult ||
        parsed.tool_result ||
        parsed.data ||
        parsed.content

      if (nested) {
        const nestedParsed = parsePayload(nested)
        // If nested parse yields results/query, use it; otherwise fall back
        if (nestedParsed && (nestedParsed.results || nestedParsed.query)) {
          return nestedParsed
        }
      }
    }

    return parsed
  }

  const payload = $derived(parsePayload(tool.toolResult))

  const results = $derived.by(() => {
    const baseResults =
      (Array.isArray(payload?.results) && payload.results) ||
      (Array.isArray(payload?.tools) && payload.tools) ||
      (Array.isArray(payload?.data) && payload.data) ||
      (Array.isArray(payload?.items) && payload.items) ||
      (Array.isArray(payload?.output) && payload.output) ||
      (Array.isArray(payload?.content) && payload.content) ||
      (Array.isArray(payload) && payload) ||
      []

    const expandedResults: any[] = []
    for (const entry of baseResults) {
      if (typeof entry === 'string') {
        const parsed = parsePayload(entry)
        if (parsed?.results && Array.isArray(parsed.results)) {
          expandedResults.push(...parsed.results)
          continue
        }
        expandedResults.push(parsed)
        continue
      }
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
        const parsed = parsePayload(entry.text)
        if (parsed?.results && Array.isArray(parsed.results)) {
          expandedResults.push(...parsed.results)
          continue
        }
        expandedResults.push(parsed)
        continue
      }
      expandedResults.push(entry)
    }

    return expandedResults
  })

  const totalMatches = $derived.by(() => {
    const totalMatchesRaw: number | undefined =
      payload?.totalMatches ??
      payload?.total_matches ??
      payload?.count ??
      tool.toolResult?.totalMatches

    return results.length > (totalMatchesRaw ?? 0)
      ? results.length
      : totalMatchesRaw ?? results.length
  })

  const query = $derived(
    payload?.query ||
    tool.toolInput?.query ||
    tool.toolInput?.params?.query
  )

  const displayResults = $derived.by(() =>
    results.map((item) => {
      if (typeof item === 'string') {
        return {
          toolName: item,
          description: '',
          groupName: undefined,
          schemaHint: undefined,
          inputSchema: undefined
        }
      }
      const toolName =
        item?.toolName ||
        item?.name ||
        item?.tool ||
        item?.id ||
        item?.title ||
        item?.label ||
        'Unknown tool'

      const description =
        item?.description ||
        item?.toolDescription ||
        item?.summary ||
        item?.desc ||
        ''

      const groupName = item?.groupName || item?.group || item?.category
      const schemaHintRaw = item?.schemaHint || item?.schema_summary
      const schemaHint = typeof schemaHintRaw === 'string' ? schemaHintRaw : undefined
      const inputSchema =
        item?.inputSchema ||
        item?.schemaFull ||
        item?.schema_full ||
        (item?.schema && typeof item.schema === 'object' ? item.schema : undefined)

      return { toolName, description, groupName, schemaHint, inputSchema }
    })
  )

  const summary = $derived.by(() => {
    const summaryParts: string[] = []
    if (typeof totalMatches === 'number') {
      summaryParts.push(`${totalMatches} match${totalMatches === 1 ? '' : 'es'}`)
    }
    if (query) {
      summaryParts.push(`query: ${query}`)
    }
    return summaryParts.join(' • ') || 'Dynamic Tool Search'
  })
</script>

<CompactTool
  icon={Search}
  title="Dynamic Tool Search"
  summary={summary}
  status={tool.success ? 'success' : 'error'}
  expandable={true}
  metadata={{
    ...(typeof totalMatches === 'number' ? { Matches: totalMatches } : {}),
    ...(query ? { Query: query } : {})
  }}
  error={tool.error}
>
  {#snippet children()}
    {#if displayResults.length === 0}
      <div class="empty">No tools found.</div>
    {:else}
      <div class="list">
        {#each displayResults as item}
          <div class="card">
            <div class="card-title">{item.toolName}</div>
            {#if item.description}
              <p class="desc">{item.description}</p>
            {/if}
            {#if item.schemaHint}
              <p class="schema">Schema: {item.schemaHint}</p>
            {/if}
            {#if item.inputSchema && !item.schemaHint}
              <details class="schema-details">
                <summary>Schema (full)</summary>
                <pre>{JSON.stringify(item.inputSchema, null, 2)}</pre>
              </details>
            {/if}
            <div class="tags">
              {#if item.groupName}
                <span class="tag subtle">{item.groupName}</span>
              {/if}
            </div>
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
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.85rem;
  }
  .tags {
    margin-top: 0.35rem;
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .schema {
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    color: var(--muted-foreground);
  }
  .schema-details {
    margin-top: 0.35rem;
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }
  .schema-details summary {
    cursor: pointer;
    font-weight: 600;
  }
  .schema-details pre {
    margin-top: 0.35rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tag {
    background: var(--muted);
    color: var(--foreground);
    border-radius: 999px;
    padding: 0.18rem 0.55rem;
    font-size: 0.75rem;
  }
  .tag.subtle {
    background: transparent;
    border: 1px solid var(--border);
  }
  .empty {
    color: var(--muted-foreground);
    margin: 0.25rem 0 0;
    font-size: 0.9rem;
  }
</style>

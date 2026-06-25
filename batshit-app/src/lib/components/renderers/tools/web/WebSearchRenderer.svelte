<script lang="ts">
	import FullTool from '../templates/FullTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
	import { ExternalLink, Globe } from '@lucide/svelte'

	let { tool }: { tool: ToolData } = $props()

	let query = $derived(
		typeof tool.toolResult?.query === 'string'
			? tool.toolResult.query
			: typeof tool.toolInput?.query === 'string'
				? tool.toolInput.query
				: 'Web search'
	)
	let provider = $derived(
		typeof tool.toolResult?.provider === 'string' ? tool.toolResult.provider : undefined
	)
	let queries = $derived(
		Array.isArray(tool.toolResult?.queries)
			? tool.toolResult.queries.filter(
					(entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0
				)
			: []
	)
	let resultsUnavailable = $derived(tool.toolResult?.resultsUnavailable === true)
	let results = $derived(
		Array.isArray(tool.toolResult?.results) ? tool.toolResult.results : []
	)
	let totalMatches = $derived(
		typeof tool.toolResult?.totalMatches === 'number' ? tool.toolResult.totalMatches : results.length
	)
	let metadata = $derived.by(() => ({
		...(provider ? { Provider: provider } : {}),
		...(resultsUnavailable
			? { 'Queries Run': queries.length > 0 ? queries.length : 1 }
			: { Results: totalMatches }),
		...(tool.rawSidecar?.zipId ? { 'Raw Payload Zip': tool.rawSidecar.zipId } : {})
	}))
</script>

<FullTool
	icon={Globe}
	title="Web Search"
	subtitle={query}
	status={tool.success ? 'success' : 'error'}
	{metadata}
	duration={tool.metadata?.executionTime}
	error={tool.error}
>
	<div class="search-results">
		{#if !tool.error && results.length > 0}
			{#each results as result}
				<div class="result-card">
					<div class="result-title-row">
						<div class="result-title">{result.title || 'Untitled result'}</div>
						{#if result.url}
							<a
								href={result.url}
								target="_blank"
								rel="noreferrer noopener"
								class="result-link"
								aria-label={`Open ${result.title || 'search result'}`}
							>
								<ExternalLink size={13} />
							</a>
						{/if}
					</div>
					{#if result.url}
						<div class="result-url">{result.url}</div>
					{/if}
					{#if result.snippet}
						<div class="result-snippet">{result.snippet}</div>
					{/if}
					{#if result.source}
						<div class="result-source">{result.source}</div>
					{/if}
				</div>
			{/each}
		{:else if !tool.error && resultsUnavailable}
			<div class="provider-note">
				Search completed, but Codex did not expose result rows for this run.
			</div>
			{#if queries.length > 0}
				<div class="query-list">
					<div class="query-list-label">Queries run</div>
					<ul>
						{#each queries as attemptedQuery}
							<li>{attemptedQuery}</li>
						{/each}
					</ul>
				</div>
			{/if}
		{:else if !tool.error}
			<div class="empty-state">No search results were returned.</div>
		{/if}
	</div>
</FullTool>

<style>
	.search-results {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.result-card {
		border: 1px solid var(--border);
		border-radius: 0.45rem;
		padding: 0.625rem 0.6875rem;
		background: oklch(1 0 0 / 0.03);
	}

	.result-title-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.result-title {
		font-weight: 600;
		font-size: 0.8125rem;
		line-height: 1.32;
		letter-spacing: 0;
	}

	.result-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		color: var(--muted-foreground);
	}

	.result-link:hover {
		background: oklch(1 0 0 / 0.05);
		color: var(--foreground);
	}

	.result-link:focus-visible {
		outline: 1px solid var(--ring);
		outline-offset: 2px;
	}

	.result-url,
	.result-source {
		font-size: 0.6875rem;
		line-height: 1.35;
		color: var(--muted-foreground);
		word-break: break-word;
	}

	.result-snippet {
		margin-top: 0.375rem;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--muted-foreground);
	}

	.empty-state {
		color: var(--muted-foreground);
		font-size: 0.875rem;
	}

	.provider-note,
	.query-list {
		font-size: 0.875rem;
		color: var(--muted-foreground);
	}

	.query-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.query-list-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.query-list ul {
		margin: 0;
		padding-left: 1.125rem;
	}

	.query-list li {
		line-height: 1.45;
		word-break: break-word;
	}
</style>

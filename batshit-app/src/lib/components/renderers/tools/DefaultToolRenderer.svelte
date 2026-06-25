<!-- DefaultToolRenderer.svelte - Fallback renderer for unknown tools -->
<script lang="ts">
	import CompactTool from './templates/CompactTool.svelte'
	import type { ToolData } from './toolRendererRegistry'
	import { normalizeToolPayload } from '$lib/utils/toolPayloadUnwrap'
	
	let { tool }: { tool: ToolData } = $props()
	
	let cleanedResult = $derived(
		normalizeToolPayload(tool.toolResult, {
			textArrays: false,
			singlePropertyKeys: ['result', 'output', 'response', 'data']
		})
	)
	let resultSummary = $derived(summarizeResult(cleanedResult))
	
	function summarizeResult(result: any): string {
		if (!result) return 'No result'
		
		if (typeof result === 'string') {
			// Truncate long strings
			return result.length > 100 ? result.slice(0, 100) + '...' : result
		}
		
		if (typeof result === 'boolean') {
			return result ? 'Success' : 'Failed'
		}
		
		if (typeof result === 'number') {
			return result.toString()
		}
		
		if (Array.isArray(result)) {
			return `${result.length} items`
		}
		
		if (typeof result === 'object') {
			const keys = Object.keys(result)
			if (keys.length === 0) return 'Empty object'
			if (keys.length === 1) return `{${keys[0]}: ...}`
			return `${keys.length} properties`
		}
		
		return 'Result available'
	}
	
	// Build metadata for display
	let displayMetadata = $derived({
		...(tool.metadata || {}),
		...(tool.success !== undefined && { status: tool.success ? 'success' : 'failed' }),
		...(tool.error && { error: tool.error })
	})
</script>

<CompactTool
	title={(tool.displayToolName || tool.toolName).replace(/_/g, ' ')}
	summary={tool.toolName === 'Executing Tool...' ? 'Tool execution in progress...' : resultSummary}
	status={tool.toolName === 'Executing Tool...' ? 'loading' : (tool.error ? 'error' : tool.success ? 'success' : 'info')}
	expandable={tool.toolName !== 'Executing Tool...'}
	metadata={displayMetadata}
>
	{#snippet children()}
		<!-- Show input if present -->
		{#if tool.toolInput}
			<div class="tool-section">
				<h5 class="section-label">Input</h5>
				<div class="section-content">
					{#if typeof tool.toolInput === 'object'}
						<pre class="json-display">{JSON.stringify(tool.toolInput, null, 2)}</pre>
					{:else}
						<div class="text-display">{tool.toolInput}</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Show result -->
		{#if cleanedResult !== undefined && cleanedResult !== null}
			<div class="tool-section">
				<h5 class="section-label">Result</h5>
				<div class="section-content">
					{#if typeof cleanedResult === 'object'}
						<pre class="json-display">{JSON.stringify(cleanedResult, null, 2)}</pre>
					{:else}
						<div class="text-display">{cleanedResult}</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Show error if present -->
		{#if tool.error}
			<div class="tool-section error">
				<h5 class="section-label">Error</h5>
				<div class="section-content">
					<div class="error-display">{tool.error}</div>
				</div>
			</div>
		{/if}
	{/snippet}
</CompactTool>

<style>
	.tool-section {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	
	.tool-section:first-child {
		margin-top: 0;
		padding-top: 0;
		border-top: none;
	}
	
	.section-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		margin-bottom: 0.5rem;
	}
	
	.section-content {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
	}
	
	.json-display {
		background: var(--muted);
		padding: 0.5rem;
		border-radius: 0.25rem;
		overflow-x: auto;
		white-space: pre;
		font-size: 0.6875rem;
		line-height: 1.4;
		max-height: 200px;
		overflow-y: auto;
	}
	
	.text-display {
		line-height: 1.4;
		word-break: break-word;
		white-space: pre-wrap;
	}
	
	.error .section-label {
		color: rgb(239 68 68);
	}
	
	.error-display {
		color: rgb(239 68 68);
		font-family: var(--font-mono, monospace);
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>

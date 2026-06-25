<!-- ToolStats.svelte - Performance and execution statistics -->
<script lang="ts">
	import { Clock } from '@lucide/svelte'

	let {
		duration = undefined, // milliseconds
		tokenCount = undefined,
		timestamp = undefined,
		custom = {}
	}: {
		duration?: number
		tokenCount?: number
		timestamp?: string
		custom?: Record<string, any>
	} = $props()
	
	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
		return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
	}
	
	function formatTimestamp(ts: string): string {
		const date = new Date(ts)
		const now = new Date()
		const diff = now.getTime() - date.getTime()
		
		if (diff < 60000) return 'just now'
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
		
		return date.toLocaleTimeString()
	}
</script>

<div class="tool-stats">
	{#if duration !== undefined}
		<span class="stat-item" title="Execution time">
			<Clock size={12} strokeWidth={2} />
			{formatDuration(duration)}
		</span>
	{/if}
	
	{#if tokenCount !== undefined && tokenCount > 0}
		<span class="stat-item" title="Token count">
			Tokens {tokenCount.toLocaleString()}
		</span>
	{/if}
	
	{#if timestamp}
		<span class="stat-item" title="Executed at">
			<Clock size={12} strokeWidth={2} />
			{formatTimestamp(timestamp)}
		</span>
	{/if}
	
	{#each Object.entries(custom) as [key, value]}
		<span class="stat-item" title={key}>
			{value}
		</span>
	{/each}
</div>

<style>
	.tool-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
		font-family: var(--font-mono, monospace);
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	
	.stat-item {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		white-space: nowrap;
	}
</style>

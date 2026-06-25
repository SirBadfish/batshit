<!-- ToolMetadata.svelte - Key-value metadata display -->
<script lang="ts">
	let {
		metadata = {},
		compact = false
	}: {
		metadata?: Record<string, any>
		compact?: boolean
	} = $props()

	// Filter out null/undefined values
	let displayData = $derived(Object.entries(metadata).filter(([_, v]) => v != null))
</script>

{#if displayData.length > 0}
	<div class="tool-metadata {compact ? 'compact' : 'full'}">
		{#each displayData as [key, value]}
			<div class="metadata-item">
				<span class="metadata-key">
					{key.replace(/_/g, ' ')}:
				</span>
				<span class="metadata-value">
					{#if typeof value === 'object'}
						{JSON.stringify(value, null, 2)}
					{:else}
						{value}
					{/if}
				</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.tool-metadata {
		font-size: 0.75rem;
		font-family: var(--font-mono, monospace);
		color: var(--muted-foreground);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 0.5rem;
	}
	
	.tool-metadata.compact {
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	
	.metadata-item {
		display: flex;
		gap: 0.5rem;
	}
	
	.compact .metadata-item {
		display: inline-flex;
	}
	
	.metadata-key {
		opacity: 0.7;
		text-transform: capitalize;
	}
	
	.metadata-value {
		color: var(--foreground);
		word-break: break-word;
	}
</style>
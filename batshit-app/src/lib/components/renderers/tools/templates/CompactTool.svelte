<!-- CompactTool.svelte - 2-4 line tool display with optional expansion -->
<script lang="ts">
	import ToolHeader from './slots/ToolHeader.svelte'
	
	import type { Component } from 'svelte'
	import { Wrench } from '@lucide/svelte'
	
	let {
		icon = Wrench,
		title,
		summary = '',
		status = 'info',
		expandable = false,
		expanded = $bindable(false),
		metadata = {},
		error = undefined,
		children
	}: {
		icon?: string | Component
		title: string
		summary?: string
		status?: 'loading' | 'success' | 'error' | 'info'
		expandable?: boolean
		expanded?: boolean
		metadata?: Record<string, any>
		error?: string
		children?: any
	} = $props()
	
	function toggleExpanded() {
		if (expandable) {
			expanded = !expanded
		}
	}
</script>

<div class="compact-tool" class:expandable>
	<button
		class="compact-header"
		onclick={toggleExpanded}
		disabled={!expandable}
		type="button"
		aria-expanded={expanded}
	>
		<ToolHeader {icon} {title} subtitle={summary} {status} />
	</button>
	
	{#if expanded}
		<div class="compact-details">
			{#if children}
				{@render children()}
			{:else if Object.keys(metadata).length > 0}
				<div class="metadata-grid">
					{#each Object.entries(metadata) as [key, value]}
						<div class="metadata-row">
							<span class="metadata-key">{key}:</span>
							<span class="metadata-value">{value}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.compact-tool {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		margin: 0.25rem 0;
		overflow: hidden;
		position: relative;
		border: 1px solid var(--bs-app-inner-line);
		border-radius: var(--radius);
		background: oklch(1 0 0 / 0.018);
	}
	
	.compact-header {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		padding: 0.5rem 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-align: left;
		background: oklch(1 0 0 / 0.04);
		border: none;
		cursor: default;
		transition: all 0.2s ease;
		color: var(--muted-foreground);
		font-size: 0.875rem;
		overflow: hidden;
	}
	
	/* Rounded corners: all 4 when collapsed, only top when expanded */
	.compact-header[aria-expanded="false"] {
		border-radius: var(--radius);
	}
	
	.compact-header[aria-expanded="true"] {
		border-radius: var(--radius) var(--radius) 0 0;
		border-bottom: 1px solid var(--bs-app-inner-line);
	}
	
	.expandable .compact-header {
		cursor: pointer;
	}
	
	.expandable .compact-header:hover:not(:disabled) {
		background-color: var(--bs-app-field);
		color: var(--bs-app-field-text);
	}
	
	.compact-details {
		min-width: 0;
		max-width: 100%;
		padding: 0.75rem;
		background: oklch(1 0 0 / 0.04);
		border-radius: 0 0 var(--radius) var(--radius);
		border-top: 1px solid var(--bs-app-inner-line);
		font-size: 0.875rem;
		font-family: var(--font-mono, monospace);
	}
	
	.metadata-grid {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.25rem 1rem;
		margin-top: 0.5rem;
	}
	
	.metadata-key {
		color: var(--muted-foreground);
		text-transform: capitalize;
	}
	
	.metadata-value {
		word-break: break-word;
	}
</style>

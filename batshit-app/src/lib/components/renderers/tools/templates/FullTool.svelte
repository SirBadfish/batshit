<!-- FullTool.svelte - Full display with collapsible sections -->
<script lang="ts">
	import ToolHeader from './slots/ToolHeader.svelte'
	import ToolMetadata from './slots/ToolMetadata.svelte'
	import ToolStats from './slots/ToolStats.svelte'
	import type { Component } from 'svelte'
	import type { IconRef } from '$lib/icons/iconTypes'
	import { Wrench } from '@lucide/svelte'
	
	let {
		icon = Wrench,
		iconRef = null,
		title,
		subtitle = '',
		status = 'info',
		// Content sections
		input = undefined,
		output = undefined,
		error = undefined,
		// Metadata
		metadata = {},
		duration = undefined,
		tokenCount = undefined,
		timestamp = undefined,
		// Collapse state
		collapsed = $bindable(true),  // Start collapsed by default
		interactive = true,
		// Snippets for custom content
		children,
		inputSlot,
		outputSlot
	}: {
		icon?: string | Component
		iconRef?: IconRef | null
		title: string
		subtitle?: string
		status?: 'loading' | 'success' | 'error' | 'info'
		// Content sections
		input?: any
		output?: any
		error?: string
		// Metadata
		metadata?: Record<string, any>
		duration?: number
		tokenCount?: number
		timestamp?: string
		// Collapse state
		collapsed?: boolean
		defaultCollapsed?: boolean
		interactive?: boolean
		// Snippets
		children?: any
		inputSlot?: any
		outputSlot?: any
	} = $props()
	
	
	function toggleCollapse() {
		if (!interactive) return
		collapsed = !collapsed
	}
</script>

<div class="full-tool" class:error={status === 'error'}>
	<button
		class="tool-header-button"
		onclick={toggleCollapse}
		type="button"
		aria-expanded={interactive ? !collapsed : false}
		aria-disabled={interactive ? undefined : 'true'}
	>
		<ToolHeader {icon} {iconRef} {title} {subtitle} {status} />
	</button>
	
	{#if interactive && !collapsed}
		<div class="tool-content">
			<!-- Input Section -->
			{#if input !== undefined}
				<div class="content-section">
					<h5 class="section-title">Input</h5>
					<div class="section-content">
						{#if inputSlot}
							{@render inputSlot()}
						{:else if typeof input === 'object'}
							<pre class="code-block">{JSON.stringify(input, null, 2)}</pre>
						{:else}
							<div class="text-content">{input}</div>
						{/if}
					</div>
				</div>
			{/if}
			
			<!-- Output/Result Section -->
			{#if output !== undefined || error}
				<div class="content-section">
					<h5 class="section-title">
						{error ? 'Error' : 'Output'}
					</h5>
					<div class="section-content" class:error-content={!!error}>
						{#if outputSlot}
							{@render outputSlot()}
						{:else if error}
							<div class="error-message">{error}</div>
						{:else if typeof output === 'object'}
							<pre class="code-block">{JSON.stringify(output, null, 2)}</pre>
						{:else}
							<div class="text-content">{output}</div>
						{/if}
					</div>
				</div>
			{/if}
			
			<!-- Custom content -->
			{#if children}
				{@render children()}
			{/if}
			
			<!-- Metadata Section -->
			{#if Object.keys(metadata).length > 0}
				<div class="content-section">
					<ToolMetadata {metadata} />
				</div>
			{/if}
			
			<!-- Stats Footer -->
			{#if duration !== undefined || tokenCount !== undefined || timestamp}
				<ToolStats {duration} {tokenCount} {timestamp} />
			{/if}
		</div>
	{/if}
</div>

<style>
	.full-tool {
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
	
	
	.tool-header-button {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		padding: 0.5rem 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-align: left;
		background: transparent;
		border: none;
		cursor: pointer;
		transition: all 0.2s ease;
		color: var(--muted-foreground);
		font-size: 0.875rem;
		overflow: hidden;
	}
	
	/* Rounded corners: all 4 when collapsed, only top when expanded */
	.tool-header-button[aria-expanded="false"] {
		border-radius: var(--radius);
	}
	
	.tool-header-button[aria-expanded="true"] {
		border-radius: var(--radius) var(--radius) 0 0;
		border-bottom: 1px solid var(--bs-app-inner-line);
	}
	
	.tool-header-button:hover {
		background-color: var(--bs-app-field);
		color: var(--bs-app-field-text);
	}

	.tool-header-button[aria-disabled="true"] {
		cursor: default;
	}
	
	.tool-content {
		min-width: 0;
		max-width: 100%;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		background: oklch(1 0 0 / 0.04);
		border-radius: 0 0 var(--radius) var(--radius);
	}
	
	.content-section {
		min-width: 0;
		max-width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0.5rem 0.5rem 0.5rem;
	}
	
	.section-title {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
	}
	
	.section-content {
		min-width: 0;
		max-width: 100%;
		font-family: var(--font-mono, monospace);
		font-size: 0.875rem;
	}
	
	.code-block {
		background: var(--muted);
		padding: 0.75rem;
		border-radius: 0.375rem;
		overflow-x: auto;
		white-space: pre;
		font-size: 0.75rem;
		line-height: 1.5;
	}
	
	.text-content {
		line-height: 1.5;
	}
	
	.error-content {
		color: rgb(239 68 68);
	}
	
	.error-message {
		font-family: var(--font-mono, monospace);
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>

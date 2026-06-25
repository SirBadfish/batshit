<!-- ImageTool.svelte - Collapsible tool shell for image renderers -->
<script lang="ts">
	import ToolHeader from './slots/ToolHeader.svelte'
	import type { Component } from 'svelte'

	let {
		icon = 'IMG',
		title,
		subtitle = '',
		status = 'info',
		collapsed = $bindable(true),
		children
	}: {
		icon?: string | Component
		title: string
		subtitle?: string
		status?: 'loading' | 'success' | 'error' | 'info'
		collapsed?: boolean
		children?: any
	} = $props()

	function toggleCollapse() {
		collapsed = !collapsed
	}
</script>

<div class="image-tool" class:error={status === 'error'}>
	<button
		class="tool-header-button"
		onclick={toggleCollapse}
		type="button"
		aria-expanded={!collapsed}
	>
		<ToolHeader {icon} {title} {subtitle} {status} />
	</button>

	{#if !collapsed}
		<div class="tool-content">
			{#if children}
				{@render children()}
			{/if}
		</div>
	{/if}
</div>

<style>
	.image-tool {
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
		background: oklch(1 0 0 / 0.04);
		border: none;
		cursor: pointer;
		transition: all 0.2s ease;
		color: var(--muted-foreground);
		font-size: 0.875rem;
		overflow: hidden;
	}

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

	.tool-content {
		min-width: 0;
		max-width: 100%;
		padding: 0;
		background: oklch(1 0 0 / 0.04);
		border-radius: 0 0 var(--radius) var(--radius);
	}
</style>

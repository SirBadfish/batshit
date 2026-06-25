<!-- ToolHeader.svelte - Header component for all tool renderers -->
<script lang="ts">
	import type { Component } from 'svelte'
	import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
	import type { IconRef } from '$lib/icons/iconTypes'
	import { Wrench } from '@lucide/svelte'
	
	let {
		icon = Wrench,
		iconRef = null,
		title,
		subtitle = '',
		status = 'info'
	}: {
		icon?: string | Component
		iconRef?: IconRef | null
		title: string
		subtitle?: string
		status?: 'loading' | 'success' | 'error' | 'info'
	} = $props()
	
	const statusColors = {
		loading: 'text-muted-foreground',
		success: 'text-muted-foreground',
		error: 'text-muted-foreground',
		info: 'text-muted-foreground'
	}
</script>

<div class="tool-header flex items-center gap-2">
	<span class="tool-icon flex-shrink-0" aria-hidden="true">
		{#if iconRef}
			<IconRenderer
				ref={iconRef}
				label={title}
				iconClass="tool-header-file-type-icon"
				imageClass="tool-header-file-type-icon"
			/>
		{:else if typeof icon === 'string'}
			{icon}
		{:else}
			{@const Icon = icon}
			<Icon size={16} strokeWidth={2} />
		{/if}
	</span>
	
	<div class="tool-header-text flex items-baseline gap-2 flex-1 min-w-0">
		<span class="title font-medium {statusColors[status]} truncate">
			{title}
		</span>
		
		{#if subtitle}
			<span class="separator">•</span>
			<span class="subtitle truncate">
				{subtitle}
			</span>
		{/if}
	</div>
</div>

<style>
	.tool-header {
		font-family: var(--font-mono, monospace);
		color: var(--muted-foreground);
		font-size: 0.75rem;
		width: 100%;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
	}

	.tool-header-text {
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
	}
	
	.title {
		display: block;
		flex: 0 0 auto;
		font-weight: 500;
		font-family: monospace;
		min-width: 0;
		max-width: min(14rem, 45%);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title:last-child {
		flex: 1 1 auto;
		max-width: 100%;
	}
	
	.tool-icon {
		display: flex;
		align-items: center;
		color: var(--muted-foreground);
	}

	:global(.tool-header-file-type-icon) {
		width: 16px;
		height: 16px;
	}
	
	.separator {
		flex: 0 0 auto;
		opacity: 0.4;
	}
	
	.subtitle {
		display: block;
		flex: 1 1 auto;
		opacity: 0.7;
		font-size: 0.7rem;
		margin: 0;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

<!-- GenericToolRenderer.svelte - Professional renderer for generic tools and n8n Workflow tools -->
<script lang="ts">
	import { Badge } from '$lib/components/ui/badge'
	import FullTool from '../templates/FullTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
  import {
    Wrench,
    Plug,
    Terminal,
    Workflow,
    Sparkles,
    type Icon as LucideIcon
  } from '@lucide/svelte'
  import { formatToolDisplayName } from '$lib/utils/toolNameFormatter'
	import type { Component } from 'svelte'

	let { tool } = $props<{ tool: ToolData }>()

	// ===== SOURCE BADGE HELPER =====
	// Returns Lucide icon component (NOT emoji string) and label
	interface SourceBadge {
		icon: typeof Terminal  // Svelte component type from Lucide
		label: string
	}

	export function getToolSourceBadge(toolData: ToolData): SourceBadge {
		// batshit-server tools (any source: direct, Docker Gateway, n8n MCP Trigger)
		if (toolData.toolProvider === 'batshit-server' ||
		    toolData.mcpServerName === 'batshit-server' ||
		    toolData.mcpServerName === 'batshit-server') {
			return {
				icon: Terminal,  // Temporary - will be redesigned in Epic 7
				label: 'batshit-server'
			}
		}

		// MCP tools (Docker Gateway or n8n MCP Trigger)
		if (toolData.toolSource === 'mcp-gateway' || toolData.toolProvider === 'mcp') {
			return {
				icon: Plug,
				label: 'MCP Tool'
			}
		}

		// n8n Workflow tools
		if (toolData.toolProvider === 'n8n-workflow') {
			return {
				icon: Workflow,
				label: 'Workflow'
			}
		}

		// Provider-native LLM tools
		if (toolData.toolProvider === 'llm-native') {
			return {
				icon: Sparkles,
				label: 'LLM Tool'
			}
		}

		// Generic/unknown tool - default fallback
		return {
			icon: Wrench,
			label: 'Tool'
		}
	}

	// ===== HEADER SECTION =====
	let badge = $derived(getToolSourceBadge(tool))
  let toolDisplayName = $derived(tool.displayToolName || formatToolDisplayName(tool.toolName))
  let subtitle = $derived(badge.label)

	// ===== DATA FORMATTING LOGIC =====
	let formattedResult = $derived(formatToolResult(tool.toolResult))
	let isObject = $derived(typeof formattedResult === 'object' && formattedResult !== null && !Array.isArray(formattedResult))
	let isString = $derived(typeof formattedResult === 'string')

	function extractMeaningfulData(obj: any): any {
		if (!obj || typeof obj !== 'object') return obj

		// Special handling for MCP result format: {"content": [{"type": "text", "text": "..."}]}
		if (obj.content && Array.isArray(obj.content) && obj.content.length > 0) {
			const firstContent = obj.content[0]
			if (firstContent && typeof firstContent === 'object' && firstContent.text) {
				let extractedText = firstContent.text

				// CRITICAL: The text might be a stringified JSON (double/triple-wrapped MCP format)
				// Unwrap recursively until we get the actual data
				let currentText = extractedText
				let maxUnwraps = 5 // Prevent infinite loops

				while (maxUnwraps-- > 0) {
					try {
						const parsed = JSON.parse(currentText)

						// If it's an array with MCP format [{type: "text", text: "..."}]
						if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type === 'text') {
							currentText = parsed[0].text
							continue // Try to unwrap further
						}

						// If it's an object, we're done unwrapping
						if (typeof parsed === 'object') {
							return parsed
						}

						// If it's a primitive after parsing, return it
						return parsed
					} catch {
						// Not valid JSON anymore, we've unwrapped everything
						break
					}
				}

				return currentText
			}
		}

		// Priority fields - check these first
		const meaningfulFields = ['result', 'output', 'data', 'content', 'value']
		for (const field of meaningfulFields) {
			if (obj[field] !== undefined) return obj[field]
		}

		// Filter out technical noise
		const technicalFields = ['id', 'type', 'timestamp', 'metadata']
		const entries = Object.entries(obj)
			.filter(([key]) => !technicalFields.includes(key))
			.slice(0, 100) // PERF-001: Truncate to first 100 keys

		if (entries.length === 0) return obj

		return entries.reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {})
	}

	function formatToolResult(result: any, depth = 0): any {
		const MAX_DEPTH = 5 // PERF-001: Limit nested depth

		// TECH-001: Handle null/undefined
		if (result === null || result === undefined) {
			return 'No result'
		}

		// TECH-001: Handle circular references
		try {
			JSON.stringify(result)
		} catch (error) {
			return 'Result contains circular references'
		}

		// Max depth reached
		if (depth >= MAX_DEPTH) {
			return '[Max depth reached]'
		}

		// Handle strings
		if (typeof result === 'string') {
			return result.length > 10000 ? result.slice(0, 10000) + '...' : result
		}

		// Handle primitives
		if (typeof result === 'boolean' || typeof result === 'number') {
			return result.toString()
		}

		// Handle arrays
		if (Array.isArray(result)) {
			if (result.length === 0) return 'Empty array'
			return result.slice(0, 100) // Truncate large arrays
		}

		// Handle objects
		if (typeof result === 'object') {
			const meaningful = extractMeaningfulData(result)
			// Recursively format nested objects
			if (typeof meaningful === 'object' && meaningful !== null) {
				return meaningful
			}
			return meaningful
		}

		return result
	}

	// ===== STATUS & METADATA =====
	let status = $derived((tool.success ? 'success' : 'error') as 'success' | 'error' | 'info' | 'loading')
	let duration = $derived(tool.metadata?.executionTime)
</script>

<FullTool
	icon={badge.icon}
	title={toolDisplayName}
	{subtitle}
	{status}
	error={tool.error}
	{duration}
>
	<!-- Result Display Section -->
	<div class="tool-result-content">
		{#if !tool.error}
			{#if isString}
				<pre class="result-text">{formattedResult}</pre>
			{:else if isObject}
				<div class="key-value-display">
					{#each Object.entries(formattedResult).slice(0, 100) as [key, value]}
						<div class="kv-row">
							<span class="kv-key">{key}:</span>
							<span class="kv-value">
								{#if typeof value === 'object' && value !== null}
									{JSON.stringify(value, null, 2)}
								{:else}
									{value}
								{/if}
							</span>
						</div>
					{/each}
				</div>
			{:else}
				<pre class="result-text">{typeof formattedResult === 'object' ? JSON.stringify(formattedResult, null, 2) : formattedResult}</pre>
			{/if}
		{/if}
	</div>
</FullTool>

<style>
	.tool-result-content {
		background: var(--muted);
		border-radius: 0.25rem;
		padding: 0.75rem;
		max-height: 400px;
		overflow-y: auto;
	}

	.result-text {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		line-height: 1.5;
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.key-value-display {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.kv-row {
		display: grid;
		grid-template-columns: minmax(120px, auto) 1fr;
		gap: 0.75rem;
		align-items: start;
	}

	.kv-key {
		font-weight: 600;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		word-break: break-word;
	}

	.kv-value {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		word-break: break-word;
		white-space: pre-wrap;
	}

	/* Responsive Design */
	@media (max-width: 640px) {
		.kv-row {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}
	}
</style>

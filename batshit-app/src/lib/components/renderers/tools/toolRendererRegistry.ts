// Tool Renderer Registry - Maps tool names to their Cool Tool renderers
import type { Component } from 'svelte'
import { canonicalToolName } from '$lib/utils/toolRenderMap'
import type { ToolProvider, ToolSource } from '$lib/utils/toolSourceDetector'
import type { ToolOperationKind, ToolRendererFamily } from '$lib/utils/toolActivityContract'
import {
	normalizeAgentBrowserCommandName,
	extractKnownToolNameFromRawName
} from '$lib/utils/toolNameNormalization'
import { parseJsonIfLikely } from '$lib/utils/toolPayloadUnwrap'

/**
 * ToolData - Complete tool execution data for renderer components
 *
 * This interface defines the props passed to all Cool Tool renderers.
 * Enhanced in Epic 6 to mirror IntermediateStep's tool source metadata.
 *
 * @see IntermediateStep in toolResultProcessor.ts for source data structure
 */
export interface ToolData {
	// Core fields (existing)
	toolName: string
	displayToolName?: string
	toolInput: any
	toolResult: any
	success: boolean
	error?: string
	displayMode?: 'minimal' | 'compact' | 'full' | 'custom'
	toolCategory?: string
	operationKind?: ToolOperationKind
	rendererFamily?: ToolRendererFamily
	rawSidecar?: {
		status: 'stored' | 'not_retained'
		zipId?: string
		reason?: string
	}

	// Tool Source Detection (Epic 6.1 - mirrors IntermediateStep)
        /** Identifies which system provided this tool (e.g., 'batshit-server', 'mcp', 'n8n-workflow') */
	toolProvider?: ToolProvider
        /** Identifies how the tool was attached (e.g., 'direct-attachment', 'mcp-gateway') */
	toolSource?: ToolSource

	// MCP Gateway Context (when toolSource === 'mcp-gateway')
	/** Unique identifier for the MCP gateway instance */
	gatewayId?: string
	/** Human-readable name of the gateway */
	gatewayName?: string
	/** Type of gateway (Docker Desktop, n8n MCP Trigger, n8n Instance MCP, or other streamable MCPs) */
	gatewayType?: 'docker' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'custom' | 'stdio'
	/** Name of the MCP server providing this tool (e.g., "github", "redis", "batshit-server") */
	mcpServerName?: string

	// Subagent Context (when toolProvider === 'subagent')
	/** Indicates if this tool call is a subagent execution */
	isSubagent?: boolean
	/** Name of the subagent that was called */
	subagentName?: string
	/** Slug/ID of the subagent that was called */
	subagentId?: string
	/** Name of the primary agent that called this subagent */
	agentName?: string
	/** Avatar URL for the subagent (if provided) */
	subagentAvatar?: string

	// Enhanced metadata structure
	metadata?: {
		/** Tool execution time in milliseconds */
		executionTime?: number
		/** Token count for this tool result */
		tokenCount?: number
		/** ISO timestamp of tool execution */
		timestamp?: string
		/** Structured MCP gateway context (alternative to flat fields above) */
			gatewayContext?: {
				id: string
				name: string
				type: 'docker' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'custom'
				mcpServer: string
			}
		[key: string]: any
	}
}

export interface ToolRendererProps {
	tool: ToolData
}

// Type for lazy-loaded component modules
type LazyComponent = () => Promise<{ default: Component<any> }>

// Core batshit-server tool renderers - manually mapped for performance
// NOTE: Keys use batshit_server_ prefix for namespace clarity and source-first detection
const coreRenderers: Record<string, LazyComponent> = {
	// === File Operations ===
	'batshit_server_read_file': () => import('./file/ReadFileRenderer.svelte'),
	'read_file': () => import('./file/ReadFileRenderer.svelte'),
	'batshit_server_overwrite_file': () => import('./file/WriteFileRenderer.svelte'),
	'write_file': () => import('./file/WriteFileRenderer.svelte'),
	'batshit_server_edit_file': () => import('./file/EditFileRenderer.svelte'),
	'edit_file': () => import('./file/EditFileRenderer.svelte'),
	'batshit_server_execute_command': () => import('./command/BashRenderer.svelte'),
	'execute_command': () => import('./command/BashRenderer.svelte'),
	'native_bash_execute': () => import('./command/BashRenderer.svelte'),
	'batshit_server_list_files': () => import('./file/ListFilesRenderer.svelte'),
	'list_files': () => import('./file/ListFilesRenderer.svelte'),
	'batshit_server_search_files': () => import('./file/SearchFilesRenderer.svelte'),
	'search_files': () => import('./file/SearchFilesRenderer.svelte'),

	// === Dynamic MCP (find) ===
	'batshit_server_dynamic_mcp_find': () => import('./mcp/DynamicMcpFindRenderer.svelte'),
	'dynamic_mcp_find': () => import('./mcp/DynamicMcpFindRenderer.svelte'),
	'native_dynamic_mcp_find': () => import('./mcp/DynamicMcpFindRenderer.svelte'),
	'batshit_tool_search': () => import('./generic/ToolFindRenderer.svelte'),
	'native_batshit_tool_search': () => import('./generic/ToolFindRenderer.svelte'),
	'batshit_server_cli_tool_find': () => import('./generic/ToolFindRenderer.svelte'),
	'cli_tool_find': () => import('./generic/ToolFindRenderer.svelte'),
	'native_cli_tool_find': () => import('./generic/ToolFindRenderer.svelte'),
	'batshit_server_cli_tool_use': () => import('./generic/CliToolRenderer.svelte'),
	'cli_tool_use': () => import('./generic/CliToolRenderer.svelte'),
	'native_cli_tool_use': () => import('./generic/CliToolRenderer.svelte'),
}

// Provider-native / custom tool renderers
const specialRenderers: Record<string, LazyComponent> = {
	'image_generation': () => import('./image/ImageGenerationRenderer.svelte')
}

function isAgentBrowserScreenshotToolResult(toolData: ToolData): boolean {
	const result = parseJsonIfLikely(toolData?.toolResult)
	const input = parseJsonIfLikely(toolData?.toolInput)

	const candidates = [
		(result as any)?.command,
		(result as any)?.toolName,
		(input as any)?.toolName,
		(input as any)?.command
	]

	return candidates.some((candidate) => normalizeAgentBrowserCommandName(candidate) === 'screenshot')
}

/**
 * SA-111 P4: true for the Workers batch tool on either lane. The name check covers both
 * `native_spawn_workers` (API) and the managed CLI bridge's composed MCP name; the
 * `rendererFamily` check covers a normalized step that already resolved the family.
 */
function looksLikeWorkersTool(toolName: string, toolData: ToolData): boolean {
	if (toolData?.rendererFamily === 'workers') return true
	const candidates = [toolName, toolData?.toolName, toolData?.displayToolName]
	return candidates.some(
		(candidate) => typeof candidate === 'string' && candidate.toLowerCase().includes('spawn_workers')
	)
}

function looksLikeAgentBrowserTool(...values: unknown[]): boolean {
	return values.some((value) => {
		const normalized = normalizeAgentBrowserCommandName(value)
		return (
			normalized === 'agent_browser_use' ||
			normalized === 'native_agent_browser_use' ||
			normalized.includes('agent_browser_use')
		)
	})
}

// Generic renderers for broader tool categories
const genericToolRenderer: LazyComponent = () => import('./generic/GenericToolRenderer.svelte')
const genericMCPRenderer: LazyComponent = () => import('./generic/GenericMCPRenderer.svelte')
const familyRenderers: Record<ToolRendererFamily, LazyComponent> = {
	read_file: () => import('./file/ReadFileRenderer.svelte'),
	skill_read: () => import('./file/ReadFileRenderer.svelte'),
	write_file: () => import('./file/WriteFileRenderer.svelte'),
	edit_file: () => import('./file/EditFileRenderer.svelte'),
	web_search: () => import('./web/WebSearchRenderer.svelte'),
	list_files: () => import('./file/ListFilesRenderer.svelte'),
	bash: () => import('./command/BashRenderer.svelte'),
	dynamic_find: () => import('./mcp/DynamicMcpFindRenderer.svelte'),
	tool_find: () => import('./generic/ToolFindRenderer.svelte'),
	cli_tool: () => import('./generic/CliToolRenderer.svelte'),
	generic_tool: () => import('./generic/GenericToolRenderer.svelte'),
	subagent: () => import('./subagent/CallSubagentRenderer.svelte'),
	// SA-111 P4: one `spawn_workers` call, up to three runs, one card.
	workers: () => import('./workers/WorkersRenderer.svelte')
}


/**
 * Enhanced renderer resolution with SOURCE-FIRST detection
 *
 * PRIORITY ORDER (strict hierarchy):
 * 1. Subagent calls (highest priority - special case)
 * 2. batshit-server tools (SOURCE-FIRST: check source, then name)
 * 3. MCP Gateway tools (gateway-based)
 * 4. Generic fallback (n8n workflows and other tools)
 *
 * CRITICAL: Null safety for TECH-003 risk mitigation
 *
 * @param toolName - Name of the tool being rendered
 * @param toolData - Complete tool execution data with source metadata (may be null/undefined)
 * @returns Component renderer for the tool (always returns a renderer, never null)
 */
export async function getToolRenderer(toolName: string, toolData?: ToolData | null): Promise<Component<any>> {
	// Normalise to canonical for renderer lookup while preserving original for logs
	const canonicalName = canonicalToolName(toolName)
	const canonicalKey = canonicalName.toLowerCase()
	// NULL SAFETY: Handle missing toolData gracefully (TECH-003 mitigation)
	if (!toolData) {
		console.warn(`[Renderer] No toolData provided for ${toolName}, using GenericToolRenderer`)
		const module = await genericToolRenderer()
		return module.default
	}

	// SA-111 P4: a Workers batch is checked BEFORE the subagent branch. `native_spawn_workers`
	// is a native tool so it would fall through anyway, but the managed CLI lane's
	// `mcp__batshit_gateway_<seg>__spawn_workers` is not, and it must never render as a
	// subagent conversation card.
	if (looksLikeWorkersTool(toolName, toolData)) {
		const module = await import('./workers/WorkersRenderer.svelte')
		return module.default
	}

	// PRIORITY 1: Subagent calls (highest priority - special case)
	// Checks THREE conditions: isSubagent flag, toolName match, or subagentName present
	// BUT: native tools (fabric_find/use, dynamic_mcp) are NEVER subagents — skip for them
	const isNativeToolSource = toolData.toolSource === 'native-tool' || toolName?.startsWith('native_')
	if (!isNativeToolSource && (toolData.isSubagent || toolName === 'call_subagent' || toolData.subagentName || toolData.toolProvider === 'subagent')) {
		const module = await import('./subagent/CallSubagentRenderer.svelte')
		return module.default
	}

	// SPECIAL CASE: Dynamic Tool Search compatibility routes (work across providers/modes)
	const nameLower = (toolData.displayToolName || toolName || '').toLowerCase()
	if (nameLower.includes('dynamic_mcp_find')) {
		const module = await import('./mcp/DynamicMcpFindRenderer.svelte')
		return module.default
	}

	// SPECIAL CASE: Provider-native image generation tool
	if (specialRenderers[canonicalKey]) {
		const module = await specialRenderers[canonicalKey]()
		return module.default
	}

	// SPECIAL CASE: Agent Browser screenshot output (URL-first render path)
	if (
		isAgentBrowserScreenshotToolResult(toolData) &&
		looksLikeAgentBrowserTool(toolName, toolData?.toolName, toolData?.displayToolName, canonicalName)
	) {
		const module = await import('./image/AgentBrowserScreenshotRenderer.svelte')
		return module.default
	}

	if (toolData?.rendererFamily && familyRenderers[toolData.rendererFamily]) {
		try {
			const module = await familyRenderers[toolData.rendererFamily]()
			return module.default
		} catch (error) {
			console.warn(
				`[Renderer] Failed to load renderer family ${toolData.rendererFamily} for ${toolName}:`,
				error
			)
		}
	}

	// PRIORITY 2: batshit-server tools (SOURCE-FIRST: check source, then name)
	// ⚠️ CRITICAL CHANGE: Check SOURCE before NAME (Story 6.7b requirement)
	// Works for ANY batshit-server source: direct-attachment, Docker Gateway, n8n MCP Trigger
	const isBatshitServerSource =
		toolData?.toolProvider === 'batshit-server' ||
		toolData?.mcpServerName === 'batshit-server'

	if (isBatshitServerSource) {
		// Source confirmed as batshit-server - NOW check if custom renderer exists
		// CRITICAL FIX: Extract base tool name from gateway-prefixed names
		// Example: 'My_n8n_MCP_Trigger_batshit_server_read_file' → 'batshit_server_read_file'
		let baseToolName = canonicalName || toolName
		const batshitServerToolNames = Object.keys(coreRenderers).filter((name) => name.startsWith('batshit_server_'))
		baseToolName =
			extractKnownToolNameFromRawName(toolName, batshitServerToolNames) ||
			baseToolName

		if (coreRenderers[baseToolName] || coreRenderers[canonicalName]) {
			try {
				const module = await (coreRenderers[baseToolName] || coreRenderers[canonicalName])()
				return module.default
			} catch (error) {
				console.warn(`[Renderer] Failed to load batshit-server renderer for ${baseToolName}:`, error)
				console.warn(`[Renderer] Falling through to Priority 3/4 for ${toolName}`)
				// Fall through to next priority (no return statement)
			}
		}
	}

	// PRIORITY 3: MCP Gateway tools (gateway-based)
	// Requires BOTH conditions: toolSource AND toolProvider
	if (toolData?.toolSource === 'mcp-gateway' && toolData?.toolProvider === 'mcp') {
		const module = await genericMCPRenderer()
		return module.default
	}

	// PRIORITY 4: Everything else (n8n workflows, generic MCP tools, etc.)
	// Generic fallback for all remaining tools
	const module = await genericToolRenderer()
	return module.default
}

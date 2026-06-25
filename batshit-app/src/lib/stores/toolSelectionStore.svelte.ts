/**
 * Tool Selection Store (SA-009: Simplified Flat List)
 *
 * Manages MCP tool selections using a flat list of enabled tool names.
 * Simple model: if tool is in list = enabled, if not = disabled.
 *
 * CRITICAL: Uses Svelte 5 $state (NOT writable stores)
 */

import type { MCPToolSelections } from '$lib/types/database'

/**
 * Tool Selection State
 *
 * Flat list model - no nested gateway/MCP structure
 */
class ToolSelectionState {
	// Current enabled tools (flat list of tool names)
	selections = $state<Set<string>>(new Set())

	// Agent default selections (for override detection)
	defaults = $state<Set<string>>(new Set())

	// Enable a single tool
	enableTool(toolName: string) {
		this.selections.add(toolName)
		// Trigger reactivity by reassigning
		this.selections = new Set(this.selections)
	}

	// Disable a single tool
	disableTool(toolName: string) {
		this.selections.delete(toolName)
		// Trigger reactivity by reassigning
		this.selections = new Set(this.selections)
	}

	// Toggle a single tool
	toggleTool(toolName: string) {
		if (this.selections.has(toolName)) {
			this.disableTool(toolName)
		} else {
			this.enableTool(toolName)
		}
	}

	// Check if a tool is enabled
	isToolEnabled(toolName: string): boolean {
		return this.selections.has(toolName)
	}

	// Enable multiple tools at once (for group/gateway toggles)
	enableTools(toolNames: string[]) {
		for (const name of toolNames) {
			this.selections.add(name)
		}
		this.selections = new Set(this.selections)
	}

	// Disable multiple tools at once (for group/gateway toggles)
	disableTools(toolNames: string[]) {
		for (const name of toolNames) {
			this.selections.delete(name)
		}
		this.selections = new Set(this.selections)
	}

	// Set the complete list of enabled tools (replaces current selection)
	setEnabledTools(toolNames: string[]) {
		this.selections = new Set(toolNames)
	}

	// Load from agent defaults
	loadDefaults(defaults: MCPToolSelections | undefined) {
		const toolList = Array.isArray(defaults) ? defaults : []
		this.defaults = new Set(toolList)
		this.selections = new Set(toolList)
	}

	// Reset to agent defaults
	resetToDefaults() {
		this.selections = new Set(this.defaults)
	}

	// Check if current selections differ from defaults
	get hasOverrides(): boolean {
		if (this.selections.size !== this.defaults.size) return true
		for (const tool of this.selections) {
			if (!this.defaults.has(tool)) return true
		}
		return false
	}

	// Get total selected tools count
	get totalSelectedTools(): number {
		return this.selections.size
	}

	// Clear all selections
	clear() {
		this.selections = new Set()
		this.defaults = new Set()
	}

	// Export current selections as array (for persistence)
	export(): MCPToolSelections {
		return Array.from(this.selections).sort()
	}

	// Import selections from array
	import(selections: MCPToolSelections | undefined) {
		const toolList = Array.isArray(selections) ? selections : []
		this.selections = new Set(toolList)
	}

	// Get the Set directly (for reactive UI bindings)
	get enabledTools(): Set<string> {
		return this.selections
	}
}

// Export singleton instance
export const toolSelectionStore = new ToolSelectionState()

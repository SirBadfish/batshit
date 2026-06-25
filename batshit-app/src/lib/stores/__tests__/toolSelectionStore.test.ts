/**
 * SA-009 - Tool Selection Store (Flat List Model)
 *
 * Tests for the simplified flat list tool selection store.
 * Simple model: if tool is in list = enabled, if not = disabled.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { toolSelectionStore } from '$lib/stores/toolSelectionStore.svelte'
import type { MCPToolSelections } from '$lib/types/database'

describe('SA-009 - Tool Selection Store (Flat List Model)', () => {

	// Reset store before each test
	beforeEach(() => {
		toolSelectionStore.clear()
	})

	describe('Basic State Management', () => {

		test('enableTool adds a tool to selections', () => {
			toolSelectionStore.enableTool('batshit_server_read_file')

			expect(toolSelectionStore.isToolEnabled('batshit_server_read_file')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('batshit_server_overwrite_file')).toBe(false)
		})

		test('disableTool removes a tool from selections', () => {
			toolSelectionStore.enableTool('batshit_server_read_file')
			toolSelectionStore.enableTool('batshit_server_overwrite_file')
			toolSelectionStore.disableTool('batshit_server_read_file')

			expect(toolSelectionStore.isToolEnabled('batshit_server_read_file')).toBe(false)
			expect(toolSelectionStore.isToolEnabled('batshit_server_overwrite_file')).toBe(true)
		})

		test('toggleTool switches state', () => {
			toolSelectionStore.toggleTool('batshit_server_read_file')
			expect(toolSelectionStore.isToolEnabled('batshit_server_read_file')).toBe(true)

			toolSelectionStore.toggleTool('batshit_server_read_file')
			expect(toolSelectionStore.isToolEnabled('batshit_server_read_file')).toBe(false)
		})

		test('export returns sorted flat array', () => {
			toolSelectionStore.enableTool('redis_set')
			toolSelectionStore.enableTool('redis_get')
			toolSelectionStore.enableTool('github_search')

			const exported = toolSelectionStore.export()

			expect(exported).toEqual(['github_search', 'redis_get', 'redis_set'])
		})

		test('import loads flat array', () => {
			const selections: MCPToolSelections = ['batshit_server_read_file', 'batshit_server_overwrite_file', 'redis_get']

			toolSelectionStore.import(selections)

			expect(toolSelectionStore.isToolEnabled('batshit_server_read_file')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('batshit_server_overwrite_file')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('redis_get')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('redis_del')).toBe(false)
		})
	})

	describe('Bulk Operations', () => {

		test('enableTools adds multiple tools at once', () => {
			toolSelectionStore.enableTools(['redis_get', 'redis_set', 'redis_del'])

			expect(toolSelectionStore.isToolEnabled('redis_get')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('redis_set')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('redis_del')).toBe(true)
			expect(toolSelectionStore.totalSelectedTools).toBe(3)
		})

		test('disableTools removes multiple tools at once', () => {
			toolSelectionStore.enableTools(['redis_get', 'redis_set', 'redis_del', 'github_search'])
			toolSelectionStore.disableTools(['redis_get', 'redis_del'])

			expect(toolSelectionStore.isToolEnabled('redis_get')).toBe(false)
			expect(toolSelectionStore.isToolEnabled('redis_set')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('redis_del')).toBe(false)
			expect(toolSelectionStore.isToolEnabled('github_search')).toBe(true)
			expect(toolSelectionStore.totalSelectedTools).toBe(2)
		})

		test('setEnabledTools replaces all selections', () => {
			toolSelectionStore.enableTools(['old_tool_1', 'old_tool_2'])
			toolSelectionStore.setEnabledTools(['new_tool_1', 'new_tool_2', 'new_tool_3'])

			expect(toolSelectionStore.isToolEnabled('old_tool_1')).toBe(false)
			expect(toolSelectionStore.isToolEnabled('old_tool_2')).toBe(false)
			expect(toolSelectionStore.isToolEnabled('new_tool_1')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('new_tool_2')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('new_tool_3')).toBe(true)
			expect(toolSelectionStore.totalSelectedTools).toBe(3)
		})
	})

	describe('Agent Defaults Loading', () => {

		test('loadDefaults loads flat array as both selections and defaults', () => {
			const agentDefaults: MCPToolSelections = ['batshit_server_read_file', 'batshit_server_overwrite_file', 'redis_get']

			toolSelectionStore.loadDefaults(agentDefaults)

			expect(toolSelectionStore.isToolEnabled('batshit_server_read_file')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('batshit_server_overwrite_file')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('redis_get')).toBe(true)
			expect(toolSelectionStore.hasOverrides).toBe(false)
		})

		test('loadDefaults with undefined results in empty selections', () => {
			toolSelectionStore.loadDefaults(undefined)

			const exported = toolSelectionStore.export()
			expect(exported).toEqual([])
			expect(toolSelectionStore.hasOverrides).toBe(false)
		})

		test('loadDefaults with empty array results in empty selections', () => {
			toolSelectionStore.loadDefaults([])

			expect(toolSelectionStore.totalSelectedTools).toBe(0)
			expect(toolSelectionStore.hasOverrides).toBe(false)
		})
	})

	describe('Override Detection', () => {

		test('hasOverrides = false when matching defaults', () => {
			const defaults: MCPToolSelections = ['redis_get', 'redis_set']

			toolSelectionStore.loadDefaults(defaults)

			expect(toolSelectionStore.hasOverrides).toBe(false)
		})

		test('hasOverrides = true when tool added', () => {
			const defaults: MCPToolSelections = ['redis_get', 'redis_set']

			toolSelectionStore.loadDefaults(defaults)
			toolSelectionStore.enableTool('redis_del')

			expect(toolSelectionStore.hasOverrides).toBe(true)
		})

		test('hasOverrides = true when tool removed', () => {
			const defaults: MCPToolSelections = ['redis_get', 'redis_set', 'redis_del']

			toolSelectionStore.loadDefaults(defaults)
			toolSelectionStore.disableTool('redis_del')

			expect(toolSelectionStore.hasOverrides).toBe(true)
		})

		test('hasOverrides = false after resetToDefaults', () => {
			const defaults: MCPToolSelections = ['redis_get', 'redis_set']

			toolSelectionStore.loadDefaults(defaults)
			toolSelectionStore.enableTool('github_search')
			expect(toolSelectionStore.hasOverrides).toBe(true)

			toolSelectionStore.resetToDefaults()

			expect(toolSelectionStore.hasOverrides).toBe(false)
			expect(toolSelectionStore.isToolEnabled('redis_get')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('redis_set')).toBe(true)
			expect(toolSelectionStore.isToolEnabled('github_search')).toBe(false)
		})

		test('hasOverrides = true when completely different tools', () => {
			const defaults: MCPToolSelections = ['tool_a', 'tool_b']

			toolSelectionStore.loadDefaults(defaults)
			toolSelectionStore.setEnabledTools(['tool_c', 'tool_d'])

			expect(toolSelectionStore.hasOverrides).toBe(true)
		})
	})

	describe('Tool Count', () => {

		test('totalSelectedTools returns count of enabled tools', () => {
			toolSelectionStore.enableTools(['redis_get', 'redis_set', 'redis_del', 'github_search'])

			expect(toolSelectionStore.totalSelectedTools).toBe(4)
		})

		test('totalSelectedTools returns 0 for empty selections', () => {
			expect(toolSelectionStore.totalSelectedTools).toBe(0)
		})

		test('totalSelectedTools updates on enable/disable', () => {
			toolSelectionStore.enableTool('tool_1')
			expect(toolSelectionStore.totalSelectedTools).toBe(1)

			toolSelectionStore.enableTool('tool_2')
			expect(toolSelectionStore.totalSelectedTools).toBe(2)

			toolSelectionStore.disableTool('tool_1')
			expect(toolSelectionStore.totalSelectedTools).toBe(1)
		})
	})

	describe('enabledTools Getter', () => {

		test('enabledTools returns Set of enabled tools', () => {
			toolSelectionStore.enableTools(['redis_get', 'redis_set'])

			const enabledSet = toolSelectionStore.enabledTools

			expect(enabledSet.has('redis_get')).toBe(true)
			expect(enabledSet.has('redis_set')).toBe(true)
			expect(enabledSet.has('redis_del')).toBe(false)
		})
	})

	describe('Clear', () => {

		test('clear removes all selections and defaults', () => {
			toolSelectionStore.loadDefaults(['tool_a', 'tool_b'])
			toolSelectionStore.enableTool('tool_c')

			toolSelectionStore.clear()

			expect(toolSelectionStore.totalSelectedTools).toBe(0)
			expect(toolSelectionStore.export()).toEqual([])
			expect(toolSelectionStore.hasOverrides).toBe(false)
		})
	})
})

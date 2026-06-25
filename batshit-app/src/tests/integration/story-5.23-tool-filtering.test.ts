/**
 * SA-009 - Tool Selection & Filtering Tests (Flat List Model)
 *
 * CRITICAL: Tests backend filtering logic
 * SA-009 changed MCPToolSelections from nested object to flat string[]
 *
 * P0 Tests:
 * - Empty array [] selection returns no tools
 * - Specific array [...] returns only those tools (by name match)
 * - No selections = no tools
 * - Performance benchmark <50ms
 */

import { describe, test, expect } from 'vitest'
import { MCPGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import type { MCPToolSelections } from '$lib/types/database'
import type { Tool } from 'ai'

// Mock tools for testing (with name property as ToolWithName)
const mockRedisTools = [
	{ name: 'Redis_get', description: 'Get value from Redis', parameters: {} },
	{ name: 'Redis_set', description: 'Set value in Redis', parameters: {} },
	{ name: 'Redis_del', description: 'Delete key from Redis', parameters: {} },
	{ name: 'Redis_hgetall', description: 'Get hash', parameters: {} },
	{ name: 'Redis_scan', description: 'Scan keys', parameters: {} }
] as any[]

const mockGithubTools = [
	{ name: 'Github_search-issues', description: 'Search issues', parameters: {} },
	{ name: 'Github_create-issue', description: 'Create issue', parameters: {} },
	{ name: 'Github_get-pr', description: 'Get PR', parameters: {} }
] as any[]

const mockInternalHelperTools = [
	{ name: 'batshit_server_dynamic_mcp_find', description: 'Find MCP tools', parameters: {} },
	{ name: 'batshit_server_dynamic_mcp_use', description: 'Use MCP tool', parameters: {} },
	{ name: 'mcp_fabric_find', description: 'Find Fabric controls', parameters: {} },
	{ name: 'mcp_fabric_use', description: 'Use Fabric control', parameters: {} }
] as any[]

const mockN8nTools = [
	{ name: 'n8n_list_workflows', description: 'List workflows', parameters: {} },
	{ name: 'n8n_execute_workflow', description: 'Execute workflow', parameters: {} }
] as any[]

describe('SA-009 - Backend Tool Filtering (Flat List Model)', () => {

	// Create instance for testing
	const discovery = new MCPGatewayDiscovery()

	describe('Basic Filtering (Flat List)', () => {

		test('Empty array [] returns no tools', () => {
			// SA-009: Empty array = no tools enabled
			const toolSelections: MCPToolSelections = []

			const filtered = discovery.filterToolsBySelection(
				mockRedisTools,
				'test-gateway',
				'Docker Gateway',
				toolSelections
			)

			// Should return ZERO tools (no selections = nothing enabled)
			expect(filtered).toHaveLength(0)
		})

		test('Specific tools in array returns only those tools', () => {
			// SA-009: Flat array of enabled tool names
			const toolSelections: MCPToolSelections = ['Redis_get', 'Redis_set', 'Redis_del']

			const filtered = discovery.filterToolsBySelection(
				mockRedisTools,
				'test-gateway',
				'Docker Gateway',
				toolSelections
			)

			// Should return exactly 3 tools
			expect(filtered).toHaveLength(3)

			// Verify correct tools selected
			const toolNames = filtered.map(t => t.name)
			expect(toolNames).toContain('Redis_get')
			expect(toolNames).toContain('Redis_set')
			expect(toolNames).toContain('Redis_del')
			expect(toolNames).not.toContain('Redis_hgetall')
			expect(toolNames).not.toContain('Redis_scan')
		})

		test('Undefined selections with no build context returns no tools', () => {
			// SA-009: undefined selections = no tools (unless artifacts build context injects)
			const filtered = discovery.filterToolsBySelection(
				mockRedisTools,
				'test-gateway',
				'Docker Gateway',
				undefined
			)

			// Should return ZERO tools (no selections and no build context injection)
			expect(filtered).toHaveLength(0)
		})

		test('Mixed tools from different MCPs in flat list', () => {
			// SA-009: All tools in one flat array regardless of MCP
			const toolSelections: MCPToolSelections = [
				'Redis_get', 'Redis_set',
				'Github_search-issues'
			]

			// Combine all tools
			const allTools = [...mockRedisTools, ...mockGithubTools]

			const filtered = discovery.filterToolsBySelection(
				allTools,
				'test-gateway',
				'Docker Gateway',
				toolSelections
			)

			// Should return exactly 3 tools
			expect(filtered).toHaveLength(3)

			const toolNames = filtered.map(t => t.name)
			expect(toolNames).toContain('Redis_get')
			expect(toolNames).toContain('Redis_set')
			expect(toolNames).toContain('Github_search-issues')
		})
	})

	describe('No Implicit Tool Injection (Skill-Scoped Tooling)', () => {

		test('Internal helper tools are disabled when not explicitly selected', () => {
			const filtered = discovery.filterToolsBySelection(
				mockInternalHelperTools,
				'test-gateway',
				'Docker Gateway',
				[]
			)

			expect(filtered).toHaveLength(0)
		})

		test('Explicit helper selections enable only selected helper tools', () => {
			const toolSelections: MCPToolSelections = ['batshit_server_dynamic_mcp_find', 'mcp_fabric_use']

			const filtered = discovery.filterToolsBySelection(
				mockInternalHelperTools,
				'test-gateway',
				'Docker Gateway',
				toolSelections
			)

			expect(filtered).toHaveLength(2)

			const toolNames = filtered.map(t => t.name)
			expect(toolNames).toContain('batshit_server_dynamic_mcp_find')
			expect(toolNames).toContain('mcp_fabric_use')
			expect(toolNames).not.toContain('batshit_server_dynamic_mcp_use')
			expect(toolNames).not.toContain('mcp_fabric_find')
		})

		test('n8n tools are never auto-added and require explicit selection', () => {
			const allTools = [...mockInternalHelperTools, ...mockN8nTools]
			const filtered = discovery.filterToolsBySelection(
				allTools,
				'test-gateway',
				'Docker Gateway',
				['n8n_execute_workflow']
			)

			expect(filtered).toHaveLength(1)
			expect(filtered[0].name).toBe('n8n_execute_workflow')
		})
	})

	describe('Performance Benchmark', () => {

		test('Tool filtering completes in <50ms', () => {
			// Create large tool set (168 tools like in story)
			const largeToolSet: any[] = []
			for (let i = 0; i < 168; i++) {
				largeToolSet.push({
					name: `Redis_tool${i}`,
					description: `Tool ${i}`,
					parameters: {}
				})
			}

			// SA-009: Flat array with 5 specific tools
			const toolSelections: MCPToolSelections = [
				'Redis_tool1', 'Redis_tool5', 'Redis_tool10', 'Redis_tool15', 'Redis_tool20'
			]

			// Measure performance
			const startTime = performance.now()

			const filtered = discovery.filterToolsBySelection(
				largeToolSet,
				'test-gateway',
				'Docker Gateway',
				toolSelections
			)

			const endTime = performance.now()
			const latency = endTime - startTime

			// Verify correctness
			expect(filtered).toHaveLength(5)

			// Verify performance (AC25: <50ms target)
			expect(latency).toBeLessThan(50)

			console.log(`[SA-009-PERF] Filtered 168 tools to 5 in ${latency.toFixed(2)}ms`)
		})

		test('Performance with very large selection list', () => {
			// Large tool set
			const largeToolSet: any[] = []
			for (let i = 0; i < 500; i++) {
				largeToolSet.push({
					name: `Tool_${i}`,
					description: `Tool ${i}`,
					parameters: {}
				})
			}

			// SA-009: Many tools selected
			const toolSelections: MCPToolSelections = []
			for (let i = 0; i < 200; i++) {
				toolSelections.push(`Tool_${i}`)
			}

			const startTime = performance.now()

			const filtered = discovery.filterToolsBySelection(
				largeToolSet,
				'test-gateway',
				'Docker Gateway',
				toolSelections
			)

			const endTime = performance.now()
			const latency = endTime - startTime

			// Should have 200 tools (first 200 match)
			expect(filtered).toHaveLength(200)

			// Should still be fast
			expect(latency).toBeLessThan(50)

			console.log(`[SA-009-PERF] Filtered 500 tools to 200 in ${latency.toFixed(2)}ms`)
		})
	})
})

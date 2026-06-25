/**
 * Type Validation Tests for Epic 6.1 Data Model Enhancements
 *
 * Tests the enhanced IntermediateStep and ToolData interfaces
 * to ensure all new optional fields work correctly.
 */

import { describe, it, expect } from 'vitest'
import type { IntermediateStep } from '$lib/utils/toolResultProcessor'
import type { ToolData } from '$lib/components/renderers/tools/toolRendererRegistry'

describe('Epic 6.1 Data Model Enhancements', () => {
	describe('IntermediateStep Interface', () => {
		it('should accept basic tool execution without new fields', () => {
			const step: IntermediateStep = {
				type: 'tool',
				toolName: 'read_file',
				toolArgs: { filePath: '/path/to/file.ts' },
				toolResult: 'file contents'
			}

			expect(step.toolName).toBe('read_file')
			expect(step.type).toBe('tool')
		})

		it('should accept tool with batshit-server direct attachment metadata', () => {
			const step: IntermediateStep = {
				type: 'tool',
				toolName: 'read_file',
				toolArgs: { filePath: '/path/to/file.ts' },
				toolResult: 'file contents',
				toolProvider: 'batshit-server',
				toolSource: 'direct-attachment',
				executionTime: 150,
				success: true
			}

			expect(step.toolProvider).toBe('batshit-server')
			expect(step.toolSource).toBe('direct-attachment')
			expect(step.executionTime).toBe(150)
			expect(step.success).toBe(true)
		})

		it('should accept tool with MCP gateway metadata', () => {
			const step: IntermediateStep = {
				type: 'tool',
				toolName: 'github-search-issues',
				toolArgs: { query: 'bug' },
				toolResult: { items: [] },
				toolProvider: 'mcp',
				toolSource: 'mcp-gateway',
				gatewayId: 'docker-gateway-1',
				gatewayName: 'Docker MCP Gateway',
				gatewayType: 'docker',
				mcpServerName: 'github',
				executionTime: 320,
				success: true
			}

			expect(step.toolProvider).toBe('mcp')
			expect(step.toolSource).toBe('mcp-gateway')
			expect(step.gatewayType).toBe('docker')
			expect(step.mcpServerName).toBe('github')
		})

		it('should accept tool with n8n MCP trigger gateway metadata', () => {
			const step: IntermediateStep = {
				type: 'tool',
				toolName: 'custom-tool',
				toolArgs: { input: 'test' },
				toolResult: { output: 'result' },
				toolProvider: 'mcp',
				toolSource: 'mcp-gateway',
				gatewayId: 'n8n-code-tools',
				gatewayName: 'Code Tools Gateway',
				gatewayType: 'n8n-mcp-trigger',
				mcpServerName: 'custom-mcp',
				executionTime: 250,
				success: true
			}

			expect(step.gatewayType).toBe('n8n-mcp-trigger')
			expect(step.gatewayId).toBe('n8n-code-tools')
		})

		it('should accept subagent tool execution', () => {
			const step: IntermediateStep = {
				type: 'tool',
				toolName: 'call_subagent',
				toolArgs: { prompt: 'Analyze this code' },
				toolResult: { response: 'Analysis complete' },
				toolProvider: 'subagent',
				toolSource: 'direct-attachment',
				isSubagent: true,
				subagentName: 'Code Analyzer',
				agentName: 'Primary Agent',
				executionTime: 5200,
				success: true
			}

			expect(step.toolProvider).toBe('subagent')
			expect(step.isSubagent).toBe(true)
			expect(step.subagentName).toBe('Code Analyzer')
			expect(step.agentName).toBe('Primary Agent')
		})

		it('should accept n8n workflow as tool', () => {
			const step: IntermediateStep = {
				type: 'tool',
				toolName: 'analyze-data-workflow',
				toolArgs: { data: [1, 2, 3] },
				toolResult: { summary: 'stats' },
				toolProvider: 'n8n-workflow',
				toolSource: 'workflow',
				executionTime: 1200,
				success: true
			}

			expect(step.toolProvider).toBe('n8n-workflow')
			expect(step.toolSource).toBe('workflow')
		})

                it('should accept batshit-server tool metadata', () => {
                        const step: IntermediateStep = {
                                type: 'tool',
                                toolName: 'batshit_server_read_file',
                                toolArgs: { path: '/workspace/file.txt' },
                                toolResult: { content: 'hello world' },
                                toolProvider: 'batshit-server',
                                toolSource: 'direct-attachment',
                                executionTime: 10,
                                success: true
                        }

                        expect(step.toolProvider).toBe('batshit-server')
                        expect(step.toolSource).toBe('direct-attachment')
                })

		it('should accept tool error with metadata', () => {
			const step: IntermediateStep = {
				type: 'tool_error',
				toolName: 'failing-tool',
				error: 'Tool execution failed',
				toolProvider: 'mcp',
				toolSource: 'mcp-gateway',
				executionTime: 100,
				success: false
			}

			expect(step.type).toBe('tool_error')
			expect(step.success).toBe(false)
		})

		it('should allow all new fields to be optional', () => {
			// This should compile without any of the new fields
			const step: IntermediateStep = {
				type: 'tool',
				toolName: 'some-tool'
			}

			// All new fields should be undefined
			expect(step.toolProvider).toBeUndefined()
			expect(step.toolSource).toBeUndefined()
			expect(step.gatewayId).toBeUndefined()
			expect(step.isSubagent).toBeUndefined()
			expect(step.executionTime).toBeUndefined()
		})
	})

	describe('ToolData Interface', () => {
		it('should accept basic tool data without new fields', () => {
			const toolData: ToolData = {
				toolName: 'read_file',
				toolInput: { filePath: '/path/to/file.ts' },
				toolResult: 'file contents',
				success: true
			}

			expect(toolData.toolName).toBe('read_file')
			expect(toolData.success).toBe(true)
		})

		it('should accept tool data with batshit-server metadata', () => {
			const toolData: ToolData = {
				toolName: 'read_file',
				toolInput: { filePath: '/path/to/file.ts' },
				toolResult: 'file contents',
				success: true,
				toolProvider: 'batshit-server',
				toolSource: 'direct-attachment',
				displayMode: 'full'
			}

			expect(toolData.toolProvider).toBe('batshit-server')
			expect(toolData.toolSource).toBe('direct-attachment')
		})

		it('should accept tool data with MCP gateway context (flat fields)', () => {
			const toolData: ToolData = {
				toolName: 'github-search',
				toolInput: { query: 'test' },
				toolResult: { items: [] },
				success: true,
				toolProvider: 'mcp',
				toolSource: 'mcp-gateway',
				gatewayId: 'docker-gateway-1',
				gatewayName: 'GitHub MCP',
				gatewayType: 'docker',
				mcpServerName: 'github',
				displayMode: 'compact'
			}

			expect(toolData.gatewayType).toBe('docker')
			expect(toolData.mcpServerName).toBe('github')
		})

		it('should accept tool data with enhanced metadata structure', () => {
			const toolData: ToolData = {
				toolName: 'redis-get',
				toolInput: { key: 'user:123' },
				toolResult: { name: 'Josh' },
				success: true,
				toolProvider: 'mcp',
				toolSource: 'mcp-gateway',
				metadata: {
					executionTime: 45,
					tokenCount: 150,
					timestamp: '2025-10-02T20:00:00Z',
					gatewayContext: {
						id: 'docker-gateway-1',
						name: 'Docker MCP Gateway',
						type: 'docker',
						mcpServer: 'redis'
					}
				}
			}

			expect(toolData.metadata?.executionTime).toBe(45)
			expect(toolData.metadata?.gatewayContext?.type).toBe('docker')
			expect(toolData.metadata?.gatewayContext?.mcpServer).toBe('redis')
		})

		it('should accept tool data with subagent context', () => {
			const toolData: ToolData = {
				toolName: 'call_subagent',
				toolInput: { prompt: 'Analyze code' },
				toolResult: { response: 'Analysis done' },
				success: true,
				toolProvider: 'subagent',
				toolSource: 'direct-attachment',
				isSubagent: true,
				subagentName: 'Code Analyzer',
				agentName: 'Primary Agent',
				displayMode: 'custom'
			}

			expect(toolData.toolProvider).toBe('subagent')
			expect(toolData.isSubagent).toBe(true)
			expect(toolData.subagentName).toBe('Code Analyzer')
		})

		it('should allow all new fields to be optional', () => {
			const toolData: ToolData = {
				toolName: 'some-tool',
				toolInput: {},
				toolResult: null,
				success: false
			}

			// All new fields should be undefined
			expect(toolData.toolProvider).toBeUndefined()
			expect(toolData.toolSource).toBeUndefined()
			expect(toolData.gatewayId).toBeUndefined()
			expect(toolData.isSubagent).toBeUndefined()
		})
	})

        describe('Tool Source Matrix Coverage', () => {
                it('should support all primary tool source combinations from architecture', () => {
                        const toolSources: Array<{
                                name: string
                                provider: IntermediateStep['toolProvider']
                                source: IntermediateStep['toolSource']
                        }> = [
                                { name: 'batshit-server Direct', provider: 'batshit-server', source: 'direct-attachment' },
                                { name: 'batshit-server MCP Gateway', provider: 'batshit-server', source: 'mcp-gateway' },
                                { name: 'n8n Workflow Tool', provider: 'n8n-workflow', source: 'workflow' },
                                { name: 'Docker MCP', provider: 'mcp', source: 'mcp-gateway' },
                                { name: 'Subagent Mode 2', provider: 'subagent', source: 'direct-attachment' },
                                { name: 'Subagent Mode 3', provider: 'subagent', source: 'workflow' }
                        ]

                        toolSources.forEach(({ name, provider, source }) => {
				const step: IntermediateStep = {
					type: 'tool',
					toolName: `test-${name}`,
					toolProvider: provider,
					toolSource: source
				}

				expect(step.toolProvider).toBe(provider)
				expect(step.toolSource).toBe(source)
			})

                        // All combinations should compile and validate
                        expect(toolSources).toHaveLength(6)
                })
        })

	describe('Backward Compatibility', () => {
		it('should handle IntermediateStep from legacy code (no new fields)', () => {
			// Simulates old code that doesn't know about new fields
			const legacyStep = {
				type: 'tool' as const,
				toolName: 'legacy-tool',
				toolArgs: { input: 'test' },
				toolResult: { output: 'result' }
			}

			// Should be assignable to new interface
			const newStep: IntermediateStep = legacyStep
			expect(newStep.toolName).toBe('legacy-tool')
		})

		it('should handle ToolData from legacy renderers', () => {
			// Simulates old renderer that doesn't use new fields
			const legacyToolData = {
				toolName: 'legacy-tool',
				toolInput: { input: 'test' },
				toolResult: { output: 'result' },
				success: true
			}

			// Should be assignable to new interface
			const newToolData: ToolData = legacyToolData
			expect(newToolData.toolName).toBe('legacy-tool')
		})
	})
})

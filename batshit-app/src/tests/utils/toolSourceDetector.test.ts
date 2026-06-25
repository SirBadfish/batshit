/**
 * Tool Source Detector Tests
 *
 * Comprehensive test suite for detectToolSource() function
 * Tests all 6 priority levels + edge cases for 100% coverage
 */

import { describe, it, expect } from 'vitest'
import { detectToolSource, type ToolSourceDetectionResult } from '$lib/utils/toolSourceDetector'
import type { IntermediateStep } from '$lib/utils/toolResultProcessor'

describe('Tool Source Detector', () => {
  describe('PRIORITY 1: Explicit Metadata Override', () => {
    it('should trust explicit toolProvider and toolSource when present', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'some_random_tool',
        toolProvider: 'mcp',
        toolSource: 'mcp-gateway',
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('mcp')
      expect(result.toolSource).toBe('mcp-gateway')
      expect(result.isSubagent).toBe(false)
    })

    it('should trust explicit metadata even with conflicting signals', () => {
      // Tool name says batshit-server, gateway metadata says MCP, but explicit says workflow
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_read_file', // batshit-server tool name
        toolProvider: 'n8n-workflow', // Explicit override
        toolSource: 'workflow', // Explicit override
        gatewayId: 'gateway-1', // MCP signal
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      // Must trust explicit metadata over detection
      expect(result.toolProvider).toBe('n8n-workflow')
      expect(result.toolSource).toBe('workflow')
    })

    it('should preserve isSubagent flag from explicit metadata', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'custom_tool',
        toolProvider: 'subagent',
        toolSource: 'workflow',
        isSubagent: true,
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('subagent')
      expect(result.toolSource).toBe('workflow')
      expect(result.isSubagent).toBe(true)
    })
  })

  describe('PRIORITY 2: Subagent Detection', () => {
    it('should detect subagent by call_subagent tool name', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'call_subagent',
        toolArgs: {
          Prompt__User_Message_: 'Research AI trends',
          subagentName: 'researcher'
        },
        toolResult: { response: 'Research results...' }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('subagent')
      expect(result.isSubagent).toBe(true)
    })

    it('should detect subagent by isSubagent flag', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'research_agent', // Custom name, not call_subagent
        isSubagent: true,
        subagentName: 'researcher',
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('subagent')
      expect(result.isSubagent).toBe(true)
    })

    it('should detect subagent by Prompt__User_Message_ in toolArgs (Mode 2 pattern)', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'custom_subagent',
        toolArgs: {
          Prompt__User_Message_: 'Analyze data',
          agentName: 'Primary Agent'
        },
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('subagent')
      expect(result.isSubagent).toBe(true)
    })

    it('should preserve toolSource from step when detecting subagent', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'call_subagent',
        toolSource: 'workflow', // Subagent via workflow
        isSubagent: true,
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('subagent')
      expect(result.toolSource).toBe('workflow') // Preserved from step
      expect(result.isSubagent).toBe(true)
    })
  })

  describe('PRIORITY 3: batshit-server Tool Detection', () => {
    it('should detect batshit-server tool by name pattern (batshit_server_read_file)', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_read_file',
        toolArgs: { path: '/test.txt' },
        toolResult: { content: 'test content' }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('batshit-server')
      expect(result.toolSource).toBe('direct-attachment')
      expect(result.isSubagent).toBe(false)
    })

    it('should detect batshit-server tool via MCP gateway (CRITICAL TEST CASE)', () => {
      // This is the HIGH-PRIORITY test from TECH-001 risk assessment
      // batshit-server tool delivered via MCP gateway MUST return 'batshit-server', not 'mcp'
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_read_file', // batshit-server tool name
        toolProvider: 'batshit-server', // Explicit provider
        toolSource: 'mcp-gateway', // Via gateway
        gatewayId: 'gateway-1', // Gateway metadata present
        gatewayName: 'batshit-server MCP',
        toolArgs: { path: '/test.txt' },
        toolResult: { content: 'test' }
      }

      const result = detectToolSource(step)

      // CRITICAL: Must return 'batshit-server', NOT 'mcp'
      expect(result.toolProvider).toBe('batshit-server')
      expect(result.toolSource).toBe('mcp-gateway')
      expect(result.isSubagent).toBe(false)
    })

    it('should detect all batshit-server tool names', () => {
      const batshitServerTools = [
        'batshit_server_read_file',
        'batshit_server_overwrite_file',
        'batshit_server_edit_file',
        'batshit_server_list_files',
        'batshit_server_search_files',
        'batshit_server_execute_command'
      ]

      batshitServerTools.forEach(toolName => {
        const step: IntermediateStep = {
          type: 'tool',
          toolName,
          toolArgs: {},
          toolResult: {}
        }

        const result = detectToolSource(step)

        expect(result.toolProvider).toBe('batshit-server')
        expect(result.toolSource).toBe('direct-attachment')
      })
    })

    it('should use toolSource from step if present', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_execute_command',
        toolSource: 'mcp-gateway', // Explicit source
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('batshit-server')
      expect(result.toolSource).toBe('mcp-gateway') // Preserved
    })

    it('should detect base batshit-server tool names without prefix when no workflow/gateway markers', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'read_file',
        toolArgs: { path: '/test.txt' },
        toolResult: { content: 'test' }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('batshit-server')
      expect(result.toolSource).toBe('direct-attachment')
    })

    it('should not treat base tool names as batshit-server when workflow markers exist', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'read_file',
        toolArgs: { webhookUrl: 'http://localhost:5678/webhook/foo' },
        toolResult: { content: 'workflow' }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('n8n-workflow')
      expect(result.toolSource).toBe('workflow')
    })

    it('should not treat base tool names as batshit-server when gateway markers exist', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'read_file',
        gatewayId: 'gateway-1',
        gatewayName: 'Docker MCP Gateway',
        toolArgs: { path: '/test.txt' },
        toolResult: { content: 'mcp' }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('mcp')
      expect(result.toolSource).toBe('mcp-gateway')
    })
  })

  describe('PRIORITY 4: MCP Tool Detection', () => {
    it('should detect Docker MCP tools by gatewayId', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'github-search-issues',
        gatewayId: 'docker-gateway-1',
        gatewayName: 'GitHub MCP',
        gatewayType: 'docker',
        mcpServerName: 'github',
        toolArgs: { query: 'bug' },
        toolResult: { issues: [] }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('mcp')
      expect(result.toolSource).toBe('mcp-gateway')
      expect(result.isSubagent).toBe(false)
    })

    it('should detect n8n MCP Trigger tools by gatewayName', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'custom_mcp_tool',
        gatewayName: 'Custom MCP Gateway',
        gatewayType: 'n8n-mcp-trigger',
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('mcp')
      expect(result.toolSource).toBe('mcp-gateway')
    })

    it('should detect MCP tool with only gatewayId present', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'some_tool',
        gatewayId: 'gateway-123',
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('mcp')
      expect(result.toolSource).toBe('mcp-gateway')
    })
  })

  describe('PRIORITY 5: Workflow Tool Detection', () => {
    it('should detect workflow tool by webhookUrl', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'analyze_data',
        toolArgs: {
          webhookUrl: 'http://localhost:5678/webhook/analyze',
          data: { values: [1, 2, 3] }
        },
        toolResult: { summary: 'Analysis complete' }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('n8n-workflow')
      expect(result.toolSource).toBe('workflow')
      expect(result.isSubagent).toBe(false)
    })

    it('should detect workflow tool by workflowId in toolArgs', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'process_invoice',
        toolArgs: {
          workflowId: 'wf-123',
          invoiceUrl: 'https://example.com/invoice.pdf'
        },
        toolResult: { processed: true }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('n8n-workflow')
      expect(result.toolSource).toBe('workflow')
    })
  })

  describe('PRIORITY 6: Fallback (Unknown)', () => {
    it('should fallback to unknown for unrecognized tools', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'mystery_tool',
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('unknown')
      expect(result.toolSource).toBe('unknown')
      expect(result.isSubagent).toBe(false)
    })

    it('should fallback to unknown for tool with unrecognized patterns', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'future_tool',
        toolArgs: { someNewField: 'value' },
        toolResult: { data: 'result' }
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('unknown')
      expect(result.toolSource).toBe('unknown')
    })
  })

  describe('Edge Cases: Missing/Incomplete Metadata', () => {
    it('should handle IntermediateStep with minimal fields', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'minimal_tool'
        // No toolArgs, no toolResult, no metadata
      }

      const result = detectToolSource(step)

      // Should not crash, should fallback gracefully
      expect(result).toBeDefined()
      expect(result.toolProvider).toBe('unknown')
      expect(result.toolSource).toBe('unknown')
      expect(result.isSubagent).toBe(false)
    })

    it('should handle undefined toolArgs gracefully', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'test_tool',
        toolArgs: undefined,
        toolResult: {}
      }

      const result = detectToolSource(step)

      // Should not crash on optional chaining
      expect(result).toBeDefined()
    })

    it('should handle null fields gracefully', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'null_fields_tool',
        toolArgs: null as any,
        toolResult: null as any,
        gatewayId: undefined,
        isSubagent: undefined
      }

      const result = detectToolSource(step)

      expect(result).toBeDefined()
      expect(result.isSubagent).toBe(false)
    })

    it('should handle missing optional fields', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'incomplete_tool'
        // All optional fields missing
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('unknown')
      expect(result.toolSource).toBe('unknown')
      expect(result.isSubagent).toBe(false)
    })
  })

  describe('Edge Cases: Priority Order Conflicts', () => {
    it('should prioritize subagent over batshit-server when tool name matches both', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_read_file', // batshit-server tool name
        isSubagent: true, // But it's a subagent
        subagentName: 'file_reader_agent',
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      // Subagent has higher priority (level 2) than batshit-server (level 3)
      expect(result.toolProvider).toBe('subagent')
      expect(result.isSubagent).toBe(true)
    })

    it('should prioritize batshit-server over MCP gateway when both signals present', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_execute_command', // batshit-server tool
        gatewayId: 'gateway-1', // MCP signal
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      // batshit-server has higher priority (level 3) than MCP (level 4)
      expect(result.toolProvider).toBe('batshit-server')
      expect(result.toolSource).toBe('direct-attachment')
    })

    it('should prioritize MCP over workflow metadata when both signals present', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'workflow_tool',
        gatewayId: 'gateway-1', // MCP signal (priority 4)
        toolArgs: {
          webhookUrl: 'http://localhost/webhook' // Workflow signal (priority 5)
        },
        toolResult: {}
      }

      const result = detectToolSource(step)

      // MCP has higher priority (level 4) than workflow (level 5)
      expect(result.toolProvider).toBe('mcp')
      expect(result.toolSource).toBe('mcp-gateway')
    })
  })

  describe('Edge Cases: Tool Name Variations', () => {
    it('should normalize casing differences for batshit-server tool names', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'BATSHIT_SERVER_READ_FILE', // Uppercase prefix and name
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      expect(result.toolProvider).toBe('batshit-server')
    })

    it('should not partially match batshit-server tool names', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_read_file_advanced', // Contains base name but extra suffix
        toolArgs: {},
        toolResult: {}
      }

      const result = detectToolSource(step)

      // Should not match - requires known tool suffix
      expect(result.toolProvider).toBe('unknown')
    })
  })

  describe('Performance', () => {
    it('should execute detection in <1ms', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_read_file',
        gatewayId: 'gateway-1',
        toolArgs: { path: '/test.txt' },
        toolResult: { content: 'test' }
      }

      const iterations = 1000
      const start = performance.now()

      for (let i = 0; i < iterations; i++) {
        detectToolSource(step)
      }

      const end = performance.now()
      const avgTime = (end - start) / iterations

      // Should be well under 1ms per detection
      expect(avgTime).toBeLessThan(1)
    })
  })

  describe('Type Safety', () => {
    it('should return proper TypeScript types', () => {
      const step: IntermediateStep = {
        type: 'tool',
        toolName: 'batshit_server_read_file',
        toolArgs: {},
        toolResult: {}
      }

      const result: ToolSourceDetectionResult = detectToolSource(step)

      // TypeScript should enforce these types at compile time
      expect(typeof result.toolProvider).toBe('string')
      expect(typeof result.toolSource).toBe('string')
      expect(typeof result.isSubagent).toBe('boolean')
    })
  })
})

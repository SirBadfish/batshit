/**
 * Unit Tests for Cool Tools Zip Adapter
 * Story 4.4: Cool Tools Integration with Stream-to-Zip Architecture
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { adaptCoolToolsToZipSystem, hasSubagentToolSettings, getDefaultSubagentSettings } from '../coolToolZipAdapter'
import { createZipFromContent } from '../zipService'
import type { AgentRow } from '$lib/types/database'

// Mock the zipService
vi.mock('../zipService', () => ({
  createZipFromContent: vi.fn().mockImplementation((content, type, sessionId, messageId, metadata, options) => {
    // Generate a consistent mock zipId based on inputs
    const mockZipId = options?.zipId || `${type}_${Date.now()}_mock`
    const lineCount =
      typeof metadata?.contentLineCount === 'number'
        ? metadata.contentLineCount
        : content.split('\n').length
    const label = metadata?.zipDescriptionLabel || metadata?.toolName || type
    const target = metadata?.zipDescriptionTarget ? `: ${metadata.zipDescriptionTarget}` : ''
    const details = [
      metadata?.zipDescriptionStatus,
      metadata?.zipDescriptionSize || `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`
    ].filter(Boolean)
    const description = `${label}${target}${details.length ? ` - ${details.join(' - ')}` : ''}`
    return Promise.resolve({
      zipId: mockZipId,
      reference: `{{batshit-zip:${mockZipId}:::${description}}}`
    })
  })
}))

// Test data fixtures
const testToolResults = {
  simple: {
    tool: 'calculator',
    input: '2+2',
    output: '4'
  },

  complex: {
    tool: 'web_search',
    input: { query: 'test', limit: 10 },
    output: {
      results: [
        { title: 'Result 1', url: 'http://example.com', snippet: '...' }
      ],
      metadata: { total: 100, time: 0.5 }
    }
  },

  large: {
    tool: 'file_reader',
    input: 'large.txt',
    output: 'x'.repeat(10000) // 10KB of text
  },

  error: {
    tool: 'api_call',
    input: { url: 'invalid' },
    output: null,
    error: 'Connection failed'
  },

  circularRef: (() => {
    const obj: any = { tool: 'test', output: {} }
    obj.output.self = obj.output // Circular reference
    return obj
  })()
}

describe('CoolToolZipAdapter', () => {
  const sessionId = 'test-session-123'
  const messageId = 'msg-456'
  const defaultSettings: Partial<AgentRow> = {
    buffer_size: 3,
    zip_threshold: 500
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('adaptCoolToolsToZipSystem', () => {
    // 4.4-UNIT-001: Transform simple tool result to zip reference
    it('should transform simple tool result to zip reference', async () => {
      const intermediateSteps = [testToolResults.simple]
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0, // Force zipping
        zip_threshold_all_other_tools: 0
      }

      const result = await adaptCoolToolsToZipSystem(
        intermediateSteps,
        sessionId,
        messageId,
        settings
      )

      expect(result).toHaveLength(1)
      expect(result[0].reference).toContain('{{batshit-zip:')
      expect(result[0].reference).toContain('cool_tool')
      expect(result[0].zipId).toContain('cool_tool')
      expect(result[0].reference).toContain(result[0].zipId)
      expect(result[0].placeholder).toBe('{{ZIP_COOL_TOOL_0}}')
    })

    // SA-104 P3 (DL-104-17): memory broker calls are exempt from zip-first treatment —
    // summary-first references only; remembered content rides the DCM insert channel.
    it('skips zip creation for broker steps targeting sys.memory.* and still zips the rest', async () => {
      const memoryStep = {
        toolName: 'native_batshit_tool_use',
        toolInput: { ref: 'fabric:sys.memory.search', input: { query: 'dog' } },
        toolResult: { results: [{ id: 'mem_1', gist: 'Maggie is the dog' }] },
        toolCallId: 'call-memory-1',
        timestamp: Date.now()
      }
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      const memoryOnly = await adaptCoolToolsToZipSystem([memoryStep], sessionId, messageId, settings)
      expect(memoryOnly).toHaveLength(0)
      expect(vi.mocked(createZipFromContent)).not.toHaveBeenCalled()

      const mixed = await adaptCoolToolsToZipSystem(
        [memoryStep, testToolResults.simple],
        sessionId,
        messageId,
        settings
      )
      expect(mixed).toHaveLength(1)
      expect(mixed[0].zipId).toContain('cool_tool')
    })

    it('passes a reserved zipId to the main cool_tool zip writer by toolCallId', async () => {
      const step = {
        toolName: 'read_file',
        toolInput: { path: '/tmp/memory.md' },
        toolResult: { content: 'durable memory contents' },
        toolCallId: 'call_read_memory'
      }
      const reservedZipId = 'cool_tool_1781000000000_abcde'

      const result = await adaptCoolToolsToZipSystem(
        [step],
        sessionId,
        messageId,
        defaultSettings,
        undefined,
        {
          reservedZipIdsByToolCallId: new Map([[step.toolCallId, reservedZipId]])
        }
      )

      expect(result[0].zipId).toBe(reservedZipId)
      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      expect(mainCall?.[5]).toEqual({ zipId: reservedZipId })
    })

    it('adds compact target metadata for read_file zip descriptions', async () => {
      const step = {
        toolName: 'batshit_server_read_file',
        toolInput: { path: '/Users/example/batshit/docs/user-docs/index.md' },
        toolResult: {
          filePath: '/Users/example/batshit/docs/user-docs/index.md',
          content: 'one\ntwo\nthree',
          lineCount: 3
        },
        toolCallId: 'call_read_memory'
      }

      const result = await adaptCoolToolsToZipSystem(
        [step],
        sessionId,
        messageId,
        defaultSettings
      )

      expect(result[0].reference).toContain(
        'read_file: /Users/example/batshit/docs/user-docs/index.md - 3 lines'
      )

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      expect(mainCall?.[4]).toMatchObject({
        zipDescriptionLabel: 'read_file',
        zipDescriptionTarget: '/Users/example/batshit/docs/user-docs/index.md',
        zipDescriptionSize: '3 lines'
      })
    })

    it('adds compact status metadata for bash zip descriptions', async () => {
      const step = {
        toolName: 'execute_command',
        toolInput: { command: 'npm run check' },
        toolResult: {
          command: 'npm run check',
          stdout: 'ok\nall good',
          stderr: '',
          exitCode: 0
        },
        toolCallId: 'call_check'
      }

      const result = await adaptCoolToolsToZipSystem(
        [step],
        sessionId,
        messageId,
        defaultSettings
      )

      expect(result[0].reference).toContain('bash: npm run check - exit 0 - 2 lines')

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      expect(mainCall?.[4]).toMatchObject({
        zipDescriptionLabel: 'bash',
        zipDescriptionTarget: 'npm run check',
        zipDescriptionStatus: 'exit 0',
        zipDescriptionSize: '2 lines'
      })
    })

    it('coerces numeric-keyed toolResult objects into arrays', async () => {
      const step = {
        toolName: 'call_subagent',
        toolResult: { '0': { output: 'first' }, '1': { output: 'second' } }
      }

      const results = await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const contentArg = vi.mocked(createZipFromContent).mock.calls[0][0]
      const parsed = JSON.parse(contentArg)
      expect(Array.isArray(parsed.toolResult)).toBe(true)
      expect(parsed.toolResult[0]?.output).toBe('first')
      expect(parsed.toolResult[1]?.output).toBe('second')
    })

    it('preserves execute_command inputs for renderer payloads', async () => {
      const step = {
        toolName: 'batshit_server_execute_command',
        toolInput: {
          command: 'rm temp-testing/test.md',
          projectPath: '/Users/example/batshit'
        },
        toolResult: {
          stdout: '',
          stderr: '',
          exitCode: 0
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_execute_command: 0,
        zip_threshold_execute_command: 0
      })

      const contentArg = vi.mocked(createZipFromContent).mock.calls[0][0]
      const parsed = JSON.parse(contentArg)

      expect(parsed.toolArgs?.command).toBe('rm temp-testing/test.md')
      expect(parsed.toolResult?.command).toBe('rm temp-testing/test.md')
    })

    it('preserves edit_file diffs when apply_patch only exists in nested native wrapper data', async () => {
      const patch =
        "apply_patch<<'PATCH'\n" +
        '*** Begin Patch\n' +
        '*** Update File: /Users/example/hello/sa049-mode2-write.txt\n' +
        '@@\n' +
        ' alpha\n' +
        '-beta\n' +
        '+BRAVO\n' +
        ' gamma\n' +
        '*** End Patch\n' +
        'PATCH'

      await adaptCoolToolsToZipSystem(
        [
          {
            toolName: 'batshit_server_edit_file',
            toolArgs: {
              command: patch,
              filePath: 'sa049-mode2-write.txt',
              path: 'sa049-mode2-write.txt'
            },
            toolResult: {
              data: {
                success: true,
                command: patch,
                mappedToolInput: {
                  command: patch,
                  innerCommand: patch,
                  filePath: 'sa049-mode2-write.txt',
                  path: 'sa049-mode2-write.txt'
                }
              }
            }
          }
        ],
        sessionId,
        messageId,
        {
          buffer_size_edit_file: 0,
          zip_threshold_edit_file: 0
        }
      )

      const contentArg = vi.mocked(createZipFromContent).mock.calls[0][0]
      const parsed = JSON.parse(contentArg)

      expect(parsed.operationKind).toBe('edit_file')
      expect(parsed.rendererFamily).toBe('edit_file')
      expect(parsed.toolResult?.filePath).toBe('sa049-mode2-write.txt')
      expect(parsed.toolResult?.diff).toContain('*** Begin Patch')
      expect(parsed.toolResult?.diff).toContain('+BRAVO')
    })

    it('preserves write_file content when the native wrapper only exposes a printf command', async () => {
      const command =
        'mkdir -p /Users/example/hello && printf "alpha\\nbeta\\ngamma\\n" > /Users/example/hello/sa049-mode1-write.txt'

      await adaptCoolToolsToZipSystem(
        [
          {
            toolName: 'Batshit_Native_Tools',
            toolArgs: {
              action: 'bash_execute'
            },
            toolResult: [
              {
                success: true,
                action: 'bash_execute',
                data: {
                  success: true,
                  command,
                  mappedToolName: 'batshit_server_overwrite_file',
                  mappedToolInput: {
                    command,
                    innerCommand: command,
                    filePath: '/Users/example/hello/sa049-mode1-write.txt',
                    path: '/Users/example/hello/sa049-mode1-write.txt'
                  }
                }
              }
            ]
          }
        ],
        sessionId,
        messageId,
        {
          buffer_size_write_file: 0,
          zip_threshold_write_file: 0
        }
      )

      const contentArg = vi.mocked(createZipFromContent).mock.calls[0][0]
      const parsed = JSON.parse(contentArg)

      expect(parsed.operationKind).toBe('write_file')
      expect(parsed.rendererFamily).toBe('write_file')
      expect(parsed.toolResult?.filePath).toBe('/Users/example/hello/sa049-mode1-write.txt')
    expect(parsed.toolResult?.content).toBe('alpha\nbeta\ngamma')
    expect(parsed.toolResult?.lineCount).toBe(3)
    expect(parsed.toolResult?.size).toBe(17)
  })

    it('describes cool-tool zips with the tool result line count instead of the JSON wrapper line count', async () => {
      const results = await adaptCoolToolsToZipSystem(
        [
          {
            toolName: 'batshit_server_read_file',
            toolResult: {
              filePath: '/Users/example/batshit/AGENTS.md',
              content: Array.from({ length: 221 }, (_, index) => `line ${index + 1}`).join('\n'),
              lineCount: 221
            }
          }
        ],
        sessionId,
        messageId,
        {
          buffer_size_read_file: 0,
          zip_threshold_read_file: 0
        }
      )

      const metadataArg = vi.mocked(createZipFromContent).mock.calls[0][4]
      expect(metadataArg.contentLineCount).toBe(221)
      expect(metadataArg.resultLineCount).toBe(221)
      expect(results[0].reference).toContain('221 lines')
      expect(results[0].reference).not.toContain(' - 1 line')
    })

    it('preserves tool errors in compact payloads so error renderers survive hydration', async () => {
      await adaptCoolToolsToZipSystem(
        [
          {
            toolName: 'claude_web_search',
            toolArgs: {
              query: 'Svelte runes official documentation'
            },
            toolResult: {
              query: 'Svelte runes official documentation',
              totalMatches: 0,
              results: []
            },
            error:
              'InputValidationError: WebSearch failed because allowed_domains must be an array.',
            success: false
          }
        ],
        sessionId,
        messageId,
        {
          buffer_size_all_other_tools: 0,
          zip_threshold_all_other_tools: 0
        }
      )

      const contentArg = vi.mocked(createZipFromContent).mock.calls[0][0]
      const parsed = JSON.parse(contentArg)

      expect(parsed.rendererFamily).toBe('web_search')
      expect(parsed.error).toContain('allowed_domains')
    })

    // 4.4-UNIT-002: Handle empty intermediateSteps array
    it('should handle empty intermediateSteps array', async () => {
      const result = await adaptCoolToolsToZipSystem([], sessionId, messageId, defaultSettings)
      expect(result).toEqual([])
    })

    // 4.4-UNIT-003: Handle null intermediateSteps
    it('should handle null intermediateSteps', async () => {
      const result = await adaptCoolToolsToZipSystem(null, sessionId, messageId, defaultSettings)
      expect(result).toEqual([])
    })

    // 4.4-UNIT-004: Handle undefined intermediateSteps
    it('should handle undefined intermediateSteps', async () => {
      const result = await adaptCoolToolsToZipSystem(undefined, sessionId, messageId, defaultSettings)
      expect(result).toEqual([])
    })

    // 4.4-UNIT-005: Record token metadata for threshold evaluation
    it('should record token metadata for threshold evaluation', async () => {
      const largeResult = { tool: 'search', output: 'x'.repeat(2000) } // ~500 tokens
      const smallResult = { tool: 'calc', output: '42' } // ~3 tokens
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 10, // Large buffer to test threshold
        zip_threshold_all_other_tools: 100 // Low threshold
      }

      const results = await adaptCoolToolsToZipSystem(
        [largeResult, smallResult],
        sessionId,
        messageId,
        settings
      )

      expect(results).toHaveLength(2)

      const calls = vi.mocked(createZipFromContent).mock.calls
      expect(calls).toHaveLength(2)

      const largeTokens = calls[0][4]?.tokens
      const smallTokens = calls[1][4]?.tokens
      expect(typeof largeTokens).toBe('number')
      expect(typeof smallTokens).toBe('number')
      expect(largeTokens).toBeGreaterThan(smallTokens!)
    })

    it('records prompt-facing tokens separately from stored renderer payload size', async () => {
      await adaptCoolToolsToZipSystem(
        [
          {
            toolName: 'batshit_server_read_file',
            toolArgs: {
              filePath: '/Users/example/batshit/package.json',
              path: '/Users/example/batshit/package.json'
            },
            toolResult: {
              filePath: '/Users/example/batshit/package.json',
              path: '/Users/example/batshit/package.json',
              content: JSON.stringify({ name: 'batshit-v2', private: true }, null, 2),
              lineCount: 4,
              language: 'json'
            }
          }
        ],
        sessionId,
        messageId,
        {
          buffer_size_read_file: 0,
          zip_threshold_read_file: 0
        }
      )

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const contentArg = String((mainCall as any)[0])
      const metadata = (mainCall as any)[4]

      expect(metadata.tokenBasis).toBe('ai_expanded')
      expect(metadata.tokens).toBe(metadata.promptTokens)
      expect(metadata.aiTokens).toBe(metadata.promptTokens)
      expect(metadata.storageTokens).toBe(Math.ceil(contentArg.length / 4))
      expect(metadata.storageTokens).toBeGreaterThan(metadata.promptTokens)
    })

    // 4.4-UNIT-006: Maintain tool ordering metadata
    it('should maintain tool index ordering in metadata', async () => {
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 2,
        zip_threshold_all_other_tools: 200 // High threshold so items in buffer won't zip
      }
      const tools = Array(5).fill(0).map((_, i) => ({
        tool: `tool${i}`,
        output: 'x'.repeat(100) // ~25 tokens - under threshold for items in buffer
      }))

      const results = await adaptCoolToolsToZipSystem(tools, sessionId, messageId, settings)

      expect(results).toHaveLength(5)
      const indices = vi.mocked(createZipFromContent).mock.calls.map((call) => call[4]?.toolIndex)
      expect(indices).toEqual([0, 1, 2, 3, 4])
    })

    // 4.4-UNIT-007: Generate unique zip IDs
    it('should generate unique placeholders for each tool', async () => {
      const tools = Array(3).fill({ tool: 'test', output: 'x'.repeat(1000) })
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      const results = await adaptCoolToolsToZipSystem(tools, sessionId, messageId, settings)
      const placeholders = results.map(r => r.placeholder)

      // All placeholders should be unique
      expect(new Set(placeholders).size).toBe(placeholders.length)
      expect(placeholders).toEqual([
        '{{ZIP_COOL_TOOL_0}}',
        '{{ZIP_COOL_TOOL_1}}',
        '{{ZIP_COOL_TOOL_2}}'
      ])
    })

    // 4.4-UNIT-008: Preserve tool metadata
    it('should preserve tool metadata in zip', async () => {
      const tool = {
        tool: 'api_call',
        input: { url: 'test.com' },
        output: { status: 200 },
        metadata: { timing: 150 }
      }
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      const results = await adaptCoolToolsToZipSystem([tool], sessionId, messageId, settings)
      expect(results).toHaveLength(1)
      expect(results[0].reference).toContain('cool_tool')
    })

    it('should normalize Mode 3 intermediate steps with toolName fields', async () => {
      const mode3Step = {
        toolName: 'read_file',
        toolInput: { path: '/docs/example.md' },
        toolResult: { content: 'Hello World' },
        success: true,
        metadata: {
          toolProvider: 'mcp',
          gatewayId: 'docker'
        }
      }
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      const results = await adaptCoolToolsToZipSystem([mode3Step], sessionId, messageId, settings)
      expect(results).toHaveLength(1)
      expect(results[0].placeholder).toBe('{{ZIP_COOL_TOOL_0}}')
    })

    it('applies MCP tool-specific zip settings when dynamic_mcp_use wraps execution', async () => {
      const wrappedDynamicStep = {
        toolName: 'batshit_server_dynamic_mcp_use',
        toolArgs: {
          params: {
            toolName: 'n8n_list_workflows',
            includeArchived: false
          }
        },
        toolResult: {
          toolName: 'n8n_list_workflows',
          result: {
            workflows: [{ id: 'wf_1', name: 'Example Workflow' }]
          },
          executionTimeMs: 57
        }
      }

      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 5,
        zip_threshold_all_other_tools: 400,
        custom_tool_settings: [
          {
            tool_name: 'n8n_list_workflows',
            buffer_size: 11,
            zip_threshold: 222,
            auto_zip: true
          }
        ]
      }

      await adaptCoolToolsToZipSystem([wrappedDynamicStep], sessionId, messageId, settings)

      const zipCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(zipCall).toBeTruthy()
      const metadata = (zipCall as any)[4]
      expect(metadata.toolName).toBe('n8n_list_workflows')
      expect(metadata.bufferSize).toBe(11)
      expect(metadata.threshold).toBe(222)

      const contentArg = (zipCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('n8n_list_workflows')
      expect(parsed.originalToolName).toBe('batshit_server_dynamic_mcp_use')
    })

    it('applies web_search zip settings when live n8n Batshit_Tools wraps web search', async () => {
      const wrappedWebSearchStep = {
        toolName: 'Batshit_Tools',
        toolArgs: {
          action: 'web_search'
        },
        toolResult: [
          {
            auth: 'service',
            success: true,
            action: 'web_search',
            backend: 'local',
            context: {
              mode: 'mode2',
              actor_type: 'primary',
              agent_id: 'sample_n8n_primary'
            },
            data: {
              success: true,
              query: 'Docker n8n web search',
              provider: 'exa',
              results: [
                {
                  title: 'Docker',
                  url: 'https://docs.docker.com/',
                  snippet: 'Docker documentation.'
                }
              ]
            }
          }
        ]
      }

      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 5,
        zip_threshold_all_other_tools: 400,
        custom_tool_settings: [
          {
            tool_name: 'web_search',
            buffer_size: 2,
            zip_threshold: 111,
            auto_zip: true
          }
        ]
      }

      await adaptCoolToolsToZipSystem([wrappedWebSearchStep], sessionId, messageId, settings)

      const zipCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(zipCall).toBeTruthy()
      const metadata = (zipCall as any)[4]
      expect(metadata.toolName).toBe('web_search')
      expect(metadata.displayToolName).toBe('Web Search')
      expect(metadata.operationKind).toBe('web_search')
      expect(metadata.rendererFamily).toBe('web_search')
      expect(metadata.bufferSize).toBe(2)
      expect(metadata.threshold).toBe(111)

      const contentArg = (zipCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('web_search')
      expect(parsed.originalToolName).toBe('Batshit_Tools')
      expect(parsed.operationKind).toBe('web_search')
      expect(parsed.rendererFamily).toBe('web_search')
      expect(parsed.toolArgs.query).toBe('Docker n8n web search')
      expect(parsed.toolResult.provider).toBe('exa')
    })

    it('applies individual MCP tool zip settings when live n8n Batshit_Tools wraps dynamic_mcp_use', async () => {
      const wrappedMcpStep = {
        toolName: 'Batshit_Tools',
        toolArgs: {
          action: 'dynamic_mcp_use',
          input: {
            toolName: 'mcp_huggingface_search_models',
            params: {
              query: 'text to image'
            }
          }
        },
        toolResult: [
          {
            auth: 'service',
            success: true,
            action: 'dynamic_mcp_use',
            backend: 'local',
            data: {
              success: true,
              toolName: 'mcp_huggingface_search_models',
              requestedToolName: 'huggingface search',
              result: {
                models: [{ id: 'demo/model' }]
              },
              executionTimeMs: 37
            }
          }
        ]
      }

      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 5,
        zip_threshold_all_other_tools: 400,
        custom_tool_settings: [
          {
            tool_name: 'mcp_huggingface_search_models',
            buffer_size: 1,
            zip_threshold: 22,
            auto_zip: true
          }
        ]
      }

      await adaptCoolToolsToZipSystem([wrappedMcpStep], sessionId, messageId, settings)

      const zipCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(zipCall).toBeTruthy()
      const metadata = (zipCall as any)[4]
      expect(metadata.toolName).toBe('mcp_huggingface_search_models')
      expect(metadata.displayToolName).toBe('mcp_huggingface_search_models')
      expect(metadata.operationKind).toBe('dynamic_use')
      expect(metadata.bufferSize).toBe(1)
      expect(metadata.threshold).toBe(22)

      const contentArg = (zipCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('mcp_huggingface_search_models')
      expect(parsed.originalToolName).toBe('Batshit_Tools')
      expect(parsed.operationKind).toBe('dynamic_use')
      expect(parsed.toolArgs.toolName).toBe('mcp_huggingface_search_models')
      expect(parsed.toolArgs.params).toEqual({ query: 'text to image' })
    })

    it('applies CLI tool-specific zip settings when cli_tool_use wraps execution', async () => {
      const wrappedCliStep = {
        toolName: 'native_cli_tool_use',
        toolArgs: {
          toolId: 'repo_snapshot',
          input: {
            path: '/Users/example/batshit'
          }
        },
        toolResult: {
          toolId: 'repo_snapshot',
          title: 'Repo Snapshot',
          stdout: 'clean',
          stderr: '',
          exitCode: 0,
          durationMs: 12
        }
      }

      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 5,
        zip_threshold_all_other_tools: 400,
        custom_tool_settings: [
          {
            tool_name: 'repo_snapshot',
            buffer_size: 9,
            zip_threshold: 123,
            auto_zip: false
          }
        ]
      }

      await adaptCoolToolsToZipSystem([wrappedCliStep], sessionId, messageId, settings)

      const zipCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(zipCall).toBeTruthy()
      const metadata = (zipCall as any)[4]
      expect(metadata.toolName).toBe('repo_snapshot')
      expect(metadata.bufferSize).toBe(9)
      expect(metadata.threshold).toBe(123)

      const contentArg = (zipCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('repo_snapshot')
      expect(parsed.originalToolName).toBe('native_cli_tool_use')
    })

    it('normalizes list_files output into a files array for renderers', async () => {
      const step = {
        toolName: 'list_files',
        toolResult: { output: 'foo.txt\nbar/\n' }
      }
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, settings)

      const contentArg = vi.mocked(createZipFromContent).mock.calls[0][0]
      const parsed = JSON.parse(contentArg)

      expect(Array.isArray(parsed.toolResult?.files)).toBe(true)
      expect(parsed.toolResult.files).toHaveLength(2)
      expect(parsed.toolResult.files[0].name).toBe('foo.txt')
      expect(parsed.toolResult.files[1].name).toBe('bar/')
    })

    it('coerces non-string content safely for Codex outputs', async () => {
      const codexStep = {
        toolName: 'batshit_server_read_file',
        toolArgs: { path: '/docs/example.md' },
        toolResult: { content: [{ type: 'text', text: 'Hello from Codex' }], filePath: '/docs/example.md' }
      }

      await adaptCoolToolsToZipSystem([codexStep], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const contentArg = vi.mocked(createZipFromContent).mock.calls[0][0]
      const parsed = JSON.parse(contentArg)
      expect(typeof parsed.toolResult.content).toBe('string')
      expect(parsed.toolResult.content).toContain('Hello from Codex')
    })

    it('stores skill_read as a compact main payload with a raw sidecar zip', async () => {
      const step = {
        toolName: 'native_skill',
        toolArgs: {
          action: 'read',
          skillId: 'agent-browser',
          path: 'references/setup.md'
        },
        toolResult: {
          action: 'read',
          skillId: 'agent-browser',
          skillName: 'Agent Browser',
          path: 'references/setup.md',
          content: 'hello\n'.repeat(2000)
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const rawCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'tool_raw')
      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')

      expect(rawCall).toBeTruthy()
      expect(mainCall).toBeTruthy()

      const parsed = JSON.parse((mainCall as any)[0])
      expect(parsed.operationKind).toBe('skill_read')
      expect(parsed.rendererFamily).toBe('skill_read')
      expect(parsed.rawSidecar.status).toBe('stored')
      expect(parsed.rawSidecar.zipId).toContain('tool_raw_')
      expect((mainCall as any)[4].operationKind).toBe('skill_read')
    })

    it('stores Mode 4 helper skill invoke payloads in the skill_read family', async () => {
      const step = {
        toolName: 'mcp.batshit_gateway_cody-mode4-controls.native_skill',
        toolArgs: {
          arguments: {
            skillId: 'agent_browser',
            action: 'invoke',
            maxChars: 12000
          }
        },
        toolResult: {
          content: [
            {
              type: 'text',
              text: {
                auth: 'service',
                userId: 'josh',
                success: true,
                action: 'invoke',
                skill: {
                  summary: 'Object',
                  truncated: true
                },
                skillMarkdown: '# agent-browser\n\nUse the browser.'
              }
            }
          ],
          structured_content: null,
          input: {
            arguments: {
              skillId: 'agent_browser',
              action: 'invoke',
              maxChars: 12000
            }
          },
          action: 'invoke'
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const parsed = JSON.parse((mainCall as any)[0])

      expect(parsed.operationKind).toBe('skill_read')
      expect(parsed.rendererFamily).toBe('skill_read')
      expect(parsed.toolArgs.action).toBe('invoke')
      expect(parsed.toolArgs.skillId).toBe('agent_browser')
      expect(parsed.toolArgs.path).toBe('SKILL.md')
      expect(parsed.toolResult.action).toBe('invoke')
      expect(parsed.toolResult.content).toContain('agent-browser')
    })

    it('stores managed CLI broker search results with real matches', async () => {
      const step = {
        toolName: 'mcp.batshit_gateway_cody-mode4-controls.batshit_tool_search',
        toolArgs: {
          arguments: {
            family: 'fabric',
            query: 'skill save',
            limit: 5
          }
        },
        toolResult: {
          content: [
            {
              type: 'text',
              text: {
                results: [
                  {
                    ref: 'fabric:sys.skill.save',
                    family: 'fabric',
                    title: 'Save Skill',
                    description: 'Create or update a custom skill.',
                    riskLevel: 'safe'
                  }
                ],
                totalMatches: 1,
                query: 'skill save',
                families: ['fabric'],
                operationKind: 'tool_find',
                rendererFamily: 'tool_find'
              }
            }
          ],
          structured_content: null,
          input: {
            arguments: {
              family: 'fabric',
              query: 'skill save',
              limit: 5
            }
          }
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const parsed = JSON.parse((mainCall as any)[0])

      expect(parsed.operationKind).toBe('tool_find')
      expect(parsed.rendererFamily).toBe('tool_find')
      expect(parsed.toolArgs).toMatchObject({
        family: 'fabric',
        query: 'skill save',
        limit: 5
      })
      expect(parsed.toolResult.totalMatches).toBe(1)
      expect(parsed.toolResult.results[0].ref).toBe('fabric:sys.skill.save')
    })

    it('stores managed CLI broker use as the executed Fabric control', async () => {
      const step = {
        toolName: 'mcp.batshit_gateway_cody-mode4-controls.batshit_tool_use',
        toolArgs: {
          arguments: {
            ref: 'fabric:sys.cli_tool.list',
            input: {
              includeArchived: false
            }
          }
        },
        toolResult: {
          content: [
            {
              type: 'text',
              text: {
                auth: 'service',
                userId: 'josh',
                success: true,
                controlId: 'sys.cli_tool.list',
                result: {
                  summary: 'Object',
                  truncated: true
                },
                ref: 'fabric:sys.cli_tool.list',
                family: 'fabric',
                target: 'sys.cli_tool.list',
                operationKind: 'fabric_use',
                rendererFamily: 'generic_tool'
              }
            }
          ],
          structured_content: null,
          input: {
            arguments: {
              ref: 'fabric:sys.cli_tool.list',
              input: {
                includeArchived: false
              }
            }
          }
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const metadata = (mainCall as any)[4]
      const parsed = JSON.parse((mainCall as any)[0])

      expect(metadata.toolName).toBe('sys.cli_tool.list')
      expect(metadata.operationKind).toBe('fabric_use')
      expect(parsed.toolName).toBe('sys.cli_tool.list')
      expect(parsed.originalToolName).toBe('mcp.batshit_gateway_cody-mode4-controls.batshit_tool_use')
      expect(parsed.operationKind).toBe('fabric_use')
      expect(parsed.toolArgs).toMatchObject({
        ref: 'fabric:sys.cli_tool.list',
        target: 'sys.cli_tool.list',
        input: {
          includeArchived: false
        }
      })
    })

    it('stores brokered artifact create controls as artifact write renderer payloads', async () => {
      const content = '<!doctype html>\n<html><body><h1>Nano Banana 2</h1></body></html>'
      const step = {
        toolName: 'native_batshit_tool_use',
        toolArgs: {
          ref: 'fabric:sys.artifact.create',
          input: {
            name: 'Nano Banana 2',
            content
          }
        },
        toolResult: {
          success: true,
          ref: 'fabric:sys.artifact.create',
          family: 'fabric',
          target: 'sys.artifact.create',
          artifact: {
            id: 'artifact_1',
            name: 'Nano Banana 2',
            contentChars: content.length
          }
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const metadata = (mainCall as any)[4]
      const parsed = JSON.parse((mainCall as any)[0])

      expect(metadata.toolName).toBe('sys.artifact.create')
      expect(metadata.displayToolName).toBe('Artifact Create')
      expect(metadata.rendererFamily).toBe('write_file')
      expect(parsed.toolName).toBe('sys.artifact.create')
      expect(parsed.displayToolName).toBe('Artifact Create')
      expect(parsed.operationKind).toBe('fabric_use')
      expect(parsed.rendererFamily).toBe('write_file')
      expect(parsed.metadata.rendererTitle).toBe('Artifact Create')
      expect(parsed.metadata.artifactName).toBe('Nano Banana 2')
      expect(parsed.toolResult.filePath).toBe('artifact.html')
      expect(parsed.toolResult.content).toContain('Nano Banana 2')
    })

    it('stores parsed search_files metadata when only text output is available', async () => {
      const step = {
        toolName: 'batshit_server_search_files',
        toolArgs: {
          command: 'rg "zipActivation" batshit-app/src/lib',
          innerCommand: 'rg "zipActivation" batshit-app/src/lib'
        },
        toolResult: {
          output: [
            'batshit-app/src/lib/utils/zipActivation.ts:84:const resolvedToolName = ...',
            'batshit-app/src/lib/services/messageCompiler.ts:17:import { zipActivation } from "./zipActivation"'
          ].join('\n')
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const parsed = JSON.parse((mainCall as any)[0])

      expect(parsed.operationKind).toBe('search_files')
      expect(parsed.rendererFamily).toBe('bash')
      expect(parsed.toolResult.query).toBe('zipActivation')
      expect(parsed.toolResult.totalMatches).toBe(2)
      expect(parsed.toolResult.totalMatchingFiles).toBe(2)
      expect(parsed.toolResult.results[0]).toMatchObject({
        path: 'batshit-app/src/lib/utils/zipActivation.ts',
        matchCount: 1
      })
    })

    it('stores files-only search_files output as one row per matching file', async () => {
      const step = {
        toolName: 'batshit_server_search_files',
        toolArgs: {
          command: 'rg -n -l "zipActivation" /Users/example/batshit',
          innerCommand: 'rg -n -l "zipActivation" /Users/example/batshit'
        },
        toolResult: {
          stdout: [
            '/Users/example/batshit/batshit-app/src/lib/services/messageCompiler.ts',
            '/Users/example/batshit/docs/user-docs/tools/zips.md',
            '/Users/example/batshit/batshit-app/src/lib/utils/zipActivation.test.ts'
          ].join('\n')
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const parsed = JSON.parse((mainCall as any)[0])

      expect(parsed.operationKind).toBe('search_files')
      expect(parsed.rendererFamily).toBe('bash')
      expect(parsed.toolResult.query).toBe('zipActivation')
      expect(parsed.toolResult.totalMatches).toBe(3)
      expect(parsed.toolResult.totalMatchingFiles).toBe(3)
      expect(parsed.toolResult.results).toEqual([
        expect.objectContaining({
          path: '/Users/example/batshit/batshit-app/src/lib/services/messageCompiler.ts',
          matchCount: 1,
          matches: []
        }),
        expect.objectContaining({
          path: '/Users/example/batshit/docs/user-docs/tools/zips.md',
          matchCount: 1,
          matches: []
        }),
        expect.objectContaining({
          path: '/Users/example/batshit/batshit-app/src/lib/utils/zipActivation.test.ts',
          matchCount: 1,
          matches: []
        })
      ])
    })

    it('omits binary-like read payloads from the main chat payload', async () => {
      const step = {
        toolName: 'batshit_server_read_file',
        toolArgs: { path: '/tmp/image.txt' },
        toolResult: {
          filePath: '/tmp/image.txt',
          content: `data:image/png;base64,${'A'.repeat(2048)}`
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const parsed = JSON.parse((mainCall as any)[0])

      expect(parsed.toolResult.contentOmitted).toBe(true)
      expect(parsed.toolResult.omittedReason).toBe('binary_like')
      expect(parsed.rawSidecar.status).toBe('stored')
    })

    it('marks oversized payloads to stay compressed for AI history', async () => {
      const step = {
        toolName: 'native_bash_execute',
        toolArgs: {
          command: 'npm run verify-huge-output'
        },
        toolResult: {
          stdout: 'x'.repeat(260000),
          stderr: '',
          exitCode: 0
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 50,
        zip_threshold_all_other_tools: 999999
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const parsed = JSON.parse((mainCall as any)[0])

      expect(parsed.operationKind).toBe('bash')
      expect(parsed.storage.forceCompress).toBe(true)
      expect((mainCall as any)[4].forceCompress).toBe(true)
    })

    it('marks moderately large file transcripts to stay compressed for AI history', async () => {
      const step = {
        toolName: 'batshit_server_read_file',
        toolArgs: {
          filePath: '/Users/example/batshit/big-file.ts',
          path: '/Users/example/batshit/big-file.ts'
        },
        toolResult: {
          filePath: '/Users/example/batshit/big-file.ts',
          path: '/Users/example/batshit/big-file.ts',
          content: 'x'.repeat(45000),
          lineCount: 1,
          language: 'typescript'
        }
      }

      await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_read_file: 50,
        zip_threshold_read_file: 999999
      })

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const parsed = JSON.parse((mainCall as any)[0])

      expect(parsed.operationKind).toBe('read_file')
      expect(parsed.storage.forceCompress).toBe(true)
      expect((mainCall as any)[4].forceCompress).toBe(true)
    })

    it('normalizes toolResult shape and metadata into unified content', async () => {
      const step = {
        toolName: 'call_subagent',
        toolResult: { '0': { output: 'Hi from subagent' } },
        toolProvider: 'n8n-workflow',
        gatewayId: 'gw1',
        gatewayName: 'Docker Gateway',
        subagentId: 'sa_123',
        subagentName: 'Helper',
        subagentAvatar: '/avatar.png'
      }

      const results = await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      expect(results).toHaveLength(1)
      const firstCall = vi.mocked(createZipFromContent).mock.calls[0]
      const contentArg = firstCall[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('subagent')
      expect(parsed.originalToolName).toBe('call_subagent')
      expect(Array.isArray(parsed.toolResult)).toBe(true)
      expect(parsed.toolResult[0]?.output).toBe('Hi from subagent')
      expect(parsed.metadata?.gatewayId).toBe('gw1')
      expect(parsed.metadata?.subagentId).toBe('sa_123')
      expect(parsed.metadata?.subagentAvatar).toBe('/avatar.png')
    })

    // 4.4-UNIT-009: Handle circular references safely
    it('should handle circular references safely', async () => {
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      await expect(
        adaptCoolToolsToZipSystem([testToolResults.circularRef], sessionId, messageId, settings)
      ).resolves.not.toThrow()

      const results = await adaptCoolToolsToZipSystem([testToolResults.circularRef], sessionId, messageId, settings)
      expect(results).toHaveLength(1)
      expect(results[0].reference).toContain('cool_tool')
    })

    // 4.4-UNIT-010: Handle very large tool results
    it('should handle very large tool results efficiently', async () => {
      const largeOutput = 'x'.repeat(1000000) // 1MB of data
      const tool = { tool: 'large', output: largeOutput }
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      const start = Date.now()
      const results = await adaptCoolToolsToZipSystem([tool], sessionId, messageId, settings)
      const duration = Date.now() - start

      expect(results).toHaveLength(1)
      expect(duration).toBeLessThan(100) // Should be fast
    })

    // 4.4-UNIT-011: Handle malformed tool objects gracefully
    it('should handle malformed tool objects gracefully', async () => {
      const malformed = [
        null,
        undefined,
        { tool: 'test' }, // Missing output - still valid
        { output: 'test' }, // Missing tool name - invalid
        'not an object' as any
      ]

      const results = await adaptCoolToolsToZipSystem(malformed, sessionId, messageId, defaultSettings)
      // Should skip invalid entries but process valid ones
      expect(results.length).toBeGreaterThanOrEqual(0)
      expect(results.length).toBeLessThanOrEqual(1) // Only one potentially valid entry
    })

    // 4.4-UNIT-012: Use fallback settings when cool_tool settings missing
    it('should use fallback settings when cool_tool settings are not defined', async () => {
      const tools = [{ tool: 'test', output: 'x'.repeat(2000) }]
      const settings: Partial<AgentRow> = {
        buffer_size: 5, // Global settings only
        zip_threshold: 100
      }

      const results = await adaptCoolToolsToZipSystem(tools, sessionId, messageId, settings)

      // Should use global settings as fallback
      expect(results).toHaveLength(1) // Tool exceeds threshold of 100
    })

    // Additional test: Metadata includes tool name and original type
    it('should include tool metadata for renderer parity', async () => {
      const tools = [{ tool: 'test', output: 'payload' }]
      const settings: Partial<AgentRow> = {
        buffer_size: 10,
        zip_threshold: 50,
        buffer_size_all_other_tools: 10,
        zip_threshold_all_other_tools: 200
      }

      const results = await adaptCoolToolsToZipSystem(tools, sessionId, messageId, settings)

      expect(results).toHaveLength(1)
      const metadata = vi.mocked(createZipFromContent).mock.calls[0][4]
      expect(metadata?.toolName).toBe('test')
      expect(metadata?.originalType).toBe('cool_tool')
    })

    // Additional test: Mixed valid/invalid tools
    it('should process valid tools and skip invalid ones', async () => {
      const mixed = [
        { tool: 'valid1', output: 'x'.repeat(1000) },
        null,
        { tool: 'valid2', output: 'data' },
        { notATool: 'invalid' },
        undefined
      ]
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      const results = await adaptCoolToolsToZipSystem(mixed as any, sessionId, messageId, settings)

      // Should only process the 2 valid tools
      expect(results).toHaveLength(2)
      expect(results[0].placeholder).toBe('{{ZIP_COOL_TOOL_0}}')
      expect(results[1].placeholder).toBe('{{ZIP_COOL_TOOL_2}}')
    })

    // Additional test: Empty agent settings
    it('should still create zips when agent settings are empty', async () => {
      const tools = [{ tool: 'test', output: 'x'.repeat(20) }] // ~5 tokens
      const results = await adaptCoolToolsToZipSystem(tools, sessionId, messageId, {})

      expect(results).toHaveLength(1)
      const metadata = vi.mocked(createZipFromContent).mock.calls[0][4]
      expect(metadata?.toolIndex).toBe(0)
    })
  })

  describe('hasSubagentToolSettings', () => {
    it('should return true when buffer_size_subagent is defined', () => {
      const settings: Partial<AgentRow> = { buffer_size_subagent: 5 }
      expect(hasSubagentToolSettings(settings)).toBe(true)
    })

    it('should return true when zip_threshold_subagent is defined', () => {
      const settings: Partial<AgentRow> = { zip_threshold_subagent: 300 }
      expect(hasSubagentToolSettings(settings)).toBe(true)
    })

    it('should return true when both settings are defined', () => {
      const settings: Partial<AgentRow> = {
        buffer_size_subagent: 5,
        zip_threshold_subagent: 300
      }
      expect(hasSubagentToolSettings(settings)).toBe(true)
    })

    it('should return false when no subagent settings are defined', () => {
      const settings: Partial<AgentRow> = {
        buffer_size: 10,
        zip_threshold: 500
      }
      expect(hasSubagentToolSettings(settings)).toBe(false)
    })

    it('should return false for empty settings', () => {
      expect(hasSubagentToolSettings({})).toBe(false)
    })
  })

  describe('getDefaultSubagentSettings', () => {
    it('should return correct default values', () => {
      const defaults = getDefaultSubagentSettings()
      expect(defaults).toEqual({
        buffer_size_subagent: 2,
        zip_threshold_subagent: 0
      })
    })
  })
})

describe('Data Transformation', () => {
  const sessionId = 'test-session'
  const messageId = 'test-msg'

  // 4.4-UNIT-013: Preserve exact structure through transformation
  it('should preserve exact structure through transformation', async () => {
    const original = {
      tool: 'complex',
      input: { nested: { deep: { value: 42 } } },
      output: { array: [1, 2, { three: 3 }] }
    }
    const settings: Partial<AgentRow> = {
      buffer_size_all_other_tools: 0,
      zip_threshold_all_other_tools: 0
    }

    const results = await adaptCoolToolsToZipSystem([original], sessionId, messageId, settings)

    expect(results).toHaveLength(1)
    // The actual structure is preserved in the content that gets stored
    expect(results[0].reference).toContain('cool_tool')
  })

  // 4.4-UNIT-014: Handle special characters in content
  it('should handle special characters in content', async () => {
    const special = {
      tool: 'unicode',
      output: '🚀 émojis "quotes" \\backslash\\ \n\r\t tabs'
    }
    const settings: Partial<AgentRow> = {
      buffer_size_all_other_tools: 0,
      zip_threshold_all_other_tools: 0
    }

    const results = await adaptCoolToolsToZipSystem([special], sessionId, messageId, settings)

    expect(results).toHaveLength(1)
    expect(results[0].reference).toContain('cool_tool')
  })

  // 4.4-UNIT-015: Handle base64 encoded data
  it('should handle base64 encoded data', async () => {
    const base64Data = Buffer.from('binary data').toString('base64')
    const tool = { tool: 'image', output: base64Data }
    const settings: Partial<AgentRow> = {
      buffer_size_all_other_tools: 0,
      zip_threshold_all_other_tools: 0
    }

    const results = await adaptCoolToolsToZipSystem([tool], sessionId, messageId, settings)

    expect(results).toHaveLength(1)
    expect(results[0].reference).toContain('cool_tool')
  })

  // Additional tests for edge cases
    it('should handle tools with only action property', async () => {
      const actionTool = {
        action: { tool: 'test_action', args: {} },
        observation: 'result'
      }
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }

      const results = await adaptCoolToolsToZipSystem([actionTool], sessionId, messageId, settings)

      expect(results).toHaveLength(1)
      expect(results[0].reference).toContain('cool_tool')
    })

    it('maps n8n action/observation steps into toolArgs + toolResult', async () => {
      const mode1Step = {
        action: {
          tool: 'batshit_server_read_file',
          toolInput: { path: '/docs/example.md' },
          toolCallId: 'call_123'
        },
        observation: {
          content: 'Hello World',
          filePath: '/docs/example.md',
          language: 'md'
        }
      }

      await adaptCoolToolsToZipSystem([mode1Step], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const lastCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(lastCall).toBeTruthy()
      const contentArg = (lastCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('read_file')
      expect(parsed.originalToolName).toBe('batshit_server_read_file')
      expect(parsed.toolCallId).toBe('call_123')
      expect(parsed.toolArgs?.filePath).toBe('/docs/example.md')
      expect(parsed.toolResult?.filePath).toBe('/docs/example.md')
      expect(parsed.toolResult?.content).toBe('Hello World')
    })

    it('stores n8n Subnode Subagent action steps as subagent cards with nested tools', async () => {
      const nestedSteps = [
        {
          action: {
            tool: 'Batshit Subagent Tools',
            toolInput: { action: 'bash_execute', input: { command: 'pwd' } }
          },
          observation: { data: { stdout: '/workspace' } }
        }
      ]
      const subagentStep = {
        action: {
          tool: 'n8n Subnode Subagent',
          toolInput: {
            Prompt__User_Message_: 'Check the workspace.'
          },
          toolCallId: 'call_parent'
        },
        observation: {
          output: 'The workspace is ready.',
          intermediateSteps: nestedSteps
        }
      }

      await adaptCoolToolsToZipSystem([subagentStep], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const lastCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(lastCall).toBeTruthy()
      const contentArg = (lastCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('subagent')
      expect(parsed.displayToolName).toBe('n8n Subnode Subagent')
      expect(parsed.operationKind).toBe('subagent')
      expect(parsed.rendererFamily).toBe('subagent')
      expect(parsed.isSubagent).toBe(true)
      expect(parsed.subagentName).toBe('n8n Subnode Subagent')
      expect(parsed.toolArgs?.Prompt__User_Message_).toBe('Check the workspace.')
      expect(parsed.toolResult?.output).toBe('The workspace is ready.')
      expect(parsed.toolResult?.intermediateSteps).toEqual(nestedSteps)
    })

    it('unwraps n8n_MCP_Trigger steps to the underlying MCP tool + args', async () => {
      const wrapperStep = {
        action: {
          tool: 'n8n_MCP_Trigger',
          toolInput: {},
          toolCallId: 'call_wrapper',
          messageLog: [
            {
              kwargs: {
                tool_calls: [
                  {
                    name: 'n8n_MCP_Trigger',
                    args: {
                      projectPath: '/Users/example/batshit',
                      filePath: 'Jen.md',
                      encoding: 'utf8',
                      tool: 'batshit_server_read_file',
                      id: 'call_real'
                    }
                  }
                ]
              }
            }
          ]
        },
        observation: JSON.stringify({
          content: 'Hello from MCP',
          filePath: 'Jen.md',
          language: 'md'
        })
      }

      await adaptCoolToolsToZipSystem([wrapperStep], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const lastCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(lastCall).toBeTruthy()
      const contentArg = (lastCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('read_file')
      expect(parsed.originalToolName).toBe('n8n_MCP_Trigger')
      expect(parsed.toolCallId).toBe('call_real')
      expect(parsed.toolArgs?.filePath).toBe('Jen.md')
      expect(parsed.toolArgs?.projectPath).toBe('/Users/example/batshit')
      expect(parsed.toolResult?.filePath).toBe('Jen.md')
      expect(parsed.toolResult?.content).toBe('Hello from MCP')
    })

    it('unwraps n8n response wrappers into the actual tool content', async () => {
      const wrapperStep = {
        action: {
          tool: 'n8n_MCP_Trigger',
          toolInput: {},
          toolCallId: 'call_wrapper',
          messageLog: [
            {
              kwargs: {
                tool_calls: [
                  {
                    name: 'n8n_MCP_Trigger',
                    args: {
                      projectPath: '/Users/example/batshit',
                      filePath: 'Jen.md',
                      encoding: 'utf8',
                      tool: 'batshit_server_read_file',
                      id: 'call_real'
                    }
                  }
                ]
              }
            }
          ]
        },
        // n8n MCP Trigger returns an array with { response: [ { type, text } ] }.
        // The `text` is itself a JSON-string of the actual tool payload.
        observation: JSON.stringify([
          {
            response: [
              {
                type: 'text',
                text: JSON.stringify([{ type: 'text', text: 'Hello from MCP' }])
              }
            ]
          }
        ])
      }

      await adaptCoolToolsToZipSystem([wrapperStep], sessionId, messageId, {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      })

      const lastCall = vi.mocked(createZipFromContent).mock.calls.at(-1)
      expect(lastCall).toBeTruthy()
      const contentArg = (lastCall as any)[0]
      const parsed = JSON.parse(contentArg)
      expect(parsed.toolName).toBe('read_file')
      expect(parsed.originalToolName).toBe('n8n_MCP_Trigger')
      expect(parsed.toolCallId).toBe('call_real')
      expect(parsed.toolResult?.filePath).toBe('Jen.md')
      expect(parsed.toolResult?.content).toBe('Hello from MCP')
    })

    it('should handle deeply nested circular references', async () => {
      const deep: any = {
        tool: 'nested',
      output: {
        level1: {
          level2: {
            level3: null as any
          }
        }
      }
    }
    deep.output.level1.level2.level3 = deep.output // Deep circular ref

    const settings: Partial<AgentRow> = {
      buffer_size_all_other_tools: 0,
      zip_threshold_all_other_tools: 0
    }

    await expect(
      adaptCoolToolsToZipSystem([deep], sessionId, messageId, settings)
    ).resolves.not.toThrow()
  })
})

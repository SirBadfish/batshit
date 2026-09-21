/**
 * Unit Tests for Cool Tools Zip Adapter
 * Story 4.4: Cool Tools Integration with Stream-to-Zip Architecture
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { adaptCoolToolsToZipSystem, hasSubagentToolSettings, getDefaultSubagentSettings } from '../coolToolZipAdapter'
import { createZipFromContent } from '../zipService'
import { buildCoolToolAiContent, shouldPreferRawSidecarForAiExpansion } from '$lib/utils/coolToolAiContent'
import type { AgentRow } from '$lib/types/database'
import { calculateZipActivation } from '$lib/utils/zipActivation'
import {
  FETCHED_ZIP_ID,
  apiBrokeredZipFetchStep,
  codexDirectZipFetchStep,
  fetchedZipContent
} from '$lib/test-utils/zip-fetch-steps'
import {
  MISSING_FILE_COMMAND,
  MISSING_FILE_ERROR,
  MISSING_FILE_PATH,
  PRESENT_FILE_COMMAND,
  PRESENT_FILE_CONTENT,
  PRESENT_FILE_PATH,
  apiFailedReadStep,
  apiNativeBashResult,
  apiShellStep,
  claudeBashEvents,
  claudeFailedBashEvents,
  cliStepForZip,
  codexCommandEvents,
  codexFileChangeEvents
} from '$lib/test-utils/shell-command-steps'
import { CodexEventAdapter } from '$lib/server/services/codexEventAdapter'
import {
  CAPTURED_UPDATE_AND_RENAME,
  CODEX_PROJECT,
  appServerFileChangeEvents
} from '$lib/test-utils/codex-app-server-file-changes'
import { ClaudeEventAdapter } from '$lib/server/services/claudeEventAdapter'
import { isFailedToolFact } from '$lib/server/services/postTurnCheck.jev'
import { normalizeToolArgs } from '$lib/server/services/sseToolNormalization'
import { buildHydratedCoolToolStep } from '$lib/components/chat/coolToolHydration'

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

    // F-P4-7 (2026-09-17): the managed Codex lane nests the helper call under `arguments`.
    // Step shape captured from the SA-120 P4 live proof, where this search WAS zipped.
    it('skips zip creation for managed Codex helper memory steps (ref under `arguments`)', async () => {
      const codexHelperStep = (ref: string, input: Record<string, unknown>, toolCallId: string) => ({
        toolName: 'mcp.batshit_gateway_jev_p4_codex-mode4-controls.batshit_tool_use',
        originalToolName: 'mcp.batshit_gateway_jev_p4_codex-mode4-controls.batshit_tool_use',
        toolInput: { arguments: { ref, input } },
        toolArgs: { arguments: { ref, input } },
        toolResult: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                controlId: ref.replace(/^fabric:/, ''),
                result: { results: [{ id: 'mem_1', gist: 'Pickle is afraid of fireworks' }] },
                ref,
                family: 'fabric',
                target: ref.replace(/^fabric:/, ''),
                operationKind: 'fabric_use',
                rendererFamily: 'generic_tool'
              })
            }
          ],
          structured_content: null
        },
        toolCallId,
        toolProvider: 'mcp',
        toolSource: 'mcp-gateway',
        mcpServerName: 'batshit_gateway_jev_p4_codex-mode4-controls',
        timestamp: 1789617532085
      })
      const settings: Partial<AgentRow> = {
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      }
      const reservedZipIdsByToolCallId = new Map([
        ['call_memory_search', 'cool_tool_1789617531638_9lq36'],
        ['call_memory_recall', 'cool_tool_1789617531700_abcde'],
        ['call_artifact_update', 'cool_tool_1789617531800_fghij']
      ])

      const memoryOnly = await adaptCoolToolsToZipSystem(
        [
          codexHelperStep(
            'fabric:sys.memory.search',
            { query: 'who should not be near loud bangs', limit: 3 },
            'call_memory_search'
          ),
          codexHelperStep('fabric:sys.memory.recall', { memoryIds: ['mem_1'] }, 'call_memory_recall')
        ],
        sessionId,
        messageId,
        settings,
        undefined,
        { reservedZipIdsByToolCallId }
      )
      expect(memoryOnly).toHaveLength(0)
      expect(vi.mocked(createZipFromContent)).not.toHaveBeenCalled()

      // Negative: a non-memory ref under the same nesting still gets its zip.
      const mixed = await adaptCoolToolsToZipSystem(
        [
          codexHelperStep('fabric:sys.memory.recall', { memoryIds: ['mem_1'] }, 'call_memory_recall'),
          codexHelperStep(
            'fabric:sys.artifact.update',
            { slug: 'notes', content: 'mentions sys.memory.search' },
            'call_artifact_update'
          )
        ],
        sessionId,
        messageId,
        settings,
        undefined,
        { reservedZipIdsByToolCallId }
      )
      expect(mixed).toHaveLength(1)
      expect(mixed[0].zipId).toBe('cool_tool_1789617531800_fghij')
      const zippedToolNames = vi
        .mocked(createZipFromContent)
        .mock.calls.filter((call) => call[1] === 'cool_tool')
        .map((call) => (call[4] as any)?.toolName)
      expect(zippedToolNames).toEqual(['sys.artifact.update'])
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

    // F-P5-1: the API lane's streamed step (send-routed `stepForZip`) carries no `error` or
    // `success` of its own, and a sandbox that failed to start used to be stored as
    // `exitCode: 0` with empty output, so the agent later read it as a clean run.
    it('stores a command whose sandbox never started as a failure with its reason', async () => {
      const reason =
        '[0/6] [0s]\n[6/6] Starting container [0s]\nError: failed to create container (cause: "exists: "container already exists: batshit-apple-sandbox-josh-s52af26b6-5d17df6157"")'
      const args = {
        command: 'git log --oneline -5',
        innerCommand: 'git log --oneline -5',
        originalToolName: 'native_bash_execute'
      }
      const streamedStep = {
        toolName: 'native_bash_execute',
        originalToolName: 'native_bash_execute',
        toolInput: args,
        toolArgs: args,
        toolResult: {
          success: false,
          blocked: false,
          errorCode: 'SANDBOX_UNAVAILABLE',
          reason,
          command: 'git log --oneline -5',
          policyMode: 'workspace',
          accessMode: 'agent',
          backend: 'apple_container',
          input: args,
          originalToolName: 'native_bash_execute',
          mappedToolName: 'native_bash_execute',
          mappedReason: 'Command does not map to a structured file tool.'
        },
        toolCallId: 'toolu_sandbox_never_started',
        timestamp: new Date().toISOString(),
        metadata: { sessionId }
      }

      const result = await adaptCoolToolsToZipSystem([streamedStep], sessionId, messageId, defaultSettings)

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const payload = JSON.parse(mainCall?.[0] as string)
      expect(payload.operationKind).toBe('bash')
      expect(payload.toolResult).not.toHaveProperty('exitCode')
      expect(payload.toolResult).toMatchObject({
        command: 'git log --oneline -5',
        stdout: '',
        stderr: reason,
        errorCode: 'SANDBOX_UNAVAILABLE'
      })
      expect(payload.error).toBe(reason)
      expect(result[0].reference).toContain('bash: git log --oneline -5 - error')

      const aiView = buildCoolToolAiContent('zip_sandbox_never_started', { content: mainCall?.[0] }, payload)
      expect(aiView).toContain('Error code: SANDBOX_UNAVAILABLE')
      expect(aiView).toContain('container already exists')
      expect(aiView).not.toContain('Exit code')
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

    // F-P5-2 (2026-09-17): a zip fetch whose fetched zip is itself a tool result was stored
    // as that INNER tool (`bash - 9 lines`, empty args, no target), so it followed Bash's zip
    // policy and rendered as a Bash card with no command. Captured API step shape.
    it('stores a brokered API zip fetch as fetch_zip, not as the tool it fetched', async () => {
      const created = await adaptCoolToolsToZipSystem([apiBrokeredZipFetchStep()], sessionId, messageId, {})

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const content = (mainCall as any)[0] as string
      const metadata = (mainCall as any)[4]
      const parsed = JSON.parse(content)

      expect(metadata).toMatchObject({
        toolName: 'fetch_zip',
        displayToolName: 'Fetch Zip',
        operationKind: 'fetch_zip',
        rendererFamily: 'generic_tool',
        zipDescriptionLabel: 'fetch_zip',
        zipDescriptionTarget: FETCHED_ZIP_ID
      })
      expect(parsed).toMatchObject({
        toolName: 'fetch_zip',
        displayToolName: 'Fetch Zip',
        originalToolName: 'native_batshit_tool_use',
        operationKind: 'fetch_zip',
        rendererFamily: 'generic_tool',
        toolArgs: { zipId: FETCHED_ZIP_ID },
        toolResult: {
          found: true,
          zipId: FETCHED_ZIP_ID,
          type: 'cool_tool',
          content: fetchedZipContent()
        }
      })
      expect(parsed.toolResult).not.toHaveProperty('stdout')

      // The real description builder, fed what the adapter stored.
      const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
      const description = generateZipDescription(content, 'cool_tool', metadata)
      expect(description).toBe(`fetch_zip: ${FETCHED_ZIP_ID} - 1 line`)
      expect(created[0].reference).toContain(`:::fetch_zip: ${FETCHED_ZIP_ID}`)

      // Zip policy follows the Fetch Zip row, not the fetched tool's. Bash is Normal with a
      // long buffer here and Fetch Zip is Auto, so a fresh fetch compresses at once.
      const agentSettings = {
        auto_zip_execute_command: false,
        buffer_size_execute_command: 10,
        auto_zip_fetch_zip: true
      }
      const stored = { type: 'cool_tool', content, tokens: metadata.tokens, metadata }
      const activation = calculateZipActivation({
        zipType: 'cool_tool',
        messagesFromEnd: 0,
        zipData: stored,
        agentSettings
      })
      expect(activation).toMatchObject({ toolName: 'fetch_zip', autoZip: true, shouldCompress: true })

      // The stored body alone resolves the same way (metadata-less read paths).
      const fromContent = calculateZipActivation({
        zipType: 'cool_tool',
        messagesFromEnd: 0,
        zipData: { type: 'cool_tool', content, tokens: metadata.tokens },
        agentSettings
      })
      expect(fromContent).toMatchObject({ toolName: 'fetch_zip', autoZip: true, shouldCompress: true })
    })

    it('stores a managed Codex direct-helper zip fetch as fetch_zip', async () => {
      await adaptCoolToolsToZipSystem([codexDirectZipFetchStep()], sessionId, messageId, {})

      const mainCall = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const metadata = (mainCall as any)[4]
      const parsed = JSON.parse((mainCall as any)[0])

      expect(metadata).toMatchObject({
        toolName: 'fetch_zip',
        operationKind: 'fetch_zip',
        rendererFamily: 'generic_tool',
        zipDescriptionLabel: 'fetch_zip',
        zipDescriptionTarget: FETCHED_ZIP_ID
      })
      expect(parsed).toMatchObject({
        toolName: 'fetch_zip',
        operationKind: 'fetch_zip',
        toolArgs: { zipId: FETCHED_ZIP_ID, includeContent: true, maxChars: 20000 },
        toolResult: { found: true, zipId: FETCHED_ZIP_ID, content: fetchedZipContent() }
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

// F-P6-5 (2026-09-17): on the managed Codex lane `cat` on a missing file exited 1, and the stored
// read said nothing about it (`read_file: <path> - 2 lines`, no status, the error text as the file's
// content): the read shaping kept the text and dropped the exit code. The follow-up found the same
// gap in every file action a shell command becomes (write, edit, listing, search, a Codex patch, a
// command Codex reports failed with no exit code). Each case runs the lane's own event adapter, or
// the API lane's live step, then this adapter, then the description zipService really writes.
describe('a shell command stored as a file action keeps its failure (F-P6-5)', () => {
  const sessionId = 'session-shell-read'
  const messageId = 'msg-shell-read'
  const request: any = {
    sessionId,
    messageId,
    agentId: 'agent-shell-read',
    userId: 'user-shell-read',
    model: 'cli',
    messages: [{ role: 'user', content: 'Read the file' }],
    availableTools: [],
    maxToolRounds: 1
  }
  const DIR = '/tmp/batshit-example'

  beforeEach(() => {
    vi.mocked(createZipFromContent).mockClear()
  })

  async function toolResultChunk(adapter: CodexEventAdapter | ClaudeEventAdapter, events: any[]) {
    async function* stream() {
      yield* events
    }
    let found: any = null
    for await (const chunk of adapter.stream(stream() as any)) {
      if ((chunk as any).type === 'tool-result') found = chunk
    }
    expect(found).toBeTruthy()
    return found
  }

  async function storeStep(step: Record<string, any>) {
    await adaptCoolToolsToZipSystem([step], sessionId, messageId, {})
    const call = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'cool_tool')
    const rawCall = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'tool_raw')
    const content = (call as any)[0] as string
    const metadata = (call as any)[4]
    const payload = JSON.parse(content)
    const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
    const description = generateZipDescription(content, 'cool_tool', metadata)
    return {
      payload,
      metadata,
      description,
      rawSidecar: rawCall ? JSON.parse((rawCall as any)[0] as string) : null,
      aiView: buildCoolToolAiContent('zip_shell_read', { content, metadata }, payload),
      // What the after-reply check reads back from the stored zip.
      failed: isFailedToolFact({
        description,
        kind: metadata.operationKind,
        target: metadata.zipDescriptionTarget ?? '',
        status: metadata.zipDescriptionStatus ?? ''
      })
    }
  }

  async function storeCodexCommand(options: Parameters<typeof codexCommandEvents>[0]) {
    const adapter = new CodexEventAdapter({ request, transport: 'cli' })
    const chunk = await toolResultChunk(adapter, codexCommandEvents(options))
    return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
  }

  async function storeCodexPatch(options: Parameters<typeof codexFileChangeEvents>[0]) {
    const adapter = new CodexEventAdapter({ request, transport: 'cli' })
    const chunk = await toolResultChunk(adapter, codexFileChangeEvents(options))
    return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
  }

  describe('reads', () => {
    it('stores a Codex `cat` that exited 1 as a failed read, with its exit code', async () => {
      const stored = await storeCodexCommand({
        id: 'call_failed_cat',
        command: MISSING_FILE_COMMAND,
        output: MISSING_FILE_ERROR,
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.description).toBe(`read_file: ${MISSING_FILE_PATH} - exit 1 - 2 lines`)
      expect(stored.metadata).toMatchObject({
        operationKind: 'read_file',
        zipDescriptionLabel: 'read_file',
        zipDescriptionTarget: MISSING_FILE_PATH,
        zipDescriptionStatus: 'exit 1'
      })
      expect(stored.payload).toMatchObject({
        operationKind: 'read_file',
        rendererFamily: 'read_file',
        toolResult: {
          filePath: MISSING_FILE_PATH,
          content: MISSING_FILE_ERROR.trimEnd(),
          exitCode: 1
        }
      })
      expect(stored.aiView).toBe(
        `Tool result: read_file\nPath: ${MISSING_FILE_PATH}\nExit code: 1\nLines: 2\nChars/bytes: 64\n` +
          `Content:\n\`\`\`plaintext\n${MISSING_FILE_ERROR.trimEnd()}\n\`\`\``
      )
      expect(stored.failed).toBe(true)
    })

    it('keeps a successful Codex `cat` exactly as it was stored before', async () => {
      const stored = await storeCodexCommand({
        id: 'call_present_cat',
        command: PRESENT_FILE_COMMAND,
        output: PRESENT_FILE_CONTENT,
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.description).toBe(`read_file: ${PRESENT_FILE_PATH} - 5 lines`)
      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.payload.error).toBeUndefined()
      expect(stored.payload.toolResult).toEqual({
        filePath: PRESENT_FILE_PATH,
        path: PRESENT_FILE_PATH,
        content: PRESENT_FILE_CONTENT.trimEnd(),
        lineCount: 5,
        size: 34,
        language: 'markdown',
        contentTruncated: false,
        contentOmitted: false,
        contentChars: 34
      })
      expect(stored.aiView).toBe(
        `Tool result: read_file\nPath: ${PRESENT_FILE_PATH}\nLines: 5\nChars/bytes: 34\n` +
          `Content:\n\`\`\`markdown\n${PRESENT_FILE_CONTENT.trimEnd()}\n\`\`\``
      )
      expect(stored.failed).toBe(false)
    })

    // The app-server lane maps a declined or cancelled command to `failed` with no exit code: the
    // failure is kept as a reason, and no exit code is ever derived from Codex's `status` word.
    it('stores a Codex read that failed with no exit code as an error, not as JSON', async () => {
      const stored = await storeCodexCommand({
        id: 'call_no_exit_cat',
        command: MISSING_FILE_COMMAND,
        output: '',
        status: 'failed'
      })

      expect(stored.description).toBe(`read_file: ${MISSING_FILE_PATH} - error - 0 lines`)
      expect(stored.payload.error).toBe('Codex reported this command as failed and gave no exit code.')
      expect(stored.payload.toolResult).not.toHaveProperty('exitCode')
      expect(stored.payload.toolResult.content).toBe('')
      expect(stored.aiView).toContain(
        'Error:\n```text\nCodex reported this command as failed and gave no exit code.\n```'
      )
      expect(stored.failed).toBe(true)
    })

    it('does not call a read that ends in a search with no match a failure', async () => {
      const stored = await storeCodexCommand({
        id: 'call_cat_grep',
        command: `cat ${PRESENT_FILE_PATH} | grep zzz`,
        output: 'nothing\n',
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.payload.operationKind).toBe('read_file')
      expect(stored.payload.toolResult).not.toHaveProperty('exitCode')
      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.failed).toBe(false)
    })

    it('already stored a failed managed Claude `cat` as an error (no gap on that lane)', async () => {
      const adapter = new ClaudeEventAdapter({ request, transport: 'cli' })
      const chunk = await toolResultChunk(adapter, claudeFailedBashEvents('toolu_failed_cat'))
      const stored = await storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))

      expect(chunk.toolName).toBe('batshit_server_read_file')
      expect(stored.description).toBe(`read_file: ${MISSING_FILE_PATH} - error - 1 line`)
      expect(stored.metadata.zipDescriptionStatus).toBe('error')
      expect(stored.payload.error).toBe(`Error: Exit code 1\n${MISSING_FILE_ERROR.trimEnd()}`)
      // The follow-up gave this lane the number Claude keeps inside its text, so the content is
      // what `cat` printed and the exit code is a number like every other lane's.
      expect(stored.payload.toolResult).toMatchObject({
        content: MISSING_FILE_ERROR.trimEnd(),
        exitCode: 1
      })
      expect(stored.payload.toolResult.content).not.toContain('Exit code 1')
      expect(stored.failed).toBe(true)
    })

    // The API lane's empty stdout once made the read's "content" the whole native bash result:
    // 31 lines of JSON with `success`, `stderr`, and the sandbox name.
    it('stores what an API read that failed printed, never the whole result', async () => {
      const stored = await storeStep(apiFailedReadStep())
      const printed = `cat: can't open '${MISSING_FILE_PATH}': No such file or directory`

      expect(stored.description).toBe(`read_file: ${MISSING_FILE_PATH} - error - 2 lines`)
      // fp65h: the native result names no reason, so the failure gives its exit code.
      expect(stored.payload.error).toBe('The command failed with exit code 1.')
      expect(stored.payload.toolResult).toMatchObject({ content: printed, exitCode: 1 })
      expect(stored.payload.toolResult.content).not.toContain('sandboxName')
      expect(stored.aiView).toBe(
        `Tool result: read_file\nPath: ${MISSING_FILE_PATH}\nExit code: 1\nLines: 2\nChars/bytes: 77\n` +
          `Content:\n\`\`\`plaintext\n${printed}\n\`\`\``
      )
      expect(stored.failed).toBe(true)
    })

    it("does not read a read tool's own numeric status or code as an exit code", async () => {
      const stored = await storeStep({
        toolName: 'read_file',
        toolArgs: { path: PRESENT_FILE_PATH },
        toolResult: { content: PRESENT_FILE_CONTENT, status: 200, code: 404 },
        toolCallId: 'mcp_read_1',
        timestamp: '2026-09-17T08:00:00.000Z'
      })

      expect(stored.payload.toolResult).not.toHaveProperty('exitCode')
      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.description).toBe(`read_file: ${PRESENT_FILE_PATH} - 5 lines`)
    })
  })

  describe('writes, edits, and patches', () => {
    // Whether the adapter reads a failed write back is pinned in codexEventAdapter.test.ts.
    it('stores a Codex write that exited 1 as a failed write', async () => {
      const stored = await storeCodexCommand({
        id: 'call_failed_write',
        command: 'echo hi > /nope/dir/out.txt',
        output: 'zsh: no such file or directory: /nope/dir/out.txt\n',
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.description).toBe('write_file: /nope/dir/out.txt - exit 1 - 1 line')
      expect(stored.payload.toolResult).toMatchObject({
        filePath: '/nope/dir/out.txt',
        exitCode: 1,
        commandOutput: 'zsh: no such file or directory: /nope/dir/out.txt'
      })
      expect(JSON.stringify(stored.payload)).not.toContain('content unavailable')
      expect(stored.aiView).toBe(
        'Tool result: write_file\nPath: /nope/dir/out.txt\nExit code: 1\n' +
          'Output:\n```text\nzsh: no such file or directory: /nope/dir/out.txt\n```'
      )
      expect(stored.failed).toBe(true)
    })

    it('never stores what a failed write printed as the content it wrote', async () => {
      const stored = await storeCodexCommand({
        id: 'call_failed_generated_write',
        command: 'node gen.js > /nope/dir/out.txt',
        output: 'zsh: no such file or directory: /nope/dir/out.txt\n',
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.payload.operationKind).toBe('write_file')
      expect(stored.payload.toolResult.content).toBe('')
      expect(stored.payload.toolResult.commandOutput).toBe('zsh: no such file or directory: /nope/dir/out.txt')
    })

    it('keeps a successful Codex write exactly as it was stored before', async () => {
      const stored = await storeCodexCommand({
        id: 'call_present_write',
        command: `echo hi > ${DIR}/out.txt`,
        output: '',
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.description).toBe(`write_file: ${DIR}/out.txt - 1 line`)
      expect(stored.payload.toolResult).toEqual({
        filePath: `${DIR}/out.txt`,
        path: `${DIR}/out.txt`,
        content: 'hi',
        lineCount: 1,
        size: 2,
        language: 'plaintext',
        contentTruncated: false,
        contentOmitted: false,
        contentChars: 2
      })
      expect(stored.aiView).toBe(
        `Tool result: write_file\nPath: ${DIR}/out.txt\nLines: 1\nChars/bytes: 2\nWritten content:\n\`\`\`plaintext\nhi\n\`\`\``
      )
    })

    it('stores a Codex in-place edit that exited 1 without claiming it updated the file', async () => {
      const stored = await storeCodexCommand({
        id: 'call_failed_edit',
        command: 'sed -i s/a/b/ /nope/missing.txt',
        output: 'sed: /nope/missing.txt: No such file or directory\n',
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.description).toMatch(/^edit_file: \/nope\/missing\.txt - exit 1 - /)
      expect(stored.payload.toolResult).toMatchObject({
        diff: '',
        exitCode: 1,
        commandOutput: 'sed: /nope/missing.txt: No such file or directory'
      })
      expect(JSON.stringify(stored.payload)).not.toContain('Updated /nope/missing.txt')
      expect(stored.aiView).toBe(
        'Tool result: edit_file\nPath: /nope/missing.txt\nExit code: 1\n' +
          'Output:\n```text\nsed: /nope/missing.txt: No such file or directory\n```'
      )
      expect(stored.failed).toBe(true)
    })

    it('stores a Codex patch that failed as an edit that was not applied', async () => {
      const stored = await storeCodexPatch({
        id: 'patch_failed',
        changes: [{ path: `${DIR}/notes.md`, kind: 'update' }],
        status: 'failed'
      })

      // The size is the diff's, and a patch that failed applied nothing (item 3).
      expect(stored.description).toBe(`edit_file: ${DIR}/notes.md - error - 0 lines`)
      expect(stored.payload.error).toBe('Codex reported that this patch failed.')
      expect(stored.payload.toolResult.diff).toBe('')
      expect(stored.aiView).toBe(
        `Tool result: edit_file\nPath: ${DIR}/notes.md\nError:\n\`\`\`text\nCodex reported that this patch failed.\n\`\`\``
      )
      expect(stored.failed).toBe(true)
    })

    // `nativeBashExecute` reads the edit target just before and just after a clean run and reports
    // their diff. The rebuild in `normalizeToolStep` once dropped the copies it sent then, so every
    // API edit without a patch was stored as "Diff unavailable" (found in F-P6-5's round).
    describe("an API in-place edit's diff", () => {
      const edited = PRESENT_FILE_CONTENT.replace('First', 'Last')
      const apiEdit = (command: string, before: string, after: string) =>
        apiShellStep({ id: 'toolu_api_edit', command, exitCode: 0, snapshots: { before, after } })

      it('stores the changed lines, never the copies', async () => {
        const stored = await storeStep(apiEdit(`sed -i 's/First/Last/' ${PRESENT_FILE_PATH}`, PRESENT_FILE_CONTENT, edited))
        const diff =
          '--- Before\n+++ After\n    1 | # Notes\n    2 | \n-   3 | First line.\n+   3 | Last line.\n    4 | Second line.\n    5 |'

        expect(stored.description).toBe(`edit_file: ${PRESENT_FILE_PATH} - 8 lines`)
        expect(stored.payload.toolResult).toEqual({
          filePath: PRESENT_FILE_PATH,
          path: PRESENT_FILE_PATH,
          diff,
          diffTruncated: false,
          diffOmitted: false,
          language: 'markdown'
        })
        expect(stored.aiView).toBe(`Tool result: edit_file\nPath: ${PRESENT_FILE_PATH}\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``)
        // The raw sidecar keeps the rebuilt result: the diff, and neither copy of the file.
        expect(stored.rawSidecar?.toolResult.diff).toBe(`${diff} `)
        expect(JSON.stringify(stored.rawSidecar)).not.toContain('"before"')
        expect(JSON.stringify(stored.rawSidecar)).not.toContain(JSON.stringify(PRESENT_FILE_CONTENT))
        expect(stored.failed).toBe(false)
      })

      it('stores an edit that changed nothing as no change, not as "Updated"', async () => {
        const stored = await storeStep(
          apiEdit(`sed -i 's/zzz/yyy/' ${PRESENT_FILE_PATH}`, PRESENT_FILE_CONTENT, PRESENT_FILE_CONTENT)
        )

        expect(stored.description).toBe(`edit_file: ${PRESENT_FILE_PATH} - 1 line`)
        expect(stored.payload.toolResult.diff).toBe(`No changes: the command left ${PRESENT_FILE_PATH} exactly as it was.`)
      })

      // An empty file read as "no copy", so this edit kept saying "Diff unavailable".
      it('stores a diff for an edit that fills an empty file', async () => {
        const stored = await storeStep(apiEdit(`sed -i '1i hello' ${PRESENT_FILE_PATH}`, '', 'hello\n'))

        expect(stored.payload.toolResult.diff).toBe('--- Before\n+++ After\n+   1 | hello\n    1 |')
      })

      it('still stores the summary for an edit the run reported no diff for', async () => {
        const stored = await storeStep(
          apiShellStep({ id: 'toolu_api_edit_nocopy', command: `sed -i 's/First/Last/' ${PRESENT_FILE_PATH}`, exitCode: 0 })
        )

        expect(stored.payload.toolResult.diff).toBe(
          `Updated ${PRESENT_FILE_PATH}. Diff unavailable because Batshit could not reconstruct the before/after change.`
        )
      })

      // An edit that changed nothing once stored an empty diff here, and the model then read the
      // raw sidecar: for this wrapper the whole native result, both copies of the file included.
      it('keeps a native-wrapper edit that changed nothing out of the raw sidecar', async () => {
        const command = `sed -i 's/zzz/yyy/' ${PRESENT_FILE_PATH}`
        const data = apiNativeBashResult({
          id: 'n8n_edit_nomatch',
          command,
          exitCode: 0,
          snapshots: { before: PRESENT_FILE_CONTENT, after: PRESENT_FILE_CONTENT }
        })
        const stored = await storeStep({
          toolName: 'Batshit_Native_Tools',
          toolArgs: { action: 'bash_execute', input: { command } },
          toolResult: [{ success: true, action: 'bash_execute', backend: 'apple_container', data }],
          toolCallId: 'n8n_edit_nomatch',
          timestamp: '2026-09-18T08:00:00.000Z'
        })

        expect(stored.payload.toolResult.diff).toBe(`No changes: the command left ${PRESENT_FILE_PATH} exactly as it was.`)
        expect(shouldPreferRawSidecarForAiExpansion(stored.payload)).toBe(false)
        expect(stored.aiView).not.toContain('"before"')
        expect(stored.metadata.promptTokens).toBeLessThan(60)
        expect(JSON.stringify(stored.rawSidecar)).not.toContain(JSON.stringify(PRESENT_FILE_CONTENT))
      })
    })

    // Every Codex native patch crashed the adapter (`kind.toLowerCase is not a function`) once the
    // app server described a change's kind as an object; it also sends each file's own diff.
    it('stores a real Codex native patch with Codex\'s own diff', async () => {
      const adapter = new CodexEventAdapter({ request: { ...request, projectPath: CODEX_PROJECT }, transport: 'cli' })
      const chunk = await toolResultChunk(adapter, appServerFileChangeEvents(CAPTURED_UPDATE_AND_RENAME))
      const stored = await storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
      const diff =
        'diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -2,3 +2,3 @@\n \n' +
        '-First line.\n+Last line.\n Second line.\n' +
        'diff --git a/old-name.txt b/new-name.txt\nrename from old-name.txt\nrename to new-name.txt'

      expect(stored.description).toBe(`edit_file: ${CODEX_PROJECT}/notes.md - 11 lines`)
      expect(stored.payload.toolResult).toMatchObject({ filePath: `${CODEX_PROJECT}/notes.md`, diff })
      expect(stored.aiView).toContain(`Diff:\n\`\`\`diff\n${diff}\n\`\`\``)
      expect(stored.failed).toBe(false)
    })

    it('keeps the API lane at `error` for a failed write and now keeps what it printed', async () => {
      const stored = await storeStep(
        apiShellStep({
          id: 'toolu_api_failed_write',
          command: 'echo hi > /nope/dir/out.txt',
          stderr: 'bash: /nope/dir/out.txt: No such file or directory\n',
          exitCode: 1
        })
      )

      expect(stored.description).toBe('write_file: /nope/dir/out.txt - error - 1 line')
      expect(stored.payload.toolResult).toMatchObject({
        exitCode: 1,
        commandOutput: 'bash: /nope/dir/out.txt: No such file or directory'
      })
      expect(stored.aiView).toBe(
        'Tool result: write_file\nPath: /nope/dir/out.txt\nExit code: 1\n' +
          'Output:\n```text\nbash: /nope/dir/out.txt: No such file or directory\n```'
      )
    })
  })

  describe('listings and searches', () => {
    it('stores a Codex listing that exited 1 with no entries, never its error line', async () => {
      const stored = await storeCodexCommand({
        id: 'call_failed_ls',
        command: 'ls /nope',
        output: 'ls: /nope: No such file or directory\n',
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.description).toBe('list_files: /nope - exit 1 - 0 entries')
      expect(stored.payload.toolResult).toMatchObject({
        files: [],
        totalItems: 0,
        exitCode: 1,
        commandOutput: 'ls: /nope: No such file or directory'
      })
      expect(stored.aiView).toBe(
        'Tool result: list_files\nPath: /nope\nExit code: 1\nItems: 0\nFiles:\n(none)\n' +
          'Output:\n```text\nls: /nope: No such file or directory\n```'
      )
      expect(stored.failed).toBe(true)
    })

    it('keeps the real entries of a `find` that hit an error, and drops its error lines', async () => {
      const stored = await storeCodexCommand({
        id: 'call_partial_find',
        command: `find ${DIR} -name "*.md"`,
        output: `${DIR}/notes.md\nfind: ${DIR}/private: Permission denied\n`,
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.description).toBe(`list_files: ${DIR} - exit 1 - 1 entry`)
      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
    })

    it('keeps a successful Codex listing exactly as it was stored before', async () => {
      const stored = await storeCodexCommand({
        id: 'call_present_ls',
        command: `ls ${DIR}`,
        output: 'notes.md\nout.txt\n',
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.description).toBe(`list_files: ${DIR} - 2 entries`)
      expect(stored.payload.toolResult).toEqual({
        files: [
          { path: 'notes.md', name: 'notes.md', type: 'unknown' },
          { path: 'out.txt', name: 'out.txt', type: 'unknown' }
        ],
        totalFiles: 0,
        totalDirectories: 0,
        totalUnknownItems: 2,
        totalItems: 2
      })
      expect(stored.aiView).toBe(`Tool result: list_files\nPath: ${DIR}\nItems: 2\nFiles:\n- notes.md\n- out.txt`)
    })

    it.each([
      { label: 'a search with no match', command: `rg zzz ${DIR}`, lane: 'search_files' },
      { label: 'a grep with no match', command: `grep -rn zzz ${DIR}`, lane: 'search_files' },
      { label: 'an `rg --files` listing with nothing in it', command: 'rg --files /tmp/empty-dir', lane: 'list_files' }
    ])('does not call exit 1 from $label a failure', async ({ command, lane }) => {
      const stored = await storeCodexCommand({ id: 'call_no_match', command, output: '', exitCode: 1, status: 'failed' })

      expect(stored.payload.operationKind).toBe(lane)
      expect(stored.payload.toolResult).not.toHaveProperty('exitCode')
      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.failed).toBe(false)
    })

    it('stores a search that hit an error with its exit code', async () => {
      const stored = await storeCodexCommand({
        id: 'call_search_error',
        command: 'rg zzz /nope',
        output: 'rg: /nope: No such file or directory (os error 2)\n',
        exitCode: 2,
        status: 'failed'
      })

      expect(stored.description).toBe('search_files: "zzz" - exit 2 - 1 line')
      expect(stored.payload.toolResult.exitCode).toBe(2)
      expect(stored.failed).toBe(true)
    })
  })

  it('stores a Codex command that failed with no exit code as an error, with the reason as stderr', async () => {
    const stored = await storeCodexCommand({ id: 'call_no_exit_bash', command: 'node -e "1"', output: '', status: 'failed' })

    expect(stored.description).toBe('bash: node -e "1" - error - 1 line')
    expect(stored.payload.toolResult).not.toHaveProperty('exitCode')
    expect(stored.payload.toolResult.stderr).toBe('Codex reported this command as failed and gave no exit code.')
    expect(stored.failed).toBe(true)
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

/**
 * The defects F-P6-5 and its follow-up found in passing, fixed here over the same real path:
 * the lane adapter, send-routed's live zip step, `adaptCoolToolsToZipSystem`, the real
 * description builder, the AI view, and the reply check's reading of the stored status.
 */
describe('the F-P6-5 follow-up found-in-passing defects', () => {
  const sessionId = 'session-shell-followup'
  const messageId = 'msg-shell-followup'
  const request: any = {
    sessionId,
    messageId,
    agentId: 'agent-shell-followup',
    userId: 'user-shell-followup',
    model: 'cli',
    messages: [{ role: 'user', content: 'Do it' }],
    availableTools: [],
    maxToolRounds: 1
  }
  const DIR = '/tmp/batshit-example'
  const NO_OUTPUT = '(Bash completed with no output)'

  beforeEach(() => {
    vi.mocked(createZipFromContent).mockClear()
  })

  async function toolResultChunk(adapter: CodexEventAdapter | ClaudeEventAdapter, events: any[]) {
    async function* stream() {
      yield* events
    }
    let found: any = null
    for await (const chunk of adapter.stream(stream() as any)) {
      if ((chunk as any).type === 'tool-result') found = chunk
    }
    expect(found).toBeTruthy()
    return found
  }

  async function storeStep(step: Record<string, any>) {
    // One test can store several steps; each must read its own zip, not the test's first one.
    vi.mocked(createZipFromContent).mockClear()
    await adaptCoolToolsToZipSystem([step], sessionId, messageId, {})
    const call = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'cool_tool')
    const content = (call as any)[0] as string
    const metadata = (call as any)[4]
    const payload = JSON.parse(content)
    const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
    const description = generateZipDescription(content, 'cool_tool', metadata)
    return {
      payload,
      metadata,
      description,
      aiView: buildCoolToolAiContent('zip_shell_followup', { content, metadata }, payload),
      failed: isFailedToolFact({
        description,
        kind: metadata.operationKind,
        target: metadata.zipDescriptionTarget ?? '',
        status: metadata.zipDescriptionStatus ?? ''
      })
    }
  }

  async function storeCodexCommand(options: Parameters<typeof codexCommandEvents>[0]) {
    const adapter = new CodexEventAdapter({ request, transport: 'cli' })
    const chunk = await toolResultChunk(adapter, codexCommandEvents(options))
    return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
  }

  async function storeCodexPatch(options: Parameters<typeof codexFileChangeEvents>[0]) {
    const adapter = new CodexEventAdapter({ request, transport: 'cli' })
    const chunk = await toolResultChunk(adapter, codexFileChangeEvents(options))
    return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
  }

  async function storeClaudeBash(options: {
    command: string
    isError?: boolean
    content: string
    toolUseResult: unknown
  }) {
    const adapter = new ClaudeEventAdapter({ request, transport: 'cli' })
    const chunk = await toolResultChunk(
      adapter,
      claudeBashEvents({ id: 'toolu_followup', ...options, isError: options.isError === true })
    )
    return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
  }

  function claudeFailure(command: string, output: string, exitCode = 1) {
    const text = output ? `Exit code ${exitCode}\n${output}` : `Exit code ${exitCode}`
    return { command, isError: true, content: text, toolUseResult: `Error: ${text}` }
  }

  function claudeSuccess(command: string, stdout: string) {
    return {
      command,
      content: stdout || NO_OUTPUT,
      toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
    }
  }

  // Item 1 — the API lane's native bash calls every non-zero exit a failure, so a search that
  // matched nothing was stored as an error and the reply check counted it as a failed tool.
  describe('a search that matched nothing is an answer on every lane (item 1)', () => {
    it.each([
      { label: 'a search', command: `rg zzz ${DIR}`, kind: 'search_files' },
      { label: 'a grep', command: `grep -rn zzz ${DIR}`, kind: 'search_files' },
      { label: 'an `rg --files` listing', command: 'rg --files /tmp/empty-dir', kind: 'list_files' },
      { label: 'a read piped into a search', command: `cat ${DIR}/notes.md | grep zzz`, kind: 'read_file' }
    ])('stores $label with no match as a success on the API lane', async ({ command, kind }) => {
      const stored = await storeStep(apiShellStep({ id: 'toolu_api_no_match', command, exitCode: 1 }, sessionId))

      expect(stored.payload.operationKind).toBe(kind)
      expect(stored.payload.error).toBeUndefined()
      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.failed).toBe(false)
    })

    it.each([
      { label: 'a search', command: `rg zzz ${DIR}`, kind: 'search_files' },
      { label: 'an `rg --files` listing', command: 'rg --files /tmp/empty-dir', kind: 'list_files' }
    ])('stores $label with no match as a success on the managed Claude lane', async ({ command, kind }) => {
      const stored = await storeClaudeBash(claudeFailure(command, ''))

      expect(stored.payload.operationKind).toBe(kind)
      expect(stored.payload.error).toBeUndefined()
      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.failed).toBe(false)
    })

    it('still stores a real search error as a failure on both lanes', async () => {
      const api = await storeStep(
        apiShellStep(
          { id: 'toolu_api_search_error', command: 'rg zzz /nope', stderr: 'rg: /nope: No such file\n', exitCode: 2 },
          sessionId
        )
      )
      const claude = await storeClaudeBash(claudeFailure('rg zzz /nope', 'rg: /nope: No such file', 2))

      expect(api.metadata.zipDescriptionStatus).toBe('error')
      expect(api.failed).toBe(true)
      expect(claude.metadata.zipDescriptionStatus).toBe('error')
      expect(claude.payload.toolResult.exitCode).toBe(2)
      expect(claude.failed).toBe(true)
    })

    it('still stores a search that timed out as a failure', async () => {
      const step = apiShellStep({ id: 'toolu_api_timeout', command: `rg zzz ${DIR}`, exitCode: 1 }, sessionId)
      const stored = await storeStep({ ...step, toolResult: { ...step.toolResult, timedOut: true } })

      expect(stored.metadata.zipDescriptionStatus).toBe('error')
      expect(stored.failed).toBe(true)
    })
  })

  // Item 2 — a read whose command printed nothing stored the whole native result as JSON.
  describe('a read that printed nothing read nothing (item 2)', () => {
    it('stores an empty Codex read as empty, not as its own result object', async () => {
      const stored = await storeCodexCommand({
        id: 'call_empty_cat',
        command: `cat ${DIR}/empty.txt`,
        output: '',
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.description).toBe(`read_file: ${DIR}/empty.txt - 0 lines`)
      expect(stored.payload.toolResult.content).toBe('')
      expect(stored.aiView).toBe(
        `Tool result: read_file\nPath: ${DIR}/empty.txt\nLines: 0\nChars/bytes: 0\nContent:\n\`\`\`plaintext\n\n\`\`\``
      )
    })

    it('stores an empty API read as empty, not as 31 lines of JSON', async () => {
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_api_empty_read', command: `cat ${DIR}/empty.txt`, exitCode: 0 }, sessionId)
      )

      expect(stored.description).toBe(`read_file: ${DIR}/empty.txt - 0 lines`)
      expect(stored.payload.toolResult.content).toBe('')
      expect(JSON.stringify(stored.payload.toolResult)).not.toContain('sandboxName')
    })

    it('stores an empty managed Claude read as empty, never its "no output" note', async () => {
      const stored = await storeClaudeBash(claudeSuccess(`cat ${DIR}/empty.txt`, ''))

      expect(stored.description).toBe(`read_file: ${DIR}/empty.txt - 0 lines`)
      expect(stored.payload.toolResult.content).toBe('')
      expect(JSON.stringify(stored.payload)).not.toContain(NO_OUTPUT)
    })

    it('stores an empty file a read tool returned as empty', async () => {
      const stored = await storeStep({
        toolName: 'batshit_server_read_file',
        toolArgs: { filePath: `${DIR}/empty.txt` },
        toolResult: { content: '', filePath: `${DIR}/empty.txt` },
        toolCallId: 'read_empty_1',
        timestamp: '2026-09-18T08:00:00.000Z'
      })

      expect(stored.payload.toolResult.content).toBe('')
      expect(stored.description).toBe(`read_file: ${DIR}/empty.txt - 0 lines`)
    })
  })

  // Item 3 — the size in a description described the stored JSON payload, not the tool's output.
  describe('a description size is the tool\'s own output (item 3)', () => {
    it('counts an edit by its diff', async () => {
      const stored = await storeStep({
        toolName: 'batshit_server_edit_file',
        toolArgs: { filePath: `${DIR}/notes.md` },
        toolResult: {
          filePath: `${DIR}/notes.md`,
          diff: '--- a/notes.md\n+++ b/notes.md\n@@ -3 +3 @@\n-First line.\n+First line!'
        },
        toolCallId: 'edit_diff_1',
        timestamp: '2026-09-18T08:00:00.000Z'
      })

      expect(stored.description).toBe(`edit_file: ${DIR}/notes.md - 5 lines`)
    })

    it('counts a command that printed nothing as nothing', async () => {
      const stored = await storeCodexCommand({
        id: 'call_silent_bash',
        command: `mkdir -p ${DIR}/new`,
        output: '',
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.description).toBe(`bash: mkdir -p ${DIR}/new - exit 0 - 0 lines`)
    })

    it('counts a search by its matching lines', async () => {
      const stored = await storeCodexCommand({
        id: 'call_search_match',
        command: `rg -n First ${DIR}`,
        output: `${DIR}/notes.md:3:First line.\n`,
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.description).toBe('search_files: "First" - 1 line')
      expect(stored.payload.toolResult.totalMatches).toBe(1)
    })
  })

  // Item 4 — Codex reports a native patch's targets as a list of objects, and a delete or rename
  // was rendered as an Edit File card whose "diff" was the JSON of that list.
  describe('a Codex delete or rename is a command, not an edit (item 4)', () => {
    it.each([
      {
        label: 'a delete',
        changes: [{ path: `${DIR}/old.md`, kind: 'delete' as const }],
        command: `rm ${DIR}/old.md`
      },
      {
        label: 'a rename',
        changes: [{ path: `${DIR}/a.md`, kind: 'rename' as any, to: `${DIR}/b.md` } as any],
        command: `mv ${DIR}/a.md ${DIR}/b.md`
      }
    ])('stores $label as its command', async ({ changes, command }) => {
      const stored = await storeCodexPatch({ id: 'patch_change', changes, status: 'completed' })

      expect(stored.payload.operationKind).toBe('bash')
      expect(stored.payload.toolResult.command).toBe(command)
      expect(stored.description).toBe(`bash: ${command} - 0 lines`)
      expect(JSON.stringify(stored.payload)).not.toContain('"kind"')
      expect(stored.aiView).toContain(`Command: ${command}`)
    })

    it('keeps a Codex update an edit', async () => {
      const stored = await storeCodexPatch({
        id: 'patch_update',
        changes: [{ path: `${DIR}/notes.md`, kind: 'update' }],
        status: 'completed'
      })

      expect(stored.payload.operationKind).toBe('edit_file')
    })
  })

  // Item 5 — Claude Code frames a failed Bash call as `Exit code N\n<output>`, and the framing
  // line and the command's own error lines were parsed as file entries.
  describe('a failed managed Claude listing has no entries it did not list (item 5)', () => {
    it('stores a failed `ls` with no entries and what it printed', async () => {
      const stored = await storeClaudeBash(claudeFailure('ls /nope', 'ls: /nope: No such file or directory'))

      expect(stored.description).toBe('list_files: /nope - error - 0 entries')
      expect(stored.payload.toolResult).toMatchObject({
        files: [],
        totalItems: 0,
        exitCode: 1,
        commandOutput: 'ls: /nope: No such file or directory'
      })
      expect(stored.failed).toBe(true)
    })

    it("drops the bfs diagnostic Claude Code's `find` prints, and keeps the real entry", async () => {
      const stored = await storeClaudeBash(
        claudeFailure(
          `find ${DIR} /nope -name "*.md"`,
          `${DIR}/notes.md\nbfs: error: /nope: No such file or directory.`
        )
      )

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
      expect(JSON.stringify(stored.payload.toolResult.files)).not.toContain('bfs:')
      expect(stored.payload.toolResult.commandOutput).toContain('bfs: error:')
    })

    // Live on 2026-09-18: Claude Code reported a `find` that hit a permission error as a SUCCESS
    // (`is_error: false`, bfs's line in the output), so a failure-gated strip left it as an entry.
    it.each([
      { label: 'the managed Claude lane', lane: 'claude' as const },
      { label: 'the Codex lane', lane: 'codex' as const }
    ])('drops a listing diagnostic on $label even when the lane called it a success', async ({ lane }) => {
      const command = `find ${DIR} -name "*.md"`
      const output = `bfs: error: ${DIR}/private: Permission denied.\n${DIR}/notes.md`
      const stored =
        lane === 'claude'
          ? await storeClaudeBash(claudeSuccess(command, output))
          : await storeCodexCommand({ id: 'call_find_ok', command, output: `${output}\n`, exitCode: 0, status: 'completed' })

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
      expect(stored.payload.error).toBeUndefined()
      expect(stored.payload.toolResult).not.toHaveProperty('commandOutput')
    })

    it('never claims a failed managed Claude edit updated the file', async () => {
      const stored = await storeClaudeBash(
        claudeFailure("sed -i '' s/a/b/ /nope/x.md", 'sed: /nope/x.md: No such file or directory')
      )

      expect(stored.payload.operationKind).toBe('edit_file')
      expect(stored.payload.toolResult.diff).toBe('')
      expect(JSON.stringify(stored.payload)).not.toContain('Updated /nope/x.md')
      expect(stored.aiView).toBe(
        'Tool result: edit_file\nPath: /nope/x.md\nExit code: 1\n' +
          'Output:\n```text\nsed: /nope/x.md: No such file or directory\n```'
      )
    })
  })

  // Item 6 — `ls` of several directories heads each one's entries with `<dir>:`.
  describe('a multi-directory listing stores entries, not its headers (item 6)', () => {
    const OUTPUT = `${DIR}:\nnotes.md\nout.txt\n\n/tmp/other:\nb.md\n`
    const ENTRIES = [`${DIR}/notes.md`, `${DIR}/out.txt`, '/tmp/other/b.md']

    it('stores each entry under the directory that listed it on the Codex lane', async () => {
      const stored = await storeCodexCommand({
        id: 'call_ls_multi',
        command: `ls ${DIR} /tmp/other`,
        output: OUTPUT,
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.description).toBe(`list_files: ${DIR} - 3 entries`)
      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual(ENTRIES)
    })

    it('stores the same entries on the API lane', async () => {
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_api_ls_multi', command: `ls ${DIR} /tmp/other`, stdout: OUTPUT, exitCode: 0 }, sessionId)
      )

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual(ENTRIES)
    })

    it('stores the same entries on the managed Claude lane', async () => {
      const stored = await storeClaudeBash(claudeSuccess(`ls ${DIR} /tmp/other`, OUTPUT.trimEnd()))

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual(ENTRIES)
    })

    it('keeps the entries a partly failed multi-directory listing did list', async () => {
      const stored = await storeCodexCommand({
        id: 'call_ls_multi_partial',
        command: `ls ${DIR} /nope`,
        output: `ls: /nope: No such file or directory\n${DIR}:\nnotes.md\nout.txt\n`,
        exitCode: 1,
        status: 'failed'
      })

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual([
        `${DIR}/notes.md`,
        `${DIR}/out.txt`
      ])
      expect(stored.metadata.zipDescriptionStatus).toBe('exit 1')
    })

    it('leaves a lone listing bare, even when a file is named like a header', async () => {
      const stored = await storeCodexCommand({
        id: 'call_ls_colon',
        command: `ls ${DIR}`,
        output: 'weird:\nnotes.md\n',
        exitCode: 0,
        status: 'completed'
      })

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual(['weird:', 'notes.md'])
    })
  })

  // fp65g (2026-09-18) — a failed search kept only its exit code, and the API lane keeps a
  // command's error text in `stderr`, so `grep zzz /nope` was stored with an empty output and
  // neither the card nor the agent could see why it failed.
  describe('a failed search keeps what it printed (fp65g)', () => {
    const GREP_MISSING = 'grep: /nope: No such file or directory'
    const MATCH = `${DIR}/notes.md:3:First line.`

    it('keeps an API search error as its command output, and the AI view shows it', async () => {
      const stored = await storeStep(
        apiShellStep(
          { id: 'toolu_api_search_missing', command: 'grep -rn zzz /nope', stderr: `${GREP_MISSING}\n`, exitCode: 2 },
          sessionId
        )
      )

      expect(stored.description).toBe('search_files: "zzz" - error - 0 lines')
      expect(stored.payload.toolResult).toEqual({
        query: 'zzz',
        output: '',
        stdout: '',
        truncated: false,
        exitCode: 2,
        commandOutput: GREP_MISSING
      })
      expect(stored.aiView).toContain(`"commandOutput": "${GREP_MISSING}"`)
      expect(stored.failed).toBe(true)
    })

    it('keeps the error of an API search that failed after it matched', async () => {
      const stored = await storeStep(
        apiShellStep(
          {
            id: 'toolu_api_search_partial',
            command: `grep -rn First ${DIR} /nope`,
            stdout: `${MATCH}\n`,
            stderr: `${GREP_MISSING}\n`,
            exitCode: 2
          },
          sessionId
        )
      )

      expect(stored.payload.toolResult.results.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
      expect(stored.payload.toolResult.exitCode).toBe(2)
      expect(stored.payload.toolResult.commandOutput).toBe(`${MATCH}\n${GREP_MISSING}`)
    })

    it('keeps the error line after the matches on the lanes that merge their streams', async () => {
      const codex = await storeCodexCommand({
        id: 'call_search_partial',
        command: `grep -rn First ${DIR} /nope`,
        output: `${MATCH}\n${GREP_MISSING}\n`,
        exitCode: 2,
        status: 'failed'
      })
      const claude = await storeClaudeBash(claudeFailure(`grep -rn First ${DIR} /nope`, `${MATCH}\n${GREP_MISSING}`, 2))

      for (const stored of [codex, claude]) {
        expect(stored.payload.toolResult.results.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
        expect(stored.payload.toolResult.commandOutput).toBe(`${MATCH}\n${GREP_MISSING}`)
      }
    })

    it('stores an error those lanes already stored as the output only once', async () => {
      const codex = await storeCodexCommand({
        id: 'call_search_missing',
        command: 'grep -rn zzz /nope',
        output: `${GREP_MISSING}\n`,
        exitCode: 2,
        status: 'failed'
      })
      const claude = await storeClaudeBash(claudeFailure('grep -rn zzz /nope', GREP_MISSING, 2))

      for (const stored of [codex, claude]) {
        expect(stored.payload.toolResult).toEqual({
          query: 'zzz',
          output: GREP_MISSING,
          stdout: GREP_MISSING,
          truncated: false,
          exitCode: 2
        })
      }
    })

    it('never stores a files-only search error line as a matching file', async () => {
      const codex = await storeCodexCommand({
        id: 'call_search_files_only_missing',
        command: 'grep -rl zzz /nope',
        output: `${GREP_MISSING}\n`,
        exitCode: 2,
        status: 'failed'
      })
      const claude = await storeClaudeBash(claudeFailure('grep -rl zzz /nope', GREP_MISSING, 2))
      const api = await storeStep(
        apiShellStep(
          { id: 'toolu_api_files_only_missing', command: 'grep -rl zzz /nope', stderr: `${GREP_MISSING}\n`, exitCode: 2 },
          sessionId
        )
      )

      for (const stored of [codex, claude]) {
        expect(stored.payload.toolResult).not.toHaveProperty('results')
        expect(stored.payload.toolResult.output).toBe(GREP_MISSING)
      }
      expect(api.payload.toolResult).not.toHaveProperty('results')
      expect(api.payload.toolResult.commandOutput).toBe(GREP_MISSING)
    })

    it('keeps the files a files-only search found before it failed, and not its error line', async () => {
      const stored = await storeCodexCommand({
        id: 'call_search_files_only_partial',
        command: `grep -rl First ${DIR} /nope`,
        output: `${DIR}/notes.md\n${GREP_MISSING}\n`,
        exitCode: 2,
        status: 'failed'
      })

      expect(stored.description).toBe('search_files: "First" - exit 2 - 1 line')
      expect(stored.payload.toolResult.results.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
      expect(stored.payload.toolResult.commandOutput).toBe(`${DIR}/notes.md\n${GREP_MISSING}`)
    })

    it('keeps a search that matched nothing exactly as before', async () => {
      const api = await storeStep(apiShellStep({ id: 'toolu_api_search_none', command: `grep -rn zzz ${DIR}`, exitCode: 1 }, sessionId))
      const codex = await storeCodexCommand({
        id: 'call_search_none',
        command: `grep -rn zzz ${DIR}`,
        output: '',
        exitCode: 1,
        status: 'failed'
      })

      for (const stored of [api, codex]) {
        expect(stored.payload.toolResult).toEqual({ query: 'zzz', output: '', stdout: '', truncated: false })
        expect(stored.failed).toBe(false)
      }
    })

    it('keeps nothing a search that never ran did not print', async () => {
      const step = apiShellStep({ id: 'toolu_api_search_blocked', command: `grep -rn zzz ${DIR}`, exitCode: 0 }, sessionId)
      const stored = await storeStep({
        ...step,
        toolResult: {
          success: false,
          blocked: true,
          reason: 'Blocked by Agent mode policy.',
          input: step.toolResult.input,
          mappedToolName: step.toolResult.mappedToolName,
          mappedReason: step.toolResult.mappedReason
        }
      })

      expect(stored.payload.toolResult).toEqual({ query: 'zzz', output: '', stdout: '', truncated: false })
      expect(stored.payload.error).toBe('Blocked by Agent mode policy.')
    })
  })

  // Bug sweep item 4 (2026-09-18): Claude Code refuses some commands before they run and answers
  // with `is_error` and its own words, no `Exit code N` (the texts below are its real ones). Those
  // words were stored as the command's output: a List Files entry, a read's content, a command's
  // stdout. The API lane stores its own refusal (a blocked command) as a failure with no output, and
  // the Claude lane now stores its refusal the same way.
  describe('a command Claude Code refused is stored like a command the API lane refused (item 4)', () => {
    function apiRefused(command: string, reason: string) {
      const step = apiShellStep({ id: 'toolu_api_refused', command, exitCode: 0 }, sessionId)
      return {
        ...step,
        toolResult: {
          success: false,
          blocked: true,
          reason,
          input: step.toolResult.input,
          mappedToolName: step.toolResult.mappedToolName,
          mappedReason: step.toolResult.mappedReason
        }
      }
    }
    // The API lane's refusal says it was a policy block; Claude's words say what they say.
    const withoutBlocked = (value: Record<string, any>) => {
      const { blocked: _blocked, ...rest } = value
      return rest
    }

    it.each([
      {
        lane: 'list_files',
        command: 'ls -la /usr/bin',
        text: "ls in '/usr/bin' was blocked. For security, Claude Code may only list files in the allowed working directories for this session: '/Users/example/hello'.",
        description: 'list_files: /usr/bin - error - 0 entries'
      },
      {
        lane: 'read_file',
        command: 'cat /Users/example/other/empty.txt',
        text: "cat in '/Users/example/other/empty.txt' was blocked. For security, Claude Code may only concatenate files from the allowed working directories for this session: '/Users/example/hello'.",
        description: 'read_file: /Users/example/other/empty.txt - error - 0 lines'
      },
      {
        lane: 'read_file',
        command: 'cat /Users/example/hello/big.txt; exit 3',
        text: 'This Bash command contains multiple operations. The following part requires approval: exit 3',
        description: 'read_file: /Users/example/hello/big.txt - error - 0 lines'
      },
      {
        lane: 'search_files',
        command: 'grep -rn zzz /Users/example/other',
        text: "grep in '/Users/example/other' was blocked. For security, Claude Code may only search for patterns in files from the allowed working directories for this session: '/Users/example/hello'.",
        description: 'search_files: "zzz" - error - 0 lines'
      },
      {
        lane: 'edit_file',
        command: "sed -i.bak 's/abc/xyz/' /Users/example/hello/copy.txt && cat /Users/example/hello/copy.txt",
        text: 'sed command requires approval (contains potentially dangerous operations)',
        description: 'edit_file: /Users/example/hello/copy.txt - error - 0 lines'
      },
      {
        // A write whose content the command line does not show, so only the refusal could fill it.
        lane: 'write_file',
        command: `node gen.js > ${DIR}/out.txt`,
        text: 'This command requires approval',
        description: `write_file: ${DIR}/out.txt - error - 0 lines`
      }
    ])('stores a refused $lane with no output, as the API lane stores its own', async ({ lane, command, text, description }) => {
      const claude = await storeClaudeBash({ command, isError: true, content: text, toolUseResult: `Error: ${text}` })
      const api = await storeStep(apiRefused(command, `Error: ${text}`))

      expect(claude.payload.operationKind).toBe(lane)
      expect(withoutBlocked(claude.payload.toolResult)).toEqual(withoutBlocked(api.payload.toolResult))
      expect(claude.description).toBe(api.description)
      expect(claude.description).toBe(description)
      expect(claude.payload.error).toBe(`Error: ${text}`)
      expect(JSON.stringify(claude.payload.toolResult)).not.toContain(text)
      expect(claude.failed).toBe(true)
    })

    it('stores a refused plain command with the reason as stderr and no exit code (F-P5-1)', async () => {
      const reason =
        'Blocked: sleep 45 followed by: npm test. To wait for a condition, use Monitor with an until-loop.'
      const command = 'sleep 45; npm test'
      const claude = await storeClaudeBash({
        command,
        isError: true,
        content: `<tool_use_error>${reason}</tool_use_error>`,
        toolUseResult: `Error: ${reason}`
      })
      const api = await storeStep(apiRefused(command, `Error: ${reason}`))

      expect(claude.payload.operationKind).toBe('bash')
      expect(claude.payload.toolResult).toMatchObject({ stdout: '', stderr: `Error: ${reason}`, command })
      expect(claude.payload.toolResult).not.toHaveProperty('exitCode')
      expect(claude.payload.toolResult).toEqual(api.payload.toolResult)
      expect(claude.description).toBe(api.description)
      expect(claude.aiView).not.toContain('Exit code')
      expect(claude.failed).toBe(true)
    })
  })

  // Bug sweep, item 4's sibling (2026-09-18): Claude Code's own file tools fail with `is_error` and
  // their own words (the real texts, with the home path replaced). The words were stored as the file:
  // a failed Read's content, and a failed Edit claimed `Updated <path>`. Each is now stored the way
  // batshit-server's own file tools store a failure (`builtInService.js`: `{ success: false, error }`).
  describe("a failed call of Claude Code's own file tool is stored as a failure (item 4's sibling)", () => {
    const PATH = `${DIR}/notes.md`

    async function storeClaudeTool(name: string, input: Record<string, any>, blockText: string, text: string) {
      const adapter = new ClaudeEventAdapter({ request, transport: 'cli' })
      const chunk = await toolResultChunk(adapter, [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_file_tool', name, input }] } },
        {
          type: 'user',
          tool_use_result: `Error: ${text}`,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_file_tool', content: blockText, is_error: true }]
          }
        }
      ])
      return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
    }

    function storeServerFailure(toolName: string, tool: string, args: Record<string, any>, error: string) {
      return storeStep({
        toolName,
        toolArgs: args,
        toolResult: { success: false, tool, error, filePath: args.filePath },
        toolCallId: 'server_file_tool',
        timestamp: '2026-09-18T08:00:00.000Z'
      })
    }

    it.each([
      'File does not exist. Note: your current working directory is /Users/example/batshit.',
      'File content (38059 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.'
    ])('stores a failed Read with no content, as a failed server read: %s', async (text) => {
      const claude = await storeClaudeTool('Read', { file_path: PATH }, text, text)
      const server = await storeServerFailure('batshit_server_read_file', 'read_file', { filePath: PATH }, `Error: ${text}`)

      expect(claude.description).toBe(`read_file: ${PATH} - error - 0 lines`)
      expect(claude.payload.toolResult.content).toBe('')
      expect(claude.payload.error).toBe(`Error: ${text}`)
      expect(claude.payload.toolResult).toEqual(server.payload.toolResult)
      expect(claude.description).toBe(server.description)
      expect(claude.aiView).not.toContain(`Content:\n\`\`\`plaintext\n${text}`)
      expect(claude.failed).toBe(true)
    })

    it.each([
      'String to replace not found in file.\nString: First line.',
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
      'No changes to make: old_string and new_string are exactly the same.'
    ])('never says a failed Edit updated the file, as a failed server edit does not: %s', async (text) => {
      const claude = await storeClaudeTool(
        'Edit',
        { file_path: PATH, old_string: 'First line.', new_string: 'Last line.', replace_all: false },
        `<tool_use_error>${text}</tool_use_error>`,
        text
      )
      const server = await storeServerFailure(
        'batshit_server_edit_file',
        'edit_file',
        { filePath: PATH, oldContent: 'First line.', newContent: 'Last line.' },
        `Error: ${text}`
      )

      expect(claude.description).toBe(`edit_file: ${PATH} - error - 0 lines`)
      expect(claude.payload.toolResult.diff).toBe('')
      expect(JSON.stringify(claude.payload)).not.toContain(`Updated ${PATH}`)
      expect(claude.payload.toolResult).toEqual(server.payload.toolResult)
      expect(claude.failed).toBe(true)
    })

    it('keeps only what a failed Write meant to write, as a failed server write does', async () => {
      const text = 'File has not been read yet. Read it first before writing to it.'
      const claude = await storeClaudeTool('Write', { file_path: PATH, content: '# Notes\n' }, `<tool_use_error>${text}</tool_use_error>`, text)
      const server = await storeServerFailure('batshit_server_overwrite_file', 'write_file', { filePath: PATH, content: '# Notes\n' }, `Error: ${text}`)

      expect(claude.payload.toolResult.content).toBe('# Notes')
      expect(JSON.stringify(claude.payload.toolResult)).not.toContain(text)
      expect(claude.payload.toolResult).toEqual(server.payload.toolResult)
      expect(claude.payload.error).toBe(`Error: ${text}`)
    })

    it('stores a failed Grep with no matches', async () => {
      const stored = await storeClaudeTool('Grep', { pattern: 'zzz', path: '/nope' }, 'Path does not exist: /nope', 'Path does not exist: /nope')

      expect(stored.payload.operationKind).toBe('search_files')
      expect(stored.payload.toolResult).toEqual({ query: 'zzz', output: '', stdout: '', truncated: false })
      expect(stored.payload.error).toBe('Error: Path does not exist: /nope')
    })
  })

  // Bug sweep (2026-09-18): send-routed's argument normalizer invented `Prompt__User_Message_`, n8n's
  // Subagent message field, from any tool's own `prompt` argument, and every reader takes that field
  // for a subagent call, so Claude Code's WebFetch, CronCreate, and Agent helper (the real result
  // shapes below, their values replaced) were stored, and drawn by the client, as Subagent cards.
  // Only a real delegation is a subagent: the lane's own marking, a subagent tool's `chatInput`, or
  // n8n's own field.
  describe('only a real delegation is stored as a subagent', () => {
    async function storeClaudeCall(name: string, input: Record<string, any>, blockContent: unknown, toolUseResult: unknown) {
      const adapter = new ClaudeEventAdapter({ request, transport: 'cli' })
      const chunk = await toolResultChunk(adapter, [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_claude_call', name, input }] } },
        {
          type: 'user',
          tool_use_result: toolUseResult,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_claude_call', content: blockContent }] }
        }
      ])
      return storeStep(cliStepForZip(chunk, adapter.getToolMetadataResolver(), sessionId))
    }

    it.each([
      {
        tool: 'WebFetch',
        input: { url: 'https://www.example.com/listing', prompt: 'Return the address and the price.' },
        block: 'The server returned HTTP 403 Forbidden.',
        result: {
          bytes: 0,
          code: 403,
          codeText: 'Forbidden',
          result: 'The server returned HTTP 403 Forbidden.',
          durationMs: 292,
          url: 'https://www.example.com/listing'
        }
      },
      {
        tool: 'CronCreate',
        input: { cron: '*/15 * * * *', recurring: true, prompt: 'Run one polling cycle.' },
        block: 'Scheduled recurring job de4b0e44 (Every 15 minutes).',
        result: { id: 'de4b0e44', humanSchedule: 'Every 15 minutes', recurring: true, durable: false }
      },
      {
        // Claude Code's own delegation helper: never a Batshit Subagent (SA-111 P4).
        tool: 'Agent',
        input: { description: 'Find the tests', subagent_type: 'Explore', prompt: 'Find every test file.' },
        block: [{ type: 'text', text: 'Async agent launched successfully.' }],
        result: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'a0000000000000000',
          description: 'Find the tests',
          resolvedModel: 'claude-sonnet-5',
          prompt: 'Find every test file.',
          outputFile: '/tmp/agent-output.txt',
          canReadOutputFile: true
        }
      }
    ])('stores $tool as a generic Claude tool, never as a subagent', async ({ tool, input, block, result }) => {
      const stored = await storeClaudeCall(tool, input, block, result)

      expect(stored.payload.operationKind).toBe('unknown_tool')
      expect(stored.payload.rendererFamily).toBe('generic_tool')
      expect(stored.payload.isSubagent).not.toBe(true)
      expect(stored.payload.toolArgs).not.toHaveProperty('Prompt__User_Message_')
      expect(stored.description.startsWith('subagent:')).toBe(false)
      // The client's hydration of the stored zip picks the card: the Subagent tier comes first.
      expect(buildHydratedCoolToolStep(stored.payload).isSubagent).toBe(false)
    })

    // A tool's own `code` is not a command's exit code (the F-P6-5 rule): a WebFetch reports the
    // page's HTTP status there, and the description called a fetched page `exit 200`, which the reply
    // check read as a failed tool.
    it.each([
      { code: 200, codeText: 'OK', result: 'The page lists the price.' },
      { code: 403, codeText: 'Forbidden', result: 'The server returned HTTP 403 Forbidden.' }
    ])('never calls a fetched page\'s HTTP $code an exit code', async ({ code, codeText, result }) => {
      const url = 'https://www.example.com/listing'
      const stored = await storeClaudeCall(
        'WebFetch',
        { url, prompt: 'Return the address and the price.' },
        result,
        { bytes: 120, code, codeText, result, durationMs: 292, url }
      )

      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.description).toBe(`WebFetch: ${url} - 1 line`)
      expect(stored.failed).toBe(false)
    })

    it('still stores an API subagent call and a Claude call of a Batshit subagent as subagents', async () => {
      // vercelBrain's subagent tool: `{ chatInput, thread }`, its `kind: 'subagent'` result, and the
      // metadata its resolver stamps, as send-routed stores it.
      const args = normalizeToolArgs({ chatInput: 'Summarize the notes', thread: 'fresh' })
      const api = await storeStep({
        toolName: 'research_helper',
        originalToolName: 'research_helper',
        toolInput: args,
        toolArgs: args,
        toolResult: {
          kind: 'subagent',
          success: true,
          subagentName: 'Research Helper',
          subagentType: 'api',
          output: 'The notes say hello.',
          intermediateSteps: [],
          usage: null,
          status: 'completed',
          thread: null
        },
        toolCallId: 'api_subagent_1',
        timestamp: '2026-09-18T08:00:00.000Z',
        metadata: { sessionId },
        toolProvider: 'subagent',
        toolSource: 'mode3-workflow',
        isSubagent: true,
        subagentName: 'Research Helper',
        subagentId: 'research_helper',
        subagentType: 'api'
      })
      const claude = await storeClaudeCall(
        'mcp__batshit_gateway_cli_subagents__subagent_api_helper',
        { chatInput: 'ask the API helper' },
        'API subagent done.',
        [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              output: 'API subagent done.',
              intermediateSteps: [],
              subagentType: 'api',
              subagentId: 'api-subagent',
              subagentName: 'API Helper',
              toolSource: 'managed-api-subagent'
            })
          }
        ]
      )

      for (const stored of [api, claude]) {
        expect(stored.payload.operationKind).toBe('subagent')
        expect(stored.payload.isSubagent).toBe(true)
        expect(buildHydratedCoolToolStep(stored.payload).isSubagent).toBe(true)
      }
    })
  })

  // Bug sweep items 6, 7, and 8 (2026-09-18) through every lane that runs the shared mapper.
  describe('the mapper items on every lane (items 6, 7, 8)', () => {
    const NOTES = `${DIR}/notes.md`

    async function onEveryLane(command: string, printed: string, exitCode = 0) {
      const api = await storeStep(apiShellStep({ id: 'toolu_api_lane', command, stdout: printed, exitCode }, sessionId))
      const codex = await storeCodexCommand({
        id: 'call_lane',
        command,
        output: printed,
        exitCode,
        status: exitCode === 0 ? 'completed' : 'failed'
      })
      const claude = await storeClaudeBash(
        exitCode === 0 ? claudeSuccess(command, printed.trimEnd()) : claudeFailure(command, printed.trimEnd(), exitCode)
      )
      return { api, codex, claude }
    }

    it("stores a count of a quoted pattern as a search, not as the command 'foo' (item 6)", async () => {
      const lanes = await onEveryLane(`grep -c 'abc' ${NOTES}`, '2\n')

      for (const stored of Object.values(lanes)) {
        expect(stored.payload.operationKind).toBe('search_files')
        expect(stored.description).toBe('search_files: "abc" - 1 line')
      }
    })

    it('stores a sed read piped into grep as a read of the file sed read (item 7)', async () => {
      const lanes = await onEveryLane(`sed -n '1,5p' ${NOTES} | grep -i abc`, 'abc line one\nabc line two\n')

      for (const stored of Object.values(lanes)) {
        expect(stored.payload.operationKind).toBe('read_file')
        expect(stored.payload.toolResult.filePath).toBe(NOTES)
        expect(stored.metadata.zipDescriptionTarget).toBe(NOTES)
      }
    })

    it('keeps the path of a command remapped to a read as written (item 8)', async () => {
      const path = '/Users/Example/Hello/Notes.MD'
      const lanes = await onEveryLane(`cat ${path}; exit 3`, '# Notes\n', 3)
      const refused = await storeClaudeBash({
        command: `cat ${path}; exit 3`,
        isError: true,
        content: 'This Bash command contains multiple operations. The following part requires approval: exit 3',
        toolUseResult: 'Error: This Bash command contains multiple operations. The following part requires approval: exit 3'
      })

      for (const stored of [...Object.values(lanes), refused]) {
        expect(stored.payload.operationKind).toBe('read_file')
        expect(stored.payload.toolResult.filePath).toBe(path)
        expect(stored.description.startsWith(`read_file: ${path} - `)).toBe(true)
      }
    })
  })
})

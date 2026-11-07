/**
 * Unit Tests for Cool Tools Zip Adapter
 * Story 4.4: Cool Tools Integration with Stream-to-Zip Architecture
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { guardCutNotice } from '$lib/test-utils/guard-cut-notice'
import { adaptCoolToolsToZipSystem, hasSubagentToolSettings, getDefaultSubagentSettings, refreshedReadTranscript } from '../coolToolZipAdapter'
import { createZipFromContent } from '../zipService'
import { buildCoolToolAiContent, buildCoolToolAiContentWithSources, parseCoolToolPayload, shouldPreferRawSidecarForAiExpansion } from '$lib/utils/coolToolAiContent'
import type { AgentRow } from '$lib/types/database'
import { calculateZipActivation } from '$lib/utils/zipActivation'
import { describeToolResultFiles } from '$lib/utils/zipDeadCopies'
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
  apiShellStep
} from '$lib/test-utils/shell-command-steps'
import { isFailedToolFact } from '$lib/server/services/postTurnCheck.jev'
import { normalizeToolArgs } from '$lib/server/services/sseToolNormalization'
import { buildHydratedCoolToolStep } from '$lib/components/chat/coolToolHydration'
import {
  CLI_HELPER_STEP_CASES,
  LEGACY_CLI_HELPER_SERVER,
  renameHelperServer
} from '$lib/test-utils/cli-helper-steps'
import { CLI_HELPER_MCP_SERVER_NAME } from '$lib/utils/cliHelperToolNames'
import { API_UTILITY_CONTROL_IDS } from '$lib/utils/apiUtilityControls'

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

  describe('canonical API utility broker persistence', () => {
    const settings = {
      buffer_size_web_search: 5, zip_threshold_web_search: 61,
      buffer_size_workers: 4, zip_threshold_workers: 71,
      buffer_size_skill_read: 7, zip_threshold_skill_read: 81,
      buffer_size_subagent: 6, zip_threshold_subagent: 91
    }
    async function storeUtility(kind: keyof typeof API_UTILITY_CONTROL_IDS, args: Record<string, unknown>, raw: Record<string, unknown>, operationKind: string, extra: Record<string, unknown> = {}) {
      const target = API_UTILITY_CONTROL_IDS[kind]
      const callId = `api-utility-${kind}`
      const toolArgs = normalizeToolArgs({ ref: `batshit:${target}`, input: args }, 'native_batshit_tool_use')
      expect(toolArgs.ref).toBe(`batshit:${target}`)
      expect(toolArgs.input).toEqual(args)
      const step = { toolName: 'native_batshit_tool_use', toolSource: 'native-tool', toolProvider: 'batshit-server',
        toolCallId: callId, toolArgs,
        toolResult: { success: raw.success !== false, ref: `batshit:${target}`, family: 'batshit', target, controlId: target,
          operationKind, rendererFamily: operationKind, result: raw, ...extra } }
      const refs = await adaptCoolToolsToZipSystem([step, { ...step }], sessionId, messageId, settings, undefined, {
        reservedZipIdsByToolCallId: new Map([[callId, `zip-${kind}-reserved`]])
      })
      const calls = vi.mocked(createZipFromContent).mock.calls
      const main = calls.filter(call => call[1] === 'cool_tool')
      const sidecar = calls.filter(call => call[1] === 'tool_raw')
      expect(main).toHaveLength(1)
      expect(refs).toHaveLength(1)
      expect(refs[0].zipId).toBe(`zip-${kind}-reserved`)
      expect((main[0][5] as any).zipId).toBe(`zip-${kind}-reserved`)
      const payload = JSON.parse(main[0][0])
      expect(payload.toolCallId).toBe(callId)
      expect(payload.originalToolName).toBe('native_batshit_tool_use')
      expect(payload.operationKind).toBe(operationKind)
      expect(sidecar).toHaveLength(1)
      expect(JSON.parse(sidecar[0][0]).toolResult.result).toEqual(raw)
      expect(payload.rawSidecar.status).toBe('stored')
      const hydrated = buildHydratedCoolToolStep(payload)
      expect(hydrated.toolCallId).toBe(callId)
      expect(hydrated.rendererFamily).toBe(operationKind)
      return { payload, metadata: main[0][4] as any, hydrated }
    }

    it('retains Web Search settings, raw results and one main zip for duplicate SDK lifecycle events', async () => {
      const raw = { success: true, query: 'one', provider: 'exa', results: Array.from({ length: 12 }, (_, index) => ({
        title: `Result ${index}`, url: `https://example.test/${index}`, snippet: 'Search detail '.repeat(60)
      })) }
      const { payload, metadata } = await storeUtility('webSearch', { query: 'one', maxResults: 12, ref: 'mcp:nested-model-guess' }, raw, 'web_search')
      expect(metadata.bufferSize).toBe(5)
      expect(metadata.threshold).toBe(61)
      expect(payload.toolResult.query).toBe('one')
      expect(payload.toolResult.results).toHaveLength(8)
    })

    it('keeps failed/partial Worker siblings and usage without inventing child IDs', async () => {
      const raw = { kind: 'workers', success: true, requested: 2, completed: 0, workers: [
        { name: 'Worker 1', status: 'partial', output: 'Work so far', usage: { inputTokens: 10 }, modelId: 'saved-model', provider: 'saved-provider' },
        { name: 'Worker 2', status: 'failed', output: 'Could not start', usage: null, modelId: null, provider: null }
      ] }
      const { payload, metadata } = await storeUtility('workers', { workers: [{ task: 'one' }, { task: 'two' }] }, raw, 'workers')
      expect(metadata.bufferSize).toBe(4)
      expect(metadata.threshold).toBe(71)
      expect(payload.toolResult).toMatchObject({ kind: 'workers', requested: 2, completed: 0 })
      expect(payload.toolResult.workers.map((worker: any) => worker.status)).toEqual(['partial', 'failed'])
      expect(payload.toolResult.workers[0].usage).toEqual({ inputTokens: 10 })
      expect(payload.toolResult.workers.every((worker: any) => !Object.hasOwn(worker, 'id'))).toBe(true)
    })

    it('ignores retired Skill Read settings while keeping partial-read continuation through storage and hydration', async () => {
      const raw = { success: true, action: 'read', skillId: 'notes', skillName: 'Notes', path: 'references/one.md',
        content: 'A reference line\n'.repeat(100), offset: 100, nextOffset: 1800, readMore: 'Read the next window.' }
      const { payload, metadata, hydrated } = await storeUtility('skill', { skillId: 'notes', action: 'read', path: 'references/one.md', offset: 100 }, raw, 'skill_read')
      expect(metadata.bufferSize).toBe(0)
      expect(metadata.threshold).toBe(0)
      expect(payload.toolArgs.skillId).toBe('notes')
      expect(hydrated.toolResult.content).toContain('A reference line')
    })

    it('BL-2250: projects valid-shaped saved raw API Skill text with a structured current continuation and unchanged source bytes', async () => {
      const literal = 'Documentation example: call native_skill again with old fields.\n'
      const content = (literal + 'x\n'.repeat(30_000)).slice(0, 30_000)
      const raw = { success: true, action: 'read', skillId: 'notes', skillName: 'Notes', path: 'references/one.md',
        content, offset: 100, returnedChars: 30_000, originalChars: 100_000, nextOffset: 30_100,
        contentTruncated: true, readMore: 'Retired pointer: call native_skill again with old fields.', warnings: ['Keep this reference warning.'] }
      const originalRaw = JSON.stringify(raw)
      const { payload } = await storeUtility('skill', { skillId: 'notes', action: 'read', path: 'references/one.md', offset: 100, maxChars: 30_000 }, raw, 'skill_read')
      expect(shouldPreferRawSidecarForAiExpansion(payload)).toBe(true)
      const call = vi.mocked(createZipFromContent).mock.calls.find(call => call[1] === 'tool_raw')!
      const savedBytes = call[0]
      const saved = parseCoolToolPayload(savedBytes)!
      expect(saved).toMatchObject({ originalToolName: 'native_batshit_tool_use', toolProvider: 'batshit-server', toolSource: 'native-tool' })
      const expansion = buildCoolToolAiContentWithSources(payload.rawSidecar.zipId, { content: savedBytes }, saved)
      expect(expansion.text).toContain(content)
      expect(expansion.text).toContain('Showing characters 101 to 30,100 of 100,000.')
      expect(expansion.text).toContain('call native_batshit_tool_use with ref "batshit:sys.skill.use" and input {"skillId":"notes","action":"read","path":"references/one.md","offset":30100}')
      expect(expansion.text).toContain('Keep this reference warning.')
      expect(expansion.text).not.toContain('Retired pointer:')
      expect(expansion.parts.filter(part => part.source === 'tool_result').map(part => part.text).join('')).toContain(content)
      expect(JSON.stringify(raw)).toBe(originalRaw)
      expect(JSON.stringify(saved)).toBe(savedBytes)
      expect(saved.toolResult.result.readMore).toBe(raw.readMore)
      expect(saved.toolResult.result).toMatchObject({ contentTruncated: true, offset: 100, returnedChars: 30_000, originalChars: 100_000, nextOffset: 30_100 })
      const foreign = { ...saved, toolProvider: 'mcp', toolSource: 'mcp-gateway' }
      const generic = buildCoolToolAiContent('foreign', { content: JSON.stringify(foreign) }, foreign)
      expect(generic).toContain('Result:\n```json')
      expect(generic).not.toContain('To read on, call native_batshit_tool_use')
      const direct = { ...saved, toolName: 'native_skill', originalToolName: 'native_skill',
        toolArgs: { skillId: 'notes', action: 'read', path: 'references/one.md' }, toolResult: raw }
      expect(buildCoolToolAiContent('direct', { content: JSON.stringify(direct) }, direct)).toContain(raw.readMore)
    })

    it('BL-2250: an uncut partial Skill window still selects saved RAW and preserves its current continuation and warnings', async () => {
      const content = 'Short reference: native_skill is a literal example.\n'
      const raw = { success: true, action: 'read', skillId: 'notes', skillName: 'Notes', path: 'references/one.md',
        content, offset: 0, returnedChars: content.length, originalChars: 1000, nextOffset: content.length,
        contentTruncated: true, readMore: 'Retired short pointer: call native_skill again.', warnings: ['Short window warning.'] }
      const { payload } = await storeUtility('skill', { skillId: 'notes', action: 'read', path: 'references/one.md' }, raw, 'skill_read')
      expect(payload.storage.truncated).toBe(false)
      expect(payload.toolResult.contentTruncated).toBe(false)
      expect(shouldPreferRawSidecarForAiExpansion(payload)).toBe(true)
      const bytes = vi.mocked(createZipFromContent).mock.calls.find(call => call[1] === 'tool_raw')![0]
      const saved = parseCoolToolPayload(bytes)!
      const view = buildCoolToolAiContent('short-raw', { content: bytes }, saved)
      expect(view).toContain(content)
      expect(view).toContain(`"offset":${content.length}`)
      expect(view).toContain('call native_batshit_tool_use with ref "batshit:sys.skill.use"')
      expect(view).toContain('Short window warning.')
      expect(view).not.toContain('Retired short pointer:')
      expect(JSON.stringify(saved)).toBe(bytes)
    })

    it('BL-2250: an uncut invoked Skill selects saved RAW so reference facts and warnings survive history projection', async () => {
      const raw = { success: true, action: 'invoke', skill: { id: 'notes', name: 'Notes', references: ['references/one.md'], scripts: ['scripts/one.sh'] },
        skillMarkdown: '# Notes\nLiteral native_skill examples stay intact.', warnings: ['Invoke warning.'] }
      const { payload } = await storeUtility('skill', { skillId: 'notes', action: 'invoke' }, raw, 'skill_read')
      expect(payload.storage.truncated).toBe(false)
      expect(shouldPreferRawSidecarForAiExpansion(payload)).toBe(true)
      const bytes = vi.mocked(createZipFromContent).mock.calls.find(call => call[1] === 'tool_raw')![0]
      const view = buildCoolToolAiContent('invoke-raw', { content: bytes }, parseCoolToolPayload(bytes))
      expect(view).toContain(raw.skillMarkdown)
      expect(view).toContain('references/one.md')
      expect(view).toContain('scripts/one.sh')
      expect(view).toContain('Invoke warning.')
      expect(view).not.toContain('"family": "batshit"')
    })

    it.each(['partial', 'failed'] as const)('retains captured Subagent identity, nested tools, thread and %s outcome rather than the model selector', async status => {
      const steps = [{ toolCallId: 'child-tool', toolName: 'read_file', toolResult: { content: 'Nested result' } }]
      const raw = { kind: 'subagent', success: status !== 'failed', status, thread: 'resumed', output: 'Work so far',
        usage: { inputTokens: 10, outputTokens: 4 }, subagentName: 'Saved Helper', subagentType: 'api', intermediateSteps: steps }
      const { payload, metadata, hydrated } = await storeUtility('subagent', { subagentId: 'model-guess', chatInput: 'one', thread: 'resume' }, raw,
        'subagent', { isSubagent: true, subagentId: 'saved-child', subagentName: 'Saved Helper', subagentType: 'api' })
      expect(metadata.bufferSize).toBe(6)
      expect(metadata.threshold).toBe(91)
      expect(payload.subagentId).toBe('saved-child')
      expect(hydrated.subagentId).toBe('saved-child')
      expect(payload.toolResult).toMatchObject({ status, thread: 'resumed', usage: { inputTokens: 10, outputTokens: 4 } })
      expect(payload.toolResult.intermediateSteps).toEqual(steps)
    })
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

    // F-P4-7 (2026-09-17): the managed Codex lane nested the helper call under `arguments`.
    // Step shape captured from the SA-120 P4 live proof, where this search WAS zipped. SA-139 R1
    // removed that lane; a saved step of this shape (an old chat's history) is handled the same.
    it('skips zip creation for saved managed Codex helper memory steps (ref under `arguments`)', async () => {
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

    it('coerces non-string content safely for saved Codex outputs (history)', async () => {
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

    it('stores a saved managed Codex direct-helper zip fetch as fetch_zip (history)', async () => {
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

    it.each([
      ['mcp.batshit_helpers.batshit_server_bash_execute', { command: 'cat oversized.txt' }, 'bash'],
      ['mcp.batshit_helpers.batshit_server_cli_tool_use', { toolId: 'cli-reader' }, 'cli_tool']
    ])('BL-666 keeps a guarded command view in its saved %s card', async (toolName, toolArgs, operationKind) => {
      const modelText = `Command output\nstatus: exitCode=0\nstdout:\n${'A'.repeat(7_000)}\n${guardCutNotice(7_042, 'raw-1')}`
      await adaptCoolToolsToZipSystem([{
        toolName, toolArgs, toolResult: { content: [{ type: 'text', text: modelText }], structured_content: null }, toolProvider: 'mcp'
      }], sessionId, messageId, {})
      const main = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      expect(main).toBeDefined()
      const card = JSON.parse(main![0] as string)
      const metadata = main![4] as Record<string, any>
      expect(card.operationKind).toBe(operationKind)
      expect(card.toolResult.content).toBe(modelText)
      expect(card.rendererFamily).toBe('generic_tool')
      expect(card.toolResult.modelTextOnly).toBe(true)
      expect(card.toolResult.exitCode).toBeUndefined()
      expect(metadata.promptTokens).toBeGreaterThanOrEqual(Math.ceil(modelText.length / 4))
      expect(metadata.aiChars).toBeGreaterThan(modelText.length)
      expect(card.rawSidecar?.zipId).not.toBe('raw-1')
    })

    // BL-677: a first part with no line end filled the old 100,000-character ceiling, so its
    // saved card was itself 25,000 tokens and no Off row or Hold could ever keep it open.
    it('keeps a real guard cut of one long line under the too-large size, so Off keeps it open', async () => {
      const { formatToolModelTextCut } = await import('$lib/utils/toolModelTextSizeGuard')
      const modelText = formatToolModelTextCut('Z'.repeat(400_000), 'tool_raw_bl677').text
      await adaptCoolToolsToZipSystem([{
        toolName: 'mcp.batshit_helpers.batshit_server_bash_execute', toolArgs: { command: 'cat one-line.txt' },
        toolResult: { content: [{ type: 'text', text: modelText }], structured_content: null }, toolProvider: 'mcp'
      }], sessionId, messageId, {})
      const main = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const content = main![0] as string
      const metadata = main![4] as Record<string, any>
      expect(JSON.parse(content).toolResult).toMatchObject({ content: modelText, modelTextOnly: true })
      expect(metadata.promptTokens).toBeGreaterThanOrEqual(10_000)
      expect(metadata.promptTokens).toBeLessThan(25_000)
      const zipData = { type: 'cool_tool', content, tokens: metadata.tokens, metadata }
      // Without Off it is a large result (compressed at once); Off keeps it open, which a
      // too-large result never allows.
      expect(calculateZipActivation({ zipType: 'cool_tool', messagesFromEnd: 0, zipData, agentSettings: {} }))
        .toMatchObject({ shouldCompress: true, sizeGuard: 'large' })
      const off = calculateZipActivation({
        zipType: 'cool_tool', messagesFromEnd: 0, zipData,
        agentSettings: { zip_disabled_execute_command: true }
      })
      expect(off.shouldCompress).toBe(false)
      expect(off.sizeGuard).not.toBe('too_large')
    })

    // BL-678: the cut notice's words inside an ordinary MCP text (a doc that quotes one, a search
    // of Batshit's code) made the adapter and the card treat the result as a guard cut.
    it('stores a saved Codex MCP text that quotes the cut notice mid-text like any other text (history)', async () => {
      const store = async (text: string) => {
        vi.mocked(createZipFromContent).mockClear()
        await adaptCoolToolsToZipSystem([{
          toolName: 'mcp.docs_search.search', toolArgs: { query: 'Output cut here' },
          toolResult: { content: [{ type: 'text', text }], structured_content: null }, toolProvider: 'mcp'
        }], sessionId, messageId, {})
        const main = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
        return JSON.parse(main![0] as string)
      }
      const plain = await store('match 1: size guard notes\nmatch 2: the line after it\n')
      const quoted = await store(`match 1: size guard notes\n${guardCutNotice(4_000)}\nmatch 2: the line after it\n`)
      expect(quoted.rendererFamily).toBe(plain.rendererFamily)
      expect(quoted.operationKind).toBe(plain.operationKind)
      expect(Object.keys(quoted.toolResult).sort()).toEqual(Object.keys(plain.toolResult).sort())
      expect(quoted.toolResult).not.toHaveProperty('modelTextOnly')
    })

    it('does not treat an oversized tool-printed cut phrase as authority to discard raw output', async () => {
      const text = `${'A'.repeat(65_000)}UNIQUE_MIDDLE_SENTINEL${'B'.repeat(65_000)}[Output cut here by Batshit: tool printed this phrase.]`
      await adaptCoolToolsToZipSystem([{
        toolName: 'mcp.batshit_helpers.batshit_server_bash_execute', toolArgs: { command: 'cat large.txt' },
        toolResult: [{ type: 'text', text }], toolProvider: 'mcp'
      }], sessionId, messageId, {})
      const main = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const raw = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'tool_raw')
      expect(JSON.parse(main![0] as string).toolResult.modelTextOnly).not.toBe(true)
      expect(raw![0]).toContain('UNIQUE_MIDDLE_SENTINEL')
      expect(raw![0]).toContain('tool printed this phrase')
    })

    it('BL-666 saves a Claude MCP cut as visible text and stamps its model-facing size', async () => {
      const modelText = `${'{"success":true,"content":"'}${'A'.repeat(99_920)}\n[Output cut here by Batshit; fetch the next page.]`
      await adaptCoolToolsToZipSystem([{
        toolName: `mcp.batshit_helpers.batshit_server_fetch_zip`,
        toolArgs: { zipId: FETCHED_ZIP_ID },
        toolResult: [{ type: 'text', text: modelText }],
        toolProvider: 'mcp'
      }], sessionId, messageId, {})

      const main = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      expect(main).toBeDefined()
      const card = JSON.parse(main![0] as string)
      const metadata = main![4] as Record<string, any>
      expect(card.toolResult).toMatchObject({ content: modelText, contentLength: modelText.length })
      expect(card.toolResult).not.toHaveProperty('found')
      expect(metadata.promptTokens).toBeGreaterThanOrEqual(Math.ceil(modelText.length / 4))
      expect(metadata.promptTokens).toBeGreaterThanOrEqual(25_000)
      expect(card.storage.forceCompress).toBe(true)
      expect(main![0]).not.toContain('LATER_SOURCE_PAGE_SENTINEL')
    })

    it('BL-666 keeps the MCP text size when a complete Fetch Zip reply is summarized', async () => {
      const modelText = JSON.stringify({
        success: true,
        tool: 'fetch_zip',
        zipId: FETCHED_ZIP_ID,
        content: 'A'.repeat(99_000)
      })
      await adaptCoolToolsToZipSystem([{
        toolName: 'mcp.batshit_helpers.batshit_server_fetch_zip',
        toolArgs: { zipId: FETCHED_ZIP_ID },
        toolResult: [{ type: 'text', text: modelText }],
        toolProvider: 'mcp'
      }], sessionId, messageId, {})

      const main = vi.mocked(createZipFromContent).mock.calls.find((call) => call[1] === 'cool_tool')
      const card = JSON.parse(main![0] as string)
      const metadata = main![4] as Record<string, any>
      expect(card.toolResult.found).toBe(true)
      expect(card.toolResult.content.length).toBeLessThan(modelText.length / 4)
      expect(metadata.promptTokens).toBeGreaterThanOrEqual(Math.ceil(modelText.length / 4))
      expect(metadata.tokenBasis).toBe('model_facing_mcp_text')
    })

    it.each([['sys.judge.ask', 'Ask Judge Juice'], ['sys.mcp.dynamic.find', 'Dynamic Tool Search'], ['sys.mcp.dynamic.use', 'MCP Tool']])('stores and reloads utility %s with exact display metadata', async (id, title) => {
      const step = { toolName: 'native_batshit_tool_use', toolArgs: { ref: `batshit:${id}`, input: {} }, toolResult: { success: true, family: 'batshit', target: id, result: {} } }
      await adaptCoolToolsToZipSystem([step], sessionId, messageId, { buffer_size_all_other_tools: 0, zip_threshold_all_other_tools: 0 })
      const call = vi.mocked(createZipFromContent).mock.calls.find((item) => item[1] === 'cool_tool')
      const card = JSON.parse(call![0] as string)
      expect(card).toMatchObject({ displayToolName: title, operationKind: 'fabric_use', rendererFamily: 'generic_tool' })
      expect((call as any)[4]).toMatchObject({ displayToolName: title, operationKind: 'fabric_use', rendererFamily: 'generic_tool' })
      expect(buildHydratedCoolToolStep(card)).toMatchObject({ displayToolName: title, operationKind: 'fabric_use', rendererFamily: 'generic_tool' })
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

    it('does not force-compress a small Bash transcript because its raw storage is large', async () => {
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
      expect(parsed.storage.forceCompress).toBe(false)
      expect((mainCall as any)[4].forceCompress).toBe(false)
      expect((mainCall as any)[4].promptTokens).toBeLessThan(10000)
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

// F-P6-5 (2026-09-17): on a managed CLI lane `cat` on a missing file exited 1, and the stored read
// said nothing about it (`read_file: <path> - 2 lines`, no status, the error text as the file's
// content): the read shaping kept the text and dropped the exit code. The follow-up found the same
// gap in every file action a shell command becomes (write, edit, listing, search). Each case runs
// the lane's own event adapter, or the API lane's live step, then this adapter, then the
// description zipService really writes.
// SA-139 R5: the managed Claude Code lane's cases in the F-P6-5 suites went with the Claude Code
// CLI Subagent (its event adapter was their only producer). A rule that holds on every lane now
// runs on the API lane; a rule of that lane's own output went with it.
describe('a shell command stored as a file action keeps its failure (F-P6-5)', () => {
  const sessionId = 'session-shell-read'
  const messageId = 'msg-shell-read'
  const DIR = '/tmp/batshit-example'

  beforeEach(() => {
    vi.mocked(createZipFromContent).mockClear()
  })

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

  describe('reads', () => {
    // BL-678: the ledger took the notice's words anywhere in a read for a cut, so this whole
    // read never superseded an older copy and could not be held.
    it('stores an API `cat` of a file that quotes the cut notice as a whole read', async () => {
      const quoted = `# Size guard\n${guardCutNotice(4_000)}\nThat line is quoted from the guard.\n`
      const stored = await storeStep(apiShellStep({ id: 'toolu_quoted_notice_cat', command: PRESENT_FILE_COMMAND, stdout: quoted, exitCode: 0 }))
      expect(stored.payload.toolResult.content).toBe(quoted.trimEnd())
      expect(describeToolResultFiles({ operationKind: stored.metadata.operationKind, payload: stored.payload }, { projectPath: DIR }))
        .toEqual({ kind: 'read', files: new Map([['notes.md', 'whole']]) })
    })

    // The API lane's empty stdout once made the read's "content" the whole native bash result:
    // 31 lines of JSON with `success`, `stderr`, and the sandbox name.
    it('stores what an API read that failed printed, never the whole result', async () => {
      const stored = await storeStep(apiFailedReadStep())
      const printed = `cat: can't open '${MISSING_FILE_PATH}': No such file or directory`

      expect(stored.description).toBe(`read_file: ${MISSING_FILE_PATH} - error - 1 line`)
      // fp65h: the native result names no reason, so the failure gives its exit code.
      expect(stored.payload.error).toBe('The command failed with exit code 1.')
      expect(stored.payload.toolResult).toMatchObject({ content: printed, exitCode: 1 })
      expect(stored.payload.toolResult.content).not.toContain('sandboxName')
      expect(stored.aiView).toBe(
        `Tool result: read_file\nPath: ${MISSING_FILE_PATH}\nExit code: 1\nLines: 1\nChars/bytes: 77\n` +
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
      expect(stored.description).toBe(`read_file: ${PRESENT_FILE_PATH} - 4 lines`)
    })
  })

  describe('writes, edits, and patches', () => {
    it('never stores what a failed write printed as the content it wrote', async () => {
      const stored = await storeStep(apiShellStep({
        id: 'toolu_failed_generated_write',
        command: 'node gen.js > /nope/dir/out.txt',
        stderr: 'zsh: no such file or directory: /nope/dir/out.txt\n',
        exitCode: 1
      }))

      expect(stored.payload.operationKind).toBe('write_file')
      expect(stored.payload.toolResult.content).toBe('')
      expect(stored.payload.toolResult.commandOutput).toBe('zsh: no such file or directory: /nope/dir/out.txt')
    })

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
    it('keeps the real entries of a `find` that hit an error, and drops its error lines', async () => {
      const stored = await storeStep(apiShellStep({
        id: 'toolu_partial_find',
        command: `find ${DIR} -name "*.md"`,
        stdout: `${DIR}/notes.md\n`,
        stderr: `find: ${DIR}/private: Permission denied\n`,
        exitCode: 1
      }))

      expect(stored.description).toBe(`list_files: ${DIR} - error - 1 entry`)
      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
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

/**
 * The defects F-P6-5 and its follow-up found in passing, fixed here over the same real path:
 * the lane adapter, send-routed's live zip step, `adaptCoolToolsToZipSystem`, the real
 * description builder, the AI view, and the reply check's reading of the stored status.
 */
describe('the F-P6-5 follow-up found-in-passing defects', () => {
  const sessionId = 'session-shell-followup'
  const messageId = 'msg-shell-followup'
  const DIR = '/tmp/batshit-example'

  beforeEach(() => {
    vi.mocked(createZipFromContent).mockClear()
  })

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

  /** One API native bash call that printed `stdout` and `stderr` and exited `exitCode`. */
  function storeApiCommand(options: { command: string; stdout?: string; stderr?: string; exitCode: number }) {
    return storeStep(apiShellStep({ id: 'toolu_api_followup', ...options }, sessionId))
  }

  // Item 1 — the API lane's native bash calls every non-zero exit a failure, so a search that
  // matched nothing was stored as an error and the reply check counted it as a failed tool.
  describe('a search that matched nothing is an answer on every lane (item 1)', () => {
    it.each([
      { label: 'a search', command: `rg zzz ${DIR}`, kind: 'search_files' },
      { label: 'a grep', command: `grep -rn zzz ${DIR}`, kind: 'search_files' },
      { label: 'an `rg --files` listing', command: 'rg --files /tmp/empty-dir', kind: 'list_files' },
      { label: 'a read piped into a search', command: `cat ${DIR}/notes.md | grep zzz`, kind: 'search_files' }
    ])('stores $label with no match as a success on the API lane', async ({ command, kind }) => {
      const stored = await storeStep(apiShellStep({ id: 'toolu_api_no_match', command, exitCode: 1 }, sessionId))

      expect(stored.payload.operationKind).toBe(kind)
      expect(stored.payload.error).toBeUndefined()
      expect(stored.metadata).not.toHaveProperty('zipDescriptionStatus')
      expect(stored.failed).toBe(false)
    })

    it('still stores a real search error as a failure', async () => {
      const api = await storeStep(
        apiShellStep(
          { id: 'toolu_api_search_error', command: 'rg zzz /nope', stderr: 'rg: /nope: No such file\n', exitCode: 2 },
          sessionId
        )
      )

      expect(api.metadata.zipDescriptionStatus).toBe('error')
      expect(api.failed).toBe(true)
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
    it('stores an empty API read as empty, not as 31 lines of JSON', async () => {
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_api_empty_read', command: `cat ${DIR}/empty.txt`, exitCode: 0 }, sessionId)
      )

      expect(stored.description).toBe(`read_file: ${DIR}/empty.txt - 0 lines`)
      expect(stored.payload.toolResult.content).toBe('')
      expect(JSON.stringify(stored.payload.toolResult)).not.toContain('sandboxName')
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
      const stored = await storeApiCommand({ command: `mkdir -p ${DIR}/new`, exitCode: 0 })

      expect(stored.description).toBe(`bash: mkdir -p ${DIR}/new - exit 0 - 0 lines`)
    })

    it('counts a search by its matching lines', async () => {
      const stored = await storeApiCommand({ command: `rg -n First ${DIR}`, stdout: `${DIR}/notes.md:3:First line.\n`, exitCode: 0 })

      expect(stored.description).toBe('search_files: "First" - 1 line')
      expect(stored.payload.toolResult.totalMatches).toBe(1)
    })
  })

  // Item 5 — a failed listing or edit has no entries or change it did not make. (The managed
  // Claude lane's own framing, `Exit code N\n<output>`, and the bfs diagnostics of its `find` went
  // with that lane in SA-139 R5.)
  describe('a failed listing has no entries it did not list (item 5)', () => {
    it('stores a failed `ls` with no entries and what it printed', async () => {
      const stored = await storeApiCommand({ command: 'ls /nope', stderr: 'ls: /nope: No such file or directory\n', exitCode: 1 })

      expect(stored.description).toBe('list_files: /nope - error - 0 entries')
      expect(stored.payload.toolResult).toMatchObject({
        files: [],
        totalItems: 0,
        exitCode: 1,
        commandOutput: 'ls: /nope: No such file or directory'
      })
      expect(stored.failed).toBe(true)
    })

    it('never claims a failed edit updated the file', async () => {
      const stored = await storeApiCommand({ command: "sed -i '' s/a/b/ /nope/x.md", stderr: 'sed: /nope/x.md: No such file or directory\n', exitCode: 1 })

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

    it('stores each entry under the directory that listed it on the API lane', async () => {
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_api_ls_multi', command: `ls ${DIR} /tmp/other`, stdout: OUTPUT, exitCode: 0 }, sessionId)
      )

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual(ENTRIES)
    })

    it('keeps the entries a partly failed multi-directory listing did list', async () => {
      const stored = await storeApiCommand({
        command: `ls ${DIR} /nope`,
        stdout: `${DIR}:\nnotes.md\nout.txt\n`,
        stderr: 'ls: /nope: No such file or directory\n',
        exitCode: 1
      })

      expect(stored.payload.toolResult.files.map((entry: any) => entry.path)).toEqual([
        `${DIR}/notes.md`,
        `${DIR}/out.txt`
      ])
      expect(stored.metadata.zipDescriptionStatus).toBe('error')
    })

    it('leaves a lone listing bare, even when a file is named like a header', async () => {
      const stored = await storeApiCommand({ command: `ls ${DIR}`, stdout: 'weird:\nnotes.md\n', exitCode: 0 })

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

    it('never stores a files-only search error line as a matching file', async () => {
      const api = await storeStep(
        apiShellStep(
          { id: 'toolu_api_files_only_missing', command: 'grep -rl zzz /nope', stderr: `${GREP_MISSING}\n`, exitCode: 2 },
          sessionId
        )
      )

      expect(api.payload.toolResult).not.toHaveProperty('results')
      expect(api.payload.toolResult.commandOutput).toBe(GREP_MISSING)
    })

    it('keeps the files a files-only search found before it failed, and not its error line', async () => {
      const stored = await storeApiCommand({
        command: `grep -rl First ${DIR} /nope`,
        stdout: `${DIR}/notes.md\n`,
        stderr: `${GREP_MISSING}\n`,
        exitCode: 2
      })

      expect(stored.description).toBe('search_files: "First" - error - 1 line')
      expect(stored.payload.toolResult.results.map((entry: any) => entry.path)).toEqual([`${DIR}/notes.md`])
      expect(stored.payload.toolResult.commandOutput).toBe(`${DIR}/notes.md\n${GREP_MISSING}`)
    })

    it('keeps a search that matched nothing exactly as before', async () => {
      const api = await storeStep(apiShellStep({ id: 'toolu_api_search_none', command: `grep -rn zzz ${DIR}`, exitCode: 1 }, sessionId))

      expect(api.payload.toolResult).toEqual({ query: 'zzz', output: '', stdout: '', truncated: false })
      expect(api.failed).toBe(false)
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

  // Bug sweep item 4 (2026-09-18): a refused command's words were stored as its output: a List
  // Files entry, a read's content, a command's stdout. The API lane stores its own refusal (a
  // blocked command) as a failure with no output. (The managed Claude lane, whose Claude Code
  // refusals were stored the same way, went in SA-139 R5; the refusal texts below are its real ones.)
  describe('a refused command is stored as a failure with no output (item 4)', () => {
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
    ])('stores a refused $lane with no output', async ({ lane, command, text, description }) => {
      const api = await storeStep(apiRefused(command, `Error: ${text}`))

      expect(api.payload.operationKind).toBe(lane)
      expect(api.description).toBe(description)
      expect(api.payload.error).toBe(`Error: ${text}`)
      expect(JSON.stringify(api.payload.toolResult)).not.toContain(text)
      expect(api.failed).toBe(true)
    })

    it('stores a refused plain command with the reason as stderr and no exit code (F-P5-1)', async () => {
      const reason =
        'Blocked: sleep 45 followed by: npm test. To wait for a condition, use Monitor with an until-loop.'
      const command = 'sleep 45; npm test'
      const api = await storeStep(apiRefused(command, `Error: ${reason}`))

      expect(api.payload.operationKind).toBe('bash')
      expect(api.payload.toolResult).toMatchObject({ stdout: '', stderr: `Error: ${reason}`, command })
      expect(api.payload.toolResult).not.toHaveProperty('exitCode')
      expect(api.aiView).not.toContain('Exit code')
      expect(api.failed).toBe(true)
    })
  })

  // Bug sweep, item 4's sibling (2026-09-18): a failed file tool's words were stored as the file: a
  // failed Read's content, and a failed Edit claimed `Updated <path>`. A failure is stored the way
  // batshit-server's own file tools store one (`builtInService.js`: `{ success: false, error }`).
  // (Claude Code's own file tools, which the managed Claude lane stored the same way, went with
  // that lane in SA-139 R5; the failure texts below are theirs.)
  describe("a failed file tool call is stored as a failure (item 4's sibling)", () => {
    const PATH = `${DIR}/notes.md`

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
    ])('stores a failed server read with no content: %s', async (text) => {
      const server = await storeServerFailure('batshit_server_read_file', 'read_file', { filePath: PATH }, `Error: ${text}`)

      expect(server.description).toBe(`read_file: ${PATH} - error - 0 lines`)
      expect(server.payload.toolResult.content).toBe('')
      expect(server.payload.error).toBe(`Error: ${text}`)
      expect(server.aiView).not.toContain(`Content:\n\`\`\`plaintext\n${text}`)
      expect(server.failed).toBe(true)
    })

    it.each([
      'String to replace not found in file.\nString: First line.',
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
      'No changes to make: old_string and new_string are exactly the same.'
    ])('never says a failed server edit updated the file: %s', async (text) => {
      const server = await storeServerFailure(
        'batshit_server_edit_file',
        'edit_file',
        { filePath: PATH, oldContent: 'First line.', newContent: 'Last line.' },
        `Error: ${text}`
      )

      expect(server.description).toBe(`edit_file: ${PATH} - error - 0 lines`)
      expect(server.payload.toolResult.diff).toBe('')
      expect(JSON.stringify(server.payload)).not.toContain(`Updated ${PATH}`)
      expect(server.failed).toBe(true)
    })

    it('keeps only what a failed server write meant to write', async () => {
      const text = 'File has not been read yet. Read it first before writing to it.'
      const server = await storeServerFailure('batshit_server_overwrite_file', 'write_file', { filePath: PATH, content: '# Notes\n' }, `Error: ${text}`)

      expect(server.payload.toolResult.content).toBe('# Notes')
      expect(JSON.stringify(server.payload.toolResult)).not.toContain(text)
      expect(server.payload.error).toBe(`Error: ${text}`)
    })
  })

  // Bug sweep (2026-09-18): send-routed's argument normalizer invented `Prompt__User_Message_`, n8n's
  // Subagent message field, from any tool's own `prompt` argument, and every reader takes that field
  // for a subagent call. Only a real delegation is a subagent: the lane's own marking, a subagent
  // tool's `chatInput`, or n8n's own field. (The managed Claude lane's cases, Claude Code's own
  // WebFetch, CronCreate and Agent helper, went with that lane in SA-139 R5.)
  describe('only a real delegation is stored as a subagent', () => {
    it('stores a tool whose own argument is named prompt as that tool, never as a subagent', async () => {
      const args = normalizeToolArgs({ url: 'https://www.example.com/listing', prompt: 'Return the address and the price.' })
      const stored = await storeStep({
        toolName: 'mcp__web__fetch_page',
        originalToolName: 'mcp__web__fetch_page',
        toolInput: args,
        toolArgs: args,
        toolResult: { content: 'The page lists the price.' },
        toolCallId: 'mcp_fetch_1',
        timestamp: '2026-09-18T08:00:00.000Z'
      })

      expect(stored.payload.isSubagent).not.toBe(true)
      expect(stored.payload.toolArgs).not.toHaveProperty('Prompt__User_Message_')
      expect(stored.description.startsWith('subagent:')).toBe(false)
      // The client's hydration of the stored zip picks the card: the Subagent tier comes first.
      expect(buildHydratedCoolToolStep(stored.payload).isSubagent).toBe(false)
    })

    it('still stores an API subagent call as a subagent', async () => {
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
      expect(api.payload.operationKind).toBe('subagent')
      expect(api.payload.isSubagent).toBe(true)
      expect(buildHydratedCoolToolStep(api.payload).isSubagent).toBe(true)
    })
  })

  // Bug sweep items 6, 7, and 8 (2026-09-18) through every lane that runs the shared mapper (since
  // SA-139 R5, the API lane: the managed Claude lane went).
  describe('the mapper items on every lane (items 6, 7, 8)', () => {
    const NOTES = `${DIR}/notes.md`

    async function onEveryLane(command: string, printed: string, exitCode = 0) {
      const api = await storeStep(apiShellStep({ id: 'toolu_api_lane', command, stdout: printed, exitCode }, sessionId))
      return { api }
    }

    it("stores a count of a quoted pattern as a search, not as the command 'foo' (item 6)", async () => {
      const lanes = await onEveryLane(`grep -c 'abc' ${NOTES}`, '2\n')

      for (const stored of Object.values(lanes)) {
        expect(stored.payload.operationKind).toBe('search_files')
        expect(stored.description).toBe('search_files: "abc" - 1 line')
      }
    })

    // BL-2037: its output is search findings, so every lane stores it as a search of that file.
    it('stores a sed read piped into grep as a search of the file sed read (item 7, BL-2037)', async () => {
      const lanes = await onEveryLane(`sed -n '1,5p' ${NOTES} | grep -i abc`, 'abc line one\nabc line two\n')

      for (const stored of Object.values(lanes)) {
        expect(stored.payload.operationKind).toBe('search_files')
        expect(stored.description).toBe(`search_files: ${NOTES} - 2 lines`)
        expect(stored.metadata.zipDescriptionTarget).toBe(NOTES)
      }
    })

    // Item 8 kept a remapped read's path as written. BL-233 took the remap away: the mapper names
    // `cat <path>; exit 3` a command, so every lane stores it as one, a refusal included.
    it('stores a read that ends in another statement as the command the mapper names it (item 8, BL-233)', async () => {
      const path = '/Users/Example/Hello/Notes.MD'
      const lanes = await onEveryLane(`cat ${path}; exit 3`, '# Notes\n', 3)

      for (const stored of Object.values(lanes)) {
        expect(stored.payload.operationKind).toBe('bash')
        expect(stored.payload.toolResult).not.toHaveProperty('filePath')
        expect(stored.description.startsWith(`bash: cat ${path}; exit 3 - `)).toBe(true)
      }
    })
  })
})

/* -------------------------------------------------------------------------------------------- *
 * BL-5 — the helper bridge's server was renamed from `batshit_gateway_<agent>-mode4-controls` to
 * `batshit_helpers`. Through the real store path (adapter, zip description, AI view) and the
 * reload path (`buildHydratedCoolToolStep`), a step under either name must come out the same:
 * the same card, the same zip description, the same kind.
 * -------------------------------------------------------------------------------------------- */
describe('BL-5: a helper step is stored and reloaded the same under its old and new server name', () => {
  const sessionId = 'session-helper-rename'
  const messageId = 'msg-helper-rename'

  // Zip ids and stamps carry the clock; nothing else may differ. Every 13-digit millisecond
  // stamp becomes one fixed 13-digit number, so a bare number stays valid JSON.
  const withoutClock = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value)
        .replace(/\d{13}/g, '1000000000000')
        .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<iso>')
    )

  async function storeStep(step: Record<string, any>) {
    vi.mocked(createZipFromContent).mockClear()
    await adaptCoolToolsToZipSystem([step], sessionId, messageId, {
      buffer_size_all_other_tools: 0,
      zip_threshold_all_other_tools: 0
    })
    const call = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'cool_tool')
    expect(call).toBeTruthy()
    const content = (call as any)[0] as string
    const metadata = (call as any)[4]
    const payload = JSON.parse(content)
    const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
    // The stored size counts the bytes of the stored names, and the new name is shorter; the
    // tokens the agent is charged (`tokens`, `promptTokens`) must not move, and do not.
    const { storageChars: _chars, storageTokens: _tokens, ...sizeFreeMetadata } = metadata
    return withoutClock({
      payload,
      metadata: sizeFreeMetadata,
      description: generateZipDescription(content, 'cool_tool', metadata),
      aiView: buildCoolToolAiContent('zip_helper_rename', { content, metadata }, payload),
      reloaded: buildHydratedCoolToolStep(payload)
    })
  }

  for (const testCase of CLI_HELPER_STEP_CASES) {
    it(testCase.label, async () => {
      const legacy = await storeStep(testCase.build(LEGACY_CLI_HELPER_SERVER))
      const current = await storeStep(testCase.build(CLI_HELPER_MCP_SERVER_NAME))

      expect(legacy.metadata.operationKind).toBe(testCase.expectedKind)
      expect(current.metadata.operationKind).toBe(testCase.expectedKind)
      expect(current.reloaded.rendererFamily).toBe(legacy.reloaded.rendererFamily)
      expect(current.description).toBe(
        renameHelperServer(legacy.description, LEGACY_CLI_HELPER_SERVER, CLI_HELPER_MCP_SERVER_NAME)
      )
      expect(current).toEqual(
        renameHelperServer(legacy, LEGACY_CLI_HELPER_SERVER, CLI_HELPER_MCP_SERVER_NAME)
      )
    })
  }
})

/* -------------------------------------------------------------------------------------------- *
 * BL-233 — the zip lane follows the one mapping. Every lane classifies a shell command once, with
 * the shared mapper (`mapBashCommandToRendererTool`): the API lane in send-routed, Claude in its
 * adapter. `normalizeToolStep` used to classify a command the mapper called a plain
 * command a second time, by a regex over the command text, so a test run piped into `tail` and
 * followed by `node src/cli.js` was stored as a Read File of `src/cli.js`: its output saved as the
 * file's content, Read File's zip rule, and a Read File card, while the Execution Viewer and Plan
 * mode said Bash.
 * -------------------------------------------------------------------------------------------- */
// SA-139 R5: the API lane is the lane that runs the one mapping (the managed Claude lane went).
describe('BL-233: the zip lane follows the one mapping', () => {
  const sessionId = 'session-one-mapping'
  const messageId = 'msg-one-mapping'
  // The benchmark agent's own lanes: Read File keeps 8 responses, Bash 1.
  const settings = {
    buffer_size_read_file: 8,
    zip_threshold_read_file: 0,
    auto_zip_read_file: false,
    buffer_size_execute_command: 1,
    zip_threshold_execute_command: 0,
    auto_zip_execute_command: false
  }
  const TEST_RUN =
    "cd /tmp/batshit-example/habit-streaks && npm test 2>&1 | tail -12 && echo '--- CLI check ---' && node src/cli.js examples/meditate.json 2026-01-10"
  const TEST_OUTPUT = [
    '✔ a multi-day streak ending today is counted in full (0.068458ms)',
    'ℹ tests 22',
    'ℹ pass 22',
    'ℹ fail 0',
    '--- CLI check ---',
    'Meditate',
    'Current streak: 1',
    'Longest streak: 5'
  ].join('\n')

  beforeEach(() => {
    vi.mocked(createZipFromContent).mockClear()
  })

  async function storeStep(step: Record<string, any>) {
    vi.mocked(createZipFromContent).mockClear()
    await adaptCoolToolsToZipSystem([step], sessionId, messageId, settings)
    const call = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'cool_tool')
    const content = (call as any)[0] as string
    const metadata = (call as any)[4]
    const payload = JSON.parse(content)
    const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
    return {
      payload,
      metadata,
      description: generateZipDescription(content, 'cool_tool', metadata),
      reloaded: buildHydratedCoolToolStep(payload)
    }
  }

  async function onEveryLane(command: string, printed: string, exitCode = 0) {
    const api = await storeStep(apiShellStep({ id: 'toolu_one_mapping', command, stdout: printed, exitCode }, sessionId))
    return { api }
  }

  const kinds = (lanes: Record<string, { payload: any }>) =>
    Object.fromEntries(Object.entries(lanes).map(([lane, stored]) => [lane, stored.payload.operationKind]))

  it('stores a test run the mapper calls a command as Bash on every lane, not as a Read File of its script', async () => {
    const lanes = await onEveryLane(TEST_RUN, `${TEST_OUTPUT}\n`)

    expect(kinds(lanes)).toEqual({ api: 'bash' })
    expect(lanes.api.metadata.zipDescriptionStatus).toBe('exit 0')
    for (const stored of Object.values(lanes)) {
      expect(stored.payload.rendererFamily).toBe('bash')
      expect(stored.payload.toolName).toBe('bash')
      expect(stored.reloaded.rendererFamily).toBe('bash')
      // Bash's zip rule, not Read File's.
      expect(stored.metadata.bufferSize).toBe(1)
      expect(stored.payload.toolArgs).not.toHaveProperty('filePath')
      expect(stored.payload.toolResult).not.toHaveProperty('filePath')
      expect(stored.payload.toolResult).not.toHaveProperty('content')
      expect(stored.payload.toolResult.stdout).toContain('Longest streak: 5')
      expect(stored.metadata).toMatchObject({ zipDescriptionLabel: 'bash', zipDescriptionSize: '8 lines' })
      expect(stored.metadata.zipDescriptionTarget.startsWith('cd /tmp/batshit-example/habit-streaks && npm test')).toBe(true)
      expect(stored.description.startsWith('bash: cd /tmp/batshit-example/habit-streaks && npm test')).toBe(true)
    }
  })

  it('stores a command that ends in another statement as the mapper names it: a command', async () => {
    const path = '/Users/Example/Hello/Notes.MD'
    const lanes = await onEveryLane(`cat ${path}; exit 3`, '# Notes\n', 3)

    expect(kinds(lanes)).toEqual({ api: 'bash' })
    for (const stored of Object.values(lanes)) {
      expect(stored.payload.toolResult).not.toHaveProperty('filePath')
      expect(stored.description.startsWith(`bash: cat ${path}; exit 3 - `)).toBe(true)
    }
  })

  it('still stores a read the mapper maps as a read, with its path as written', async () => {
    const path = '/Users/Example/Hello/Notes.MD'
    const lanes = await onEveryLane(`cat ${path}`, '# Notes\n')

    expect(kinds(lanes)).toEqual({ api: 'read_file' })
    for (const stored of Object.values(lanes)) {
      expect(stored.payload.toolResult.filePath).toBe(path)
      expect(stored.payload.toolResult.content).toBe('# Notes')
      expect(stored.metadata.bufferSize).toBe(8)
      // A final newline ends the one line; it is not a second one (found in BL-233's proof).
      expect(stored.payload.toolResult.lineCount).toBe(1)
      expect(stored.description).toBe(`read_file: ${path} - 1 line`)
    }
  })
})

/* -------------------------------------------------------------------------------------------- *
 * BL-166 — counts that read lower than the truth. A listing's per-type counts counted only the 200
 * rows a card keeps; a command's description counted only its 220-line preview; and the API lane's
 * own cut (`truncated: true`, from the shell runner's limit or Apple Container's) was dropped by
 * the shapers, so a cut output read as whole.
 * -------------------------------------------------------------------------------------------- */
describe('BL-166: counts read what the tool produced', () => {
  const sessionId = 'session-true-counts'
  const messageId = 'msg-true-counts'
  const DIR = '/tmp/batshit-example/big'
  // The line the API lane's shell runner (`limitedOutput`, commandOutputLimit.ts) ends a cut stream with;
  // `nativeTools.test.ts` holds the real runner to it.
  const BATSHIT_CUT = (limit: number) =>
    `[Output cut here by Batshit: the command printed more than ${limit.toLocaleString('en-US')} characters.]`

  beforeEach(() => {
    vi.mocked(createZipFromContent).mockClear()
  })

  async function storeStep(step: Record<string, any>) {
    vi.mocked(createZipFromContent).mockClear()
    await adaptCoolToolsToZipSystem([step], sessionId, messageId, {})
    const call = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'cool_tool')
    const content = (call as any)[0] as string
    const metadata = (call as any)[4]
    const payload = JSON.parse(content)
    const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
    return {
      payload,
      metadata,
      description: generateZipDescription(content, 'cool_tool', metadata),
      aiView: buildCoolToolAiContent('zip_true_counts', { content, metadata }, payload)
    }
  }

  const longLsLine = (kind: 'd' | '-', name: string) =>
    `${kind}rw-r--r--  1 josh  staff  96 Sep 25 10:00 ${name}`

  it('counts a listing of more than 200 entries by type over every entry, not the 200 it keeps', async () => {
    const lines = [
      'total 1000',
      ...Array.from({ length: 250 }, (_, i) => longLsLine('-', `a-file-${String(i).padStart(3, '0')}.txt`)),
      ...Array.from({ length: 250 }, (_, i) => longLsLine('d', `z-dir-${String(i).padStart(3, '0')}`))
    ]
    const stored = await storeStep(
      apiShellStep({ id: 'toolu_big_listing', command: `ls -la ${DIR}`, stdout: `${lines.join('\n')}\n`, exitCode: 0 }, sessionId)
    )

    expect(stored.payload.operationKind).toBe('list_files')
    expect(stored.payload.toolResult.files).toHaveLength(200)
    expect(stored.payload.toolResult).toMatchObject({ totalItems: 500, totalFiles: 250, totalDirectories: 250 })
    expect(stored.description).toBe(`list_files: ${DIR} - 500 entries`)
  })

  it("sizes a command's description by what it printed, not by its 220-line preview", async () => {
    const printed = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n')
    const stored = await storeStep(
      apiShellStep({ id: 'toolu_long_output', command: 'node print-lines.js', stdout: `${printed}\n`, exitCode: 0 }, sessionId)
    )

    expect(stored.payload.operationKind).toBe('bash')
    expect(stored.payload.toolResult.stdout.split('\n')).toHaveLength(220)
    expect(stored.metadata.zipDescriptionSize).toBe('1000 lines')
  })

  // Found in BL-166's proof: the 220-line preview was never shown as a cut, so the agent read 220
  // lines as the whole output.
  it("says in the AI view that a command's preview shows only its first lines", async () => {
    const printed = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n')
    const stored = await storeStep(
      apiShellStep({ id: 'toolu_long_preview', command: 'node print-lines.js', stdout: `${printed}\n`, exitCode: 0 }, sessionId)
    )

    expect(stored.aiView).toContain('Output shown: the first 220 of 1,000 lines.')
  })

  it('says in the AI view that a listing of more than 200 entries lists only the first 200', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `file-${String(i).padStart(3, '0')}.txt`)
    const stored = await storeStep(
      apiShellStep({ id: 'toolu_long_listing_ai', command: `ls -1 ${DIR}`, stdout: `${names.join('\n')}\n`, exitCode: 0 }, sessionId)
    )

    expect(stored.aiView).toContain('Items: 300 (the first 200 are listed)')
  })

  it('keeps a short command exactly as before (no new field)', async () => {
    const stored = await storeStep(
      apiShellStep({ id: 'toolu_short_output', command: 'node print-lines.js', stdout: 'one\ntwo\n', exitCode: 0 }, sessionId)
    )

    expect(stored.payload.toolResult).not.toHaveProperty('totalLines')
    expect(stored.payload.toolResult).not.toHaveProperty('outputCut')
    expect(stored.metadata.zipDescriptionSize).toBe('2 lines')
    expect(stored.aiView).not.toContain('Output shown')
  })

  describe("the API lane's own cut", () => {
    const LIMIT = 1_000
    // What the runner kept: whole lines that fit under the limit, then its cut line.
    function cutStream(lines: string[]) {
      let kept = ''
      for (const line of lines) {
        if (kept.length + line.length + 1 > LIMIT - BATSHIT_CUT(LIMIT).length) break
        kept += `${line}\n`
      }
      return { kept, text: `${kept}${BATSHIT_CUT(LIMIT)}` }
    }

    it('stores a cut command as its first lines, says it was cut, and keeps no cut line in its output', async () => {
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`)
      const { kept, text } = cutStream(lines)
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_cut_command', command: 'node print-lines.js', stdout: text, exitCode: 0, truncated: true }, sessionId)
      )
      const keptLines = kept.trimEnd().split('\n').length

      expect(stored.payload.operationKind).toBe('bash')
      expect(stored.payload.toolResult.outputCut).toEqual({ by: 'Batshit', keptBytes: Buffer.byteLength(kept) })
      expect(stored.payload.toolResult.stdout).not.toContain('Output cut here')
      expect(stored.metadata.zipDescriptionSize).toBe(`first ${keptLines} lines`)
      expect(stored.aiView).toContain(`Batshit cut this output: only the first ${Buffer.byteLength(kept).toLocaleString('en-US')} bytes kept.`)
    })

    it('stores a cut listing as its first entries, with no entry made of the cut line', async () => {
      const names = Array.from({ length: 300 }, (_, i) => `file-${String(i).padStart(3, '0')}.txt`)
      const { kept, text } = cutStream(names)
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_cut_listing', command: `ls -1 ${DIR}`, stdout: text, exitCode: 0, truncated: true }, sessionId)
      )
      const keptEntries = kept.trimEnd().split('\n').length

      expect(stored.payload.operationKind).toBe('list_files')
      expect(stored.payload.toolResult.outputCut).toMatchObject({ by: 'Batshit' })
      expect(JSON.stringify(stored.payload.toolResult.files)).not.toContain('Output cut here')
      expect(stored.description).toBe(`list_files: ${DIR} - first ${keptEntries} entries`)
    })

    it("reads Apple Container's own cut the same way, keeping only whole lines", async () => {
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`)
      const full = `${lines.join('\n')}\n`
      // `truncateOutput` (appleContainerSandbox.ts): the first N characters, then a line naming the rest.
      const appleCut = `${full.slice(0, LIMIT)}\n...[truncated ${full.length - LIMIT} chars]`
      const wholeLines = full.slice(0, full.slice(0, LIMIT).lastIndexOf('\n') + 1)
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_apple_cut', command: 'node print-lines.js', stdout: appleCut, exitCode: 0, truncated: true }, sessionId)
      )

      expect(stored.payload.toolResult.stdout).toBe(wholeLines.trimEnd())
      expect(stored.payload.toolResult.outputCut).toEqual({ by: 'Batshit', keptBytes: Buffer.byteLength(wholeLines) })
      expect(stored.metadata.zipDescriptionSize).toBe(`first ${wholeLines.trimEnd().split('\n').length} lines`)
    })

    it('keeps the cut line in a cut read, where it tells the reader where the file stops', async () => {
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`)
      const { text } = cutStream(lines)
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_cut_read', command: `cat ${DIR}/big.log`, stdout: text, exitCode: 0, truncated: true }, sessionId)
      )

      expect(stored.payload.operationKind).toBe('read_file')
      expect(stored.payload.toolResult.content.endsWith(BATSHIT_CUT(LIMIT))).toBe(true)
    })
  })
})

/* -------------------------------------------------------------------------------------------- *
 * The independent review of BL-166 and BL-233 (2026-09-25). A cut that keeps only whole lines
 * dropped a long last line entirely; a cut line the command printed itself could fake a cut; and a
 * command step no lane had classified (batshit-server's own `execute_command`, a third-party or
 * n8n tool) was always stored as Bash.
 * -------------------------------------------------------------------------------------------- */
describe('BL-166 and BL-233 review follow-ups', () => {
  const sessionId = 'session-review-follow-ups'
  const messageId = 'msg-review-follow-ups'
  const DIR = '/tmp/batshit-example/review'
  const LIMIT = 1_000
  const BATSHIT_CUT = `[Output cut here by Batshit: the command printed more than ${LIMIT.toLocaleString('en-US')} characters.]`

  beforeEach(() => {
    vi.mocked(createZipFromContent).mockClear()
  })

  async function storeStep(step: Record<string, any>) {
    vi.mocked(createZipFromContent).mockClear()
    await adaptCoolToolsToZipSystem([step], sessionId, messageId, {})
    const call = vi.mocked(createZipFromContent).mock.calls.find((entry) => entry[1] === 'cool_tool')
    const content = (call as any)[0] as string
    const metadata = (call as any)[4]
    const payload = JSON.parse(content)
    const { generateZipDescription } = await vi.importActual<typeof import('../zipService')>('../zipService')
    return {
      payload,
      metadata,
      description: generateZipDescription(content, 'cool_tool', metadata),
      aiView: buildCoolToolAiContent('zip_review', { content, metadata }, payload)
    }
  }

  describe('a cut keeps the start of a long last line (finding 1)', () => {
    const HEADER = 'HTTP/1.1 200 OK\n'
    const LONG = 'x'.repeat(3_000)

    it("keeps the partial line the runner kept, before its cut line", async () => {
      // What the runner keeps: the header and the start of the long line, then its cut line.
      const kept = `${HEADER}${LONG}`.slice(0, LIMIT - BATSHIT_CUT.length - 1)
      const stored = await storeStep(
        apiShellStep(
          { id: 'toolu_long_line', command: 'curl -si https://example.test/api', stdout: `${kept}\n${BATSHIT_CUT}`, exitCode: 0, truncated: true },
          sessionId
        )
      )

      expect(stored.payload.toolResult.stdout).toBe(kept)
      expect(stored.payload.toolResult.outputCut).toEqual({ by: 'Batshit', keptBytes: Buffer.byteLength(`${kept}\n`) })
    })

    it("keeps Apple Container's partial line when its last newline is far behind the cut", async () => {
      const full = `${HEADER}${LONG}\n`
      const appleCut = `${full.slice(0, LIMIT)}\n...[truncated ${full.length - LIMIT} chars]`
      const stored = await storeStep(
        apiShellStep(
          { id: 'toolu_apple_long_line', command: 'curl -si https://example.test/api', stdout: appleCut, exitCode: 0, truncated: true },
          sessionId
        )
      )

      expect(stored.payload.toolResult.stdout).toBe(full.slice(0, LIMIT))
      expect(stored.payload.toolResult.outputCut).toEqual({ by: 'Batshit', keptBytes: LIMIT })
    })
  })

  describe('a cut line the command printed itself is not a cut (finding 3)', () => {
    it('leaves a run that was not cut exactly as it printed', async () => {
      const stdout = `one\n${BATSHIT_CUT}`
      const stored = await storeStep(
        apiShellStep({ id: 'toolu_forged_uncut', command: 'node print-cut-line.js', stdout, exitCode: 0 }, sessionId)
      )

      expect(stored.payload.toolResult).not.toHaveProperty('outputCut')
      expect(stored.payload.toolResult.stdout).toBe(stdout)
    })

    it("leaves a short stream alone when the run's other stream was cut", async () => {
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`)
      let kept = ''
      for (const line of lines) {
        if (kept.length + line.length + 1 > LIMIT - BATSHIT_CUT.length - 1) break
        kept += `${line}\n`
      }
      const stderr = `warning: one\n${BATSHIT_CUT}`
      const stored = await storeStep(
        apiShellStep(
          { id: 'toolu_forged_stderr', command: 'node print-lines.js', stdout: `${kept}${BATSHIT_CUT}`, stderr, exitCode: 0, truncated: true },
          sessionId
        )
      )

      expect(stored.payload.toolResult.stdout).toBe(kept.trimEnd())
      expect(stored.payload.toolResult.stderr).toBe(stderr)
      expect(stored.payload.toolResult.outputCut).toEqual({ by: 'Batshit', keptBytes: Buffer.byteLength(kept) })
    })
  })

  describe("an Apple Container cut line the command printed itself is not a cut (finding 3)", () => {
    it("leaves a short stream alone when the run's other stream was cut", async () => {
      const full = `${Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')}\n`
      const appleCut = `${full.slice(0, LIMIT)}\n...[truncated ${full.length - LIMIT} chars]`
      const stderr = 'warning: one\n...[truncated 12 chars]'
      const stored = await storeStep(
        apiShellStep(
          { id: 'toolu_forged_apple', command: 'node print-lines.js', stdout: appleCut, stderr, exitCode: 0, truncated: true },
          sessionId
        )
      )

      expect(stored.payload.toolResult.stderr).toBe(stderr)
      expect(stored.payload.toolResult.outputCut).toEqual({
        by: 'Batshit',
        keptBytes: full.slice(0, LIMIT).lastIndexOf('\n') + 1
      })
    })
  })

  // Finding 2: batshit-server's `execute_command` (builtInService.js), as an n8n workflow or
  // an MCP client calls it, never passed through a lane's mapper; the regex BL-233 removed had been
  // its only classifier, so `ls` became a Bash card. The zip write now runs the SAME mapper.
  describe('a command step no lane classified is classified by the shared mapper (finding 2)', () => {
    function batshitServerCommandStep(command: string, stdout: string) {
      return {
        toolName: 'batshit_server_execute_command',
        originalToolName: 'batshit_server_execute_command',
        toolInput: { command },
        toolArgs: { command },
        toolResult: {
          success: true,
          tool: 'execute_command',
          toolName: 'Execute Command',
          command,
          workingDir: DIR,
          exitCode: 0,
          stdout,
          stderr: '',
          toolInput: { command, workingDir: DIR, timeout: 30000, shell: true }
        },
        toolCallId: `call_unmapped_${command.length}`,
        timestamp: '2026-09-25T20:00:00.000Z',
        metadata: { sessionId }
      }
    }

    it('stores a listing as List Files', async () => {
      const stored = await storeStep(batshitServerCommandStep(`ls ${DIR}`, 'a.md\nb.md\n'))

      expect(stored.payload.operationKind).toBe('list_files')
      expect(stored.description).toBe(`list_files: ${DIR} - 2 entries`)
    })

    it('stores a read as Read File of its own path', async () => {
      const stored = await storeStep(batshitServerCommandStep(`cat ${DIR}/notes.md`, '# Notes\n'))

      expect(stored.payload.operationKind).toBe('read_file')
      expect(stored.payload.toolResult.filePath).toBe(`${DIR}/notes.md`)
    })

    it('stores a test run as Bash, as the mapper names it', async () => {
      const command = `cd ${DIR} && npm test 2>&1 | tail -12 && node src/cli.js examples/a.json`
      const stored = await storeStep(batshitServerCommandStep(command, 'ok\n'))

      expect(stored.payload.operationKind).toBe('bash')
      expect(stored.payload.toolResult).not.toHaveProperty('filePath')
    })
  })
})

/* --------------------------------------------------------------------------------------------
 * BL-1652 — a command that read several files is stored as one zip per file. The native Bash
 * result carries a split proven against the files (`readSplit`, nativeTools.ts); every read part
 * becomes a Read File of that file alone, whose command the dead-copy ledger reads, so an edit of
 * one file retires that file's copy only. A split that no longer covers stdout is ignored.
 * -------------------------------------------------------------------------------------------- */
describe('BL-1652: a read of several files is stored as one zip per file', () => {
  const sessionId = 'session-multi-read'
  const messageId = 'msg-multi-read'
  const DIR = '/tmp/batshit-example/week-calendar'
  const A = "'use strict'\nconst x = 1\nmodule.exports = { x }\n"
  const B = "const test = require('node:test')\ntest('week', () => {})\n"
  const LS = 'cli.js\nisoWeek.js\n'

  async function splitStep(command: string, stdout: string, files: Record<string, string>, id = 'toolu_multi_read_1') {
    const { planShellReadSplit, matchShellReadSplit } = await import('$lib/utils/shellReadSplit')
    const plan = planShellReadSplit(command)
    const readSplit = plan ? matchShellReadSplit(plan, stdout, new Map(Object.entries(files))) : null
    const step = apiShellStep({ id, command, stdout, exitCode: 0 })
    // Only a local run is split (the shared fixture models an Apple Container run).
    step.toolResult.backend = 'local'
    if (readSplit) step.toolResult.readSplit = readSplit
    return { step, readSplit }
  }

  async function store(steps: any[], reserved?: Record<string, string>) {
    vi.mocked(createZipFromContent).mockClear()
    const refs = await adaptCoolToolsToZipSystem(steps, sessionId, messageId, {}, undefined, reserved ? { reservedZipIdsByToolCallId: reserved } : {})
    const calls = vi.mocked(createZipFromContent).mock.calls.filter((entry) => entry[1] === 'cool_tool')
    return {
      refs,
      zips: calls.map((call: any) => ({ payload: JSON.parse(call[0]), metadata: call[4], zipId: call[5]?.zipId }))
    }
  }

  it('stores each file under its own path, label and line count, and other output as its own Bash zip', async () => {
    const command = `cd ${DIR} && cat src/isoWeek.js test/isoWeek.test.js && ls src`
    const { step, readSplit } = await splitStep(command, A + B + LS, { 'src/isoWeek.js': A, 'test/isoWeek.test.js': B })
    expect(readSplit).toBeTruthy()
    const { refs, zips } = await store([step])
    expect(refs.map((ref) => ref.reference.replace(/^\{\{batshit-zip:[^:]+:::/, ''))).toEqual([
      'read_file: src/isoWeek.js - 3 lines}}',
      'read_file: test/isoWeek.test.js - 2 lines}}',
      expect.stringMatching(/^bash: cd \/tmp\/batshit-example\/week-calendar && ls src - exit 0 - 2 lines\}\}$/)
    ])
    // Stored as a one-file read stores its content: without the final newline.
    expect(zips.map((zip) => zip.payload.toolResult.content ?? zip.payload.toolResult.stdout)).toEqual([A, B, LS].map((text) => text.replace(/\n$/, '')))
    expect(zips.map((zip) => zip.payload.toolArgs.innerCommand)).toEqual([
      `cd ${DIR} && cat src/isoWeek.js`,
      `cd ${DIR} && cat test/isoWeek.test.js`,
      `cd ${DIR} && ls src`
    ])
    expect(zips.every((zip) => zip.payload.toolCallId === 'toolu_multi_read_1')).toBe(true)
    expect(zips.map((zip) => zip.metadata.shellReadSplitPart)).toEqual([
      { index: 0, of: 3, command },
      { index: 1, of: 3, command },
      { index: 2, of: 3, command }
    ])
  })

  it('gives each read zip a file set of its own, so an edit of one file retires that copy only', async () => {
    const command = `cd ${DIR} && cat src/isoWeek.js test/isoWeek.test.js`
    const { step } = await splitStep(command, A + B, { 'src/isoWeek.js': A, 'test/isoWeek.test.js': B })
    const { zips } = await store([step])
    const files = zips.map((zip) => {
      const effect = describeToolResultFiles({ operationKind: zip.metadata.operationKind, payload: zip.payload }, { projectPath: DIR })
      return effect.kind === 'read' ? [...effect.files.entries()] : effect.kind
    })
    expect(files).toEqual([[['src/isoWeek.js', 'whole']], [['test/isoWeek.test.js', 'whole']]])

    const { findDeadCopies } = await import('$lib/utils/zipDeadCopies')
    const edit = {
      zipId: 'edit_1',
      authorId: 'agent',
      messageIndex: 2,
      operationKind: 'edit_file',
      payload: { operationKind: 'edit_file', toolArgs: { filePath: 'src/isoWeek.js' }, toolResult: { success: true, filePath: 'src/isoWeek.js' } }
    }
    const reads = zips.map((zip, at) => ({ zipId: `read_${at}`, authorId: 'agent', messageIndex: 1, operationKind: zip.metadata.operationKind, payload: zip.payload }))
    const dead = findDeadCopies([...reads, edit], { projectPath: DIR })
    expect(dead.get('read_0')?.reason).toBe('stale')
    expect(dead.has('read_1')).toBe(false)
  })

  it('keeps the first part on the reserved id and gives later parts fixed ids made from it', async () => {
    const command = `cd ${DIR} && cat src/isoWeek.js test/isoWeek.test.js`
    const { step } = await splitStep(command, A + B, { 'src/isoWeek.js': A, 'test/isoWeek.test.js': B })
    const reserved = { toolu_multi_read_1: 'cool_tool_1792345678901_ab3de' }
    const first = await store([step], reserved)
    const second = await store([step], reserved)
    expect(first.zips[0].zipId).toBe('cool_tool_1792345678901_ab3de')
    expect(first.zips[1].zipId).toMatch(/^cool_tool_1792345678901_s1[a-z0-9]{7}$/)
    expect(second.zips.map((zip) => zip.zipId)).toEqual(first.zips.map((zip) => zip.zipId))
  })

  it('drops a separators-only remainder and stores a one-file read with separators exactly as before', async () => {
    const command = `cd ${DIR} && cat src/isoWeek.js && echo --- && cat test/isoWeek.test.js`
    const { step } = await splitStep(command, `${A}---\n${B}`, { 'src/isoWeek.js': A, 'test/isoWeek.test.js': B })
    const { zips } = await store([step])
    expect(zips.map((zip) => zip.metadata.operationKind)).toEqual(['read_file', 'read_file'])

    const single = `cd ${DIR} && echo === && cat src/isoWeek.js`
    const { step: one, readSplit } = await splitStep(single, `===\n${A}`, { 'src/isoWeek.js': A })
    expect(readSplit).toBeNull()
    const stored = await store([one])
    expect(stored.zips).toHaveLength(1)
    expect(stored.zips[0].metadata.shellReadSplitPart).toBeUndefined()
  })

  it('splits only the native Bash tool\'s own local run: the same field from any other tool is data', async () => {
    const command = `cd ${DIR} && cat src/isoWeek.js test/isoWeek.test.js`
    const { step, readSplit } = await splitStep(command, A + B, { 'src/isoWeek.js': A, 'test/isoWeek.test.js': B })
    const forged = (patch: Record<string, any>) => ({ ...step, ...patch })
    // an MCP tool whose JSON answer carries stdout and a readSplit, as an object and as a string
    const mcp = forged({ toolName: 'read_file', originalToolName: 'mcp__files__read_file', toolResult: { stdout: A + B, readSplit, backend: 'local', mappedReason: 'read-command' } })
    const mcpText = forged({ toolName: 'read_file', originalToolName: 'mcp__files__read_file', toolResult: JSON.stringify({ stdout: A + B, readSplit, backend: 'local', mappedReason: 'read-command' }) })
    // a native Bash run on another backend, and a tool that only ends with the Bash tool's name
    const sandbox = forged({ toolResult: { ...step.toolResult, backend: 'docker_sandbox' } })
    const lookalike = forged({ originalToolName: 'mcp__evil__native_bash_execute' })
    const dotted = forged({ originalToolName: 'gw.native_bash_execute' })
    for (const candidate of [mcp, mcpText, sandbox, lookalike, dotted]) {
      const { zips } = await store([candidate])
      expect(zips).toHaveLength(1)
      expect(zips[0].metadata.shellReadSplitPart).toBeUndefined()
    }
    // the genuine step splits
    expect((await store([step])).zips).toHaveLength(2)
  })

  it('stores each part\'s own arguments as its input, not the whole command\'s', async () => {
    const command = `cd ${DIR} && cat src/isoWeek.js test/isoWeek.test.js`
    const { step } = await splitStep(command, A + B, { 'src/isoWeek.js': A, 'test/isoWeek.test.js': B })
    const { zips } = await store([step])
    // the whole command is kept once, as the part's provenance (`shellReadSplitPart.command`)
    const { metadata: _metadata, ...stored } = zips[1].payload
    expect(JSON.stringify(stored)).not.toContain('cat src/isoWeek.js test/isoWeek.test.js')
    expect(zips[1].payload.metadata.shellReadSplitPart.command).toBe(command)
    const sidecars = vi.mocked(createZipFromContent).mock.calls.filter((entry) => entry[1] === 'tool_raw')
    for (const sidecar of sidecars) {
      const { metadata: _sidecarMetadata, ...raw } = JSON.parse(String(sidecar[0]))
      expect(JSON.stringify(raw)).not.toContain('cat src/isoWeek.js test/isoWeek.test.js')
    }
  })

  it('stores one zip, as before, when the split no longer covers what the command printed', async () => {
    const command = `cd ${DIR} && cat src/isoWeek.js test/isoWeek.test.js`
    const { step } = await splitStep(command, A + B, { 'src/isoWeek.js': A, 'test/isoWeek.test.js': B })
    step.toolResult.stdout = `${A + B}[redacted]`
    const { zips } = await store([step])
    expect(zips).toHaveLength(1)
    expect(zips[0].metadata.shellReadSplitPart).toBeUndefined()
    expect(zips[0].payload.toolResult).not.toHaveProperty('readSplit')
  })
})

/* --------------------------------------------------------------------------------------------
 * SA-137 (D4) — a proven read becomes its zip's `fileReadSource`. The native Bash tool seals the
 * proof in this process (`fileReadProofSeal.ts`); the adapter writes the descriptor only from a
 * sealed proof that names this chat, this reply, this call and this part, and never stores the
 * proof itself. Without a proof (live file reads off) the zip is stored exactly as before.
 * -------------------------------------------------------------------------------------------- */
describe('SA-137: a proven read is stored with its fileReadSource', () => {
  const sessionId = 'session-live-read'
  const messageId = 'msg-live-read'
  const DIR = '/tmp/batshit-example/live-read'
  const A = "'use strict'\nconst x = 1\n"
  const B = 'line one\nline two\n'

  async function sealedProof(
    reads: Array<{ part: number | null; file: string; locator: string; view: any }>,
    ids: { sessionId: string; messageId: string; toolCallId: string } = { sessionId, messageId, toolCallId: 'toolu_live_read_1' },
    sandbox?: 'apple_container' | 'docker_sandbox'
  ) {
    const { sealFileReadProof } = await import('$lib/server/services/fileReadProofSeal')
    return sealFileReadProof({
      version: 1,
      userId: 'user-1',
      agentId: 'agent-1',
      ...ids,
      backend: sandbox ?? 'local',
      ...(sandbox ? { liveReadsOn: true } : {}),
      workspaceRoot: DIR,
      rootIdentity: '1:2',
      cwd: DIR,
      reads
    })
  }

  function oneFileStep(id = 'toolu_live_read_1') {
    const step = apiShellStep({ id, command: `cd ${DIR} && cat src/a.js`, stdout: A, exitCode: 0 })
    step.toolResult.backend = 'local'
    return step
  }

  async function store(steps: any[]) {
    vi.mocked(createZipFromContent).mockClear()
    await adaptCoolToolsToZipSystem(steps, sessionId, messageId, {}, undefined, {})
    return vi.mocked(createZipFromContent).mock.calls
      .filter((entry) => entry[1] === 'cool_tool')
      .map((call: any) => ({ raw: String(call[0]), payload: JSON.parse(call[0]), metadata: call[4] }))
  }

  const whole = { kind: 'whole', numbering: 'none' }

  it('stores a sealed one-file proof as the zip\'s fileReadSource, and never the proof', async () => {
    const step = oneFileStep()
    step.toolResult.fileReadProof = await sealedProof([{ part: null, file: 'src/a.js', locator: 'src/a.js', view: whole }])
    const [zip] = await store([step])
    expect(zip.metadata.fileReadSource).toEqual({
      version: 1,
      owner: { userId: 'user-1', agentId: 'agent-1', sessionId, messageId, toolCallId: 'toolu_live_read_1' },
      backend: 'local',
      workspaceRoot: DIR,
      rootIdentity: '1:2',
      cwd: DIR,
      locator: 'src/a.js',
      view: whole
    })
    expect(zip.raw).not.toContain('fileReadProof')
    expect(zip.raw).not.toContain('"seal"')
    // Neither the result zip nor its raw sidecar keeps the proof.
    for (const call of vi.mocked(createZipFromContent).mock.calls) expect(String(call[0])).not.toContain('fileReadProof')
  })

  // SA-137 Round 2 (R2-6): a Bash read inside Apple Container or Docker Sandbox is proven host-side; its
  // proof travels when it names the run's own backend, and the descriptor records that backend.
  it.each(['apple_container', 'docker_sandbox'] as const)('stores a %s run\'s sealed proof with its own backend', async (sandbox) => {
    const step = oneFileStep()
    step.toolResult.backend = sandbox
    step.toolResult.fileReadProof = await sealedProof([{ part: null, file: 'src/a.js', locator: 'src/a.js', view: whole }], undefined, sandbox)
    const [zip] = await store([step])
    expect(zip.metadata.fileReadSource).toMatchObject({ backend: sandbox, liveReadsOn: true, locator: 'src/a.js' })
    expect(zip.raw).not.toContain('fileReadProof')
    // A proof that names another backend than the run's describes nothing.
    const mismatched = oneFileStep()
    mismatched.toolResult.backend = sandbox
    mismatched.toolResult.fileReadProof = await sealedProof([{ part: null, file: 'src/a.js', locator: 'src/a.js', view: whole }])
    const [rejected] = await store([mismatched])
    expect(rejected.metadata.fileReadSource).toBeUndefined()
    // A proof the gate did not accept is not stored either.
    expect(rejected.raw).not.toContain('fileReadProof')
  })

  it('stores no descriptor from an unsealed, changed or foreign proof, or from another tool', async () => {
    const forged = oneFileStep()
    forged.toolResult.fileReadProof = { ...(await sealedProof([{ part: null, file: 'src/a.js', locator: 'src/a.js', view: whole }])), seal: 'A'.repeat(43) }
    const changed = oneFileStep()
    const sealed = await sealedProof([{ part: null, file: 'src/a.js', locator: 'src/a.js', view: whole }])
    changed.toolResult.fileReadProof = { ...sealed, reads: [{ ...sealed.reads[0], locator: '.env' }] }
    const otherReply = oneFileStep()
    otherReply.toolResult.fileReadProof = await sealedProof([{ part: null, file: 'src/a.js', locator: 'src/a.js', view: whole }], { sessionId, messageId: 'msg-other', toolCallId: 'toolu_live_read_1' })
    // A genuine proof copied onto another call (a tab replaying an SSE event) describes nothing.
    const otherCall = oneFileStep('toolu_live_read_2')
    otherCall.toolResult.fileReadProof = sealed
    const mcp = { ...oneFileStep(), originalToolName: 'mcp__files__read_file' }
    mcp.toolResult = { ...mcp.toolResult, fileReadProof: sealed }
    const otherBackend = oneFileStep()
    otherBackend.toolResult.backend = 'docker_sandbox'
    otherBackend.toolResult.fileReadProof = sealed
    for (const [label, step] of Object.entries({ forged, changed, otherReply, otherCall, mcp, otherBackend })) {
      const [zip] = await store([step])
      expect(zip.metadata.fileReadSource, label).toBeUndefined()
    }
    // The genuine native local origin never stores the proof, sealed or not.
    for (const step of [forged, changed, otherReply]) expect((await store([step]))[0].raw).not.toContain('fileReadProof')
  })

  it('gives each proven read part of a split its own descriptor, and the other output none', async () => {
    const { planShellReadSplit, matchShellReadSplit } = await import('$lib/utils/shellReadSplit')
    const command = `cd ${DIR} && cat src/a.js src/b.txt && ls src`
    const stdout = A + B + 'a.js\nb.txt\n'
    const readSplit = matchShellReadSplit(planShellReadSplit(command)!, stdout, new Map([['src/a.js', A], ['src/b.txt', B]]))!
    const step = apiShellStep({ id: 'toolu_live_split_1', command, stdout, exitCode: 0 })
    step.toolResult.backend = 'local'
    step.toolResult.readSplit = readSplit
    step.toolResult.fileReadProof = await sealedProof([
      { part: 0, file: 'src/a.js', locator: 'src/a.js', view: whole },
      { part: 1, file: 'src/b.txt', locator: 'src/b.txt', view: whole }
    ], { sessionId, messageId, toolCallId: 'toolu_live_split_1' })
    const zips = await store([step])
    expect(zips.map((zip) => zip.metadata.fileReadSource?.locator ?? null)).toEqual(['src/a.js', 'src/b.txt', null])
    expect(zips.map((zip) => zip.metadata.fileReadSource?.owner.toolCallId ?? null)).toEqual(['toolu_live_split_1', 'toolu_live_split_1', null])
    for (const zip of zips) expect(zip.raw).not.toContain('fileReadProof')
  })

  it('stores no descriptor on a part that is not a Read File, even with a valid proof', async () => {
    const step = apiShellStep({ id: 'toolu_live_ls', command: `cd ${DIR} && ls src`, stdout: 'a.js\n', exitCode: 0 })
    step.toolResult.backend = 'local'
    step.toolResult.fileReadProof = await sealedProof([{ part: null, file: 'src/a.js', locator: 'src/a.js', view: whole }],
      { sessionId, messageId, toolCallId: 'toolu_live_ls' })
    const [zip] = await store([step])
    expect(zip.metadata.operationKind).not.toBe('read_file')
    expect(zip.metadata.fileReadSource).toBeUndefined()
  })

  it('without a proof (live file reads off) stores the zip exactly as before', async () => {
    const plain = oneFileStep('toolu_live_read_off')
    const [zip] = await store([plain])
    expect(zip.metadata).not.toHaveProperty('fileReadSource')
    expect(zip.payload.toolResult).not.toHaveProperty('fileReadProof')
  })
})

/* --------------------------------------------------------------------------------------------
 * SA-137 (P2) — a refreshed copy is what a fresh read of the same output would show. The compile
 * expands a stored Read File from its payload, or from its raw sidecar when the preview was cut;
 * `refreshedReadTranscript` runs the same pipeline on the stored call with new output. With the
 * file unchanged it is byte for byte the stored copy's transcript, with the same token count.
 * -------------------------------------------------------------------------------------------- */
describe('SA-137: a refreshed Read File transcript has the stored copy\'s form', () => {
  const sessionId = 'session-refresh'
  const messageId = 'msg-refresh'

  async function storedCopy(command: string, stdout: string) {
    vi.mocked(createZipFromContent).mockClear()
    const step = apiShellStep({ id: 'toolu_refresh_1', command, stdout, exitCode: 0 })
    step.toolResult.backend = 'local'
    await adaptCoolToolsToZipSystem([step], sessionId, messageId, {}, undefined, {})
    const calls = vi.mocked(createZipFromContent).mock.calls as any[]
    const main = calls.find((call) => call[1] === 'cool_tool')
    const raw = calls.find((call) => call[1] === 'tool_raw')
    const payload = parseCoolToolPayload(main[0])!
    // What compileForAI expands: the raw sidecar's payload when the policy prefers it.
    const aiPayload = raw && shouldPreferRawSidecarForAiExpansion(payload) ? parseCoolToolPayload(raw[0])! : payload
    const compiled = buildCoolToolAiContentWithSources('zip_1', { content: main[0], metadata: main[4] }, aiPayload)
    return { payload, metadata: main[4], compiled }
  }

  const longFile = Array.from({ length: 5_000 }, (_, at) => `line ${at + 1}`).join('\n') + '\n'
  const cases: Array<[string, string]> = [
    ['cat src/a.js', 'one\ntwo\n'],
    ['cat src/a.js', 'no final newline'],
    ['cat src/a.js', 'tabs\there\t\tand there\r\ncrlf\n'],
    ['cat -n src/a.js', '     1\tone\n     2\ttwo\n'],
    ['sed -n 2,3p src/a.js', 'two\nthree\n'],
    ['head -n 1 src/a.js', 'one\n'],
    ['tail -n 2 src/a.js', 'y\nz\n'],
    ['cat src/a.js', ''],
    ['cat src/long.txt', longFile]
  ]

  it('is byte for byte the stored copy when the file is unchanged, with the same token count', async () => {
    for (const [command, stdout] of cases) {
      const stored = await storedCopy(command, stdout)
      const refreshed = refreshedReadTranscript('zip_1', stored.payload, stored.metadata, stdout)
      expect(refreshed?.text, `${command} ${JSON.stringify(stdout.slice(0, 40))}`).toBe(stored.compiled.text)
      expect(refreshed?.parts).toEqual(stored.compiled.parts)
      expect(refreshed?.promptTokens, command).toBe(stored.metadata.promptTokens)
    }
  })

  it('shows the new text in the same form when the file changed', async () => {
    const stored = await storedCopy('cat -n src/a.js', '     1\tone\n')
    const refreshed = refreshedReadTranscript('zip_1', stored.payload, stored.metadata, '     1\tone\n     2\ttwo\n     3\tthree\n')!
    const fresh = await storedCopy('cat -n src/a.js', '     1\tone\n     2\ttwo\n     3\tthree\n')
    expect(refreshed.text).toBe(fresh.compiled.text)
    expect(refreshed.text).toContain('Lines: 3')
    expect(refreshed.promptTokens).toBe(fresh.metadata.promptTokens)
  })

  it('makes no transcript for anything that is not a native Bash Read File', async () => {
    const stored = await storedCopy('cat src/a.js', 'x\n')
    expect(refreshedReadTranscript('zip_1', { ...stored.payload, operationKind: 'bash' }, stored.metadata, 'x\n')).toBeNull()
    expect(refreshedReadTranscript('zip_1', { ...stored.payload, originalToolName: 'mcp__files__read_file' }, stored.metadata, 'x\n')).toBeNull()
    expect(refreshedReadTranscript('zip_1', { ...stored.payload, toolArgs: {} }, stored.metadata, 'x\n')).toBeNull()
  })
})

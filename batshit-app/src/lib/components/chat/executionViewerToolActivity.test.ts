import { describe, expect, it } from 'vitest'
import { estimateTokens } from '$lib/utils/tokens'
import { estimateCoolToolAiTokens } from '$lib/utils/coolToolAiContent'
import { buildExecutionToolActivityEntries } from './executionViewerToolActivity'

function expectedToolTokens(step: any) {
  return estimateCoolToolAiTokens(
    String(step.toolCallId || step.id || 'execution-tool'),
    {
      content: JSON.stringify(step),
      metadata: step.metadata || {}
    },
    step
  )
}

describe('buildExecutionToolActivityEntries', () => {
  it('normalizes Mode 4 CLI steps and prefers executed tool names for display', () => {
    const step = {
      toolName:
        'mcp.batshit_gateway_clea-mode4-controls.batshit_server_cli_tool_use',
      originalToolName:
        'mcp.batshit_gateway_clea-mode4-controls.batshit_server_cli_tool_use',
      executedToolName: 'ffprobe-media-inspector',
      toolInput: {
        toolId: 'ffprobe-media-inspector',
        input: { inputFile: '/Users/example/hello' },
      },
      toolResult: { error: 'ffprobe expected a file path, not a directory.' },
      executionTime: 712,
    }

    const entries = buildExecutionToolActivityEntries({ steps: [step] })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      index: 1,
      rawToolName: 'ffprobe-media-inspector',
      displayName: 'Ffprobe Media Inspector',
      status: 'error',
      durationMs: 712,
      tokenEstimate: expectedToolTokens(step),
    })
    expect(entries[0]?.input).toEqual(step.toolInput)
    expect(entries[0]?.output).toEqual(step.toolResult)
    expect(entries[0]?.notes).toContain(
      'Original tool: mcp.batshit_gateway_clea-mode4-controls.batshit_server_cli_tool_use',
    )
  })

  it('shows broker use wrappers while preserving the executed capability name', () => {
    const step = {
      toolName: 'native_batshit_tool_use',
      originalToolName: 'native_batshit_tool_use',
      executedToolName: 'sys.artifact.update',
      toolInput: {
        ref: 'fabric:sys.artifact.update',
        input: { artifactId: 'artifact_123' },
      },
      toolResult: {
        success: true,
        ref: 'fabric:sys.artifact.update',
        family: 'fabric',
        target: 'sys.artifact.update',
        operationKind: 'fabric_use',
      },
      executionTime: 218,
    }

    const entries = buildExecutionToolActivityEntries({ steps: [step] })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      rawToolName: 'sys.artifact.update',
      displayName: 'Artifact Edit',
      status: 'success',
      durationMs: 218,
      tokenEstimate: expectedToolTokens(step),
    })
    expect(entries[0]?.input).toEqual(step.toolInput)
    expect(entries[0]?.output).toEqual(step.toolResult)
    expect(entries[0]?.notes).toContain('Original tool: native_batshit_tool_use')
  })

  it('normalizes n8n intermediateSteps observation payloads', () => {
    const step = {
      action: {
        tool: 'n8n_MCP_Trigger',
        toolCallId: 'call_123',
        toolInput: { query: 'Example Domain purpose' },
      },
      observation: { title: 'Example Domain' },
      timestamp: 1774288206023,
    }

    const entries = buildExecutionToolActivityEntries({ steps: [step] })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      rawToolName: 'n8n_MCP_Trigger',
      displayName: 'n8n MCP Trigger',
      status: 'success',
      tokenEstimate: expectedToolTokens(step),
      timestamp: 1774288206023,
    })
    expect(entries[0]?.input).toEqual({ query: 'Example Domain purpose' })
    expect(entries[0]?.output).toEqual({ title: 'Example Domain' })
  })

  it('adds partial fallback entries for provider tool calls missing from intermediateSteps', () => {
    const entries = buildExecutionToolActivityEntries({
      steps: [
        {
          toolName: 'native_web_search',
          toolInput: { query: 'Example Domain purpose' },
          toolResult: { title: 'Example Domain' },
        },
      ],
      llmCalls: [
        {
          index: 1,
          runtime: 'vercel',
          usage: {
            inputTokens: { value: 1, confidence: 'exact' },
            outputTokens: { value: 1, confidence: 'exact' },
            totalTokens: { value: 2, confidence: 'exact' },
          },
          requestPayload: {},
          requestConfidence: 'exact',
          responsePayload: {
            response: '',
            toolCalls: [
              { name: 'native_web_search', args: { query: 'Example Domain purpose' } },
              { name: 'batshit_subagent', args: { chatInput: 'Count letters in batshit' } },
            ],
          },
          responseConfidence: 'exact',
          finishReason: 'tool-calls',
          toolCallsCount: 2,
        },
      ],
    })

    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({
      rawToolName: 'batshit_subagent',
      displayName: 'Subagent',
      status: 'partial',
      tokenEstimate: estimateTokens(
        JSON.stringify({ chatInput: 'Count letters in batshit' }),
      ),
    })
    expect(entries[1]?.output).toEqual({
      note:
        'Tool call was captured in the provider trace, but no matching tool-result payload was stored in intermediateSteps for this run.',
    })
  })

  it('SA-116 DL-116-12: a broker step is named by the control it ran, not by the broker', () => {
    // A broker step is COMPACTED before it reaches a renderer: `toolArgs` becomes
    // `{ ref, target }` and the real input moves under `toolResult.input`. Every Fabric call
    // in the Execution Viewer used to read "Dynamic Tool Use", which is the broker's own
    // display name.
    // Captured from a live BSMS run on 2026-09-10 (SA-116 P2 T1): note that `toolArgs`
    // holds the ref beside the control's OWN fields, not the `{ref, target}` pair the
    // Fragility Map describes for the renderer path. A hand-written fixture using that pair
    // would pass while the real step stayed unnamed.
    const entries = buildExecutionToolActivityEntries({
      steps: [
        {
          toolCallId: 'toolu_01QmAdgoyudjLFRNzmmVhLPm',
          toolName: 'native_batshit_tool_use',
          originalToolName: 'native_batshit_tool_use',
          toolArgs: {
            ref: 'fabric:sys.memory.delete',
            memoryId: 'mem_1789030269276_h43dh2',
          },
          toolResult: {
            success: true,
            controlId: 'sys.memory.delete',
            riskLevel: 'confirm',
            ref: 'fabric:sys.memory.delete',
            target: 'sys.memory.delete',
            input: { memoryId: 'mem_1789030269276_h43dh2' },
          },
        },
      ],
      llmCalls: [],
    })

    expect(entries[0]).toMatchObject({
      rawToolName: 'native_batshit_tool_use',
      displayName: 'Memory Delete',
    })
  })

  it('SA-116: an unrecognised broker ref keeps the broker name instead of guessing', () => {
    const entries = buildExecutionToolActivityEntries({
      steps: [
        {
          toolCallId: 'toolu_x',
          toolName: 'native_batshit_tool_use',
          toolArgs: {},
        },
      ],
      llmCalls: [],
    })

    expect(entries[0]?.displayName).toBe('Dynamic Tool Use')
  })
})

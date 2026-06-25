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
})

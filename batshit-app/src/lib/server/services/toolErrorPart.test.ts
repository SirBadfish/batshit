/**
 * BL-450 — a failed tool call on the API lane, against the REAL installed `ai` package.
 *
 * The three failures the SDK reports as a `tool-error` part (a schema-refused call, a call to a
 * tool that does not exist, and an `execute` that throws, like an MCP gateway error) are produced
 * here by `streamText` itself over the SDK's own mock model, so the parts this test converts are
 * the parts send-routed's loop receives, not a hand-built guess at them.
 */
import { describe, expect, it, vi } from 'vitest'

vi.unmock('ai')

import { isStepCount, streamText, tool } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { toolStepFailureMessage } from '$lib/utils/toolResultProcessor'
import {
  stepContentReachedToolBoundary,
  toolErrorAsFailedToolResult,
  toolErrorMessage
} from './toolErrorPart'

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
}

function finish(reason: string) {
  return { type: 'finish' as const, finishReason: { unified: reason, raw: reason } as any, usage: USAGE }
}

/** One step that makes the given tool calls, then one step of text. */
function runFailingCalls(calls: Array<{ id: string; toolName: string; input: unknown }>) {
  let call = 0
  const stepContents: unknown[][] = []
  const model = new MockLanguageModelV4({
    doStream: async () => {
      call += 1
      if (call === 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            ...calls.map((entry) => ({
              type: 'tool-call' as const,
              toolCallId: entry.id,
              toolName: entry.toolName,
              input: JSON.stringify(entry.input)
            })),
            finish('tool-calls')
          ])
        }
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't' },
          { type: 'text-delta' as const, id: 't', delta: 'after the failure' },
          { type: 'text-end' as const, id: 't' },
          finish('stop')
        ])
      }
    }
  })
  const result = streamText({
    model,
    allowSystemInMessages: true,
    messages: [{ role: 'user', content: 'go' }],
    tools: {
      echo: tool({
        description: 'echo',
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }: { value: string }) => ({ echoed: value })
      }),
      mcp_gateway: tool({
        description: 'an MCP tool whose gateway fails',
        inputSchema: z.object({ q: z.string() }),
        execute: async () => {
          throw new Error('MCP gateway error: upstream server unreachable')
        }
      })
    },
    stopWhen: isStepCount(3),
    prepareStep: ({ steps }: { steps: any[] }) => {
      const previous = steps[steps.length - 1]
      if (previous) stepContents.push(previous.content ?? [])
      return undefined
    }
  })
  return { result, stepContents }
}

async function collect(result: ReturnType<typeof streamText>) {
  const parts: any[] = []
  for await (const part of result.stream) parts.push(part)
  return parts
}

describe('BL-450: a tool-error part becomes the ordinary failed tool result', () => {
  it('a schema-refused call, a missing tool, and a throwing execute each send tool-call then tool-error', async () => {
    const { result, stepContents } = runFailingCalls([
      { id: 'refused', toolName: 'echo', input: { value: 42 } },
      { id: 'missing', toolName: 'no_such_tool', input: { a: 1 } },
      { id: 'thrown', toolName: 'mcp_gateway', input: { q: 'x' } }
    ])
    const parts = await collect(result)

    const errors = parts.filter((part) => part.type === 'tool-error')
    expect(errors.map((part) => part.toolCallId).sort()).toEqual(['missing', 'refused', 'thrown'])
    // Every failed call was announced first, so its card is open and waits for an answer.
    for (const id of ['refused', 'missing', 'thrown']) {
      const callIndex = parts.findIndex((part) => part.type === 'tool-call' && part.toolCallId === id)
      const errorIndex = parts.findIndex((part) => part.type === 'tool-error' && part.toolCallId === id)
      expect(callIndex).toBeGreaterThanOrEqual(0)
      expect(errorIndex).toBeGreaterThan(callIndex)
    }
    // No tool-result is sent for any of them: the tool-error is the only answer.
    expect(parts.some((part) => part.type === 'tool-result')).toBe(false)
    // The reply goes on after the failures.
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.text).join('')).toBe(
      'after the failure'
    )

    const byId = new Map(errors.map((part) => [part.toolCallId, toolErrorAsFailedToolResult(part)]))
    const refused = byId.get('refused')!
    const missing = byId.get('missing')!
    const thrown = byId.get('thrown')!

    for (const failed of [refused, missing, thrown]) {
      expect(failed.type).toBe('tool-result')
      expect(failed.output.success).toBe(false)
      expect(failed.output.error.length).toBeGreaterThan(0)
      // The same rule every copy of a step (and the stored zip) reads: a failure, with its reason.
      expect(toolStepFailureMessage(failed.toolName, failed.input, failed.output)).toBe(failed.output.error)
    }
    expect(refused.toolName).toBe('echo')
    expect(refused.input).toEqual({ value: 42 })
    expect(refused.output.error).toMatch(/echo/)
    expect(missing.toolName).toBe('no_such_tool')
    expect(missing.output.error).toMatch(/no_such_tool/)
    expect(thrown.toolName).toBe('mcp_gateway')
    expect(thrown.input).toEqual({ q: 'x' })
    expect(thrown.output.error).toBe('MCP gateway error: upstream server unreachable')

    // The step that held only failures is a tool boundary: the model took another step after it,
    // and that is where a waiting steer belongs.
    expect(stepContents).toHaveLength(1)
    expect((stepContents[0] as any[]).some((part) => part?.type === 'tool-result')).toBe(false)
    expect(stepContentReachedToolBoundary(stepContents[0])).toBe(true)
  })

  it('keeps the tool-result boundary and refuses a step with no tool answer', () => {
    expect(stepContentReachedToolBoundary([{ type: 'tool-result' }])).toBe(true)
    expect(stepContentReachedToolBoundary([{ type: 'tool-error' }])).toBe(true)
    expect(stepContentReachedToolBoundary([{ type: 'text' }, { type: 'tool-call' }])).toBe(false)
    expect(stepContentReachedToolBoundary(undefined)).toBe(false)
  })

  it('reads a reason from every shape an error arrives in', () => {
    expect(toolErrorMessage('bad input')).toBe('bad input')
    expect(toolErrorMessage(new Error('boom'))).toBe('boom')
    expect(toolErrorMessage({ message: 'from the provider' })).toBe('from the provider')
    expect(toolErrorMessage({ code: 502 })).toBe('{"code":502}')
    expect(toolErrorMessage(undefined)).toBe('The tool call failed without an error message.')
    expect(toolErrorMessage('   ')).toBe('The tool call failed without an error message.')
  })
})

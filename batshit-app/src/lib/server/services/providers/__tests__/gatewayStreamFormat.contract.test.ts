// @vitest-environment node
/**
 * BL-1782: a Vercel AI Gateway answer whose `finish` part has the older shape, replayed from the
 * 2026-10-18 capture through the REAL `ProviderManager`, the REAL `@ai-sdk/gateway` 4.0.97 and the
 * REAL `ai` 7.0.119 `streamText`. Only the network is fake: a stubbed fetch answers with the
 * captured event stream. No Redis, no keys.
 *
 * Two halves: the model-boundary observer only logs (the stream reaches the SDK unchanged), and the
 * result-stream check both consumers share fails the step whose tool call Batshit runs got no
 * result, error or approval card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ env: {} }))
// The shared setup file fakes these; this test needs the real SDK and the real Anthropic client.
vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')

import { dynamicTool, isStepCount, streamText, tool } from 'ai'
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { ProviderManager } from '../index'
import {
  GATEWAY_STREAM_FORMAT_ERROR_CODE,
  GatewayStreamFormatError,
  createGatewayStreamFormatCheck,
  describeFinishPartShape,
  isGatewayStreamFormatStep,
  observeGatewayStreamFormat
} from '../gatewayStreamFormat'
import {
  ANTHROPIC_DIRECT_TOOL_CALL_EVENTS,
  GATEWAY_V2_FINISH_TEXT_EVENTS,
  GATEWAY_V2_FINISH_TOOL_CALL_EVENTS,
  eventStreamResponse
} from '../../__tests__/fixtures/gatewayV2FinishStreams'

const GATEWAY_BASE_URL = 'https://gateway.test/v3/ai'
const NAMED_ERROR =
  'The Vercel AI Gateway replied in a stream format this Batshit version cannot read, so the tool call test-researcher did not run; use a direct provider connection for this model.'

/** The captured tool-call answer with its `finish` in the v4 shape the client asked for. */
const GATEWAY_V4_FINISH_TOOL_CALL_EVENTS = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS.map((event) =>
  event.type === 'finish'
    ? {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 552, noCache: 552, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 68, text: 68, reasoning: 0 }
        }
      }
    : event
)

let gatewayAnswer: ReadonlyArray<Record<string, unknown>> = []
const requests: string[] = []

beforeEach(() => {
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    requests.push(url)
    if (url.startsWith(`${GATEWAY_BASE_URL}/`)) return eventStreamResponse(gatewayAnswer)
    if (url.startsWith('https://api.anthropic.com/')) return eventStreamResponse(ANTHROPIC_DIRECT_TOOL_CALL_EVENTS, { eventLines: true })
    throw new Error(`BL-1782 test: no network for ${url}`)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function manager() {
  return new ProviderManager({
    apiKeys: { anthropic: 'sk-ant-bl1782-placeholder-key' },
    gateway: { apiKey: 'bl1782-placeholder-gateway-key', baseURL: GATEWAY_BASE_URL }
  })
}

/**
 * The turn of the triage repro: one model call; the SDK still runs that call's tools. Every result
 * part goes through the shared check, as send-routed's loop and `processNativeMode` feed it.
 */
async function runTurn(
  model: unknown,
  options: { kind?: 'dynamic' | 'static'; approval?: 'user-approval' | 'approved' | 'denied' } = {}
) {
  const toolRuns: unknown[] = []
  const inputSchema = z.object({ chatInput: z.string(), thread: z.enum(['fresh', 'resume']).optional() })
  const execute = async (input: unknown) => {
    toolRuns.push(input)
    return 'The researcher says: 4'
  }
  const description = 'Ask the Researcher subagent a question.'
  const result = streamText({
    model: model as any,
    allowSystemInMessages: true,
    messages: [
      { role: 'system', content: 'For every user question you MUST call the test-researcher tool exactly once.' },
      { role: 'user', content: 'What is 2 plus 2? Answer with one number.' }
    ],
    tools: {
      'test-researcher': options.kind === 'static' ? tool({ description, inputSchema, execute }) : dynamicTool({ description, inputSchema, execute })
    },
    // The call-level policy shape `vercelBrain` hands the SDK (`NativeToolApprovalPolicy` answers
    // 'user-approval'; the SDK also takes an automatic 'approved' or 'denied').
    ...(options.approval ? { toolApproval: { 'test-researcher': async () => options.approval! } } : {}),
    stopWhen: isStepCount(1),
    maxRetries: 0,
    include: { rawChunks: true, requestBody: true },
    onError: () => {}
  })
  const check = createGatewayStreamFormatCheck()
  const parts: any[] = []
  const failures: GatewayStreamFormatError[] = []
  let thrown: unknown = null
  try {
    for await (const part of result.stream) {
      parts.push(part)
      const failure = check.observe(part)
      if (failure) failures.push(failure)
    }
  } catch (error) {
    thrown = error
  }
  // The finished steps send-routed's finish callback reads (`StepResult`: own `content`, `finishReason`).
  const steps: any[] = thrown ? [] : await result.steps
  return { parts, thrown, toolRuns, failures, steps, types: parts.filter((part) => part.type !== 'raw').map((part) => part.type) }
}

const observerLogs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((call) => String(call[0]).includes('BL-1782'))

describe('BL-1782: a Gateway tool call the installed SDK cannot run fails its step with GATEWAY_STREAM_FORMAT', () => {
  it('a call resolved to the Gateway by name (BL-266: no connection): the stream reaches the SDK unchanged, the step fails by name, the shape is logged once', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    gatewayAnswer = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS
    const { parts, thrown, toolRuns, failures, steps, types } = await runTurn(manager().getModel('claude-haiku-5-5'))

    expect(requests).toEqual([`${GATEWAY_BASE_URL}/language-model`])
    // The observer converts nothing: the SDK ends the step as it did before, with no reason and no run.
    expect(thrown).toBeNull()
    expect(toolRuns).toEqual([])
    expect(types).toContain('tool-call')
    expect(types).not.toContain('tool-result')
    expect(parts.find((part) => part.type === 'finish-step')?.finishReason).toBeUndefined()
    // The shared check names the call at that step's finish.
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(GatewayStreamFormatError)
    expect(failures[0]).toMatchObject({ code: GATEWAY_STREAM_FORMAT_ERROR_CODE, status: 502, message: NAMED_ERROR })
    // And the finished step the SDK hands its finish callback is the same failure (spread, as
    // `vercelBrain` hands it on).
    expect(steps).toHaveLength(1)
    expect(isGatewayStreamFormatStep(steps[0])).toBe(true)
    expect(isGatewayStreamFormatStep({ ...steps[0] })).toBe(true)

    const logs = observerLogs(consoleWarn)
    expect(logs).toHaveLength(1)
    expect(logs[0][1]).toEqual({
      modelId: 'claude-haiku-5-5',
      toolCalls: 1,
      finishPartShape: {
        type: 'string',
        finishReason: 'string',
        usage: { inputTokens: 'number', outputTokens: 'number', totalTokens: 'number', cachedInputTokens: 'number' },
        providerMetadata: 'object'
      }
    })
    // The line carries the model id and the number of calls; none of the finish part's own values
    // (its counts, ids, finish reason or provider metadata) is in it.
    expect(JSON.stringify(logs[0])).not.toMatch(/552|68|fixture_1782|tool-calls/)
  })

  it('a call on an explicit vercel-gateway connection fails the same way, for a plain tool() too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    gatewayAnswer = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS
    const model = manager().getModel('claude-haiku-5-5', { transport: 'vercel-gateway', service: 'vercel-gateway' })
    const { toolRuns, failures } = await runTurn(model, { kind: 'static' })

    expect(toolRuns).toEqual([])
    expect(failures.map((failure) => failure.message)).toEqual([NAMED_ERROR])
  })

  it('a Gateway call that raises an approval card is not failed: the card is the SDK\'s, before the finish', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    gatewayAnswer = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS
    const { thrown, toolRuns, failures, steps, types } = await runTurn(manager().getModel('claude-haiku-5-5'), { approval: 'user-approval' })

    expect(thrown).toBeNull()
    expect(types).toContain('tool-approval-request')
    expect(toolRuns).toEqual([])
    expect(failures).toEqual([])
    // Its finish callback must run: the card is saved there.
    expect(isGatewayStreamFormatStep(steps[0])).toBe(false)
  })

  it('an automatic approval is no card: the queued call does not run on the Gateway, and the step fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    gatewayAnswer = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS
    const { toolRuns, failures, steps, parts } = await runTurn(manager().getModel('claude-haiku-5-5'), { approval: 'approved' })

    expect(parts.find((part) => part.type === 'tool-approval-request')?.isAutomatic).toBe(true)
    expect(toolRuns).toEqual([])
    expect(failures.map((failure) => failure.message)).toEqual([NAMED_ERROR])
    expect(isGatewayStreamFormatStep(steps[0])).toBe(true)
  })

  it('an automatic denial is the call\'s outcome: nothing fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    gatewayAnswer = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS
    const { toolRuns, failures, steps, types } = await runTurn(manager().getModel('claude-haiku-5-5'), { approval: 'denied' })

    expect(types).toContain('tool-output-denied')
    expect(toolRuns).toEqual([])
    expect(failures).toEqual([])
    // Step content keeps the denial as its approval response (no `tool-output-denied` there).
    expect(steps[0].content.map((part: any) => part.type)).not.toContain('tool-output-denied')
    expect(isGatewayStreamFormatStep(steps[0])).toBe(false)
  })

  it('passes a Gateway reply of words only through unchanged: it streams and finishes, with an unreadable reason and unknown usage, as before; nothing is logged', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    gatewayAnswer = GATEWAY_V2_FINISH_TEXT_EVENTS
    const { parts, thrown, failures, steps, types } = await runTurn(manager().getModel('claude-haiku-5-5'))

    expect(thrown).toBeNull()
    expect(failures).toEqual([])
    expect(isGatewayStreamFormatStep(steps[0])).toBe(false)
    expect(types).not.toContain('error')
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.text).join('')).toBe('Two plus two is 4.')
    const finish = parts.find((part) => part.type === 'finish')
    expect(finish).toBeTruthy()
    // What the installed SDK makes of the older finish (BL-1782 owes the usage): no finish reason
    // and no token counts.
    expect(finish.finishReason).toBeUndefined()
    expect(finish.totalUsage.inputTokens).toBeUndefined()
    expect(finish.totalUsage.outputTokens).toBeUndefined()
    expect(observerLogs(consoleWarn)).toEqual([])
  })

  it('lets a Gateway tool call with a readable (v4) finish run: only the older shape fails', async () => {
    gatewayAnswer = GATEWAY_V4_FINISH_TOOL_CALL_EVENTS
    const { thrown, toolRuns, failures, steps, types } = await runTurn(manager().getModel('claude-haiku-5-5'))

    expect(thrown).toBeNull()
    expect(failures).toEqual([])
    expect(isGatewayStreamFormatStep(steps[0])).toBe(false)
    expect(toolRuns).toEqual([{ chatInput: 'What is 2 plus 2? Answer with one number.' }])
    expect(types).toContain('tool-result')
  })

  it('leaves a direct provider alone: the same turn sent to Anthropic runs its tool', async () => {
    const { thrown, toolRuns, failures, parts } = await runTurn(manager().getModel('claude-haiku-5-5', { transport: 'direct', service: 'anthropic' }))

    expect(requests).toEqual(['https://api.anthropic.com/v1/messages'])
    expect(thrown).toBeNull()
    expect(failures).toEqual([])
    expect(toolRuns).toEqual([{ chatInput: 'What is 2 plus 2? Answer with one number.' }])
    expect(parts.find((part) => part.type === 'finish')?.finishReason).toBe('tool-calls')
  })
})

describe('BL-1782 rules', () => {
  function fakeGatewayModel(parts: LanguageModelV4StreamPart[]): LanguageModelV4 {
    return {
      specificationVersion: 'v4',
      provider: 'gateway',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('not used')
      },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          }
        })
      })
    }
  }

  async function read(model: LanguageModelV4) {
    const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const seen: LanguageModelV4StreamPart[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return seen
      seen.push(value)
    }
  }

  const olderFinish = { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LanguageModelV4StreamPart

  it('the observer passes every part through unchanged and logs nothing for a tool the provider ran itself', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'tool-call', toolCallId: 'ws_1', toolName: 'web_search', input: '{}', providerExecuted: true },
      olderFinish
    ]
    expect(await read(observeGatewayStreamFormat(fakeGatewayModel(parts)))).toEqual(parts)
    expect(observerLogs(consoleWarn)).toEqual([])
  })

  it('the observer returns a model that is not specification v4 as it came', () => {
    const notV4 = { modelId: 'claude-haiku-5-5' }
    expect(observeGatewayStreamFormat(notV4)).toBe(notV4)
  })

  function check(parts: Array<Record<string, unknown>>) {
    const steps = createGatewayStreamFormatCheck()
    return parts.map((part) => steps.observe(part)).filter(Boolean).map((failure) => failure!.message)
  }

  it('names every tool call of the step that got no outcome, and only those', () => {
    expect(check([
      { type: 'start-step' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'read_file' },
      { type: 'tool-call', toolCallId: 'b', toolName: 'researcher' },
      { type: 'tool-call', toolCallId: 'c', toolName: 'native_bash_execute' },
      { type: 'tool-call', toolCallId: 'd', toolName: 'list_files' },
      { type: 'tool-call', toolCallId: 'ws', toolName: 'web_search', providerExecuted: true },
      { type: 'tool-error', toolCallId: 'd', toolName: 'list_files' },
      { type: 'tool-approval-request', approvalId: 'ap1', toolCall: { toolCallId: 'c', toolName: 'native_bash_execute' } },
      { type: 'finish-step' }
    ])).toEqual([
      'The Vercel AI Gateway replied in a stream format this Batshit version cannot read, so the tool calls read_file, researcher did not run; use a direct provider connection for this model.'
    ])
  })

  it('the step predicate reads the same rule from StepResult content', () => {
    const call = (id: string, toolName: string, extra: Record<string, unknown> = {}) => ({ type: 'tool-call', toolCallId: id, toolName, ...extra })
    const card = (id: string, isAutomatic?: boolean) => ({ type: 'tool-approval-request', approvalId: `ap_${id}`, toolCall: call(id, 'x'), ...(isAutomatic ? { isAutomatic } : {}) })
    expect(isGatewayStreamFormatStep({ finishReason: undefined, content: [call('a', 'read_file')] })).toBe(true)
    expect(isGatewayStreamFormatStep({ finishReason: 'tool-calls', content: [call('a', 'read_file')] })).toBe(false)
    expect(isGatewayStreamFormatStep({ finishReason: undefined, content: [call('a', 'read_file'), card('a')] })).toBe(false)
    expect(isGatewayStreamFormatStep({ finishReason: undefined, content: [call('a', 'read_file'), card('a', true)] })).toBe(true)
    expect(isGatewayStreamFormatStep({ finishReason: undefined, content: [
      call('a', 'read_file'), card('a', true), { type: 'tool-approval-response', approvalId: 'ap_a', approved: false, toolCall: call('a', 'x') }
    ] })).toBe(false)
    expect(isGatewayStreamFormatStep({ finishReason: undefined, content: [call('a', 'read_file'), card('a'), call('b', 'researcher')] })).toBe(true)
    expect(isGatewayStreamFormatStep({ finishReason: undefined, content: [call('ws', 'web_search', { providerExecuted: true })] })).toBe(false)
    expect(isGatewayStreamFormatStep({ finishReason: undefined, content: [{ type: 'text', text: 'Done.' }] })).toBe(false)
    expect(isGatewayStreamFormatStep({ finishReason: 'error' })).toBe(false)
    expect(isGatewayStreamFormatStep(null)).toBe(false)
  })

  it('fails nothing when the step finished with a reason, or when every call got an outcome', () => {
    expect(check([
      { type: 'start-step' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'read_file' },
      { type: 'finish-step', finishReason: 'length' }
    ])).toEqual([])
    expect(check([
      { type: 'start-step' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'read_file' },
      { type: 'tool-result', toolCallId: 'a', toolName: 'read_file' },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-delta', text: 'Done.' },
      { type: 'finish-step' }
    ])).toEqual([])
  })

  it('describes a part by field names and types only', () => {
    expect(describeFinishPartShape({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: null })).toEqual({
      type: 'string',
      finishReason: { unified: 'string', raw: 'undefined' },
      usage: 'null'
    })
    expect(describeFinishPartShape('finish')).toEqual({ part: 'string' })
  })
})

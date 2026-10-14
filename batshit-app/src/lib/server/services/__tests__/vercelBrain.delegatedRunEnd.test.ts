/**
 * How a delegated API run ENDS: Stop, the Subagent time limit, and a failed model call.
 *
 * API Subagents and Workers run through `processNativeMode` (`subagentRunner.runApiSubagent`).
 * Runs the REAL method through the REAL AI SDK loop and the REAL Anthropic provider package; only
 * the network is fake (an injected fetch serves canned provider answers and records each request).
 *
 * BL-449 (2026-09-27): the run's abort signal (the runner's, which fires on the parent's Stop and
 * on the Subagent time limit) never reached `streamText`, so a stopped or timed-out delegated run
 * went on calling the model and running tools after the parent had been answered, and a tool that
 * runs a process (`native_bash_execute` reads the SDK's `options.abortSignal`) was never told.
 *
 * BL-452 (2026-09-27): a model call that failed mid-run (a 429, an overloaded provider) reaches
 * the loop as an `error` part and the stream then closes normally, so the run returned its partial
 * words and the runner stamped it completed. A first-step failure threw only the SDK's generic
 * "No output generated". The run now throws the provider's own error after the loop, and a Stop
 * still reads as a Stop (`streamStop.ts`), never as a provider failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')

const slot = vi.hoisted(() => ({ model: null as any }))

vi.mock('$lib/server/services/providers', () => {
  const factory = () => ({
    getModel: () => slot.model,
    listAvailableModels: () => []
  })
  const ProviderManager = vi.fn(function MockProviderManager(this: Record<string, unknown>) {
    Object.assign(this, factory())
  })
  ;(ProviderManager as any).createForUser = vi.fn(async () => factory())
  return {
    ProviderManager,
    resolveProviderAccess: vi.fn().mockResolvedValue({ apiKeys: {} })
  }
})

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    getUserSettings: vi.fn().mockResolvedValue(null)
  }
}))

import { jsonSchema, tool } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { VercelAIBrain, type NativeModeRequest } from '../vercelBrain'
import { isStopError } from '../streamStop'

type Body = Record<string, any>

function sseResponse(events: Array<Record<string, any>>): Response {
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function messageStart(id: string) {
  return {
    type: 'message_start',
    message: {
      id,
      model: 'claude-sonnet-5',
      role: 'assistant',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  }
}

const turn = {
  /** A step that says a few words, then calls `work`. */
  toolCall: (n: number) =>
    sseResponse([
      messageStart(`msg_${n}`),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Partial ${n}. ` } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: `toolu_${n}`, name: 'work', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ value: `step-${n}` }) }
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ]),
  answer: () =>
    sseResponse([
      messageStart('msg_final'),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }
    ]),
  /** Anthropic's mid-stream failure: the response started (HTTP 200), then an `error` event. */
  overloadedMidStream: () =>
    sseResponse([
      messageStart('msg_overloaded'),
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
    ]),
  /** An `error` event that does NOT end the response: the provider goes on to call a tool. */
  errorThenToolCall: () =>
    sseResponse([
      messageStart('msg_error_first'),
      { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'After the error. ' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_after_error', name: 'work', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ value: 'after-error' }) }
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ]),
  /** A 429 the SDK retries at once (the provider's own retry header), then gives up on. */
  rateLimited: () =>
    new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' }
      }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } }
    ),
  /** A non-retryable HTTP failure on the request itself. */
  badRequest: () =>
    new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' }
      }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
}

const fetchSignals: AbortSignal[] = []

function scriptedFetch(bodies: Body[], script: Array<() => Response>) {
  return (async (_url: unknown, init: any) => {
    if (init?.signal) fetchSignals.push(init.signal)
    // Like the real fetch: an aborted signal rejects before anything leaves.
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
    }
    bodies.push(JSON.parse(init.body))
    const next = script[bodies.length - 1]
    if (!next) throw new Error(`unexpected request #${bodies.length}`)
    return next()
  }) as any
}

type WorkExecute = (input: { value: string }, options: { abortSignal?: AbortSignal }) => Promise<unknown>

function workTools(execute: WorkExecute) {
  return {
    tools: {
      work: tool({
        description: 'Do a piece of work.',
        inputSchema: jsonSchema<{ value: string }>({
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value']
        }),
        execute: execute as any
      })
    },
    maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
    toolApprovals: {},
    ephemeralImages: null
  }
}

async function runDelegated(options: {
  script: Array<() => Response>
  execute?: WorkExecute
  abortSignal?: AbortSignal
}): Promise<{ bodies: Body[]; outcome: Promise<Awaited<ReturnType<VercelAIBrain['processNativeMode']>>> }> {
  const bodies: Body[] = []
  slot.model = createAnthropic({ apiKey: 'test-key', fetch: scriptedFetch(bodies, options.script) })(
    'claude-sonnet-5'
  )
  const brain = new VercelAIBrain()
  ;(brain as any).buildToolsForMode3 = vi.fn(async () =>
    workTools(options.execute ?? (async ({ value }) => ({ worked: value })))
  )
  const request: NativeModeRequest = {
    model: 'claude-sonnet-5',
    connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' } as any,
    messages: [
      { role: 'system', content: 'You are a delegated probe.' },
      { role: 'user', content: 'Do the task.' }
    ],
    sessionId: 'sess-delegated',
    messageId: 'subagent-probe-1',
    userId: 'user-1',
    agentId: 'agent-1',
    maxToolRounds: 10,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {})
  }
  const outcome = brain.processNativeMode(request)
  // Keep an early rejection from surfacing as unhandled before the test awaits it.
  outcome.catch(() => undefined)
  return { bodies, outcome }
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: any }> {
  try {
    return { value: await promise }
  } catch (error) {
    return { error }
  }
}

describe('BL-449 Stop and the time limit reach a delegated API run', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('an abort during a tool ends the loop: no further model call, and the run reads as a Stop', async () => {
    const controller = new AbortController()
    let toolSignal: AbortSignal | undefined
    const { bodies, outcome } = await runDelegated({
      script: [() => turn.toolCall(1), () => turn.toolCall(2), () => turn.answer()],
      abortSignal: controller.signal,
      execute: async ({ value }, options) => {
        toolSignal = options.abortSignal
        // The parent's Stop (or the Subagent time limit) lands while the tool runs.
        controller.abort()
        return { worked: value }
      }
    })

    const result = await settle(outcome)
    expect(result.value).toBeUndefined()
    expect(isStopError(result.error, [])).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(toolSignal?.aborted).toBe(true)
  })

  it('a running tool hears the abort through the SDK options (what native_bash_execute reads)', async () => {
    const controller = new AbortController()
    let heard: 'abort' | 'timer' | null = null
    const { outcome } = await runDelegated({
      script: [() => turn.toolCall(1), () => turn.answer()],
      abortSignal: controller.signal,
      execute: (_input, options) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            heard = 'timer'
            resolve({ worked: 'ran to the end' })
          }, 1500)
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer)
            heard = 'abort'
            resolve({ stopped: true })
          })
          setTimeout(() => controller.abort(), 20)
        })
    })

    const result = await settle(outcome)
    expect(heard).toBe('abort')
    expect(isStopError(result.error, [])).toBe(true)
  })

  it('an abort before the run starts sends nothing to the provider', async () => {
    const controller = new AbortController()
    controller.abort()
    const { bodies, outcome } = await runDelegated({
      script: [() => turn.answer()],
      abortSignal: controller.signal
    })

    const result = await settle(outcome)
    expect(isStopError(result.error, [])).toBe(true)
    expect(bodies).toHaveLength(0)
  })
})

describe('BL-452 a failed model call fails the delegated run', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('a provider error after a tool step throws the provider reason instead of returning the partial words', async () => {
    const { bodies, outcome } = await runDelegated({
      script: [() => turn.toolCall(1), () => turn.overloadedMidStream()]
    })

    const result = await settle(outcome)
    expect(bodies).toHaveLength(2)
    expect(result.value).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('Overloaded')
    expect(isStopError(result.error, [])).toBe(false)
  })

  it('an error part ends the run at once: nothing after it is run, sent, or counted', async () => {
    const ran: string[] = []
    let toolSignal: AbortSignal | undefined
    const { bodies, outcome } = await runDelegated({
      script: [() => turn.errorThenToolCall(), () => turn.toolCall(2), () => turn.answer()],
      execute: async ({ value }, options) => {
        ran.push(value)
        toolSignal = options.abortSignal
        return { worked: value }
      }
    })

    const result = await settle(outcome)
    // Give an SDK loop left running in the background the time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(result.value).toBeUndefined()
    expect(result.error?.message).toContain('Internal server error')
    expect(isStopError(result.error, [])).toBe(false)
    expect(bodies).toHaveLength(1)
    expect(ran).toEqual([])
    expect(toolSignal).toBeUndefined()
    // The SDK's run is cancelled, not left suspended: the provider request's signal fired.
    expect(fetchSignals.at(-1)?.aborted).toBe(true)
  })

  it('a 429 after a tool step (retries used up) throws with the provider reason', async () => {
    const { bodies, outcome } = await runDelegated({
      script: [() => turn.toolCall(1), () => turn.rateLimited(), () => turn.rateLimited(), () => turn.rateLimited()]
    })

    const result = await settle(outcome)
    expect(bodies).toHaveLength(4)
    expect(result.value).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('per-minute rate limit')
  })

  it("a first-step failure throws the provider's reason, not the SDK's generic 'No output generated'", async () => {
    const { outcome } = await runDelegated({ script: [() => turn.badRequest()] })

    const result = await settle(outcome)
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('prompt is too long')
    expect(result.error.message).not.toContain('No output generated')
  })

  it('a clean run still returns its words', async () => {
    const { outcome } = await runDelegated({ script: [() => turn.toolCall(1), () => turn.answer()] })

    const result = await settle(outcome)
    expect(result.error).toBeUndefined()
    expect(result.value?.content).toBe('Partial 1. Done.')
    expect(result.value?.intermediateSteps).toHaveLength(1)
  })
})

describe('BL-611 a delegated API run keeps its failed tool calls', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('a tool whose execute threw is a failed step in the run record, with the reason, and the run goes on', async () => {
    const { outcome } = await runDelegated({
      script: [() => turn.toolCall(1), () => turn.answer()],
      execute: async () => {
        throw new Error('The MCP gateway refused the call: 502 Bad Gateway')
      }
    })

    const result = await outcome
    expect(result.content).toContain('Done.')
    expect(result.intermediateSteps).toEqual([
      expect.objectContaining({
        toolName: 'work',
        toolInput: { value: 'step-1' },
        toolOutput: { success: false, error: 'The MCP gateway refused the call: 502 Bad Gateway' }
      })
    ])
  })

  it('a call to a tool that does not exist is a failed step too', async () => {
    const unknownToolCall = () =>
      sseResponse([
        messageStart('msg_unknown'),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_unknown', name: 'no_such_tool', input: {} }
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' }
      ])
    const { outcome } = await runDelegated({ script: [unknownToolCall, () => turn.answer()] })

    const result = await outcome
    expect(result.intermediateSteps).toEqual([
      expect.objectContaining({
        toolName: 'no_such_tool',
        toolOutput: expect.objectContaining({ success: false, error: expect.stringContaining('no_such_tool') })
      })
    ])
  })
})

/**
 * BL-1517 — REAL installed `ai` 7 and `@ai-sdk/openai` chat model; MiMo-shaped synthetic
 * responses (the chunk shape recorded on the wire 2026-10-14), no network, no Redis.
 *
 * Pins: the model's streamed `reasoning_content` reaches the SDK as reasoning parts, and the
 * next request of the same reply carries it back on that step's assistant message, byte for
 * byte, while every other byte of the request is what the plain provider builds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.unmock('@ai-sdk/openai')

import { generateText, isStepCount, jsonSchema, streamText, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { ProviderManager } from '../index'
import { batshitProviderHeaders } from '../batshitIdentity'
import {
  assistantStepReasoning,
  carryAssistantReasoning,
  reasoningContentChatModel,
  withAssistantReasoningContent
} from '../reasoningContentCarry'
import { ReasoningStreamSourceArbiter, extractReasoningTextFromRawChunk } from '$lib/utils/reasoningDisplay'

// Deltas with the characters a re-serialisation could change: quotes, a backslash, a newline,
// non-ASCII and an astral-plane character.
const STEP_ONE_REASONING = ['Let me start', ' by "exploring" the\nproject: C:\\work ', 'naïve 🦇.']
const STEP_TWO_REASONING = ['Found it; ', 'answer now.']
const CALL_ID = 'call_21a46754e1b64e0cbcc84de2'

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'fixture-response',
    choices: [{ delta: { content: null, role: null, tool_calls: null, reasoning_content: null, ...delta }, finish_reason: null, index: 0 }],
    created: 1791991272,
    model: 'mimo-v2.6-pro',
    object: 'chat.completion.chunk',
    ...extra
  }
}

function finish(reason: string) {
  return {
    id: 'fixture-response',
    choices: [{ delta: { content: null, role: null, tool_calls: null, reasoning_content: null }, finish_reason: reason, index: 0 }],
    created: 1791991273,
    model: 'mimo-v2.6-pro',
    object: 'chat.completion.chunk',
    usage: null
  }
}

const usage = {
  id: 'fixture-response',
  choices: [],
  created: 1791991273,
  model: 'mimo-v2.6-pro',
  object: 'chat.completion.chunk',
  usage: { completion_tokens: 81, prompt_tokens: 6251, total_tokens: 6332, completion_tokens_details: { reasoning_tokens: 9 }, prompt_tokens_details: { cached_tokens: 0 } }
}

function sse(chunks: unknown[]): Response {
  const text = chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

const stepOneChunks = [
  chunk({ content: '', role: 'assistant' }),
  ...STEP_ONE_REASONING.map((reasoning_content) => chunk({ reasoning_content })),
  chunk({ tool_calls: [{ index: 0, id: CALL_ID, function: { arguments: '', name: 'lookup' }, type: 'function' }] }),
  chunk({ tool_calls: [{ index: 0, id: null, function: { arguments: '{"query":"habit"}', name: null }, type: 'function' }] }),
  finish('tool_calls'),
  usage
]

const stepTwoChunks = [
  chunk({ content: '', role: 'assistant' }),
  ...STEP_TWO_REASONING.map((reasoning_content) => chunk({ reasoning_content })),
  chunk({ content: 'Streaks are counted per day.' }),
  finish('stop'),
  usage
]

/** A fetch that answers the two steps in order and keeps every request body and headers it was sent. */
function mimoEndpoint(responses = [stepOneChunks, stepTwoChunks]) {
  const bodies: any[] = []
  const urls: string[] = []
  const headers: unknown[] = []
  const fetch = vi.fn(async (input: any, init?: RequestInit) => {
    urls.push(String(input))
    headers.push(init?.headers)
    bodies.push(JSON.parse(String(init?.body)))
    const next = responses[bodies.length - 1]
    if (!next) throw new Error('Unexpected extra request')
    return sse(next)
  })
  return { fetch, bodies, urls, headers }
}

const tools = {
  lookup: tool({
    description: 'Look something up.',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false
    }),
    execute: async () => 'habit-streaks/src/streaks.ts'
  })
}

async function runReply(model: any, include?: { rawChunks?: boolean; requestBody?: boolean }) {
  const result = streamText({
    model,
    messages: [{ role: 'user', content: 'How are streaks counted?' }],
    tools,
    stopWhen: isStepCount(3),
    maxRetries: 0,
    ...(include ? { include } : {})
  })
  const parts: any[] = []
  for await (const part of result.stream) parts.push(part)
  return { parts, steps: await result.steps, text: await result.text }
}

/**
 * The reasoning text send-routed saves for these parts: its `raw`, `reasoning-*`, text, tool and
 * finish cases (`send-routed/+server.ts`), with the real arbiter and raw-chunk reader.
 */
function displayedReasoning(parts: any[]): string {
  const arbiter = new ReasoningStreamSourceArbiter()
  let captured = ''
  let active = false
  const append = (text: string) => {
    if (!text) return
    if (!active && captured) captured += '\n\n'
    active = true
    captured += text
  }
  for (const part of parts) {
    switch (part.type) {
      case 'raw':
        append(arbiter.queueRawFallback(extractReasoningTextFromRawChunk(part.rawValue)))
        break
      case 'reasoning-start':
        arbiter.noteNormalizedReasoning()
        if (!active && captured) captured += '\n\n'
        active = true
        break
      case 'reasoning-delta':
        arbiter.noteNormalizedReasoning()
        append(part.text)
        break
      case 'reasoning-end':
        arbiter.noteNormalizedReasoning()
        active = false
        break
      case 'text-delta':
      case 'tool-call':
      case 'finish':
        append(arbiter.flushRawFallback())
        active = false
        break
      case 'tool-result':
      case 'tool-error':
        active = false
        break
    }
  }
  return captured
}

function withoutReasoningContent(body: any) {
  return {
    ...body,
    messages: body.messages.map(({ reasoning_content: _ignored, ...message }: any) => message)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BL-1517 reasoning_content carry (installed SDK)', () => {
  it('direct:mimo sends each step its own streamed reasoning back, byte for byte, and nothing else changes', async () => {
    const wire = mimoEndpoint()
    vi.stubGlobal('fetch', wire.fetch)
    const manager = new ProviderManager({ apiKeys: { mimo: 'sk-mimo-fixture-0123456789' } })
    const reply = await runReply(manager.getModel('mimo-v2.6-pro', { transport: 'direct', service: 'mimo' }), {
      rawChunks: true,
      requestBody: true
    })

    expect(wire.urls).toHaveLength(2)
    expect(wire.urls[0]).toMatch(/\/chat\/completions$/)
    expect(JSON.stringify(wire.bodies[0])).not.toContain('reasoning_content')

    const assistant = wire.bodies[1].messages.find((message: any) => message.role === 'assistant')
    expect(assistant.reasoning_content).toBe(STEP_ONE_REASONING.join(''))
    expect(Object.keys(assistant)).toEqual(['role', 'content', 'reasoning_content', 'tool_calls'])
    expect(assistant.tool_calls.map((call: any) => call.id)).toEqual([CALL_ID])

    // The same reply through the plain provider (the settings the registration builds): every
    // other byte of both requests is the same.
    const plainWire = mimoEndpoint()
    const plain = createOpenAI({
      headers: batshitProviderHeaders(),
      apiKey: 'sk-mimo-fixture-0123456789',
      baseURL: 'https://api.xiaomimimo.com/v1',
      fetch: plainWire.fetch
    })
    await runReply(plain.chat('mimo-v2.6-pro'))
    expect(wire.bodies[0]).toEqual(plainWire.bodies[0])
    expect(withoutReasoningContent(wire.bodies[1])).toEqual(plainWire.bodies[1])
    expect(JSON.stringify(plainWire.bodies[1])).not.toContain('reasoning_content')
    // The per-call client of step two sends the plain client's headers, key for key.
    expect(wire.headers[1]).toHaveProperty('authorization')
    expect(wire.headers[1]).toEqual(plainWire.headers[1])

    // In: the SDK's own reasoning parts, before the step's tool call and text, in stream order.
    const reasoningDeltas = reply.parts.filter((part) => part.type === 'reasoning-delta').map((part) => part.text)
    expect(reasoningDeltas).toEqual([...STEP_ONE_REASONING, ...STEP_TWO_REASONING])
    const order = reply.parts.map((part) => part.type)
    expect(order.indexOf('reasoning-end')).toBeLessThan(order.indexOf('tool-call'))
    expect(reply.steps[0]!.reasoningText).toBe(STEP_ONE_REASONING.join(''))
    expect(reply.steps[1]!.reasoningText).toBe(STEP_TWO_REASONING.join(''))
    expect(reply.text).toBe('Streaks are counted per day.')

    // Raw chunks still reach the caller that asked (send-routed's display fallback reads them).
    expect(reply.parts.filter((part) => part.type === 'raw').length).toBe(stepOneChunks.length + stepTwoChunks.length)

    // Execution Viewer evidence: the step's request body is the one that went out.
    expect((reply.steps[1]!.request.body as any).messages[1].reasoning_content).toBe(STEP_ONE_REASONING.join(''))
  })

  it('a step without reasoning sends no reasoning_content field: the request is the plain one', async () => {
    const silentStepOne = stepOneChunks.filter((value: any) => !value.choices[0]?.delta?.reasoning_content)
    const wire = mimoEndpoint([silentStepOne, stepTwoChunks])
    vi.stubGlobal('fetch', wire.fetch)
    const manager = new ProviderManager({ apiKeys: { mimo: 'sk-mimo-fixture-0123456789' } })
    await runReply(manager.getModel('mimo-v2.6-pro', { transport: 'direct', service: 'mimo' }))

    const plainWire = mimoEndpoint([silentStepOne, stepTwoChunks])
    const plain = createOpenAI({ apiKey: 'sk-mimo-fixture-0123456789', baseURL: 'https://api.xiaomimimo.com/v1', fetch: plainWire.fetch })
    await runReply(plain.chat('mimo-v2.6-pro'))
    expect(wire.bodies[1].messages[1]).not.toHaveProperty('reasoning_content')
    expect(wire.bodies).toEqual(plainWire.bodies)
  })

  it('the display lane reads the same raw chunks and saves one copy of the reasoning', async () => {
    const wire = mimoEndpoint()
    vi.stubGlobal('fetch', wire.fetch)
    const manager = new ProviderManager({ apiKeys: { mimo: 'sk-mimo-fixture-0123456789' } })
    const carried = await runReply(manager.getModel('mimo-v2.6-pro', { transport: 'direct', service: 'mimo' }), { rawChunks: true })

    const plainWire = mimoEndpoint()
    const plain = createOpenAI({ apiKey: 'sk-mimo-fixture-0123456789', baseURL: 'https://api.xiaomimimo.com/v1', fetch: plainWire.fetch })
    const before = await runReply(plain.chat('mimo-v2.6-pro'), { rawChunks: true })

    const raw = (parts: any[]) => parts.filter((part) => part.type === 'raw').map((part) => part.rawValue)
    expect(raw(carried.parts)).toEqual(raw(before.parts))
    const saved = `${STEP_ONE_REASONING.join('')}\n\n${STEP_TWO_REASONING.join('')}`
    expect(displayedReasoning(before.parts)).toBe(saved)
    expect(displayedReasoning(carried.parts)).toBe(saved)
  })

  it('drops raw parts nobody asked for and keeps reasoning parts', async () => {
    const wire = mimoEndpoint()
    const model = reasoningContentChatModel((fetch) =>
      createOpenAI({ apiKey: 'sk-fixture-0123456789', fetch: fetch ?? wire.fetch }).chat('mimo-v2.6-pro')
    )
    vi.stubGlobal('fetch', wire.fetch)
    const reply = await runReply(model)
    expect(reply.parts.some((part) => part.type === 'raw')).toBe(false)
    expect(reply.steps[0]!.reasoningText).toBe(STEP_ONE_REASONING.join(''))
    expect(wire.bodies[1].messages[1].reasoning_content).toBe(STEP_ONE_REASONING.join(''))
  })

  it('leaves a chat connection without the flag exactly as before (direct:zai)', async () => {
    const wire = mimoEndpoint()
    vi.stubGlobal('fetch', wire.fetch)
    const manager = new ProviderManager({ apiKeys: { zai: 'zai-fixture-0123456789' } })
    const reply = await runReply(manager.getModel('glm-5.3', { transport: 'direct', service: 'zai' }), { rawChunks: true })
    expect(JSON.stringify(wire.bodies[1])).not.toContain('reasoning_content')
    expect(reply.parts.some((part) => part.type === 'reasoning-delta')).toBe(false)
  })

  it('a reply with two reasoning blocks in one step sends both, joined, as the compatible provider does', async () => {
    const interleaved = [
      chunk({ reasoning_content: 'First thought. ' }),
      chunk({ content: 'Checking.' }),
      chunk({ reasoning_content: 'Second thought.' }),
      chunk({ tool_calls: [{ index: 0, id: CALL_ID, function: { arguments: '{"query":"x"}', name: 'lookup' }, type: 'function' }] }),
      finish('tool_calls'),
      usage
    ]
    const wire = mimoEndpoint([interleaved, stepTwoChunks])
    vi.stubGlobal('fetch', wire.fetch)
    const manager = new ProviderManager({ apiKeys: { mimo: 'sk-mimo-fixture-0123456789' } })
    const reply = await runReply(manager.getModel('mimo-v2.6-pro', { transport: 'direct', service: 'mimo' }))
    // Two blocks in step one, one in step two (the SDK gives repeated ids its own).
    expect(reply.parts.filter((part) => part.type === 'reasoning-start')).toHaveLength(3)
    expect(reply.steps[0]!.reasoningText).toBe('First thought. Second thought.')
    expect(wire.bodies[1].messages[1]).toMatchObject({
      content: 'Checking.',
      reasoning_content: 'First thought. Second thought.'
    })
  })

  it('generateText reads message.reasoning_content and sends it back on the next step', async () => {
    const bodies: any[] = []
    const replies = [
      { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'Plan: look it up.', tool_calls: [{ id: CALL_ID, type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' } }] } }], usage: usage.usage },
      { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.', reasoning_content: 'Answer.' } }], usage: usage.usage }
    ]
    const fetch = vi.fn(async (_input: any, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(replies[bodies.length - 1]), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const manager = new ProviderManager({ apiKeys: { mimo: 'sk-mimo-fixture-0123456789' } })
    const result = await generateText({
      model: manager.getModel('mimo-v2.6-pro', { transport: 'direct', service: 'mimo' }),
      messages: [{ role: 'user', content: 'Go.' }],
      tools,
      stopWhen: isStepCount(3),
      maxRetries: 0
    })
    expect(result.steps[0]!.reasoningText).toBe('Plan: look it up.')
    expect(bodies[1].messages[1].reasoning_content).toBe('Plan: look it up.')
    expect(result.text).toBe('Done.')
  })

  it('Stop while the model is still thinking aborts the request on the wire', async () => {
    // @ai-sdk/openai's chat stream holds reasoning-only chunks until the first text or tool call
    // (throwIfOpenAIStreamErrorBeforeOutput), so this Stop lands before any part reaches the loop.
    let wireSignal: AbortSignal | undefined
    let requested!: () => void
    const sent = new Promise<void>((resolve) => { requested = resolve })
    const encoder = new TextEncoder()
    const fetch = vi.fn(async (_input: any, init?: RequestInit) => {
      wireSignal = init?.signal as AbortSignal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ reasoning_content: 'Thinking' }))}\n\n`))
          wireSignal?.addEventListener('abort', () => controller.error(wireSignal?.reason))
          requested()
        }
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetch)
    const manager = new ProviderManager({ apiKeys: { mimo: 'sk-mimo-fixture-0123456789' } })
    const stop = new AbortController()
    const result = streamText({
      model: manager.getModel('mimo-v2.6-pro', { transport: 'direct', service: 'mimo' }),
      messages: [{ role: 'user', content: 'Think.' }],
      maxRetries: 0,
      abortSignal: stop.signal
    })
    const types: string[] = []
    const consumed = (async () => {
      for await (const part of result.stream) types.push(part.type)
    })()
    await sent
    stop.abort('user')
    await consumed
    expect(wireSignal?.aborted).toBe(true)
    expect(types).toContain('abort')
    expect(types).not.toContain('reasoning-delta')
  })
})

describe('carryAssistantReasoning (body rewrite)', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'A1 ' },
        { type: 'reasoning', text: 'A2' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: {} }
      ]
    },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', output: { type: 'text', value: 'ok' } }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'lookup', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'lookup', output: { type: 'text', value: 'ok' } }] }
  ]
  const body = {
    model: 'm',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'ok' }
    ]
  }

  it('puts each step its own reasoning and leaves a step without reasoning alone', () => {
    const steps = assistantStepReasoning(prompt)
    expect(steps).toEqual([
      { reasoning: 'A1 A2', toolCallIds: ['c1'] },
      { reasoning: '', toolCallIds: ['c2'] }
    ])
    const carried = carryAssistantReasoning(body, steps)
    expect(carried.messages[1]).toEqual({ ...body.messages[1], reasoning_content: 'A1 A2' })
    expect(carried.messages[3]).toBe(body.messages[3])
    expect(body.messages[1]).not.toHaveProperty('reasoning_content')
  })

  it('returns the same body when no step has reasoning', () => {
    expect(carryAssistantReasoning(body, [{ reasoning: '', toolCallIds: ['c1'] }, { reasoning: '', toolCallIds: ['c2'] }])).toBe(body)
  })

  it('sends nothing and says why when the messages do not line up', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const context = { provider: 'openai.chat', modelId: 'mimo-v2.6-pro' }
    expect(carryAssistantReasoning(body, [{ reasoning: 'only one', toolCallIds: ['c1'] }], context)).toBe(body)
    expect(carryAssistantReasoning(body, [
      { reasoning: 'x', toolCallIds: ['other'] },
      { reasoning: '', toolCallIds: ['c2'] }
    ], context)).toBe(body)
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenNthCalledWith(1, expect.stringContaining('Assistant messages do not line up'), expect.objectContaining(context))
    expect(error).toHaveBeenNthCalledWith(2, expect.stringContaining('Tool calls do not line up'), expect.objectContaining(context))
  })

  it('sends a body it cannot read unchanged and says why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wire = vi.fn(async (_input: any, _init?: RequestInit) => new Response('{}'))
    const context = { provider: 'openai.chat', modelId: 'mimo-v2.6-pro' }
    const init = { method: 'POST', body: 'not json {' }
    await withAssistantReasoningContent(assistantStepReasoning(prompt), wire, { context })('https://example.invalid/v1/chat/completions', init)
    expect(wire).toHaveBeenCalledTimes(1)
    expect(wire.mock.calls[0]![1]).toBe(init)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Request body is not JSON'), expect.objectContaining(context))
  })
})

describe('reasoningContentChatModel (one call, one log)', () => {
  // `@ai-sdk/openai`'s converter always lines the messages up (one body message per prompt
  // assistant message, each tool-call id copied), so a mismatch cannot be forced through it with a
  // well-formed prompt. This base model builds a body whose tool call does not match instead.
  const prompt: LanguageModelV4Prompt = [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Plan.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: {} }
      ]
    },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', output: { type: 'text', value: 'ok' } }] }
  ]
  const builtBody = {
    model: 'fake-model',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'not-c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'not-c1', content: 'ok' }
    ]
  }

  const baseRequests: unknown[] = []

  function fakeChatModel(fetch?: typeof globalThis.fetch): LanguageModelV4 {
    const send = async () => {
      await (fetch ?? globalThis.fetch)('https://example.invalid/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(builtBody)
      })
      const request = { body: builtBody }
      baseRequests.push(request)
      return request
    }
    return {
      specificationVersion: 'v4',
      provider: 'fake.chat',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined }
        },
        warnings: [],
        request: await send()
      }),
      doStream: async () => ({
        stream: new ReadableStream({ start: (controller) => controller.close() }),
        request: await send()
      })
    }
  }

  it('a mismatch logs once per call, names the connection, and the request goes out as built', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sent: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: any, init?: RequestInit) => {
      sent.push(init?.body)
      return new Response('{}')
    }))
    const model = reasoningContentChatModel(fakeChatModel)
    const context = { provider: 'fake.chat', modelId: 'fake-model' }

    const streamed = await model.doStream({ prompt })
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Tool calls do not line up'), expect.objectContaining(context))
    expect(sent).toEqual([JSON.stringify(builtBody)])
    expect(streamed.request).toBe(baseRequests.at(-1))

    const generated = await model.doGenerate({ prompt })
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('Tool calls do not line up'), expect.objectContaining(context))
    expect(sent).toEqual([JSON.stringify(builtBody), JSON.stringify(builtBody)])
    expect(generated.request).toBe(baseRequests.at(-1))
  })
})

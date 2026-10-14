/**
 * BL-77 wire proof: the tool loop's cache point, end to end.
 *
 * Runs Batshit's REAL `streamNativeMode` (the cache policy and the per-step hook) through the
 * REAL AI SDK loop and the REAL provider packages. Only the network is fake: an injected fetch
 * serves canned provider streams (two tool calls, then an answer) and records every request
 * body, which is exactly what the provider would have received. No Redis, no keys.
 *
 * What it pins (BL-77, 2026-09-22):
 *  - a turn's first request carries no conversation-end cache point, and every later request
 *    carries exactly one (the request-level automatic point), on direct Anthropic and on
 *    OpenRouter with a Claude model;
 *  - the system cache point stays on every request, and a request never carries more cache
 *    points than Anthropic allows (4, the automatic one included);
 *  - nothing else moves: with every cache marker stripped, each request is the previous one
 *    plus the new step, the system prompt and the first user message (which ends with the DCM)
 *    are byte-identical on every step, and a steer delivered at a step boundary stays where it
 *    landed;
 *  - a provider that does not take Anthropic cache control gets no cache field at all;
 *  - a preset's 1-hour cache TTL puts every cache point on one hour (longer TTLs must come
 *    before shorter ones).
 *
 * BL-183 (2026-09-25): an API Subagent or Worker run (`processNativeMode`) gets the same point
 * on the same rule; before, its hook was registered only on the synthetic image lane.
 * BL-185 (2026-09-25): on OpenRouter the tail point is an explicit marker on the LAST message's
 * last content part instead of the request-level field (OpenRouter's Amazon Bedrock route
 * accepts the request-level field and ignores it). The hook moves Batshit's one marker every
 * step, so a request carries the system point and one tail point, never more; nothing the
 * SDK hands back as the run's response messages (what send-routed saves) ever carries one.
 * BL-200 (2026-09-25): an approval resume keeps the same rule, no point on its first request.
 * Measured live: a resume recompiles the one user message, so it can never read what the paused
 * run wrote, and a first-request point only pays off when the resumed run takes two or more
 * calls; with every tool call gated each resume was one call and the point cost 22% more.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')
vi.unmock('@openrouter/ai-sdk-provider')

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
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { VercelAIBrain, type NativeModeRequest } from '../vercelBrain'
import { ApiImageInputCollector } from '../imageAddressApiInput'
import { isTurnComplete } from '../imageAddressTurnRecord'
import { formatSteerForModel } from '$lib/utils/steerControl'

const SYSTEM_PROMPT = '==== API PRIMARY SYSTEM PROMPT ====\nYou are a probe agent.'
const FIRST_USER_MESSAGE =
  '<user time="September 22, 2026 at 12:00 PM">\nBuild me a tip calculator artifact.\n</user>\n\n' +
  '<dynamic_info>\nproject_path: /tmp/probe\n</dynamic_info>'
const STEER_TEXT = 'use a slider for the tip'

type Body = Record<string, any>

function sseResponse(events: Array<Record<string, any>>, withEventLines: boolean): Response {
  const body = events
    .map((event) => `${withEventLines ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const anthropicTurn = {
  toolCall: (n: number) =>
    sseResponse(
      [
        {
          type: 'message_start',
          message: {
            id: `msg_${n}`,
            model: 'claude-sonnet-5',
            role: 'assistant',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
          }
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `toolu_${n}`, name: 'echo', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ value: `step-${n}` }) }
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 5 }
        },
        { type: 'message_stop' }
      ],
      true
    ),
  answer: () =>
    sseResponse(
      [
        {
          type: 'message_start',
          message: {
            id: 'msg_final',
            model: 'claude-sonnet-5',
            role: 'assistant',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
          }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 }
        },
        { type: 'message_stop' }
      ],
      true
    )
}

const openRouterTurn = {
  toolCall: (n: number) =>
    sseResponse(
      [
        {
          id: `gen_${n}`,
          model: 'probe/model',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${n}`,
                    type: 'function',
                    function: { name: 'echo', arguments: JSON.stringify({ value: `step-${n}` }) }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          id: `gen_${n}`,
          model: 'probe/model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      ],
      false
    ),
  /** One step that calls `echo` `count` times in parallel. */
  parallelToolCalls: (n: number, count: number) =>
    sseResponse(
      [
        {
          id: `gen_${n}`,
          model: 'probe/model',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: Array.from({ length: count }, (_unused, index) => ({
                  index,
                  id: `call_${n}_${index}`,
                  type: 'function',
                  function: { name: 'echo', arguments: JSON.stringify({ value: `step-${n}-${index}` }) }
                }))
              },
              finish_reason: null
            }
          ]
        },
        {
          id: `gen_${n}`,
          model: 'probe/model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      ],
      false
    ),
  answer: () =>
    sseResponse(
      [
        {
          id: 'gen_final',
          model: 'probe/model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }]
        },
        {
          id: 'gen_final',
          model: 'probe/model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        }
      ],
      false
    )
}

/** Serves `toolCall(1)`, `toolCall(2)`, then `answer()` unless a script is given; records each
 *  request body. */
function scriptedFetch(
  turn: typeof anthropicTurn | typeof openRouterTurn,
  bodies: Body[],
  script: Array<() => Response> = [() => turn.toolCall(1), () => turn.toolCall(2), () => turn.answer()]
) {
  return (async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body))
    const next = script[bodies.length - 1]
    if (!next) throw new Error(`unexpected request #${bodies.length}`)
    const response = next()
    // `data: [DONE]` ends an OpenAI-compatible stream; Anthropic ends on message_stop.
    if (turn === openRouterTurn) {
      const text = await response.text()
      return new Response(`${text}data: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    return response
  }) as any
}

/** Removes every cache marker (block level and request level) from a request body. */
function stripCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheMarkers)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'cache_control') continue
    out[key] = stripCacheMarkers(entry)
  }
  return out
}

/** Every block-level `cache_control` in a request body, in order. */
function blockCacheMarkers(value: unknown, found: any[] = []): any[] {
  if (Array.isArray(value)) {
    for (const entry of value) blockCacheMarkers(entry, found)
    return found
  }
  if (!value || typeof value !== 'object') return found
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'cache_control') found.push(entry)
    else blockCacheMarkers(entry, found)
  }
  return found
}

function echoTools() {
  return {
    tools: {
      echo: tool({
        description: 'Echo a value back.',
        inputSchema: jsonSchema<{ value: string }>({
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value']
        }),
        execute: async ({ value }: { value: string }) => ({ echoed: value })
      })
    },
    maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
    toolApprovals: {},
    ephemeralImages: null
  }
}

async function runTurn(
  lane: 'anthropic' | 'openrouter-claude' | 'openrouter-other',
  overrides: Partial<NativeModeRequest> = {},
  path: 'stream' | 'delegated' = 'stream',
  script?: (turn: any) => Array<() => Response>
): Promise<Body[]> {
  const bodies: Body[] = []
  let request: NativeModeRequest
  if (lane === 'anthropic') {
    slot.model = createAnthropic({
      apiKey: 'test-key',
      fetch: scriptedFetch(anthropicTurn, bodies, script?.(anthropicTurn))
    })('claude-sonnet-5')
    request = {
      model: 'claude-sonnet-5',
      connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' } as any,
      messages: []
    }
  } else {
    const modelId = lane === 'openrouter-claude' ? 'anthropic/claude-sonnet-5' : 'openai/gpt-5.5'
    slot.model = createOpenRouter({
      apiKey: 'test-key',
      fetch: scriptedFetch(openRouterTurn, bodies, script?.(openRouterTurn))
    }).chat(modelId)
    request = {
      model: modelId,
      connection: { id: 'openrouter', type: 'openrouter' } as any,
      messages: []
    }
  }

  const brain = new VercelAIBrain()
  ;(brain as any).buildToolsForMode3 = vi.fn(async () => echoTools())
  const fullRequest: NativeModeRequest = {
    ...request,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: FIRST_USER_MESSAGE }
    ],
    sessionId: 'sess-bl77',
    messageId: 'msg-bl77',
    userId: 'user-1',
    agentId: 'agent-1',
    maxToolRounds: 10,
    ...overrides
  }
  if (path === 'delegated') {
    // The API Subagent / Worker path (`subagentRunner.runApiSubagent`): non-streaming, no steers.
    await brain.processNativeMode(fullRequest)
    return bodies
  }
  const result: any = await brain.streamNativeMode(fullRequest)
  for await (const part of result.stream) {
    if (part?.type === 'error') throw part.error
  }
  return bodies
}

/**
 * The messages send-routed hands the API lane on an approval resume: the compiled chat, the
 * provider continuation (the assistant's paused tool call and its approval request), and one
 * `tool` message with the user's answer (`send-routed/+server.ts`, `isStrictApprovalResume`).
 */
function approvalResumeMessages(approved = true): NativeModeRequest['messages'] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: FIRST_USER_MESSAGE },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'toolu_paused', toolName: 'echo', input: { value: 'paused' } },
        { type: 'tool-approval-request', approvalId: 'apr_1', toolCallId: 'toolu_paused' }
      ]
    },
    {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: 'apr_1', approved }]
    }
  ] as any
}

describe('BL-77 tool-loop cache point on the wire (real SDK + real providers)', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('direct Anthropic: no tail point on the first request, exactly one on every later request', async () => {
    const bodies = await runTurn('anthropic')
    expect(bodies).toHaveLength(3)

    // Request 1: the system point only.
    expect(bodies[0].cache_control).toBeUndefined()
    expect(bodies[0].system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    expect(blockCacheMarkers(bodies[0].messages)).toEqual([])

    for (const body of bodies.slice(1)) {
      // Exactly one conversation-end point: the request-level automatic one. Anthropic puts it
      // on the last block; no message carries a marker of its own.
      expect(body.cache_control).toEqual({ type: 'ephemeral' })
      expect(blockCacheMarkers(body.messages)).toEqual([])
      expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
      // Anthropic's limit is 4 points per request, the automatic one included.
      expect(blockCacheMarkers(body).length + 1).toBeLessThanOrEqual(4)
    }
  })

  it('direct Anthropic: nothing but the markers changes, and nothing is reordered', async () => {
    const bodies = (await runTurn('anthropic')).map((body) => stripCacheMarkers(body) as Body)

    for (let index = 1; index < bodies.length; index += 1) {
      const previous = bodies[index - 1]
      const current = bodies[index]
      // Append-only: each request is the previous request plus the step that just ran.
      expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
      expect(current.messages.length).toBeGreaterThan(previous.messages.length)
      // Everything outside `messages` is byte-identical from step to step.
      const { messages: _currentMessages, ...currentRest } = current
      const { messages: _previousMessages, ...previousRest } = previous
      expect(JSON.stringify(currentRest)).toBe(JSON.stringify(previousRest))
    }
    // The first user message (history + current turn + the DCM tail) is untouched on every step.
    for (const body of bodies) {
      expect(body.messages[0]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: FIRST_USER_MESSAGE }]
      })
    }
  })

  it('a steer delivered at a step boundary keeps its place, and the tail point still lands', async () => {
    const takeSteers = vi.fn((step: number) =>
      step === 1
        ? [
            {
              steerId: 'steer_1',
              messageId: 'msg-bl77',
              text: STEER_TEXT,
              at: '2026-09-22T12:00:00.000Z',
              source: 'user' as const,
              step,
              lane: 'api' as const
            }
          ]
        : []
    )
    const bodies = await runTurn('anthropic', { takeSteers })
    expect(bodies).toHaveLength(3)

    const steerBlock = { type: 'text', text: `[The user said, mid-reply: ${STEER_TEXT}]` }
    // Request 2: the steer is the last block (after the first tool result), with the tail point.
    const second = stripCacheMarkers(bodies[1]) as Body
    expect(second.messages.at(-1).content.at(-1)).toEqual(steerBlock)
    expect(bodies[1].cache_control).toEqual({ type: 'ephemeral' })
    // Request 3: the same message, byte for byte, still in the same place.
    const third = stripCacheMarkers(bodies[2]) as Body
    expect(third.messages[second.messages.length - 1]).toEqual(second.messages.at(-1))
    expect(bodies[2].cache_control).toEqual({ type: 'ephemeral' })
    expect(JSON.stringify(bodies[2]).split(STEER_TEXT)).toHaveLength(2)
  })

  it("a preset's 1-hour TTL: the system point is back, and every point is one hour", async () => {
    const bodies = await runTurn('anthropic', {
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } }
    })
    expect(bodies).toHaveLength(3)

    for (const body of bodies) {
      // The preset's own request-level point rides every request, as before BL-77 …
      expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
      // … and the system point it used to REPLACE is there too, on the same TTL.
      expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
      for (const marker of blockCacheMarkers(body)) expect(marker.ttl).toBe('1h')
      expect(blockCacheMarkers(body).length + 1).toBeLessThanOrEqual(4)
    }
  })

  it('OpenRouter with a Claude model: the same rule, as a marker on the last message (BL-185)', async () => {
    const bodies = await runTurn('openrouter-claude')
    expect(bodies).toHaveLength(3)

    // Request 1: the system point only.
    expect(blockCacheMarkers(bodies[0].messages.slice(1))).toEqual([])
    for (const body of bodies) {
      // Never the request-level field: OpenRouter's Bedrock route ignores it.
      expect(body.cache_control).toBeUndefined()
      expect(body.messages[0].role).toBe('system')
      expect(blockCacheMarkers(body.messages[0])).toEqual([{ type: 'ephemeral' }])
    }
    for (const body of bodies.slice(1)) {
      // Exactly one tail marker, on the last message, and nowhere else.
      expect(blockCacheMarkers(body.messages.slice(1))).toEqual([{ type: 'ephemeral' }])
      expect(blockCacheMarkers(body.messages.at(-1))).toEqual([{ type: 'ephemeral' }])
    }
  })

  it('a provider that does not take Anthropic cache control gets no cache field at all', async () => {
    const bodies = await runTurn('openrouter-other')
    expect(bodies).toHaveLength(3)

    for (const body of bodies) {
      expect(body.cache_control).toBeUndefined()
      expect(blockCacheMarkers(body)).toEqual([])
    }
  })
})

describe('BL-183 API Subagents and Workers get the tool-loop cache point (processNativeMode)', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('direct Anthropic: no tail point on the first request, exactly one on every later request', async () => {
    const bodies = await runTurn('anthropic', {}, 'delegated')
    expect(bodies).toHaveLength(3)

    expect(bodies[0].cache_control).toBeUndefined()
    expect(bodies[0].system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    for (const body of bodies.slice(1)) {
      expect(body.cache_control).toEqual({ type: 'ephemeral' })
      expect(blockCacheMarkers(body.messages)).toEqual([])
      expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
      expect(blockCacheMarkers(body).length + 1).toBeLessThanOrEqual(4)
    }
  })

  it('OpenRouter with a Claude model: the same rule (a marker on the last message, BL-185)', async () => {
    const bodies = await runTurn('openrouter-claude', {}, 'delegated')
    expect(bodies).toHaveLength(3)

    expect(blockCacheMarkers(bodies[0].messages.slice(1))).toEqual([])
    for (const body of bodies) {
      expect(body.cache_control).toBeUndefined()
      // The system point stays on every request: the compiled messages are never touched.
      expect(blockCacheMarkers(body.messages[0])).toEqual([{ type: 'ephemeral' }])
    }
    for (const body of bodies.slice(1)) {
      expect(blockCacheMarkers(body.messages.slice(1))).toEqual([{ type: 'ephemeral' }])
      expect(blockCacheMarkers(body.messages.at(-1))).toEqual([{ type: 'ephemeral' }])
    }
  })

  it('sends exactly what the streaming path sends, once the markers are stripped', async () => {
    const streamed = (await runTurn('anthropic')).map((body) => JSON.stringify(stripCacheMarkers(body)))
    const delegated = (await runTurn('anthropic', {}, 'delegated')).map((body) =>
      JSON.stringify(stripCacheMarkers(body))
    )
    expect(delegated).toEqual(streamed)
  })

  it('a provider that does not take Anthropic cache control gets no cache field at all', async () => {
    const bodies = await runTurn('openrouter-other', {}, 'delegated')
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body.cache_control).toBeUndefined()
      expect(blockCacheMarkers(body)).toEqual([])
    }
  })
})

describe('BL-200 an approval resume keeps the BL-77 rule', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('no tail point on its first request (the SDK has just run the approved tool), one on every later request', async () => {
    for (const approved of [true, false]) {
      const bodies = await runTurn('anthropic', { messages: approvalResumeMessages(approved) })
      expect(bodies).toHaveLength(3)

      // Request 1 already ends with the approved (or denied) tool's result …
      const first = stripCacheMarkers(bodies[0]) as Body
      expect(first.messages.at(-1).content.at(-1).type).toBe('tool_result')
      // … and still carries the system point only: a resumed run that answers in one call
      // never pays for a cache write nobody reads.
      expect(bodies[0].cache_control).toBeUndefined()
      expect(bodies[0].system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
      for (const body of bodies.slice(1)) expect(body.cache_control).toEqual({ type: 'ephemeral' })
    }
  })
})

describe('BL-185 OpenRouter: the tail point is a marker on the last message, moved every step', () => {
  beforeEach(() => {
    slot.model = null
  })

  /** Every marker outside the system message, with the index of the message that carries it. */
  function tailMarkers(body: Body): Array<{ index: number; role: string; marker: any }> {
    const found: Array<{ index: number; role: string; marker: any }> = []
    body.messages.forEach((message: any, index: number) => {
      if (index === 0) return
      for (const marker of blockCacheMarkers(message)) found.push({ index, role: message.role, marker })
    })
    return found
  }

  it('a long loop: one tail marker per request, always on the last message, never piling up', async () => {
    const bodies = await runTurn('openrouter-claude', {}, 'stream', (turn) => [
      ...[1, 2, 3, 4, 5].map((n) => () => turn.toolCall(n)),
      () => turn.answer()
    ])
    expect(bodies).toHaveLength(6)

    expect(tailMarkers(bodies[0])).toEqual([])
    for (const body of bodies.slice(1)) {
      expect(tailMarkers(body)).toEqual([
        { index: body.messages.length - 1, role: body.messages.at(-1).role, marker: { type: 'ephemeral' } }
      ])
      // The system point and the tail: two of Anthropic's four, and no request-level one.
      expect(blockCacheMarkers(body)).toHaveLength(2)
      expect(body.cache_control).toBeUndefined()
    }
  })

  it('parallel tool results: only the last one carries the marker', async () => {
    const bodies = await runTurn('openrouter-claude', {}, 'stream', (turn) => [
      () => turn.parallelToolCalls(1, 3),
      () => turn.answer()
    ])
    expect(bodies).toHaveLength(2)

    const second = bodies[1]
    // Three tool results, each its own `tool` message on the OpenRouter wire.
    expect(second.messages.slice(-3).map((message: any) => message.role)).toEqual(['tool', 'tool', 'tool'])
    expect(tailMarkers(second)).toEqual([
      { index: second.messages.length - 1, role: 'tool', marker: { type: 'ephemeral' } }
    ])
    expect(blockCacheMarkers(second)).toHaveLength(2)
  })

  it('nothing but the markers changes, and nothing is reordered', async () => {
    const bodies = (await runTurn('openrouter-claude')).map((body) => stripCacheMarkers(body) as Body)
    for (let index = 1; index < bodies.length; index += 1) {
      const previous = bodies[index - 1]
      const current = bodies[index]
      expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
      const { messages: _currentMessages, ...currentRest } = current
      const { messages: _previousMessages, ...previousRest } = previous
      expect(JSON.stringify(currentRest)).toBe(JSON.stringify(previousRest))
    }
  })

  it('a steer delivered at a step boundary is untouched; the tool results before it carry the marker', async () => {
    const takeSteers = vi.fn((step: number) =>
      step === 1
        ? [
            {
              steerId: 'steer_1',
              messageId: 'msg-bl77',
              text: STEER_TEXT,
              at: '2026-09-22T12:00:00.000Z',
              source: 'user' as const,
              step,
              lane: 'api' as const
            }
          ]
        : []
    )
    const bodies = await runTurn('openrouter-claude', { takeSteers })
    expect(bodies).toHaveLength(3)

    const second = bodies[1]
    // The steer is the last message, byte for byte what it is without caching (a plain string:
    // the provider would turn it into a one-block array if it carried a marker).
    expect(second.messages.at(-1)).toEqual({
      role: 'user',
      content: `[The user said, mid-reply: ${STEER_TEXT}]`
    })
    expect(tailMarkers(second)).toEqual([
      { index: second.messages.length - 2, role: 'tool', marker: { type: 'ephemeral' } }
    ])
    // Request 3: the steer is carried forward unchanged; the tail moved on to the new results.
    const third = bodies[2]
    expect(third.messages[second.messages.length - 1]).toEqual(second.messages.at(-1))
    expect(tailMarkers(third)).toEqual([
      { index: third.messages.length - 1, role: 'tool', marker: { type: 'ephemeral' } }
    ])
  })

  it('an approval resume: the replayed messages are never marked; the tail starts at the second request', async () => {
    const bodies = await runTurn('openrouter-claude', { messages: approvalResumeMessages() })
    expect(bodies).toHaveLength(3)

    expect(tailMarkers(bodies[0])).toEqual([])
    for (const body of bodies.slice(1)) {
      expect(tailMarkers(body)).toEqual([
        { index: body.messages.length - 1, role: body.messages.at(-1).role, marker: { type: 'ephemeral' } }
      ])
    }
  })

  it('a preset request-level setting still rides every request instead, as before', async () => {
    const bodies = await runTurn('openrouter-claude', {
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } } }
    })
    for (const body of bodies) {
      expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
      expect(tailMarkers(body)).toEqual([])
    }
  })

  it("no marker ever reaches the run's response messages, which send-routed saves and replays", async () => {
    let saved: any[] | undefined
    const bodies = await runTurn('openrouter-claude', {
      onFinish: async ({ responseMessages }: any) => {
        saved = responseMessages
      }
    })
    expect(bodies).toHaveLength(3)
    expect(saved?.length).toBeGreaterThan(0)
    const text = JSON.stringify(saved)
    expect(text).not.toContain('cacheControl')
    expect(text).not.toContain('cache_control')
  })
})

describe('BL-474 API input observer through VercelBrain and the real provider wire', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('observes the exact dispatched schema, prompt text, and steer provenance without changing provider bytes', async () => {
    const compiledUserText = 'Please inspect https://compiled.example.org/chart.png'
    const steerText = 'Also compare https://steer.example.org/table.png'
    const dmText = 'Mira says https://dm-steer.example.org/reference.png'
    const takeSteers = vi.fn((step: number) => step === 1 ? [
      {
        steerId: 'observer_user_steer',
        messageId: 'msg-bl77',
        text: steerText,
        at: '2026-09-22T12:00:00.000Z',
        source: 'user' as const,
        step,
        lane: 'api' as const
      },
      {
        steerId: 'observer_dm_steer',
        messageId: 'msg-bl77',
        text: dmText,
        at: '2026-09-22T12:00:01.000Z',
        source: 'dm' as const,
        label: 'Mira',
        step,
        lane: 'api' as const
      }
    ] : [])
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: compiledUserText }
    ]
    const imageOriginInput = { compiledPrefixCount: messages.length, userSources: [] }
    const collector = new ApiImageInputCollector()
    const observations: any[] = []
    const capture = {
      messages,
      imageOriginInput,
      takeSteers,
      onApiModelInput: (input: any) => {
        observations.push(input)
        collector.observe(input)
      }
    }

    const withoutObserver = await runTurn('anthropic', {
      messages,
      imageOriginInput,
      takeSteers
    })
    const withObserver = await runTurn('anthropic', capture)

    expect(withObserver).toEqual(withoutObserver)
    expect(withObserver).toHaveLength(3)
    expect(observations).toHaveLength(3)
    expect(observations[0].toolDefinitions).toEqual([
      expect.objectContaining({ type: 'function', name: 'echo' })
    ])
    expect(JSON.stringify(observations[0].promptMessages)).toContain(compiledUserText)
    expect(JSON.stringify(withObserver[0].messages)).toContain(compiledUserText)
    expect(JSON.stringify(observations[1].promptMessages)).toContain(steerText)
    expect(JSON.stringify(observations[1].promptMessages)).toContain(dmText)
    expect(JSON.stringify(withObserver[1].messages)).toContain(steerText)
    expect(JSON.stringify(withObserver[1].messages)).toContain(dmText)

    const dispatchedEcho = observations[0].toolDefinitions.find((tool: any) => tool.name === 'echo')
    expect(dispatchedEcho).toMatchObject({
      type: 'function',
      name: withObserver[0].tools.find((tool: any) => tool.name === 'echo')?.name,
      description: withObserver[0].tools.find((tool: any) => tool.name === 'echo')?.description
    })
    expect(JSON.stringify(dispatchedEcho)).toContain('value')
    expect(JSON.stringify(withObserver[0].tools.find((tool: any) => tool.name === 'echo'))).toContain('value')

    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.unaccountedInputs).toBe(0)
    expect(collector.run.pieces).toContainEqual({ source: 'user', text: formatSteerForModel(takeSteers.mock.results[0].value[0]) })
    expect(collector.run.pieces).toContainEqual({ source: 'agent_note', text: formatSteerForModel(takeSteers.mock.results[0].value[1]) })
    expect(collector.run.pieces.some((piece) => piece.source === 'tool_result' && piece.text.includes('name":"echo"'))).toBe(true)
    expect(isTurnComplete({
      lane: 'api',
      compiled: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 },
      run: collector.run
    })).toBe(true)
  })
})

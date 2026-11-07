/**
 * BL-77 wire proof: the tool loop's cache point, end to end.
 *
 * Runs Batshit's REAL `streamNativeMode` (the cache policy and the per-step hook) through the
 * REAL AI SDK loop and the REAL provider packages. Only the network is fake: an injected fetch
 * serves canned provider streams (two tool calls, then an answer) and records every request
 * body, which is exactly what the provider would have received. No Redis, no keys.
 *
 * What it pins (BL-77, 2026-09-22; BL-1976, 2026-10-21):
 *  - every request of a turn, the first included, carries exactly one conversation-end cache
 *    point (the request-level automatic point on direct Anthropic; on OpenRouter with a Claude
 *    model, an explicit marker on the last message, which on the first request is the step-start
 *    message); until BL-1976 the first request carried none;
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
 * BL-200 (2026-09-25) kept an approval resume's first request without a point (a resume then
 * recompiled the one user message, and with every tool call gated each resume was one call: the
 * point cost 22% more). BL-1976 (Josh, 2026-10-21): the point starts on the first request on every
 * path, the resume included: its first call writes, its second reads; a one-call reply pays one
 * write nobody reads.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')
vi.unmock('@openrouter/ai-sdk-provider')
vi.unmock('@ai-sdk/openai')

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

// Skill consumers start after the existing catalog bootstrap owner. Validate
// its real saved plugin/member rows rather than emulate its write Lua here.
vi.mock('../systemSlashCommands', async importOriginal => {
  const { assertInitializedBuiltinPlugin } = await import('$lib/test-utils/initialized-builtin-plugin')
  const { redis } = await import('$lib/server/redis')
  return { ...(await importOriginal<typeof import('../systemSlashCommands')>()), ensureSystemSlashCommands: (userId: string) => assertInitializedBuiltinPlugin(userId, key => redis.json.get(key)) }
})

// These native utility consumers own confirmed saved settings, not the atomic
// operational-settings reader's Lua. Preserve its real projection from the same
// existing store without a generic fake EVAL or a default chosen to force success.
vi.mock('$lib/server/toolOperationalSettingsOwner', async () => {
  const { redis } = await import('$lib/server/redis')
  const { resolveToolOperationalSettings } = await import('$lib/utils/toolOperationalSettings')
  return { readToolOperationalSettings: async (userId: string) =>
    resolveToolOperationalSettings(await redis.getUserSettings(userId)) }
})

// The approval/media cases reuse the existing complete default Redis fake and
// its cleanup, rather than a new partial persistence adapter. No real Redis lane.
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
useRedisTestServer()

import { jsonSchema, tool } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createOpenAI } from '@ai-sdk/openai'
import { VercelAIBrain, type NativeModeRequest } from '../vercelBrain'
import { ApiImageInputCollector } from '../imageAddressApiInput'
import { isTurnComplete } from '../imageAddressTurnRecord'
import { formatSteerForModel } from '$lib/utils/steerControl'
import { compiledConversation, compiledElement } from '$lib/utils/compiledChatTags'
import { agentSetupCache, type LiveAgentSetup } from '../agentSetupCache'
import { fingerprintRegisteredTools, serializeRegisteredTools } from '../toolDefinitionFingerprint'
import { withToolResultsOnStop } from '../lateToolResults'
import { readApiUtilities } from '../apiUtilityRuntime'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'

const SYSTEM_PROMPT = '==== PRIMARY AGENT SYSTEM PROMPT ====\nYou are a probe agent.'
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
  toolCall: (n: number, name = 'echo', input: Record<string, any> = { value: `step-${n}` }) =>
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
          content_block: { type: 'tool_use', id: `toolu_${n}`, name, input: {} }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
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

// BL-1991: direct OpenAI's Responses API stream (the shape `chatgptPlanRuntime.test.ts` serves).
const openAiUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
const openAiTurn = {
  toolCall: (n: number) => {
    const item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'echo', arguments: JSON.stringify({ value: `step-${n}` }), status: 'completed' }
    return sseResponse([
      { type: 'response.created', response: { id: `resp_${n}`, created_at: 1790000000, model: 'gpt-6.1-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { usage: openAiUsage } }
    ], false)
  },
  answer: () =>
    sseResponse([
      { type: 'response.created', response: { id: 'resp_final', created_at: 1790000000, model: 'gpt-6.1-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_final' } },
      { type: 'response.output_text.delta', item_id: 'msg_final', output_index: 0, delta: 'Done.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_final' } },
      { type: 'response.completed', response: { usage: openAiUsage } }
    ], false)
}

/** Serves `toolCall(1)`, `toolCall(2)`, then `answer()` unless a script is given; records each
 *  request body. */
function scriptedFetch(
  turn: typeof anthropicTurn | typeof openRouterTurn | typeof openAiTurn,
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
  lane: 'anthropic' | 'openrouter-claude' | 'openrouter-other' | 'openrouter-openai' | 'openai' | 'openai-gpt55',
  overrides: Partial<NativeModeRequest> = {},
  path: 'stream' | 'delegated' = 'stream',
  script?: (turn: any) => Array<() => Response>,
  configureTools?: (tools: ReturnType<typeof echoTools>) => void,
  prepareRequest?: (brain: VercelAIBrain, request: NativeModeRequest, bodies: readonly Body[]) => Promise<void>,
  observePart?: (part: any) => void,
  recordStoppedTools = false
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
  } else if (lane === 'openai' || lane === 'openai-gpt55') {
    const modelId = lane === 'openai' ? 'gpt-6.1-sol' : 'gpt-5.5'
    slot.model = createOpenAI({ apiKey: 'test-key', fetch: scriptedFetch(openAiTurn, bodies, script?.(openAiTurn)) })(modelId)
    request = {
      model: modelId,
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' } as any,
      messages: []
    }
  } else {
    const modelId = lane === 'openrouter-claude' ? 'anthropic/claude-sonnet-5' : lane === 'openrouter-openai' ? 'openai/gpt-6.1-sol' : 'openai/gpt-5.5'
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
  ;(brain as any).buildToolsForMode3 = vi.fn(async () => { const tools = echoTools(); configureTools?.(tools); return tools })
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
  await prepareRequest?.(brain, fullRequest, bodies)
  if (path === 'delegated') {
    // The API Subagent / Worker path (`subagentRunner.runApiSubagent`): non-streaming, no steers.
    await brain.processNativeMode(fullRequest)
    return bodies
  }
  const result: any = await brain.streamNativeMode(fullRequest)
  const stream = recordStoppedTools ? withToolResultsOnStop(result.stream, fullRequest.abortSignal) : result.stream
  for await (const part of stream) {
    observePart?.(part)
    // How many requests reached the provider before the failure (none: nothing was sent).
    if (part?.type === 'error') throw Object.assign(part.error, { requestsSent: bodies.length })
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

  it('direct Anthropic: exactly one tail point on every request, the first included (BL-1976)', async () => {
    const bodies = await runTurn('anthropic')
    expect(bodies).toHaveLength(3)

    for (const body of bodies) {
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

    // Request 1 (BL-1976): the step-start message, the last one Batshit compiled, carries it.
    expect(bodies[0].messages).toHaveLength(2)
    expect(bodies[0].messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: FIRST_USER_MESSAGE, cache_control: { type: 'ephemeral' } }]
    })
    for (const body of bodies) {
      // Never the request-level field: OpenRouter's Bedrock route ignores it.
      expect(body.cache_control).toBeUndefined()
      expect(body.messages[0].role).toBe('system')
      expect(blockCacheMarkers(body.messages[0])).toEqual([{ type: 'ephemeral' }])
    }
    for (const body of bodies) {
      // Exactly one tail marker, on the last message, and nowhere else.
      expect(blockCacheMarkers(body.messages.slice(1))).toEqual([{ type: 'ephemeral' }])
      expect(blockCacheMarkers(body.messages.at(-1))).toEqual([{ type: 'ephemeral' }])
    }
    // Request 2 on: the step-start message is back to the plain string it is unmarked.
    for (const body of bodies.slice(1)) expect(body.messages[1]).toEqual({ role: 'user', content: FIRST_USER_MESSAGE })
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

describe('Agent Setup owns actual SDK registrations and model-call activity', () => {
  const live: LiveAgentSetup = { sources: [{ id: 'tools', label: 'Tools', available: true }],
    blocks: [{ key: 'echo', source: 'tools', section: 'tools', order: 0, text: '- echo',
      items: [{ key: 'echo', label: 'echo', text: 'echo' }] }] }
  beforeEach(() => agentSetupCache.clearAll())
  afterEach(() => { vi.restoreAllMocks(); agentSetupCache.clearAll() })

  it('reuses the exact prepared toolset for every real SDK wire request and stamps only issued requests', async () => {
    const stamps = vi.spyOn(agentSetupCache, 'modelCalled')
    let build: any
    let registered: ReturnType<typeof echoTools>
    let observed = 0
    const bodies = await runTurn('anthropic', { onApiModelInput: () => {
      expect(stamps).toHaveBeenCalledTimes(observed++)
    } }, 'stream', undefined, tools => { registered = tools }, async (brain, request) => {
      build = (brain as any).buildToolsForMode3
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      expect(build).toHaveBeenCalledTimes(1)
      expect(request.preparedApiToolset.fingerprint).toBe(fingerprintRegisteredTools(registered!.tools))
      expect(serializeRegisteredTools(registered!.tools)[0]).toMatchObject({ name: 'echo',
        inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } })
      request.agentSetup = agentSetupCache.prepare({ identity: { userId: request.userId!, sessionId: request.sessionId!, agentId: request.agentId! },
        live, precedingBytes: SYSTEM_PROMPT, toolFingerprint: request.preparedApiToolset.fingerprint })
      expect(stamps).not.toHaveBeenCalled()
    })
    expect(bodies).toHaveLength(3)
    expect(build).toHaveBeenCalledTimes(1)
    expect(stamps).toHaveBeenCalledTimes(3)
    expect(observed).toBe(3)
    for (const body of bodies) expect(body.tools).toEqual(bodies[0].tools)
    expect(bodies[0].tools[0]).toMatchObject({ name: 'echo', description: 'Echo a value back.' })
  })

  it('fingerprints the final provider-defined additions and preserves their converted wire order', async () => {
    let build: any
    let preparedTools: any
    const bodies = await runTurn('openai', { providerSettings: { openaiWebSearchTool: true,
      openaiWebSearchExternalAccess: false, openaiWebSearchContextSize: 'low' } }, 'stream', undefined, undefined, async (brain, request) => {
      vi.spyOn(brain as any, 'getOpenAIClient').mockResolvedValue(createOpenAI({ apiKey: 'fixture-key' }))
      build = (brain as any).buildToolsForMode3
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      preparedTools = (brain as any).preparedApiToolsets.get(request.preparedApiToolset).tools
      const definitions = serializeRegisteredTools(preparedTools)
      expect(definitions.map(entry => entry.name)).toEqual(['echo', 'web_search'])
      expect(definitions[1]).toMatchObject({ id: 'openai.web_search', args: { externalWebAccess: false, searchContextSize: 'low' } })
      expect(request.preparedApiToolset.fingerprint).toBe(fingerprintRegisteredTools(preparedTools))
      expect(request.preparedApiToolset.fingerprint).not.toBe(fingerprintRegisteredTools({ echo: preparedTools.echo }))
    })
    expect(build).toHaveBeenCalledTimes(1)
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body.tools.map((entry: any) => entry.type === 'function' ? entry.name : entry.type)).toEqual(['echo', 'web_search'])
      expect(body.tools[1]).toMatchObject({ type: 'web_search', external_web_access: false, search_context_size: 'low' })
    }
  })

  it.each(['actor', 'session', 'delegated', 'signal', 'definitions', 'forged'] as const)('refuses changed %s before any provider request', async change => {
    const stamps = vi.spyOn(agentSetupCache, 'modelCalled')
    let registered: ReturnType<typeof echoTools>
    let sent: readonly Body[] = []
    const failure = await runTurn('anthropic', {}, 'stream', undefined, tools => { registered = tools }, async (brain, request, bodies) => {
      sent = bodies
      const prepared = await brain.prepareApiToolset(request)
      request.preparedApiToolset = change === 'forged' ? { ...prepared } : prepared
      if (change === 'actor') request.agentId = 'another-agent'
      if (change === 'session') request.sessionId = 'another-session'
      if (change === 'delegated') request.scopeAgentId = 'another-actor'
      if (change === 'signal') request.abortSignal = new AbortController().signal
      if (change === 'definitions') registered!.tools.echo.description = 'Changed after compilation'
    }).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain(change === 'definitions' ? 'definitions changed before dispatch' : 'prepared API tool owner changed')
    expect(sent).toHaveLength(0)
    expect(stamps).not.toHaveBeenCalled()
  })
})

describe('API Web Search through the actual eligible utility bridge', () => {
  const ref = 'batshit:sys.web_search.search'
  const native = { bashEnabled: false, webSearchEnabled: true, dynamicMcpEnabled: false, cliToolsEnabled: false,
    batshitToolsEnabled: false, artifactRuntimeEnabled: false, agentBrowserEnabled: false, fetchZipEnabled: false }
  let originalExecute: ((operation: any) => Promise<any>) | undefined
  beforeEach(() => {
    // The existing raw fake omits node-redis's camel-case list aliases. Audit
    // persistence uses the same existing fake lists, not a substitute audit result.
    if (vi.isMockFunction(redis.execute)) {
      originalExecute = vi.mocked(redis.execute).getMockImplementation()
      if (!originalExecute) throw new Error('The existing Redis execute fixture is unavailable.')
      const execute = originalExecute
      vi.mocked(redis.execute).mockImplementation(operation => execute((client: any) => operation({
        ...client, lPush: client.lPush ?? ((key: string, value: string) => redis.lpush(key, value)),
        lTrim: client.lTrim ?? ((key: string, start: number, end: number) => redis.ltrim(key, start, end))
      })))
    }
  })
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals()
    if (originalExecute) vi.mocked(redis.execute).mockImplementation(originalExecute)
    originalExecute = undefined
  })

  function actualNativeOwner(brain: VercelAIBrain, observed: any[], name: string | string[] = 'native_web_search') {
    const actual = (VercelAIBrain.prototype as any).buildToolsForMode3.bind(brain)
    const build = vi.fn(async (...args: any[]) => {
      const built = await actual(...args)
      for (const toolName of Array.isArray(name) ? name : [name]) {
      const web = built.tools?.[toolName]
      if (web) {
        const execute = web.execute
        web.execute = (input: unknown, options: unknown) => {
          observed.push({ input, options })
          return execute.call(web, input, options)
        }
      }
      }
      return built
    })
    ;(brain as any).buildToolsForMode3 = build
    return build
  }

  async function wireSkill(enabledAgentIds = ['agent-1']) {
    for (const [key, row] of initializedBuiltinPluginEntries('user-1')) await redis.set(key, row)
    await redis.set('slash_command:user-1:wire_skill', { id: 'wire_skill', user_id: 'user-1', name: 'wire_skill', displayName: 'Wire Skill',
      type: 'skill', skill_id: 'wire_skill', is_active: true, can_be_invoked_in_chat: true,
      enabled_for_all_agents: false, enabled_agent_ids: enabledAgentIds })
    const registry = await import('../skillRegistry')
    return vi.spyOn(registry, 'getSkill').mockResolvedValue({ id: 'wire_skill', user_id: 'user-1', name: 'wire_skill', displayName: 'Wire Skill',
      description: 'Fixture skill', skill_markdown: '# Wire Skill\nKeep this markdown.', trust_level: 'untrusted', has_scripts: true,
      bundle_files: [{ path: 'references/long.md', kind: 'reference', encoding: 'utf8', content: 'A'.repeat(137), sha256: 'fixture', size: 137 },
        { path: 'scripts/run.sh', kind: 'script', encoding: 'utf8', content: 'echo forbidden', sha256: 'fixture', size: 14 }] } as any)
  }

  it('keeps the real SDK call IDs/options and single outer tracking event across multiple utility steps', async () => {
    const late = await import('../lateToolResults')
    const track = vi.spyOn(late, 'trackToolExecution')
    const search = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input)).toMatch(/^https:\/\/duckduckgo\.com\/html\//)
      return new Response('<div class="result"><a class="result__a" href="https://example.test/">Fixture</a><span class="result__snippet">Saved result.</span></div>')
    })
    const observed: any[] = [], parts: any[] = []
    let build: any
    const bodies = await runTurn('anthropic', { abortSignal: new AbortController().signal,
      providerSettings: { nativeTools: native }, assignedSubagents: [],
      selectedGateways: [], selectedCliToolIds: [], workersEnabled: false }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref, input: { query: 'first' } }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref, input: { query: 'second' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      build = actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      const prepared = (brain as any).preparedApiToolsets.get(request.preparedApiToolset)
      expect(prepared.tools).not.toHaveProperty('native_web_search')
      expect(prepared.tools).toHaveProperty('native_batshit_tool_use')
      expect(request.preparedApiToolset.apiUtilityScope).toBeDefined()
    }, part => parts.push(part))
    expect(build).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledTimes(2)
    expect(bodies).toHaveLength(3)
    expect(observed.map(row => row.input)).toEqual([{ query: 'first' }, { query: 'second' }])
    expect(observed.map(row => row.options.toolCallId)).toEqual(['toolu_1', 'toolu_2'])
    for (const row of observed) {
      expect(row.options.abortSignal).toBeInstanceOf(AbortSignal)
      expect(row.options.messages).toBeInstanceOf(Array)
    }
    expect(track.mock.calls.map(([, callId, name]) => [callId, name])).toEqual([
      ['toolu_1', 'native_batshit_tool_use'], ['toolu_2', 'native_batshit_tool_use']
    ])
    const results = parts.filter(part => part.type === 'tool-result')
    expect(results.map(part => part.toolCallId)).toEqual(['toolu_1', 'toolu_2'])
    for (const part of results) expect(part.output).toMatchObject({ ref, controlId: 'sys.web_search.search', family: 'batshit',
      operationKind: 'web_search', rendererFamily: 'web_search', success: true, result: { provider: 'duckduckgo-html' } })
    for (const body of bodies) expect(body.tools.some((entry: any) => entry.name === 'native_web_search')).toBe(false)
    expect(JSON.stringify(bodies[1].messages)).toContain('Saved result.')
    const returned = bodies[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .find((part: any) => part.type === 'tool_result' && part.tool_use_id === 'toolu_1')
    const returnedText = typeof returned.content === 'string' ? returned.content
      : returned.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
    const nativeModelResult = JSON.parse(returnedText)
    expect(nativeModelResult).toMatchObject({ provider: 'duckduckgo-html', query: 'first', results: [{ snippet: 'Saved result.' }] })
    expect(nativeModelResult).not.toHaveProperty('ref')
    expect(nativeModelResult).not.toHaveProperty('controlId')
    const auditKeys = await redis.keys('control_audit:user-1:*')
    expect(auditKeys).toHaveLength(2)
    for (const key of auditKeys) expect(await redis.get(key)).toMatchObject({ controlId: 'sys.web_search.search', success: true,
      actorType: 'in-process', agentId: 'agent-1', sessionId: 'sess-bl77' })
    expect(await redis.lrange('recent_control_executions:user-1', 0, -1)).toHaveLength(2)
  })

  it('preserves original native schema refusal and strips provider/identity aliases before the actual callback', async () => {
    const search = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>'))
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { providerSettings: { nativeTools: native }, assignedSubagents: [],
      selectedGateways: [], selectedCliToolIds: [], workersEnabled: false }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref, input: { query: '' } }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref, input: { query: 'valid', provider: 'exa',
        exaSearchType: 'deep', user_id: 'foreign', session_id: 'foreign', scopeAgentId: 'foreign' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part))
    expect(observed).toHaveLength(1)
    expect(observed[0].input).toEqual({ query: 'valid' })
    expect(observed[0].options.toolCallId).toBe('toolu_2')
    expect(search).toHaveBeenCalledTimes(1)
    const results = parts.filter(part => part.type === 'tool-result')
    expect(results[0].output).toMatchObject({ success: false, ref, error: { code: 'CONTROL_INPUT_INVALID' } })
    expect(results[1].output).toMatchObject({ success: true, ref, result: { provider: 'duckduckgo-html' } })
  })

  it('refuses flat and params-only API utility arguments before search while keeping canonical nested execution/formatting', async () => {
    const search = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>'))
    const observed: any[] = [], parts: any[] = []
    const bodies = await runTurn('anthropic', { providerSettings: { nativeTools: native }, assignedSubagents: [],
      selectedGateways: [], selectedCliToolIds: [], workersEnabled: false }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref, query: 'flat' }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref, params: { query: 'params' } }),
      () => turn.toolCall(3, 'native_batshit_tool_use', { ref, input: {}, query: 'flat-again', params: { query: 'params-again' } }),
      () => turn.toolCall(4, 'native_batshit_tool_use', { ref, input: { query: 'nested' }, query: 'ignored', params: { query: 'ignored' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part))
    expect(search).toHaveBeenCalledTimes(1)
    expect(observed.map(row => [row.input, row.options.toolCallId])).toEqual([[{ query: 'nested' }, 'toolu_4']])
    const results = parts.filter(part => part.type === 'tool-result').map(part => part.output)
    expect(results).toHaveLength(4)
    for (const result of results.slice(0, 3)) {
      expect(result).toMatchObject({ ref, success: false, error: { code: 'CONTROL_INPUT_INVALID' } })
      expect(result).not.toHaveProperty('result')
    }
    expect(results[3]).toMatchObject({ ref, success: true, result: { query: 'nested' } })
    expect(JSON.stringify(bodies[4].messages)).toContain('nested')
  })

  it('requires the exact batshit utility namespace even when broad Fabric is enabled', async () => {
    await redis.set('agent:agent-1', { id: 'agent-1', user_id: 'user-1', agentType: 'api' })
    const search = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>'))
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { providerSettings: { nativeTools: { ...native, batshitToolsEnabled: true } }, assignedSubagents: [],
      selectedGateways: [], selectedCliToolIds: [], workersEnabled: false }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: 'fabric:sys.web_search.search', input: { query: 'wrong-family' } }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref, input: { query: 'canonical' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part))
    expect(search).toHaveBeenCalledTimes(1)
    expect(observed.map(row => row.input)).toEqual([{ query: 'canonical' }])
    const results = parts.filter(part => part.type === 'tool-result').map(part => part.output)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ref, family: 'batshit', success: true, result: { query: 'canonical' } })
    const refused = parts.filter(part => part.type === 'tool-error')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ toolCallId: 'toolu_1', toolName: 'native_batshit_tool_use' })
    expect(String(refused[0].error)).toContain('requires the canonical ref batshit:sys.web_search.search')
  })

  it.each(['BATSHIT:sys.web_search.search', 'batshit: sys.web_search.search'])('refuses a raw noncanonical API utility ref before effect (%s)', async noncanonical => {
    const search = vi.spyOn(globalThis, 'fetch')
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { providerSettings: { nativeTools: native }, assignedSubagents: [],
      selectedGateways: [], selectedCliToolIds: [], workersEnabled: false }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: noncanonical, input: { query: 'must not execute' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part))
    expect(search).not.toHaveBeenCalled()
    expect(observed).toEqual([])
    expect(parts.filter(part => part.type === 'tool-result').map(part => part.output)).toEqual([
      expect.objectContaining({ ref: noncanonical, success: false, code: 'OUT_OF_SCOPE', error: 'This API utility requires the exact ref batshit:sys.web_search.search.' })
    ])
    expect(parts.some(part => part.type === 'tool-approval-request')).toBe(false)
  })

  it('routes the eligible Worker batch through the original runner with saved parent/Stop, partial usage and readable caps', async () => {
    const runners = await import('../subagentRunner')
    const child = vi.spyOn(runners, 'executeManagedSubagent').mockImplementation(async input => ({
      status: input.chatInput === 'fails' ? 'failed' : 'completed', output: input.chatInput === 'fails' ? 'Fixture failure' : 'Fixture answer',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, modelId: 'fixture-child', provider: 'fixture', durationMs: 2,
      intermediateSteps: []
    }))
    const observed: any[] = [], parts: any[] = []
    const stop = new AbortController()
    const workerRef = 'batshit:sys.workers.spawn'
    const bodies = await runTurn('anthropic', { abortSignal: stop.signal, providerSettings: { nativeTools: { ...native, webSearchEnabled: false } },
      workersEnabled: true, assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [], messageId: 'worker-utility-wire' }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: workerRef, input: { workers: [
        { task: 'works', role: 'one', user_id: 'forged' }, { task: 'fails' }
      ], parentAgentId: 'forged', sessionId: 'forged' } }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref: workerRef, input: { workers: Array.from({ length: 7 }, () => ({ task: 'too many' })) } }),
      () => turn.toolCall(3, 'native_batshit_tool_use', { ref: workerRef, input: { workers: [{ task: 'unknown', base: 'unassigned' }] } }),
      () => turn.toolCall(4, 'native_batshit_tool_use', { ref: workerRef, input: { workers: [] } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed, 'native_spawn_workers')
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      const prepared = (brain as any).preparedApiToolsets.get(request.preparedApiToolset)
      expect(prepared.tools).not.toHaveProperty('native_spawn_workers')
      expect(readApiUtilities(request.preparedApiToolset.apiUtilityScope, request).map(entry => entry.controlId)).toEqual(['sys.skill.use', 'sys.workers.spawn'])
    }, part => parts.push(part))
    expect(observed).toHaveLength(3)
    expect(observed.map(row => row.options.toolCallId)).toEqual(['toolu_1', 'toolu_2', 'toolu_3'])
    expect(observed[0].input).toEqual({ workers: [{ task: 'works', role: 'one' }, { task: 'fails' }] })
    expect(child).toHaveBeenCalledTimes(2)
    for (const [input] of child.mock.calls) expect(input).toMatchObject({ userId: 'user-1', sessionId: 'sess-bl77',
      parentAgentId: 'agent-1', parentMessageId: 'worker-utility-wire', abortSignal: stop.signal,
      toolApprovalMode: 'off', delegationKind: 'worker' })
    const results = parts.filter(part => part.type === 'tool-result').map(part => part.output)
    expect(results[0]).toMatchObject({ ref: workerRef, controlId: 'sys.workers.spawn', operationKind: 'workers', rendererFamily: 'workers',
      result: { kind: 'workers', success: true, requested: 2, completed: 1, workers: [
        { status: 'completed', usage: { totalTokens: 10 } }, { status: 'failed', output: 'Fixture failure', usage: { totalTokens: 10 } }
      ] } })
    expect(results[0].result.workers.every((worker: any) => !Object.hasOwn(worker, 'subagentId'))).toBe(true)
    expect(results[1]).toMatchObject({ success: false, result: { kind: 'workers', success: false, error: 'worker_batch_too_large', workers: [] } })
    expect(results[1].result.message).toBe('You asked for 7 workers in one call; Batshit runs at most 6 per call. Send 6 or fewer.')
    expect(results[2]).toMatchObject({ success: false, result: { kind: 'workers', success: false, error: 'unknown_base', workers: [] } })
    expect(results[3]).toMatchObject({ success: false, error: { code: 'CONTROL_INPUT_INVALID' } })
    expect(results[3]).not.toHaveProperty('result')
    for (const body of bodies) expect(body.tools.some((entry: any) => entry.name === 'native_spawn_workers')).toBe(false)
    expect(JSON.stringify(bodies[1].messages)).toContain('Fixture answer')
  })

  it('carries the original Worker parent Stop through a running batch and keeps its stopped result on the actual broker call', async () => {
    const runners = await import('../subagentRunner')
    const stop = new AbortController()
    let entered!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const child = vi.spyOn(runners, 'executeManagedSubagent').mockImplementation(async input => {
      expect(input.abortSignal).toBe(stop.signal)
      await new Promise<void>(resolve => { input.abortSignal!.addEventListener('abort', () => resolve(), { once: true }); entered() })
      return { status: 'failed', output: 'Worker stopped.', usage: null, modelId: 'fixture-child', provider: 'fixture', durationMs: 1, intermediateSteps: [] }
    })
    const observed: any[] = [], parts: any[] = []
    const pending = runTurn('anthropic', { abortSignal: stop.signal, providerSettings: { nativeTools: { ...native, webSearchEnabled: false } },
      workersEnabled: true, assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [], messageId: 'worker-utility-stop' }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: 'batshit:sys.workers.spawn', input: { workers: [{ task: 'wait' }] } })
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed, 'native_spawn_workers')
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part), true)
    await reached
    stop.abort('user')
    await pending
    expect(child).toHaveBeenCalledTimes(1)
    expect(observed[0].options.toolCallId).toBe('toolu_1')
    expect(parts.filter(part => part.type === 'tool-result')).toEqual([expect.objectContaining({ toolCallId: 'toolu_1', toolName: 'native_batshit_tool_use',
      output: expect.objectContaining({ result: expect.objectContaining({ kind: 'workers', workers: [expect.objectContaining({ status: 'failed', output: 'Worker stopped.' })] }) }) })])
  })

  it('keeps permitted delegated Web Search while refusing nested Workers from the same real broker', async () => {
    await redis.set('agent:agent-1', { id: 'agent-1', user_id: 'user-1', agentType: 'api', provider_specific_settings: { nativeTools: native } })
    const search = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>'))
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { abortSignal: new AbortController().signal, scopeAgentId: 'child-own-scope',
      providerSettings: { nativeTools: native }, assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [], workersEnabled: false },
    'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref, input: { query: 'delegated' } }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref: 'batshit:sys.workers.spawn', input: { workers: [{ task: 'not allowed' }] } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      const prepared = (brain as any).preparedApiToolsets.get(request.preparedApiToolset)
      expect(prepared.tools).not.toHaveProperty('native_spawn_workers')
      expect(prepared.maps.subagentTools.size).toBe(0)
    }, part => parts.push(part))
    expect(observed).toHaveLength(1)
    expect(observed[0].input).toEqual({ query: 'delegated' })
    expect(search).toHaveBeenCalledTimes(1)
    const results = parts.filter(part => part.type === 'tool-result')
    expect(results[0].output).toMatchObject({ success: true, result: { provider: 'duckduckgo-html' } })
    expect(results[1].output).toMatchObject({ success: false, code: 'OUT_OF_SCOPE' })
    expect(results[1].output).not.toHaveProperty('result')
  })

  it.each(['off', 'tools-disabled'] as const)('does not create utility authority when Web Search is %s', async mode => {
    const search = vi.spyOn(globalThis, 'fetch')
    const observed: any[] = []
    await runTurn('anthropic', { providerSettings: { nativeTools: { ...native, webSearchEnabled: mode !== 'off' } },
      ...(mode === 'tools-disabled' ? { toolsEnabled: false } : {}), assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [] },
    'stream', turn => [() => turn.answer()], undefined, async (brain, request) => {
      const build = actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      const prepared = (brain as any).preparedApiToolsets.get(request.preparedApiToolset)
      expect(readApiUtilities(request.preparedApiToolset.apiUtilityScope, request).map(entry => entry.controlId))
        .toEqual(mode === 'tools-disabled' ? [] : ['sys.skill.use'])
      expect(prepared.tools ?? {}).not.toHaveProperty('native_web_search')
      if (mode === 'tools-disabled') expect(prepared.tools ?? {}).not.toHaveProperty('native_batshit_tool_use')
      expect(build).toHaveBeenCalledTimes(mode === 'tools-disabled' ? 0 : 1)
    })
    expect(search).not.toHaveBeenCalled()
    expect(observed).toEqual([])
  })

  it('migrates Skill invoke/list/read through the real access/runtime and original formatter, preserving offsets and failure paths', async () => {
    const load = await wireSkill()
    const observed: any[] = [], parts: any[] = []
    const skillRef = 'batshit:sys.skill.use'
    const bodies = await runTurn('anthropic', { providerSettings: { nativeTools: { ...native, webSearchEnabled: false } },
      workersEnabled: false, assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [] }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: skillRef, input: { skillId: 'wire_skill', user_id: 'foreign', scopeAgentId: 'foreign' } }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref: skillRef, input: { skillId: 'wire_skill', action: 'list' } }),
      () => turn.toolCall(3, 'native_batshit_tool_use', { ref: skillRef, input: { skillId: 'wire_skill', action: 'read', path: 'references/long.md', maxChars: 64, offset: 64 } }),
      () => turn.toolCall(4, 'native_batshit_tool_use', { ref: skillRef, input: { skillId: 'wire_skill', action: 'read', path: 'references/missing.md' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed, 'native_skill')
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      const prepared = (brain as any).preparedApiToolsets.get(request.preparedApiToolset)
      expect(prepared.tools.native_skill.inputSchema.safeParse({ skillId: 'wire_skill', action: 'script_run', path: 'scripts/run.sh' }).success).toBe(true)
      expect(prepared.tools.native_skill.inputSchema.safeParse({ skillId: 'wire_skill', action: 'invoke' }).success).toBe(false)
      const utility = readApiUtilities(request.preparedApiToolset.apiUtilityScope, request).find(entry => entry.controlId === 'sys.skill.use')!
      expect(utility.inputSchema.safeParse({ skillId: 'wire_skill', action: 'script_run' }).success).toBe(false)
      expect(utility.inputSchemaJson.properties).not.toHaveProperty('args')
    }, part => parts.push(part))
    expect(load).toHaveBeenCalledTimes(4)
    expect(observed[0].input).toEqual({ skillId: 'wire_skill' })
    expect(observed.map(row => row.options.toolCallId)).toEqual(['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4'])
    const results = parts.filter(part => part.type === 'tool-result').map(part => part.output)
    expect(results[0]).toMatchObject({ ref: skillRef, operationKind: 'skill_read', rendererFamily: 'skill_read', result: {
      success: true, action: 'invoke', skillMarkdown: '# Wire Skill\nKeep this markdown.', skill: { scripts: ['scripts/run.sh'], references: ['references/long.md'] },
      warnings: expect.arrayContaining([expect.stringContaining('untrusted')]) } })
    expect(results[1]).toMatchObject({ operationKind: 'unknown_tool', rendererFamily: 'generic_tool', result: { action: 'list', references: ['SKILL.md', 'references/long.md'] } })
    expect(results[2]).toMatchObject({ result: { action: 'read', offset: 64, nextOffset: 128, content: 'A'.repeat(64) } })
    expect(results[3]).toMatchObject({ success: false, result: { success: false, availableReferences: ['SKILL.md', 'references/long.md'] } })
    const modelText = JSON.stringify(bodies.at(-1)?.messages)
    expect(modelText).toContain('==== SKILL: Wire Skill (wire_skill) ====')
    expect(modelText).toContain('skill_warnings:')
    expect(modelText).toContain('Active skill references (2)')
    expect(modelText).toContain('\\"offset\\":128')
    expect(modelText).toContain('batshit:sys.skill.use')
    expect(modelText).toContain('Available references:')
    expect(modelText).not.toContain('call native_skill again')
  })

  it.each(['script_list', 'script_read', 'script_run', 'run_script', 'run', 'scripts'])('does not admit script action/alias %s through Skill utility', async action => {
    const load = await wireSkill()
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { providerSettings: { nativeTools: { ...native, webSearchEnabled: false } }, workersEnabled: false,
      assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [] }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: 'batshit:sys.skill.use', input: { skillId: 'wire_skill', action, path: 'scripts/run.sh' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed, 'native_skill')
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part))
    expect(load).not.toHaveBeenCalled()
    expect(observed).toEqual([])
    expect(parts.filter(part => part.type === 'tool-result').map(part => part.output)).toEqual([
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'CONTROL_INPUT_INVALID' }) })
    ])
    expect(parts.some(part => part.type === 'tool-approval-request')).toBe(false)
  })

  it.each([true, false])('keeps the delegated Skill scope instead of the parent/body identity (child allowed=%s)', async allowed => {
    const load = await wireSkill(allowed ? ['child-own-scope'] : ['agent-1'])
    await redis.set('agent:agent-1', { id: 'agent-1', user_id: 'user-1', agentType: 'api', provider_specific_settings: { nativeTools: native } })
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { scopeAgentId: 'child-own-scope', providerSettings: { nativeTools: { ...native, webSearchEnabled: false } },
      workersEnabled: false, assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [] }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: 'batshit:sys.skill.use', input: { skillId: 'wire_skill', scopeAgentId: 'agent-1', agentId: 'agent-1' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed, 'native_skill')
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part))
    expect(observed.map(row => row.input)).toEqual([{ skillId: 'wire_skill' }])
    const result = parts.find(part => part.type === 'tool-result')?.output
    if (allowed) {
      expect(load).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ success: true, result: { action: 'invoke', skill: { id: 'wire_skill' } } })
    } else {
      expect(load).not.toHaveBeenCalled()
      expect(result).toMatchObject({ success: false, result: { success: false, blocked: true, errorCode: 'SKILL_NOT_ENABLED' } })
    }
  })

  it('keeps the original direct Skill script SDK approval boundary before execution', async () => {
    const load = await wireSkill()
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { providerSettings: { nativeTools: { ...native, webSearchEnabled: false, bashEnabled: true, bashAccessMode: 'agent' } },
      toolApprovalMode: 'all', workersEnabled: false, assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [] }, 'stream', turn => [
      () => turn.toolCall(1, 'native_skill', { skillId: 'wire_skill', action: 'script_run', path: 'scripts/run.sh' })
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed, 'native_skill')
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part))
    expect(observed).toEqual([])
    expect(load).not.toHaveBeenCalled()
    expect(parts.filter(part => part.type === 'tool-approval-request')).toEqual([expect.objectContaining({ toolCall: expect.objectContaining({ toolName: 'native_skill', toolCallId: 'toolu_1' }) })])
  })

  it('routes exact assigned Subagent slugs through original stripped schemas and retains captured child identity/results/options', async () => {
    const runners = await import('../subagentRunner')
    const { SubagentBusyError } = await import('../subagentThreads')
    const child = vi.spyOn(runners, 'executeManagedSubagent').mockImplementation(async input => {
      if (input.subagent.id === 'saved_busy') throw new SubagentBusyError('Saved Busy', 1)
      return { status: input.subagent.id === 'saved_partial' ? 'partial' : 'completed', output: 'Saved child answer',
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, subagentType: input.subagent.subagentType,
        modelId: 'child-model', provider: 'child-provider', durationMs: 3,
        intermediateSteps: [{ toolName: 'read_file', toolResult: { content: 'Nested step' } }], thread: input.thread === 'resume' ? 'resumed' : 'fresh',
        threadNote: input.subagent.id === 'saved_partial' ? 'Partial fixture note' : undefined } as any
    })
    const stop = new AbortController(), observed: any[] = [], parts: any[] = []
    const assigned = [
      { id: 'saved_child', slug: 'researcher', user_id: 'user-1', displayName: 'Saved Child', subagentType: 'api', avatar: 'saved-avatar' },
      // SA-139 R5: this second child was a CLI Subagent until that type was removed.
      { id: 'saved_partial', slug: 'partial_helper', user_id: 'user-1', displayName: 'Saved Partial', subagentType: 'api' },
      { id: 'saved_busy', slug: 'busy_helper', user_id: 'user-1', displayName: 'Saved Busy', subagentType: 'api' }
    ]
    const subagentRef = 'batshit:sys.subagent.call'
    const bodies = await runTurn('anthropic', { abortSignal: stop.signal, providerSettings: { nativeTools: { ...native, webSearchEnabled: false } },
      workersEnabled: false, assignedSubagents: assigned, selectedGateways: [], selectedCliToolIds: [] }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: subagentRef, input: { slug: 'researcher', chatInput: 'Brief', thread: 'resume',
        user_id: 'forged', userId: 'forged', session_id: 'forged', sessionId: 'forged', parentAgentId: 'forged', subagentId: 'forged' } }),
      () => turn.toolCall(2, 'native_batshit_tool_use', { ref: subagentRef, input: { slug: 'partial_helper', chatInput: 'Partial brief' } }),
      () => turn.toolCall(3, 'native_batshit_tool_use', { ref: subagentRef, input: { slug: 'busy_helper', chatInput: 'Busy brief' } }),
      () => turn.toolCall(4, 'native_batshit_tool_use', { ref: subagentRef, input: { slug: 'unassigned', chatInput: 'Must not run' } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed, assigned.map(row => row.id))
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      const prepared = (brain as any).preparedApiToolsets.get(request.preparedApiToolset)
      for (const row of assigned) expect(prepared.tools).not.toHaveProperty(row.id)
      const utility = readApiUtilities(request.preparedApiToolset.apiUtilityScope, request).find(entry => entry.controlId === 'sys.subagent.call')!
      expect(utility.targets?.map(target => target.metadata.slug)).toEqual(['busy_helper', 'partial_helper', 'researcher'])
    }, part => parts.push(part))
    expect(child).toHaveBeenCalledTimes(3)
    expect(observed.map(row => row.input)).toEqual([{ chatInput: 'Brief', thread: 'resume' }, { chatInput: 'Partial brief' }, { chatInput: 'Busy brief' }])
    expect(observed.map(row => row.options.toolCallId)).toEqual(['toolu_1', 'toolu_2', 'toolu_3'])
    for (const [input] of child.mock.calls) expect(input).toMatchObject({ userId: 'user-1', sessionId: 'sess-bl77', parentAgentId: 'agent-1',
      parentMessageId: 'msg-bl77', abortSignal: stop.signal, toolApprovalMode: 'off' })
    for (const [input] of child.mock.calls) expect(input).not.toHaveProperty('assignedSubagents')
    expect(child.mock.calls.map(([input]) => input.thread)).toEqual(['resume', 'fresh', 'fresh'])
    const results = parts.filter(part => part.type === 'tool-result').map(part => part.output)
    expect(results[0]).toMatchObject({ ref: subagentRef, controlId: 'sys.subagent.call', operationKind: 'subagent', rendererFamily: 'subagent',
      isSubagent: true, subagentId: 'saved_child', subagentName: 'Saved Child', subagentType: 'api', subagentAvatar: 'saved-avatar',
      result: { kind: 'subagent', success: true, status: 'completed', thread: 'resumed', usage: { totalTokens: 18 }, intermediateSteps: [{ toolName: 'read_file' }] } })
    expect(results[1]).toMatchObject({ subagentId: 'saved_partial', result: { success: true, status: 'partial', thread: 'fresh', threadNote: 'Partial fixture note' } })
    expect(results[2]).toMatchObject({ subagentId: 'saved_busy', success: false, result: { kind: 'subagent', error: 'subagent_busy', status: 'failed', thread: null } })
    expect(results[3]).toMatchObject({ success: false, error: { code: 'CONTROL_INPUT_INVALID' } })
    expect(results[3]).not.toHaveProperty('subagentId')
    for (const body of bodies) for (const row of assigned) expect(body.tools.some((tool: any) => tool.name === row.id)).toBe(false)
  })

  it('refuses ambiguous eligible Subagent slugs before any SDK request', async () => {
    const observed: any[] = []
    let issued: readonly Body[] = []
    await expect(runTurn('anthropic', { providerSettings: { nativeTools: { ...native, webSearchEnabled: false } }, workersEnabled: false,
      assignedSubagents: [{ id: 'one', slug: 'same', subagentType: 'api' }, { id: 'two', slug: 'same', subagentType: 'api' }],
      selectedGateways: [], selectedCliToolIds: [] }, 'stream', undefined, undefined, async (brain, request, bodies) => {
      issued = bodies
      actualNativeOwner(brain, observed, ['one', 'two'])
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    })).rejects.toThrow('eligible Subagent slug is missing or ambiguous')
    expect(issued).toHaveLength(0)
    expect(observed).toEqual([])
  })

  it('refuses an assigned SDK-name collision that removes the final utility broker before any request', async () => {
    const observed: any[] = []
    let issued: readonly Body[] = []
    await expect(runTurn('anthropic', { providerSettings: { nativeTools: { ...native, webSearchEnabled: false } }, workersEnabled: false,
      assignedSubagents: [{ id: 'native_batshit_tool_use', slug: 'colliding', subagentType: 'api' }], selectedGateways: [], selectedCliToolIds: [] },
    'stream', undefined, undefined, async (brain, request, bodies) => {
      issued = bodies
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    })).rejects.toMatchObject({ code: 'API_TOOL_NAME_COLLISION' })
    expect(issued).toHaveLength(0)
    expect(observed).toEqual([])
  })

  it.each([
    { key: 'native_skill', workers: false, web: false, saved: false },
    { key: 'native_spawn_workers', workers: true, web: false, saved: false },
    { key: 'native_web_search', workers: false, web: true, saved: false },
    { key: 'native_skill', workers: false, web: false, saved: true },
    { key: 'mixedcase', workers: false, web: false, saved: false, caseFold: true }
  ])('refuses Subagent SDK overwrite before replacing native/case-folded definitions ($key, saved=$saved)', async ({ key, workers, web, saved, caseFold }) => {
    const nativeModule = await import('../nativeTools')
    const indexModule = await import('../dynamicMcpIndex')
    const index = vi.spyOn(indexModule, 'buildDynamicMcpIndex')
    const prepare = vi.spyOn(agentSetupCache, 'prepare'), commit = vi.spyOn(agentSetupCache, 'commit'), clock = vi.spyOn(agentSetupCache, 'modelCalled')
    const cacheSize = agentSetupCache.size()
    const original = nativeModule.nativeToolService.buildMode3NativeTools
    let nativeSet: Awaited<ReturnType<typeof original>> | undefined
    let definitions: Array<[string, any]> = []
    vi.spyOn(nativeModule.nativeToolService, 'buildMode3NativeTools').mockImplementation(async context => {
      nativeSet = await original(context)
      definitions = Object.entries(nativeSet.tools)
      return nativeSet
    })
    const assigned = caseFold ? [{ id: 'MixedCase', slug: 'first', subagentType: 'api' }, { id: 'mixedcase', slug: 'second', subagentType: 'api' }]
      : [{ id: key, slug: 'colliding', subagentType: 'api' }]
    if (saved) {
      await redis.set('agent:agent-1', { id: 'agent-1', user_id: 'user-1', assignedSubagents: [key] })
      await redis.set(`subagent:${key}`, { ...assigned[0], user_id: 'user-1' })
    }
    const observed: any[] = []
    let issued: readonly Body[] = []
    await expect(runTurn('anthropic', { providerSettings: { nativeTools: { ...native, webSearchEnabled: web } }, workersEnabled: workers,
      assignedSubagents: saved ? undefined : assigned, selectedGateways: [], selectedCliToolIds: [] }, 'stream', undefined, undefined,
    async (brain, request, bodies) => {
      issued = bodies
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    })).rejects.toMatchObject({ code: 'API_TOOL_NAME_COLLISION', message: `The assigned Subagent SDK tool name "${key}" collides with an existing tool. Nothing was sent.` })
    expect(nativeSet).toBeDefined()
    for (const [name, definition] of definitions) expect(nativeSet!.tools[name]).toBe(definition)
    expect(issued).toHaveLength(0)
    expect(observed).toEqual([])
    expect(index).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(clock).not.toHaveBeenCalled()
    expect(agentSetupCache.size()).toBe(cacheSize)
  })

  it('does not mint a nested Subagent target from a parent-named body on a delegated run', async () => {
    const runners = await import('../subagentRunner')
    const child = vi.spyOn(runners, 'executeManagedSubagent')
    const observed: any[] = [], parts: any[] = []
    await runTurn('anthropic', { scopeAgentId: 'own-child', providerSettings: { nativeTools: { ...native, webSearchEnabled: false } },
      assignedSubagents: [], workersEnabled: false, selectedGateways: [], selectedCliToolIds: [] }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: 'batshit:sys.subagent.call', input: { slug: 'parent-helper', chatInput: 'Must not run', assignedSubagents: ['parent-helper'] } }),
      () => turn.answer()
    ], undefined, async (brain, request) => {
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
      expect(readApiUtilities(request.preparedApiToolset.apiUtilityScope, request).some(entry => entry.controlId === 'sys.subagent.call')).toBe(false)
    }, part => parts.push(part))
    expect(child).not.toHaveBeenCalled()
    expect(parts.filter(part => part.type === 'tool-result').map(part => part.output)).toEqual([
      expect.objectContaining({ success: false, code: 'OUT_OF_SCOPE' })
    ])
  })

  it('preserves the original Subagent Stop and captured child identity on one late SDK result', async () => {
    const runners = await import('../subagentRunner')
    const stop = new AbortController()
    let entered!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const child = vi.spyOn(runners, 'executeManagedSubagent').mockImplementation(async input => {
      expect(input.abortSignal).toBe(stop.signal)
      await new Promise<void>(resolve => { input.abortSignal!.addEventListener('abort', () => resolve(), { once: true }); entered() })
      return { status: 'failed', output: 'Subagent stopped.', usage: null, subagentType: 'api', modelId: 'fixture-child', provider: 'fixture', durationMs: 1,
        intermediateSteps: [], thread: 'fresh' } as any
    })
    const observed: any[] = [], parts: any[] = []
    let requests: readonly Body[] = []
    const pending = runTurn('anthropic', { abortSignal: stop.signal, providerSettings: { nativeTools: { ...native, webSearchEnabled: false } },
      workersEnabled: false, assignedSubagents: [{ id: 'saved_child', slug: 'researcher', subagentType: 'api', displayName: 'Saved Child' }],
      selectedGateways: [], selectedCliToolIds: [] }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref: 'batshit:sys.subagent.call', input: { slug: 'researcher', chatInput: 'Wait' } })
    ], undefined, async (brain, request, bodies) => {
      requests = bodies
      actualNativeOwner(brain, observed, 'saved_child')
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part), true)
    await reached
    stop.abort('user')
    await pending
    expect(child).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(1)
    expect(parts.filter(part => part.type === 'tool-result')).toEqual([expect.objectContaining({ toolCallId: 'toolu_1', toolName: 'native_batshit_tool_use',
      output: expect.objectContaining({ isSubagent: true, subagentId: 'saved_child', result: expect.objectContaining({ kind: 'subagent', status: 'failed', output: 'Subagent stopped.' }) }) })])
  })

  it('relays Stop into the actual search and records one stopped broker result under its real SDK call ID', async () => {
    const stop = new AbortController()
    let entered!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    let providerSignal: AbortSignal | undefined
    const search = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, options) => {
      providerSignal = options?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        providerSignal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
        entered()
      })
    })
    const observed: any[] = [], parts: any[] = []
    let requests: readonly Body[] = []
    const pending = runTurn('anthropic', { abortSignal: stop.signal, providerSettings: { nativeTools: native },
      assignedSubagents: [], selectedGateways: [], selectedCliToolIds: [], workersEnabled: false }, 'stream', turn => [
      () => turn.toolCall(1, 'native_batshit_tool_use', { ref, input: { query: 'stop fixture' } })
    ], undefined, async (brain, request, bodies) => {
      requests = bodies
      actualNativeOwner(brain, observed)
      request.preparedApiToolset = await brain.prepareApiToolset(request)
    }, part => parts.push(part), true)
    await reached
    expect(observed[0].options.toolCallId).toBe('toolu_1')
    expect(providerSignal?.aborted).toBe(false)
    stop.abort('user')
    await pending
    expect(search).toHaveBeenCalledTimes(1)
    expect(providerSignal?.aborted).toBe(true)
    expect(requests).toHaveLength(1)
    const results = parts.filter(part => part.type === 'tool-result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: 'toolu_1', toolName: 'native_batshit_tool_use',
      output: { ref, controlId: 'sys.web_search.search', success: false, result: { stopped: true, error: 'Search stopped.' } } })
  })
})

describe('BL-183 API Subagents and Workers get the tool-loop cache point (processNativeMode)', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('direct Anthropic: exactly one tail point on every request, the first included (BL-1976)', async () => {
    const bodies = await runTurn('anthropic', {}, 'delegated')
    expect(bodies).toHaveLength(3)

    for (const body of bodies) {
      expect(body.cache_control).toEqual({ type: 'ephemeral' })
      expect(blockCacheMarkers(body.messages)).toEqual([])
      expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
      expect(blockCacheMarkers(body).length + 1).toBeLessThanOrEqual(4)
    }
  })

  it('OpenRouter with a Claude model: the same rule (a marker on the last message, BL-185)', async () => {
    const bodies = await runTurn('openrouter-claude', {}, 'delegated')
    expect(bodies).toHaveLength(3)

    // BL-1976: request 1 marks the step-start message.
    expect(blockCacheMarkers(bodies[0].messages[1])).toEqual([{ type: 'ephemeral' }])
    for (const body of bodies) {
      expect(body.cache_control).toBeUndefined()
      // The system point stays on every request: the compiled system message is never touched.
      expect(blockCacheMarkers(body.messages[0])).toEqual([{ type: 'ephemeral' }])
    }
    for (const body of bodies) {
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

describe('BL-200 / BL-1976 an approval resume follows the same rule as any turn', () => {
  beforeEach(() => {
    slot.model = null
  })

  it('a tail point on its first request (the SDK has just run the approved tool) and on every later one', async () => {
    for (const approved of [true, false]) {
      const bodies = await runTurn('anthropic', { messages: approvalResumeMessages(approved) })
      expect(bodies).toHaveLength(3)

      // Request 1 already ends with the approved (or denied) tool's result …
      const first = stripCacheMarkers(bodies[0]) as Body
      expect(first.messages.at(-1).content.at(-1).type).toBe('tool_result')
      // … and, since BL-1976, writes it: the resume's first call writes, its second reads.
      for (const body of bodies) {
        expect(body.cache_control).toEqual({ type: 'ephemeral' })
        expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
      }
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

    // BL-1976: request 1's last message is the step-start message, and it carries the tail.
    expect(bodies[0].messages).toHaveLength(2)
    for (const body of bodies) {
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
    const raw = await runTurn('openrouter-claude')
    // BL-1976: the one other change. Marked on request 1, the step-start message is a one-block
    // array; unmarked from request 2 on, the provider sends it as a plain string again. Anthropic
    // reads the string as exactly that one text block.
    expect(raw[0].messages[1].content).toEqual([{ type: 'text', text: FIRST_USER_MESSAGE, cache_control: { type: 'ephemeral' } }])
    expect(raw[1].messages[1].content).toBe(FIRST_USER_MESSAGE)
    const oneBlockAsString = (body: Body): Body => ({
      ...body,
      messages: body.messages.map((message: any) =>
        Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === 'text' && message.role === 'user'
          ? { ...message, content: message.content[0].text }
          : message
      )
    })
    const bodies = raw.map((body) => oneBlockAsString(stripCacheMarkers(body) as Body))
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

  it('an approval resume: the replayed messages are never marked; the tail starts at the first request', async () => {
    const bodies = await runTurn('openrouter-claude', { messages: approvalResumeMessages() })
    expect(bodies).toHaveLength(3)

    // BL-1976: request 1 ends with the approved tool's result (the SDK ran it), which takes the tail.
    expect(bodies[0].messages.at(-1).role).toBe('tool')
    for (const body of bodies) {
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

describe('History cache blocks on the wire (2026-10-21): the compiled chat as one block per turn on direct Anthropic', () => {
  beforeEach(() => {
    slot.model = null
  })

  const at = [['time', 'Monday, October 20, 2026 at 9:00 AM']] as Array<[string, string]>
  const HISTORY_TEXT = [
    compiledConversation([
      compiledElement('user', 'Build me a tip calculator.', at),
      compiledElement('assistant', 'Done: tip.js.'),
      compiledElement('user', 'Round to cents.', at),
      compiledElement('assistant', 'Rounded.')
    ]),
    compiledElement('user', 'Add tests.', [['time', '9:05 AM']]),
    compiledElement('dynamic_info', 'project_path: /tmp/probe')
  ].join('\n\n')
  const withHistory = (): NativeModeRequest['messages'] => [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: HISTORY_TEXT }
  ] as any

  it("the turn's first request reads as blocks: two history blocks (the last with a cache point), then the tail", async () => {
    const bodies = await runTurn('anthropic', { messages: withHistory() })
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      const first = body.messages[0]
      expect(first.role).toBe('user')
      expect(first.content).toHaveLength(3)
      expect(first.content.map((block: any) => block.text).join('')).toBe(HISTORY_TEXT)
      expect(first.content[0].cache_control).toBeUndefined()
      expect(first.content[1].cache_control).toEqual({ type: 'ephemeral' })
      expect(first.content[2].cache_control).toBeUndefined()
      expect(first.content[2].text.startsWith('\n</conversation>')).toBe(true)
      // System + history + the request-level tail (BL-1976: on every request): three of four
      // (`blockCacheMarkers` walks the whole body, so it counts the request-level one too).
      expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
      expect(body.cache_control).toEqual({ type: 'ephemeral' })
      expect(blockCacheMarkers(body)).toHaveLength(3)
    }
  })

  it('OpenRouter with a Claude model: the same blocks; the history point stays, the tail marker moves (BL-185, BL-1976)', async () => {
    const bodies = await runTurn('openrouter-claude', { messages: withHistory() })
    expect(bodies).toHaveLength(3)
    bodies.forEach((body, index) => {
      const user = body.messages[1]
      expect(user.role).toBe('user')
      expect(user.content).toHaveLength(3)
      expect(user.content.map((block: any) => block.text).join('')).toBe(HISTORY_TEXT)
      expect(user.content[0].cache_control).toBeUndefined()
      expect(user.content[1].cache_control).toEqual({ type: 'ephemeral' })
      // Request 1: the tail marker is on the step-start message's last block (BL-1976); later
      // requests: the original is back and the tail marker sits on the newest loop message.
      if (index === 0) expect(user.content[2].cache_control).toEqual({ type: 'ephemeral' })
      else {
        expect(user.content[2].cache_control).toBeUndefined()
        expect(blockCacheMarkers(body.messages.at(-1))).toEqual([{ type: 'ephemeral' }])
      }
      // System + history + one tail marker; never the request-level field.
      expect(blockCacheMarkers(body)).toHaveLength(3)
      expect(body.cache_control).toBeUndefined()
    })
  })

  it('a provider that does not take Anthropic cache control sends the one plain message', async () => {
    const bodies = await runTurn('openrouter-other', { messages: withHistory() })
    for (const body of bodies) {
      expect(body.messages[1]).toEqual({ role: 'user', content: HISTORY_TEXT })
      expect(blockCacheMarkers(body)).toEqual([])
    }
  })

  it('the BL-474 provenance check still accounts for every dispatched part (it compares against the split copy)', async () => {
    const messages = withHistory()
    const imageOriginInput = { compiledPrefixCount: messages.length, userSources: [] }
    const collector = new ApiImageInputCollector()
    const bodies = await runTurn('anthropic', { messages, imageOriginInput, onApiModelInput: (input: any) => collector.observe(input) } as any)
    expect(bodies[0].messages[0].content).toHaveLength(3)
    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.unaccountedInputs).toBe(0)
  })

  it('a delegated run (Subagent or Worker) on direct Anthropic gets the same blocks', async () => {
    const bodies = await runTurn('anthropic', { messages: withHistory() }, 'delegated')
    expect(bodies[0].messages[0].content).toHaveLength(3)
    expect(bodies[0].messages[0].content[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  // BL-1991: direct OpenAI on GPT-5.6 and later, through the real `@ai-sdk/openai` Responses converter.
  const openAiUserItem = (body: Body) => body.input.find((item: any) => item.role === 'user')

  it('direct OpenAI (GPT-5.6+): input_text parts with prompt_cache_breakpoint on both history parts, on every request', async () => {
    const bodies = await runTurn('openai', { messages: withHistory() })
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      const user = openAiUserItem(body)
      expect(user.content).toHaveLength(3)
      expect(user.content.map((part: any) => part.type)).toEqual(['input_text', 'input_text', 'input_text'])
      expect(user.content.map((part: any) => part.text).join('')).toBe(HISTORY_TEXT)
      expect(user.content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
      expect(user.content[1].prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
      expect(user.content[2].prompt_cache_breakpoint).toBeUndefined()
      expect(user.content[2].text.startsWith('\n</conversation>')).toBe(true)
      // Implicit mode stays on (no request-level mode), the key rides as before, and no Anthropic field leaks in.
      expect(body.prompt_cache_options).toBeUndefined()
      expect(typeof body.prompt_cache_key).toBe('string')
      expect(blockCacheMarkers(body)).toEqual([])
      expect(JSON.stringify(body).split('prompt_cache_breakpoint')).toHaveLength(3)
    }
    // The compiled message is the same on every step; the loop only appends.
    expect(JSON.stringify(openAiUserItem(bodies[2]))).toBe(JSON.stringify(openAiUserItem(bodies[0])))
  })

  it('OpenRouter with an OpenAI GPT-5.6+ model: cache_control on both history blocks, every request; no tail marker (BL-1991 Part B)', async () => {
    const bodies = await runTurn('openrouter-openai', { messages: withHistory() })
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      const user = body.messages.find((m: any) => m.role === 'user')
      expect(user.content).toHaveLength(3)
      expect(user.content.map((block: any) => block.text).join('')).toBe(HISTORY_TEXT)
      expect(user.content[0].cache_control).toEqual({ type: 'ephemeral' })
      expect(user.content[1].cache_control).toEqual({ type: 'ephemeral' })
      expect(user.content[2].cache_control).toBeUndefined()
      expect(blockCacheMarkers(body)).toHaveLength(2)
      expect(body.cache_control).toBeUndefined()
      expect(typeof body.session_id).toBe('string')
    }
  })

  it('direct OpenAI on GPT-5.5 (no explicit breakpoints) sends the one plain message', async () => {
    const bodies = await runTurn('openai-gpt55', { messages: withHistory() })
    for (const body of bodies) {
      const user = openAiUserItem(body)
      expect(user.content).toEqual([{ type: 'input_text', text: HISTORY_TEXT }])
      expect(JSON.stringify(body)).not.toContain('prompt_cache_breakpoint')
    }
  })

  it('direct OpenAI: the BL-474 provenance check still accounts for every dispatched part', async () => {
    const messages = withHistory()
    const imageOriginInput = { compiledPrefixCount: messages.length, userSources: [] }
    const collector = new ApiImageInputCollector()
    const bodies = await runTurn('openai', { messages, imageOriginInput, onApiModelInput: (input: any) => collector.observe(input) } as any)
    expect(openAiUserItem(bodies[0]).content).toHaveLength(3)
    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.unaccountedInputs).toBe(0)
  })

  it('a delegated run (Subagent or Worker) on direct OpenAI gets the same parts', async () => {
    const bodies = await runTurn('openai', { messages: withHistory() }, 'delegated')
    const user = openAiUserItem(bodies[0])
    expect(user.content).toHaveLength(3)
    expect(user.content[1].prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
  })

  it('direct OpenAI approval resume: the compiled message is split, the replayed call and its answer are not', async () => {
    const resume = withHistory().concat(approvalResumeMessages().slice(2) as any)
    const bodies = await runTurn('openai', { messages: resume })
    const user = openAiUserItem(bodies[0])
    expect(user.content).toHaveLength(3)
    expect(user.content.map((part: any) => part.text).join('')).toBe(HISTORY_TEXT)
    const later = bodies[0].input.slice(bodies[0].input.indexOf(user) + 1)
    expect(JSON.stringify(later)).not.toContain('prompt_cache_breakpoint')
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


describe('private API original pause through the real SDK loop', () => {
  it('stops at a nonawaiting restrictive reservation without fabricating saved/verified continuation', async () => {
    const owner = await import('../appActions/mcp/originalTask')
    const turns = await import('../streamAbortRegistry')
    const identity = { userId: 'user-1', agentId: 'agent-1', sessionId: 'sess-bl77' }
    const stop = new AbortController()
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: stop.signal })!
    const turn = turns.registerSessionTurn(identity.sessionId, 'single', 'msg-bl77')
    if (!turn.ok) throw new Error('owned API turn refused')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity,
      session: { id: identity.sessionId, user_id: identity.userId },
      agent: { id: identity.agentId, user_id: identity.userId }, turn: turn.entry })!
    owner.recordP5ResolvedApiScope(preparation, { gateways: ['A'], tools: [], authority: { humanSelection: true } })
    const part = owner.bindP5ApiReplyPart(preparation, { replyId: 'msg-bl77', version: 0 })!
    let observedRun: Parameters<typeof owner.p5ApiRunMustPause>[0] | undefined
    try {
      const bodies = await runTurn('anthropic', { mcpOriginalPreparation: preparation, mcpApiPart: part, abortSignal: stop.signal,
        onP5ApiRun(run) { observedRun = run } }, 'stream', undefined, tools => {
          tools.tools.echo.execute = async ({ value }: { value: string }) => {
            if (!observedRun) throw new Error('Actual API association is missing.')
            owner.recordP5ApiManagementIntent(observedRun)
            // Real restrictive reservation INSIDE the actual SDK tool callback.
            // No writer ACK/ready/verification fake or pre-dispatch phase shortcut.
            owner.captureP5ApiManagement({ ...identity, messageId: 'msg-bl77', actorType: 'in-process', p5ApiRun: observedRun }, 'C',
              { operationId: 'synthetic-pending-source-op', requestId: 'synthetic-pending-source-request' })
            return { echoed: value }
          }
        })
      expect(bodies).toHaveLength(1)
      expect(observedRun).toBeDefined()
      expect(owner.p5ApiRunMustPause(observedRun!)).toBe(true)
      expect(typeof owner.p5ApiRunMustPause(observedRun!)).toBe('boolean')
      await expect(owner.takeP5ApiVerifiedContinuation(preparation)).resolves.toBeUndefined()
    } finally {
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(identity.sessionId, turn.entry.turnId)
    }
  })
})


describe('actual approval-part media custody through composed Brain prepareStep', () => {
  it.each([true, false])('carries only completed unconsumed images once after a genuine %s answer without added Clip resolution/spend', async approved => {
    const original = await import('../appActions/mcp/originalTask')
    const turns = await import('../streamAbortRegistry')
    const { settingsOperationRegistry } = await import('../appActions/settings/managementRuntime')
    const { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_STAGES } = await import('$lib/appActions/settings/mcpConfiguration')
    const { nativeToolService } = await import('../nativeTools')
    const { attachControlApprovalRecords, resolveApprovalResumeGrants } = await import('../brokerControlApprovals')
    const { persistCanonicalReply } = await import('../replyStreamRecord')
    const { answerApprovalsOnce } = await import('../approvalAnswerRecord')
    const { createApprovalResumeStart } = await import('../approvalResumeMessage')
    const { observeP5ApiConsumedStream } = await import('../vercelBrain')
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const clipState = await import('../sessionClipState')
    const identity = { userId: `media-user-${approved}`, agentId: `media-agent-${approved}`, sessionId: `media-session-${approved}` }
    const replyId = 'media-approval-reply', stop = new AbortController()
    const agent = { id: identity.agentId, user_id: identity.userId, agentType: 'api' as const, displayName: 'Media proof', created_at: 'owned-media-incarnation' }
    await redis.createAgent(agent as any)
    await redis.createSession({ id: identity.sessionId, user_id: identity.userId, agent_id: identity.agentId, title: 'Media proof' } as any)
    const clipKey = `session:${identity.sessionId}:clip_state`
    const clipCut = { clips: [{ clipId: 'retained-clip', messagesUntilUnclip: 3 }] }
    await redis.set(clipKey, clipCut as any)
    const get = vi.spyOn(redis, 'get').mockClear()
    const spend = vi.spyOn(clipState, 'decrementSessionClipDurations')
    const registration = turns.registerSessionTurn(identity.sessionId, 'single', replyId)
    if (!registration.ok) throw new Error('Genuine media turn unavailable')
    const lookup = original.captureP5OriginalLookup({ ...identity, signal: stop.signal })!
    const preparation = original.prepareP5OriginalTask(lookup, { ...identity, agent, session: { id: identity.sessionId, user_id: identity.userId }, turn: registration.entry })!
    original.recordP5ResolvedApiScope(preparation, { gateways: ['A'], tools: [], authority: { humanSelection: true } })
    const part = original.bindP5ApiReplyPart(preparation, { replyId, version: 0 })!
    original.recordP5ApiRequestView(preparation, { request: 'Review these tool images and the held setup choice.', history: [] })
    const input = { op: 'change', requestId: `${settingsOperationRegistry.boot}:media-${approved ? 'approve' : 'deny'}`,
      reportId: `asr_${settingsOperationRegistry.boot}_mcp_${'5'.repeat(32)}`, semanticId: MCP_CONFIGURATION_ID,
      changes: { source: { candidateId: `mcpc_${'6'.repeat(32)}` } } }
    const review = { kind: 'mcp-configuration' as const, planId: `mcpp_${'7'.repeat(32)}`, candidateId: `mcpc_${'6'.repeat(32)}`,
      mode: 'create' as const, resource: { kind: 'mcp-gateway' as const, gatewayId: 'C' }, before: null,
      after: { id: 'C', slug: 'media-c', name: 'Media C', type: 'custom' as const, enabled: true, url: 'https://fixture.invalid/mcp' }, stages: [...MCP_CONFIGURATION_STAGES] }
    const effect = vi.fn(async () => [])
    settingsOperationRegistry.capture({ actor: { userId: identity.userId, kind: 'native', id: identity.agentId, sessionId: identity.sessionId, generation: 1, label: 'Actual held media setup' },
      requestId: input.requestId, input, resource: review.resource, preview: { semanticId: MCP_CONFIGURATION_ID, targets: [], excluded: [], effects: [...MCP_CONFIGURATION_EFFECTS], resource: review },
      permission: 'ask', preimages: { planId: review.planId, disclosure: review }, refresh: async () => {}, execute: effect })
    const brokerInput = { ref: 'fabric:sys.app_settings.native.change', input }
    let actualRun: Parameters<typeof original.p5ApiRunMustPause>[0] | undefined
    let binding: ReturnType<typeof settingsOperationRegistry.bindP5ApiMcpOperation> | undefined
    const risk = vi.spyOn(nativeToolService, 'resolveBrokerRiskApprovalTarget').mockImplementation(async () => ({ ref: brokerInput.ref, family: 'fabric', controlId: 'sys.app_settings.native.change', controlTitle: 'Configure MCP', riskLevel: 'restricted', scopeKey: null, input, lane: 'api',
      settingsPreview: settingsOperationRegistry.nativeApprovalPreview(identity.userId, identity.agentId, identity.sessionId, input.requestId)!, p5ApiHeldRecipe: await binding }))
    const refusedSetup = vi.fn(async () => ({ code: 'MCP_SETUP_POSTIMAGE_REQUIRED', status: 'refused' }))
    const prompts: any[] = []
    let modelCalls = 0
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    const call = (toolCallId: string, toolName: string, value: object): LanguageModelV3StreamPart => ({ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(value) })
    slot.model = new MockLanguageModelV3({ provider: 'fixture', modelId: 'qwen/media-proof', doStream: async options => {
      prompts.push(structuredClone(options.prompt)); modelCalls++
      const content: LanguageModelV3StreamPart[] = modelCalls === 1 ? [call('consumed-image', 'produce_image', { source: 'consumed-source' })]
        : modelCalls === 2 ? [call('pending-image', 'produce_image', { source: 'pending-source' }), call('held-setup', 'native_batshit_tool_use', brokerInput)]
        : modelCalls === 3 ? [call('later-ordinary', 'ordinary_echo', {})]
        : [{ type: 'text-start', id: 'media-final' }, { type: 'text-delta', id: 'media-final', delta: 'The verified setup prerequisite remains unavailable.' }, { type: 'text-end', id: 'media-final' }]
      return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([{ type: 'stream-start', warnings: [] }, ...content,
        { type: 'finish', finishReason: { unified: modelCalls < 4 ? 'tool-calls' : 'stop', raw: modelCalls < 4 ? 'tool_calls' : 'stop' }, usage }]) }
    } })
    const brain = new VercelAIBrain()
    const actualBuild = (brain as any).buildToolsForMode3.bind(brain)
    const registries: import('../toolResultImageDelivery').EphemeralImageRegistry[] = []
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
    const build = vi.spyOn(brain as any, 'buildToolsForMode3').mockImplementation(async (...args: any[]) => {
      const built = await actualBuild(...args) // Actual native builder creates and binds EACH real registry.
      if (!built.ephemeralImages) throw new Error('Actual composed image registry was not installed')
      registries.push(built.ephemeralImages)
      const registry = built.ephemeralImages as import('../toolResultImageDelivery').EphemeralImageRegistry
      built.tools = { ...built.tools,
        produce_image: tool({ inputSchema: jsonSchema<{ source: string }>({ type: 'object', properties: { source: { type: 'string' } }, required: ['source'] }),
          execute: async ({ source }, options) => {
            registry.register(options.toolCallId, source, [{ mediaType: 'image/png', data: png }], 'controlled tool image', 'synthetic_user')
            return { source, image: 'owned by actual registry' }
          } }),
        native_batshit_tool_use: tool({ inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object', additionalProperties: true }), execute: refusedSetup }),
        ordinary_echo: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => ({ ordinary: true }) }) }
      built.toolApprovals = { native_batshit_tool_use: async () => 'user-approval' }
      return built
    })
    const messages: NativeModeRequest['messages'] = [{ role: 'system', content: 'Controlled image/approval instructions.' }, { role: 'user', content: 'Review these tool images and the held setup choice.' }]
    const request: NativeModeRequest = { ...identity, messageId: replyId, model: 'qwen/media-proof', connection: { id: 'openrouter', type: 'openrouter' } as any, messages,
      selectedGateways: ['A'], selectedCliToolIds: [], providerSettings: { nativeTools: { dynamicMcpEnabled: false, batshitToolsEnabled: false, cliToolsEnabled: false, artifactRuntimeEnabled: false, fetchZipEnabled: false, agentBrowserEnabled: false, webSearchEnabled: false, bashEnabled: false } },
      abortSignal: stop.signal, mcpOriginalPreparation: preparation, mcpApiPart: part,
      onP5ApiRun(run) { actualRun = run; binding = settingsOperationRegistry.bindP5ApiMcpOperation({ ...identity, messageId: replyId, actorType: 'in-process', p5ApiRun: run }, input) } }
    let resume: ReturnType<typeof original.prepareP5ApiApprovalResume> | undefined
    let resumedTurn: ReturnType<typeof turns.registerSessionTurn> | undefined
    try {
      const first = await brain.streamNativeMode(request)
      const events: any[] = []
      for await (const event of first.stream) { if (event.type === 'error') throw event.error; events.push(event) }
      observeP5ApiConsumedStream(first)
      expect(modelCalls).toBe(2)
      expect(JSON.stringify(prompts[1])).toContain('Images returned by consumed-source (controlled tool image)')
      expect(registries[0].pending()).toBe(1) // image1 actually spent by prepareStep; image2 completed at the held step.
      const approval = events.find(event => event.type === 'tool-approval-request')
      expect(approval?.toolCall?.toolCallId).toBe('held-setup')
      const entries = await attachControlApprovalRecords({ ...identity, messageId: replyId, p5ApiRun: actualRun!, abortSignal: stop.signal,
        approvals: [{ approvalId: approval.approvalId, toolName: approval.toolCall.toolName, toolCall: approval.toolCall, input: brokerInput, status: 'pending', requestedAt: new Date().toISOString() }] })
      expect(entries[0].control?.approvalId).toMatch(/^apr_/)
      // No manual hold/copy: production's pending writer must retain actual completed images.
      await persistCanonicalReply({ id: replyId, role: 'assistant', user_id: identity.userId, agent_id: identity.agentId, session_id: identity.sessionId,
        content: 'First canonical approval part.', metadata: { toolApprovals: { source: 'vercel', mode: 'all', approvals: entries } }, intermediateSteps: [] } as any, preparation, part)
      await original.sealP5OriginalPreparation(preparation); original.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(identity.sessionId, registration.entry.turnId)
      resumedTurn = turns.registerSessionTurn(identity.sessionId, 'single', replyId, { answersApproval: true })
      if (!resumedTurn.ok) throw new Error('Actual approval answer turn unavailable')
      const responses = [{ approvalId: approval.approvalId, approved }]
      const pending = await original.pendingP5ApiApproval({ ...identity, agent, session: { id: identity.sessionId, user_id: identity.userId }, turn: resumedTurn.entry, messageId: replyId, responses })
      expect(pending).toBeDefined()
      const answer = await answerApprovalsOnce({ ...identity, messageId: replyId, responses })
      expect(answer).toMatchObject({ ok: true, recorded: true })
      resume = original.prepareP5ApiApprovalResume({ ...identity, agent, session: { id: identity.sessionId, user_id: identity.userId }, turn: resumedTurn.entry,
        signal: resumedTurn.entry.stop.signal, pending: pending!, answer })
      const grants = await resolveApprovalResumeGrants({ ...identity, messageId: replyId, responses, originalApiPending: pending })
      expect(approved ? grants.approved['held-setup'] : grants.denied['held-setup']).toBeDefined()
      await original.settleP5ApiApprovalResume(resume, grants)
      const prior = await redis.execute(client => client.json.get(`message:${identity.sessionId}:${replyId}`)) as any
      const resumePart = original.bindP5ApiReplyPart(resume, { replyId, version: createApprovalResumeStart(prior).version })!
      const response = await first.response
      const second = await brain.streamNativeMode({ ...request, mcpOriginalPreparation: resume, mcpApiPart: resumePart, controlApprovals: grants,
        abortSignal: resumedTurn.entry.stop.signal,
        messages: [...messages, ...response.messages, { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: approval.approvalId, approved }] }],
        onP5ApiRun(run) { actualRun = run } })
      for await (const event of second.stream) if (event.type === 'error') throw event.error
      observeP5ApiConsumedStream(second)
      expect(modelCalls).toBe(4)
      for (const prompt of prompts.slice(2)) {
        const text = JSON.stringify(prompt)
        expect(text.split('Images returned by pending-source (controlled tool image)')).toHaveLength(2)
        expect(text).not.toContain('Images returned by consumed-source')
        const imageParts = prompt.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((entry: any) => entry.type === 'file' && entry.mediaType === 'image/png')
        expect(imageParts).toHaveLength(1)
        expect(imageParts[0].data).toBe(png)
      }
      expect(registries).toHaveLength(2)
      expect(registries[1].pending()).toBe(0)
      expect(refusedSetup).toHaveBeenCalledTimes(approved ? 1 : 0)
      expect(effect).not.toHaveBeenCalled()
      expect(original.p5ApiPreparedScope(resume)?.gateways).toEqual(['A'])
      await expect(original.takeP5ApiVerifiedContinuation(resume)).resolves.toBeUndefined()
      // Two ordinary Brain conversions read active Clip syntax once each; handoff adds
      // NO content reload/re-resolution or countdown spend. Compiler behavior is not frozen.
      expect(get.mock.calls.filter(([key]) => key === clipKey)).toHaveLength(2)
      expect(get.mock.calls.filter(([key]) => typeof key === 'string' && key.startsWith('clip:'))).toHaveLength(0)
      expect(spend).not.toHaveBeenCalled()
      expect(await redis.get(clipKey)).toEqual(clipCut)
    } finally {
      build.mockRestore(); risk.mockRestore(); spend.mockRestore()
      if (vi.isMockFunction(redis.get)) redis.get.mockRestore()
      if (resume) { await original.sealP5OriginalPreparation(resume); original.retireP5OriginalPreparation(resume) }
      await original.sealP5OriginalPreparation(preparation); original.retireP5OriginalPreparation(preparation)
      if (resumedTurn?.ok) turns.releaseSessionTurn(identity.sessionId, resumedTurn.entry.turnId)
      turns.releaseSessionTurn(identity.sessionId, registration.entry.turnId)
    }
  })
})

/**
 * SA-137 Round 2 follow-up (R2-4): send-routed's last sharing check (`modelDispatchGate`) runs in
 * the innermost model middleware, after every awaited setup (the tools, the step hook's steer take)
 * and right before each provider request leaves, ahead of the input observer. A refusal sends no
 * request at all and records no delivery; `requestSent` follows only a request whose send resolved,
 * so an attempt the SDK retries after a failed send is checked again.
 */
describe('the last check before a provider request (SA-137 Round 2 follow-up)', () => {
  beforeEach(() => {
    slot.model = null
  })

  const gateOf = (events: string[], refuse: (call: number) => Error | null = () => null) => {
    let calls = 0
    return {
      beforeRequest: vi.fn(async () => {
        calls += 1
        events.push(`check:${calls}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
        const refusal = refuse(calls)
        if (refusal) throw refusal
      }),
      requestSent: vi.fn(() => { events.push('sent') })
    }
  }

  it('a check that refuses after a delayed setup sends no request and observes none; the SDK does not retry it', async () => {
    const { LiveFileReadSharingChangedError } = await import('../liveFileReadTurn.server')
    const events: string[] = []
    const observed = vi.fn()
    const modelDispatchGate = gateOf(events, () => new LiveFileReadSharingChangedError())
    const failure = await runTurn('anthropic', { modelDispatchGate, onApiModelInput: observed }).then(() => null, (error) => error)
    expect(failure).toBeInstanceOf(LiveFileReadSharingChangedError)
    expect(failure.requestsSent).toBe(0)
    expect(modelDispatchGate.beforeRequest).toHaveBeenCalledTimes(1)
    expect(modelDispatchGate.requestSent).not.toHaveBeenCalled()
    expect(observed).not.toHaveBeenCalled()
  })

  it('a check that passes runs after the tools and each step\'s steer take, before every request and its observer, and changes no provider byte', async () => {
    const events: string[] = []
    const modelDispatchGate = gateOf(events)
    const onApiModelInput = vi.fn(() => { events.push('observe') })
    const takeSteers = vi.fn((step: number) => { events.push(`steers:${step}`); return [] })
    const plain = await runTurn('anthropic', {})
    const checked = await runTurn('anthropic', { modelDispatchGate, onApiModelInput, takeSteers }, 'stream', undefined, () => { events.push('tools') })
    expect(checked).toEqual(plain)
    expect(checked).toHaveLength(3)
    // Each request: its setup first, then the check, the observer, the send.
    expect(events.filter((event) => !event.startsWith('steers:'))).toEqual(
      ['tools', 'check:1', 'observe', 'sent', 'check:2', 'observe', 'sent', 'check:3', 'observe', 'sent'])
    for (const step of [0, 1, 2]) {
      const take = events.indexOf(`steers:${step}`)
      if (take >= 0) expect(take).toBeLessThan(events.indexOf(`check:${step + 1}`))
    }
    expect(events.some((event) => event.startsWith('steers:'))).toBe(true)
  })

  it('a send that fails before the provider takes it is checked again on the SDK\'s retry, and only the sent attempt confirms', async () => {
    const events: string[] = []
    const modelDispatchGate = gateOf(events)
    let attempts = 0
    const bodies = await runTurn('anthropic', { modelDispatchGate }, 'stream', (turn) => [
      // As Node's fetch fails on a refused connection: nothing reached the provider.
      () => { attempts += 1; throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) },
      () => { attempts += 1; return turn.answer() }
    ])
    expect(attempts).toBe(2)
    expect(bodies).toHaveLength(2)
    expect(events).toEqual(['check:1', 'check:2', 'sent'])
  }, 30_000)
})

describe('the turn\'s Refreshed File Reads answer reaches the native tool builder (Josh, 2026-10-22)', () => {
  beforeEach(() => {
    slot.model = null
  })

  // edit_file's text follows it (`buildTypedFileTools`): the request's flag must arrive in the
  // native context on both brain paths, and only as true when the route said so.
  it.each([
    ['stream', true],
    ['stream', false],
    ['delegated', true],
    ['delegated', false]
  ] as const)('%s path, refreshedFileReadsTurn %s', async (path, on) => {
    const { nativeToolService } = await import('../nativeTools')
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    const finish = { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage }
    slot.model = new MockLanguageModelV3({
      provider: 'fixture',
      modelId: 'fixture-api',
      doStream: async () => ({ stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }, finish
      ]) }),
      doGenerate: async () => ({ content: [{ type: 'text', text: 'Done.' }], finishReason: finish.finishReason, usage, warnings: [] })
    })
    const build = vi.spyOn(nativeToolService, 'buildMode3NativeTools').mockResolvedValue({ tools: {}, toolApprovals: {}, fetchZipAvailable: false } as any)
    try {
      const brain = new VercelAIBrain()
      const request: NativeModeRequest = {
        model: 'fixture-api',
        connection: { id: 'openrouter', type: 'openrouter' } as any,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: FIRST_USER_MESSAGE }],
        sessionId: `sess-rfr-${path}-${on}`,
        messageId: `msg-rfr-${path}-${on}`,
        userId: 'user-rfr',
        agentId: 'agent-rfr',
        ...(on ? { refreshedFileReadsTurn: true } : {})
      }
      if (path === 'delegated') await brain.processNativeMode(request)
      else {
        const result: any = await brain.streamNativeMode(request)
        for await (const part of result.stream) if (part?.type === 'error') throw part.error
      }
      expect(build).toHaveBeenCalled()
      for (const [context] of build.mock.calls) expect((context as any).refreshedFileReadsTurn).toBe(on)
    } finally {
      build.mockRestore()
    }
  }, 30_000)
})

describe('open skill DCM refresh at the actual awaited SDK tool boundary', () => {
  it('replaces only the canonical section before the next dispatch and preserves cache/provenance on later steps', async () => {
    const { createSkillDcmUpdate } = await import('../skillDcmUpdate')
    const original = '<conversation>\n<user>earlier actual request</user>\n</conversation>\n\n' + FIRST_USER_MESSAGE
    const old = '<dynamic_info>\nproject_path: /tmp/probe\n</dynamic_info>'
    const section = 'open_skills:\n- Example\n  - fabric:sys.example.use — required: `id`'
    const opened = `<dynamic_info>\n${section}\nproject_path: /tmp/probe\n</dynamic_info>`
    const middle = original.replace(old, opened)
    let completed = 0
    let delivered = 0
    const collector = new ApiImageInputCollector()
    const refreshOpenSkills = async () => {
      // Actual asynchronous preparation must finish before the SDK dispatches its next call.
      await Promise.resolve()
      if (completed === 1 && delivered === 0) {
        delivered += 1
        return createSkillDcmUpdate(original, original.indexOf(old), old, opened, section)
      }
      if (completed === 2 && delivered === 1) {
        delivered += 1
        return createSkillDcmUpdate(middle, middle.indexOf(opened), opened, old, '')
      }
      return undefined
    }
    const bodies = await runTurn('anthropic', {
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: original }],
      refreshOpenSkills, imageOriginInput: { compiledPrefixCount: 2, userSources: [] },
      onApiModelInput: input => collector.observe(input)
    }, 'stream', undefined, tools => {
      tools.tools.echo.execute = async ({ value }: { value: string }) => { completed += 1; return { echoed: value } }
    })
    const userText = (body: any) => body.messages.filter((message: any) => message.role === 'user').flatMap((message: any) =>
      typeof message.content === 'string' ? [message.content] : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text)).join('')
    expect(bodies).toHaveLength(3)
    expect(userText(bodies[0])).toBe(original)
    expect(userText(bodies[1])).toContain(middle)
    expect(userText(bodies[2])).toContain(original)
    expect(userText(bodies[2])).not.toContain(section)
    expect(delivered).toBe(2)
    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.unaccountedInputs).toBe(0)
    expect(collector.run.pieces.filter(piece => piece.source === 'batshit')).toEqual([{ source: 'batshit', text: section }])
    for (const body of bodies) expect(body.cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('complete opened-skill guidance uses the existing model hard-fit budget', () => {
  it('refuses the next actual SDK dispatch instead of cutting required DCM guidance', async () => {
    const { createSkillDcmUpdate } = await import('../skillDcmUpdate')
    const old = '<dynamic_info>\nproject_path: /tmp/probe\n</dynamic_info>'
    const section = 'open_skills:\n- Example\n' + '  - complete required tool fields '.repeat(3000)
    const opened = `<dynamic_info>\n${section}\nproject_path: /tmp/probe\n</dynamic_info>`
    let read = false, updated = false
    const error = await runTurn('anthropic', {
      skillContextBudget: { contextLimit: 2000, outputReserveTokens: 100 },
      skillReadDelivery: { hasReads: () => read, owns: () => false, execute: async (_args, run) => run(), delivered: async () => {} },
      refreshOpenSkills: async () => {
        if (!read || updated) return undefined
        updated = true
        return createSkillDcmUpdate(FIRST_USER_MESSAGE, FIRST_USER_MESSAGE.indexOf(old), old, opened, section)
      }
    }, 'stream', undefined, tools => {
      tools.tools.echo.execute = async () => { read = true; return { read: true } }
    }).then(() => null, caught => caught)
    expect(error?.message).toContain('complete opened-skill guidance')
    expect(error?.requestsSent).toBe(1)
    expect(updated).toBe(true)
  })
})

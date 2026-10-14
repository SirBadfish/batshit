/**
 * BL-866 wire proof: the Thinking mode a Claude Sonnet 5.5 send puts in the request body.
 *
 * Claude Sonnet 5.5 (`claude-sonnet-5-5`) answers 400 to `thinking: {type: 'disabled'}` and to
 * `{type: 'enabled', budget_tokens}`; its lowest setting is `{type: 'between_tools'}`, which
 * takes no other field. Batshit owns that choice: the mapper hands the provider the value the
 * model takes, so the AI SDK never has to rewrite one for it (its own rewrites are silent to the
 * user: a Node process warning on the server's stderr and nothing else). A setting the model
 * refuses is refused before a request is built (this mapping first, then the Thinking guard).
 *
 * Drives the REAL `VercelAIBrain` (`streamNativeMode` is a primary's send, `processNativeMode` an
 * API Subagent's or Worker's), the REAL mapper and reasoning composition `send-routed` uses, the
 * REAL AI SDK and the REAL provider packages. Only the network is fake: an injected fetch
 * answers with a canned stream and records the request body, which is exactly what the provider
 * would have received. No Redis, no keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { createGateway } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { VercelAIBrain, type NativeModeRequest } from '../vercelBrain'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { withReasoningProviderOptions } from '$lib/utils/reasoningDisplay'
import type { ParameterValue } from '$lib/data/parameter-schemas'

type Body = Record<string, any>
type Lane = 'primary' | 'delegated'

const SONNET_5_5 = 'claude-sonnet-5-5'
const DIRECT = { id: 'direct:anthropic', type: 'direct', service: 'anthropic' } as const
const GATEWAY = { id: 'vercel-gateway', type: 'vercel-gateway', service: 'vercel-gateway' } as const
const OPENROUTER = { id: 'openrouter', type: 'openrouter', service: 'openrouter' } as const

/** What the AI SDK told the server about a request (the default is a Node process warning). */
const sdkWarnings: string[] = []
/** Every request body any send in the current test put on the wire, refused sends included. */
const wire: Body[] = []

beforeEach(() => {
  slot.model = null
  sdkWarnings.length = 0
  wire.length = 0
  ;(globalThis as any).AI_SDK_LOG_WARNINGS = (options: { warnings: Array<Record<string, any>> }) => {
    for (const warning of options.warnings) {
      sdkWarnings.push(String(warning.details ?? warning.message ?? warning.feature ?? ''))
    }
  }
})

afterEach(() => {
  delete (globalThis as any).AI_SDK_LOG_WARNINGS
})

function sse(events: Array<Record<string, any>>, withEventLines: boolean, tail = ''): Response {
  const body =
    events
      .map((event) => `${withEventLines ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
      .join('') + tail
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function anthropicAnswer(): Response {
  return sse(
    [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: SONNET_5_5,
          role: 'assistant',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }
    ],
    true
  )
}

function openRouterAnswer(): Response {
  return sse(
    [
      {
        id: 'gen_1',
        model: 'anthropic/claude-sonnet-5.5',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }]
      },
      {
        id: 'gen_1',
        model: 'anthropic/claude-sonnet-5.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }
    ],
    false,
    'data: [DONE]\n\n'
  )
}

/** The AI Gateway's language-model stream: the SDK's own stream parts, one JSON object per event. */
function gatewayAnswer(): Response {
  return sse(
    [
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'gw_1', modelId: 'anthropic/claude-sonnet-5.5' },
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', delta: 'Done.' },
      { type: 'text-end', id: 't0' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 }
        }
      }
    ],
    false
  )
}

type Door = 'direct' | 'gateway' | 'openrouter'

function useDoor(door: Door, modelId: string, bodies: Body[]) {
  const scripted = (answer: () => Response) =>
    (async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      wire.push(body)
      return answer()
    }) as any
  if (door === 'direct') {
    slot.model = createAnthropic({ apiKey: 'test-key', fetch: scripted(anthropicAnswer) })(modelId)
  } else if (door === 'gateway') {
    slot.model = createGateway({
      apiKey: 'test-key',
      baseURL: 'https://gateway.test/v3/ai',
      fetch: scripted(gatewayAnswer)
    })(modelId)
  } else {
    slot.model = createOpenRouter({ apiKey: 'test-key', fetch: scripted(openRouterAnswer) }).chat(modelId)
  }
}

/**
 * One send, the way `send-routed` builds it: the saved settings go through the mapper, then the
 * reasoning composition, into the request the brain runs. Returns every request body the
 * provider received.
 */
async function send(options: {
  door?: Door
  lane?: Lane
  modelId: string
  settings: Record<string, ParameterValue>
}): Promise<Body[]> {
  const door = options.door ?? 'direct'
  const bodies: Body[] = []
  useDoor(door, options.modelId, bodies)
  const connection = door === 'direct' ? DIRECT : door === 'gateway' ? GATEWAY : OPENROUTER
  const capabilities = { reasoning: true } as any

  const runtime = buildRuntimeModelSettings({
    provider: 'anthropic',
    modelId: options.modelId,
    vercelId: null,
    connection,
    capabilities,
    settings: options.settings
  })
  const providerOptions = withReasoningProviderOptions(
    Object.keys(runtime.providerOptions).length > 0 ? runtime.providerOptions : undefined,
    { provider: 'anthropic', modelId: options.modelId, connection, capabilities, showReasoning: true }
  )

  const brain = new VercelAIBrain()
  ;(brain as any).buildToolsForMode3 = vi.fn(async () => ({
    tools: {},
    maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
    toolApprovals: {},
    ephemeralImages: null
  }))
  const request = {
    model: options.modelId,
    connection,
    messages: [
      { role: 'system', content: 'You are a probe agent.' },
      { role: 'user', content: 'Say hi.' }
    ],
    sessionId: 'sess-bl866',
    messageId: 'msg-bl866',
    userId: 'user-1',
    agentId: 'agent-1',
    maxToolRounds: 3,
    temperature: runtime.standard.temperature,
    maxTokens: runtime.standard.maxTokens,
    providerOptions
  } as unknown as NativeModeRequest

  if ((options.lane ?? 'primary') === 'delegated') {
    await brain.processNativeMode(request)
    return bodies
  }
  const result: any = await brain.streamNativeMode(request)
  for await (const part of result.stream) {
    if (part?.type === 'error') throw part.error
  }
  return bodies
}

describe('BL-866 direct Anthropic: what a Claude Sonnet 5.5 send carries', () => {
  it.each<Lane>(['primary', 'delegated'])('blank sends no thinking and no effort (%s)', async (lane) => {
    const [body, ...rest] = await send({ lane, modelId: SONNET_5_5, settings: {} })
    expect(rest).toEqual([])
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('output_config')
    expect(sdkWarnings).toEqual([])
  })

  it.each<Lane>(['primary', 'delegated'])('between_tools sends between_tools and nothing else (%s)', async (lane) => {
    const [body] = await send({ lane, modelId: SONNET_5_5, settings: { thinkingMode: 'between_tools' } })
    expect(body.thinking).toEqual({ type: 'between_tools' })
    // Batshit sends no effort of its own: there is nothing above `high` to send beside it.
    expect(body).not.toHaveProperty('output_config')
    expect(sdkWarnings).toEqual([])
  })

  it.each<Lane>(['primary', 'delegated'])(
    'a saved Disabled is sent as between_tools, by Batshit and not by the SDK (%s)',
    async (lane) => {
      const [body] = await send({ lane, modelId: SONNET_5_5, settings: { thinkingMode: 'disabled' } })
      expect(body.thinking).toEqual({ type: 'between_tools' })
      // The AI SDK rewrites `disabled` for this model too, and says so only in a warning nobody
      // reads. No warning means Batshit made the choice itself, before the Thinking guard looked.
      expect(sdkWarnings).toEqual([])
    }
  )

  it('never sends a budget beside between_tools', async () => {
    for (const settings of [
      { thinkingMode: 'between_tools', thinkingBudget: 2048 },
      { thinkingMode: 'disabled', thinkingBudget: 2048 },
      { thinkingMode: 'between_tools', thinkingBudget: 0 }
    ]) {
      const [body] = await send({ modelId: SONNET_5_5, settings })
      expect(body.thinking).toEqual({ type: 'between_tools' })
      expect(JSON.stringify(body)).not.toContain('budget_tokens')
    }
    expect(sdkWarnings).toEqual([])
  })

  it('a saved budget alone sends no thinking field', async () => {
    const [body] = await send({ modelId: SONNET_5_5, settings: { thinkingBudget: 2048 } })
    expect(body).not.toHaveProperty('thinking')
    expect(sdkWarnings).toEqual([])
  })

  it('a saved Enabled sends nothing at all: the send is refused before a request is built', async () => {
    let refusal: unknown
    try {
      await send({ modelId: SONNET_5_5, settings: { thinkingMode: 'enabled', thinkingBudget: 2048 } })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toContain('Thinking mode "enabled"')
    // Not rewritten to another value and sent: nothing reached the wire.
    expect(wire).toEqual([])
    expect(sdkWarnings).toEqual([])
  })

  it('a Custom Parameter effort is the user\'s own: xhigh beside between_tools is lowered by the SDK and reported only as a warning', async () => {
    // Batshit has no effort setting. A user who types `anthropic.effort` as a Custom Parameter
    // reaches the wire; the API refuses xhigh and max beside between_tools, so the SDK lowers
    // it to high. Pinned so a change in the SDK's rule shows up here.
    const [body] = await send({
      modelId: SONNET_5_5,
      settings: { thinkingMode: 'between_tools', 'anthropic.effort': 'xhigh' }
    })
    expect(body.thinking).toEqual({ type: 'between_tools' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(sdkWarnings.join('\n')).toContain("effort 'xhigh' is not supported with 'between_tools'")
  })
})

describe('BL-866 the AI Gateway: the same settings, forwarded verbatim', () => {
  // The gateway lane posts the call options, provider options included, to the gateway, which
  // builds the Anthropic request itself. Batshit's part is what it puts in `providerOptions`.
  it.each<[string, Record<string, ParameterValue>, unknown]>([
    ['blank', {}, undefined],
    ['between_tools', { thinkingMode: 'between_tools' }, { type: 'between_tools' }],
    ['a saved Disabled', { thinkingMode: 'disabled' }, { type: 'between_tools' }],
    ['between_tools with a saved budget', { thinkingMode: 'between_tools', thinkingBudget: 2048 }, { type: 'between_tools' }]
  ])('%s', async (_label, settings, expected) => {
    const [body] = await send({ door: 'gateway', modelId: 'anthropic/claude-sonnet-5.5', settings })
    expect(body.providerOptions?.anthropic?.thinking).toEqual(expected)
    expect(JSON.stringify(body.providerOptions ?? {})).not.toContain('budget')
  })

  it('refuses a saved Enabled on the gateway spelling of the id too', async () => {
    await expect(
      send({ door: 'gateway', modelId: 'anthropic/claude-sonnet-5.5', settings: { thinkingMode: 'enabled' } })
    ).rejects.toThrow('Thinking mode "enabled"')
  })
})

describe('BL-866 OpenRouter does not carry the option', () => {
  it('sends the same chat-completions body whatever Thinking mode is saved', async () => {
    const modelId = 'anthropic/claude-sonnet-5.5'
    const [blank] = await send({ door: 'openrouter', modelId, settings: {} })
    const [saved] = await send({ door: 'openrouter', modelId, settings: { thinkingMode: 'between_tools' } })
    // OpenRouter's provider reads `providerOptions.openrouter`; the `anthropic` block is never
    // put on its wire, so there is no `thinking` field to get wrong on this lane.
    expect(JSON.stringify(saved)).not.toContain('between_tools')
    expect(saved).toEqual(blank)
  })
})

/**
 * Other Claude models: their thinking body for each saved value was captured before the change
 * (the old mapper on the old AI SDK) and is pinned here, so the change cannot move it. The
 * three models that always think adaptively (Opus 5.5, Fable 5, Fable 5.1) are NOT in this
 * table: the new AI SDK itself would rewrite their `disabled` and `enabled`, so the Thinking
 * guard (`anthropicThinkingGuard.ts`, its own test) refuses those before a body is built.
 */
const UNCHANGED_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5'
]

const UNCHANGED_CASES: Array<[string, Record<string, ParameterValue>, Body | undefined]> = [
  ['blank', {}, undefined],
  ['disabled', { thinkingMode: 'disabled' }, { type: 'disabled' }],
  ['enabled with a budget', { thinkingMode: 'enabled', thinkingBudget: 2048 }, { type: 'enabled', budget_tokens: 2048 }]
]

describe('BL-866 every other Claude model sends the same thinking body as before', () => {
  it.each(UNCHANGED_MODELS)('%s', async (modelId) => {
    for (const [label, settings, thinking] of UNCHANGED_CASES) {
      const [body] = await send({ modelId, settings })
      if (thinking === undefined) expect(body, `${modelId} ${label}`).not.toHaveProperty('thinking')
      else expect(body.thinking, `${modelId} ${label}`).toEqual(thinking)
    }
  })
})

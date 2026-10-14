/**
 * BL-800: an API Subagent or Worker run sends the settings of the preset it names.
 *
 * `runApiSubagent` used to hand the preset's settings to `processNativeMode` only as
 * `providerSettings` (the tool scope), while the model call is built from the request's own
 * `temperature`, `maxTokens`, `topP`, ... and `providerOptions`, which the runner never set. A
 * saved temperature, max tokens, reasoning setting or Custom Parameter was silently not sent on
 * every Subagent call.
 *
 * Drives the REAL runner (`executeManagedSubagent` -> `runApiSubagent`), the REAL
 * `processNativeMode` (the cache policy and the per-step hook), the REAL AI SDK loop and the REAL
 * provider packages. Only the network is fake: an injected fetch answers with a canned stream and
 * records every request body, which is exactly what the provider would have received.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')

const harness = vi.hoisted(() => ({
  model: null as any,
  redisStore: { current: null as any },
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))

vi.mock('$lib/server/services/providers', () => {
  const factory = () => ({
    getModel: () => harness.model,
    listAvailableModels: () => [],
  })
  const ProviderManager = vi.fn(function MockProviderManager(this: Record<string, unknown>) {
    Object.assign(this, factory())
  })
  ;(ProviderManager as any).createForUser = vi.fn(async () => factory())
  return {
    ProviderManager,
    resolveProviderAccess: vi.fn().mockResolvedValue({ apiKeys: {} }),
  }
})

vi.mock('$lib/server/services/codexBridge', () => ({ CodexBridge: vi.fn() }))
vi.mock('$lib/server/services/claudeBridge', () => ({ ClaudeBridge: vi.fn() }))
vi.mock('$lib/server/services/codexProfileManager', () => ({
  buildAgentProfileId: vi.fn((value: string) => `profile-${value}`),
  prepareManagedCodexSubagentProfile: vi.fn(),
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  prepareManagedClaudeSubagentProfile: vi.fn(),
}))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn().mockResolvedValue(null) },
}))

vi.mock('$lib/server/redis', () => ({
  redis: new Proxy({} as Record<string, any>, {
    get(_target, prop: string) {
      if (prop === 'getUserSettings') return async () => null
      return harness.redisStore.current.redis[prop]
    },
  }),
}))

vi.mock('$lib/server/services/subagentRuntimeScope', () => ({
  resolveManagedSubagentScope: vi.fn(async () => ({
    subagentType: 'api',
    nativeToolSettings: {},
    defaultMcpGateways: [],
    resolvedGateways: [],
    defaultCliToolIds: [],
    resolvedCliToolIds: [],
    defaultMcpToolSelections: [],
    dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
    projectPath: null,
  })),
  buildManagedSubagentDynamicInfo: vi.fn(async () => ''),
  appendManagedSubagentDynamicInfo: (systemPrompt: string) => systemPrompt,
}))

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: vi.fn().mockResolvedValue([]),
  buildSkillsCommandsDcmLines: vi.fn(() => []),
}))

import { jsonSchema, tool } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import { VercelAIBrain } from '../vercelBrain'
import { executeManagedSubagent } from '../subagentRunner'

const subagentRedis = createSubagentRedisMock()
harness.redisStore.current = subagentRedis

type Body = Record<string, any>

const LMSTUDIO = { id: 'direct:lmstudio', type: 'direct', service: 'lmstudio' } as const
const ANTHROPIC = { id: 'direct:anthropic', type: 'direct', service: 'anthropic' } as const

function sse(events: Array<Record<string, any>>, withEventLines: boolean): Response {
  const body =
    events
      .map((event) => `${withEventLines ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
      .join('') + (withEventLines ? '' : 'data: [DONE]\n\n')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function compatibleAnswer(): Response {
  return sse(
    [
      {
        id: 'chatcmpl-1',
        model: 'local',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        model: 'local',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ],
    false,
  )
}

function anthropicAnswer(): Response {
  return sse(
    [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ],
    true,
  )
}

/** One Anthropic step that calls the `echo` tool. */
function anthropicToolCall(n: number): Response {
  return sse(
    [
      {
        type: 'message_start',
        message: {
          id: `msg_${n}`,
          model: 'claude-sonnet-4-5',
          role: 'assistant',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name: 'echo', input: {} } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ value: `step-${n}` }) },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ],
    true,
  )
}

/**
 * Puts a real provider behind the run, and returns the bodies it will have been sent. `script`
 * answers the requests in order (the last answer repeats); by default every request is answered
 * with a final text.
 */
function useLane(lane: 'lmstudio' | 'anthropic', script?: Array<() => Response>): Body[] {
  const bodies: Body[] = []
  const scriptedFetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    if (script) return script[Math.min(bodies.length - 1, script.length - 1)]()
    return lane === 'lmstudio' ? compatibleAnswer() : anthropicAnswer()
  }) as unknown as typeof fetch
  harness.model =
    lane === 'lmstudio'
      ? createOpenAICompatible({
          name: 'lmstudio',
          baseURL: 'http://127.0.0.1:1234/v1',
          apiKey: 'test-key',
          fetch: scriptedFetch,
          includeUsage: true,
        }).chatModel('qwen-local')
      : createAnthropic({ apiKey: 'test-key', fetch: scriptedFetch })('claude-sonnet-4-5')
  return bodies
}

function localPreset(settings: Record<string, unknown>) {
  return {
    id: 'preset-local',
    provider: 'lmstudio',
    modelId: 'qwen-local',
    connection: LMSTUDIO,
    settings,
  }
}

function anthropicPreset(settings: Record<string, unknown>) {
  return {
    id: 'preset-claude',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    connection: ANTHROPIC,
    settings,
  }
}

function subagentFor(preset: { id: string; provider: string; modelId: string; connection: any }, extra = {}) {
  return {
    id: 'sub-1',
    user_id: 'USER-1',
    displayName: 'Settings Helper',
    subagentType: 'api' as const,
    primary_model_provider: preset.provider,
    primary_model_name: preset.modelId,
    primary_model_preset_id: preset.id,
    primary_model_connection: preset.connection,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...extra,
  }
}

async function run(subagent: Record<string, any>, overrides: Record<string, any> = {}) {
  if (overrides.delegationKind !== 'worker') subagentRedis.seed(`subagent:${subagent.id}`, subagent)
  return executeManagedSubagent({
    userId: 'USER-1',
    sessionId: 'session-800',
    chatInput: 'Do the thing.',
    parentAgentId: 'primary-agent',
    parentModelId: 'parent-model',
    parentConnection: LMSTUDIO,
    subagent,
    ...overrides,
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  subagentRedis.clear()
  subagentRedis.seed('batshit:sub_system_prompt', '# Base subagent prompt')
  harness.model = null
  // The tool set is not what this suite decides: none is enough for a model call.
  vi.spyOn(VercelAIBrain.prototype as any, 'buildToolsForMode3').mockResolvedValue({
    tools: {},
    maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
    toolApprovals: {},
    ephemeralImages: null,
  })
})

describe('BL-800: a Subagent run sends its preset settings (the request body the provider gets)', () => {
  it('sends the temperature, max tokens, top p, reasoning setting and Custom Parameter of the preset', async () => {
    const preset = localPreset({
      temperature: 0.3,
      maxTokens: 2048,
      topP: 0.9,
      minP: 0.05,
      localReasoningEffort: 'low',
      customKnob: 3,
    })
    subagentRedis.seed(`model:${preset.id}`, preset)
    const bodies = useLane('lmstudio')

    const result = await run(subagentFor(preset))

    expect(result.status).toBe('completed')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      temperature: 0.3,
      max_tokens: 2048,
      top_p: 0.9,
      // Provider options travel in the body under the names the local program reads.
      min_p: 0.05,
      reasoning_effort: 'low',
      // A Custom Parameter (a key Batshit does not define) reaches the body verbatim.
      customKnob: 3,
    })
  })

  it('sends a temperature of 0: zero is a real value', async () => {
    const preset = localPreset({ temperature: 0 })
    subagentRedis.seed(`model:${preset.id}`, preset)
    const bodies = useLane('lmstudio')

    await run(subagentFor(preset))

    expect(bodies[0].temperature).toBe(0)
  })

  it('sends nothing for a preset with every value blank', async () => {
    const preset = localPreset({})
    subagentRedis.seed(`model:${preset.id}`, preset)
    const bodies = useLane('lmstudio')

    await run(subagentFor(preset))

    expect(bodies).toHaveLength(1)
    for (const key of ['temperature', 'max_tokens', 'top_p', 'top_k', 'min_p', 'reasoning_effort', 'seed', 'stop']) {
      expect(bodies[0], `the body must not carry ${key}`).not.toHaveProperty(key)
    }
  })

  it('sends only what the live preset holds, never the model values left on the Subagent record (BL-515)', async () => {
    const preset = localPreset({ maxTokens: 512 })
    subagentRedis.seed(`model:${preset.id}`, preset)
    const bodies = useLane('lmstudio')

    await run(
      subagentFor(preset, {
        provider_specific_settings: { temperature: 1.2, topP: 0.5, nativeTools: { bashEnabled: false } },
      }),
    )

    expect(bodies[0].max_tokens).toBe(512)
    expect(bodies[0]).not.toHaveProperty('temperature')
    expect(bodies[0]).not.toHaveProperty('top_p')
    // The Subagent's own tool block is Batshit's, not a model parameter: it never reaches the body.
    expect(JSON.stringify(bodies[0])).not.toContain('nativeTools')
  })

  it('a Worker cloned from an assigned Subagent sends its base preset settings too', async () => {
    const preset = localPreset({ temperature: 0.6, maxTokens: 1024 })
    subagentRedis.seed(`model:${preset.id}`, preset)
    const bodies = useLane('lmstudio')

    await run(subagentFor(preset), { delegationKind: 'worker' })

    expect(bodies[0]).toMatchObject({ temperature: 0.6, max_tokens: 1024 })
  })

  it('a run on the parent model (no model of its own) sends no sampling settings: the parent model default applies', async () => {
    const bodies = useLane('lmstudio')

    // The built-in Worker's record: no model of its own, and the PARENT's settings as its scope.
    await run(
      {
        id: 'worker_abc',
        user_id: 'USER-1',
        displayName: 'Worker 1',
        subagentType: 'api',
        provider_specific_settings: { temperature: 0.7, maxTokens: 4096, nativeTools: { bashEnabled: false } },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { delegationKind: 'worker', parentModelId: 'qwen-local' },
    )

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('temperature')
    expect(bodies[0]).not.toHaveProperty('max_tokens')
  })

  it('a preset\'s Prompt cache TTL is not sent: a delegated run\'s cache points stay at five minutes (BL-184)', async () => {
    const preset = anthropicPreset({ temperature: 0.2, maxTokens: 1024, cacheControl: '1h' })
    subagentRedis.seed(`model:${preset.id}`, preset)
    const bodies = useLane('anthropic')

    await run(subagentFor(preset))

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ temperature: 0.2, max_tokens: 1024 })
    // The system cache point is still there, on Anthropic's default lifetime.
    expect(bodies[0].system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    expect(JSON.stringify(bodies[0])).not.toContain('"ttl"')
  })

  it('a delegated tool loop keeps its step-2 cache point AND the preset\'s other provider options (the per-step merge)', async () => {
    const preset = anthropicPreset({ temperature: 0.2, maxTokens: 1024, disableParallelToolUse: true, cacheControl: '1h' })
    subagentRedis.seed(`model:${preset.id}`, preset)
    // The tool the run calls: one step calls it, the second answers.
    vi.spyOn(VercelAIBrain.prototype as any, 'buildToolsForMode3').mockResolvedValue({
      tools: {
        echo: tool({
          description: 'Echo a value back.',
          inputSchema: jsonSchema<{ value: string }>({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          }),
          execute: async ({ value }: { value: string }) => ({ echoed: value }),
        }),
      },
      maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
      toolApprovals: {},
      ephemeralImages: null,
    })
    const bodies = useLane('anthropic', [() => anthropicToolCall(1), () => anthropicAnswer()])

    const result = await run(subagentFor(preset))

    expect(result.status).toBe('completed')
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      // The preset's values ride every step; the per-step provider options must not replace them.
      expect(body).toMatchObject({ temperature: 0.2, max_tokens: 1024 })
      expect(body.tool_choice).toMatchObject({ disable_parallel_tool_use: true })
      expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    }
    // BL-183: no conversation-end cache point on the first request, the request-level one from the
    // second on, on the five-minute lifetime (the preset's 1-hour TTL is not sent).
    expect(bodies[0].cache_control).toBeUndefined()
    expect(bodies[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(JSON.stringify(bodies)).not.toContain('"ttl"')
  })
})

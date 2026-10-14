// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { executionViewerService } from '$lib/server/services/executionViewerService'
import { summarizeContextUsage } from '$lib/utils/tokenPanel'
import { clearLocalRuntimeContextCache } from '$lib/server/services/localRuntimeContext'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'

/**
 * BL-515 — what a send asks the model for comes from the preset the agent names, now.
 *
 * `mergePresetRuntimeSettings` laid the live preset over the copy of an older preset saved on the
 * agent when it was picked, and send-routed passed the agent's `primary_model_*` copies as
 * fallbacks. So a Temperature or Custom Parameter the user later cleared in the preset was still
 * sent, and after switching presets in the chat bar preset B sent preset A's temperature (1.2 on a
 * Claude preset is refused). Blank sends nothing; zero is real.
 *
 * BL-517 — a send with an AI Gateway preset whose model the gateway no longer lists is refused
 * with that cause.
 *
 * These run the real handler with the default lane's Redis fake. Two seams are faked, and only
 * them: the compiler's OUTPUT and the API lane's model (`VercelAIBrain`), which records the
 * request the handler hands it: the sampling settings (`temperature`, …) and `providerOptions`
 * the provider call is built from.
 */

const USER = 'user-bl515'
const AGENT = 'agent-bl515'
const PRESET = 'preset-bl515'

const mocks = vi.hoisted(() => ({
  requests: [] as any[],
  compileContent: 'Hello from the compile.'
}))

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: {
    cleanupExecutionSandboxesForSession: vi.fn(async () => [])
  }
}))

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput() {
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: mocks.compileContent }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      mocks.requests.push(request)
      const text = 'A reply.'
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let PREVIEW_POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0

function send(messages = [{ id: `msg-user-${count}`, role: 'user', content: 'Hi' }]): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: 'Hi',
        messageId: `msg-reply-${count}`,
        messages
      })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

async function setUp(options: { preset: Record<string, unknown>; agent: Record<string, unknown> }) {
  await redis.set(`model:${PRESET}`, {
    id: PRESET,
    modelName: 'Claude test preset',
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    effectiveModelId: 'claude-sonnet-5',
    connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
    contextWindow: 200_000,
    capabilities: { vision: false, tools: true },
    ...options.preset
  })
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    name: 'Probe',
    displayName: 'Probe',
    agentType: 'api',
    primary_model_preset_id: PRESET,
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-5',
    primary_model_connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
    ...options.agent
  } as any)
}

describe('send-routed: the send uses the preset the agent names, now (BL-515, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    ;({ POST: PREVIEW_POST } = await import('../context-preview/+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl515-${count}`
    mocks.requests = []
    mocks.compileContent = 'Hello from the compile.'
    clearLocalRuntimeContextCache()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-515', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['koboldcpp', 'ollama'] as const)('uses the same %s effective context for real send and preview routes', async (provider) => {
    const modelId = provider === 'koboldcpp' ? 'koboldcpp/Qwen' : 'qwen:latest'
    await setUp({ preset: { provider, modelId, effectiveModelId: modelId,
      connection: { id: `direct:${provider}`, type: 'direct', service: provider }, contextWindow: 64000,
      capabilities: { streaming: true, tools: false },
      settings: provider === 'ollama' ? { ollamaNumCtx: 8192 } : {} }, agent: {} })
    await redis.set(`local_provider:${USER}:${provider}`, { id: provider, enabled: true,
      baseUrl: 'http://local-model.test', openaiPath: '/v1', imageTransport: 'auto' })
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      const body = url.endsWith('/api/extra/version') ? { router: false, llm: true }
        : url.endsWith('/api/extra/true_max_context_length') ? { value: 16384 }
          : url.endsWith('/api/ps') ? { models: [{ name: modelId, context_length: 131072 }] }
            : { data: [{ id: modelId }] }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const history = [ { id: 'earlier-user', role: 'user', content: 'Earlier question' },
      { id: 'earlier-assistant', role: 'assistant', content: 'Earlier answer' },
      { id: `msg-user-${count}`, role: 'user', content: 'Hi' } ]
    const response = await send(history)
    expect(response.status).toBe(200)
    await response.text()
    const [snapshot] = await executionViewerService.getSnapshots(SESSION)
    const sendBudget = snapshot?.executionMetadata?.promptBudget
    expect(sendBudget?.contextLimit).toBe(provider === 'koboldcpp' ? 16384 : 8192)
    expect(sendBudget?.localContext?.source).toBe(provider === 'koboldcpp' ? 'loaded' : 'requested')
    const previewResponse = await PREVIEW_POST({ request: new Request('http://localhost/api/messages/context-preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, messages: history })
    }), fetch: globalThis.fetch, locals: { user: { id: USER } } })
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json()
    expect(preview.budget.contextLimit).toBe(sendBudget?.contextLimit)
    expect(preview.budget.localContext.source).toBe(sendBudget?.localContext?.source)
    expect(JSON.stringify(sendBudget?.localContext)).not.toContain('local-model.test')
  }, 30_000)

  it.each(['koboldcpp', 'ollama'] as const)('keeps the smaller positive %s planning cap in actual send, preview and meter', async (provider) => {
    const modelId = provider === 'koboldcpp' ? 'koboldcpp/Qwen' : 'qwen:latest'
    const preset = { provider, modelId, effectiveModelId: modelId,
      connection: { id: `direct:${provider}`, type: 'direct', service: provider }, contextWindow: 4096,
      capabilities: { streaming: true, tools: false, reasoning: false },
      settings: provider === 'ollama' ? { ollamaNumCtx: 8192 } : {} }
    await setUp({ preset, agent: {} })
    await redis.set(`local_provider:${USER}:${provider}`, { id: provider, enabled: true,
      baseUrl: 'http://local-model.test', openaiPath: '/v1', imageTransport: 'auto' })
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      return new Response(JSON.stringify(url.endsWith('/api/extra/version') ? { router: false, llm: true }
        : url.endsWith('/api/extra/true_max_context_length') ? { value: 16384 }
          : url.endsWith('/api/ps') ? { models: [{ name: modelId, context_length: 131072 }] }
            : { data: [{ id: modelId }] }), { status: 200 })
    }))
    const history = [{ id: 'earlier-user', role: 'user', content: 'Earlier question' },
      { id: 'earlier-assistant', role: 'assistant', content: 'Earlier answer' },
      { id: `msg-user-${count}`, role: 'user', content: 'Hi' }]
    const response = await send(history)
    expect(response.status).toBe(200)
    await response.text()
    const [snapshot] = await executionViewerService.getSnapshots(SESSION)
    const sendBudget = snapshot?.executionMetadata?.promptBudget
    expect(sendBudget?.contextLimit).toBe(4096)
    expect(sendBudget?.localContext?.source).toBe(provider === 'koboldcpp' ? 'loaded' : 'requested')
    const previewResponse = await PREVIEW_POST({ request: new Request('http://localhost/api/messages/context-preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, messages: history })
    }), fetch: globalThis.fetch, locals: { user: { id: USER } } })
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json()
    expect(preview.budget.contextLimit).toBe(sendBudget?.contextLimit)
    expect(preview.budget.localContext.note).toBe(sendBudget?.localContext?.note)
    expect(preview.budget.localContext.note).toContain('smaller preset limit of 4,096')
    expect(preview.budget.localContext.note).toContain(provider === 'koboldcpp' ? 'loaded context of 16,384' : 'asked to use 8,192')
    const meter = summarizeContextUsage({ messages: history as any, snapshots: [], activeModel: preset as any,
      agent: { id: AGENT, agentType: 'api' } as any, liveContextLimit: preview.budget.contextLimit,
      liveLocalContext: preview.budget.localContext })
    expect(meter.contextLimit).toBe(4096)
    if (provider === 'ollama') expect(mocks.requests[0].providerOptions.ollama.options.num_ctx).toBe(8192)
  }, 30_000)

  it('reserves no stale output cap after a local preset clears maxTokens in both actual routes', async () => {
    const provider = 'koboldcpp'
    const modelId = 'koboldcpp/Qwen'
    mocks.compileContent = 'token '.repeat(8000)
    await setUp({ preset: { provider, modelId, effectiveModelId: modelId,
      connection: { id: 'direct:koboldcpp', type: 'direct', service: provider },
      contextWindow: 64000, capabilities: { streaming: true, tools: false, reasoning: false }, settings: {} },
      agent: { primary_model_max_tokens: 8192 } })
    await redis.set(`local_provider:${USER}:${provider}`, { id: provider, enabled: true,
      baseUrl: 'http://local-model.test', openaiPath: '/v1', imageTransport: 'auto' })
    vi.stubGlobal('fetch', vi.fn(async (input: any) => new Response(JSON.stringify(
      String(input).endsWith('/api/extra/version') ? { router: false, llm: true }
        : String(input).endsWith('/api/extra/true_max_context_length') ? { value: 16384 }
          : { data: [{ id: modelId }] }), { status: 200 })))
    const history = [{ id: 'earlier-user', role: 'user', content: 'Earlier question' },
      { id: 'earlier-assistant', role: 'assistant', content: 'Earlier answer' },
      { id: `msg-user-${count}`, role: 'user', content: 'Hi' }]
    const previewResponse = await PREVIEW_POST({ request: new Request('http://localhost/api/messages/context-preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, messages: history })
    }), fetch: globalThis.fetch, locals: { user: { id: USER } } })
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json()
    expect(preview.budget.outputReserveTokens).toBe(0)
    const response = await send(history)
    expect(response.status).toBe(200)
    await response.text()
    expect(mocks.requests).toHaveLength(1)
    expect(mocks.requests[0].maxTokens).toBeUndefined()
    const [snapshot] = await executionViewerService.getSnapshots(SESSION)
    const budget = snapshot?.executionMetadata?.promptBudget
    expect(budget?.outputReserveTokens).toBe(0)
    expect(budget?.contextLimit).toBe(16384)
    expect(budget?.estimatedRuntimeTokens).toBeGreaterThan(8192)
    expect(budget?.estimatedRuntimeTokens).toBeLessThan(16384)
    expect(preview.budget.estimatedRuntimeTokens).toBe(budget?.estimatedRuntimeTokens)
  }, 30_000)

  it('a value cleared in the preset is not sent, though the agent still holds the old copy', async () => {
    // The agent picked the preset while it said temperature 0.7 and a Custom Parameter; the user
    // has since cleared both in the preset.
    await setUp({
      preset: { settings: {} },
      agent: {
        primary_model_temperature: 0.7,
        provider_specific_settings: { temperature: 0.7, customKnob: 5, nativeTools: { bashAccessMode: 'plan' } }
      }
    })
    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.requests).toHaveLength(1)
    const request = mocks.requests[0]
    expect(request.temperature).toBeUndefined()
    expect(JSON.stringify(request.providerOptions ?? {})).not.toContain('customKnob')
    // The agent's own tool settings still reach the run.
    expect(request.providerSettings).toMatchObject({ nativeTools: { bashAccessMode: 'plan' } })
    expect(request.providerSettings).not.toHaveProperty('temperature')
  }, 30_000)

  it('after switching from a preset with temperature 1.2 to one with none, none is sent', async () => {
    // What the old chat-bar picker left behind: preset B named, preset A's 1.2 still on the agent.
    await setUp({
      preset: { settings: {} },
      agent: { primary_model_temperature: 1.2, provider_specific_settings: {} }
    })
    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.requests[0].temperature).toBeUndefined()
  }, 30_000)

  it('a preset temperature of 0 is sent as 0 (zero is real)', async () => {
    await setUp({
      preset: { settings: { temperature: 0 } },
      agent: { primary_model_temperature: 1.2, provider_specific_settings: { temperature: 1.2 } }
    })
    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.requests[0].temperature).toBe(0)
  }, 30_000)

  it('the preset value is sent (control)', async () => {
    await setUp({
      preset: { settings: { temperature: 0.4, customKnob: 9 } },
      agent: { primary_model_temperature: 1.2, provider_specific_settings: { temperature: 1.2 } }
    })
    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.requests[0].temperature).toBe(0.4)
    expect(mocks.requests[0].providerOptions?.anthropic?.customKnob).toBe(9)
  }, 30_000)

  it('BL-517: a gateway preset whose model the gateway no longer lists is refused with that cause', async () => {
    // A fresh cached catalog that lists another gateway model, not this one.
    await redis.set('vercel:model_catalog:v1', {
      models: [
        {
          id: 'anthropic/claude-sonnet-5',
          canonicalId: 'anthropic/claude-sonnet-5',
          provider: 'anthropic',
          name: 'claude-sonnet-5',
          displayName: 'Claude Sonnet 5',
          tags: [],
          features: {},
          source: 'vercel',
          idVariants: {
            'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-sonnet-5', effectiveId: 'anthropic/claude-sonnet-5', source: 'vercel' }
          }
        }
      ],
      fetchedAt: new Date().toISOString()
    })
    await setUp({
      preset: {
        modelName: 'Retired GPT',
        provider: 'openai',
        modelId: 'gpt-4.1-old',
        effectiveModelId: 'openai/gpt-4.1-old',
        catalogModelId: 'openai/gpt-4.1-old',
        vercelSourceId: 'openai/gpt-4.1-old',
        isVercelImport: true,
        connection: { type: 'vercel-gateway', service: 'vercel' },
        settings: {}
      },
      agent: {}
    })
    const response = await send()
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({
      code: 'model_preset_unavailable',
      error:
        'Vercel AI Gateway no longer lists openai/gpt-4.1-old, the model of the selected primary model preset "Retired GPT". Pick another model in Agent settings.'
    })
    expect(mocks.requests).toHaveLength(0)
  }, 30_000)
})

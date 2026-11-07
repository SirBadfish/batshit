// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { executionViewerService } from '$lib/server/services/executionViewerService'
import { summarizeContextUsage } from '$lib/utils/tokenPanel'
import { clearLocalRuntimeContextCache } from '$lib/server/services/localRuntimeContext'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import { agentSetupCache } from '$lib/server/services/agentSetupCache'

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
  compileContent: 'Hello from the compile.',
  refuseSetupBudget: false,
  preparations: [] as any[]
}))

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: {
    cleanupExecutionSandboxesForSession: vi.fn(async () => [])
  }
}))

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  const { ToolHintBudgetError } = await import('$lib/server/services/dynamicMcpIndex')
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput() {
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: mocks.compileContent }], metadata: {} },
        resolvedProjectPath: null,
        ...(mocks.refuseSetupBudget ? { finalizeAgentSetup: async () => { throw new ToolHintBudgetError(500, 24000) } } : {})
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async prepareApiToolset(request: any) {
      mocks.preparations.push(request)
      const { captureApiUtilities } = await import('$lib/server/services/apiUtilityRuntime')
      return { fingerprint: 'fixture-actual-definitions', brokerAvailable: true, toolsRegistered: true,
        apiUtilityScope: captureApiUtilities({ identity: request, approvals: {} }).scope }
    }
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
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
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
    modelId: 'claude-sonnet-4-6',
    effectiveModelId: 'claude-sonnet-4-6',
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
    primary_model_name: 'claude-sonnet-4-6',
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
    mocks.refuseSetupBudget = false
    mocks.preparations = []
    agentSetupCache.clearAll()
    clearLocalRuntimeContextCache()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-515', agent_id: AGENT } as any)

  })

  afterEach(() => {
    agentSetupCache.clearAll()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('surfaces a compiler budget refusal before model dispatch or cache publication', async () => {
    await setUp({ preset: {}, agent: {} })
    const identity = { userId: USER, agentId: AGENT, sessionId: SESSION }
    const live = { sources: [{ id: 'fixture', label: 'Fixture', available: true }], blocks: [{ key: 'fixture', source: 'fixture',
      section: 'facts' as const, order: 0, text: 'existing setup', items: [{ key: 'fixture', label: 'Fixture', text: 'existing setup' }] }] }
    const first = agentSetupCache.prepare({ identity, live, precedingBytes: 'unchanged', toolFingerprint: 'old-definitions' })
    agentSetupCache.modelCalled(first)
    const committed = vi.spyOn(agentSetupCache, 'commit')
    const called = vi.spyOn(agentSetupCache, 'modelCalled')
    const snapshots = vi.spyOn(executionViewerService, 'recordSnapshot')
    mocks.refuseSetupBudget = true
    const response = await send()
    const body = await response.text()
    expect(response.status).toBe(400)
    expect(body).toContain('Total Hint Budget is 500')
    expect(body).toContain('at least 24000')
    expect(body).toContain('reduce/shorten enabled group metadata')
    expect(mocks.preparations).toHaveLength(1)
    expect(mocks.requests).toHaveLength(0)
    expect(committed).not.toHaveBeenCalled()
    expect(called).not.toHaveBeenCalled()
    expect(snapshots).not.toHaveBeenCalled()
    const retained = agentSetupCache.prepare({ identity, live, precedingBytes: 'unchanged', toolFingerprint: 'old-definitions', preview: true })
    expect(retained.refresh).toBeNull()
    expect(retained.text).toBe(first.text)
  })

  it('captures one exact local Thinking snapshot before primary selection and freezes the actual model tag into the request', async () => {
    const connection = { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' }, effectiveModelId = 'qwen3.5:9b-q4_K_M'
    const key = reasoningOverrideKey({ presetId: PRESET, connection, effectiveModelId }, 'thinking')
    await setUp({ preset: { provider: 'qwen', modelId: 'catalog/qwen-local', effectiveModelId, connection, contextWindow: 4096,
      capabilities: { tools: false, reasoning: false }, settings: { temperature: 0, 'ollama.options.num_ctx': 4096 } },
      agent: { model_reasoning_overrides: { [key]: { mode: 'value', value: true } } } })
    await redis.set(`local_provider:${USER}:ollama`, { id: 'ollama', enabled: true, baseUrl: 'http://local-model.test', openaiPath: '/v1', imageTransport: 'auto' })
    const http = vi.fn(async (input: any) => Response.json(String(input).endsWith('/api/version') ? { version: '0.40.3' }
      : String(input).endsWith('/api/show') ? { capabilities: ['thinking'], thinking: { values: [false, true], default: true } }
        : { models: [] }))
    vi.stubGlobal('fetch', http)
    const response = await send()
    expect(response.status, await response.clone().text()).toBe(200)
    await response.text()
    const shows = http.mock.calls.filter(call => String(call[0]).endsWith('/api/show'))
    expect(shows).toHaveLength(1)
    expect(http.mock.calls.filter(call => String(call[0]).endsWith('/api/version'))).toHaveLength(1)
    expect(JSON.parse(String((shows[0] as any)[1].body))).toEqual({ model: effectiveModelId, verbose: false })
    expect(mocks.requests).toHaveLength(1)
    const request = mocks.requests[0]
    expect(request.model).toBe(effectiveModelId)
    expect(request.providerOptions.ollama).toMatchObject({ think: true, options: { num_ctx: 4096 } })
    expect(request.providerOptions.batshit_reasoning.ollama).toMatchObject({ modelId: effectiveModelId, mode: 'value', value: true })
    expect(request.providerOptions.batshit_reasoning.ollama.connectionKey).toMatch(/^[a-f0-9]{64}$/)
    expect((await redis.get(`model:${PRESET}`)).settings).toEqual({ temperature: 0, 'ollama.options.num_ctx': 4096 })
  }, 30_000)

  it('keeps inherited local requests free of reasoning metadata reads and refuses an unverified explicit choice before the model', async () => {
    const connection = { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' }, effectiveModelId = 'qwen3.5:9b-q4_K_M'
    const key = reasoningOverrideKey({ presetId: PRESET, connection, effectiveModelId }, 'thinking')
    await setUp({ preset: { provider: 'qwen', modelId: 'catalog/qwen-local', effectiveModelId, connection, contextWindow: 4096,
      capabilities: { tools: false }, settings: { 'ollama.options.num_ctx': 4096 } }, agent: {} })
    await redis.set(`local_provider:${USER}:ollama`, { id: 'ollama', enabled: true, baseUrl: 'http://local-model.test', openaiPath: '/v1' })
    const http = vi.fn(async () => Response.json({ models: [] }))
    vi.stubGlobal('fetch', http)
    const inherited = await send()
    expect(inherited.status).toBe(200); await inherited.text()
    expect(http.mock.calls.some(call => /\/api\/(?:show|version)$/.test(String(call[0])))).toBe(false)
    expect(mocks.requests[0].providerOptions).not.toHaveProperty('batshit_reasoning')
    await redis.updateAgent(AGENT, { model_reasoning_overrides: { [key]: { mode: 'value', value: false } } } as any)
    mocks.requests = []
    const failure = await send()
    const body = await failure.text()
    expect(body).toMatch(/not verified|not supported/i)
    expect(mocks.requests).toHaveLength(0)
    expect(http.mock.calls.filter(call => String(call[0]).endsWith('/api/version'))).toHaveLength(1)
    expect(http.mock.calls.some(call => String(call[0]).endsWith('/api/show'))).toBe(false)
    expect((await redis.get(`agent:${AGENT}`))?.model_reasoning_overrides).toEqual({ [key]: { mode: 'value', value: false } })
  }, 30_000)

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
          id: 'anthropic/claude-sonnet-4-6',
          canonicalId: 'anthropic/claude-sonnet-4-6',
          provider: 'anthropic',
          name: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 5',
          tags: [],
          features: {},
          source: 'vercel',
          idVariants: {
            'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-sonnet-4-6', effectiveId: 'anthropic/claude-sonnet-4-6', source: 'vercel' }
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

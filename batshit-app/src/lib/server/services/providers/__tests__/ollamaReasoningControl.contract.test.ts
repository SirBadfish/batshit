// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai')
vi.unmock('ollama-ai-provider-v2')
import { generateText, streamText, tool, jsonSchema, isStepCount } from 'ai'
import { ProviderManager } from '../index'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import { localAiConnectionKey } from '../../localAiConnectionIdentity'
import { qualifyOllamaReasoningMetadata } from '../../localModelReasoning'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'

const userId = 'local-reasoning-owner', modelId = 'qwen3.5:9b-q4_K_M', baseUrl = 'http://ollama.fixture:11434'
const connection = { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' }
const identity = { presetId: 'shared-local', connection, effectiveModelId: modelId }
const key = reasoningOverrideKey(identity, 'thinking')
const contract = qualifyOllamaReasoningMetadata(modelId, '0.40.3', { capabilities: ['thinking'], thinking: { values: [false, true], default: true } })
const connectionKey = localAiConnectionKey(userId, 'ollama', { baseUrl, apiKey: null })
const preset = { id: identity.presetId, provider: 'qwen', modelId: 'catalog/qwen-local', effectiveModelId: modelId, connection,
  capabilities: { reasoning: false }, settings: { 'ollama.options.top_k': 1, 'ollama.options.num_ctx': 4096, temperature: 0 } } as any
function manager(url = baseUrl) {
  return new ProviderManager({ userId, apiKeys: {}, localProviders: [{ ...LOCAL_AI_SERVER_DEFINITIONS.find(value => value.id === 'ollama')!,
    baseUrl: url, openaiPath: '/v1', enabled: true, source: 'stored', imageTransport: 'auto', imageBaseUrl: url }] })
}
function options(selection?: any, localPreset = preset) {
  const selected = resolveRuntimeModelSelection({ preset: localPreset, localReasoning: contract,
    reasoningOverrides: selection === undefined ? {} : { [key]: selection } })
  expect(selected.effectiveModelId).toBe(modelId)
  expect(selected.modelId).toBe('catalog/qwen-local')
  return buildRuntimeModelSettings({ provider: 'qwen', modelId: selected.effectiveModelId, connection, capabilities: localPreset.capabilities,
    settings: selected.settings, localReasoning: contract, localReasoningConnectionKey: connectionKey, explicitReasoning: selected.explicitReasoning })
}
const final = { model: modelId, created_at: '2026-10-15T00:00:00Z', message: { role: 'assistant', content: 'Done.' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 1 }
afterEach(() => vi.unstubAllGlobals())
describe('P6 real installed Ollama SDK and per-call defaults', () => {
  it('preserves inherited false, sends explicit bools, and truly omits Provider default without changing samplers', async () => {
    const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json(final) }))
    const model = manager().getModel(modelId, { transport: 'direct', service: 'ollama' })
    for (const selection of [undefined, { mode: 'value', value: true }, { mode: 'value', value: false }, { mode: 'provider-default' }]) {
      const mapped = options(selection)
      const result = await generateText({ model, prompt: 'Hello', maxRetries: 0, maxOutputTokens: 5, temperature: mapped.standard.temperature,
        providerOptions: mapped.providerOptions, include: { requestBody: true } })
      const body = bodies.at(-1)
      expect(body.model).toBe(modelId)
      expect(body.options).toMatchObject({ temperature: 0, num_predict: 5, top_k: 1, num_ctx: 4096 })
      expect(body).not.toHaveProperty('batshit_reasoning'); expect(body).not.toHaveProperty('connectionKey')
      if (selection?.mode === 'provider-default') expect(body).not.toHaveProperty('think')
      else expect(body.think).toBe(selection?.value ?? false)
      if (selection) expect(result.request.body).toEqual(body)
    }
    expect(preset.settings).toEqual({ 'ollama.options.top_k': 1, 'ollama.options.num_ctx': 4096, temperature: 0 })
  })
  it('keeps the preset capability filter on inherit and overrides only the explicit local choice', async () => {
    const localPreset = { ...preset, settings: { ...preset.settings, ollamaThink: true } }
    expect(options(undefined, localPreset).providerOptions.ollama?.think).toBeUndefined()
    expect(options({ mode: 'value', value: true }, localPreset).providerOptions.ollama.think).toBe(true)
    expect(localPreset.capabilities.reasoning).toBe(false)
    const selected = resolveRuntimeModelSelection({ preset: localPreset, localReasoning: contract, reasoningOverrides: { [key]: { mode: 'value', value: true } } })
    expect(() => buildRuntimeModelSettings({ provider: 'qwen', modelId, connection, localReasoning: contract, explicitReasoning: selected.explicitReasoning, settings: selected.settings })).toThrow(/server-owned/)
  })
  it.each([true, 'default'] as const)('freezes %s intent through native streaming tool steps and preserves matching key text', async choice => {
    const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const first = bodies.length === 1
      const parts = first ? [{ ...final, done: false, message: { role: 'assistant', content: '', thinking: 'Plan.',
        tool_calls: [{ function: { name: 'lookup', arguments: {} } }] } }, { ...final, message: { role: 'assistant', content: '' } }]
        : [final]
      return new Response(parts.map(value => JSON.stringify(value)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
    }))
    const saved = { [key]: choice === 'default' ? { mode: 'provider-default' as const } : { mode: 'value' as const, value: true } }
    const selected = resolveRuntimeModelSelection({ preset, localReasoning: contract, reasoningOverrides: saved })
    const mapped = buildRuntimeModelSettings({ provider: 'qwen', modelId, connection, localReasoning: contract,
      localReasoningConnectionKey: connectionKey, explicitReasoning: selected.explicitReasoning, settings: selected.settings })
    const result = streamText({ model: manager().getModel(modelId, { transport: 'direct', service: 'ollama' }),
      messages: [{ role: 'user', content: `Ordinary management receipt: ${connectionKey}` }], providerOptions: mapped.providerOptions,
      include: { requestBody: true }, maxRetries: 0, stopWhen: isStepCount(3),
      tools: { lookup: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => {
        saved[key] = { mode: 'value', value: false }; return `Tool receipt: ${connectionKey}`
      } }) } })
    await result.consumeStream()
    expect(await result.text).toBe('Done.')
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      if (choice === 'default') expect(body).not.toHaveProperty('think'); else expect(body.think).toBe(true)
      expect(body).not.toHaveProperty('batshit_reasoning'); expect(body).not.toHaveProperty('connectionKey')
      expect(JSON.stringify(body.messages)).toContain(connectionKey)
    }
    expect((await result.steps).map(step => step.request.body)).toEqual(bodies)
    expect(JSON.stringify(bodies[1].messages)).toContain('Tool receipt:')
  })
  it('refuses metadata for endpoint A when the actual provider is now endpoint B, before generation', async () => {
    const http = vi.fn(async () => Response.json(final)); vi.stubGlobal('fetch', http)
    await expect(generateText({ model: manager('http://another.fixture:11434').getModel(modelId, { transport: 'direct', service: 'ollama' }),
      prompt: 'Hello', providerOptions: options({ mode: 'value', value: true }).providerOptions, maxRetries: 0 })).rejects.toThrow(/could not be applied safely/)
    expect(http).not.toHaveBeenCalled()
  })
  it.each([{ modelId: 'different-tag' }, { value: 'false' }, { runtimeVersion: 'unknown' }, { adapterVersion: '4.0.2' }])('refuses an invalid explicit SDK marker before transport', async replacement => {
    const http = vi.fn(async () => Response.json(final)); vi.stubGlobal('fetch', http)
    const mapped = options({ mode: 'value', value: false })
    Object.assign(mapped.providerOptions.batshit_reasoning.ollama, replacement)
    await expect(generateText({ model: manager().getModel(modelId, { transport: 'direct', service: 'ollama' }), prompt: 'Hello',
      providerOptions: mapped.providerOptions, maxRetries: 0 })).rejects.toThrow(/could not be applied safely/)
    expect(http).not.toHaveBeenCalled()
  })
  it('preserves image URL refusal and abort plumbing on the new explicit path', async () => {
    const http = vi.fn(async () => Response.json(final)); vi.stubGlobal('fetch', http)
    const model = manager().getModel(modelId, { transport: 'direct', service: 'ollama' })
    await expect(generateText({ model, maxRetries: 0, providerOptions: options({ mode: 'provider-default' }).providerOptions,
      messages: [{ role: 'user', content: [{ type: 'image', image: 'http://fixture/image.png' }] }] })).rejects.toThrow(/Select Automatic image transport/)
    expect(http).not.toHaveBeenCalled()
    const stop = new AbortController()
    await generateText({ model, prompt: 'Hello', maxRetries: 0, abortSignal: stop.signal, providerOptions: options({ mode: 'value', value: false }).providerOptions })
    expect((http.mock.calls[0] as any)[1].signal).toBeInstanceOf(AbortSignal)
  })
})

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai')
vi.unmock('@ai-sdk/openai')
vi.unmock('@ai-sdk/alibaba')
import { generateText, streamText, isStepCount, jsonSchema, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAlibaba } from '@ai-sdk/alibaba'
import { ProviderManager } from '../index'
import { nativeReasoningChatModel } from '../nativeReasoningBody'
import { batshitProviderHeaders } from '../batshitIdentity'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import { reviewedReasoningBinding } from '$lib/data/reasoning-controls'

const keys = { mimo: 'sk-mimo-fixture-0123456789', qwencloud: 'dashscope-fixture-0123456789' }
const manager = () => new ProviderManager({ apiKeys: keys })
const connection = (service: string) => ({ type: 'direct' as const, id: `direct:${service}`, service })
function runtime(service: string, modelId: string, settings: Record<string, any>, selection?: unknown) {
  const preset = { id: 'native-shared', provider: service === 'mimo' ? 'xiaomi' : 'zai', modelId, connection: connection(service), settings } as any
  const id = service === 'mimo' ? 'thinking' : 'effort'
  const overrideKey = reasoningOverrideKey({ presetId: preset.id, connection: preset.connection, effectiveModelId: modelId }, id)
  const resolved = resolveRuntimeModelSelection({ preset, reasoningOverrides: selection === undefined ? {} : { [overrideKey]: selection } as any })
  return buildRuntimeModelSettings({ provider: preset.provider, modelId, connection: preset.connection, settings: resolved.settings })
}
const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
function answer() { return Response.json({ id: 'fixture', model: 'fixture', created: 1, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }], usage }) }
function chunk(delta: Record<string, any>, finish_reason: string | null = null) { return { id: 'fixture', model: 'fixture', created: 1, choices: [{ index: 0, delta, finish_reason }] } }
function streamed(step: number) {
  const data = step === 1 ? [chunk({ role: 'assistant', reasoning_content: 'Plan: "look up". 🦇' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_native', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }), chunk({}, 'tool_calls')]
    : [chunk({ role: 'assistant', content: 'Done.' }), chunk({}, 'stop')]
  return new Response([...data, { id: 'fixture', model: 'fixture', created: 1, choices: [], usage }].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
function capture(response: (body: any, count: number) => Response | Promise<Response> = () => answer()) {
  const bodies: any[] = [], raw: string[] = [], inits: RequestInit[] = []
  const fetch = vi.fn(async (_url: any, init?: RequestInit) => {
    raw.push(String(init?.body)); const body = JSON.parse(raw.at(-1)!); bodies.push(body); inits.push(init!)
    expect(body).not.toHaveProperty('batshit_reasoning')
    return response(body, bodies.length)
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, bodies, raw, inits }
}
afterEach(() => vi.unstubAllGlobals())

describe('SA-132 native fields around the real installed provider serializers', () => {
  it.each(['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-pro'])('sends real boolean On/Off for direct MiMo %s and preserves legacy effort/samplers', async modelId => {
    const wire = capture()
    const model = manager().getModel(modelId, { transport: 'direct', service: 'mimo' })
    const settings = { mimoThinking: true, 'openai.reasoningEffort': 'high', 'openai.parallelToolCalls': false, temperature: 0, topP: 0.8, maxTokens: 512 }
    for (const value of [true, false]) {
      const mapped = runtime('mimo', modelId, settings, { mode: 'value', value })
      const result = await generateText({ model, prompt: 'Hello', ...mapped.standard, maxOutputTokens: mapped.standard.maxTokens, providerOptions: mapped.providerOptions, include: { requestBody: true }, maxRetries: 0 })
      const body = wire.bodies.at(-1)
      expect(body).toMatchObject({ thinking: { type: value ? 'enabled' : 'disabled' }, reasoning_effort: 'high', temperature: 0, top_p: 0.8, parallel_tool_calls: false })
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(512)
      expect(result.request.body).toEqual(body)
    }
    const inherited = runtime('mimo', modelId, settings)
    expect(inherited.providerOptions.batshit_reasoning.mimoThinking).toBe(true)
    const defaults = runtime('mimo', modelId, settings, { mode: 'provider-default' })
    await generateText({ model, prompt: 'Default', providerOptions: defaults.providerOptions, include: { requestBody: true }, maxRetries: 0 })
    expect(wire.bodies.at(-1)).not.toHaveProperty('thinking')
    expect(wire.bodies.at(-1).reasoning_effort).toBe('high')
    expect(settings).toEqual({ mimoThinking: true, 'openai.reasoningEffort': 'high', 'openai.parallelToolCalls': false, temperature: 0, topP: 0.8, maxTokens: 512 })
  })

  it('adds only exact GLM effort after Alibaba serialization; old ignored custom effort stays ignored', async () => {
    const wire = capture()
    const model = manager().getModel('glm-5.3', { transport: 'direct', service: 'qwencloud' })
    const settings = { qwenReasoningEffort: 'high', 'alibaba.reasoningEffort': 'max', 'alibaba.enableThinking': true, 'alibaba.thinkingBudget': 2048, temperature: 0.2, maxTokens: 512 }
    for (const value of ['low', 'high', 'max']) {
      const mapped = runtime('qwencloud', 'glm-5.3', settings, { mode: 'value', value })
      const result = await generateText({ model, prompt: 'Hello', ...mapped.standard, maxOutputTokens: mapped.standard.maxTokens, providerOptions: mapped.providerOptions, include: { requestBody: true }, maxRetries: 0 })
      expect(wire.bodies.at(-1)).toMatchObject({ reasoning_effort: value, enable_thinking: true, thinking_budget: 2048, temperature: 0.2 })
      expect(wire.bodies.at(-1).max_tokens).toBe(512)
      expect(result.request.body).toEqual(wire.bodies.at(-1))
    }
    const defaults = runtime('qwencloud', 'glm-5.3', settings, { mode: 'provider-default' })
    await generateText({ model, prompt: 'Default', providerOptions: defaults.providerOptions, include: { requestBody: true }, maxRetries: 0 })
    expect(wire.bodies.at(-1)).not.toHaveProperty('reasoning_effort')
    expect(settings['alibaba.reasoningEffort']).toBe('max')
  })

  it.each(['mimo', 'qwencloud'] as const)('no new %s control keeps the previous SDK body byte-equivalent', async service => {
    const wire = capture()
    const modelId = service === 'mimo' ? 'mimo-v2.5-pro' : 'glm-5.3'
    const settings = service === 'mimo' ? { 'openai.reasoningEffort': 'high', 'openai.parallelToolCalls': false, 'mimo.thinking': { type: 'disabled' }, temperature: 0.2 }
      : { 'alibaba.reasoningEffort': 'max', 'alibaba.enableThinking': true, 'alibaba.thinkingBudget': 2048, temperature: 0.2 }
    const mapped = runtime(service, modelId, settings)
    const plain = service === 'mimo' ? createOpenAI({ apiKey: keys.mimo, baseURL: 'https://api.xiaomimimo.com/v1', headers: batshitProviderHeaders() }).chat(modelId)
      : createAlibaba({ apiKey: keys.qwencloud, headers: batshitProviderHeaders() })(modelId)
    const options = { prompt: 'Same prompt', ...mapped.standard, maxOutputTokens: mapped.standard.maxTokens, providerOptions: mapped.providerOptions, include: { requestBody: true }, maxRetries: 0 }
    await generateText({ ...options, model: plain })
    await generateText({ ...options, model: manager().getModel(modelId, { transport: 'direct', service }) })
    expect(wire.raw[1]).toBe(wire.raw[0])
    if (service === 'mimo') expect(wire.bodies[1]).not.toHaveProperty('thinking')
    else expect(wire.bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it.each(['mimo', 'qwencloud'] as const)('freezes %s selection through streaming tools and retains existing carry', async service => {
    const wire = capture((_body, step) => streamed(step))
    const modelId = service === 'mimo' ? 'mimo-v2.5-pro' : 'glm-5.3'
    const model = manager().getModel(modelId, { transport: 'direct', service })
    const selected = service === 'mimo' ? true : 'max'
    const mapped = runtime(service, modelId, {}, { mode: 'value', value: selected })
    const result = streamText({ model, messages: [{ role: 'user', content: 'Use lookup' }], providerOptions: mapped.providerOptions, include: { requestBody: true }, maxRetries: 0,
      tools: { lookup: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => 'Found it.' }) }, stopWhen: isStepCount(3) })
    const parts: any[] = []; for await (const part of result.stream) parts.push(part)
    expect(await result.text).toBe('Done.')
    expect(wire.bodies).toHaveLength(2)
    expect(wire.bodies.map(body => service === 'mimo' ? body.thinking.type : body.reasoning_effort)).toEqual(service === 'mimo' ? ['enabled', 'enabled'] : ['max', 'max'])
    expect(wire.bodies[1].messages.find((message: any) => message.role === 'assistant')).toMatchObject({ reasoning_content: 'Plan: "look up". 🦇' })
    expect(parts.some(part => part.type === 'reasoning-delta')).toBe(true)
    expect((await result.steps).map(step => step.request.body)).toEqual(wire.bodies)
  })

  it('keeps simultaneous opposite MiMo selections, headers and abort signals local to each call', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const wire = capture(async body => { if (body.thinking.type === 'enabled') await gate; return answer() })
    const model = manager().getModel('mimo-v2.5', { transport: 'direct', service: 'mimo' })
    const stop = new AbortController()
    const on = generateText({ model, prompt: 'On', providerOptions: runtime('mimo', 'mimo-v2.5', {}, { mode: 'value', value: true }).providerOptions, abortSignal: stop.signal, headers: { 'X-Fixture': 'on' }, include: { requestBody: true }, maxRetries: 0 })
    await vi.waitFor(() => expect(wire.bodies).toHaveLength(1))
    const off = await generateText({ model, prompt: 'Off', providerOptions: runtime('mimo', 'mimo-v2.5', {}, { mode: 'value', value: false }).providerOptions, headers: { 'X-Fixture': 'off' }, include: { requestBody: true }, maxRetries: 0 })
    expect(wire.bodies.map(body => body.thinking.type)).toEqual(['enabled', 'disabled'])
    expect(new Headers(wire.inits[0].headers).get('X-Fixture')).toBe('on')
    expect(new Headers(wire.inits[1].headers).get('X-Fixture')).toBe('off')
    expect(wire.inits[0].signal).toBeInstanceOf(AbortSignal)
    release(); const enabled = await on
    expect((enabled.request.body as any).thinking.type).toBe('enabled')
    expect((off.request.body as any).thinking.type).toBe('disabled')
  })

  it('refuses invalid, cross-route and unreviewed-model markers before transport', async () => {
    const wire = capture()
    for (const [service, modelId, marker] of [
      ['mimo', 'mimo-v2.5', { mimoThinking: 'false' }], ['mimo', 'mimo-v2.5', { qwenEffort: 'max' }],
      ['mimo', 'unreviewed-mimo', { mimoThinking: true }], ['qwencloud', 'glm-5.3', { qwenEffort: 'medium' }]
    ] as const) {
      await expect(manager().getModel(modelId, { transport: 'direct', service }).doGenerate({ prompt: [], providerOptions: { batshit_reasoning: marker } } as any)).rejects.toThrow(/not sent/)
    }
    expect(() => runtime('mimo', 'mimo-v2.5', { mimoThinking: 'false' })).toThrow(/unsupported/)
    expect(() => runtime('qwencloud', 'glm-5.3', { qwenReasoningEffort: 'medium' })).toThrow(/unsupported/)
    for (const service of ['mimo_token_plan', 'qwen_token_plan']) {
      const modelId = service === 'mimo_token_plan' ? 'mimo-v2.5' : 'glm-5.3'
      expect(reviewedReasoningBinding({ modelId, connection: connection(service) })).toBeNull()
      expect(() => runtime(service, modelId, {}, { mode: 'value', value: 'max' })).toThrow(/not verified/)
    }
    expect(wire.fetch).not.toHaveBeenCalled()
  })

  it.each(['not JSON', JSON.stringify({ model: 'wrong', messages: [] }), JSON.stringify({ model: 'mimo-v2.5', messages: [], thinking: { type: 'disabled' } })])(
    'refuses an unsafe serialized body before transport: %s', async body => {
      const wire = capture()
      const factory = (fetch?: typeof globalThis.fetch) => ({ specificationVersion: 'v4', provider: 'fixture', modelId: 'mimo-v2.5', supportedUrls: {},
        doGenerate: async () => { await fetch?.('https://fixture/chat/completions', { method: 'POST', body }); return {} } }) as any
      const model = nativeReasoningChatModel('mimo', 'mimo-v2.5', factory)
      await expect(model.doGenerate({ prompt: [], providerOptions: { batshit_reasoning: { mimoThinking: true } } })).rejects.toThrow(/not sent/)
      expect(wire.fetch).not.toHaveBeenCalled()
    })
})

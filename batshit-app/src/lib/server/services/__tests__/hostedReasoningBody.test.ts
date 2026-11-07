// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.unmock('ai')
vi.unmock('@ai-sdk/google')
vi.unmock('@ai-sdk/anthropic')
import { generateText, tool, jsonSchema, isStepCount } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { resolveModelReasoningControls, reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import { previewModelReasoningControls, availableReasoningParameterValues } from '$lib/utils/modelReasoningPreview'

const connection = { type: 'direct' as const, id: 'direct:google', service: 'google' }
describe('SA-132 real Google serializer and final control options', () => {
  it.each(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash'])('sends exact %s levels unchanged and preserves nested siblings', async modelId => {
    const bodies: any[] = []
    const model = createGoogleGenerativeAI({ apiKey: 'fixture-only', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } })
    } })(modelId)
    const identity = { presetId: 'google-preset', connection, effectiveModelId: modelId }
    const settings = { 'google.thinkingConfig': { includeThoughts: true, thinkingLevel: 'low' } }
    for (const level of [...(modelId === 'gemini-3.6-flash' ? ['minimal'] : []), 'low', 'medium', 'high', 'default']) {
      const resolved = resolveModelReasoningControls({ identity, settings, overrides: {
        [reasoningOverrideKey(identity, 'effort')]: level === 'default' ? { mode: 'provider-default' } : { mode: 'value', value: level }
      } })
      const runtime = buildRuntimeModelSettings({ provider: 'google', modelId, connection, settings: resolved.settings })
      expect((await generateText({ model, prompt: 'Hello', providerOptions: runtime.providerOptions, maxRetries: 0 })).text).toBe('Done.')
      expect(bodies.at(-1).generationConfig.thinkingConfig).toEqual({ includeThoughts: true, ...(level === 'default' ? {} : { thinkingLevel: level }) })
    }
    expect(settings['google.thinkingConfig']).toEqual({ includeThoughts: true, thinkingLevel: 'low' })
    expect(() => buildRuntimeModelSettings({ provider: 'google', modelId, connection,
      settings: { googleThinkingLevel: 'high', thinkingBudget: 1024 } })).toThrow(/not converted/)
    if (modelId !== 'gemini-3.6-flash') expect(() => buildRuntimeModelSettings({ provider: 'google', modelId, connection,
      settings: { 'google.thinkingConfig.thinkingLevel': 'minimal' } })).toThrow(/unsupported/)
  })
  it.each([
    ['gemini-2.5-pro', [-1, 128, 32768]], ['gemini-2.5-flash', [-1, 0, 1, 24576]], ['gemini-2.5-flash-lite', [-1, 0, 512, 24576]]
  ] as const)('serializes exact %s budgets, special values and omission without changing output limits', async (modelId, values) => {
    const bodies: any[] = []
    const model = createGoogleGenerativeAI({ apiKey: 'fixture-only', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } })
    } })(modelId)
    const identity = { presetId: 'budget-preset', connection, effectiveModelId: modelId }
    const settings = { thinkingBudget: 2048, 'google.thinkingConfig': { includeThoughts: false, thinkingBudget: 1024 } }
    for (const value of [...values, 'default', 'inherit'] as const) {
      const resolved = resolveModelReasoningControls({ identity, settings, overrides: value === 'inherit' ? {} : {
        [reasoningOverrideKey(identity, 'budget')]: value === 'default' ? { mode: 'provider-default' } : { mode: 'value', value }
      } })
      const mapped = buildRuntimeModelSettings({ provider: 'google', modelId, connection, settings: resolved.settings })
      await generateText({ model, prompt: 'Hello', maxOutputTokens: 64, providerOptions: mapped.providerOptions, maxRetries: 0 })
      expect(bodies.at(-1).generationConfig).toMatchObject({ maxOutputTokens: 64, thinkingConfig: { includeThoughts: false } })
      expect(bodies.at(-1).generationConfig.thinkingConfig.thinkingBudget).toBe(value === 'default' ? undefined : value === 'inherit' ? 1024 : value)
    }
    expect(settings).toEqual({ thinkingBudget: 2048, 'google.thinkingConfig': { includeThoughts: false, thinkingBudget: 1024 } })
  })

  it('freezes both explicit Claude controls for the complete SDK tool loop', async () => {
    const connection = { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' }
    const identity = { presetId: 'frozen-pair', connection, effectiveModelId: 'claude-sonnet-5-5' }
    const effortKey = reasoningOverrideKey(identity, 'effort'), modeKey = reasoningOverrideKey(identity, 'mode')
    const overrides = { [effortKey]: { mode: 'value' as const, value: 'max' }, [modeKey]: { mode: 'value' as const, value: 'adaptive' } }
    const frozen = resolveModelReasoningControls({ identity, settings: {}, overrides })
    const runtime = buildRuntimeModelSettings({ provider: 'anthropic', modelId: identity.effectiveModelId, connection, settings: frozen.settings })
    const bodies: any[] = []
    const model = createAnthropic({ apiKey: 'fixture-only', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'msg_pair', type: 'message', role: 'assistant', model: identity.effectiveModelId,
        content: bodies.length === 1 ? [{ type: 'tool_use', id: 'tool_pair', name: 'echo', input: {} }] : [{ type: 'text', text: 'Done.' }],
        stop_reason: bodies.length === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } })
    } })(identity.effectiveModelId)
    const result = await generateText({ model, prompt: 'Hello', providerOptions: runtime.providerOptions, maxRetries: 0, stopWhen: isStepCount(3),
      tools: { echo: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => {
        overrides[effortKey] = { mode: 'value', value: 'high' }; overrides[modeKey] = { mode: 'value', value: 'between_tools' }; return 'changed next reply'
      } }) } })
    expect(result.text).toBe('Done.')
    expect(bodies.map(body => [body.thinking.type, body.output_config.effort])).toEqual([['adaptive', 'max'], ['adaptive', 'max']])
    expect(resolveModelReasoningControls({ identity, settings: {}, overrides }).settings).toEqual({ anthropicEffort: 'high', thinkingMode: 'between_tools' })
  })
  it('keeps each typed clear available without clearing another invalid field or custom parameter', () => {
    const args = { provider: 'anthropic', modelId: 'claude-sonnet-5-5', connection: { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' } }
    const settings = { thinkingMode: 'enabled', anthropicEffort: 'ultra', 'anthropic.effort': 'unverified' }
    for (const parameterName of ['thinkingMode', 'anthropicEffort']) {
      expect(availableReasoningParameterValues({ ...args, settings, parameterName })).toContain('')
      const cleared: Record<string, any> = { ...settings }
      delete cleared[parameterName]
      expect(cleared[parameterName === 'thinkingMode' ? 'anthropicEffort' : 'thinkingMode']).toBe(parameterName === 'thinkingMode' ? 'ultra' : 'enabled')
      expect(cleared['anthropic.effort']).toBe('unverified')
      expect(() => buildRuntimeModelSettings({ ...args, settings: cleared })).toThrow()
    }
    expect(settings).toEqual({ thinkingMode: 'enabled', anthropicEffort: 'ultra', 'anthropic.effort': 'unverified' })
  })
  it('uses the same effective custom precedence and tuple validation for both menus', () => {
    const identity = { presetId: 'claude', effectiveModelId: 'claude-sonnet-5-5', connection: { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' } }
    const result = previewModelReasoningControls({ identity, provider: 'anthropic', settings: { thinkingMode: 'adaptive', 'anthropic.thinking.type': 'between_tools', anthropicEffort: 'high' } })
    expect(result.controls.find(control => control.id === 'effort')!.options.filter(option => option.available).map(option => option.value)).not.toContain('max')
    expect(result.controls.find(control => control.id === 'mode')!.options.find(option => option.value === 'adaptive')!.available).toBe(true)
  })
})

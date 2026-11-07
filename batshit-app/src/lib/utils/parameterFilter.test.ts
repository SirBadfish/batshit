import { describe, expect, it } from 'vitest'
import { filterParameters, resolveParameterProvider } from './parameterFilter'

function names(values: ReturnType<typeof filterParameters>) {
  return values.map((value) => value.name)
}

describe('resolveParameterProvider', () => {
  it('uses the normalized local direct service independently of the developer', () => {
    expect(resolveParameterProvider('Qwen', { type: 'direct', service: ' VLLM ' })).toBe('vllm')
  })

  it('preserves the provider outside a local direct connection', () => {
    for (const connection of [
      undefined,
      { type: 'direct' as const, service: 'openai' },
      { type: 'direct' as const, service: 'custom_server' },
      { type: 'openrouter' as const, service: 'vllm' },
    ]) {
      expect(resolveParameterProvider('Qwen', connection)).toBe('Qwen')
    }
  })
})

describe('parameterFilter', () => {
  it.each(['claude-sonnet-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])('hides direct Anthropic controls its installed SDK ignores on %s', modelId => {
    const connectionInfo = { type: 'direct' as const, service: 'anthropic', id: 'direct:anthropic' }
    const result = names(filterParameters({ provider: 'anthropic', modelId, purpose: 'chat', connectionInfo }))
    for (const name of ['presencePenalty', 'frequencyPenalty', 'seed']) expect(result).not.toContain(name)
    const saved = names(filterParameters({ provider: 'anthropic', modelId, purpose: 'chat', connectionInfo, projection: 'saved' }))
    for (const name of ['presencePenalty', 'frequencyPenalty', 'seed']) expect(saved).toContain(name)
  })

  it.each([
    undefined, { type: 'vercel-gateway' as const, service: 'vercel', id: 'vercel-gateway' },
    { type: 'openrouter' as const, service: 'openrouter', id: 'openrouter' },
    { type: 'direct' as const, service: 'custom_claude', id: 'direct:custom_claude' },
    { type: 'direct' as const, service: 'anthropic', id: 'direct:custom_claude' }
  ])('does not transfer the direct adapter rule to another or unknown connection %j', connectionInfo => {
    const result = names(filterParameters({ provider: 'anthropic', modelId: 'claude-sonnet-4-5', purpose: 'chat', connectionInfo }))
    for (const name of ['presencePenalty', 'frequencyPenalty', 'seed']) expect(result).toContain(name)
    expect(result).toContain('temperature')
  })

  it('uses explicit direct service even without the optional connection id', () => {
    const result = names(filterParameters({ provider: 'anthropic', modelId: 'claude-sonnet-4-5', purpose: 'chat',
      connectionInfo: { type: 'direct', service: 'anthropic' } }))
    expect(result).not.toContain('seed')
    expect(result).toContain('temperature')
  })

  it('returns common parameters for unknown providers', () => {
    const result = filterParameters({ provider: 'custom', modelId: 'my-model', purpose: 'chat' })
    expect(names(result)).toContain('temperature')
    expect(names(result)).toContain('responseFormat')
  })

  it('includes OpenAI reasoning-only parameters for o1 models', () => {
    const result = filterParameters({ provider: 'openai', modelId: 'o1-preview', purpose: 'chat' })
    expect(names(result)).toContain('reasoningEffort')
    expect(names(result)).toContain('maxCompletionTokens')
    expect(names(result)).not.toContain('temperature')
    expect(names(result)).not.toContain('topP')
  })

  it('omits reasoning parameters for non-reasoning OpenAI models', () => {
    const result = filterParameters({ provider: 'openai', modelId: 'gpt-4.1', purpose: 'chat' })
    expect(names(result)).not.toContain('reasoningEffort')
    expect(names(result)).toContain('temperature')
  })

  it('omits unsupported sampling controls for GPT-5 reasoning models', () => {
    const result = filterParameters({ provider: 'openai', modelId: 'gpt-5.5', purpose: 'chat' })
    expect(names(result)).toContain('reasoningEffort')
    expect(names(result)).toContain('maxTokens')
    expect(names(result)).not.toContain('temperature')
    expect(names(result)).not.toContain('topP')
    expect(names(result)).not.toContain('topK')
    expect(names(result)).not.toContain('presencePenalty')
    expect(names(result)).not.toContain('frequencyPenalty')
    expect(names(result)).not.toContain('seed')
    expect(names(result)).not.toContain('stopSequences')
  })

  // BL-926: Claude models for which @ai-sdk/anthropic discards temperature, topP and topK (it says so
  // only in a warning nobody reads) must not offer them. The same ids appear as Anthropic's own, a
  // gateway's dotted form, and a vendor-prefixed form.
  const CLAUDE_MODELS_WITHOUT_SAMPLING = [
    'claude-opus-5-5',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-5',
    'claude-opus-5-5-20260901',
    'anthropic/claude-opus-5.5',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-fable-5.1'
  ]

  for (const parameter of ['temperature', 'topP', 'topK'] as const) {
    it(`omits ${parameter} for Claude models whose SDK discards it (BL-926)`, () => {
      for (const modelId of CLAUDE_MODELS_WITHOUT_SAMPLING) {
        const result = filterParameters({ provider: 'anthropic', modelId, purpose: 'chat' })
        expect(names(result), modelId).not.toContain(parameter)
        expect(names(result), modelId).toContain('maxTokens')
      }
    })
  }

  it('finds the Claude model by its catalog id when the preset model id is a custom name (BL-926)', () => {
    const result = filterParameters({
      provider: 'anthropic',
      modelId: 'my-opus',
      vercelId: 'anthropic/claude-opus-5.5',
      purpose: 'chat'
    })
    for (const parameter of ['temperature', 'topP', 'topK']) expect(names(result)).not.toContain(parameter)
  })

  it('keeps the sampling controls for Claude models that take them, and for other developers (BL-926)', () => {
    for (const modelId of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4', 'claude-opus-4-70']) {
      const result = filterParameters({ provider: 'anthropic', modelId, purpose: 'chat' })
      expect(names(result), modelId).toContain('temperature')
      expect(names(result), modelId).toContain('topP')
      expect(names(result), modelId).toContain('topK')
    }
    const other = filterParameters({ provider: 'custom', modelId: 'claude-opus-5-5', purpose: 'chat' })
    expect(names(other)).toContain('temperature')
  })

  it('gates vision-specific parameters based on capability flag', () => {
    const withVision = filterParameters({
      provider: 'openai',
      modelId: 'gpt-4o',
      capabilities: { vision: true },
      purpose: 'chat'
    })
    const withoutVision = filterParameters({
      provider: 'openai',
      modelId: 'gpt-4o',
      capabilities: { vision: false },
      purpose: 'chat'
    })

    expect(names(withVision)).toContain('imageDetail')
    expect(names(withoutVision)).not.toContain('imageDetail')
  })

  it('includes Anthropic cache controls', () => {
    const result = filterParameters({ provider: 'anthropic', modelId: 'claude-3-5-sonnet-20241022', purpose: 'chat' })
    expect(names(result)).toContain('cacheControl')
  })

  it('scopes visual parameters to visual presets', () => {
    const visual = filterParameters({ provider: 'openai', modelId: 'gpt-image-1', purpose: 'visual' })
    expect(names(visual)).toContain('n')
    expect(names(visual)).toContain('size')
    expect(names(visual)).not.toContain('temperature')
  })

  it('scopes audio parameters to audio presets', () => {
    const audio = filterParameters({ provider: 'openai', modelId: 'gpt-4o-mini-tts', purpose: 'audio' })
    expect(names(audio)).toContain('voice')
    expect(names(audio)).toContain('language')
    expect(names(audio)).not.toContain('temperature')
  })

  it('scopes utility parameters to utility presets', () => {
    const utility = filterParameters({ provider: 'cohere', modelId: 'embed-english-v3', purpose: 'utility' })
    expect(names(utility)).toContain('dimensions')
    expect(names(utility)).toContain('topN')
    expect(names(utility)).not.toContain('temperature')
  })
})


describe('SA-132 exact native controls without changing developer parameter ownership', () => {
  it.each([['xiaomi', 'mimo-v2.5', 'mimo', 'mimoThinking'], ['zai', 'glm-5.3', 'qwencloud', 'qwenReasoningEffort']])(
    'projects %s model %s through exact %s', (provider, modelId, service, name) => {
      const connectionInfo = { type: 'direct' as const, id: `direct:${service}`, service }
      expect(filterParameters({ provider, modelId, connectionInfo }).map(definition => definition.name)).toContain(name)
      for (const connection of [{ ...connectionInfo, id: 'custom:fixture' }, { ...connectionInfo, service: `${service}_token_plan`, id: `direct:${service}_token_plan` }]) {
        expect(filterParameters({ provider, modelId, connectionInfo: connection }).map(definition => definition.name)).not.toContain(name)
      }
    })
})

import { describe, expect, it } from 'vitest'
import { filterParameters } from './parameterFilter'

function names(values: ReturnType<typeof filterParameters>) {
  return values.map((value) => value.name)
}

describe('parameterFilter', () => {
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

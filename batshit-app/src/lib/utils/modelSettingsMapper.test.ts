import { describe, expect, it } from 'vitest'
import {
  OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
  buildRuntimeModelSettings
} from './modelSettingsMapper'

describe('buildRuntimeModelSettings', () => {
  it('maps standard OpenAI parameters from settings', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-4.1',
      settings: {
        temperature: 0.2,
        topP: 0.9,
        topK: 50,
        maxTokens: 2000,
        frequencyPenalty: 0.3,
        presencePenalty: 0.1,
        stopSequences: ['DONE', 'STOP'],
        responseFormat: 'json'
      }
    })

    expect(runtime.standard.temperature).toBe(0.2)
    expect(runtime.standard.topP).toBe(0.9)
    expect(runtime.standard.topK).toBe(50)
    expect(runtime.standard.maxTokens).toBe(2000)
    expect(runtime.standard.frequencyPenalty).toBe(0.3)
    expect(runtime.standard.presencePenalty).toBe(0.1)
    expect(runtime.standard.stopSequences).toEqual(['DONE', 'STOP'])
  })

  it('builds anthropic provider options for cache control and thinking', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'anthropic',
      modelId: 'claude-3-5-sonnet-20241022',
      settings: {
        cacheControl: '5m',
        thinkingMode: 'enabled',
        thinkingBudget: 4000
      }
    })

    expect(runtime.providerOptions.anthropic?.cacheControl).toEqual({
      type: 'ephemeral',
      ttl: '5m'
    })
    expect(runtime.providerOptions.anthropic?.thinking).toEqual({
      type: 'enabled',
      budgetTokens: 4000
    })
  })

  it('falls back to legacy model fields when no settings exist', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-4o',
      fallbacks: {
        temperature: 0.6,
        maxTokens: 1500,
        topP: 0.8
      }
    })

    expect(runtime.standard.temperature).toBe(0.6)
    expect(runtime.standard.maxTokens).toBe(1500)
    expect(runtime.standard.topP).toBe(0.8)
  })

  it('drops stale sampling settings for OpenAI reasoning models', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-5.5',
      settings: {
        temperature: 0.7,
        topP: 0.9,
        topK: 50,
        maxTokens: 128000,
        reasoningEffort: 'high'
      },
      fallbacks: {
        temperature: 0.6,
        topP: 0.8
      }
    })

    expect(runtime.standard.temperature).toBeUndefined()
    expect(runtime.standard.topP).toBeUndefined()
    expect(runtime.standard.topK).toBeUndefined()
    expect(runtime.standard.maxTokens).toBe(128000)
    expect(runtime.providerOptions.openai?.reasoningEffort).toBe('high')
  })

  it('clamps stale OpenRouter context-window values used as max output tokens', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      connection: {
        id: 'openrouter',
        type: 'openrouter',
        service: 'openrouter'
      },
      contextWindow: 262000,
      settings: {
        maxTokens: 262000
      }
    })

    expect(runtime.standard.maxTokens).toBe(OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS)
  })

  it('clamps context-sized max output tokens for every provider', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-5.5',
      contextWindow: 400000,
      settings: {
        maxTokens: 400000
      }
    })

    expect(runtime.standard.maxTokens).toBe(OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS)
  })

  it('keeps explicit OpenRouter output limits below the context window', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
      connection: {
        id: 'openrouter',
        type: 'openrouter',
        service: 'openrouter'
      },
      contextWindow: 262000,
      settings: {
        maxTokens: 40000
      }
    })

    expect(runtime.standard.maxTokens).toBe(40000)
  })
})

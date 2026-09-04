import { describe, expect, it } from 'vitest'
import { normaliseModelSettings } from '$lib/server/services/modelManagerHelpers'
import { filterParameters, resolveParameterProvider } from './parameterFilter'
import {
  MIMO_V25_XIAOMI_MAX_OUTPUT_TOKENS,
  OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
  buildRuntimeModelSettings,
  resolveProviderOptionsSegment
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

  it('clamps the rounded MiMo V2.5 catalog limit to Xiaomi\'s accepted boundary', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'xiaomi',
      modelId: 'xiaomi/mimo-v2.5',
      connection: {
        id: 'vercel-gateway',
        type: 'vercel-gateway',
        service: 'vercel-gateway'
      },
      contextWindow: 1_050_000,
      settings: {
        maxTokens: 131_100
      }
    })

    expect(runtime.standard.maxTokens).toBe(MIMO_V25_XIAOMI_MAX_OUTPUT_TOKENS)
  })
})

// ---------------------------------------------------------------------------
// SA-102 P1 (DL-102-01): blank means "do not send".
// ---------------------------------------------------------------------------
describe('SA-102 blank-means-unset', () => {
  it('omits every standard sampler when the preset is empty', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'lmstudio',
      modelId: 'qwen/qwen3.8-27b',
      connection: { id: 'direct:lmstudio', type: 'direct', service: 'lmstudio' } as any,
      settings: {}
    })

    expect(runtime.standard.temperature).toBeUndefined()
    expect(runtime.standard.maxTokens).toBeUndefined()
    expect(runtime.standard.topP).toBeUndefined()
    expect(runtime.standard.topK).toBeUndefined()
    expect(runtime.standard.presencePenalty).toBeUndefined()
    expect(runtime.standard.frequencyPenalty).toBeUndefined()
    expect(runtime.standard.seed).toBeUndefined()
    expect(runtime.standard.stopSequences).toBeUndefined()
    expect(Object.keys(runtime.standard)).toEqual(['maxTokens'])
  })

  it('omits samplers when settings is null', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'ollama',
      modelId: 'llama3.2:latest',
      settings: null
    })
    expect(runtime.standard.temperature).toBeUndefined()
    expect(runtime.standard.maxTokens).toBeUndefined()
  })

  it('treats 0 as a real value, not as blank', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'lmstudio',
      modelId: 'qwen/qwen3.8-27b',
      settings: {
        temperature: 0,
        topP: 0,
        presencePenalty: 0,
        frequencyPenalty: 0,
        seed: 0
      }
    })

    expect(runtime.standard.temperature).toBe(0)
    expect(runtime.standard.topP).toBe(0)
    expect(runtime.standard.presencePenalty).toBe(0)
    expect(runtime.standard.frequencyPenalty).toBe(0)
    expect(runtime.standard.seed).toBe(0)
  })

  it('passes set values through unchanged', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'lmstudio',
      modelId: 'qwen/qwen3.8-27b',
      settings: { temperature: 0.6, maxTokens: 4096, topP: 0.95 }
    })
    expect(runtime.standard.temperature).toBe(0.6)
    expect(runtime.standard.maxTokens).toBe(4096)
    expect(runtime.standard.topP).toBe(0.95)
  })

  it('still applies agent-level fallbacks where the preset left a gap', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'lmstudio',
      modelId: 'qwen/qwen3.8-27b',
      settings: { temperature: 0.6 },
      fallbacks: { temperature: 0.2, maxTokens: 8000 }
    })
    expect(runtime.standard.temperature).toBe(0.6)
    expect(runtime.standard.maxTokens).toBe(8000)
  })

  it('clamps a fallback maxTokens to the context window (the ?? 16384 escape hatch is gone)', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'ollama',
      modelId: 'llama3.2:latest',
      contextWindow: 4096,
      settings: {},
      fallbacks: { maxTokens: 16384 }
    })
    expect(runtime.standard.maxTokens).toBeLessThanOrEqual(4096)
  })
})

// ---------------------------------------------------------------------------
// SA-102 P1 (DL-102-05): cloud request bodies must be unchanged except where a
// preset genuinely left a value blank.
//
// `send-routed` used to build each sampler as
//   settings.standard.X ?? overrides.X ?? <literal default>
// where `overrides` carried the SAME agent-level primary_model_* values already
// handed to buildRuntimeModelSettings as `fallbacks`. These pin the two ways
// that second chain could differ from the merge that replaced it, using the
// real shapes of the presets on Josh's machine at P0.
// ---------------------------------------------------------------------------
describe('SA-102 cloud parity', () => {
  const CLOUD_PRESETS = [
    // gpt-5.5 is deliberately NOT here: it is a reasoning model, so the mapper
    // suppresses its samplers by design. That case is pinned separately below.
    { provider: 'openai', modelId: 'gpt-4.1', settings: { temperature: 0.7, maxTokens: 128000 } },
    {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      settings: { temperature: 0.7, maxTokens: 128000 }
    },
    {
      provider: 'google',
      modelId: 'gemini-3.5-flash',
      settings: { temperature: 0.7, maxTokens: 64000 }
    },
    { provider: 'vercel', modelId: 'kimi-k2.7-code', settings: { temperature: 0.7, maxTokens: 32768 } }
  ]

  it('leaves a populated cloud preset byte-identical to the old fallback chain', () => {
    for (const preset of CLOUD_PRESETS) {
      const runtime = buildRuntimeModelSettings({
        provider: preset.provider,
        modelId: preset.modelId,
        contextWindow: 200_000,
        settings: preset.settings,
        // the agent-level values the removed `overrides` object used to carry
        fallbacks: { temperature: 0.3, maxTokens: 1234 }
      })

      // old: settings.standard.temperature ?? overrides.temperature ?? 0.7
      const legacyTemperature = runtime.standard.temperature ?? 0.3 ?? 0.7
      const legacyMaxTokens = runtime.standard.maxTokens ?? 1234 ?? 16384

      expect(runtime.standard.temperature).toBe(legacyTemperature)
      expect(runtime.standard.maxTokens).toBe(legacyMaxTokens)
      expect(runtime.standard.temperature).toBe(preset.settings.temperature)
      expect(runtime.standard.maxTokens).toBe(preset.settings.maxTokens)
    }
  })

  it('still applies an agent-level value when the cloud preset left the field blank', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      contextWindow: 200_000,
      settings: {},
      fallbacks: { temperature: 0.3, maxTokens: 1234 }
    })
    expect(runtime.standard.temperature).toBe(0.3)
    expect(runtime.standard.maxTokens).toBe(1234)
  })

  it('no longer smuggles a suppressed sampler back onto an OpenAI reasoning model', () => {
    // buildRuntimeModelSettings drops these for gpt-5-class models on purpose,
    // whether the value came from the preset or from the agent. The old
    // `?? overrides.temperature` re-added the very value it had just dropped.
    // On an OpenAI-DIRECT lane vercelBrain.buildGenerationSettings caught it a
    // second time; on a Gateway or OpenRouter lane serving the same model id
    // nothing did, and the sampler reached the wire.
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-5.5',
      contextWindow: 400_000,
      settings: {},
      fallbacks: { temperature: 0.3, topP: 0.9, presencePenalty: 0.2, frequencyPenalty: 0.2 }
    })
    expect(runtime.standard.temperature).toBeUndefined()
    expect(runtime.standard.topP).toBeUndefined()
    expect(runtime.standard.presencePenalty).toBeUndefined()
    expect(runtime.standard.frequencyPenalty).toBeUndefined()
  })

  it('suppresses a reasoning model sampler even when the preset set it explicitly', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'openai',
      modelId: 'gpt-5.5',
      contextWindow: 400_000,
      settings: { temperature: 0.7, maxTokens: 128000 }
    })
    expect(runtime.standard.temperature).toBeUndefined()
    expect(runtime.standard.maxTokens).toBe(128000)
  })
})

// ---------------------------------------------------------------------------
// SA-102 P2 (DL-102-02): the providerOptions segment local samplers travel under.
// ---------------------------------------------------------------------------
describe('SA-102 local providerOptions segment', () => {
  it.each(['vllm', 'sglang'])(
    'offers, normalizes and maps local settings for a Qwen model on %s',
    (service) => {
      const connection = { type: 'direct' as const, service }
      const provider = 'Qwen'
      const modelId = 'Qwen3-VL-4B-Instruct'
      const definitions = filterParameters({
        provider: resolveParameterProvider(provider, connection), modelId,
      })
      expect(definitions.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'topK', 'minP', 'repetitionPenalty', 'chatTemplateKwargs',
      ]))

      const settings = normaliseModelSettings({
        provider, connection, modelId,
        settings: {
          temperature: '0', maxTokens: '512', topK: '20', minP: '0.05',
          repetitionPenalty: '1.1', chatTemplateKwargs: '{"enable_thinking":false}',
          custom_switch: false,
        },
      })
      expect(settings).toEqual({
        temperature: 0, maxTokens: 512, topK: 20, minP: 0.05,
        repetitionPenalty: 1.1, chatTemplateKwargs: { enable_thinking: false },
        custom_switch: false,
      })
      const runtime = buildRuntimeModelSettings({ provider, connection, modelId, settings })
      expect(runtime.standard.temperature).toBe(0)
      expect(runtime.standard.maxTokens).toBe(512)
      expect(runtime.standard.topK).toBeUndefined()
      expect(runtime.providerOptions).toEqual({
        [service]: {
          top_k: 20, min_p: 0.05, repetition_penalty: 1.1,
          chat_template_kwargs: { enable_thinking: false }, custom_switch: false,
        },
      })
    },
  )

  it('keeps cloud developer parameters and namespace when a gateway connection is supplied', () => {
    const args = {
      provider: 'anthropic', modelId: 'claude-3-5-sonnet-20241022',
      settings: { thinkingMode: 'enabled', thinkingBudget: 4000, custom_switch: false },
    }
    const connection = { type: 'vercel-gateway' as const, service: 'vercel-gateway' }
    expect(normaliseModelSettings({ ...args, connection })).toEqual(normaliseModelSettings(args))
    expect(buildRuntimeModelSettings({ ...args, connection })).toEqual(buildRuntimeModelSettings(args))
  })

  it('camel-cases a hyphenated local runtime id', () => {
    expect(resolveProviderOptionsSegment('llama-cpp')).toBe('llamaCpp')
  })

  it('leaves single-word local runtime ids alone', () => {
    for (const id of ['ollama', 'dmr', 'lmstudio', 'vllm']) {
      expect(resolveProviderOptionsSegment(id)).toBe(id)
    }
  })

  it('never rewrites a cloud provider id', () => {
    for (const id of ['openai', 'anthropic', 'google', 'zai_coding', 'openai-codex']) {
      expect(resolveProviderOptionsSegment(id)).toBe(id)
    }
  })

  it('routes a plain Custom Parameter to the camel-cased local segment', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'llama-cpp',
      modelId: 'some-local-gguf',
      settings: { min_p: 0.05, repeat_penalty: 1.1 }
    })
    expect(runtime.providerOptions.llamaCpp).toEqual({ min_p: 0.05, repeat_penalty: 1.1 })
    expect(runtime.providerOptions['llama-cpp']).toBeUndefined()
  })

  it('routes a plain Custom Parameter straight through for a single-word runtime', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'lmstudio',
      modelId: 'qwen/qwen3.8-27b',
      settings: { min_p: 0.05, top_k: 20 }
    })
    expect(runtime.providerOptions.lmstudio).toEqual({ min_p: 0.05, top_k: 20 })
  })
})

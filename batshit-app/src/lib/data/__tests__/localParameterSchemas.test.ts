import { describe, expect, it } from 'vitest'
import { PARAMETER_SCHEMAS, getParameterSchema } from '../parameter-schemas'
import { LOCAL_AI_SERVER_DEFINITIONS } from '../localAiServers'
import { filterParameters } from '$lib/utils/parameterFilter'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'

/**
 * SA-102 P3 (DL-102-03): every local program gets its own parameter list, a
 * parameter it is offered must reach the wire, and a parameter it would ignore
 * must not be offered. The "ignored" assertions below are measurements, not
 * guesses — see the evidence block above LOCAL_SAMPLER_LIBRARY.
 */
describe('SA-102 per-runtime local parameter schemas', () => {
  it('gives every local runtime its own schema instead of the default fallthrough', () => {
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      const schema = getParameterSchema(definition.id)
      expect(schema.provider, `${definition.id} schema`).toBe(definition.id)
    }
  })

  it('replaces the SDK-dropped generic Top K with a provider-option Top K', () => {
    const definitions = filterParameters({ provider: 'lmstudio', modelId: 'qwen/qwen3.8-27b' })
    const topK = definitions.find((d) => d.name === 'topK')
    expect(topK).toBeDefined()
    // The generic one carries standardKey, which both AI SDK providers drop.
    expect(topK?.standardKey).toBeUndefined()
    expect(topK?.providerOptionKey).toBe('lmstudio.top_k')
  })

  it('routes llama.cpp through the camel-cased provider-options segment', () => {
    const definitions = filterParameters({ provider: 'llama-cpp', modelId: 'some-gguf' })
    const minP = definitions.find((d) => d.name === 'minP')
    expect(minP?.providerOptionKey).toBe('llamaCpp.min_p')
  })

  it('puts a local sampler on the wire through the mapper', () => {
    const runtime = buildRuntimeModelSettings({
      provider: 'lmstudio',
      modelId: 'qwen/qwen3.8-27b',
      settings: { topK: 20, minP: 0.05, repeatPenalty: 1.1, temperature: 0.6 }
    })
    expect(runtime.standard.temperature).toBe(0.6)
    expect(runtime.standard.topK).toBeUndefined()
    expect(runtime.providerOptions.lmstudio).toEqual({
      top_k: 20,
      min_p: 0.05,
      repeat_penalty: 1.1
    })
  })

  it('offers Ollama only its documented /v1 set (DL-102-15)', () => {
    const definitions = filterParameters({ provider: 'ollama', modelId: 'llama3.2:latest' })
    const names = new Set(definitions.map((d) => d.name))
    for (const ignored of ['minP', 'repeatPenalty', 'typicalP', 'mirostat', 'localTtl']) {
      expect(names.has(ignored), `ollama should not offer ${ignored}`).toBe(false)
    }
    // Ollama's /v1 ignores top_k, so it keeps no provider-option Top K.
    const topK = definitions.find((d) => d.name === 'topK')
    expect(topK?.providerOptionKey).toBeUndefined()
    // Ollama FAILS the whole send if this is set on a model that cannot think,
    // so it is gated on the preset's Reasoning capability rather than offered
    // to every model.
    expect(names.has('localReasoningEffort')).toBe(false)
    const thinking = filterParameters({
      provider: 'ollama',
      modelId: 'qwen3:latest',
      capabilities: { reasoning: true } as any
    })
    const effort = thinking.find((d) => d.name === 'localReasoningEffort')
    expect(effort).toBeDefined()
    expect(effort?.options?.map((o) => o.value)).toContain('none')
  })

  it('does not offer LM Studio the samplers it was measured to ignore', () => {
    const names = new Set(
      filterParameters({ provider: 'lmstudio', modelId: 'qwen/qwen3.8-27b' }).map((d) => d.name)
    )
    for (const ignored of ['typicalP', 'mirostat', 'repetitionPenalty']) {
      expect(names.has(ignored), `lmstudio should not offer ${ignored}`).toBe(false)
    }
    for (const honoured of ['topK', 'minP', 'repeatPenalty', 'localTtl', 'localReasoningEffort']) {
      expect(names.has(honoured), `lmstudio should offer ${honoured}`).toBe(true)
    }
  })

  it('offers the llama.cpp family its full measured set', () => {
    for (const runtimeId of ['llama-cpp', 'dmr']) {
      const names = new Set(
        filterParameters({ provider: runtimeId, modelId: 'some-model' }).map((d) => d.name)
      )
      for (const honoured of [
        'topK',
        'minP',
        'typicalP',
        'repeatPenalty',
        'repeatLastN',
        'mirostat',
        'xtcProbability'
      ]) {
        expect(names.has(honoured), `${runtimeId} should offer ${honoured}`).toBe(true)
      }
    }
  })

  it('uses the repetition_penalty spelling for vLLM and repeat_penalty for llama.cpp', () => {
    const vllm = filterParameters({ provider: 'vllm', modelId: 'm' })
    expect(vllm.find((d) => d.name === 'repetitionPenalty')?.providerOptionKey).toBe(
      'vllm.repetition_penalty'
    )
    expect(vllm.find((d) => d.name === 'repeatPenalty')).toBeUndefined()

    const llama = filterParameters({ provider: 'llama-cpp', modelId: 'm' })
    expect(llama.find((d) => d.name === 'repeatPenalty')?.providerOptionKey).toBe(
      'llamaCpp.repeat_penalty'
    )
    expect(llama.find((d) => d.name === 'repetitionPenalty')).toBeUndefined()
  })

  it('routes thinking effort through the SDK-owned option key, not the wire name', () => {
    // Measured on @ai-sdk/openai-compatible 3.0.43: the provider assigns
    // `reasoning_effort` from its OWN `reasoningEffort` option AFTER spreading
    // providerOptions into the body, so a snake_case passthrough is erased.
    //   providerOptions.lmstudio.reasoning_effort -> body has NEITHER key
    //   providerOptions.lmstudio.reasoningEffort  -> body has reasoning_effort
    for (const runtimeId of ['lmstudio', 'ollama']) {
      const effort = filterParameters({
        provider: runtimeId,
        modelId: 'm',
        // Ollama gates this on the Reasoning capability; LM Studio does not.
        capabilities: { reasoning: true } as any
      }).find((d) => d.name === 'localReasoningEffort')
      expect(effort?.providerOptionKey, runtimeId).toMatch(/\.reasoningEffort$/)
      expect(effort?.providerOptionKey, runtimeId).not.toMatch(/reasoning_effort/)
    }
  })

  it('never routes a local sampler under a key the SDK owns in snake_case', () => {
    const OWNED_SNAKE = ['user', 'reasoning_effort', 'text_verbosity', 'strict_json_schema']
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      for (const parameter of filterParameters({ provider: definition.id, modelId: 'm' })) {
        const key = parameter.providerOptionKey
        if (!key) continue
        const segment = key.split('.').slice(1).join('.')
        expect(
          OWNED_SNAKE.includes(segment),
          `${definition.id}.${parameter.name} routes under owned key "${segment}"`
        ).toBe(false)
      }
    }
  })

  it('offers only the thinking-effort values LM Studio actually accepts', () => {
    // Measured: the endpoint rejects `off` and `on`, which ARE in the model's
    // own capabilities.reasoning.allowed_options. The API's list is the truth.
    const effort = filterParameters({ provider: 'lmstudio', modelId: 'qwen/qwen3.8-27b' }).find(
      (d) => d.name === 'localReasoningEffort'
    )
    expect(effort?.options?.map((o) => o.value)).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(effort?.providerOptionKey).toBe('lmstudio.reasoningEffort')
  })

  it('keeps every local sampler out of the cloud schemas', () => {
    const cloudProviders = ['openai', 'anthropic', 'google', 'mistral', 'groq', 'default']
    for (const provider of cloudProviders) {
      const names = new Set(getParameterSchema(provider).base.map((d) => d.name))
      for (const localOnly of ['minP', 'repeatPenalty', 'mirostat', 'localTtl']) {
        expect(names.has(localOnly), `${provider} must not offer ${localOnly}`).toBe(false)
      }
      // and the cloud Top K stays the standard one
      const topK = getParameterSchema(provider).base.find((d) => d.name === 'topK')
      expect(topK?.standardKey, `${provider} topK`).toBe('topK')
    }
  })

  it('has no duplicate provider entries in PARAMETER_SCHEMAS', () => {
    const seen = new Set<string>()
    for (const schema of PARAMETER_SCHEMAS) {
      expect(seen.has(schema.provider), `duplicate schema for ${schema.provider}`).toBe(false)
      seen.add(schema.provider)
    }
  })
})

/**
 * SA-102 P5 (DL-102-07): the two programs added last. Each is proven against a
 * real running server before it ships — see the story's evidence log for what
 * was and was not measured.
 */
describe('SA-102 the two new local programs', () => {
  it('registers SGLang and oMLX, both disabled by default and connect-only', () => {
    for (const id of ['sglang', 'omlx']) {
      const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === id)
      expect(definition, id).toBeDefined()
      expect(definition?.enabledByDefault, `${id} must not enable itself`).toBe(false)
      expect(definition?.supports.management, `${id} is connect-only`).toBe(false)
      expect(definition?.supports.promptCacheReporting, `${id} reports cache`).toBe('reports')
    }
  })

  it('does not move any existing program default base URL', () => {
    const expected: Record<string, string> = {
      ollama: 'http://localhost:11434',
      dmr: 'http://localhost:12434',
      lmstudio: 'http://localhost:1234',
      'llama-cpp': 'http://localhost:8080',
      vllm: 'http://localhost:8000',
      sglang: 'http://localhost:30000',
      omlx: 'http://localhost:8000'
    }
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      expect(definition.defaultBaseUrl, definition.id).toBe(expected[definition.id])
    }
  })

  it('keeps the oMLX / vLLM port collision that DL-102-10 warns about', () => {
    // Deliberate: oMLX genuinely defaults to 8000, and so does vLLM. Batshit
    // warns and points at changing a port rather than inventing a different
    // default that would not match the program's own documentation.
    const omlx = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === 'omlx')
    const vllm = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === 'vllm')
    expect(omlx?.defaultBaseUrl).toBe(vllm?.defaultBaseUrl)
  })

  it('gives each new program its measured sampler set', () => {
    const sglang = new Set(
      filterParameters({ provider: 'sglang', modelId: 'm' }).map((d) => d.name)
    )
    expect(sglang.has('minP')).toBe(true)
    expect(sglang.has('repetitionPenalty')).toBe(true)
    expect(sglang.has('repeatPenalty')).toBe(false)

    const omlx = new Set(filterParameters({ provider: 'omlx', modelId: 'm' }).map((d) => d.name))
    expect(omlx.has('minP')).toBe(true)
    expect(omlx.has('repetitionPenalty')).toBe(true)
    expect(omlx.has('repetitionContextSize')).toBe(true)
    expect(omlx.has('repeatPenalty')).toBe(false)
  })
})

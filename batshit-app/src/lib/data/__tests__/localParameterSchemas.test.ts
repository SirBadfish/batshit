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

  it('offers Ollama its measured NATIVE set (SA-125 supersedes DL-102-15)', () => {
    // Ollama no longer goes through the OpenAI door. Measured 2026-09-20 with a
    // pinned seed: top_k and min_p were byte-identical to baseline on /v1 and
    // genuinely changed the output on /api/chat.
    const definitions = filterParameters({ provider: 'ollama', modelId: 'llama3.2:latest' })
    const names = new Set(definitions.map((d) => d.name))
    for (const honoured of ['topK', 'minP', 'repeatPenalty', 'repeatLastN', 'ollamaNumCtx']) {
      expect(names.has(honoured), `ollama should offer ${honoured}`).toBe(true)
    }
    // Everything Ollama generates with lives inside `options`.
    expect(definitions.find((d) => d.name === 'topK')?.providerOptionKey).toBe('ollama.options.top_k')
    expect(definitions.find((d) => d.name === 'minP')?.providerOptionKey).toBe('ollama.options.min_p')
    expect(definitions.find((d) => d.name === 'ollamaNumCtx')?.providerOptionKey).toBe(
      'ollama.options.num_ctx'
    )

    // Measured as ignored, so still not offered. `typicalP` is worse than
    // ignored: Ollama answers "typical_p is no longer supported" and the whole
    // send fails, which is why the shim strips it as well.
    for (const ignored of ['typicalP', 'mirostat', 'mirostatTau', 'localTtl']) {
      expect(names.has(ignored), `ollama should not offer ${ignored}`).toBe(false)
    }
  })

  it('gates Ollama thinking on the Reasoning capability, as a boolean', () => {
    // Measured 2026-09-20: `think: true` FAILS the send on a model that cannot
    // think ("llama3.2:latest" does not support thinking). `think: false` is
    // safe on any model. Same hazard the /v1 reasoning_effort field had.
    const plain = filterParameters({ provider: 'ollama', modelId: 'llama3.2:latest' })
    expect(plain.some((d) => d.name === 'ollamaThink')).toBe(false)

    const thinking = filterParameters({
      provider: 'ollama',
      modelId: 'qwen3:latest',
      capabilities: { reasoning: true } as any
    })
    const think = thinking.find((d) => d.name === 'ollamaThink')
    expect(think).toBeDefined()
    expect(think?.inputType).toBe('boolean')
    // `think` is a sibling of `messages`, not one of the generation options.
    expect(think?.providerOptionKey).toBe('ollama.think')
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
    // SA-125: Ollama left this lane entirely; its thinking control is now the
    // native boolean `think`. LM Studio still routes through the owned key.
    for (const runtimeId of ['lmstudio']) {
      const effort = filterParameters({
        provider: runtimeId,
        modelId: 'm',
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
      omlx: 'http://localhost:8000',
      // SA-124: KoboldCpp's own `defaultport = 5001`. No collision with the
      // seven above, and none with any Batshit runtime lane.
      koboldcpp: 'http://localhost:5001'
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

/**
 * SA-124 P0: KoboldCpp. Every assertion here is a measurement taken against
 * KoboldCpp 1.121 (mac-arm64) on 2026-09-20 with a pinned seed, not a reading of
 * its documentation. KoboldCpp accepts unknown JSON keys silently, so an
 * un-measured field is indistinguishable from a broken one at runtime — these
 * tests exist so a future edit cannot quietly re-add one.
 */
describe('SA-124 KoboldCpp parameter schema', () => {
  const koboldNames = () =>
    new Set(filterParameters({ provider: 'koboldcpp', modelId: 'm' }).map((d) => d.name))

  it('offers only the samplers that were measured to change output', () => {
    const names = koboldNames()
    for (const proven of [
      'topK',
      'minP',
      'typicalP',
      'dryMultiplier',
      'dryBase',
      'dryAllowedLength',
      'xtcProbability',
      'xtcThreshold'
    ]) {
      expect(names.has(proven), `${proven} was measured to work`).toBe(true)
    }
  })

  it('does not offer Mirostat, which is a no-op on this build', () => {
    // Measured: `mirostat_mode: 2`, `mirostat_mode: 1`, and `top_k: 0, top_p: 1`
    // all produced the SAME output hash. Enabling Mirostat only switches off Top
    // K and Top P; tau (0.1 vs 20) and eta (0.01 vs 1) moved nothing at all.
    const names = koboldNames()
    expect(names.has('mirostat')).toBe(false)
    expect(names.has('mirostatTau')).toBe(false)
    expect(names.has('mirostatEta')).toBe(false)
  })

  it('offers Presence Penalty but NOT Frequency Penalty (they share one slot)', () => {
    // koboldcpp.py: presence_penalty = genparams.get('presence_penalty',
    // genparams.get('frequency_penalty', 0.0)). Two boxes, one value. DL-124-03.
    const names = koboldNames()
    expect(names.has('presencePenalty')).toBe(true)
    expect(names.has('frequencyPenalty')).toBe(false)
  })

  it('scopes that omission to KoboldCpp alone', () => {
    for (const other of ['ollama', 'lmstudio', 'llama-cpp', 'vllm', 'sglang', 'omlx', 'dmr']) {
      const names = new Set(
        filterParameters({ provider: other, modelId: 'm' }).map((d) => d.name)
      )
      expect(names.has('frequencyPenalty'), `${other} keeps Frequency Penalty`).toBe(true)
    }
  })

  it('routes KoboldCpp samplers under its own provider-options segment', () => {
    const definitions = filterParameters({ provider: 'koboldcpp', modelId: 'm' })
    const byName = new Map(definitions.map((d) => [d.name, d]))
    expect(byName.get('topK')?.providerOptionKey).toBe('koboldcpp.top_k')
    expect(byName.get('minP')?.providerOptionKey).toBe('koboldcpp.min_p')
    // KoboldCpp spells Typical `typical`, not `typical_p`.
    expect(byName.get('typicalP')?.providerOptionKey).toBe('koboldcpp.typical')
  })
})

/**
 * Josh, 2026-09-21, looking at a saved KoboldCpp preset: "a lot of them look
 * like they're in the common accordion section... it just seems like common
 * isn't quite the right word for these because they're not common."
 *
 * "Common" is described in the UI as the controls most people look for first.
 * DRY, XTC, Typical P and Mirostat are not that for anyone.
 */
describe('local specialist samplers do not sit in Common', () => {
  const SPECIALIST = [
    'typicalP',
    'dryMultiplier',
    'dryBase',
    'dryAllowedLength',
    'xtcProbability',
    'xtcThreshold',
    'mirostat',
    'mirostatTau',
    'mirostatEta',
    'repeatLastN',
    'repetitionContextSize'
  ]

  it('files them under the program section instead', () => {
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      for (const parameter of filterParameters({ provider: definition.id, modelId: 'm' })) {
        if (!SPECIALIST.includes(parameter.name)) continue
        expect(
          parameter.section,
          `${definition.id} → ${parameter.label} should not be in Common`
        ).toBe('provider')
      }
    }
  })

  it('keeps the genuinely common ones in Common', () => {
    // The opposite failure would be just as bad: an empty Common section with
    // everything buried one accordion deeper.
    const kobold = filterParameters({ provider: 'koboldcpp', modelId: 'm' })
    for (const common of ['temperature', 'maxTokens', 'topP', 'topK', 'minP', 'seed']) {
      expect(
        kobold.find((d) => d.name === common)?.section,
        `${common} belongs in Common`
      ).toBe('core')
    }
  })

  it('gives the program section a name the user recognises', () => {
    // The title comes from the first segment of providerOptionKey, so this is
    // what makes the accordion read "KoboldCpp Options" rather than "Provider".
    const kobold = filterParameters({ provider: 'koboldcpp', modelId: 'm' })
    const specialist = kobold.filter((d) => d.section === 'provider')
    expect(specialist.length).toBeGreaterThan(0)
    for (const parameter of specialist) {
      expect(parameter.providerOptionKey?.split('.')[0]).toBe('koboldcpp')
    }
  })
})

/**
 * SA-124 P1: KoboldCpp's roleplay sampler set. All measured 2026-09-21 against
 * KoboldCpp 1.121 with a pinned seed and two control rows.
 */
describe('SA-124 P1 KoboldCpp roleplay samplers', () => {
  const kobold = () => filterParameters({ provider: 'koboldcpp', modelId: 'm' })
  const key = (name: string) => kobold().find((d) => d.name === name)?.providerOptionKey

  it('offers all twenty measured fields under their KoboldCpp wire names', () => {
    const expected: Record<string, string> = {
      repPen: 'rep_pen',
      repPenRange: 'rep_pen_range',
      repPenSlope: 'rep_pen_slope',
      topA: 'top_a',
      tfs: 'tfs',
      nsigma: 'nsigma',
      dryPenaltyLastN: 'dry_penalty_last_n',
      drySequenceBreakers: 'dry_sequence_breakers',
      dynatempRange: 'dynatemp_range',
      dynatempExponent: 'dynatemp_exponent',
      smoothingFactor: 'smoothing_factor',
      smoothingCurve: 'smoothing_curve',
      adaptiveTarget: 'adaptive_target',
      samplerOrder: 'sampler_order',
      bannedTokens: 'banned_tokens',
      customTokenBans: 'custom_token_bans',
      logitBias: 'logit_bias',
      banEosToken: 'ban_eos_token',
      guidanceScale: 'guidance_scale',
      negativePrompt: 'negative_prompt'
    }
    for (const [name, wire] of Object.entries(expected)) {
      expect(key(name), name).toBe(`koboldcpp.${wire}`)
    }
  })

  it('does not offer the four that measured as dead or unprovable', () => {
    // adaptive_decay moved nothing at 0.99 vs 0.01 over 160 tokens.
    // max_context_length: the server kept 32768 after requests asked for 4096
    //   and 8192; the launch flag wins.
    // thinking budget / reasoning effort: unprovable on a model that cannot
    //   think, so not offered until measured on one that can.
    const names = new Set(kobold().map((d) => d.name))
    for (const absent of ['adaptiveDecay', 'maxContextLength', 'thinkingBudgetTokens', 'koboldReasoningEffort']) {
      expect(names.has(absent), absent).toBe(false)
    }
  })

  it('sends the ban lists as real arrays, never one long string', () => {
    // DL-124-06. KoboldCpp's own coerce_ban_list() exists because a bare string
    // used to be iterated letter by letter, banning single characters.
    for (const name of ['bannedTokens', 'drySequenceBreakers']) {
      expect(kobold().find((d) => d.name === name)?.inputType, name).toBe('string-array')
    }
  })

  it('has no default sampler order, so it is not sent unless customised', () => {
    // DL-102-01: blank means "do not send". A default here would send
    // KoboldCpp its own default back on every request.
    expect(kobold().find((d) => d.name === 'samplerOrder')?.defaultValue).toBeUndefined()
  })

  it('lands the whole set under KoboldCpp Options, not Common', () => {
    const provider = kobold().filter((d) => d.section === 'provider')
    expect(provider.length).toBe(26)
    expect(kobold().filter((d) => d.section === 'core').length).toBe(9)
  })
})

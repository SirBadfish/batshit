import { describe, expect, it } from 'vitest'
import { normalizeUsageLike, withHonestLocalCacheUsage } from '../apiProviderUsage'
import { resolveLocalPromptCacheReporting } from '$lib/data/localAiServers'
import {
  resolveEffectiveContextLimit,
  localRuntimeReportsLoadedContext
} from '../localRuntimeContext'

/**
 * SA-102 P4 (DL-102-13): a local cache readout is runtime-reported or honestly
 * absent — never inferred, and never a confident zero the program did not send.
 */
describe('SA-102 honest local cache reporting', () => {
  it('knows which programs report cached prompt tokens', () => {
    expect(resolveLocalPromptCacheReporting('llama-cpp')).toBe('reports')
    expect(resolveLocalPromptCacheReporting('dmr')).toBe('reports')
    expect(resolveLocalPromptCacheReporting('ollama')).toBe('never-reports')
    expect(resolveLocalPromptCacheReporting('vllm')).toBe('reports')
    expect(resolveLocalPromptCacheReporting('lmstudio')).toBe('never-reports')
    // cloud lanes are none of its business
    expect(resolveLocalPromptCacheReporting('openai')).toBeNull()
    expect(resolveLocalPromptCacheReporting(null)).toBeNull()
  })

  it('strips the SDK-invented zero for a program that never reports', () => {
    // @ai-sdk/openai-compatible maps an ABSENT cached_tokens to 0.
    const usage = { inputTokens: 11313, outputTokens: 5, cachedInputTokens: 0 }
    const honest = withHonestLocalCacheUsage(usage, 'never-reports')
    expect(honest?.cachedInputTokens).toBeUndefined()
    expect(honest?.inputTokens).toBe(11313)
    expect(honest?.outputTokens).toBe(5)
  })

  it('keeps a real zero from a program that does report', () => {
    const usage = {
      inputTokens: 3020, outputTokens: 5, cachedInputTokens: 0,
      raw: { prompt_tokens_details: { cached_tokens: 0 } },
    }
    expect(withHonestLocalCacheUsage(usage, 'reports')?.cachedInputTokens).toBe(0)
  })

  it('keeps a real hit from a program that does report', () => {
    const usage = {
      inputTokens: 3020, outputTokens: 5, cachedInputTokens: 3019,
      raw: { prompt_tokens_details: { cached_tokens: 3019 } },
    }
    expect(withHonestLocalCacheUsage(usage, 'reports')?.cachedInputTokens).toBe(3019)
  })

  it('leaves cloud usage completely alone', () => {
    const usage = { inputTokens: 100, outputTokens: 2, cachedInputTokens: 64 }
    expect(withHonestLocalCacheUsage(usage, null)).toBe(usage)
    expect(withHonestLocalCacheUsage(usage, undefined)).toBe(usage)
  })

  it.each(['sglang', 'vllm', 'lmstudio', 'ollama'])(
    '%s trusts raw counts rather than its static reporting capability', (program) => {
      const capability = resolveLocalPromptCacheReporting(program)
      const sdk = { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0 }
      for (const raw of [undefined, {}, { prompt_tokens_details: null },
        { prompt_tokens_details: { cached_tokens: null } }]) {
        const honest = withHonestLocalCacheUsage(sdk, capability, [raw])
        expect(honest?.cachedInputTokens).toBeUndefined()
        expect(honest?.inputTokenDetails?.cacheReadTokens).toBeUndefined()
        expect(honest?.inputTokens).toBe(100)
      }
      for (const cached of [0, 64]) {
        const honest = withHonestLocalCacheUsage(sdk, capability, [
          { prompt_tokens_details: { cached_tokens: cached } },
        ])
        expect(honest?.cachedInputTokens).toBe(cached)
        expect(honest?.inputTokenDetails?.cacheReadTokens).toBe(cached)
      }
    },
  )

  it('sums each call once and requires every call to report the aggregate field', () => {
    const sdk = { inputTokens: 200, outputTokens: 10, cachedInputTokens: 64 }
    const raw = [
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } },
      { prompt_tokens: 100, cached_tokens: 32 },
    ]
    expect(withHonestLocalCacheUsage(sdk, 'reports', raw)?.cachedInputTokens).toBe(96)
    expect(withHonestLocalCacheUsage(sdk, 'reports', [raw[0], {}])?.cachedInputTokens)
      .toBeUndefined()
    expect(withHonestLocalCacheUsage(sdk, 'reports', [{}, raw[1]])?.cachedInputTokens)
      .toBeUndefined()
    expect(withHonestLocalCacheUsage(sdk, 'reports', [])?.cachedInputTokens)
      .toBeUndefined()
  })

  it('validates reads and writes independently and strips invalid raw counts', () => {
    const sdk = { inputTokens: 200, cachedInputTokens: 0, cacheCreationInputTokens: 0 }
    const honest = withHonestLocalCacheUsage(sdk, 'reports', [
      { cached_tokens: 10, cache_creation_input_tokens: 12 },
      { cached_tokens: 20 },
    ])
    expect(honest?.cachedInputTokens).toBe(30)
    expect(honest?.cacheCreationInputTokens).toBeUndefined()
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(withHonestLocalCacheUsage(sdk, 'reports', [{ cached_tokens: invalid }])
        ?.cachedInputTokens).toBeUndefined()
    }
  })
})

/**
 * SA-102 P4 (DL-102-04): budget against what the program is running, and say so
 * plainly when it cannot be known.
 */
describe('SA-102 effective context limit', () => {
  it('prefers the loaded context over the preset ceiling', () => {
    const result = resolveEffectiveContextLimit({
      presetContextWindow: 262144,
      reading: {
        source: 'loaded',
        loadedContextWindow: 208384,
        maxContextWindow: 262144,
        remainingTtlSeconds: null
      }
    })
    expect(result.contextLimit).toBe(208384)
    expect(result.source).toBe('loaded')
    expect(result.mismatch).toBe(true)
  })

  it('reports no mismatch when the two agree', () => {
    const result = resolveEffectiveContextLimit({
      presetContextWindow: 131072,
      reading: {
        source: 'loaded',
        loadedContextWindow: 131072,
        maxContextWindow: null,
        remainingTtlSeconds: null
      }
    })
    expect(result.contextLimit).toBe(131072)
    expect(result.mismatch).toBe(false)
  })

  it('keeps the preset and says why when the model is not loaded', () => {
    const result = resolveEffectiveContextLimit({
      presetContextWindow: 262144,
      reading: {
        source: 'unknown-until-loaded',
        loadedContextWindow: null,
        maxContextWindow: 262144,
        remainingTtlSeconds: null
      }
    })
    expect(result.contextLimit).toBe(262144)
    expect(result.source).toBe('unknown-until-loaded')
    expect(result.mismatch).toBe(false)
  })

  it('falls back to the preset for a program that cannot report at all', () => {
    const result = resolveEffectiveContextLimit({
      presetContextWindow: 32768,
      reading: null
    })
    expect(result.contextLimit).toBe(32768)
    expect(result.source).toBe('preset')
  })

  it('trusts a loaded context that is LARGER than the preset', () => {
    // The preset is the guess; the program is the fact.
    const result = resolveEffectiveContextLimit({
      presetContextWindow: 4096,
      reading: {
        source: 'loaded',
        loadedContextWindow: 131072,
        maxContextWindow: null,
        remainingTtlSeconds: null
      }
    })
    expect(result.contextLimit).toBe(131072)
    expect(result.mismatch).toBe(true)
  })

  it('knows which programs can report a loaded context at all', () => {
    expect(localRuntimeReportsLoadedContext('lmstudio')).toBe(true)
    expect(localRuntimeReportsLoadedContext('ollama')).toBe(true)
    expect(localRuntimeReportsLoadedContext('vllm')).toBe(false)
    expect(localRuntimeReportsLoadedContext('openai')).toBe(false)
  })
})

describe('SA-102 honest cache with the SDK nested usage shape', () => {
  it('strips a nested inputTokens.cacheRead the program never reported', () => {
    // ai@7 can hand back `{ inputTokens: { total, cacheRead }, ... }`, and a
    // flat delete would leave the nested value to be re-extracted downstream.
    const usage = {
      inputTokens: { total: 11313, cacheRead: 0 },
      outputTokens: { total: 5 },
      totalTokens: 11318
    } as any
    const honest = withHonestLocalCacheUsage(usage, 'never-reports')
    expect(honest?.cachedInputTokens).toBeUndefined()
    expect(honest?.inputTokenDetails?.cacheReadTokens).toBeUndefined()
    expect(honest?.inputTokens).toBe(11313)
    expect(honest?.outputTokens).toBe(5)
  })

  it('requires raw evidence even for a nested SDK usage from a reporting program', () => {
    const usage = {
      inputTokens: { total: 3020, cacheRead: 3019 },
      outputTokens: { total: 5 },
      raw: { prompt_tokens_details: { cached_tokens: 3019 } },
    } as any
    expect(withHonestLocalCacheUsage(usage, 'reports')?.cachedInputTokens).toBe(3019)
    expect(withHonestLocalCacheUsage(usage, 'reports', [{}])?.cachedInputTokens)
      .toBeUndefined()
    // Neither the SDK source nor its raw evidence is mutated.
    expect(normalizeUsageLike(usage)?.cachedInputTokens).toBe(3019)
  })
})

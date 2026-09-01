import { describe, expect, it } from 'vitest'
import {
  deriveUsageFromStepsProviderMetadata,
  extractUsageFromRawPayload,
  normalizeProviderMetadataUsageInclusive,
  normalizeUsageLike,
  resolveMessageUsage,
} from '../apiProviderUsage'

describe('apiProviderUsage', () => {
  it('normalizes Gemini raw usage metadata cache-hit fields', () => {
    const usage = extractUsageFromRawPayload({
      usageMetadata: {
        promptTokenCount: 1500,
        candidatesTokenCount: 25,
        thoughtsTokenCount: 5,
        totalTokenCount: 1530,
        cachedContentTokenCount: 1024,
      },
    })

    expect(usage?.inputTokens).toBe(1500)
    expect(usage?.outputTokens).toBe(30)
    expect(usage?.totalTokens).toBe(1530)
    expect(usage?.reasoningTokens).toBe(5)
    expect(usage?.cachedInputTokens).toBe(1024)
  })

  it('normalizes OpenAI/OpenRouter prompt-token detail cache fields', () => {
    const usage = normalizeUsageLike({
      prompt_tokens: 2048,
      completion_tokens: 20,
      total_tokens: 2068,
      prompt_tokens_details: {
        cached_tokens: 1536,
        cache_write_tokens: 512,
      },
      completion_tokens_details: {
        reasoning_tokens: 7,
      },
    })

    expect(usage?.inputTokens).toBe(2048)
    expect(usage?.outputTokens).toBe(20)
    expect(usage?.cachedInputTokens).toBe(1536)
    expect(usage?.cacheCreationInputTokens).toBe(512)
    expect(usage?.reasoningTokens).toBe(7)
  })

  it('normalizes Anthropic cache read and creation token fields', () => {
    const usage = normalizeUsageLike({
      input_tokens: 3000,
      output_tokens: 40,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 900,
    })

    expect(usage?.inputTokens).toBe(3000)
    expect(usage?.outputTokens).toBe(40)
    expect(usage?.totalTokens).toBe(3040)
    expect(usage?.cachedInputTokens).toBe(2000)
    expect(usage?.cacheCreationInputTokens).toBe(900)
  })
})

describe('SA-107 flat cached_tokens fallbacks (DL-107-05)', () => {
  it('normalizes the Together non-reasoning flat shape', () => {
    const usage = normalizeUsageLike({
      usage: {
        prompt_tokens: 5921,
        completion_tokens: 42,
        total_tokens: 5963,
        cached_tokens: 4747,
      },
    })

    expect(usage?.inputTokens).toBe(5921)
    expect(usage?.outputTokens).toBe(42)
    expect(usage?.cachedInputTokens).toBe(4747)
  })

  it('keeps the nested prompt-details shape authoritative when both appear', () => {
    const usage = normalizeUsageLike({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 640 },
      cached_tokens: 999,
    })

    expect(usage?.cachedInputTokens).toBe(640)
  })

  it('extracts Cohere native v2 message-end usage from the delta wrapper', () => {
    const usage = extractUsageFromRawPayload({
      type: 'message-end',
      delta: {
        finish_reason: 'COMPLETE',
        usage: {
          billed_units: { input_tokens: 5000, output_tokens: 20 },
          tokens: { input_tokens: 5200, output_tokens: 22 },
          cached_tokens: 4096,
        },
      },
    })

    expect(usage?.cachedInputTokens).toBe(4096)
  })

  it('reports an explicit provider zero instead of dropping it', () => {
    const usage = normalizeUsageLike({
      usage: {
        prompt_tokens: 5921,
        completion_tokens: 42,
        cached_tokens: 0,
      },
    })

    expect(usage?.cachedInputTokens).toBe(0)
  })
})

describe('SA-107 gateway providerMetadata usage (DL-107-07)', () => {
  const anthropicRawMetadata = {
    anthropic: {
      usage: {
        input_tokens: 3,
        output_tokens: 553,
        cache_read_input_tokens: 5117,
        cache_creation_input_tokens: 13996,
      },
    },
  }

  it('sums the Anthropic exclusive raw shape into inclusive input', () => {
    const usage = normalizeProviderMetadataUsageInclusive(anthropicRawMetadata)

    expect(usage?.inputTokens).toBe(3 + 5117 + 13996)
    expect(usage?.outputTokens).toBe(553)
    expect(usage?.totalTokens).toBe(3 + 5117 + 13996 + 553)
    expect(usage?.cachedInputTokens).toBe(5117)
    expect(usage?.cacheCreationInputTokens).toBe(13996)
  })

  it('never sums an OpenAI-style inclusive shape', () => {
    const usage = normalizeProviderMetadataUsageInclusive({
      openai: {
        usage: {
          prompt_tokens: 6000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 4200 },
        },
      },
    })

    expect(usage?.inputTokens).toBe(6000)
    expect(usage?.cachedInputTokens).toBe(4200)
  })

  it('returns null when metadata usage has no cache evidence', () => {
    const usage = normalizeProviderMetadataUsageInclusive({
      anthropic: {
        usage: { input_tokens: 900, output_tokens: 20 },
      },
    })

    expect(usage).toBeNull()
  })

  it('aggregates cache-bearing steps and ignores cache-less steps', () => {
    const usage = deriveUsageFromStepsProviderMetadata([
      { providerMetadata: anthropicRawMetadata },
      { providerMetadata: { anthropic: { usage: { input_tokens: 12, output_tokens: 4 } } } },
      {
        providerMetadata: {
          anthropic: {
            usage: {
              input_tokens: 5,
              output_tokens: 100,
              cache_read_input_tokens: 19000,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
    ])

    expect(usage?.inputTokens).toBe(3 + 5117 + 13996 + 5 + 19000)
    expect(usage?.outputTokens).toBe(553 + 100)
    expect(usage?.cachedInputTokens).toBe(5117 + 19000)
  })

  it('returns null for steps without providerMetadata cache usage', () => {
    expect(deriveUsageFromStepsProviderMetadata([{ usage: { inputTokens: 10 } }])).toBeNull()
    expect(deriveUsageFromStepsProviderMetadata([])).toBeNull()
  })
})

describe('SA-107 resolveMessageUsage (DL-107-06/07)', () => {
  it('returns SDK usage as-is when it already carries cache fields', () => {
    const sdkUsage = {
      inputTokens: 8017,
      outputTokens: 120,
      totalTokens: 8137,
      cachedInputTokens: 7055,
    }
    const resolved = resolveMessageUsage({
      sdkUsage,
      rawStreamUsage: { cachedInputTokens: 1 },
      isGatewayLane: false,
    })

    expect(resolved).toBe(sdkUsage)
  })

  it('fills cache fields from raw-stream usage while SDK numbers stay authoritative', () => {
    const resolved = resolveMessageUsage({
      sdkUsage: { inputTokens: 5921, outputTokens: 42, totalTokens: 5963 },
      rawStreamUsage: { inputTokens: 5900, cachedInputTokens: 4747 },
      isGatewayLane: false,
    })

    expect(resolved?.inputTokens).toBe(5921)
    expect(resolved?.outputTokens).toBe(42)
    expect(resolved?.totalTokens).toBe(5963)
    expect(resolved?.cachedInputTokens).toBe(4747)
  })

  it('derives inclusive gateway usage from step providerMetadata', () => {
    const resolved = resolveMessageUsage({
      sdkUsage: { inputTokens: 3, outputTokens: 553, totalTokens: 556 },
      steps: [
        {
          providerMetadata: {
            anthropic: {
              usage: {
                input_tokens: 3,
                output_tokens: 553,
                cache_read_input_tokens: 5117,
                cache_creation_input_tokens: 13996,
              },
            },
          },
        },
      ],
      isGatewayLane: true,
    })

    expect(resolved?.inputTokens).toBe(3 + 5117 + 13996)
    expect(resolved?.cachedInputTokens).toBe(5117)
    expect(resolved?.cacheCreationInputTokens).toBe(13996)
    expect(resolved?.totalTokens).toBe(3 + 5117 + 13996 + 553)
  })

  it('never applies the providerMetadata fallback off the gateway lane', () => {
    const sdkUsage = { inputTokens: 3, outputTokens: 553, totalTokens: 556 }
    const resolved = resolveMessageUsage({
      sdkUsage,
      steps: [
        {
          providerMetadata: {
            anthropic: {
              usage: {
                input_tokens: 3,
                output_tokens: 553,
                cache_read_input_tokens: 5117,
              },
            },
          },
        },
      ],
      isGatewayLane: false,
    })

    expect(resolved).toBe(sdkUsage)
  })

  it('returns the base unchanged when nothing carries cache evidence off the gateway lane', () => {
    const sdkUsage = { inputTokens: 100, outputTokens: 5, totalTokens: 105 }
    const resolved = resolveMessageUsage({
      sdkUsage,
      rawStreamUsage: { inputTokens: 100 },
      isGatewayLane: false,
      steps: [],
    })

    expect(resolved).toBe(sdkUsage)
  })

  it('keeps gateway values intact when nothing carries cache evidence', () => {
    const resolved = resolveMessageUsage({
      sdkUsage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
      rawStreamUsage: { inputTokens: 100 },
      isGatewayLane: true,
      steps: [],
    })

    expect(resolved?.inputTokens).toBe(100)
    expect(resolved?.outputTokens).toBe(5)
    expect(resolved?.totalTokens).toBe(105)
    expect(resolved?.cachedInputTokens).toBeUndefined()
  })

  it('corrects exclusive gateway SDK usage without step metadata (2026-08-31 live shape)', () => {
    const resolved = resolveMessageUsage({
      sdkUsage: {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
        cachedInputTokens: 5194,
        cacheCreationInputTokens: 992,
      },
      isGatewayLane: true,
      steps: [],
    })

    expect(resolved?.inputTokens).toBe(3 + 5194 + 992)
    expect(resolved?.totalTokens).toBe(3 + 5194 + 992 + 5)
    expect(resolved?.cachedInputTokens).toBe(5194)
    expect(resolved?.cacheCreationInputTokens).toBe(992)
  })

  it('leaves inclusive gateway usage values untouched', () => {
    const resolved = resolveMessageUsage({
      sdkUsage: {
        inputTokens: 6000,
        outputTokens: 50,
        totalTokens: 6050,
        cachedInputTokens: 4200,
      },
      isGatewayLane: true,
      steps: [],
    })

    expect(resolved?.inputTokens).toBe(6000)
    expect(resolved?.totalTokens).toBe(6050)
    expect(resolved?.cachedInputTokens).toBe(4200)
  })

  it('falls back to raw-stream usage when the SDK reported nothing', () => {
    const raw = { inputTokens: 200, outputTokens: 9, cachedInputTokens: 64 }
    const resolved = resolveMessageUsage({
      sdkUsage: undefined,
      rawStreamUsage: raw,
      isGatewayLane: false,
    })

    expect(resolved?.inputTokens).toBe(200)
    expect(resolved?.cachedInputTokens).toBe(64)
  })
})

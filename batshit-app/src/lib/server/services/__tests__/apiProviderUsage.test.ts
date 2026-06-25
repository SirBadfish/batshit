import { describe, expect, it } from 'vitest'
import {
  extractUsageFromRawPayload,
  normalizeUsageLike,
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

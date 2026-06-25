import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const redisStore = new Map<string, any>()

vi.mock('$lib/server/redis', () => {
  const redisMock = {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: any) => {
      redisStore.set(key, value)
    }),
    expire: vi.fn(async () => true),
    del: vi.fn(async (key: string) => {
      redisStore.delete(key)
    })
  }
  return { redis: redisMock }
})

vi.mock('$env/dynamic/private', () => ({
  env: {
    ARTIFICIAL_ANALYSIS_API_KEY: 'test-key'
  }
}))

let service: typeof import('../artificialAnalysisService')

beforeAll(async () => {
  service = await import('../artificialAnalysisService')
})

beforeEach(async () => {
  redisStore.clear()
  await service.clearArtificialAnalysisCache()
  vi.clearAllMocks()
})

describe('artificialAnalysisService', () => {
  it('fetches and caches enrichment data', async () => {
    const mockResponse = {
      models: [
        {
          slug: 'anthropic-claude-sonnet-4-5-latest',
          provider: 'anthropic',
          name: 'claude-sonnet-4-5-latest',
          context_window: 200000,
          max_output_tokens: 64000,
          input_cost_per_million: 3,
          output_cost_per_million: 15,
          capabilities: ['streaming', 'vision']
        }
      ]
    }

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    })
    globalThis.fetch = fetchSpy as any

    const first = await service.getArtificialAnalysisEnrichment({
      vercelModelId: 'anthropic/claude-sonnet-4-5-latest'
    })

    expect(first?.contextWindow).toBe(200000)
    expect(first?.maxOutputTokens).toBe(64000)
    expect(first?.pricing?.input).toBe(3)
    expect(first?.capabilities?.vision).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const second = await service.getArtificialAnalysisEnrichment({
      vercelModelId: 'anthropic/claude-sonnet-4-5-latest'
    })

    expect(second?.identifier).toBe(first?.identifier)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // cache hit
  })

  it('returns null when model is missing', async () => {
    const mockResponse = {
      models: [
        {
          slug: 'openai-gpt-4o',
          provider: 'openai',
          name: 'gpt-4o',
          context_window: 128000,
          input_cost_per_million: 5
        }
      ]
    }
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    })
    globalThis.fetch = fetchSpy as any

    const result = await service.getArtificialAnalysisEnrichment({
      vercelModelId: 'unknown/provider'
    })

    expect(result).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not trust Artificial Analysis output limits that fill the context window', async () => {
    const mockResponse = {
      models: [
        {
          slug: 'anthropic-claude-sonnet-4-5-latest',
          provider: 'anthropic',
          name: 'claude-sonnet-4-5-latest',
          context_window_tokens: 200000,
          max_output_tokens: 200000
        }
      ]
    }
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    }) as any

    const result = await service.getArtificialAnalysisEnrichment({
      vercelModelId: 'anthropic/claude-sonnet-4-5-latest'
    })

    expect(result?.contextWindow).toBe(200000)
    expect(result?.maxOutputTokens).toBeUndefined()
  })
})

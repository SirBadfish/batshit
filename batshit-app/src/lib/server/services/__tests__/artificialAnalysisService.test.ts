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
  it('finds a Free-tier model on a later page and caches only the complete list', async () => {
    const model = (slug: string) => ({ slug, name: slug, pricing: { price_1m_input_tokens: 3, price_1m_output_tokens: 15 } })
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [model('other-model')], pagination: { page: 1, page_size: 1, total_pages: 2, has_more: true } }))
      .mockResolvedValueOnce(Response.json({ data: [model('wanted-model')], pagination: { page: 2, page_size: 1, total_pages: 2, has_more: false } }))
    globalThis.fetch = fetchSpy as any
    const result = await service.getArtificialAnalysisEnrichment({ modelId: 'wanted-model' })
    expect(result?.pricing).toEqual({ input: 3, output: 15, cachedInput: undefined })
    expect(result?.contextWindow).toBeUndefined()
    expect(redisStore.get('aa_cache:catalog').items).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('preserves its previous cache when a forced refresh fails on a later page', async () => {
    const prior = { items: [{ slug: 'prior', name: 'prior' }], fetchedAt: '2026-11-04' }
    redisStore.set('aa_cache:catalog', prior)
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ slug: 'partial', name: 'partial' }], pagination: { page: 1, page_size: 1, total_pages: 2, has_more: true } }))
      .mockResolvedValueOnce(new Response('no', { status: 503 })) as any
    await expect(service.getArtificialAnalysisEnrichment({ modelId: 'partial', forceRefresh: true })).rejects.toThrow('(503)')
    expect(redisStore.get('aa_cache:catalog')).toEqual(prior)
    expect(redisStore.has('aa_cache:model:partial')).toBe(false)
  })

  it('does not overwrite the cache when pagination changes its offset size', async () => {
    const prior = { items: [{ slug: 'prior', name: 'prior' }], fetchedAt: '2026-11-04' }
    redisStore.set('aa_cache:catalog', prior)
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ slug: 'first', name: 'first' }], pagination: { page: 1, page_size: 1, total_pages: 2, has_more: true } }))
      .mockResolvedValueOnce(Response.json({ data: [{ slug: 'third', name: 'third' }], pagination: { page: 2, page_size: 2, total_pages: 2, has_more: false } })) as any
    await expect(service.getArtificialAnalysisEnrichment({ modelId: 'third', forceRefresh: true })).rejects.toThrow(/incomplete or invalid model page/)
    expect(redisStore.get('aa_cache:catalog')).toEqual(prior)
    expect(redisStore.has('aa_cache:model:third')).toBe(false)
  })

  it('fetches and caches enrichment data', async () => {
    const mockResponse = {
      pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
      data: [
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
      pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
      data: [
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
      pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
      data: [
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

/**
 * BL-130: the enrich route's Artificial Analysis mapper. A blank price is
 * unknown (it used to read as $0), and Artificial Analysis lists 0 for a model
 * it has no price for, so that is unknown too: the preset keeps the catalog's
 * price instead of a false $0.00.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

const { getArtificialAnalysisEnrichment } = await import('./artificialAnalysisService')

useRedisTestServer()

const mutableEnv = env as Record<string, string | undefined>
let savedKey: string | undefined

function stubCatalog(items: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: items }), { status: 200 }))
  )
}

beforeEach(() => {
  savedKey = mutableEnv.ARTIFICIAL_ANALYSIS_API_KEY
  mutableEnv.ARTIFICIAL_ANALYSIS_API_KEY = 'zbmodels-test-key'
})

afterEach(() => {
  mutableEnv.ARTIFICIAL_ANALYSIS_API_KEY = savedKey
  vi.unstubAllGlobals()
})

describe('BL-130 Artificial Analysis prices in the enrich route', () => {
  it('reads a blank price as unknown, not $0', async () => {
    stubCatalog([{ slug: 'blank-model', name: 'Blank Model', pricing: { input: '', output: '  ', cached_input: '' } }])
    const result = await getArtificialAnalysisEnrichment({ modelId: 'blank-model', forceRefresh: true })
    expect(result?.pricing).toEqual({ input: undefined, output: undefined, cachedInput: undefined })
  })

  it('reads a blank window as unknown, not 0', async () => {
    stubCatalog([{ slug: 'blank-window', name: 'Blank Window', context_window_tokens: '' as any, context: '  ' as any }])
    const result = await getArtificialAnalysisEnrichment({ modelId: 'blank-window', forceRefresh: true })
    expect(result?.contextWindow).toBeUndefined()
  })

  it('reads Artificial Analysis\'s 0 (no price data) as unknown', async () => {
    stubCatalog([{ slug: 'no-data', name: 'No Data', input_cost_per_million: 0, output_cost_per_million: 0 }])
    const result = await getArtificialAnalysisEnrichment({ modelId: 'no-data', forceRefresh: true })
    expect(result?.pricing?.input).toBeUndefined()
    expect(result?.pricing?.output).toBeUndefined()
  })

  it('keeps a real price (the control)', async () => {
    stubCatalog([{ slug: 'priced', name: 'Priced', pricing: { input: '4', output: 20, cached_input: '0.4' } }])
    const result = await getArtificialAnalysisEnrichment({ modelId: 'priced', forceRefresh: true })
    expect(result?.pricing).toEqual({ input: 4, output: 20, cachedInput: 0.4 })
  })
})

describe('BL-294 the enrich route reads Artificial Analysis v2 prices', () => {
  // The v2 shape (live read of /api/v2/data/llms/models, 2026-09-27): prices per
  // million tokens under pricing.price_1m_*; no cached-input price is listed.
  const kimi = {
    id: '3f1c0d3e-0000-4000-8000-000000000000',
    name: 'Kimi K3',
    slug: 'kimi-k3',
    model_creator: { id: 'c0', name: 'Kimi', slug: 'kimi' },
    pricing: { price_1m_blended_3_to_1: 6, price_1m_input_tokens: 3, price_1m_output_tokens: 15 }
  }

  it('reads the input and output price per million tokens', async () => {
    stubCatalog([kimi])
    const result = await getArtificialAnalysisEnrichment({ modelId: 'kimi-k3', forceRefresh: true })
    expect(result?.pricing).toEqual({ input: 3, output: 15, cachedInput: undefined })
  })

  it('reads a v2 row with no price data (all 0) as unknown', async () => {
    stubCatalog([
      { ...kimi, slug: 'kimi-linear-48b-a3b-instruct', name: 'Kimi Linear', pricing: { price_1m_blended_3_to_1: 0, price_1m_input_tokens: 0, price_1m_output_tokens: 0 } }
    ])
    const result = await getArtificialAnalysisEnrichment({ modelId: 'kimi-linear-48b-a3b-instruct', forceRefresh: true })
    expect(result?.pricing).toEqual({ input: undefined, output: undefined, cachedInput: undefined })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARTIFICIAL_ANALYSIS_MODELS_URL, fetchArtificialAnalysisCatalog } from './artificialAnalysisCatalog'

function page(number: number, total = 2, slug = `model-${number}`) {
  return { tier: 'free', data: [{ slug, name: slug, pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 } }],
    pagination: { page: number, page_size: 1, total_pages: total, has_more: number < total } }
}

afterEach(() => vi.unstubAllGlobals())

describe('supported Artificial Analysis model pages', () => {
  it('reads all pages of the Free API with server-side authentication', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page(1))).mockResolvedValueOnce(Response.json(page(2)))
    vi.stubGlobal('fetch', fetcher)
    const models = await fetchArtificialAnalysisCatalog({ apiKey: 'fixture-key' })
    expect(models.map(model => model.slug)).toEqual(['model-1', 'model-2'])
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([`${ARTIFICIAL_ANALYSIS_MODELS_URL}?page=1`, `${ARTIFICIAL_ANALYSIS_MODELS_URL}?page=2`])
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { 'x-api-key': 'fixture-key', Accept: 'application/json' }, redirect: 'error', signal: expect.anything() }))
  })

  it('preserves explicit Pro endpoint parameters and starts at page one', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(page(1, 1)))
    vi.stubGlobal('fetch', fetcher)
    await fetchArtificialAnalysisCatalog({ apiKey: 'fixture-key', apiUrl: 'https://artificialanalysis.ai/api/v2/language/models?prompt_type=long&page=99' })
    expect(fetcher.mock.calls[0][0]).toBe('https://artificialanalysis.ai/api/v2/language/models?prompt_type=long&page=1')
  })

  it('rejects a later-page failure instead of returning a partial catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(page(1))).mockResolvedValueOnce(new Response('private upstream body', { status: 429 })))
    await expect(fetchArtificialAnalysisCatalog({ apiKey: 'fixture-key' })).rejects.toThrow('Artificial Analysis API request failed (429)')
  })

  it.each([
    { ...page(1), pagination: undefined },
    { ...page(1), data: [] },
    { ...page(1), pagination: { ...page(1).pagination, page: 2 } },
    { ...page(1), pagination: { ...page(1).pagination, has_more: false } },
    { ...page(1), pagination: { ...page(1).pagination, total_pages: 101 } },
    { ...page(1), pagination: { ...page(1).pagination, page_size: 2 } },
    { ...page(1), data: [{ slug: '', name: 'broken' }] }
  ])('rejects malformed or incomplete responses %j', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)))
    await expect(fetchArtificialAnalysisCatalog({ apiKey: 'fixture-key' })).rejects.toThrow(/Artificial Analysis API/)
  })

  it.each([page(2, 3), page(2, 2, 'model-1')])('rejects drifting page totals and repeated model identities', async last => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(page(1))).mockResolvedValueOnce(Response.json(last)))
    await expect(fetchArtificialAnalysisCatalog({ apiKey: 'fixture-key' })).rejects.toThrow(/Artificial Analysis API/)
  })

  it('rejects a page-size change that can skip offset-based rows without duplicates', async () => {
    const last = { ...page(2), pagination: { ...page(2).pagination, page_size: 2 } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(page(1))).mockResolvedValueOnce(Response.json(last)))
    await expect(fetchArtificialAnalysisCatalog({ apiKey: 'fixture-key' })).rejects.toThrow(/incomplete or invalid model page/)
  })
})

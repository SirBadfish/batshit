import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const retirements: import('$lib/data/catalog-confirmed-retirements').ConfirmedCatalogRetirement[] = []
vi.mock('$lib/data/catalog-confirmed-retirements', () => ({ CONFIRMED_CATALOG_RETIREMENTS: retirements }))

const upstashKvGet = vi.fn()
const upstashKvSet = vi.fn(async () => undefined)
const storeCatalogSyncReport = vi.fn(async () => ({ warningStreak: 0, warningAlert: null }))
const getRuntimeEnv = vi.fn(async (_name: string): Promise<string | undefined> => undefined)

vi.mock('$lib/server/services/upstashKv', () => ({ upstashKvGet, upstashKvSet }))
vi.mock('$lib/server/services/modelCatalogReportStore', () => ({ storeCatalogSyncReport }))
vi.mock('$lib/server/services/runtimeEnv', () => ({ getRuntimeEnv }))

const { runModelCatalogSync } = await import('./modelCatalogSync')

const savedGateway = {
  id: 'maker/old', canonicalId: 'maker/old', provider: 'maker', name: 'old',
  displayName: 'Old', source: 'vercel', transport: 'vercel-gateway', connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway'], tags: [], purpose: 'chat',
  features: { streaming: true, tools: true, vision: false },
  idVariants: {
    'vercel-gateway': { developerId: 'maker', modelId: 'old', effectiveId: 'maker/old', source: 'vercel' }
  }
}

describe('catalog source response validation', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    retirements.length = 0
    upstashKvGet.mockReset().mockResolvedValue({ version: 2, fetchedAt: '2026-09-28T00:00:00Z', models: [savedGateway] })
    upstashKvSet.mockClear()
    storeCatalogSyncReport.mockClear()
    getRuntimeEnv.mockReset().mockResolvedValue(undefined)
    fetchSpy = vi.fn(async (input: string) => new Response(JSON.stringify(
      input.includes('deepinfra.com') ? [] : { data: [], models: [] }
    ), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([{}, { data: [], error: { message: 'provider failed' } }])(
    'does not apply an approved retirement from a malformed HTTP 200 response: %j', async (gatewayResponse) => {
    retirements.push({
      connectionId: 'vercel-gateway', effectiveId: 'maker/old',
      firstAbsentAt: '2026-09-28T00:00:00Z', recheckedAt: '2026-09-28T01:00:00Z',
      evidenceUrl: 'https://example.com/provider-retirement', reason: 'Fixture retirement'
    })
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes('ai-gateway.vercel.sh') ? gatewayResponse : input.includes('deepinfra.com') ? [] : { data: [] }
    ), { status: 200 }))

    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some((model) => model.idVariants?.['vercel-gateway']?.effectiveId === 'maker/old')).toBe(true)
    const source = result.report.sources.find((source) => source.connectionId === 'vercel-gateway')
    expect(source).toMatchObject({ error: expect.stringContaining('model list') })
    expect(source?.confirmedRemovalIds ?? []).toEqual([])
  })

  it.each([
    ['openrouter', undefined, 'openrouter.ai', {}],
    ['direct:deepinfra', undefined, 'deepinfra.com', {}],
    ['direct:moonshot', 'MOONSHOT_API_KEY', 'moonshot.ai', { data: [{ id: null }] }],
    ['direct:openai', 'OPENAI_API_KEY', 'api.openai.com', { data: [{ id: 42 }] }],
    ['direct:replicate', 'REPLICATE_API_KEY', 'replicate.com', { models: [{ is_official: true, owner: 'maker', name: null }] }],
    ['direct:fal', 'FAL_API_KEY', 'api.fal.ai', { models: [{ endpoint_id: null }], next_cursor: null }],
    ['direct:fireworks', 'FIREWORKS_API_KEY', 'fireworks.ai', { models: [], nextPageToken: 42 }],
    ['direct:google', 'GOOGLE_GENERATIVE_AI_API_KEY', 'generativelanguage.googleapis.com', { models: [], nextPageToken: 42 }],
    ['direct:cohere', 'COHERE_API_KEY', 'api.cohere.ai', {}],
    ['direct:cohere', 'COHERE_API_KEY', 'api.cohere.ai', { models: [], next_page_token: 42 }],
    ['direct:anthropic', 'ANTHROPIC_API_KEY', 'anthropic.com', { data: [{ id: 'claude-valid' }], has_more: true }]
  ])('rejects incomplete or malformed %s responses', async (connectionId, envName, host, invalidPayload) => {
    if (envName) getRuntimeEnv.mockImplementation(async (name) => name === envName ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes(host) ? invalidPayload : input.includes('deepinfra.com') ? [] : { data: [], models: [] }
    ), { status: 200 }))

    const result = await runModelCatalogSync({ dryRun: true })
    const source = result.report.sources.find((source) => source.connectionId === connectionId)
    expect(source).toMatchObject({ ok: false, error: expect.any(String) })
    expect(source?.confirmedRemovalIds ?? []).toEqual([])
  })

  it.each([
    [{ has_more: true }, false],
    [{ has_more: 'false' }, false],
    [{ has_more: null }, false],
    [{ hasMore: true }, false],
    [{ next_page_token: 'page2' }, false],
    [{ nextPageToken: 42 }, false],
    [{ next_cursor: 'cursor2' }, false],
    [{ nextCursor: {} }, false],
    [{ next: 'https://provider.example/page2' }, false],
    [{}, true],
    [{ has_more: false, hasMore: false, next_page_token: null, nextPageToken: '', next_cursor: null, nextCursor: '', next: null }, true]
  ])('requires a terminal compatible list before applying retirement: %j', async (pagination, complete) => {
    const connectionId = 'direct:moonshot'
    upstashKvGet.mockResolvedValue({ version: 2, fetchedAt: '2026-09-28T00:00:00Z', models: [{
      ...savedGateway, id: 'moonshot/old', canonicalId: 'moonshot/old', provider: 'moonshot',
      source: 'direct', transport: 'direct', connectionId, availableConnections: [connectionId],
      idVariants: { [connectionId]: { developerId: 'moonshot', modelId: 'old', effectiveId: 'old', source: 'direct' } }
    }] })
    retirements.push({ connectionId, effectiveId: 'old',
      firstAbsentAt: '2026-09-28T00:00:00Z', recheckedAt: '2026-09-28T01:00:00Z',
      evidenceUrl: 'https://example.com/provider-retirement', reason: 'Fixture retirement' })
    getRuntimeEnv.mockImplementation(async (name) => name === 'MOONSHOT_API_KEY' ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes('moonshot.ai') ? { data: [{ id: 'current' }], ...pagination }
        : input.includes('deepinfra.com') ? [] : { data: [], models: [] }
    ), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    const source = result.report.sources.find(item => item.connectionId === connectionId)
    expect(result.payload.models.some(model => model.idVariants?.[connectionId]?.effectiveId === 'old')).toBe(!complete)
    expect(source?.confirmedRemovalIds ?? []).toEqual(complete ? ['old'] : [])
    if (complete) expect(source?.error).toBeUndefined()
    else expect(source?.error).toContain('pagination')
  })

  it('reads every Cohere page before treating the list as complete', async () => {
    getRuntimeEnv.mockImplementation(async (name) => name === 'COHERE_API_KEY' ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes('api.cohere.ai')
        ? input.includes('page_token=next-page')
          ? { models: [{ name: 'cohere-two', endpoints: ['chat'] }] }
          : { models: [{ name: 'cohere-one', endpoints: ['chat'] }], next_page_token: 'next-page' }
        : input.includes('deepinfra.com') ? [] : { data: [], models: [] }
    ), { status: 200 }))

    const result = await runModelCatalogSync({ dryRun: true })
    const source = result.report.sources.find((item) => item.connectionId === 'direct:cohere')
    expect(source).toMatchObject({ fetchedCount: 2, error: undefined })
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes('api.cohere.ai'))).toHaveLength(2)
  })
})

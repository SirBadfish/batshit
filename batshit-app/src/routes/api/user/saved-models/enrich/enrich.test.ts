import { beforeEach, describe, expect, it, vi } from 'vitest'

const catalogEntries = new Map<string, any>()
const aaEnrichment = vi.fn(async (): Promise<any> => null)

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: {
    createForUser: vi.fn(async () => ({ listAvailableModels: () => [] }))
  }
}))

vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  findVercelCatalogEntryById: vi.fn(async (id?: string | null) =>
    id ? (catalogEntries.get(id) ?? null) : null
  )
}))

vi.mock('$lib/server/services/artificialAnalysisService', () => ({
  getArtificialAnalysisEnrichment: aaEnrichment
}))

const { POST } = await import('./+server')

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'anthropic/claude-haiku-4-5-20251001',
    provider: 'anthropic',
    name: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5 (2025-10-01)',
    source: 'vercel',
    features: { streaming: true },
    idVariants: {
      'direct:anthropic': {
        developerId: 'anthropic',
        modelId: 'claude-haiku-4-5-20251001',
        effectiveId: 'claude-haiku-4-5-20251001',
        source: 'direct'
      }
    },
    ...overrides
  }
}

async function enrich(id: string, connectionId = 'direct:anthropic') {
  const response = await POST({
    request: new Request('http://localhost/api/user/saved-models/enrich', {
      method: 'POST',
      body: JSON.stringify({ vercelModelId: id, connectionId })
    }),
    locals: { user: { id: 'user_1' } }
  } as any)
  expect(response.status).toBe(200)
  return (await response.json()).data
}

beforeEach(() => {
  catalogEntries.clear()
  aaEnrichment.mockReset()
  aaEnrichment.mockResolvedValue(null)
})

describe('POST /api/user/saved-models/enrich unknown price and context window (BL-67)', () => {
  it('returns no price and no context window for a catalog row that has neither, never 0', async () => {
    const row = catalogRow()
    catalogEntries.set(row.id, row)

    const data = await enrich(row.id)

    expect(data.contextWindow).toBeUndefined()
    expect(data.pricing?.input).toBeUndefined()
    expect(data.pricing?.output).toBeUndefined()
    expect(data.enrichment.contextWindow).toBeUndefined()
  })

  it('keeps an explicit catalog price of 0 as a real zero', async () => {
    const row = catalogRow({
      pricing: { input: 0, output: 0 },
      contextWindow: 200000
    })
    catalogEntries.set(row.id, row)

    const data = await enrich(row.id)

    expect(data.pricing.input).toBe(0)
    expect(data.pricing.output).toBe(0)
    expect(data.contextWindow).toBe(200000)
  })

  it('treats a catalog context window of 0 as unknown', async () => {
    const row = catalogRow({ contextWindow: 0 })
    catalogEntries.set(row.id, row)

    const data = await enrich(row.id)

    expect(data.contextWindow).toBeUndefined()
  })
})

/**
 * BL-68: a merged row carries the gateway's window. Anthropic's direct API runs
 * Sonnet 4.5 at 200,000 tokens (1,000,000 needs a beta header Batshit does not
 * send), so a connection that joined through the reviewed identity rule takes
 * its own limits, and an unknown one stays unknown.
 */
describe('POST /api/user/saved-models/enrich per-connection limits (BL-68)', () => {
  function mergedSonnet45() {
    return {
      id: 'anthropic/claude-sonnet-4.5',
      provider: 'anthropic',
      name: 'claude-sonnet-4.5',
      displayName: 'Claude Sonnet 4.5',
      source: 'vercel',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: { input: 3, output: 15, cachedInput: 0.3 },
      features: { streaming: true, tools: true, maxTokens: 1_000_000 },
      idVariants: {
        'vercel-gateway': {
          developerId: 'anthropic',
          modelId: 'claude-sonnet-4.5',
          effectiveId: 'anthropic/claude-sonnet-4.5',
          source: 'vercel'
        },
        'direct:anthropic': {
          developerId: 'anthropic',
          modelId: 'claude-sonnet-4-5-20250929',
          effectiveId: 'claude-sonnet-4-5-20250929',
          source: 'direct',
          limits: { contextWindow: null, maxOutputTokens: null }
        }
      }
    }
  }

  it('gives a direct preset its own unknown window, not the gateway row\'s 1,000,000', async () => {
    const row = mergedSonnet45()
    catalogEntries.set(row.id, row)

    const data = await enrich(row.id, 'direct:anthropic')

    expect(data.contextWindow).toBeUndefined()
    expect(data.enrichment.contextWindow).toBeUndefined()
    expect(data.effectiveModelId).toBe('claude-sonnet-4-5-20250929')
    // The price is the same list price on every connection and still applies.
    expect(data.pricing).toMatchObject({ input: 3, output: 15, cachedInput: 0.3 })
    // No limit is known, so the output cap is Batshit's safe default, marked estimated.
    expect(data.enrichment.maxOutputTokensEstimated).toBe(true)
  })

  it('does not let Artificial Analysis fill the direct connection\'s window either', async () => {
    const row = mergedSonnet45()
    catalogEntries.set(row.id, row)
    aaEnrichment.mockResolvedValue({ contextWindow: 1_000_000, maxOutputTokens: 64_000 })

    const data = await enrich(row.id, 'direct:anthropic')

    expect(data.contextWindow).toBeUndefined()
    expect(data.enrichment.contextWindow).toBeUndefined()
    expect(data.enrichment.maxOutputTokensEstimated).toBe(true)
  })

  it('keeps the row\'s numbers for the gateway connection', async () => {
    const row = mergedSonnet45()
    catalogEntries.set(row.id, row)

    const data = await enrich(row.id, 'vercel-gateway')

    expect(data.contextWindow).toBe(1_000_000)
    expect(data.settings.maxTokens).toBe(64_000)
  })
})

describe('POST /api/user/saved-models/enrich per-connection price (BL-132)', () => {
  const glm53 = () => ({
    id: 'zai/glm-5.3',
    provider: 'zai',
    name: 'glm-5.3',
    displayName: 'GLM 5.3',
    source: 'vercel',
    connectionId: 'vercel-gateway',
    contextWindow: 262_144,
    pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 },
    features: { streaming: true },
    availableConnections: ['vercel-gateway', 'direct:deepinfra'],
    idVariants: {
      'vercel-gateway': { developerId: 'zai', modelId: 'glm-5.3', effectiveId: 'zai/glm-5.3', source: 'vercel' },
      'direct:deepinfra': {
        developerId: 'zai-org',
        modelId: 'GLM-5.3',
        effectiveId: 'zai-org/GLM-5.3',
        source: 'direct',
        limits: { contextWindow: 131_072, maxOutputTokens: null },
        pricing: { input: 0.45, output: 1.9 }
      }
    }
  })

  it('gives a DeepInfra preset DeepInfra\'s price, not the gateway row\'s', async () => {
    const row = glm53()
    catalogEntries.set(row.id, row)

    const data = await enrich(row.id, 'direct:deepinfra')

    expect(data.effectiveModelId).toBe('zai-org/GLM-5.3')
    expect(data.pricing).toEqual({ input: 0.45, output: 1.9 })
    expect(data.contextWindow).toBe(131_072)
  })

  it('keeps the row\'s price for the gateway connection', async () => {
    const row = glm53()
    catalogEntries.set(row.id, row)

    const data = await enrich(row.id, 'vercel-gateway')

    expect(data.pricing).toEqual({ input: 0.6, output: 2.2, cachedInput: 0.11 })
  })

  it('does not let an Artificial Analysis price stand in for the connection\'s own', async () => {
    const row = glm53()
    catalogEntries.set(row.id, row)
    aaEnrichment.mockResolvedValue({ pricing: { input: 1, output: 3.2 }, source: 'artificial-analysis' })

    const data = await enrich(row.id, 'direct:deepinfra')

    expect(data.pricing).toEqual({ input: 0.45, output: 1.9 })
    // The baseline Restore Defaults returns to is the connection's own price too.
    expect(data.enrichment.pricing).toEqual({ input: 0.45, output: 1.9 })
  })
})

describe('POST /api/user/saved-models/enrich the catalog\'s own price wins over Artificial Analysis (decision A)', () => {
  it('keeps the row\'s listed price and lets Artificial Analysis fill only a row with none', async () => {
    const priced = catalogRow({ id: 'deepseek/deepseek-v4-flash', pricing: { input: 0.13, output: 0.26 } })
    const unpriced = catalogRow({ id: 'acme/unpriced' })
    catalogEntries.set(priced.id, priced)
    catalogEntries.set(unpriced.id, unpriced)
    aaEnrichment.mockResolvedValue({ pricing: { input: 0.44, output: 1.32 }, source: 'artificial-analysis' })

    const pricedData = await enrich(priced.id)
    expect(pricedData.pricing).toEqual({ input: 0.13, output: 0.26 })
    expect(pricedData.enrichment.pricing).toEqual({ input: 0.13, output: 0.26 })
    expect((await enrich(unpriced.id)).pricing).toEqual({ input: 0.44, output: 1.32 })
  })
})

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

async function enrich(id: string) {
  const response = await POST({
    request: new Request('http://localhost/api/user/saved-models/enrich', {
      method: 'POST',
      body: JSON.stringify({ vercelModelId: id, connectionId: 'direct:anthropic' })
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

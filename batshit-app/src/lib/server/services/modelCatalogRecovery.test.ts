import { beforeEach, describe, expect, it, vi } from 'vitest'

const retirements: import('$lib/data/catalog-confirmed-retirements').ConfirmedCatalogRetirement[] = []
vi.mock('$lib/data/catalog-confirmed-retirements', () => ({ CONFIRMED_CATALOG_RETIREMENTS: retirements }))

const upstashKvGet = vi.fn()
const upstashKvSet = vi.fn(async () => undefined)
const getRuntimeEnv = vi.fn(async (name: string): Promise<string | undefined> => name === 'FAL_API_KEY' ? 'fixture-key' : undefined)
vi.mock('$lib/server/services/upstashKv', () => ({ upstashKvGet, upstashKvSet }))
vi.mock('$lib/server/services/modelCatalogReportStore', () => ({
  storeCatalogSyncReport: vi.fn(async () => ({ warningStreak: 0, warningAlert: null }))
}))
vi.mock('$lib/server/services/runtimeEnv', () => ({ getRuntimeEnv }))

const { runModelCatalogSync } = await import('./modelCatalogSync')

const recoveredIds = [
  'imagineart/imagineart-1.5-preview/text-to-image',
  'imagineart/imagineart-1.5-pro-preview/text-to-image',
  'imagineart/imagineart-2.0-edit-preview/image-to-image',
  'imagineart/imagineart-2.0-preview/text-to-image'
]

function savedFalRow() {
  const id = recoveredIds[0]
  return {
    id,
    canonicalId: id,
    provider: 'imagineart',
    upstreamProvider: 'fal',
    name: 'imagineart-1.5-preview/text-to-image',
    displayName: 'Saved catalog name',
    description: 'Saved catalog description',
    tags: ['image'],
    purpose: 'visual',
    features: { streaming: false, tools: false, vision: false },
    category: 'visual',
    source: 'direct',
    transport: 'direct',
    connectionId: 'direct:fal',
    availableConnections: ['direct:fal'],
    idVariants: {
      'direct:fal': { developerId: 'imagineart', modelId: 'imagineart-1.5-preview/text-to-image', effectiveId: id, source: 'direct' }
    }
  }
}

describe('dated Fal recovery entries', () => {
  let falModels: Record<string, unknown>[]

  beforeEach(() => {
    retirements.length = 0
    falModels = []
    upstashKvGet.mockReset().mockResolvedValue(null)
    upstashKvSet.mockClear()
    getRuntimeEnv.mockReset().mockImplementation(async name => name === 'FAL_API_KEY' ? 'fixture-key' : undefined)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(
      input.includes('ai-gateway.vercel.sh')
        ? { data: [{ id: 'maker/gateway-only', name: 'Gateway Only' }] }
        : input.includes('api.fal.ai/v1/models')
          ? { models: falModels, next_cursor: null }
          : { data: [] }
    ), { status: 200 })))
  })

  it('keeps four known Fal IDs on first publication without inventing prices or limits', async () => {
    falModels = [{ endpoint_id: 'fal-ai/unrelated', metadata: { display_name: 'Unrelated', category: 'text-to-image' } }]
    const result = await runModelCatalogSync({ dryRun: true })
    for (const id of recoveredIds) {
      const model = result.payload.models.find(model => model.idVariants?.['direct:fal']?.effectiveId === id)
      expect(model, id).toBeDefined()
      expect(model?.idVariants?.['direct:fal']?.pricing).toBeUndefined()
      expect(model?.idVariants?.['direct:fal']?.limits?.contextWindow).toBeFalsy()
    }
    expect(result.report.sources.find(source => source.connectionId === 'direct:fal')).toMatchObject({
      fetchedCount: 1,
      pendingRemovalIds: recoveredIds
    })
    expect(upstashKvSet).not.toHaveBeenCalled()
  })

  it('uses fresh Fal metadata when a recovered ID returns', async () => {
    falModels = [{ endpoint_id: recoveredIds[0], metadata: { display_name: 'Fresh provider name', category: 'text-to-image' } }]
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.find(model => model.idVariants?.['direct:fal']?.effectiveId === recoveredIds[0])?.displayName)
      .toBe('Fresh provider name')
    expect(result.report.sources.find(source => source.connectionId === 'direct:fal')?.pendingRemovalIds)
      .toEqual(recoveredIds.slice(1))
  })

  it('preserves an existing saved Fal row rather than replacing its metadata with the seed', async () => {
    upstashKvGet.mockResolvedValueOnce({ version: 2, fetchedAt: '2026-09-28T12:00:00Z', models: [savedFalRow()] })
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.find(model => model.idVariants?.['direct:fal']?.effectiveId === recoveredIds[0])?.displayName)
      .toBe('Saved catalog name')
  })

  it('allows a reviewed Fal retirement after a complete live recheck', async () => {
    retirements.push({
      connectionId: 'direct:fal', effectiveId: recoveredIds[0],
      firstAbsentAt: '2026-09-28T10:00:00Z', recheckedAt: '2026-09-28T11:00:00Z',
      evidenceUrl: 'https://fal.ai/models/imagineart/retired', reason: 'Fixture provider confirmation'
    })
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some(model => model.idVariants?.['direct:fal']?.effectiveId === recoveredIds[0])).toBe(false)
    expect(result.report.sources.find(source => source.connectionId === 'direct:fal')?.confirmedRemovalIds)
      .toEqual([recoveredIds[0]])
  })

  it('does not reintroduce a retired recovery seed on a later source failure', async () => {
    retirements.push({
      connectionId: 'direct:fal', effectiveId: recoveredIds[0],
      firstAbsentAt: '2026-09-28T10:00:00Z', recheckedAt: '2026-09-28T11:00:00Z',
      evidenceUrl: 'https://fal.ai/models/imagineart/retired', reason: 'Fixture provider confirmation'
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('api.fal.ai/v1/models')) throw new Error('Fal timed out')
      return new Response(JSON.stringify(input.includes('ai-gateway.vercel.sh')
        ? { data: [{ id: 'maker/gateway-only', name: 'Gateway Only' }] }
        : { data: [] }), { status: 200 })
    }))

    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some(model => model.idVariants?.['direct:fal']?.effectiveId === recoveredIds[0])).toBe(false)
    expect(result.report.sources.find(source => source.connectionId === 'direct:fal')?.error).toContain('Fal timed out')

    upstashKvGet.mockResolvedValueOnce({ version: 2, fetchedAt: '2026-09-28T12:00:00Z', models: [savedFalRow()] })
    const withSavedRow = await runModelCatalogSync({ dryRun: true })
    expect(withSavedRow.payload.models.some(model => model.idVariants?.['direct:fal']?.effectiveId === recoveredIds[0])).toBe(true)
  })

  it('does not change unrelated connection identities', async () => {
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.find(model => model.id === 'maker/gateway-only')?.idVariants?.['vercel-gateway']?.effectiveId)
      .toBe('maker/gateway-only')
    expect(result.payload.models.find(model => model.id === 'maker/gateway-only')?.idVariants?.['direct:fal'])
      .toBeUndefined()
  })

  it('labels recovery coverage truthfully when the Fal key is missing', async () => {
    getRuntimeEnv.mockResolvedValue(undefined)
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.report.sources.find(source => source.connectionId === 'direct:fal')).toMatchObject({
      skipped: true,
      fetchedCount: 0,
      warning: expect.stringContaining('preserving 4 prior/recovered Fal entries')
    })
  })
})

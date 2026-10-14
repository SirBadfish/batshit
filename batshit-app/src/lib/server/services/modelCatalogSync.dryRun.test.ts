/**
 * BL-68: the catalog sync's dry run must never write to Upstash (no catalog
 * upload, no stored report), and the snapshot replay must not touch the network
 * at all. Each "never" has a positive control in the same setup.
 */
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

const { buildCatalogFromSnapshot, runModelCatalogSync } = await import('./modelCatalogSync')

function row(overrides: Record<string, unknown>) {
  return {
    tags: [],
    purpose: 'chat',
    features: { streaming: true, tools: true, vision: true, maxTokens: 0, longContext: false },
    category: 'balanced',
    ...overrides
  }
}

const SNAPSHOT = {
  version: 2,
  fetchedAt: '2026-09-22T06:03:53.365Z',
  models: [
    row({
      id: 'anthropic/claude-sonnet-4.5',
      canonicalId: 'anthropic/claude-sonnet-4.5',
      provider: 'anthropic',
      name: 'claude-sonnet-4.5',
      displayName: 'Claude Sonnet 4.5',
      contextWindow: 1_000_000,
      pricing: { input: 3, output: 15 },
      features: { streaming: true, tools: true, vision: true, maxTokens: 1_000_000, longContext: true },
      source: 'vercel',
      transport: 'vercel-gateway',
      connectionId: 'vercel-gateway',
      availableConnections: ['vercel-gateway'],
      idVariants: {
        'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-sonnet-4.5', effectiveId: 'anthropic/claude-sonnet-4.5', source: 'vercel' }
      }
    }),
    row({
      id: 'claude-sonnet-4-5-20250929',
      canonicalId: 'anthropic/claude-sonnet-4-5-20250929',
      provider: 'anthropic',
      name: 'claude-sonnet-4-5-20250929',
      displayName: 'Claude Sonnet 4.5',
      source: 'direct',
      transport: 'direct',
      connectionId: 'direct:anthropic',
      availableConnections: ['direct:anthropic'],
      idVariants: {
        'direct:anthropic': { developerId: 'anthropic', modelId: 'claude-sonnet-4-5-20250929', effectiveId: 'claude-sonnet-4-5-20250929', source: 'direct' }
      }
    })
  ]
}

describe('BL-68 sync dry run and snapshot replay', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    retirements.length = 0
    upstashKvGet.mockReset()
    upstashKvGet.mockResolvedValue(SNAPSHOT)
    upstashKvSet.mockClear()
    storeCatalogSyncReport.mockClear()
    getRuntimeEnv.mockReset().mockResolvedValue(undefined)
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('publishes and stores its report on a real run (the control)', async () => {
    await runModelCatalogSync({ trigger: 'cli' })

    expect(upstashKvSet).toHaveBeenCalledWith('catalog:v1', expect.anything(), expect.anything())
    expect(storeCatalogSyncReport).toHaveBeenCalledTimes(1)
  })

  it('refuses publication when the prior catalog read fails', async () => {
    upstashKvGet.mockRejectedValueOnce(new Error('Upstash read timed out'))

    await expect(runModelCatalogSync({ trigger: 'cli' })).rejects.toThrow('Upstash read timed out')
    expect(upstashKvGet).toHaveBeenCalledWith('catalog:v1', expect.objectContaining({ required: true }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(upstashKvSet).not.toHaveBeenCalled()
    expect(storeCatalogSyncReport).not.toHaveBeenCalled()
  })

  it('refuses publication when catalog read credentials are missing', async () => {
    upstashKvGet.mockRejectedValueOnce(new Error('KV_REST_API_READ_ONLY_TOKEN not configured'))

    await expect(runModelCatalogSync({ trigger: 'cli' })).rejects.toThrow('KV_REST_API_READ_ONLY_TOKEN not configured')
    expect(upstashKvGet).toHaveBeenCalledWith('catalog:v1', expect.objectContaining({ required: true }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(upstashKvSet).not.toHaveBeenCalled()
    expect(storeCatalogSyncReport).not.toHaveBeenCalled()
  })

  it('refuses publication when the prior catalog is malformed', async () => {
    upstashKvGet.mockResolvedValueOnce({ version: 2, models: 'not an array' })

    await expect(runModelCatalogSync({ trigger: 'cli' })).rejects.toThrow('existing catalog')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(upstashKvSet).not.toHaveBeenCalled()
    expect(storeCatalogSyncReport).not.toHaveBeenCalled()
  })

  it.each([null, {}, { ...SNAPSHOT.models[0], idVariants: {} }])('refuses an unusable saved identity before fetching sources: %s', badRow => {
    upstashKvGet.mockResolvedValueOnce({ ...SNAPSHOT, models: [badRow] })
    return expect(runModelCatalogSync()).rejects.toThrow('existing catalog')
  })

  it.each(['MINIMAX_TOKEN_PLAN_API_KEY', 'MIMO_TOKEN_PLAN_API_KEY', 'QWEN_TOKEN_PLAN_API_KEY', 'KIMI_CODE_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY'])('reports rejected configured credentials even for a docs-backed source: %s', async key => {
    getRuntimeEnv.mockImplementation(async name => name === key ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async () => new Response('Unauthorized', { status: 401 }))
    const result = await runModelCatalogSync({ dryRun: true })
    const source = result.report.sources.find(source => source.connectionId === `direct:${key.replace('_API_KEY', '').toLowerCase()}`)
    expect(source).toMatchObject({ ok: false, error: expect.stringContaining('(401)') })
  })

  it('never applies approved retirement when a source was skipped for a missing key', async () => {
    retirements.push({ connectionId: 'direct:anthropic', effectiveId: 'claude-sonnet-4-5-20250929', firstAbsentAt: '2026-09-28T00:00:00Z', recheckedAt: '2026-09-28T01:00:00Z', evidenceUrl: 'https://docs.anthropic.com/retirement', reason: 'Fixture confirmation' })
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some(model => model.idVariants?.['direct:anthropic']?.effectiveId === 'claude-sonnet-4-5-20250929')).toBe(true)
    expect(result.report.sources.find(source => source.connectionId === 'direct:anthropic')).toMatchObject({ skipped: true, confirmedRemovalIds: [] })
  })

  it('applies reviewed retirement only after a valid configured live recheck', async () => {
    retirements.push({ connectionId: 'direct:anthropic', effectiveId: 'claude-sonnet-4-5-20250929', firstAbsentAt: '2026-09-28T00:00:00Z', recheckedAt: '2026-09-28T01:00:00Z', evidenceUrl: 'https://docs.anthropic.com/retirement', reason: 'Fixture confirmation' })
    getRuntimeEnv.mockImplementation(async name => name === 'ANTHROPIC_API_KEY' ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some(model => model.idVariants?.['direct:anthropic']?.effectiveId === 'claude-sonnet-4-5-20250929')).toBe(false)
    expect(result.report.sources.find(source => source.connectionId === 'direct:anthropic')).toMatchObject({ skipped: false, confirmedRemovalIds: ['claude-sonnet-4-5-20250929'] })
  })

  it('cannot retire approved entries from a malformed successful HTTP response', async () => {
    retirements.push({ connectionId: 'direct:anthropic', effectiveId: 'claude-sonnet-4-5-20250929', firstAbsentAt: '2026-09-28T00:00:00Z', recheckedAt: '2026-09-28T01:00:00Z', evidenceUrl: 'https://docs.anthropic.com/retirement', reason: 'Fixture confirmation' })
    getRuntimeEnv.mockImplementation(async name => name === 'ANTHROPIC_API_KEY' ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some(model => model.idVariants?.['direct:anthropic']?.effectiveId === 'claude-sonnet-4-5-20250929')).toBe(true)
    expect(result.report.sources.find(source => source.connectionId === 'direct:anthropic')).toMatchObject({ ok: false, error: expect.any(String) })
  })

  it.each(['missing key', 'timeout', 'rejected key', 'malformed response', 'fresh list', 'absent from fresh list'])(
    'publishes healthy sources and reports only reviewed OpenAI policy removals with %s', async mode => {
      const excluded = ['babbage-002', 'davinci-002', 'gpt-3.5-turbo-instruct', 'gpt-3.5-turbo-instruct-0914']
      const savedOpenAI = (id: string) => row({ id, provider: 'openai', name: id, displayName: id,
        source: 'direct', transport: 'direct', connectionId: 'direct:openai', availableConnections: ['direct:openai'],
        idVariants: { 'direct:openai': { developerId: 'openai', modelId: id, effectiveId: id } },
        ...(id === 'gpt-3.5-turbo-instruct' ? {
          id: `openai/${id}`, connectionId: 'vercel-gateway', source: 'vercel', transport: 'vercel-gateway',
          availableConnections: ['vercel-gateway', 'direct:openai'],
          idVariants: {
            'direct:openai': { developerId: 'openai', modelId: id, effectiveId: id },
            'vercel-gateway': { developerId: 'openai', modelId: id, effectiveId: `openai/${id}` }
          }
        } : {}) })
      const openRouterId = 'openai/gpt-3.5-turbo-instruct'
      upstashKvGet.mockResolvedValueOnce({ ...SNAPSHOT, models: [...SNAPSHOT.models,
        ...[...excluded, 'gpt-4o', 'future-missing'].map(savedOpenAI),
        row({ id: openRouterId, provider: 'openai', name: 'gpt-3.5-turbo-instruct', displayName: 'Instruct',
          source: 'openrouter', transport: 'openrouter', connectionId: 'openrouter', availableConnections: ['openrouter'],
          idVariants: { openrouter: { developerId: 'openai', modelId: 'gpt-3.5-turbo-instruct', effectiveId: openRouterId } } })] })
      getRuntimeEnv.mockImplementation(async name => name === 'OPENAI_API_KEY' && mode !== 'missing key' ? 'test-key' : undefined)
      fetchSpy.mockImplementation(async (input: string) => {
        if (input.includes('api.openai.com')) {
          if (mode === 'timeout') throw new Error('OpenAI timeout')
          if (mode === 'rejected key') return new Response('Unauthorized', { status: 401 })
          if (mode === 'malformed response') return new Response(JSON.stringify({}), { status: 200 })
          return new Response(JSON.stringify({ data: [...(mode === 'fresh list' ? excluded : []), 'gpt-4o', 'fresh-model'].map(id => ({ id })) }), { status: 200 })
        }
        return new Response(JSON.stringify({ data: input.includes('ai-gateway.vercel.sh')
          ? [{ id: 'maker/new', name: 'Healthy new model' }] : [] }), { status: 200 })
      })

      const result = await runModelCatalogSync({ trigger: 'cli' })
      const ids = result.payload.models.flatMap(model => Object.entries(model.idVariants ?? {}).map(([connection, variant]) => `${connection}:${variant.effectiveId}`))
      for (const id of excluded) expect(ids).not.toContain(`direct:openai:${id}`)
      expect(ids).toContain('direct:openai:gpt-4o')
      expect(ids).toContain('direct:openai:future-missing')
      expect(ids).toContain(`openrouter:${openRouterId}`)
      expect(ids).toContain(`vercel-gateway:${openRouterId}`)
      expect(ids).toContain('vercel-gateway:maker/new')
      const source = result.report.sources.find(source => source.connectionId === 'direct:openai')!
      expect(source).toMatchObject({
        policyRemovalIds: excluded, confirmedRemovalIds: [], skipped: mode === 'missing key'
      })
      if (mode === 'timeout') expect(source.error).toContain('timeout')
      else if (mode === 'rejected key') expect(source.error).toContain('(401)')
      else if (mode === 'malformed response') expect(source.error).toContain('OpenAI')
      else expect(source.error).toBeUndefined()
      const liveSuccess = mode === 'fresh list' || mode === 'absent from fresh list'
      expect(ids.includes('direct:openai:fresh-model')).toBe(liveSuccess)
      if (liveSuccess) expect(source.fetchedCount).toBe(2)
      expect(upstashKvSet).toHaveBeenCalledWith('catalog:v1', result.payload, expect.anything())
      expect(storeCatalogSyncReport).toHaveBeenCalledWith(expect.objectContaining({ report: expect.objectContaining({
        sources: expect.arrayContaining([expect.objectContaining({ connectionId: 'direct:openai', policyRemovalIds: excluded })])
      }) }))
    }
  )

  it('names saved Z.ai compatibility aliases as policy removals during an outage', async () => {
    const id = 'glm-4.5'
    upstashKvGet.mockResolvedValueOnce({ ...SNAPSHOT, models: [...SNAPSHOT.models, row({
      id, provider: 'zai', name: id, displayName: id, connectionId: 'direct:zai_coding', availableConnections: ['direct:zai_coding'],
      idVariants: { 'direct:zai_coding': { developerId: 'zai', modelId: id, effectiveId: id } }
    })] })
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some(model => model.idVariants?.['direct:zai_coding']?.effectiveId === id)).toBe(false)
    expect(result.report.sources.find(source => source.connectionId === 'direct:zai_coding')).toMatchObject({ policyRemovalIds: [id] })
    expect(upstashKvSet).not.toHaveBeenCalled()
  })

  it('still refuses unapproved downstream loss after a same-connection merge collision', async () => {
    const saved = ['first', 'second'].map(id => row({
      id: `maker/${id}`, provider: 'maker', name: 'shared', displayName: id,
      connectionId: 'vercel-gateway', availableConnections: ['vercel-gateway'],
      idVariants: { 'vercel-gateway': { developerId: 'maker', modelId: 'shared', effectiveId: `maker/${id}` } }
    }))
    upstashKvGet.mockResolvedValueOnce({ ...SNAPSHOT, models: saved })
    await expect(runModelCatalogSync()).rejects.toThrow('unapproved saved connection')
    expect(upstashKvSet).not.toHaveBeenCalled()
    expect(storeCatalogSyncReport).not.toHaveBeenCalled()
  })

  it('permits the first publication when the catalog key is genuinely absent', async () => {
    upstashKvGet.mockResolvedValueOnce(null)
    fetchSpy.mockImplementation(async (input: string) =>
      new Response(
        JSON.stringify(
          input.includes('ai-gateway.vercel.sh')
            ? { data: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }] }
            : { data: [] }
        ),
        { status: 200 }
      )
    )

    await runModelCatalogSync({ trigger: 'cli' })

    expect(upstashKvSet).toHaveBeenCalledWith('catalog:v1', expect.anything(), expect.anything())
    expect(storeCatalogSyncReport).toHaveBeenCalledTimes(1)
  })

  it('writes nothing to Upstash on a dry run and still returns the catalog', async () => {
    const result = await runModelCatalogSync({ trigger: 'cli', dryRun: true })

    expect(upstashKvSet).not.toHaveBeenCalled()
    expect(storeCatalogSyncReport).not.toHaveBeenCalled()
    const ids = result.payload.models.map((model) => model.id)
    expect(ids).toContain('anthropic/claude-sonnet-4.5')
    expect(ids).not.toContain('claude-sonnet-4-5-20250929')
    expect(result.report.variantCollisions).toEqual([])
  })

  it('keeps a missing source identity even when replacements increase the response count', async () => {
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes('ai-gateway.vercel.sh')
        ? { data: [{ id: 'maker/new-a', name: 'New A' }, { id: 'maker/new-b', name: 'New B' }] }
        : { data: [] }
    ), { status: 200 }))

    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.map(model => model.id)).toContain('anthropic/claude-sonnet-4.5')
    expect(result.payload.models.map(model => model.id)).toContain('maker/new-a')
    expect(result.report.sources.find(source => source.connectionId === 'vercel-gateway')).toMatchObject({
      ok: false, pendingRemovalIds: ['anthropic/claude-sonnet-4.5']
    })
    expect(result.payload.models.find(model => model.id === 'anthropic/claude-sonnet-4.5')?.idVariants?.['vercel-gateway']?.effectiveId)
      .toBe('anthropic/claude-sonnet-4.5')
  })

  it('uses fresh metadata for present identities while retaining missing ones', async () => {
    const second = { ...SNAPSHOT.models[0], id: 'maker/old', provider: 'maker', name: 'old',
      canonicalId: 'maker/old', idVariants: { 'vercel-gateway': { developerId: 'maker', modelId: 'old', effectiveId: 'maker/old' } } }
    upstashKvGet.mockResolvedValueOnce({ ...SNAPSHOT, models: [SNAPSHOT.models[0], second] })
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes('ai-gateway.vercel.sh')
        ? { data: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Fresh name', context_window: 999999 }] }
        : { data: [] }
    ), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.find(model => model.id === 'anthropic/claude-sonnet-4.5')?.contextWindow).toBe(999999)
    expect(result.payload.models.map(model => model.id)).toContain('maker/old')
  })

  it('reports a Moonshot authentication failure instead of disguising it as a short manual list', async () => {
    getRuntimeEnv.mockImplementation(async name => name === 'MOONSHOT_API_KEY' ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async (input: string) => input.includes('moonshot.ai')
      ? new Response('Unauthorized', { status: 401 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.report.sources.find(source => source.connectionId === 'direct:moonshot')).toMatchObject({
      usedFallback: true, error: expect.stringContaining('(401)')
    })
  })

  it.each(['openrouter', 'direct:replicate'])('preserves missing identities on %s independently of the gateway', async connectionId => {
    const saved = row({ id: 'maker/old', provider: 'maker', name: 'old', canonicalId: 'maker/old',
      connectionId, availableConnections: [connectionId],
      idVariants: { [connectionId]: { developerId: 'maker', modelId: 'old', effectiveId: 'maker/old' } } })
    upstashKvGet.mockResolvedValueOnce({ ...SNAPSHOT, models: [SNAPSHOT.models[0], saved] })
    getRuntimeEnv.mockImplementation(async name => name === 'REPLICATE_API_KEY' ? 'test-key' : undefined)
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes('replicate.com')
        ? { models: [{ owner: 'maker', name: 'new', is_official: true }] }
        : input.includes('openrouter.ai') ? { data: [{ id: 'maker/new', name: 'New' }] }
        : { data: [] }
    ), { status: 200 }))
    const result = await runModelCatalogSync({ trigger: 'cli' })
    expect(result.payload.models.find(model => model.id === 'maker/old')?.idVariants?.[connectionId]?.effectiveId).toBe('maker/old')
    expect(result.report.sources.find(source => source.connectionId === connectionId)?.pendingRemovalIds).toEqual(['maker/old'])
    expect(storeCatalogSyncReport).toHaveBeenCalledWith(expect.objectContaining({ report: expect.objectContaining({
      sources: expect.arrayContaining([expect.objectContaining({ connectionId, pendingRemovalIds: ['maker/old'] })])
    }) }))
  })

  it('rejects a Fal list which still has another page at the pagination cap', async () => {
    getRuntimeEnv.mockImplementation(async name => name === 'FAL_API_KEY' ? 'test-key' : undefined)
    let pages = 0
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      input.includes('api.fal.ai')
        ? { models: [{ endpoint_id: `fal-ai/model-${++pages}` }], next_cursor: `page-${pages}` }
        : { data: [] }
    ), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    expect(pages).toBe(200)
    expect(result.report.sources.find(source => source.connectionId === 'direct:fal')).toMatchObject({
      usedFallback: true, error: expect.stringContaining('incomplete')
    })
  })

  it('replays a snapshot without any network and applies the reviewed rules', () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error('network used')
    })

    const { payload } = buildCatalogFromSnapshot(SNAPSHOT)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(upstashKvGet).not.toHaveBeenCalled()
    expect(payload.fetchedAt).toBe(SNAPSHOT.fetchedAt)
    expect(payload.models).toHaveLength(1)
    expect(payload.models[0].idVariants?.['direct:anthropic']).toMatchObject({
      effectiveId: 'claude-sonnet-4-5-20250929',
      limits: { contextWindow: null, maxOutputTokens: null }
    })
  })

  it('keeps rows the snapshot merged by Artificial Analysis merged, and applies the OpenAI policy', () => {
    const { payload } = buildCatalogFromSnapshot({
      version: 2,
      fetchedAt: SNAPSHOT.fetchedAt,
      models: [
        row({
          id: 'anthropic/claude-opus-4.6',
          canonicalId: 'anthropic/claude-opus-4.6',
          provider: 'anthropic',
          name: 'claude-opus-4.6',
          displayName: 'Claude Opus 4.6',
          aaSlug: 'claude-opus-4-6',
          contextWindow: 1_000_000,
          source: 'vercel',
          transport: 'vercel-gateway',
          connectionId: 'vercel-gateway',
          availableConnections: ['vercel-gateway', 'direct:anthropic'],
          idVariants: {
            'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-opus-4.6', effectiveId: 'anthropic/claude-opus-4.6', source: 'vercel' },
            'direct:anthropic': { developerId: 'anthropic', modelId: 'claude-opus-4-6', effectiveId: 'claude-opus-4-6', source: 'direct' }
          }
        }),
        row({
          id: 'babbage-002',
          canonicalId: 'openai/babbage-002',
          provider: 'openai',
          name: 'babbage-002',
          displayName: 'babbage-002',
          source: 'direct',
          transport: 'direct',
          connectionId: 'direct:openai',
          availableConnections: ['direct:openai'],
          idVariants: {
            'direct:openai': { developerId: 'openai', modelId: 'babbage-002', effectiveId: 'babbage-002', source: 'direct' }
          }
        })
      ]
    })

    expect(payload.models.map((model) => model.canonicalId)).toEqual(['anthropic/claude-opus-4.6'])
    expect(payload.models[0].aaSlug).toBe('claude-opus-4-6')
    expect(payload.models[0].idVariants?.['direct:anthropic']).toEqual({
      developerId: 'anthropic',
      modelId: 'claude-opus-4-6',
      effectiveId: 'claude-opus-4-6',
      source: 'direct'
    })
    expect(payload.counts.openai).toBe(0)
  })
})

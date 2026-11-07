import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QWEN_TOKEN_PLAN_OPENAI_BASE_URL } from '$lib/server/constants/qwenTokenPlan'

const retirements: import('$lib/data/catalog-confirmed-retirements').ConfirmedCatalogRetirement[] = []
vi.mock('$lib/data/catalog-confirmed-retirements', () => ({ CONFIRMED_CATALOG_RETIREMENTS: retirements }))

const upstashKvGet = vi.fn()
const upstashKvGetRaw = vi.fn(async (...args: unknown[]) => {
  const value = await upstashKvGet(...args)
  return value === null || typeof value === 'string' ? value : JSON.stringify(value)
})
const upstashKvSetIfUnchanged = vi.fn(async () => true)
const storeCatalogSyncReport = vi.fn(async () => ({ warningStreak: 0, warningAlert: null }))
const getRuntimeEnv = vi.fn(async (_name: string): Promise<string | undefined> => undefined)

vi.mock('$lib/server/services/upstashKv', () => ({ upstashKvGetRaw, upstashKvSetIfUnchanged }))
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
    upstashKvGetRaw.mockClear()
    upstashKvSetIfUnchanged.mockClear()
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

  const alibabaPrior = () => ({ ...savedGateway, id: 'qwen/old', canonicalId: 'qwen/old', provider: 'qwen',
    source: 'direct', transport: 'direct', connectionId: 'direct:alibaba', availableConnections: ['direct:alibaba'],
    idVariants: { 'direct:alibaba': { developerId: 'qwen', modelId: 'old', effectiveId: 'old', source: 'direct' } } })
  const peerEnv = (extra: Record<string, string> = {}) => {
    const values: Record<string, string> = { DASHSCOPE_API_KEY: 'qwen-source-fixture', ...extra }
    getRuntimeEnv.mockImplementation(async name => values[name])
  }
  const listPeer = (payload: unknown = { data: [{ id: 'qwen-plus', owned_by: 'system' }] }) => {
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      String(input).includes('aliyuncs.com') ? payload : String(input).includes('deepinfra.com') ? [] : { data: [] }
    ), { status: 200 }))
  }

  it('binds only fresh same-endpoint Model Studio metadata to a separate Alibaba variant without a second request or retirement recheck', async () => {
    upstashKvGet.mockResolvedValue({ version: 2, fetchedAt: '2026-09-28T00:00:00Z', models: [savedGateway, alibabaPrior()] })
    retirements.push({ connectionId: 'direct:alibaba', effectiveId: 'old', firstAbsentAt: '2026-09-28T00:00:00Z',
      recheckedAt: '2026-09-28T01:00:00Z', evidenceUrl: 'https://www.alibabacloud.com/help/en/model-studio/models', reason: 'Fixture removal must not apply through a peer metadata read' })
    peerEnv({ ALIBABA_CLOUD_API_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/' })
    listPeer()
    const result = await runModelCatalogSync({ dryRun: true })
    const imported = result.payload.models.find(model => model.idVariants?.['direct:alibaba']?.effectiveId === 'qwen-plus')!
    expect(imported.idVariants?.['direct:qwencloud']).toMatchObject({ developerId: 'qwen', effectiveId: 'qwen-plus' })
    expect(imported.idVariants?.['direct:alibaba']).toMatchObject({ developerId: 'qwen', effectiveId: 'qwen-plus' })
    expect(result.payload.models.some(model => model.idVariants?.['direct:alibaba']?.effectiveId === 'old')).toBe(true)
    expect(result.report.sources.find(source => source.connectionId === 'direct:alibaba')).toMatchObject({ metadataSourceConnectionId: 'direct:qwencloud', fetchedCount: 1, skipped: false, confirmedRemovalIds: [], pendingRemovalIds: ['old'] })
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes('aliyuncs.com'))).toHaveLength(1)
    expect(upstashKvSetIfUnchanged).not.toHaveBeenCalled()
    expect(storeCatalogSyncReport).not.toHaveBeenCalled()
  })

  it.each([
    ['empty override', { ALIBABA_CLOUD_API_BASE_URL: '' }],
    ['region', { ALIBABA_CLOUD_API_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }],
    ['workspace', { ALIBABA_CLOUD_API_BASE_URL: 'https://one.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', DASHSCOPE_API_BASE_URL: 'https://two.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' }],
    ['custom host', { ALIBABA_CLOUD_API_BASE_URL: 'https://example.com/compatible-mode/v1', DASHSCOPE_API_BASE_URL: 'https://example.com/compatible-mode/v1' }],
    ['HTTP', { ALIBABA_CLOUD_API_BASE_URL: 'http://dashscope-intl.aliyuncs.com/compatible-mode/v1', DASHSCOPE_API_BASE_URL: 'http://dashscope-intl.aliyuncs.com/compatible-mode/v1' }],
    ['query', { ALIBABA_CLOUD_API_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1?workspace=one' }],
    ['fragment', { ALIBABA_CLOUD_API_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1#one' }],
    ['userinfo', { ALIBABA_CLOUD_API_BASE_URL: 'https://user@dashscope-intl.aliyuncs.com/compatible-mode/v1' }],
    ['path', { ALIBABA_CLOUD_API_BASE_URL: 'https://dashscope-intl.aliyuncs.com/api/v1' }],
    ['Token Plan', { ALIBABA_CLOUD_API_BASE_URL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' }]
  ] as const)('does not share Alibaba metadata across a changed %s binding', async (_case, overrides) => {
    peerEnv(overrides)
    listPeer()
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.some(model => model.idVariants?.['direct:alibaba'])).toBe(false)
    expect(result.report.sources.find(source => source.connectionId === 'direct:alibaba')).not.toHaveProperty('metadataSourceConnectionId')
  })

  it.each([
    ['both explicit bindings', { ALIBABA_CLOUD_API_BASE_URL: QWEN_TOKEN_PLAN_OPENAI_BASE_URL, DASHSCOPE_API_BASE_URL: QWEN_TOKEN_PLAN_OPENAI_BASE_URL }],
    ['inherited DashScope binding', { DASHSCOPE_API_BASE_URL: QWEN_TOKEN_PLAN_OPENAI_BASE_URL }]
  ] as const)('refuses Token Plan peer metadata with %s while retaining exact prior Alibaba coverage', async (_case, overrides) => {
    upstashKvGet.mockResolvedValue({ version: 2, fetchedAt: '2026-09-28T00:00:00Z', models: [savedGateway, alibabaPrior()] })
    peerEnv(overrides)
    listPeer()
    const result = await runModelCatalogSync({ dryRun: true })
    const alibabaIds = result.payload.models.flatMap(model => model.idVariants?.['direct:alibaba'] ? [model.idVariants['direct:alibaba'].effectiveId] : [])
    expect(alibabaIds).toEqual(['old'])
    expect(result.report.sources.find(source => source.connectionId === 'direct:alibaba')).not.toHaveProperty('metadataSourceConnectionId')
    expect(result.report.sources.find(source => source.connectionId === 'direct:alibaba')?.confirmedRemovalIds).toEqual([])
  })

  it.each([{}, { data: [] }, { data: [{ id: 'qwen-plus' }], has_more: true }, { data: [], error: { message: 'failed' } }])(
    'retains prior Alibaba coverage rather than reusing failed/empty/incomplete peer metadata: %j', async payload => {
      upstashKvGet.mockResolvedValue({ version: 2, fetchedAt: '2026-09-28T00:00:00Z', models: [savedGateway, alibabaPrior()] })
      peerEnv(); listPeer(payload)
      const result = await runModelCatalogSync({ dryRun: true })
      expect(result.payload.models.some(model => model.idVariants?.['direct:alibaba']?.effectiveId === 'old')).toBe(true)
      expect(result.report.sources.find(source => source.connectionId === 'direct:alibaba')).not.toHaveProperty('metadataSourceConnectionId')
    }
  )

  it('keeps configured Alibaba and Qwen credentials and source results independent', async () => {
    peerEnv({ ALIBABA_CLOUD_API_KEY: 'alibaba-source-fixture' })
    fetchSpy.mockImplementation(async (input: string, init?: RequestInit) => new Response(JSON.stringify(
      String(input).includes('aliyuncs.com') ? { data: [{ id: new Headers(init?.headers).get('Authorization') === 'Bearer alibaba-source-fixture' ? 'qwen-ali-only' : 'qwen-peer-only', owned_by: 'system' }] }
        : String(input).includes('deepinfra.com') ? [] : { data: [] }
    ), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.find(model => model.idVariants?.['direct:alibaba']?.effectiveId === 'qwen-ali-only')?.idVariants).not.toHaveProperty('direct:qwencloud')
    expect(result.payload.models.find(model => model.idVariants?.['direct:qwencloud']?.effectiveId === 'qwen-peer-only')?.idVariants).not.toHaveProperty('direct:alibaba')
    expect(result.report.sources.find(source => source.connectionId === 'direct:alibaba')).not.toHaveProperty('metadataSourceConnectionId')
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes('aliyuncs.com'))).toHaveLength(2)
  })

  it.each(['STEPFUN_API_KEY', 'STEP_API_KEY'])('discovers exact StepFun IDs using only its %s owner and warns about unverified new metadata', async keyName => {
    getRuntimeEnv.mockImplementation(async name => name === keyName ? 'stepfun-source-fixture' : undefined)
    fetchSpy.mockImplementation(async (input: string) => new Response(JSON.stringify(
      String(input).includes('api.stepfun.ai') ? { data: [{ id: 'step-5-preview', owned_by: 'stepai' }, { id: 'stepaudio-2.5-chat', owned_by: 'stepai' }, { id: 'stepaudio-future', owned_by: 'stepai' }, { id: 'constructor', owned_by: 'stepai' }] }
        : String(input).includes('deepinfra.com') ? [] : { data: [] }
    ), { status: 200 }))
    const result = await runModelCatalogSync({ dryRun: true })
    expect(result.payload.models.find(model => model.idVariants?.['direct:stepfun']?.effectiveId === 'stepaudio-2.5-chat')?.purpose).toBe('chat')
    expect(result.payload.models.filter(model => model.idVariants?.['direct:stepfun'])).toHaveLength(4)
    expect(result.report.sources.find(source => source.connectionId === 'direct:stepfun')).toMatchObject({ fetchedCount: 4, warning: expect.stringContaining('stepaudio-future') })
    expect(result.report.sources.find(source => source.connectionId === 'direct:stepfun')?.warning).toContain('constructor')
    const request = fetchSpy.mock.calls.find(([input]) => String(input).includes('api.stepfun.ai'))
    expect(String(request?.[0])).toBe('https://api.stepfun.ai/v1/models')
  })

  it.each(['stepfun', 'alibaba'] as const)('preserves %s exact prior IDs on source error, malformed/empty and successful shorter lists', async provider => {
    const connectionId = `direct:${provider}`
    const prior = { ...savedGateway, id: `${provider}/old`, canonicalId: `${provider}/old`, provider: provider === 'stepfun' ? 'stepai' : 'qwen',
      source: 'direct', transport: 'direct', connectionId, availableConnections: [connectionId],
      idVariants: { [connectionId]: { developerId: provider === 'stepfun' ? 'stepai' : 'qwen', modelId: 'old-EXACT', effectiveId: 'old-EXACT', source: 'direct' } } }
    const keys: Record<string, string> = { STEPFUN_API_KEY: 'stepfun-source-fixture', ALIBABA_CLOUD_API_KEY: 'alibaba-source-fixture', DASHSCOPE_API_KEY: 'qwen-source-fixture' }
    getRuntimeEnv.mockImplementation(async name => keys[name])
    for (const response of [null, {}, { data: [] }, { data: [{ id: provider === 'stepfun' ? 'step-5-preview' : 'qwen-plus', owned_by: provider === 'stepfun' ? 'stepai' : 'system' }] }]) {
      upstashKvGet.mockResolvedValue({ version: 2, fetchedAt: '2026-09-28T00:00:00Z', models: [savedGateway, prior] })
      fetchSpy.mockImplementation(async (input: string, init?: RequestInit) => {
        const ownRequest = provider === 'stepfun' ? String(input).includes('stepfun.ai') : new Headers(init?.headers).get('Authorization') === 'Bearer alibaba-source-fixture'
        return new Response(JSON.stringify(ownRequest ? response : String(input).includes('deepinfra.com') ? [] : { data: [] }), { status: ownRequest && response === null ? 503 : 200 })
      })
      const result = await runModelCatalogSync({ dryRun: true })
      expect(result.payload.models.some(model => model.idVariants?.[connectionId]?.effectiveId === 'old-EXACT')).toBe(true)
      expect(result.report.sources.find(source => source.connectionId === connectionId)?.confirmedRemovalIds).toEqual([])
      expect(result.report.sources.find(source => source.connectionId === connectionId)).not.toHaveProperty('metadataSourceConnectionId')
    }
  })
})

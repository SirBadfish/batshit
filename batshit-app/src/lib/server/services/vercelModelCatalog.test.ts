/**
 * BL-68 on the instance side of the catalog: an exact-connection lookup for a
 * preset whose row merged into another, and no `maxTokens: 0` for an unknown
 * window when an instance falls back to the gateway's own model list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { UPSTASH_COMPARE_AND_SET_SCRIPT } from './upstashKv'
import { projectCatalogReasoningEvidence } from '$lib/utils/catalogReasoningEvidence'
import { reviewedPublicReasoningEvidence } from '$lib/data/reviewed-public-reasoning-facts'

vi.mock('$lib/server/services/upstashKv', async importOriginal => ({
  ...await importOriginal<typeof import('./upstashKv')>(), upstashKvGet: vi.fn(async () => null)
}))

const { fetchVercelModelCatalog, findVercelCatalogEntryById, readCachedVercelModelCatalog, readCachedVercelModelCatalogStamp,
  CATALOG_CACHE_COMPARE_SCRIPT } = await import('./vercelModelCatalog')

useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
  const target = new URL(resolvedUrl)
  const database = Number(target.pathname.slice(1))
  expect(Number.isInteger(database) && database > 0).toBe(true)
  expect((await adminClient.clientInfo()).db).toBe(database)
  const modules = await adminClient.sendCommand<string[]>(['MODULE', 'LIST'])
  expect(JSON.stringify(modules)).toMatch(/ReJSON/)
} })
const executeFixtureBase = vi.isMockFunction(redis.execute) ? vi.mocked(redis.execute).getMockImplementation() : null

// Only this owning file needs the new raw-read/CAS fixture. Real-lane tests execute Lua itself.
beforeEach(() => {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return
  const execute = executeFixtureBase!
  vi.spyOn(redis, 'execute').mockImplementation((operation: any) => execute(async (client: any) => {
    const rawAt = async (kind: string, key: string) => kind === 'json'
      ? JSON.stringify([await client.json.get(key)]) : kind === 'string' ? await client.get(key) : ''
    const fixture = { ...client,
      sendCommand: async (command: string[]) => {
        expect(command).toEqual(['JSON.GET', 'vercel:model_catalog:v1', '$'])
        return rawAt('json', command[1])
      },
      eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
        expect(script).toBe(CATALOG_CACHE_COMPARE_SCRIPT)
        const key = options.keys[0]
        const [expectedKind, expectedRaw, operation, serialized] = options.arguments
        const type = await client.type(key)
        const kind = ['ReJSON-RL', 'JSON'].includes(type) ? 'json' : type
        if (kind !== expectedKind || await rawAt(kind, key) !== expectedRaw) return 'CHANGED'
        if (operation === 'SET') {
          if (kind === 'string') await client.set(key, serialized)
          else await client.json.set(key, '$', JSON.parse(serialized))
        }
        await client.persist(key)
        return 'OK'
      }
    }
    return operation(fixture)
  }))
})

const MERGED_HAIKU = {
  id: 'anthropic/claude-haiku-4.5',
  canonicalId: 'anthropic/claude-haiku-4.5',
  provider: 'anthropic',
  name: 'claude-haiku-4.5',
  displayName: 'Claude Haiku 4.5',
  tags: [],
  features: { streaming: true, tools: true, vision: true, maxTokens: 200_000 },
  source: 'vercel',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'direct:anthropic'],
  idVariants: {
    'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-haiku-4.5', effectiveId: 'anthropic/claude-haiku-4.5', source: 'vercel' },
    'direct:anthropic': { developerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001', effectiveId: 'claude-haiku-4-5-20251001', source: 'direct' }
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('reviewed purpose corrections on existing catalog snapshots', () => {
  it.each(['json', 'string'])('clears only MiMo plan USD pricing on an existing %s merged snapshot', async storage => {
    const row = { ...structuredClone(MERGED_HAIKU), id: 'xiaomi/mimo-v2.6-pro', canonicalId: 'xiaomi/mimo-v2.6-pro',
      provider: 'xiaomi', name: 'mimo-v2.6-pro', pricing: { input: 0.435, output: 0.87 },
      availableConnections: ['vercel-gateway', 'direct:mimo_token_plan'], idVariants: {
        'vercel-gateway': { developerId: 'xiaomi', modelId: 'mimo-v2.6-pro', effectiveId: 'xiaomi/mimo-v2.6-pro', source: 'vercel' },
        'direct:mimo_token_plan': { developerId: 'xiaomi', modelId: 'mimo-v2.6-pro', effectiveId: 'mimo-v2.6-pro', source: 'direct' }
      } }
    const snapshot = { fetchedAt: new Date().toISOString(), models: [row] }
    if (storage === 'json') await redis.set('vercel:model_catalog:v1', snapshot)
    else await redis.execute(client => client.set('vercel:model_catalog:v1', JSON.stringify(snapshot)))
    const loaded = (await fetchVercelModelCatalog()).models[0]
    expect(loaded.pricing).toEqual(row.pricing)
    expect(loaded.idVariants?.['direct:mimo_token_plan']).toMatchObject({ effectiveId: 'mimo-v2.6-pro', pricing: {} })
    expect(loaded.idVariants?.['vercel-gateway']).toEqual(row.idVariants['vercel-gateway'])
    expect((await readCachedVercelModelCatalog())?.models[0].idVariants?.['direct:mimo_token_plan'].pricing).toEqual({})
  })

  it.each(['json', 'string'])('corrects stale %s cached classifications without changing exact variants or prices', async storage => {
    const definitions = [
      ['vercel-gateway', 'baseten/elephant-1', 'utility'],
      ['direct:baseten', 'decision-models/baseten-mammoth-27b-latest', 'utility'],
      ['direct:replicate', 'pixverse/pixverse-v6-max', 'visual']
    ]
    const snapshot = { fetchedAt: new Date().toISOString(), models: definitions.map(([connectionId, id]) => ({
      id, canonicalId: id, provider: id.split('/')[0], name: id.split('/').slice(1).join('/'), displayName: id,
      purpose: 'chat', source: connectionId === 'vercel-gateway' ? 'vercel' : 'direct', connectionId,
      availableConnections: [connectionId], pricing: { input: 0.1 },
      idVariants: { [connectionId]: { developerId: id.split('/')[0], modelId: id.split('/').slice(1).join('/'), effectiveId: id,
        source: connectionId === 'vercel-gateway' ? 'vercel' : 'direct' } }
    })) }
    if (storage === 'json') await redis.set('vercel:model_catalog:v1', snapshot)
    else await redis.execute(client => client.set('vercel:model_catalog:v1', JSON.stringify(snapshot)))
    const fetch = vi.fn(() => { throw new Error('fresh cache must not refresh') })
    vi.stubGlobal('fetch', fetch)
    const loaded = await fetchVercelModelCatalog()
    expect(fetch).not.toHaveBeenCalled()
    for (const [connectionId, id, purpose] of definitions) {
      const row = loaded.models.find(model => model.idVariants?.[connectionId]?.effectiveId === id)!
      expect(row.purpose).toBe(purpose)
      expect(row.pricing).toMatchObject({ input: 0.1 })
      expect(row.availableConnections).toEqual([connectionId])
    }
  })
})

describe('ordinary provider coverage across instance catalog loading', () => {
  it.each(['json', 'string'])('retains %s cached direct and OpenRouter variants without reasoning facts when only raw Gateway answers', async storage => {
    const prior = { ...structuredClone(MERGED_HAIKU), contextWindow: 200000, pricing: { input: 1, output: 2 } }
    const directOnly = { ...structuredClone(prior), id: 'cohere/only-direct', canonicalId: 'cohere/only-direct',
      provider: 'cohere', name: 'only-direct', connectionId: 'direct:cohere', availableConnections: ['direct:cohere'],
      idVariants: { 'direct:cohere': { developerId: 'cohere', modelId: 'Exact-Direct', effectiveId: 'Exact-Direct', source: 'direct' } } }
    const routerOnly = { ...structuredClone(directOnly), id: 'cohere/only-router', canonicalId: 'cohere/only-router',
      connectionId: 'openrouter', availableConnections: ['openrouter'],
      idVariants: { openrouter: { developerId: 'cohere', modelId: 'Exact-Router', effectiveId: 'cohere/Exact-Router', source: 'openrouter' } } }
    const snapshot = { models: [prior, directOnly, routerOnly], fetchedAt: '2026-10-14T12:00:00Z' }
    if (storage === 'json') await redis.set('vercel:model_catalog:v1', snapshot)
    else await redis.execute(client => client.set('vercel:model_catalog:v1', JSON.stringify(snapshot)))
    vi.stubGlobal('fetch', vi.fn(async (input: any) => String(input).includes('ai-gateway.vercel.sh')
      ? new Response(JSON.stringify({ data: [{ id: prior.id, name: 'Fresh gateway', context_window: 400000 }] }), { status: 200 })
      : new Response('registry unavailable', { status: 503 })))
    const refreshed = await fetchVercelModelCatalog(true)
    expect(refreshed.models).toHaveLength(3)
    const shared = refreshed.models.find(model => model.canonicalId === prior.canonicalId)!
    expect(shared.contextWindow).toBe(400000)
    expect(shared.idVariants?.['direct:anthropic']).toMatchObject({ effectiveId: prior.idVariants['direct:anthropic'].effectiveId,
      limits: { contextWindow: 200000, maxOutputTokens: null }, pricing: { input: 1, output: 2 } })
    expect(shared.idVariants?.['direct:anthropic']).not.toHaveProperty('reasoningEvidence')
    expect(refreshed.models.find(model => model.id === directOnly.id)?.idVariants).toEqual(directOnly.idVariants)
    expect(refreshed.models.find(model => model.id === routerOnly.id)?.idVariants).toEqual(routerOnly.idVariants)
    expect(await readCachedVercelModelCatalog()).toEqual(refreshed)
    expect(await redis.execute(client => client.type('vercel:model_catalog:v1'))).toBe(storage === 'string' ? 'string' : 'ReJSON-RL')
  })

  it('adopts the authoritative shared catalog without resurrecting removed ordinary variants', async () => {
    await redis.set('vercel:model_catalog:v1', { models: [MERGED_HAIKU], fetchedAt: '2026-10-14T12:00:00Z' })
    const published = structuredClone(MERGED_HAIKU)
    delete (published.idVariants as any)['direct:anthropic']
    published.availableConnections = ['vercel-gateway']
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [published], fetchedAt: '2026-10-18T11:01:39Z' }), { status: 200 })))
    const refreshed = await fetchVercelModelCatalog(true)
    expect(refreshed.models).toHaveLength(1)
    expect(refreshed.models[0].idVariants).not.toHaveProperty('direct:anthropic')
    expect(refreshed.models[0].availableConnections).toEqual(['vercel-gateway'])
  })
})

describe('reasoning evidence across instance catalog loading', () => {
  function priorWithReasoning() {
    const prior: any = structuredClone(MERGED_HAIKU)
    prior.contextWindow = 200000
    const variant = prior.idVariants['direct:anthropic']
    const evidence = { lastGood: { version: 1, scope: 'public', support: 'supported', connection: 'direct:anthropic',
      effectiveModelId: variant.effectiveId, endpoint: 'messages', controls: [{ id: 'effort', kind: 'effort', values: ['low', 'high'] }],
      evidence: [{ url: 'https://platform.claude.com/docs/en/build-with-claude/effort', checkedAt: '2026-10-14' }], lastVerified: '2026-10-14' },
      lastAttempt: { at: '2026-10-14T12:00:00Z', outcome: 'verified' } }
    variant.reasoningEvidence = evidence
    return { prior, variant, evidence }
  }

  it('carries the reviewed producer fact through replay, registry response, cache and exact preset projection', async () => {
    const { buildCatalogFromSnapshot } = await import('./modelCatalogSync')
    const source: any = { models: [{ id: 'gpt-6.1-sol', provider: 'openai', name: 'gpt-6.1-sol', displayName: 'Sol',
      source: 'direct', transport: 'direct', connectionId: 'direct:openai', availableConnections: ['direct:openai'],
      idVariants: { 'direct:openai': { developerId: 'openai', modelId: 'gpt-6.1-sol', effectiveId: 'gpt-6.1-sol', source: 'direct' } } }] }
    const published = buildCatalogFromSnapshot(source).payload
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(published), { status: 200 })))
    const cached = await fetchVercelModelCatalog(true)
    const exact = cached.models.find(model => model.idVariants?.['direct:openai']?.effectiveId === 'gpt-6.1-sol')!
    expect(projectCatalogReasoningEvidence(exact, 'direct:openai', 'gpt-6.1-sol')).toEqual({ status: 'supported',
      evidence: reviewedPublicReasoningEvidence('direct:openai', 'gpt-6.1-sol') })
    expect(projectCatalogReasoningEvidence(exact, 'direct:openai', 'gpt-6.1-sol-preview')).toEqual({ status: 'unknown' })
    expect(await readCachedVercelModelCatalog()).toEqual(cached)
  })

  it('retains a direct identity and its facts when only the raw gateway fallback answers', async () => {
    const { prior, variant, evidence } = priorWithReasoning()
    await redis.set('vercel:model_catalog:v1', { models: [prior], fetchedAt: new Date().toISOString() })
    vi.stubGlobal('fetch', vi.fn(async (input: any) => String(input).includes('ai-gateway.vercel.sh')
      ? new Response(JSON.stringify({ data: [{ id: prior.id, name: 'Fresh gateway', context_window: 400000 }] }), { status: 200 })
      : new Response('registry unavailable', { status: 503 })))
    const refreshed = await fetchVercelModelCatalog(true)
    const own = refreshed.models[0].idVariants?.['direct:anthropic']
    expect(own?.reasoningEvidence).toEqual(evidence)
    expect(own?.effectiveId).toBe(variant.effectiveId)
    expect(own?.limits).toEqual({ contextWindow: 200000, maxOutputTokens: null })
    expect(refreshed.models[0].contextWindow).toBe(400000)
    expect((await redis.get('vercel:model_catalog:v1') as any).models[0].idVariants['direct:anthropic'].reasoningEvidence).toEqual(evidence)
  })

  it('adopts a newer reviewed registry default/removal without freezing old local facts', async () => {
    const { prior } = priorWithReasoning()
    const reviewed = structuredClone(prior)
    const record = reviewed.idVariants['direct:anthropic'].reasoningEvidence
    record.lastGood.controls = [{ id: 'effort', kind: 'effort', values: ['high'], defaultValue: 'high' }]
    record.lastAttempt.at = '2026-10-14T13:00:00Z'
    await redis.set('vercel:model_catalog:v1', { models: [prior], fetchedAt: new Date().toISOString() })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [reviewed], fetchedAt: '2026-10-14T13:00:00Z' }), { status: 200 })))
    const result = await fetchVercelModelCatalog(true)
    expect(result.models[0].idVariants?.['direct:anthropic'].reasoningEvidence).toEqual(record)
    expect(prior.idVariants['direct:anthropic'].reasoningEvidence.lastGood.controls[0].values).toEqual(['low', 'high'])
  })

  it('refuses refresh before any loader/write when the prior raw cache read fails', async () => {
    const { prior } = priorWithReasoning()
    await redis.set('vercel:model_catalog:v1', { models: [prior], fetchedAt: new Date().toISOString() })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const reader = vi.spyOn(redis, 'execute').mockRejectedValueOnce(new Error('fixture raw cache read failed'))
    const writer = vi.spyOn(redis, 'set'); writer.mockClear()
    try {
      await expect(fetchVercelModelCatalog(true)).rejects.toThrow('fixture raw cache read failed')
      expect(fetcher).not.toHaveBeenCalled()
      expect(writer).not.toHaveBeenCalled()
    } finally { reader.mockRestore(); writer.mockRestore() }
    expect((await redis.get('vercel:model_catalog:v1') as any).models[0]).toEqual(prior)
  })

  it('reads a valid raw legacy string envelope without rewriting it or parsing a JSON-module object', async () => {
    const { prior, evidence } = priorWithReasoning()
    const envelope = { models: [prior], fetchedAt: new Date().toISOString() }
    // Deliberately construct the legacy Redis STRING, using the raw client rather than JSON.SET.
    await redis.execute(async client => { await client.set('vercel:model_catalog:v1', JSON.stringify(envelope)) })
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await fetchVercelModelCatalog()).models[0].idVariants?.['direct:anthropic'].reasoningEvidence).toEqual(evidence)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await redis.execute(client => client.type('vercel:model_catalog:v1'))).toBe('string')
    expect(await readCachedVercelModelCatalogStamp()).toBe(envelope.fetchedAt)
    expect(await readCachedVercelModelCatalog()).toEqual(envelope)
  })

  it.each(['json', 'string'])('retains %s cache facts after one-hour staleness and failed refresh, without expiry', async storage => {
    const { prior, evidence } = priorWithReasoning()
    const envelope = { models: [prior], fetchedAt: new Date(Date.now() - 7200000).toISOString() }
    if (storage === 'json') await redis.set('vercel:model_catalog:v1', envelope)
    else await redis.execute(client => client.set('vercel:model_catalog:v1', JSON.stringify(envelope)))
    await redis.expire('vercel:model_catalog:v1', 3600)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('temporarily unavailable', { status: 503 })))
    const result = await fetchVercelModelCatalog()
    expect(result.models[0].idVariants?.['direct:anthropic'].reasoningEvidence).toEqual(evidence)
    expect(await redis.ttl('vercel:model_catalog:v1')).toBe(-1)
    expect(await readCachedVercelModelCatalogStamp()).toBe(envelope.fetchedAt)
  })

  it('refreshes a legacy STRING without converting its storage or breaking stamps and send reads', async () => {
    const { prior, evidence } = priorWithReasoning()
    await redis.execute(client => client.set('vercel:model_catalog:v1', JSON.stringify({ models: [prior], fetchedAt: '2026-10-13' })))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [prior], fetchedAt: '2026-10-14T15:00:00Z' }), { status: 200 })))
    await fetchVercelModelCatalog(true)
    expect(await redis.execute(client => client.type('vercel:model_catalog:v1'))).toBe('string')
    expect(await readCachedVercelModelCatalogStamp()).toBe('2026-10-14T15:00:00Z')
    expect((await readCachedVercelModelCatalog())?.models[0].idVariants?.['direct:anthropic'].reasoningEvidence).toEqual(evidence)
    expect(await redis.ttl('vercel:model_catalog:v1')).toBe(-1)
  })

  it('returns the admitted winner when a slow raw fallback loses a concurrent refresh', async () => {
    const { prior } = priorWithReasoning()
    const reviewed = structuredClone(prior)
    reviewed.idVariants['direct:anthropic'].reasoningEvidence.lastAttempt.at = '2026-10-14T15:00:00Z'
    reviewed.idVariants['direct:anthropic'].reasoningEvidence.lastGood.controls = [{ id: 'effort', kind: 'effort', values: ['high'], defaultValue: 'high' }]
    await redis.set('vercel:model_catalog:v1', { models: [prior], fetchedAt: '2026-10-13' })
    let release!: (response: Response) => void
    const slow = new Promise<Response>(resolve => { release = resolve })
    let first = true
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('api.batshit.ai')) {
        if (first) { first = false; entered(); return slow }
        return new Response(JSON.stringify({ models: [reviewed], fetchedAt: '2026-10-14T15:00:00Z' }), { status: 200 })
      }
      if (url.includes('ai-gateway.vercel.sh')) return new Response(JSON.stringify({ data: [{ id: prior.id, name: 'Slow raw result' }] }), { status: 200 })
      return new Response('unavailable', { status: 503 })
    }))
    const pending = fetchVercelModelCatalog(true)
    await started
    const winner = await fetchVercelModelCatalog(true)
    release(new Response('unavailable', { status: 503 }))
    expect(await pending).toEqual(winner)
    expect(await readCachedVercelModelCatalog()).toEqual(winner)
    expect(winner.models[0].idVariants?.['direct:anthropic'].reasoningEvidence.lastGood.controls[0].defaultValue).toBe('high')
  })

  it('throws if the winning cache is unreadable, including the stale-cache fallback path', async () => {
    const { prior } = priorWithReasoning()
    await redis.set('vercel:model_catalog:v1', { models: [prior], fetchedAt: '2026-10-13' })
    let release!: (response: Response) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => { entered(); return new Promise<Response>(resolve => { release = resolve }) }))
    const pending = fetchVercelModelCatalog()
    const rejection = expect(pending).rejects.toThrow('malformed')
    await started
    await redis.execute(client => client.set('vercel:model_catalog:v1', '{"models":false}'))
    release(new Response(JSON.stringify({ models: [prior] }), { status: 200 }))
    await rejection
    expect(await redis.execute(client => client.get('vercel:model_catalog:v1'))).toBe('{"models":false}')
  })

  it.skipIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('executes global raw publication CAS against actual Redis without losing the winner', async () => {
    await redis.execute(async client => {
      const key = 'catalog:v1'
      const original = ' { "models" : [] }\n'
      await client.set(key, original)
      const publish = (expected: string | null, next: string) => client.eval(UPSTASH_COMPARE_AND_SET_SCRIPT,
        { keys: [key], arguments: [expected === null ? 'absent' : 'present', expected ?? '', next] })
      expect(await publish(original, '{"models":["winner"]}')).toBe('OK')
      expect(await publish(original, '{"models":["loser"]}')).toBe('CHANGED')
      expect(await client.get(key)).toBe('{"models":["winner"]}')
      expect(await publish(null, '{}')).toBe('CHANGED')
      await client.del(key)
      expect(await publish(null, '{}')).toBe('OK')
      await client.set(key, '')
      expect(await publish(null, '{}')).toBe('CHANGED')
    })
  })
})

describe('BL-68 findVercelCatalogEntryById through a connection\'s variant', () => {
  beforeEach(async () => {
    await redis.set('vercel:model_catalog:v1', { models: [MERGED_HAIKU], fetchedAt: new Date().toISOString() })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network is not used here')
    }))
  })

  it('finds the merged row for the old id on the exact connection only', async () => {
    expect((await findVercelCatalogEntryById('claude-haiku-4-5-20251001', 'direct:anthropic'))?.id).toBe(
      'anthropic/claude-haiku-4.5'
    )
    expect(await findVercelCatalogEntryById('claude-haiku-4-5-20251001', 'openrouter')).toBeNull()
    expect(await findVercelCatalogEntryById('claude-haiku-4-5-20251001')).toBeNull()
  })

  it('still finds a row by its own id without a connection', async () => {
    expect((await findVercelCatalogEntryById('anthropic/claude-haiku-4.5'))?.id).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('BL-68 the gateway fallback publishes no window it does not know', () => {
  it('leaves maxTokens and the long-context claim out for an unknown window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'acme/mystery-model', name: 'Mystery Model' },
                { id: 'acme/long-model', name: 'Long Model', context_window: 200_000 }
              ]
            }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )

    const catalog = await fetchVercelModelCatalog(true)
    const mystery = catalog.models.find((model) => model.id === 'acme/mystery-model')
    const long = catalog.models.find((model) => model.id === 'acme/long-model')

    expect(mystery?.features).not.toHaveProperty('maxTokens')
    expect(mystery?.features).not.toHaveProperty('longContext')
    expect(long?.features).toMatchObject({ maxTokens: 200_000, longContext: true })
  })
})

describe('BL-131 the gateway fallback keeps a free price and never invents one', () => {
  it('keeps $0, drops a negative or blank price, and converts per-token prices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'acme/model-free', name: 'Free', pricing: { input: '0', output: '0' } },
                { id: 'acme/unmarked', name: 'Unmarked', pricing: { input: '0', output: '0' } },
                { id: 'spacexai/grok-stt', name: 'Grok STT', type: 'transcription', pricing: { input: '0', transcription_duration_cost_per_second: '0.000028' } },
                { id: 'acme/router', name: 'Router', pricing: { input: '-1', output: '-1' } },
                { id: 'acme/blank', name: 'Blank', pricing: { input: '', output: '' } },
                { id: 'acme/paid', name: 'Paid', pricing: { input: '0.000003', output: '0.000015' } },
                { id: 'acme/varies', name: 'Varies', pricing: { input: '0', output: '0', varies_by_provider: true } },
                { id: 'acme/tiny', name: 'Tiny', pricing: { input: '0.0000000001' } }
              ]
            }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )

    const catalog = await fetchVercelModelCatalog(true)
    const byId = (id: string) => catalog.models.find((model) => model.id === id)

    expect(byId('acme/model-free')?.pricing).toEqual({ input: 0, output: 0 })
    // Review finding 1: the gateway marks its free models with -free, and prices
    // grok-stt per second of audio, so neither 0 is a free price.
    expect(byId('acme/unmarked')?.pricing).toBeUndefined()
    expect(byId('spacexai/grok-stt')?.pricing).toBeUndefined()
    expect(byId('acme/router')?.pricing).toBeUndefined()
    expect(byId('acme/blank')?.pricing).toBeUndefined()
    expect(byId('acme/paid')?.pricing).toEqual({ input: 3, output: 15 })
    expect(byId('acme/varies')?.pricing).toBeUndefined()
    expect(byId('acme/tiny')?.pricing).toEqual({ input: 0.0001 })
  })
})

describe('BL-295 the gateway fallback drops a placeholder token price beside a per-second one', () => {
  it('lists no token price for whisper-1 and keeps a token-priced transcription model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'openai/whisper-1', name: 'Whisper', type: 'transcription', pricing: { input: '0.0000000001', transcription_duration_cost_per_second: '0.0001' } },
                { id: 'openai/gpt-4o-transcribe', name: 'GPT-4o Transcribe', type: 'transcription', pricing: { input: '0.0000025', output: '0.00001' } }
              ]
            }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )

    const catalog = await fetchVercelModelCatalog(true)
    const byId = (id: string) => catalog.models.find((model) => model.id === id)
    expect(byId('openai/whisper-1')?.pricing).toBeUndefined()
    expect(byId('openai/gpt-4o-transcribe')?.pricing).toEqual({ input: 2.5, output: 10 })
  })
})

describe('A window of 0 is unknown on the instance side too (new find in the 2026-09-25 bug batch)', () => {
  it('drops a 0 window from the gateway fallback and from a registry that still publishes one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('ai-gateway.vercel.sh')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'mistral/mistral-embed', name: 'Mistral Embed', context_window: 0, max_tokens: 0 }] }),
            { status: 200 }
          )
        }
        return new Response('registry down', { status: 503 })
      })
    )
    const fromGateway = await fetchVercelModelCatalog(true)
    expect(fromGateway.models.find((model) => model.id === 'mistral/mistral-embed')?.contextWindow).toBeUndefined()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('registry')) {
          return new Response(
            JSON.stringify({
              fetchedAt: new Date().toISOString(),
              models: [{ ...MERGED_HAIKU, id: 'mistral/mistral-embed', canonicalId: 'mistral/mistral-embed', contextWindow: 0, maxOutputTokens: 0 }]
            }),
            { status: 200 }
          )
        }
        return new Response('not used', { status: 503 })
      })
    )
    const fromRegistry = await fetchVercelModelCatalog(true)
    const row = fromRegistry.models.find((model) => model.id === 'mistral/mistral-embed')
    expect(row).toBeTruthy()
    expect(row?.contextWindow).toBeUndefined()
    expect(row?.maxOutputTokens).toBeUndefined()
  })
})

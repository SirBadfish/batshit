/**
 * Review finding 2 (2026-09-25 bug batch): BL-241 gave the MiMo Token Plan
 * fallback Xiaomi's own developer namespace, so its rows merged into the
 * `xiaomi/*` rows. A Token Plan preset saved before that says provider `mimo`,
 * and the load repair moves it to `xiaomi`. Its saved baseline (the numbers
 * Restore Defaults returns to, and what the editor compares against to say
 * "provider modified") must move in the same write, or the editor reports a
 * change nobody made and Restore Defaults flips the provider back on every load.
 * Runs the real route and the real catalog module; only Redis is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, any>()
const sets = new Map<string, Set<string>>()
const clone = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => (store.has(key) ? clone(store.get(key)) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, clone(value))
    }),
    expire: vi.fn(async () => 1),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    sAdd: vi.fn(async (key: string, member: string) => {
      if (!sets.has(key)) sets.set(key, new Set())
      sets.get(key)!.add(member)
    }),
    sismember: vi.fn(async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0)),
    sMembers: vi.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    sRem: vi.fn(async (key: string, member: string) => {
      sets.get(key)?.delete(member)
    }),
    json: {
      // The real facade's `JSON.SET … XX`: the load's repair writes only a preset that still exists.
      setIfExists: vi.fn(async (key: string, _path: string, value: unknown) => {
        if (!store.has(key)) return false
        store.set(key, clone(value))
        return true
      })
    }
  }
}))

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: {
    createForUser: vi.fn(async () => ({ listAvailableModels: () => [] }))
  }
}))

const MERGED_MIMO_PRO = {
  id: 'xiaomi/mimo-v2.5-pro',
  canonicalId: 'xiaomi/mimo-v2.5-pro',
  provider: 'xiaomi',
  name: 'mimo-v2.5-pro',
  displayName: 'MiMo V2.5 Pro',
  tags: [],
  features: { streaming: true, tools: true },
  purpose: 'chat',
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'direct:mimo', 'direct:mimo_token_plan'],
  idVariants: {
    'vercel-gateway': { developerId: 'xiaomi', modelId: 'mimo-v2.5-pro', effectiveId: 'xiaomi/mimo-v2.5-pro', source: 'vercel' },
    'direct:mimo': { developerId: 'xiaomi', modelId: 'mimo-v2.5-pro', effectiveId: 'mimo-v2.5-pro', source: 'direct' },
    'direct:mimo_token_plan': { developerId: 'xiaomi', modelId: 'mimo-v2.5-pro', effectiveId: 'mimo-v2.5-pro', source: 'direct' }
  }
}

/** A Token Plan preset saved on the old `mimo/mimo-v2.5-pro` row, baseline included. */
function tokenPlanPreset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'zbmodels_mimo_pro_token_plan',
    modelName: 'MiMo V2.5 Pro (Token Plan)',
    modelId: 'mimo-v2.5-pro',
    provider: 'mimo',
    catalogModelId: 'mimo-v2.5-pro',
    effectiveModelId: 'mimo-v2.5-pro',
    settings: {},
    purpose: 'chat',
    connection: { id: 'direct:mimo_token_plan', type: 'direct', service: 'mimo_token_plan', useDeveloperPrefix: false },
    enrichment: {
      source: 'provider-manager',
      fetchedAt: '2026-09-20T00:00:00.000Z',
      modelName: 'MiMo V2.5 Pro (Token Plan)',
      modelId: 'mimo-v2.5-pro',
      provider: 'mimo',
      connectionId: 'direct:mimo_token_plan',
      identifier: 'mimo-v2.5-pro',
      contextWindow: 1_000_000
    },
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides
  }
}

const routeModule = await import('./+server')

beforeEach(() => {
  store.clear()
  sets.clear()
  store.set('vercel:model_catalog:v1', { models: [MERGED_MIMO_PRO], fetchedAt: new Date().toISOString() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is not used here')
    })
  )
})

async function load() {
  const response = await routeModule.GET({ locals: { user: { id: 'josh' } } } as any)
  expect(response.status).toBe(200)
  return (await response.json()).models.find((model: any) => model.id === 'zbmodels_mimo_pro_token_plan')
}

describe('review finding 2: a repaired preset\'s baseline moves with it', () => {
  it('moves the provider and its saved baseline to xiaomi in the same write', async () => {
    store.set('model:zbmodels_mimo_pro_token_plan', tokenPlanPreset())
    sets.set('user:josh:models', new Set(['zbmodels_mimo_pro_token_plan']))

    const loaded = await load()

    expect(loaded).toMatchObject({ provider: 'xiaomi', catalogModelId: 'xiaomi/mimo-v2.5-pro' })
    expect(loaded.enrichment).toMatchObject({ provider: 'xiaomi', modelId: 'mimo-v2.5-pro', identifier: 'mimo-v2.5-pro' })
    expect(store.get('model:zbmodels_mimo_pro_token_plan').enrichment.provider).toBe('xiaomi')
    // Nothing else in the baseline moves.
    expect(loaded.enrichment.contextWindow).toBe(1_000_000)
  })

  it('is stable: the next load changes nothing', async () => {
    store.set('model:zbmodels_mimo_pro_token_plan', tokenPlanPreset())
    sets.set('user:josh:models', new Set(['zbmodels_mimo_pro_token_plan']))
    await load()

    const response = await routeModule.GET({ locals: { user: { id: 'josh' } } } as any)
    const body = await response.json()
    expect(body.meta.identityBackfilledCount).toBe(0)
  })

  it('leaves a baseline that recorded something else alone', async () => {
    store.set(
      'model:zbmodels_mimo_pro_token_plan',
      tokenPlanPreset({ enrichment: { ...tokenPlanPreset().enrichment, provider: 'someone-else' } })
    )
    sets.set('user:josh:models', new Set(['zbmodels_mimo_pro_token_plan']))

    const loaded = await load()

    expect(loaded.provider).toBe('xiaomi')
    expect(loaded.enrichment.provider).toBe('someone-else')
  })
})

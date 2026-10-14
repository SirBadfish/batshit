/**
 * BL-68: after the reviewed identity rule merges Anthropic's dated
 * `claude-haiku-4-5-20251001` row into `anthropic/claude-haiku-4.5`, a preset
 * saved on the old row still names the old row's id. Its next save must not be
 * refused as "no longer available", and a load repairs its catalog id. The
 * match is exact: the preset's own connection and that connection's variant id.
 * Runs the real routes and the real catalog module; only Redis is faked.
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
      setIfExists: vi.fn(async (key: string, _path: string, value: unknown) => {
        if (!store.has(key)) return false
        store.set(key, clone(value))
        return true
      })
    }
  }
}))

/** BL-516: a save that names an id updates a preset the user already has. */
function seedSaved(preset: Record<string, any>) {
  store.set(`model:${preset.id}`, preset)
  if (!sets.has('user:josh:models')) sets.set('user:josh:models', new Set())
  sets.get('user:josh:models')!.add(preset.id)
}

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: {
    createForUser: vi.fn(async () => ({ listAvailableModels: () => [] }))
  }
}))

const MERGED_HAIKU = {
  id: 'anthropic/claude-haiku-4.5',
  canonicalId: 'anthropic/claude-haiku-4.5',
  provider: 'anthropic',
  name: 'claude-haiku-4.5',
  displayName: 'Claude Haiku 4.5',
  tags: [],
  features: { streaming: true, tools: true },
  purpose: 'chat',
  contextWindow: 200_000,
  pricing: { input: 1, output: 5, cachedInput: 0.1 },
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'direct:anthropic'],
  idVariants: {
    'vercel-gateway': {
      developerId: 'anthropic',
      modelId: 'claude-haiku-4.5',
      effectiveId: 'anthropic/claude-haiku-4.5',
      source: 'vercel'
    },
    'direct:anthropic': {
      developerId: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      effectiveId: 'claude-haiku-4-5-20251001',
      source: 'direct',
      limits: { contextWindow: null, maxOutputTokens: null }
    }
  }
}

/** A preset saved on the dated row before the merge. */
function oldPreset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'zb_haiku_45_direct',
    modelName: 'Claude Haiku 4.5 (Direct)',
    modelId: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    catalogModelId: 'claude-haiku-4-5-20251001',
    effectiveModelId: 'claude-haiku-4-5-20251001',
    pricing: { input: 1, output: 5 },
    settings: {},
    purpose: 'chat',
    connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic', useDeveloperPrefix: false },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

const routeModule = await import('./+server')

beforeEach(() => {
  store.clear()
  sets.clear()
  // A fresh cached catalog, so the real loader never reaches the network.
  store.set('vercel:model_catalog:v1', { models: [MERGED_HAIKU], fetchedAt: new Date().toISOString() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is not used here')
    })
  )
})

describe('BL-68 presets saved on a dated row that merged away', () => {
  it('saves again, and the save points the preset at the merged row', async () => {
    seedSaved(oldPreset())
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/user/saved-models', {
        method: 'POST',
        body: JSON.stringify(oldPreset())
      }),
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(200)
    const saved = store.get('model:zb_haiku_45_direct')
    expect(saved).toMatchObject({
      catalogModelId: 'anthropic/claude-haiku-4.5',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      effectiveModelId: 'claude-haiku-4-5-20251001'
    })
  })

  it('matches only through the preset\'s own connection', async () => {
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/user/saved-models', {
        method: 'POST',
        body: JSON.stringify(
          oldPreset({ connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter', useDeveloperPrefix: false } })
        )
      }),
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(400)
  })

  it('repairs the catalog id on load', async () => {
    store.set('model:zb_haiku_45_direct', oldPreset())
    sets.set('user:josh:models', new Set(['zb_haiku_45_direct']))

    const response = await routeModule.GET({ locals: { user: { id: 'josh' } } } as any)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meta.identityBackfilledCount).toBe(1)
    expect(store.get('model:zb_haiku_45_direct')).toMatchObject({
      catalogModelId: 'anthropic/claude-haiku-4.5',
      effectiveModelId: 'claude-haiku-4-5-20251001'
    })
  })
})

describe('BL-292 / BL-293 a Moonshot preset whose row merged into moonshotai/kimi-k3', () => {
  const MERGED_KIMI = {
    id: 'moonshotai/kimi-k3',
    canonicalId: 'moonshotai/kimi-k3',
    provider: 'moonshotai',
    name: 'kimi-k3',
    displayName: 'Kimi K3',
    tags: ['reasoning'],
    features: { streaming: true, tools: true, vision: true, reasoning: true },
    purpose: 'chat',
    source: 'vercel',
    transport: 'vercel-gateway',
    connectionId: 'vercel-gateway',
    availableConnections: ['vercel-gateway', 'direct:moonshot'],
    idVariants: {
      'vercel-gateway': { developerId: 'moonshotai', modelId: 'kimi-k3', effectiveId: 'moonshotai/kimi-k3', source: 'vercel' },
      'direct:moonshot': { developerId: 'moonshot', modelId: 'kimi-k3', effectiveId: 'kimi-k3', source: 'direct' }
    }
  }

  it('keeps the merged row\'s catalog details on the next save', async () => {
    store.set('vercel:model_catalog:v1', { models: [MERGED_KIMI], fetchedAt: new Date().toISOString() })
    const kimiPreset = oldPreset({
      id: 'zc_kimi_k3_moonshot',
      modelName: 'Kimi K3 (Moonshot)',
      modelId: 'kimi-k3',
      provider: 'moonshot',
      catalogModelId: 'kimi-k3',
      effectiveModelId: 'kimi-k3',
      connection: { id: 'direct:moonshot', type: 'direct', service: 'moonshot', useDeveloperPrefix: false }
    })
    seedSaved(kimiPreset)
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/user/saved-models', {
        method: 'POST',
        body: JSON.stringify(kimiPreset)
      }),
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(200)
    expect(store.get('model:zc_kimi_k3_moonshot')).toMatchObject({
      catalogModelId: 'moonshotai/kimi-k3',
      effectiveModelId: 'kimi-k3',
      vercelDisplayName: 'Kimi K3',
      capabilities: expect.objectContaining({ reasoning: true, vision: true })
    })
  })
})

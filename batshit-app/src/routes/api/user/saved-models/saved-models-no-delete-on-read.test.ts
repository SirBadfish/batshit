/**
 * BL-517: loading the preset list never deletes a preset.
 *
 * Every GET of `/api/user/saved-models` used to delete each AI Gateway preset whose gateway id
 * was not an exact current gateway row id, before the BL-68 lookup that finds a renamed or merged
 * row, and whether or not an agent used it; the agent's next send then failed with "model preset
 * no longer exists". Now the GET deletes nothing: a preset whose model the gateway no longer
 * lists stays, and the answer marks it unavailable (the pickers' existing unavailable state); a
 * preset whose row was renamed is found through its gateway variant and repaired as before.
 * Runs the real route and the real catalog module; only Redis is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, any>()
const sets = new Map<string, Set<string>>()
const clone = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

const redisMock = vi.hoisted(() => ({}) as Record<string, any>)

vi.mock('$lib/server/redis', () => ({ redis: redisMock }))

Object.assign(redisMock, {
  get: vi.fn(async (key: string) => (store.has(key) ? clone(store.get(key)) : null)),
  set: vi.fn(async (key: string, value: unknown) => {
    store.set(key, clone(value))
  }),
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
    // The real facade's `JSON.SET … XX`: writes only while the key exists.
    setIfExists: vi.fn(async (key: string, _path: string, value: unknown) => {
      if (!store.has(key)) return false
      store.set(key, clone(value))
      return true
    }),
    // The real facade's `JSON.SET … NX`: a create writes only while the key does not exist.
    setIfAbsent: vi.fn(async (key: string, _path: string, value: unknown) => {
      if (store.has(key)) return false
      store.set(key, clone(value))
      return true
    })
  }
})

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: {
    createForUser: vi.fn(async () => ({ listAvailableModels: () => [] }))
  }
}))

/** The gateway's `alibaba/qwen3-max`, now a variant of the merged `qwen/qwen3-max` row. */
const MERGED_QWEN = {
  id: 'qwen/qwen3-max',
  canonicalId: 'qwen/qwen3-max',
  provider: 'qwen',
  name: 'qwen3-max',
  displayName: 'Qwen3 Max',
  tags: [],
  features: { streaming: true, tools: true },
  purpose: 'chat',
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway', 'openrouter'],
  idVariants: {
    'vercel-gateway': { developerId: 'alibaba', modelId: 'qwen3-max', effectiveId: 'alibaba/qwen3-max', source: 'vercel' },
    openrouter: { developerId: 'qwen', modelId: 'qwen3-max', effectiveId: 'qwen/qwen3-max', source: 'openrouter' }
  }
}

const LISTED_SONNET = {
  id: 'anthropic/claude-sonnet-5',
  canonicalId: 'anthropic/claude-sonnet-5',
  provider: 'anthropic',
  name: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  tags: [],
  features: { streaming: true, tools: true },
  purpose: 'chat',
  source: 'vercel',
  transport: 'vercel-gateway',
  connectionId: 'vercel-gateway',
  availableConnections: ['vercel-gateway'],
  idVariants: {
    'vercel-gateway': {
      developerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      effectiveId: 'anthropic/claude-sonnet-5',
      source: 'vercel'
    }
  }
}

/** Only OpenRouter still serves this one: the gateway dropped it. */
const OPENROUTER_ONLY_OLD = {
  id: 'openai/gpt-4.1-old',
  canonicalId: 'openai/gpt-4.1-old',
  provider: 'openai',
  name: 'gpt-4.1-old',
  displayName: 'GPT-4.1 Old',
  tags: [],
  features: { streaming: true, tools: true },
  purpose: 'chat',
  source: 'openrouter',
  transport: 'openrouter',
  connectionId: 'openrouter',
  availableConnections: ['openrouter'],
  idVariants: {
    openrouter: { developerId: 'openai', modelId: 'gpt-4.1-old', effectiveId: 'openai/gpt-4.1-old', source: 'openrouter' }
  }
}

function gatewayPreset(id: string, gatewayId: string, overrides: Record<string, unknown> = {}) {
  const [developer, ...rest] = gatewayId.split('/')
  return {
    id,
    modelName: `Preset ${id}`,
    provider: developer,
    modelId: rest.join('/'),
    catalogModelId: gatewayId,
    effectiveModelId: gatewayId,
    vercelSourceId: gatewayId,
    isVercelImport: true,
    pricing: { input: 1, output: 2 },
    settings: { temperature: 0.3 },
    purpose: 'chat',
    connection: { type: 'vercel-gateway', service: 'vercel' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

const routeModule = await import('./+server')

function seed(preset: ReturnType<typeof gatewayPreset>) {
  store.set(`model:${preset.id}`, preset)
  if (!sets.has('user:josh:models')) sets.set('user:josh:models', new Set())
  sets.get('user:josh:models')!.add(preset.id)
}

async function listPresets() {
  const response = await routeModule.GET({ locals: { user: { id: 'josh' } } } as any)
  expect(response.status).toBe(200)
  return (await response.json()) as { models: any[]; meta: Record<string, any> }
}

beforeEach(() => {
  store.clear()
  sets.clear()
  vi.clearAllMocks()
  // A fresh cached catalog, so the real loader never reaches the network.
  store.set('vercel:model_catalog:v1', {
    models: [MERGED_QWEN, LISTED_SONNET, OPENROUTER_ONLY_OLD],
    fetchedAt: new Date().toISOString()
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is not used here')
    })
  )
})

describe('BL-517: loading the preset list never deletes a preset', () => {
  it('keeps a gateway preset the gateway no longer lists, and marks it unavailable in the answer only', async () => {
    const retired = gatewayPreset('zm_retired_gpt', 'openai/gpt-4.1-old', { settings: { temperature: 1.1, customKnob: 7 } })
    seed(retired)
    // An agent uses it; the old load deleted it anyway.
    store.set('agent:zm_agent', { id: 'zm_agent', user_id: 'josh', primary_model_preset_id: retired.id })

    const body = await listPresets()

    expect(redisMock.del).not.toHaveBeenCalled()
    expect(redisMock.sRem).not.toHaveBeenCalled()
    // The preset and its custom settings are still stored, and still the user's.
    expect(store.get('model:zm_retired_gpt')).toMatchObject({ settings: { temperature: 1.1, customKnob: 7 } })
    expect(sets.get('user:josh:models')?.has('zm_retired_gpt')).toBe(true)

    const listed = body.models.find((model) => model.id === 'zm_retired_gpt')
    expect(listed).toBeDefined()
    expect(listed.unavailableReason).toBe('Vercel AI Gateway no longer lists this model')
    expect(body.meta.unlisted).toEqual([{ id: 'zm_retired_gpt', modelName: 'Preset zm_retired_gpt' }])
    // The mark is never written into the stored preset.
    expect(store.get('model:zm_retired_gpt').unavailableReason).toBeUndefined()
  })

  it('finds a preset whose gateway row was renamed through its gateway variant, and repairs it instead of deleting it', async () => {
    seed(gatewayPreset('zm_qwen_max', 'alibaba/qwen3-max'))

    const body = await listPresets()

    expect(redisMock.del).not.toHaveBeenCalled()
    const stored = store.get('model:zm_qwen_max')
    expect(stored).toMatchObject({
      catalogModelId: 'qwen/qwen3-max',
      effectiveModelId: 'alibaba/qwen3-max',
      settings: { temperature: 0.3 }
    })
    const listed = body.models.find((model) => model.id === 'zm_qwen_max')
    expect(listed.unavailableReason).toBeUndefined()
    expect(body.meta.unlisted).toEqual([])
  })

  it('a preset deleted while the load repairs it is not made again (review)', async () => {
    seed(gatewayPreset('zm_qwen_max', 'alibaba/qwen3-max'))
    // The delete lands between the load's read of the preset and its repair write.
    const read = redisMock.get.getMockImplementation()!
    redisMock.get.mockImplementation(async (key: string) => {
      const answer = await read(key)
      if (key === 'model:zm_qwen_max') store.delete(key)
      return answer
    })

    const body = await listPresets()

    expect(store.has('model:zm_qwen_max')).toBe(false)
    expect(body.models.map((model) => model.id)).not.toContain('zm_qwen_max')
    redisMock.get.mockImplementation(read)
  })

  it('a listed gateway preset stays available (control)', async () => {
    seed(gatewayPreset('zm_sonnet', 'anthropic/claude-sonnet-5'))

    const body = await listPresets()

    expect(body.models.map((model) => model.id)).toEqual(['zm_sonnet'])
    expect(body.models[0].unavailableReason).toBeUndefined()
    expect(body.meta.unlisted).toEqual([])
  })

  it('a save never stores the answer-only mark', async () => {
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/user/saved-models', {
        method: 'POST',
        body: JSON.stringify({
          ...gatewayPreset('zm_sonnet_save', 'anthropic/claude-sonnet-5'),
          id: '',
          unavailableReason: 'Vercel AI Gateway no longer lists this model'
        })
      }),
      locals: { user: { id: 'josh' } }
    } as any)
    expect(response.status).toBe(200)
    const { model } = await response.json()
    expect(store.get(`model:${model.id}`).unavailableReason).toBeUndefined()
  })
})

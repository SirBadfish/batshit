/**
 * BL-516: a create never replaces a saved preset.
 *
 * "Use to Create New Preset" sends a preset with no id, and the server builds the id from the
 * display name, model, and connection. A second create from the same catalog model therefore
 * built the SAME id and the POST wrote over the first preset: its custom temperature and
 * parameters were gone, every agent on it now ran the reset copy, and the toast said "Model
 * preset created". Now a create whose id is already saved is refused (409) with a sentence the
 * panel shows; an update names its id and only writes a preset that is still there.
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
      // The real facade's `JSON.SET … NX`: writes only while the key does not exist.
      setIfAbsent: vi.fn(async (key: string, _path: string, value: unknown) => {
        if (store.has(key)) return false
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

const SONNET_ROW = {
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

/** What the panel's "Use to Create New Preset" sends: the catalog name and no id. */
function catalogCreatePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: '',
    modelName: 'Claude Sonnet 5',
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    catalogModelId: 'anthropic/claude-sonnet-5',
    effectiveModelId: 'anthropic/claude-sonnet-5',
    isVercelImport: true,
    vercelSourceId: 'anthropic/claude-sonnet-5',
    pricing: { input: 3, output: 15 },
    settings: { temperature: 1 },
    connection: { type: 'vercel-gateway', service: 'vercel' },
    ...overrides
  }
}

const routeModule = await import('./+server')

async function post(body: Record<string, unknown>) {
  const response = await routeModule.POST({
    request: new Request('http://localhost/api/user/saved-models', { method: 'POST', body: JSON.stringify(body) }),
    locals: { user: { id: 'josh' } }
  } as any)
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  store.clear()
  sets.clear()
  store.set('vercel:model_catalog:v1', { models: [SONNET_ROW], fetchedAt: new Date().toISOString() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is not used here')
    })
  )
})

describe('BL-516: a create never replaces a saved preset', () => {
  it('refuses a second create from the same catalog model, and the first preset keeps its settings', async () => {
    const first = await post(catalogCreatePayload())
    expect(first.status).toBe(200)
    const id = first.body.model.id as string

    // The user tunes the first preset (an update names its id).
    const tuned = await post({ ...first.body.model, settings: { temperature: 0.2, customKnob: 5 } })
    expect(tuned.status).toBe(200)

    // "Use to Create New Preset" again on the same catalog model.
    const second = await post(catalogCreatePayload())
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({
      code: 'model_preset_exists',
      error: 'A model preset with that name already exists: "Claude Sonnet 5". Choose a different display name.'
    })
    expect(store.get(`model:${id}`).settings).toEqual({ temperature: 0.2, customKnob: 5 })
    expect(Array.from(sets.get('user:josh:models') ?? [])).toEqual([id])
  })

  it('two creates of the same id at the same moment: one is made, the other is refused (atomic create)', async () => {
    const [first, second] = await Promise.all([
      post(catalogCreatePayload({ settings: { temperature: 0.2 } })),
      post(catalogCreatePayload({ settings: { temperature: 0.9 } }))
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    const made = first.status === 200 ? first : second
    expect(store.get(`model:${made.body.model.id}`).settings).toEqual(made.body.model.settings)
  })

  it('names the saved preset by its current name after a rename, since its id keeps the first name', async () => {
    const first = await post(catalogCreatePayload())
    const renamed = await post({ ...first.body.model, modelName: 'Sonnet for writing' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.model.id).toBe(first.body.model.id)

    const second = await post(catalogCreatePayload())
    expect(second.status).toBe(409)
    expect(second.body.error).toBe(
      'A model preset with that name already exists: "Sonnet for writing". Choose a different display name.'
    )
    expect(store.get(`model:${first.body.model.id}`).modelName).toBe('Sonnet for writing')
  })

  it('creates a second preset of the same model under another display name', async () => {
    const first = await post(catalogCreatePayload())
    const second = await post(catalogCreatePayload({ modelName: 'Claude Sonnet 5 (cold)', settings: { temperature: 0 } }))
    expect(second.status).toBe(200)
    expect(second.body.model.id).not.toBe(first.body.model.id)
    expect(store.get(`model:${second.body.model.id}`).settings).toEqual({ temperature: 0 })
    expect(store.get(`model:${first.body.model.id}`).settings).toEqual({ temperature: 1 })
  })

  it('an update to a preset that is gone is refused and makes nothing', async () => {
    const response = await post(catalogCreatePayload({ id: 'claude_sonnet_5_deleted_elsewhere' }))
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'model_preset_missing' })
    expect(store.has('model:claude_sonnet_5_deleted_elsewhere')).toBe(false)
    expect(sets.get('user:josh:models')?.has('claude_sonnet_5_deleted_elsewhere') ?? false).toBe(false)
  })

  it('an update never writes a stored preset that is not in the user\'s list', async () => {
    store.set('model:someone_elses_preset', { id: 'someone_elses_preset', modelName: 'Not yours', settings: { temperature: 0.9 } })
    const response = await post(catalogCreatePayload({ id: 'someone_elses_preset' }))
    expect(response.status).toBe(404)
    expect(store.get('model:someone_elses_preset')).toMatchObject({ modelName: 'Not yours', settings: { temperature: 0.9 } })
  })

  it('a preset deleted between the update\'s check and its write is not made again', async () => {
    const first = await post(catalogCreatePayload())
    const id = first.body.model.id as string
    const { redis } = await import('$lib/server/redis')
    // The delete lands after the ownership check: the write must not bring the preset back.
    vi.mocked(redis.sismember).mockImplementationOnce(async () => {
      store.delete(`model:${id}`)
      return 1 as any
    })
    const response = await post({ ...first.body.model, settings: { temperature: 0.5 } })
    expect(response.status).toBe(404)
    expect(store.has(`model:${id}`)).toBe(false)
  })
})

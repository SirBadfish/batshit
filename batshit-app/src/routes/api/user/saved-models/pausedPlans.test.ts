/** Plan pause: a model of a paused plan cannot be added or saved. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  json: { get: vi.fn(async () => null) },
  set: vi.fn(),
  sAdd: vi.fn(),
  sismember: vi.fn(async () => false),
  exists: vi.fn(async () => 0),
  del: vi.fn()
}))
const testEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>)

vi.mock('$env/dynamic/private', () => ({ env: testEnv }))
vi.mock('$lib/server/redis', () => ({ redis: redisMock }))
vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: { createForUser: vi.fn(async () => ({ listAvailableModels: () => [] })) }
}))
vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: vi.fn(),
  findVercelCatalogEntry: vi.fn(),
  findVercelCatalogEntryById: vi.fn()
}))

describe('POST /api/user/saved-models and paused plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(testEnv)) delete testEnv[key]
  })

  it('refuses a model of a paused plan with the plain sentence and saves nothing', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: new Request('http://localhost/api/user/saved-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'zcpause-model',
          modelId: 'qwen3.8-max',
          modelName: 'zcpause',
          provider: 'qwen',
          pricing: {},
          connection: { id: 'direct:qwen_token_plan', type: 'direct', service: 'qwen_token_plan' }
        })
      }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'paused_plan',
      error:
        'Qwen Token Plan is paused: Alibaba Cloud does not list Batshit as an allowed tool yet. ' +
        "Alibaba Cloud's normal pay-as-you-go connection (Qwen Cloud) works."
    })
    expect(redisMock.set).not.toHaveBeenCalled()
    expect(redisMock.sAdd).not.toHaveBeenCalled()
  })
})

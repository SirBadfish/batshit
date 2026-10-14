import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  getAgents: vi.fn(),
  sMembers: vi.fn(async () => []),
  getUserSettings: vi.fn(async () => null),
  json: { get: vi.fn(async () => null) },
  del: vi.fn(),
  sRem: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: {
    createForUser: vi.fn()
  }
}))

vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: vi.fn(),
  findVercelCatalogEntry: vi.fn(),
  findVercelCatalogEntryById: vi.fn()
}))

describe('DELETE /api/user/saved-models', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.getAgents.mockResolvedValue([])
    redisMock.del.mockResolvedValue(undefined)
    redisMock.sRem.mockResolvedValue(undefined)
  })

  it('blocks deleting a model preset while an agent still references it', async () => {
    redisMock.getAgents.mockResolvedValue([
      {
        id: 'agent-1',
        displayName: 'Ava',
        primary_model_preset_id: 'model-1'
      }
    ])

    const { DELETE } = await import('./+server')
    const response = await DELETE({
      url: new URL('http://localhost/api/user/saved-models?id=model-1'),
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(409)
    expect(payload.code).toBe('model_preset_in_use')
    expect(payload.dependencies.references).toEqual([
      {
        kind: 'agent_model',
        ownerId: 'agent-1',
        label: "Ava's model"
      }
    ])
    expect(payload.error).toBe(
      "This model preset is still used by Ava's model. Pick a different model in each of those places before deleting it."
    )
    expect(redisMock.del).not.toHaveBeenCalled()
  })

  it('deletes an unreferenced model preset', async () => {
    const { DELETE } = await import('./+server')
    const response = await DELETE({
      url: new URL('http://localhost/api/user/saved-models?id=model-2'),
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.success).toBe(true)
    expect(redisMock.del).toHaveBeenCalledWith('model:model-2')
    expect(redisMock.sRem).toHaveBeenCalledWith('user:user-1:models', 'model-2')
  })
})

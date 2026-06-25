import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  getAgents: vi.fn(),
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
    expect(payload.dependencies.agents).toEqual([
      {
        agentId: 'agent-1',
        agentName: 'Ava',
        field: 'primary'
      }
    ])
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

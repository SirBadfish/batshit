import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  sMembers: vi.fn(),
  get: vi.fn()
}))

const customProviderMocks = vi.hoisted(() => ({
  deleteCustomProvider: vi.fn(),
  listCustomProviders: vi.fn(),
  upsertCustomProvider: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$lib/server/services/customProviders', () => ({
  deleteCustomProvider: customProviderMocks.deleteCustomProvider,
  listCustomProviders: customProviderMocks.listCustomProviders,
  upsertCustomProvider: customProviderMocks.upsertCustomProvider
}))

describe('DELETE /api/settings/custom-providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.sMembers.mockResolvedValue([])
    redisMock.get.mockResolvedValue(null)
    customProviderMocks.deleteCustomProvider.mockResolvedValue(undefined)
  })

  it('blocks deleting a custom provider while saved model presets reference it', async () => {
    redisMock.sMembers.mockResolvedValue(['model-1'])
    redisMock.get.mockResolvedValue({
      id: 'model-1',
      modelName: 'Custom GPT',
      modelId: 'gpt-custom',
      provider: 'openai',
      connection: {
        type: 'direct',
        service: 'custom_acme'
      }
    })

    const { DELETE } = await import('./+server')
    const response = await DELETE({
      request: new Request('http://localhost/api/settings/custom-providers', {
        method: 'DELETE',
        body: JSON.stringify({ id: 'custom_acme' })
      }),
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(409)
    expect(payload.code).toBe('custom_provider_in_use')
    expect(payload.dependencies.models).toEqual([
      {
        modelId: 'model-1',
        modelName: 'Custom GPT'
      }
    ])
    expect(customProviderMocks.deleteCustomProvider).not.toHaveBeenCalled()
  })

  it('deletes an unreferenced custom provider', async () => {
    const { DELETE } = await import('./+server')
    const response = await DELETE({
      request: new Request('http://localhost/api/settings/custom-providers', {
        method: 'DELETE',
        body: JSON.stringify({ id: 'custom_acme' })
      }),
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.success).toBe(true)
    expect(customProviderMocks.deleteCustomProvider).toHaveBeenCalledWith('user-1', 'custom_acme')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveProviderAccess: vi.fn(),
  redisExecute: vi.fn(),
  redisSMembers: vi.fn(),
  getAgents: vi.fn(),
  getUserSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  invalidateUserSettingsCache: vi.fn()
}))

vi.mock('$lib/server/services/providers', () => ({
  resolveProviderAccess: mocks.resolveProviderAccess
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: mocks.redisExecute,
    getAgents: mocks.getAgents,
    getUserSettings: mocks.getUserSettings,
    updateUserSettings: mocks.updateUserSettings
  }
}))

vi.mock('$lib/services/databaseRedis.server', () => ({
  invalidateUserSettingsCache: mocks.invalidateUserSettingsCache
}))

function providerAccess(
  ready: Record<string, 'user' | 'env'> = {},
  gatewaySource: 'user' | 'env' | null = null
) {
  const providerIds = [
    'anthropic',
    'openai',
    'google',
    'mistral',
    'groq',
    'xai',
    'deepseek',
    'moonshot',
    'minimax',
    'mimo',
    'qwencloud',
    'alibaba',
    'stepfun',
    'zai',
    'zai_coding',
    'openrouter',
    'deepinfra',
    'togetherai',
    'fireworks',
    'baseten',
    'cerebras'
  ]

  return {
    availability: Object.fromEntries(
      providerIds.map((id) => [
        id,
        {
          hasKey: Boolean(ready[id]),
          source: ready[id] ?? null
        }
      ])
    ),
    gateway: {
      availability: {
        hasKey: Boolean(gatewaySource),
        source: gatewaySource
      }
    }
  }
}

describe('/api/onboarding/status', () => {
  let routeModule: typeof import('./+server')

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.redisExecute.mockImplementation((callback: (client: { sMembers: typeof mocks.redisSMembers }) => unknown) =>
      callback({ sMembers: mocks.redisSMembers })
    )
    mocks.redisSMembers.mockResolvedValue([])
    mocks.getAgents.mockResolvedValue([])
    mocks.getUserSettings.mockResolvedValue({
      id: 'settings-user-1',
      user_id: 'user-1',
      created_at: '2026-06-22T00:00:00.000Z',
      updated_at: '2026-06-22T00:00:00.000Z'
    })
    mocks.updateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, unknown>) => ({
      id: 'settings-user-1',
      user_id: 'user-1',
      ...updates,
      created_at: '2026-06-22T00:00:00.000Z',
      updated_at: '2026-06-22T00:00:01.000Z'
    }))
    mocks.resolveProviderAccess.mockResolvedValue(providerAccess())
    routeModule = await import('./+server')
  })

  it('shows onboarding for a new instance that has no model presets or agents', async () => {
    mocks.resolveProviderAccess.mockResolvedValue(providerAccess({ openai: 'user' }))

    const response = await routeModule.GET({
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.apiKeys).toMatchObject({
      readyCount: 1,
      readyKeys: [{ id: 'openai', label: 'OpenAI', source: 'user' }]
    })
    expect(payload.modelPresets.count).toBe(0)
    expect(payload.agents.count).toBe(0)
    expect(payload.onboarding.shouldShow).toBe(true)
  })

  it('does not show onboarding for an already configured instance without a legacy finish marker', async () => {
    mocks.redisSMembers.mockResolvedValue(['model-1'])
    mocks.getAgents.mockResolvedValue([{ id: 'agent-1', displayName: 'Ava' }])

    const response = await routeModule.GET({
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.onboarding.finished).toBe(false)
    expect(payload.onboarding.shouldShow).toBe(false)
  })

  it('marks onboarding complete and preserves existing onboarding metadata', async () => {
    let storedSettings: Record<string, any> = {
      id: 'settings-user-1',
      user_id: 'user-1',
      onboarding_settings: {
        last_seen_step: 'models'
      },
      created_at: '2026-06-22T00:00:00.000Z',
      updated_at: '2026-06-22T00:00:00.000Z'
    }
    mocks.getUserSettings.mockImplementation(async () => storedSettings)
    mocks.updateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, unknown>) => {
      storedSettings = {
        ...storedSettings,
        ...updates,
        updated_at: '2026-06-22T00:00:01.000Z'
      }
      return storedSettings
    })

    const response = await routeModule.POST({
      request: new Request('http://localhost/api/onboarding/status', {
        method: 'POST',
        body: JSON.stringify({ action: 'complete' })
      }),
      locals: { user: { id: 'user-1' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.updateUserSettings).toHaveBeenCalledWith('user-1', {
      onboarding_settings: expect.objectContaining({
        last_seen_step: 'models',
        setup_completed_at: expect.any(String),
        setup_skipped_at: null
      })
    })
    expect(mocks.invalidateUserSettingsCache).toHaveBeenCalledWith('user-1')
    expect(payload.settings.onboarding_settings.last_seen_step).toBe('models')
    expect(payload.status.onboarding.finished).toBe(true)
  })
})

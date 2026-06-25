import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redisPing: vi.fn(),
  checkCoreSystemPromptDefaults: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    ping: mocks.redisPing
  }
}))

vi.mock('$lib/server/services/systemPromptRegistry', () => ({
  checkCoreSystemPromptDefaults: mocks.checkCoreSystemPromptDefaults
}))

import { GET } from './+server'

describe('/api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.redisPing.mockResolvedValue('PONG')
    mocks.checkCoreSystemPromptDefaults.mockResolvedValue({
      ready: true,
      count: 8,
      missing: []
    })
  })

  it('reports healthy when Redis and packaged prompt defaults are ready', async () => {
    const response = await GET({} as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checks: {
        redis: true,
        systemPromptDefaults: true
      },
      systemPromptDefaults: {
        ready: true,
        count: 8,
        missing: []
      }
    })
  })

  it('fails health when packaged prompt defaults are missing', async () => {
    mocks.checkCoreSystemPromptDefaults.mockResolvedValue({
      ready: false,
      count: 8,
      missing: ['batshit_primary_agent_api_system_prompt.md']
    })

    const response = await GET({} as any)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: {
        redis: true,
        systemPromptDefaults: false
      },
      systemPromptDefaults: {
        ready: false,
        missing: ['batshit_primary_agent_api_system_prompt.md']
      }
    })
  })

  it('fails health with a clear Redis error when Redis ping fails', async () => {
    mocks.redisPing.mockRejectedValue(new Error('Redis connection refused'))

    const response = await GET({} as any)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      service: 'batshit-app',
      checks: {
        http: true,
        redis: false,
        systemPromptDefaults: false
      },
      error: 'Redis connection refused'
    })
  })
})

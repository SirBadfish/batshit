import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiKeyService = {
  retrieve: vi.fn()
}

const dynamicPrivateEnv = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService
}))

vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)

describe('/api/settings/api-keys/retrieve runtime-managed keys', () => {
  let routeModule: typeof import('./+server')

  beforeEach(async () => {
    vi.clearAllMocks()
    for (const key of Object.keys(dynamicPrivateEnv.env)) {
      delete dynamicPrivateEnv.env[key]
    }
    routeModule = await import('./+server')
  })

  it('returns the Docker runtime BATSHIT_TOKEN for the logged-in user', async () => {
    dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'docker-runtime-token-7890'

    const request = new Request('http://localhost/api/settings/api-keys/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'batshit_token' })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      success: true,
      apiKey: 'docker-runtime-token-7890',
      managedByRuntime: true
    })
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })

  it('returns the Mac runtime BATSHIT_TOKEN for the logged-in user', async () => {
    dynamicPrivateEnv.env.BATSHIT_RUNTIME_OWNER = 'mac-app'
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'mac-runtime-token-2468'

    const request = new Request('http://localhost/api/settings/api-keys/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'batshit_token' })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      success: true,
      apiKey: 'mac-runtime-token-2468',
      managedByRuntime: true
    })
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })

  it('returns the source runtime BATSHIT_TOKEN for the logged-in user', async () => {
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'source-runtime-token-1357'

    const request = new Request('http://localhost/api/settings/api-keys/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'batshit_token' })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      success: true,
      apiKey: 'source-runtime-token-1357',
      managedByRuntime: true
    })
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })

  it('fails loudly when the Mac runtime BATSHIT_TOKEN is missing', async () => {
    dynamicPrivateEnv.env.BATSHIT_RUNTIME_OWNER = 'mac-app'

    const request = new Request('http://localhost/api/settings/api-keys/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'batshit_token' })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(payload.error).toBe('BATSHIT_TOKEN is not configured in the Mac runtime.')
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })

  it('fails loudly when Docker runtime BATSHIT_TOKEN is missing', async () => {
    dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'

    const request = new Request('http://localhost/api/settings/api-keys/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'batshit_token' })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(payload.error).toBe('BATSHIT_TOKEN is not configured in the Docker runtime environment.')
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })

  it('fails loudly when the source runtime BATSHIT_TOKEN is missing', async () => {
    const request = new Request('http://localhost/api/settings/api-keys/retrieve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'batshit_token' })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(404)
    expect(payload.error).toBe('BATSHIT_TOKEN is not configured in the source runtime environment.')
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
  })
})

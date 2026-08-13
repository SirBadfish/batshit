import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiKeyService = {
  getAllMasked: vi.fn().mockResolvedValue({}),
  store: vi.fn().mockResolvedValue(undefined),
  getMasked: vi.fn().mockResolvedValue('****1234'),
  delete: vi.fn().mockResolvedValue(undefined)
}

const syncAgentCodexProfiles = vi.fn()
const syncAgentClaudeProfiles = vi.fn()
const dynamicPrivateEnv = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService
}))

vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)

vi.mock('$lib/server/services/codexProfileManager', () => ({
  syncAgentCodexProfiles
}))

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles
}))

describe('/api/settings/api-keys managed profile sync hooks', () => {
  let routeModule: typeof import('./+server')

  beforeEach(async () => {
    vi.clearAllMocks()
    for (const key of Object.keys(dynamicPrivateEnv.env)) {
      delete dynamicPrivateEnv.env[key]
    }
    apiKeyService.getAllMasked.mockResolvedValue({})
    apiKeyService.getMasked.mockResolvedValue('****1234')
    routeModule = await import('./+server')
  })

  it('POST syncs both Codex and Claude profiles for n8n instance MCP token updates', async () => {
    const request = new Request('http://localhost/api/settings/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'n8n_instance_mcp_token',
        apiKey: 'secret-token'
      })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(200)
    expect(apiKeyService.store).toHaveBeenCalledWith('n8n_instance_mcp_token', 'secret-token', 'josh')
    expect(syncAgentCodexProfiles).toHaveBeenCalledWith('josh')
    expect(syncAgentClaudeProfiles).toHaveBeenCalledWith('josh')
  })

  it('DELETE syncs both Codex and Claude profiles for n8n instance MCP token removal', async () => {
    const request = new Request('http://localhost/api/settings/api-keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'n8n_instance_mcp_token'
      })
    })

    const response = await routeModule.DELETE({
      request,
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(200)
    expect(apiKeyService.delete).toHaveBeenCalledWith('n8n_instance_mcp_token', 'josh')
    expect(syncAgentCodexProfiles).toHaveBeenCalledWith('josh')
    expect(syncAgentClaudeProfiles).toHaveBeenCalledWith('josh')
  })

  it('GET reports Batshit internal token as Docker runtime-managed when containerized', async () => {
    dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'docker-runtime-token-7890'
    dynamicPrivateEnv.env.BATSHIT_ARTIFACT_COMPLETE_URL = 'http://localhost:5613/api/artifacts/complete'
    dynamicPrivateEnv.env.N8N_API_URL = 'http://n8n:5678'
    apiKeyService.getAllMasked.mockResolvedValue({
      batshit_token: {
        service: 'batshit_token',
        masked: '****...d99f',
        status: 'ready',
        updatedAt: '2026-05-22T00:00:00.000Z'
      }
    })

    const response = await routeModule.GET({
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.keys.batshit_token).toMatchObject({
      service: 'batshit_token',
      masked: '****...7890',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Docker Compose'
    })
    expect(payload.keys.batshit_artifact_complete_url).toMatchObject({
      service: 'batshit_artifact_complete_url',
      masked: 'http://localhost:5613/api/artifacts/complete',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Using Docker runtime default'
    })
    expect(payload.keys.n8n_api_url).toMatchObject({
      service: 'n8n_api_url',
      masked: 'http://n8n:5678',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Docker Compose'
    })
    expect(apiKeyService.getAllMasked).toHaveBeenCalledWith('josh', {
      skipServices: ['batshit_token']
    })
  })

  it('GET reports Batshit internal token as Mac runtime-managed in the packaged Mac app', async () => {
    dynamicPrivateEnv.env.BATSHIT_RUNTIME_OWNER = 'mac-app'
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'mac-runtime-token-2468'
    apiKeyService.getAllMasked.mockResolvedValue({
      batshit_token: {
        service: 'batshit_token',
        masked: '****...old0',
        status: 'ready',
        updatedAt: '2026-05-29T00:00:00.000Z'
      }
    })

    const response = await routeModule.GET({
      request: new Request('http://localhost:5620/api/settings/api-keys'),
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.keys.batshit_token).toMatchObject({
      service: 'batshit_token',
      masked: '****...2468',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Mac Runtime'
    })
    expect(payload.keys.batshit_artifact_complete_url).toMatchObject({
      service: 'batshit_artifact_complete_url',
      masked: 'http://localhost:5620/api/artifacts/complete',
      status: 'ready',
      defaultedByRuntime: true,
      runtimeLabel: 'Using default'
    })
    expect(apiKeyService.getAllMasked).toHaveBeenCalledWith('josh', {
      skipServices: ['batshit_token']
    })
  })

  it('GET blocks editing when saved API key records cannot be decrypted', async () => {
    apiKeyService.getAllMasked.mockResolvedValue({
      openai: {
        service: 'openai',
        masked: '****',
        status: 'error',
        updatedAt: '2026-08-12T00:00:00.000Z'
      }
    })

    const response = await routeModule.GET({
      request: new Request('http://localhost:5620/api/settings/api-keys'),
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(409)
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('Do not re-enter or delete the keys')
  })

  it('GET reports Batshit internal token as source runtime-managed in host/source installs', async () => {
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'source-runtime-token-1357'
    apiKeyService.getAllMasked.mockResolvedValue({
      batshit_token: {
        service: 'batshit_token',
        masked: '****...old0',
        status: 'ready',
        updatedAt: '2026-06-12T00:00:00.000Z'
      }
    })

    const response = await routeModule.GET({
      request: new Request('http://localhost:5620/api/settings/api-keys'),
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.keys.batshit_token).toMatchObject({
      service: 'batshit_token',
      masked: '****...1357',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Source Runtime'
    })
    expect(apiKeyService.getAllMasked).toHaveBeenCalledWith('josh', {
      skipServices: ['batshit_token']
    })
  })

  it('GET reports Artifact Complete URL default instead of missing in host runtime', async () => {
    apiKeyService.getAllMasked.mockResolvedValue({
      batshit_artifact_complete_url: {
        service: 'batshit_artifact_complete_url',
        masked: '',
        status: 'needs-config',
        updatedAt: ''
      }
    })

    const response = await routeModule.GET({
      request: new Request('http://localhost:5620/api/settings/api-keys'),
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.keys.batshit_artifact_complete_url).toMatchObject({
      service: 'batshit_artifact_complete_url',
      masked: 'http://localhost:5620/api/artifacts/complete',
      status: 'ready',
      defaultedByRuntime: true,
      runtimeLabel: 'Using default'
    })
  })

  it('POST does not store Batshit internal token from the UI when containerized', async () => {
    dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'docker-runtime-token-7890'
    const request = new Request('http://localhost/api/settings/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'batshit_token',
        apiKey: 'ui-generated-token'
      })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      success: true,
      service: 'batshit_token',
      masked: '****...7890',
      managedByRuntime: true
    })
    expect(apiKeyService.delete).toHaveBeenCalledWith('batshit_token', 'josh')
    expect(apiKeyService.store).not.toHaveBeenCalled()
  })

  it('POST does not store Batshit internal token from the UI in the packaged Mac app', async () => {
    dynamicPrivateEnv.env.BATSHIT_RUNTIME_OWNER = 'mac-app'
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'mac-runtime-token-2468'
    const request = new Request('http://localhost/api/settings/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'batshit_token',
        apiKey: 'ui-generated-token'
      })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      success: true,
      service: 'batshit_token',
      masked: '****...2468',
      managedByRuntime: true
    })
    expect(apiKeyService.delete).toHaveBeenCalledWith('batshit_token', 'josh')
    expect(apiKeyService.store).not.toHaveBeenCalled()
  })

  it('POST does not store Batshit internal token from the UI in source installs', async () => {
    dynamicPrivateEnv.env.BATSHIT_TOKEN = 'source-runtime-token-1357'
    const request = new Request('http://localhost/api/settings/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'batshit_token',
        apiKey: 'ui-generated-token'
      })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      success: true,
      service: 'batshit_token',
      masked: '****...1357',
      managedByRuntime: true
    })
    expect(apiKeyService.delete).toHaveBeenCalledWith('batshit_token', 'josh')
    expect(apiKeyService.store).not.toHaveBeenCalled()
  })

  it('POST rejects Batshit internal token storage when the source runtime token is missing', async () => {
    const request = new Request('http://localhost/api/settings/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'batshit_token',
        apiKey: 'ui-generated-token'
      })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.error).toBe('BATSHIT_TOKEN is not configured in the source runtime environment.')
    expect(apiKeyService.delete).toHaveBeenCalledWith('batshit_token', 'josh')
    expect(apiKeyService.store).not.toHaveBeenCalled()
  })
})

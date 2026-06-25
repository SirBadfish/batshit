import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
  env: {}
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn()
  }
}))

import { apiKeyService } from '$lib/services/apiKey.server'
import { getN8nRuntimeStatus } from '../n8nRuntimeStatus'

describe('n8nRuntimeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(apiKeyService.retrieve as any).mockResolvedValue(null)
  })

  it('uses the saved n8n API URL and reports healthy status', async () => {
    ;(apiKeyService.retrieve as any).mockImplementation(async (service: string) => {
      if (service === 'n8n_api_url') return 'http://localhost:5678/api/v1'
      if (service === 'n8n_api_key') return 'n8n-key'
      return null
    })
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const status = await getN8nRuntimeStatus({
      userId: 'user-1',
      fetchImpl: fetchImpl as any,
      runtimeEnv: {}
    })

    expect(status).toMatchObject({
      healthy: true,
      reachable: true,
      effectiveUrl: 'http://localhost:5678',
      healthUrl: 'http://localhost:5678/healthz',
      urlSource: 'saved-api-url',
      apiKeyConfigured: true,
      mode: 'native'
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:5678/healthz', expect.any(Object))
  })

  it('uses the Docker n8n service URL when the optional profile config is active', async () => {
    ;(apiKeyService.retrieve as any).mockResolvedValue('http://localhost:5678')
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    const status = await getN8nRuntimeStatus({
      userId: 'user-1',
      fetchImpl: fetchImpl as any,
      runtimeEnv: {
        BATSHIT_CONTAINERIZED: '1',
        N8N_API_URL: 'http://n8n:5678'
      }
    })

    expect(status.mode).toBe('docker')
    expect(status.effectiveUrl).toBe('http://n8n:5678')
    expect(status.urlSource).toBe('runtime-env')
    expect(status.launch.startSupported).toBe(false)
    expect(status.launch.reason).toContain('opt-in')
  })

  it('reports unreachable status without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))

    const status = await getN8nRuntimeStatus({
      fetchImpl: fetchImpl as any,
      runtimeEnv: {
        BATSHIT_RUNTIME_OWNER: 'mac-app'
      }
    })

    expect(status).toMatchObject({
      healthy: false,
      reachable: false,
      mode: 'mac-app',
      effectiveUrl: 'http://localhost:5678',
      error: 'connect ECONNREFUSED'
    })
    expect(status.launch.reason).toContain('does not bundle or auto-start n8n yet')
  })
})

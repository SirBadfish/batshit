import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTrustedInternalRequest: vi.fn(),
  retrieve: vi.fn()
}))

vi.mock('$lib/server/services/internalRequestAuth', () => ({
  isTrustedInternalRequest: mocks.isTrustedInternalRequest
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: mocks.retrieve
  }
}))

import { POST } from './+server'

function buildRequest(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/voice/livekit/provider-key', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-batshit-service-token': 'service-token'
    },
    body: JSON.stringify(payload)
  })
}

describe('/api/voice/livekit/provider-key', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('rejects untrusted sidecar calls', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(false)

    const response = await POST({
      request: buildRequest({
        userId: 'user-1',
        providerId: 'xai'
      })
    } as any)

    expect(response.status).toBe(401)
    expect(mocks.retrieve).not.toHaveBeenCalled()
  })

  it('returns the saved provider key for trusted sidecar calls', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.retrieve.mockResolvedValue(' saved-xai-key ')

    const response = await POST({
      request: buildRequest({
        userId: 'user-1',
        providerId: 'grok'
      })
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      providerId: 'xai',
      source: 'user',
      apiKey: 'saved-xai-key'
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns Deepgram keys for LiveKit bridge STT', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.retrieve.mockResolvedValue(' saved-deepgram-key ')

    const response = await POST({
      request: buildRequest({
        userId: 'user-1',
        providerId: 'deepgram'
      })
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      providerId: 'deepgram',
      source: 'user',
      apiKey: 'saved-deepgram-key'
    })
    expect(mocks.retrieve).toHaveBeenCalledWith('deepgram', 'user-1')
  })

  it('falls back to the Deepgram env key for LiveKit bridge STT', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.retrieve.mockResolvedValue(null)
    vi.stubEnv('DEEPGRAM_API_KEY', 'env-deepgram-key')

    const response = await POST({
      request: buildRequest({
        userId: 'user-1',
        providerId: 'deepgram'
      })
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      providerId: 'deepgram',
      source: 'env',
      apiKey: 'env-deepgram-key'
    })
  })

  it('fails loudly when the provider key is not configured', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.retrieve.mockResolvedValue(null)
    vi.stubEnv('XAI_API_KEY', '')

    const response = await POST({
      request: buildRequest({
        userId: 'user-1',
        providerId: 'xai'
      })
    } as any)

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Grok Voice API key is not configured.',
      setupHint: expect.stringContaining('XAI_API_KEY')
    })
  })
})

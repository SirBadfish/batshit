import { afterEach, describe, expect, it, vi } from 'vitest'

const apiKeyMocks = vi.hoisted(() => ({
  retrieve: vi.fn()
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: apiKeyMocks.retrieve
  }
}))

import { POST } from './+server'

describe('/api/voice/livekit/session', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    apiKeyMocks.retrieve.mockReset()
  })

  it('rejects anonymous requests', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', { method: 'POST' }),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized'
    })
  })

  it('fails loudly for malformed JSON payloads', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', {
        method: 'POST',
        body: '{'
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid JSON payload',
      runtime: 'livekit',
      fallback: false
    })
  })

  it('fails loudly for non-object JSON payloads', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', {
        method: 'POST',
        body: '[]'
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid LiveKit voice session payload',
      runtime: 'livekit',
      fallback: false
    })
  })

  it('returns a setup hint instead of silently assuming local dev credentials', async () => {
    vi.stubEnv('LIVEKIT_URL', '')
    vi.stubEnv('LIVEKIT_WS_URL', '')
    vi.stubEnv('LIVEKIT_API_KEY', '')
    vi.stubEnv('LIVEKIT_API_SECRET', '')
    apiKeyMocks.retrieve.mockResolvedValue(null)

    const response = await POST({
      request: new Request('http://localhost/api/voice/livekit/session', {
        method: 'POST',
        body: '{}'
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(412)
    await expect(response.json()).resolves.toMatchObject({
      error: 'LiveKit URL not configured.',
      setupHint: expect.stringContaining('LIVEKIT_URL'),
      runtime: 'livekit',
      fallback: false
    })
  })

})

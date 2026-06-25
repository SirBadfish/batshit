import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './+server'

const mockCreateToken = vi.fn()

vi.mock('$lib/server/services/voiceRealtimeSttRuntime', () => ({
  createDeepgramRealtimeSttEphemeralToken: (...args: any[]) => mockCreateToken(...args),
  getRealtimeSttSessionSetupHint: () => undefined,
  RealtimeSttSessionSetupError: class RealtimeSttSessionSetupError extends Error {
    status = 412
  }
}))

describe('/api/voice/realtime-stt/deepgram-token', () => {
  beforeEach(() => {
    mockCreateToken.mockReset()
    mockCreateToken.mockResolvedValue({
      provider: 'deepgram',
      accessToken: 'dg-temporary-jwt',
      tokenType: 'bearer',
      expiresIn: 30,
      expiresAt: '2026-05-18T00:00:30.000Z'
    })
  })

  it('rejects anonymous requests', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/realtime-stt/deepgram-token', {
        method: 'POST'
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized'
    })
  })

  it('mints a no-store temporary Deepgram token for signed-in users', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/realtime-stt/deepgram-token', {
        method: 'POST',
        body: JSON.stringify({
          ttlSeconds: 30
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mockCreateToken).toHaveBeenCalledWith('user-1', {
      ttlSeconds: 30
    })
    await expect(response.json()).resolves.toMatchObject({
      provider: 'deepgram',
      accessToken: 'dg-temporary-jwt',
      tokenType: 'bearer',
      expiresIn: 30
    })
  })

  it('fails loudly for malformed JSON payloads', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/realtime-stt/deepgram-token', {
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
      runtime: 'realtime-stt',
      fallback: false
    })
  })
})

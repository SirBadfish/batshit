import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createRealtimeSttSessionContract: vi.fn(),
  isTrustedInternalRequest: vi.fn()
}))

vi.mock('$lib/server/services/voiceRealtimeSttRuntime', () => ({
  createRealtimeSttSessionContract: mocks.createRealtimeSttSessionContract,
  getRealtimeSttSessionSetupHint: () => undefined,
  RealtimeSttSessionSetupError: class RealtimeSttSessionSetupError extends Error {
    status: number
    setupHint?: string

    constructor(message: string, options: { status?: number; setupHint?: string } = {}) {
      super(message)
      this.status = options.status ?? 400
      this.setupHint = options.setupHint
    }
  }
}))

vi.mock('$lib/server/services/internalRequestAuth', () => ({
  isTrustedInternalRequest: mocks.isTrustedInternalRequest
}))

import { POST } from './+server'

describe('/api/voice/realtime-stt/session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createRealtimeSttSessionContract.mockResolvedValue({
      provider: 'byo',
      voiceProviderId: 'byo:whisper-cpp-realtime',
      mode: 'byo-local-websocket',
      ready: true,
      launchSupported: true,
      transport: 'byo-runtime',
      realtimeEvents: ['start', 'speech_start', 'final', 'endpoint', 'error', 'end'],
      audio: {
        encoding: 'linear16',
        sampleRate: 16000,
        channels: 1,
        chunkMs: 100
      },
      serverBridgeRequired: false,
      clientMayConnectDirectly: true,
      secretsExposed: false,
      providerConfig: {
        method: 'websocket',
        endpoint: 'ws://127.0.0.1:8078/stream',
        docsUrl: 'https://batshit.ai/docs/realtime-stt'
      },
      notes: []
    })
    mocks.isTrustedInternalRequest.mockReturnValue(false)
  })

  it('rejects anonymous requests', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/realtime-stt/session', { method: 'POST' }),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized'
    })
  })

  it('fails loudly for malformed JSON payloads', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/realtime-stt/session', {
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

  it('fails loudly for non-object JSON payloads', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/voice/realtime-stt/session', {
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
      error: 'Invalid realtime STT session payload',
      runtime: 'realtime-stt',
      fallback: false
    })
  })

  it('allows a trusted sidecar to request a user-scoped realtime STT contract', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(true)

    const response = await POST({
      request: new Request('http://localhost/api/voice/realtime-stt/session', {
        method: 'POST',
        headers: {
          'x-batshit-service-token': 'test-token'
        },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'byo:whisper-cpp-realtime',
          mode: 'livekit'
        })
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.createRealtimeSttSessionContract).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        provider: 'byo:whisper-cpp-realtime',
        mode: 'livekit'
      })
    )
    await expect(response.json()).resolves.toMatchObject({
      provider: 'byo',
      voiceProviderId: 'byo:whisper-cpp-realtime',
      mode: 'byo-local-websocket'
    })
  })
})

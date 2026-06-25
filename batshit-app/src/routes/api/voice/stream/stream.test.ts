import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_REALTIME_TTS_CONTENT_TYPE } from '$lib/types/voiceRealtime'

const mockStreamSpeechRealtime = vi.fn()

vi.mock('$lib/server/services/voiceService', () => ({
  streamSpeechRealtime: (...args: any[]) => mockStreamSpeechRealtime(...args)
}))

describe('/api/voice/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects anonymous realtime speech requests', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: new Request('http://localhost/api/voice/stream', { method: 'POST' }),
      locals: {}
    } as any)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized'
    })
    expect(mockStreamSpeechRealtime).not.toHaveBeenCalled()
  })

  it('fails loudly for malformed JSON payloads', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: new Request('http://localhost/api/voice/stream', {
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
      fallback: false
    })
    expect(mockStreamSpeechRealtime).not.toHaveBeenCalled()
  })

  it('fails loudly for non-object JSON payloads', async () => {
    const { POST } = await import('./+server')
    const response = await POST({
      request: new Request('http://localhost/api/voice/stream', {
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
      error: 'Invalid realtime speech payload',
      fallback: false
    })
    expect(mockStreamSpeechRealtime).not.toHaveBeenCalled()
  })

  it('streams Batshit realtime TTS events without exposing provider credentials to the browser', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"end","chunkCount":0,"audioBytes":0}\n'))
        controller.close()
      }
    })
    mockStreamSpeechRealtime.mockResolvedValue(stream)

    const { POST } = await import('./+server')
    const response = await POST({
      request: new Request('http://localhost/api/voice/stream', {
        method: 'POST',
        body: JSON.stringify({
          text: 'Hello realtime.',
          provider: 'fish',
          voice_id: 'fish-voice-123'
        })
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(VOICE_REALTIME_TTS_CONTENT_TYPE)
    expect(response.headers.get('x-voice-stream')).toBe('direct-realtime')
    expect(mockStreamSpeechRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hello realtime.',
        provider: 'fish',
        voiceId: 'fish-voice-123',
        userId: 'user-1'
      }),
      expect.any(AbortSignal)
    )
  })
})

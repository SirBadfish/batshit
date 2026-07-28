import { afterEach, describe, expect, it, vi } from 'vitest'

const bridgeMocks = vi.hoisted(() => ({
  analyze: vi.fn()
}))

vi.mock('$lib/server/services/audio2FaceBridge.server', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('$lib/server/services/audio2FaceBridge.server')
  >()
  return {
    ...original,
    analyzeAudio2FacePcm: bridgeMocks.analyze
  }
})

import { Audio2FaceBridgeError } from '$lib/server/services/audio2FaceBridge.server'
import { POST } from './+server'

function request(body = new Uint8Array([0, 0])) {
  return new Request('http://localhost/api/voice/lip-sync/audio2face', {
    method: 'POST',
    headers: {
      'content-type': 'audio/L16',
      'x-batshit-audio-sample-rate': '16000'
    },
    body
  })
}

describe('/api/voice/lip-sync/audio2face', () => {
  afterEach(() => {
    bridgeMocks.analyze.mockReset()
  })

  it('rejects anonymous requests', async () => {
    const response = await POST({ request: request(), locals: {} } as any)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('validates complete PCM16 samples before contacting the bridge', async () => {
    const response = await POST({
      request: request(new Uint8Array([0])),
      locals: { user: { id: 'user-1' } }
    } as any)

    expect(response.status).toBe(400)
    expect(bridgeMocks.analyze).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({ code: 'AUDIO2FACE_INVALID_PCM' })
  })

  it('returns a normalized bridge result without caching it', async () => {
    bridgeMocks.analyze.mockResolvedValue({
      schemaVersion: 'batshit-audio2face/v1',
      status: 'success'
    })
    const response = await POST({
      request: request(new Uint8Array([1, 0, 2, 0])),
      locals: { user: { id: 'user-1' } }
    } as any)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(bridgeMocks.analyze).toHaveBeenCalledWith({
      pcm: new Uint8Array([1, 0, 2, 0]),
      sampleRate: 16_000
    })
  })

  it('preserves typed bridge readiness failures', async () => {
    bridgeMocks.analyze.mockRejectedValue(
      new Audio2FaceBridgeError('NVIDIA NIM is unavailable.', {
        code: 'AUDIO2FACE_NIM_UNAVAILABLE',
        status: 502
      })
    )
    const response = await POST({
      request: request(),
      locals: { user: { id: 'user-1' } }
    } as any)

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: 'NVIDIA NIM is unavailable.',
      code: 'AUDIO2FACE_NIM_UNAVAILABLE'
    })
  })
})

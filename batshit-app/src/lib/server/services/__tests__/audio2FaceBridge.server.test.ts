import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  analyzeAudio2FacePcm,
  Audio2FaceBridgeError
} from '../audio2FaceBridge.server'

describe('Audio2Face bridge client', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('fails loudly when the private bridge boundary is not configured', async () => {
    vi.stubEnv('BATSHIT_AUDIO2FACE_BRIDGE_URL', '')
    vi.stubEnv('BATSHIT_AUDIO2FACE_BRIDGE_TOKEN', '')

    await expect(
      analyzeAudio2FacePcm({ pcm: new Uint8Array([0, 0]), sampleRate: 16_000 })
    ).rejects.toMatchObject({
      code: 'AUDIO2FACE_NOT_CONFIGURED',
      status: 412
    })
  })

  it('forwards PCM through the authenticated bridge without exposing its token', async () => {
    vi.stubEnv('BATSHIT_AUDIO2FACE_BRIDGE_URL', 'http://audio2face-bridge:8068/')
    vi.stubEnv('BATSHIT_AUDIO2FACE_BRIDGE_TOKEN', 'private-bridge-token')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ schemaVersion: 'batshit-audio2face/v1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await analyzeAudio2FacePcm({
      pcm: new Uint8Array([1, 0, 2, 0]),
      sampleRate: 16_000
    })

    expect(result).toEqual({ schemaVersion: 'batshit-audio2face/v1' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://audio2face-bridge:8068/v1/analyze',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer private-bridge-token',
          'x-batshit-audio-sample-rate': '16000'
        })
      })
    )
    const requestBody = fetchMock.mock.calls[0][1].body as ArrayBuffer
    expect([...new Uint8Array(requestBody)]).toEqual([1, 0, 2, 0])
    expect(JSON.stringify(result)).not.toContain('private-bridge-token')
  })

  it('preserves typed bridge failures for the authenticated app route', async () => {
    vi.stubEnv('BATSHIT_AUDIO2FACE_BRIDGE_URL', 'http://audio2face-bridge:8068')
    vi.stubEnv('BATSHIT_AUDIO2FACE_BRIDGE_TOKEN', 'private-bridge-token')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'AUDIO2FACE_NIM_UNAVAILABLE',
            error: 'The bridge is running, but NVIDIA NIM is unavailable.'
          }),
          { status: 502, headers: { 'content-type': 'application/json' } }
        )
      )
    )

    const error = await analyzeAudio2FacePcm({
      pcm: new Uint8Array([0, 0]),
      sampleRate: 16_000
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(Audio2FaceBridgeError)
    expect(error).toMatchObject({
      code: 'AUDIO2FACE_NIM_UNAVAILABLE',
      status: 502,
      message: 'The bridge is running, but NVIDIA NIM is unavailable.'
    })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ARKIT_52_CHANNEL_ORDER } from '$lib/goons/speechFaceProfiles'

const engineMocks = vi.hoisted(() => ({
  loadAudio: vi.fn()
}))

vi.mock('lip-sync-engine', () => ({
  loadAudio: engineMocks.loadAudio
}))

import { analyzeGoonLipSyncWithAudio2Face } from './audio2FaceLipSync'

describe('Audio2Face browser analyzer', () => {
  afterEach(() => {
    engineMocks.loadAudio.mockReset()
    vi.unstubAllGlobals()
  })

  it('normalizes final audio to PCM16 and uses the authenticated app route', async () => {
    engineMocks.loadAudio.mockResolvedValue({
      pcm16: new Int16Array([1, -2]),
      audioBuffer: {}
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 'batshit-audio2face/v1',
          status: 'success',
          fps: 30,
          shapeNames: [...ARKIT_52_CHANNEL_ORDER],
          frames: [
            { timeCode: 0, values: ARKIT_52_CHANNEL_ORDER.map(() => 0) },
            { timeCode: 1 / 30, values: ARKIT_52_CHANNEL_ORDER.map(() => 0) }
          ],
          durationMs: 100,
          cacheHit: false
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await analyzeGoonLipSyncWithAudio2Face({
      audioBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
      mediaType: 'audio/wav',
      text: 'Hello.'
    })

    expect(engineMocks.loadAudio).toHaveBeenCalledWith(expect.any(File), 16_000)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice/lip-sync/audio2face',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'audio/L16',
          'x-batshit-audio-sample-rate': '16000'
        })
      })
    )
    const requestBody = fetchMock.mock.calls[0][1].body as ArrayBuffer
    expect([...new Int16Array(requestBody)]).toEqual([1, -2])
    expect(result.timeline).toMatchObject({
      analyzerId: 'audio2face-3d',
      profile: 'arkit-52',
      sourceText: 'Hello.'
    })
    expect(result.metrics).toMatchObject({
      analyzerId: 'audio2face-3d',
      runtimeMode: 'precomputed',
      normalizeMs: expect.any(Number),
      networkMs: expect.any(Number)
    })
  })

  it('surfaces typed app-route failures to the visible fallback chain', async () => {
    engineMocks.loadAudio.mockResolvedValue({
      pcm16: new Int16Array([0]),
      audioBuffer: {}
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'AUDIO2FACE_NIM_UNAVAILABLE',
            error: 'NVIDIA NIM is unavailable.'
          }),
          { status: 502, headers: { 'content-type': 'application/json' } }
        )
      )
    )

    await expect(
      analyzeGoonLipSyncWithAudio2Face({
        audioBuffer: new Uint8Array([1, 2]).buffer,
        mediaType: 'audio/wav'
      })
    ).rejects.toThrow('AUDIO2FACE_NIM_UNAVAILABLE: NVIDIA NIM is unavailable.')
  })
})

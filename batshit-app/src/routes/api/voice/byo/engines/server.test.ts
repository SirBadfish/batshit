import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  applyVoiceEnginePublicUpdates: vi.fn(),
  listVoiceEngineManagerView: vi.fn(),
  listUnreadableVoiceEngines: vi.fn(),
  upsertVoiceEngineRecord: vi.fn()
}))

import { GET, POST, PUT } from './+server'
import {
  applyVoiceEnginePublicUpdates,
  listUnreadableVoiceEngines,
  listVoiceEngineManagerView,
  upsertVoiceEngineRecord
} from '$lib/server/services/voiceEngineRegistry'

// A saved record the registry cannot read (a newer Batshit wrote it) is kept unchanged; every
// answer that lists engines names it, so the Engine Manager can say so.
const UNREADABLE = [{ id: 'dots-tts-mf', reason: 'has settings this Batshit does not know: futureOption' }]

function buildEvent(body: Record<string, unknown>, userId: string | null = 'user-1'): RequestEvent {
  return {
    request: new Request('http://localhost/api/voice/byo/engines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: userId ? { user: { id: userId } } : { user: null }
  } as unknown as RequestEvent
}

describe('POST /api/voice/byo/engines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(upsertVoiceEngineRecord).mockResolvedValue({
      created: true,
      record: {} as any,
      summary: {
        id: 'kokoro-host',
        providerId: 'byo:kokoro-host',
        name: 'Kokoro Host',
        enabled: false,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        hasAuthToken: false
      } as any
    })
    vi.mocked(listVoiceEngineManagerView).mockResolvedValue({
      engines: [
        {
          id: 'kokoro-host',
          providerId: 'byo:kokoro-host',
          name: 'Kokoro Host',
          enabled: false,
          supportsTts: true,
          supportsStt: false,
          supportsClone: false,
          hasAuthToken: false
        } as any
      ],
      unreadableEngines: UNREADABLE
    })
  })

  it('registers a manually connected existing engine disabled first', async () => {
    const response = await POST(
      buildEvent({
        engineId: 'kokoro-host',
        payload: {
          name: 'Kokoro Host',
          baseUrl: 'http://host.docker.internal:8010/',
          supportsTts: true,
          supportsStt: false,
          requestFormat: 'openai-compatible',
          healthPath: '/v1/models',
          ttsPath: '/v1/audio/speech',
          modelId: 'mlx-community/Kokoro-82M-bf16',
          voiceId: 'af_heart',
          enabled: true
        }
      })
    )

    expect(response.status).toBe(200)
    expect(upsertVoiceEngineRecord).toHaveBeenCalledWith('user-1', 'kokoro-host', {
      name: 'Kokoro Host',
      enabled: false,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://host.docker.internal:8010',
      requestFormat: 'openai-compatible',
      healthPath: '/v1/models',
      readiness: { mode: 'health' },
      tags: ['manual', 'existing-service'],
      ttsPath: '/v1/audio/speech',
      ttsDefaults: {
        modelId: 'mlx-community/Kokoro-82M-bf16',
        voiceId: 'af_heart'
      }
    })
    expect(await response.json()).toMatchObject({
      success: true,
      created: true,
      engine: { id: 'kokoro-host' },
      engines: [{ id: 'kokoro-host' }],
      unreadableEngines: UNREADABLE
    })
  })

  it('rejects records without a capability', async () => {
    const response = await POST(
      buildEvent({
        engineId: 'empty-engine',
        payload: {
          name: 'Empty Engine',
          baseUrl: 'http://localhost:9000',
          supportsTts: false,
          supportsStt: false
        }
      })
    )

    expect(response.status).toBe(400)
    expect(upsertVoiceEngineRecord).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({
      error: 'Choose at least one capability: TTS or STT.'
    })
  })

  it('requires authentication', async () => {
    const response = await POST(buildEvent({}, null))

    expect(response.status).toBe(401)
    expect(upsertVoiceEngineRecord).not.toHaveBeenCalled()
  })
})

describe('PUT /api/voice/byo/engines', () => {
  // This handler rebuilds every update from an ALLOW-LIST. A startup field it
  // does not name is silently dropped here, with the whole chain below it
  // correct and every service-level test still green — which is exactly how
  // "Stop with Batshit" first failed its live proof.
  function buildPutEvent(engines: unknown[], userId: string | null = 'user-1'): RequestEvent {
    return {
      request: new Request('http://localhost/api/voice/byo/engines', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engines })
      }),
      locals: userId ? { user: { id: userId } } : { user: null }
    } as unknown as RequestEvent
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyVoiceEnginePublicUpdates).mockResolvedValue([])
    vi.mocked(listUnreadableVoiceEngines).mockResolvedValue(UNREADABLE)
  })

  it('names the saved engines it cannot read beside the ones it saved', async () => {
    const response = await PUT(buildPutEvent([{ id: 'whisper-cpp', enabled: true }]))

    expect(await response.json()).toMatchObject({ success: true, engines: [], unreadableEngines: UNREADABLE })
  })

  it('passes both startup halves through to the registry', async () => {
    await PUT(
      buildPutEvent([
        {
          id: 'whisper-cpp',
          enabled: true,
          localRuntime: { startup: { autoStartOnLaunch: true, stopOnShutdown: false } }
        }
      ])
    )

    expect(applyVoiceEnginePublicUpdates).toHaveBeenCalledWith('user-1', [
      expect.objectContaining({
        id: 'whisper-cpp',
        localRuntime: { startup: { autoStartOnLaunch: true, stopOnShutdown: false } }
      })
    ])
  })

  it('keeps a stop choice sent on its own', async () => {
    await PUT(
      buildPutEvent([{ id: 'whisper-cpp', localRuntime: { startup: { stopOnShutdown: false } } }])
    )

    expect(applyVoiceEnginePublicUpdates).toHaveBeenCalledWith('user-1', [
      expect.objectContaining({ localRuntime: { startup: { stopOnShutdown: false } } })
    ])
  })

  it('ignores a non-boolean stop value instead of saving a guess', async () => {
    await PUT(
      buildPutEvent([
        { id: 'whisper-cpp', localRuntime: { startup: { stopOnShutdown: 'false' } } }
      ])
    )

    expect(applyVoiceEnginePublicUpdates).toHaveBeenCalledWith('user-1', [
      expect.objectContaining({ localRuntime: { startup: undefined } })
    ])
  })
})

describe('GET /api/voice/byo/engines', () => {
  const getEvent = (userId: string | null = 'user-1') =>
    ({ locals: userId ? { user: { id: userId } } : { user: null } }) as unknown as RequestEvent

  it('lists the engines it can read and names the ones it cannot', async () => {
    vi.mocked(listVoiceEngineManagerView).mockResolvedValue({
      engines: [{ id: 'kokoro', providerId: 'byo:kokoro', name: 'Kokoro' } as any],
      unreadableEngines: UNREADABLE
    })

    const response = await GET(getEvent())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      engines: [{ id: 'kokoro', providerId: 'byo:kokoro', name: 'Kokoro' }],
      unreadableEngines: UNREADABLE
    })
  })

  it('a registry it cannot read at all is an error, not an empty list', async () => {
    vi.mocked(listVoiceEngineManagerView).mockRejectedValue(new Error('connection lost'))

    const response = await GET(getEvent())

    expect(response.status).toBe(500)
  })
})

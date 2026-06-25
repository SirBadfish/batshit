import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'

vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  applyVoiceEnginePublicUpdates: vi.fn(),
  listVoiceEngineSummaries: vi.fn(),
  upsertVoiceEngineRecord: vi.fn()
}))

import { POST } from './+server'
import {
  listVoiceEngineSummaries,
  upsertVoiceEngineRecord
} from '$lib/server/services/voiceEngineRegistry'

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
    vi.mocked(listVoiceEngineSummaries).mockResolvedValue([
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
    ])
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
      engines: [{ id: 'kokoro-host' }]
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

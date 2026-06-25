import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockRetrieveApiKey = vi.fn()
const mockGetUserSettings = vi.fn()
const mockGetVoiceEngineRecordByProviderId = vi.fn()

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: (...args: any[]) => mockRetrieveApiKey(...args)
  }
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: (...args: any[]) => mockGetUserSettings(...args)
  }
}))

vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  getVoiceEngineRecordByProviderId: (...args: any[]) =>
    mockGetVoiceEngineRecordByProviderId(...args)
}))

describe('voiceRealtimeSttRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPGRAM_API_KEY', '')
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    mockRetrieveApiKey.mockResolvedValue(null)
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue(null)
    mockGetUserSettings.mockResolvedValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'browser'
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('returns the current browser realtime STT lane without requiring a server bridge', async () => {
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const contract = await createRealtimeSttSessionContract('user-1', {})

    expect(contract).toMatchObject({
      provider: 'browser',
      voiceProviderId: 'browser',
      ready: true,
      launchSupported: true,
      transport: 'browser-api',
      serverBridgeRequired: false,
      clientMayConnectDirectly: true,
      secretsExposed: false
    })
  })

  it('fails loudly when Deepgram realtime STT is selected without a key', async () => {
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    await expect(
      createRealtimeSttSessionContract('user-1', { provider: 'deepgram' })
    ).rejects.toThrow('Deepgram API key not configured.')
  })

  it('returns a launchable Deepgram Flux contract when credentials exist', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'deepgram' ? 'dg-secret-key' : null
    )
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const contract = await createRealtimeSttSessionContract('user-1', {
      provider: 'deepgram',
      language: 'en'
    })
    const serialized = JSON.stringify(contract)

    expect(contract).toMatchObject({
      provider: 'deepgram',
      ready: true,
      launchSupported: true,
      serverBridgeRequired: false,
      clientMayConnectDirectly: true,
      secretsExposed: false,
      model: 'flux-general-en',
      audio: {
        encoding: 'linear16',
        sampleRate: 16000,
        channels: 1,
        chunkMs: 80
      },
      providerConfig: {
        endpoint: 'wss://api.deepgram.com/v2/listen',
        query: {
          model: 'flux-general-en',
          eot_threshold: 0.7,
          eot_timeout_ms: 1000
        },
        auth: {
          kind: 'deepgram-temporary-token',
          tokenEndpoint: '/api/voice/realtime-stt/deepgram-token',
          websocketProtocol: 'bearer',
          expiresInSeconds: 30
        }
      }
    })
    expect(serialized).not.toContain('dg-secret-key')
  })

  it('uses the realtime STT default and Voice Mode turn settings from saved global settings', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'deepgram' ? 'dg-secret-key' : null
    )
    mockGetUserSettings.mockResolvedValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini-transcribe'
        },
        realtimeStt: {
          providerId: 'deepgram',
          modelId: 'flux-general-multi',
          language: 'es'
        },
        voiceMode: {
          autoSubmitDelayMs: 1500,
          endOfTurnThreshold: 0.85
        }
      }
    })
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const contract = await createRealtimeSttSessionContract('user-1', {
      model: 'flux-general-multi',
      language: 'es',
      voiceMode: {
        autoSubmitDelayMs: 1500,
        endOfTurnThreshold: 0.85
      }
    })

    expect(contract).toMatchObject({
      provider: 'deepgram',
      voiceProviderId: 'deepgram',
      model: 'flux-general-multi',
      providerConfig: {
        query: {
          model: 'flux-general-multi',
          eot_timeout_ms: 1500,
          eot_threshold: 0.85,
          language_hint: ['es']
        }
      }
    })
  })

  it('uses a Flux model for Deepgram realtime even when the saved STT default is Nova', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'deepgram' ? 'dg-secret-key' : null
    )
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const contract = await createRealtimeSttSessionContract('user-1', {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'en'
    })

    expect(contract.model).toBe('flux-general-en')
    expect(contract.providerConfig.query).toMatchObject({
      model: 'flux-general-en'
    })
  })

  it('mints Deepgram temporary realtime STT tokens without returning the saved API key', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'deepgram' ? 'dg-secret-key' : null
    )
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'dg-temporary-jwt',
          expires_in: 30
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const { createDeepgramRealtimeSttEphemeralToken } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const token = await createDeepgramRealtimeSttEphemeralToken('user-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepgram.com/v1/auth/grant',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Token dg-secret-key'
        }),
        body: JSON.stringify({
          ttl_seconds: 30
        })
      })
    )
    expect(token).toMatchObject({
      provider: 'deepgram',
      accessToken: 'dg-temporary-jwt',
      tokenType: 'bearer',
      expiresIn: 30
    })
    expect(JSON.stringify(token)).not.toContain('dg-secret-key')
  })

  it('explains that Deepgram realtime token minting needs a Member-permission key', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'deepgram' ? 'dg-low-permission-key' : null
    )
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          err_code: 'FORBIDDEN',
          err_msg: 'Insufficient permissions.'
        }),
        { status: 403 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const { createDeepgramRealtimeSttEphemeralToken } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    await expect(createDeepgramRealtimeSttEphemeralToken('user-1')).rejects.toMatchObject({
      message: 'Deepgram API key cannot mint realtime STT browser tokens.',
      status: 412,
      setupHint: expect.stringContaining('Permissions: Member')
    })
  })

  it('returns an OpenAI realtime transcription candidate contract without exposing the API key', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'openai' ? 'sk-secret-key' : null
    )
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const contract = await createRealtimeSttSessionContract('user-1', {
      provider: 'openai',
      language: 'en'
    })
    const serialized = JSON.stringify(contract)

    expect(contract).toMatchObject({
      provider: 'openai',
      model: 'gpt-realtime-whisper',
      transport: 'provider-realtime-session',
      launchSupported: false,
      serverBridgeRequired: true,
      providerConfig: {
        endpoint: 'wss://api.openai.com/v1/realtime',
        messages: [
          {
            type: 'session.update',
            session: {
              type: 'transcription'
            }
          }
        ]
      }
    })
    expect(serialized).not.toContain('sk-secret-key')
  })

  it('returns an ElevenLabs Scribe v2 Realtime candidate contract without exposing the API key', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'elevenlabs' ? 'xi-secret-key' : null
    )
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const contract = await createRealtimeSttSessionContract('user-1', {
      provider: 'elevenlabs'
    })
    const serialized = JSON.stringify(contract)

    expect(contract).toMatchObject({
      provider: 'elevenlabs',
      model: 'scribe_v2_realtime',
      launchSupported: false,
      serverBridgeRequired: true,
      providerConfig: {
        endpoint: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
        query: {
          model_id: 'scribe_v2_realtime',
          include_timestamps: true
        }
      }
    })
    expect(serialized).not.toContain('xi-secret-key')
  })

  it('rejects Fish ASR as recorded-only for realtime STT sessions', async () => {
    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    await expect(
      createRealtimeSttSessionContract('user-1', { provider: 'fish' })
    ).rejects.toThrow('Fish Audio STT is recorded/uploaded-audio only in Batshit today.')
  })

  it('rewrites loopback BYO realtime STT endpoints for the Docker LiveKit sidecar only', async () => {
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'whisper-cpp-realtime',
      name: 'Whisper.cpp Realtime STT',
      enabled: true,
      supportsTts: false,
      supportsStt: true,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8078',
      requestFormat: 'openai-compatible',
      sttDefaults: {
        modelId: 'ggml-large-v3.bin',
        language: 'en'
      },
      realtimeStt: {
        enabled: true,
        transport: 'websocket',
        path: '/stream',
        encoding: 'linear16',
        sampleRate: 16000,
        channels: 1,
        chunkMs: 100,
        finalResults: true,
        partialResults: false,
        closeMessageType: 'CloseStream'
      }
    })

    const { createRealtimeSttSessionContract } = await import(
      '../services/voiceRealtimeSttRuntime'
    )

    const direct = await createRealtimeSttSessionContract('user-1', {
      provider: 'byo:whisper-cpp-realtime'
    })
    const livekit = await createRealtimeSttSessionContract('user-1', {
      provider: 'byo:whisper-cpp-realtime',
      mode: 'livekit'
    })

    expect(direct.providerConfig.endpoint).toBe('ws://127.0.0.1:8078/stream')
    expect(livekit.providerConfig.endpoint).toBe('ws://host.docker.internal:8078/stream')
  })
})

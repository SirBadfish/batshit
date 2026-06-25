import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetUserSettings = vi.fn()
const mockRedisGet = vi.fn()
const mockGetVoiceProfile = vi.fn()
const mockCreateVoiceProfile = vi.fn()
const mockDeleteVoiceProfile = vi.fn()
const mockGetVoiceEngineRecordByProviderId = vi.fn()
const mockListVoiceEngineRecords = vi.fn()
const mockListVoiceEngineSummaries = vi.fn()
const mockFetch = vi.fn()
const mockRetrieveApiKey = vi.fn()
const mockSaveHostVoiceReferenceAudioViaOperator = vi.fn()

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: (...args: any[]) => mockGetUserSettings(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    getVoiceProfile: (...args: any[]) => mockGetVoiceProfile(...args),
    createVoiceProfile: (...args: any[]) => mockCreateVoiceProfile(...args),
    deleteVoiceProfile: (...args: any[]) => mockDeleteVoiceProfile(...args)
  }
}))

vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  getVoiceEngineRecordByProviderId: (...args: any[]) =>
    mockGetVoiceEngineRecordByProviderId(...args),
  listVoiceEngineRecords: (...args: any[]) => mockListVoiceEngineRecords(...args),
  listVoiceEngineSummaries: (...args: any[]) => mockListVoiceEngineSummaries(...args),
  getVoiceEngineSuiteId: (record: any) => record?.suite?.id ?? record?.id,
  getVoiceEngineSuiteRole: (record: any) => record?.suite?.role ?? 'primary',
  isVoiceEngineHidden: (record: any) => record?.suite?.hidden === true
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: (...args: any[]) => mockRetrieveApiKey(...args)
  },
  normalizeApiKeyServiceName: (service: string) => service.trim().toLowerCase(),
  isUserFacingApiKeyService: (service: string) => service.trim().toLowerCase() !== 'batshit_token'
}))

vi.mock('$lib/server/services/voiceHostOperatorRuntime', () => ({
  saveHostVoiceReferenceAudioViaOperator: (...args: any[]) =>
    mockSaveHostVoiceReferenceAudioViaOperator(...args)
}))

describe('voiceService engine defaults', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    const { __clearByoSpeechStatusCacheForTests } = await import('../services/voiceService')
    __clearByoSpeechStatusCacheForTests()
    mockRetrieveApiKey.mockResolvedValue(null)
    mockRedisGet.mockResolvedValue(null)
    mockGetVoiceProfile.mockResolvedValue(null)
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue(null)
    mockCreateVoiceProfile.mockImplementation(async (profile: any) => profile)
    mockDeleteVoiceProfile.mockResolvedValue(undefined)
    mockListVoiceEngineRecords.mockResolvedValue([])
    mockListVoiceEngineSummaries.mockResolvedValue([])
    mockSaveHostVoiceReferenceAudioViaOperator.mockReset()
    mockGetUserSettings.mockResolvedValue({
      user_id: 'user-1',
      voice_settings: {
        schemaVersion: 2
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const createTinyWav = () => {
    const pcm = Buffer.from([0, 0, 0, 0])
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(24_000, 24)
    header.writeUInt32LE(48_000, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
  }

  const readRealtimeEvents = async (stream: ReadableStream<Uint8Array>) => {
    const raw = await new Response(stream).text()
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  const createFishSse = (...events: Array<Record<string, unknown>>) =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')

  const createJsonObjectStream = (...events: Array<Record<string, unknown>>) =>
    events.map((event) => JSON.stringify(event)).join('\n')

  it('synthesizes speech through Mistral Voxtral TTS', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'mistral' ? 'mistral-test-key-1234567890' : null
    )
    const audioBase64 = Buffer.from([1, 2, 3, 4]).toString('base64')
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ audio_data: audioBase64 }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from Mistral',
      provider: 'mistral',
      model: 'voxtral-mini-tts-2603',
      voiceId: 'mistral-voice-123',
      userId: 'user-1',
      options: {
        providerOptions: {
          response_format: 'wav'
        }
      }
    })

    const [url, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))
    expect(url).toBe('https://api.mistral.ai/v1/audio/speech')
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer mistral-test-key-1234567890',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    })
    expect(body).toMatchObject({
      input: 'Hello from Mistral',
      model: 'voxtral-mini-tts-2603',
      voice_id: 'mistral-voice-123',
      response_format: 'wav',
      stream: false
    })
    expect(result).toMatchObject({
      provider: 'mistral',
      model: 'voxtral-mini-tts-2603',
      voiceId: 'mistral-voice-123',
      mediaType: 'audio/wav'
    })
    expect(Array.from(result.audio)).toEqual([1, 2, 3, 4])
  })

  it('synthesizes batch speech through Inworld without realtime transport options', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'inworld' ? 'inworld-test-key-1234567890' : null
    )
    const audioBase64 = Buffer.from([11, 12, 13]).toString('base64')
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          audioContent: audioBase64
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from Inworld batch',
      provider: 'inworld',
      model: 'inworld-tts-2',
      voiceId: 'Dennis',
      userId: 'user-1',
      options: {
        common: {
          language: 'en-US'
        },
        providerOptions: {
          audioEncoding: 'MP3',
          sampleRateHertz: 24000,
          deliveryMode: 'CREATIVE',
          applyTextNormalization: 'ON',
          timestampType: 'WORD',
          timestampTransportStrategy: 'SYNC'
        }
      }
    })

    const [url, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))
    expect(url).toBe('https://api.inworld.ai/tts/v1/voice')
    expect(request.headers).toMatchObject({
      Authorization: 'Basic inworld-test-key-1234567890',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    })
    expect(body).toMatchObject({
      text: 'Hello from Inworld batch',
      voiceId: 'Dennis',
      modelId: 'inworld-tts-2',
      language: 'en-US',
      audioConfig: {
        audioEncoding: 'MP3',
        sampleRateHertz: 24000
      },
      deliveryMode: 'CREATIVE',
      applyTextNormalization: 'ON',
      timestampType: 'WORD'
    })
    expect(body).not.toHaveProperty('timestampTransportStrategy')
    expect(result).toMatchObject({
      provider: 'inworld',
      model: 'inworld-tts-2',
      voiceId: 'Dennis',
      mediaType: 'audio/mpeg'
    })
    expect(Array.from(result.audio)).toEqual([11, 12, 13])
  })

  it('synthesizes speech through MiniMax TTS', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'minimax' ? 'minimax-test-key-1234567890' : null
    )
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            audio: Buffer.from([5, 6, 7, 8]).toString('hex')
          },
          extra_info: {
            audio_format: 'wav'
          },
          base_resp: {
            status_code: 0,
            status_msg: 'success'
          }
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from MiniMax',
      provider: 'minimax',
      model: 'speech-2.8-hd',
      voiceId: 'English_expressive_narrator',
      userId: 'user-1',
      options: {
        common: {
          speed: 1.1,
          volume: 1.2
        },
        providerOptions: {
          format: 'wav',
          sample_rate: '32000',
          bitrate: 128000,
          pitch: 1
        }
      }
    })

    const [url, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))
    expect(url).toBe('https://api.minimax.io/v1/t2a_v2')
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer minimax-test-key-1234567890',
      'Content-Type': 'application/json'
    })
    expect(body).toMatchObject({
      model: 'speech-2.8-hd',
      text: 'Hello from MiniMax',
      stream: false,
      output_format: 'hex',
      voice_setting: {
        voice_id: 'English_expressive_narrator',
        speed: 1.1,
        vol: 1.2,
        pitch: 1
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'wav',
        channel: 1
      }
    })
    expect(result).toMatchObject({
      provider: 'minimax',
      model: 'speech-2.8-hd',
      voiceId: 'English_expressive_narrator',
      mediaType: 'audio/wav'
    })
    expect(Array.from(result.audio)).toEqual([5, 6, 7, 8])
  })

  it('synthesizes speech through MiMo V2.5 TTS', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'mimo' ? 'mimo-test-key-1234567890' : null
    )
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                audio: {
                  data: Buffer.from([9, 10, 11]).toString('base64')
                }
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from MiMo',
      provider: 'mimo',
      model: 'mimo-v2.5-tts',
      voiceId: 'Chloe',
      userId: 'user-1',
      options: {
        common: {
          instructions: 'Bright and friendly'
        },
        providerOptions: {
          format: 'wav'
        }
      }
    })

    const [url, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer mimo-test-key-1234567890',
      'Content-Type': 'application/json'
    })
    expect(body).toMatchObject({
      model: 'mimo-v2.5-tts',
      messages: [
        { role: 'user', content: 'Bright and friendly' },
        { role: 'assistant', content: 'Hello from MiMo' }
      ],
      audio: {
        format: 'wav',
        voice: 'Chloe'
      }
    })
    expect(result).toMatchObject({
      provider: 'mimo',
      model: 'mimo-v2.5-tts',
      voiceId: 'Chloe',
      mediaType: 'audio/wav'
    })
    expect(Array.from(result.audio)).toEqual([9, 10, 11])
  })

  it('synthesizes speech through Azure Speech REST TTS', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) => {
      if (service === 'azure_speech_key') return 'azure-test-key-1234567890'
      if (service === 'azure_speech_region') return 'eastus'
      return null
    })
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([12, 13, 14]), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from Azure',
      provider: 'azure',
      model: 'azure-neural-tts',
      voiceId: 'en-US-AvaMultilingualNeural',
      userId: 'user-1',
      options: {
        common: {
          language: 'en-US'
        },
        providerOptions: {
          output_format: 'audio-24khz-48kbitrate-mono-mp3'
        }
      }
    })

    const [url, request] = mockFetch.mock.calls[0]
    expect(url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1')
    expect(request.headers).toMatchObject({
      'Ocp-Apim-Subscription-Key': 'azure-test-key-1234567890',
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
    })
    expect(String(request.body)).toContain('name="en-US-AvaMultilingualNeural"')
    expect(result).toMatchObject({
      provider: 'azure',
      model: 'azure-neural-tts',
      voiceId: 'en-US-AvaMultilingualNeural',
      mediaType: 'audio/mpeg'
    })
    expect(Array.from(result.audio)).toEqual([12, 13, 14])
  })

  it('uses engine-level TTS default model and voice for openai-compatible BYO engines', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'mlx-chatterbox',
      name: 'Chatterbox Turbo (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8010',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16',
        voiceId: 'default'
      }
    })
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from MLX',
      provider: 'byo:mlx-chatterbox',
      userId: 'user-1'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/chatterbox-turbo-fp16',
      input: 'Hello from MLX',
      voice: 'default'
    })
    expect(result).toMatchObject({
      provider: 'byo:mlx-chatterbox',
      model: 'mlx-community/chatterbox-turbo-fp16',
      voiceId: 'default',
      mediaType: 'audio/wav'
    })
  })

  it('does not reuse saved voice defaults from another provider when request chooses BYO TTS', async () => {
    mockGetUserSettings.mockResolvedValue({
      user_id: 'user-1',
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'fish',
          modelId: 's2-pro',
          voiceId: 'fish-reference-id',
          common: {
            speed: 0.75
          }
        }
      }
    })
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'kokoro',
      name: 'Kokoro TTS (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8010',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Kokoro-82M-bf16',
        voiceId: 'af_heart',
        common: {
          speed: 1
        }
      }
    })
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from Kokoro',
      provider: 'byo:kokoro',
      userId: 'user-1'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/Kokoro-82M-bf16',
      input: 'Hello from Kokoro',
      voice: 'af_heart',
      speed: 1
    })
    expect(body.voice).not.toBe('fish-reference-id')
    expect(result).toMatchObject({
      provider: 'byo:kokoro',
      model: 'mlx-community/Kokoro-82M-bf16',
      voiceId: 'af_heart'
    })
  })

  it('falls back to ttsDefaults.providerOptions.model for openai-compatible BYO engines', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'mlx-chatterbox',
      name: 'Chatterbox Turbo (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8010',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        providerOptions: {
          model: 'mlx-community/chatterbox-turbo-fp16'
        }
      }
    })
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({
      text: 'Hello from MLX providerOptions',
      provider: 'byo:mlx-chatterbox',
      userId: 'user-1'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/chatterbox-turbo-fp16',
      input: 'Hello from MLX providerOptions',
      voice: 'alloy'
    })
    expect(result).toMatchObject({
      provider: 'byo:mlx-chatterbox',
      model: 'mlx-community/chatterbox-turbo-fp16',
      voiceId: 'alloy',
      mediaType: 'audio/wav'
    })
  })

  it('fails loudly when an openai-compatible BYO TTS engine has no saved default model', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'mlx-chatterbox',
      name: 'Chatterbox Turbo (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8010',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible'
    })

    const { synthesizeSpeech } = await import('../services/voiceService')

    await expect(
      synthesizeSpeech({
        text: 'Hello from MLX',
        provider: 'byo:mlx-chatterbox',
        userId: 'user-1'
      })
    ).rejects.toThrow(
      'BYO provider "byo:mlx-chatterbox" uses the OpenAI-compatible speech synthesis lane but has no model configured.'
    )

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('uses engine-level STT default model for openai-compatible BYO engines', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'mlx-whisper',
      name: 'Whisper (MLX)',
      enabled: true,
      supportsTts: false,
      supportsStt: true,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8010',
      sttPath: '/v1/audio/transcriptions',
      requestFormat: 'openai-compatible',
      sttDefaults: {
        modelId: 'mlx-community/whisper-large-v3-turbo-asr-fp16'
      }
    })
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ text: 'transcribed text' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      })
    )

    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({
      audio: new Uint8Array([1, 2, 3]),
      provider: 'byo:mlx-whisper',
      userId: 'user-1',
      contentType: 'audio/wav'
    })

    const [, request] = mockFetch.mock.calls[0]
    const form = request.body as FormData

    expect(form.get('model')).toBe('mlx-community/whisper-large-v3-turbo-asr-fp16')
    expect(result).toMatchObject({
      text: 'transcribed text'
    })
  })

  it('fails loudly when an openai-compatible BYO STT engine has no saved default model', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'mlx-whisper',
      name: 'Whisper (MLX)',
      enabled: true,
      supportsTts: false,
      supportsStt: true,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8010',
      sttPath: '/v1/audio/transcriptions',
      requestFormat: 'openai-compatible'
    })

    const { transcribeAudio } = await import('../services/voiceService')

    await expect(
      transcribeAudio({
        audio: new Uint8Array([1, 2, 3]),
        provider: 'byo:mlx-whisper',
        userId: 'user-1',
        contentType: 'audio/wav'
      })
    ).rejects.toThrow(
      'BYO provider "byo:mlx-whisper" uses the OpenAI-compatible speech transcription lane but has no model configured.'
    )

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('resolves saved API key refs for BYO health checks', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'voice-cloud',
      name: 'Voice Cloud',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: true,
      baseUrl: 'https://api.example.com',
      healthPath: '/v1/user',
      authMode: 'header',
      authHeader: 'xi-api-key',
      authSavedKeyRef: 'elevenlabs'
    })
    mockRetrieveApiKey.mockResolvedValue('secret-elevenlabs-key')
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ subscription: { tier: 'starter' } }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      })
    )

    const { checkByoSpeechStatus } = await import('../services/voiceService')
    const result = await checkByoSpeechStatus('user-1', 'byo:voice-cloud')

    const [url, request] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/user')
    expect(request.headers).toMatchObject({
      'xi-api-key': 'secret-elevenlabs-key'
    })
    expect(result).toMatchObject({
      ready: true
    })
  })

  it('rewrites loopback BYO base URLs to the host gateway in Docker', async () => {
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'whisper-cpp',
      name: 'Whisper.cpp',
      enabled: true,
      supportsTts: false,
      supportsStt: true,
      baseUrl: 'http://localhost:8077',
      healthPath: '/health',
      authMode: 'none'
    })
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))

    const { checkByoSpeechStatus } = await import('../services/voiceService')
    const result = await checkByoSpeechStatus('user-1', 'byo:whisper-cpp')

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('http://host.docker.internal:8077/health')
    expect(result).toMatchObject({
      ready: true
    })
  })

  it('surfaces suite-aware BYO defaults into provider summaries for settings dropdowns', async () => {
    mockListVoiceEngineSummaries.mockResolvedValue([
      {
        id: 'qwen3-tts',
        providerId: 'byo:qwen3-tts',
        name: 'Qwen3 TTS Suite',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: true,
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
          voiceId: 'Ryan'
        },
        voiceSurface: {
          kind: 'hybrid',
          summary:
            "Preset speakers available (Ryan, Aiden, Serena, Vivian). Clone profiles route through Batshit's hidden clone lane. Voice design routes through Batshit's hidden voice-design lane.",
          voices: ['Ryan', 'Aiden', 'Serena', 'Vivian'],
          requiresDiscussion: false
        },
        suite: {
          id: 'qwen3-tts',
          role: 'primary'
        },
        voiceDiscovery: {
          mode: 'none'
        },
        readiness: {
          mode: 'health'
        }
      }
    ])
    mockFetch.mockResolvedValue(
      new Response('', {
        status: 200
      })
    )

    const { buildVoiceProviderSummary } = await import('../services/voiceService')
    const result = await buildVoiceProviderSummary('user-1')
    const provider = result.find((entry) => entry.id === 'byo:qwen3-tts')

    expect(provider).toMatchObject({
      id: 'byo:qwen3-tts',
      defaultModel: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
      defaultVoice: 'Ryan',
      ttsModels: ['mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16'],
      sttModels: [],
      voiceSurface: {
        kind: 'hybrid',
        requiresDiscussion: false
      },
      supports: {
        clone: true,
        listVoices: true
      },
      suite: {
        id: 'qwen3-tts',
        role: 'primary'
      }
    })
  })

  it('reuses short-lived BYO health probes while building provider summaries', async () => {
    mockListVoiceEngineSummaries.mockResolvedValue([
      {
        id: 'kokoro',
        providerId: 'byo:kokoro',
        name: 'Kokoro TTS',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        baseUrl: 'http://127.0.0.1:8010',
        healthPath: '/health',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Kokoro-82M-bf16',
          voiceId: 'af_heart'
        },
        voiceDiscovery: {
          mode: 'none'
        },
        readiness: {
          mode: 'health'
        }
      }
    ])
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'kokoro',
      name: 'Kokoro TTS',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8010',
      healthPath: '/health',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Kokoro-82M-bf16',
        voiceId: 'af_heart'
      },
      voiceDiscovery: {
        mode: 'none'
      },
      readiness: {
        mode: 'health'
      }
    })
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      })
    )

    const { buildVoiceProviderSummary } = await import('../services/voiceService')
    await buildVoiceProviderSummary('user-1')
    await buildVoiceProviderSummary('user-1')

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('surfaces installed BYO STT catalog models in provider summaries', async () => {
    mockListVoiceEngineSummaries.mockResolvedValue([
      {
        id: 'whisper-cpp',
        providerId: 'byo:whisper-cpp',
        name: 'Whisper.cpp Local STT',
        enabled: true,
        supportsTts: false,
        supportsStt: true,
        supportsClone: false,
        requestFormat: 'openai-compatible',
        sttDefaults: {
          modelId: 'ggml-tiny.en.bin',
          language: 'en'
        },
        sttModelCatalog: {
          kind: 'whisper.cpp',
          capability: 'stt',
          modelDir: 'models',
          activeModelId: 'tiny.en',
          requiresRestartOnModelChange: true,
          models: [
            {
              id: 'tiny.en',
              label: 'tiny.en',
              filename: 'ggml-tiny.en.bin',
              requestModel: 'ggml-tiny.en.bin',
              installed: true
            },
            {
              id: 'base.en',
              label: 'base.en',
              filename: 'ggml-base.en.bin',
              requestModel: 'ggml-base.en.bin',
              installed: true
            },
            {
              id: 'small.en',
              label: 'small.en',
              filename: 'ggml-small.en.bin',
              requestModel: 'ggml-small.en.bin',
              installed: false
            }
          ]
        },
        readiness: {
          mode: 'health'
        }
      }
    ])
    mockFetch.mockResolvedValue(
      new Response('', {
        status: 200
      })
    )

    const { buildVoiceProviderSummary } = await import('../services/voiceService')
    const result = await buildVoiceProviderSummary('user-1')
    const provider = result.find((entry) => entry.id === 'byo:whisper-cpp')

    expect(provider).toMatchObject({
      id: 'byo:whisper-cpp',
      defaultSttModel: 'ggml-tiny.en.bin',
      sttModels: ['ggml-tiny.en.bin', 'ggml-base.en.bin']
    })
  })

  it('marks Fish and Inworld as built-in direct realtime TTS providers in provider summaries', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fish'
        ? 'fish-test-key-1234567890'
        : service === 'inworld'
          ? 'inworld-test-key-1234567890'
          : null
    )

    const { buildVoiceProviderSummary } = await import('../services/voiceService')
    const result = await buildVoiceProviderSummary('user-1')

    expect(result.find((entry) => entry.id === 'fish')).toMatchObject({
      ready: true,
      supports: {
        tts: true,
        stt: true,
        listVoices: true,
        streaming: true
      },
      defaultModel: 's2-pro',
      defaultTtsModel: 's2-pro',
      ttsModels: ['s2-pro', 's1'],
      sttCapabilities: {
        recorded: true,
        realtime: false,
        transport: 'http-upload'
      }
    })
    expect(result.find((entry) => entry.id === 'inworld')).toMatchObject({
      ready: true,
      supports: {
        tts: true,
        stt: false,
        listVoices: true,
        streaming: true
      },
      defaultModel: 'inworld-tts-2',
      defaultTtsModel: 'inworld-tts-2',
      ttsModels: ['inworld-tts-2', 'inworld-tts-1.5-max', 'inworld-tts-1.5-mini', 'inworld-tts-1', 'inworld-tts-1-max']
    })
    expect(result.find((entry) => entry.id === 'openai')?.supports.streaming).toBe(false)
    expect(result.find((entry) => entry.id === 'elevenlabs')?.supports.streaming).toBe(false)
    expect(result.find((entry) => entry.id === 'deepgram')?.supports.streaming).toBe(false)
  })

  it('lists Fish Audio user models and popular public models as voices', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fish' ? 'fish-test-key-1234567890' : null
    )
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://api.fish.audio')
      expect(url.pathname).toBe('/model')
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer fish-test-key-1234567890',
        Accept: 'application/json'
      })

      const self = url.searchParams.get('self') === 'true'
      return new Response(
        JSON.stringify({
          has_more: false,
          items: self
            ? [
                {
                  _id: 'fish-private-voice',
                  title: 'Josh Clone',
                  state: 'trained',
                  visibility: 'private',
                  languages: ['en']
                }
              ]
            : [
                {
                  _id: 'fish-public-voice',
                  title: 'Energetic Male',
                  state: 'created',
                  visibility: 'public'
                },
                {
                  _id: 'fish-training-voice',
                  title: 'Still Training',
                  state: 'training',
                  visibility: 'private'
                },
                {
                  _id: 'fish-private-voice',
                  title: 'Duplicate User Voice',
                  state: 'trained',
                  visibility: 'private'
                }
              ]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    })

    const { listVoices } = await import('../services/voiceService')
    const voices = await listVoices({
      userId: 'user-1',
      provider: 'fish'
    })

    expect(voices).toEqual([
      {
        id: 'fish-private-voice',
        name: 'Josh Clone',
        provider: 'fish',
        category: 'Your Fish models',
        language: 'en',
        isClone: true
      },
      {
        id: 'fish-public-voice',
        name: 'Energetic Male',
        provider: 'fish',
        category: 'public',
        language: undefined,
        isClone: false
      }
    ])
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get('self')).toBe('true')
    expect(new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get('sort_by')).toBe('score')
  })

  it('lists ElevenLabs voices from the current paginated voice endpoint', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'elevenlabs' ? 'elevenlabs-placeholder' : null
    )
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            voices: [
              {
                voice_id: 'eleven-default',
                name: 'Rachel',
                category: 'premade',
                preview_url: 'https://example.com/rachel.mp3'
              }
            ],
            has_more: true,
            next_page_token: 'page-2'
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json'
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            voices: [
              {
                voice_id: 'eleven-clone',
                name: 'Josh Clone',
                category: 'cloned'
              }
            ],
            has_more: false,
            next_page_token: null
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json'
            }
          }
        )
      )

    const { listVoices } = await import('../services/voiceService')
    const voices = await listVoices({
      userId: 'user-1',
      provider: 'elevenlabs'
    })

    expect(voices).toEqual([
      {
        id: 'eleven-default',
        name: 'Rachel',
        provider: 'elevenlabs',
        category: 'premade',
        previewUrl: 'https://example.com/rachel.mp3',
        isClone: false
      },
      {
        id: 'eleven-clone',
        name: 'Josh Clone',
        provider: 'elevenlabs',
        category: 'cloned',
        previewUrl: undefined,
        isClone: true
      }
    ])
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const firstUrl = new URL(String(mockFetch.mock.calls[0]?.[0]))
    const secondUrl = new URL(String(mockFetch.mock.calls[1]?.[0]))
    expect(firstUrl.toString()).toContain('https://api.elevenlabs.io/v2/voices')
    expect(firstUrl.searchParams.get('page_size')).toBe('100')
    expect(firstUrl.searchParams.get('include_total_count')).toBe('false')
    expect(secondUrl.searchParams.get('next_page_token')).toBe('page-2')
  })

  it('lists Mistral voices from the Audio Voices endpoint', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'mistral' ? 'mistral-test-key-1234567890' : null
    )
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'mistral-preset',
              name: 'Studio Voice',
              user_id: null,
              languages: ['en'],
              tags: ['preset']
            },
            {
              id: 'mistral-custom',
              name: 'Josh Mistral Clone',
              user_id: 'user-1',
              languages: ['en', 'fr']
            }
          ],
          total: 2,
          page_size: 100
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { listVoices } = await import('../services/voiceService')
    const voices = await listVoices({
      userId: 'user-1',
      provider: 'mistral'
    })

    expect(voices).toEqual([
      {
        id: 'mistral-preset',
        name: 'Studio Voice',
        provider: 'mistral',
        category: 'preset',
        language: 'en',
        isClone: false
      },
      {
        id: 'mistral-custom',
        name: 'Josh Mistral Clone',
        provider: 'mistral',
        category: 'Your Mistral voices',
        language: 'en',
        isClone: true
      }
    ])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const url = new URL(String(mockFetch.mock.calls[0]?.[0]))
    expect(url.toString()).toContain('https://api.mistral.ai/v1/audio/voices')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('offset')).toBe('0')
  })

  it('surfaces current STT model defaults separately from TTS defaults', async () => {
    const { buildVoiceProviderSummary } = await import('../services/voiceService')
    const result = await buildVoiceProviderSummary('user-1')

    expect(result.find((entry) => entry.id === 'openai')).toMatchObject({
      defaultModel: 'gpt-4o-mini-tts',
      defaultTtsModel: 'gpt-4o-mini-tts',
      defaultSttModel: 'gpt-4o-mini-transcribe',
      defaultRealtimeSttModel: 'gpt-realtime-whisper',
      ttsModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
      sttModels: [
        'gpt-4o-mini-transcribe',
        'gpt-4o-transcribe',
        'gpt-4o-transcribe-diarize',
        'whisper-1'
      ],
      realtimeSttModels: ['gpt-realtime-whisper']
    })
    expect(result.find((entry) => entry.id === 'deepgram')).toMatchObject({
      defaultModel: 'aura-2-asteria-en',
      defaultTtsModel: 'aura-2-asteria-en',
      defaultSttModel: 'nova-3',
      defaultRealtimeSttModel: 'flux-general-en',
      sttModels: [
        'nova-3',
        'nova-3-general',
        'nova-3-medical',
        'nova-2',
        'nova-2-general',
        'nova-2-meeting',
        'nova-2-phonecall',
        'nova-2-finance',
        'nova-2-conversationalai',
        'nova-2-voicemail',
        'nova-2-video',
        'nova-2-medical',
        'nova-2-drivethru',
        'nova-2-automotive',
        'nova-2-atc',
        'whisper',
        'whisper-tiny',
        'whisper-base',
        'whisper-small',
        'whisper-medium',
        'whisper-large'
      ],
      realtimeSttModels: ['flux-general-en', 'flux-general-multi']
    })
    expect(result.find((entry) => entry.id === 'fish')).toMatchObject({
      defaultSttModel: 'transcribe-1',
      sttModels: ['transcribe-1']
    })
    expect(result.find((entry) => entry.id === 'elevenlabs')).toMatchObject({
      supports: {
        stt: true
      },
      defaultSttModel: 'scribe_v2',
      defaultRealtimeSttModel: 'scribe_v2_realtime',
      sttModels: ['scribe_v2'],
      realtimeSttModels: ['scribe_v2_realtime'],
      ttsModels: ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_flash_v2']
    })
    expect(result.find((entry) => entry.id === 'mistral')).toMatchObject({
      supports: {
        listVoices: true
      },
      defaultTtsModel: 'voxtral-mini-tts-2603',
      defaultSttModel: 'voxtral-mini-latest',
      defaultRealtimeSttModel: 'voxtral-mini-transcribe-realtime-2602',
      ttsModels: ['voxtral-mini-tts-2603'],
      sttModels: ['voxtral-mini-latest', 'voxtral-mini-2602'],
      realtimeSttModels: ['voxtral-mini-transcribe-realtime-2602']
    })
  })

  it('filters OpenAI TTS voices by selected model support', async () => {
    const { listVoices } = await import('../services/voiceService')

    const latestVoices = await listVoices({
      userId: 'user-1',
      provider: 'openai',
      model: 'gpt-4o-mini-tts'
    })
    const legacyVoices = await listVoices({
      userId: 'user-1',
      provider: 'openai',
      model: 'tts-1'
    })

    expect(latestVoices.map((voice) => voice.id)).toEqual(
      expect.arrayContaining(['alloy', 'ballad', 'verse', 'marin', 'cedar'])
    )
    expect(legacyVoices.map((voice) => voice.id)).toEqual(
      expect.arrayContaining(['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'])
    )
    expect(legacyVoices.map((voice) => voice.id)).not.toEqual(
      expect.arrayContaining(['ballad', 'verse', 'marin', 'cedar'])
    )
  })

  it('fails loudly when uploaded-audio Deepgram STT is asked to use a realtime Flux model', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'deepgram' ? 'dg-test-key-1234567890' : null
    )

    const { transcribeAudio } = await import('../services/voiceService')

    await expect(
      transcribeAudio({
        audio: new Uint8Array([1, 2, 3]),
        provider: 'deepgram',
        userId: 'user-1',
        model: 'flux-general-en',
        contentType: 'audio/wav'
      })
    ).rejects.toThrow(
      'Deepgram Flux models are realtime-only in Batshit. Use Voice Mode for Flux, or choose a non-Flux Deepgram model for uploaded-audio transcription.'
    )

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('transcribes uploaded audio through Fish ASR', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fish' ? 'fish-test-key-1234567890' : null
    )
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'fish heard this',
          language: 'en',
          confidence: 0.91,
          segments: [{ text: 'fish' }]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({
      audio: new Uint8Array([1, 2, 3]),
      provider: 'fish',
      userId: 'user-1',
      language: 'en',
      contentType: 'audio/wav'
    })

    const [url, request] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.fish.audio/v1/asr')
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer fish-test-key-1234567890'
    })
    expect(request.body.get('audio')).toBeInstanceOf(Blob)
    expect(request.body.get('language')).toBe('en')
    expect(result).toMatchObject({
      text: 'fish heard this',
      language: 'en',
      confidence: 0.91,
      segments: [{ text: 'fish' }]
    })
  })

  it('uses engine-level STT language when transcription request has no language override', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fish' ? 'fish-test-key-1234567890' : null
    )
    mockGetUserSettings.mockResolvedValue({
      user_id: 'user-1',
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'fish'
        },
        sttEngineSettings: {
          fish: {
            language: 'en'
          }
        }
      }
    })
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'engine language worked',
          language: 'en'
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { transcribeAudio } = await import('../services/voiceService')
    await transcribeAudio({
      audio: new Uint8Array([1, 2, 3]),
      provider: 'fish',
      userId: 'user-1',
      contentType: 'audio/wav'
    })

    const [, request] = mockFetch.mock.calls[0]
    expect(request.body.get('language')).toBe('en')
  })

  it('transcribes uploaded audio through ElevenLabs Scribe', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'elevenlabs' ? 'elevenlabs-placeholder' : null
    )
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'eleven heard this',
          language_code: 'en',
          language_probability: 0.98,
          words: [{ text: 'eleven', start: 0, end: 0.4 }]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({
      audio: new Uint8Array([1, 2, 3]),
      provider: 'elevenlabs',
      userId: 'user-1',
      model: 'scribe_v2',
      language: 'en',
      contentType: 'audio/wav'
    })

    const [url, request] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(request.headers).toMatchObject({
      'xi-api-key': 'elevenlabs-placeholder'
    })
    expect(request.body.get('model_id')).toBe('scribe_v2')
    expect(request.body.get('file')).toBeInstanceOf(Blob)
    expect(request.body.get('language_code')).toBe('en')
    expect(result).toMatchObject({
      text: 'eleven heard this',
      language: 'en',
      confidence: 0.98,
      segments: [{ text: 'eleven', start: 0, end: 0.4 }]
    })
  })

  it('transcribes uploaded audio through Mistral Voxtral', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'mistral' ? 'mistral-test-key-1234567890' : null
    )
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'mistral heard this',
          language: 'en',
          segments: [{ text: 'mistral', start: 0, end: 0.5 }]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({
      audio: new Uint8Array([1, 2, 3]),
      provider: 'mistral',
      userId: 'user-1',
      model: 'voxtral-mini-2602',
      language: 'en',
      contentType: 'audio/wav'
    })

    const [url, request] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.mistral.ai/v1/audio/transcriptions')
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer mistral-test-key-1234567890'
    })
    expect(request.body.get('model')).toBe('voxtral-mini-2602')
    expect(request.body.get('file')).toBeInstanceOf(Blob)
    expect(request.body.get('language')).toBe('en')
    expect(request.body.get('timestamp_granularities[]')).toBeNull()
    expect(result).toMatchObject({
      text: 'mistral heard this',
      language: 'en',
      segments: [{ text: 'mistral', start: 0, end: 0.5 }]
    })
  })

  it('streams Fish realtime TTS as Batshit-owned NDJSON events', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fish' ? 'fish-test-key-1234567890' : null
    )
    const audioBase64 = Buffer.from(new Int16Array([0, 1200, -1200, 0]).buffer).toString('base64')
    mockFetch.mockResolvedValue(
      new Response(
        createFishSse(
          {
            audio_base64: audioBase64,
            content: 'Hello',
            alignment: {
              segments: [{ text: 'Hello', start: 0, end: 0.2 }]
            },
            chunk_seq: 0,
            chunk_audio_offset_sec: 0
          }
        ),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream'
          }
        }
      )
    )

    const { streamSpeechRealtime } = await import('../services/voiceService')
    const stream = await streamSpeechRealtime({
      text: 'Hello from Fish.',
      provider: 'fish',
      model: 's2-pro',
      voiceId: 'fish-voice-123',
      userId: 'user-1',
      options: {
        providerOptions: {
          sample_rate: '24000',
          latency: 'balanced',
          chunk_length: 100
        }
      }
    })
    const events = await readRealtimeEvents(stream)

    const [url, request] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.fish.audio/v1/tts/stream/with-timestamp')
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer fish-test-key-1234567890',
      model: 's2-pro'
    })
    expect(JSON.parse(String(request.body))).toMatchObject({
      text: 'Hello from Fish.',
      reference_id: 'fish-voice-123',
      format: 'pcm',
      sample_rate: 24000,
      latency: 'balanced',
      chunk_length: 100
    })
    expect(events).toEqual([
      expect.objectContaining({
        type: 'start',
        provider: 'fish',
        model: 's2-pro',
        voiceId: 'fish-voice-123',
        audioFormat: 'pcm_s16le',
        sampleRate: 24000,
        channels: 1
      }),
      expect.objectContaining({
        type: 'audio',
        sequence: 1,
        audioBase64,
        byteLength: 8,
        content: 'Hello',
        chunkSeq: 0,
        chunkAudioOffsetSec: 0
      }),
      expect.objectContaining({
        type: 'end',
        chunkCount: 1,
        audioBytes: 8
      })
    ])
  })

  it('uses a smoother Fish realtime chunk length when no override is configured', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fish' ? 'fish-test-key-1234567890' : null
    )
    const audioBase64 = Buffer.from(new Int16Array([0, 1200, -1200, 0]).buffer).toString('base64')
    mockFetch.mockResolvedValue(
      new Response(
        createFishSse({
          audio_base64: audioBase64,
          content: 'Hello',
          alignment: {
            segments: [{ text: 'Hello', start: 0, end: 0.2 }]
          },
          chunk_seq: 0,
          chunk_audio_offset_sec: 0
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream'
          }
        }
      )
    )

    const { streamSpeechRealtime } = await import('../services/voiceService')
    const stream = await streamSpeechRealtime({
      text: 'Hello from Fish.',
      provider: 'fish',
      model: 's2-pro',
      voiceId: 'fish-voice-123',
      userId: 'user-1'
    })
    await readRealtimeEvents(stream)

    const [, request] = mockFetch.mock.calls[0]
    expect(JSON.parse(String(request.body))).toMatchObject({
      text: 'Hello from Fish.',
      reference_id: 'fish-voice-123',
      format: 'pcm',
      sample_rate: 24000,
      latency: 'balanced',
      chunk_length: 200
    })
  })

  it('streams Inworld realtime TTS as PCM NDJSON events with word alignment', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'inworld' ? 'inworld-test-key-1234567890' : null
    )
    const wavChunk = createTinyWav()
    const audioBase64 = wavChunk.toString('base64')
    const rawPcmBase64 = Buffer.from([0, 0, 0, 0]).toString('base64')
    const inworldChunk = {
      result: {
        audioContent: audioBase64,
        usage: {
          processedCharactersCount: 18,
          modelId: 'inworld-tts-2'
        },
        timestampInfo: {
          wordAlignment: {
            words: ['', 'Hello', ' ', 'Josh'],
            wordStartTimeSeconds: [0, 0.1, 0.5, 0.5],
            wordEndTimeSeconds: [0.1, 0.5, 0.5, 0.8],
            phoneticDetails: [
              {
                wordIndex: 1,
                phones: [
                  {
                    phoneSymbol: 'h',
                    startTimeSeconds: 0.1,
                    durationSeconds: 0.08,
                    visemeSymbol: 'cdgknstxyz'
                  },
                  {
                    phoneSymbol: 'eh',
                    startTimeSeconds: 0.18,
                    durationSeconds: 0.07,
                    visemeSymbol: 'aei'
                  }
                ]
              },
              {
                wordIndex: 3,
                phones: [
                  {
                    phoneSymbol: 'j',
                    startTimeSeconds: 0.5,
                    durationSeconds: 0.1,
                    visemeSymbol: 'chjsh'
                  }
                ]
              }
            ]
          }
        }
      }
    }
    mockFetch.mockResolvedValue(
      new Response(
        createJsonObjectStream(inworldChunk, inworldChunk),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { streamSpeechRealtime } = await import('../services/voiceService')
    const stream = await streamSpeechRealtime({
      text: 'Hello from Inworld.',
      provider: 'inworld',
      model: 'inworld-tts-2',
      voiceId: 'Dennis',
      userId: 'user-1',
      options: {
        common: {
          language: 'en-US'
        },
        providerOptions: {
          audioEncoding: 'MP3',
          sampleRateHertz: 24000,
          deliveryMode: 'CREATIVE',
          applyTextNormalization: 'ON',
          timestampType: 'WORD',
          timestampTransportStrategy: 'SYNC'
        }
      }
    })
    const events = await readRealtimeEvents(stream)

    const [url, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))
    expect(url).toBe('https://api.inworld.ai/tts/v1/voice:stream')
    expect(request.headers).toMatchObject({
      Authorization: 'Basic inworld-test-key-1234567890',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    })
    expect(body).toMatchObject({
      text: 'Hello from Inworld.',
      voiceId: 'Dennis',
      modelId: 'inworld-tts-2',
      language: 'en-US',
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: 24000
      },
      deliveryMode: 'CREATIVE',
      applyTextNormalization: 'ON',
      timestampType: 'WORD',
      timestampTransportStrategy: 'SYNC'
    })
    expect(events).toEqual([
      expect.objectContaining({
        type: 'start',
        provider: 'inworld',
        model: 'inworld-tts-2',
        voiceId: 'Dennis',
        audioFormat: 'pcm_s16le',
        sampleRate: 24000,
        channels: 1
      }),
      expect.objectContaining({
        type: 'audio',
        sequence: 1,
        audioBase64: rawPcmBase64,
        byteLength: 4,
        content: 'Hello Josh',
        chunkSeq: 0,
        chunkAudioOffsetSec: 0,
        alignment: {
          segments: [
            {
              text: 'Hello',
              start: 0.1,
              end: 0.5,
              phoneticDetails: [
                {
                  phoneSymbol: 'h',
                  startTimeSeconds: 0.1,
                  durationSeconds: 0.08,
                  visemeSymbol: 'cdgknstxyz'
                },
                {
                  phoneSymbol: 'eh',
                  startTimeSeconds: 0.18,
                  durationSeconds: 0.07,
                  visemeSymbol: 'aei'
                }
              ]
            },
            {
              text: 'Josh',
              start: 0.5,
              end: 0.8,
              phoneticDetails: [
                {
                  phoneSymbol: 'j',
                  startTimeSeconds: 0.5,
                  durationSeconds: 0.1,
                  visemeSymbol: 'chjsh'
                }
              ]
            }
          ]
        }
      }),
      expect.objectContaining({
        type: 'audio',
        sequence: 2,
        audioBase64: rawPcmBase64,
        byteLength: 4,
        content: 'Hello Josh',
        chunkSeq: 1
      }),
      expect.objectContaining({
        type: 'end',
        chunkCount: 2,
        audioBytes: 8
      })
    ])
    expect(events[2].chunkAudioOffsetSec).toBeCloseTo(4 / (24000 * 1 * 2), 8)
  })

  it('fails loudly when Fish realtime TTS has no voice selected', async () => {
    mockRetrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fish' ? 'fish-test-key-1234567890' : null
    )

    const { streamSpeechRealtime } = await import('../services/voiceService')

    await expect(
      streamSpeechRealtime({
        text: 'Hello without a voice.',
        provider: 'fish',
        userId: 'user-1'
      })
    ).rejects.toThrow('Fish Audio voice is required')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('marks single-voice BYO lanes as a discussion-required voice surface', async () => {
    mockListVoiceEngineSummaries.mockResolvedValue([
      {
        id: 'kokoro',
        name: 'Kokoro TTS (MLX)',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Kokoro-82M-bf16',
          voiceId: 'af_heart'
        },
        voiceDiscovery: {
          mode: 'none'
        },
        readiness: {
          mode: 'health'
        }
      }
    ])
    mockFetch.mockResolvedValue(
      new Response('', {
        status: 200
      })
    )

    const { buildVoiceProviderSummary } = await import('../services/voiceService')
    const result = await buildVoiceProviderSummary('user-1')
    const provider = result.find((entry) => entry.id === 'byo:kokoro')

    expect(provider).toMatchObject({
      id: 'byo:kokoro',
      defaultVoice: 'af_heart',
      voiceSurface: {
        kind: 'single_voice',
        requiresDiscussion: true,
        voices: ['af_heart']
      }
    })
    expect(provider?.voiceSurface?.summary).toContain('Only one configured default voice')
  })

  it('returns static suite speakers when a BYO suite publishes them via voiceSurface', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'qwen3-tts',
      name: 'Qwen3 TTS Suite',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8013',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
        voiceId: 'Ryan'
      },
      voiceSurface: {
        kind: 'hybrid',
        voices: ['Ryan', 'Aiden', 'Serena', 'Vivian']
      },
      voiceDiscovery: {
        mode: 'none'
      }
    })

    const { listVoices } = await import('../services/voiceService')
    const voices = await listVoices({
      userId: 'user-1',
      provider: 'byo:qwen3-tts'
    })

    expect(voices.map((voice) => voice.id)).toEqual(['Ryan', 'Aiden', 'Serena', 'Vivian'])
  })

  it('routes Qwen suite voice cloning through the hidden base lane', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'batshit-qwen-suite-clone-'))
    vi.stubEnv('HOME', tempHome)

    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'qwen3-tts',
      name: 'Qwen3 TTS Suite',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8013',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
        voiceId: 'Ryan'
      },
      suite: {
        id: 'qwen3-tts',
        role: 'primary'
      }
    })
    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'qwen3-tts',
        name: 'Qwen3 TTS Suite',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
          voiceId: 'Ryan'
        },
        suite: {
          id: 'qwen3-tts',
          role: 'primary'
        }
      },
      {
        id: 'qwen3-tts-base',
        name: 'Qwen3 TTS Base',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: true,
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
          voiceId: 'Ryan'
        },
        suite: {
          id: 'qwen3-tts',
          role: 'clone',
          hidden: true
        }
      }
    ])

    try {
      const { cloneVoice } = await import('../services/voiceService')
      const result = await cloneVoice({
        audio: new Uint8Array([1, 2, 3, 4]),
        provider: 'byo:qwen3-tts',
        name: 'Suite clone',
        userId: 'user-1'
      })

      expect(result.profile).toMatchObject({
        provider: 'byo:qwen3-tts',
        model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
        isClone: true
      })
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  it('uses the globally selected Qwen clone profile for chat synthesis', async () => {
    mockGetUserSettings.mockResolvedValue({
      user_id: 'user-1',
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'byo:qwen3-tts',
          voiceId: 'voice_qwen_clone',
          profileId: 'voice_qwen_clone'
        }
      }
    })
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'qwen3-tts',
      name: 'Qwen3 TTS Suite',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8013',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
        voiceId: 'Ryan',
        providerOptions: {
          qwen_mode: 'custom_voice'
        }
      },
      suite: {
        id: 'qwen3-tts',
        role: 'primary'
      }
    })
    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'qwen3-tts',
        name: 'Qwen3 TTS Suite',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        baseUrl: 'http://127.0.0.1:8013',
        ttsPath: '/v1/audio/speech',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
          voiceId: 'Ryan',
          providerOptions: {
            qwen_mode: 'custom_voice'
          }
        },
        suite: {
          id: 'qwen3-tts',
          role: 'primary'
        }
      },
      {
        id: 'qwen3-tts-base',
        name: 'Qwen3 TTS Base',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: true,
        baseUrl: 'http://127.0.0.1:8013',
        ttsPath: '/v1/audio/speech',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
          voiceId: 'Ryan'
        },
        suite: {
          id: 'qwen3-tts',
          role: 'clone',
          hidden: true
        }
      }
    ])
    mockGetVoiceProfile.mockResolvedValue({
      id: 'voice_qwen_clone',
      user_id: 'user-1',
      name: 'Qwen clone',
      provider: 'byo:qwen3-tts',
      voiceId: 'voice_qwen_clone',
      model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
      isClone: true,
      settings: {
        providerOptions: {
          'byo:qwen3-tts': {
            ref_audio: '/tmp/qwen-reference.wav',
            ref_text: 'Reference text'
          }
        }
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([9, 9, 9]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    await synthesizeSpeech({
      text: 'Speak through the saved global clone profile',
      provider: 'byo:qwen3-tts',
      userId: 'user-1'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
      input: 'Speak through the saved global clone profile',
      voice: 'voice_qwen_clone',
      ref_audio: '/tmp/qwen-reference.wav',
      ref_text: 'Reference text'
    })
  })

  it('resolves metadata voice config with saved profile options before playback starts', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'qwen3-tts',
      name: 'Qwen3 TTS Suite',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: true,
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
        voiceId: 'Ryan',
        common: {
          speed: 1
        }
      }
    })
    mockGetVoiceProfile.mockResolvedValue({
      id: 'voice_qwen_clone',
      user_id: 'user-1',
      name: 'Qwen clone',
      provider: 'byo:qwen3-tts',
      voiceId: 'voice_qwen_clone',
      model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
      isClone: true,
      settings: {
        common: {
          speed: 0.9
        },
        providerOptions: {
          'byo:qwen3-tts': {
            ref_audio: '/tmp/qwen-reference.wav',
            ref_text: 'Reference text'
          }
        }
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    const { resolveVoiceConfigForMetadata } = await import('../services/voiceService')
    const result = await resolveVoiceConfigForMetadata({
      userSettings: {
        user_id: 'user-1',
        voice_settings: {
          schemaVersion: 2,
          tts: {
            providerId: 'byo:qwen3-tts',
            profileId: 'voice_qwen_clone'
          }
        }
      } as any,
      agent: null,
      metadata: {
        tts: true
      }
    })

    expect(result).toMatchObject({
      provider: 'byo:qwen3-tts',
      model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
      voiceId: 'voice_qwen_clone',
      profileId: 'voice_qwen_clone',
      common: {
        speed: 0.9
      },
      providerOptions: {
        ref_audio: '/tmp/qwen-reference.wav',
        ref_text: 'Reference text'
      }
    })
  })

  it('uses engine-level TTS settings and ignores legacy agent advanced options', async () => {
    const { resolveVoiceConfigForMetadata } = await import('../services/voiceService')
    const result = await resolveVoiceConfigForMetadata({
      userSettings: {
        user_id: 'user-1',
        voice_settings: {
          schemaVersion: 2,
          tts: {
            providerId: 'openai',
            modelId: 'gpt-4o-mini-tts',
            voiceId: 'nova'
          },
          ttsEngineSettings: {
            openai: {
              common: {
                speed: 1.15,
                instructions: 'Use engine-level delivery.'
              },
              providerOptions: {
                format: 'wav'
              }
            }
          }
        }
      } as any,
      agent: {
        voice_profile: {
          tts: {
            providerId: 'openai',
            modelId: 'tts-1',
            voiceId: 'alloy',
            common: {
              speed: 2
            },
            providerOptions: {
              openai: {
                format: 'mp3'
              }
            }
          }
        }
      } as any,
      metadata: {
        tts: true
      }
    })

    expect(result).toMatchObject({
      provider: 'openai',
      model: 'tts-1',
      voiceId: 'alloy',
      common: {
        speed: 1.15,
        instructions: 'Use engine-level delivery.'
      },
      providerOptions: {
        format: 'wav'
      }
    })
  })

  it('routes Qwen voice-design synthesis through the hidden design lane', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'qwen3-tts',
      name: 'Qwen3 TTS Suite',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8013',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
        voiceId: 'Ryan'
      },
      suite: {
        id: 'qwen3-tts',
        role: 'primary'
      }
    })
    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'qwen3-tts',
        name: 'Qwen3 TTS Suite',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
          voiceId: 'Ryan'
        },
        suite: {
          id: 'qwen3-tts',
          role: 'primary'
        }
      },
      {
        id: 'qwen3-tts-voice-design',
        name: 'Qwen3 TTS VoiceDesign',
        enabled: true,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        baseUrl: 'http://127.0.0.1:8013',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16'
        },
        suite: {
          id: 'qwen3-tts',
          role: 'voice_design',
          hidden: true
        }
      }
    ])
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([7, 7, 7]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    await synthesizeSpeech({
      text: 'Design me a brave narrator voice.',
      provider: 'byo:qwen3-tts',
      userId: 'user-1',
      options: {
        common: {
          instructions: 'A brave cinematic narrator with a deep resonant tone.'
        },
        providerOptions: {
          qwen_mode: 'voice_design'
        }
      }
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16',
      instruct: 'A brave cinematic narrator with a deep resonant tone.'
    })
  })

  it('does not translate goon emotes into provider-specific speech controls', async () => {
    const qwenRecord = {
      id: 'qwen3-tts',
      name: 'Qwen3 TTS Suite',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'http://127.0.0.1:8013',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
        voiceId: 'Ryan'
      },
      expression: {
        strategy: 'instructions'
      },
      suite: {
        id: 'qwen3-tts',
        role: 'primary'
      }
    }

    mockGetVoiceEngineRecordByProviderId.mockResolvedValue(qwenRecord)
    mockListVoiceEngineRecords.mockResolvedValue([qwenRecord])
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([7, 7, 7]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    await synthesizeSpeech({
      text: 'Hello there',
      sourceText: '🙂 Hello there',
      provider: 'byo:qwen3-tts',
      agentId: 'agent-1',
      userId: 'user-1'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body.input).toBe('Hello there')
    expect(body.instruct).toBeUndefined()
  })

  it('creates a managed reference-audio profile for clone-capable BYO engines', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-clone-'))
    vi.stubEnv('HOME', tempHome)
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'chatterbox-turbo',
      name: 'Chatterbox Turbo (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: true,
      baseUrl: 'http://127.0.0.1:8010',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16'
      }
    })

    try {
      const { cloneVoice } = await import('../services/voiceService')
      const result = await cloneVoice({
        audio: new Uint8Array([1, 2, 3, 4]),
        provider: 'byo:chatterbox-turbo',
        name: 'Warm clone',
        description: 'Reference profile',
        filename: 'sample.mp3',
        referenceText: 'Hello from the reference clip.',
        userId: 'user-1'
      })

      const settings = result.profile.settings as Record<string, any>
      const audioPath = settings.batshitManagedReferenceAudioPath

      expect(result.profile).toMatchObject({
        provider: 'byo:chatterbox-turbo',
        model: 'mlx-community/chatterbox-turbo-fp16',
        isClone: true,
        settings: {
          providerOptions: {
            'byo:chatterbox-turbo': {
              ref_audio: audioPath,
              ref_text: 'Hello from the reference clip.'
            }
          },
          cloneMethod: 'reference-audio'
        }
      })
      expect(path.extname(String(audioPath))).toBe('.mp3')
      expect(await readFile(String(audioPath))).toEqual(Buffer.from([1, 2, 3, 4]))
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  it('stores Docker BYO clone reference audio on the host through the operator', async () => {
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'chatterbox-turbo',
      name: 'Chatterbox Turbo (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: true,
      baseUrl: 'http://127.0.0.1:8012',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16'
      }
    })
    mockSaveHostVoiceReferenceAudioViaOperator.mockImplementation(async (input: any) => ({
      success: true,
      profileId: input.profileId,
      audioPath: `/Users/example/.batshit/voice-profiles/${input.profileId}/reference.wav`,
      dirPath: `/Users/example/.batshit/voice-profiles/${input.profileId}`
    }))

    const { cloneVoice } = await import('../services/voiceService')
    const result = await cloneVoice({
      audio: new Uint8Array([5, 6, 7]),
      provider: 'byo:chatterbox-turbo',
      name: 'Docker clone',
      filename: 'sample.wav',
      contentType: 'audio/wav',
      referenceText: 'Docker host reference sample.',
      userId: 'user-1'
    })

    expect(mockSaveHostVoiceReferenceAudioViaOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        audioBase64: Buffer.from([5, 6, 7]).toString('base64'),
        filename: 'sample.wav',
        contentType: 'audio/wav'
      })
    )
    const settings = result.profile.settings as Record<string, any>
    expect(settings.batshitManagedReferenceAudioPath).toMatch(
      /^\/Users\/example\/\.batshit\/voice-profiles\/voice_.*\/reference\.wav$/
    )
    expect(settings.providerOptions['byo:chatterbox-turbo']).toMatchObject({
      ref_audio: settings.batshitManagedReferenceAudioPath,
      ref_text: 'Docker host reference sample.'
    })
  })

  it('fails clearly when asked to clone through a non-clone-capable BYO engine', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'glm-tts',
      name: 'GLM TTS',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: false,
      baseUrl: 'https://api.example.com',
      ttsPath: '/tts',
      requestFormat: 'openai-compatible'
    })

    const { cloneVoice } = await import('../services/voiceService')

    await expect(
      cloneVoice({
        audio: new Uint8Array([1, 2, 3]),
        provider: 'byo:glm-tts',
        name: 'My cloned voice',
        userId: 'user-1'
      })
    ).rejects.toThrow('Voice cloning is not enabled for provider: byo:glm-tts')
  })

  it('passes managed reference-audio profile settings through BYO openai-compatible synth requests', async () => {
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'mlx-chatterbox',
      name: 'Chatterbox Turbo (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: true,
      baseUrl: 'http://127.0.0.1:8010',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16',
        voiceId: 'default'
      }
    })
    mockGetVoiceProfile.mockResolvedValue({
      id: 'voice_profile_1',
      user_id: 'user-1',
      name: 'Warm clone',
      provider: 'byo:mlx-chatterbox',
      voiceId: 'voice_profile_1',
      model: 'mlx-community/chatterbox-turbo-fp16',
      isClone: true,
      settings: {
        providerOptions: {
          'byo:mlx-chatterbox': {
            ref_audio: '/tmp/reference.wav',
            ref_text: 'Reference text'
          }
        }
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeSpeech } = await import('../services/voiceService')
    await synthesizeSpeech({
      text: 'Speak like the saved profile',
      provider: 'byo:mlx-chatterbox',
      profileId: 'voice_profile_1',
      userId: 'user-1'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/chatterbox-turbo-fp16',
      input: 'Speak like the saved profile',
      voice: 'voice_profile_1',
      ref_audio: '/tmp/reference.wav',
      ref_text: 'Reference text'
    })
  })

  it('normalizes non-wav ref_audio paths before BYO openai-compatible synth requests', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'batshit-ref-audio-'))
    const sourcePath = path.join(tempDir, 'reference.aiff')
    const normalizedPath = path.join(tempDir, 'reference.batshit-normalized.wav')
    await writeFile(sourcePath, createTinyWav())
    mockGetVoiceEngineRecordByProviderId.mockResolvedValue({
      id: 'mlx-chatterbox',
      name: 'Chatterbox Turbo (MLX)',
      enabled: true,
      supportsTts: true,
      supportsStt: false,
      supportsClone: true,
      baseUrl: 'http://127.0.0.1:8010',
      ttsPath: '/v1/audio/speech',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16',
        voiceId: 'default'
      }
    })
    mockGetVoiceProfile.mockResolvedValue({
      id: 'voice_profile_2',
      user_id: 'user-1',
      name: 'Warm clone',
      provider: 'byo:mlx-chatterbox',
      voiceId: 'voice_profile_2',
      model: 'mlx-community/chatterbox-turbo-fp16',
      isClone: true,
      settings: {
        providerOptions: {
          'byo:mlx-chatterbox': {
            ref_audio: sourcePath,
            ref_text: 'Reference text'
          }
        }
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    try {
      const { synthesizeSpeech } = await import('../services/voiceService')
      await synthesizeSpeech({
        text: 'Speak like the saved profile',
        provider: 'byo:mlx-chatterbox',
        profileId: 'voice_profile_2',
        userId: 'user-1'
      })

      const [, request] = mockFetch.mock.calls[0]
      const body = JSON.parse(String(request.body))

      expect(body).toMatchObject({
        model: 'mlx-community/chatterbox-turbo-fp16',
        input: 'Speak like the saved profile',
        voice: 'voice_profile_2',
        ref_audio: normalizedPath,
        ref_text: 'Reference text'
      })
      expect((await readFile(normalizedPath)).byteLength).toBeGreaterThan(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('uses record-level TTS defaults for helper-owned smoke requests', async () => {
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    )

    const { synthesizeByoSpeechForRecord } = await import('../services/voiceService')
    const result = await synthesizeByoSpeechForRecord({
      record: {
        id: 'mlx-chatterbox',
        name: 'Chatterbox Turbo (MLX)',
        enabled: false,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        baseUrl: 'http://127.0.0.1:8100/v1',
        ttsPath: '/audio/speech',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/chatterbox-turbo-fp16',
          voiceId: 'default',
          common: {
            speed: 1.1,
            instructions: 'Speak warmly.'
          },
          providerOptions: {
            format: 'wav',
            lang_code: 'EN',
            num_steps: 4,
            guidance_scale: 1.2,
            speaker_scale: 1.5,
            seed: 42
          }
        }
      },
      text: 'Smoke test'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/chatterbox-turbo-fp16',
      input: 'Smoke test',
      voice: 'default',
      response_format: 'wav',
      speed: 1.1,
      instructions: 'Speak warmly.',
      lang_code: 'EN',
      num_steps: 4,
      guidance_scale: 1.2,
      speaker_scale: 1.5,
      seed: 42
    })
    expect(result).toMatchObject({
      provider: 'byo:mlx-chatterbox',
      model: 'mlx-community/chatterbox-turbo-fp16',
      voiceId: 'default',
      mediaType: 'audio/wav'
    })
  })

  it('falls back to record-level providerOptions.model for helper-owned smoke requests', async () => {
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg'
        }
      })
    )

    const { synthesizeByoSpeechForRecord } = await import('../services/voiceService')
    const result = await synthesizeByoSpeechForRecord({
      record: {
        id: 'mlx-chatterbox',
        name: 'Chatterbox Turbo (MLX)',
        enabled: false,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        baseUrl: 'http://127.0.0.1:8100/v1',
        ttsPath: '/audio/speech',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          providerOptions: {
            model: 'mlx-community/chatterbox-turbo-fp16'
          }
        }
      },
      text: 'Helper smoke test'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      model: 'mlx-community/chatterbox-turbo-fp16',
      input: 'Helper smoke test',
      voice: 'alloy'
    })
    expect(result).toMatchObject({
      provider: 'byo:mlx-chatterbox',
      model: 'mlx-community/chatterbox-turbo-fp16',
      voiceId: 'alloy',
      mediaType: 'audio/mpeg'
    })
  })

  it('merges record-level defaults into batshit-byo helper-owned smoke requests', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          audioBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
          mediaType: 'audio/wav'
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    )

    const { synthesizeByoSpeechForRecord } = await import('../services/voiceService')
    const result = await synthesizeByoSpeechForRecord({
      record: {
        id: 'generic-tts',
        name: 'Generic Hosted TTS',
        enabled: false,
        supportsTts: true,
        supportsStt: false,
        supportsClone: false,
        baseUrl: 'https://api.example.com',
        ttsPath: '/tts',
        requestFormat: 'batshit-byo',
        ttsDefaults: {
          common: {
            speed: 0.9,
            instructions: 'Use a calm tone.'
          },
          providerOptions: {
            format: 'wav',
            emphasis: 'soft'
          }
        }
      },
      text: 'BYO helper smoke'
    })

    const [, request] = mockFetch.mock.calls[0]
    const body = JSON.parse(String(request.body))

    expect(body).toMatchObject({
      text: 'BYO helper smoke',
      options: {
        common: {
          speed: 0.9,
          instructions: 'Use a calm tone.'
        },
        providerOptions: {
          format: 'wav',
          emphasis: 'soft'
        }
      }
    })
    expect(result).toMatchObject({
      provider: 'byo:generic-tts',
      mediaType: 'audio/wav'
    })
    expect(Array.from(result.audio)).toEqual([1, 2, 3, 4])
  })
})

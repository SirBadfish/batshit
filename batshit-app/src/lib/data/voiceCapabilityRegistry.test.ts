import { describe, expect, it } from 'vitest'
import { getVoiceProviderCapability, validateVoiceOptionsForProvider } from './voiceCapabilityRegistry'

describe('voiceCapabilityRegistry BYO validation', () => {
  it('reports Fish and Inworld as built-in direct realtime TTS providers', () => {
    expect(getVoiceProviderCapability('fish')?.supports.streaming).toBe(true)
    expect(getVoiceProviderCapability('inworld')?.supports.streaming).toBe(true)
    expect(getVoiceProviderCapability('openai')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('elevenlabs')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('deepgram')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('minimax')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('mimo')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('alibaba')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('cartesia')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('async')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('stepfun')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('azure')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('byo')?.supports.streaming).toBe(false)
    expect(getVoiceProviderCapability('byo:qwen3-tts')?.supports.streaming).toBe(false)
  })

  it('keeps STT capability claims separate from realtime TTS claims', () => {
    expect(getVoiceProviderCapability('browser')?.sttCapabilities).toMatchObject({
      realtime: true,
      recorded: false,
      cost: 'free',
      transport: 'browser-api'
    })
    expect(getVoiceProviderCapability('fish')).toMatchObject({
      supports: {
        stt: true,
        listVoices: true,
        streaming: true
      },
      sttCapabilities: {
        recorded: true,
        realtime: false,
        transport: 'http-upload',
        runtimeSupport: 'supported'
      }
    })
    expect(getVoiceProviderCapability('deepgram')?.sttCapabilities).toMatchObject({
      recorded: true,
      realtime: true,
      runtimeSupport: 'supported',
      transport: 'provider-websocket'
    })
    expect(getVoiceProviderCapability('elevenlabs')?.sttCapabilities).toMatchObject({
      recorded: true,
      realtime: false,
      runtimeSupport: 'supported',
      transport: 'http-upload'
    })
    expect(getVoiceProviderCapability('mistral')?.sttCapabilities).toMatchObject({
      recorded: true,
      realtime: false,
      runtimeSupport: 'supported',
      transport: 'http-upload'
    })
    expect(getVoiceProviderCapability('mistral')).toMatchObject({
      supports: {
        listVoices: true
      },
      voiceSource: 'remote'
    })
  })

  it('validates Fish realtime provider options', () => {
    const result = validateVoiceOptionsForProvider('fish', 'tts', {
      common: {
        speed: 1.1,
        volume: -3
      },
      providerOptions: {
        format: 'pcm',
        sample_rate: '24000',
        latency: 'balanced',
        chunk_length: 100
      }
    })

    expect(result.common).toEqual({
      speed: 1.1,
      volume: -3
    })
    expect(result.providerOptions).toEqual({
      format: 'pcm',
      sample_rate: '24000',
      latency: 'balanced',
      chunk_length: 100
    })
  })

  it('validates new cloud TTS provider options without marking them realtime', () => {
    expect(getVoiceProviderCapability('cartesia')).toMatchObject({
      supports: {
        tts: true,
        stt: false,
        streaming: false
      },
      voiceSource: 'remote'
    })

    const result = validateVoiceOptionsForProvider('minimax', 'tts', {
      common: {
        speed: 1.1,
        volume: 1.2
      },
      providerOptions: {
        format: 'wav',
        sample_rate: '32000',
        bitrate: 128000,
        pitch: 0,
        language_boost: 'auto'
      }
    })

    expect(result.common).toEqual({
      speed: 1.1,
      volume: 1.2
    })
    expect(result.providerOptions).toEqual({
      format: 'wav',
      sample_rate: '32000',
      bitrate: 128000,
      pitch: 0,
      language_boost: 'auto'
    })
  })

  it('validates Inworld realtime TTS provider options', () => {
    const capability = getVoiceProviderCapability('inworld')
    expect(capability).toMatchObject({
      supports: {
        tts: true,
        stt: false,
        streaming: true
      },
      voiceSource: 'remote'
    })

    const result = validateVoiceOptionsForProvider('inworld', 'tts', {
      common: {
        language: 'en-US'
      },
      providerOptions: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: 24000,
        deliveryMode: 'CREATIVE',
        applyTextNormalization: 'ON',
        timestampType: 'WORD',
        timestampTransportStrategy: 'SYNC'
      }
    })

    expect(result.common).toEqual({
      language: 'en-US'
    })
    expect(result.providerOptions).toEqual({
      audioEncoding: 'LINEAR16',
      sampleRateHertz: 24000,
      deliveryMode: 'CREATIVE',
      applyTextNormalization: 'ON',
      timestampType: 'WORD',
      timestampTransportStrategy: 'SYNC'
    })
  })

  it('allows custom BYO provider options and common fields to pass through', () => {
    const result = validateVoiceOptionsForProvider('byo:mock-engine', 'tts', {
      common: {
        speed: 1.1,
        instructions: 'Warm and friendly',
        expressive_mode: 'cinematic'
      },
      providerOptions: {
        style_strength: 0.7,
        use_cache: true,
        prompt_prefix: 'Narrator'
      }
    })

    expect(result.common).toEqual({
      speed: 1.1,
      instructions: 'Warm and friendly',
      expressive_mode: 'cinematic'
    })
    expect(result.providerOptions).toEqual({
      style_strength: 0.7,
      use_cache: true,
      prompt_prefix: 'Narrator'
    })
  })

  it('still rejects unsupported provider options for non-BYO providers', () => {
    expect(() =>
      validateVoiceOptionsForProvider('openai', 'tts', {
        providerOptions: {
          style_strength: 0.9
        }
      })
    ).toThrow('OpenAI does not support provider option "style_strength".')
  })

  it('rejects non-primitive BYO option values', () => {
    expect(() =>
      validateVoiceOptionsForProvider('byo:mock-engine', 'stt', {
        providerOptions: {
          punctuate: {
            enabled: true
          }
        }
      })
    ).toThrow('BYO provider option "punctuate" must be a string, number, or boolean.')
  })
})

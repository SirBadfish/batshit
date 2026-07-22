import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
  DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD,
  flattenLegacyVoiceStyle,
  normalizeAgentVoiceProfile,
  normalizeVoiceModeTurnSettings,
  normalizeVoiceSettings
} from './voiceSchema'

describe('voiceSchema legacy cutover normalization', () => {
  it('normalizes Fish Audio as a built-in voice provider', () => {
    const normalized = normalizeVoiceSettings({
      tts: {
        providerId: 'fish',
        modelId: 's2-pro',
        providerOptions: {
          fish: {
            reference_id: 'fish-voice-123'
          }
        }
      },
      stt: { providerId: 'browser' }
    })

    expect(normalized.tts?.providerId).toBe('fish')
    expect(normalized.tts?.modelId).toBe('s2-pro')
    expect(normalized.tts?.voiceId).toBe('fish-voice-123')
    expect(normalized.tts?.providerOptions?.fish).toBeUndefined()
  })

  it('normalizes legacy agent voice_profile style fields into v2 shape', () => {
    const normalized = normalizeAgentVoiceProfile({
      provider: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      voiceId: 'voice_123',
      profileId: 'profile_abc',
      style: {
        speed: '1.15',
        stability: 0.42,
        similarity: 0.81,
        style: 0.35,
        speakerBoost: true
      }
    })

    expect(normalized).toEqual({
      schemaVersion: 2,
      tts: {
        providerId: 'elevenlabs',
        modelId: 'eleven_multilingual_v2',
        voiceId: 'voice_123',
        profileId: 'profile_abc',
        common: {
          speed: 1.15
        },
        providerOptions: {
          elevenlabs: {
            stability: 0.42,
            similarityBoost: 0.81,
            style: 0.35,
            speakerBoost: true
          }
        }
      }
    })
  })

  it('normalizes agent-level STT overrides alongside TTS overrides', () => {
    const normalized = normalizeAgentVoiceProfile({
      voiceSessionRuntime: 'livekit',
      tts: {
        providerId: 'elevenlabs',
        modelId: 'eleven_multilingual_v2',
        voiceId: 'voice_123'
      },
      stt: {
        providerId: 'deepgram',
        modelId: 'flux-general-en',
        language: 'en'
      }
    })

    expect(normalized).toMatchObject({
      schemaVersion: 2,
      voiceSessionRuntime: 'livekit',
      tts: {
        providerId: 'elevenlabs',
        modelId: 'eleven_multilingual_v2',
        voiceId: 'voice_123'
      },
      stt: {
        providerId: 'deepgram',
        modelId: 'flux-general-en',
        language: 'en'
      }
    })
  })

  it('keeps runtime-only agent voice overrides instead of dropping them', () => {
    expect(normalizeAgentVoiceProfile({ voiceSessionRuntime: 'direct' })).toEqual({
      schemaVersion: 2,
      voiceSessionRuntime: 'direct',
      tts: undefined,
      stt: undefined,
      realtimeStt: undefined
    })
  })

  it('keeps normal transcription STT separate from realtime Voice Mode STT', () => {
    const global = normalizeVoiceSettings({
      voiceSessionRuntime: 'livekit',
      voiceRuntimes: {
        livekit: {
          startup: {
            autoStartOnLaunch: true
          }
        }
      },
      stt: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini-transcribe',
        language: 'en'
      },
      realtimeStt: {
        providerId: 'deepgram',
        modelId: 'flux-general-en',
        language: 'en-US'
      },
      voiceMode: {
        inputMode: 'text',
        submitMode: 'manual',
        autoSubmitDelayMs: 3200,
        endOfTurnThreshold: 0.85
      }
    })

    expect(global.stt).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-4o-mini-transcribe',
      language: 'en'
    })
    expect(global.voiceSessionRuntime).toBe('livekit')
    expect(global.voiceRuntimes?.livekit?.startup?.autoStartOnLaunch).toBe(true)
    expect(global.realtimeStt).toMatchObject({
      providerId: 'deepgram',
      modelId: 'flux-general-en',
      language: 'en-US'
    })
    expect(global.voiceMode).toEqual({
      inputMode: 'text',
      submitMode: 'manual',
      autoSubmitDelayMs: 3200,
      endOfTurnThreshold: 0.85
    })
    expect(normalizeVoiceSettings({ voiceSessionRuntime: 'unknown' }).voiceSessionRuntime).toBe('direct')
  })

  it('normalizes per-TTS-engine prompts by provider id', () => {
    const normalized = normalizeVoiceSettings({
      ttsEnginePrompts: {
        OpenAI: {
          prompt: '  Use bracketed breath cues only when natural.  '
        },
        'byo:Kokoro': {
          prompt: 'Preserve [laughs] and [sighs].'
        },
        unknown: {
          prompt: 'Drop me.'
        },
        fish: ''
      }
    })

    expect(normalized.ttsEnginePrompts).toEqual({
      openai: {
        prompt: 'Use bracketed breath cues only when natural.'
      },
      'byo:kokoro': {
        prompt: 'Preserve [laughs] and [sighs].'
      }
    })
  })

  it('lifts legacy selected-provider advanced settings into engine-level maps', () => {
    const normalized = normalizeVoiceSettings({
      tts: {
        providerId: 'openai',
        common: {
          speed: 1.15,
          language: 'en'
        },
        providerOptions: {
          openai: {
            format: 'wav',
            speed_format: 'legacy'
          }
        }
      },
      stt: {
        providerId: 'openai',
        language: 'en',
        providerOptions: {
          openai: {
            temperature: 0.2
          }
        }
      },
      realtimeStt: {
        providerId: 'deepgram',
        language: 'en-US',
        providerOptions: {
          deepgram: {
            endpointing: '120'
          }
        }
      },
      ttsEngineSettings: {
        openai: {
          common: {
            volume: 0.8
          },
          providerOptions: {
            format: 'mp3'
          }
        }
      },
      sttEngineSettings: {
        openai: {
          language: 'fr'
        },
        deepgram: {
          providerOptions: {
            interim_results: true
          }
        }
      }
    })

    expect(normalized.ttsEngineSettings).toEqual({
      openai: {
        common: {
          speed: 1.15,
          language: 'en',
          volume: 0.8
        },
        providerOptions: {
          format: 'mp3',
          speed_format: 'legacy'
        }
      }
    })
    expect(normalized.sttEngineSettings).toEqual({
      openai: {
        language: 'fr',
        providerOptions: {
          temperature: 0.2
        }
      },
      deepgram: {
        language: 'en-US',
        providerOptions: {
          endpointing: '120',
          interim_results: true
        }
      }
    })
  })

  it('normalizes Voice Mode turn settings into the supported tuning range', () => {
    expect(normalizeVoiceModeTurnSettings(null)).toEqual({
      inputMode: 'stt',
      submitMode: 'auto',
      autoSubmitDelayMs: DEFAULT_VOICE_MODE_AUTO_SUBMIT_DELAY_MS,
      endOfTurnThreshold: DEFAULT_VOICE_MODE_END_OF_TURN_THRESHOLD
    })

    expect(
      normalizeVoiceModeTurnSettings({
        submitMode: 'manual',
        inputMode: 'text',
        autoSubmitDelayMs: 50_000,
        endOfTurnThreshold: 5
      })
    ).toEqual({
      inputMode: 'text',
      submitMode: 'manual',
      autoSubmitDelayMs: 5000,
      endOfTurnThreshold: 0.9
    })
  })

  it('keeps agent Voice Mode input overrides separate from STT provider overrides', () => {
    const normalized = normalizeAgentVoiceProfile({
      voiceModeInputMode: 'text'
    })

    expect(normalized).toEqual({
      schemaVersion: 2,
      voiceSessionRuntime: undefined,
      voiceModeInputMode: 'text',
      tts: undefined,
      stt: undefined,
      realtimeStt: undefined
    })
  })

  it('keeps agent Voice Mode turn overrides separate from STT provider overrides', () => {
    const normalized = normalizeAgentVoiceProfile({
      voiceMode: {
        inputMode: 'stt',
        submitMode: 'manual',
        autoSubmitDelayMs: 2800,
        endOfTurnThreshold: 0.82
      }
    })

    expect(normalized).toEqual({
      schemaVersion: 2,
      voiceSessionRuntime: undefined,
      voiceModeInputMode: 'stt',
      voiceMode: {
        inputMode: 'stt',
        submitMode: 'manual',
        autoSubmitDelayMs: 2800,
        endOfTurnThreshold: 0.82
      },
      tts: undefined,
      stt: undefined,
      realtimeStt: undefined
    })
  })

  it('keeps STT-only agent voice profiles instead of dropping them', () => {
    const normalized = normalizeAgentVoiceProfile({
      sttProvider: 'openai',
      sttModel: 'gpt-4o-mini-transcribe',
      sttLanguage: 'en'
    })

    expect(normalized).toEqual({
      schemaVersion: 2,
      tts: undefined,
      stt: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini-transcribe',
        language: 'en',
        providerOptions: undefined
      }
    })
  })

  it('normalizes legacy global voice settings and rewrites byo provider options to keyed provider id', () => {
    const normalized = normalizeVoiceSettings({
      autoMuteZips: true,
      goonLipSyncMode: 'viseme',
      ttsProvider: 'byo',
      ttsModel: 'my-model',
      ttsVoiceId: 'my-voice',
      tts: {
        providerId: 'byo',
        modelId: 'my-model',
        voiceId: 'my-voice',
        providerOptions: {
          byo: {
            temperature: 0.5,
            character: 'narrator'
          }
        }
      },
      sttProvider: 'openai',
      sttModel: 'whisper-1',
      byo: {
        id: 'speech-lab',
        name: 'Speech Lab',
        baseUrl: 'http://127.0.0.1:9000',
        ttsPath: '/tts'
      }
    })

    expect(normalized.schemaVersion).toBe(2)
    expect(normalized.goonLipSync?.mode).toBe('viseme')
    expect(normalized.tts?.providerId).toBe('byo:speech-lab')
    expect(normalized.tts?.modelId).toBe('my-model')
    expect(normalized.tts?.voiceId).toBe('my-voice')
    expect(normalized.tts?.providerOptions).toEqual({
      'byo:speech-lab': {
        temperature: 0.5,
        character: 'narrator'
      }
    })
    expect(normalized).not.toHaveProperty('autoMuteZips')
    expect(normalized.byoProviders).toEqual([
      expect.objectContaining({
        id: 'speech-lab',
        name: 'Speech Lab'
      })
    ])
  })

  it('round-trips v2 provider options back into legacy style for compatibility surfaces', () => {
    const style = flattenLegacyVoiceStyle({
      providerId: 'openai',
      common: {
        speed: 0.9,
        instructions: 'Calm and clear'
      },
      providerOptions: {
        openai: {
          format: 'wav'
        }
      }
    })

    expect(style).toEqual({
      speed: 0.9,
      instructions: 'Calm and clear',
      format: 'wav'
    })
  })

  it('defaults goon lip sync to amplitude when the setting is absent', () => {
    const normalized = normalizeVoiceSettings({
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    expect(normalized.goonLipSync?.mode).toBe('amplitude')
    expect(normalized.goonLipSync?.analyzerId).toBe('rhubarb-wasm')
    expect(normalized.goonLipSync?.visemeBlendMs).toBe(35)
  })

  it('normalizes the italic narration TTS setting', () => {
    const silent = normalizeVoiceSettings({
      tts: {
        providerId: 'browser',
        narration: {
          italicBehavior: 'silent'
        }
      },
      stt: { providerId: 'browser' }
    })

    const invalid = normalizeVoiceSettings({
      tts: {
        providerId: 'browser',
        narration: {
          italicBehavior: 'mumble'
        }
      },
      stt: { providerId: 'browser' }
    })

    expect(silent.tts?.narration?.italicBehavior).toBe('silent')
    expect(invalid.tts?.narration?.italicBehavior).toBe('speak')
  })

  it('normalizes agent italic narration TTS overrides', () => {
    const nested = normalizeAgentVoiceProfile({
      tts: {
        narration: {
          italicBehavior: 'silent'
        }
      }
    })
    const flat = normalizeAgentVoiceProfile({
      ttsItalicNarrationBehavior: 'silent'
    })
    const invalid = normalizeAgentVoiceProfile({
      tts: {
        narration: {
          italicBehavior: 'mumble'
        }
      }
    })

    expect(nested?.tts?.narration?.italicBehavior).toBe('silent')
    expect(flat?.tts?.narration?.italicBehavior).toBe('silent')
    expect(invalid?.tts?.narration?.italicBehavior).toBe('speak')
  })

  it('preserves current analyzers and falls back to Rhubarb for retired or invalid values', () => {
    const retiredWawa = normalizeVoiceSettings({
      goonLipSync: {
        mode: 'viseme',
        analyzerId: 'wawa-lipsync'
      },
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    const saved = normalizeVoiceSettings({
      goonLipSync: {
        mode: 'viseme',
        analyzerId: 'rhubarb-wasm'
      },
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    const audio2Face = normalizeVoiceSettings({
      goonLipSync: {
        mode: 'viseme',
        analyzerId: 'audio2face-3d'
      },
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    const retiredRhubarb = normalizeVoiceSettings({
      goonLipSync: {
        mode: 'viseme',
        analyzerId: 'rhubarb'
      },
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    const fallback = normalizeVoiceSettings({
      goonLipSync: {
        mode: 'viseme',
        analyzerId: 'definitely-not-real'
      },
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    expect(saved.goonLipSync?.analyzerId).toBe('rhubarb-wasm')
    expect(audio2Face.goonLipSync?.analyzerId).toBe('audio2face-3d')
    expect(retiredWawa.goonLipSync?.analyzerId).toBe('rhubarb-wasm')
    expect(retiredRhubarb.goonLipSync?.analyzerId).toBe('rhubarb-wasm')
    expect(fallback.goonLipSync?.analyzerId).toBe('rhubarb-wasm')
  })

  it('normalizes goon viseme blend into the supported tuning range', () => {
    const saved = normalizeVoiceSettings({
      goonLipSync: {
        mode: 'viseme',
        analyzerId: 'rhubarb-wasm',
        visemeBlendMs: 45
      },
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    const clamped = normalizeVoiceSettings({
      goonLipSync: {
        mode: 'viseme',
        analyzerId: 'rhubarb-wasm',
        visemeBlendMs: 999
      },
      tts: { providerId: 'browser' },
      stt: { providerId: 'browser' }
    })

    expect(saved.goonLipSync?.visemeBlendMs).toBe(45)
    expect(clamped.goonLipSync?.visemeBlendMs).toBe(80)
  })
})

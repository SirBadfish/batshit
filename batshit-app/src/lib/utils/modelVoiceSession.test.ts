import { describe, expect, it } from 'vitest'
import {
  getVoiceModeLockLabel,
  inferLiveKitSpeechToSpeechConfig,
  isLiveKitSpeechToSpeechModelPreset,
  normalizeModelVoiceSessionConfig,
  resolveModelVoiceSessionConfig,
  shouldRouteLiveKitRemoteAudioToGoon
} from './modelVoiceSession'
import type { SavedModel } from '$lib/types/savedModels'

function model(overrides: Partial<SavedModel>): SavedModel {
  return {
    id: overrides.id ?? 'model-1',
    modelName: overrides.modelName ?? 'Voice Brain',
    modelId: overrides.modelId ?? 'gpt-realtime',
    provider: overrides.provider ?? 'openai',
    contextWindow: 0,
    pricing: { input: 0, output: 0 },
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
    ...overrides
  }
}

describe('modelVoiceSession', () => {
  it('normalizes explicit LiveKit speech-to-speech config', () => {
    expect(
      normalizeModelVoiceSessionConfig({
        runtime: 'livekit',
        mode: 'speech-to-speech',
        providerId: 'OpenAI'
      })
    ).toMatchObject({
      runtime: 'livekit',
      mode: 'speech-to-speech',
      providerId: 'openai',
      providerLabel: 'OpenAI Realtime',
      defaultModelId: 'gpt-realtime-2',
      supportStatus: 'supported',
      requiresLiveKit: true,
      locksVoiceModeSettings: true,
      includes: {
        stt: true,
        llm: true,
        tts: true
      }
    })
  })

  it('infers OpenAI, Gemini, and Grok realtime presets', () => {
    expect(inferLiveKitSpeechToSpeechConfig('openai', 'gpt-realtime-2')).toMatchObject({
      providerId: 'openai',
      defaultModelId: 'gpt-realtime-2',
      supportStatus: 'supported'
    })
    expect(inferLiveKitSpeechToSpeechConfig('openai', 'gpt-realtime')?.providerId).toBe(
      'openai'
    )
    expect(
      inferLiveKitSpeechToSpeechConfig(
        'google-generative-ai',
        'gemini-3.1-flash-live-preview'
      )?.providerId
    ).toBe('google')
    expect(inferLiveKitSpeechToSpeechConfig('x-ai', 'grok-voice-latest')).toMatchObject({
      providerId: 'xai',
      defaultModelId: 'grok-voice-latest',
      defaultVoiceId: 'ara',
      supportStatus: 'supported'
    })
  })

  it('resolves explicit top-level metadata before inference', () => {
    const resolved = resolveModelVoiceSessionConfig(
      model({
        provider: 'openai',
        modelId: 'gpt-realtime',
        voiceSession: {
          runtime: 'livekit',
          mode: 'speech-to-speech',
          providerId: 'google',
          providerLabel: 'Gemini Live'
        }
      })
    )

    expect(resolved?.providerId).toBe('google')
    expect(resolved?.providerLabel).toBe('Gemini Live')
  })

  it('exposes lock copy for selected speech-to-speech presets', () => {
    const preset = model({
      modelName: 'OpenAI Realtime Voice',
      voiceSession: {
        runtime: 'livekit',
        mode: 'speech-to-speech',
        providerId: 'openai'
      }
    })

    expect(isLiveKitSpeechToSpeechModelPreset(preset)).toBe(true)
    expect(getVoiceModeLockLabel(preset)).toContain('already includes listening, reasoning, and speaking')
  })

  it('routes LiveKit room audio to Goons only for true speech-to-speech', () => {
    expect(
      shouldRouteLiveKitRemoteAudioToGoon({
        runtime: 'livekit',
        mode: 'speech-to-speech'
      })
    ).toBe(true)
    expect(shouldRouteLiveKitRemoteAudioToGoon(null)).toBe(false)
    expect(
      shouldRouteLiveKitRemoteAudioToGoon({
        runtime: 'livekit',
        mode: 'bridge'
      } as Parameters<typeof shouldRouteLiveKitRemoteAudioToGoon>[0])
    ).toBe(false)
  })
})

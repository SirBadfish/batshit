import { describe, expect, it } from 'vitest'
import { OPENAI_TTS_VOICES } from './voiceModelCatalog'
import { detectSpeechModel, getSpeechProviderInfo } from './speechModelDetection'

describe('artifact speech model detection', () => {
  it('detects supported OpenAI TTS models through the shared catalog', () => {
    const info = detectSpeechModel('openai/gpt-4o-mini-tts')

    expect(info).toMatchObject({
      type: 'dedicated',
      provider: 'openai',
      supportsVoice: true,
      supportsInstructions: true,
      defaultVoice: OPENAI_TTS_VOICES[0]
    })
    expect(getSpeechProviderInfo('openai/tts-1')).toEqual({
      provider: 'openai',
      factoryModel: 'tts-1'
    })
  })

  it('detects Fal speech models without claiming unrelated provider IDs', () => {
    expect(detectSpeechModel('fal-ai/minimax/speech-02-hd')).toMatchObject({
      type: 'dedicated',
      provider: 'fal',
      supportsVoice: true
    })
    expect(detectSpeechModel('fal-ai/example/fast-tts')).toMatchObject({
      type: 'dedicated',
      provider: 'fal'
    })
    expect(detectSpeechModel('acme/tts-large')).toMatchObject({
      type: 'none',
      provider: null
    })
  })

  it('does not advertise unsupported artifact speech providers', () => {
    expect(detectSpeechModel('eleven_multilingual_v2')).toMatchObject({
      type: 'none',
      provider: null
    })
    expect(detectSpeechModel('lmnt/aurora')).toMatchObject({
      type: 'none',
      provider: null
    })
  })
})

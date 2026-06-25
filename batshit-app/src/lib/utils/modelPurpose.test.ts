import { describe, expect, it } from 'vitest'
import { inferModelPurpose } from './modelPurpose'

describe('inferModelPurpose', () => {
  it('treats embedding models as utility', () => {
    expect(
      inferModelPurpose({
        id: 'openai/text-embedding-3-small',
        name: 'text-embedding-3-small'
      })
    ).toBe('utility')
  })

  it('treats dedicated image models as visual', () => {
    expect(
      inferModelPurpose({
        id: 'google/gemini-2.5-flash-image',
        name: 'gemini-2.5-flash-image',
        tags: ['image-generation']
      })
    ).toBe('visual')

    expect(
      inferModelPurpose({
        id: 'openai/gpt-5-image-mini',
        name: 'gpt-5-image-mini'
      })
    ).toBe('visual')
  })

  it('does not treat chat models with image-generation capability as non-chat', () => {
    expect(
      inferModelPurpose({
        id: 'openai/gpt-5',
        name: 'gpt-5',
        tags: ['vision', 'tool-use', 'image-generation']
      })
    ).toBe('chat')
  })

  it('does not treat audio-preview chat models as non-chat', () => {
    expect(
      inferModelPurpose({
        id: 'openai/gpt-4o-audio-preview',
        name: 'gpt-4o-audio-preview'
      })
    ).toBe('chat')
  })

  it('treats realtime speech-to-speech brains as chat-capable presets', () => {
    expect(
      inferModelPurpose({
        id: 'openai/gpt-realtime',
        name: 'gpt-realtime'
      })
    ).toBe('chat')

    expect(
      inferModelPurpose({
        id: 'google/gemini-2.5-flash-native-audio-preview-12-2025',
        name: 'gemini-2.5-flash-native-audio-preview-12-2025'
      })
    ).toBe('chat')
  })

  it('treats whisper/tts endpoints as audio', () => {
    expect(
      inferModelPurpose({
        id: 'openai/whisper-1',
        name: 'whisper-1'
      })
    ).toBe('audio')

    expect(
      inferModelPurpose({
        id: 'openai/tts-1',
        name: 'tts-1'
      })
    ).toBe('audio')
  })
})

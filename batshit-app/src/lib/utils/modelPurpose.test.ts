import { describe, expect, it } from 'vitest'
import { inferModelPurpose } from './modelPurpose'

describe('inferModelPurpose', () => {
  it('treats provider evaluation endpoints as utility even when their tags say chat', () => {
    expect(inferModelPurpose({ id: 'baseten/elephant-1', modelType: 'evaluation', tags: ['chat', 'vision'] })).toBe('utility')
    expect(inferModelPurpose({ id: 'new-provider/new-decision-id', modelType: 'evaluation' })).toBe('utility')
  })

  it('uses reviewed exact endpoint facts without guessing from elephant or mammoth names', () => {
    for (const [connectionId, id] of [['vercel-gateway', 'baseten/elephant-1'], ['vercel-gateway', 'baseten/mammoth-1'],
      ['direct:baseten', 'decision-models/baseten-elephant-9b-latest'], ['direct:baseten', 'decision-models/baseten-mammoth-27b-latest']]) {
      expect(inferModelPurpose({ connectionId, id, modelType: 'chat' })).toBe('utility')
      expect(inferModelPurpose({ connectionId: 'direct:custom_example', id, modelType: 'chat' })).toBe('chat')
    }
    expect(inferModelPurpose({ id: 'another-maker/elephant-chat', modelType: 'language' })).toBe('chat')
  })

  it('classifies the exact PixVerse generator without reclassifying generic video-understanding chat', () => {
    expect(inferModelPurpose({ connectionId: 'direct:replicate', id: 'pixverse/pixverse-v6-max', tags: ['image', 'video', 'audio'] })).toBe('visual')
    expect(inferModelPurpose({ id: 'xiaomi/mimo-v2.6-pro', modelType: 'chat', tags: ['chat', 'vision', 'video', 'audio'] })).toBe('chat')
  })

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

  it('treats OCR as a chat capability when the model itself is a language model', () => {
    expect(
      inferModelPurpose({
        id: 'anthropic/claude-sonnet-5',
        name: 'claude-sonnet-5',
        modelType: 'language',
        tags: ['reasoning', 'vision', 'ocr', 'chat']
      })
    ).toBe('chat')
  })

  it('still treats dedicated OCR endpoints as utility models', () => {
    expect(
      inferModelPurpose({
        id: 'provider/document-ocr',
        name: 'document-ocr',
        tags: ['ocr']
      })
    ).toBe('utility')
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

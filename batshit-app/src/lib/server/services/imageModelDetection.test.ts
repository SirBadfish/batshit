import { describe, expect, it } from 'vitest'

import {
  detectImageModel,
  isDedicatedImageModel,
  isMultimodalImageModel
} from './imageModelDetection'

describe('imageModelDetection', () => {
  it('recognizes current and forward OpenAI image model IDs as dedicated image models', () => {
    for (const modelId of ['gpt-image-2', 'openai/gpt-image-2', 'chatgpt-image-latest']) {
      expect(isDedicatedImageModel(modelId)).toBe(true)
      expect(detectImageModel(modelId)).toEqual(
        expect.objectContaining({
          type: 'dedicated',
          provider: 'openai',
          supportsSize: true
        })
      )
    }
  })

  it('does not treat OpenAI video model IDs as image generation models', () => {
    expect(isDedicatedImageModel('openai/sora-2')).toBe(false)
    expect(detectImageModel('openai/sora-2')).toEqual(
      expect.objectContaining({
        type: 'text-only',
        provider: null
      })
    )
  })

  it('keeps Replicate Flux models on the Replicate provider instead of the broad Fal Flux route', () => {
    expect(detectImageModel('black-forest-labs/flux-ultra')).toEqual(
      expect.objectContaining({
        type: 'dedicated',
        provider: 'replicate'
      })
    )
  })

  it('recognizes Grok Imagine image models as direct xAI dedicated image models', () => {
    for (const modelId of [
      'grok-imagine-image-quality',
      'xai/grok-imagine-image-quality',
      'grok-imagine-image-quality-latest'
    ]) {
      expect(isDedicatedImageModel(modelId)).toBe(true)
      expect(detectImageModel(modelId)).toEqual(
        expect.objectContaining({
          type: 'dedicated',
          provider: 'xai',
          supportsN: true,
          maxImagesPerCall: 10,
          supportsAspectRatio: true
        })
      )
    }
  })

  it('does not treat xAI chat models as image generation models', () => {
    expect(isDedicatedImageModel('grok-4.3')).toBe(false)
    expect(detectImageModel('grok-4.3')).toEqual(
      expect.objectContaining({
        type: 'text-only',
        provider: null
      })
    )
  })

  it('recognizes current Gemini image models as multimodal image-capable models', () => {
    for (const modelId of ['gemini-3.1-flash-image', 'gemini-3-pro-image']) {
      expect(isMultimodalImageModel(modelId)).toBe(true)
      expect(isDedicatedImageModel(modelId)).toBe(false)
      expect(detectImageModel(modelId)).toEqual(
        expect.objectContaining({
          type: 'multimodal',
          provider: 'google',
          supportsAspectRatio: true
        })
      )
    }
  })
})

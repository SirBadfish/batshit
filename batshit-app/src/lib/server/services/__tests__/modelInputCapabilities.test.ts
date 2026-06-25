import { describe, expect, it } from 'vitest'
import {
  IMAGE_INPUT_UNSUPPORTED_CODE,
  buildImageInputUnsupportedMessage,
  classifyImageInputUnsupportedRuntimeFailure,
  modelAllowsImageInput,
} from '../modelInputCapabilities'

describe('modelInputCapabilities', () => {
  it('allows image input when model capability metadata is unknown', () => {
    expect(modelAllowsImageInput(null)).toBe(true)
    expect(modelAllowsImageInput(undefined)).toBe(true)
    expect(modelAllowsImageInput({})).toBe(true)
  })

  it('blocks image input only when vision is explicitly disabled', () => {
    expect(modelAllowsImageInput({ vision: true })).toBe(true)
    expect(modelAllowsImageInput({ image: true })).toBe(true)
    expect(modelAllowsImageInput({ vision: false })).toBe(false)
  })

  it('builds a user-facing text-only model error', () => {
    expect(IMAGE_INPUT_UNSUPPORTED_CODE).toBe('IMAGE_INPUT_UNSUPPORTED')
    expect(
      buildImageInputUnsupportedMessage({
        imageCount: 2,
        providerId: 'lmstudio',
        modelId: 'llama-text-only',
      }),
    ).toBe(
      'lmstudio / llama-text-only is saved as text-only in Batshit, but this message includes 2 image inputs. Switch to a vision-capable model or remove the image clips.',
    )
  })

  it('classifies provider runtime image-input rejections', () => {
    const result = classifyImageInputUnsupportedRuntimeFailure({
      providerId: 'lmstudio',
      modelId: 'supergemma4-26b-uncensored-v2',
      errorMessage:
        'The provided messages contain images, but supergemma4-26b-uncensored-v2 does not support image inputs.',
    })

    expect(result?.code).toBe(IMAGE_INPUT_UNSUPPORTED_CODE)
    expect(result?.userMessage).toContain('Switch to a vision-capable model')
    expect(result?.userMessage).toContain('Provider error:')
  })

  it('does not classify unrelated provider errors as image-input failures', () => {
    expect(
      classifyImageInputUnsupportedRuntimeFailure({
        providerId: 'lmstudio',
        modelId: 'local-model',
        errorMessage: 'The model is currently loading.',
      }),
    ).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  resolvePresetMaxOutputTokenResolution,
  sanitizeCatalogMaxOutputTokens
} from './modelOutputTokens'

describe('modelOutputTokens', () => {
  it('keeps provider output caps that leave room inside the context window', () => {
    const result = resolvePresetMaxOutputTokenResolution({
      maxOutputTokens: 128_000,
      contextWindow: 400_000
    })

    expect(result).toEqual({
      maxOutputTokens: 128_000,
      estimated: false,
      reason: 'provided'
    })
  })

  it('uses a safe default when the catalog omits max output tokens', () => {
    const result = resolvePresetMaxOutputTokenResolution({
      contextWindow: 400_000
    })

    expect(result).toEqual({
      maxOutputTokens: DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
      estimated: true,
      reason: 'missing'
    })
  })

  it('uses a safe default when max output tokens are context-sized', () => {
    const result = resolvePresetMaxOutputTokenResolution({
      maxOutputTokens: 400_000,
      contextWindow: 400_000
    })

    expect(result).toEqual({
      maxOutputTokens: DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
      estimated: true,
      reason: 'unsafe'
    })
  })

  it('caps the safe default to half of small context windows', () => {
    const result = resolvePresetMaxOutputTokenResolution({
      contextWindow: 8_000
    })

    expect(result.maxOutputTokens).toBe(4_000)
    expect(result.estimated).toBe(true)
  })

  it('drops unsafe catalog defaults but preserves safe catalog output caps', () => {
    expect(
      sanitizeCatalogMaxOutputTokens({
        maxOutputTokens: 256_000,
        contextWindow: 256_000
      })
    ).toBeUndefined()

    expect(
      sanitizeCatalogMaxOutputTokens({
        maxOutputTokens: 64_000,
        contextWindow: 256_000
      })
    ).toBe(64_000)
  })
})

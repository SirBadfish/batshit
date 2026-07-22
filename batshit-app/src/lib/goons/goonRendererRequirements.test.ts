import { describe, expect, it } from 'vitest'

import {
  buildGoonRendererConstructionOptions,
  shouldRetryGoonRendererWithWebGL2
} from './goonRendererRequirements'

describe('Goon renderer requirements', () => {
  it('requests the package texture-array limit from WebGPU', () => {
    expect(buildGoonRendererConstructionOptions(false, 501)).toMatchObject({
      forceWebGL: false,
      requiredLimits: { maxTextureArrayLayers: 501 }
    })
    expect(shouldRetryGoonRendererWithWebGL2(false, 501)).toBe(true)
  })

  it('retries WebGL2 without passing WebGPU-only required limits', () => {
    expect(buildGoonRendererConstructionOptions(true, 501)).toEqual({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      forceWebGL: true
    })
    expect(shouldRetryGoonRendererWithWebGL2(true, 501)).toBe(false)
  })

  it('rejects invalid renderer requirements instead of silently weakening them', () => {
    expect(() => buildGoonRendererConstructionOptions(false, 501.5)).toThrow(
      'non-negative integer'
    )
  })
})

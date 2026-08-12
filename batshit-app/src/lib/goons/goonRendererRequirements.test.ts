import { describe, expect, it } from 'vitest'

import {
  buildGoonRendererConstructionOptions,
  resolveGoonRendererBackendPolicy,
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

  it('uses WebGL2 inside the packaged Mac WebKit shell to avoid the platform WebGPU leak', () => {
    expect(
      resolveGoonRendererBackendPolicy({
        embeddedWebKitRuntime: true,
        debugForceWebGL2: false
      })
    ).toEqual({
      forceWebGL2: true,
      reason: 'embedded-webkit-stability'
    })
  })

  it('keeps ordinary browsers WebGPU-first and retains explicit QA overrides', () => {
    expect(
      resolveGoonRendererBackendPolicy({
        embeddedWebKitRuntime: false,
        debugForceWebGL2: false
      })
    ).toEqual({
      forceWebGL2: false,
      reason: 'default-webgpu'
    })
    expect(
      resolveGoonRendererBackendPolicy({
        explicitForceWebGL2: false,
        embeddedWebKitRuntime: true,
        debugForceWebGL2: true
      })
    ).toEqual({
      forceWebGL2: false,
      reason: 'explicit-webgpu'
    })
  })
})

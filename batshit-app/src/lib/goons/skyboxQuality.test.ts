import { describe, expect, it } from 'vitest'

import { resolveGoonSkyboxTextureBudget } from '$lib/goons/skyboxQuality'

describe('resolveGoonSkyboxTextureBudget', () => {
  it.each([
    ['low', 2048],
    ['auto', 4096],
    ['high', 4096],
    ['ultra', 8192]
  ] as const)('uses the embedded %s skybox budget', (quality, expected) => {
    expect(resolveGoonSkyboxTextureBudget({
      embeddedWebKitRuntime: true,
      quality,
      supportedMaxSize: 16384
    }).effectiveMaxSize).toBe(expected)
  })

  it('caps Ultra to the renderer limit and reports the cap', () => {
    expect(resolveGoonSkyboxTextureBudget({
      embeddedWebKitRuntime: true,
      quality: 'ultra',
      supportedMaxSize: 4096
    })).toEqual({
      requestedMaxSize: 8192,
      effectiveMaxSize: 4096,
      deviceCapped: true
    })
  })
})

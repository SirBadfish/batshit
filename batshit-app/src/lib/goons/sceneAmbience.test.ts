import { describe, expect, it } from 'vitest'

import { normalizeGoonSceneAmbience } from '$lib/goons/sceneAmbience'

describe('scene ambience', () => {
  it('normalizes missing ambience to a disabled whole-stage dust layer', () => {
    expect(normalizeGoonSceneAmbience(null)).toEqual(
      expect.objectContaining({
        enabled: false,
        preset: 'dust',
        placement: 'whole_stage',
        intensity: 0.45,
        speed: 1,
        wind: [0.15, 0]
      })
    )
  })

  it('clamps numeric controls and rejects unknown preset values', () => {
    const normalized = normalizeGoonSceneAmbience({
      enabled: true,
      preset: 'lava' as never,
      placement: 'ceiling' as never,
      intensity: 4,
      speed: -10,
      wind: [99, -99],
      seed: -3
    })

    expect(normalized).toEqual(
      expect.objectContaining({
        enabled: true,
        preset: 'dust',
        placement: 'whole_stage',
        intensity: 1,
        speed: 0.2,
        wind: [2, -2],
        seed: 1
      })
    )
  })

  it('preserves valid built-in ambience choices', () => {
    expect(
      normalizeGoonSceneAmbience({
        enabled: true,
        preset: 'rain',
        placement: 'outside',
        intensity: 0.7,
        speed: 1.35,
        wind: [-0.2, 0.4],
        seed: 42
      })
    ).toEqual({
      enabled: true,
      preset: 'rain',
      placement: 'outside',
      intensity: 0.7,
      speed: 1.35,
      wind: [-0.2, 0.4],
      seed: 42
    })
  })

  it('accepts numeric strings from imported scene data', () => {
    expect(
      normalizeGoonSceneAmbience({
        enabled: true,
        intensity: '0.35' as never,
        speed: '1.25' as never,
        wind: ['-0.3', '0.6'] as never,
        seed: '99' as never
      })
    ).toEqual(
      expect.objectContaining({
        intensity: 0.35,
        speed: 1.25,
        wind: [-0.3, 0.6],
        seed: 99
      })
    )
  })
})

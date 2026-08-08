import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countChangedNailSurfaceControls,
  createDefaultNailSurfaceState,
  createNailSurfacePresenceState,
  nailSurfaceHexToRgb,
  nailSurfaceRgbToHex,
  parseNailSurfaceDefinition,
  parseNailSurfacePresenceState,
  parseNailSurfaceState,
  reconcileNailSurfaceState
} from './nailSurface'

function definition() {
  return parseNailSurfaceDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/nail-surface/v1/nail-surface-v1.json'),
        'utf8'
      )
    )
  )
}

describe('nail-surface/v1', () => {
  it('parses the canonical twenty-plate geometry, controls, templates, and pinky-toe law', () => {
    const contract = definition()
    expect(contract.definitionSha256).toBe(
      '96fd99de666e47f3dac016cdb42c6d1bc4e6d7842fb754055cf53d05e8888612'
    )
    expect(contract.geometry).toMatchObject({
      plateCount: 20,
      nominalThicknessMeters: 0.0003,
      freeEdgeTopBevelMeters: 0,
      fingerPositiveGrowthRiseRatio: 0.18,
      toeShortClearanceRatio: 0.2,
      toeSurfaceProfileLaw:
        'linear-cuticle-to-tip-profile-plus-transverse-quadratic-crown-with-zero-geometric-top-bevel',
      toeTopEdgeNormalLaw: 'hard-top-to-side-boundary'
    })
    expect(contract.controls.fingers.shape.options).toEqual([
      'round',
      'soft-square',
      'almond',
      'pointed'
    ])
    expect(contract.controls.toes.shape.options).toEqual(['round', 'soft-square'])
    expect(contract.geometry.toes.archWeights.pinky).toBe(0)
    expect(contract.geometry.archRiseRatio).toBe(0.3)
    expect(contract.geometry.toeFreeEdgeStart).toBe(0.68)
    expect(contract.geometry.toeGrowthAxisY).toBe(0)
    expect(contract.templates.fingers.slots).toHaveLength(10)
    expect(contract.templates.toes.slots).toHaveLength(10)
    expect(contract.templates.fingers.zoneLaw).toMatchObject({
      cuticleAnchor: [0, 0.22],
      growth: [0.22, 0.78],
      tipAnchor: [0.78, 1]
    })
  })

  it('creates strict linked defaults and accepts narrow pointed claw composition', () => {
    const contract = definition()
    const defaults = createDefaultNailSurfaceState(contract)
    expect(defaults.appearance.linked).toBe(true)
    expect(defaults.appearance.fingers.color).toEqual(defaults.appearance.toes.color)
    expect(countChangedNailSurfaceControls(contract, defaults)).toBe(0)

    const claw = structuredClone(defaults)
    claw.geometry.fingers.length = 1
    claw.geometry.fingers.width = -1
    claw.geometry.fingers.shape = 'pointed'
    claw.geometry.fingers.arch = 1
    expect(parseNailSurfaceState(contract, claw).geometry.fingers).toEqual({
      length: 1,
      width: -1,
      shape: 'pointed',
      arch: 1
    })
    expect(countChangedNailSurfaceControls(contract, claw)).toBe(4)
  })

  it('rejects unsupported toe shapes, stale template proof, and broken link invariants', () => {
    const contract = definition()
    const value = createDefaultNailSurfaceState(contract) as any
    value.geometry.toes.shape = 'pointed'
    expect(() => parseNailSurfaceState(contract, value)).toThrow(/shape is unsupported/)
    value.geometry.toes.shape = 'round'
    value.appearance.toes.color = [0, 0, 0]
    expect(() => parseNailSurfaceState(contract, value)).toThrow(/linked finger\/toe/)
    value.appearance.linked = false
    value.definitionSha256 = 'a'.repeat(64)
    expect(reconcileNailSurfaceState(contract, value)).toMatchObject({
      state: null,
      incompatible: true
    })
  })

  it('normalizes literal sRGB colors for stable Recipe hashes', () => {
    expect(nailSurfaceHexToRgb('#f4dad3')).toEqual([0.956863, 0.854902, 0.827451])
    expect(nailSurfaceRgbToHex(nailSurfaceHexToRgb('#f4dad3')!)).toBe('#f4dad3')
  })

  it('binds an explicit off state to the exact Nail Surface package', () => {
    const contract = definition()
    const presence = createNailSurfacePresenceState(contract, false)
    expect(parseNailSurfacePresenceState(contract, presence)).toEqual({
      schemaVersion: 'nail-surface-presence-state/v1',
      definitionSha256: contract.definitionSha256,
      enabled: false
    })
    expect(() =>
      parseNailSurfacePresenceState(contract, {
        ...presence,
        definitionSha256: 'a'.repeat(64)
      })
    ).toThrow(/does not match/)
  })
})

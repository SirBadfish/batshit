import * as THREE from 'three'
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js'
import { describe, expect, it } from 'vitest'

import {
  applyGroundProjectionLineToGeometry,
  DEFAULT_GROUND_PROJECTION_LINE,
  normalizeGroundProjectionLine,
  reapplyGroundProjectionLineToGeometry,
  remapGroundProjectionUvY
} from '$lib/goons/sceneSkybox'

describe('ground projection line', () => {
  it('defaults invalid values and clamps the saved source row', () => {
    expect(normalizeGroundProjectionLine()).toBe(DEFAULT_GROUND_PROJECTION_LINE)
    expect(normalizeGroundProjectionLine(Number.NaN)).toBe(DEFAULT_GROUND_PROJECTION_LINE)
    expect(normalizeGroundProjectionLine(0.1)).toBe(0.25)
    expect(normalizeGroundProjectionLine(0.9)).toBe(0.75)
  })

  it('keeps the canonical 50% mapping unchanged', () => {
    expect(remapGroundProjectionUvY(0, 0.5)).toBe(0)
    expect(remapGroundProjectionUvY(0.25, 0.5)).toBe(0.25)
    expect(remapGroundProjectionUvY(0.5, 0.5)).toBe(0.5)
    expect(remapGroundProjectionUvY(0.75, 0.5)).toBe(0.75)
    expect(remapGroundProjectionUvY(1, 0.5)).toBe(1)
  })

  it('maps the sphere equator to the selected top-down image row and preserves both poles', () => {
    expect(remapGroundProjectionUvY(0, 0.6)).toBe(0)
    expect(remapGroundProjectionUvY(0.5, 0.6)).toBeCloseTo(0.4, 6)
    expect(remapGroundProjectionUvY(1, 0.6)).toBe(1)

    const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((value) =>
      remapGroundProjectionUvY(value, 0.6)
    )
    expect(samples).toEqual([...samples].sort((a, b) => a - b))
  })

  it('applies the mapping to a fresh sphere without changing its positions', () => {
    const geometry = new THREE.SphereGeometry(5, 8, 4)
    const beforePositions = Array.from(geometry.getAttribute('position').array)

    expect(applyGroundProjectionLineToGeometry(geometry, 0.6)).toBe(true)

    const uv = geometry.getAttribute('uv')
    const equatorValues: number[] = []
    for (let index = 0; index < geometry.getAttribute('position').count; index += 1) {
      if (Math.abs(geometry.getAttribute('position').getY(index)) < 0.0001) {
        equatorValues.push(uv.getY(index))
      }
    }
    expect(equatorValues.length).toBeGreaterThan(0)
    expect(equatorValues.every((value) => Math.abs(value - 0.4) < 0.0001)).toBe(true)
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(beforePositions)
  })

  it('remaps the installed GroundedSkybox UVs without tilting or moving its floor geometry', () => {
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    texture.needsUpdate = true
    const grounded = new GroundedSkybox(texture, 2, 70, 8)
    const beforePositions = Array.from(grounded.geometry.getAttribute('position').array)

    applyGroundProjectionLineToGeometry(grounded.geometry, 0.6)

    const uv = grounded.geometry.getAttribute('uv')
    const position = grounded.geometry.getAttribute('position')
    const boundaryValues: number[] = []
    for (let index = 0; index < position.count; index += 1) {
      if (Math.abs(position.getY(index)) < 0.0001) boundaryValues.push(uv.getY(index))
    }
    expect(boundaryValues.length).toBeGreaterThan(0)
    expect(boundaryValues.every((value) => Math.abs(value - 0.4) < 0.0001)).toBe(true)
    expect(Array.from(position.array)).toEqual(beforePositions)

    grounded.geometry.dispose()
    ;(grounded.material as THREE.Material).dispose()
    texture.dispose()
  })

  it('reapplies live line changes from canonical UVs instead of compounding prior remaps', () => {
    const geometry = new THREE.SphereGeometry(5, 8, 4)
    const canonicalUv = new Float32Array(geometry.getAttribute('uv').array)
    const position = geometry.getAttribute('position')
    const equatorValues = () => {
      const uv = geometry.getAttribute('uv')
      const values: number[] = []
      for (let index = 0; index < position.count; index += 1) {
        if (Math.abs(position.getY(index)) < 0.0001) values.push(uv.getY(index))
      }
      return values
    }

    expect(reapplyGroundProjectionLineToGeometry(geometry, canonicalUv, 0.6)).toBe(true)
    expect(equatorValues().every((value) => Math.abs(value - 0.4) < 0.0001)).toBe(true)

    expect(reapplyGroundProjectionLineToGeometry(geometry, canonicalUv, 0.4)).toBe(true)
    expect(equatorValues().every((value) => Math.abs(value - 0.6) < 0.0001)).toBe(true)

    expect(reapplyGroundProjectionLineToGeometry(geometry, canonicalUv, 0.5)).toBe(true)
    expect(equatorValues().every((value) => Math.abs(value - 0.5) < 0.0001)).toBe(true)

    geometry.dispose()
  })
})

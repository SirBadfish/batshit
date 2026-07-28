import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { OralAppearanceEngineRuntime } from './oralAppearance.engine'
import {
  createDefaultOralAppearanceState,
  parseOralAppearanceDefinition
} from './oralAppearance'

function definition() {
  return parseOralAppearanceDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/oral-appearance/v1/oral-appearance-v1.json'),
        'utf8'
      )
    )
  )
}

function material(name: string, roughness: number) {
  const value = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness })
  value.name = name
  return value
}

function mesh(name: string, value: THREE.Material) {
  const object = new THREE.Mesh(new THREE.BufferGeometry(), value)
  object.name = name
  return object
}

function scene(options: { splitTeethMaterial?: boolean } = {}) {
  const root = new THREE.Group()
  const teeth = material('bs_f1_teeth_mat', 0.23)
  const lowerTeeth = options.splitTeethMaterial ? material('bs_f1_teeth_mat', 0.23) : teeth
  const gums = material('bs_f1_gums_mat', 0.38)
  const tongue = material('bs_f1_tongue_mat', 0.7)
  root.add(
    mesh('bs_f1_upper_teeth', teeth),
    mesh('bs_f1_lower_teeth', lowerTeeth),
    mesh('bs_f1_upper_gums', gums),
    mesh('bs_f1_lower_gums', gums),
    mesh('bs_f1_tongue', tongue)
  )
  return { root, teeth, gums, tongue }
}

describe('OralAppearanceEngineRuntime', () => {
  it('applies color, brightness, and shine and restores authored materials on disposal', () => {
    const contract = definition()
    const value = scene()
    const state = createDefaultOralAppearanceState(contract)
    state.teeth.color = [0.5, 0.25, 1]
    state.teeth.brightness = 1.2
    state.teeth.shine = 0.8
    state.gums.color = [1, 0.5, 0.5]
    state.tongue.color = [0.25, 0.5, 0.75]

    const runtime = new OralAppearanceEngineRuntime(value.root, contract, state)
    const expectedTeeth = new THREE.Color()
      .setRGB(0.5, 0.25, 1, THREE.SRGBColorSpace)
      .multiplyScalar(1.2)
    expect(value.teeth.color.r).toBeCloseTo(expectedTeeth.r)
    expect(value.teeth.color.g).toBeCloseTo(expectedTeeth.g)
    expect(value.teeth.roughness).toBeCloseTo(0.2)
    expect(value.gums.color.g).toBeCloseTo(
      new THREE.Color().setRGB(1, 0.5, 0.5, THREE.SRGBColorSpace).g
    )

    runtime.setState(null)
    expect(value.teeth.color.getHex()).toBe(0xffffff)
    expect(value.teeth.roughness).toBeCloseTo(0.23)
    runtime.setState(state)
    runtime.dispose()
    expect(value.teeth.color.getHex()).toBe(0xffffff)
    expect(value.gums.color.getHex()).toBe(0xffffff)
    expect(value.tongue.color.getHex()).toBe(0xffffff)
    expect(value.teeth.roughness).toBeCloseTo(0.23)
    expect(value.gums.roughness).toBeCloseTo(0.38)
  })

  it('fails loudly for missing nodes or separately instantiated family materials', () => {
    const contract = definition()
    const missing = scene()
    missing.root.remove(missing.root.getObjectByName('bs_f1_tongue')!)
    expect(() => new OralAppearanceEngineRuntime(missing.root, contract, null)).toThrow(
      /bs_f1_tongue, found 0/
    )
    expect(
      () => new OralAppearanceEngineRuntime(scene({ splitTeethMaterial: true }).root, contract, null)
    ).toThrow(/teeth nodes must share one exact material instance/)
  })
})

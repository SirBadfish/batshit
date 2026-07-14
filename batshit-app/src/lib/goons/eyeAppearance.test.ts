import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition,
  parseEyeAppearanceState,
  readEyeAppearanceControl,
  reconcileEyeAppearanceState,
  updateEyeAppearanceControl
} from './eyeAppearance'

function loadDefinition() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/eye-appearance/v1/eye-appearance-v1.json'),
      'utf8'
    )
  )
}

describe('eye-appearance/v1', () => {
  it('parses the actual canonical definition and exact runtime bindings', () => {
    const definition = parseEyeAppearanceDefinition(loadDefinition())
    expect(definition.definitionSha256).toBe(
      'ead3b1bba85b06675aa042943db4b5bc1f562c4aeb8ddc88c9976eb1533c1fa5'
    )
    expect(definition.runtimeBindings.left.eyeBone).toBe('mixamorigLeftEye')
    expect(definition.runtimeBindings.right.horizontalSign).toBe(-1)
    expect(definition.runtimeBindings.left.eyeHighlightMaterialNodes).toEqual([
      'bs_f1_eye_l_iris',
      'bs_f1_eye_l_pupil'
    ])
  })

  it('creates exact linked bilateral defaults and exposes all seven controls', () => {
    const definition = parseEyeAppearanceDefinition(loadDefinition())
    const state = createDefaultEyeAppearanceState(definition)
    expect(state).toEqual({
      schemaVersion: 'eye-appearance-state/v1',
      definitionSha256: definition.definitionSha256,
      irisSize: 1,
      pupilSize: 1,
      scleraFit: { scale: 0, tilt: 0, horizontal: 0, vertical: 0, depth: 0 }
    })
    expect(readEyeAppearanceControl(state, 'sclera_horizontal_position')).toBe(0)
    expect(updateEyeAppearanceControl(state, 'pupil_size', 1.25).pupilSize).toBe(1.25)
  })

  it('rejects per-eye state, stale definitions, and out-of-range values without clamping', () => {
    const definition = parseEyeAppearanceDefinition(loadDefinition())
    const state = createDefaultEyeAppearanceState(definition) as any
    state.left = { irisSize: 1.1 }
    expect(() => parseEyeAppearanceState(definition, state)).toThrow(/unsupported fields/)
    delete state.left
    state.irisSize = 1.351
    expect(() => parseEyeAppearanceState(definition, state)).toThrow(/inside \[0.75, 1.35\]/)
    state.irisSize = 1
    state.definitionSha256 = 'a'.repeat(64)
    expect(reconcileEyeAppearanceState(definition, state)).toMatchObject({ state: null, incompatible: true })
  })
})

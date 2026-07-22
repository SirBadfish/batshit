import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countChangedOralAppearanceControls,
  createDefaultOralAppearanceState,
  oralAppearanceHexToRgb,
  oralAppearanceRgbToHex,
  parseOralAppearanceDefinition,
  parseOralAppearanceState,
  reconcileOralAppearanceState,
  updateOralAppearanceColor,
  updateOralAppearanceNumber
} from './oralAppearance'

function loadDefinition() {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'static/goons/oral-appearance/v1/oral-appearance-v1.json'),
      'utf8'
    )
  )
}

describe('oral-appearance/v1', () => {
  it('parses the canonical five-control definition and exact runtime families', () => {
    const definition = parseOralAppearanceDefinition(loadDefinition())
    expect(definition.definitionSha256).toBe(
      'dffdbe6d9db2840260b3822409f29e927ad82485916b8f288d22e610fe507177'
    )
    expect(definition.controls.map((control) => control.id)).toEqual([
      'teeth_color',
      'teeth_brightness',
      'teeth_shine',
      'gum_color',
      'tongue_color'
    ])
    expect(definition.runtimeBindings.teeth.nodes).toEqual([
      'bs_f1_upper_teeth',
      'bs_f1_lower_teeth'
    ])
    expect(definition.runtimeBindings.tongue.material).toBe('bs_f1_tongue_mat')
  })

  it('creates exact authored defaults and updates each owned field immutably', () => {
    const definition = parseOralAppearanceDefinition(loadDefinition())
    const state = createDefaultOralAppearanceState(definition)
    expect(state).toEqual({
      schemaVersion: 'oral-appearance-state/v1',
      definitionSha256: definition.definitionSha256,
      teeth: { color: [1, 1, 1], brightness: 1, shine: 0.3 },
      gums: { color: [1, 1, 1] },
      tongue: { color: [1, 1, 1] }
    })

    const tinted = updateOralAppearanceColor(state, 'gum_color', [1, 0.5, 0.25])
    const brighter = updateOralAppearanceNumber(tinted, 'teeth_brightness', 1.25)
    expect(brighter.gums.color).toEqual([1, 0.5, 0.25])
    expect(brighter.teeth.brightness).toBe(1.25)
    expect(state.gums.color).toEqual([1, 1, 1])
    expect(oralAppearanceRgbToHex([1, 0.5, 0])).toBe('#ff8000')
    expect(oralAppearanceHexToRgb('#804020')).toEqual([128 / 255, 64 / 255, 32 / 255])
    expect(countChangedOralAppearanceControls(definition, state)).toBe(0)
    expect(countChangedOralAppearanceControls(definition, brighter)).toBe(2)
  })

  it('rejects stale, unknown, out-of-bounds, and off-lattice state', () => {
    const definition = parseOralAppearanceDefinition(loadDefinition())
    const state = createDefaultOralAppearanceState(definition) as any
    state.teeth.texture = 'unsupported.png'
    expect(() => parseOralAppearanceState(definition, state)).toThrow(/unsupported fields/)
    delete state.teeth.texture
    state.teeth.brightness = 1.505
    expect(() => parseOralAppearanceState(definition, state)).toThrow(/inside \[0.5, 1.5\]/)
    state.teeth.brightness = 1.005
    expect(() => parseOralAppearanceState(definition, state)).toThrow(/step lattice/)
    state.teeth.brightness = 1
    state.definitionSha256 = 'a'.repeat(64)
    expect(reconcileOralAppearanceState(definition, state)).toMatchObject({
      state: null,
      incompatible: true
    })
  })

  it('rejects definition defaults that no longer reproduce authored materials', () => {
    const definition = loadDefinition()
    definition.controls[2].default = 0.31
    expect(() => parseOralAppearanceDefinition(definition)).toThrow(
      /Teeth Shine default must preserve authored roughness/
    )
  })
})

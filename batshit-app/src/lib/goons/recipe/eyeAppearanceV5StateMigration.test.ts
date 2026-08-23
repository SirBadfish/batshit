import { describe, expect, it } from 'vitest'

import {
  EYE_APPEARANCE_V5_MIGRATION,
  LEGACY_EYE_APPEARANCE_DEFINITION_V4,
  LEGACY_EYE_APPEARANCE_STATE_V4,
  TARGET_EYE_APPEARANCE_DEFINITION_V5,
  TARGET_EYE_APPEARANCE_STATE_V5,
  migrateEyeAppearanceStateV4ToV5,
  type EyeAppearanceV5StateMigrationInput
} from './eyeAppearanceV5StateMigration'

const SOURCE_HASH = 'a'.repeat(64)
const TARGET_HASH = 'b'.repeat(64)

function input(overrides: Partial<EyeAppearanceV5StateMigrationInput> = {}): EyeAppearanceV5StateMigrationInput {
  return {
    source: {
      schemaVersion: LEGACY_EYE_APPEARANCE_DEFINITION_V4,
      stateSchemaVersion: LEGACY_EYE_APPEARANCE_STATE_V4,
      definitionSha256: SOURCE_HASH,
      bounds: {
        irisSize: [0.45, 1.75],
        pupilSize: [0.35, 1.75],
        irisHorizontalPosition: [-1, 1],
        irisVerticalPosition: [-1, 1]
      }
    },
    target: {
      schemaVersion: TARGET_EYE_APPEARANCE_DEFINITION_V5,
      stateSchemaVersion: TARGET_EYE_APPEARANCE_STATE_V5,
      definitionSha256: TARGET_HASH,
      bounds: {
        irisSize: [0.5, 1.5],
        pupilSize: [0.5, 1.5],
        irisHorizontalPosition: [-1, 1],
        irisVerticalPosition: [-1, 1]
      }
    },
    state: {
      schemaVersion: LEGACY_EYE_APPEARANCE_STATE_V4,
      definitionSha256: SOURCE_HASH,
      irisSize: 1.35,
      pupilSize: 1.4,
      irisHorizontalPosition: -0.5,
      irisVerticalPosition: -0.7
    },
    ...overrides
  }
}

describe('Eye Appearance v4 to v5 saved-state migration', () => {
  it('maps the accepted old appearance to exact new user-facing neutral values', () => {
    expect(EYE_APPEARANCE_V5_MIGRATION).toEqual({
      irisSizeDivisor: 1.35,
      pupilSizeDivisor: 1.4,
      irisHorizontalOffset: 0.5,
      irisVerticalOffset: 0.7
    })
    expect(migrateEyeAppearanceStateV4ToV5(input())).toEqual({
      schemaVersion: TARGET_EYE_APPEARANCE_STATE_V5,
      definitionSha256: TARGET_HASH,
      irisSize: 1,
      pupilSize: 1,
      irisHorizontalPosition: 0,
      irisVerticalPosition: 0
    })
  })

  it('applies the exact affine mapping rather than copying or clamping source values', () => {
    const value = input()
    value.state = {
      schemaVersion: LEGACY_EYE_APPEARANCE_STATE_V4,
      definitionSha256: SOURCE_HASH,
      irisSize: 1.6875,
      pupilSize: 0.98,
      irisHorizontalPosition: -0.25,
      irisVerticalPosition: -0.4
    }
    const result = migrateEyeAppearanceStateV4ToV5(value)
    expect(result).toMatchObject({
      schemaVersion: TARGET_EYE_APPEARANCE_STATE_V5,
      definitionSha256: TARGET_HASH,
      irisSize: 1.25,
      irisHorizontalPosition: 0.25
    })
    expect(result.pupilSize).toBeCloseTo(0.7, 12)
    expect(result.irisVerticalPosition).toBeCloseTo(0.3, 12)
  })

  it('fails loudly when valid source state falls outside target v5 bounds', () => {
    const value = input()
    value.state = {
      schemaVersion: LEGACY_EYE_APPEARANCE_STATE_V4,
      definitionSha256: SOURCE_HASH,
      irisSize: 0.45,
      pupilSize: 1.4,
      irisHorizontalPosition: -0.5,
      irisVerticalPosition: -0.7
    }
    expect(() => migrateEyeAppearanceStateV4ToV5(value)).toThrowError(
      expect.objectContaining({ code: 'OUT_OF_BOUNDS' })
    )

    const travel = input()
    travel.state = {
      schemaVersion: LEGACY_EYE_APPEARANCE_STATE_V4,
      definitionSha256: SOURCE_HASH,
      irisSize: 1.35,
      pupilSize: 1.4,
      irisHorizontalPosition: 1,
      irisVerticalPosition: -0.7
    }
    expect(() => migrateEyeAppearanceStateV4ToV5(travel)).toThrowError(
      expect.objectContaining({ code: 'OUT_OF_BOUNDS' })
    )
  })

  it('rejects wrong schemas, hashes, unknown fields, nonfinite values, and invalid bindings', () => {
    const wrongSchema = input()
    wrongSchema.state = { ...(wrongSchema.state as object), schemaVersion: 'eye-appearance-state/v3' }
    expect(() => migrateEyeAppearanceStateV4ToV5(wrongSchema)).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const wrongHash = input()
    wrongHash.state = { ...(wrongHash.state as object), definitionSha256: 'c'.repeat(64) }
    expect(() => migrateEyeAppearanceStateV4ToV5(wrongHash)).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const unknownField = input()
    unknownField.state = { ...(unknownField.state as object), obsoleteScale: 1 }
    expect(() => migrateEyeAppearanceStateV4ToV5(unknownField)).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const nonfinite = input()
    nonfinite.state = { ...(nonfinite.state as object), irisSize: Number.NaN }
    expect(() => migrateEyeAppearanceStateV4ToV5(nonfinite)).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SOURCE' })
    )

    const sameHash = input()
    sameHash.target = { ...sameHash.target, definitionSha256: SOURCE_HASH }
    expect(() => migrateEyeAppearanceStateV4ToV5(sameHash)).toThrowError(
      expect.objectContaining({ code: 'INVALID_BINDING' })
    )
  })
})

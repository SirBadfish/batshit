import { describe, expect, it, vi } from 'vitest'
import { EyeAppearanceEngineRuntime } from './eyeAppearance.engine'
import type { EyeAppearanceDefinitionV3 } from './eyeAppearance'

function control(id: 'iris_size' | 'pupil_size' | 'iris_vertical_position') {
  return {
    id,
    label: id,
    description: id,
    minimum: id === 'iris_size' ? 0.75 : id === 'pupil_size' ? 0 : -1,
    maximum: id === 'iris_size' ? 1.35 : id === 'pupil_size' ? 2 : 1,
    step: 0.01,
    default: id === 'iris_vertical_position' ? 0 : 1,
    unit:
      id === 'iris_size'
        ? 'neutral-multiplier' as const
        : id === 'pupil_size'
          ? 'iris-relative-multiplier' as const
          : 'neutral-travel-fraction' as const,
    linkedBilateral: true as const,
    perEyeOverridesAllowed: false as const,
    runtimeClampingAllowed: false as const,
    geometrySemantics: id
  }
}

const definition = {
  schemaVersion: 'eye-appearance/v3',
  stateSchemaVersion: 'eye-appearance-state/v3',
  status: 'product-export-approved',
  productExportApproved: true,
  definitionSha256: 'a'.repeat(64),
  dependencies: {
    socketEyeSurface: { schemaVersion: 'socket-eye-surface/v1', definitionSha256: 'b'.repeat(64) },
    eyeApertureSeam: { schemaVersion: 'eye-aperture-seam/v1', definitionSha256: 'c'.repeat(64) }
  },
  ownership: 'test',
  zeroLaw: 'test',
  symmetryLaw: 'test',
  compositionOrder: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
  solidColorDefaults: {
    iris: [0.1, 0.2, 0.3, 1],
    pupil: [0, 0, 0, 1],
    sclera: [0.8, 0.8, 0.8, 1]
  },
  runtimeBindings: {
    coordinateSpace: 'socket-eye-surface',
    left: {
      compositeCapNode: 'left-cap',
      irisNeutralRadiusMeters: 0.006,
      pupilNeutralRadiusRatio: 0.4,
      irisVerticalTravelMeters: 0.003,
      edgeSoftnessMeters: 0.0001,
      artworkMappings: {
        sclera: 'gaze-linked-carrier',
        iris: 'radial-carrier',
        pupil: 'radial-carrier',
        highlight: 'iris-space'
      },
      cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 }
    },
    right: {
      compositeCapNode: 'right-cap',
      irisNeutralRadiusMeters: 0.0062,
      pupilNeutralRadiusRatio: 0.42,
      irisVerticalTravelMeters: 0.003,
      edgeSoftnessMeters: 0.0001,
      artworkMappings: {
        sclera: 'gaze-linked-carrier',
        iris: 'radial-carrier',
        pupil: 'radial-carrier',
        highlight: 'iris-space'
      },
      cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 }
    },
    geometryEvidence: {
      acceptedGlbSha256: 'd'.repeat(64),
      socketSurfaceSha256: 'b'.repeat(64),
      apertureSeamSha256: 'c'.repeat(64)
    }
  },
  controls: [control('iris_size'), control('pupil_size'), control('iris_vertical_position')],
  rangeEvidence: {
    schemaVersion: 'sa090-eye-appearance-range-calibration/v3',
    sha256: 'e'.repeat(64),
    canonicalSha256: 'f'.repeat(64)
  }
} as EyeAppearanceDefinitionV3

describe('EyeAppearanceEngineRuntime v3', () => {
  it('resolves Iris, Pupil, and linked vertical position into socket material calibration', () => {
    const runtime = new EyeAppearanceEngineRuntime(definition, {
      schemaVersion: 'eye-appearance-state/v3',
      definitionSha256: definition.definitionSha256,
      irisSize: 1.25,
      pupilSize: 0.5,
      irisVerticalPosition: 0.5
    })
    expect(runtime.resolveSide('left')).toEqual({
      irisRadiusMeters: 0.0075,
      pupilRadiusRatio: 0.2,
      irisVerticalOffsetMeters: 0.0015,
      edgeSoftnessMeters: 0.0001,
      cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 }
    })
  })

  it('supports exact zero pupil presentation without moving geometry', () => {
    const runtime = new EyeAppearanceEngineRuntime(definition, {
      schemaVersion: 'eye-appearance-state/v3',
      definitionSha256: definition.definitionSha256,
      irisSize: 1,
      pupilSize: 0,
      irisVerticalPosition: 0
    })
    expect(runtime.resolveSide('right').pupilRadiusRatio).toBe(0)
  })

  it('notifies the composite owner after strict state changes', () => {
    const changed = vi.fn()
    const runtime = new EyeAppearanceEngineRuntime(definition, null, changed)
    runtime.setState({
      schemaVersion: 'eye-appearance-state/v3',
      definitionSha256: definition.definitionSha256,
      irisSize: 0.9,
      pupilSize: 1.2,
      irisVerticalPosition: -0.25
    })
    expect(changed).toHaveBeenCalledOnce()
    runtime.dispose()
    expect(() => runtime.resolveSide('left')).toThrow('after disposal')
  })
})

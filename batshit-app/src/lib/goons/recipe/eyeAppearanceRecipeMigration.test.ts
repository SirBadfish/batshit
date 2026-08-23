import { describe, expect, it } from 'vitest'

import { parseEyeAppearanceDefinition, parseEyeAppearanceState } from '../eyeAppearance'
import {
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT
} from '../socketEyeArtworkProjection'
import { createEyeAppearanceRecipeSiblingVerifier } from './eyeAppearanceRecipeMigration'
import { recipeSiblingStateSha256 } from './recipeContracts'

const SOURCE_HASH = '1'.repeat(64)
const TARGET_HASH = '2'.repeat(64)

function control(id: string, minimum: number, maximum: number, defaultValue: number, unit: string) {
  return {
    id,
    label: id,
    description: `${id} description`,
    minimum,
    maximum,
    step: 0.01,
    default: defaultValue,
    unit,
    linkedBilateral: true,
    bilateralLaw:
      id === 'iris_horizontal_position' ? 'mirrored-convergence-divergence' : 'linked-same-value',
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: `${id} is definition-owned.`
  }
}

function sourceDefinition() {
  return {
    schemaVersion: 'eye-appearance/v4',
    stateSchemaVersion: 'eye-appearance-state/v4',
    definitionSha256: SOURCE_HASH,
    controls: [
      control('iris_size', 0.75, 1.35, 1, 'neutral-multiplier'),
      control('pupil_size', 0, 2, 1, 'iris-relative-multiplier'),
      control('iris_horizontal_position', -1, 1, 0, 'neutral-travel-fraction'),
      control('iris_vertical_position', -1, 1, 0, 'neutral-travel-fraction')
    ]
  }
}

function targetDefinition() {
  const side = (name: string) => ({
    physicalEyeNode: `physical_eye_${name}`,
    irisNeutralRadiusMeters: 0.0081,
    pupilNeutralRadiusRatio: 0.49,
    neutralPlacement: {
      horizontalTravelFraction: -0.5,
      verticalTravelFraction: -0.7
    },
    irisHorizontalTravelMeters: 0.002,
    irisVerticalTravelMeters: 0.003,
    edgeSoftnessMeters: 0.0002,
    artworkMappings: {
      sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
      iris: SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
      pupil: SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
      highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
    },
    cornea: { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 }
  })
  return {
    schemaVersion: 'eye-appearance/v5',
    stateSchemaVersion: 'eye-appearance-state/v5',
    status: 'product-export-approved',
    productExportApproved: true,
    definitionSha256: TARGET_HASH,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: 'socket-eye-surface/v2',
        definitionSha256: '3'.repeat(64)
      },
      eyeApertureSeam: {
        schemaVersion: 'eye-aperture-seam/v2',
        definitionSha256: '4'.repeat(64)
      }
    },
    ownership: 'static physical eye presentation',
    zeroLaw: 'definition-owned neutral placement plus user value',
    symmetryLaw: 'linked bilateral values',
    compositionOrder: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
    solidColorDefaults: {
      iris: [0.2, 0.4, 0.6, 1],
      pupil: [0.02, 0.02, 0.02, 1],
      sclera: [0.9, 0.9, 0.9, 1]
    },
    runtimeBindings: {
      coordinateSpace: 'physical-eye-sphere',
      left: side('left'),
      right: side('right'),
      geometryEvidence: {
        acceptedGlbSha256: '5'.repeat(64),
        socketSurfaceSha256: '3'.repeat(64),
        apertureSeamSha256: '4'.repeat(64)
      }
    },
    controls: [
      control('iris_size', 0.5, 1.5, 1, 'neutral-multiplier'),
      control('pupil_size', 0.5, 1.5, 1, 'iris-relative-multiplier'),
      control('iris_horizontal_position', -1, 1, 0, 'neutral-travel-fraction'),
      control('iris_vertical_position', -1, 1, 0, 'neutral-travel-fraction')
    ],
    rangeEvidence: {
      schemaVersion: 'eye-appearance-range-evidence/v5',
      sha256: '6'.repeat(64),
      canonicalSha256: '7'.repeat(64)
    }
  }
}

describe('Eye Appearance Recipe sibling migration', () => {
  it('maps the accepted v4 saved appearance to exact v5 user neutral', async () => {
    const source = sourceDefinition()
    const target = parseEyeAppearanceDefinition(targetDefinition())
    const value = {
      schemaVersion: 'eye-appearance-state/v4',
      definitionSha256: SOURCE_HASH,
      irisSize: 1.35,
      pupilSize: 1.4,
      irisHorizontalPosition: -0.5,
      irisVerticalPosition: -0.7
    }
    const verifier = createEyeAppearanceRecipeSiblingVerifier(source, target)
    const result = await verifier.verify({
      surface: 'eyeAppearance',
      operation: 'migrate',
      directEdgeKey: 'recipe-direct-edge/v1|fixture',
      edgeSha256: '8'.repeat(64),
      sourceState: {
        id: 'eyeAppearance',
        contract: 'eye-appearance-state/v4',
        definitionSha256: SOURCE_HASH,
        stateSha256: await recipeSiblingStateSha256(value),
        state: value
      },
      targetStateId: 'eyeAppearance',
      targetDefinition: {
        contract: target.stateSchemaVersion,
        definitionSha256: target.definitionSha256
      }
    })

    expect(parseEyeAppearanceState(target, result.proposedState.state)).toEqual({
      schemaVersion: 'eye-appearance-state/v5',
      definitionSha256: TARGET_HASH,
      irisSize: 1,
      pupilSize: 1,
      irisHorizontalPosition: 0,
      irisVerticalPosition: 0
    })
    expect(result.domainEvidenceSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('supports explicit reset without inventing a legacy source binding', async () => {
    const target = parseEyeAppearanceDefinition(targetDefinition())
    const verifier = createEyeAppearanceRecipeSiblingVerifier(null, target)
    const result = await verifier.verify({
      surface: 'eyeAppearance',
      operation: 'reset',
      directEdgeKey: 'recipe-direct-edge/v1|fixture',
      edgeSha256: '8'.repeat(64),
      sourceState: null,
      targetStateId: 'eyeAppearance',
      targetDefinition: {
        contract: target.stateSchemaVersion,
        definitionSha256: target.definitionSha256
      }
    })
    expect(result.proposedState.state).toMatchObject({
      schemaVersion: 'eye-appearance-state/v5',
      definitionSha256: TARGET_HASH,
      irisSize: 1,
      pupilSize: 1,
      irisHorizontalPosition: 0,
      irisVerticalPosition: 0
    })
  })

  it('rebinds a current v5 state for future definition updates without a legacy shim', async () => {
    const source = parseEyeAppearanceDefinition({
      ...targetDefinition(),
      definitionSha256: '9'.repeat(64)
    })
    const target = parseEyeAppearanceDefinition(targetDefinition())
    const value = {
      schemaVersion: 'eye-appearance-state/v5',
      definitionSha256: source.definitionSha256,
      irisSize: 1.2,
      pupilSize: 0.8,
      irisHorizontalPosition: 0.25,
      irisVerticalPosition: -0.1
    }
    const verifier = createEyeAppearanceRecipeSiblingVerifier(source, target)
    const result = await verifier.verify({
      surface: 'eyeAppearance',
      operation: 'migrate',
      directEdgeKey: 'recipe-direct-edge/v1|fixture',
      edgeSha256: '8'.repeat(64),
      sourceState: {
        id: 'eyeAppearance',
        contract: source.stateSchemaVersion,
        definitionSha256: source.definitionSha256,
        stateSha256: await recipeSiblingStateSha256(value),
        state: value
      },
      targetStateId: 'eyeAppearance',
      targetDefinition: {
        contract: target.stateSchemaVersion,
        definitionSha256: target.definitionSha256
      }
    })
    expect(result.proposedState.state).toEqual({
      ...value,
      definitionSha256: target.definitionSha256
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  parseEyeApertureSeamDefinition,
  SOCKET_EYE_TREATMENT_FOLLOWER_MORPH_COUNT,
  validateSocketEyeApertureOwnership
} from './eyeApertureSeam'

const HASH = { seam: 'a'.repeat(64), followers: 'b'.repeat(64), boundary: 'c'.repeat(64) }

function retainedMorphs(side: 'left' | 'right') {
  const suffix = side === 'left' ? 'Left' : 'Right'
  const required = [
    `eyeBlink${suffix}`,
    `eyeLookDown${suffix}`,
    `eyeLookIn${suffix}`,
    `eyeLookOut${suffix}`,
    `eyeLookUp${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`
  ]
  return [
    ...required,
    ...Array.from(
      { length: 38 - required.length },
      (_, index) => `performance_${side}_${String(index).padStart(3, '0')}`
    )
  ].sort()
}

function followerMorphs(side: 'left' | 'right') {
  const retained = retainedMorphs(side)
  return [
    ...retained,
    ...Array.from(
      { length: SOCKET_EYE_TREATMENT_FOLLOWER_MORPH_COUNT - retained.length },
      (_, index) => `identity_${side}_${String(index).padStart(3, '0')}`
    )
  ].sort()
}

function side(side: 'left' | 'right') {
  return {
    side,
    sourceBodyNode: 'body',
    physicalEyeNode: `physical_eye_${side}`,
    lashesEyeOutlineNode: `eye_treatment_${side}`,
    upperBoundary: { sampleCount: 28, bindingSha256: HASH.boundary },
    lowerBoundary: { sampleCount: 28, bindingSha256: HASH.boundary },
    innerCanthusVertexIndex: side === 'left' ? 10 : 12,
    outerCanthusVertexIndex: side === 'left' ? 11 : 13,
    treatment: {
      geometryLaw: 'animated-upper-lower-thin-surface/v1',
      upperMaterialName: `eye_treatment_${side}_upper_mat`,
      lowerMaterialName: `eye_treatment_${side}_lower_mat`,
      appearanceFollowerContract: 'appearance-followers/v2',
      followerInventorySha256: HASH.followers,
      followerMorphs: followerMorphs(side),
      retainedPerformanceMorphs: retainedMorphs(side),
      surfaceCorrection: {
        contract: 'head-projection-blink-surface-correction/v1',
        projectionMorph: `surface_projection_${side}`,
        blinkLinearMorph: `surface_blink_linear_${side}`,
        blinkResidualMorph: `surface_blink_residual_${side}`,
        blinkMorph: `eyeBlink${side === 'left' ? 'Left' : 'Right'}`,
        projectionWeightLaw: 'appearance-follower-weight',
        blinkLinearWeightLaw: 'blink-times-projection',
        blinkResidualWeightLaw: 'four-blink-one-minus-blink-times-projection'
      },
      doubleSided: true,
      ordinaryDepthTest: true,
      depthWrite: false,
      renderOrder: 'after-physical-eye'
    }
  }
}

function fixture() {
  return {
    schemaVersion: 'eye-aperture-seam/v2',
    definitionSha256: HASH.seam,
    status: 'product-export-approved',
    productExportApproved: true,
    sharedCanthusRoots: true,
    blinkClosure: { composition: 'authored-independent/v2', fullBlinkSquintFloor: 0 },
    runtimeBindings: { left: side('left'), right: side('right') }
  }
}

describe('eye-aperture-seam/v2', () => {
  it('locks one physical eye and one upper/lower treatment root per side', () => {
    const definition = parseEyeApertureSeamDefinition(fixture())
    expect(definition.blinkClosure).toEqual({
      composition: 'authored-independent/v2',
      fullBlinkSquintFloor: 0
    })
    expect(definition.runtimeBindings.left.treatment).toMatchObject({
      geometryLaw: 'animated-upper-lower-thin-surface/v1',
      appearanceFollowerContract: 'appearance-followers/v2',
      doubleSided: true,
      ordinaryDepthTest: true,
      depthWrite: false
    })
    expect(definition.runtimeBindings.left.treatment.followerMorphs).toHaveLength(84)
    expect(definition.runtimeBindings.left.treatment.retainedPerformanceMorphs).toHaveLength(38)
  })

  it('rejects the retired implicit Squint floor and incomplete treatment followers', () => {
    const floor = fixture() as any
    floor.blinkClosure = { composition: 'same-side-squint-floor/v1', fullBlinkSquintFloor: 0.5 }
    expect(() => parseEyeApertureSeamDefinition(floor)).toThrow(/authored-independent\/v2/)

    const incomplete = fixture() as any
    incomplete.runtimeBindings.left.treatment.followerMorphs.pop()
    expect(() => parseEyeApertureSeamDefinition(incomplete)).toThrow(/exactly 84/)

    const missingRuntime = fixture() as any
    missingRuntime.runtimeBindings.left.treatment.retainedPerformanceMorphs = ['eyeBlinkLeft']
    expect(() => parseEyeApertureSeamDefinition(missingRuntime)).toThrow(/eyeLookDownLeft/)
  })

  it('requires two distinct material roles and two-sided ordinary depth behavior', () => {
    for (const mutate of [
      (value: any) =>
        (value.runtimeBindings.left.treatment.lowerMaterialName =
          value.runtimeBindings.left.treatment.upperMaterialName),
      (value: any) => (value.runtimeBindings.left.treatment.doubleSided = false),
      (value: any) => (value.runtimeBindings.left.treatment.depthWrite = true)
    ]) {
      const value = fixture() as any
      mutate(value)
      expect(() => parseEyeApertureSeamDefinition(value)).toThrow()
    }
  })

  it('hash-binds the seam to each exact physical-eye node', () => {
    const seam = parseEyeApertureSeamDefinition(fixture())
    const surface = {
      runtimeBindings: {
        left: {
          apertureSeamDefinitionSha256: HASH.seam,
          nodes: { physicalEye: 'physical_eye_left' }
        },
        right: {
          apertureSeamDefinitionSha256: HASH.seam,
          nodes: { physicalEye: 'physical_eye_right' }
        }
      }
    } as any
    expect(() => validateSocketEyeApertureOwnership(surface, seam)).not.toThrow()
    surface.runtimeBindings.right.nodes.physicalEye = 'another_eye'
    expect(() => validateSocketEyeApertureOwnership(surface, seam)).toThrow(/physical-eye node/)
  })
})

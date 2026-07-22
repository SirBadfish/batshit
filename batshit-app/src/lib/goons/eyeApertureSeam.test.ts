import { describe, expect, it } from 'vitest'

import {
  parseEyeApertureSeamDefinition,
  validateSocketEyeApertureOwnership
} from './eyeApertureSeam'
import { parseSocketEyeSurfaceDefinition } from './socketEyeSurface'

function linerPerformanceMorphs(suffix: 'Left' | 'Right'): string[] {
  return [
    `eyeBlink${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`,
    ...Array.from({ length: 41 }, (_, index) => `performance${suffix}${index}`)
  ].sort()
}

function seamFixture(): any {
  const side = (name: 'left' | 'right', code: 'L' | 'R', offset: number) => ({
    side: name,
    sourceBodyNode: 'Body',
    compositeCapNode: `BS_Eye_${code}_CompositeCap`,
    lashesEyeOutlineNode: `BS_EyeTreatmentCanvas_${code}`,
    upperBoundary: { sampleCount: 48, bindingSha256: `${offset}`.repeat(64) },
    lowerBoundary: { sampleCount: 48, bindingSha256: `${offset + 1}`.repeat(64) },
    innerCanthusVertexIndex: offset * 100 + 1,
    outerCanthusVertexIndex: offset * 100 + 2,
    capUnderlapMeters: 0.002,
    liner: {
      innerOverlapMeters: 0.00045,
      surfaceClearanceMeters: 0.00008,
      baseForwardPitchDegrees: 0,
      faceConformal: true,
      visibleLidRimAllowed: false,
      ordinaryDepthTest: true,
      renderOrder: 'after-composite-cap',
      retainedPerformanceMorphs: linerPerformanceMorphs(name === 'left' ? 'Left' : 'Right'),
      freeLashFlare: {
        profile: 'geometry-derived-attachment-hinge/v1',
        direction: 'model-forward',
        attachmentBandNormalizedWidth: 0.2,
        canthusTaperNormalizedWidth: 0.08,
        upperMaximumForwardOffsetMeters: 0.0016,
        lowerMaximumForwardOffsetMeters: 0.0028
      }
    }
  })
  return {
    schemaVersion: 'eye-aperture-seam/v1',
    definitionSha256: 'a'.repeat(64),
    status: 'product-export-approved',
    productExportApproved: true,
    sharedCanthusRoots: true,
    blinkClosure: {
      composition: 'same-side-squint-floor/v1',
      fullBlinkSquintFloor: 0.5
    },
    runtimeBindings: {
      left: side('left', 'L', 1),
      right: side('right', 'R', 3)
    }
  }
}

function socketFixture(): any {
  const side = (name: 'left' | 'right', code: 'L' | 'R', x: number) => ({
    side: name,
    nodes: {
      compositeCap: `BS_Eye_${code}_CompositeCap`
    },
    apertureSeamDefinitionSha256: 'a'.repeat(64),
    gazeAnchorHeadLocal: [x, 0, 0],
    surfaceCenterHeadLocal: [x, 0, 0],
    horizontalAxisHeadLocal: [1, 0, 0],
    verticalAxisHeadLocal: [0, 1, 0],
    forwardAxisHeadLocal: [0, 0, 1],
    cap: {
      frontGeometryLaw: 'aperture-normalized-shallow-patch/v1',
      frontDepthRatio: 0.08,
      maximumFrontDepthMeters: 0.0008,
      artworkProjection: 'deformed-surface-meters/v1',
      carrierHalfWidthMeters: 0.016,
      carrierHalfHeightMeters: 0.012,
      carrierDepthRadiusMeters: 0.014,
      rearClosureDepthMeters: 0.004,
      minimumHiddenUnderlapMeters: 0.002,
      visibleFrontFaceGroup: `${name}-visible-front`,
      hiddenClosureFaceGroup: `${name}-hidden-closure`,
      primitiveFollowerMorphs: {
        visibleFront: [
          `eyeBlink${name === 'left' ? 'Left' : 'Right'}`,
          `eyeSquint${name === 'left' ? 'Left' : 'Right'}`,
          `eyeWide${name === 'left' ? 'Left' : 'Right'}`
        ],
        hiddenClosure: [
          `eyeBlink${name === 'left' ? 'Left' : 'Right'}`,
          `eyeSquint${name === 'left' ? 'Left' : 'Right'}`,
          `eyeWide${name === 'left' ? 'Left' : 'Right'}`
        ]
      },
      apertureFollowing: true,
      closedManifold: true
    },
    gaze: { maximumHorizontal: 0.58, maximumVertical: 0.45, headFollowStart: 0.72 }
  })
  return {
    schemaVersion: 'socket-eye-surface/v1',
    definitionSha256: 'b'.repeat(64),
    status: 'product-export-approved',
    productExportApproved: true,
    coordinateSpace: 'head-local',
    surfaceKind: 'aperture-following-composite-cap',
    compositeLayers: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
    rendering: {
      meshOwnsApertureMask: true,
      visibleFrontDepthTest: true,
      visibleFrontDepthWrite: true,
      visibleFrontSide: 'front',
      renderOrder: 'after-face-before-liner',
      requiredMaxTextureArrayLayers: 501
    },
    artwork: {
      scleraOverlay: {
        gazeLinked: true,
        transparentRgba: true,
        minimumOverscanHorizontal: 0.8,
        minimumOverscanVertical: 0.75
      }
    },
    runtimeBindings: { left: side('left', 'L', 0.03), right: side('right', 'R', -0.03) }
  }
}

describe('eye-aperture-seam/v1', () => {
  it('locks one exact cap/liner boundary with an Overwatch-register presentation law', () => {
    const definition = parseEyeApertureSeamDefinition(seamFixture())

    expect(definition.sharedCanthusRoots).toBe(true)
    expect(definition.productExportApproved).toBe(true)
    expect(definition.runtimeBindings.left.liner.visibleLidRimAllowed).toBe(false)
    expect(definition.runtimeBindings.left.liner.baseForwardPitchDegrees).toBe(0)
    expect(definition.runtimeBindings.left.liner.renderOrder).toBe('after-composite-cap')
    expect(definition.runtimeBindings.left.liner.retainedPerformanceMorphs).toHaveLength(44)
    expect(definition.runtimeBindings.right.liner.freeLashFlare.direction).toBe('model-forward')
    expect(definition.blinkClosure.fullBlinkSquintFloor).toBe(0.5)
    expect(definition.runtimeBindings.right.upperBoundary.sampleCount).toBe(48)
  })

  it('rejects prototype-only aperture seam metadata', () => {
    const fixture = seamFixture()
    fixture.productExportApproved = false
    expect(() => parseEyeApertureSeamDefinition(fixture)).toThrow(
      /productExportApproved must be true/
    )
  })

  it('rejects the old projecting-card clearance and pitch', () => {
    const clearance = seamFixture()
    clearance.runtimeBindings.left.liner.surfaceClearanceMeters = 0.0015
    expect(() => parseEyeApertureSeamDefinition(clearance)).toThrow(/micro-clearance/)

    const pitch = seamFixture()
    pitch.runtimeBindings.left.liner.baseForwardPitchDegrees = 12
    expect(() => parseEyeApertureSeamDefinition(pitch)).toThrow(/must be 0/)
  })

  it('rejects an exposed lid rim, non-conformal canvas, disabled depth test, or wrong order', () => {
    for (const [field, value] of [
      ['visibleLidRimAllowed', true],
      ['faceConformal', false],
      ['ordinaryDepthTest', false]
    ] as const) {
      const fixture = seamFixture()
      fixture.runtimeBindings.right.liner[field] = value
      expect(() => parseEyeApertureSeamDefinition(fixture)).toThrow()
    }

    const wrongOrder = seamFixture()
    wrongOrder.runtimeBindings.left.liner.renderOrder = 'before-composite-cap'
    expect(() => parseEyeApertureSeamDefinition(wrongOrder)).toThrow(/after-composite-cap/)
  })

  it('rejects incomplete rails, duplicate canthi, and insufficient inward overlap', () => {
    const rail = seamFixture()
    rail.runtimeBindings.left.upperBoundary.sampleCount = 3
    expect(() => parseEyeApertureSeamDefinition(rail)).toThrow(/at least four/)

    const canthus = seamFixture()
    canthus.runtimeBindings.right.innerCanthusVertexIndex =
      canthus.runtimeBindings.left.innerCanthusVertexIndex
    expect(() => parseEyeApertureSeamDefinition(canthus)).toThrow(/must be unique/)

    const overlap = seamFixture()
    overlap.runtimeBindings.left.liner.innerOverlapMeters = 0.00005
    expect(() => parseEyeApertureSeamDefinition(overlap)).toThrow(/must exceed/)
  })

  it('rejects partial liner performance, whole-card flare, or an additive Blink law', () => {
    const followers = seamFixture()
    followers.runtimeBindings.left.liner.retainedPerformanceMorphs.pop()
    expect(() => parseEyeApertureSeamDefinition(followers)).toThrow(/exactly 44/)

    const flare = seamFixture()
    flare.runtimeBindings.right.liner.freeLashFlare.attachmentBandNormalizedWidth = 0
    expect(() => parseEyeApertureSeamDefinition(flare)).toThrow(/inside \(0, 1\)/)

    const blink = seamFixture()
    blink.blinkClosure.composition = 'additive'
    expect(() => parseEyeApertureSeamDefinition(blink)).toThrow(/same-side-squint-floor/)
  })

  it('fails closed when the cap and eye-outline seam identities drift', () => {
    const socket = parseSocketEyeSurfaceDefinition(socketFixture())
    const seam = parseEyeApertureSeamDefinition(seamFixture())
    expect(() => validateSocketEyeApertureOwnership(socket, seam)).not.toThrow()

    const wrongHash = socketFixture()
    wrongHash.runtimeBindings.right.apertureSeamDefinitionSha256 = 'c'.repeat(64)
    expect(() =>
      validateSocketEyeApertureOwnership(parseSocketEyeSurfaceDefinition(wrongHash), seam)
    ).toThrow(/different aperture-seam definition/)

    const wrongUnderlap = seamFixture()
    wrongUnderlap.runtimeBindings.left.capUnderlapMeters = 0.003
    expect(() =>
      validateSocketEyeApertureOwnership(
        socket,
        parseEyeApertureSeamDefinition(wrongUnderlap)
      )
    ).toThrow(/underlap drifted/)
  })
})

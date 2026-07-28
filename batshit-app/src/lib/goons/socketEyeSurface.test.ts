import { describe, expect, it } from 'vitest'

import {
  parseSocketEyeSurfaceDefinition,
  projectTargetToSocketEyeSurface,
  type SocketEyeSurfaceDefinitionV1
} from './socketEyeSurface'

function definitionFixture(): unknown {
  const side = (name: 'left' | 'right', x: number) => ({
    side: name,
    nodes: {
      compositeCap: `${name}-composite-cap`
    },
    apertureSeamDefinitionSha256: 'b'.repeat(64),
    gazeAnchorHeadLocal: [x, 0, 0] as [number, number, number],
    surfaceCenterHeadLocal: [x, 0, 0] as [number, number, number],
    horizontalAxisHeadLocal: [1, 0, 0] as [number, number, number],
    verticalAxisHeadLocal: [0, 1, 0] as [number, number, number],
    forwardAxisHeadLocal: [0, 0, 1] as [number, number, number],
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
    gaze: {
      maximumHorizontal: 0.58,
      maximumVertical: 0.45,
      headFollowStart: 0.72
    }
  })
  return {
    schemaVersion: 'socket-eye-surface/v1',
    definitionSha256: 'a'.repeat(64),
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
    runtimeBindings: {
      left: side('left', 0.03),
      right: side('right', -0.03)
    }
  }
}

function parsedDefinition() {
  return parseSocketEyeSurfaceDefinition(definitionFixture())
}

describe('socket-eye-surface/v1', () => {
  it('parses a strict bilateral aperture-following composite-cap contract', () => {
    const definition = parsedDefinition()

    expect(definition.surfaceKind).toBe('aperture-following-composite-cap')
    expect(definition.runtimeBindings.left.cap.closedManifold).toBe(true)
    expect(definition.runtimeBindings.left.cap.apertureFollowing).toBe(true)
    expect(definition.rendering.renderOrder).toBe('after-face-before-liner')
    expect(definition.rendering.visibleFrontDepthTest).toBe(true)
    expect(definition.rendering.requiredMaxTextureArrayLayers).toBe(501)
    expect(definition.coordinateSpace).toBe('head-local')
    expect(definition.productExportApproved).toBe(true)
    expect(definition.runtimeBindings.right.gazeAnchorHeadLocal).toEqual([-0.03, 0, 0])
    expect(definition.artwork.scleraOverlay.gazeLinked).toBe(true)
  })

  it('requires an exact positive integer renderer texture-array capacity', () => {
    for (const value of [0, 501.5]) {
      const fixture = definitionFixture() as any
      fixture.rendering.requiredMaxTextureArrayLayers = value
      expect(() => parseSocketEyeSurfaceDefinition(fixture)).toThrow(
        /requiredMaxTextureArrayLayers/
      )
    }
  })

  it('derives automatic near-target convergence from one shared target', () => {
    const definition = parsedDefinition()
    const farLeft = projectTargetToSocketEyeSurface(
      definition.runtimeBindings.left,
      [0, 0, 1]
    )
    const farRight = projectTargetToSocketEyeSurface(
      definition.runtimeBindings.right,
      [0, 0, 1]
    )
    const nearLeft = projectTargetToSocketEyeSurface(
      definition.runtimeBindings.left,
      [0, 0, 0.25]
    )
    const nearRight = projectTargetToSocketEyeSurface(
      definition.runtimeBindings.right,
      [0, 0, 0.25]
    )

    expect(farLeft.resolved.horizontal).toBeLessThan(0)
    expect(farRight.resolved.horizontal).toBeGreaterThan(0)
    expect(farLeft.resolved.horizontal).toBeCloseTo(-farRight.resolved.horizontal, 10)
    expect(Math.abs(nearLeft.resolved.horizontal)).toBeGreaterThan(
      Math.abs(farLeft.resolved.horizontal)
    )
    expect(nearLeft.resolved.horizontal).toBeCloseTo(-nearRight.resolved.horizontal, 10)
  })

  it('projects vertical and horizontal camera movement onto the cap without moving its base', () => {
    const definition = parsedDefinition()
    const result = projectTargetToSocketEyeSurface(
      definition.runtimeBindings.left,
      [0.15, 0.08, 0.8]
    )

    expect(result.requested.horizontal).toBeGreaterThan(0)
    expect(result.requested.vertical).toBeGreaterThan(0)
    expect(result.clamped).toBe(false)
    expect(result.surfacePointHeadLocal[2]).toBeGreaterThan(
      definition.runtimeBindings.left.surfaceCenterHeadLocal[2]
    )
  })

  it('clamps to the elliptical safe domain and reports head-follow pressure', () => {
    const definition = parsedDefinition()
    const result = projectTargetToSocketEyeSurface(
      definition.runtimeBindings.left,
      [1.5, 0.6, 0.4]
    )
    const side = definition.runtimeBindings.left
    const resolvedRadius = Math.sqrt(
      (result.resolved.horizontal / side.gaze.maximumHorizontal) ** 2 +
        (result.resolved.vertical / side.gaze.maximumVertical) ** 2
    )

    expect(result.clamped).toBe(true)
    expect(resolvedRadius).toBeCloseTo(1, 10)
    expect(result.headFollowPressure).toBe(1)
  })

  it('rejects targets behind the fixed eye surface', () => {
    const definition = parsedDefinition()
    expect(() =>
      projectTargetToSocketEyeSurface(definition.runtimeBindings.left, [0, 0, -1])
    ).toThrow(/must be in front/)
  })

  it('rejects open or static caps, non-orthonormal frames, duplicate nodes, and insufficient artwork overscan', () => {
    const openCap = definitionFixture() as any
    openCap.runtimeBindings.left.cap.closedManifold = false
    expect(() => parseSocketEyeSurfaceDefinition(openCap)).toThrow(/closedManifold must be true/)

    const staticCap = definitionFixture() as any
    staticCap.runtimeBindings.left.cap.apertureFollowing = false
    expect(() => parseSocketEyeSurfaceDefinition(staticCap)).toThrow(/apertureFollowing must be true/)

    const badAxes = definitionFixture() as any
    badAxes.runtimeBindings.left.verticalAxisHeadLocal = [0.2, 1, 0]
    expect(() => parseSocketEyeSurfaceDefinition(badAxes)).toThrow(/must be unit length/)

    const duplicate = definitionFixture() as any
    duplicate.runtimeBindings.right.nodes.compositeCap =
      duplicate.runtimeBindings.left.nodes.compositeCap
    expect(() => parseSocketEyeSurfaceDefinition(duplicate)).toThrow(/must be unique/)

    const croppedArtwork = definitionFixture() as any
    croppedArtwork.artwork.scleraOverlay.minimumOverscanHorizontal = 0.5
    expect(() => parseSocketEyeSurfaceDefinition(croppedArtwork)).toThrow(
      /horizontal overscan must exceed/
    )
  })

  it('rejects prototype approval, legacy coordinate names, and incomplete primitive follower inventories', () => {
    const prototype = definitionFixture() as any
    prototype.productExportApproved = false
    expect(() => parseSocketEyeSurfaceDefinition(prototype)).toThrow(
      /productExportApproved must be true/
    )

    const legacyCoordinates = definitionFixture() as any
    legacyCoordinates.runtimeBindings.left.gazeAnchorParent = [0.03, 0, 0]
    expect(() => parseSocketEyeSurfaceDefinition(legacyCoordinates)).toThrow(/unsupported fields/)

    const incomplete = definitionFixture() as any
    incomplete.runtimeBindings.left.cap.primitiveFollowerMorphs.hiddenClosure = [
      'eyeBlinkLeft',
      'eyeSquintLeft'
    ]
    expect(() => parseSocketEyeSurfaceDefinition(incomplete)).toThrow(/same exact inventory/)

    const missingRequired = definitionFixture() as any
    missingRequired.runtimeBindings.right.cap.primitiveFollowerMorphs.visibleFront = [
      'identityFaceRight',
      'eyeBlinkRight',
      'eyeSquintRight'
    ].sort()
    missingRequired.runtimeBindings.right.cap.primitiveFollowerMorphs.hiddenClosure = [
      ...missingRequired.runtimeBindings.right.cap.primitiveFollowerMorphs.visibleFront
    ]
    expect(() => parseSocketEyeSurfaceDefinition(missingRequired)).toThrow(/eyeWideRight/)
  })

  it('rejects separate globe layers or depth-tested front rendering', () => {
    const oldNodes = definitionFixture() as any
    oldNodes.runtimeBindings.left.nodes.scleraCap = 'legacy-sclera'
    expect(() => parseSocketEyeSurfaceDefinition(oldNodes)).toThrow(/unsupported fields/)

    const depthTestDisabled = definitionFixture() as any
    depthTestDisabled.rendering.visibleFrontDepthTest = false
    expect(() => parseSocketEyeSurfaceDefinition(depthTestDisabled)).toThrow(
      /visibleFrontDepthTest must be true/
    )

    const wrongOrder = definitionFixture() as any
    wrongOrder.compositeLayers = ['sclera', 'iris', 'scleraArtwork', 'pupil', 'highlight', 'cornea']
    expect(() => parseSocketEyeSurfaceDefinition(wrongOrder)).toThrow(/compositeLayers\[1\]/)
  })

  it('returns data that remains exact across a JSON boundary', () => {
    const definition = parsedDefinition()
    const roundTripped = parseSocketEyeSurfaceDefinition(
      JSON.parse(JSON.stringify(definition))
    ) as SocketEyeSurfaceDefinitionV1
    const target: [number, number, number] = [0.1, -0.04, 0.9]

    expect(projectTargetToSocketEyeSurface(roundTripped.runtimeBindings.left, target)).toEqual(
      projectTargetToSocketEyeSurface(definition.runtimeBindings.left, target)
    )
  })
})

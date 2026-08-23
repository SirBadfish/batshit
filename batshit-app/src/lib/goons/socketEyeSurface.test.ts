import { describe, expect, it } from 'vitest'
import {
  parseSocketEyeSurfaceDefinition,
  projectTargetToSocketEyeSurface
} from './socketEyeSurface'

const HASH = {
  surface: 'a'.repeat(64),
  seam: 'b'.repeat(64)
}

function side(side: 'left' | 'right') {
  const x = side === 'left' ? -0.03 : 0.03
  return {
    side,
    nodes: { physicalEye: `physical_eye_${side}` },
    apertureSeamDefinitionSha256: HASH.seam,
    gazeAnchorHeadLocal: [x, 0, -0.02],
    surfaceCenterHeadLocal: [x, 0, 0],
    horizontalAxisHeadLocal: [1, 0, 0],
    verticalAxisHeadLocal: [0, 1, 0],
    forwardAxisHeadLocal: [0, 0, 1],
    sphere: {
      geometryLaw: 'static-full-sphere/v1',
      radiusMeters: 0.012,
      artworkProjection: 'front-hemisphere-uv/v1',
      stableNeutralRear: true,
      surfaceMorphTargets: [],
      physicalFit: {
        mode: 'transform-only/v1',
        translation: true,
        rotation: true,
        uniformScale: true,
        nonUniformScale: false
      }
    },
    gaze: { maximumHorizontal: 0.35, maximumVertical: 0.28, headFollowStart: 0.75 }
  }
}

function fixture() {
  return {
    schemaVersion: 'socket-eye-surface/v2',
    definitionSha256: HASH.surface,
    status: 'product-export-approved',
    productExportApproved: true,
    coordinateSpace: 'head-local',
    surfaceKind: 'static-full-sphere',
    compositeLayers: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
    rendering: {
      eyelidsOwnApertureOcclusion: true,
      sphereDepthTest: true,
      sphereDepthWrite: true,
      sphereSide: 'front',
      renderOrder: 'after-face-before-treatment',
      requiredMaxTextureArrayLayers: 501
    },
    artwork: {
      scleraOverlay: {
        projection: 'front-hemisphere-only/v1',
        transparentRgba: true,
        rearPresentation: 'stable-neutral-base',
        gazeLinked: false
      }
    },
    runtimeBindings: { left: side('left'), right: side('right') }
  }
}

describe('socket-eye-surface/v2', () => {
  it('parses a strict bilateral zero-morph static-sphere contract', () => {
    const definition = parseSocketEyeSurfaceDefinition(fixture())
    expect(definition.surfaceKind).toBe('static-full-sphere')
    expect(definition.runtimeBindings.left.nodes.physicalEye).toBe('physical_eye_left')
    expect(definition.runtimeBindings.left.sphere).toMatchObject({
      artworkProjection: 'front-hemisphere-uv/v1',
      stableNeutralRear: true,
      surfaceMorphTargets: [],
      physicalFit: { mode: 'transform-only/v1', nonUniformScale: false }
    })
    expect(definition.artwork.scleraOverlay).toEqual({
      projection: 'front-hemisphere-only/v1',
      transparentRgba: true,
      rearPresentation: 'stable-neutral-base',
      gazeLinked: false
    })
  })

  it('rejects the retired cap contract and any physical-eye morph target', () => {
    const retired = fixture() as any
    retired.schemaVersion = 'socket-eye-surface/v1'
    expect(() => parseSocketEyeSurfaceDefinition(retired)).toThrow(/socket-eye-surface\/v2/)

    const deformed = fixture() as any
    deformed.runtimeBindings.left.sphere.surfaceMorphTargets = ['eyeBlinkLeft']
    expect(() => parseSocketEyeSurfaceDefinition(deformed)).toThrow(/physical eye is static/)
  })

  it('rejects non-transform fitting, rear artwork, and non-uniform scale', () => {
    for (const mutate of [
      (value: any) => (value.runtimeBindings.left.sphere.physicalFit.mode = 'morph-followers/v1'),
      (value: any) => (value.artwork.scleraOverlay.gazeLinked = true),
      (value: any) => (value.runtimeBindings.left.sphere.physicalFit.nonUniformScale = true)
    ]) {
      const value = fixture() as any
      mutate(value)
      expect(() => parseSocketEyeSurfaceDefinition(value)).toThrow()
    }
  })

  it('preserves independent physical target projection and near-target convergence', () => {
    const definition = parseSocketEyeSurfaceDefinition(fixture())
    const target: [number, number, number] = [0, 0, 0.4]
    const left = projectTargetToSocketEyeSurface(definition.runtimeBindings.left, target)
    const right = projectTargetToSocketEyeSurface(definition.runtimeBindings.right, target)
    expect(left.resolved.horizontal).toBeGreaterThan(0)
    expect(right.resolved.horizontal).toBeLessThan(0)
    expect(left.surfacePointHeadLocal[2]).toBeGreaterThan(0)
    expect(right.surfacePointHeadLocal[2]).toBeGreaterThan(0)
  })

  it('clamps gaze to the package ellipse and rejects rear targets', () => {
    const definition = parseSocketEyeSurfaceDefinition(fixture())
    const projected = projectTargetToSocketEyeSurface(
      definition.runtimeBindings.left,
      [0.02, 0, 0.1]
    )
    expect(projected.clamped).toBe(true)
    expect(
      Math.hypot(
        projected.resolved.horizontal / definition.runtimeBindings.left.gaze.maximumHorizontal,
        projected.resolved.vertical / definition.runtimeBindings.left.gaze.maximumVertical
      )
    ).toBeCloseTo(1)
    expect(() =>
      projectTargetToSocketEyeSurface(definition.runtimeBindings.left, [-0.03, 0, -1])
    ).toThrow(/in front/)
  })
})

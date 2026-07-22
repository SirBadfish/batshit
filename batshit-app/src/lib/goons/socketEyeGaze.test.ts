import { describe, expect, it } from 'vitest'
import type { CustomPerformanceDirection } from './customPerformanceRig'
import type { SocketEyeSurfaceDefinitionV1 } from './socketEyeSurface'
import {
  resolveAuthoredSocketEyeCoordinates,
  resolveSocketEyeGaze,
  resolveSocketEyeLookTargetWeights,
  resolveSocketEyeHeadAssist,
  smoothSocketEyeHeadAssist
} from './socketEyeGaze'
import { DEFAULT_SOCKET_EYE_CONTACT_SETTINGS } from './socketEyeContact'

const neutralDirection: CustomPerformanceDirection = {
  headYaw: 0,
  headPitch: 0,
  leftEyeYaw: 0,
  leftEyePitch: 0,
  rightEyeYaw: 0,
  rightEyePitch: 0
}

function side(side: 'left' | 'right', x: number) {
  return {
    side,
    nodes: { compositeCap: `${side}-cap` },
    apertureSeamDefinitionSha256: 'b'.repeat(64),
    gazeAnchorHeadLocal: [x, 0, 0] as [number, number, number],
    surfaceCenterHeadLocal: [x, 0, 0.01] as [number, number, number],
    horizontalAxisHeadLocal: [1, 0, 0] as [number, number, number],
    verticalAxisHeadLocal: [0, 1, 0] as [number, number, number],
    forwardAxisHeadLocal: [0, 0, 1] as [number, number, number],
    cap: {
      frontGeometryLaw: 'aperture-normalized-shallow-patch/v1',
      frontDepthRatio: 0.08,
      maximumFrontDepthMeters: 0.0008,
      artworkProjection: 'deformed-surface-meters/v1',
      carrierHalfWidthMeters: 0.02,
      carrierHalfHeightMeters: 0.015,
      carrierDepthRadiusMeters: 0.015,
      rearClosureDepthMeters: 0.005,
      minimumHiddenUnderlapMeters: 0.001,
      visibleFrontFaceGroup: 'visible-front',
      hiddenClosureFaceGroup: 'hidden-closure',
      primitiveFollowerMorphs: {
        visibleFront: [
          `eyeBlink${side === 'left' ? 'Left' : 'Right'}`,
          `eyeWide${side === 'left' ? 'Left' : 'Right'}`,
          `eyeSquint${side === 'left' ? 'Left' : 'Right'}`
        ],
        hiddenClosure: [
          `eyeBlink${side === 'left' ? 'Left' : 'Right'}`,
          `eyeWide${side === 'left' ? 'Left' : 'Right'}`,
          `eyeSquint${side === 'left' ? 'Left' : 'Right'}`
        ]
      },
      apertureFollowing: true as const,
      closedManifold: true as const
    },
    gaze: { maximumHorizontal: 0.75, maximumVertical: 0.6, headFollowStart: 0.8 }
  }
}

const definition = {
  schemaVersion: 'socket-eye-surface/v1',
  definitionSha256: 'a'.repeat(64),
  status: 'test',
  productExportApproved: true,
  coordinateSpace: 'head-local',
  surfaceKind: 'aperture-following-composite-cap',
  compositeLayers: ['sclera', 'scleraArtwork', 'iris', 'pupil', 'highlight', 'cornea'],
  rendering: {
    meshOwnsApertureMask: true,
    visibleFrontDepthTest: true,
    visibleFrontDepthWrite: true,
    visibleFrontSide: 'front',
    renderOrder: 'after-face-before-liner'
  },
  artwork: {
    scleraOverlay: {
      gazeLinked: true,
      transparentRgba: true,
      minimumOverscanHorizontal: 0.9,
      minimumOverscanVertical: 0.8
    }
  },
  runtimeBindings: { left: side('left', 0.03), right: side('right', -0.03) }
} as SocketEyeSurfaceDefinitionV1

describe('socket-eye gaze composition', () => {
  it('projects one target independently so near targets converge automatically', () => {
    const resolved = resolveSocketEyeGaze(
      definition,
      [0, 0, 0.3],
      neutralDirection,
      { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS },
      true
    )
    expect(resolved.contactStatus).toBe('projected')
    expect(resolved.gaze.left.horizontal).toBeLessThan(0)
    expect(resolved.gaze.right.horizontal).toBeGreaterThan(0)
  })

  it('adds a bounded inward/outward convergence correction after physical target projection', () => {
    const neutral = resolveSocketEyeGaze(
      definition,
      [0, 0, 0.3],
      neutralDirection,
      { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS },
      true
    )
    const inward = resolveSocketEyeGaze(
      definition,
      [0, 0, 0.3],
      neutralDirection,
      { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS, convergence: 0.2 },
      true
    )
    const outward = resolveSocketEyeGaze(
      definition,
      [0, 0, 0.3],
      neutralDirection,
      { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS, convergence: -0.2 },
      true
    )
    expect(inward.gaze.left.horizontal).toBeLessThan(neutral.gaze.left.horizontal)
    expect(inward.gaze.right.horizontal).toBeGreaterThan(neutral.gaze.right.horizontal)
    expect(Math.abs(outward.gaze.left.horizontal)).toBeLessThan(
      Math.abs(neutral.gaze.left.horizontal)
    )
    expect(Math.abs(outward.gaze.right.horizontal)).toBeLessThan(
      Math.abs(neutral.gaze.right.horizontal)
    )
  })

  it('preserves authored gaze when the camera target is behind the Head', () => {
    const authored = {
      ...neutralDirection,
      leftEyeYaw: -0.5,
      rightEyeYaw: 0.25
    }
    const resolved = resolveSocketEyeGaze(
      definition,
      [0, 0, -0.3],
      authored,
      { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS },
      true
    )
    expect(resolved.contactStatus).toBe('target-behind')
    expect(resolved.projections).toBeNull()
    expect(resolved.headFollowPressure).toBe(0)
    expect(resolved.gaze).toEqual(resolveAuthoredSocketEyeCoordinates(definition, authored))
  })

  it('does not project an irrelevant camera target while Eye Contact is inactive', () => {
    const resolved = resolveSocketEyeGaze(
      definition,
      [0, 0, -0.3],
      neutralDirection,
      { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS, enabled: false },
      true
    )
    expect(resolved.contactStatus).toBe('inactive')
    expect(resolved.projections).toBeNull()
    expect(resolved.gaze).toEqual({
      left: { horizontal: -0, vertical: 0 },
      right: { horizontal: -0, vertical: 0 }
    })
  })

  it('preserves asymmetric authored ARKit direction when contact is disabled', () => {
    const authored = {
      ...neutralDirection,
      leftEyeYaw: -1,
      rightEyeYaw: 0.5,
      leftEyePitch: 0.5,
      rightEyePitch: -0.25
    }
    const coordinates = resolveAuthoredSocketEyeCoordinates(definition, authored)
    expect(coordinates.left).toEqual({ horizontal: 0.75, vertical: 0.3 })
    expect(coordinates.right).toEqual({ horizontal: -0.375, vertical: -0.15 })
  })

  it('maps final per-eye socket coordinates into all eight ARKit Look accommodation channels', () => {
    const weights = resolveSocketEyeLookTargetWeights(definition, {
      left: { horizontal: -0.375, vertical: -0.3 },
      right: { horizontal: -0.15, vertical: 0.15 }
    })
    expect(Object.fromEntries(weights)).toMatchObject({
      eyeLookInLeft: 0.5,
      eyeLookOutLeft: 0,
      eyeLookUpLeft: 0,
      eyeLookDownLeft: 0.5,
      eyeLookInRight: 0,
      eyeLookUpRight: 0.25,
      eyeLookDownRight: 0
    })
    expect(weights.get('eyeLookOutRight')).toBeCloseTo(0.2)
  })

  it('derives Head Follow from the same target and scales it by pressure and setting', () => {
    expect(resolveSocketEyeHeadAssist([1, 0.5, 1], 0, 1)).toEqual({
      headYaw: 0,
      headPitch: 0
    })
    const assisted = resolveSocketEyeHeadAssist([1, 0.5, 1], 1, 0.5)
    expect(assisted.headYaw).toBeLessThan(0)
    expect(assisted.headPitch).toBeGreaterThan(0)
    expect(Math.abs(assisted.headYaw)).toBeLessThanOrEqual(0.5)
    expect(resolveSocketEyeHeadAssist([-1, 0.5, 1], 1, 0.5).headYaw).toBeGreaterThan(0)
  })

  it('uses the same Head Follow response while leaving center and returning to it', () => {
    const away = smoothSocketEyeHeadAssist(
      { headYaw: 0, headPitch: 0 },
      { headYaw: -0.8, headPitch: 0.4 },
      0.25
    )
    expect(away.headYaw).toBeCloseTo(-0.2)
    expect(away.headPitch).toBeCloseTo(0.1)

    const returning = smoothSocketEyeHeadAssist(
      away,
      { headYaw: 0, headPitch: 0 },
      0.25
    )
    expect(returning.headYaw).toBeCloseTo(-0.15)
    expect(returning.headPitch).toBeCloseTo(0.075)
  })
})

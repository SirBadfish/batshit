import { describe, expect, it } from 'vitest'
import {
  SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE,
  SOCKET_EYE_RADIAL_ARTWORK_BOUNDARY_UV_SCALE,
  projectConstantSphericalEyeLayerUv,
  projectFixedEyeHighlightUv,
  projectScleraEquirectangularUv,
  projectViewResponsiveEyeHighlightUv,
  resolveFixedEyeHighlightAlpha,
  wrapSocketEyeLongitude,
  type SocketEyeArtworkVector
} from './socketEyeArtworkProjection'

const IDENTITY_HIGHLIGHT = {
  scale: 1,
  translateU: 0,
  translateV: 0,
  rotationDegrees: 0
} as const

function directionForGaze(horizontal: number, vertical: number): SocketEyeArtworkVector {
  return {
    horizontal,
    vertical,
    forward: Math.sqrt(1 - horizontal * horizontal - vertical * vertical)
  }
}

function circularDistance(a: number, b: number) {
  const direct = Math.abs(a - b)
  return Math.min(direct, 1 - direct)
}

function normalize(value: SocketEyeArtworkVector): SocketEyeArtworkVector {
  const magnitude = Math.hypot(value.horizontal, value.vertical, value.forward)
  return {
    horizontal: value.horizontal / magnitude,
    vertical: value.vertical / magnitude,
    forward: value.forward / magnitude
  }
}

function dot(left: SocketEyeArtworkVector, right: SocketEyeArtworkVector) {
  return (
    left.horizontal * right.horizontal +
    left.vertical * right.vertical +
    left.forward * right.forward
  )
}

function sphericalCapBoundaryDirection(
  center: { horizontal: number; vertical: number },
  radiusRatio: number,
  azimuthRadians: number
): SocketEyeArtworkVector {
  const centerDirection = directionForGaze(center.horizontal, center.vertical)
  const horizontalTangent = normalize({
    horizontal: centerDirection.forward,
    vertical: 0,
    forward: -centerDirection.horizontal
  })
  const verticalTangent = normalize({
    horizontal: centerDirection.vertical * horizontalTangent.forward,
    vertical:
      centerDirection.forward * horizontalTangent.horizontal -
      centerDirection.horizontal * horizontalTangent.forward,
    forward: -centerDirection.vertical * horizontalTangent.horizontal
  })
  const angularRadius = Math.asin(radiusRatio)
  const tangentHorizontal = Math.cos(azimuthRadians)
  const tangentVertical = Math.sin(azimuthRadians)
  return normalize({
    horizontal:
      centerDirection.horizontal * Math.cos(angularRadius) +
      (horizontalTangent.horizontal * tangentHorizontal +
        verticalTangent.horizontal * tangentVertical) *
        Math.sin(angularRadius),
    vertical:
      centerDirection.vertical * Math.cos(angularRadius) +
      (horizontalTangent.vertical * tangentHorizontal +
        verticalTangent.vertical * tangentVertical) *
        Math.sin(angularRadius),
    forward:
      centerDirection.forward * Math.cos(angularRadius) +
      (horizontalTangent.forward * tangentHorizontal + verticalTangent.forward * tangentVertical) *
        Math.sin(angularRadius)
  })
}

function radialNormalForHighlightUv(u: number, v: number): SocketEyeArtworkVector {
  const reflectionDirection = normalize({
    horizontal: (u - 0.5) / SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE,
    vertical: (0.5 - v) / SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE,
    forward: Math.sqrt(
      Math.max(
        0,
        1 -
          ((u - 0.5) / SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE) ** 2 -
          ((0.5 - v) / SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE) ** 2
      )
    )
  })
  // A specular normal bisects the surface-to-camera and reflected directions.
  return normalize({
    horizontal: reflectionDirection.horizontal,
    vertical: reflectionDirection.vertical,
    forward: reflectionDirection.forward + 1
  })
}

describe('Socket Eye artwork projections', () => {
  describe('constant spherical-cap Iris and Pupil mapping', () => {
    it('maps every cap center to artwork center at neutral and extreme gaze positions', () => {
      for (const center of [
        { horizontal: 0, vertical: 0 },
        { horizontal: 0.58, vertical: 0 },
        { horizontal: -0.58, vertical: 0.45 },
        { horizontal: 0.2, vertical: -0.45 }
      ]) {
        const surfaceDirection = directionForGaze(center.horizontal, center.vertical)
        const projection = projectConstantSphericalEyeLayerUv({
          surfaceDirection,
          center,
          radiusRatio: 0.42
        })
        expect(projection.uv.u).toBeCloseTo(0.5, 12)
        expect(projection.uv.v).toBeCloseTo(0.5, 12)
        expect(projection.angularDistanceRadians).toBeCloseTo(0, 7)
        expect(projection.insideLayer).toBe(true)
      }
    })

    it('keeps the same angular footprint and exact artwork rim around every gaze center', () => {
      for (const radiusRatio of [0.12, 0.35, 0.62]) {
        const expectedAngularRadius = Math.asin(radiusRatio)
        for (const center of [
          { horizontal: 0, vertical: 0 },
          { horizontal: 0.58, vertical: 0.1 },
          { horizontal: -0.5, vertical: -0.45 }
        ]) {
          for (let step = 0; step < 16; step += 1) {
            const azimuth = (step / 16) * Math.PI * 2
            const surfaceDirection = sphericalCapBoundaryDirection(center, radiusRatio, azimuth)
            const projection = projectConstantSphericalEyeLayerUv({
              surfaceDirection,
              center,
              radiusRatio
            })
            expect(projection.angularRadiusRadians).toBeCloseTo(expectedAngularRadius, 12)
            expect(projection.angularDistanceRadians).toBeCloseTo(expectedAngularRadius, 12)
            expect(Math.hypot(projection.uv.u - 0.5, projection.uv.v - 0.5)).toBeCloseTo(0.5, 12)
            expect(projection.insideLayer).toBe(true)
          }
        }
      }
    })

    it('maps the v2 physical rim to one exact inset authoring circle', () => {
      const radiusRatio = 0.42
      for (let step = 0; step < 32; step += 1) {
        const surfaceDirection = sphericalCapBoundaryDirection(
          { horizontal: 0.48, vertical: -0.22 },
          radiusRatio,
          (step / 32) * Math.PI * 2
        )
        const projection = projectConstantSphericalEyeLayerUv({
          surfaceDirection,
          center: { horizontal: 0.48, vertical: -0.22 },
          radiusRatio,
          artworkUvScale: SOCKET_EYE_RADIAL_ARTWORK_BOUNDARY_UV_SCALE
        })
        expect(Math.hypot(projection.uv.u - 0.5, projection.uv.v - 0.5)).toBeCloseTo(
          (999 / 1024) * 0.5,
          12
        )
      }
    })

    it('rejects samples beyond the spherical cap instead of inflating a planar disk', () => {
      const center = { horizontal: 0.58, vertical: 0.2 }
      const radiusRatio = 0.35
      const boundary = sphericalCapBoundaryDirection(center, radiusRatio, 0)
      const beyond = normalize({
        horizontal: boundary.horizontal + 0.03,
        vertical: boundary.vertical,
        forward: boundary.forward - 0.04
      })
      const projection = projectConstantSphericalEyeLayerUv({
        surfaceDirection: beyond,
        center,
        radiusRatio
      })
      expect(projection.insideLayer).toBe(false)
      expect(projection.angularDistanceRadians).toBeGreaterThan(projection.angularRadiusRadians)
    })

    it('fails loudly for impossible centers, radii, and surface directions', () => {
      expect(() =>
        projectConstantSphericalEyeLayerUv({
          surfaceDirection: { horizontal: 0, vertical: 0, forward: 1 },
          center: { horizontal: 1, vertical: 0 },
          radiusRatio: 0.5
        })
      ).toThrow(/center must stay strictly inside/)
      expect(() =>
        projectConstantSphericalEyeLayerUv({
          surfaceDirection: { horizontal: 0, vertical: 0, forward: 1 },
          center: { horizontal: 0, vertical: 0 },
          radiusRatio: 1
        })
      ).toThrow(/radiusRatio must stay inside/)
      expect(() =>
        projectConstantSphericalEyeLayerUv({
          surfaceDirection: { horizontal: 0, vertical: 0, forward: 0 },
          center: { horizontal: 0, vertical: 0 },
          radiusRatio: 0.5
        })
      ).toThrow(/must not be degenerate/)
    })
  })

  describe('full-sphere Sclera equirectangular mapping', () => {
    it('maps the complete neutral sphere into the canonical 2:1 cardinal coordinates', () => {
      const project = (surfaceDirection: SocketEyeArtworkVector) =>
        projectScleraEquirectangularUv({
          surfaceDirection,
          gaze: { horizontal: 0, vertical: 0 },
          artworkRotationDegrees: 0
        }).uv

      expect(project({ horizontal: 0, vertical: 0, forward: 1 })).toEqual({
        u: 0.5,
        v: 0.5
      })
      expect(project({ horizontal: 1, vertical: 0, forward: 0 })).toEqual({
        u: 0.75,
        v: 0.5
      })
      expect(project({ horizontal: -1, vertical: 0, forward: 0 })).toEqual({
        u: 0.25,
        v: 0.5
      })
      expect(project({ horizontal: 0, vertical: 0, forward: -1 })).toEqual({
        u: 0,
        v: 0.5
      })
      expect(project({ horizontal: 0, vertical: 1, forward: 0 })).toEqual({
        u: 0.5,
        v: 0
      })
      expect(project({ horizontal: 0, vertical: -1, forward: 0 })).toEqual({
        u: 0.5,
        v: 1
      })
    })

    it('moves the Sclera with gaze by mapping the gaze-facing surface back to artwork center', () => {
      for (const gaze of [
        { horizontal: 0.3, vertical: 0 },
        { horizontal: -0.25, vertical: 0.2 },
        { horizontal: 0.1, vertical: -0.35 }
      ]) {
        const projection = projectScleraEquirectangularUv({
          surfaceDirection: directionForGaze(gaze.horizontal, gaze.vertical),
          gaze,
          artworkRotationDegrees: 0
        })
        expect(projection.uv.u).toBeCloseTo(0.5, 12)
        expect(projection.uv.v).toBeCloseTo(0.5, 12)
      }
    })

    it('keeps additive artwork rotation independent from gaze rotation', () => {
      const input = {
        surfaceDirection: {
          horizontal: -0.2,
          vertical: 0.25,
          forward: 0.9473647661
        },
        gaze: { horizontal: 0.2, vertical: -0.15 }
      }
      const gazeOnly = projectScleraEquirectangularUv({
        ...input,
        artworkRotationDegrees: 0
      })
      const withArtworkRotation = projectScleraEquirectangularUv({
        ...input,
        artworkRotationDegrees: 90
      })
      expect(withArtworkRotation.uv.u).toBeCloseTo(wrapSocketEyeLongitude(gazeOnly.uv.u - 0.25), 12)
      expect(withArtworkRotation.uv.v).toBeCloseTo(gazeOnly.uv.v, 12)
    })

    it('wraps continuously across the rear seam and canonicalizes both poles', () => {
      const nearLeft = projectScleraEquirectangularUv({
        surfaceDirection: { horizontal: -1e-8, vertical: 0, forward: -1 },
        gaze: { horizontal: 0, vertical: 0 },
        artworkRotationDegrees: 0
      })
      const nearRight = projectScleraEquirectangularUv({
        surfaceDirection: { horizontal: 1e-8, vertical: 0, forward: -1 },
        gaze: { horizontal: 0, vertical: 0 },
        artworkRotationDegrees: 0
      })
      expect(circularDistance(nearLeft.uv.u, nearRight.uv.u)).toBeLessThan(1e-7)

      for (const vertical of [-1, 1]) {
        const pole = projectScleraEquirectangularUv({
          surfaceDirection: { horizontal: 0, vertical, forward: 0 },
          gaze: { horizontal: 0, vertical: 0 },
          artworkRotationDegrees: 45
        })
        expect(pole.atPole).toBe(true)
        expect(pole.uv.u).toBeCloseTo(0.375, 12)
        expect(pole.uv.v).toBe(vertical > 0 ? 0 : 1)
      }
    })

    it('applies the accepted non-Highlight right reflection exactly once', () => {
      const common = {
        surfaceDirection: { horizontal: 0.4, vertical: 0.1, forward: 0.91 },
        gaze: { horizontal: 0, vertical: 0 },
        artworkRotationDegrees: 30
      }
      const left = projectScleraEquirectangularUv(common)
      const right = projectScleraEquirectangularUv({
        ...common,
        mirrorU: true
      })
      expect(right.uv.u).toBeCloseTo(
        wrapSocketEyeLongitude(1 - (left.uv.u + 30 / 360) - 30 / 360),
        12
      )
      expect(right.uv.v).toBeCloseTo(left.uv.v, 12)
    })

    it('fails loudly for invalid gaze and degenerate surface directions', () => {
      expect(() =>
        projectScleraEquirectangularUv({
          surfaceDirection: { horizontal: 0, vertical: 0, forward: 0 },
          gaze: { horizontal: 0, vertical: 0 },
          artworkRotationDegrees: 0
        })
      ).toThrow(/must not be degenerate/)
      expect(() =>
        projectScleraEquirectangularUv({
          surfaceDirection: { horizontal: 0, vertical: 0, forward: 1 },
          gaze: { horizontal: 0.9, vertical: 0.9 },
          artworkRotationDegrees: 0
        })
      ).toThrow(/inside the unit sphere/)
    })
  })

  describe('legacy fixed front/cornea-space Eye Highlight mapping', () => {
    it('places identity shared artwork in the same orientation on both eyes', () => {
      const upperRightSurface = {
        horizontal: 0.5,
        vertical: 0.5,
        forward: Math.SQRT1_2
      }
      const left = projectFixedEyeHighlightUv({
        surfaceDirection: upperRightSurface,
        transform: IDENTITY_HIGHLIGHT
      })
      const right = projectFixedEyeHighlightUv({
        surfaceDirection: upperRightSurface,
        transform: IDENTITY_HIGHLIGHT
      })
      expect(left).toEqual(right)
      expect(left.uv.u).toBeGreaterThan(0.5)
      expect(left.uv.v).toBeLessThan(0.5)
    })

    it('depends only on fixed surface position and Highlight transform', () => {
      const input = {
        surfaceDirection: { horizontal: 0.2, vertical: 0.35, forward: 0.915 },
        transform: IDENTITY_HIGHLIGHT
      }
      const baseline = projectFixedEyeHighlightUv(input)
      // Gaze, Iris placement, and Iris size deliberately have no input slot in
      // this projection contract; every such external state resolves identically.
      for (const _irrelevantEyeState of [
        { gaze: [-0.4, 0.25], irisOffset: [-0.5, -0.7], irisSize: 0.5 },
        { gaze: [0, 0], irisOffset: [0, 0], irisSize: 1 },
        { gaze: [0.45, -0.2], irisOffset: [0.5, 0.7], irisSize: 1.5 }
      ]) {
        expect(projectFixedEyeHighlightUv(input)).toEqual(baseline)
      }
    })

    it('preserves the same movement and rotation signs without a right-eye mirror', () => {
      const surfaceDirection = {
        horizontal: 0.25,
        vertical: 0.3,
        forward: 0.92
      }
      const identity = projectFixedEyeHighlightUv({
        surfaceDirection,
        transform: IDENTITY_HIGHLIGHT
      })
      const movedRight = projectFixedEyeHighlightUv({
        surfaceDirection,
        transform: { ...IDENTITY_HIGHLIGHT, translateU: 0.1 }
      })
      const rotated = projectFixedEyeHighlightUv({
        surfaceDirection,
        transform: { ...IDENTITY_HIGHLIGHT, rotationDegrees: 90 }
      })
      expect(movedRight.uv.u).toBeCloseTo(identity.uv.u - 0.1, 12)
      expect(rotated.uv.u).toBeCloseTo(identity.uv.v, 12)
      expect(rotated.uv.v).toBeCloseTo(1 - identity.uv.u, 12)
    })

    it('composes alpha without an Iris mask while still rejecting rear or off-artwork samples', () => {
      const front = projectFixedEyeHighlightUv({
        surfaceDirection: { horizontal: 0.8, vertical: 0, forward: 0.6 },
        transform: IDENTITY_HIGHLIGHT
      })
      expect(resolveFixedEyeHighlightAlpha(0.8, 0.5, front)).toBeCloseTo(0.4, 12)

      const rear = projectFixedEyeHighlightUv({
        surfaceDirection: { horizontal: 0, vertical: 0, forward: -1 },
        transform: IDENTITY_HIGHLIGHT
      })
      expect(resolveFixedEyeHighlightAlpha(1, 1, rear)).toBe(0)

      const offArtwork = projectFixedEyeHighlightUv({
        surfaceDirection: { horizontal: 0.8, vertical: 0, forward: 0.6 },
        transform: { ...IDENTITY_HIGHLIGHT, translateU: -1 }
      })
      expect(offArtwork.insideArtwork).toBe(false)
      expect(resolveFixedEyeHighlightAlpha(1, 1, offArtwork)).toBe(0)
    })

    it('fails loudly for invalid transforms and alpha inputs', () => {
      expect(() =>
        projectFixedEyeHighlightUv({
          surfaceDirection: { horizontal: 0, vertical: 0, forward: 1 },
          transform: { ...IDENTITY_HIGHLIGHT, scale: 0 }
        })
      ).toThrow(/scale must be greater than zero/)
      expect(() =>
        resolveFixedEyeHighlightAlpha(1.1, 1, {
          frontFacing: true,
          insideArtwork: true
        })
      ).toThrow(/sampleAlpha must be inside/)
    })
  })

  describe('view-responsive reflected-cornea Eye Highlight mapping', () => {
    it('keeps shared artwork unmirrored and in the same screen orientation for both eyes', () => {
      const common = {
        radialNormalView: radialNormalForHighlightUv(0.82, 0.18),
        viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
        transform: IDENTITY_HIGHLIGHT
      }
      const left = projectViewResponsiveEyeHighlightUv(common)
      const right = projectViewResponsiveEyeHighlightUv(common)
      expect(left).toEqual(right)
      expect(left.uv.u).toBeCloseTo(0.82, 12)
      expect(left.uv.v).toBeCloseTo(0.18, 12)
      expect(left.frontFacing).toBe(true)
    })

    it('makes the exact trusted source region reachable without an Iris-shaped crop', () => {
      // The exact source alpha bounds are x=689..930 and y=130..438 in 1024px.
      for (const uv of [
        { u: 689 / 1024, v: 438 / 1024 },
        { u: 930 / 1024, v: 130 / 1024 }
      ]) {
        const projection = projectViewResponsiveEyeHighlightUv({
          radialNormalView: radialNormalForHighlightUv(uv.u, uv.v),
          viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
          transform: IDENTITY_HIGHLIGHT
        })
        expect(projection.uv.u).toBeCloseTo(uv.u, 12)
        expect(projection.uv.v).toBeCloseTo(uv.v, 12)
        expect(projection.insideArtwork).toBe(true)
        expect(projection.frontFacing).toBe(true)
      }
    })

    it('moves continuously with the view while remaining independent of gaze and Iris state', () => {
      const radialNormalView = normalize({
        horizontal: 0.2,
        vertical: 0.3,
        forward: 0.93
      })
      const headOn = projectViewResponsiveEyeHighlightUv({
        radialNormalView,
        viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
        transform: IDENTITY_HIGHLIGHT
      })
      const angledView = projectViewResponsiveEyeHighlightUv({
        radialNormalView,
        viewDirection: normalize({
          horizontal: 0.2,
          vertical: 0,
          forward: 0.98
        }),
        transform: IDENTITY_HIGHLIGHT
      })
      expect(angledView.uv.u).not.toBeCloseTo(headOn.uv.u, 6)

      // Gaze, Iris placement, and Iris size deliberately have no contract input.
      for (const _irrelevantEyeState of [
        { gaze: [-0.58, 0.45], irisOffset: [-0.5, -0.7], irisSize: 0.5 },
        { gaze: [0.58, -0.45], irisOffset: [0.5, 0.7], irisSize: 1.5 }
      ]) {
        expect(
          projectViewResponsiveEyeHighlightUv({
            radialNormalView,
            viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
            transform: IDENTITY_HIGHLIGHT
          })
        ).toEqual(headOn)
      }
    })

    it('maps every square canvas corner to a reachable front-cornea sample', () => {
      for (const u of [0, 1]) {
        for (const v of [0, 1]) {
          const projection = projectViewResponsiveEyeHighlightUv({
            radialNormalView: radialNormalForHighlightUv(u, v),
            viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
            transform: IDENTITY_HIGHLIGHT
          })
          expect(projection.uv.u).toBeCloseTo(u, 12)
          expect(projection.uv.v).toBeCloseTo(v, 12)
          expect(projection.insideArtwork).toBe(true)
          expect(projection.frontFacing).toBe(true)
          expect(
            dot(projection.reflectionDirectionView, projection.reflectionDirectionView)
          ).toBeCloseTo(1, 12)
        }
      }
    })

    it('preserves the accepted control signs and rejects rear-facing samples', () => {
      const radialNormalView = radialNormalForHighlightUv(0.7, 0.3)
      const identity = projectViewResponsiveEyeHighlightUv({
        radialNormalView,
        viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
        transform: IDENTITY_HIGHLIGHT
      })
      const movedRight = projectViewResponsiveEyeHighlightUv({
        radialNormalView,
        viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
        transform: { ...IDENTITY_HIGHLIGHT, translateU: 0.1 }
      })
      const rotated = projectViewResponsiveEyeHighlightUv({
        radialNormalView,
        viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
        transform: { ...IDENTITY_HIGHLIGHT, rotationDegrees: 90 }
      })
      expect(movedRight.uv.u).toBeCloseTo(identity.uv.u - 0.1, 12)
      expect(rotated.uv.u).toBeCloseTo(identity.uv.v, 12)
      expect(rotated.uv.v).toBeCloseTo(1 - identity.uv.u, 12)

      const rear = projectViewResponsiveEyeHighlightUv({
        radialNormalView: { horizontal: 0, vertical: 0, forward: -1 },
        viewDirection: { horizontal: 0, vertical: 0, forward: 1 },
        transform: IDENTITY_HIGHLIGHT
      })
      expect(rear.frontFacing).toBe(false)
      expect(resolveFixedEyeHighlightAlpha(1, 1, rear)).toBe(0)
    })
  })
})

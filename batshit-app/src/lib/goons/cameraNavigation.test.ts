import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  GOON_CINEMATIC_WHEEL_ZOOM_SENSITIVITY,
  clampCameraPositionToPaddedBox,
  pointerClientToNdc,
  resolveCinematicGoonZoomTarget,
  resolveGoonRelativeRecenter,
  resolveGoonFraming,
  resolveHybridCameraZoom,
  resolveHybridCameraZoomAtPosition,
  resolvePerspectiveCursorZoom,
  resolvePerspectivePinnedPointZoom,
  resolvePerspectiveScreenPanDelta,
  resolvePerspectiveNearPlaneClearance,
  resolvePerspectiveCursorDolly,
  resolveSceneAwareFreeCameraDistanceLimits,
  resolveUnifiedZoomDistance,
  type GoonFramingPreset
} from '$lib/goons/cameraNavigation'

function createCamera() {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.03, 100)
  camera.position.set(0, 1.4, 2.2)
  camera.lookAt(0, 1.4, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return camera
}

describe('Goon camera navigation', () => {
  it('keeps the same world ray pinned through repeated cursor-focused zoom', () => {
    const camera = createCamera()
    const pointerNdc = new THREE.Vector2(-0.34, 0.52)
    const pinnedWorldPoint = new THREE.Vector3(pointerNdc.x, pointerNdc.y, 1)
      .unproject(camera)
      .sub(camera.position)
      .normalize()
      .multiplyScalar(4)
      .add(camera.position)
    let currentDistance = 2.2
    let target = new THREE.Vector3(0, 1.4, 0)

    for (let step = 0; step < 20; step += 1) {
      const nextDistance = resolveUnifiedZoomDistance({
        currentDistance,
        minDistance: 0.8,
        maxDistance: 6,
        delta: -18
      })
      const result = resolvePerspectiveCursorDolly({
        camera,
        pointerNdc,
        currentDistance,
        nextDistance
      })
      expect(result).not.toBeNull()
      camera.position.copy(result!.nextPosition)
      target = result!.nextTarget
      camera.lookAt(target)
      camera.updateMatrixWorld()
      currentDistance = nextDistance
      const projected = pinnedWorldPoint.clone().project(camera)
      expect(projected.x).toBeCloseTo(pointerNdc.x, 10)
      expect(projected.y).toBeCloseTo(pointerNdc.y, 10)
    }
  })

  it('uses both horizontal and vertical pointer position', () => {
    const camera = createCamera()
    const left = resolvePerspectiveCursorDolly({
      camera,
      pointerNdc: new THREE.Vector2(-0.6, 0.4),
      currentDistance: 2.2,
      nextDistance: 1.8
    })
    const right = resolvePerspectiveCursorDolly({
      camera,
      pointerNdc: new THREE.Vector2(0.6, -0.4),
      currentDistance: 2.2,
      nextDistance: 1.8
    })
    expect(left!.nextPosition.x).toBeLessThan(camera.position.x)
    expect(right!.nextPosition.x).toBeGreaterThan(camera.position.x)
    expect(left!.nextPosition.y).toBeGreaterThan(camera.position.y)
    expect(right!.nextPosition.y).toBeLessThan(camera.position.y)
  })

  it('keeps the cursor ray pinned while the hybrid zoom changes both distance and FOV', () => {
    const camera = createCamera()
    const pointerNdc = new THREE.Vector2(0.41, -0.27)
    const currentDistance = 2.2
    const pinnedWorldPoint = new THREE.Vector3(pointerNdc.x, pointerNdc.y, 1)
      .unproject(camera)
      .sub(camera.position)
      .normalize()
      .multiplyScalar(currentDistance)
      .add(camera.position)
    const result = resolvePerspectiveCursorZoom({
      camera,
      pointerNdc,
      currentDistance,
      nextDistance: 2.2,
      nextFovDegrees: 35
    })

    expect(result).not.toBeNull()
    camera.position.copy(result!.nextPosition)
    camera.fov = result!.nextFovDegrees
    camera.updateProjectionMatrix()
    camera.lookAt(result!.nextTarget)
    camera.updateMatrixWorld()
    const projected = pinnedWorldPoint.project(camera)
    expect(projected.x).toBeCloseTo(pointerNdc.x, 10)
    expect(projected.y).toBeCloseTo(pointerNdc.y, 10)
  })

  it('keeps an explicit Goon hit pinned when its ray depth differs from orbit distance', () => {
    const camera = createCamera()
    const pointerNdc = new THREE.Vector2(-0.38, 0.31)
    const pinnedPoint = new THREE.Vector3(pointerNdc.x, pointerNdc.y, 1)
      .unproject(camera)
      .sub(camera.position)
      .normalize()
      .multiplyScalar(1.35)
      .add(camera.position)
    let nextDistance = 2.05
    let nextFovDegrees = 46

    for (let step = 0; step < 12; step += 1) {
      const result = resolvePerspectivePinnedPointZoom({
        camera,
        pointerNdc,
        pinnedPoint,
        nextDistance,
        nextFovDegrees
      })
      expect(result).not.toBeNull()
      camera.position.copy(result!.nextPosition)
      camera.fov = nextFovDegrees
      camera.updateProjectionMatrix()
      camera.lookAt(result!.nextTarget)
      camera.updateMatrixWorld()
      const projected = pinnedPoint.clone().project(camera)
      expect(projected.x).toBeCloseTo(pointerNdc.x, 10)
      expect(projected.y).toBeCloseTo(pointerNdc.y, 10)
      nextDistance = Math.max(0.45, nextDistance - 0.12)
      nextFovDegrees = Math.max(18, nextFovDegrees - 1.7)
    }
  })

  it('progresses smoothly from full body to upper body to face', () => {
    const feet = new THREE.Vector3(0, 0, 0)
    const hips = new THREE.Vector3(0, 1, 0)
    const head = new THREE.Vector3(0, 2, 0)

    expect(resolveCinematicGoonZoomTarget({ head, hips, feet, projectedBodyHeightFraction: 0.5 }).y)
      .toBeCloseTo(1, 10)
    expect(resolveCinematicGoonZoomTarget({ head, hips, feet, projectedBodyHeightFraction: 1.15 }).y)
      .toBeCloseTo(1.5, 10)
    expect(resolveCinematicGoonZoomTarget({ head, hips, feet, projectedBodyHeightFraction: 1.8 }).y)
      .toBeCloseTo(2, 10)

    const beforeFirstTransition = resolveCinematicGoonZoomTarget({
      head,
      hips,
      feet,
      projectedBodyHeightFraction: 1.1499
    })
    const afterFirstTransition = resolveCinematicGoonZoomTarget({
      head,
      hips,
      feet,
      projectedBodyHeightFraction: 1.1501
    })
    expect(beforeFirstTransition.distanceTo(afterFirstTransition)).toBeLessThan(0.001)
  })

  it('resolves perspective-correct screen pan without changing camera depth', () => {
    const camera = createCamera()
    const delta = resolvePerspectiveScreenPanDelta({
      camera,
      deltaX: 120,
      deltaY: -60,
      viewportHeight: 900,
      targetDistance: 2.2
    })
    expect(delta.x).toBeLessThan(0)
    expect(delta.y).toBeLessThan(0)
    expect(delta.z).toBeCloseTo(0, 10)

    const doubledDistance = resolvePerspectiveScreenPanDelta({
      camera,
      deltaX: 120,
      deltaY: -60,
      viewportHeight: 900,
      targetDistance: 4.4
    })
    expect(doubledDistance.length()).toBeCloseTo(delta.length() * 2, 10)
  })

  it('recenters a moved Goon around the currently viewed body-area anchor', () => {
    const currentGoonPosition = new THREE.Vector3(1, 0, -2)
    const currentOrbitTarget = new THREE.Vector3(1, 1.82, -2)
    const currentCameraPosition = new THREE.Vector3(1.2, 1.9, 0.4)
    const nextGoonPosition = new THREE.Vector3(-2.5, 0.4, 3)
    const beforeDistance = currentCameraPosition.distanceTo(currentOrbitTarget)
    const result = resolveGoonRelativeRecenter({
      currentCameraPosition,
      currentOrbitTarget,
      currentGoonPosition,
      nextGoonPosition
    })

    expect(result.goonRelativeTarget.x).toBeCloseTo(0, 10)
    expect(result.goonRelativeTarget.y).toBeCloseTo(1.82, 10)
    expect(result.goonRelativeTarget.z).toBeCloseTo(0, 10)
    expect(result.nextTarget.clone().sub(nextGoonPosition).distanceTo(result.goonRelativeTarget))
      .toBeLessThan(1e-10)
    expect(result.nextCameraPosition.distanceTo(result.nextTarget)).toBeCloseTo(beforeDistance, 10)
    expect(
      result.nextCameraPosition
        .clone()
        .sub(result.nextTarget)
        .normalize()
        .distanceTo(currentCameraPosition.clone().sub(currentOrbitTarget).normalize())
    ).toBeLessThan(1e-10)
  })

  it('round-trips zoom distance and clamps at both limits', () => {
    const minDistance = 0.8
    const maxDistance = 6
    const start = 3.4
    const zoomed = resolveUnifiedZoomDistance({
      currentDistance: start,
      minDistance,
      maxDistance,
      delta: -40
    })
    const restored = resolveUnifiedZoomDistance({
      currentDistance: zoomed,
      minDistance,
      maxDistance,
      delta: 40
    })
    expect(restored).toBeCloseTo(start, 10)
    expect(
      resolveUnifiedZoomDistance({ currentDistance: minDistance, minDistance, maxDistance, delta: -120 })
    ).toBe(minDistance)
    expect(
      resolveUnifiedZoomDistance({ currentDistance: maxDistance, minDistance, maxDistance, delta: 120 })
    ).toBe(maxDistance)
  })

  it('round-trips the hybrid one-scroll path across every zone', () => {
    const config = {
      minDistance: 0.8,
      maxDistance: 18,
      minFov: 15,
      baseFov: 65,
      maxFov: 100
    }

    for (const logicalPosition of [0.08, 0.14, 0.3, 0.72, 0.84, 0.94]) {
      const start = resolveHybridCameraZoomAtPosition({ ...config, logicalPosition })
      const moved = resolveHybridCameraZoom({
        ...config,
        currentDistance: start.distance,
        currentFov: start.fov,
        delta: 20
      })
      const restored = resolveHybridCameraZoom({
        ...config,
        currentDistance: moved.distance,
        currentFov: moved.fov,
        delta: -20
      })
      expect(restored.logicalPosition).toBeCloseTo(logicalPosition, 10)
      expect(restored.distance).toBeCloseTo(start.distance, 10)
      expect(restored.fov).toBeCloseTo(start.fov, 10)
    }
  })

  it('uses the same reduced production wheel rate for zooming in and out', () => {
    const config = {
      minDistance: 0.8,
      maxDistance: 18,
      minFov: 15,
      baseFov: 65,
      maxFov: 100
    }
    const rawWheelDelta = 40
    const expectedLogicalStep = rawWheelDelta * GOON_CINEMATIC_WHEEL_ZOOM_SENSITIVITY

    expect(GOON_CINEMATIC_WHEEL_ZOOM_SENSITIVITY).toBe(0.0005)
    for (const logicalPosition of [0.1, 0.5, 0.9]) {
      const start = resolveHybridCameraZoomAtPosition({ ...config, logicalPosition })
      const zoomedOut = resolveHybridCameraZoom({
        ...config,
        currentDistance: start.distance,
        currentFov: start.fov,
        delta: rawWheelDelta
      })
      const zoomedIn = resolveHybridCameraZoom({
        ...config,
        currentDistance: start.distance,
        currentFov: start.fov,
        delta: -rawWheelDelta
      })

      expect(zoomedOut.logicalPosition - logicalPosition).toBeCloseTo(expectedLogicalStep, 12)
      expect(logicalPosition - zoomedIn.logicalPosition).toBeCloseTo(expectedLogicalStep, 12)
    }
  })

  it('holds the base FOV through the physical middle and extends it only at the ends', () => {
    const config = {
      minDistance: 0.8,
      maxDistance: 18,
      minFov: 15,
      baseFov: 65,
      maxFov: 100
    }
    const close = resolveHybridCameraZoomAtPosition({ ...config, logicalPosition: 0.05 })
    const middle = resolveHybridCameraZoomAtPosition({ ...config, logicalPosition: 0.5 })
    const far = resolveHybridCameraZoomAtPosition({ ...config, logicalPosition: 0.95 })

    expect(close.zone).toBe('close-extension')
    expect(close.distance).toBe(config.minDistance)
    expect(close.fov).toBeLessThan(config.baseFov)
    expect(middle.zone).toBe('physical-dolly')
    expect(middle.distance).toBeGreaterThan(config.minDistance)
    expect(middle.distance).toBeLessThan(config.maxDistance)
    expect(middle.fov).toBe(config.baseFov)
    expect(far.zone).toBe('far-extension')
    expect(far.distance).toBe(config.maxDistance)
    expect(far.fov).toBeGreaterThan(config.baseFov)
  })

  it('derives Free Camera travel from off-center targets and scene bounds', () => {
    const target = new THREE.Vector3(5, 1, 0)
    const bounds = new THREE.Box3(
      new THREE.Vector3(-5, 0, -4),
      new THREE.Vector3(7, 3, 4)
    )
    const limits = resolveSceneAwareFreeCameraDistanceLimits({
      target,
      sceneBounds: bounds,
      exteriorMarginScale: 2
    })
    const farthestCornerDistance = target.distanceTo(new THREE.Vector3(-5, 3, -4))

    expect(limits.sceneRadius).toBeCloseTo(farthestCornerDistance, 10)
    expect(limits.maxDistance).toBeCloseTo(farthestCornerDistance * 2, 10)
    expect(limits.maxDistance).toBeGreaterThan(6)
  })

  it('uses explicit scene extent when measured bounds are unavailable', () => {
    const limits = resolveSceneAwareFreeCameraDistanceLimits({
      target: new THREE.Vector3(40, 20, -10),
      sceneExtent: new THREE.Vector3(6, 3, 8),
      exteriorMarginScale: 1.5
    })
    expect(limits.sceneRadius).toBe(10.44030650891055)
    expect(limits.maxDistance).toBeCloseTo(limits.sceneRadius * 1.5, 10)
  })

  it('clamps box corners and ceilings while leaving sliding axes untouched', () => {
    const bounds = new THREE.Box3(
      new THREE.Vector3(-5, 0, -4),
      new THREE.Vector3(5, 2.5, 4)
    )
    const corner = clampCameraPositionToPaddedBox({
      position: new THREE.Vector3(7, 3, -1.25),
      bounds,
      padding: new THREE.Vector3(0.2, 0.4, 0.2)
    })

    expect(corner?.position.toArray()).toEqual([4.8, 2.1, -1.25])
    expect(corner?.clampedAxes).toEqual({ x: true, y: true, z: false })

    const oppositeCorner = clampCameraPositionToPaddedBox({
      position: new THREE.Vector3(-9, -1, 10),
      bounds,
      padding: 0.25
    })
    expect(oppositeCorner?.position.toArray()).toEqual([-4.75, 0.25, 3.75])
    expect(oppositeCorner?.clampedAxes).toEqual({ x: true, y: true, z: true })
  })

  it('computes conservative perspective near-plane clearance', () => {
    const clearance = resolvePerspectiveNearPlaneClearance({
      near: 0.1,
      verticalFovDegrees: 90,
      aspect: 2,
      extraPadding: 0.05
    })
    expect(clearance.halfHeight).toBeCloseTo(0.1, 10)
    expect(clearance.halfWidth).toBeCloseTo(0.2, 10)
    expect(clearance.radius).toBeCloseTo(Math.hypot(0.1, 0.2, 0.1) + 0.05, 10)
  })

  it('converts a canvas-relative pointer into normalized device coordinates', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }
    expect(pointerClientToNdc({ clientX: 100, clientY: 50 }, rect)?.toArray()).toEqual([-1, 1])
    expect(pointerClientToNdc({ clientX: 500, clientY: 250 }, rect)?.toArray()).toEqual([1, -1])
    expect(pointerClientToNdc({ clientX: 300, clientY: 150 }, rect)?.toArray()).toEqual([0, 0])
  })

  it.each<[GoonFramingPreset, number]>([
    ['headshot', 0.8],
    ['portrait', 1.08],
    ['full-body', 2.08]
  ])('resolves deterministic %s framing from live avatar bounds', (preset, expectedDistance) => {
    const framing = resolveGoonFraming({
      bounds: new THREE.Box3(new THREE.Vector3(-0.35, 0, -0.2), new THREE.Vector3(0.35, 1.8, 0.2)),
      preset,
      verticalFovDegrees: 50,
      aspect: 16 / 9,
      minDistance: 0.8,
      maxDistance: 6
    })
    expect(framing).not.toBeNull()
    expect(framing!.distance).toBeCloseTo(expectedDistance, 1)
    expect(framing!.target.y).toBeGreaterThanOrEqual(0)
    expect(framing!.target.y).toBeLessThanOrEqual(1.8)
  })

  it('uses semantic anchors for stable headshot, portrait, and full-body crops', () => {
    const bounds = new THREE.Box3(
      new THREE.Vector3(-0.35, -0.9, -0.2),
      new THREE.Vector3(0.35, 1.8, 0.2)
    )
    const anchors = { headY: 1.56, hipsY: 1.1, feetY: 0 }
    const frame = (preset: GoonFramingPreset) =>
      resolveGoonFraming({
        bounds,
        anchors,
        preset,
        verticalFovDegrees: 50,
        aspect: 16 / 9,
        minDistance: 0.8,
        maxDistance: 6
      })!

    expect(frame('headshot').target.y).toBeCloseTo(1.588, 3)
    expect(frame('headshot').distance).toBe(0.8)
    expect(frame('portrait').target.y).toBeCloseTo(1.45, 3)
    expect(frame('portrait').distance).toBeGreaterThan(0.8)
    expect(frame('full-body').target.y).toBeCloseTo(0.9, 3)
    expect(frame('full-body').distance).toBeGreaterThan(frame('portrait').distance)
  })

  it('does not back a narrow headshot away to fit the avatar arms', () => {
    const bounds = new THREE.Box3(
      new THREE.Vector3(-0.4, 0, -0.2),
      new THREE.Vector3(0.4, 1.8, 0.2)
    )
    const anchors = { headY: 1.56, hipsY: 1.1, feetY: 0 }
    const frame = (preset: GoonFramingPreset) =>
      resolveGoonFraming({
        bounds,
        anchors,
        preset,
        verticalFovDegrees: 50,
        aspect: 0.55,
        minDistance: 0.8,
        maxDistance: 6
      })!

    expect(frame('headshot').distance).toBeLessThan(frame('portrait').distance)
    expect(frame('portrait').distance).toBeLessThan(frame('full-body').distance)
  })
})

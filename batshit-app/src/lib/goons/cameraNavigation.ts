import * as THREE from 'three'

export type GoonFramingPreset = 'headshot' | 'portrait' | 'full-body'

export type GoonFramingSlice = {
  bottomRatio: number
  topRatio: number
  margin: number
  widthRatio: number
}

export type HybridCameraZoomZone = 'close-extension' | 'physical-dolly' | 'far-extension'

export type HybridCameraZoomState = {
  distance: number
  fov: number
  logicalPosition: number
  zone: HybridCameraZoomZone
}

export type CameraBoxClampAxes = {
  x: boolean
  y: boolean
  z: boolean
}

const GOON_FRAMING_SLICES: Record<GoonFramingPreset, GoonFramingSlice> = {
  headshot: { bottomRatio: 0.66, topRatio: 1, margin: 1.14, widthRatio: 0.55 },
  portrait: { bottomRatio: 0.5, topRatio: 1, margin: 1.12, widthRatio: 0.8 },
  'full-body': { bottomRatio: 0, topRatio: 1, margin: 1.08, widthRatio: 1 }
}

export function pointerClientToNdc(
  pointer: { clientX: number; clientY: number },
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
) {
  if (!rect.width || !rect.height) return null
  return new THREE.Vector2(
    ((pointer.clientX - rect.left) / rect.width) * 2 - 1,
    -((pointer.clientY - rect.top) / rect.height) * 2 + 1
  )
}

export function resolvePerspectiveCursorDolly(options: {
  camera: THREE.PerspectiveCamera
  pointerNdc: THREE.Vector2
  currentDistance: number
  nextDistance: number
}) {
  return resolvePerspectiveCursorZoom(options)
}

/**
 * Keeps an explicit world-space subject under a stable screen-space pointer.
 * This is used for a Goon mesh hit that was captured once at wheel-gesture
 * start, rather than re-raycasting a different body point on every wheel tick.
 */
export function resolvePerspectivePinnedPointZoom(options: {
  camera: THREE.PerspectiveCamera
  pointerNdc: THREE.Vector2
  pinnedPoint: THREE.Vector3
  nextDistance: number
  nextFovDegrees?: number
}) {
  const { camera, pointerNdc, pinnedPoint, nextDistance } = options
  const nextFovDegrees = options.nextFovDegrees ?? camera.fov
  if (
    !Number.isFinite(nextDistance) ||
    !Number.isFinite(nextFovDegrees) ||
    nextDistance <= 0 ||
    nextFovDegrees <= 0 ||
    nextFovDegrees >= 180
  ) {
    return null
  }

  const nextProjectionCamera = camera.clone()
  nextProjectionCamera.fov = nextFovDegrees
  nextProjectionCamera.updateProjectionMatrix()
  nextProjectionCamera.updateMatrixWorld()
  const nextRayDirection = new THREE.Vector3(pointerNdc.x, pointerNdc.y, 1)
    .unproject(nextProjectionCamera)
    .sub(nextProjectionCamera.position)
    .normalize()
  if (!Number.isFinite(nextRayDirection.lengthSq()) || nextRayDirection.lengthSq() < 0.999) {
    return null
  }

  const nextPosition = pinnedPoint.clone().addScaledVector(nextRayDirection, -nextDistance)
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
  const nextTarget = nextPosition.clone().addScaledVector(forward, nextDistance)
  return {
    nextPosition,
    nextTarget,
    rayDirection: nextRayDirection,
    pinnedPoint: pinnedPoint.clone(),
    nextFovDegrees
  }
}

/**
 * Resolves a cursor-pinned camera move for both physical dolly and lens extension.
 * Neither the source camera nor its target is mutated.
 */
export function resolvePerspectiveCursorZoom(options: {
  camera: THREE.PerspectiveCamera
  pointerNdc: THREE.Vector2
  currentDistance: number
  nextDistance: number
  nextFovDegrees?: number
}) {
  const { camera, pointerNdc, currentDistance, nextDistance } = options
  const nextFovDegrees = options.nextFovDegrees ?? camera.fov
  if (
    !Number.isFinite(currentDistance) ||
    !Number.isFinite(nextDistance) ||
    !Number.isFinite(nextFovDegrees) ||
    currentDistance <= 0 ||
    nextDistance <= 0 ||
    nextFovDegrees <= 0 ||
    nextFovDegrees >= 180
  ) {
    return null
  }

  camera.updateMatrixWorld()
  const currentRayDirection = new THREE.Vector3(pointerNdc.x, pointerNdc.y, 1)
    .unproject(camera)
    .sub(camera.position)
    .normalize()
  if (
    !Number.isFinite(currentRayDirection.lengthSq()) ||
    currentRayDirection.lengthSq() < 0.999
  ) {
    return null
  }

  const nextProjectionCamera = camera.clone()
  nextProjectionCamera.fov = nextFovDegrees
  nextProjectionCamera.updateProjectionMatrix()
  nextProjectionCamera.updateMatrixWorld()
  const nextRayDirection = new THREE.Vector3(pointerNdc.x, pointerNdc.y, 1)
    .unproject(nextProjectionCamera)
    .sub(nextProjectionCamera.position)
    .normalize()
  if (!Number.isFinite(nextRayDirection.lengthSq()) || nextRayDirection.lengthSq() < 0.999) {
    return null
  }

  const pinnedPoint = camera.position.clone().addScaledVector(currentRayDirection, currentDistance)
  const resolved = resolvePerspectivePinnedPointZoom({
    camera,
    pointerNdc,
    pinnedPoint,
    nextDistance,
    nextFovDegrees
  })
  return resolved ? { ...resolved, currentRayDirection } : null
}

/**
 * Resolves the default Goon subject as it grows through the viewport. The
 * transitions are continuous so repeated wheel ticks do not jump between
 * hard-coded body anchors.
 */
export function resolveCinematicGoonZoomTarget(options: {
  head: THREE.Vector3
  hips: THREE.Vector3
  feet: THREE.Vector3
  projectedBodyHeightFraction: number
}) {
  const { head, hips, feet } = options
  const bodyHeight = Math.max(0, options.projectedBodyHeightFraction)
  const fullBodyTarget = feet.clone().lerp(head, 0.5)
  const upperBodyTarget = hips.clone().lerp(head, 0.5)

  if (bodyHeight <= 0.72) return fullBodyTarget
  if (bodyHeight < 1.15) {
    const progress = THREE.MathUtils.smoothstep(bodyHeight, 0.72, 1.15)
    return fullBodyTarget.lerp(upperBodyTarget, progress)
  }
  if (bodyHeight < 1.65) {
    const progress = THREE.MathUtils.smoothstep(bodyHeight, 1.15, 1.65)
    return upperBodyTarget.lerp(head, progress)
  }
  return head.clone()
}

/**
 * Converts a screen-space drag into a perspective-correct world translation.
 * The sign follows direct manipulation: dragging right/down moves the rendered
 * scene right/down by translating the camera left/up.
 */
export function resolvePerspectiveScreenPanDelta(options: {
  camera: THREE.PerspectiveCamera
  deltaX: number
  deltaY: number
  viewportHeight: number
  targetDistance: number
}) {
  const viewportHeight = Math.max(1, options.viewportHeight)
  const targetDistance = Math.max(0.001, options.targetDistance)
  const visibleWorldHeight =
    2 * targetDistance * Math.tan(THREE.MathUtils.degToRad(options.camera.fov) / 2)
  const worldPerPixel = visibleWorldHeight / viewportHeight
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(options.camera.quaternion).normalize()
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(options.camera.quaternion).normalize()
  return right
    .multiplyScalar(-options.deltaX * worldPerPixel)
    .add(up.multiplyScalar(options.deltaY * worldPerPixel))
}

/** Re-centers a moved Goon around the currently viewed Goon-relative anchor. */
export function resolveGoonRelativeRecenter(options: {
  currentCameraPosition: THREE.Vector3
  currentOrbitTarget: THREE.Vector3
  currentGoonPosition: THREE.Vector3
  nextGoonPosition: THREE.Vector3
}) {
  const goonRelativeTarget = options.currentOrbitTarget.clone().sub(options.currentGoonPosition)
  const cameraOffset = options.currentCameraPosition.clone().sub(options.currentOrbitTarget)
  const nextTarget = options.nextGoonPosition.clone().add(goonRelativeTarget)
  return {
    nextTarget,
    nextCameraPosition: nextTarget.clone().add(cameraOffset),
    goonRelativeTarget
  }
}

export function resolveUnifiedZoomDistance(options: {
  currentDistance: number
  minDistance: number
  maxDistance: number
  delta: number
}) {
  const { currentDistance, minDistance, maxDistance, delta } = options
  const range = minDistance - maxDistance || 1
  let t = THREE.MathUtils.clamp((currentDistance - maxDistance) / range, 0, 1)
  t = THREE.MathUtils.clamp(t - delta * 0.0015, 0, 1)
  return THREE.MathUtils.lerp(maxDistance, minDistance, t)
}

function resolveHybridZoomSegments(closeExtensionFraction: number, farExtensionFraction: number) {
  let close = THREE.MathUtils.clamp(closeExtensionFraction, 0.01, 0.45)
  let far = THREE.MathUtils.clamp(farExtensionFraction, 0.01, 0.45)
  const total = close + far
  if (total > 0.9) {
    close = (close / total) * 0.9
    far = (far / total) * 0.9
  }
  return { closeEnd: close, farStart: 1 - far }
}

/**
 * Maps one normalized logical zoom position onto three reversible zones:
 * close lens extension, physical dolly at a stable base FOV, and far lens extension.
 */
export function resolveHybridCameraZoomAtPosition(options: {
  logicalPosition: number
  minDistance: number
  maxDistance: number
  minFov: number
  baseFov: number
  maxFov: number
  closeExtensionFraction?: number
  farExtensionFraction?: number
}): HybridCameraZoomState {
  const minDistance = Math.max(0.001, Math.min(options.minDistance, options.maxDistance))
  const maxDistance = Math.max(minDistance, options.minDistance, options.maxDistance)
  const minFov = THREE.MathUtils.clamp(Math.min(options.minFov, options.baseFov), 1, 179)
  const baseFov = THREE.MathUtils.clamp(options.baseFov, minFov, 179)
  const maxFov = THREE.MathUtils.clamp(Math.max(options.maxFov, baseFov), baseFov, 179)
  const logicalPosition = THREE.MathUtils.clamp(options.logicalPosition, 0, 1)
  const { closeEnd, farStart } = resolveHybridZoomSegments(
    options.closeExtensionFraction ?? 0.15,
    options.farExtensionFraction ?? 0.15
  )

  if (logicalPosition < closeEnd) {
    return {
      distance: minDistance,
      fov: THREE.MathUtils.lerp(minFov, baseFov, logicalPosition / closeEnd),
      logicalPosition,
      zone: 'close-extension'
    }
  }
  if (logicalPosition > farStart) {
    return {
      distance: maxDistance,
      fov: THREE.MathUtils.lerp(baseFov, maxFov, (logicalPosition - farStart) / (1 - farStart)),
      logicalPosition,
      zone: 'far-extension'
    }
  }
  return {
    distance: THREE.MathUtils.lerp(
      minDistance,
      maxDistance,
      (logicalPosition - closeEnd) / (farStart - closeEnd)
    ),
    fov: baseFov,
    logicalPosition,
    zone: 'physical-dolly'
  }
}

/** Converts a rendered hybrid zoom state back to its normalized logical position. */
export function resolveHybridCameraZoomPosition(options: {
  currentDistance: number
  currentFov: number
  minDistance: number
  maxDistance: number
  minFov: number
  baseFov: number
  maxFov: number
  closeExtensionFraction?: number
  farExtensionFraction?: number
}) {
  const minDistance = Math.max(0.001, Math.min(options.minDistance, options.maxDistance))
  const maxDistance = Math.max(minDistance, options.minDistance, options.maxDistance)
  const minFov = Math.min(options.minFov, options.baseFov)
  const baseFov = options.baseFov
  const maxFov = Math.max(options.maxFov, baseFov)
  const { closeEnd, farStart } = resolveHybridZoomSegments(
    options.closeExtensionFraction ?? 0.15,
    options.farExtensionFraction ?? 0.15
  )
  const distanceEpsilon = Math.max(1e-7, (maxDistance - minDistance) * 1e-7)

  if (options.currentDistance <= minDistance + distanceEpsilon && options.currentFov < baseFov) {
    const fovT = THREE.MathUtils.inverseLerp(minFov, baseFov, options.currentFov)
    return THREE.MathUtils.clamp(fovT * closeEnd, 0, closeEnd)
  }
  if (options.currentDistance >= maxDistance - distanceEpsilon && options.currentFov > baseFov) {
    const fovT = THREE.MathUtils.inverseLerp(baseFov, maxFov, options.currentFov)
    return THREE.MathUtils.clamp(THREE.MathUtils.lerp(farStart, 1, fovT), farStart, 1)
  }

  const distanceT = THREE.MathUtils.inverseLerp(minDistance, maxDistance, options.currentDistance)
  return THREE.MathUtils.clamp(THREE.MathUtils.lerp(closeEnd, farStart, distanceT), closeEnd, farStart)
}

/** Applies wheel input to the reversible logical zoom path. Positive delta zooms out. */
export function resolveHybridCameraZoom(options: {
  currentDistance: number
  currentFov: number
  minDistance: number
  maxDistance: number
  minFov: number
  baseFov: number
  maxFov: number
  delta: number
  sensitivity?: number
  closeExtensionFraction?: number
  farExtensionFraction?: number
}): HybridCameraZoomState {
  const logicalPosition = resolveHybridCameraZoomPosition(options)
  return resolveHybridCameraZoomAtPosition({
    ...options,
    logicalPosition: logicalPosition + options.delta * (options.sensitivity ?? 0.0015)
  })
}

/**
 * Derives a cinematic Free Camera limit from the target to the farthest scene point.
 * `sceneExtent` is a target-relative radius (or half-extents when supplied as a Vector3).
 */
export function resolveSceneAwareFreeCameraDistanceLimits(options: {
  target: THREE.Vector3
  sceneBounds?: THREE.Box3 | null
  sceneExtent?: number | THREE.Vector3 | null
  minDistance?: number
  minimumMaxDistance?: number
  exteriorMarginScale?: number
}) {
  const minDistance = Math.max(0.001, options.minDistance ?? 0.8)
  let sceneRadius = 0

  if (options.sceneBounds && !options.sceneBounds.isEmpty()) {
    const { min, max } = options.sceneBounds
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          sceneRadius = Math.max(sceneRadius, options.target.distanceTo(new THREE.Vector3(x, y, z)))
        }
      }
    }
  }
  if (typeof options.sceneExtent === 'number' && Number.isFinite(options.sceneExtent)) {
    sceneRadius = Math.max(sceneRadius, Math.abs(options.sceneExtent))
  } else if (options.sceneExtent instanceof THREE.Vector3) {
    sceneRadius = Math.max(sceneRadius, options.sceneExtent.length())
  }

  const exteriorMarginScale = Math.max(1, options.exteriorMarginScale ?? 1.75)
  const minimumMaxDistance = Math.max(minDistance, options.minimumMaxDistance ?? 6)
  return {
    minDistance,
    maxDistance: Math.max(minimumMaxDistance, sceneRadius * exteriorMarginScale),
    sceneRadius
  }
}

/** Returns a conservative camera-center clearance that contains the whole near plane. */
export function resolvePerspectiveNearPlaneClearance(options: {
  near: number
  verticalFovDegrees: number
  aspect: number
  extraPadding?: number
}) {
  const near = Math.max(0, options.near)
  const halfHeight = near * Math.tan(THREE.MathUtils.degToRad(options.verticalFovDegrees) / 2)
  const halfWidth = halfHeight * Math.max(0, options.aspect)
  const extraPadding = Math.max(0, options.extraPadding ?? 0)
  return {
    halfWidth,
    halfHeight,
    radius: Math.hypot(near, halfWidth, halfHeight) + extraPadding
  }
}

/**
 * Clamps each axis independently inside a padded box, which naturally preserves
 * wall, corner, floor, and ceiling sliding. Inputs are never mutated.
 */
export function clampCameraPositionToPaddedBox(options: {
  position: THREE.Vector3
  bounds: THREE.Box3
  padding?: number | THREE.Vector3
}) {
  if (options.bounds.isEmpty()) return null
  const padding = typeof options.padding === 'number'
    ? new THREE.Vector3(options.padding, options.padding, options.padding)
    : options.padding?.clone() ?? new THREE.Vector3()
  padding.set(Math.max(0, padding.x), Math.max(0, padding.y), Math.max(0, padding.z))

  const position = options.position.clone()
  const clampedAxes: CameraBoxClampAxes = { x: false, y: false, z: false }
  const center = options.bounds.getCenter(new THREE.Vector3())

  for (const axis of ['x', 'y', 'z'] as const) {
    const minimum = options.bounds.min[axis] + padding[axis]
    const maximum = options.bounds.max[axis] - padding[axis]
    const next = minimum <= maximum
      ? THREE.MathUtils.clamp(position[axis], minimum, maximum)
      : center[axis]
    clampedAxes[axis] = next !== position[axis]
    position[axis] = next
  }

  return { position, clampedAxes }
}

export function resolveGoonFraming(options: {
  bounds: THREE.Box3
  preset: GoonFramingPreset
  verticalFovDegrees: number
  aspect: number
  minDistance: number
  maxDistance: number
  anchors?: { headY: number; hipsY: number; feetY: number } | null
}) {
  const { bounds, preset, verticalFovDegrees, aspect, minDistance, maxDistance, anchors } = options
  if (bounds.isEmpty()) return null

  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  const slice = GOON_FRAMING_SLICES[preset]
  const semanticSpan = anchors ? Math.max(0.01, anchors.headY - anchors.hipsY) : 0
  const top = anchors
    ? Math.max(bounds.max.y, anchors.headY + semanticSpan * 0.35)
    : bounds.min.y + size.y * slice.topRatio
  const bottom = anchors
    ? preset === 'full-body'
      ? anchors.feetY
      : preset === 'portrait'
        ? anchors.hipsY
        : anchors.headY - semanticSpan * 0.4
    : bounds.min.y + size.y * slice.bottomRatio
  const visibleHeight = Math.max(0.01, top - bottom)
  const visibleWidth = Math.max(0.01, size.x * slice.widthRatio)
  const verticalHalfAngle = THREE.MathUtils.degToRad(verticalFovDegrees) / 2
  const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * Math.max(0.01, aspect))
  const verticalDistance = visibleHeight / 2 / Math.tan(verticalHalfAngle)
  const horizontalDistance = visibleWidth / 2 / Math.tan(horizontalHalfAngle)
  const distance = THREE.MathUtils.clamp(
    Math.max(verticalDistance, horizontalDistance) * slice.margin,
    minDistance,
    maxDistance
  )

  center.y = (bottom + top) / 2
  return { target: center, distance }
}

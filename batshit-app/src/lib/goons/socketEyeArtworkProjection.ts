export const SOCKET_EYE_SCLERA_PROJECTION_CONTRACT =
  'full-sphere-equirectangular-gaze-linked/v1' as const

export const LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT = 'sphere-tangent-radial' as const

export const SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT = 'constant-spherical-cap-radial/v1' as const

export const SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT =
  'constant-spherical-cap-radial-inset/v2' as const

/**
 * The v2 1024-square radial authoring boundary leaves 12 transparent pixels
 * outside the painted circle. Physical Iris/Pupil edges sample the centers of
 * the outermost painted texels (12..1011), not the texture border.
 */
export const SOCKET_EYE_RADIAL_ARTWORK_BOUNDARY_UV_SCALE = 999 / 1024

export const LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT =
  'fixed-front-cornea-space-unmirrored/v1' as const

export const SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT =
  'view-responsive-cornea-reflection-unmirrored/v1' as const

/**
 * Reflection X/Y spans a unit disk. Scaling it by 1/sqrt(2) makes every pixel
 * in the square authoring canvas reachable without an Iris-shaped crop: each
 * canvas corner resolves to the reflection disk boundary.
 */
export const SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE = Math.SQRT1_2

export type SocketEyeArtworkVector = {
  horizontal: number
  vertical: number
  forward: number
}

export type SocketEyeArtworkUv = { u: number; v: number }

export type SocketEyeGazeCoordinate = {
  horizontal: number
  vertical: number
}

export type ConstantSphericalEyeLayerProjectionInput = {
  /** Unit sphere direction of the fragment in the package Socket Eye frame. */
  surfaceDirection: SocketEyeArtworkVector
  /** Layer center as normalized sphere X/Y coordinates. */
  center: SocketEyeGazeCoordinate
  /** Accepted front-projected physical radius divided by physical sphere radius. */
  radiusRatio: number
  /** Diameter scale of the exact circular authoring boundary inside the square. */
  artworkUvScale?: number
}

export type ConstantSphericalEyeLayerProjection = {
  uv: SocketEyeArtworkUv
  centerDirection: SocketEyeArtworkVector
  angularRadiusRadians: number
  angularDistanceRadians: number
  insideLayer: boolean
}

export type ScleraEquirectangularProjectionInput = {
  /** Direction from the sphere center, expressed in the package Socket Eye frame. */
  surfaceDirection: SocketEyeArtworkVector
  /** Iris/gaze surface coordinate. Its radial magnitude must stay inside the unit sphere. */
  gaze: SocketEyeGazeCoordinate
  /** Existing artist-facing longitude convention: positive rotation subtracts sampled U. */
  artworkRotationDegrees: number
  /** Accepted non-Highlight bilateral law: reflect the sampled longitude exactly once. */
  mirrorU?: boolean
}

export type ScleraEquirectangularProjection = {
  uv: SocketEyeArtworkUv
  /** The texture-space direction after undoing gaze rotation. */
  artworkDirection: SocketEyeArtworkVector
  atPole: boolean
}

export type EyeHighlightTransform = {
  scale: number
  translateU: number
  translateV: number
  rotationDegrees: number
}

export type FixedEyeHighlightProjectionInput = {
  /** Direction from the sphere center, expressed in the package Socket Eye frame. */
  surfaceDirection: SocketEyeArtworkVector
  transform: EyeHighlightTransform
}

export type FixedEyeHighlightProjection = {
  uv: SocketEyeArtworkUv
  frontFacing: boolean
  insideArtwork: boolean
}

export type ViewResponsiveEyeHighlightProjectionInput = {
  /** Exact radial corneal normal in view space; presentation normal maps must not alter it. */
  radialNormalView: SocketEyeArtworkVector
  /** Per-fragment direction from the corneal surface toward the camera in view space. */
  viewDirection: SocketEyeArtworkVector
  transform: EyeHighlightTransform
}

export type ViewResponsiveEyeHighlightProjection = FixedEyeHighlightProjection & {
  reflectionDirectionView: SocketEyeArtworkVector
}

const VECTOR_EPSILON = 1e-12
const DOMAIN_EPSILON = 1e-9
const POLE_EPSILON = 1e-10
const TAU = Math.PI * 2

function fail(message: string): never {
  throw new Error(`[socket-eye-artwork-projection] ${message}`)
}

function finite(value: number, context: string) {
  if (!Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function normalizeVector(value: SocketEyeArtworkVector, context: string): SocketEyeArtworkVector {
  const horizontal = finite(value.horizontal, `${context}.horizontal`)
  const vertical = finite(value.vertical, `${context}.vertical`)
  const forward = finite(value.forward, `${context}.forward`)
  const magnitude = Math.hypot(horizontal, vertical, forward)
  if (magnitude <= VECTOR_EPSILON) fail(`${context} must not be degenerate`)
  return {
    horizontal: horizontal / magnitude,
    vertical: vertical / magnitude,
    forward: forward / magnitude
  }
}

function dotVector(left: SocketEyeArtworkVector, right: SocketEyeArtworkVector) {
  return (
    left.horizontal * right.horizontal +
    left.vertical * right.vertical +
    left.forward * right.forward
  )
}

function crossVector(
  left: SocketEyeArtworkVector,
  right: SocketEyeArtworkVector
): SocketEyeArtworkVector {
  return {
    horizontal: left.vertical * right.forward - left.forward * right.vertical,
    vertical: left.forward * right.horizontal - left.horizontal * right.forward,
    forward: left.horizontal * right.vertical - left.vertical * right.horizontal
  }
}

function clampUnit(value: number) {
  return Math.max(-1, Math.min(1, value))
}

function sphericalCenterDirection(value: SocketEyeGazeCoordinate): SocketEyeArtworkVector {
  const horizontal = finite(value.horizontal, 'center.horizontal')
  const vertical = finite(value.vertical, 'center.vertical')
  const radialSquared = horizontal * horizontal + vertical * vertical
  if (radialSquared >= 1 - DOMAIN_EPSILON) {
    fail('center must stay strictly inside the sphere front hemisphere')
  }
  return {
    horizontal,
    vertical,
    forward: Math.sqrt(1 - radialSquared)
  }
}

/**
 * Map Iris or Pupil artwork over one constant spherical cap.
 *
 * The definition-owned radius remains the accepted neutral front-projected
 * radius. `asin(radius / sphereRadius)` converts it exactly once into an
 * angular radius. Moving the center then rotates the cap instead of sliding a
 * flat X/Y disk across the sphere, so its surface footprint cannot inflate at
 * gaze extremes.
 */
export function projectConstantSphericalEyeLayerUv(
  input: ConstantSphericalEyeLayerProjectionInput
): ConstantSphericalEyeLayerProjection {
  const surfaceDirection = normalizeVector(input.surfaceDirection, 'surfaceDirection')
  const centerDirection = sphericalCenterDirection(input.center)
  const radiusRatio = finite(input.radiusRatio, 'radiusRatio')
  if (radiusRatio <= 0 || radiusRatio >= 1) fail('radiusRatio must stay inside (0, 1)')
  const artworkUvScale = finite(input.artworkUvScale ?? 1, 'artworkUvScale')
  if (artworkUvScale <= 0 || artworkUvScale > 1) {
    fail('artworkUvScale must stay inside (0, 1]')
  }

  const horizontalTangent = normalizeVector(
    {
      horizontal: centerDirection.forward,
      vertical: 0,
      forward: -centerDirection.horizontal
    },
    'center horizontal tangent'
  )
  const verticalTangent = normalizeVector(
    crossVector(centerDirection, horizontalTangent),
    'center vertical tangent'
  )
  const horizontal = dotVector(surfaceDirection, horizontalTangent)
  const vertical = dotVector(surfaceDirection, verticalTangent)
  const centerDot = clampUnit(dotVector(surfaceDirection, centerDirection))
  const angularRadiusRadians = Math.asin(radiusRatio)
  const angularDistanceRadians = Math.acos(centerDot)

  return {
    uv: {
      u: 0.5 + (horizontal / (radiusRatio * 2)) * artworkUvScale,
      // Facial artwork assets use the artist-facing top-left image convention.
      v: 0.5 - (vertical / (radiusRatio * 2)) * artworkUvScale
    },
    centerDirection,
    angularRadiusRadians,
    angularDistanceRadians,
    insideLayer: angularDistanceRadians <= angularRadiusRadians + DOMAIN_EPSILON
  }
}

/** Wrap texture longitude into a single seam-safe [0, 1) interval. */
export function wrapSocketEyeLongitude(value: number) {
  const parsed = finite(value, 'longitude')
  return ((parsed % 1) + 1) % 1
}

function gazeDirection(value: SocketEyeGazeCoordinate): SocketEyeArtworkVector {
  const horizontal = finite(value.horizontal, 'gaze.horizontal')
  const vertical = finite(value.vertical, 'gaze.vertical')
  const radialSquared = horizontal * horizontal + vertical * vertical
  if (radialSquared > 1 + DOMAIN_EPSILON) fail('gaze must stay inside the unit sphere')
  return normalizeVector(
    {
      horizontal,
      vertical,
      forward: Math.sqrt(Math.max(0, 1 - radialSquared))
    },
    'gaze direction'
  )
}

type Quaternion = { x: number; y: number; z: number; w: number }

/**
 * Minimal-roll rotation from neutral forward to the gaze direction.
 * Socket Eye's allowed gaze domain stays in the forward hemisphere, so the
 * antipodal quaternion singularity is unreachable by a valid package.
 */
function neutralToGazeQuaternion(gaze: SocketEyeArtworkVector): Quaternion {
  const quaternion = {
    x: -gaze.vertical,
    y: gaze.horizontal,
    z: 0,
    w: 1 + gaze.forward
  }
  const magnitude = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
  if (magnitude <= VECTOR_EPSILON) fail('gaze rotation must not be antipodal to neutral forward')
  return {
    x: quaternion.x / magnitude,
    y: quaternion.y / magnitude,
    z: 0,
    w: quaternion.w / magnitude
  }
}

function rotateByQuaternion(value: SocketEyeArtworkVector, q: Quaternion): SocketEyeArtworkVector {
  const tx = 2 * (q.y * value.forward - q.z * value.vertical)
  const ty = 2 * (q.z * value.horizontal - q.x * value.forward)
  const tz = 2 * (q.x * value.vertical - q.y * value.horizontal)
  return {
    horizontal: value.horizontal + q.w * tx + (q.y * tz - q.z * ty),
    vertical: value.vertical + q.w * ty + (q.z * tx - q.x * tz),
    forward: value.forward + q.w * tz + (q.x * ty - q.y * tx)
  }
}

function inverseRotateFromGaze(
  surfaceDirection: SocketEyeArtworkVector,
  gaze: SocketEyeArtworkVector
) {
  const q = neutralToGazeQuaternion(gaze)
  return normalizeVector(
    rotateByQuaternion(surfaceDirection, { x: -q.x, y: -q.y, z: -q.z, w: q.w }),
    'gaze-rotated surface direction'
  )
}

/**
 * Resolve a complete sphere to a 2:1 equirectangular artwork coordinate.
 *
 * Gaze is removed from the static surface direction before sampling, which
 * makes the texture move with the same minimal-roll sphere orientation as the
 * Iris/Pupil gaze. Artist rotation is then applied as an independent longitude
 * offset. Longitude wraps; latitude clamps only for floating-point drift.
 */
export function projectScleraEquirectangularUv(
  input: ScleraEquirectangularProjectionInput
): ScleraEquirectangularProjection {
  const surfaceDirection = normalizeVector(input.surfaceDirection, 'surfaceDirection')
  const artworkDirection = inverseRotateFromGaze(surfaceDirection, gazeDirection(input.gaze))
  const horizontalRadius = Math.hypot(artworkDirection.horizontal, artworkDirection.forward)
  const atPole = horizontalRadius <= POLE_EPSILON
  const neutralLongitude = atPole
    ? 0.5
    : 0.5 + Math.atan2(artworkDirection.horizontal, artworkDirection.forward) / TAU
  const bilateralLongitude = input.mirrorU ? 1 - neutralLongitude : neutralLongitude
  const artworkRotationTurns = finite(input.artworkRotationDegrees, 'artworkRotationDegrees') / 360

  return {
    uv: {
      u: wrapSocketEyeLongitude(bilateralLongitude - artworkRotationTurns),
      // Facial artwork assets use the artist-facing top-left image convention.
      v: 0.5 - Math.asin(Math.max(-1, Math.min(1, artworkDirection.vertical))) / Math.PI
    },
    artworkDirection,
    atPole
  }
}

/**
 * Resolve Highlight in fixed front/cornea space.
 *
 * The signature intentionally has no side, gaze, Iris placement, Iris size,
 * or Iris mask inputs. Shared left/right art therefore uses one orientation,
 * and Highlight coverage cannot accidentally inherit Iris-edge cropping.
 */
export function projectFixedEyeHighlightUv(
  input: FixedEyeHighlightProjectionInput
): FixedEyeHighlightProjection {
  const direction = normalizeVector(input.surfaceDirection, 'surfaceDirection')
  const scale = finite(input.transform.scale, 'transform.scale')
  if (scale <= 0) fail('transform.scale must be greater than zero')
  const translateU = finite(input.transform.translateU, 'transform.translateU')
  const translateV = finite(input.transform.translateV, 'transform.translateV')
  const rotation =
    (finite(input.transform.rotationDegrees, 'transform.rotationDegrees') * Math.PI) / 180

  // Front/cornea-space planar coordinates use the top-left artwork convention:
  // physical up samples the top half of the source image.
  const baseU = 0.5 + direction.horizontal * 0.5
  const baseV = 0.5 - direction.vertical * 0.5
  const deltaU = baseU - 0.5
  const deltaV = baseV - 0.5
  const cosine = Math.cos(rotation)
  const sine = Math.sin(rotation)
  // Preserve the existing user-facing transform signs: positive Horizontal
  // moves visible art right, positive Vertical moves it up, and Scale expands
  // visible art around the center.
  const u = 0.5 + (cosine * deltaU + sine * deltaV) / scale - translateU
  const v = 0.5 + (-sine * deltaU + cosine * deltaV) / scale + translateV
  const frontFacing = direction.forward >= 0
  const insideArtwork = u >= 0 && u <= 1 && v >= 0 && v <= 1
  return { uv: { u, v }, frontFacing, insideArtwork }
}

/**
 * Resolve Highlight from the reflected camera ray over the spherical cornea.
 *
 * The input deliberately has no side, gaze, Iris placement, Iris size, or Iris
 * mask. The reflected view ray changes continuously with camera/head angle,
 * while a shared source keeps the same screen/environment orientation in both
 * eyes. The square canvas is entirely reachable and owns the sole projection
 * boundary; natural eyelid/treatment depth remains the only anatomical crop.
 */
export function projectViewResponsiveEyeHighlightUv(
  input: ViewResponsiveEyeHighlightProjectionInput
): ViewResponsiveEyeHighlightProjection {
  const radialNormalView = normalizeVector(input.radialNormalView, 'radialNormalView')
  const viewDirection = normalizeVector(input.viewDirection, 'viewDirection')
  const scale = finite(input.transform.scale, 'transform.scale')
  if (scale <= 0) fail('transform.scale must be greater than zero')
  const translateU = finite(input.transform.translateU, 'transform.translateU')
  const translateV = finite(input.transform.translateV, 'transform.translateV')
  const rotation =
    (finite(input.transform.rotationDegrees, 'transform.rotationDegrees') * Math.PI) / 180
  const frontDot = dotVector(radialNormalView, viewDirection)
  const reflectionDirectionView = normalizeVector(
    {
      horizontal: 2 * frontDot * radialNormalView.horizontal - viewDirection.horizontal,
      vertical: 2 * frontDot * radialNormalView.vertical - viewDirection.vertical,
      forward: 2 * frontDot * radialNormalView.forward - viewDirection.forward
    },
    'reflected view direction'
  )
  const baseU = 0.5 + reflectionDirectionView.horizontal * SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE
  const baseV = 0.5 - reflectionDirectionView.vertical * SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE
  const deltaU = baseU - 0.5
  const deltaV = baseV - 0.5
  const cosine = Math.cos(rotation)
  const sine = Math.sin(rotation)
  const u = 0.5 + (cosine * deltaU + sine * deltaV) / scale - translateU
  const v = 0.5 + (-sine * deltaU + cosine * deltaV) / scale + translateV
  const frontFacing = frontDot >= 0
  const insideArtwork =
    u >= -DOMAIN_EPSILON &&
    u <= 1 + DOMAIN_EPSILON &&
    v >= -DOMAIN_EPSILON &&
    v <= 1 + DOMAIN_EPSILON
  return {
    uv: { u, v },
    frontFacing,
    insideArtwork,
    reflectionDirectionView
  }
}

/** Highlight alpha has only front-surface and artwork-boundary coverage. */
export function resolveFixedEyeHighlightAlpha(
  sampleAlpha: number,
  opacity: number,
  projection: Pick<FixedEyeHighlightProjection, 'frontFacing' | 'insideArtwork'>
) {
  const alpha = finite(sampleAlpha, 'sampleAlpha')
  const layerOpacity = finite(opacity, 'opacity')
  if (alpha < 0 || alpha > 1) fail('sampleAlpha must be inside [0, 1]')
  if (layerOpacity < 0 || layerOpacity > 1) fail('opacity must be inside [0, 1]')
  return projection.frontFacing && projection.insideArtwork ? alpha * layerOpacity : 0
}

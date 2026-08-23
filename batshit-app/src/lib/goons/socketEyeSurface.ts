export const SOCKET_EYE_SURFACE_SCHEMA_VERSION = 'socket-eye-surface/v2' as const

export type SocketEyeSide = 'left' | 'right'
export type SocketEyeVec3 = [number, number, number]
export type SocketEyeCompositeLayer =
  | 'sclera'
  | 'scleraArtwork'
  | 'iris'
  | 'pupil'
  | 'highlight'
  | 'cornea'

export const SOCKET_EYE_COMPOSITE_LAYER_ORDER = [
  'sclera',
  'scleraArtwork',
  'iris',
  'pupil',
  'highlight',
  'cornea'
] as const satisfies readonly SocketEyeCompositeLayer[]

export type SocketEyeSurfaceSideDefinitionV2 = {
  side: SocketEyeSide
  nodes: { physicalEye: string }
  apertureSeamDefinitionSha256: string
  gazeAnchorHeadLocal: SocketEyeVec3
  surfaceCenterHeadLocal: SocketEyeVec3
  horizontalAxisHeadLocal: SocketEyeVec3
  verticalAxisHeadLocal: SocketEyeVec3
  forwardAxisHeadLocal: SocketEyeVec3
  sphere: {
    geometryLaw: 'static-full-sphere/v1'
    radiusMeters: number
    artworkProjection: 'front-hemisphere-uv/v1'
    stableNeutralRear: true
    surfaceMorphTargets: []
    physicalFit: {
      mode: 'transform-only/v1'
      translation: true
      rotation: true
      uniformScale: true
      nonUniformScale: false
    }
  }
  gaze: {
    maximumHorizontal: number
    maximumVertical: number
    headFollowStart: number
  }
}

export type SocketEyeSurfaceDefinitionV2 = {
  schemaVersion: typeof SOCKET_EYE_SURFACE_SCHEMA_VERSION
  definitionSha256: string
  status: 'product-export-approved'
  productExportApproved: true
  coordinateSpace: 'head-local'
  surfaceKind: 'static-full-sphere'
  compositeLayers: typeof SOCKET_EYE_COMPOSITE_LAYER_ORDER
  rendering: {
    eyelidsOwnApertureOcclusion: true
    sphereDepthTest: true
    sphereDepthWrite: true
    sphereSide: 'front'
    renderOrder: 'after-face-before-treatment'
    requiredMaxTextureArrayLayers: number
  }
  artwork: {
    scleraOverlay: {
      projection: 'front-hemisphere-only/v1'
      transparentRgba: true
      rearPresentation: 'stable-neutral-base'
      gazeLinked: false
    }
  }
  runtimeBindings: {
    left: SocketEyeSurfaceSideDefinitionV2
    right: SocketEyeSurfaceSideDefinitionV2
  }
}

export type SocketEyeSurfaceProjection = {
  requested: { horizontal: number; vertical: number }
  resolved: { horizontal: number; vertical: number }
  clamped: boolean
  safeDomainRadius: number
  headFollowPressure: number
  targetDistanceMeters: number
  surfacePointHeadLocal: SocketEyeVec3
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const EPSILON = 1e-9
const AXIS_TOLERANCE = 1e-5

function fail(message: string): never {
  throw new Error(`[${SOCKET_EYE_SURFACE_SCHEMA_VERSION}] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  context: string
) {
  const accepted = new Set(allowed)
  const extra = Object.keys(source).filter((key) => !accepted.has(key))
  if (extra.length > 0) fail(`${context} contains unsupported fields: ${extra.join(', ')}`)
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function sha256(value: unknown, context: string): string {
  const parsed = stringValue(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function positive(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed <= 0) fail(`${context} must be greater than zero`)
  return parsed
}

function positiveInteger(value: unknown, context: string): number {
  const parsed = positive(value, context)
  if (!Number.isInteger(parsed)) fail(`${context} must be an integer`)
  return parsed
}

function openUnitInterval(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed <= 0 || parsed >= 1) fail(`${context} must be inside (0, 1)`)
  return parsed
}

function literal<T extends boolean | string>(value: unknown, expected: T, context: string): T {
  if (value !== expected) fail(`${context} must be ${expected}`)
  return expected
}

function emptyArray(value: unknown, context: string): [] {
  if (!Array.isArray(value) || value.length !== 0) {
    fail(`${context} must be an empty array because the physical eye is static`)
  }
  return []
}

function vec3(value: unknown, context: string): SocketEyeVec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${context} must contain three numbers`)
  return value.map((entry, index) => finite(entry, `${context}[${index}]`)) as SocketEyeVec3
}

function compositeLayers(value: unknown): typeof SOCKET_EYE_COMPOSITE_LAYER_ORDER {
  if (!Array.isArray(value) || value.length !== SOCKET_EYE_COMPOSITE_LAYER_ORDER.length) {
    fail('definition.compositeLayers must declare the complete ordered layer stack')
  }
  for (const [index, expected] of SOCKET_EYE_COMPOSITE_LAYER_ORDER.entries()) {
    if (value[index] !== expected) fail(`definition.compositeLayers[${index}] must be ${expected}`)
  }
  return SOCKET_EYE_COMPOSITE_LAYER_ORDER
}

function subtract(a: SocketEyeVec3, b: SocketEyeVec3): SocketEyeVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function add(a: SocketEyeVec3, b: SocketEyeVec3): SocketEyeVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scale(value: SocketEyeVec3, amount: number): SocketEyeVec3 {
  return [value[0] * amount, value[1] * amount, value[2] * amount]
}

function dot(a: SocketEyeVec3, b: SocketEyeVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: SocketEyeVec3, b: SocketEyeVec3): SocketEyeVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
}

function length(value: SocketEyeVec3): number {
  return Math.sqrt(dot(value, value))
}

function normalized(value: SocketEyeVec3, context: string): SocketEyeVec3 {
  const magnitude = length(value)
  if (magnitude <= EPSILON) fail(`${context} must not be degenerate`)
  return scale(value, 1 / magnitude)
}

function validateAxes(side: SocketEyeSurfaceSideDefinitionV2, context: string) {
  const axes = [
    ['horizontalAxisHeadLocal', side.horizontalAxisHeadLocal],
    ['verticalAxisHeadLocal', side.verticalAxisHeadLocal],
    ['forwardAxisHeadLocal', side.forwardAxisHeadLocal]
  ] as const
  for (const [name, axis] of axes) {
    if (Math.abs(length(axis) - 1) > AXIS_TOLERANCE) fail(`${context}.${name} must be unit length`)
  }
  if (Math.abs(dot(side.horizontalAxisHeadLocal, side.verticalAxisHeadLocal)) > AXIS_TOLERANCE) {
    fail(`${context} horizontal and vertical axes must be orthogonal`)
  }
  if (Math.abs(dot(side.horizontalAxisHeadLocal, side.forwardAxisHeadLocal)) > AXIS_TOLERANCE) {
    fail(`${context} horizontal and forward axes must be orthogonal`)
  }
  if (Math.abs(dot(side.verticalAxisHeadLocal, side.forwardAxisHeadLocal)) > AXIS_TOLERANCE) {
    fail(`${context} vertical and forward axes must be orthogonal`)
  }
  const handedness = dot(
    normalized(cross(side.horizontalAxisHeadLocal, side.verticalAxisHeadLocal), `${context} axes`),
    side.forwardAxisHeadLocal
  )
  if (handedness < 1 - AXIS_TOLERANCE) fail(`${context} axes must form a right-handed frame`)
}

function parseSide(
  value: unknown,
  expectedSide: SocketEyeSide,
  context: string
): SocketEyeSurfaceSideDefinitionV2 {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'side',
      'nodes',
      'apertureSeamDefinitionSha256',
      'gazeAnchorHeadLocal',
      'surfaceCenterHeadLocal',
      'horizontalAxisHeadLocal',
      'verticalAxisHeadLocal',
      'forwardAxisHeadLocal',
      'sphere',
      'gaze'
    ],
    context
  )
  if (source.side !== expectedSide) fail(`${context}.side must be ${expectedSide}`)

  const nodes = record(source.nodes, `${context}.nodes`)
  rejectUnknownKeys(nodes, ['physicalEye'], `${context}.nodes`)
  const sphere = record(source.sphere, `${context}.sphere`)
  rejectUnknownKeys(
    sphere,
    [
      'geometryLaw',
      'radiusMeters',
      'artworkProjection',
      'stableNeutralRear',
      'surfaceMorphTargets',
      'physicalFit'
    ],
    `${context}.sphere`
  )
  const physicalFit = record(sphere.physicalFit, `${context}.sphere.physicalFit`)
  rejectUnknownKeys(
    physicalFit,
    ['mode', 'translation', 'rotation', 'uniformScale', 'nonUniformScale'],
    `${context}.sphere.physicalFit`
  )
  const gaze = record(source.gaze, `${context}.gaze`)
  rejectUnknownKeys(gaze, ['maximumHorizontal', 'maximumVertical', 'headFollowStart'], `${context}.gaze`)

  const parsed: SocketEyeSurfaceSideDefinitionV2 = {
    side: expectedSide,
    nodes: { physicalEye: stringValue(nodes.physicalEye, `${context}.nodes.physicalEye`) },
    apertureSeamDefinitionSha256: sha256(
      source.apertureSeamDefinitionSha256,
      `${context}.apertureSeamDefinitionSha256`
    ),
    gazeAnchorHeadLocal: vec3(source.gazeAnchorHeadLocal, `${context}.gazeAnchorHeadLocal`),
    surfaceCenterHeadLocal: vec3(source.surfaceCenterHeadLocal, `${context}.surfaceCenterHeadLocal`),
    horizontalAxisHeadLocal: vec3(source.horizontalAxisHeadLocal, `${context}.horizontalAxisHeadLocal`),
    verticalAxisHeadLocal: vec3(source.verticalAxisHeadLocal, `${context}.verticalAxisHeadLocal`),
    forwardAxisHeadLocal: vec3(source.forwardAxisHeadLocal, `${context}.forwardAxisHeadLocal`),
    sphere: {
      geometryLaw: literal(sphere.geometryLaw, 'static-full-sphere/v1', `${context}.sphere.geometryLaw`),
      radiusMeters: positive(sphere.radiusMeters, `${context}.sphere.radiusMeters`),
      artworkProjection: literal(
        sphere.artworkProjection,
        'front-hemisphere-uv/v1',
        `${context}.sphere.artworkProjection`
      ),
      stableNeutralRear: literal(sphere.stableNeutralRear, true, `${context}.sphere.stableNeutralRear`),
      surfaceMorphTargets: emptyArray(sphere.surfaceMorphTargets, `${context}.sphere.surfaceMorphTargets`),
      physicalFit: {
        mode: literal(physicalFit.mode, 'transform-only/v1', `${context}.sphere.physicalFit.mode`),
        translation: literal(physicalFit.translation, true, `${context}.sphere.physicalFit.translation`),
        rotation: literal(physicalFit.rotation, true, `${context}.sphere.physicalFit.rotation`),
        uniformScale: literal(physicalFit.uniformScale, true, `${context}.sphere.physicalFit.uniformScale`),
        nonUniformScale: literal(
          physicalFit.nonUniformScale,
          false,
          `${context}.sphere.physicalFit.nonUniformScale`
        )
      }
    },
    gaze: {
      maximumHorizontal: openUnitInterval(gaze.maximumHorizontal, `${context}.gaze.maximumHorizontal`),
      maximumVertical: openUnitInterval(gaze.maximumVertical, `${context}.gaze.maximumVertical`),
      headFollowStart: openUnitInterval(gaze.headFollowStart, `${context}.gaze.headFollowStart`)
    }
  }

  validateAxes(parsed, context)
  const anchorFromCenter = subtract(parsed.gazeAnchorHeadLocal, parsed.surfaceCenterHeadLocal)
  if (dot(anchorFromCenter, parsed.forwardAxisHeadLocal) > EPSILON) {
    fail(`${context} gaze anchor must stay on or behind the sphere center plane`)
  }
  if (
    Math.abs(dot(anchorFromCenter, parsed.horizontalAxisHeadLocal)) > EPSILON ||
    Math.abs(dot(anchorFromCenter, parsed.verticalAxisHeadLocal)) > EPSILON
  ) {
    fail(`${context} gaze anchor must stay centered behind the physical eye`)
  }
  return parsed
}

export function parseSocketEyeSurfaceDefinition(value: unknown): SocketEyeSurfaceDefinitionV2 {
  const source = record(value, 'definition')
  rejectUnknownKeys(
    source,
    [
      'schemaVersion',
      'definitionSha256',
      'status',
      'productExportApproved',
      'coordinateSpace',
      'surfaceKind',
      'compositeLayers',
      'rendering',
      'artwork',
      'runtimeBindings'
    ],
    'definition'
  )
  if (source.schemaVersion !== SOCKET_EYE_SURFACE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SOCKET_EYE_SURFACE_SCHEMA_VERSION}`)
  }
  const definitionSha256 = sha256(source.definitionSha256, 'definition.definitionSha256')
  literal(source.coordinateSpace, 'head-local', 'definition.coordinateSpace')
  literal(source.surfaceKind, 'static-full-sphere', 'definition.surfaceKind')

  const rendering = record(source.rendering, 'definition.rendering')
  rejectUnknownKeys(
    rendering,
    [
      'eyelidsOwnApertureOcclusion',
      'sphereDepthTest',
      'sphereDepthWrite',
      'sphereSide',
      'renderOrder',
      'requiredMaxTextureArrayLayers'
    ],
    'definition.rendering'
  )
  const artwork = record(source.artwork, 'definition.artwork')
  rejectUnknownKeys(artwork, ['scleraOverlay'], 'definition.artwork')
  const scleraOverlay = record(artwork.scleraOverlay, 'definition.artwork.scleraOverlay')
  rejectUnknownKeys(
    scleraOverlay,
    ['projection', 'transparentRgba', 'rearPresentation', 'gazeLinked'],
    'definition.artwork.scleraOverlay'
  )

  const runtimeBindings = record(source.runtimeBindings, 'definition.runtimeBindings')
  rejectUnknownKeys(runtimeBindings, ['left', 'right'], 'definition.runtimeBindings')
  const left = parseSide(runtimeBindings.left, 'left', 'definition.runtimeBindings.left')
  const right = parseSide(runtimeBindings.right, 'right', 'definition.runtimeBindings.right')
  if (left.nodes.physicalEye === right.nodes.physicalEye) {
    fail('left/right physical-eye nodes must be unique')
  }

  return {
    schemaVersion: SOCKET_EYE_SURFACE_SCHEMA_VERSION,
    definitionSha256,
    status: literal(source.status, 'product-export-approved', 'definition.status'),
    productExportApproved: literal(source.productExportApproved, true, 'definition.productExportApproved'),
    coordinateSpace: 'head-local',
    surfaceKind: 'static-full-sphere',
    compositeLayers: compositeLayers(source.compositeLayers),
    rendering: {
      eyelidsOwnApertureOcclusion: literal(
        rendering.eyelidsOwnApertureOcclusion,
        true,
        'definition.rendering.eyelidsOwnApertureOcclusion'
      ),
      sphereDepthTest: literal(rendering.sphereDepthTest, true, 'definition.rendering.sphereDepthTest'),
      sphereDepthWrite: literal(rendering.sphereDepthWrite, true, 'definition.rendering.sphereDepthWrite'),
      sphereSide: literal(rendering.sphereSide, 'front', 'definition.rendering.sphereSide'),
      renderOrder: literal(
        rendering.renderOrder,
        'after-face-before-treatment',
        'definition.rendering.renderOrder'
      ),
      requiredMaxTextureArrayLayers: positiveInteger(
        rendering.requiredMaxTextureArrayLayers,
        'definition.rendering.requiredMaxTextureArrayLayers'
      )
    },
    artwork: {
      scleraOverlay: {
        projection: literal(
          scleraOverlay.projection,
          'front-hemisphere-only/v1',
          'definition.artwork.scleraOverlay.projection'
        ),
        transparentRgba: literal(
          scleraOverlay.transparentRgba,
          true,
          'definition.artwork.scleraOverlay.transparentRgba'
        ),
        rearPresentation: literal(
          scleraOverlay.rearPresentation,
          'stable-neutral-base',
          'definition.artwork.scleraOverlay.rearPresentation'
        ),
        gazeLinked: literal(
          scleraOverlay.gazeLinked,
          false,
          'definition.artwork.scleraOverlay.gazeLinked'
        )
      }
    },
    runtimeBindings: { left, right }
  }
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function surfacePoint(
  side: SocketEyeSurfaceSideDefinitionV2,
  horizontal: number,
  vertical: number
): SocketEyeVec3 {
  const radialSquared = horizontal * horizontal + vertical * vertical
  if (radialSquared > 1 + EPSILON) fail('resolved eye coordinate left the sphere domain')
  const radius = side.sphere.radiusMeters
  const depth = radius * Math.sqrt(Math.max(0, 1 - radialSquared))
  return add(
    add(
      add(side.surfaceCenterHeadLocal, scale(side.horizontalAxisHeadLocal, horizontal * radius)),
      scale(side.verticalAxisHeadLocal, vertical * radius)
    ),
    scale(side.forwardAxisHeadLocal, depth)
  )
}

/** Preserve the accepted gaze/contact law on the real static physical sphere. */
export function projectTargetToSocketEyeSurface(
  side: SocketEyeSurfaceSideDefinitionV2,
  targetHeadLocal: SocketEyeVec3
): SocketEyeSurfaceProjection {
  const target = vec3(targetHeadLocal, 'targetHeadLocal')
  const targetDelta = subtract(target, side.gazeAnchorHeadLocal)
  const targetDistanceMeters = length(targetDelta)
  if (targetDistanceMeters <= EPSILON) fail('targetHeadLocal must not equal the gaze anchor')
  const direction = scale(targetDelta, 1 / targetDistanceMeters)
  const dx = dot(direction, side.horizontalAxisHeadLocal)
  const dy = dot(direction, side.verticalAxisHeadLocal)
  const dz = dot(direction, side.forwardAxisHeadLocal)
  if (dz <= EPSILON) fail('targetHeadLocal must be in front of the physical eye')

  const anchorFromCenter = subtract(side.gazeAnchorHeadLocal, side.surfaceCenterHeadLocal)
  const ax = dot(anchorFromCenter, side.horizontalAxisHeadLocal)
  const ay = dot(anchorFromCenter, side.verticalAxisHeadLocal)
  const az = dot(anchorFromCenter, side.forwardAxisHeadLocal)
  const radius = side.sphere.radiusMeters
  const quadratic = (dx * dx + dy * dy + dz * dz) / (radius * radius)
  const linear = (2 * (ax * dx + ay * dy + az * dz)) / (radius * radius)
  const constant = (ax * ax + ay * ay + az * az) / (radius * radius) - 1
  const discriminant = linear * linear - 4 * quadratic * constant
  if (discriminant < 0) fail('target ray does not intersect the physical eye sphere')
  const root = Math.sqrt(discriminant)
  const candidates = [
    (-linear - root) / (2 * quadratic),
    (-linear + root) / (2 * quadratic)
  ].filter((candidate) => candidate > EPSILON && az + candidate * dz >= -EPSILON)
  if (candidates.length === 0) fail('target ray intersects only the rear eye hemisphere')
  const distanceAlongRay = Math.min(...candidates)
  if (!Number.isFinite(distanceAlongRay) || distanceAlongRay <= EPSILON) {
    fail('target ray produced an invalid eye-sphere intersection')
  }

  const requestedHorizontal = (ax + distanceAlongRay * dx) / radius
  const requestedVertical = (ay + distanceAlongRay * dy) / radius
  const safeDomainRadius = Math.sqrt(
    (requestedHorizontal * requestedHorizontal) /
      (side.gaze.maximumHorizontal * side.gaze.maximumHorizontal) +
      (requestedVertical * requestedVertical) /
        (side.gaze.maximumVertical * side.gaze.maximumVertical)
  )
  const clampScale = safeDomainRadius > 1 ? 1 / safeDomainRadius : 1
  const horizontal = requestedHorizontal * clampScale
  const vertical = requestedVertical * clampScale

  return {
    requested: { horizontal: requestedHorizontal, vertical: requestedVertical },
    resolved: { horizontal, vertical },
    clamped: safeDomainRadius > 1,
    safeDomainRadius,
    headFollowPressure: smoothstep(side.gaze.headFollowStart, 1, safeDomainRadius),
    targetDistanceMeters,
    surfacePointHeadLocal: surfacePoint(side, horizontal, vertical)
  }
}

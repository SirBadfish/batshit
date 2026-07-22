export const SOCKET_EYE_SURFACE_SCHEMA_VERSION = 'socket-eye-surface/v1' as const

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

export type SocketEyeSurfaceSideDefinition = {
  side: SocketEyeSide
  nodes: {
    compositeCap: string
  }
  apertureSeamDefinitionSha256: string
  gazeAnchorHeadLocal: SocketEyeVec3
  surfaceCenterHeadLocal: SocketEyeVec3
  horizontalAxisHeadLocal: SocketEyeVec3
  verticalAxisHeadLocal: SocketEyeVec3
  forwardAxisHeadLocal: SocketEyeVec3
  cap: {
    frontGeometryLaw: 'aperture-normalized-shallow-patch/v1'
    frontDepthRatio: number
    maximumFrontDepthMeters: number
    artworkProjection: 'deformed-surface-meters/v1'
    carrierHalfWidthMeters: number
    carrierHalfHeightMeters: number
    carrierDepthRadiusMeters: number
    rearClosureDepthMeters: number
    minimumHiddenUnderlapMeters: number
    visibleFrontFaceGroup: string
    hiddenClosureFaceGroup: string
    primitiveFollowerMorphs: {
      visibleFront: string[]
      hiddenClosure: string[]
    }
    apertureFollowing: true
    closedManifold: true
  }
  gaze: {
    maximumHorizontal: number
    maximumVertical: number
    headFollowStart: number
  }
}

export type SocketEyeSurfaceDefinitionV1 = {
  schemaVersion: typeof SOCKET_EYE_SURFACE_SCHEMA_VERSION
  definitionSha256: string
  status: 'product-export-approved'
  productExportApproved: true
  coordinateSpace: 'head-local'
  surfaceKind: 'aperture-following-composite-cap'
  compositeLayers: typeof SOCKET_EYE_COMPOSITE_LAYER_ORDER
  rendering: {
    meshOwnsApertureMask: true
    visibleFrontDepthTest: true
    visibleFrontDepthWrite: true
    visibleFrontSide: 'front'
    renderOrder: 'after-face-before-liner'
    requiredMaxTextureArrayLayers: number
  }
  artwork: {
    scleraOverlay: {
      gazeLinked: true
      transparentRgba: true
      minimumOverscanHorizontal: number
      minimumOverscanVertical: number
    }
  }
  runtimeBindings: {
    left: SocketEyeSurfaceSideDefinition
    right: SocketEyeSurfaceSideDefinition
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

/**
 * Live composite caps retain only the three socket-aperture expression followers.
 * The package's primitiveFollowerMorphs inventory is intentionally broader:
 * it also proves every authoring-only identity morph present on the cap.
 */
export function socketEyeCapRetainedDynamicMorphs(side: SocketEyeSide): string[] {
  const suffix = side === 'left' ? 'Left' : 'Right'
  return [`eyeBlink${suffix}`, `eyeSquint${suffix}`, `eyeWide${suffix}`]
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const EPSILON = 1e-9
const AXIS_TOLERANCE = 1e-5

function fail(message: string): never {
  throw new Error(`[socket-eye-surface/v1] ${message}`)
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
  const allowedKeys = new Set(allowed)
  const extra = Object.keys(source).filter((key) => !allowedKeys.has(key))
  if (extra.length > 0) fail(`${context} contains unsupported fields: ${extra.join(', ')}`)
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
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

function unitInterval(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed <= 0 || parsed >= 1) fail(`${context} must be inside (0, 1)`)
  return parsed
}

function literal<T extends boolean | string>(value: unknown, expected: T, context: string): T {
  if (value !== expected) fail(`${context} must be ${expected}`)
  return expected
}

function vec3(value: unknown, context: string): SocketEyeVec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${context} must contain three numbers`)
  return value.map((entry, index) => finite(entry, `${context}[${index}]`)) as SocketEyeVec3
}

function followerMorphInventory(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${context} must be a non-empty array`)
  }
  const parsed = value.map((entry, index) => stringValue(entry, `${context}[${index}]`))
  if (new Set(parsed).size !== parsed.length) fail(`${context} must not contain duplicates`)
  const sorted = [...parsed].sort()
  if (parsed.some((entry, index) => entry !== sorted[index])) {
    fail(`${context} must be sorted`)
  }
  return parsed
}

function primitiveFollowerMorphs(
  value: unknown,
  side: SocketEyeSide,
  context: string
): { visibleFront: string[]; hiddenClosure: string[] } {
  const source = record(value, context)
  rejectUnknownKeys(source, ['visibleFront', 'hiddenClosure'], context)
  const visibleFront = followerMorphInventory(source.visibleFront, `${context}.visibleFront`)
  const hiddenClosure = followerMorphInventory(source.hiddenClosure, `${context}.hiddenClosure`)
  if (
    visibleFront.length !== hiddenClosure.length ||
    visibleFront.some((entry, index) => entry !== hiddenClosure[index])
  ) {
    fail(`${context} must declare the same exact inventory for both cap primitives`)
  }
  const required = socketEyeCapRetainedDynamicMorphs(side)
  for (const key of required) {
    if (!visibleFront.includes(key)) {
      fail(`${context} must include ${key} on both cap primitives`)
    }
  }
  return { visibleFront, hiddenClosure }
}

function compositeLayers(value: unknown): typeof SOCKET_EYE_COMPOSITE_LAYER_ORDER {
  if (!Array.isArray(value) || value.length !== SOCKET_EYE_COMPOSITE_LAYER_ORDER.length) {
    fail('definition.compositeLayers must declare the complete ordered layer stack')
  }
  for (const [index, expected] of SOCKET_EYE_COMPOSITE_LAYER_ORDER.entries()) {
    if (value[index] !== expected) {
      fail(`definition.compositeLayers[${index}] must be ${expected}`)
    }
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

function validateAxes(side: SocketEyeSurfaceSideDefinition, context: string) {
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
    normalized(
      cross(side.horizontalAxisHeadLocal, side.verticalAxisHeadLocal),
      `${context} axes`
    ),
    side.forwardAxisHeadLocal
  )
  if (handedness < 1 - AXIS_TOLERANCE) fail(`${context} axes must form a right-handed frame`)
}

function parseSide(
  value: unknown,
  expectedSide: SocketEyeSide,
  context: string
): SocketEyeSurfaceSideDefinition {
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
      'cap',
      'gaze'
    ],
    context
  )
  if (source.side !== expectedSide) fail(`${context}.side must be ${expectedSide}`)

  const nodes = record(source.nodes, `${context}.nodes`)
  rejectUnknownKeys(nodes, ['compositeCap'], `${context}.nodes`)

  const cap = record(source.cap, `${context}.cap`)
  rejectUnknownKeys(
    cap,
    [
      'frontGeometryLaw',
      'frontDepthRatio',
      'maximumFrontDepthMeters',
      'artworkProjection',
      'carrierHalfWidthMeters',
      'carrierHalfHeightMeters',
      'carrierDepthRadiusMeters',
      'rearClosureDepthMeters',
      'minimumHiddenUnderlapMeters',
      'visibleFrontFaceGroup',
      'hiddenClosureFaceGroup',
      'primitiveFollowerMorphs',
      'apertureFollowing',
      'closedManifold'
    ],
    `${context}.cap`
  )

  const gaze = record(source.gaze, `${context}.gaze`)
  rejectUnknownKeys(
    gaze,
    ['maximumHorizontal', 'maximumVertical', 'headFollowStart'],
    `${context}.gaze`
  )

  const parsed: SocketEyeSurfaceSideDefinition = {
    side: expectedSide,
    nodes: {
      compositeCap: stringValue(nodes.compositeCap, `${context}.nodes.compositeCap`)
    },
    apertureSeamDefinitionSha256: stringValue(
      source.apertureSeamDefinitionSha256,
      `${context}.apertureSeamDefinitionSha256`
    ),
    gazeAnchorHeadLocal: vec3(source.gazeAnchorHeadLocal, `${context}.gazeAnchorHeadLocal`),
    surfaceCenterHeadLocal: vec3(
      source.surfaceCenterHeadLocal,
      `${context}.surfaceCenterHeadLocal`
    ),
    horizontalAxisHeadLocal: vec3(
      source.horizontalAxisHeadLocal,
      `${context}.horizontalAxisHeadLocal`
    ),
    verticalAxisHeadLocal: vec3(
      source.verticalAxisHeadLocal,
      `${context}.verticalAxisHeadLocal`
    ),
    forwardAxisHeadLocal: vec3(
      source.forwardAxisHeadLocal,
      `${context}.forwardAxisHeadLocal`
    ),
    cap: {
      frontGeometryLaw: literal(
        cap.frontGeometryLaw,
        'aperture-normalized-shallow-patch/v1',
        `${context}.cap.frontGeometryLaw`
      ),
      frontDepthRatio: positive(cap.frontDepthRatio, `${context}.cap.frontDepthRatio`),
      maximumFrontDepthMeters: positive(
        cap.maximumFrontDepthMeters,
        `${context}.cap.maximumFrontDepthMeters`
      ),
      artworkProjection: literal(
        cap.artworkProjection,
        'deformed-surface-meters/v1',
        `${context}.cap.artworkProjection`
      ),
      carrierHalfWidthMeters: positive(
        cap.carrierHalfWidthMeters,
        `${context}.cap.carrierHalfWidthMeters`
      ),
      carrierHalfHeightMeters: positive(
        cap.carrierHalfHeightMeters,
        `${context}.cap.carrierHalfHeightMeters`
      ),
      carrierDepthRadiusMeters: positive(
        cap.carrierDepthRadiusMeters,
        `${context}.cap.carrierDepthRadiusMeters`
      ),
      rearClosureDepthMeters: positive(
        cap.rearClosureDepthMeters,
        `${context}.cap.rearClosureDepthMeters`
      ),
      minimumHiddenUnderlapMeters: positive(
        cap.minimumHiddenUnderlapMeters,
        `${context}.cap.minimumHiddenUnderlapMeters`
      ),
      visibleFrontFaceGroup: stringValue(
        cap.visibleFrontFaceGroup,
        `${context}.cap.visibleFrontFaceGroup`
      ),
      hiddenClosureFaceGroup: stringValue(
        cap.hiddenClosureFaceGroup,
        `${context}.cap.hiddenClosureFaceGroup`
      ),
      primitiveFollowerMorphs: primitiveFollowerMorphs(
        cap.primitiveFollowerMorphs,
        expectedSide,
        `${context}.cap.primitiveFollowerMorphs`
      ),
      apertureFollowing: literal(
        cap.apertureFollowing,
        true,
        `${context}.cap.apertureFollowing`
      ),
      closedManifold: literal(cap.closedManifold, true, `${context}.cap.closedManifold`)
    },
    gaze: {
      maximumHorizontal: unitInterval(
        gaze.maximumHorizontal,
        `${context}.gaze.maximumHorizontal`
      ),
      maximumVertical: unitInterval(gaze.maximumVertical, `${context}.gaze.maximumVertical`),
      headFollowStart: unitInterval(gaze.headFollowStart, `${context}.gaze.headFollowStart`)
    }
  }
  if (!HASH_PATTERN.test(parsed.apertureSeamDefinitionSha256)) {
    fail(`${context}.apertureSeamDefinitionSha256 must be lowercase SHA-256`)
  }
  if (parsed.cap.visibleFrontFaceGroup === parsed.cap.hiddenClosureFaceGroup) {
    fail(`${context} visible front and hidden closure face groups must differ`)
  }
  validateAxes(parsed, context)
  const anchorFromCenter = subtract(parsed.gazeAnchorHeadLocal, parsed.surfaceCenterHeadLocal)
  const anchorDepthFromCenter = dot(anchorFromCenter, parsed.forwardAxisHeadLocal)
  if (anchorDepthFromCenter > EPSILON) {
    fail(`${context} gaze anchor must stay on or behind the carrier perimeter plane`)
  }
  const anchorHorizontalFromCenter = dot(anchorFromCenter, parsed.horizontalAxisHeadLocal)
  const anchorVerticalFromCenter = dot(anchorFromCenter, parsed.verticalAxisHeadLocal)
  if (
    Math.abs(anchorHorizontalFromCenter) > EPSILON ||
    Math.abs(anchorVerticalFromCenter) > EPSILON
  ) {
    fail(`${context} gaze anchor must stay centered behind the virtual carrier`)
  }
  return parsed
}

export function parseSocketEyeSurfaceDefinition(value: unknown): SocketEyeSurfaceDefinitionV1 {
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
  const definitionSha256 = stringValue(source.definitionSha256, 'definition.definitionSha256')
  if (!HASH_PATTERN.test(definitionSha256)) {
    fail('definition.definitionSha256 must be lowercase SHA-256')
  }
  if (source.coordinateSpace !== 'head-local') {
    fail('definition.coordinateSpace must be head-local')
  }
  if (source.surfaceKind !== 'aperture-following-composite-cap') {
    fail('definition.surfaceKind must be aperture-following-composite-cap')
  }

  const rendering = record(source.rendering, 'definition.rendering')
  rejectUnknownKeys(
    rendering,
    [
      'meshOwnsApertureMask',
      'visibleFrontDepthTest',
      'visibleFrontDepthWrite',
      'visibleFrontSide',
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
    [
      'gazeLinked',
      'transparentRgba',
      'minimumOverscanHorizontal',
      'minimumOverscanVertical'
    ],
    'definition.artwork.scleraOverlay'
  )

  const runtimeBindings = record(source.runtimeBindings, 'definition.runtimeBindings')
  rejectUnknownKeys(runtimeBindings, ['left', 'right'], 'definition.runtimeBindings')
  const left = parseSide(runtimeBindings.left, 'left', 'definition.runtimeBindings.left')
  const right = parseSide(runtimeBindings.right, 'right', 'definition.runtimeBindings.right')

  const overlay = {
    gazeLinked: literal(
      scleraOverlay.gazeLinked,
      true,
      'definition.artwork.scleraOverlay.gazeLinked'
    ),
    transparentRgba: literal(
      scleraOverlay.transparentRgba,
      true,
      'definition.artwork.scleraOverlay.transparentRgba'
    ),
    minimumOverscanHorizontal: unitInterval(
      scleraOverlay.minimumOverscanHorizontal,
      'definition.artwork.scleraOverlay.minimumOverscanHorizontal'
    ),
    minimumOverscanVertical: unitInterval(
      scleraOverlay.minimumOverscanVertical,
      'definition.artwork.scleraOverlay.minimumOverscanVertical'
    )
  }
  const maximumHorizontal = Math.max(left.gaze.maximumHorizontal, right.gaze.maximumHorizontal)
  const maximumVertical = Math.max(left.gaze.maximumVertical, right.gaze.maximumVertical)
  if (overlay.minimumOverscanHorizontal <= maximumHorizontal) {
    fail('sclera artwork horizontal overscan must exceed every safe gaze endpoint')
  }
  if (overlay.minimumOverscanVertical <= maximumVertical) {
    fail('sclera artwork vertical overscan must exceed every safe gaze endpoint')
  }

  if (left.nodes.compositeCap === right.nodes.compositeCap) {
    fail('left/right composite-cap nodes must be unique')
  }

  return {
    schemaVersion: SOCKET_EYE_SURFACE_SCHEMA_VERSION,
    definitionSha256,
    status: literal(source.status, 'product-export-approved', 'definition.status'),
    productExportApproved: literal(
      source.productExportApproved,
      true,
      'definition.productExportApproved'
    ),
    coordinateSpace: 'head-local',
    surfaceKind: 'aperture-following-composite-cap',
    compositeLayers: compositeLayers(source.compositeLayers),
    rendering: {
      meshOwnsApertureMask: literal(
        rendering.meshOwnsApertureMask,
        true,
        'definition.rendering.meshOwnsApertureMask'
      ),
      visibleFrontDepthTest: literal(
        rendering.visibleFrontDepthTest,
        true,
        'definition.rendering.visibleFrontDepthTest'
      ),
      visibleFrontDepthWrite: literal(
        rendering.visibleFrontDepthWrite,
        true,
        'definition.rendering.visibleFrontDepthWrite'
      ),
      visibleFrontSide: literal(
        rendering.visibleFrontSide,
        'front',
        'definition.rendering.visibleFrontSide'
      ),
      renderOrder: literal(
        rendering.renderOrder,
        'after-face-before-liner',
        'definition.rendering.renderOrder'
      ),
      requiredMaxTextureArrayLayers: positiveInteger(
        rendering.requiredMaxTextureArrayLayers,
        'definition.rendering.requiredMaxTextureArrayLayers'
      )
    },
    artwork: { scleraOverlay: overlay },
    runtimeBindings: { left, right }
  }
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function surfacePoint(
  side: SocketEyeSurfaceSideDefinition,
  horizontal: number,
  vertical: number
): SocketEyeVec3 {
  const radialSquared = horizontal * horizontal + vertical * vertical
  if (radialSquared > 1 + EPSILON) fail('resolved eye coordinate left the carrier domain')
  const depth =
    side.cap.carrierDepthRadiusMeters * Math.sqrt(Math.max(0, 1 - radialSquared))
  return add(
    add(
      add(
        side.surfaceCenterHeadLocal,
        scale(side.horizontalAxisHeadLocal, horizontal * side.cap.carrierHalfWidthMeters)
      ),
      scale(side.verticalAxisHeadLocal, vertical * side.cap.carrierHalfHeightMeters)
    ),
    scale(side.forwardAxisHeadLocal, depth)
  )
}

export function projectTargetToSocketEyeSurface(
  side: SocketEyeSurfaceSideDefinition,
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
  if (dz <= EPSILON) fail('targetHeadLocal must be in front of the eye surface')

  const anchorFromCenter = subtract(side.gazeAnchorHeadLocal, side.surfaceCenterHeadLocal)
  const ax = dot(anchorFromCenter, side.horizontalAxisHeadLocal)
  const ay = dot(anchorFromCenter, side.verticalAxisHeadLocal)
  const az = dot(anchorFromCenter, side.forwardAxisHeadLocal)
  const width = side.cap.carrierHalfWidthMeters
  const height = side.cap.carrierHalfHeightMeters
  const depth = side.cap.carrierDepthRadiusMeters
  const quadratic =
    (dx * dx) / (width * width) +
    (dy * dy) / (height * height) +
    (dz * dz) / (depth * depth)
  const linear =
    2 *
    ((ax * dx) / (width * width) +
      (ay * dy) / (height * height) +
      (az * dz) / (depth * depth))
  const constant =
    (ax * ax) / (width * width) +
    (ay * ay) / (height * height) +
    (az * az) / (depth * depth) -
    1
  const discriminant = linear * linear - 4 * quadratic * constant
  if (discriminant < 0) fail('target ray does not intersect the eye carrier')
  const root = Math.sqrt(discriminant)
  const candidates = [
    (-linear - root) / (2 * quadratic),
    (-linear + root) / (2 * quadratic)
  ].filter((candidate) => candidate > EPSILON && az + candidate * dz >= -EPSILON)
  if (candidates.length === 0) fail('target ray intersects only outside the front eye carrier')
  const distanceAlongRay = Math.min(...candidates)
  if (!Number.isFinite(distanceAlongRay) || distanceAlongRay <= EPSILON) {
    fail('target ray produced an invalid eye-carrier intersection')
  }

  const requestedHorizontal = (ax + distanceAlongRay * dx) / width
  const requestedVertical = (ay + distanceAlongRay * dy) / height
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

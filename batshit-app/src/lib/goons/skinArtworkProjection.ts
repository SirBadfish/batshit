import * as THREE from 'three'
import { canonicalRecipeSha256, sha256Hex } from './recipe/recipeCanonical'

export const SKIN_ARTWORK_PROJECTION_SCHEMA_VERSION =
  'skin-artwork-projection/v8' as const

export type SkinArtworkSurfacePointV1 = {
  triangle: number
  barycentric: [number, number, number]
}

export type SkinArtworkProjectionCircleV8 = {
  side: 'left' | 'right'
  sourceArtworkCenterUv: [number, number]
  surfaceCenterUv: [number, number]
  deformationCenterUv: [number, number]
  sourceOuterRadiusUv: number
  deformationFrameRadiusUv: number
  supportRadiusUv: number
  neutralOuterRadiusMeters: number
  neutralSizeFrameMeters: [number, number]
  neutralCenterFrameRatios: [number, number, number]
  anchors: {
    ownershipSeed: SkinArtworkSurfacePointV1
    outerBoundary: SkinArtworkSurfacePointV1[]
    deformationFrame: {
      uMinus: SkinArtworkSurfacePointV1
      uPlus: SkinArtworkSurfacePointV1
      vMinus: SkinArtworkSurfacePointV1
      vPlus: SkinArtworkSurfacePointV1
    }
  }
}

export type SkinArtworkProjectionDefinitionV8 = {
  schemaVersion: typeof SKIN_ARTWORK_PROJECTION_SCHEMA_VERSION
  status: string
  productExportApproved: true
  definitionSha256: string
  metric: 'nipple-base-ring-single-surface-circle/v3'
  projectionOrigin: 'selected-outer-boundary-stable-frame/v1'
  pigmentExtraction: 'isolated-skin-appearance-region-layer/v1'
  surfaceOwnership: 'center-connected-projection-island/v1'
  radiusResponse: {
    driver: 'appearance-dial/nipple_size-positive/v1'
    positiveMaximumMultiplier: number
    maximumOuterRadiusMeters: number
    bakedDriverValue: number | null
  }
  runtimeBinding: {
    node: string
    material: string
    vertexCount: number
    indexCount: number
    indexSha256: string
    uvSha256: string
    surfaceOffsetMeters: number
    overlayTextureSize: number
    overlayTextureRadiusUv: number
  }
  circles: [SkinArtworkProjectionCircleV8, SkinArtworkProjectionCircleV8]
}

type NumericBufferAttribute = THREE.BufferAttribute & { array: ArrayBufferView }
type RuntimeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
type RuntimeSkinnedMesh = THREE.SkinnedMesh<
  THREE.BufferGeometry,
  THREE.MeshStandardMaterial
>
type PreparedOverlay = {
  material: THREE.MeshStandardMaterial
  texture: THREE.CanvasTexture
}
export type SkinArtworkPreparedProjection = {
  overlays: [PreparedOverlay, PreparedOverlay]
}
type RuntimeCircle = {
  definition: SkinArtworkProjectionCircleV8
  mesh: RuntimeMesh | RuntimeSkinnedMesh
  geometry: THREE.BufferGeometry
  sourceVertices: Uint32Array
  sourceTriangles: Uint32Array
  triangleNeighbors: number[][]
  centerLocalTriangle: number
  position: THREE.BufferAttribute
  normal: THREE.BufferAttribute
  uv1: THREE.BufferAttribute
  diagnostics: SkinArtworkProjectionDiagnostics
  ownedMaterial: THREE.MeshStandardMaterial
  ownedTexture: THREE.Texture | null
}

export type SkinArtworkProjectionDiagnostics = {
  side: 'left' | 'right'
  candidateComponentCount: number
  visibleComponentCount: 1
  ownedTriangleCount: number
  rejectedTriangleCount: number
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const ZERO_SHA256 = '0'.repeat(64)
const EPSILON = 1e-6
const UV_EPSILON = 5e-5

function fail(message: string): never {
  throw new Error(`[skin-artwork-projection/v8] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string
) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${context} must contain exactly: ${wanted.join(', ')}`)
  }
}

function text(value: unknown, context: string) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function sha256(value: unknown, context: string) {
  const parsed = text(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function finite(value: unknown, context: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be finite`)
  }
  return value
}

function positive(value: unknown, context: string, maximum: number) {
  const parsed = finite(value, context)
  if (parsed <= 0 || parsed > maximum) {
    fail(`${context} must be inside (0, ${maximum}]`)
  }
  return parsed
}

function nonNegative(value: unknown, context: string, maximum: number) {
  const parsed = finite(value, context)
  if (parsed < 0 || parsed > maximum) {
    fail(`${context} must be inside [0, ${maximum}]`)
  }
  return parsed
}

function nullableUnit(value: unknown, context: string): number | null {
  if (value === null) return null
  const parsed = finite(value, context)
  if (parsed < -1 || parsed > 1) {
    fail(`${context} must be null or inside [-1, 1]`)
  }
  return parsed
}

function safeInteger(value: unknown, context: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${context} must be a safe integer >= ${minimum}`)
  }
  return value as number
}

function uv(value: unknown, context: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(`${context} must contain two UV coordinates`)
  }
  const parsed = value.map((entry, index) => finite(entry, `${context}[${index}]`)) as [
    number,
    number
  ]
  if (parsed.some((entry) => entry < 0 || entry > 1)) {
    fail(`${context} must stay inside [0, 1]`)
  }
  return parsed
}

function positivePair(value: unknown, context: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(`${context} must contain two distances`)
  }
  return value.map((entry, index) => positive(entry, `${context}[${index}]`, 0.2)) as [
    number,
    number
  ]
}

function finiteTriple(value: unknown, context: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    fail(`${context} must contain three coordinates`)
  }
  const parsed = value.map((entry, index) =>
    finite(entry, `${context}[${index}]`)
  ) as [number, number, number]
  if (parsed.some((entry) => Math.abs(entry) > 2)) {
    fail(`${context} must stay inside [-2, 2]`)
  }
  return parsed
}

function surfacePoint(value: unknown, context: string): SkinArtworkSurfacePointV1 {
  const source = record(value, context)
  exactKeys(source, ['triangle', 'barycentric'], context)
  if (!Array.isArray(source.barycentric) || source.barycentric.length !== 3) {
    fail(`${context}.barycentric must contain three weights`)
  }
  const barycentric = source.barycentric.map((entry, index) =>
    finite(entry, `${context}.barycentric[${index}]`)
  ) as [number, number, number]
  if (barycentric.some((entry) => entry < -EPSILON || entry > 1 + EPSILON)) {
    fail(`${context}.barycentric must stay inside the triangle`)
  }
  if (Math.abs(barycentric.reduce((sum, entry) => sum + entry, 0) - 1) > EPSILON) {
    fail(`${context}.barycentric must sum to one`)
  }
  return {
    triangle: safeInteger(source.triangle, `${context}.triangle`),
    barycentric
  }
}

function circle(
  value: unknown,
  expectedSide: 'left' | 'right',
  context: string
): SkinArtworkProjectionCircleV8 {
  const source = record(value, context)
  exactKeys(
    source,
    [
      'side',
      'sourceArtworkCenterUv',
      'surfaceCenterUv',
      'deformationCenterUv',
      'sourceOuterRadiusUv',
      'deformationFrameRadiusUv',
      'supportRadiusUv',
      'neutralOuterRadiusMeters',
      'neutralSizeFrameMeters',
      'neutralCenterFrameRatios',
      'anchors'
    ],
    context
  )
  if (source.side !== expectedSide) fail(`${context}.side must be ${expectedSide}`)
  const sourceOuterRadiusUv = positive(
    source.sourceOuterRadiusUv,
    `${context}.sourceOuterRadiusUv`,
    0.05
  )
  const supportRadiusUv = positive(
    source.supportRadiusUv,
    `${context}.supportRadiusUv`,
    0.2
  )
  const deformationFrameRadiusUv = positive(
    source.deformationFrameRadiusUv,
    `${context}.deformationFrameRadiusUv`,
    0.05
  )
  if (
    sourceOuterRadiusUv >= supportRadiusUv ||
    deformationFrameRadiusUv >= supportRadiusUv
  ) {
    fail(`${context} declares an invalid artwork/anatomy radius order`)
  }
  const anchorsSource = record(source.anchors, `${context}.anchors`)
  exactKeys(
    anchorsSource,
    ['ownershipSeed', 'outerBoundary', 'deformationFrame'],
    `${context}.anchors`
  )
  if (
    !Array.isArray(anchorsSource.outerBoundary) ||
    anchorsSource.outerBoundary.length < 8 ||
    anchorsSource.outerBoundary.length > 64
  ) {
    fail(`${context}.anchors.outerBoundary must contain 8 to 64 surface points`)
  }
  const deformationFrameSource = record(
    anchorsSource.deformationFrame,
    `${context}.anchors.deformationFrame`
  )
  exactKeys(
    deformationFrameSource,
    ['uMinus', 'uPlus', 'vMinus', 'vPlus'],
    `${context}.anchors.deformationFrame`
  )
  return {
    side: expectedSide,
    sourceArtworkCenterUv: uv(
      source.sourceArtworkCenterUv,
      `${context}.sourceArtworkCenterUv`
    ),
    surfaceCenterUv: uv(source.surfaceCenterUv, `${context}.surfaceCenterUv`),
    deformationCenterUv: uv(
      source.deformationCenterUv,
      `${context}.deformationCenterUv`
    ),
    sourceOuterRadiusUv,
    deformationFrameRadiusUv,
    supportRadiusUv,
    neutralOuterRadiusMeters: positive(
      source.neutralOuterRadiusMeters,
      `${context}.neutralOuterRadiusMeters`,
      0.05
    ),
    neutralSizeFrameMeters: positivePair(
      source.neutralSizeFrameMeters,
      `${context}.neutralSizeFrameMeters`
    ),
    neutralCenterFrameRatios: finiteTriple(
      source.neutralCenterFrameRatios,
      `${context}.neutralCenterFrameRatios`
    ),
    anchors: {
      ownershipSeed: surfacePoint(
        anchorsSource.ownershipSeed,
        `${context}.anchors.ownershipSeed`
      ),
      outerBoundary: anchorsSource.outerBoundary.map((entry, index) =>
        surfacePoint(entry, `${context}.anchors.outerBoundary[${index}]`)
      ),
      deformationFrame: {
        uMinus: surfacePoint(
          deformationFrameSource.uMinus,
          `${context}.anchors.deformationFrame.uMinus`
        ),
        uPlus: surfacePoint(
          deformationFrameSource.uPlus,
          `${context}.anchors.deformationFrame.uPlus`
        ),
        vMinus: surfacePoint(
          deformationFrameSource.vMinus,
          `${context}.anchors.deformationFrame.vMinus`
        ),
        vPlus: surfacePoint(
          deformationFrameSource.vPlus,
          `${context}.anchors.deformationFrame.vPlus`
        )
      }
    }
  }
}

export function parseSkinArtworkProjectionDefinition(
  value: unknown
): SkinArtworkProjectionDefinitionV8 {
  const source = record(value, 'definition')
  exactKeys(
    source,
    [
      'schemaVersion',
      'status',
      'productExportApproved',
      'definitionSha256',
      'metric',
      'projectionOrigin',
      'pigmentExtraction',
      'surfaceOwnership',
      'radiusResponse',
      'runtimeBinding',
      'circles'
    ],
    'definition'
  )
  if (source.schemaVersion !== SKIN_ARTWORK_PROJECTION_SCHEMA_VERSION) {
    fail('definition.schemaVersion is unsupported')
  }
  if (source.productExportApproved !== true) {
    fail('definition.productExportApproved must be true')
  }
  if (source.metric !== 'nipple-base-ring-single-surface-circle/v3') {
    fail('definition.metric must be nipple-base-ring-single-surface-circle/v3')
  }
  if (source.projectionOrigin !== 'selected-outer-boundary-stable-frame/v1') {
    fail(
      'definition.projectionOrigin must be selected-outer-boundary-stable-frame/v1'
    )
  }
  if (
    source.pigmentExtraction !== 'isolated-skin-appearance-region-layer/v1'
  ) {
    fail(
      'definition.pigmentExtraction must be isolated-skin-appearance-region-layer/v1'
    )
  }
  if (source.surfaceOwnership !== 'center-connected-projection-island/v1') {
    fail('definition.surfaceOwnership must be center-connected-projection-island/v1')
  }
  const radiusResponse = record(
    source.radiusResponse,
    'definition.radiusResponse'
  )
  exactKeys(
    radiusResponse,
    [
      'driver',
      'positiveMaximumMultiplier',
      'maximumOuterRadiusMeters',
      'bakedDriverValue'
    ],
    'definition.radiusResponse'
  )
  if (radiusResponse.driver !== 'appearance-dial/nipple_size-positive/v1') {
    fail(
      'definition.radiusResponse.driver must be appearance-dial/nipple_size-positive/v1'
    )
  }
  const positiveMaximumMultiplier = finite(
    radiusResponse.positiveMaximumMultiplier,
    'definition.radiusResponse.positiveMaximumMultiplier'
  )
  if (positiveMaximumMultiplier <= 1 || positiveMaximumMultiplier > 4) {
    fail(
      'definition.radiusResponse.positiveMaximumMultiplier must be inside (1, 4]'
    )
  }
  const binding = record(source.runtimeBinding, 'definition.runtimeBinding')
  exactKeys(
    binding,
    [
      'node',
      'material',
      'vertexCount',
      'indexCount',
      'indexSha256',
      'uvSha256',
      'surfaceOffsetMeters',
      'overlayTextureSize',
      'overlayTextureRadiusUv'
    ],
    'definition.runtimeBinding'
  )
  const overlayTextureSize = safeInteger(
    binding.overlayTextureSize,
    'definition.runtimeBinding.overlayTextureSize',
    32
  )
  if (
    overlayTextureSize > 512 ||
    (overlayTextureSize & (overlayTextureSize - 1)) !== 0
  ) {
    fail('definition.runtimeBinding.overlayTextureSize must be a power of two <= 512')
  }
  const overlayTextureRadiusUv = positive(
    binding.overlayTextureRadiusUv,
    'definition.runtimeBinding.overlayTextureRadiusUv',
    0.49
  )
  if (!Array.isArray(source.circles) || source.circles.length !== 2) {
    fail('definition.circles must contain left and right')
  }
  const circles: [SkinArtworkProjectionCircleV8, SkinArtworkProjectionCircleV8] = [
    circle(source.circles[0], 'left', 'definition.circles[0]'),
    circle(source.circles[1], 'right', 'definition.circles[1]')
  ]
  const bilateralFields = [
    'sourceOuterRadiusUv',
    'deformationFrameRadiusUv',
    'supportRadiusUv',
    'neutralOuterRadiusMeters'
  ] as const
  if (
    bilateralFields.some((key) => Math.abs(circles[0][key] - circles[1][key]) > EPSILON)
  ) {
    fail('definition.circles must use one bilateral artwork law')
  }
  return {
    schemaVersion: SKIN_ARTWORK_PROJECTION_SCHEMA_VERSION,
    status: text(source.status, 'definition.status'),
    productExportApproved: true,
    definitionSha256: sha256(source.definitionSha256, 'definition.definitionSha256'),
    metric: 'nipple-base-ring-single-surface-circle/v3',
    projectionOrigin: 'selected-outer-boundary-stable-frame/v1',
    pigmentExtraction: 'isolated-skin-appearance-region-layer/v1',
    surfaceOwnership: 'center-connected-projection-island/v1',
    radiusResponse: {
      driver: 'appearance-dial/nipple_size-positive/v1',
      positiveMaximumMultiplier,
      maximumOuterRadiusMeters: positive(
        radiusResponse.maximumOuterRadiusMeters,
        'definition.radiusResponse.maximumOuterRadiusMeters',
        0.1
      ),
      bakedDriverValue: nullableUnit(
        radiusResponse.bakedDriverValue,
        'definition.radiusResponse.bakedDriverValue'
      )
    },
    runtimeBinding: {
      node: text(binding.node, 'definition.runtimeBinding.node'),
      material: text(binding.material, 'definition.runtimeBinding.material'),
      vertexCount: safeInteger(
        binding.vertexCount,
        'definition.runtimeBinding.vertexCount',
        3
      ),
      indexCount: safeInteger(
        binding.indexCount,
        'definition.runtimeBinding.indexCount',
        3
      ),
      indexSha256: sha256(binding.indexSha256, 'definition.runtimeBinding.indexSha256'),
      uvSha256: sha256(binding.uvSha256, 'definition.runtimeBinding.uvSha256'),
      surfaceOffsetMeters: nonNegative(
        binding.surfaceOffsetMeters,
        'definition.runtimeBinding.surfaceOffsetMeters',
        0.002
      ),
      overlayTextureSize,
      overlayTextureRadiusUv
    },
    circles
  }
}

export async function verifySkinArtworkProjectionDefinition(
  value: unknown
): Promise<SkinArtworkProjectionDefinitionV8> {
  const definition = parseSkinArtworkProjectionDefinition(value)
  const expected = await canonicalRecipeSha256({
    ...definition,
    definitionSha256: ZERO_SHA256
  })
  if (definition.definitionSha256 !== expected) {
    fail('definition.definitionSha256 does not match canonical content')
  }
  return definition
}

export async function bakeSkinArtworkProjectionDefinition(
  value: unknown,
  nippleSizeValue: number
): Promise<SkinArtworkProjectionDefinitionV8> {
  const definition = await verifySkinArtworkProjectionDefinition(value)
  const bakedDriverValue = nullableUnit(
    nippleSizeValue,
    'baked nipple_size value'
  )
  if (bakedDriverValue === null) {
    fail('baked nipple_size value must be present')
  }
  const baked: SkinArtworkProjectionDefinitionV8 = {
    ...definition,
    definitionSha256: ZERO_SHA256,
    radiusResponse: {
      ...definition.radiusResponse,
      bakedDriverValue
    }
  }
  baked.definitionSha256 = await canonicalRecipeSha256(baked)
  return baked
}

function exactMesh(root: THREE.Object3D, name: string): RuntimeMesh {
  const matches: RuntimeMesh[] = []
  root.traverse((node) => {
    const mesh = node as RuntimeMesh
    if (node.name === name && mesh.isMesh && !Array.isArray(mesh.material)) {
      matches.push(mesh)
    }
  })
  if (matches.length !== 1) {
    fail(`expected exactly one mesh named ${name}, found ${matches.length}`)
  }
  return matches[0]
}

function numericAttribute(
  value: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined,
  itemSize: number,
  context: string
): NumericBufferAttribute {
  if (
    !value ||
    (value as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true ||
    value.itemSize !== itemSize
  ) {
    fail(`${context} must be a non-interleaved itemSize ${itemSize} attribute`)
  }
  return value as NumericBufferAttribute
}

function bytes(value: ArrayBufferView) {
  return Uint8Array.from(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  )
}

function barycentricPoint(
  point: SkinArtworkSurfacePointV1,
  index: NumericBufferAttribute,
  attribute: NumericBufferAttribute,
  target: THREE.Vector3
) {
  const base = point.triangle * 3
  if (base + 2 >= index.count) fail(`triangle ${point.triangle} is out of range`)
  target.set(0, 0, 0)
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = index.getX(base + corner)
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= attribute.count) {
      fail(`triangle ${point.triangle} contains an invalid vertex index`)
    }
    target.x += attribute.getX(vertex) * point.barycentric[corner]
    target.y += attribute.getY(vertex) * point.barycentric[corner]
    target.z += attribute.getZ(vertex) * point.barycentric[corner]
  }
  return target
}

function barycentricUv(
  point: SkinArtworkSurfacePointV1,
  index: NumericBufferAttribute,
  attribute: NumericBufferAttribute
): [number, number] {
  const base = point.triangle * 3
  if (base + 2 >= index.count) fail(`triangle ${point.triangle} is out of range`)
  let u = 0
  let v = 0
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = index.getX(base + corner)
    u += attribute.getX(vertex) * point.barycentric[corner]
    v += attribute.getY(vertex) * point.barycentric[corner]
  }
  return [u, v]
}

function assertUvClose(
  actual: [number, number],
  expected: [number, number],
  context: string
) {
  if (
    Math.abs(actual[0] - expected[0]) > UV_EPSILON ||
    Math.abs(actual[1] - expected[1]) > UV_EPSILON
  ) {
    fail(`${context} does not resolve to its declared surface UV`)
  }
}

function distanceToSegmentSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
) {
  const dx = bx - ax
  const dy = by - ay
  const denominator = dx * dx + dy * dy
  const t =
    denominator <= EPSILON
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator))
  const x = ax + dx * t - px
  const y = ay + dy * t - py
  return x * x + y * y
}

function pointInsideTriangle(px: number, py: number, points: Array<[number, number]>) {
  const signs = points.map(([ax, ay], index) => {
    const [bx, by] = points[(index + 1) % 3]
    return (px - bx) * (ay - by) - (ax - bx) * (py - by)
  })
  return (
    signs.every((value) => value >= -EPSILON) ||
    signs.every((value) => value <= EPSILON)
  )
}

function triangleTouchesCircle(
  points: Array<[number, number]>,
  center: [number, number],
  radius: number
) {
  if (pointInsideTriangle(center[0], center[1], points)) return true
  const radiusSquared = radius * radius
  return points.some(([u, v], index) => {
    if ((u - center[0]) ** 2 + (v - center[1]) ** 2 <= radiusSquared) return true
    const [nextU, nextV] = points[(index + 1) % 3]
    return (
      distanceToSegmentSquared(center[0], center[1], u, v, nextU, nextV) <=
      radiusSquared
    )
  })
}

function triangleNeighbors(sourceVertices: Uint32Array) {
  const triangleCount = sourceVertices.length / 3
  const neighbors = Array.from({ length: triangleCount }, () => new Set<number>())
  const edgeOwners = new Map<string, number[]>()
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const vertices = [0, 1, 2].map((corner) => sourceVertices[triangle * 3 + corner]!)
    for (let edge = 0; edge < 3; edge += 1) {
      const a = vertices[edge]!
      const b = vertices[(edge + 1) % 3]!
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const owners = edgeOwners.get(key)
      if (owners) owners.push(triangle)
      else edgeOwners.set(key, [triangle])
    }
  }
  for (const owners of edgeOwners.values()) {
    for (const owner of owners) {
      for (const neighbor of owners) {
        if (owner !== neighbor) neighbors[owner]!.add(neighbor)
      }
    }
  }
  return neighbors.map((entries) => [...entries].sort((a, b) => a - b))
}

function applyCenterConnectedProjectionOwnership(
  circle: RuntimeCircle,
  textureRadius: number
): SkinArtworkProjectionDiagnostics {
  const triangleCount = circle.sourceTriangles.length
  const candidate = new Uint8Array(triangleCount)
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const points = [0, 1, 2].map((corner) => {
      const vertex = triangle * 3 + corner
      return [circle.uv1.getX(vertex), circle.uv1.getY(vertex)] as [number, number]
    })
    if (triangleTouchesCircle(points, [0.5, 0.5], textureRadius)) {
      candidate[triangle] = 1
    }
  }
  if (!candidate[circle.centerLocalTriangle]) {
    fail(`${circle.definition.side} nipple-center triangle left the projection circle`)
  }

  const visited = new Uint8Array(triangleCount)
  let candidateComponentCount = 0
  const walk = (seed: number, output: Uint8Array) => {
    const queue = [seed]
    output[seed] = 1
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const triangle = queue[cursor]!
      for (const neighbor of circle.triangleNeighbors[triangle]!) {
        if (!candidate[neighbor] || output[neighbor]) continue
        output[neighbor] = 1
        queue.push(neighbor)
      }
    }
  }
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (!candidate[triangle] || visited[triangle]) continue
    candidateComponentCount += 1
    walk(triangle, visited)
  }

  const owned = new Uint8Array(triangleCount)
  walk(circle.centerLocalTriangle, owned)
  let ownedTriangleCount = 0
  let rejectedTriangleCount = 0
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (owned[triangle]) {
      ownedTriangleCount += 1
      continue
    }
    if (!candidate[triangle]) continue
    rejectedTriangleCount += 1
    for (let corner = 0; corner < 3; corner += 1) {
      circle.uv1.setXY(triangle * 3 + corner, 0, 0)
    }
  }
  if (ownedTriangleCount === 0) {
    fail(`${circle.definition.side} projection has no nipple-owned surface triangles`)
  }
  return {
    side: circle.definition.side,
    candidateComponentCount,
    visibleComponentCount: 1,
    ownedTriangleCount,
    rejectedTriangleCount
  }
}

function copyAttributeValues(
  source: NumericBufferAttribute,
  sourceVertices: Uint32Array
) {
  const values = new Float32Array(sourceVertices.length * source.itemSize)
  for (let local = 0; local < sourceVertices.length; local += 1) {
    const vertex = sourceVertices[local]
    for (let component = 0; component < source.itemSize; component += 1) {
      values[local * source.itemSize + component] = source.getComponent(
        vertex,
        component
      )
    }
  }
  return new THREE.BufferAttribute(values, source.itemSize)
}

function configureOverlayTextureSampling(source: THREE.Texture, target: THREE.Texture) {
  target.flipY = false
  // The body atlas is allowed to repeat, but this private canvas contains one
  // nipple circle. Inheriting RepeatWrapping tiles that circle across every
  // projected UV outside 0..1, with smaller nipple radii producing more copies.
  target.wrapS = THREE.ClampToEdgeWrapping
  target.wrapT = THREE.ClampToEdgeWrapping
  target.magFilter = source.magFilter
  target.minFilter = source.minFilter
  target.anisotropy = source.anisotropy
  target.generateMipmaps = source.generateMipmaps
  target.colorSpace = THREE.SRGBColorSpace
  target.channel = 1
  target.needsUpdate = true
}

/**
 * Nipple-centered surface projection for the accepted areola artwork.
 *
 * The body keeps its original UV and material mapping. Each side receives one
 * compact, skin-following surface made only from nearby body triangles. The
 * transparent artwork texture is centered and scaled from the resolved outer
 * base-ring frame while remaining round; the central point only selects which
 * connected body-surface island owns the pigment.
 */
export class SkinArtworkProjectionRuntime {
  readonly mesh: RuntimeMesh
  private readonly geometry: THREE.BufferGeometry
  private readonly position: NumericBufferAttribute
  private readonly normal: NumericBufferAttribute
  private readonly uv0: NumericBufferAttribute
  private readonly index: NumericBufferAttribute
  private circles: RuntimeCircle[] = []
  private initialized = false
  private disposed = false
  private nippleSizeValue: number | null

  constructor(
    root: THREE.Object3D,
    readonly definition: SkinArtworkProjectionDefinitionV8,
    nippleSizeValue: number | null = null
  ) {
    this.nippleSizeValue = nippleSizeValue
    this.mesh = exactMesh(root, definition.runtimeBinding.node)
    if (this.mesh.material.name !== definition.runtimeBinding.material) {
      fail(
        `${definition.runtimeBinding.node} must use ${definition.runtimeBinding.material}`
      )
    }
    this.geometry = this.mesh.geometry
    this.position = numericAttribute(
      this.geometry.getAttribute('position'),
      3,
      'body POSITION'
    )
    this.normal = numericAttribute(
      this.geometry.getAttribute('normal'),
      3,
      'body NORMAL'
    )
    this.uv0 = numericAttribute(this.geometry.getAttribute('uv'), 2, 'body TEXCOORD_0')
    this.index = numericAttribute(this.geometry.getIndex(), 1, 'body indices')
  }

  async initialize() {
    if (this.disposed) fail('cannot initialize after disposal')
    if (this.initialized) return
    await verifySkinArtworkProjectionDefinition(this.definition)
    const binding = this.definition.runtimeBinding
    if (
      this.position.count !== binding.vertexCount ||
      this.uv0.count !== binding.vertexCount ||
      this.index.count !== binding.indexCount
    ) {
      fail('body vertex/index counts do not match the immutable projection binding')
    }
    const [indexSha256, uvSha256] = await Promise.all([
      sha256Hex(bytes(this.index.array)),
      sha256Hex(bytes(this.uv0.array))
    ])
    if (indexSha256 !== binding.indexSha256 || uvSha256 !== binding.uvSha256) {
      fail(
        'body topology or UV identity does not match the immutable projection binding'
      )
    }

    try {
      this.circles = this.definition.circles.map((entry) => {
        assertUvClose(
          barycentricUv(entry.anchors.ownershipSeed, this.index, this.uv0),
          entry.surfaceCenterUv,
          `${entry.side} ownershipSeed anchor`
        )
        const boundaryUvCenter = entry.anchors.outerBoundary
          .map((anchor) => barycentricUv(anchor, this.index, this.uv0))
          .reduce<[number, number]>(
            (sum, resolved) => [sum[0] + resolved[0], sum[1] + resolved[1]],
            [0, 0]
          )
          .map((value) => value / entry.anchors.outerBoundary.length) as [
          number,
          number
        ]
        assertUvClose(
          boundaryUvCenter,
          entry.surfaceCenterUv,
          `${entry.side} outerBoundary centroid`
        )
        for (const [anchorIndex, anchor] of entry.anchors.outerBoundary.entries()) {
          const resolved = barycentricUv(anchor, this.index, this.uv0)
          const distance = Math.hypot(
            resolved[0] - entry.surfaceCenterUv[0],
            resolved[1] - entry.surfaceCenterUv[1]
          )
          if (distance <= UV_EPSILON || distance >= entry.supportRadiusUv) {
            fail(
              `${entry.side} outerBoundary[${anchorIndex}] must surround the center inside projection support`
            )
          }
        }
        const deformationExpected = {
          uMinus: [
            entry.deformationCenterUv[0] - entry.deformationFrameRadiusUv,
            entry.deformationCenterUv[1]
          ],
          uPlus: [
            entry.deformationCenterUv[0] + entry.deformationFrameRadiusUv,
            entry.deformationCenterUv[1]
          ],
          vMinus: [
            entry.deformationCenterUv[0],
            entry.deformationCenterUv[1] - entry.deformationFrameRadiusUv
          ],
          vPlus: [
            entry.deformationCenterUv[0],
            entry.deformationCenterUv[1] + entry.deformationFrameRadiusUv
          ]
        } satisfies Record<string, [number, number]>
        for (const key of Object.keys(
          deformationExpected
        ) as Array<keyof typeof deformationExpected>) {
          assertUvClose(
            barycentricUv(
              entry.anchors.deformationFrame[key],
              this.index,
              this.uv0
            ),
            deformationExpected[key],
            `${entry.side} deformationFrame.${key}`
          )
        }

        const sourceVertices: number[] = []
        const sourceTriangles: number[] = []
        for (let triangle = 0; triangle < this.index.count / 3; triangle += 1) {
          const vertices = [0, 1, 2].map((corner) =>
            this.index.getX(triangle * 3 + corner)
          )
          const points = vertices.map(
            (vertex) =>
              [this.uv0.getX(vertex), this.uv0.getY(vertex)] as [number, number]
          )
          if (
            triangleTouchesCircle(points, entry.surfaceCenterUv, entry.supportRadiusUv)
          ) {
            sourceTriangles.push(triangle)
            sourceVertices.push(...vertices)
          }
        }
        if (sourceVertices.length < 12 || sourceVertices.length % 3 !== 0) {
          fail(`${entry.side} projection support contains too few body triangles`)
        }

        const sourceMap = Uint32Array.from(sourceVertices)
        const sourceTriangleMap = Uint32Array.from(sourceTriangles)
        const centerLocalTriangle = sourceTriangles.indexOf(
          entry.anchors.ownershipSeed.triangle
        )
        if (centerLocalTriangle < 0) {
          fail(`${entry.side} projection support omits the nipple-center triangle`)
        }
        const overlayGeometry = new THREE.BufferGeometry()
        const overlayPosition = copyAttributeValues(this.position, sourceMap)
        const overlayNormal = copyAttributeValues(this.normal, sourceMap)
        overlayPosition.setUsage(THREE.DynamicDrawUsage)
        overlayNormal.setUsage(THREE.DynamicDrawUsage)
        overlayGeometry.setAttribute('position', overlayPosition)
        overlayGeometry.setAttribute('normal', overlayNormal)
        overlayGeometry.setAttribute('uv', copyAttributeValues(this.uv0, sourceMap))
        overlayGeometry.setIndex(
          new THREE.BufferAttribute(
            Uint32Array.from({ length: sourceMap.length }, (_, index) => index),
            1
          )
        )
        const uv1 = new THREE.BufferAttribute(new Float32Array(sourceMap.length * 2), 2)
        uv1.setUsage(THREE.DynamicDrawUsage)
        overlayGeometry.setAttribute('uv1', uv1)

        for (const name of ['skinIndex', 'skinWeight'] as const) {
          const source = this.geometry.getAttribute(name)
          if (source) {
            overlayGeometry.setAttribute(
              name,
              copyAttributeValues(
                numericAttribute(source, 4, `body ${name}`),
                sourceMap
              )
            )
          }
        }

        const placeholder = new THREE.MeshStandardMaterial({ visible: false })
        placeholder.name = `skin-artwork-${entry.side}-placeholder-v8`
        const bodySkinned = this.mesh as RuntimeSkinnedMesh
        let overlay: RuntimeMesh | RuntimeSkinnedMesh
        if (bodySkinned.isSkinnedMesh) {
          const skinnedOverlay = new THREE.SkinnedMesh(
            overlayGeometry,
            placeholder
          ) as RuntimeSkinnedMesh
          skinnedOverlay.bind(bodySkinned.skeleton, bodySkinned.bindMatrix)
          skinnedOverlay.bindMode = bodySkinned.bindMode
          overlay = skinnedOverlay
        } else {
          overlay = new THREE.Mesh(overlayGeometry, placeholder)
        }
        overlay.name = `skin-artwork-${entry.side}-nipple-overlay-v8`
        overlay.position.copy(this.mesh.position)
        overlay.quaternion.copy(this.mesh.quaternion)
        overlay.scale.copy(this.mesh.scale)
        overlay.renderOrder = this.mesh.renderOrder + 1
        overlay.frustumCulled = false
        if (!this.mesh.parent) fail('body mesh must have a parent for surface artwork')
        this.mesh.parent.add(overlay)
        return {
          definition: entry,
          mesh: overlay,
          geometry: overlayGeometry,
          sourceVertices: sourceMap,
          sourceTriangles: sourceTriangleMap,
          triangleNeighbors: triangleNeighbors(sourceMap),
          centerLocalTriangle,
          position: overlayPosition,
          normal: overlayNormal,
          uv1,
          diagnostics: {
            side: entry.side,
            candidateComponentCount: 0,
            visibleComponentCount: 1,
            ownedTriangleCount: 0,
            rejectedTriangleCount: 0
          },
          ownedMaterial: placeholder,
          ownedTexture: null
        }
      }) as RuntimeCircle[]
      this.initialized = true
      this.syncSurfaceGeometry()
    } catch (error) {
      this.disposeCircles()
      throw error
    }
  }

  prepareArtwork(
    pigmentCanvas: HTMLCanvasElement,
    bodyMaterial: THREE.MeshStandardMaterial,
    nippleMaskCanvas: HTMLCanvasElement
  ): SkinArtworkPreparedProjection {
    if (!this.initialized || this.disposed) fail('projection is not initialized')
    if (
      nippleMaskCanvas.width !== pigmentCanvas.width ||
      nippleMaskCanvas.height !== pigmentCanvas.height
    ) {
      fail('nipple pigment mask dimensions must match the isolated pigment canvas')
    }
    const pigmentContext = pigmentCanvas.getContext('2d', {
      alpha: true,
      colorSpace: 'srgb'
    })
    if (!pigmentContext) fail('isolated nipple pigment canvas has no 2D context')
    const maskContext = nippleMaskCanvas.getContext('2d', {
      alpha: true,
      colorSpace: 'srgb'
    })
    if (!maskContext) fail('nipple pigment mask has no 2D context')
    const prepared = this.definition.circles.map((entry) => {
      const size = this.definition.runtimeBinding.overlayTextureSize
      const overlayCanvas = document.createElement('canvas')
      overlayCanvas.width = size
      overlayCanvas.height = size
      const overlayContext = overlayCanvas.getContext('2d', {
        alpha: true,
        colorSpace: 'srgb'
      })
      if (!overlayContext) fail(`${entry.side} overlay canvas has no 2D context`)
      const overlayMaskCanvas = document.createElement('canvas')
      overlayMaskCanvas.width = size
      overlayMaskCanvas.height = size
      const overlayMaskContext = overlayMaskCanvas.getContext('2d', {
        alpha: true,
        colorSpace: 'srgb'
      })
      if (!overlayMaskContext) {
        fail(`${entry.side} overlay pigment mask has no 2D context`)
      }
      const sourceRadiusX = entry.sourceOuterRadiusUv * pigmentCanvas.width
      const sourceRadiusY = entry.sourceOuterRadiusUv * pigmentCanvas.height
      const centerX = entry.sourceArtworkCenterUv[0] * pigmentCanvas.width
      const centerY = entry.sourceArtworkCenterUv[1] * pigmentCanvas.height
      const outputRadius = this.definition.runtimeBinding.overlayTextureRadiusUv * size
      overlayContext.drawImage(
        pigmentCanvas,
        centerX - sourceRadiusX,
        centerY - sourceRadiusY,
        sourceRadiusX * 2,
        sourceRadiusY * 2,
        size / 2 - outputRadius,
        size / 2 - outputRadius,
        outputRadius * 2,
        outputRadius * 2
      )
      overlayMaskContext.drawImage(
        nippleMaskCanvas,
        centerX - sourceRadiusX,
        centerY - sourceRadiusY,
        sourceRadiusX * 2,
        sourceRadiusY * 2,
        size / 2 - outputRadius,
        size / 2 - outputRadius,
        outputRadius * 2,
        outputRadius * 2
      )
      const overlayPixels = overlayContext.getImageData(0, 0, size, size)
      const overlayMaskPixels = overlayMaskContext.getImageData(0, 0, size, size)
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const offset = (y * size + x) * 4
          const pigmentAlpha = overlayPixels.data[offset + 3]!
          const maskAlpha = overlayMaskPixels.data[offset + 3]!
          const alpha = Math.min(pigmentAlpha, maskAlpha)
          if (alpha === 0) {
            overlayPixels.data[offset] = 0
            overlayPixels.data[offset + 1] = 0
            overlayPixels.data[offset + 2] = 0
            overlayPixels.data[offset + 3] = 0
            continue
          }
          overlayPixels.data[offset + 3] = alpha
        }
      }
      overlayContext.putImageData(overlayPixels, 0, 0)

      const texture = new THREE.CanvasTexture(overlayCanvas)
      texture.name = `skin-artwork-${entry.side}-nipple-circle-v8`
      if (!bodyMaterial.map) fail('body artwork material has no Base Color map')
      configureOverlayTextureSampling(bodyMaterial.map, texture)
      const material = bodyMaterial.clone()
      material.name = `skin-artwork-${entry.side}-nipple-overlay-material-v8`
      material.map = texture
      material.transparent = true
      material.alphaTest = 0.001
      // This is a pigment decal on the body, not a second physical skin shell.
      // Keeping it co-surface and out of the depth buffer prevents the overlay
      // from introducing a new nipple-base lighting/depth crescent.
      material.depthWrite = false
      material.polygonOffset = true
      material.polygonOffsetFactor = -1
      material.polygonOffsetUnits = -1
      material.needsUpdate = true
      return { material, texture }
    }) as [PreparedOverlay, PreparedOverlay]
    return { overlays: prepared }
  }

  commitPrepared(prepared: SkinArtworkPreparedProjection) {
    if (!this.initialized || this.disposed) fail('projection is not initialized')
    for (let index = 0; index < this.circles.length; index += 1) {
      const circle = this.circles[index]
      const next = prepared.overlays[index]
      const previousMaterial = circle.ownedMaterial
      const previousTexture = circle.ownedTexture
      circle.mesh.material = next.material
      circle.mesh.visible = true
      circle.ownedMaterial = next.material
      circle.ownedTexture = next.texture
      previousMaterial.dispose()
      previousTexture?.dispose()
    }
  }

  disposePrepared(prepared: SkinArtworkPreparedProjection | null) {
    if (!prepared) return
    for (const overlay of prepared.overlays) {
      overlay.material.dispose()
      overlay.texture.dispose()
    }
  }

  syncSurfaceGeometry(nippleSizeValue: number | null = this.nippleSizeValue) {
    if (this.disposed) fail('cannot synchronize after disposal')
    if (!this.initialized) fail('projection is not initialized')
    this.nippleSizeValue = nippleSizeValue
    const center = new THREE.Vector3()
    const sizeUMinus = new THREE.Vector3()
    const sizeUPlus = new THREE.Vector3()
    const sizeVMinus = new THREE.Vector3()
    const sizeVPlus = new THREE.Vector3()
    const axisU = new THREE.Vector3()
    const axisV = new THREE.Vector3()
    const axisNormal = new THREE.Vector3()
    const frameCenter = new THREE.Vector3()
    const delta = new THREE.Vector3()
    for (const circle of this.circles) {
      const entry = circle.definition
      const deformationFrame = entry.anchors.deformationFrame
      barycentricPoint(
        deformationFrame.uMinus,
        this.index,
        this.position,
        sizeUMinus
      )
      barycentricPoint(
        deformationFrame.uPlus,
        this.index,
        this.position,
        sizeUPlus
      )
      barycentricPoint(
        deformationFrame.vMinus,
        this.index,
        this.position,
        sizeVMinus
      )
      barycentricPoint(
        deformationFrame.vPlus,
        this.index,
        this.position,
        sizeVPlus
      )
      // The exact outer polygon loop selected in the accepted Blender source
      // owns the neutral center. This surrounding frame transports that center
      // through breast and Nipple Size deformation without inheriting the
      // Nipple Point morph that also moves some vertices in the selected loop.
      axisU.subVectors(sizeUPlus, sizeUMinus)
      const uLength = axisU.length()
      if (!Number.isFinite(uLength) || uLength <= EPSILON) {
        fail(`${entry.side} horizontal surface frame is degenerate`)
      }
      axisU.multiplyScalar(1 / uLength)
      axisV.subVectors(sizeVPlus, sizeVMinus)
      axisV.addScaledVector(axisU, -axisV.dot(axisU))
      const vLength = axisV.length()
      if (!Number.isFinite(vLength) || vLength <= EPSILON) {
        fail(`${entry.side} vertical surface frame is degenerate`)
      }
      axisV.multiplyScalar(1 / vLength)
      axisNormal.crossVectors(axisU, axisV)
      const normalLength = axisNormal.length()
      if (!Number.isFinite(normalLength) || normalLength <= EPSILON) {
        fail(`${entry.side} surface-frame normal is degenerate`)
      }
      axisNormal.multiplyScalar(1 / normalLength)
      frameCenter
        .copy(sizeUMinus)
        .add(sizeUPlus)
        .add(sizeVMinus)
        .add(sizeVPlus)
        .multiplyScalar(0.25)
      center
        .copy(frameCenter)
        .addScaledVector(
          axisU,
          entry.neutralCenterFrameRatios[0] * uLength
        )
        .addScaledVector(
          axisV,
          entry.neutralCenterFrameRatios[1] * vLength
        )
        .addScaledVector(
          axisNormal,
          entry.neutralCenterFrameRatios[2] * Math.sqrt(uLength * vLength)
        )
      const frameScale = Math.sqrt(
        (uLength * vLength) /
          (entry.neutralSizeFrameMeters[0] * entry.neutralSizeFrameMeters[1])
      )
      const resolvedNippleSize = nullableUnit(
        this.nippleSizeValue ??
          this.definition.radiusResponse.bakedDriverValue ??
          0,
        'resolved nipple_size value'
      )!
      const positiveResponse = Math.max(0, resolvedNippleSize)
      const radiusMultiplier =
        1 +
        positiveResponse *
          (this.definition.radiusResponse.positiveMaximumMultiplier - 1)
      const radius = Math.min(
        entry.neutralOuterRadiusMeters * frameScale * radiusMultiplier,
        this.definition.radiusResponse.maximumOuterRadiusMeters
      )
      if (!Number.isFinite(radius) || radius <= EPSILON) {
        fail(`${entry.side} artwork radius is degenerate`)
      }
      const textureRadius = this.definition.runtimeBinding.overlayTextureRadiusUv
      for (let local = 0; local < circle.sourceVertices.length; local += 1) {
        const source = circle.sourceVertices[local]
        const nx = this.normal.getX(source)
        const ny = this.normal.getY(source)
        const nz = this.normal.getZ(source)
        circle.position.setXYZ(
          local,
          this.position.getX(source) +
            nx * this.definition.runtimeBinding.surfaceOffsetMeters,
          this.position.getY(source) +
            ny * this.definition.runtimeBinding.surfaceOffsetMeters,
          this.position.getZ(source) +
            nz * this.definition.runtimeBinding.surfaceOffsetMeters
        )
        circle.normal.setXYZ(local, nx, ny, nz)
        delta.set(
          this.position.getX(source) - center.x,
          this.position.getY(source) - center.y,
          this.position.getZ(source) - center.z
        )
        circle.uv1.setXY(
          local,
          0.5 + (delta.dot(axisU) / radius) * textureRadius,
          0.5 + (delta.dot(axisV) / radius) * textureRadius
        )
      }
      circle.diagnostics = applyCenterConnectedProjectionOwnership(
        circle,
        textureRadius
      )
      circle.position.needsUpdate = true
      circle.normal.needsUpdate = true
      circle.uv1.needsUpdate = true
      circle.geometry.computeBoundingSphere()
    }
  }

  projectionDiagnostics(): [
    SkinArtworkProjectionDiagnostics,
    SkinArtworkProjectionDiagnostics
  ] {
    if (!this.initialized || this.disposed) fail('projection is not initialized')
    return this.circles.map((circle) => ({ ...circle.diagnostics })) as [
      SkinArtworkProjectionDiagnostics,
      SkinArtworkProjectionDiagnostics
    ]
  }

  private disposeCircles() {
    for (const circle of this.circles) {
      circle.mesh.removeFromParent()
      circle.geometry.dispose()
      circle.ownedMaterial.dispose()
      circle.ownedTexture?.dispose()
    }
    this.circles = []
  }

  dispose() {
    if (this.disposed) return
    this.disposeCircles()
    this.disposed = true
  }
}

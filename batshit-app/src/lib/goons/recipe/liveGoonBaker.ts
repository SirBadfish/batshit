import * as THREE from 'three'
import { parseAppearanceDialsManifest } from '../appearanceDials.schema'
import { parseJointCorrectives } from '../jointCorrectives'
import {
  parseEyeApertureSeamDefinition,
  validateSocketEyeApertureOwnership
} from '../eyeApertureSeam'
import {
  parseSocketEyeSurfaceDefinition,
  socketEyeCapRetainedDynamicMorphs
} from '../socketEyeSurface'
import {
  LIVE_JOINT_CORRECTIVES_CONTRACT,
  parseLiveJointCorrectives,
  type LiveJointCorrectiveEntry,
  type LiveJointCorrectivesSpec
} from '../liveJointCorrectives'
import {
  buildAppearanceRecipePhysicalBasisFromGlb
} from './appearanceRecipePhysicalModel'
import {
  evaluateAppearanceRecipePhysicalOutput,
  type AppearanceRecipePhysicalBasis,
  type AppearanceRecipePhysicalEvaluation,
  type AppearanceRecipePositionDelta
} from './appearanceRecipePhysicalEvaluator'
import {
  ANATOMY_FIT_RECIPE_SIBLING_ID,
  ANATOMY_FIT_STATE_CONTRACT,
  assertAnatomyFitFollowerCompatibility,
  parseAnatomyFitState,
  type AnatomyFitResult
} from './anatomyFitContracts'
import {
  parseAnatomyFitManifestDefinition,
  requireAnatomyFitStateDefinition
} from './anatomyFitManifest'
import { createSocketEyeAnatomyProof } from './socketEyeSurfaceFit'
import { buildAppearanceRecipeSemanticMaterialProof } from './appearanceRecipeSemanticProof'
import {
  createGoonLiveBuildReceipt,
  GOON_LIVE_BUILD_CONTRACT,
  verifyGoonLiveBuildReceipt,
  type GoonLiveBuildBakerIdentity,
  type GoonLiveBuildEvidenceProofs,
  type GoonLiveBuildInventory,
  type GoonLiveBuildOutputCounts,
  type GoonLiveBuildReceipt,
  type GoonLiveBuildSourceIdentity,
  type GoonLiveBuildValidation
} from './liveBuildContracts'
import {
  createGoonLiveManifest,
  GOON_LIVE_MANIFEST_CONTRACT,
  verifyGoonLiveAvatarManifestAgainstReceipt,
  type GoonLiveManifest
} from './liveManifestContracts'
import {
  canonicalRecipeSha256,
  canonicalRecipeUtf8,
  canonicalRecipeString,
  sha256Hex
} from './recipeCanonical'
import {
  verifyRecipeStateSnapshot,
  type RecipeSource,
  type RecipeStateSnapshot
} from './recipeContracts'
import { verifyRecipeSourceRawAssets } from './recipeSourceAssets'
import {
  decodeSemanticGlbAccessor,
  getSemanticGlbMesh,
  getSemanticGlbNode,
  getSemanticGlbSkin,
  inspectSemanticGlbAccessor,
  parseSemanticGlb,
  resolveSemanticGlbNode,
  resolveSemanticGlbNodeTransform,
  stableSemanticGlbNodeName,
  type SemanticGlbDocument,
  type SemanticJsonRecord
} from './semanticGlb'
import { resolveStrictAppearanceRecipeSnapshot } from './strictAppearanceRecipeResolver'

type AppearanceManifest = NonNullable<ReturnType<typeof parseAppearanceDialsManifest>>

export const LIVE_GOON_BAKER_ID = 'batshit-live-goon-baker' as const
export const LIVE_GOON_BAKER_VERSION = 'r4-v1' as const
export const LIVE_GOON_BAKER_SCHEMA_VERSION = 'goon-live-manifest/v1' as const
export const LIVE_GOON_BAKER_RESOLVER_VERSION = 'appearance-recipe-physical-evaluation/v1' as const

export const LIVE_GOON_BAKER_IDENTITY: GoonLiveBuildBakerIdentity = Object.freeze({
  id: LIVE_GOON_BAKER_ID,
  version: LIVE_GOON_BAKER_VERSION,
  resolverVersion: LIVE_GOON_BAKER_RESOLVER_VERSION,
  schemaVersion: LIVE_GOON_BAKER_SCHEMA_VERSION
})

export type LiveGoonBakeInput = {
  source: RecipeSource
  sourceRevision: {
    revisionId: string
    revision: number
  }
  state: RecipeStateSnapshot
  packageBytes: Uint8Array
  modelBytes: Uint8Array
  manifestBytes: Uint8Array
}

export type LiveGoonBakeAudit = {
  contract: 'goon-live-bake-audit/v1'
  materialProofSha256: string
  retainedMorphProofSha256: string
  liveMorphTargets: string[]
  removedMorphTargets: string[]
  recipeMorphTargets: 0
  maximumErrors: GoonLiveBuildValidation
  reportSha256: string
}

export type LiveGoonBakeOutput = {
  contract: 'goon-live-bake-output/v1'
  modelBytes: Uint8Array
  manifestBytes: Uint8Array
  packageBytes: Uint8Array
  manifest: Record<string, unknown>
  liveManifest: GoonLiveManifest
  receipt: GoonLiveBuildReceipt
  audit: LiveGoonBakeAudit
}

export type LiveGoonBakeStage =
  | 'validating-source'
  | 'evaluating-recipe'
  | 'rewriting-model'
  | 'auditing-model'
  | 'packaging-live-goon'
  | 'verifying-output'

type JsonRecord = Record<string, unknown>

type AccessorOverride = {
  values: Float32Array
  type: 'SCALAR' | 'VEC3' | 'MAT4'
  count: number
  min?: number[]
  max?: number[]
}

type MorphPlan = {
  keptRefs: string[]
  removedRefs: string[]
  correctiveRefs: string[]
  dynamicRefs: string[]
  keepIndexesByMesh: Map<number, number[]>
  originalNamesByMesh: Map<number, string[]>
  outputNamesByMesh: Map<number, string[]>
  retainedWeightByNodeMorph: Map<string, number>
  liveCorrectives: LiveJointCorrectivesSpec | null
}

type StructuralRewrite = {
  bytes: Uint8Array
  morphPlan: MorphPlan
  counts: GoonLiveBuildOutputCounts
  cost: {
    inputBytes: number
    meshesProcessed: number
    verticesProcessed: number
    morphTargetsProcessed: number
  }
}

type StructuralAudit = {
  audit: LiveGoonBakeAudit
  proofs: GoonLiveBuildEvidenceProofs
  validation: GoonLiveBuildValidation
}

export type LiveGoonBakeArtifactInput = {
  modelBytes: Uint8Array
  manifestBytes: Uint8Array
  packageBytes: Uint8Array
  receipt: GoonLiveBuildReceipt
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder('utf-8', { fatal: true })
const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK = 0x4e4f534a
const GLB_BINARY_CHUNK = 0x004e4942
const MAX_BAKER_INPUT_BYTES = 1024 * 1024 * 1024
const MAX_ZIP32_BYTES = 0xffffffff
const MATRIX_EPSILON = 1e-10

function fail(message: string): never {
  throw new Error(`[${LIVE_GOON_BAKER_ID}/${LIVE_GOON_BAKER_VERSION}] ${message}`)
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`)
  }
  return value as JsonRecord
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`)
  return value
}

function optionalArray(value: unknown, context: string): unknown[] {
  return value === undefined ? [] : array(value, context)
}

function integer(value: unknown, context: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${context} must be a safe integer >= ${minimum}`)
  }
  return value as number
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return Object.is(value, -0) ? 0 : value
}

function stableString(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function exactBytes(value: Uint8Array, context: string): Uint8Array {
  if (
    !ArrayBuffer.isView(value) ||
    !('BYTES_PER_ELEMENT' in value) ||
    value.BYTES_PER_ELEMENT !== 1 ||
    value.byteLength === 0
  ) {
    fail(`${context} must be a non-empty Uint8Array`)
  }
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function align4(value: number): number {
  return (value + 3) & ~3
}

function cloneJson<T>(value: T): T {
  canonicalRecipeString(value)
  return structuredClone(value)
}

function uint8View(value: Float32Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

async function resolveBakedAnatomyFitResults(args: {
  input: LiveGoonBakeInput
  state: RecipeStateSnapshot
  manifest: JsonRecord
  appearanceManifest: AppearanceManifest
  baseline: AppearanceRecipePhysicalEvaluation
}): Promise<AnatomyFitResult[]> {
  const rawDefinition = args.manifest.anatomyFit
  const siblings = args.state.siblings.filter(
    (entry) =>
      entry.id === ANATOMY_FIT_RECIPE_SIBLING_ID ||
      entry.contract === ANATOMY_FIT_STATE_CONTRACT
  )
  if (rawDefinition === undefined || rawDefinition === null) {
    if (siblings.length > 0) {
      fail('Recipe State carries Anatomy Fit output but the source package has no Anatomy Fit definition')
    }
    return []
  }
  if (siblings.length !== 1) {
    fail('An Anatomy Fit source package requires exactly one Anatomy Fit Recipe sibling')
  }
  const sibling = siblings[0]!
  if (
    sibling.id !== ANATOMY_FIT_RECIPE_SIBLING_ID ||
    sibling.contract !== ANATOMY_FIT_STATE_CONTRACT
  ) {
    fail('Anatomy Fit Recipe sibling identity is ambiguous')
  }
  if (args.manifest.socketEyeSurface === undefined || args.manifest.eyeApertureSeam === undefined) {
    fail('Anatomy Fit v2 requires socketEyeSurface and eyeApertureSeam definitions')
  }
  const [definition, fitState, socketEyeSurface, eyeApertureSeam] = await Promise.all([
    parseAnatomyFitManifestDefinition(rawDefinition),
    parseAnatomyFitState(sibling.state),
    Promise.resolve(parseSocketEyeSurfaceDefinition(args.manifest.socketEyeSurface)),
    Promise.resolve(parseEyeApertureSeamDefinition(args.manifest.eyeApertureSeam))
  ])
  validateSocketEyeApertureOwnership(socketEyeSurface, eyeApertureSeam)
  if (
    sibling.definitionSha256 !== definition.definitionSha256 ||
    sibling.definitionSha256 !== fitState.definitionSha256
  ) {
    fail('Anatomy Fit Recipe sibling does not match the source package definition')
  }
  requireAnatomyFitStateDefinition(definition, fitState)
  const domainById = new Map(
    definition.domains.map((entry) => [`socket-eye:${entry.side}`, entry])
  )
  const meshById = new Map(args.baseline.meshes.map((entry) => [entry.id, entry]))
  const results: AnatomyFitResult[] = []

  for (const fit of fitState.fits) {
    const domain = domainById.get(fit.result.domain)
    if (!domain) fail(`Anatomy Fit state references undeclared domain ${fit.result.domain}`)
    if (fit.input.source.modelSha256 !== args.input.source.model.sha256) {
      fail(`Anatomy Fit ${fit.result.domain} targets another source model`)
    }
    if (
      fit.input.source.appearanceDefinitionSha256 !==
      args.appearanceManifest.definitionSha256
    ) {
      fail(`Anatomy Fit ${fit.result.domain} targets another Appearance definition`)
    }
    if (fit.input.source.topologySha256 !== domain.bodyTopologySha256) {
      fail(`Anatomy Fit ${fit.result.domain} targets another body topology`)
    }
    if (domain.bodyTopologySha256 !== args.input.source.identities.topologySha256) {
      fail(`Anatomy Fit ${fit.result.domain} topology does not match the verified Recipe Source`)
    }
    const mesh = meshById.get(domain.bodyMeshId)
    if (!mesh) fail(`Anatomy Fit ${fit.result.domain} body mesh is missing from the physical evaluation`)
    if (fit.input.source.positionsScalarCount !== mesh.positions.length) {
      fail(`Anatomy Fit ${fit.result.domain} composed POSITION count is stale`)
    }
    if (fit.input.source.positionsSha256 !== (await sha256Hex(uint8View(mesh.positions)))) {
      fail(`Anatomy Fit ${fit.result.domain} composed POSITION hash is stale`)
    }
    const surfaceSide = socketEyeSurface.runtimeBindings[domain.side]
    const seamSide = eyeApertureSeam.runtimeBindings[domain.side]
    if (
      domain.socketEyeSurfaceDefinitionSha256 !== socketEyeSurface.definitionSha256 ||
      domain.apertureSeamDefinitionSha256 !== eyeApertureSeam.definitionSha256 ||
      domain.compositeCapNodeId !== surfaceSide.nodes.compositeCap ||
      domain.lashesEyeOutlineNodeId !== seamSide.lashesEyeOutlineNode
    ) {
      fail(`Anatomy Fit ${fit.result.domain} cap/liner definition binding is stale`)
    }
    const physicalProjection = await createSocketEyeAnatomyProof({
      modelBytes: args.input.modelBytes,
      evaluation: args.baseline,
      surfaceDefinitionSha256: socketEyeSurface.definitionSha256,
      seamDefinitionSha256: eyeApertureSeam.definitionSha256,
      surface: surfaceSide,
      seam: seamSide
    })
    if (
      fit.input.source.physicalEvaluationSha256 !== physicalProjection.proofSha256 ||
      fit.input.source.physicalEvaluationScalarCount !== physicalProjection.scalarCount
    ) {
      fail(`Anatomy Fit ${fit.result.domain} generated cap/liner geometry or follower inventory is stale`)
    }
    const landmarkSet = {
      domain,
      surface: socketEyeSurface.definitionSha256,
      seam: eyeApertureSeam.definitionSha256
    }
    if (
      fit.input.source.landmarkSetSha256 !==
      (await canonicalRecipeSha256(landmarkSet))
    ) {
      fail(`Anatomy Fit ${fit.result.domain} socket/seam definition proof is stale`)
    }
    const relevantIds = fit.input.relevantInputs.map((entry) => entry.id)
    const expectedRelevantIds = Object.keys(args.state.appearanceDials.values).sort(compareText)
    if (canonicalRecipeString(relevantIds) !== canonicalRecipeString(expectedRelevantIds)) {
      fail(`Anatomy Fit ${fit.result.domain} relevant-input inventory is incomplete`)
    }
    for (const relevant of fit.input.relevantInputs) {
      if (args.state.appearanceDials.values[relevant.id] !== relevant.value) {
        fail(`Anatomy Fit ${fit.result.domain} relevant input ${relevant.id} is stale`)
      }
    }
    results.push(
      await assertAnatomyFitFollowerCompatibility(
        fit.input,
        fit.result,
        args.appearanceManifest
      )
    )
  }
  return results
}

function matrixArray(value: readonly number[], context: string): number[] {
  if (value.length !== 16) fail(`${context} must contain 16 values`)
  return value.map((entry, index) => finite(entry, `${context}[${index}]`))
}

function matrixMaximumError(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY
  let maximum = 0
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(left[index]! - right[index]!))
  }
  return maximum
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function deterministicStoredZip(entries: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const prepared = entries.map((entry) => ({
    ...entry,
    nameBytes: ENCODER.encode(entry.name),
    crc: crc32(entry.bytes)
  }))
  const localBytes = prepared.reduce(
    (sum, entry) => sum + 30 + entry.nameBytes.byteLength + entry.bytes.byteLength,
    0
  )
  const centralBytes = prepared.reduce((sum, entry) => sum + 46 + entry.nameBytes.byteLength, 0)
  const totalBytes = localBytes + centralBytes + 22
  if (totalBytes > MAX_ZIP32_BYTES || prepared.length > 0xffff) {
    fail('Live package exceeds deterministic ZIP32 limits')
  }
  const output = new Uint8Array(totalBytes)
  const view = new DataView(output.buffer)
  const offsets: number[] = []
  let offset = 0
  for (const entry of prepared) {
    offsets.push(offset)
    view.setUint32(offset, 0x04034b50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 10, 0, true)
    view.setUint16(offset + 12, 0x22, true)
    view.setUint32(offset + 14, entry.crc, true)
    view.setUint32(offset + 18, entry.bytes.byteLength, true)
    view.setUint32(offset + 22, entry.bytes.byteLength, true)
    view.setUint16(offset + 26, entry.nameBytes.byteLength, true)
    output.set(entry.nameBytes, offset + 30)
    output.set(entry.bytes, offset + 30 + entry.nameBytes.byteLength)
    offset += 30 + entry.nameBytes.byteLength + entry.bytes.byteLength
  }
  const centralOffset = offset
  prepared.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true)
    view.setUint16(offset + 4, 20, true)
    view.setUint16(offset + 6, 20, true)
    view.setUint16(offset + 12, 0, true)
    view.setUint16(offset + 14, 0x22, true)
    view.setUint32(offset + 16, entry.crc, true)
    view.setUint32(offset + 20, entry.bytes.byteLength, true)
    view.setUint32(offset + 24, entry.bytes.byteLength, true)
    view.setUint16(offset + 28, entry.nameBytes.byteLength, true)
    view.setUint32(offset + 42, offsets[index]!, true)
    output.set(entry.nameBytes, offset + 46)
    offset += 46 + entry.nameBytes.byteLength
  })
  view.setUint32(offset, 0x06054b50, true)
  view.setUint16(offset + 8, prepared.length, true)
  view.setUint16(offset + 10, prepared.length, true)
  view.setUint32(offset + 12, centralBytes, true)
  view.setUint32(offset + 16, centralOffset, true)
  return output
}

function writeGlb(gltf: JsonRecord, binary: Uint8Array): Uint8Array {
  const json = ENCODER.encode(canonicalRecipeString(gltf))
  const jsonLength = align4(json.byteLength)
  const binaryLength = align4(binary.byteLength)
  const total = 12 + 8 + jsonLength + 8 + binaryLength
  if (total > 0xffffffff) fail('Live GLB exceeds the glTF 2.0 32-bit length limit')
  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)
  view.setUint32(0, GLB_MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, GLB_JSON_CHUNK, true)
  output.fill(0x20, 20, 20 + jsonLength)
  output.set(json, 20)
  const binaryHeader = 20 + jsonLength
  view.setUint32(binaryHeader, binaryLength, true)
  view.setUint32(binaryHeader + 4, GLB_BINARY_CHUNK, true)
  output.set(binary, binaryHeader + 8)
  return output
}

const SAFE_PRESERVED_EXTENSIONS = new Set([
  'KHR_lights_punctual',
  'KHR_materials_anisotropy',
  'KHR_materials_clearcoat',
  'KHR_materials_diffuse_transmission',
  'KHR_materials_dispersion',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_iridescence',
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_variants',
  'KHR_materials_volume',
  'KHR_texture_basisu',
  'KHR_texture_transform',
  'EXT_texture_avif',
  'EXT_texture_webp'
])

function validateStructuralExtensions(parsed: SemanticGlbDocument): void {
  const used = optionalArray(parsed.gltf.extensionsUsed, 'gltf.extensionsUsed')
  const required = new Set(
    optionalArray(parsed.gltf.extensionsRequired, 'gltf.extensionsRequired').map((value, index) =>
      stableString(value, `gltf.extensionsRequired[${index}]`)
    )
  )
  for (const [index, value] of used.entries()) {
    const extension = stableString(value, `gltf.extensionsUsed[${index}]`)
    if (!SAFE_PRESERVED_EXTENSIONS.has(extension)) {
      fail(
        `extension ${extension} is not proven safe for structural Live baking${
          required.has(extension) ? ' and is required by the source' : ''
        }`
      )
    }
  }
  const bufferViews = optionalArray(parsed.gltf.bufferViews, 'gltf.bufferViews')
  for (const [index, value] of bufferViews.entries()) {
    const view = record(value, `gltf.bufferViews[${index}]`)
    if (view.extensions !== undefined) {
      const names = Object.keys(record(view.extensions, `gltf.bufferViews[${index}].extensions`))
      if (names.length > 0) {
        fail(`bufferView ${index} uses unsupported structural extensions: ${names.join(', ')}`)
      }
    }
  }
  for (const [meshIndex, meshValue] of optionalArray(parsed.gltf.meshes, 'gltf.meshes').entries()) {
    const mesh = record(meshValue, `gltf.meshes[${meshIndex}]`)
    for (const [primitiveIndex, primitiveValue] of optionalArray(
      mesh.primitives,
      `gltf.meshes[${meshIndex}].primitives`
    ).entries()) {
      const primitive = record(primitiveValue, `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`)
      if (primitive.extensions !== undefined) {
        const names = Object.keys(
          record(primitive.extensions, `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].extensions`)
        )
        const unsupported = names.filter((name) => !SAFE_PRESERVED_EXTENSIONS.has(name))
        if (unsupported.length > 0) {
          fail(`mesh primitive uses unsupported structural extensions: ${unsupported.join(', ')}`)
        }
      }
    }
  }
}

function activeSceneOrder(parsed: SemanticGlbDocument): { scene: JsonRecord; roots: number[]; order: number[] } {
  const scenes = array(parsed.gltf.scenes, 'gltf.scenes')
  if (scenes.length === 0) fail('avatar.glb has no scenes')
  const sceneIndex = integer(parsed.gltf.scene ?? 0, 'gltf.scene')
  if (sceneIndex >= scenes.length) fail('gltf.scene is out of range')
  const scene = record(scenes[sceneIndex], `gltf.scenes[${sceneIndex}]`)
  const roots = array(scene.nodes, `gltf.scenes[${sceneIndex}].nodes`).map((value, index) =>
    integer(value, `gltf.scenes[${sceneIndex}].nodes[${index}]`)
  )
  if (roots.length === 0 || new Set(roots).size !== roots.length) {
    fail('active scene roots must be non-empty and unique')
  }
  const order: number[] = []
  const visited = new Set<number>()
  const visit = (nodeIndex: number) => {
    if (nodeIndex >= parsed.nodes.length) fail(`active node ${nodeIndex} is out of range`)
    if (visited.has(nodeIndex)) fail(`active scene reaches node ${nodeIndex} more than once`)
    visited.add(nodeIndex)
    order.push(nodeIndex)
    const node = parsed.nodes[nodeIndex]!
    for (const childValue of optionalArray(node.children, `gltf.nodes[${nodeIndex}].children`)) {
      visit(integer(childValue, `gltf.nodes[${nodeIndex}].children[]`))
    }
  }
  roots.forEach(visit)
  return { scene, roots, order }
}

function inventorySegment(value: string): string {
  let encoded = ''
  for (const byte of ENCODER.encode(value)) {
    const character = String.fromCharCode(byte)
    encoded += /^[A-Za-z0-9._:-]$/.test(character)
      ? character
      : `+${byte.toString(16).padStart(2, '0')}`
  }
  if (encoded.length === 0) fail('inventory path segment may not be empty')
  return encoded
}

function rawNodePath(parsed: SemanticGlbDocument, nodeIndex: number): string {
  const segments: string[] = []
  let cursor: number | undefined = nodeIndex
  while (cursor !== undefined) {
    const node = getSemanticGlbNode(parsed, cursor, `gltf.nodes[${cursor}]`)
    const name = stableString(node.name, `gltf.nodes[${cursor}].name`)
    segments.unshift(inventorySegment(name))
    cursor = parsed.parents.get(cursor)
  }
  return `node:/${segments.join('/')}`
}

function morphRef(parsed: SemanticGlbDocument, nodeIndex: number, morph: string): string {
  return `${rawNodePath(parsed, nodeIndex)}/morph:/${inventorySegment(morph)}`
}

function collectStrings(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    output.add(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStrings(entry, output))
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => collectStrings(entry, output))
  }
}

function socketEyeRuntimeMorphsByNode(
  parsed: SemanticGlbDocument,
  rawManifest: JsonRecord,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>()
  const rawSurface = rawManifest.socketEyeSurface
  const rawSeam = rawManifest.eyeApertureSeam
  if (rawSurface === undefined && rawSeam === undefined) return result
  if (rawSurface === undefined || rawSeam === undefined) {
    fail('Socket-eye Recipe Source must declare both socketEyeSurface and eyeApertureSeam')
  }
  const surface = parseSocketEyeSurfaceDefinition(rawSurface)
  const seam = parseEyeApertureSeamDefinition(rawSeam)
  validateSocketEyeApertureOwnership(surface, seam)
  for (const side of ['left', 'right'] as const) {
    const roots = [
      {
        rootName: surface.runtimeBindings[side].nodes.compositeCap,
        retained: new Set(socketEyeCapRetainedDynamicMorphs(side))
      },
      {
        rootName: seam.runtimeBindings[side].lashesEyeOutlineNode,
        retained: new Set(seam.runtimeBindings[side].liner.retainedPerformanceMorphs)
      }
    ]
    for (const { rootName, retained } of roots) {
      const rootIndex = resolveSemanticGlbNode(
        parsed,
        rootName,
        `socket-eye Recipe Source node ${rootName}`,
      )
      const pending = [rootIndex]
      const visited = new Set<number>()
      while (pending.length > 0) {
        const nodeIndex = pending.pop()!
        if (visited.has(nodeIndex)) continue
        visited.add(nodeIndex)
        const node = getSemanticGlbNode(
          parsed,
          nodeIndex,
          `socket-eye Recipe Source node ${rootName}`,
        )
        if (node.mesh !== undefined) result.set(nodeIndex, retained)
        for (const child of optionalArray(node.children, `${rootName}.children`)) {
          pending.push(integer(child, `${rootName}.children[]`))
        }
      }
    }
  }
  return result
}

function morphTargetNames(mesh: JsonRecord, context: string): string[] {
  const primitives = array(mesh.primitives, `${context}.primitives`)
  if (primitives.length === 0) fail(`${context} has no primitives`)
  const targetCount = optionalArray(record(primitives[0], `${context}.primitives[0]`).targets, `${context}.targets`).length
  for (const [index, primitiveValue] of primitives.entries()) {
    const count = optionalArray(record(primitiveValue, `${context}.primitives[${index}]`).targets, `${context}.targets`).length
    if (count !== targetCount) fail(`${context} primitives disagree on morph target count`)
  }
  if (targetCount === 0) return []
  const extras = record(mesh.extras, `${context}.extras`)
  const names = array(extras.targetNames, `${context}.extras.targetNames`).map((value, index) =>
    stableString(value, `${context}.extras.targetNames[${index}]`)
  )
  if (names.length !== targetCount || new Set(names).size !== names.length) {
    fail(`${context}.extras.targetNames must be unique and exhaustive`)
  }
  return names
}

function resolveAppearanceNodeIndices(
  parsed: SemanticGlbDocument,
  manifest: AppearanceManifest
): Map<string, number | null> {
  const result = new Map<string, number | null>()
  for (const [id, declaration] of Object.entries(manifest.nodes)) {
    try {
      result.set(id, resolveSemanticGlbNode(parsed, declaration.node, `appearance node ${id}`))
    } catch (error) {
      if (declaration.required) throw error
      result.set(id, null)
    }
  }
  return result
}

function createLiveCorrectives(
  rawManifest: JsonRecord,
  appearanceManifest: AppearanceManifest,
  resolved: ReturnType<typeof resolveStrictAppearanceRecipeSnapshot>['resolved'],
  nodeIndices: Map<string, number | null>,
  parsed: SemanticGlbDocument
): { spec: LiveJointCorrectivesSpec | null; correctiveKeys: Set<string> } {
  const authoring = parseJointCorrectives(rawManifest, appearanceManifest)
  if (!authoring) return { spec: null, correctiveKeys: new Set() }
  const entries: LiveJointCorrectiveEntry[] = []
  const correctiveKeys = new Set<string>()
  for (const [entryIndex, entry] of authoring.entries.entries()) {
    const target = appearanceManifest.targets[entry.key]
    if (!target || target.runtimeRetention !== 'retain-in-live-goon') {
      fail(`corrective ${entry.key} is not retained in the Live Goon`)
    }
    const dialValue = resolved.values[entry.anchorDial]
    if (dialValue === undefined) fail(`corrective ${entry.key} anchor dial is absent from resolved state`)
    const anchor = entry.anchorAt0 + (entry.anchorAt1 - entry.anchorAt0) * dialValue
    const baseInfluence = resolved.influences.get(entry.key)
    if (baseInfluence === undefined) fail(`corrective ${entry.key} has no resolved base influence`)
    for (const [bindingIndex, binding] of target.bindings.entries()) {
      const nodeIndex = nodeIndices.get(binding.node)
      if (nodeIndex === undefined || nodeIndex === null) {
        fail(`corrective ${entry.key} binding ${bindingIndex} has no physical node`)
      }
      const nodeName = stableString(
        getSemanticGlbNode(parsed, nodeIndex, `corrective ${entry.key} node`).name,
        `corrective ${entry.key} node name`
      )
      const id = `${entry.driver}:${entry.key}:${bindingIndex}:${entryIndex}`
      entries.push({
        id,
        driver: entry.driver,
        node: nodeName,
        morph: binding.morph,
        baseInfluence,
        anchor,
        influenceMin: target.influenceMin,
        influenceMax: target.influenceMax,
        angleCurve: entry.angleCurve.map((point) => [...point] as [number, number]),
        mode: 'additive'
      })
      correctiveKeys.add(`${nodeIndex}\u0000${binding.morph}`)
    }
  }
  const spec = parseLiveJointCorrectives({
    contract: LIVE_JOINT_CORRECTIVES_CONTRACT,
    drivers: cloneJson(authoring.drivers),
    entries
  })
  if (!spec) fail('authoring correctives produced an empty Live projection')
  return { spec, correctiveKeys }
}

function buildMorphPlan(
  parsed: SemanticGlbDocument,
  rawManifest: JsonRecord,
  appearanceManifest: AppearanceManifest,
  resolved: ReturnType<typeof resolveStrictAppearanceRecipeSnapshot>['resolved']
): MorphPlan {
  const active = activeSceneOrder(parsed)
  const nodeIndices = resolveAppearanceNodeIndices(parsed, appearanceManifest)
  const removeByNode = new Map<number, Set<string>>()
  const requiredByNode = new Map<number, Set<string>>()
  const retainedWeightByNodeMorph = new Map<string, number>()
  const requireMorph = (nodeIndex: number, morph: string) => {
    const values = requiredByNode.get(nodeIndex) ?? new Set<string>()
    values.add(morph)
    requiredByNode.set(nodeIndex, values)
  }
  const removeMorph = (nodeIndex: number, morph: string) => {
    const values = removeByNode.get(nodeIndex) ?? new Set<string>()
    values.add(morph)
    removeByNode.set(nodeIndex, values)
  }

  for (const [targetId, target] of Object.entries(appearanceManifest.targets)) {
    for (const [bindingIndex, binding] of target.bindings.entries()) {
      const nodeIndex = nodeIndices.get(binding.node)
      if (nodeIndex === undefined || nodeIndex === null) {
        if (target.runtimeRetention === 'retain-in-live-goon') {
          fail(`retained target ${targetId} binding ${bindingIndex} is missing`)
        }
        continue
      }
      if (target.runtimeRetention === 'recipe-only') {
        removeMorph(nodeIndex, binding.morph)
      } else {
        requireMorph(nodeIndex, binding.morph)
        const weight = resolved.influences.get(targetId)
        if (weight === undefined) fail(`retained target ${targetId} has no resolved influence`)
        const key = `${nodeIndex}\u0000${binding.morph}`
        const prior = retainedWeightByNodeMorph.get(key)
        if (prior !== undefined && prior !== weight) {
          fail(`retained morph ${binding.morph} on node ${nodeIndex} has conflicting base weights`)
        }
        retainedWeightByNodeMorph.set(key, weight)
      }
    }
  }
  for (const follower of Object.values(appearanceManifest.followers)) {
    for (const driver of follower.drivers) {
      for (const channel of driver.channels) {
        if (channel.kind !== 'morph-weight') continue
        const nodeIndex = nodeIndices.get(channel.node)
        if (nodeIndex !== undefined && nodeIndex !== null) removeMorph(nodeIndex, channel.morph)
      }
    }
  }

  const runtimeNames = new Set<string>()
  collectStrings(rawManifest.face, runtimeNames)
  collectStrings(rawManifest.eyeAppearance, runtimeNames)
  collectStrings(rawManifest.oralAppearance, runtimeNames)
  const rig = rawManifest.rig === undefined ? null : record(rawManifest.rig, 'avatar.json#rig')
  collectStrings(rig?.performance, runtimeNames)
  const socketEyeRuntimeMorphs = socketEyeRuntimeMorphsByNode(
    parsed,
    rawManifest,
  )

  const { spec: liveCorrectives, correctiveKeys } = createLiveCorrectives(
    rawManifest,
    appearanceManifest,
    resolved,
    nodeIndices,
    parsed
  )

  const nodesByMesh = new Map<number, number[]>()
  for (const nodeIndex of active.order) {
    const node = getSemanticGlbNode(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`)
    if (node.mesh === undefined) continue
    const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`)
    const values = nodesByMesh.get(meshIndex) ?? []
    values.push(nodeIndex)
    nodesByMesh.set(meshIndex, values)
  }

  const keptRefs: string[] = []
  const removedRefs: string[] = []
  const correctiveRefs: string[] = []
  const dynamicRefs: string[] = []
  const keepIndexesByMesh = new Map<number, number[]>()
  const originalNamesByMesh = new Map<number, string[]>()
  const outputNamesByMesh = new Map<number, string[]>()

  for (const [meshIndex, nodeIndexes] of [...nodesByMesh.entries()].sort((a, b) => a[0] - b[0])) {
    const mesh = getSemanticGlbMesh(parsed, meshIndex, `gltf.meshes[${meshIndex}]`)
    const names = morphTargetNames(mesh, `gltf.meshes[${meshIndex}]`)
    originalNamesByMesh.set(meshIndex, names)
    const keepIndexes: number[] = []
    const outputNames: string[] = []
    for (const [targetIndex, name] of names.entries()) {
      const removeDecisions = nodeIndexes.map((nodeIndex) => removeByNode.get(nodeIndex)?.has(name) ?? false)
      const requiredDecisions = nodeIndexes.map(
        (nodeIndex) =>
          requiredByNode.get(nodeIndex)?.has(name) ||
          (socketEyeRuntimeMorphs.has(nodeIndex)
            ? socketEyeRuntimeMorphs.get(nodeIndex)!.has(name)
            : runtimeNames.has(name))
      )
      if (removeDecisions.some(Boolean) && requiredDecisions.some(Boolean)) {
        fail(`morph ${name} on mesh ${meshIndex} is both Recipe-owned and runtime-required`)
      }
      const keep = requiredDecisions.some(Boolean) && !removeDecisions.some(Boolean)
      for (const nodeIndex of nodeIndexes) {
        const ref = morphRef(parsed, nodeIndex, name)
        if (keep) {
          keptRefs.push(ref)
          if (correctiveKeys.has(`${nodeIndex}\u0000${name}`)) correctiveRefs.push(ref)
          else dynamicRefs.push(ref)
        } else {
          removedRefs.push(ref)
        }
      }
      if (keep) {
        keepIndexes.push(targetIndex)
        outputNames.push(name)
      }
    }
    keepIndexesByMesh.set(meshIndex, keepIndexes)
    outputNamesByMesh.set(meshIndex, outputNames)
  }

  const sortedUnique = (values: string[]) => [...new Set(values)].sort(compareText)
  return {
    keptRefs: sortedUnique(keptRefs),
    removedRefs: sortedUnique(removedRefs),
    correctiveRefs: sortedUnique(correctiveRefs),
    dynamicRefs: sortedUnique(dynamicRefs),
    keepIndexesByMesh,
    originalNamesByMesh,
    outputNamesByMesh,
    retainedWeightByNodeMorph,
    liveCorrectives
  }
}

function rewriteMorphTargets(
  gltf: JsonRecord,
  parsed: SemanticGlbDocument,
  morphPlan: MorphPlan,
  accessorOverrides: Map<number, AccessorOverride>
): void {
  const meshes = optionalArray(gltf.meshes, 'gltf.meshes')
  const nodes = optionalArray(gltf.nodes, 'gltf.nodes')
  for (const [meshIndex, keepIndexes] of morphPlan.keepIndexesByMesh) {
    const mesh = record(meshes[meshIndex], `gltf.meshes[${meshIndex}]`)
    const originalNames = morphPlan.originalNamesByMesh.get(meshIndex)!
    const outputNames = morphPlan.outputNamesByMesh.get(meshIndex)!
    const originalMeshWeights =
      mesh.weights === undefined
        ? originalNames.map(() => 0)
        : array(mesh.weights, `gltf.meshes[${meshIndex}].weights`).map((value, index) =>
            finite(value, `gltf.meshes[${meshIndex}].weights[${index}]`)
          )
    if (originalMeshWeights.length !== originalNames.length) {
      fail(`mesh ${meshIndex} default weights are misaligned`)
    }
    const primitives = array(mesh.primitives, `gltf.meshes[${meshIndex}].primitives`)
    for (const [primitiveIndex, primitiveValue] of primitives.entries()) {
      const primitive = record(primitiveValue, `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`)
      const targets = optionalArray(primitive.targets, `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].targets`)
      if (targets.length !== originalNames.length) {
        fail(`mesh ${meshIndex} primitive ${primitiveIndex} morph inventory drifted`)
      }
      if (keepIndexes.length > 0) primitive.targets = keepIndexes.map((index) => targets[index])
      else delete primitive.targets
    }
    const extras = mesh.extras === undefined ? {} : record(mesh.extras, `gltf.meshes[${meshIndex}].extras`)
    if (outputNames.length > 0) {
      extras.targetNames = outputNames
      mesh.extras = extras
    } else {
      delete extras.targetNames
      if (Object.keys(extras).length === 0) delete mesh.extras
    }
    if (mesh.weights !== undefined) {
      if (keepIndexes.length > 0) mesh.weights = keepIndexes.map((index) => originalMeshWeights[index]!)
      else delete mesh.weights
    }
    for (const [nodeIndex, nodeValue] of nodes.entries()) {
      const node = record(nodeValue, `gltf.nodes[${nodeIndex}]`)
      if (node.mesh !== meshIndex) continue
      const sourceWeights =
        node.weights === undefined
          ? originalMeshWeights
          : array(node.weights, `gltf.nodes[${nodeIndex}].weights`).map((value, index) =>
              finite(value, `gltf.nodes[${nodeIndex}].weights[${index}]`)
            )
      if (sourceWeights.length !== originalNames.length) fail(`node ${nodeIndex} default weights are misaligned`)
      if (keepIndexes.length > 0) {
        node.weights = keepIndexes.map((sourceIndex) => {
          const retained = morphPlan.retainedWeightByNodeMorph.get(
            `${nodeIndex}\u0000${originalNames[sourceIndex]}`
          )
          return retained ?? sourceWeights[sourceIndex]!
        })
      } else {
        delete node.weights
      }
    }
  }
  rewriteWeightAnimations(gltf, parsed, morphPlan, accessorOverrides)
}

function rewriteWeightAnimations(
  gltf: JsonRecord,
  parsed: SemanticGlbDocument,
  morphPlan: MorphPlan,
  accessorOverrides: Map<number, AccessorOverride>
): void {
  const animations = optionalArray(gltf.animations, 'gltf.animations')
  const nodes = optionalArray(gltf.nodes, 'gltf.nodes')
  const keptAnimations: unknown[] = []
  for (const [animationIndex, animationValue] of animations.entries()) {
    const animation = record(animationValue, `gltf.animations[${animationIndex}]`)
    const samplers = array(animation.samplers, `gltf.animations[${animationIndex}].samplers`)
    const channels = array(animation.channels, `gltf.animations[${animationIndex}].channels`)
    const samplerPlans = new Map<number, { keep: number[]; originalCount: number }>()
    const removedChannels = new Set<number>()
    for (const [channelIndex, channelValue] of channels.entries()) {
      const channel = record(channelValue, `gltf.animations[${animationIndex}].channels[${channelIndex}]`)
      const target = record(channel.target, `gltf.animations[${animationIndex}].channels[${channelIndex}].target`)
      if (target.path !== 'weights') continue
      const nodeIndex = integer(target.node, `animation ${animationIndex} weights target node`)
      const node = record(nodes[nodeIndex], `gltf.nodes[${nodeIndex}]`)
      const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`)
      const keep = morphPlan.keepIndexesByMesh.get(meshIndex)
      const originalCount = morphPlan.originalNamesByMesh.get(meshIndex)?.length
      if (!keep || originalCount === undefined) fail('weight animation targets an unplanned mesh')
      if (keep.length === 0) {
        removedChannels.add(channelIndex)
        continue
      }
      const samplerIndex = integer(channel.sampler, `animation ${animationIndex} channel sampler`)
      const previous = samplerPlans.get(samplerIndex)
      if (previous && canonicalRecipeString(previous) !== canonicalRecipeString({ keep, originalCount })) {
        fail('one animation sampler is shared by incompatible morph inventories')
      }
      samplerPlans.set(samplerIndex, { keep, originalCount })
    }
    for (const [samplerIndex, plan] of samplerPlans) {
      const sampler = record(samplers[samplerIndex], `gltf.animations[${animationIndex}].samplers[${samplerIndex}]`)
      const inputAccessor = decodeSemanticGlbAccessor(parsed, sampler.input)
      const outputIndex = integer(sampler.output, `animation ${animationIndex} sampler output`)
      const outputAccessor = decodeSemanticGlbAccessor(parsed, outputIndex)
      if (outputAccessor.type !== 'SCALAR' || outputAccessor.componentType !== 5126 || outputAccessor.normalized) {
        fail('morph weight animation output must be an unnormalized FLOAT SCALAR accessor')
      }
      const multiplier = sampler.interpolation === 'CUBICSPLINE' ? 3 : 1
      const expected = inputAccessor.count * plan.originalCount * multiplier
      if (outputAccessor.count !== expected) fail('morph weight animation output count is malformed')
      const values = new Float32Array(inputAccessor.count * plan.keep.length * multiplier)
      let destination = 0
      for (let keyframe = 0; keyframe < inputAccessor.count; keyframe += 1) {
        for (let spline = 0; spline < multiplier; spline += 1) {
          const base = (keyframe * multiplier + spline) * plan.originalCount
          for (const targetIndex of plan.keep) values[destination++] = outputAccessor.values[base + targetIndex]!
        }
      }
      accessorOverrides.set(outputIndex, { values, type: 'SCALAR', count: values.length })
    }
    const retainedChannels = channels.filter((_channel, index) => !removedChannels.has(index))
    if (retainedChannels.length === 0) continue
    const usedSamplerIndexes = [...new Set(retainedChannels.map((channelValue, channelIndex) =>
      integer(record(channelValue, `animation ${animationIndex} retained channel ${channelIndex}`).sampler, 'animation sampler')
    ))].sort((left, right) => left - right)
    const samplerMapping = new Map(usedSamplerIndexes.map((sourceIndex, outputIndex) => [sourceIndex, outputIndex]))
    animation.samplers = usedSamplerIndexes.map((sourceIndex) => samplers[sourceIndex])
    animation.channels = retainedChannels.map((channelValue, channelIndex) => {
      const channel = record(channelValue, `animation ${animationIndex} retained channel ${channelIndex}`)
      const mapped = samplerMapping.get(integer(channel.sampler, 'animation sampler'))
      if (mapped === undefined) fail('retained animation channel lost its sampler')
      channel.sampler = mapped
      return channel
    })
    keptAnimations.push(animation)
  }
  if (keptAnimations.length > 0) gltf.animations = keptAnimations
  else delete gltf.animations
}

function minMaxVec3(values: Float32Array): { min: number[]; max: number[] } {
  if (values.length === 0 || values.length % 3 !== 0) fail('POSITION override must contain VEC3 rows')
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (let index = 0; index < values.length; index += 3) {
    for (let component = 0; component < 3; component += 1) {
      const value = finite(values[index + component], `POSITION[${index + component}]`)
      min[component] = Math.min(min[component]!, value)
      max[component] = Math.max(max[component]!, value)
    }
  }
  return { min, max }
}

function addPhysicalOverrides(
  gltf: JsonRecord,
  parsed: SemanticGlbDocument,
  evaluation: AppearanceRecipePhysicalEvaluation,
  accessorOverrides: Map<number, AccessorOverride>
): void {
  const meshes = optionalArray(gltf.meshes, 'gltf.meshes')
  const nodes = optionalArray(gltf.nodes, 'gltf.nodes')
  const skins = optionalArray(gltf.skins, 'gltf.skins')
  const positionByAccessor = new Map<number, Float32Array>()
  for (const mesh of evaluation.meshes) {
    const match = /^mesh:([0-9]+):([0-9]+)$/.exec(mesh.id)
    if (!match) fail(`physical mesh id ${mesh.id} is malformed`)
    const nodeIndex = Number(match[1])
    const primitiveIndex = Number(match[2])
    const node = record(nodes[nodeIndex], `gltf.nodes[${nodeIndex}]`)
    const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`)
    const gltfMesh = record(meshes[meshIndex], `gltf.meshes[${meshIndex}]`)
    const primitive = record(
      array(gltfMesh.primitives, `gltf.meshes[${meshIndex}].primitives`)[primitiveIndex],
      `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`
    )
    const attributes = record(primitive.attributes, `mesh ${mesh.id}.attributes`)
    const accessorIndex = integer(attributes.POSITION, `mesh ${mesh.id}.POSITION`)
    const previous = positionByAccessor.get(accessorIndex)
    if (previous) {
      if (previous.length !== mesh.positions.length) fail('shared POSITION accessor output length differs')
      for (let index = 0; index < previous.length; index += 1) {
        if (previous[index] !== mesh.positions[index]) {
          fail(`shared POSITION accessor ${accessorIndex} requires different baked outputs`)
        }
      }
      continue
    }
    const values = mesh.positions.slice()
    const bounds = minMaxVec3(values)
    accessorOverrides.set(accessorIndex, {
      values,
      type: 'VEC3',
      count: values.length / 3,
      ...bounds
    })
    positionByAccessor.set(accessorIndex, values)
  }

  const inverseByAccessor = new Map<number, Float32Array>()
  for (const skinOutput of evaluation.skins) {
    const match = /^skin:([0-9]+):([0-9]+)$/.exec(skinOutput.id)
    if (!match) fail(`physical skin id ${skinOutput.id} is malformed`)
    const skinIndex = Number(match[2])
    const skin = record(skins[skinIndex], `gltf.skins[${skinIndex}]`)
    const accessorIndex = integer(skin.inverseBindMatrices, `gltf.skins[${skinIndex}].inverseBindMatrices`)
    const values = new Float32Array(skinOutput.joints.length * 16)
    skinOutput.joints.forEach((joint, slot) => {
      matrixArray(joint.inverseBindMatrix, `skin ${skinOutput.id} joint ${slot}`).forEach((value, index) => {
        values[slot * 16 + index] = value
      })
    })
    const previous = inverseByAccessor.get(accessorIndex)
    if (previous) {
      if (previous.length !== values.length) fail('shared inverse-bind accessor output length differs')
      for (let index = 0; index < previous.length; index += 1) {
        if (previous[index] !== values[index]) {
          fail(`shared inverse-bind accessor ${accessorIndex} requires different baked outputs`)
        }
      }
      continue
    }
    accessorOverrides.set(accessorIndex, {
      values,
      type: 'MAT4',
      count: skinOutput.joints.length
    })
    inverseByAccessor.set(accessorIndex, values)
  }

  rewriteNodeRests(gltf, parsed, evaluation)
}

function writeNodeMatrix(node: JsonRecord, matrixValue: readonly number[], context: string): void {
  const matrix = new THREE.Matrix4().fromArray(matrixArray(matrixValue, context))
  if (node.matrix !== undefined) {
    node.matrix = matrix.elements.map((value) => (Object.is(value, -0) ? 0 : value))
    delete node.translation
    delete node.rotation
    delete node.scale
    return
  }
  const position = new THREE.Vector3()
  const rotation = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(position, rotation, scale)
  if (![position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, scale.x, scale.y, scale.z].every(Number.isFinite)) {
    fail(`${context} cannot be decomposed into finite TRS`)
  }
  rotation.normalize()
  if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w)
  node.translation = [position.x, position.y, position.z].map((value) => (Object.is(value, -0) ? 0 : value))
  node.rotation = [rotation.x, rotation.y, rotation.z, rotation.w].map((value) =>
    Object.is(value, -0) ? 0 : value
  )
  node.scale = [scale.x, scale.y, scale.z].map((value) => (Object.is(value, -0) ? 0 : value))
  delete node.matrix
}

function rewriteNodeRests(
  gltf: JsonRecord,
  parsed: SemanticGlbDocument,
  evaluation: AppearanceRecipePhysicalEvaluation
): void {
  const active = activeSceneOrder(parsed)
  const nodes = array(gltf.nodes, 'gltf.nodes')
  const evaluatedByNode = new Map(
    evaluation.nodes.map((node) => {
      const match = /^node:([0-9]+)$/.exec(node.id)
      if (!match) fail(`physical node id ${node.id} is malformed`)
      return [integer(Number(match[1]), `physical node ${node.id}`), node.localMatrix] as const
    })
  )
  const rootTransform = new THREE.Matrix4().fromArray(matrixArray(evaluation.root.matrix, 'evaluated root matrix'))
  const rootChanges = matrixMaximumError(evaluation.root.matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) > MATRIX_EPSILON
  if (rootChanges) {
    const roots = new Set(active.roots)
    for (const [animationIndex, animationValue] of optionalArray(gltf.animations, 'gltf.animations').entries()) {
      const animation = record(animationValue, `gltf.animations[${animationIndex}]`)
      for (const channelValue of array(animation.channels, `gltf.animations[${animationIndex}].channels`)) {
        const target = record(record(channelValue, 'animation channel').target, 'animation channel target')
        if (target.node !== undefined && roots.has(integer(target.node, 'animation target node'))) {
          fail('root scale/grounding cannot be baked over an embedded animation targeting an active scene root')
        }
      }
    }
  }
  for (const nodeIndex of active.order) {
    const node = record(nodes[nodeIndex], `gltf.nodes[${nodeIndex}]`)
    const evaluated = evaluatedByNode.get(nodeIndex)
    if (!evaluated) fail(`physical evaluation omitted active node ${nodeIndex}`)
    let expected = new THREE.Matrix4().fromArray(matrixArray(evaluated, `evaluated node ${nodeIndex}`))
    if (active.roots.includes(nodeIndex)) expected = rootTransform.clone().multiply(expected)
    const original = resolveSemanticGlbNodeTransform(
      parsed.nodes[nodeIndex]!,
      `gltf.nodes[${nodeIndex}]`,
      { diagnosticPrefix: LIVE_GOON_BAKER_ID }
    ).matrix
    if (matrixMaximumError(original, expected.elements) > MATRIX_EPSILON) {
      writeNodeMatrix(node, expected.elements, `gltf.nodes[${nodeIndex}] baked matrix`)
    }
  }
}

function collectReferencedAccessors(gltf: JsonRecord): Set<number> {
  const references = new Set<number>()
  const add = (value: unknown, context: string) => references.add(integer(value, context))
  for (const [meshIndex, meshValue] of optionalArray(gltf.meshes, 'gltf.meshes').entries()) {
    const mesh = record(meshValue, `gltf.meshes[${meshIndex}]`)
    for (const [primitiveIndex, primitiveValue] of array(mesh.primitives, `gltf.meshes[${meshIndex}].primitives`).entries()) {
      const primitive = record(primitiveValue, `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`)
      if (primitive.indices !== undefined) add(primitive.indices, 'primitive.indices')
      for (const value of Object.values(record(primitive.attributes, 'primitive.attributes'))) add(value, 'attribute')
      for (const targetValue of optionalArray(primitive.targets, 'primitive.targets')) {
        for (const value of Object.values(record(targetValue, 'primitive target'))) add(value, 'target attribute')
      }
    }
  }
  for (const [skinIndex, skinValue] of optionalArray(gltf.skins, 'gltf.skins').entries()) {
    const skin = record(skinValue, `gltf.skins[${skinIndex}]`)
    if (skin.inverseBindMatrices !== undefined) add(skin.inverseBindMatrices, 'skin.inverseBindMatrices')
  }
  for (const [animationIndex, animationValue] of optionalArray(gltf.animations, 'gltf.animations').entries()) {
    const animation = record(animationValue, `gltf.animations[${animationIndex}]`)
    for (const samplerValue of array(animation.samplers, `gltf.animations[${animationIndex}].samplers`)) {
      const sampler = record(samplerValue, 'animation sampler')
      add(sampler.input, 'animation sampler input')
      add(sampler.output, 'animation sampler output')
    }
  }
  return references
}

function remapAccessorReferences(gltf: JsonRecord, mapping: Map<number, number>): void {
  const remap = (value: unknown, context: string) => {
    const source = integer(value, context)
    const target = mapping.get(source)
    if (target === undefined) fail(`${context} references removed accessor ${source}`)
    return target
  }
  for (const meshValue of optionalArray(gltf.meshes, 'gltf.meshes')) {
    const mesh = record(meshValue, 'mesh')
    for (const primitiveValue of array(mesh.primitives, 'mesh.primitives')) {
      const primitive = record(primitiveValue, 'primitive')
      if (primitive.indices !== undefined) primitive.indices = remap(primitive.indices, 'primitive.indices')
      const attributes = record(primitive.attributes, 'primitive.attributes')
      for (const key of Object.keys(attributes)) attributes[key] = remap(attributes[key], `attribute ${key}`)
      for (const targetValue of optionalArray(primitive.targets, 'primitive.targets')) {
        const target = record(targetValue, 'primitive target')
        for (const key of Object.keys(target)) target[key] = remap(target[key], `target ${key}`)
      }
    }
  }
  for (const skinValue of optionalArray(gltf.skins, 'gltf.skins')) {
    const skin = record(skinValue, 'skin')
    if (skin.inverseBindMatrices !== undefined) {
      skin.inverseBindMatrices = remap(skin.inverseBindMatrices, 'skin.inverseBindMatrices')
    }
  }
  for (const animationValue of optionalArray(gltf.animations, 'gltf.animations')) {
    const animation = record(animationValue, 'animation')
    for (const samplerValue of array(animation.samplers, 'animation.samplers')) {
      const sampler = record(samplerValue, 'animation sampler')
      sampler.input = remap(sampler.input, 'animation input')
      sampler.output = remap(sampler.output, 'animation output')
    }
  }
}

function accessorBufferViews(accessor: JsonRecord, context: string): number[] {
  const views: number[] = []
  if (accessor.bufferView !== undefined) views.push(integer(accessor.bufferView, `${context}.bufferView`))
  if (accessor.sparse !== undefined) {
    const sparse = record(accessor.sparse, `${context}.sparse`)
    views.push(integer(record(sparse.indices, `${context}.sparse.indices`).bufferView, `${context}.sparse.indices.bufferView`))
    views.push(integer(record(sparse.values, `${context}.sparse.values`).bufferView, `${context}.sparse.values.bufferView`))
  }
  return views
}

function remapAccessorBufferViews(accessor: JsonRecord, mapping: Map<number, number>, context: string): void {
  const remap = (value: unknown, path: string) => {
    const source = integer(value, path)
    const target = mapping.get(source)
    if (target === undefined) fail(`${path} references removed bufferView ${source}`)
    return target
  }
  if (accessor.bufferView !== undefined) accessor.bufferView = remap(accessor.bufferView, `${context}.bufferView`)
  if (accessor.sparse !== undefined) {
    const sparse = record(accessor.sparse, `${context}.sparse`)
    const indices = record(sparse.indices, `${context}.sparse.indices`)
    const values = record(sparse.values, `${context}.sparse.values`)
    indices.bufferView = remap(indices.bufferView, `${context}.sparse.indices.bufferView`)
    values.bufferView = remap(values.bufferView, `${context}.sparse.values.bufferView`)
  }
}

function compactGlbResources(
  gltf: JsonRecord,
  parsed: SemanticGlbDocument,
  accessorOverrides: Map<number, AccessorOverride>
): Uint8Array {
  const sourceAccessors = optionalArray(parsed.gltf.accessors, 'source gltf.accessors')
  const sourceViews = optionalArray(parsed.gltf.bufferViews, 'source gltf.bufferViews')
  const referencedAccessors = [...collectReferencedAccessors(gltf)].sort((left, right) => left - right)
  for (const accessorIndex of referencedAccessors) {
    if (accessorIndex >= sourceAccessors.length) fail(`referenced accessor ${accessorIndex} is out of range`)
  }
  const referencedOriginalViews = new Set<number>()
  for (const accessorIndex of referencedAccessors) {
    if (accessorOverrides.has(accessorIndex)) continue
    const accessor = record(sourceAccessors[accessorIndex], `gltf.accessors[${accessorIndex}]`)
    accessorBufferViews(accessor, `gltf.accessors[${accessorIndex}]`).forEach((view) => referencedOriginalViews.add(view))
  }
  for (const [imageIndex, imageValue] of optionalArray(gltf.images, 'gltf.images').entries()) {
    const image = record(imageValue, `gltf.images[${imageIndex}]`)
    if (image.bufferView !== undefined) referencedOriginalViews.add(integer(image.bufferView, `gltf.images[${imageIndex}].bufferView`))
  }
  const originalViewIndexes = [...referencedOriginalViews].sort((left, right) => left - right)
  for (const viewIndex of originalViewIndexes) {
    if (viewIndex >= sourceViews.length) fail(`referenced bufferView ${viewIndex} is out of range`)
  }

  const chunks: Array<{ bytes: Uint8Array; view: JsonRecord; original?: number; override?: number }> = []
  for (const viewIndex of originalViewIndexes) {
    const source = record(sourceViews[viewIndex], `gltf.bufferViews[${viewIndex}]`)
    const byteOffset = integer(source.byteOffset ?? 0, `gltf.bufferViews[${viewIndex}].byteOffset`)
    const byteLength = integer(source.byteLength, `gltf.bufferViews[${viewIndex}].byteLength`)
    if (byteOffset > parsed.binary.byteLength || byteLength > parsed.binary.byteLength - byteOffset) {
      fail(`gltf.bufferViews[${viewIndex}] exceeds the source binary`)
    }
    const view = cloneJson(source)
    view.buffer = 0
    chunks.push({
      bytes: parsed.binary.subarray(byteOffset, byteOffset + byteLength),
      view,
      original: viewIndex
    })
  }
  for (const accessorIndex of referencedAccessors) {
    const override = accessorOverrides.get(accessorIndex)
    if (!override) continue
    const sourceAccessor = record(sourceAccessors[accessorIndex], `gltf.accessors[${accessorIndex}]`)
    let target: unknown
    if (sourceAccessor.bufferView !== undefined) {
      target = record(sourceViews[integer(sourceAccessor.bufferView, 'override source bufferView')], 'override source bufferView').target
    }
    chunks.push({
      bytes: uint8View(override.values),
      view: {
        buffer: 0,
        byteLength: override.values.byteLength,
        ...(target === undefined ? {} : { target })
      },
      override: accessorIndex
    })
  }

  let binaryLength = 0
  for (const chunk of chunks) binaryLength = align4(binaryLength) + chunk.bytes.byteLength
  const binary = new Uint8Array(binaryLength)
  const newViews: JsonRecord[] = []
  const viewMapping = new Map<number, number>()
  const overrideView = new Map<number, number>()
  let offset = 0
  for (const chunk of chunks) {
    offset = align4(offset)
    binary.set(chunk.bytes, offset)
    const view = chunk.view
    view.byteOffset = offset
    view.byteLength = chunk.bytes.byteLength
    const index = newViews.length
    newViews.push(view)
    if (chunk.original !== undefined) viewMapping.set(chunk.original, index)
    if (chunk.override !== undefined) overrideView.set(chunk.override, index)
    offset += chunk.bytes.byteLength
  }

  const accessorMapping = new Map<number, number>()
  const newAccessors = referencedAccessors.map((sourceIndex, newIndex) => {
    accessorMapping.set(sourceIndex, newIndex)
    const accessor = cloneJson(record(sourceAccessors[sourceIndex], `gltf.accessors[${sourceIndex}]`))
    const override = accessorOverrides.get(sourceIndex)
    if (override) {
      accessor.bufferView = overrideView.get(sourceIndex)!
      accessor.byteOffset = 0
      accessor.componentType = 5126
      accessor.count = override.count
      accessor.type = override.type
      delete accessor.normalized
      delete accessor.sparse
      if (override.min) accessor.min = override.min
      else delete accessor.min
      if (override.max) accessor.max = override.max
      else delete accessor.max
    } else {
      remapAccessorBufferViews(accessor, viewMapping, `gltf.accessors[${sourceIndex}]`)
    }
    return accessor
  })
  remapAccessorReferences(gltf, accessorMapping)
  for (const [imageIndex, imageValue] of optionalArray(gltf.images, 'gltf.images').entries()) {
    const image = record(imageValue, `gltf.images[${imageIndex}]`)
    if (image.bufferView === undefined) continue
    const source = integer(image.bufferView, `gltf.images[${imageIndex}].bufferView`)
    const target = viewMapping.get(source)
    if (target === undefined) fail(`image ${imageIndex} references removed bufferView ${source}`)
    image.bufferView = target
  }
  gltf.accessors = newAccessors
  gltf.bufferViews = newViews
  const sourceBuffers = array(parsed.gltf.buffers, 'gltf.buffers')
  const buffer = cloneJson(record(sourceBuffers[0], 'gltf.buffers[0]'))
  buffer.byteLength = binary.byteLength
  delete buffer.uri
  gltf.buffers = [buffer]
  return binary
}

function buildStructuralLiveGlb(
  sourceModelBytes: Uint8Array,
  rawManifest: JsonRecord,
  appearanceManifest: AppearanceManifest,
  resolved: ReturnType<typeof resolveStrictAppearanceRecipeSnapshot>['resolved'],
  evaluation: AppearanceRecipePhysicalEvaluation
): StructuralRewrite {
  const parsed = parseSemanticGlb(sourceModelBytes, { diagnosticPrefix: LIVE_GOON_BAKER_ID })
  validateStructuralExtensions(parsed)
  const gltf = cloneJson(parsed.gltf)
  const accessorOverrides = new Map<number, AccessorOverride>()
  const morphPlan = buildMorphPlan(parsed, rawManifest, appearanceManifest, resolved)
  rewriteMorphTargets(gltf, parsed, morphPlan, accessorOverrides)
  addPhysicalOverrides(gltf, parsed, evaluation, accessorOverrides)
  const binary = compactGlbResources(gltf, parsed, accessorOverrides)
  const bytes = writeGlb(gltf, binary)

  let meshesProcessed = 0
  let verticesProcessed = 0
  let morphTargetsProcessed = 0
  const active = activeSceneOrder(parsed)
  for (const nodeIndex of active.order) {
    const node = getSemanticGlbNode(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`)
    if (node.mesh === undefined) continue
    const mesh = getSemanticGlbMesh(parsed, node.mesh, `gltf.nodes[${nodeIndex}].mesh`)
    for (const primitiveValue of array(mesh.primitives, 'mesh.primitives')) {
      const primitive = record(primitiveValue, 'mesh primitive')
      const position = inspectSemanticGlbAccessor(parsed, record(primitive.attributes, 'primitive.attributes').POSITION)
      meshesProcessed += 1
      verticesProcessed += position.count
      morphTargetsProcessed += optionalArray(primitive.targets, 'primitive.targets').length
    }
  }
  const counts: GoonLiveBuildOutputCounts = {
    meshes: meshesProcessed,
    vertices: verticesProcessed,
    nodes: active.order.length,
    bones: evaluation.jointRests.length,
    morphTargets: morphPlan.keptRefs.length,
    dynamicMorphTargets: morphPlan.dynamicRefs.length,
    correctiveMorphTargets: morphPlan.correctiveRefs.length,
    recipeMorphTargets: 0
  }
  return {
    bytes,
    morphPlan,
    counts,
    cost: {
      inputBytes: sourceModelBytes.byteLength,
      meshesProcessed,
      verticesProcessed,
      morphTargetsProcessed
    }
  }
}

function parseJsonManifestBytes(bytes: Uint8Array): JsonRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(DECODER.decode(exactBytes(bytes, 'avatar.json bytes')))
  } catch {
    fail('avatar.json must be strict UTF-8 JSON')
  }
  return record(parsed, 'avatar.json')
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function strictStoredZipEntries(packageBytes: Uint8Array): Map<string, Uint8Array> {
  exactBytes(packageBytes, 'Live package bytes')
  if (packageBytes.byteLength < 22) fail('Live package is too small to be a ZIP')
  const view = new DataView(packageBytes.buffer, packageBytes.byteOffset, packageBytes.byteLength)
  const eocdOffset = packageBytes.byteLength - 22
  if (view.getUint32(eocdOffset, true) !== 0x06054b50) {
    fail('Live package must end with one deterministic ZIP32 directory')
  }
  if (
    view.getUint16(eocdOffset + 4, true) !== 0 ||
    view.getUint16(eocdOffset + 6, true) !== 0 ||
    view.getUint16(eocdOffset + 20, true) !== 0
  ) {
    fail('Live package may not use multi-disk ZIPs or comments')
  }
  const entryCount = view.getUint16(eocdOffset + 8, true)
  if (entryCount !== view.getUint16(eocdOffset + 10, true) || entryCount !== 2) {
    fail('Live package must contain exactly avatar.glb and avatar.json')
  }
  const centralSize = view.getUint32(eocdOffset + 12, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)
  if (centralOffset + centralSize !== eocdOffset) fail('Live package central directory is malformed')
  const result = new Map<string, Uint8Array>()
  const localRanges: Array<[number, number]> = []
  let cursor = centralOffset
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > eocdOffset || view.getUint32(cursor, true) !== 0x02014b50) {
      fail(`Live package central entry ${entryIndex} is malformed`)
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    if (flags !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      fail('Live package entries must use deterministic stored ZIP encoding')
    }
    if (extraLength !== 0 || commentLength !== 0 || cursor + 46 + nameLength > eocdOffset) {
      fail(`Live package central entry ${entryIndex} contains unsupported metadata`)
    }
    const name = DECODER.decode(packageBytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (!['avatar.glb', 'avatar.json'].includes(name) || result.has(name)) {
      fail(`Live package contains invalid or duplicate entry ${name}`)
    }
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) {
      fail(`Live package local entry ${name} is malformed`)
    }
    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localCrc = view.getUint32(localOffset + 14, true)
    const localCompressedSize = view.getUint32(localOffset + 18, true)
    const localUncompressedSize = view.getUint32(localOffset + 22, true)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataOffset + uncompressedSize
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localCrc !== crc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
      localExtraLength !== 0 ||
      dataEnd > centralOffset
    ) {
      fail(`Live package local entry ${name} disagrees with its directory record`)
    }
    const localName = DECODER.decode(
      packageBytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    )
    if (localName !== name) fail(`Live package local entry name ${localName} disagrees with ${name}`)
    const bytes = packageBytes.subarray(dataOffset, dataEnd)
    if (crc32(bytes) !== crc) fail(`Live package entry ${name} failed CRC validation`)
    result.set(name, bytes)
    localRanges.push([localOffset, dataEnd])
    cursor += 46 + nameLength
  }
  if (cursor !== eocdOffset) fail('Live package central directory contains trailing records')
  localRanges.sort((left, right) => left[0] - right[0])
  if (localRanges[0]?.[0] !== 0 || localRanges[0]?.[1] !== localRanges[1]?.[0] || localRanges[1]?.[1] !== centralOffset) {
    fail('Live package local entries are not contiguous and canonical')
  }
  return result
}

function maximumArrayError(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY
  let maximum = 0
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(left[index]! - right[index]!))
  }
  return maximum
}

function matrixComponents(matrixValue: readonly number[]) {
  const matrix = new THREE.Matrix4().fromArray(matrixArray(matrixValue, 'matrix metrics'))
  const translation = new THREE.Vector3()
  const rotation = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(translation, rotation, scale)
  rotation.normalize()
  return { translation, rotation, scale }
}

function matrixMetricErrors(left: readonly number[], right: readonly number[]) {
  const a = matrixComponents(left)
  const b = matrixComponents(right)
  const dot = Math.min(1, Math.abs(a.rotation.dot(b.rotation)))
  return {
    translation: a.translation.distanceTo(b.translation),
    scale: Math.max(
      Math.abs(a.scale.x - b.scale.x),
      Math.abs(a.scale.y - b.scale.y),
      Math.abs(a.scale.z - b.scale.z)
    ),
    rotation: 2 * Math.acos(dot)
  }
}

function worldMatrices(parsed: SemanticGlbDocument): Map<number, THREE.Matrix4> {
  const active = activeSceneOrder(parsed)
  const result = new Map<number, THREE.Matrix4>()
  for (const nodeIndex of active.order) {
    const local = new THREE.Matrix4().fromArray(
      resolveSemanticGlbNodeTransform(parsed.nodes[nodeIndex]!, `gltf.nodes[${nodeIndex}]`, {
        diagnosticPrefix: LIVE_GOON_BAKER_ID
      }).matrix
    )
    const parent = parsed.parents.get(nodeIndex)
    result.set(nodeIndex, parent === undefined ? local : result.get(parent)!.clone().multiply(local))
  }
  return result
}

function inventoryMorphRefs(parsed: SemanticGlbDocument): string[] {
  const refs: string[] = []
  for (const nodeIndex of activeSceneOrder(parsed).order) {
    const node = getSemanticGlbNode(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`)
    if (node.mesh === undefined) continue
    const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`)
    const mesh = getSemanticGlbMesh(parsed, meshIndex, `gltf.meshes[${meshIndex}]`)
    for (const name of morphTargetNames(mesh, `gltf.meshes[${meshIndex}]`)) {
      refs.push(morphRef(parsed, nodeIndex, name))
    }
  }
  return [...new Set(refs)].sort(compareText)
}

function verifySocketEyeLiveMorphInventory(
  parsed: SemanticGlbDocument,
  manifest: JsonRecord
): void {
  const rawSurface = manifest.socketEyeSurface
  const rawSeam = manifest.eyeApertureSeam
  if (rawSurface === undefined && rawSeam === undefined) return
  if (rawSurface === undefined || rawSeam === undefined) {
    fail('Live socket-eye package must retain both socketEyeSurface and eyeApertureSeam')
  }
  const surface = parseSocketEyeSurfaceDefinition(rawSurface)
  const seam = parseEyeApertureSeamDefinition(rawSeam)
  validateSocketEyeApertureOwnership(surface, seam)

  for (const side of ['left', 'right'] as const) {
    const nodes = [
      {
        nodeName: surface.runtimeBindings[side].nodes.compositeCap,
        expected: socketEyeCapRetainedDynamicMorphs(side).sort(compareText)
      },
      {
        nodeName: seam.runtimeBindings[side].lashesEyeOutlineNode,
        expected: [...seam.runtimeBindings[side].liner.retainedPerformanceMorphs].sort(compareText)
      }
    ]
    for (const { nodeName, expected } of nodes) {
      const nodeIndex = resolveSemanticGlbNode(
        parsed,
        nodeName,
        `Live socket-eye ${side} node ${nodeName}`
      )
      const node = getSemanticGlbNode(parsed, nodeIndex, `Live socket-eye node ${nodeName}`)
      if (node.mesh === undefined) fail(`Live socket-eye node ${nodeName} has no mesh`)
      const meshIndex = integer(node.mesh, `Live socket-eye node ${nodeName}.mesh`)
      const mesh = getSemanticGlbMesh(parsed, meshIndex, `Live socket-eye mesh ${nodeName}`)
      const actual = morphTargetNames(mesh, `Live socket-eye mesh ${nodeName}`).sort(compareText)
      if (canonicalRecipeString(actual) !== canonicalRecipeString(expected)) {
        fail(
          `Live socket-eye node ${nodeName} must retain exactly ${expected.join(', ')}`
        )
      }
    }
  }
}

async function typedValuesSha256(values: ArrayLike<number>): Promise<string> {
  const normalized = new Float64Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = Object.is(values[index], -0) ? 0 : values[index]!
  }
  return sha256Hex(new Uint8Array(normalized.buffer))
}

async function retainedMorphProof(
  source: SemanticGlbDocument,
  output: SemanticGlbDocument,
  plan: MorphPlan
): Promise<{ sha256: string; maxError: number }> {
  const entries: Array<Record<string, unknown>> = []
  let maxError = 0
  for (const [meshIndex, keepIndexes] of [...plan.keepIndexesByMesh.entries()].sort((a, b) => a[0] - b[0])) {
    const sourceMesh = getSemanticGlbMesh(source, meshIndex, `source mesh ${meshIndex}`)
    const outputMesh = getSemanticGlbMesh(output, meshIndex, `output mesh ${meshIndex}`)
    const sourcePrimitives = array(sourceMesh.primitives, `source mesh ${meshIndex}.primitives`)
    const outputPrimitives = array(outputMesh.primitives, `output mesh ${meshIndex}.primitives`)
    if (sourcePrimitives.length !== outputPrimitives.length) fail(`mesh ${meshIndex} primitive count changed`)
    for (let primitiveIndex = 0; primitiveIndex < sourcePrimitives.length; primitiveIndex += 1) {
      const sourceTargets = optionalArray(
        record(sourcePrimitives[primitiveIndex], 'source primitive').targets,
        'source primitive targets'
      )
      const outputTargets = optionalArray(
        record(outputPrimitives[primitiveIndex], 'output primitive').targets,
        'output primitive targets'
      )
      if (outputTargets.length !== keepIndexes.length) fail(`mesh ${meshIndex} retained target count changed`)
      for (const [outputIndex, sourceIndex] of keepIndexes.entries()) {
        const sourceTarget = record(sourceTargets[sourceIndex], 'source morph target')
        const outputTarget = record(outputTargets[outputIndex], 'output morph target')
        const semantics = Object.keys(sourceTarget).sort(compareText)
        if (canonicalRecipeString(semantics) !== canonicalRecipeString(Object.keys(outputTarget).sort(compareText))) {
          fail(`mesh ${meshIndex} retained morph ${sourceIndex} attribute semantics changed`)
        }
        for (const semantic of semantics) {
          const left = decodeSemanticGlbAccessor(source, sourceTarget[semantic])
          const right = decodeSemanticGlbAccessor(output, outputTarget[semantic])
          if (
            left.count !== right.count ||
            left.components !== right.components ||
            left.componentType !== right.componentType ||
            left.type !== right.type ||
            left.normalized !== right.normalized
          ) {
            fail(`mesh ${meshIndex} retained morph ${sourceIndex}/${semantic} accessor shape changed`)
          }
          maxError = Math.max(maxError, maximumArrayError(left.values, right.values))
          entries.push({
            meshIndex,
            primitiveIndex,
            sourceIndex,
            outputIndex,
            semantic,
            valuesSha256: await typedValuesSha256(right.values)
          })
        }
      }
    }
  }
  return { sha256: await canonicalRecipeSha256(entries), maxError }
}

function materialProjectionForComparison(
  projection: Awaited<ReturnType<typeof buildAppearanceRecipeSemanticMaterialProof>>,
  retainedMorphNames: Set<string>
) {
  return {
    materials: projection.materials,
    primitives: projection.primitives
      .map((primitive) => ({
        materialSha256: primitive.materialSha256,
        shadingAccessors: primitive.shadingAccessors.filter(
          (accessor) => accessor.target === null || retainedMorphNames.has(accessor.target)
        )
      }))
      .sort((left, right) => compareText(canonicalRecipeString(left), canonicalRecipeString(right)))
  }
}

async function auditStructuralLiveGlb(
  sourceModelBytes: Uint8Array,
  outputModelBytes: Uint8Array,
  rawManifest: JsonRecord,
  evaluation: AppearanceRecipePhysicalEvaluation,
  rewrite: StructuralRewrite
): Promise<StructuralAudit> {
  const source = parseSemanticGlb(sourceModelBytes, { diagnosticPrefix: `${LIVE_GOON_BAKER_ID}:source-audit` })
  const output = parseSemanticGlb(outputModelBytes, { diagnosticPrefix: `${LIVE_GOON_BAKER_ID}:output-audit` })
  const liveMorphTargets = inventoryMorphRefs(output)
  if (canonicalRecipeString(liveMorphTargets) !== canonicalRecipeString(rewrite.morphPlan.keptRefs)) {
    fail('re-imported Live morph inventory differs from the bake plan')
  }
  const removedRefs = new Set(rewrite.morphPlan.removedRefs)
  for (const ref of liveMorphTargets) {
    if (removedRefs.has(ref)) {
      fail(`Recipe-only morph ${ref} survived the Live re-import`)
    }
  }

  let maxVertexErrorMeters = 0
  let maxNodeTranslationErrorMeters = 0
  let maxScaleError = 0
  let maxRotationErrorRadians = 0
  let maxJointErrorMeters = 0
  let maxPivotErrorMeters = 0
  let maxFinalPositionErrorMeters = 0
  let maxWeightScalarError = 0
  let finalSquaredError = 0
  let finalSamples = 0
  const active = activeSceneOrder(output)
  const outputWorld = worldMatrices(output)
  const evaluationNodes = new Map(evaluation.nodes.map((node) => [node.id, node]))
  const roots = new Set(active.roots)
  for (const nodeIndex of active.order) {
    const evaluationNode = evaluationNodes.get(`node:${nodeIndex}`)
    if (!evaluationNode) fail(`physical evaluation omitted node:${nodeIndex}`)
    const outputLocal = resolveSemanticGlbNodeTransform(output.nodes[nodeIndex]!, `output node ${nodeIndex}`, {
      diagnosticPrefix: LIVE_GOON_BAKER_ID
    }).matrix
    const expectedLocal = roots.has(nodeIndex)
      ? new THREE.Matrix4().fromArray(evaluation.root.matrix).multiply(
          new THREE.Matrix4().fromArray(evaluationNode.localMatrix)
        ).elements
      : evaluationNode.localMatrix
    const metrics = matrixMetricErrors(outputLocal, expectedLocal)
    maxNodeTranslationErrorMeters = Math.max(maxNodeTranslationErrorMeters, metrics.translation)
    maxScaleError = Math.max(maxScaleError, metrics.scale)
    maxRotationErrorRadians = Math.max(maxRotationErrorRadians, metrics.rotation)
    const worldMetrics = matrixMetricErrors(outputWorld.get(nodeIndex)!.elements, evaluationNode.worldMatrix)
    maxNodeTranslationErrorMeters = Math.max(maxNodeTranslationErrorMeters, worldMetrics.translation)
    maxScaleError = Math.max(maxScaleError, worldMetrics.scale)
    maxRotationErrorRadians = Math.max(maxRotationErrorRadians, worldMetrics.rotation)
  }

  const meshes = array(output.gltf.meshes, 'output gltf.meshes')
  for (const mesh of evaluation.meshes) {
    const match = /^mesh:([0-9]+):([0-9]+)$/.exec(mesh.id)
    if (!match) fail(`physical mesh id ${mesh.id} is malformed during audit`)
    const nodeIndex = Number(match[1])
    const primitiveIndex = Number(match[2])
    const node = output.nodes[nodeIndex]!
    const gltfMesh = record(meshes[integer(node.mesh, `output node ${nodeIndex}.mesh`)], 'output mesh')
    const primitive = record(array(gltfMesh.primitives, 'output mesh primitives')[primitiveIndex], 'output primitive')
    const positions = decodeSemanticGlbAccessor(output, record(primitive.attributes, 'output attributes').POSITION)
    maxVertexErrorMeters = Math.max(maxVertexErrorMeters, maximumArrayError(mesh.positions, positions.values))
    const expectedNode = evaluationNodes.get(mesh.nodeId)
    if (!expectedNode) fail(`physical mesh ${mesh.id} references missing ${mesh.nodeId}`)
    const expectedWorld = new THREE.Matrix4().fromArray(expectedNode.worldMatrix)
    const actualWorld = outputWorld.get(nodeIndex)!
    const expectedPoint = new THREE.Vector3()
    const actualPoint = new THREE.Vector3()
    for (let scalar = 0; scalar < positions.values.length; scalar += 3) {
      expectedPoint.set(mesh.positions[scalar]!, mesh.positions[scalar + 1]!, mesh.positions[scalar + 2]!).applyMatrix4(expectedWorld)
      actualPoint.set(positions.values[scalar]!, positions.values[scalar + 1]!, positions.values[scalar + 2]!).applyMatrix4(actualWorld)
      const error = expectedPoint.distanceTo(actualPoint)
      maxFinalPositionErrorMeters = Math.max(maxFinalPositionErrorMeters, error)
      finalSquaredError += error * error
      finalSamples += 1
    }
  }

  for (const binding of evaluation.retainedTargetPositionBindings) {
    const match = /^mesh:([0-9]+):[0-9]+$/.exec(binding.meshId)
    if (!match) fail(`retained binding ${binding.id} has malformed mesh id ${binding.meshId}`)
    const nodeIndex = Number(match[1])
    const node = output.nodes[nodeIndex]!
    const mesh = record(meshes[integer(node.mesh, `retained binding ${binding.id} mesh`)], 'retained mesh')
    const names = morphTargetNames(mesh, `retained binding ${binding.id} mesh`)
    const morphIndex = names.indexOf(binding.morph)
    if (morphIndex < 0) fail(`retained binding ${binding.id} morph is absent after re-import`)
    const weights =
      node.weights === undefined
        ? mesh.weights === undefined
          ? names.map(() => 0)
          : array(mesh.weights, 'retained mesh weights')
        : array(node.weights, `retained node ${nodeIndex} weights`)
    if (weights.length !== names.length) fail(`retained binding ${binding.id} weights are misaligned`)
    maxWeightScalarError = Math.max(
      maxWeightScalarError,
      Math.abs(finite(weights[morphIndex], `retained binding ${binding.id} weight`) - binding.weight)
    )
  }

  const outputSkins = array(output.gltf.skins ?? [], 'output gltf.skins')
  for (const skinOutput of evaluation.skins) {
    const match = /^skin:[0-9]+:([0-9]+)$/.exec(skinOutput.id)
    if (!match) fail(`physical skin id ${skinOutput.id} is malformed during audit`)
    const skinIndex = Number(match[1])
    const skin = record(outputSkins[skinIndex], `output skin ${skinIndex}`)
    const inverse = decodeSemanticGlbAccessor(output, skin.inverseBindMatrices)
    skinOutput.joints.forEach((joint, jointIndex) => {
      maxJointErrorMeters = Math.max(
        maxJointErrorMeters,
        maximumArrayError(joint.inverseBindMatrix, inverse.values.subarray(jointIndex * 16, jointIndex * 16 + 16))
      )
    })
  }
  for (const joint of evaluation.jointRests) {
    const match = /^node:([0-9]+)$/.exec(joint.nodeId)
    if (!match) fail(`joint ${joint.bone} has malformed node id ${joint.nodeId}`)
    const outputLocal = resolveSemanticGlbNodeTransform(output.nodes[Number(match[1])]!, `joint ${joint.bone}`, {
      diagnosticPrefix: LIVE_GOON_BAKER_ID
    }).matrix
    maxJointErrorMeters = Math.max(maxJointErrorMeters, matrixMetricErrors(outputLocal, joint.localMatrix).translation)
  }
  for (const role of evaluation.roles) {
    const match = /^node:([0-9]+)$/.exec(role.nodeId)
    if (!match) fail(`role ${role.id} has malformed node id ${role.nodeId}`)
    const actual = new THREE.Vector3().setFromMatrixPosition(outputWorld.get(Number(match[1]))!)
    const error = actual.distanceTo(new THREE.Vector3(...role.worldPosition))
    if (role.kind === 'eye' || role.kind === 'stage') maxPivotErrorMeters = Math.max(maxPivotErrorMeters, error)
  }

  const retained = await retainedMorphProof(source, output, rewrite.morphPlan)
  const retainedNames = new Set([...rewrite.morphPlan.outputNamesByMesh.values()].flatMap((names) => names))
  const [sourceMaterials, outputMaterials] = await Promise.all([
    buildAppearanceRecipeSemanticMaterialProof(source),
    buildAppearanceRecipeSemanticMaterialProof(output)
  ])
  const sourceMaterialProjection = materialProjectionForComparison(sourceMaterials, retainedNames)
  const outputMaterialProjection = materialProjectionForComparison(outputMaterials, retainedNames)
  if (canonicalRecipeString(sourceMaterialProjection) !== canonicalRecipeString(outputMaterialProjection)) {
    fail('material, texture, UV, or retained morph shading semantics changed during Live baking')
  }
  const materialProofSha256 = await canonicalRecipeSha256(outputMaterialProjection)
  const rootMetrics = matrixMetricErrors(
    outputWorld.get(active.roots[0]!)!.elements,
    evaluationNodes.get(`node:${active.roots[0]}`)!.worldMatrix
  )
  const maxGroundingErrorMeters = Math.abs(rootMetrics.translation)
  const validation: GoonLiveBuildValidation = {
    maxWeightScalarError: Math.max(retained.maxError, maxWeightScalarError),
    maxVertexErrorMeters,
    maxJointErrorMeters,
    maxNodeTranslationErrorMeters,
    maxPivotErrorMeters,
    maxScaleError,
    maxRotationErrorRadians,
    maxGroundingErrorMeters,
    maxFinalPositionErrorMeters,
    rmsFinalPositionErrorMeters: finalSamples === 0 ? 0 : Math.sqrt(finalSquaredError / finalSamples)
  }
  const hashedMeshes = await Promise.all(
    evaluation.meshes.map(async (mesh) => ({ id: mesh.id, sha256: await sha256Hex(uint8View(mesh.positions)) }))
  )
  const rig = rawManifest.rig === undefined ? null : record(rawManifest.rig, 'avatar.json#rig')
  const proofsWithoutValidation = {
    neutralPositionSha256: await canonicalRecipeSha256(hashedMeshes),
    skeletonRestSha256: await canonicalRecipeSha256({
      joints: evaluation.jointRests,
      skins: evaluation.skins
    }),
    followerSha256: await canonicalRecipeSha256({
      morphWeights: evaluation.followerMorphWeights,
      nodes: evaluation.nodes
    }),
    rootSha256: await canonicalRecipeSha256(evaluation.root),
    groundingSha256: await canonicalRecipeSha256({
      rootPosition: evaluation.root.position,
      soleOffsetY: evaluation.root.soleOffsetY
    }),
    performanceSha256: await canonicalRecipeSha256(rig?.performance ?? null),
    pivotSha256: await canonicalRecipeSha256(
      evaluation.roles.filter((role) => role.kind === 'eye' || role.kind === 'stage')
    ),
    attachmentSha256: await canonicalRecipeSha256(
      evaluation.roles.filter((role) => role.kind === 'attachment')
    )
  }
  const proofs: GoonLiveBuildEvidenceProofs = {
    ...proofsWithoutValidation,
    validationReportSha256: await canonicalRecipeSha256(validation)
  }
  const report = {
    contract: 'goon-live-bake-audit/v1' as const,
    materialProofSha256,
    retainedMorphProofSha256: retained.sha256,
    liveMorphTargets,
    removedMorphTargets: rewrite.morphPlan.removedRefs,
    recipeMorphTargets: 0 as const,
    maximumErrors: validation
  }
  return {
    validation,
    proofs,
    audit: { ...report, reportSha256: await canonicalRecipeSha256(report) }
  }
}

function createLiveAvatarManifest(
  sourceManifest: JsonRecord,
  liveManifest: GoonLiveManifest,
  liveCorrectives: LiveJointCorrectivesSpec | null
): JsonRecord {
  const output = cloneJson(sourceManifest)
  delete output.appearanceDials
  delete output.anatomyFit
  delete output.dials
  delete output.recipeSource
  delete output.recipeUpdates
  delete output.evaluation
  output.description = `Deterministic Live Goon baked from Recipe revision ${liveManifest.source.revision}.`
  output.liveBuild = liveManifest
  if (output.rig !== undefined) {
    const rig = record(output.rig, 'avatar.json#rig')
    delete rig.correctives
    delete rig.provenance
    if (liveCorrectives) rig.liveCorrectives = liveCorrectives
    else delete rig.liveCorrectives
  } else if (liveCorrectives) {
    output.rig = { liveCorrectives }
  }
  parseLiveJointCorrectives(output.rig === undefined ? undefined : record(output.rig, 'avatar.json#rig').liveCorrectives)
  return output
}

function sourceIdentity(input: LiveGoonBakeInput): GoonLiveBuildSourceIdentity {
  return {
    revisionId: stableString(input.sourceRevision.revisionId, 'source revision id'),
    revision: integer(input.sourceRevision.revision, 'source revision', 1),
    packageSha256: input.source.package.sha256,
    modelSha256: input.source.model.sha256,
    manifestSha256: input.source.manifest.sha256,
    definitionSha256: input.source.identities.definitionSha256,
    neutralRecipeSha256: input.source.identities.neutralRecipeSha256,
    basisSha256: input.source.identities.physicalBasisSha256
  }
}

function buildInventory(rewrite: StructuralRewrite, sourceManifest: JsonRecord): GoonLiveBuildInventory {
  const removedManifestEntries = ['manifest:/appearanceDials']
  if (sourceManifest.anatomyFit !== undefined) removedManifestEntries.push('manifest:/anatomyFit')
  if (sourceManifest.recipeSource !== undefined) removedManifestEntries.push('manifest:/recipeSource')
  if (sourceManifest.recipeUpdates !== undefined) removedManifestEntries.push('manifest:/recipeUpdates')
  const sourceRig = sourceManifest.rig === undefined ? null : record(sourceManifest.rig, 'avatar.json#rig')
  if (sourceRig?.correctives !== undefined) removedManifestEntries.push('manifest:/rig/correctives')
  return {
    kept: rewrite.morphPlan.keptRefs,
    removed: [...new Set([
      ...rewrite.morphPlan.removedRefs,
      ...removedManifestEntries
    ])].sort(compareText),
    liveMorphTargets: rewrite.morphPlan.keptRefs,
    retainedDynamicMorphs: rewrite.morphPlan.dynamicRefs,
    retainedCorrectiveMorphs: rewrite.morphPlan.correctiveRefs
  }
}

function assertInputBounds(input: LiveGoonBakeInput): void {
  const entries = [
    ['package', input.packageBytes],
    ['model', input.modelBytes],
    ['manifest', input.manifestBytes]
  ] as const
  let total = 0
  for (const [name, bytes] of entries) {
    exactBytes(bytes, `${name} bytes`)
    if (bytes.byteLength > MAX_BAKER_INPUT_BYTES) fail(`${name} exceeds the 1 GiB baker input limit`)
    total += bytes.byteLength
  }
  if (total > MAX_BAKER_INPUT_BYTES * 2) fail('combined baker input exceeds the bounded working-set contract')
}

export async function verifyLiveGoonBakeArtifacts(
  input: LiveGoonBakeArtifactInput
): Promise<{ manifest: JsonRecord; liveManifest: GoonLiveManifest; receipt: GoonLiveBuildReceipt }> {
  const [receipt, packageSha256, modelSha256, manifestSha256] = await Promise.all([
    verifyGoonLiveBuildReceipt(input.receipt),
    sha256Hex(exactBytes(input.packageBytes, 'Live package bytes')),
    sha256Hex(exactBytes(input.modelBytes, 'Live model bytes')),
    sha256Hex(exactBytes(input.manifestBytes, 'Live manifest bytes'))
  ])
  if (
    receipt.output.package.sha256 !== packageSha256 ||
    receipt.output.package.bytes !== input.packageBytes.byteLength ||
    receipt.output.model.sha256 !== modelSha256 ||
    receipt.output.model.bytes !== input.modelBytes.byteLength ||
    receipt.output.manifest.sha256 !== manifestSha256 ||
    receipt.output.manifest.bytes !== input.manifestBytes.byteLength
  ) {
    fail('Live output bytes do not match the external receipt')
  }
  const entries = strictStoredZipEntries(input.packageBytes)
  if (!bytesEqual(entries.get('avatar.glb')!, input.modelBytes) || !bytesEqual(entries.get('avatar.json')!, input.manifestBytes)) {
    fail('Live package entries differ from the independently supplied model or manifest')
  }
  const manifest = parseJsonManifestBytes(input.manifestBytes)
  const liveManifest = await verifyGoonLiveAvatarManifestAgainstReceipt(manifest, receipt)
  if (manifest.appearanceDials !== undefined || manifest.anatomyFit !== undefined || manifest.dials !== undefined || manifest.recipeSource !== undefined || manifest.recipeUpdates !== undefined) {
    fail('Live manifest retains editable Recipe authoring definitions')
  }
  const rig = manifest.rig === undefined ? null : record(manifest.rig, 'avatar.json#rig')
  if (rig?.correctives !== undefined) fail('Live manifest retains authoring joint correctives')
  parseLiveJointCorrectives(rig?.liveCorrectives)
  const parsed = parseSemanticGlb(input.modelBytes, { diagnosticPrefix: `${LIVE_GOON_BAKER_ID}:artifact-verifier` })
  validateStructuralExtensions(parsed)
  verifySocketEyeLiveMorphInventory(parsed, manifest)
  const morphs = inventoryMorphRefs(parsed)
  if (canonicalRecipeString(morphs) !== canonicalRecipeString(liveManifest.inventory.liveMorphTargets)) {
    fail('re-imported model morphs differ from the receipt inventory')
  }
  if (liveManifest.counts.recipeMorphTargets !== 0 || liveManifest.counts.morphTargets !== morphs.length) {
    fail('Live manifest morph counts are invalid')
  }
  return { manifest, liveManifest, receipt }
}

export async function bakeLiveGoon(
  input: LiveGoonBakeInput,
  onStage: (stage: LiveGoonBakeStage) => void = () => {}
): Promise<LiveGoonBakeOutput> {
  onStage('validating-source')
  assertInputBounds(input)
  const [verifiedAssets, state] = await Promise.all([
    verifyRecipeSourceRawAssets(
      input.source,
      {
        packageBytes: input.packageBytes,
        modelBytes: input.modelBytes,
        manifestBytes: input.manifestBytes
      },
      input.source.identities
    ),
    verifyRecipeStateSnapshot(input.state)
  ])
  const appearanceManifest = parseAppearanceDialsManifest(verifiedAssets.manifest)
  if (!appearanceManifest) fail('Recipe Source does not contain appearance-dials/v2')
  onStage('evaluating-recipe')
  const strict = resolveStrictAppearanceRecipeSnapshot(appearanceManifest, state.appearanceDials)
  const basis: AppearanceRecipePhysicalBasis = buildAppearanceRecipePhysicalBasisFromGlb(
    input.modelBytes,
    verifiedAssets.manifest
  )
  const baseline = evaluateAppearanceRecipePhysicalOutput(basis, strict.resolved)
  const anatomyFitResults = await resolveBakedAnatomyFitResults({
    input,
    state,
    manifest: verifiedAssets.manifest as JsonRecord,
    appearanceManifest,
    baseline
  })
  const evaluation = anatomyFitResults.length > 0
    ? evaluateAppearanceRecipePhysicalOutput(basis, strict.resolved, { anatomyFitResults })
    : baseline
  onStage('rewriting-model')
  const rewrite = buildStructuralLiveGlb(
    input.modelBytes,
    verifiedAssets.manifest,
    appearanceManifest,
    strict.resolved,
    evaluation
  )
  onStage('auditing-model')
  const structuralAudit = await auditStructuralLiveGlb(
    input.modelBytes,
    rewrite.bytes,
    verifiedAssets.manifest,
    evaluation,
    rewrite
  )
  const source = sourceIdentity(input)
  const stateIdentity = { contract: state.contract, sha256: state.stateSha256 }
  const inventory = buildInventory(rewrite, verifiedAssets.manifest)
  const liveManifest = await createGoonLiveManifest({
    contract: GOON_LIVE_MANIFEST_CONTRACT,
    source,
    state: stateIdentity,
    baker: LIVE_GOON_BAKER_IDENTITY,
    inventory,
    proofs: structuralAudit.proofs,
    counts: rewrite.counts
  })
  onStage('packaging-live-goon')
  const manifest = createLiveAvatarManifest(
    verifiedAssets.manifest,
    liveManifest,
    rewrite.morphPlan.liveCorrectives
  )
  const manifestBytes = canonicalRecipeUtf8(manifest)
  const packageBytes = deterministicStoredZip([
    { name: 'avatar.glb', bytes: rewrite.bytes },
    { name: 'avatar.json', bytes: manifestBytes }
  ])
  const [packageSha256, modelSha256, manifestSha256] = await Promise.all([
    sha256Hex(packageBytes),
    sha256Hex(rewrite.bytes),
    sha256Hex(manifestBytes)
  ])
  const receipt = await createGoonLiveBuildReceipt({
    contract: GOON_LIVE_BUILD_CONTRACT,
    source,
    state: stateIdentity,
    baker: LIVE_GOON_BAKER_IDENTITY,
    inventory,
    proofs: {
      ...structuralAudit.proofs,
      liveManifestProvenanceSha256: liveManifest.provenanceSha256
    },
    output: {
      package: { sha256: packageSha256, bytes: packageBytes.byteLength },
      model: { sha256: modelSha256, bytes: rewrite.bytes.byteLength },
      manifest: { sha256: manifestSha256, bytes: manifestBytes.byteLength },
      counts: rewrite.counts
    },
    cost: rewrite.cost,
    validation: structuralAudit.validation
  })
  onStage('verifying-output')
  await verifyLiveGoonBakeArtifacts({
    modelBytes: rewrite.bytes,
    manifestBytes,
    packageBytes,
    receipt
  })
  return {
    contract: 'goon-live-bake-output/v1',
    modelBytes: rewrite.bytes,
    manifestBytes,
    packageBytes,
    manifest,
    liveManifest,
    receipt,
    audit: structuralAudit.audit
  }
}

import {
  decodeSemanticGlbAccessor,
  inspectSemanticGlbAccessor,
  parseSemanticGlb,
  resolveSemanticGlbNodeTransform,
  semanticGlbRuntimeNodeName,
  writeDeterministicSemanticGlb,
  type SemanticGlbDocument
} from './semanticGlb'
import { canonicalRecipeString } from './recipeCanonical'
import { createEmbeddedHairMaterialMetadata, inspectHairMaterialPng } from '../hairMaterial'
import type { HairAssetV1, HairStateV2 } from '../hairAssets'
import {
  parseEmbeddedSecondaryMotion,
  parseSecondaryMotionDefinition,
  type EmbeddedSecondaryMotionV2,
  type SecondaryMotionDefinitionV1
} from '../secondaryMotion'
import {
  HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
  HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE
} from '../secondaryMotion'

export const HAIR_AVATAR_GLB_COMPOSER_CONTRACT = 'hair-avatar-glb-composer/v1' as const

export type HairAvatarGlbAttachment = {
  /** Exact Three.js runtime node name declared by the Goon performance rig. */
  readonly headNode: string
  /** Column-major local transform applied to the Hair root under the head. */
  readonly authoredRootMatrix: readonly number[]
}

export type ComposeHairIntoAvatarGlbInput = {
  readonly sourceAvatarGlb: Uint8Array
  readonly hairGlb: Uint8Array
  readonly attachment: HairAvatarGlbAttachment
  readonly material?: ComposeHairMaterialInput
  readonly sourceSecondaryMotion?: SecondaryMotionDefinitionV1
  readonly secondaryMotion?: EmbeddedSecondaryMotionV2
}

export type ComposeHairMaterialInput = {
  readonly asset: HairAssetV1
  readonly state: HairStateV2
  readonly neutralValueBytes: Uint8Array
  readonly highlightMaskBytes: Uint8Array
  readonly normalBytes?: Uint8Array
  readonly roughnessBytes?: Uint8Array
}

type JsonRecord = Record<string, unknown>

const CORE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png'])

function fail(message: string): never {
  throw new Error(`[${HAIR_AVATAR_GLB_COMPOSER_CONTRACT}] ${message}`)
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
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

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalRecipeString(value)) as T
}

function checkedIndex(value: unknown, length: number, offset: number, context: string): number {
  const index = integer(value, context)
  if (index >= length) fail(`${context} is out of range`)
  return index + offset
}

function align4(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('binary byte length is invalid')
  }
  return Math.ceil(value / 4) * 4
}

function validateAttachmentMatrix(value: readonly number[]): number[] {
  if (!Array.isArray(value) || value.length !== 16) {
    fail('attachment.authoredRootMatrix must contain exactly 16 numbers')
  }
  const matrix = value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      fail(`attachment.authoredRootMatrix[${index}] must be finite`)
    }
    return Object.is(entry, -0) ? 0 : entry
  })
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    fail('attachment.authoredRootMatrix must be an affine matrix')
  }
  const determinant =
    matrix[0]! * (matrix[5]! * matrix[10]! - matrix[9]! * matrix[6]!) -
    matrix[4]! * (matrix[1]! * matrix[10]! - matrix[9]! * matrix[2]!) +
    matrix[8]! * (matrix[1]! * matrix[6]! - matrix[5]! * matrix[2]!)
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    fail('attachment.authoredRootMatrix must be invertible')
  }
  return matrix
}

type OwnedScene = {
  readonly scene: JsonRecord
  readonly roots: number[]
  readonly ownedNodes: Set<number>
}

function requireOwnedSingleScene(
  parsed: SemanticGlbDocument,
  label: 'source avatar' | 'Hair'
): OwnedScene {
  const scenes = optionalArray(parsed.gltf.scenes, `${label} gltf.scenes`)
  if (scenes.length !== 1) {
    fail(`${label} GLB must contain exactly one unambiguous scene`)
  }
  const sceneIndex = integer(parsed.gltf.scene ?? 0, `${label} gltf.scene`)
  if (sceneIndex !== 0) fail(`${label} GLB scene must resolve to index 0`)
  const scene = record(scenes[0], `${label} gltf.scenes[0]`)
  const roots = array(scene.nodes, `${label} gltf.scenes[0].nodes`).map((value, index) => {
    const root = integer(value, `${label} gltf.scenes[0].nodes[${index}]`)
    if (root >= parsed.nodes.length) {
      fail(`${label} scene root ${root} is out of range`)
    }
    if (parsed.parents.has(root)) {
      fail(`${label} scene root ${root} has a parent outside scene ownership`)
    }
    return root
  })
  if (roots.length === 0 || new Set(roots).size !== roots.length) {
    fail(`${label} GLB scene roots must be non-empty and unique`)
  }

  const ownedNodes = new Set<number>()
  const visit = (nodeIndex: number) => {
    if (ownedNodes.has(nodeIndex)) {
      fail(`${label} scene reaches node ${nodeIndex} more than once`)
    }
    ownedNodes.add(nodeIndex)
    const node = parsed.nodes[nodeIndex]!
    for (const childValue of optionalArray(
      node.children,
      `${label} gltf.nodes[${nodeIndex}].children`
    )) {
      const child = integer(childValue, `${label} gltf.nodes[${nodeIndex}].children[]`)
      if (child >= parsed.nodes.length) {
        fail(`${label} node ${nodeIndex} has an out-of-range child`)
      }
      visit(child)
    }
  }
  roots.forEach(visit)
  if (ownedNodes.size !== parsed.nodes.length) {
    fail(`${label} GLB contains nodes outside its sole scene hierarchy`)
  }
  return { scene, roots, ownedNodes }
}

function validateEmbeddedStorage(
  parsed: SemanticGlbDocument,
  label: 'source avatar' | 'Hair'
): void {
  const buffers = array(parsed.gltf.buffers, `${label} gltf.buffers`)
  const buffer = record(buffers[0], `${label} gltf.buffers[0]`)
  if (buffer.uri !== undefined) {
    fail(`${label} GLB may not declare an external buffer URI`)
  }
  for (const [imageIndex, value] of optionalArray(
    parsed.gltf.images,
    `${label} gltf.images`
  ).entries()) {
    const image = record(value, `${label} gltf.images[${imageIndex}]`)
    if (image.uri !== undefined) {
      fail(`${label} gltf.images[${imageIndex}] may not use a URI`)
    }
    const bufferView = integer(image.bufferView, `${label} gltf.images[${imageIndex}].bufferView`)
    const bufferViews = optionalArray(parsed.gltf.bufferViews, `${label} gltf.bufferViews`)
    if (bufferView >= bufferViews.length) {
      fail(`${label} gltf.images[${imageIndex}].bufferView is out of range`)
    }
    const mimeType = stableString(image.mimeType, `${label} gltf.images[${imageIndex}].mimeType`)
    if (label === 'Hair' && !CORE_IMAGE_MIME_TYPES.has(mimeType)) {
      fail(`${label} gltf.images[${imageIndex}] uses unsupported MIME type ${mimeType}`)
    }
  }
}

function rejectHairExtensions(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectHairExtensions(entry, `${context}[${index}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  const entry = value as Record<string, unknown>
  if (entry.extensions !== undefined) {
    const extensions = record(entry.extensions, `${context}.extensions`)
    const names = Object.keys(extensions)
    if (names.length > 0) {
      fail(`Hair GLB uses unsupported extensions at ${context}: ${names.join(', ')}`)
    }
  }
  for (const [key, child] of Object.entries(entry)) {
    if (key !== 'extensions') rejectHairExtensions(child, `${context}.${key}`)
  }
}

function validateRootWeightedHairSkin(
  parsed: SemanticGlbDocument,
  hairRootIndex: number,
  sourceSecondaryMotion: SecondaryMotionDefinitionV1 | null,
  secondaryMotion: EmbeddedSecondaryMotionV2 | null
): void {
  if (!secondaryMotion) fail('Hair skinning requires embedded root-weighted secondary motion')
  if (!sourceSecondaryMotion) {
    fail('root-weighted Hair skinning requires the immutable source secondary-motion definition')
  }
  const sourceInventory = sourceSecondaryMotion.chains.map((chain) => ({
    id: chain.id,
    nodes: chain.segments.map((segment) => segment.node)
  }))
  const embeddedInventory = secondaryMotion.chains.map((chain) => ({
    id: chain.id,
    nodes: chain.segments.map((segment) => segment.node)
  }))
  if (
    canonicalRecipeString(sourceSecondaryMotion.owner) !==
      canonicalRecipeString(secondaryMotion.owner) ||
    sourceSecondaryMotion.chainSpace !== secondaryMotion.chainSpace ||
    sourceSecondaryMotion.colliderSpace !== secondaryMotion.colliderSpace ||
    canonicalRecipeString(sourceInventory) !== canonicalRecipeString(embeddedInventory)
  ) {
    fail('embedded Hair motion does not project the immutable source definition')
  }
  if (parsed.skins.length !== 1) fail('root-weighted Hair must contain exactly one skin')
  const skin = parsed.skins[0]!
  const joints = array(skin.joints, 'Hair gltf.skins[0].joints').map((value, index) =>
    integer(value, `Hair gltf.skins[0].joints[${index}]`)
  )
  const motionSegments = sourceSecondaryMotion.chains.flatMap((chain) => chain.segments)
  if (joints.length !== motionSegments.length + 1 || joints[0] !== hairRootIndex) {
    fail('root-weighted Hair skin must contain the Hair root followed by every motion joint')
  }
  if (integer(skin.skeleton, 'Hair gltf.skins[0].skeleton') !== hairRootIndex) {
    fail('root-weighted Hair skin skeleton must be the authored Hair root')
  }
  const inverseBindMatrices = inspectSemanticGlbAccessor(parsed, skin.inverseBindMatrices)
  if (
    inverseBindMatrices.type !== 'MAT4' ||
    inverseBindMatrices.componentType !== 5126 ||
    inverseBindMatrices.count !== joints.length
  ) {
    fail('root-weighted Hair inverse-bind matrices must be FLOAT MAT4 with one row per joint')
  }

  const segmentByNode = new Map(motionSegments.map((segment) => [segment.node, segment]))
  const meshSlotsByNode = new Map<string, Set<number>>()
  for (let slot = 1; slot < joints.length; slot += 1) {
    const jointNodeIndex = joints[slot]!
    const jointNode = parsed.nodes[jointNodeIndex]
    if (!jointNode) fail(`root-weighted Hair joint ${slot} is out of range`)
    const jointName = stableString(jointNode.name, `Hair gltf.nodes[${jointNodeIndex}].name`)
    const segment = segmentByNode.get(jointName)
    if (!segment) fail(`root-weighted Hair joint ${jointName} has no motion segment`)
    if (parsed.parents.get(jointNodeIndex) !== hairRootIndex) {
      fail(`root-weighted Hair joint ${jointName} must be a direct child of the Hair root`)
    }
    const translation = array(
      jointNode.translation,
      `Hair gltf.nodes[${jointNodeIndex}].translation`
    ).map((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`Hair gltf.nodes[${jointNodeIndex}].translation[${index}] must be finite`)
      }
      return value
    })
    if (
      translation.length !== 3 ||
      translation.some((value, index) => Math.abs(value - segment.pivot[index]!) > 1e-6)
    ) {
      fail(`root-weighted Hair joint ${jointName} translation drifted from its motion pivot`)
    }
    const extras = record(
      jointNode.extras,
      `Hair gltf.nodes[${jointNodeIndex}].extras`
    )
    const metadata = record(
      extras.batshitHairRootWeightedMotion,
      `Hair gltf.nodes[${jointNodeIndex}].extras.batshitHairRootWeightedMotion`
    )
    if (
      metadata.contract !== HAIR_ROOT_WEIGHTED_MOTION_CONTRACT ||
      metadata.tipAttribute !== HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE ||
      metadata.dynamicJointSlot !== slot
    ) {
      fail(`root-weighted Hair joint ${jointName} metadata is invalid`)
    }
    const meshNode = stableString(
      metadata.meshNode,
      `Hair gltf.nodes[${jointNodeIndex}].extras.batshitHairRootWeightedMotion.meshNode`
    )
    const meshSlots = meshSlotsByNode.get(meshNode) ?? new Set<number>()
    meshSlots.add(slot)
    meshSlotsByNode.set(meshNode, meshSlots)
  }

  const usedMotionSlots = new Set<number>()
  for (const [nodeIndex, node] of parsed.nodes.entries()) {
    if (node.mesh === undefined) {
      if (node.skin !== undefined) fail(`non-mesh Hair node ${nodeIndex} may not use a skin`)
      continue
    }
    const nodeName = stableString(node.name, `Hair gltf.nodes[${nodeIndex}].name`)
    const expectedSlots = meshSlotsByNode.get(nodeName) ?? new Set<number>()
    const rigidMesh = expectedSlots.size === 0
    if (rigidMesh && node.skin !== undefined) {
      fail(`rigid Hair mesh ${nodeName} may not use the motion skin`)
    }
    if (!rigidMesh && node.skin !== 0) {
      fail(`root-weighted Hair mesh ${nodeName} must use skin 0`)
    }
    const meshIndex = integer(node.mesh, `Hair gltf.nodes[${nodeIndex}].mesh`)
    const mesh = parsed.meshes[meshIndex]
    if (!mesh) fail(`Hair mesh ${meshIndex} is out of range`)
    for (const [primitiveIndex, primitiveValue] of array(
      mesh.primitives,
      `Hair gltf.meshes[${meshIndex}].primitives`
    ).entries()) {
      const primitive = record(
        primitiveValue,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`
      )
      const attributes = record(
        primitive.attributes,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes`
      )
      const positions = inspectSemanticGlbAccessor(parsed, attributes.POSITION)
      if (rigidMesh) {
        if (
          attributes.JOINTS_0 !== undefined ||
          attributes.WEIGHTS_0 !== undefined ||
          attributes._BATSHAIR_TIP !== undefined
        ) {
          fail(`rigid Hair mesh ${nodeName} may not contain root-weighted motion attributes`)
        }
        continue
      }
      const jointAccessor = decodeSemanticGlbAccessor(parsed, attributes.JOINTS_0)
      const weightAccessor = decodeSemanticGlbAccessor(parsed, attributes.WEIGHTS_0)
      const tipAccessor = decodeSemanticGlbAccessor(parsed, attributes._BATSHAIR_TIP)
      if (
        jointAccessor.type !== 'VEC4' ||
        ![5121, 5123].includes(jointAccessor.componentType) ||
        weightAccessor.type !== 'VEC4' ||
        weightAccessor.componentType !== 5126 ||
        tipAccessor.type !== 'SCALAR' ||
        tipAccessor.componentType !== 5126 ||
        jointAccessor.count !== positions.count ||
        weightAccessor.count !== positions.count ||
        tipAccessor.count !== positions.count
      ) {
        fail(`root-weighted Hair mesh ${nodeName} has malformed skin attributes`)
      }
      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        const offset = vertex * 4
        const rootWeight = weightAccessor.values[offset]!
        const dynamicWeight = weightAccessor.values[offset + 1]!
        const authoredMotionWeight = tipAccessor.values[vertex]!
        const dynamicSlot = jointAccessor.values[offset + 1]!
        const dynamicSlotIsValid =
          expectedSlots.has(dynamicSlot) || (dynamicWeight <= 1e-7 && dynamicSlot === 0)
        if (
          jointAccessor.values[offset] !== 0 ||
          !dynamicSlotIsValid ||
          jointAccessor.values[offset + 2] !== 0 ||
          jointAccessor.values[offset + 3] !== 0 ||
          Math.abs(rootWeight + dynamicWeight - 1) > 1e-6 ||
          Math.abs(dynamicWeight - authoredMotionWeight) > 1e-6 ||
          Math.abs(weightAccessor.values[offset + 2]!) > 1e-7 ||
          Math.abs(weightAccessor.values[offset + 3]!) > 1e-7 ||
          authoredMotionWeight < 0 ||
          authoredMotionWeight > 1
        ) {
          fail(`root-weighted Hair mesh ${nodeName} has invalid vertex weight ${vertex}`)
        }
        if (dynamicWeight > 1e-7) usedMotionSlots.add(dynamicSlot)
      }
    }
  }
  if (
    usedMotionSlots.size !== motionSegments.length ||
    [...usedMotionSlots].some((slot) => slot < 1 || slot >= joints.length)
  ) {
    fail('root-weighted Hair must bind every motion segment to authored moving vertices')
  }
}

function rejectUnsupportedHairFeatures(
  parsed: SemanticGlbDocument,
  hairRootIndex: number,
  sourceSecondaryMotion: SecondaryMotionDefinitionV1 | null,
  secondaryMotion: EmbeddedSecondaryMotionV2 | null
): void {
  const forbiddenArrays = [
    ['animations', 'animations'],
    ['cameras', 'cameras']
  ] as const
  for (const [key, label] of forbiddenArrays) {
    if (optionalArray(parsed.gltf[key], `Hair gltf.${key}`).length > 0) {
      fail(`Hair GLB may not contain ${label}`)
    }
  }
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    if (optionalArray(parsed.gltf[key], `Hair gltf.${key}`).length > 0) {
      fail(`Hair GLB may not declare ${key}`)
    }
  }
  rejectHairExtensions(parsed.gltf, 'Hair gltf')

  if (parsed.meshes.length === 0) {
    fail('Hair GLB must contain at least one polygon mesh')
  }
  if (secondaryMotion?.motionSettings && parsed.skins.length === 0) {
    fail('saved Hair motion settings require root-weighted Hair skinning')
  }

  for (const [nodeIndex, node] of parsed.nodes.entries()) {
    resolveSemanticGlbNodeTransform(node, `Hair gltf.nodes[${nodeIndex}]`, {
      diagnosticPrefix: HAIR_AVATAR_GLB_COMPOSER_CONTRACT
    })
    if (parsed.skins.length === 0 && node.skin !== undefined) {
      fail(`Hair node ${nodeIndex} may not use a skin without a root-weighted Hair contract`)
    }
    if (node.camera !== undefined) fail(`Hair node ${nodeIndex} may not use a camera`)
    if (node.weights !== undefined) fail(`Hair node ${nodeIndex} may not use morph weights`)
  }
  for (const [meshIndex, mesh] of parsed.meshes.entries()) {
    if (mesh.weights !== undefined) fail(`Hair mesh ${meshIndex} may not use morph weights`)
    const primitives = array(mesh.primitives, `Hair gltf.meshes[${meshIndex}].primitives`)
    if (primitives.length === 0) fail(`Hair mesh ${meshIndex} has no primitives`)
    for (const [primitiveIndex, value] of primitives.entries()) {
      const primitive = record(
        value,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`
      )
      if (primitive.targets !== undefined) {
        fail(`Hair mesh ${meshIndex} primitive ${primitiveIndex} may not use morph targets`)
      }
      const mode = integer(
        primitive.mode ?? 4,
        `Hair primitive ${meshIndex}:${primitiveIndex}.mode`
      )
      if (mode !== 4) {
        fail(`Hair mesh ${meshIndex} primitive ${primitiveIndex} must use TRIANGLES mode`)
      }
      const attributes = record(
        primitive.attributes,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes`
      )
      if (attributes.POSITION === undefined) {
        fail(`Hair mesh ${meshIndex} primitive ${primitiveIndex} is missing POSITION`)
      }
      if (
        parsed.skins.length === 0 &&
        Object.keys(attributes).some(
          (name) => name.startsWith('JOINTS_') || name.startsWith('WEIGHTS_')
        )
      ) {
        fail(`Hair mesh ${meshIndex} primitive ${primitiveIndex} may not use skin attributes`)
      }
      for (const [name, accessorIndex] of Object.entries(attributes)) {
        const info = inspectSemanticGlbAccessor(parsed, accessorIndex)
        if (name === 'POSITION' && (info.type !== 'VEC3' || info.componentType !== 5126)) {
          fail(`Hair mesh ${meshIndex} primitive ${primitiveIndex} POSITION must be FLOAT VEC3`)
        }
      }
      if (primitive.indices !== undefined) {
        const info = inspectSemanticGlbAccessor(parsed, primitive.indices)
        if (info.type !== 'SCALAR' || ![5121, 5123, 5125].includes(info.componentType)) {
          fail(`Hair mesh ${meshIndex} primitive ${primitiveIndex} indices must be unsigned SCALAR`)
        }
      }
    }
  }
  if (parsed.skins.length > 0) {
    validateRootWeightedHairSkin(
      parsed,
      hairRootIndex,
      sourceSecondaryMotion,
      secondaryMotion
    )
  }
}

function validateHairBufferViews(parsed: SemanticGlbDocument): void {
  for (const [viewIndex, value] of optionalArray(
    parsed.gltf.bufferViews,
    'Hair gltf.bufferViews'
  ).entries()) {
    const view = record(value, `Hair gltf.bufferViews[${viewIndex}]`)
    if (view.buffer !== undefined && view.buffer !== 0) {
      fail(`Hair gltf.bufferViews[${viewIndex}] references a non-GLB buffer`)
    }
    const byteOffset = integer(
      view.byteOffset ?? 0,
      `Hair gltf.bufferViews[${viewIndex}].byteOffset`
    )
    const byteLength = integer(view.byteLength, `Hair gltf.bufferViews[${viewIndex}].byteLength`)
    if (
      byteOffset > parsed.binary.byteLength ||
      byteLength > parsed.binary.byteLength - byteOffset
    ) {
      fail(`Hair gltf.bufferViews[${viewIndex}] exceeds the GLB BIN chunk`)
    }
  }
  const accessors = optionalArray(parsed.gltf.accessors, 'Hair gltf.accessors')
  accessors.forEach((_value, index) => inspectSemanticGlbAccessor(parsed, index))
}

function appendResourceArray(target: JsonRecord, key: string, values: JsonRecord[]): void {
  if (values.length === 0) return
  const existing = optionalArray(target[key], `source avatar gltf.${key}`)
  target[key] = [...existing, ...values]
}

function remapTextureInfo(
  owner: JsonRecord,
  key: string,
  textureCount: number,
  textureOffset: number,
  context: string
): void {
  if (owner[key] === undefined) return
  const info = record(owner[key], `${context}.${key}`)
  info.index = checkedIndex(info.index, textureCount, textureOffset, `${context}.${key}.index`)
}

function remapHairResources(
  source: SemanticGlbDocument,
  hair: SemanticGlbDocument,
  binaryOffset: number,
  nodeOffset: number
): {
  readonly accessors: JsonRecord[]
  readonly bufferViews: JsonRecord[]
  readonly images: JsonRecord[]
  readonly samplers: JsonRecord[]
  readonly textures: JsonRecord[]
  readonly materials: JsonRecord[]
  readonly meshes: JsonRecord[]
  readonly nodes: JsonRecord[]
  readonly skins: JsonRecord[]
} {
  const sourceAccessors = optionalArray(
    source.gltf.accessors,
    'source avatar gltf.accessors'
  ).length
  const sourceBufferViews = optionalArray(
    source.gltf.bufferViews,
    'source avatar gltf.bufferViews'
  ).length
  const sourceImages = optionalArray(source.gltf.images, 'source avatar gltf.images').length
  const sourceSamplers = optionalArray(source.gltf.samplers, 'source avatar gltf.samplers').length
  const sourceTextures = optionalArray(source.gltf.textures, 'source avatar gltf.textures').length
  const sourceMaterials = optionalArray(
    source.gltf.materials,
    'source avatar gltf.materials'
  ).length
  const sourceMeshes = source.meshes.length
  const sourceSkins = source.skins.length

  const rawBufferViews = optionalArray(hair.gltf.bufferViews, 'Hair gltf.bufferViews')
  const bufferViews = rawBufferViews.map((value, index) => {
    const view = cloneJson(record(value, `Hair gltf.bufferViews[${index}]`))
    view.buffer = 0
    view.byteOffset =
      integer(view.byteOffset ?? 0, `Hair gltf.bufferViews[${index}].byteOffset`) + binaryOffset
    return view
  })

  const rawAccessors = optionalArray(hair.gltf.accessors, 'Hair gltf.accessors')
  const accessors = rawAccessors.map((value, index) => {
    const accessor = cloneJson(record(value, `Hair gltf.accessors[${index}]`))
    if (accessor.bufferView !== undefined) {
      accessor.bufferView = checkedIndex(
        accessor.bufferView,
        rawBufferViews.length,
        sourceBufferViews,
        `Hair gltf.accessors[${index}].bufferView`
      )
    }
    if (accessor.sparse !== undefined) {
      const sparse = record(accessor.sparse, `Hair gltf.accessors[${index}].sparse`)
      for (const key of ['indices', 'values'] as const) {
        const entry = record(sparse[key], `Hair gltf.accessors[${index}].sparse.${key}`)
        entry.bufferView = checkedIndex(
          entry.bufferView,
          rawBufferViews.length,
          sourceBufferViews,
          `Hair gltf.accessors[${index}].sparse.${key}.bufferView`
        )
      }
    }
    return accessor
  })

  const rawImages = optionalArray(hair.gltf.images, 'Hair gltf.images')
  const images = rawImages.map((value, index) => {
    const image = cloneJson(record(value, `Hair gltf.images[${index}]`))
    image.bufferView = checkedIndex(
      image.bufferView,
      rawBufferViews.length,
      sourceBufferViews,
      `Hair gltf.images[${index}].bufferView`
    )
    return image
  })

  const rawSamplers = optionalArray(hair.gltf.samplers, 'Hair gltf.samplers')
  const samplers = rawSamplers.map((value, index) =>
    cloneJson(record(value, `Hair gltf.samplers[${index}]`))
  )

  const rawTextures = optionalArray(hair.gltf.textures, 'Hair gltf.textures')
  const textures = rawTextures.map((value, index) => {
    const texture = cloneJson(record(value, `Hair gltf.textures[${index}]`))
    texture.source = checkedIndex(
      texture.source,
      rawImages.length,
      sourceImages,
      `Hair gltf.textures[${index}].source`
    )
    if (texture.sampler !== undefined) {
      texture.sampler = checkedIndex(
        texture.sampler,
        rawSamplers.length,
        sourceSamplers,
        `Hair gltf.textures[${index}].sampler`
      )
    }
    return texture
  })

  const rawMaterials = optionalArray(hair.gltf.materials, 'Hair gltf.materials')
  const materials = rawMaterials.map((value, index) => {
    const material = cloneJson(record(value, `Hair gltf.materials[${index}]`))
    const context = `Hair gltf.materials[${index}]`
    if (material.pbrMetallicRoughness !== undefined) {
      const pbr = record(material.pbrMetallicRoughness, `${context}.pbrMetallicRoughness`)
      remapTextureInfo(
        pbr,
        'baseColorTexture',
        rawTextures.length,
        sourceTextures,
        `${context}.pbrMetallicRoughness`
      )
      remapTextureInfo(
        pbr,
        'metallicRoughnessTexture',
        rawTextures.length,
        sourceTextures,
        `${context}.pbrMetallicRoughness`
      )
    }
    remapTextureInfo(material, 'normalTexture', rawTextures.length, sourceTextures, context)
    remapTextureInfo(material, 'occlusionTexture', rawTextures.length, sourceTextures, context)
    remapTextureInfo(material, 'emissiveTexture', rawTextures.length, sourceTextures, context)
    return material
  })

  const rawMeshes = optionalArray(hair.gltf.meshes, 'Hair gltf.meshes')
  const meshes = rawMeshes.map((value, meshIndex) => {
    const mesh = cloneJson(record(value, `Hair gltf.meshes[${meshIndex}]`))
    const primitives = array(mesh.primitives, `Hair gltf.meshes[${meshIndex}].primitives`)
    mesh.primitives = primitives.map((primitiveValue, primitiveIndex) => {
      const primitive = record(
        primitiveValue,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`
      )
      const attributes = record(
        primitive.attributes,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes`
      )
      for (const [name, accessorIndex] of Object.entries(attributes)) {
        attributes[name] = checkedIndex(
          accessorIndex,
          rawAccessors.length,
          sourceAccessors,
          `Hair primitive ${meshIndex}:${primitiveIndex}.attributes.${name}`
        )
      }
      if (primitive.indices !== undefined) {
        primitive.indices = checkedIndex(
          primitive.indices,
          rawAccessors.length,
          sourceAccessors,
          `Hair primitive ${meshIndex}:${primitiveIndex}.indices`
        )
      }
      if (primitive.material !== undefined) {
        primitive.material = checkedIndex(
          primitive.material,
          rawMaterials.length,
          sourceMaterials,
          `Hair primitive ${meshIndex}:${primitiveIndex}.material`
        )
      }
      return primitive
    })
    return mesh
  })

  const usedMeshes = new Set<number>()
  const rawSkins = optionalArray(hair.gltf.skins, 'Hair gltf.skins')
  const nodes = hair.nodes.map((value, nodeIndex) => {
    const node = cloneJson(value)
    if (node.children !== undefined) {
      node.children = array(node.children, `Hair gltf.nodes[${nodeIndex}].children`).map(
        (child, childIndex) =>
          checkedIndex(
            child,
            hair.nodes.length,
            nodeOffset,
            `Hair gltf.nodes[${nodeIndex}].children[${childIndex}]`
          )
      )
    }
    if (node.mesh !== undefined) {
      const meshIndex = integer(node.mesh, `Hair gltf.nodes[${nodeIndex}].mesh`)
      if (meshIndex >= rawMeshes.length) {
        fail(`Hair gltf.nodes[${nodeIndex}].mesh is out of range`)
      }
      usedMeshes.add(meshIndex)
      node.mesh = meshIndex + sourceMeshes
    }
    if (node.skin !== undefined) {
      node.skin = checkedIndex(
        node.skin,
        rawSkins.length,
        sourceSkins,
        `Hair gltf.nodes[${nodeIndex}].skin`
      )
    }
    return node
  })
  if (usedMeshes.size !== rawMeshes.length) {
    fail('Hair GLB contains mesh resources outside its scene hierarchy')
  }

  const skins = rawSkins.map((value, skinIndex) => {
    const skin = cloneJson(record(value, `Hair gltf.skins[${skinIndex}]`))
    skin.joints = array(skin.joints, `Hair gltf.skins[${skinIndex}].joints`).map(
      (joint, jointIndex) =>
        checkedIndex(
          joint,
          hair.nodes.length,
          nodeOffset,
          `Hair gltf.skins[${skinIndex}].joints[${jointIndex}]`
        )
    )
    if (skin.skeleton !== undefined) {
      skin.skeleton = checkedIndex(
        skin.skeleton,
        hair.nodes.length,
        nodeOffset,
        `Hair gltf.skins[${skinIndex}].skeleton`
      )
    }
    skin.inverseBindMatrices = checkedIndex(
      skin.inverseBindMatrices,
      rawAccessors.length,
      sourceAccessors,
      `Hair gltf.skins[${skinIndex}].inverseBindMatrices`
    )
    return skin
  })

  return {
    accessors,
    bufferViews,
    images,
    samplers,
    textures,
    materials,
    meshes,
    nodes,
    skins
  }
}

function installHairMaterialResources(input: {
  material: ComposeHairMaterialInput
  hair: SemanticGlbDocument
  source: SemanticGlbDocument
  remapped: ReturnType<typeof remapHairResources>
  binaryParts: Array<{ offset: number; bytes: Uint8Array }>
  binaryLength: number
}): number {
  const { material, hair, source, remapped, binaryParts } = input
  const declaration = material.asset.material
  if (
    declaration.status !== 'ready' ||
    !declaration.layout ||
    !declaration.neutralValueTexture ||
    !declaration.highlightMask
  ) {
    fail('production Hair composition requires one ready H3 material declaration')
  }
  if (
    optionalArray(hair.gltf.images, 'Hair gltf.images').length > 0 ||
    optionalArray(hair.gltf.textures, 'Hair gltf.textures').length > 0
  ) {
    fail('production Hair geometry must not carry independent legacy image or texture resources')
  }
  for (const [meshIndex, mesh] of hair.meshes.entries()) {
    for (const [primitiveIndex, value] of array(
      mesh.primitives,
      `Hair gltf.meshes[${meshIndex}].primitives`
    ).entries()) {
      const attributes = record(
        record(value, `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`).attributes,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes`
      )
      if (attributes.TEXCOORD_0 === undefined) {
        fail(`Hair mesh ${meshIndex} primitive ${primitiveIndex} is missing required TEXCOORD_0`)
      }
    }
  }

  const textureInputs = [
    {
      role: 'neutral-value' as const,
      name: 'BatshitHairNeutralValue',
      bytes: material.neutralValueBytes
    },
    {
      role: 'highlight-mask' as const,
      name: 'BatshitHairHighlightMask',
      bytes: material.highlightMaskBytes
    },
    ...(material.normalBytes
      ? [
          {
            role: 'normal' as const,
            name: 'BatshitHairNormal',
            bytes: material.normalBytes
          }
        ]
      : []),
    ...(material.roughnessBytes
      ? [
          {
            role: 'roughness' as const,
            name: 'BatshitHairRoughness',
            bytes: material.roughnessBytes
          }
        ]
      : [])
  ]
  if (Boolean(material.normalBytes) !== Boolean(declaration.normalTexture)) {
    fail('Hair Normal bytes do not match the ready material declaration')
  }
  if (Boolean(material.roughnessBytes) !== Boolean(declaration.roughnessTexture)) {
    fail('Hair Roughness bytes do not match the ready material declaration')
  }

  const sourceBufferViews = optionalArray(
    source.gltf.bufferViews,
    'source avatar gltf.bufferViews'
  ).length
  const sourceImages = optionalArray(source.gltf.images, 'source avatar gltf.images').length
  const sourceSamplers = optionalArray(source.gltf.samplers, 'source avatar gltf.samplers').length
  const sourceTextures = optionalArray(source.gltf.textures, 'source avatar gltf.textures').length
  const samplerIndex = sourceSamplers + remapped.samplers.length
  remapped.samplers.push({
    name: 'BatshitHairLinearRepeat',
    magFilter: 9729,
    minFilter: 9987,
    wrapS: 10497,
    wrapT: 10497
  })

  let binaryLength = input.binaryLength
  const textureIndexByRole = new Map<string, number>()
  for (const [index, entry] of textureInputs.entries()) {
    inspectHairMaterialPng(entry.bytes, declaration, entry.role)
    const byteOffset = align4(binaryLength)
    binaryParts.push({ offset: byteOffset, bytes: entry.bytes })
    binaryLength = byteOffset + entry.bytes.byteLength
    const bufferView = sourceBufferViews + remapped.bufferViews.length
    remapped.bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: entry.bytes.byteLength
    })
    const image = sourceImages + remapped.images.length
    remapped.images.push({
      name: entry.name,
      bufferView,
      mimeType: 'image/png'
    })
    const texture = sourceTextures + remapped.textures.length
    remapped.textures.push({
      name: `${entry.name}Texture`,
      sampler: samplerIndex,
      source: image
    })
    textureIndexByRole.set(entry.role, texture)
  }

  const metadata = createEmbeddedHairMaterialMetadata(material.asset, material.state)
  const neutralTexture = textureIndexByRole.get('neutral-value')!
  const highlightMask = textureIndexByRole.get('highlight-mask')!
  const normalTexture = textureIndexByRole.get('normal')
  const roughnessTexture = textureIndexByRole.get('roughness')
  const productionMaterials = remapped.materials.map((sourceMaterial, index) => {
    const pbr: JsonRecord = {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index: neutralTexture },
      metallicFactor: declaration.defaults.metalness,
      roughnessFactor: roughnessTexture === undefined ? declaration.defaults.roughness : 1
    }
    if (roughnessTexture !== undefined) {
      pbr.metallicRoughnessTexture = { index: roughnessTexture }
    }
    const output: JsonRecord = {
      name: `${typeof sourceMaterial.name === 'string' ? sourceMaterial.name : `HairMaterial${index}`}__BatshitHairV1`,
      pbrMetallicRoughness: pbr,
      emissiveFactor: [0, 0, 0],
      emissiveTexture: { index: highlightMask },
      alphaMode: 'OPAQUE',
      doubleSided: sourceMaterial.doubleSided === true,
      extras: {
        ...(sourceMaterial.extras && typeof sourceMaterial.extras === 'object'
          ? cloneJson(sourceMaterial.extras)
          : {}),
        batshitHairMaterial: metadata
      }
    }
    if (normalTexture !== undefined) output.normalTexture = { index: normalTexture }
    return output
  })
  remapped.materials.splice(0, remapped.materials.length, ...productionMaterials)
  return binaryLength
}

/**
 * Deterministically integrates one validated polygon Hair GLB beneath
 * an exact head node in a verified source avatar GLB.
 *
 * This boundary preserves only Batshit-authored root-weighted Hair skinning.
 * Followers must already be baked, while animation, lights, cameras, arbitrary
 * skins, and extension-defined structures fail closed.
 */
export function composeHairIntoAvatarGlb(input: ComposeHairIntoAvatarGlbInput): Uint8Array {
  if (input === null || typeof input !== 'object') {
    fail('composition input must be an object')
  }
  const attachment = record(input.attachment, 'attachment')
  const headNode = stableString(attachment.headNode, 'attachment.headNode')
  const attachmentMatrix = validateAttachmentMatrix(
    attachment.authoredRootMatrix as readonly number[]
  )
  const source = parseSemanticGlb(input.sourceAvatarGlb, {
    diagnosticPrefix: HAIR_AVATAR_GLB_COMPOSER_CONTRACT
  })
  const hair = parseSemanticGlb(input.hairGlb, {
    diagnosticPrefix: HAIR_AVATAR_GLB_COMPOSER_CONTRACT
  })

  requireOwnedSingleScene(source, 'source avatar')
  const hairScene = requireOwnedSingleScene(hair, 'Hair')
  if (hairScene.roots.length !== 1) {
    fail('Hair GLB scene must have exactly one authored root')
  }
  const hairRootIndex = hairScene.roots[0]!
  validateEmbeddedStorage(source, 'source avatar')
  validateEmbeddedStorage(hair, 'Hair')
  const secondaryMotion = input.secondaryMotion
    ? parseEmbeddedSecondaryMotion(input.secondaryMotion)
    : null
  const sourceSecondaryMotion = input.sourceSecondaryMotion
    ? parseSecondaryMotionDefinition(input.sourceSecondaryMotion)
    : null
  rejectUnsupportedHairFeatures(
    hair,
    hairRootIndex,
    sourceSecondaryMotion,
    secondaryMotion
  )
  validateHairBufferViews(hair)

  const headIndex = source.runtimeNodeByName.get(headNode)
  if (headIndex === undefined) {
    fail(`source avatar head node ${headNode} is missing`)
  }
  for (const [name] of hair.rawNodeByName) {
    if (source.rawNodeByName.has(name)) {
      fail(`Hair node name ${name} collides with the source avatar`)
    }
    const runtimeName = semanticGlbRuntimeNodeName(name)
    if (source.runtimeNodeByName.has(runtimeName)) {
      fail(`Hair runtime node name ${runtimeName} collides with the source avatar`)
    }
  }

  const binaryOffset = align4(source.binary.byteLength)
  let combinedBinaryLength = binaryOffset + hair.binary.byteLength
  if (!Number.isSafeInteger(combinedBinaryLength) || combinedBinaryLength > 0xffffffff) {
    fail('combined GLB binary exceeds the supported size')
  }

  const gltf = cloneJson(source.gltf) as JsonRecord
  const sourceNodes = array(gltf.nodes, 'source avatar gltf.nodes') as JsonRecord[]
  const remapped = remapHairResources(source, hair, binaryOffset, sourceNodes.length)
  const binaryParts = [
    { offset: 0, bytes: source.binary },
    { offset: binaryOffset, bytes: hair.binary }
  ]
  if (input.material) {
    combinedBinaryLength = installHairMaterialResources({
      material: input.material,
      hair,
      source,
      remapped,
      binaryParts,
      binaryLength: combinedBinaryLength
    })
  }
  if (!Number.isSafeInteger(combinedBinaryLength) || combinedBinaryLength > 0xffffffff) {
    fail('combined GLB binary exceeds the supported size')
  }
  const binary = new Uint8Array(combinedBinaryLength)
  for (const part of binaryParts) binary.set(part.bytes, part.offset)
  const outputHairRoot = remapped.nodes[hairRootIndex]!
  delete outputHairRoot.translation
  delete outputHairRoot.rotation
  delete outputHairRoot.scale
  outputHairRoot.matrix = attachmentMatrix
  if (input.secondaryMotion) {
    if (!secondaryMotion) fail('Hair secondary-motion metadata is missing')
    outputHairRoot.extras = {
      ...(outputHairRoot.extras && typeof outputHairRoot.extras === 'object'
        ? cloneJson(outputHairRoot.extras)
        : {}),
      batshitSecondaryMotion: secondaryMotion
    }
  }

  const outputHead = record(sourceNodes[headIndex], `source avatar gltf.nodes[${headIndex}]`)
  const headChildren = optionalArray(
    outputHead.children,
    `source avatar gltf.nodes[${headIndex}].children`
  ).map((value, index) =>
    integer(value, `source avatar gltf.nodes[${headIndex}].children[${index}]`)
  )
  outputHead.children = [...headChildren, sourceNodes.length + hairRootIndex]

  appendResourceArray(gltf, 'bufferViews', remapped.bufferViews)
  appendResourceArray(gltf, 'accessors', remapped.accessors)
  appendResourceArray(gltf, 'images', remapped.images)
  appendResourceArray(gltf, 'samplers', remapped.samplers)
  appendResourceArray(gltf, 'textures', remapped.textures)
  appendResourceArray(gltf, 'materials', remapped.materials)
  appendResourceArray(gltf, 'meshes', remapped.meshes)
  appendResourceArray(gltf, 'nodes', remapped.nodes)
  appendResourceArray(gltf, 'skins', remapped.skins)

  const buffers = array(gltf.buffers, 'source avatar gltf.buffers')
  const buffer = record(buffers[0], 'source avatar gltf.buffers[0]')
  buffer.byteLength = binary.byteLength
  delete buffer.uri

  const output = writeDeterministicSemanticGlb(gltf, binary, {
    diagnosticPrefix: HAIR_AVATAR_GLB_COMPOSER_CONTRACT
  })
  const verified = parseSemanticGlb(output, {
    diagnosticPrefix: HAIR_AVATAR_GLB_COMPOSER_CONTRACT
  })
  for (
    let accessorIndex = optionalArray(source.gltf.accessors, 'source avatar gltf.accessors').length;
    accessorIndex < optionalArray(verified.gltf.accessors, 'composed gltf.accessors').length;
    accessorIndex += 1
  ) {
    inspectSemanticGlbAccessor(verified, accessorIndex)
  }
  requireOwnedSingleScene(verified, 'source avatar')
  return output
}

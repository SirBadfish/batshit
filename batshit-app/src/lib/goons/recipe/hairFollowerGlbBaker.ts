import type { ResolvedAppearanceDialState } from '../appearanceDials.contracts'
import {
  hairFollowerMorphNames,
  parseHairFollowerDefinition,
  resolveHairFollowerWeights,
  type HairFollowerDefinitionV1
} from '../hairFollowers'
import { canonicalRecipeString } from './recipeCanonical'
import {
  decodeSemanticGlbAccessor,
  inspectSemanticGlbAccessor,
  parseSemanticGlb,
  writeDeterministicSemanticGlb,
  type SemanticGltfRecord,
  type SemanticJsonRecord
} from './semanticGlb'

export const HAIR_FOLLOWER_GLB_BAKER_CONTRACT = 'hair-follower-glb-baker/v1' as const

export type BakeHairFollowerGlbInput = {
  hairGlb: Uint8Array
  definition: HairFollowerDefinitionV1
  state: Pick<ResolvedAppearanceDialState, 'values'>
}

function fail(message: string): never {
  throw new Error(`[${HAIR_FOLLOWER_GLB_BAKER_CONTRACT}] ${message}`)
}

function record(value: unknown, context: string): SemanticJsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as SemanticJsonRecord
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`)
  return value
}

function optionalArray(value: unknown, context: string): unknown[] {
  return value === undefined ? [] : array(value, context)
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${context} must be a non-negative safe integer`)
  }
  return value as number
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalRecipeString(value)) as T
}

function align4(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail('binary length is invalid')
  return Math.ceil(value / 4) * 4
}

type BinaryPart = { offset: number; bytes: Uint8Array }

export function bakeHairFollowerGlb(input: BakeHairFollowerGlbInput): Uint8Array {
  const definition = parseHairFollowerDefinition(input.definition)
  const weights = resolveHairFollowerWeights(definition, input.state)
  const targetNames = hairFollowerMorphNames(definition)
  const parsed = parseSemanticGlb(input.hairGlb, {
    diagnosticPrefix: HAIR_FOLLOWER_GLB_BAKER_CONTRACT
  })
  if (
    optionalArray(parsed.gltf.images, 'Hair gltf.images').length > 0 ||
    optionalArray(parsed.gltf.textures, 'Hair gltf.textures').length > 0
  ) {
    fail('Recipe Hair follower geometry must not contain embedded images or textures')
  }

  const sourceAccessors = optionalArray(parsed.gltf.accessors, 'Hair gltf.accessors')
  const sourceBufferViews = optionalArray(parsed.gltf.bufferViews, 'Hair gltf.bufferViews')
  const outputAccessors: SemanticJsonRecord[] = []
  const outputBufferViews: SemanticJsonRecord[] = []
  const binaryParts: BinaryPart[] = []
  const bufferViewMap = new Map<number, number>()
  const accessorMap = new Map<number, number>()
  let binaryLength = 0

  const appendBytes = (bytes: Uint8Array, target?: number) => {
    const offset = align4(binaryLength)
    binaryParts.push({ offset, bytes })
    binaryLength = offset + bytes.byteLength
    const index = outputBufferViews.length
    outputBufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.byteLength,
      ...(target === undefined ? {} : { target })
    })
    return index
  }

  const copyBufferView = (value: unknown, context: string) => {
    const sourceIndex = integer(value, context)
    const existing = bufferViewMap.get(sourceIndex)
    if (existing !== undefined) return existing
    const source = record(sourceBufferViews[sourceIndex], `Hair gltf.bufferViews[${sourceIndex}]`)
    const byteOffset = integer(
      source.byteOffset ?? 0,
      `Hair gltf.bufferViews[${sourceIndex}].byteOffset`
    )
    const byteLength = integer(
      source.byteLength,
      `Hair gltf.bufferViews[${sourceIndex}].byteLength`
    )
    if (
      sourceIndex >= sourceBufferViews.length ||
      byteOffset > parsed.binary.byteLength ||
      byteLength > parsed.binary.byteLength - byteOffset
    ) {
      fail(`Hair gltf.bufferViews[${sourceIndex}] exceeds the embedded binary`)
    }
    const target =
      source.target === undefined ? undefined : integer(source.target, `${context}.target`)
    const copied = appendBytes(parsed.binary.slice(byteOffset, byteOffset + byteLength), target)
    const output = outputBufferViews[copied]!
    if (source.byteStride !== undefined) {
      output.byteStride = integer(source.byteStride, `${context}.byteStride`)
    }
    bufferViewMap.set(sourceIndex, copied)
    return copied
  }

  const copyAccessor = (value: unknown, context: string) => {
    const sourceIndex = integer(value, context)
    const existing = accessorMap.get(sourceIndex)
    if (existing !== undefined) return existing
    if (sourceIndex >= sourceAccessors.length) fail(`${context} is out of range`)
    inspectSemanticGlbAccessor(parsed, sourceIndex)
    const accessor = cloneJson(
      record(sourceAccessors[sourceIndex], `Hair gltf.accessors[${sourceIndex}]`)
    )
    if (accessor.bufferView !== undefined) {
      accessor.bufferView = copyBufferView(
        accessor.bufferView,
        `Hair gltf.accessors[${sourceIndex}].bufferView`
      )
    }
    if (accessor.sparse !== undefined) {
      const sparse = record(accessor.sparse, `Hair gltf.accessors[${sourceIndex}].sparse`)
      for (const key of ['indices', 'values'] as const) {
        const entry = record(sparse[key], `Hair gltf.accessors[${sourceIndex}].sparse.${key}`)
        entry.bufferView = copyBufferView(
          entry.bufferView,
          `Hair gltf.accessors[${sourceIndex}].sparse.${key}.bufferView`
        )
      }
    }
    const outputIndex = outputAccessors.length
    outputAccessors.push(accessor)
    accessorMap.set(sourceIndex, outputIndex)
    return outputIndex
  }

  const createPositionAccessor = (positions: Float32Array) => {
    const bytes = new Uint8Array(positions.buffer.slice(0))
    const bufferView = appendBytes(bytes, 34962)
    const minimum = [Infinity, Infinity, Infinity]
    const maximum = [-Infinity, -Infinity, -Infinity]
    for (let index = 0; index < positions.length; index += 3) {
      for (let component = 0; component < 3; component += 1) {
        const value = positions[index + component]!
        minimum[component] = Math.min(minimum[component]!, value)
        maximum[component] = Math.max(maximum[component]!, value)
      }
    }
    const accessor = outputAccessors.length
    outputAccessors.push({
      bufferView,
      componentType: 5126,
      count: positions.length / 3,
      type: 'VEC3',
      min: minimum,
      max: maximum
    })
    return accessor
  }

  const outputMeshes = parsed.meshes.map((meshValue, meshIndex) => {
    const mesh = cloneJson(meshValue)
    const primitives = array(mesh.primitives, `Hair gltf.meshes[${meshIndex}].primitives`)
    mesh.primitives = primitives.map((primitiveValue, primitiveIndex) => {
      const primitive = cloneJson(
        record(primitiveValue, `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`)
      )
      const attributes = record(
        primitive.attributes,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes`
      )
      const positionIndex = integer(
        attributes.POSITION,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].attributes.POSITION`
      )
      const base = decodeSemanticGlbAccessor(parsed, positionIndex)
      if (base.type !== 'VEC3' || base.componentType !== 5126) {
        fail(`Hair primitive ${meshIndex}:${primitiveIndex} POSITION must be FLOAT VEC3`)
      }
      const targets = array(
        primitive.targets,
        `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].targets`
      )
      if (targets.length !== targetNames.length) {
        fail(`Hair primitive ${meshIndex}:${primitiveIndex} has a drifted follower target count`)
      }
      const positions = Float32Array.from(base.values)
      targets.forEach((targetValue, targetIndex) => {
        const target = record(
          targetValue,
          `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].targets[${targetIndex}]`
        )
        if (Object.keys(target).length !== 1 || target.POSITION === undefined) {
          fail(
            `Hair follower target ${meshIndex}:${primitiveIndex}:${targetIndex} must own POSITION only`
          )
        }
        const delta = decodeSemanticGlbAccessor(parsed, target.POSITION)
        if (delta.type !== 'VEC3' || delta.componentType !== 5126 || delta.count !== base.count) {
          fail(`Hair follower target ${meshIndex}:${primitiveIndex}:${targetIndex} is malformed`)
        }
        const weight = weights.get(targetNames[targetIndex]!)
        if (weight === undefined || !Number.isFinite(weight)) {
          fail(`Hair follower target ${targetNames[targetIndex]} has no resolved weight`)
        }
        if (weight === 0) return
        for (let scalar = 0; scalar < positions.length; scalar += 1) {
          positions[scalar] += delta.values[scalar]! * weight
        }
      })
      const outputAttributes: SemanticJsonRecord = {}
      for (const [name, accessor] of Object.entries(attributes)) {
        outputAttributes[name] =
          name === 'POSITION'
            ? createPositionAccessor(positions)
            : copyAccessor(accessor, `Hair primitive ${meshIndex}:${primitiveIndex}.${name}`)
      }
      primitive.attributes = outputAttributes
      if (primitive.indices !== undefined) {
        primitive.indices = copyAccessor(
          primitive.indices,
          `Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].indices`
        )
      }
      delete primitive.targets
      return primitive
    })
    if (mesh.weights !== undefined) {
      const weightsValue = array(mesh.weights, `Hair gltf.meshes[${meshIndex}].weights`)
      if (weightsValue.length !== targetNames.length || weightsValue.some((value) => value !== 0)) {
        fail(`Hair gltf.meshes[${meshIndex}].weights must contain only neutral follower weights`)
      }
      delete mesh.weights
    }
    if (mesh.extras !== undefined) {
      const extras = record(mesh.extras, `Hair gltf.meshes[${meshIndex}].extras`)
      const declaredNames = array(
        extras.targetNames,
        `Hair gltf.meshes[${meshIndex}].extras.targetNames`
      )
      if (
        declaredNames.length !== targetNames.length ||
        declaredNames.some((name, index) => name !== targetNames[index])
      ) {
        fail(`Hair gltf.meshes[${meshIndex}] target names do not match the follower definition`)
      }
      delete extras.targetNames
      if (Object.keys(extras).length === 0) delete mesh.extras
    } else {
      fail(`Hair gltf.meshes[${meshIndex}] is missing follower target names`)
    }
    return mesh
  })

  const outputNodes = parsed.nodes.map((nodeValue, nodeIndex) => {
    const node = cloneJson(nodeValue)
    if (node.weights !== undefined) {
      const weightsValue = array(node.weights, `Hair gltf.nodes[${nodeIndex}].weights`)
      if (weightsValue.length !== targetNames.length || weightsValue.some((value) => value !== 0)) {
        fail(`Hair gltf.nodes[${nodeIndex}].weights must contain only neutral follower weights`)
      }
      delete node.weights
    }
    return node
  })
  const outputSkins = parsed.skins.map((skinValue, skinIndex) => {
    const skin = cloneJson(skinValue)
    skin.inverseBindMatrices = copyAccessor(
      skin.inverseBindMatrices,
      `Hair gltf.skins[${skinIndex}].inverseBindMatrices`
    )
    return skin
  })

  const binary = new Uint8Array(binaryLength)
  for (const part of binaryParts) binary.set(part.bytes, part.offset)
  const gltf = cloneJson(parsed.gltf) as SemanticGltfRecord
  gltf.asset = {
    version: '2.0',
    generator: 'Batshit Hair follower GLB baker v1'
  }
  gltf.buffers = [{ byteLength: binary.byteLength }]
  gltf.bufferViews = outputBufferViews
  gltf.accessors = outputAccessors
  gltf.meshes = outputMeshes
  gltf.nodes = outputNodes
  gltf.skins = outputSkins
  delete gltf.animations

  const output = writeDeterministicSemanticGlb(gltf, binary, {
    diagnosticPrefix: HAIR_FOLLOWER_GLB_BAKER_CONTRACT
  })
  const verified = parseSemanticGlb(output, {
    diagnosticPrefix: HAIR_FOLLOWER_GLB_BAKER_CONTRACT
  })
  for (const [meshIndex, mesh] of verified.meshes.entries()) {
    if (mesh.weights !== undefined || mesh.extras !== undefined) {
      fail(`baked Hair mesh ${meshIndex} retained Recipe follower metadata`)
    }
    for (const [primitiveIndex, primitiveValue] of array(
      mesh.primitives,
      `baked Hair gltf.meshes[${meshIndex}].primitives`
    ).entries()) {
      const primitive = record(
        primitiveValue,
        `baked Hair gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`
      )
      if (primitive.targets !== undefined) {
        fail(`baked Hair primitive ${meshIndex}:${primitiveIndex} retained follower targets`)
      }
    }
  }
  return output
}

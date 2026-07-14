import * as THREE from 'three'
import {
  parseAppearanceDialsManifest,
  resolveAppearanceDialState,
  validateAppearanceRuntimeInventory,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
  type AppearanceRuntimeInventory,
  type AppearanceVec3,
  type ResolvedAppearanceDialState,
  type ResolvedAppearanceFollowerNodeTransform
} from './appearanceDials'
import { normalizeFaceMorphCollisionName } from './appearanceDials.validation'
import { sanitizeCustomRuntimeNodeName, type GoonCustomAvatarManifest } from './customAvatar'

type RuntimeMorphBinding = {
  mesh: THREE.Mesh
  index: number
  morph: string
}

type RuntimeBakedMesh = {
  mesh: THREE.Mesh
  position: THREE.BufferAttribute
  basePosition: Float32Array
  bakedBasePosition: Float32Array
}

type RuntimeBakedMorphBinding = {
  runtime: RuntimeBakedMesh
  delta: Float32Array
}

type RuntimeBone = {
  node: THREE.Object3D
  baseLocalPosition: THREE.Vector3
  parentBaseRelQuaternion: THREE.Quaternion
  parent: THREE.Object3D | null
}

type RuntimeSkin = {
  mesh: THREE.SkinnedMesh
  baseInverses: THREE.Matrix4[]
}

type RuntimeFollowerNode = {
  node: THREE.Object3D
  baseMatrix: THREE.Matrix4
}

type HipsClipRemap = {
  node: THREE.Object3D
  baseRest: THREE.Vector3
  newRest: THREE.Vector3
  ratio: number
  lastOutput: THREE.Vector3 | null
}

export type AppearanceDialsEngineOptions = {
  faceMeshes?: Iterable<THREE.Mesh>
  initialValues?: unknown
}

function morphRuntimeKey(runtimeId: string, index: number): string {
  return runtimeId + '\u0000' + index
}

function readVec3Attribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
): Float32Array {
  if (
    attribute instanceof THREE.BufferAttribute &&
    attribute.itemSize === 3 &&
    !attribute.normalized &&
    attribute.array instanceof Float32Array
  ) {
    return attribute.array.length === attribute.count * 3
      ? attribute.array
      : attribute.array.subarray(0, attribute.count * 3)
  }
  const values = new Float32Array(attribute.count * 3)
  for (let index = 0; index < attribute.count; index += 1) {
    const offset = index * 3
    values[offset] = attribute.getX(index)
    values[offset + 1] = attribute.getY(index)
    values[offset + 2] = attribute.getZ(index)
  }
  return values
}

function buildRuntimeInventory(
  root: THREE.Object3D,
  manifest: AppearanceDialsManifest,
  faceMeshes: Set<THREE.Mesh>
): {
  inventory: AppearanceRuntimeInventory
  nodesByRuntimeId: Map<string, THREE.Object3D>
  morphBindings: Map<string, RuntimeMorphBinding>
} {
  const nodesByRuntimeId = new Map<string, THREE.Object3D>()
  const morphBindings = new Map<string, RuntimeMorphBinding>()
  const nodes: AppearanceRuntimeInventory['nodes'] = []
  const faceBindings: AppearanceRuntimeInventory['faceBindings'] = []
  const mappedFaceMorphNames = new Set(manifest.mappedFaceMorphNames)
  const declaredNodeNames = new Set(Object.values(manifest.nodes).map((entry) => entry.node))
  const selectedNodes: THREE.Object3D[] = []

  root.traverse((node) => {
    if (declaredNodeNames.has(node.name) || faceMeshes.has(node as THREE.Mesh)) {
      selectedNodes.push(node)
    }
  })
  const selectedNodeSet = new Set(selectedNodes)

  for (const node of selectedNodes) {
    const runtimeId = node.uuid
    nodesByRuntimeId.set(runtimeId, node)
    const mesh = node as THREE.Mesh
    const isMesh = Boolean((mesh as { isMesh?: boolean }).isMesh)
    const dict = isMesh ? (mesh.morphTargetDictionary ?? {}) : {}
    const influences = isMesh ? mesh.morphTargetInfluences : undefined
    const morphs = Object.entries(dict)
      .map(([name, index]) => ({
        name,
        index,
        initialWeight: Array.isArray(influences) ? (influences[index] ?? 0) : 0
      }))
      .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name))
    for (const morph of morphs) {
      morphBindings.set(morphRuntimeKey(runtimeId, morph.index), {
        mesh,
        index: morph.index,
        morph: morph.name
      })
      if (
        faceMeshes.has(mesh) &&
        mappedFaceMorphNames.has(normalizeFaceMorphCollisionName(morph.name))
      ) {
        faceBindings.push({ runtimeNodeId: runtimeId, morph: morph.name })
      }
    }
    nodes.push({
      runtimeId,
      node: node.name,
      kind: isMesh ? 'mesh' : 'anchor',
      ...(node.parent && selectedNodeSet.has(node.parent)
        ? { parentRuntimeId: node.parent.uuid }
        : {}),
      ...(node.parent && (node.parent as { isBone?: boolean }).isBone
        ? { parentBone: node.parent.name }
        : {}),
      localScale: [node.scale.x, node.scale.y, node.scale.z],
      morphs
    })
  }

  return {
    inventory: { nodes, faceBindings },
    nodesByRuntimeId,
    morphBindings
  }
}

function followerDeltaMatrix(entry: ResolvedAppearanceFollowerNodeTransform): THREE.Matrix4 {
  const translation = new THREE.Matrix4().makeTranslation(...entry.translation)
  const pivot = new THREE.Matrix4().makeTranslation(...entry.pivot)
  const inversePivot = new THREE.Matrix4().makeTranslation(
    -entry.pivot[0],
    -entry.pivot[1],
    -entry.pivot[2]
  )
  const rotation = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(...entry.rotation)
  )
  const scale = new THREE.Matrix4().makeScale(...entry.scale)
  return translation.multiply(pivot).multiply(rotation).multiply(scale).multiply(inversePivot)
}

/**
 * THREE.js application layer for the strict appearance-dials/v2 contract.
 * The pure parser/resolver owns semantics; this class owns exact runtime
 * inventory binding, rest capture, deterministic writes, and complete reset.
 */
export class AppearanceDialsEngineRuntime {
  readonly manifest: AppearanceDialsManifest
  readonly ownedFaceMorphNames: Set<string>

  private readonly root: THREE.Object3D
  private readonly targetBindings = new Map<string, RuntimeMorphBinding[]>()
  private readonly bakedTargetBindings = new Map<string, RuntimeBakedMorphBinding[]>()
  private readonly followerMorphBindings = new Map<string, RuntimeMorphBinding>()
  private readonly bakedFollowerMorphBindings = new Map<string, RuntimeBakedMorphBinding>()
  private readonly bakedMeshes = new Set<RuntimeBakedMesh>()
  private readonly followerNodes = new Map<string, RuntimeFollowerNode>()
  private readonly bones = new Map<string, RuntimeBone>()
  private readonly skins: RuntimeSkin[] = []
  private readonly rootBase: { scale: THREE.Vector3; positionY: number }
  private hipsRemap: HipsClipRemap | null = null
  private values: unknown
  private state: ResolvedAppearanceDialState

  constructor(
    root: THREE.Object3D,
    rawManifest: GoonCustomAvatarManifest,
    options: AppearanceDialsEngineOptions = {}
  ) {
    const manifest = parseAppearanceDialsManifest(rawManifest)
    if (!manifest) {
      throw new Error('appearance-dials/v2 runtime requires avatar.json#appearanceDials')
    }
    this.root = root
    this.manifest = manifest
    this.values = options.initialValues ?? null
    this.rootBase = { scale: root.scale.clone(), positionY: root.position.y }

    const faceMeshes = new Set(options.faceMeshes ?? [])
    const built = buildRuntimeInventory(root, manifest, faceMeshes)
    const validated = validateAppearanceRuntimeInventory(manifest, built.inventory)

    const recipeRuntimeKeys = new Set<string>()
    for (const binding of validated.bindings) {
      if (manifest.targets[binding.target]?.runtimeRetention === 'recipe-only') {
        recipeRuntimeKeys.add(morphRuntimeKey(binding.runtimeNodeId, binding.index))
      }
    }
    for (const binding of validated.followerMorphBindings) {
      recipeRuntimeKeys.add(morphRuntimeKey(binding.runtimeNodeId, binding.index))
    }
    const bakedByRuntimeKey = this.prepareRecipeBaking(built.morphBindings, recipeRuntimeKeys)

    for (const binding of validated.bindings) {
      const key = morphRuntimeKey(binding.runtimeNodeId, binding.index)
      const runtime = built.morphBindings.get(key)
      if (!runtime) {
        throw new Error(`appearance target ${binding.target} lost its validated runtime binding`)
      }
      const baked = bakedByRuntimeKey.get(key)
      if (baked) {
        const entries = this.bakedTargetBindings.get(binding.target) ?? []
        entries.push(baked)
        this.bakedTargetBindings.set(binding.target, entries)
      } else {
        const entries = this.targetBindings.get(binding.target) ?? []
        entries.push(runtime)
        this.targetBindings.set(binding.target, entries)
      }
    }
    for (const binding of validated.followerMorphBindings) {
      const key = morphRuntimeKey(binding.runtimeNodeId, binding.index)
      const runtime = built.morphBindings.get(key)
      if (!runtime) {
        throw new Error(
          `appearance follower ${binding.follower}/${binding.channel} lost its runtime binding`
        )
      }
      const followerKey = binding.follower + '\u0000' + binding.channel
      const baked = bakedByRuntimeKey.get(key)
      if (baked) {
        this.bakedFollowerMorphBindings.set(followerKey, baked)
      } else {
        this.followerMorphBindings.set(followerKey, runtime)
      }
    }
    for (const [manifestNodeId, runtimeId] of validated.runtimeNodeIdsByManifestNode) {
      const node = built.nodesByRuntimeId.get(runtimeId)
      if (!node) {
        throw new Error(`appearance node ${manifestNodeId} lost its validated runtime object`)
      }
      this.followerNodes.set(manifestNodeId, {
        node,
        baseMatrix: node.matrix.clone().compose(node.position, node.quaternion, node.scale)
      })
    }

    this.ownedFaceMorphNames = new Set<string>()
    for (const binding of [...validated.bindings, ...validated.followerMorphBindings]) {
      this.ownedFaceMorphNames.add(normalizeFaceMorphCollisionName(binding.morph))
    }

    this.captureRig()
    this.state = resolveAppearanceDialState(manifest, this.values)
    this.applyResolvedState(this.state)
  }

  /**
   * Identity targets are authoring recipes, not live animation channels. Keep
   * their CPU deltas for dial edits, then remove them from the mesh morph
   * inventory before the renderer sees the geometry. This keeps WebGPU/WebGL
   * shaders proportional to the dynamic face/corrective set instead of the
   * full identity catalog.
   */
  private prepareRecipeBaking(
    morphBindings: Map<string, RuntimeMorphBinding>,
    recipeRuntimeKeys: Set<string>
  ): Map<string, RuntimeBakedMorphBinding> {
    const recipeIndicesByMesh = new Map<THREE.Mesh, Set<number>>()
    for (const key of recipeRuntimeKeys) {
      const binding = morphBindings.get(key)
      if (!binding) continue
      const indices = recipeIndicesByMesh.get(binding.mesh) ?? new Set<number>()
      indices.add(binding.index)
      recipeIndicesByMesh.set(binding.mesh, indices)
    }

    const bakedByRuntimeKey = new Map<string, RuntimeBakedMorphBinding>()
    for (const [mesh, recipeIndices] of recipeIndicesByMesh) {
      const geometry = mesh.geometry
      const sourcePosition = geometry.getAttribute('position')
      if (!sourcePosition) {
        throw new Error(`appearance recipe mesh ${mesh.name || mesh.uuid} has no POSITION attribute`)
      }
      const basePosition = readVec3Attribute(sourcePosition).slice()
      const position = new THREE.Float32BufferAttribute(basePosition.slice(), 3)
      position.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute('position', position)
      const originalMorphPositions = geometry.morphAttributes.position ?? []
      const originalInfluences = mesh.morphTargetInfluences ?? []
      const originalDictionary = mesh.morphTargetDictionary ?? {}
      const retainedIndices = originalMorphPositions
        .map((_, index) => index)
        .filter((index) => !recipeIndices.has(index))
      const bakedMesh: RuntimeBakedMesh = {
        mesh,
        position,
        basePosition,
        bakedBasePosition: basePosition.slice()
      }
      this.bakedMeshes.add(bakedMesh)

      for (const [key, binding] of morphBindings) {
        if (binding.mesh !== mesh || !recipeIndices.has(binding.index)) continue
        const morphPosition = geometry.morphAttributes.position?.[binding.index]
        if (!morphPosition) {
          throw new Error(
            `appearance recipe morph ${mesh.name || mesh.uuid}/${binding.morph} has no POSITION delta`
          )
        }
        let delta = readVec3Attribute(morphPosition)
        if (!geometry.morphTargetsRelative) {
          delta = delta.slice()
          for (let index = 0; index < delta.length; index += 1) {
            delta[index] -= basePosition[index] ?? 0
          }
        }
        bakedByRuntimeKey.set(key, { runtime: bakedMesh, delta })
      }

      const oldToNew = new Map(retainedIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]))
      for (const attributeName of ['position', 'normal', 'color'] as const) {
        const originalAttributes = geometry.morphAttributes[attributeName]
        if (!originalAttributes) {
          delete geometry.morphAttributes[attributeName]
          continue
        }
        const retainedAttributes = retainedIndices.map((index) => originalAttributes[index])
        if (retainedAttributes.some((attribute) => !attribute)) {
          throw new Error(
            `appearance live morph ${mesh.name || mesh.uuid} has incomplete ${attributeName.toUpperCase()} payloads`
          )
        }
        if (retainedAttributes.length > 0) {
          geometry.morphAttributes[attributeName] = retainedAttributes as THREE.BufferAttribute[]
        } else {
          // Three's WebGPU MorphNode treats an existing empty array as an
          // enabled morph channel. Delete zero-length inventories entirely.
          delete geometry.morphAttributes[attributeName]
        }
      }
      mesh.morphTargetDictionary = Object.fromEntries(
        Object.entries(originalDictionary)
          .filter(([, index]) => oldToNew.has(index))
          .map(([name, index]) => [name, oldToNew.get(index)!])
      )
      mesh.morphTargetInfluences = retainedIndices.map((index) => originalInfluences[index] ?? 0)

      for (const binding of morphBindings.values()) {
        if (binding.mesh !== mesh || recipeIndices.has(binding.index)) continue
        const newIndex = oldToNew.get(binding.index)
        if (newIndex === undefined) {
          throw new Error(`appearance live morph ${mesh.name || mesh.uuid}/${binding.morph} lost its index`)
        }
        binding.index = newIndex
      }
    }
    return bakedByRuntimeKey
  }

  private captureRig() {
    this.root.updateMatrixWorld(true)
    const rootInverse = this.root.matrixWorld.clone().invert()
    const boneNodes: THREE.Object3D[] = []
    this.root.traverse((node) => {
      if ((node as { isBone?: boolean }).isBone) boneNodes.push(node)
      const skinned = node as THREE.SkinnedMesh
      if ((skinned as { isSkinnedMesh?: boolean }).isSkinnedMesh && skinned.skeleton) {
        this.skins.push({
          mesh: skinned,
          baseInverses: skinned.skeleton.boneInverses.map((matrix) => matrix.clone())
        })
      }
    })
    for (const node of boneNodes) {
      const parent = node.parent
      const parentRelative = new THREE.Matrix4()
      if (parent) {
        parent.updateWorldMatrix(true, false)
        parentRelative.multiplyMatrices(rootInverse, parent.matrixWorld)
      }
      const parentQuaternion = new THREE.Quaternion()
      parentRelative.decompose(new THREE.Vector3(), parentQuaternion, new THREE.Vector3())
      const entry: RuntimeBone = {
        node,
        baseLocalPosition: node.position.clone(),
        parentBaseRelQuaternion: parentQuaternion,
        parent
      }
      this.bones.set(node.name, entry)
      this.bones.set(sanitizeCustomRuntimeNodeName(node.name), entry)
    }

    const hipsName = this.manifest.jointFollow?.clipRemap?.hipsBone
    const hips = hipsName ? this.resolveBone(hipsName) : null
    if (hips) {
      this.hipsRemap = {
        node: hips,
        baseRest: hips.position.clone(),
        newRest: hips.position.clone(),
        ratio: 1,
        lastOutput: null
      }
    }
  }

  getState(): ResolvedAppearanceDialState {
    return this.state
  }

  getValues(): unknown {
    return this.values
  }

  resolveBone(name: string): THREE.Object3D | null {
    return this.bones.get(name)?.node ?? this.bones.get(sanitizeCustomRuntimeNodeName(name))?.node ?? null
  }

  setValues(values: AppearanceDialValueState | null | undefined): ResolvedAppearanceDialState {
    this.values = values ?? null
    this.state = resolveAppearanceDialState(this.manifest, this.values)
    this.applyResolvedState(this.state)
    return this.state
  }

  applyTargetInfluences(influences: Map<string, number>) {
    for (const [targetId, value] of influences) {
      for (const binding of this.targetBindings.get(targetId) ?? []) {
        const weights = binding.mesh.morphTargetInfluences
        if (Array.isArray(weights)) weights[binding.index] = value
      }
    }
  }

  private applyResolvedState(state: ResolvedAppearanceDialState) {
    this.applyTargetInfluences(state.influences)
    this.applyBakedGeometry(state)
    this.applyJointOffsets(state.jointOffsets)
    this.applyFollowers(state)
    this.root.scale.copy(this.rootBase.scale).multiplyScalar(state.rootScale)
    this.root.position.y = this.rootBase.positionY - state.soleOffsetY * state.rootScale
    this.root.updateMatrixWorld(true)
  }

  private applyBakedGeometry(state: ResolvedAppearanceDialState) {
    if (this.bakedMeshes.size === 0) return
    for (const baked of this.bakedMeshes) {
      const position = baked.position.array as Float32Array
      position.set(baked.basePosition)
    }

    const apply = (binding: RuntimeBakedMorphBinding, weight: number) => {
      if (Math.abs(weight) <= 1e-8) return
      const output = binding.runtime.position.array as Float32Array
      for (let index = 0; index < output.length; index += 1) {
        output[index] += (binding.delta[index] ?? 0) * weight
      }
    }
    for (const [targetId, weight] of state.influences) {
      for (const binding of this.bakedTargetBindings.get(targetId) ?? []) {
        apply(binding, weight)
      }
    }
    for (const morph of state.followerState.morphs) {
      const binding = this.bakedFollowerMorphBindings.get(
        morph.follower + '\u0000' + morph.channel
      )
      if (binding) apply(binding, morph.weight)
    }

    for (const baked of this.bakedMeshes) {
      const position = baked.position.array as Float32Array
      baked.bakedBasePosition.set(position)
      // Recipe morphs mutate the CPU-side base POSITION array after the mesh
      // may already have rendered. WebGPU/WebGL only uploads that new geometry
      // when the attribute version advances.
      baked.position.needsUpdate = true
    }
    for (const baked of this.bakedMeshes) {
      baked.mesh.geometry.computeVertexNormals()
      baked.mesh.geometry.computeBoundingBox()
      baked.mesh.geometry.computeBoundingSphere()
    }
  }

  private applyJointOffsets(offsetsByName: Map<string, AppearanceVec3>) {
    const offsets = new Map<THREE.Object3D, THREE.Vector3>()
    for (const [boneName, delta] of offsetsByName) {
      const entry = this.bones.get(boneName) ?? this.bones.get(sanitizeCustomRuntimeNodeName(boneName))
      if (entry) offsets.set(entry.node, new THREE.Vector3(...delta))
    }

    const zero = new THREE.Vector3()
    const scratch = new THREE.Vector3()
    const inverseParentQuaternion = new THREE.Quaternion()
    for (const entry of new Set(this.bones.values())) {
      const own = offsets.get(entry.node) ?? zero
      const parentEntry = entry.parent
        ? (this.bones.get(entry.parent.name) ??
          this.bones.get(sanitizeCustomRuntimeNodeName(entry.parent.name)))
        : null
      const parentOffset = parentEntry ? (offsets.get(parentEntry.node) ?? zero) : zero
      scratch.subVectors(own, parentOffset)
      if (scratch.lengthSq() === 0) {
        entry.node.position.copy(entry.baseLocalPosition)
      } else {
        inverseParentQuaternion.copy(entry.parentBaseRelQuaternion).invert()
        scratch.applyQuaternion(inverseParentQuaternion)
        entry.node.position.copy(entry.baseLocalPosition).add(scratch)
      }
    }

    const translation = new THREE.Matrix4()
    for (const skin of this.skins) {
      for (let index = 0; index < skin.mesh.skeleton.bones.length; index += 1) {
        const offset = offsets.get(skin.mesh.skeleton.bones[index])
        const inverse = skin.mesh.skeleton.boneInverses[index]
        const baseInverse = skin.baseInverses[index]
        if (!inverse || !baseInverse) continue
        if (!offset || offset.lengthSq() === 0) {
          inverse.copy(baseInverse)
        } else {
          translation.makeTranslation(-offset.x, -offset.y, -offset.z)
          inverse.copy(baseInverse).multiply(translation)
        }
      }
      skin.mesh.skeleton.update()
    }

    if (this.hipsRemap) {
      const hipsEntry = this.bones.get(this.hipsRemap.node.name)
      if (hipsEntry) {
        this.hipsRemap.newRest.copy(hipsEntry.node.position)
        this.hipsRemap.ratio =
          Math.abs(this.hipsRemap.baseRest.y) > 1e-6
            ? this.hipsRemap.newRest.y / this.hipsRemap.baseRest.y
            : 1
        this.hipsRemap.lastOutput = this.hipsRemap.node.position.clone()
      }
    }
  }

  private applyFollowers(state: ResolvedAppearanceDialState) {
    const transformsByNode = new Map<string, ResolvedAppearanceFollowerNodeTransform[]>()
    for (const transform of state.followerState.nodeTransforms) {
      const entries = transformsByNode.get(transform.node) ?? []
      entries.push(transform)
      transformsByNode.set(transform.node, entries)
    }

    for (const [nodeId, runtime] of this.followerNodes) {
      const transforms = transformsByNode.get(nodeId) ?? []
      const composed = runtime.baseMatrix.clone()
      for (const transform of transforms) {
        composed.premultiply(followerDeltaMatrix(transform))
      }
      composed.decompose(runtime.node.position, runtime.node.quaternion, runtime.node.scale)
    }

    for (const morph of state.followerState.morphs) {
      const binding = this.followerMorphBindings.get(morph.follower + '\u0000' + morph.channel)
      if (!binding) continue
      const weights = binding.mesh.morphTargetInfluences
      if (Array.isArray(weights)) weights[binding.index] = morph.weight
    }
  }

  applyHipsClipRemap() {
    const remap = this.hipsRemap
    if (!remap) return
    if (remap.ratio === 1 && remap.newRest.equals(remap.baseRest)) return
    const position = remap.node.position
    if (remap.lastOutput && position.equals(remap.lastOutput)) return
    position.set(
      remap.newRest.x + remap.ratio * (position.x - remap.baseRest.x),
      remap.newRest.y + remap.ratio * (position.y - remap.baseRest.y),
      remap.newRest.z + remap.ratio * (position.z - remap.baseRest.z)
    )
    remap.lastOutput = remap.lastOutput ? remap.lastOutput.copy(position) : position.clone()
  }
}

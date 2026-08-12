import * as THREE from 'three'

import type {
  HairRootWeightedMotionV2,
  ResolvedSecondaryMotionColliderV1,
  ResolvedSecondaryMotionChainV1,
  ResolvedSecondaryMotionSegmentV1,
  SecondaryMotionRuntimeDefinition,
  SecondaryMotionTuning,
  SecondaryMotionVec3
} from './secondaryMotion'
import {
  HAIR_MOTION_ANCHORED_LENGTH_MAX,
  HAIR_MOTION_ANCHORED_LENGTH_MIN,
  HAIR_MOTION_INTENSITY_MAX,
  HAIR_MOTION_INTENSITY_MIN,
  HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
  HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
  HAIR_MOTION_WEIGHT_CURVE
} from './secondaryMotion'

export type SecondaryMotionRuntimeSnapshot = {
  accumulatorSeconds: number
  resetCount: number
  segments: Array<{
    node: string
    speed: number
    stretchRatio: number
    angleRadians: number
    maximumPenetration: number
    resolvedPenetration: number
  }>
}

type ColliderRuntime = ResolvedSecondaryMotionColliderV1 & {
  object: THREE.Object3D
  offsetVector: THREE.Vector3
  tailOffsetVector: THREE.Vector3
}

type SegmentRuntime = {
  definition: ResolvedSecondaryMotionSegmentV1
  collisionGroups: ReadonlySet<string>
  node: THREE.Object3D
  wrapper: THREE.Object3D
  ownsWrapper: boolean
  originalParent: THREE.Object3D
  originalIndex: number
  originalPosition: THREE.Vector3
  originalQuaternion: THREE.Quaternion
  originalScale: THREE.Vector3
  originalMatrixAutoUpdate: boolean
  pivot: THREE.Vector3
  tip: THREE.Vector3
  currentTip: THREE.Vector3
  velocity: THREE.Vector3
  restLength: number
  maximumPenetration: number
  restColliderPenetrations: Map<string, Float64Array>
  weightedMotion: WeightedMotionRuntime | null
}

type WeightedMotionRuntime = {
  definition: HairRootWeightedMotionV2
  mesh: THREE.SkinnedMesh
  tipRatios: THREE.BufferAttribute
  skinWeights: THREE.BufferAttribute
  originalSkinWeights: Float32Array
  originalBoneInverses: THREE.Matrix4[]
  originalBindMatrix: THREE.Matrix4
  originalBindMatrixInverse: THREE.Matrix4
}

type SecondaryMotionScratch = {
  stepTargetPivot: THREE.Vector3
  stepTargetTip: THREE.Vector3
  stepAcceleration: THREE.Vector3
  stepRadial: THREE.Vector3
  constrainRestDirection: THREE.Vector3
  constrainDirection: THREE.Vector3
  constrainRotation: THREE.Quaternion
  constrainLimitedRotation: THREE.Quaternion
  collisionDirection: THREE.Vector3
  collisionSample: THREE.Vector3
  colliderStart: THREE.Vector3
  colliderEnd: THREE.Vector3
  colliderClosest: THREE.Vector3
  collisionSeparation: THREE.Vector3
  closestPointDirection: THREE.Vector3
  closestPointOffset: THREE.Vector3
  applyTargetPivot: THREE.Vector3
  applyTargetTip: THREE.Vector3
  applyRestDirection: THREE.Vector3
  applyCurrentDirection: THREE.Vector3
  applyWorldDelta: THREE.Quaternion
  applyWeightedWorldDelta: THREE.Quaternion
  applyParentWorldQuaternion: THREE.Quaternion
  identityQuaternion: THREE.Quaternion
}

const SAMPLE_FACTORS = [0.45, 0.7, 1] as const
const EPSILON = 1e-8
const ROOT_WEIGHTED_RESPONSE_GAIN = 3

function fail(message: string): never {
  throw new Error(`[secondary-motion/runtime-v1] ${message}`)
}

function vector(value: SecondaryMotionVec3): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2])
}

function findUniqueNode(root: THREE.Object3D, name: string, context: string): THREE.Object3D {
  const matches: THREE.Object3D[] = []
  root.traverse((object) => {
    if (object.name === name) matches.push(object)
  })
  if (matches.length !== 1) {
    fail(`${context} node ${name} must resolve exactly once; found ${matches.length}`)
  }
  return matches[0]!
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function parseWeightedMotion(value: unknown, context: string): HairRootWeightedMotionV2 | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${context} must be an object`)
  const raw = value as Record<string, unknown>
  const expected = [
    'contract',
    'meshNode',
    'tipAttribute',
    'dynamicJointSlot',
    'anchoredLength',
    'weightCurve',
    'defaultEnabled',
    'defaultIntensity'
  ].sort()
  const actual = Object.keys(raw).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${context} must contain exactly: ${expected.join(', ')}`)
  }
  if (raw.contract !== HAIR_ROOT_WEIGHTED_MOTION_CONTRACT) {
    fail(`${context}.contract must equal ${HAIR_ROOT_WEIGHTED_MOTION_CONTRACT}`)
  }
  if (raw.tipAttribute !== HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE) {
    fail(`${context}.tipAttribute must equal ${HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE}`)
  }
  if (typeof raw.meshNode !== 'string' || !raw.meshNode.trim()) {
    fail(`${context}.meshNode must be a non-empty string`)
  }
  if (!Number.isSafeInteger(raw.dynamicJointSlot) || (raw.dynamicJointSlot as number) < 1) {
    fail(`${context}.dynamicJointSlot must be a positive safe integer`)
  }
  const anchoredLength = finiteNumber(raw.anchoredLength, `${context}.anchoredLength`)
  if (
    anchoredLength < HAIR_MOTION_ANCHORED_LENGTH_MIN ||
    anchoredLength > HAIR_MOTION_ANCHORED_LENGTH_MAX
  ) {
    fail(`${context}.anchoredLength is outside the supported authoring range`)
  }
  if (raw.weightCurve !== HAIR_MOTION_WEIGHT_CURVE) {
    fail(`${context}.weightCurve must equal ${HAIR_MOTION_WEIGHT_CURVE}`)
  }
  if (typeof raw.defaultEnabled !== 'boolean') {
    fail(`${context}.defaultEnabled must be boolean`)
  }
  const defaultIntensity = finiteNumber(raw.defaultIntensity, `${context}.defaultIntensity`)
  if (defaultIntensity < HAIR_MOTION_INTENSITY_MIN || defaultIntensity > HAIR_MOTION_INTENSITY_MAX) {
    fail(`${context}.defaultIntensity is outside the supported review range`)
  }
  return {
    contract: HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
    meshNode: raw.meshNode,
    tipAttribute: HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
    dynamicJointSlot: raw.dynamicJointSlot as number,
    anchoredLength,
    weightCurve: HAIR_MOTION_WEIGHT_CURVE,
    defaultEnabled: raw.defaultEnabled,
    defaultIntensity
  }
}

function reorderChild(parent: THREE.Object3D, child: THREE.Object3D, index: number): void {
  const currentIndex = parent.children.indexOf(child)
  if (currentIndex < 0) fail(`runtime child ${child.name || child.uuid} lost its parent`)
  parent.children.splice(currentIndex, 1)
  parent.children.splice(Math.min(index, parent.children.length), 0, child)
}

function closestPointOnSegment(
  point: THREE.Vector3,
  start: THREE.Vector3,
  end: THREE.Vector3,
  target: THREE.Vector3,
  directionScratch: THREE.Vector3,
  offsetScratch: THREE.Vector3
): THREE.Vector3 {
  const direction = directionScratch.copy(end).sub(start)
  const lengthSquared = direction.lengthSq()
  if (lengthSquared <= EPSILON) return target.copy(start)
  const parameter = THREE.MathUtils.clamp(
    offsetScratch.copy(point).sub(start).dot(direction) / lengthSquared,
    0,
    1
  )
  return target.copy(start).addScaledVector(direction, parameter)
}

export class SecondaryMotionEngineRuntime {
  readonly definition: SecondaryMotionRuntimeDefinition
  private readonly assetRoot: THREE.Object3D
  private readonly avatarRoot: THREE.Object3D
  private readonly segments: SegmentRuntime[]
  private colliders: ColliderRuntime[]
  private accumulatorSeconds = 0
  private resetCount = 0
  private disposed = false
  private motionTuning: SecondaryMotionTuning | null = null
  private readonly gravity: THREE.Vector3
  private readonly scratch: SecondaryMotionScratch = {
    stepTargetPivot: new THREE.Vector3(),
    stepTargetTip: new THREE.Vector3(),
    stepAcceleration: new THREE.Vector3(),
    stepRadial: new THREE.Vector3(),
    constrainRestDirection: new THREE.Vector3(),
    constrainDirection: new THREE.Vector3(),
    constrainRotation: new THREE.Quaternion(),
    constrainLimitedRotation: new THREE.Quaternion(),
    collisionDirection: new THREE.Vector3(),
    collisionSample: new THREE.Vector3(),
    colliderStart: new THREE.Vector3(),
    colliderEnd: new THREE.Vector3(),
    colliderClosest: new THREE.Vector3(),
    collisionSeparation: new THREE.Vector3(),
    closestPointDirection: new THREE.Vector3(),
    closestPointOffset: new THREE.Vector3(),
    applyTargetPivot: new THREE.Vector3(),
    applyTargetTip: new THREE.Vector3(),
    applyRestDirection: new THREE.Vector3(),
    applyCurrentDirection: new THREE.Vector3(),
    applyWorldDelta: new THREE.Quaternion(),
    applyWeightedWorldDelta: new THREE.Quaternion(),
    applyParentWorldQuaternion: new THREE.Quaternion(),
    identityQuaternion: new THREE.Quaternion()
  }

  constructor(
    assetRoot: THREE.Object3D,
    avatarRoot: THREE.Object3D,
    definition: SecondaryMotionRuntimeDefinition
  ) {
    this.assetRoot = assetRoot
    this.avatarRoot = avatarRoot
    this.definition = definition
    this.gravity = vector(definition.simulation.gravity)
    this.colliders = this.bindColliders(definition.colliders)
    this.assetRoot.updateMatrixWorld(true)
    const segments: SegmentRuntime[] = []
    try {
      for (const chain of definition.chains) {
        for (const segment of chain.segments) {
          segments.push(this.bindSegment(segment))
        }
      }
    } catch (error) {
      this.restoreSegments(segments)
      throw error
    }
    this.segments = segments
    this.rebaseWeightedMotionJoints()
    const weighted = segments.flatMap((segment) =>
      segment.weightedMotion ? [segment.weightedMotion.definition] : []
    )
    if (weighted.length > 0) {
      if (weighted.length !== segments.length) {
        this.restoreSegments(segments)
        fail('root-weighted and rigid segments may not be mixed in one runtime')
      }
      const first = weighted[0]!
      if (
        weighted.some(
          (entry) =>
            entry.defaultEnabled !== first.defaultEnabled ||
            entry.defaultIntensity !== first.defaultIntensity
        )
      ) {
        this.restoreSegments(segments)
        fail('root-weighted segments must share one authored tuning default')
      }
      this.motionTuning = {
        enabled: first.defaultEnabled,
        intensity: first.defaultIntensity
      }
    }
    this.refreshRestColliderPenetrations()
    this.reset()
  }

  private bindSegment(definition: ResolvedSecondaryMotionSegmentV1): SegmentRuntime {
    const node = findUniqueNode(this.assetRoot, definition.node, 'motion')
    if (node === this.assetRoot) fail('the asset root itself cannot be a motion segment')
    const originalParent = node.parent
    if (!originalParent) fail(`motion node ${definition.node} has no parent`)
    const originalIndex = originalParent.children.indexOf(node)
    node.updateMatrix()
    const originalPosition = node.position.clone()
    const originalQuaternion = node.quaternion.clone()
    const originalScale = node.scale.clone()
    const originalMatrixAutoUpdate = node.matrixAutoUpdate
    const originalLocalMatrix = node.matrix.clone()

    const weightedDefinition = parseWeightedMotion(
      node.userData?.batshitHairRootWeightedMotion,
      `motion node ${definition.node}.batshitHairRootWeightedMotion`
    )
    if (weightedDefinition) {
      if (!(node as THREE.Bone).isBone) {
        fail(`root-weighted motion node ${definition.node} must be a Bone`)
      }
      const meshObject = findUniqueNode(
        this.assetRoot,
        weightedDefinition.meshNode,
        'root-weighted motion mesh'
      )
      if (!(meshObject as THREE.SkinnedMesh).isSkinnedMesh) {
        fail(`root-weighted motion mesh ${weightedDefinition.meshNode} must be a SkinnedMesh`)
      }
      const mesh = meshObject as THREE.SkinnedMesh
      if (mesh.skeleton.bones[weightedDefinition.dynamicJointSlot] !== node) {
        fail(`root-weighted motion node ${definition.node} does not own its declared joint slot`)
      }
      const tipRatios = mesh.geometry.getAttribute(weightedDefinition.tipAttribute)
      const skinIndices = mesh.geometry.getAttribute('skinIndex')
      const skinWeights = mesh.geometry.getAttribute('skinWeight')
      if (
        !(tipRatios instanceof THREE.BufferAttribute) ||
        tipRatios.itemSize !== 1 ||
        !(skinIndices instanceof THREE.BufferAttribute) ||
        skinIndices.itemSize !== 4 ||
        !(skinWeights instanceof THREE.BufferAttribute) ||
        skinWeights.itemSize !== 4 ||
        tipRatios.count !== skinIndices.count ||
        tipRatios.count !== skinWeights.count
      ) {
        fail(
          `root-weighted motion mesh ${weightedDefinition.meshNode} has invalid weight attributes`
        )
      }
      const declaredMotionSlots = new Set<number>()
      const runtimeMotionNodes = new Set(
        this.definition.chains.flatMap((chain) =>
          chain.segments.map((segment) => segment.node)
        )
      )
      for (let slot = 1; slot < mesh.skeleton.bones.length; slot += 1) {
        const bone = mesh.skeleton.bones[slot]!
        const candidate = parseWeightedMotion(
          bone.userData?.batshitHairRootWeightedMotion,
          `motion bone ${bone.name || slot}.batshitHairRootWeightedMotion`
        )
        if (
          !candidate ||
          candidate.meshNode !== weightedDefinition.meshNode ||
          !runtimeMotionNodes.has(bone.name)
        ) {
          continue
        }
        if (candidate.dynamicJointSlot !== slot) {
          fail(
            `root-weighted motion bone ${bone.name || slot} does not own its declared joint slot`
          )
        }
        declaredMotionSlots.add(slot)
      }
      let ownsWeightedVertex = false
      for (let vertex = 0; vertex < skinIndices.count; vertex += 1) {
        const dynamicJointSlot = skinIndices.getY(vertex)
        const rootWeight = skinWeights.getX(vertex)
        const dynamicWeight = skinWeights.getY(vertex)
        const unusedWeightZ = skinWeights.getZ(vertex)
        const unusedWeightW = skinWeights.getW(vertex)
        const tipRatio = tipRatios.getX(vertex)
        if (
          skinIndices.getX(vertex) !== 0 ||
          skinIndices.getZ(vertex) !== 0 ||
          skinIndices.getW(vertex) !== 0 ||
          !Number.isSafeInteger(dynamicJointSlot) ||
          (dynamicJointSlot !== 0 && !declaredMotionSlots.has(dynamicJointSlot))
        ) {
          fail(
            `root-weighted motion mesh ${weightedDefinition.meshNode} has an invalid joint tuple at vertex ${vertex}`
          )
        }
        if (
          !Number.isFinite(rootWeight) ||
          !Number.isFinite(dynamicWeight) ||
          !Number.isFinite(unusedWeightZ) ||
          !Number.isFinite(unusedWeightW) ||
          !Number.isFinite(tipRatio) ||
          rootWeight < 0 ||
          dynamicWeight < 0 ||
          Math.abs(unusedWeightZ) > EPSILON ||
          Math.abs(unusedWeightW) > EPSILON ||
          Math.abs(rootWeight + dynamicWeight - 1) > 1e-5 ||
          tipRatio < 0 ||
          tipRatio > 1 ||
          (dynamicJointSlot === 0 && dynamicWeight > EPSILON)
        ) {
          fail(
            `root-weighted motion mesh ${weightedDefinition.meshNode} has invalid weights at vertex ${vertex}`
          )
        }
        if (
          dynamicJointSlot === weightedDefinition.dynamicJointSlot &&
          dynamicWeight > EPSILON
        ) {
          ownsWeightedVertex = true
        }
      }
      if (!ownsWeightedVertex) {
        fail(
          `root-weighted motion node ${definition.node} has no positively weighted vertices in its declared joint slot`
        )
      }
      return {
        definition,
        collisionGroups: new Set(definition.collisionGroups),
        node,
        wrapper: node,
        ownsWrapper: false,
        originalParent,
        originalIndex,
        originalPosition,
        originalQuaternion,
        originalScale,
        originalMatrixAutoUpdate,
        pivot: vector(definition.pivot),
        tip: vector(definition.tip),
        currentTip: this.assetRoot.localToWorld(vector(definition.tip)),
        velocity: new THREE.Vector3(),
        restLength: vector(definition.pivot).distanceTo(vector(definition.tip)),
        maximumPenetration: 0,
        restColliderPenetrations: new Map(),
        weightedMotion: {
          definition: weightedDefinition,
          mesh,
          tipRatios,
          skinWeights,
          originalSkinWeights: Float32Array.from(skinWeights.array),
          originalBoneInverses: mesh.skeleton.boneInverses.map((inverse) => inverse.clone()),
          originalBindMatrix: mesh.bindMatrix.clone(),
          originalBindMatrixInverse: mesh.bindMatrixInverse.clone()
        }
      }
    }

    const pivotWorld = this.assetRoot.localToWorld(vector(definition.pivot))
    const pivotParent = originalParent.worldToLocal(pivotWorld.clone())
    const wrapper = new THREE.Object3D()
    wrapper.name = `BatshitSecondaryMotion__${definition.node}`
    wrapper.position.copy(pivotParent)
    wrapper.updateMatrix()
    originalParent.add(wrapper)
    wrapper.add(node)
    reorderChild(originalParent, wrapper, originalIndex)
    const nextLocalMatrix = wrapper.matrix.clone().invert().multiply(originalLocalMatrix)
    nextLocalMatrix.decompose(node.position, node.quaternion, node.scale)
    node.matrixAutoUpdate = true
    node.updateMatrix()
    wrapper.updateMatrixWorld(true)

    const pivot = vector(definition.pivot)
    const tip = vector(definition.tip)
    return {
      definition,
      collisionGroups: new Set(definition.collisionGroups),
      node,
      wrapper,
      ownsWrapper: true,
      originalParent,
      originalIndex,
      originalPosition,
      originalQuaternion,
      originalScale,
      originalMatrixAutoUpdate,
      pivot,
      tip,
      currentTip: this.assetRoot.localToWorld(tip.clone()),
      velocity: new THREE.Vector3(),
      restLength: pivot.distanceTo(tip),
      maximumPenetration: 0,
      restColliderPenetrations: new Map(),
      weightedMotion: null
    }
  }

  getMotionTuning(): SecondaryMotionTuning | null {
    return this.motionTuning ? { ...this.motionTuning } : null
  }

  setMotionTuning(value: SecondaryMotionTuning): void {
    if (this.disposed) fail('cannot tune a disposed runtime')
    if (!this.motionTuning) fail('this secondary-motion runtime is not root-weighted')
    if (typeof value.enabled !== 'boolean') {
      fail('motion tuning enabled must be boolean')
    }
    const intensity = finiteNumber(value.intensity, 'motion tuning intensity')
    if (intensity < HAIR_MOTION_INTENSITY_MIN || intensity > HAIR_MOTION_INTENSITY_MAX) {
      fail('motion tuning intensity is outside the supported review range')
    }
    const wasEnabled = this.motionTuning.enabled
    this.motionTuning = { enabled: value.enabled, intensity }
    if (wasEnabled !== value.enabled) this.reset()
    this.applyRotations()
  }

  private rebaseWeightedMotionJoints(): void {
    const weightedSegments = this.segments.filter((segment) => segment.weightedMotion)
    if (weightedSegments.length === 0) return
    this.assetRoot.updateMatrixWorld(true)
    for (const segment of weightedSegments) {
      segment.node.position.copy(
        segment.originalParent.worldToLocal(this.assetRoot.localToWorld(segment.pivot.clone()))
      )
      segment.node.quaternion.copy(segment.originalQuaternion)
      segment.node.updateMatrix()
    }
    this.assetRoot.updateMatrixWorld(true)
    const meshes = new Set(weightedSegments.map((segment) => segment.weightedMotion!.mesh))
    for (const mesh of meshes) {
      // Rebind both halves of Three's skinning transform in the same frame.
      // Updating bone inverses alone captures the avatar's current animation
      // pose while leaving the old mesh bind matrix behind, which makes Hair
      // stay offset after that pose changes.
      mesh.bind(mesh.skeleton)
    }
  }

  private bindColliders(values: readonly ResolvedSecondaryMotionColliderV1[]): ColliderRuntime[] {
    return values.map((collider) => ({
      ...collider,
      object: findUniqueNode(this.avatarRoot, collider.node, 'collider'),
      offsetVector: vector(collider.offset),
      tailOffsetVector: vector(collider.tailOffset)
    }))
  }

  private refreshRestColliderPenetrations(): void {
    this.avatarRoot.updateMatrixWorld(true)
    this.assetRoot.updateMatrixWorld(true)
    const scratch = this.scratch
    for (const segment of this.segments) {
      segment.restColliderPenetrations.clear()
      const pivot = this.assetRoot.localToWorld(scratch.stepTargetPivot.copy(segment.pivot))
      const tip = this.assetRoot.localToWorld(scratch.stepTargetTip.copy(segment.tip))
      const direction = scratch.collisionDirection.copy(tip).sub(pivot)
      for (const collider of this.colliders) {
        if (!segment.collisionGroups.has(collider.group)) continue
        const values = new Float64Array(SAMPLE_FACTORS.length)
        for (const [sampleIndex, sampleFactor] of SAMPLE_FACTORS.entries()) {
          const sample = scratch.collisionSample
            .copy(pivot)
            .addScaledVector(direction, sampleFactor)
          const start = collider.object.localToWorld(
            scratch.colliderStart.copy(collider.offsetVector)
          )
          const end = collider.object.localToWorld(
            scratch.colliderEnd.copy(collider.tailOffsetVector)
          )
          const closest =
            collider.shape === 'sphere'
              ? start
              : closestPointOnSegment(
                  sample,
                  start,
                  end,
                  scratch.colliderClosest,
                  scratch.closestPointDirection,
                  scratch.closestPointOffset
                )
          values[sampleIndex] = Math.max(
            0,
            collider.radius + segment.definition.collisionRadius - sample.distanceTo(closest)
          )
        }
        segment.restColliderPenetrations.set(collider.id, values)
      }
    }
  }

  setResolvedColliders(values: readonly ResolvedSecondaryMotionColliderV1[]): void {
    if (this.disposed) fail('cannot update a disposed runtime')
    const ids = values.map((entry) => entry.id)
    const expected = this.definition.colliders.map((entry) => entry.id)
    if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
      fail('resolved collider inventory changed after runtime construction')
    }
    this.colliders = this.bindColliders(values)
    this.refreshRestColliderPenetrations()
    this.reset()
  }

  setResolvedState(
    chains: readonly ResolvedSecondaryMotionChainV1[],
    colliders: readonly ResolvedSecondaryMotionColliderV1[]
  ): void {
    if (this.disposed) fail('cannot update a disposed runtime')
    const resolvedSegments = chains.flatMap((chain) => chain.segments)
    if (
      resolvedSegments.length !== this.segments.length ||
      resolvedSegments.some(
        (segment, index) => segment.node !== this.segments[index]!.definition.node
      )
    ) {
      fail('resolved motion-chain inventory changed after runtime construction')
    }
    this.assetRoot.updateMatrixWorld(true)
    for (const [index, definition] of resolvedSegments.entries()) {
      const runtime = this.segments[index]!
      runtime.definition = definition
      runtime.collisionGroups = new Set(definition.collisionGroups)
      runtime.pivot.copy(vector(definition.pivot))
      runtime.tip.copy(vector(definition.tip))
      runtime.restLength = runtime.pivot.distanceTo(runtime.tip)
      if (runtime.weightedMotion) {
        continue
      } else {
        runtime.wrapper.quaternion.identity()
        runtime.wrapper.position.copy(
          runtime.originalParent.worldToLocal(this.assetRoot.localToWorld(runtime.pivot.clone()))
        )
        runtime.wrapper.updateMatrix()
        const originalLocalMatrix = new THREE.Matrix4().compose(
          runtime.originalPosition,
          runtime.originalQuaternion,
          runtime.originalScale
        )
        const nextLocalMatrix = runtime.wrapper.matrix
          .clone()
          .invert()
          .multiply(originalLocalMatrix)
        nextLocalMatrix.decompose(
          runtime.node.position,
          runtime.node.quaternion,
          runtime.node.scale
        )
        runtime.node.updateMatrix()
      }
    }
    this.rebaseWeightedMotionJoints()
    const colliderIds = colliders.map((entry) => entry.id)
    const expectedColliderIds = this.definition.colliders.map((entry) => entry.id)
    if (
      colliderIds.length !== expectedColliderIds.length ||
      colliderIds.some((id, index) => id !== expectedColliderIds[index])
    ) {
      fail('resolved collider inventory changed after runtime construction')
    }
    this.definition.chains = chains.map((chain) => ({
      id: chain.id,
      segments: chain.segments.map((segment) => ({ ...segment }))
    }))
    this.definition.colliders = colliders.map((collider) => ({ ...collider }))
    this.colliders = this.bindColliders(colliders)
    this.refreshRestColliderPenetrations()
    this.reset()
  }

  update(deltaSeconds: number): void {
    if (this.disposed) fail('cannot update a disposed runtime')
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      fail('frame delta must be a finite non-negative number')
    }
    if (this.motionTuning && !this.motionTuning.enabled) {
      this.applyRotations()
      return
    }
    if (deltaSeconds >= this.definition.simulation.interruptionResetSeconds) {
      this.reset()
      this.resetCount += 1
      return
    }
    if (deltaSeconds === 0) {
      this.applyRotations()
      return
    }
    const { fixedStepSeconds, maxSubsteps } = this.definition.simulation
    this.accumulatorSeconds = Math.min(
      this.accumulatorSeconds + deltaSeconds,
      fixedStepSeconds * maxSubsteps
    )
    let steps = 0
    while (this.accumulatorSeconds + EPSILON >= fixedStepSeconds && steps < maxSubsteps) {
      this.step(fixedStepSeconds)
      this.accumulatorSeconds -= fixedStepSeconds
      steps += 1
    }
    this.applyRotations()
  }

  reset(): void {
    if (this.disposed) return
    this.accumulatorSeconds = 0
    this.assetRoot.updateMatrixWorld(true)
    for (const segment of this.segments) {
      segment.currentTip.copy(this.assetRoot.localToWorld(segment.tip.clone()))
      segment.velocity.set(0, 0, 0)
      segment.maximumPenetration = 0
      segment.wrapper.quaternion.copy(
        segment.weightedMotion ? segment.originalQuaternion : new THREE.Quaternion()
      )
      segment.wrapper.updateMatrix()
    }
    this.assetRoot.updateMatrixWorld(true)
  }

  private step(deltaSeconds: number): void {
    this.avatarRoot.updateMatrixWorld(true)
    this.assetRoot.updateMatrixWorld(true)
    const scratch = this.scratch
    const responseGain = this.motionResponseGain()
    for (const segment of this.segments) {
      const targetPivot = this.assetRoot.localToWorld(scratch.stepTargetPivot.copy(segment.pivot))
      const targetTip = this.assetRoot.localToWorld(scratch.stepTargetTip.copy(segment.tip))
      const acceleration = scratch.stepAcceleration
        .copy(targetTip)
        .sub(segment.currentTip)
        .multiplyScalar(segment.definition.stiffness / responseGain)
        .addScaledVector(this.gravity, segment.definition.gravityScale)
      segment.velocity.addScaledVector(acceleration, deltaSeconds)
      segment.velocity.multiplyScalar(
        Math.exp(-(segment.definition.damping / Math.sqrt(responseGain)) * deltaSeconds)
      )
      segment.velocity.multiplyScalar(Math.max(0, 1 - segment.definition.drag))
      segment.currentTip.addScaledVector(segment.velocity, deltaSeconds)
      this.constrainSegment(segment, targetPivot, targetTip)
      for (
        let iteration = 0;
        iteration < this.definition.simulation.collisionIterations;
        iteration += 1
      ) {
        this.collideSegment(segment, targetPivot)
        this.constrainSegment(segment, targetPivot, targetTip)
      }
      const radial = scratch.stepRadial.copy(segment.currentTip).sub(targetPivot)
      const radialVelocity = segment.velocity.dot(radial) / Math.max(radial.lengthSq(), EPSILON)
      segment.velocity.addScaledVector(radial, -radialVelocity)
    }
  }

  private constrainSegment(
    segment: SegmentRuntime,
    targetPivot: THREE.Vector3,
    targetTip: THREE.Vector3
  ): void {
    const scratch = this.scratch
    const restDirection = scratch.constrainRestDirection
      .copy(targetTip)
      .sub(targetPivot)
      .normalize()
    const direction = scratch.constrainDirection.copy(segment.currentTip).sub(targetPivot)
    if (direction.lengthSq() <= EPSILON) direction.copy(restDirection)
    else direction.normalize()
    const angle = restDirection.angleTo(direction)
    const maxAngleRadians = Math.min(
      Math.PI,
      segment.definition.maxAngleRadians * this.motionResponseGain()
    )
    if (angle > maxAngleRadians) {
      const rotation = scratch.constrainRotation.setFromUnitVectors(restDirection, direction)
      const limited = scratch.constrainLimitedRotation
        .identity()
        .slerp(rotation, maxAngleRadians / angle)
      direction.copy(restDirection).applyQuaternion(limited).normalize()
    }
    segment.currentTip.copy(targetPivot).addScaledVector(direction, segment.restLength)
  }

  private collideSegment(segment: SegmentRuntime, pivot: THREE.Vector3): void {
    const scratch = this.scratch
    const groups = segment.collisionGroups
    const direction = scratch.collisionDirection.copy(segment.currentTip).sub(pivot)
    for (const [sampleIndex, sampleFactor] of SAMPLE_FACTORS.entries()) {
      const sample = scratch.collisionSample.copy(pivot).addScaledVector(direction, sampleFactor)
      for (const collider of this.colliders) {
        if (!groups.has(collider.group)) continue
        const start = collider.object.localToWorld(
          scratch.colliderStart.copy(collider.offsetVector)
        )
        const end = collider.object.localToWorld(
          scratch.colliderEnd.copy(collider.tailOffsetVector)
        )
        const closest =
          collider.shape === 'sphere'
            ? start
            : closestPointOnSegment(
                sample,
                start,
                end,
                scratch.colliderClosest,
                scratch.closestPointDirection,
                scratch.closestPointOffset
              )
        const separation = scratch.collisionSeparation.copy(sample).sub(closest)
        const requiredDistance = collider.radius + segment.definition.collisionRadius
        const distance = separation.length()
        const restPenetration =
          segment.restColliderPenetrations.get(collider.id)?.[sampleIndex] ?? 0
        const penetration = requiredDistance - distance - restPenetration
        if (penetration <= 0) continue
        segment.maximumPenetration = Math.max(segment.maximumPenetration, penetration)
        if (distance <= EPSILON) {
          separation.copy(sample).sub(pivot)
          if (separation.lengthSq() <= EPSILON) separation.set(0, 1, 0)
          separation.normalize()
        } else {
          separation.multiplyScalar(1 / distance)
        }
        segment.currentTip.addScaledVector(separation, penetration / sampleFactor)
      }
    }
  }

  private resolvedPenetration(segment: SegmentRuntime, pivot: THREE.Vector3): number {
    const scratch = this.scratch
    const groups = segment.collisionGroups
    const direction = scratch.collisionDirection.copy(segment.currentTip).sub(pivot)
    let maximum = 0
    for (const [sampleIndex, sampleFactor] of SAMPLE_FACTORS.entries()) {
      const sample = scratch.collisionSample.copy(pivot).addScaledVector(direction, sampleFactor)
      for (const collider of this.colliders) {
        if (!groups.has(collider.group)) continue
        const start = collider.object.localToWorld(
          scratch.colliderStart.copy(collider.offsetVector)
        )
        const end = collider.object.localToWorld(
          scratch.colliderEnd.copy(collider.tailOffsetVector)
        )
        const closest =
          collider.shape === 'sphere'
            ? start
            : closestPointOnSegment(
                sample,
                start,
                end,
                scratch.colliderClosest,
                scratch.closestPointDirection,
                scratch.closestPointOffset
              )
        maximum = Math.max(
          maximum,
          collider.radius +
            segment.definition.collisionRadius -
            sample.distanceTo(closest) -
            (segment.restColliderPenetrations.get(collider.id)?.[sampleIndex] ?? 0)
        )
      }
    }
    return Math.max(0, maximum)
  }

  private applyRotations(): void {
    this.assetRoot.updateMatrixWorld(true)
    this.avatarRoot.updateMatrixWorld(true)
    const scratch = this.scratch
    for (const segment of this.segments) {
      const targetPivot = this.assetRoot.localToWorld(scratch.applyTargetPivot.copy(segment.pivot))
      const targetTip = this.assetRoot.localToWorld(scratch.applyTargetTip.copy(segment.tip))
      const restDirection = scratch.applyRestDirection.copy(targetTip).sub(targetPivot).normalize()
      const currentDirection = scratch.applyCurrentDirection
        .copy(segment.currentTip)
        .sub(targetPivot)
      if (currentDirection.lengthSq() <= EPSILON) currentDirection.copy(restDirection)
      else currentDirection.normalize()
      const worldDelta = scratch.applyWorldDelta.setFromUnitVectors(restDirection, currentDirection)
      const appliedWorldDelta = this.motionTuning
        ? scratch.applyWeightedWorldDelta.slerpQuaternions(
            scratch.identityQuaternion,
            worldDelta,
            this.motionTuning.enabled && this.motionTuning.intensity > 0 ? 1 : 0
          )
        : worldDelta
      const parentWorldQuaternion = segment.wrapper.parent!.getWorldQuaternion(
        scratch.applyParentWorldQuaternion
      )
      segment.wrapper.quaternion
        .copy(parentWorldQuaternion)
        .invert()
        .multiply(appliedWorldDelta)
        .multiply(parentWorldQuaternion)
        .multiply(segment.weightedMotion ? segment.originalQuaternion : scratch.identityQuaternion)
        .normalize()
      segment.wrapper.updateMatrix()
      segment.wrapper.updateMatrixWorld(true)
    }
  }

  private motionResponseGain(): number {
    if (!this.motionTuning || !this.motionTuning.enabled || this.motionTuning.intensity <= 0) {
      return 1
    }
    return this.motionTuning.intensity * ROOT_WEIGHTED_RESPONSE_GAIN
  }

  inspect(): SecondaryMotionRuntimeSnapshot {
    this.assetRoot.updateMatrixWorld(true)
    return {
      accumulatorSeconds: this.accumulatorSeconds,
      resetCount: this.resetCount,
      segments: this.segments.map((segment) => {
        const pivot = this.assetRoot.localToWorld(segment.pivot.clone())
        const restTip = this.assetRoot.localToWorld(segment.tip.clone())
        const restDirection = restTip.clone().sub(pivot).normalize()
        const currentDirection = segment.currentTip.clone().sub(pivot)
        const length = currentDirection.length()
        if (length > EPSILON) currentDirection.multiplyScalar(1 / length)
        else currentDirection.copy(restDirection)
        return {
          node: segment.definition.node,
          speed: segment.velocity.length(),
          stretchRatio: length / segment.restLength,
          angleRadians: restDirection.angleTo(currentDirection),
          maximumPenetration: segment.maximumPenetration,
          resolvedPenetration: this.resolvedPenetration(segment, pivot)
        }
      })
    }
  }

  private restoreSegments(segments: readonly SegmentRuntime[]): void {
    for (const segment of [...segments].reverse()) {
      if (segment.weightedMotion) {
        segment.weightedMotion.skinWeights.array.set(segment.weightedMotion.originalSkinWeights)
        segment.weightedMotion.skinWeights.needsUpdate = true
        segment.weightedMotion.mesh.skeleton.boneInverses.forEach((inverse, index) => {
          inverse.copy(segment.weightedMotion!.originalBoneInverses[index]!)
        })
        segment.weightedMotion.mesh.bindMatrix.copy(segment.weightedMotion.originalBindMatrix)
        segment.weightedMotion.mesh.bindMatrixInverse.copy(
          segment.weightedMotion.originalBindMatrixInverse
        )
        segment.node.position.copy(segment.originalPosition)
        segment.node.quaternion.copy(segment.originalQuaternion)
        segment.node.scale.copy(segment.originalScale)
        segment.node.matrixAutoUpdate = segment.originalMatrixAutoUpdate
        segment.node.updateMatrix()
        continue
      }
      segment.node.removeFromParent()
      segment.originalParent.add(segment.node)
      reorderChild(segment.originalParent, segment.node, segment.originalIndex)
      segment.node.position.copy(segment.originalPosition)
      segment.node.quaternion.copy(segment.originalQuaternion)
      segment.node.scale.copy(segment.originalScale)
      segment.node.matrixAutoUpdate = segment.originalMatrixAutoUpdate
      segment.node.updateMatrix()
      if (segment.ownsWrapper) segment.wrapper.removeFromParent()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.restoreSegments(this.segments)
    this.disposed = true
    this.colliders = []
  }
}

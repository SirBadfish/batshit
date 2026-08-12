import * as THREE from 'three'
import { describe, expect, test, vi } from 'vitest'

import { SecondaryMotionEngineRuntime } from './secondaryMotion.engine'
import { resolveSecondaryMotionChains, resolveSecondaryMotionColliders } from './secondaryMotion'
import {
  HAIR_MOTION_DEFAULT_ANCHORED_LENGTH,
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_MOTION_WEIGHT_CURVE,
  HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
  HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE
} from './secondaryMotion'
import { secondaryMotionFixture } from './secondaryMotion.test'

function sceneFixture() {
  const avatar = new THREE.Group()
  avatar.name = 'avatar'
  const chest = new THREE.Bone()
  chest.name = 'chest'
  const head = new THREE.Bone()
  head.name = 'head'
  chest.add(head)
  avatar.add(chest)
  const hair = new THREE.Group()
  hair.name = 'HairRoot'
  const before = new THREE.Object3D()
  before.name = 'BeforeHair'
  const clump = new THREE.Object3D()
  clump.name = 'HairClump01'
  clump.position.set(0.01, 0.02, 0.03)
  const after = new THREE.Object3D()
  after.name = 'AfterHair'
  hair.add(before, clump, after)
  head.add(hair)
  avatar.updateMatrixWorld(true)
  return { avatar, chest, head, hair, clump }
}

function runtimeFixture(configure?: (definition: ReturnType<typeof secondaryMotionFixture>) => void) {
  const scene = sceneFixture()
  const definition = secondaryMotionFixture()
  configure?.(definition)
  const runtime = new SecondaryMotionEngineRuntime(scene.hair, scene.avatar, {
    owner: definition.owner,
    chainSpace: definition.chainSpace,
    colliderSpace: definition.colliderSpace,
    simulation: definition.simulation,
    chains: resolveSecondaryMotionChains(definition, { values: {} }),
    colliders: resolveSecondaryMotionColliders(definition, { values: {} })
  })
  return { ...scene, definition, runtime }
}

function rootWeightedRuntimeFixture(
  multipleRegions = false,
  lastVertexJointSlot = multipleRegions ? 2 : 1
) {
  const avatar = new THREE.Group()
  const chest = new THREE.Bone()
  chest.name = 'chest'
  const head = new THREE.Bone()
  head.name = 'head'
  chest.add(head)
  avatar.add(chest)
  const hair = new THREE.Group()
  hair.name = 'HairScene'
  head.add(hair)
  const root = new THREE.Bone()
  root.name = 'HairRoot'
  const motion = new THREE.Bone()
  motion.name = 'HairClump01__Motion'
  motion.position.set(0, 0.1, 0)
  motion.userData.batshitHairRootWeightedMotion = {
    contract: HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
    meshNode: 'HairClump01',
    tipAttribute: HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
    dynamicJointSlot: 1,
    anchoredLength: HAIR_MOTION_DEFAULT_ANCHORED_LENGTH,
    weightCurve: HAIR_MOTION_WEIGHT_CURVE,
    defaultEnabled: true,
    defaultIntensity: HAIR_MOTION_DEFAULT_INTENSITY
  }
  const secondMotion = new THREE.Bone()
  secondMotion.name = 'HairClump01__Motion_002'
  secondMotion.position.set(0.02, 0.1, 0)
  secondMotion.userData.batshitHairRootWeightedMotion = {
    ...motion.userData.batshitHairRootWeightedMotion,
    dynamicJointSlot: 2
  }
  root.add(...(multipleRegions ? [motion, secondMotion] : [motion]))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0.1, 0, 0, 0, 0, 0, -0.1, 0, 0, -0.2, 0], 3)
  )
  geometry.setAttribute(
    HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
    new THREE.Float32BufferAttribute([0, 0.6, 0.7, 1], 1)
  )
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, lastVertexJointSlot, 0, 0],
      4
    )
  )
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1, 0, 0], 4)
  )
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  mesh.name = 'HairClump01'
  root.add(mesh)
  hair.add(root)
  avatar.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(
    multipleRegions ? [root, motion, secondMotion] : [root, motion]
  )
  mesh.bind(skeleton)
  const originalBoneInverses = skeleton.boneInverses.map((inverse) => inverse.clone())
  const definition = secondaryMotionFixture()
  definition.chains[0]!.segments[0]!.node = motion.name
  if (multipleRegions) {
    definition.chains.push({
      id: 'Hair_Clump_Secondary',
      segments: [
        {
          ...definition.chains[0]!.segments[0]!,
          node: secondMotion.name,
          pivot: [0.02, 0.1, 0],
          tip: [0.02, -0.1, 0]
        }
      ]
    })
  }
  const runtime = new SecondaryMotionEngineRuntime(hair, avatar, {
    owner: definition.owner,
    chainSpace: definition.chainSpace,
    colliderSpace: definition.colliderSpace,
    simulation: definition.simulation,
    chains: resolveSecondaryMotionChains(definition, { values: {} }),
    colliders: resolveSecondaryMotionColliders(definition, { values: {} })
  })
  return {
    avatar,
    head,
    hair,
    root,
    motion,
    secondMotion,
    mesh,
    originalBoneInverses,
    runtime
  }
}

function skinnedVertexWorld(mesh: THREE.SkinnedMesh, index: number) {
  const positions = mesh.geometry.getAttribute('position')
  const point = new THREE.Vector3().fromBufferAttribute(positions, index)
  mesh.applyBoneTransform(index, point)
  return mesh.localToWorld(point)
}

describe('secondary-motion fixed-step runtime', () => {
  test('accepts root-only vertices and multiple declared motion slots on one mesh', () => {
    const fixture = rootWeightedRuntimeFixture(true)

    expect(fixture.runtime.inspect().segments.map((segment) => segment.node)).toEqual([
      fixture.motion.name,
      fixture.secondMotion.name
    ])
    fixture.runtime.dispose()
  })

  test('rejects a vertex that references an undeclared motion slot', () => {
    expect(() => rootWeightedRuntimeFixture(true, 3)).toThrow(
      /root-weighted motion mesh HairClump01 has an invalid joint tuple at vertex 3/
    )
  })

  test('reuses scratch vectors and quaternions during live fixed-step updates', () => {
    const rigid = runtimeFixture()
    const weighted = rootWeightedRuntimeFixture()
    const vectorClone = vi.spyOn(THREE.Vector3.prototype, 'clone')
    const quaternionClone = vi.spyOn(THREE.Quaternion.prototype, 'clone')

    rigid.runtime.update(1 / 60)
    weighted.runtime.update(1 / 60)

    expect(vectorClone).not.toHaveBeenCalled()
    expect(quaternionClone).not.toHaveBeenCalled()
    vectorClone.mockRestore()
    quaternionClone.mockRestore()
    rigid.runtime.dispose()
    weighted.runtime.dispose()
  })

  test('produces identical motion for equal elapsed time with different frame chunking', () => {
    const first = runtimeFixture()
    const second = runtimeFixture()
    first.head.rotation.z = 0.3
    second.head.rotation.z = 0.3
    for (let index = 0; index < 120; index += 1) first.runtime.update(1 / 120)
    for (let index = 0; index < 60; index += 1) second.runtime.update(1 / 60)
    const firstWrapper = first.hair.getObjectByName('BatshitSecondaryMotion__HairClump01')!
    const secondWrapper = second.hair.getObjectByName('BatshitSecondaryMotion__HairClump01')!
    expect(firstWrapper.quaternion.toArray()).toEqual(secondWrapper.quaternion.toArray())
    expect(first.runtime.inspect().segments[0]!.stretchRatio).toBeCloseTo(1, 8)
    expect(first.runtime.inspect().segments[0]!.angleRadians).toBeLessThanOrEqual(
      first.definition.chains[0]!.segments[0]!.maxAngleRadians + 1e-7
    )
  })

  test('resolves collision, follows updated colliders, and resets cleanly after an interruption', () => {
    const fixture = runtimeFixture()
    const originalWorldPosition = fixture.clump.getWorldPosition(new THREE.Vector3()).toArray()
    fixture.head.position.y = -0.16
    for (let index = 0; index < 40; index += 1) fixture.runtime.update(1 / 120)
    expect(fixture.runtime.inspect().segments[0]!.maximumPenetration).toBeGreaterThan(0)
    const drivenChains = resolveSecondaryMotionChains(fixture.definition, {
      values: { head_size: 1 }
    })
    fixture.runtime.setResolvedState(
      drivenChains,
      resolveSecondaryMotionColliders(fixture.definition, {
        values: { head_size: 1 }
      })
    )
    expect(drivenChains[0]!.segments[0]!.pivot).toEqual([0, 0.17, 0])
    const wrapper = fixture.hair.getObjectByName('BatshitSecondaryMotion__HairClump01')!
    expect(wrapper.position.toArray()).toEqual([0, 0.17, 0])
    expect(fixture.clump.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([
      originalWorldPosition[0],
      originalWorldPosition[1]! - 0.16,
      originalWorldPosition[2]
    ])
    fixture.runtime.update(0.3)
    const snapshot = fixture.runtime.inspect()
    expect(snapshot.resetCount).toBe(1)
    expect(snapshot.segments[0]!.speed).toBe(0)
    expect(snapshot.segments[0]!.stretchRatio).toBeCloseTo(1, 8)
  })

  test('treats authored rest overlap as an allowance instead of pinning a moving strand', () => {
    const fixture = runtimeFixture((definition) => {
      const segment = definition.chains[0]!.segments[0]!
      segment.gravityScale = 0
      segment.collisionGroups = ['head']
      const collider = definition.colliders[0]!
      collider.offset = [0, 0.25, 0]
      collider.tailOffset = [0, 0.25, 0]
      collider.radius = 0.14
    })

    for (let index = 0; index < 60; index += 1) fixture.runtime.update(1 / 120)
    const rest = fixture.runtime.inspect().segments[0]!
    expect(rest.angleRadians).toBeLessThan(1e-7)
    expect(rest.maximumPenetration).toBeLessThan(1e-7)
    expect(rest.resolvedPenetration).toBeLessThan(1e-7)

    let maximumAngle = 0
    for (let index = 0; index < 90; index += 1) {
      fixture.head.rotation.z = Math.sin(index / 8) * 0.35
      fixture.runtime.update(1 / 120)
      maximumAngle = Math.max(
        maximumAngle,
        fixture.runtime.inspect().segments[0]!.angleRadians
      )
    }
    expect(maximumAngle).toBeGreaterThan(0.01)
    fixture.runtime.dispose()
  })

  test('restores exact hierarchy and local transforms on disposal', () => {
    const fixture = runtimeFixture()
    const originalPosition = [0.01, 0.02, 0.03]
    expect(fixture.hair.children.map((entry) => entry.name)).toEqual([
      'BeforeHair',
      'BatshitSecondaryMotion__HairClump01',
      'AfterHair'
    ])
    fixture.runtime.update(1 / 60)
    fixture.runtime.dispose()
    expect(fixture.hair.children.map((entry) => entry.name)).toEqual([
      'BeforeHair',
      'HairClump01',
      'AfterHair'
    ])
    expect(fixture.clump.position.toArray()).toEqual(originalPosition)
    expect(fixture.clump.parent).toBe(fixture.hair)
  })

  test('keeps authored weights immutable while the simple controls toggle and scale motion', () => {
    const fixture = rootWeightedRuntimeFixture()
    const neutralTip = skinnedVertexWorld(fixture.mesh, 3)
    expect(fixture.motion.position.toArray()).toEqual([0, 0.16, 0])
    expect(fixture.runtime.getMotionTuning()).toEqual({
      enabled: true,
      intensity: HAIR_MOTION_DEFAULT_INTENSITY
    })
    const weights = fixture.mesh.geometry.getAttribute('skinWeight')
    const originalWeights = Array.from(weights.array)
    fixture.runtime.setMotionTuning({ enabled: false, intensity: 1.5 })
    expect(Array.from(weights.array)).toEqual(originalWeights)

    fixture.head.rotation.z = 0.35
    for (let index = 0; index < 60; index += 1) fixture.runtime.update(1 / 120)
    expect(fixture.motion.quaternion.toArray()).toEqual([0, 0, 0, 1])

    fixture.runtime.setMotionTuning({ enabled: true, intensity: 1 })
    fixture.head.rotation.z = -0.35
    for (let index = 0; index < 60; index += 1) fixture.runtime.update(1 / 120)
    expect(fixture.motion.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0)
    expect(skinnedVertexWorld(fixture.mesh, 3).distanceTo(neutralTip)).toBeGreaterThan(0.01)
    expect(Array.from(weights.array)).toEqual(originalWeights)

    fixture.runtime.setMotionTuning({ enabled: true, intensity: 0 })
    expect(fixture.motion.quaternion.toArray()).toEqual([0, 0, 0, 1])
    expect(fixture.runtime.inspect().segments[0]!.angleRadians).toBeGreaterThan(0)

    fixture.runtime.dispose()
    expect(Array.from(weights.array)).toEqual(originalWeights)
    expect(fixture.motion.quaternion.toArray()).toEqual([0, 0, 0, 1])
    fixture.mesh.skeleton.boneInverses.forEach((inverse, index) => {
      expect(inverse.elements).toEqual(fixture.originalBoneInverses[index]!.elements)
    })
  })

  test('turns the simple intensity control into visibly stronger root-weighted travel', () => {
    const mild = rootWeightedRuntimeFixture()
    const strong = rootWeightedRuntimeFixture()
    mild.runtime.setMotionTuning({ enabled: true, intensity: 0.5 })
    strong.runtime.setMotionTuning({ enabled: true, intensity: 1.5 })
    mild.head.rotation.z = 0.35
    strong.head.rotation.z = 0.35

    for (let index = 0; index < 60; index += 1) {
      mild.runtime.update(1 / 120)
      strong.runtime.update(1 / 120)
    }

    const mildAngle = mild.motion.quaternion.angleTo(new THREE.Quaternion())
    const strongAngle = strong.motion.quaternion.angleTo(new THREE.Quaternion())
    expect(mildAngle).toBeGreaterThan(0)
    expect(strongAngle).toBeGreaterThan(mildAngle * 2)
    expect(strong.runtime.inspect().segments[0]!.resolvedPenetration).toBeLessThan(1e-7)

    mild.runtime.dispose()
    strong.runtime.dispose()
  })

  test('rebases fitted root-weighted joints without binding Hair to the active avatar pose', () => {
    const fixture = rootWeightedRuntimeFixture()
    const neutralTip = skinnedVertexWorld(fixture.mesh, 3)
    fixture.avatar.rotation.y = 0.7
    fixture.head.rotation.z = 0.4
    fixture.avatar.updateMatrixWorld(true)

    const definition = secondaryMotionFixture()
    definition.chains[0]!.segments[0]!.node = fixture.motion.name
    fixture.runtime.setResolvedState(
      resolveSecondaryMotionChains(definition, { values: { head_size: 1 } }),
      resolveSecondaryMotionColliders(definition, { values: { head_size: 1 } })
    )

    fixture.avatar.rotation.y = 0
    fixture.head.rotation.z = 0
    fixture.avatar.updateMatrixWorld(true)
    const returnedTip = skinnedVertexWorld(fixture.mesh, 3)
    expect(returnedTip.distanceTo(neutralTip)).toBeLessThan(1e-7)
  })
})

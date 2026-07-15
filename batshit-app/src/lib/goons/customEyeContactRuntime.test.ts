import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GoonEngine } from '$lib/goons/engine'
import {
  bindCustomPerformanceRig,
  type CustomPerformanceDirection,
  type CustomPerformanceRigManifest,
  type CustomPerformanceRigRuntime
} from '$lib/goons/customPerformanceRig'

function axis(direction: [number, number, number]) {
  return {
    axis: direction,
    sign: -1 as const,
    rangeDegrees: { negative: 45, positive: 45 }
  }
}

function buildRig() {
  const root = new THREE.Group()
  const chest = new THREE.Bone()
  const neck = new THREE.Bone()
  const head = new THREE.Bone()
  const leftEye = new THREE.Bone()
  const rightEye = new THREE.Bone()

  chest.name = 'Chest'
  neck.name = 'Neck'
  head.name = 'Head'
  leftEye.name = 'LeftEye'
  rightEye.name = 'RightEye'
  neck.position.set(0, 1, 0)
  head.position.set(0, 0.3, 0)
  leftEye.position.set(0.1, 0.1, 0.1)
  rightEye.position.set(-0.1, 0.1, 0.1)
  root.add(chest)
  chest.add(neck)
  neck.add(head)
  head.add(leftEye, rightEye)
  root.updateMatrixWorld(true)

  const lookNode = (node: string) => ({
    node,
    yaw: axis([0, 1, 0]),
    pitch: axis([1, 0, 0])
  })
  const manifest: CustomPerformanceRigManifest = {
    contract: 'batshit-performance-rig/v1',
    space: 'node-parent-rest',
    rotation: {
      representation: 'rotation-vector',
      units: 'radians',
      composition: 'ordered-expmap/v1'
    },
    nodes: {
      head: lookNode('Head'),
      neck: lookNode('Neck'),
      leftEye: lookNode('LeftEye'),
      rightEye: lookNode('RightEye')
    },
    look: {
      headYawShares: { head: 0.7, neck: 0.3 },
      headPitchShares: { head: 0.7, neck: 0.3 },
      eyeYawMode: 'asymmetric-in-out',
      eyePitchMode: 'asymmetric-up-down'
    },
    targetTransforms: {}
  }
  const binding = bindCustomPerformanceRig(root, manifest)
  if (!binding.runtime) throw new Error(binding.issues.join('\n'))
  return { root, chest, neck, head, leftEye, rightEye, runtime: binding.runtime }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Advanced/GLB Eye Contact runtime', () => {
  it('calibrates from bound eye nodes and feeds the current camera target into the performance rig', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const engine = new GoonEngine(document.createElement('div'))
    const rig = buildRig()
    const internals = engine as unknown as {
      camera: THREE.PerspectiveCamera
      customAvatarRoot: THREE.Object3D | null
      customPerformanceRigRuntime: CustomPerformanceRigRuntime | null
      customPerformanceDirection: CustomPerformanceDirection
      eyeContactTuning: {
        eyeYawRange: number
        eyePitchRange: number
        headYawRange: number
        headPitchRange: number
      }
      calibrateEyeContactReference(): void
      resolveCameraEyeContact(): {
        eyeYaw: number
        eyePitch: number
        headYaw: number
        headPitch: number
      } | null
      applyCustomPerformance(elapsed: number): void
    }

    internals.customAvatarRoot = rig.root
    internals.customPerformanceRigRuntime = rig.runtime
    internals.camera.position.set(0, 1.4, 3)
    internals.calibrateEyeContactReference()

    internals.camera.position.set(1.5, 1.4, 2.5)
    const contact = internals.resolveCameraEyeContact()
    expect(contact).not.toBeNull()
    expect(contact?.eyeYaw).toBeGreaterThan(0)
    expect(contact?.headYaw).toBeGreaterThan(0)

    rig.head.position.add(new THREE.Vector3(0.04, 0.02, -0.03))
    rig.head.rotateY(0.4)
    rig.leftEye.rotateX(-0.25)
    rig.rightEye.rotateX(0.2)

    for (let frame = 0; frame < 20; frame += 1) {
      internals.applyCustomPerformance(frame / 60)
    }

    expect(rig.head.position).toEqual(new THREE.Vector3(0, 0.3, 0))
    expect(rig.head.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0)
    expect(rig.leftEye.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0)
    expect(rig.rightEye.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0)

    expect(internals.customPerformanceDirection.leftEyeYaw).toBeLessThan(0)
    expect(internals.customPerformanceDirection.rightEyeYaw).toBeLessThan(0)
    expect(internals.customPerformanceDirection.headYaw).toBeLessThan(0)
    expect(internals.customPerformanceDirection.leftEyePitch).toBeCloseTo(
      internals.customPerformanceDirection.rightEyePitch
    )

    rig.runtime.dispose()
  })

  it('preserves mixer-authored gaze when the active motion opts out of Eye Contact', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const engine = new GoonEngine(document.createElement('div'))
    const rig = buildRig()
    const internals = engine as unknown as {
      camera: THREE.PerspectiveCamera
      customAvatarRoot: THREE.Object3D | null
      customPerformanceRigRuntime: CustomPerformanceRigRuntime | null
      calibrateEyeContactReference(): void
      isEyeContactSuppressedByMotion(): boolean
      applyCustomPerformance(elapsed: number): void
    }

    internals.customAvatarRoot = rig.root
    internals.customPerformanceRigRuntime = rig.runtime
    internals.camera.position.set(0, 1.4, 3)
    internals.calibrateEyeContactReference()
    vi.spyOn(internals, 'isEyeContactSuppressedByMotion').mockReturnValue(true)

    rig.head.rotateY(0.4)
    rig.leftEye.rotateX(-0.25)
    rig.rightEye.rotateX(0.2)
    const motionPose = {
      head: rig.head.quaternion.clone(),
      leftEye: rig.leftEye.quaternion.clone(),
      rightEye: rig.rightEye.quaternion.clone()
    }

    internals.applyCustomPerformance(0)

    expect(rig.head.quaternion.angleTo(motionPose.head)).toBeCloseTo(0)
    expect(rig.leftEye.quaternion.angleTo(motionPose.leftEye)).toBeCloseTo(0)
    expect(rig.rightEye.quaternion.angleTo(motionPose.rightEye)).toBeCloseTo(0)

    rig.runtime.dispose()
  })

  it('rebases live Recipe eye-pivot positions before the next gaze reset', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const engine = new GoonEngine(document.createElement('div'))
    const rig = buildRig()
    const nextLeftEyePosition = new THREE.Vector3(0.18, 0.12, 0.08)
    const nextRightEyePosition = new THREE.Vector3(-0.18, 0.12, 0.08)
    const internals = engine as unknown as {
      customPerformanceRigRuntime: CustomPerformanceRigRuntime | null
      appearanceDialsRuntime: {
        setValues(values: unknown): void
      } | null
    }

    internals.customPerformanceRigRuntime = rig.runtime
    internals.appearanceDialsRuntime = {
      setValues() {
        rig.leftEye.position.copy(nextLeftEyePosition)
        rig.rightEye.position.copy(nextRightEyePosition)
      }
    }

    engine.setAppearanceDialValues(null)
    rig.leftEye.rotateX(0.3)
    rig.rightEye.rotateX(-0.25)
    rig.runtime.neutralizeMotionLookNodes()

    expect(rig.leftEye.position).toEqual(nextLeftEyePosition)
    expect(rig.rightEye.position).toEqual(nextRightEyePosition)
    expect(rig.leftEye.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0)
    expect(rig.rightEye.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0)

    rig.runtime.dispose()
  })
})

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { resolveCustomPerformanceRigBlock } from './customAvatar'
import {
  bindCustomPerformanceRig,
  composeCustomPerformanceEyeContact,
  hasCustomPerformanceAuthoredEyeDirection,
  NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
  resolveCustomPerformanceDirection,
  resolveCustomPerformanceEyeContactState,
  resolveCustomPerformanceRigManifest,
  resolveFaceControlEyeLookPresetWeights,
  resolveFinalCustomTargetWeights,
  shouldApplyCustomExpressionMorphPreset,
  type CustomPerformanceDirection,
  type CustomPerformanceRigManifest
} from './customPerformanceRig'

function axis(
  negative: number,
  positive: number,
  direction: [number, number, number]
) {
  return {
    axis: direction,
    sign: -1 as const,
    rangeDegrees: { negative, positive }
  }
}

function buildManifest(): CustomPerformanceRigManifest {
  return {
    contract: 'batshit-performance-rig/v1',
    space: 'node-parent-rest',
    rotation: {
      representation: 'rotation-vector',
      units: 'radians',
      composition: 'ordered-expmap/v1'
    },
    nodes: {
      head: {
        node: 'Head',
        yaw: axis(40, 40, [0, 1, 0]),
        pitch: axis(30, 50, [1, 0, 0])
      },
      neck: {
        node: 'Neck',
        yaw: axis(40, 40, [0, 1, 0]),
        pitch: axis(30, 50, [1, 0, 0])
      },
      leftEye: {
        node: 'LeftEye',
        yaw: axis(60, 45, [0, 1, 0]),
        pitch: axis(35, 45, [1, 0, 0])
      },
      rightEye: {
        node: 'RightEye',
        yaw: axis(45, 60, [0, 1, 0]),
        pitch: axis(35, 45, [1, 0, 0])
      }
    },
    look: {
      headYawShares: { head: 0.7, neck: 0.3 },
      headPitchShares: { head: 0.7, neck: 0.3 },
      eyeYawMode: 'asymmetric-in-out',
      eyePitchMode: 'asymmetric-up-down'
    },
    targetTransforms: {
      jaw: {
        node: 'Jaw',
        combine: 'translation-sum-rotation-vector-sum/v1',
        channels: {
          jawOpen: {
            translation: [0, -0.02, 0.01],
            rotationVector: [0.3, 0, 0]
          },
          jawLeft: {
            translation: [-0.01, 0, 0],
            rotationVector: [0, 0.1, 0]
          },
          viseme_aa: {
            translation: [0, -0.01, 0],
            rotationVector: [0.1, 0, 0]
          }
        }
      }
    }
  }
}

function buildRig() {
  const root = new THREE.Group()
  const neck = new THREE.Bone()
  const head = new THREE.Bone()
  const leftEye = new THREE.Bone()
  const rightEye = new THREE.Bone()
  const jaw = new THREE.Bone()
  const eyeAssembly = new THREE.Group()

  neck.name = 'Neck'
  head.name = 'Head'
  leftEye.name = 'LeftEye'
  rightEye.name = 'RightEye'
  jaw.name = 'Jaw'
  eyeAssembly.name = 'LeftEyeAssembly'

  neck.position.set(0, 1, 0)
  head.position.set(0, 0.3, 0)
  leftEye.position.set(0.1, 0.08, 0.1)
  rightEye.position.set(-0.1, 0.08, 0.1)
  jaw.position.set(0, -0.1, 0.02)
  eyeAssembly.position.set(0, 0, 0.04)

  neck.quaternion.setFromEuler(new THREE.Euler(0.05, -0.08, 0.02))
  head.quaternion.setFromEuler(new THREE.Euler(-0.03, 0.12, -0.04))
  leftEye.quaternion.setFromEuler(new THREE.Euler(0.01, -0.02, 0.03))
  rightEye.quaternion.setFromEuler(new THREE.Euler(-0.02, 0.01, -0.01))
  jaw.quaternion.setFromEuler(new THREE.Euler(0.02, 0.03, -0.01))

  root.add(neck)
  neck.add(head)
  head.add(leftEye, rightEye, jaw)
  leftEye.add(eyeAssembly)
  root.updateMatrixWorld(true)

  const binding = bindCustomPerformanceRig(root, buildManifest())
  if (!binding.runtime) throw new Error(binding.issues.join('\n'))
  return {
    root,
    neck,
    head,
    leftEye,
    rightEye,
    jaw,
    eyeAssembly,
    runtime: binding.runtime
  }
}

function expectQuaternionClose(
  actual: THREE.Quaternion,
  expected: THREE.Quaternion,
  digits = 7
) {
  expect(actual.angleTo(expected)).toBeCloseTo(0, digits)
}

function overlayFrom(applied: THREE.Quaternion, base: THREE.Quaternion) {
  return applied.clone().multiply(base.clone().invert()).normalize()
}

describe('resolveCustomPerformanceRigManifest', () => {
  it('reads only the nested rig.performance block from the avatar manifest', () => {
    const performance = buildManifest()
    expect(
      resolveCustomPerformanceRigBlock({
        rig: { performance, correctives: {} }
      })
    ).toBe(performance)
    expect(resolveCustomPerformanceRigBlock({ rig: [] })).toBeUndefined()
  })

  it('accepts the versioned generic contract without baking in package node names or ranges', () => {
    const manifest = buildManifest()
    manifest.nodes.head.node = 'Any_Runtime_Head'
    manifest.nodes.head.yaw.rangeDegrees.positive = 41.252961
    const resolved = resolveCustomPerformanceRigManifest(manifest)
    expect(resolved.issues).toEqual([])
    expect(resolved.manifest?.nodes.head).toMatchObject({
      node: 'Any_Runtime_Head',
      yaw: { rangeDegrees: { positive: 41.252961 } }
    })
  })

  it('fails closed with actionable paths for malformed or incomplete contracts', () => {
    const malformed = structuredClone(buildManifest()) as Record<
      string,
      unknown
    >
    const look = malformed.look as Record<string, unknown>
    look.headYawShares = { head: 0.8, neck: 0.3 }
    const nodes = malformed.nodes as Record<string, Record<string, unknown>>
    const head = nodes.head
    head.extra = true
    const targetTransforms = malformed.targetTransforms as Record<
      string,
      Record<string, unknown>
    >
    const jaw = targetTransforms.jaw
    const channels = jaw.channels as Record<string, Record<string, unknown>>
    channels.jawOpen = { translation: [0, 0, 0], rotationVector: [0, 0, 0] }

    const resolved = resolveCustomPerformanceRigManifest(malformed)
    expect(resolved.manifest).toBeNull()
    expect(resolved.issues.join('\n')).toMatch(
      /rig\.performance\.nodes\.head\.extra/
    )
    expect(resolved.issues.join('\n')).toMatch(/head \+ neck must equal 1/)
    expect(resolved.issues.join('\n')).toMatch(
      /targetTransforms\.jaw\.channels\.jawOpen/
    )
    expect(resolveCustomPerformanceRigManifest({}).manifest).toBeNull()
  })

  it('rejects both absent and explicit-null performance blocks when the package requires one', () => {
    for (const value of [undefined, null]) {
      const resolved = resolveCustomPerformanceRigManifest(value, {
        required: true
      })
      expect(resolved.manifest).toBeNull()
      expect(resolved.issues).toEqual([
        'rig.performance is required for first-party appearance packages.'
      ])
    }

    expect(resolveCustomPerformanceRigManifest(null).issues).toEqual([])
  })

  it('rejects missing, duplicate-name, and multiply-claimed runtime nodes', () => {
    const missingRoot = new THREE.Group()
    const missing = bindCustomPerformanceRig(missingRoot, buildManifest())
    expect(missing.runtime).toBeNull()
    expect(missing.issues.join('\n')).toMatch(/missing runtime node "Head"/)

    const duplicateRoot = buildRig().root.clone(true)
    const duplicateHead = new THREE.Bone()
    duplicateHead.name = 'Head'
    duplicateRoot.add(duplicateHead)
    const duplicate = bindCustomPerformanceRig(duplicateRoot, buildManifest())
    expect(duplicate.runtime).toBeNull()
    expect(duplicate.issues.join('\n')).toMatch(/2 runtime nodes named "Head"/)

    const multiplyClaimed = buildManifest()
    multiplyClaimed.targetTransforms.jaw.node = 'Head'
    const claimed = bindCustomPerformanceRig(buildRig().root, multiplyClaimed)
    expect(claimed.runtime).toBeNull()
    expect(claimed.issues.join('\n')).toMatch(/already claimed by nodes\.head/)
  })
})

describe('custom performance input resolution', () => {
  it('keeps directional morph fan-out GLB-rig-only without filtering ordinary expressions', () => {
    const directionalPresets = [
      'lookLeftHead',
      'lookRightHead',
      'lookUpHead',
      'lookDownHead',
      'lookLeft',
      'lookRight',
      'lookUp',
      'lookDown'
    ]

    for (const preset of directionalPresets) {
      expect(shouldApplyCustomExpressionMorphPreset(preset, false)).toBe(false)
      expect(shouldApplyCustomExpressionMorphPreset(preset, true)).toBe(true)
    }
    expect(shouldApplyCustomExpressionMorphPreset('happy', false)).toBe(true)
  })

  it('combines semantic presets and original controls while retaining asymmetric raw eye input', () => {
    const direction = resolveCustomPerformanceDirection({
      expressionTargets: [
        { preset: 'lookRightHead', weight: 0.4 },
        { preset: 'lookLeft', weight: 0.2 },
        { preset: 'lookUp', weight: 0.3 }
      ],
      faceControls: [
        { control: 'head_leftright', value: 0.2 },
        { control: 'eyes_leftright', value: 0.1 }
      ],
      rawTargetWeights: new Map([
        ['eyeLookOutLeft', 0.5],
        ['eyeLookOutRight', 0.6],
        ['eyeLookDownRight', 0.15]
      ])
    })

    expect(direction.headYaw).toBeCloseTo(0.6)
    expect(direction.leftEyeYaw).toBeCloseTo(-0.6)
    expect(direction.rightEyeYaw).toBeCloseTo(0.5)
    expect(direction.leftEyePitch).toBeCloseTo(0.3)
    expect(direction.rightEyePitch).toBeCloseTo(0.15)
  })

  it('converts Eye Contact signs and composes ambient motion without collapsing asymmetric eyes', () => {
    const authored: CustomPerformanceDirection = {
      headYaw: 0.25,
      headPitch: -0.1,
      leftEyeYaw: -0.6,
      leftEyePitch: 0.4,
      rightEyeYaw: 0.2,
      rightEyePitch: -0.2
    }
    const authoredState = resolveCustomPerformanceEyeContactState(authored)

    expect(authoredState.eyeYaw).toBeCloseTo(0.2)
    expect(authoredState.eyePitch).toBeCloseTo(-0.1)
    expect(authoredState.headYaw).toBeCloseTo(-0.25)
    expect(authoredState.headPitch).toBeCloseTo(0.1)
    expect(hasCustomPerformanceAuthoredEyeDirection(authored)).toBe(true)

    const composed = composeCustomPerformanceEyeContact(authored, {
      eyeYaw: authoredState.eyeYaw + 0.3,
      eyePitch: authoredState.eyePitch - 0.15,
      headYaw: authoredState.headYaw + 0.4,
      headPitch: authoredState.headPitch - 0.2
    })

    expect(composed.headYaw).toBeCloseTo(-0.15)
    expect(composed.headPitch).toBeCloseTo(0.1)
    expect(composed.leftEyeYaw).toBeCloseTo(-0.9)
    expect(composed.rightEyeYaw).toBeCloseTo(-0.1)
    expect(composed.leftEyePitch).toBeCloseTo(0.55)
    expect(composed.rightEyePitch).toBeCloseTo(-0.05)
    expect(composed.rightEyeYaw - composed.leftEyeYaw).toBeCloseTo(0.8)
    expect(composed.leftEyePitch - composed.rightEyePitch).toBeCloseTo(0.6)
  })

  it('maps camera-only Eye Contact onto both eyes and Head/Neck in performance-rig signs', () => {
    const composed = composeCustomPerformanceEyeContact(
      NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
      {
        eyeYaw: 0.4,
        eyePitch: -0.2,
        headYaw: 0.3,
        headPitch: -0.1
      }
    )

    expect(composed).toEqual({
      headYaw: -0.3,
      headPitch: 0.1,
      leftEyeYaw: -0.4,
      leftEyePitch: 0.2,
      rightEyeYaw: -0.4,
      rightEyePitch: 0.2
    })
    expect(
      hasCustomPerformanceAuthoredEyeDirection({
        ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
        rightEyeYaw: 0.049
      })
    ).toBe(false)
    expect(
      hasCustomPerformanceAuthoredEyeDirection({
        ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
        rightEyeYaw: 0.05
      })
    ).toBe(true)
  })

  it('scales only ambient camera contact with the saved output ranges', () => {
    const authored: CustomPerformanceDirection = {
      headYaw: 0.25,
      headPitch: -0.1,
      leftEyeYaw: -0.6,
      leftEyePitch: 0.4,
      rightEyeYaw: 0.2,
      rightEyePitch: -0.2
    }
    const authoredState = resolveCustomPerformanceEyeContactState(authored)
    const composed = composeCustomPerformanceEyeContact(
      authored,
      {
        eyeYaw: authoredState.eyeYaw + 0.3,
        eyePitch: authoredState.eyePitch - 0.15,
        headYaw: authoredState.headYaw + 0.4,
        headPitch: authoredState.headPitch - 0.2
      },
      {
        eyeYaw: 0.5,
        eyePitch: 2,
        headYaw: 0.5,
        headPitch: 2
      }
    )

    expect(composed.headYaw).toBeCloseTo(0.05)
    expect(composed.headPitch).toBeCloseTo(0.3)
    expect(composed.leftEyeYaw).toBeCloseTo(-0.75)
    expect(composed.rightEyeYaw).toBeCloseTo(0.05)
    expect(composed.leftEyePitch).toBeCloseTo(0.7)
    expect(composed.rightEyePitch).toBeCloseTo(0.1)
    expect(composed.rightEyeYaw - composed.leftEyeYaw).toBeCloseTo(0.8)
    expect(composed.leftEyePitch - composed.rightEyePitch).toBeCloseTo(0.6)
  })

  it('creates eye-canvas corrective presets from direction controls without collapsing eyes', () => {
    expect(
      Object.fromEntries(
        resolveFaceControlEyeLookPresetWeights([
          { control: 'eyes_leftright', value: -0.7 },
          { control: 'eyes_updown', value: 0.4 },
          { control: 'eyes_leftright', value: -0.2 }
        ])
      )
    ).toEqual({ lookLeft: 0.7, lookUp: 0.4 })
  })

  it('resolves expression, face-control, lip-sync, and Custom Morph targets with raw exact precedence', () => {
    const weights = resolveFinalCustomTargetWeights({
      expressionWeights: new Map([
        ['happy', 0.4],
        ['aa', 0.7]
      ]),
      expressionBindings: new Map([
        ['happy', ['smileTarget']],
        ['aa', ['viseme_aa']]
      ]),
      faceControlWeights: new Map([
        ['smileTarget', 0.8],
        ['jawLeft', 0.5]
      ]),
      rawTargetWeights: new Map([
        ['smileTarget', 0.2],
        ['eyeLookOutLeft', 0.6],
        ['custom_scar', 0.9]
      ])
    })
    expect(Object.fromEntries(weights)).toEqual({
      smileTarget: 0.2,
      viseme_aa: 0.7,
      jawLeft: 0.5,
      eyeLookOutLeft: 0.6,
      custom_scar: 0.9
    })
  })
})

describe('CustomPerformanceRigRuntime', () => {
  it('exposes the exact validated look nodes needed by camera-contact calibration', () => {
    const rig = buildRig()

    expect(rig.runtime.getLookNode('neck')).toBe(rig.neck)
    expect(rig.runtime.getLookNode('head')).toBe(rig.head)
    expect(rig.runtime.getLookNode('leftEye')).toBe(rig.leftEye)
    expect(rig.runtime.getLookNode('rightEye')).toBe(rig.rightEye)
  })

  it('restores mixer-authored gaze nodes to their bound parent-rest transforms', () => {
    const rig = buildRig()
    const rest = {
      neckPosition: rig.neck.position.clone(),
      neckRotation: rig.neck.quaternion.clone(),
      headPosition: rig.head.position.clone(),
      headRotation: rig.head.quaternion.clone(),
      leftEyePosition: rig.leftEye.position.clone(),
      leftEyeRotation: rig.leftEye.quaternion.clone(),
      rightEyePosition: rig.rightEye.position.clone(),
      rightEyeRotation: rig.rightEye.quaternion.clone()
    }

    for (const node of [rig.neck, rig.head, rig.leftEye, rig.rightEye]) {
      node.position.add(new THREE.Vector3(0.02, -0.01, 0.03))
      node.rotateX(0.2)
      node.rotateY(-0.3)
    }

    rig.runtime.neutralizeMotionLookNodes()

    expect(rig.neck.position).toEqual(rest.neckPosition)
    expectQuaternionClose(rig.neck.quaternion, rest.neckRotation)
    expect(rig.head.position).toEqual(rest.headPosition)
    expectQuaternionClose(rig.head.quaternion, rest.headRotation)
    expect(rig.leftEye.position).toEqual(rest.leftEyePosition)
    expectQuaternionClose(rig.leftEye.quaternion, rest.leftEyeRotation)
    expect(rig.rightEye.position).toEqual(rest.rightEyePosition)
    expectQuaternionClose(rig.rightEye.quaternion, rest.rightEyeRotation)
  })

  it('rebases Recipe-owned positions without adopting mixer-authored rotations', () => {
    const rig = buildRig()
    const canonicalRotations = {
      neck: rig.neck.quaternion.clone(),
      head: rig.head.quaternion.clone(),
      leftEye: rig.leftEye.quaternion.clone(),
      rightEye: rig.rightEye.quaternion.clone()
    }
    const recipePositions = {
      neck: rig.neck.position.clone().add(new THREE.Vector3(0, 0.02, 0)),
      head: rig.head.position.clone().add(new THREE.Vector3(0.01, 0.03, -0.02)),
      leftEye: rig.leftEye.position.clone().add(new THREE.Vector3(0.04, 0.01, 0)),
      rightEye: rig.rightEye.position.clone().add(new THREE.Vector3(-0.04, 0.01, 0))
    }

    rig.neck.position.copy(recipePositions.neck)
    rig.head.position.copy(recipePositions.head)
    rig.leftEye.position.copy(recipePositions.leftEye)
    rig.rightEye.position.copy(recipePositions.rightEye)
    rig.neck.rotateX(0.15)
    rig.head.rotateY(-0.25)
    rig.leftEye.rotateX(0.3)
    rig.rightEye.rotateX(-0.2)
    rig.runtime.rebaseLookNodePositions()

    rig.runtime.neutralizeMotionLookNodes()

    expect(rig.neck.position).toEqual(recipePositions.neck)
    expectQuaternionClose(rig.neck.quaternion, canonicalRotations.neck)
    expect(rig.head.position).toEqual(recipePositions.head)
    expectQuaternionClose(rig.head.quaternion, canonicalRotations.head)
    expect(rig.leftEye.position).toEqual(recipePositions.leftEye)
    expectQuaternionClose(rig.leftEye.quaternion, canonicalRotations.leftEye)
    expect(rig.rightEye.position).toEqual(recipePositions.rightEye)
    expectQuaternionClose(rig.rightEye.quaternion, canonicalRotations.rightEye)
  })

  it('composes bounded parent-space look overlays onto non-identity motion and keeps eye pivots fixed', () => {
    const rig = buildRig()
    const bases = {
      neck: rig.neck.quaternion.clone(),
      head: rig.head.quaternion.clone(),
      leftEye: rig.leftEye.quaternion.clone(),
      rightEye: rig.rightEye.quaternion.clone()
    }
    const positions = {
      leftEye: rig.leftEye.position.clone(),
      rightEye: rig.rightEye.position.clone()
    }
    const childBefore = rig.eyeAssembly.getWorldPosition(new THREE.Vector3())
    const direction: CustomPerformanceDirection = {
      headYaw: 4,
      headPitch: 0,
      leftEyeYaw: -2,
      leftEyePitch: 0,
      rightEyeYaw: 3,
      rightEyePitch: 0
    }

    rig.runtime.apply(direction, new Map())
    rig.root.updateMatrixWorld(true)

    expectQuaternionClose(
      overlayFrom(rig.head.quaternion, bases.head),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(-28)
      )
    )
    expectQuaternionClose(
      overlayFrom(rig.neck.quaternion, bases.neck),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(-12)
      )
    )
    expectQuaternionClose(
      overlayFrom(rig.leftEye.quaternion, bases.leftEye),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(60)
      )
    )
    expectQuaternionClose(
      overlayFrom(rig.rightEye.quaternion, bases.rightEye),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(-60)
      )
    )
    expect(rig.leftEye.position).toEqual(positions.leftEye)
    expect(rig.rightEye.position).toEqual(positions.rightEye)
    expect(
      rig.eyeAssembly
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(childBefore)
    ).toBeGreaterThan(0.01)
  })

  it('removes the prior overlay before a new mixer pose and restores exact neutral motion', () => {
    const rig = buildRig()
    rig.runtime.apply(
      {
        ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
        headYaw: 1,
        leftEyePitch: 1
      },
      new Map([['jawOpen', 0.75]])
    )
    rig.runtime.removeOverlay()

    const mixerHead = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.2, -0.3, 0.1)
    )
    const mixerEye = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.15, 0.05, 0.04)
    )
    const mixerJawPosition = new THREE.Vector3(0.01, -0.12, 0.03)
    rig.head.quaternion.copy(mixerHead)
    rig.leftEye.quaternion.copy(mixerEye)
    rig.jaw.position.copy(mixerJawPosition)

    rig.runtime.apply(
      {
        ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
        headPitch: -0.5,
        leftEyeYaw: 0.5
      },
      new Map([['jawOpen', 0.25]])
    )
    rig.runtime.apply(NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION, new Map())

    expectQuaternionClose(rig.head.quaternion, mixerHead)
    expectQuaternionClose(rig.leftEye.quaternion, mixerEye)
    expect(rig.jaw.position.distanceTo(mixerJawPosition)).toBeLessThan(1e-12)
  })

  it('drives generic transforms from the shared final target weights and cleans up on dispose', () => {
    const rig = buildRig()
    const basePosition = rig.jaw.position.clone()
    const baseQuaternion = rig.jaw.quaternion.clone()
    const weights = new Map([
      ['jawOpen', 0.5],
      ['jawLeft', 0.25],
      ['viseme_aa', 0.4]
    ])
    const expectedTranslation = new THREE.Vector3(
      -0.01 * 0.25,
      -0.02 * 0.5 - 0.01 * 0.4,
      0.01 * 0.5
    )
    const expectedRotationVector = new THREE.Vector3(
      0.3 * 0.5 + 0.1 * 0.4,
      0.1 * 0.25,
      0
    )
    const expectedRotation = new THREE.Quaternion().setFromAxisAngle(
      expectedRotationVector.clone().normalize(),
      expectedRotationVector.length()
    )

    rig.runtime.apply(NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION, weights)
    expect(
      rig.jaw.position.distanceTo(basePosition.clone().add(expectedTranslation))
    ).toBeLessThan(1e-12)
    expectQuaternionClose(
      overlayFrom(rig.jaw.quaternion, baseQuaternion),
      expectedRotation
    )

    rig.runtime.dispose()
    expect(rig.jaw.position.distanceTo(basePosition)).toBeLessThan(1e-12)
    expectQuaternionClose(rig.jaw.quaternion, baseQuaternion)
  })

  it('does not accumulate drift across repeated mixer-overlay cycles', () => {
    const rig = buildRig()
    const base = {
      head: rig.head.quaternion.clone(),
      leftEye: rig.leftEye.quaternion.clone(),
      jawPosition: rig.jaw.position.clone(),
      jawQuaternion: rig.jaw.quaternion.clone()
    }
    const direction = {
      ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
      headYaw: 0.61,
      leftEyePitch: -0.42,
      rightEyeYaw: 0.37
    }
    const weights = new Map([['jawOpen', 0.63]])

    for (let index = 0; index < 1_000; index += 1) {
      rig.runtime.removeOverlay()
      rig.runtime.apply(direction, weights)
    }
    rig.runtime.apply(NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION, new Map())

    expectQuaternionClose(rig.head.quaternion, base.head, 9)
    expectQuaternionClose(rig.leftEye.quaternion, base.leftEye, 9)
    expectQuaternionClose(rig.jaw.quaternion, base.jawQuaternion, 9)
    expect(rig.jaw.position.distanceTo(base.jawPosition)).toBeLessThan(1e-11)
  })
})

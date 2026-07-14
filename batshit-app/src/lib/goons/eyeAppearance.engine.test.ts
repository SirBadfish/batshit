import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { EyeAppearanceEngineRuntime } from './eyeAppearance.engine'
import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition,
  type EyeAppearanceDefinitionV1
} from './eyeAppearance'

function definition(): EyeAppearanceDefinitionV1 {
  return parseEyeAppearanceDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/eye-appearance/v1/eye-appearance-v1.json'),
        'utf8'
      )
    )
  )
}

function ellipsoidGeometry(rx: number, ry: number, rz: number) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([
        rx, 0, 0,
        -rx, 0, 0,
        0, ry, 0,
        0, -ry, 0,
        0, 0, rz,
        0, 0, -rz
      ]),
      3
    )
  )
  return geometry
}

function discGeometry(radius: number, rx: number, ry: number, rz: number, authoredOffset: number) {
  const points: number[] = []
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    const z = rz * Math.sqrt(1 - (x * x) / (rx * rx) - (y * y) / (ry * ry)) + authoredOffset
    points.push(x, y, z)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
  return geometry
}

function makeMesh(name: string, geometry: THREE.BufferGeometry) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  mesh.name = name
  return mesh
}

function fixture() {
  const definitionValue = definition()
  const root = new THREE.Group()
  const leftBone = new THREE.Bone()
  leftBone.name = definitionValue.runtimeBindings.left.eyeBone
  const rightBone = new THREE.Bone()
  rightBone.name = definitionValue.runtimeBindings.right.eyeBone
  leftBone.position.set(0.03, 0.06, 0.05)
  rightBone.position.set(-0.03, 0.06, 0.05)
  root.add(leftBone, rightBone)

  const createSide = (side: 'left' | 'right', bone: THREE.Bone) => {
    const spec = definitionValue.runtimeBindings[side]
    const [rx, ry, rz] = spec.conformal.scleraRadiiLocal
    const sclera = makeMesh(spec.assemblyNodes.sclera, ellipsoidGeometry(rx, ry, rz))
    const cornea = makeMesh(spec.assemblyNodes.cornea, ellipsoidGeometry(rx, ry, rz + 0.0002))
    const iris = makeMesh(
      spec.assemblyNodes.iris,
      discGeometry(0.005, rx, ry, rz, spec.conformal.irisAuthoredOffset)
    )
    const pupil = makeMesh(
      spec.assemblyNodes.pupil,
      discGeometry(0.002, rx, ry, rz, spec.conformal.pupilAuthoredOffset)
    )
    bone.add(sclera, cornea, iris, pupil)
    return { sclera, iris, pupil }
  }
  const left = createSide('left', leftBone)
  const right = createSide('right', rightBone)

  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton([leftBone, rightBone])
  skeleton.calculateInverses()
  const skinGeometry = new THREE.BufferGeometry()
  skinGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3))
  skinGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4))
  skinGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4))
  const skin = new THREE.SkinnedMesh(skinGeometry, new THREE.MeshBasicMaterial())
  skin.name = 'fixture_skin'
  skin.bind(skeleton)
  root.add(skin)
  root.updateMatrixWorld(true)
  return { definitionValue, root, leftBone, rightBone, left, right, skeleton }
}

function expectVectorClose(actual: THREE.Vector3, expected: THREE.Vector3) {
  expect(actual.x).toBeCloseTo(expected.x, 8)
  expect(actual.y).toBeCloseTo(expected.y, 8)
  expect(actual.z).toBeCloseTo(expected.z, 8)
}

describe('EyeAppearanceEngineRuntime', () => {
  it('keeps the exact post-Recipe zero state byte-for-byte and transform-for-transform neutral', () => {
    const value = fixture()
    const irisBefore = Array.from(
      (value.left.iris.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    )
    const bonePosition = value.leftBone.position.clone()
    const boneQuaternion = value.leftBone.quaternion.clone()
    const inverse = value.skeleton.boneInverses[0].clone()
    new EyeAppearanceEngineRuntime(value.root, value.definitionValue, null)
    expect(
      Array.from(
        (value.left.iris.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
      )
    ).toEqual(irisBefore)
    expect(value.leftBone.position.equals(bonePosition)).toBe(true)
    expect(value.leftBone.quaternion.equals(boneQuaternion)).toBe(true)
    expect(value.skeleton.boneInverses[0].equals(inverse)).toBe(true)
  })

  it('adds its pivot delta to the mixer-sampled pose and removes it reversibly', () => {
    const value = fixture()
    const state = createDefaultEyeAppearanceState(value.definitionValue)
    state.scleraFit.horizontal = 0.001
    state.scleraFit.vertical = 0.0005
    state.scleraFit.tilt = 2
    const runtime = new EyeAppearanceEngineRuntime(value.root, value.definitionValue, state)
    runtime.removeOverlay()

    const sampledPosition = new THREE.Vector3(0.12, -0.08, 0.04)
    const sampledRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.2, 0.05))
    value.leftBone.position.copy(sampledPosition)
    value.leftBone.quaternion.copy(sampledRotation)
    runtime.applyOverlay()
    expect(value.leftBone.position.x).toBeCloseTo(sampledPosition.x + 0.001, 8)
    expect(value.leftBone.position.y).toBeCloseTo(sampledPosition.y + 0.0005, 8)
    expect(value.leftBone.position).not.toEqual(sampledPosition)

    runtime.removeOverlay()
    expectVectorClose(value.leftBone.position, sampledPosition)
    expect(value.leftBone.quaternion.angleTo(sampledRotation)).toBeLessThan(1e-8)
  })

  it('restores the Recipe inverse baseline before edits and captures the replacement baseline afterward', () => {
    const value = fixture()
    const originalInverse = value.skeleton.boneInverses[0].clone()
    const state = createDefaultEyeAppearanceState(value.definitionValue)
    state.scleraFit.horizontal = 0.001
    const runtime = new EyeAppearanceEngineRuntime(value.root, value.definitionValue, state)
    expect(value.skeleton.boneInverses[0].equals(originalInverse)).toBe(false)

    runtime.prepareForRecipeUpdate()
    expect(value.skeleton.boneInverses[0].equals(originalInverse)).toBe(true)

    const recipeOffset = new THREE.Vector3(0.002, 0, 0)
    value.leftBone.position.add(recipeOffset)
    const recipeInverse = originalInverse
      .clone()
      .multiply(new THREE.Matrix4().makeTranslation(-recipeOffset.x, -recipeOffset.y, -recipeOffset.z))
    value.skeleton.boneInverses[0].copy(recipeInverse)
    runtime.rebaseFromRecipeAndApply()
    runtime.prepareForRecipeUpdate()
    expect(value.skeleton.boneInverses[0].equals(recipeInverse)).toBe(true)
  })

  it('recomputes fitted sclera radii from post-Recipe geometry before conformal sizing', () => {
    const value = fixture()
    const runtime = new EyeAppearanceEngineRuntime(value.root, value.definitionValue, null)
    runtime.prepareForRecipeUpdate()

    const leftSpec = value.definitionValue.runtimeBindings.left
    const newRx = 0.02
    const newRy = 0.018
    const newRz = 0.019
    value.left.sclera.geometry.setAttribute('position', ellipsoidGeometry(newRx, newRy, newRz).getAttribute('position'))
    value.left.iris.geometry.setAttribute(
      'position',
      discGeometry(0.012, newRx, newRy, newRz, leftSpec.conformal.irisAuthoredOffset).getAttribute('position')
    )
    runtime.rebaseFromRecipeAndApply()

    const state = createDefaultEyeAppearanceState(value.definitionValue)
    state.irisSize = 1.35
    expect(() => runtime.setState(state)).not.toThrow()
    const position = value.left.iris.geometry.getAttribute('position') as THREE.BufferAttribute
    expect(position.getX(0)).toBeCloseTo(0.012 * 1.35, 6)
    const expectedZ =
      newRz * Math.sqrt(1 - ((0.012 * 1.35) ** 2) / (newRx * newRx)) +
      leftSpec.conformal.irisAuthoredOffset
    expect(position.getZ(0)).toBeCloseTo(expectedZ, 6)
  })
})

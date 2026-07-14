import * as THREE from 'three'
import {
  resolveEyeAppearanceState,
  type EyeAppearanceDefinitionV1,
  type EyeAppearanceRuntimeSideBinding,
  type EyeAppearanceStateV1
} from './eyeAppearance'

type Side = 'left' | 'right'

type RuntimeAssemblyNode = {
  node: THREE.Object3D
  basePosition: THREE.Vector3
  baseScale: THREE.Vector3
}

type RuntimeSurface = {
  mesh: THREE.Mesh<THREE.BufferGeometry>
  scleraMesh: THREE.Mesh<THREE.BufferGeometry>
  position: THREE.BufferAttribute
  basePosition: Float32Array
  center: THREE.Vector3
  scleraCenter: THREE.Vector3
  opticalAxis: THREE.Vector3
  scleraRadii: THREE.Vector3
  authoredOffset: number
}

type RuntimeInverse = {
  skeleton: THREE.Skeleton
  index: number
  baseInverse: THREE.Matrix4
}

type RuntimeSide = {
  spec: EyeAppearanceRuntimeSideBinding
  bone: THREE.Object3D
  baseBonePosition: THREE.Vector3
  baseBoneQuaternion: THREE.Quaternion
  baseBoneScale: THREE.Vector3
  assembly: RuntimeAssemblyNode[]
  iris: RuntimeSurface
  pupil: RuntimeSurface
  inverses: RuntimeInverse[]
  appliedTranslation: THREE.Vector3
  appliedRotation: THREE.Quaternion
  appliedAssemblyScale: number
}

function fail(message: string): never {
  throw new Error(`[eye-appearance/runtime] ${message}`)
}

function exactNamedObject(root: THREE.Object3D, name: string) {
  const matches: THREE.Object3D[] = []
  root.traverse((node) => {
    if (node.name === name) matches.push(node)
  })
  if (matches.length !== 1) fail(`expected exactly one runtime object named ${name}, found ${matches.length}`)
  return matches[0]
}

function exactMesh(root: THREE.Object3D, name: string) {
  const node = exactNamedObject(root, name)
  if (!(node as { isMesh?: boolean }).isMesh) fail(`${name} must be a mesh`)
  return node as THREE.Mesh<THREE.BufferGeometry>
}

function positionAttribute(mesh: THREE.Mesh<THREE.BufferGeometry>) {
  const position = mesh.geometry.getAttribute('position')
  if (
    !(position instanceof THREE.BufferAttribute) ||
    position.itemSize !== 3 ||
    position.normalized ||
    !(position.array instanceof Float32Array)
  ) {
    fail(`${mesh.name} must expose a non-interleaved Float32 POSITION attribute`)
  }
  return position
}

function tupleVector(value: [number, number, number]) {
  return new THREE.Vector3(...value)
}

function captureSurface(
  mesh: THREE.Mesh<THREE.BufferGeometry>,
  scleraMesh: THREE.Mesh<THREE.BufferGeometry>,
  center: [number, number, number],
  opticalAxis: [number, number, number],
  scleraRadii: [number, number, number],
  authoredOffset: number
): RuntimeSurface {
  const position = positionAttribute(mesh)
  return {
    mesh,
    scleraMesh,
    position,
    basePosition: new Float32Array(position.array as Float32Array),
    center: tupleVector(center),
    scleraCenter: new THREE.Vector3(),
    opticalAxis: tupleVector(opticalAxis).normalize(),
    scleraRadii: tupleVector(scleraRadii),
    authoredOffset
  }
}

function restoreSurface(surface: RuntimeSurface) {
  ;(surface.position.array as Float32Array).set(surface.basePosition)
  surface.position.needsUpdate = true
  surface.mesh.geometry.computeVertexNormals()
  surface.mesh.geometry.computeBoundingBox()
  surface.mesh.geometry.computeBoundingSphere()
}

function resizeConformally(surface: RuntimeSurface, multiplier: number) {
  const output = surface.position.array as Float32Array
  const source = surface.basePosition
  if (multiplier === 1) {
    output.set(source)
    surface.position.needsUpdate = true
    return
  }
  const center = surface.center
  if (!surface.opticalAxis.equals(new THREE.Vector3(0, 0, 1))) {
    fail(`${surface.mesh.name} conformal solver currently requires the package-declared +Z optical axis`)
  }
  const radii = surface.scleraRadii

  for (let offset = 0; offset < source.length; offset += 3) {
    const x = center.x + (source[offset] - center.x) * multiplier
    const y = center.y + (source[offset + 1] - center.y) * multiplier
    const localX = x - surface.scleraCenter.x
    const localY = y - surface.scleraCenter.y
    const squared =
      1 - (localX * localX) / (radii.x * radii.x) - (localY * localY) / (radii.y * radii.y)
    if (squared < -1e-6) {
      fail(`${surface.mesh.name} size ${multiplier} exceeds the package-calibrated sclera surface`)
    }
    const z =
      surface.scleraCenter.z + radii.z * Math.sqrt(Math.max(0, squared)) + surface.authoredOffset
    output[offset] = x
    output[offset + 1] = y
    output[offset + 2] = z
  }
  surface.position.needsUpdate = true
  surface.mesh.geometry.computeVertexNormals()
  surface.mesh.geometry.computeBoundingBox()
  surface.mesh.geometry.computeBoundingSphere()
}

export class EyeAppearanceEngineRuntime {
  private state: EyeAppearanceStateV1
  private readonly sides: Record<Side, RuntimeSide>
  private disposed = false

  constructor(
    private readonly root: THREE.Object3D,
    readonly definition: EyeAppearanceDefinitionV1,
    initialState: EyeAppearanceStateV1 | null | undefined
  ) {
    this.state = resolveEyeAppearanceState(definition, initialState)
    this.sides = {
      left: this.bindSide(definition.runtimeBindings.left),
      right: this.bindSide(definition.runtimeBindings.right)
    }
    if (
      this.sides.left.iris.position === this.sides.right.iris.position ||
      this.sides.left.pupil.position === this.sides.right.pupil.position
    ) {
      fail('left/right Iris and Pupil POSITION buffers must be isolated before Eye Appearance binds')
    }
    this.rebaseFromRecipeAndApply()
  }

  private bindSide(spec: EyeAppearanceRuntimeSideBinding): RuntimeSide {
    const bone = exactNamedObject(this.root, spec.eyeBone)
    if (!(bone as { isBone?: boolean }).isBone) fail(`${spec.eyeBone} must be an eye bone`)
    const assemblyNames = Object.values(spec.assemblyNodes)
    if (new Set(assemblyNames).size !== assemblyNames.length) fail(`${spec.eyeBone} assembly nodes must be unique`)
    const assembly = assemblyNames.map((name) => {
      const node = exactNamedObject(this.root, name)
      if (node.parent !== bone) fail(`${name} must remain a direct child of ${spec.eyeBone}`)
      return { node, basePosition: node.position.clone(), baseScale: node.scale.clone() }
    })
    const iris = exactMesh(this.root, spec.assemblyNodes.iris)
    const pupil = exactMesh(this.root, spec.assemblyNodes.pupil)
    const sclera = exactMesh(this.root, spec.assemblyNodes.sclera)
    return {
      spec,
      bone,
      baseBonePosition: bone.position.clone(),
      baseBoneQuaternion: bone.quaternion.clone(),
      baseBoneScale: bone.scale.clone(),
      assembly,
      iris: captureSurface(
        iris,
        sclera,
        spec.conformal.irisCenterLocal,
        spec.conformal.opticalAxisLocal,
        spec.conformal.scleraRadiiLocal,
        spec.conformal.irisAuthoredOffset
      ),
      pupil: captureSurface(
        pupil,
        sclera,
        spec.conformal.pupilCenterLocal,
        spec.conformal.opticalAxisLocal,
        spec.conformal.scleraRadiiLocal,
        spec.conformal.pupilAuthoredOffset
      ),
      inverses: [],
      appliedTranslation: new THREE.Vector3(),
      appliedRotation: new THREE.Quaternion(),
      appliedAssemblyScale: 1
    }
  }

  getState() {
    return structuredClone(this.state)
  }

  setState(value: EyeAppearanceStateV1 | null | undefined) {
    if (this.disposed) fail('cannot apply state after disposal')
    this.removeOverlay()
    this.restoreBaseInverses()
    this.restoreBaseGeometry()
    this.state = resolveEyeAppearanceState(this.definition, value)
    this.applyStaticState()
    this.applyOverlay()
    return this.getState()
  }

  /** Remove all Eye Appearance writes before Appearance Dials rewrites Recipe state. */
  prepareForRecipeUpdate() {
    if (this.disposed) return
    this.removeOverlay()
    this.restoreBaseInverses()
    this.restoreBaseGeometry()
  }

  /**
   * Call only after the Recipe runtime has rewritten its baked POSITION data,
   * follower transforms, eye rest positions, and skin inverses. The resulting
   * capture is the new zero state for Eye Appearance.
   */
  rebaseFromRecipeAndApply() {
    if (this.disposed) return
    this.removeOverlay()
    this.root.updateMatrixWorld(true)
    for (const side of ['left', 'right'] as const) this.captureRecipeBaseline(this.sides[side])
    this.applyStaticState()
    this.applyOverlay()
  }

  private captureRecipeBaseline(runtime: RuntimeSide) {
    runtime.baseBonePosition.copy(runtime.bone.position)
    runtime.baseBoneQuaternion.copy(runtime.bone.quaternion)
    runtime.baseBoneScale.copy(runtime.bone.scale)
    for (const entry of runtime.assembly) {
      entry.basePosition.copy(entry.node.position)
      entry.baseScale.copy(entry.node.scale)
    }
    const irisPosition = positionAttribute(runtime.iris.mesh)
    runtime.iris.position = irisPosition
    runtime.iris.basePosition = new Float32Array(irisPosition.array as Float32Array)
    const pupilPosition = positionAttribute(runtime.pupil.mesh)
    runtime.pupil.position = pupilPosition
    runtime.pupil.basePosition = new Float32Array(pupilPosition.array as Float32Array)
    this.captureFittedSurface(runtime.iris)
    this.captureFittedSurface(runtime.pupil)

    runtime.inverses = []
    this.root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh
      if (!(mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh || !mesh.skeleton) return
      mesh.skeleton.bones.forEach((candidate, index) => {
        if (candidate !== runtime.bone) return
        const inverse = mesh.skeleton.boneInverses[index]
        if (!inverse) fail(`${mesh.name} is missing the inverse bind for ${runtime.spec.eyeBone}`)
        runtime.inverses.push({ skeleton: mesh.skeleton, index, baseInverse: inverse.clone() })
      })
    })
    if (runtime.inverses.length === 0) fail(`${runtime.spec.eyeBone} is not referenced by any skin`)
  }

  private captureFittedSurface(surface: RuntimeSurface) {
    const scleraPosition = positionAttribute(surface.scleraMesh)
    const values = scleraPosition.array as Float32Array
    const minimum = new THREE.Vector3(Infinity, Infinity, Infinity)
    const maximum = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    for (let offset = 0; offset < values.length; offset += 3) {
      minimum.min(new THREE.Vector3(values[offset], values[offset + 1], values[offset + 2]))
      maximum.max(new THREE.Vector3(values[offset], values[offset + 1], values[offset + 2]))
    }
    surface.scleraCenter.addVectors(minimum, maximum).multiplyScalar(0.5)
    surface.scleraRadii.subVectors(maximum, minimum).multiplyScalar(0.5)
    if (surface.scleraRadii.x <= 0 || surface.scleraRadii.y <= 0 || surface.scleraRadii.z <= 0) {
      fail(`${surface.scleraMesh.name} has invalid post-Recipe sclera radii`)
    }

    const disc = surface.basePosition
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let offset = 0; offset < disc.length; offset += 3) {
      minX = Math.min(minX, disc[offset])
      maxX = Math.max(maxX, disc[offset])
      minY = Math.min(minY, disc[offset + 1])
      maxY = Math.max(maxY, disc[offset + 1])
    }
    surface.center.x = (minX + maxX) * 0.5
    surface.center.y = (minY + maxY) * 0.5
  }

  private translationFor(runtime: RuntimeSide) {
    const fit = this.state.scleraFit
    return tupleVector(runtime.spec.horizontalAxisParent)
      .multiplyScalar(fit.horizontal * runtime.spec.horizontalSign)
      .addScaledVector(tupleVector(runtime.spec.verticalAxisParent), fit.vertical)
      .addScaledVector(tupleVector(runtime.spec.depthAxisParent), fit.depth)
  }

  private rotationFor(runtime: RuntimeSide) {
    return new THREE.Quaternion().setFromAxisAngle(
      tupleVector(runtime.spec.tiltAxisParent),
      THREE.MathUtils.degToRad(this.state.scleraFit.tilt * runtime.spec.tiltSign)
    )
  }

  private applyStaticState() {
    resizeConformally(this.sides.left.iris, this.state.irisSize)
    resizeConformally(this.sides.right.iris, this.state.irisSize)
    resizeConformally(this.sides.left.pupil, this.state.pupilSize)
    resizeConformally(this.sides.right.pupil, this.state.pupilSize)
    for (const side of ['left', 'right'] as const) this.applyInverseCorrection(this.sides[side])
  }

  private applyInverseCorrection(runtime: RuntimeSide) {
    const translation = this.translationFor(runtime)
    const rotation = this.rotationFor(runtime)
    if (translation.lengthSq() === 0 && Math.abs(rotation.w) === 1) {
      const skeletons = new Set<THREE.Skeleton>()
      for (const entry of runtime.inverses) {
        entry.skeleton.boneInverses[entry.index].copy(entry.baseInverse)
        skeletons.add(entry.skeleton)
      }
      for (const skeleton of skeletons) skeleton.update()
      return
    }
    const desiredPosition = runtime.baseBonePosition.clone().add(translation)
    const desiredQuaternion = runtime.baseBoneQuaternion.clone().premultiply(rotation).normalize()
    const baseLocal = new THREE.Matrix4().compose(
      runtime.baseBonePosition,
      runtime.baseBoneQuaternion,
      runtime.baseBoneScale
    )
    const desiredLocal = new THREE.Matrix4().compose(
      desiredPosition,
      desiredQuaternion,
      runtime.baseBoneScale
    )
    const updatedSkeletons = new Set<THREE.Skeleton>()
    for (const entry of runtime.inverses) {
      const baseBindWorld = entry.baseInverse.clone().invert()
      const parentBindWorld = baseBindWorld.multiply(baseLocal.clone().invert())
      const desiredBindWorld = parentBindWorld.multiply(desiredLocal)
      entry.skeleton.boneInverses[entry.index].copy(desiredBindWorld.invert())
      updatedSkeletons.add(entry.skeleton)
    }
    for (const skeleton of updatedSkeletons) skeleton.update()
  }

  removeOverlay() {
    if (this.disposed) return
    for (const side of ['left', 'right'] as const) {
      const runtime = this.sides[side]
      if (runtime.appliedTranslation.lengthSq() > 0) runtime.bone.position.sub(runtime.appliedTranslation)
      if (Math.abs(runtime.appliedRotation.w) !== 1) {
        runtime.bone.quaternion.premultiply(runtime.appliedRotation.clone().invert()).normalize()
      }
      for (const entry of runtime.assembly) {
        if (runtime.appliedAssemblyScale !== 1) {
          entry.node.position.divideScalar(runtime.appliedAssemblyScale)
          entry.node.scale.divideScalar(runtime.appliedAssemblyScale)
        }
      }
      runtime.appliedTranslation.set(0, 0, 0)
      runtime.appliedRotation.identity()
      runtime.appliedAssemblyScale = 1
    }
  }

  applyOverlay() {
    if (this.disposed) return
    const assemblyScale = 1 + this.state.scleraFit.scale
    for (const side of ['left', 'right'] as const) {
      const runtime = this.sides[side]
      const translation = this.translationFor(runtime)
      const rotation = this.rotationFor(runtime)
      if (translation.lengthSq() > 0) runtime.bone.position.add(translation)
      if (Math.abs(rotation.w) !== 1) runtime.bone.quaternion.premultiply(rotation).normalize()
      for (const entry of runtime.assembly) {
        if (assemblyScale !== 1) {
          entry.node.position.multiplyScalar(assemblyScale)
          entry.node.scale.multiplyScalar(assemblyScale)
        }
      }
      runtime.appliedTranslation.copy(translation)
      runtime.appliedRotation.copy(rotation)
      runtime.appliedAssemblyScale = assemblyScale
    }
    this.root.updateMatrixWorld(true)
  }

  private restoreBaseInverses() {
    const skeletons = new Set<THREE.Skeleton>()
    for (const side of ['left', 'right'] as const) {
      for (const entry of this.sides[side].inverses) {
        entry.skeleton.boneInverses[entry.index].copy(entry.baseInverse)
        skeletons.add(entry.skeleton)
      }
    }
    for (const skeleton of skeletons) skeleton.update()
  }

  private restoreBaseGeometry() {
    restoreSurface(this.sides.left.iris)
    restoreSurface(this.sides.right.iris)
    restoreSurface(this.sides.left.pupil)
    restoreSurface(this.sides.right.pupil)
  }

  dispose() {
    if (this.disposed) return
    this.removeOverlay()
    this.restoreBaseInverses()
    this.restoreBaseGeometry()
    this.disposed = true
  }
}

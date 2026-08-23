import * as THREE from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  cross,
  dot,
  fract,
  length,
  max,
  mix,
  modelViewMatrix,
  positionLocal,
  positionViewDirection,
  sqrt,
  smoothstep,
  step,
  texture,
  transformNormal,
  uniform,
  vec2,
  vec3
} from 'three/tsl'
import {
  SOCKET_EYE_COMPOSITE_LAYER_ORDER,
  type SocketEyeSide,
  type SocketEyeSurfaceDefinitionV2,
  type SocketEyeSurfaceSideDefinitionV2
} from './socketEyeSurface'
import {
  validateSocketEyeApertureOwnership,
  type EyeApertureSeamDefinitionV2,
  type EyeApertureSeamSideDefinitionV2
} from './eyeApertureSeam'
import {
  LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE,
  SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_RADIAL_ARTWORK_BOUNDARY_UV_SCALE,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT
} from './socketEyeArtworkProjection'

type RuntimeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
type SocketEyeRgba = [number, number, number, number]

export type SocketEyeArtworkProjectionMode = 'legacy' | 'corrected' | 'corrected-inset'

export type SocketEyeCompositeTextureLayer = {
  texture: THREE.Texture | null
  tint: SocketEyeRgba
  opacity: number
}

export type SocketEyeCompositeVisualState = {
  scleraColor: SocketEyeRgba
  irisColor: SocketEyeRgba
  pupilColor: SocketEyeRgba
  irisRadiusMeters: number
  pupilRadiusRatio: number
  irisHorizontalOffsetMeters: number
  irisVerticalOffsetMeters: number
  edgeSoftnessMeters: number
  scleraArtwork: SocketEyeCompositeTextureLayer
  irisArtwork: SocketEyeCompositeTextureLayer
  pupilArtwork: SocketEyeCompositeTextureLayer
  highlight: SocketEyeCompositeTextureLayer
  cornea: {
    roughness: number
    clearcoat: number
    clearcoatRoughness: number
  }
}

type MaterialUniforms = {
  gaze: any
  sphereCenterLocal: any
  horizontalAxisLocal: any
  verticalAxisLocal: any
  forwardAxisLocal: any
  scleraColor: any
  irisColor: any
  pupilColor: any
  irisRadius: any
  pupilRadiusRatio: any
  pupilVisibility: any
  irisHorizontalOffset: any
  irisVerticalOffset: any
  edgeSoftness: any
  scleraArtworkTint: any
  scleraArtworkOpacity: any
  irisArtworkTint: any
  irisArtworkOpacity: any
  pupilArtworkTint: any
  pupilArtworkOpacity: any
  highlightTint: any
  highlightOpacity: any
}

type TextureNodes = {
  scleraArtwork: any
  irisArtwork: any
  pupilArtwork: any
  highlight: any
}

type BoundSide = {
  physicalEye: RuntimeMesh
  treatmentRoot: THREE.Object3D
  upperTreatment: RuntimeMesh
  lowerTreatment: RuntimeMesh
  treatmentSurfaceCorrection: BoundTreatmentSurfaceCorrection
  originalPhysicalMaterial: THREE.Material
  originalPhysicalRenderOrder: number
  originalUpperRenderOrder: number
  originalLowerRenderOrder: number
  compositeMaterial: SocketEyeCompositeMaterialRuntime
  metricFrame: SocketEyeSurfaceMetricFrame
}

type BoundTreatmentCorrectionIndices = {
  blink: number
  projection: number | null
  linear: number
  residual: number
}

type BoundTreatmentSurfaceCorrection = {
  kind: 'recipe-source' | 'compact-runtime'
  upper: BoundTreatmentCorrectionIndices
  lower: BoundTreatmentCorrectionIndices
}

export type SocketEyeSurfaceMetricFrame = {
  horizontalAxisLocal: THREE.Vector3
  verticalAxisLocal: THREE.Vector3
  forwardAxisLocal: THREE.Vector3
  sphereCenterLocal: THREE.Vector3
}

type BodyDepthMaterialState = {
  material: THREE.Material
  depthWrite: boolean
}

export const SOCKET_EYE_COMPOSITE_RENDER_ORDER = 100
export const SOCKET_EYE_TREATMENT_RENDER_ORDER = 101
export const SOCKET_EYE_SCLERA_EMISSIVE_WEIGHT = 0.45

function fail(message: string): never {
  throw new Error(`[socket-eye-surface/runtime-v2] ${message}`)
}

function finite(value: number, context: string) {
  if (!Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function positive(value: number, context: string) {
  const parsed = finite(value, context)
  if (parsed <= 0) fail(`${context} must be greater than zero`)
  return parsed
}

function nonNegative(value: number, context: string) {
  const parsed = finite(value, context)
  if (parsed < 0) fail(`${context} must not be negative`)
  return parsed
}

function unitInterval(value: number, context: string) {
  const parsed = finite(value, context)
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`)
  return parsed
}

function rgba(value: SocketEyeRgba, context: string, opaque: boolean) {
  if (!Array.isArray(value) || value.length !== 4) fail(`${context} must contain four channels`)
  const parsed = value.map((channel, index) =>
    unitInterval(channel, `${context}[${index}]`)
  ) as SocketEyeRgba
  if (opaque && parsed[3] !== 1) fail(`${context} must remain opaque`)
  return parsed
}

function colorFromSrgb(value: SocketEyeRgba) {
  return new THREE.Color().setRGB(value[0], value[1], value[2], THREE.SRGBColorSpace)
}

function makeTransparentPixelTexture() {
  const value = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat)
  value.name = 'Batshit socket-eye transparent texture'
  value.colorSpace = THREE.SRGBColorSpace
  value.needsUpdate = true
  return value
}

function materialList(material: THREE.Material | THREE.Material[]) {
  return Array.isArray(material) ? material : [material]
}

function exactNamedObject(root: THREE.Object3D, name: string) {
  const matches: THREE.Object3D[] = []
  root.traverse((node) => {
    if (node.name === name) matches.push(node)
  })
  if (matches.length !== 1)
    fail(`expected exactly one runtime object named ${name}, found ${matches.length}`)
  return matches[0]
}

function exactNamedMesh(root: THREE.Object3D, name: string): RuntimeMesh {
  const node = exactNamedObject(root, name)
  if (!(node as { isMesh?: boolean }).isMesh) fail(`${name} must be a mesh`)
  return node as RuntimeMesh
}

function validateTrianglePrimitive(mesh: RuntimeMesh, context: string) {
  if (Array.isArray(mesh.material)) fail(`${context} must own one material`)
  const count = mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0
  if (count <= 0 || count % 3 !== 0) fail(`${context} must contain complete triangles`)
  const uvAttribute = mesh.geometry.getAttribute('uv')
  if (!uvAttribute || uvAttribute.itemSize !== 2 || uvAttribute.count <= 0) {
    fail(`${context} must expose the package-authored UV projection`)
  }
}

function validateStaticPhysicalEye(mesh: RuntimeMesh, context: string) {
  validateTrianglePrimitive(mesh, context)
  if (
    (mesh.geometry.morphAttributes.position?.length ?? 0) !== 0 ||
    Object.keys(mesh.morphTargetDictionary ?? {}).length !== 0 ||
    (mesh.morphTargetInfluences?.length ?? 0) !== 0
  ) {
    fail(`${context} must be a zero-morph static physical eye`)
  }
}

function readTreatmentMorphInventory(mesh: RuntimeMesh, context: string) {
  const basePosition = mesh.geometry.getAttribute('position')
  if (!basePosition || basePosition.itemSize !== 3 || basePosition.count <= 0) {
    fail(`${context} must expose a valid base POSITION attribute`)
  }
  const positionMorphs = mesh.geometry.morphAttributes.position ?? []
  const dictionary = mesh.morphTargetDictionary ?? {}
  const influences = mesh.morphTargetInfluences ?? []
  if (!mesh.geometry.morphTargetsRelative)
    fail(`${context} follower morphs must use relative glTF deltas`)
  if (
    positionMorphs.length !== Object.keys(dictionary).length ||
    positionMorphs.length !== influences.length
  ) {
    fail(`${context} morph attributes, dictionary, and influences must have equal lengths`)
  }
  const namesByIndex = new Array<string>(positionMorphs.length)
  for (const [name, index] of Object.entries(dictionary)) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= positionMorphs.length ||
      namesByIndex[index]
    ) {
      fail(`${context} follower morph dictionary contains an invalid index for ${name}`)
    }
    namesByIndex[index] = name
  }
  for (const [index, attribute] of positionMorphs.entries()) {
    if (namesByIndex[index] === undefined) {
      fail(`${context} follower morph dictionary must bind every morph attribute index`)
    }
    if (attribute.itemSize !== 3 || attribute.count !== basePosition.count) {
      fail(`${context} follower morph ${namesByIndex[index]} must match the base POSITION layout`)
    }
  }
  return {
    dictionary,
    sortedNames: [...namesByIndex].sort()
  }
}

function sameSortedNames(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  )
}

function bindTreatmentSurfaceCorrection(
  mesh: RuntimeMesh,
  seam: EyeApertureSeamSideDefinitionV2,
  context: string
): {
  kind: 'recipe-source' | 'compact-runtime'
  indices: BoundTreatmentCorrectionIndices
} {
  const inventory = readTreatmentMorphInventory(mesh, context)
  const correction = seam.treatment.surfaceCorrection
  const sourceNames = [
    ...seam.treatment.followerMorphs,
    correction.projectionMorph,
    correction.blinkLinearMorph,
    correction.blinkResidualMorph
  ].sort()
  const compactRuntimeNames = [
    ...seam.treatment.retainedPerformanceMorphs,
    correction.blinkLinearMorph,
    correction.blinkResidualMorph
  ].sort()
  const kind = sameSortedNames(inventory.sortedNames, sourceNames)
    ? 'recipe-source'
    : sameSortedNames(inventory.sortedNames, compactRuntimeNames)
      ? 'compact-runtime'
      : null
  if (!kind) {
    fail(
      `${context} morph inventory must exactly match raw Recipe Source followers plus three surface correctives or compact runtime retained performance plus linear/residual correctives`
    )
  }
  const index = (name: string) => {
    const resolved = inventory.dictionary[name]
    if (!Number.isInteger(resolved)) fail(`${context} is missing bound correction morph ${name}`)
    return resolved
  }
  return {
    kind,
    indices: {
      blink: index(correction.blinkMorph),
      projection: kind === 'recipe-source' ? index(correction.projectionMorph) : null,
      linear: index(correction.blinkLinearMorph),
      residual: index(correction.blinkResidualMorph)
    }
  }
}

function sphereCenterForGeometry(mesh: RuntimeMesh) {
  const position = mesh.geometry.getAttribute('position')
  if (!position || position.itemSize !== 3 || position.count <= 0) {
    fail(`${mesh.name} cannot resolve a physical sphere center without POSITION`)
  }
  mesh.geometry.computeBoundingBox()
  const box = mesh.geometry.boundingBox
  if (!box) fail(`${mesh.name} did not produce a physical sphere bound`)
  return box.getCenter(new THREE.Vector3())
}

const HEAD_OWNER_NAMES = new Set(['mixamorig:Head', 'mixamorigHead', 'Head'])

function exactHeadOwner(physicalEye: RuntimeMesh) {
  const matches: THREE.Object3D[] = []
  for (let owner = physicalEye.parent; owner; owner = owner.parent) {
    if (HEAD_OWNER_NAMES.has(owner.name)) matches.push(owner)
  }
  if (matches.length !== 1) {
    fail(`${physicalEye.name} must retain exactly one Head-space ancestor, found ${matches.length}`)
  }
  return matches[0]!
}

export function resolveSocketEyeSurfaceMetricFrame(
  physicalEye: RuntimeMesh,
  side: SocketEyeSurfaceSideDefinitionV2
): SocketEyeSurfaceMetricFrame {
  const headOwner = exactHeadOwner(physicalEye)
  headOwner.updateWorldMatrix(true, false)
  physicalEye.updateWorldMatrix(true, false)
  const headToMesh = physicalEye.matrixWorld.clone().invert().multiply(headOwner.matrixWorld)
  const horizontalAxisLocal = new THREE.Vector3(...side.horizontalAxisHeadLocal)
    .transformDirection(headToMesh)
    .normalize()
  const verticalAxisLocal = new THREE.Vector3(...side.verticalAxisHeadLocal)
    .transformDirection(headToMesh)
    .normalize()
  const forwardAxisLocal = new THREE.Vector3(...side.forwardAxisHeadLocal)
    .transformDirection(headToMesh)
    .normalize()
  if (
    !Number.isFinite(horizontalAxisLocal.lengthSq()) ||
    !Number.isFinite(verticalAxisLocal.lengthSq()) ||
    !Number.isFinite(forwardAxisLocal.lengthSq()) ||
    Math.abs(horizontalAxisLocal.dot(verticalAxisLocal)) > 1e-5 ||
    Math.abs(horizontalAxisLocal.dot(forwardAxisLocal)) > 1e-5 ||
    Math.abs(verticalAxisLocal.dot(forwardAxisLocal)) > 1e-5
  ) {
    fail(`${physicalEye.name} physical artwork axes are invalid`)
  }
  return {
    horizontalAxisLocal,
    verticalAxisLocal,
    forwardAxisLocal,
    sphereCenterLocal: sphereCenterForGeometry(physicalEye)
  }
}

function bindTreatmentPrimitives(root: THREE.Object3D, seam: EyeApertureSeamSideDefinitionV2) {
  const treatmentRoot = exactNamedObject(root, seam.lashesEyeOutlineNode)
  if ((treatmentRoot as { isMesh?: boolean }).isMesh) {
    fail(`${treatmentRoot.name} must contain separate upper and lower treatment primitives`)
  }
  const meshes: RuntimeMesh[] = []
  treatmentRoot.traverse((node) => {
    if (node !== treatmentRoot && (node as { isMesh?: boolean }).isMesh)
      meshes.push(node as RuntimeMesh)
  })
  if (meshes.length !== 2) {
    fail(`${treatmentRoot.name} must contain exactly two treatment meshes, found ${meshes.length}`)
  }
  const byMaterialName = (name: string) =>
    meshes.filter((mesh) => !Array.isArray(mesh.material) && mesh.material.name === name)
  const upper = byMaterialName(seam.treatment.upperMaterialName)
  const lower = byMaterialName(seam.treatment.lowerMaterialName)
  if (upper.length !== 1 || lower.length !== 1 || upper[0] === lower[0]) {
    fail(`${treatmentRoot.name} must retain exact upper/lower treatment material identities`)
  }
  let upperCorrection: ReturnType<typeof bindTreatmentSurfaceCorrection> | null = null
  let lowerCorrection: ReturnType<typeof bindTreatmentSurfaceCorrection> | null = null
  for (const [role, mesh] of [
    ['upper', upper[0]],
    ['lower', lower[0]]
  ] as const) {
    validateTrianglePrimitive(mesh, `${treatmentRoot.name}/${role}`)
    const correction = bindTreatmentSurfaceCorrection(mesh, seam, `${treatmentRoot.name}/${role}`)
    if (role === 'upper') upperCorrection = correction
    else lowerCorrection = correction
    const material = mesh.material as THREE.Material
    if (!material.depthTest || material.depthWrite || material.side !== THREE.DoubleSide) {
      fail(`${treatmentRoot.name}/${role} must use double-sided ordinary depth-tested treatment`)
    }
  }
  if (!upperCorrection || !lowerCorrection || upperCorrection.kind !== lowerCorrection.kind) {
    fail(
      `${treatmentRoot.name} upper and lower treatment primitives must share raw Source or compact runtime inventory kind`
    )
  }
  return {
    treatmentRoot,
    upperTreatment: upper[0],
    lowerTreatment: lower[0],
    treatmentSurfaceCorrection: {
      kind: upperCorrection.kind,
      upper: upperCorrection.indices,
      lower: lowerCorrection.indices
    }
  }
}

function validateVisualState(
  side: SocketEyeSurfaceSideDefinitionV2,
  value: SocketEyeCompositeVisualState
) {
  const irisRadiusMeters = positive(value.irisRadiusMeters, 'state.irisRadiusMeters')
  const pupilRadiusRatio = nonNegative(value.pupilRadiusRatio, 'state.pupilRadiusRatio')
  if (pupilRadiusRatio >= 1) fail('state.pupilRadiusRatio must stay below one')
  const irisHorizontalOffsetMeters = finite(
    value.irisHorizontalOffsetMeters,
    'state.irisHorizontalOffsetMeters'
  )
  const irisVerticalOffsetMeters = finite(
    value.irisVerticalOffsetMeters,
    'state.irisVerticalOffsetMeters'
  )
  const offsetRadius = Math.hypot(irisHorizontalOffsetMeters, irisVerticalOffsetMeters)
  if (offsetRadius + irisRadiusMeters >= side.sphere.radiusMeters) {
    fail('state iris offsets and radius must stay inside the physical eye sphere')
  }
  const edgeSoftnessMeters = positive(value.edgeSoftnessMeters, 'state.edgeSoftnessMeters')
  if (pupilRadiusRatio > 0 && edgeSoftnessMeters >= irisRadiusMeters * pupilRadiusRatio) {
    fail('state.edgeSoftnessMeters must stay below the pupil radius')
  }
  return {
    scleraColor: rgba(value.scleraColor, 'state.scleraColor', true),
    irisColor: rgba(value.irisColor, 'state.irisColor', true),
    pupilColor: rgba(value.pupilColor, 'state.pupilColor', true),
    irisRadiusMeters,
    pupilRadiusRatio,
    irisHorizontalOffsetMeters,
    irisVerticalOffsetMeters,
    edgeSoftnessMeters,
    scleraArtwork: {
      texture: value.scleraArtwork.texture,
      tint: rgba(value.scleraArtwork.tint, 'state.scleraArtwork.tint', false),
      opacity: unitInterval(value.scleraArtwork.opacity, 'state.scleraArtwork.opacity')
    },
    irisArtwork: {
      texture: value.irisArtwork.texture,
      tint: rgba(value.irisArtwork.tint, 'state.irisArtwork.tint', false),
      opacity: unitInterval(value.irisArtwork.opacity, 'state.irisArtwork.opacity')
    },
    pupilArtwork: {
      texture: value.pupilArtwork.texture,
      tint: rgba(value.pupilArtwork.tint, 'state.pupilArtwork.tint', false),
      opacity: unitInterval(value.pupilArtwork.opacity, 'state.pupilArtwork.opacity')
    },
    highlight: {
      texture: value.highlight.texture,
      tint: rgba(value.highlight.tint, 'state.highlight.tint', false),
      opacity: unitInterval(value.highlight.opacity, 'state.highlight.opacity')
    },
    cornea: {
      roughness: unitInterval(value.cornea.roughness, 'state.cornea.roughness'),
      clearcoat: unitInterval(value.cornea.clearcoat, 'state.cornea.clearcoat'),
      clearcoatRoughness: unitInterval(
        value.cornea.clearcoatRoughness,
        'state.cornea.clearcoatRoughness'
      )
    }
  } satisfies SocketEyeCompositeVisualState
}

export class SocketEyeCompositeMaterialRuntime {
  readonly material: MeshPhysicalNodeMaterial
  private readonly transparentPixels: Record<keyof TextureNodes, THREE.DataTexture>
  private readonly uniforms: MaterialUniforms
  private readonly textureNodes: TextureNodes
  private state: SocketEyeCompositeVisualState
  private disposed = false

  constructor(
    private readonly side: SocketEyeSurfaceSideDefinitionV2,
    initialState: SocketEyeCompositeVisualState,
    metricFrame: SocketEyeSurfaceMetricFrame,
    private readonly artworkProjectionMode: SocketEyeArtworkProjectionMode = 'legacy'
  ) {
    this.state = validateVisualState(side, initialState)
    this.transparentPixels = {
      scleraArtwork: makeTransparentPixelTexture(),
      irisArtwork: makeTransparentPixelTexture(),
      pupilArtwork: makeTransparentPixelTexture(),
      highlight: makeTransparentPixelTexture()
    }
    const sphereRadius = uniform(side.sphere.radiusMeters)
    const pupilVisibility = uniform(this.state.pupilRadiusRatio > 0 ? 1 : 0)
    this.uniforms = {
      gaze: uniform(new THREE.Vector2()),
      sphereCenterLocal: uniform(metricFrame.sphereCenterLocal.clone()),
      horizontalAxisLocal: uniform(metricFrame.horizontalAxisLocal.clone()),
      verticalAxisLocal: uniform(metricFrame.verticalAxisLocal.clone()),
      forwardAxisLocal: uniform(metricFrame.forwardAxisLocal.clone()),
      scleraColor: uniform(colorFromSrgb(this.state.scleraColor)),
      irisColor: uniform(colorFromSrgb(this.state.irisColor)),
      pupilColor: uniform(colorFromSrgb(this.state.pupilColor)),
      irisRadius: uniform(this.state.irisRadiusMeters),
      pupilRadiusRatio: uniform(this.state.pupilRadiusRatio),
      pupilVisibility,
      irisHorizontalOffset: uniform(this.state.irisHorizontalOffsetMeters),
      irisVerticalOffset: uniform(this.state.irisVerticalOffsetMeters),
      edgeSoftness: uniform(this.state.edgeSoftnessMeters),
      scleraArtworkTint: uniform(colorFromSrgb(this.state.scleraArtwork.tint)),
      scleraArtworkOpacity: uniform(
        this.state.scleraArtwork.opacity * this.state.scleraArtwork.tint[3]
      ),
      irisArtworkTint: uniform(colorFromSrgb(this.state.irisArtwork.tint)),
      irisArtworkOpacity: uniform(this.state.irisArtwork.opacity * this.state.irisArtwork.tint[3]),
      pupilArtworkTint: uniform(colorFromSrgb(this.state.pupilArtwork.tint)),
      pupilArtworkOpacity: uniform(
        this.state.pupilArtwork.opacity * this.state.pupilArtwork.tint[3]
      ),
      highlightTint: uniform(colorFromSrgb(this.state.highlight.tint)),
      highlightOpacity: uniform(this.state.highlight.opacity * this.state.highlight.tint[3])
    }
    this.textureNodes = {
      scleraArtwork: texture(
        this.state.scleraArtwork.texture ?? this.transparentPixels.scleraArtwork
      ),
      irisArtwork: texture(this.state.irisArtwork.texture ?? this.transparentPixels.irisArtwork),
      pupilArtwork: texture(this.state.pupilArtwork.texture ?? this.transparentPixels.pupilArtwork),
      highlight: texture(this.state.highlight.texture ?? this.transparentPixels.highlight)
    }

    const sphereOffset = positionLocal.sub(this.uniforms.sphereCenterLocal)
    const surfaceMeters = vec2(
      dot(sphereOffset, this.uniforms.horizontalAxisLocal),
      dot(sphereOffset, this.uniforms.verticalAxisLocal)
    )
    const surfaceForwardMeters = dot(sphereOffset, this.uniforms.forwardAxisLocal)
    const frontHemisphereMask = step(0, surfaceForwardMeters)
    const surfaceDirection = vec3(surfaceMeters, surfaceForwardMeters).normalize()
    const gazeCenterMeters = this.uniforms.gaze.mul(sphereRadius)
    const irisCenterMeters = gazeCenterMeters.add(
      vec2(this.uniforms.irisHorizontalOffset, this.uniforms.irisVerticalOffset)
    )
    const legacyGazeDeltaMeters = surfaceMeters.sub(irisCenterMeters)
    const legacyRadialDistance = length(legacyGazeDeltaMeters)
    const legacyIrisMask = smoothstep(
      this.uniforms.irisRadius.sub(this.uniforms.edgeSoftness),
      this.uniforms.irisRadius.add(this.uniforms.edgeSoftness),
      legacyRadialDistance
    )
      .oneMinus()
      .mul(frontHemisphereMask)
    const pupilRadius = this.uniforms.irisRadius.mul(this.uniforms.pupilRadiusRatio)
    const legacyPupilMask = smoothstep(
      pupilRadius.sub(this.uniforms.edgeSoftness),
      pupilRadius.add(this.uniforms.edgeSoftness),
      legacyRadialDistance
    )
      .oneMinus()
      .mul(frontHemisphereMask)
    const legacyIrisUv = legacyGazeDeltaMeters.div(this.uniforms.irisRadius.mul(2)).add(vec2(0.5))
    const legacyPupilUv = legacyGazeDeltaMeters
      .div(max(pupilRadius, this.uniforms.edgeSoftness).mul(2))
      .add(vec2(0.5))

    let irisMask = legacyIrisMask
    let pupilMask = legacyPupilMask
    let irisUv = legacyIrisUv
    let pupilUv = legacyPupilUv
    if (artworkProjectionMode !== 'legacy') {
      // The Iris/Pupil center is a direction on the physical sphere. Their
      // accepted neutral front radii become constant spherical-cap radii, so
      // moving gaze rotates one fixed surface footprint instead of sliding a
      // flat X/Y disk that inflates near the eye corners.
      const irisCenterNormalized = irisCenterMeters.div(sphereRadius)
      const irisCenterRadialSquared = dot(irisCenterNormalized, irisCenterNormalized)
      const irisCenterForward = sqrt(max(0, irisCenterRadialSquared.oneMinus()))
      const irisCenterDirection = vec3(irisCenterNormalized, irisCenterForward).normalize()
      const irisHorizontalTangent = vec3(
        irisCenterDirection.z,
        0,
        irisCenterDirection.x.negate()
      ).normalize()
      const irisVerticalTangent = cross(irisCenterDirection, irisHorizontalTangent).normalize()
      const sphericalDelta = vec2(
        dot(surfaceDirection, irisHorizontalTangent),
        dot(surfaceDirection, irisVerticalTangent)
      )
      const sphericalRadialDistanceMeters = length(sphericalDelta).mul(sphereRadius)
      const capFrontMask = step(0, dot(surfaceDirection, irisCenterDirection))
      irisMask = smoothstep(
        this.uniforms.irisRadius.sub(this.uniforms.edgeSoftness),
        this.uniforms.irisRadius.add(this.uniforms.edgeSoftness),
        sphericalRadialDistanceMeters
      )
        .oneMinus()
        .mul(capFrontMask)
      pupilMask = smoothstep(
        pupilRadius.sub(this.uniforms.edgeSoftness),
        pupilRadius.add(this.uniforms.edgeSoftness),
        sphericalRadialDistanceMeters
      )
        .oneMinus()
        .mul(capFrontMask)
      const radialArtworkUvScale =
        artworkProjectionMode === 'corrected-inset'
          ? SOCKET_EYE_RADIAL_ARTWORK_BOUNDARY_UV_SCALE
          : 1
      irisUv = vec2(
        sphericalDelta.x
          .div(this.uniforms.irisRadius.div(sphereRadius).mul(2))
          .mul(radialArtworkUvScale)
          .add(0.5),
        sphericalDelta.y
          .div(this.uniforms.irisRadius.div(sphereRadius).mul(2))
          .negate()
          .mul(radialArtworkUvScale)
          .add(0.5)
      )
      pupilUv = vec2(
        sphericalDelta.x
          .div(max(pupilRadius, this.uniforms.edgeSoftness).div(sphereRadius).mul(2))
          .mul(radialArtworkUvScale)
          .add(0.5),
        sphericalDelta.y
          .div(max(pupilRadius, this.uniforms.edgeSoftness).div(sphereRadius).mul(2))
          .negate()
          .mul(radialArtworkUvScale)
          .add(0.5)
      )
    }

    // The physical sphere remains static. Undo the same minimal-roll rotation
    // that carries neutral forward into the current gaze direction, then map
    // that texture-space direction over the complete sphere. The texture's
    // own matrix still owns additive artwork longitude and the accepted
    // non-Highlight bilateral reflection exactly once.
    const gazeRadialSquared = dot(this.uniforms.gaze, this.uniforms.gaze)
    const gazeForward = sqrt(max(0, gazeRadialSquared.oneMinus()))
    const inverseQuaternionDenominator = sqrt(max(1e-12, gazeForward.add(1).mul(2)))
    const inverseQuaternionVector = vec3(
      this.uniforms.gaze.y,
      this.uniforms.gaze.x.negate(),
      0
    ).div(inverseQuaternionDenominator)
    const inverseQuaternionW = gazeForward.add(1).div(inverseQuaternionDenominator)
    const twiceQuaternionCross = cross(inverseQuaternionVector, surfaceDirection).mul(2)
    const scleraArtworkDirection = surfaceDirection
      .add(twiceQuaternionCross.mul(inverseQuaternionW))
      .add(cross(inverseQuaternionVector, twiceQuaternionCross))
      .normalize()
    const scleraHorizontalRadius = length(vec2(scleraArtworkDirection.x, scleraArtworkDirection.z))
    const scleraLongitude = scleraArtworkDirection.x
      .atan(scleraArtworkDirection.z)
      .mul(1 / (Math.PI * 2))
      .add(0.5)
    const scleraCanonicalLongitude = scleraHorizontalRadius
      .lessThanEqual(1e-10)
      .select(0.5, scleraLongitude)
    const scleraUv = vec2(
      fract(scleraCanonicalLongitude),
      scleraArtworkDirection.y
        .clamp(-1, 1)
        .asin()
        .mul(-1 / Math.PI)
        .add(0.5)
    )
    const legacyHighlightUv = vec2(
      surfaceMeters.x.div(sphereRadius.mul(2)).add(0.5),
      surfaceMeters.y.div(sphereRadius.mul(2)).negate().add(0.5)
    )

    let highlightUv = legacyHighlightUv
    let highlightCoverageMask = frontHemisphereMask
    if (artworkProjectionMode !== 'legacy') {
      // Use the exact radial corneal normal rather than the presentation
      // normal, then reflect the camera ray in view space. This keeps the
      // graphic independent of Iris/gaze while allowing camera/head motion to
      // slide and deform it like a reflection. One square boundary replaces
      // the retired Iris-shaped crop.
      const radialNormalView = transformNormal(sphereOffset.normalize(), modelViewMatrix)
      const reflectedViewDirection = positionViewDirection
        .negate()
        .reflect(radialNormalView)
        .normalize()
      highlightUv = vec2(
        reflectedViewDirection.x.mul(SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE).add(0.5),
        reflectedViewDirection.y.mul(-SOCKET_EYE_HIGHLIGHT_REFLECTION_UV_SCALE).add(0.5)
      )
      const viewFrontMask = step(0, dot(radialNormalView, positionViewDirection))
      const artworkBoundaryMask = step(0, highlightUv.x)
        .mul(step(highlightUv.x, 1))
        .mul(step(0, highlightUv.y))
        .mul(step(highlightUv.y, 1))
      highlightCoverageMask = viewFrontMask.mul(artworkBoundaryMask)
    }

    const scleraArtworkSample = this.textureNodes.scleraArtwork.sample(scleraUv)
    const irisArtworkSample = this.textureNodes.irisArtwork.sample(irisUv)
    const pupilArtworkSample = this.textureNodes.pupilArtwork.sample(pupilUv)
    const highlightSample = this.textureNodes.highlight.sample(highlightUv)
    const scleraArtworkAlpha = scleraArtworkSample.a.mul(this.uniforms.scleraArtworkOpacity)
    const scleraPresentationColor = mix(
      this.uniforms.scleraColor,
      scleraArtworkSample.rgb.mul(this.uniforms.scleraArtworkTint),
      scleraArtworkAlpha
    )
    const irisPresentationColor = mix(
      this.uniforms.irisColor,
      irisArtworkSample.rgb.mul(this.uniforms.irisArtworkTint),
      irisArtworkSample.a.mul(this.uniforms.irisArtworkOpacity)
    )
    const pupilPresentationColor = mix(
      this.uniforms.pupilColor,
      pupilArtworkSample.rgb.mul(this.uniforms.pupilArtworkTint),
      pupilArtworkSample.a.mul(this.uniforms.pupilArtworkOpacity)
    )
    let colorNode: any = scleraPresentationColor
    colorNode = mix(colorNode, irisPresentationColor, irisMask)
    colorNode = mix(colorNode, pupilPresentationColor, pupilMask.mul(pupilVisibility))
    colorNode = mix(
      colorNode,
      highlightSample.rgb.mul(this.uniforms.highlightTint),
      highlightSample.a.mul(this.uniforms.highlightOpacity).mul(highlightCoverageMask)
    )

    const material = new MeshPhysicalNodeMaterial()
    material.name = `${side.nodes.physicalEye}__socket_eye_sphere_runtime_v2`
    material.colorNode = colorNode
    material.emissiveNode = scleraPresentationColor
      .mul(SOCKET_EYE_SCLERA_EMISSIVE_WEIGHT)
      .mul(irisMask.oneMinus())
    material.transparent = true
    material.opacity = 1
    material.premultipliedAlpha = false
    material.blending = THREE.NormalBlending
    material.depthTest = true
    material.depthWrite = true
    material.side = THREE.FrontSide
    material.metalness = 0
    material.roughness = this.state.cornea.roughness
    material.clearcoat = this.state.cornea.clearcoat
    material.clearcoatRoughness = this.state.cornea.clearcoatRoughness
    material.userData = {
      ...material.userData,
      batshitSocketEyeLayers: [...SOCKET_EYE_COMPOSITE_LAYER_ORDER],
      batshitSocketEyeSurface: side.side,
      batshitSocketEyeArtworkProjection: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
      batshitSocketEyeDeclaredArtworkProjection: side.sphere.artworkProjection,
      batshitSocketEyeIrisPupilProjection:
        artworkProjectionMode === 'corrected-inset'
          ? SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT
          : artworkProjectionMode === 'corrected'
            ? SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT
            : LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
      batshitSocketEyeHighlightProjection:
        artworkProjectionMode !== 'legacy'
          ? SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT
          : LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
      batshitSocketEyeHighlightGazeLinked: false,
      batshitSocketEyeHighlightIrisMaskCropped: false,
      batshitSocketEyePhysicalFit: side.sphere.physicalFit.mode,
      batshitSocketEyeStableNeutralRear: true
    }
    this.material = material
  }

  getState() {
    return {
      ...this.state,
      scleraArtwork: { ...this.state.scleraArtwork },
      irisArtwork: { ...this.state.irisArtwork },
      pupilArtwork: { ...this.state.pupilArtwork },
      highlight: { ...this.state.highlight },
      cornea: { ...this.state.cornea }
    }
  }

  setMetricFrame(value: SocketEyeSurfaceMetricFrame) {
    if (this.disposed) fail('cannot update physical-eye frame after disposal')
    this.uniforms.sphereCenterLocal.value.copy(value.sphereCenterLocal)
    this.uniforms.horizontalAxisLocal.value.copy(value.horizontalAxisLocal)
    this.uniforms.verticalAxisLocal.value.copy(value.verticalAxisLocal)
    this.uniforms.forwardAxisLocal.value.copy(value.forwardAxisLocal)
  }

  getMetricFrame(): SocketEyeSurfaceMetricFrame {
    return {
      sphereCenterLocal: this.uniforms.sphereCenterLocal.value.clone(),
      horizontalAxisLocal: this.uniforms.horizontalAxisLocal.value.clone(),
      verticalAxisLocal: this.uniforms.verticalAxisLocal.value.clone(),
      forwardAxisLocal: this.uniforms.forwardAxisLocal.value.clone()
    }
  }

  setState(value: SocketEyeCompositeVisualState) {
    if (this.disposed) fail('cannot update composite state after disposal')
    this.state = validateVisualState(this.side, value)
    this.uniforms.scleraColor.value.copy(colorFromSrgb(this.state.scleraColor))
    this.uniforms.irisColor.value.copy(colorFromSrgb(this.state.irisColor))
    this.uniforms.pupilColor.value.copy(colorFromSrgb(this.state.pupilColor))
    this.uniforms.irisRadius.value = this.state.irisRadiusMeters
    this.uniforms.pupilRadiusRatio.value = this.state.pupilRadiusRatio
    this.uniforms.pupilVisibility.value = this.state.pupilRadiusRatio > 0 ? 1 : 0
    this.uniforms.irisHorizontalOffset.value = this.state.irisHorizontalOffsetMeters
    this.uniforms.irisVerticalOffset.value = this.state.irisVerticalOffsetMeters
    this.uniforms.edgeSoftness.value = this.state.edgeSoftnessMeters
    this.uniforms.scleraArtworkTint.value.copy(colorFromSrgb(this.state.scleraArtwork.tint))
    this.uniforms.scleraArtworkOpacity.value =
      this.state.scleraArtwork.opacity * this.state.scleraArtwork.tint[3]
    this.uniforms.irisArtworkTint.value.copy(colorFromSrgb(this.state.irisArtwork.tint))
    this.uniforms.irisArtworkOpacity.value =
      this.state.irisArtwork.opacity * this.state.irisArtwork.tint[3]
    this.uniforms.pupilArtworkTint.value.copy(colorFromSrgb(this.state.pupilArtwork.tint))
    this.uniforms.pupilArtworkOpacity.value =
      this.state.pupilArtwork.opacity * this.state.pupilArtwork.tint[3]
    this.uniforms.highlightTint.value.copy(colorFromSrgb(this.state.highlight.tint))
    this.uniforms.highlightOpacity.value =
      this.state.highlight.opacity * this.state.highlight.tint[3]
    this.textureNodes.scleraArtwork.value =
      this.state.scleraArtwork.texture ?? this.transparentPixels.scleraArtwork
    this.textureNodes.irisArtwork.value =
      this.state.irisArtwork.texture ?? this.transparentPixels.irisArtwork
    this.textureNodes.pupilArtwork.value =
      this.state.pupilArtwork.texture ?? this.transparentPixels.pupilArtwork
    this.textureNodes.highlight.value =
      this.state.highlight.texture ?? this.transparentPixels.highlight
    this.material.roughness = this.state.cornea.roughness
    this.material.clearcoat = this.state.cornea.clearcoat
    this.material.clearcoatRoughness = this.state.cornea.clearcoatRoughness
  }

  setGaze(horizontal: number, vertical: number) {
    if (this.disposed) fail('cannot update gaze after disposal')
    const x = finite(horizontal, 'gaze.horizontal')
    const y = finite(vertical, 'gaze.vertical')
    const radius = Math.sqrt(
      (x * x) / (this.side.gaze.maximumHorizontal * this.side.gaze.maximumHorizontal) +
        (y * y) / (this.side.gaze.maximumVertical * this.side.gaze.maximumVertical)
    )
    if (radius > 1 + 1e-9) fail('gaze coordinate exceeds the package safe domain')
    this.uniforms.gaze.value.set(x, y)
  }

  getGaze() {
    return this.uniforms.gaze.value.clone()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.material.dispose()
    for (const textureValue of Object.values(this.transparentPixels)) textureValue.dispose()
  }
}

export class SocketEyeSurfaceEngineRuntime {
  private readonly sides: Record<SocketEyeSide, BoundSide>
  private readonly bodyDepthMaterials: BodyDepthMaterialState[]
  private disposed = false

  constructor(
    private readonly root: THREE.Object3D,
    readonly definition: SocketEyeSurfaceDefinitionV2,
    readonly apertureSeam: EyeApertureSeamDefinitionV2,
    initialState: Record<SocketEyeSide, SocketEyeCompositeVisualState>,
    private readonly artworkProjectionMode: SocketEyeArtworkProjectionMode = 'legacy'
  ) {
    validateSocketEyeApertureOwnership(definition, apertureSeam)
    this.bodyDepthMaterials = this.enableBodyDepthOcclusion()
    const bound: Partial<Record<SocketEyeSide, BoundSide>> = {}
    try {
      bound.left = this.bindSide('left', initialState.left)
      bound.right = this.bindSide('right', initialState.right)
      if (
        bound.left.treatmentSurfaceCorrection.kind !== bound.right.treatmentSurfaceCorrection.kind
      ) {
        fail(
          'bilateral treatment primitives must share raw Recipe Source or compact runtime inventory kind'
        )
      }
    } catch (error) {
      if (bound.right) this.releaseSide(bound.right)
      if (bound.left) this.releaseSide(bound.left)
      this.restoreBodyDepthOcclusion()
      throw error
    }
    this.sides = { left: bound.left, right: bound.right }
  }

  private enableBodyDepthOcclusion() {
    const seen = new Set<THREE.Material>()
    const states: BodyDepthMaterialState[] = []
    for (const side of ['left', 'right'] as const) {
      const sourceBody = exactNamedMesh(
        this.root,
        this.apertureSeam.runtimeBindings[side].sourceBodyNode
      )
      for (const material of materialList(sourceBody.material)) {
        if (seen.has(material)) continue
        seen.add(material)
        states.push({ material, depthWrite: material.depthWrite })
        material.depthWrite = true
      }
    }
    return states
  }

  private restoreBodyDepthOcclusion() {
    for (const state of this.bodyDepthMaterials) state.material.depthWrite = state.depthWrite
  }

  private bindSide(sideName: SocketEyeSide, state: SocketEyeCompositeVisualState): BoundSide {
    const side = this.definition.runtimeBindings[sideName]
    const seam = this.apertureSeam.runtimeBindings[sideName]
    const physicalEye = exactNamedMesh(this.root, side.nodes.physicalEye)
    validateStaticPhysicalEye(physicalEye, `${physicalEye.name}/physical-eye`)
    const { treatmentRoot, upperTreatment, lowerTreatment, treatmentSurfaceCorrection } =
      bindTreatmentPrimitives(this.root, seam)
    const originalPhysicalMaterial = physicalEye.material as THREE.Material
    const originalPhysicalRenderOrder = physicalEye.renderOrder
    const originalUpperRenderOrder = upperTreatment.renderOrder
    const originalLowerRenderOrder = lowerTreatment.renderOrder
    const metricFrame = resolveSocketEyeSurfaceMetricFrame(physicalEye, side)
    const compositeMaterial = new SocketEyeCompositeMaterialRuntime(
      side,
      state,
      metricFrame,
      this.artworkProjectionMode
    )
    physicalEye.material = compositeMaterial.material
    physicalEye.renderOrder = SOCKET_EYE_COMPOSITE_RENDER_ORDER
    upperTreatment.renderOrder = SOCKET_EYE_TREATMENT_RENDER_ORDER
    lowerTreatment.renderOrder = SOCKET_EYE_TREATMENT_RENDER_ORDER
    return {
      physicalEye,
      treatmentRoot,
      upperTreatment,
      lowerTreatment,
      treatmentSurfaceCorrection,
      originalPhysicalMaterial,
      originalPhysicalRenderOrder,
      originalUpperRenderOrder,
      originalLowerRenderOrder,
      compositeMaterial,
      metricFrame
    }
  }

  /** Re-read the transform-only physical frame after Appearance fitting. */
  syncIdentitySurfaceFrames() {
    if (this.disposed) fail('cannot update physical-eye frames after disposal')
    for (const sideName of ['left', 'right'] as const) {
      const bound = this.sides[sideName]
      bound.metricFrame = resolveSocketEyeSurfaceMetricFrame(
        bound.physicalEye,
        this.definition.runtimeBindings[sideName]
      )
      bound.compositeMaterial.setMetricFrame(bound.metricFrame)
    }
  }

  setVisualState(side: SocketEyeSide, state: SocketEyeCompositeVisualState) {
    if (this.disposed) fail('cannot update composite state after disposal')
    this.sides[side].compositeMaterial.setState(state)
  }

  setGaze(side: SocketEyeSide, horizontal: number, vertical: number) {
    if (this.disposed) fail('cannot update gaze after disposal')
    this.sides[side].compositeMaterial.setGaze(horizontal, vertical)
  }

  /**
   * Apply the accepted nonlinear Blink correction after performance overlays.
   * Raw Recipe Source cross-checks its retained projection morph; compact
   * mounted runtime receives the factor because source-only morphs were stripped.
   */
  setTreatmentSurfaceCorrection(
    side: SocketEyeSide,
    blinkWeight: number,
    projectionWeight: number
  ) {
    if (this.disposed) fail('cannot update treatment surface correction after disposal')
    const blink = unitInterval(blinkWeight, `${side}.treatment.blinkWeight`)
    const projection = unitInterval(projectionWeight, `${side}.treatment.projectionWeight`)
    const bound = this.sides[side]
    const correction = bound.treatmentSurfaceCorrection
    const targets = [
      ['upper', bound.upperTreatment, correction.upper],
      ['lower', bound.lowerTreatment, correction.lower]
    ] as const

    for (const [role, mesh, indices] of targets) {
      const influences = mesh.morphTargetInfluences
      if (!influences) fail(`${side} ${role} treatment lost its bound morph influences`)
      if (Math.abs(influences[indices.blink] - blink) > 1e-6) {
        fail(`${side} ${role} treatment Blink influence does not match the correction update`)
      }
    }

    if (correction.kind === 'recipe-source') {
      const upperProjectionIndex = correction.upper.projection
      const lowerProjectionIndex = correction.lower.projection
      if (upperProjectionIndex === null || lowerProjectionIndex === null) {
        fail(`${side} Recipe Source treatment lost its projection correction binding`)
      }
      const upperInfluences = bound.upperTreatment.morphTargetInfluences!
      const lowerInfluences = bound.lowerTreatment.morphTargetInfluences!
      const upperProjection = unitInterval(
        upperInfluences[upperProjectionIndex],
        `${side}.upperTreatment.projectionWeight`
      )
      const lowerProjection = unitInterval(
        lowerInfluences[lowerProjectionIndex],
        `${side}.lowerTreatment.projectionWeight`
      )
      if (
        Math.abs(upperProjection - projection) > 1e-6 ||
        Math.abs(lowerProjection - projection) > 1e-6
      ) {
        fail(`${side} Recipe Source projection influences do not match the supplied factor`)
      }
    }
    const linearWeight = blink * projection
    const residualWeight = 4 * blink * (1 - blink) * projection
    for (const [, mesh, indices] of targets) {
      const influences = mesh.morphTargetInfluences!
      influences[indices.linear] = linearWeight
      influences[indices.residual] = residualWeight
    }
  }

  getMaterial(side: SocketEyeSide) {
    return this.sides[side].compositeMaterial.material
  }

  getMetricFrame(side: SocketEyeSide) {
    return this.sides[side].compositeMaterial.getMetricFrame()
  }

  getTreatmentArtworkMeshes(side: SocketEyeSide) {
    if (this.disposed) fail('cannot resolve treatment artwork after disposal')
    const bound = this.sides[side]
    return { upper: bound.upperTreatment, lower: bound.lowerTreatment }
  }

  private releaseSide(side: BoundSide) {
    side.physicalEye.material = side.originalPhysicalMaterial
    side.physicalEye.renderOrder = side.originalPhysicalRenderOrder
    side.upperTreatment.renderOrder = side.originalUpperRenderOrder
    side.lowerTreatment.renderOrder = side.originalLowerRenderOrder
    const upperInfluences = side.upperTreatment.morphTargetInfluences
    const lowerInfluences = side.lowerTreatment.morphTargetInfluences
    if (upperInfluences) {
      upperInfluences[side.treatmentSurfaceCorrection.upper.linear] = 0
      upperInfluences[side.treatmentSurfaceCorrection.upper.residual] = 0
    }
    if (lowerInfluences) {
      lowerInfluences[side.treatmentSurfaceCorrection.lower.linear] = 0
      lowerInfluences[side.treatmentSurfaceCorrection.lower.residual] = 0
    }
    side.compositeMaterial.dispose()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.releaseSide(this.sides.left)
    this.releaseSide(this.sides.right)
    this.restoreBodyDepthOcclusion()
  }
}

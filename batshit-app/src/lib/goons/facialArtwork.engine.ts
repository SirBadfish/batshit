import * as THREE from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { texture, uniform } from 'three/tsl'
import type { EyeAppearanceEngineRuntime } from './eyeAppearance.engine'
import {
  collectFacialArtworkUploadUrls,
  resolveFacialArtworkEyeState,
  resolveFacialArtworkState,
  type FacialArtworkArtworkLayer,
  type FacialArtworkDefinitionV4,
  type FacialArtworkRoleDefinition,
  type FacialArtworkSide,
  type FacialArtworkStateV4,
  type FacialArtworkTemplate
} from './facialArtwork'
import {
  type SocketEyeCompositeVisualState,
  SocketEyeSurfaceEngineRuntime
} from './socketEyeSurface.engine'

type RuntimeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>

type OriginalMeshState = {
  mesh: RuntimeMesh
  material: THREE.Material | THREE.Material[]
  visible: boolean
}

type Candidate = {
  assignments: Map<RuntimeMesh, { material: THREE.Material | THREE.Material[]; visible: boolean }>
  materials: Set<THREE.Material>
  textures: Map<string, THREE.Texture>
  socketVisualStates: Record<FacialArtworkSide, SocketEyeCompositeVisualState>
}

function fail(message: string): never {
  throw new Error(`[facial-artwork/runtime-v4] ${message}`)
}

function materialList(material: THREE.Material | THREE.Material[]) {
  return Array.isArray(material) ? material : [material]
}

function isRuntimeMesh(value: THREE.Object3D | undefined): value is RuntimeMesh {
  return Boolean(value && 'isMesh' in value && (value as THREE.Mesh).isMesh)
}

function exactNamedMesh(root: THREE.Object3D, name: string): RuntimeMesh {
  const matches: RuntimeMesh[] = []
  root.traverse((node) => {
    if (node.name === name && isRuntimeMesh(node)) matches.push(node)
  })
  if (matches.length !== 1) fail(`expected exactly one mesh named ${name}, found ${matches.length}`)
  return matches[0]
}

function applySharedMaterialProperties(target: THREE.Material, source: THREE.Material) {
  target.name = `${source.name || source.type}__facial_artwork_runtime_v4`
  target.colorWrite = source.colorWrite
  target.blending = source.blending
  target.blendSrc = source.blendSrc
  target.blendDst = source.blendDst
  target.blendEquation = source.blendEquation
  target.visible = source.visible
}

function colorFromSrgb(rgb: [number, number, number]) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
}

function buildCanvasMaterial(
  source: THREE.Material,
  layerTexture: THREE.Texture,
  layer: FacialArtworkArtworkLayer
) {
  const material = new MeshBasicNodeMaterial()
  applySharedMaterialProperties(material, source)
  const sample = texture(layerTexture)
  const tint = uniform(colorFromSrgb([layer.tint[0], layer.tint[1], layer.tint[2]]))
  material.colorNode = sample.rgb.mul(tint)
  material.opacityNode = sample.a.mul(layer.tint[3] * layer.opacity)
  material.transparent = true
  material.premultipliedAlpha = false
  material.depthTest = true
  material.depthWrite = false
  // Brows and the eye-aperture liner are animated surface artwork. Blink can
  // legitimately roll sections of the liner through their back side even
  // when the authored neutral winding and face seating are correct.
  material.side = THREE.DoubleSide
  material.alphaTest = 0
  material.alphaToCoverage = false
  material.blending = THREE.NormalBlending
  return material
}

function textureKey(roleId: string, side: FacialArtworkSide) {
  return `${roleId}:${side}`
}

export function resolveFacialArtworkHorizontalReflection(
  targetMirrorU: boolean,
  artwork: FacialArtworkArtworkLayer
) {
  return targetMirrorU !== (artwork.upload.template.orientation === 'anatomical-right')
}

export function resolveFacialArtworkEffectiveScale(
  role: FacialArtworkRoleDefinition,
  logicalScale: number
) {
  const effectiveScale = logicalScale * role.artworkScaleCalibration
  if (!Number.isFinite(effectiveScale) || effectiveScale <= 0) {
    fail(`${role.id} effective artwork scale must be a finite positive number`)
  }
  return effectiveScale
}

export function buildFacialArtworkTextureMatrix(
  template: FacialArtworkTemplate,
  role: FacialArtworkRoleDefinition,
  side: FacialArtworkSide,
  artwork: FacialArtworkArtworkLayer
) {
  const target = role.target[side]
  const mirrorU = resolveFacialArtworkHorizontalReflection(target.mirrorU, artwork)
  const mirrorV = target.mirrorV
  const authoredRight = artwork.upload.template.orientation === 'anatomical-right'
  const originU = authoredRight ? 1 - template.transformOriginUv[0] : template.transformOriginUv[0]
  const originV = template.transformOriginUv[1]
  const userMatrix = new THREE.Matrix3()

  if (artwork.mapping === 'longitude') {
    userMatrix.setUvTransform(-artwork.transform.longitudeDegrees / 360, 0, 1, 1, 0, originU, originV)
  } else {
    const repeat = 1 / resolveFacialArtworkEffectiveScale(role, artwork.transform.scale)
    userMatrix.setUvTransform(
      -artwork.transform.translateU,
      artwork.transform.translateV,
      repeat,
      repeat,
      THREE.MathUtils.degToRad(artwork.transform.rotationDegrees),
      originU,
      originV
    )
  }

  const reflection = new THREE.Matrix3().set(
    mirrorU ? -1 : 1,
    0,
    mirrorU ? 1 : 0,
    0,
    mirrorV ? -1 : 1,
    mirrorV ? 1 : 0,
    0,
    0,
    1
  )
  return userMatrix.multiply(reflection)
}

export function configureArtworkTexture(
  textureValue: THREE.Texture,
  template: FacialArtworkTemplate,
  role: FacialArtworkRoleDefinition,
  side: FacialArtworkSide,
  artwork: FacialArtworkArtworkLayer
) {
  textureValue.colorSpace = THREE.SRGBColorSpace
  textureValue.flipY = false
  textureValue.wrapS = artwork.mapping === 'longitude' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  textureValue.wrapT = THREE.ClampToEdgeWrapping
  textureValue.center.set(0, 0)
  textureValue.offset.set(0, 0)
  textureValue.repeat.set(1, 1)
  textureValue.rotation = 0
  textureValue.matrix.copy(buildFacialArtworkTextureMatrix(template, role, side, artwork))
  textureValue.matrixAutoUpdate = false
  textureValue.needsUpdate = true
}

export class FacialArtworkEngineRuntime {
  private readonly originals = new Map<RuntimeMesh, OriginalMeshState>()
  private ownedMaterials = new Set<THREE.Material>()
  private ownedTextures = new Map<string, THREE.Texture>()
  private sourceTextures = new Map<string, THREE.Texture>()
  private sourceTextureLoads = new Map<string, Promise<THREE.Texture>>()
  private appliedUploadUrls = new Set<string>()
  private appliedState: FacialArtworkStateV4 | null = null
  private generation = 0
  private disposed = false

  constructor(
    private readonly root: THREE.Object3D,
    readonly definition: FacialArtworkDefinitionV4,
    private readonly socketEyes: SocketEyeSurfaceEngineRuntime,
    private readonly eyeAppearance: EyeAppearanceEngineRuntime,
    private readonly textureLoader: Pick<THREE.TextureLoader, 'loadAsync'> = new THREE.TextureLoader()
  ) {
    for (const role of definition.roles) {
      for (const side of ['left', 'right'] as const) {
        const target = role.target[side]
        if (target.bindingKind === 'socket-eye-composite-layer') continue
        const mesh =
          target.bindingKind === 'eye-aperture-liner'
            ? socketEyes.getLinerArtworkMesh(side)
            : exactNamedMesh(root, target.runtimeNodes[0])
        if (!this.originals.has(mesh)) {
          this.originals.set(mesh, { mesh, material: mesh.material, visible: mesh.visible })
        }
      }
    }
  }

  async apply(value: FacialArtworkStateV4 | null | undefined) {
    if (this.disposed) fail('cannot apply state after disposal')
    const state = resolveFacialArtworkState(this.definition, value)
    const generation = ++this.generation
    const candidate = await this.buildCandidate(state)
    if (this.disposed || generation !== this.generation) {
      this.disposeCandidate(candidate)
      return false
    }

    const previousMaterials = this.ownedMaterials
    const previousTextures = this.ownedTextures
    for (const [mesh, assignment] of candidate.assignments) {
      mesh.material = assignment.material
      mesh.visible = assignment.visible
    }
    this.ownedMaterials = candidate.materials
    this.ownedTextures = candidate.textures
    this.appliedState = state
    this.applySocketVisualStates(candidate.socketVisualStates)

    for (const material of previousMaterials) material.dispose()
    for (const textureValue of previousTextures.values()) textureValue.dispose()
    this.appliedUploadUrls = collectFacialArtworkUploadUrls(state)
    this.pruneSourceTextures(this.appliedUploadUrls)
    return true
  }

  refreshSocketVisualState() {
    if (this.disposed || !this.appliedState) return
    this.applySocketVisualStates(this.buildSocketVisualStates(this.appliedState, this.ownedTextures))
  }

  private async buildCandidate(state: FacialArtworkStateV4): Promise<Candidate> {
    const textures = await this.loadTextures(state)
    const candidate: Candidate = {
      assignments: new Map(
        [...this.originals].map(([mesh, original]) => [
          mesh,
          { material: original.material, visible: original.visible }
        ])
      ),
      materials: new Set(),
      textures,
      socketVisualStates: this.buildSocketVisualStates(state, textures)
    }
    try {
      for (const role of this.definition.roles) {
        for (const side of ['left', 'right'] as const) {
          const target = role.target[side]
          if (target.bindingKind === 'socket-eye-composite-layer') continue
          const eyeState = resolveFacialArtworkEyeState(state, role.id, side)
          const textureValue = textures.get(textureKey(role.id, side))
          const visible = Boolean(eyeState.visible && eyeState.artwork && textureValue)
          const mesh =
            target.bindingKind === 'eye-aperture-liner'
              ? this.socketEyes.getLinerArtworkMesh(side)
              : exactNamedMesh(this.root, target.runtimeNodes[0])
          const original = this.originals.get(mesh)!
          candidate.assignments.set(mesh, {
            visible,
            material: visible
              ? this.buildMaterialSet(original.material, candidate.materials, (source) =>
                  buildCanvasMaterial(source, textureValue!, eyeState.artwork!)
                )
              : original.material
          })
        }
      }
      return candidate
    } catch (error) {
      this.disposeCandidate(candidate)
      throw error
    }
  }

  private buildSocketVisualStates(
    state: FacialArtworkStateV4,
    textures: ReadonlyMap<string, THREE.Texture>
  ): Record<FacialArtworkSide, SocketEyeCompositeVisualState> {
    const build = (side: FacialArtworkSide): SocketEyeCompositeVisualState => {
      const sclera = resolveFacialArtworkEyeState(state, 'sclera', side)
      const iris = resolveFacialArtworkEyeState(state, 'iris', side)
      const pupil = resolveFacialArtworkEyeState(state, 'pupil', side)
      const highlight = resolveFacialArtworkEyeState(state, 'eye_highlight', side)
      if (!sclera.baseColor || !iris.baseColor || !pupil.baseColor) {
        fail(`socket composite ${side} requires Sclera, Iris, and Pupil base colors`)
      }
      const physical = this.eyeAppearance.resolveSide(side)
      return {
        scleraColor: [...sclera.baseColor, 1],
        irisColor: [...iris.baseColor, 1],
        pupilColor: [...pupil.baseColor, 1],
        irisRadiusMeters: physical.irisRadiusMeters,
        pupilRadiusRatio: physical.pupilRadiusRatio,
        irisVerticalOffsetMeters: physical.irisVerticalOffsetMeters,
        edgeSoftnessMeters: physical.edgeSoftnessMeters,
        scleraArtwork: {
          texture: sclera.visible && sclera.artwork ? textures.get(textureKey('sclera', side)) ?? null : null,
          tint: sclera.artwork?.tint ?? [1, 1, 1, 0],
          opacity: sclera.artwork?.opacity ?? 0
        },
        irisArtwork: {
          texture: iris.visible && iris.artwork ? textures.get(textureKey('iris', side)) ?? null : null,
          tint: iris.artwork?.tint ?? [1, 1, 1, 0],
          opacity: iris.artwork?.opacity ?? 0
        },
        pupilArtwork: {
          texture: pupil.visible && pupil.artwork ? textures.get(textureKey('pupil', side)) ?? null : null,
          tint: pupil.artwork?.tint ?? [1, 1, 1, 0],
          opacity: pupil.artwork?.opacity ?? 0
        },
        highlight: {
          texture:
            highlight.visible && highlight.artwork
              ? textures.get(textureKey('eye_highlight', side)) ?? null
              : null,
          tint: highlight.artwork?.tint ?? [1, 1, 1, 0],
          opacity: highlight.artwork?.opacity ?? 0
        },
        cornea: physical.cornea
      }
    }
    return { left: build('left'), right: build('right') }
  }

  private applySocketVisualStates(states: Record<FacialArtworkSide, SocketEyeCompositeVisualState>) {
    this.socketEyes.setVisualState('left', states.left)
    this.socketEyes.setVisualState('right', states.right)
  }

  private buildMaterialSet(
    original: THREE.Material | THREE.Material[],
    ownership: Set<THREE.Material>,
    build: (source: THREE.Material) => THREE.Material
  ) {
    const materials = materialList(original).map((source) => {
      const material = build(source)
      ownership.add(material)
      return material
    })
    return Array.isArray(original) ? materials : materials[0]
  }

  private async loadTextures(state: FacialArtworkStateV4) {
    const requests: Array<{
      key: string
      url: string
      role: FacialArtworkRoleDefinition
      template: FacialArtworkTemplate
      side: FacialArtworkSide
      artwork: FacialArtworkArtworkLayer
    }> = []
    for (const role of this.definition.roles) {
      const template = this.definition.templates.find((candidate) => candidate.id === role.template)
      if (!template) fail(`definition has no template ${role.template}`)
      for (const side of ['left', 'right'] as const) {
        const eyeState = resolveFacialArtworkEyeState(state, role.id, side)
        if (!eyeState.visible || !eyeState.artwork) continue
        requests.push({
          key: textureKey(role.id, side),
          url: eyeState.artwork.upload.url,
          role,
          template,
          side,
          artwork: eyeState.artwork
        })
      }
    }

    const loaded = new Map<string, THREE.Texture>()
    const results = await Promise.allSettled(
      requests.map(async (request) => {
        const source = await this.loadSourceTexture(request.url)
        const textureValue = source.clone()
        configureArtworkTexture(textureValue, request.template, request.role, request.side, request.artwork)
        return { key: request.key, textureValue }
      })
    )
    for (const result of results) {
      if (result.status === 'fulfilled') loaded.set(result.value.key, result.value.textureValue)
    }
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') {
      for (const textureValue of loaded.values()) textureValue.dispose()
      throw new Error(
        `[facial-artwork/runtime-v4] Failed to load validated artwork: ${
          rejected.reason instanceof Error ? rejected.reason.message : 'Unknown texture error'
        }`
      )
    }
    return loaded
  }

  private async loadSourceTexture(url: string): Promise<THREE.Texture> {
    const cached = this.sourceTextures.get(url)
    if (cached) return cached
    const pending = this.sourceTextureLoads.get(url)
    if (pending) return pending
    const load = this.textureLoader
      .loadAsync(url)
      .then((textureValue) => {
        if (this.disposed) {
          textureValue.dispose()
          throw new Error('[facial-artwork/runtime-v4] texture finished loading after disposal')
        }
        textureValue.colorSpace = THREE.SRGBColorSpace
        textureValue.flipY = false
        this.sourceTextures.set(url, textureValue)
        return textureValue
      })
      .finally(() => this.sourceTextureLoads.delete(url))
    this.sourceTextureLoads.set(url, load)
    return load
  }

  private disposeCandidate(candidate: Candidate) {
    for (const material of candidate.materials) material.dispose()
    for (const textureValue of candidate.textures.values()) textureValue.dispose()
  }

  private pruneSourceTextures(retainedUrls: ReadonlySet<string>) {
    for (const [url, textureValue] of this.sourceTextures) {
      if (retainedUrls.has(url)) continue
      textureValue.dispose()
      this.sourceTextures.delete(url)
    }
  }

  private restoreOriginals() {
    for (const original of this.originals.values()) {
      original.mesh.material = original.material
      original.mesh.visible = original.visible
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.restoreOriginals()
    for (const material of this.ownedMaterials) material.dispose()
    for (const textureValue of this.ownedTextures.values()) textureValue.dispose()
    for (const textureValue of this.sourceTextures.values()) textureValue.dispose()
    this.ownedMaterials.clear()
    this.ownedTextures.clear()
    this.sourceTextures.clear()
    this.sourceTextureLoads.clear()
    this.appliedState = null
  }
}

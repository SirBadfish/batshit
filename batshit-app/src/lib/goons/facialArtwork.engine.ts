import * as THREE from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { mix, texture, uniform } from 'three/tsl'
import {
  collectFacialArtworkUploadUrls,
  resolveFacialArtworkEyeState,
  resolveFacialArtworkState,
  type FacialArtworkArtworkLayer,
  type FacialArtworkDefinitionV2,
  type FacialArtworkEyeState,
  type FacialArtworkRoleDefinition,
  type FacialArtworkRoleId,
  type FacialArtworkSide,
  type FacialArtworkStateV2
} from './facialArtwork'

type RuntimeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>

type OriginalMeshState = {
  mesh: RuntimeMesh
  material: THREE.Material | THREE.Material[]
  visible: boolean
}

type CandidateAssignment = {
  material: THREE.Material | THREE.Material[]
  visible: boolean
}

type Candidate = {
  assignments: Map<RuntimeMesh, CandidateAssignment>
  materials: Set<THREE.Material>
  textures: Set<THREE.Texture>
}

const SURFACE_ROLES = new Set<FacialArtworkRoleId>(['iris', 'pupil', 'sclera'])

function fail(message: string): never {
  throw new Error(`[facial-artwork/runtime] ${message}`)
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
  target.name = `${source.name || source.type}__facial_artwork_runtime`
  target.side = source.side
  target.depthTest = source.depthTest
  target.depthWrite = source.depthWrite
  target.colorWrite = source.colorWrite
  target.blending = source.blending
  target.blendSrc = source.blendSrc
  target.blendDst = source.blendDst
  target.blendEquation = source.blendEquation
  target.alphaTest = source.alphaTest
  target.polygonOffset = false
  target.visible = source.visible
}

function colorFromSrgb(rgb: [number, number, number]) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
}

function layerColorNode(layerTexture: THREE.Texture, layer: FacialArtworkArtworkLayer) {
  const sample = texture(layerTexture)
  const tint = uniform(colorFromSrgb([layer.tint[0], layer.tint[1], layer.tint[2]]))
  const alpha = sample.a.mul(layer.tint[3] * layer.opacity)
  return { color: sample.rgb.mul(tint), alpha }
}

function buildCanvasMaterial(
  source: THREE.Material,
  layerTexture: THREE.Texture,
  layer: FacialArtworkArtworkLayer
) {
  const material = new MeshBasicNodeMaterial()
  applySharedMaterialProperties(material, source)
  const artwork = layerColorNode(layerTexture, layer)
  material.colorNode = artwork.color
  material.opacityNode = artwork.alpha
  material.transparent = true
  material.premultipliedAlpha = false
  material.depthTest = true
  material.depthWrite = false
  material.side = THREE.FrontSide
  material.alphaTest = 0
  material.alphaToCoverage = false
  material.blending = THREE.NormalBlending
  return material
}

function buildLitLayeredMaterial(
  source: THREE.Material,
  baseColor: [number, number, number],
  layers: Array<{ texture: THREE.Texture; artwork: FacialArtworkArtworkLayer }>
) {
  const material = new MeshStandardNodeMaterial()
  applySharedMaterialProperties(material, source)
  // TSL's mix() widens the node expression type beyond uniform()'s narrow
  // generic even though both are valid color nodes.
  let colorNode: any = uniform(colorFromSrgb(baseColor))
  for (const layer of layers) {
    const artwork = layerColorNode(layer.texture, layer.artwork)
    colorNode = mix(colorNode, artwork.color, artwork.alpha)
  }
  material.colorNode = colorNode
  material.transparent = false
  material.opacity = 1
  material.depthTest = source.depthTest
  material.depthWrite = source.depthWrite
  material.side = source.side
  material.metalness =
    'metalness' in source && typeof (source as THREE.MeshStandardMaterial).metalness === 'number'
      ? (source as THREE.MeshStandardMaterial).metalness
      : 0
  material.roughness =
    'roughness' in source && typeof (source as THREE.MeshStandardMaterial).roughness === 'number'
      ? (source as THREE.MeshStandardMaterial).roughness
      : 1
  if ('normalMap' in source) material.normalMap = (source as THREE.MeshStandardMaterial).normalMap
  if ('roughnessMap' in source) material.roughnessMap = (source as THREE.MeshStandardMaterial).roughnessMap
  if ('metalnessMap' in source) material.metalnessMap = (source as THREE.MeshStandardMaterial).metalnessMap
  return material
}

function textureKey(roleId: FacialArtworkRoleId, side: FacialArtworkSide) {
  return `${roleId}:${side}`
}

function configureArtworkTexture(
  textureValue: THREE.Texture,
  role: FacialArtworkRoleDefinition,
  side: FacialArtworkSide,
  artwork: FacialArtworkArtworkLayer
) {
  textureValue.colorSpace = THREE.SRGBColorSpace
  textureValue.flipY = false
  textureValue.center.set(0.5, 0.5)
  const target = role.target[side]

  if (artwork.mapping === 'longitude') {
    textureValue.wrapS = THREE.RepeatWrapping
    textureValue.wrapT = THREE.ClampToEdgeWrapping
    textureValue.repeat.set(target.mirrorU ? -1 : 1, target.mirrorV ? -1 : 1)
    textureValue.offset.set(-artwork.transform.longitudeDegrees / 360, 0)
    textureValue.rotation = 0
  } else {
    textureValue.wrapS = THREE.ClampToEdgeWrapping
    textureValue.wrapT = THREE.ClampToEdgeWrapping
    const repeat = 1 / artwork.transform.scale
    textureValue.repeat.set(target.mirrorU ? -repeat : repeat, target.mirrorV ? -repeat : repeat)
    textureValue.offset.set(-artwork.transform.translateU, -artwork.transform.translateV)
    textureValue.rotation = THREE.MathUtils.degToRad(artwork.transform.rotationDegrees)
  }
  textureValue.matrixAutoUpdate = true
  textureValue.needsUpdate = true
}

export class FacialArtworkEngineRuntime {
  private readonly originals = new Map<RuntimeMesh, OriginalMeshState>()
  private ownedMaterials = new Set<THREE.Material>()
  private ownedTextures = new Set<THREE.Texture>()
  private sourceTextures = new Map<string, THREE.Texture>()
  private sourceTextureLoads = new Map<string, Promise<THREE.Texture>>()
  private appliedUploadUrls = new Set<string>()
  private generation = 0
  private disposed = false

  constructor(
    private readonly root: THREE.Object3D,
    readonly definition: FacialArtworkDefinitionV2,
    private readonly textureLoader: Pick<THREE.TextureLoader, 'loadAsync'> = new THREE.TextureLoader()
  ) {
    for (const role of definition.roles) {
      for (const side of ['left', 'right'] as const) {
        for (const name of role.target[side].runtimeNodes) {
          const mesh = exactNamedMesh(root, name)
          if (!this.originals.has(mesh)) {
            this.originals.set(mesh, { mesh, material: mesh.material, visible: mesh.visible })
          }
        }
      }
    }
  }

  async apply(value: FacialArtworkStateV2 | null | undefined) {
    if (this.disposed) fail('cannot apply state after disposal')
    const state = resolveFacialArtworkState(this.definition, value)
    const generation = ++this.generation
    let candidate: Candidate
    try {
      candidate = await this.buildCandidate(state)
    } catch (error) {
      this.pruneSourceTextures(this.appliedUploadUrls)
      throw error
    }
    if (this.disposed || generation !== this.generation) {
      this.disposeCandidate(candidate)
      this.pruneSourceTextures(this.appliedUploadUrls)
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

    for (const material of previousMaterials) material.dispose()
    for (const textureValue of previousTextures) textureValue.dispose()

    const retainedUrls = collectFacialArtworkUploadUrls(state)
    this.appliedUploadUrls = retainedUrls
    this.pruneSourceTextures(retainedUrls)
    return true
  }

  private async buildCandidate(state: FacialArtworkStateV2): Promise<Candidate> {
    const textures = await this.loadTextures(state)
    const candidate: Candidate = {
      assignments: new Map(
        [...this.originals].map(([mesh, original]) => [
          mesh,
          { material: original.material, visible: original.visible }
        ])
      ),
      materials: new Set(),
      textures: new Set(textures.values())
    }

    try {
      for (const role of this.definition.roles.filter((entry) => entry.ownership === 'canvas')) {
        for (const side of ['left', 'right'] as const) {
          const eyeState = resolveFacialArtworkEyeState(state, role.id, side)
          const textureValue = textures.get(textureKey(role.id, side))
          const visible = Boolean(eyeState.visible && eyeState.artwork && textureValue)
          for (const name of role.target[side].runtimeNodes) {
            const mesh = exactNamedMesh(this.root, name)
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
      }

      for (const role of this.definition.roles.filter((entry) => SURFACE_ROLES.has(entry.id))) {
        for (const side of ['left', 'right'] as const) {
          const eyeState = resolveFacialArtworkEyeState(state, role.id, side)
          const ownTexture = textures.get(textureKey(role.id, side))
          const highlightState = resolveFacialArtworkEyeState(state, 'eye_highlight', side)
          const highlightRole = this.definition.roles.find((entry) => entry.id === 'eye_highlight')!
          const highlightTexture = textures.get(textureKey('eye_highlight', side))
          const highlightTargets = new Set(highlightRole.target[side].runtimeNodes)

          for (const name of role.target[side].runtimeNodes) {
            const mesh = exactNamedMesh(this.root, name)
            const original = this.originals.get(mesh)!
            const layers: Array<{ texture: THREE.Texture; artwork: FacialArtworkArtworkLayer }> = []
            if (eyeState.artwork && ownTexture) layers.push({ texture: ownTexture, artwork: eyeState.artwork })
            if (
              highlightState.visible &&
              highlightState.artwork &&
              highlightTexture &&
              highlightTargets.has(name)
            ) {
              layers.push({ texture: highlightTexture, artwork: highlightState.artwork })
            }
            if (!eyeState.baseColor) fail(`${role.id} must provide an opaque base color`)
            candidate.assignments.set(mesh, {
              visible: eyeState.visible,
              material: this.buildMaterialSet(original.material, candidate.materials, (source) =>
                buildLitLayeredMaterial(source, eyeState.baseColor!, layers)
              )
            })
          }
        }
      }
      return candidate
    } catch (error) {
      this.disposeCandidate(candidate)
      throw error
    }
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

  private async loadTextures(state: FacialArtworkStateV2) {
    const requests: Array<{
      key: string
      url: string
      role: FacialArtworkRoleDefinition
      side: FacialArtworkSide
      artwork: FacialArtworkArtworkLayer
    }> = []
    for (const role of this.definition.roles) {
      for (const side of ['left', 'right'] as const) {
        const eyeState = resolveFacialArtworkEyeState(state, role.id, side)
        if (!eyeState.visible || !eyeState.artwork) continue
        requests.push({
          key: textureKey(role.id, side),
          url: eyeState.artwork.upload.url,
          role,
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
        configureArtworkTexture(textureValue, request.role, request.side, request.artwork)
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
        `[facial-artwork/runtime] Failed to load validated artwork: ${rejected.reason instanceof Error ? rejected.reason.message : 'Unknown texture error'}`
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
          throw new Error('[facial-artwork/runtime] texture finished loading after disposal')
        }
        textureValue.colorSpace = THREE.SRGBColorSpace
        textureValue.flipY = false
        this.sourceTextures.set(url, textureValue)
        return textureValue
      })
      .finally(() => {
        this.sourceTextureLoads.delete(url)
      })
    this.sourceTextureLoads.set(url, load)
    return load
  }

  private disposeCandidate(candidate: Candidate) {
    for (const material of candidate.materials) material.dispose()
    for (const textureValue of candidate.textures) textureValue.dispose()
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
    for (const textureValue of this.ownedTextures) textureValue.dispose()
    for (const textureValue of this.sourceTextures.values()) textureValue.dispose()
    this.ownedMaterials.clear()
    this.ownedTextures.clear()
    this.sourceTextures.clear()
    this.sourceTextureLoads.clear()
  }
}

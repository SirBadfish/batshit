import * as THREE from 'three'
import {
  parseLipArtworkState,
  type LipArtworkDefinitionV2,
  type LipArtworkStateV2
} from './lipArtwork'

type RuntimeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material>
type RuntimePbrMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial

function fail(message: string): never {
  throw new Error(`[lip-artwork/runtime-v2] ${message}`)
}

function exactMesh(root: THREE.Object3D, name: string): RuntimeMesh {
  const matches: RuntimeMesh[] = []
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (node.name === name && mesh.isMesh && !Array.isArray(mesh.material)) {
      matches.push(mesh as RuntimeMesh)
    }
  })
  if (matches.length !== 1) fail(`expected exactly one mesh named ${name}, found ${matches.length}`)
  return matches[0]
}

function srgbColor(rgb: [number, number, number]) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
}

export class LipArtworkEngineRuntime {
  private readonly mesh: RuntimeMesh
  private readonly originalMaterial: RuntimePbrMaterial
  private readonly originalVisible: boolean
  private ownedMaterial: THREE.Material | null = null
  private ownedTexture: THREE.Texture | null = null
  private enabled = true
  private contentVisible: boolean
  private generation = 0
  private disposed = false

  constructor(
    root: THREE.Object3D,
    readonly definition: LipArtworkDefinitionV2,
    private readonly textureLoader: Pick<
      THREE.TextureLoader,
      'loadAsync'
    > = new THREE.TextureLoader()
  ) {
    this.mesh = exactMesh(root, definition.runtimeBinding.node)
    if (this.mesh.material.name !== definition.runtimeBinding.material) {
      fail(
        `${definition.runtimeBinding.node} must use ${definition.runtimeBinding.material}, found ${this.mesh.material.name || 'an unnamed material'}`
      )
    }
    const originalMaterial = this.mesh.material as RuntimePbrMaterial
    if (originalMaterial.isMeshStandardMaterial !== true) {
      fail(
        `${definition.runtimeBinding.material} must be a light-reactive PBR material, found ${originalMaterial.type}`
      )
    }
    this.originalMaterial = originalMaterial
    this.originalVisible = this.mesh.visible
    this.contentVisible = this.originalVisible
  }

  private syncVisibility() {
    this.mesh.visible = this.enabled && this.contentVisible
  }

  setEnabled(enabled: boolean) {
    if (this.disposed) fail('cannot change presence after disposal')
    this.enabled = enabled
    this.syncVisibility()
  }

  async apply(value: LipArtworkStateV2 | null | undefined) {
    if (this.disposed) fail('cannot apply state after disposal')
    const generation = ++this.generation
    if (!value) {
      this.restoreOriginal()
      return true
    }

    const state = parseLipArtworkState(this.definition, value)
    const loaded = await this.textureLoader.loadAsync(state.artwork.url)
    if (this.disposed || generation !== this.generation) {
      loaded.dispose()
      return false
    }
    loaded.colorSpace = THREE.SRGBColorSpace
    loaded.flipY = false
    loaded.wrapS = THREE.ClampToEdgeWrapping
    loaded.wrapT = THREE.ClampToEdgeWrapping
    loaded.needsUpdate = true

    // The package-authored overlay already carries the intended lip finish.
    // Clone that exact PBR material so custom flat-color artwork responds to
    // the same geometry normals, room lights, and roughness as the default.
    // Only RGB/alpha, tint, and opacity belong to mutable artwork state.
    const material = this.originalMaterial.clone() as RuntimePbrMaterial
    material.name = `${this.definition.runtimeBinding.material}__lip_artwork_runtime_v2`
    material.map = loaded
    material.alphaMap = null
    material.color.copy(srgbColor(state.tint))
    material.opacity = state.opacity
    material.transparent = true
    material.premultipliedAlpha = false
    material.depthTest = true
    material.depthWrite = false
    material.side = THREE.FrontSide
    material.blending = THREE.NormalBlending
    material.needsUpdate = true

    const previousMaterial = this.ownedMaterial
    const previousTexture = this.ownedTexture
    this.mesh.material = material
    this.contentVisible = true
    this.syncVisibility()
    this.ownedMaterial = material
    this.ownedTexture = loaded
    previousMaterial?.dispose()
    previousTexture?.dispose()
    return true
  }

  private restoreOriginal() {
    this.mesh.material = this.originalMaterial
    this.contentVisible = this.originalVisible
    this.syncVisibility()
    this.ownedMaterial?.dispose()
    this.ownedTexture?.dispose()
    this.ownedMaterial = null
    this.ownedTexture = null
  }

  dispose() {
    if (this.disposed) return
    this.generation += 1
    this.enabled = true
    this.restoreOriginal()
    this.disposed = true
  }
}

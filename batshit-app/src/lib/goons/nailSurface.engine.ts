import * as THREE from 'three'
import {
  createDefaultNailSurfaceState,
  parseNailSurfaceState,
  type NailAppearanceFamilyState,
  type NailFamily,
  type NailRuntimeBinding,
  type NailSurfaceDefinitionV1,
  type NailSurfaceStateV1
} from './nailSurface'

type RuntimeMesh = THREE.SkinnedMesh<
  THREE.BufferGeometry,
  THREE.MeshPhysicalMaterial
>

type PreparedMaterial = {
  material: THREE.MeshPhysicalMaterial
  texture: THREE.Texture | null
}

type FamilyRuntime = {
  mesh: RuntimeMesh
  binding: NailRuntimeBinding
  originalMaterial: THREE.MeshPhysicalMaterial
  originalVisible: boolean
  ownedMaterial: THREE.MeshPhysicalMaterial | null
  ownedTexture: THREE.Texture | null
}

function fail(message: string): never {
  throw new Error(`[nail-surface/runtime-v1] ${message}`)
}

function exactMesh(root: THREE.Object3D, name: string): RuntimeMesh {
  const matches: RuntimeMesh[] = []
  root.traverse((node) => {
    const mesh = node as RuntimeMesh
    if (node.name === name && mesh.isSkinnedMesh && !Array.isArray(mesh.material)) {
      matches.push(mesh)
    }
  })
  if (matches.length !== 1) {
    fail(`expected exactly one skinned mesh named ${name}, found ${matches.length}`)
  }
  return matches[0]
}

function bindFamily(
  root: THREE.Object3D,
  definition: NailSurfaceDefinitionV1,
  family: NailFamily
): FamilyRuntime {
  const binding = definition.runtimeBindings[family]
  const mesh = exactMesh(root, binding.node)
  if (mesh.material.name !== binding.material) {
    fail(
      `${binding.node} must use ${binding.material}, found ${mesh.material.name || 'an unnamed material'}`
    )
  }
  if (mesh.material.isMeshPhysicalMaterial !== true) {
    fail(`${binding.material} must be a light-reactive MeshPhysicalMaterial`)
  }
  if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) {
    fail(`${binding.node} must expose morph target names and influences`)
  }
  const targetNames = Object.values(binding.targets)
  const missing = targetNames.filter(
    (targetName) => mesh.morphTargetDictionary?.[targetName] === undefined
  )
  if (missing.length > 0) {
    fail(`${binding.node} is missing Nail Surface morphs: ${missing.join(', ')}`)
  }
  return {
    mesh,
    binding,
    originalMaterial: mesh.material,
    originalVisible: mesh.visible,
    ownedMaterial: null,
    ownedTexture: null
  }
}

function srgbColor(value: [number, number, number]) {
  return new THREE.Color().setRGB(value[0], value[1], value[2], THREE.SRGBColorSpace)
}

function rgbCss(value: [number, number, number]) {
  return `rgb(${value
    .map((channel) => Math.round(channel * 255))
    .join(' ')})`
}

function setMorph(runtime: FamilyRuntime, targetName: string, value: number) {
  const index = runtime.mesh.morphTargetDictionary?.[targetName]
  if (index === undefined) fail(`${runtime.mesh.name} lost morph ${targetName}`)
  const influences = runtime.mesh.morphTargetInfluences
  if (!influences) fail(`${runtime.mesh.name} lost morph influences`)
  influences[index] = value
}

function signedTargets(
  runtime: FamilyRuntime,
  value: number,
  negativeKey: 'lengthDecrease' | 'widthNarrow',
  positiveKey: 'lengthIncrease' | 'widthWide'
) {
  setMorph(runtime, runtime.binding.targets[negativeKey], value < 0 ? -value : 0)
  setMorph(runtime, runtime.binding.targets[positiveKey], value > 0 ? value : 0)
}

function applyGeometry(
  runtime: FamilyRuntime,
  family: NailFamily,
  state: NailSurfaceStateV1
) {
  const geometry = state.geometry[family]
  signedTargets(runtime, geometry.length, 'lengthDecrease', 'lengthIncrease')
  signedTargets(runtime, geometry.width, 'widthNarrow', 'widthWide')
  setMorph(
    runtime,
    runtime.binding.targets.shapeSoftSquare,
    geometry.shape === 'soft-square' ? 1 : 0
  )
  if (family === 'fingers') {
    setMorph(
      runtime,
      runtime.binding.targets.shapeAlmond,
      geometry.shape === 'almond' ? 1 : 0
    )
    setMorph(
      runtime,
      runtime.binding.targets.shapePointed,
      geometry.shape === 'pointed' ? 1 : 0
    )
  }
  setMorph(runtime, runtime.binding.targets.arch, geometry.arch)
}

function restoreFamily(runtime: FamilyRuntime) {
  runtime.mesh.material = runtime.originalMaterial
  runtime.ownedMaterial?.dispose()
  runtime.ownedTexture?.dispose()
  runtime.ownedMaterial = null
  runtime.ownedTexture = null
}

function imageSource(value: THREE.Texture, family: NailFamily): CanvasImageSource {
  const image = value.image as CanvasImageSource | undefined
  if (!image) fail(`${family} artwork texture has no drawable image`)
  return image
}

function compositeArtwork(
  definition: NailSurfaceDefinitionV1,
  family: NailFamily,
  appearance: NailAppearanceFamilyState,
  source: CanvasImageSource
) {
  if (typeof document === 'undefined') {
    fail(`${family} Nail Artwork compositing requires the browser runtime`)
  }
  const [width, height] = definition.templates[family].dimensions
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', {
    alpha: false,
    colorSpace: 'srgb'
  })
  if (!context) fail(`${family} Nail Artwork could not create a 2D canvas`)
  context.fillStyle = rgbCss(appearance.color)
  context.fillRect(0, 0, width, height)
  // Source-over is the product law: opaque artwork remains literal while
  // transparent pixels expose Nail Color. Texture alpha never hides geometry.
  context.globalCompositeOperation = 'source-over'
  context.drawImage(source, 0, 0, width, height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.name = `${family}-nail-artwork-runtime-v1`
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  return texture
}

export class NailSurfaceEngineRuntime {
  private readonly families: Record<NailFamily, FamilyRuntime>
  private state: NailSurfaceStateV1
  private generation = 0
  private disposed = false
  private enabled = true

  constructor(
    root: THREE.Object3D,
    readonly definition: NailSurfaceDefinitionV1,
    initialState: NailSurfaceStateV1 | null | undefined,
    private readonly textureLoader: Pick<
      THREE.TextureLoader,
      'loadAsync'
    > = new THREE.TextureLoader()
  ) {
    this.families = {
      fingers: bindFamily(root, definition, 'fingers'),
      toes: bindFamily(root, definition, 'toes')
    }
    this.state = createDefaultNailSurfaceState(definition)
    this.verifyPackageDefaults()
    if (initialState) {
      this.state = parseNailSurfaceState(definition, initialState)
    }
  }

  private verifyPackageDefaults() {
    for (const family of NAIL_FAMILY_ORDER) {
      const runtime = this.families[family]
      const expected = this.definition.materialDefaults[family]
      const expectedColor = srgbColor(expected.color)
      const finish = this.definition.finishes[expected.finish]
      const material = runtime.originalMaterial
      const close = (left: number, right: number) => Math.abs(left - right) <= 1e-5
      if (
        !close(material.color.r, expectedColor.r) ||
        !close(material.color.g, expectedColor.g) ||
        !close(material.color.b, expectedColor.b) ||
        !close(material.roughness, finish.roughness) ||
        !close(material.clearcoat, finish.clearcoat) ||
        !close(material.clearcoatRoughness, finish.clearcoatRoughness)
      ) {
        fail(`${family} package material defaults do not match avatar.json#nailSurface`)
      }
    }
  }

  getState() {
    return structuredClone(this.state)
  }

  private syncVisibility() {
    for (const family of NAIL_FAMILY_ORDER) {
      const runtime = this.families[family]
      runtime.mesh.visible = this.enabled && runtime.originalVisible
    }
  }

  setEnabled(enabled: boolean) {
    if (this.disposed) fail('cannot change presence after disposal')
    this.enabled = enabled
    this.syncVisibility()
  }

  async apply(value: NailSurfaceStateV1 | null | undefined) {
    if (this.disposed) fail('cannot apply state after disposal')
    const generation = ++this.generation
    const state = value
      ? parseNailSurfaceState(this.definition, value)
      : createDefaultNailSurfaceState(this.definition)

    if (!value) {
      for (const family of NAIL_FAMILY_ORDER) {
        restoreFamily(this.families[family])
        applyGeometry(this.families[family], family, state)
      }
      this.syncVisibility()
      this.state = state
      return true
    }

    const prepared = await Promise.all(
      NAIL_FAMILY_ORDER.map((family) =>
        this.prepareMaterial(family, state.appearance[family])
      )
    )
    if (this.disposed || generation !== this.generation) {
      for (const result of prepared) {
        result.material.dispose()
        result.texture?.dispose()
      }
      return false
    }
    for (const [index, family] of NAIL_FAMILY_ORDER.entries()) {
      const runtime = this.families[family]
      const result = prepared[index]
      const previousMaterial = runtime.ownedMaterial
      const previousTexture = runtime.ownedTexture
      runtime.mesh.material = result.material
      runtime.ownedMaterial = result.material
      runtime.ownedTexture = result.texture
      applyGeometry(runtime, family, state)
      previousMaterial?.dispose()
      previousTexture?.dispose()
    }
    this.syncVisibility()
    this.state = state
    return true
  }

  private async prepareMaterial(
    family: NailFamily,
    appearance: NailAppearanceFamilyState
  ): Promise<PreparedMaterial> {
    const runtime = this.families[family]
    const material = runtime.originalMaterial.clone()
    material.name = `${runtime.binding.material}__runtime_v1`
    const finish = this.definition.finishes[appearance.finish]
    material.roughness = finish.roughness
    material.clearcoat = finish.clearcoat
    material.clearcoatRoughness = finish.clearcoatRoughness
    material.transparent = false
    material.opacity = 1
    material.alphaMap = null
    material.depthTest = true
    material.depthWrite = true
    material.side = THREE.FrontSide
    material.premultipliedAlpha = false

    if (!appearance.artwork) {
      material.color.copy(srgbColor(appearance.color))
      material.needsUpdate = true
      return { material, texture: null }
    }

    let loaded: THREE.Texture | null = null
    try {
      loaded = await this.textureLoader.loadAsync(appearance.artwork.url)
      const composite = compositeArtwork(
        this.definition,
        family,
        appearance,
        imageSource(loaded, family)
      )
      loaded.dispose()
      loaded = null
      material.map = composite
      material.color.setRGB(1, 1, 1)
      material.needsUpdate = true
      return { material, texture: composite }
    } catch (error) {
      loaded?.dispose()
      material.dispose()
      throw error
    }
  }

  dispose() {
    if (this.disposed) return
    this.generation += 1
    for (const family of NAIL_FAMILY_ORDER) {
      restoreFamily(this.families[family])
    }
    this.enabled = true
    this.syncVisibility()
    this.disposed = true
  }
}

const NAIL_FAMILY_ORDER = ['fingers', 'toes'] as const satisfies readonly NailFamily[]

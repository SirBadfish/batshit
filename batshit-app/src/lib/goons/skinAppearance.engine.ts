import * as THREE from 'three'
import {
  createDefaultSkinAppearanceState,
  migrateSkinAppearanceState,
  parseSkinAppearanceState,
  resolveSkinAppearanceAssetUrl,
  type SkinAppearanceDefinitionV1,
  type SkinAppearanceRgb,
  type SkinAppearanceStateV2
} from './skinAppearance'
import type { SkinSurfaceUploadV1 } from './skinSurface'
import {
  SkinArtworkProjectionRuntime,
  type SkinArtworkPreparedProjection,
  type SkinArtworkProjectionDefinitionV8
} from './skinArtworkProjection'

type RuntimeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
type DrawableTexture = THREE.Texture & { image: CanvasImageSource }

type PreparedRuntime = {
  material: THREE.MeshStandardMaterial
  ownedTextures: THREE.Texture[]
  projection: SkinArtworkPreparedProjection | null
}

function fail(message: string): never {
  throw new Error(`[skin-appearance/runtime-v2] ${message}`)
}

function exactMesh(root: THREE.Object3D, name: string): RuntimeMesh {
  const matches: RuntimeMesh[] = []
  root.traverse((node) => {
    const mesh = node as RuntimeMesh
    if (node.name === name && mesh.isMesh && !Array.isArray(mesh.material)) {
      matches.push(mesh)
    }
  })
  if (matches.length !== 1) {
    fail(`expected exactly one mesh named ${name}, found ${matches.length}`)
  }
  return matches[0]
}

function close(left: number, right: number) {
  return Math.abs(left - right) <= 1e-5
}

function imageDimension(image: CanvasImageSource, axis: 'width' | 'height') {
  const dimensions = image as {
    naturalWidth?: number
    naturalHeight?: number
    videoWidth?: number
    videoHeight?: number
    displayWidth?: number
    displayHeight?: number
    width?: number
    height?: number
  }
  const value =
    axis === 'width'
      ? (dimensions.naturalWidth ??
        dimensions.videoWidth ??
        dimensions.displayWidth ??
        dimensions.width)
      : (dimensions.naturalHeight ??
        dimensions.videoHeight ??
        dimensions.displayHeight ??
        dimensions.height)
  return typeof value === 'number' ? value : 0
}

function drawableTexture(
  value: THREE.Texture | null,
  context: string
): DrawableTexture {
  const image = value?.image as CanvasImageSource | undefined
  if (!value || !image) fail(`${context} has no drawable image`)
  return value as DrawableTexture
}

function rgbCss(value: SkinAppearanceRgb) {
  return `rgb(${value.map((channel) => Math.round(channel * 255)).join(' ')})`
}

function multiplyRgb(
  left: SkinAppearanceRgb,
  right: SkinAppearanceRgb
): SkinAppearanceRgb {
  return left.map((channel, index) => channel * right[index]) as SkinAppearanceRgb
}

function canvas2d(width: number, height: number) {
  if (typeof document === 'undefined') {
    fail('Skin Appearance compositing requires the browser runtime')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' })
  if (!context) fail('Skin Appearance could not create a 2D canvas')
  return { canvas, context }
}

function drawMaskedLayer(
  width: number,
  height: number,
  destination: CanvasRenderingContext2D,
  scratch: CanvasRenderingContext2D,
  mask: CanvasImageSource,
  source: SkinAppearanceRgb
) {
  scratch.clearRect(0, 0, width, height)
  scratch.globalCompositeOperation = 'source-over'
  scratch.fillStyle = rgbCss(source)
  scratch.fillRect(0, 0, width, height)
  scratch.globalCompositeOperation = 'destination-in'
  scratch.drawImage(mask, 0, 0, width, height)
  scratch.globalCompositeOperation = 'source-over'
  destination.drawImage(scratch.canvas, 0, 0)
}

function drawTintedArtwork(
  width: number,
  height: number,
  destination: CanvasRenderingContext2D,
  source: CanvasImageSource,
  tint: SkinAppearanceRgb
) {
  destination.globalCompositeOperation = 'source-over'
  destination.drawImage(source, 0, 0, width, height)
  if (tint.every((channel) => channel === 1)) return

  // Artwork Tint is an sRGB multiply. White authored artwork resolves to the
  // selected color exactly, while authored variation and source alpha survive.
  destination.globalCompositeOperation = 'multiply'
  destination.fillStyle = rgbCss(tint)
  destination.fillRect(0, 0, width, height)
  destination.globalCompositeOperation = 'destination-in'
  destination.drawImage(source, 0, 0, width, height)
  destination.globalCompositeOperation = 'source-over'
}

function copyTextureSampling(
  source: THREE.Texture,
  target: THREE.Texture,
  colorSpace: THREE.ColorSpace
) {
  target.colorSpace = colorSpace
  target.flipY = false
  target.wrapS = source.wrapS
  target.wrapT = source.wrapT
  target.magFilter = source.magFilter
  target.minFilter = source.minFilter
  target.anisotropy = source.anisotropy
  target.offset.copy(source.offset)
  target.repeat.copy(source.repeat)
  target.center.copy(source.center)
  target.rotation = source.rotation
  target.matrixAutoUpdate = source.matrixAutoUpdate
  target.matrix.copy(source.matrix)
  target.generateMipmaps = source.generateMipmaps
  target.needsUpdate = true
}

function needsBaseComposition(state: SkinAppearanceStateV2) {
  return (
    state.surface.baseColor.mode === 'custom' ||
    state.surface.baseColor.tint.some((channel) => channel !== 1) ||
    Object.values(state.regions).some((region) => region.mode !== 'inherit')
  )
}

export class SkinAppearanceEngineRuntime {
  private readonly mesh: RuntimeMesh
  private readonly originalMaterial: THREE.MeshStandardMaterial
  private readonly originalTexture: DrawableTexture
  private ownedMaterial: THREE.MeshStandardMaterial | null = null
  private ownedTextures: THREE.Texture[] = []
  private masksPromise: Promise<DrawableTexture[]> | null = null
  private generation = 0
  private disposed = false
  private readonly artworkProjection: SkinArtworkProjectionRuntime | null
  private projectionNippleSizeValue: number | null

  constructor(
    root: THREE.Object3D,
    readonly definition: SkinAppearanceDefinitionV1,
    private readonly textureLoader: Pick<THREE.TextureLoader, 'loadAsync'> =
      new THREE.TextureLoader(),
    artworkProjectionDefinition: SkinArtworkProjectionDefinitionV8 | null = null,
    projectionNippleSizeValue: number | null = null
  ) {
    this.projectionNippleSizeValue = projectionNippleSizeValue
    this.mesh = exactMesh(root, definition.runtimeBinding.node)
    if (this.mesh.material.name !== definition.runtimeBinding.material) {
      fail(
        `${definition.runtimeBinding.node} must use ${definition.runtimeBinding.material}, found ${this.mesh.material.name || 'an unnamed material'}`
      )
    }
    if (this.mesh.material.isMeshStandardMaterial !== true) {
      fail(`${definition.runtimeBinding.material} must be a light-reactive PBR material`)
    }
    this.originalMaterial = this.mesh.material
    this.originalTexture = drawableTexture(
      this.originalMaterial.map,
      'package base-color texture'
    )
    if (
      artworkProjectionDefinition &&
      (artworkProjectionDefinition.runtimeBinding.node !==
        definition.runtimeBinding.node ||
        artworkProjectionDefinition.runtimeBinding.material !==
          definition.runtimeBinding.material)
    ) {
      fail('Skin Artwork Projection must bind the same body node and material')
    }
    this.artworkProjection = artworkProjectionDefinition
      ? new SkinArtworkProjectionRuntime(
          root,
          artworkProjectionDefinition,
          projectionNippleSizeValue
        )
      : null
    const { width, height } = definition.canvas
    if (
      imageDimension(this.originalTexture.image, 'width') !== width ||
      imageDimension(this.originalTexture.image, 'height') !== height
    ) {
      fail('package base-color texture dimensions do not match avatar.json#skinAppearance')
    }
    const defaults = definition.materialDefaults
    if (
      !close(this.originalMaterial.color.r, 1) ||
      !close(this.originalMaterial.color.g, 1) ||
      !close(this.originalMaterial.color.b, 1) ||
      !close(this.originalMaterial.roughness, defaults.roughness) ||
      !close(this.originalMaterial.metalness, defaults.metalness)
    ) {
      fail('package material defaults do not match avatar.json#skinAppearance')
    }
  }

  async apply(
    value: SkinAppearanceStateV2 | unknown | null | undefined,
    legacyMaterialArtwork: unknown = null
  ) {
    if (this.disposed) fail('cannot apply state after disposal')
    const generation = ++this.generation
    await this.artworkProjection?.initialize()
    if (!value && !legacyMaterialArtwork && !this.artworkProjection) {
      this.restoreOriginal()
      return true
    }
    const state =
      !value && !legacyMaterialArtwork
        ? createDefaultSkinAppearanceState(this.definition)
        : migrateSkinAppearanceState(
            this.definition,
            value,
            legacyMaterialArtwork
          )
    const prepared = await this.prepare(state)
    if (this.disposed || generation !== this.generation) {
      prepared.material.dispose()
      for (const texture of prepared.ownedTextures) texture.dispose()
      this.artworkProjection?.disposePrepared(prepared.projection)
      return false
    }
    const previousMaterial = this.ownedMaterial
    const previousTextures = this.ownedTextures
    this.mesh.material = prepared.material
    if (prepared.projection) {
      this.artworkProjection?.commitPrepared(prepared.projection)
    }
    this.ownedMaterial = prepared.material
    this.ownedTextures = prepared.ownedTextures
    previousMaterial?.dispose()
    for (const texture of previousTextures) texture.dispose()
    return true
  }

  private async loadCustomMap(
    upload: SkinSurfaceUploadV1,
    context: string
  ): Promise<DrawableTexture> {
    const texture = drawableTexture(
      await this.textureLoader.loadAsync(upload.url),
      context
    )
    if (
      imageDimension(texture.image, 'width') !== upload.canvas.width ||
      imageDimension(texture.image, 'height') !== upload.canvas.height
    ) {
      texture.dispose()
      fail(`${context} dimensions do not match its validated ownership record`)
    }
    return texture
  }

  private async loadMasks() {
    const assets = this.definition.masks
    return (
      this.masksPromise ??
      (this.masksPromise = Promise.all([
        this.textureLoader.loadAsync(
          resolveSkinAppearanceAssetUrl(assets.nipplesAreolae.path)
        ),
        this.textureLoader.loadAsync(
          resolveSkinAppearanceAssetUrl(assets.palmsSoles.path)
        ),
        this.textureLoader.loadAsync(
          resolveSkinAppearanceAssetUrl(assets.cheekBlush.path)
        )
      ]).then((textures) =>
        textures.map((texture, index) =>
          drawableTexture(texture, `Skin Appearance mask ${index + 1}`)
        )
      ))
    )
  }

  private async prepare(stateValue: SkinAppearanceStateV2): Promise<PreparedRuntime> {
    const state = parseSkinAppearanceState(this.definition, stateValue)
    const ownedTextures: THREE.Texture[] = []
    let uploadedBaseColor: DrawableTexture | null = null
    let baseColorCanvas: HTMLCanvasElement | null = null
    let nipplePigmentCanvas: HTMLCanvasElement | null = null
    let nippleMaskCanvas: HTMLCanvasElement | null = null
    let preparedProjection: SkinArtworkPreparedProjection | null = null
    try {
      if (state.surface.baseColor.mode === 'custom') {
        uploadedBaseColor = await this.loadCustomMap(
          state.surface.baseColor.custom!,
          'uploaded Base Color Artwork'
        )
      }
      const customNormal =
        state.surface.normal.mode === 'custom'
          ? await this.loadCustomMap(
            state.surface.normal.custom!,
            'uploaded Normal Map'
          )
          : null
      if (customNormal) ownedTextures.push(customNormal)
      const customRoughness =
        state.surface.roughness.mode === 'custom'
          ? await this.loadCustomMap(
            state.surface.roughness.custom!,
            'uploaded Roughness Map'
          )
          : null
      if (customRoughness) ownedTextures.push(customRoughness)
      const customMetallic =
        state.surface.metallic.mode === 'custom'
          ? await this.loadCustomMap(
            state.surface.metallic.custom!,
            'uploaded Metallic Map'
          )
          : null
      if (customMetallic) ownedTextures.push(customMetallic)

      const material = this.originalMaterial.clone()
      material.name = `${this.definition.runtimeBinding.material}__skin_appearance_runtime_v2`
      material.color.setRGB(1, 1, 1)

      if (needsBaseComposition(state) || this.artworkProjection) {
        const { width, height } = this.definition.canvas
        const [nipplesAreolae, palmsSoles, cheekBlush] = await this.loadMasks()
        const maskDefinitions = [
          this.definition.masks.nipplesAreolae,
          this.definition.masks.palmsSoles,
          this.definition.masks.cheekBlush
        ]
        for (const [index, texture] of [
          nipplesAreolae,
          palmsSoles,
          cheekBlush
        ].entries()) {
          if (
            imageDimension(texture.image, 'width') !==
              maskDefinitions[index].width ||
            imageDimension(texture.image, 'height') !==
              maskDefinitions[index].height
          ) {
            fail('a Skin Appearance mask has the wrong dimensions')
          }
        }

        const { canvas, context } = canvas2d(width, height)
        baseColorCanvas = canvas
        const { context: scratch } = canvas2d(width, height)
        const inheritedBase =
          uploadedBaseColor?.image ?? this.originalTexture.image
        drawTintedArtwork(
          width,
          height,
          context,
          inheritedBase,
          state.surface.baseColor.tint
        )

        const customBase = state.surface.baseColor.mode === 'custom'
        const resolveRegionColor = (
          region: SkinAppearanceStateV2['regions']['nipplesAreolae'],
          defaultColor: SkinAppearanceRgb
        ): SkinAppearanceRgb | null => {
          if (region.mode === 'custom') return region.color
          return customBase ? defaultColor : null
        }
        const nippleColor = resolveRegionColor(
          state.regions.nipplesAreolae,
          this.definition.controls.find(
            (control) => control.id === 'nipplesAreolae'
          )!.defaultColor
        )
        if (this.artworkProjection) {
          const pigment = canvas2d(width, height)
          nipplePigmentCanvas = pigment.canvas
          if (nippleColor) {
            drawMaskedLayer(
              width,
              height,
              pigment.context,
              scratch,
              nipplesAreolae.image,
              nippleColor
            )
          }
        } else if (nippleColor) {
          drawMaskedLayer(
            width,
            height,
            context,
            scratch,
            nipplesAreolae.image,
            nippleColor
          )
        }
        const palmsSolesColor = resolveRegionColor(
          state.regions.palmsSoles,
          this.definition.controls.find((control) => control.id === 'palmsSoles')!
            .defaultColor
        )
        if (palmsSolesColor) {
          drawMaskedLayer(
            width,
            height,
            context,
            scratch,
            palmsSoles.image,
            palmsSolesColor
          )
        }

        const cheek = state.regions.cheekBlush
        if (cheek.mode === 'custom') {
          drawMaskedLayer(
            width,
            height,
            context,
            scratch,
            cheekBlush.image,
            cheek.color
          )
        } else if (cheek.mode === 'inherit' && customBase) {
          drawMaskedLayer(
            width,
            height,
            context,
            scratch,
            cheekBlush.image,
            this.definition.controls.find(
              (control) => control.id === 'cheekBlush'
            )!.defaultColor
          )
        } else if (cheek.mode === 'off' && !customBase) {
          drawMaskedLayer(
            width,
            height,
            context,
            scratch,
            cheekBlush.image,
            multiplyRgb(
              this.definition.defaultTint,
              state.surface.baseColor.tint
            )
          )
        }

        scratch.clearRect(0, 0, width, height)
        scratch.globalCompositeOperation = 'source-over'
        scratch.drawImage(nipplesAreolae.image, 0, 0, width, height)
        nippleMaskCanvas = scratch.canvas

        const texture = new THREE.CanvasTexture(canvas)
        texture.name = 'skin-appearance-base-color-runtime-v2'
        copyTextureSampling(
          this.originalTexture,
          texture,
          THREE.SRGBColorSpace
        )
        texture.channel = this.originalTexture.channel
        material.map = texture
        ownedTextures.push(texture)
      } else {
        material.map = this.originalMaterial.map
      }

      if (state.surface.normal.mode === 'custom') {
        copyTextureSampling(
          this.originalMaterial.normalMap ?? this.originalTexture,
          customNormal!,
          THREE.NoColorSpace
        )
        material.normalMap = customNormal
        material.normalScale.set(
          state.surface.normal.strength,
          -state.surface.normal.strength
        )
      } else if (state.surface.normal.mode === 'none') {
        material.normalMap = null
      } else {
        material.normalMap = this.originalMaterial.normalMap
        if (material.normalMap) {
          material.normalScale.set(
            state.surface.normal.strength,
            -state.surface.normal.strength
          )
        }
      }

      if (state.surface.roughness.mode === 'custom') {
        copyTextureSampling(
          this.originalMaterial.roughnessMap ?? this.originalTexture,
          customRoughness!,
          THREE.NoColorSpace
        )
        material.roughnessMap = customRoughness
        material.roughness = 1
      } else if (state.surface.roughness.mode === 'none') {
        material.roughnessMap = null
        material.roughness = this.definition.materialDefaults.roughness
      } else {
        material.roughnessMap = this.originalMaterial.roughnessMap
        material.roughness = this.originalMaterial.roughness
      }

      if (state.surface.metallic.mode === 'custom') {
        copyTextureSampling(
          this.originalMaterial.metalnessMap ?? this.originalTexture,
          customMetallic!,
          THREE.NoColorSpace
        )
        material.metalnessMap = customMetallic
        material.metalness = 1
      } else if (state.surface.metallic.mode === 'none') {
        material.metalnessMap = null
        material.metalness = 0
      } else {
        material.metalnessMap = this.originalMaterial.metalnessMap
        material.metalness = this.originalMaterial.metalness
      }

      if (
        this.artworkProjection &&
        (!baseColorCanvas || !nipplePigmentCanvas || !nippleMaskCanvas)
      ) {
        fail(
          'Skin Artwork Projection requires its clean Base Color, isolated nipple pigment, and nipple mask'
        )
      }
      preparedProjection =
        this.artworkProjection && nipplePigmentCanvas && nippleMaskCanvas
          ? this.artworkProjection.prepareArtwork(
            nipplePigmentCanvas,
            material,
            nippleMaskCanvas
          )
          : null
      material.needsUpdate = true
      return { material, ownedTextures, projection: preparedProjection }
    } catch (error) {
      this.artworkProjection?.disposePrepared(preparedProjection)
      for (const texture of ownedTextures) texture.dispose()
      throw error
    } finally {
      uploadedBaseColor?.dispose()
    }
  }

  private restoreOriginal() {
    this.mesh.material = this.originalMaterial
    this.ownedMaterial?.dispose()
    for (const texture of this.ownedTextures) texture.dispose()
    this.ownedMaterial = null
    this.ownedTextures = []
  }

  syncSurfaceGeometry(nippleSizeValue: number | null = this.projectionNippleSizeValue) {
    this.projectionNippleSizeValue = nippleSizeValue
    this.artworkProjection?.syncSurfaceGeometry(nippleSizeValue)
  }

  dispose() {
    if (this.disposed) return
    this.generation += 1
    this.restoreOriginal()
    void this.masksPromise?.then((textures) => {
      for (const texture of textures) texture.dispose()
    })
    this.masksPromise = null
    this.artworkProjection?.dispose()
    this.disposed = true
  }
}

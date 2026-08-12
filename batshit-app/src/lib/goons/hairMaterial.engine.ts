import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { color, float, max, min, mix, normalMap, texture, uniform } from 'three/tsl'

import {
  HAIR_VALUE_HIGHLIGHT_STRENGTH,
  HAIR_VALUE_PIVOT,
  parseHairState,
  type HairAssetMaterialDeclarationV1,
  type HairAssetV1,
  type HairStateV2
} from './hairAssets'
import {
  EMBEDDED_HAIR_MATERIAL_CONTRACT,
  parseEmbeddedHairMaterial,
  type EmbeddedHairMaterialV1
} from './hairMaterial'

type RuntimeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>

export type HairMaterialTextureSet = {
  neutralValue: THREE.Texture
  highlightMask: THREE.Texture
  normal: THREE.Texture | null
  roughness: THREE.Texture | null
}

export type HairMaterialRuntimeHandle = {
  readonly assetId: string
  readonly revisionId: string
  readonly materialDefinitionSha256: string
  updateColors(state: HairStateV2): void
}

type Presentation = {
  assetId: string
  revisionId: string
  materialDefinitionSha256: string
  baseColor: string
  highlightColor: string
  metalness: number
  roughness: number
}

function fail(message: string): never {
  throw new Error(`[hair-material/runtime-v1] ${message}`)
}

function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material]
}

function isRuntimeMesh(value: THREE.Object3D): value is RuntimeMesh {
  return 'isMesh' in value && Boolean((value as THREE.Mesh).isMesh)
}

function configureTexture(
  value: THREE.Texture,
  role: 'neutral-value' | 'highlight-mask' | 'normal' | 'roughness'
) {
  value.name = value.name || `Batshit Hair ${role}`
  value.flipY = false
  value.wrapS = THREE.RepeatWrapping
  value.wrapT = THREE.RepeatWrapping
  value.magFilter = THREE.LinearFilter
  value.minFilter = THREE.LinearMipmapLinearFilter
  value.generateMipmaps = true
  value.colorSpace = role === 'neutral-value' ? THREE.SRGBColorSpace : THREE.NoColorSpace
  value.needsUpdate = true
  return value
}

function copyMaterialRenderState(target: MeshStandardNodeMaterial, source: THREE.Material) {
  target.name = `${source.name || source.type}__batshit_hair_material_v1`
  target.side = source.side
  target.shadowSide = source.shadowSide
  target.depthTest = source.depthTest
  target.depthWrite = source.depthWrite
  target.depthFunc = source.depthFunc
  target.colorWrite = source.colorWrite
  target.blending = source.blending
  target.blendSrc = source.blendSrc
  target.blendDst = source.blendDst
  target.blendEquation = source.blendEquation
  target.polygonOffset = source.polygonOffset
  target.polygonOffsetFactor = source.polygonOffsetFactor
  target.polygonOffsetUnits = source.polygonOffsetUnits
  target.alphaToCoverage = source.alphaToCoverage
  target.toneMapped = source.toneMapped
  target.visible = source.visible
  target.transparent = false
  target.opacity = 1
  target.alphaTest = 0
}

function colorFromHex(value: string) {
  return new THREE.Color().setStyle(value, THREE.SRGBColorSpace)
}

function validateTexturePair(
  textures: HairMaterialTextureSet,
  declaration: HairAssetMaterialDeclarationV1
) {
  if (declaration.status !== 'ready' || !declaration.layout || !declaration.definitionSha256) {
    fail('the selected Hair Asset has no ready H3 material declaration')
  }
  if (Boolean(textures.normal) !== Boolean(declaration.normalTexture)) {
    fail('the loaded Normal texture does not match the Hair material declaration')
  }
  if (Boolean(textures.roughness) !== Boolean(declaration.roughnessTexture)) {
    fail('the loaded Roughness texture does not match the Hair material declaration')
  }
}

function buildNodeMaterials(
  root: THREE.Object3D,
  textures: HairMaterialTextureSet,
  presentation: Presentation
): HairMaterialRuntimeHandle {
  const normalizedTextures: HairMaterialTextureSet = {
    neutralValue: configureTexture(textures.neutralValue, 'neutral-value'),
    highlightMask: configureTexture(textures.highlightMask, 'highlight-mask'),
    normal: textures.normal ? configureTexture(textures.normal, 'normal') : null,
    roughness: textures.roughness ? configureTexture(textures.roughness, 'roughness') : null
  }
  const baseColor = uniform(colorFromHex(presentation.baseColor))
  const highlightColor = uniform(colorFromHex(presentation.highlightColor))
  const neutralSample = texture(normalizedTextures.neutralValue)
  const maskSample = texture(normalizedTextures.highlightMask)
  const value = neutralSample.r
  const shadowWeight = min(value.mul(1 / HAIR_VALUE_PIVOT), float(1))
  const highlightWeight = max(
    value
      .sub(HAIR_VALUE_PIVOT)
      .div(1 - HAIR_VALUE_PIVOT)
      .mul(HAIR_VALUE_HIGHLIGHT_STRENGTH),
    float(0)
  )
  const palette = mix(baseColor, highlightColor, maskSample.r)
  const presentationColor = mix(palette.mul(shadowWeight), color(0xffffff), highlightWeight)
  const materialMap = new Map<THREE.Material, MeshStandardNodeMaterial>()
  let meshCount = 0

  root.traverse((object) => {
    if (!isRuntimeMesh(object)) return
    meshCount += 1
    const next = materialList(object.material).map((source) => {
      const existing = materialMap.get(source)
      if (existing) return existing
      const material = new MeshStandardNodeMaterial()
      copyMaterialRenderState(material, source)
      material.colorNode = presentationColor
      material.metalnessNode = float(presentation.metalness)
      material.roughnessNode = normalizedTextures.roughness
        ? texture(normalizedTextures.roughness).g
        : float(presentation.roughness)
      material.normalNode = normalizedTextures.normal
        ? normalMap(texture(normalizedTextures.normal))
        : null
      material.emissiveNode = color(0x000000)

      // Keep the owned texture references on standard map fields as well as
      // inside TSL nodes so the engine's ordinary material disposer owns them.
      material.map = normalizedTextures.neutralValue
      material.emissiveMap = normalizedTextures.highlightMask
      material.normalMap = normalizedTextures.normal
      material.roughnessMap = normalizedTextures.roughness
      material.userData = {
        ...source.userData,
        batshitHairMaterial: {
          contract: EMBEDDED_HAIR_MATERIAL_CONTRACT,
          assetId: presentation.assetId,
          revisionId: presentation.revisionId,
          materialDefinitionSha256: presentation.materialDefinitionSha256,
          baseColor: presentation.baseColor,
          highlightColor: presentation.highlightColor,
          metalness: presentation.metalness,
          roughness: presentation.roughness,
          normalTexture: Boolean(normalizedTextures.normal),
          roughnessTexture: Boolean(normalizedTextures.roughness)
        } satisfies EmbeddedHairMaterialV1
      }
      material.needsUpdate = true
      materialMap.set(source, material)
      return material
    })
    object.material = Array.isArray(object.material) ? next : next[0]!
  })

  if (meshCount === 0 || materialMap.size === 0) {
    fail('the selected Hair geometry contains no renderable mesh materials')
  }

  return {
    assetId: presentation.assetId,
    revisionId: presentation.revisionId,
    materialDefinitionSha256: presentation.materialDefinitionSha256,
    updateColors(stateValue) {
      const state = parseHairState(stateValue)
      if (
        !state.selected ||
        state.selected.assetId !== presentation.assetId ||
        state.selected.assetRevisionId !== presentation.revisionId
      ) {
        fail('Hair recolor state does not target the mounted Hair Asset revision')
      }
      baseColor.value.copy(colorFromHex(state.baseColor))
      highlightColor.value.copy(colorFromHex(state.highlightColor))
    }
  }
}

function textureDimensions(value: THREE.Texture): { width: number; height: number } | null {
  const image = value.image as { width?: unknown; height?: unknown } | undefined
  return image && Number.isInteger(image.width) && Number.isInteger(image.height)
    ? { width: image.width as number, height: image.height as number }
    : null
}

async function loadTextureSet(
  asset: HairAssetV1,
  resolveUrl: (ref: string) => string,
  loader = new THREE.TextureLoader()
): Promise<HairMaterialTextureSet> {
  const declaration = asset.material
  if (
    declaration.status !== 'ready' ||
    !declaration.layout ||
    !declaration.neutralValueTexture ||
    !declaration.highlightMask
  ) {
    fail('the selected Hair Asset has no ready H3 material declaration')
  }
  const entries = [
    ['neutralValue', declaration.neutralValueTexture] as const,
    ['highlightMask', declaration.highlightMask] as const,
    ['normal', declaration.normalTexture] as const,
    ['roughness', declaration.roughnessTexture] as const
  ]
  const settled = await Promise.allSettled(
    entries.map(async ([role, ref]) => [role, ref ? await loader.loadAsync(resolveUrl(ref.ref)) : null] as const)
  )
  const loaded = settled.flatMap((entry) =>
    entry.status === 'fulfilled' && entry.value[1] ? [entry.value[1]] : []
  )
  const failure = settled.find((entry) => entry.status === 'rejected')
  if (failure?.status === 'rejected') {
    loaded.forEach((entry) => entry.dispose())
    fail(`Hair material texture load failed: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`)
  }
  const byRole = Object.fromEntries(
    settled.map((entry) => {
      if (entry.status !== 'fulfilled') fail('Hair material texture load did not settle')
      return entry.value
    })
  ) as Record<'neutralValue' | 'highlightMask' | 'normal' | 'roughness', THREE.Texture | null>
  for (const [role, value] of Object.entries(byRole)) {
    if (!value) continue
    const dimensions = textureDimensions(value)
    if (
      !dimensions ||
      dimensions.width !== declaration.layout.width ||
      dimensions.height !== declaration.layout.height
    ) {
      loaded.forEach((entry) => entry.dispose())
      fail(`${role} texture dimensions do not match the immutable Hair material layout`)
    }
  }
  return {
    neutralValue: byRole.neutralValue!,
    highlightMask: byRole.highlightMask!,
    normal: byRole.normal,
    roughness: byRole.roughness
  }
}

export async function applyHairAssetMaterial(
  root: THREE.Object3D,
  asset: HairAssetV1,
  stateValue: HairStateV2,
  resolveUrl: (ref: string) => string
): Promise<HairMaterialRuntimeHandle> {
  const state = parseHairState(stateValue)
  if (
    !state.selected ||
    state.selected.assetId !== asset.assetId ||
    state.selected.assetRevisionId !== asset.revisionId
  ) {
    fail('Hair material state does not bind the selected Hair Asset revision')
  }
  const textures = await loadTextureSet(asset, resolveUrl)
  try {
    validateTexturePair(textures, asset.material)
    return buildNodeMaterials(root, textures, {
      assetId: asset.assetId,
      revisionId: asset.revisionId,
      materialDefinitionSha256: asset.material.definitionSha256!,
      baseColor: state.baseColor,
      highlightColor: state.highlightColor,
      metalness: asset.material.defaults.metalness,
      roughness: asset.material.defaults.roughness
    })
  } catch (error) {
    for (const textureValue of [
      textures.neutralValue,
      textures.highlightMask,
      textures.normal,
      textures.roughness
    ]) {
      textureValue?.dispose()
    }
    throw error
  }
}

export function applyEmbeddedHairMaterials(root: THREE.Object3D): number {
  const embedded = new Map<THREE.Material, EmbeddedHairMaterialV1>()
  root.traverse((object) => {
    if (!isRuntimeMesh(object)) return
    for (const source of materialList(object.material)) {
      const metadata = parseEmbeddedHairMaterial(source.userData?.batshitHairMaterial)
      if (!metadata) continue
      embedded.set(source, metadata)
    }
  })
  const replacements = new Map<THREE.Material, THREE.Material>()
  for (const [sourceValue, metadata] of embedded) {
    const source = sourceValue as THREE.MeshStandardMaterial
    if (!source.map || !source.emissiveMap) {
      fail('embedded Hair material is missing its neutral value or Highlight-mask texture')
    }
    if (metadata.normalTexture !== Boolean(source.normalMap)) {
      fail('embedded Hair Normal texture does not match its material metadata')
    }
    if (metadata.roughnessTexture !== Boolean(source.roughnessMap)) {
      fail('embedded Hair Roughness texture does not match its material metadata')
    }
    const replacementRoot = new THREE.Group()
    const proxy = new THREE.Mesh(new THREE.BufferGeometry(), source)
    replacementRoot.add(proxy)
    buildNodeMaterials(
      replacementRoot,
      {
        neutralValue: source.map,
        highlightMask: source.emissiveMap,
        normal: source.normalMap,
        roughness: source.roughnessMap
      },
      {
        assetId: metadata.assetId,
        revisionId: metadata.revisionId,
        materialDefinitionSha256: metadata.materialDefinitionSha256,
        baseColor: metadata.baseColor,
        highlightColor: metadata.highlightColor,
        metalness: metadata.metalness,
        roughness: metadata.roughness
      }
    )
    replacements.set(source, proxy.material as THREE.Material)
  }
  let applied = 0
  root.traverse((object) => {
    if (!isRuntimeMesh(object)) return
    if (Array.isArray(object.material)) {
      object.material = object.material.map((source) => {
        const replacement = replacements.get(source)
        if (replacement) applied += 1
        return replacement ?? source
      })
      return
    }
    const replacement = replacements.get(object.material)
    if (!replacement) return
    object.material = replacement
    applied += 1
  })
  for (const source of replacements.keys()) source.dispose()
  return applied
}

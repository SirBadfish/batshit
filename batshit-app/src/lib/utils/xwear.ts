import { strFromU8, unzipSync } from 'fflate'
import type {
  GoonFileRef,
  GoonXWearData,
  GoonXWearMaterial,
  GoonXWearPropertyColor
} from '$lib/types/goons'
import { normalizeClosetSlotMaterialName } from '$lib/goons/closetMaterials'
import { bytesToFile } from '$lib/utils/binary'

export type ParsedXWearMaterial = Omit<GoonXWearMaterial, 'textures'> & {
  textures?: Record<string, File>
}

export type ParsedXWear = {
  name: string
  materials: ParsedXWearMaterial[]
}

const COLOR_PROPERTIES = new Set([
  '_Color',
  '_ShadeColor',
  '_EmissionColor',
  '_MatcapColor',
  '_RimColor',
  '_OutlineColor'
])

const TEXTURE_PROPERTIES = new Set([
  '_MainTex',
  '_ShadeTex',
  '_BumpMap',
  '_EmissionMap',
  '_MatcapTex',
  '_RimTex',
  '_OutlineWidthMultiplyTexture',
  '_UvAnimMaskTex',
  '_ShadingShiftTex'
])

export async function parseXWearFile(file: File): Promise<ParsedXWear> {
  const data = new Uint8Array(await file.arrayBuffer())
  const unzipped = unzipSync(data)
  const entries: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(unzipped)) {
    entries[name.replace(/\\/g, '/')] = bytes
  }

  const xItemPath = Object.keys(entries).find((name) => name.endsWith('XItem.json'))
  if (!xItemPath) {
    throw new Error('XWear missing XItem.json')
  }

  const xItem = JSON.parse(strFromU8(entries[xItemPath]))
  const materials = Array.isArray(xItem?.XResourceMaterials) ? xItem.XResourceMaterials : []
  if (materials.length === 0) {
    throw new Error('XWear has no materials')
  }

  const parsedMaterials: ParsedXWearMaterial[] = materials.map((material: any, index: number) => {
    const materialName = material?.Name ?? `${file.name.replace(/\.xwear$/i, '')}_${index + 1}`
    const shader = material?.ShaderName ?? ''
    const colors: Record<string, GoonXWearPropertyColor> = {}
    const floats: Record<string, number> = {}
    const textureGuids: Record<string, string> = {}

    for (const prop of material?.ShaderProperties ?? []) {
      const propertyName = prop?.PropertyName
      if (!propertyName) continue
      const type = prop?.$type ?? ''
      if (type.includes('ShaderColorProperty') && COLOR_PROPERTIES.has(propertyName)) {
        const color = prop?.Color
        if (color && typeof color.r === 'number') {
          colors[propertyName] = {
            r: color.r,
            g: color.g,
            b: color.b,
            a: color.a ?? 1
          }
        }
        continue
      }
      if (type.includes('ShaderFloatProperty')) {
        const value = prop?.Value
        if (typeof value === 'number') {
          floats[propertyName] = value
        }
        continue
      }
      if (type.includes('ShaderTextureProperty') && TEXTURE_PROPERTIES.has(propertyName)) {
        const guid = prop?.TextureGuid
        if (guid) {
          textureGuids[propertyName] = guid
        }
      }
    }

    const textures: Record<string, File> = {}
    for (const [property, guid] of Object.entries(textureGuids)) {
      const key = Object.keys(entries).find((name) => name.endsWith(`Textures/${guid}.png`))
      if (!key) continue
      const bytes = entries[key]
      textures[property] = bytesToFile(bytes, `${guid}.png`, { type: 'image/png' })
    }

    return {
      materialName,
      shader,
      colors: Object.keys(colors).length ? colors : undefined,
      floats: Object.keys(floats).length ? floats : undefined,
      textures: Object.keys(textures).length ? textures : undefined
    }
  })

  return {
    name: file.name.replace(/\.xwear$/i, ''),
    materials: parsedMaterials
  }
}

export function getXWearMaterials(xwear?: GoonXWearData | null): GoonXWearMaterial[] {
  if (!xwear) return []
  if (Array.isArray(xwear.materials) && xwear.materials.length > 0) {
    return xwear.materials.filter((material): material is GoonXWearMaterial => Boolean(material?.materialName))
  }
  if (!xwear.materialName) return []
  return [
    {
      materialName: xwear.materialName,
      shader: xwear.shader,
      colors: xwear.colors,
      floats: xwear.floats,
      textures: xwear.textures
    }
  ]
}

export function xwearMaterialTargetsMatch(left?: string | null, right?: string | null) {
  if (!left || !right) return false
  return normalizeClosetSlotMaterialName(left) === normalizeClosetSlotMaterialName(right)
}

export function resolveXWearLayersForMaterial(
  xwear?: GoonXWearData | null,
  materialName?: string | null
): GoonXWearMaterial[] {
  if (!xwear) return []

  const materials = getXWearMaterials(xwear)
  const matchingLayers =
    materialName
      ? materials.filter((layer) => xwearMaterialTargetsMatch(layer.materialName, materialName))
      : []
  if (matchingLayers.length > 0) return matchingLayers

  if (materials.length > 0) {
    return [materials[0]]
  }

  if (!xwear.materialName) return []
  return [
    {
      materialName: xwear.materialName,
      shader: xwear.shader,
      colors: xwear.colors,
      floats: xwear.floats,
      textures: xwear.textures
    }
  ]
}

export function getPrimaryXWearMaterialName(xwear?: GoonXWearData | null) {
  return getXWearMaterials(xwear)[0]?.materialName
}

export function buildStoredXWear(materials: Array<Omit<GoonXWearMaterial, 'textures'> & { textures?: Record<string, GoonFileRef> }>): GoonXWearData {
  const [primary] = materials
  return {
    materialName: primary?.materialName ?? '',
    shader: primary?.shader,
    colors: primary?.colors,
    floats: primary?.floats,
    textures: primary?.textures,
    materials
  }
}

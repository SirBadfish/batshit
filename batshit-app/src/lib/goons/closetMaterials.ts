import type { GoonMaterialColorOverride, GoonXWearPropertyColor } from '$lib/types/goons'

const INSTANCE_SUFFIX = /\s*\(Instance\)\s*$/i
const CLONE_SUFFIX = /\s*\(Clone\)\s*$/i
const CLOSET_DUPLICATE_SLOT_SUFFIX = /(_(?:CLOTH|SKIN))_\d+$/i
const BODY_SKIN_RE = /body_00_skin/i
const HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/
const SHADE_RELATION_EPSILON = 1e-3
const DEFAULT_LINEAR_SHADE_FACTOR = 0.78

export const SKIN_OVERLAY_SLOT_KEY = '__batshit_skin_overlay__'

const DEFAULT_CLOSET_SLOT_LABELS: Record<string, string> = {
  [SKIN_OVERLAY_SLOT_KEY]: 'Skin Overlay',
  N00_000_00_Body_00_SKIN: 'Skin Overlay',
  Accessory_CatEar_01_CLOTH: 'Cat Ear',
  N00_001_01_Accessory_Tie_01_CLOTH: 'Short Tie',
  N00_001_02_Accessory_Tie_01_CLOTH: 'Pussycat Bow',
  N00_007_01_Accessory_Tie_01_CLOTH: 'Necktie',
  N00_007_02_Accessory_Tie_01_CLOTH: 'String Tie',
  N00_003_01_Tops_01_CLOTH: 'Mini-T-Shirt',
  N00_004_01_Tops_01_CLOTH: 'T-Shirt',
  N00_001_02_Tops_01_CLOTH: 'Uniform Vest',
  N00_005_01_Tops_01_CLOTH: 'Hoodie',
  N00_007_02_Tops_01_CLOTH: 'Suit Jacket',
  N00_002_01_Tops_01_CLOTH: 'Dress (Long Sleeve)',
  N00_002_02_Tops_01_CLOTH: 'Off-Shoulder Dress',
  N00_002_03_Tops_01_CLOTH: 'Dress (Half-Sleeve)',
  N00_002_04_Tops_01_CLOTH: 'Pencil Dress',
  N00_001_01_Bottoms_01_CLOTH: 'Pants/Shorts',
  N00_001_03_Bottoms_01_CLOTH: 'Mini-Skirt',
  N00_003_01_Bottoms_01_CLOTH: 'Skirt',
  N00_001_01_Shoes_01_CLOTH: 'Loafers',
  N00_002_01_Shoes_01_CLOTH: 'Chunky Sole Boots',
  N00_003_01_Shoes_01_CLOTH: 'Heels',
  N00_004_01_Shoes_01_CLOTH: 'Sneakers',
  N00_005_01_Shoes_01_CLOTH: 'Basketball Sneakers',
  N00_006_01_Shoes_01_CLOTH: 'High Cut Sneakers',
  N00_008_01_Shoes_01_CLOTH: 'Long Boots',
  N00_009_01_Shoes_01_CLOTH: 'Stiletto Boots/Pumps',
  N00_010_01_Onepiece_00_CLOTH: 'Body Suit'
}

type LinearRgb = {
  r: number
  g: number
  b: number
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value))
}

function srgbToLinear(value: number) {
  if (value <= 0.04045) return value / 12.92
  return Math.pow((value + 0.055) / 1.055, 2.4)
}

function linearToSrgb(value: number) {
  if (value <= 0.0031308) return value * 12.92
  return 1.055 * Math.pow(value, 1 / 2.4) - 0.055
}

function colorsNearlyEqual(a: LinearRgb, b: LinearRgb) {
  return (
    Math.abs(a.r - b.r) <= SHADE_RELATION_EPSILON &&
    Math.abs(a.g - b.g) <= SHADE_RELATION_EPSILON &&
    Math.abs(a.b - b.b) <= SHADE_RELATION_EPSILON
  )
}

export function stripClosetMaterialInstanceSuffix(materialName: string) {
  return materialName.replace(INSTANCE_SUFFIX, '').trim()
}

export function stripClosetMaterialCloneSuffix(materialName: string) {
  return materialName.replace(CLONE_SUFFIX, '').trim()
}

export function normalizeClosetSlotMaterialName(materialName: string) {
  return stripClosetMaterialCloneSuffix(stripClosetMaterialInstanceSuffix(materialName)).replace(
    CLOSET_DUPLICATE_SLOT_SUFFIX,
    '$1'
  )
}

export function isClosetSlotMaterialName(materialName: string) {
  const normalized = normalizeClosetSlotMaterialName(materialName)
  return normalized.includes('_CLOTH') || BODY_SKIN_RE.test(normalized)
}

export function isBodySkinClosetSlotMaterialName(materialName: string) {
  return BODY_SKIN_RE.test(normalizeClosetSlotMaterialName(materialName))
}

export function isSkinOverlayClosetSlotKey(materialName: string) {
  return materialName === SKIN_OVERLAY_SLOT_KEY
}

export function buildClosetSlotNames(materialNames: string[]) {
  const slotNames = materialNames.filter(
    (name) => isClosetSlotMaterialName(name) && !isBodySkinClosetSlotMaterialName(name)
  )
  if (materialNames.some((name) => isBodySkinClosetSlotMaterialName(name))) {
    slotNames.push(SKIN_OVERLAY_SLOT_KEY)
  }
  return slotNames
}

export function resolveClosetRuntimeMaterialName(slotName: string, materialNames: string[]) {
  if (isSkinOverlayClosetSlotKey(slotName)) {
    return materialNames.find((name) => isBodySkinClosetSlotMaterialName(name)) ?? null
  }
  return slotName
}

export function getDefaultClosetSlotLabel(materialName: string) {
  return DEFAULT_CLOSET_SLOT_LABELS[normalizeClosetSlotMaterialName(materialName)] ?? 'Other'
}

export function normalizeHexColor(value?: string | null) {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!HEX_COLOR_RE.test(trimmed)) return undefined
  const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  return normalized.toUpperCase()
}

export function hexToLinearRgb(value?: string | null): LinearRgb | null {
  const normalized = normalizeHexColor(value)
  if (!normalized) return null

  return {
    r: srgbToLinear(parseInt(normalized.slice(1, 3), 16) / 255),
    g: srgbToLinear(parseInt(normalized.slice(3, 5), 16) / 255),
    b: srgbToLinear(parseInt(normalized.slice(5, 7), 16) / 255)
  }
}

export function linearRgbToHex(value?: LinearRgb | null) {
  if (!value) return undefined

  const toHexChannel = (channel: number) =>
    Math.round(clampUnit(linearToSrgb(channel)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()

  return `#${toHexChannel(value.r)}${toHexChannel(value.g)}${toHexChannel(value.b)}`
}

export function xwearColorToHex(color?: GoonXWearPropertyColor | null) {
  if (!color) return undefined
  return linearRgbToHex({ r: color.r, g: color.g, b: color.b })
}

export function deriveAutoShadeHex(
  baseHex: string,
  sourceBaseHex?: string | null,
  sourceShadeHex?: string | null
) {
  const targetBase = hexToLinearRgb(baseHex)
  if (!targetBase) return undefined

  const sourceBase = hexToLinearRgb(sourceBaseHex)
  const sourceShade = hexToLinearRgb(sourceShadeHex)

  if (sourceBase && sourceShade && !colorsNearlyEqual(sourceBase, sourceShade)) {
    const ratios: Array<number | null> = [
      sourceBase.r > SHADE_RELATION_EPSILON ? sourceShade.r / sourceBase.r : null,
      sourceBase.g > SHADE_RELATION_EPSILON ? sourceShade.g / sourceBase.g : null,
      sourceBase.b > SHADE_RELATION_EPSILON ? sourceShade.b / sourceBase.b : null
    ]

    const fallbackRatio =
      ratios.filter((value): value is number => typeof value === 'number').reduce((sum, value, _, values) => {
        return sum + value / values.length
      }, 0) || DEFAULT_LINEAR_SHADE_FACTOR

    return linearRgbToHex({
      r: clampUnit(targetBase.r * (ratios[0] ?? fallbackRatio)),
      g: clampUnit(targetBase.g * (ratios[1] ?? fallbackRatio)),
      b: clampUnit(targetBase.b * (ratios[2] ?? fallbackRatio))
    })
  }

  return linearRgbToHex({
    r: targetBase.r * DEFAULT_LINEAR_SHADE_FACTOR,
    g: targetBase.g * DEFAULT_LINEAR_SHADE_FACTOR,
    b: targetBase.b * DEFAULT_LINEAR_SHADE_FACTOR
  })
}

export function hasMaterialColorOverride(override?: GoonMaterialColorOverride | null) {
  return Boolean(normalizeHexColor(override?.baseHex) || normalizeHexColor(override?.shadeHex))
}

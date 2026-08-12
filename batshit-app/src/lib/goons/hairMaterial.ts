import {
  HAIR_VALUE_HIGHLIGHT_STRENGTH,
  HAIR_VALUE_PIVOT,
  parseHairState,
  type HairAssetMaterialDeclarationV1,
  type HairAssetV1,
  type HairStateV2
} from './hairAssets'

export const EMBEDDED_HAIR_MATERIAL_CONTRACT = 'embedded-hair-material/v1' as const

export const HAIR_COLOR_PRESETS = [
  { id: 'dark-purple', label: 'Dark Purple', baseColor: '#21142f', highlightColor: '#68468f' },
  { id: 'black-violet', label: 'Black Violet', baseColor: '#05040a', highlightColor: '#2f2045' },
  { id: 'chestnut', label: 'Chestnut', baseColor: '#32150e', highlightColor: '#8b4d2d' },
  { id: 'platinum', label: 'Platinum', baseColor: '#b8a88d', highlightColor: '#fff1cc' },
  { id: 'ocean-blue', label: 'Ocean Blue', baseColor: '#071e3b', highlightColor: '#2d90d4' }
] as const

export type EmbeddedHairMaterialV1 = {
  contract: typeof EMBEDDED_HAIR_MATERIAL_CONTRACT
  assetId: string
  revisionId: string
  materialDefinitionSha256: string
  baseColor: string
  highlightColor: string
  metalness: number
  roughness: number
  normalTexture: boolean
  roughnessTexture: boolean
}

export type HairMaterialTextureRole =
  | 'neutral-value'
  | 'highlight-mask'
  | 'normal'
  | 'roughness'

function fail(message: string): never {
  throw new Error(`[hair-material/v1] ${message}`)
}

export function createEmbeddedHairMaterialMetadata(
  asset: HairAssetV1,
  stateValue: HairStateV2
): EmbeddedHairMaterialV1 {
  const state = parseHairState(stateValue)
  if (
    asset.material.status !== 'ready' ||
    !asset.material.definitionSha256 ||
    !state.selected ||
    state.selected.assetId !== asset.assetId ||
    state.selected.assetRevisionId !== asset.revisionId
  ) {
    fail('embedded material metadata requires one ready, exactly selected Hair Asset revision')
  }
  return {
    contract: EMBEDDED_HAIR_MATERIAL_CONTRACT,
    assetId: asset.assetId,
    revisionId: asset.revisionId,
    materialDefinitionSha256: asset.material.definitionSha256,
    baseColor: state.baseColor,
    highlightColor: state.highlightColor,
    metalness: asset.material.defaults.metalness,
    roughness: asset.material.defaults.roughness,
    normalTexture: Boolean(asset.material.normalTexture),
    roughnessTexture: Boolean(asset.material.roughnessTexture)
  }
}

export function parseEmbeddedHairMaterial(value: unknown): EmbeddedHairMaterialV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.contract !== EMBEDDED_HAIR_MATERIAL_CONTRACT) return null
  const exact = [
    'assetId',
    'baseColor',
    'contract',
    'highlightColor',
    'materialDefinitionSha256',
    'metalness',
    'normalTexture',
    'revisionId',
    'roughness',
    'roughnessTexture'
  ]
  if (Object.keys(raw).sort().join(',') !== exact.sort().join(',')) {
    fail('embedded Hair material metadata contains unsupported fields')
  }
  for (const key of ['assetId', 'revisionId'] as const) {
    if (typeof raw[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw[key])) {
      fail(`embedded Hair material ${key} is invalid`)
    }
  }
  if (
    typeof raw.materialDefinitionSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.materialDefinitionSha256)
  ) {
    fail('embedded Hair material definition hash is invalid')
  }
  for (const key of ['baseColor', 'highlightColor'] as const) {
    if (typeof raw[key] !== 'string' || !/^#[a-f0-9]{6}$/.test(raw[key])) {
      fail(`embedded Hair material ${key} is invalid`)
    }
  }
  for (const key of ['metalness', 'roughness'] as const) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > 1) {
      fail(`embedded Hair material ${key} must be between 0 and 1`)
    }
  }
  if (typeof raw.normalTexture !== 'boolean' || typeof raw.roughnessTexture !== 'boolean') {
    fail('embedded Hair material texture flags are invalid')
  }
  return raw as EmbeddedHairMaterialV1
}

export function inspectHairMaterialPng(
  bytes: Uint8Array,
  declaration: HairAssetMaterialDeclarationV1,
  role: HairMaterialTextureRole
): { width: number; height: number; colorType: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.byteLength < 33 || signature.some((entry, index) => bytes[index] !== entry)) {
    fail(`${role} texture is not a complete PNG`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let chunkIndex = 0
  let sawImageData = false
  let sawEnd = false
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) fail(`${role} texture has a truncated PNG chunk`)
    const byteLength = view.getUint32(offset, false)
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!
    )
    const end = offset + 12 + byteLength
    if (!/^[A-Za-z]{4}$/.test(type) || !Number.isSafeInteger(end) || end > bytes.byteLength) {
      fail(`${role} texture has an invalid PNG chunk`)
    }
    if (chunkIndex === 0 && (type !== 'IHDR' || byteLength !== 13)) {
      fail(`${role} texture does not begin with one canonical PNG IHDR chunk`)
    }
    if (chunkIndex > 0 && type === 'IHDR') fail(`${role} texture contains multiple PNG headers`)
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      fail(`${role} texture must be a single-frame PNG`)
    }
    if (type === 'IDAT') sawImageData = true
    if (type === 'IEND') {
      if (byteLength !== 0 || !sawImageData || end !== bytes.byteLength) {
        fail(`${role} texture has an invalid PNG ending`)
      }
      sawEnd = true
    }
    offset = end
    chunkIndex += 1
  }
  if (!sawEnd) fail(`${role} texture is missing its PNG ending`)
  const chunkLength = view.getUint32(8, false)
  const chunkType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (chunkLength !== 13 || chunkType !== 'IHDR') {
    fail(`${role} texture does not begin with one canonical PNG IHDR chunk`)
  }
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  const bitDepth = bytes[24]
  const colorType = bytes[25]!
  const compression = bytes[26]
  const filtering = bytes[27]
  const interlace = bytes[28]
  if (!declaration.layout || width !== declaration.layout.width || height !== declaration.layout.height) {
    fail(`${role} texture dimensions do not match the immutable material layout`)
  }
  if (
    bitDepth !== 8 ||
    ![0, 2, 4, 6].includes(colorType) ||
    compression !== 0 ||
    filtering !== 0 ||
    interlace !== 0
  ) {
    fail(`${role} texture must be a non-interlaced 8-bit grayscale or RGB PNG`)
  }
  if (role === 'normal' && ![2, 6].includes(colorType)) {
    fail('Normal texture must contain RGB data')
  }
  return { width, height, colorType }
}

export function evaluateHairValueMasterLinear(input: {
  base: readonly [number, number, number]
  highlight: readonly [number, number, number]
  mask: number
  value: number
}): [number, number, number] {
  const mask = Math.min(1, Math.max(0, input.mask))
  const value = Math.min(1, Math.max(0, input.value))
  const shadowWeight = Math.min(1, value / HAIR_VALUE_PIVOT)
  const highlightWeight =
    Math.max(0, (value - HAIR_VALUE_PIVOT) / (1 - HAIR_VALUE_PIVOT)) *
    HAIR_VALUE_HIGHLIGHT_STRENGTH
  return input.base.map((base, index) => {
    const palette = base + (input.highlight[index]! - base) * mask
    const shadowed = palette * shadowWeight
    return Math.min(1, Math.max(0, shadowed + (1 - shadowed) * highlightWeight))
  }) as [number, number, number]
}

import {
  SKIN_SURFACE_MAP_ROLES,
  parseSkinSurfaceUpload,
  type SkinSurfaceMapRole,
  type SkinSurfaceUploadV1
} from './skinSurface'

export const SKIN_APPEARANCE_SCHEMA_VERSION = 'skin-appearance/v1' as const
export const LEGACY_SKIN_APPEARANCE_STATE_SCHEMA_VERSION =
  'skin-appearance-state/v1' as const
export const SKIN_APPEARANCE_STATE_SCHEMA_VERSION =
  'skin-appearance-state/v2' as const

export const SKIN_APPEARANCE_REGION_IDS = [
  'nipplesAreolae',
  'palmsSoles',
  'cheekBlush'
] as const
const LEGACY_SKIN_APPEARANCE_REGION_IDS = [
  'baseSkin',
  ...SKIN_APPEARANCE_REGION_IDS
] as const

export const DEFAULT_SKIN_ARTWORK_TINT: SkinAppearanceRgb = [
  0.729412, 0.486275, 0.407843
]
export const DEFAULT_SKIN_NORMAL_STRENGTH = 1

export type SkinAppearanceRegionId = (typeof SKIN_APPEARANCE_REGION_IDS)[number]
export type SkinAppearanceRgb = [number, number, number]
export type SkinAppearanceMode = 'inherit' | 'custom'
export type SkinAppearanceCheekMode = SkinAppearanceMode | 'off'
export type SkinSurfaceBaseColorMode = 'package' | 'custom'
export type SkinSurfaceOptionalMode = SkinSurfaceBaseColorMode | 'none'

export type SkinAppearanceAssetRef = {
  path: string
  sha256: string
  width: number
  height: number
  channels: 'alpha-rgba8'
}

export type SkinAppearanceControlDefinition = {
  id: SkinAppearanceRegionId
  label: string
  description: string
  defaultColor: SkinAppearanceRgb
  modes: Array<SkinAppearanceMode | SkinAppearanceCheekMode>
}

export type SkinAppearanceDefinitionV1 = {
  schemaVersion: typeof SKIN_APPEARANCE_SCHEMA_VERSION
  stateSchemaVersion: typeof SKIN_APPEARANCE_STATE_SCHEMA_VERSION
  packageStateSchemaVersion: typeof LEGACY_SKIN_APPEARANCE_STATE_SCHEMA_VERSION
  status: string
  productExportApproved: true
  definitionSha256: string
  ownership: string
  defaultLaw: string
  compositionOrder: SkinAppearanceRegionId[]
  runtimeBinding: {
    node: string
    material: string
    baseColorTextureSha256: string
  }
  canvas: {
    width: number
    height: number
    colorSpace: 'srgb'
    flipY: false
  }
  materialDefaults: {
    color: [1, 1, 1]
    roughness: number
    metalness: number
  }
  masks: {
    generalSkin: SkinAppearanceAssetRef
    nipplesAreolae: SkinAppearanceAssetRef
    palmsSoles: SkinAppearanceAssetRef
    cheekBlush: SkinAppearanceAssetRef
  }
  controls: SkinAppearanceControlDefinition[]
  defaultTint: SkinAppearanceRgb
}

export type SkinAppearanceStateV2 = {
  schemaVersion: typeof SKIN_APPEARANCE_STATE_SCHEMA_VERSION
  definitionSha256: string
  surface: {
    baseColor: {
      mode: SkinSurfaceBaseColorMode
      custom: SkinSurfaceUploadV1 | null
      tint: SkinAppearanceRgb
    }
    normal: {
      mode: SkinSurfaceOptionalMode
      custom: SkinSurfaceUploadV1 | null
      strength: number
    }
    roughness: {
      mode: SkinSurfaceOptionalMode
      custom: SkinSurfaceUploadV1 | null
    }
    metallic: {
      mode: SkinSurfaceOptionalMode
      custom: SkinSurfaceUploadV1 | null
    }
  }
  regions: {
    nipplesAreolae: { mode: SkinAppearanceMode; color: SkinAppearanceRgb }
    palmsSoles: { mode: SkinAppearanceMode; color: SkinAppearanceRgb }
    cheekBlush: { mode: SkinAppearanceCheekMode; color: SkinAppearanceRgb }
  }
}

/** @deprecated Read-only migration input. New writes use SkinAppearanceStateV2. */
export type SkinAppearanceStateV1 = {
  schemaVersion: typeof LEGACY_SKIN_APPEARANCE_STATE_SCHEMA_VERSION
  definitionSha256: string
  regions: {
    baseSkin: { mode: SkinAppearanceMode; color: SkinAppearanceRgb }
    nipplesAreolae: { mode: SkinAppearanceMode; color: SkinAppearanceRgb }
    palmsSoles: { mode: SkinAppearanceMode; color: SkinAppearanceRgb }
    cheekBlush: { mode: SkinAppearanceCheekMode; color: SkinAppearanceRgb }
  }
}

export type SkinAppearanceReconciliation = {
  state: SkinAppearanceStateV2 | null
  incompatible: boolean
  reason?: string
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const PUBLIC_ASSET_PREFIX = 'goons/skin-appearance/v1/'
const COLOR_DECIMAL_SCALE = 1_000_000
const MASK_IDS = [
  'generalSkin',
  'nipplesAreolae',
  'palmsSoles',
  'cheekBlush'
] as const

function fail(message: string): never {
  throw new Error(`[skin-appearance/v2] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string
) {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${context} must contain exactly: ${expected.join(', ')}`)
  }
}

function text(value: unknown, context: string) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function finite(value: unknown, context: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be finite`)
  }
  return value
}

function unit(value: unknown, context: string) {
  const parsed = finite(value, context)
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`)
  return parsed
}

function positiveInteger(value: unknown, context: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${context} must be a positive integer`)
  }
  return value as number
}

function sha256(value: unknown, context: string) {
  const parsed = text(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function stableColorUnit(value: unknown, context: string) {
  return (
    Math.round(unit(value, context) * COLOR_DECIMAL_SCALE) / COLOR_DECIMAL_SCALE
  )
}

function rgb(value: unknown, context: string): SkinAppearanceRgb {
  if (!Array.isArray(value) || value.length !== 3) {
    fail(`${context} must have three channels`)
  }
  return value.map((channel, index) =>
    stableColorUnit(channel, `${context}[${index}]`)
  ) as SkinAppearanceRgb
}

function parseAsset(value: unknown, context: string): SkinAppearanceAssetRef {
  const source = record(value, context)
  exactKeys(source, ['path', 'sha256', 'width', 'height', 'channels'], context)
  const path = text(source.path, `${context}.path`)
  if (
    !path.startsWith(PUBLIC_ASSET_PREFIX) ||
    path.includes('\\') ||
    path.split('/').includes('..')
  ) {
    fail(`${context}.path must be a public Skin Appearance asset`)
  }
  if (source.channels !== 'alpha-rgba8') {
    fail(`${context}.channels must be alpha-rgba8`)
  }
  return {
    path,
    sha256: sha256(source.sha256, `${context}.sha256`),
    width: positiveInteger(source.width, `${context}.width`),
    height: positiveInteger(source.height, `${context}.height`),
    channels: 'alpha-rgba8'
  }
}

function parseRawControl(
  value: unknown,
  expectedId: (typeof LEGACY_SKIN_APPEARANCE_REGION_IDS)[number],
  context: string
) {
  const source = record(value, context)
  exactKeys(
    source,
    ['id', 'label', 'description', 'defaultColor', 'modes'],
    context
  )
  if (source.id !== expectedId) fail(`${context}.id must be ${expectedId}`)
  const expectedModes =
    expectedId === 'cheekBlush'
      ? ['inherit', 'off', 'custom']
      : ['inherit', 'custom']
  if (
    !Array.isArray(source.modes) ||
    source.modes.length !== expectedModes.length ||
    source.modes.some((mode, index) => mode !== expectedModes[index])
  ) {
    fail(`${context}.modes must be ${expectedModes.join(', ')}`)
  }
  return {
    id: expectedId,
    label: text(source.label, `${context}.label`),
    description: text(source.description, `${context}.description`),
    defaultColor: rgb(source.defaultColor, `${context}.defaultColor`),
    modes: expectedModes
  }
}

export function parseSkinAppearanceDefinition(
  value: unknown
): SkinAppearanceDefinitionV1 {
  const source = record(value, 'definition')
  exactKeys(
    source,
    [
      'schemaVersion',
      'stateSchemaVersion',
      'status',
      'productExportApproved',
      'definitionSha256',
      'ownership',
      'defaultLaw',
      'compositionOrder',
      'runtimeBinding',
      'canvas',
      'materialDefaults',
      'masks',
      'controls'
    ],
    'definition'
  )
  if (source.schemaVersion !== SKIN_APPEARANCE_SCHEMA_VERSION) {
    fail('package definition schemaVersion is unsupported')
  }
  if (source.stateSchemaVersion !== LEGACY_SKIN_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail('package definition stateSchemaVersion is unsupported')
  }
  if (source.productExportApproved !== true) {
    fail('definition productExportApproved must be true')
  }

  const compositionOrder = source.compositionOrder
  if (
    !Array.isArray(compositionOrder) ||
    compositionOrder.length !== LEGACY_SKIN_APPEARANCE_REGION_IDS.length ||
    compositionOrder.some(
      (id, index) => id !== LEGACY_SKIN_APPEARANCE_REGION_IDS[index]
    )
  ) {
    fail(
      `package definition.compositionOrder must be ${LEGACY_SKIN_APPEARANCE_REGION_IDS.join(', ')}`
    )
  }

  const runtimeBinding = record(source.runtimeBinding, 'definition.runtimeBinding')
  exactKeys(
    runtimeBinding,
    ['node', 'material', 'baseColorTextureSha256'],
    'definition.runtimeBinding'
  )
  const canvas = record(source.canvas, 'definition.canvas')
  exactKeys(canvas, ['width', 'height', 'colorSpace', 'flipY'], 'definition.canvas')
  if (canvas.colorSpace !== 'srgb' || canvas.flipY !== false) {
    fail('definition.canvas must use srgb with flipY false')
  }
  const width = positiveInteger(canvas.width, 'definition.canvas.width')
  const height = positiveInteger(canvas.height, 'definition.canvas.height')
  if (width !== height) fail('definition.canvas must be square')

  const materialDefaults = record(source.materialDefaults, 'definition.materialDefaults')
  exactKeys(
    materialDefaults,
    ['color', 'roughness', 'metalness'],
    'definition.materialDefaults'
  )
  if (
    !Array.isArray(materialDefaults.color) ||
    materialDefaults.color.length !== 3 ||
    materialDefaults.color.some((channel) => channel !== 1)
  ) {
    fail('definition.materialDefaults.color must be literal white')
  }

  const masksSource = record(source.masks, 'definition.masks')
  exactKeys(masksSource, MASK_IDS, 'definition.masks')
  const masks = Object.fromEntries(
    MASK_IDS.map((id) => [
      id,
      parseAsset(masksSource[id], `definition.masks.${id}`)
    ])
  ) as SkinAppearanceDefinitionV1['masks']
  for (const [id, asset] of Object.entries(masks)) {
    if (asset.width !== asset.height || width % asset.width !== 0) {
      fail(`definition.masks.${id} must be a square exact divisor of the canvas`)
    }
  }

  if (
    !Array.isArray(source.controls) ||
    source.controls.length !== LEGACY_SKIN_APPEARANCE_REGION_IDS.length
  ) {
    fail('package definition.controls has the wrong length')
  }
  const controlsSource = source.controls as unknown[]
  const rawControls = LEGACY_SKIN_APPEARANCE_REGION_IDS.map((id, index) =>
    parseRawControl(controlsSource[index], id, `definition.controls[${index}]`)
  )
  const baseControl = rawControls[0]
  const controls = rawControls.slice(1) as SkinAppearanceControlDefinition[]

  return {
    schemaVersion: SKIN_APPEARANCE_SCHEMA_VERSION,
    stateSchemaVersion: SKIN_APPEARANCE_STATE_SCHEMA_VERSION,
    packageStateSchemaVersion: LEGACY_SKIN_APPEARANCE_STATE_SCHEMA_VERSION,
    status: text(source.status, 'definition.status'),
    productExportApproved: true,
    definitionSha256: sha256(
      source.definitionSha256,
      'definition.definitionSha256'
    ),
    ownership: text(source.ownership, 'definition.ownership'),
    defaultLaw: text(source.defaultLaw, 'definition.defaultLaw'),
    compositionOrder: [...SKIN_APPEARANCE_REGION_IDS],
    runtimeBinding: {
      node: text(runtimeBinding.node, 'definition.runtimeBinding.node'),
      material: text(runtimeBinding.material, 'definition.runtimeBinding.material'),
      baseColorTextureSha256: sha256(
        runtimeBinding.baseColorTextureSha256,
        'definition.runtimeBinding.baseColorTextureSha256'
      )
    },
    canvas: { width, height, colorSpace: 'srgb', flipY: false },
    materialDefaults: {
      color: [1, 1, 1],
      roughness: unit(
        materialDefaults.roughness,
        'definition.materialDefaults.roughness'
      ),
      metalness: unit(
        materialDefaults.metalness,
        'definition.materialDefaults.metalness'
      )
    },
    masks,
    controls,
    defaultTint: [...baseControl.defaultColor]
  }
}

function parseRegionMode(
  value: unknown,
  cheek: boolean,
  context: string
): SkinAppearanceMode | SkinAppearanceCheekMode {
  if (
    value !== 'inherit' &&
    value !== 'custom' &&
    (!cheek || value !== 'off')
  ) {
    fail(`${context} is unsupported`)
  }
  return value
}

function parseSurfaceMode(
  value: unknown,
  role: SkinSurfaceMapRole,
  context: string
): SkinSurfaceBaseColorMode | SkinSurfaceOptionalMode {
  if (
    value !== 'package' &&
    value !== 'custom' &&
    (role === 'baseColor' || value !== 'none')
  ) {
    fail(`${context} is unsupported`)
  }
  return value
}

function parseSurfaceSlot(
  definition: SkinAppearanceDefinitionV1,
  role: SkinSurfaceMapRole,
  value: unknown
) {
  const context = `state.surface.${role}`
  const source = record(value, context)
  exactKeys(
    source,
    role === 'baseColor'
      ? ['mode', 'custom', 'tint']
      : role === 'normal'
        ? ['mode', 'custom', 'strength']
        : ['mode', 'custom'],
    context
  )
  const mode = parseSurfaceMode(source.mode, role, `${context}.mode`)
  const custom =
    source.custom === null
      ? null
      : parseSkinSurfaceUpload(definition, role, source.custom)
  if (mode === 'custom' && !custom) fail(`${context}.custom is required in Custom mode`)
  if (mode !== 'custom' && custom) {
    fail(`${context}.custom must be null outside Custom mode`)
  }
  if (role === 'baseColor') {
    return { mode, custom, tint: rgb(source.tint, `${context}.tint`) }
  }
  if (role === 'normal') {
    return { mode, custom, strength: unit(source.strength, `${context}.strength`) }
  }
  return { mode, custom }
}

export function parseSkinAppearanceState(
  definition: SkinAppearanceDefinitionV1,
  value: unknown
): SkinAppearanceStateV2 {
  const source = record(value, 'state')
  exactKeys(
    source,
    ['schemaVersion', 'definitionSha256', 'surface', 'regions'],
    'state'
  )
  if (source.schemaVersion !== SKIN_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail('state schemaVersion is unsupported')
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('state definitionSha256 does not match this package')
  }

  const surface = record(source.surface, 'state.surface')
  exactKeys(surface, SKIN_SURFACE_MAP_ROLES, 'state.surface')
  const regions = record(source.regions, 'state.regions')
  exactKeys(regions, SKIN_APPEARANCE_REGION_IDS, 'state.regions')
  const parsedRegions = Object.fromEntries(
    SKIN_APPEARANCE_REGION_IDS.map((id) => {
      const region = record(regions[id], `state.regions.${id}`)
      exactKeys(region, ['mode', 'color'], `state.regions.${id}`)
      return [
        id,
        {
          mode: parseRegionMode(
            region.mode,
            id === 'cheekBlush',
            `state.regions.${id}.mode`
          ),
          color: rgb(region.color, `state.regions.${id}.color`)
        }
      ]
    })
  ) as SkinAppearanceStateV2['regions']

  return {
    schemaVersion: SKIN_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    surface: {
      baseColor: parseSurfaceSlot(
        definition,
        'baseColor',
        surface.baseColor
      ) as SkinAppearanceStateV2['surface']['baseColor'],
      normal: parseSurfaceSlot(
        definition,
        'normal',
        surface.normal
      ) as SkinAppearanceStateV2['surface']['normal'],
      roughness: parseSurfaceSlot(
        definition,
        'roughness',
        surface.roughness
      ) as SkinAppearanceStateV2['surface']['roughness'],
      metallic: parseSurfaceSlot(
        definition,
        'metallic',
        surface.metallic
      ) as SkinAppearanceStateV2['surface']['metallic']
    },
    regions: parsedRegions
  }
}

function parseLegacyState(
  definition: SkinAppearanceDefinitionV1,
  value: unknown
): SkinAppearanceStateV1 {
  const source = record(value, 'legacy state')
  exactKeys(source, ['schemaVersion', 'definitionSha256', 'regions'], 'legacy state')
  if (source.schemaVersion !== LEGACY_SKIN_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail('legacy state schemaVersion is unsupported')
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('legacy state definitionSha256 does not match this package')
  }
  const regions = record(source.regions, 'legacy state.regions')
  exactKeys(regions, LEGACY_SKIN_APPEARANCE_REGION_IDS, 'legacy state.regions')
  const parsed = Object.fromEntries(
    LEGACY_SKIN_APPEARANCE_REGION_IDS.map((id) => {
      const region = record(regions[id], `legacy state.regions.${id}`)
      exactKeys(region, ['mode', 'color'], `legacy state.regions.${id}`)
      return [
        id,
        {
          mode: parseRegionMode(
            region.mode,
            id === 'cheekBlush',
            `legacy state.regions.${id}.mode`
          ),
          color: rgb(region.color, `legacy state.regions.${id}.color`)
        }
      ]
    })
  ) as SkinAppearanceStateV1['regions']
  return {
    schemaVersion: LEGACY_SKIN_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    regions: parsed
  }
}

function parseLegacyMaterialArtwork(
  definition: SkinAppearanceDefinitionV1,
  value: unknown
): { upload: SkinSurfaceUploadV1; tint: SkinAppearanceRgb } | null {
  if (!value) return null
  const source = record(value, 'legacy material artwork')
  const legacyV1 = source.schemaVersion === 'skin-material-artwork-state/v1'
  exactKeys(
    source,
    legacyV1
      ? ['schemaVersion', 'definitionSha256', 'baseColor']
      : ['schemaVersion', 'definitionSha256', 'baseColor', 'tint'],
    'legacy material artwork'
  )
  if (
    !legacyV1 &&
    source.schemaVersion !== 'skin-material-artwork-state/v2'
  ) {
    fail('legacy material artwork schemaVersion is unsupported')
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('legacy material artwork definition does not match this package')
  }
  return {
    upload: parseSkinSurfaceUpload(definition, 'baseColor', source.baseColor),
    tint: legacyV1 ? [1, 1, 1] : rgb(source.tint, 'legacy material artwork.tint')
  }
}

export function createDefaultSkinAppearanceState(
  definition: SkinAppearanceDefinitionV1
): SkinAppearanceStateV2 {
  const controls = Object.fromEntries(
    definition.controls.map((control) => [
      control.id,
      { mode: 'inherit', color: [...control.defaultColor] }
    ])
  ) as SkinAppearanceStateV2['regions']
  return {
    schemaVersion: SKIN_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    surface: {
      baseColor: { mode: 'package', custom: null, tint: [1, 1, 1] },
      normal: {
        mode: 'package',
        custom: null,
        strength: DEFAULT_SKIN_NORMAL_STRENGTH
      },
      roughness: { mode: 'package', custom: null },
      metallic: { mode: 'package', custom: null }
    },
    regions: controls
  }
}

export function migrateSkinAppearanceState(
  definition: SkinAppearanceDefinitionV1,
  value: unknown,
  legacyMaterialArtwork?: unknown
): SkinAppearanceStateV2 {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion ===
      SKIN_APPEARANCE_STATE_SCHEMA_VERSION
  ) {
    if (legacyMaterialArtwork) {
      fail('v2 state cannot be combined with a legacy Base Color Artwork sibling')
    }
    return parseSkinAppearanceState(definition, value)
  }

  const migrated = createDefaultSkinAppearanceState(definition)
  if (value) {
    const legacy = parseLegacyState(definition, value)
    if (legacy.regions.baseSkin.mode === 'custom') {
      fail(
        'saved Base Skin used whole-atlas pixel replacement and cannot be represented by Artwork Tint; reset Base Skin before migration'
      )
    }
    migrated.regions = {
      nipplesAreolae: legacy.regions.nipplesAreolae,
      palmsSoles: legacy.regions.palmsSoles,
      cheekBlush: legacy.regions.cheekBlush
    }
  }
  const legacyArtwork = parseLegacyMaterialArtwork(
    definition,
    legacyMaterialArtwork
  )
  if (legacyArtwork) {
    migrated.surface.baseColor = {
      mode: 'custom',
      custom: legacyArtwork.upload,
      tint: legacyArtwork.tint
    }
  }
  return parseSkinAppearanceState(definition, migrated)
}

export function reconcileSkinAppearanceState(
  definition: SkinAppearanceDefinitionV1,
  value: unknown,
  legacyMaterialArtwork?: unknown
): SkinAppearanceReconciliation {
  if (!value && !legacyMaterialArtwork) {
    return { state: null, incompatible: false }
  }
  try {
    return {
      state: migrateSkinAppearanceState(definition, value, legacyMaterialArtwork),
      incompatible: false
    }
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

export function countChangedSkinAppearanceControls(
  definition: SkinAppearanceDefinitionV1,
  value: SkinAppearanceStateV2 | null | undefined
) {
  if (!value) return 0
  const state = parseSkinAppearanceState(definition, value)
  const defaults = createDefaultSkinAppearanceState(definition)
  let changed = 0
  for (const role of SKIN_SURFACE_MAP_ROLES) {
    if (
      JSON.stringify(state.surface[role]) !==
      JSON.stringify(defaults.surface[role])
    ) {
      changed += 1
    }
  }
  changed += SKIN_APPEARANCE_REGION_IDS.filter(
    (id) => state.regions[id].mode !== 'inherit'
  ).length
  return changed
}

export function updateSkinAppearanceRegion(
  definition: SkinAppearanceDefinitionV1,
  value: SkinAppearanceStateV2,
  id: SkinAppearanceRegionId,
  update: { mode?: SkinAppearanceCheekMode; color?: SkinAppearanceRgb }
) {
  return parseSkinAppearanceState(definition, {
    ...value,
    regions: {
      ...value.regions,
      [id]: { ...value.regions[id], ...update }
    }
  })
}

export function updateSkinAppearanceSurface(
  definition: SkinAppearanceDefinitionV1,
  value: SkinAppearanceStateV2,
  role: SkinSurfaceMapRole,
  update: Record<string, unknown>
) {
  return parseSkinAppearanceState(definition, {
    ...value,
    surface: {
      ...value.surface,
      [role]: { ...value.surface[role], ...update }
    }
  })
}

export function setCustomSkinSurfaceUpload(
  definition: SkinAppearanceDefinitionV1,
  value: SkinAppearanceStateV2,
  role: SkinSurfaceMapRole,
  upload: SkinSurfaceUploadV1
) {
  return updateSkinAppearanceSurface(definition, value, role, {
    mode: 'custom',
    custom: upload,
    ...(role === 'baseColor' && value.surface.baseColor.mode !== 'custom'
      ? { tint: [...definition.defaultTint] }
      : {})
  })
}

export function skinAppearanceRgbToHex(value: SkinAppearanceRgb) {
  return `#${value
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

export function skinAppearanceHexToRgb(
  value: string
): SkinAppearanceRgb | null {
  const match = /^#([a-f0-9]{6})$/i.exec(value)
  if (!match) return null
  const channels = [0, 2, 4].map(
    (offset) =>
      Math.round(
        (Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255) *
          COLOR_DECIMAL_SCALE
      ) / COLOR_DECIMAL_SCALE
  )
  return channels as SkinAppearanceRgb
}

export function resolveSkinAppearanceAssetUrl(path: string) {
  if (
    !path.startsWith(PUBLIC_ASSET_PREFIX) ||
    path.includes('\\') ||
    path.split('/').includes('..')
  ) {
    fail('asset path is not a canonical public Skin Appearance asset')
  }
  return `/${path}`
}

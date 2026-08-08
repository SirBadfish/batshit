import type { FacialArtworkProvenance } from './facialArtwork'

export const NAIL_SURFACE_SCHEMA_VERSION = 'nail-surface/v1' as const
export const NAIL_SURFACE_STATE_SCHEMA_VERSION = 'nail-surface-state/v1' as const
export const NAIL_SURFACE_PRESENCE_STATE_SCHEMA_VERSION =
  'nail-surface-presence-state/v1' as const
export const NAIL_ARTWORK_SCHEMA_VERSION = 'nail-artwork/v1' as const

export const NAIL_FAMILIES = ['fingers', 'toes'] as const
export const NAIL_FINISHES = ['natural', 'matte', 'glossy'] as const
export const FINGER_NAIL_SHAPES = ['round', 'soft-square', 'almond', 'pointed'] as const
export const TOE_NAIL_SHAPES = ['round', 'soft-square'] as const

export type NailFamily = (typeof NAIL_FAMILIES)[number]
export type NailFinish = (typeof NAIL_FINISHES)[number]
export type FingerNailShape = (typeof FINGER_NAIL_SHAPES)[number]
export type ToeNailShape = (typeof TOE_NAIL_SHAPES)[number]
export type NailSurfaceRgb = [number, number, number]

export type NailAssetRef = {
  path: string
  sha256: string
}

export type NailArtworkTemplateV1 = {
  id: string
  version: string
  family: NailFamily
  dimensions: [number, number]
  orientation: 'cuticle-bottom-tip-top'
  guide: NailAssetRef
  slotMask: NailAssetRef & {
    channels: 'L8'
    paintThreshold: 1
  }
  baseArtwork: NailAssetRef & {
    law: 'neutral-white-opaque-inside-slots'
  }
  transparentBlank: NailAssetRef
  slotOrder: string[]
  slots: Array<{
    id: string
    orientation: 'cuticle-bottom-tip-top'
    rect: [number, number, number, number]
    zones: {
      tipAnchor: [number, number]
      growth: [number, number]
      cuticleAnchor: [number, number]
    }
  }>
  zoneLaw: {
    cuticleAnchor: [0, 0.22]
    growth: [0.22, 0.78]
    tipAnchor: [0.78, 1]
    lengthBehavior: string
  }
}

export type NailNumberControlDefinition = {
  kind: 'number'
  label: string
  description: string
  minimum: number
  maximum: number
  step: number
  default: number
}

export type NailShapeControlDefinition<T extends string> = {
  kind: 'preset'
  label: string
  default: T
  options: T[]
}

export type NailFamilyControlDefinition<T extends string> = {
  length: NailNumberControlDefinition
  width: NailNumberControlDefinition
  shape: NailShapeControlDefinition<T>
  arch: NailNumberControlDefinition
}

export type NailRuntimeBinding = {
  node: string
  material: string
  targets: Record<string, string>
}

export type NailSurfaceDefinitionV1 = {
  schemaVersion: typeof NAIL_SURFACE_SCHEMA_VERSION
  stateSchemaVersion: typeof NAIL_SURFACE_STATE_SCHEMA_VERSION
  artworkSchemaVersion: typeof NAIL_ARTWORK_SCHEMA_VERSION
  status: string
  productExportApproved: true
  definitionSha256: string
  ownership: string
  defaultLaw: string
  compositionOrder: string[]
  runtimeBindings: Record<NailFamily, NailRuntimeBinding>
  controls: {
    fingers: NailFamilyControlDefinition<FingerNailShape>
    toes: NailFamilyControlDefinition<ToeNailShape>
  }
  materialDefaults: Record<
    NailFamily,
    {
      color: NailSurfaceRgb
      finish: NailFinish
    }
  >
  finishes: Record<
    NailFinish,
    {
      roughness: number
      clearcoat: number
      clearcoatRoughness: number
    }
  >
  templates: Record<NailFamily, NailArtworkTemplateV1>
  geometry: {
    plateCount: 20
    nominalThicknessMeters: number
    freeEdgeTopBevelMeters: 0
    shapeLaw: string
    softSquareLaw: string
    archLaw: string
    archRiseRatio: number
    fingerPositiveGrowthLaw: string
    fingerPositiveGrowthRiseRatio: number
    toeFreeEdgeLaw: string
    toeFreeEdgeStart: number
    toeGrowthAxisY: 0
    toeShortClearanceLaw: string
    toeShortClearanceRatio: number
    toeSurfaceProfileLaw: string
    toeTopEdgeNormalLaw: string
    fingers: {
      plateCount: 10
      archWeights: Record<string, number>
      generatedVertexCount: number
      generatedTriangleCount: number
    }
    toes: {
      plateCount: 10
      archWeights: Record<string, number>
      generatedVertexCount: number
      generatedTriangleCount: number
    }
  }
}

export type NailArtworkUploadV1 = {
  schemaVersion: typeof NAIL_ARTWORK_SCHEMA_VERSION
  family: NailFamily
  url: string
  filename: string
  size: number
  mimeType: 'image/png'
  sha256: string
  definitionSha256: string
  template: {
    id: string
    version: string
    guideSha256: string
    slotMaskSha256: string
    baseArtworkSha256: string
  }
  provenance: FacialArtworkProvenance
}

export type FingerNailGeometryState = {
  length: number
  width: number
  shape: FingerNailShape
  arch: number
}

export type ToeNailGeometryState = {
  length: number
  width: number
  shape: ToeNailShape
  arch: number
}

export type NailAppearanceFamilyState = {
  color: NailSurfaceRgb
  finish: NailFinish
  artwork: NailArtworkUploadV1 | null
}

export type NailSurfaceStateV1 = {
  schemaVersion: typeof NAIL_SURFACE_STATE_SCHEMA_VERSION
  definitionSha256: string
  geometry: {
    fingers: FingerNailGeometryState
    toes: ToeNailGeometryState
  }
  appearance: {
    linked: boolean
    fingers: NailAppearanceFamilyState
    toes: NailAppearanceFamilyState
  }
}

export type NailSurfacePresenceStateV1 = {
  schemaVersion: typeof NAIL_SURFACE_PRESENCE_STATE_SCHEMA_VERSION
  definitionSha256: string
  enabled: boolean
}

export type NailSurfaceReconciliation = {
  state: NailSurfaceStateV1 | null
  incompatible: boolean
  reason?: string
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const PUBLIC_ASSET_PREFIX = 'goons/nail-surface/v1/'
const COLOR_DECIMAL_SCALE = 1_000_000
const EXPECTED_FINGER_TARGET_KEYS = [
  'lengthDecrease',
  'lengthIncrease',
  'widthNarrow',
  'widthWide',
  'shapeSoftSquare',
  'shapeAlmond',
  'shapePointed',
  'arch'
] as const
const EXPECTED_TOE_TARGET_KEYS = [
  'lengthDecrease',
  'lengthIncrease',
  'widthNarrow',
  'widthWide',
  'shapeSoftSquare',
  'arch'
] as const
const EXPECTED_FINGER_SLOTS = [
  'left-thumb',
  'left-index',
  'left-middle',
  'left-ring',
  'left-pinky',
  'right-thumb',
  'right-index',
  'right-middle',
  'right-ring',
  'right-pinky'
] as const
const EXPECTED_TOE_SLOTS = [
  'left-big',
  'left-second',
  'left-third',
  'left-fourth',
  'left-pinky',
  'right-big',
  'right-second',
  'right-third',
  'right-fourth',
  'right-pinky'
] as const
const EXPECTED_FINGER_DIGITS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const
const EXPECTED_TOE_DIGITS = ['big', 'second', 'third', 'fourth', 'pinky'] as const

function fail(message: string): never {
  throw new Error(`[nail-surface/v1] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  const accepted = new Set(allowed)
  const extras = Object.keys(value).filter((key) => !accepted.has(key))
  if (extras.length > 0) fail(`${context} contains unsupported fields: ${extras.join(', ')}`)
  const missing = allowed.filter((key) => !(key in value))
  if (missing.length > 0) fail(`${context} is missing required fields: ${missing.join(', ')}`)
}

function text(value: unknown, context: string) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function finite(value: unknown, context: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function integer(value: unknown, context: string) {
  if (!Number.isSafeInteger(value)) fail(`${context} must be an integer`)
  return value as number
}

function positiveInteger(value: unknown, context: string) {
  const parsed = integer(value, context)
  if (parsed < 1) fail(`${context} must be positive`)
  return parsed
}

function sha256(value: unknown, context: string) {
  const parsed = text(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function unit(value: unknown, context: string) {
  const parsed = finite(value, context)
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`)
  return parsed
}

function stableColorUnit(value: unknown, context: string) {
  return Math.round(unit(value, context) * COLOR_DECIMAL_SCALE) / COLOR_DECIMAL_SCALE
}

function rgb(value: unknown, context: string): NailSurfaceRgb {
  if (!Array.isArray(value) || value.length !== 3) fail(`${context} must have three channels`)
  return value.map((channel, index) =>
    stableColorUnit(channel, `${context}[${index}]`)
  ) as NailSurfaceRgb
}

function stringList(value: unknown, context: string) {
  if (!Array.isArray(value) || value.length === 0) fail(`${context} must be a non-empty array`)
  const values = value.map((entry, index) => text(entry, `${context}[${index}]`))
  if (new Set(values).size !== values.length) fail(`${context} contains duplicates`)
  return values
}

function exactStringList(
  value: unknown,
  expected: readonly string[],
  context: string
): string[] {
  const values = stringList(value, context)
  if (
    values.length !== expected.length ||
    values.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${context} must be ${expected.join(', ')} in canonical order`)
  }
  return values
}

function exactNumberPair(
  value: unknown,
  expected: readonly [number, number],
  context: string
): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail(`${context} must contain two numbers`)
  const pair = [
    finite(value[0], `${context}[0]`),
    finite(value[1], `${context}[1]`)
  ] as [number, number]
  if (pair[0] !== expected[0] || pair[1] !== expected[1]) {
    fail(`${context} must be [${expected.join(', ')}]`)
  }
  return pair
}

function asset(
  value: unknown,
  context: string,
  extras: readonly string[] = []
): NailAssetRef & Record<string, unknown> {
  const source = record(value, context)
  exactKeys(source, ['path', 'sha256', ...extras], context)
  const path = text(source.path, `${context}.path`)
  if (
    !path.startsWith(PUBLIC_ASSET_PREFIX) ||
    path.includes('\\') ||
    path.split('/').includes('..')
  ) {
    fail(`${context}.path must be a public Nail Surface asset`)
  }
  return {
    ...source,
    path,
    sha256: sha256(source.sha256, `${context}.sha256`)
  }
}

function parseBinding(
  value: unknown,
  family: NailFamily
): NailRuntimeBinding {
  const source = record(value, `definition.runtimeBindings.${family}`)
  exactKeys(source, ['node', 'material', 'targets'], `definition.runtimeBindings.${family}`)
  const targetSource = record(source.targets, `definition.runtimeBindings.${family}.targets`)
  const expected =
    family === 'fingers' ? EXPECTED_FINGER_TARGET_KEYS : EXPECTED_TOE_TARGET_KEYS
  exactKeys(targetSource, expected, `definition.runtimeBindings.${family}.targets`)
  const targets = Object.fromEntries(
    expected.map((key) => [
      key,
      text(targetSource[key], `definition.runtimeBindings.${family}.targets.${key}`)
    ])
  )
  if (new Set(Object.values(targets)).size !== expected.length) {
    fail(`definition.runtimeBindings.${family}.targets contains duplicate morphs`)
  }
  return {
    node: text(source.node, `definition.runtimeBindings.${family}.node`),
    material: text(source.material, `definition.runtimeBindings.${family}.material`),
    targets
  }
}

function parseNumberControl(value: unknown, context: string): NailNumberControlDefinition {
  const source = record(value, context)
  exactKeys(
    source,
    ['kind', 'label', 'description', 'minimum', 'maximum', 'step', 'default'],
    context
  )
  if (source.kind !== 'number') fail(`${context}.kind must be number`)
  const minimum = finite(source.minimum, `${context}.minimum`)
  const maximum = finite(source.maximum, `${context}.maximum`)
  const step = finite(source.step, `${context}.step`)
  const defaultValue = finite(source.default, `${context}.default`)
  if (minimum !== -1 && minimum !== 0) fail(`${context}.minimum must be -1 or 0`)
  if (maximum !== 1 || step !== 0.01 || defaultValue !== 0) {
    fail(`${context} must use the canonical maximum, step, and default`)
  }
  return {
    kind: 'number',
    label: text(source.label, `${context}.label`),
    description: text(source.description, `${context}.description`),
    minimum,
    maximum,
    step,
    default: defaultValue
  }
}

function parseControls(value: unknown): NailSurfaceDefinitionV1['controls'] {
  const source = record(value, 'definition.controls')
  exactKeys(source, NAIL_FAMILIES, 'definition.controls')

  const parseFamily = <T extends string>(
    family: NailFamily,
    expectedShapes: readonly T[]
  ): NailFamilyControlDefinition<T> => {
    const familySource = record(source[family], `definition.controls.${family}`)
    exactKeys(
      familySource,
      ['length', 'width', 'shape', 'arch'],
      `definition.controls.${family}`
    )
    const shapeSource = record(
      familySource.shape,
      `definition.controls.${family}.shape`
    )
    exactKeys(
      shapeSource,
      ['kind', 'label', 'default', 'options'],
      `definition.controls.${family}.shape`
    )
    if (shapeSource.kind !== 'preset') {
      fail(`definition.controls.${family}.shape.kind must be preset`)
    }
    const options = exactStringList(
      shapeSource.options,
      expectedShapes,
      `definition.controls.${family}.shape.options`
    ) as T[]
    if (shapeSource.default !== 'round') {
      fail(`definition.controls.${family}.shape.default must be round`)
    }
    return {
      length: parseNumberControl(
        familySource.length,
        `definition.controls.${family}.length`
      ),
      width: parseNumberControl(
        familySource.width,
        `definition.controls.${family}.width`
      ),
      shape: {
        kind: 'preset',
        label: text(
          shapeSource.label,
          `definition.controls.${family}.shape.label`
        ),
        default: 'round' as T,
        options
      },
      arch: parseNumberControl(
        familySource.arch,
        `definition.controls.${family}.arch`
      )
    }
  }

  const fingers = parseFamily('fingers', FINGER_NAIL_SHAPES)
  const toes = parseFamily('toes', TOE_NAIL_SHAPES)
  if (fingers.arch.minimum !== 0) {
    fail('finger Arch must start at zero')
  }
  if (toes.arch.minimum !== 0) {
    fail('toe Arch must start at zero')
  }
  if (
    fingers.length.minimum !== -1 ||
    fingers.width.minimum !== -1 ||
    toes.length.minimum !== -1 ||
    toes.width.minimum !== -1
  ) {
    fail('Length and Width must expose signed canonical ranges')
  }
  return { fingers, toes }
}

function parseFinish(
  value: unknown,
  finish: NailFinish
): NailSurfaceDefinitionV1['finishes'][NailFinish] {
  const source = record(value, `definition.finishes.${finish}`)
  exactKeys(
    source,
    ['roughness', 'clearcoat', 'clearcoatRoughness'],
    `definition.finishes.${finish}`
  )
  return {
    roughness: unit(source.roughness, `definition.finishes.${finish}.roughness`),
    clearcoat: unit(source.clearcoat, `definition.finishes.${finish}.clearcoat`),
    clearcoatRoughness: unit(
      source.clearcoatRoughness,
      `definition.finishes.${finish}.clearcoatRoughness`
    )
  }
}

function parseTemplate(value: unknown, family: NailFamily): NailArtworkTemplateV1 {
  const context = `definition.templates.${family}`
  const source = record(value, context)
  exactKeys(
    source,
    [
      'id',
      'version',
      'family',
      'dimensions',
      'orientation',
      'guide',
      'slotMask',
      'baseArtwork',
      'transparentBlank',
      'slotOrder',
      'slots',
      'zoneLaw'
    ],
    context
  )
  if (source.family !== family) fail(`${context}.family must be ${family}`)
  if (source.orientation !== 'cuticle-bottom-tip-top') {
    fail(`${context}.orientation is unsupported`)
  }
  if (!Array.isArray(source.dimensions) || source.dimensions.length !== 2) {
    fail(`${context}.dimensions must contain width and height`)
  }
  const dimensions = [
    positiveInteger(source.dimensions[0], `${context}.dimensions[0]`),
    positiveInteger(source.dimensions[1], `${context}.dimensions[1]`)
  ] as [number, number]
  if (dimensions[0] !== dimensions[1] || dimensions[0] !== 2048) {
    fail(`${context}.dimensions must be the measured 2048px square atlas`)
  }
  const expectedSlots =
    family === 'fingers' ? EXPECTED_FINGER_SLOTS : EXPECTED_TOE_SLOTS
  const slotOrder = exactStringList(source.slotOrder, expectedSlots, `${context}.slotOrder`)
  if (!Array.isArray(source.slots) || source.slots.length !== 10) {
    fail(`${context}.slots must contain ten entries`)
  }
  const slots = source.slots.map((entry, index) => {
    const slotContext = `${context}.slots[${index}]`
    const slot = record(entry, slotContext)
    exactKeys(slot, ['id', 'orientation', 'rect', 'zones'], slotContext)
    if (slot.id !== expectedSlots[index]) {
      fail(`${slotContext}.id must be ${expectedSlots[index]}`)
    }
    if (slot.orientation !== 'cuticle-bottom-tip-top') {
      fail(`${slotContext}.orientation is unsupported`)
    }
    if (!Array.isArray(slot.rect) || slot.rect.length !== 4) {
      fail(`${slotContext}.rect must contain four pixel bounds`)
    }
    const rect = slot.rect.map((coordinate, coordinateIndex) =>
      integer(coordinate, `${slotContext}.rect[${coordinateIndex}]`)
    ) as [number, number, number, number]
    if (
      rect[0] < 0 ||
      rect[1] < 0 ||
      rect[2] > dimensions[0] ||
      rect[3] > dimensions[1] ||
      rect[0] >= rect[2] ||
      rect[1] >= rect[3]
    ) {
      fail(`${slotContext}.rect is outside the atlas`)
    }
    const zones = record(slot.zones, `${slotContext}.zones`)
    exactKeys(zones, ['tipAnchor', 'growth', 'cuticleAnchor'], `${slotContext}.zones`)
    const zone = (key: 'tipAnchor' | 'growth' | 'cuticleAnchor') => {
      const raw = zones[key]
      if (!Array.isArray(raw) || raw.length !== 2) {
        fail(`${slotContext}.zones.${key} must contain two pixel rows`)
      }
      return [
        integer(raw[0], `${slotContext}.zones.${key}[0]`),
        integer(raw[1], `${slotContext}.zones.${key}[1]`)
      ] as [number, number]
    }
    const parsedZones = {
      tipAnchor: zone('tipAnchor'),
      growth: zone('growth'),
      cuticleAnchor: zone('cuticleAnchor')
    }
    if (
      parsedZones.tipAnchor[0] !== rect[1] ||
      parsedZones.tipAnchor[1] !== parsedZones.growth[0] ||
      parsedZones.growth[1] !== parsedZones.cuticleAnchor[0] ||
      parsedZones.cuticleAnchor[1] !== rect[3]
    ) {
      fail(`${slotContext}.zones do not partition the slot`)
    }
    return {
      id: expectedSlots[index],
      orientation: 'cuticle-bottom-tip-top' as const,
      rect,
      zones: parsedZones
    }
  })
  const slotMask = asset(source.slotMask, `${context}.slotMask`, [
    'channels',
    'paintThreshold'
  ])
  if (slotMask.channels !== 'L8' || slotMask.paintThreshold !== 1) {
    fail(`${context}.slotMask must use L8 with paintThreshold 1`)
  }
  const baseArtwork = asset(source.baseArtwork, `${context}.baseArtwork`, ['law'])
  if (baseArtwork.law !== 'neutral-white-opaque-inside-slots') {
    fail(`${context}.baseArtwork law is unsupported`)
  }
  const zoneLaw = record(source.zoneLaw, `${context}.zoneLaw`)
  exactKeys(
    zoneLaw,
    ['cuticleAnchor', 'growth', 'tipAnchor', 'lengthBehavior'],
    `${context}.zoneLaw`
  )
  return {
    id: text(source.id, `${context}.id`),
    version: text(source.version, `${context}.version`),
    family,
    dimensions,
    orientation: 'cuticle-bottom-tip-top',
    guide: asset(source.guide, `${context}.guide`),
    slotMask: {
      path: slotMask.path,
      sha256: slotMask.sha256,
      channels: 'L8',
      paintThreshold: 1
    },
    baseArtwork: {
      path: baseArtwork.path,
      sha256: baseArtwork.sha256,
      law: 'neutral-white-opaque-inside-slots'
    },
    transparentBlank: asset(source.transparentBlank, `${context}.transparentBlank`),
    slotOrder,
    slots,
    zoneLaw: {
      cuticleAnchor: exactNumberPair(
        zoneLaw.cuticleAnchor,
        [0, 0.22],
        `${context}.zoneLaw.cuticleAnchor`
      ) as [0, 0.22],
      growth: exactNumberPair(
        zoneLaw.growth,
        [0.22, 0.78],
        `${context}.zoneLaw.growth`
      ) as [0.22, 0.78],
      tipAnchor: exactNumberPair(
        zoneLaw.tipAnchor,
        [0.78, 1],
        `${context}.zoneLaw.tipAnchor`
      ) as [0.78, 1],
      lengthBehavior: text(zoneLaw.lengthBehavior, `${context}.zoneLaw.lengthBehavior`)
    }
  }
}

function parseDigitWeights(
  value: unknown,
  digits: readonly string[],
  context: string
) {
  const source = record(value, context)
  exactKeys(source, digits, context)
  return Object.fromEntries(
    digits.map((digit) => [digit, unit(source[digit], `${context}.${digit}`)])
  )
}

function parseGeometry(value: unknown): NailSurfaceDefinitionV1['geometry'] {
  const source = record(value, 'definition.geometry')
  exactKeys(
    source,
    [
      'plateCount',
      'nominalThicknessMeters',
      'freeEdgeTopBevelMeters',
      'shapeLaw',
      'softSquareLaw',
      'archLaw',
      'archRiseRatio',
      'fingerPositiveGrowthLaw',
      'fingerPositiveGrowthRiseRatio',
      'toeFreeEdgeLaw',
      'toeFreeEdgeStart',
      'toeGrowthAxisY',
      'toeShortClearanceLaw',
      'toeShortClearanceRatio',
      'toeSurfaceProfileLaw',
      'toeTopEdgeNormalLaw',
      'fingers',
      'toes'
    ],
    'definition.geometry'
  )
  if (source.plateCount !== 20) fail('definition.geometry.plateCount must be 20')
  const thickness = finite(
    source.nominalThicknessMeters,
    'definition.geometry.nominalThicknessMeters'
  )
  if (thickness <= 0 || thickness > 0.001) {
    fail('definition.geometry.nominalThicknessMeters is outside the authored safety range')
  }
  if (source.freeEdgeTopBevelMeters !== 0) {
    fail('definition.geometry.freeEdgeTopBevelMeters must be exactly zero')
  }
  const parseFamily = (
    family: NailFamily,
    digits: readonly string[]
  ): NailSurfaceDefinitionV1['geometry'][NailFamily] => {
    const familySource = record(source[family], `definition.geometry.${family}`)
    exactKeys(
      familySource,
      [
        'plateCount',
        'archWeights',
        'generatedVertexCount',
        'generatedTriangleCount'
      ],
      `definition.geometry.${family}`
    )
    if (familySource.plateCount !== 10) {
      fail(`definition.geometry.${family}.plateCount must be 10`)
    }
    return {
      plateCount: 10,
      archWeights: parseDigitWeights(
        familySource.archWeights,
        digits,
        `definition.geometry.${family}.archWeights`
      ),
      generatedVertexCount: positiveInteger(
        familySource.generatedVertexCount,
        `definition.geometry.${family}.generatedVertexCount`
      ),
      generatedTriangleCount: positiveInteger(
        familySource.generatedTriangleCount,
        `definition.geometry.${family}.generatedTriangleCount`
      )
    }
  }
  const fingers = parseFamily('fingers', EXPECTED_FINGER_DIGITS)
  const toes = parseFamily('toes', EXPECTED_TOE_DIGITS)
  if (toes.archWeights.pinky !== 0) {
    fail('pinky toenail Arch weight must be exactly zero')
  }
  const archRiseRatio = finite(
    source.archRiseRatio,
    'definition.geometry.archRiseRatio'
  )
  if (archRiseRatio <= 0 || archRiseRatio > 0.5) {
    fail('definition.geometry.archRiseRatio is outside the authored safety range')
  }
  const toeFreeEdgeStart = finite(
    source.toeFreeEdgeStart,
    'definition.geometry.toeFreeEdgeStart'
  )
  if (toeFreeEdgeStart < 0.5 || toeFreeEdgeStart > 0.85) {
    fail('definition.geometry.toeFreeEdgeStart is outside the authored safety range')
  }
  if (source.toeGrowthAxisY !== 0) {
    fail('definition.geometry.toeGrowthAxisY must be exactly zero')
  }
  const fingerPositiveGrowthRiseRatio = finite(
    source.fingerPositiveGrowthRiseRatio,
    'definition.geometry.fingerPositiveGrowthRiseRatio'
  )
  if (fingerPositiveGrowthRiseRatio <= 0 || fingerPositiveGrowthRiseRatio > 0.35) {
    fail('definition.geometry.fingerPositiveGrowthRiseRatio is outside the authored safety range')
  }
  const toeShortClearanceRatio = finite(
    source.toeShortClearanceRatio,
    'definition.geometry.toeShortClearanceRatio'
  )
  if (toeShortClearanceRatio <= 0 || toeShortClearanceRatio > 0.4) {
    fail('definition.geometry.toeShortClearanceRatio is outside the authored safety range')
  }
  return {
    plateCount: 20,
    nominalThicknessMeters: thickness,
    freeEdgeTopBevelMeters: 0,
    shapeLaw: text(source.shapeLaw, 'definition.geometry.shapeLaw'),
    softSquareLaw: text(source.softSquareLaw, 'definition.geometry.softSquareLaw'),
    archLaw: text(source.archLaw, 'definition.geometry.archLaw'),
    archRiseRatio,
    fingerPositiveGrowthLaw: text(
      source.fingerPositiveGrowthLaw,
      'definition.geometry.fingerPositiveGrowthLaw'
    ),
    fingerPositiveGrowthRiseRatio,
    toeFreeEdgeLaw: text(source.toeFreeEdgeLaw, 'definition.geometry.toeFreeEdgeLaw'),
    toeFreeEdgeStart,
    toeGrowthAxisY: 0,
    toeShortClearanceLaw: text(
      source.toeShortClearanceLaw,
      'definition.geometry.toeShortClearanceLaw'
    ),
    toeShortClearanceRatio,
    toeSurfaceProfileLaw: text(
      source.toeSurfaceProfileLaw,
      'definition.geometry.toeSurfaceProfileLaw'
    ),
    toeTopEdgeNormalLaw: text(
      source.toeTopEdgeNormalLaw,
      'definition.geometry.toeTopEdgeNormalLaw'
    ),
    fingers,
    toes
  }
}

export function parseNailSurfaceDefinition(value: unknown): NailSurfaceDefinitionV1 {
  const source = record(value, 'definition')
  exactKeys(
    source,
    [
      'schemaVersion',
      'stateSchemaVersion',
      'artworkSchemaVersion',
      'status',
      'productExportApproved',
      'definitionSha256',
      'ownership',
      'defaultLaw',
      'compositionOrder',
      'runtimeBindings',
      'controls',
      'materialDefaults',
      'finishes',
      'templates',
      'geometry'
    ],
    'definition'
  )
  if (source.schemaVersion !== NAIL_SURFACE_SCHEMA_VERSION) {
    fail('definition schemaVersion is unsupported')
  }
  if (source.stateSchemaVersion !== NAIL_SURFACE_STATE_SCHEMA_VERSION) {
    fail('definition stateSchemaVersion is unsupported')
  }
  if (source.artworkSchemaVersion !== NAIL_ARTWORK_SCHEMA_VERSION) {
    fail('definition artworkSchemaVersion is unsupported')
  }
  if (source.productExportApproved !== true) {
    fail('definition productExportApproved must be true')
  }
  const bindings = record(source.runtimeBindings, 'definition.runtimeBindings')
  exactKeys(bindings, NAIL_FAMILIES, 'definition.runtimeBindings')
  const runtimeBindings = {
    fingers: parseBinding(bindings.fingers, 'fingers'),
    toes: parseBinding(bindings.toes, 'toes')
  }
  if (
    runtimeBindings.fingers.node === runtimeBindings.toes.node ||
    runtimeBindings.fingers.material === runtimeBindings.toes.material
  ) {
    fail('finger and toe runtime bindings must be independent')
  }
  const defaults = record(source.materialDefaults, 'definition.materialDefaults')
  exactKeys(defaults, NAIL_FAMILIES, 'definition.materialDefaults')
  const materialDefaults = Object.fromEntries(
    NAIL_FAMILIES.map((family) => {
      const familySource = record(
        defaults[family],
        `definition.materialDefaults.${family}`
      )
      exactKeys(
        familySource,
        ['color', 'finish'],
        `definition.materialDefaults.${family}`
      )
      if (!NAIL_FINISHES.includes(familySource.finish as NailFinish)) {
        fail(`definition.materialDefaults.${family}.finish is unsupported`)
      }
      return [
        family,
        {
          color: rgb(
            familySource.color,
            `definition.materialDefaults.${family}.color`
          ),
          finish: familySource.finish as NailFinish
        }
      ]
    })
  ) as NailSurfaceDefinitionV1['materialDefaults']
  const finishesSource = record(source.finishes, 'definition.finishes')
  exactKeys(finishesSource, NAIL_FINISHES, 'definition.finishes')
  const finishes = Object.fromEntries(
    NAIL_FINISHES.map((finish) => [
      finish,
      parseFinish(finishesSource[finish], finish)
    ])
  ) as NailSurfaceDefinitionV1['finishes']
  if (
    !(finishes.matte.roughness > finishes.natural.roughness) ||
    !(finishes.glossy.roughness < finishes.natural.roughness) ||
    !(finishes.glossy.clearcoat > finishes.natural.clearcoat)
  ) {
    fail('definition finish presets do not preserve Matte/Natural/Glossy ordering')
  }
  const templatesSource = record(source.templates, 'definition.templates')
  exactKeys(templatesSource, NAIL_FAMILIES, 'definition.templates')
  return {
    schemaVersion: NAIL_SURFACE_SCHEMA_VERSION,
    stateSchemaVersion: NAIL_SURFACE_STATE_SCHEMA_VERSION,
    artworkSchemaVersion: NAIL_ARTWORK_SCHEMA_VERSION,
    status: text(source.status, 'definition.status'),
    productExportApproved: true,
    definitionSha256: sha256(source.definitionSha256, 'definition.definitionSha256'),
    ownership: text(source.ownership, 'definition.ownership'),
    defaultLaw: text(source.defaultLaw, 'definition.defaultLaw'),
    compositionOrder: stringList(source.compositionOrder, 'definition.compositionOrder'),
    runtimeBindings,
    controls: parseControls(source.controls),
    materialDefaults,
    finishes,
    templates: {
      fingers: parseTemplate(templatesSource.fingers, 'fingers'),
      toes: parseTemplate(templatesSource.toes, 'toes')
    },
    geometry: parseGeometry(source.geometry)
  }
}

function parseProvenance(
  value: unknown,
  context: string
): FacialArtworkProvenance {
  const source = record(value, context)
  exactKeys(source, ['sourceKind', 'author', 'license', 'rightsConfirmed'], context)
  if (
    source.sourceKind !== 'batshit-original' &&
    source.sourceKind !== 'user-authored' &&
    source.sourceKind !== 'comfyui-generated' &&
    source.sourceKind !== 'approved-external'
  ) {
    fail(`${context}.sourceKind is unsupported`)
  }
  if (source.rightsConfirmed !== true) {
    fail(`${context}.rightsConfirmed must be true`)
  }
  return {
    sourceKind: source.sourceKind,
    author: text(source.author, `${context}.author`),
    license: text(source.license, `${context}.license`),
    rightsConfirmed: true
  }
}

function parseArtwork(
  definition: NailSurfaceDefinitionV1,
  family: NailFamily,
  value: unknown
): NailArtworkUploadV1 | null {
  if (value === null) return null
  const context = `state.appearance.${family}.artwork`
  const source = record(value, context)
  exactKeys(
    source,
    [
      'schemaVersion',
      'family',
      'url',
      'filename',
      'size',
      'mimeType',
      'sha256',
      'definitionSha256',
      'template',
      'provenance'
    ],
    context
  )
  if (source.schemaVersion !== NAIL_ARTWORK_SCHEMA_VERSION) {
    fail(`${context}.schemaVersion is unsupported`)
  }
  if (source.family !== family) fail(`${context}.family must be ${family}`)
  if (source.mimeType !== 'image/png') fail(`${context}.mimeType must be image/png`)
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail(`${context}.definitionSha256 does not match this package`)
  }
  const filename = text(source.filename, `${context}.filename`)
  if (filename.includes('/') || filename.includes('\\')) {
    fail(`${context}.filename is invalid`)
  }
  const expected = definition.templates[family]
  const template = record(source.template, `${context}.template`)
  exactKeys(
    template,
    ['id', 'version', 'guideSha256', 'slotMaskSha256', 'baseArtworkSha256'],
    `${context}.template`
  )
  if (
    template.id !== expected.id ||
    template.version !== expected.version ||
    template.guideSha256 !== expected.guide.sha256 ||
    template.slotMaskSha256 !== expected.slotMask.sha256 ||
    template.baseArtworkSha256 !== expected.baseArtwork.sha256
  ) {
    fail(`${context}.template proof does not match this package`)
  }
  return {
    schemaVersion: NAIL_ARTWORK_SCHEMA_VERSION,
    family,
    url: text(source.url, `${context}.url`),
    filename,
    size: positiveInteger(source.size, `${context}.size`),
    mimeType: 'image/png',
    sha256: sha256(source.sha256, `${context}.sha256`),
    definitionSha256: definition.definitionSha256,
    template: {
      id: expected.id,
      version: expected.version,
      guideSha256: expected.guide.sha256,
      slotMaskSha256: expected.slotMask.sha256,
      baseArtworkSha256: expected.baseArtwork.sha256
    },
    provenance: parseProvenance(source.provenance, `${context}.provenance`)
  }
}

function boundedControl(
  control: NailNumberControlDefinition,
  value: unknown,
  context: string
) {
  const parsed = finite(value, context)
  if (parsed < control.minimum || parsed > control.maximum) {
    fail(`${context} must be inside [${control.minimum}, ${control.maximum}]`)
  }
  const steps = (parsed - control.minimum) / control.step
  const tolerance = Math.max(1, Math.abs(steps)) * Number.EPSILON * 64
  if (Math.abs(steps - Math.round(steps)) > tolerance) {
    fail(`${context} must use the ${control.step} step lattice`)
  }
  return parsed
}

function parseGeometryFamily<T extends string>(
  value: unknown,
  definition: NailFamilyControlDefinition<T>,
  context: string
): {
  length: number
  width: number
  shape: T
  arch: number
} {
  const source = record(value, context)
  exactKeys(source, ['length', 'width', 'shape', 'arch'], context)
  if (!definition.shape.options.includes(source.shape as T)) {
    fail(`${context}.shape is unsupported`)
  }
  return {
    length: boundedControl(definition.length, source.length, `${context}.length`),
    width: boundedControl(definition.width, source.width, `${context}.width`),
    shape: source.shape as T,
    arch: boundedControl(definition.arch, source.arch, `${context}.arch`)
  }
}

function parseAppearanceFamily(
  definition: NailSurfaceDefinitionV1,
  family: NailFamily,
  value: unknown
): NailAppearanceFamilyState {
  const context = `state.appearance.${family}`
  const source = record(value, context)
  exactKeys(source, ['color', 'finish', 'artwork'], context)
  if (!NAIL_FINISHES.includes(source.finish as NailFinish)) {
    fail(`${context}.finish is unsupported`)
  }
  return {
    color: rgb(source.color, `${context}.color`),
    finish: source.finish as NailFinish,
    artwork: parseArtwork(definition, family, source.artwork)
  }
}

function sameRgb(left: NailSurfaceRgb, right: NailSurfaceRgb) {
  return left.every((channel, index) => channel === right[index])
}

export function parseNailSurfaceState(
  definition: NailSurfaceDefinitionV1,
  value: unknown
): NailSurfaceStateV1 {
  const source = record(value, 'state')
  exactKeys(source, ['schemaVersion', 'definitionSha256', 'geometry', 'appearance'], 'state')
  if (source.schemaVersion !== NAIL_SURFACE_STATE_SCHEMA_VERSION) {
    fail('state schemaVersion is unsupported')
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('state definitionSha256 does not match this package')
  }
  const geometry = record(source.geometry, 'state.geometry')
  exactKeys(geometry, NAIL_FAMILIES, 'state.geometry')
  const appearance = record(source.appearance, 'state.appearance')
  exactKeys(appearance, ['linked', 'fingers', 'toes'], 'state.appearance')
  if (typeof appearance.linked !== 'boolean') {
    fail('state.appearance.linked must be boolean')
  }
  const fingers = parseAppearanceFamily(definition, 'fingers', appearance.fingers)
  const toes = parseAppearanceFamily(definition, 'toes', appearance.toes)
  if (
    appearance.linked &&
    (!sameRgb(fingers.color, toes.color) || fingers.finish !== toes.finish)
  ) {
    fail('linked finger/toe appearance must use the same color and finish')
  }
  return {
    schemaVersion: NAIL_SURFACE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    geometry: {
      fingers: parseGeometryFamily(
        geometry.fingers,
        definition.controls.fingers,
        'state.geometry.fingers'
      ),
      toes: parseGeometryFamily(
        geometry.toes,
        definition.controls.toes,
        'state.geometry.toes'
      )
    },
    appearance: {
      linked: appearance.linked,
      fingers,
      toes
    }
  }
}

function cloneRgb(value: NailSurfaceRgb): NailSurfaceRgb {
  return [...value] as NailSurfaceRgb
}

export function createDefaultNailSurfaceState(
  definition: NailSurfaceDefinitionV1
): NailSurfaceStateV1 {
  return {
    schemaVersion: NAIL_SURFACE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    geometry: {
      fingers: {
        length: definition.controls.fingers.length.default,
        width: definition.controls.fingers.width.default,
        shape: definition.controls.fingers.shape.default,
        arch: definition.controls.fingers.arch.default
      },
      toes: {
        length: definition.controls.toes.length.default,
        width: definition.controls.toes.width.default,
        shape: definition.controls.toes.shape.default,
        arch: definition.controls.toes.arch.default
      }
    },
    appearance: {
      linked: true,
      fingers: {
        color: cloneRgb(definition.materialDefaults.fingers.color),
        finish: definition.materialDefaults.fingers.finish,
        artwork: null
      },
      toes: {
        color: cloneRgb(definition.materialDefaults.fingers.color),
        finish: definition.materialDefaults.fingers.finish,
        artwork: null
      }
    }
  }
}

export function resolveNailSurfaceState(
  definition: NailSurfaceDefinitionV1,
  value: NailSurfaceStateV1 | null | undefined
) {
  return value
    ? parseNailSurfaceState(definition, value)
    : createDefaultNailSurfaceState(definition)
}

export function reconcileNailSurfaceState(
  definition: NailSurfaceDefinitionV1,
  value: unknown
): NailSurfaceReconciliation {
  if (value == null) return { state: null, incompatible: false }
  try {
    return {
      state: parseNailSurfaceState(definition, value),
      incompatible: false
    }
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason: error instanceof Error ? error.message : 'Nail Surface state is incompatible.'
    }
  }
}

export function parseNailSurfacePresenceState(
  definition: NailSurfaceDefinitionV1,
  value: unknown
): NailSurfacePresenceStateV1 {
  const source = record(value, 'presence')
  exactKeys(source, ['schemaVersion', 'definitionSha256', 'enabled'], 'presence')
  if (source.schemaVersion !== NAIL_SURFACE_PRESENCE_STATE_SCHEMA_VERSION) {
    fail('presence schemaVersion is unsupported')
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('presence definitionSha256 does not match this package')
  }
  if (typeof source.enabled !== 'boolean') {
    fail('presence.enabled must be boolean')
  }
  return {
    schemaVersion: NAIL_SURFACE_PRESENCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    enabled: source.enabled
  }
}

export function createNailSurfacePresenceState(
  definition: NailSurfaceDefinitionV1,
  enabled: boolean
): NailSurfacePresenceStateV1 {
  return parseNailSurfacePresenceState(definition, {
    schemaVersion: NAIL_SURFACE_PRESENCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    enabled
  })
}

export function nailSurfaceRgbToHex(value: NailSurfaceRgb) {
  return `#${value
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

export function nailSurfaceHexToRgb(value: string): NailSurfaceRgb | null {
  if (!/^#[a-f0-9]{6}$/i.test(value)) return null
  return [1, 3, 5].map(
    (offset) =>
      Math.round(
        (Number.parseInt(value.slice(offset, offset + 2), 16) / 255) *
          COLOR_DECIMAL_SCALE
      ) / COLOR_DECIMAL_SCALE
  ) as NailSurfaceRgb
}

export function countChangedNailSurfaceControls(
  definition: NailSurfaceDefinitionV1,
  value: NailSurfaceStateV1
) {
  const state = parseNailSurfaceState(definition, value)
  const defaults = createDefaultNailSurfaceState(definition)
  return [
    state.geometry.fingers.length !== defaults.geometry.fingers.length,
    state.geometry.fingers.width !== defaults.geometry.fingers.width,
    state.geometry.fingers.shape !== defaults.geometry.fingers.shape,
    state.geometry.fingers.arch !== defaults.geometry.fingers.arch,
    state.geometry.toes.length !== defaults.geometry.toes.length,
    state.geometry.toes.width !== defaults.geometry.toes.width,
    state.geometry.toes.shape !== defaults.geometry.toes.shape,
    state.geometry.toes.arch !== defaults.geometry.toes.arch,
    !sameRgb(state.appearance.fingers.color, defaults.appearance.fingers.color),
    state.appearance.fingers.finish !== defaults.appearance.fingers.finish,
    state.appearance.fingers.artwork !== null,
    !sameRgb(state.appearance.toes.color, defaults.appearance.toes.color),
    state.appearance.toes.finish !== defaults.appearance.toes.finish,
    state.appearance.toes.artwork !== null,
    state.appearance.linked !== defaults.appearance.linked
  ].filter(Boolean).length
}

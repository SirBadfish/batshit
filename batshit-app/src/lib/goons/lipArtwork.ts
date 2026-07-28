import type { FacialArtworkProvenance } from './facialArtwork'

export const LIP_ARTWORK_SCHEMA_VERSION = 'lip-artwork/v2' as const
export const LIP_ARTWORK_STATE_SCHEMA_VERSION = 'lip-artwork-state/v2' as const

export type LipArtworkRgb = [number, number, number]

export type LipArtworkAssetRef = {
  path: string
  sha256: string
}

export type LipArtworkTemplateV2 = {
  id: string
  version: string
  dimensions: [number, number]
  guide: LipArtworkAssetRef
  safePaintMask: LipArtworkAssetRef & { channels: 'L8'; paintThreshold: 1 }
  baseLipReferenceMask: LipArtworkAssetRef & { channels: 'L8' }
  transparentBlank: LipArtworkAssetRef
}

export type LipArtworkDefinitionV2 = {
  schemaVersion: typeof LIP_ARTWORK_SCHEMA_VERSION
  stateSchemaVersion: typeof LIP_ARTWORK_STATE_SCHEMA_VERSION
  status: string
  productExportApproved: true
  definitionSha256: string
  ownership: string
  defaultLaw: string
  runtimeBinding: {
    node: string
    material: string
  }
  template: LipArtworkTemplateV2
}

export type LipArtworkUpload = {
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
    maskSha256: string
    baseLipReferenceMaskSha256: string
  }
  provenance: FacialArtworkProvenance
}

export type LipArtworkStateV2 = {
  schemaVersion: typeof LIP_ARTWORK_STATE_SCHEMA_VERSION
  definitionSha256: string
  artwork: LipArtworkUpload
  tint: LipArtworkRgb
  opacity: number
}

export type LipArtworkReconciliation = {
  state: LipArtworkStateV2 | null
  incompatible: boolean
  reason?: string
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const PUBLIC_ASSET_PREFIX = 'goons/lip-artwork/v2/'
const COLOR_DECIMAL_SCALE = 1_000_000

function fail(message: string): never {
  throw new Error(`[lip-artwork/v2] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  const accepted = new Set(allowed)
  const extra = Object.keys(value).filter((key) => !accepted.has(key))
  if (extra.length > 0) fail(`${context} contains unsupported fields: ${extra.join(', ')}`)
}

function text(value: unknown, context: string) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function sha256(value: unknown, context: string) {
  const parsed = text(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function finite(value: unknown, context: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function unit(value: unknown, context: string) {
  const parsed = finite(value, context)
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`)
  return parsed
}

function stableColorUnit(value: unknown, context: string) {
  const parsed = unit(value, context)
  return Math.round(parsed * COLOR_DECIMAL_SCALE) / COLOR_DECIMAL_SCALE
}

function positiveInteger(value: unknown, context: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${context} must be a positive integer`)
  }
  return value as number
}

function rgb(value: unknown, context: string): LipArtworkRgb {
  if (!Array.isArray(value) || value.length !== 3) fail(`${context} must have three channels`)
  return value.map((channel, index) =>
    stableColorUnit(channel, `${context}[${index}]`)
  ) as LipArtworkRgb
}

function asset(
  value: unknown,
  context: string,
  extras: readonly string[] = []
): LipArtworkAssetRef & Record<string, unknown> {
  const source = record(value, context)
  exactKeys(source, ['path', 'sha256', ...extras], context)
  const path = text(source.path, `${context}.path`)
  if (
    !path.startsWith(PUBLIC_ASSET_PREFIX) ||
    path.includes('\\') ||
    path.split('/').includes('..')
  ) {
    fail(`${context}.path must be a public lip-artwork asset`)
  }
  return {
    ...source,
    path,
    sha256: sha256(source.sha256, `${context}.sha256`)
  }
}

function parseProvenance(value: unknown): FacialArtworkProvenance {
  const source = record(value, 'state.artwork.provenance')
  exactKeys(
    source,
    ['sourceKind', 'author', 'license', 'rightsConfirmed'],
    'state.artwork.provenance'
  )
  if (
    source.sourceKind !== 'batshit-original' &&
    source.sourceKind !== 'user-authored' &&
    source.sourceKind !== 'comfyui-generated' &&
    source.sourceKind !== 'approved-external'
  ) {
    fail('state.artwork.provenance.sourceKind is unsupported')
  }
  if (source.rightsConfirmed !== true) {
    fail('state.artwork.provenance.rightsConfirmed must be true')
  }
  return {
    sourceKind: source.sourceKind,
    author: text(source.author, 'state.artwork.provenance.author'),
    license: text(source.license, 'state.artwork.provenance.license'),
    rightsConfirmed: true
  }
}

export function parseLipArtworkDefinition(value: unknown): LipArtworkDefinitionV2 {
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
      'runtimeBinding',
      'template'
    ],
    'definition'
  )
  if (source.schemaVersion !== LIP_ARTWORK_SCHEMA_VERSION) {
    fail('definition schemaVersion is unsupported')
  }
  if (source.stateSchemaVersion !== LIP_ARTWORK_STATE_SCHEMA_VERSION) {
    fail('definition stateSchemaVersion is unsupported')
  }
  if (source.productExportApproved !== true) {
    fail('definition productExportApproved must be true')
  }
  const binding = record(source.runtimeBinding, 'definition.runtimeBinding')
  exactKeys(binding, ['node', 'material'], 'definition.runtimeBinding')
  const template = record(source.template, 'definition.template')
  exactKeys(
    template,
    [
      'id',
      'version',
      'dimensions',
      'guide',
      'safePaintMask',
      'baseLipReferenceMask',
      'transparentBlank'
    ],
    'definition.template'
  )
  if (!Array.isArray(template.dimensions) || template.dimensions.length !== 2) {
    fail('definition.template.dimensions must contain width and height')
  }
  const safePaintMask = asset(template.safePaintMask, 'definition.template.safePaintMask', [
    'channels',
    'paintThreshold'
  ])
  if (safePaintMask.channels !== 'L8' || safePaintMask.paintThreshold !== 1) {
    fail('definition.template.safePaintMask must use L8 with paintThreshold 1')
  }
  const baseLipReferenceMask = asset(
    template.baseLipReferenceMask,
    'definition.template.baseLipReferenceMask',
    ['channels']
  )
  if (baseLipReferenceMask.channels !== 'L8') {
    fail('definition.template.baseLipReferenceMask must use L8')
  }
  return {
    schemaVersion: LIP_ARTWORK_SCHEMA_VERSION,
    stateSchemaVersion: LIP_ARTWORK_STATE_SCHEMA_VERSION,
    status: text(source.status, 'definition.status'),
    productExportApproved: true,
    definitionSha256: sha256(source.definitionSha256, 'definition.definitionSha256'),
    ownership: text(source.ownership, 'definition.ownership'),
    defaultLaw: text(source.defaultLaw, 'definition.defaultLaw'),
    runtimeBinding: {
      node: text(binding.node, 'definition.runtimeBinding.node'),
      material: text(binding.material, 'definition.runtimeBinding.material')
    },
    template: {
      id: text(template.id, 'definition.template.id'),
      version: text(template.version, 'definition.template.version'),
      dimensions: [
        positiveInteger(template.dimensions[0], 'definition.template.dimensions[0]'),
        positiveInteger(template.dimensions[1], 'definition.template.dimensions[1]')
      ],
      guide: asset(template.guide, 'definition.template.guide'),
      safePaintMask: {
        path: safePaintMask.path,
        sha256: safePaintMask.sha256,
        channels: 'L8',
        paintThreshold: 1
      },
      baseLipReferenceMask: {
        path: baseLipReferenceMask.path,
        sha256: baseLipReferenceMask.sha256,
        channels: 'L8'
      },
      transparentBlank: asset(template.transparentBlank, 'definition.template.transparentBlank')
    }
  }
}

export function parseLipArtworkState(
  definition: LipArtworkDefinitionV2,
  value: unknown
): LipArtworkStateV2 {
  const source = record(value, 'state')
  exactKeys(source, ['schemaVersion', 'definitionSha256', 'artwork', 'tint', 'opacity'], 'state')
  if (source.schemaVersion !== LIP_ARTWORK_STATE_SCHEMA_VERSION) {
    fail('state schemaVersion is unsupported')
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('state definitionSha256 does not match this package')
  }
  const artwork = record(source.artwork, 'state.artwork')
  exactKeys(
    artwork,
    ['url', 'filename', 'size', 'mimeType', 'sha256', 'definitionSha256', 'template', 'provenance'],
    'state.artwork'
  )
  if (artwork.mimeType !== 'image/png') fail('state.artwork.mimeType must be image/png')
  if (artwork.definitionSha256 !== definition.definitionSha256) {
    fail('state.artwork.definitionSha256 does not match this package')
  }
  const template = record(artwork.template, 'state.artwork.template')
  exactKeys(
    template,
    ['id', 'version', 'guideSha256', 'maskSha256', 'baseLipReferenceMaskSha256'],
    'state.artwork.template'
  )
  if (
    template.id !== definition.template.id ||
    template.version !== definition.template.version ||
    template.guideSha256 !== definition.template.guide.sha256 ||
    template.maskSha256 !== definition.template.safePaintMask.sha256 ||
    template.baseLipReferenceMaskSha256 !== definition.template.baseLipReferenceMask.sha256
  ) {
    fail('state.artwork template proof does not match this package')
  }
  const filename = text(artwork.filename, 'state.artwork.filename')
  if (filename.includes('/') || filename.includes('\\')) fail('state.artwork.filename is invalid')
  return {
    schemaVersion: LIP_ARTWORK_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    artwork: {
      url: text(artwork.url, 'state.artwork.url'),
      filename,
      size: positiveInteger(artwork.size, 'state.artwork.size'),
      mimeType: 'image/png',
      sha256: sha256(artwork.sha256, 'state.artwork.sha256'),
      definitionSha256: definition.definitionSha256,
      template: {
        id: definition.template.id,
        version: definition.template.version,
        guideSha256: definition.template.guide.sha256,
        maskSha256: definition.template.safePaintMask.sha256,
        baseLipReferenceMaskSha256: definition.template.baseLipReferenceMask.sha256
      },
      provenance: parseProvenance(artwork.provenance)
    },
    tint: rgb(source.tint, 'state.tint'),
    opacity: unit(source.opacity, 'state.opacity')
  }
}

export function reconcileLipArtworkState(
  definition: LipArtworkDefinitionV2,
  value: unknown
): LipArtworkReconciliation {
  if (value == null) return { state: null, incompatible: false }
  try {
    return {
      state: parseLipArtworkState(definition, value),
      incompatible: false
    }
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason: error instanceof Error ? error.message : 'Lip Artwork state is incompatible.'
    }
  }
}

export function lipArtworkRgbToHex(value: LipArtworkRgb) {
  return `#${value
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

export function lipArtworkHexToRgb(value: string): LipArtworkRgb | null {
  if (!/^#[a-f0-9]{6}$/i.test(value)) return null
  return [1, 3, 5].map(
    (offset) =>
      Math.round(
        (Number.parseInt(value.slice(offset, offset + 2), 16) / 255) * COLOR_DECIMAL_SCALE
      ) / COLOR_DECIMAL_SCALE
  ) as LipArtworkRgb
}

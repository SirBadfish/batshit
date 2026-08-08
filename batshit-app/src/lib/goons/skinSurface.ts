import type { FacialArtworkProvenance } from './facialArtwork'

export const SKIN_SURFACE_ARTWORK_SCHEMA_VERSION =
  'skin-surface-artwork/v1' as const
export const LEGACY_SKIN_MATERIAL_ARTWORK_SCHEMA_VERSION =
  'skin-material-artwork/v1' as const

export const SKIN_SURFACE_MAP_ROLES = [
  'baseColor',
  'normal',
  'roughness',
  'metallic'
] as const

export type SkinSurfaceMapRole = (typeof SKIN_SURFACE_MAP_ROLES)[number]
export type SkinSurfaceColorSpace = 'srgb' | 'linear'
export type SkinSurfaceEncoding =
  | 'rgba8'
  | 'rgb8-normal-opengl'
  | 'rgb8-roughness-g'
  | 'rgb8-metallic-b'

export type SkinSurfaceUploadV1 = {
  schemaVersion: typeof SKIN_SURFACE_ARTWORK_SCHEMA_VERSION
  map: SkinSurfaceMapRole
  url: string
  filename: string
  size: number
  mimeType: 'image/png'
  sha256: string
  definitionSha256: string
  canvas: {
    width: number
    height: number
    colorSpace: SkinSurfaceColorSpace
    flipY: false
    encoding: SkinSurfaceEncoding
  }
  provenance: FacialArtworkProvenance
}

export type LegacySkinMaterialBaseColorUploadV1 = Omit<
  SkinSurfaceUploadV1,
  'schemaVersion' | 'canvas'
> & {
  schemaVersion: typeof LEGACY_SKIN_MATERIAL_ARTWORK_SCHEMA_VERSION
  map: 'baseColor'
  canvas: {
    width: number
    height: number
    colorSpace: 'srgb'
    flipY: false
  }
}

export type SkinSurfaceDefinitionIdentity = {
  definitionSha256: string
  canvas: { width: number; height: number }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const UPLOAD_PATH_SEGMENT = '/uploads/goon_skin_artwork/'
const SOURCE_KINDS = new Set<FacialArtworkProvenance['sourceKind']>([
  'batshit-original',
  'user-authored',
  'comfyui-generated',
  'approved-external'
])

function fail(message: string): never {
  throw new Error(`[skin-surface-artwork/v1] ${message}`)
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
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function sha256(value: unknown, context: string) {
  const parsed = text(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function positiveInteger(value: unknown, context: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${context} must be a positive integer`)
  }
  return value as number
}

function parseProvenance(value: unknown, context: string): FacialArtworkProvenance {
  const source = record(value, context)
  exactKeys(
    source,
    ['sourceKind', 'author', 'license', 'rightsConfirmed'],
    context
  )
  if (
    typeof source.sourceKind !== 'string' ||
    !SOURCE_KINDS.has(source.sourceKind as FacialArtworkProvenance['sourceKind'])
  ) {
    fail(`${context}.sourceKind is unsupported`)
  }
  if (source.rightsConfirmed !== true) {
    fail(`${context}.rightsConfirmed must be true`)
  }
  return {
    sourceKind: source.sourceKind as FacialArtworkProvenance['sourceKind'],
    author: text(source.author, `${context}.author`),
    license: text(source.license, `${context}.license`),
    rightsConfirmed: true
  }
}

function parseUploadUrl(value: unknown, context: string) {
  const url = text(value, context)
  let pathname: string
  try {
    pathname = new URL(url, 'http://batshit.local').pathname
  } catch {
    fail(`${context} is invalid`)
  }
  if (!pathname.includes(UPLOAD_PATH_SEGMENT)) {
    fail(`${context} must reference a validated Skin Surface upload`)
  }
  return url
}

function roleContract(
  definition: SkinSurfaceDefinitionIdentity,
  role: SkinSurfaceMapRole
): {
  width: number
  height: number
  colorSpace: SkinSurfaceColorSpace
  encoding: SkinSurfaceEncoding
} {
  if (role === 'baseColor') {
    return {
      width: definition.canvas.width,
      height: definition.canvas.height,
      colorSpace: 'srgb',
      encoding: 'rgba8'
    }
  }
  return {
    width: 2048,
    height: 2048,
    colorSpace: 'linear',
    encoding:
      role === 'normal'
        ? 'rgb8-normal-opengl'
        : role === 'roughness'
          ? 'rgb8-roughness-g'
          : 'rgb8-metallic-b'
  }
}

export function parseSkinSurfaceUpload(
  definition: SkinSurfaceDefinitionIdentity,
  expectedRole: SkinSurfaceMapRole,
  value: unknown
): SkinSurfaceUploadV1 {
  const source = record(value, `state.surface.${expectedRole}.custom`)
  const legacyBaseColor =
    expectedRole === 'baseColor' &&
    source.schemaVersion === LEGACY_SKIN_MATERIAL_ARTWORK_SCHEMA_VERSION
  exactKeys(
    source,
    [
      'schemaVersion',
      'map',
      'url',
      'filename',
      'size',
      'mimeType',
      'sha256',
      'definitionSha256',
      'canvas',
      'provenance'
    ],
    `state.surface.${expectedRole}.custom`
  )
  if (
    source.schemaVersion !== SKIN_SURFACE_ARTWORK_SCHEMA_VERSION &&
    !legacyBaseColor
  ) {
    fail(`state.surface.${expectedRole}.custom.schemaVersion is unsupported`)
  }
  if (source.map !== expectedRole) {
    fail(`state.surface.${expectedRole}.custom.map must be ${expectedRole}`)
  }
  if (source.mimeType !== 'image/png') {
    fail(`state.surface.${expectedRole}.custom.mimeType must be image/png`)
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail(`state.surface.${expectedRole}.custom definition does not match this Goon`)
  }
  const filename = text(
    source.filename,
    `state.surface.${expectedRole}.custom.filename`
  )
  if (filename.includes('/') || filename.includes('\\')) {
    fail(`state.surface.${expectedRole}.custom.filename must be a basename`)
  }

  const canvas = record(
    source.canvas,
    `state.surface.${expectedRole}.custom.canvas`
  )
  exactKeys(
    canvas,
    legacyBaseColor
      ? ['width', 'height', 'colorSpace', 'flipY']
      : ['width', 'height', 'colorSpace', 'flipY', 'encoding'],
    `state.surface.${expectedRole}.custom.canvas`
  )
  const contract = roleContract(definition, expectedRole)
  const width = positiveInteger(
    canvas.width,
    `state.surface.${expectedRole}.custom.canvas.width`
  )
  const height = positiveInteger(
    canvas.height,
    `state.surface.${expectedRole}.custom.canvas.height`
  )
  if (
    width !== contract.width ||
    height !== contract.height ||
    canvas.colorSpace !== contract.colorSpace ||
    canvas.flipY !== false ||
    (!legacyBaseColor && canvas.encoding !== contract.encoding)
  ) {
    fail(`state.surface.${expectedRole}.custom canvas contract is invalid`)
  }

  return {
    schemaVersion: SKIN_SURFACE_ARTWORK_SCHEMA_VERSION,
    map: expectedRole,
    url: parseUploadUrl(
      source.url,
      `state.surface.${expectedRole}.custom.url`
    ),
    filename,
    size: positiveInteger(
      source.size,
      `state.surface.${expectedRole}.custom.size`
    ),
    mimeType: 'image/png',
    sha256: sha256(
      source.sha256,
      `state.surface.${expectedRole}.custom.sha256`
    ),
    definitionSha256: definition.definitionSha256,
    canvas: {
      width,
      height,
      colorSpace: contract.colorSpace,
      flipY: false,
      encoding: contract.encoding
    },
    provenance: parseProvenance(
      source.provenance,
      `state.surface.${expectedRole}.custom.provenance`
    )
  }
}

export function collectSkinSurfaceUploads(value: {
  surface?: Partial<
    Record<SkinSurfaceMapRole, { custom?: SkinSurfaceUploadV1 | null }>
  >
} | null | undefined): SkinSurfaceUploadV1[] {
  if (!value?.surface) return []
  return SKIN_SURFACE_MAP_ROLES.flatMap((role) => {
    const upload = value.surface?.[role]?.custom
    return upload ? [upload] : []
  })
}

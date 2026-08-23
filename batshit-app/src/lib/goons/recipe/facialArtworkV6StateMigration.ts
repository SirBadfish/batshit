export const LEGACY_FACIAL_ARTWORK_DEFINITION_V5 = 'facial-artwork/v5' as const
export const LEGACY_FACIAL_ARTWORK_STATE_V5 = 'facial-artwork-state/v5' as const
export const TARGET_FACIAL_ARTWORK_DEFINITION_V6 = 'facial-artwork/v6' as const
export const TARGET_FACIAL_ARTWORK_STATE_V6 = 'facial-artwork-state/v6' as const

export const FACIAL_ARTWORK_V6_ROLE_IDS = [
  'brows',
  'lashes_eye_outline',
  'iris',
  'pupil',
  'eye_highlight',
  'sclera'
] as const

export type FacialArtworkV6RoleId = (typeof FACIAL_ARTWORK_V6_ROLE_IDS)[number]
export type FacialArtworkV6Orientation =
  | 'orientation-neutral'
  | 'anatomical-left'
  | 'anatomical-right'

export type FacialArtworkV6UploadTemplateBinding = {
  id: string
  version: string
  orientation: FacialArtworkV6Orientation
  guideSha256: string
  maskSha256: string
}

export type FacialArtworkV6RoleTemplateBinding = {
  id: string
  version: string
  variants: FacialArtworkV6UploadTemplateBinding[]
}

export type FacialArtworkV6MigrationDefinitionBinding = {
  schemaVersion:
    | typeof LEGACY_FACIAL_ARTWORK_DEFINITION_V5
    | typeof TARGET_FACIAL_ARTWORK_DEFINITION_V6
  stateSchemaVersion:
    | typeof LEGACY_FACIAL_ARTWORK_STATE_V5
    | typeof TARGET_FACIAL_ARTWORK_STATE_V6
  definitionSha256: string
  templateSet: { id: string; version: string }
  templates: Record<FacialArtworkV6RoleId, FacialArtworkV6RoleTemplateBinding>
}

export type FacialArtworkV5PlanarTransform = {
  translateU: number
  translateV: number
  scale: number
  rotationDegrees: number
}

export type FacialArtworkV6IdentityPlanarTransform = {
  translateU: 0
  translateV: 0
  scale: 1
  rotationDegrees: number
}

export type FacialArtworkV6PreservedPlanarTransform = FacialArtworkV5PlanarTransform
export type FacialArtworkV6LongitudeTransform = { longitudeDegrees: number }

export type FacialArtworkV6Provenance = {
  sourceKind: 'batshit-original' | 'user-authored' | 'comfyui-generated' | 'approved-external'
  author: string
  license: string
  rightsConfirmed: true
}

export type FacialArtworkV6Upload = {
  role: FacialArtworkV6RoleId
  url: string
  filename: string
  size: number
  mimeType: 'image/png'
  sha256: string
  template: FacialArtworkV6UploadTemplateBinding
  provenance: FacialArtworkV6Provenance
}

export type FacialArtworkV6ArtworkLayer = {
  upload: FacialArtworkV6Upload
  tint: [number, number, number, number]
  opacity: number
} & (
  | {
      mapping: 'planar' | 'radial'
      transform: FacialArtworkV6PreservedPlanarTransform | FacialArtworkV6IdentityPlanarTransform
    }
  | { mapping: 'longitude'; transform: FacialArtworkV6LongitudeTransform }
)

export type FacialArtworkV6EyeState = {
  visible: boolean
  baseColor: [number, number, number] | null
  artwork: FacialArtworkV6ArtworkLayer | null
}

export type FacialArtworkV6RoleState =
  | { mode: 'shared'; shared: FacialArtworkV6EyeState }
  | { mode: 'per-eye'; left: FacialArtworkV6EyeState; right: FacialArtworkV6EyeState }

export type FacialArtworkStateV5MigrationSource = {
  schemaVersion: typeof LEGACY_FACIAL_ARTWORK_STATE_V5
  definitionSha256: string
  templateSet: { id: string; version: string }
  roles: Record<FacialArtworkV6RoleId, FacialArtworkV6RoleState>
}

export type FacialArtworkStateV6MigrationTarget = {
  schemaVersion: typeof TARGET_FACIAL_ARTWORK_STATE_V6
  definitionSha256: string
  templateSet: { id: string; version: string }
  roles: Record<FacialArtworkV6RoleId, FacialArtworkV6RoleState>
}

export type FacialArtworkV6StateMigrationInput = {
  source: FacialArtworkV6MigrationDefinitionBinding
  target: FacialArtworkV6MigrationDefinitionBinding
  state: unknown
}

export type FacialArtworkV6StateMigrationErrorCode =
  | 'INVALID_BINDING'
  | 'INCOMPATIBLE_SOURCE'

export class FacialArtworkV6StateMigrationError extends Error {
  constructor(
    readonly code: FacialArtworkV6StateMigrationErrorCode,
    message: string
  ) {
    super(`[facial-artwork-state/v5->v6] ${message}`)
    this.name = 'FacialArtworkV6StateMigrationError'
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const SOURCE_KINDS = new Set<FacialArtworkV6Provenance['sourceKind']>([
  'batshit-original',
  'user-authored',
  'comfyui-generated',
  'approved-external'
])
const ORIENTATIONS = new Set<FacialArtworkV6Orientation>([
  'orientation-neutral',
  'anatomical-left',
  'anatomical-right'
])
const COLOR_ROLES = new Set<FacialArtworkV6RoleId>(['iris', 'pupil', 'sclera'])
const ROLE_MAPPINGS: Record<FacialArtworkV6RoleId, 'planar' | 'radial' | 'longitude'> = {
  brows: 'planar',
  lashes_eye_outline: 'planar',
  iris: 'radial',
  pupil: 'radial',
  eye_highlight: 'radial',
  sclera: 'longitude'
}

function fail(code: FacialArtworkV6StateMigrationErrorCode, message: string): never {
  throw new FacialArtworkV6StateMigrationError(code, message)
}

function record(
  value: unknown,
  context: string,
  code: FacialArtworkV6StateMigrationErrorCode
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${context} must be an object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${context} must be a plain object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
  code: FacialArtworkV6StateMigrationErrorCode
) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${context} must contain exactly: ${wanted.join(', ')}.`)
  }
}

function text(
  value: unknown,
  context: string,
  code: FacialArtworkV6StateMigrationErrorCode
): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail(code, `${context} must be a non-empty trimmed string.`)
  }
  return value
}

function hash(
  value: unknown,
  context: string,
  code: FacialArtworkV6StateMigrationErrorCode
): string {
  const parsed = text(value, context, code)
  if (!HASH_PATTERN.test(parsed)) fail(code, `${context} must be a lowercase SHA-256.`)
  return parsed
}

function finite(
  value: unknown,
  context: string,
  code: FacialArtworkV6StateMigrationErrorCode
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(code, `${context} must be finite.`)
  }
  return value
}

function unit(value: unknown, context: string): number {
  const parsed = finite(value, context, 'INCOMPATIBLE_SOURCE')
  if (parsed < 0 || parsed > 1) {
    fail('INCOMPATIBLE_SOURCE', `${context} must be inside [0, 1].`)
  }
  return parsed
}

function uploadTemplateBinding(
  value: unknown,
  context: string,
  code: FacialArtworkV6StateMigrationErrorCode
): FacialArtworkV6UploadTemplateBinding {
  const raw = record(value, context, code)
  exactKeys(raw, ['id', 'version', 'orientation', 'guideSha256', 'maskSha256'], context, code)
  if (!ORIENTATIONS.has(raw.orientation as FacialArtworkV6Orientation)) {
    fail(code, `${context}.orientation is invalid.`)
  }
  return {
    id: text(raw.id, `${context}.id`, code),
    version: text(raw.version, `${context}.version`, code),
    orientation: raw.orientation as FacialArtworkV6Orientation,
    guideSha256: hash(raw.guideSha256, `${context}.guideSha256`, code),
    maskSha256: hash(raw.maskSha256, `${context}.maskSha256`, code)
  }
}

function roleTemplateBinding(
  value: unknown,
  context: string
): FacialArtworkV6RoleTemplateBinding {
  const raw = record(value, context, 'INVALID_BINDING')
  exactKeys(raw, ['id', 'version', 'variants'], context, 'INVALID_BINDING')
  if (!Array.isArray(raw.variants) || raw.variants.length === 0) {
    fail('INVALID_BINDING', `${context}.variants must be a non-empty array.`)
  }
  const id = text(raw.id, `${context}.id`, 'INVALID_BINDING')
  const version = text(raw.version, `${context}.version`, 'INVALID_BINDING')
  const variants = raw.variants.map((variant, index) =>
    uploadTemplateBinding(variant, `${context}.variants[${index}]`, 'INVALID_BINDING')
  )
  const orientations = variants.map((variant) => variant.orientation)
  if (new Set(orientations).size !== orientations.length) {
    fail('INVALID_BINDING', `${context}.variants cannot repeat an orientation.`)
  }
  if (variants.some((variant) => variant.id !== id || variant.version !== version)) {
    fail('INVALID_BINDING', `${context}.variants must bind the role template id and version.`)
  }
  return { id, version, variants }
}

function templateSet(
  value: unknown,
  context: string,
  code: FacialArtworkV6StateMigrationErrorCode
) {
  const raw = record(value, context, code)
  exactKeys(raw, ['id', 'version'], context, code)
  return {
    id: text(raw.id, `${context}.id`, code),
    version: text(raw.version, `${context}.version`, code)
  }
}

function definitionBinding(
  value: FacialArtworkV6MigrationDefinitionBinding,
  expectedDefinition: typeof LEGACY_FACIAL_ARTWORK_DEFINITION_V5 | typeof TARGET_FACIAL_ARTWORK_DEFINITION_V6,
  expectedState: typeof LEGACY_FACIAL_ARTWORK_STATE_V5 | typeof TARGET_FACIAL_ARTWORK_STATE_V6,
  context: string
) {
  const raw = record(value, context, 'INVALID_BINDING')
  exactKeys(
    raw,
    ['schemaVersion', 'stateSchemaVersion', 'definitionSha256', 'templateSet', 'templates'],
    context,
    'INVALID_BINDING'
  )
  if (raw.schemaVersion !== expectedDefinition || raw.stateSchemaVersion !== expectedState) {
    fail('INVALID_BINDING', `${context} must bind ${expectedDefinition} and ${expectedState}.`)
  }
  const templatesRaw = record(raw.templates, `${context}.templates`, 'INVALID_BINDING')
  exactKeys(templatesRaw, FACIAL_ARTWORK_V6_ROLE_IDS, `${context}.templates`, 'INVALID_BINDING')
  const templates = {} as Record<FacialArtworkV6RoleId, FacialArtworkV6RoleTemplateBinding>
  for (const role of FACIAL_ARTWORK_V6_ROLE_IDS) {
    templates[role] = roleTemplateBinding(
      templatesRaw[role],
      `${context}.templates.${role}`
    )
  }
  return {
    definitionSha256: hash(raw.definitionSha256, `${context}.definitionSha256`, 'INVALID_BINDING'),
    templateSet: templateSet(raw.templateSet, `${context}.templateSet`, 'INVALID_BINDING'),
    templates
  }
}

function sameTemplate(
  left: FacialArtworkV6UploadTemplateBinding,
  right: FacialArtworkV6UploadTemplateBinding
) {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.orientation === right.orientation &&
    left.guideSha256 === right.guideSha256 &&
    left.maskSha256 === right.maskSha256
  )
}

function parseUpload(
  value: unknown,
  role: FacialArtworkV6RoleId,
  sourceTemplate: FacialArtworkV6RoleTemplateBinding,
  targetTemplate: FacialArtworkV6RoleTemplateBinding,
  context: string
): FacialArtworkV6Upload {
  const raw = record(value, context, 'INCOMPATIBLE_SOURCE')
  exactKeys(
    raw,
    ['role', 'url', 'filename', 'size', 'mimeType', 'sha256', 'template', 'provenance'],
    context,
    'INCOMPATIBLE_SOURCE'
  )
  if (raw.role !== role) fail('INCOMPATIBLE_SOURCE', `${context}.role must equal ${role}.`)
  if (raw.mimeType !== 'image/png') {
    fail('INCOMPATIBLE_SOURCE', `${context}.mimeType must equal image/png.`)
  }
  if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 1) {
    fail('INCOMPATIBLE_SOURCE', `${context}.size must be a positive safe integer.`)
  }
  const sourceUploadTemplate = uploadTemplateBinding(
    raw.template,
    `${context}.template`,
    'INCOMPATIBLE_SOURCE'
  )
  const sourceVariant = sourceTemplate.variants.find(
    (variant) => variant.orientation === sourceUploadTemplate.orientation
  )
  if (!sourceVariant || !sameTemplate(sourceUploadTemplate, sourceVariant)) {
    fail('INCOMPATIBLE_SOURCE', `${context}.template does not match the exact source template.`)
  }
  const targetVariant = targetTemplate.variants.find(
    (variant) => variant.orientation === sourceUploadTemplate.orientation
  )
  if (!targetVariant) {
    fail(
      'INVALID_BINDING',
      `target template for ${role} does not declare ${sourceUploadTemplate.orientation}.`
    )
  }
  const provenance = record(raw.provenance, `${context}.provenance`, 'INCOMPATIBLE_SOURCE')
  exactKeys(
    provenance,
    ['sourceKind', 'author', 'license', 'rightsConfirmed'],
    `${context}.provenance`,
    'INCOMPATIBLE_SOURCE'
  )
  if (!SOURCE_KINDS.has(provenance.sourceKind as FacialArtworkV6Provenance['sourceKind'])) {
    fail('INCOMPATIBLE_SOURCE', `${context}.provenance.sourceKind is invalid.`)
  }
  if (provenance.rightsConfirmed !== true) {
    fail('INCOMPATIBLE_SOURCE', `${context}.provenance.rightsConfirmed must be true.`)
  }
  return {
    role,
    url: text(raw.url, `${context}.url`, 'INCOMPATIBLE_SOURCE'),
    filename: text(raw.filename, `${context}.filename`, 'INCOMPATIBLE_SOURCE'),
    size: raw.size,
    mimeType: 'image/png',
    sha256: hash(raw.sha256, `${context}.sha256`, 'INCOMPATIBLE_SOURCE'),
    template: { ...targetVariant },
    provenance: {
      sourceKind: provenance.sourceKind as FacialArtworkV6Provenance['sourceKind'],
      author: text(provenance.author, `${context}.provenance.author`, 'INCOMPATIBLE_SOURCE'),
      license: text(provenance.license, `${context}.provenance.license`, 'INCOMPATIBLE_SOURCE'),
      rightsConfirmed: true
    }
  }
}

function parsePlanarTransform(value: unknown, context: string): FacialArtworkV5PlanarTransform {
  const raw = record(value, context, 'INCOMPATIBLE_SOURCE')
  exactKeys(
    raw,
    ['translateU', 'translateV', 'scale', 'rotationDegrees'],
    context,
    'INCOMPATIBLE_SOURCE'
  )
  const scale = finite(raw.scale, `${context}.scale`, 'INCOMPATIBLE_SOURCE')
  if (scale <= 0) fail('INCOMPATIBLE_SOURCE', `${context}.scale must be greater than zero.`)
  return {
    translateU: finite(raw.translateU, `${context}.translateU`, 'INCOMPATIBLE_SOURCE'),
    translateV: finite(raw.translateV, `${context}.translateV`, 'INCOMPATIBLE_SOURCE'),
    scale,
    rotationDegrees: finite(
      raw.rotationDegrees,
      `${context}.rotationDegrees`,
      'INCOMPATIBLE_SOURCE'
    )
  }
}

function parseEyeState(
  value: unknown,
  role: FacialArtworkV6RoleId,
  sourceTemplate: FacialArtworkV6RoleTemplateBinding,
  targetTemplate: FacialArtworkV6RoleTemplateBinding,
  context: string
): FacialArtworkV6EyeState {
  const raw = record(value, context, 'INCOMPATIBLE_SOURCE')
  exactKeys(raw, ['visible', 'baseColor', 'artwork'], context, 'INCOMPATIBLE_SOURCE')
  if (typeof raw.visible !== 'boolean') {
    fail('INCOMPATIBLE_SOURCE', `${context}.visible must be boolean.`)
  }
  let baseColor: [number, number, number] | null = null
  if (raw.baseColor !== null) {
    if (!COLOR_ROLES.has(role)) {
      fail('INCOMPATIBLE_SOURCE', `${context}.baseColor is unsupported for ${role}.`)
    }
    if (!Array.isArray(raw.baseColor) || raw.baseColor.length !== 3) {
      fail('INCOMPATIBLE_SOURCE', `${context}.baseColor must contain three channels.`)
    }
    baseColor = raw.baseColor.map((channel, index) =>
      unit(channel, `${context}.baseColor[${index}]`)
    ) as [number, number, number]
  }
  if (raw.artwork === null) {
    return { visible: raw.visible, baseColor, artwork: null }
  }
  const artwork = record(raw.artwork, `${context}.artwork`, 'INCOMPATIBLE_SOURCE')
  exactKeys(
    artwork,
    ['upload', 'tint', 'opacity', 'mapping', 'transform'],
    `${context}.artwork`,
    'INCOMPATIBLE_SOURCE'
  )
  const mapping = ROLE_MAPPINGS[role]
  if (artwork.mapping !== mapping) {
    fail('INCOMPATIBLE_SOURCE', `${context}.artwork.mapping must equal ${mapping}.`)
  }
  if (!Array.isArray(artwork.tint) || artwork.tint.length !== 4) {
    fail('INCOMPATIBLE_SOURCE', `${context}.artwork.tint must contain four channels.`)
  }
  const common = {
    upload: parseUpload(
      artwork.upload,
      role,
      sourceTemplate,
      targetTemplate,
      `${context}.artwork.upload`
    ),
    tint: artwork.tint.map((channel, index) =>
      unit(channel, `${context}.artwork.tint[${index}]`)
    ) as [number, number, number, number],
    opacity: unit(artwork.opacity, `${context}.artwork.opacity`)
  }
  if (mapping === 'longitude') {
    const transform = record(
      artwork.transform,
      `${context}.artwork.transform`,
      'INCOMPATIBLE_SOURCE'
    )
    exactKeys(
      transform,
      ['longitudeDegrees'],
      `${context}.artwork.transform`,
      'INCOMPATIBLE_SOURCE'
    )
    return {
      visible: raw.visible,
      baseColor,
      artwork: {
        ...common,
        mapping,
        transform: {
          longitudeDegrees: finite(
            transform.longitudeDegrees,
            `${context}.artwork.transform.longitudeDegrees`,
            'INCOMPATIBLE_SOURCE'
          )
        }
      }
    }
  }
  const sourceTransform = parsePlanarTransform(
    artwork.transform,
    `${context}.artwork.transform`
  )
  const transform =
    role === 'iris' || role === 'pupil'
      ? {
          translateU: 0 as const,
          translateV: 0 as const,
          scale: 1 as const,
          rotationDegrees: sourceTransform.rotationDegrees
        }
      : sourceTransform
  return {
    visible: raw.visible,
    baseColor,
    artwork: { ...common, mapping, transform }
  }
}

function parseRoleState(
  value: unknown,
  role: FacialArtworkV6RoleId,
  sourceTemplate: FacialArtworkV6RoleTemplateBinding,
  targetTemplate: FacialArtworkV6RoleTemplateBinding
): FacialArtworkV6RoleState {
  const context = `state.roles.${role}`
  const raw = record(value, context, 'INCOMPATIBLE_SOURCE')
  if (raw.mode === 'shared') {
    exactKeys(raw, ['mode', 'shared'], context, 'INCOMPATIBLE_SOURCE')
    return {
      mode: 'shared',
      shared: parseEyeState(raw.shared, role, sourceTemplate, targetTemplate, `${context}.shared`)
    }
  }
  if (raw.mode === 'per-eye') {
    exactKeys(raw, ['mode', 'left', 'right'], context, 'INCOMPATIBLE_SOURCE')
    return {
      mode: 'per-eye',
      left: parseEyeState(raw.left, role, sourceTemplate, targetTemplate, `${context}.left`),
      right: parseEyeState(raw.right, role, sourceTemplate, targetTemplate, `${context}.right`)
    }
  }
  fail('INCOMPATIBLE_SOURCE', `${context}.mode must be shared or per-eye.`)
}

export function migrateFacialArtworkStateV5ToV6(
  input: FacialArtworkV6StateMigrationInput
): FacialArtworkStateV6MigrationTarget {
  const source = definitionBinding(
    input.source,
    LEGACY_FACIAL_ARTWORK_DEFINITION_V5,
    LEGACY_FACIAL_ARTWORK_STATE_V5,
    'source definition'
  )
  const target = definitionBinding(
    input.target,
    TARGET_FACIAL_ARTWORK_DEFINITION_V6,
    TARGET_FACIAL_ARTWORK_STATE_V6,
    'target definition'
  )
  if (source.definitionSha256 === target.definitionSha256) {
    fail('INVALID_BINDING', 'source and target definitions must have distinct immutable hashes.')
  }
  const state = record(input.state, 'state', 'INCOMPATIBLE_SOURCE')
  exactKeys(
    state,
    ['schemaVersion', 'definitionSha256', 'templateSet', 'roles'],
    'state',
    'INCOMPATIBLE_SOURCE'
  )
  if (state.schemaVersion !== LEGACY_FACIAL_ARTWORK_STATE_V5) {
    fail('INCOMPATIBLE_SOURCE', `state.schemaVersion must equal ${LEGACY_FACIAL_ARTWORK_STATE_V5}.`)
  }
  if (state.definitionSha256 !== source.definitionSha256) {
    fail('INCOMPATIBLE_SOURCE', 'state.definitionSha256 does not match the exact source definition.')
  }
  const savedTemplateSet = templateSet(
    state.templateSet,
    'state.templateSet',
    'INCOMPATIBLE_SOURCE'
  )
  if (
    savedTemplateSet.id !== source.templateSet.id ||
    savedTemplateSet.version !== source.templateSet.version
  ) {
    fail('INCOMPATIBLE_SOURCE', 'state.templateSet does not match the exact source definition.')
  }
  const roleSource = record(state.roles, 'state.roles', 'INCOMPATIBLE_SOURCE')
  exactKeys(roleSource, FACIAL_ARTWORK_V6_ROLE_IDS, 'state.roles', 'INCOMPATIBLE_SOURCE')
  const roles = {} as Record<FacialArtworkV6RoleId, FacialArtworkV6RoleState>
  for (const role of FACIAL_ARTWORK_V6_ROLE_IDS) {
    roles[role] = parseRoleState(
      roleSource[role],
      role,
      source.templates[role],
      target.templates[role]
    )
  }
  return {
    schemaVersion: TARGET_FACIAL_ARTWORK_STATE_V6,
    definitionSha256: target.definitionSha256,
    templateSet: { ...target.templateSet },
    roles
  }
}

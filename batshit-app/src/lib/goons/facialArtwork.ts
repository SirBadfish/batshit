export const FACIAL_ARTWORK_SCHEMA_VERSION = 'facial-artwork/v2' as const
export const FACIAL_ARTWORK_STATE_SCHEMA_VERSION = 'facial-artwork-state/v2' as const

export const FACIAL_ARTWORK_ROLE_IDS = [
  'brows',
  'lashes_eye_outline',
  'iris',
  'pupil',
  'eye_highlight',
  'sclera'
] as const

export type FacialArtworkRoleId = (typeof FACIAL_ARTWORK_ROLE_IDS)[number]
export type FacialArtworkSide = 'left' | 'right'
export type FacialArtworkBilateralMode = 'shared' | 'per-eye'
export type FacialArtworkMapping = 'planar' | 'radial' | 'longitude'
export type FacialArtworkRgb = [number, number, number]
export type FacialArtworkRgba = [number, number, number, number]

export type FacialArtworkBilateral<T> =
  | { mode: 'shared'; shared: T }
  | { mode: 'per-eye'; left: T; right: T }

export type FacialArtworkPlanarTransform = {
  translateU: number
  translateV: number
  scale: number
  rotationDegrees: number
}

export type FacialArtworkLongitudeTransform = {
  longitudeDegrees: number
}

export type FacialArtworkProvenance = {
  sourceKind: 'batshit-original' | 'user-authored' | 'comfyui-generated' | 'approved-external'
  author: string
  license: string
  rightsConfirmed: true
}

export type FacialArtworkUpload = {
  role: FacialArtworkRoleId
  url: string
  filename: string
  size: number
  mimeType: 'image/png'
  sha256: string
  template: {
    id: string
    version: string
    guideSha256: string
  }
  provenance: FacialArtworkProvenance
}

type FacialArtworkArtworkLayerBase = {
  upload: FacialArtworkUpload
  tint: FacialArtworkRgba
  opacity: number
}

export type FacialArtworkArtworkLayer =
  | (FacialArtworkArtworkLayerBase & {
      mapping: 'planar' | 'radial'
      transform: FacialArtworkPlanarTransform
    })
  | (FacialArtworkArtworkLayerBase & {
      mapping: 'longitude'
      transform: FacialArtworkLongitudeTransform
    })

export type FacialArtworkEyeState = {
  visible: boolean
  baseColor: FacialArtworkRgb | null
  artwork: FacialArtworkArtworkLayer | null
}

export type FacialArtworkRoleState = FacialArtworkBilateral<FacialArtworkEyeState>

export type FacialArtworkStateV2 = {
  schemaVersion: typeof FACIAL_ARTWORK_STATE_SCHEMA_VERSION
  definitionSha256: string
  templateSet: { id: string; version: string }
  roles: Record<FacialArtworkRoleId, FacialArtworkRoleState>
}

export type FacialArtworkTemplate = {
  id: string
  version: string
  dimensions: [number, number]
  guide: { path: string; sha256: string }
  safePaintMask: { path: string; sha256: string }
  transparentBlank: { path: string; sha256: string }
}

export type FacialArtworkRuntimeTarget = {
  runtimeNodes: string[]
  mirrorU: boolean
  mirrorV: boolean
}

export type FacialArtworkPlanarBounds = {
  translateU: [number, number]
  translateV: [number, number]
  scale: [number, number]
  rotationDegrees: [number, number]
}

export type FacialArtworkLongitudeBounds = {
  longitudeDegrees: [number, number]
}

export type FacialArtworkRoleDefinition = {
  id: FacialArtworkRoleId
  template: string
  ownership: 'canvas' | 'lit-surface' | 'lit-overlay'
  mapping: FacialArtworkMapping
  target: Record<FacialArtworkSide, FacialArtworkRuntimeTarget>
  defaultEyeState: FacialArtworkEyeState
  defaultMode: FacialArtworkBilateralMode
  bounds: FacialArtworkPlanarBounds | FacialArtworkLongitudeBounds
}

export type FacialArtworkDefinitionV2 = {
  schemaVersion: typeof FACIAL_ARTWORK_SCHEMA_VERSION
  stateSchemaVersion: typeof FACIAL_ARTWORK_STATE_SCHEMA_VERSION
  productExportApproved: false
  definitionSha256: string
  templateSet: { id: string; version: string }
  templates: FacialArtworkTemplate[]
  roles: FacialArtworkRoleDefinition[]
}

export type FacialArtworkReconciliation = {
  state: FacialArtworkStateV2 | null
  incompatible: boolean
  reason?: string
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const SOURCE_KINDS = new Set<FacialArtworkProvenance['sourceKind']>([
  'batshit-original',
  'user-authored',
  'comfyui-generated',
  'approved-external'
])
const COLOR_ROLES = new Set<FacialArtworkRoleId>(['iris', 'pupil', 'sclera'])
const PUBLIC_PREFIX = 'goons/facial-artwork/v2/'

function fail(message: string): never {
  throw new Error(`[facial-artwork/v2] ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  const accepted = new Set(allowed)
  const extra = Object.keys(value).filter((key) => !accepted.has(key))
  if (extra.length > 0) fail(`${context} contains unsupported fields: ${extra.join(', ')}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${context} must be an object`)
  return value
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') fail(`${context} must be boolean`)
  return value
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function bounded(value: unknown, bounds: [number, number], context: string): number {
  const parsed = finite(value, context)
  if (parsed < bounds[0] || parsed > bounds[1]) {
    fail(`${context} must be inside [${bounds[0]}, ${bounds[1]}]`)
  }
  return parsed
}

function tuple2(value: unknown, context: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail(`${context} must contain two numbers`)
  const result: [number, number] = [finite(value[0], `${context}[0]`), finite(value[1], `${context}[1]`)]
  if (result[0] > result[1]) fail(`${context} minimum must not exceed maximum`)
  return result
}

function rgb(value: unknown, context: string): FacialArtworkRgb {
  if (!Array.isArray(value) || value.length !== 3) fail(`${context} must contain three channels`)
  return value.map((channel, index) => bounded(channel, [0, 1], `${context}[${index}]`)) as FacialArtworkRgb
}

function rgba(value: unknown, context: string): FacialArtworkRgba {
  if (!Array.isArray(value) || value.length !== 4) fail(`${context} must contain four channels`)
  return value.map((channel, index) => bounded(channel, [0, 1], `${context}[${index}]`)) as FacialArtworkRgba
}

function hash(value: unknown, context: string): string {
  const parsed = stringValue(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function publicPath(value: unknown, context: string): string {
  const parsed = stringValue(value, context)
  if (
    !parsed.startsWith(PUBLIC_PREFIX) ||
    parsed.includes('\\') ||
    parsed.split('/').includes('..') ||
    parsed.includes('_private')
  ) {
    fail(`${context} must use the canonical public v2 asset root`)
  }
  return parsed
}

function parseProvenance(value: unknown, context: string): FacialArtworkProvenance {
  const source = record(value, context)
  rejectUnknownKeys(source, ['sourceKind', 'author', 'license', 'rightsConfirmed'], context)
  const sourceKind = stringValue(source.sourceKind, `${context}.sourceKind`) as FacialArtworkProvenance['sourceKind']
  if (!SOURCE_KINDS.has(sourceKind)) fail(`${context}.sourceKind is unsupported`)
  if (source.rightsConfirmed !== true) fail(`${context}.rightsConfirmed must be true`)
  return {
    sourceKind,
    author: stringValue(source.author, `${context}.author`),
    license: stringValue(source.license, `${context}.license`),
    rightsConfirmed: true
  }
}

function parseTemplate(value: unknown, context: string): FacialArtworkTemplate {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'id',
      'version',
      'dimensions',
      'pixelContract',
      'guide',
      'safePaintMask',
      'transparentBlank',
      'landmarks',
      'splits'
    ],
    context
  )
  if (!Array.isArray(source.dimensions) || source.dimensions.length !== 2) {
    fail(`${context}.dimensions must contain width and height`)
  }
  const parseAsset = (assetValue: unknown, assetContext: string, mask = false) => {
    const asset = record(assetValue, assetContext)
    rejectUnknownKeys(asset, mask ? ['path', 'sha256', 'channels', 'paintThreshold'] : ['path', 'sha256'], assetContext)
    if (mask) {
      stringValue(asset.channels, `${assetContext}.channels`)
      const threshold = finite(asset.paintThreshold, `${assetContext}.paintThreshold`)
      if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
        fail(`${assetContext}.paintThreshold must be an integer inside [0, 255]`)
      }
    }
    return {
      path: publicPath(asset.path, `${assetContext}.path`),
      sha256: hash(asset.sha256, `${assetContext}.sha256`)
    }
  }
  const pixelContract = record(source.pixelContract, `${context}.pixelContract`)
  rejectUnknownKeys(
    pixelContract,
    ['format', 'channels', 'colorSpace', 'alpha', 'interlaced'],
    `${context}.pixelContract`
  )
  for (const field of ['format', 'channels', 'colorSpace', 'alpha'] as const) {
    stringValue(pixelContract[field], `${context}.pixelContract.${field}`)
  }
  booleanValue(pixelContract.interlaced, `${context}.pixelContract.interlaced`)
  validateEvidenceValue(source.landmarks, `${context}.landmarks`)
  validateEvidenceValue(source.splits, `${context}.splits`)
  const dimensions: [number, number] = [
    finite(source.dimensions[0], `${context}.dimensions[0]`),
    finite(source.dimensions[1], `${context}.dimensions[1]`)
  ]
  if (!dimensions.every(Number.isInteger) || dimensions.some((entry) => entry <= 0)) {
    fail(`${context}.dimensions must be positive integers`)
  }
  return {
    id: stringValue(source.id, `${context}.id`),
    version: stringValue(source.version, `${context}.version`),
    dimensions,
    guide: parseAsset(source.guide, `${context}.guide`),
    safePaintMask: parseAsset(source.safePaintMask, `${context}.safePaintMask`, true),
    transparentBlank: parseAsset(source.transparentBlank, `${context}.transparentBlank`)
  }
}

function validateEvidenceValue(value: unknown, context: string): void {
  if (value === null) return
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    finite(value, context)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateEvidenceValue(entry, `${context}[${index}]`))
    return
  }
  const source = record(value, context)
  for (const [key, entry] of Object.entries(source)) validateEvidenceValue(entry, `${context}.${key}`)
}

function parseRuntimeTarget(value: unknown, context: string): FacialArtworkRuntimeTarget {
  const source = record(value, context)
  rejectUnknownKeys(source, ['runtimeNodes', 'mirrorU', 'mirrorV'], context)
  if (
    !Array.isArray(source.runtimeNodes) ||
    source.runtimeNodes.length === 0 ||
    source.runtimeNodes.some((node) => typeof node !== 'string' || !node.trim())
  ) {
    fail(`${context}.runtimeNodes must contain exact runtime node names`)
  }
  return {
    runtimeNodes: source.runtimeNodes.map((node, index) =>
      stringValue(node, `${context}.runtimeNodes[${index}]`)
    ),
    mirrorU: booleanValue(source.mirrorU, `${context}.mirrorU`),
    mirrorV: booleanValue(source.mirrorV, `${context}.mirrorV`)
  }
}

function parseBounds(value: unknown, mapping: FacialArtworkMapping, context: string) {
  const source = record(value, context)
  if (mapping === 'longitude') {
    rejectUnknownKeys(source, ['longitudeDegrees'], context)
    return { longitudeDegrees: tuple2(source.longitudeDegrees, `${context}.longitudeDegrees`) }
  }
  rejectUnknownKeys(source, ['translateU', 'translateV', 'scale', 'rotationDegrees'], context)
  const result: FacialArtworkPlanarBounds = {
    translateU: tuple2(source.translateU, `${context}.translateU`),
    translateV: tuple2(source.translateV, `${context}.translateV`),
    scale: tuple2(source.scale, `${context}.scale`),
    rotationDegrees: tuple2(source.rotationDegrees, `${context}.rotationDegrees`)
  }
  if (result.scale[0] <= 0) fail(`${context}.scale minimum must be positive`)
  return result
}

function parseUpload(
  value: unknown,
  role: FacialArtworkRoleDefinition,
  template: FacialArtworkTemplate,
  context: string
): FacialArtworkUpload {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    ['role', 'url', 'filename', 'size', 'mimeType', 'sha256', 'template', 'provenance'],
    context
  )
  if (source.role !== role.id) fail(`${context}.role must equal ${role.id}`)
  if (source.mimeType !== 'image/png') fail(`${context}.mimeType must be image/png`)
  const templateProof = record(source.template, `${context}.template`)
  rejectUnknownKeys(templateProof, ['id', 'version', 'guideSha256'], `${context}.template`)
  if (
    templateProof.id !== template.id ||
    templateProof.version !== template.version ||
    templateProof.guideSha256 !== template.guide.sha256
  ) {
    fail(`${context}.template does not match the bound guide identity`)
  }
  const size = finite(source.size, `${context}.size`)
  if (!Number.isInteger(size) || size <= 0) fail(`${context}.size must be a positive integer`)
  const filename = stringValue(source.filename, `${context}.filename`)
  if (filename.includes('/') || filename.includes('\\')) fail(`${context}.filename must be a basename`)
  return {
    role: role.id,
    url: stringValue(source.url, `${context}.url`),
    filename,
    size,
    mimeType: 'image/png',
    sha256: hash(source.sha256, `${context}.sha256`),
    template: { id: template.id, version: template.version, guideSha256: template.guide.sha256 },
    provenance: parseProvenance(source.provenance, `${context}.provenance`)
  }
}

function parseArtworkLayer(
  value: unknown,
  role: FacialArtworkRoleDefinition,
  template: FacialArtworkTemplate,
  context: string
): FacialArtworkArtworkLayer | null {
  if (value === null) return null
  const source = record(value, context)
  rejectUnknownKeys(source, ['mapping', 'transform', 'upload', 'tint', 'opacity'], context)
  if (source.mapping !== role.mapping) fail(`${context}.mapping must equal ${role.mapping}`)
  const transform = record(source.transform, `${context}.transform`)
  const base = {
    upload: parseUpload(source.upload, role, template, `${context}.upload`),
    tint: rgba(source.tint, `${context}.tint`),
    opacity: bounded(source.opacity, [0, 1], `${context}.opacity`)
  }
  if (role.mapping === 'longitude') {
    rejectUnknownKeys(transform, ['longitudeDegrees'], `${context}.transform`)
    const bounds = role.bounds as FacialArtworkLongitudeBounds
    return {
      ...base,
      mapping: 'longitude',
      transform: {
        longitudeDegrees: bounded(
          transform.longitudeDegrees,
          bounds.longitudeDegrees,
          `${context}.transform.longitudeDegrees`
        )
      }
    }
  }
  rejectUnknownKeys(
    transform,
    ['translateU', 'translateV', 'scale', 'rotationDegrees'],
    `${context}.transform`
  )
  const bounds = role.bounds as FacialArtworkPlanarBounds
  return {
    ...base,
    mapping: role.mapping,
    transform: {
      translateU: bounded(transform.translateU, bounds.translateU, `${context}.transform.translateU`),
      translateV: bounded(transform.translateV, bounds.translateV, `${context}.transform.translateV`),
      scale: bounded(transform.scale, bounds.scale, `${context}.transform.scale`),
      rotationDegrees: bounded(
        transform.rotationDegrees,
        bounds.rotationDegrees,
        `${context}.transform.rotationDegrees`
      )
    }
  }
}

function parseEyeState(
  value: unknown,
  role: FacialArtworkRoleDefinition,
  template: FacialArtworkTemplate,
  context: string
): FacialArtworkEyeState {
  const source = record(value, context)
  rejectUnknownKeys(source, ['visible', 'baseColor', 'artwork'], context)
  const expectsColor = COLOR_ROLES.has(role.id)
  const baseColor = source.baseColor === null ? null : rgb(source.baseColor, `${context}.baseColor`)
  if (expectsColor !== Boolean(baseColor)) {
    fail(`${context}.baseColor must be ${expectsColor ? 'an RGB color' : 'null'} for ${role.id}`)
  }
  const artwork = parseArtworkLayer(source.artwork, role, template, `${context}.artwork`)
  const visible = booleanValue(source.visible, `${context}.visible`)
  if (!expectsColor && visible && !artwork) {
    fail(`${context} cannot be visible without artwork`)
  }
  return { visible, baseColor, artwork }
}

function parseRoleDefinition(
  value: unknown,
  expectedId: FacialArtworkRoleId,
  templates: Map<string, FacialArtworkTemplate>,
  context: string
): FacialArtworkRoleDefinition {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'id',
      'template',
      'ownership',
      'geometryOwnership',
      'side',
      'modes',
      'defaultState',
      'symmetry',
      'submissionBounds',
      'mapping',
      'target',
      'defaultEyeState',
      'defaultMode',
      'bounds'
    ],
    context
  )
  if (source.id !== expectedId) fail(`${context}.id must equal ${expectedId}`)
  const templateId = stringValue(source.template, `${context}.template`)
  const template = templates.get(templateId)
  if (!template) fail(`${context}.template is unknown`)
  stringValue(source.geometryOwnership, `${context}.geometryOwnership`)
  stringValue(source.side, `${context}.side`)
  if (!Array.isArray(source.modes) || source.modes.length === 0) fail(`${context}.modes must be non-empty`)
  source.modes.forEach((mode, index) => stringValue(mode, `${context}.modes[${index}]`))
  validateEvidenceValue(source.defaultState, `${context}.defaultState`)
  validateEvidenceValue(source.symmetry, `${context}.symmetry`)
  parseBounds(source.submissionBounds, 'planar', `${context}.submissionBounds`)
  const ownership = source.ownership
  if (!['canvas', 'lit-surface', 'lit-overlay'].includes(String(ownership))) {
    fail(`${context}.ownership is unsupported`)
  }
  const mapping = source.mapping
  if (!['planar', 'radial', 'longitude'].includes(String(mapping))) {
    fail(`${context}.mapping is unsupported`)
  }
  const targetSource = record(source.target, `${context}.target`)
  rejectUnknownKeys(targetSource, ['left', 'right'], `${context}.target`)
  const defaultMode = source.defaultMode
  if (defaultMode !== 'shared' && defaultMode !== 'per-eye') {
    fail(`${context}.defaultMode is unsupported`)
  }
  const partial: Omit<FacialArtworkRoleDefinition, 'defaultEyeState'> = {
    id: expectedId,
    template: templateId,
    ownership: ownership as FacialArtworkRoleDefinition['ownership'],
    mapping: mapping as FacialArtworkMapping,
    target: {
      left: parseRuntimeTarget(targetSource.left, `${context}.target.left`),
      right: parseRuntimeTarget(targetSource.right, `${context}.target.right`)
    },
    defaultMode: defaultMode as FacialArtworkBilateralMode,
    bounds: parseBounds(source.bounds, mapping as FacialArtworkMapping, `${context}.bounds`)
  }
  const defaultEyeState = parseEyeState(
    source.defaultEyeState,
    partial as FacialArtworkRoleDefinition,
    template,
    `${context}.defaultEyeState`
  )
  if (partial.ownership === 'canvas' && partial.target.left.runtimeNodes.length !== 1) {
    fail(`${context}.target.left must bind one canvas node`)
  }
  if (partial.ownership === 'canvas' && partial.target.right.runtimeNodes.length !== 1) {
    fail(`${context}.target.right must bind one canvas node`)
  }
  return { ...partial, defaultEyeState }
}

function validateRichDefinitionMetadata(source: Record<string, unknown>) {
  stringValue(source.status, 'definition.status')
  const ownership = record(source.ownership, 'definition.ownership')
  rejectUnknownKeys(
    ownership,
    [
      'definition',
      'recipeState',
      'artwork',
      'baseSkinContaminationAllowed',
      'packageArchiveFiles',
      'uploadCategory'
    ],
    'definition.ownership'
  )
  for (const field of ['definition', 'recipeState', 'artwork', 'uploadCategory'] as const) {
    stringValue(ownership[field], `definition.ownership.${field}`)
  }
  booleanValue(ownership.baseSkinContaminationAllowed, 'definition.ownership.baseSkinContaminationAllowed')
  if (!Array.isArray(ownership.packageArchiveFiles) || ownership.packageArchiveFiles.length === 0) {
    fail('definition.ownership.packageArchiveFiles must be non-empty')
  }
  ownership.packageArchiveFiles.forEach((entry, index) =>
    stringValue(entry, `definition.ownership.packageArchiveFiles[${index}]`)
  )

  const stateModel = record(source.stateModel, 'definition.stateModel')
  rejectUnknownKeys(
    stateModel,
    ['roles', 'bilateral', 'sharedMirroring', 'overrideOwnership', 'cleanBreak'],
    'definition.stateModel'
  )
  Object.entries(stateModel).forEach(([key, value]) => stringValue(value, `definition.stateModel.${key}`))

  const eyePackage = record(source.eyeAppearancePackage, 'definition.eyeAppearancePackage')
  rejectUnknownKeys(eyePackage, ['schemaVersion', 'stateSchemaVersion', 'ownership'], 'definition.eyeAppearancePackage')
  if (eyePackage.schemaVersion !== 'eye-appearance/v1') fail('definition.eyeAppearancePackage.schemaVersion is unsupported')
  if (eyePackage.stateSchemaVersion !== 'eye-appearance-state/v1') {
    fail('definition.eyeAppearancePackage.stateSchemaVersion is unsupported')
  }
  stringValue(eyePackage.ownership, 'definition.eyeAppearancePackage.ownership')

  const hashContract = record(source.hashContract, 'definition.hashContract')
  rejectUnknownKeys(
    hashContract,
    ['algorithm', 'fileHashes', 'definitionHash', 'absolutePathsAllowed'],
    'definition.hashContract'
  )
  for (const field of ['algorithm', 'fileHashes', 'definitionHash'] as const) {
    stringValue(hashContract[field], `definition.hashContract.${field}`)
  }
  if (hashContract.absolutePathsAllowed !== false) fail('definition.hashContract.absolutePathsAllowed must be false')

  const provenance = record(source.provenanceContract, 'definition.provenanceContract')
  rejectUnknownKeys(provenance, ['required', 'allowedSourceKinds', 'rightsConfirmedMustBe'], 'definition.provenanceContract')
  if (!Array.isArray(provenance.required) || provenance.required.length === 0) {
    fail('definition.provenanceContract.required must be non-empty')
  }
  provenance.required.forEach((entry, index) =>
    stringValue(entry, `definition.provenanceContract.required[${index}]`)
  )
  if (!Array.isArray(provenance.allowedSourceKinds)) {
    fail('definition.provenanceContract.allowedSourceKinds must be an array')
  }
  const allowedKinds = new Set(
    provenance.allowedSourceKinds.map((entry, index) =>
      stringValue(entry, `definition.provenanceContract.allowedSourceKinds[${index}]`)
    )
  )
  if (allowedKinds.size !== SOURCE_KINDS.size || [...SOURCE_KINDS].some((entry) => !allowedKinds.has(entry))) {
    fail('definition.provenanceContract.allowedSourceKinds does not match the v2 upload contract')
  }
  if (provenance.rightsConfirmedMustBe !== true) {
    fail('definition.provenanceContract.rightsConfirmedMustBe must be true')
  }

  const rendering = record(source.rendering, 'definition.rendering')
  rejectUnknownKeys(
    rendering,
    [
      'canvasAndHighlight',
      'irisPupilAndSclera',
      'effectiveAlpha',
      'visibilityPrecedence',
      'highlightComposition',
      'cornea'
    ],
    'definition.rendering'
  )
  validateEvidenceValue(rendering, 'definition.rendering')

  const topology = record(source.topologyFreeze, 'definition.topologyFreeze')
  rejectUnknownKeys(
    topology,
    [
      'acceptedInputSha256',
      'acceptedProofBlendSha256',
      'acceptedProofReportSha256',
      'generatorDependencies',
      'nodes',
      'openDependency'
    ],
    'definition.topologyFreeze'
  )
  hash(topology.acceptedInputSha256, 'definition.topologyFreeze.acceptedInputSha256')
  hash(topology.acceptedProofBlendSha256, 'definition.topologyFreeze.acceptedProofBlendSha256')
  hash(topology.acceptedProofReportSha256, 'definition.topologyFreeze.acceptedProofReportSha256')
  stringValue(topology.openDependency, 'definition.topologyFreeze.openDependency')
  if (!Array.isArray(topology.generatorDependencies) || !Array.isArray(topology.nodes)) {
    fail('definition.topologyFreeze dependencies and nodes must be arrays')
  }
  topology.generatorDependencies.forEach((entry, index) => {
    const dependency = record(entry, `definition.topologyFreeze.generatorDependencies[${index}]`)
    rejectUnknownKeys(dependency, ['id', 'sha256'], `definition.topologyFreeze.generatorDependencies[${index}]`)
    stringValue(dependency.id, `definition.topologyFreeze.generatorDependencies[${index}].id`)
    hash(dependency.sha256, `definition.topologyFreeze.generatorDependencies[${index}].sha256`)
  })
  topology.nodes.forEach((entry, index) => validateEvidenceValue(entry, `definition.topologyFreeze.nodes[${index}]`))
}

export function parseFacialArtworkDefinition(value: unknown): FacialArtworkDefinitionV2 {
  const source = record(value, 'definition')
  rejectUnknownKeys(
    source,
    [
      'schemaVersion',
      'stateSchemaVersion',
      'status',
      'productExportApproved',
      'definitionSha256',
      'templateSet',
      'templates',
      'roles',
      'ownership',
      'stateModel',
      'eyeAppearancePackage',
      'hashContract',
      'provenanceContract',
      'rendering',
      'topologyFreeze'
    ],
    'definition'
  )
  if (source.schemaVersion !== FACIAL_ARTWORK_SCHEMA_VERSION) {
    fail(`definition.schemaVersion must equal ${FACIAL_ARTWORK_SCHEMA_VERSION}`)
  }
  if (source.stateSchemaVersion !== FACIAL_ARTWORK_STATE_SCHEMA_VERSION) {
    fail(`definition.stateSchemaVersion must equal ${FACIAL_ARTWORK_STATE_SCHEMA_VERSION}`)
  }
  if (source.productExportApproved !== false) {
    fail('definition.productExportApproved must remain false until final clearance')
  }
  validateRichDefinitionMetadata(source)
  const templateSetSource = record(source.templateSet, 'definition.templateSet')
  rejectUnknownKeys(templateSetSource, ['id', 'version'], 'definition.templateSet')
  if (!Array.isArray(source.templates) || source.templates.length === 0) {
    fail('definition.templates must be non-empty')
  }
  const templates = source.templates.map((entry, index) =>
    parseTemplate(entry, `definition.templates[${index}]`)
  )
  const templateMap = new Map(templates.map((template) => [template.id, template]))
  if (templateMap.size !== templates.length) fail('definition.templates contains duplicate ids')
  if (
    !Array.isArray(source.roles) ||
    source.roles.length !== FACIAL_ARTWORK_ROLE_IDS.length
  ) {
    fail('definition.roles must contain exactly the six v2 product roles')
  }
  const roleSources = source.roles as unknown[]
  const roles = FACIAL_ARTWORK_ROLE_IDS.map((id, index) =>
    parseRoleDefinition(roleSources[index], id, templateMap, `definition.roles[${index}]`)
  )
  const claimedNodes = new Set<string>()
  for (const role of roles.filter((entry) => entry.ownership !== 'lit-overlay')) {
    for (const side of ['left', 'right'] as const) {
      for (const node of role.target[side].runtimeNodes) {
        if (claimedNodes.has(node)) fail(`runtime node ${node} has multiple surface owners`)
        claimedNodes.add(node)
      }
    }
  }
  return {
    schemaVersion: FACIAL_ARTWORK_SCHEMA_VERSION,
    stateSchemaVersion: FACIAL_ARTWORK_STATE_SCHEMA_VERSION,
    productExportApproved: false,
    definitionSha256: hash(source.definitionSha256, 'definition.definitionSha256'),
    templateSet: {
      id: stringValue(templateSetSource.id, 'definition.templateSet.id'),
      version: stringValue(templateSetSource.version, 'definition.templateSet.version')
    },
    templates,
    roles
  }
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createDefaultFacialArtworkState(
  definition: FacialArtworkDefinitionV2
): FacialArtworkStateV2 {
  const roles = {} as Record<FacialArtworkRoleId, FacialArtworkRoleState>
  for (const role of definition.roles) {
    const eye = cloneValue(role.defaultEyeState)
    roles[role.id] =
      role.defaultMode === 'shared'
        ? { mode: 'shared', shared: eye }
        : { mode: 'per-eye', left: eye, right: cloneValue(eye) }
  }
  return {
    schemaVersion: FACIAL_ARTWORK_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    templateSet: cloneValue(definition.templateSet),
    roles
  }
}

export function parseFacialArtworkState(
  definition: FacialArtworkDefinitionV2,
  value: unknown
): FacialArtworkStateV2 {
  const source = record(value, 'state')
  rejectUnknownKeys(source, ['schemaVersion', 'definitionSha256', 'templateSet', 'roles'], 'state')
  if (source.schemaVersion !== FACIAL_ARTWORK_STATE_SCHEMA_VERSION) {
    fail(`state.schemaVersion must equal ${FACIAL_ARTWORK_STATE_SCHEMA_VERSION}`)
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('state.definitionSha256 does not match the package definition')
  }
  const templateSet = record(source.templateSet, 'state.templateSet')
  rejectUnknownKeys(templateSet, ['id', 'version'], 'state.templateSet')
  if (
    templateSet.id !== definition.templateSet.id ||
    templateSet.version !== definition.templateSet.version
  ) {
    fail('state.templateSet does not match the package definition')
  }
  const roleSource = record(source.roles, 'state.roles')
  if (
    Object.keys(roleSource).length !== FACIAL_ARTWORK_ROLE_IDS.length ||
    FACIAL_ARTWORK_ROLE_IDS.some((id) => !Object.hasOwn(roleSource, id))
  ) {
    fail('state.roles must contain exactly the six v2 product roles')
  }
  const templates = new Map(definition.templates.map((template) => [template.id, template]))
  const definitions = new Map(definition.roles.map((role) => [role.id, role]))
  const roles = {} as Record<FacialArtworkRoleId, FacialArtworkRoleState>
  for (const id of FACIAL_ARTWORK_ROLE_IDS) {
    const role = definitions.get(id)!
    const template = templates.get(role.template)!
    const raw = record(roleSource[id], `state.roles.${id}`)
    if (raw.mode === 'shared') {
      rejectUnknownKeys(raw, ['mode', 'shared'], `state.roles.${id}`)
      roles[id] = {
        mode: 'shared',
        shared: parseEyeState(raw.shared, role, template, `state.roles.${id}.shared`)
      }
    } else if (raw.mode === 'per-eye') {
      rejectUnknownKeys(raw, ['mode', 'left', 'right'], `state.roles.${id}`)
      roles[id] = {
        mode: 'per-eye',
        left: parseEyeState(raw.left, role, template, `state.roles.${id}.left`),
        right: parseEyeState(raw.right, role, template, `state.roles.${id}.right`)
      }
    } else {
      fail(`state.roles.${id}.mode must be shared or per-eye`)
    }
  }
  return {
    schemaVersion: FACIAL_ARTWORK_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    templateSet: cloneValue(definition.templateSet),
    roles
  }
}

export function reconcileFacialArtworkState(
  definition: FacialArtworkDefinitionV2,
  value: unknown
): FacialArtworkReconciliation {
  if (value === null || value === undefined) return { state: null, incompatible: false }
  try {
    return { state: parseFacialArtworkState(definition, value), incompatible: false }
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

export function resolveFacialArtworkState(
  definition: FacialArtworkDefinitionV2,
  value: FacialArtworkStateV2 | null | undefined
): FacialArtworkStateV2 {
  return value ? parseFacialArtworkState(definition, value) : createDefaultFacialArtworkState(definition)
}

export function resolveFacialArtworkEyeState(
  state: FacialArtworkStateV2,
  roleId: FacialArtworkRoleId,
  side: FacialArtworkSide
): FacialArtworkEyeState {
  const role = state.roles[roleId]
  return role.mode === 'shared' ? role.shared : role[side]
}

export function createFacialArtworkArtworkLayer(
  definition: FacialArtworkDefinitionV2,
  roleId: FacialArtworkRoleId,
  upload: FacialArtworkUpload
): FacialArtworkArtworkLayer {
  const role = definition.roles.find((candidate) => candidate.id === roleId)
  if (!role) fail(`definition has no role ${roleId}`)
  const template = definition.templates.find((candidate) => candidate.id === role.template)
  if (!template) fail(`definition has no template ${role.template}`)
  const parsedUpload = parseUpload(upload, role, template, `upload.${roleId}`)
  const base = {
    upload: parsedUpload,
    tint: [1, 1, 1, 1] as FacialArtworkRgba,
    opacity: 1
  }
  if (role.mapping === 'longitude') {
    return {
      ...base,
      mapping: 'longitude',
      transform: { longitudeDegrees: 0 }
    }
  }
  return {
    ...base,
    mapping: role.mapping,
    transform: { translateU: 0, translateV: 0, scale: 1, rotationDegrees: 0 }
  }
}

export function resolveFacialArtworkAssetUrl(path: string): string {
  return `/${publicPath(path, 'asset path')}`
}

export function collectFacialArtworkUploads(value: FacialArtworkStateV2 | null | undefined) {
  const uploads = new Map<string, FacialArtworkUpload>()
  if (!value) return []
  for (const role of Object.values(value.roles)) {
    const eyes = role.mode === 'shared' ? [role.shared] : [role.left, role.right]
    for (const eye of eyes) {
      const upload = eye.artwork?.upload
      if (upload) uploads.set(upload.filename, upload)
    }
  }
  return [...uploads.values()]
}

export function collectFacialArtworkUploadUrls(value: FacialArtworkStateV2 | null | undefined) {
  return new Set(collectFacialArtworkUploads(value).map((upload) => upload.url))
}

import type { RecipeSourceIdentity } from './recipe/packageMetadata'
import {
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_ROOT_WEIGHTED_MOTION_TAG,
  parseHairMotionSettings,
  type HairMotionSettingsV2
} from './hairMotionSettings'
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256
} from './recipe/recipeCanonical'

export const HAIR_ASSET_CONTRACT = 'hair-assets/v1' as const
export const HAIR_STATE_CONTRACT = 'hair-state/v2' as const
export const HAIR_FIT_RECEIPT_CONTRACT = 'hair-fit-receipt/v1' as const
export const HAIR_MATERIAL_DECLARATION_CONTRACT = 'hair-material-declaration/v1' as const
export const HAIR_FOLLOWER_DECLARATION_CONTRACT = 'hair-follower-declaration/v1' as const
export const HAIR_PHYSICS_DECLARATION_CONTRACT = 'hair-physics-declaration/v1' as const
export const HAIR_ASSET_AUDIT_CONTRACT = 'hair-asset-audit/v1' as const
export const HAIR_REFIT_SOURCE_CONTRACT = 'hair-refit-source/v1' as const
export const HAIR_VALUE_PIVOT = 0.5 as const
export const HAIR_VALUE_HIGHLIGHT_STRENGTH = 0.35 as const

const HAIR_STORAGE_STABLE_SIGNIFICANT_DIGITS = 15

function storageStableMatrixNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be finite`)
  }
  // RedisJSON stores numbers as IEEE-754 doubles but can emit the adjacent
  // shortest decimal for values that use all 16-17 significant digits. Hair
  // revisions hash the attachment matrix, so normalize beyond Three.js fit
  // precision before hashing and before the reviewed candidate is persisted.
  const normalized = Number(value.toPrecision(HAIR_STORAGE_STABLE_SIGNIFICANT_DIGITS))
  return Object.is(normalized, -0) ? 0 : normalized
}

export type HairAssetSourceClass = 'builtin' | 'user'

export type HairAssetFileRefV1 = {
  ref: string
  sha256: string
  bytes: number
  mimeType: string
}

export type HairAssetMaterialDeclarationV1 = {
  contract: typeof HAIR_MATERIAL_DECLARATION_CONTRACT
  status: 'pending' | 'ready'
  definitionSha256: string | null
  layout: {
    width: number
    height: number
    uvSet: 0
    flipY: false
    neutralValue: {
      colorSpace: 'srgb'
      channel: 'rgb'
      pivot: typeof HAIR_VALUE_PIVOT
      highlightStrength: typeof HAIR_VALUE_HIGHLIGHT_STRENGTH
    }
    highlightMask: {
      colorSpace: 'linear'
      channel: 'r'
    }
    normal: {
      colorSpace: 'linear'
      convention: 'opengl'
    } | null
    roughness: {
      colorSpace: 'linear'
      channel: 'g'
    } | null
  } | null
  neutralValueTexture: HairAssetFileRefV1 | null
  highlightMask: HairAssetFileRefV1 | null
  normalTexture: HairAssetFileRefV1 | null
  roughnessTexture: HairAssetFileRefV1 | null
  defaults: {
    baseColor: string
    highlightColor: string
    metalness: number
    roughness: number
    alphaMode: 'OPAQUE'
  }
}

export type HairAssetFollowerDeclarationV1 = {
  contract: typeof HAIR_FOLLOWER_DECLARATION_CONTRACT
  mode: 'appearance-followers/v2' | 'static'
  definitionSha256: string | null
  asset: HairAssetFileRefV1 | null
  staticReason: 'pending-h4-preview-only' | 'approved-short-static' | null
}

export type HairAssetPhysicsDeclarationV1 = {
  contract: typeof HAIR_PHYSICS_DECLARATION_CONTRACT
  mode: 'secondary-motion/v1' | 'static'
  definitionSha256: string | null
  asset: HairAssetFileRefV1 | null
  staticReason: 'pending-h5-preview-only' | 'approved-short-static' | null
}

export type HairAssetAuditV1 = {
  contract: typeof HAIR_ASSET_AUDIT_CONTRACT
  meshCount: number
  vertexCount: number
  triangleCount: number
  materialCount: number
  textureCount: number
  sparseAccent: boolean
  receiptSha256: string
}

export type HairRefitTransformV1 = {
  move: { x: number; y: number; z: number }
  rotate: { x: number; y: number; z: number }
  uniformScale: number
  axisScale: { x: number; y: number; z: number }
}

export type HairRefitSourceV1 = {
  contract: typeof HAIR_REFIT_SOURCE_CONTRACT
  assetId: string
  revisionId: string
  source: HairAssetFileRefV1
  startingTransform: HairRefitTransformV1
  savedTransform: HairRefitTransformV1
}

export type HairFitReceiptV1 = {
  contract: typeof HAIR_FIT_RECEIPT_CONTRACT
  receiptId: string
  assetId: string
  assetRevisionId: string
  assetRevisionSha256: string
  baseId: string
  fitFamily: string
  headAttachmentNode: string
  appearanceDefinitionSha256: string
  physicalBasisSha256: string
  topologySha256: string
  skeletonHierarchySha256: string
  fitSha256: string
}

export type HairAssetV1 = {
  schemaVersion: typeof HAIR_ASSET_CONTRACT
  assetId: string
  revisionId: string
  revision: number
  revisionSha256: string
  sourceClass: HairAssetSourceClass
  display: {
    name: string
    previewImage: HairAssetFileRefV1
    tags: string[]
  }
  compatibility: {
    baseId: string
    fitFamily: string
  }
  geometry: {
    main: HairAssetFileRefV1
    sparseAccent: HairAssetFileRefV1 | null
  }
  attachment: {
    headNode: string
    authoredRootMatrix: number[]
    fitReceipt: HairFitReceiptV1
  }
  material: HairAssetMaterialDeclarationV1
  follower: HairAssetFollowerDeclarationV1
  physics: HairAssetPhysicsDeclarationV1
  audit: HairAssetAuditV1
  provenance: {
    author: string
    license: string
    sourceTool: string
    sourceSha256: string
    catalogEligible: boolean
    productExportApproved: boolean
  }
  receiptRefs: HairAssetFileRefV1[]
}

export type HairAssetSelectionV1 = {
  assetId: string
  assetRevisionId: string
  assetRevision: number
  assetRevisionSha256: string
  fitFamily: string
  fitSha256: string
}

export type HairStateV2 = {
  schemaVersion: typeof HAIR_STATE_CONTRACT
  definitionSha256: string | null
  selected: HairAssetSelectionV1 | null
  baseColor: string
  highlightColor: string
  motionSettings: HairMotionSettingsV2 | null
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const HEX_COLOR_PATTERN = /^#[a-f0-9]{6}$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function fail(message: string): never {
  throw new Error(`[${HAIR_ASSET_CONTRACT}] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${context} must contain exactly: ${wanted.join(', ')}`)
  }
}

function text(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${context} must be a non-empty trimmed string without control characters`)
  }
  return value
}

function stableId(value: unknown, context: string): string {
  const parsed = text(value, context)
  if (!STABLE_ID_PATTERN.test(parsed) || FORBIDDEN_KEYS.has(parsed)) {
    fail(`${context} must be a stable id`)
  }
  return parsed
}

function refitTransform(value: unknown, context: string): HairRefitTransformV1 {
  const raw = record(value, context)
  exactKeys(raw, ['move', 'rotate', 'uniformScale', 'axisScale'], context)
  const vector = (entry: unknown, vectorContext: string) => {
    const source = record(entry, vectorContext)
    exactKeys(source, ['x', 'y', 'z'], vectorContext)
    const components = ['x', 'y', 'z'].map((axis) => source[axis])
    if (
      components.some((component) => typeof component !== 'number' || !Number.isFinite(component))
    ) {
      fail(`${vectorContext} must contain finite XYZ values`)
    }
    return {
      x: components[0] as number,
      y: components[1] as number,
      z: components[2] as number
    }
  }
  if (typeof raw.uniformScale !== 'number' || !Number.isFinite(raw.uniformScale)) {
    fail(`${context}.uniformScale must be finite`)
  }
  return {
    move: vector(raw.move, `${context}.move`),
    rotate: vector(raw.rotate, `${context}.rotate`),
    uniformScale: raw.uniformScale,
    axisScale: vector(raw.axisScale, `${context}.axisScale`)
  }
}

export function parseHairRefitSource(
  value: unknown,
  context = 'Hair refit source'
): HairRefitSourceV1 {
  const raw = record(value, context)
  exactKeys(
    raw,
    ['contract', 'assetId', 'revisionId', 'source', 'startingTransform', 'savedTransform'],
    context
  )
  if (raw.contract !== HAIR_REFIT_SOURCE_CONTRACT) {
    fail(`${context}.contract must equal ${HAIR_REFIT_SOURCE_CONTRACT}`)
  }
  return {
    contract: HAIR_REFIT_SOURCE_CONTRACT,
    assetId: stableId(raw.assetId, `${context}.assetId`),
    revisionId: stableId(raw.revisionId, `${context}.revisionId`),
    source: fileRef(raw.source, `${context}.source`),
    startingTransform: refitTransform(raw.startingTransform, `${context}.startingTransform`),
    savedTransform: refitTransform(raw.savedTransform, `${context}.savedTransform`)
  }
}

function positiveInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail(`${context} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${context} must be a non-negative safe integer`)
  }
  return value
}

function finiteUnit(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${context} must be a finite number between 0 and 1`)
  }
  return value
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') fail(`${context} must be boolean`)
  return value
}

function nullableSha256(value: unknown, context: string): string | null {
  return value === null ? null : requireLowercaseSha256(value, context)
}

function hexColor(value: unknown, context: string): string {
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) {
    fail(`${context} must be a lowercase #rrggbb color`)
  }
  return value
}

function fileRef(value: unknown, context: string): HairAssetFileRefV1 {
  const raw = record(value, context)
  exactKeys(raw, ['ref', 'sha256', 'bytes', 'mimeType'], context)
  const ref = text(raw.ref, `${context}.ref`)
  if (!ref.startsWith('/') || ref.includes('..') || ref.includes('\\')) {
    fail(`${context}.ref must be a root-relative owned asset path`)
  }
  return {
    ref,
    sha256: requireLowercaseSha256(raw.sha256, `${context}.sha256`),
    bytes: positiveInteger(raw.bytes, `${context}.bytes`),
    mimeType: text(raw.mimeType, `${context}.mimeType`)
  }
}

function nullableFileRef(value: unknown, context: string): HairAssetFileRefV1 | null {
  return value === null ? null : fileRef(value, context)
}

function parseMaterial(value: unknown): HairAssetMaterialDeclarationV1 {
  const raw = record(value, 'material')
  exactKeys(
    raw,
    [
      'contract',
      'status',
      'definitionSha256',
      'layout',
      'neutralValueTexture',
      'highlightMask',
      'normalTexture',
      'roughnessTexture',
      'defaults'
    ],
    'material'
  )
  if (raw.contract !== HAIR_MATERIAL_DECLARATION_CONTRACT) {
    fail(`material.contract must equal ${HAIR_MATERIAL_DECLARATION_CONTRACT}`)
  }
  if (raw.status !== 'pending' && raw.status !== 'ready') {
    fail('material.status must be pending or ready')
  }
  const definitionSha256 = nullableSha256(raw.definitionSha256, 'material.definitionSha256')
  const layout = raw.layout === null ? null : parseMaterialLayout(raw.layout)
  const neutralValueTexture = nullableFileRef(
    raw.neutralValueTexture,
    'material.neutralValueTexture'
  )
  const highlightMask = nullableFileRef(raw.highlightMask, 'material.highlightMask')
  if (
    raw.status === 'ready' &&
    (!definitionSha256 || !layout || !neutralValueTexture || !highlightMask)
  ) {
    fail(
      'ready material declarations require a definition hash, texture layout, neutral value texture, and highlight mask'
    )
  }
  const normalTexture = nullableFileRef(raw.normalTexture, 'material.normalTexture')
  const roughnessTexture = nullableFileRef(raw.roughnessTexture, 'material.roughnessTexture')
  if (
    raw.status === 'pending' &&
    (definitionSha256 ||
      layout ||
      neutralValueTexture ||
      highlightMask ||
      normalTexture ||
      roughnessTexture)
  ) {
    fail('pending material declarations cannot claim production material assets')
  }
  if (raw.status === 'ready') {
    for (const [name, ref] of [
      ['neutral value', neutralValueTexture],
      ['Highlight mask', highlightMask],
      ['Normal', normalTexture],
      ['Roughness', roughnessTexture]
    ] as const) {
      if (ref && ref.mimeType !== 'image/png') {
        fail(`material ${name} texture must use image/png`)
      }
    }
    if (Boolean(layout?.normal) !== Boolean(normalTexture)) {
      fail('material.layout.normal and material.normalTexture must both be present or both be null')
    }
    if (Boolean(layout?.roughness) !== Boolean(roughnessTexture)) {
      fail(
        'material.layout.roughness and material.roughnessTexture must both be present or both be null'
      )
    }
  }
  const defaults = record(raw.defaults, 'material.defaults')
  exactKeys(
    defaults,
    ['baseColor', 'highlightColor', 'metalness', 'roughness', 'alphaMode'],
    'material.defaults'
  )
  if (defaults.alphaMode !== 'OPAQUE') {
    fail('material.defaults.alphaMode must be OPAQUE for sculpted main Hair geometry')
  }
  const metalness = finiteUnit(defaults.metalness, 'material.defaults.metalness')
  if (metalness !== 0) {
    fail('material.defaults.metalness must remain 0 for the H3 Hair material contract')
  }
  return {
    contract: HAIR_MATERIAL_DECLARATION_CONTRACT,
    status: raw.status,
    definitionSha256,
    layout,
    neutralValueTexture,
    highlightMask,
    normalTexture,
    roughnessTexture,
    defaults: {
      baseColor: hexColor(defaults.baseColor, 'material.defaults.baseColor'),
      highlightColor: hexColor(defaults.highlightColor, 'material.defaults.highlightColor'),
      metalness,
      roughness: finiteUnit(defaults.roughness, 'material.defaults.roughness'),
      alphaMode: defaults.alphaMode
    }
  }
}

function parseMaterialLayout(
  value: unknown
): NonNullable<HairAssetMaterialDeclarationV1['layout']> {
  const raw = record(value, 'material.layout')
  exactKeys(
    raw,
    ['width', 'height', 'uvSet', 'flipY', 'neutralValue', 'highlightMask', 'normal', 'roughness'],
    'material.layout'
  )
  const width = positiveInteger(raw.width, 'material.layout.width')
  const height = positiveInteger(raw.height, 'material.layout.height')
  if (width !== height || width > 4096 || (width & (width - 1)) !== 0) {
    fail('material.layout dimensions must be one square power-of-two image up to 4096px')
  }
  if (raw.uvSet !== 0 || raw.flipY !== false) {
    fail('material.layout must use UV0 with flipY false')
  }
  const neutralValue = record(raw.neutralValue, 'material.layout.neutralValue')
  exactKeys(
    neutralValue,
    ['colorSpace', 'channel', 'pivot', 'highlightStrength'],
    'material.layout.neutralValue'
  )
  if (
    neutralValue.colorSpace !== 'srgb' ||
    neutralValue.channel !== 'rgb' ||
    neutralValue.pivot !== HAIR_VALUE_PIVOT ||
    neutralValue.highlightStrength !== HAIR_VALUE_HIGHLIGHT_STRENGTH
  ) {
    fail('material.layout.neutralValue does not match the H3 value-master contract')
  }
  const highlightMask = record(raw.highlightMask, 'material.layout.highlightMask')
  exactKeys(highlightMask, ['colorSpace', 'channel'], 'material.layout.highlightMask')
  if (highlightMask.colorSpace !== 'linear' || highlightMask.channel !== 'r') {
    fail('material.layout.highlightMask must use linear red-channel data')
  }
  const normal = raw.normal === null ? null : record(raw.normal, 'material.layout.normal')
  if (normal) {
    exactKeys(normal, ['colorSpace', 'convention'], 'material.layout.normal')
    if (normal.colorSpace !== 'linear' || normal.convention !== 'opengl') {
      fail('material.layout.normal must use linear OpenGL normals')
    }
  }
  const roughness =
    raw.roughness === null ? null : record(raw.roughness, 'material.layout.roughness')
  if (roughness) {
    exactKeys(roughness, ['colorSpace', 'channel'], 'material.layout.roughness')
    if (roughness.colorSpace !== 'linear' || roughness.channel !== 'g') {
      fail('material.layout.roughness must use linear glTF green-channel data')
    }
  }
  return {
    width,
    height,
    uvSet: 0,
    flipY: false,
    neutralValue: {
      colorSpace: 'srgb',
      channel: 'rgb',
      pivot: HAIR_VALUE_PIVOT,
      highlightStrength: HAIR_VALUE_HIGHLIGHT_STRENGTH
    },
    highlightMask: { colorSpace: 'linear', channel: 'r' },
    normal: normal ? { colorSpace: 'linear', convention: 'opengl' } : null,
    roughness: roughness ? { colorSpace: 'linear', channel: 'g' } : null
  }
}

function parseFollower(value: unknown): HairAssetFollowerDeclarationV1 {
  const raw = record(value, 'follower')
  exactKeys(raw, ['contract', 'mode', 'definitionSha256', 'asset', 'staticReason'], 'follower')
  if (raw.contract !== HAIR_FOLLOWER_DECLARATION_CONTRACT) {
    fail(`follower.contract must equal ${HAIR_FOLLOWER_DECLARATION_CONTRACT}`)
  }
  if (raw.mode !== 'appearance-followers/v2' && raw.mode !== 'static') {
    fail('follower.mode is unsupported')
  }
  const definitionSha256 = nullableSha256(raw.definitionSha256, 'follower.definitionSha256')
  const asset = nullableFileRef(raw.asset, 'follower.asset')
  if (asset && asset.mimeType !== 'application/json') {
    fail('follower.asset must use application/json')
  }
  const staticReason = raw.staticReason
  if (
    staticReason !== null &&
    staticReason !== 'pending-h4-preview-only' &&
    staticReason !== 'approved-short-static'
  ) {
    fail('follower.staticReason is unsupported')
  }
  if (
    raw.mode === 'appearance-followers/v2' &&
    (!definitionSha256 || !asset || staticReason !== null)
  ) {
    fail('appearance-followers/v2 requires a definition hash and asset, with no static reason')
  }
  if (raw.mode === 'static' && (definitionSha256 || asset || staticReason === null)) {
    fail('static follower declarations require only an explicit static reason')
  }
  return {
    contract: HAIR_FOLLOWER_DECLARATION_CONTRACT,
    mode: raw.mode,
    definitionSha256,
    asset,
    staticReason
  }
}

function parsePhysics(value: unknown): HairAssetPhysicsDeclarationV1 {
  const raw = record(value, 'physics')
  exactKeys(raw, ['contract', 'mode', 'definitionSha256', 'asset', 'staticReason'], 'physics')
  if (raw.contract !== HAIR_PHYSICS_DECLARATION_CONTRACT) {
    fail(`physics.contract must equal ${HAIR_PHYSICS_DECLARATION_CONTRACT}`)
  }
  if (raw.mode !== 'secondary-motion/v1' && raw.mode !== 'static') {
    fail('physics.mode is unsupported')
  }
  const definitionSha256 = nullableSha256(raw.definitionSha256, 'physics.definitionSha256')
  const asset = nullableFileRef(raw.asset, 'physics.asset')
  if (asset && asset.mimeType !== 'application/json') {
    fail('physics.asset must use application/json')
  }
  const staticReason = raw.staticReason
  if (
    staticReason !== null &&
    staticReason !== 'pending-h5-preview-only' &&
    staticReason !== 'approved-short-static'
  ) {
    fail('physics.staticReason is unsupported')
  }
  if (
    raw.mode === 'secondary-motion/v1' &&
    (!definitionSha256 || !asset || staticReason !== null)
  ) {
    fail('secondary-motion/v1 requires a definition hash and asset, with no static reason')
  }
  if (raw.mode === 'static' && (definitionSha256 || asset || staticReason === null)) {
    fail('static physics declarations require only an explicit static reason')
  }
  return {
    contract: HAIR_PHYSICS_DECLARATION_CONTRACT,
    mode: raw.mode,
    definitionSha256,
    asset,
    staticReason
  }
}

export function parseHairFitReceipt(value: unknown): HairFitReceiptV1 {
  const raw = record(value, 'fit receipt')
  exactKeys(
    raw,
    [
      'contract',
      'receiptId',
      'assetId',
      'assetRevisionId',
      'assetRevisionSha256',
      'baseId',
      'fitFamily',
      'headAttachmentNode',
      'appearanceDefinitionSha256',
      'physicalBasisSha256',
      'topologySha256',
      'skeletonHierarchySha256',
      'fitSha256'
    ],
    'fit receipt'
  )
  if (raw.contract !== HAIR_FIT_RECEIPT_CONTRACT) {
    fail(`fit receipt.contract must equal ${HAIR_FIT_RECEIPT_CONTRACT}`)
  }
  return {
    contract: HAIR_FIT_RECEIPT_CONTRACT,
    receiptId: stableId(raw.receiptId, 'fit receipt.receiptId'),
    assetId: stableId(raw.assetId, 'fit receipt.assetId'),
    assetRevisionId: stableId(raw.assetRevisionId, 'fit receipt.assetRevisionId'),
    assetRevisionSha256: requireLowercaseSha256(
      raw.assetRevisionSha256,
      'fit receipt.assetRevisionSha256'
    ),
    baseId: stableId(raw.baseId, 'fit receipt.baseId'),
    fitFamily: stableId(raw.fitFamily, 'fit receipt.fitFamily'),
    headAttachmentNode: stableId(raw.headAttachmentNode, 'fit receipt.headAttachmentNode'),
    appearanceDefinitionSha256: requireLowercaseSha256(
      raw.appearanceDefinitionSha256,
      'fit receipt.appearanceDefinitionSha256'
    ),
    physicalBasisSha256: requireLowercaseSha256(
      raw.physicalBasisSha256,
      'fit receipt.physicalBasisSha256'
    ),
    topologySha256: requireLowercaseSha256(raw.topologySha256, 'fit receipt.topologySha256'),
    skeletonHierarchySha256: requireLowercaseSha256(
      raw.skeletonHierarchySha256,
      'fit receipt.skeletonHierarchySha256'
    ),
    fitSha256: requireLowercaseSha256(raw.fitSha256, 'fit receipt.fitSha256')
  }
}

export async function hairFitReceiptSha256(value: unknown): Promise<string> {
  const receipt = parseHairFitReceipt(value)
  const { fitSha256: _fitSha256, ...content } = receipt
  return canonicalRecipeSha256(content)
}

export async function verifyHairFitReceipt(value: unknown): Promise<HairFitReceiptV1> {
  const receipt = parseHairFitReceipt(value)
  const actual = await hairFitReceiptSha256(receipt)
  if (actual !== receipt.fitSha256) {
    fail(`fit receipt hash mismatch: expected ${receipt.fitSha256}, got ${actual}`)
  }
  return receipt
}

export function parseHairAsset(value: unknown): HairAssetV1 {
  canonicalRecipeString(value)
  const raw = record(value, 'asset')
  exactKeys(
    raw,
    [
      'schemaVersion',
      'assetId',
      'revisionId',
      'revision',
      'revisionSha256',
      'sourceClass',
      'display',
      'compatibility',
      'geometry',
      'attachment',
      'material',
      'follower',
      'physics',
      'audit',
      'provenance',
      'receiptRefs'
    ],
    'asset'
  )
  if (raw.schemaVersion !== HAIR_ASSET_CONTRACT) {
    fail(`asset.schemaVersion must equal ${HAIR_ASSET_CONTRACT}`)
  }
  if (raw.sourceClass !== 'builtin' && raw.sourceClass !== 'user') {
    fail('asset.sourceClass must be builtin or user')
  }
  const assetId = stableId(raw.assetId, 'asset.assetId')
  const revisionId = stableId(raw.revisionId, 'asset.revisionId')
  const revisionSha256 = requireLowercaseSha256(raw.revisionSha256, 'asset.revisionSha256')

  const display = record(raw.display, 'asset.display')
  exactKeys(display, ['name', 'previewImage', 'tags'], 'asset.display')
  if (!Array.isArray(display.tags)) fail('asset.display.tags must be an array')
  const tags = display.tags.map((tag, index) => stableId(tag, `asset.display.tags[${index}]`))
  if (
    new Set(tags).size !== tags.length ||
    tags.some((tag, index) => index > 0 && tags[index - 1] >= tag)
  ) {
    fail('asset.display.tags must be unique and sorted')
  }

  const compatibility = record(raw.compatibility, 'asset.compatibility')
  exactKeys(compatibility, ['baseId', 'fitFamily'], 'asset.compatibility')

  const geometry = record(raw.geometry, 'asset.geometry')
  exactKeys(geometry, ['main', 'sparseAccent'], 'asset.geometry')

  const attachment = record(raw.attachment, 'asset.attachment')
  exactKeys(attachment, ['headNode', 'authoredRootMatrix', 'fitReceipt'], 'asset.attachment')
  if (
    !Array.isArray(attachment.authoredRootMatrix) ||
    attachment.authoredRootMatrix.length !== 16
  ) {
    fail('asset.attachment.authoredRootMatrix must contain exactly 16 numbers')
  }
  const authoredRootMatrix = attachment.authoredRootMatrix.map((entry, index) =>
    storageStableMatrixNumber(entry, `asset.attachment.authoredRootMatrix[${index}]`)
  )

  const audit = record(raw.audit, 'asset.audit')
  exactKeys(
    audit,
    [
      'contract',
      'meshCount',
      'vertexCount',
      'triangleCount',
      'materialCount',
      'textureCount',
      'sparseAccent',
      'receiptSha256'
    ],
    'asset.audit'
  )
  if (audit.contract !== HAIR_ASSET_AUDIT_CONTRACT) {
    fail(`asset.audit.contract must equal ${HAIR_ASSET_AUDIT_CONTRACT}`)
  }

  const provenance = record(raw.provenance, 'asset.provenance')
  exactKeys(
    provenance,
    ['author', 'license', 'sourceTool', 'sourceSha256', 'catalogEligible', 'productExportApproved'],
    'asset.provenance'
  )
  if (!Array.isArray(raw.receiptRefs) || raw.receiptRefs.length === 0) {
    fail('asset.receiptRefs must contain at least one receipt')
  }
  const receiptRefs = raw.receiptRefs.map((entry, index) =>
    fileRef(entry, `asset.receiptRefs[${index}]`)
  )

  const parsed: HairAssetV1 = {
    schemaVersion: HAIR_ASSET_CONTRACT,
    assetId,
    revisionId,
    revision: positiveInteger(raw.revision, 'asset.revision'),
    revisionSha256,
    sourceClass: raw.sourceClass,
    display: {
      name: text(display.name, 'asset.display.name'),
      previewImage: fileRef(display.previewImage, 'asset.display.previewImage'),
      tags
    },
    compatibility: {
      baseId: stableId(compatibility.baseId, 'asset.compatibility.baseId'),
      fitFamily: stableId(compatibility.fitFamily, 'asset.compatibility.fitFamily')
    },
    geometry: {
      main: fileRef(geometry.main, 'asset.geometry.main'),
      sparseAccent: nullableFileRef(geometry.sparseAccent, 'asset.geometry.sparseAccent')
    },
    attachment: {
      headNode: stableId(attachment.headNode, 'asset.attachment.headNode'),
      authoredRootMatrix,
      fitReceipt: parseHairFitReceipt(attachment.fitReceipt)
    },
    material: parseMaterial(raw.material),
    follower: parseFollower(raw.follower),
    physics: parsePhysics(raw.physics),
    audit: {
      contract: HAIR_ASSET_AUDIT_CONTRACT,
      meshCount: positiveInteger(audit.meshCount, 'asset.audit.meshCount'),
      vertexCount: positiveInteger(audit.vertexCount, 'asset.audit.vertexCount'),
      triangleCount: positiveInteger(audit.triangleCount, 'asset.audit.triangleCount'),
      materialCount: positiveInteger(audit.materialCount, 'asset.audit.materialCount'),
      textureCount: nonNegativeInteger(audit.textureCount, 'asset.audit.textureCount'),
      sparseAccent: booleanValue(audit.sparseAccent, 'asset.audit.sparseAccent'),
      receiptSha256: requireLowercaseSha256(audit.receiptSha256, 'asset.audit.receiptSha256')
    },
    provenance: {
      author: text(provenance.author, 'asset.provenance.author'),
      license: text(provenance.license, 'asset.provenance.license'),
      sourceTool: text(provenance.sourceTool, 'asset.provenance.sourceTool'),
      sourceSha256: requireLowercaseSha256(
        provenance.sourceSha256,
        'asset.provenance.sourceSha256'
      ),
      catalogEligible: booleanValue(provenance.catalogEligible, 'asset.provenance.catalogEligible'),
      productExportApproved: booleanValue(
        provenance.productExportApproved,
        'asset.provenance.productExportApproved'
      )
    },
    receiptRefs
  }

  const ownedPrefix =
    parsed.sourceClass === 'builtin' ? '/goon-assets/hair/' : '/uploads/goon_hair_assets/'
  const allRefs = collectHairAssetFileRefs(parsed)
  if (allRefs.some((entry) => !entry.ref.startsWith(ownedPrefix))) {
    fail(`${parsed.sourceClass} asset refs must remain under ${ownedPrefix}`)
  }
  const fit = parsed.attachment.fitReceipt
  if (
    fit.assetId !== parsed.assetId ||
    fit.assetRevisionId !== parsed.revisionId ||
    fit.assetRevisionSha256 !== parsed.revisionSha256 ||
    fit.baseId !== parsed.compatibility.baseId ||
    fit.fitFamily !== parsed.compatibility.fitFamily ||
    fit.headAttachmentNode !== parsed.attachment.headNode
  ) {
    fail(
      'asset fit receipt does not bind the exact asset revision, fit family, and attachment node'
    )
  }
  if (parsed.audit.sparseAccent !== Boolean(parsed.geometry.sparseAccent)) {
    fail('asset audit sparseAccent does not match geometry')
  }
  if (
    parsed.sourceClass === 'user' &&
    (parsed.provenance.catalogEligible || parsed.provenance.productExportApproved)
  ) {
    fail('user assets cannot claim catalog eligibility or product export approval')
  }
  return parsed
}

export function collectHairAssetFileRefs(assetValue: HairAssetV1): HairAssetFileRefV1[] {
  const refs = [
    assetValue.display.previewImage,
    assetValue.geometry.main,
    assetValue.geometry.sparseAccent,
    assetValue.material.neutralValueTexture,
    assetValue.material.highlightMask,
    assetValue.material.normalTexture,
    assetValue.material.roughnessTexture,
    assetValue.follower.asset,
    assetValue.physics.asset,
    ...assetValue.receiptRefs
  ].filter((entry): entry is HairAssetFileRefV1 => entry !== null)
  const unique = new Map<string, HairAssetFileRefV1>()
  for (const entry of refs) {
    const existing = unique.get(entry.ref)
    if (
      existing &&
      (existing.sha256 !== entry.sha256 ||
        existing.bytes !== entry.bytes ||
        existing.mimeType !== entry.mimeType)
    ) {
      fail(`asset file ref ${entry.ref} has conflicting immutable metadata`)
    }
    unique.set(entry.ref, entry)
  }
  return [...unique.values()].sort((left, right) => left.ref.localeCompare(right.ref))
}

export async function hairAssetRevisionSha256(value: unknown): Promise<string> {
  const asset = parseHairAsset(value)
  const { revisionSha256: _revisionSha256, ...content } = asset
  const fitReceipt = {
    ...content.attachment.fitReceipt,
    assetRevisionSha256: '0'.repeat(64),
    fitSha256: '0'.repeat(64)
  }
  return canonicalRecipeSha256({
    ...content,
    attachment: { ...content.attachment, fitReceipt }
  })
}

export async function hairMaterialDefinitionSha256(value: unknown): Promise<string> {
  const material = parseMaterial(value)
  if (material.status !== 'ready') {
    fail('only ready Hair material declarations have a production definition hash')
  }
  const { definitionSha256: _definitionSha256, ...definition } = material
  return canonicalRecipeSha256(definition)
}

export async function verifyHairAsset(value: unknown): Promise<HairAssetV1> {
  const asset = parseHairAsset(value)
  const [revisionSha256, fitReceipt, materialDefinitionSha256] = await Promise.all([
    hairAssetRevisionSha256(asset),
    verifyHairFitReceipt(asset.attachment.fitReceipt),
    asset.material.status === 'ready'
      ? hairMaterialDefinitionSha256(asset.material)
      : Promise.resolve(null)
  ])
  if (revisionSha256 !== asset.revisionSha256) {
    fail(`asset revision hash mismatch: expected ${asset.revisionSha256}, got ${revisionSha256}`)
  }
  if (fitReceipt.assetRevisionSha256 !== revisionSha256) {
    fail('fit receipt does not bind the verified asset revision')
  }
  if (
    asset.material.status === 'ready' &&
    materialDefinitionSha256 !== asset.material.definitionSha256
  ) {
    fail(
      `Hair material definition hash mismatch: expected ${asset.material.definitionSha256}, got ${materialDefinitionSha256}`
    )
  }
  return asset
}

export function parseHairState(value: unknown): HairStateV2 {
  canonicalRecipeString(value)
  const raw = record(value, 'state')
  exactKeys(
    raw,
    [
      'schemaVersion',
      'definitionSha256',
      'selected',
      'baseColor',
      'highlightColor',
      'motionSettings'
    ],
    'state'
  )
  if (raw.schemaVersion !== HAIR_STATE_CONTRACT) {
    fail(`state.schemaVersion must equal ${HAIR_STATE_CONTRACT}`)
  }
  const definitionSha256 = nullableSha256(raw.definitionSha256, 'state.definitionSha256')
  let selected: HairAssetSelectionV1 | null = null
  if (raw.selected !== null) {
    const selection = record(raw.selected, 'state.selected')
    exactKeys(
      selection,
      [
        'assetId',
        'assetRevisionId',
        'assetRevision',
        'assetRevisionSha256',
        'fitFamily',
        'fitSha256'
      ],
      'state.selected'
    )
    selected = {
      assetId: stableId(selection.assetId, 'state.selected.assetId'),
      assetRevisionId: stableId(selection.assetRevisionId, 'state.selected.assetRevisionId'),
      assetRevision: positiveInteger(selection.assetRevision, 'state.selected.assetRevision'),
      assetRevisionSha256: requireLowercaseSha256(
        selection.assetRevisionSha256,
        'state.selected.assetRevisionSha256'
      ),
      fitFamily: stableId(selection.fitFamily, 'state.selected.fitFamily'),
      fitSha256: requireLowercaseSha256(selection.fitSha256, 'state.selected.fitSha256')
    }
  }
  if ((selected === null) !== (definitionSha256 === null)) {
    fail('state.definitionSha256 and state.selected must both be present or both be null')
  }
  if (selected && selected.assetRevisionSha256 !== definitionSha256) {
    fail('state.definitionSha256 must equal the selected asset revision hash')
  }
  const motionSettings =
    raw.motionSettings === null ? null : parseHairMotionSettings(raw.motionSettings)
  if (!selected && motionSettings) {
    fail('state.motionSettings must be null when Hair selects None')
  }
  return {
    schemaVersion: HAIR_STATE_CONTRACT,
    definitionSha256,
    selected,
    baseColor: hexColor(raw.baseColor, 'state.baseColor'),
    highlightColor: hexColor(raw.highlightColor, 'state.highlightColor'),
    motionSettings
  }
}

export function createHairState(
  assetValue: HairAssetV1 | null,
  settings?: {
    baseColor?: string
    highlightColor?: string
    motionSettings?: HairMotionSettingsV2 | null
  }
): HairStateV2 {
  if (!assetValue) {
    return parseHairState({
      schemaVersion: HAIR_STATE_CONTRACT,
      definitionSha256: null,
      selected: null,
      baseColor: settings?.baseColor ?? '#2a1738',
      highlightColor: settings?.highlightColor ?? '#6f4a8e',
      motionSettings: null
    })
  }
  const asset = parseHairAsset(assetValue)
  return parseHairState({
    schemaVersion: HAIR_STATE_CONTRACT,
    definitionSha256: asset.revisionSha256,
    selected: {
      assetId: asset.assetId,
      assetRevisionId: asset.revisionId,
      assetRevision: asset.revision,
      assetRevisionSha256: asset.revisionSha256,
      fitFamily: asset.compatibility.fitFamily,
      fitSha256: asset.attachment.fitReceipt.fitSha256
    },
    baseColor: settings?.baseColor ?? asset.material.defaults.baseColor,
    highlightColor: settings?.highlightColor ?? asset.material.defaults.highlightColor,
    motionSettings:
      settings?.motionSettings ??
      (asset.physics.mode === 'secondary-motion/v1' &&
      asset.display.tags.includes(HAIR_ROOT_WEIGHTED_MOTION_TAG)
        ? { enabled: true, intensity: HAIR_MOTION_DEFAULT_INTENSITY }
        : null)
  })
}

export async function validateHairStateBinding(input: {
  asset: unknown
  state: unknown
  recipeSource: Pick<
    RecipeSourceIdentity,
    | 'baseId'
    | 'fitFamily'
    | 'definitionSha256'
    | 'physicalBasisSha256'
    | 'topologySha256'
    | 'skeletonHierarchySha256'
  >
}): Promise<{ asset: HairAssetV1; state: HairStateV2 }> {
  const [asset, fitReceipt] = await Promise.all([
    verifyHairAsset(input.asset),
    verifyHairFitReceipt(parseHairAsset(input.asset).attachment.fitReceipt)
  ])
  const state = parseHairState(input.state)
  const selected = state.selected
  if (!selected) fail('a selected Hair Asset is required for a bound Recipe Hair state')
  if (
    selected.assetId !== asset.assetId ||
    selected.assetRevisionId !== asset.revisionId ||
    selected.assetRevision !== asset.revision ||
    selected.assetRevisionSha256 !== asset.revisionSha256 ||
    selected.fitFamily !== asset.compatibility.fitFamily ||
    selected.fitSha256 !== fitReceipt.fitSha256
  ) {
    fail('Hair state does not bind the exact immutable asset revision and fit receipt')
  }
  if (
    asset.compatibility.baseId !== input.recipeSource.baseId ||
    asset.compatibility.fitFamily !== input.recipeSource.fitFamily
  ) {
    fail('Hair Asset is incompatible with this Recipe base or fit family')
  }
  if (
    fitReceipt.appearanceDefinitionSha256 !== input.recipeSource.definitionSha256 ||
    fitReceipt.physicalBasisSha256 !== input.recipeSource.physicalBasisSha256 ||
    fitReceipt.topologySha256 !== input.recipeSource.topologySha256 ||
    fitReceipt.skeletonHierarchySha256 !== input.recipeSource.skeletonHierarchySha256
  ) {
    fail('Hair fit receipt is stale for this Recipe head and Appearance contract')
  }
  if (
    state.motionSettings &&
    (asset.physics.mode !== 'secondary-motion/v1' ||
      !asset.display.tags.includes(HAIR_ROOT_WEIGHTED_MOTION_TAG))
  ) {
    fail('Hair motion settings require a root-weighted secondary-motion style')
  }
  if (
    asset.physics.mode === 'secondary-motion/v1' &&
    !asset.display.tags.includes(HAIR_ROOT_WEIGHTED_MOTION_TAG)
  ) {
    fail('Hair secondary motion revision must be refitted or re-imported for the current motion model')
  }
  return { asset, state }
}

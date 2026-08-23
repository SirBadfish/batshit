import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { unzipSync } from 'fflate'

import {
  HAIR_ASSET_AUDIT_CONTRACT,
  HAIR_ASSET_CONTRACT,
  HAIR_FIT_RECEIPT_CONTRACT,
  HAIR_FOLLOWER_DECLARATION_CONTRACT,
  HAIR_MATERIAL_DECLARATION_CONTRACT,
  HAIR_PHYSICS_DECLARATION_CONTRACT,
  collectHairAssetFileRefs,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  hairMaterialDefinitionSha256,
  verifyHairAsset,
  type HairAssetFileRefV1,
  type HairAssetV1
} from '../src/lib/goons/hairAssets'
import {
  hairBuiltinRevisionRef,
  parseHairBuiltinCatalog,
  type HairBuiltinCatalogV2
} from '../src/lib/goons/hairBuiltinCatalog'
import {
  authorHairImportProposal,
  type HairImportAuthoringResult
} from '../src/lib/goons/hairImportAuthoring'
import {
  canonicalizeHairImportSelection,
  inspectHairImportSource,
  type HairImportCanonicalizationV1,
  type HairImportTransformInput
} from '../src/lib/goons/hairImportIntake'
import type { HairMotionPaintV1 } from '../src/lib/goons/hairMotionPaint'
import {
  RECIPE_SOURCE_CONTRACT,
  verifyRecipeSourceManifest,
  type RecipeSourceIdentity
} from '../src/lib/goons/recipe/packageMetadata'
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
  sha256Hex
} from '../src/lib/goons/recipe/recipeCanonical'
import { verifyRecipeSourceProjectionHashes } from '../src/lib/goons/recipe/sourcePackageProjections'
import {
  buildHairImportRecipeContext,
  proposeHairImportAuthoringInput
} from '../src/lib/server/services/hairImportRecipeContext.server'

export const BUILTIN_HAIR_REFIT_CONTRACT = 'hair-builtin-refit-publication/v1' as const
const ZERO_SHA256 = '0'.repeat(64)
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const ENCODER = new TextEncoder()
const STATIC_HAIR_V1_PREFIX = '/goon-assets/hair/v1/'
const STATIC_HAIR_V2_PREFIX = '/goon-assets/hair/v2/'

const SHAGGY_SOURCE_SHA256 = '602026e974a6844a03793abb33c34d5a9fc0744dd28da2df2c8191c741c5dfde'
const SHAGGY_AUTHORITY_RECEIPT_SHA256 =
  '2a4ceb2b993b6bddd655da7acf35b812fe50bed15b243d7ba01795a52d7a844e'
const BUN_SOURCE_SHA256 = 'a4c0baab026f09b437c4e3e4f36c9f106ee35bffffb2662cd2435b390a4be84c'
const BUN_AUTHORITY_RECEIPT_SHA256 =
  '00ced9d6a9cd6e03b13003b8867c28c4f16cdea4195f0e2c9d59423c1145c29a'

type JsonRecord = Record<string, unknown>

export type BuiltinHairRefitStyleInput = {
  assetId: 'batshit-style-01' | 'batshit-style-02'
  targetDirectory: 'style-01-shaggy-layers-r2' | 'style-02-twisted-bun-r2'
  sourceFilename: string
  sourceBytes: Uint8Array
  authorityReceiptBytes: Uint8Array
  canonicalTransform: HairImportTransformInput | null
  keepObjectIds: string[] | null
  expectedSourceInventory: {
    meshCount: number
    vertexCount: number
    triangleCount: number
  }
  expectedCanonicalInventory: {
    meshCount: number
    vertexCount: number
    triangleCount: number
  }
  motionPaint?: HairMotionPaintV1
}

export type HairBuiltinRefitReceiptV1 = {
  contract: typeof BUILTIN_HAIR_REFIT_CONTRACT
  sourceAsset: ReturnType<typeof hairBuiltinRevisionRef>
  targetRevisionId: string
  recipeSource: RecipeSourceIdentity
  sourceAuthority: {
    sourceSha256: string
    receiptSha256: string
    sourceFilename: string
  }
  canonicalInput: {
    sha256: string
    meshCount: number
    vertexCount: number
    triangleCount: number
  }
  authoring: HairImportAuthoringResult['evidence']
  determinism: {
    independentRuns: 2
    geometrySha256: string
    followerSha256: string
    physicsSha256: string
    proposalSha256: string
    evidenceSha256: string
  }
  topologyPreserved: {
    meshCount: number
    vertexCount: number
    triangleCount: number
  }
}

function fail(message: string): never {
  throw new Error(`[${BUILTIN_HAIR_REFIT_CONTRACT}] ${message}`)
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be one object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`)
  }
  return value as JsonRecord
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value: unknown): Uint8Array {
  return ENCODER.encode(`${canonicalRecipeString(value)}\n`)
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalRecipeString(value)) as T
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function assertHash(bytes: Uint8Array, expected: string, context: string): void {
  const actual = sha256(bytes)
  if (actual !== expected) fail(`${context} hash drifted: expected ${expected}, got ${actual}`)
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${context} must contain exactly: ${wanted.join(', ')}`)
  }
}

function arg(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) fail(`${name} is required`)
  return value
}

function under(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(rel).startsWith(sep))
}

function parseJson(bytes: Uint8Array, context: string): JsonRecord {
  try {
    return record(JSON.parse(UTF8.decode(bytes)) as unknown, context)
  } catch (error) {
    fail(`${context} is not strict UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function verifyExplicitRecipeSource(input: {
  archiveBytes: Uint8Array
  modelBytes: Uint8Array
  manifestBytes: Uint8Array
  expectedModelSha256: string
  expectedDefinitionSha256: string
}): Promise<{ manifest: JsonRecord; identity: RecipeSourceIdentity }> {
  const expectedModelSha256 = requireLowercaseSha256(
    input.expectedModelSha256,
    'expected v38 model SHA-256'
  )
  const expectedDefinitionSha256 = requireLowercaseSha256(
    input.expectedDefinitionSha256,
    'expected v38 Appearance definition SHA-256'
  )
  const archive = unzipSync(input.archiveBytes)
  const entries = Object.keys(archive).sort()
  if (entries.length !== 2 || entries[0] !== 'avatar.glb' || entries[1] !== 'avatar.json') {
    fail('Recipe Source archive must contain exactly avatar.glb and avatar.json')
  }
  if (!bytesEqual(archive['avatar.glb']!, input.modelBytes)) {
    fail('explicit model bytes do not match avatar.glb in the Recipe Source archive')
  }
  if (!bytesEqual(archive['avatar.json']!, input.manifestBytes)) {
    fail('explicit manifest bytes do not match avatar.json in the Recipe Source archive')
  }
  const modelSha256 = await sha256Hex(input.modelBytes)
  if (modelSha256 !== expectedModelSha256) {
    fail(`final v38 model pin mismatch: expected ${expectedModelSha256}, got ${modelSha256}`)
  }
  const manifest = parseJson(input.manifestBytes, 'Recipe source avatar.json')
  const identity = await verifyRecipeSourceManifest(manifest, modelSha256)
  if (identity.contract !== RECIPE_SOURCE_CONTRACT) fail('Recipe Source identity contract is invalid')
  if (identity.definitionSha256 !== expectedDefinitionSha256) {
    fail(
      `final v38 Appearance definition pin mismatch: expected ${expectedDefinitionSha256}, got ${identity.definitionSha256}`
    )
  }
  await verifyRecipeSourceProjectionHashes(identity, manifest, input.modelBytes)
  return { manifest, identity }
}

export function assertCanonicalInventory(
  canonical: HairImportCanonicalizationV1,
  expected: BuiltinHairRefitStyleInput['expectedCanonicalInventory'],
  context: string
): void {
  for (const field of ['meshCount', 'vertexCount', 'triangleCount'] as const) {
    if (canonical.geometry[field] !== expected[field]) {
      fail(
        `${context} canonical ${field} drifted: expected ${expected[field]}, got ${canonical.geometry[field]}`
      )
    }
  }
}

export async function assertDeterministicAuthoringRuns(
  first: HairImportAuthoringResult,
  second: HairImportAuthoringResult,
  context: string
): Promise<HairImportAuthoringResult> {
  const pairs: Array<[string, string, string]> = [
    ['geometry', sha256(first.geometryGlb), sha256(second.geometryGlb)],
    [
      'follower definition',
      await canonicalRecipeSha256(first.followerDefinition),
      await canonicalRecipeSha256(second.followerDefinition)
    ],
    [
      'secondary-motion definition',
      await canonicalRecipeSha256(first.secondaryMotionDefinition),
      await canonicalRecipeSha256(second.secondaryMotionDefinition)
    ],
    ['proposal', await canonicalRecipeSha256(first.proposal), await canonicalRecipeSha256(second.proposal)],
    ['evidence', await canonicalRecipeSha256(first.evidence), await canonicalRecipeSha256(second.evidence)]
  ]
  for (const [label, left, right] of pairs) {
    if (left !== right) fail(`${context} refit is nondeterministic: ${label} differs across runs`)
  }
  return first
}

export function assertGenuineRefitEvidence(input: {
  context: string
  evidence: HairImportAuthoringResult['evidence']
  canonicalSha256: string
  r1GeometrySha256: string
  recipeSource: RecipeSourceIdentity
  topology: BuiltinHairRefitStyleInput['expectedCanonicalInventory']
}): void {
  if (input.evidence.inputHairSha256 !== input.canonicalSha256) {
    fail(`${input.context} authoring evidence does not bind the canonical Hair input`)
  }
  if (
    input.evidence.recipeSourceSha256 !== input.recipeSource.modelSha256 ||
    input.evidence.appearanceDefinitionSha256 !== input.recipeSource.definitionSha256
  ) {
    fail(`${input.context} authoring evidence does not bind the explicit Recipe Source`)
  }
  if (
    input.evidence.outputGeometrySha256 === input.canonicalSha256 ||
    input.evidence.outputGeometrySha256 === input.r1GeometrySha256
  ) {
    fail(`${input.context} produced unchanged/non-refitted geometry`)
  }
  if (
    input.evidence.meshCount !== input.topology.meshCount ||
    input.evidence.vertexCount !== input.topology.vertexCount
  ) {
    fail(`${input.context} authoring topology drifted after canonicalization`)
  }
}

function localRef(targetDirectory: string, filename: string, bytes: Uint8Array, mimeType: string) {
  return {
    ref: `${STATIC_HAIR_V2_PREFIX}${targetDirectory}/${filename}`,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    mimeType
  } satisfies HairAssetFileRefV1
}

function replaceV1Ref(
  ref: HairAssetFileRefV1,
  targetDirectory: string,
  filename: string,
  bytes: Uint8Array
): HairAssetFileRefV1 {
  if (!ref.ref.startsWith(STATIC_HAIR_V1_PREFIX)) {
    fail(`r1 built-in ref escaped ${STATIC_HAIR_V1_PREFIX}: ${ref.ref}`)
  }
  return localRef(targetDirectory, filename, bytes, ref.mimeType)
}

export async function buildR2Asset(input: {
  sourceAsset: HairAssetV1
  targetDirectory: string
  recipeSource: RecipeSourceIdentity
  authoredRootMatrix: number[]
  result: HairImportAuthoringResult
  topology: BuiltinHairRefitStyleInput['expectedCanonicalInventory']
  copied: {
    preview: Uint8Array
    neutralValue: Uint8Array
    highlightMask: Uint8Array
    acceptedSourceReceipt: Uint8Array
  }
  refitReceiptBytes: Uint8Array
}): Promise<HairAssetV1> {
  const source = await verifyHairAsset(input.sourceAsset)
  if (source.sourceClass !== 'builtin' || source.revision !== 1) {
    fail(`${source.assetId} source must be the immutable built-in r1 revision`)
  }
  const revisionId = `${source.assetId}-r2`
  const geometry = localRef(input.targetDirectory, 'geometry.glb', input.result.geometryGlb, 'model/gltf-binary')
  const followerBytes = jsonBytes(input.result.followerDefinition)
  const physicsBytes = jsonBytes(input.result.secondaryMotionDefinition)
  const follower = localRef(
    input.targetDirectory,
    'appearance-followers.json',
    followerBytes,
    'application/json'
  )
  const physics = localRef(
    input.targetDirectory,
    'secondary-motion.json',
    physicsBytes,
    'application/json'
  )
  const preview = replaceV1Ref(
    source.display.previewImage,
    input.targetDirectory,
    'preview.png',
    input.copied.preview
  )
  if (!source.material.neutralValueTexture || !source.material.highlightMask) {
    fail(`${source.assetId} r1 material lacks its accepted neutral/highlight textures`)
  }
  const neutralValue = replaceV1Ref(
    source.material.neutralValueTexture,
    input.targetDirectory,
    'neutral-value.png',
    input.copied.neutralValue
  )
  const highlightMask = replaceV1Ref(
    source.material.highlightMask,
    input.targetDirectory,
    'highlight-mask.png',
    input.copied.highlightMask
  )
  const acceptedSourceReceipt = localRef(
    input.targetDirectory,
    'accepted-source-receipt.json',
    input.copied.acceptedSourceReceipt,
    'application/json'
  )
  const refitReceipt = localRef(
    input.targetDirectory,
    'refit-receipt.json',
    input.refitReceiptBytes,
    'application/json'
  )
  const material = clone(source.material)
  material.neutralValueTexture = neutralValue
  material.highlightMask = highlightMask
  material.definitionSha256 = ZERO_SHA256
  material.definitionSha256 = await hairMaterialDefinitionSha256(material)
  const draft: HairAssetV1 = {
    schemaVersion: HAIR_ASSET_CONTRACT,
    assetId: source.assetId,
    revisionId,
    revision: 2,
    revisionSha256: ZERO_SHA256,
    sourceClass: 'builtin',
    display: { ...clone(source.display), previewImage: preview },
    compatibility: {
      baseId: input.recipeSource.baseId,
      fitFamily: input.recipeSource.fitFamily
    },
    geometry: { main: geometry, sparseAccent: null },
    attachment: {
      headNode: input.result.followerDefinition.headNode,
      authoredRootMatrix: [...input.authoredRootMatrix],
      fitReceipt: {
        contract: HAIR_FIT_RECEIPT_CONTRACT,
        receiptId: `${source.assetId}-fit-r2`,
        assetId: source.assetId,
        assetRevisionId: revisionId,
        assetRevisionSha256: ZERO_SHA256,
        baseId: input.recipeSource.baseId,
        fitFamily: input.recipeSource.fitFamily,
        headAttachmentNode: input.result.followerDefinition.headNode,
        appearanceDefinitionSha256: input.recipeSource.definitionSha256,
        physicalBasisSha256: input.recipeSource.physicalBasisSha256,
        topologySha256: input.recipeSource.topologySha256,
        skeletonHierarchySha256: input.recipeSource.skeletonHierarchySha256,
        fitSha256: ZERO_SHA256
      }
    },
    material: { ...material, contract: HAIR_MATERIAL_DECLARATION_CONTRACT },
    follower: {
      contract: HAIR_FOLLOWER_DECLARATION_CONTRACT,
      mode: 'appearance-followers/v2',
      definitionSha256: input.result.evidence.followerDefinitionSha256,
      asset: follower,
      staticReason: null
    },
    physics: {
      contract: HAIR_PHYSICS_DECLARATION_CONTRACT,
      mode: 'secondary-motion/v1',
      definitionSha256: input.result.evidence.secondaryMotionDefinitionSha256,
      asset: physics,
      staticReason: null
    },
    audit: {
      contract: HAIR_ASSET_AUDIT_CONTRACT,
      meshCount: input.result.evidence.meshCount,
      vertexCount: input.result.evidence.vertexCount,
      triangleCount: input.topology.triangleCount,
      materialCount: 1,
      textureCount: 2,
      sparseAccent: false,
      receiptSha256: refitReceipt.sha256
    },
    provenance: {
      ...clone(source.provenance),
      sourceTool: `${source.provenance.sourceTool} + Batshit deterministic v38 refit`
    },
    receiptRefs: [acceptedSourceReceipt, refitReceipt].sort((left, right) =>
      left.ref.localeCompare(right.ref)
    )
  }
  draft.revisionSha256 = await hairAssetRevisionSha256(draft)
  draft.attachment.fitReceipt.assetRevisionSha256 = draft.revisionSha256
  draft.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(draft.attachment.fitReceipt)
  return verifyHairAsset(draft)
}

export async function buildV2Catalog(r1Assets: HairAssetV1[], r2Assets: HairAssetV1[]) {
  if (r1Assets.length !== 2 || r2Assets.length !== 2) {
    fail('catalog publication requires exactly two r1 assets and two r2 successors')
  }
  const assets = [...r1Assets, ...r2Assets].sort(
    (left, right) => left.assetId.localeCompare(right.assetId) || left.revision - right.revision
  )
  if (assets.some((asset) => asset.sourceClass !== 'builtin')) {
    fail('user-imported Hair cannot enter or interfere with the built-in publication catalog')
  }
  const currentRevisions = [...r2Assets]
    .sort((left, right) => left.assetId.localeCompare(right.assetId))
    .map(hairBuiltinRevisionRef)
  const successorEdges = [...r1Assets]
    .sort((left, right) => left.assetId.localeCompare(right.assetId))
    .map((source) => {
      const target = r2Assets.find((asset) => asset.assetId === source.assetId)
      if (!target) fail(`${source.assetId} has no r2 successor`)
      return { from: hairBuiltinRevisionRef(source), to: hairBuiltinRevisionRef(target) }
    })
  return parseHairBuiltinCatalog({
    schemaVersion: 'hair-catalog/v2',
    assets,
    currentRevisions,
    successorEdges
  } satisfies HairBuiltinCatalogV2)
}

async function sourceFileBytes(staticRoot: string, ref: HairAssetFileRefV1): Promise<Uint8Array> {
  if (!ref.ref.startsWith('/goon-assets/')) fail(`catalog ref is outside /goon-assets: ${ref.ref}`)
  const bytes = new Uint8Array(await readFile(join(staticRoot, ref.ref.slice(1))))
  if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.sha256) {
    fail(`immutable r1 file drifted: ${ref.ref}`)
  }
  return bytes
}

async function refitStyle(input: {
  style: BuiltinHairRefitStyleInput
  sourceAsset: HairAssetV1
  recipeSource: RecipeSourceIdentity
  recipeSourceGlb: Uint8Array
  manifest: JsonRecord
  staticRoot: string
}): Promise<{
  asset: HairAssetV1
  files: Record<string, Uint8Array>
}> {
  const inspection = inspectHairImportSource({
    bytes: input.style.sourceBytes,
    filename: input.style.sourceFilename
  })
  for (const field of ['meshCount', 'vertexCount', 'triangleCount'] as const) {
    if (inspection.geometry[field] !== input.style.expectedSourceInventory[field]) {
      fail(
        `${input.style.assetId} retained source ${field} drifted: expected ${input.style.expectedSourceInventory[field]}, got ${inspection.geometry[field]}`
      )
    }
  }
  const keepObjectIds =
    input.style.keepObjectIds ??
    inspection.inventory.filter((entry) => entry.kind === 'mesh').map((entry) => entry.objectId)
  const canonical = canonicalizeHairImportSelection({
    bytes: input.style.sourceBytes,
    filename: input.style.sourceFilename,
    keepObjectIds,
    transform: input.style.canonicalTransform
  })
  assertCanonicalInventory(canonical, input.style.expectedCanonicalInventory, input.style.assetId)
  const context = buildHairImportRecipeContext({
    recipeSourceGlb: input.recipeSourceGlb,
    appearanceManifest: input.manifest,
    recipeSource: input.recipeSource
  })
  const authoringInput = proposeHairImportAuthoringInput({
    canonical,
    context,
    assetId: input.style.assetId,
    revisionId: `${input.style.assetId}-r2`,
    ...(input.style.motionPaint ? { motionPaint: input.style.motionPaint } : {})
  })
  const result = await assertDeterministicAuthoringRuns(
    await authorHairImportProposal(authoringInput),
    await authorHairImportProposal(authoringInput),
    input.style.assetId
  )
  const canonicalSha256 = sha256(canonical.glbBytes)
  assertGenuineRefitEvidence({
    context: input.style.assetId,
    evidence: result.evidence,
    canonicalSha256,
    r1GeometrySha256: input.sourceAsset.geometry.main.sha256,
    recipeSource: input.recipeSource,
    topology: input.style.expectedCanonicalInventory
  })
  const receipt: HairBuiltinRefitReceiptV1 = {
    contract: BUILTIN_HAIR_REFIT_CONTRACT,
    sourceAsset: hairBuiltinRevisionRef(input.sourceAsset),
    targetRevisionId: `${input.style.assetId}-r2`,
    recipeSource: input.recipeSource,
    sourceAuthority: {
      sourceSha256: sha256(input.style.sourceBytes),
      receiptSha256: sha256(input.style.authorityReceiptBytes),
      sourceFilename: basename(input.style.sourceFilename)
    },
    canonicalInput: {
      sha256: canonicalSha256,
      meshCount: canonical.geometry.meshCount,
      vertexCount: canonical.geometry.vertexCount,
      triangleCount: canonical.geometry.triangleCount
    },
    authoring: result.evidence,
    determinism: {
      independentRuns: 2,
      geometrySha256: result.evidence.outputGeometrySha256,
      followerSha256: await canonicalRecipeSha256(result.followerDefinition),
      physicsSha256: await canonicalRecipeSha256(result.secondaryMotionDefinition),
      proposalSha256: await canonicalRecipeSha256(result.proposal),
      evidenceSha256: await canonicalRecipeSha256(result.evidence)
    },
    topologyPreserved: {
      meshCount: canonical.geometry.meshCount,
      vertexCount: canonical.geometry.vertexCount,
      triangleCount: canonical.geometry.triangleCount
    }
  }
  const r1Receipt = input.sourceAsset.receiptRefs.find((entry) =>
    entry.ref.endsWith('/accepted-source-receipt.json')
  )
  if (!r1Receipt) fail(`${input.style.assetId} r1 has no accepted source receipt`)
  const copied = {
    preview: await sourceFileBytes(input.staticRoot, input.sourceAsset.display.previewImage),
    neutralValue: await sourceFileBytes(input.staticRoot, input.sourceAsset.material.neutralValueTexture!),
    highlightMask: await sourceFileBytes(input.staticRoot, input.sourceAsset.material.highlightMask!),
    acceptedSourceReceipt: await sourceFileBytes(input.staticRoot, r1Receipt)
  }
  const refitReceiptBytes = jsonBytes(receipt)
  const asset = await buildR2Asset({
    sourceAsset: input.sourceAsset,
    targetDirectory: input.style.targetDirectory,
    recipeSource: input.recipeSource,
    authoredRootMatrix: context.authoredRootMatrix,
    result,
    topology: input.style.expectedCanonicalInventory,
    copied,
    refitReceiptBytes
  })
  // The asset audit binds the canonical source triangle inventory, not generated
  // skin/morph accessors. This assignment is explicit because authoring evidence
  // carries mesh/vertex counts but not source triangle count.
  if (asset.audit.triangleCount !== canonical.geometry.triangleCount) {
    fail(`${input.style.assetId} asset audit triangle count drifted from canonical source topology`)
  }
  return {
    asset,
    files: {
      'geometry.glb': result.geometryGlb,
      'appearance-followers.json': jsonBytes(result.followerDefinition),
      'secondary-motion.json': jsonBytes(result.secondaryMotionDefinition),
      'accepted-source-receipt.json': copied.acceptedSourceReceipt,
      'refit-receipt.json': refitReceiptBytes,
      'preview.png': copied.preview,
      'neutral-value.png': copied.neutralValue,
      'highlight-mask.png': copied.highlightMask
    }
  }
}

async function writeAndVerifyStage(input: {
  outputRoot: string
  catalog: HairBuiltinCatalogV2
  products: Array<{ asset: HairAssetV1; files: Record<string, Uint8Array> }>
}): Promise<void> {
  const outputRoot = resolve(input.outputRoot)
  const staticV1Root = resolve(import.meta.dirname, '../static/goon-assets/hair/v1')
  if (under(staticV1Root, outputRoot) || under(outputRoot, staticV1Root)) {
    fail('output may not be the immutable static hair/v1 tree or one of its ancestors')
  }
  try {
    await access(outputRoot)
    fail(`output already exists; immutable staging never overwrites ${outputRoot}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`[${BUILTIN_HAIR_REFIT_CONTRACT}]`)) {
      throw error
    }
  }
  await mkdir(dirname(outputRoot), { recursive: true })
  const temporary = await mkdtemp(join(dirname(outputRoot), '.hair-r2-stage-'))
  try {
    for (const product of input.products) {
      const directory = product.asset.geometry.main.ref
        .slice(STATIC_HAIR_V2_PREFIX.length)
        .split('/')[0]!
      const target = join(temporary, directory)
      await mkdir(target, { recursive: true })
      for (const [filename, bytes] of Object.entries(product.files)) {
        await writeFile(join(target, filename), bytes, { flag: 'wx' })
      }
    }
    await writeFile(join(temporary, 'catalog.json'), jsonBytes(input.catalog), { flag: 'wx' })
    for (const asset of input.catalog.assets.filter((entry) => entry.revision === 2)) {
      for (const ref of collectHairAssetFileRefs(asset)) {
        if (!ref.ref.startsWith(STATIC_HAIR_V2_PREFIX)) fail(`r2 ref escaped v2: ${ref.ref}`)
        const bytes = new Uint8Array(
          await readFile(join(temporary, ref.ref.slice(STATIC_HAIR_V2_PREFIX.length)))
        )
        if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.sha256) {
          fail(`staged file does not match immutable ref ${ref.ref}`)
        }
      }
    }
    await parseHairBuiltinCatalog(parseJson(new Uint8Array(await readFile(join(temporary, 'catalog.json'))), 'staged catalog'))
    await rename(temporary, outputRoot)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '../..')
  const staticRoot = join(root, 'batshit-app/static')
  const archivePath = resolve(arg('--recipe-source'))
  const modelPath = resolve(arg('--model'))
  const manifestPath = resolve(arg('--manifest'))
  const outputRoot = resolve(arg('--output'))
  const r1CatalogPath = resolve(arg('--r1-catalog'))
  const shaggySourcePath = resolve(arg('--shaggy-source'))
  const shaggyReceiptPath = resolve(arg('--shaggy-receipt'))
  const bunSourcePath = resolve(arg('--bun-source'))
  const bunReceiptPath = resolve(arg('--bun-receipt'))
  const [archiveBytes, modelBytes, manifestBytes] = await Promise.all([
    readFile(archivePath).then((bytes) => new Uint8Array(bytes)),
    readFile(modelPath).then((bytes) => new Uint8Array(bytes)),
    readFile(manifestPath).then((bytes) => new Uint8Array(bytes))
  ])
  const recipe = await verifyExplicitRecipeSource({
    archiveBytes,
    modelBytes,
    manifestBytes,
    expectedModelSha256: arg('--expected-model-sha256'),
    expectedDefinitionSha256: arg('--expected-definition-sha256')
  })
  const r1Raw = parseJson(new Uint8Array(await readFile(r1CatalogPath)), 'r1 catalog')
  exactKeys(r1Raw, ['schemaVersion', 'assets'], 'r1 catalog')
  if (r1Raw.schemaVersion !== 'hair-catalog/v1' || !Array.isArray(r1Raw.assets)) {
    fail('r1 catalog must be the immutable hair-catalog/v1 with an assets array')
  }
  const r1Assets = await Promise.all(r1Raw.assets.map((asset) => verifyHairAsset(asset)))
  if (
    r1Assets.length !== 2 ||
    r1Assets.some((asset) => asset.sourceClass !== 'builtin' || asset.revision !== 1) ||
    r1Assets.map((asset) => asset.assetId).sort().join(',') !== 'batshit-style-01,batshit-style-02'
  ) {
    fail('r1 catalog contains missing, extra, imported, or non-r1 Hair revisions')
  }
  const shaggySourceBytes = new Uint8Array(await readFile(shaggySourcePath))
  const shaggyAuthorityReceiptBytes = new Uint8Array(await readFile(shaggyReceiptPath))
  const bunSourceBytes = new Uint8Array(await readFile(bunSourcePath))
  const bunAuthorityReceiptBytes = new Uint8Array(await readFile(bunReceiptPath))
  assertHash(shaggySourceBytes, SHAGGY_SOURCE_SHA256, 'Shaggy accepted fitted source')
  assertHash(
    shaggyAuthorityReceiptBytes,
    SHAGGY_AUTHORITY_RECEIPT_SHA256,
    'Shaggy review receipt'
  )
  assertHash(bunSourceBytes, BUN_SOURCE_SHA256, 'Twisted Bun repaired source')
  assertHash(bunAuthorityReceiptBytes, BUN_AUTHORITY_RECEIPT_SHA256, 'Twisted Bun accepted receipt')
  const shaggyReceipt = parseJson(shaggyAuthorityReceiptBytes, 'Shaggy review receipt')
  const fittedHair = record(shaggyReceipt.fitted_hair, 'Shaggy review receipt.fitted_hair')
  if (fittedHair.sha256 !== SHAGGY_SOURCE_SHA256) {
    fail('Shaggy review receipt does not bind the accepted fitted source')
  }
  const bunReceipt = parseJson(bunAuthorityReceiptBytes, 'Twisted Bun accepted receipt')
  const selection = record(bunReceipt.selection, 'Twisted Bun receipt.selection')
  const transform = record(selection.transform, 'Twisted Bun receipt.selection.transform')
  if (!Array.isArray(selection.keptObjectIds) || !Array.isArray(selection.removedObjectIds)) {
    fail('Twisted Bun receipt has no exact kept/removed object selection')
  }
  const motionPaint = bunReceipt.motionPaint as HairMotionPaintV1
  const styleInputs: BuiltinHairRefitStyleInput[] = [
    {
      assetId: 'batshit-style-01',
      targetDirectory: 'style-01-shaggy-layers-r2',
      sourceFilename: shaggySourcePath,
      sourceBytes: shaggySourceBytes,
      authorityReceiptBytes: shaggyAuthorityReceiptBytes,
      canonicalTransform: null,
      keepObjectIds: null,
      expectedSourceInventory: { meshCount: 49, vertexCount: 14651, triangleCount: 25480 },
      expectedCanonicalInventory: { meshCount: 49, vertexCount: 76440, triangleCount: 25480 }
    },
    {
      assetId: 'batshit-style-02',
      targetDirectory: 'style-02-twisted-bun-r2',
      sourceFilename: bunSourcePath,
      sourceBytes: bunSourceBytes,
      authorityReceiptBytes: bunAuthorityReceiptBytes,
      canonicalTransform: {
        translation: transform.translation as number[],
        rotation: transform.rotation as number[],
        uniformScale: transform.uniformScale as number,
        axisScale: transform.axisScale as number[]
      },
      keepObjectIds: selection.keptObjectIds as string[],
      expectedSourceInventory: { meshCount: 3, vertexCount: 8170, triangleCount: 13018 },
      expectedCanonicalInventory: { meshCount: 2, vertexCount: 34902, triangleCount: 11634 },
      motionPaint
    }
  ]
  const products = []
  for (const style of styleInputs) {
    const sourceAsset = r1Assets.find((asset) => asset.assetId === style.assetId)
    if (!sourceAsset) fail(`${style.assetId} is absent from r1 catalog`)
    if (sourceAsset.provenance.sourceSha256 !== (style.assetId === 'batshit-style-01'
      ? 'ab4e8c9737da31f10921a35a1dfe8875864a713d01a2ed99ea99a237ae4f9168'
      : BUN_SOURCE_SHA256)) {
      fail(`${style.assetId} r1 provenance no longer binds the retained source authority`)
    }
    products.push(
      await refitStyle({
        style,
        sourceAsset,
        recipeSource: recipe.identity,
        recipeSourceGlb: modelBytes,
        manifest: recipe.manifest,
        staticRoot
      })
    )
  }
  const catalog = await buildV2Catalog(
    r1Assets,
    products.map((product) => product.asset)
  )
  await writeAndVerifyStage({ outputRoot, catalog, products })
  process.stdout.write(
    `${canonicalRecipeString({
      contract: BUILTIN_HAIR_REFIT_CONTRACT,
      output: outputRoot,
      recipeModelSha256: recipe.identity.modelSha256,
      appearanceDefinitionSha256: recipe.identity.definitionSha256,
      currentRevisions: catalog.currentRevisions
    })}\n`
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === resolve(import.meta.filename)) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

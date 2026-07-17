import type { GoonRecord } from '$lib/types/goons'
import { redis } from '$lib/server/redis'
import {
  collectGoonRecipeUploadReferencesForClient,
  collectGoonUploadReferencesForClient,
  deleteUnreferencedGoonUploadReferences,
  type GoonAssetReferenceMap
} from './goonAssetCleanupService'
import {
  GOON_LIVE_BUILD_CONTRACT,
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_JOB_CONTRACT,
  GOON_RECIPE_REVISION_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  RECIPE_MIGRATION_PLAN_CONTRACT,
  canonicalRecipeSha256,
  canonicalRecipeString,
  createGoonRecipeDocument,
  createRecipeRevisionEnvelope,
  parseRecipeMigrationPlan,
  recipeAuthoringRevisionSha256,
  recipeDocumentRedisKey,
  recipeJobRedisKey,
  recipeRevisionBundleSha256,
  recipeRevisionRedisKey,
  sha256Hex,
  verifyGoonLiveBuildReceipt,
  verifyGoonRecipeV2,
  verifyRecipeArchiveContainmentReceipt,
  verifyRecipeMigrationReport,
  verifyRecipePackageMetadata,
  verifyRecipeStateSnapshot,
  type AppearanceRecipeMigrationPlannerInput,
  type AppearanceRecipeMigrationSiblingInput,
  type GoonLiveBuildReceipt,
  type GoonRecipeDocument,
  type GoonRecipeJob,
  type GoonRecipeV2,
  type RecipeArchiveContainmentReceipt,
  type RecipeAssetSet,
  type RecipeComponentMapBundle,
  type RecipeDocumentRef,
  type RecipeFailureStage,
  type RecipeMigrationPlan,
  type RecipeRevisionBundle,
  type RecipeRevisionEnvelope,
  type RecipeSiblingSurface,
  type RecipeSource,
  type RecipeStateSnapshot,
  type RecipeStoredAssetRef,
  type RecipeUpdateEdge
} from '$lib/goons/recipe'
import { planAppearanceRecipeMigration } from '$lib/goons/recipe/appearanceRecipeMigrationPlanner'
import {
  compareAndSwapRecipeJobState,
  compareAndSwapRecipeState,
  discardRecipeAnalysisRecords,
  getGoonRecipeDocument,
  getGoonRecipeJob,
  getOwnedRecipeGoon,
  getRecipeRevisionEnvelope,
  putGoonRecipeDocument,
  putRecipeRevisionEnvelope
} from './goonRecipeRepository.server'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl
} from './batshitServerUrls'

const DEFAULT_LEASE_MS = 5 * 60 * 1000
const ZERO_SHA256 = '0'.repeat(64)

export class GoonRecipeLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'GoonRecipeLifecycleError'
  }
}

export type RecipeAssetReader = (asset: RecipeStoredAssetRef) => Promise<Uint8Array>

export type RecipeLifecycleDependencies = {
  now?: () => Date
  readAsset?: RecipeAssetReader
  deleteAsset?: Parameters<typeof deleteUnreferencedGoonUploadReferences>[2]
  leaseOwnerId?: string
  leaseMs?: number
}

export type AnalyzeRecipePackageUpdateInput = {
  userId: string
  goonId: string
  receipt: RecipeArchiveContainmentReceipt
  siblingInputs: Record<RecipeSiblingSurface, AppearanceRecipeMigrationSiblingInput>
  componentMapBundle?: RecipeComponentMapBundle
}

export type RecipePackageUpdateAnalysis = {
  expectedWriteVersion: number
  sourceRevision: RecipeDocumentRef
  containmentReceipt: RecipeDocumentRef
  plan: RecipeMigrationPlan
  planRef: RecipeDocumentRef
}

export type StartRecipePackageUpdateInput = {
  userId: string
  goonId: string
  expectedWriteVersion: number
  idempotencyKey: string
  planRef: RecipeDocumentRef
  containmentReceipt: RecipeDocumentRef
}

export type StageRecipeCandidateInput = {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
  state: RecipeStateSnapshot
  migrationReport: unknown
  liveBuildReceipt: GoonLiveBuildReceipt
  live: RecipeAssetSet
}

type LoadedArchive = {
  receipt: RecipeArchiveContainmentReceipt
  source: RecipeSource
  packageBytes: Uint8Array
  modelBytes: Uint8Array
  manifestBytes: Uint8Array
  manifest: Record<string, unknown>
  metadata: Awaited<ReturnType<typeof verifyRecipePackageMetadata>>
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoonRecipeLifecycleError('INVALID_INPUT', `${context} must be an object.`)
  }
  return value as Record<string, unknown>
}

function cloneGoon(goon: GoonRecord): GoonRecord {
  return structuredClone(goon)
}

function assetFileName(asset: RecipeStoredAssetRef) {
  const filename = asset.ref.split('/').pop()
  if (!filename) {
    throw new GoonRecipeLifecycleError('CORRUPT_ASSET', `Stored asset ${asset.ref} has no filename.`, 500)
  }
  return filename
}

function toGoonFileRef(asset: RecipeStoredAssetRef) {
  return {
    url: asset.ref,
    filename: assetFileName(asset),
    size: asset.bytes
  }
}

function documentRef(document: GoonRecipeDocument): RecipeDocumentRef {
  return {
    contract: document.documentContract,
    ref: recipeDocumentRedisKey(document.userId, document.goonId, document.sha256),
    sha256: document.sha256
  }
}

function revisionRef(userId: string, goonId: string, envelope: RecipeRevisionEnvelope): RecipeDocumentRef {
  return {
    contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    ref: recipeRevisionRedisKey(userId, goonId, envelope.revision.revisionId),
    sha256: envelope.envelopeSha256
  }
}

function pendingJob(job: GoonRecipeJob) {
  return {
    jobId: job.jobId,
    jobRef: recipeJobRedisKey(job.userId, job.goonId, job.jobId),
    status: job.status,
    operation: job.operation,
    targetWriteVersion: job.targetWriteVersion,
    targetRecipeRevision: job.targetRecipeRevision,
    targetRevisionId: job.targetRevisionId
  }
}

function stableInputId(value: string, context: string) {
  const parsed = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed)) {
    throw new GoonRecipeLifecycleError('INVALID_INPUT', `${context} must be a stable id.`)
  }
  return parsed
}

async function defaultReadAsset(asset: RecipeStoredAssetRef): Promise<Uint8Array> {
  const response = await fetch(`${getInternalBatshitServerUrl()}${asset.ref}`, {
    headers: getInternalBatshitServerAuthHeaders()
  })
  if (!response.ok) {
    throw new GoonRecipeLifecycleError(
      'ASSET_UNAVAILABLE',
      `Stored Recipe asset ${asset.ref} could not be read (${response.status}).`,
      response.status === 404 ? 409 : 502
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

function archiveMember(receipt: RecipeArchiveContainmentReceipt, role: 'model' | 'manifest') {
  const member = receipt.members.find((candidate) => candidate.role === role)
  if (!member) {
    throw new GoonRecipeLifecycleError('CORRUPT_RECEIPT', `Recipe receipt is missing ${role}.`, 500)
  }
  return member
}

async function readVerifiedAsset(asset: RecipeStoredAssetRef, readAsset: RecipeAssetReader) {
  const bytes = await readAsset(asset)
  const hash = await sha256Hex(bytes)
  if (bytes.byteLength !== asset.bytes || hash !== asset.sha256) {
    throw new GoonRecipeLifecycleError(
      'ASSET_MISMATCH',
      `Stored Recipe asset ${asset.ref} does not match its immutable byte receipt.`,
      409
    )
  }
  return bytes
}

async function loadArchive(
  receiptValue: unknown,
  readAsset: RecipeAssetReader
): Promise<LoadedArchive> {
  const receipt = await verifyRecipeArchiveContainmentReceipt(receiptValue)
  const model = archiveMember(receipt, 'model')
  const manifestMember = archiveMember(receipt, 'manifest')
  const [packageBytes, modelBytes, manifestBytes] = await Promise.all([
    readVerifiedAsset(receipt.archive, readAsset),
    readVerifiedAsset(model.extracted, readAsset),
    readVerifiedAsset(manifestMember.extracted, readAsset)
  ])
  let manifest: Record<string, unknown>
  try {
    manifest = asRecord(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
      'Stored avatar.json'
    )
  } catch (error) {
    if (error instanceof GoonRecipeLifecycleError) throw error
    throw new GoonRecipeLifecycleError('CORRUPT_MANIFEST', 'Stored avatar.json is not strict UTF-8 JSON.', 409)
  }
  const metadata = await verifyRecipePackageMetadata(manifest, model.sha256)
  return {
    receipt,
    source: {
      package: { ref: receipt.archive.ref, sha256: receipt.archive.sha256 },
      model: { ref: model.extracted.ref, sha256: model.sha256 },
      manifest: { ref: manifestMember.extracted.ref, sha256: manifestMember.sha256 },
      identities: metadata.source
    },
    packageBytes,
    modelBytes,
    manifestBytes,
    manifest,
    metadata
  }
}

function revisionIdFromRef(userId: string, goonId: string, ref: RecipeDocumentRef) {
  if (ref.contract !== GOON_RECIPE_REVISION_ENVELOPE_CONTRACT) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVISION', 'Recipe revision ref has the wrong contract.', 500)
  }
  const prefix = `goon_recipe_revision:${userId}:${goonId}:`
  if (!ref.ref.startsWith(prefix) || ref.ref.length === prefix.length) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVISION', 'Recipe revision ref is outside its owner namespace.', 500)
  }
  return ref.ref.slice(prefix.length)
}

async function loadEnvelopeByRef(userId: string, goonId: string, ref: RecipeDocumentRef) {
  const envelope = await getRecipeRevisionEnvelope(userId, goonId, revisionIdFromRef(userId, goonId, ref))
  if (envelope.envelopeSha256 !== ref.sha256) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVISION', 'Recipe revision ref hash does not match storage.', 500)
  }
  return envelope
}

async function loadDocumentByRef(userId: string, goonId: string, ref: RecipeDocumentRef) {
  const expectedKey = recipeDocumentRedisKey(userId, goonId, ref.sha256)
  if (ref.ref !== expectedKey) {
    throw new GoonRecipeLifecycleError('CORRUPT_DOCUMENT', 'Recipe document ref is outside its owner namespace.', 500)
  }
  const document = await getGoonRecipeDocument(userId, goonId, ref.sha256)
  if (document.documentContract !== ref.contract) {
    throw new GoonRecipeLifecycleError('CORRUPT_DOCUMENT', 'Recipe document contract does not match its ref.', 500)
  }
  return document
}

async function loadArchiveFromDocument(
  userId: string,
  goonId: string,
  ref: RecipeDocumentRef,
  readAsset: RecipeAssetReader
) {
  if (ref.contract !== RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT) {
    throw new GoonRecipeLifecycleError('CORRUPT_RECEIPT', 'Recipe containment ref has the wrong contract.', 500)
  }
  const document = await loadDocumentByRef(userId, goonId, ref)
  return loadArchive(document.content, readAsset)
}

function assertOwnerReadyForAnalysis(owner: GoonRecipeV2) {
  if (owner.liveStatus !== 'up_to_date' || !owner.activeRevision || owner.pendingJob) {
    throw new GoonRecipeLifecycleError(
      'RECIPE_BUSY',
      'Finish, retry, or discard the current Recipe work before analyzing another package update.',
      409
    )
  }
}

function directUpdateEdge(source: RecipeSource, target: LoadedArchive): RecipeUpdateEdge {
  const sourceIdentity = canonicalRecipeString(source.identities)
  const targetIdentity = canonicalRecipeString(target.source.identities)
  const matches = target.metadata.updates.edges.filter(
    (edge) =>
      canonicalRecipeString(edge.from) === sourceIdentity &&
      canonicalRecipeString(edge.to) === targetIdentity
  )
  if (matches.length !== 1) {
    throw new GoonRecipeLifecycleError(
      'UNSUPPORTED_UPDATE_EDGE',
      'The uploaded package does not contain exactly one trusted direct update edge from the active Recipe source.',
      409
    )
  }
  return matches[0]!
}

function lease(dependencies: RecipeLifecycleDependencies, now: Date) {
  const ownerId = stableInputId(dependencies.leaseOwnerId ?? 'recipe-lifecycle', 'lease owner id')
  const leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) {
    throw new GoonRecipeLifecycleError('INVALID_CONFIGURATION', 'Recipe lease duration is invalid.', 500)
  }
  return { ownerId, expiresAt: new Date(now.getTime() + leaseMs).toISOString() }
}

export async function analyzeRecipePackageUpdate(
  input: AnalyzeRecipePackageUpdateInput,
  dependencies: RecipeLifecycleDependencies = {}
): Promise<RecipePackageUpdateAnalysis> {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  assertOwnerReadyForAnalysis(owner)
  const activeEnvelope = await loadEnvelopeByRef(input.userId, input.goonId, owner.activeRevision!)
  if (
    activeEnvelope.revision.revisionId !== owner.authoringRevision.revisionId ||
    activeEnvelope.revision.recipeRevision !== owner.authoringRevision.recipeRevision ||
    canonicalRecipeString(activeEnvelope.revision.source) !==
      canonicalRecipeString(owner.authoringRevision.source) ||
    canonicalRecipeString(activeEnvelope.revision.state) !==
      canonicalRecipeString(owner.authoringRevision.state) ||
    canonicalRecipeString(activeEnvelope.revision.updateReport) !==
      canonicalRecipeString(owner.authoringRevision.updateReport)
  ) {
    throw new GoonRecipeLifecycleError(
      'UNSAVED_RECIPE_CHANGES',
      'Save or discard the current Recipe changes before analyzing a package update.',
      409
    )
  }

  const target = await loadArchive(input.receipt, readAsset)
  const receiptDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: target.receipt
  })
  const storedReceipt = await putGoonRecipeDocument(receiptDocument)
  const targetReceiptRef = documentRef(storedReceipt.document)

  const source = await loadArchiveFromDocument(
    input.userId,
    input.goonId,
    activeEnvelope.sourceContainmentReceipt,
    readAsset
  )
  if (canonicalRecipeString(source.source) !== canonicalRecipeString(activeEnvelope.revision.source)) {
    throw new GoonRecipeLifecycleError(
      'CORRUPT_REVISION',
      'The active revision source does not match its exact extraction receipt.',
      500
    )
  }
  const edge = directUpdateEdge(source.source, target)
  const planId = `plan_${(
    await canonicalRecipeSha256({
      goonId: input.goonId,
      writeVersion: owner.writeVersion,
      sourceRevision: activeEnvelope.revision.revisionSha256,
      targetReceipt: target.receipt.receiptSha256
    })
  ).slice(0, 48)}`
  const plannerInput: AppearanceRecipeMigrationPlannerInput = {
    planId,
    fromRecipeRevision: owner.authoringRevision.recipeRevision,
    toRecipeRevision: owner.nextRecipeRevision,
    edge,
    sourceState: owner.authoringRevision.state,
    sourcePackage: {
      recipeSource: source.source,
      packageBytes: source.packageBytes,
      glbBytes: source.modelBytes,
      manifestBytes: source.manifestBytes
    },
    targetPackage: {
      recipeSource: target.source,
      packageBytes: target.packageBytes,
      glbBytes: target.modelBytes,
      manifestBytes: target.manifestBytes
    },
    siblingInputs: input.siblingInputs,
    ...(input.componentMapBundle ? { componentMapBundle: input.componentMapBundle } : {})
  }
  const plan = await planAppearanceRecipeMigration(plannerInput)
  const planDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: plan
  })
  const storedPlan = await putGoonRecipeDocument(planDocument)
  return {
    expectedWriteVersion: owner.writeVersion,
    sourceRevision: owner.activeRevision!,
    containmentReceipt: targetReceiptRef,
    plan,
    planRef: documentRef(storedPlan.document)
  }
}

async function loadPlan(userId: string, goonId: string, ref: RecipeDocumentRef) {
  if (ref.contract !== RECIPE_MIGRATION_PLAN_CONTRACT) {
    throw new GoonRecipeLifecycleError('INVALID_PLAN', 'Recipe plan ref has the wrong contract.', 400)
  }
  const document = await loadDocumentByRef(userId, goonId, ref)
  const plan = parseRecipeMigrationPlan(document.content)
  const actual = await canonicalRecipeSha256((({ planSha256: _ignored, ...value }) => value)(plan))
  if (actual !== plan.planSha256) {
    throw new GoonRecipeLifecycleError('CORRUPT_PLAN', 'Stored Recipe plan hash is invalid.', 500)
  }
  return plan
}

export async function startRecipePackageUpdate(
  input: StartRecipePackageUpdateInput,
  dependencies: RecipeLifecycleDependencies = {}
) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const idempotencyKey = stableInputId(input.idempotencyKey, 'idempotency key')
  if (owner.pendingJob) {
    const existing = await getGoonRecipeJob(input.userId, input.goonId, owner.pendingJob.jobId)
    if (
      existing.idempotencyKey === idempotencyKey &&
      existing.plan?.ref === input.planRef.ref &&
      existing.stagedSource.containmentReceipt.ref === input.containmentReceipt.ref
    ) {
      return { goon, job: existing, replayed: true }
    }
  }
  assertOwnerReadyForAnalysis(owner)
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError(
      'WRITE_CONFLICT',
      'The Recipe changed after analysis. Analyze the package again.',
      409
    )
  }
  const plan = await loadPlan(input.userId, input.goonId, input.planRef)
  if (!plan.proposedState || plan.outcome.readiness !== 'ready') {
    throw new GoonRecipeLifecycleError(
      'UPDATE_NOT_READY',
      'This analysis is not eligible for Update & Rebuild. Review its blocked or reset-required result.',
      409
    )
  }
  if (
    plan.fromRecipeRevision !== owner.authoringRevision.recipeRevision ||
    plan.toRecipeRevision !== owner.nextRecipeRevision ||
    canonicalRecipeString(plan.fromSource) !== canonicalRecipeString(owner.authoringRevision.source) ||
    plan.fromStateSha256 !== owner.authoringRevision.state.stateSha256
  ) {
    throw new GoonRecipeLifecycleError('STALE_PLAN', 'The Recipe plan no longer matches the active authoring revision.', 409)
  }
  const target = await loadArchiveFromDocument(
    input.userId,
    input.goonId,
    input.containmentReceipt,
    readAsset
  )
  if (canonicalRecipeString(target.source) !== canonicalRecipeString(plan.toSource)) {
    throw new GoonRecipeLifecycleError('CORRUPT_PLAN', 'The Recipe plan target differs from its extraction receipt.', 500)
  }

  const now = (dependencies.now ?? (() => new Date()))()
  const jobHash = await canonicalRecipeSha256({
    userId: input.userId,
    goonId: input.goonId,
    idempotencyKey,
    planSha256: plan.planSha256,
    targetReceiptSha256: target.receipt.receiptSha256,
    targetRecipeRevision: owner.nextRecipeRevision
  })
  const jobId = `recipe_job_${jobHash.slice(0, 40)}`
  const targetRevisionId = `recipe_revision_${owner.nextRecipeRevision}_${jobHash.slice(0, 24)}`
  const nextWriteVersion = owner.writeVersion + 1
  const job: GoonRecipeJob = {
    contract: GOON_RECIPE_JOB_CONTRACT,
    userId: input.userId,
    goonId: input.goonId,
    jobId,
    idempotencyKey,
    operation: 'package-update',
    status: 'baking',
    stateVersion: 1,
    attempt: 1,
    targetWriteVersion: nextWriteVersion,
    targetRecipeRevision: owner.nextRecipeRevision,
    targetRevisionId,
    sourceRevision: owner.activeRevision,
    stagedSource: {
      source: target.source,
      containmentReceipt: input.containmentReceipt
    },
    plan: input.planRef,
    candidateRevision: null,
    lease: lease(dependencies, now),
    failure: null,
    cleanupAssets: [
      target.receipt.archive,
      archiveMember(target.receipt, 'model').extracted,
      archiveMember(target.receipt, 'manifest').extracted
    ].sort((left, right) => left.ref.localeCompare(right.ref)),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    nextRecipeRevision: owner.nextRecipeRevision + 1,
    liveStatus: 'building',
    pendingJob: pendingJob(job),
    lastFailure: null
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: null,
    nextGoon,
    nextJob: job
  })
  return { goon: stored, job }
}

export async function discardRecipePackageAnalysis(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
  planRef: RecipeDocumentRef
  containmentReceipt: RecipeDocumentRef
}, dependencies: RecipeLifecycleDependencies = {}) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  assertOwnerReadyForAnalysis(owner)
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError('WRITE_CONFLICT', 'The Recipe changed after analysis.', 409)
  }
  const [plan, target, active] = await Promise.all([
    loadPlan(input.userId, input.goonId, input.planRef),
    loadArchiveFromDocument(input.userId, input.goonId, input.containmentReceipt, readAsset),
    loadEnvelopeByRef(input.userId, input.goonId, owner.activeRevision!)
  ])
  if (
    canonicalRecipeString(plan.fromSource) !== canonicalRecipeString(owner.authoringRevision.source) ||
    canonicalRecipeString(plan.toSource) !== canonicalRecipeString(target.source) ||
    active.sourceContainmentReceipt.ref === input.containmentReceipt.ref
  ) {
    throw new GoonRecipeLifecycleError(
      'INVALID_ANALYSIS',
      'The analysis does not belong to the current Recipe update review.',
      409
    )
  }
  const candidates: GoonAssetReferenceMap = new Map()
  for (const asset of [
    target.receipt.archive,
    archiveMember(target.receipt, 'model').extracted,
    archiveMember(target.receipt, 'manifest').extracted
  ]) {
    const parts = asset.ref.split('/').filter(Boolean)
    candidates.set(`${parts[1]}/${parts[2]}`, new Set(['discarded Recipe analysis']))
  }
  await discardRecipeAnalysisRecords({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    planRef: input.planRef.ref,
    containmentReceiptRef: input.containmentReceipt.ref
  })
  const remaining = await redis.execute((client: any) =>
    collectGoonUploadReferencesForClient(client, input.userId)
  )
  const deletedAssets = await deleteUnreferencedGoonUploadReferences(
    candidates,
    remaining,
    dependencies.deleteAsset
  )
  return { discarded: true, deletedAssets }
}

function assertJobSnapshot(
  owner: GoonRecipeV2,
  job: GoonRecipeJob,
  expectedWriteVersion: number,
  expectedJobStateVersion: number
) {
  if (
    owner.writeVersion !== expectedWriteVersion ||
    job.stateVersion !== expectedJobStateVersion ||
    owner.pendingJob?.jobId !== job.jobId ||
    owner.pendingJob.status !== job.status
  ) {
    throw new GoonRecipeLifecycleError(
      'WRITE_CONFLICT',
      'The Recipe job changed while this operation was in progress. Reload it before retrying.',
      409
    )
  }
}

function assertLeaseCurrent(job: GoonRecipeJob, now: Date) {
  if (!job.lease || Date.parse(job.lease.expiresAt) <= now.getTime()) {
    throw new GoonRecipeLifecycleError(
      'LEASE_EXPIRED',
      'The Recipe job lease expired. Recover the interrupted job before continuing.',
      409
    )
  }
}

function uniqueSortedAssets(assets: RecipeStoredAssetRef[]) {
  const byRef = new Map<string, RecipeStoredAssetRef>()
  for (const asset of assets) {
    const previous = byRef.get(asset.ref)
    if (previous && canonicalRecipeString(previous) !== canonicalRecipeString(asset)) {
      throw new GoonRecipeLifecycleError('CORRUPT_ASSET', `Asset ref ${asset.ref} has conflicting receipts.`, 500)
    }
    byRef.set(asset.ref, asset)
  }
  return [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref))
}

function edgeForPlan(plan: RecipeMigrationPlan, archive: LoadedArchive) {
  const matches = archive.metadata.updates.edges.filter(
    (edge) => edge.directEdgeKey === plan.directEdgeKey && edge.edgeSha256 === plan.edgeSha256
  )
  if (matches.length !== 1) {
    throw new GoonRecipeLifecycleError('CORRUPT_PLAN', 'The staged target no longer contains the planned update edge.', 500)
  }
  return matches[0]!
}

function assertLiveReceiptBindings(
  job: GoonRecipeJob,
  state: RecipeStateSnapshot,
  receipt: GoonLiveBuildReceipt,
  live: RecipeAssetSet
) {
  const source = job.stagedSource.source
  const expectedSource = {
    revisionId: job.targetRevisionId,
    revision: job.targetRecipeRevision,
    packageSha256: source.package.sha256,
    modelSha256: source.model.sha256,
    manifestSha256: source.manifest.sha256,
    definitionSha256: source.identities.definitionSha256,
    neutralRecipeSha256: source.identities.neutralRecipeSha256,
    basisSha256: source.identities.physicalBasisSha256
  }
  if (canonicalRecipeString(receipt.source) !== canonicalRecipeString(expectedSource)) {
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_MISMATCH',
      'The Live-build receipt does not bind the staged Recipe source and allocated revision.',
      409
    )
  }
  if (receipt.state.contract !== state.contract || receipt.state.sha256 !== state.stateSha256) {
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_MISMATCH',
      'The Live-build receipt does not bind the staged Recipe State.',
      409
    )
  }
  for (const role of ['package', 'model', 'manifest'] as const) {
    if (
      receipt.output[role].sha256 !== live[role].sha256 ||
      receipt.output[role].bytes !== live[role].bytes
    ) {
      throw new GoonRecipeLifecycleError(
        'CANDIDATE_MISMATCH',
        `The Live-build ${role} output does not match its stored asset receipt.`,
        409
      )
    }
  }
}

async function createRevisionBundle(input: {
  job: GoonRecipeJob
  state: RecipeStateSnapshot
  liveBuildReceipt: RecipeDocumentRef
  updateReport: RecipeDocumentRef
}) {
  const candidate: RecipeRevisionBundle = {
    contract: GOON_RECIPE_REVISION_CONTRACT,
    recipeRevision: input.job.targetRecipeRevision,
    revisionId: input.job.targetRevisionId,
    revisionSha256: ZERO_SHA256,
    source: input.job.stagedSource.source,
    state: input.state,
    liveBuildReceipt: input.liveBuildReceipt,
    updateReport: input.updateReport
  }
  candidate.revisionSha256 = await recipeRevisionBundleSha256(candidate)
  return candidate
}

async function createAuthoringRevision(revision: RecipeRevisionBundle) {
  const authoring = {
    contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
    recipeRevision: revision.recipeRevision,
    revisionId: revision.revisionId,
    revisionSha256: ZERO_SHA256,
    source: revision.source,
    state: revision.state,
    updateReport: revision.updateReport
  }
  authoring.revisionSha256 = await recipeAuthoringRevisionSha256(authoring)
  return authoring
}

export async function stageRecipeUpdateCandidate(
  input: StageRecipeCandidateInput,
  dependencies: RecipeLifecycleDependencies = {}
) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  assertJobSnapshot(owner, job, input.expectedWriteVersion, input.expectedJobStateVersion)
  if (!['baking', 'packaging', 'verifying'].includes(job.status)) {
    throw new GoonRecipeLifecycleError('INVALID_JOB_STATE', `Cannot stage a candidate from ${job.status}.`, 409)
  }
  assertLeaseCurrent(job, now)
  if (!job.plan) {
    throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Package-update job is missing its immutable plan.', 500)
  }
  const plan = await loadPlan(input.userId, input.goonId, job.plan)
  const state = await verifyRecipeStateSnapshot(input.state)
  if (!plan.proposedState || canonicalRecipeString(state) !== canonicalRecipeString(plan.proposedState)) {
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_MISMATCH',
      'The staged Recipe State differs from the reviewed migration plan.',
      409
    )
  }
  const target = await loadArchiveFromDocument(
    input.userId,
    input.goonId,
    job.stagedSource.containmentReceipt,
    readAsset
  )
  if (canonicalRecipeString(target.source) !== canonicalRecipeString(job.stagedSource.source)) {
    throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Staged source differs from its extraction receipt.', 500)
  }
  const edge = edgeForPlan(plan, target)
  const report = await verifyRecipeMigrationReport(input.migrationReport, edge)
  if (
    report.fromRecipeRevision !== plan.fromRecipeRevision ||
    plan.toRecipeRevision !== job.targetRecipeRevision ||
    report.toRecipeRevision !== job.targetRecipeRevision
  ) {
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_MISMATCH',
      'The migration report does not bind the allocated Recipe revision.',
      409
    )
  }
  const liveBuildReceipt = await verifyGoonLiveBuildReceipt(input.liveBuildReceipt)
  await Promise.all([
    readVerifiedAsset(input.live.package, readAsset),
    readVerifiedAsset(input.live.model, readAsset),
    readVerifiedAsset(input.live.manifest, readAsset)
  ])
  assertLiveReceiptBindings(job, state, liveBuildReceipt, input.live)

  const reportDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: report
  })
  const buildDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: liveBuildReceipt
  })
  const [storedReport, storedBuild] = await Promise.all([
    putGoonRecipeDocument(reportDocument),
    putGoonRecipeDocument(buildDocument)
  ])
  const reportRef = documentRef(storedReport.document)
  const buildRef = documentRef(storedBuild.document)
  const revision = await createRevisionBundle({
    job,
    state,
    liveBuildReceipt: buildRef,
    updateReport: reportRef
  })
  const envelope = await createRecipeRevisionEnvelope({
    contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    revision,
    sourceContainmentReceipt: job.stagedSource.containmentReceipt,
    live: input.live
  })
  await putRecipeRevisionEnvelope(input.userId, input.goonId, envelope)
  const nextWriteVersion = owner.writeVersion + 1
  const nextJob: GoonRecipeJob = {
    ...job,
    status: 'ready',
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    candidateRevision: revisionRef(input.userId, input.goonId, envelope),
    lease: null,
    failure: null,
    cleanupAssets: uniqueSortedAssets([
      ...job.cleanupAssets,
      input.live.package,
      input.live.model,
      input.live.manifest
    ]),
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: 'building',
    pendingJob: pendingJob(nextJob),
    latestUpdateReport: reportRef,
    lastFailure: null
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  return { goon: stored, job: nextJob, envelope }
}

async function claimReadyJobForCommit(input: {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
}, dependencies: RecipeLifecycleDependencies) {
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  assertJobSnapshot(owner, job, input.expectedWriteVersion, input.expectedJobStateVersion)
  if (job.status !== 'ready' || !job.candidateRevision) {
    throw new GoonRecipeLifecycleError('INVALID_JOB_STATE', 'Only a verified ready candidate can commit.', 409)
  }
  const nextWriteVersion = owner.writeVersion + 1
  const nextJob: GoonRecipeJob = {
    ...job,
    status: 'committing',
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    lease: lease(dependencies, now),
    failure: null,
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: 'building',
    pendingJob: pendingJob(nextJob),
    lastFailure: null
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  return { goon: stored, owner: stored.recipe as GoonRecipeV2, job: nextJob }
}

export async function verifyCompleteRecipeRevision(
  userId: string,
  goonId: string,
  ref: RecipeDocumentRef,
  readAsset: RecipeAssetReader = defaultReadAsset
) {
  const envelope = await loadEnvelopeByRef(userId, goonId, ref)
  const source = await loadArchiveFromDocument(userId, goonId, envelope.sourceContainmentReceipt, readAsset)
  if (canonicalRecipeString(source.source) !== canonicalRecipeString(envelope.revision.source)) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVISION', 'Revision source differs from its extraction receipt.', 500)
  }
  const buildDocument = await loadDocumentByRef(userId, goonId, envelope.revision.liveBuildReceipt)
  if (buildDocument.documentContract !== GOON_LIVE_BUILD_CONTRACT) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVISION', 'Revision Live-build receipt contract is invalid.', 500)
  }
  const buildReceipt = await verifyGoonLiveBuildReceipt(buildDocument.content)
  await Promise.all([
    readVerifiedAsset(envelope.live.package, readAsset),
    readVerifiedAsset(envelope.live.model, readAsset),
    readVerifiedAsset(envelope.live.manifest, readAsset)
  ])
  assertLiveReceiptBindings(
    {
      targetRevisionId: envelope.revision.revisionId,
      targetRecipeRevision: envelope.revision.recipeRevision,
      stagedSource: { source: envelope.revision.source }
    } as GoonRecipeJob,
    envelope.revision.state,
    buildReceipt,
    envelope.live
  )
  if (envelope.revision.updateReport) {
    await loadDocumentByRef(userId, goonId, envelope.revision.updateReport)
  }
  return envelope
}

function applyRevisionToGoon(goon: GoonRecord, envelope: RecipeRevisionEnvelope) {
  goon.customAvatar = {
    ...(goon.customAvatar ?? {}),
    package: toGoonFileRef(envelope.live.package),
    model: toGoonFileRef(envelope.live.model),
    manifest: toGoonFileRef(envelope.live.manifest)
  }
  delete goon.customAvatar.pending
  delete goon.customAvatar.backup
  goon.appearanceDials = envelope.revision.state.appearanceDials
  const siblingFor = (contract: string, ids: string[]) =>
    envelope.revision.state.siblings.find(
      (sibling) => sibling.contract === contract || ids.includes(sibling.id)
    )?.state
  const facialArtwork = siblingFor('facial-artwork-state/v3', ['facial-artwork', 'facialArtwork'])
  const eyeAppearance = siblingFor('eye-appearance-state/v1', ['eye-appearance', 'eyeAppearance'])
  if (facialArtwork) goon.facialArtwork = facialArtwork as GoonRecord['facialArtwork']
  else delete goon.facialArtwork
  if (eyeAppearance) goon.eyeAppearance = eyeAppearance as GoonRecord['eyeAppearance']
  else delete goon.eyeAppearance
}

export async function commitRecipeUpdate(input: {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
}, dependencies: RecipeLifecycleDependencies = {}) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const claimed = await claimReadyJobForCommit(input, dependencies)
  const goon = claimed.goon
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = claimed.job
  assertLeaseCurrent(job, (dependencies.now ?? (() => new Date()))())
  if (!job.candidateRevision) {
    throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Committing job lost its candidate revision.', 500)
  }
  const envelope = await verifyCompleteRecipeRevision(
    input.userId,
    input.goonId,
    job.candidateRevision,
    readAsset
  )
  const authoringRevision = await createAuthoringRevision(envelope.revision)
  const now = (dependencies.now ?? (() => new Date()))()
  const nextWriteVersion = owner.writeVersion + 1
  const committedJob: GoonRecipeJob = {
    ...job,
    status: 'committed',
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    lease: null,
    failure: null,
    cleanupAssets: [],
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  applyRevisionToGoon(nextGoon, envelope)
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: 'up_to_date',
    authoringRevision,
    activeRevision: job.candidateRevision,
    previousRevision: owner.activeRevision,
    pendingJob: null,
    latestUpdateReport: envelope.revision.updateReport,
    lastFailure: null,
    maintenanceFailure: null
  }
  let stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob: committedJob
  })
  let cleanup: Awaited<ReturnType<typeof pruneRecipeRetention>> | null = null
  let cleanupError: string | null = null
  try {
    cleanup = await pruneRecipeRetention(input.userId, input.goonId, {
      deleteAsset: dependencies.deleteAsset
    })
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : 'Recipe retention cleanup failed.'
    stored = await recordRecipeMaintenanceFailure(stored, cleanupError, dependencies)
  }
  return { goon: stored, job: committedJob, envelope, cleanup, cleanupError }
}

const LEASED_STATUSES = new Set([
  'validating',
  'planning',
  'baking',
  'packaging',
  'verifying',
  'committing'
])

export async function recoverInterruptedRecipeJob(input: {
  userId: string
  goonId: string
  jobId: string
}, dependencies: RecipeLifecycleDependencies = {}) {
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  if (job.status === 'interrupted') return { goon, job, recovered: false }
  if (!LEASED_STATUSES.has(job.status) || !job.lease || Date.parse(job.lease.expiresAt) > now.getTime()) {
    return { goon, job, recovered: false }
  }
  if (owner.pendingJob?.jobId !== job.jobId) {
    throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Expired Recipe job is not owned by the Goon.', 500)
  }
  const nextWriteVersion = owner.writeVersion + 1
  const failure = {
    stage: 'restart' as const,
    reason: `Recipe ${job.status} work was interrupted before its lease completed.`,
    reportRef: null
  }
  const nextJob: GoonRecipeJob = {
    ...job,
    status: 'interrupted',
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    lease: null,
    failure,
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: 'interrupted',
    pendingJob: pendingJob(nextJob),
    lastFailure: failure
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  return { goon: stored, job: nextJob, recovered: true }
}

const NEXT_ACTIVE_STAGE = new Map([
  ['validating', 'planning'],
  ['planning', 'baking'],
  ['baking', 'packaging'],
  ['packaging', 'verifying']
] as const)

export async function advanceRecipeJobStage(input: {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
  nextStatus: 'planning' | 'baking' | 'packaging' | 'verifying'
}, dependencies: RecipeLifecycleDependencies = {}) {
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  assertJobSnapshot(owner, job, input.expectedWriteVersion, input.expectedJobStateVersion)
  assertLeaseCurrent(job, now)
  if (NEXT_ACTIVE_STAGE.get(job.status as 'validating') !== input.nextStatus) {
    throw new GoonRecipeLifecycleError(
      'INVALID_JOB_STATE',
      `Recipe job cannot move directly from ${job.status} to ${input.nextStatus}.`,
      409
    )
  }
  const nextWriteVersion = owner.writeVersion + 1
  const nextJob: GoonRecipeJob = {
    ...job,
    status: input.nextStatus,
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    lease: lease(dependencies, now),
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: 'building',
    pendingJob: pendingJob(nextJob),
    lastFailure: null
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  return { goon: stored, job: nextJob }
}

export async function failRecipeJob(input: {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
  stage: RecipeFailureStage
  reason: string
  reportRef?: RecipeDocumentRef | null
}, dependencies: RecipeLifecycleDependencies = {}) {
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  assertJobSnapshot(owner, job, input.expectedWriteVersion, input.expectedJobStateVersion)
  if (!LEASED_STATUSES.has(job.status)) {
    throw new GoonRecipeLifecycleError('INVALID_JOB_STATE', `Recipe job cannot fail from ${job.status}.`, 409)
  }
  assertLeaseCurrent(job, now)
  const reason = input.reason.trim()
  if (!reason) throw new GoonRecipeLifecycleError('INVALID_INPUT', 'Recipe failure reason is required.')
  if (input.reportRef) await loadDocumentByRef(input.userId, input.goonId, input.reportRef)
  const nextWriteVersion = owner.writeVersion + 1
  const failure = { stage: input.stage, reason, reportRef: input.reportRef ?? null }
  const nextJob: GoonRecipeJob = {
    ...job,
    status: 'failed',
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    lease: null,
    failure,
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: 'failed',
    pendingJob: pendingJob(nextJob),
    lastFailure: failure
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  return { goon: stored, job: nextJob }
}

export async function retryRecipeJob(input: {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
}, dependencies: RecipeLifecycleDependencies = {}) {
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  assertJobSnapshot(owner, job, input.expectedWriteVersion, input.expectedJobStateVersion)
  if (job.status !== 'failed' && job.status !== 'interrupted') {
    throw new GoonRecipeLifecycleError('INVALID_JOB_STATE', 'Only failed or interrupted Recipe work can retry.', 409)
  }
  const nextWriteVersion = owner.writeVersion + 1
  const status = job.candidateRevision ? 'ready' as const : 'baking' as const
  if (!job.candidateRevision && !job.plan) {
    throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Recipe job has no durable plan to retry.', 500)
  }
  const nextJob: GoonRecipeJob = {
    ...job,
    status,
    stateVersion: job.stateVersion + 1,
    attempt: job.attempt + 1,
    targetWriteVersion: nextWriteVersion,
    lease: status === 'baking' ? lease(dependencies, now) : null,
    failure: null,
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: 'building',
    pendingJob: pendingJob(nextJob),
    lastFailure: null
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  return { goon: stored, job: nextJob }
}

export async function discardRecipeJob(input: {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
}, dependencies: RecipeLifecycleDependencies = {}) {
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  assertJobSnapshot(owner, job, input.expectedWriteVersion, input.expectedJobStateVersion)
  if (!['ready', 'failed', 'interrupted'].includes(job.status)) {
    throw new GoonRecipeLifecycleError(
      'INVALID_JOB_STATE',
      'Stop or recover active Recipe work before discarding it.',
      409
    )
  }
  const nextWriteVersion = owner.writeVersion + 1
  const nextJob: GoonRecipeJob = {
    ...job,
    status: 'discarded',
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    lease: null,
    failure: null,
    cleanupAssets: [],
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    liveStatus: owner.activeRevision ? 'up_to_date' : 'needs_bake',
    pendingJob: null,
    lastFailure: null
  }
  let stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  let cleanup: Awaited<ReturnType<typeof pruneRecipeRetention>> | null = null
  let cleanupError: string | null = null
  try {
    cleanup = await pruneRecipeRetention(input.userId, input.goonId, {
      deleteAsset: dependencies.deleteAsset
    })
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : 'Recipe discard cleanup failed.'
    stored = await recordRecipeMaintenanceFailure(stored, cleanupError, dependencies)
  }
  return { goon: stored, job: nextJob, cleanup, cleanupError }
}

export async function restorePreviousRecipeRevision(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
}, dependencies: RecipeLifecycleDependencies = {}) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError('WRITE_CONFLICT', 'The Recipe changed before rollback.', 409)
  }
  if (owner.pendingJob) {
    throw new GoonRecipeLifecycleError('RECIPE_BUSY', 'Finish or discard current Recipe work before rollback.', 409)
  }
  if (!owner.activeRevision || !owner.previousRevision) {
    throw new GoonRecipeLifecycleError('NO_PREVIOUS_REVISION', 'No complete previous Recipe revision is available.', 409)
  }
  const [active, previous] = await Promise.all([
    verifyCompleteRecipeRevision(input.userId, input.goonId, owner.activeRevision, readAsset),
    verifyCompleteRecipeRevision(input.userId, input.goonId, owner.previousRevision, readAsset)
  ])
  const authoringRevision = await createAuthoringRevision(previous.revision)
  const now = (dependencies.now ?? (() => new Date()))()
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  applyRevisionToGoon(nextGoon, previous)
  nextGoon.recipe = {
    ...owner,
    writeVersion: owner.writeVersion + 1,
    liveStatus: 'up_to_date',
    authoringRevision,
    activeRevision: owner.previousRevision,
    previousRevision: owner.activeRevision,
    latestUpdateReport: previous.revision.updateReport,
    lastFailure: null,
    maintenanceFailure: null
  }
  let stored = await compareAndSwapRecipeState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    nextGoon
  })
  let cleanup: Awaited<ReturnType<typeof pruneRecipeRetention>> | null = null
  let cleanupError: string | null = null
  try {
    cleanup = await pruneRecipeRetention(input.userId, input.goonId, {
      deleteAsset: dependencies.deleteAsset
    })
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : 'Recipe rollback cleanup failed.'
    stored = await recordRecipeMaintenanceFailure(stored, cleanupError, dependencies)
  }
  return { goon: stored, restored: previous, replaced: active, cleanup, cleanupError }
}

async function recordRecipeMaintenanceFailure(
  goon: GoonRecord,
  reason: string,
  dependencies: RecipeLifecycleDependencies
) {
  try {
    const owner = await verifyGoonRecipeV2(goon.recipe)
    const nextGoon = cloneGoon(goon)
    nextGoon.updated_at = (dependencies.now ?? (() => new Date()))().toISOString()
    nextGoon.recipe = {
      ...owner,
      writeVersion: owner.writeVersion + 1,
      maintenanceFailure: {
        stage: 'cleanup',
        reason,
        reportRef: null
      }
    }
    return await compareAndSwapRecipeState({
      userId: goon.user_id,
      goonId: goon.id,
      expectedWriteVersion: owner.writeVersion,
      nextGoon
    })
  } catch (error) {
    console.error('[Recipe lifecycle] Failed to persist cleanup failure:', error)
    return goon
  }
}

function collectRecipeRecordRefs(value: unknown, target: Set<string>, seen = new Set<unknown>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const child of value) collectRecipeRecordRefs(child, target, seen)
    return
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.ref === 'string' &&
    (record.ref.startsWith('goon_recipe_revision:') ||
      record.ref.startsWith('goon_recipe_document:') ||
      record.ref.startsWith('goon_recipe_job:'))
  ) {
    target.add(record.ref)
  }
  for (const child of Object.values(record)) collectRecipeRecordRefs(child, target, seen)
}

export async function pruneRecipeRetention(
  userId: string,
  goonId: string,
  options: { deleteAsset?: Parameters<typeof deleteUnreferencedGoonUploadReferences>[2] } = {}
) {
  const result = await redis.execute(async (client: any) => {
    const goon = await client.json.get(`goon:${goonId}`) as GoonRecord | null
    if (!goon || goon.user_id !== userId) {
      throw new GoonRecipeLifecycleError('NOT_FOUND', 'Goon not found for Recipe retention.', 404)
    }
    const owner = await verifyGoonRecipeV2(goon.recipe)
    const patterns = [
      `goon_recipe_revision:${userId}:${goonId}:*`,
      `goon_recipe_document:${userId}:${goonId}:*`,
      `goon_recipe_job:${userId}:${goonId}:*`
    ]
    const keys = Array.from(new Set((await Promise.all(patterns.map((pattern) => client.keys(pattern)))).flat()))
      .sort((left: string, right: string) => left.localeCompare(right)) as string[]
    const values = new Map<string, unknown>()
    for (const key of keys) values.set(key, await client.json.get(key))
    const reachable = new Set<string>()
    collectRecipeRecordRefs(owner, reachable)
    const queue = [...reachable]
    while (queue.length > 0) {
      const key = queue.shift()!
      const value = values.get(key)
      if (value === undefined) {
        throw new GoonRecipeLifecycleError(
          'CORRUPT_REVISION_GRAPH',
          `Recipe owner references missing record ${key}.`,
          500
        )
      }
      const discovered = new Set<string>()
      collectRecipeRecordRefs(value, discovered)
      for (const ref of discovered) {
        if (reachable.has(ref)) continue
        reachable.add(ref)
        queue.push(ref)
      }
    }
    const unreachable = keys.filter((key) => !reachable.has(key))
    const candidates = await collectGoonRecipeUploadReferencesForClient(client, userId, goonId)
    if (unreachable.length > 0) await client.del(unreachable)
    const remaining = await collectGoonUploadReferencesForClient(client, userId)
    return { unreachable, candidates, remaining }
  })
  const deletedAssets = await deleteUnreferencedGoonUploadReferences(
    result.candidates as GoonAssetReferenceMap,
    result.remaining as GoonAssetReferenceMap,
    options.deleteAsset
  )
  return { deletedRecords: result.unreachable, deletedAssets }
}

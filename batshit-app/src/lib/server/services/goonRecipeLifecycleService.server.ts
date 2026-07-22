import type { GoonRecord } from '$lib/types/goons'
import { parseAppearanceDialsManifest } from '$lib/goons/appearanceDials.schema'
import type { GoonCustomAvatarManifest } from '$lib/goons/customAvatar'
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
  RECIPE_MIGRATION_REPORT_CONTRACT,
  RECIPE_REVIEWED_STATE_CONTRACT,
  RECIPE_STRICT_TOLERANCES,
  RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT,
  appearanceRecipeControlInventory,
  applyRecipeRevisionProjection,
  canonicalRecipeSha256,
  canonicalRecipeString,
  computeAnatomyFitRecipeState,
  bakeLiveGoon,
  createGoonRecipeDocument,
  createRecipeRevisionEnvelope,
  parseRecipeMigrationPlan,
  parseRecipeUpdateAnalysisContext,
  recipeAuthoringRevisionSha256,
  recipeDocumentRedisKey,
  recipeJobRedisKey,
  recipeRevisionBundleSha256,
  recipeRevisionRedisKey,
  recipeMigrationReportSha256,
  sha256Hex,
  verifyGoonLiveBuildReceipt,
  verifyLiveGoonBakeArtifacts,
  verifyGoonRecipeV2,
  verifyRecipeArchiveContainmentReceipt,
  verifyRecipeMigrationReport,
  verifyRecipeReviewedState,
  verifyRecipeUpdateAnalysisContext,
  deserializeRecipeSiblingInputs,
  serializeRecipeSiblingInputs,
  verifyRecipePackageMetadata,
  verifyRecipeStateSnapshot,
  withoutAnatomyFitRecipeSibling,
  type AppearanceRecipeMigrationPlannerInput,
  type AppearanceRecipeMigrationSiblingInput,
  type GoonLiveBuildReceipt,
  type GoonRecipeDocument,
  type GoonRecipeJob,
  type GoonRecipeV2,
  type RecipeAnalysisHydration,
  type RecipeArchiveContainmentReceipt,
  type RecipeAssetSet,
  type RecipeComponentMapBundle,
  type RecipeDocumentRef,
  type RecipeFailureStage,
  type RecipeMigrationPlan,
  type RecipeMigrationReport,
  type RecipeMigrationReportExpectation,
  type RecipeReviewedState,
  type RecipeRevisionBundle,
  type RecipeRevisionEnvelope,
  type RecipeSiblingSurface,
  type RecipeSource,
  type RecipeStateSnapshot,
  type RecipeStoredAssetRef,
  type RecipeUpdateEdge
} from '$lib/goons/recipe'
import {
  planAppearanceRecipeCleanReset,
  planAppearanceRecipeMigration
} from '$lib/goons/recipe/appearanceRecipeMigrationPlanner'
import {
  compareAndSwapRecipeJobState,
  compareAndSwapRecipeState,
  discardRecipeAnalysisRecords,
  getGoonRecipeDocument,
  getGoonRecipeJob,
  getOwnedRecipeGoon,
  getOwnedGoonForRecipeBootstrap,
  getRecipeRevisionEnvelope,
  createRecipeBootstrapManagedSnapshot,
  putGoonRecipeDocument,
  putRecipeRevisionEnvelope,
  initializeRecipeState
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
  planMigration?: typeof planAppearanceRecipeMigration
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
  goon: GoonRecord
  owner: GoonRecipeV2
  pendingAnalysis: NonNullable<GoonRecipeV2['pendingAnalysis']>
  plan: RecipeMigrationPlan
  basePlan: RecipeMigrationPlan
  report: RecipeMigrationReport
  receipt: RecipeArchiveContainmentReceipt
  reviewedState: RecipeReviewedState | null
}

export type StartRecipePackageUpdateInput = {
  userId: string
  goonId: string
  expectedWriteVersion: number
  idempotencyKey: string
  analysisId: string
}

export type StartRecipeBakeInput = {
  userId: string
  goonId: string
  expectedWriteVersion: number
  idempotencyKey: string
  state: RecipeStateSnapshot
}

export type StageRecipeCandidateInput = {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
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

async function verifyStoredLiveArtifacts(
  live: RecipeAssetSet,
  receipt: GoonLiveBuildReceipt,
  readAsset: RecipeAssetReader
) {
  const [packageBytes, modelBytes, manifestBytes] = await Promise.all([
    readVerifiedAsset(live.package, readAsset),
    readVerifiedAsset(live.model, readAsset),
    readVerifiedAsset(live.manifest, readAsset)
  ])
  try {
    return await verifyLiveGoonBakeArtifacts({
      packageBytes,
      modelBytes,
      manifestBytes,
      receipt
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown Live artifact verification failure'
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_MISMATCH',
      `The stored Live Goon failed structural verification: ${message}`,
      409
    )
  }
}

async function verifyDeterministicLiveBake(input: {
  archive: LoadedArchive
  revisionId: string
  revision: number
  state: RecipeStateSnapshot
  receipt: GoonLiveBuildReceipt
}) {
  let expected: Awaited<ReturnType<typeof bakeLiveGoon>>
  try {
    expected = await bakeLiveGoon({
      source: input.archive.source,
      sourceRevision: { revisionId: input.revisionId, revision: input.revision },
      state: input.state,
      packageBytes: input.archive.packageBytes,
      modelBytes: input.archive.modelBytes,
      manifestBytes: input.archive.manifestBytes
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown deterministic bake failure'
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_MISMATCH',
      `The server could not reproduce the staged Live Goon: ${message}`,
      409
    )
  }
  if (canonicalRecipeString(expected.receipt) !== canonicalRecipeString(input.receipt)) {
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_MISMATCH',
      'The uploaded Live-build receipt differs from the server-reproduced deterministic bake.',
      409
    )
  }
  return expected
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

export async function bootstrapRecipeV2(input: {
  userId: string
  goonId: string
  expectedUpdatedAt: string
  receipt: RecipeArchiveContainmentReceipt
  state: RecipeStateSnapshot
}, dependencies: RecipeLifecycleDependencies = {}) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedGoonForRecipeBootstrap(input.userId, input.goonId)
  if (goon.kind !== 'custom' || goon.sourceProfile !== 'expert-custom-glb') {
    throw new GoonRecipeLifecycleError(
      'RECIPE_NOT_CAPABLE',
      'Only an expert Custom GLB Goon can initialize a Recipe owner.',
      409
    )
  }
  if (goon.updated_at !== input.expectedUpdatedAt) {
    throw new GoonRecipeLifecycleError(
      'WRITE_CONFLICT',
      'The Goon changed before Recipe initialization. Reload it and try again.',
      409
    )
  }
  const expectedManagedState = createRecipeBootstrapManagedSnapshot(goon)
  const archive = await loadArchive(input.receipt, readAsset)
  const submittedState = await verifyRecipeStateSnapshot(input.state)
  const stateWithoutAnatomyFit = await withoutAnatomyFitRecipeSibling(submittedState)
  let state: RecipeStateSnapshot
  try {
    // Initial Recipe creation owns the same integrity boundary as package
    // updates: Anatomy Fit is derived from the exact stored source bytes on
    // the server, never trusted from a client summary or submitted sibling.
    state = await computeAnatomyFitRecipeState({
      state: stateWithoutAnatomyFit,
      previousState: null,
      manifest: archive.manifest as GoonCustomAvatarManifest,
      modelBytes: archive.modelBytes,
      source: archive.source.identities
    })
  } catch (error) {
    throw new GoonRecipeLifecycleError(
      'ANATOMY_FIT_FAILED',
      `The Goon file could not produce its required Anatomy Fit: ${
        error instanceof Error ? error.message : String(error)
      }`,
      409
    )
  }
  const containmentDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: archive.receipt
  })
  const containmentReceipt = documentRef(containmentDocument)
  const revisionHash = await canonicalRecipeSha256({
    userId: input.userId,
    goonId: input.goonId,
    source: archive.source,
    state
  })
  const authoringRevision = await createAuthoringRevision({
    contract: GOON_RECIPE_REVISION_CONTRACT,
    recipeRevision: 1,
    revisionId: `recipe_revision_1_${revisionHash.slice(0, 24)}`,
    revisionSha256: ZERO_SHA256,
    source: archive.source,
    state,
    liveBuildReceipt: {
      contract: GOON_LIVE_BUILD_CONTRACT,
      ref: 'bootstrap-pending',
      sha256: ZERO_SHA256
    },
    updateReport: null
  })
  const owner: GoonRecipeV2 = {
    contract: 'goon-recipe/v2',
    writeVersion: 1,
    nextRecipeRevision: 2,
    liveStatus: 'needs_bake',
    authoringRevision,
    authoringSourceContainmentReceipt: containmentReceipt,
    activeRevision: null,
    previousRevision: null,
    pendingAnalysis: null,
    pendingJob: null,
    latestUpdateReport: null,
    lastFailure: null,
    maintenanceFailure: null
  }
  await verifyGoonRecipeV2(owner)
  const now = (dependencies.now ?? (() => new Date()))().toISOString()
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now
  nextGoon.recipe = owner
  const stored = await initializeRecipeState({
    userId: input.userId,
    goonId: input.goonId,
    expectedManagedState,
    nextGoon,
    records: [{
      key: recipeDocumentRedisKey(input.userId, input.goonId, containmentDocument.sha256),
      value: containmentDocument
    }]
  })
  return { goon: stored, containmentReceipt }
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
  if (
    owner.liveStatus !== 'up_to_date' ||
    !owner.activeRevision ||
    owner.pendingJob ||
    owner.pendingAnalysis
  ) {
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

const MIGRATION_CLASSIFICATION = {
  keep: 'kept',
  'presentation-only': 'presentation-updated',
  affine: 'remapped',
  piecewise: 'remapped',
  new: 'new',
  removed: 'removed',
  'reset-required': 'reset-required',
  blocked: 'blocked'
} as const

function migrationReportExpectation(
  plan: RecipeMigrationPlan,
  edge: RecipeUpdateEdge
): RecipeMigrationReportExpectation {
  const rows = new Map(plan.controlRows.map((row) => [row.ledgerId, row]))
  const classifications = Object.fromEntries(edge.controls.map((control) => {
    const row = rows.get(control.id)
    if (!row) {
      throw new GoonRecipeLifecycleError(
        'CORRUPT_PLAN',
        `Migration plan omitted update-edge control ${control.id}.`,
        500
      )
    }
    if (plan.outcome.kind === 'clean-reset') {
      return [
        control.id,
        row.sourceControl === null
          ? 'new'
          : row.targetControl === null
            ? 'removed'
            : 'reset-required'
      ] as const
    }
    if (plan.outcome.kind === 'unsupported') {
      return [control.id, row.sourceControl === null ? 'new' : 'blocked'] as const
    }
    if (row.resolution === 'blocked' || row.proofStatus === 'failed') {
      return [control.id, row.sourceControl === null ? 'new' : 'blocked'] as const
    }
    return [control.id, MIGRATION_CLASSIFICATION[control.action]] as const
  }))
  return {
    classifications,
    status:
      plan.outcome.readiness === 'blocked'
        ? 'blocked'
        : plan.outcome.readiness === 'preview-required'
          ? 'preview-required'
          : 'preserved'
  }
}

async function createServerMigrationReport(
  plan: RecipeMigrationPlan,
  edge: RecipeUpdateEdge
): Promise<RecipeMigrationReport> {
  const rows = new Map(plan.controlRows.map((row) => [row.ledgerId, row]))
  const expectation = migrationReportExpectation(plan, edge)
  const entries = edge.controls.map((control) => {
    const row = rows.get(control.id)
    if (!row) {
      throw new GoonRecipeLifecycleError(
        'CORRUPT_PLAN',
        `Migration plan omitted update-edge control ${control.id}.`,
        500
      )
    }
    const classification = expectation.classifications[control.id]
    if (!classification) {
      throw new GoonRecipeLifecycleError(
        'CORRUPT_PLAN',
        `Migration report omitted update-edge control ${control.id}.`,
        500
      )
    }
    const oldValue = row.sourceControl?.value ?? null
    const proposedValue =
      classification === 'new' || classification === 'reset-required'
        ? 0
        : classification === 'removed' || classification === 'blocked'
          ? null
          : row.targetControl?.value ?? null
    const cleanReset = plan.outcome.kind === 'clean-reset'
    const removedNeedsReview = classification === 'removed' && (cleanReset || oldValue !== 0)
    return {
      id: control.id,
      classification,
      componentId: control.componentId,
      oldValue,
      proposedValue,
      reason: row.message,
      proofStatus:
        classification === 'new' || classification === 'removed'
          ? 'not-required' as const
          : classification === 'reset-required'
            ? 'not-preserved' as const
            : classification === 'blocked'
              ? 'failed' as const
              : 'verified' as const,
      maximumError: row.maximumScalarError,
      tolerance: RECIPE_STRICT_TOLERANCES.scalar,
      proofSha256: row.componentProofSha256,
      requiresPreview:
        classification === 'blocked' ||
        classification === 'reset-required' ||
        removedNeedsReview ||
        (classification === 'new' && cleanReset),
      requiresConfirmation:
        classification === 'reset-required' ||
        removedNeedsReview ||
        (classification === 'new' && cleanReset)
    }
  }).sort((left, right) => left.id.localeCompare(right.id))
  const report: RecipeMigrationReport = {
    contract: RECIPE_MIGRATION_REPORT_CONTRACT,
    reportId: `report_${plan.planId}`,
    directEdgeKey: plan.directEdgeKey,
    edgeSha256: plan.edgeSha256,
    fromRecipeRevision: plan.fromRecipeRevision,
    toRecipeRevision: plan.toRecipeRevision,
    status: expectation.status,
    entries,
    warnings: edge.warnings,
    proof: {
      toleranceProfile: 'recipe-strict/v1',
      wholeRecipeMaximumError: plan.wholeRecipeProof.errors.positionMaximumMeters,
      wholeRecipeRmsError: plan.wholeRecipeProof.errors.positionRmsMeters,
      wholeRecipeTolerance: RECIPE_STRICT_TOLERANCES.positionMeters,
      wholeRecipeProofSha256: plan.wholeRecipeProof.proofSha256,
      reportSha256: ZERO_SHA256
    }
  }
  report.proof.reportSha256 = await recipeMigrationReportSha256(report, edge, expectation)
  return verifyRecipeMigrationReport(report, edge, expectation)
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
  const targetReceiptRef = documentRef(receiptDocument)

  const source = await loadArchiveFromDocument(
    input.userId,
    input.goonId,
    owner.authoringSourceContainmentReceipt,
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
  const sourceMigrationState = await withoutAnatomyFitRecipeSibling(
    owner.authoringRevision.state
  )
  const plannerInput: AppearanceRecipeMigrationPlannerInput = {
    planId,
    fromRecipeRevision: owner.authoringRevision.recipeRevision,
    toRecipeRevision: owner.nextRecipeRevision,
    edge,
    sourceState: sourceMigrationState,
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
  const plan = await (dependencies.planMigration ?? planAppearanceRecipeMigration)(plannerInput)
  const report = await createServerMigrationReport(plan, edge)
  const planDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: plan
  })
  const planRef = documentRef(planDocument)
  const reportDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: report
  })
  const reportRef = documentRef(reportDocument)
  const analysisHash = await canonicalRecipeSha256({
    userId: input.userId,
    goonId: input.goonId,
    writeVersion: owner.writeVersion,
    sourceRevision: owner.activeRevision,
    receipt: targetReceiptRef,
    plan: planRef
  })
  const analysisId = `recipe_analysis_${analysisHash.slice(0, 40)}`
  const analysisDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: {
      contract: RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT,
      analysisId,
      sourceRevision: owner.activeRevision!,
      containmentReceipt: targetReceiptRef,
      basePlan: planRef,
      siblingInputs: serializeRecipeSiblingInputs(input.siblingInputs),
      componentMapBundle: input.componentMapBundle ?? null
    }
  })
  await verifyRecipeUpdateAnalysisContext(analysisDocument.content)
  const nextWriteVersion = owner.writeVersion + 1
  const pendingAnalysis: NonNullable<GoonRecipeV2['pendingAnalysis']> = {
    analysisId,
    analysisRef: documentRef(analysisDocument),
    basePlan: planRef,
    selectedPlan: planRef,
    migrationReport: reportRef,
    containmentReceipt: targetReceiptRef,
    reviewedState: null,
    targetWriteVersion: nextWriteVersion
  }
  const now = (dependencies.now ?? (() => new Date()))().toISOString()
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    pendingAnalysis
  }
  const stored = await compareAndSwapRecipeState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    nextGoon,
    records: [receiptDocument, planDocument, reportDocument, analysisDocument].map((document) => ({
      key: recipeDocumentRedisKey(input.userId, input.goonId, document.sha256),
      value: document
    }))
  })
  const storedOwner = await verifyGoonRecipeV2(stored.recipe)
  return {
    goon: stored,
    owner: storedOwner,
    pendingAnalysis,
    plan,
    basePlan: plan,
    report,
    receipt: target.receipt,
    reviewedState: null
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

async function loadReviewedState(userId: string, goonId: string, ref: RecipeDocumentRef) {
  if (ref.contract !== RECIPE_REVIEWED_STATE_CONTRACT) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVIEW', 'Reviewed Recipe State ref has the wrong contract.', 500)
  }
  const document = await loadDocumentByRef(userId, goonId, ref)
  return verifyRecipeReviewedState(document.content)
}

function requirePendingAnalysis(owner: GoonRecipeV2, analysisId?: string) {
  const pending = owner.pendingAnalysis
  if (!pending) {
    throw new GoonRecipeLifecycleError(
      'NO_PENDING_ANALYSIS',
      'This Goon has no package update waiting for review.',
      409
    )
  }
  if (analysisId && pending.analysisId !== stableInputId(analysisId, 'analysis id')) {
    throw new GoonRecipeLifecycleError(
      'STALE_ANALYSIS',
      'The package update review changed. Reload it before continuing.',
      409
    )
  }
  return pending
}

export async function getRecipePackageAnalysis(input: {
  userId: string
  goonId: string
}): Promise<RecipeAnalysisHydration> {
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const pendingAnalysis = requirePendingAnalysis(owner)
  const [plan, basePlan, reportDocument, receiptDocument, reviewedState] = await Promise.all([
    loadPlan(input.userId, input.goonId, pendingAnalysis.selectedPlan),
    loadPlan(input.userId, input.goonId, pendingAnalysis.basePlan),
    loadDocumentByRef(input.userId, input.goonId, pendingAnalysis.migrationReport),
    loadDocumentByRef(input.userId, input.goonId, pendingAnalysis.containmentReceipt),
    pendingAnalysis.reviewedState
      ? loadReviewedState(input.userId, input.goonId, pendingAnalysis.reviewedState)
      : Promise.resolve(null)
  ])
  if (reportDocument.documentContract !== RECIPE_MIGRATION_REPORT_CONTRACT) {
    throw new GoonRecipeLifecycleError('CORRUPT_REPORT', 'Stored migration report contract is invalid.', 500)
  }
  const report = reportDocument.content as unknown as RecipeMigrationReport
  const receipt = await verifyRecipeArchiveContainmentReceipt(receiptDocument.content)
  return { goon, owner, pendingAnalysis, plan, basePlan, report, receipt, reviewedState }
}

async function analysisPlannerInput(input: {
  userId: string
  goonId: string
  owner: GoonRecipeV2
  pending: NonNullable<GoonRecipeV2['pendingAnalysis']>
  basePlan: RecipeMigrationPlan
  readAsset: RecipeAssetReader
}) {
  const contextDocument = await loadDocumentByRef(
    input.userId,
    input.goonId,
    input.pending.analysisRef
  )
  const context = parseRecipeUpdateAnalysisContext(contextDocument.content)
  if (
    context.analysisId !== input.pending.analysisId ||
    canonicalRecipeString(context.containmentReceipt) !==
      canonicalRecipeString(input.pending.containmentReceipt) ||
    canonicalRecipeString(context.basePlan) !== canonicalRecipeString(input.pending.basePlan)
  ) {
    throw new GoonRecipeLifecycleError(
      'CORRUPT_ANALYSIS',
      'Stored package analysis context does not match its owner.',
      500
    )
  }
  const sourceEnvelope = await loadEnvelopeByRef(input.userId, input.goonId, context.sourceRevision)
  const [source, target] = await Promise.all([
    loadArchiveFromDocument(
      input.userId,
      input.goonId,
      sourceEnvelope.sourceContainmentReceipt,
      input.readAsset
    ),
    loadArchiveFromDocument(
      input.userId,
      input.goonId,
      context.containmentReceipt,
      input.readAsset
    )
  ])
  const edge = directUpdateEdge(source.source, target)
  return {
    context,
    source,
    target,
    edge,
    plannerInput: {
      planId: input.basePlan.planId,
      fromRecipeRevision: sourceEnvelope.revision.recipeRevision,
      toRecipeRevision: input.owner.nextRecipeRevision,
      edge,
      sourceState: await withoutAnatomyFitRecipeSibling(sourceEnvelope.revision.state),
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
      siblingInputs: deserializeRecipeSiblingInputs(context.siblingInputs),
      ...(context.componentMapBundle ? { componentMapBundle: context.componentMapBundle } : {})
    } satisfies AppearanceRecipeMigrationPlannerInput
  }
}

export async function selectRecipeCleanReset(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
  analysisId: string
  confirmed: boolean
}, dependencies: RecipeLifecycleDependencies = {}) {
  if (input.confirmed !== true) {
    throw new GoonRecipeLifecycleError(
      'RESET_CONFIRMATION_REQUIRED',
      'Clean reset must be explicitly confirmed.',
      409
    )
  }
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const pending = requirePendingAnalysis(owner, input.analysisId)
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError('WRITE_CONFLICT', 'The package analysis changed.', 409)
  }
  const basePlan = await loadPlan(input.userId, input.goonId, pending.basePlan)
  if (
    basePlan.outcome.kind !== 'unsupported' ||
    basePlan.outcome.cleanResetEligibility !== 'eligible'
  ) {
    throw new GoonRecipeLifecycleError(
      'CLEAN_RESET_NOT_ELIGIBLE',
      'This package analysis is not eligible for a clean reset.',
      409
    )
  }
  const analysis = await analysisPlannerInput({
    userId: input.userId,
    goonId: input.goonId,
    owner,
    pending,
    basePlan,
    readAsset
  })
  const plan = await planAppearanceRecipeCleanReset({
    planId: `clean_reset_${pending.analysisId}`,
    migrationInput: analysis.plannerInput,
    eligibleUnsupportedPlan: basePlan
  })
  const report = await createServerMigrationReport(plan, analysis.edge)
  const planDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: plan
  })
  const selectedPlan = documentRef(planDocument)
  const reportDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: report
  })
  const migrationReport = documentRef(reportDocument)
  const now = (dependencies.now ?? (() => new Date()))().toISOString()
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now
  nextGoon.recipe = {
    ...owner,
    writeVersion: owner.writeVersion + 1,
    pendingAnalysis: {
      ...pending,
      selectedPlan,
      migrationReport,
      reviewedState: null,
      targetWriteVersion: owner.writeVersion + 1
    }
  }
  await compareAndSwapRecipeState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    nextGoon,
    records: [planDocument, reportDocument].map((document) => ({
      key: recipeDocumentRedisKey(input.userId, input.goonId, document.sha256),
      value: document
    }))
  })
  return getRecipePackageAnalysis({ userId: input.userId, goonId: input.goonId })
}

function assertReviewedStateAdjustment(input: {
  plan: RecipeMigrationPlan
  state: RecipeStateSnapshot
  target: LoadedArchive
  confirmedControlIds: string[]
  cleanResetConfirmed: boolean
}) {
  if (!input.plan.proposedState || input.plan.outcome.readiness === 'blocked') {
    throw new GoonRecipeLifecycleError(
      'UPDATE_NOT_READY',
      'This package analysis cannot produce a reviewed Recipe State.',
      409
    )
  }
  const baseline = input.plan.proposedState
  if (
    canonicalRecipeString(input.state.siblings) !== canonicalRecipeString(baseline.siblings) ||
    input.state.appearanceDials.contract !== baseline.appearanceDials.contract ||
    input.state.appearanceDials.definitionSha256 !== baseline.appearanceDials.definitionSha256 ||
    input.state.appearanceDials.neutralId !== baseline.appearanceDials.neutralId ||
    input.state.appearanceDials.neutralRecipeSha256 !== baseline.appearanceDials.neutralRecipeSha256 ||
    canonicalRecipeString(input.state.appearanceDials.unlockedDialIds) !==
      canonicalRecipeString(baseline.appearanceDials.unlockedDialIds)
  ) {
    throw new GoonRecipeLifecycleError(
      'UNAUTHORIZED_REVIEW_CHANGE',
      'Reviewed package state may only adjust authorized new or reset controls.',
      409
    )
  }
  const authorized = new Set(
    input.plan.controlRows
      .filter((row) =>
        row.targetControl &&
        (row.edgeAction === 'new' ||
          row.edgeAction === 'reset-required' ||
          row.resolution === 'new-neutral' ||
          row.resolution === 'reset-to-neutral')
      )
      .map((row) => row.targetControl!.id)
  )
  const baselineIds = Object.keys(baseline.appearanceDials.values).sort()
  const candidateIds = Object.keys(input.state.appearanceDials.values).sort()
  if (canonicalRecipeString(baselineIds) !== canonicalRecipeString(candidateIds)) {
    throw new GoonRecipeLifecycleError(
      'UNAUTHORIZED_REVIEW_CHANGE',
      'Reviewed package state cannot add or remove controls.',
      409
    )
  }
  const adjustedControlIds = candidateIds.filter(
    (id) => input.state.appearanceDials.values[id] !== baseline.appearanceDials.values[id]
  )
  if (adjustedControlIds.some((id) => !authorized.has(id))) {
    throw new GoonRecipeLifecycleError(
      'UNAUTHORIZED_REVIEW_CHANGE',
      'Only new or reset-authorized controls may be adjusted during package review.',
      409
    )
  }
  const appearanceManifest = parseAppearanceDialsManifest(input.target.manifest)
  if (!appearanceManifest) {
    throw new GoonRecipeLifecycleError('CORRUPT_MANIFEST', 'Target package has no Recipe appearance manifest.', 500)
  }
  const ranges = appearanceRecipeControlInventory(appearanceManifest).ranges
  for (const [id, value] of Object.entries(input.state.appearanceDials.values)) {
    const range = ranges[id]
    if (!range || value < range[0] || value > range[1]) {
      throw new GoonRecipeLifecycleError(
        'REVIEW_VALUE_OUT_OF_RANGE',
        `Reviewed control ${id} is outside the exact target package range.`,
        409
      )
    }
  }
  const confirmed = [...new Set(input.confirmedControlIds)].sort((a, b) => a.localeCompare(b))
  if (
    confirmed.length !== input.confirmedControlIds.length ||
    confirmed.some((id, index) => id !== input.confirmedControlIds[index])
  ) {
    throw new GoonRecipeLifecycleError('INVALID_INPUT', 'Confirmed control ids must be sorted and unique.')
  }
  const reviewableRows = new Set(
    input.plan.controlRows
      .filter((row) => row.requiresPreview || row.requiresConfirmation)
      .map((row) => row.ledgerId)
  )
  if (confirmed.some((id) => !reviewableRows.has(id))) {
    throw new GoonRecipeLifecycleError(
      'INVALID_CONFIRMATION',
      'The review confirmed a control that does not require review.',
      409
    )
  }
  const required = input.plan.controlRows
    .filter((row) => row.requiresConfirmation)
    .map((row) => row.ledgerId)
  if (required.some((id) => !confirmed.includes(id))) {
    throw new GoonRecipeLifecycleError(
      'CONFIRMATION_REQUIRED',
      'Every reset or destructive migration row must be explicitly confirmed.',
      409
    )
  }
  const isCleanReset = input.plan.outcome.kind === 'clean-reset'
  if (input.cleanResetConfirmed !== isCleanReset) {
    throw new GoonRecipeLifecycleError(
      'RESET_CONFIRMATION_REQUIRED',
      'Clean-reset confirmation must exactly match the selected plan.',
      409
    )
  }
  return { adjustedControlIds, confirmedControlIds: confirmed }
}

export async function reviewRecipePackageState(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
  analysisId: string
  state: RecipeStateSnapshot
  confirmedControlIds: string[]
  cleanResetConfirmed: boolean
}, dependencies: RecipeLifecycleDependencies = {}) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const pending = requirePendingAnalysis(owner, input.analysisId)
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError('WRITE_CONFLICT', 'The package analysis changed.', 409)
  }
  const [plan, target, submittedState] = await Promise.all([
    loadPlan(input.userId, input.goonId, pending.selectedPlan),
    loadArchiveFromDocument(input.userId, input.goonId, pending.containmentReceipt, readAsset),
    verifyRecipeStateSnapshot(input.state)
  ])
  const reviewState = await withoutAnatomyFitRecipeSibling(submittedState)
  const review = assertReviewedStateAdjustment({
    plan,
    state: reviewState,
    target,
    confirmedControlIds: input.confirmedControlIds,
    cleanResetConfirmed: input.cleanResetConfirmed
  })
  let state: RecipeStateSnapshot
  try {
    state = await computeAnatomyFitRecipeState({
      state: reviewState,
      previousState: owner.authoringRevision.state,
      manifest: target.manifest as GoonCustomAvatarManifest,
      modelBytes: target.modelBytes,
      source: target.source.identities
    })
  } catch (error) {
    throw new GoonRecipeLifecycleError(
      'ANATOMY_FIT_FAILED',
      `The updated Goon file could not produce its required Anatomy Fit: ${
        error instanceof Error ? error.message : String(error)
      }`,
      409
    )
  }
  const reviewHash = await canonicalRecipeSha256({
    analysisId: pending.analysisId,
    planSha256: plan.planSha256,
    state,
    ...review,
    cleanResetConfirmed: input.cleanResetConfirmed
  })
  const reviewedState: RecipeReviewedState = await verifyRecipeReviewedState({
    contract: RECIPE_REVIEWED_STATE_CONTRACT,
    reviewId: `recipe_review_${reviewHash.slice(0, 40)}`,
    operation: 'package-update',
    analysisId: pending.analysisId,
    planSha256: plan.planSha256,
    containmentReceiptSha256: target.receipt.receiptSha256,
    state,
    adjustedControlIds: review.adjustedControlIds,
    confirmedControlIds: review.confirmedControlIds,
    cleanResetConfirmed: input.cleanResetConfirmed
  })
  const reviewDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: reviewedState
  })
  const now = (dependencies.now ?? (() => new Date()))().toISOString()
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now
  nextGoon.recipe = {
    ...owner,
    writeVersion: owner.writeVersion + 1,
    pendingAnalysis: {
      ...pending,
      reviewedState: documentRef(reviewDocument),
      targetWriteVersion: owner.writeVersion + 1
    }
  }
  await compareAndSwapRecipeState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    nextGoon,
    records: [{
      key: recipeDocumentRedisKey(input.userId, input.goonId, reviewDocument.sha256),
      value: reviewDocument
    }]
  })
  return getRecipePackageAnalysis({ userId: input.userId, goonId: input.goonId })
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
    if (existing.idempotencyKey === idempotencyKey && existing.operation === 'package-update') {
      const reviewedState = await loadReviewedState(input.userId, input.goonId, existing.reviewedState)
      return { goon, job: existing, reviewedState, replayed: true }
    }
  }
  const pending = requirePendingAnalysis(owner, input.analysisId)
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError(
      'WRITE_CONFLICT',
      'The Recipe changed after analysis. Analyze the package again.',
      409
    )
  }
  if (!pending.reviewedState) {
    throw new GoonRecipeLifecycleError(
      'REVIEW_REQUIRED',
      'Review and confirm the proposed Recipe State before starting the rebuild.',
      409
    )
  }
  const [plan, reviewedState] = await Promise.all([
    loadPlan(input.userId, input.goonId, pending.selectedPlan),
    loadReviewedState(input.userId, input.goonId, pending.reviewedState)
  ])
  if (!plan.proposedState || plan.outcome.readiness === 'blocked') {
    throw new GoonRecipeLifecycleError(
      'UPDATE_NOT_READY',
      'This analysis is not eligible for Update & Rebuild. Review its blocked or reset-required result.',
      409
    )
  }
  if (
    reviewedState.operation !== 'package-update' ||
    reviewedState.analysisId !== pending.analysisId ||
    reviewedState.planSha256 !== plan.planSha256
  ) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVIEW', 'Reviewed state does not bind this analysis.', 500)
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
    pending.containmentReceipt,
    readAsset
  )
  if (canonicalRecipeString(target.source) !== canonicalRecipeString(plan.toSource)) {
    throw new GoonRecipeLifecycleError('CORRUPT_PLAN', 'The Recipe plan target differs from its extraction receipt.', 500)
  }
  if (reviewedState.containmentReceiptSha256 !== target.receipt.receiptSha256) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVIEW', 'Reviewed state targets another package receipt.', 500)
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
      containmentReceipt: pending.containmentReceipt
    },
    plan: pending.selectedPlan,
    migrationReport: pending.migrationReport,
    reviewedState: pending.reviewedState,
    stagedLive: null,
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
    pendingAnalysis: null,
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
  return { goon: stored, job, reviewedState, replayed: false }
}

export async function startRecipeBake(
  input: StartRecipeBakeInput,
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
      (existing.operation === 'first-bake' || existing.operation === 'rebake')
    ) {
      const reviewedState = await loadReviewedState(input.userId, input.goonId, existing.reviewedState)
      return { goon, job: existing, reviewedState, replayed: true }
    }
    throw new GoonRecipeLifecycleError('RECIPE_BUSY', 'Finish or discard the current Recipe build.', 409)
  }
  if (owner.pendingAnalysis) {
    throw new GoonRecipeLifecycleError('RECIPE_BUSY', 'Keep or finish the current package analysis first.', 409)
  }
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError('WRITE_CONFLICT', 'The Recipe changed before rebuild started.', 409)
  }
  if (!['up_to_date', 'needs_bake'].includes(owner.liveStatus)) {
    throw new GoonRecipeLifecycleError('RECIPE_BUSY', 'Recover current Recipe work before rebuilding.', 409)
  }
  const state = await verifyRecipeStateSnapshot(input.state)
  const source = await loadArchiveFromDocument(
    input.userId,
    input.goonId,
    owner.authoringSourceContainmentReceipt,
    readAsset
  )
  if (canonicalRecipeString(source.source) !== canonicalRecipeString(owner.authoringRevision.source)) {
    throw new GoonRecipeLifecycleError('CORRUPT_REVISION', 'Authoring Source differs from its containment receipt.', 500)
  }
  const operation = owner.activeRevision ? 'rebake' as const : 'first-bake' as const
  if (
    operation === 'first-bake' &&
    canonicalRecipeString(state) !== canonicalRecipeString(owner.authoringRevision.state)
  ) {
    throw new GoonRecipeLifecycleError(
      'WRITE_CONFLICT',
      'Save the initial Recipe State before starting its first bake.',
      409
    )
  }
  const targetRecipeRevision = operation === 'first-bake'
    ? owner.authoringRevision.recipeRevision
    : owner.nextRecipeRevision
  const jobHash = await canonicalRecipeSha256({
    userId: input.userId,
    goonId: input.goonId,
    idempotencyKey,
    operation,
    source: source.source,
    state,
    targetRecipeRevision
  })
  const targetRevisionId = operation === 'first-bake'
    ? owner.authoringRevision.revisionId
    : `recipe_revision_${targetRecipeRevision}_${jobHash.slice(0, 24)}`
  const reviewHash = await canonicalRecipeSha256({
    operation,
    containmentReceiptSha256: source.receipt.receiptSha256,
    state
  })
  const reviewedState = await verifyRecipeReviewedState({
    contract: RECIPE_REVIEWED_STATE_CONTRACT,
    reviewId: `recipe_review_${reviewHash.slice(0, 40)}`,
    operation,
    analysisId: null,
    planSha256: null,
    containmentReceiptSha256: source.receipt.receiptSha256,
    state,
    adjustedControlIds: [],
    confirmedControlIds: [],
    cleanResetConfirmed: false
  })
  const reviewDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: reviewedState
  })
  const reviewedStateRef = documentRef(reviewDocument)
  const now = (dependencies.now ?? (() => new Date()))()
  const nextWriteVersion = owner.writeVersion + 1
  const authoringRevision = operation === 'first-bake'
    ? owner.authoringRevision
    : await createAuthoringRevision({
        contract: GOON_RECIPE_REVISION_CONTRACT,
        recipeRevision: targetRecipeRevision,
        revisionId: targetRevisionId,
        revisionSha256: ZERO_SHA256,
        source: source.source,
        state,
        liveBuildReceipt: {
          contract: GOON_LIVE_BUILD_CONTRACT,
          ref: 'rebake-pending',
          sha256: ZERO_SHA256
        },
        updateReport: null
      })
  const job: GoonRecipeJob = {
    contract: GOON_RECIPE_JOB_CONTRACT,
    userId: input.userId,
    goonId: input.goonId,
    jobId: `recipe_job_${jobHash.slice(0, 40)}`,
    idempotencyKey,
    operation,
    status: 'baking',
    stateVersion: 1,
    attempt: 1,
    targetWriteVersion: nextWriteVersion,
    targetRecipeRevision,
    targetRevisionId,
    sourceRevision: owner.activeRevision,
    stagedSource: {
      source: source.source,
      containmentReceipt: owner.authoringSourceContainmentReceipt
    },
    plan: null,
    migrationReport: null,
    reviewedState: reviewedStateRef,
    stagedLive: null,
    candidateRevision: null,
    lease: lease(dependencies, now),
    failure: null,
    cleanupAssets: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    nextRecipeRevision:
      operation === 'rebake' ? owner.nextRecipeRevision + 1 : owner.nextRecipeRevision,
    liveStatus: 'building',
    authoringRevision,
    pendingJob: pendingJob(job),
    lastFailure: null
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: null,
    nextGoon,
    nextJob: job,
    records: [{
      key: recipeDocumentRedisKey(input.userId, input.goonId, reviewDocument.sha256),
      value: reviewDocument
    }]
  })
  return { goon: stored, job, reviewedState, replayed: false }
}

export async function discardRecipePackageAnalysis(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
  analysisId: string
  confirmed: boolean
}, dependencies: RecipeLifecycleDependencies = {}) {
  if (input.confirmed !== true) {
    throw new GoonRecipeLifecycleError(
      'KEEP_CURRENT_CONFIRMATION_REQUIRED',
      'Keeping the current package must be explicitly confirmed.',
      409
    )
  }
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const pending = requirePendingAnalysis(owner, input.analysisId)
  if (owner.writeVersion !== input.expectedWriteVersion) {
    throw new GoonRecipeLifecycleError('WRITE_CONFLICT', 'The Recipe changed after analysis.', 409)
  }
  const [plan, target, active] = await Promise.all([
    loadPlan(input.userId, input.goonId, pending.selectedPlan),
    loadArchiveFromDocument(input.userId, input.goonId, pending.containmentReceipt, readAsset),
    loadEnvelopeByRef(input.userId, input.goonId, owner.activeRevision!)
  ])
  if (
    canonicalRecipeString(plan.fromSource) !== canonicalRecipeString(owner.authoringRevision.source) ||
    canonicalRecipeString(plan.toSource) !== canonicalRecipeString(target.source) ||
    active.sourceContainmentReceipt.ref === pending.containmentReceipt.ref
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
  const now = (dependencies.now ?? (() => new Date()))().toISOString()
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now
  nextGoon.recipe = {
    ...owner,
    writeVersion: owner.writeVersion + 1,
    pendingAnalysis: null
  }
  const stored = await discardRecipeAnalysisRecords({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    analysisId: pending.analysisId,
    nextGoon,
    recordRefs: [
      pending.analysisRef.ref,
      pending.basePlan.ref,
      pending.selectedPlan.ref,
      pending.migrationReport.ref,
      pending.containmentReceipt.ref,
      ...(pending.reviewedState ? [pending.reviewedState.ref] : [])
    ]
  })
  const remaining = await redis.execute((client: any) =>
    collectGoonUploadReferencesForClient(client, input.userId)
  )
  const deletedAssets = await deleteUnreferencedGoonUploadReferences(
    candidates,
    remaining,
    dependencies.deleteAsset
  )
  return { goon: stored, discarded: true, deletedAssets }
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
  updateReport: RecipeDocumentRef | null
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

export async function registerRecipeCandidateAssets(input: {
  userId: string
  goonId: string
  jobId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number
  live: RecipeAssetSet
}, dependencies: RecipeLifecycleDependencies = {}) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  if (job.stagedLive) {
    if (canonicalRecipeString(job.stagedLive) !== canonicalRecipeString(input.live)) {
      throw new GoonRecipeLifecycleError(
        'CANDIDATE_ALREADY_REGISTERED',
        'This Recipe job already owns a different Live candidate.',
        409
      )
    }
    const cleanup = new Set(job.cleanupAssets.map((asset) => asset.ref))
    if (Object.values(job.stagedLive).some((asset) => !cleanup.has(asset.ref))) {
      throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Registered candidate is missing cleanup ownership.', 500)
    }
    return { goon, owner, job, replayed: true }
  }
  assertJobSnapshot(owner, job, input.expectedWriteVersion, input.expectedJobStateVersion)
  if (!['baking', 'packaging', 'verifying'].includes(job.status)) {
    throw new GoonRecipeLifecycleError(
      'INVALID_JOB_STATE',
      `Cannot register candidate assets from ${job.status}.`,
      409
    )
  }
  assertLeaseCurrent(job, (dependencies.now ?? (() => new Date()))())
  await Promise.all(Object.values(input.live).map((asset) => readVerifiedAsset(asset, readAsset)))
  const now = (dependencies.now ?? (() => new Date()))()
  const nextWriteVersion = owner.writeVersion + 1
  const nextJob: GoonRecipeJob = {
    ...job,
    stateVersion: job.stateVersion + 1,
    targetWriteVersion: nextWriteVersion,
    stagedLive: input.live,
    cleanupAssets: uniqueSortedAssets([...job.cleanupAssets, ...Object.values(input.live)]),
    updatedAt: now.toISOString()
  }
  const nextGoon = cloneGoon(goon)
  nextGoon.updated_at = now.toISOString()
  nextGoon.recipe = {
    ...owner,
    writeVersion: nextWriteVersion,
    pendingJob: pendingJob(nextJob)
  }
  const stored = await compareAndSwapRecipeJobState({
    userId: input.userId,
    goonId: input.goonId,
    expectedWriteVersion: owner.writeVersion,
    expectedJobStateVersion: job.stateVersion,
    nextGoon,
    nextJob
  })
  return {
    goon: stored,
    owner: await verifyGoonRecipeV2(stored.recipe),
    job: nextJob,
    replayed: false
  }
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
  const reviewedState = await loadReviewedState(input.userId, input.goonId, job.reviewedState)
  if (reviewedState.operation !== job.operation) {
    throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Reviewed state operation differs from its job.', 500)
  }
  const state = reviewedState.state
  if (!job.stagedLive || canonicalRecipeString(job.stagedLive) !== canonicalRecipeString(input.live)) {
    throw new GoonRecipeLifecycleError(
      'CANDIDATE_NOT_REGISTERED',
      'Register the exact uploaded Live candidate before staging it.',
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
  let reportRef: RecipeDocumentRef | null = null
  if (job.operation === 'package-update') {
    if (!job.plan || !job.migrationReport) {
      throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Package-update job lost its plan or report.', 500)
    }
    const plan = await loadPlan(input.userId, input.goonId, job.plan)
    if (
      reviewedState.analysisId === null ||
      reviewedState.planSha256 !== plan.planSha256 ||
      plan.toRecipeRevision !== job.targetRecipeRevision
    ) {
      throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Reviewed state does not bind the package-update plan.', 500)
    }
    const edge = edgeForPlan(plan, target)
    const reportDocument = await loadDocumentByRef(
      input.userId,
      input.goonId,
      job.migrationReport
    )
    const report = await verifyRecipeMigrationReport(
      reportDocument.content,
      edge,
      migrationReportExpectation(plan, edge)
    )
    if (
      report.fromRecipeRevision !== plan.fromRecipeRevision ||
      report.toRecipeRevision !== job.targetRecipeRevision
    ) {
      throw new GoonRecipeLifecycleError(
        'CORRUPT_REPORT',
        'The server-authored migration report does not bind the allocated Recipe revision.',
        500
      )
    }
    reportRef = job.migrationReport
  } else if (job.plan || job.migrationReport) {
    throw new GoonRecipeLifecycleError('CORRUPT_JOB', 'Ordinary bake unexpectedly contains migration proof.', 500)
  }
  const liveBuildReceipt = await verifyGoonLiveBuildReceipt(input.liveBuildReceipt)
  assertLiveReceiptBindings(job, state, liveBuildReceipt, input.live)
  await verifyDeterministicLiveBake({
    archive: target,
    revisionId: job.targetRevisionId,
    revision: job.targetRecipeRevision,
    state,
    receipt: liveBuildReceipt
  })
  await verifyStoredLiveArtifacts(input.live, liveBuildReceipt, readAsset)

  const buildDocument = await createGoonRecipeDocument({
    userId: input.userId,
    goonId: input.goonId,
    content: liveBuildReceipt
  })
  const storedBuild = await putGoonRecipeDocument(buildDocument)
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
  await verifyDeterministicLiveBake({
    archive: source,
    revisionId: envelope.revision.revisionId,
    revision: envelope.revision.recipeRevision,
    state: envelope.revision.state,
    receipt: buildReceipt
  })
  await verifyStoredLiveArtifacts(envelope.live, buildReceipt, readAsset)
  if (envelope.revision.updateReport) {
    await loadDocumentByRef(userId, goonId, envelope.revision.updateReport)
  }
  return envelope
}

function applyRevisionToGoon(goon: GoonRecord, envelope: RecipeRevisionEnvelope) {
  applyRecipeRevisionProjection(goon, envelope, (asset) => toGoonFileRef(asset))
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
    authoringSourceContainmentReceipt: envelope.sourceContainmentReceipt,
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
    const maintenance = await recordRecipeMaintenanceFailure(stored, cleanupError, dependencies)
    stored = maintenance.goon
    if (maintenance.persistenceError) {
      cleanupError = `${cleanupError} Cleanup failure persistence also failed: ${maintenance.persistenceError}`
    }
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
const FAILABLE_STATUSES = new Set([...LEASED_STATUSES, 'ready'])

export async function recoverInterruptedRecipeJob(input: {
  userId: string
  goonId: string
  jobId: string
}, dependencies: RecipeLifecycleDependencies = {}) {
  const now = (dependencies.now ?? (() => new Date()))()
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  const job = await getGoonRecipeJob(input.userId, input.goonId, input.jobId)
  const [reviewedState, candidate] = await Promise.all([
    loadReviewedState(input.userId, input.goonId, job.reviewedState),
    job.candidateRevision
      ? loadEnvelopeByRef(input.userId, input.goonId, job.candidateRevision)
      : Promise.resolve(null)
  ])
  if (job.status === 'interrupted') return { goon, job, reviewedState, candidate, recovered: false }
  if (!LEASED_STATUSES.has(job.status) || !job.lease || Date.parse(job.lease.expiresAt) > now.getTime()) {
    return { goon, job, reviewedState, candidate, recovered: false }
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
  return { goon: stored, job: nextJob, reviewedState, candidate, recovered: true }
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
  if (!FAILABLE_STATUSES.has(job.status)) {
    throw new GoonRecipeLifecycleError('INVALID_JOB_STATE', `Recipe job cannot fail from ${job.status}.`, 409)
  }
  if (job.status !== 'ready') assertLeaseCurrent(job, now)
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
  await loadReviewedState(input.userId, input.goonId, job.reviewedState)
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
  const active = owner.activeRevision
    ? await loadEnvelopeByRef(input.userId, input.goonId, owner.activeRevision)
    : null
  const authoringMatchesActive = Boolean(
    active &&
    canonicalRecipeString(active.revision.source) ===
      canonicalRecipeString(owner.authoringRevision.source) &&
    canonicalRecipeString(active.revision.state) ===
      canonicalRecipeString(owner.authoringRevision.state) &&
    canonicalRecipeString(active.revision.updateReport) ===
      canonicalRecipeString(owner.authoringRevision.updateReport) &&
    canonicalRecipeString(active.sourceContainmentReceipt) ===
      canonicalRecipeString(owner.authoringSourceContainmentReceipt)
  )
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
    liveStatus: authoringMatchesActive ? 'up_to_date' : 'needs_bake',
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
    const maintenance = await recordRecipeMaintenanceFailure(stored, cleanupError, dependencies)
    stored = maintenance.goon
    if (maintenance.persistenceError) {
      cleanupError = `${cleanupError} Cleanup failure persistence also failed: ${maintenance.persistenceError}`
    }
  }
  return { goon: stored, job: nextJob, cleanup, cleanupError }
}

export async function getPreviousRecipeRevisionPreview(input: {
  userId: string
  goonId: string
}, dependencies: RecipeLifecycleDependencies = {}) {
  const readAsset = dependencies.readAsset ?? defaultReadAsset
  const goon = await getOwnedRecipeGoon(input.userId, input.goonId)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  if (owner.pendingJob) {
    throw new GoonRecipeLifecycleError(
      'RECIPE_BUSY',
      'Finish or discard current Recipe work before previewing rollback.',
      409
    )
  }
  if (!owner.previousRevision) {
    throw new GoonRecipeLifecycleError(
      'NO_PREVIOUS_REVISION',
      'No complete previous Recipe revision is available.',
      409
    )
  }
  const previous = await verifyCompleteRecipeRevision(
    input.userId,
    input.goonId,
    owner.previousRevision,
    readAsset
  )
  return { goon, owner, previous }
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
    authoringSourceContainmentReceipt: previous.sourceContainmentReceipt,
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
    const maintenance = await recordRecipeMaintenanceFailure(stored, cleanupError, dependencies)
    stored = maintenance.goon
    if (maintenance.persistenceError) {
      cleanupError = `${cleanupError} Cleanup failure persistence also failed: ${maintenance.persistenceError}`
    }
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
    return {
      goon: await compareAndSwapRecipeState({
        userId: goon.user_id,
        goonId: goon.id,
        expectedWriteVersion: owner.writeVersion,
        nextGoon
      }),
      persistenceError: null
    }
  } catch (error) {
    return {
      goon,
      persistenceError: error instanceof Error ? error.message : String(error)
    }
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
    const unreachableSet = new Set(unreachable)
    const candidates = await collectGoonRecipeUploadReferencesForClient(client, userId, goonId)
    const referenceClient = {
      keys: async (pattern: string) =>
        (await client.keys(pattern)).filter((key: string) => !unreachableSet.has(key)),
      sMembers: (key: string) => client.sMembers(key),
      del: (keys: string | string[]) => client.del(keys),
      json: {
        get: (key: string, options?: unknown) => client.json.get(key, options)
      }
    }
    const remaining = await collectGoonUploadReferencesForClient(referenceClient, userId)
    return { unreachable, candidates, remaining }
  })
  const deletedAssets = await deleteUnreferencedGoonUploadReferences(
    result.candidates as GoonAssetReferenceMap,
    result.remaining as GoonAssetReferenceMap,
    options.deleteAsset
  )
  if (result.unreachable.length > 0) {
    await redis.execute((client: any) => client.del(result.unreachable))
  }
  return { deletedRecords: result.unreachable, deletedAssets }
}

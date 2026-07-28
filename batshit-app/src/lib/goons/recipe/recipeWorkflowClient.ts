import type { AppearanceDialValueState, AppearanceDialsManifest } from '../appearanceDials.contracts'
import type { GoonCustomAvatarManifest } from '../customAvatar'
import { parseEyeAppearanceDefinition } from '../eyeAppearance'
import { parseFacialArtworkDefinition } from '../facialArtwork'
import type { GoonFileRef, GoonRecord } from '$lib/types/goons'
import type { CustomGoonPackageUploadResult } from '$lib/services/goons'
import {
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  verifyRecipeArchiveContainmentReceipt,
  type RecipeArchiveContainmentReceipt,
  type RecipeStoredAssetRef
} from './archiveContainmentContracts'
import { bakeLiveGoonInWorker, type LiveGoonBakerClientOptions } from './liveGoonBakerClient'
import { withoutAnatomyFitRecipeSibling } from './anatomyFitContracts'
import {
  verifyGoonLiveBuildReceipt,
  type GoonLiveBuildReceipt
} from './liveBuildContracts'
import type { AppearanceRecipeMigrationSiblingInput } from './appearanceRecipeMigrationPlanner'
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
  sha256Hex
} from './recipeCanonical'
import {
  GOON_RECIPE_STATE_CONTRACT,
  parseRecipeStateSnapshot,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  verifyRecipeStateSnapshot,
  type RecipeFailureStage,
  type RecipeDocumentRef,
  type RecipeJsonValue,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot
} from './recipeContracts'
import {
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  parseGoonRecipeJob,
  verifyGoonRecipeV2,
  verifyRecipeRevisionEnvelope,
  type GoonRecipeJob,
  type GoonRecipeV2,
  type RecipeAssetSet,
  type RecipeRevisionEnvelope
} from './recipeLifecycleContracts'
import { parseRecipeMigrationPlan } from './migrationPlanContracts'
import {
  verifyRecipeReviewedState,
  type AnalyzeRecipePackageUpdateRequest,
  type BootstrapRecipeRequest,
  type DiscardRecipeAnalysisRequest,
  type RecipeAnalysisHydration,
  type RecipeJobStartResponse,
  type RecipeReviewedState,
  type RegisterRecipeCandidateAssetsRequest,
  type ResetRecipeAnalysisRequest,
  type ReviewRecipeStateRequest,
  type StageRecipeCandidateRequest,
  type StartRecipeBakeRequest,
  type StartRecipePackageUpdateRequest
} from './recipeReviewContracts'
import { RECIPE_MIGRATION_REPORT_CONTRACT } from './contractIds'
import {
  verifyRecipeUpdateEdge,
  type RecipeMigrationReport,
  type RecipeSiblingSurface,
  type RecipeUpdateEdge
} from './updateContracts'

const ZERO_SHA256 = '0'.repeat(64)
const ACTIVE_JOB_STATUSES = new Set([
  'validating',
  'planning',
  'baking',
  'packaging',
  'verifying',
  'ready',
  'committing'
])

type UnknownRecord = Record<string, unknown>

export type RecipeWorkflowRequestOptions = {
  signal?: AbortSignal
}

export type RecipeWorkflowHttpErrorDetails = {
  status: number
  code: string | null
  responseBody: unknown
}

export class RecipeWorkflowHttpError extends Error {
  readonly status: number
  readonly code: string | null
  readonly responseBody: unknown

  constructor(message: string, details: RecipeWorkflowHttpErrorDetails) {
    super(message)
    this.name = 'RecipeWorkflowHttpError'
    this.status = details.status
    this.code = details.code
    this.responseBody = details.responseBody
  }
}

export type RecipeSiblingStateDraft = {
  id: string
  contract: string
  definitionSha256: string
  state: Record<string, RecipeJsonValue>
}

export type BuildRecipeStateSnapshotInput = {
  goon: GoonRecord
  appearanceDials: AppearanceDialValueState
  /** Managed automatic Anatomy Fit state. Null removes a stale retained sibling. */
  anatomyFitState?: RecipeSiblingStateDraft | null
  /** Additional current sibling state, including future definition-bound surfaces. */
  siblingStates?: RecipeSiblingStateDraft[]
}

export type BuildRecipeSiblingInputsInput = {
  state: RecipeStateSnapshot
  targetManifest: GoonCustomAvatarManifest
  edge: RecipeUpdateEdge
}

export type ServerAuthorizedRecipePreviewControl = {
  authorization: 'server-verified'
  id: string
  label: string
  classification: 'new' | 'reset-required'
  minimum: number
  maximum: number
  step: number
  neutralValue: 0
  value: number
  reason: string
  description?: string
  unit?: string
}

export type RecipeInitializationResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  containmentReceipt: RecipeDocumentRef
}

export type RecipeAnalysisDiscardResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  discarded: true
  deletedAssets: unknown
}

export type RecipeJobRecoveryResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  job: GoonRecipeJob
  reviewedState: RecipeReviewedState
  candidate: RecipeRevisionEnvelope | null
  recovered: boolean
}

export type RecipeJobAction =
  | { action: 'retry' }
  | { action: 'discard' }
  | {
      action: 'advance'
      nextStatus: 'planning' | 'baking' | 'packaging' | 'verifying'
    }
  | {
      action: 'fail'
      stage: RecipeFailureStage
      reason: string
      reportRef?: null
    }

export type RecipeJobActionRequest = RecipeJobAction & {
  expectedWriteVersion: number
  expectedJobStateVersion: number
}

export type RecipeJobActionResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  job: GoonRecipeJob
  cleanup?: unknown
  cleanupError?: string | null
}

export type RecipeCandidateAssetsResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  job: GoonRecipeJob
  replayed: boolean
}

export type RecipeStageResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  job: GoonRecipeJob
  envelope: RecipeRevisionEnvelope
}

export type RecipeCommitResponse = RecipeStageResponse & {
  cleanup: unknown
  cleanupError: string | null
}

export type RecipeRollbackResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  restored: RecipeRevisionEnvelope
  replaced: RecipeRevisionEnvelope
  cleanup: unknown
  cleanupError: string | null
}

export type RecipeRollbackPreviewResponse = {
  goon: GoonRecord
  owner: GoonRecipeV2
  previous: RecipeRevisionEnvelope
}

export type RecipeWorkflowProgress =
  | 'starting'
  | 'fetching-source'
  | 'validating-source'
  | 'evaluating-recipe'
  | 'rewriting-model'
  | 'auditing-model'
  | 'packaging-live-goon'
  | 'verifying-output'
  | 'uploading-candidate'
  | 'registering-candidate'
  | 'staging-candidate'
  | 'previewing-candidate'
  | 'committing'
  | 'complete'

export type RecipeBuildStart =
  | {
      kind: 'package-update'
      request: StartRecipePackageUpdateRequest
    }
  | {
      kind: 'bake'
      request: StartRecipeBakeRequest
    }

export type RecipeBuildWorkflowInput = {
  start: RecipeBuildStart
  signal?: AbortSignal
  onProgress?: (stage: RecipeWorkflowProgress) => void
  /**
   * Load the staged lean-Live candidate into the real preview runtime. The
   * callback must not resolve until the candidate and its animation set are
   * usable. Throwing prevents activation and records a durable preview-load
   * failure on the pending Recipe job.
   */
  previewCandidate: (staged: RecipeStageResponse) => Promise<void>
  candidateFilename?: string
}

export type RecipeBuildWorkflowResult = {
  started: RecipeJobStartResponse
  bake: Awaited<ReturnType<typeof bakeLiveGoonInWorker>>
  upload: CustomGoonPackageUploadResult
  live: RecipeAssetSet
  registered: RecipeCandidateAssetsResponse
  staged: RecipeStageResponse
  committed: RecipeCommitResponse
}

export type RecipeReadyResumeInput = {
  recovery: RecipeJobRecoveryResponse
  signal?: AbortSignal
  onProgress?: (stage: RecipeWorkflowProgress) => void
  previewCandidate: (staged: RecipeStageResponse) => Promise<void>
}

export type RecipeWorkflowClientDependencies = {
  fetchImpl?: typeof fetch
  bake?: typeof bakeLiveGoonInWorker
  uploadCustomPackage?: (
    goonId: string,
    file: File
  ) => Promise<CustomGoonPackageUploadResult>
  cleanupCustomPackage?: (goonId: string, archiveReceipt: unknown) => Promise<unknown>
  assetUrl?: (ref: string) => string | Promise<string>
}

function record(value: unknown, context: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`)
  }
  return value as UnknownRecord
}

function requiredText(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${context} must be a non-empty trimmed string.`)
  }
  return value
}

function requiredBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${context} must be boolean.`)
  return value
}

function cloneRecipeJson<T>(value: T): T {
  return JSON.parse(canonicalRecipeString(value)) as T
}

function currentAuthoringSiblings(goon: GoonRecord): RecipeSiblingStateRecord[] {
  const recipe = goon.recipe
  if (!recipe?.authoringRevision?.state?.siblings) return []
  return cloneRecipeJson(recipe.authoringRevision.state.siblings)
}

async function siblingRecord(input: RecipeSiblingStateDraft): Promise<RecipeSiblingStateRecord> {
  const state = cloneRecipeJson(input.state)
  const stateContract = state.schemaVersion ?? state.contract
  if (stateContract !== input.contract) {
    throw new Error(`Recipe sibling ${input.id} state must declare contract ${input.contract}.`)
  }
  if (state.definitionSha256 !== input.definitionSha256) {
    throw new Error(`Recipe sibling ${input.id} definition hash does not match its state.`)
  }
  requireLowercaseSha256(input.definitionSha256, `Recipe sibling ${input.id} definitionSha256`)
  return {
    id: input.id,
    contract: input.contract,
    definitionSha256: input.definitionSha256,
    stateSha256: await recipeSiblingStateSha256(state),
    state
  }
}

function removeSiblingSurface(
  siblings: Map<string, RecipeSiblingStateRecord>,
  ids: readonly string[],
  contract: string
) {
  for (const [id, sibling] of siblings) {
    if (ids.includes(id) || sibling.contract === contract) siblings.delete(id)
  }
}

/**
 * Build the canonical, self-hashed Recipe State from the editor's current
 * draft. Definition-bound siblings are derived here so Settings never hand
 * assembles hashes or silently drops a retained future sibling surface.
 */
export async function buildRecipeStateSnapshot(
  input: BuildRecipeStateSnapshotInput
): Promise<RecipeStateSnapshot> {
  const siblings = new Map(
    currentAuthoringSiblings(input.goon).map((sibling) => [sibling.id, sibling])
  )

  removeSiblingSurface(
    siblings,
    ['facialArtwork', 'facial-artwork'],
    'facial-artwork-state/v4'
  )
  if (input.goon.facialArtwork) {
    const state = cloneRecipeJson(input.goon.facialArtwork)
    const next = await siblingRecord({
      id: 'facialArtwork',
      contract: state.schemaVersion,
      definitionSha256: state.definitionSha256,
      state
    })
    siblings.set(next.id, next)
  }

  removeSiblingSurface(
    siblings,
    ['eyeAppearance', 'eye-appearance'],
    'eye-appearance-state/v3'
  )
  if (input.goon.eyeAppearance) {
    const state = cloneRecipeJson(input.goon.eyeAppearance)
    const next = await siblingRecord({
      id: 'eyeAppearance',
      contract: state.schemaVersion,
      definitionSha256: state.definitionSha256,
      state
    })
    siblings.set(next.id, next)
  }

  removeSiblingSurface(
    siblings,
    ['oralAppearance', 'oral-appearance'],
    input.goon.oralAppearance?.schemaVersion ?? 'oral-appearance-state/v1'
  )
  if (input.goon.oralAppearance) {
    const state = cloneRecipeJson(input.goon.oralAppearance)
    const contract = requiredText(state.schemaVersion, 'Recipe oralAppearance state contract')
    const definitionSha256 = requireLowercaseSha256(
      state.definitionSha256,
      'Recipe oralAppearance definitionSha256'
    )
    const next = await siblingRecord({
      id: 'oralAppearance',
      contract,
      definitionSha256,
      state
    })
    siblings.set(next.id, next)
  }

  removeSiblingSurface(siblings, ['lipArtwork', 'lip-artwork'], 'lip-artwork-state/v2')
  if (input.goon.lipArtwork) {
    const state = cloneRecipeJson(input.goon.lipArtwork)
    const next = await siblingRecord({
      id: 'lipArtwork',
      contract: state.schemaVersion,
      definitionSha256: state.definitionSha256,
      state
    })
    siblings.set(next.id, next)
  }

  if (input.anatomyFitState !== undefined) {
    removeSiblingSurface(
      siblings,
      ['anatomy-fit'],
      'anatomy-fit-state/v2'
    )
    if (input.anatomyFitState) {
      const next = await siblingRecord(input.anatomyFitState)
      siblings.set(next.id, next)
    }
  }

  for (const draft of input.siblingStates ?? []) {
    const next = await siblingRecord(draft)
    siblings.set(next.id, next)
  }

  const snapshot: RecipeStateSnapshot = {
    contract: GOON_RECIPE_STATE_CONTRACT,
    stateSha256: ZERO_SHA256,
    appearanceDials: cloneRecipeJson(input.appearanceDials),
    siblings: [...siblings.values()].sort((left, right) => left.id.localeCompare(right.id))
  }
  snapshot.stateSha256 = await recipeStateSnapshotSha256(snapshot)
  return verifyRecipeStateSnapshot(snapshot)
}

const RECIPE_SIBLING_SURFACES = [
  'facialArtwork',
  'eyeAppearance',
  'oralAppearance'
] as const satisfies readonly RecipeSiblingSurface[]

const RECIPE_SIBLING_ID_ALIASES: Record<RecipeSiblingSurface, readonly string[]> = {
  facialArtwork: ['facialArtwork', 'facial-artwork'],
  eyeAppearance: ['eyeAppearance', 'eye-appearance'],
  oralAppearance: ['oralAppearance', 'oral-appearance']
}

function targetSiblingDefinition(
  manifest: GoonCustomAvatarManifest,
  surface: RecipeSiblingSurface
) {
  const raw = (manifest as Record<string, unknown>)[surface]
  if (raw === undefined || raw === null) return null
  if (surface === 'facialArtwork') {
    const definition = parseFacialArtworkDefinition(raw)
    return {
      contract: definition.stateSchemaVersion,
      definitionSha256: definition.definitionSha256
    }
  }
  if (surface === 'eyeAppearance') {
    const definition = parseEyeAppearanceDefinition(raw)
    return {
      contract: definition.stateSchemaVersion,
      definitionSha256: definition.definitionSha256
    }
  }
  const definition = record(raw, 'avatar.json#oralAppearance')
  return {
    contract: requiredText(
      definition.stateSchemaVersion,
      'avatar.json#oralAppearance.stateSchemaVersion'
    ),
    definitionSha256: requireLowercaseSha256(
      definition.definitionSha256,
      'avatar.json#oralAppearance.definitionSha256'
    )
  }
}

/**
 * Bind all three sibling migration surfaces to the exact current state and
 * verified target package definitions. The caller cannot invent ids, omit a
 * retained sibling, or pass a target definition that contradicts the edge.
 */
export async function buildRecipeSiblingInputs(
  input: BuildRecipeSiblingInputsInput
): Promise<Record<RecipeSiblingSurface, AppearanceRecipeMigrationSiblingInput>> {
  const [state, edge] = await Promise.all([
    withoutAnatomyFitRecipeSibling(input.state),
    verifyRecipeUpdateEdge(input.edge)
  ])
  const remaining = new Map(state.siblings.map((sibling) => [sibling.id, sibling]))
  const subplans = new Map(edge.siblingSubplans.map((subplan) => [subplan.surface, subplan]))
  const result = {} as Record<RecipeSiblingSurface, AppearanceRecipeMigrationSiblingInput>

  for (const surface of RECIPE_SIBLING_SURFACES) {
    const subplan = subplans.get(surface)
    if (!subplan) throw new Error(`Recipe update edge has no ${surface} sibling subplan.`)
    const aliases = RECIPE_SIBLING_ID_ALIASES[surface]
    const aliased = state.siblings.filter((sibling) => aliases.includes(sibling.id))
    if (aliased.length > 1) {
      throw new Error(`Recipe State ambiguously binds more than one ${surface} sibling.`)
    }
    const contractMatches = subplan.fromContract
      ? state.siblings.filter((sibling) => sibling.contract === subplan.fromContract)
      : []
    const source = aliased[0] ?? (contractMatches.length === 1 ? contractMatches[0] : null)
    if (!source && contractMatches.length > 1) {
      throw new Error(`Recipe State ambiguously binds ${surface} by contract.`)
    }
    if ((source === null) !== (subplan.fromContract === null)) {
      throw new Error(`Recipe State ${surface} presence contradicts the selected update edge.`)
    }
    if (source && source.contract !== subplan.fromContract) {
      throw new Error(`Recipe State ${surface} contract contradicts the selected update edge.`)
    }

    const targetDefinition = targetSiblingDefinition(input.targetManifest, surface)
    if ((targetDefinition === null) !== (subplan.toContract === null)) {
      throw new Error(`Target package ${surface} presence contradicts the selected update edge.`)
    }
    if (targetDefinition && targetDefinition.contract !== subplan.toContract) {
      throw new Error(`Target package ${surface} contract contradicts the selected update edge.`)
    }
    if (
      subplan.action === 'keep' &&
      (!source ||
        !targetDefinition ||
        source.definitionSha256 !== targetDefinition.definitionSha256)
    ) {
      throw new Error(`Kept ${surface} must retain the exact definition binding.`)
    }
    if (source) remaining.delete(source.id)
    result[surface] = {
      sourceStateId: source?.id ?? null,
      targetStateId: targetDefinition ? (source?.id ?? surface) : null,
      targetDefinition,
      message: subplan.reason
    }
  }

  if (remaining.size > 0) {
    throw new Error(
      `Recipe State contains unbound sibling state: ${[...remaining.keys()].sort().join(', ')}.`
    )
  }
  return result
}

type PreviewDefinition = {
  id: string
  label: string
  description: string
  range: [number, number]
  step: number
}

function appearanceDefinitionMap(manifest: AppearanceDialsManifest) {
  const definitions = new Map<string, PreviewDefinition>()
  for (const dial of manifest.dials) {
    definitions.set(dial.id, dial)
    if (dial.symmetry?.mode === 'linked-with-offsets') {
      definitions.set(dial.symmetry.left.id, {
        id: dial.symmetry.left.id,
        label: dial.symmetry.left.label,
        description: dial.description,
        range: dial.symmetry.left.range,
        step: dial.symmetry.left.step
      })
      definitions.set(dial.symmetry.right.id, {
        id: dial.symmetry.right.id,
        label: dial.symmetry.right.label,
        description: dial.description,
        range: dial.symmetry.right.range,
        step: dial.symmetry.right.step
      })
    }
  }
  return definitions
}

/** Return only controls explicitly authorized by the verified server plan. */
export async function deriveServerAuthorizedRecipePreviewControls(
  hydration: RecipeAnalysisHydration,
  manifest: AppearanceDialsManifest
): Promise<ServerAuthorizedRecipePreviewControl[]> {
  const plan = parseRecipeMigrationPlan(hydration.plan)
  const state = hydration.reviewedState
    ? (await verifyRecipeReviewedState(hydration.reviewedState)).state
    : plan.proposedState
      ? await verifyRecipeStateSnapshot(plan.proposedState)
      : null
  if (!state) return []
  if (
    manifest.definitionSha256 !== state.appearanceDials.definitionSha256 ||
    manifest.definitionSha256 !== plan.toSource.identities.definitionSha256
  ) {
    throw new Error('Updated preview manifest does not match the server-verified Recipe target.')
  }
  const definitions = appearanceDefinitionMap(manifest)
  return plan.controlRows.flatMap((row) => {
    const endpoint = row.targetControl
    if (!endpoint) return []
    const classification =
      plan.outcome.kind === 'clean-reset' || row.edgeAction === 'reset-required'
        ? 'reset-required'
        : row.edgeAction === 'new'
          ? 'new'
          : null
    if (!classification) return []
    const definition = definitions.get(endpoint.id)
    if (!definition) {
      throw new Error(`Server-authorized preview control ${endpoint.id} is missing from the target manifest.`)
    }
    const value = state.appearanceDials.values[endpoint.id] ?? 0
    return [{
      authorization: 'server-verified' as const,
      id: endpoint.id,
      label: definition.label,
      classification,
      minimum: definition.range[0],
      maximum: definition.range[1],
      step: definition.step,
      neutralValue: 0 as const,
      value,
      reason: row.message,
      description: definition.description
    }]
  })
}

function uploadPath(value: string): string | null {
  if (value.startsWith('/uploads/')) return value
  try {
    const parsed = new URL(value)
    return parsed.pathname.startsWith('/uploads/') ? parsed.pathname : null
  } catch {
    return null
  }
}

function assertUploadFileRef(
  file: GoonFileRef,
  asset: RecipeStoredAssetRef,
  role: keyof RecipeAssetSet
) {
  if (uploadPath(file.url) !== asset.ref || file.filename !== asset.ref.split('/').pop()) {
    throw new Error(`Uploaded Live ${role} file does not match its verified archive receipt.`)
  }
  if (file.size !== undefined && file.size !== asset.bytes) {
    throw new Error(`Uploaded Live ${role} byte count does not match its verified archive receipt.`)
  }
}

/** Preserve the complete content-addressed evidence returned by archive ingest. */
export async function deriveRecipeAssetSetFromUpload(
  upload: CustomGoonPackageUploadResult,
  expected?: GoonLiveBuildReceipt
): Promise<RecipeAssetSet> {
  const receipt = await verifyRecipeArchiveContainmentReceipt(upload.archiveReceipt)
  const manifest = receipt.members.find((member) => member.role === 'manifest')
  const model = receipt.members.find((member) => member.role === 'model')
  if (!manifest || !model) throw new Error('Verified Live archive receipt is incomplete.')
  const live: RecipeAssetSet = {
    package: receipt.archive,
    model: model.extracted,
    manifest: manifest.extracted
  }
  assertUploadFileRef(upload.package, live.package, 'package')
  assertUploadFileRef(upload.model, live.model, 'model')
  assertUploadFileRef(upload.manifest, live.manifest, 'manifest')
  if (expected) {
    const verified = await verifyGoonLiveBuildReceipt(expected)
    for (const role of ['package', 'model', 'manifest'] as const) {
      if (
        live[role].sha256 !== verified.output[role].sha256 ||
        live[role].bytes !== verified.output[role].bytes
      ) {
        throw new Error(`Stored Live ${role} evidence differs from the deterministic bake receipt.`)
      }
    }
  }
  return live
}

async function parseRecipeGoon(value: unknown, context: string) {
  const goon = record(value, context) as unknown as GoonRecord
  requiredText(goon.id, `${context}.id`)
  requiredText(goon.user_id, `${context}.user_id`)
  const owner = await verifyGoonRecipeV2(goon.recipe)
  return { goon, owner }
}

async function parseAnalysisHydration(value: unknown): Promise<RecipeAnalysisHydration> {
  const raw = record(value, 'Recipe analysis response')
  const { goon, owner } = await parseRecipeGoon(raw.goon, 'Recipe analysis response.goon')
  const explicitOwner = await verifyGoonRecipeV2(raw.owner)
  if (canonicalRecipeString(owner) !== canonicalRecipeString(explicitOwner)) {
    throw new Error('Recipe analysis owner differs from the returned Goon.')
  }
  if (!owner.pendingAnalysis) throw new Error('Recipe analysis response has no pending analysis.')
  const plan = parseRecipeMigrationPlan(raw.plan)
  const basePlan = parseRecipeMigrationPlan(raw.basePlan)
  const report = record(raw.report, 'Recipe analysis response.report') as unknown as RecipeMigrationReport
  if (
    report.contract !== RECIPE_MIGRATION_REPORT_CONTRACT ||
    report.directEdgeKey !== plan.directEdgeKey ||
    report.edgeSha256 !== plan.edgeSha256 ||
    report.fromRecipeRevision !== plan.fromRecipeRevision ||
    report.toRecipeRevision !== plan.toRecipeRevision ||
    !report.proof ||
    typeof report.proof.reportSha256 !== 'string'
  ) {
    throw new Error('Recipe analysis report does not match the selected migration plan.')
  }
  requireLowercaseSha256(report.proof.reportSha256, 'Recipe analysis report proof hash')
  const receipt = await verifyRecipeArchiveContainmentReceipt(raw.receipt)
  const reviewedState = raw.reviewedState === null
    ? null
    : await verifyRecipeReviewedState(raw.reviewedState)
  const [planDocumentSha256, basePlanDocumentSha256, reportDocumentSha256, receiptDocumentSha256] =
    await Promise.all([
      canonicalRecipeSha256(plan),
      canonicalRecipeSha256(basePlan),
      canonicalRecipeSha256(report),
      canonicalRecipeSha256(receipt)
    ])
  if (
    owner.pendingAnalysis.selectedPlan.sha256 !== planDocumentSha256 ||
    owner.pendingAnalysis.basePlan.sha256 !== basePlanDocumentSha256 ||
    owner.pendingAnalysis.migrationReport.sha256 !== reportDocumentSha256 ||
    owner.pendingAnalysis.containmentReceipt.sha256 !== receiptDocumentSha256
  ) {
    throw new Error('Recipe analysis evidence differs from the owner pending-analysis refs.')
  }
  if (reviewedState && reviewedState.analysisId !== owner.pendingAnalysis.analysisId) {
    throw new Error('Reviewed Recipe State belongs to another analysis.')
  }
  return {
    goon,
    owner,
    pendingAnalysis: owner.pendingAnalysis,
    plan,
    basePlan,
    report,
    receipt,
    reviewedState
  }
}

async function parseJobResponse(
  value: unknown,
  marker: 'replayed' | 'recovered'
): Promise<RecipeJobStartResponse | RecipeJobRecoveryResponse> {
  const raw = record(value, 'Recipe job response')
  const { goon, owner } = await parseRecipeGoon(raw.goon, 'Recipe job response.goon')
  const job = parseGoonRecipeJob(raw.job)
  const reviewedState = await verifyRecipeReviewedState(raw.reviewedState)
  if (
    job.goonId !== goon.id ||
    job.userId !== goon.user_id ||
    job.reviewedState.sha256 !== await canonicalRecipeSha256(reviewedState) ||
    reviewedState.operation !== job.operation
  ) {
    throw new Error('Recipe job response has inconsistent Goon, job, or reviewed-state bindings.')
  }
  const marked = requiredBoolean(raw[marker], `Recipe job response.${marker}`)
  if (marker === 'replayed') return { goon, job, reviewedState, replayed: marked }
  const candidate = raw.candidate === null
    ? null
    : await verifyRecipeRevisionEnvelope(raw.candidate)
  if (
    Boolean(candidate) !== Boolean(job.candidateRevision) ||
    (candidate && job.candidateRevision && (
      candidate.envelopeSha256 !== job.candidateRevision.sha256 ||
      !job.candidateRevision.ref.endsWith(`:${candidate.revision.revisionId}`)
    ))
  ) {
    throw new Error('Recovered Recipe candidate differs from the job candidate revision ref.')
  }
  return { goon, owner, job, reviewedState, candidate, recovered: marked }
}

async function parseJobActionResponse(value: unknown): Promise<RecipeJobActionResponse> {
  const raw = record(value, 'Recipe job action response')
  const { goon, owner } = await parseRecipeGoon(raw.goon, 'Recipe job action response.goon')
  const job = parseGoonRecipeJob(raw.job)
  return {
    goon,
    owner,
    job,
    ...(raw.cleanup !== undefined ? { cleanup: raw.cleanup } : {}),
    ...(raw.cleanupError === null || typeof raw.cleanupError === 'string'
      ? { cleanupError: raw.cleanupError }
      : {})
  }
}

async function parseCandidateAssetsResponse(
  value: unknown
): Promise<RecipeCandidateAssetsResponse> {
  const raw = record(value, 'Recipe candidate-assets response')
  const { goon, owner } = await parseRecipeGoon(
    raw.goon,
    'Recipe candidate-assets response.goon'
  )
  const explicitOwner = await verifyGoonRecipeV2(raw.owner)
  const job = parseGoonRecipeJob(raw.job)
  if (
    canonicalRecipeString(owner) !== canonicalRecipeString(explicitOwner) ||
    job.goonId !== goon.id ||
    job.userId !== goon.user_id ||
    !job.stagedLive ||
    !owner.pendingJob ||
    owner.pendingJob.jobId !== job.jobId
  ) {
    throw new Error('Recipe candidate registration returned inconsistent ownership bindings.')
  }
  return {
    goon,
    owner,
    job,
    replayed: requiredBoolean(raw.replayed, 'Recipe candidate-assets response.replayed')
  }
}

async function parseStageResponse(value: unknown): Promise<RecipeStageResponse> {
  const raw = record(value, 'Recipe stage response')
  const { goon, owner } = await parseRecipeGoon(raw.goon, 'Recipe stage response.goon')
  return {
    goon,
    owner,
    job: parseGoonRecipeJob(raw.job),
    envelope: await verifyRecipeRevisionEnvelope(raw.envelope)
  }
}

function abortError(message = 'Recipe workflow was aborted.') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export function resolveRecipeAssetUrl(ref: string, batshitServerUrl: string) {
  return ref.startsWith('/uploads/')
    ? new URL(ref, `${batshitServerUrl.replace(/\/+$/, '')}/`).toString()
    : ref
}

export function resolveRecipePreviewGoonAssetUrls(
  goon: GoonRecord,
  batshitServerUrl: string
): GoonRecord {
  const customAvatar = goon.customAvatar
  if (!customAvatar) return goon

  const resolveFile = (file: GoonFileRef | undefined) => {
    if (!file) return file
    const url = resolveRecipeAssetUrl(file.url, batshitServerUrl)
    return url === file.url ? file : { ...file, url }
  }
  const packageFile = resolveFile(customAvatar.package)
  const modelFile = resolveFile(customAvatar.model)
  const manifestFile = resolveFile(customAvatar.manifest)
  if (
    packageFile === customAvatar.package &&
    modelFile === customAvatar.model &&
    manifestFile === customAvatar.manifest
  ) {
    return goon
  }

  return {
    ...goon,
    customAvatar: {
      ...customAvatar,
      package: packageFile,
      model: modelFile,
      manifest: manifestFile
    }
  }
}

async function defaultAssetUrl(ref: string) {
  const { BATSHIT_SERVER_URL } = await import('$lib/services/apiClient')
  return resolveRecipeAssetUrl(ref, BATSHIT_SERVER_URL)
}

async function defaultUploadCustomPackage(goonId: string, file: File) {
  const { uploadCustomGoonPackage } = await import('$lib/services/goons')
  return uploadCustomGoonPackage(goonId, file)
}

async function defaultCleanupCustomPackage(goonId: string, archiveReceipt: unknown) {
  const { cleanupCustomGoonPackageUpload } = await import('$lib/services/goons')
  return cleanupCustomGoonPackageUpload(goonId, archiveReceipt)
}

export class RecipeWorkflowClient {
  readonly goonId: string
  private readonly fetchImpl: typeof fetch
  private readonly bake: typeof bakeLiveGoonInWorker
  private readonly uploadCustomPackage: NonNullable<RecipeWorkflowClientDependencies['uploadCustomPackage']>
  private readonly cleanupCustomPackage: NonNullable<RecipeWorkflowClientDependencies['cleanupCustomPackage']>
  private readonly resolveAssetUrl: NonNullable<RecipeWorkflowClientDependencies['assetUrl']>

  constructor(goonId: string, dependencies: RecipeWorkflowClientDependencies = {}) {
    this.goonId = requiredText(goonId, 'Recipe Goon id')
    this.fetchImpl = dependencies.fetchImpl ?? fetch
    this.bake = dependencies.bake ?? bakeLiveGoonInWorker
    this.uploadCustomPackage = dependencies.uploadCustomPackage ?? defaultUploadCustomPackage
    this.cleanupCustomPackage = dependencies.cleanupCustomPackage ?? defaultCleanupCustomPackage
    this.resolveAssetUrl = dependencies.assetUrl ?? defaultAssetUrl
  }

  private route(path = '') {
    return `/api/goons/${encodeURIComponent(this.goonId)}/recipe${path}`
  }

  private async loadCurrentGoon(signal?: AbortSignal): Promise<GoonRecord> {
    const response = await this.fetchImpl(`/api/goons/${encodeURIComponent(this.goonId)}`, {
      signal
    })
    const text = await response.text()
    let payload: unknown = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        if (response.ok) throw new Error('Current Goon lookup returned invalid JSON.')
        payload = text
      }
    }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as UnknownRecord : null
      throw new RecipeWorkflowHttpError(
        typeof body?.error === 'string' ? body.error : `Current Goon lookup failed (${response.status}).`,
        {
          status: response.status,
          code: typeof body?.code === 'string' ? body.code : null,
          responseBody: payload
        }
      )
    }
    const goon = record(payload, 'Current Goon lookup') as unknown as GoonRecord
    if (goon.id !== this.goonId || typeof goon.updated_at !== 'string') {
      throw new Error('Current Goon lookup returned a mismatched or incomplete record.')
    }
    return goon
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetchImpl(this.route(path), init)
    const text = await response.text()
    let payload: unknown = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        if (response.ok) throw new Error(`Recipe route ${path || '/'} returned invalid JSON.`)
        payload = text
      }
    }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as UnknownRecord : null
      const message = typeof body?.error === 'string'
        ? body.error
        : `Recipe request failed (${response.status}).`
      throw new RecipeWorkflowHttpError(message, {
        status: response.status,
        code: typeof body?.code === 'string' ? body.code : null,
        responseBody: payload
      })
    }
    if (payload === null) throw new Error(`Recipe route ${path || '/'} returned no response body.`)
    return payload
  }

  private json(method: string, body: unknown, signal?: AbortSignal): RequestInit {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }
  }

  async initialize(
    request: BootstrapRecipeRequest,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeInitializationResponse> {
    const payload = record(
      await this.request('/bootstrap', this.json('POST', request, options.signal)),
      'Recipe initialization response'
    )
    const { goon, owner } = await parseRecipeGoon(payload.goon, 'Recipe initialization response.goon')
    const rawReceipt = record(
      payload.containmentReceipt,
      'Recipe initialization response.containmentReceipt'
    )
    const containmentReceipt: RecipeDocumentRef = {
      contract: requiredText(rawReceipt.contract, 'Recipe initialization containment contract'),
      ref: requiredText(rawReceipt.ref, 'Recipe initialization containment ref'),
      sha256: requireLowercaseSha256(
        rawReceipt.sha256,
        'Recipe initialization containment hash'
      )
    }
    if (
      containmentReceipt.contract !== RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT ||
      canonicalRecipeString(owner.authoringSourceContainmentReceipt) !==
        canonicalRecipeString(containmentReceipt)
    ) {
      throw new Error('Initialized Recipe owner does not bind the returned containment receipt.')
    }
    return { goon, owner, containmentReceipt }
  }

  async initializeFromCurrentPackage(
    goon: GoonRecord,
    state: RecipeStateSnapshot,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeInitializationResponse> {
    const current = goon.customAvatar?.package
    if (!current?.url || !current.filename) {
      throw new Error('Recipe initialization requires the current Advanced/GLB package.')
    }
    throwIfAborted(options.signal)
    const bytes = await this.fetchExactBytes(current.url, undefined, current.size, options.signal)
    const filename = current.filename.toLowerCase().endsWith('.bgoon')
      ? current.filename
      : `${current.filename}.bgoon`
    const upload = await this.uploadCustomPackage(
      this.goonId,
      new File([bytes], filename, { type: 'application/zip' })
    )
    try {
      const receipt = await verifyRecipeArchiveContainmentReceipt(upload.archiveReceipt)
      if (receipt.archive.sha256 !== await sha256Hex(bytes) || receipt.archive.bytes !== bytes.byteLength) {
        throw new Error('Re-uploaded current package does not match the exact initialization bytes.')
      }

      // Reading and re-uploading a large source package gives ordinary runtime
      // state (especially the editor camera) time to save. Refresh the record
      // after the upload so that runtime-only writes cannot create a false
      // bootstrap conflict. The exact source package must still be unchanged;
      // initialization never merges across a real file replacement.
      const latestGoon = await this.loadCurrentGoon(options.signal)
      if (
        canonicalRecipeString(latestGoon.customAvatar?.package ?? null) !==
        canonicalRecipeString(current)
      ) {
        throw new Error('The Goon file changed while initial preparation was starting. Retry preparation from the current file.')
      }
      return await this.initialize({
        expectedUpdatedAt: latestGoon.updated_at,
        receipt,
        state: await verifyRecipeStateSnapshot(state)
      }, options)
    } catch (error) {
      try {
        await this.cleanupCustomPackage(this.goonId, upload.archiveReceipt)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Recipe initialization failed and its rejected upload could not be cleaned: ${errorMessage(cleanupError)}`
        )
      }
      throw error
    }
  }

  async hydrateAnalysis(options: RecipeWorkflowRequestOptions = {}) {
    return parseAnalysisHydration(await this.request('/analysis', { signal: options.signal }))
  }

  async analyzeUpdate(
    request: AnalyzeRecipePackageUpdateRequest,
    options: RecipeWorkflowRequestOptions = {}
  ) {
    return parseAnalysisHydration(
      await this.request('/analyze', this.json('POST', request, options.signal))
    )
  }

  async loadAnalysisTargetManifest(
    hydration: RecipeAnalysisHydration,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<GoonCustomAvatarManifest> {
    const plan = parseRecipeMigrationPlan(hydration.plan)
    const receipt = await verifyRecipeArchiveContainmentReceipt(hydration.receipt)
    const storedManifest = receipt.members.find((member) => member.role === 'manifest')?.extracted
    if (
      !storedManifest ||
      storedManifest.ref !== plan.toSource.manifest.ref ||
      storedManifest.sha256 !== plan.toSource.manifest.sha256
    ) {
      throw new Error('Recipe analysis target manifest differs from its archive containment receipt.')
    }
    const bytes = await this.fetchExactBytes(
      storedManifest.ref,
      storedManifest.sha256,
      storedManifest.bytes,
      options.signal
    )
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      throw new Error(`Recipe analysis target avatar.json is invalid: ${errorMessage(error)}`)
    }
    return record(parsed, 'Recipe analysis target avatar.json') as GoonCustomAvatarManifest
  }

  async loadAnalysisTargetModelBytes(
    hydration: RecipeAnalysisHydration,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<Uint8Array> {
    const plan = parseRecipeMigrationPlan(hydration.plan)
    const receipt = await verifyRecipeArchiveContainmentReceipt(hydration.receipt)
    const storedModel = receipt.members.find((member) => member.role === 'model')?.extracted
    if (
      !storedModel ||
      storedModel.ref !== plan.toSource.model.ref ||
      storedModel.sha256 !== plan.toSource.model.sha256
    ) {
      throw new Error('Recipe analysis target model differs from its archive containment receipt.')
    }
    return this.fetchExactBytes(
      storedModel.ref,
      storedModel.sha256,
      storedModel.bytes,
      options.signal
    )
  }

  async discardAnalysis(
    request: DiscardRecipeAnalysisRequest,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeAnalysisDiscardResponse> {
    const payload = record(
      await this.request('/analysis', this.json('DELETE', request, options.signal)),
      'Recipe discard response'
    )
    const { goon, owner } = await parseRecipeGoon(payload.goon, 'Recipe discard response.goon')
    if (payload.discarded !== true || owner.pendingAnalysis) {
      throw new Error('Recipe analysis discard did not clear the pending analysis.')
    }
    return { goon, owner, discarded: true, deletedAssets: payload.deletedAssets }
  }

  async resetAnalysis(
    request: ResetRecipeAnalysisRequest,
    options: RecipeWorkflowRequestOptions = {}
  ) {
    return parseAnalysisHydration(
      await this.request('/analysis/reset', this.json('POST', request, options.signal))
    )
  }

  async reviewAnalysisState(
    request: ReviewRecipeStateRequest,
    options: RecipeWorkflowRequestOptions = {}
  ) {
    return parseAnalysisHydration(
      await this.request('/analysis/review-state', this.json('POST', request, options.signal))
    )
  }

  async startBake(
    request: StartRecipeBakeRequest,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeJobStartResponse> {
    return parseJobResponse(
      await this.request('/bake/start', this.json('POST', request, options.signal)),
      'replayed'
    ) as Promise<RecipeJobStartResponse>
  }

  async startPackageUpdate(
    request: StartRecipePackageUpdateRequest,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeJobStartResponse> {
    return parseJobResponse(
      await this.request('/start', this.json('POST', request, options.signal)),
      'replayed'
    ) as Promise<RecipeJobStartResponse>
  }

  async recoverJob(
    jobId: string,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeJobRecoveryResponse> {
    return parseJobResponse(
      await this.request(`/jobs/${encodeURIComponent(jobId)}`, { signal: options.signal }),
      'recovered'
    ) as Promise<RecipeJobRecoveryResponse>
  }

  async actOnJob(
    jobId: string,
    request: RecipeJobActionRequest,
    options: RecipeWorkflowRequestOptions = {}
  ) {
    return parseJobActionResponse(
      await this.request(
        `/jobs/${encodeURIComponent(jobId)}`,
        this.json('POST', request, options.signal)
      )
    )
  }

  retryJob(job: RecipeJobRecoveryResponse | RecipeJobActionResponse) {
    return this.actOnJob(job.job.jobId, {
      action: 'retry',
      expectedWriteVersion: job.owner.writeVersion,
      expectedJobStateVersion: job.job.stateVersion
    })
  }

  discardJob(job: RecipeJobRecoveryResponse | RecipeJobActionResponse) {
    return this.actOnJob(job.job.jobId, {
      action: 'discard',
      expectedWriteVersion: job.owner.writeVersion,
      expectedJobStateVersion: job.job.stateVersion
    })
  }

  async stageCandidate(
    jobId: string,
    request: StageRecipeCandidateRequest,
    options: RecipeWorkflowRequestOptions = {}
  ) {
    return parseStageResponse(
      await this.request(
        `/jobs/${encodeURIComponent(jobId)}/stage`,
        this.json('POST', request, options.signal)
      )
    )
  }

  async registerCandidateAssets(
    jobId: string,
    request: RegisterRecipeCandidateAssetsRequest,
    options: RecipeWorkflowRequestOptions = {}
  ) {
    return parseCandidateAssetsResponse(
      await this.request(
        `/jobs/${encodeURIComponent(jobId)}/candidate-assets`,
        this.json('POST', request, options.signal)
      )
    )
  }

  async commitJob(
    jobId: string,
    request: { expectedWriteVersion: number; expectedJobStateVersion: number },
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeCommitResponse> {
    const payload = record(
      await this.request(
        `/jobs/${encodeURIComponent(jobId)}/commit`,
        this.json('POST', request, options.signal)
      ),
      'Recipe commit response'
    )
    const staged = await parseStageResponse(payload)
    if (payload.cleanupError !== null && typeof payload.cleanupError !== 'string') {
      throw new Error('Recipe commit cleanupError must be a string or null.')
    }
    return {
      ...staged,
      cleanup: payload.cleanup,
      cleanupError: payload.cleanupError as string | null
    }
  }

  async rollback(
    expectedWriteVersion: number,
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeRollbackResponse> {
    const payload = record(
      await this.request(
        '/rollback',
        this.json('POST', { expectedWriteVersion }, options.signal)
      ),
      'Recipe rollback response'
    )
    const { goon, owner } = await parseRecipeGoon(payload.goon, 'Recipe rollback response.goon')
    if (payload.cleanupError !== null && typeof payload.cleanupError !== 'string') {
      throw new Error('Recipe rollback cleanupError must be a string or null.')
    }
    return {
      goon,
      owner,
      restored: await verifyRecipeRevisionEnvelope(payload.restored),
      replaced: await verifyRecipeRevisionEnvelope(payload.replaced),
      cleanup: payload.cleanup,
      cleanupError: payload.cleanupError as string | null
    }
  }

  async previewRollback(
    options: RecipeWorkflowRequestOptions = {}
  ): Promise<RecipeRollbackPreviewResponse> {
    const payload = record(
      await this.request('/rollback', { signal: options.signal }),
      'Recipe rollback preview response'
    )
    const { goon, owner } = await parseRecipeGoon(
      payload.goon,
      'Recipe rollback preview response.goon'
    )
    const previous = await verifyRecipeRevisionEnvelope(payload.previous)
    if (
      !owner.previousRevision ||
      canonicalRecipeString(owner.previousRevision) !==
        canonicalRecipeString({
          contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
          ref: `goon_recipe_revision:${goon.user_id}:${this.goonId}:${previous.revision.revisionId}`,
          sha256: previous.envelopeSha256
        })
    ) {
      throw new Error('Rollback preview does not match the owner previous-revision reference.')
    }
    return { goon, owner, previous }
  }

  private async fetchExactBytes(
    ref: string,
    expectedSha256?: string,
    expectedBytes?: number,
    signal?: AbortSignal
  ) {
    const url = ref.startsWith('/uploads/') ? await this.resolveAssetUrl(ref) : ref
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || signal?.aborted) throw error
      throw new Error(
        `Failed to load exact Recipe asset ${ref}: ${errorMessage(error)}`,
        { cause: error }
      )
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch exact Recipe asset ${ref} (${response.status}).`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error(`Recipe asset ${ref} is empty.`)
    if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
      throw new Error(`Recipe asset ${ref} byte count does not match its trusted evidence.`)
    }
    if (expectedSha256 && await sha256Hex(bytes) !== expectedSha256) {
      throw new Error(`Recipe asset ${ref} hash does not match its trusted evidence.`)
    }
    return bytes
  }

  private async fetchJobSource(job: GoonRecipeJob, signal?: AbortSignal) {
    const source = job.stagedSource.source
    const [packageBytes, modelBytes, manifestBytes] = await Promise.all([
      this.fetchExactBytes(source.package.ref, source.package.sha256, undefined, signal),
      this.fetchExactBytes(source.model.ref, source.model.sha256, undefined, signal),
      this.fetchExactBytes(source.manifest.ref, source.manifest.sha256, undefined, signal)
    ])
    return { packageBytes, modelBytes, manifestBytes }
  }

  private async recordDurableFailure(
    jobId: string,
    stage: RecipeFailureStage,
    failure: unknown
  ) {
    const current = await this.recoverJob(jobId)
    if (!ACTIVE_JOB_STATUSES.has(current.job.status)) return
    await this.actOnJob(jobId, {
      action: 'fail',
      expectedWriteVersion: current.owner.writeVersion,
      expectedJobStateVersion: current.job.stateVersion,
      stage,
      reason: errorMessage(failure).slice(0, 2_000),
      reportRef: null
    })
  }

  async buildUploadStageCommit(input: RecipeBuildWorkflowInput): Promise<RecipeBuildWorkflowResult> {
    throwIfAborted(input.signal)
    input.onProgress?.('starting')
    const started = input.start.kind === 'package-update'
      ? await this.startPackageUpdate(input.start.request)
      : await this.startBake(input.start.request)
    let uploadedArchiveReceipt: unknown = null
    let failureStage: RecipeFailureStage = 'validating'
    try {
      throwIfAborted(input.signal)
      input.onProgress?.('fetching-source')
      const sourceBytes = await this.fetchJobSource(started.job, input.signal)
      failureStage = 'baking'
      const bakeOptions: LiveGoonBakerClientOptions = {
        signal: input.signal,
        onProgress: input.onProgress
      }
      const bake = await this.bake({
        source: started.job.stagedSource.source,
        sourceRevision: {
          revisionId: started.job.targetRevisionId,
          revision: started.job.targetRecipeRevision
        },
        state: started.reviewedState.state,
        ...sourceBytes
      }, bakeOptions)
      const buildReceipt = await verifyGoonLiveBuildReceipt(bake.receipt)
      throwIfAborted(input.signal)
      failureStage = 'upload'
      input.onProgress?.('uploading-candidate')
      const upload = await this.uploadCustomPackage(
        this.goonId,
        new File(
          [exactArrayBuffer(bake.packageBytes)],
          input.candidateFilename ?? `${this.goonId}-live-r${started.job.targetRecipeRevision}.bgoon`,
          { type: 'application/zip' }
        )
      )
      uploadedArchiveReceipt = upload.archiveReceipt
      // The verified archive receipt is sufficient to bind cleanup ownership.
      // Register it before any build-receipt comparison or cancellation check.
      const live = await deriveRecipeAssetSetFromUpload(upload)
      failureStage = 'packaging'
      input.onProgress?.('registering-candidate')
      const registered = await this.registerCandidateAssets(started.job.jobId, {
        expectedWriteVersion: (started.goon.recipe as GoonRecipeV2).writeVersion,
        expectedJobStateVersion: started.job.stateVersion,
        live
      })
      await deriveRecipeAssetSetFromUpload(upload, buildReceipt)
      throwIfAborted(input.signal)
      failureStage = 'verifying'
      input.onProgress?.('staging-candidate')
      const staged = await this.stageCandidate(started.job.jobId, {
        expectedWriteVersion: registered.owner.writeVersion,
        expectedJobStateVersion: registered.job.stateVersion,
        liveBuildReceipt: buildReceipt,
        live
      })
      throwIfAborted(input.signal)
      failureStage = 'preview-load'
      input.onProgress?.('previewing-candidate')
      await input.previewCandidate(staged)
      throwIfAborted(input.signal)
      failureStage = 'committing'
      input.onProgress?.('committing')
      const committed = await this.commitJob(staged.job.jobId, {
        expectedWriteVersion: staged.owner.writeVersion,
        expectedJobStateVersion: staged.job.stateVersion
      })
      input.onProgress?.('complete')
      return { started, bake, upload, live, registered, staged, committed }
    } catch (error) {
      let durabilityError: unknown = null
      let cleanupError: unknown = null
      try {
        await this.recordDurableFailure(started.job.jobId, failureStage, error)
      } catch (nextError) {
        durabilityError = nextError
      }
      if (uploadedArchiveReceipt) {
        try {
          await this.cleanupCustomPackage(this.goonId, uploadedArchiveReceipt)
        } catch (nextError) {
          cleanupError = nextError
        }
      }
      if (durabilityError || cleanupError) {
        const failures = [error, durabilityError, cleanupError].filter(Boolean)
        const details = [
          durabilityError
            ? `durable failure state could not be confirmed: ${errorMessage(durabilityError)}`
            : null,
          cleanupError
            ? `rejected upload cleanup could not be confirmed: ${errorMessage(cleanupError)}`
            : null
        ].filter(Boolean).join('; ')
        const combined = new AggregateError(failures, `Recipe workflow failed and ${details}`)
        if ((error as Error)?.name === 'AbortError' || input.signal?.aborted) combined.name = 'AbortError'
        throw combined
      }
      throw error
    }
  }

  async resumeReadyCandidate(input: RecipeReadyResumeInput): Promise<RecipeCommitResponse> {
    const { recovery } = input
    if (
      recovery.goon.id !== this.goonId ||
      recovery.job.goonId !== this.goonId ||
      recovery.job.status !== 'ready' ||
      !recovery.job.stagedLive ||
      !recovery.candidate ||
      canonicalRecipeString(recovery.job.stagedLive) !==
        canonicalRecipeString(recovery.candidate.live)
    ) {
      throw new Error('Recipe Retry cannot resume because the verified ready candidate is incomplete.')
    }

    const staged: RecipeStageResponse = {
      goon: recovery.goon,
      owner: recovery.owner,
      job: recovery.job,
      envelope: recovery.candidate
    }
    let failureStage: RecipeFailureStage = 'preview-load'
    try {
      throwIfAborted(input.signal)
      input.onProgress?.('previewing-candidate')
      await input.previewCandidate(staged)
      throwIfAborted(input.signal)
      failureStage = 'committing'
      input.onProgress?.('committing')
      const committed = await this.commitJob(recovery.job.jobId, {
        expectedWriteVersion: recovery.owner.writeVersion,
        expectedJobStateVersion: recovery.job.stateVersion
      })
      input.onProgress?.('complete')
      return committed
    } catch (error) {
      try {
        await this.recordDurableFailure(recovery.job.jobId, failureStage, error)
      } catch (durabilityError) {
        const combined = new AggregateError(
          [error, durabilityError],
          `Recipe Retry failed and durable failure state could not be confirmed: ${errorMessage(durabilityError)}`
        )
        if ((error as Error)?.name === 'AbortError' || input.signal?.aborted) combined.name = 'AbortError'
        throw combined
      }
      throw error
    }
  }
}

export function createRecipeWorkflowClient(
  goonId: string,
  dependencies: RecipeWorkflowClientDependencies = {}
) {
  return new RecipeWorkflowClient(goonId, dependencies)
}

export function runRecipeBakeUploadStageCommit(
  client: RecipeWorkflowClient,
  input: RecipeBuildWorkflowInput
) {
  return client.buildUploadStageCommit(input)
}

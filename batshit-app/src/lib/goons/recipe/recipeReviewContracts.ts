import type { GoonRecord } from '$lib/types/goons'
import {
  parseRecipeComponentMapBundle,
  type RecipeComponentMapBundle
} from './componentMapContracts'
import { RECIPE_MIGRATION_PLAN_CONTRACT, type RecipeMigrationPlan } from './migrationPlanContracts'
import {
  GOON_RECIPE_STATE_CONTRACT,
  parseRecipeStateSnapshot,
  parseRecipeSiblingStateRecord,
  verifyRecipeStateSnapshot,
  type RecipeDocumentRef,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot
} from './recipeContracts'
import type {
  AppearanceRecipeMigrationExternalSiblingInput,
  AppearanceRecipeMigrationSiblingInput
} from './appearanceRecipeMigrationPlanner'
import type { RecipeArchiveContainmentReceipt } from './archiveContainmentContracts'
import type {
  GoonRecipeJob,
  GoonRecipeV2,
  RecipeAssetSet,
  RecipePendingAnalysisV2
} from './recipeLifecycleContracts'
import type { GoonLiveBuildReceipt } from './liveBuildContracts'
import { RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT } from './archiveContainmentContracts'
import { RECIPE_MIGRATION_REPORT_CONTRACT } from './contractIds'
import { canonicalRecipeString, requireLowercaseSha256 } from './recipeCanonical'
import { type RecipeMigrationReport, type RecipeSiblingSurface } from './updateContracts'

export const RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT = 'recipe-update-analysis-context/v3' as const
export const RECIPE_REVIEWED_STATE_CONTRACT = 'recipe-reviewed-state/v1' as const

export const RECIPE_REVIEW_OPERATIONS = ['first-bake', 'rebake', 'package-update'] as const

export type RecipeReviewOperation = (typeof RECIPE_REVIEW_OPERATIONS)[number]

export type RecipeSerializableSiblingInput = {
  sourceStateId: string | null
  targetStateId: string | null
  targetDefinition: {
    contract: string
    definitionSha256: string
  } | null
  message: string | null
}

export type RecipeSerializableExternalSiblingInput = {
  sourceStateId: string
  targetStateId: string
  validationSha256: string
  message: string
  targetState: RecipeSiblingStateRecord
}

export type RecipeUpdateAnalysisContext = {
  contract: typeof RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT
  analysisId: string
  sourceRevision: RecipeDocumentRef
  containmentReceipt: RecipeDocumentRef
  basePlan: RecipeDocumentRef
  siblingInputs: Record<RecipeSiblingSurface, RecipeSerializableSiblingInput>
  externalSiblingInputs: RecipeSerializableExternalSiblingInput[]
  componentMapBundle: RecipeComponentMapBundle | null
}

export type RecipeReviewedState = {
  contract: typeof RECIPE_REVIEWED_STATE_CONTRACT
  reviewId: string
  operation: RecipeReviewOperation
  analysisId: string | null
  planSha256: string | null
  containmentReceiptSha256: string
  state: RecipeStateSnapshot
  adjustedControlIds: string[]
  confirmedControlIds: string[]
  cleanResetConfirmed: boolean
}

export type BootstrapRecipeRequest = {
  expectedUpdatedAt: string
  receipt: RecipeArchiveContainmentReceipt
  state: RecipeStateSnapshot
}

export type AnalyzeRecipePackageUpdateRequest = {
  receipt: RecipeArchiveContainmentReceipt
  siblingInputs: Record<RecipeSiblingSurface, AppearanceRecipeMigrationSiblingInput>
  componentMapBundle?: RecipeComponentMapBundle
}

export type ResetRecipeAnalysisRequest = {
  expectedWriteVersion: number
  analysisId: string
  confirmed: true
}

export type ReviewRecipeStateRequest = {
  expectedWriteVersion: number
  analysisId: string
  state: RecipeStateSnapshot
  confirmedControlIds: string[]
  cleanResetConfirmed: boolean
}

export type DiscardRecipeAnalysisRequest = {
  expectedWriteVersion: number
  analysisId: string
  confirmed: true
}

export type StartRecipeBakeRequest = {
  expectedWriteVersion: number
  idempotencyKey: string
  state: RecipeStateSnapshot
}

export type StartRecipePackageUpdateRequest = {
  expectedWriteVersion: number
  idempotencyKey: string
  analysisId: string
}

export type StageRecipeCandidateRequest = {
  expectedWriteVersion: number
  expectedJobStateVersion: number
  liveBuildReceipt: GoonLiveBuildReceipt
  live: RecipeAssetSet
}

export type RegisterRecipeCandidateAssetsRequest = {
  expectedWriteVersion: number
  expectedJobStateVersion: number
  live: RecipeAssetSet
}

export type RecipeAnalysisHydration = {
  goon: GoonRecord
  owner: GoonRecipeV2
  pendingAnalysis: RecipePendingAnalysisV2
  plan: RecipeMigrationPlan
  basePlan: RecipeMigrationPlan
  report: RecipeMigrationReport
  receipt: RecipeArchiveContainmentReceipt
  reviewedState: RecipeReviewedState | null
}

export type RecipeJobStartResponse = {
  goon: GoonRecord
  job: GoonRecipeJob
  reviewedState: RecipeReviewedState
  replayed: boolean
}

type UnknownRecord = Record<string, unknown>

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const VERSIONED_CONTRACT_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/v[1-9][0-9]*$/
const SIBLING_SURFACES: RecipeSiblingSurface[] = [
  'eyeAppearance',
  'facialArtwork',
  'oralAppearance'
]

function fail(context: string, message: string): never {
  throw new Error(`[Recipe review] ${context} ${message}`)
}

function record(value: unknown, context: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(context, 'must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(context, 'must be a plain object')
  }
  return value as UnknownRecord
}

function exactKeys(value: UnknownRecord, expected: readonly string[], context: string) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(context, `must contain exactly: ${wanted.join(', ')}`)
  }
}

function text(value: unknown, context: string) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(context, 'must be a non-empty trimmed string without control characters')
  }
  return value
}

function stableId(value: unknown, context: string) {
  const parsed = text(value, context)
  if (!STABLE_ID_PATTERN.test(parsed)) fail(context, 'must be a stable id')
  return parsed
}

function versionedContract(value: unknown, context: string) {
  const parsed = text(value, context)
  if (!VERSIONED_CONTRACT_PATTERN.test(parsed)) fail(context, 'must be a versioned contract id')
  return parsed
}

function documentRef(
  value: unknown,
  context: string,
  requiredContract?: string
): RecipeDocumentRef {
  const raw = record(value, context)
  exactKeys(raw, ['contract', 'ref', 'sha256'], context)
  const contract = versionedContract(raw.contract, `${context}.contract`)
  if (requiredContract && contract !== requiredContract) {
    fail(`${context}.contract`, `must equal ${requiredContract}`)
  }
  return {
    contract,
    ref: text(raw.ref, `${context}.ref`),
    sha256: requireLowercaseSha256(raw.sha256, `${context}.sha256`)
  }
}

function stableIds(value: unknown, context: string) {
  if (!Array.isArray(value)) fail(context, 'must be an array')
  const result = value.map((entry, index) => stableId(entry, `${context}[${index}]`))
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => index > 0 && result[index - 1]! >= entry)
  ) {
    fail(context, 'must be sorted and unique')
  }
  return result
}

function nullableStableId(value: unknown, context: string) {
  return value === null ? null : stableId(value, context)
}

function parseSiblingInput(value: unknown, context: string): RecipeSerializableSiblingInput {
  const raw = record(value, context)
  exactKeys(raw, ['sourceStateId', 'targetStateId', 'targetDefinition', 'message'], context)
  let targetDefinition: RecipeSerializableSiblingInput['targetDefinition'] = null
  if (raw.targetDefinition !== null) {
    const definition = record(raw.targetDefinition, `${context}.targetDefinition`)
    exactKeys(definition, ['contract', 'definitionSha256'], `${context}.targetDefinition`)
    targetDefinition = {
      contract: versionedContract(definition.contract, `${context}.targetDefinition.contract`),
      definitionSha256: requireLowercaseSha256(
        definition.definitionSha256,
        `${context}.targetDefinition.definitionSha256`
      )
    }
  }
  return {
    sourceStateId: nullableStableId(raw.sourceStateId, `${context}.sourceStateId`),
    targetStateId: nullableStableId(raw.targetStateId, `${context}.targetStateId`),
    targetDefinition,
    message: raw.message === null ? null : text(raw.message, `${context}.message`)
  }
}

function parseExternalSiblingInput(
  value: unknown,
  context: string
): RecipeSerializableExternalSiblingInput {
  const raw = record(value, context)
  exactKeys(
    raw,
    ['sourceStateId', 'targetStateId', 'validationSha256', 'message', 'targetState'],
    context
  )
  const sourceStateId = stableId(raw.sourceStateId, `${context}.sourceStateId`)
  const targetStateId = stableId(raw.targetStateId, `${context}.targetStateId`)
  if (sourceStateId !== targetStateId) {
    fail(context, 'must retain the exact external sibling state id')
  }
  const targetState = parseRecipeSiblingStateRecord(raw.targetState, `${context}.targetState`)
  if (targetState.id !== targetStateId) {
    fail(context, 'targetState.id must match targetStateId')
  }
  return {
    sourceStateId,
    targetStateId,
    validationSha256: requireLowercaseSha256(raw.validationSha256, `${context}.validationSha256`),
    message: text(raw.message, `${context}.message`),
    targetState
  }
}

export function serializeRecipeSiblingInputs(
  inputs: Record<RecipeSiblingSurface, AppearanceRecipeMigrationSiblingInput>
): Record<RecipeSiblingSurface, RecipeSerializableSiblingInput> {
  return Object.fromEntries(
    SIBLING_SURFACES.map((surface) => {
      const input = inputs[surface]
      if (!input) fail(`siblingInputs.${surface}`, 'is required')
      return [
        surface,
        {
          sourceStateId: input.sourceStateId,
          targetStateId: input.targetStateId,
          targetDefinition: input.targetDefinition,
          message: input.message ?? null
        }
      ]
    })
  ) as Record<RecipeSiblingSurface, RecipeSerializableSiblingInput>
}

export function deserializeRecipeSiblingInputs(
  inputs: Record<RecipeSiblingSurface, RecipeSerializableSiblingInput>
): Record<RecipeSiblingSurface, AppearanceRecipeMigrationSiblingInput> {
  return Object.fromEntries(
    SIBLING_SURFACES.map((surface) => {
      const input = inputs[surface]
      return [
        surface,
        {
          sourceStateId: input.sourceStateId,
          targetStateId: input.targetStateId,
          targetDefinition: input.targetDefinition,
          ...(input.message ? { message: input.message } : {})
        }
      ]
    })
  ) as Record<RecipeSiblingSurface, AppearanceRecipeMigrationSiblingInput>
}

export function serializeRecipeExternalSiblingInputs(
  inputs: AppearanceRecipeMigrationExternalSiblingInput[]
): RecipeSerializableExternalSiblingInput[] {
  const serialized = inputs.map((input, index) =>
    parseExternalSiblingInput(input, `externalSiblingInputs[${index}]`)
  )
  serialized.sort((left, right) => left.sourceStateId.localeCompare(right.sourceStateId))
  if (new Set(serialized.map((input) => input.sourceStateId)).size !== serialized.length) {
    fail('externalSiblingInputs', 'must contain unique source state ids')
  }
  return serialized
}

export function deserializeRecipeExternalSiblingInputs(
  inputs: RecipeSerializableExternalSiblingInput[]
): AppearanceRecipeMigrationExternalSiblingInput[] {
  const parsed = inputs.map((input, index) =>
    parseExternalSiblingInput(input, `externalSiblingInputs[${index}]`)
  )
  const sourceIds = parsed.map((input) => input.sourceStateId)
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some((id, index) => index > 0 && sourceIds[index - 1]! >= id)
  ) {
    fail('externalSiblingInputs', 'must be sorted and unique')
  }
  return parsed
}

export function parseRecipeUpdateAnalysisContext(value: unknown): RecipeUpdateAnalysisContext {
  canonicalRecipeString(value)
  const raw = record(value, 'analysis context')
  exactKeys(
    raw,
    [
      'contract',
      'analysisId',
      'sourceRevision',
      'containmentReceipt',
      'basePlan',
      'siblingInputs',
      'externalSiblingInputs',
      'componentMapBundle'
    ],
    'analysis context'
  )
  if (raw.contract !== RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT) {
    fail('analysis context.contract', `must equal ${RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT}`)
  }
  const siblingInputRecord = record(raw.siblingInputs, 'analysis context.siblingInputs')
  exactKeys(siblingInputRecord, SIBLING_SURFACES, 'analysis context.siblingInputs')
  if (!Array.isArray(raw.externalSiblingInputs)) {
    fail('analysis context.externalSiblingInputs', 'must be an array')
  }
  const externalSiblingInputs = raw.externalSiblingInputs.map((entry, index) =>
    parseExternalSiblingInput(entry, `analysis context.externalSiblingInputs[${index}]`)
  )
  const externalSourceIds = externalSiblingInputs.map((entry) => entry.sourceStateId)
  if (
    new Set(externalSourceIds).size !== externalSourceIds.length ||
    externalSourceIds.some((id, index) => index > 0 && externalSourceIds[index - 1]! >= id)
  ) {
    fail('analysis context.externalSiblingInputs', 'must be sorted and unique')
  }
  return {
    contract: RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT,
    analysisId: stableId(raw.analysisId, 'analysis context.analysisId'),
    sourceRevision: documentRef(raw.sourceRevision, 'analysis context.sourceRevision'),
    containmentReceipt: documentRef(
      raw.containmentReceipt,
      'analysis context.containmentReceipt',
      RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT
    ),
    basePlan: documentRef(
      raw.basePlan,
      'analysis context.basePlan',
      RECIPE_MIGRATION_PLAN_CONTRACT
    ),
    siblingInputs: Object.fromEntries(
      SIBLING_SURFACES.map((surface) => [
        surface,
        parseSiblingInput(siblingInputRecord[surface], `analysis context.siblingInputs.${surface}`)
      ])
    ) as Record<RecipeSiblingSurface, RecipeSerializableSiblingInput>,
    externalSiblingInputs,
    componentMapBundle:
      raw.componentMapBundle === null ? null : parseRecipeComponentMapBundle(raw.componentMapBundle)
  }
}

export async function verifyRecipeUpdateAnalysisContext(value: unknown) {
  return parseRecipeUpdateAnalysisContext(value)
}

export async function verifyRecipeReviewedState(value: unknown): Promise<RecipeReviewedState> {
  canonicalRecipeString(value)
  const raw = record(value, 'reviewed state')
  exactKeys(
    raw,
    [
      'contract',
      'reviewId',
      'operation',
      'analysisId',
      'planSha256',
      'containmentReceiptSha256',
      'state',
      'adjustedControlIds',
      'confirmedControlIds',
      'cleanResetConfirmed'
    ],
    'reviewed state'
  )
  if (raw.contract !== RECIPE_REVIEWED_STATE_CONTRACT) {
    fail('reviewed state.contract', `must equal ${RECIPE_REVIEWED_STATE_CONTRACT}`)
  }
  if (!RECIPE_REVIEW_OPERATIONS.includes(raw.operation as RecipeReviewOperation)) {
    fail('reviewed state.operation', 'is unsupported')
  }
  if (typeof raw.cleanResetConfirmed !== 'boolean') {
    fail('reviewed state.cleanResetConfirmed', 'must be boolean')
  }
  const state = await verifyRecipeStateSnapshot(parseRecipeStateSnapshot(raw.state))
  if (state.contract !== GOON_RECIPE_STATE_CONTRACT) {
    fail('reviewed state.state.contract', `must equal ${GOON_RECIPE_STATE_CONTRACT}`)
  }
  const operation = raw.operation as RecipeReviewOperation
  const analysisId =
    raw.analysisId === null ? null : stableId(raw.analysisId, 'reviewed state.analysisId')
  const planSha256 =
    raw.planSha256 === null
      ? null
      : requireLowercaseSha256(raw.planSha256, 'reviewed state.planSha256')
  if (operation === 'package-update' ? !analysisId || !planSha256 : analysisId || planSha256) {
    fail('reviewed state', 'analysis and plan bindings must exist exactly for package updates')
  }
  if (operation !== 'package-update' && raw.cleanResetConfirmed !== false) {
    fail('reviewed state.cleanResetConfirmed', 'is only valid for package updates')
  }
  return {
    contract: RECIPE_REVIEWED_STATE_CONTRACT,
    reviewId: stableId(raw.reviewId, 'reviewed state.reviewId'),
    operation,
    analysisId,
    planSha256,
    containmentReceiptSha256: requireLowercaseSha256(
      raw.containmentReceiptSha256,
      'reviewed state.containmentReceiptSha256'
    ),
    state,
    adjustedControlIds: stableIds(raw.adjustedControlIds, 'reviewed state.adjustedControlIds'),
    confirmedControlIds: stableIds(raw.confirmedControlIds, 'reviewed state.confirmedControlIds'),
    cleanResetConfirmed: raw.cleanResetConfirmed
  }
}

export const RECIPE_REVIEW_DOCUMENT_CONTRACTS = [
  RECIPE_UPDATE_ANALYSIS_CONTEXT_CONTRACT,
  RECIPE_REVIEWED_STATE_CONTRACT,
  RECIPE_MIGRATION_REPORT_CONTRACT
] as const

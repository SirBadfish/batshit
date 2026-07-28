import { redis } from '$lib/server/redis'
import type { GoonRecord } from '$lib/types/goons'
import {
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  applyRecipeRevisionProjection,
  canonicalRecipeString,
  createGoonRecipeDocument,
  createRecipeRevisionEnvelope,
  parseGoonRecipeV2,
  recipeAuthoringRevisionSha256,
  recipeDocumentRedisKey,
  recipeRevisionBundleSha256,
  recipeRevisionRedisKey,
  verifyGoonRecipeDocument,
  verifyRecipeRevisionEnvelope,
  type GoonRecipeDocument,
  type GoonRecipeV2,
  type RecipeDocumentRef,
  type RecipeRevisionEnvelope
} from '$lib/goons/recipe'
import {
  getGoonRecipeDocument,
  getOwnedRecipeGoon,
  getRecipeRevisionEnvelope
} from './goonRecipeRepository.server'
import {
  verifyCompleteRecipeRevision,
  type RecipeAssetReader
} from './goonRecipeLifecycleService.server'

const ZERO_SHA256 = '0'.repeat(64)

const CREATE_DUPLICATE_RECIPE_GOON_SCRIPT = `
for index = 1, #KEYS - 1 do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    return 'COLLISION'
  end
end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
for index = 2, #KEYS - 1 do
  redis.call('JSON.SET', KEYS[index], '$', ARGV[index])
end
redis.call('SADD', KEYS[#KEYS], ARGV[#ARGV])
return 'CREATED'
`

export class GoonRecipeDuplicationError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message)
    this.name = 'GoonRecipeDuplicationError'
  }
}

function revisionIdFromRef(userId: string, goonId: string, ref: RecipeDocumentRef) {
  const prefix = `goon_recipe_revision:${userId}:${goonId}:`
  if (ref.contract !== GOON_RECIPE_REVISION_ENVELOPE_CONTRACT || !ref.ref.startsWith(prefix)) {
    throw new GoonRecipeDuplicationError('Recipe revision ref is outside its source Goon namespace.')
  }
  return ref.ref.slice(prefix.length)
}

function refForDocument(document: GoonRecipeDocument): RecipeDocumentRef {
  return {
    contract: document.documentContract,
    ref: recipeDocumentRedisKey(document.userId, document.goonId, document.sha256),
    sha256: document.sha256
  }
}

function refForEnvelope(userId: string, goonId: string, envelope: RecipeRevisionEnvelope): RecipeDocumentRef {
  return {
    contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    ref: recipeRevisionRedisKey(userId, goonId, envelope.revision.revisionId),
    sha256: envelope.envelopeSha256
  }
}

async function copyDocument(input: {
  sourceUserId: string
  sourceGoonId: string
  targetUserId: string
  targetGoonId: string
  ref: RecipeDocumentRef
  records: Map<string, unknown>
  refs: Map<string, RecipeDocumentRef>
}) {
  const cached = input.refs.get(input.ref.ref)
  if (cached) return cached
  const source = await getGoonRecipeDocument(input.sourceUserId, input.sourceGoonId, input.ref.sha256)
  if (
    source.documentContract !== input.ref.contract ||
    input.ref.ref !== recipeDocumentRedisKey(input.sourceUserId, input.sourceGoonId, input.ref.sha256)
  ) {
    throw new GoonRecipeDuplicationError('Recipe document ref does not match its immutable source record.')
  }
  const copied = await createGoonRecipeDocument({
    userId: input.targetUserId,
    goonId: input.targetGoonId,
    content: source.content
  })
  await verifyGoonRecipeDocument(copied)
  const key = recipeDocumentRedisKey(input.targetUserId, input.targetGoonId, copied.sha256)
  input.records.set(key, copied)
  const ref = refForDocument(copied)
  input.refs.set(input.ref.ref, ref)
  return ref
}

async function copyEnvelope(input: {
  sourceUserId: string
  sourceGoonId: string
  targetUserId: string
  targetGoonId: string
  ref: RecipeDocumentRef
  records: Map<string, unknown>
  refs: Map<string, RecipeDocumentRef>
}) {
  const source = await getRecipeRevisionEnvelope(
    input.sourceUserId,
    input.sourceGoonId,
    revisionIdFromRef(input.sourceUserId, input.sourceGoonId, input.ref)
  )
  if (source.envelopeSha256 !== input.ref.sha256) {
    throw new GoonRecipeDuplicationError('Recipe revision ref hash does not match its immutable source record.')
  }
  const [sourceContainmentReceipt, liveBuildReceipt, updateReport] = await Promise.all([
    copyDocument({ ...input, ref: source.sourceContainmentReceipt }),
    copyDocument({ ...input, ref: source.revision.liveBuildReceipt }),
    source.revision.updateReport
      ? copyDocument({ ...input, ref: source.revision.updateReport })
      : Promise.resolve(null)
  ])
  const revisionId = `duplicate_${input.targetGoonId}_${source.revision.recipeRevision}_${source.envelopeSha256.slice(0, 16)}`
  const revision = {
    ...source.revision,
    revisionId,
    revisionSha256: ZERO_SHA256,
    liveBuildReceipt,
    updateReport
  }
  revision.revisionSha256 = await recipeRevisionBundleSha256(revision)
  const envelope = await createRecipeRevisionEnvelope({
    contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    revision,
    sourceContainmentReceipt,
    live: source.live
  })
  await verifyRecipeRevisionEnvelope(envelope)
  input.records.set(
    recipeRevisionRedisKey(input.targetUserId, input.targetGoonId, revisionId),
    envelope
  )
  return { envelope, ref: refForEnvelope(input.targetUserId, input.targetGoonId, envelope) }
}

async function authoringFromEnvelope(envelope: RecipeRevisionEnvelope) {
  const authoring = {
    contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
    recipeRevision: envelope.revision.recipeRevision,
    revisionId: envelope.revision.revisionId,
    revisionSha256: ZERO_SHA256,
    source: envelope.revision.source,
    state: envelope.revision.state,
    updateReport: envelope.revision.updateReport
  }
  authoring.revisionSha256 = await recipeAuthoringRevisionSha256(authoring)
  return authoring
}

function fileRef(asset: RecipeRevisionEnvelope['live']['package']) {
  const filename = asset.ref.split('/').pop()
  if (!filename) throw new GoonRecipeDuplicationError(`Recipe asset ${asset.ref} has no filename.`)
  return { url: asset.ref, filename, size: asset.bytes }
}

function applyActiveRevision(clone: GoonRecord, envelope: RecipeRevisionEnvelope) {
  applyRecipeRevisionProjection(clone, envelope, (asset) => fileRef(asset))
}

export async function duplicateRecipeGoon(input: {
  userId: string
  sourceGoonId: string
  targetGoonId: string
  name: string
  now: string
}, dependencies: { readAsset?: RecipeAssetReader } = {}) {
  const sourceGoon = await getOwnedRecipeGoon(input.userId, input.sourceGoonId)
  const sourceOwner = parseGoonRecipeV2(sourceGoon.recipe)
  if (!sourceOwner.activeRevision) {
    throw new GoonRecipeDuplicationError(
      'A durable Recipe Goon must have a complete active revision before duplication.',
      409
    )
  }
  await verifyCompleteRecipeRevision(
    input.userId,
    input.sourceGoonId,
    sourceOwner.activeRevision,
    dependencies.readAsset
  )
  if (sourceOwner.previousRevision) {
    await verifyCompleteRecipeRevision(
      input.userId,
      input.sourceGoonId,
      sourceOwner.previousRevision,
      dependencies.readAsset
    )
  }
  const records = new Map<string, unknown>()
  const refs = new Map<string, RecipeDocumentRef>()
  const active = await copyEnvelope({
    sourceUserId: input.userId,
    sourceGoonId: input.sourceGoonId,
    targetUserId: input.userId,
    targetGoonId: input.targetGoonId,
    ref: sourceOwner.activeRevision,
    records,
    refs
  })
  const previous = sourceOwner.previousRevision
    ? await copyEnvelope({
        sourceUserId: input.userId,
        sourceGoonId: input.sourceGoonId,
        targetUserId: input.userId,
        targetGoonId: input.targetGoonId,
        ref: sourceOwner.previousRevision,
        records,
        refs
      })
    : null
  const authoringRevision = await authoringFromEnvelope(active.envelope)
  const recipe: GoonRecipeV2 = {
    ...sourceOwner,
    writeVersion: 1,
    nextRecipeRevision: Math.max(sourceOwner.nextRecipeRevision, authoringRevision.recipeRevision + 1),
    liveStatus: 'up_to_date',
    authoringRevision,
    authoringSourceContainmentReceipt: active.envelope.sourceContainmentReceipt,
    activeRevision: active.ref,
    previousRevision: previous?.ref ?? null,
    pendingAnalysis: null,
    pendingJob: null,
    latestUpdateReport: active.envelope.revision.updateReport,
    lastFailure: null,
    maintenanceFailure: null
  }
  parseGoonRecipeV2(recipe)
  const clone = structuredClone(sourceGoon)
  clone.id = input.targetGoonId
  clone.user_id = input.userId
  clone.name = input.name
  clone.created_at = input.now
  clone.updated_at = input.now
  clone.recipe = recipe
  applyActiveRevision(clone, active.envelope)
  clone.vrmUpdate = null
  if (clone.files) delete clone.files.vrmPending
  canonicalRecipeString(clone)
  const recordEntries = [...records.entries()].sort(([left], [right]) => left.localeCompare(right))
  const keys = [
    `goon:${input.targetGoonId}`,
    ...recordEntries.map(([key]) => key),
    `user:${input.userId}:goons`
  ]
  const arguments_ = [
    JSON.stringify(clone),
    ...recordEntries.map(([, value]) => JSON.stringify(value)),
    input.targetGoonId
  ]
  const result = await redis.execute((client: any) => {
    if (typeof client.eval !== 'function') {
      throw new GoonRecipeDuplicationError('Redis EVAL is unavailable; Recipe duplication cannot be atomic.')
    }
    return client.eval(CREATE_DUPLICATE_RECIPE_GOON_SCRIPT, { keys, arguments: arguments_ })
  })
  if (result !== 'CREATED') {
    throw new GoonRecipeDuplicationError('The duplicate Goon id or Recipe lineage already exists.', 409)
  }
  return clone
}

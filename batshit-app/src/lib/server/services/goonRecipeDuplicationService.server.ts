import { redis } from '$lib/server/redis'
import { WatchError, type RedisClientType } from 'redis'
import {
  collectGoonGuardedReferences,
  CUSTOM_GOON_UPLOAD_GUARD_LUA
} from './goonCustomAssetOwnership.server'
import type { GoonRecord } from '$lib/types/goons'
import { captureRecipeVerificationEpoch, isRecipeVerificationEpochCurrent, publishInRecipeVerificationEpoch } from './recipeVerificationEpoch.server'
import { readOwnedGoonRawForClient } from './goonMutationRepository.server'
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
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if redis.call('JSON.GET', ARGV[#ARGV - 1]) ~= ARGV[#ARGV - 2] then return 'ASSET_UNAVAILABLE' end
local indexType = redis.call('TYPE', KEYS[#KEYS]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'COLLISION' end
for index = 1, #KEYS - 1 do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    return 'COLLISION'
  end
end
if indexType == 'set' and redis.call('SISMEMBER', KEYS[#KEYS], ARGV[#ARGV - 3]) == 1 then return 'COLLISION' end
if not customGoonUploadsAvailable(ARGV[#ARGV]) then
  return 'ASSET_UNAVAILABLE'
end
local function ok(value) return not (type(value) == 'table' and value.err) end
local function rollback()
  local complete = true
  for index = 1, #KEYS - 1 do
    if not ok(redis.pcall('DEL', KEYS[index])) then complete = false end
  end
  if not ok(redis.pcall('SREM', KEYS[#KEYS], ARGV[#ARGV - 3])) then complete = false end
  if complete then return 'NOT_WRITTEN' end
  return 'UNKNOWN'
end
for index = 1, #KEYS - 1 do
  local written = redis.pcall('JSON.SET', KEYS[index], '$', ARGV[index])
  if not ok(written) then return rollback() end
end
if not ok(redis.pcall('SADD', KEYS[#KEYS], ARGV[#ARGV - 3])) then return rollback() end
return 'CREATED'
`

const OBSERVE_DUPLICATE_RECIPE_GOON_SCRIPT = `
if redis.call('EXISTS','goon_asset_restore') ~= 0 or redis.call('TYPE',KEYS[#KEYS]).ok ~= 'set' or
   redis.call('SISMEMBER',KEYS[#KEYS],ARGV[1]) ~= 1 then return {'NOT_OBSERVED'} end
local result, total = {'OBSERVED'}, 0
for index = 1, #KEYS - 1 do
  if redis.call('TYPE',KEYS[index]).ok ~= 'ReJSON-RL' then return {'NOT_OBSERVED'} end
  local raw = redis.call('JSON.GET',KEYS[index])
  total = total + #raw
  if #raw > 4 * 1024 * 1024 or total > 16 * 1024 * 1024 then return {'NOT_OBSERVED'} end
  table.insert(result, raw)
end
return result
`

export class GoonRecipeDuplicationError extends Error {
  constructor(message: string, readonly status = 500, readonly outcome?: 'not_written' | 'unknown',
    readonly recovery?: { goonId: string }) {
    super(message)
    this.name = 'GoonRecipeDuplicationError'
  }
}

/** node-redis command timeouts stop applying after dispatch. Closing this
 * dedicated, non-reconnecting socket rejects and settles even an issued
 * command; only its caller decides whether the outcome remains unknown. */
async function boundedOwnedCommand<T>(watcher: RedisClientType, pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = Symbol('owned-command-timeout')
  try {
    const result = await Promise.race([pending, new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), milliseconds) })])
    if (result === timeout) {
      if (watcher.isOpen) watcher.destroy()
      await pending.catch(() => undefined)
      throw new Error('The duplicate database command did not settle before its deadline.')
    }
    return result as T
  } finally { clearTimeout(timer) }
}

/** A lost issued EXEC is success only when one atomic observation contains
 * the exact planned target, all new Recipe rows and its user index member. */
async function observeDuplicate(watcher: RedisClientType, keys: string[], expected: readonly unknown[], targetGoonId: string, epoch: symbol | null) {
  if (!watcher.isOpen || expected.length > 512 || expected.length !== keys.length - 1 || !isRecipeVerificationEpochCurrent(epoch)) return false
  const expectedCanonical = expected.map(value => canonicalRecipeString(value))
  if (expectedCanonical.reduce((n, value) => n + Buffer.byteLength(value, 'utf8'), 0) > 16 * 1024 * 1024) return false
  const result: unknown = await boundedOwnedCommand(watcher,
    watcher.eval(OBSERVE_DUPLICATE_RECIPE_GOON_SCRIPT, { keys, arguments: [targetGoonId] }), 2000)
  if (!isRecipeVerificationEpochCurrent(epoch) || !Array.isArray(result) || result[0] !== 'OBSERVED' || result.length !== expected.length + 1) return false
  try {
    return expectedCanonical.every((value, index) => {
      const raw = result[index + 1]
      return typeof raw === 'string' && canonicalRecipeString(JSON.parse(raw)) === value
    })
  } catch { return false }
}

/** WATCH is connection-scoped. A fresh client preserves the configured auth,
 * TLS and actual selected database while refusing offline queue/reconnect. */
async function openDuplicateWatcher(): Promise<{ watcher: RedisClientType; database: number }> {
  return redis.execute(async shared => {
    const info = await shared.clientInfo()
    if (!Number.isSafeInteger(info.db) || info.db < 0) throw new GoonRecipeDuplicationError('The Goon database could not be verified.', 503, 'not_written')
    return { database: info.db, watcher: shared.duplicate({ database: info.db, disableOfflineQueue: true,
      socket: { ...shared.options.socket, reconnectStrategy: false } }) as RedisClientType }
  })
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
  // The shared immutable Live assets and build receipt bind this revision id.
  // Ownership is already isolated by user + Goon in every revision/document key.
  const revisionId = source.revision.revisionId
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
  const epoch = captureRecipeVerificationEpoch()
  if (!epoch) throw new GoonRecipeDuplicationError('Wait for backup restore before duplicating this Goon.', 503, 'not_written')
  let watcher: RedisClientType | undefined
  try {
    const opened = await openDuplicateWatcher()
    watcher = opened.watcher
    watcher.on('error', () => {})
    await watcher.connect()
    await watcher.select(opened.database)
    if ((await watcher.clientInfo()).db !== opened.database) throw new GoonRecipeDuplicationError('The Goon database could not be verified.', 503, 'not_written')
    await watcher.watch('goon_asset_restore')
    if (!isRecipeVerificationEpochCurrent(epoch) || await watcher.exists('goon_asset_restore') !== 0 || !isRecipeVerificationEpochCurrent(epoch)) {
      throw new GoonRecipeDuplicationError('Restore changed the Goon context before duplication. Reload and retry.', 409, 'not_written')
    }
    return await duplicateRecipeGoonWatched(input, dependencies, epoch, watcher)
  } finally {
    if (watcher?.isOpen) watcher.destroy()
  }
}

async function duplicateRecipeGoonWatched(input: {
  userId: string; sourceGoonId: string; targetGoonId: string; name: string; now: string
}, dependencies: { readAsset?: RecipeAssetReader }, epoch: symbol, watcher: RedisClientType) {
  const sourceGoon = await getOwnedRecipeGoon(input.userId, input.sourceGoonId)
  if (['anatomyPresence', 'clothingState', 'clothingCloset', 'sphericalEyelid'].some(field => Object.hasOwn(sourceGoon, field))) {
    throw new GoonRecipeDuplicationError('This Goon has fields this release does not support. Its records were preserved.', 409, 'not_written')
  }
  const observed = await redis.execute(client => readOwnedGoonRawForClient(client, input.userId, input.sourceGoonId))
  if (canonicalRecipeString(sourceGoon) !== canonicalRecipeString(observed.goon)) {
    throw new GoonRecipeDuplicationError('The source Goon changed before duplication. Reload before retrying.', 409, 'not_written')
  }
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
    input.targetGoonId,
    observed.raw,
    observed.key,
    JSON.stringify(await collectGoonGuardedReferences([clone, ...recordEntries.map(([, value]) => value)], input.userId))
  ]
  let dispatched = false, result: unknown
  try {
    const replies = await publishInRecipeVerificationEpoch(epoch, () => {
      if (!isRecipeVerificationEpochCurrent(epoch)) throw new GoonRecipeDuplicationError('Restore changed the Goon context before duplication. Reload and retry.', 409, 'not_written')
      dispatched = true
      return boundedOwnedCommand(watcher, watcher.multi().eval(CREATE_DUPLICATE_RECIPE_GOON_SCRIPT, { keys, arguments: arguments_ }).exec(), 10_000)
    })
    if (!Array.isArray(replies) || replies.length !== 1 || typeof replies[0] !== 'string') throw Error('Unexpected duplicate transaction result.')
    result = replies[0]
  } catch (error) {
    if (!dispatched) throw error
    if (error instanceof WatchError) throw new GoonRecipeDuplicationError('Restore changed the Goon context before duplication. Reload and retry.', 409, 'not_written')
    if (await observeDuplicate(watcher, keys, [clone, ...recordEntries.map(([, value]) => value)], input.targetGoonId, epoch).catch(() => false)) return clone
    throw new GoonRecipeDuplicationError('Duplication could not be confirmed. Do not retry until its outcome is recovered.', 503,
      'unknown', { goonId: input.targetGoonId })
  }
  if (result !== 'CREATED') {
    if (result === 'UNKNOWN') {
      if (await observeDuplicate(watcher, keys, [clone, ...recordEntries.map(([, value]) => value)], input.targetGoonId, epoch).catch(() => false)) return clone
      throw new GoonRecipeDuplicationError('Duplication could not be confirmed. Do not retry until its outcome is recovered.', 503,
        'unknown', { goonId: input.targetGoonId })
    }
    if (result === 'NOT_WRITTEN') throw new GoonRecipeDuplicationError('The duplicate could not be created; its partial records were removed.', 503, 'not_written')
    if (result === 'ASSET_UNAVAILABLE') {
      throw new GoonRecipeDuplicationError(
        'A custom Goon asset is unavailable or being deleted. Reload before retrying.',
        409
      )
    }
    throw new GoonRecipeDuplicationError('The duplicate Goon id or Recipe lineage already exists.', 409)
  }
  return clone
}

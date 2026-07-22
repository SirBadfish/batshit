import { redis } from '$lib/server/redis'
import type { GoonRecord } from '$lib/types/goons'
import {
  GOON_RECIPE_OWNER_V2_CONTRACT,
  canonicalRecipeString,
  parseGoonRecipeJob,
  parseGoonRecipeV2,
  recipeDocumentRedisKey,
  recipeJobRedisKey,
  recipeRevisionRedisKey,
  verifyGoonRecipeDocument,
  verifyRecipeRevisionEnvelope,
  type GoonRecipeDocument,
  type GoonRecipeJob,
  type RecipeRevisionEnvelope
} from '$lib/goons/recipe'

export type RecipeRepositoryErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'RECIPE_NOT_INITIALIZED'
  | 'RECIPE_ALREADY_INITIALIZED'
  | 'WRITE_CONFLICT'
  | 'CORRUPT_RECORD'

export class RecipeRepositoryError extends Error {
  code: RecipeRepositoryErrorCode
  status: number

  constructor(code: RecipeRepositoryErrorCode, message: string, status: number) {
    super(message)
    this.name = 'RecipeRepositoryError'
    this.code = code
    this.status = status
  }
}

const RECIPE_MANAGED_GOON_FIELDS = [
  'recipe',
  'customAvatar',
  'appearanceDials',
  'facialArtwork',
  'eyeAppearance',
  'oralAppearance',
  'recipeFitReceipts'
] as const

export type RecipeBootstrapManagedSnapshot = Partial<
  Pick<GoonRecord, (typeof RECIPE_MANAGED_GOON_FIELDS)[number]>
>

export function createRecipeBootstrapManagedSnapshot(
  goon: GoonRecord
): RecipeBootstrapManagedSnapshot {
  const source = goon as unknown as Record<string, unknown>
  return Object.fromEntries(
    RECIPE_MANAGED_GOON_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(source, field))
      .map((field) => [field, source[field]])
  ) as RecipeBootstrapManagedSnapshot
}

const RECIPE_COMPARE_AND_SWAP_SCRIPT = `
local raw = redis.call('JSON.GET', KEYS[1])
if not raw then
  return 'NOT_FOUND'
end
local current = cjson.decode(raw)
if current['user_id'] ~= ARGV[1] then
  return 'FORBIDDEN'
end
local recipe = current['recipe']
if not recipe or recipe['contract'] ~= '${GOON_RECIPE_OWNER_V2_CONTRACT}' then
  return 'RECIPE_NOT_INITIALIZED'
end
if tonumber(recipe['writeVersion']) ~= tonumber(ARGV[2]) then
  return 'WRITE_CONFLICT'
end
for index = 2, #KEYS do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    return 'IMMUTABLE_COLLISION'
  end
end
local managedFields = {
  'recipe',
  'customAvatar',
  'appearanceDials',
  'facialArtwork',
  'eyeAppearance',
  'oralAppearance',
  'recipeFitReceipts'
}
for index, field in ipairs(managedFields) do
  local value = ARGV[index + 2]
  local path = '$.' .. field
  if value == '__BATSHIT_DELETE__' then
    redis.call('JSON.DEL', KEYS[1], path)
  else
    redis.call('JSON.SET', KEYS[1], path, value)
  end
end
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[10])
for index = 2, #KEYS do
  redis.call('JSON.SET', KEYS[index], '$', ARGV[index + 9])
end
return redis.call('JSON.GET', KEYS[1])
`

const RECIPE_BOOTSTRAP_SCRIPT = `
local function deepEqual(left, right)
  if left == cjson.null or right == cjson.null then
    return left == cjson.null and right == cjson.null
  end
  if type(left) ~= type(right) then
    return false
  end
  if type(left) ~= 'table' then
    return left == right
  end
  for key, value in pairs(left) do
    if not deepEqual(value, right[key]) then
      return false
    end
  end
  for key, _ in pairs(right) do
    if left[key] == nil then
      return false
    end
  end
  return true
end

local raw = redis.call('JSON.GET', KEYS[1])
if not raw then
  return 'NOT_FOUND'
end
local current = cjson.decode(raw)
if current['user_id'] ~= ARGV[1] then
  return 'FORBIDDEN'
end
if current['recipe'] and current['recipe'] ~= cjson.null then
  return 'RECIPE_ALREADY_INITIALIZED'
end
local managedFields = {
  'recipe',
  'customAvatar',
  'appearanceDials',
  'facialArtwork',
  'eyeAppearance',
  'oralAppearance',
  'recipeFitReceipts'
}
local currentManaged = {}
for _, field in ipairs(managedFields) do
  if current[field] ~= nil then
    currentManaged[field] = current[field]
  end
end
local expectedManaged = cjson.decode(ARGV[2])
if not deepEqual(currentManaged, expectedManaged) then
  return 'WRITE_CONFLICT'
end
for index = 2, #KEYS do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    return 'IMMUTABLE_COLLISION'
  end
end
redis.call('JSON.SET', KEYS[1], '$.recipe', ARGV[3])
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[4])
for index = 2, #KEYS do
  redis.call('JSON.SET', KEYS[index], '$', ARGV[index + 3])
end
return redis.call('JSON.GET', KEYS[1])
`

const RECIPE_IMMUTABLE_PUT_SCRIPT = `
local current = redis.call('JSON.GET', KEYS[1])
if current then
  return current
end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
return 'INSERTED'
`

const RECIPE_JOB_COMPARE_AND_SWAP_SCRIPT = `
local raw = redis.call('JSON.GET', KEYS[1])
if not raw then
  return 'NOT_FOUND'
end
local current = cjson.decode(raw)
if current['user_id'] ~= ARGV[1] then
  return 'FORBIDDEN'
end
local recipe = current['recipe']
if not recipe or recipe['contract'] ~= '${GOON_RECIPE_OWNER_V2_CONTRACT}' then
  return 'RECIPE_NOT_INITIALIZED'
end
if tonumber(recipe['writeVersion']) ~= tonumber(ARGV[2]) then
  return 'WRITE_CONFLICT'
end
local expectedJobVersion = tonumber(ARGV[3])
local currentJobRaw = redis.call('JSON.GET', KEYS[2])
if expectedJobVersion == 0 then
  if currentJobRaw then
    return 'JOB_WRITE_CONFLICT'
  end
else
  if not currentJobRaw then
    return 'JOB_WRITE_CONFLICT'
  end
  local currentJob = cjson.decode(currentJobRaw)
  if currentJob['userId'] ~= ARGV[1] or currentJob['goonId'] ~= ARGV[4] or currentJob['jobId'] ~= ARGV[5] then
    return 'JOB_CORRUPT'
  end
  if tonumber(currentJob['stateVersion']) ~= expectedJobVersion then
    return 'JOB_WRITE_CONFLICT'
  end
  local pending = recipe['pendingJob']
  if not pending or pending['jobId'] ~= ARGV[5] then
    return 'JOB_WRITE_CONFLICT'
  end
end
for index = 3, #KEYS do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    return 'IMMUTABLE_COLLISION'
  end
end
local managedFields = {
  'recipe',
  'customAvatar',
  'appearanceDials',
  'facialArtwork',
  'eyeAppearance',
  'oralAppearance',
  'recipeFitReceipts'
}
for index, field in ipairs(managedFields) do
  local value = ARGV[index + 5]
  local path = '$.' .. field
  if value == '__BATSHIT_DELETE__' then
    redis.call('JSON.DEL', KEYS[1], path)
  else
    redis.call('JSON.SET', KEYS[1], path, value)
  end
end
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[13])
redis.call('JSON.SET', KEYS[2], '$', ARGV[14])
for index = 3, #KEYS do
  redis.call('JSON.SET', KEYS[index], '$', ARGV[index + 12])
end
return redis.call('JSON.GET', KEYS[1])
`

const RECIPE_ANALYSIS_DISCARD_SCRIPT = `
local raw = redis.call('JSON.GET', KEYS[1])
if not raw then
  return 'NOT_FOUND'
end
local current = cjson.decode(raw)
if current['user_id'] ~= ARGV[1] then
  return 'FORBIDDEN'
end
local recipe = current['recipe']
if not recipe or recipe['contract'] ~= '${GOON_RECIPE_OWNER_V2_CONTRACT}' then
  return 'RECIPE_NOT_INITIALIZED'
end
local pendingJob = recipe['pendingJob']
if tonumber(recipe['writeVersion']) ~= tonumber(ARGV[2]) or
   (pendingJob and pendingJob ~= cjson.null) then
  return 'WRITE_CONFLICT'
end
local pendingAnalysis = recipe['pendingAnalysis']
if not pendingAnalysis or pendingAnalysis == cjson.null or pendingAnalysis['analysisId'] ~= ARGV[3] then
  return 'ANALYSIS_WRITE_CONFLICT'
end
redis.call('JSON.SET', KEYS[1], '$.recipe', ARGV[4])
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[5])
if #KEYS > 1 then
  local deleteKeys = {}
  for index = 2, #KEYS do
    deleteKeys[#deleteKeys + 1] = KEYS[index]
  end
  redis.call('DEL', unpack(deleteKeys))
end
return redis.call('JSON.GET', KEYS[1])
`

function goonKey(goonId: string) {
  return `goon:${goonId}`
}

function statusForCode(code: RecipeRepositoryErrorCode) {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'WRITE_CONFLICT') return 409
  if (code === 'RECIPE_NOT_INITIALIZED') return 409
  if (code === 'RECIPE_ALREADY_INITIALIZED') return 409
  return 500
}

function throwCasFailure(code: string): never {
  if (code === 'IMMUTABLE_COLLISION') {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'A Recipe transaction attempted to replace an immutable revision or document.',
      500
    )
  }
  if (code === 'JOB_WRITE_CONFLICT') {
    throw new RecipeRepositoryError(
      'WRITE_CONFLICT',
      'The Recipe job changed while this operation was in progress. Reload it before retrying.',
      409
    )
  }
  if (code === 'ANALYSIS_WRITE_CONFLICT') {
    throw new RecipeRepositoryError(
      'WRITE_CONFLICT',
      'The pending Recipe analysis changed. Reload it before continuing.',
      409
    )
  }
  if (code === 'JOB_CORRUPT') {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'The pending Recipe job does not match its immutable owner identity.',
      500
    )
  }
  const known = [
    'NOT_FOUND',
    'FORBIDDEN',
    'RECIPE_NOT_INITIALIZED',
    'RECIPE_ALREADY_INITIALIZED',
    'WRITE_CONFLICT'
  ] as const
  if (!known.includes(code as (typeof known)[number])) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      `Recipe persistence returned an unsupported transaction result: ${code}`,
      500
    )
  }
  const typed = code as (typeof known)[number]
  const messages: Record<(typeof known)[number], string> = {
    NOT_FOUND: 'Goon not found.',
    FORBIDDEN: 'The Goon belongs to another user.',
    RECIPE_NOT_INITIALIZED: 'This Goon does not have a durable Recipe owner yet.',
    RECIPE_ALREADY_INITIALIZED: 'This Goon already has a durable Recipe owner.',
    WRITE_CONFLICT: 'The Recipe changed while this operation was in progress. Analyze it again.'
  }
  throw new RecipeRepositoryError(typed, messages[typed], statusForCode(typed))
}

function assertGoonIdentity(goon: GoonRecord, userId: string, goonId: string) {
  if (goon.id !== goonId || goon.user_id !== userId) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'Recipe persistence received a Goon with mismatched ownership.',
      500
    )
  }
}

export async function getOwnedRecipeGoon(
  userId: string,
  goonId: string
): Promise<GoonRecord> {
  const goon = await redis.execute(async (client) =>
    client.json.get(goonKey(goonId)) as Promise<GoonRecord | null>
  )
  if (!goon) {
    throw new RecipeRepositoryError('NOT_FOUND', 'Goon not found.', 404)
  }
  if (goon.user_id !== userId) {
    throw new RecipeRepositoryError('FORBIDDEN', 'The Goon belongs to another user.', 403)
  }
  if (!goon.recipe || goon.recipe.contract !== GOON_RECIPE_OWNER_V2_CONTRACT) {
    throw new RecipeRepositoryError(
      'RECIPE_NOT_INITIALIZED',
      'This Goon does not have a durable Recipe owner yet.',
      409
    )
  }
  parseGoonRecipeV2(goon.recipe)
  return goon
}

export async function getOwnedGoonForRecipeBootstrap(
  userId: string,
  goonId: string
): Promise<GoonRecord> {
  const goon = await redis.execute(async (client) =>
    client.json.get(goonKey(goonId)) as Promise<GoonRecord | null>
  )
  if (!goon) throw new RecipeRepositoryError('NOT_FOUND', 'Goon not found.', 404)
  if (goon.user_id !== userId) {
    throw new RecipeRepositoryError('FORBIDDEN', 'The Goon belongs to another user.', 403)
  }
  if (goon.recipe) {
    throw new RecipeRepositoryError(
      'RECIPE_ALREADY_INITIALIZED',
      'This Goon already has a durable Recipe owner.',
      409
    )
  }
  return goon
}

async function putImmutableJsonRecord(key: string, value: unknown) {
  canonicalRecipeString(value)
  await redis.execute(async (client: any) => {
    if (typeof client.eval === 'function') {
      const result = await client.eval(RECIPE_IMMUTABLE_PUT_SCRIPT, {
        keys: [key],
        arguments: [JSON.stringify(value)]
      })
      if (result === 'INSERTED') return
      const existing = JSON.parse(String(result))
      if (canonicalRecipeString(existing) !== canonicalRecipeString(value)) {
        throw new RecipeRepositoryError(
          'CORRUPT_RECORD',
          `Immutable Recipe record collision at ${key}.`,
          500
        )
      }
      return
    }
    if (process.env.VITEST !== 'true' || process.env.VITEST_USE_REAL_REDIS === 'true') {
      throw new RecipeRepositoryError(
        'CORRUPT_RECORD',
        'Redis EVAL is unavailable; immutable Recipe storage cannot proceed safely.',
        500
      )
    }
    const existing = await client.json.get(key)
    if (existing !== null) {
      if (canonicalRecipeString(existing) !== canonicalRecipeString(value)) {
        throw new RecipeRepositoryError(
          'CORRUPT_RECORD',
          `Immutable Recipe record collision at ${key}.`,
          500
        )
      }
      return
    }
    await client.json.set(key, '$', value as any)
  })
}

export async function putGoonRecipeDocument(documentValue: unknown) {
  const document = await verifyGoonRecipeDocument(documentValue)
  const key = recipeDocumentRedisKey(document.userId, document.goonId, document.sha256)
  await putImmutableJsonRecord(key, document)
  return { key, document }
}

export async function getGoonRecipeDocument(
  userId: string,
  goonId: string,
  sha256: string
): Promise<GoonRecipeDocument> {
  const key = recipeDocumentRedisKey(userId, goonId, sha256)
  const value = await redis.execute(async (client) => client.json.get(key))
  if (value === null) {
    throw new RecipeRepositoryError('NOT_FOUND', `Recipe document ${sha256} is missing.`, 404)
  }
  const document = await verifyGoonRecipeDocument(value)
  if (document.userId !== userId || document.goonId !== goonId) {
    throw new RecipeRepositoryError('CORRUPT_RECORD', 'Recipe document ownership is corrupt.', 500)
  }
  return document
}

export async function putRecipeRevisionEnvelope(
  userId: string,
  goonId: string,
  envelopeValue: unknown
) {
  const envelope = await verifyRecipeRevisionEnvelope(envelopeValue)
  const key = recipeRevisionRedisKey(userId, goonId, envelope.revision.revisionId)
  await putImmutableJsonRecord(key, envelope)
  return { key, envelope }
}

export async function getRecipeRevisionEnvelope(
  userId: string,
  goonId: string,
  revisionId: string
): Promise<RecipeRevisionEnvelope> {
  const key = recipeRevisionRedisKey(userId, goonId, revisionId)
  const value = await redis.execute(async (client) => client.json.get(key))
  if (value === null) {
    throw new RecipeRepositoryError(
      'NOT_FOUND',
      `Recipe revision ${revisionId} is missing.`,
      404
    )
  }
  return verifyRecipeRevisionEnvelope(value)
}

export async function putGoonRecipeJob(jobValue: unknown) {
  const job = parseGoonRecipeJob(jobValue)
  const key = recipeJobRedisKey(job.userId, job.goonId, job.jobId)
  await redis.execute(async (client) => client.json.set(key, '$', job as any))
  return { key, job }
}

export async function getGoonRecipeJob(
  userId: string,
  goonId: string,
  jobId: string
): Promise<GoonRecipeJob> {
  const key = recipeJobRedisKey(userId, goonId, jobId)
  const value = await redis.execute(async (client) => client.json.get(key))
  if (value === null) {
    throw new RecipeRepositoryError('NOT_FOUND', `Recipe job ${jobId} is missing.`, 404)
  }
  const job = parseGoonRecipeJob(value)
  if (job.userId !== userId || job.goonId !== goonId) {
    throw new RecipeRepositoryError('CORRUPT_RECORD', 'Recipe job ownership is corrupt.', 500)
  }
  return job
}

export async function compareAndSwapRecipeState(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
  nextGoon: GoonRecord
  records?: Array<{ key: string; value: unknown }>
}): Promise<GoonRecord> {
  assertGoonIdentity(input.nextGoon, input.userId, input.goonId)
  const nextOwner = parseGoonRecipeV2(input.nextGoon.recipe)
  if (nextOwner.writeVersion !== input.expectedWriteVersion + 1) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'A Recipe compare-and-swap must advance writeVersion by exactly one.',
      500
    )
  }
  const records = input.records ?? []
  for (const record of records) canonicalRecipeString(record.value)
  const keys = [goonKey(input.goonId), ...records.map((record) => record.key)]
  const nextFields = input.nextGoon as unknown as Record<string, unknown>
  const managedFields = [
    'recipe',
    'customAvatar',
    'appearanceDials',
    'facialArtwork',
    'eyeAppearance',
    'oralAppearance',
    'recipeFitReceipts'
  ] as const
  const args = [
    input.userId,
    String(input.expectedWriteVersion),
    ...managedFields.map((field) =>
      Object.prototype.hasOwnProperty.call(nextFields, field)
        ? (JSON.stringify(nextFields[field]) ?? '__BATSHIT_DELETE__')
        : '__BATSHIT_DELETE__'
    ),
    JSON.stringify(input.nextGoon.updated_at),
    ...records.map((record) => JSON.stringify(record.value))
  ]

  const result = await redis.execute(async (client: any) => {
    if (typeof client.eval !== 'function') {
      if (process.env.VITEST === 'true' && process.env.VITEST_USE_REAL_REDIS !== 'true') {
        throw new RecipeRepositoryError(
          'CORRUPT_RECORD',
          'Recipe CAS requires the real-Redis test lane.',
          500
        )
      }
      throw new RecipeRepositoryError(
        'CORRUPT_RECORD',
        'Redis EVAL is unavailable; Recipe writes cannot proceed safely.',
        500
      )
    }
    return client.eval(RECIPE_COMPARE_AND_SWAP_SCRIPT, {
      keys,
      arguments: args
    })
  })
  const serialized = String(result)
  if (!serialized.startsWith('{')) throwCasFailure(serialized)
  const stored = JSON.parse(serialized) as GoonRecord
  assertGoonIdentity(stored, input.userId, input.goonId)
  parseGoonRecipeV2(stored.recipe)
  return stored
}

export async function initializeRecipeState(input: {
  userId: string
  goonId: string
  expectedManagedState: RecipeBootstrapManagedSnapshot
  nextGoon: GoonRecord
  records: Array<{ key: string; value: unknown }>
}): Promise<GoonRecord> {
  assertGoonIdentity(input.nextGoon, input.userId, input.goonId)
  const owner = parseGoonRecipeV2(input.nextGoon.recipe)
  if (owner.writeVersion !== 1) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'Recipe bootstrap must create owner writeVersion 1.',
      500
    )
  }
  for (const record of input.records) canonicalRecipeString(record.value)
  canonicalRecipeString(input.expectedManagedState)
  const keys = [goonKey(input.goonId), ...input.records.map((record) => record.key)]
  const result = await redis.execute(async (client: any) => {
    if (typeof client.eval !== 'function') {
      throw new RecipeRepositoryError(
        'CORRUPT_RECORD',
        'Redis EVAL is unavailable; Recipe bootstrap cannot proceed atomically.',
        500
      )
    }
    return client.eval(RECIPE_BOOTSTRAP_SCRIPT, {
      keys,
      arguments: [
        input.userId,
        JSON.stringify(input.expectedManagedState),
        JSON.stringify(owner),
        JSON.stringify(input.nextGoon.updated_at),
        ...input.records.map((record) => JSON.stringify(record.value))
      ]
    })
  })
  const serialized = String(result)
  if (!serialized.startsWith('{')) throwCasFailure(serialized)
  const stored = JSON.parse(serialized) as GoonRecord
  assertGoonIdentity(stored, input.userId, input.goonId)
  parseGoonRecipeV2(stored.recipe)
  return stored
}

export async function compareAndSwapRecipeJobState(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
  expectedJobStateVersion: number | null
  nextGoon: GoonRecord
  nextJob: GoonRecipeJob
  records?: Array<{ key: string; value: unknown }>
}): Promise<GoonRecord> {
  assertGoonIdentity(input.nextGoon, input.userId, input.goonId)
  const nextOwner = parseGoonRecipeV2(input.nextGoon.recipe)
  const nextJob = parseGoonRecipeJob(input.nextJob)
  if (nextJob.userId !== input.userId || nextJob.goonId !== input.goonId) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'A Recipe job compare-and-swap received a mismatched job owner.',
      500
    )
  }
  if (nextOwner.writeVersion !== input.expectedWriteVersion + 1) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'A Recipe job compare-and-swap must advance writeVersion by exactly one.',
      500
    )
  }
  const expectedJobVersion = input.expectedJobStateVersion ?? 0
  if (nextJob.stateVersion !== expectedJobVersion + 1) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'A Recipe job compare-and-swap must advance stateVersion by exactly one.',
      500
    )
  }
  if (nextJob.targetWriteVersion !== nextOwner.writeVersion) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'The pending Recipe job must target the owner version written in the same transaction.',
      500
    )
  }
  const records = input.records ?? []
  for (const record of records) canonicalRecipeString(record.value)
  const jobKey = recipeJobRedisKey(input.userId, input.goonId, nextJob.jobId)
  const keys = [goonKey(input.goonId), jobKey, ...records.map((record) => record.key)]
  const nextFields = input.nextGoon as unknown as Record<string, unknown>
  const managedFields = [
    'recipe',
    'customAvatar',
    'appearanceDials',
    'facialArtwork',
    'eyeAppearance',
    'oralAppearance',
    'recipeFitReceipts'
  ] as const
  const args = [
    input.userId,
    String(input.expectedWriteVersion),
    String(expectedJobVersion),
    input.goonId,
    nextJob.jobId,
    ...managedFields.map((field) =>
      Object.prototype.hasOwnProperty.call(nextFields, field)
        ? (JSON.stringify(nextFields[field]) ?? '__BATSHIT_DELETE__')
        : '__BATSHIT_DELETE__'
    ),
    JSON.stringify(input.nextGoon.updated_at),
    JSON.stringify(nextJob),
    ...records.map((record) => JSON.stringify(record.value))
  ]

  const result = await redis.execute(async (client: any) => {
    if (typeof client.eval !== 'function') {
      throw new RecipeRepositoryError(
        'CORRUPT_RECORD',
        'Redis EVAL is unavailable; Recipe job writes cannot proceed safely.',
        500
      )
    }
    return client.eval(RECIPE_JOB_COMPARE_AND_SWAP_SCRIPT, {
      keys,
      arguments: args
    })
  })
  const serialized = String(result)
  if (!serialized.startsWith('{')) throwCasFailure(serialized)
  const stored = JSON.parse(serialized) as GoonRecord
  assertGoonIdentity(stored, input.userId, input.goonId)
  parseGoonRecipeV2(stored.recipe)
  return stored
}

export async function discardRecipeAnalysisRecords(input: {
  userId: string
  goonId: string
  expectedWriteVersion: number
  analysisId: string
  nextGoon: GoonRecord
  recordRefs: string[]
}): Promise<GoonRecord> {
  assertGoonIdentity(input.nextGoon, input.userId, input.goonId)
  const nextOwner = parseGoonRecipeV2(input.nextGoon.recipe)
  if (nextOwner.writeVersion !== input.expectedWriteVersion + 1 || nextOwner.pendingAnalysis) {
    throw new RecipeRepositoryError(
      'CORRUPT_RECORD',
      'Recipe analysis discard must advance once and clear pending analysis.',
      500
    )
  }
  const recordRefs = [...new Set(input.recordRefs)].sort((left, right) => left.localeCompare(right))
  const result = await redis.execute(async (client: any) => {
    if (typeof client.eval !== 'function') {
      throw new RecipeRepositoryError(
        'CORRUPT_RECORD',
        'Redis EVAL is unavailable; Recipe analysis cannot be discarded safely.',
        500
      )
    }
    return client.eval(RECIPE_ANALYSIS_DISCARD_SCRIPT, {
      keys: [goonKey(input.goonId), ...recordRefs],
      arguments: [
        input.userId,
        String(input.expectedWriteVersion),
        input.analysisId,
        JSON.stringify(nextOwner),
        JSON.stringify(input.nextGoon.updated_at)
      ]
    })
  })
  const serialized = String(result)
  if (!serialized.startsWith('{')) throwCasFailure(serialized)
  const stored = JSON.parse(serialized) as GoonRecord
  assertGoonIdentity(stored, input.userId, input.goonId)
  parseGoonRecipeV2(stored.recipe)
  return stored
}

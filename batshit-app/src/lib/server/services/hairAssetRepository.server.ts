import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import {
  HAIR_ASSET_CONTRACT,
  HAIR_STATE_CONTRACT,
  collectHairAssetFileRefs,
  parseHairRefitSource,
  parseHairState,
  verifyHairAsset,
  type HairAssetFileRefV1,
  type HairRefitSourceV1,
  type HairAssetSelectionV1,
  type HairAssetV1,
  type HairStateV2
} from '$lib/goons/hairAssets'
import {
  listCurrentHairBuiltinAssets,
  migrateHairBuiltinStateToCurrent,
  type HairBuiltinCatalogV2,
  type HairBuiltinStateMigration
} from '$lib/goons/hairBuiltinCatalog'
import { canonicalRecipeString, sha256Hex } from '$lib/goons/recipe/recipeCanonical'
import { redis } from '$lib/server/redis'
import { loadHairBuiltinCatalogMetadata } from './hairBuiltinCatalogMetadata.server'
import { collectCustomGoonUploadKeys, CUSTOM_GOON_UPLOAD_GUARD_LUA } from './goonCustomAssetOwnership.server'
import { collectAllGoonUploadReferencesForClient, hasGoonUploadReference, reserveGoonUploadAsset, releaseGoonUploadReservation, deleteReservedGoonUploadAsset, type GoonAssetReservation } from './goonAssetCleanupService'

import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl
} from './batshitServerUrls'
import {
  hairImportJobIndexKey,
  hairImportJobRedisKey
} from './hairImportJobRepository.server'

const USER_HAIR_ASSET_PREFIX = '/uploads/goon_hair_assets/'
const USER_HAIR_UPLOAD_TYPE = 'goon_hair_assets'

export type HairAssetRepositoryErrorCode =
  | 'NOT_FOUND'
  | 'IMMUTABLE_REVISION_CONFLICT'
  | 'BUILTIN_COLLISION'
  | 'INVALID_OWNED_FILE'
  | 'ATOMIC_REGISTRATION_FAILED'
  | 'ASSET_IN_USE'
  | 'OWNED_FILE_DELETE_FAILED'

export class HairAssetRepositoryError extends Error {
  constructor(
    readonly code: HairAssetRepositoryErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'HairAssetRepositoryError'
  }
}

export type HairAssetDependency = {
  redisKey: string
  assetId: string
  assetRevisionId: string
  usage?: string
  previousVersion?: boolean
}

type RepositoryDependencies = {
  builtinAssets?: readonly HairAssetV1[]
  deleteOwnedFile?: (ref: HairAssetFileRefV1, reservation: GoonAssetReservation) => Promise<void>
  reserveOwnedFile?: (ref: HairAssetFileRefV1) => Promise<GoonAssetReservation>
  releaseOwnedFile?: (ref: HairAssetFileRefV1, reservation: GoonAssetReservation) => Promise<unknown>
}

const REGISTER_USER_HAIR_ASSET_REVISION_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if not customGoonUploadsAvailable(ARGV[3]) then return { 'ASSET_UNAVAILABLE' } end
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

local current = redis.call('JSON.GET', KEYS[1])
if current then
  if not deepEqual(cjson.decode(current), cjson.decode(ARGV[1])) then
    return { 'IMMUTABLE_CONFLICT' }
  end
  local existingIndexResult = redis.pcall('SADD', KEYS[2], ARGV[2])
  if type(existingIndexResult) == 'table' and existingIndexResult['err'] then
    return { 'INDEX_WRITE_FAILED', existingIndexResult['err'] }
  end
  return { 'EXISTING', current }
end

local revisionResult = redis.pcall('JSON.SET', KEYS[1], '$', ARGV[1])
if type(revisionResult) == 'table' and revisionResult['err'] then
  return { 'REVISION_WRITE_FAILED', revisionResult['err'] }
end
local indexResult = redis.pcall('SADD', KEYS[2], ARGV[2])
if type(indexResult) == 'table' and indexResult['err'] then
  redis.call('DEL', KEYS[1])
  return { 'INDEX_WRITE_FAILED', indexResult['err'] }
end
return { 'INSERTED' }
`

const COMMIT_IMPORTED_HAIR_ASSET_REVISION_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if not customGoonUploadsAvailable(ARGV[9]) then return { 'ASSET_UNAVAILABLE' } end
local function deepEqual(left, right)
  if left == cjson.null or right == cjson.null then
    return left == cjson.null and right == cjson.null
  end
  if type(left) ~= type(right) then return false end
  if type(left) ~= 'table' then return left == right end
  for key, value in pairs(left) do
    if not deepEqual(value, right[key]) then return false end
  end
  for key, _ in pairs(right) do
    if left[key] == nil then return false end
  end
  return true
end

local jobRaw = redis.call('JSON.GET', KEYS[3])
if not jobRaw then return { 'JOB_NOT_FOUND' } end
local job = cjson.decode(jobRaw)
if job.userId ~= ARGV[3] then return { 'JOB_FORBIDDEN' } end
if tonumber(job.stateVersion) ~= tonumber(ARGV[4]) then return { 'JOB_WRITE_CONFLICT' } end
if job.status ~= 'reviewable' then return { 'JOB_INVALID_STATE' } end
if not job.candidate or job.candidate.assetId ~= ARGV[5] or job.candidate.revisionId ~= ARGV[6] then
  return { 'JOB_CANDIDATE_MISMATCH' }
end

local current = redis.call('JSON.GET', KEYS[1])
local currentRefit = redis.call('JSON.GET', KEYS[5])
if current then
  if not deepEqual(cjson.decode(current), cjson.decode(ARGV[1])) then
    return { 'IMMUTABLE_CONFLICT' }
  end
  if not currentRefit or not deepEqual(cjson.decode(currentRefit), cjson.decode(ARGV[8])) then
    return { 'REFIT_CONFLICT' }
  end
  local existingIndexResult = redis.pcall('SADD', KEYS[2], ARGV[2])
  if type(existingIndexResult) == 'table' and existingIndexResult['err'] then
    return { 'INDEX_WRITE_FAILED', existingIndexResult['err'] }
  end
  redis.call('DEL', KEYS[3])
  redis.call('SREM', KEYS[4], ARGV[7])
  return { 'EXISTING', current }
end

if currentRefit then return { 'REFIT_CONFLICT' } end

local revisionResult = redis.pcall('JSON.SET', KEYS[1], '$', ARGV[1])
if type(revisionResult) == 'table' and revisionResult['err'] then
  return { 'REVISION_WRITE_FAILED', revisionResult['err'] }
end
local refitResult = redis.pcall('JSON.SET', KEYS[5], '$', ARGV[8])
if type(refitResult) == 'table' and refitResult['err'] then
  redis.call('DEL', KEYS[1])
  return { 'REFIT_WRITE_FAILED', refitResult['err'] }
end
local indexResult = redis.pcall('SADD', KEYS[2], ARGV[2])
if type(indexResult) == 'table' and indexResult['err'] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[5])
  return { 'INDEX_WRITE_FAILED', indexResult['err'] }
end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[7])
return { 'INSERTED' }
`

let builtinCatalogPromise: Promise<HairBuiltinCatalogV2> | null = null

function stableSegment(value: string, context: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new HairAssetRepositoryError('NOT_FOUND', `${context} is invalid.`, 404)
  }
  return value
}

export function userHairAssetIndexKey(userId: string) {
  return `user:${userId}:hair_assets`
}

export function userHairAssetRevisionKey(userId: string, assetId: string, revisionId: string) {
  return `hair_asset:${userId}:${stableSegment(assetId, 'Hair Asset id')}:${stableSegment(revisionId, 'Hair Asset revision id')}`
}

export function userHairRefitSourceKey(userId: string, assetId: string, revisionId: string) {
  return `hair_refit_source:${userId}:${stableSegment(assetId, 'Hair Asset id')}:${stableSegment(revisionId, 'Hair Asset revision id')}`
}

function indexMember(assetId: string, revisionId: string) {
  return `${stableSegment(assetId, 'Hair Asset id')}@${stableSegment(revisionId, 'Hair Asset revision id')}`
}

function parseIndexMember(value: string) {
  const separator = value.indexOf('@')
  if (separator < 1 || separator === value.length - 1 || value.indexOf('@', separator + 1) !== -1) {
    throw new HairAssetRepositoryError(
      'NOT_FOUND',
      `Hair Asset index contains invalid member "${value}".`,
      500
    )
  }
  return {
    assetId: stableSegment(value.slice(0, separator), 'Hair Asset index id'),
    revisionId: stableSegment(value.slice(separator + 1), 'Hair Asset index revision id')
  }
}

export async function loadHairBuiltinCatalog(): Promise<HairBuiltinCatalogV2> {
  if (!builtinCatalogPromise) {
    builtinCatalogPromise = (async () => {
      const catalog = await loadHairBuiltinCatalogMetadata()
      await Promise.all(
        catalog.assets.flatMap((asset) =>
          collectHairAssetFileRefs(asset).map((ref) => readHairAssetFileBytes(asset, ref))
        )
      )
      return catalog
    })().catch((error) => {
      builtinCatalogPromise = null
      throw error
    })
  }
  return builtinCatalogPromise
}

async function builtins(dependencies: RepositoryDependencies): Promise<HairAssetV1[]> {
  if (dependencies.builtinAssets) {
    const assets = await Promise.all(
      dependencies.builtinAssets.map((asset) => verifyHairAsset(asset))
    )
    if (assets.some((asset) => asset.sourceClass !== 'builtin')) {
      throw new Error('Injected built-in Hair Asset inventory contains a user asset.')
    }
    return assets
  }
  return listCurrentHairBuiltinAssets(await loadHairBuiltinCatalog())
}

async function builtinRevisionHistory(
  dependencies: RepositoryDependencies
): Promise<HairAssetV1[]> {
  if (dependencies.builtinAssets) {
    const assets = await Promise.all(
      dependencies.builtinAssets.map((asset) => verifyHairAsset(asset))
    )
    if (assets.some((asset) => asset.sourceClass !== 'builtin')) {
      throw new Error('Injected built-in Hair Asset inventory contains a user asset.')
    }
    return assets
  }
  return (await loadHairBuiltinCatalog()).assets
}

export async function migrateSavedHairBuiltinState(
  state: HairStateV2
): Promise<HairBuiltinStateMigration> {
  return migrateHairBuiltinStateToCurrent(state, await loadHairBuiltinCatalog())
}

async function listUserAssetsForClient(
  client: any,
  userId: string,
  options: { verifyFiles?: boolean } = {}
): Promise<HairAssetV1[]> {
  const members = ((await client.sMembers(userHairAssetIndexKey(userId))) as string[]).sort(
    (a, b) => a.localeCompare(b)
  )
  const results: HairAssetV1[] = []
  for (const member of members) {
    const identity = parseIndexMember(member)
    const value = await client.json.get(
      userHairAssetRevisionKey(userId, identity.assetId, identity.revisionId)
    )
    if (!value) {
      throw new Error(`Hair Asset index member ${member} has no immutable revision record.`)
    }
    const asset = await verifyHairAsset(value)
    if (
      asset.sourceClass !== 'user' ||
      asset.assetId !== identity.assetId ||
      asset.revisionId !== identity.revisionId
    ) {
      throw new Error(`Hair Asset index member ${member} does not match its revision record.`)
    }
    if (options.verifyFiles !== false) await verifyOwnedFiles(client, asset)
    results.push(asset)
  }
  return results
}

export async function listHairAssets(
  userId: string,
  dependencies: RepositoryDependencies = {}
): Promise<HairAssetV1[]> {
  const [builtin, user] = await Promise.all([
    builtins(dependencies),
    redis.execute((client) => listUserAssetsForClient(client, userId))
  ])
  return [...builtin, ...user].sort((left, right) => {
    const id = left.assetId.localeCompare(right.assetId)
    return id || left.revision - right.revision || left.revisionId.localeCompare(right.revisionId)
  })
}

export async function resolveHairAssetRevision(
  userId: string,
  selection: Pick<HairAssetSelectionV1, 'assetId' | 'assetRevisionId' | 'assetRevisionSha256'>,
  dependencies: RepositoryDependencies = {}
): Promise<HairAssetV1> {
  const builtin = (await builtinRevisionHistory(dependencies)).find(
    (asset) => asset.assetId === selection.assetId && asset.revisionId === selection.assetRevisionId
  )
  if (builtin) {
    if (builtin.revisionSha256 !== selection.assetRevisionSha256) {
      throw new HairAssetRepositoryError(
        'NOT_FOUND',
        `Hair Asset ${selection.assetId}@${selection.assetRevisionId} does not match the selected immutable revision hash.`,
        409
      )
    }
    return builtin
  }
  return redis.execute(async (client: any) => {
    const asset = await client.json.get(
      userHairAssetRevisionKey(userId, selection.assetId, selection.assetRevisionId)
    )
    if (!asset) {
      throw new HairAssetRepositoryError(
        'NOT_FOUND',
        `Hair Asset ${selection.assetId}@${selection.assetRevisionId} is missing.`,
        404
      )
    }
    const verified = await verifyHairAsset(asset)
    if (verified.revisionSha256 !== selection.assetRevisionSha256) {
      throw new HairAssetRepositoryError(
        'NOT_FOUND',
        `Hair Asset ${selection.assetId}@${selection.assetRevisionId} does not match the selected immutable revision hash.`,
        409
      )
    }
    await verifyOwnedFiles(client, verified)
    return verified
  })
}

function uploadFilename(ref: HairAssetFileRefV1) {
  if (!ref.ref.startsWith(USER_HAIR_ASSET_PREFIX)) {
    throw new HairAssetRepositoryError(
      'INVALID_OWNED_FILE',
      `User Hair Asset file ${ref.ref} is outside the owned Hair upload boundary.`,
      400
    )
  }
  const filename = ref.ref.slice(USER_HAIR_ASSET_PREFIX.length)
  if (!filename || filename.includes('/') || filename.includes('\\')) {
    throw new HairAssetRepositoryError(
      'INVALID_OWNED_FILE',
      `User Hair Asset file ${ref.ref} must resolve to one canonical owned filename.`,
      400
    )
  }
  return filename
}

async function verifyOwnedFileRefs(client: any, refs: readonly HairAssetFileRefV1[]) {
  for (const ref of refs) {
    const filename = uploadFilename(ref)
    const record = (await client.json.get(`upload:${USER_HAIR_UPLOAD_TYPE}:${filename}`)) as Record<
      string,
      unknown
    > | null
    if (
      !record ||
      record.storage !== 'filesystem' ||
      record.uploadType !== USER_HAIR_UPLOAD_TYPE ||
      record.relativePath !== `${USER_HAIR_UPLOAD_TYPE}/${filename}` ||
      record.sha256 !== ref.sha256 ||
      record.size !== ref.bytes ||
      (record.mimetype !== undefined && record.mimetype !== ref.mimeType)
    ) {
      throw new HairAssetRepositoryError(
        'INVALID_OWNED_FILE',
        `User Hair Asset file ${ref.ref} is missing or does not match its immutable upload receipt.`,
        409
      )
    }
  }
}

async function verifyOwnedFiles(client: any, asset: HairAssetV1) {
  await verifyOwnedFileRefs(client, collectHairAssetFileRefs(asset))
}

function assertRefitIdentity(
  source: HairRefitSourceV1,
  assetId: string,
  revisionId: string
) {
  if (source.assetId !== assetId || source.revisionId !== revisionId) {
    throw new HairAssetRepositoryError(
      'INVALID_OWNED_FILE',
      `Hair refit source ${source.assetId}@${source.revisionId} does not match ${assetId}@${revisionId}.`,
      409
    )
  }
  return source
}

export async function getHairRefitSource(
  userId: string,
  assetId: string,
  revisionId: string
): Promise<HairRefitSourceV1 | null> {
  return redis.execute(async (client: any) => {
    const value = await client.json.get(userHairRefitSourceKey(userId, assetId, revisionId))
    if (!value) return null
    const source = assertRefitIdentity(
      parseHairRefitSource(value),
      stableSegment(assetId, 'Hair Asset id'),
      stableSegment(revisionId, 'Hair Asset revision id')
    )
    await verifyOwnedFileRefs(client, [source.source])
    return source
  })
}

export async function listHairRefitSources(userId: string): Promise<HairRefitSourceV1[]> {
  return redis.execute(async (client: any) => {
    const members = ((await client.sMembers(userHairAssetIndexKey(userId))) as string[]).sort(
      (left, right) => left.localeCompare(right)
    )
    const sources: HairRefitSourceV1[] = []
    for (const member of members) {
      const identity = parseIndexMember(member)
      const value = await client.json.get(
        userHairRefitSourceKey(userId, identity.assetId, identity.revisionId)
      )
      if (!value) continue
      const source = assertRefitIdentity(
        parseHairRefitSource(value),
        identity.assetId,
        identity.revisionId
      )
      await verifyOwnedFileRefs(client, [source.source])
      sources.push(source)
    }
    return sources
  })
}

export async function readHairAssetFileBytes(
  asset: HairAssetV1,
  ref: HairAssetFileRefV1,
  readOwnedFile?: (ref: HairAssetFileRefV1) => Promise<Uint8Array>
): Promise<Uint8Array> {
  let bytes: Uint8Array
  if (asset.sourceClass === 'builtin') {
    const root = resolve(process.cwd(), 'static/goon-assets/hair')
    const path = resolve(process.cwd(), 'static', ref.ref.slice(1))
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`Built-in Hair Asset file ${ref.ref} escapes the trusted catalog root.`)
    }
    bytes = new Uint8Array(await readFile(path))
  } else {
    if (!readOwnedFile) {
      throw new Error(`User Hair Asset file ${ref.ref} requires the owned-file reader.`)
    }
    bytes = await readOwnedFile(ref)
  }
  if (bytes.byteLength !== ref.bytes || (await sha256Hex(bytes)) !== ref.sha256) {
    throw new HairAssetRepositoryError(
      'INVALID_OWNED_FILE',
      `Hair Asset file ${ref.ref} does not match its immutable byte receipt.`,
      409
    )
  }
  return bytes
}

export async function putUserHairAssetRevision(
  userId: string,
  value: unknown
): Promise<HairAssetV1> {
  const asset = await verifyHairAsset(value)
  if (asset.sourceClass !== 'user') {
    throw new HairAssetRepositoryError(
      'IMMUTABLE_REVISION_CONFLICT',
      'Only user Hair Asset revisions may be written to Redis.',
      400
    )
  }
  const builtinCollision = (await builtinRevisionHistory({})).some(
    (entry) => entry.assetId === asset.assetId
  )
  if (builtinCollision) {
    throw new HairAssetRepositoryError(
      'BUILTIN_COLLISION',
      `User Hair Asset id ${asset.assetId} collides with the read-only built-in catalog.`,
      409
    )
  }
  return redis.execute(async (client: any) => {
    await verifyOwnedFiles(client, asset)
    const key = userHairAssetRevisionKey(userId, asset.assetId, asset.revisionId)
    const indexKey = userHairAssetIndexKey(userId)
    const member = indexMember(asset.assetId, asset.revisionId)
    const canonicalAsset = canonicalRecipeString(asset)
    if (typeof client.eval !== 'function') {
      if (process.env.VITEST !== 'true' || process.env.VITEST_USE_REAL_REDIS === 'true') {
        throw new HairAssetRepositoryError(
          'ATOMIC_REGISTRATION_FAILED',
          'Redis EVAL is unavailable; the Hair Asset revision cannot be registered safely.',
          500
        )
      }
      const existing = await client.json.get(key)
      if (existing) {
        const verified = await verifyHairAsset(existing)
        if (canonicalRecipeString(verified) !== canonicalAsset) {
          throw new HairAssetRepositoryError(
            'IMMUTABLE_REVISION_CONFLICT',
            `Hair Asset revision ${asset.assetId}@${asset.revisionId} already exists with different immutable content.`,
            409
          )
        }
        await client.sAdd(indexKey, member)
        return verified
      }
      await client.json.set(key, '$', asset)
      await client.sAdd(indexKey, member)
      return asset
    }
    const result = await client.eval(REGISTER_USER_HAIR_ASSET_REVISION_SCRIPT, {
      keys: [key, indexKey],
      arguments: [canonicalAsset, member, JSON.stringify(collectCustomGoonUploadKeys(asset))]
    })
    if (!Array.isArray(result) || typeof result[0] !== 'string') {
      throw new HairAssetRepositoryError(
        'ATOMIC_REGISTRATION_FAILED',
        'Atomic Hair Asset registration returned an unsupported result.',
        500,
        result
      )
    }
    const [status, detail] = result
    if (status === 'ASSET_UNAVAILABLE') {
      throw new HairAssetRepositoryError('INVALID_OWNED_FILE', 'Hair Asset files are unavailable or being deleted. Retry after cleanup finishes.', 409)
    }
    if (status === 'INSERTED') return asset
    if (status === 'IMMUTABLE_CONFLICT') {
      throw new HairAssetRepositoryError(
        'IMMUTABLE_REVISION_CONFLICT',
        `Hair Asset revision ${asset.assetId}@${asset.revisionId} already exists with different immutable content.`,
        409
      )
    }
    if (status === 'EXISTING' && typeof detail === 'string') {
      const verified = await verifyHairAsset(JSON.parse(detail))
      if (canonicalRecipeString(verified) !== canonicalAsset) {
        throw new HairAssetRepositoryError(
          'IMMUTABLE_REVISION_CONFLICT',
          `Hair Asset revision ${asset.assetId}@${asset.revisionId} already exists with different immutable content.`,
          409
        )
      }
      return verified
    }
    throw new HairAssetRepositoryError(
      'ATOMIC_REGISTRATION_FAILED',
      'Atomic Hair Asset registration failed without changing the catalog.',
      500,
      { status, detail }
    )
  })
}

export async function commitImportedHairAssetRevision(input: {
  userId: string
  jobId: string
  expectedJobStateVersion: number
  asset: unknown
  refitSource: unknown
}): Promise<HairAssetV1> {
  const asset = await verifyHairAsset(input.asset)
  const refitSource = assertRefitIdentity(
    parseHairRefitSource(input.refitSource),
    asset.assetId,
    asset.revisionId
  )
  if (asset.sourceClass !== 'user') {
    throw new HairAssetRepositoryError(
      'IMMUTABLE_REVISION_CONFLICT',
      'Only user Hair Asset revisions may be committed from an import.',
      400
    )
  }
  if (!Number.isSafeInteger(input.expectedJobStateVersion) || input.expectedJobStateVersion < 1) {
    throw new HairAssetRepositoryError(
      'ATOMIC_REGISTRATION_FAILED',
      'Hair import commit requires a positive job state version.',
      400
    )
  }
  const builtinCollision = (await builtins({})).some((entry) => entry.assetId === asset.assetId)
  if (builtinCollision) {
    throw new HairAssetRepositoryError(
      'BUILTIN_COLLISION',
      `User Hair Asset id ${asset.assetId} collides with the read-only built-in catalog.`,
      409
    )
  }
  return redis.execute(async (client: any) => {
    await verifyOwnedFiles(client, asset)
    await verifyOwnedFileRefs(client, [refitSource.source])
    if (typeof client.eval !== 'function') {
      throw new HairAssetRepositoryError(
        'ATOMIC_REGISTRATION_FAILED',
        'Redis EVAL is unavailable; the Hair import cannot transfer ownership safely.',
        500
      )
    }
    const revisionKey = userHairAssetRevisionKey(input.userId, asset.assetId, asset.revisionId)
    const assetIndexKey = userHairAssetIndexKey(input.userId)
    const member = indexMember(asset.assetId, asset.revisionId)
    const result = await client.eval(COMMIT_IMPORTED_HAIR_ASSET_REVISION_SCRIPT, {
      keys: [
        revisionKey,
        assetIndexKey,
        hairImportJobRedisKey(input.userId, input.jobId),
        hairImportJobIndexKey(input.userId),
        userHairRefitSourceKey(input.userId, asset.assetId, asset.revisionId)
      ],
      arguments: [
        canonicalRecipeString(asset),
        member,
        input.userId,
        String(input.expectedJobStateVersion),
        asset.assetId,
        asset.revisionId,
        input.jobId,
        canonicalRecipeString(refitSource),
        JSON.stringify(collectCustomGoonUploadKeys([asset, refitSource]))
      ]
    })
    if (!Array.isArray(result) || typeof result[0] !== 'string') {
      throw new HairAssetRepositoryError(
        'ATOMIC_REGISTRATION_FAILED',
        'Atomic Hair import commit returned an unsupported result.',
        500,
        result
      )
    }
    const [status, detail] = result
    if (status === 'ASSET_UNAVAILABLE') {
      throw new HairAssetRepositoryError('INVALID_OWNED_FILE', 'Hair Asset files are unavailable or being deleted. Retry after cleanup finishes.', 409)
    }
    if (status === 'INSERTED') return asset
    if (status === 'EXISTING' && typeof detail === 'string') {
      const existing = await verifyHairAsset(JSON.parse(detail))
      if (canonicalRecipeString(existing) !== canonicalRecipeString(asset)) {
        throw new HairAssetRepositoryError(
          'IMMUTABLE_REVISION_CONFLICT',
          `Hair Asset revision ${asset.assetId}@${asset.revisionId} already exists with different immutable content.`,
          409
        )
      }
      return existing
    }
    if (status === 'IMMUTABLE_CONFLICT') {
      throw new HairAssetRepositoryError(
        'IMMUTABLE_REVISION_CONFLICT',
        `Hair Asset revision ${asset.assetId}@${asset.revisionId} already exists with different immutable content.`,
        409
      )
    }
    if (status === 'REFIT_CONFLICT') {
      throw new HairAssetRepositoryError(
        'IMMUTABLE_REVISION_CONFLICT',
        `Hair refit source ${asset.assetId}@${asset.revisionId} already exists with different immutable content.`,
        409
      )
    }
    const jobFailures: Record<string, { message: string; status: number }> = {
      JOB_NOT_FOUND: { message: 'The Hair import job was not found.', status: 404 },
      JOB_FORBIDDEN: { message: 'The Hair import job belongs to another user.', status: 403 },
      JOB_WRITE_CONFLICT: {
        message: 'The Hair import changed while it was being saved.',
        status: 409
      },
      JOB_INVALID_STATE: { message: 'The Hair import is not ready to save.', status: 409 },
      JOB_CANDIDATE_MISMATCH: {
        message: 'The reviewed Hair candidate does not match the immutable revision being saved.',
        status: 409
      }
    }
    const failure = jobFailures[status]
    throw new HairAssetRepositoryError(
      'ATOMIC_REGISTRATION_FAILED',
      failure?.message ?? 'Atomic Hair import commit failed without changing the catalog.',
      failure?.status ?? 500,
      { status, detail }
    )
  })
}

function collectStateDependencies(
  value: unknown,
  redisKey: string,
  dependencies: HairAssetDependency[]
) {
  if (Array.isArray(value)) {
    for (const entry of value) collectStateDependencies(entry, redisKey, dependencies)
    return
  }
  if (value === null || typeof value !== 'object') return
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion === HAIR_STATE_CONTRACT) {
    const state = parseHairState(raw)
    if (state.selected) {
      dependencies.push({
        redisKey,
        assetId: state.selected.assetId,
        assetRevisionId: state.selected.assetRevisionId
      })
    }
    return
  }
  for (const entry of Object.values(raw)) collectStateDependencies(entry, redisKey, dependencies)
}

export async function findHairAssetDependenciesForClient(
  client: any,
  userId: string,
  assetId: string,
  revisionId: string
): Promise<HairAssetDependency[]> {
  const goonIds = ((await client.sMembers(`user:${userId}:goons`)) as string[]).sort((a, b) =>
    a.localeCompare(b)
  )
  const keys = new Set<string>([...goonIds.map((goonId) => `goon:${goonId}`),
    ...await client.keys('goon:*'), `user:${userId}:settings`])
  for (const pattern of [
    `goon_recipe_revision:${userId}:*`,
    `goon_recipe_document:${userId}:*`,
    `goon_recipe_job:${userId}:*`,
    `hair_import_job:${userId}:*`
  ]) {
    for (const key of (await client.keys(pattern)) as string[]) keys.add(key)
  }
  const usageByKey = new Map<string, { usage: string; previousVersion: boolean }>()
  for (const goonId of goonIds) {
    const key = `goon:${goonId}`
    const goon = await client.json.get(key)
    if (!goon) continue
    const name = typeof goon.name === 'string' && goon.name.trim() ? goon.name.trim() : 'Unnamed Goon'
    usageByKey.set(key, { usage: `the saved Goon “${name}”`, previousVersion: false })
    for (const [field, label] of [
      ['activeRevision', 'the current version'],
      ['previousRevision', 'Previous Version (rollback)']
    ] as const) {
      const ref = goon.recipe?.[field]?.ref
      if (typeof ref === 'string') {
        usageByKey.set(ref, { usage: `${label} of “${name}”`, previousVersion: field === 'previousRevision' })
      }
    }
  }
  const dependencies: HairAssetDependency[] = []
  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    const value = await client.json.get(key)
    if (value) {
      collectStateDependencies(value, key, dependencies)
      if (key.startsWith('hair_import_job:') && value.target?.kind === 'refit' &&
          value.target.assetId === assetId && value.target.sourceRevisionId === revisionId) {
        dependencies.push({ redisKey: key, assetId, assetRevisionId: revisionId, usage: 'an unfinished Hair refit' })
      }
    }
  }
  return dependencies.filter(
    (dependency) => dependency.assetId === assetId && dependency.assetRevisionId === revisionId
  ).map((dependency) => ({ ...dependency, ...usageByKey.get(dependency.redisKey) }))
}

function hairAssetInUseMessage(dependencies: HairAssetDependency[]): string {
  const usages = [...new Set(dependencies.map((entry) => entry.usage ?? 'a retained Goon recipe or build'))]
  const explanation = dependencies.some((entry) => entry.previousVersion)
    ? 'Keeping that rollback version also keeps its Hair. Choosing No Hair for the current version does not remove it from Previous Version.'
    : 'Choose and save different Hair on the affected Goon, and check any retained versions or builds.'
  return `This Hair is still needed by ${usages.join('; ')}. ${explanation} It can be deleted once no saved version or build uses it.`
}

const RETIRE_USER_HAIR_REVISION_SCRIPT = `
local current = redis.call('JSON.GET', KEYS[1])
local source = redis.call('JSON.GET', KEYS[2])
if current ~= ARGV[1] or (source or '') ~= ARGV[2] then return 'CHANGED' end
local indexType = redis.call('TYPE', KEYS[3]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'INVALID_INDEX' end
local claims = cjson.decode(ARGV[4])
for _, claim in ipairs(claims) do
  local raw = redis.call('GET', claim.key)
  if not raw then return 'CHANGED_CLAIM' end
  local marker = cjson.decode(raw)
  if marker.contract ~= 'goon-asset-deletion/v1' or marker.token ~= claim.token or marker.phase ~= 'reserved' then return 'CHANGED_CLAIM' end
end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SREM', KEYS[3], ARGV[3])
return 'RETIRED'
`

export async function deleteUserHairAssetRevision(userId: string, assetId: string, revisionId: string,
  dependencies: RepositoryDependencies = {}) {
  const held: Array<{ ref: HairAssetFileRefV1; reservation: GoonAssetReservation }> = []
  const reserve = dependencies.reserveOwnedFile ?? ((ref: HairAssetFileRefV1) => reserveGoonUploadAsset('goon_hair_assets', uploadFilename(ref)))
  const release = dependencies.releaseOwnedFile ?? ((ref: HairAssetFileRefV1, reservation: GoonAssetReservation) =>
    releaseGoonUploadReservation('goon_hair_assets', uploadFilename(ref), reservation))
  let retirementDispatched = false
  try {
    const deleted = await redis.execute(async (client: any) => {
      const key = userHairAssetRevisionKey(userId, assetId, revisionId)
      const sourceKey = userHairRefitSourceKey(userId, assetId, revisionId)
      const readRaw = async (recordKey: string): Promise<string | null> => typeof client.sendCommand === 'function'
        ? client.sendCommand(['JSON.GET', recordKey]) : JSON.stringify(await client.json.get(recordKey))
      const raw = await readRaw(key)
      if (!raw || raw === 'null') throw new HairAssetRepositoryError('NOT_FOUND', `Hair Asset ${assetId}@${revisionId} was not found.`, 404)
      const asset = await verifyHairAsset(JSON.parse(raw))
      if (asset.sourceClass !== 'user') throw new HairAssetRepositoryError('NOT_FOUND', 'Built-in Hair Assets are read-only and cannot be deleted.', 404)
      const sourceRaw = await readRaw(sourceKey)
      const source = sourceRaw && sourceRaw !== 'null' ? assertRefitIdentity(parseHairRefitSource(JSON.parse(sourceRaw)), assetId, revisionId) : null
      const refs = [...new Map([...collectHairAssetFileRefs(asset), ...(source ? [source.source] : [])].map((ref) => [ref.ref, ref])).values()]
      // Fence EVERY file before the dependency read, including shared files.
      // New identity selections check the exact revision and these same claims.
      for (const ref of refs) {
        const reservation = await reserve(ref)
        held.push({ ref, reservation })
        if (reservation.phase !== 'reserved') throw new HairAssetRepositoryError('OWNED_FILE_DELETE_FAILED', 'Hair cleanup is already deleting a file. Finish cleanup before retrying library removal.', 409)
      }
      await verifyOwnedFiles(client, asset)
      if (source) await verifyOwnedFileRefs(client, [source.source])
      const borrowers = await findHairAssetDependenciesForClient(client, userId, assetId, revisionId)
      if (borrowers.length) throw new HairAssetRepositoryError('ASSET_IN_USE', hairAssetInUseMessage(borrowers), 409, borrowers)
      const retained = await collectAllGoonUploadReferencesForClient(client, { excludedRecordKeys: [key, sourceKey],
        candidateFiles: held.map(({ ref }) => ({ uploadType: 'goon_hair_assets', filename: uploadFilename(ref) })) })
      retirementDispatched = true
      if (typeof client.eval === 'function') {
        const result = await client.eval(RETIRE_USER_HAIR_REVISION_SCRIPT, {
          keys: [key, sourceKey, userHairAssetIndexKey(userId)],
          arguments: [raw, sourceRaw === 'null' || !sourceRaw ? '' : sourceRaw, indexMember(assetId, revisionId),
            JSON.stringify(held.map(({ ref, reservation }) => ({ key: `goon_asset_delete:goon_hair_assets:${uploadFilename(ref)}`, token: reservation.token })))]
        })
        if (result !== 'RETIRED') {
          retirementDispatched = false // Definitive pre-mutation refusal; reserved tokens can be released.
          throw new HairAssetRepositoryError('OWNED_FILE_DELETE_FAILED', 'Hair library ownership changed. Retry from its current state.', 409, result)
        }
      } else {
        if (process.env.VITEST !== 'true' || process.env.VITEST_USE_REAL_REDIS === 'true') throw new HairAssetRepositoryError('ATOMIC_REGISTRATION_FAILED', 'Redis EVAL is required for safe Hair library removal.', 500)
        if (await readRaw(key) !== raw || await readRaw(sourceKey) !== sourceRaw) throw new HairAssetRepositoryError('OWNED_FILE_DELETE_FAILED', 'Hair library ownership changed.', 409)
        await client.json.del(key)
        await client.json.del(sourceKey)
        await client.sRem(userHairAssetIndexKey(userId), indexMember(assetId, revisionId))
      }
      return { asset, retained }
    })
    const failures: Array<{ ref: string; error: string }> = []
    for (const { ref, reservation } of held) {
      try {
        if (hasGoonUploadReference(deleted.retained, 'goon_hair_assets', uploadFilename(ref))) await release(ref, reservation)
        else if (dependencies.deleteOwnedFile) await dependencies.deleteOwnedFile(ref, reservation)
        else await deleteReservedGoonUploadAsset('goon_hair_assets', uploadFilename(ref), reservation, undefined, ref)
      } catch (error) { failures.push({ ref: ref.ref, error: error instanceof Error ? error.message : String(error) }) }
    }
    if (failures.length) throw new HairAssetRepositoryError('OWNED_FILE_DELETE_FAILED',
      'Hair library metadata was retired, but file cleanup did not finish. Retry the exact unfinished cleanup in Admin.', 500, failures)
    return deleted.asset
  } catch (error) {
    // Before retirement dispatch no physical IO owns these reservations. After
    // uncertain CAS/IO, keep tokens so exact Admin recovery remains possible.
    if (!retirementDispatched) {
      for (const { ref, reservation } of held) if (reservation.phase === 'reserved') await release(ref, reservation)
    }
    throw error
  }
}

export const HAIR_ASSET_REDIS_CONTRACT = {
  definition: HAIR_ASSET_CONTRACT,
  indexKey: userHairAssetIndexKey,
  revisionKey: userHairAssetRevisionKey,
  refitSourceKey: userHairRefitSourceKey
} as const

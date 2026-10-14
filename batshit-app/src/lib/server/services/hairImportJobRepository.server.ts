import { randomUUID } from 'node:crypto'

import { redis } from '$lib/server/redis'
import { collectCustomGoonUploadKeys, CUSTOM_GOON_UPLOAD_GUARD_LUA } from './goonCustomAssetOwnership.server'
import { sameHairCleanupFile, isHairCleanupFile, type HairCleanupContext } from './hairCleanupContext'
import type { HairImportOwnedFile } from './hairCleanupContext'
import type { HairRefitTransformV1 } from '$lib/goons/hairAssets'

export const HAIR_IMPORT_JOB_CONTRACT = 'hair-import-job/v4' as const
export const HAIR_IMPORT_JOB_TTL_SECONDS = 24 * 60 * 60

export type HairImportJobStatus =
  | 'inspected'
  | 'preparing'
  | 'reviewable'
  | 'finalizing'
  | 'complete'
  | 'failed'
  | 'cancelled'

const HAIR_IMPORT_JOB_STATUSES: readonly HairImportJobStatus[] = [
  'inspected',
  'preparing',
  'reviewable',
  'finalizing',
  'complete',
  'failed',
  'cancelled'
]

export type { HairImportOwnedFile } from './hairCleanupContext'

export type HairImportTarget =
  | { kind: 'new' }
  | {
      kind: 'refit'
      assetId: string
      revisionId: string
      revision: number
      sourceRevisionId: string
      displayName: string
      author: string
      license: string
      originalSourceSha256: string
      refitSource: HairImportOwnedFile
    }

export type HairImportJob = {
  contract: typeof HAIR_IMPORT_JOB_CONTRACT
  jobId: string
  userId: string
  goonId: string
  status: HairImportJobStatus
  stateVersion: number
  source: HairImportOwnedFile & { originalName: string }
  target: HairImportTarget
  startingTransform: HairRefitTransformV1
  initialTransform: HairRefitTransformV1
  inspection: Record<string, unknown>
  calibration: Record<string, unknown> | null
  draft: Record<string, unknown> | null
  proposal: Record<string, unknown> | null
  candidate: Record<string, unknown> | null
  cleanupFiles: HairImportOwnedFile[]
  failure: { stage: string; message: string } | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export type HairImportDiscardableJob = Pick<
  HairImportJob,
  'jobId' | 'userId' | 'cleanupFiles'
> & {
  reason: 'expired' | 'obsolete'
  observedRaw: string
}

export class HairImportJobError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'WRITE_CONFLICT'
      | 'INVALID_STATE'
      | 'CLEANUP_FAILED',
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'HairImportJobError'
  }
}

/** Cleanup tuples are bookkeeping, not reference acquisition. Cancelled jobs
 * retain their borrowed source but cannot republish an owned candidate. */
export function hairImportJobLiveUploadKeys(job: HairImportJob, creation = false): string[] {
  const keys = collectCustomGoonUploadKeys(job.status === 'cancelled'
    ? (job.target.kind === 'refit' ? [job.target.refitSource] : [])
    : [job.source, job.target, job.candidate, job.proposal, job.draft, ...(creation ? job.cleanupFiles : [])])
  // The immutable raw source is consumed before final commit. Updating cleanup
  // bookkeeping must not reacquire those bytes; new source ownership is guarded
  // at job creation, and replace cannot change its source identity.
  return creation ? keys : keys.filter((key) => job.source.uploadType !== 'goon_hair_imports' ||
    key !== `upload:goon_hair_imports:${job.source.filename}`)
}

const CREATE_JOB_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if not customGoonUploadsAvailable(ARGV[3]) then return 'ASSET_UNAVAILABLE' end
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 'EXISTS'
end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
local indexResult = redis.pcall('SADD', KEYS[2], ARGV[2])
if type(indexResult) == 'table' and indexResult['err'] then
  redis.call('DEL', KEYS[1])
  return 'INDEX_WRITE_FAILED'
end
return 'CREATED'
`

const REPLACE_JOB_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
local current = redis.call('JSON.GET', KEYS[1])
if not current then return 'NOT_FOUND' end
local decoded = cjson.decode(current)
if decoded.userId ~= ARGV[1] then return 'FORBIDDEN' end
if tonumber(decoded.stateVersion) ~= tonumber(ARGV[2]) then return 'WRITE_CONFLICT' end
local next = cjson.decode(ARGV[3])
if decoded.status == 'cancelled' and next.status ~= 'cancelled' then return 'WRITE_CONFLICT' end
if not next.source or next.source.ref ~= decoded.source.ref then return 'WRITE_CONFLICT' end
if not customGoonUploadsAvailable(ARGV[4]) then return 'ASSET_UNAVAILABLE' end
redis.call('JSON.SET', KEYS[1], '$', ARGV[3])
return 'UPDATED'
`

const DELETE_JOB_SCRIPT = `
local current = redis.call('JSON.GET', KEYS[1])
if not current then return 'NOT_FOUND' end
if ARGV[2] ~= '' then
  if current ~= ARGV[2] then return 'WRITE_CONFLICT' end
else
  local decoded = cjson.decode(current)
  if decoded.stateVersion ~= tonumber(ARGV[3]) then return 'WRITE_CONFLICT' end
end
local removed = redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 'DELETED'
`

const RETIRE_JOB_SCRIPT = `
local current = redis.call('JSON.GET', KEYS[1])
if not current then return 'NOT_FOUND' end
if ARGV[1] ~= '' then
  if current ~= ARGV[1] then return 'WRITE_CONFLICT' end
else
  local decoded = cjson.decode(current)
  if decoded.stateVersion ~= tonumber(ARGV[2]) or decoded.status == 'complete' then return 'WRITE_CONFLICT' end
end
local decoded = cjson.decode(current)
if decoded.status == 'complete' then return 'WRITE_CONFLICT' end
-- Partial RedisJSON writes preserve every other raw number/array and legacy field.
redis.call('JSON.SET', KEYS[1], '.status', '"cancelled"')
if decoded.contract == 'hair-import-job/v4' then redis.call('JSON.NUMINCRBY', KEYS[1], '.stateVersion', 1) end
return redis.call('JSON.GET', KEYS[1])
`

export function hairImportJobRedisKey(userId: string, jobId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(userId)) {
    throw new HairImportJobError('FORBIDDEN', 'Hair import owner is invalid.', 403)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(jobId)) {
    throw new HairImportJobError('NOT_FOUND', 'Hair import job id is invalid.', 404)
  }
  return `hair_import_job:${userId}:${jobId}`
}

export function hairImportJobIndexKey(userId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(userId)) {
    throw new HairImportJobError('FORBIDDEN', 'Hair import owner is invalid.', 403)
  }
  return `user:${userId}:hair_import_jobs`
}

function isExpired(job: HairImportJob, now: Date) {
  return Date.parse(job.expiresAt) <= now.getTime()
}

function assertJobShape(value: unknown): HairImportJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HairImportJobError('INVALID_STATE', 'Stored Hair import job is malformed.', 500)
  }
  const job = value as HairImportJob
  if (
    job.contract !== HAIR_IMPORT_JOB_CONTRACT ||
    typeof job.jobId !== 'string' ||
    typeof job.userId !== 'string' ||
    typeof job.goonId !== 'string' ||
    !isHairCleanupFile(job.source) || job.source.bytes < 1 ||
    !job.target ||
    (job.target.kind !== 'new' && job.target.kind !== 'refit') ||
    !job.startingTransform ||
    !job.initialTransform ||
    !(
      job.calibration === null ||
      (typeof job.calibration === 'object' && !Array.isArray(job.calibration))
    ) ||
    !Number.isSafeInteger(job.stateVersion) || job.stateVersion < 1 ||
    !HAIR_IMPORT_JOB_STATUSES.includes(job.status) ||
    !Array.isArray(job.cleanupFiles) || !job.cleanupFiles.every(isHairCleanupFile)
  ) {
    throw new HairImportJobError('INVALID_STATE', 'Stored Hair import job is malformed.', 500)
  }
  return job
}

function assertCleanupFileShape(value: unknown): HairImportOwnedFile {
  if (!isHairCleanupFile(value)) throw new HairImportJobError('INVALID_STATE', 'Stored Hair import cleanup file is malformed.', 500)
  return value
}

function obsoleteCleanupJob(
  value: unknown,
  expectedUserId: string,
  expectedJobId: string,
  observedRaw: string
): HairImportDiscardableJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HairImportJobError('INVALID_STATE', 'Stored Hair import job is malformed.', 500)
  }
  const job = value as Record<string, unknown>
  if (
    typeof job.contract !== 'string' ||
    !job.contract.startsWith('hair-import-job/') ||
    job.contract === HAIR_IMPORT_JOB_CONTRACT ||
    job.userId !== expectedUserId ||
    job.jobId !== expectedJobId ||
    typeof job.status !== 'string' ||
    !HAIR_IMPORT_JOB_STATUSES.includes(job.status as HairImportJobStatus) ||
    !Array.isArray(job.cleanupFiles)
  ) {
    throw new HairImportJobError(
      'INVALID_STATE',
      `Stored Hair import job ${expectedJobId} does not match its cleanup index.`,
      500
    )
  }
  if (job.status === 'complete') {
    throw new HairImportJobError(
      'INVALID_STATE',
      `Completed obsolete Hair import job ${expectedJobId} requires manual ownership review.`,
      500
    )
  }
  return {
    jobId: expectedJobId,
    userId: expectedUserId,
    cleanupFiles: job.cleanupFiles.map(assertCleanupFileShape),
    reason: 'obsolete',
    observedRaw
  }
}

export async function createHairImportJob(input: {
  userId: string
  goonId: string
  source: HairImportJob['source']
  target?: HairImportTarget
  startingTransform?: HairRefitTransformV1
  initialTransform?: HairRefitTransformV1
  inspection: Record<string, unknown>
  calibration?: Record<string, unknown> | null
  cleanupFiles?: HairImportOwnedFile[]
  now?: Date
  jobId?: string
}) {
  const now = input.now ?? new Date()
  const jobId = input.jobId ?? randomUUID()
  const job: HairImportJob = {
    contract: HAIR_IMPORT_JOB_CONTRACT,
    jobId,
    userId: input.userId,
    goonId: input.goonId,
    status: 'inspected',
    stateVersion: 1,
    source: input.source,
    target: input.target ?? { kind: 'new' },
    startingTransform: input.startingTransform ?? {
      move: { x: 0, y: 0, z: 0 },
      rotate: { x: 0, y: 0, z: 0 },
      uniformScale: 1,
      axisScale: { x: 1, y: 1, z: 1 }
    },
    initialTransform: input.initialTransform ??
      input.startingTransform ?? {
        move: { x: 0, y: 0, z: 0 },
        rotate: { x: 0, y: 0, z: 0 },
        uniformScale: 1,
        axisScale: { x: 1, y: 1, z: 1 }
      },
    inspection: input.inspection,
    calibration: input.calibration ?? null,
    draft: null,
    proposal: null,
    candidate: null,
    cleanupFiles: [
      input.source,
      ...new Map(
        (input.cleanupFiles ?? [])
          .filter((file) => file.ref !== input.source.ref)
          .map((file) => [file.ref, file])
      ).values()
    ],
    failure: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + HAIR_IMPORT_JOB_TTL_SECONDS * 1000).toISOString()
  }
  await redis.execute(async (client: any) => {
    if (typeof client.eval === 'function') {
      const result = await client.eval(CREATE_JOB_SCRIPT, {
        keys: [hairImportJobRedisKey(input.userId, jobId), hairImportJobIndexKey(input.userId)],
        arguments: [JSON.stringify(job), jobId, JSON.stringify(hairImportJobLiveUploadKeys(job, true))]
      })
      if (result === 'ASSET_UNAVAILABLE') throw new HairImportJobError('WRITE_CONFLICT', 'Hair files are unavailable or being deleted. Retry after cleanup finishes.', 409)
      if (result !== 'CREATED') {
        throw new HairImportJobError('WRITE_CONFLICT', 'Hair import job id already exists.', 409)
      }
      return
    }
    if (await client.json.get(hairImportJobRedisKey(input.userId, jobId))) {
      throw new HairImportJobError('WRITE_CONFLICT', 'Hair import job id already exists.', 409)
    }
    await client.json.set(hairImportJobRedisKey(input.userId, jobId), '$', job)
    await client.sAdd(hairImportJobIndexKey(input.userId), jobId)
  })
  return job
}

async function loadHairImportJob(userId: string, jobId: string) {
  const value = await redis.execute((client: any) =>
    client.json.get(hairImportJobRedisKey(userId, jobId))
  )
  if (!value) throw new HairImportJobError('NOT_FOUND', 'Hair import job was not found.', 404)
  const job = assertJobShape(value)
  if (job.userId !== userId)
    throw new HairImportJobError('FORBIDDEN', 'Hair import job belongs to another user.', 403)
  if (job.jobId !== jobId) throw new HairImportJobError('INVALID_STATE', 'Stored Hair import job does not match its owner key.', 500)
  return job
}

export async function getHairImportJob(userId: string, jobId: string, now = new Date()) {
  const job = await loadHairImportJob(userId, jobId)
  if (isExpired(job, now)) {
    throw new HairImportJobError(
      'INVALID_STATE',
      'Hair import job expired and must be discarded.',
      410
    )
  }
  return job
}

export async function getHairImportJobForCleanup(userId: string, jobId: string) {
  return loadHairImportJob(userId, jobId)
}

export async function replaceHairImportJob(
  current: HairImportJob,
  replacement: Omit<HairImportJob, 'stateVersion' | 'updatedAt' | 'expiresAt'>,
  now = new Date()
) {
  const next: HairImportJob = {
    ...replacement,
    stateVersion: current.stateVersion + 1,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + HAIR_IMPORT_JOB_TTL_SECONDS * 1000).toISOString()
  }
  const result = await redis.execute(async (client: any) => {
    if (typeof client.eval === 'function') {
      return client.eval(REPLACE_JOB_SCRIPT, {
        keys: [hairImportJobRedisKey(current.userId, current.jobId)],
        arguments: [current.userId, String(current.stateVersion), JSON.stringify(next), JSON.stringify(hairImportJobLiveUploadKeys(next))]
      })
    }
    const stored = assertJobShape(
      await client.json.get(hairImportJobRedisKey(current.userId, current.jobId))
    )
    if (stored.userId !== current.userId) return 'FORBIDDEN'
    if (stored.stateVersion !== current.stateVersion || (stored.status === 'cancelled' && next.status !== 'cancelled')) return 'WRITE_CONFLICT'
    await client.json.set(hairImportJobRedisKey(current.userId, current.jobId), '$', next)
    return 'UPDATED'
  })
  if (result === 'ASSET_UNAVAILABLE') throw new HairImportJobError('WRITE_CONFLICT', 'Hair files are unavailable or being deleted. Retry after cleanup finishes.', 409)
  if (result === 'UPDATED') return next
  if (result === 'NOT_FOUND')
    throw new HairImportJobError('NOT_FOUND', 'Hair import job was not found.', 404)
  if (result === 'FORBIDDEN')
    throw new HairImportJobError('FORBIDDEN', 'Hair import job belongs to another user.', 403)
  throw new HairImportJobError(
    'WRITE_CONFLICT',
    'Hair import job changed while this operation was running.',
    409
  )
}

export function hairImportCleanupContext(job: HairImportJob, files: readonly HairImportOwnedFile[],
  mode: HairCleanupContext['mode'] = job.status === 'cancelled' ? 'retired' : 'subset'): HairCleanupContext {
  if (files.some((file) => !job.cleanupFiles.some((owned) => sameHairCleanupFile(file, owned)))) {
    throw new HairImportJobError('INVALID_STATE', 'Hair cleanup subset is not owned by the observed job.', 409)
  }
  return { jobKey: hairImportJobRedisKey(job.userId, job.jobId), stateVersion: job.stateVersion, files, mode }
}

export async function retireHairImportJob(current: HairImportJob): Promise<HairImportJob> {
  if (current.status === 'complete') throw new HairImportJobError('INVALID_STATE', 'Completed Hair imports cannot be discarded.', 409)
  if (current.status === 'cancelled') return current
  return redis.execute(async (client: any) => {
    if (typeof client.eval === 'function') {
      const result = await client.eval(RETIRE_JOB_SCRIPT, { keys: [hairImportJobRedisKey(current.userId, current.jobId)],
        arguments: ['', String(current.stateVersion)] })
      if (typeof result !== 'string' || !result.startsWith('{')) throw new HairImportJobError('WRITE_CONFLICT', 'Hair import changed. Reload before cleanup.', 409)
      return assertJobShape(JSON.parse(result))
    }
    // The existing isolated default fake has no EVAL; production never uses it.
    const stored = assertJobShape(await client.json.get(hairImportJobRedisKey(current.userId, current.jobId)))
    if (stored.stateVersion !== current.stateVersion) throw new HairImportJobError('WRITE_CONFLICT', 'Hair import changed. Reload before cleanup.', 409)
    const next = { ...stored, status: 'cancelled' as const, stateVersion: stored.stateVersion + 1 }
    await client.json.set(hairImportJobRedisKey(current.userId, current.jobId), '$', next)
    return next
  })
}

export async function retireDiscardableHairImportJob(job: HairImportDiscardableJob): Promise<HairCleanupContext> {
  return redis.execute(async (client: any) => {
    const key = hairImportJobRedisKey(job.userId, job.jobId)
    let raw: string
    if (typeof client.eval === 'function') {
      raw = await client.eval(RETIRE_JOB_SCRIPT, { keys: [key], arguments: [job.observedRaw, ''] })
      if (typeof raw !== 'string' || !raw.startsWith('{')) throw new HairImportJobError('WRITE_CONFLICT', 'Hair import changed. Retry pruning.', 409)
    } else {
      const value = await client.json.get(key)
      if (JSON.stringify(value) !== job.observedRaw) throw new HairImportJobError('WRITE_CONFLICT', 'Hair import changed. Retry pruning.', 409)
      const next = { ...value, status: 'cancelled', ...(value.contract === HAIR_IMPORT_JOB_CONTRACT ? { stateVersion: value.stateVersion + 1 } : {}) }
      await client.json.set(key, '$', next)
      raw = JSON.stringify(next)
    }
    const retired = JSON.parse(raw)
    return retired.contract === HAIR_IMPORT_JOB_CONTRACT
      ? { jobKey: key, stateVersion: retired.stateVersion, files: job.cleanupFiles, mode: 'retired' }
      : { jobKey: key, expectedRaw: raw, files: job.cleanupFiles, mode: 'retired' }
  })
}

/** Track a discovered exact subset without rewriting any candidate numbers or
 * arrays. Used only after retirement, with the same observed-record CAS. */
export async function trackRetiredHairCleanupFiles(context: HairCleanupContext, files: readonly HairImportOwnedFile[]): Promise<HairCleanupContext> {
  files.forEach(assertCleanupFileShape)
  if (context.mode !== 'retired') throw new HairImportJobError('INVALID_STATE', 'Hair cleanup owner was not retired.', 409)
  return redis.execute(async (client: any) => {
    const script = `
local raw = redis.call('JSON.GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local job = cjson.decode(raw)
if job.status ~= 'cancelled' then return 'WRITE_CONFLICT' end
if ARGV[1] ~= '' then
  if raw ~= ARGV[1] then return 'WRITE_CONFLICT' end
elseif job.stateVersion ~= tonumber(ARGV[2]) then return 'WRITE_CONFLICT' end
redis.call('JSON.SET', KEYS[1], '.cleanupFiles', ARGV[3])
if job.contract == 'hair-import-job/v4' then redis.call('JSON.NUMINCRBY', KEYS[1], '.stateVersion', 1) end
return redis.call('JSON.GET', KEYS[1])
`
    let raw: string
    if (typeof client.eval === 'function') {
      raw = await client.eval(script, { keys: [context.jobKey], arguments: [context.expectedRaw ?? '', String(context.stateVersion ?? ''), JSON.stringify(files)] })
      if (typeof raw !== 'string' || !raw.startsWith('{')) throw new HairImportJobError('WRITE_CONFLICT', 'Hair cleanup owner changed.', 409)
    } else {
      const job = await client.json.get(context.jobKey)
      if (context.expectedRaw ? JSON.stringify(job) !== context.expectedRaw : job.stateVersion !== context.stateVersion) throw new HairImportJobError('WRITE_CONFLICT', 'Hair cleanup owner changed.', 409)
      const next = { ...job, cleanupFiles: files, ...(job.contract === HAIR_IMPORT_JOB_CONTRACT ? { stateVersion: job.stateVersion + 1 } : {}) }
      await client.json.set(context.jobKey, '$', next)
      raw = JSON.stringify(next)
    }
    const tracked = JSON.parse(raw)
    return tracked.contract === HAIR_IMPORT_JOB_CONTRACT
      ? { jobKey: context.jobKey, stateVersion: tracked.stateVersion, files, mode: 'retired' }
      : { jobKey: context.jobKey, expectedRaw: raw, files, mode: 'retired' }
  })
}

export async function deleteHairImportJobRecord(userId: string, jobId: string, context: HairCleanupContext) {
  await redis.execute(async (client: any) => {
    if (typeof client.eval === 'function') {
      const result = await client.eval(DELETE_JOB_SCRIPT, {
        keys: [hairImportJobRedisKey(userId, jobId), hairImportJobIndexKey(userId)],
        arguments: [jobId, context.expectedRaw ?? '', String(context.stateVersion ?? '')]
      })
      if (result !== 'DELETED') throw new HairImportJobError('WRITE_CONFLICT', 'Hair import changed before cleanup finished. Retry from its current state.', 409)
      return
    }
    const stored = await client.json.get(hairImportJobRedisKey(userId, jobId))
    if (!stored || (context.expectedRaw ? JSON.stringify(stored) !== context.expectedRaw : stored.stateVersion !== context.stateVersion)) {
      throw new HairImportJobError('WRITE_CONFLICT', 'Hair import changed before cleanup finished.', 409)
    }
    await client.del(hairImportJobRedisKey(userId, jobId))
    await client.sRem(hairImportJobIndexKey(userId), jobId)
  })
}

export async function listDiscardableHairImportJobs(userId: string, now = new Date()) {
  return redis.execute(async (client: any) => {
    const jobIds = ((await client.sMembers(hairImportJobIndexKey(userId))) as string[]).sort(
      (left, right) => left.localeCompare(right)
    )
    const discardable: HairImportDiscardableJob[] = []
    for (const jobId of jobIds) {
      const key = hairImportJobRedisKey(userId, jobId)
      const observedRaw = typeof client.sendCommand === 'function'
        ? await client.sendCommand(['JSON.GET', key]) : JSON.stringify(await client.json.get(key))
      const value = observedRaw ? JSON.parse(observedRaw) : null
      if (!value) {
        await client.sRem(hairImportJobIndexKey(userId), jobId)
        continue
      }
      const contract =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>).contract
          : null
      if (contract !== HAIR_IMPORT_JOB_CONTRACT) {
        discardable.push(obsoleteCleanupJob(value, userId, jobId, observedRaw))
        continue
      }
      const job = assertJobShape(value)
      if (job.userId !== userId || job.jobId !== jobId) {
        throw new HairImportJobError(
          'INVALID_STATE',
          `Stored Hair import job ${jobId} does not match its cleanup index.`,
          500
        )
      }
      if (isExpired(job, now) && job.status !== 'complete') {
        discardable.push({
          jobId: job.jobId,
          userId: job.userId,
          cleanupFiles: job.cleanupFiles,
          reason: 'expired',
          observedRaw
        })
      }
    }
    return discardable
  })
}

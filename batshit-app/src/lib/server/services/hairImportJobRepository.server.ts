import { randomUUID } from 'node:crypto'

import { redis } from '$lib/server/redis'
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

export type HairImportOwnedFile = {
  uploadType: 'goon_hair_imports' | 'goon_hair_assets'
  filename: string
  ref: string
  sha256: string
  bytes: number
  mimeType: string
}

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

const CREATE_JOB_SCRIPT = `
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
local current = redis.call('JSON.GET', KEYS[1])
if not current then return 'NOT_FOUND' end
local decoded = cjson.decode(current)
if decoded.userId ~= ARGV[1] then return 'FORBIDDEN' end
if tonumber(decoded.stateVersion) ~= tonumber(ARGV[2]) then return 'WRITE_CONFLICT' end
redis.call('JSON.SET', KEYS[1], '$', ARGV[3])
return 'UPDATED'
`

const DELETE_JOB_SCRIPT = `
local removed = redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return removed
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
    !job.target ||
    (job.target.kind !== 'new' && job.target.kind !== 'refit') ||
    !job.startingTransform ||
    !job.initialTransform ||
    !(
      job.calibration === null ||
      (typeof job.calibration === 'object' && !Array.isArray(job.calibration))
    ) ||
    !Number.isSafeInteger(job.stateVersion) ||
    !Array.isArray(job.cleanupFiles)
  ) {
    throw new HairImportJobError('INVALID_STATE', 'Stored Hair import job is malformed.', 500)
  }
  return job
}

function assertCleanupFileShape(value: unknown): HairImportOwnedFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HairImportJobError('INVALID_STATE', 'Stored Hair import cleanup file is malformed.', 500)
  }
  const file = value as HairImportOwnedFile
  const validUploadType =
    file.uploadType === 'goon_hair_imports' || file.uploadType === 'goon_hair_assets'
  const validFilename =
    typeof file.filename === 'string' &&
    file.filename.length > 0 &&
    !file.filename.includes('/') &&
    !file.filename.includes('\\')
  if (
    !validUploadType ||
    !validFilename ||
    file.ref !== `/uploads/${file.uploadType}/${file.filename}` ||
    typeof file.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    typeof file.mimeType !== 'string' ||
    file.mimeType.length === 0
  ) {
    throw new HairImportJobError('INVALID_STATE', 'Stored Hair import cleanup file is malformed.', 500)
  }
  return file
}

function obsoleteCleanupJob(
  value: unknown,
  expectedUserId: string,
  expectedJobId: string
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
    reason: 'obsolete'
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
        arguments: [JSON.stringify(job), jobId]
      })
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
        arguments: [current.userId, String(current.stateVersion), JSON.stringify(next)]
      })
    }
    const stored = assertJobShape(
      await client.json.get(hairImportJobRedisKey(current.userId, current.jobId))
    )
    if (stored.userId !== current.userId) return 'FORBIDDEN'
    if (stored.stateVersion !== current.stateVersion) return 'WRITE_CONFLICT'
    await client.json.set(hairImportJobRedisKey(current.userId, current.jobId), '$', next)
    return 'UPDATED'
  })
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

export async function deleteHairImportJobRecord(userId: string, jobId: string) {
  await redis.execute(async (client: any) => {
    if (typeof client.eval === 'function') {
      await client.eval(DELETE_JOB_SCRIPT, {
        keys: [hairImportJobRedisKey(userId, jobId), hairImportJobIndexKey(userId)],
        arguments: [jobId]
      })
      return
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
      const value = await client.json.get(hairImportJobRedisKey(userId, jobId))
      if (!value) {
        await client.sRem(hairImportJobIndexKey(userId), jobId)
        continue
      }
      const contract =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>).contract
          : null
      if (contract !== HAIR_IMPORT_JOB_CONTRACT) {
        discardable.push(obsoleteCleanupJob(value, userId, jobId))
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
          reason: 'expired'
        })
      }
    }
    return discardable
  })
}

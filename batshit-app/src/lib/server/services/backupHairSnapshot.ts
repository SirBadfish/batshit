import { hairImportCandidateIds, HAIR_IMPORT_UPLOAD_RECEIPT_CONTRACT } from './hairImportCandidateIdentity'
import { clipHairUploadReferences } from './clipHairReferences'

/** A bounded metadata cut, not a filesystem snapshot or a whole-database transaction. */
export const HAIR_BACKUP_SNAPSHOT_LIMITS = {
  records: 4096,
  bytes: 256 * 1024 * 1024,
  recordBytes: 128 * 1024 * 1024,
  collectionItems: 4096
} as const

export type HairSnapshotRecord = {
  key: string
  type: 'json' | 'string' | 'set' | 'list' | 'hash' | 'zset'
  value: unknown
  ttlSeconds: number | null
}

export function isHairSnapshotKey(key: string) {
  return /^(?:hair_asset:|hair_refit_source:|hair_import_job:|upload:goon_hair_(?:assets|imports):)/.test(key) ||
    /^user:.*:hair_assets$/.test(key)
}

// These are durable Hair owners, not quoted upload URLs in chat/tool text. Memory media
// owns copies in memory-media (memoryMedia.ts), and does not retain source Hair staging.
export const RETAINED_HAIR_OWNER_PATTERNS = [
  'goon:*', 'goon_recipe_document:*', 'goon_recipe_revision:*', 'goon_recipe_job:*',
  'user:*:settings', 'user:*:goons_animation_library', 'clothing_asset:*', 'clip:*'
] as const
export function isRetainedHairOwnerKey(key: string) {
  return /^(?:goon:|goon_recipe_(?:document|revision|job):|clothing_asset:|clip:)/.test(key) ||
    /^user:.*:(?:settings|goons_animation_library)$/.test(key)
}

export function needsHairBackupSnapshot(keys: readonly string[]) {
  return keys.some((key) => /^(?:hair_asset:|hair_refit_source:|upload:goon_hair_(?:assets|imports):)/.test(key) || /^user:.*:hair_assets$/.test(key))
}

// JSON.GET has no path: return its original text, never decode/re-encode a record in Lua.
// The existing family KEYS discovery runs inside this read-only EVAL. Its cost still
// depends on DB keyspace, but captured-data limits never impose an unrelated DB/page ceiling.
export const HAIR_BACKUP_SNAPSHOT_SCRIPT = `
-- BATSHIT_HAIR_BACKUP_SNAPSHOT_V1
local maxRecords, maxBytes, maxItems, maxRecordBytes = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local rows, seen, keys, bytes = {'OK'}, {}, {}, 0
for _, pattern in ipairs({'hair_asset:*', 'hair_refit_source:*', 'hair_import_job:*',
    'upload:goon_hair_assets:*', 'upload:goon_hair_imports:*', 'user:*:hair_assets'}) do
  for _, key in ipairs(redis.call('KEYS', pattern)) do
    if not seen[key] then
      seen[key] = true
      table.insert(keys, key)
      if #keys > maxRecords then return {'LIMIT', 'record count'} end
    end
  end
end
for _, key in ipairs(keys) do
      local kind = redis.call('TYPE', key)['ok']
      local payload
      if kind == 'ReJSON-RL' or kind == 'json' then
        payload = redis.pcall('JSON.GET', key)
        kind = 'json'
      elseif kind == 'string' then payload = redis.pcall('GET', key)
      elseif kind == 'set' or kind == 'list' or kind == 'hash' or kind == 'zset' then
        local sizeCommand = ({set='SCARD', list='LLEN', hash='HLEN', zset='ZCARD'})[kind]
        if redis.call(sizeCommand, key) > maxItems then return {'LIMIT', 'collection items'} end
        if kind == 'set' then payload = redis.pcall('SMEMBERS', key)
        elseif kind == 'list' then payload = redis.pcall('LRANGE', key, 0, -1)
        elseif kind == 'hash' then payload = redis.pcall('HGETALL', key)
        else payload = redis.pcall('ZRANGE', key, 0, -1, 'WITHSCORES') end
      else return {'READ_FAILED', 'unsupported type'} end
      if not payload or (type(payload) == 'table' and payload['err']) then return {'READ_FAILED', 'record read'} end
      local recordBytes = string.len(key)
      if type(payload) == 'table' then
        for _, item in ipairs(payload) do recordBytes = recordBytes + string.len(item) end
      else recordBytes = recordBytes + string.len(payload) end
      if recordBytes > maxRecordBytes then return {'LIMIT', 'single record bytes'} end
      bytes = bytes + recordBytes
      if bytes > maxBytes then return {'LIMIT', 'record bytes'} end
      table.insert(rows, {key, kind, redis.call('TTL', key), payload})
end
return rows
`

export function parseHairBackupSnapshot(answer: unknown): Map<string, HairSnapshotRecord> {
  if (!Array.isArray(answer) || answer[0] !== 'OK') {
    const reason = Array.isArray(answer) ? answer.slice(0, 2).join(': ') : 'invalid reply'
    throw new Error(`Hair backup snapshot could not be captured (${reason}). Retry backup.`)
  }
  const records = new Map<string, HairSnapshotRecord>()
  for (const row of answer.slice(1)) {
    if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== 'string' || !isHairSnapshotKey(row[0]) || records.has(row[0])) {
      throw new Error('Hair backup snapshot returned an invalid record. Retry backup.')
    }
    const [key, type, ttl, raw] = row
    let value: unknown
    if (type === 'json') value = JSON.parse(raw)
    else if (type === 'string') value = raw
    else if (type === 'set') value = [...raw].sort()
    else if (type === 'list') value = raw
    else if (type === 'hash') {
      value = Object.fromEntries(Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2], raw[i * 2 + 1]]))
    } else if (type === 'zset') {
      value = Array.from({ length: raw.length / 2 }, (_, i) => ({ value: raw[i * 2], score: Number(raw[i * 2 + 1]) }))
    } else throw new Error('Hair backup snapshot returned an unsupported type. Retry backup.')
    records.set(key, { key, type, value, ttlSeconds: ttl > 0 ? ttl : null })
  }
  return records
}

export async function readHairBackupSnapshot(client: { eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown> }) {
  if (!client.eval) throw new Error('Hair backup requires atomic Redis snapshot support. Retry backup.')
  const limits = HAIR_BACKUP_SNAPSHOT_LIMITS
  return parseHairBackupSnapshot(await client.eval(HAIR_BACKUP_SNAPSHOT_SCRIPT, {
    keys: [], arguments: [limits.records, limits.bytes, limits.collectionItems, limits.recordBytes].map(String)
  }))
}

function object(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
const stableId = (value: unknown) => typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const artifactId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const ROLES: Record<string, string> = {
  geometry: '.glb', 'follower-definition': '.json', 'physics-definition': '.json', 'material-definition': '.json',
  'neutral-value': '.png', 'highlight-mask': '.png', normal: '.png', roughness: '.png', preview: '.png',
  'import-receipt': '.json', 'fit-receipt': '.json', 'refit-source': '.glb'
}

function cleanupFile(value: unknown) {
  return object(value) && ['goon_hair_assets', 'goon_hair_imports'].includes(value.uploadType) &&
    typeof value.filename === 'string' && /^[^/\\:]+$/.test(value.filename) &&
    value.ref === `/uploads/${value.uploadType}/${value.filename}` && sha(value.sha256) &&
    Number.isSafeInteger(value.bytes) && value.bytes > 0 && typeof value.mimeType === 'string' && value.mimeType.length > 0
}

function uploadIdentity(record: HairSnapshotRecord) {
  const match = /^upload:(goon_hair_assets|goon_hair_imports):([^/\\:]+)$/.exec(record.key)
  const value = record.value
  if (!match || record.type !== 'json' || !object(value) || value.storage !== 'filesystem' ||
      value.uploadType !== match[1] || value.filename !== match[2] ||
      value.relativePath !== `${match[1]}/${match[2]}` || !sha(value.sha256) ||
      !Number.isSafeInteger(value.size) || value.size <= 0) return null
  return { uploadType: match[1], filename: match[2], ref: `/uploads/${match[1]}/${match[2]}`, value }
}

/** Conservative ref walk: a positive retained path or asset identity wins even in legacy metadata. */
export function stagedHairUploadKeys(snapshot: Map<string, HairSnapshotRecord>, retainedRecords: readonly { key?: string; value: unknown }[] = []) {
  const retainedPaths = new Set<string>()
  const retainedAssets = new Set<string>()
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\/uploads\/(goon_hair_assets|goon_hair_imports)\/([^/?#\s"'<>]+)/g)) {
        try { retainedPaths.add(`${match[1]}/${decodeURIComponent(match[2])}`) } catch { /* Invalid URI cannot authorize disposal. */ }
      }
    } else if (Array.isArray(value)) value.forEach(walk)
    else if (object(value)) {
      if (typeof value.assetId === 'string' && typeof value.revisionId === 'string') retainedAssets.add(`${value.assetId}\0${value.revisionId}`)
      Object.values(value).forEach(walk)
    }
  }
  // Already-collected non-Hair archive values only protect; they never prove staging.
  retainedRecords.forEach((record) => walk(record.key?.startsWith('clip:') ? clipHairUploadReferences(record.value) : record.value))
  const jobs = new Map<string, Record<string, any>>()
  for (const record of snapshot.values()) {
    if (record.key.startsWith('upload:')) continue
    if (!record.key.startsWith('hair_import_job:')) {
      // A retained key/index identity also conserves bytes if its legacy value lost refs.
      const revision = /^hair_(?:asset|refit_source):.+:([^:]+):([^:]+)$/.exec(record.key)
      if (revision) retainedAssets.add(`${revision[1]}\0${revision[2]}`)
      if (/^user:.*:hair_assets$/.test(record.key) && record.type === 'set' && Array.isArray(record.value)) {
        for (const member of record.value) {
          if (typeof member !== 'string') continue
          const pair = /^([^@]+)@([^@]+)$/.exec(member)
          if (pair) retainedAssets.add(`${pair[1]}\0${pair[2]}`)
        }
      }
      walk(record.value); continue
    }
    const job = record.value
    if (record.type === 'json' && object(job) && job.contract === 'hair-import-job/v4' &&
        stableId(job.userId) && stableId(job.jobId) && stableId(job.goonId) &&
        object(job.startingTransform) && object(job.initialTransform) && (job.calibration === null || object(job.calibration)) && record.key === `hair_import_job:${job.userId}:${job.jobId}` &&
        ['inspected', 'preparing', 'reviewable', 'finalizing', 'failed', 'cancelled'].includes(job.status) &&
        Number.isSafeInteger(job.stateVersion) && job.stateVersion > 0 && Array.isArray(job.cleanupFiles) && job.cleanupFiles.every(cleanupFile) &&
        object(job.target) && (job.target.kind === 'new' || (job.target.kind === 'refit' &&
          artifactId(job.target.assetId) && artifactId(job.target.revisionId) && Number.isSafeInteger(job.target.revision) && job.target.revision > 0))) {
      const ids = hairImportCandidateIds(job as Parameters<typeof hairImportCandidateIds>[0])
      if (job.candidate !== null && job.candidate !== undefined && (!object(job.candidate) ||
          job.candidate.assetId !== ids.assetId || job.candidate.revisionId !== ids.revisionId)) continue
      jobs.set(record.key, job)
    }
  }
  const omitted = new Set<string>()
  for (const record of snapshot.values()) {
    const upload = uploadIdentity(record)
    if (!upload || retainedPaths.has(`${upload.uploadType}/${upload.filename}`)) continue
    const { value } = upload
    const artifact = value.hairAssetArtifact
    if (object(artifact) && retainedAssets.has(`${artifact.assetId}\0${artifact.revisionId}`)) continue
    if (upload.uploadType === 'goon_hair_imports') {
      const receipt = value.hairImportSource
      const match = /^(\d+)_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([a-f0-9]{64})\.(obj|glb)$/.exec(upload.filename)
      if (object(receipt) && Object.keys(receipt).length === 2 &&
          Object.keys(receipt).every((key) => ['sha256', 'stagedAt'].includes(key)) && match && receipt.sha256 === value.sha256 && match[3] === value.sha256 &&
          typeof receipt.stagedAt === 'string' && Number.isFinite(Date.parse(receipt.stagedAt))) omitted.add(record.key)
      continue
    }
    const cleanupOwned = [...jobs.values()].some((job) => job.cleanupFiles.some((file: unknown) =>
      object(file) && file.uploadType === upload.uploadType && file.filename === upload.filename &&
      file.ref === upload.ref && file.sha256 === value.sha256 && file.bytes === value.size &&
      typeof file.mimeType === 'string' && file.mimeType === value.mimetype))
    if (cleanupOwned) { omitted.add(record.key); continue }
    const receipt = value.hairImportUpload
    if (!object(receipt) || Object.keys(receipt).length !== 9 ||
        Object.keys(receipt).some((key) => !['contract', 'userId', 'jobId', 'assetId', 'revisionId', 'role', 'sha256', 'filename', 'bytes'].includes(key)) ||
        !stableId(receipt.userId) || !stableId(receipt.jobId) || receipt.contract !== HAIR_IMPORT_UPLOAD_RECEIPT_CONTRACT ||
        !object(artifact) || !artifactId(artifact.assetId) || !artifactId(artifact.revisionId) ||
        typeof artifact.role !== 'string' || !ROLES[artifact.role] || artifact.sha256 !== value.sha256 ||
        upload.filename !== `${artifact.assetId}_${artifact.revisionId}_${artifact.role}_${value.sha256}${ROLES[artifact.role]}` ||
        receipt.assetId !== artifact.assetId || receipt.revisionId !== artifact.revisionId || receipt.role !== artifact.role ||
        receipt.filename !== upload.filename || receipt.sha256 !== value.sha256 || receipt.bytes !== value.size) continue
    const job = jobs.get(`hair_import_job:${receipt.userId}:${receipt.jobId}`)
    if (!job || job.userId !== receipt.userId || job.jobId !== receipt.jobId) continue
    const ids = hairImportCandidateIds(job as Parameters<typeof hairImportCandidateIds>[0])
    if (ids.assetId !== artifact.assetId || ids.revisionId !== artifact.revisionId) continue
    if (job.candidate !== null && job.candidate !== undefined && (!object(job.candidate) ||
        job.candidate.assetId !== ids.assetId || job.candidate.revisionId !== ids.revisionId)) continue
    omitted.add(record.key)
  }
  return omitted
}

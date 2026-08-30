import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw, deflateRawSync } from 'node:zlib'

import { unzipSync } from 'fflate/node'
import * as yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'

import { redis } from '$lib/server/redis'
import { reconcileMemoryIndexesAfterRestore } from '$lib/server/services/memory/memoryIndex'
import {
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  parseGoonRecipeJob,
  parseGoonRecipeFitReceipt,
  parseRecipeRevisionEnvelope,
  recipeRevisionIdentity,
  recipeAuthoringRevisionSha256,
  recipeDocumentRedisKey,
  recipeJobRedisKey,
  recipeRevisionBundleSha256,
  recipeRevisionEnvelopeSha256,
  recipeRevisionRedisKey,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  reconcileGoonRecipeFitReceipts,
  verifyGoonRecipeDocument,
  verifyGoonRecipeV2,
  verifyRecipeRevisionEnvelope,
  type GoonRecipeDocument,
  type GoonRecipeJob,
  type GoonRecipeV2,
  type RecipeDocumentRef,
  type RecipeRevisionEnvelope
} from '$lib/goons/recipe'

export const BATSHIT_BACKUP_SCHEMA_VERSION = 1

const MANIFEST_PATH = 'manifest.json'
const LEGACY_REDIS_RECORDS_PATH = 'redis/records.json'
const REDIS_RECORDS_DIR = 'redis/records/'
const UPLOAD_FILE_ROOT = 'files/uploads/'
const DEFAULT_APP_VERSION = '0.0.1'
const UTF8_ZIP_FLAG = 0x0800
const DATA_DESCRIPTOR_FLAG = 0x0008
const DEFLATE_METHOD = 8
const ZIP32_MAX = 0xffffffff
const LOCAL_UPLOAD_URL_FIELDS = new Set([
  'url',
  'displayUrl',
  'localUrl',
  'thumbnailUrl',
  'avatar',
  'avatar_url',
  'imageUrl',
  'image_url'
])
const PROJECT_RESTORE_PATH_FIELDS = new Set([
  'root_path',
  'rootPath',
  'full_path',
  'fullPath',
  'default_workspace_path',
  'defaultWorkspacePath'
])

const SYSTEM_PROMPT_KEYS = [
  'batshit:batshit_mode3_system_prompt',
  'batshit:batshit_mode4_system_prompt',
  'batshit:n8n_mode2_system_prompt',
  'batshit:sub_system_prompt',
  'batshit:subagent_instructions',
  'batshit:tool_guidance_zip_enabled_prompt',
  'batshit:tool_guidance_zip_disabled_prompt',
  'batshit:dynamic_mcp_prompt',
  'batshit:batshit_primary_system_prompt',
  'batshit:n8n_primary_system_prompt',
  'batshit:primary_system_prompt',
  'batshit:system_prompt',
  'batshit:batshit_mode3_system_prompt:last_updated',
  'batshit:batshit_mode4_system_prompt:last_updated',
  'batshit:n8n_mode2_system_prompt:last_updated',
  'batshit:sub_system_prompt:last_updated',
  'batshit:subagent_instructions:last_updated',
  'batshit:tool_guidance_zip_enabled_prompt:last_updated',
  'batshit:tool_guidance_zip_disabled_prompt:last_updated',
  'batshit:dynamic_mcp_prompt:last_updated',
  'batshit:batshit_primary_system_prompt:last_updated',
  'batshit:n8n_primary_system_prompt:last_updated',
  'batshit:primary_system_prompt:last_updated',
  'batshit:system_prompt:last_updated'
] as const

const GROUP_DEFINITIONS = [
  {
    id: 'settings',
    label: 'Settings and Admin preferences',
    classification: 'required',
    description: 'User settings, Admin defaults, Docker MCP settings, project preferences, and icon library preferences.'
  },
  {
    id: 'prompts',
    label: 'Prompt overrides',
    classification: 'required',
    description: 'Editable Batshit system prompts and prompt guidance overrides.'
  },
  {
    id: 'chats',
    label: 'Chats and messages',
    classification: 'required',
    description: 'Sessions, messages, folders, zips, session clips, and execution-viewer snapshots.'
  },
  {
    id: 'agents',
    label: 'Agents, subagents, and groups',
    classification: 'required',
    description: 'Primary agents, subagents, group chats, and agent/subagent assignments.'
  },
  {
    id: 'memory',
    label: 'Agent memory',
    classification: 'required',
    description:
      'Agent memories, graduated history segments, and memory configuration. Search indexes are derived and rebuild automatically after restore.'
  },
  {
    id: 'models',
    label: 'Models and provider settings',
    classification: 'optional',
    description: 'Saved models, custom providers, local AI endpoints, and saved provider keys when explicitly included.'
  },
  {
    id: 'projects',
    label: 'Projects',
    classification: 'required',
    description: 'Project records and file tree preferences. Project source files stay in their existing filesystem locations.'
  },
  {
    id: 'clips',
    label: 'Clips and uploads',
    classification: 'required',
    description: 'User/system clips plus Batshit-owned Redis and filesystem upload assets.'
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    classification: 'required',
    description: 'Artifact records, versions, ordering, runtime storage, and usage metadata.'
  },
  {
    id: 'goons',
    label: 'Goons and Goon assets',
    classification: 'required',
    description: 'Goon records and Batshit-owned uploaded model, animation, room, scene, and closet assets.'
  },
  {
    id: 'icons',
    label: 'Custom icons',
    classification: 'required',
    description: 'Custom icon records, contents, favorites, and recents.'
  },
  {
    id: 'voice',
    label: 'Voice settings',
    classification: 'optional',
    description: 'Voice profiles and engine registry references. Installed local runtimes and model weights are not included.'
  },
  {
    id: 'tools',
    label: 'Tools, MCP gateways, skills, and slash commands',
    classification: 'optional',
    description: 'CLI tools, MCP gateway records, slash commands, and skill metadata.'
  },
  {
    id: 'api-keys',
    label: 'Saved secrets',
    classification: 'secret',
    description: 'Encrypted saved API key records. Excluded from default backups.'
  }
] as const

type BackupGroupId = (typeof GROUP_DEFINITIONS)[number]['id']
type RedisRecordType = 'json' | 'string' | 'set' | 'list' | 'hash' | 'zset'

export interface BackupRedisRecord {
  key: string
  type: RedisRecordType
  value: unknown
  ttlSeconds: number | null
  groupId: BackupGroupId
}

export interface BackupManifest {
  schemaVersion: typeof BATSHIT_BACKUP_SCHEMA_VERSION
  app: {
    name: 'Batshit'
    version: string
  }
  createdAt: string
  source: {
    userId: string
  }
  options: {
    includeSecrets: boolean
  }
  contents: {
    redisRecordCount: number
    fileAssetCount: number
    fileAssetBytes: number
    groups: Array<{
      id: BackupGroupId
      label: string
      classification: string
      recordCount: number
      fileAssetCount: number
      description: string
    }>
  }
  secrets: {
    included: boolean
    excludedRecordCount: number
    redactedFieldCount: number
    redactedPaths: string[]
    warning: string
  }
  externalReferences: string[]
  compatibility: {
    minSchemaVersion: number
    maxSchemaVersion: number
    restoreMode: 'fresh-or-destructive-replace'
  }
}

interface BackupBundle {
  manifest: BackupManifest
  records: BackupRedisRecord[]
  zipEntries: Record<string, Uint8Array>
}

export interface BackupBundleStream {
  manifest: BackupManifest
  stream: ReadableStream<Uint8Array>
  filename: string
}

export interface BackupPreflightSummary {
  ok: true
  manifest: BackupManifest
  redisRecordCount: number
  fileAssetCount: number
  fileAssetBytes: number
  requiresDestructiveConfirmation: boolean
  currentRecordCount: number
  sourceUserId: string
  targetUserId: string
  userRemapRequired: boolean
  warnings: string[]
  stage?: {
    id: string
    filename: string
    archiveBytes: number
    sha256: string
    expiresAt: string
  }
  disk?: {
    requiredBytes: number
    availableBytes: number
    sufficient: boolean
    restoredFileBytes: number
    rollbackBytes: number
    restorePlanBytes: number
  }
}

export interface RestoreResult {
  restored: true
  redisRecordCount: number
  fileAssetCount: number
  fileAssetBytes: number
  sourceUserId: string
  targetUserId: string
  secretsIncluded: boolean
  redactedFieldCount: number
  replacedExistingRecordCount: number
}

export class BackupRestoreError extends Error {
  status: number
  details?: unknown

  constructor(message: string, status = 400, details?: unknown) {
    super(message)
    this.name = 'BackupRestoreError'
    this.status = status
    this.details = details
  }
}

interface CollectOptions {
  includeSecrets: boolean
  userId: string
}

interface RedactionState {
  excludedRecordCount: number
  redactedFieldCount: number
  redactedPaths: Set<string>
}

interface BackupFileAssetBase {
  zipPath: string
  relativePath: string
  byteLength: number
}

interface FilesystemBackupFileAsset extends BackupFileAssetBase {
  source: 'filesystem'
  sourcePath: string
}

interface RedisBase64BackupFileAsset extends BackupFileAssetBase {
  source: 'redis-base64'
  redisKey: string
}

type BackupFileAsset = FilesystemBackupFileAsset | RedisBase64BackupFileAsset

interface ZipMemoryEntry {
  name: string
  data: Uint8Array
}

interface ZipCentralRecord {
  nameBytes: Buffer
  crc: number
  compressedSize: number
  size: number
  localOffset: number
  dosDate: number
  dosTime: number
}

function getAppVersion() {
  return process.env.npm_package_version || DEFAULT_APP_VERSION
}

function resolveUploadsDir() {
  const explicit = process.env.UPLOADS_DIR?.trim()
  if (explicit) return path.resolve(explicit)
  return path.resolve(process.cwd(), '../batshit-server/server/uploads')
}

function resolveBackupStagingDir() {
  const explicit = process.env.BATSHIT_BACKUP_STAGING_DIR?.trim()
  if (explicit) return path.resolve(explicit)
  const runtimeRoot = process.env.BATSHIT_RUNTIME_DATA_DIR?.trim()
  if (runtimeRoot) return path.resolve(runtimeRoot, 'backup-restore-staging')
  return path.resolve(process.cwd(), '../batshit-server/server/data/backup-restore-staging')
}

function toPosixPath(input: string) {
  return input.split(path.sep).join('/')
}

function sanitizeRelativePathPart(value: string) {
  return value.trim().replace(/^\/+|\/+$/g, '')
}

function encodeText(input: string) {
  return new Uint8Array(Buffer.from(input, 'utf8'))
}

function encodeJsonEntry(input: unknown) {
  return encodeText(`${JSON.stringify(input)}\n`)
}

function decodeText(input: Uint8Array) {
  return Buffer.from(input).toString('utf8')
}

const CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < CRC32_TABLE.length; i += 1) {
  let crc = i
  for (let j = 0; j < 8; j += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  CRC32_TABLE[i] = crc >>> 0
}

function crc32Update(crc: number, bytes: Uint8Array) {
  let next = crc >>> 0
  for (const byte of bytes) {
    next = CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8)
  }
  return next >>> 0
}

function crc32(bytes: Uint8Array) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosDate, dosTime }
}

function createZip(entries: Record<string, Uint8Array>) {
  const fileParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const names = Object.keys(entries).sort((left, right) => left.localeCompare(right))
  const { dosDate, dosTime } = getDosDateTime()
  if (names.length > 0xffff) {
    throw new BackupRestoreError(
      'Backup cannot be created because it has too many zip entries for the v1 bundle format.',
      500
    )
  }

  for (const name of names) {
    assertSafeZipPath(name)
    const data = Buffer.from(entries[name])
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 6 })
    const crc = crc32(data)
    if (data.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new BackupRestoreError(
        `Backup entry "${name}" is too large for the v1 bundle format.`,
        500
      )
    }
    if (offset > 0xffffffff) {
      throw new BackupRestoreError('Backup is too large for the v1 bundle format.', 500)
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_ZIP_FLAG, 6)
    local.writeUInt16LE(DEFLATE_METHOD, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    fileParts.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_ZIP_FLAG, 8)
    central.writeUInt16LE(DEFLATE_METHOD, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += local.length + nameBytes.length + compressed.length
    if (offset > 0xffffffff) {
      throw new BackupRestoreError('Backup is too large for the v1 bundle format.', 500)
    }
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  if (centralOffset > 0xffffffff || centralSize > 0xffffffff) {
    throw new BackupRestoreError('Backup is too large for the v1 bundle format.', 500)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return new Uint8Array(Buffer.concat([...fileParts, ...centralParts, end]))
}

function assertZipUint32(value: number, message: string) {
  if (!Number.isFinite(value) || value < 0 || value > ZIP32_MAX) {
    throw new BackupRestoreError(message, 500)
  }
}

function assertSafeZipOffset(value: number, message: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BackupRestoreError(message, 500)
  }
}

function normalizeZipMemoryEntries(entries: Record<string, Uint8Array>) {
  return Object.entries(entries)
    .map(([name, data]) => ({ name, data }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function validateZipInputs(memoryEntries: ZipMemoryEntry[], fileAssets: BackupFileAsset[]) {
  const seen = new Set<string>()
  const count = memoryEntries.length + fileAssets.length
  if (count > 0xffff) {
    throw new BackupRestoreError(
      'Backup cannot be created because it has too many zip entries for the v1 bundle format.',
      500
    )
  }

  for (const entry of memoryEntries) {
    assertSafeZipPath(entry.name)
    if (seen.has(entry.name)) {
      throw new BackupRestoreError(`Backup cannot be created because "${entry.name}" is duplicated.`, 500)
    }
    seen.add(entry.name)
  }

  for (const asset of fileAssets) {
    assertSafeZipPath(asset.zipPath)
    if (seen.has(asset.zipPath)) {
      throw new BackupRestoreError(
        `Backup cannot be created because "${asset.zipPath}" is duplicated.`,
        500
      )
    }
    if (asset.byteLength > ZIP32_MAX) {
      throw new BackupRestoreError(
        `Backup asset "${asset.relativePath}" is too large for one zip entry.`,
        500
      )
    }
    seen.add(asset.zipPath)
  }
}

function createStreamingLocalHeader(nameBytes: Buffer, dosDate: number, dosTime: number) {
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(UTF8_ZIP_FLAG | DATA_DESCRIPTOR_FLAG, 6)
  local.writeUInt16LE(DEFLATE_METHOD, 8)
  local.writeUInt16LE(dosTime, 10)
  local.writeUInt16LE(dosDate, 12)
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(0, 18)
  local.writeUInt32LE(0, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)
  return local
}

function createDataDescriptor(crc: number, compressedSize: number, size: number) {
  assertZipUint32(compressedSize, 'Backup entry is too large for the v1 bundle format.')
  assertZipUint32(size, 'Backup entry is too large for the v1 bundle format.')
  const descriptor = Buffer.alloc(16)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(crc, 4)
  descriptor.writeUInt32LE(compressedSize, 8)
  descriptor.writeUInt32LE(size, 12)
  return descriptor
}

function writeZipUint64(buffer: Buffer, value: number, offset: number) {
  assertSafeZipOffset(value, 'Backup is too large for the zip bundle format.')
  buffer.writeBigUInt64LE(BigInt(value), offset)
}

function createZip64ExtraField(values: number[]) {
  if (values.length === 0) return Buffer.alloc(0)
  const extra = Buffer.alloc(4 + values.length * 8)
  extra.writeUInt16LE(0x0001, 0)
  extra.writeUInt16LE(values.length * 8, 2)
  values.forEach((value, index) => writeZipUint64(extra, value, 4 + index * 8))
  return extra
}

function createCentralEntry(record: ZipCentralRecord) {
  assertZipUint32(record.compressedSize, 'Backup entry is too large for one zip entry.')
  assertZipUint32(record.size, 'Backup entry is too large for one zip entry.')
  const needsZip64Offset = record.localOffset > ZIP32_MAX
  const zip64Extra = createZip64ExtraField(needsZip64Offset ? [record.localOffset] : [])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(needsZip64Offset ? 45 : 20, 6)
  central.writeUInt16LE(UTF8_ZIP_FLAG | DATA_DESCRIPTOR_FLAG, 8)
  central.writeUInt16LE(DEFLATE_METHOD, 10)
  central.writeUInt16LE(record.dosTime, 12)
  central.writeUInt16LE(record.dosDate, 14)
  central.writeUInt32LE(record.crc, 16)
  central.writeUInt32LE(record.compressedSize, 20)
  central.writeUInt32LE(record.size, 24)
  central.writeUInt16LE(record.nameBytes.length, 28)
  central.writeUInt16LE(zip64Extra.length, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(needsZip64Offset ? ZIP32_MAX : record.localOffset, 42)
  return Buffer.concat([central, record.nameBytes, zip64Extra])
}

function createEndOfCentralDirectory(
  count: number,
  centralSize: number,
  centralOffset: number,
  zip64EndOffset: number
) {
  assertSafeZipOffset(centralSize, 'Backup is too large for the zip bundle format.')
  assertSafeZipOffset(centralOffset, 'Backup is too large for the zip bundle format.')
  assertSafeZipOffset(zip64EndOffset, 'Backup is too large for the zip bundle format.')
  const needsZip64 =
    count > 0xffff || centralSize > ZIP32_MAX || centralOffset > ZIP32_MAX || zip64EndOffset > ZIP32_MAX
  const parts: Buffer[] = []

  if (needsZip64) {
    const zip64End = Buffer.alloc(56)
    zip64End.writeUInt32LE(0x06064b50, 0)
    zip64End.writeBigUInt64LE(44n, 4)
    zip64End.writeUInt16LE(45, 12)
    zip64End.writeUInt16LE(45, 14)
    zip64End.writeUInt32LE(0, 16)
    zip64End.writeUInt32LE(0, 20)
    writeZipUint64(zip64End, count, 24)
    writeZipUint64(zip64End, count, 32)
    writeZipUint64(zip64End, centralSize, 40)
    writeZipUint64(zip64End, centralOffset, 48)
    parts.push(zip64End)

    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeUInt32LE(0, 4)
    writeZipUint64(locator, zip64EndOffset, 8)
    locator.writeUInt32LE(1, 16)
    parts.push(locator)
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(Math.min(count, 0xffff), 8)
  end.writeUInt16LE(Math.min(count, 0xffff), 10)
  end.writeUInt32LE(centralSize > ZIP32_MAX ? ZIP32_MAX : centralSize, 12)
  end.writeUInt32LE(centralOffset > ZIP32_MAX ? ZIP32_MAX : centralOffset, 16)
  end.writeUInt16LE(0, 20)
  parts.push(end)
  return parts
}

function toBufferChunk(chunk: unknown) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk))
}

async function readRedisBase64Payload(asset: RedisBase64BackupFileAsset) {
  let raw: unknown
  try {
    raw = await redis.execute(async (client) => {
      const result = await client.json.get(asset.redisKey, { path: '$.base64' })
      return Array.isArray(result) ? result[0] : result
    })
  } catch (error) {
    throw new BackupRestoreError(
      `Backup failed while reading legacy upload asset "${asset.relativePath}" from Redis.`,
      500,
      error instanceof Error ? error.message : null
    )
  }

  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BackupRestoreError(
      `Backup cannot continue because legacy upload asset "${asset.relativePath}" is missing its Base64 payload.`,
      500
    )
  }

  return raw
}

async function createAssetReadStream(asset: BackupFileAsset) {
  if (asset.source === 'filesystem') return createReadStream(asset.sourcePath)
  const base64 = await readRedisBase64Payload(asset)
  return Readable.from(decodeBase64Chunks(base64), { objectMode: false })
}

async function* createZipChunks(
  memoryEntries: ZipMemoryEntry[],
  fileAssets: BackupFileAsset[]
): AsyncGenerator<Buffer> {
  const { dosDate, dosTime } = getDosDateTime()
  const centralRecords: ZipCentralRecord[] = []
  let offset = 0

  function track(chunk: Buffer) {
    offset += chunk.length
    assertSafeZipOffset(offset, 'Backup is too large for the zip bundle format.')
    return chunk
  }

  for (const entry of memoryEntries) {
    const data = Buffer.from(entry.data)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const localOffset = offset
    yield track(createStreamingLocalHeader(nameBytes, dosDate, dosTime))
    yield track(nameBytes)

    const compressed = deflateRawSync(data, { level: 6 })
    const crc = crc32(data)
    yield track(compressed)
    yield track(createDataDescriptor(crc, compressed.length, data.length))
    centralRecords.push({
      nameBytes,
      crc,
      compressedSize: compressed.length,
      size: data.length,
      localOffset,
      dosDate,
      dosTime
    })
  }

  for (const asset of fileAssets) {
    const nameBytes = Buffer.from(asset.zipPath, 'utf8')
    const localOffset = offset
    yield track(createStreamingLocalHeader(nameBytes, dosDate, dosTime))
    yield track(nameBytes)

    let crc = 0xffffffff
    let size = 0
    let compressedSize = 0
    const source = await createAssetReadStream(asset)
    source.on('data', (chunk: Buffer | Uint8Array) => {
      const bytes = toBufferChunk(chunk)
      crc = crc32Update(crc, bytes)
      size += bytes.length
    })

    const compressed = source.pipe(createDeflateRaw({ level: 6 }))
    try {
      for await (const chunk of compressed) {
        const buffer = toBufferChunk(chunk)
        compressedSize += buffer.length
        assertZipUint32(compressedSize, `Backup asset "${asset.relativePath}" is too large for one zip entry.`)
        yield track(buffer)
      }
    } catch (error) {
      if (error instanceof BackupRestoreError) throw error
      throw new BackupRestoreError(
        `Backup failed while streaming upload asset "${asset.relativePath}".`,
        500,
        error instanceof Error ? error.message : null
      )
    }

    if (size !== asset.byteLength) {
      throw new BackupRestoreError(
        `Backup asset "${asset.relativePath}" changed while the export was running. Try the export again.`,
        409
      )
    }

    const finalizedCrc = (crc ^ 0xffffffff) >>> 0
    yield track(createDataDescriptor(finalizedCrc, compressedSize, size))
    centralRecords.push({
      nameBytes,
      crc: finalizedCrc,
      compressedSize,
      size,
      localOffset,
      dosDate,
      dosTime
    })
  }

  const centralOffset = offset
  for (const record of centralRecords) {
    yield track(createCentralEntry(record))
  }
  const centralSize = offset - centralOffset
  for (const part of createEndOfCentralDirectory(centralRecords.length, centralSize, centralOffset, offset)) {
    yield track(part)
  }
}

function createZipReadableStream(entries: Record<string, Uint8Array>, fileAssets: BackupFileAsset[]) {
  const memoryEntries = normalizeZipMemoryEntries(entries)
  const sortedFileAssets = [...fileAssets].sort((left, right) => left.zipPath.localeCompare(right.zipPath))
  validateZipInputs(memoryEntries, sortedFileAssets)
  return Readable.toWeb(Readable.from(createZipChunks(memoryEntries, sortedFileAssets), { objectMode: false }))
}

function assertSafeZipPath(name: string) {
  if (!name || name.startsWith('/') || name.includes('\\')) {
    throw new BackupRestoreError(`Backup contains an unsafe path: ${name}`, 400)
  }
  const parts = name.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new BackupRestoreError(`Backup contains an unsafe path: ${name}`, 400)
  }
}

function safeJoin(root: string, relativePath: string) {
  const normalized = path.normalize(relativePath)
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new BackupRestoreError(`Backup contains an unsafe file asset path: ${relativePath}`, 400)
  }
  const resolved = path.resolve(root, normalized)
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new BackupRestoreError(`Backup file asset escapes the upload directory: ${relativePath}`, 400)
  }
  return resolved
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeBase64Payload(value: string) {
  const payload = value.includes(',') && value.slice(0, value.indexOf(',')).includes('base64')
    ? value.slice(value.indexOf(',') + 1)
    : value
  return payload.replace(/\s+/g, '')
}

function decodedBase64ByteLength(value: string) {
  const base64 = normalizeBase64Payload(value)
  if (!base64) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function* decodeBase64Chunks(value: string) {
  const base64 = normalizeBase64Payload(value)
  const chunkChars = 1024 * 1024
  let index = 0
  while (index < base64.length) {
    let end = Math.min(index + chunkChars, base64.length)
    if (end < base64.length) {
      end -= (end - index) % 4
    }
    if (end <= index) end = Math.min(index + 4, base64.length)
    const chunk = Buffer.from(base64.slice(index, end), 'base64')
    if (chunk.byteLength > 0) yield chunk
    index = end
  }
}

function isJsonRedisType(type: string) {
  const normalized = type.toLowerCase()
  return normalized === 'rejson-rl' || normalized === 'json'
}

function normalizeRedisType(type: string): RedisRecordType | null {
  if (isJsonRedisType(type)) return 'json'
  if (type === 'string') return 'string'
  if (type === 'set') return 'set'
  if (type === 'list') return 'list'
  if (type === 'hash') return 'hash'
  if (type === 'zset') return 'zset'
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSecretFieldName(name: string) {
  const compact = name.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (
    [
      'apikey',
      'apitoken',
      'authtoken',
      'bearertoken',
      'credential',
      'credentials',
      'encrypted',
      'iv',
      'password',
      'secret',
      'token',
      'authtag'
    ].includes(compact)
  ) {
    return true
  }
  return (
    compact.includes('apikey') ||
    compact.endsWith('apikey') ||
    compact.endsWith('secret') ||
    compact.endsWith('password') ||
    compact.endsWith('credential') ||
    compact.endsWith('credentials') ||
    compact.endsWith('token') ||
    compact.endsWith('auth') ||
    compact.endsWith('authtag') ||
    compact.endsWith('authtoken') ||
    compact.endsWith('bearertoken') ||
    compact.includes('encrypted')
  )
}

function isSecretRecordKey(key: string, userId: string) {
  return key.startsWith(`api_keys:${userId}:`)
}

function redactSecretFields(
  key: string,
  value: unknown,
  state: RedactionState,
  pathParts: string[] = []
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactSecretFields(key, entry, state, [...pathParts, String(index)]))
  }

  if (!isPlainObject(value)) return value

  const next: Record<string, unknown> = {}
  for (const [field, fieldValue] of Object.entries(value)) {
    const nextPath = [...pathParts, field]
    if (fieldValue !== null && fieldValue !== undefined && isSecretFieldName(field)) {
      next[field] = null
      state.redactedFieldCount += 1
      state.redactedPaths.add(`${key}.${nextPath.join('.')}`)
      continue
    }
    next[field] = redactSecretFields(key, fieldValue, state, nextPath)
  }

  return next
}

function remapUserValue(value: unknown, sourceUserId: string, targetUserId: string): unknown {
  if (sourceUserId === targetUserId) return value

  if (Array.isArray(value)) {
    return value.map((entry) => remapUserValue(entry, sourceUserId, targetUserId))
  }

  if (!isPlainObject(value)) {
    if (value === `settings_${sourceUserId}`) return `settings_${targetUserId}`
    if (typeof value === 'string') {
      for (const prefix of [
        'goon_recipe_revision:',
        'goon_recipe_document:',
        'goon_recipe_job:'
      ]) {
        const sourcePrefix = `${prefix}${sourceUserId}:`
        if (value.startsWith(sourcePrefix)) {
          return `${prefix}${targetUserId}:${value.slice(sourcePrefix.length)}`
        }
      }
    }
    return value
  }

  const next: Record<string, unknown> = {}
  for (const [field, fieldValue] of Object.entries(value)) {
    if (
      typeof fieldValue === 'string' &&
      fieldValue === sourceUserId &&
      ['user_id', 'userId', 'owner_id', 'ownerId'].includes(field)
    ) {
      next[field] = targetUserId
      continue
    }
    if (field === 'id' && fieldValue === `settings_${sourceUserId}`) {
      next[field] = `settings_${targetUserId}`
      continue
    }
    next[field] = remapUserValue(fieldValue, sourceUserId, targetUserId)
  }
  return next
}

function remapUserKey(key: string, sourceUserId: string, targetUserId: string) {
  if (sourceUserId === targetUserId) return key

  const replacements: Array<[string, string]> = [
    [`user:${sourceUserId}:`, `user:${targetUserId}:`],
    [`folder:${sourceUserId}:`, `folder:${targetUserId}:`],
    [`project:${sourceUserId}:`, `project:${targetUserId}:`],
    [`project_prefs:${sourceUserId}`, `project_prefs:${targetUserId}`],
    [`api_keys:${sourceUserId}:`, `api_keys:${targetUserId}:`],
    [`custom_provider:${sourceUserId}:`, `custom_provider:${targetUserId}:`],
    [`local_provider:${sourceUserId}:`, `local_provider:${targetUserId}:`],
    [`artifact_runtime_storage:${sourceUserId}:`, `artifact_runtime_storage:${targetUserId}:`],
    [`icon:${sourceUserId}:`, `icon:${targetUserId}:`],
    [`icon_library:${sourceUserId}:`, `icon_library:${targetUserId}:`],
    [`clip:${sourceUserId}:`, `clip:${targetUserId}:`],
    [`mcp_gateways:${sourceUserId}`, `mcp_gateways:${targetUserId}`],
    [`cli_tool_registry:${sourceUserId}`, `cli_tool_registry:${targetUserId}`],
    [`slash_command:${sourceUserId}:`, `slash_command:${targetUserId}:`],
    [`skill:${sourceUserId}:`, `skill:${targetUserId}:`],
    [`goon_recipe_revision:${sourceUserId}:`, `goon_recipe_revision:${targetUserId}:`],
    [`goon_recipe_document:${sourceUserId}:`, `goon_recipe_document:${targetUserId}:`],
    [`goon_recipe_job:${sourceUserId}:`, `goon_recipe_job:${targetUserId}:`],
    [`hair_asset:${sourceUserId}:`, `hair_asset:${targetUserId}:`],
    [`hair_refit_source:${sourceUserId}:`, `hair_refit_source:${targetUserId}:`],
    [`clothing_asset:${sourceUserId}:`, `clothing_asset:${targetUserId}:`],
    [`voice_engine_registry:${sourceUserId}`, `voice_engine_registry:${targetUserId}`],
    [`user_artifact_usage:${sourceUserId}`, `user_artifact_usage:${targetUserId}`]
  ]

  for (const [from, to] of replacements) {
    if (key.startsWith(from)) {
      return `${to}${key.slice(from.length)}`
    }
  }

  return key
}

function isContainerizedRuntime() {
  return process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
}

function getContainerWorkspaceRoot() {
  return path.resolve(process.env.BATSHIT_CODEX_WORKDIR?.trim() || '/workspace')
}

function isUnderPath(candidatePath: string, rootPath: string) {
  const resolvedCandidate = path.resolve(candidatePath)
  const resolvedRoot = path.resolve(rootPath)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
}

function shouldRewriteProjectPathForContainer(value: unknown, workspaceRoot = getContainerWorkspaceRoot()) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    path.isAbsolute(value.trim()) &&
    !isUnderPath(value.trim(), workspaceRoot)
  )
}

function replaceProjectPathStrings(
  value: unknown,
  replacements: Array<{ from: string; to: string }>
): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    for (const replacement of replacements) {
      if (trimmed === replacement.from) return replacement.to
      if (trimmed.startsWith(`${replacement.from}${path.sep}`)) {
        return `${replacement.to}${trimmed.slice(replacement.from.length)}`
      }
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => replaceProjectPathStrings(entry, replacements))
  }

  if (!isPlainObject(value)) return value

  const next: Record<string, unknown> = {}
  for (const [field, fieldValue] of Object.entries(value)) {
    next[field] = replaceProjectPathStrings(fieldValue, replacements)
  }
  return next
}

function rewriteContainerProjectPaths(key: string, value: unknown, targetUserId: string): unknown {
  if (!isContainerizedRuntime() || !isPlainObject(value)) return value
  if (!(key.startsWith(`project:${targetUserId}:`) || key === `project_prefs:${targetUserId}`)) {
    return value
  }

  const workspaceRoot = getContainerWorkspaceRoot()
  const replacements: Array<{ from: string; to: string }> = []
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!PROJECT_RESTORE_PATH_FIELDS.has(field)) continue
    if (!shouldRewriteProjectPathForContainer(fieldValue, workspaceRoot)) continue
    const from = path.resolve(String(fieldValue).trim())
    if (!replacements.some((entry) => entry.from === from)) {
      replacements.push({ from, to: workspaceRoot })
    }
  }

  return replacements.length > 0 ? replaceProjectPathStrings(value, replacements) : value
}

function groupForKey(key: string, userId: string): BackupGroupId {
  if (SYSTEM_PROMPT_KEYS.includes(key as (typeof SYSTEM_PROMPT_KEYS)[number])) return 'prompts'
  if (
    key === `user:${userId}:settings` ||
    key === `project_prefs:${userId}` ||
    key === `icon_library:${userId}:prefs` ||
    key === 'system:settings:docker-mcp'
  ) {
    return 'settings'
  }
  if (key.startsWith(`api_keys:${userId}:`)) return 'api-keys'
  if (
    key.startsWith(`user:${userId}:agents`) ||
    key.startsWith(`user:${userId}:subagents`) ||
    key.startsWith(`user:${userId}:groups`) ||
    key.startsWith('agent:') ||
    key.startsWith('subagent:') ||
    key.startsWith('group:')
  ) {
    return 'agents'
  }
  if (
    key.startsWith(`user:${userId}:models`) ||
    key.startsWith('model:') ||
    key.startsWith(`local_provider:${userId}:`) ||
    key === `user:${userId}:local_providers` ||
    key.startsWith(`custom_provider:${userId}:`) ||
    key === `user:${userId}:custom_providers`
  ) {
    return 'models'
  }
  if (key.startsWith(`project:${userId}:`)) return 'projects'
  if (
    key.startsWith(`clip:${userId}:`) ||
    key.startsWith('clip:system:') ||
    key === `user:${userId}:clips` ||
    key === 'user:system:clips' ||
    key.startsWith('clip_usage:') ||
    key.startsWith('upload:')
  ) {
    return 'clips'
  }
  if (
    key.startsWith('artifact:') ||
    key.startsWith('artifact_usage:') ||
    key === `user_artifact_usage:${userId}` ||
    key === `user:${userId}:artifacts` ||
    key.startsWith(`user:${userId}:artifact_order:`) ||
    key.startsWith(`artifact_runtime_storage:${userId}:`)
  ) {
    return 'artifacts'
  }
  if (
    key === `user:${userId}:goons` ||
    key === `user:${userId}:hair_assets` ||
    key === `user:${userId}:clothing_assets` ||
    key.startsWith('goon:') ||
    key.startsWith(`hair_asset:${userId}:`) ||
    key.startsWith(`hair_refit_source:${userId}:`) ||
    key.startsWith(`clothing_asset:${userId}:`) ||
    key.startsWith(`goon_recipe_revision:${userId}:`) ||
    key.startsWith(`goon_recipe_document:${userId}:`) ||
    key.startsWith(`goon_recipe_job:${userId}:`)
  ) {
    return 'goons'
  }
  if (
    key === `user:${userId}:icons` ||
    key.startsWith(`icon:${userId}:`) ||
    key === `icon_library:${userId}:prefs`
  ) {
    return 'icons'
  }
  if (
    key === `user:${userId}:voice_profiles` ||
    key.startsWith('voice_profile:') ||
    key === `voice_engine_registry:${userId}`
  ) {
    return 'voice'
  }
  if (
    key === `mcp_gateways:${userId}` ||
    key === `cli_tool_registry:${userId}` ||
    key.startsWith(`slash_command:${userId}:`) ||
    key.startsWith(`skill:${userId}:`)
  ) {
    return 'tools'
  }
  if (
    key.startsWith('memory:') ||
    key.startsWith('memseg:') ||
    key.startsWith('memdream:') ||
    key.startsWith('memdream_index:') ||
    key.startsWith('episode:') ||
    key.startsWith('memlinger:') ||
    /^session:[^:]+:episodes$/.test(key) ||
    key === 'batshit:memory_config' ||
    key === 'batshit:memory_index_meta'
  ) {
    return 'memory'
  }
  return 'chats'
}

function isRestorableKeyForUser(key: string, userId: string) {
  if (SYSTEM_PROMPT_KEYS.includes(key as (typeof SYSTEM_PROMPT_KEYS)[number])) return true
  if (key === 'system:settings:docker-mcp') return true
  if (key === 'batshit:memory_config' || key === 'batshit:memory_index_meta') return true

  const exactKeys = new Set([
    `user:${userId}:settings`,
    `user:${userId}:sessions`,
    `user:${userId}:folders`,
    `user:${userId}:default_folder`,
    `user:${userId}:agents`,
    `user:${userId}:subagents`,
    `user:${userId}:groups`,
    `user:${userId}:models`,
    `user:${userId}:clips`,
    `user:${userId}:goons`,
    `user:${userId}:hair_assets`,
    `user:${userId}:clothing_assets`,
    `user:${userId}:icons`,
    `user:${userId}:artifacts`,
    `user:${userId}:voice_profiles`,
    `user:${userId}:local_providers`,
    `user:${userId}:custom_providers`,
    `user_artifact_usage:${userId}`,
    `project_prefs:${userId}`,
    `icon_library:${userId}:prefs`,
    `voice_engine_registry:${userId}`,
    `mcp_gateways:${userId}`,
    `cli_tool_registry:${userId}`,
    'user:system:clips'
  ])
  if (exactKeys.has(key)) return true

  const userPrefixes = [
    `folder:${userId}:`,
    `project:${userId}:`,
    `api_keys:${userId}:`,
    `custom_provider:${userId}:`,
    `local_provider:${userId}:`,
    `clip:${userId}:`,
    `artifact_runtime_storage:${userId}:`,
    `icon:${userId}:`,
    `slash_command:${userId}:`,
    `skill:${userId}:`,
    `goon_recipe_revision:${userId}:`,
    `goon_recipe_document:${userId}:`,
    `goon_recipe_job:${userId}:`,
    `hair_asset:${userId}:`,
    `hair_refit_source:${userId}:`,
    `clothing_asset:${userId}:`
  ]
  if (userPrefixes.some((prefix) => key.startsWith(prefix))) return true

  const globalEntityPrefixes = [
    'session:',
    'messages:',
    'message:',
    'zip:',
    'zip_temp:',
    'zip_temp_meta:',
    'unzipped:',
    'unzipped_item:',
    'rezipped:',
    'rezipped_item:',
    'session_clip:',
    'subagent_sessions:',
    'pins:',
    'agent:',
    'subagent:',
    'group:',
    'model:',
    'upload:',
    'clip:system:',
    'clip_usage:',
    'artifact:',
    'artifact_usage:',
    'goon:',
    'voice_profile:',
    'memory:',
    'memseg:',
    'memdream:',
    'memdream_index:',
    'episode:',
    'memlinger:'
  ]

  return globalEntityPrefixes.some((prefix) => key.startsWith(prefix))
}

function isDefinitelyRuntimeOnlyKey(key: string) {
  return (
    key.startsWith('user_session:') ||
    key.startsWith('email:') ||
    key === 'users:all' ||
    key === 'user:admin' ||
    key.startsWith('ratelimit:') ||
    key.startsWith('artifact_runtime_token:') ||
    key.startsWith('tool_approval:') ||
    key.startsWith('codex_bridge:')
  )
}

async function readRedisRecord(client: any, key: string, groupId: BackupGroupId): Promise<BackupRedisRecord | null> {
  const type = normalizeRedisType(await client.type(key))
  if (!type) return null

  let value: unknown
  if (type === 'json') {
    const raw = await client.json.get(key)
    value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw
  } else if (type === 'string') {
    value = await client.get(key)
  } else if (type === 'set') {
    value = (await client.sMembers(key)).sort()
  } else if (type === 'list') {
    value = await client.lRange(key, 0, -1)
  } else if (type === 'hash') {
    value = await client.hGetAll(key)
  } else if (type === 'zset') {
    value = await client.zRangeWithScores(key, 0, -1)
  }

  const ttl = await client.ttl(key)
  return {
    key,
    type,
    value,
    ttlSeconds: ttl > 0 ? ttl : null,
    groupId
  }
}

async function addExistingKey(keys: Set<string>, client: any, key: string) {
  if (isDefinitelyRuntimeOnlyKey(key)) return
  if ((await client.exists(key)) === 1) keys.add(key)
}

async function addPatternKeys(keys: Set<string>, client: any, pattern: string) {
  const matches = await client.keys(pattern)
  for (const key of matches) {
    if (!isDefinitelyRuntimeOnlyKey(key)) keys.add(key)
  }
}

async function safeSetMembers(client: any, key: string) {
  try {
    if ((await client.exists(key)) !== 1) return []
    const type = await client.type(key)
    if (type !== 'set') return []
    return await client.sMembers(key)
  } catch {
    return []
  }
}

async function collectCandidateKeys(client: any, userId: string) {
  const keys = new Set<string>()
  const sessionIds = await safeSetMembers(client, `user:${userId}:sessions`)
  const agentIds = await safeSetMembers(client, `user:${userId}:agents`)
  const subagentIds = await safeSetMembers(client, `user:${userId}:subagents`)
  const groupIds = await safeSetMembers(client, `user:${userId}:groups`)
  const folderIds = await safeSetMembers(client, `user:${userId}:folders`)
  const modelIds = await safeSetMembers(client, `user:${userId}:models`)
  const clipIds = await safeSetMembers(client, `user:${userId}:clips`)
  const artifactIds = await safeSetMembers(client, `user:${userId}:artifacts`)
  const goonIds = await safeSetMembers(client, `user:${userId}:goons`)
  const voiceProfileIds = await safeSetMembers(client, `user:${userId}:voice_profiles`)

  for (const key of [
    `user:${userId}:settings`,
    `user:${userId}:sessions`,
    `user:${userId}:folders`,
    `user:${userId}:default_folder`,
    `user:${userId}:agents`,
    `user:${userId}:subagents`,
    `user:${userId}:groups`,
    `user:${userId}:models`,
    `user:${userId}:clips`,
    `user:${userId}:goons`,
    `user:${userId}:hair_assets`,
    `user:${userId}:clothing_assets`,
    `user:${userId}:icons`,
    `user:${userId}:artifacts`,
    `user:${userId}:voice_profiles`,
    `user:${userId}:local_providers`,
    `user:${userId}:custom_providers`,
    `project_prefs:${userId}`,
    `icon_library:${userId}:prefs`,
    `voice_engine_registry:${userId}`,
    `mcp_gateways:${userId}`,
    `cli_tool_registry:${userId}`,
    `user_artifact_usage:${userId}`,
    'user:system:clips',
    'system:settings:docker-mcp',
    'batshit:memory_config',
    'batshit:memory_index_meta',
    ...SYSTEM_PROMPT_KEYS
  ]) {
    await addExistingKey(keys, client, key)
  }

  for (const sessionId of sessionIds) {
    for (const key of [
      `session:${sessionId}`,
      `messages:${sessionId}`,
      `session:${sessionId}:messages`,
      `session:${sessionId}:zips`,
      `session:${sessionId}:execution_log`,
      `session:${sessionId}:clips`,
      `session:${sessionId}:clip_state`,
      `session:${sessionId}:active_clips`,
      `unzipped:${sessionId}`,
      `rezipped:${sessionId}`,
      `pins:${sessionId}`,
      `session:${sessionId}:episodes`,
      `memlinger:${sessionId}`
    ]) {
      await addExistingKey(keys, client, key)
    }
    await addPatternKeys(keys, client, `episode:${sessionId}:*`)
    await addPatternKeys(keys, client, `message:${sessionId}:*`)
    await addPatternKeys(keys, client, `session_clip:${sessionId}:*`)
    await addPatternKeys(keys, client, `subagent_sessions:${sessionId}:subagent:*`)
    await addPatternKeys(keys, client, `unzipped_item:${sessionId}:*`)
    await addPatternKeys(keys, client, `rezipped_item:${sessionId}:*`)
    await addPatternKeys(keys, client, `zip_temp:${sessionId}:*`)
    await addPatternKeys(keys, client, `zip_temp_meta:${sessionId}:*`)
  }

  for (const folderId of folderIds) {
    await addExistingKey(keys, client, `folder:${userId}:${folderId}`)
    await addExistingKey(keys, client, `folder:${userId}:${folderId}:sessions`)
  }

  for (const agentId of agentIds) {
    await addExistingKey(keys, client, `agent:${agentId}`)
    await addExistingKey(keys, client, `agent:${agentId}:subagents`)
    await addPatternKeys(keys, client, `memory:${agentId}:*`)
    await addPatternKeys(keys, client, `memseg:${agentId}:*`)
    await addPatternKeys(keys, client, `memdream:${agentId}:*`)
    await addExistingKey(keys, client, `memdream_index:${agentId}`)
  }

  for (const subagentId of subagentIds) {
    await addExistingKey(keys, client, `subagent:${subagentId}`)
  }

  for (const groupId of groupIds) {
    await addExistingKey(keys, client, `group:${groupId}`)
  }

  for (const modelId of modelIds) {
    await addExistingKey(keys, client, `model:${modelId}`)
  }

  for (const clipId of clipIds) {
    await addExistingKey(keys, client, `clip:${userId}:${clipId}`)
    await addExistingKey(keys, client, `clip_usage:${clipId}`)
  }

  for (const artifactId of artifactIds) {
    await addExistingKey(keys, client, `artifact:${artifactId}`)
    await addExistingKey(keys, client, `artifact_runtime_storage:${userId}:${artifactId}`)
  }

  for (const goonId of goonIds) {
    await addExistingKey(keys, client, `goon:${goonId}`)
  }

  for (const profileId of voiceProfileIds) {
    await addExistingKey(keys, client, `voice_profile:${profileId}`)
  }

  await addPatternKeys(keys, client, `api_keys:${userId}:*`)
  await addPatternKeys(keys, client, `custom_provider:${userId}:*`)
  await addPatternKeys(keys, client, `local_provider:${userId}:*`)
  await addPatternKeys(keys, client, `project:${userId}:*`)
  await addPatternKeys(keys, client, `icon:${userId}:*`)
  await addPatternKeys(keys, client, `user:${userId}:artifact_order:*`)
  await addPatternKeys(keys, client, `slash_command:${userId}:*`)
  await addPatternKeys(keys, client, `skill:${userId}:*`)
  await addPatternKeys(keys, client, `goon_recipe_revision:${userId}:*`)
  await addPatternKeys(keys, client, `goon_recipe_document:${userId}:*`)
  await addPatternKeys(keys, client, `goon_recipe_job:${userId}:*`)
  await addPatternKeys(keys, client, `hair_asset:${userId}:*`)
  await addPatternKeys(keys, client, `hair_refit_source:${userId}:*`)
  await addPatternKeys(keys, client, `clothing_asset:${userId}:*`)
  await addPatternKeys(keys, client, 'clip:system:*')
  await addPatternKeys(keys, client, 'upload:*')
  await addPatternKeys(keys, client, 'zip:*')
  await addPatternKeys(keys, client, 'artifact_usage:*')

  return Array.from(keys)
    .filter((key) => isRestorableKeyForUser(key, userId))
    .sort((left, right) => left.localeCompare(right))
}

function normalizeRecordForExport(
  record: BackupRedisRecord,
  options: CollectOptions,
  redactions: RedactionState
): BackupRedisRecord | null {
  if (!options.includeSecrets && isSecretRecordKey(record.key, options.userId)) {
    redactions.excludedRecordCount += 1
    redactions.redactedPaths.add(record.key)
    return null
  }

  if (options.includeSecrets) return record

  return {
    ...record,
    value: redactSecretFields(record.key, cloneJson(record.value), redactions)
  }
}

async function collectRedisRecords(options: CollectOptions) {
  const redactions: RedactionState = {
    excludedRecordCount: 0,
    redactedFieldCount: 0,
    redactedPaths: new Set()
  }
  const redisBase64Assets: RedisBase64BackupFileAsset[] = []

  const records = await redis.execute(async (client) => {
    const keys = await collectCandidateKeys(client, options.userId)
    const collected: BackupRedisRecord[] = []
    for (const key of keys) {
      const record = await readRedisRecord(client, key, groupForKey(key, options.userId))
      if (!record) continue
      const normalized = normalizeRecordForExport(record, options, redactions)
      if (normalized) {
        const uploadNormalized = normalizeUploadRecordForExport(normalized)
        if (uploadNormalized.redisBase64Asset) redisBase64Assets.push(uploadNormalized.redisBase64Asset)
        collected.push(uploadNormalized.record)
      }
    }
    return collected
  })

  return { records, redactions, redisBase64Assets }
}

function normalizeUploadRelativePath(value: unknown) {
  if (!isPlainObject(value)) return null
  const raw = typeof value.relativePath === 'string' ? value.relativePath.trim() : ''
  return raw.length > 0 ? toPosixPath(raw) : null
}

function isFilesystemBackedUploadValue(value: Record<string, unknown>) {
  return (
    value.storage === 'filesystem' ||
    value.storageMode === 'local' ||
    value.uploadStrategy === 'local' ||
    typeof value.filePath === 'string'
  )
}

function uploadRelativePathFromKey(key: string) {
  if (!key.startsWith('upload:')) return null
  const parts = key
    .slice('upload:'.length)
    .split(':')
    .map(sanitizeRelativePathPart)
    .filter(Boolean)
  return parts.length >= 2 ? toPosixPath(parts.join('/')) : null
}

function buildUploadRelativePathIndex(records: BackupRedisRecord[]) {
  const byBasename = new Map<string, string>()
  for (const record of records) {
    if (!record.key.startsWith('upload:')) continue
    const relativePath = uploadRelativePathForExport(record)
    if (!relativePath) continue
    const basename = path.posix.basename(relativePath)
    if (!byBasename.has(basename)) byBasename.set(basename, relativePath)
  }
  return byBasename
}

function uploadPathFromString(value: string, uploadRelativePathByBasename: Map<string, string>) {
  const trimmed = value.trim()
  if (!trimmed) return null

  let pathname: string | null = null
  if (trimmed.startsWith('/uploads/')) {
    pathname = trimmed
  } else {
    try {
      const parsed = new URL(trimmed)
      pathname = parsed.pathname.startsWith('/uploads/') ? parsed.pathname : null
    } catch {
      pathname = null
    }
  }

  if (!pathname) return null
  const basename = path.posix.basename(pathname)
  const indexedRelativePath = uploadRelativePathByBasename.get(basename)
  return indexedRelativePath ? `/uploads/${indexedRelativePath}` : pathname
}

function rewriteLocalUploadUrlFields(
  value: unknown,
  uploadRelativePathByBasename: Map<string, string>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteLocalUploadUrlFields(item, uploadRelativePathByBasename))
  }
  if (!isPlainObject(value)) return value

  const next: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, raw]) => [
      key,
      rewriteLocalUploadUrlFields(raw, uploadRelativePathByBasename)
    ])
  )
  const explicitRelativePath = normalizeUploadRelativePath(next)
  const explicitUploadPath = explicitRelativePath ? `/uploads/${explicitRelativePath}` : null
  const rewritePath = (raw: unknown) => {
    if (typeof raw !== 'string') return explicitUploadPath
    return uploadPathFromString(raw, uploadRelativePathByBasename) ?? explicitUploadPath
  }

  for (const [key, raw] of Object.entries(value)) {
    if (!LOCAL_UPLOAD_URL_FIELDS.has(key) || typeof raw !== 'string') continue
    const uploadPath = rewritePath(raw)
    if (uploadPath) next[key] = uploadPath
  }

  const tunnelPath = typeof value.tunnelPath === 'string' ? value.tunnelPath : null
  const normalizedTunnelPath = tunnelPath
    ? uploadPathFromString(tunnelPath, uploadRelativePathByBasename)
    : explicitUploadPath
  if (normalizedTunnelPath && 'tunnelPath' in value) {
    next.tunnelPath = normalizedTunnelPath
  }

  return next
}

function uploadRelativePathForExport(record: BackupRedisRecord) {
  const existing = normalizeUploadRelativePath(record.value)
  if (existing) return existing

  const keyRelativePath = uploadRelativePathFromKey(record.key)
  if (keyRelativePath) return keyRelativePath

  if (!isPlainObject(record.value)) return uploadRelativePathFromKey(record.key)
  const uploadType =
    typeof record.value.uploadType === 'string' && record.value.uploadType.trim().length > 0
      ? sanitizeRelativePathPart(record.value.uploadType)
      : null
  const filename =
    typeof record.value.filename === 'string' && record.value.filename.trim().length > 0
      ? sanitizeRelativePathPart(record.value.filename)
      : null

  if (uploadType && filename) return toPosixPath(`${uploadType}/${filename}`)
  return null
}

function stripPortableFileFields(value: Record<string, unknown>) {
  const next = { ...value }
  delete next.base64
  delete next.filePath
  return next
}

function normalizeUploadRecordForExport(record: BackupRedisRecord): {
  record: BackupRedisRecord
  redisBase64Asset: RedisBase64BackupFileAsset | null
} {
  if (!record.key.startsWith('upload:') || !isPlainObject(record.value)) {
    return { record, redisBase64Asset: null }
  }

  const relativePath = uploadRelativePathForExport(record)
  if (!relativePath) return { record, redisBase64Asset: null }
  const base64 = typeof record.value.base64 === 'string' ? record.value.base64 : null

  if (!base64) {
    if (isFilesystemBackedUploadValue(record.value)) {
      return {
        record: {
          ...record,
          value: {
            ...stripPortableFileFields(record.value),
            storage: 'filesystem',
            relativePath
          }
        },
        redisBase64Asset: null
      }
    }
    return { record, redisBase64Asset: null }
  }

  const declaredSize = typeof record.value.size === 'number' && Number.isFinite(record.value.size)
    ? record.value.size
    : decodedBase64ByteLength(base64)

  return {
    record: {
      ...record,
      value: {
        ...stripPortableFileFields(record.value),
        storage: 'filesystem',
        relativePath,
        size: declaredSize
      }
    },
    redisBase64Asset: {
      source: 'redis-base64',
      redisKey: record.key,
      zipPath: `${UPLOAD_FILE_ROOT}${relativePath}`,
      relativePath,
      byteLength: declaredSize
    }
  }
}

async function collectUploadFileAssets(
  records: BackupRedisRecord[],
  redisBase64Assets: RedisBase64BackupFileAsset[]
) {
  const uploadRoot = resolveUploadsDir()
  const assets = new Map<string, BackupFileAsset>()
  const redisBase64ByPath = new Map(redisBase64Assets.map((asset) => [asset.relativePath, asset]))

  for (const record of records) {
    if (!record.key.startsWith('upload:')) continue
    const relativePath = normalizeUploadRelativePath(record.value)
    if (!relativePath) continue

    const sourcePath = safeJoin(uploadRoot, relativePath)
    let stat
    try {
      stat = await fs.stat(sourcePath)
    } catch {
      if (redisBase64ByPath.has(relativePath)) continue
      throw new BackupRestoreError(
        `Backup cannot continue because upload asset "${relativePath}" is missing from ${uploadRoot}.`,
        500
      )
    }
    if (!stat.isFile()) {
      throw new BackupRestoreError(
        `Backup cannot continue because upload asset "${relativePath}" is not a file.`,
        500
      )
    }

    if (!assets.has(relativePath)) {
      assets.set(relativePath, {
        source: 'filesystem',
        zipPath: `${UPLOAD_FILE_ROOT}${relativePath}`,
        sourcePath,
        relativePath,
        byteLength: stat.size
      })
    }
  }

  for (const asset of redisBase64Assets) {
    if (!assets.has(asset.relativePath)) assets.set(asset.relativePath, asset)
  }

  const collected = Array.from(assets.values())
  return {
    assets: collected,
    fileAssetCount: collected.length,
    fileAssetBytes: collected.reduce((sum, asset) => sum + asset.byteLength, 0)
  }
}

function getRedisRecordEntryPath(index: number) {
  return `${REDIS_RECORDS_DIR}${String(index + 1).padStart(8, '0')}.json`
}

function addRedisRecordEntries(entries: Record<string, Uint8Array>, records: BackupRedisRecord[]) {
  for (let index = 0; index < records.length; index += 1) {
    entries[getRedisRecordEntryPath(index)] = encodeJsonEntry(records[index])
  }
}

function buildManifest(params: {
  userId: string
  includeSecrets: boolean
  records: BackupRedisRecord[]
  redactions: RedactionState
  fileAssetCount: number
  fileAssetBytes: number
}): BackupManifest {
  const groupCounts = new Map<BackupGroupId, { records: number; files: number }>()
  for (const group of GROUP_DEFINITIONS) {
    groupCounts.set(group.id, { records: 0, files: 0 })
  }
  for (const record of params.records) {
    const counts = groupCounts.get(record.groupId)
    if (counts) counts.records += 1
  }
  if (params.fileAssetCount > 0) {
    const counts = groupCounts.get('clips')
    if (counts) counts.files += params.fileAssetCount
  }

  return {
    schemaVersion: BATSHIT_BACKUP_SCHEMA_VERSION,
    app: {
      name: 'Batshit',
      version: getAppVersion()
    },
    createdAt: new Date().toISOString(),
    source: {
      userId: params.userId
    },
    options: {
      includeSecrets: params.includeSecrets
    },
    contents: {
      redisRecordCount: params.records.length,
      fileAssetCount: params.fileAssetCount,
      fileAssetBytes: params.fileAssetBytes,
      groups: GROUP_DEFINITIONS.map((group) => {
        const counts = groupCounts.get(group.id) ?? { records: 0, files: 0 }
        return {
          id: group.id,
          label: group.label,
          classification: group.classification,
          recordCount: counts.records,
          fileAssetCount: counts.files,
          description: group.description
        }
      }).filter((group) => group.recordCount > 0 || group.fileAssetCount > 0 || group.classification === 'secret')
    },
    secrets: {
      included: params.includeSecrets,
      excludedRecordCount: params.includeSecrets ? 0 : params.redactions.excludedRecordCount,
      redactedFieldCount: params.includeSecrets ? 0 : params.redactions.redactedFieldCount,
      redactedPaths: params.includeSecrets
        ? []
        : Array.from(params.redactions.redactedPaths).sort((left, right) => left.localeCompare(right)),
      warning: params.includeSecrets
        ? 'This backup includes saved encrypted secret records. Protect the file and restore it only into an instance with the same encryption key.'
        : 'Saved API keys, tokens, webhook auth values, and other secret fields were excluded or nulled. Re-enter missing credentials after restore.'
    },
    externalReferences: [
      'External n8n workflows and n8n credentials are not included.',
      'Local AI servers, voice engines, Agent Browser, Cloudflared, LiveKit sidecars, and model weights are restored as settings or references only.',
      'Project source files remain at their filesystem paths and are not copied into the backup bundle.'
    ],
    compatibility: {
      minSchemaVersion: 1,
      maxSchemaVersion: BATSHIT_BACKUP_SCHEMA_VERSION,
      restoreMode: 'fresh-or-destructive-replace'
    }
  }
}

function createBackupFilename() {
  return `batshit-backup-${new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}.zip`
}

async function collectBackupBundleParts(userId: string, options?: { includeSecrets?: boolean }) {
  const includeSecrets = options?.includeSecrets === true
  const { records, redactions, redisBase64Assets } = await collectRedisRecords({ userId, includeSecrets })
  const fileAssets = await collectUploadFileAssets(records, redisBase64Assets)
  const manifest = buildManifest({
    userId,
    includeSecrets,
    records,
    redactions,
    fileAssetCount: fileAssets.fileAssetCount,
    fileAssetBytes: fileAssets.fileAssetBytes
  })
  const entries: Record<string, Uint8Array> = {}
  addRedisRecordEntries(entries, records)
  entries[MANIFEST_PATH] = encodeText(JSON.stringify(manifest, null, 2))

  return {
    manifest,
    records,
    entries,
    fileAssets: fileAssets.assets,
    filename: createBackupFilename()
  }
}

export async function createBackupBundle(userId: string, options?: { includeSecrets?: boolean }) {
  const parts = await collectBackupBundleParts(userId, options)
  for (const asset of parts.fileAssets) {
    try {
      if (asset.source === 'filesystem') {
        parts.entries[asset.zipPath] = new Uint8Array(await fs.readFile(asset.sourcePath))
      } else {
        const base64 = await readRedisBase64Payload(asset)
        parts.entries[asset.zipPath] = new Uint8Array(Buffer.concat(Array.from(decodeBase64Chunks(base64))))
      }
    } catch (error) {
      if (error instanceof BackupRestoreError) throw error
      throw new BackupRestoreError(
        `Backup cannot continue because upload asset "${asset.relativePath}" could not be read.`,
        500
      )
    }
  }
  const bytes = createZip(parts.entries)

  return {
    bytes,
    manifest: parts.manifest,
    filename: parts.filename
  }
}

export async function createBackupBundleStream(
  userId: string,
  options?: { includeSecrets?: boolean }
): Promise<BackupBundleStream> {
  const parts = await collectBackupBundleParts(userId, options)
  const stream = createZipReadableStream(parts.entries, parts.fileAssets) as ReadableStream<Uint8Array>

  return {
    stream,
    manifest: parts.manifest,
    filename: parts.filename
  }
}

function getRedisRecordEntryNames(zipEntries: Record<string, Uint8Array>) {
  return Object.keys(zipEntries)
    .filter((name) => name.startsWith(REDIS_RECORDS_DIR) && name.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
}

function parseLegacyRedisRecords(bytes: Uint8Array) {
  try {
    return JSON.parse(decodeText(bytes)) as BackupRedisRecord[]
  } catch {
    throw new BackupRestoreError('Backup contains invalid Redis record JSON.', 400)
  }
}

function parseRedisRecordEntries(zipEntries: Record<string, Uint8Array>) {
  const legacyBytes = zipEntries[LEGACY_REDIS_RECORDS_PATH]
  if (legacyBytes) return parseLegacyRedisRecords(legacyBytes)

  const recordEntryNames = getRedisRecordEntryNames(zipEntries)
  if (recordEntryNames.length === 0) {
    throw new BackupRestoreError('Backup is missing Redis record entries.', 400)
  }

  const records: BackupRedisRecord[] = []
  for (const name of recordEntryNames) {
    try {
      records.push(JSON.parse(decodeText(zipEntries[name])) as BackupRedisRecord)
    } catch {
      throw new BackupRestoreError(`Backup contains invalid Redis record JSON at ${name}.`, 400)
    }
  }

  return records
}

function parseBackupBundle(bytes: Uint8Array): BackupBundle {
  let zipEntries: Record<string, Uint8Array>
  try {
    zipEntries = unzipSync(bytes, { filter: (file) => !file.name.endsWith('/') })
  } catch {
    throw new BackupRestoreError('Backup file is not a readable zip bundle.', 400)
  }

  for (const name of Object.keys(zipEntries)) {
    assertSafeZipPath(name)
  }

  const manifestBytes = zipEntries[MANIFEST_PATH]
  if (!manifestBytes) {
    throw new BackupRestoreError('Backup is missing manifest.json.', 400)
  }

  let manifest: BackupManifest
  try {
    manifest = JSON.parse(decodeText(manifestBytes)) as BackupManifest
  } catch {
    throw new BackupRestoreError('Backup contains invalid manifest JSON.', 400)
  }

  validateManifest(manifest)
  const records = parseRedisRecordEntries(zipEntries)
  validateRecords(records)

  if (records.length !== manifest.contents.redisRecordCount) {
    throw new BackupRestoreError('Backup record count does not match the manifest.', 400)
  }

  return { manifest, records, zipEntries }
}

function validateManifest(manifest: BackupManifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new BackupRestoreError('Backup manifest is invalid.', 400)
  }
  if (manifest.app?.name !== 'Batshit') {
    throw new BackupRestoreError('This is not a Batshit backup bundle.', 400)
  }
  if (manifest.schemaVersion > BATSHIT_BACKUP_SCHEMA_VERSION) {
    throw new BackupRestoreError(
      `This backup uses schema ${manifest.schemaVersion}, but this Batshit build only supports schema ${BATSHIT_BACKUP_SCHEMA_VERSION}.`,
      409
    )
  }
  if (manifest.schemaVersion < 1) {
    throw new BackupRestoreError('Backup schema version is invalid.', 400)
  }
  if (!manifest.source?.userId) {
    throw new BackupRestoreError('Backup manifest is missing the source user.', 400)
  }
}

function validateRecords(records: BackupRedisRecord[]) {
  if (!Array.isArray(records)) {
    throw new BackupRestoreError('Backup records must be an array.', 400)
  }
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      throw new BackupRestoreError('Backup contains an invalid Redis record.', 400)
    }
    if (typeof record.key !== 'string' || record.key.trim().length === 0) {
      throw new BackupRestoreError('Backup contains a Redis record without a key.', 400)
    }
    if (!['json', 'string', 'set', 'list', 'hash', 'zset'].includes(record.type)) {
      throw new BackupRestoreError(`Backup contains unsupported Redis type for ${record.key}.`, 400)
    }
  }
}

async function countCurrentRecords(userId: string) {
  return await redis.execute(async (client) => {
    return (await collectCandidateKeys(client, userId)).length
  })
}

export async function preflightBackupRestore(
  userId: string,
  bytes: Uint8Array
): Promise<BackupPreflightSummary> {
  const bundle = parseBackupBundle(bytes)
  await validateRecipeRestoreGraph(bundle.records, bundle.manifest.source.userId)
  const preflightTargetRecords = buildTargetRecords(bundle, userId)
  await rehashTransformedRecipeGraph(preflightTargetRecords, userId)
  await validateRecipeRestoreGraph(preflightTargetRecords, userId)
  const currentRecordCount = await countCurrentRecords(userId)
  const fileAssetNames = Object.keys(bundle.zipEntries).filter((name) => name.startsWith(UPLOAD_FILE_ROOT))
  const fileAssetBytes = fileAssetNames.reduce(
    (sum, name) => sum + (bundle.zipEntries[name]?.byteLength ?? 0),
    0
  )

  return {
    ok: true,
    manifest: bundle.manifest,
    redisRecordCount: bundle.records.length,
    fileAssetCount: fileAssetNames.length,
    fileAssetBytes,
    requiresDestructiveConfirmation: currentRecordCount > 0,
    currentRecordCount,
    sourceUserId: bundle.manifest.source.userId,
    targetUserId: userId,
    userRemapRequired: bundle.manifest.source.userId !== userId,
    warnings: buildPreflightWarnings(bundle, currentRecordCount)
  }
}

function backupHasContainerProjectPathRewrite(records: BackupRedisRecord[]) {
  if (!isContainerizedRuntime()) return false
  const workspaceRoot = getContainerWorkspaceRoot()
  return records.some((record) => {
    if (!isPlainObject(record.value)) return false
    if (!(record.key.startsWith('project:') || record.key.startsWith('project_prefs:'))) return false
    return Object.entries(record.value).some(([field, fieldValue]) => {
      return PROJECT_RESTORE_PATH_FIELDS.has(field) && shouldRewriteProjectPathForContainer(fieldValue, workspaceRoot)
    })
  })
}

function buildPreflightWarnings(bundle: BackupBundle, currentRecordCount: number) {
  const manifest = bundle.manifest
  const warnings: string[] = []
  if (!manifest.secrets.included) {
    warnings.push('This backup excludes secrets. Provider keys and tokens must be re-entered after restore.')
  }
  if (manifest.secrets.included) {
    warnings.push('This backup includes saved encrypted secrets. Protect the file.')
  }
  if (currentRecordCount > 0) {
    warnings.push('Restore replaces current Batshit data. It does not merge records.')
  }
  if (backupHasContainerProjectPathRewrite(bundle.records)) {
    warnings.push(
      `This Docker restore will point imported Project paths at ${getContainerWorkspaceRoot()}. ` +
        'Mount or copy project source files there before asking agents to read or edit them.'
    )
  }
  warnings.push(...manifest.externalReferences)
  return warnings
}

function buildTargetRecords(bundle: BackupBundle, targetUserId: string) {
  const sourceUserId = bundle.manifest.source.userId
  const uploadRoot = resolveUploadsDir()
  const uploadRelativePathByBasename = buildUploadRelativePathIndex(bundle.records)
  return bundle.records.map((record) => {
    const key = remapUserKey(record.key, sourceUserId, targetUserId)
    if (!isRestorableKeyForUser(key, targetUserId)) {
      throw new BackupRestoreError(`Backup contains a key Batshit will not restore: ${record.key}`, 400)
    }

    let value = remapUserValue(cloneJson(record.value), sourceUserId, targetUserId)
    if (key.startsWith('upload:') && isPlainObject(value) && value.storage === 'filesystem') {
      const relativePath = normalizeUploadRelativePath(value)
      if (!relativePath) {
        throw new BackupRestoreError(`Filesystem upload record "${record.key}" is missing relativePath.`, 400)
      }
      value = {
        ...value,
        relativePath,
        filePath: safeJoin(uploadRoot, relativePath)
      }
    }
    value = rewriteLocalUploadUrlFields(value, uploadRelativePathByBasename)
    value = rewriteContainerProjectPaths(key, value, targetUserId)

    return {
      ...record,
      key,
      groupId: groupForKey(key, targetUserId),
      value
    }
  })
}

function recipeRestoreError(message: string): never {
  throw new BackupRestoreError(`Backup Recipe graph is invalid: ${message}`, 400)
}

function expectRecipeRecord(
  records: Map<string, BackupRedisRecord>,
  ref: RecipeDocumentRef,
  context: string
) {
  const record = records.get(ref.ref)
  if (!record || record.type !== 'json') {
    recipeRestoreError(`${context} references missing JSON record ${ref.ref}.`)
  }
  return record
}

function assertDocumentRef(
  records: Map<string, BackupRedisRecord>,
  ref: RecipeDocumentRef,
  context: string,
  userId: string,
  goonId: string
) {
  const record = expectRecipeRecord(records, ref, context)
  const document = record.value as GoonRecipeDocument
  if (
    !ref.ref.startsWith(`goon_recipe_document:${userId}:${goonId}:`) ||
    document.userId !== userId ||
    document.goonId !== goonId ||
    document.documentContract !== ref.contract ||
    document.sha256 !== ref.sha256
  ) {
    recipeRestoreError(`${context} does not match its Goon namespace, document contract, and hash.`)
  }
}

function assertRevisionRef(
  records: Map<string, BackupRedisRecord>,
  ref: RecipeDocumentRef,
  context: string,
  userId: string,
  goonId: string
) {
  const record = expectRecipeRecord(records, ref, context)
  const envelope = record.value as RecipeRevisionEnvelope
  if (
    !ref.ref.startsWith(`goon_recipe_revision:${userId}:${goonId}:`) ||
    ref.contract !== GOON_RECIPE_REVISION_ENVELOPE_CONTRACT ||
    envelope.envelopeSha256 !== ref.sha256
  ) {
    recipeRestoreError(`${context} does not match its Goon namespace, revision contract, and hash.`)
  }
}

async function validateRecipeRestoreGraph(records: BackupRedisRecord[], userId: string) {
  const byKey = new Map(records.map((record) => [record.key, record]))
  const owners = new Map<string, GoonRecipeV2>()
  for (const record of records) {
    if (record.type !== 'json' || !record.key.startsWith('goon:')) continue
    if (!isPlainObject(record.value) || !isPlainObject(record.value.recipe)) continue
    if (record.value.recipe.contract !== GOON_RECIPE_OWNER_V2_CONTRACT) continue
    const goonId = record.key.slice('goon:'.length)
    if (record.value.id !== goonId || record.value.user_id !== userId) {
      recipeRestoreError(`Goon ${goonId} has mismatched restored ownership.`)
    }
    try {
      owners.set(goonId, await verifyGoonRecipeV2(record.value.recipe))
    } catch (error) {
      recipeRestoreError(`Goon ${goonId} owner failed verification: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const revisions = new Map<string, RecipeRevisionEnvelope>()
  const jobs = new Map<string, GoonRecipeJob>()
  for (const record of records) {
    if (record.type !== 'json') continue
    try {
      if (record.key.startsWith(`goon_recipe_document:${userId}:`)) {
        const document = await verifyGoonRecipeDocument(record.value)
        const expectedKey = recipeDocumentRedisKey(document.userId, document.goonId, document.sha256)
        if (document.userId !== userId || record.key !== expectedKey || !owners.has(document.goonId)) {
          recipeRestoreError(`document ${record.key} has mismatched key or owner.`)
        }
      } else if (record.key.startsWith(`goon_recipe_revision:${userId}:`)) {
        const envelope = await verifyRecipeRevisionEnvelope(record.value)
        const parts = record.key.split(':')
        const goonId = parts[2] ?? ''
        const revisionId = parts.slice(3).join(':')
        if (!owners.has(goonId) || record.key !== recipeRevisionRedisKey(userId, goonId, revisionId)) {
          recipeRestoreError(`revision ${record.key} has mismatched key or owner.`)
        }
        if (envelope.revision.revisionId !== revisionId) {
          recipeRestoreError(`revision ${record.key} has a mismatched revision id.`)
        }
        revisions.set(record.key, envelope)
      } else if (record.key.startsWith(`goon_recipe_job:${userId}:`)) {
        const job = parseGoonRecipeJob(record.value)
        if (
          job.userId !== userId ||
          !owners.has(job.goonId) ||
          record.key !== recipeJobRedisKey(userId, job.goonId, job.jobId)
        ) {
          recipeRestoreError(`job ${record.key} has mismatched key or owner.`)
        }
        jobs.set(record.key, job)
      }
    } catch (error) {
      if (error instanceof BackupRestoreError) throw error
      recipeRestoreError(`${record.key} failed verification: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const [goonId, owner] of owners) {
    if (owner.activeRevision) {
      assertRevisionRef(byKey, owner.activeRevision, `Goon ${goonId} active revision`, userId, goonId)
    }
    if (owner.previousRevision) {
      assertRevisionRef(byKey, owner.previousRevision, `Goon ${goonId} previous revision`, userId, goonId)
    }
    if (owner.latestUpdateReport) {
      assertDocumentRef(byKey, owner.latestUpdateReport, `Goon ${goonId} latest report`, userId, goonId)
    }
    if (owner.lastFailure?.reportRef) {
      assertDocumentRef(byKey, owner.lastFailure.reportRef, `Goon ${goonId} failure report`, userId, goonId)
    }
    if (owner.maintenanceFailure?.reportRef) {
      assertDocumentRef(
        byKey,
        owner.maintenanceFailure.reportRef,
        `Goon ${goonId} maintenance report`,
        userId,
        goonId
      )
    }
    if (owner.pendingJob) {
      const pending = jobs.get(owner.pendingJob.jobRef)
      if (
        !pending ||
        pending.jobId !== owner.pendingJob.jobId ||
        pending.status !== owner.pendingJob.status ||
        pending.targetWriteVersion !== owner.writeVersion
      ) {
        recipeRestoreError(`Goon ${goonId} pending job does not match its job record.`)
      }
    }
  }
  for (const [key, envelope] of revisions) {
    const parts = key.split(':')
    const goonId = parts[2] ?? ''
    assertDocumentRef(byKey, envelope.sourceContainmentReceipt, `${key} source receipt`, userId, goonId)
    assertDocumentRef(byKey, envelope.revision.liveBuildReceipt, `${key} Live-build receipt`, userId, goonId)
    if (envelope.revision.updateReport) {
      assertDocumentRef(byKey, envelope.revision.updateReport, `${key} update report`, userId, goonId)
    }
  }
  for (const [key, job] of jobs) {
    if (job.sourceRevision) {
      assertRevisionRef(byKey, job.sourceRevision, `${key} source revision`, userId, job.goonId)
    }
    assertDocumentRef(
      byKey,
      job.stagedSource.containmentReceipt,
      `${key} staged source receipt`,
      userId,
      job.goonId
    )
    if (job.plan) assertDocumentRef(byKey, job.plan, `${key} plan`, userId, job.goonId)
    if (job.candidateRevision) {
      assertRevisionRef(byKey, job.candidateRevision, `${key} candidate revision`, userId, job.goonId)
    }
    if (job.failure?.reportRef) {
      assertDocumentRef(byKey, job.failure.reportRef, `${key} failure report`, userId, job.goonId)
    }
  }
}

async function rehashRecipeStateSnapshot(value: unknown) {
  if (!isPlainObject(value) || !Array.isArray(value.siblings)) {
    throw new Error('Recipe state snapshot is missing its sibling collection.')
  }
  for (const sibling of value.siblings) {
    if (!isPlainObject(sibling) || !isPlainObject(sibling.state)) {
      throw new Error('Recipe state snapshot contains an invalid sibling state.')
    }
    sibling.stateSha256 = await recipeSiblingStateSha256(sibling.state)
  }
  value.stateSha256 = await recipeStateSnapshotSha256(value)
}

async function rehashTransformedRecipeGraph(records: BackupRedisRecord[], userId: string) {
  const revisionHashByKey = new Map<string, string>()
  const revisionIdentityByKey = new Map<
    string,
    ReturnType<typeof recipeRevisionIdentity>
  >()
  const revisionIdentityByGoonRevision = new Map<
    string,
    ReturnType<typeof recipeRevisionIdentity>
  >()
  for (const record of records) {
    if (record.type !== 'json' || !record.key.startsWith(`goon_recipe_revision:${userId}:`)) continue
    try {
      const envelope = parseRecipeRevisionEnvelope(record.value)
      await rehashRecipeStateSnapshot(envelope.revision.state)
      envelope.revision.revisionSha256 = await recipeRevisionBundleSha256(envelope.revision)
      envelope.envelopeSha256 = await recipeRevisionEnvelopeSha256(envelope)
      record.value = envelope
      revisionHashByKey.set(record.key, envelope.envelopeSha256)
      const identity = recipeRevisionIdentity(envelope.revision)
      const goonId = record.key.split(':')[2] ?? ''
      revisionIdentityByKey.set(record.key, identity)
      revisionIdentityByGoonRevision.set(
        `${goonId}:${identity.recipeRevision}:${identity.revisionId}`,
        identity
      )
    } catch (error) {
      recipeRestoreError(
        `${record.key} could not be rehashed after restore transformation: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const updateRevisionRef = (ref: unknown) => {
    if (!isPlainObject(ref) || typeof ref.ref !== 'string') return
    const hash = revisionHashByKey.get(ref.ref)
    if (hash) ref.sha256 = hash
  }
  for (const record of records) {
    if (record.type !== 'json' || !isPlainObject(record.value)) continue
    if (record.key.startsWith('goon:') && isPlainObject(record.value.recipe)) {
      const owner = record.value.recipe
      if (owner.contract !== GOON_RECIPE_OWNER_V2_CONTRACT) continue
      updateRevisionRef(owner.activeRevision)
      updateRevisionRef(owner.previousRevision)
      if (isPlainObject(owner.authoringRevision)) {
        try {
          await rehashRecipeStateSnapshot(owner.authoringRevision.state)
          owner.authoringRevision.revisionSha256 = await recipeAuthoringRevisionSha256(
            owner.authoringRevision
          )
        } catch (error) {
          recipeRestoreError(
            `${record.key} authoring revision could not be rehashed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      if (Array.isArray(record.value.recipeFitReceipts)) {
        try {
          const goonId = String(record.value.id ?? '')
          const receipts = record.value.recipeFitReceipts.map((value) => {
            const receipt = parseGoonRecipeFitReceipt(value)
            const mappedBound = revisionIdentityByGoonRevision.get(
              `${goonId}:${receipt.boundRevision.recipeRevision}:${receipt.boundRevision.revisionId}`
            )
            return mappedBound ? { ...receipt, boundRevision: mappedBound } : receipt
          })
          const activeIdentity = isPlainObject(owner.activeRevision) &&
            typeof owner.activeRevision.ref === 'string'
            ? revisionIdentityByKey.get(owner.activeRevision.ref)
            : undefined
          record.value.recipeFitReceipts = activeIdentity
            ? reconcileGoonRecipeFitReceipts(receipts, activeIdentity)
            : receipts
        } catch (error) {
          recipeRestoreError(
            `${record.key} Recipe fit receipts could not be remapped: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } else if (record.key.startsWith(`goon_recipe_job:${userId}:`)) {
      updateRevisionRef(record.value.sourceRevision)
      updateRevisionRef(record.value.candidateRevision)
    }
  }
}

async function writeUploadFileAssets(bundle: BackupBundle) {
  const uploadRoot = resolveUploadsDir()
  const writtenPaths: string[] = []
  let count = 0
  let bytes = 0

  for (const [name, content] of Object.entries(bundle.zipEntries)) {
    if (!name.startsWith(UPLOAD_FILE_ROOT)) continue
    const relativePath = name.slice(UPLOAD_FILE_ROOT.length)
    const targetPath = safeJoin(uploadRoot, relativePath)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, content)
    writtenPaths.push(targetPath)
    count += 1
    bytes += content.byteLength
  }

  return { writtenPaths, count, bytes }
}

async function deleteFiles(paths: string[]) {
  for (const filePath of paths) {
    await fs.rm(filePath, { force: true }).catch(() => {})
  }
}

async function writeRecord(client: any, record: BackupRedisRecord) {
  await client.del(record.key)
  if (record.type === 'json') {
    await client.json.set(record.key, '$', record.value)
  } else if (record.type === 'string') {
    await client.set(record.key, String(record.value ?? ''))
  } else if (record.type === 'set') {
    const values = Array.isArray(record.value) ? record.value.map(String) : []
    if (values.length > 0) await client.sAdd(record.key, values)
  } else if (record.type === 'list') {
    const values = Array.isArray(record.value) ? record.value.map(String) : []
    for (const value of values) {
      await client.rPush(record.key, value)
    }
  } else if (record.type === 'hash') {
    const values = isPlainObject(record.value) ? record.value : {}
    if (Object.keys(values).length > 0) await client.hSet(record.key, values)
  } else if (record.type === 'zset') {
    const values = Array.isArray(record.value) ? record.value : []
    if (values.length > 0) await client.zAdd(record.key, values)
  }

  if (record.ttlSeconds && record.ttlSeconds > 0) {
    await client.expire(record.key, record.ttlSeconds)
  }
}

async function deleteRecords(client: any, keys: string[]) {
  const uniqueKeys = Array.from(new Set(keys)).filter(Boolean)
  if (uniqueKeys.length === 0) return
  await client.del(uniqueKeys)
}

async function collectCurrentRecordsForRollback(client: any, userId: string) {
  const keys = await collectCandidateKeys(client, userId)
  const records: BackupRedisRecord[] = []
  for (const key of keys) {
    const record = await readRedisRecord(client, key, groupForKey(key, userId))
    if (record) records.push(record)
  }
  return records
}

export async function restoreBackupBundle(
  userId: string,
  bytes: Uint8Array,
  options?: { confirmReplace?: boolean }
): Promise<RestoreResult> {
  const bundle = parseBackupBundle(bytes)
  await validateRecipeRestoreGraph(bundle.records, bundle.manifest.source.userId)
  const currentRecordCount = await countCurrentRecords(userId)
  if (currentRecordCount > 0 && options?.confirmReplace !== true) {
    throw new BackupRestoreError(
      'Restore would replace existing Batshit data. Confirm destructive restore first.',
      409,
      { currentRecordCount }
    )
  }

  const targetRecords = buildTargetRecords(bundle, userId)
  await rehashTransformedRecipeGraph(targetRecords, userId)
  await validateRecipeRestoreGraph(targetRecords, userId)
  const uploadedFiles = await writeUploadFileAssets(bundle)

  try {
    await redis.execute(async (client) => {
      const rollbackRecords = await collectCurrentRecordsForRollback(client, userId)
      const currentKeys = rollbackRecords.map((record) => record.key)
      const targetKeys = targetRecords.map((record) => record.key)

      try {
        await deleteRecords(client, [...currentKeys, ...targetKeys])
        for (const record of targetRecords) {
          await writeRecord(client, record)
        }
      } catch (error) {
        await deleteRecords(client, targetKeys).catch(() => {})
        for (const rollbackRecord of rollbackRecords) {
          await writeRecord(client, rollbackRecord).catch(() => {})
        }
        throw error
      }
    })
  } catch (error) {
    await deleteFiles(uploadedFiles.writtenPaths)
    if (error instanceof BackupRestoreError) throw error
    throw new BackupRestoreError(
      error instanceof Error ? error.message : 'Restore failed while writing Redis records.',
      500
    )
  }

  // Same post-restore memory index reconciliation as restoreStagedBackup: indexes are
  // not Redis keys, so the replace above left them in the pre-restore shape.
  try {
    await reconcileMemoryIndexesAfterRestore()
  } catch (memoryIndexError) {
    console.error(
      '[BackupRestore] Restore completed but memory index reconciliation failed; memory search stays unavailable until re-indexed:',
      memoryIndexError
    )
  }

  return {
    restored: true,
    redisRecordCount: targetRecords.length,
    fileAssetCount: uploadedFiles.count,
    fileAssetBytes: uploadedFiles.bytes,
    sourceUserId: bundle.manifest.source.userId,
    targetUserId: userId,
    secretsIncluded: bundle.manifest.secrets.included,
    redactedFieldCount: bundle.manifest.secrets.redactedFieldCount,
    replacedExistingRecordCount: currentRecordCount
  }
}

type AsyncZipFile = ZipFile & {
  eachEntry: () => AsyncIterable<Entry>
  openReadStreamPromise: (entry: Entry) => Promise<Readable>
}

interface BackupStageMetadata {
  contract: 'batshit-backup-stage/v1'
  stageId: string
  userId: string
  filename: string
  bytes: number
  sha256: string
  stagedAt: string
  expiresAt: string
  archivePath: string
}

interface StagedFileAsset {
  name: string
  relativePath: string
  byteLength: number
}

interface StagedBackupBundle {
  stage: BackupStageMetadata
  archivePath: string
  manifest: BackupManifest
  records: BackupRedisRecord[]
  fileAssets: StagedFileAsset[]
}

interface RestoreJournal {
  contract: 'batshit-backup-restore-journal/v1'
  stageId: string
  userId: string
  phase: 'prepared' | 'files-old-moved' | 'files-swapped' | 'redis-replacing' | 'redis-complete'
  hadOriginalUploads: boolean
  createdAt: string
  updatedAt: string
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_REDIS_RECORD_BYTES = 64 * 1024 * 1024
const MAX_LEGACY_RECORDS_BYTES = 512 * 1024 * 1024
const RESTORE_LOCK_NAME = 'active-restore.lock'
const RESTORE_REQUEST_DRAIN_TIMEOUT_MS = 30_000

let backupRestoreMaintenanceActive = false
let backupRestoreHttpRequestCount = 0
const backupRestoreRequestDrainWaiters = new Set<() => void>()

function notifyBackupRestoreRequestDrainWaiters() {
  for (const waiter of backupRestoreRequestDrainWaiters) waiter()
  backupRestoreRequestDrainWaiters.clear()
}

export function enterBackupRestoreHttpRequest() {
  if (backupRestoreMaintenanceActive) return null
  backupRestoreHttpRequestCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    backupRestoreHttpRequestCount = Math.max(0, backupRestoreHttpRequestCount - 1)
    notifyBackupRestoreRequestDrainWaiters()
  }
}

function waitForBackupRestoreRequestDrain(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      backupRestoreRequestDrainWaiters.delete(finish)
      resolve()
    }
    timer = setTimeout(finish, timeoutMs)
    backupRestoreRequestDrainWaiters.add(finish)
  })
}

export async function beginBackupRestoreMaintenance() {
  if (backupRestoreMaintenanceActive) {
    throw new BackupRestoreError('Another backup restore is already running.', 409)
  }
  backupRestoreMaintenanceActive = true
  const deadline = Date.now() + RESTORE_REQUEST_DRAIN_TIMEOUT_MS
  while (backupRestoreHttpRequestCount > 1) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      backupRestoreMaintenanceActive = false
      notifyBackupRestoreRequestDrainWaiters()
      throw new BackupRestoreError(
        'Restore is waiting for active Batshit work to finish. Stop the current task and try again.',
        409
      )
    }
    await waitForBackupRestoreRequestDrain(remainingMs)
  }

  let ended = false
  return () => {
    if (ended) return
    ended = true
    backupRestoreMaintenanceActive = false
    notifyBackupRestoreRequestDrainWaiters()
  }
}

function assertStageId(stageId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(stageId)) {
    throw new BackupRestoreError('Backup stage id is invalid.', 400)
  }
}

function stagedRestorePaths(stageId: string) {
  assertStageId(stageId)
  const stagingRoot = resolveBackupStagingDir()
  const uploadRoot = resolveUploadsDir()
  // Keep route-controlled identifiers out of filesystem names. This digest
  // must match batshit-server's private staging contract.
  const storageKey = createHash('sha256').update(stageId, 'utf8').digest('hex')
  return {
    stagingRoot,
    archivePath: path.join(stagingRoot, `${storageKey}.zip`),
    metadataPath: path.join(stagingRoot, `${storageKey}.json`),
    journalPath: path.join(stagingRoot, `${storageKey}.restore-journal.json`),
    rollbackPath: path.join(stagingRoot, `${storageKey}.rollback.ndjson`),
    planPath: path.join(stagingRoot, `${storageKey}.plan.ndjson`),
    lockPath: path.join(stagingRoot, RESTORE_LOCK_NAME),
    uploadRoot,
    newUploadRoot: path.join(uploadRoot, `.restore-new-${storageKey}`),
    oldUploadRoot: path.join(uploadRoot, `.restore-old-${storageKey}`)
  }
}

async function pathExists(targetPath: string) {
  return await fs.stat(targetPath).then(() => true).catch(() => false)
}

async function writeJsonAtomic(targetPath: string, value: unknown) {
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await fs.rename(temporaryPath, targetPath)
}

async function loadBackupStage(userId: string, stageId: string) {
  const paths = stagedRestorePaths(stageId)
  let stage: BackupStageMetadata
  try {
    stage = JSON.parse(await fs.readFile(paths.metadataPath, 'utf8')) as BackupStageMetadata
  } catch {
    throw new BackupRestoreError('The staged backup is missing or no longer available.', 404)
  }
  if (
    stage.contract !== 'batshit-backup-stage/v1' ||
    stage.stageId !== stageId ||
    stage.userId !== userId ||
    !Number.isSafeInteger(stage.bytes) ||
    stage.bytes <= 0 ||
    !/^[0-9a-f]{64}$/i.test(stage.sha256)
  ) {
    throw new BackupRestoreError('The staged backup metadata is invalid.', 400)
  }
  if (!Number.isFinite(Date.parse(stage.expiresAt)) || Date.parse(stage.expiresAt) <= Date.now()) {
    throw new BackupRestoreError('The staged backup has expired. Choose the file again.', 410)
  }
  const archiveStat = await fs.stat(paths.archivePath).catch(() => null)
  if (!archiveStat?.isFile() || archiveStat.size !== stage.bytes) {
    throw new BackupRestoreError('The staged backup file does not match its verified size.', 409)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(paths.archivePath)) {
    hash.update(chunk)
  }
  if (hash.digest('hex') !== stage.sha256.toLowerCase()) {
    throw new BackupRestoreError('The staged backup file no longer matches its verified SHA-256 identity.', 409)
  }
  return { stage, paths }
}

async function openLazyZip(archivePath: string): Promise<AsyncZipFile> {
  return await new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true
      },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(error ?? new Error('Zip reader did not open the archive'))
          return
        }
        resolve(zipFile as AsyncZipFile)
      }
    )
  })
}

function assertReadableBackupEntry(entry: Entry) {
  assertSafeZipPath(entry.fileName)
  if (entry.isEncrypted()) {
    throw new BackupRestoreError(`Backup entry "${entry.fileName}" is encrypted and cannot be restored.`, 400)
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== DEFLATE_METHOD) {
    throw new BackupRestoreError(
      `Backup entry "${entry.fileName}" uses unsupported compression method ${entry.compressionMethod}.`,
      400
    )
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  if ((unixMode & 0o170000) === 0o120000) {
    throw new BackupRestoreError(`Backup entry "${entry.fileName}" cannot be a symbolic link.`, 400)
  }
}

async function readZipEntryBuffer(zipFile: AsyncZipFile, entry: Entry, maxBytes: number) {
  if (entry.uncompressedSize > maxBytes) {
    throw new BackupRestoreError(`Backup entry "${entry.fileName}" is too large to validate safely.`, 400)
  }
  const stream = await zipFile.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array)
    bytes += chunk.length
    if (bytes > maxBytes) {
      stream.destroy()
      throw new BackupRestoreError(`Backup entry "${entry.fileName}" exceeded its validated size.`, 400)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes)
}

async function readStagedBackup(userId: string, stageId: string): Promise<StagedBackupBundle> {
  const { stage, paths } = await loadBackupStage(userId, stageId)
  let zipFile: AsyncZipFile | null = null
  try {
    zipFile = await openLazyZip(paths.archivePath)
    const seen = new Set<string>()
    let manifest: BackupManifest | null = null
    let legacyRecords: BackupRedisRecord[] | null = null
    const records: BackupRedisRecord[] = []
    const fileAssets: StagedFileAsset[] = []

    for await (const entry of zipFile.eachEntry()) {
      if (entry.fileName.endsWith('/')) continue
      assertReadableBackupEntry(entry)
      if (seen.has(entry.fileName)) {
        throw new BackupRestoreError(`Backup contains duplicate entry "${entry.fileName}".`, 400)
      }
      seen.add(entry.fileName)

      if (entry.fileName === MANIFEST_PATH) {
        const bytes = await readZipEntryBuffer(zipFile, entry, MAX_MANIFEST_BYTES)
        try {
          manifest = JSON.parse(bytes.toString('utf8')) as BackupManifest
        } catch {
          throw new BackupRestoreError('Backup contains invalid manifest JSON.', 400)
        }
      } else if (entry.fileName === LEGACY_REDIS_RECORDS_PATH) {
        const bytes = await readZipEntryBuffer(zipFile, entry, MAX_LEGACY_RECORDS_BYTES)
        legacyRecords = parseLegacyRedisRecords(bytes)
      } else if (entry.fileName.startsWith(REDIS_RECORDS_DIR) && entry.fileName.endsWith('.json')) {
        const bytes = await readZipEntryBuffer(zipFile, entry, MAX_REDIS_RECORD_BYTES)
        try {
          records.push(JSON.parse(bytes.toString('utf8')) as BackupRedisRecord)
        } catch {
          throw new BackupRestoreError(`Backup contains invalid Redis record JSON at ${entry.fileName}.`, 400)
        }
      } else if (entry.fileName.startsWith(UPLOAD_FILE_ROOT)) {
        const relativePath = entry.fileName.slice(UPLOAD_FILE_ROOT.length)
        if (!relativePath) throw new BackupRestoreError('Backup contains an empty upload path.', 400)
        fileAssets.push({
          name: entry.fileName,
          relativePath,
          byteLength: entry.uncompressedSize
        })
      }
    }

    if (!manifest) throw new BackupRestoreError('Backup is missing manifest.json.', 400)
    validateManifest(manifest)
    const resolvedRecords = legacyRecords ?? records
    if (!legacyRecords && resolvedRecords.length === 0) {
      throw new BackupRestoreError('Backup is missing Redis record entries.', 400)
    }
    validateRecords(resolvedRecords)
    if (resolvedRecords.length !== manifest.contents.redisRecordCount) {
      throw new BackupRestoreError('Backup record count does not match the manifest.', 400)
    }
    const fileBytes = fileAssets.reduce((sum, asset) => sum + asset.byteLength, 0)
    if (
      fileAssets.length !== manifest.contents.fileAssetCount ||
      fileBytes !== manifest.contents.fileAssetBytes
    ) {
      throw new BackupRestoreError('Backup file inventory does not match the manifest.', 400)
    }

    return {
      stage,
      archivePath: paths.archivePath,
      manifest,
      records: resolvedRecords,
      fileAssets
    }
  } catch (error) {
    if (error instanceof BackupRestoreError) throw error
    throw new BackupRestoreError(
      error instanceof Error ? `Backup file is not a readable zip bundle: ${error.message}` : 'Backup file is not a readable zip bundle.',
      400
    )
  } finally {
    zipFile?.close()
  }
}

function asBackupBundle(bundle: StagedBackupBundle): BackupBundle {
  return {
    manifest: bundle.manifest,
    records: bundle.records,
    zipEntries: {}
  }
}

async function measureCurrentRestoreState(userId: string) {
  return await redis.execute(async (client) => {
    const keys = await collectCandidateKeys(client, userId)
    let rollbackBytes = 0
    for (const key of keys) {
      const record = await readRedisRecord(client, key, groupForKey(key, userId))
      if (record) rollbackBytes += Buffer.byteLength(JSON.stringify(record), 'utf8') + 1
    }
    return { currentRecordCount: keys.length, rollbackBytes }
  })
}

async function getDiskCapacity(targetPath: string) {
  await fs.mkdir(targetPath, { recursive: true, mode: 0o700 })
  const stats = await fs.statfs(targetPath)
  return {
    availableBytes: stats.bavail * stats.bsize,
    blockSize: stats.bsize
  }
}

function estimateRestoreDiskBytes(
  fileAssets: StagedFileAsset[],
  rollbackBytes: number,
  restorePlanBytes: number,
  blockSize: number
) {
  const allocate = (bytes: number) => Math.ceil(Math.max(bytes, 1) / blockSize) * blockSize
  const directories = new Set<string>()
  for (const asset of fileAssets) {
    let directory = path.posix.dirname(asset.relativePath)
    while (directory !== '.' && directory !== '/') {
      directories.add(directory)
      const parent = path.posix.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  const fileBytes = fileAssets.reduce((sum, asset) => sum + allocate(asset.byteLength), 0)
  // Each new directory and the small journal/lock/metadata files need at least
  // one filesystem block. This is structural allocation, not a guessed size cap.
  const transactionMetadataBytes = (directories.size + 8) * blockSize
  return fileBytes + allocate(rollbackBytes) + allocate(restorePlanBytes) + transactionMetadataBytes
}

export async function preflightStagedBackupRestore(
  userId: string,
  stageId: string
): Promise<BackupPreflightSummary> {
  await ensureBackupRestoreRecovery()
  const bundle = await readStagedBackup(userId, stageId)
  await validateRecipeRestoreGraph(bundle.records, bundle.manifest.source.userId)
  const targetRecords = buildTargetRecords(asBackupBundle(bundle), userId)
  await rehashTransformedRecipeGraph(targetRecords, userId)
  await validateRecipeRestoreGraph(targetRecords, userId)

  const { currentRecordCount, rollbackBytes } = await measureCurrentRestoreState(userId)
  const fileAssetBytes = bundle.fileAssets.reduce((sum, asset) => sum + asset.byteLength, 0)
  const restorePlanBytes = targetRecords.reduce(
    (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1,
    0
  )
  const { availableBytes, blockSize } = await getDiskCapacity(resolveUploadsDir())
  const requiredBytes = estimateRestoreDiskBytes(
    bundle.fileAssets,
    rollbackBytes,
    restorePlanBytes,
    blockSize
  )
  const legacyBundle = asBackupBundle(bundle)
  const warnings = buildPreflightWarnings(legacyBundle, currentRecordCount)
  if (availableBytes < requiredBytes) {
    warnings.unshift('This restore needs more free disk space before Batshit can safely stage files and preserve rollback data.')
  }

  return {
    ok: true,
    manifest: bundle.manifest,
    redisRecordCount: bundle.records.length,
    fileAssetCount: bundle.fileAssets.length,
    fileAssetBytes,
    requiresDestructiveConfirmation: currentRecordCount > 0,
    currentRecordCount,
    sourceUserId: bundle.manifest.source.userId,
    targetUserId: userId,
    userRemapRequired: bundle.manifest.source.userId !== userId,
    warnings,
    stage: {
      id: bundle.stage.stageId,
      filename: bundle.stage.filename,
      archiveBytes: bundle.stage.bytes,
      sha256: bundle.stage.sha256,
      expiresAt: bundle.stage.expiresAt
    },
    disk: {
      requiredBytes,
      availableBytes,
      sufficient: availableBytes >= requiredBytes,
      restoredFileBytes: fileAssetBytes,
      rollbackBytes,
      restorePlanBytes
    }
  }
}

async function writeRecordsNdjson(filePath: string, records: BackupRedisRecord[]) {
  const handle = await fs.open(filePath, 'w', 0o600)
  try {
    for (const record of records) {
      await handle.write(`${JSON.stringify(record)}\n`)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeCurrentRollbackNdjson(filePath: string, userId: string) {
  await redis.execute(async (client) => {
    const handle = await fs.open(filePath, 'w', 0o600)
    try {
      const keys = await collectCandidateKeys(client, userId)
      for (const key of keys) {
        const record = await readRedisRecord(client, key, groupForKey(key, userId))
        if (record) await handle.write(`${JSON.stringify(record)}\n`)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
}

async function forEachNdjsonRecord(
  filePath: string,
  callback: (record: BackupRedisRecord) => Promise<void>
) {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const record = JSON.parse(line) as BackupRedisRecord
    validateRecords([record])
    await callback(record)
  }
}

async function deleteRecordKeysFromPlan(client: any, planPath: string) {
  let batch: string[] = []
  await forEachNdjsonRecord(planPath, async (record) => {
    batch.push(record.key)
    if (batch.length >= 250) {
      await deleteRecords(client, batch)
      batch = []
    }
  })
  await deleteRecords(client, batch)
}

async function restoreRedisFromRollback(planPath: string, rollbackPath: string) {
  await redis.execute(async (client) => {
    if (await pathExists(planPath)) await deleteRecordKeysFromPlan(client, planPath)
    if (await pathExists(rollbackPath)) {
      await forEachNdjsonRecord(rollbackPath, async (record) => {
        await writeRecord(client, record)
      })
    }
  })
}

async function extractStagedUploadFiles(bundle: StagedBackupBundle, targetRoot: string) {
  await fs.rm(targetRoot, { recursive: true, force: true })
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 })
  let zipFile: AsyncZipFile | null = null
  let count = 0
  let bytes = 0
  try {
    zipFile = await openLazyZip(bundle.archivePath)
    for await (const entry of zipFile.eachEntry()) {
      if (entry.fileName.endsWith('/') || !entry.fileName.startsWith(UPLOAD_FILE_ROOT)) continue
      assertReadableBackupEntry(entry)
      const relativePath = entry.fileName.slice(UPLOAD_FILE_ROOT.length)
      const targetPath = safeJoin(targetRoot, relativePath)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      const input = await zipFile.openReadStreamPromise(entry)
      await pipeline(input, createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }))
      count += 1
      bytes += entry.uncompressedSize
    }
  } finally {
    zipFile?.close()
  }
  if (count !== bundle.fileAssets.length || bytes !== bundle.manifest.contents.fileAssetBytes) {
    throw new BackupRestoreError('Extracted upload inventory does not match the validated backup.', 400)
  }
  return { count, bytes }
}

async function saveRestoreJournal(paths: ReturnType<typeof stagedRestorePaths>, journal: RestoreJournal) {
  journal.updatedAt = new Date().toISOString()
  await writeJsonAtomic(paths.journalPath, journal)
}

function isRestoreTransactionEntry(name: string) {
  return name.startsWith('.restore-new-') || name.startsWith('.restore-old-')
}

async function listLiveUploadEntries(uploadRoot: string) {
  return (await fs.readdir(uploadRoot).catch(() => [])).filter((name) => !isRestoreTransactionEntry(name))
}

async function moveDirectoryContents(sourceRoot: string, targetRoot: string) {
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 })
  for (const name of await fs.readdir(sourceRoot).catch(() => [])) {
    await fs.rename(path.join(sourceRoot, name), path.join(targetRoot, name))
  }
}

async function restoreUploadTree(
  paths: ReturnType<typeof stagedRestorePaths>,
  hadOriginalUploads: boolean,
  removeLiveFirst: boolean
) {
  if (removeLiveFirst) {
    for (const name of await listLiveUploadEntries(paths.uploadRoot)) {
      await fs.rm(path.join(paths.uploadRoot, name), { recursive: true, force: true })
    }
  }
  if (hadOriginalUploads && await pathExists(paths.oldUploadRoot)) {
    await moveDirectoryContents(paths.oldUploadRoot, paths.uploadRoot)
  }
  await fs.rm(paths.newUploadRoot, { recursive: true, force: true })
  await fs.rm(paths.oldUploadRoot, { recursive: true, force: true })
}

async function cleanupRestoreOperation(paths: ReturnType<typeof stagedRestorePaths>, removeStage: boolean) {
  await Promise.all([
    fs.rm(paths.oldUploadRoot, { recursive: true, force: true }),
    fs.rm(paths.newUploadRoot, { recursive: true, force: true }),
    fs.rm(paths.rollbackPath, { force: true }),
    fs.rm(paths.planPath, { force: true }),
    fs.rm(paths.journalPath, { force: true }),
    ...(removeStage
      ? [fs.rm(paths.archivePath, { force: true }), fs.rm(paths.metadataPath, { force: true })]
      : [])
  ])
}

async function recoverRestoreJournal(journalPath: string) {
  const raw = JSON.parse(await fs.readFile(journalPath, 'utf8')) as RestoreJournal
  if (
    raw.contract !== 'batshit-backup-restore-journal/v1' ||
    typeof raw.userId !== 'string'
  ) {
    throw new BackupRestoreError('An interrupted restore journal is invalid and requires manual recovery.', 500)
  }
  const paths = stagedRestorePaths(raw.stageId)
  if (paths.journalPath !== journalPath) {
    throw new BackupRestoreError('An interrupted restore journal path is invalid.', 500)
  }

  if (raw.phase === 'redis-complete') {
    await cleanupRestoreOperation(paths, true)
    return
  }

  if (raw.phase === 'redis-replacing') {
    await restoreRedisFromRollback(paths.planPath, paths.rollbackPath)
  }
  await restoreUploadTree(paths, raw.hadOriginalUploads, raw.phase !== 'prepared')
  await cleanupRestoreOperation(paths, false)
}

let restoreRecoveryPromise: Promise<void> | null = null

export function ensureBackupRestoreRecovery() {
  if (!restoreRecoveryPromise) {
    restoreRecoveryPromise = (async () => {
      const stagingRoot = resolveBackupStagingDir()
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 })
      const journals = (await fs.readdir(stagingRoot))
        .filter((name) => name.endsWith('.restore-journal.json'))
        .sort()
      for (const name of journals) {
        await recoverRestoreJournal(path.join(stagingRoot, name))
      }
      await fs.rm(path.join(stagingRoot, RESTORE_LOCK_NAME), { force: true })
    })().finally(() => {
      restoreRecoveryPromise = null
    })
  }
  return restoreRecoveryPromise
}

async function acquireRestoreLock(paths: ReturnType<typeof stagedRestorePaths>) {
  await fs.mkdir(paths.stagingRoot, { recursive: true, mode: 0o700 })
  try {
    const handle = await fs.open(paths.lockPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, stageId: path.basename(paths.archivePath, '.zip'), startedAt: new Date().toISOString() })}\n`)
    return handle
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new BackupRestoreError('Another backup restore is already running.', 409)
    }
    throw error
  }
}

export async function restoreStagedBackup(
  userId: string,
  stageId: string,
  options?: { confirmReplace?: boolean }
): Promise<RestoreResult> {
  await ensureBackupRestoreRecovery()
  const paths = stagedRestorePaths(stageId)
  const lock = await acquireRestoreLock(paths)
  try {
    const bundle = await readStagedBackup(userId, stageId)
    await validateRecipeRestoreGraph(bundle.records, bundle.manifest.source.userId)
    const { currentRecordCount, rollbackBytes } = await measureCurrentRestoreState(userId)
    if (currentRecordCount > 0 && options?.confirmReplace !== true) {
      throw new BackupRestoreError(
        'Restore would replace existing Batshit data. Confirm destructive restore first.',
        409,
        { currentRecordCount }
      )
    }

    const targetRecords = buildTargetRecords(asBackupBundle(bundle), userId)
    await rehashTransformedRecipeGraph(targetRecords, userId)
    await validateRecipeRestoreGraph(targetRecords, userId)

    const restorePlanBytes = targetRecords.reduce(
      (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1,
      0
    )
    const { availableBytes, blockSize } = await getDiskCapacity(paths.uploadRoot)
    const requiredBytes = estimateRestoreDiskBytes(
      bundle.fileAssets,
      rollbackBytes,
      restorePlanBytes,
      blockSize
    )
    if (availableBytes < requiredBytes) {
      throw new BackupRestoreError(
        'Restore cannot start because there is not enough free disk space for restored files and rollback data.',
        409,
        { requiredBytes, availableBytes }
      )
    }

    const uploadedFiles = await extractStagedUploadFiles(bundle, paths.newUploadRoot)
    await writeRecordsNdjson(paths.planPath, targetRecords)
    await writeCurrentRollbackNdjson(paths.rollbackPath, userId)
    const journal: RestoreJournal = {
      contract: 'batshit-backup-restore-journal/v1',
      stageId,
      userId,
      phase: 'prepared',
      hadOriginalUploads: (await listLiveUploadEntries(paths.uploadRoot)).length > 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await saveRestoreJournal(paths, journal)

    try {
      await fs.mkdir(paths.oldUploadRoot, { recursive: true, mode: 0o700 })
      for (const name of await listLiveUploadEntries(paths.uploadRoot)) {
        await fs.rename(path.join(paths.uploadRoot, name), path.join(paths.oldUploadRoot, name))
      }
      journal.phase = 'files-old-moved'
      await saveRestoreJournal(paths, journal)
      await moveDirectoryContents(paths.newUploadRoot, paths.uploadRoot)
      await fs.rm(paths.newUploadRoot, { recursive: true, force: true })
      journal.phase = 'files-swapped'
      await saveRestoreJournal(paths, journal)

      journal.phase = 'redis-replacing'
      await saveRestoreJournal(paths, journal)
      await redis.execute(async (client) => {
        const currentKeys = await collectCandidateKeys(client, userId)
        await deleteRecords(client, [...currentKeys, ...targetRecords.map((record) => record.key)])
        for (const record of targetRecords) await writeRecord(client, record)
      })
      journal.phase = 'redis-complete'
      await saveRestoreJournal(paths, journal)
    } catch (error) {
      try {
        if (journal.phase === 'redis-replacing') {
          await restoreRedisFromRollback(paths.planPath, paths.rollbackPath)
        }
        await restoreUploadTree(paths, journal.hadOriginalUploads, journal.phase !== 'prepared')
        await cleanupRestoreOperation(paths, false)
      } catch (rollbackError) {
        throw new BackupRestoreError(
          'Restore failed and automatic rollback could not finish. Batshit kept the recovery journal for startup recovery.',
          500,
          {
            restoreError: error instanceof Error ? error.message : String(error),
            rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }
        )
      }
      throw error
    }

    await cleanupRestoreOperation(paths, true)

    // Memory search indexes are not Redis keys, so they survived the destructive replace
    // with the pre-restore shape. Rebuild them from the restored config/records (SA-104).
    // A failure here does not undo the completed restore: it logs loudly, every memory
    // recall path keeps failing loudly with the same cause, and the startup bootstrap
    // retries the reconcile on the next boot.
    try {
      await reconcileMemoryIndexesAfterRestore()
    } catch (memoryIndexError) {
      console.error(
        '[BackupRestore] Restore completed but memory index reconciliation failed; memory search stays unavailable until re-indexed:',
        memoryIndexError
      )
    }

    return {
      restored: true,
      redisRecordCount: targetRecords.length,
      fileAssetCount: uploadedFiles.count,
      fileAssetBytes: uploadedFiles.bytes,
      sourceUserId: bundle.manifest.source.userId,
      targetUserId: userId,
      secretsIncluded: bundle.manifest.secrets.included,
      redactedFieldCount: bundle.manifest.secrets.redactedFieldCount,
      replacedExistingRecordCount: currentRecordCount
    }
  } catch (error) {
    if (error instanceof BackupRestoreError) throw error
    throw new BackupRestoreError(
      error instanceof Error ? error.message : 'Restore failed.',
      500
    )
  } finally {
    await lock.close().catch(() => undefined)
    await fs.rm(paths.lockPath, { force: true }).catch(() => undefined)
  }
}

export function summarizeBackupError(error: unknown) {
  if (error instanceof BackupRestoreError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        details: error.details ?? null
      }
    }
  }
  return {
    status: 500,
    body: {
      error: error instanceof Error ? error.message : 'Backup/restore failed',
      details: null
    }
  }
}

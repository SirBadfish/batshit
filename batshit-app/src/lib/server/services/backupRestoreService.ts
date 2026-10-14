import { isHairSnapshotKey, isRetainedHairOwnerKey, RETAINED_HAIR_OWNER_PATTERNS, needsHairBackupSnapshot, readHairBackupSnapshot, stagedHairUploadKeys } from './backupHairSnapshot'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
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
import { invalidateScheduleDueCache } from '$lib/server/services/schedules/scheduleStore'
import { mcpToolListCache } from '$lib/server/services/mcpToolListCache'
import {
  corePromptMetadataKey,
  listCoreSystemPromptDefinitions,
  readPackagedCoreSystemPromptDefault,
  reconcileCoreSystemPromptsAfterRestore
} from '$lib/server/services/systemPromptRegistry'
import {
  HOST_FILE_LIMITS,
  HOST_FILE_ZIP_ROOT,
  collectHostFolderFiles,
  describeNotCarriedHostFolder,
  hostFolderKey,
  hostFolderRefsFromRecords,
  isHostFileRootId,
  isSafeHostFolderName,
  isUserSkillRecordValue,
  managedReferenceAudioPathOf,
  checkHostFolderFiles,
  HostFileHandlesExhaustedError,
  openWalkedHostFile,
  parseHostFileZipPath,
  resolveHostFileRoot,
  type HostFileExportAsset,
  type HostFileRootId,
  type HostFolderExport,
  type HostFolderNotCarried
} from './backupHostFiles'
import {
  UPLOAD_PROBLEM_LIST_LIMIT,
  archivedRecordSha256,
  countUploadProblemFiles,
  countUploadProblems,
  describeUploadInspectionFailure,
  inspectUploadFiles,
  uploadFolderFoundNothing,
  uploadRecordFingerprint,
  type UploadFileProblem,
  type UploadInspection,
  type UploadInspectionTarget
} from './backupUploadInspection'
import { describeUploadOwners, type OwnerReadClient } from './backupUploadOwners'
import { buildAvatarServingUrlOverrides, rewriteRestoredUploadUrls } from './backupAvatarServingUrls'
import type { BackupUploadCheck } from '$lib/types/backupUploadCheck'
import {
  BACKUP_PARTIAL_ENTRY_LIMIT,
  BACKUP_PARTIAL_STRING_MAX,
  type BackupMissingUploadsSummary,
  type BackupPartialAcknowledgement,
  type BackupPartialRequest
} from '$lib/utils/backupPartialSummary'
import { withRecipeVerificationRestore as withRecipeVerificationRestoreEpoch } from './recipeVerificationEpoch.server'
import { assertNoGoonAssetMaintenanceForRestore } from './goonAssetCleanupService'
import { keepQueuedSessionTurnsHeldAtApprovalCards } from './streamAbortRegistry'
import {
  completePendingGoonAssetRestore,
  isGoonAssetRestoreActive,
  readPendingGoonAssetRestore,
  withGoonAssetRestoreBarrier
} from './goonAssetRestoreBarrier.server'
import {
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  RECIPE_REVIEWED_STATE_CONTRACT,
  createGoonRecipeDocument,
  parseGoonRecipeDocument,
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
  verifyRecipeReviewedState,
  type GoonRecipeDocument,
  type GoonRecipeJob,
  type GoonRecipeV2,
  type RecipeDocumentRef,
  type RecipeRevisionEnvelope
} from '$lib/goons/recipe'

/**
 * BL-378 Phase 1b [A5]: `schemaVersion` marks reader compatibility only. Every complete export
 * writes 1, as every exporter since the constant was introduced (330f1d8d9) has; only a partial
 * export writes 2, so every Batshit released before it refuses a partial archive loudly instead
 * of restoring it as if it were whole.
 */
export const BACKUP_COMPLETE_SCHEMA_VERSION = 1
/** The long-standing name, still 1: what a complete export writes. */
export const BATSHIT_BACKUP_SCHEMA_VERSION = BACKUP_COMPLETE_SCHEMA_VERSION
export const BACKUP_PARTIAL_SCHEMA_VERSION = 2
/** The highest schema this build reads; each version must also match its partial-backup fields. */
export const BACKUP_READER_MAX_SCHEMA_VERSION = 2

function withRecipeVerificationRestore<T>(restore: () => Promise<T>, recover = false): Promise<T> {
  return withRecipeVerificationRestoreEpoch(() =>
    withGoonAssetRestoreBarrier(resolveBackupStagingDir(), async () => {
      if (!recover) await assertNoGoonAssetMaintenanceForRestore()
      return restore()
    }, { recover }))
}

const MANIFEST_PATH = 'manifest.json'
const LEGACY_REDIS_RECORDS_PATH = 'redis/records.json'
const REDIS_RECORDS_DIR = 'redis/records/'
const UPLOAD_FILE_ROOT = 'files/uploads/'
const DEFAULT_APP_VERSION = '0.0.1'
const UTF8_ZIP_FLAG = 0x0800
const DATA_DESCRIPTOR_FLAG = 0x0008
const DEFLATE_METHOD = 8
const ZIP32_MAX = 0xffffffff
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
  'batshit:sub_system_prompt',
  'batshit:worker_prompt',
  'batshit:subagent_guidance',
  'batshit:tool_guidance_zip_enabled_prompt',
  'batshit:tool_guidance_zip_disabled_prompt',
  'batshit:tool_guidance_memory_prompt',
  'batshit:dm_guidance',
  'batshit:jev_juice_guidance',
  'batshit:dynamic_mcp_prompt',
  'batshit:batshit_primary_system_prompt',
  'batshit:primary_system_prompt',
  'batshit:system_prompt',
  'batshit:batshit_mode3_system_prompt:last_updated',
  'batshit:batshit_mode4_system_prompt:last_updated',
  'batshit:sub_system_prompt:last_updated',
  'batshit:worker_prompt:last_updated',
  'batshit:subagent_guidance:last_updated',
  'batshit:tool_guidance_zip_enabled_prompt:last_updated',
  'batshit:tool_guidance_zip_disabled_prompt:last_updated',
  'batshit:tool_guidance_memory_prompt:last_updated',
  'batshit:dm_guidance:last_updated',
  'batshit:jev_juice_guidance:last_updated',
  'batshit:dynamic_mcp_prompt:last_updated',
  'batshit:batshit_primary_system_prompt:last_updated',
  'batshit:primary_system_prompt:last_updated',
  'batshit:system_prompt:last_updated'
] as const

/**
 * BL-372: each core prompt's metadata (which default its text was, and whether the user edited
 * it) travels beside the text. Without it a restore into a newer Batshit left the old default
 * in place, read as customized with no "new default available", because the instance's own
 * metadata already described the new default.
 */
const SYSTEM_PROMPT_META_KEYS: readonly string[] = listCoreSystemPromptDefinitions().map((definition) =>
  corePromptMetadataKey(definition.id)
)

const SYSTEM_PROMPT_META_PREFIX = 'batshit:system_prompt_meta:'

function isSystemPromptKey(key: string) {
  return (
    SYSTEM_PROMPT_KEYS.includes(key as (typeof SYSTEM_PROMPT_KEYS)[number]) ||
    SYSTEM_PROMPT_META_KEYS.includes(key)
  )
}

/**
 * Metadata of a core prompt this Batshit no longer lists. Once a prompt is retired, backups made
 * before that still carry its metadata; `buildTargetRecords` leaves it out before the
 * restorable-key check (which would otherwise fail the whole restore), and the preflight says
 * so (`describeRetiredPromptMetadata`).
 */
function isRetiredPromptMetadataKey(key: string) {
  return key.startsWith(SYSTEM_PROMPT_META_PREFIX) && !SYSTEM_PROMPT_META_KEYS.includes(key)
}

function describeRetiredPromptMetadata(records: BackupRedisRecord[]) {
  const retired = records
    .filter((record) => isRetiredPromptMetadataKey(record.key))
    .map((record) => record.key.slice(SYSTEM_PROMPT_META_PREFIX.length))
  if (retired.length === 0) return []
  return [
    `This backup carries settings for core prompts this Batshit no longer has (${retired.join(', ')}). Batshit leaves them out.`
  ]
}

/**
 * BL-371: a custom provider's Extra Headers are free-form, so the header NAME cannot say
 * whether its value is a secret (`Authorization`, `cf-aig-authorization`, and
 * `Ocp-Apim-Subscription-Key` all carry credentials and match no secret field rule). A normal
 * backup therefore leaves out every header value except the ones on this short reviewed list,
 * which only describe the request or name the app. Compared case-insensitively.
 */
const NON_SECRET_CUSTOM_PROVIDER_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  // OpenRouter's app attribution headers.
  'http-referer',
  'x-title',
  // API version and beta switches.
  'anthropic-version',
  'anthropic-beta',
  'openai-beta'
])

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
    id: 'dms',
    label: 'Agent DMs, wake-up webhooks, and schedules',
    classification: 'required',
    description:
      'Agent-to-agent DMs, their inbox/sent indexes, the wake-up webhook records, and the schedules that put agents on a clock. Wake-up webhook TOKENS are not stored anywhere and cannot be restored; a restored hook must be rotated before it works again.'
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
    description:
      'Voice profiles, the reference recordings of clone voices, and engine registry references. Installed local runtimes and model weights are not included.'
  },
  {
    id: 'tools',
    label: 'Tools, MCP gateways, skills, and slash commands',
    classification: 'optional',
    description: 'CLI tools, MCP gateway records, slash commands, and user skills with their files.'
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

/**
 * BL-378 Phase 1b: one upload record a partial backup lists as missing. The file is not in the
 * archive; the record is (`archivedRecordSha256` is the sha256 of that archived record).
 */
export interface BackupMissingUploadEntry {
  key: string
  relativePath: string
  kind: 'missing'
  /** The stored record's fingerprint, as the export read it (it equals the acknowledged one). */
  fingerprint: string
  archivedRecordSha256: string
}

export interface BackupManifest {
  schemaVersion: typeof BACKUP_COMPLETE_SCHEMA_VERSION | typeof BACKUP_PARTIAL_SCHEMA_VERSION
  /** BL-378 Phase 1b: only a partial (schema 2) backup has this, and `uploads`. */
  completeness?: 'partial'
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
    /** BL-373/BL-369: `files/host/` entries (skill folders, clone voice recordings). Absent in older backups. */
    hostFileCount?: number
    hostFileBytes?: number
    /** BL-378 Phase 1b, partial backups only: the listed records, and the distinct files they name. */
    missingUploadRecordCount?: number
    missingUploadFileCount?: number
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
  /**
   * BL-373/BL-369: the host-file limits this backup was made under, and every skill or voice
   * folder it could not carry whole (with the reason). Absent in backups made before host files.
   */
  hostFiles?: {
    limits: { maxFileBytes: number; maxFolderBytes: number; maxFolderFiles: number }
    notCarried: HostFolderNotCarried[]
  }
  /** BL-378 Phase 1b, partial backups only: every upload record whose file the backup does not hold. */
  uploads?: { missing: BackupMissingUploadEntry[] }
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
  /** BL-378 Phase 1b: how a partial request's acknowledged entries ended; null without one. */
  missingUploads: BackupMissingUploadsSummary | null
}

export interface BackupPreflightSummary {
  ok: true
  manifest: BackupManifest
  redisRecordCount: number
  fileAssetCount: number
  fileAssetBytes: number
  hostFileCount: number
  hostFileBytes: number
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
  hostFileCount: number
  hostFileBytes: number
  /** BL-373 review: the skill and voice folders this restore replaced, and where their previous copy is kept. */
  keptHostFolders: KeptHostFolder[]
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
  groupId: BackupGroupId
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

/**
 * The end of a backup: the host folders the export actually wrote (a folder whose files changed
 * after the walk is left out whole) decide the manifest, so the manifest is the last entry.
 */
type FinishBackupManifest = (written: HostFileExportAsset[], changed: HostFolderNotCarried[]) => Uint8Array

/** Resolves once the stream has emitted 'close' (at once if it already has). */
function streamClosed(stream: Readable) {
  if (stream.closed) return Promise.resolve()
  return new Promise<void>((resolve) => stream.once('close', () => resolve()))
}

/**
 * BL-1390: the zip path of the entry the stream is writing (null in the central directory), so a
 * failure after the response began can name it. Set before each entry's own reads start.
 */
type ZipStreamPosition = { entry: string | null }

async function* createZipChunks(
  memoryEntries: ZipMemoryEntry[],
  fileAssets: BackupFileAsset[],
  hostFolders: HostFolderExport[] = [],
  finishManifest?: FinishBackupManifest,
  position: ZipStreamPosition = { entry: null }
): AsyncGenerator<Buffer> {
  const { dosDate, dosTime } = getDosDateTime()
  const centralRecords: ZipCentralRecord[] = []
  let offset = 0

  function track(chunk: Buffer) {
    offset += chunk.length
    assertSafeZipOffset(offset, 'Backup is too large for the zip bundle format.')
    return chunk
  }

  function* memoryEntry(entry: ZipMemoryEntry): Generator<Buffer> {
    position.entry = entry.name
    const data = Buffer.from(entry.data)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const localOffset = offset
    yield track(createStreamingLocalHeader(nameBytes, dosDate, dosTime))
    yield track(nameBytes)
    const compressed = deflateRawSync(data, { level: 6 })
    const crc = crc32(data)
    yield track(compressed)
    yield track(createDataDescriptor(crc, compressed.length, data.length))
    centralRecords.push({ nameBytes, crc, compressedSize: compressed.length, size: data.length, localOffset, dosDate, dosTime })
  }

  async function* streamedEntry(zipPath: string, label: string, expectedSize: number, source: Readable): AsyncGenerator<Buffer> {
    // BL-1387: join the file to the deflate stream with `pipeline`, before the first yield. An
    // error from the file (it cannot be opened, or a read fails midway) then destroys `compressed`
    // with that error, so it reaches the catch below even while this generator waits at a header
    // yield, and an error on either side destroys both. `source.pipe()` forwarded no source error:
    // it escaped as an uncaught exception. The pipeline's own promise rejects with the error the
    // loop sees. Besides the close this entry causes itself in `finally`, the one error only it
    // can see is a failed close after the file ended, when every byte was already read and
    // counted, so it is only observed here.
    position.entry = zipPath
    const compressed = createDeflateRaw({ level: 6 })
    let crc = 0xffffffff
    let size = 0
    let compressedSize = 0
    source.on('data', (chunk: Buffer | Uint8Array) => {
      const bytes = toBufferChunk(chunk)
      crc = crc32Update(crc, bytes)
      size += bytes.length
    })
    pipeline(source, compressed).catch(() => undefined)
    try {
      const nameBytes = Buffer.from(zipPath, 'utf8')
      const localOffset = offset
      yield track(createStreamingLocalHeader(nameBytes, dosDate, dosTime))
      yield track(nameBytes)
      try {
        for await (const chunk of compressed) {
          const buffer = toBufferChunk(chunk)
          compressedSize += buffer.length
          assertZipUint32(compressedSize, `Backup asset "${label}" is too large for one zip entry.`)
          yield track(buffer)
        }
      } catch (error) {
        if (error instanceof BackupRestoreError) throw error
        const failure = new BackupRestoreError(`Backup failed while streaming "${label}".`, 500, error instanceof Error ? error.message : null)
        // BL-1390: the stream's failure log reads the system code (EACCES, EIO) from here.
        failure.cause = error
        throw failure
      }
      if (size !== expectedSize) {
        throw new BackupRestoreError(`Backup file "${label}" changed while the export was running. Try the export again.`, 409)
      }
      const finalizedCrc = (crc ^ 0xffffffff) >>> 0
      yield track(createDataDescriptor(finalizedCrc, compressedSize, size))
      centralRecords.push({ nameBytes, crc: finalizedCrc, compressedSize, size, localOffset, dosDate, dosTime })
    } finally {
      // Every way out, including a cancelled download that stops this generator at a yield, ends
      // both streams: the file is closed and nothing keeps reading it. BL-1401: and waits until
      // both have closed (a read in flight finishes first), so the export's hold on the restore
      // gate, which ends only after this generator has settled, outlasts its open files.
      source.destroy()
      compressed.destroy()
      await Promise.all([streamClosed(source), streamClosed(compressed)])
    }
  }

  for (const entry of memoryEntries) {
    if (finishManifest && entry.name === MANIFEST_PATH) continue
    yield* memoryEntry(entry)
  }

  for (const asset of fileAssets) {
    // A legacy upload's Redis read comes before its entry starts: name this entry, not the last.
    position.entry = asset.zipPath
    yield* streamedEntry(asset.zipPath, asset.relativePath, asset.byteLength, await createAssetReadStream(asset))
  }

  if (finishManifest) {
    const written: HostFileExportAsset[] = []
    const changed: HostFolderNotCarried[] = []
    for (const folder of hostFolders) {
      position.entry = `${HOST_FILE_ZIP_ROOT}${folder.root}/${folder.folder}/`
      const notCarried = await checkHostFolderFiles(folder).catch(asExportError)
      if (notCarried) {
        changed.push({ root: folder.root, folder: folder.folder, ownerKey: folder.ownerKey, label: folder.label, reason: notCarried })
        continue
      }
      for (const file of folder.files) {
        const label = `${file.root}/${file.folder}/${file.relativePath}`
        // Checked a moment ago; opened again one at a time. A file that changed in between can
        // no longer be left out (earlier files of its folder are written), so the export fails,
        // as it does for a file that changes size mid-stream.
        let handle: Awaited<ReturnType<typeof openWalkedHostFile>>
        position.entry = file.zipPath
        try {
          handle = await openWalkedHostFile(file)
        } catch (error) {
          failOnHandleExhaustion(error)
          throw new BackupRestoreError(`Backup file "${label}" changed while the export was running. Try the export again.`, 409)
        }
        const source = handle.createReadStream({ autoClose: true })
        try {
          yield* streamedEntry(file.zipPath, label, file.byteLength, source)
        } finally {
          // A finished stream closed its handle; an error or an aborted download may not have.
          await handle.close().catch(() => undefined)
        }
        written.push(file)
      }
    }
    position.entry = MANIFEST_PATH
    yield* memoryEntry({ name: MANIFEST_PATH, data: finishManifest(written, changed) })
  }

  position.entry = null
  const centralOffset = offset
  for (const record of centralRecords) {
    yield track(createCentralEntry(record))
  }
  const centralSize = offset - centralOffset
  for (const part of createEndOfCentralDirectory(centralRecords.length, centralSize, centralOffset, offset)) {
    yield track(part)
  }
}

const SYSTEM_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

/** The error's own system code (EACCES, ENOENT, EIO, Z_DATA_ERROR), or its cause's. */
function systemErrorCodeOf(error: unknown): string | null {
  for (const candidate of [error, error instanceof Error ? error.cause : null]) {
    const code = candidate && typeof candidate === 'object' ? (candidate as { code?: unknown }).code : null
    if (typeof code === 'string' && SYSTEM_ERROR_CODE.test(code)) return code
  }
  return null
}

/** An async iterator whose `return()` and `throw()` are always there, as an async generator's are. */
type ZipChunkIterator = AsyncIterableIterator<Buffer> & Required<Pick<AsyncIterator<Buffer>, 'return' | 'throw'>>

/**
 * BL-1390: logs a failure of the zip stream once, where the response body pulls it. By then the
 * client has its 200, so the error never reaches it, and the route's catch never sees it. Only a
 * rejected `next()` is a failure of the export. A download the client stops reaches the
 * generator through `throw()` (an AbortError even for a plain cancel, or the error a cancel carries) or
 * `return()`, and the file entry's catch wraps that into "Backup failed while streaming" too, so
 * those calls pass through unlogged; so does the `throw()` with which `Readable.from` cleans up
 * after a failure it already received from `next()`. A stop cannot make `next()` reject (a
 * `throw()` waits behind a pending `next()`), so `stoppedFromOutside` only silences a real
 * failure that lands after the client has gone. The log names the entry (its zip path,
 * relative), the BackupRestoreError status and sentence (which names only a relative path) and
 * the system code. Never `details` (it carries the absolute path), file contents, or the error
 * object; any other error logs only its name, since its message can carry an absolute path.
 */
function logZipStreamFailure(chunks: AsyncGenerator<Buffer>, position: ZipStreamPosition): ZipChunkIterator {
  let stoppedFromOutside = false
  const iterator: ZipChunkIterator = {
    next: () =>
      chunks.next().catch((error: unknown) => {
        if (!stoppedFromOutside) {
          console.error('[backup-export] failed after the download began:', {
            entry: position.entry,
            status: error instanceof BackupRestoreError ? error.status : null,
            code: systemErrorCodeOf(error),
            error:
              error instanceof BackupRestoreError
                ? error.message
                : error instanceof Error
                  ? String(error.name).slice(0, 100)
                  : typeof error
          })
        }
        throw error
      }),
    return: (value?: unknown) => {
      stoppedFromOutside = true
      return chunks.return(value as undefined)
    },
    throw: (error?: unknown) => {
      stoppedFromOutside = true
      return chunks.throw(error)
    },
    [Symbol.asyncIterator]: () => iterator
  }
  return iterator
}

/**
 * BL-1401: the export streams after its route has answered, and the request's own hold on the
 * restore gate ends with that answer (hooks.server.ts), so the stream holds the gate itself, as a
 * detached chat turn does (respondAsyncSend.ts). It ends that hold when the stream is over: its
 * last `next()` is done or rejected, or a `return()`/`throw()` from outside (a cancel, or
 * `Readable.from`'s cleanup after a failure) has settled. The zip generator settles each of these
 * only after its cleanup (every file entry's `finally` waits for its file and deflate streams to
 * close; a generator that never started has nothing open). `endWork` is the permit's own
 * once-only release, so the first of these ends the hold and the rest do nothing.
 */
function endWorkWhenZipStreamEnds(chunks: ZipChunkIterator, endWork: () => void): ZipChunkIterator {
  const iterator: ZipChunkIterator = {
    next: () =>
      chunks.next().then(
        (step) => {
          if (step.done) endWork()
          return step
        },
        (error: unknown) => {
          endWork()
          throw error
        }
      ),
    return: (value?: unknown) => chunks.return(value).finally(endWork),
    throw: (error?: unknown) => chunks.throw(error).finally(endWork),
    [Symbol.asyncIterator]: () => iterator
  }
  return iterator
}

function createZipReadableStream(
  entries: Record<string, Uint8Array>,
  fileAssets: BackupFileAsset[],
  hostFolders: HostFolderExport[],
  finishManifest: FinishBackupManifest,
  endWork: () => void
) {
  const memoryEntries = normalizeZipMemoryEntries(entries)
  const sortedFileAssets = [...fileAssets].sort((left, right) => left.zipPath.localeCompare(right.zipPath))
  validateZipInputs(memoryEntries, [...sortedFileAssets, ...hostFolders.flatMap(hostFolderAssets)])
  const position: ZipStreamPosition = { entry: null }
  const chunks = createZipChunks(memoryEntries, sortedFileAssets, hostFolders, finishManifest, position)
  return Readable.toWeb(Readable.from(endWorkWhenZipStreamEnds(logZipStreamFailure(chunks, position), endWork), { objectMode: false }))
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

function isCustomProviderRecordKey(key: string) {
  return key.startsWith('custom_provider:')
}

/**
 * BL-371: decided by key family, not by field name. Every Extra Header value of a custom
 * provider is nulled in a normal backup unless the header is on the reviewed non-secret list.
 * The header name stays, so the restore summary can say which values to enter again.
 */
function redactCustomProviderHeaders(key: string, value: unknown, state: RedactionState): unknown {
  if (!isCustomProviderRecordKey(key) || !isPlainObject(value) || !isPlainObject(value.headers)) {
    return value
  }
  const headers: Record<string, unknown> = {}
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (
      headerValue === null ||
      headerValue === undefined ||
      NON_SECRET_CUSTOM_PROVIDER_HEADERS.has(name.trim().toLowerCase())
    ) {
      headers[name] = headerValue
      continue
    }
    headers[name] = null
    state.redactedFieldCount += 1
    state.redactedPaths.add(`${key}.headers.${name}`)
  }
  return { ...value, headers }
}

/** The custom providers whose Extra Header values a normal backup left out (BL-371). */
function describeStrippedCustomProviderHeaders(records: BackupRedisRecord[]) {
  const warnings: string[] = []
  for (const record of records) {
    if (!isCustomProviderRecordKey(record.key) || !isPlainObject(record.value)) continue
    const headers = record.value.headers
    if (!isPlainObject(headers)) continue
    const stripped = Object.entries(headers)
      .filter(([, headerValue]) => headerValue === null)
      .map(([name]) => name)
    if (stripped.length === 0) continue
    const label =
      typeof record.value.label === 'string' && record.value.label.trim() ? record.value.label.trim() : record.key
    warnings.push(
      `Custom provider "${label}" comes back without the ${stripped.length === 1 ? 'value' : 'values'} of ` +
        `${stripped.length === 1 ? 'its Extra Header' : 'its Extra Headers'} ${stripped.join(', ')}, because this backup ` +
        'leaves secrets out. Enter them again in Settings → API Keys → Custom OpenAI-Compatible, with its API key.'
    )
  }
  return warnings
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
    [`user_artifact_usage:${sourceUserId}`, `user_artifact_usage:${targetUserId}`],
    // SA-113 P2 (DL-113-02): the two user-scoped DM/webhook keys. The DM records and the
    // per-agent inbox/sent indexes are agent-scoped and need no remap.
    [`dm_index:${sourceUserId}`, `dm_index:${targetUserId}`],
    [`wake_hooks:${sourceUserId}`, `wake_hooks:${targetUserId}`],
    // SA-115 P3 (DL-115-12): the schedule INDEX is user-scoped and needs the same remap.
    // The `schedule:{id}` records are not — their ids carry no user segment, and the
    // `userId` field inside each record is rewritten by the record-level user remap.
    [`schedules:${sourceUserId}`, `schedules:${targetUserId}`]
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
  if (isSystemPromptKey(key)) return 'prompts'
  if (key.startsWith('upload:memory-media:')) return 'memory'
  if (
    key === `user:${userId}:settings` ||
    key === `project_prefs:${userId}` ||
    key === `icon_library:${userId}:prefs` ||
    key === 'system:settings:docker-mcp' ||
    // SA-120: the instance-level Judge Juice config (master switch, pinned model, timeout).
    key === 'batshit:typesafe_config'
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
    // BL-370: the Motion Vault list. Admin Goon Asset Cleanup finds Motion Vault files only
    // through this key, so a restore without it would offer the restored files as orphans.
    key === `user:${userId}:goons_animation_library` ||
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
    key.startsWith('dm:') ||
    key.startsWith('dm_inbox:') ||
    key.startsWith('dm_sent:') ||
    key.startsWith('dm_index:') ||
    key.startsWith('wake_hook:') ||
    key.startsWith('wake_hooks:') ||
    // SA-115 P3: the clock rides in the same group as the DMs it writes.
    key.startsWith('schedule:') ||
    key.startsWith('schedules:')
  ) {
    return 'dms'
  }
  if (
    key.startsWith('memory:') ||
    key.startsWith('memseg:') ||
    key.startsWith('memdream:') ||
    key.startsWith('memdream_index:') ||
    key.startsWith('memfold:') ||
    key.startsWith('episode:') ||
    key.startsWith('memlinger:') ||
    /^session:[^:]+:episodes$/.test(key) ||
    key === 'batshit:memory_config' ||
    key === 'batshit:memory_index_meta' ||
    key === 'batshit:memory_media_migration:v1'
  ) {
    return 'memory'
  }
  return 'chats'
}

function isRestorableKeyForUser(key: string, userId: string) {
  if (isSystemPromptKey(key)) return true
  if (key === 'system:settings:docker-mcp') return true
  if (key === 'batshit:typesafe_config') return true
  if (
    key === 'batshit:memory_config' ||
    key === 'batshit:memory_index_meta' ||
    key === 'batshit:memory_media_migration:v1'
  ) return true

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
    `user:${userId}:goons_animation_library`,
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
    `dm_index:${userId}`,
    `wake_hooks:${userId}`,
    `schedules:${userId}`,
    `folder:${userId}:`,
    `project:${userId}:`,
    `api_keys:${userId}:`,
    `custom_provider:${userId}:`,
    `local_provider:${userId}:`,
    `clip:${userId}:`,
    // Collected and grouped under `artifacts` since the artifact order shipped, but missing
    // here, so the export's final filter dropped it: no backup ever carried the panel or
    // header order (BL-211, found with BL-128).
    `user:${userId}:artifact_order:`,
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
    // SA-120 P6: what the Judge Juice after-reply check noticed about a reply (the chip under it).
    // Chat data, written only by `postTurnCheckState.ts`.
    'jev_post_turn:',
    'jev_post_turn_item:',
    'codex_cleanup_warnings:',
    'codex_cleanup_warning:',
    // BL-474 step 2: where each reply's outside pictures came from (`imageAddressOrigins.ts`).
    'image_origins:',
    'image_origin:',
    'session_clip:',
    'subagent_sessions:',
    // SA-111 P2 (DL-111-06): the Batshit-issued n8n Workflow Subagent thread id. The
    // conversation itself lives in n8n's Redis and is not Batshit's to back up, but the id
    // that names it is session data. The in-flight `subagent_lock:` keys are deliberately
    // absent — transient run state, never restored.
    //
    // SA-117 P1 (DL-117-09): `agent_run_credential:` and `agent_run_credentials:` are
    // deliberately absent for the same reason, and it is worth saying why the usual
    // "a hash is not a secret" argument does not apply. A wake hook's `tokenHash` IS backed
    // up, because the hook is a durable thing the user created and dropping the hash would
    // leave every restored hook permanently unauthenticatable with no way to say which. A run
    // credential is the opposite: it names one managed CLI run that ended, so a restored one
    // could only ever authenticate as an agent for a turn nobody is taking. Absent from this
    // list means absent from BOTH `collectCandidateKeys` (never exported) and
    // `isRestorableKeyForUser` (a hand-built archive carrying one is refused outright at
    // `buildTargetRecords`), and `backupRestoreService.test.ts` pins both halves.
    'subagent_thread:',
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
    'memfold:',
    'episode:',
    'memlinger:',
    // SA-113 P2 (DL-113-02). DMs are agent-scoped, so they follow the agent-prefix shape
    // the memory keys use rather than a user prefix.
    'dm:',
    'dm_inbox:',
    'dm_sent:',
    'wake_hook:',
    // SA-115 P3: `schedule:sch_…` carries no user segment, so it follows the agent/global
    // prefix shape. `schedules:{userId}` is handled by the user-prefix list above, and the
    // two can never be confused: an id is `sch_…` and a user id can never start `sch_`.
    'schedule:'
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
    // SA-116 DL-116-02: a risk approval is transient consent for ONE call in ONE chat.
    // Restoring a fortnight-old "approved" record would be a click nobody made, in a
    // session that may not exist any more. Listed here rather than left to the fact that no
    // pattern happens to collect it, so the exclusion is something a test can read.
    key.startsWith('control_approval:') ||
    key.startsWith('control_approvals:') ||
    key.startsWith('control_risk_approval:') ||
    key.startsWith('codex_bridge:')
  )
}

async function readRedisRecord(client: any, key: string, groupId: BackupGroupId, requireRecoverable = false): Promise<BackupRedisRecord | null> {
  const rawType = await client.type(key)
  const type = normalizeRedisType(rawType)
  if (!type) {
    if (requireRecoverable && rawType !== 'none') {
      throw new BackupRestoreError('Current Hair job state has an unsupported Redis type. Restore stopped before replacement.', 500)
    }
    return null
  }

  let value: unknown
  if (type === 'json') {
    // With no path, JSON.GET answers the stored value itself, so nothing is unwrapped. A list
    // with one entry is still a list: flattening it saved a chat's one-run Execution Viewer
    // log as the bare run, which the viewer cannot read after a restore (BL-128; BL-118 was
    // the same unwrap in the artifact list).
    value = await client.json.get(key)
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
  if (requireRecoverable) {
    // Missing rows are benign. Local rollback has relative TTLs, not absolute
    // deadlines: replaying an expiring control row could revive cleanup authority.
    if (ttl === -2) return null
    const strings = (items: unknown): items is string[] =>
      Array.isArray(items) && items.length > 0 && items.every((item) => typeof item === 'string')
    const recoverable = type === 'json' ? value !== undefined :
      type === 'string' ? typeof value === 'string' :
      type === 'set' || type === 'list' ? strings(value) :
      type === 'hash' ? isPlainObject(value) && Object.keys(value).length > 0 && Object.values(value).every((item) => typeof item === 'string') :
      Array.isArray(value) && value.length > 0 && value.every((item) =>
        isPlainObject(item) && typeof item.value === 'string' && typeof item.score === 'number' && Number.isFinite(item.score))
    if (!recoverable || ttl !== -1) {
      throw new BackupRestoreError('Current Hair job state could not be captured for rollback. Restore stopped before replacement.', 500)
    }
  }
  return {
    key,
    type,
    value,
    ttlSeconds: ttl > 0 ? ttl : null,
    groupId
  }
}

/** Local rollback only: these keys never acquire archive/import authority. */
async function captureCurrentHairJobRecords(client: any, userId: string) {
  const prefix = `hair_import_job:${userId}:`
  const matches: unknown = await client.keys(`${prefix.replace(/[\\*?[\]]/g, '\\$&')}*`)
  if (!Array.isArray(matches) || matches.some((key) => typeof key !== 'string' || !key.startsWith(prefix))) {
    throw new BackupRestoreError('Current Hair job inventory is outside the target namespace. Restore stopped before replacement.', 500)
  }
  const keys = new Set<string>([...matches, `user:${userId}:hair_import_jobs`])
  const records: BackupRedisRecord[] = []
  for (const key of [...keys].sort()) {
    const record = await readRedisRecord(client, key, groupForKey(key, userId), true)
    if (record) records.push(record)
  }
  return records
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

/** SA-113 P2: the DM indexes are sorted sets, not sets — same shape of safe read. */
async function safeZsetMembers(client: any, key: string) {
  try {
    if ((await client.exists(key)) !== 1) return []
    const type = await client.type(key)
    if (type !== 'zset') return []
    const members = await client.zRange(key, 0, -1)
    return Array.isArray(members) ? (members as string[]) : []
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
    `user:${userId}:goons_animation_library`,
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
    'batshit:typesafe_config',
    'batshit:memory_config',
    'batshit:memory_index_meta',
    'batshit:memory_media_migration:v1',
    ...SYSTEM_PROMPT_KEYS,
    ...SYSTEM_PROMPT_META_KEYS
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
      `jev_post_turn:${sessionId}`,
      `codex_cleanup_warnings:${sessionId}`,
      `image_origins:${sessionId}`,
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
    await addPatternKeys(keys, client, `subagent_thread:${sessionId}:*`)
    await addPatternKeys(keys, client, `unzipped_item:${sessionId}:*`)
    await addPatternKeys(keys, client, `rezipped_item:${sessionId}:*`)
    await addPatternKeys(keys, client, `jev_post_turn_item:${sessionId}:*`)
    await addPatternKeys(keys, client, `codex_cleanup_warning:${sessionId}:*`)
    await addPatternKeys(keys, client, `image_origin:${sessionId}:*`)
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
    await addExistingKey(keys, client, `memfold:${agentId}`)
    await addPatternKeys(keys, client, `upload:memory-media:${agentId}/*`)
    // SA-113 P2: the agent's inbox and sent indexes. The DM records themselves are
    // collected from those indexes below, because a DM's id carries no agent segment.
    await addExistingKey(keys, client, `dm_inbox:${agentId}`)
    await addExistingKey(keys, client, `dm_sent:${agentId}`)
  }

  // SA-113 P2: DM records, reached through the per-user index so a DM whose recipient was
  // deleted is still exported while its record survives retention.
  await addExistingKey(keys, client, `dm_index:${userId}`)
  await addExistingKey(keys, client, `wake_hooks:${userId}`)
  for (const dmId of await safeZsetMembers(client, `dm_index:${userId}`)) {
    await addExistingKey(keys, client, `dm:${dmId}`)
  }
  for (const hookId of await safeSetMembers(client, `wake_hooks:${userId}`)) {
    await addExistingKey(keys, client, `wake_hook:${hookId}`)
  }

  // SA-115 P3: schedules, reached through their user-scoped index the same way — a SET,
  // like `wake_hooks:`, so `safeSetMembers` is the right reader.
  await addExistingKey(keys, client, `schedules:${userId}`)
  for (const scheduleId of await safeSetMembers(client, `schedules:${userId}`)) {
    await addExistingKey(keys, client, `schedule:${scheduleId}`)
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
    value: redactSecretFields(
      record.key,
      redactCustomProviderHeaders(record.key, cloneJson(record.value), redactions),
      redactions
    )
  }
}

/** Hair discovery/values/ownership share one atomic cut; all other records keep their reader.
 * Non-Hair values collected here may only retain uploads, never establish disposal ownership. */
async function collectExportRecords(client: any, keys: string[], userId: string) {
  const captured: BackupRedisRecord[] = []
  for (const key of keys) {
    if (isHairSnapshotKey(key)) continue
    const record = await readRedisRecord(client, key, groupForKey(key, userId))
    if (record) captured.push(record)
  }
  if (!needsHairBackupSnapshot(keys)) return { records: captured, omittedStagingKeys: new Set<string>() }
  // One explicit durable-owner policy for both audit/export. Reuse archived values;
  // extra owner records only conserve referenced files and are never silently archived.
  const retained = new Map(captured.filter((record) => isRetainedHairOwnerKey(record.key)).map((record) => [record.key, record]))
  for (const pattern of RETAINED_HAIR_OWNER_PATTERNS) {
    for (const key of await client.keys(pattern)) {
      if (retained.has(key)) continue
      const record = await readRedisRecord(client, key, groupForKey(key, userId))
      if (record) retained.set(key, record)
    }
  }
  const snapshot = await readHairBackupSnapshot(client)
  const omitted = stagedHairUploadKeys(snapshot, [...retained.values()])
  for (const record of snapshot.values()) {
    if (isRestorableKeyForUser(record.key, userId) && !omitted.has(record.key)) {
      captured.push({ ...record, groupId: groupForKey(record.key, userId) })
    }
  }
  return { records: captured.sort((left, right) => left.key.localeCompare(right.key)), omittedStagingKeys: omitted }
}

/**
 * Reads every exported record once. BL-378 Phase 1b [A4]: with `fingerprintUploads`, the same
 * single read of each upload record also gives its fingerprint, from the value as read (before
 * redaction and normalization, as the upload check computes it), so a partial export compares an
 * acknowledgement with its own snapshot and never reads a record a second time.
 */
async function collectRedisRecords(options: CollectOptions, collect: { fingerprintUploads?: boolean } = {}) {
  const redactions: RedactionState = {
    excludedRecordCount: 0,
    redactedFieldCount: 0,
    redactedPaths: new Set()
  }
  const redisBase64Assets: RedisBase64BackupFileAsset[] = []
  const uploadFingerprints = new Map<string, string>()
  let omittedStagingKeys = new Set<string>()

  const records = await redis.execute(async (client) => {
    const keys = await collectCandidateKeys(client, options.userId)
    const collected: BackupRedisRecord[] = []
    const cut = await collectExportRecords(client, keys, options.userId)
    omittedStagingKeys = cut.omittedStagingKeys
    for (const record of cut.records) {
      const key = record.key
      if (collect.fingerprintUploads && key.startsWith('upload:')) {
        uploadFingerprints.set(key, uploadRecordFingerprint(key, record.value))
      }
      const normalized = normalizeRecordForExport(record, options, redactions)
      if (normalized) {
        const uploadNormalized = normalizeUploadRecordForExport(normalized)
        if (uploadNormalized.redisBase64Asset) redisBase64Assets.push(uploadNormalized.redisBase64Asset)
        collected.push(uploadNormalized.record)
      }
    }
    return collected
  })

  return { records, redactions, redisBase64Assets, uploadFingerprints, omittedStagingKeys }
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

/**
 * BL-1379: a file-backed record with no `relativePath` and no Base64 copy names its file only
 * by `filePath`, and batshit-server serves it from there when that path lies inside its upload
 * folder (`resolveFilesystemUploadPath`, serve-uploads.js). The export takes the same path, so
 * the two agree: for a typed avatar `upload:avatars:agent:a.jpg` whose file is
 * `<root>/avatars/a.jpg`, the key would say `avatars/agent/a.jpg`. Only an absolute `filePath`
 * strictly inside the current upload folder counts; anything else (another folder, a relative
 * path, one that climbs out with `..`) keeps the key's path, so the check still looks there and
 * reports the file missing. The resolved file is still checked through `safeJoin`.
 */
function inRootFilePathForExport(value: unknown) {
  if (!isPlainObject(value) || !isFilesystemBackedUploadValue(value)) return null
  if (typeof value.base64 === 'string' && value.base64.length > 0) return null
  const filePath = typeof value.filePath === 'string' ? value.filePath : ''
  if (!filePath || !path.isAbsolute(filePath)) return null
  const uploadRoot = resolveUploadsDir()
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(`${uploadRoot}${path.sep}`)) return null
  return toPosixPath(path.relative(uploadRoot, resolved))
}

function uploadRelativePathForExport(record: BackupRedisRecord) {
  const existing = normalizeUploadRelativePath(record.value)
  if (existing) return existing

  const fromFilePath = inRootFilePathForExport(record.value)
  if (fromFilePath) return fromFilePath

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
      groupId: record.groupId,
      redisKey: record.key,
      zipPath: `${UPLOAD_FILE_ROOT}${relativePath}`,
      relativePath,
      byteLength: declaredSize
    }
  }
}

interface UploadRecordTarget extends UploadInspectionTarget {
  groupId: BackupGroupId
}

/**
 * BL-1380: an upload record stored as a Redis string (no current writer makes one, but a
 * restore keeps each record's type) travels in the archive exactly as stored: it is never
 * normalized, so the file it names never reaches the archive, while batshit-server parses the
 * string and serves that file. When the string is a JSON object that names a file
 * (`relativePath` or `filePath`), the record is reported as an `unsupported-record` problem,
 * which stops a normal export like any other problem, instead of the backup leaving its file
 * out without a word. A Base64 copy inside the string changes nothing: the server serves the
 * named file first and never falls back to the copy (`serveFileBackedUpload`). Nothing converts
 * the record. A string that names no file (its content, if any, is inside it) still travels as
 * it is.
 */
function unsupportedStringUploadTarget(record: BackupRedisRecord): UploadRecordTarget | null {
  if (record.type !== 'string' || typeof record.value !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(record.value)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const namesFile = [parsed.relativePath, parsed.filePath].some(
    (field) => typeof field === 'string' && field.trim().length > 0
  )
  if (!namesFile) return null
  const { size, uploadedAt, originalName, sha256 } = parsed
  return {
    key: record.key,
    // The path the export's own rule gives the record, only to name it in the list; never stat'ed.
    relativePath: uploadRelativePathForExport({ ...record, value: parsed }) ?? record.key,
    hasLegacyBase64: false,
    unsupportedRecord: true,
    size: typeof size === 'number' && Number.isFinite(size) ? size : null,
    uploadedAt: typeof uploadedAt === 'string' ? uploadedAt : null,
    originalName: typeof originalName === 'string' ? originalName : null,
    sha256: typeof sha256 === 'string' && /^[0-9a-f]{64}$/i.test(sha256) ? sha256 : null,
    groupId: record.groupId
  }
}

/**
 * BL-378: every exported upload record that names a file in the upload folder, in record
 * order, for the shared inspection. A record whose path also has a legacy Base64 copy keeps
 * that copy as its fallback, exactly as before.
 */
function uploadInspectionTargets(
  records: BackupRedisRecord[],
  legacyBase64Paths: ReadonlySet<string>
): UploadRecordTarget[] {
  const targets: UploadRecordTarget[] = []
  for (const record of records) {
    if (!record.key.startsWith('upload:')) continue
    if (!isPlainObject(record.value)) {
      const unsupported = unsupportedStringUploadTarget(record)
      if (unsupported) targets.push(unsupported)
      continue
    }
    const relativePath = normalizeUploadRelativePath(record.value)
    if (!relativePath) continue
    const { size, uploadedAt, originalName, sha256 } = record.value
    targets.push({
      key: record.key,
      relativePath,
      hasLegacyBase64: legacyBase64Paths.has(relativePath),
      size: typeof size === 'number' && Number.isFinite(size) ? size : null,
      uploadedAt: typeof uploadedAt === 'string' ? uploadedAt : null,
      originalName: typeof originalName === 'string' ? originalName : null,
      sha256: typeof sha256 === 'string' && /^[0-9a-f]{64}$/i.test(sha256) ? sha256 : null,
      groupId: record.groupId
    })
  }
  return targets
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function partialRequestError(reason: string): never {
  throw new BackupRestoreError(`The partial backup request is not valid: ${reason}.`, 400)
}

function boundedKeyForMessage(key: string) {
  return key.length > 160 ? `${key.slice(0, 159)}…` : key
}

/**
 * BL-378 Phase 1b §2a row 1: the export's `partial` option, exactly its documented shape, or a
 * 400. It lists 1 to 10,000 upload records of the upload check, each as `{ key, relativePath,
 * fingerprint }` with nothing else; a key at most once; keys and paths at most 4,096 UTF-16 code
 * units (`string.length`, as the packaged Mac export measures a path) and no NUL; a fingerprint of exactly
 * 64 lowercase hex characters; a path that is a safe archive path. `confirmAllMissing` is either
 * absent or `true`. (The request's byte cap, 413, is the route's.) A safe 4,096-unit path always
 * fits the zip name field: at most 12,288 UTF-8 bytes plus `files/uploads/`, under 65,535.
 */
export function parseBackupPartialRequest(value: unknown): BackupPartialRequest {
  if (!isPlainObject(value)) partialRequestError('partial must be an object')
  for (const field of Object.keys(value)) {
    if (field !== 'acknowledged' && field !== 'confirmAllMissing') partialRequestError(`unknown field "${boundedKeyForMessage(field)}"`)
  }
  if (value.confirmAllMissing !== undefined && value.confirmAllMissing !== true) {
    partialRequestError('confirmAllMissing may only be true')
  }
  const listed = value.acknowledged
  if (!Array.isArray(listed) || listed.length < 1 || listed.length > BACKUP_PARTIAL_ENTRY_LIMIT) {
    partialRequestError(`acknowledged must list 1 to ${BACKUP_PARTIAL_ENTRY_LIMIT} upload records`)
  }
  const keys = new Set<string>()
  const acknowledged: BackupPartialAcknowledgement[] = listed.map((entry: unknown, index: number) => {
    const where = `entry ${index + 1}`
    if (!isPlainObject(entry)) partialRequestError(`${where} must be an object`)
    const fields = Object.keys(entry)
    if (fields.length !== 3 || !['key', 'relativePath', 'fingerprint'].every((field) => Object.hasOwn(entry, field))) {
      partialRequestError(`${where} must have exactly key, relativePath and fingerprint`)
    }
    const { key, relativePath, fingerprint } = entry
    if (typeof key !== 'string' || !key.startsWith('upload:') || key.length <= 'upload:'.length || key.length > BACKUP_PARTIAL_STRING_MAX) {
      partialRequestError(`${where}'s key must be an upload record key of at most ${BACKUP_PARTIAL_STRING_MAX} characters`)
    }
    if (typeof relativePath !== 'string' || relativePath.length < 1 || relativePath.length > BACKUP_PARTIAL_STRING_MAX) {
      partialRequestError(`${where}'s relativePath must be 1 to ${BACKUP_PARTIAL_STRING_MAX} characters`)
    }
    // As the packaged Mac export refuses it: no stored upload key or file path holds a NUL.
    if (key.includes('\0') || relativePath.includes('\0')) partialRequestError(`${where}'s key or path contains a NUL character`)
    try {
      assertSafeZipPath(`${UPLOAD_FILE_ROOT}${relativePath}`)
    } catch {
      partialRequestError(`${where}'s relativePath is not a safe upload path`)
    }
    if (typeof fingerprint !== 'string' || !SHA256_HEX.test(fingerprint)) {
      partialRequestError(`${where}'s fingerprint must be 64 lowercase hexadecimal characters`)
    }
    if (keys.has(key)) partialRequestError(`upload record ${boundedKeyForMessage(key)} is listed twice`)
    keys.add(key)
    return { key, relativePath, fingerprint }
  })
  return value.confirmAllMissing === true ? { acknowledged, confirmAllMissing: true } : { acknowledged }
}

interface PartialUploadDecision {
  /** The missing records the archive lists, each with the fingerprint the export read. */
  listed: Array<{ problem: UploadFileProblem; fingerprint: string }>
  summary: BackupMissingUploadsSummary
}

function countedWords(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

/** The first few paths of a refusal reason, bounded like the export sentence's. */
function namedPaths(problems: Array<{ relativePath: string }>) {
  const paths = Array.from(new Set(problems.map((problem) => problem.relativePath)))
  const shown = paths.slice(0, 3).map((value) => (value.length > 160 ? `${value.slice(0, 159)}…` : value))
  return ` (${shown.join(', ')}${paths.length > shown.length ? `, and ${paths.length - shown.length} more` : ''})`
}

/**
 * BL-378 Phase 1b §2, §2a, §5: decides a partial export from the export's own inspection of its
 * own record snapshot. Every reason that applies is named in one refusal; its status is the first
 * matching row of §2a (an unreadable file 500, every other reason 409). The root keeps its own
 * error (500): with no folder, no file's state is known, so nothing is proven missing. A record
 * still missing is listed only when its acknowledgement matches the snapshot exactly (key, path
 * and fingerprint); every other missing record, a new alias included, refuses. The all-missing
 * check asks the one shared predicate (`uploadFolderFoundNothing`, BL-1388), so it runs only
 * while a missing record remains. Nothing here falls back: a problem that is not a proven
 * `missing` never becomes a listed one.
 */
function decidePartialUploads(
  inspection: UploadInspection,
  records: BackupRedisRecord[],
  request: BackupPartialRequest,
  fingerprints: ReadonlyMap<string, string>,
  omittedStagingKeys: ReadonlySet<string>
): PartialUploadDecision {
  if (inspection.rootProblem) {
    const failure = describeUploadInspectionFailure(inspection)!
    throw new BackupRestoreError(failure.message, failure.status, failure.details)
  }

  const acknowledged = new Map(request.acknowledged.map((entry) => [entry.key, entry]))
  const listed: PartialUploadDecision['listed'] = []
  const unacknowledged: UploadFileProblem[] = []
  const changed: UploadFileProblem[] = []
  for (const problem of inspection.problems) {
    if (problem.kind !== 'missing') continue
    const fingerprint = fingerprints.get(problem.key)
    if (!fingerprint) throw new BackupRestoreError(`Partial backup lost track of ${boundedKeyForMessage(problem.key)}.`, 500)
    const entry = acknowledged.get(problem.key)
    if (!entry) unacknowledged.push(problem)
    else if (entry.relativePath !== problem.relativePath || entry.fingerprint !== fingerprint) changed.push(problem)
    else listed.push({ problem, fingerprint })
  }

  const byKind = (kind: UploadFileProblem['kind']) => inspection.problems.filter((problem) => problem.kind === kind)
  const unreadable = byKind('unreadable')
  const notAFile = byKind('not-a-file')
  const unsupported = byKind('unsupported-record')
  const truncated = inspection.problems.length > UPLOAD_PROBLEM_LIST_LIMIT
  const missingCount = listed.length + unacknowledged.length + changed.length
  const allMissingUnconfirmed = uploadFolderFoundNothing(inspection) && request.confirmAllMissing !== true

  const reasons: string[] = []
  const parts: string[] = []
  if (unreadable.length > 0) {
    reasons.push('unreadable')
    parts.push(`${countedWords(countUploadProblemFiles(unreadable), 'upload file', 'upload files')} cannot be read${namedPaths(unreadable)}`)
  }
  if (notAFile.length > 0) {
    reasons.push('not-a-file')
    const files = countUploadProblemFiles(notAFile)
    parts.push(`${countedWords(files, 'upload file', 'upload files')} ${files === 1 ? 'is' : 'are'} not a file${namedPaths(notAFile)}`)
  }
  if (unsupported.length > 0) {
    reasons.push('unsupported-record')
    parts.push(
      `${countedWords(unsupported.length, 'upload record is', 'upload records are')} stored in a form a backup cannot carry${namedPaths(unsupported)}`
    )
  }
  if (truncated) {
    reasons.push('truncated')
    parts.push(`more than ${UPLOAD_PROBLEM_LIST_LIMIT} upload records have problems, so the list cannot be acknowledged whole`)
  }
  if (unacknowledged.length > 0) {
    reasons.push('new-missing')
    parts.push(
      `${countedWords(unacknowledged.length, 'missing upload record was', 'missing upload records were')} not in the acknowledged list${namedPaths(unacknowledged)}`
    )
  }
  if (changed.length > 0) {
    reasons.push('changed')
    parts.push(`${countedWords(changed.length, 'acknowledged upload record', 'acknowledged upload records')} changed since the check${namedPaths(changed)}`)
  }
  if (allMissingUnconfirmed) {
    reasons.push('all-missing-unconfirmed')
    const files = countUploadProblemFiles(inspection.problems)
    parts.push(`none of the ${countedWords(files, 'upload file', 'upload files')} Batshit expects ${files === 1 ? 'is' : 'are'} in ${inspection.uploadRoot}, and that was not confirmed`)
  }
  if (request.acknowledged.some((entry) => omittedStagingKeys.has(entry.key))) {
    reasons.push('staged-import')
    parts.push('the acknowledged upload list now includes unfinished Hair import staging')
  }
  if (reasons.length > 0) {
    const keysOf = (problems: UploadFileProblem[]) =>
      problems.slice(0, UPLOAD_PROBLEM_LIST_LIMIT).map(({ key, relativePath }) => ({ key, relativePath }))
    throw new BackupRestoreError(
      `Partial backup refused: ${parts.join('; ')}. Nothing was exported. Run Check Upload Files again and decide from its new list.`,
      unreadable.length > 0 ? 500 : 409,
      {
        code: 'BACKUP_PARTIAL_REFUSED',
        reasons,
        uploadRoot: inspection.uploadRoot,
        counts: countUploadProblems(inspection.problems),
        problemCount: inspection.problems.length,
        missingCount,
        unacknowledged: keysOf(unacknowledged),
        changed: keysOf(changed)
      }
    )
  }

  // Every acknowledged entry ended in exactly one state ([B3]): listed (still missing, unchanged),
  // gone (no record), found again (its path is a regular file now) or changed in another way.
  const listedKeys = new Set(listed.map(({ problem }) => problem.key))
  const recordKeys = new Set(records.map((record) => record.key))
  const foundPathByKey = new Map(inspection.found.map(({ target }) => [target.key, target.relativePath]))
  const foundAgainPaths = new Set<string>()
  let goneRecords = 0
  let otherRecords = 0
  for (const entry of request.acknowledged) {
    if (listedKeys.has(entry.key)) continue
    const foundPath = foundPathByKey.get(entry.key)
    if (!recordKeys.has(entry.key)) goneRecords += 1
    else if (foundPath !== undefined) foundAgainPaths.add(foundPath)
    else otherRecords += 1
  }
  return {
    listed,
    summary: {
      completeness: listed.length > 0 ? 'partial' : 'complete',
      missingFiles: countUploadProblemFiles(listed.map(({ problem }) => problem)),
      missingRecords: listed.length,
      foundAgainFiles: foundAgainPaths.size,
      goneRecords,
      otherRecords
    }
  }
}

async function collectUploadFileAssets(
  records: BackupRedisRecord[],
  redisBase64Assets: RedisBase64BackupFileAsset[],
  partial: { request: BackupPartialRequest; fingerprints: ReadonlyMap<string, string>; omittedStagingKeys: ReadonlySet<string> } | null = null
) {
  const uploadRoot = resolveUploadsDir()
  const assets = new Map<string, BackupFileAsset>()
  const inspection = await inspectUploadFiles({
    uploadRoot,
    targets: uploadInspectionTargets(records, new Set(redisBase64Assets.map((asset) => asset.relativePath))),
    resolvePath: (relativePath) => safeJoin(uploadRoot, relativePath)
  })
  let decision: PartialUploadDecision | null = null
  if (partial) {
    decision = decidePartialUploads(inspection, records, partial.request, partial.fingerprints, partial.omittedStagingKeys)
  } else {
    // BL-378: one error naming every problem file; a normal export still stops here.
    const failure = describeUploadInspectionFailure(inspection)
    if (failure) throw new BackupRestoreError(failure.message, failure.status, failure.details)
  }

  for (const { target, sourcePath, byteLength } of inspection.found) {
    if (!assets.has(target.relativePath)) {
      assets.set(target.relativePath, {
        source: 'filesystem',
        groupId: target.groupId,
        zipPath: `${UPLOAD_FILE_ROOT}${target.relativePath}`,
        sourcePath,
        relativePath: target.relativePath,
        byteLength
      })
    }
  }

  for (const asset of redisBase64Assets) {
    if (!assets.has(asset.relativePath)) assets.set(asset.relativePath, asset)
  }

  // BL-378 Phase 1b §4: a listed path has no file in the archive. One state per path holds for
  // one pass, but a file that appears between two aliases' checks of the same path would make a
  // path both listed and carried; that archive would fail its own restore check, so it fails here.
  const listedAndCarried = decision?.listed.filter(({ problem }) => assets.has(problem.relativePath)) ?? []
  if (listedAndCarried.length > 0) {
    throw new BackupRestoreError(
      `Upload file "${listedAndCarried[0].problem.relativePath}" changed while the export was running. Try the export again.`,
      409
    )
  }

  const collected = Array.from(assets.values())
  return {
    assets: collected,
    fileAssetCount: collected.length,
    fileAssetBytes: collected.reduce((sum, asset) => sum + asset.byteLength, 0),
    partial: decision
  }
}

/**
 * BL-378: the Admin "Check Upload Files" audit. It reads the same upload records the export
 * reads, through the same normalization, and asks the same inspection, so it names exactly the
 * files that stop a backup. It writes nothing: no Redis write, no file write, no new key. Each
 * listed problem carries its current owner (`backupUploadOwners.ts`) and the fingerprint of
 * the stored record as read now.
 */
export async function auditBackupUploadFiles(userId: string): Promise<BackupUploadCheck> {
  const uploadRoot = resolveUploadsDir()
  const { records, legacyBase64Paths, fingerprints } = await redis.execute(async (client) => {
    const keys = new Set<string>()
    await addPatternKeys(keys, client, 'upload:*')
    const redactions: RedactionState = { excludedRecordCount: 0, redactedFieldCount: 0, redactedPaths: new Set() }
    const collected: BackupRedisRecord[] = []
    const base64Paths = new Set<string>()
    const recordFingerprints = new Map<string, string>()
    const auditKeys = Array.from(keys).filter((key) => isRestorableKeyForUser(key, userId)).sort((left, right) => left.localeCompare(right))
    const cut = await collectExportRecords(client, auditKeys, userId)
    for (const record of cut.records) {
      const key = record.key
      if (!key.startsWith('upload:')) continue
      recordFingerprints.set(key, uploadRecordFingerprint(key, record.value))
      const normalized = normalizeRecordForExport(record, { userId, includeSecrets: false }, redactions)
      if (!normalized) continue
      const upload = normalizeUploadRecordForExport(normalized)
      if (upload.redisBase64Asset) base64Paths.add(upload.redisBase64Asset.relativePath)
      collected.push(upload.record)
    }
    return { records: collected, legacyBase64Paths: base64Paths, fingerprints: recordFingerprints }
  })

  const inspection = await inspectUploadFiles({
    uploadRoot,
    targets: uploadInspectionTargets(records, legacyBase64Paths),
    resolvePath: (relativePath) => safeJoin(uploadRoot, relativePath)
  })
  const listed = inspection.problems.slice(0, UPLOAD_PROBLEM_LIST_LIMIT)
  const owners = await redis.execute((client) =>
    describeUploadOwners(client as unknown as OwnerReadClient, userId, listed.map((problem) => problem.key))
  )

  return {
    checkedAt: new Date().toISOString(),
    uploadRoot,
    fileBackedCount: inspection.fileBackedCount,
    foundCount: inspection.foundCount,
    legacyCopyCount: inspection.legacyCopyCount,
    legacyCopyFileCount: inspection.legacyCopyFileCount,
    problemCount: inspection.problems.length,
    problemFileCount: countUploadProblemFiles(inspection.problems),
    counts: countUploadProblems(inspection.problems),
    problems: listed.map((problem) => {
      const fingerprint = fingerprints.get(problem.key)
      const owner = owners.get(problem.key)
      if (!fingerprint || !owner) {
        throw new BackupRestoreError(`Upload check lost track of ${problem.key}.`, 500)
      }
      return { ...problem, fingerprint, owner }
    }),
    truncated: inspection.problems.length > UPLOAD_PROBLEM_LIST_LIMIT,
    listLimit: UPLOAD_PROBLEM_LIST_LIMIT,
    rootProblem: inspection.rootProblem,
    uploadFolderFoundNothing: uploadFolderFoundNothing(inspection),
    exportBlockedMessage: describeUploadInspectionFailure(inspection)?.message ?? null
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
  fileAssets: BackupFileAsset[]
  fileAssetBytes: number
  hostFileAssets: BackupFileAsset[]
  hostFilesNotCarried: HostFolderNotCarried[]
  /** BL-378 Phase 1b: the listed records of a partial backup; null for a complete one. */
  missingUploads?: BackupMissingUploadEntry[] | null
}): BackupManifest {
  const missingUploads = params.missingUploads?.length ? params.missingUploads : null
  const groupCounts = new Map<BackupGroupId, { records: number; files: number }>()
  for (const group of GROUP_DEFINITIONS) {
    groupCounts.set(group.id, { records: 0, files: 0 })
  }
  for (const record of params.records) {
    const counts = groupCounts.get(record.groupId)
    if (counts) counts.records += 1
  }
  for (const asset of [...params.fileAssets, ...params.hostFileAssets]) {
    const counts = groupCounts.get(asset.groupId)
    if (counts) counts.files += 1
  }

  // [A5]: a complete manifest is exactly what it was (schema 1, compatibility 1 to 1, and no
  // `completeness`, `uploads` or `contents.missingUpload*`); only a partial one says 2.
  const schemaVersion = missingUploads ? BACKUP_PARTIAL_SCHEMA_VERSION : BACKUP_COMPLETE_SCHEMA_VERSION
  return {
    schemaVersion,
    ...(missingUploads ? { completeness: 'partial' as const } : {}),
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
      fileAssetCount: params.fileAssets.length,
      fileAssetBytes: params.fileAssetBytes,
      hostFileCount: params.hostFileAssets.length,
      hostFileBytes: params.hostFileAssets.reduce((sum, asset) => sum + asset.byteLength, 0),
      ...(missingUploads
        ? {
            missingUploadRecordCount: missingUploads.length,
            missingUploadFileCount: new Set(missingUploads.map((entry) => entry.relativePath)).size
          }
        : {}),
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
    hostFiles: {
      limits: { ...HOST_FILE_LIMITS },
      notCarried: params.hostFilesNotCarried
    },
    ...(missingUploads ? { uploads: { missing: missingUploads } } : {}),
    externalReferences: [
      'External n8n workflows and n8n credentials are not included.',
      'Local AI servers, voice engines, Agent Browser, Cloudflared, LiveKit sidecars, and model weights are restored as settings or references only.',
      'Project source files remain at their filesystem paths and are not copied into the backup bundle.'
    ],
    compatibility: {
      minSchemaVersion: schemaVersion,
      maxSchemaVersion: schemaVersion,
      restoreMode: 'fresh-or-destructive-replace'
    }
  }
}

function createBackupFilename(partial = false) {
  return `batshit-backup-${partial ? 'PARTIAL-' : ''}${new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}.zip`
}

/**
 * BL-378 Phase 1b §2a row 7: a restore reads `manifest.json` only up to `MAX_MANIFEST_BYTES` and
 * refuses a larger one with 400, so a partial backup whose list would make it larger is refused
 * the same way instead of being written. Checked before streaming and again for the final
 * manifest (which a host folder that changed meanwhile can lengthen).
 */
function assertPartialManifestFits(encoded: Uint8Array) {
  if (encoded.byteLength > MAX_MANIFEST_BYTES) {
    throw new BackupRestoreError(
      `This partial backup's manifest.json would be ${encoded.byteLength} bytes, over the ${MAX_MANIFEST_BYTES} bytes a restore reads, ` +
        'because its list of missing upload files is too long. Fix some of those files first, then make the partial backup again.',
      400
    )
  }
}

async function collectBackupBundleParts(
  userId: string,
  options?: { includeSecrets?: boolean; partial?: BackupPartialRequest | null }
) {
  const includeSecrets = options?.includeSecrets === true
  const partialRequest = options?.partial ?? null
  const { records, redactions, redisBase64Assets, uploadFingerprints, omittedStagingKeys } = await collectRedisRecords(
    { userId, includeSecrets },
    { fingerprintUploads: partialRequest !== null }
  )
  const fileAssets = await collectUploadFileAssets(
    records,
    redisBase64Assets,
    partialRequest ? { request: partialRequest, fingerprints: uploadFingerprints, omittedStagingKeys } : null
  )
  const hostFiles = await collectHostFileAssets(records, userId)
  // [A4]: the archived record's hash is taken from the very record this export writes.
  const recordByKey = new Map(records.map((record) => [record.key, record]))
  const missingUploads: BackupMissingUploadEntry[] | null = fileAssets.partial?.listed.length
    ? fileAssets.partial.listed.map(({ problem, fingerprint }) => ({
        key: problem.key,
        relativePath: problem.relativePath,
        kind: 'missing' as const,
        fingerprint,
        archivedRecordSha256: archivedRecordSha256(recordByKey.get(problem.key)!)
      }))
    : null
  const manifestInput = {
    userId,
    includeSecrets,
    records,
    redactions,
    fileAssets: fileAssets.assets,
    fileAssetBytes: fileAssets.fileAssetBytes,
    missingUploads
  }
  // The manifest the export route reads before streaming (its not-carried header); the export
  // rewrites it in place once it knows which host folders it actually wrote.
  const manifest = buildManifest({
    ...manifestInput,
    hostFileAssets: hostFiles.folders.flatMap(hostFolderAssets),
    hostFilesNotCarried: hostFiles.notCarried
  })
  const entries: Record<string, Uint8Array> = {}
  addRedisRecordEntries(entries, records)
  entries[MANIFEST_PATH] = encodeText(JSON.stringify(manifest, null, 2))
  if (missingUploads) assertPartialManifestFits(entries[MANIFEST_PATH])

  /** The final manifest: only the host files written, plus the folders that changed meanwhile. */
  const finishManifest: FinishBackupManifest = (written, changed) => {
    const notCarried = [...hostFiles.notCarried, ...changed].sort((left, right) =>
      hostFolderKey(left.root, left.folder).localeCompare(hostFolderKey(right.root, right.folder))
    )
    const final = buildManifest({ ...manifestInput, hostFileAssets: written.map(hostFileAsset), hostFilesNotCarried: notCarried })
    Object.assign(manifest, { ...final, createdAt: manifest.createdAt })
    const encoded = encodeText(JSON.stringify(manifest, null, 2))
    if (missingUploads) assertPartialManifestFits(encoded)
    return encoded
  }

  return {
    manifest,
    records,
    entries,
    fileAssets: fileAssets.assets,
    hostFolders: hostFiles.folders,
    finishManifest,
    filename: createBackupFilename(missingUploads !== null),
    missingUploads: fileAssets.partial?.summary ?? null
  }
}

function hostFileGroupId(root: HostFileRootId): BackupGroupId {
  return root === 'skills' ? 'tools' : 'voice'
}

function hostFileAsset(file: HostFileExportAsset): FilesystemBackupFileAsset {
  return {
    source: 'filesystem',
    groupId: hostFileGroupId(file.root),
    zipPath: file.zipPath,
    sourcePath: file.sourcePath,
    relativePath: `${file.root}/${file.folder}/${file.relativePath}`,
    byteLength: file.byteLength
  }
}

function hostFolderAssets(folder: HostFolderExport): FilesystemBackupFileAsset[] {
  return folder.files.map(hostFileAsset)
}

/**
 * BL-373/BL-369: the skill folders and clone voice recordings the exported records name. A
 * folder that cannot be carried whole is listed in the manifest and never stops the export.
 */
async function collectHostFileAssets(records: BackupRedisRecord[], userId: string) {
  const selected = hostFolderRefsFromRecords(records, userId, { containerized: isContainerizedRuntime() })
  const walked = await collectHostFolderFiles(selected.refs)
  const folders = [...walked.folders].sort((left, right) =>
    hostFolderKey(left.root, left.folder).localeCompare(hostFolderKey(right.root, right.folder))
  )
  const notCarried = [...selected.notCarried, ...walked.notCarried].sort((left, right) =>
    hostFolderKey(left.root, left.folder).localeCompare(hostFolderKey(right.root, right.folder))
  )
  return { folders, notCarried }
}

/** Running out of file handles fails the export (503) with its real cause; never a folder "changed". */
function failOnHandleExhaustion(error: unknown) {
  if (error instanceof HostFileHandlesExhaustedError) throw new BackupRestoreError(error.message, 503)
}

function asExportError(error: unknown): never {
  failOnHandleExhaustion(error)
  throw error
}

/**
 * Read one host folder whole, one handle at a time, every file checked against the walk; or the
 * reason it cannot be carried. Nothing is added to the archive until the whole folder is read.
 */
async function readHostFolder(folder: HostFolderExport): Promise<{ contents: Uint8Array[] } | { reason: HostFolderNotCarried['reason'] }> {
  const checked = await checkHostFolderFiles(folder).catch(asExportError)
  if (checked) return { reason: checked }
  const contents: Uint8Array[] = []
  for (const file of folder.files) {
    let handle: Awaited<ReturnType<typeof openWalkedHostFile>>
    try {
      handle = await openWalkedHostFile(file)
    } catch (error) {
      failOnHandleExhaustion(error)
      return { reason: 'changed' }
    }
    try {
      const bytes = new Uint8Array(await handle.readFile())
      if (bytes.byteLength !== file.byteLength) return { reason: 'changed' }
      contents.push(bytes)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  return { contents }
}

export async function createBackupBundle(
  userId: string,
  options?: { includeSecrets?: boolean; partial?: BackupPartialRequest | null }
) {
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
  const written: HostFileExportAsset[] = []
  const changed: HostFolderNotCarried[] = []
  for (const folder of parts.hostFolders) {
    const read = await readHostFolder(folder)
    if ('reason' in read) {
      changed.push({ root: folder.root, folder: folder.folder, ownerKey: folder.ownerKey, label: folder.label, reason: read.reason })
      continue
    }
    folder.files.forEach((file, index) => {
      parts.entries[file.zipPath] = read.contents[index]
      written.push(file)
    })
  }
  parts.entries[MANIFEST_PATH] = parts.finishManifest(written, changed)
  const bytes = createZip(parts.entries)

  return {
    bytes,
    manifest: parts.manifest,
    filename: parts.filename,
    missingUploads: parts.missingUploads
  }
}

/**
 * The streaming export. BL-1401: it holds the restore gate (`enterBackupRestoreHttpRequest`) from
 * before its first read until its stream is over and its files are closed, so a restore waits for
 * it: the request's own hold ends when the route returns this stream, long before the files are
 * read. A restore already draining refuses it, with the hook's words. The caller must read the
 * stream to its end or cancel it; either ends the hold.
 */
export async function createBackupBundleStream(
  userId: string,
  options?: { includeSecrets?: boolean; partial?: BackupPartialRequest | null }
): Promise<BackupBundleStream> {
  const endWork = enterBackupRestoreHttpRequest()
  if (!endWork) {
    throw new BackupRestoreError('Batshit is finishing a backup restore. Try again after the app reloads.', 503)
  }
  try {
    const parts = await collectBackupBundleParts(userId, options)
    const stream = createZipReadableStream(
      parts.entries,
      parts.fileAssets,
      parts.hostFolders,
      parts.finishManifest,
      endWork
    ) as ReadableStream<Uint8Array>
    return {
      stream,
      manifest: parts.manifest,
      filename: parts.filename,
      missingUploads: parts.missingUploads
    }
  } catch (error) {
    // No stream to end the hold: nothing was opened yet.
    endWork()
    throw error
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
  assertPartialManifestAgreement(
    manifest,
    records,
    new Set(Object.keys(zipEntries).filter((name) => name.startsWith(UPLOAD_FILE_ROOT)).map((name) => name.slice(UPLOAD_FILE_ROOT.length)))
  )

  return { manifest, records, zipEntries }
}

function validateManifest(manifest: BackupManifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new BackupRestoreError('Backup manifest is invalid.', 400)
  }
  if (manifest.app?.name !== 'Batshit') {
    throw new BackupRestoreError('This is not a Batshit backup bundle.', 400)
  }
  // BL-1402: an exact positive integer, compared without coercion. A comparison alone let
  // `undefined`, `NaN`, `"abc"`, `true` and `{}` through and called `1.5`, `[2]` or `"3"` a
  // future schema. Every exporter since the constant was introduced (330f1d8d9) wrote the
  // integer 1, so nothing older needs a looser rule.
  const schemaVersion: unknown = manifest.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new BackupRestoreError("This backup's schema version is not one Batshit supports.", 400)
  }
  if (schemaVersion > BACKUP_READER_MAX_SCHEMA_VERSION) {
    throw new BackupRestoreError(
      `This backup uses schema ${schemaVersion}, but this Batshit build only supports schema ${BACKUP_READER_MAX_SCHEMA_VERSION}.`,
      409
    )
  }
  // BL-378 Phase 1b §3: schema 2 is a partial backup and nothing else, and schema 1 never carries
  // partial-backup fields, so a manifest cannot claim one and look like the other.
  const contents: unknown = manifest.contents
  const hasPartialFields =
    Object.hasOwn(manifest, 'completeness') ||
    Object.hasOwn(manifest, 'uploads') ||
    (isPlainObject(contents) &&
      (Object.hasOwn(contents, 'missingUploadRecordCount') || Object.hasOwn(contents, 'missingUploadFileCount')))
  const consistent =
    schemaVersion === BACKUP_PARTIAL_SCHEMA_VERSION
      ? manifest.completeness === 'partial' && isPlainObject(manifest.uploads)
      : !hasPartialFields
  if (!consistent) {
    throw new BackupRestoreError("This backup's partial-backup information is inconsistent.", 400)
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

function partialListError(reason: string): never {
  throw new BackupRestoreError(`This partial backup's list of missing upload files is invalid: ${reason}.`, 400)
}

const MISSING_UPLOAD_ENTRY_FIELDS = ['key', 'relativePath', 'kind', 'fingerprint', 'archivedRecordSha256']

/**
 * BL-378 Phase 1b §4: a partial (schema 2) manifest's list is untrusted metadata, checked against
 * the exact archived records and the archive's own files before anything is restored (both
 * preflights and the restore read it here), or a 400. Bounds: 1 to 10,000 entries, exactly the
 * documented fields, keys and paths at most 4,096 UTF-16 code units with no NUL, kind `missing`, both hashes
 * 64 lowercase hex, no duplicate key (a duplicate path is an alias), and both counts. Each path is
 * a safe archive path. Each key names an archived upload record with that same path whose sha256
 * is the listed one. No listed path has a file in the archive, and every archived upload record
 * that names a file either has it or is listed, so every alias of a missing file is listed and a
 * partial archive has no unlisted hole. The list never selects, skips or deletes anything: the
 * restore stays the established destructive replace.
 */
function assertPartialManifestAgreement(
  manifest: BackupManifest,
  records: BackupRedisRecord[],
  uploadFilePaths: ReadonlySet<string>
) {
  if (manifest.schemaVersion !== BACKUP_PARTIAL_SCHEMA_VERSION) return
  const uploads: unknown = manifest.uploads
  if (!isPlainObject(uploads) || Object.keys(uploads).length !== 1 || !Array.isArray(uploads.missing)) {
    partialListError('uploads must hold only the missing list')
  }
  const missing: unknown[] = uploads.missing
  if (missing.length < 1 || missing.length > BACKUP_PARTIAL_ENTRY_LIMIT) {
    partialListError(`it must list 1 to ${BACKUP_PARTIAL_ENTRY_LIMIT} upload records`)
  }
  const listed = new Map<string, BackupMissingUploadEntry>()
  for (const [index, entry] of missing.entries()) {
    const where = `entry ${index + 1}`
    if (!isPlainObject(entry)) partialListError(`${where} is not an object`)
    const fields = Object.keys(entry)
    if (fields.length !== MISSING_UPLOAD_ENTRY_FIELDS.length || !MISSING_UPLOAD_ENTRY_FIELDS.every((field) => Object.hasOwn(entry, field))) {
      partialListError(`${where} must have exactly ${MISSING_UPLOAD_ENTRY_FIELDS.join(', ')}`)
    }
    const { key, relativePath, kind, fingerprint, archivedRecordSha256: recordSha256 } = entry
    if (typeof key !== 'string' || !key.startsWith('upload:') || key.length <= 'upload:'.length || key.length > BACKUP_PARTIAL_STRING_MAX) {
      partialListError(`${where}'s key is not an upload record key of at most ${BACKUP_PARTIAL_STRING_MAX} characters`)
    }
    if (typeof relativePath !== 'string' || relativePath.length < 1 || relativePath.length > BACKUP_PARTIAL_STRING_MAX) {
      partialListError(`${where}'s path is not 1 to ${BACKUP_PARTIAL_STRING_MAX} characters`)
    }
    if (key.includes('\0') || relativePath.includes('\0')) partialListError(`${where}'s key or path contains a NUL character`)
    try {
      assertSafeZipPath(`${UPLOAD_FILE_ROOT}${relativePath}`)
    } catch {
      partialListError(`${where}'s path is not a safe upload path`)
    }
    if (kind !== 'missing') partialListError(`${where}'s kind is not "missing"`)
    if (typeof fingerprint !== 'string' || !SHA256_HEX.test(fingerprint) || typeof recordSha256 !== 'string' || !SHA256_HEX.test(recordSha256)) {
      partialListError(`${where}'s hashes are not 64 lowercase hexadecimal characters`)
    }
    if (listed.has(key)) partialListError(`upload record ${boundedKeyForMessage(key)} is listed twice`)
    listed.set(key, { key, relativePath, kind, fingerprint, archivedRecordSha256: recordSha256 })
  }
  const paths = new Set(Array.from(listed.values(), (entry) => entry.relativePath))
  if (
    manifest.contents.missingUploadRecordCount !== listed.size ||
    manifest.contents.missingUploadFileCount !== paths.size
  ) {
    partialListError('its record and file counts do not match the list')
  }

  const uploadRecords = new Map<string, BackupRedisRecord>()
  for (const record of records) {
    if (!record.key.startsWith('upload:')) continue
    if (uploadRecords.has(record.key)) partialListError(`the archive holds upload record ${boundedKeyForMessage(record.key)} twice`)
    uploadRecords.set(record.key, record)
  }
  for (const entry of listed.values()) {
    const record = uploadRecords.get(entry.key)
    if (!record) partialListError(`listed upload record ${boundedKeyForMessage(entry.key)} is not in the archive`)
    if (normalizeUploadRelativePath(record.value) !== entry.relativePath) {
      partialListError(`listed upload record ${boundedKeyForMessage(entry.key)} does not name the listed file`)
    }
    if (archivedRecordSha256(record) !== entry.archivedRecordSha256) {
      partialListError(`listed upload record ${boundedKeyForMessage(entry.key)} is not the record the backup listed`)
    }
    if (uploadFilePaths.has(entry.relativePath)) {
      partialListError(`listed file ${boundedKeyForMessage(entry.relativePath)} is in the archive`)
    }
  }
  for (const record of uploadRecords.values()) {
    const relativePath = normalizeUploadRelativePath(record.value)
    if (relativePath && !uploadFilePaths.has(relativePath) && !listed.has(record.key)) {
      partialListError(`upload record ${boundedKeyForMessage(record.key)} has no file in the archive and is not listed`)
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
  const archiveHostFiles = Object.keys(bundle.zipEntries)
    .filter((name) => name.startsWith(HOST_FILE_ZIP_ROOT))
    .map((name) => parseArchiveHostFile(name, bundle.zipEntries[name]?.byteLength ?? 0))
  assertArchiveHostFilesWithinLimits(archiveHostFiles)
  assertArchiveHostFileInventory(bundle.manifest, archiveHostFiles)
  await validateRecipeRestoreGraph(bundle.records, bundle.manifest.source.userId)
  const preflightTargetRecords = buildTargetRecords(bundle, userId, new Set(hostFoldersToPlace(archiveHostFiles).keys()))
  assertHostFoldersHaveOwners(archiveHostFiles, preflightTargetRecords, userId)
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
    hostFileCount: archiveHostFiles.length,
    hostFileBytes: archiveHostFiles.reduce((sum, file) => sum + file.byteLength, 0),
    requiresDestructiveConfirmation: currentRecordCount > 0,
    currentRecordCount,
    sourceUserId: bundle.manifest.source.userId,
    targetUserId: userId,
    userRemapRequired: bundle.manifest.source.userId !== userId,
    warnings: await buildPreflightWarnings(bundle, currentRecordCount, archiveHostFiles)
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

/** A `files/host/{root}/{folder}/{path}` entry of an archive (BL-373/BL-369). */
interface ArchiveHostFile {
  name: string
  root: HostFileRootId
  folder: string
  relativePath: string
  byteLength: number
}

function parseArchiveHostFile(name: string, byteLength: number): ArchiveHostFile {
  assertSafeZipPath(name)
  const parts = parseHostFileZipPath(name)
  if (!parts || !parts.relativePath) {
    throw new BackupRestoreError(`Backup contains a malformed skill or voice file path: ${name}`, 400)
  }
  if (!isHostFileRootId(parts.root)) {
    throw new BackupRestoreError(`Backup contains files for a place Batshit does not restore: ${name}`, 400)
  }
  if (!isSafeHostFolderName(parts.folder)) {
    throw new BackupRestoreError(`Backup contains an unsafe skill or voice folder name: ${name}`, 400)
  }
  return { name, root: parts.root, folder: parts.folder, relativePath: parts.relativePath, byteLength }
}

/**
 * A backup Batshit made never carries a folder over the limits, so an archive that does is
 * refused. Nor two names that differ only in capitalization (a folder, or a file in one folder):
 * the Mac's disk treats them as one, so extracting both would merge them.
 */
function assertArchiveHostFilesWithinLimits(files: ArchiveHostFile[]) {
  const folders = new Map<string, { count: number; bytes: number }>()
  const spelled = new Map<string, string>()
  for (const file of files) {
    for (const name of [hostFolderKey(file.root, file.folder), `${hostFolderKey(file.root, file.folder)}/${file.relativePath}`]) {
      const folded = name.toLowerCase()
      const earlier = spelled.get(folded)
      if (earlier !== undefined && earlier !== name) {
        throw new BackupRestoreError(
          `Backup carries "${earlier}" and "${name}", which differ only in capitalization; Batshit will not place them.`,
          400
        )
      }
      spelled.set(folded, name)
    }
    if (file.byteLength > HOST_FILE_LIMITS.maxFileBytes) {
      throw new BackupRestoreError(`Backup file "${file.name}" is over the ${HOST_FILE_LIMITS.maxFileBytes} byte limit.`, 400)
    }
    const key = hostFolderKey(file.root, file.folder)
    const totals = folders.get(key) ?? { count: 0, bytes: 0 }
    totals.count += 1
    totals.bytes += file.byteLength
    folders.set(key, totals)
    if (totals.count > HOST_FILE_LIMITS.maxFolderFiles || totals.bytes > HOST_FILE_LIMITS.maxFolderBytes) {
      throw new BackupRestoreError(`Backup folder "${key}" is over the backup limits for one folder.`, 400)
    }
  }
}

function assertArchiveHostFileInventory(manifest: BackupManifest, files: ArchiveHostFile[]) {
  const bytes = files.reduce((sum, file) => sum + file.byteLength, 0)
  if (files.length !== (manifest.contents.hostFileCount ?? 0) || bytes !== (manifest.contents.hostFileBytes ?? 0)) {
    throw new BackupRestoreError('Backup skill and voice file inventory does not match the manifest.', 400)
  }
}

/**
 * The folders this restore places, by `{root}/{folder}`. In Docker a clone voice's recording
 * belongs on the HOST, which the app container cannot write yet (round 2 with the host
 * operator), so Docker leaves voice folders out and the preflight says so.
 */
function hostFoldersToPlace(files: ArchiveHostFile[]) {
  const placed = new Map<string, ArchiveHostFile[]>()
  const containerized = isContainerizedRuntime()
  for (const file of files) {
    if (containerized && file.root === 'voice-profiles') continue
    const key = hostFolderKey(file.root, file.folder)
    const folderFiles = placed.get(key) ?? []
    folderFiles.push(file)
    placed.set(key, folderFiles)
  }
  return placed
}

/** Every folder the archive carries must belong to a record the restore writes. */
function assertHostFoldersHaveOwners(files: ArchiveHostFile[], targetRecords: BackupRedisRecord[], targetUserId: string) {
  const byKey = new Map(targetRecords.map((record) => [record.key, record]))
  const checked = new Set<string>()
  for (const file of files) {
    const key = hostFolderKey(file.root, file.folder)
    if (checked.has(key)) continue
    checked.add(key)
    const owner =
      file.root === 'skills'
        ? byKey.get(`skill:${targetUserId}:${file.folder}`)
        : byKey.get(`voice_profile:${file.folder}`)
    const owned =
      file.root === 'skills'
        ? Boolean(owner && isUserSkillRecordValue(owner.value) && (owner.value.id ?? file.folder) === file.folder)
        : Boolean(owner && managedReferenceAudioPathOf(owner.value))
    if (!owned) {
      throw new BackupRestoreError(
        `Backup carries files for ${file.root === 'skills' ? 'skill' : 'voice profile'} "${file.folder}" but no matching record, so Batshit will not place them.`,
        400
      )
    }
  }
}

function recordLabel(record: BackupRedisRecord | undefined, fallback: string) {
  if (!record || !isPlainObject(record.value)) return fallback
  for (const field of ['displayName', 'name']) {
    const candidate = record.value[field]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return fallback
}

/**
 * BL-373/BL-369 preflight lines: every folder the backup could not carry (from its manifest);
 * for a backup made before host files, every user skill and clone voice it names; and in Docker,
 * every clone voice recording the restore cannot place.
 */
function describeHostFileWarnings(bundle: BackupBundle, archiveHostFiles: ArchiveHostFile[]) {
  const warnings: string[] = []
  const hostFiles = bundle.manifest.hostFiles
  if (hostFiles) {
    for (const entry of hostFiles.notCarried ?? []) warnings.push(describeNotCarriedHostFolder(entry))
  } else {
    const byKey = new Map(bundle.records.map((record) => [record.key, record]))
    const sourceUserId = bundle.manifest.source.userId
    const skills = bundle.records
      .filter((record) => record.key.startsWith(`skill:${sourceUserId}:`) && isUserSkillRecordValue(record.value))
      .map((record) => recordLabel(record, record.key.slice(`skill:${sourceUserId}:`.length)))
    const voices = bundle.records
      .filter((record) => record.key.startsWith('voice_profile:') && managedReferenceAudioPathOf(record.value))
      .map((record) => recordLabel(byKey.get(record.key), record.key.slice('voice_profile:'.length)))
    if (skills.length > 0 || voices.length > 0) {
      const named = [
        skills.length > 0 ? `skills ${skills.join(', ')}` : null,
        voices.length > 0 ? `clone voices ${voices.join(', ')}` : null
      ].filter(Boolean)
      warnings.push(
        `This backup is from a Batshit that did not save skill files or clone voice recordings. These come back with their settings only: ${named.join('; ')}. ` +
          'If their folders are not already on this computer, a skill says its files are missing when it is used, and a clone voice has no recording. Add them again, or delete them.'
      )
    }
  }
  if (isContainerizedRuntime()) {
    const byKey = new Map(bundle.records.map((record) => [record.key, record]))
    const voiceFolders = Array.from(
      new Set(archiveHostFiles.filter((file) => file.root === 'voice-profiles').map((file) => file.folder))
    )
    if (voiceFolders.length > 0) {
      const names = voiceFolders.map((folder) => recordLabel(byKey.get(`voice_profile:${folder}`), folder))
      warnings.push(
        `This Docker Batshit cannot place clone voice recordings on the host computer yet, so these clone voices come back without their recording: ${names.join(', ')}. ` +
          'Record or upload each sample again in Voice Studio.'
      )
    }
  }
  return warnings
}

/**
 * BL-373 review: a folder the restore will replace may belong to another Batshit on this
 * computer (skill ids come from names, and every Batshit shares these folders). Name each one
 * before the restore; the restore keeps the current copy beside it (`.replaced-…`).
 */
async function describeHostFoldersToReplace(bundle: BackupBundle, archiveHostFiles: ArchiveHostFile[]) {
  const byKey = new Map(bundle.records.map((record) => [record.key, record]))
  const sourceUserId = bundle.manifest.source.userId
  const warnings: string[] = []
  for (const files of hostFoldersToPlace(archiveHostFiles).values()) {
    const { root, folder } = files[0]
    const rootPath = resolveHostFileRoot(root)
    const current = path.join(rootPath, folder)
    if (!(await identifyFileNode(current))) continue
    const label = root === 'skills'
      ? `skill "${recordLabel(byKey.get(`skill:${sourceUserId}:${folder}`), folder)}"`
      : `the recording of clone voice "${recordLabel(byKey.get(`voice_profile:${folder}`), folder)}"`
    warnings.push(
      `Restore will replace your current copy of ${label} (${current}). Batshit keeps that copy in a ".replaced-…" folder in ${rootPath}, because another Batshit on this computer may use it.`
    )
  }
  return warnings
}

const MAX_NOT_CARRIED_HEADER_ITEMS = 20

/** The export route's `X-Batshit-Backup-Not-Carried` value: a count and the first few names, URI-encoded JSON. */
export function encodeNotCarriedHeader(entries: HostFolderNotCarried[]) {
  return encodeURIComponent(
    JSON.stringify({
      count: entries.length,
      items: entries.slice(0, MAX_NOT_CARRIED_HEADER_ITEMS).map((entry) => ({
        root: entry.root,
        label: entry.label,
        reason: entry.reason
      }))
    })
  )
}

/**
 * BL-372: a backup made before backups carried prompt metadata cannot say whether a core
 * prompt's text was that version's default or the user's edit. Name every restored prompt whose
 * text is not today's default, because it will read as customized and is never refreshed.
 */
async function describeCorePromptsWithoutMetadata(records: BackupRedisRecord[]) {
  const byKey = new Map(records.map((record) => [record.key, record]))
  const unplaced: string[] = []
  const unreadable: string[] = []
  for (const definition of listCoreSystemPromptDefinitions()) {
    const text = byKey.get(definition.redisKey)
    if (!text || byKey.has(corePromptMetadataKey(definition.id))) continue
    let packagedDefault: string
    try {
      packagedDefault = await readPackagedCoreSystemPromptDefault(definition.redisKey)
    } catch {
      unreadable.push(definition.label)
      continue
    }
    if (String(text.value ?? '') !== packagedDefault) unplaced.push(definition.label)
  }

  const warnings: string[] = []
  if (unplaced.length > 0) {
    warnings.push(
      `This backup is from a Batshit that did not record which core prompts were its defaults. ` +
        `${unplaced.length === 1 ? 'This core prompt differs' : 'These core prompts differ'} from this version's default ` +
        `and will show as customized: ${unplaced.join(', ')}. Batshit never replaces them on its own. ` +
        'If you never edited one, open Settings → Admin → Core System Prompts after the restore and click its Reset.'
    )
  }
  if (unreadable.length > 0) {
    warnings.push(
      `Batshit could not read its packaged default for ${unreadable.join(', ')}, so it cannot say whether the restored text is a default.`
    )
  }
  return warnings
}

const PARTIAL_WARNING_NAMED_FILES = 20

/**
 * BL-378 Phase 1b §4 [B4]: a partial backup restores like any backup: it replaces the current
 * upload files, so a file it lists is missing after the restore even if this computer has it now.
 * Files first, records when they differ; the first 20 files by name. The list itself changes
 * nothing about the restore.
 */
function describePartialBackupWarnings(manifest: BackupManifest) {
  const missing = manifest.completeness === 'partial' ? (manifest.uploads?.missing ?? []) : []
  if (missing.length === 0) return []
  const paths = Array.from(new Set(missing.map((entry) => entry.relativePath)))
  const files = paths.length
  const records = missing.length !== files ? ` (${countedWords(missing.length, 'upload record', 'upload records')})` : ''
  const named = paths.slice(0, PARTIAL_WARNING_NAMED_FILES).map((value) => (value.length > 160 ? `${value.slice(0, 159)}…` : value))
  const more = paths.length > named.length ? `, and ${paths.length - named.length} more` : ''
  return [
    `Partial backup: ${countedWords(files, 'upload file', 'upload files')}${records} ${files === 1 ? 'is' : 'are'} not in this backup. ` +
      `After the restore ${files === 1 ? 'it' : 'they'} will be missing here too, even if this computer has ${files === 1 ? 'it' : 'them'} now.`,
    `Partial backup: the missing ${files === 1 ? 'file is' : 'files are'} ${named.join(', ')}${more}.`
  ]
}

async function buildPreflightWarnings(
  bundle: BackupBundle,
  currentRecordCount: number,
  archiveHostFiles: ArchiveHostFile[] = []
) {
  const manifest = bundle.manifest
  const warnings: string[] = [...describePartialBackupWarnings(manifest)]
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
  const flattenedLists = bundle.records.filter(isFlattenedListRecord).length
  if (flattenedLists > 0) {
    warnings.push(
      `An older Batshit saved ${flattenedLists} one-item ${flattenedLists === 1 ? 'list' : 'lists'} in this backup ` +
        "as a single item (a chat's Execution Viewer log after one run, an artifact order, or a Subagent thread). " +
        `Restore puts ${flattenedLists === 1 ? 'it' : 'them'} back as ${flattenedLists === 1 ? 'a list' : 'lists'}.`
    )
  }
  if (!manifest.secrets.included) {
    warnings.push(...describeStrippedCustomProviderHeaders(bundle.records))
  }
  warnings.push(...describeRetiredPromptMetadata(bundle.records))
  warnings.push(...(await describeCorePromptsWithoutMetadata(bundle.records)))
  warnings.push(...describeHostFileWarnings(bundle, archiveHostFiles))
  warnings.push(...(await describeHostFoldersToReplace(bundle, archiveHostFiles)))
  warnings.push(...manifest.externalReferences)
  return warnings
}

/**
 * Key families whose stored value is a list at the root. Until BL-128 (2026-09-23) export
 * flattened a one-entry list to the entry itself, so an older backup holds a chat's one-run
 * Execution Viewer log as the bare run, a one-artifact order as the bare id, and a one-message
 * Subagent thread as the bare message. Restore puts such a value back in its list and the
 * preflight counts it. Nothing else is reshaped: any other key's value is restored as saved.
 */
const LIST_ROOTED_JSON_KEY_PATTERNS: readonly RegExp[] = [
  /^session:.+:execution_log$/,
  /^user:.+:artifact_order:[^:]+$/,
  /^subagent_sessions:.+:subagent:.+$/
]

function isFlattenedListRecord(record: Pick<BackupRedisRecord, 'key' | 'type' | 'value'>) {
  return (
    record.type === 'json' &&
    record.value !== null &&
    record.value !== undefined &&
    !Array.isArray(record.value) &&
    LIST_ROOTED_JSON_KEY_PATTERNS.some((pattern) => pattern.test(record.key))
  )
}

/**
 * BL-373/BL-369: a restored record that names a host folder the backup carries points at
 * that folder under THIS computer's root. A folder the backup does not carry keeps its stored
 * path: on the same computer it may still be there, and a Docker clone voice's path is a path on
 * the host.
 */
function rewriteHostFolderPaths(key: string, value: unknown, targetUserId: string, placed: ReadonlySet<string>) {
  if (placed.size === 0 || !isPlainObject(value)) return value
  const skillPrefix = `skill:${targetUserId}:`
  if (key.startsWith(skillPrefix)) {
    const folder = key.slice(skillPrefix.length)
    if (!placed.has(hostFolderKey('skills', folder)) || typeof value.cache_path !== 'string') return value
    return { ...value, cache_path: path.join(resolveHostFileRoot('skills'), folder, 'SKILL.md') }
  }
  if (key.startsWith('voice_profile:')) {
    const folder = key.slice('voice_profile:'.length)
    const previousPath = managedReferenceAudioPathOf(value)
    if (!previousPath || !placed.has(hostFolderKey('voice-profiles', folder)) || !isPlainObject(value.settings)) {
      return value
    }
    const nextPath = path.join(resolveHostFileRoot('voice-profiles'), folder, path.basename(previousPath))
    const settings: Record<string, unknown> = { ...value.settings, batshitManagedReferenceAudioPath: nextPath }
    if (isPlainObject(settings.providerOptions)) {
      settings.providerOptions = Object.fromEntries(
        Object.entries(settings.providerOptions).map(([provider, options]) => [
          provider,
          isPlainObject(options) && options.ref_audio === previousPath ? { ...options, ref_audio: nextPath } : options
        ])
      )
    }
    return { ...value, settings }
  }
  return value
}

function buildTargetRecords(
  bundle: BackupBundle,
  targetUserId: string,
  placedHostFolders: ReadonlySet<string> = new Set()
) {
  const sourceUserId = bundle.manifest.source.userId
  const uploadRoot = resolveUploadsDir()
  const uploadRelativePathByBasename = buildUploadRelativePathIndex(bundle.records)
  const avatarServingOverrides = buildAvatarServingUrlOverrides(bundle.records)
  return bundle.records.filter((record) => !isRetiredPromptMetadataKey(record.key)).map((record) => {
    const key = remapUserKey(record.key, sourceUserId, targetUserId)
    if (!isRestorableKeyForUser(key, targetUserId)) {
      throw new BackupRestoreError(`Backup contains a key Batshit will not restore: ${record.key}`, 400)
    }

    let value = remapUserValue(cloneJson(record.value), sourceUserId, targetUserId)
    if (key === `local_provider:${targetUserId}:koboldcpp` && isPlainObject(value)) {
      // Restored preferences cannot mint/reuse host-local filesystem authority.
      // Only a NEW explicit local enrollment after this restore may be bound.
      const prior = isPlainObject(value.managedProfile) ? value.managedProfile : {}
      value = { ...value, managedProfile: {
        version: 1, registrationId: null, state: 'reenrollment-required',
        restoredAt: new Date().toISOString(),
        ...(isPlainObject(prior.desired) ? { desired: prior.desired } : {})
      } }
    }
    if (isFlattenedListRecord({ key, type: record.type, value })) {
      value = [value]
    }
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
    value = rewriteRestoredUploadUrls(value, uploadRelativePathByBasename, avatarServingOverrides)
    value = rewriteContainerProjectPaths(key, value, targetUserId)
    value = rewriteHostFolderPaths(key, value, targetUserId, placedHostFolders)

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
        if (document.documentContract === RECIPE_REVIEWED_STATE_CONTRACT) {
          // A valid wrapper hash does not prove its nested state/sibling hashes.
          // Verify those on the source before any restore-owned transformation.
          await verifyRecipeReviewedState(document.content)
        }
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
    assertDocumentRef(byKey, owner.authoringSourceContainmentReceipt, `Goon ${goonId} authoring source receipt`, userId, goonId)
    if (owner.authoringRevision.updateReport) {
      assertDocumentRef(byKey, owner.authoringRevision.updateReport, `Goon ${goonId} authoring update report`, userId, goonId)
    }
    if (owner.pendingAnalysis) {
      for (const [field, ref] of Object.entries({
        analysisRef: owner.pendingAnalysis.analysisRef,
        basePlan: owner.pendingAnalysis.basePlan,
        selectedPlan: owner.pendingAnalysis.selectedPlan,
        migrationReport: owner.pendingAnalysis.migrationReport,
        containmentReceipt: owner.pendingAnalysis.containmentReceipt,
        reviewedState: owner.pendingAnalysis.reviewedState
      })) {
        if (ref) assertDocumentRef(byKey, ref, `Goon ${goonId} pending analysis ${field}`, userId, goonId)
      }
    }
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
    assertDocumentRef(byKey, job.reviewedState, `${key} reviewed state`, userId, job.goonId)
    if (job.migrationReport) {
      assertDocumentRef(byKey, job.migrationReport, `${key} migration report`, userId, job.goonId)
    }
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
  const reviewedDocumentRefs = new Map<string, RecipeDocumentRef>()
  for (const record of records) {
    if (record.type !== 'json' || !record.key.startsWith(`goon_recipe_document:${userId}:`)) continue
    try {
      const document = parseGoonRecipeDocument(record.value)
      if (document.documentContract !== RECIPE_REVIEWED_STATE_CONTRACT) continue
      // Source verification already succeeded. Rebind only this known state
      // wrapper after URL normalization; migration proofs are not generic JSON.
      await rehashRecipeStateSnapshot(document.content.state)
      await verifyRecipeReviewedState(document.content)
      const transformed = await createGoonRecipeDocument(document)
      const key = recipeDocumentRedisKey(userId, transformed.goonId, transformed.sha256)
      reviewedDocumentRefs.set(record.key, {
        contract: transformed.documentContract, ref: key, sha256: transformed.sha256
      })
      record.key = key
      record.value = transformed
    } catch (error) {
      recipeRestoreError(
        `${record.key} reviewed state could not be rehashed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const updateReviewedDocumentRef = (ref: unknown) => {
    if (!isPlainObject(ref) || typeof ref.ref !== 'string') return
    const transformed = reviewedDocumentRefs.get(ref.ref)
    if (transformed) Object.assign(ref, transformed)
  }
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
      if (isPlainObject(owner.pendingAnalysis)) {
        updateReviewedDocumentRef(owner.pendingAnalysis.reviewedState)
      }
      if (isPlainObject(owner.lastFailure)) updateReviewedDocumentRef(owner.lastFailure.reportRef)
      if (isPlainObject(owner.maintenanceFailure)) updateReviewedDocumentRef(owner.maintenanceFailure.reportRef)
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
      updateReviewedDocumentRef(record.value.reviewedState)
      if (isPlainObject(record.value.failure)) updateReviewedDocumentRef(record.value.failure.reportRef)
      updateRevisionRef(record.value.sourceRevision)
      updateRevisionRef(record.value.candidateRevision)
    }
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

/** Buffer callers use the same journaled restore as the product upload route.
 * There is no second unjournaled filesystem/Redis replacement path. */
export async function restoreBackupBundle(
  userId: string,
  bytes: Uint8Array,
  options?: { confirmReplace?: boolean }
): Promise<RestoreResult> {
  await ensureBackupRestoreReadyForRequest()
  const stageId = randomUUID()
  const paths = stagedRestorePaths(stageId)
  await fs.mkdir(paths.stagingRoot, { recursive: true, mode: 0o700 })
  try {
    const archive = await fs.open(paths.archivePath, 'wx', 0o600)
    try {
      await archive.writeFile(bytes)
      await archive.sync()
    } finally {
      await archive.close()
    }
    await fs.chmod(paths.archivePath, 0o400)
    await writeJsonAtomic(paths.metadataPath, {
      contract: 'batshit-backup-stage/v1', stageId, userId,
      filename: 'batshit-backup.zip', bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      stagedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      archivePath: paths.archivePath
    } satisfies BackupStageMetadata)
    return await restoreStagedBackup(userId, stageId, options)
  } finally {
    // Retain the complete recovery input if rollback could not finish.
    if (!await pathExists(paths.journalPath)) {
      await Promise.all([
        fs.rm(paths.archivePath, { force: true }),
        fs.rm(paths.metadataPath, { force: true })
      ])
    }
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
  hostFiles: ArchiveHostFile[]
}

interface RestoreUploadEntry {
  name: string
  device: string
  inode: string
}

interface RestoreFileIdentity {
  bytes: number
  sha256: string
}

interface RestoreFileNodeIdentity {
  device: string
  inode: string
}

/**
 * BL-373/BL-369 (journal v3): one skill or voice folder a restore replaces. Only the folders
 * the backup carries are touched, never a whole root: `~/.batshit/skills` and
 * `~/.batshit/voice-profiles` are shared by every Batshit on the computer (BL-342). `original`
 * is the folder that was there (null when there was none); `replacement` is the one the
 * restore extracted. A same-volume rename keeps both identities, so recovery can tell them
 * apart after a crash.
 */
interface RestoreHostEntry {
  root: HostFileRootId
  rootPath: string
  name: string
  original: RestoreFileNodeIdentity | null
  replacement: RestoreFileNodeIdentity
}

interface RestoreJournal {
  contract: 'batshit-backup-restore-journal/v1' | 'batshit-backup-restore-journal/v2' | 'batshit-backup-restore-journal/v3'
  stageId: string
  userId: string
  phase: 'prepared' | 'files-old-moved' | 'files-swapped' | 'redis-replacing' | 'redis-complete' | 'rollback-complete'
  hadOriginalUploads: boolean
  originalUploadEntries?: RestoreUploadEntry[]
  hostEntries?: RestoreHostEntry[]
  redisRecoveryFiles?: { plan: RestoreFileIdentity; rollback: RestoreFileIdentity }
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
  for (;;) {
    // BL-713: a restore never waits for an approval card. A send that waits in a chat's line holds
    // this gate for its request, and a line that holds for the user's answer to a card could wait
    // fifteen minutes; each is kept like a shutdown's instead (its words move to the end of the
    // chat, unanswered), so its request lets go at once. Asked at the start and again before every
    // wait: a hold can form during the drain (the reply ahead stops at a card and lets go). A line
    // behind a running reply is that reply's, and the drain waits for it as before.
    keepQueuedSessionTurnsHeldAtApprovalCards('shutdown')
    if (backupRestoreHttpRequestCount <= 1) break
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
    storageKey,
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
  try { await fs.lstat(targetPath); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function syncRestoreDirectory(directory: string) {
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function writeJsonAtomic(targetPath: string, value: unknown) {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally { await handle.close() }
  try {
    await fs.rename(temporaryPath, targetPath)
    await syncRestoreDirectory(path.dirname(targetPath))
  } finally { await fs.rm(temporaryPath, { force: true }) }
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
    const hostFiles: ArchiveHostFile[] = []

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
      } else if (entry.fileName.startsWith(HOST_FILE_ZIP_ROOT)) {
        hostFiles.push(parseArchiveHostFile(entry.fileName, entry.uncompressedSize))
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
    assertPartialManifestAgreement(manifest, resolvedRecords, new Set(fileAssets.map((asset) => asset.relativePath)))
    assertArchiveHostFilesWithinLimits(hostFiles)
    assertArchiveHostFileInventory(manifest, hostFiles)

    return {
      stage,
      archivePath: paths.archivePath,
      manifest,
      records: resolvedRecords,
      fileAssets,
      hostFiles
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
    const hairJobRecords = await captureCurrentHairJobRecords(client, userId)
    const keys = await collectCandidateKeys(client, userId)
    let rollbackBytes = hairJobRecords.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1, 0)
    for (const key of keys) {
      const record = await readRedisRecord(client, key, groupForKey(key, userId))
      if (record) rollbackBytes += Buffer.byteLength(JSON.stringify(record), 'utf8') + 1
    }
    return { currentRecordCount: keys.length + hairJobRecords.length, rollbackBytes, hairJobRecords }
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

/**
 * BL-373/BL-369: the space the placed skill and voice folders need. A root on the upload
 * volume adds to the upload requirement; a root on another volume (Docker keeps
 * `/root/.batshit` in its own volume) is checked on its own.
 */
async function measureHostDiskNeeds(placed: Map<string, ArchiveHostFile[]>, uploadRoot: string) {
  const byRoot = new Map<HostFileRootId, ArchiveHostFile[]>()
  for (const files of placed.values()) {
    for (const file of files) {
      const rootFiles = byRoot.get(file.root) ?? []
      rootFiles.push(file)
      byRoot.set(file.root, rootFiles)
    }
  }
  let sameVolumeBytes = 0
  const shortfalls: Array<{ root: HostFileRootId; rootPath: string; requiredBytes: number; availableBytes: number }> = []
  if (byRoot.size === 0) return { sameVolumeBytes, shortfalls }

  const uploadDevice = (await fs.stat(uploadRoot)).dev
  for (const [root, files] of byRoot) {
    const rootPath = resolveHostFileRoot(root)
    const { availableBytes, blockSize } = await getDiskCapacity(rootPath)
    const directories = new Set<string>()
    for (const file of files) {
      let directory = path.posix.dirname(`${file.folder}/${file.relativePath}`)
      while (directory !== '.' && directory !== '/') {
        directories.add(directory)
        directory = path.posix.dirname(directory)
      }
    }
    const requiredBytes =
      files.reduce((sum, file) => sum + Math.ceil(Math.max(file.byteLength, 1) / blockSize) * blockSize, 0) +
      (directories.size + 2) * blockSize
    if ((await fs.stat(rootPath)).dev === uploadDevice) sameVolumeBytes += requiredBytes
    else if (availableBytes < requiredBytes) shortfalls.push({ root, rootPath, requiredBytes, availableBytes })
  }
  return { sameVolumeBytes, shortfalls }
}

function describeHostDiskShortfall(shortfall: { root: HostFileRootId; rootPath: string; requiredBytes: number; availableBytes: number }) {
  return (
    `Restoring ${shortfall.root === 'skills' ? 'skill files' : 'clone voice recordings'} needs ${shortfall.requiredBytes} bytes free in ` +
    `${shortfall.rootPath}, but only ${shortfall.availableBytes} are available.`
  )
}

export async function preflightStagedBackupRestore(
  userId: string,
  stageId: string
): Promise<BackupPreflightSummary> {
  await ensureBackupRestoreReadyForRequest()
  const bundle = await readStagedBackup(userId, stageId)
  await validateRecipeRestoreGraph(bundle.records, bundle.manifest.source.userId)
  const placedHostFolders = hostFoldersToPlace(bundle.hostFiles)
  const targetRecords = buildTargetRecords(asBackupBundle(bundle), userId, new Set(placedHostFolders.keys()))
  assertHostFoldersHaveOwners(bundle.hostFiles, targetRecords, userId)
  await rehashTransformedRecipeGraph(targetRecords, userId)
  await validateRecipeRestoreGraph(targetRecords, userId)

  const { currentRecordCount, rollbackBytes } = await measureCurrentRestoreState(userId)
  const fileAssetBytes = bundle.fileAssets.reduce((sum, asset) => sum + asset.byteLength, 0)
  const restorePlanBytes = targetRecords.reduce(
    (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1,
    0
  )
  const { availableBytes, blockSize } = await getDiskCapacity(resolveUploadsDir())
  const hostDisk = await measureHostDiskNeeds(placedHostFolders, resolveUploadsDir())
  const requiredBytes =
    estimateRestoreDiskBytes(bundle.fileAssets, rollbackBytes, restorePlanBytes, blockSize) + hostDisk.sameVolumeBytes
  const legacyBundle = asBackupBundle(bundle)
  const warnings = await buildPreflightWarnings(legacyBundle, currentRecordCount, bundle.hostFiles)
  if (availableBytes < requiredBytes) {
    warnings.unshift('This restore needs more free disk space before Batshit can safely stage files and preserve rollback data.')
  }
  for (const shortfall of hostDisk.shortfalls) warnings.unshift(describeHostDiskShortfall(shortfall))

  return {
    ok: true,
    manifest: bundle.manifest,
    redisRecordCount: bundle.records.length,
    fileAssetCount: bundle.fileAssets.length,
    fileAssetBytes,
    hostFileCount: bundle.hostFiles.length,
    hostFileBytes: bundle.hostFiles.reduce((sum, file) => sum + file.byteLength, 0),
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
      sufficient: availableBytes >= requiredBytes && hostDisk.shortfalls.length === 0,
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

async function writeCurrentRollbackNdjson(filePath: string, userId: string, hairJobRecords: BackupRedisRecord[]) {
  await redis.execute(async (client) => {
    const handle = await fs.open(filePath, 'w', 0o600)
    try {
      const keys = await collectCandidateKeys(client, userId)
      for (const key of keys) {
        const record = await readRedisRecord(client, key, groupForKey(key, userId))
        if (record) await handle.write(`${JSON.stringify(record)}\n`)
      }
      for (const record of hairJobRecords) await handle.write(`${JSON.stringify(record)}\n`)
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

async function identifyRestoreFile(filePath: string): Promise<RestoreFileIdentity> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length
    hash.update(chunk)
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function restoreRedisFromRollback(planPath: string, rollbackPath: string, journal: RestoreJournal) {
  if (!await pathExists(planPath) || !await pathExists(rollbackPath)) {
    throw new BackupRestoreError('Restore rollback data is missing. Recovery stopped before changing Redis.', 500)
  }
  for (const [filePath, expected] of [
    [planPath, journal.redisRecoveryFiles?.plan],
    [rollbackPath, journal.redisRecoveryFiles?.rollback]
  ] as const) {
    if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 ||
        typeof expected.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
      throw new BackupRestoreError('The restore journal lacks valid Redis rollback identities. Recovery stopped before changing Redis.', 500)
    }
    const actual = await identifyRestoreFile(filePath)
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new BackupRestoreError('Restore rollback data no longer matches its journal. Recovery stopped before changing Redis.', 500)
    }
    // Validate the complete stream before the first Redis delete, retaining
    // bounded memory even for a large backup. Private staging owns these files.
    await forEachNdjsonRecord(filePath, async () => {})
  }
  await redis.execute(async (client) => {
    await deleteRecordKeysFromPlan(client, planPath)
    await forEachNdjsonRecord(rollbackPath, async (record) => {
      await writeRecord(client, record)
    })
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
  return (await fs.readdir(uploadRoot)).filter((name) => !isRestoreTransactionEntry(name)).sort()
}

async function moveDirectoryContents(sourceRoot: string, targetRoot: string) {
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 })
  for (const name of await fs.readdir(sourceRoot)) {
    await fs.rename(path.join(sourceRoot, name), path.join(targetRoot, name))
  }
}

async function captureOriginalUploadEntries(uploadRoot: string): Promise<RestoreUploadEntry[]> {
  return Promise.all((await listLiveUploadEntries(uploadRoot)).map(async (name) => {
    const stat = await fs.lstat(path.join(uploadRoot, name), { bigint: true })
    return { name, device: String(stat.dev), inode: String(stat.ino) }
  }))
}

function requireOriginalUploadEntries(journal: RestoreJournal): RestoreUploadEntry[] {
  if (
    (journal.contract !== 'batshit-backup-restore-journal/v2' && journal.contract !== 'batshit-backup-restore-journal/v3') ||
    !Array.isArray(journal.originalUploadEntries)
  ) {
    throw new BackupRestoreError('This interrupted restore predates safe per-file recovery. Batshit kept its files and journal; manual recovery is required.', 500)
  }
  const entries = journal.originalUploadEntries
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' ||
        /[\\/\0]/.test(entry.name) || isRestoreTransactionEntry(entry.name) || names.has(entry.name) ||
        typeof entry.device !== 'string' || !/^\d+$/.test(entry.device) ||
        typeof entry.inode !== 'string' || !/^\d+$/.test(entry.inode)) {
      throw new BackupRestoreError('The restore journal has an invalid original-file inventory; no files were changed.', 500)
    }
    names.add(entry.name)
  }
  if (journal.hadOriginalUploads !== (entries.length > 0)) {
    throw new BackupRestoreError('The restore journal original-file inventory is inconsistent.', 500)
  }
  return entries
}

async function restoreUploadTree(paths: ReturnType<typeof stagedRestorePaths>, entries: RestoreUploadEntry[]) {
  const statIfPresent = async (target: string) => {
    try { return await fs.lstat(target, { bigint: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const matches = (stat: Awaited<ReturnType<typeof statIfPresent>>, entry: RestoreUploadEntry) =>
    stat !== null && String(stat.dev) === entry.device && String(stat.ino) === entry.inode
  const names = new Set(entries.map((entry) => entry.name))
  const oldExists = await pathExists(paths.oldUploadRoot)
  if (oldExists && (await fs.readdir(paths.oldUploadRoot)).some((name) => !names.has(name))) {
    throw new BackupRestoreError('Unexpected files remain in the restore rollback directory. Recovery stopped without deleting them.', 500)
  }
  // Census every original before any removal. A same-volume rename preserves
  // identity, so a returned original is recognizable even if the process died
  // before recording progress. Missing/mismatched originals fail closed.
  const pending: RestoreUploadEntry[] = []
  for (const entry of entries) {
    const old = await statIfPresent(path.join(paths.oldUploadRoot, entry.name))
    const live = await statIfPresent(path.join(paths.uploadRoot, entry.name))
    if (old ? !matches(old, entry) || matches(live, entry) : !matches(live, entry)) {
      throw new BackupRestoreError(`Original upload entry "${entry.name}" could not be verified. Recovery kept the journal and remaining files.`, 500)
    }
    if (old) pending.push(entry)
  }
  for (const name of await listLiveUploadEntries(paths.uploadRoot)) {
    if (!names.has(name)) await fs.rm(path.join(paths.uploadRoot, name), { recursive: true, force: true })
  }
  for (const entry of pending) {
    const livePath = path.join(paths.uploadRoot, entry.name)
    await fs.rm(livePath, { recursive: true, force: true })
    await fs.rename(path.join(paths.oldUploadRoot, entry.name), livePath)
    await syncRestoreDirectory(paths.oldUploadRoot)
    await syncRestoreDirectory(paths.uploadRoot)
  }
  await syncRestoreDirectory(paths.uploadRoot)
  // Keep the transaction roots until rollback-complete is durable. Cleanup is
  // independently retryable and removes the journal last.
}

function hostTransactionDirs(rootPath: string, storageKey: string) {
  return {
    newDir: path.join(rootPath, `.restore-new-${storageKey}`),
    oldDir: path.join(rootPath, `.restore-old-${storageKey}`)
  }
}

async function identifyFileNode(target: string): Promise<RestoreFileNodeIdentity | null> {
  try {
    const stat = await fs.lstat(target, { bigint: true })
    return { device: String(stat.dev), inode: String(stat.ino) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameFileNode(left: RestoreFileNodeIdentity | null, right: RestoreFileNodeIdentity | null) {
  return left !== null && right !== null && left.device === right.device && left.inode === right.inode
}

/**
 * BL-373/BL-369: extract each placed skill or voice folder into `{root}/.restore-new-{key}/`
 * (the root's own volume, so moving it in is an atomic rename) and record the identity of the
 * extracted folder and of the folder it replaces. A failure removes what it extracted.
 */
async function extractStagedHostFolders(
  bundle: StagedBackupBundle,
  placed: Map<string, ArchiveHostFile[]>,
  storageKey: string
): Promise<RestoreHostEntry[]> {
  if (placed.size === 0) return []
  const roots = new Map<HostFileRootId, string>()
  for (const files of placed.values()) roots.set(files[0].root, resolveHostFileRoot(files[0].root))
  const newDirs = Array.from(roots.values()).map((rootPath) => hostTransactionDirs(rootPath, storageKey).newDir)
  try {
    for (const [, rootPath] of roots) {
      const { newDir } = hostTransactionDirs(rootPath, storageKey)
      await fs.mkdir(rootPath, { recursive: true })
      await fs.rm(newDir, { recursive: true, force: true })
      await fs.mkdir(newDir, { mode: 0o700 })
    }
    let count = 0
    let bytes = 0
    let zipFile: AsyncZipFile | null = null
    try {
      zipFile = await openLazyZip(bundle.archivePath)
      for await (const entry of zipFile.eachEntry()) {
        if (entry.fileName.endsWith('/') || !entry.fileName.startsWith(HOST_FILE_ZIP_ROOT)) continue
        assertReadableBackupEntry(entry)
        const file = parseArchiveHostFile(entry.fileName, entry.uncompressedSize)
        if (!placed.has(hostFolderKey(file.root, file.folder))) continue
        const { newDir } = hostTransactionDirs(roots.get(file.root)!, storageKey)
        const targetPath = safeJoin(newDir, `${file.folder}/${file.relativePath}`)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        const input = await zipFile.openReadStreamPromise(entry)
        await pipeline(input, createWriteStream(targetPath, { flags: 'wx' }))
        count += 1
        bytes += entry.uncompressedSize
      }
    } finally {
      zipFile?.close()
    }
    const expected = Array.from(placed.values()).flat()
    if (count !== expected.length || bytes !== expected.reduce((sum, file) => sum + file.byteLength, 0)) {
      throw new BackupRestoreError('Extracted skill and voice files do not match the validated backup.', 400)
    }

    const entries: RestoreHostEntry[] = []
    for (const key of Array.from(placed.keys()).sort()) {
      const { root, folder } = placed.get(key)![0]
      const rootPath = roots.get(root)!
      const replacement = await identifyFileNode(path.join(hostTransactionDirs(rootPath, storageKey).newDir, folder))
      if (!replacement) throw new BackupRestoreError(`Extracted folder "${key}" is missing.`, 500)
      entries.push({ root, rootPath, name: folder, original: await identifyFileNode(path.join(rootPath, folder)), replacement })
    }
    return entries
  } catch (error) {
    await Promise.all(newDirs.map((newDir) => fs.rm(newDir, { recursive: true, force: true }).catch(() => undefined)))
    throw error
  }
}

function hostFolderChangedError(entry: RestoreHostEntry) {
  return new BackupRestoreError(
    `Another Batshit on this computer changed the ${entry.root === 'skills' ? 'skill' : 'voice'} folder "${entry.name}" ` +
      `in ${entry.rootPath} while the restore was running. Batshit left it alone; try the restore again.`,
    409
  )
}

/**
 * The folders are shared by every Batshit on the computer (BL-342), so one may change between
 * extraction and the moves. Each folder must still be exactly the one the journal recorded: the
 * original where it was (or no folder when there was none), the replacement where it was put.
 * Checked for every folder before the restore changes anything, and again right before each move.
 */
async function assertHostFolderUnchanged(entry: RestoreHostEntry, storageKey: string, stage: 'before-move' | 'before-move-in') {
  const live = await identifyFileNode(path.join(entry.rootPath, entry.name))
  const extracted = await identifyFileNode(path.join(hostTransactionDirs(entry.rootPath, storageKey).newDir, entry.name))
  const liveAsRecorded = stage === 'before-move'
    ? entry.original ? sameFileNode(live, entry.original) : live === null
    : live === null
  if (!liveAsRecorded || !sameFileNode(extracted, entry.replacement)) throw hostFolderChangedError(entry)
}

async function assertHostFoldersUnchanged(entries: RestoreHostEntry[], storageKey: string) {
  for (const entry of entries) await assertHostFolderUnchanged(entry, storageKey, 'before-move')
}

async function moveHostOriginalsAside(entries: RestoreHostEntry[], storageKey: string) {
  for (const entry of entries) {
    if (!entry.original) continue
    await assertHostFolderUnchanged(entry, storageKey, 'before-move')
    const { oldDir } = hostTransactionDirs(entry.rootPath, storageKey)
    await fs.mkdir(oldDir, { recursive: true, mode: 0o700 })
    await fs.rename(path.join(entry.rootPath, entry.name), path.join(oldDir, entry.name))
  }
}

async function moveHostReplacementsIn(entries: RestoreHostEntry[], storageKey: string) {
  const roots = new Set<string>()
  for (const entry of entries) {
    // A rename onto an empty folder would silently replace it: the place must be empty.
    await assertHostFolderUnchanged(entry, storageKey, 'before-move-in')
    const { newDir } = hostTransactionDirs(entry.rootPath, storageKey)
    await fs.rename(path.join(newDir, entry.name), path.join(entry.rootPath, entry.name))
    roots.add(entry.rootPath)
  }
  for (const rootPath of roots) {
    await fs.rm(hostTransactionDirs(rootPath, storageKey).newDir, { recursive: true, force: true })
    await syncRestoreDirectory(rootPath)
  }
}

/**
 * Put every replaced skill or voice folder back. Like `restoreUploadTree`, it first checks
 * every entry (a census) and moves or removes nothing unless each one is where one of its two
 * recorded identities says. A folder the restore never moved (its original not in the rollback
 * folder) that another Batshit has since changed or removed is left alone: it was never this
 * restore's to touch, and refusing would keep the next start stuck on it. What stops recovery
 * with the journal intact is a state this restore's own moves could have caused: an original
 * in the rollback folder that is not the recorded one, or the replacement live while the
 * original is in neither place.
 */
async function restoreHostFolders(entries: RestoreHostEntry[], storageKey: string) {
  if (entries.length === 0) return
  const namesWithOriginal = new Map<string, Set<string>>()
  for (const entry of entries) {
    const names = namesWithOriginal.get(entry.rootPath) ?? new Set<string>()
    if (entry.original) names.add(entry.name)
    namesWithOriginal.set(entry.rootPath, names)
  }
  for (const [rootPath, names] of namesWithOriginal) {
    const { oldDir } = hostTransactionDirs(rootPath, storageKey)
    if (await pathExists(oldDir) && (await fs.readdir(oldDir)).some((name) => !names.has(name))) {
      throw new BackupRestoreError('Unexpected folders remain in a skill or voice restore rollback folder. Recovery stopped without deleting them.', 500)
    }
  }

  const remove: string[] = []
  const returnOriginal: Array<{ from: string; to: string }> = []
  for (const entry of entries) {
    const oldPath = path.join(hostTransactionDirs(entry.rootPath, storageKey).oldDir, entry.name)
    const livePath = path.join(entry.rootPath, entry.name)
    const old = await identifyFileNode(oldPath)
    const live = await identifyFileNode(livePath)
    const liveIsReplacement = sameFileNode(live, entry.replacement)
    const verified = entry.original
      ? old
        ? sameFileNode(old, entry.original) && (live === null || liveIsReplacement)
        : !liveIsReplacement
      : old === null
    if (!verified) {
      throw new BackupRestoreError(
        `Folder "${entry.name}" in ${entry.rootPath} could not be verified. Recovery kept the journal and remaining files.`,
        500
      )
    }
    if (liveIsReplacement) remove.push(livePath)
    if (entry.original && old) returnOriginal.push({ from: oldPath, to: livePath })
  }
  for (const livePath of remove) await fs.rm(livePath, { recursive: true, force: true })
  for (const move of returnOriginal) await fs.rename(move.from, move.to)
  for (const rootPath of namesWithOriginal.keys()) await syncRestoreDirectory(rootPath)
}

function requireHostEntries(journal: RestoreJournal): RestoreHostEntry[] {
  if (journal.contract !== 'batshit-backup-restore-journal/v3') return []
  if (!Array.isArray(journal.hostEntries)) {
    throw new BackupRestoreError('The restore journal has no skill and voice folder inventory; no files were changed.', 500)
  }
  const isIdentity = (value: unknown): value is RestoreFileNodeIdentity =>
    isPlainObject(value) && typeof value.device === 'string' && /^\d+$/.test(value.device) &&
    typeof value.inode === 'string' && /^\d+$/.test(value.inode)
  const seen = new Set<string>()
  for (const entry of journal.hostEntries) {
    const valid =
      isPlainObject(entry) && isHostFileRootId(entry.root) && isSafeHostFolderName(entry.name) &&
      typeof entry.rootPath === 'string' && (entry.original === null || isIdentity(entry.original)) &&
      isIdentity(entry.replacement) && !seen.has(hostFolderKey(entry.root, entry.name))
    if (!valid) {
      throw new BackupRestoreError('The restore journal has an invalid skill and voice folder inventory; no files were changed.', 500)
    }
    if (entry.rootPath !== resolveHostFileRoot(entry.root)) {
      throw new BackupRestoreError(
        `The ${entry.root} folder moved since the interrupted restore (${entry.rootPath}). Batshit kept its files and journal; manual recovery is required.`,
        500
      )
    }
    seen.add(hostFolderKey(entry.root, entry.name))
  }
  return journal.hostEntries
}

/**
 * BL-373 review: where a completed restore keeps the skill and voice folders it replaced, beside
 * their root: another Batshit on this computer may have been using the folder (skill ids come
 * from names, and every Batshit shares `~/.batshit/skills`), so its copy is never deleted. The
 * name is stable for one restore (its journal's `createdAt` and storage key), so a retried
 * cleanup finds the same place.
 */
function hostReplacedDir(rootPath: string, storageKey: string, createdAt: string) {
  const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return path.join(rootPath, `.replaced-${stamp}-${storageKey.slice(0, 8)}`)
}

export interface KeptHostFolder {
  root: HostFileRootId
  folder: string
  path: string
}

/** Move each root's rollback folder, holding the replaced originals, to its `.replaced-…` name. */
async function keepReplacedHostFolders(
  hostEntries: RestoreHostEntry[],
  storageKey: string,
  createdAt: string
): Promise<KeptHostFolder[]> {
  const kept: KeptHostFolder[] = []
  for (const rootPath of new Set(hostEntries.map((entry) => entry.rootPath))) {
    const { oldDir } = hostTransactionDirs(rootPath, storageKey)
    const keptDir = hostReplacedDir(rootPath, storageKey, createdAt)
    if (await pathExists(oldDir)) {
      await fs.rename(oldDir, keptDir)
      await syncRestoreDirectory(rootPath)
    }
    for (const entry of hostEntries) {
      if (entry.rootPath === rootPath && entry.original && await pathExists(path.join(keptDir, entry.name))) {
        kept.push({ root: entry.root, folder: entry.name, path: path.join(keptDir, entry.name) })
      }
    }
  }
  return kept
}

async function cleanupRestoreOperation(
  paths: ReturnType<typeof stagedRestorePaths>,
  removeStage: boolean,
  hostEntries: RestoreHostEntry[] = [],
  createdAt = ''
): Promise<KeptHostFolder[]> {
  // A completed restore KEEPS the folders it replaced (never deletes them); a rolled-back one
  // has already put every original back, so its rollback folder holds nothing.
  const kept = removeStage ? await keepReplacedHostFolders(hostEntries, paths.storageKey, createdAt) : []
  const hostDirs = Array.from(new Set(hostEntries.map((entry) => entry.rootPath))).flatMap((rootPath) => {
    const { newDir, oldDir } = hostTransactionDirs(rootPath, paths.storageKey)
    return removeStage ? [newDir] : [newDir, oldDir]
  })
  const cleanup = await Promise.allSettled([
    fs.rm(paths.oldUploadRoot, { recursive: true, force: true }),
    fs.rm(paths.newUploadRoot, { recursive: true, force: true }),
    ...hostDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    fs.rm(paths.rollbackPath, { force: true }),
    fs.rm(paths.planPath, { force: true }),
    ...(removeStage
      ? [fs.rm(paths.archivePath, { force: true }), fs.rm(paths.metadataPath, { force: true })]
      : [])
  ])
  for (const result of cleanup) {
    if (result.status === 'rejected') throw result.reason
  }
  // The journal is the durable unsettled-work signal. Never remove it in
  // parallel with cleanup that can fail and leave restore work unresolved.
  await fs.rm(paths.journalPath, { force: true })
  return kept
}

async function recoverRestoreJournal(journalPath: string) {
  const raw = JSON.parse(await fs.readFile(journalPath, 'utf8')) as RestoreJournal
  if (
    ![
      'batshit-backup-restore-journal/v1',
      'batshit-backup-restore-journal/v2',
      'batshit-backup-restore-journal/v3'
    ].includes(raw.contract) ||
    typeof raw.userId !== 'string'
  ) {
    throw new BackupRestoreError('An interrupted restore journal is invalid and requires manual recovery.', 500)
  }
  const paths = stagedRestorePaths(raw.stageId)
  if (paths.journalPath !== journalPath) {
    throw new BackupRestoreError('An interrupted restore journal path is invalid.', 500)
  }

  const hostEntries = requireHostEntries(raw)
  if (raw.phase === 'redis-complete' || raw.phase === 'rollback-complete') {
    const kept = await cleanupRestoreOperation(paths, raw.phase === 'redis-complete', hostEntries, raw.createdAt)
    for (const folder of kept) {
      console.warn(`[BackupRestore] The restore replaced ${folder.root}/${folder.folder}; Batshit kept the previous copy in ${folder.path}.`)
    }
    return
  }

  if (!['prepared', 'files-old-moved', 'files-swapped', 'redis-replacing'].includes(raw.phase)) {
    throw new BackupRestoreError('The interrupted restore journal phase is invalid.', 500)
  }
  const entries = requireOriginalUploadEntries(raw)
  if (raw.phase === 'redis-replacing') {
    await restoreRedisFromRollback(paths.planPath, paths.rollbackPath, raw)
  }
  await restoreUploadTree(paths, entries)
  await restoreHostFolders(hostEntries, paths.storageKey)
  raw.phase = 'rollback-complete'
  await saveRestoreJournal(paths, raw)
  await cleanupRestoreOperation(paths, false, hostEntries)
}

/**
 * A restore extracts its upload files into `{uploads}/.restore-new-{key}/` before it writes
 * its journal, so a process that died in between left that folder with no journal to clean it
 * up. After every journal is resolved, such a folder is only an orphan copy of the backup's files
 * and is removed. Never a `.restore-old-*` folder (it holds originals), and never in the shared
 * skill or voice roots: another Batshit on the computer, with its own staging folder, may be
 * extracting there right now (BL-342).
 */
async function sweepOrphanedUploadRestoreFolders(stagingRoot: string) {
  const uploadRoot = resolveUploadsDir()
  let names: string[]
  try {
    names = await fs.readdir(uploadRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    const match = /^\.restore-new-([0-9a-f]{64})$/.exec(name)
    if (!match) continue
    if (await pathExists(path.join(stagingRoot, `${match[1]}.restore-journal.json`))) continue
    await fs.rm(path.join(uploadRoot, name), { recursive: true, force: true })
    console.warn(`[BackupRestore] Removed ${name} from ${uploadRoot}: an interrupted restore left it before writing its journal.`)
  }
}

let restoreRecoveryPromise: Promise<void> | null = null

/** Resolve every interrupted restore journal (both entry points share one pass at a time). */
function recoverRestoreJournals() {
  if (!restoreRecoveryPromise) {
    restoreRecoveryPromise = (async () => {
      const stagingRoot = resolveBackupStagingDir()
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 })
      const journals = (await fs.readdir(stagingRoot))
        .filter((name) => name.endsWith('.restore-journal.json'))
        .sort()
      const pendingAssetRestore = await readPendingGoonAssetRestore(stagingRoot)
      if (journals.length > 0) {
        await withRecipeVerificationRestore(async () => {
          await assertNoGoonAssetMaintenanceForRestore()
          for (const name of journals) {
            await recoverRestoreJournal(path.join(stagingRoot, name))
          }
        }, true)
      } else if (pendingAssetRestore) {
        await withRecipeVerificationRestoreEpoch(() => completePendingGoonAssetRestore(stagingRoot))
      }
    })().finally(() => {
      restoreRecoveryPromise = null
    })
  }
  return restoreRecoveryPromise
}

/**
 * The STARTUP pass (`hooks.server.ts`, before any request is served): resolve interrupted
 * journals, then clear what a dead process left behind: its stale `active-restore.lock` and any
 * upload extraction folder no journal names. Only here: at startup no restore of this process
 * can be running, while on a request path a lock or an unjournaled folder may belong to the
 * restore that is running right now (re-review of BL-373).
 */
export function ensureBackupRestoreRecovery() {
  if (isGoonAssetRestoreActive()) {
    return Promise.reject(new BackupRestoreError('Another backup restore is already running.', 409))
  }
  return recoverRestoreJournals().then(async () => {
    const stagingRoot = resolveBackupStagingDir()
    await fs.rm(path.join(stagingRoot, RESTORE_LOCK_NAME), { force: true })
    await sweepOrphanedUploadRestoreFolders(stagingRoot)
  })
}

/**
 * A request path (Inspect, Restore): refuse while a restore holds the lock or the in-process
 * barrier, and never clean up (the lock, or an unjournaled `.restore-new-*`, may be that
 * restore's). Otherwise resolve any interrupted journal first, as before.
 */
async function ensureBackupRestoreReadyForRequest() {
  if (isGoonAssetRestoreActive() || await pathExists(path.join(resolveBackupStagingDir(), RESTORE_LOCK_NAME))) {
    throw new BackupRestoreError('Another backup restore is already running.', 409)
  }
  await recoverRestoreJournals()
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
  await ensureBackupRestoreReadyForRequest()
  const { withKoboldSettingsMutation } = await import('./localAiModelManagement')
  return withKoboldSettingsMutation(userId, () => withRecipeVerificationRestore(() => restoreStagedBackupData(userId, stageId, options)))
}

async function restoreStagedBackupData(
  userId: string,
  stageId: string,
  options?: { confirmReplace?: boolean }
): Promise<RestoreResult> {
  const paths = stagedRestorePaths(stageId)
  const lock = await acquireRestoreLock(paths)
  try {
    const bundle = await readStagedBackup(userId, stageId)
    await validateRecipeRestoreGraph(bundle.records, bundle.manifest.source.userId)
    const { currentRecordCount, rollbackBytes, hairJobRecords } = await measureCurrentRestoreState(userId)
    if (currentRecordCount > 0 && options?.confirmReplace !== true) {
      throw new BackupRestoreError(
        'Restore would replace existing Batshit data. Confirm destructive restore first.',
        409,
        { currentRecordCount }
      )
    }

    const placedHostFolders = hostFoldersToPlace(bundle.hostFiles)
    const targetRecords = buildTargetRecords(asBackupBundle(bundle), userId, new Set(placedHostFolders.keys()))
    assertHostFoldersHaveOwners(bundle.hostFiles, targetRecords, userId)
    await rehashTransformedRecipeGraph(targetRecords, userId)
    await validateRecipeRestoreGraph(targetRecords, userId)

    const restorePlanBytes = targetRecords.reduce(
      (sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1,
      0
    )
    const { availableBytes, blockSize } = await getDiskCapacity(paths.uploadRoot)
    const hostDisk = await measureHostDiskNeeds(placedHostFolders, paths.uploadRoot)
    const requiredBytes =
      estimateRestoreDiskBytes(bundle.fileAssets, rollbackBytes, restorePlanBytes, blockSize) + hostDisk.sameVolumeBytes
    if (availableBytes < requiredBytes || hostDisk.shortfalls.length > 0) {
      throw new BackupRestoreError(
        hostDisk.shortfalls.length > 0
          ? `Restore cannot start. ${hostDisk.shortfalls.map(describeHostDiskShortfall).join(' ')}`
          : 'Restore cannot start because there is not enough free disk space for restored files and rollback data.',
        409,
        { requiredBytes, availableBytes, hostShortfalls: hostDisk.shortfalls }
      )
    }

    const uploadedFiles = await extractStagedUploadFiles(bundle, paths.newUploadRoot)
    await writeRecordsNdjson(paths.planPath, targetRecords)
    await writeCurrentRollbackNdjson(paths.rollbackPath, userId, hairJobRecords)
    const [plan, rollback] = await Promise.all([
      identifyRestoreFile(paths.planPath), identifyRestoreFile(paths.rollbackPath)
    ])
    const originalUploadEntries = await captureOriginalUploadEntries(paths.uploadRoot)
    // BL-373/BL-369: the skill and voice folders, extracted beside their roots. Journal v3
    // records them; an older Batshit meeting a v3 journal stops for manual recovery.
    const hostEntries = await extractStagedHostFolders(bundle, placedHostFolders, paths.storageKey)
    const journal: RestoreJournal = {
      contract: 'batshit-backup-restore-journal/v3',
      stageId,
      userId,
      phase: 'prepared',
      hadOriginalUploads: originalUploadEntries.length > 0,
      originalUploadEntries,
      hostEntries,
      redisRecoveryFiles: { plan, rollback },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await saveRestoreJournal(paths, journal)

    try {
      // Publish and fsync the host fence before destructive changes. This is
      // outside Redis rollback: failure after fencing keeps old grants inactive.
      // The explicit stage UUID makes same-operation retry idempotent; audit
      // timestamps never decide authority. Absent provider fields cannot bypass it.
      if (process.env.BATSHIT_RUNTIME_OWNER === 'mac-app' && process.env.BATSHIT_CONTAINERIZED !== '1') {
        const { managedProfileHelper } = await import('./localAiManagedProfiles')
        const priorProvider = await redis.json.get(`local_provider:${userId}:koboldcpp`)
        await managedProfileHelper('fence-restore', { userId, operationId: stageId, requireState: isPlainObject(priorProvider) && priorProvider.managedProfile !== undefined })
      }
      // Nothing changes unless every skill and voice folder is still the one recorded.
      await assertHostFoldersUnchanged(hostEntries, paths.storageKey)
      await fs.mkdir(paths.oldUploadRoot, { recursive: true, mode: 0o700 })
      for (const { name } of originalUploadEntries) {
        await fs.rename(path.join(paths.uploadRoot, name), path.join(paths.oldUploadRoot, name))
      }
      await moveHostOriginalsAside(hostEntries, paths.storageKey)
      journal.phase = 'files-old-moved'
      await saveRestoreJournal(paths, journal)
      await moveDirectoryContents(paths.newUploadRoot, paths.uploadRoot)
      await fs.rm(paths.newUploadRoot, { recursive: true, force: true })
      await moveHostReplacementsIn(hostEntries, paths.storageKey)
      journal.phase = 'files-swapped'
      await saveRestoreJournal(paths, journal)

      journal.phase = 'redis-replacing'
      await saveRestoreJournal(paths, journal)
      await redis.execute(async (client) => {
        const currentKeys = await collectCandidateKeys(client, userId)
        await deleteRecords(client, [...currentKeys, ...targetRecords.map((record) => record.key), ...hairJobRecords.map((record) => record.key)])
        for (const record of targetRecords) await writeRecord(client, record)
      })
    } catch (error) {
      try {
        if (journal.phase === 'redis-replacing') {
          await restoreRedisFromRollback(paths.planPath, paths.rollbackPath, journal)
        }
        await restoreUploadTree(paths, originalUploadEntries)
        await restoreHostFolders(hostEntries, paths.storageKey)
        journal.phase = 'rollback-complete'
        await saveRestoreJournal(paths, journal)
        await cleanupRestoreOperation(paths, false, hostEntries)
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

    // Do not roll back from an in-memory phase when publishing this marker
    // fails: rename may already have succeeded. Keep both trees and the fence;
    // recovery must use the actual persisted phase to finish or undo BOTH stores.
    journal.phase = 'redis-complete'
    await saveRestoreJournal(paths, journal)
    const keptHostFolders = await cleanupRestoreOperation(paths, true, hostEntries, journal.createdAt)
    for (const folder of keptHostFolders) {
      console.info(`[BackupRestore] The restore replaced ${folder.root}/${folder.folder}; Batshit kept the previous copy in ${folder.path}.`)
    }

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

    // BL-372: the prompt texts and their metadata came from another point in time, and agents
    // compile from the stored text. Refresh an uncustomized older default now, as the boot seed
    // would at the next start. A failure keeps the completed restore and logs loudly; the boot
    // seed and every Admin visit run the same check again.
    try {
      await reconcileCoreSystemPromptsAfterRestore()
    } catch (promptError) {
      console.error(
        '[BackupRestore] Restore completed but the core prompt default check failed; it runs again at the next start or Admin visit:',
        promptError
      )
    }

    // SA-118 DL-118-01 — same reason as `restoreBackupBundle`: the schedule keyspace was
    // replaced from outside the store, so its due cache has to be thrown away.
    invalidateScheduleDueCache()
    mcpToolListCache.clearUser(userId)

    return {
      restored: true,
      redisRecordCount: targetRecords.length,
      fileAssetCount: uploadedFiles.count,
      fileAssetBytes: uploadedFiles.bytes,
      hostFileCount: Array.from(placedHostFolders.values()).flat().length,
      hostFileBytes: Array.from(placedHostFolders.values()).flat().reduce((sum, file) => sum + file.byteLength, 0),
      keptHostFolders,
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

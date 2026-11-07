import { readMemoryObservation } from './memoryOwnership'
import { currentMemoryDeliveryAdmission } from './memoryDeliveryAdmission'
import { acquireSettingsMutation, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from '../appActions/settings/lifecycle'
import { MemoryMutationError, memoryMutationUnknown } from './memoryMutation'
import { memoryIsEligible } from './memoryState'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { redis } from '$lib/server/redis'
import { loadClipRow } from '$lib/server/services/clipService'
import { resolveClipDataUrlFromStoredUpload } from '$lib/server/services/clipUploadPayload'
import type { MemoryMediaRecord } from './memoryTypes'

export const MEMORY_MEDIA_UPLOAD_TYPE = 'memory-media'
export const MEMORY_MEDIA_MAX_LONG_EDGE = 1024
export const MEMORY_MEDIA_MAX_SOURCE_BYTES = 10 * 1024 * 1024
export const MEMORY_MEDIA_MAX_PERSISTED_BYTES = 5 * 1024 * 1024
export const MEMORY_STANDING_MEDIA_CAP = 4

const MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
} as const

const MIME_TO_SHARP_FORMAT: Record<SupportedMemoryMediaMime, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

type SupportedMemoryMediaMime = keyof typeof MIME_TO_EXTENSION

export class MemoryMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryMediaError'
  }
}

export type MemoryMediaSource =
  | { kind: 'clip'; clipId: string }
  | { kind: 'upload'; label?: string }
  | { kind: 'migration'; clipId: string }

export interface SaveMemoryMediaBytesInput {
  lifecycle?: SettingsLifecycleSnapshot
  agentId: string
  memoryId: string
  bytes: Uint8Array
  mimeType: string
  filename?: string
  source: MemoryMediaSource
  mediaId?: string
}

export interface LoadedMemoryMedia {
  media: MemoryMediaRecord
  bytes: Uint8Array
  dataUrl: string
  url: string
}

function resolveUploadsDir(): string {
  const explicit = process.env.UPLOADS_DIR?.trim()
  if (explicit) return path.resolve(explicit)
  return path.resolve(process.cwd(), '../batshit-server/server/uploads')
}

function assertPathPart(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new MemoryMediaError(`Memory media ${label} contains unsupported path characters.`)
  }
  return trimmed
}

function uploadKey(filename: string): string {
  return `upload:${MEMORY_MEDIA_UPLOAD_TYPE}:${filename}`
}

function absolutePathForFilename(filename: string): string {
  const uploadRoot = resolveUploadsDir()
  const relativePath = `${MEMORY_MEDIA_UPLOAD_TYPE}/${filename}`
  const resolved = path.resolve(uploadRoot, ...relativePath.split('/'))
  const rootPrefix = uploadRoot.endsWith(path.sep) ? uploadRoot : `${uploadRoot}${path.sep}`
  if (!resolved.startsWith(rootPrefix)) {
    throw new MemoryMediaError('Memory media path escaped the upload directory.')
  }
  return resolved
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s)
  if (!match) throw new MemoryMediaError('The source Clip does not contain a readable image payload.')
  return { mimeType: match[1].toLowerCase(), bytes: new Uint8Array(Buffer.from(match[2], 'base64')) }
}

function sourceClipId(source: MemoryMediaSource): string | undefined {
  return source.kind === 'clip' || source.kind === 'migration' ? source.clipId : undefined
}

function tokenEstimate(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28)
}

function safeDisplayName(value: string | undefined, fallback: string): string {
  const leaf = value?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return (leaf || fallback).slice(0, 200)
}

/** Bytes-first persistence core; Clip copying is only one adapter over this API. */
export async function saveMemoryMediaBytes(input: SaveMemoryMediaBytesInput): Promise<MemoryMediaRecord> {
  const lifecycle = input.lifecycle ?? captureSettingsLifecycle([`agent:${input.agentId}`])
  const lease = acquireSettingsMutation(lifecycle)
  try {
    await readMemoryObservation({ agentId: input.agentId, lifecycle })
    lease.check()
    const record = await saveMemoryMediaBytesOwned(input, lease.check)
    lease.settle()
    return record
  } catch (error) {
    if (memoryMutationUnknown(error)) lease.unknown()
    else lease.settle()
    throw error
  }
}

async function saveMemoryMediaBytesOwned(input: SaveMemoryMediaBytesInput, assertOwner: () => void): Promise<MemoryMediaRecord> {
  const agentId = assertPathPart(input.agentId, 'agent id')
  const memoryId = assertPathPart(input.memoryId, 'memory id')
  const mimeType = input.mimeType.trim().toLowerCase() as SupportedMemoryMediaMime
  const extension = MIME_TO_EXTENSION[mimeType]
  if (!extension) {
    throw new MemoryMediaError('Memory media must be a JPEG, PNG, GIF, or WebP image.')
  }
  if (input.bytes.byteLength === 0) throw new MemoryMediaError('Memory media cannot be empty.')
  if (input.bytes.byteLength > MEMORY_MEDIA_MAX_SOURCE_BYTES) {
    throw new MemoryMediaError('Memory media source images cannot exceed 10 MiB.')
  }

  const mediaId = assertPathPart(input.mediaId ?? `media_${randomUUID()}`, 'id')
  let image = sharp(Buffer.from(input.bytes), { animated: mimeType === 'image/gif' }).rotate()
  const sourceMetadata = await image.metadata()
  if (sourceMetadata.format !== MIME_TO_SHARP_FORMAT[mimeType]) {
    throw new MemoryMediaError(
      `Memory media bytes do not match the declared ${mimeType} image type.`
    )
  }
  const sourceHeight = sourceMetadata.pageHeight ?? sourceMetadata.height
  if (!sourceMetadata.width || !sourceHeight) {
    throw new MemoryMediaError('Memory media dimensions could not be read.')
  }
  const needsResize = Math.max(sourceMetadata.width, sourceHeight) > MEMORY_MEDIA_MAX_LONG_EDGE
  if (needsResize) {
    image = image.resize({
      width: MEMORY_MEDIA_MAX_LONG_EDGE,
      height: MEMORY_MEDIA_MAX_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true
    })
  }
  const result = await image.toBuffer({ resolveWithObject: true })
  if (result.data.byteLength > MEMORY_MEDIA_MAX_PERSISTED_BYTES) {
    throw new MemoryMediaError(
      'The bounded memory image still exceeds 5 MiB; use a simpler or shorter image and retry.'
    )
  }
  const persistedMetadata = await sharp(result.data, { animated: mimeType === 'image/gif' }).metadata()
  const width = persistedMetadata.width ?? result.info.width
  const height = persistedMetadata.pageHeight ?? persistedMetadata.height ?? result.info.height
  if (!width || !height) throw new MemoryMediaError('Memory media dimensions could not be preserved.')

  const filename = `${agentId}/${memoryId}/${mediaId}.${extension}`
  const relativePath = `${MEMORY_MEDIA_UPLOAD_TYPE}/${filename}`
  const filePath = absolutePathForFilename(filename)
  assertOwner()
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  assertOwner()
  await writeFile(temporaryPath, result.data, { mode: 0o600 })
  assertOwner()
  await rename(temporaryPath, filePath)

  const now = new Date().toISOString()
  const record: MemoryMediaRecord = {
    id: mediaId,
    filename,
    display_name: safeDisplayName(input.filename, path.basename(filename)),
    mime_type: mimeType,
    bytes: result.data.byteLength,
    width,
    height,
    token_estimate: tokenEstimate(width, height),
    sha256: createHash('sha256').update(result.data).digest('hex'),
    ...(sourceClipId(input.source) ? { source_clip_id: sourceClipId(input.source) } : {})
  }

  let issued = false
  try {
    await redis.execute(async client => {
      assertOwner(); issued = true
      const answer = await client.json.set(uploadKey(filename), '$', {
      filename,
      uploadType: MEMORY_MEDIA_UPLOAD_TYPE,
      mimetype: mimeType,
      size: record.bytes,
      storage: 'filesystem',
      relativePath,
      filePath,
      uploadedAt: now,
      source: input.source
      } as never)
      if (answer !== 'OK') throw new Error('Memory image publication was not acknowledged.')
    })
  } catch (error) {
    if (issued) throw new MemoryMutationError('Memory image publication outcome is unknown; its files and custody are retained.', true)
    await rm(filePath, { force: true }).catch(() => {})
    throw error
  }
  return record
}

export async function copyClipToMemoryMedia(input: {
  userId: string
  agentId: string
  memoryId: string
  clipId: string
  source?: 'clip' | 'migration'
  lifecycle?: SettingsLifecycleSnapshot
}): Promise<MemoryMediaRecord> {
  const lifecycle = input.lifecycle ?? captureSettingsLifecycle([`agent:${input.agentId}`])
  const clip = await loadClipRow(input.userId, input.clipId)
  if (!clip) throw new MemoryMediaError(`Clip "${input.clipId}" was not found.`)
  const dataUrl = await resolveClipDataUrlFromStoredUpload(clip)
  if (!dataUrl) {
    throw new MemoryMediaError(`Clip "${input.clipId}" has no readable stored image.`)
  }
  const decoded = decodeDataUrl(dataUrl)
  if (!decoded.mimeType.startsWith('image/')) {
    throw new MemoryMediaError(`Clip "${input.clipId}" is not an image.`)
  }
  return saveMemoryMediaBytes({
    agentId: input.agentId,
    memoryId: input.memoryId,
    lifecycle,
    bytes: decoded.bytes,
    mimeType: decoded.mimeType || clip.mimeType || '',
    filename: clip.filename,
    source:
      input.source === 'migration'
        ? { kind: 'migration', clipId: input.clipId }
        : { kind: 'clip', clipId: input.clipId }
  })
}

export async function loadMemoryMedia(
  agentId: string,
  memoryId: string,
  mediaOrId: MemoryMediaRecord | string,
  options: { audience?: 'user'; userId?: string; includeExpired?: boolean } = {}
): Promise<LoadedMemoryMedia> {
  assertPathPart(agentId, 'agent id')
  assertPathPart(memoryId, 'memory id')
  const admission = currentMemoryDeliveryAdmission()
  const lifecycle = admission?.lifecycle ?? captureSettingsLifecycle([`agent:${agentId}`])
  const explicitExpired = options.includeExpired === true || admission?.agentId === agentId && admission.memoryId === memoryId && admission.includeExpired
  const observation = { agentId, userId: options.userId ?? admission?.userId, memoryIds: [memoryId], lifecycle,
    ...(admission ? { sessionId: admission.sessionId, expectedAgent: admission.agentOwner, expectedSession: admission.sessionOwner } : {}), requireEnabled: options.audience !== 'user' }
  const first = await readMemoryObservation(observation)
  const record = first.records.get(memoryId)
  if (!record || options.audience !== 'user' && !memoryIsEligible(record, explicitExpired, first.nowTs)) throw new MemoryMediaError('This memory is deleted or expired and is not eligible for agent delivery.')
  const mediaId = typeof mediaOrId === 'string' ? mediaOrId : mediaOrId.id
  const media = record.media?.find(entry => entry.id === mediaId)
  if (!media) {
    throw new MemoryMediaError(`Memory media "${String(mediaOrId)}" was not found.`)
  }
  if (!media.filename.startsWith(`${agentId}/${memoryId}/`)) {
    throw new MemoryMediaError('Memory media ownership does not match the requested memory.')
  }
  const upload = await redis.get(uploadKey(media.filename), { throwOnError: true })
  if (!upload || typeof upload !== 'object' || (upload as any).storage !== 'filesystem') {
    throw new MemoryMediaError(`Memory media "${media.id}" is missing its upload record.`)
  }
  const filePath = absolutePathForFilename(media.filename)
  const bytes = new Uint8Array(await readFile(filePath))
  if (bytes.byteLength !== media.bytes) {
    throw new MemoryMediaError(`Memory media "${media.id}" size does not match its record.`)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== media.sha256) {
    throw new MemoryMediaError(`Memory media "${media.id}" bytes do not match its saved hash.`)
  }
  const dataUrl = `data:${media.mime_type};base64,${Buffer.from(bytes).toString('base64')}`
  const url = `/uploads/${MEMORY_MEDIA_UPLOAD_TYPE}/${media.filename.split('/').map(part => encodeURIComponent(part)).join('/')}`
  // Last await: original owner/lifecycle plus the exact same currently eligible media.
  const final = await readMemoryObservation({ ...observation, expectedAgent: first.agentOwner })
  const current = final.records.get(memoryId)
  const currentMedia = current?.media?.find(entry => entry.id === mediaId)
  if (!current || !currentMedia || JSON.stringify(currentMedia) !== JSON.stringify(media) || options.audience !== 'user' && !memoryIsEligible(current, explicitExpired, final.nowTs)) throw new MemoryMediaError('This memory image changed, expired or was deleted while its bytes were loading.')
  return { media: currentMedia, bytes, dataUrl, url }

}

export async function deleteMemoryMedia(media: MemoryMediaRecord): Promise<void> {
  await redis.del(uploadKey(media.filename))
  await rm(absolutePathForFilename(media.filename), { force: true })
}

export async function sweepAgentMemoryMedia(agentId: string): Promise<number> {
  const normalized = assertPathPart(agentId, 'agent id')
  const keys = await redis.keys(`upload:${MEMORY_MEDIA_UPLOAD_TYPE}:${normalized}/*`)
  let deleted = 0
  for (const key of keys) {
    const filename = key.slice(`upload:${MEMORY_MEDIA_UPLOAD_TYPE}:`.length)
    await redis.del(key)
    await rm(absolutePathForFilename(filename), { force: true })
    deleted += 1
  }
  await rm(path.join(resolveUploadsDir(), MEMORY_MEDIA_UPLOAD_TYPE, normalized), {
    recursive: true,
    force: true
  })
  return deleted
}

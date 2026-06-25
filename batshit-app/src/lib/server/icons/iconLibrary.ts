import { redis } from '$lib/server/redis'
import type {
  CustomIconDisplaySettings,
  CustomIconRecord,
  CustomIconSourceProvenance,
  IconLibraryPrefs,
  IconRef
} from '$lib/icons/iconTypes'
import { cloneIconRef, iconRefKey, isIconRef } from '$lib/icons/iconTypes'
import { IconLibraryError } from './iconLibraryErrors'
import { applySvgPaintColor, normalizeIconHexColor, sanitizeIconSvg } from './svgSanitizer'

export { IconLibraryError } from './iconLibraryErrors'

const ICON_LIBRARY_SCHEMA_VERSION = 1
const MAX_SVG_BYTES = 128 * 1024
const MAX_PNG_BYTES = 256 * 1024
const MAX_ICON_NAME_LENGTH = 80
const MAX_ICON_TAGS = 20
const MAX_ICON_TAG_LENGTH = 40
const MAX_PREFS_ENTRIES = 40

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_IEND_CHUNK = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
const SVG_MIME = 'image/svg+xml'
const PNG_MIME = 'image/png'
const LIGHT_MONO_ICON_HEX = '#F4F1EA'
const DARK_MONO_ICON_HEX = '#171717'

type StoredIconEncoding = 'utf8' | 'base64'

interface StoredCustomIconRecord extends CustomIconRecord {
  schemaVersion: typeof ICON_LIBRARY_SCHEMA_VERSION
  content: string
  originalContent?: string
  encoding: StoredIconEncoding
}

export interface IconLibrarySnapshot {
  icons: CustomIconRecord[]
  prefs: IconLibraryPrefs
}

function userIconSetKey(userId: string) {
  return `user:${userId}:icons`
}

function iconRecordKey(userId: string, iconId: string) {
  return `icon:${userId}:${iconId}`
}

function prefsKey(userId: string) {
  return `icon_library:${userId}:prefs`
}

function toPublicRecord(record: StoredCustomIconRecord): CustomIconRecord {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    path: record.path,
    mimeType: record.mimeType,
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    tags: record.tags,
    ...(record.display ? { display: record.display } : {}),
    ...(record.source ? { source: record.source } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function sanitizeName(input: unknown, fallback: string) {
  const raw = typeof input === 'string' ? input : fallback
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (!trimmed) return fallback.slice(0, MAX_ICON_NAME_LENGTH)
  return trimmed.slice(0, MAX_ICON_NAME_LENGTH)
}

function sanitizeTags(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : []

  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter(Boolean)
        .map((value) => value.replace(/[^a-z0-9._ -]+/g, '').trim())
        .filter(Boolean)
        .map((value) => value.slice(0, MAX_ICON_TAG_LENGTH))
    )
  ).slice(0, MAX_ICON_TAGS)
}

function detectIconMime(file: File, bytes: Uint8Array): typeof SVG_MIME | typeof PNG_MIME {
  const fileName = file.name.toLowerCase()
  const declaredType = file.type.toLowerCase()

  if (declaredType === PNG_MIME || fileName.endsWith('.png')) {
    if (!isPng(bytes)) {
      throw new IconLibraryError('PNG icon uploads must be valid PNG files')
    }
    return PNG_MIME
  }

  if (declaredType === SVG_MIME || fileName.endsWith('.svg')) {
    return SVG_MIME
  }

  throw new IconLibraryError('Icon uploads only support SVG and PNG files')
}

function isPng(bytes: Uint8Array) {
  if (bytes.length < PNG_SIGNATURE.length + PNG_IEND_CHUNK.length) return false
  return (
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) &&
    PNG_IEND_CHUNK.every((byte, index) => bytes[bytes.length - PNG_IEND_CHUNK.length + index] === byte)
  )
}

function decodeSvg(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new IconLibraryError('SVG icon uploads must be valid UTF-8 text')
  }
}

function assertIconRefList(input: unknown): IconRef[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const refs: IconRef[] = []

  for (const value of input) {
    if (!isIconRef(value)) continue
    const cloned = cloneIconRef(value)
    const key = iconRefKey(cloned)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(cloned)
    if (refs.length >= MAX_PREFS_ENTRIES) break
  }

  return refs
}

function normalizePrefs(input: unknown): IconLibraryPrefs {
  const value = input && typeof input === 'object' ? (input as Partial<IconLibraryPrefs>) : {}
  return {
    favorites: assertIconRefList(value.favorites),
    recents: assertIconRefList(value.recents)
  }
}

function normalizeDisplaySettings(input: unknown): CustomIconDisplaySettings | undefined {
  if (input === undefined) return undefined
  if (input === null) return { colorMode: 'original' }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new IconLibraryError('Icon color settings must be a valid object')
  }

  const raw = input as Record<string, unknown>
  const colorMode = raw.colorMode
  if (
    colorMode !== 'original' &&
    colorMode !== 'brand' &&
    colorMode !== 'light' &&
    colorMode !== 'dark' &&
    colorMode !== 'custom'
  ) {
    throw new IconLibraryError('Icon color mode is not supported')
  }

  if (colorMode === 'custom') {
    const customHex = normalizeIconHexColor(raw.customHex)
    if (!customHex) {
      throw new IconLibraryError('Custom icon color must be a valid hex color')
    }
    return { colorMode, customHex }
  }

  return { colorMode }
}

function resolveDisplayPaint(record: StoredCustomIconRecord): { color: string; force: boolean } | null {
  if (!record.display) return { color: LIGHT_MONO_ICON_HEX, force: false }
  if (record.display.colorMode === 'original') return null
  if (record.display.colorMode === 'brand') {
    const color = normalizeIconHexColor(record.source?.brandHex)
    return color ? { color, force: true } : null
  }
  if (record.display.colorMode === 'light') return { color: LIGHT_MONO_ICON_HEX, force: true }
  if (record.display.colorMode === 'dark') return { color: DARK_MONO_ICON_HEX, force: true }
  const color = normalizeIconHexColor(record.display.customHex)
  return color ? { color, force: true } : null
}

export async function listIconLibrary(userId: string): Promise<IconLibrarySnapshot> {
  return await redis.execute(async (client) => {
    const iconIds = await client.sMembers(userIconSetKey(userId))
    const icons: CustomIconRecord[] = []

    for (const iconId of iconIds) {
      const record = (await client.json.get(iconRecordKey(userId, iconId))) as StoredCustomIconRecord | null
      if (record?.userId === userId) {
        icons.push(toPublicRecord(record))
      }
    }

    icons.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    const storedPrefs = await client.json.get(prefsKey(userId))
    return {
      icons,
      prefs: normalizePrefs(storedPrefs)
    }
  })
}

export async function getStoredCustomIcon(userId: string, iconId: string): Promise<StoredCustomIconRecord | null> {
  return await redis.execute(async (client) => {
    const record = (await client.json.get(iconRecordKey(userId, iconId))) as StoredCustomIconRecord | null
    if (!record || record.userId !== userId) return null
    return record
  })
}

export async function createCustomIcon(
  userId: string,
  file: File,
  options: {
    name?: unknown
    tags?: unknown
    source?: CustomIconSourceProvenance
  } = {}
): Promise<CustomIconRecord> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mimeType = detectIconMime(file, bytes)
  const maxBytes = mimeType === SVG_MIME ? MAX_SVG_BYTES : MAX_PNG_BYTES

  if (bytes.length > maxBytes) {
    throw new IconLibraryError(
      `${mimeType === SVG_MIME ? 'SVG' : 'PNG'} icon uploads must be ${Math.floor(maxBytes / 1024)}KB or smaller`
    )
  }

  let content: string
  let encoding: StoredIconEncoding
  if (mimeType === SVG_MIME) {
    content = sanitizeIconSvg(decodeSvg(bytes))
    encoding = 'utf8'
  } else {
    content = Buffer.from(bytes).toString('base64')
    encoding = 'base64'
  }

  const now = new Date().toISOString()
  const iconId = crypto.randomUUID()
  const fileName = sanitizeName(file.name, `${iconId}.${mimeType === SVG_MIME ? 'svg' : 'png'}`)
  const record: StoredCustomIconRecord = {
    schemaVersion: ICON_LIBRARY_SCHEMA_VERSION,
    id: iconId,
    userId,
    name: sanitizeName(options.name, fileName.replace(/\.(svg|png)$/i, '')),
    path: `/api/icons/custom/${iconId}`,
    mimeType,
    fileName,
    sizeBytes: bytes.length,
    tags: sanitizeTags(options.tags),
    ...(options.source ? { source: options.source } : {}),
    createdAt: now,
    updatedAt: now,
    content,
    originalContent: content,
    encoding
  }

  await redis.execute(async (client) => {
    await client.json.set(iconRecordKey(userId, iconId), '$', record as any)
    await client.sAdd(userIconSetKey(userId), iconId)
  })

  return toPublicRecord(record)
}

export async function updateCustomIcon(
  userId: string,
  iconId: string,
  updates: {
    name?: unknown
    tags?: unknown
    display?: unknown
  }
): Promise<CustomIconRecord> {
  return await redis.execute(async (client) => {
    const key = iconRecordKey(userId, iconId)
    const existing = (await client.json.get(key)) as StoredCustomIconRecord | null
    if (!existing || existing.userId !== userId) {
      throw new IconLibraryError('Custom icon not found', 404)
    }

    const normalizedDisplay =
      updates.display !== undefined ? normalizeDisplaySettings(updates.display) : existing.display
    const next: StoredCustomIconRecord = {
      ...existing,
      name: updates.name !== undefined ? sanitizeName(updates.name, existing.name) : existing.name,
      tags: updates.tags !== undefined ? sanitizeTags(updates.tags) : existing.tags,
      ...(normalizedDisplay ? { display: normalizedDisplay } : {}),
      updatedAt: new Date().toISOString()
    }

    await client.json.set(key, '$', next as any)
    return toPublicRecord(next)
  })
}

export async function deleteCustomIcon(userId: string, iconId: string): Promise<void> {
  await redis.execute(async (client) => {
    const key = iconRecordKey(userId, iconId)
    const existing = (await client.json.get(key)) as StoredCustomIconRecord | null
    if (!existing || existing.userId !== userId) {
      throw new IconLibraryError('Custom icon not found', 404)
    }

    await client.del(key)
    await client.sRem(userIconSetKey(userId), iconId)
  })
}

export async function updateIconLibraryPrefs(userId: string, prefs: unknown): Promise<IconLibraryPrefs> {
  const normalized = normalizePrefs(prefs)
  await redis.execute(async (client) => {
    await client.json.set(prefsKey(userId), '$', normalized as any)
  })
  return normalized
}

export function renderStoredIcon(record: StoredCustomIconRecord) {
  const sourceContent = record.originalContent ?? record.content
  const paint = record.mimeType === SVG_MIME ? resolveDisplayPaint(record) : null
  const body =
    record.encoding === 'base64'
      ? Buffer.from(record.content, 'base64')
      : paint
        ? applySvgPaintColor(sourceContent, paint.color, { force: paint.force })
        : record.content
  return new Response(body, {
    headers: {
      'Content-Type': record.mimeType,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

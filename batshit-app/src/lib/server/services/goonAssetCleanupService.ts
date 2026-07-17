import { redis } from '$lib/server/redis'
import type {
  GoonAnimationLibrary,
  GoonClosetItem,
  GoonFileRef,
  GoonRecord,
  GoonRoomSurfaceSide,
  GoonRoomTextureKind,
  GoonSceneDefinition,
  GoonsSettings
} from '$lib/types/goons'
import {
  getInternalBatshitServerUrl,
  getInternalBatshitServerAuthHeaders
} from './batshitServerUrls'

export const GOON_UPLOAD_TYPES = [
  'goons',
  'goon_guided_packages',
  'goon_guided_manifests',
  'goon_custom_packages',
  'goon_custom_models',
  'goon_custom_manifests',
  'goon_animations',
  'goon_animation_previews',
  'goon_closet',
  'goon_facial_artwork',
  'goon_scenes',
  'goon_scene_thumbs',
  'goon_room_shells',
  'goon_room_textures',
  'goon_scene_props'
] as const

export type GoonUploadType = (typeof GOON_UPLOAD_TYPES)[number]

export type GoonAssetReferenceMap = Map<string, Set<string>>

export type GoonAssetAuditEntry = {
  uploadType: GoonUploadType
  filename: string
  redisKey: string
  size: number
  storage: 'filesystem' | 'redis' | 'unknown'
  referenced: boolean
  references: string[]
}

export type GoonAssetAuditTypeSummary = {
  uploadType: GoonUploadType
  uploadRecordCount: number
  referencedRecordCount: number
  orphanRecordCount: number
  uploadBytes: number
  orphanBytes: number
}

export type GoonAssetAuditSummary = {
  uploadRecordCount: number
  referencedRecordCount: number
  orphanRecordCount: number
  uploadBytes: number
  orphanBytes: number
  byType: GoonAssetAuditTypeSummary[]
  orphans: GoonAssetAuditEntry[]
  entries: GoonAssetAuditEntry[]
}

export type GoonAssetCleanupResult = {
  audit: GoonAssetAuditSummary
  deleted: GoonAssetAuditEntry[]
  failed: Array<GoonAssetAuditEntry & { error: string }>
  deletedCount: number
  deletedBytes: number
}

type RedisClientLike = {
  keys(pattern: string): Promise<string[]>
  sMembers(key: string): Promise<string[]>
  del(keys: string | string[]): Promise<number>
  json: {
    get(key: string, options?: unknown): Promise<unknown>
  }
}

type DeleteGoonUploadAsset = (uploadType: GoonUploadType, filename: string) => Promise<void>

const GOON_UPLOAD_TYPE_SET = new Set<string>(GOON_UPLOAD_TYPES)

function referenceKey(uploadType: string, filename: string) {
  return `${uploadType}/${filename}`
}

function hasUploadType(value: string): value is GoonUploadType {
  return GOON_UPLOAD_TYPE_SET.has(value)
}

function addReference(
  references: GoonAssetReferenceMap,
  uploadType: GoonUploadType,
  filename: string | null | undefined,
  context: string
) {
  const cleanFilename = filename?.trim()
  if (!cleanFilename) return

  const key = referenceKey(uploadType, cleanFilename)
  const contexts = references.get(key) ?? new Set<string>()
  contexts.add(context)
  references.set(key, contexts)
}

function parseUploadUrl(url: unknown): { uploadType: GoonUploadType; filename: string } | null {
  if (typeof url !== 'string' || !url.trim()) return null

  let pathname = url.trim()
  try {
    pathname = new URL(pathname, 'http://batshit.local').pathname
  } catch {
    pathname = pathname.split('?')[0]?.split('#')[0] ?? pathname
  }

  const parts = pathname.split('/').filter(Boolean)
  const uploadsIndex = parts.lastIndexOf('uploads')
  if (uploadsIndex === -1 || parts.length <= uploadsIndex + 2) return null

  const uploadType = decodeURIComponent(parts[uploadsIndex + 1] ?? '')
  const filename = decodeURIComponent(parts[uploadsIndex + 2] ?? '')
  if (!hasUploadType(uploadType) || !filename) return null

  return { uploadType, filename }
}

function addFileRef(
  references: GoonAssetReferenceMap,
  uploadType: GoonUploadType,
  fileRef: Pick<GoonFileRef, 'filename' | 'url'> | null | undefined,
  context: string
) {
  addReference(references, uploadType, fileRef?.filename, context)

  const parsed = parseUploadUrl(fileRef?.url)
  if (parsed) {
    addReference(references, parsed.uploadType, parsed.filename, context)
  }
}

function deriveSceneThumbnailFilename(filename: string | null | undefined) {
  if (!filename) return null
  const dot = filename.lastIndexOf('.')
  const base = dot === -1 ? filename : filename.slice(0, dot)
  return `${base}_thumb.jpg`
}

function addSceneSkyboxRef(
  references: GoonAssetReferenceMap,
  skybox: (GoonFileRef & { thumbnailUrl?: string }) | null | undefined,
  context: string
) {
  addFileRef(references, 'goon_scenes', skybox, context)
  addReference(
    references,
    'goon_scene_thumbs',
    deriveSceneThumbnailFilename(skybox?.filename),
    `${context} thumbnail`
  )

  const parsedThumbnail = parseUploadUrl(skybox?.thumbnailUrl)
  if (parsedThumbnail) {
    addReference(references, parsedThumbnail.uploadType, parsedThumbnail.filename, `${context} thumbnail`)
  }
}

function collectUploadUrlsFromValue(
  references: GoonAssetReferenceMap,
  value: unknown,
  context: string,
  seen = new Set<unknown>()
) {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  const record = value as Record<string, unknown>
  const parsed = parseUploadUrl(record.url)
  if (parsed) {
    addReference(references, parsed.uploadType, parsed.filename, context)
  }
  const parsedThumbnail = parseUploadUrl(record.thumbnailUrl)
  if (parsedThumbnail) {
    addReference(references, parsedThumbnail.uploadType, parsedThumbnail.filename, `${context} thumbnail`)
  }
  const parsedRef = parseUploadUrl(record.ref)
  if (parsedRef) {
    addReference(references, parsedRef.uploadType, parsedRef.filename, context)
  }

  for (const child of Object.values(record)) {
    collectUploadUrlsFromValue(references, child, context, seen)
  }
}

async function recipeRecordKeysForGoon(
  client: Pick<RedisClientLike, 'keys'>,
  userId: string,
  goonId: string
) {
  const patterns = [
    `goon_recipe_revision:${userId}:${goonId}:*`,
    `goon_recipe_document:${userId}:${goonId}:*`,
    `goon_recipe_job:${userId}:${goonId}:*`
  ]
  const found = await Promise.all(patterns.map((pattern) => client.keys(pattern).catch(() => [])))
  return Array.from(new Set(found.flat())).sort((left, right) => left.localeCompare(right))
}

export async function collectGoonRecipeUploadReferencesForClient(
  client: Pick<RedisClientLike, 'keys' | 'json'>,
  userId: string,
  goonId: string
): Promise<GoonAssetReferenceMap> {
  const references: GoonAssetReferenceMap = new Map()
  const keys = await recipeRecordKeysForGoon(client, userId, goonId)
  for (const key of keys) {
    const value = await client.json.get(key).catch(() => null)
    collectUploadUrlsFromValue(references, value, `Recipe record ${key}`)
  }
  return references
}

export async function deleteGoonRecipeRecordsForClient(
  client: Pick<RedisClientLike, 'keys' | 'del'>,
  userId: string,
  goonId: string
) {
  const keys = await recipeRecordKeysForGoon(client, userId, goonId)
  return keys.length > 0 ? client.del(keys) : 0
}

function collectXWearTextureRefs(
  references: GoonAssetReferenceMap,
  xwear: GoonClosetItem['xwear'] | undefined,
  context: string
) {
  const addTextures = (textures: unknown) => {
    if (!textures || typeof textures !== 'object') return
    for (const [slot, ref] of Object.entries(textures as Record<string, GoonFileRef | null | undefined>)) {
      addFileRef(references, 'goon_closet', ref, `${context} ${slot}`)
    }
  }

  addTextures(xwear?.textures)
  for (const material of Array.isArray(xwear?.materials) ? xwear?.materials ?? [] : []) {
    addTextures(material?.textures)
  }
}

function collectClosetItemRefs(
  references: GoonAssetReferenceMap,
  item: GoonClosetItem | null | undefined,
  context: string
) {
  if (!item) return
  addFileRef(references, 'goon_closet', item.texture, `${context} texture`)
  addFileRef(references, 'goon_closet', item.mask, `${context} mask`)
  collectXWearTextureRefs(references, item.xwear, context)
}

function collectRoomSurfaceSideRefs(
  references: GoonAssetReferenceMap,
  side: GoonRoomSurfaceSide | null | undefined,
  context: string
) {
  if (!side) return
  addFileRef(references, 'goon_room_textures', side.texture, `${context} texture`)
  addFileRef(references, 'goon_room_textures', side.trimTexture, `${context} trim`)
}

function collectSceneRefs(
  references: GoonAssetReferenceMap,
  scene: GoonSceneDefinition | null | undefined,
  context: string
) {
  if (!scene) return
  addSceneSkyboxRef(references, scene.skybox, `${context} skybox`)
  addFileRef(references, 'goon_room_shells', scene.roomShell, `${context} room shell`)

  for (const prop of scene.props ?? []) {
    addFileRef(references, 'goon_scene_props', prop.fileRef, `${context} prop ${prop.id}`)
  }

  const surfaces = scene.roomShellBuilder?.surfaces
  collectRoomSurfaceSideRefs(references, surfaces?.floor?.interior, `${context} floor interior`)
  collectRoomSurfaceSideRefs(references, surfaces?.floor?.exterior, `${context} floor exterior`)
  collectRoomSurfaceSideRefs(references, surfaces?.ceiling?.interior, `${context} ceiling interior`)
  collectRoomSurfaceSideRefs(references, surfaces?.ceiling?.exterior, `${context} ceiling exterior`)

  for (const [wallKey, wall] of Object.entries(surfaces?.walls ?? {})) {
    collectRoomSurfaceSideRefs(references, wall?.interior, `${context} wall ${wallKey} interior`)
    collectRoomSurfaceSideRefs(references, wall?.exterior, `${context} wall ${wallKey} exterior`)
  }

  for (const [apronKey, apron] of Object.entries(scene.roomShellBuilder?.exteriorAprons ?? {})) {
    collectRoomSurfaceSideRefs(references, apron?.surface, `${context} apron ${apronKey}`)
  }

  collectRoomSurfaceSideRefs(
    references,
    scene.roomShellBuilder?.terrainSkirt?.surface,
    `${context} terrain skirt`
  )
}

function collectGoonRefs(references: GoonAssetReferenceMap, goon: GoonRecord) {
  const context = `Goon ${goon.name || goon.id}`
  addFileRef(references, 'goons', goon.files?.vrm, `${context} current VRM`)
  addFileRef(references, 'goons', goon.files?.vrmBackup, `${context} previous VRM`)
  addFileRef(references, 'goons', goon.files?.vrmPending, `${context} pending VRM`)

  for (const animation of goon.files?.animations ?? []) {
    addFileRef(references, 'goon_animations', animation, `${context} animation`)
  }

  addFileRef(references, 'goon_custom_packages', goon.customAvatar?.package, `${context} custom package`)
  addFileRef(references, 'goon_custom_models', goon.customAvatar?.model, `${context} custom model`)
  addFileRef(references, 'goon_custom_manifests', goon.customAvatar?.manifest, `${context} custom manifest`)
  addFileRef(references, 'goon_custom_packages', goon.customAvatar?.backup?.package, `${context} previous custom package`)
  addFileRef(references, 'goon_custom_models', goon.customAvatar?.backup?.model, `${context} previous custom model`)
  addFileRef(references, 'goon_custom_manifests', goon.customAvatar?.backup?.manifest, `${context} previous custom manifest`)
  addFileRef(references, 'goon_custom_packages', goon.customAvatar?.pending?.package, `${context} pending custom package`)
  addFileRef(references, 'goon_custom_models', goon.customAvatar?.pending?.model, `${context} pending custom model`)
  addFileRef(references, 'goon_custom_manifests', goon.customAvatar?.pending?.manifest, `${context} pending custom manifest`)

  addFileRef(references, 'goon_guided_packages', goon.guidedAvatar?.package, `${context} guided package`)
  addFileRef(references, 'goon_guided_manifests', goon.guidedAvatar?.manifest, `${context} guided manifest`)
  addFileRef(references, 'goon_guided_packages', goon.guidedAvatar?.backup?.package, `${context} previous guided package`)
  addFileRef(references, 'goons', goon.guidedAvatar?.backup?.vrm, `${context} previous guided VRM`)
  addFileRef(references, 'goon_guided_manifests', goon.guidedAvatar?.backup?.manifest, `${context} previous guided manifest`)
  addFileRef(references, 'goon_guided_packages', goon.guidedAvatar?.pending?.package, `${context} pending guided package`)
  addFileRef(references, 'goons', goon.guidedAvatar?.pending?.vrm, `${context} pending guided VRM`)
  addFileRef(references, 'goon_guided_manifests', goon.guidedAvatar?.pending?.manifest, `${context} pending guided manifest`)

  for (const overlay of goon.guidedAvatar?.dufOverlays ?? []) {
    addFileRef(references, 'goons', overlay.file, `${context} DUF overlay ${overlay.id}`)
  }

  for (const [itemId, item] of Object.entries(goon.closet?.items ?? {})) {
    collectClosetItemRefs(references, item, `${context} closet item ${itemId}`)
  }

  collectUploadUrlsFromValue(references, goon, context)
}

function collectSettingsRefs(references: GoonAssetReferenceMap, settings: GoonsSettings | null | undefined) {
  if (!settings) return

  for (const [itemId, item] of Object.entries(settings.globalCloset?.items ?? {})) {
    collectClosetItemRefs(references, item, `Global Closet item ${itemId}`)
  }

  for (const [kind, list] of Object.entries(settings.kitchen?.roomTextures ?? {}) as Array<
    [GoonRoomTextureKind, GoonFileRef[]]
  >) {
    for (const texture of list ?? []) {
      addFileRef(references, 'goon_room_textures', texture, `Room Texture ${kind}`)
    }
  }

  for (const [sceneId, scene] of Object.entries(settings.kitchen?.scenes ?? {})) {
    collectSceneRefs(references, scene, `Scene ${scene.name || sceneId}`)
  }

  for (const [variantId, variant] of Object.entries(settings.kitchen?.bodyVariants?.items ?? {})) {
    collectUploadUrlsFromValue(references, variant, `Body Variant ${variantId}`)
  }

  collectUploadUrlsFromValue(references, settings, 'Goon Settings')
}

function collectAnimationLibraryRefs(
  references: GoonAssetReferenceMap,
  library: GoonAnimationLibrary | null | undefined
) {
  for (const animation of Array.isArray(library?.vrma) ? library?.vrma ?? [] : []) {
    addFileRef(references, 'goon_animations', animation, `Motion Vault ${animation.displayName || animation.originalName || animation.filename}`)
    addFileRef(references, 'goon_animation_previews', animation.previewVideo, `Motion Vault preview ${animation.filename}`)
  }
  collectUploadUrlsFromValue(references, library, 'Motion Vault')
}

export async function collectGoonUploadReferencesForClient(
  client: RedisClientLike,
  userId: string
): Promise<GoonAssetReferenceMap> {
  const references: GoonAssetReferenceMap = new Map()

  const goonIds = await client.sMembers(`user:${userId}:goons`).catch(() => [])
  for (const goonId of goonIds) {
    const goon = (await client.json.get(`goon:${goonId}`).catch(() => null)) as GoonRecord | null
    if (!goon || goon.user_id !== userId) continue
    collectGoonRefs(references, goon)
    const recipeReferences = await collectGoonRecipeUploadReferencesForClient(client, userId, goonId)
    for (const [key, contexts] of recipeReferences) {
      const merged = references.get(key) ?? new Set<string>()
      for (const context of contexts) merged.add(context)
      references.set(key, merged)
    }
  }

  const settings = (await client.json.get(`user:${userId}:settings`).catch(() => null)) as
    | { goons_settings?: GoonsSettings }
    | null
  collectSettingsRefs(references, settings?.goons_settings)

  const library = (await client.json.get(`user:${userId}:goons_animation_library`).catch(() => null)) as
    | GoonAnimationLibrary
    | null
  collectAnimationLibraryRefs(references, library)

  return references
}

export function hasGoonUploadReference(
  references: GoonAssetReferenceMap,
  uploadType: GoonUploadType,
  filename: string | null | undefined
) {
  return Boolean(filename && references.has(referenceKey(uploadType, filename)))
}

export async function deleteUnreferencedGoonUploadReferences(
  candidates: GoonAssetReferenceMap,
  remainingReferences: GoonAssetReferenceMap,
  deleteAsset: DeleteGoonUploadAsset = deleteGoonUploadAsset
) {
  const deleted: string[] = []
  for (const key of Array.from(candidates.keys()).sort((left, right) => left.localeCompare(right))) {
    if (remainingReferences.has(key)) continue
    const separator = key.indexOf('/')
    const uploadType = key.slice(0, separator)
    const filename = key.slice(separator + 1)
    if (separator <= 0 || !hasUploadType(uploadType) || !filename) {
      throw new Error(`Invalid Goon upload reference key: ${key}`)
    }
    await deleteAsset(uploadType, filename)
    deleted.push(key)
  }
  return deleted
}

function resolvePayloadSize(value: unknown) {
  const size = (value as { size?: unknown } | null)?.size
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0
}

function resolveStorage(value: unknown): GoonAssetAuditEntry['storage'] {
  if ((value as { storage?: unknown } | null)?.storage === 'filesystem') return 'filesystem'
  if (typeof (value as { base64?: unknown } | null)?.base64 === 'string') return 'redis'
  return 'unknown'
}

export async function auditGoonUploadAssetsForClient(
  client: RedisClientLike,
  userId: string
): Promise<GoonAssetAuditSummary> {
  const references = await collectGoonUploadReferencesForClient(client, userId)
  const entries: GoonAssetAuditEntry[] = []

  for (const uploadType of GOON_UPLOAD_TYPES) {
    const keys = await client.keys(`upload:${uploadType}:*`)
    for (const redisKey of keys) {
      const filename = redisKey.slice(`upload:${uploadType}:`.length)
      const payload = await client.json.get(redisKey).catch(() => null)
      const referenceContexts = references.get(referenceKey(uploadType, filename))
      entries.push({
        uploadType,
        filename,
        redisKey,
        size: resolvePayloadSize(payload),
        storage: resolveStorage(payload),
        referenced: Boolean(referenceContexts),
        references: Array.from(referenceContexts ?? []).sort()
      })
    }
  }

  entries.sort((a, b) => a.uploadType.localeCompare(b.uploadType) || a.filename.localeCompare(b.filename))
  const orphans = entries.filter((entry) => !entry.referenced)
  const byType = GOON_UPLOAD_TYPES.map((uploadType) => {
    const typeEntries = entries.filter((entry) => entry.uploadType === uploadType)
    const typeOrphans = typeEntries.filter((entry) => !entry.referenced)
    return {
      uploadType,
      uploadRecordCount: typeEntries.length,
      referencedRecordCount: typeEntries.length - typeOrphans.length,
      orphanRecordCount: typeOrphans.length,
      uploadBytes: typeEntries.reduce((total, entry) => total + entry.size, 0),
      orphanBytes: typeOrphans.reduce((total, entry) => total + entry.size, 0)
    }
  })

  return {
    uploadRecordCount: entries.length,
    referencedRecordCount: entries.length - orphans.length,
    orphanRecordCount: orphans.length,
    uploadBytes: entries.reduce((total, entry) => total + entry.size, 0),
    orphanBytes: orphans.reduce((total, entry) => total + entry.size, 0),
    byType,
    orphans,
    entries
  }
}

export async function auditGoonUploadAssets(userId: string) {
  return redis.execute((client) => auditGoonUploadAssetsForClient(client as RedisClientLike, userId))
}

export async function deleteGoonUploadAsset(uploadType: GoonUploadType, filename: string) {
  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/asset`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
    body: JSON.stringify({ uploadType, filename })
  })

  if (response.ok) return

  const text = await response.text().catch(() => '')
  let details = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  try {
    const payload = JSON.parse(text) as { error?: string; details?: string }
    details = [payload.error, payload.details].filter(Boolean).join(': ') || details
  } catch {
    // Keep the cleaned plain-text fallback.
  }

  throw new Error(
    `Failed to delete uploaded Goon asset ${uploadType}/${filename}${details ? `: ${details}` : ''}`
  )
}

export async function cleanupOrphanGoonUploadAssets(
  userId: string,
  options: { deleteAsset?: DeleteGoonUploadAsset } = {}
): Promise<GoonAssetCleanupResult> {
  const audit = await auditGoonUploadAssets(userId)
  const deleteAsset = options.deleteAsset ?? deleteGoonUploadAsset
  const deleted: GoonAssetAuditEntry[] = []
  const failed: Array<GoonAssetAuditEntry & { error: string }> = []

  for (const orphan of audit.orphans) {
    try {
      await deleteAsset(orphan.uploadType, orphan.filename)
      deleted.push(orphan)
    } catch (error) {
      failed.push({
        ...orphan,
        error: error instanceof Error ? error.message : 'Failed to delete orphaned Goon asset'
      })
    }
  }

  return {
    audit,
    deleted,
    failed,
    deletedCount: deleted.length,
    deletedBytes: deleted.reduce((total, entry) => total + entry.size, 0)
  }
}

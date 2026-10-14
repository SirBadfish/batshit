import { redis } from '$lib/server/redis'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
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
import { CUSTOM_GOON_UPLOAD_TYPES, collectCustomGoonUploadKeys, customGoonDeletionKey, type CustomGoonUploadType } from './goonCustomAssetOwnership.server'
import { captureRecipeVerificationEpoch, publishInRecipeVerificationEpoch } from './recipeVerificationEpoch.server'
import { hairImportCandidateIds } from './hairImportCandidateIdentity'
import { sameHairCleanupFile, isHairCleanupFile, type HairCleanupContext } from './hairCleanupContext'
import { parseHairAsset, parseHairRefitSource } from '$lib/goons/hairAssets'
import { hairCleanupContextForTransport } from './hairCleanupTransport.server'
import { clipHairUploadReferences, readClipReferenceRecord } from './clipHairReferences'

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
  'goon_nail_artwork',
  'goon_skin_artwork',
  'goon_hair_assets',
  'goon_hair_imports',
  'goon_clothing_assets',
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
  cleanupEligible: boolean
  reason: string
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
  cleanupCandidateCount: number
  cleanupCandidateBytes: number
  preservedOrphanRecordCount: number
  cleanupCandidates: GoonAssetAuditEntry[]
  byType: GoonAssetAuditTypeSummary[]
  orphans: GoonAssetAuditEntry[]
  entries: GoonAssetAuditEntry[]
}

export type GoonAssetCleanupResult = {
  audit: GoonAssetAuditSummary
  deleted: GoonAssetAuditEntry[]
  failed: Array<GoonAssetAuditEntry & { error: string }>
  retained: GoonAssetAuditEntry[]
  retainedCount: number
  missing: GoonAssetAuditEntry[]
  missingCount: number
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

type DeleteGoonUploadAsset = (uploadType: GoonUploadType, filename: string) => Promise<void | boolean>

const GOON_UPLOAD_TYPE_SET = new Set<string>(GOON_UPLOAD_TYPES)
// These files can lose their only saved owner when Scene settings are erased.
// Upload age is not reference-loss evidence; without a saved reference history,
// Admin must retain them rather than guess that their removal was intentional.
const SCENE_UPLOAD_TYPES = new Set<GoonUploadType>([
  'goon_scenes', 'goon_scene_thumbs', 'goon_room_shells', 'goon_room_textures', 'goon_scene_props'
])
const NO_REFERENCE_REASON = 'No current saved reference was found in Goons, retained Recipe revisions and jobs, Motion Vault, Closet, Scenes, Hair or Clothing libraries.'
const UNKNOWN_SCENE_REASON = `${NO_REFERENCE_REASON} A failed or partial settings write may have removed a Scene reference. Batshit cannot determine when or why, or safely reconstruct the Scene from this file. This file is preserved.`

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

  try {
    const uploadType = decodeURIComponent(parts[uploadsIndex + 1] ?? '')
    const filename = decodeURIComponent(parts[uploadsIndex + 2] ?? '')
    if (!hasUploadType(uploadType) || !filename || filename.includes('/') || filename.includes('\\')) return null
    return { uploadType, filename }
  } catch {
    return null
  }
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
  const found = await Promise.all(patterns.map((pattern) => client.keys(pattern)))
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
    const value = await client.json.get(key)
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
  userId: string,
  includeHairBorrowers = false
): Promise<GoonAssetReferenceMap> {
  const references: GoonAssetReferenceMap = new Map()

  const goonIds = await client.sMembers(`user:${userId}:goons`)
  for (const goonId of goonIds) {
    const goon = (await client.json.get(`goon:${goonId}`)) as GoonRecord | null
    if (!goon || goon.user_id !== userId) continue
    collectGoonRefs(references, goon)
    const recipeReferences = await collectGoonRecipeUploadReferencesForClient(client, userId, goonId)
    for (const [key, contexts] of recipeReferences) {
      const merged = references.get(key) ?? new Set<string>()
      for (const context of contexts) merged.add(context)
      references.set(key, merged)
    }
  }

  const hairAssetKeys = await client.keys(`hair_asset:${userId}:*`)
  for (const key of hairAssetKeys.sort((left, right) => left.localeCompare(right))) {
    const asset = await client.json.get(key)
    if (!asset) {
      throw new Error(`Hair Asset metadata key ${key} disappeared during reference audit.`)
    }
    collectUploadUrlsFromValue(references, asset, `Hair Asset revision ${key}`)
  }

  const hairRefitSourceKeys = await client.keys(`hair_refit_source:${userId}:*`)
  for (const key of hairRefitSourceKeys.sort((left, right) => left.localeCompare(right))) {
    const source = await client.json.get(key)
    if (!source) {
      throw new Error(`Hair refit source metadata key ${key} disappeared during reference audit.`)
    }
    collectUploadUrlsFromValue(references, source, `Hair refit source ${key}`)
  }

  const clothingAssetKeys = await client.keys(`clothing_asset:${userId}:*`)
  for (const key of clothingAssetKeys.sort((left, right) => left.localeCompare(right))) {
    const asset = await client.json.get(key)
    if (!asset) {
      throw new Error(`Clothing Asset metadata key ${key} disappeared during reference audit.`)
    }
    collectUploadUrlsFromValue(references, asset, `Clothing Asset revision ${key}`)
  }

  const settings = (await client.json.get(`user:${userId}:settings`)) as
    | { goons_settings?: GoonsSettings }
    | null
  collectSettingsRefs(references, settings?.goons_settings)

  const library = (await client.json.get(`user:${userId}:goons_animation_library`)) as
    | GoonAnimationLibrary
    | null
  collectAnimationLibraryRefs(references, library)

  if (includeHairBorrowers) {
    for (const key of (await client.keys(`hair_import_job:${escapeRedisGlob(userId)}:*`)).sort()) {
      const job = await client.json.get(key)
      if (!job) throw new Error(`Hair import reference ${key} disappeared. Retry the audit.`)
      collectUploadUrlsFromValue(references, job, key)
      for (const uploadKey of collectCustomGoonUploadKeys(job)) {
        const typeEnd = uploadKey.indexOf(':', 7)
        addReference(references, uploadKey.slice(7, typeEnd) as CustomGoonUploadType, uploadKey.slice(typeEnd + 1), key)
      }
    }
    const clipKeys = new Set<string>([
      ...await client.keys(`clip:${escapeRedisGlob(userId)}:*`), ...await client.keys('clip:system:*')
    ])
    for (const key of [...clipKeys].sort()) {
      for (const ref of clipHairUploadReferences(await readClipReferenceRecord(client, key))) {
        addReference(references, ref.uploadType, ref.filename, key)
      }
    }
  }

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
    if (await deleteAsset(uploadType, filename) !== false) deleted.push(key)
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
  const hairKeys = await client.keys('upload:goon_hair_assets:*')
  const claimKeys = await client.keys('goon_asset_delete:*')
  const references = await collectGoonUploadReferencesForClient(client, userId, hairKeys.length > 0 ||
    claimKeys.some((key) => /^goon_asset_delete:goon_hair_(?:assets|imports):/.test(key)))
  const entries: GoonAssetAuditEntry[] = []

  for (const uploadType of GOON_UPLOAD_TYPES.filter((type) => type !== 'goon_hair_imports')) {
    const keys = uploadType === 'goon_hair_assets' ? hairKeys : await client.keys(`upload:${uploadType}:*`)
    for (const redisKey of keys) {
      const filename = redisKey.slice(`upload:${uploadType}:`.length)
      const payload = await client.json.get(redisKey)
      const referenceContexts = references.get(referenceKey(uploadType, filename))
      const referenced = Boolean(referenceContexts)
      entries.push({
        uploadType,
        filename,
        redisKey,
        size: resolvePayloadSize(payload),
        storage: resolveStorage(payload),
        referenced,
        references: Array.from(referenceContexts ?? []).sort(),
        cleanupEligible: !referenced && !SCENE_UPLOAD_TYPES.has(uploadType),
        reason: referenced ? 'Current saved references retain this file.'
          : SCENE_UPLOAD_TYPES.has(uploadType) ? UNKNOWN_SCENE_REASON : NO_REFERENCE_REASON
      })
    }
  }

  entries.sort((a, b) => a.uploadType.localeCompare(b.uploadType) || a.filename.localeCompare(b.filename))
  const orphans = entries.filter((entry) => !entry.referenced)
  const cleanupCandidates = orphans.filter((entry) => entry.cleanupEligible)
  // A claim can outlive metadata OR the app's release of a referenced asset.
  // Expose every interrupted operation; its existing fenced owner decides
  // whether to keep the file/release a reservation or finish deletion.
  for (const key of claimKeys) {
    const match = /^goon_asset_delete:(goon_custom_packages|goon_custom_models|goon_custom_manifests|goon_hair_assets|goon_hair_imports):([^/\\]+)$/.exec(key)
    if (!match) throw new Error(`Invalid Goon cleanup claim key: ${key}`)
    const uploadType = match[1] as GoonUploadType
    const filename = match[2]
    const existing = entries.find((entry) => entry.uploadType === uploadType && entry.filename === filename)
    const reason = 'An interrupted custom Goon cleanup remains unfinished. Explicit cleanup resumes its existing fenced operation. Existing ownership checks decide whether to keep the file or finish deletion.'
    const candidate = cleanupCandidates.find((entry) => entry.uploadType === uploadType && entry.filename === filename)
    if (candidate) {
      candidate.reason = reason
      continue
    }
    cleanupCandidates.push(existing ? { ...existing, cleanupEligible: true, reason } : {
      uploadType, filename, redisKey: `upload:${uploadType}:${filename}`, size: 0,
      storage: 'unknown', referenced: false, references: [], cleanupEligible: true,
      reason
    })
  }
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
    cleanupCandidateCount: cleanupCandidates.length,
    cleanupCandidateBytes: cleanupCandidates.reduce((total, entry) => total + entry.size, 0),
    preservedOrphanRecordCount: orphans.filter((entry) => !entry.cleanupEligible).length,
    cleanupCandidates,
    byType,
    orphans,
    entries
  }
}

export async function auditGoonUploadAssets(userId: string) {
  return redis.execute((client) => auditGoonUploadAssetsForClient(client as RedisClientLike, userId))
}

async function deleteUploadThroughFileService(uploadType: GoonUploadType, filename: string, deletionToken?: string, cleanupContext?: HairCleanupContext, expectedFile?: { ref: string; sha256: string; bytes: number; mimeType: string }) {
  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/asset`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
    body: JSON.stringify({ uploadType, filename, ...(deletionToken ? { deletionToken } : {}),
      ...(cleanupContext ? { cleanupContext: hairCleanupContextForTransport(cleanupContext) } : {}), ...(expectedFile ? { expectedFile } : {}) })
  })

  if (response.ok) {
    const result = await response.json()
    if (typeof result.existed !== 'boolean' || typeof result.deletedFile !== 'boolean') throw new Error('File deletion outcome is unknown. Retry the exact cleanup.')
    return result.existed || result.deletedFile ? 'deleted' as const : 'missing' as const
  }

  const text = await response.text().catch(() => '')
  let details = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  try {
    const payload = JSON.parse(text) as { error?: string; details?: string }
    details = [payload.error, payload.details].filter(Boolean).join(': ') || details
  } catch {
    // Keep the cleaned plain-text fallback.
  }

  const error = new Error(`Failed to delete uploaded Goon asset ${uploadType}/${filename}${details ? `: ${details}` : ''}`)
  try { if (JSON.parse(text)?.deletionNotStarted === true) Object.assign(error, { deletionNotStarted: true }) } catch { /* Uncertain response keeps its token. */ }
  throw error
}

/** Reference creation is fenced by the reservation in the same Redis EVAL as
 * its publication. Scan records as well as indexes: a partial old write must
 * never make an otherwise retained asset look orphaned. */
export async function collectAllGoonUploadReferencesForClient(
  client: Pick<RedisClientLike, 'keys' | 'json' | 'sMembers'> & { sendCommand?: (command: string[]) => Promise<unknown> },
  options: { cleanupContext?: HairCleanupContext; excludedRecordKeys?: readonly string[];
    candidateFiles?: readonly { uploadType: string; filename: string }[] } = {}
) {
  const references: GoonAssetReferenceMap = new Map()
  const patterns = [
    'goon:*', 'goon_recipe_document:*', 'goon_recipe_revision:*', 'goon_recipe_job:*',
    'user:*:settings', 'user:*:goons_animation_library', 'hair_asset:*',
    'hair_refit_source:*', 'clothing_asset:*', 'hair_import_job:*'
  ]
  const excluded = new Set(options.excludedRecordKeys ?? [])
  const checkingHair = options.candidateFiles?.some((file) => ['goon_hair_assets', 'goon_hair_imports'].includes(file.uploadType)) ?? false
  if (checkingHair) patterns.push('clip:*')
  const unknownHairOwner = (key: string): never => {
    throw Object.assign(new Error(`Hair ownership record ${key} could not be verified. Repair it before cleanup.`), { details: { recordKey: key } })
  }
  const context = options.cleanupContext
  const excludedFiles = new Set(context?.files.map((file) => file.ref) ?? [])
  let observedContext = !context
  const jobs: Array<{ key: string; value: any }> = []
  const retainedHairIdentities = new Set<string>()
  const ownerRows = new Map<string, unknown>()
  const revisionIdentity = (key: string) => /^hair_(?:asset|refit_source):(.+):([^:]+):([^:]+)$/.exec(key)
  for (const key of checkingHair ? await client.keys('user:*:hair_assets') : []) {
    const userId = key.slice(5, -':hair_assets'.length)
    let members: string[]
    try { members = await client.sMembers(key) } catch { unknownHairOwner(key) }
    for (const member of members!) {
      const pair = /^([^@]+)@([^@]+)$/.exec(member)
      if (!pair) unknownHairOwner(key)
      if (!excluded.has(`hair_asset:${userId}:${pair![1]}:${pair![2]}`)) {
        retainedHairIdentities.add(`${pair![1]}\0${pair![2]}`)
        if (checkingHair) {
          const revisionKey = `hair_asset:${userId}:${pair![1]}:${pair![2]}`
          try {
            const value = await client.json.get(revisionKey)
            ownerRows.set(revisionKey, value)
            const asset = parseHairAsset(value)
            if (asset.assetId !== pair![1] || asset.revisionId !== pair![2] || asset.sourceClass !== 'user') unknownHairOwner(revisionKey)
          } catch { unknownHairOwner(revisionKey) }
        }
      }
    }
  }
  for (const pattern of patterns) {
    for (const key of (await client.keys(pattern)).sort()) {
      if (excluded.has(key)) continue
      const identity = revisionIdentity(key)
      if (identity) retainedHairIdentities.add(`${identity[2]}\0${identity[3]}`)
      let value: unknown
      try {
        if (pattern === 'clip:*') value = await readClipReferenceRecord(client, key)
        else value = ownerRows.has(key) ? ownerRows.get(key) : await client.json.get(key)
      } catch (error) {
        if (checkingHair && /^(?:hair_asset|hair_refit_source):/.test(key)) unknownHairOwner(key)
        throw error
      }
      if (value === null || value === undefined) {
        throw new Error(`Goon reference record ${key} disappeared during deletion audit. Retry cleanup.`)
      }
      if (checkingHair && /^(?:hair_asset|hair_refit_source):/.test(key)) {
        try {
          const owner = key.startsWith('hair_asset:') ? parseHairAsset(value) : parseHairRefitSource(value)
          const prefix = key.startsWith('hair_asset:') ? 'hair_asset:' : 'hair_refit_source:'
          const suffix = `:${owner.assetId}:${owner.revisionId}`
          if (!key.endsWith(suffix) || key.length <= prefix.length + suffix.length) unknownHairOwner(key)
          retainedHairIdentities.add(`${owner.assetId}\0${owner.revisionId}`)
        } catch { unknownHairOwner(key) }
      }
      if (pattern === 'hair_import_job:*') {
        const job = value as any
        if (key === context?.jobKey) {
          const raw = context.expectedRaw && client.sendCommand ? await client.sendCommand(['JSON.GET', key]) : JSON.stringify(job)
          if (context.expectedRaw ? raw !== context.expectedRaw : job.stateVersion !== context.stateVersion) {
            throw new Error('Hair import changed. Retry cleanup from its current state.')
          }
          if (!Array.isArray(job.cleanupFiles) || context.files.some((file) => !job.cleanupFiles.some((owned: any) => sameHairCleanupFile(file, owned)))) {
            throw new Error('Hair cleanup subset no longer matches its observed owner.')
          }
          observedContext = true
          // Borrowed refit bytes stay live even when the caller owns a cleanup
          // receipt for that same path. Exclude only exact disposal tuples.
          if (job.target?.kind === 'refit') collectUploadUrlsFromValue(references, job.target.refitSource, key)
          const removeSubset = (node: unknown): unknown => {
            if (isHairCleanupFile(node) && excludedFiles.has(node.ref)) return null
            if (typeof node === 'string') return excludedFiles.has(node) ? null : node
            if (Array.isArray(node)) return node.map(removeSubset)
            if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([field, child]) => [field, removeSubset(child)]))
            return node
          }
          if (context.mode === 'retired') {
            if (job.status !== 'cancelled') throw new Error('Hair cleanup owner was not retired.')
            value = removeSubset(job)
          } else {
            // Failure/obsolete-candidate cleanup must preserve ALL live fields,
            // including an old candidate reusing the deterministic texture.
            value = { ...job, cleanupFiles: removeSubset(job.cleanupFiles),
              ...(context.mode === 'source-consumed' ? { source: removeSubset(job.source) } : {}) }
          }
        } else jobs.push({ key, value: job })
      }
      if (pattern === 'clip:*') {
        for (const ref of clipHairUploadReferences(value)) addReference(references, ref.uploadType, ref.filename, key)
        continue
      }
      if (pattern === 'goon:*') collectGoonRefs(references, value as GoonRecord)
      else collectUploadUrlsFromValue(references, value, key)
      // Match the atomic acquisition guard, including old nested settings data
      // and filename-only customAvatar refs. Noncustom refs keep their existing
      // field-specific collector above.
      for (const uploadKey of collectCustomGoonUploadKeys(value)) {
        const typeEnd = uploadKey.indexOf(':', 7)
        addReference(references, uploadKey.slice(7, typeEnd) as CustomGoonUploadType,
          uploadKey.slice(typeEnd + 1), key)
      }
    }
  }
  if (!observedContext) throw new Error('Hair cleanup owner disappeared. Retry from its current state.')
  // A different admitted job may not yet have recorded its upload response.
  // The canonical artifact identity protects it without trusting an overwritten
  // origin receipt as an exclusive owner.
  if (options.candidateFiles?.some((file) => file.uploadType === 'goon_hair_assets') && (jobs.length || retainedHairIdentities.size)) {
    const uploads = new Set((options.candidateFiles ?? []).filter((file) => file.uploadType === 'goon_hair_assets')
      .map((file) => `upload:goon_hair_assets:${file.filename}`))
    for (const uploadKey of uploads) {
      const filename = uploadKey.slice('upload:goon_hair_assets:'.length)
      for (const identity of retainedHairIdentities) {
        const [assetId, revisionId] = identity.split('\0')
        if (filename.startsWith(`${assetId}_${revisionId}_`) && /_[a-f0-9]{64}\.(glb|json|png)$/.test(filename)) {
          addReference(references, 'goon_hair_assets', filename, 'Retained Hair revision or library index')
        }
      }
      for (const { key, value: job } of jobs) {
        if (job?.contract !== 'hair-import-job/v4' || job.status === 'cancelled' || job.status === 'complete' ||
            !Number.isSafeInteger(job.stateVersion) || job.stateVersion < 1 || !job.target ||
            !['new', 'refit'].includes(job.target.kind) || key !== `hair_import_job:${job.userId}:${job.jobId}`) continue
        const ids = hairImportCandidateIds(job)
        if (filename.startsWith(`${ids.assetId}_${ids.revisionId}_`) && /_[a-f0-9]{64}\.(glb|json|png)$/.test(filename)) {
          addReference(references, 'goon_hair_assets', filename, key)
        }
      }
    }
  }
  return references
}

const RELEASE_RESERVED_ASSET_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local marker = cjson.decode(raw)
if marker['contract'] ~= 'goon-asset-deletion/v1' or marker['token'] ~= ARGV[1]
  or marker['phase'] ~= 'reserved' then return 0 end
return redis.call('DEL', KEYS[1])
`

export type GoonAssetDeletionDisposition = 'deleted' | 'missing' | 'retained'

export type GoonAssetReservation = { contract: 'goon-asset-deletion/v1'; token: string; phase: 'reserved' | 'deleting' }

export async function reserveGoonUploadAsset(uploadType: CustomGoonUploadType, filename: string): Promise<GoonAssetReservation> {
  // Acquire through the file-service publication queue. It also recovers a
  // publication interrupted before registration, without guessing about age.
  const reserved = await fetch(`${getInternalBatshitServerUrl()}/api/upload/asset-deletion/reserve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
    body: JSON.stringify({ uploadType, filename })
  })
  if (!reserved.ok) throw new Error(`Could not reserve Goon asset for cleanup (${reserved.status}). Retry cleanup.`)
  const payload = await reserved.json()
  const reservation = payload?.reservation
  if (reservation?.contract !== 'goon-asset-deletion/v1' ||
      typeof reservation.token !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservation.token) ||
      !['reserved', 'deleting'].includes(reservation.phase)) {
    throw new Error('File service returned an invalid Goon cleanup reservation.')
  }
  return reservation
}

export function releaseGoonUploadReservation(uploadType: CustomGoonUploadType, filename: string, reservation: GoonAssetReservation) {
  return redis.execute((client: any) => client.eval(RELEASE_RESERVED_ASSET_SCRIPT, {
    keys: [customGoonDeletionKey(uploadType, filename)], arguments: [reservation.token]
  }))
}

export async function deleteReservedGoonUploadAsset(uploadType: CustomGoonUploadType, filename: string,
  reservation: GoonAssetReservation, cleanupContext?: HairCleanupContext, expectedFile?: { ref: string; sha256: string; bytes: number; mimeType: string }) {
  return deleteUploadThroughFileService(uploadType, filename, reservation.token, cleanupContext, expectedFile)
}

async function deleteCustomGoonUploadAsset(uploadType: CustomGoonUploadType, filename: string, cleanupContext?: HairCleanupContext) {
  const reservation = await reserveGoonUploadAsset(uploadType, filename)
  const release = () => releaseGoonUploadReservation(uploadType, filename, reservation)
  if (reservation.phase === 'reserved') {
    let references: GoonAssetReferenceMap
    try {
      references = await redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client,
        { cleanupContext, candidateFiles: [{ uploadType, filename }] }))
    } catch (error) {
      await release()
      throw error
    }
    if (hasGoonUploadReference(references, uploadType, filename)) {
      await release()
      return 'retained' as const
    }
  }
  // Never clear a marker after dispatch: an uncertain response may still own
  // physical IO. A later cleanup resumes through the same fenced endpoint.
  try { return await deleteReservedGoonUploadAsset(uploadType, filename, reservation, cleanupContext) }
  catch (error) {
    if (reservation.phase === 'reserved' && (error as { deletionNotStarted?: boolean }).deletionNotStarted === true) await release()
    throw error
  }
}

export async function deleteGoonUploadAssetDisposition(uploadType: GoonUploadType, filename: string, cleanupContext?: HairCleanupContext): Promise<GoonAssetDeletionDisposition> {
  if ((CUSTOM_GOON_UPLOAD_TYPES as readonly string[]).includes(uploadType)) {
    return publishInRecipeVerificationEpoch(captureRecipeVerificationEpoch(), () =>
      deleteCustomGoonUploadAsset(uploadType as CustomGoonUploadType, filename, cleanupContext))
  }
  return deleteUploadThroughFileService(uploadType, filename)
}

export async function deleteGoonUploadAsset(uploadType: GoonUploadType, filename: string): Promise<boolean> {
  return await deleteGoonUploadAssetDisposition(uploadType, filename) === 'deleted'
}

/** Transient deletion/publication claims are never restored authority. Refuse
 * replacement while one is unresolved; Admin cleanup can safely resume it. */
export async function assertNoGoonAssetMaintenanceForRestore() {
  const markers = await redis.execute((client) => client.keys('goon_asset_delete:*'))
  if (markers.length) {
    throw new Error('Goon asset cleanup or upload is unfinished. Run Goon Asset Cleanup in Admin, then retry restore.')
  }
}

export async function cleanupOrphanGoonUploadAssets(
  userId: string,
  options: { deleteAsset?: DeleteGoonUploadAsset; selectedAssets?: readonly string[] } = {}
): Promise<GoonAssetCleanupResult> {
  return redis.execute((client) =>
    cleanupOrphanGoonUploadAssetsForClient(client as RedisClientLike, userId, options)
  )
}

export async function cleanupOrphanGoonUploadAssetsForClient(
  client: RedisClientLike,
  userId: string,
  options: { deleteAsset?: DeleteGoonUploadAsset; selectedAssets?: readonly string[] } = {}
): Promise<GoonAssetCleanupResult> {
  // Reference enumeration is deliberately completed before the first delete.
  // Any Redis read failure rejects the operation so incomplete evidence can
  // never be mistaken for an empty reference graph.
  const audit = await auditGoonUploadAssetsForClient(client, userId)
  const deleteAsset = options.deleteAsset ?? deleteGoonUploadAssetDisposition
  const deleted: GoonAssetAuditEntry[] = []
  const retained: GoonAssetAuditEntry[] = []
  const missing: GoonAssetAuditEntry[] = []
  const failed: Array<GoonAssetAuditEntry & { error: string }> = []
  const selected = options.selectedAssets ? new Set(options.selectedAssets) : null
  for (const orphan of audit.cleanupCandidates) {
    if (selected && !selected.has(referenceKey(orphan.uploadType, orphan.filename))) continue
    try {
      const outcome = await deleteAsset(orphan.uploadType, orphan.filename)
      if (outcome === 'missing') missing.push(orphan)
      else if (outcome === false || outcome === 'retained') retained.push(orphan)
      else deleted.push(orphan)
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
    retained,
    retainedCount: retained.length,
    missing,
    missingCount: missing.length,
    deletedCount: deleted.length,
    deletedBytes: deleted.reduce((total, entry) => total + entry.size, 0)
  }
}

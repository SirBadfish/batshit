import type {
  GoonAnimationLibrary,
  GoonCustomManifestSummary,
  GoonFileRef,
  GoonGuidedManifestSummary,
  GoonGuidedOutfitPiece,
  GoonGuidedOutfitPreset,
  GoonKind,
  GoonMotionMetadata,
  GoonRecord,
  GoonSourceProfile
} from '$lib/types/goons'
import type { RecipeArchiveContainmentReceipt } from '$lib/goons/recipe'
import type {
  FacialArtworkProvenance,
  FacialArtworkOrientation,
  FacialArtworkRoleId,
  FacialArtworkUpload
} from '$lib/goons/facialArtwork'
import type { LipArtworkUpload } from '$lib/goons/lipArtwork'
import type { NailArtworkUploadV1, NailFamily } from '$lib/goons/nailSurface'
import type {
  SkinSurfaceMapRole,
  SkinSurfaceUploadV1
} from '$lib/goons/skinSurface'
import {
  addGoon,
  setGoons,
  setGoonsError,
  setGoonsLoading,
  updateGoon as updateGoonStore,
  replaceGoon as replaceGoonStore,
  removeGoon as removeGoonStore
} from '$lib/stores/goons.svelte'
import {
  setGoonAnimationLibrary,
  setGoonAnimationLibraryError,
  setGoonAnimationLibraryLoading
} from '$lib/stores/goonAnimationLibrary.svelte'
import * as agentStore from '$lib/stores/agents.svelte'

export type CreateGoonInput = {
  kind?: GoonKind
  sourceProfile?: GoonSourceProfile
  file?: File
  name?: string
  description?: string
  url?: string
  starterAssetId?: string
}

export type AdvancedGoonPackageUploadResult = {
  package: GoonFileRef
  vrm: GoonFileRef
  manifest: GoonFileRef
  manifestSummary?: GoonGuidedManifestSummary
  outfitPieces: GoonGuidedOutfitPiece[]
  outfitPresets: GoonGuidedOutfitPreset[]
}

export type CustomGoonPackageUploadResult = {
  package: GoonFileRef
  model: GoonFileRef
  manifest: GoonFileRef
  manifestSummary?: GoonCustomManifestSummary
  archiveReceipt: RecipeArchiveContainmentReceipt
}

export type GoonFacialArtworkUploadInput = {
  role: FacialArtworkRoleId
  definitionSha256: string
  templateId: string
  templateVersion: string
  orientation: FacialArtworkOrientation
  guideSha256: string
  maskSha256: string
  provenance: FacialArtworkProvenance
}

export type GoonLipArtworkUploadInput = {
  definitionSha256: string
  provenance: FacialArtworkProvenance
}

export type GoonNailArtworkUploadInput = {
  family: NailFamily
  definitionSha256: string
  provenance: FacialArtworkProvenance
}

export type GoonSkinSurfaceArtworkUploadInput = {
  map: SkinSurfaceMapRole
  definitionSha256: string
  provenance: FacialArtworkProvenance
}

async function readApiError(response: Response, fallback: string) {
  const text = await response.text().catch(() => '')
  if (!text) return fallback

  try {
    const payload = JSON.parse(text) as { error?: string; details?: string }
    if (typeof payload.error === 'string' && typeof payload.details === 'string') {
      return `${payload.error}: ${payload.details}`
    }
    if (typeof payload.error === 'string') {
      return payload.error
    }
  } catch {
    // Fall through to plain-text cleanup.
  }

  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || fallback
}

export async function loadGoons(): Promise<GoonRecord[]> {
  setGoonsLoading(true)
  setGoonsError(null)
  try {
    const res = await fetch('/api/goons')
    if (!res.ok) {
      throw new Error('Failed to load goons')
    }
    const data = await res.json()
    const goons = Array.isArray(data?.goons) ? data.goons : []
    setGoons(goons)
    return goons
  } catch (error: any) {
    setGoonsError(error?.message || 'Failed to load goons')
    setGoons([])
    throw error
  } finally {
    setGoonsLoading(false)
  }
}

export async function createGoon(input: CreateGoonInput): Promise<GoonRecord> {
  const form = new FormData()
  form.append('kind', input.kind ?? 'vrm')
  if (input.sourceProfile) {
    form.append('sourceProfile', input.sourceProfile)
  }
  if (input.file) {
    form.append('file', input.file, input.file.name)
  }
  if (input.name) form.append('name', input.name)
  if (input.description) form.append('description', input.description)
  if (input.url) form.append('url', input.url)
  if (input.starterAssetId) form.append('starterAssetId', input.starterAssetId)

  const res = await fetch('/api/goons', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to create goon'))
  }

  const goon = (await res.json()) as GoonRecord
  addGoon(goon)
  return goon
}

async function putGoon(
  id: string,
  updates: Partial<GoonRecord>,
  options: { syncStore: boolean }
): Promise<GoonRecord> {
  const res = await fetch(`/api/goons/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to update goon'))
  }

  const data = await res.json()
  const goon = (data?.goon ?? data) as GoonRecord
  if (options.syncStore) updateGoonStore(id, goon)
  return goon
}

export async function updateGoon(id: string, updates: Partial<GoonRecord>): Promise<GoonRecord> {
  return putGoon(id, updates, { syncStore: true })
}

export async function resetRetiredGoonHair(
  id: string,
  expectedWriteVersion: number
): Promise<GoonRecord> {
  const res = await fetch(`/api/goons/${id}/recipe/recover-retired-hair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedWriteVersion })
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to reset retired Hair'))
  }

  const data = await res.json()
  const goon = (data?.goon ?? data) as GoonRecord
  replaceGoonStore(id, goon)
  return goon
}

/**
 * Persist the editor camera without replacing the global Goon collection.
 * The live editor already owns the current camera, and publishing every orbit
 * stop through the shared store wakes the entire Settings reactive graph.
 */
export async function persistGoonCamera(
  id: string,
  camera: NonNullable<GoonRecord['camera']>
): Promise<GoonRecord> {
  return putGoon(id, { camera }, { syncStore: false })
}

export async function duplicateGoon(id: string): Promise<GoonRecord> {
  const res = await fetch(`/api/goons/${id}/duplicate`, {
    method: 'POST'
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to duplicate goon'))
  }

  const data = await res.json()
  const goon = (data?.goon ?? data) as GoonRecord
  addGoon(goon)
  return goon
}

export async function uploadGoonVrm(id: string, file: File): Promise<GoonFileRef> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch(`/api/goons/${id}/vrm`, {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to upload VRM'))
  }

  const data = await res.json()
  const raw = data?.file ?? {}
  return {
    url: raw.url,
    filename: raw.filename,
    originalName: raw.originalName ?? raw.originalname,
    size: raw.size,
    mimeType: raw.mimetype ?? raw.mimeType,
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at
  }
}

function normalizeFileRef(raw: any): GoonFileRef {
  return {
    url: raw?.url,
    filename: raw?.filename,
    originalName: raw?.originalName ?? raw?.originalname,
    size: raw?.size,
    mimeType: raw?.mimetype ?? raw?.mimeType,
    uploadedAt: raw?.uploadedAt ?? raw?.uploaded_at
  }
}

export async function uploadAdvancedGoonPackage(
  id: string,
  file: File
): Promise<AdvancedGoonPackageUploadResult> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch(`/api/goons/${id}/advanced-package`, {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to upload Goon File Package'))
  }

  const data = await res.json()
  const files = data?.files ?? {}
  return {
    package: normalizeFileRef(files.package),
    vrm: normalizeFileRef(files.vrm),
    manifest: normalizeFileRef(files.manifest),
    manifestSummary: data?.manifestData?.summary,
    outfitPieces: Array.isArray(data?.manifestData?.outfitPieces)
      ? data.manifestData.outfitPieces
      : [],
    outfitPresets: Array.isArray(data?.manifestData?.outfitPresets)
      ? data.manifestData.outfitPresets
      : []
  }
}

export async function uploadCustomGoonPackage(
  id: string,
  file: File
): Promise<CustomGoonPackageUploadResult> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch(`/api/goons/${id}/advanced-package`, {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to upload Goon File Package'))
  }

  const data = await res.json()
  const files = data?.files ?? {}
  return {
    package: normalizeFileRef(files.package),
    model: normalizeFileRef(files.model),
    manifest: normalizeFileRef(files.manifest),
    manifestSummary: data?.manifestData ?? undefined,
    archiveReceipt: data?.archiveReceipt
  }
}

export async function cleanupCustomGoonPackageUpload(
  id: string,
  archiveReceipt: unknown
): Promise<{ deleted: string[]; retained: string[] }> {
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/advanced-package/cleanup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archiveReceipt })
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to clean rejected Recipe package upload'))
  }

  const data = await res.json()
  return {
    deleted: Array.isArray(data?.deleted) ? data.deleted : [],
    retained: Array.isArray(data?.retained) ? data.retained : []
  }
}

export async function uploadGuidedDufClothesVrm(id: string, file: File): Promise<GoonFileRef> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch(`/api/goons/${id}/duf-clothes`, {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to upload DUF clothes VRM'))
  }

  const data = await res.json()
  const raw = data?.file ?? {}
  return {
    url: raw.url,
    filename: raw.filename,
    originalName: raw.originalName ?? raw.originalname,
    size: raw.size,
    mimeType: raw.mimetype ?? raw.mimeType,
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at
  }
}

export async function uploadGoonFacialArtwork(
  id: string,
  file: File,
  input: GoonFacialArtworkUploadInput
): Promise<FacialArtworkUpload> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('role', input.role)
  form.append('definitionSha256', input.definitionSha256)
  form.append('templateId', input.templateId)
  form.append('templateVersion', input.templateVersion)
  form.append('orientation', input.orientation)
  form.append('guideSha256', input.guideSha256)
  form.append('maskSha256', input.maskSha256)
  form.append('provenance', JSON.stringify(input.provenance))

  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/facial-artwork`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to upload facial artwork'))
  }
  const data = (await res.json()) as { artwork?: FacialArtworkUpload }
  if (!data.artwork?.url || !data.artwork.filename || !data.artwork.sha256) {
    throw new Error('Facial artwork upload did not return a valid file reference')
  }
  return data.artwork
}

export async function deleteGoonFacialArtwork(id: string, filename: string): Promise<boolean> {
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/facial-artwork`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })
  if (res.status === 409) return false
  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to delete facial artwork'))
  }
  return true
}

export async function uploadGoonLipArtwork(
  id: string,
  file: File,
  input: GoonLipArtworkUploadInput
): Promise<LipArtworkUpload> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('definitionSha256', input.definitionSha256)
  form.append('provenance', JSON.stringify(input.provenance))
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/lip-artwork`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) throw new Error(await readApiError(res, 'Failed to upload Lip Artwork'))
  const data = (await res.json()) as { artwork?: LipArtworkUpload }
  if (!data.artwork?.url || !data.artwork.filename || !data.artwork.sha256) {
    throw new Error('Lip Artwork upload did not return a valid file reference')
  }
  return data.artwork
}

export async function deleteGoonLipArtwork(id: string, filename: string): Promise<boolean> {
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/lip-artwork`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })
  if (res.status === 409) return false
  if (!res.ok) throw new Error(await readApiError(res, 'Failed to delete Lip Artwork'))
  return true
}

export async function uploadGoonNailArtwork(
  id: string,
  file: File,
  input: GoonNailArtworkUploadInput
): Promise<NailArtworkUploadV1> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('family', input.family)
  form.append('definitionSha256', input.definitionSha256)
  form.append('provenance', JSON.stringify(input.provenance))
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/nail-artwork`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) throw new Error(await readApiError(res, 'Failed to upload Nail Artwork'))
  const data = (await res.json()) as { artwork?: NailArtworkUploadV1 }
  if (
    !data.artwork?.url ||
    !data.artwork.filename ||
    !data.artwork.sha256 ||
    data.artwork.family !== input.family
  ) {
    throw new Error('Nail Artwork upload did not return a valid file reference')
  }
  return data.artwork
}

export async function deleteGoonNailArtwork(id: string, filename: string): Promise<boolean> {
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/nail-artwork`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })
  if (res.status === 409) return false
  if (!res.ok) throw new Error(await readApiError(res, 'Failed to delete Nail Artwork'))
  return true
}

export async function uploadGoonSkinSurfaceArtwork(
  id: string,
  file: File,
  input: GoonSkinSurfaceArtworkUploadInput
): Promise<SkinSurfaceUploadV1> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('map', input.map)
  form.append('definitionSha256', input.definitionSha256)
  form.append('provenance', JSON.stringify(input.provenance))
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/skin-surface-artwork`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) {
    throw new Error(await readApiError(res, `Failed to upload ${input.map} artwork`))
  }
  const data = (await res.json()) as { artwork?: SkinSurfaceUploadV1 }
  if (
    !data.artwork?.url ||
    !data.artwork.filename ||
    !data.artwork.sha256 ||
    data.artwork.map !== input.map
  ) {
    throw new Error(`${input.map} artwork upload did not return a valid file reference`)
  }
  return data.artwork
}

export async function deleteGoonSkinSurfaceArtwork(
  id: string,
  filename: string
): Promise<boolean> {
  const res = await fetch(`/api/goons/${encodeURIComponent(id)}/skin-surface-artwork`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })
  if (res.status === 409) return false
  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to delete Skin Surface Artwork'))
  }
  return true
}

export async function uploadGoonClosetImage(file: File): Promise<GoonFileRef> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch('/api/goons/closet', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload closet image')
  }

  const data = await res.json()
  const raw = data?.file ?? {}
  return {
    url: raw.url,
    filename: raw.filename,
    originalName: raw.originalName ?? raw.originalname,
    size: raw.size,
    mimeType: raw.mimetype ?? raw.mimeType,
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at
  }
}

export async function deleteGoonClosetImage(filename: string): Promise<void> {
  const res = await fetch('/api/goons/closet', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete closet image')
  }
}

export async function uploadGoonSceneSkybox(file: File): Promise<GoonFileRef> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch('/api/goons/scenes', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload skybox image')
  }

  const data = await res.json()
  const raw = data?.file ?? {}
  return {
    url: raw.url,
    filename: raw.filename,
    thumbnailUrl: raw.thumbnailUrl,
    originalName: raw.originalName ?? raw.originalname,
    size: raw.size,
    mimeType: raw.mimetype ?? raw.mimeType,
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at
  }
}

export async function deleteGoonSceneSkybox(filename: string): Promise<void> {
  const res = await fetch('/api/goons/scenes', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete skybox image')
  }
}

export async function uploadGoonRoomShell(file: File): Promise<GoonFileRef> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch('/api/goons/room-shells', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload room shell')
  }

  const data = await res.json()
  const raw = data?.file ?? {}
  return {
    url: raw.url,
    filename: raw.filename,
    originalName: raw.originalName ?? raw.originalname,
    size: raw.size,
    mimeType: raw.mimetype ?? raw.mimeType,
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at
  }
}

export async function deleteGoonRoomShell(filename: string): Promise<void> {
  const res = await fetch('/api/goons/room-shells', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete room shell')
  }
}

export async function uploadGoonRoomTexture(
  file: File,
  kind: string
): Promise<GoonFileRef> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('kind', kind)

  const res = await fetch('/api/goons/room-textures', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload room texture')
  }

  const data = await res.json()
  const raw = data?.file ?? {}
  return {
    url: raw.url,
    filename: raw.filename,
    originalName: raw.originalName ?? raw.originalname,
    size: raw.size,
    mimeType: raw.mimetype ?? raw.mimeType,
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at
  }
}

export async function uploadGoonSceneProp(file: File): Promise<GoonFileRef> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch('/api/goons/scene-props', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload scene prop')
  }

  const data = await res.json()
  const raw = data?.file ?? {}
  return {
    url: raw.url,
    filename: raw.filename,
    originalName: raw.originalName ?? raw.originalname,
    size: raw.size,
    mimeType: raw.mimetype ?? raw.mimeType,
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at
  }
}

export async function deleteGoonSceneProp(filename: string): Promise<void> {
  const res = await fetch('/api/goons/scene-props', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete scene prop')
  }
}

export async function uploadGoonAnimation(id: string, file: File): Promise<GoonRecord> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch(`/api/goons/${id}/animations`, {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload animation')
  }

  const data = await res.json()
  const goon = (data?.goon ?? data) as GoonRecord
  updateGoonStore(id, goon)
  return goon
}

export async function deleteGoonAnimation(id: string, filename: string): Promise<GoonRecord> {
  const res = await fetch(`/api/goons/${id}/animations`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete animation')
  }

  const data = await res.json()
  const goon = (data?.goon ?? data) as GoonRecord
  updateGoonStore(id, goon)
  return goon
}

export async function deleteGoon(id: string): Promise<void> {
  const res = await fetch(`/api/goons/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete goon')
  }
  const payload = await res.json().catch(() => null)
  if (Array.isArray(payload?.clearedAgentIds)) {
    for (const agentId of payload.clearedAgentIds) {
      if (typeof agentId === 'string' && agentId.trim().length > 0) {
        agentStore.updateAgent(agentId, { goon_id: null })
      }
    }
  }
  removeGoonStore(id)
}

export async function loadGoonAnimationLibrary(): Promise<GoonAnimationLibrary> {
  setGoonAnimationLibraryLoading(true)
  setGoonAnimationLibraryError(null)
  try {
    const res = await fetch('/api/goons/animations')
    if (!res.ok) {
      throw new Error('Failed to load animation library')
    }
    const data = await res.json()
    const library = (data?.library ?? data) as GoonAnimationLibrary
    setGoonAnimationLibrary(library)
    return library
  } catch (error: any) {
    setGoonAnimationLibraryError(error?.message || 'Failed to load animation library')
    setGoonAnimationLibrary(null)
    throw error
  } finally {
    setGoonAnimationLibraryLoading(false)
  }
}

export type GoonMotionVersionConflict = {
  motionName: string
  lane: 'vrm' | 'glb'
  existingFilename?: string
  displayName?: string | null
}

// Thrown when an upload matches an existing motion's name + format and the
// caller did not pass replaceExisting — the UI prompts before replacing.
export class GoonMotionVersionExistsError extends Error {
  conflict: GoonMotionVersionConflict

  constructor(message: string, conflict: GoonMotionVersionConflict) {
    super(message)
    this.name = 'GoonMotionVersionExistsError'
    this.conflict = conflict
  }
}

type UploadGoonAnimationOptions = {
  replaceExisting?: boolean
}

async function throwGoonAnimationUploadError(res: Response): Promise<never> {
  const text = await res.text().catch(() => '')
  if (res.status === 409) {
    try {
      const payload = JSON.parse(text)
      if (payload?.code === 'motion_version_exists' && payload?.conflict) {
        throw new GoonMotionVersionExistsError(
          payload.error || 'This motion already has a version in that format.',
          payload.conflict as GoonMotionVersionConflict
        )
      }
    } catch (error) {
      if (error instanceof GoonMotionVersionExistsError) throw error
    }
  }
  throw new Error(text || 'Failed to upload animation')
}

export async function uploadGoonAnimationToLibrary(
  file: File,
  options: UploadGoonAnimationOptions = {}
): Promise<GoonAnimationLibrary> {
  const form = new FormData()
  form.append('file', file, file.name)
  if (options.replaceExisting) form.append('replaceExisting', '1')

  const res = await fetch('/api/goons/animations', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    await throwGoonAnimationUploadError(res)
  }

  const data = await res.json()
  const library = (data?.library ?? data) as GoonAnimationLibrary
  setGoonAnimationLibrary(library)
  return library
}

export async function uploadGoonAnimationToLibraryFile(
  file: File,
  options: UploadGoonAnimationOptions = {}
): Promise<{ library: GoonAnimationLibrary; animation: GoonFileRef }> {
  const form = new FormData()
  form.append('file', file, file.name)
  if (options.replaceExisting) form.append('replaceExisting', '1')

  const res = await fetch('/api/goons/animations', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    await throwGoonAnimationUploadError(res)
  }

  const data = await res.json()
  const library = (data?.library ?? data) as GoonAnimationLibrary
  const raw = data?.animation ?? null
  const animation: GoonFileRef = {
    url: raw?.url,
    filename: raw?.filename,
    displayName: raw?.displayName,
    originalName: raw?.originalName ?? raw?.originalname,
    size: raw?.size,
    mimeType: raw?.mimetype ?? raw?.mimeType,
    uploadedAt: raw?.uploadedAt ?? raw?.uploaded_at,
    tags: raw?.tags,
    motionMeta: raw?.motionMeta,
    previewVideo: raw?.previewVideo
      ? {
          url: raw.previewVideo.url,
          filename: raw.previewVideo.filename,
          originalName: raw.previewVideo.originalName ?? raw.previewVideo.originalname,
          size: raw.previewVideo.size,
          mimeType: raw.previewVideo.mimetype ?? raw.previewVideo.mimeType,
          uploadedAt: raw.previewVideo.uploadedAt ?? raw.previewVideo.uploaded_at
        }
      : undefined
  }

  if (!animation.url || !animation.filename) {
    throw new Error('Animation upload did not return a valid file reference')
  }

  setGoonAnimationLibrary(library)
  return { library, animation }
}

export async function deleteGoonAnimationFromLibrary(
  filename: string | string[]
): Promise<GoonAnimationLibrary> {
  const filenames = Array.isArray(filename) ? filename : [filename]
  const res = await fetch('/api/goons/animations', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete animation')
  }

  const data = await res.json()
  const library = (data?.library ?? data) as GoonAnimationLibrary
  setGoonAnimationLibrary(library)
  return library
}

export async function updateGoonAnimationLibraryMetadata(
  filename: string,
  options: {
    displayName?: string | null
    tags?: string[]
    motionMeta?: GoonMotionMetadata
  }
): Promise<GoonAnimationLibrary> {
  const res = await fetch('/api/goons/animations', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      displayName: options.displayName,
      tags: options.tags,
      motionMeta: options.motionMeta
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to update animation metadata')
  }

  const data = await res.json()
  const library = (data?.library ?? data) as GoonAnimationLibrary
  setGoonAnimationLibrary(library)
  return library
}

export async function uploadGoonAnimationPreview(
  animationFilename: string,
  file: File
): Promise<{ library: GoonAnimationLibrary; previewVideo: GoonFileRef }> {
  const form = new FormData()
  form.append('animationFilename', animationFilename)
  form.append('file', file, file.name)

  const res = await fetch('/api/goons/animations/previews', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload animation preview')
  }

  const data = await res.json()
  const library = (data?.library ?? data) as GoonAnimationLibrary
  const raw = data?.previewVideo ?? null
  const previewVideo: GoonFileRef = {
    url: raw?.url,
    filename: raw?.filename,
    originalName: raw?.originalName ?? raw?.originalname,
    size: raw?.size,
    mimeType: raw?.mimetype ?? raw?.mimeType,
    uploadedAt: raw?.uploadedAt ?? raw?.uploaded_at
  }

  if (!previewVideo.url || !previewVideo.filename) {
    throw new Error('Animation preview upload did not return a valid file reference')
  }

  setGoonAnimationLibrary(library)
  return { library, previewVideo }
}

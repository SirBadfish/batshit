import { page } from '$app/state'
import type {
  GoonAnimationLibrary,
  GoonCompatibilityReport,
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
import {
  isValidGoonInventoryEntry, isValidGoonMotionLibrary,
  type GoonCompatibilityBasis, type captureGoonCompatibilityResetBasis
} from '$lib/goons/goonCompatibilityBasis'
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
  setGoonsOwner,
  beginGoonsRead,
  isCurrentGoonsRead,
  captureGoonsMutationTicket,
  isCurrentGoonsMutation,
  acceptGoonsRead,
  failGoonsRead,
  updateGoon as updateGoonStore,
  replaceGoon as replaceGoonStore,
  removeGoon as removeGoonStore
} from '$lib/stores/goons.svelte'
import {
  setGoonAnimationLibraryOwner,
  beginGoonAnimationLibraryOperation,
  isCurrentGoonAnimationLibraryOperation,
  acceptGoonAnimationLibraryOperation,
  failGoonAnimationLibraryOperation,
  restoreGoonAnimationLibraryOperation
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

function authenticatedGoonOwner() {
  const id = page.data?.user?.id
  const owner = typeof id === 'string' && id ? id : null
  setGoonsOwner(owner)
  setGoonAnimationLibraryOwner(owner)
  if (!owner) throw new Error('Sign in before loading Goons.')
  return owner
}

function requireOwnedGoonAnswer(goon: GoonRecord, owner: string) {
  if (authenticatedGoonOwner() !== owner || !goon || goon.user_id !== owner) {
    throw new Error('The Goon update succeeded, but its result could not be confirmed for this session. Reload to check its current state.')
  }
  return goon
}

let goonRefresh: { owner: string; demand: number; promise: Promise<GoonRecord[]> } | null = null
function refreshGoonsAfterConflictingAck(owner: string): Promise<GoonRecord[]> {
  if (goonRefresh?.owner === owner) {
    goonRefresh.demand += 1
    return goonRefresh.promise
  }
  const state = { owner, demand: 1, promise: Promise.resolve([] as GoonRecord[]) }
  state.promise = (async () => {
    while (true) {
      const demand = state.demand
      if (authenticatedGoonOwner() !== owner) throw new Error('The Goon account changed. Reload to confirm the update.')
      const current = await loadGoons()
      if (authenticatedGoonOwner() !== owner) throw new Error('The Goon account changed. Reload to confirm the update.')
      if (demand === state.demand) return current
    }
  })().finally(() => { if (goonRefresh === state) goonRefresh = null })
  goonRefresh = state
  return state.promise
}

async function reconcileOwnedGoonAnswer(
  goon: GoonRecord, owner: string, ticket: ReturnType<typeof captureGoonsMutationTicket>
) {
  requireOwnedGoonAnswer(goon, owner)
  if (isCurrentGoonsMutation(ticket)) return { goon, refreshed: false }
  let goons: GoonRecord[]
  try { goons = await refreshGoonsAfterConflictingAck(owner) }
  catch { throw new Error('The Goon update succeeded, but its current state is unavailable. Reload to confirm it.') }
  const current = goons.find((entry) => entry.id === goon.id)
  if (!current) throw new Error('The Goon update succeeded, but its current state is unavailable. Reload to confirm it.')
  return { goon: current, refreshed: true }
}

async function refreshDeletedGoonAgentAssignments(
  owner: string, goonId: string, ids: unknown,
  original: Map<string, ReturnType<typeof agentStore.getAgentById>>
) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('The Goon was deleted, but its agent assignments could not be confirmed.')
  }
  for (const id of new Set(ids as string[])) {
    const before = original.get(id)
    if (!before || before.user_id !== owner || before.goon_id !== goonId ||
      agentStore.getAgentById(id) !== before) continue
    const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('The Goon was deleted, but its agent assignments could not be confirmed.')
    const fresh = await response.json()
    if (authenticatedGoonOwner() !== owner || !fresh || fresh.id !== id || fresh.user_id !== owner ||
      (fresh.goon_id != null && typeof fresh.goon_id !== 'string')) {
      throw new Error('The Goon was deleted, but its agent assignments could not be confirmed.')
    }
    const current = agentStore.getAgentById(id)
    if (current === before && current.user_id === owner) {
      agentStore.updateAgent(id, { goon_id: fresh.goon_id ?? null })
    }
  }
  assertDeletedGoonAssignmentsConfirmed(owner, goonId, ids)
}

function assertDeletedGoonAssignmentsConfirmed(owner: string, goonId: string, ids: unknown) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id) ||
    ids.some((id) => {
      const agent = agentStore.getAgentById(id)
      return agent?.user_id === owner && agent.goon_id === goonId
    })) {
    throw new Error('The Goon was deleted, but its agent assignments could not be confirmed.')
  }
}

export async function loadGoons(): Promise<GoonRecord[]> {
  const owner = authenticatedGoonOwner()
  const ticket = beginGoonsRead(owner)
  try {
    const res = await fetch('/api/goons')
    if (!res.ok) {
      throw new Error(await readApiError(res, 'Failed to load goons'))
    }
    const data = await res.json()
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.ownerId !== owner ||
      !Array.isArray(data.goons) || data.goons.some((goon: unknown) => !isValidGoonInventoryEntry(goon, owner)) ||
      new Set(data.goons.map((goon: GoonRecord) => goon.id)).size !== data.goons.length) {
      throw new Error('The saved Goon list response is invalid. The last loaded Goons were kept.')
    }
    const goons = data.goons
    if (authenticatedGoonOwner() !== owner || !acceptGoonsRead(ticket, goons)) {
      throw new Error('The Goon list read was superseded.')
    }
    return goons
  } catch (error: any) {
    const current = page.data?.user?.id
    if (current !== owner) {
      setGoonsOwner(typeof current === 'string' ? current : null)
      setGoonAnimationLibraryOwner(typeof current === 'string' ? current : null)
    } else if (isCurrentGoonsRead(ticket)) {
      failGoonsRead(ticket, error?.message || 'Failed to load goons')
    }
    throw error
  }
}

export async function createGoon(input: CreateGoonInput): Promise<GoonRecord> {
  const owner = authenticatedGoonOwner()
  const ticket = captureGoonsMutationTicket(owner)
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

  const result = await reconcileOwnedGoonAnswer((await res.json()) as GoonRecord, owner, ticket)
  if (!result.refreshed) addGoon(result.goon)
  return result.goon
}

async function putGoon(
  id: string,
  updates: Partial<GoonRecord>,
  options: {
    syncStore: boolean
    compatibilityResetBasis?: ReturnType<typeof captureGoonCompatibilityResetBasis>
  }
): Promise<GoonRecord> {
  const owner = authenticatedGoonOwner()
  const ticket = options.syncStore ? captureGoonsMutationTicket(owner) : undefined
  const res = await fetch(`/api/goons/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...updates,
      ...(options.compatibilityResetBasis ? { __compatibilityResetBasis: options.compatibilityResetBasis } : {})
    })
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to update goon'))
  }

  const data = await res.json()
  const answer = requireOwnedGoonAnswer((data?.goon ?? data) as GoonRecord, owner)
  if (!ticket) return answer
  const result = await reconcileOwnedGoonAnswer(answer, owner, ticket)
  if (!result.refreshed) updateGoonStore(id, result.goon)
  return result.goon
}

export async function updateGoon(id: string, updates: Partial<GoonRecord>): Promise<GoonRecord> {
  return putGoon(id, updates, { syncStore: true })
}

export async function updateGoonCompatibility(
  id: string, report: GoonCompatibilityReport, basis: GoonCompatibilityBasis
): Promise<{ status: 'saved'; goon: GoonRecord } | { status: 'refused' } | { status: 'unknown'; error: unknown }> {
  try {
    const response = await fetch(`/api/goons/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compatibility: report, __compatibilityBasis: basis })
    })
    if ([400, 401, 403, 404, 409].includes(response.status)) return { status: 'refused' }
    if (!response.ok) return { status: 'unknown', error: new Error(await readApiError(response, 'Compatibility could not be saved')) }
    const data = await response.json()
    const goon = (data?.goon ?? data) as GoonRecord
    if (!goon || goon.id !== id || goon.user_id !== basis.model.userId ||
      authenticatedGoonOwner() !== basis.model.userId || !goon.compatibility?.owner) {
      return { status: 'unknown', error: new Error('Compatibility save returned an invalid result') }
    }
    return { status: 'saved', goon }
  } catch (error) {
    return { status: 'unknown', error }
  }
}

export async function updateGoonWithCompatibilityReset(
  id: string, updates: Partial<GoonRecord>, basis: ReturnType<typeof captureGoonCompatibilityResetBasis>
): Promise<GoonRecord> {
  return putGoon(id, updates, { syncStore: true, compatibilityResetBasis: basis })
}

export async function resetRetiredGoonHair(
  id: string,
  expectedWriteVersion: number
): Promise<GoonRecord> {
  const owner = authenticatedGoonOwner()
  const ticket = captureGoonsMutationTicket(owner)
  const res = await fetch(`/api/goons/${id}/recipe/recover-retired-hair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedWriteVersion })
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to reset retired Hair'))
  }

  const data = await res.json()
  const result = await reconcileOwnedGoonAnswer((data?.goon ?? data) as GoonRecord, owner, ticket)
  if (!result.refreshed) replaceGoonStore(id, result.goon)
  return result.goon
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
  const owner = authenticatedGoonOwner()
  const ticket = captureGoonsMutationTicket(owner)
  const res = await fetch(`/api/goons/${id}/duplicate`, {
    method: 'POST'
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Failed to duplicate goon'))
  }

  const data = await res.json()
  const result = await reconcileOwnedGoonAnswer((data?.goon ?? data) as GoonRecord, owner, ticket)
  if (!result.refreshed) addGoon(result.goon)
  return result.goon
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
    throw new Error(text || 'Failed to upload panorama background')
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
    throw new Error(text || 'Failed to delete panorama background')
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
  const owner = authenticatedGoonOwner()
  const ticket = captureGoonsMutationTicket(owner)
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
  const result = await reconcileOwnedGoonAnswer((data?.goon ?? data) as GoonRecord, owner, ticket)
  if (!result.refreshed) updateGoonStore(id, result.goon)
  return result.goon
}

export async function deleteGoonAnimation(id: string, filename: string): Promise<GoonRecord> {
  const owner = authenticatedGoonOwner()
  const ticket = captureGoonsMutationTicket(owner)
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
  const result = await reconcileOwnedGoonAnswer((data?.goon ?? data) as GoonRecord, owner, ticket)
  if (!result.refreshed) updateGoonStore(id, result.goon)
  return result.goon
}

export async function deleteGoon(id: string): Promise<void> {
  const owner = authenticatedGoonOwner()
  const ticket = captureGoonsMutationTicket(owner)
  const originalAgents = new Map(agentStore.getAgents().filter((agent) => agent.user_id === owner)
    .map((agent) => [agent.id, agent] as const))
  const res = await fetch(`/api/goons/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to delete goon')
  }
  const payload = await res.json().catch(() => null)
  if (payload?.ownerId !== owner || authenticatedGoonOwner() !== owner) {
    throw new Error('The Goon was deleted, but its result could not be confirmed for this session. Reload to check its current state.')
  }
  if (!isCurrentGoonsMutation(ticket)) {
    let current: GoonRecord[]
    try { current = await refreshGoonsAfterConflictingAck(owner) }
    catch { throw new Error('The Goon was deleted, but its current state is unavailable. Reload to confirm it.') }
    if (current.some((goon) => goon.id === id)) throw new Error('The Goon was deleted, but its current state is unavailable. Reload to confirm it.')
    await refreshDeletedGoonAgentAssignments(owner, id, payload.clearedAgentIds, originalAgents)
    return
  }
  if (Array.isArray(payload?.clearedAgentIds)) {
    for (const agentId of payload.clearedAgentIds) {
      const before = typeof agentId === 'string' ? originalAgents.get(agentId) : undefined
      if (before && before.goon_id === id && agentStore.getAgentById(agentId) === before) {
        agentStore.updateAgent(agentId, { goon_id: null })
      }
    }
  }
  removeGoonStore(id)
  assertDeletedGoonAssignmentsConfirmed(owner, id, payload?.clearedAgentIds)
}

export async function loadGoonAnimationLibrary(): Promise<GoonAnimationLibrary> {
  const owner = authenticatedGoonOwner()
  const ticket = beginGoonAnimationLibraryOperation(owner)
  try {
    const res = await fetch('/api/goons/animations')
    if (!res.ok) {
      throw new Error('Failed to load animation library')
    }
    const data = await res.json()
    const library = data?.library
    if (!data || data.ownerId !== owner || !isValidGoonMotionLibrary(library)) {
      throw new Error('The saved Motion library response is invalid. The last loaded motions were kept.')
    }
    if (authenticatedGoonOwner() !== owner || !acceptGoonAnimationLibraryOperation(ticket, library)) {
      throw new Error('The Motion library read was superseded.')
    }
    return library
  } catch (error: any) {
    const current = page.data?.user?.id
    if (current !== owner) {
      setGoonsOwner(typeof current === 'string' ? current : null)
      setGoonAnimationLibraryOwner(typeof current === 'string' ? current : null)
    } else if (isCurrentGoonAnimationLibraryOperation(ticket)) {
      failGoonAnimationLibraryOperation(ticket, error?.message || 'Failed to load animation library')
    }
    throw error
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

let motionRefresh: { owner: string; demand: number; promise: Promise<GoonAnimationLibrary> } | null = null
function refreshMotionLibraryAfterConflictingAck(owner: string): Promise<GoonAnimationLibrary> {
  if (motionRefresh?.owner === owner) {
    motionRefresh.demand += 1
    return motionRefresh.promise
  }
  const state = { owner, demand: 1, promise: Promise.resolve({ vrma: [] } as GoonAnimationLibrary) }
  state.promise = (async () => {
    while (true) {
      const demand = state.demand
      if (authenticatedGoonOwner() !== owner) throw new Error('The Motion account changed. Reload to confirm the update.')
      const current = await loadGoonAnimationLibrary()
      if (authenticatedGoonOwner() !== owner) throw new Error('The Motion account changed. Reload to confirm the update.')
      if (demand === state.demand) return current
    }
  })().finally(() => { if (motionRefresh === state) motionRefresh = null })
  motionRefresh = state
  return state.promise
}

async function runOwnedMotionLibraryWrite<T>(operation: () => Promise<{
  data: any
  value: (library: GoonAnimationLibrary) => T
}>): Promise<T> {
  const owner = authenticatedGoonOwner()
  const ticket = beginGoonAnimationLibraryOperation(owner)
  let confirmedAnswer = false
  try {
    const { data, value } = await operation()
    const library = data?.library
    if (data?.ownerId !== owner || !isValidGoonMotionLibrary(library)) {
      throw new Error('The Motion library response could not be confirmed. Saved motions were kept.')
    }
    if (authenticatedGoonOwner() !== owner) {
      throw new Error('The Motion account changed. Reload to confirm the update.')
    }
    if (!isCurrentGoonAnimationLibraryOperation(ticket)) {
      let current: GoonAnimationLibrary
      try { current = await refreshMotionLibraryAfterConflictingAck(owner) }
      catch { throw new Error('The Motion update succeeded, but its current library is unavailable. Reload to confirm it.') }
      confirmedAnswer = true
      return value(current)
    }
    if (!acceptGoonAnimationLibraryOperation(ticket, library)) throw new Error('The Motion library update was superseded.')
    confirmedAnswer = true
    return value(library)
  } catch (error: any) {
    const current = page.data?.user?.id
    if (current !== owner) {
      setGoonsOwner(typeof current === 'string' ? current : null)
      setGoonAnimationLibraryOwner(typeof current === 'string' ? current : null)
    } else if (!confirmedAnswer && isCurrentGoonAnimationLibraryOperation(ticket)) {
      if (error instanceof GoonMotionVersionExistsError) restoreGoonAnimationLibraryOperation(ticket)
      else failGoonAnimationLibraryOperation(ticket, error?.message || 'Motion library update could not be confirmed')
    }
    throw error
  }
}

export async function uploadGoonAnimationToLibrary(
  file: File,
  options: UploadGoonAnimationOptions = {}
): Promise<GoonAnimationLibrary> {
  return runOwnedMotionLibraryWrite(async () => {
    const form = new FormData()
    form.append('file', file, file.name)
    if (options.replaceExisting) form.append('replaceExisting', '1')
    const res = await fetch('/api/goons/animations', { method: 'POST', body: form })
    if (!res.ok) await throwGoonAnimationUploadError(res)
    const data = await res.json()
    return { data, value: (library) => {
      const filename = data?.animation?.filename
      if (typeof filename !== 'string' || !library.vrma.some((entry) => entry.filename === filename)) {
        throw new Error('The uploaded Motion is no longer in the current library. Reload to confirm.')
      }
      return library
    } }
  })
}

export async function uploadGoonAnimationToLibraryFile(
  file: File,
  options: UploadGoonAnimationOptions = {}
): Promise<{ library: GoonAnimationLibrary; animation: GoonFileRef }> {
  return runOwnedMotionLibraryWrite(async () => {
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

    return { data, value: (library) => {
      if (!library.vrma.some((entry) => entry.filename === animation.filename && entry.url === animation.url)) {
        throw new Error('The uploaded Motion changed before confirmation. Reload to confirm.')
      }
      return { library, animation }
    } }
  })
}

export async function deleteGoonAnimationFromLibrary(
  filename: string | string[]
): Promise<GoonAnimationLibrary> {
  return runOwnedMotionLibraryWrite(async () => {
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
    return { data, value: (library) => {
      if (library.vrma.some((entry) => filenames.includes(entry.filename))) {
        throw new Error('The deleted Motion is present again. Reload to confirm the current library.')
      }
      return library
    } }
  })
}

export async function updateGoonAnimationLibraryMetadata(
  filename: string,
  options: {
    displayName?: string | null
    tags?: string[]
    motionMeta?: GoonMotionMetadata
  }
): Promise<GoonAnimationLibrary> {
  return runOwnedMotionLibraryWrite(async () => {
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
    return { data, value: (library) => library }
  })
}

export async function uploadGoonAnimationPreview(
  animationFilename: string,
  file: File
): Promise<{ library: GoonAnimationLibrary; previewVideo: GoonFileRef }> {
  return runOwnedMotionLibraryWrite(async () => {
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

    return { data, value: (library) => {
      const entry = library.vrma.find((item) => item.filename === animationFilename)
      if (entry?.previewVideo?.url !== previewVideo.url) {
        throw new Error('The Motion preview changed before confirmation. Reload to confirm.')
      }
      return { library, previewVideo }
    } }
  })
}

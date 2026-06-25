import type {
  GoonAnimationLibrary,
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
  addGoon,
  setGoons,
  setGoonsError,
  setGoonsLoading,
  updateGoon as updateGoonStore,
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

export async function updateGoon(id: string, updates: Partial<GoonRecord>): Promise<GoonRecord> {
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
  updateGoonStore(id, goon)
  return goon
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

export async function uploadGoonAnimationToLibrary(
  file: File
): Promise<GoonAnimationLibrary> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch('/api/goons/animations', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload animation')
  }

  const data = await res.json()
  const library = (data?.library ?? data) as GoonAnimationLibrary
  setGoonAnimationLibrary(library)
  return library
}

export async function uploadGoonAnimationToLibraryFile(
  file: File
): Promise<{ library: GoonAnimationLibrary; animation: GoonFileRef }> {
  const form = new FormData()
  form.append('file', file, file.name)

  const res = await fetch('/api/goons/animations', {
    method: 'POST',
    body: form
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Failed to upload animation')
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

export async function deleteGoonAnimationFromLibrary(filename: string): Promise<GoonAnimationLibrary> {
  const res = await fetch('/api/goons/animations', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
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

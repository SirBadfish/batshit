import { normalizeUploadUrlForStorage } from './batshitServerUrls'
import { isValidGoonMotionLibrary } from '$lib/goons/goonCompatibilityBasis'
import type { GoonAnimationLibrary, GoonFileRef, GoonMotionMetadata } from '$lib/types/goons'

export function normalizeGoonAnimationLibrary(value: unknown): GoonAnimationLibrary {
  if (value === null) return { vrma: [] }
  if (!isValidGoonMotionLibrary(value)) {
    throw new Error('The saved Motion library is unavailable. Its original data was kept.')
  }
  const record = value as GoonAnimationLibrary
  return {
    ...record,
    vrma: Array.isArray(record.vrma) ? record.vrma.map((entry) => normalizeGoonAnimationFileRef(entry)) : []
  }
}

/** A missing key is a valid empty library; a present JSON null is not. */
export async function readStoredGoonAnimationLibrary(client: any, key: string): Promise<GoonAnimationLibrary> {
  const value = await client.json.get(key) as unknown
  if (value === null && await client.exists(key)) {
    throw new Error('The saved Motion library is unavailable. Its original data was kept.')
  }
  return normalizeGoonAnimationLibrary(value)
}

function normalizeNestedFileRef(value: unknown): GoonFileRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === 'string' ? raw.url : ''
  const filename = typeof raw.filename === 'string' ? raw.filename : ''
  if (!url || !filename) return undefined
  const normalized = {
    url: normalizeUploadUrlForStorage(url),
    filename,
    originalName: typeof raw.originalName === 'string' ? raw.originalName : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : typeof raw.mimetype === 'string' ? raw.mimetype : undefined,
    uploadedAt: typeof raw.uploadedAt === 'string' ? raw.uploadedAt : typeof raw.uploaded_at === 'string' ? raw.uploaded_at : undefined
  }
  const present = Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== undefined))
  return { ...raw, ...present } as GoonFileRef
}

export function normalizeGoonAnimationFileRef(value: unknown): GoonFileRef {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const normalized = {
    url: typeof raw.url === 'string' ? normalizeUploadUrlForStorage(raw.url) : '',
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : undefined,
    originalName: typeof raw.originalName === 'string' ? raw.originalName : typeof raw.originalname === 'string' ? raw.originalname : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : typeof raw.mimetype === 'string' ? raw.mimetype : undefined,
    uploadedAt: typeof raw.uploadedAt === 'string' ? raw.uploadedAt : typeof raw.uploaded_at === 'string' ? raw.uploaded_at : undefined,
    metaUpdatedAt: typeof raw.metaUpdatedAt === 'string' ? raw.metaUpdatedAt : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((entry): entry is string => typeof entry === 'string') : undefined,
    motionMeta: normalizeGoonMotionMeta(raw.motionMeta),
    previewVideo: normalizeNestedFileRef(raw.previewVideo)
  }
  // Keep additional saved fields and nulls. Only values actually normalized
  // by this owner replace their original representation.
  const present = Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== undefined))
  if (present.motionMeta && raw.motionMeta && typeof raw.motionMeta === 'object') {
    present.motionMeta = { ...raw.motionMeta, ...present.motionMeta as object }
  }
  return { ...raw, ...present } as GoonFileRef
}

export function normalizeGoonMotionMeta(value: unknown): GoonMotionMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const posture = typeof record.posture === 'string' && record.posture.trim() ? record.posture.trim() : undefined
  const playback = record.playback === 'loop' || record.playback === 'oneshot' ? record.playback : undefined
  const eyeContact = record.eyeContact === 'off' ? record.eyeContact : undefined
  if (!posture && !playback && !eyeContact) return undefined
  return { ...(posture ? { posture } : {}), ...(playback ? { playback } : {}), ...(eyeContact ? { eyeContact } : {}) }
}

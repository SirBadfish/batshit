import { canonicalRecipeString } from '$lib/goons/recipe/recipeCanonical'
import { sha256Hex } from '$lib/utils/sha256'
import type { GoonAnimationLoadPlan } from '$lib/goons/animationLoadPlan'
import type { GoonCompatibilityOwner, GoonFileRef, GoonRecord } from '$lib/types/goons'

// This limits only the derived diagnostic snapshot. It never limits Goon or motion playback.
export const MAX_COMPATIBILITY_GOONS = 1024
export const MAX_COMPATIBILITY_MOTIONS = 8192
export const MAX_COMPATIBILITY_BASIS_BYTES = 2 * 1024 * 1024

/** Match the Dock's existing shared-first, per-Goon order and de-duplication. */
export function collectGoonCompatibilityMotionFiles(
  goons: readonly GoonRecord[], shared: readonly GoonFileRef[]
) {
  const files: GoonFileRef[] = []
  const seen = new Set<string>()
  const add = (file: GoonFileRef | null | undefined) => {
    if (!isSafeMotionLoadFile(file)) return
    const key = file.url || file.filename
    if (!key || seen.has(key)) return
    seen.add(key)
    files.push(file)
  }
  for (const file of shared) add(file)
  for (const goon of goons) {
    for (const file of Array.isArray(goon.files?.animations) ? goon.files.animations : []) add(file)
  }
  return files
}

function uploadRef(value: unknown) {
  if (typeof value !== 'string') return null
  return value
}

function fileIdentity(file: GoonFileRef | null | undefined) {
  if (!file) return null
  if (typeof file !== 'object' ||
    (file.url != null && typeof file.url !== 'string') ||
    (file.filename != null && typeof file.filename !== 'string') ||
    (typeof file.url !== 'string' && typeof file.filename !== 'string')) {
    throw new Error('Compatibility analysis needs valid motion and model references.')
  }
  return {
    url: uploadRef(file.url), filename: file.filename ?? null,
    originalName: file.originalName ?? null, size: file.size ?? null,
    uploadedAt: file.uploadedAt ?? null
  }
}

export function isSafeMotionLoadFile(value: unknown): value is GoonFileRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as GoonFileRef
  const raw = value as Record<string, unknown>
  if (typeof file.url !== 'string' || !file.url.trim() ||
    (file.filename != null && typeof file.filename !== 'string')) return false
  for (const key of ['displayName', 'originalName', 'originalname', 'mimeType', 'mimetype',
    'uploadedAt', 'uploaded_at', 'thumbnailUrl', 'metaUpdatedAt']) {
    if (raw[key] != null && typeof raw[key] !== 'string') return false
  }
  if (file.size != null && (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0)) return false
  if (file.tags != null && (!Array.isArray(file.tags) || file.tags.some((tag) => typeof tag !== 'string'))) return false
  if (file.motionMeta != null) {
    if (typeof file.motionMeta !== 'object' || Array.isArray(file.motionMeta)) return false
    const meta = file.motionMeta
    if (meta.posture != null && typeof meta.posture !== 'string') return false
    if (meta.playback != null && meta.playback !== 'loop' && meta.playback !== 'oneshot') return false
    if (meta.eyeContact != null && meta.eyeContact !== 'off') return false
  }
  return true
}

export function isValidMotionFileRef(value: unknown): value is GoonFileRef {
  if (!isSafeMotionLoadFile(value) || typeof value.filename !== 'string' || !value.filename.trim()) return false
  const file = value
  if (file.previewVideo != null && (!file.previewVideo || typeof file.previewVideo !== 'object' ||
    Array.isArray(file.previewVideo) || typeof file.previewVideo.url !== 'string' || !file.previewVideo.url.trim() ||
    typeof file.previewVideo.filename !== 'string' || !file.previewVideo.filename.trim())) return false
  return true
}

function motionIdentity(file: GoonFileRef) {
  if (!isValidMotionFileRef(file)) throw new Error('Compatibility analysis needs valid motion references.')
  const identity = fileIdentity(file)
  if (!identity || typeof file.url !== 'string' || !file.url ||
    typeof file.filename !== 'string' || !file.filename) {
    throw new Error('Compatibility analysis needs valid motion references.')
  }
  return {
    ...identity,
    motionMeta: file.motionMeta ? {
      posture: file.motionMeta.posture ?? null,
      playback: file.motionMeta.playback ?? null,
      eyeContact: file.motionMeta.eyeContact ?? null
    } : null
  }
}

/** A list may contain old records without files, but never an omitted or malformed indexed owner. */
export function isValidGoonInventoryEntry(value: unknown, owner: string, expectedId?: string): value is GoonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const goon = value as GoonRecord
  if (typeof goon.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(goon.id) ||
    (expectedId !== undefined && goon.id !== expectedId) || goon.user_id !== owner) return false
  if (goon.name != null && typeof goon.name !== 'string') return false
  return true
}

/** Bad optional motion data makes diagnostics unverified, not the whole Goon list unavailable. */
export function isValidGoonMotionSources(goon: GoonRecord): boolean {
  if (goon.files == null) return true
  if (typeof goon.files !== 'object' || Array.isArray(goon.files)) return false
  const animations = goon.files.animations
  if (animations == null) return true
  if (!Array.isArray(animations)) return false
  try { animations.forEach(motionIdentity); return true } catch { return false }
}

export function isValidGoonMotionLibrary(value: unknown): value is { vrma: GoonFileRef[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const files = (value as { vrma?: unknown }).vrma
  if (!Array.isArray(files)) return false
  try { files.forEach(motionIdentity); return true } catch { return false }
}

export function compatibilityModelBasis(goon: GoonRecord) {
  const active = goon.recipe?.contract === 'goon-recipe/v2' ? goon.recipe.activeRevision : null
  return {
    id: goon.id, userId: goon.user_id, createdAt: goon.created_at,
    kind: goon.kind ?? null, sourceProfile: goon.sourceProfile ?? null,
    vrm: fileIdentity(goon.files?.vrm), vrmPending: fileIdentity(goon.files?.vrmPending),
    package: fileIdentity(goon.customAvatar?.package),
    model: fileIdentity(goon.customAvatar?.model),
    manifest: fileIdentity(goon.customAvatar?.manifest),
    guidedManifest: fileIdentity(goon.guidedAvatar?.manifest),
    guidedOverlays: (goon.guidedAvatar?.dufOverlays ?? []).map((overlay) => fileIdentity(overlay.file)),
    guidedPieceStates: Object.fromEntries(Object.entries(goon.guidedAvatar?.pieceStates ?? {})),
    activeRevision: active ? { ref: active.ref, sha256: active.sha256 } : null
  }
}

/** A model replacement also carries whole `files`/guided siblings in today's editor. */
export function captureGoonCompatibilityResetBasis(goon: GoonRecord) {
  return {
    model: compatibilityModelBasis(goon),
    files: JSON.parse(JSON.stringify(goon.files ?? null)) as unknown,
    guidedAvatar: JSON.parse(JSON.stringify(goon.guidedAvatar ?? null)) as unknown
  }
}

export function isGoonCompatibilityModelReplacement(goon: GoonRecord, updates: Partial<GoonRecord>) {
  if (!updates.files || typeof updates.files !== 'object' || Array.isArray(updates.files)) return false
  const nextGuided = Object.hasOwn(updates, 'guidedAvatar') ? updates.guidedAvatar : goon.guidedAvatar
  return (goon.files?.vrm?.url ?? '') !== (updates.files.vrm?.url ?? '') ||
    (goon.files?.vrmPending?.url ?? '') !== (updates.files.vrmPending?.url ?? '') ||
    (goon.guidedAvatar?.manifest?.url ?? '') !== (nextGuided?.manifest?.url ?? '')
}

/** Capture only fields consumed by the existing animation planner and loader. */
export function captureGoonCompatibilitySources(goons: readonly GoonRecord[], shared: readonly GoonFileRef[]) {
  if (!Array.isArray(goons) || !Array.isArray(shared)) throw new Error('Compatibility analysis needs a complete motion inventory.')
  if (goons.length > MAX_COMPATIBILITY_GOONS) throw new Error('Compatibility analysis is unavailable for this Goon inventory.')
  const owner = goons[0]?.user_id ?? null
  if (goons.length > 0 && (typeof owner !== 'string' || !owner)) throw new Error('Compatibility analysis needs an authenticated Goon inventory.')
  const seen = new Set<string>()
  let motionCount = shared.length
  if (motionCount > MAX_COMPATIBILITY_MOTIONS) throw new Error('Compatibility analysis is unavailable for this motion inventory.')
  const sources = goons.map((goon) => {
    if (!goon.id || seen.has(goon.id) || goon.user_id !== owner) throw new Error('Compatibility analysis needs a complete Goon inventory.')
    seen.add(goon.id)
    if (goon.files != null && (typeof goon.files !== 'object' || Array.isArray(goon.files))) {
      throw new Error('Compatibility analysis needs a valid motion inventory.')
    }
    const files = goon.files?.animations ?? []
    if (!Array.isArray(files)) throw new Error('Compatibility analysis needs a valid motion inventory.')
    motionCount += files.length
    if (motionCount > MAX_COMPATIBILITY_MOTIONS) throw new Error('Compatibility analysis is unavailable for this motion inventory.')
    if (!isValidGoonMotionSources(goon)) throw new Error('Compatibility analysis needs a valid motion inventory.')
    return { id: goon.id, animations: files.map(motionIdentity) }
  })
  return {
    sources: {
      owner,
      shared: shared.map(motionIdentity),
      goons: sources.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    },
    goonOrder: goons.map((goon) => goon.id)
  }
}

export function captureGoonCompatibilityBasis(
  target: GoonRecord,
  goons: readonly GoonRecord[],
  shared: readonly GoonFileRef[],
  plan: GoonAnimationLoadPlan
) {
  const captured = captureGoonCompatibilitySources(goons, shared)
  if (!captured.goonOrder.includes(target.id)) throw new Error('Compatibility analysis needs the current Goon inventory.')
  const basis = {
    model: compatibilityModelBasis(target),
    sources: captured.sources,
    // The Dock's current ordering is part of the produced plan, but not of
    // the underlying source inventory used to qualify a saved report.
    goonOrder: captured.goonOrder,
    plan: {
      eager: plan.eager.map(motionIdentity),
      deferred: plan.deferred.map(motionIdentity)
    }
  }
  if (new TextEncoder().encode(canonicalRecipeString(basis)).byteLength > MAX_COMPATIBILITY_BASIS_BYTES) {
    throw new Error('Compatibility analysis is unavailable for this motion inventory.')
  }
  return basis
}

export type GoonCompatibilityBasis = ReturnType<typeof captureGoonCompatibilityBasis>
export type GoonCompatibilitySources = ReturnType<typeof captureGoonCompatibilitySources>['sources']

export function preserveSavedMotionOption<T extends { name: string; label: string; sourceLabel?: string | null; disabled?: boolean }>(
  options: T[], name?: string | null
) {
  if (!name || options.some((option) => option.name === name)) return options
  return [...options, { name, label: name, sourceLabel: 'Saved · unverified', disabled: true }]
}

export function compatibilitySourcesSha256(sources: GoonCompatibilitySources) {
  const canonical = canonicalRecipeString(sources)
  if (new TextEncoder().encode(canonical).byteLength > MAX_COMPATIBILITY_BASIS_BYTES) {
    throw new Error('Compatibility analysis is unavailable for this motion inventory.')
  }
  return sha256Hex(canonical)
}

export function compatibilityOwnerForBasis(basis: GoonCompatibilityBasis): GoonCompatibilityOwner {
  return {
    contract: 'goon-compatibility-owner/v1',
    modelIdentitySha256: sha256Hex(canonicalRecipeString(basis.model)),
    motionSourcesSha256: compatibilitySourcesSha256(basis.sources),
    motionPlanSha256: sha256Hex(canonicalRecipeString(basis.plan))
  }
}

export function isCurrentGoonCompatibilityReport(
  owner: GoonCompatibilityOwner | null | undefined,
  goon: GoonRecord,
  sourcesSha256: string | null
) {
  if (!owner || owner.contract !== 'goon-compatibility-owner/v1' || !sourcesSha256) return false
  return owner.modelIdentitySha256 === sha256Hex(canonicalRecipeString(compatibilityModelBasis(goon))) &&
    owner.motionSourcesSha256 === sourcesSha256
}

/** Plan order is producer provenance; Settings compares model and confirmed sources. */
export function isCurrentGoonCompatibilityOwner(
  owner: GoonCompatibilityOwner | null | undefined,
  basis: GoonCompatibilityBasis
) {
  if (!owner || owner.contract !== 'goon-compatibility-owner/v1') return false
  const current = compatibilityOwnerForBasis(basis)
  return owner.modelIdentitySha256 === current.modelIdentitySha256 &&
    owner.motionSourcesSha256 === current.motionSourcesSha256
}

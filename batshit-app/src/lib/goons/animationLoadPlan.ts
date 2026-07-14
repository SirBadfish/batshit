import type { GoonFileRef } from '$lib/types/goons'

export type GoonAnimationLoadPlan = {
  eager: GoonFileRef[]
  deferred: GoonFileRef[]
}

export type GoonAnimationLoadPlanOptions = {
  maxLibraryBytes?: number
  maxLibraryFiles?: number
  maxGoonBytes?: number
  maxGoonFiles?: number
  priorityNames?: string[]
}

const DEFAULT_MAX_LIBRARY_BYTES = 5_000_000
const DEFAULT_MAX_LIBRARY_FILES = 6
const DEFAULT_MAX_GOON_BYTES = 2_500_000
const DEFAULT_MAX_GOON_FILES = 4
export const GOON_STAND_POSE_FALLBACK_NAMES = [
  'base_stand_pose',
  'pose_stand',
  'stand_pose',
  'base_stand'
] as const
export const GOON_BASE_POSE_FALLBACK_NAMES = [
  ...GOON_STAND_POSE_FALLBACK_NAMES,
  'base_sit_pose',
  'pose_sit',
  'sit_pose',
  'base_sit',
  'base_lay_pose',
  'pose_lay',
  'lay_pose',
  'base_lay'
] as const

function fileKey(file: GoonFileRef | null | undefined) {
  if (!file) return ''
  return file.url || file.filename || ''
}

// Per-lane clip binding: VRM goons consume .vrma library entries, GLB-lane
// custom goons consume .glb/.gltf entries that target their skeleton by name.
// The dock and Goon Settings must resolve lanes through these helpers so both
// surfaces always agree on which clips belong to which lane.
export type GoonMotionLane = 'vrm' | 'glb'

export function isGlbAnimationFileRef(file: GoonFileRef | null | undefined) {
  if (!file) return false
  // The stored asset's filename/url is the authoritative format signal;
  // originalName is only a last resort — converted entries keep the source
  // upload's name there (e.g. FBX-sourced VRMAs carry originalName "*.fbx",
  // and worker-retargeted GLBs will too), which says nothing about the lane.
  const label = (file.filename || file.url || file.originalName || '').toLowerCase()
  return label.endsWith('.glb') || label.endsWith('.gltf')
}

export function resolveGoonMotionLane(file: GoonFileRef | null | undefined): GoonMotionLane {
  return isGlbAnimationFileRef(file) ? 'glb' : 'vrm'
}

export function filterGoonAnimationFilesForLane(
  files: GoonFileRef[] | null | undefined,
  lane: GoonMotionLane
): GoonFileRef[] {
  if (!Array.isArray(files)) return []
  return files.filter((file) => resolveGoonMotionLane(file) === lane)
}

// Unified motion library pairing (Settings/UX concept — runtime lanes stay
// strict). Files pair when their sanitized base names match, which is the
// exact name contract cues and engine clip registration already use, so a
// paired card's name resolves on both lanes by construction.
export type UnifiedGoonMotionEntry = {
  /** Sanitized base name — the pair key and the runtime animation name. */
  name: string
  /** Every library file sharing the pair key, input order preserved. */
  files: GoonFileRef[]
  /** First VRM-lane file, if any. */
  vrma: GoonFileRef | null
  /** First GLB-lane file, if any. */
  glb: GoonFileRef | null
  /** Metadata winner — the file whose displayName/tags/motionMeta the card shows. */
  primary: GoonFileRef
}

function parseTimestamp(value: string | undefined) {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

function hasAuthoredMotionMetadata(file: GoonFileRef) {
  return Boolean(
    (file.displayName && file.displayName.trim()) ||
      (Array.isArray(file.tags) && file.tags.length > 0) ||
      (file.motionMeta && Object.keys(file.motionMeta).length > 0)
  )
}

// Winner rule for pre-pairing divergence: an explicit edit stamp beats
// everything, then a side that actually has authored metadata beats an empty
// side, then the newer upload, then the VRM lane for stability.
export function resolveGoonMotionMetadataWinner(files: GoonFileRef[]): GoonFileRef {
  if (files.length === 1) return files[0]

  const stamped = files.filter((file) => parseTimestamp(file.metaUpdatedAt) > 0)
  const pool =
    stamped.length > 0
      ? stamped
      : files.some(hasAuthoredMotionMetadata)
        ? files.filter(hasAuthoredMotionMetadata)
        : files

  let winner = pool[0]
  for (const file of pool.slice(1)) {
    const winnerScore = parseTimestamp(winner.metaUpdatedAt) || parseTimestamp(winner.uploadedAt)
    const fileScore = parseTimestamp(file.metaUpdatedAt) || parseTimestamp(file.uploadedAt)
    if (
      fileScore > winnerScore ||
      (fileScore === winnerScore &&
        resolveGoonMotionLane(file) === 'vrm' &&
        resolveGoonMotionLane(winner) === 'glb')
    ) {
      winner = file
    }
  }
  return winner
}

export function groupGoonMotionLibraryEntries(
  files: GoonFileRef[] | null | undefined
): UnifiedGoonMotionEntry[] {
  if (!Array.isArray(files) || files.length === 0) return []

  const buckets = new Map<string, GoonFileRef[]>()
  for (const file of files) {
    if (!file) continue
    const name = resolveGoonAnimationName(file, file.filename || file.url || '')
    if (!name) continue
    const bucket = buckets.get(name) ?? []
    bucket.push(file)
    buckets.set(name, bucket)
  }

  const entries: UnifiedGoonMotionEntry[] = []
  for (const [name, bucketFiles] of buckets) {
    entries.push({
      name,
      files: bucketFiles,
      vrma: bucketFiles.find((file) => resolveGoonMotionLane(file) === 'vrm') ?? null,
      glb: bucketFiles.find((file) => resolveGoonMotionLane(file) === 'glb') ?? null,
      primary: resolveGoonMotionMetadataWinner(bucketFiles)
    })
  }
  return entries
}

export function sanitizeGoonAnimationName(value: string, fallback = '') {
  const base = value.replace(/\.[^/.]+$/, '')
  const safe = base
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return safe || fallback
}

export function resolveGoonAnimationName(file: GoonFileRef | null | undefined, fallback = '') {
  if (!file) return fallback
  const label = file.originalName || file.filename || ''
  return sanitizeGoonAnimationName(label, fallback)
}

function resolveAnimationName(file: GoonFileRef | null | undefined) {
  return resolveGoonAnimationName(file)
}

export function buildGoonAnimationPriorityNames(primaryName?: string | null) {
  return Array.from(new Set([primaryName, ...GOON_BASE_POSE_FALLBACK_NAMES])).filter(
    Boolean
  ) as string[]
}

function isPriorityPose(
  file: GoonFileRef | null | undefined,
  prioritySet: Set<string>,
  prioritySetLower: Set<string>
) {
  if (!file) return false
  const name = resolveAnimationName(file)
  const loweredName = name.toLowerCase()
  if (prioritySet.has(name) || prioritySetLower.has(loweredName)) {
    return true
  }
  const label = `${file.originalName || ''} ${file.filename || ''}`.toLowerCase()
  if (!label) return false
  return (
    /base[_-]?(stand|sit|lay)/.test(label) ||
    /pose[_-]?(stand|sit|lay)/.test(label)
  )
}

function resolveSize(file: GoonFileRef, fallback: number) {
  if (!file) return fallback
  const size = file.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return fallback
  return size
}

function partitionBySize(
  files: GoonFileRef[],
  maxBytes: number,
  maxFiles: number
): { eager: GoonFileRef[]; deferred: GoonFileRef[] } {
  if (!Array.isArray(files) || files.length === 0) {
    return { eager: [], deferred: [] }
  }

  const fallbackSize =
    Number.isFinite(maxBytes) && maxBytes > 0 && Number.isFinite(maxFiles) && maxFiles > 0
      ? Math.max(1, Math.floor(maxBytes / maxFiles))
      : 1

  const sorted = [...files].sort((a, b) => resolveSize(a, fallbackSize) - resolveSize(b, fallbackSize))

  const eager: GoonFileRef[] = []
  const deferred: GoonFileRef[] = []
  let byteBudget = Math.max(0, maxBytes)

  for (const file of sorted) {
    if (!file) continue
    if (eager.length >= maxFiles) {
      deferred.push(file)
      continue
    }
    const size = resolveSize(file, fallbackSize)
    if (eager.length === 0 || size <= byteBudget) {
      eager.push(file)
      byteBudget = Math.max(0, byteBudget - size)
    } else {
      deferred.push(file)
    }
  }

  return { eager, deferred }
}

function dedupeFiles(files: GoonFileRef[], seen: Set<string>) {
  const result: GoonFileRef[] = []
  for (const file of files) {
    const key = fileKey(file)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(file)
  }
  return result
}

export function buildGoonAnimationLoadPlan(
  libraryFiles: GoonFileRef[] = [],
  goonFiles: GoonFileRef[] = [],
  options: GoonAnimationLoadPlanOptions = {}
): GoonAnimationLoadPlan {
  const {
    maxLibraryBytes = DEFAULT_MAX_LIBRARY_BYTES,
    maxLibraryFiles = DEFAULT_MAX_LIBRARY_FILES,
    maxGoonBytes = DEFAULT_MAX_GOON_BYTES,
    maxGoonFiles = DEFAULT_MAX_GOON_FILES,
    priorityNames = []
  } = options

  const trimmedPriority = priorityNames.map((name) => name.trim()).filter(Boolean)
  const prioritySet = new Set(trimmedPriority)
  const prioritySetLower = new Set(trimmedPriority.map((name) => name.toLowerCase()))
  const priority = dedupeFiles(
    [...libraryFiles, ...goonFiles].filter((file) =>
      isPriorityPose(file, prioritySet, prioritySetLower)
    ),
    new Set()
  )
  const priorityKeys = new Set(priority.map((file) => fileKey(file)))

  const libraryPlan = partitionBySize(
    libraryFiles.filter((file) => !priorityKeys.has(fileKey(file))),
    maxLibraryBytes,
    maxLibraryFiles
  )
  const goonPlan = partitionBySize(
    goonFiles.filter((file) => !priorityKeys.has(fileKey(file))),
    maxGoonBytes,
    maxGoonFiles
  )

  const seen = new Set<string>()
  const eager = dedupeFiles([...priority, ...libraryPlan.eager, ...goonPlan.eager], seen)
  const deferred = dedupeFiles([...libraryPlan.deferred, ...goonPlan.deferred], seen)

  return { eager, deferred }
}

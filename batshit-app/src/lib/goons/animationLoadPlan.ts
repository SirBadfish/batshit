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

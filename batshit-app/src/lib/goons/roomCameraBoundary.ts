import type { GoonSceneCameraBoundary } from '$lib/types/goons'

export type NormalizedGoonSceneCameraBoundary = {
  center: [number, number, number]
  size: [number, number, number]
  rotationY: number
}

const MIN_BOUNDARY_SIZE = 0.1
const MAX_BOUNDARY_SIZE = 10_000

function normalizeFinite(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeSize(value: unknown) {
  return Math.min(
    MAX_BOUNDARY_SIZE,
    Math.max(MIN_BOUNDARY_SIZE, normalizeFinite(value, MIN_BOUNDARY_SIZE))
  )
}

export function normalizeRoomCameraBoundary(
  boundary?: GoonSceneCameraBoundary | null
): NormalizedGoonSceneCameraBoundary | null {
  if (!boundary || !Array.isArray(boundary.center) || !Array.isArray(boundary.size)) {
    return null
  }
  return {
    center: [
      normalizeFinite(boundary.center[0]),
      normalizeFinite(boundary.center[1]),
      normalizeFinite(boundary.center[2])
    ],
    size: [
      normalizeSize(boundary.size[0]),
      normalizeSize(boundary.size[1]),
      normalizeSize(boundary.size[2])
    ],
    rotationY: normalizeFinite(boundary.rotationY)
  }
}

export function createRoomCameraBoundaryFromExtents(extents: {
  min: [number, number, number]
  max: [number, number, number]
}): NormalizedGoonSceneCameraBoundary | null {
  const min = extents.min
  const max = extents.max
  if (![...min, ...max].every(Number.isFinite)) return null
  const size: [number, number, number] = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2]
  ]
  if (size.some((value) => value < MIN_BOUNDARY_SIZE)) return null
  return {
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2
    ],
    size,
    rotationY: 0
  }
}

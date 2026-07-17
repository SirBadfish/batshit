import type { BufferGeometry } from 'three'

export const DEFAULT_GROUND_PROJECTION_LINE = 0.5
export const MIN_GROUND_PROJECTION_LINE = 0.25
export const MAX_GROUND_PROJECTION_LINE = 0.75

export function normalizeGroundProjectionLine(value?: number | null) {
  if (!Number.isFinite(value)) return DEFAULT_GROUND_PROJECTION_LINE
  return Math.min(
    MAX_GROUND_PROJECTION_LINE,
    Math.max(MIN_GROUND_PROJECTION_LINE, Number(value))
  )
}

/**
 * Maps a canonical sphere UV latitude to a selected image-space row while
 * keeping both poles fixed. `sourceLine` is measured from the top of the image,
 * so the corresponding Three UV latitude is `1 - sourceLine`.
 */
export function remapGroundProjectionUvY(uvY: number, sourceLine?: number | null) {
  const normalizedLine = normalizeGroundProjectionLine(sourceLine)
  const sourceUvY = 1 - normalizedLine
  if (uvY <= 0.5) {
    return uvY * (sourceUvY / 0.5)
  }
  return sourceUvY + (uvY - 0.5) * ((1 - sourceUvY) / 0.5)
}

export function applyGroundProjectionLineToGeometry(
  geometry: BufferGeometry,
  sourceLine?: number | null
) {
  const uv = geometry.getAttribute('uv')
  if (!uv) return false

  for (let index = 0; index < uv.count; index += 1) {
    uv.setY(index, remapGroundProjectionUvY(uv.getY(index), sourceLine))
  }
  uv.needsUpdate = true
  return true
}

export function reapplyGroundProjectionLineToGeometry(
  geometry: BufferGeometry,
  canonicalUv: ArrayLike<number>,
  sourceLine?: number | null
) {
  const uv = geometry.getAttribute('uv')
  if (!uv || uv.array.length !== canonicalUv.length) return false
  ;(uv.array as Float32Array).set(canonicalUv)
  return applyGroundProjectionLineToGeometry(geometry, sourceLine)
}

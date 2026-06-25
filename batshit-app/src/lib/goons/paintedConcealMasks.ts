import type { GoonPaintedConcealMask, GoonPaintedConcealMeshMask } from '$lib/types/goons'

export function normalizePaintedTriangleIndices(indices: number[] | null | undefined, maxExclusive?: number) {
  return [...new Set(indices ?? [])]
    .filter((index) => {
      if (!Number.isInteger(index) || index < 0) return false
      return typeof maxExclusive === 'number' ? index < maxExclusive : true
    })
    .sort((a, b) => a - b)
}

export function compressPaintedTriangleRanges(indices: number[] | null | undefined): Array<[number, number]> {
  const normalized = normalizePaintedTriangleIndices(indices)
  const ranges: Array<[number, number]> = []
  let start: number | null = null
  let previous: number | null = null

  for (const index of normalized) {
    if (start === null || previous === null) {
      start = index
      previous = index
      continue
    }
    if (index === previous + 1) {
      previous = index
      continue
    }
    ranges.push([start, previous])
    start = index
    previous = index
  }

  if (start !== null && previous !== null) {
    ranges.push([start, previous])
  }

  return ranges
}

export function expandPaintedTriangleRanges(
  ranges: Array<[number, number]> | null | undefined,
  maxExclusive?: number
) {
  const indices: number[] = []
  for (const range of ranges ?? []) {
    const start = Math.max(0, Math.floor(range[0] ?? 0))
    const end = Math.max(start, Math.floor(range[1] ?? start))
    for (let index = start; index <= end; index += 1) {
      indices.push(index)
    }
  }
  return normalizePaintedTriangleIndices(indices, maxExclusive)
}

export function countPaintedConcealTriangles(mask?: GoonPaintedConcealMask | null) {
  return (mask?.meshes ?? []).reduce(
    (total, mesh) => total + expandPaintedTriangleRanges(mesh.triangleRanges, mesh.triangleCount).length,
    0
  )
}

export function normalizePaintedConcealMeshMask(
  meshMask: GoonPaintedConcealMeshMask | null | undefined
): GoonPaintedConcealMeshMask | null {
  const mesh = meshMask?.mesh?.trim()
  const topologySignature = meshMask?.topologySignature?.trim()
  const triangleCount = Math.max(0, Math.floor(meshMask?.triangleCount ?? 0))
  const vertexCount = Math.max(0, Math.floor(meshMask?.vertexCount ?? 0))
  if (!mesh || !topologySignature || triangleCount <= 0 || vertexCount <= 0) return null

  const triangleRanges = compressPaintedTriangleRanges(
    expandPaintedTriangleRanges(meshMask?.triangleRanges, triangleCount)
  )
  if (triangleRanges.length === 0) return null

  return {
    mesh,
    topologySignature,
    triangleCount,
    vertexCount,
    triangleRanges
  }
}

export function normalizePaintedConcealMask(
  mask: GoonPaintedConcealMask | null | undefined
): GoonPaintedConcealMask | undefined {
  const topologySignature = mask?.topologySignature?.trim()
  if (mask?.version !== 1 || !topologySignature) return undefined

  const meshes = (mask.meshes ?? [])
    .map((meshMask) => normalizePaintedConcealMeshMask(meshMask))
    .filter((meshMask): meshMask is GoonPaintedConcealMeshMask => Boolean(meshMask))
    .sort((left, right) => left.mesh.localeCompare(right.mesh))

  if (meshes.length === 0) return undefined

  const updatedAt = mask.updatedAt?.trim()
  return {
    version: 1,
    topologySignature,
    meshes,
    ...(updatedAt ? { updatedAt } : {})
  }
}

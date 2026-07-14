import * as THREE from 'three'

export type StandingSurfaceProbeOptions = {
  objects: THREE.Object3D[]
  x: number
  z: number
  minY: number
  maxY: number
  clearance?: number
  minNormalY?: number
}

export type NearestStandingSurfaceProbeOptions = StandingSurfaceProbeOptions & {
  targetY: number
}

function resolveIntersectionNormalY(intersection: THREE.Intersection<THREE.Object3D>) {
  if (!intersection.face) return null
  const normal = intersection.face.normal.clone()
  normal.transformDirection(intersection.object.matrixWorld)
  return normal.y
}

export function probeStandingSurfaceY({
  objects,
  x,
  z,
  minY,
  maxY,
  clearance = 0.01,
  minNormalY = 0.35
}: StandingSurfaceProbeOptions): number | null {
  if (!objects.length) return null
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) return null

  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(x, maxY, z),
    new THREE.Vector3(0, -1, 0),
    0,
    maxY - minY
  )

  let bestY: number | null = null

  for (const object of objects) {
    const intersections = raycaster.intersectObject(object, true)
    for (const intersection of intersections) {
      const normalY = resolveIntersectionNormalY(intersection)
      if (normalY !== null && normalY < minNormalY) continue
      const candidateY = intersection.point.y + clearance
      if (candidateY < minY - clearance) continue
      if (bestY === null || candidateY > bestY) {
        bestY = candidateY
      }
    }
  }

  return bestY
}

/**
 * Finds the walkable horizontal hit closest to a target height. This is used
 * for explicit Room Shell floor alignment, where choosing the highest hit can
 * incorrectly select a ceiling or baked-in furnishing.
 */
export function probeNearestStandingSurfaceY({
  objects,
  x,
  z,
  minY,
  maxY,
  targetY,
  clearance = 0,
  minNormalY = 0.8
}: NearestStandingSurfaceProbeOptions): number | null {
  if (!objects.length) return null
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) return null
  if (!Number.isFinite(targetY)) return null

  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(x, maxY, z),
    new THREE.Vector3(0, -1, 0),
    0,
    maxY - minY
  )

  let bestY: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const object of objects) {
    const intersections = raycaster.intersectObject(object, true)
    for (const intersection of intersections) {
      const normalY = resolveIntersectionNormalY(intersection)
      if (normalY !== null && normalY < minNormalY) continue
      const candidateY = intersection.point.y + clearance
      if (candidateY < minY - clearance) continue
      const distance = Math.abs(candidateY - targetY)
      if (distance < bestDistance) {
        bestDistance = distance
        bestY = candidateY
      }
    }
  }

  return bestY
}

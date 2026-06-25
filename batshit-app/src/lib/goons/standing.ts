export type StandingPoint = {
  x: number
  z: number
}

export type StandingBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export type StandingSearchOptions = {
  desired: StandingPoint
  bounds?: StandingBounds | null
  isBlocked: (point: StandingPoint) => boolean
  step?: number
  directions?: number
  maxRadius?: number
}

function clampPoint(point: StandingPoint, bounds?: StandingBounds | null): StandingPoint {
  if (!bounds) return point
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, point.x)),
    z: Math.min(bounds.maxZ, Math.max(bounds.minZ, point.z))
  }
}

function resolveSearchRadius(bounds?: StandingBounds | null, explicitMaxRadius?: number) {
  if (typeof explicitMaxRadius === 'number' && explicitMaxRadius > 0) return explicitMaxRadius
  if (!bounds) return 4
  const spanX = Math.max(0, bounds.maxX - bounds.minX)
  const spanZ = Math.max(0, bounds.maxZ - bounds.minZ)
  return Math.max(1, Math.sqrt(spanX * spanX + spanZ * spanZ))
}

function buildPointKey(point: StandingPoint) {
  return `${point.x.toFixed(3)}:${point.z.toFixed(3)}`
}

function findGridFallback(
  desired: StandingPoint,
  bounds: StandingBounds,
  step: number,
  isBlocked: (point: StandingPoint) => boolean
): StandingPoint | null {
  const points: Array<{ point: StandingPoint; distanceSq: number }> = []
  for (let x = bounds.minX; x <= bounds.maxX + step * 0.5; x += step) {
    for (let z = bounds.minZ; z <= bounds.maxZ + step * 0.5; z += step) {
      const point = clampPoint({ x, z }, bounds)
      points.push({
        point,
        distanceSq: (point.x - desired.x) ** 2 + (point.z - desired.z) ** 2
      })
    }
  }
  points.sort((a, b) => a.distanceSq - b.distanceSq)
  for (const entry of points) {
    if (!isBlocked(entry.point)) return entry.point
  }
  return null
}

export function findNearestValidStandingPoint({
  desired,
  bounds,
  isBlocked,
  step = 0.16,
  directions = 24,
  maxRadius
}: StandingSearchOptions): StandingPoint | null {
  const clampedDesired = clampPoint(desired, bounds)
  if (!isBlocked(clampedDesired)) {
    return clampedDesired
  }

  const visited = new Set<string>([buildPointKey(clampedDesired)])
  const limit = resolveSearchRadius(bounds, maxRadius)

  for (let radius = step; radius <= limit + step * 0.5; radius += step) {
    let bestCandidate: StandingPoint | null = null
    let bestDistanceSq = Number.POSITIVE_INFINITY

    for (let index = 0; index < directions; index += 1) {
      const angle = (Math.PI * 2 * index) / directions
      const candidate = clampPoint(
        {
          x: desired.x + Math.cos(angle) * radius,
          z: desired.z + Math.sin(angle) * radius
        },
        bounds
      )
      const key = buildPointKey(candidate)
      if (visited.has(key)) continue
      visited.add(key)
      if (isBlocked(candidate)) continue
      const distanceSq = (candidate.x - desired.x) ** 2 + (candidate.z - desired.z) ** 2
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq
        bestCandidate = candidate
      }
    }

    if (bestCandidate) return bestCandidate
  }

  if (bounds) {
    return findGridFallback(desired, bounds, step, isBlocked)
  }

  return null
}

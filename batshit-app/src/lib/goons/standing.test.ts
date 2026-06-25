import { describe, expect, it } from 'vitest'

import { findNearestValidStandingPoint, type StandingPoint } from '$lib/goons/standing'

type Rect = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function pointInRects(point: StandingPoint, rects: Rect[]) {
  return rects.some(
    (rect) =>
      point.x >= rect.minX &&
      point.x <= rect.maxX &&
      point.z >= rect.minZ &&
      point.z <= rect.maxZ
  )
}

describe('standing placement search', () => {
  it('keeps the desired point when the floor spot is already valid', () => {
    const point = findNearestValidStandingPoint({
      desired: { x: 1, z: -0.5 },
      bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
      isBlocked: () => false
    })

    expect(point).toEqual({ x: 1, z: -0.5 })
  })

  it('moves a blocked stand point to the nearest free area inside the room', () => {
    const blockers: Rect[] = [{ minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 }]

    const point = findNearestValidStandingPoint({
      desired: { x: 0, z: 0 },
      bounds: { minX: -3, maxX: 3, minZ: -3, maxZ: 3 },
      isBlocked: (candidate) => pointInRects(candidate, blockers),
      step: 0.1,
      directions: 32
    })

    expect(point).not.toBeNull()
    expect(pointInRects(point!, blockers)).toBe(false)
    expect(point!.x ** 2 + point!.z ** 2).toBeGreaterThan(0)
  })

  it('falls back to another open room area if the first search ring is crowded', () => {
    const blockers: Rect[] = [
      { minX: -0.6, maxX: 0.6, minZ: -0.6, maxZ: 0.6 },
      { minX: 0.7, maxX: 1.5, minZ: -0.4, maxZ: 0.4 },
      { minX: -1.5, maxX: -0.7, minZ: -0.4, maxZ: 0.4 }
    ]

    const point = findNearestValidStandingPoint({
      desired: { x: 0, z: 0 },
      bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
      isBlocked: (candidate) => pointInRects(candidate, blockers),
      step: 0.1,
      directions: 24
    })

    expect(point).not.toBeNull()
    expect(pointInRects(point!, blockers)).toBe(false)
    expect(point!.z).not.toBe(0)
  })
})

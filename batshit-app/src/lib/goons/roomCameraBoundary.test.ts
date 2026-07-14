import { describe, expect, it } from 'vitest'

import {
  createRoomCameraBoundaryFromExtents,
  normalizeRoomCameraBoundary
} from '$lib/goons/roomCameraBoundary'

describe('roomCameraBoundary', () => {
  it('normalizes finite saved camera boundary values', () => {
    expect(normalizeRoomCameraBoundary({
      center: [1, Number.NaN, 3],
      size: [4, 0, 6],
      rotationY: Number.POSITIVE_INFINITY
    })).toEqual({
      center: [1, 0, 3],
      size: [4, 0.1, 6],
      rotationY: 0
    })
  })

  it('creates a centered boundary from valid extents', () => {
    expect(createRoomCameraBoundaryFromExtents({
      min: [-4, 0, -3],
      max: [4, 4, 3]
    })).toEqual({
      center: [0, 2, 0],
      size: [8, 4, 6],
      rotationY: 0
    })
  })
})

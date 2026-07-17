import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ROOM_SHELL_TRANSFORM,
  isIdentityRoomShellTransform,
  normalizeRoomShellTransform
} from '$lib/goons/roomShellTransform'

describe('room shell transform', () => {
  it('normalizes missing and invalid values to identity', () => {
    expect(normalizeRoomShellTransform()).toEqual(DEFAULT_ROOM_SHELL_TRANSFORM)
    expect(
      normalizeRoomShellTransform({
        position: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        rotationY: Number.NaN,
        uniformScale: Number.NaN
      })
    ).toEqual(DEFAULT_ROOM_SHELL_TRANSFORM)
  })

  it('clamps scale and offsets and normalizes Y rotation', () => {
    const normalized = normalizeRoomShellTransform({
      position: [2000, -2000, 2.5],
      rotationY: Math.PI * 3,
      uniformScale: 40
    })

    expect(normalized.position).toEqual([1000, -1000, 2.5])
    expect(normalized.rotationY).toBeCloseTo(-Math.PI, 6)
    expect(normalized.uniformScale).toBe(20)
  })

  it('recognizes missing and explicit identity transforms', () => {
    expect(isIdentityRoomShellTransform()).toBe(true)
    expect(
      isIdentityRoomShellTransform({
        position: [0, 0, 0],
        rotationY: 0,
        uniformScale: 1
      })
    ).toBe(true)
    expect(isIdentityRoomShellTransform({ uniformScale: 1.25 })).toBe(false)
  })
})

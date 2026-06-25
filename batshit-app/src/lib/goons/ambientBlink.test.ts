import { describe, expect, it } from 'vitest'

import {
  AMBIENT_BLINK_INTERVAL_MIN_MS,
  createAmbientBlinkState,
  resolveAmbientBlinkWeight,
  updateAmbientBlinkState
} from '$lib/goons/ambientBlink'

function createDeterministicRandom(values: number[]) {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0
    index += 1
    return value
  }
}

describe('ambient blinking', () => {
  it('schedules the first blink into the future', () => {
    const random = createDeterministicRandom([0])
    const state = createAmbientBlinkState(1000, random)

    expect(state.activeBlink).toBeNull()
    expect(state.nextBlinkAt).toBe(1000 + AMBIENT_BLINK_INTERVAL_MIN_MS)
  })

  it('produces a blink pulse after the scheduled time', () => {
    const random = createDeterministicRandom([0, 0.5, 0.5, 0])
    let state = createAmbientBlinkState(0, random)

    let result = updateAmbientBlinkState(state, state.nextBlinkAt, { random })
    state = result.state
    expect(result.weight).toBe(0)
    expect(state.activeBlink).not.toBeNull()

    result = updateAmbientBlinkState(state, state.activeBlink!.startedAt + state.activeBlink!.durationMs / 2, {
      random
    })
    state = result.state
    expect(result.weight).toBeGreaterThan(0.9)

    result = updateAmbientBlinkState(state, state.activeBlink!.startedAt + state.activeBlink!.durationMs + 1, {
      random
    })
    expect(result.weight).toBe(0)
    expect(result.state.activeBlink).toBeNull()
    expect(result.state.nextBlinkAt).toBeGreaterThan(state.activeBlink!.startedAt)
  })

  it('backs off and reschedules when authored eyelid closure suppresses ambient blinking', () => {
    const random = createDeterministicRandom([0, 0, 0.5])
    const state = createAmbientBlinkState(0, random)
    const result = updateAmbientBlinkState(state, state.nextBlinkAt + 5, { canBlink: false, random })

    expect(result.weight).toBe(0)
    expect(result.state.activeBlink).toBeNull()
    expect(result.state.nextBlinkAt).toBeGreaterThan(state.nextBlinkAt)
  })

  it('uses a smooth pulse shape for the blink weight', () => {
    expect(resolveAmbientBlinkWeight(0)).toBe(0)
    expect(resolveAmbientBlinkWeight(0.5)).toBeCloseTo(1, 5)
    expect(resolveAmbientBlinkWeight(1)).toBe(0)
  })
})

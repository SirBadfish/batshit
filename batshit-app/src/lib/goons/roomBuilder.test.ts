import { describe, expect, it } from 'vitest'

import {
  ROOM_DEFAULT_HEIGHT,
  ROOM_HEIGHT_PRESET_SPECS,
  ROOM_HEIGHT_PRESET_VALUES,
  ROOM_MIN_HEIGHT,
  roomHeightToPercent,
  roomHeightToPresetValue,
  roomPresetValueToHeight
} from '$lib/goons/roomBuilder'

describe('roomBuilder height preset helpers', () => {
  it('treats the lowered default builder ceiling as 100%', () => {
    expect(roomHeightToPercent(ROOM_DEFAULT_HEIGHT)).toBe(100)
    expect(roomHeightToPresetValue(ROOM_DEFAULT_HEIGHT)).toBe(100)
  })

  it('maps the 50% preset to half of the default ceiling', () => {
    expect(roomPresetValueToHeight(50)).toBe(ROOM_MIN_HEIGHT)
    expect(roomHeightToPercent(ROOM_MIN_HEIGHT)).toBe(50)
  })

  it('round-trips the 75% preset correctly', () => {
    const height = roomPresetValueToHeight(75)

    expect(roomHeightToPercent(height)).toBe(75)
    expect(roomHeightToPresetValue(height)).toBe(75)
  })

  it('exposes exact ideal wall specs for each preset', () => {
    expect(ROOM_HEIGHT_PRESET_VALUES).toEqual([100, 75, 50])
    expect(ROOM_HEIGHT_PRESET_SPECS[100]).toBe('2048x1200')
    expect(ROOM_HEIGHT_PRESET_SPECS[75]).toBe('2048x900')
    expect(ROOM_HEIGHT_PRESET_SPECS[50]).toBe('2048x600')
  })
})

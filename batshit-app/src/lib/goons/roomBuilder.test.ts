import { describe, expect, it } from 'vitest'

import {
  ROOM_DEFAULT_HEIGHT,
  ROOM_HEIGHT_PRESET_SPECS,
  ROOM_HEIGHT_PRESET_VALUES,
  ROOM_MIN_HEIGHT,
  normalizeRoomShellBuilder,
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

  it('normalizes exterior aprons with floor texture defaults', () => {
    const floorTexture = { url: '/floor.png', filename: 'floor.png' }
    const builder = normalizeRoomShellBuilder({
      surfaces: {
        floor: {
          interior: {
            texture: floorTexture
          }
        }
      },
      exteriorAprons: {
        north: {
          enabled: true,
          depth: 8
        }
      }
    })

    expect(builder.exteriorAprons?.north?.enabled).toBe(true)
    expect(builder.exteriorAprons?.north?.depth).toBe(8)
    expect(builder.exteriorAprons?.north?.surface?.texture).toEqual(floorTexture)
    expect(builder.exteriorAprons?.south?.enabled).toBe(false)
  })

  it('normalizes terrain skirts with floor texture defaults and safe ranges', () => {
    const floorTexture = { url: '/grass.png', filename: 'grass.png' }
    const builder = normalizeRoomShellBuilder({
      surfaces: {
        floor: {
          interior: {
            texture: floorTexture
          }
        }
      },
      terrainSkirt: {
        enabled: true,
        radius: 500,
        edgeFade: -1,
        slopeAngleDeg: 120,
        projection: 'skybox-ground',
        segments: 8
      }
    })

    expect(builder.terrainSkirt?.enabled).toBe(true)
    expect(builder.terrainSkirt?.radius).toBe(240)
    expect(builder.terrainSkirt?.edgeFade).toBe(0)
    expect(builder.terrainSkirt?.slopeAngleDeg).toBe(75)
    expect(builder.terrainSkirt?.projection).toBe('skybox-ground')
    expect(builder.terrainSkirt?.segments).toBe(32)
    expect(builder.terrainSkirt?.surface?.texture).toEqual(floorTexture)
  })
})

import { describe, expect, it } from 'vitest'

import {
  mergeImportedCustomPostures,
  resolveBasePosture,
  resolveStagePostures
} from '$lib/goons/postures'
import type { GoonsSettings } from '$lib/types/goons'

const baseSettings: GoonsSettings = {
  dockOpen: false,
  showCues: false,
  immersiveMode: true,
  globalCloset: { items: {} },
  kitchen: {
    cues: {},
    emojiMap: {},
    postures: {
      floor_sit: {
        id: 'floor_sit',
        name: 'Floor Sit',
        basePosture: 'sit'
      }
    },
    scenes: {},
    roomTextures: {},
    bodyVariants: { items: {} }
  }
}

describe('goon posture helpers', () => {
  it('resolves built-in and custom stage postures together', () => {
    const postures = resolveStagePostures(baseSettings)
    expect(postures.stand?.name).toBe('Standing')
    expect(postures.floor_sit?.basePosture).toBe('sit')
  })

  it('falls back to a custom posture base posture when resolving placement family', () => {
    expect(resolveBasePosture('floor_sit', baseSettings)).toBe('sit')
    expect(resolveBasePosture('dance_break', baseSettings)).toBe('stand')
  })

  it('renames imported custom posture ids when the incoming id is already taken', () => {
    const merged = mergeImportedCustomPostures(baseSettings, [
      {
        id: 'floor_sit',
        name: 'Floor Sit (Bed)',
        basePosture: 'sit'
      }
    ])

    expect(merged.idMap.floor_sit).toBe('floor_sit_bed')
    expect(merged.postures.floor_sit_bed?.name).toBe('Floor Sit (Bed)')
    expect(merged.postures.floor_sit_bed?.basePosture).toBe('sit')
  })
})

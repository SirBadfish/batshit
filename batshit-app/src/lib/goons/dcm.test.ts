import { describe, expect, it } from 'vitest'

import { buildGoonDcmLines, shouldIncludeGoonSpokenCues } from '$lib/goons/dcm'
import type { GoonRecord, GoonsSettings } from '$lib/types/goons'

const goonsSettings: GoonsSettings = {
  dockOpen: true,
  showCues: false,
  immersiveMode: true,
  globalCloset: {
    items: {
      pants: {
        id: 'pants',
        name: 'BS-Pants-Black',
        description: 'Black graffiti sweatpants',
        category: 'bottom'
      },
      shoes: {
        id: 'shoes',
        name: 'Chucks',
        category: 'shoes'
      }
    }
  },
  kitchen: {
    cues: {
      base_stand: {
        name: 'base_stand',
        kind: 'mood',
        playback: 'loop',
        description: 'Standing idle (default)'
      },
      calm: {
        name: 'calm',
        kind: 'mood',
        playback: 'loop',
        description: 'Calm idle'
      },
      happy: {
        name: 'happy',
        kind: 'mood',
        playback: 'loop',
        description: 'Happy idle'
      },
      wave: {
        name: 'wave',
        kind: 'emote',
        playback: 'oneshot',
        description: 'Friendly wave'
      },
      shrug: {
        name: 'shrug',
        kind: 'emote',
        playback: 'oneshot',
        description: 'Shrug'
      },
      laugh: {
        name: 'laugh',
        kind: 'emote',
        playback: 'oneshot',
        description: 'Short laugh beat',
        blocking: true
      }
    },
    emojiMap: {
      '👋': 'wave'
    },
    scenes: {
      cyberpunk: {
        id: 'cyberpunk',
        name: 'Cyberpunk'
      }
    },
    roomTextures: {},
    bodyVariants: { items: {} }
  }
}

const goon: GoonRecord = {
  id: 'goon_luci',
  user_id: 'josh',
  name: 'Luci.vrm',
  files: {
    vrm: {
      url: '/goons/luci.vrm',
      filename: 'luci.vrm'
    }
  },
  cues: {
    enabled: ['base_stand', 'calm', 'happy', 'wave', 'shrug', 'laugh'],
    overrides: {},
    emojiOverrides: {}
  },
  defaults: {
    baseLoop: 'happy',
    sceneId: 'cyberpunk'
  },
  closetAssignments: {
    N00_001_01_Bottoms_01_CLOTH: {
      mode: 'item',
      itemId: 'pants'
    },
    N00_006_01_Shoes_01_CLOTH: {
      mode: 'item',
      itemId: 'shoes'
    }
  },
  created_at: '2026-03-15T00:00:00.000Z',
  updated_at: '2026-03-15T00:00:00.000Z'
}

describe('goon dcm', () => {
  it('includes the active scene and closet outfit context', () => {
    const lines = buildGoonDcmLines(goon, {}, goonsSettings)

    expect(lines.some((line) => line.startsWith('Goon: '))).toBe(false)
    expect(lines).toContain('Scene: Cyberpunk')
    expect(lines).toContain(
      'Closet outfit: Bottom: BS-Pants-Black (Black graffiti sweatpants); Shoes: Chucks'
    )
  })

  it('lists all enabled emotes without truncating the current cue set', () => {
    const lines = buildGoonDcmLines(goon, { includeSpokenCues: true }, goonsSettings)
    const emotesLine = lines.find((line) => line.startsWith('Emotes: '))
    const emojiLine = lines.find((line) => line.startsWith('Emoji triggers: '))

    expect(emotesLine).toContain('wave (Friendly wave)')
    expect(emotesLine).toContain('shrug (Shrug)')
    expect(emotesLine).toContain('laugh (Short laugh beat)')
    expect(emojiLine).toContain('👋=wave')
    expect(lines).toContain(
      'If an emote has Pause speech timing, that authored pause wins.'
    )
    expect(lines).toContain(
      'For normal emoji emotes, place the emoji immediately before the spoken word or sentence it should start with.'
    )
    expect(lines).toContain(
      'If an emoji is followed only by punctuation or it ends the message, Batshit treats it like an after-reaction instead of waiting for a next word.'
    )
    expect(lines).toContain('Emoji combos use +, e.g. 😏+🙄. Keep combos to 2 emojis max.')
  })

  it('keeps moods but omits emote guidance when the reply will not be spoken', () => {
    const lines = buildGoonDcmLines(goon, { includeSpokenCues: false }, goonsSettings)

    expect(lines.find((line) => line.startsWith('Moods: '))).toContain('happy (Happy idle)')
    expect(lines.some((line) => line.startsWith('Emotes: '))).toBe(false)
    expect(lines.some((line) => line.startsWith('Emoji triggers: '))).toBe(false)
    expect(lines.some((line) => line.includes('One-shot goon motions'))).toBe(false)
    expect(lines.some((line) => line.includes('Pause speech'))).toBe(false)
  })

  it('treats TTS and voice reply modes as spoken Goon cue turns', () => {
    expect(shouldIncludeGoonSpokenCues({ tts: true, voiceMode: 'text' })).toBe(true)
    expect(shouldIncludeGoonSpokenCues({ tts: false, voiceMode: 'voice' })).toBe(true)
    expect(shouldIncludeGoonSpokenCues({ tts: false, voiceMode: 'hybrid' })).toBe(true)
    expect(shouldIncludeGoonSpokenCues({ tts: false, voiceMode: 'speech-to-speech' })).toBe(true)
    expect(shouldIncludeGoonSpokenCues({ stt: true, voiceMode: 'text' })).toBe(false)
    expect(shouldIncludeGoonSpokenCues(undefined)).toBe(false)
  })
})

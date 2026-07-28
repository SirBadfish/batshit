import { describe, expect, it } from 'vitest'

import {
  mergeGoonsSettingsPatch,
  normalizeGoonCueMap,
  resolveGoonCues,
  resolvePreviewAnimationDefinition
} from '$lib/goons/resolve'
import type { GoonCueMap, GoonFileRef, GoonRecord, GoonsSettings } from '$lib/types/goons'

describe('resolvePreviewAnimationDefinition', () => {
  it('prefers real cue definitions when an animation name maps to a cue animationName', () => {
    const cueMap: GoonCueMap = {
      couch_idle: {
        name: 'couch_idle',
        kind: 'mood',
        animationName: 'Idle-sit-couch',
        posture: 'sit',
        playback: 'loop'
      }
    }

    const result = resolvePreviewAnimationDefinition('Idle-sit-couch', cueMap, [])

    expect(result).toBe(cueMap.couch_idle)
    expect(result?.posture).toBe('sit')
  })

  it('builds a posture-aware fallback from motion metadata when no cue exists', () => {
    const files: GoonFileRef[] = [
      {
        url: '/motions/lounge-sit.vrma',
        filename: 'lounge-sit.vrma',
        motionMeta: {
          posture: 'sit',
          playback: 'loop'
        }
      }
    ]

    const result = resolvePreviewAnimationDefinition('lounge-sit', {}, files)

    expect(result).toMatchObject({
      name: 'lounge-sit',
      kind: 'mood',
      animationName: 'lounge-sit',
      posture: 'sit',
      playback: 'loop'
    })
  })
})

describe('resolveGoonCues', () => {
  it('automatically includes new global cues unless a goon explicitly disables them', () => {
    const settings: GoonsSettings = {
      dockOpen: false,
      showCues: false,
      immersiveMode: true,
      globalCloset: { items: {} },
      kitchen: {
        cues: {
          calm: { name: 'calm', kind: 'mood', playback: 'loop' },
          smile: {
            name: 'smile',
            kind: 'emote',
            playback: 'oneshot',
            expressionTargets: [{ preset: 'happy', weight: 0.6 }]
          },
          laugh: {
            name: 'laugh',
            kind: 'emote',
            playback: 'oneshot',
            faceControls: [{ control: 'mouth_open', value: 0.4 }]
          }
        },
        emojiMap: {},
        scenes: {},
        roomTextures: {},
        bodyVariants: { items: {} }
      }
    }

    const goon: GoonRecord = {
      id: 'goon_1',
      user_id: 'josh',
      name: 'Jen',
      files: { animations: [] },
      cues: {
        enabled: ['smile'],
        disabled: ['laugh'],
        overrides: {},
        emojiOverrides: {}
      },
      created_at: '2026-03-17T00:00:00.000Z',
      updated_at: '2026-03-17T00:00:00.000Z'
    }

    const resolved = resolveGoonCues(goon, settings)

    expect(Object.keys(resolved.cueMap)).toEqual(['calm', 'smile'])
    expect(resolved.enabled).toEqual(['calm', 'smile'])
  })

  it('removes motion-only Emotes while preserving facial payloads without motion fields', () => {
    const normalized = normalizeGoonCueMap({
      wave: {
        name: 'wave',
        kind: 'emote',
        playback: 'oneshot',
        animationName: 'gesture-wave',
        mask: 'upper'
      },
      animated_smile: {
        name: 'animated_smile',
        kind: 'emote',
        playback: 'loop',
        animationName: 'gesture-wave',
        posture: 'stand',
        expressionTargets: [{ preset: 'happy', weight: 0.5 }]
      },
      fresh_emote: {
        name: 'fresh_emote',
        kind: 'emote',
        playback: 'oneshot'
      }
    })

    expect(normalized.wave).toBeUndefined()
    expect(normalized.animated_smile).toMatchObject({
      name: 'animated_smile',
      kind: 'emote',
      playback: 'oneshot',
      faceProfiles: {
        portable: {
          expressionTargets: [{ preset: 'happy', weight: 0.5 }]
        },
        arkit52: {}
      }
    })
    expect(normalized.animated_smile.expressionTargets).toBeUndefined()
    expect(normalized.animated_smile.animationName).toBeUndefined()
    expect(normalized.animated_smile.posture).toBeUndefined()
    expect(normalized.fresh_emote).toBeDefined()
  })
})

describe('mergeGoonsSettingsPatch', () => {
  it('merges top-level Goon settings patches without wiping scenes or room textures', () => {
    const settings: GoonsSettings = {
      dockOpen: true,
      immersiveMode: true,
      globalCloset: { items: {} },
      kitchen: {
        cues: {},
        emojiMap: {},
        scenes: {
          cyberpunk: {
            id: 'cyberpunk',
            name: 'Cyberpunk',
            skybox: {
              url: '/uploads/goon_scenes/new.png',
              filename: 'new.png',
              originalName: 'new.png'
            }
          }
        },
        roomTextures: {
          wall: [
            {
              url: '/uploads/goon_room_textures/wall.png',
              filename: 'wall.png',
              originalName: 'wall.png'
            }
          ]
        },
        bodyVariants: { items: {} }
      }
    }

    const merged = mergeGoonsSettingsPatch(settings, { dockOpen: false })

    expect(merged.dockOpen).toBe(false)
    expect(merged.kitchen?.scenes?.cyberpunk?.skybox?.filename).toBe('new.png')
    expect(merged.kitchen?.roomTextures?.wall?.[0]?.filename).toBe('wall.png')
  })

  it('merges kitchen patches without dropping unrelated kitchen libraries', () => {
    const settings: GoonsSettings = {
      kitchen: {
        cues: {
          calm: { name: 'calm', kind: 'mood', playback: 'loop' },
          smile: {
            name: 'smile',
            kind: 'emote',
            playback: 'oneshot',
            expressionTargets: [{ preset: 'happy', weight: 0.6 }]
          }
        },
        emojiMap: {},
        scenes: {
          cyberpunk: { id: 'cyberpunk', name: 'Cyberpunk' }
        },
        roomTextures: {},
        bodyVariants: { items: {} }
      }
    }

    const merged = mergeGoonsSettingsPatch(settings, {
      kitchen: {
        emojiMap: {
          ':)': 'smile'
        }
      }
    })

    expect(merged.kitchen?.emojiMap?.[':)']).toBe('smile')
    expect(merged.kitchen?.cues?.calm?.name).toBe('calm')
    expect(merged.kitchen?.scenes?.cyberpunk?.name).toBe('Cyberpunk')
  })
})

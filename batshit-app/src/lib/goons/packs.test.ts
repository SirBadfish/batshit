import { describe, expect, it } from 'vitest'

import {
  buildDefaultPackFromGoon,
  buildDefaultPackUpdateForGoon,
  importGoonLibraryExportBundle,
  mergeDefaultPackIntoSettings
} from '$lib/goons/packs'
import type { GoonRecord, GoonsSettings } from '$lib/types/goons'
import { DEFAULT_SOCKET_EYE_CONTACT_SETTINGS } from '$lib/goons/socketEyeContact'

const baseSettings: GoonsSettings = {
  dockOpen: false,
  showCues: false,
  immersiveMode: true,
  globalCloset: { items: {} },
  kitchen: {
    cues: {
      calm: {
        name: 'calm',
        kind: 'mood',
        playback: 'loop'
      },
      wave: {
        name: 'wave',
        kind: 'emote',
        playback: 'oneshot',
        rawMorphTargets: [{ target: 'Fcl_BRW_Fun', value: 0.4 }],
        steps: [
          {
            rawMorphTargets: [{ target: 'Fcl_MTH_Surprised', value: 0.7 }],
            attackMs: 100,
            holdMs: 200,
            releaseMs: 150
          }
        ]
      }
    },
    emojiMap: {
      '👋': 'wave'
    },
    scenes: {
      lounge: {
        id: 'lounge',
        name: 'Lounge'
      }
    },
    roomTextures: {},
    bodyVariants: { items: {} }
  }
}

const baseGoon: GoonRecord = {
  id: 'goon_1',
  user_id: 'josh',
  name: 'Josh Prime',
  description: '',
  files: {
    vrm: {
      url: '/goons/josh.vrm',
      filename: 'josh.vrm'
    },
    animations: []
  },
  cues: {
    enabled: ['calm', 'wave'],
    overrides: {},
    emojiOverrides: {}
  },
  defaults: {
    baseLoop: 'calm',
    sceneId: 'lounge',
    quality: 'high',
    lipSync: true,
    eyeContactMode: 'expression',
    eyeContactTuning: {
      eyeYawSensitivity: 2.5,
      eyeYawRange: 1.75,
      eyePitchSensitivity: 0.75,
      eyePitchRange: 1.25,
      headYawStartOutDeg: 45,
      headYawStartInDeg: 88,
      headYawSensitivity: 0.6,
      headYawRange: 1.1,
      headYawSpeed: 1.4,
      headPitchStartOutDeg: 10,
      headPitchStartInDeg: 82,
      headPitchSensitivity: 0.7,
      headPitchRange: 0.9,
      headPitchSpeed: 0.8,
      eyeYawHeadCompensation: 1.2,
      eyePitchHeadCompensation: 0.5
    },
    socketEyeContact: {
      ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
      strength: 0.8,
      headFollow: 0.6,
      response: 0.4
    }
  },
  created_at: '2026-03-15T00:00:00.000Z',
  updated_at: '2026-03-15T00:00:00.000Z'
}

describe('goon packs helpers', () => {
  it('builds a default pack from a tuned goon and merges it into kitchen settings', () => {
    const pack = buildDefaultPackFromGoon(baseGoon, baseSettings)
    expect(pack.name).toBe('Default Pack')
    expect(pack.enabledCueNames).toEqual(['calm', 'wave'])
    expect(pack.defaults?.baseLoop).toBe('calm')
    expect(pack.defaults?.sceneId).toBe('lounge')
    expect(pack.defaults?.eyeContactMode).toBe('expression')
    expect(pack.defaults?.socketEyeContact).toEqual(baseGoon.defaults?.socketEyeContact)
    expect(pack.defaults?.eyeContactTuning).toEqual({
      eyeYawSensitivity: 2.5,
      eyeYawRange: 1.75,
      eyePitchSensitivity: 0.75,
      eyePitchRange: 1.25,
      headYawStartOutDeg: 45,
      headYawStartInDeg: 88,
      headYawSensitivity: 0.6,
      headYawRange: 1.1,
      headYawSpeed: 1.4,
      headPitchStartOutDeg: 10,
      headPitchStartInDeg: 82,
      headPitchSensitivity: 0.7,
      headPitchRange: 0.9,
      headPitchSpeed: 0.8,
      eyeYawHeadCompensation: 1.2,
      eyePitchHeadCompensation: 0.5
    })
    expect(pack.cueMap.wave?.rawMorphTargets).toEqual([{ target: 'Fcl_BRW_Fun', value: 0.4 }])
    expect(pack.cueMap.wave?.steps?.[0]?.rawMorphTargets).toEqual([
      { target: 'Fcl_MTH_Surprised', value: 0.7 }
    ])

    const merged = mergeDefaultPackIntoSettings(baseSettings, pack)
    expect(merged.kitchen?.defaultPack?.sourceGoonName).toBe('Josh Prime')
    expect(merged.kitchen?.defaultPack?.cueMap?.calm?.name).toBe('calm')
    expect(merged.kitchen?.defaultPack?.cueMap?.wave?.rawMorphTargets).toEqual([
      { target: 'Fcl_BRW_Fun', value: 0.4 }
    ])
    expect(merged.kitchen?.defaultPack?.cueMap?.wave?.steps?.[0]?.rawMorphTargets).toEqual([
      { target: 'Fcl_MTH_Surprised', value: 0.7 }
    ])
  })

  it('applies the exported default pack back onto another goon', () => {
    const pack = buildDefaultPackFromGoon(baseGoon, baseSettings)
    const settingsWithPack = mergeDefaultPackIntoSettings(baseSettings, pack)

    const nextGoon = {
      ...baseGoon,
      id: 'goon_2',
      name: 'Fresh Copy',
      cues: {
        enabled: ['wave'],
        overrides: {
          wave: {
            name: 'wave',
            kind: 'emote',
            playback: 'oneshot',
            description: 'Old override'
          }
        },
        emojiOverrides: {
          '👋': 'wave'
        }
      },
      defaults: {
        baseLoop: 'wave',
        quality: 'low',
        lipSync: false,
        eyeContactMode: 'bone',
        eyeContactTuning: {
          eyeYawSensitivity: 1,
          eyeYawRange: 1,
          eyePitchSensitivity: 1,
          eyePitchRange: 1,
          headYawStartOutDeg: 14,
          headYawStartInDeg: 90,
          headYawSensitivity: 1,
          headYawRange: 1,
          headYawSpeed: 1,
          headPitchStartOutDeg: 8,
          headPitchStartInDeg: 90,
          headPitchSensitivity: 1,
          headPitchRange: 1,
          headPitchSpeed: 1,
          eyeYawHeadCompensation: 1,
          eyePitchHeadCompensation: 1
        }
      }
    } satisfies GoonRecord

    const updates = buildDefaultPackUpdateForGoon(nextGoon, settingsWithPack)
    expect(updates?.cues?.enabled).toEqual(['calm', 'wave'])
    expect(updates?.cues?.disabled).toEqual([])
    expect(updates?.cues?.overrides).toEqual({})
    expect(updates?.defaults?.baseLoop).toBe('calm')
    expect(updates?.defaults?.quality).toBe('high')
    expect(updates?.defaults?.eyeContactMode).toBe('expression')
    expect(updates?.defaults?.socketEyeContact).toEqual(baseGoon.defaults?.socketEyeContact)
    expect(updates?.defaults?.eyeContactTuning).toEqual({
      eyeYawSensitivity: 2.5,
      eyeYawRange: 1.75,
      eyePitchSensitivity: 0.75,
      eyePitchRange: 1.25,
      headYawStartOutDeg: 45,
      headYawStartInDeg: 88,
      headYawSensitivity: 0.6,
      headYawRange: 1.1,
      headYawSpeed: 1.4,
      headPitchStartOutDeg: 10,
      headPitchStartInDeg: 82,
      headPitchSensitivity: 0.7,
      headPitchRange: 0.9,
      headPitchSpeed: 0.8,
      eyeYawHeadCompensation: 1.2,
      eyePitchHeadCompensation: 0.5
    })
  })

  it('renames imported motion and scene collisions instead of replacing existing data', () => {
    const imported = importGoonLibraryExportBundle(baseSettings, {
      version: 1,
      exportedAt: '2026-03-15T00:00:00.000Z',
      moods: [
        {
          name: 'calm',
          kind: 'mood',
          playback: 'loop',
          description: 'Imported calm'
        }
      ],
      emotes: [
        {
          name: 'wave',
          kind: 'emote',
          playback: 'oneshot',
          description: 'Imported wave',
          rawMorphTargets: [{ target: 'Fcl_MTH_Small', value: 0.5 }],
          steps: [
            {
              rawMorphTargets: [{ target: 'Fcl_EYE_Surprised', value: 0.6 }],
              attackMs: 120,
              holdMs: 180,
              releaseMs: 120
            }
          ]
        }
      ],
      emojiMap: {
        '👋': 'wave'
      },
      scenes: [
        {
          id: 'lounge',
          name: 'Lounge',
          scenePlacement: 'ground',
          groundProjectionLine: 0.62,
          roomShell: {
            kind: 'room_shell',
            url: '/uploads/goon_room_shells/neon-room.glb',
            filename: 'neon-room.glb',
            originalName: 'Neon Room.glb'
          },
          roomShellTransform: {
            position: [1.25, -0.367, -2.5],
            rotationY: Math.PI / 2,
            uniformScale: 1.45
          }
        }
      ]
    })

    expect(imported.renamedCueNames).toEqual({
      calm: 'calm2',
      wave: 'wave2'
    })
    expect(imported.renamedSceneNames).toEqual({
      Lounge: 'Lounge2'
    })
    expect(imported.settings.kitchen?.cues?.calm2?.description).toBe('Imported calm')
    const importedScene = imported.settings.kitchen?.scenes?.lounge2
    expect(importedScene?.name).toBe('Lounge2')
    expect(importedScene?.scenePlacement).toBe('ground')
    expect(importedScene?.groundProjectionLine).toBe(0.62)
    expect(importedScene?.roomShell).toEqual({
      kind: 'room_shell',
      url: '/uploads/goon_room_shells/neon-room.glb',
      filename: 'neon-room.glb',
      originalName: 'Neon Room.glb'
    })
    expect(importedScene?.roomShellTransform).toEqual({
      position: [1.25, -0.367, -2.5],
      rotationY: Math.PI / 2,
      uniformScale: 1.45
    })
    expect(imported.settings.kitchen?.cues?.wave2?.rawMorphTargets).toEqual([
      { target: 'Fcl_MTH_Small', value: 0.5 }
    ])
    expect(imported.settings.kitchen?.cues?.wave2?.steps?.[0]?.rawMorphTargets).toEqual([
      { target: 'Fcl_EYE_Surprised', value: 0.6 }
    ])
    expect(imported.emojiConflicts).toEqual(['👋'])
  })

  it('merges imported custom postures alongside cues and scenes', () => {
    const imported = importGoonLibraryExportBundle(baseSettings, {
      version: 1,
      exportedAt: '2026-04-13T00:00:00.000Z',
      postures: [
        {
          id: 'dance',
          name: 'Dance',
          basePosture: 'stand'
        }
      ],
      moods: [
        {
          name: 'dance_loop',
          kind: 'mood',
          playback: 'loop',
          posture: 'dance'
        }
      ],
      emotes: [],
      emojiMap: {},
      scenes: [
        {
          id: 'club',
          name: 'Club',
          markers: {
            dance: [{ id: 'dance_1', position: [0, 0, 0] }]
          }
        }
      ]
    })

    expect(imported.settings.kitchen?.postures?.dance?.name).toBe('Dance')
    expect(imported.settings.kitchen?.cues?.dance_loop?.posture).toBe('dance')
    expect(imported.settings.kitchen?.scenes?.club?.markers?.dance?.length).toBe(1)
  })
})

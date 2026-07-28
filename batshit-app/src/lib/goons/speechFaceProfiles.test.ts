import { describe, expect, it } from 'vitest'

import { createEmptyCustomRhubarbMouthWeights } from './semanticVisemes'
import {
  GOON_SPEECH_FACE_PROFILE_SCHEMA,
  OVR_15_VISEME_ORDER,
  createEmptyOvr15Weights,
  projectGoonSpeechFaceFrameToOvr15,
  projectGoonSpeechFaceFrameToRhubarb9,
  resolveGoonSpeechFaceProfileDeclaration
} from './speechFaceProfiles'

describe('speechFaceProfiles', () => {
  it('locks Meta OVR-15 order and neutral sentinel exactly', () => {
    expect(OVR_15_VISEME_ORDER).toEqual([
      'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'
    ])
    expect(createEmptyOvr15Weights()).toEqual(Object.fromEntries(OVR_15_VISEME_ORDER.map((key) => [key, 0])))
  })

  it('projects only at the requested package boundary', () => {
    const ovr = createEmptyOvr15Weights()
    ovr.PP = 1
    ovr.aa = 0.8
    ovr.U = 0.6

    const projectedRhubarb = projectGoonSpeechFaceFrameToRhubarb9({ profile: 'ovr-15', weights: ovr })
    expect(projectedRhubarb.closed).toBe(1)
    expect(projectedRhubarb.wide_open).toBeCloseTo(0.736)
    expect(projectedRhubarb.pucker).toBeCloseTo(0.57)

    const rhubarb = createEmptyCustomRhubarbMouthWeights()
    rhubarb.closed = 1
    rhubarb.wide_open = 0.8
    expect(projectGoonSpeechFaceFrameToOvr15({ profile: 'rhubarb-9', weights: rhubarb })).toMatchObject({
      PP: 1,
      aa: 0.8
    })
  })

  it('accepts only an exact versioned profile declaration', () => {
    expect(
      resolveGoonSpeechFaceProfileDeclaration({
        schemaVersion: GOON_SPEECH_FACE_PROFILE_SCHEMA,
        profile: 'ovr-15',
        neutral: 'sil',
        channels: [...OVR_15_VISEME_ORDER]
      })
    ).toEqual({ profile: 'ovr-15', issues: [] })

    const invalid = resolveGoonSpeechFaceProfileDeclaration({
      schemaVersion: GOON_SPEECH_FACE_PROFILE_SCHEMA,
      profile: 'ovr-15',
      neutral: 'rest',
      channels: [...OVR_15_VISEME_ORDER].reverse()
    })
    expect(invalid.profile).toBeNull()
    expect(invalid.issues).toHaveLength(2)
  })
})

import { describe, expect, it } from 'vitest'

import { NORMAL_FACE_CONTROL_SECTIONS } from '$lib/goons/faceControls'
import {
  ARKIT_52_CHANNEL_ORDER,
  OVR_15_SPEECH_FACE_PROFILE,
  OVR_15_VISEME_ORDER
} from '$lib/goons/speechFaceProfiles'
import { buildUniversalFaceControlModel } from '$lib/goons/universalFaceControls'

describe('universal face control model', () => {
  it('organizes a rich Custom GLB face without duplicating ARKit or speech morphs', () => {
    const arkitDefinitions = ARKIT_52_CHANNEL_ORDER.map((channel) => ({
      id: channel,
      morphTargets: [`BS_ARKit_${channel}`]
    }))
    const ovrDefinitions = OVR_15_VISEME_ORDER.filter((channel) => channel !== 'sil').map(
      (channel) => ({
        id: `viseme_${channel}`,
        morphTargets: [`BS_OVR_${channel}`]
      })
    )
    const model = buildUniversalFaceControlModel({
      arkitDefinitions,
      customMorphDefinitions: [
        ...arkitDefinitions,
        ...ovrDefinitions,
        { id: 'jawOpen', morphTargets: ['BS_Duplicate_JawOpen'] },
        { id: 'earWiggle', morphTargets: ['BS_Custom_EarWiggle'] }
      ],
      mouthPresetSupport: {
        mode: 'ovr',
        profile: OVR_15_SPEECH_FACE_PROFILE,
        availablePresets: [...OVR_15_VISEME_ORDER]
      },
      classicSections: NORMAL_FACE_CONTROL_SECTIONS
    })

    expect(model.sections.map((section) => section.id)).toEqual([
      'eyes',
      'brows',
      'cheeks-nose',
      'jaw',
      'mouth',
      'tongue',
      'visemes',
      'head-movement',
      'custom-morphs'
    ])
    expect(model.sections.find((section) => section.id === 'visemes')?.controls).toHaveLength(14)
    expect(model.sections.find((section) => section.id === 'custom-morphs')?.controls).toEqual([
      expect.objectContaining({ id: 'custom:earWiggle', morphTargets: ['BS_Custom_EarWiggle'] })
    ])

    const representedTargets = model.sections.flatMap((section) =>
      section.controls.flatMap((control) => control.morphTargets ?? [])
    )
    expect(new Set(representedTargets).size).toBe(representedTargets.length)
    expect(representedTargets).toContain('BS_ARKit_jawOpen')
    expect(representedTargets).toContain('BS_OVR_PP')
    expect(representedTargets).not.toContain('BS_Duplicate_JawOpen')
    expect(
      model.sections
        .find((section) => section.id === 'jaw')
        ?.controls.find((control) => control.id === 'arkit:jawOpen')
    ).toMatchObject({
      storage: 'arkit-channel',
      arkitChannel: 'jawOpen',
      morphTargets: ['BS_ARKit_jawOpen']
    })
  })

  it('keeps the normal semantic controls for a Standard VRoid face', () => {
    const model = buildUniversalFaceControlModel({
      classicSections: NORMAL_FACE_CONTROL_SECTIONS,
      mouthPresetSupport: {
        mode: 'legacy',
        profile: 'vrm-vowels-5',
        availablePresets: ['aa', 'ih', 'ou', 'ee', 'oh']
      }
    })

    expect(model.sections.map((section) => section.id)).toEqual([
      'eyes',
      'brows',
      'mouth',
      'visemes',
      'head-movement'
    ])
    expect(model.sections.find((section) => section.id === 'visemes')?.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'A', storage: 'expression-preset' }),
        expect.objectContaining({ label: 'O', storage: 'expression-preset' })
      ])
    )
  })
})

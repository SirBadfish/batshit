import { describe, expect, it } from 'vitest'

import {
  detectVRMSource,
  formatFaceControlDisplayValue,
  getEyelidsValue,
  getFaceControlBehaviorGroups,
  getFaceControlMapping,
  getFaceControlFillFrom,
  getNormalFaceControlSectionsForControls,
  resolveSpeakingFaceControl,
  stepFaceLayerBlend,
  shouldApplyMoodFaceLayer,
  getSupportedNormalFaceControlSections,
  resolveMappedFaceControls,
  resolveRawMorphTargets,
  resolveFaceControls,
  type GoonFaceControl
} from '$lib/goons/faceControls'

describe('face controls helpers', () => {
  const vroidMorphs = [
    'Face.Fcl_EYE_Close',
    'Face.Fcl_EYE_Close_L',
    'Face.Fcl_EYE_Close_R',
    'Face.Fcl_EYE_Surprised',
    'Face.Fcl_EYE_Spread',
    'Face.Fcl_EYE_Angry',
    'Face.Fcl_EYE_Sorrow',
    'Face.Fcl_EYE_Joy',
    'Face.Fcl_EYE_Fun',
    'Face.Fcl_BRW_Angry',
    'Face.Fcl_BRW_Fun',
    'Face.Fcl_BRW_Joy',
    'Face.Fcl_BRW_Sorrow',
    'Face.Fcl_BRW_Surprised',
    'Face.Fcl_MTH_A',
    'Face.Fcl_MTH_Angry',
    'Face.Fcl_MTH_Close',
    'Face.Fcl_MTH_Down',
    'Face.Fcl_MTH_E',
    'Face.Fcl_MTH_Fun',
    'Face.Fcl_MTH_I',
    'Face.Fcl_MTH_Joy',
    'Face.Fcl_MTH_Large',
    'Face.Fcl_MTH_O',
    'Face.Fcl_MTH_Small',
    'Face.Fcl_MTH_Sorrow',
    'Face.Fcl_MTH_Surprised',
    'Face.Fcl_MTH_U',
    'Face.Fcl_MTH_Up'
  ]

  it('detects VRoid morph naming from Fcl targets', () => {
    expect(detectVRMSource(vroidMorphs)).toBe('vroid')
  })

  it('resolves morph controls into the expected VRoid targets', () => {
    const controls: GoonFaceControl[] = [
      { control: 'eyelids_left', value: -0.5 },
      { control: 'eyebrows', value: 0.75 },
      { control: 'mouth_smile', value: 0.5 },
      { control: 'mouth_open', value: 0.4 },
      { control: 'head_leftright', value: 1 }
    ]
    const mapping = getFaceControlMapping('vroid')

    expect(mapping).not.toBeNull()

    const resolved = resolveFaceControls(controls, mapping!)

    expect(resolved.get('Fcl_EYE_Close_L')).toBeCloseTo(0.5, 5)
    expect(resolved.get('Fcl_BRW_Surprised')).toBeCloseTo(0.75, 5)
    expect(resolved.get('Fcl_MTH_Fun')).toBeCloseTo(0.3, 5)
    expect(resolved.get('Fcl_MTH_Joy')).toBeCloseTo(0.2, 5)
    expect(resolved.get('Fcl_MTH_A')).toBeCloseTo(0.4, 5)
    expect(resolved.has('head_leftright')).toBe(false)
  })

  it('uses a downturned mouth mapping for the frown side of mouth expression', () => {
    const mapping = getFaceControlMapping('vroid')

    expect(mapping).not.toBeNull()

    const resolved = resolveFaceControls([{ control: 'mouth_smile', value: -0.5 }], mapping!)

    expect(resolved.get('Fcl_MTH_Down')).toBeCloseTo(0.425, 5)
    expect(resolved.get('Fcl_MTH_Close')).toBeCloseTo(0.175, 5)
    expect(resolved.get('Fcl_MTH_Angry')).toBeCloseTo(0.1, 5)
    expect(resolved.has('Fcl_MTH_Sorrow')).toBe(false)
  })

  it('uses a corners-down approximation without the whole-mouth lowering morph', () => {
    const mapping = getFaceControlMapping('vroid')

    expect(mapping).not.toBeNull()

    const resolved = resolveFaceControls([{ control: 'mouth_corners', value: -0.5 }], mapping!)

    expect(resolved.get('Fcl_MTH_Sorrow')).toBeCloseTo(0.325, 5)
    expect(resolved.get('Fcl_MTH_Close')).toBeCloseTo(0.15, 5)
    expect(resolved.get('Fcl_MTH_Angry')).toBeCloseTo(0.375, 5)
    expect(resolved.has('Fcl_MTH_Down')).toBe(false)
  })

  it('uses the most closed eyelid value for blink suppression checks', () => {
    expect(
      getEyelidsValue([
        { control: 'eyelids_left', value: -0.25 },
        { control: 'eyelids_right', value: -0.6 }
      ])
    ).toBeCloseTo(-0.6, 5)

    expect(getEyelidsValue([{ control: 'mouth_smile', value: 1 }])).toBe(0)
  })

  it('exposes the richer semantic sections only when the model supports them', () => {
    const sections = getSupportedNormalFaceControlSections('vroid', vroidMorphs)

    expect(sections.map((section) => section.id)).toEqual(['eyes', 'brows', 'mouth', 'head'])
    expect(sections.find((section) => section.id === 'eyes')?.specs.map((spec) => spec.id)).toEqual(
      [
        'eyelids_left',
        'eyelids_right',
        'eyes_widen',
        'eyes_squint',
        'eyes_tense',
        'eyes_soft',
        'eyes_happy',
        'eyes_leftright',
        'eyes_updown'
      ]
    )
    expect(sections.find((section) => section.id === 'brows')?.specs.map((spec) => spec.id)).toEqual(
      ['brows_raise', 'brows_furrow', 'brows_sad', 'brows_playful']
    )
    expect(sections.find((section) => section.id === 'mouth')?.specs.map((spec) => spec.id)).toEqual(
      ['mouth_corners', 'mouth_open', 'mouth_width', 'mouth_tension', 'mouth_round']
    )
    expect(sections.find((section) => section.id === 'head')?.specs.map((spec) => spec.id)).toEqual(
      ['head_leftright', 'head_updown']
    )

    const eyeGroups = getFaceControlBehaviorGroups(
      sections.find((section) => section.id === 'eyes')!
    )

    expect(eyeGroups.map((group) => group.id)).toEqual(['two_way', 'one_way'])
    expect(eyeGroups[0]?.specs.map((spec) => spec.id)).toEqual([
      'eyelids_left',
      'eyelids_right',
      'eyes_leftright',
      'eyes_updown'
    ])
    expect(eyeGroups[1]?.specs.map((spec) => spec.id)).toEqual([
      'eyes_widen',
      'eyes_squint',
      'eyes_tense',
      'eyes_soft',
      'eyes_happy'
    ])
    expect(getFaceControlFillFrom(eyeGroups[0]!.specs[0]!)).toBe(0)
    expect(getFaceControlFillFrom(eyeGroups[1]!.specs[0]!)).toBe(0)
    expect(formatFaceControlDisplayValue(eyeGroups[0]!.specs[0]!, -0.25)).toBe('-0.25')
    expect(formatFaceControlDisplayValue(eyeGroups[1]!.specs[0]!, 0.35)).toBe('35%')
  })

  it('can rebuild visible face-control sections from authored controls alone', () => {
    const sections = getNormalFaceControlSectionsForControls([
      { control: 'eyes_happy', value: 0.4 },
      { control: 'mouth_corners', value: -0.3 },
      { control: 'head_leftright', value: 0.2 }
    ])

    expect(sections.map((section) => section.id)).toEqual(['eyes', 'mouth', 'head'])
    expect(sections.find((section) => section.id === 'eyes')?.specs.map((spec) => spec.id)).toEqual([
      'eyes_happy'
    ])
    expect(sections.find((section) => section.id === 'mouth')?.specs.map((spec) => spec.id)).toEqual([
      'mouth_corners'
    ])
    expect(sections.find((section) => section.id === 'head')?.specs.map((spec) => spec.id)).toEqual([
      'head_leftright'
    ])
  })

  it('resolves the new semantic controls into real VRoid morph targets', () => {
    const mapping = getFaceControlMapping('vroid')

    expect(mapping).not.toBeNull()

    const resolved = resolveFaceControls(
      [
        { control: 'eyes_widen', value: 0.8 },
        { control: 'brows_playful', value: 0.5 },
        { control: 'mouth_width', value: -0.6 },
        { control: 'mouth_round', value: 0.5 }
      ],
      mapping!
    )

    expect(resolved.get('Fcl_EYE_Surprised')).toBeCloseTo(0.6, 5)
    expect(resolved.get('Fcl_EYE_Spread')).toBeCloseTo(0.2, 5)
    expect(resolved.get('Fcl_BRW_Fun')).toBeCloseTo(0.35, 5)
    expect(resolved.get('Fcl_BRW_Joy')).toBeCloseTo(0.15, 5)
    expect(resolved.get('Fcl_MTH_Small')).toBeCloseTo(0.6, 5)
    expect(resolved.get('Fcl_MTH_Surprised')).toBeCloseTo(0.3, 5)
    expect(resolved.get('Fcl_MTH_O')).toBeCloseTo(0.125, 5)
    expect(resolved.get('Fcl_MTH_U')).toBeCloseTo(0.075, 5)
  })

  it('can resolve a custom mapping that includes split direction bindings', () => {
    const resolved = resolveMappedFaceControls(
      [
        { control: 'eyes_leftright', value: -0.5 },
        { control: 'mouth_width', value: 0.4 },
        { control: 'head_updown', value: 0.25 }
      ],
      {
        eyes_leftright: {
          negative: [{ target: 'EyesLookLeft', scale: 1 }],
          positive: [{ target: 'EyesLookRight', scale: 1 }]
        },
        mouth_width: {
          negative: [{ target: 'MouthNarrow', scale: 1 }],
          positive: [{ target: 'MouthWide', scale: 1 }]
        },
        head_updown: {
          negative: [{ target: 'HeadDown', scale: 1 }],
          positive: [{ target: 'HeadUp', scale: 1 }]
        }
      },
      { includeDirectionControls: true }
    )

    expect(resolved.get('EyesLookLeft')).toBeCloseTo(0.5, 5)
    expect(resolved.get('MouthWide')).toBeCloseTo(0.4, 5)
    expect(resolved.get('HeadUp')).toBeCloseTo(0.25, 5)
  })

  it('dampens mouth controls during active speech while leaving non-mouth controls alone', () => {
    expect(
      resolveSpeakingFaceControl(
        { control: 'mouth_open', value: 0.8 },
        { speaking: true }
      )
    ).toBeNull()

    expect(
      resolveSpeakingFaceControl(
        { control: 'mouth_width', value: 0.8 },
        { speaking: true }
      )
    ).toEqual({
      control: 'mouth_width',
      value: 0.2
    })

    expect(
      resolveSpeakingFaceControl(
        { control: 'mouth_smile', value: -0.8 },
        { speaking: true }
      )
    ).toEqual({
      control: 'mouth_smile',
      value: -0.4
    })

    expect(
      resolveSpeakingFaceControl(
        { control: 'eyes_widen', value: 0.6 },
        { speaking: true }
      )
    ).toEqual({
      control: 'eyes_widen',
      value: 0.6
    })
  })

  it('restores full authored mouth controls during cue-authored speech pauses', () => {
    expect(
      resolveSpeakingFaceControl(
        { control: 'mouth_open', value: 0.8 },
        { speaking: true, pausedForCue: true }
      )
    ).toEqual({
      control: 'mouth_open',
      value: 0.8
    })

    expect(
      resolveSpeakingFaceControl(
        { control: 'mouth_round', value: 0.6 },
        { speaking: true, pausedForCue: true }
      )
    ).toEqual({
      control: 'mouth_round',
      value: 0.6
    })
  })

  it('suppresses the mood face layer whenever speech or an emote is active', () => {
    expect(shouldApplyMoodFaceLayer({ speaking: false, emoteActive: false })).toBe(true)
    expect(shouldApplyMoodFaceLayer({ speaking: true, emoteActive: false })).toBe(false)
    expect(shouldApplyMoodFaceLayer({ speaking: false, emoteActive: true })).toBe(false)
    expect(shouldApplyMoodFaceLayer({ speaking: true, emoteActive: true })).toBe(false)
  })

  it('steps the face-layer blend toward the target over time', () => {
    expect(stepFaceLayerBlend(1, { active: false, deltaMs: 250, durationMs: 500 })).toBeCloseTo(0.5, 5)
    expect(stepFaceLayerBlend(0.5, { active: false, deltaMs: 500, durationMs: 500 })).toBe(0)
    expect(stepFaceLayerBlend(0, { active: true, deltaMs: 250, durationMs: 500 })).toBeCloseTo(0.5, 5)
    expect(stepFaceLayerBlend(0.5, { active: true, deltaMs: 500, durationMs: 500 })).toBe(1)
  })

  it('resolves raw morph targets with clamping and dedupe by strongest weight', () => {
    const resolved = resolveRawMorphTargets([
      { target: 'Fcl_MTH_Surprised', value: 0.25 },
      { target: 'Fcl_MTH_Surprised', value: 0.8 },
      { target: 'Fcl_BRW_Fun', value: 1.4 },
      { target: 'Fcl_EYE_Close_L', value: -0.2 },
      { target: '', value: 0.7 }
    ])

    expect(resolved.get('Fcl_MTH_Surprised')).toBeCloseTo(0.8, 5)
    expect(resolved.get('Fcl_BRW_Fun')).toBeCloseTo(1, 5)
    expect(resolved.has('Fcl_EYE_Close_L')).toBe(false)
    expect(resolved.size).toBe(2)
  })
})

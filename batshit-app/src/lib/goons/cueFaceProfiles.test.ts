import { describe, expect, it } from 'vitest'

import {
  normalizeCueFaceSource,
  prepareCueForPortablePack,
  selectCueFacePayload
} from '$lib/goons/cueFaceProfiles'

describe('cue face profiles', () => {
  it('moves legacy controls into the portable profile and initializes Emotes with neutral ARKit', () => {
    const normalized = normalizeCueFaceSource(
      {
        expressionTargets: [{ preset: 'happy', weight: 0.75 }],
        faceControls: [{ control: 'eyes_updown', value: 0.5 }],
        rawMorphTargets: [
          { target: 'eyeLookUpLeft', value: 1 },
          { target: 'packageEarWiggle', value: 0.4 }
        ]
      },
      { initializeNeutralArkit52: true }
    )

    expect(normalized.faceProfiles).toEqual({
      portable: {
        expressionTargets: [{ preset: 'happy', weight: 0.75 }],
        faceControls: [{ control: 'eyes_updown', value: 0.5 }]
      },
      arkit52: {}
    })
    expect(normalized.rawMorphTargets).toEqual([
      { target: 'packageEarWiggle', value: 0.4 }
    ])
  })

  it('treats an explicit empty ARKit profile as neutral instead of falling back', () => {
    const selected = selectCueFacePayload(
      {
        faceProfiles: {
          portable: {
            expressionTargets: [{ preset: 'happy', weight: 1 }],
            faceControls: [{ control: 'eyes_updown', value: 1 }]
          },
          arkit52: {}
        }
      },
      {
        arkit52Available: true,
        arkit52Bindings: new Map()
      }
    )

    expect(selected).toEqual({
      profile: 'arkit52',
      expressionTargets: [],
      faceControls: [],
      rawMorphTargets: []
    })
  })

  it('projects canonical ARKit channels through package-specific target bindings', () => {
    const selected = selectCueFacePayload(
      {
        faceProfiles: {
          portable: {},
          arkit52: {
            channels: [
              { channel: 'eyeLookUpLeft', value: 0.8 },
              { channel: 'eyeLookUpRight', value: 0.6 }
            ],
            headControls: [{ control: 'head_leftright', value: -0.25 }]
          }
        }
      },
      {
        arkit52Available: true,
        arkit52Bindings: new Map([
          ['eyeLookUpLeft', ['CustomEyeUp.L']],
          ['eyeLookUpRight', ['CustomEyeUp.R']]
        ])
      }
    )

    expect(selected.profile).toBe('arkit52')
    expect(selected.faceControls).toEqual([
      { control: 'head_leftright', value: -0.25 }
    ])
    expect(selected.rawMorphTargets).toEqual([
      { target: 'CustomEyeUp.L', value: 0.8 },
      { target: 'CustomEyeUp.R', value: 0.6 }
    ])
  })

  it('uses the portable profile when a Goon has no complete ARKit binding', () => {
    const selected = selectCueFacePayload(
      {
        faceProfiles: {
          portable: {
            expressionTargets: [{ preset: 'sad', weight: 0.9 }]
          },
          arkit52: {
            channels: [{ channel: 'browDownLeft', value: 1 }]
          }
        }
      },
      { arkit52Available: false }
    )

    expect(selected.profile).toBe('portable')
    expect(selected.expressionTargets).toEqual([
      { preset: 'sad', weight: 0.9 }
    ])
    expect(selected.rawMorphTargets).toEqual([])
  })

  it('removes package-bound raw targets while retaining both portable pack profiles', () => {
    const portable = prepareCueForPortablePack({
      name: 'roll_eyes',
      kind: 'emote',
      faceProfiles: {
        portable: {
          faceControls: [{ control: 'eyes_updown', value: 1 }]
        },
        arkit52: {
          channels: [{ channel: 'eyeLookUpLeft', value: 1 }]
        }
      },
      rawMorphTargets: [{ target: 'OnlyThisPackage', value: 0.5 }],
      steps: [
        {
          faceProfiles: {
            portable: {},
            arkit52: {}
          },
          rawMorphTargets: [{ target: 'OnlyThisPackageStep', value: 0.75 }]
        }
      ]
    })

    expect(portable.rawMorphTargets).toBeUndefined()
    expect(portable.steps?.[0]?.rawMorphTargets).toBeUndefined()
    expect(portable.faceProfiles).toEqual({
      portable: {
        faceControls: [{ control: 'eyes_updown', value: 1 }]
      },
      arkit52: {
        channels: [{ channel: 'eyeLookUpLeft', value: 1 }]
      }
    })
  })
})

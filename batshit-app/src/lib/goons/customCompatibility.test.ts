import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import type { GoonCustomAvatarManifest } from '$lib/goons/customAvatar'
import {
  CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER,
  CUSTOM_RHUBARB_MOUTH_ORDER
} from '$lib/goons/semanticVisemes'
import { createEmptyGoonLipSyncWeights } from '$lib/utils/goonLipSync'
import {
  ARKIT_52_CHANNEL_ORDER,
  AUDIO2FACE_16_TONGUE_CHANNEL_ORDER,
  OVR_15_VISEME_ORDER,
  createEmptyArkit52Weights,
  createEmptyAudio2FaceTongueWeights,
  createEmptyOvr15Weights
} from './speechFaceProfiles'
import {
  resolveDirectCustomArkitFaceDriverWeights,
  resolveCustomLipSyncPresetWeights,
  resolveCustomMouthPresetSupport,
  resolveCustomRigCompatibilityCoverage
} from './customCompatibility'

function addNode(root: THREE.Object3D, name: string) {
  const node = new THREE.Object3D()
  node.name = name
  root.add(node)
}

function firstPartyManifest(): GoonCustomAvatarManifest {
  return {
    stage: {
      anchors: {
        head: 'anchor_head',
        hips: 'anchor_hips',
        feet: 'anchor_feet'
      }
    },
    rig: {
      hips: 'mixamorig:Hips',
      mixamoCoreBones: [
        'mixamorig:Hips',
        'mixamorig:Spine',
        'mixamorig:Spine1',
        'mixamorig:Neck',
        'mixamorig:Head',
        'mixamorig:RightArm',
        'mixamorig:RightForeArm'
      ],
      performance: {
        nodes: {
          head: { node: 'mixamorigHead' },
          neck: { node: 'mixamorigNeck' }
        }
      }
    }
  }
}

describe('Advanced/GLB compatibility', () => {
  it('scores the seven representative rig roles from verified manifest-backed runtime nodes', () => {
    const root = new THREE.Group()
    for (const name of [
      'anchor_head',
      'anchor_hips',
      'anchor_feet',
      'mixamorigHips',
      'mixamorigSpine',
      'mixamorigSpine1',
      'mixamorigNeck',
      'mixamorigHead',
      'mixamorigRightArm',
      'mixamorigRightForeArm'
    ]) {
      addNode(root, name)
    }

    expect(resolveCustomRigCompatibilityCoverage(root, firstPartyManifest())).toEqual({
      present: 7,
      total: 7,
      missingCoreBones: [],
      missingUpperBody: [],
      missingArms: []
    })
  })

  it('reports a genuinely absent representative arm role instead of forcing 7/7', () => {
    const root = new THREE.Group()
    for (const name of [
      'anchor_head',
      'anchor_hips',
      'anchor_feet',
      'mixamorigHips',
      'mixamorigSpine',
      'mixamorigSpine1',
      'mixamorigNeck',
      'mixamorigHead',
      'mixamorigRightArm'
    ]) {
      addNode(root, name)
    }

    expect(resolveCustomRigCompatibilityCoverage(root, firstPartyManifest())).toEqual({
      present: 6,
      total: 7,
      missingCoreBones: [],
      missingUpperBody: [],
      missingArms: ['rightLowerArm']
    })
  })

  it('recognizes and drives both semantic and legacy GLB mouth contracts', () => {
    const semantic = resolveCustomMouthPresetSupport(['wide_open', 'round', 'happy'])
    expect(semantic).toEqual({
      mode: 'semantic',
      profile: 'rhubarb-9',
      availablePresets: ['wide_open', 'round']
    })

    const legacy = resolveCustomMouthPresetSupport(['aa', 'ih', 'ou', 'happy'])
    expect(legacy).toEqual({
      mode: 'legacy',
      profile: 'vrm-vowels-5',
      availablePresets: ['aa', 'ih', 'ou']
    })

    const weights = createEmptyGoonLipSyncWeights()
    weights.wide_open = 1
    weights.round = 0.5

    const rhubarbFrame = { profile: 'rhubarb-9' as const, weights }
    expect(Object.fromEntries(resolveCustomLipSyncPresetWeights(rhubarbFrame, semantic))).toEqual({
      wide_open: 1,
      round: 0.5
    })
    expect(Object.fromEntries(resolveCustomLipSyncPresetWeights(rhubarbFrame, legacy))).toEqual({
      aa: 1,
      ih: 0.08,
      ou: 0.09
    })
  })

  it('preserves every historical Rhubarb-9 slot without a five-vowel downmix', () => {
    const support = resolveCustomMouthPresetSupport(CUSTOM_RHUBARB_MOUTH_ORDER)
    expect(support).toEqual({
      mode: 'semantic',
      profile: 'rhubarb-9',
      availablePresets: CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER
    })

    for (const cue of CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER) {
      const weights = createEmptyGoonLipSyncWeights()
      weights[cue] = 1
      expect(
        Object.fromEntries(
          resolveCustomLipSyncPresetWeights({ profile: 'rhubarb-9', weights }, support)
        )
      ).toEqual({ [cue]: 1 })
    }

    const rest = createEmptyGoonLipSyncWeights()
    rest.rest = 1
    expect(
      Object.fromEntries(
        resolveCustomLipSyncPresetWeights({ profile: 'rhubarb-9', weights: rest }, support)
      )
    ).toEqual({})
  })

  it('drives complete OVR-15 packages directly and projects lower sources only at that boundary', () => {
    const support = resolveCustomMouthPresetSupport(OVR_15_VISEME_ORDER, 'ovr-15')
    expect(support).toEqual({
      mode: 'ovr',
      profile: 'ovr-15',
      availablePresets: OVR_15_VISEME_ORDER.filter((preset) => preset !== 'sil')
    })

    const ovrWeights = createEmptyOvr15Weights()
    ovrWeights.TH = 1
    expect(
      Object.fromEntries(
        resolveCustomLipSyncPresetWeights({ profile: 'ovr-15', weights: ovrWeights }, support)
      )
    ).toEqual({ TH: 1 })

    const rhubarbWeights = createEmptyGoonLipSyncWeights()
    rhubarbWeights.closed = 1
    expect(
      Object.fromEntries(
        resolveCustomLipSyncPresetWeights(
          { profile: 'rhubarb-9', weights: rhubarbWeights },
          support
        )
      )
    ).toEqual({ PP: 1 })
  })
})

describe('direct ARKit face-driver compatibility', () => {
  it('preserves exact face and optional tongue weights while leaving eye-look to Batshit', () => {
    const weights = createEmptyArkit52Weights()
    weights.jawOpen = 0.7
    weights.eyeBlinkLeft = 0.4
    weights.eyeLookOutLeft = 0.9
    const tongueWeights = createEmptyAudio2FaceTongueWeights()
    tongueWeights.tongueTipUp = 0.6

    const resolved = resolveDirectCustomArkitFaceDriverWeights(
      { profile: 'arkit-52', weights, tongueWeights },
      {
        face: new Map(
          ARKIT_52_CHANNEL_ORDER.map((channel) => [
            channel,
            channel === 'jawOpen'
              ? ['face_jawOpen', 'teeth_jawOpen']
              : [`face_${channel}`]
          ])
        ),
        tongue: new Map(
          AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.map((channel) => [channel, [`tongue_${channel}`]])
        )
      }
    )

    expect(resolved).not.toBeNull()
    expect(resolved?.get('face_jawOpen')).toBe(0.7)
    expect(resolved?.get('teeth_jawOpen')).toBe(0.7)
    expect(resolved?.get('face_eyeBlinkLeft')).toBe(0.4)
    expect(resolved?.has('face_eyeLookOutLeft')).toBe(false)
    expect(resolved?.get('tongue_tongueTipUp')).toBe(0.6)
  })

  it('rejects partial ARKit packages instead of partially direct-driving them', () => {
    const weights = createEmptyArkit52Weights()
    expect(
      resolveDirectCustomArkitFaceDriverWeights(
        { profile: 'arkit-52', weights },
        {
          face: new Map(
            ARKIT_52_CHANNEL_ORDER.slice(1).map((channel) => [channel, [channel]])
          )
        }
      )
    ).toBeNull()
  })
})

import type { Object3D } from 'three'

import { resolveCustomNamedNode, type GoonCustomAvatarManifest } from '$lib/goons/customAvatar'
import {
  CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER,
  CUSTOM_RHUBARB_MOUTH_ORDER
} from '$lib/goons/semanticVisemes'
import {
  ARKIT_52_CHANNEL_ORDER,
  ARKIT_52_FACE_DRIVER_PROFILE,
  AUDIO2FACE_16_TONGUE_CHANNEL_ORDER,
  OVR_15_SPEECH_FACE_PROFILE,
  OVR_15_VISEME_ORDER,
  RHUBARB_9_SPEECH_FACE_PROFILE,
  projectGoonSpeechFaceFrameToOvr15,
  projectGoonSpeechFaceFrameToRhubarb9,
  type Arkit52Channel,
  type Audio2FaceTongueChannel,
  type GoonSpeechFaceFrame,
  type GoonSpeechFaceProfile
} from '$lib/goons/speechFaceProfiles'
import type { GoonExpressionPreset } from '$lib/types/goons'
import {
  downmixGoonLipSyncWeightsToLegacy,
} from '$lib/utils/goonLipSync'

export const CUSTOM_LEGACY_MOUTH_PRESET_ORDER = [
  'aa',
  'ih',
  'ou',
  'ee',
  'oh'
] as const satisfies readonly GoonExpressionPreset[]

export const CUSTOM_COMPATIBLE_MOUTH_PRESET_ORDER = [
  ...OVR_15_VISEME_ORDER,
  ...CUSTOM_RHUBARB_MOUTH_ORDER,
  ...CUSTOM_LEGACY_MOUTH_PRESET_ORDER
] as const satisfies readonly GoonExpressionPreset[]

const CUSTOM_COMPATIBLE_MOUTH_PRESETS = new Set<GoonExpressionPreset>(
  CUSTOM_COMPATIBLE_MOUTH_PRESET_ORDER
)

export function isCustomCompatibleMouthPreset(
  preset: GoonExpressionPreset
): boolean {
  return CUSTOM_COMPATIBLE_MOUTH_PRESETS.has(preset)
}

export type CustomMouthPresetMode = 'ovr' | 'semantic' | 'legacy' | 'none'

export type CustomMouthPresetSupport = {
  mode: CustomMouthPresetMode
  profile: GoonSpeechFaceProfile | 'vrm-vowels-5' | null
  availablePresets: GoonExpressionPreset[]
}

export type CustomRigCompatibilityCoverage = {
  present: number
  total: number
  missingCoreBones: string[]
  missingUpperBody: string[]
  missingArms: string[]
}

type CustomRigCoverageGroup = {
  label: string
  category: 'core' | 'upper-body' | 'arms'
  conventionalNames: string[]
  declaredSuffixes: string[]
  manifestNames: (manifest: GoonCustomAvatarManifest) => string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeBoneName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function stringValues(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function performanceNodeName(manifest: GoonCustomAvatarManifest, role: 'head' | 'neck') {
  if (!isRecord(manifest.rig) || !isRecord(manifest.rig.performance)) return []
  const nodes = manifest.rig.performance.nodes
  if (!isRecord(nodes) || !isRecord(nodes[role])) return []
  const node = nodes[role].node
  return typeof node === 'string' && node.trim() ? [node] : []
}

function declaredRigNodeNames(manifest: GoonCustomAvatarManifest) {
  if (!isRecord(manifest.rig)) return []
  const names = new Set<string>()
  for (const name of stringValues(manifest.rig.mixamoCoreBones)) {
    names.add(name)
  }
  if (isRecord(manifest.rig.renameMap)) {
    for (const value of Object.values(manifest.rig.renameMap)) {
      if (typeof value === 'string' && value.trim()) names.add(value)
    }
  }
  if (typeof manifest.rig.hips === 'string' && manifest.rig.hips.trim()) {
    names.add(manifest.rig.hips)
  }
  return [...names]
}

const CUSTOM_RIG_COVERAGE_GROUPS: CustomRigCoverageGroup[] = [
  {
    label: 'hips',
    category: 'core',
    conventionalNames: ['mixamorig:Hips', 'mixamorigHips', 'Hips'],
    declaredSuffixes: ['hips'],
    manifestNames: (manifest) => [
      ...(typeof manifest.stage?.anchors?.hips === 'string' ? [manifest.stage.anchors.hips] : []),
      ...(isRecord(manifest.rig) && typeof manifest.rig.hips === 'string' ? [manifest.rig.hips] : [])
    ]
  },
  {
    label: 'spine',
    category: 'upper-body',
    conventionalNames: ['mixamorig:Spine', 'mixamorigSpine', 'Spine'],
    declaredSuffixes: ['spine'],
    manifestNames: () => []
  },
  {
    label: 'chest',
    category: 'upper-body',
    conventionalNames: [
      'mixamorig:Spine1',
      'mixamorigSpine1',
      'mixamorig:Spine2',
      'mixamorigSpine2',
      'Chest',
      'UpperChest'
    ],
    declaredSuffixes: ['spine1', 'spine2', 'chest', 'upperchest'],
    manifestNames: () => []
  },
  {
    label: 'neck',
    category: 'upper-body',
    conventionalNames: ['mixamorig:Neck', 'mixamorigNeck', 'Neck'],
    declaredSuffixes: ['neck'],
    manifestNames: (manifest) => performanceNodeName(manifest, 'neck')
  },
  {
    label: 'head',
    category: 'core',
    conventionalNames: ['mixamorig:Head', 'mixamorigHead', 'Head'],
    declaredSuffixes: ['head'],
    manifestNames: (manifest) => [
      ...(typeof manifest.stage?.anchors?.head === 'string' ? [manifest.stage.anchors.head] : []),
      ...performanceNodeName(manifest, 'head')
    ]
  },
  {
    label: 'rightUpperArm',
    category: 'arms',
    conventionalNames: ['mixamorig:RightArm', 'mixamorigRightArm', 'RightArm'],
    declaredSuffixes: ['rightarm', 'rightupperarm'],
    manifestNames: () => []
  },
  {
    label: 'rightLowerArm',
    category: 'arms',
    conventionalNames: ['mixamorig:RightForeArm', 'mixamorigRightForeArm', 'RightForeArm', 'RightLowerArm'],
    declaredSuffixes: ['rightforearm', 'rightlowerarm'],
    manifestNames: () => []
  }
]

export function resolveCustomRigCompatibilityCoverage(
  root: Object3D,
  manifest: GoonCustomAvatarManifest
): CustomRigCompatibilityCoverage {
  const declaredNames = declaredRigNodeNames(manifest)
  const missingCoreBones: string[] = []
  const missingUpperBody: string[] = []
  const missingArms: string[] = []
  let present = 0

  for (const group of CUSTOM_RIG_COVERAGE_GROUPS) {
    const declaredMatches = declaredNames.filter((name) => {
      const normalized = normalizeBoneName(name)
      return group.declaredSuffixes.some((suffix) => normalized.endsWith(suffix))
    })
    const candidates = [
      ...new Set([
        ...group.manifestNames(manifest),
        ...declaredMatches,
        ...group.conventionalNames
      ])
    ]
    const found = candidates.some((name) => Boolean(resolveCustomNamedNode(root, name)))
    if (found) {
      present += 1
      continue
    }
    if (group.category === 'core') missingCoreBones.push(group.label)
    if (group.category === 'upper-body') missingUpperBody.push(group.label)
    if (group.category === 'arms') missingArms.push(group.label)
  }

  return {
    present,
    total: CUSTOM_RIG_COVERAGE_GROUPS.length,
    missingCoreBones,
    missingUpperBody,
    missingArms
  }
}

export function resolveCustomMouthPresetSupport(
  presets: Iterable<string>,
  declaredProfile: GoonSpeechFaceProfile | null = null
): CustomMouthPresetSupport {
  const available = new Set(presets)
  const ovr = OVR_15_VISEME_ORDER.filter(
    (preset) => preset !== 'sil' && available.has(preset)
  )
  const completeOvr = ovr.length === OVR_15_VISEME_ORDER.length - 1
  if (declaredProfile === OVR_15_SPEECH_FACE_PROFILE) {
    return completeOvr
      ? { mode: 'ovr', profile: OVR_15_SPEECH_FACE_PROFILE, availablePresets: ovr }
      : { mode: 'none', profile: OVR_15_SPEECH_FACE_PROFILE, availablePresets: [] }
  }
  if (!declaredProfile && completeOvr) {
    return { mode: 'ovr', profile: OVR_15_SPEECH_FACE_PROFILE, availablePresets: ovr }
  }

  const semantic = CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER.filter((preset) => available.has(preset))
  if (declaredProfile === RHUBARB_9_SPEECH_FACE_PROFILE) {
    return semantic.length === CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER.length
      ? { mode: 'semantic', profile: RHUBARB_9_SPEECH_FACE_PROFILE, availablePresets: semantic }
      : { mode: 'none', profile: RHUBARB_9_SPEECH_FACE_PROFILE, availablePresets: [] }
  }
  if (semantic.length > 0) {
    return { mode: 'semantic', profile: RHUBARB_9_SPEECH_FACE_PROFILE, availablePresets: semantic }
  }

  const legacy = CUSTOM_LEGACY_MOUTH_PRESET_ORDER.filter((preset) => available.has(preset))
  if (legacy.length > 0) {
    return { mode: 'legacy', profile: 'vrm-vowels-5', availablePresets: legacy }
  }

  return { mode: 'none', profile: declaredProfile, availablePresets: [] }
}

export function resolveCustomLipSyncPresetWeights(
  frame: GoonSpeechFaceFrame,
  support: CustomMouthPresetSupport
) {
  const resolved = new Map<GoonExpressionPreset, number>()
  if (support.mode === 'ovr') {
    const weights = projectGoonSpeechFaceFrameToOvr15(frame)
    for (const preset of support.availablePresets) {
      const value = weights[preset as keyof typeof weights]
      if (typeof value === 'number' && value > 0.001) resolved.set(preset, value)
    }
    return resolved
  }

  if (support.mode === 'semantic') {
    const weights = projectGoonSpeechFaceFrameToRhubarb9(frame)
    for (const preset of support.availablePresets) {
      const value = weights[preset as keyof typeof weights]
      if (typeof value === 'number' && value > 0.001) resolved.set(preset, value)
    }
    return resolved
  }

  if (support.mode === 'legacy') {
    const legacyWeights = downmixGoonLipSyncWeightsToLegacy(
      projectGoonSpeechFaceFrameToRhubarb9(frame)
    )
    for (const preset of support.availablePresets) {
      const value = legacyWeights[preset as keyof typeof legacyWeights]
      if (typeof value === 'number' && value > 0.001) resolved.set(preset, value)
    }
  }
  return resolved
}

const BATSHIT_OWNED_ARKIT_EYE_LOOK_CHANNELS = new Set<string>([
  'eyeLookDownLeft',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeLookDownRight',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight'
])

/**
 * Preserve continuous Audio2Face ARKit output only for packages that expose the
 * exact ARKit-52 target inventory. Audio2Face 2.0 does not provide head motion
 * and emits zero eye-look weights, so Batshit's eye-bone gaze system retains
 * those eight channels while blink, squint, brow, jaw, mouth, cheek, nose, and
 * tongue deformation stay direct.
 */
export function resolveDirectCustomArkitFaceDriverWeights(
  frame: GoonSpeechFaceFrame,
  bindings: {
    face: ReadonlyMap<Arkit52Channel, readonly string[]>
    tongue?: ReadonlyMap<Audio2FaceTongueChannel, readonly string[]> | null
  }
): Map<string, number> | null {
  if (frame.profile !== ARKIT_52_FACE_DRIVER_PROFILE) return null

  if (!ARKIT_52_CHANNEL_ORDER.every((channel) => bindings.face.has(channel))) return null

  const resolved = new Map<string, number>()
  for (const channel of ARKIT_52_CHANNEL_ORDER) {
    if (BATSHIT_OWNED_ARKIT_EYE_LOOK_CHANNELS.has(channel)) continue
    for (const target of bindings.face.get(channel) ?? []) {
      resolved.set(target, frame.weights[channel])
    }
  }

  if (
    frame.tongueWeights &&
    bindings.tongue &&
    AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.every((channel) => bindings.tongue?.has(channel))
  ) {
    for (const channel of AUDIO2FACE_16_TONGUE_CHANNEL_ORDER) {
      for (const target of bindings.tongue.get(channel) ?? []) {
        resolved.set(target, frame.tongueWeights[channel])
      }
    }
  }

  return resolved
}

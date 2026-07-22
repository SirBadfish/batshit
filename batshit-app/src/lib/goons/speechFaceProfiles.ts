import {
  CUSTOM_RHUBARB_MOUTH_ORDER,
  createEmptyCustomRhubarbMouthWeights,
  type CustomRhubarbMouthCue,
  type CustomRhubarbMouthWeights
} from '$lib/goons/semanticVisemes'

export const GOON_SPEECH_FACE_PROFILE_SCHEMA = 'batshit-speech-face/v1' as const
export const RHUBARB_9_SPEECH_FACE_PROFILE = 'rhubarb-9' as const
export const OVR_15_SPEECH_FACE_PROFILE = 'ovr-15' as const
export const ARKIT_52_FACE_DRIVER_PROFILE = 'arkit-52' as const

export const ARKIT_52_CHANNEL_ORDER = [
  'eyeBlinkLeft',
  'eyeLookDownLeft',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeSquintLeft',
  'eyeWideLeft',
  'eyeBlinkRight',
  'eyeLookDownRight',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeSquintRight',
  'eyeWideRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthLeft',
  'mouthRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut'
] as const

export const AUDIO2FACE_16_TONGUE_CHANNEL_ORDER = [
  'tongueTipUp',
  'tongueTipDown',
  'tongueTipLeft',
  'tongueTipRight',
  'tongueRollUp',
  'tongueRollDown',
  'tongueRollLeft',
  'tongueRollRight',
  'tongueUp',
  'tongueDown',
  'tongueLeft',
  'tongueRight',
  'tongueIn',
  'tongueStretch',
  'tongueWide',
  'tongueNarrow'
] as const

export const OVR_15_VISEME_ORDER = [
  'sil',
  'PP',
  'FF',
  'TH',
  'DD',
  'kk',
  'CH',
  'SS',
  'nn',
  'RR',
  'aa',
  'E',
  'I',
  'O',
  'U'
] as const

export type Ovr15Viseme = (typeof OVR_15_VISEME_ORDER)[number]
export type Ovr15Weights = Record<Ovr15Viseme, number>
export type Arkit52Channel = (typeof ARKIT_52_CHANNEL_ORDER)[number]
export type Arkit52Weights = Record<Arkit52Channel, number>
export type Audio2FaceTongueChannel = (typeof AUDIO2FACE_16_TONGUE_CHANNEL_ORDER)[number]
export type Audio2FaceTongueWeights = Record<Audio2FaceTongueChannel, number>
export type GoonSpeechFaceProfile =
  | typeof RHUBARB_9_SPEECH_FACE_PROFILE
  | typeof OVR_15_SPEECH_FACE_PROFILE
export type GoonFaceDriverProfile =
  | GoonSpeechFaceProfile
  | typeof ARKIT_52_FACE_DRIVER_PROFILE

export type GoonSpeechFaceFrame =
  | {
      profile: typeof RHUBARB_9_SPEECH_FACE_PROFILE
      weights: CustomRhubarbMouthWeights
    }
  | {
      profile: typeof OVR_15_SPEECH_FACE_PROFILE
      weights: Ovr15Weights
    }
  | {
      profile: typeof ARKIT_52_FACE_DRIVER_PROFILE
      weights: Arkit52Weights
      tongueWeights?: Audio2FaceTongueWeights
    }

export type GoonSpeechFaceProfileDeclaration = {
  schemaVersion: typeof GOON_SPEECH_FACE_PROFILE_SCHEMA
  profile: GoonSpeechFaceProfile
  neutral: CustomRhubarbMouthCue | Ovr15Viseme
  channels: string[]
}

export type ResolvedGoonSpeechFaceProfileDeclaration = {
  profile: GoonSpeechFaceProfile | null
  issues: string[]
}

const clamp01 = (value: unknown) => {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createEmptyOvr15Weights(): Ovr15Weights {
  return Object.fromEntries(OVR_15_VISEME_ORDER.map((viseme) => [viseme, 0])) as Ovr15Weights
}

export function createEmptyArkit52Weights(): Arkit52Weights {
  return Object.fromEntries(ARKIT_52_CHANNEL_ORDER.map((channel) => [channel, 0])) as Arkit52Weights
}

export function createEmptyAudio2FaceTongueWeights(): Audio2FaceTongueWeights {
  return Object.fromEntries(
    AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.map((channel) => [channel, 0])
  ) as Audio2FaceTongueWeights
}

export function createEmptyGoonSpeechFaceFrame(
  profile: GoonFaceDriverProfile
): GoonSpeechFaceFrame {
  if (profile === ARKIT_52_FACE_DRIVER_PROFILE) {
    return { profile, weights: createEmptyArkit52Weights() }
  }
  if (profile === OVR_15_SPEECH_FACE_PROFILE) {
    return { profile, weights: createEmptyOvr15Weights() }
  }
  return { profile, weights: createEmptyCustomRhubarbMouthWeights() }
}

export function cloneGoonSpeechFaceFrame(frame: GoonSpeechFaceFrame): GoonSpeechFaceFrame {
  if (frame.profile === ARKIT_52_FACE_DRIVER_PROFILE) {
    const weights = createEmptyArkit52Weights()
    for (const channel of ARKIT_52_CHANNEL_ORDER) {
      weights[channel] = clamp01(frame.weights[channel])
    }
    if (!frame.tongueWeights) return { profile: frame.profile, weights }
    const tongueWeights = createEmptyAudio2FaceTongueWeights()
    for (const channel of AUDIO2FACE_16_TONGUE_CHANNEL_ORDER) {
      tongueWeights[channel] = clamp01(frame.tongueWeights[channel])
    }
    return { profile: frame.profile, weights, tongueWeights }
  }
  if (frame.profile === OVR_15_SPEECH_FACE_PROFILE) {
    const weights = createEmptyOvr15Weights()
    for (const viseme of OVR_15_VISEME_ORDER) {
      weights[viseme] = clamp01(frame.weights[viseme])
    }
    return { profile: frame.profile, weights }
  }

  const weights = createEmptyCustomRhubarbMouthWeights()
  for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
    weights[cue] = clamp01(frame.weights[cue])
  }
  return { profile: frame.profile, weights }
}

export function sameGoonSpeechFaceFrame(
  left: GoonSpeechFaceFrame,
  right: GoonSpeechFaceFrame
): boolean {
  if (left.profile !== right.profile) return false
  if (left.profile === ARKIT_52_FACE_DRIVER_PROFILE && right.profile === ARKIT_52_FACE_DRIVER_PROFILE) {
    const faceMatches = ARKIT_52_CHANNEL_ORDER.every(
      (channel) => Math.abs(left.weights[channel] - right.weights[channel]) < 0.0001
    )
    if (!faceMatches || Boolean(left.tongueWeights) !== Boolean(right.tongueWeights)) return false
    if (!left.tongueWeights || !right.tongueWeights) return true
    return AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.every(
      (channel) => Math.abs(left.tongueWeights![channel] - right.tongueWeights![channel]) < 0.0001
    )
  }
  if (left.profile === OVR_15_SPEECH_FACE_PROFILE && right.profile === OVR_15_SPEECH_FACE_PROFILE) {
    return OVR_15_VISEME_ORDER.every(
      (viseme) => Math.abs(left.weights[viseme] - right.weights[viseme]) < 0.0001
    )
  }
  if (left.profile === RHUBARB_9_SPEECH_FACE_PROFILE && right.profile === RHUBARB_9_SPEECH_FACE_PROFILE) {
    return CUSTOM_RHUBARB_MOUTH_ORDER.every(
      (cue) => Math.abs(left.weights[cue] - right.weights[cue]) < 0.0001
    )
  }
  return false
}

export function lerpGoonSpeechFaceFrames(
  from: GoonSpeechFaceFrame,
  to: GoonSpeechFaceFrame,
  amount: number
): GoonSpeechFaceFrame {
  if (from.profile !== to.profile) {
    throw new Error(
      `Cannot blend speech-face frames from different profiles (${from.profile} -> ${to.profile}).`
    )
  }
  const clampedAmount = clamp01(amount)
  if (from.profile === ARKIT_52_FACE_DRIVER_PROFILE && to.profile === ARKIT_52_FACE_DRIVER_PROFILE) {
    const weights = createEmptyArkit52Weights()
    for (const channel of ARKIT_52_CHANNEL_ORDER) {
      weights[channel] = from.weights[channel] + (to.weights[channel] - from.weights[channel]) * clampedAmount
    }
    if (!from.tongueWeights && !to.tongueWeights) return { profile: from.profile, weights }
    const fromTongue = from.tongueWeights ?? createEmptyAudio2FaceTongueWeights()
    const toTongue = to.tongueWeights ?? createEmptyAudio2FaceTongueWeights()
    const tongueWeights = createEmptyAudio2FaceTongueWeights()
    for (const channel of AUDIO2FACE_16_TONGUE_CHANNEL_ORDER) {
      tongueWeights[channel] = fromTongue[channel] + (toTongue[channel] - fromTongue[channel]) * clampedAmount
    }
    return { profile: from.profile, weights, tongueWeights }
  }
  if (from.profile === OVR_15_SPEECH_FACE_PROFILE && to.profile === OVR_15_SPEECH_FACE_PROFILE) {
    const weights = createEmptyOvr15Weights()
    for (const viseme of OVR_15_VISEME_ORDER) {
      weights[viseme] = from.weights[viseme] + (to.weights[viseme] - from.weights[viseme]) * clampedAmount
    }
    return { profile: from.profile, weights }
  }
  if (from.profile === RHUBARB_9_SPEECH_FACE_PROFILE && to.profile === RHUBARB_9_SPEECH_FACE_PROFILE) {
    const weights = createEmptyCustomRhubarbMouthWeights()
    for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
      weights[cue] = from.weights[cue] + (to.weights[cue] - from.weights[cue]) * clampedAmount
    }
    return { profile: from.profile, weights }
  }
  throw new Error('Speech-face frame profile narrowing failed.')
}

export function scaleGoonSpeechFaceFrame(
  frame: GoonSpeechFaceFrame,
  amount: number
): GoonSpeechFaceFrame {
  const scale = Math.max(0, Number.isFinite(amount) ? amount : 0)
  const next = cloneGoonSpeechFaceFrame(frame)
  if (next.profile === ARKIT_52_FACE_DRIVER_PROFILE) {
    for (const channel of ARKIT_52_CHANNEL_ORDER) {
      next.weights[channel] = clamp01(next.weights[channel] * scale)
    }
    if (next.tongueWeights) {
      for (const channel of AUDIO2FACE_16_TONGUE_CHANNEL_ORDER) {
        next.tongueWeights[channel] = clamp01(next.tongueWeights[channel] * scale)
      }
    }
  } else if (next.profile === OVR_15_SPEECH_FACE_PROFILE) {
    for (const viseme of OVR_15_VISEME_ORDER) {
      next.weights[viseme] = clamp01(next.weights[viseme] * scale)
    }
  } else {
    for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
      next.weights[cue] = clamp01(next.weights[cue] * scale)
    }
  }
  return next
}

function addRhubarbProjection(
  weights: CustomRhubarbMouthWeights,
  patch: Partial<CustomRhubarbMouthWeights>,
  amount: number
) {
  for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
    weights[cue] = clamp01(weights[cue] + (patch[cue] ?? 0) * amount)
  }
}

const OVR_TO_RHUBARB_PROJECTION: Record<Ovr15Viseme, Partial<CustomRhubarbMouthWeights>> = {
  sil: { rest: 1 },
  PP: { closed: 1 },
  FF: { teeth_lip: 1 },
  TH: { clenched: 0.78, pucker: 0.16 },
  DD: { clenched: 0.92 },
  kk: { clenched: 0.92 },
  CH: { tongue_lift: 0.76, clenched: 0.42, pucker: 0.18 },
  SS: { clenched: 0.92 },
  nn: { tongue_lift: 0.95, mid_open: 0.16 },
  RR: { tongue_lift: 0.56, round: 0.48 },
  aa: { wide_open: 0.92, mid_open: 0.32 },
  E: { mid_open: 0.9, wide_open: 0.28 },
  I: { clenched: 0.9, mid_open: 0.14 },
  O: { round: 0.92, pucker: 0.18 },
  U: { pucker: 0.95, round: 0.2 }
}

function maxArkitWeight(weights: Arkit52Weights, ...channels: Arkit52Channel[]) {
  return channels.reduce((maximum, channel) => Math.max(maximum, clamp01(weights[channel])), 0)
}

function projectArkit52ToRhubarb9(frame: Extract<GoonSpeechFaceFrame, { profile: 'arkit-52' }>) {
  const weights = createEmptyCustomRhubarbMouthWeights()
  const source = frame.weights
  const jawOpen = clamp01(source.jawOpen)
  weights.closed = maxArkitWeight(source, 'mouthClose', 'mouthPressLeft', 'mouthPressRight')
  weights.clenched = maxArkitWeight(
    source,
    'mouthStretchLeft',
    'mouthStretchRight',
    'mouthSmileLeft',
    'mouthSmileRight'
  )
  weights.mid_open = clamp01(
    Math.max(jawOpen * 0.66, source.mouthShrugLower, source.mouthLowerDownLeft, source.mouthLowerDownRight)
  )
  weights.wide_open = clamp01(
    Math.max(jawOpen, source.mouthLowerDownLeft * 0.82, source.mouthLowerDownRight * 0.82)
  )
  weights.round = maxArkitWeight(source, 'mouthFunnel', 'mouthPucker')
  weights.pucker = maxArkitWeight(source, 'mouthPucker', 'mouthFunnel')
  weights.teeth_lip = maxArkitWeight(source, 'mouthRollLower', 'mouthUpperUpLeft', 'mouthUpperUpRight')
  weights.tongue_lift = clamp01(
    Math.max(
      source.tongueOut,
      frame.tongueWeights?.tongueTipUp ?? 0,
      frame.tongueWeights?.tongueUp ?? 0,
      frame.tongueWeights?.tongueStretch ?? 0
    )
  )
  const active = CUSTOM_RHUBARB_MOUTH_ORDER
    .filter((cue) => cue !== 'rest')
    .reduce((maximum, cue) => Math.max(maximum, weights[cue]), 0)
  weights.rest = active < 0.02 ? 1 : 0
  return weights
}

export function projectGoonSpeechFaceFrameToRhubarb9(
  frame: GoonSpeechFaceFrame
): CustomRhubarbMouthWeights {
  if (frame.profile === RHUBARB_9_SPEECH_FACE_PROFILE) {
    const weights = createEmptyCustomRhubarbMouthWeights()
    for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
      weights[cue] = clamp01(frame.weights[cue])
    }
    return weights
  }

  if (frame.profile === ARKIT_52_FACE_DRIVER_PROFILE) {
    return projectArkit52ToRhubarb9(frame)
  }

  const weights = createEmptyCustomRhubarbMouthWeights()
  for (const viseme of OVR_15_VISEME_ORDER) {
    const amount = clamp01(frame.weights[viseme])
    if (amount <= 0) continue
    addRhubarbProjection(weights, OVR_TO_RHUBARB_PROJECTION[viseme], amount)
  }
  return weights
}

function addOvrProjection(
  weights: Ovr15Weights,
  patch: Partial<Ovr15Weights>,
  amount: number
) {
  for (const viseme of OVR_15_VISEME_ORDER) {
    weights[viseme] = clamp01(weights[viseme] + (patch[viseme] ?? 0) * amount)
  }
}

const RHUBARB_TO_OVR_PROJECTION: Record<CustomRhubarbMouthCue, Partial<Ovr15Weights>> = {
  rest: { sil: 1 },
  closed: { PP: 1 },
  clenched: { SS: 0.7, I: 0.3 },
  mid_open: { E: 0.75, aa: 0.25 },
  wide_open: { aa: 1 },
  round: { O: 0.85, U: 0.15 },
  pucker: { U: 0.85, O: 0.15 },
  teeth_lip: { FF: 1 },
  tongue_lift: { nn: 0.7, TH: 0.3 }
}

export function projectGoonSpeechFaceFrameToOvr15(frame: GoonSpeechFaceFrame): Ovr15Weights {
  if (frame.profile === OVR_15_SPEECH_FACE_PROFILE) {
    const weights = createEmptyOvr15Weights()
    for (const viseme of OVR_15_VISEME_ORDER) {
      weights[viseme] = clamp01(frame.weights[viseme])
    }
    return weights
  }

  if (frame.profile === ARKIT_52_FACE_DRIVER_PROFILE) {
    const rhubarbWeights = projectArkit52ToRhubarb9(frame)
    const weights = createEmptyOvr15Weights()
    for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
      const amount = clamp01(rhubarbWeights[cue])
      if (amount <= 0) continue
      addOvrProjection(weights, RHUBARB_TO_OVR_PROJECTION[cue], amount)
    }
    return weights
  }

  const weights = createEmptyOvr15Weights()
  for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
    const amount = clamp01(frame.weights[cue])
    if (amount <= 0) continue
    addOvrProjection(weights, RHUBARB_TO_OVR_PROJECTION[cue], amount)
  }
  return weights
}

export function resolveGoonSpeechFaceProfileDeclaration(
  value: unknown
): ResolvedGoonSpeechFaceProfileDeclaration {
  if (value === undefined || value === null) return { profile: null, issues: [] }
  if (!isRecord(value)) {
    return { profile: null, issues: ['face.speechProfile must be an object.'] }
  }

  const knownKeys = new Set(['schemaVersion', 'profile', 'neutral', 'channels'])
  const unknownKeys = Object.keys(value).filter((key) => !knownKeys.has(key))
  const issues = unknownKeys.map((key) => `face.speechProfile contains unknown field "${key}".`)

  if (value.schemaVersion !== GOON_SPEECH_FACE_PROFILE_SCHEMA) {
    issues.push(`face.speechProfile.schemaVersion must be "${GOON_SPEECH_FACE_PROFILE_SCHEMA}".`)
  }

  const profile =
    value.profile === RHUBARB_9_SPEECH_FACE_PROFILE || value.profile === OVR_15_SPEECH_FACE_PROFILE
      ? value.profile
      : null
  if (!profile) {
    issues.push('face.speechProfile.profile must be "rhubarb-9" or "ovr-15".')
    return { profile: null, issues }
  }

  const expectedChannels =
    profile === OVR_15_SPEECH_FACE_PROFILE ? [...OVR_15_VISEME_ORDER] : [...CUSTOM_RHUBARB_MOUTH_ORDER]
  const expectedNeutral = profile === OVR_15_SPEECH_FACE_PROFILE ? 'sil' : 'rest'
  if (value.neutral !== expectedNeutral) {
    issues.push(`face.speechProfile.neutral must be "${expectedNeutral}" for ${profile}.`)
  }
  const actualChannels = Array.isArray(value.channels) ? value.channels : null
  if (
    actualChannels === null ||
    actualChannels.length !== expectedChannels.length ||
    expectedChannels.some((channel, index) => actualChannels[index] !== channel)
  ) {
    issues.push(
      `face.speechProfile.channels must exactly match the ordered ${profile} inventory: ${expectedChannels.join(', ')}.`
    )
  }

  return { profile: issues.length === 0 ? profile : null, issues }
}

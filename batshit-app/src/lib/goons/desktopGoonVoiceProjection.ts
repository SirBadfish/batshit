import type { GoonSpeechFaceFrame } from '$lib/goons/speechFaceProfiles'
import type { GoonLipSyncAnalyzerId, GoonLipSyncTimeline } from '$lib/utils/goonLipSync'

type VoiceIdentity = {
  generation: string
  agentId: string | null
  messageId: string | null
}

export type DesktopGoonVoiceVisualProjection =
  | (VoiceIdentity & {
      kind: 'start'
      startedAtMs: number
      durationMs: number | null
      analyzerId: GoonLipSyncAnalyzerId | null
      timeline: GoonLipSyncTimeline | null
    })
  | (VoiceIdentity & {
      kind: 'frame'
      atMs: number
      elapsedMs: number
      frame: GoonSpeechFaceFrame | null
      audioLevel: number | null
    })
  | (VoiceIdentity & {
      kind: 'alignment'
      atMs: number
      durationMs: number | null
      analyzerId: GoonLipSyncAnalyzerId
      timeline: GoonLipSyncTimeline
    })
  | (VoiceIdentity & {
      kind: 'end'
      endedAtMs: number
    })

export type DesktopGoonVoiceProjectionResult =
  | { ok: true; value: DesktopGoonVoiceVisualProjection }
  | {
      ok: false
      code: 'INVALID_INPUT' | 'FORBIDDEN_AUDIO_OWNER' | 'NOT_CLONE_SAFE'
      message: string
    }

const FORBIDDEN_AUDIO_KEYS = new Set([
  'audio',
  'audioContext',
  'audioBuffer',
  'rawAudio',
  'pcm',
  'pcmBytes',
  'mediaStream',
  'srcObject',
  'arrayBuffer',
  'buffer'
])

const FORBIDDEN_AUDIO_CONSTRUCTORS = new Set([
  'HTMLAudioElement',
  'HTMLMediaElement',
  'AudioContext',
  'OfflineAudioContext',
  'AudioBuffer',
  'MediaStream',
  'MediaStreamTrack',
  'Blob',
  'File',
  'ArrayBuffer',
  'Uint8Array',
  'Int16Array',
  'Float32Array'
])

const COMMON_KEYS = new Set(['kind', 'generation', 'agentId', 'messageId'])
const KIND_KEYS: Record<DesktopGoonVoiceVisualProjection['kind'], ReadonlySet<string>> = {
  start: new Set([...COMMON_KEYS, 'startedAtMs', 'durationMs', 'analyzerId', 'timeline']),
  frame: new Set([...COMMON_KEYS, 'atMs', 'elapsedMs', 'frame', 'audioLevel']),
  alignment: new Set([...COMMON_KEYS, 'atMs', 'durationMs', 'analyzerId', 'timeline']),
  end: new Set([...COMMON_KEYS, 'endedAtMs'])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsForbiddenAudioOwner(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || value === undefined || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)

  const constructorName = value.constructor?.name
  if (constructorName && FORBIDDEN_AUDIO_CONSTRUCTORS.has(constructorName)) return true
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenAudioOwner(entry, seen))
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_AUDIO_KEYS.has(key)) return true
    if (containsForbiddenAudioOwner(entry, seen)) return true
  }
  return false
}

function isCloneSafePlainData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) {
    return value.every((entry) => isCloneSafePlainData(entry, seen))
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return false
  }
  return Object.values(value).every((entry) => isCloneSafePlainData(entry, seen))
}

function validOptionalId(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || (typeof value === 'string' && value.length <= 256)
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validNullableNonNegativeNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || validNonNegativeNumber(value)
}

function validSpeechFaceFrame(value: unknown): value is GoonSpeechFaceFrame {
  if (!isRecord(value) || typeof value.profile !== 'string' || !isRecord(value.weights)) return false
  if (!['rhubarb-9', 'ovr-15', 'arkit-52'].includes(value.profile)) return false
  const weightsValid = Object.values(value.weights).every(
    (weight) => typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 1
  )
  if (!weightsValid) return false
  if (value.tongueWeights !== undefined) {
    if (!isRecord(value.tongueWeights)) return false
    return Object.values(value.tongueWeights).every(
      (weight) => typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 1
    )
  }
  return true
}

function cloneProjection(value: Record<string, unknown>): DesktopGoonVoiceVisualProjection {
  return JSON.parse(JSON.stringify(value)) as DesktopGoonVoiceVisualProjection
}

export function projectDesktopGoonVoiceVisual(
  input: unknown
): DesktopGoonVoiceProjectionResult {
  if (containsForbiddenAudioOwner(input)) {
    return {
      ok: false,
      code: 'FORBIDDEN_AUDIO_OWNER',
      message: 'Desktop Goon visual state cannot carry audio elements, contexts, streams, or raw audio.'
    }
  }
  if (!isRecord(input)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Voice visual state must be an object.' }
  }
  if (!isCloneSafePlainData(input)) {
    return {
      ok: false,
      code: 'NOT_CLONE_SAFE',
      message: 'Voice visual state must contain only finite structured-clone-safe plain data.'
    }
  }
  const kind = input.kind
  if (kind !== 'start' && kind !== 'frame' && kind !== 'alignment' && kind !== 'end') {
    return { ok: false, code: 'INVALID_INPUT', message: 'Unknown Desktop Goon voice visual kind.' }
  }
  if (Object.keys(input).some((key) => !KIND_KEYS[kind].has(key))) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `Desktop Goon voice ${kind} contains an unsupported field.`
    }
  }
  if (
    typeof input.generation !== 'string' ||
    !input.generation.trim() ||
    input.generation.length > 128 ||
    !validOptionalId(input.agentId) ||
    !validOptionalId(input.messageId)
  ) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Voice visual identity is invalid.' }
  }

  if (kind === 'start') {
    if (
      !validNonNegativeNumber(input.startedAtMs) ||
      !validNullableNonNegativeNumber(input.durationMs) ||
      !(input.analyzerId === null || input.analyzerId === undefined || typeof input.analyzerId === 'string') ||
      !(input.timeline === null || input.timeline === undefined || isRecord(input.timeline))
    ) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Voice start visual state is invalid.' }
    }
  } else if (kind === 'frame') {
    const hasFrame = input.frame !== null && input.frame !== undefined
    const hasLevel = input.audioLevel !== null && input.audioLevel !== undefined
    if (
      !validNonNegativeNumber(input.atMs) ||
      !validNonNegativeNumber(input.elapsedMs) ||
      (!hasFrame && !hasLevel) ||
      (hasFrame && !validSpeechFaceFrame(input.frame)) ||
      (hasLevel &&
        !(typeof input.audioLevel === 'number' && input.audioLevel >= 0 && input.audioLevel <= 1))
    ) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Voice frame visual state is invalid.' }
    }
  } else if (kind === 'alignment') {
    if (
      !validNonNegativeNumber(input.atMs) ||
      !validNullableNonNegativeNumber(input.durationMs) ||
      typeof input.analyzerId !== 'string' ||
      !isRecord(input.timeline)
    ) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Voice alignment visual state is invalid.' }
    }
  } else if (!validNonNegativeNumber(input.endedAtMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Voice end visual state is invalid.' }
  }

  return { ok: true, value: cloneProjection(input) }
}

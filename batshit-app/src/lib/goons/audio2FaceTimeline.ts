import {
  ARKIT_52_CHANNEL_ORDER,
  ARKIT_52_FACE_DRIVER_PROFILE,
  AUDIO2FACE_16_TONGUE_CHANNEL_ORDER,
  createEmptyArkit52Weights,
  createEmptyAudio2FaceTongueWeights,
  type Arkit52Channel,
  type Audio2FaceTongueChannel,
  type GoonSpeechFaceFrame
} from '$lib/goons/speechFaceProfiles'
import type {
  AudioLedGoonLipSyncResult,
  GoonLipSyncTimeline,
  GoonLipSyncTimelineDiagnostics
} from '$lib/utils/goonLipSync'

export const AUDIO2FACE_BRIDGE_SCHEMA = 'batshit-audio2face/v1' as const
export const AUDIO2FACE_OUTPUT_FPS = 30 as const

export type Audio2FaceBridgeFrame = {
  timeCode: number
  values: number[]
}

export type Audio2FaceBridgeResponse = {
  schemaVersion: typeof AUDIO2FACE_BRIDGE_SCHEMA
  status: 'success'
  fps: typeof AUDIO2FACE_OUTPUT_FPS
  shapeNames: string[]
  frames: Audio2FaceBridgeFrame[]
  durationMs: number
  cacheHit: boolean
  cacheKey?: string
  nimEndpoint?: string
}

type NormalizedAudio2FaceChannel = Arkit52Channel | Audio2FaceTongueChannel

const CANONICAL_CHANNEL_BY_SOURCE_NAME = new Map<string, NormalizedAudio2FaceChannel>()
for (const channel of [...ARKIT_52_CHANNEL_ORDER, ...AUDIO2FACE_16_TONGUE_CHANNEL_ORDER]) {
  CANONICAL_CHANNEL_BY_SOURCE_NAME.set(channel, channel)
  CANONICAL_CHANNEL_BY_SOURCE_NAME.set(`${channel[0].toUpperCase()}${channel.slice(1)}`, channel)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`)
  }
  return value
}

function normalizeWeight(value: unknown, path: string): number {
  const numeric = requireFiniteNumber(value, path)
  if (numeric < -0.0001 || numeric > 1.0001) {
    throw new Error(`${path} must be within the clamped 0..1 Audio2Face output range.`)
  }
  return Math.max(0, Math.min(1, numeric))
}

export function normalizeAudio2FaceChannelName(value: unknown): NormalizedAudio2FaceChannel {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('Audio2Face shape names must be non-empty strings without surrounding whitespace.')
  }
  const normalized = CANONICAL_CHANNEL_BY_SOURCE_NAME.get(value)
  if (!normalized) {
    throw new Error(`Audio2Face returned unsupported shape name "${value}".`)
  }
  return normalized
}

function normalizeShapeInventory(shapeNames: unknown) {
  if (!Array.isArray(shapeNames)) {
    throw new Error('Audio2Face shapeNames must be an array.')
  }
  if (
    shapeNames.length !== ARKIT_52_CHANNEL_ORDER.length &&
    shapeNames.length !== ARKIT_52_CHANNEL_ORDER.length + AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.length
  ) {
    throw new Error('Audio2Face must return exactly 52 ARKit shapes or 68 ARKit-plus-tongue shapes.')
  }

  const channels = shapeNames.map((name) => normalizeAudio2FaceChannelName(name))
  const unique = new Set(channels)
  if (unique.size !== channels.length) {
    throw new Error('Audio2Face shapeNames contain duplicate channels after PascalCase normalization.')
  }
  const missingFace = ARKIT_52_CHANNEL_ORDER.filter((channel) => !unique.has(channel))
  if (missingFace.length > 0) {
    throw new Error(`Audio2Face is missing required ARKit-52 channels: ${missingFace.join(', ')}.`)
  }
  const tongueCount = AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.filter((channel) => unique.has(channel)).length
  if (tongueCount !== 0 && tongueCount !== AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.length) {
    throw new Error('Audio2Face optional tongue output must contain the complete 16-channel inventory.')
  }

  return {
    channels,
    tongueEnabled: tongueCount === AUDIO2FACE_16_TONGUE_CHANNEL_ORDER.length
  }
}

function normalizeFrame(
  value: unknown,
  index: number,
  channels: NormalizedAudio2FaceChannel[],
  tongueEnabled: boolean,
  previousTimeCode: number | null
) {
  if (!isRecord(value)) throw new Error(`Audio2Face frames[${index}] must be an object.`)
  const timeCode = requireFiniteNumber(value.timeCode, `Audio2Face frames[${index}].timeCode`)
  if (timeCode < 0) throw new Error(`Audio2Face frames[${index}].timeCode cannot be negative.`)
  if (previousTimeCode !== null && timeCode <= previousTimeCode) {
    throw new Error('Audio2Face frame time codes must be strictly increasing.')
  }
  const values = value.values
  if (!Array.isArray(values) || values.length !== channels.length) {
    throw new Error(
      `Audio2Face frames[${index}].values must exactly match the ${channels.length}-shape header.`
    )
  }

  const weights = createEmptyArkit52Weights()
  const tongueWeights = tongueEnabled ? createEmptyAudio2FaceTongueWeights() : undefined
  channels.forEach((channel, channelIndex) => {
    const weight = normalizeWeight(
      values[channelIndex],
      `Audio2Face frames[${index}].values[${channelIndex}]`
    )
    if ((ARKIT_52_CHANNEL_ORDER as readonly string[]).includes(channel)) {
      weights[channel as Arkit52Channel] = weight
    } else if (tongueWeights) {
      tongueWeights[channel as Audio2FaceTongueChannel] = weight
    }
  })

  const frame: GoonSpeechFaceFrame = {
    profile: ARKIT_52_FACE_DRIVER_PROFILE,
    weights,
    ...(tongueWeights ? { tongueWeights } : {})
  }
  return { timeCode, frame }
}

function buildDiagnostics(
  frames: Array<{ timeCode: number; frame: GoonSpeechFaceFrame }>,
  durationMs: number
): GoonLipSyncTimelineDiagnostics {
  const weightMaxima: Record<string, number> = {}
  for (const channel of [...ARKIT_52_CHANNEL_ORDER, ...AUDIO2FACE_16_TONGUE_CHANNEL_ORDER]) {
    weightMaxima[channel] = 0
  }
  for (const { frame } of frames) {
    if (frame.profile !== ARKIT_52_FACE_DRIVER_PROFILE) continue
    for (const channel of ARKIT_52_CHANNEL_ORDER) {
      weightMaxima[channel] = Math.max(weightMaxima[channel], frame.weights[channel])
    }
    if (frame.tongueWeights) {
      for (const channel of AUDIO2FACE_16_TONGUE_CHANNEL_ORDER) {
        weightMaxima[channel] = Math.max(weightMaxima[channel], frame.tongueWeights[channel])
      }
    }
  }
  return {
    provider: 'nvidia-audio2face-3d',
    phoneCount: 0,
    mappedPhoneCount: 0,
    silencePhoneCount: 0,
    unmappedPhoneCount: 0,
    coveragePercent: 100,
    segmentCount: frames.length,
    chunkCount: 1,
    durationMs,
    visemeSymbolCounts: {},
    phoneSymbolCounts: {},
    primaryCueCounts: {},
    unmappedSymbols: [],
    weightMaxima
  }
}

export function normalizeAudio2FaceBridgeResponse(
  value: unknown,
  sourceText = ''
): AudioLedGoonLipSyncResult {
  if (!isRecord(value)) throw new Error('Audio2Face bridge response must be an object.')
  if (value.schemaVersion !== AUDIO2FACE_BRIDGE_SCHEMA) {
    throw new Error(`Audio2Face bridge schemaVersion must be "${AUDIO2FACE_BRIDGE_SCHEMA}".`)
  }
  if (value.status !== 'success') throw new Error('Audio2Face bridge did not report success.')
  if (value.fps !== AUDIO2FACE_OUTPUT_FPS) {
    throw new Error(`Audio2Face output must use the fixed ${AUDIO2FACE_OUTPUT_FPS} FPS contract.`)
  }
  if (typeof value.cacheHit !== 'boolean') {
    throw new Error('Audio2Face bridge cacheHit must be a boolean.')
  }

  const durationMs = requireFiniteNumber(value.durationMs, 'Audio2Face durationMs')
  if (durationMs <= 0) throw new Error('Audio2Face durationMs must be positive.')
  const inventory = normalizeShapeInventory(value.shapeNames)
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    throw new Error('Audio2Face bridge response must contain at least one animation frame.')
  }

  const normalizedFrames: Array<{ timeCode: number; frame: GoonSpeechFaceFrame }> = []
  let previousTimeCode: number | null = null
  value.frames.forEach((frameValue, index) => {
    const frame = normalizeFrame(
      frameValue,
      index,
      inventory.channels,
      inventory.tongueEnabled,
      previousTimeCode
    )
    normalizedFrames.push(frame)
    previousTimeCode = frame.timeCode
  })
  const finalTimeMs = normalizedFrames[normalizedFrames.length - 1].timeCode * 1000
  if (finalTimeMs > durationMs + 1) {
    throw new Error('Audio2Face durationMs ends before its final animation frame.')
  }

  const timeline: GoonLipSyncTimeline = {
    analyzerId: 'audio2face-3d',
    source: 'audio-analysis',
    profile: ARKIT_52_FACE_DRIVER_PROFILE,
    keyframes: normalizedFrames.map(({ timeCode, frame }) => ({
      timeMs: timeCode * 1000,
      frame
    })),
    durationMs,
    unitCount: normalizedFrames.length,
    sourceText,
    visemeBlendMs: 0,
    diagnostics: buildDiagnostics(normalizedFrames, durationMs)
  }

  return {
    timeline,
    metrics: {
      analyzerId: 'audio2face-3d',
      runtimeMode: 'precomputed',
      totalMs: 0,
      notes: [
        value.cacheHit ? 'Audio2Face completed-utterance cache hit.' : 'Audio2Face completed-utterance cache miss.',
        inventory.tongueEnabled ? 'Audio2Face 16-channel tongue output enabled.' : 'Audio2Face ARKit-52 face output.'
      ]
    }
  }
}

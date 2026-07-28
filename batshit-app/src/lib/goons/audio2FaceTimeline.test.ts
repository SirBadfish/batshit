import { describe, expect, it } from 'vitest'
import {
  ARKIT_52_CHANNEL_ORDER,
  AUDIO2FACE_16_TONGUE_CHANNEL_ORDER,
  projectGoonSpeechFaceFrameToRhubarb9
} from '$lib/goons/speechFaceProfiles'
import {
  AUDIO2FACE_BRIDGE_SCHEMA,
  AUDIO2FACE_OUTPUT_FPS,
  normalizeAudio2FaceBridgeResponse,
  normalizeAudio2FaceChannelName
} from '$lib/goons/audio2FaceTimeline'

function pascalCase(value: string) {
  return `${value[0].toUpperCase()}${value.slice(1)}`
}

function buildPayload(options: { tongue?: boolean } = {}) {
  const names = [
    ...ARKIT_52_CHANNEL_ORDER,
    ...(options.tongue ? AUDIO2FACE_16_TONGUE_CHANNEL_ORDER : [])
  ].map(pascalCase)
  const first = names.map(() => 0)
  const second = names.map(() => 0)
  second[names.indexOf('JawOpen')] = 0.75
  second[names.indexOf('MouthPucker')] = 0.4
  if (options.tongue) second[names.indexOf('TongueTipUp')] = 0.65
  return {
    schemaVersion: AUDIO2FACE_BRIDGE_SCHEMA,
    status: 'success',
    fps: AUDIO2FACE_OUTPUT_FPS,
    shapeNames: names,
    frames: [
      { timeCode: 0, values: first },
      { timeCode: 1 / 30, values: second }
    ],
    durationMs: 100,
    cacheHit: true
  }
}

describe('Audio2Face timeline normalization', () => {
  it('normalizes exact PascalCase ARKit-52 frames without losing continuous weights', () => {
    const result = normalizeAudio2FaceBridgeResponse(buildPayload(), 'Hello')
    expect(result.timeline.profile).toBe('arkit-52')
    expect(result.timeline.analyzerId).toBe('audio2face-3d')
    expect(result.timeline.keyframes).toHaveLength(2)
    const frame = result.timeline.keyframes[1].frame
    expect(frame.profile).toBe('arkit-52')
    if (frame.profile !== 'arkit-52') throw new Error('Expected ARKit-52 frame.')
    expect(frame.weights.jawOpen).toBe(0.75)
    expect(frame.weights.mouthPucker).toBe(0.4)
    expect(frame.tongueWeights).toBeUndefined()
    expect(result.metrics?.notes).toContain('Audio2Face completed-utterance cache hit.')
  })

  it('retains the complete optional 16-channel tongue inventory', () => {
    const result = normalizeAudio2FaceBridgeResponse(buildPayload({ tongue: true }))
    const frame = result.timeline.keyframes[1].frame
    if (frame.profile !== 'arkit-52') throw new Error('Expected ARKit-52 frame.')
    expect(frame.tongueWeights?.tongueTipUp).toBe(0.65)
    expect(Object.keys(frame.tongueWeights ?? {})).toEqual([...AUDIO2FACE_16_TONGUE_CHANNEL_ORDER])
    expect(projectGoonSpeechFaceFrameToRhubarb9(frame).tongue_lift).toBe(0.65)
  })

  it('accepts only exact canonical or PascalCase source names', () => {
    expect(normalizeAudio2FaceChannelName('JawOpen')).toBe('jawOpen')
    expect(normalizeAudio2FaceChannelName('jawOpen')).toBe('jawOpen')
    expect(() => normalizeAudio2FaceChannelName('jaw_open')).toThrow('unsupported shape name')
  })

  it('fails loudly on missing, duplicate, partial-tongue, and unknown shape inventories', () => {
    const missing = buildPayload()
    missing.shapeNames = missing.shapeNames.slice(1)
    missing.frames = missing.frames.map((frame) => ({ ...frame, values: frame.values.slice(1) }))
    expect(() => normalizeAudio2FaceBridgeResponse(missing)).toThrow('exactly 52')

    const duplicate = buildPayload()
    duplicate.shapeNames[1] = duplicate.shapeNames[0]
    expect(() => normalizeAudio2FaceBridgeResponse(duplicate)).toThrow('duplicate channels')

    const partialTongue = buildPayload()
    partialTongue.shapeNames.push('TongueTipUp')
    partialTongue.frames = partialTongue.frames.map((frame) => ({ ...frame, values: [...frame.values, 0] }))
    expect(() => normalizeAudio2FaceBridgeResponse(partialTongue)).toThrow('exactly 52')

    const unknown = buildPayload()
    unknown.shapeNames[0] = 'HeadYaw'
    expect(() => normalizeAudio2FaceBridgeResponse(unknown)).toThrow('unsupported shape name')
  })

  it('rejects invalid frame ordering, width, ranges, FPS, and duration', () => {
    const nonMonotonic = buildPayload()
    nonMonotonic.frames[1].timeCode = 0
    expect(() => normalizeAudio2FaceBridgeResponse(nonMonotonic)).toThrow('strictly increasing')

    const wrongWidth = buildPayload()
    wrongWidth.frames[1].values.pop()
    expect(() => normalizeAudio2FaceBridgeResponse(wrongWidth)).toThrow('exactly match')

    const outOfRange = buildPayload()
    outOfRange.frames[1].values[0] = 1.2
    expect(() => normalizeAudio2FaceBridgeResponse(outOfRange)).toThrow('0..1')

    const wrongFps = { ...buildPayload(), fps: 60 }
    expect(() => normalizeAudio2FaceBridgeResponse(wrongFps)).toThrow('fixed 30 FPS')

    const shortDuration = { ...buildPayload(), durationMs: 1 }
    expect(() => normalizeAudio2FaceBridgeResponse(shortDuration)).toThrow('final animation frame')
  })
})

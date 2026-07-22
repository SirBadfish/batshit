import { describe, expect, it } from 'vitest'

import {
  applyGoonLipSyncWeightMultipliers,
  buildTextGoonLipSyncTimeline,
  createEmptyGoonLipSyncWeights,
  DEFAULT_GOON_LIP_SYNC_VISEME_BLEND_MS,
  estimateGoonLipSyncDurationMs,
  getGoonLipSyncOpenness,
  isTimelineOwnedGoonLipSyncSource,
  normalizeGoonLipSyncTimelineDuration,
  sampleGoonLipSyncTimeline
} from './goonLipSync'
import { RHUBARB_9_SPEECH_FACE_PROFILE } from '$lib/goons/speechFaceProfiles'

function sampleRhubarb(timeline: Parameters<typeof sampleGoonLipSyncTimeline>[0], timeMs: number) {
  const frame = sampleGoonLipSyncTimeline(timeline, timeMs)
  if (frame.profile !== RHUBARB_9_SPEECH_FACE_PROFILE) {
    throw new Error(`Expected Rhubarb-9 frame, received ${frame.profile}.`)
  }
  return frame.weights
}

describe('goonLipSync', () => {
  it('builds a time-based viseme timeline that changes mouth shapes across the phrase', () => {
    const timeline = buildTextGoonLipSyncTimeline('Meet moon cat.')

    expect(timeline).not.toBeNull()
    expect(timeline?.keyframes.length ?? 0).toBeGreaterThan(3)

    const maxWeight = (viseme: 'clenched' | 'pucker' | 'wide_open') =>
      Math.max(
        ...(timeline?.keyframes ?? []).map((keyframe) =>
          keyframe.frame.profile === RHUBARB_9_SPEECH_FACE_PROFILE
            ? keyframe.frame.weights[viseme]
            : 0
        )
      )

    expect(maxWeight('clenched')).toBeGreaterThan(0.9)
    expect(maxWeight('pucker')).toBeGreaterThan(0.9)
    expect(maxWeight('wide_open')).toBeGreaterThan(0.9)
  })

  it('uses playback rate when estimating the duration hint', () => {
    const normal = estimateGoonLipSyncDurationMs('This is a quick test sentence.', 1)
    const faster = estimateGoonLipSyncDurationMs('This is a quick test sentence.', 1.5)

    expect(normal).toBeGreaterThan(faster)
    expect(faster).toBeGreaterThan(0)
  })

  it('can stretch text-timing fallback timelines to a known audio duration', () => {
    const text = 'Short line.'
    const estimated = estimateGoonLipSyncDurationMs(text, 1)
    const stretched = buildTextGoonLipSyncTimeline(text, 1, estimated + 2000)
    const notShrunk = buildTextGoonLipSyncTimeline(text, 1, 100)

    expect(stretched?.durationMs).toBe(estimated + 2000)
    expect(notShrunk?.durationMs).toBe(estimated)
  })

  it('keeps Custom Rhubarb 9 consonant cues in the text-timing fallback timeline', () => {
    const timeline = buildTextGoonLipSyncTimeline('Puffy fish choose thin sass with wow lull.')
    const maxWeight = (
      viseme: 'closed' | 'teeth_lip' | 'clenched' | 'pucker' | 'tongue_lift'
    ) =>
      Math.max(
        ...(timeline?.keyframes ?? []).map((keyframe) =>
          keyframe.frame.profile === RHUBARB_9_SPEECH_FACE_PROFILE
            ? keyframe.frame.weights[viseme]
            : 0
        )
      )

    expect(maxWeight('closed')).toBeGreaterThan(0.9)
    expect(maxWeight('teeth_lip')).toBeGreaterThan(0.8)
    expect(maxWeight('clenched')).toBeGreaterThan(0.8)
    expect(maxWeight('pucker')).toBeGreaterThan(0.8)
    expect(maxWeight('tongue_lift')).toBeGreaterThan(0.8)
  })

  it('converts blended viseme weights into a capped mouth openness value', () => {
    const openness = getGoonLipSyncOpenness({
      profile: RHUBARB_9_SPEECH_FACE_PROFILE,
      weights: {
        ...createEmptyGoonLipSyncWeights(),
        wide_open: 0.7,
        mid_open: 0.3,
        pucker: 0.2,
        clenched: 0.1,
        round: 0
      }
    })

    expect(openness).toBeGreaterThan(0.7)
    expect(openness).toBeLessThanOrEqual(1)
  })

  it('can trim wide visemes without shrinking the open-mouth shapes', () => {
    const baseWeights = {
      ...createEmptyGoonLipSyncWeights(),
      wide_open: 0.42,
      mid_open: 0.48,
      pucker: 0.18,
      clenched: 0.44,
      round: 0.26
    }

    const tunedWeights = applyGoonLipSyncWeightMultipliers(baseWeights, {
      mid_open: 0.75,
      clenched: 0.75
    })

    expect(tunedWeights.wide_open).toBe(baseWeights.wide_open)
    expect(tunedWeights.pucker).toBe(baseWeights.pucker)
    expect(tunedWeights.round).toBe(baseWeights.round)
    expect(tunedWeights.mid_open).toBeCloseTo(baseWeights.mid_open * 0.75)
    expect(tunedWeights.clenched).toBeCloseTo(baseWeights.clenched * 0.75)
  })

  it('crossfades hard Rhubarb cue boundaries when viseme blend is enabled', () => {
    const closed = { ...createEmptyGoonLipSyncWeights(), closed: 1 }
    const wideOpen = { ...createEmptyGoonLipSyncWeights(), wide_open: 1 }
    const timeline = {
      analyzerId: 'rhubarb-wasm' as const,
      source: 'audio-analysis' as const,
      profile: RHUBARB_9_SPEECH_FACE_PROFILE,
      durationMs: 200,
      unitCount: 2,
      sourceText: 'pop',
      visemeBlendMs: DEFAULT_GOON_LIP_SYNC_VISEME_BLEND_MS,
      keyframes: [
        { timeMs: 0, frame: { profile: RHUBARB_9_SPEECH_FACE_PROFILE, weights: closed } },
        { timeMs: 100, frame: { profile: RHUBARB_9_SPEECH_FACE_PROFILE, weights: closed } },
        { timeMs: 100, frame: { profile: RHUBARB_9_SPEECH_FACE_PROFILE, weights: wideOpen } },
        { timeMs: 200, frame: { profile: RHUBARB_9_SPEECH_FACE_PROFILE, weights: wideOpen } }
      ]
    }

    const beforeBoundary = sampleRhubarb(timeline, 95)
    const atBoundary = sampleRhubarb(timeline, 100)
    const afterBoundary = sampleRhubarb(timeline, 105)

    expect(beforeBoundary.closed).toBeGreaterThan(beforeBoundary.wide_open)
    expect(beforeBoundary.wide_open).toBeGreaterThan(0)
    expect(atBoundary.closed).toBeCloseTo(0.5)
    expect(atBoundary.wide_open).toBeCloseTo(0.5)
    expect(afterBoundary.wide_open).toBeGreaterThan(afterBoundary.closed)
    expect(afterBoundary.closed).toBeGreaterThan(0)
  })

  it('normalizes precomputed analyzer timelines to the real playback duration', () => {
    const rest = { ...createEmptyGoonLipSyncWeights(), rest: 1 }
    const wideOpen = { ...createEmptyGoonLipSyncWeights(), wide_open: 1 }
    const timeline = {
      analyzerId: 'rhubarb-wasm' as const,
      source: 'audio-analysis' as const,
      profile: RHUBARB_9_SPEECH_FACE_PROFILE,
      durationMs: 1000,
      unitCount: 2,
      sourceText: 'hello',
      keyframes: [
        { timeMs: 0, frame: { profile: RHUBARB_9_SPEECH_FACE_PROFILE, weights: rest } },
        { timeMs: 500, frame: { profile: RHUBARB_9_SPEECH_FACE_PROFILE, weights: wideOpen } },
        { timeMs: 1000, frame: { profile: RHUBARB_9_SPEECH_FACE_PROFILE, weights: rest } }
      ]
    }

    const stretched = normalizeGoonLipSyncTimelineDuration(timeline, 2000)
    const defaultNoShrink = normalizeGoonLipSyncTimelineDuration(timeline, 500)
    const compressed = normalizeGoonLipSyncTimelineDuration(timeline, 500, { allowShrink: true })

    expect(stretched?.durationMs).toBe(2000)
    expect(stretched?.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([0, 1000, 2000])
    expect(sampleRhubarb(stretched, 1000).wide_open).toBe(1)

    expect(defaultNoShrink).toBe(timeline)
    expect(compressed?.durationMs).toBe(500)
    expect(compressed?.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([0, 250, 500])
  })

  it('treats premium/provider timelines as owning their mouth strength', () => {
    expect(isTimelineOwnedGoonLipSyncSource('audio-analysis')).toBe(true)
    expect(isTimelineOwnedGoonLipSyncSource('provider-alignment')).toBe(true)
    expect(isTimelineOwnedGoonLipSyncSource('text-timing')).toBe(false)
  })
})

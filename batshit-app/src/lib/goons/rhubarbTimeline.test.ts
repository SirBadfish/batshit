import { describe, expect, it } from 'vitest'
import { sampleGoonLipSyncTimeline } from '$lib/utils/goonLipSync'
import { convertRhubarbJsonToTimeline, mapRhubarbCueToWeights } from './rhubarbTimeline'

describe('rhubarbTimeline', () => {
  it('maps Rhubarb cue values into Custom Rhubarb 9 mouth weights', () => {
    const rest = mapRhubarbCueToWeights('X')
    const plosive = mapRhubarbCueToWeights('A')
    const clenched = mapRhubarbCueToWeights('B')
    const midOpen = mapRhubarbCueToWeights('C')
    const wideOpen = mapRhubarbCueToWeights('D')
    const rounded = mapRhubarbCueToWeights('E')
    const pucker = mapRhubarbCueToWeights('F')
    const teeth = mapRhubarbCueToWeights('G')
    const tongueLift = mapRhubarbCueToWeights('H')

    expect(rest.rest).toBe(1)
    expect(plosive.closed).toBe(1)
    expect(clenched.clenched).toBeGreaterThan(0.8)
    expect(midOpen.mid_open).toBeGreaterThan(0.8)
    expect(wideOpen.wide_open).toBe(1)
    expect(rounded.round).toBeGreaterThan(0.8)
    expect(pucker.pucker).toBeGreaterThan(0.9)
    expect(teeth.teeth_lip).toBe(1)
    expect(tongueLift.tongue_lift).toBeGreaterThan(0.9)
  })

  it('converts Rhubarb JSON output into a timed WASM timeline', () => {
    const timeline = convertRhubarbJsonToTimeline(
      {
        metadata: { duration: 0.47 },
        mouthCues: [
          { start: 0, end: 0.05, value: 'X' },
          { start: 0.05, end: 0.27, value: 'D' },
          { start: 0.27, end: 0.31, value: 'C' },
          { start: 0.31, end: 0.43, value: 'B' },
          { start: 0.43, end: 0.47, value: 'X' }
        ]
      },
      'Hi'
    )

    expect(timeline.analyzerId).toBe('rhubarb-wasm')
    expect(timeline.source).toBe('audio-analysis')
    expect(timeline.durationMs).toBe(470)
    expect(timeline.keyframes.length).toBeGreaterThanOrEqual(10)
    expect(timeline.diagnostics).toMatchObject({
      provider: 'rhubarb-wasm',
      phoneCount: 5,
      mappedPhoneCount: 5,
      silencePhoneCount: 2,
      unmappedPhoneCount: 0,
      coveragePercent: 100,
      segmentCount: 5,
      chunkCount: 1,
      visemeSymbolCounts: {
        X: 2,
        D: 1,
        C: 1,
        B: 1
      },
      primaryCueCounts: {
        rest: 2,
        wide_open: 1,
        mid_open: 1,
        clenched: 1
      },
      cueDurationMs: {
        X: 90,
        D: 220,
        C: 40,
        B: 120
      },
      activeDurationMs: 380,
      weightMaxima: {
        rest: 1,
        clenched: 0.9,
        mid_open: 0.86,
        wide_open: 1
      },
      weightedDurationMs: {
        rest: 90,
        clenched: 108,
        mid_open: 79.2,
        wide_open: 227.2
      }
    })

    const early = sampleGoonLipSyncTimeline(timeline, 10)
    const middle = sampleGoonLipSyncTimeline(timeline, 140)
    const late = sampleGoonLipSyncTimeline(timeline, 350)

    expect(early).toMatchObject({ rest: 1, wide_open: 0, pucker: 0, round: 0 })
    expect(middle.wide_open).toBeGreaterThan(0.9)
    expect(late.clenched).toBeGreaterThan(0.8)
    expect(late.clenched).toBeGreaterThan(late.wide_open + late.pucker + late.round)
  })
})

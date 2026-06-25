import { describe, expect, it } from 'vitest'
import { sampleGoonLipSyncTimeline } from '$lib/utils/goonLipSync'
import {
  buildInworldVisemeLipSyncTimeline,
  mapInworldVisemeToGoonLipSyncWeights
} from './providerVisemeTimeline'

describe('providerVisemeTimeline', () => {
  it('maps Inworld viseme symbols into Custom Rhubarb 9 mouth weights', () => {
    const open = mapInworldVisemeToGoonLipSyncWeights('aei')
    const closed = mapInworldVisemeToGoonLipSyncWeights('bmp')
    const teeth = mapInworldVisemeToGoonLipSyncWeights('fv')
    const pucker = mapInworldVisemeToGoonLipSyncWeights('qw')
    const rest = mapInworldVisemeToGoonLipSyncWeights(null, '[silence]')
    const silenceWithBmpViseme = mapInworldVisemeToGoonLipSyncWeights('bmp', '[silence]')

    expect(open?.wide_open).toBeGreaterThan(0.9)
    expect(open?.wide_open ?? 0).toBeGreaterThan(open?.mid_open ?? 0)
    expect(closed?.closed).toBe(1)
    expect(teeth?.teeth_lip).toBe(1)
    expect(pucker?.pucker).toBeGreaterThan(0.9)
    expect(rest?.rest).toBe(1)
    expect(silenceWithBmpViseme?.rest).toBe(1)
    expect(silenceWithBmpViseme?.closed).toBe(0)
  })

  it('builds a provider-aligned timeline from Inworld phonetic details', () => {
    const timeline = buildInworldVisemeLipSyncTimeline({
      sourceText: 'Hello Josh',
      durationMs: 850,
      segments: [
        {
          text: 'Hello',
          startSec: 0.1,
          endSec: 0.5,
          phoneticDetails: [
            {
              phoneSymbol: 'h',
              startTimeSeconds: 0.1,
              durationSeconds: 0.08,
              visemeSymbol: 'cdgknstxyz'
            },
            {
              phoneSymbol: 'eh',
              startTimeSeconds: 0.18,
              durationSeconds: 0.07,
              visemeSymbol: 'aei'
            }
          ]
        },
        {
          text: 'Josh',
          startSec: 0.5,
          endSec: 0.8,
          phoneticDetails: [
            {
              phoneSymbol: 'j',
              startTimeSeconds: 0.5,
              durationSeconds: 0.1,
              visemeSymbol: 'chjsh'
            }
          ]
        }
      ]
    })

    expect(timeline).not.toBeNull()
    expect(timeline?.analyzerId).toBe('inworld-viseme-timing')
    expect(timeline?.source).toBe('provider-alignment')
    expect(timeline?.durationMs).toBe(850)
    expect(timeline?.unitCount).toBe(3)
    expect(timeline?.diagnostics).toMatchObject({
      provider: 'inworld',
      phoneCount: 3,
      mappedPhoneCount: 3,
      unmappedPhoneCount: 0,
      coveragePercent: 100,
      segmentCount: 2,
      visemeSymbolCounts: {
        cdgknstxyz: 1,
        aei: 1,
        chjsh: 1
      }
    })

    const consonant = sampleGoonLipSyncTimeline(timeline!, 120)
    const vowel = sampleGoonLipSyncTimeline(timeline!, 200)
    const affricate = sampleGoonLipSyncTimeline(timeline!, 540)
    const afterSpeech = sampleGoonLipSyncTimeline(timeline!, 840)

    expect(consonant.clenched).toBeGreaterThan(0.8)
    expect(vowel.wide_open).toBeGreaterThan(0.8)
    expect(affricate.tongue_lift).toBeGreaterThan(0.7)
    expect(afterSpeech.rest).toBe(1)
  })

  it('accepts word-relative Inworld phone offsets when absolute starts are absent', () => {
    const timeline = buildInworldVisemeLipSyncTimeline({
      sourceText: 'Pop',
      segments: [
        {
          text: 'Pop',
          startSec: 0.25,
          endSec: 0.55,
          phoneticDetails: [
            {
              phoneSymbol: 'p',
              startTimeSeconds: 0,
              durationSeconds: 0.06,
              visemeSymbol: 'bmp'
            }
          ]
        }
      ]
    })

    expect(timeline).not.toBeNull()
    expect(sampleGoonLipSyncTimeline(timeline!, 245).rest).toBe(1)
    expect(sampleGoonLipSyncTimeline(timeline!, 260).closed).toBe(1)
  })

  it('applies realtime chunk offsets to chunk-relative Inworld phonetic starts', () => {
    const timeline = buildInworldVisemeLipSyncTimeline({
      sourceText: 'Later',
      segments: [
        {
          text: 'Later',
          startSec: 2.25,
          endSec: 2.55,
          chunkSeq: 3,
          chunkAudioOffsetSec: 2,
          phoneticDetails: [
            {
              phoneSymbol: 'l',
              startTimeSeconds: 0.25,
              durationSeconds: 0.08,
              visemeSymbol: 'l'
            }
          ]
        }
      ]
    })

    expect(timeline).not.toBeNull()
    expect(sampleGoonLipSyncTimeline(timeline!, 2240).rest).toBe(1)
    expect(sampleGoonLipSyncTimeline(timeline!, 2260).tongue_lift).toBeGreaterThan(0.8)
  })

  it('does not double-offset absolute Inworld phonetic starts on later chunks', () => {
    const timeline = buildInworldVisemeLipSyncTimeline({
      sourceText: 'Later',
      segments: [
        {
          text: 'Later',
          startSec: 2.25,
          endSec: 2.55,
          chunkSeq: 3,
          chunkAudioOffsetSec: 2,
          phoneticDetails: [
            {
              phoneSymbol: 'l',
              startTimeSeconds: 2.25,
              durationSeconds: 0.08,
              visemeSymbol: 'l'
            }
          ]
        }
      ]
    })

    expect(timeline).not.toBeNull()
    expect(timeline?.durationMs).toBe(2550)
    expect(sampleGoonLipSyncTimeline(timeline!, 2260).tongue_lift).toBeGreaterThan(0.8)
    expect(sampleGoonLipSyncTimeline(timeline!, 4260).rest).toBe(1)
  })

  it('treats Inworld silence phones as rest even when the provider reports bmp', () => {
    const timeline = buildInworldVisemeLipSyncTimeline({
      sourceText: ' Hello',
      segments: [
        {
          text: '',
          startSec: 0,
          endSec: 0.2,
          phoneticDetails: [
            {
              phoneSymbol: '[silence]',
              startTimeSeconds: 0,
              durationSeconds: 0.2,
              visemeSymbol: 'bmp'
            }
          ]
        },
        {
          text: 'Hello',
          startSec: 0.2,
          endSec: 0.42,
          phoneticDetails: [
            {
              phoneSymbol: 'ɛ',
              startTimeSeconds: 0.24,
              durationSeconds: 0.08,
              visemeSymbol: 'aei'
            }
          ]
        }
      ]
    })

    expect(timeline).not.toBeNull()
    expect(sampleGoonLipSyncTimeline(timeline!, 100).rest).toBe(1)
    expect(sampleGoonLipSyncTimeline(timeline!, 100).closed).toBe(0)
    expect(sampleGoonLipSyncTimeline(timeline!, 260).wide_open).toBeGreaterThan(0.8)
    expect(timeline?.diagnostics?.silencePhoneCount).toBe(1)
    expect(timeline?.diagnostics?.primaryCueCounts).toMatchObject({
      rest: 1,
      wide_open: 1
    })
  })
})

import { describe, expect, it } from 'vitest'
import { sampleGoonLipSyncTimeline } from '$lib/utils/goonLipSync'
import {
  buildInworldVisemeLipSyncTimeline,
  mapInworldVisemeToOvr15Weights
} from './providerVisemeTimeline'
import type { GoonLipSyncTimeline } from '$lib/utils/goonLipSync'

function sampleOvr(timeline: GoonLipSyncTimeline, timeMs: number) {
  const frame = sampleGoonLipSyncTimeline(timeline, timeMs)
  if (frame.profile !== 'ovr-15') {
    throw new Error(`Expected OVR-15 frame, received ${frame.profile}.`)
  }
  return frame.weights
}

describe('providerVisemeTimeline', () => {
  it('maps Inworld categories and phone detail directly into OVR-15', () => {
    expect(mapInworldVisemeToOvr15Weights('aei', 'a')?.aa).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('aei', 'ɛ')?.E).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('aei', 'i')?.I).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('o', 'o')?.O).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('o', 'u')?.U).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('bmp', 'p')?.PP).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('fv', 'f')?.FF).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('th', 'θ')?.TH).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('chjsh', 'tʃ')?.CH).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('cdgknstxyz', 'd')?.DD).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('cdgknstxyz', 'k')?.kk).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('cdgknstxyz', 's')?.SS).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('cdgknstxyz', 'n')?.nn).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('r', 'r')?.RR).toBe(1)
    expect(mapInworldVisemeToOvr15Weights('bmp', '[silence]')?.sil).toBe(1)
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
    expect(timeline?.profile).toBe('ovr-15')
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

    const consonant = sampleOvr(timeline!, 120)
    const vowel = sampleOvr(timeline!, 200)
    const affricate = sampleOvr(timeline!, 540)
    const afterSpeech = sampleOvr(timeline!, 840)

    expect(consonant.SS).toBe(1)
    expect(vowel.E).toBe(1)
    expect(affricate.CH).toBe(1)
    expect(afterSpeech.sil).toBe(1)
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
    expect(sampleOvr(timeline!, 245).sil).toBe(1)
    expect(sampleOvr(timeline!, 260).PP).toBe(1)
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
    expect(sampleOvr(timeline!, 2240).sil).toBe(1)
    expect(sampleOvr(timeline!, 2260).nn).toBe(1)
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
    expect(sampleOvr(timeline!, 2260).nn).toBe(1)
    expect(sampleOvr(timeline!, 4260).sil).toBe(1)
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
    expect(sampleOvr(timeline!, 100).sil).toBe(1)
    expect(sampleOvr(timeline!, 100).PP).toBe(0)
    expect(sampleOvr(timeline!, 260).E).toBe(1)
    expect(timeline?.diagnostics?.silencePhoneCount).toBe(1)
    expect(timeline?.diagnostics?.primaryCueCounts).toMatchObject({
      sil: 1,
      E: 1
    })
  })
})

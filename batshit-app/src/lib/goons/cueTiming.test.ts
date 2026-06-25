import { describe, expect, it } from 'vitest'
import {
  estimateCueTimingFraction,
  estimateCueTimingMsFromAlignment,
  usesAnalyzerOwnedCueProgress
} from './cueTiming'

describe('estimateCueTimingFraction', () => {
  it('uses spoken-prefix timing for sentence-opening emoji cues instead of raw message length', () => {
    const rawText =
      "Got it! Let's test all the eye rolls again.\n🙄 Whatever, it's not a big deal. I'm not even bothered by this at all!"
    const cueIndex = rawText.indexOf('🙄')
    const rawFraction = cueIndex / rawText.length
    const cueStartTiming = estimateCueTimingFraction(rawText, {
      index: cueIndex,
      spanStart: cueIndex,
      source: 'stage'
    })

    const estimated = estimateCueTimingFraction(rawText, {
      index: cueIndex,
      spanStart: cueIndex,
      spanEnd: cueIndex + '🙄'.length,
      source: 'emoji',
      definition: { name: 'eye_roll', kind: 'emote' }
    })

    expect(estimated).toBeGreaterThan(rawFraction)
    expect(estimated).toBeGreaterThan(cueStartTiming)
    expect(estimated - cueStartTiming).toBeGreaterThan(0.08)
  })

  it('lets punctuation-followed emoji cues land after the prior word without forcing pause-speech timing', () => {
    const rawText = "Whatever 🙄. I'm fine."
    const cueIndex = rawText.indexOf('🙄')

    const estimated = estimateCueTimingFraction(rawText, {
      index: cueIndex,
      spanStart: cueIndex,
      spanEnd: cueIndex + '🙄'.length,
      source: 'emoji',
      definition: { name: 'eye_roll', kind: 'emote' }
    })
    const cueStartTiming = estimateCueTimingFraction(rawText, {
      index: cueIndex,
      spanStart: cueIndex,
      source: 'stage'
    })

    expect(estimated).toBeGreaterThan(cueStartTiming)
  })

  it('keeps pause-speech emotes on their authored timing instead of snapping to the next word', () => {
    const rawText = 'Fine. 🙄 Whatever.'
    const cueIndex = rawText.indexOf('🙄')

    const estimated = estimateCueTimingFraction(rawText, {
      index: cueIndex,
      spanStart: cueIndex,
      spanEnd: cueIndex + '🙄'.length,
      source: 'emoji',
      definition: { name: 'eye_roll_pause', kind: 'emote', blocking: true }
    })
    const cueStartTiming = estimateCueTimingFraction(rawText, {
      index: cueIndex,
      spanStart: cueIndex,
      source: 'stage'
    })
    expect(Math.abs(estimated - cueStartTiming)).toBeLessThan(0.03)
  })

  it('keeps plus signs in normal spoken text from affecting cue timing', () => {
    const rawText = 'We use C++ all the time. 🙄 Fine, whatever.'
    const cueIndex = rawText.indexOf('🙄')

    const estimated = estimateCueTimingFraction(rawText, {
      index: cueIndex,
      spanStart: cueIndex,
      spanEnd: cueIndex + '🙄'.length,
      source: 'emoji',
      definition: { name: 'eye_roll', kind: 'emote' }
    })

    expect(estimated).toBeGreaterThan(0.7)
    expect(estimated).toBeLessThanOrEqual(1)
  })

  it('estimates cue timing from spoken text after markdown formatting is removed', () => {
    const rawText = [
      '# Status',
      '- **First** we test the setup. 😏 Nice.',
      '- Then we continue with _another_ spoken sentence. 🙄 Fine.',
      '- Finally, [the link](https://example.com) is just spoken as text. 🤨 Hmm.'
    ].join('\n')
    const cueIndexes = ['😏', '🙄', '🤨'].map((emoji) => rawText.indexOf(emoji))

    const estimates = cueIndexes.map((cueIndex) =>
      estimateCueTimingFraction(rawText, {
        index: cueIndex,
        spanStart: cueIndex,
        spanEnd: cueIndex + '😏'.length,
        source: 'emoji',
        definition: { name: 'test_emote', kind: 'emote' }
      })
    )

    expect(estimates[0]).toBeGreaterThan(0.1)
    expect(estimates[1]).toBeGreaterThan(estimates[0])
    expect(estimates[2]).toBeGreaterThan(estimates[1])
  })

  it('uses provider alignment segments when available for emoji cue timing', () => {
    const rawText = 'First sentence. 😏 Nice. Second sentence. 🙄 Fine.'
    const smileIndex = rawText.indexOf('😏')
    const eyeRollIndex = rawText.indexOf('🙄')
    const segments = [
      { text: 'First', startSec: 0, endSec: 0.25 },
      { text: 'sentence', startSec: 0.25, endSec: 0.7 },
      { text: 'Nice', startSec: 0.95, endSec: 1.2 },
      { text: 'Second', startSec: 1.55, endSec: 1.9 },
      { text: 'sentence', startSec: 1.9, endSec: 2.35 },
      { text: 'Fine', startSec: 2.8, endSec: 3.1 }
    ]

    const smileMs = estimateCueTimingMsFromAlignment(rawText, {
      index: smileIndex,
      spanStart: smileIndex,
      spanEnd: smileIndex + '😏'.length,
      source: 'emoji',
      definition: { name: 'smile', kind: 'emote' }
    }, segments)
    const eyeRollMs = estimateCueTimingMsFromAlignment(rawText, {
      index: eyeRollIndex,
      spanStart: eyeRollIndex,
      spanEnd: eyeRollIndex + '🙄'.length,
      source: 'emoji',
      definition: { name: 'eye_roll', kind: 'emote' }
    }, segments)

    expect(smileMs).toBe(1060)
    expect(eyeRollMs).toBe(2910)
  })

  it('uses analyzer-owned cue progress for every premium audio-led lane', () => {
    expect(usesAnalyzerOwnedCueProgress('rhubarb-wasm')).toBe(true)
    expect(usesAnalyzerOwnedCueProgress('batshit-text-timing')).toBe(false)
    expect(usesAnalyzerOwnedCueProgress(null)).toBe(false)
  })
})

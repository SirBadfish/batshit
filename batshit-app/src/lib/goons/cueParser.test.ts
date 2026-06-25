import { describe, expect, it } from 'vitest'
import { parseGoonCues, parseLiveKitNaturalGoonCues, stripGoonStageDirections } from './cueParser'
import type { GoonCueMap, GoonEmojiMap } from '$lib/types/goons'

const CUE_MAP: GoonCueMap = {
  calm: {
    name: 'calm',
    kind: 'mood'
  },
  dance: {
    name: 'dance',
    kind: 'mood'
  },
  focus: {
    name: 'focus',
    kind: 'mood'
  },
  smile: {
    name: 'smile',
    kind: 'emote'
  },
  side_eye: {
    name: 'side_eye',
    kind: 'emote'
  },
  wink: {
    name: 'wink',
    kind: 'emote'
  }
}

const EMOJI_MAP: GoonEmojiMap = {
  '😄': 'smile',
  '😏+🙄': 'side_eye'
}

describe('goons cue parser smoke', () => {
  it('parses stage, controls, and emoji cues in-order', () => {
    const input =
      'Lets focus now.\n*goon: calm* <batshit-cue>{"goon_mood":"focus"}</batshit-cue> 😄 😏+🙄'

    const cues = parseGoonCues(input, EMOJI_MAP, CUE_MAP)
    const names = cues.map((cue) => cue.name)

    expect(names).toEqual(['calm', 'focus', 'smile', 'side_eye'])
    expect(cues.map((cue) => cue.source)).toEqual(['stage', 'cue', 'emoji', 'emoji'])
  })

  it('parses spaced stage cue names', () => {
    const cueMap: GoonCueMap = {
      'Flirty Smirk': {
        name: 'Flirty Smirk',
        kind: 'emote'
      }
    }
    const cues = parseGoonCues('*goon: Flirty Smirk* Well hello.', {}, cueMap)

    expect(cues.map((cue) => cue.name)).toEqual(['Flirty Smirk'])
    expect(cues[0]?.definition?.name).toBe('Flirty Smirk')
  })

  it('still accepts the old parenthesis combo syntax during transition', () => {
    const cues = parseGoonCues('(😏🙄)', EMOJI_MAP, CUE_MAP)

    expect(cues.map((cue) => cue.name)).toEqual(['side_eye'])
  })

  it('strips stage directions from speakable text', () => {
    const input = 'Hello there *goon: calm* friend'
    expect(stripGoonStageDirections(input)).toBe('Hello there  friend'.trim())
  })

  it('strips spaced stage directions from speakable text', () => {
    const input = 'Hello there *goon: Flirty Smirk* friend'
    expect(stripGoonStageDirections(input)).toBe('Hello there  friend'.trim())
  })

  it('parses cue tags with attributes', () => {
    const input =
      '<batshit-cue>{"mood":"focus"}</batshit-cue>'
    const cues = parseGoonCues(input, EMOJI_MAP, CUE_MAP)

    expect(cues.map((cue) => cue.name)).toEqual(['focus'])
    expect(cues[0]?.source).toBe('cue')
  })

  it('parses one-shot goon cues from control tags', () => {
    const input =
      '<batshit-cue>{"goon_cue":"smile","goon_emote":"side_eye"}</batshit-cue> Hello.'
    const cues = parseGoonCues(input, EMOJI_MAP, CUE_MAP)

    expect(cues.map((cue) => cue.name)).toEqual(['smile', 'side_eye'])
    expect(cues.map((cue) => cue.source)).toEqual(['cue', 'cue'])
    expect(cues[0]?.definition?.kind).toBe('emote')
  })

  it('maps a unique simple cue alias to the enabled authored cue name', () => {
    const cueMap: GoonCueMap = {
      'Playful Wink': {
        name: 'Playful Wink',
        kind: 'emote'
      },
      'Happy Smile': {
        name: 'Happy Smile',
        kind: 'emote'
      }
    }
    const cues = parseGoonCues(
      '<batshit-cue>{"goon_cue":"wink"}</batshit-cue>',
      {},
      cueMap
    )

    expect(cues.map((cue) => cue.name)).toEqual(['Playful Wink'])
    expect(cues[0]?.definition?.name).toBe('Playful Wink')
  })

  it('parses spaced one-shot goon cues from control tags', () => {
    const cueMap: GoonCueMap = {
      'Flirty Smirk': {
        name: 'Flirty Smirk',
        kind: 'emote'
      }
    }
    const cues = parseGoonCues(
      '<batshit-cue>{"goon_cue":"Flirty Smirk"}</batshit-cue>',
      {},
      cueMap
    )

    expect(cues.map((cue) => cue.name)).toEqual(['Flirty Smirk'])
    expect(cues[0]?.definition?.name).toBe('Flirty Smirk')
  })

  it('parses simple emote tags as one-shot goon cues', () => {
    const cues = parseGoonCues('<emote>smile</emote> Hello.', EMOJI_MAP, CUE_MAP)

    expect(cues.map((cue) => cue.name)).toEqual(['smile'])
    expect(cues[0]?.source).toBe('cue')
    expect(cues[0]?.definition?.kind).toBe('emote')
  })

  it('parses attribute emote tags with non-spoken placeholder content', () => {
    const cues = parseGoonCues('<emote name="smile">.</emote> Hello.', EMOJI_MAP, CUE_MAP)

    expect(cues.map((cue) => cue.name)).toEqual(['smile'])
    expect(cues[0]?.source).toBe('cue')
    expect(cues[0]?.definition?.kind).toBe('emote')
  })

  it('parses cue names from emote tag names', () => {
    const cues = parseGoonCues(
      '<emote-smile>.</emote-smile> Hello. <emote-side_eye>side_eye</emote-side_eye> Still talking.',
      EMOJI_MAP,
      CUE_MAP
    )

    expect(cues.map((cue) => cue.name)).toEqual(['smile', 'side_eye'])
    expect(cues.map((cue) => cue.source)).toEqual(['cue', 'cue'])
  })

  it('parses self-closing emote tags as one-shot goon cues', () => {
    const cues = parseGoonCues(
      '<emote name="smile" /> Hello. <emote emote="side_eye" /> Still talking. <emote smile />',
      EMOJI_MAP,
      CUE_MAP
    )

    expect(cues.map((cue) => cue.name)).toEqual(['smile', 'side_eye', 'smile'])
    expect(cues.map((cue) => cue.source)).toEqual(['cue', 'cue', 'cue'])
  })

  it('parses narrow LiveKit natural cue confirmations for speech-to-speech providers', () => {
    const cueMap: GoonCueMap = {
      'Playful Wink': {
        name: 'Playful Wink',
        kind: 'emote'
      }
    }
    const cues = parseLiveKitNaturalGoonCues(
      'Yeah, I just winked at you, dummy. You shoulda felt it.',
      cueMap
    )

    expect(cues.map((cue) => cue.name)).toEqual(['Playful Wink'])
    expect(cues[0]?.source).toBe('natural')
  })

  it('parses leading LiveKit natural cue words without treating negations as cues', () => {
    expect(
      parseLiveKitNaturalGoonCues('Wink right back at you, cutie.', CUE_MAP).map(
        (cue) => cue.name
      )
    ).toEqual(['wink'])
    expect(parseLiveKitNaturalGoonCues("I won't wink this time.", CUE_MAP)).toEqual([])
  })

  it('parses named LiveKit natural cue claims for multi-word emotes', () => {
    const cueMap: GoonCueMap = {
      'Happy Smile': {
        name: 'Happy Smile',
        kind: 'emote'
      },
      'Flirty Smirk': {
        name: 'Flirty Smirk',
        kind: 'emote'
      }
    }

    expect(
      parseLiveKitNaturalGoonCues("I'll go with a Happy Smile this time.", cueMap).map(
        (cue) => cue.name
      )
    ).toEqual(['Happy Smile'])
    expect(
      parseLiveKitNaturalGoonCues('Giving you a Flirty Smirk now.', cueMap).map(
        (cue) => cue.name
      )
    ).toEqual(['Flirty Smirk'])
  })

  it('matches control moods case-insensitively to canonical cue names', () => {
    const input = '<batshit-cue>{\\"goon_mood\\":\\"Dance\\"}</batshit-cue>'
    const cues = parseGoonCues(input, EMOJI_MAP, CUE_MAP)

    expect(cues.map((cue) => cue.name)).toEqual(['dance'])
    expect(cues[0]?.definition?.name).toBe('dance')
  })
})

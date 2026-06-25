import { describe, expect, it } from 'vitest'
import {
  extractBatshitCuePayload,
  extractGoonMoodFromCuePayload,
  extractVisibleBatshitCueState
} from './batshitCue'

describe('batshitCue', () => {
  it('parses goon mood payloads with escaped quotes', () => {
    const payload = '{\\"goon_mood\\":\\"Dance\\"}'
    expect(extractGoonMoodFromCuePayload(payload)).toBe('Dance')
  })

  it('parses one-shot goon cue payloads', () => {
    expect(
      extractBatshitCuePayload('{"goon_cue":"Happy Smile","goon_emotes":["side_eye"]}')
    ).toEqual({
      mood: null,
      cues: ['Happy Smile', 'side_eye']
    })
  })

  it('parses spaced one-shot goon cue names from relaxed control syntax', () => {
    expect(extractBatshitCuePayload('goon_cue: Flirty Smirk')).toEqual({
      mood: null,
      cues: ['Flirty Smirk']
    })
  })

  it('strips visible control blocks while surfacing a mood note', () => {
    const result = extractVisibleBatshitCueState(
      'Hello there\n<batshit-cue>{\\"goon_mood\\":\\"Dance\\",\\"goon_cue\\":\\"smile\\"}</batshit-cue>\nKeep going'
    )

    expect(result.cleanedContent).toBe('Hello there\n\nKeep going')
    expect(result.notes).toEqual([{ kind: 'mood', label: 'Mood: Dance', value: 'Dance' }])
  })

  it('strips visible one-shot goon stage directions', () => {
    const result = extractVisibleBatshitCueState(
      '*goon: smile* Hello there.\n*goon: side_eye* Still visible prose.\n*goon: Flirty Smirk* More.'
    )

    expect(result.cleanedContent).toBe('Hello there.\nStill visible prose.\nMore.')
    expect(result.notes).toEqual([])
  })

  it('strips visible emote tags', () => {
    const result = extractVisibleBatshitCueState(
      '<emote>smile</emote> Hello there. <emote name="wink">.</emote> Still here. <emote-side_eye>.</emote-side_eye> Yep.'
    )

    expect(result.cleanedContent).toBe('Hello there. Still here. Yep.')
    expect(result.notes).toEqual([])
  })

  it('strips visible self-closing emote tags', () => {
    const result = extractVisibleBatshitCueState(
      '<emote name="smile" /> Hello there. <emote wink /> Still here.'
    )

    expect(result.cleanedContent).toBe('Hello there. Still here.')
    expect(result.notes).toEqual([])
  })
})

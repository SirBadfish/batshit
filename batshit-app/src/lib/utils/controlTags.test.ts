import { describe, expect, it } from 'vitest'
import * as registry from './controlTags'

import {
  CONTROL_TAGS,
  buildControlDenialRecord,
  buildControlErrorDcmLines,
  buildControlErrorRecord,
  controlTag,
  controlTagByName,
  findControlBlocks,
  realtimeHiddenTagNames,
  realtimeHiddenTagOpenPrefixes,
  ttsHiddenTagNames
} from './controlTags'

describe('control tag registry', () => {
  it('registers every tag exactly once with a unique element name', () => {
    const names = CONTROL_TAGS.map((spec) => spec.tag)
    expect(new Set(names).size).toBe(names.length)
    const ids = CONTROL_TAGS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resolves tags by id and by element name', () => {
    expect(controlTag('zip-control').tag).toBe('batshit-zip-control')
    expect(controlTag('tool-notes').tag).toBe('batshit-tool-notes')
    expect(controlTagByName('BATSHIT-CUE')?.id).toBe('cue')
    expect(controlTagByName('not-a-tag')).toBeNull()
  })

  it('registers the SA-104 P3 memory save tag with full strip + loud-failure policy', () => {
    const spec = controlTag('memory')
    expect(spec.tag).toBe('batshit-memory')
    expect(spec.parse).toBe('json')
    expect(spec.position).toBe('any')
    expect(spec.bulkyEndOfMessageConvention).toBe(true)
    expect(spec.hideFromRender).toBe(true)
    expect(spec.hideFromTts).toBe(true)
    expect(spec.loudFailure).toBe(true)
  })

  it('derives render, tts, and realtime tag lists from one registration', () => {
    for (const spec of CONTROL_TAGS) {
      if (spec.hideFromRender) {
        expect(findControlBlocks(`<${spec.tag}>{}</${spec.tag}>`, { final: true })).toHaveLength(1)
      }
      if (spec.hideFromTts) {
        expect(ttsHiddenTagNames()).toContain(spec.tag)
        expect(realtimeHiddenTagNames()).toContain(spec.tag)
        expect(realtimeHiddenTagOpenPrefixes()).toContain(`<${spec.tag}`)
      }
    }
  })

  it('offers no plain-search helper any more: every reader uses the one scanner (BL-442)', () => {
    for (const retired of [
      'pairedBlockRegexGlobal',
      'unclosedTailRegexGlobal',
      'renderHiddenOpenRegex',
      'closeTagRegex',
      'splitTrailingPartialControlPrefix',
      'EMOTE_TAG_REGEX_SOURCE',
      'INCOMPLETE_EMOTE_TAG_REGEX_SOURCE'
    ]) {
      expect(Object.keys(registry)).not.toContain(retired)
    }
    expect(typeof registry.findControlBlocks).toBe('function')
  })

  it('keeps the plain tool-results spellings in the realtime hold-back set', () => {
    expect(realtimeHiddenTagNames()).toContain('tool-results-summary')
    expect(realtimeHiddenTagNames()).toContain('tool_results')
  })
})

describe('a streaming reply holds a start that can still become a tag (R4; was splitTrailingPartialControlPrefix)', () => {
  const held = (text: string) =>
    findControlBlocks(text, { final: false })
      .filter((block) => block.kind === 'held-start')
      .map((block) => text.slice(block.start))

  it('holds back a trailing partial control-tag prefix, of every tag', () => {
    expect(held('Hello there <batshit-cu')).toEqual(['<batshit-cu'])
    expect(held('Saved that. <batshit-mem')).toEqual(['<batshit-mem'])
    expect(held('Saving notes now <batshit-tool-no')).toEqual(['<batshit-tool-no'])
  })

  it('holds back a complete open tag name that has not seen its ">" yet', () => {
    expect(held('Text <batshit-zip-control ')).toEqual(['<batshit-zip-control '])
  })

  it('does not hold ordinary angle-bracket text', () => {
    expect(held('a < b and 3 <marquee')).toEqual([])
  })

  it('does not hold completed tags', () => {
    expect(held('Before <batshit-cue>{"mood":"happy"}</batshit-cue>')).toEqual([])
  })
})

describe('buildControlErrorDcmLines', () => {
  const messages = (
    ...entries: Array<{ role: string; controlErrors?: Array<{ tag: string; error: string; hint?: string; at: string }> }>
  ) =>
    entries.map((entry, index) => ({
      role: entry.role,
      metadata: entry.controlErrors ? { controlErrors: entry.controlErrors } : {},
      id: `m${index}`
    }))

  it('surfaces errors from the most recent assistant message with a fix hint', () => {
    const lines = buildControlErrorDcmLines(
      messages(
        { role: 'user' },
        {
          role: 'assistant',
          controlErrors: [buildControlErrorRecord('batshit-tool-notes', 'bad JSON', 'use {"notes":[...]}')]
        },
        { role: 'user' }
      )
    )
    expect(lines[0]).toContain('control_errors')
    expect(lines[1]).toBe('- <batshit-tool-notes>: bad JSON | fix: use {"notes":[...]}')
  })

  it('returns nothing when the most recent assistant message is clean (one-turn correction only)', () => {
    const lines = buildControlErrorDcmLines(
      messages(
        {
          role: 'assistant',
          controlErrors: [buildControlErrorRecord('batshit-zip-control', 'old error')]
        },
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user' }
      )
    )
    expect(lines).toEqual([])
  })

  it('returns nothing for empty histories', () => {
    expect(buildControlErrorDcmLines([])).toEqual([])
  })
})

describe('buildControlDenialRecord (PR #106 review F-17)', () => {
  /**
   * The sentence used to carry `decidedAt`'s UTC `HH:MM` with no zone marker, so a user in
   * `America/Chicago` who denied at 09:32 had the agent told "(14:32)" — and the agent
   * repeats that back to them. The DCM reads only the most recent assistant message, so
   * position already says "this just happened"; the time added nothing the model could use
   * and one thing it got wrong.
   */
  it('names the control and says not to retry, with NO clock time', () => {
    const record = buildControlDenialRecord('Skill Import', '2026-09-10T14:35:00.000Z')
    expect(record.error).toBe('Denied by the user: Skill Import — do not retry it.')
    // Belt and braces: no `HH:MM` anywhere in the agent-facing sentence, in any zone.
    expect(record.error).not.toMatch(/\d{1,2}:\d{2}/)
  })

  it('keeps the full ISO instant on the record, for machines', () => {
    const record = buildControlDenialRecord('Skill Import', '2026-09-10T14:35:00.000Z')
    expect(record.at).toBe('2026-09-10T14:35:00.000Z')
    expect(record.kind).toBe('approval')
    expect(record.tag).toBe('approval')
  })

  it('stamps now when the decision carries no instant', () => {
    const before = Date.now()
    const record = buildControlDenialRecord('Skill Import')
    expect(Date.parse(record.at!)).toBeGreaterThanOrEqual(before)
  })
})

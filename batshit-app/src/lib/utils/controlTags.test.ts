import { describe, expect, it } from 'vitest'

import {
  CONTROL_TAGS,
  buildControlErrorDcmLines,
  buildControlErrorRecord,
  controlTag,
  controlTagByName,
  realtimeHiddenTagNames,
  realtimeHiddenTagOpenPrefixes,
  renderHiddenOpenRegex,
  splitTrailingPartialControlPrefix,
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
        expect(renderHiddenOpenRegex().test(`<${spec.tag}>`)).toBe(true)
      }
      if (spec.hideFromTts) {
        expect(ttsHiddenTagNames()).toContain(spec.tag)
        expect(realtimeHiddenTagNames()).toContain(spec.tag)
        expect(realtimeHiddenTagOpenPrefixes()).toContain(`<${spec.tag}`)
      }
    }
  })

  it('keeps the plain tool-results spellings in the realtime hold-back set', () => {
    expect(realtimeHiddenTagNames()).toContain('tool-results-summary')
    expect(realtimeHiddenTagNames()).toContain('tool_results')
  })
})

describe('splitTrailingPartialControlPrefix', () => {
  it('holds back a trailing partial control-tag prefix', () => {
    const result = splitTrailingPartialControlPrefix('Hello there <batshit-cu')
    expect(result.visible).toBe('Hello there ')
    expect(result.heldPrefix).toBe('<batshit-cu')
  })

  it('holds back a partial prefix of the memory save tag (chunk-split safety)', () => {
    const { visible, heldPrefix } = splitTrailingPartialControlPrefix('Saved that. <batshit-mem')
    expect(visible).toBe('Saved that. ')
    expect(heldPrefix).toBe('<batshit-mem')
  })

  it('holds back a partial prefix of the tool-notes tag', () => {
    const result = splitTrailingPartialControlPrefix('Saving notes now <batshit-tool-no')
    expect(result.visible).toBe('Saving notes now ')
    expect(result.heldPrefix).toBe('<batshit-tool-no')
  })

  it('holds back a complete open tag name that has not seen its ">" yet', () => {
    const result = splitTrailingPartialControlPrefix('Text <batshit-zip-control ')
    expect(result.visible).toBe('Text ')
    expect(result.heldPrefix).toBe('<batshit-zip-control ')
  })

  it('does not hold ordinary angle-bracket text', () => {
    const result = splitTrailingPartialControlPrefix('a < b and 3 <marquee')
    expect(result.visible).toBe('a < b and 3 <marquee')
    expect(result.heldPrefix).toBe('')
  })

  it('does not hold completed tags', () => {
    const content = 'Before <batshit-cue>{"mood":"happy"}</batshit-cue>'
    const result = splitTrailingPartialControlPrefix(content)
    expect(result.visible).toBe(content)
    expect(result.heldPrefix).toBe('')
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

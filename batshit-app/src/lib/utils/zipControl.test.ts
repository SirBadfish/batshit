import { describe, expect, it } from 'vitest'

import {
  extractToolNotes,
  extractZipControl,
  hideStreamingHiddenControlBlocks,
  resolveZipControlZipIds,
  stripZipControlBlocks
} from './zipControl'

describe('hideStreamingHiddenControlBlocks', () => {
  it('removes complete zip, group, and cue control blocks from rendered streaming text', () => {
    const content =
      [
        'Visible before',
        '<batshit-group>{"mode":"responding"}</batshit-group>',
        '<batshit-zip-control>{"unzip":["z1"]}</batshit-zip-control>',
        'Visible after',
        '<batshit-cue>{"mood":"happy"}</batshit-cue>'
      ].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible before\n\nVisible after')
  })

  it('withholds an incomplete control block until it closes', () => {
    const content = 'Visible before\n<batshit-zip-control>{"unzip":["z1"]'

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible before')
  })

  it('removes streaming emote control tags', () => {
    const content = 'Hello <goon-emote name="wave" />there <emote name="smile"'

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Hello there')
  })

  it('removes a standalone trailing bare zip-control payload from streaming text', () => {
    const content = [
      'Visible response.',
      '{"unzip":[],"zip":[],"toolResultsSummary":[]}'
    ].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible response.')
  })

  it('keeps ordinary inline JSON visible', () => {
    const content = 'Visible example: {"unzip":[],"zip":[],"toolResultsSummary":[]}'

    expect(hideStreamingHiddenControlBlocks(content)).toBe(content)
  })

  it('removes standalone bare group and goon cue payloads from streaming text', () => {
    const content = [
      '{"mode":"responding"}',
      'Visible response.',
      '{"goon_mood":"Joy","goon_cue":"wave"}'
    ].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible response.')
  })

  it('keeps ordinary inline group and cue JSON visible', () => {
    const content =
      'Visible examples: {"mode":"responding"} and {"goon_mood":"Joy","goon_cue":"wave"}'

    expect(hideStreamingHiddenControlBlocks(content)).toBe(content)
  })

  it('does not treat a mood-only JSON object as a bare cue fallback', () => {
    const content = ['Visible response.', '{"mood":"happy"}'].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe(content)
  })
})

describe('extractZipControl', () => {
  it('extracts the two zip-control actions as zip IDs', () => {
    const result = extractZipControl(
      [
        'Visible response.',
        '<batshit-zip-control>',
        '{"unzip":["cool_tool_1"],"zip":["error_1"],"toolResultsSummary":[]}',
        '</batshit-zip-control>'
      ].join('\n')
    )

    expect(result.cleaned).toBe('Visible response.')
    expect(result.payload?.unzip).toEqual(['cool_tool_1'])
    expect(result.payload?.zip).toEqual(['error_1'])
  })

  it('ignores removed zip-control action names', () => {
    const result = extractZipControl(
      [
        'Visible response.',
        '<batshit-zip-control>',
        '{"rezip":["error_1"],"keepUnzipped":["cool_tool_2"],"toolResultsSummary":[]}',
        '</batshit-zip-control>'
      ].join('\n')
    )

    expect(result.payload?.unzip).toEqual([])
    expect(result.payload?.zip).toEqual([])
  })

  it('extracts a standalone trailing bare zip-control payload', () => {
    const result = extractZipControl(
      [
        'Visible response.',
        '{"unzip":[],"zip":[],"toolResultsSummary":[]}'
      ].join('\n')
    )

    expect(result.hadBlock).toBe(true)
    expect(result.cleaned).toBe('Visible response.')
    expect(result.payload?.unzip).toEqual([])
    expect(result.payload?.zip).toEqual([])
    expect(result.payload?.toolResultsSummary).toEqual([])
  })

  it('does not extract inline visible JSON as zip control metadata', () => {
    const content = 'Visible example: {"unzip":[],"zip":[],"toolResultsSummary":[]}'
    const result = extractZipControl(content)

    expect(result.hadBlock).toBe(false)
    expect(result.cleaned).toBe(content)
  })

  it('strips malformed standalone hidden-control payloads without extracting them as zip control', () => {
    const content = ['{"mode":"responding"}', 'Visible response.', '{"goon_cue":"wave"}'].join('\n')
    const result = extractZipControl(content)

    expect(result.hadBlock).toBe(false)
    expect(stripZipControlBlocks(result.cleaned)).toBe('Visible response.')
  })
})

describe('resolveZipControlZipIds', () => {
  it('resolves requested zip IDs against the trusted session zip set', () => {
    expect(
      resolveZipControlZipIds(
        [' cool_tool_1 ', 'cool_tool_1', 'error_2'],
        ['cool_tool_1', 'error_2']
      )
    ).toEqual(['cool_tool_1', 'error_2'])
  })

  it('does not resolve tool call IDs that are not zip IDs', () => {
    expect(resolveZipControlZipIds(['call_123'], ['cool_tool_1'])).toEqual([])
  })

  it('resolves one-based current tool result aliases before normal ID matching', () => {
    const first = 'cool_tool_1780541000000_abcd1'
    const second = 'cool_tool_1780541000001_abcd2'
    const third = 'cool_tool_1780541000002_abcd3'

    expect(
      resolveZipControlZipIds(
        ['tool_result_1', 'tool_result_3'],
        [first, second, third],
        {
          currentToolZipIds: [first, second, third]
        }
      )
    ).toEqual([first, third])
  })

  it('does not resolve zero-based or out-of-range current tool result aliases', () => {
    const first = 'cool_tool_1780541000000_abcd1'

    expect(
      resolveZipControlZipIds(
        ['tool_result_0', 'tool_result_2'],
        [first],
        {
          currentToolZipIds: [first]
        }
      )
    ).toEqual([])
  })

  it('deduplicates zip IDs resolved through aliases and direct IDs', () => {
    const first = 'cool_tool_1780541000000_abcd1'

    expect(
      resolveZipControlZipIds(
        ['tool_result_1', first],
        [first],
        {
          currentToolZipIds: [first]
        }
      )
    ).toEqual([first])
  })
})

describe('extractToolNotes (SA-104 P1 tag split)', () => {
  it('extracts notes from a tagged tool-notes block and cleans the content', () => {
    const content = [
      'Here is my answer.',
      '<batshit-tool-notes>',
      '{"notes":[{"toolName":"web_search","summary":"Redis 8.10.1 is latest"}]}',
      '</batshit-tool-notes>'
    ].join('\n')

    const result = extractToolNotes(content)
    expect(result.hadBlock).toBe(true)
    expect(result.payload?.notes).toEqual([
      { toolName: 'web_search', summary: 'Redis 8.10.1 is latest' }
    ])
    expect(result.cleaned).toBe('Here is my answer.')
    expect(result.parseError).toBeUndefined()
  })

  it('accepts a tool-notes block anywhere in the message (position-flexible)', () => {
    const content = [
      'Intro.',
      '<batshit-tool-notes>{"notes":[{"summary":"mid-message note"}]}</batshit-tool-notes>',
      'Outro.'
    ].join('\n')

    const result = extractToolNotes(content)
    expect(result.payload?.notes).toEqual([{ summary: 'mid-message note' }])
    expect(result.cleaned).toBe('Intro.\n\nOutro.')
  })

  it('extracts a trailing bare notes payload', () => {
    const content = 'Answer text.\n{"notes":[{"summary":"bare note"}]}'
    const result = extractToolNotes(content)
    expect(result.hadBlock).toBe(true)
    expect(result.payload?.notes).toEqual([{ summary: 'bare note' }])
    expect(result.cleaned).toBe('Answer text.')
  })

  it('reports a parse error for malformed JSON instead of silently dropping', () => {
    const content = 'Text.\n<batshit-tool-notes>{"notes":[oops]}</batshit-tool-notes>'
    const result = extractToolNotes(content)
    expect(result.hadBlock).toBe(true)
    expect(result.payload).toBeUndefined()
    expect(result.parseError).toBeTruthy()
    expect(result.cleaned).toBe('Text.')
  })

  it('reports a parse error when the payload has no notes shape', () => {
    const content = '<batshit-tool-notes>{"wrong":"shape"}</batshit-tool-notes>'
    const result = extractToolNotes(content)
    expect(result.hadBlock).toBe(true)
    expect(result.parseError).toContain('notes')
  })

  it('leaves zip-control blocks alone so extraction can chain', () => {
    const content = [
      'Answer.',
      '<batshit-tool-notes>{"notes":[{"summary":"n1"}]}</batshit-tool-notes>',
      '<batshit-zip-control>{"unzip":["z1"]}</batshit-zip-control>'
    ].join('\n')

    const notes = extractToolNotes(content)
    expect(notes.payload?.notes).toEqual([{ summary: 'n1' }])
    expect(notes.cleaned).toContain('<batshit-zip-control>')

    const zip = extractZipControl(notes.cleaned)
    expect(zip.payload?.unzip).toEqual(['z1'])
    expect(zip.cleaned).toBe('Answer.')
  })
})

describe('zip-control clean break (notes moved to their own tag)', () => {
  it('no longer absorbs legacy note fields and flags the drop loudly', () => {
    const content =
      '<batshit-zip-control>{"unzip":["z1"],"toolResultsSummary":[{"summary":"legacy"}]}</batshit-zip-control>'
    const result = extractZipControl(content)
    expect(result.payload?.unzip).toEqual(['z1'])
    expect(result.payload?.toolResultsSummary).toEqual([])
    expect(result.payload?.legacyNotesDropped).toBe(true)
  })

  it('does not flag payloads without legacy note keys', () => {
    const content = '<batshit-zip-control>{"unzip":["z1"],"zip":[]}</batshit-zip-control>'
    const result = extractZipControl(content)
    expect(result.payload?.legacyNotesDropped).toBeUndefined()
  })

  it('strips tool-notes blocks in stripZipControlBlocks so compiled views never show them', () => {
    const content = [
      'Visible.',
      '<batshit-tool-notes>{"notes":[{"summary":"n"}]}</batshit-tool-notes>',
      '<batshit-zip-control>{"unzip":[]}</batshit-zip-control>'
    ].join('\n')
    expect(stripZipControlBlocks(content)).toBe('Visible.')
  })
})

describe('hideStreamingHiddenControlBlocks (registry-driven additions)', () => {
  it('hides tool-notes blocks at start, middle, and end positions', () => {
    const block = '<batshit-tool-notes>{"notes":[{"summary":"n"}]}</batshit-tool-notes>'
    expect(hideStreamingHiddenControlBlocks(`${block}\nAfter.`)).toBe('After.')
    expect(hideStreamingHiddenControlBlocks(`Before.\n${block}\nAfter.`)).toBe('Before.\n\nAfter.')
    expect(hideStreamingHiddenControlBlocks(`Before.\n${block}`)).toBe('Before.')
  })

  it('withholds an unclosed tool-notes block from render', () => {
    const content = 'Visible.\n<batshit-tool-notes>{"notes":['
    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible.')
  })

  it('holds back a trailing partial control-tag prefix so it never flashes', () => {
    expect(hideStreamingHiddenControlBlocks('Streaming text <batshit-cu')).toBe('Streaming text')
    expect(hideStreamingHiddenControlBlocks('Streaming text <batshit-tool-no')).toBe(
      'Streaming text'
    )
  })

  it('hides a bare notes-only payload from render', () => {
    const content = 'Visible.\n{"notes":[{"summary":"bare"}]}'
    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible.')
  })
})

describe('memory save blocks (SA-104 P3 registry addition)', () => {
  const memoryBlock = '<batshit-memory>{"lane":"ltm","content":"a fact"}</batshit-memory>'

  it('hides memory blocks from streaming render at start, middle, and end', () => {
    expect(hideStreamingHiddenControlBlocks(`${memoryBlock}\nAfter.`)).toBe('After.')
    expect(hideStreamingHiddenControlBlocks(`Before.\n${memoryBlock}\nAfter.`)).toBe(
      'Before.\n\nAfter.'
    )
    expect(hideStreamingHiddenControlBlocks(`Before.\n${memoryBlock}`)).toBe('Before.')
  })

  it('withholds an unclosed memory block and a partial memory-tag prefix from render', () => {
    expect(hideStreamingHiddenControlBlocks('Visible.\n<batshit-memory>{"lane":"ltm"')).toBe(
      'Visible.'
    )
    expect(hideStreamingHiddenControlBlocks('Streaming text <batshit-mem')).toBe('Streaming text')
  })

  it('strips memory blocks in stripZipControlBlocks so compiled AI views never re-see saves', () => {
    const content = ['Visible.', memoryBlock, memoryBlock].join('\n')
    expect(stripZipControlBlocks(content)).toBe('Visible.')
  })
})

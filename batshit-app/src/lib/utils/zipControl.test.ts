import { describe, expect, it } from 'vitest'

import {
  extractToolNotes,
  extractZipControl,
  hideStreamingHiddenControlBlocks,
  resolveZipControlZipIds,
  stripZipControlBlocks,
  TOOL_NOTES_BLOCK_LIMIT
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

  it('reads EVERY block of a reply with more than one, never only the last (SA-129 P2b, BL-357)', () => {
    const content = [
      'Reading.',
      '<batshit-tool-notes>{"notes":[{"summary":"first"}],"hold":["src/a.ts","src/b.ts"]}</batshit-tool-notes>',
      'Editing.',
      '<batshit-tool-notes>{"notes":[{"summary":"second"}],"release":["src/b.ts"],"hold":["src/c.ts"],"odd":1}</batshit-tool-notes>'
    ].join('\n')

    const result = extractToolNotes(content)
    expect(result.blockCount).toBe(2)
    expect(result.payload?.notes).toEqual([{ summary: 'first' }, { summary: 'second' }])
    // A file named in more than one block ends as the LAST block says.
    expect(result.payload?.hold).toEqual(['src/a.ts', 'src/c.ts'])
    expect(result.payload?.release).toEqual(['src/b.ts'])
    expect(result.payload?.unknownKeys).toEqual(['odd'])
    expect(result.cleaned).toBe('Reading.\n\nEditing.')
  })

  it('inside one block of several, release runs before hold, as for a single block', () => {
    const content = [
      '<batshit-tool-notes>{"release":["src/b.ts"]}</batshit-tool-notes>',
      '<batshit-tool-notes>{"release":["src/a.ts"],"hold":["src/a.ts","src/b.ts"]}</batshit-tool-notes>'
    ].join('\n')
    const result = extractToolNotes(content)
    expect(result.payload?.hold).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.payload?.release).toEqual([])
  })

  it('keeps the good blocks of a reply when one block is malformed, and says which one', () => {
    const content = [
      '<batshit-tool-notes>{"notes":[oops]}</batshit-tool-notes>',
      '<batshit-tool-notes>{"hold":["src/a.ts"]}</batshit-tool-notes>'
    ].join('\n')
    const result = extractToolNotes(content)
    expect(result.blockCount).toBe(2)
    expect(result.payload?.hold).toEqual(['src/a.ts'])
    expect(result.parseError).toMatch(/^Tool Notes block 1 of 2: /)
  })

  it('a single block is read exactly as before, release and hold of one path included', () => {
    const result = extractToolNotes('<batshit-tool-notes>{"release":["a.ts"],"hold":["a.ts"]}</batshit-tool-notes>')
    expect(result.blockCount).toBe(1)
    expect(result.payload?.hold).toEqual(['a.ts'])
    expect(result.payload?.release).toEqual(['a.ts'])
    expect(result.payload?.blocks).toBeUndefined()
  })

  it('keeps each block\'s own holds and releases in order, for the hold step to compare by file (BL-538)', () => {
    const content = [
      '<batshit-tool-notes>{"hold":["src/a.ts"]}</batshit-tool-notes>',
      '<batshit-tool-notes>{"release":["./src/a.ts"],"hold":["src/b.ts"]}</batshit-tool-notes>'
    ].join('\n')
    const result = extractToolNotes(content)
    expect(result.payload?.blocks).toEqual([
      { hold: ['src/a.ts'], release: [] },
      { hold: ['src/b.ts'], release: ['./src/a.ts'] }
    ])
  })

  it('reads a tag in any ASCII case, as the tag regex did (BL-543)', () => {
    const result = extractToolNotes('A.\n<BATSHIT-Tool-Notes>{"hold":["a.ts"]}</batshit-TOOL-notes>\nB.')
    expect(result.blockCount).toBe(1)
    expect(result.payload?.hold).toEqual(['a.ts'])
    expect(result.cleaned).toBe('A.\n\nB.')
  })

  it('an opening tag takes the first closing tag after it; an unclosed one is hidden and reported (BL-543, BL-442 R3)', () => {
    const nested = extractToolNotes('<batshit-tool-notes>{"hold":["a.ts"]}<batshit-tool-notes></batshit-tool-notes>tail</batshit-tool-notes>')
    expect(nested.blockCount).toBe(1)
    expect(nested.parseError).toBeTruthy()
    expect(nested.cleaned).toBe('tail</batshit-tool-notes>')

    const unclosed = extractToolNotes('<batshit-tool-notes>{"hold":["a.ts"]}</batshit-tool-notes>\nText <batshit-tool-notes>{"hold":')
    expect(unclosed.blockCount).toBe(1)
    expect(unclosed.payload?.hold).toEqual(['a.ts'])
    expect(unclosed.cleaned).toBe('Text')
    expect(unclosed.parseError).toBe('Unclosed <batshit-tool-notes> block (missing </batshit-tool-notes>).')
  })

  it(`reads the first ${TOOL_NOTES_BLOCK_LIMIT} blocks of a reply with more, and removes every one (BL-543)`, () => {
    const count = TOOL_NOTES_BLOCK_LIMIT + 5
    const content = Array.from(
      { length: count },
      (_, index) => `Step ${index + 1}.\n<batshit-tool-notes>{"notes":[{"summary":"n${index + 1}"}],"hold":["f${index + 1}.ts"]}</batshit-tool-notes>`
    ).join('\n')

    const result = extractToolNotes(content)

    expect(result.blockCount).toBe(count)
    expect(result.payload?.notes).toHaveLength(TOOL_NOTES_BLOCK_LIMIT)
    expect(result.payload?.notes.at(-1)).toEqual({ summary: `n${TOOL_NOTES_BLOCK_LIMIT}` })
    expect(result.payload?.hold).not.toContain(`f${TOOL_NOTES_BLOCK_LIMIT + 1}.ts`)
    expect(result.payload?.blocks).toHaveLength(TOOL_NOTES_BLOCK_LIMIT)
    expect(result.cleaned).not.toContain('batshit-tool-notes')
    expect(result.cleaned).toContain(`Step ${count}.`)
  })

  it('pairs blocks and leaves the same text as the lazy tag regex it replaced, where the tag is a real block (BL-543, BL-442)', () => {
    // The regex BL-543 replaced, kept here as the reference for the PAIRING: same tag, same flags.
    // Every opening tag here is followed by its payload and none is in code, so BL-442's rule
    // agrees with the regex, except that an opening tag left without a closing tag is now hidden
    // from its tag on and reported (R3), where the regex left it as text.
    const reference = /<batshit-tool-notes>([\s\S]*?)<\/batshit-tool-notes>/gi
    const pieces = [
      '<batshit-tool-notes>{',
      '</batshit-tool-notes>',
      '<BATSHIT-TOOL-NOTES>{',
      '</Batshit-Tool-Notes>',
      '<batshit-tool-notes',
      '</batshit-tool',
      '<batshit-zip-control>',
      '"notes":[{"summary":"x"}]}',
      'text ',
      '\n',
      '\n\n\n',
      'İ',
      'ſ',
      '<'
    ]
    let seed = 543
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let round = 0; round < 2000; round += 1) {
      const length = next() % 12
      const content = Array.from({ length }, () => pieces[next() % pieces.length]).join('')
      const matches = Array.from(content.matchAll(reference))
      const result = extractToolNotes(content)
      expect(result.blockCount, content).toBe(matches.length)
      // The first real opening tag after the last pair has no closing tag: R3 hides from it on.
      const lastEnd = matches.length > 0 ? matches.at(-1)!.index! + matches.at(-1)![0].length : 0
      // ASCII letters only: \`toLowerCase\` would turn \`İ\` into two characters and move every index.
      const folded = content.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
      const unclosedAt = folded.indexOf('<batshit-tool-notes>{', lastEnd)
      const kept = unclosedAt >= 0 ? content.slice(0, unclosedAt) : content
      if (matches.length > 0 || unclosedAt >= 0) {
        expect(result.cleaned, content).toBe(kept.replace(reference, '').replace(/\n{3,}/g, '\n\n').trim())
      } else {
        expect(result.cleaned, content).toBe(content)
      }
    }
  })

  it('reads a 1 MB reply of 50,000 unclosed opening tags in one pass (BL-543)', () => {
    // The lazy regex took about 6 s of the one Node process on this reply (measured 2026-09-27),
    // once for every read; one pass over 1 MB takes milliseconds. The bound is generous for CI.
    const content = `Answer.\n${'<batshit-tool-notes>x'.repeat(50_000)}`
    expect(content.length).toBeGreaterThan(1_000_000)

    const started = performance.now()
    const result = extractToolNotes(content)
    const elapsed = performance.now() - started

    expect(result.hadBlock).toBe(false)
    expect(result.cleaned).toBe(content)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('strips a stored 1 MB reply of 50,000 unclosed opening tags in one pass, as every compile does (BL-543)', () => {
    // `stripZipControlBlocks` runs at least twice per history message on every compile. Its lazy
    // Tool Notes regex took about 15 s on this reply (the review's measurement, 2026-09-27), and the
    // unclosed tags stay in the stored reply, so every later send paid it.
    const content = `Answer.\n<batshit-tool-notes>{"notes":[]}</batshit-tool-notes>\n${'<batshit-tool-notes>x'.repeat(50_000)}`

    const started = performance.now()
    const stripped = stripZipControlBlocks(content)
    const elapsed = performance.now() - started

    expect(stripped.startsWith('Answer.\n\n<batshit-tool-notes>x')).toBe(true)
    expect(stripped).not.toContain('"notes"')
    expect(elapsed).toBeLessThan(1_000)
  })

  it('reads a 1 MB reply of 5,000 closed blocks and 5,000 unclosed tags in one pass (BL-543)', () => {
    const closed = '<batshit-tool-notes>{"notes":[{"summary":"s"}]}</batshit-tool-notes>\n'.repeat(5_000)
    const content = `${closed}${'<batshit-tool-notes>'.repeat(5_000)}${'y'.repeat(1_000_000 - closed.length)}`

    const started = performance.now()
    const result = extractToolNotes(content)
    const elapsed = performance.now() - started

    expect(result.blockCount).toBe(5_000)
    expect(result.payload?.notes).toHaveLength(TOOL_NOTES_BLOCK_LIMIT)
    expect(result.cleaned.startsWith('<batshit-tool-notes><batshit-tool-notes>')).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
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

describe('hideStreamingHiddenControlBlocks: the live view shows what the server saves (BL-442)', () => {
  const example = 'Here is how:\n\n```\n<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>\n```'
  const mention = 'I write a <batshit-memory> block to save it.'
  const lone = 'If the count is < 5, retry. And x < 5 and y > 3.'
  const memory = '<batshit-memory>{"lane":"ltm","content":"Josh likes tea"}</batshit-memory>'

  it('shows the four bug cases and hides only the correct block', () => {
    const reply = `${example}\n\n${mention}\n${lone}\n${memory}\nThe end <`
    // Streaming: the last "<" can still become a tag, so it waits for the next chunk.
    expect(hideStreamingHiddenControlBlocks(reply)).toBe(`${example}\n\n${mention}\n${lone}\n\nThe end`)
    expect(hideStreamingHiddenControlBlocks(`${reply} 5`)).toBe(`${example}\n\n${mention}\n${lone}\n\nThe end < 5`)
  })

  it('hides a tag named in a sentence only until the words after it arrive', () => {
    expect(hideStreamingHiddenControlBlocks('I write a <batshit-memory>')).toBe('I write a')
    expect(hideStreamingHiddenControlBlocks('I write a <batshit-memory> block')).toBe('I write a <batshit-memory> block')
  })

  it('hides a block while it is written, and an example in an open fence is shown as the fence draws it', () => {
    expect(hideStreamingHiddenControlBlocks('Saved. <batshit-memory>{"lane":"ltm","con')).toBe('Saved.')
    expect(hideStreamingHiddenControlBlocks('Example:\n```\n<batshit-memory>{"lane":"ltm","con')).toBe(
      'Example:\n```\n<batshit-memory>{"lane":"ltm","con'
    )
  })
})

describe('stripZipControlBlocks: the compile\'s last strip (BL-442)', () => {
  it('keeps an example in code, a tag named in a sentence, and an unclosed block', () => {
    // The reply end hid an unclosed block before the reply was stored (R3), and this strip also
    // runs over the user's own messages, so it removes complete blocks only.
    for (const text of [
      'Example:\n\n```\n<batshit-memory>{"lane":"ltm","content":"x"}</batshit-memory>\n```',
      'I write a <batshit-tool-notes> block at the end.',
      'Pasted: <batshit-memory>{"lane":"ltm","content":"half'
    ]) {
      expect(stripZipControlBlocks(text)).toBe(text)
    }
  })

  it('keeps the four bug cases and removes only the correct block (BL-442 contract)', () => {
    const words = [
      'Here is how:',
      '```',
      '<batshit-tool-notes>{"notes":[]}</batshit-tool-notes>',
      '```',
      'I write a <batshit-memory> block to save it. If x < 5 it waits.'
    ].join('\n')
    expect(stripZipControlBlocks(`${words}\n<batshit-memory>{"lane":"ltm","content":"x"}</batshit-memory>\nThe end <`)).toBe(
      `${words}\n\nThe end <`
    )
  })

  it('removes a real block that follows a mention, without pairing the mention (trap 1)', () => {
    const text = 'Use `<batshit-memory>` like this. <batshit-memory>{"lane":"ltm","content":"x"}</batshit-memory> Done.'
    expect(stripZipControlBlocks(text)).toBe('Use `<batshit-memory>` like this.  Done.')
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

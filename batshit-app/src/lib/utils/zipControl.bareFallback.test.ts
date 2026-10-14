import { describe, expect, it } from 'vitest'

import {
  extractLeadingBareHiddenControl,
  extractToolNotes,
  extractTrailingBareHiddenControl,
  extractTrailingBareToolNotes,
  isBareToolNotesRecord,
  normalizeToolNotesPayload,
  parseBareHiddenControlRecord,
  stripBareHiddenControlPayloads,
  stripZipControlBlocks,
  type BareHiddenControlKind
} from './zipControl'
import { extractReplyControl } from './replyControl'

/**
 * BL-639: the malformed-output fallback (a hidden-control JSON object written without its tag,
 * alone at an edge of the reply) keeps its BEHAVIOR exactly, and its cost becomes one pass. The
 * readers it replaced are kept here, word for word, as the reference.
 */

function oldTrailingBareHiddenControl(content: string, allowedKind?: BareHiddenControlKind) {
  const starts: number[] = []
  for (let index = content.indexOf('{'); index >= 0; index = content.indexOf('{', index + 1)) {
    starts.push(index)
  }
  for (const start of starts) {
    const prefix = content.slice(0, start)
    if (prefix.trim().length > 0 && !/\n\s*$/.test(prefix)) continue
    const raw = content.slice(start).trim()
    if (!raw.endsWith('}')) continue
    const parsed = parseBareHiddenControlRecord(raw, allowedKind)
    if (parsed) {
      return { cleaned: prefix.replace(/\n{3,}/g, '\n\n').trim(), payload: parsed.payload }
    }
  }
  return null
}

function oldLeadingBareHiddenControl(content: string, allowedKind?: BareHiddenControlKind) {
  const ends: number[] = []
  for (let index = content.indexOf('}'); index >= 0; index = content.indexOf('}', index + 1)) {
    ends.push(index)
  }
  for (const end of ends) {
    const raw = content.slice(0, end + 1).trim()
    const suffix = content.slice(end + 1)
    if (suffix.trim().length > 0 && !/^\s*\n/.test(suffix)) continue
    const parsed = parseBareHiddenControlRecord(raw, allowedKind)
    if (parsed) {
      return { cleaned: suffix.replace(/\n{3,}/g, '\n\n').trim(), payload: parsed.payload }
    }
  }
  return null
}

function oldTrailingBareToolNotes(content: string) {
  const starts: number[] = []
  for (let index = content.indexOf('{'); index >= 0; index = content.indexOf('{', index + 1)) {
    starts.push(index)
  }
  for (const start of starts) {
    const prefix = content.slice(0, start)
    if (prefix.trim().length > 0 && !/\n\s*$/.test(prefix)) continue
    const raw = content.slice(start).trim()
    if (!raw.endsWith('}')) continue
    try {
      const parsed = JSON.parse(raw)
      if (isBareToolNotesRecord(parsed)) {
        const normalized = normalizeToolNotesPayload(parsed)
        if (normalized) {
          return { cleaned: prefix.replace(/\n{3,}/g, '\n\n').trim(), payload: normalized }
        }
      }
    } catch {
      continue
    }
  }
  return null
}

function oldStripBareHiddenControlPayloads(content: string): string {
  let output = content
  let guard = 0
  while (guard < 10) {
    guard += 1
    const leading = oldLeadingBareHiddenControl(output)
    if (leading) {
      output = leading.cleaned
      continue
    }
    const trailing = oldTrailingBareHiddenControl(output)
    if (trailing) {
      output = trailing.cleaned
      continue
    }
    break
  }
  return output.replace(/\n{3,}/g, '\n\n').trim()
}

const PIECES = [
  'Answer here.',
  'word',
  ' ',
  '\n',
  '\n\n\n',
  '\t',
  ' ',
  '{',
  '}',
  '"',
  '\\',
  '\\"',
  ':',
  ',',
  '[',
  ']',
  '{"unzip":["tool_result_1"]}',
  '{"zip":["zip_1"]}',
  '{"notes":[{"summary":"n"}],"hold":["a.ts"]}',
  '{"hold":["a.ts"],"release":[]}',
  '{"notes":"not an array"}',
  '{"mode":"listening"}',
  '{"goon_mood":"happy","emote":"wave"}',
  '{"mood":"happy"}',
  '{"toolResultsSummary":[{"summary":"legacy"}]}',
  '{"a":{"b":{"c":1}}}',
  '{"s":"}{\\"x\\"{"}',
  '{"s":"\\\\"}',
  '{"unzip":["a"],"other":1}',
  '[1,2]',
  'const x = { a: 1 }'
]

function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function generatedReplies(count: number, seed: number): string[] {
  const random = generator(seed)
  const replies: string[] = []
  for (let sample = 0; sample < count; sample += 1) {
    let text = ''
    const length = Math.floor(random() * 10)
    for (let part = 0; part < length; part += 1) text += PIECES[Math.floor(random() * PIECES.length)]
    replies.push(text)
  }
  return replies
}

const KINDS: Array<BareHiddenControlKind | undefined> = [undefined, 'zip', 'tool-notes', 'cue', 'group']

describe('the bare-JSON fallback: exactly the old behavior (BL-639)', () => {
  it('matches the old readers on 5,000 generated replies, for every kind', () => {
    for (const reply of generatedReplies(5_000, 639)) {
      for (const kind of KINDS) {
        expect(extractTrailingBareHiddenControl(reply, kind), `${kind} trailing: ${JSON.stringify(reply)}`).toEqual(
          oldTrailingBareHiddenControl(reply, kind)
        )
        expect(extractLeadingBareHiddenControl(reply, kind), `${kind} leading: ${JSON.stringify(reply)}`).toEqual(
          oldLeadingBareHiddenControl(reply, kind)
        )
      }
      expect(extractTrailingBareToolNotes(reply), JSON.stringify(reply)).toEqual(oldTrailingBareToolNotes(reply))
      expect(stripBareHiddenControlPayloads(reply), JSON.stringify(reply)).toBe(oldStripBareHiddenControlPayloads(reply))
    }
  })

  it('still finds a bare payload at either edge, and never ordinary JSON inside a sentence', () => {
    expect(extractTrailingBareHiddenControl('Done.\n{"unzip":["tool_result_1"]}')?.payload?.unzip).toEqual([
      'tool_result_1'
    ])
    expect(extractLeadingBareHiddenControl('{"mode":"listening"}\nHi')?.cleaned).toBe('Hi')
    expect(extractTrailingBareToolNotes('Done.\n  {"notes":[{"summary":"n"}]}  ')?.cleaned).toBe('Done.')
    expect(extractTrailingBareHiddenControl('Set it to {"unzip":["tool_result_1"]}')).toBeNull()
    expect(extractTrailingBareHiddenControl('Done.\n{"s":"}"}')).toBeNull()
  })

  it('reads the quotes and backslashes in the payload strings as JSON does', () => {
    // One escaped quote before a brace inside a string: read without the escape rule, the brace
    // would count and the payload would not be found.
    const notes = 'Done.\n{"notes":[{"summary":"one \\" {"}]}'
    expect(extractTrailingBareToolNotes(notes)?.payload?.notes).toEqual([{ summary: 'one " {' }])
    expect(extractTrailingBareToolNotes(notes)).toEqual(oldTrailingBareToolNotes(notes))
    const leading = '{"goon_mood":"say \\"} ok"}\nHi'
    expect(extractLeadingBareHiddenControl(leading)?.cleaned).toBe('Hi')
    expect(extractLeadingBareHiddenControl(leading)).toEqual(oldLeadingBareHiddenControl(leading))
  })
})

describe('the bare-JSON fallback: one pass (BL-639)', () => {
  // A 780 KB code reply with many braces, the size the helper measured: about 6 s for each pass
  // with the old readers (and 1.4 s for 260 KB at the reply end), on the one Node process.
  // It ends in a `}` that no `{` matches, so the backward pass walks the whole reply, and it
  // starts with a `{` that never closes, so the forward pass does too: the worst case for both.
  const code = 'function f(a) {\n  if (a) { return { x: a, y: [1, 2] } }\n  return {}\n}\n{\n  "k": { "v": 1 }\n}\n'
  const reply = `{\n${code.repeat(Math.ceil(780_000 / code.length))}}`

  it('reads a 780 KB code reply with many braces through the reply end in bounded time', () => {
    expect(reply.length).toBeGreaterThan(780_000)
    const started = performance.now()
    const extraction = extractReplyControl(reply)
    const elapsed = performance.now() - started
    expect(extraction.hadNotesBlock).toBe(false)
    expect(extraction.hadZipControlBlock).toBe(false)
    expect(extraction.cleaned).toBe(reply)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('strips the same reply as every compile does, in bounded time', () => {
    const started = performance.now()
    const stripped = stripZipControlBlocks(reply)
    const elapsed = performance.now() - started
    expect(stripped).toBe(reply)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('reads a reply that ends in a large bare payload in one pass', () => {
    const notes = JSON.stringify({ notes: Array.from({ length: 20_000 }, (_, index) => ({ summary: `n${index} {}` })) })
    const started = performance.now()
    const result = extractToolNotes(`Answer.\n${notes}`)
    const elapsed = performance.now() - started
    expect(result.payload?.notes).toHaveLength(20_000)
    expect(result.cleaned).toBe('Answer.')
    expect(elapsed).toBeLessThan(2_000)
  })
})

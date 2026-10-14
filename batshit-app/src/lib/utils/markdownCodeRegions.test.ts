import { describe, expect, it } from 'vitest'

import {
  CHAT_MARKDOWN_OPTIONS,
  CodeSpanReader,
  findCodeRegions,
  isInCodeRegion,
  pairCodeSpans,
  readCodeLayout,
  type CodeRegion
} from './markdownCodeRegions'
import { Marked } from 'marked'

/** The text of each region, so a case reads as what the reader sees. */
function codeTexts(text: string): Array<[CodeRegion['kind'], string]> {
  return findCodeRegions(text).map((region) => [region.kind, text.slice(region.start, region.end)])
}

/** Whether the first occurrence of `needle` in `text` starts inside code. */
function isCode(text: string, needle: string, occurrence = 0): boolean {
  let at = -1
  for (let count = 0; count <= occurrence; count += 1) at = text.indexOf(needle, at + 1)
  if (at < 0) throw new Error(`"${needle}" not in the text`)
  return isInCodeRegion(findCodeRegions(text), at)
}

describe('findCodeRegions (the chat Markdown view is the truth)', () => {
  it('uses the chat view options', () => {
    expect(CHAT_MARKDOWN_OPTIONS).toEqual({ breaks: true, gfm: true })
  })

  it('finds fenced code with backticks and with tildes, fences included', () => {
    const text = 'Before\n\n```js\nconst a = 1\n```\n\nMiddle\n\n~~~\n<batshit-memory>{}</batshit-memory>\n~~~\nAfter'
    const regions = codeTexts(text)
    expect(regions.map(([kind]) => kind)).toEqual(['fenced', 'fenced'])
    expect(regions[0][1].trim()).toBe('```js\nconst a = 1\n```')
    expect(regions[1][1].trim()).toBe('~~~\n<batshit-memory>{}</batshit-memory>\n~~~')
    expect(isCode(text, 'Before')).toBe(false)
    expect(isCode(text, 'Middle')).toBe(false)
    expect(isCode(text, '<batshit-memory>')).toBe(true)
    expect(isCode(text, 'After')).toBe(false)
  })

  it('counts an unclosed fence as code to the end of the text', () => {
    const text = 'Here is the syntax:\n```\n<batshit-memory>{"lane":"ltm"}</batshit-memory>\nand more'
    const regions = findCodeRegions(text)
    expect(regions).toHaveLength(1)
    expect(regions[0].kind).toBe('fenced')
    expect(regions[0].end).toBe(text.length)
    expect(isCode(text, 'and more')).toBe(true)
    expect(isCode(text, 'Here is')).toBe(false)
  })

  it('finds inline code with one and with several backticks', () => {
    const text = 'Write `<batshit-memory>` or ``a `nested` tick`` then ```x``` here'
    expect(codeTexts(text)).toEqual([
      ['inline', '`<batshit-memory>`'],
      ['inline', '``a `nested` tick``'],
      ['inline', '```x```']
    ])
    expect(isCode(text, 'Write')).toBe(false)
    expect(isCode(text, 'then')).toBe(false)
  })

  it('does not count a lone backtick as code', () => {
    const text = 'A lone ` backtick and <batshit-memory>{"lane":"ltm"}</batshit-memory>'
    expect(findCodeRegions(text)).toEqual([])
  })

  it('counts indented code only where marked says so', () => {
    const indented = 'Para\n\n    <batshit-memory>{"a":1}</batshit-memory>\n    more\n\nAfter'
    expect(codeTexts(indented).map(([kind]) => kind)).toEqual(['indented'])
    expect(isCode(indented, '<batshit-memory>')).toBe(true)
    expect(isCode(indented, 'After')).toBe(false)

    // A lazy continuation line of a paragraph is paragraph text, not code.
    const lazy = 'Para line one\n    <batshit-memory>{"a":1}</batshit-memory>'
    expect(findCodeRegions(lazy)).toEqual([])
  })

  it('never counts an HTML block as code', () => {
    const text = '<batshit-memory>\n{"lane":"ltm","content":"use `npm run check`"}\n</batshit-memory>\n\n<div>\n`not parsed here`\n</div>\n\nand `real` code'
    expect(codeTexts(text)).toEqual([['inline', '`real`']])
    expect(isCode(text, '<batshit-memory>')).toBe(false)
  })

  it('finds code inside quotes, lists, and tables', () => {
    const text = [
      '> quoted `inline` and',
      '> ```',
      '> <batshit-memory>{"a":1}</batshit-memory>',
      '> ```',
      '',
      '- item `x`',
      '- item',
      '',
      '  ```',
      '  <batshit-tool-notes>{"notes":[]}</batshit-tool-notes>',
      '  ```',
      '',
      '| a | b |',
      '|---|---|',
      '| `<batshit-cue>` | <batshit-cue>{"mood":"x"}</batshit-cue> |',
      '',
      'Outside <batshit-group>{"mode":"responding"}</batshit-group>'
    ].join('\n')
    expect(isCode(text, '`inline`')).toBe(true)
    expect(isCode(text, '<batshit-memory>')).toBe(true)
    expect(isCode(text, '`x`')).toBe(true)
    expect(isCode(text, '<batshit-tool-notes>')).toBe(true)
    expect(isCode(text, '<batshit-cue>', 0)).toBe(true)
    expect(isCode(text, '<batshit-cue>', 1)).toBe(false)
    expect(isCode(text, '<batshit-group>')).toBe(false)
  })

  it('finds a code span with an escaped pipe in a table cell', () => {
    const text = '| a |\n|---|\n| `x\\|y` <batshit-memory> |'
    expect(isCode(text, '`x')).toBe(true)
    expect(isCode(text, '<batshit-memory>')).toBe(false)
  })

  it('maps offsets back through \\r\\n line ends', () => {
    const text = 'Line one\r\n\r\n```\r\n<batshit-memory>{}</batshit-memory>\r\n```\r\n\r\nx `<batshit-cue>` y <batshit-cue>{}</batshit-cue>'
    expect(isCode(text, '<batshit-memory>')).toBe(true)
    expect(isCode(text, '<batshit-cue>', 0)).toBe(true)
    expect(isCode(text, '<batshit-cue>', 1)).toBe(false)
    expect(isCode(text, 'Line one')).toBe(false)
    for (const region of findCodeRegions(text)) {
      expect(region.end).toBeLessThanOrEqual(text.length)
    }
    expect(codeTexts(text)).toEqual([
      ['fenced', '```\r\n<batshit-memory>{}</batshit-memory>\r\n```'],
      ['inline', '`<batshit-cue>`']
    ])
  })

  it('takes the nearest spelling of a table cell, not a later one inside another cell', () => {
    // The first cell is "``\\| a" in the source and "``| a" in marked's cell text; the plain
    // spelling also occurs later, at the end of the next row's first cell.
    const text = '``\\| a | `b` |\n|---|---|\nword `x\\`y```| a | `c` |\n'
    expect(codeTexts(text).map(([, code]) => code)).toEqual(['`b`', '`x\\`'])
  })

  it('returns nothing for an empty or code-free text', () => {
    expect(findCodeRegions('')).toEqual([])
    expect(findCodeRegions('Plain words, a < b, and <b>bold</b>.')).toEqual([])
  })

  it('returns ordered regions that do not overlap', () => {
    const text = 'a `b` c\n\n```\nd\n```\n\n    e\n\nf ``g`` h'
    const regions = findCodeRegions(text)
    for (let index = 1; index < regions.length; index += 1) {
      expect(regions[index].start).toBeGreaterThanOrEqual(regions[index - 1].end)
    }
    expect(regions.map((region) => region.kind)).toEqual(['inline', 'fenced', 'indented', 'inline'])
  })

  it('lexes a large reply in bounded time', () => {
    const block = '```ts\nconst x = { a: 1 } // `tick`\n```\n\nSome prose with `code` and <b>tags</b>.\n\n'
    const text = block.repeat(Math.ceil(400_000 / block.length))
    const started = performance.now()
    const regions = findCodeRegions(text)
    const elapsed = performance.now() - started
    expect(regions.length).toBeGreaterThan(1000)
    expect(elapsed).toBeLessThan(5_000)
  })
})

describe('isInCodeRegion', () => {
  it('answers by binary search over the ordered regions', () => {
    const regions: CodeRegion[] = [
      { start: 2, end: 5, kind: 'inline' },
      { start: 10, end: 20, kind: 'fenced' }
    ]
    expect([0, 1, 2, 4, 5, 9, 10, 19, 20, 99].map((index) => isInCodeRegion(regions, index))).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
      true,
      true,
      false,
      false
    ])
    expect(isInCodeRegion([], 0)).toBe(false)
    const adjacent: CodeRegion[] = [
      { start: 2, end: 5, kind: 'inline' },
      { start: 5, end: 8, kind: 'inline' }
    ]
    expect([4, 5, 7, 8].map((index) => isInCodeRegion(adjacent, index))).toEqual([true, true, true, false])
  })
})

describe('findCodeRegions agrees with marked over generated texts', () => {
  /** A small seeded generator, so a failure repeats. */
  function generator(seed: number) {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
  }

  /** Every code span and code block `marked`'s full lexer (inline included) reads, in order. */
  function markedCodeTexts(text: string): string[] {
    const texts: string[] = []
    const visit = (tokens: any[] | undefined) => {
      for (const token of tokens ?? []) {
        if (token.type === 'codespan') texts.push(token.raw)
        if (token.type === 'code') texts.push(token.raw.trim())
        visit(token.tokens)
        if (token.type === 'list') for (const item of token.items) visit(item.tokens)
        if (token.type === 'table') {
          for (const cell of token.header) visit(cell.tokens)
          for (const row of token.rows) for (const cell of row) visit(cell.tokens)
        }
      }
    }
    visit(new Marked({ ...CHAT_MARKDOWN_OPTIONS }).lexer(text))
    return texts
  }

  // Left out on purpose, because that is where the two differ (see the module's comment):
  // emphasis and strikethrough marks (`*`, `_`, `~`) next to code, and a backtick inside an inline
  // HTML tag or a link's address.
  const fragments = ['word', ' ', ' ', '`', '``', '```', '\\', 'a `b` c', '\n', '\n\n', '- ', '> ', '1. ', '    ', '<batshit-memory>', '{"a":1}', '|', '\n~~~\n', '\n```\n', 'x\\`y', '# ', '| a | `b` |\n|---|---|\n']

  it('finds the same code as marked in 2,000 generated texts', () => {
    const random = generator(442)
    const disagreements: string[] = []
    for (let sample = 0; sample < 2000; sample += 1) {
      let text = ''
      const length = 1 + Math.floor(random() * 30)
      for (let part = 0; part < length; part += 1) text += fragments[Math.floor(random() * fragments.length)]
      const ours = findCodeRegions(text).map((region) => text.slice(region.start, region.end).trim())
      const theirs = markedCodeTexts(text)
      const normalize = (values: string[]) =>
        values.map((value) => value.replace(/\n(?:>\s?|\s+)*/g, '\n').replace(/\\\|/g, '|'))
      if (JSON.stringify(normalize(ours)) !== JSON.stringify(normalize(theirs))) {
        disagreements.push(JSON.stringify({ text, ours, theirs }))
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([])
  })
})

describe('readCodeLayout and CodeSpanReader: the code spans, paired by the reader (BL-701)', () => {
  const fragments = ['word', ' ', '`', '``', '```', '\\', 'a `b` c', '\n', '\n\n', '\r\n', '- ', '> ', '    ', '<batshit-memory>', '{"a":1}', '|', '\n~~~\n', '\n```\n', 'x\\`y', '# ', '| a | `b` |\n|---|---|\n']
  function texts(seed: number, count: number): string[] {
    let state = seed >>> 0
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
    return Array.from({ length: count }, () => {
      let text = ''
      const length = 1 + Math.floor(random() * 30)
      for (let part = 0; part < length; part += 1) text += fragments[Math.floor(random() * fragments.length)]
      return text
    })
  }

  it('is findCodeRegions before its spans are paired, over 3,000 generated texts', () => {
    for (const text of texts(701, 3000)) {
      const layout = readCodeLayout(text)
      const spans = pairCodeSpans(layout.runs)
      const merged = [...layout.blocks, ...spans].sort((a, b) => a.start - b.start)
      expect(merged, JSON.stringify(text)).toEqual(findCodeRegions(text))
      // The runs come in order: the reader reads them left to right.
      for (let run = 1; run < layout.runs.length; run += 1) expect(layout.runs[run].start).toBeGreaterThan(layout.runs[run - 1].start)
    }
  })

  it('reads the same spans as findCodeRegions when it skips nothing, position by position', () => {
    for (const text of texts(702, 1500)) {
      const layout = readCodeLayout(text)
      const inline = pairCodeSpans(layout.runs)
      const reader = new CodeSpanReader(layout.runs, () => false)
      for (let index = 0; index <= text.length; index += 1) {
        expect(reader.covers(index), `${JSON.stringify(text)} at ${index}`).toBe(isInCodeRegion(inline, index))
      }
    }
  })

  it('never opens a span at a run it skips, and pairs the runs after it afresh', () => {
    // A lone backtick at 6 (inside what the skip names), then an inline code span.
    const text = 'block `x end then `code` ok'
    const layout = readCodeLayout(text)
    const unskipped = new CodeSpanReader(layout.runs, () => false)
    expect(unskipped.covers(text.indexOf('code'))).toBe(false) // `x … ` pairs, so `code` is outside
    const skipping = new CodeSpanReader(layout.runs, (start) => start < 9)
    expect(skipping.covers(text.indexOf('end'))).toBe(false)
    expect(skipping.covers(text.indexOf('code'))).toBe(true)
    expect(skipping.covers(text.indexOf('ok'))).toBe(false)
  })

  it('forks: a fork reads ahead and the reader it came from stays where it was', () => {
    const text = 'a `b` c `d` e'
    const reader = new CodeSpanReader(readCodeLayout(text).runs, () => false)
    expect(reader.covers(0)).toBe(false)
    const fork = reader.fork()
    expect(fork.covers(text.indexOf('d'))).toBe(true)
    expect(reader.covers(text.indexOf('b'))).toBe(true)
    expect(reader.covers(text.indexOf('c'))).toBe(false)
  })

  it('maps runs back through \\r\\n line ends', () => {
    const text = 'x\r\ny `z` w'
    const [run] = readCodeLayout(text).runs
    expect(text.slice(run.start, readCodeLayout(text).runs[run.close].end)).toBe('`z`')
  })
})

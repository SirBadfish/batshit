import { describe, expect, it } from 'vitest'

import {
  CONTROL_TAGS,
  findControlBlocks,
  removeControlBlocks,
  stripEmoteTags,
  stripIncompleteEmoteTag,
  type ControlBlock,
  type ControlTagSpec
} from './controlTags'
import { extractBatshitCuePayload } from './batshitCue'

/**
 * BL-442's rule, one table: a control block is a tag that is outside code, that is followed by
 * its payload, and that is closed. Everything else is text. Every case runs for every registered
 * tag, and for a finished reply (`final: true`) and a streaming one (`final: false`).
 */

const PAYLOADS: Record<string, string> = {
  'zip-control': '{"unzip":["tool_result_1"]}',
  'tool-notes': '{"notes":[{"toolName":"Read","summary":"a fact"}]}',
  memory: '{"lane":"ltm","content":"Josh likes tea"}',
  cue: '{"goon_mood":"happy"}',
  group: '{"mode":"responding"}'
}

const open = (spec: ControlTagSpec) => `<${spec.tag}>`
const close = (spec: ControlTagSpec) => `</${spec.tag}>`
const realBlock = (spec: ControlTagSpec) => `${open(spec)}${PAYLOADS[spec.id]}${close(spec)}`

/** The blocks as `[kind, the text they cover]`, which is what a reader acts on. */
function read(text: string, final: boolean): Array<[ControlBlock['kind'], string]> {
  return findControlBlocks(text, { final }).map((block) => [block.kind, text.slice(block.start, block.end)])
}

const BOTH = [true, false] as const

describe.each(CONTROL_TAGS.map((spec) => [spec.tag, spec] as const))('findControlBlocks: <%s>', (_name, spec) => {
  const block = realBlock(spec)

  it.each(BOTH)('reads a correct block at the start, in the middle, and at the end (final %s)', (final) => {
    expect(read(`${block}\nThen words.`, final)).toEqual([['paired', block]])
    expect(read(`Words, ${block} more words.`, final)).toEqual([['paired', block]])
    expect(read(`Words.\n\n${block}`, final)).toEqual([['paired', block]])
  })

  it.each(BOTH)('R1: never reads a tag in fenced, indented, or inline code (final %s)', (final) => {
    expect(read(`Example:\n\n\`\`\`\n${block}\n\`\`\`\n\nDone.`, final)).toEqual([])
    expect(read(`Example:\n\n~~~xml\n${block}\n~~~\n`, final)).toEqual([])
    expect(read(`Write \`${block}\` to do it.`, final)).toEqual([])
    expect(read(`Example:\n\n    ${block}\n\nDone.`, final)).toEqual([])
  })

  it('R1: counts an unclosed fence as code to the end while the reply streams', () => {
    expect(read(`Example:\n\`\`\`\n${block}\nstill code`, false)).toEqual([])
    expect(read(`Example:\n\`\`\`\n${open(spec)}{"a":`, false)).toEqual([])
  })

  it.each(BOTH)('R2: reads a tag named in a sentence as text (final %s)', (final) => {
    expect(read(`I write a ${open(spec)} block when I need one.`, final)).toEqual([])
    // Its closing tag in code closes nothing (R1).
    expect(read(`The ${open(spec)} tag, then \`${close(spec)}\` closes it.`, final)).toEqual([])
  })

  it.each(BOTH)('R2 (b): reads a closed block with a bad payload as a block, for its loud error (final %s)', (final) => {
    const bad = `${open(spec)}not a payload${close(spec)}`
    expect(read(`Words ${bad} more.`, final)).toEqual([['paired', bad]])
    const sentence = `${open(spec)} tag, then ${close(spec)}`
    expect(read(`The ${sentence} closes it.`, final)).toEqual([['paired', sentence]])
  })

  it.each(BOTH)('R2 (b): a mention never pairs across another opening tag of its kind (final %s)', (final) => {
    // The later opening tag stands between: the mention is text, and the real block is read.
    expect(read(`The ${open(spec)} tag. ${block}`, final)).toEqual([['paired', block]])
    // An opening tag in code between counts too.
    expect(read(`The ${open(spec)} tag, like \`${open(spec)}\`, ends with ${close(spec)} here.`, final)).toEqual([])
  })

  it.each(BOTH)('R2: lets spaces and line breaks come between the tag and its payload (final %s)', (final) => {
    const spaced = `${open(spec)}\n  ${PAYLOADS[spec.id]}\n${close(spec)}`
    expect(read(`Words.\n${spaced}`, final)).toEqual([['paired', spaced]])
  })

  it.each(BOTH)('R2: reads an empty block as a block, which its reader reports (final %s)', (final) => {
    const empty = `${open(spec)}${close(spec)}`
    expect(read(`Words ${empty}`, final)).toEqual([['paired', empty]])
  })

  it.each(BOTH)('R3: reads a real opening tag with no closing tag as unclosed, to the end (final %s)', (final) => {
    const broken = `${open(spec)}${PAYLOADS[spec.id].slice(0, 10)}`
    expect(read(`Words. ${broken}`, final)).toEqual([['unclosed', broken]])
  })

  it('R4 (strict): holds a start while the reply streams; at the end hides only a bare cut start', () => {
    // Only `<`, or letters that do not yet spell `<batshit-`: held, then text at the end.
    for (const tail of ['<', '<b', '<batshit']) {
      expect(read(`Words ${tail}`, false)).toEqual([['held-start', tail]])
      expect(read(`Words ${tail}`, true)).toEqual([])
    }
    // A bare cut start: `<batshit-` in full, then part of a name, or the name and spaces or nothing.
    for (const tail of ['<batshit-', `<${spec.tag.slice(0, 11)}`, `<${spec.tag}`, `<${spec.tag} `]) {
      expect(read(`Words ${tail}`, false)).toEqual([['held-start', tail]])
      expect(read(`Words ${tail}`, true)).toEqual([['held-start', tail]])
    }
    // A complete opening tag with nothing decisive after it: held while streaming, text at the end.
    for (const tail of [open(spec), `${open(spec)}\n  `]) {
      expect(read(`Words ${tail}`, false)).toEqual([['held-start', tail]])
      expect(read(`Words ${tail}`, true)).toEqual([])
    }
    // A full name followed by other words is never a tag: no tag has attributes.
    for (const tail of [`<${spec.tag} is how you begin one`, `<${spec.tag} version="1`]) {
      expect(read(`Words ${tail}`, false)).toEqual([])
      expect(read(`Words ${tail}`, true)).toEqual([])
    }
  })

  it.each(BOTH)('trap 1: a mention before a real block never pairs with its closing tag (final %s)', (final) => {
    const inCode = `Use \`${open(spec)}\` like this: ${block} and more words.`
    expect(read(inCode, final)).toEqual([['paired', block]])
    const inProse = `The ${open(spec)} tag is how; here: ${block} and more words.`
    expect(read(inProse, final)).toEqual([['paired', block]])
    const inFence = `\`\`\`\n${open(spec)}\n\`\`\`\nThen: ${block}`
    expect(read(inFence, final)).toEqual([['paired', block]])
  })

  it.each(BOTH)('matches the tag without regard to ASCII case and with spaces before `>`, never with attributes (final %s)', (final) => {
    const upper = `<${spec.tag.toUpperCase()}>${PAYLOADS[spec.id]}</${spec.tag.toUpperCase()}>`
    expect(read(upper, final)).toEqual([['paired', upper]])
    const spaced = `<${spec.tag} >${PAYLOADS[spec.id]}</ ${spec.tag} >`
    expect(read(spaced, final)).toEqual([['paired', spaced]])
    expect(read(`<${spec.tag} version="1">${PAYLOADS[spec.id]}</${spec.tag}>`, final)).toEqual([])
  })

  it.each(BOTH)('reads a longer tag name or a self-closing tag as text (final %s)', (final) => {
    expect(read(`<${spec.tag}x>${PAYLOADS[spec.id]}</${spec.tag}x>`, final)).toEqual([])
    expect(read(`<${spec.tag}-more>${PAYLOADS[spec.id]}</${spec.tag}-more>`, final)).toEqual([])
    expect(read(`<${spec.tag}/> ${PAYLOADS[spec.id]}`, final)).toEqual([])
    // After the name comes a space, a \`/\`, or the \`>\`, as in HTML; anything else is another word.
    expect(read(`<${spec.tag}!>${PAYLOADS[spec.id]}</${spec.tag}>`, final)).toEqual([])
    // An opening tag's attributes hold no \`<\`: a name and then another tag is not an opening tag.
    expect(read(`<${spec.tag}\n<b>${PAYLOADS[spec.id]}</${spec.tag}>`, final)).toEqual([])
  })

  it.each(BOTH)('reads several blocks of the tag, each on its own (final %s)', (final) => {
    expect(read(`${block}\n${block}\n${block}`, final)).toEqual([
      ['paired', block],
      ['paired', block],
      ['paired', block]
    ])
  })

  it.each(BOTH)('reads a tag inside another block\'s payload as payload (final %s)', (final) => {
    const other = CONTROL_TAGS.find((entry) => entry.id !== spec.id)!
    const outer = `${open(other)}{"content":"${block.replace(/"/g, '\\"')}"}${close(other)}`
    expect(read(`Words ${outer}`, final)).toEqual([['paired', outer]])
  })
})

describe('findControlBlocks: mixed replies', () => {
  const notes = realBlock(CONTROL_TAGS.find((spec) => spec.id === 'tool-notes')!)
  const memory = realBlock(CONTROL_TAGS.find((spec) => spec.id === 'memory')!)
  const zip = realBlock(CONTROL_TAGS.find((spec) => spec.id === 'zip-control')!)
  const cue = realBlock(CONTROL_TAGS.find((spec) => spec.id === 'cue')!)

  it('reads every kind in one reply, in order', () => {
    const text = `${cue} Hello there.\n\n${notes}\n${memory}\n${memory}\n${zip}`
    expect(read(text, true)).toEqual([
      ['paired', cue],
      ['paired', notes],
      ['paired', memory],
      ['paired', memory],
      ['paired', zip]
    ])
  })

  it('goes on reading the other tags after an unclosed one; a later same-name tag belongs to it', () => {
    const text = `Words. <batshit-memory>{"lane":"ltm"\n${notes}\n<batshit-memory>{"lane":"stm"}`
    const blocks = findControlBlocks(text, { final: true })
    expect(blocks.map((block) => [block.id, block.kind])).toEqual([
      ['memory', 'unclosed'],
      ['tool-notes', 'paired']
    ])
    expect(removeControlBlocks(text, blocks)).toBe('Words. ')
  })

  it('pairs an opening tag with the FIRST closing tag of its name after it, as the old readers did', () => {
    const text = `<batshit-memory>{"lane":"ltm"\n<batshit-memory>{"lane":"stm"}</batshit-memory> tail`
    expect(read(text, true)).toEqual([['paired', text.slice(0, -' tail'.length)]])
  })

  it('a mention in inline code, then a real block: the four bug cases next to one correct block', () => {
    const text = [
      'Here is the syntax:',
      '```',
      '<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>',
      '```',
      'I write a <batshit-memory> block to save, and `<batshit-memory>` in code.',
      'If the count is < 5, retry.',
      memory,
      'The end <'
    ].join('\n')
    expect(read(text, true)).toEqual([['paired', memory]])
    expect(read(text, false)).toEqual([
      ['paired', memory],
      ['held-start', '<']
    ])
  })

  it('reads a block after \\r\\n line ends at the right place', () => {
    const text = 'Line\r\n\r\n```\r\n<batshit-memory>{}</batshit-memory>\r\n```\r\n\r\n' + memory
    expect(read(text, true)).toEqual([['paired', memory]])
  })

  it('does not hold a < that is in code, or a < that cannot become a tag', () => {
    expect(read('```\nfor (i = 0; i <', false)).toEqual([])
    expect(read('x < 5 and y > 3', false)).toEqual([])
    expect(read('a <c', false)).toEqual([])
    // `<b` can still become `<batshit-…`: held for now, text at the end.
    expect(read('a <b', false)).toEqual([['held-start', '<b']])
    expect(read('a <b', true)).toEqual([])
    expect(read('x < ', false)).toEqual([])
  })
})

describe('findControlBlocks: the cue tag\'s tolerant payload (the design\'s open point)', () => {
  it.each(BOTH)('reads the forms its parser accepts as a start: JSON, a JSON string, a key first (final %s)', (final) => {
    for (const payload of ['{"goon_mood":"happy"}', '"{\\"goon_mood\\":\\"happy\\"}"', 'goon_mood: happy', "'mood'=calm", 'Emote: wave']) {
      const text = `Hi <batshit-cue>${payload}</batshit-cue> there`
      expect(read(text, final)).toEqual([['paired', `<batshit-cue>${payload}</batshit-cue>`]])
    }
  })

  it('reads only forms the parser itself accepts', () => {
    for (const payload of ['{"goon_mood":"happy"}', '"{\\"goon_mood\\":\\"happy\\"}"', 'goon_mood: happy', "'mood'=calm", 'Emote: wave']) {
      const parsed = extractBatshitCuePayload(payload)
      expect(Boolean(parsed.mood) || parsed.cues.length > 0).toBe(true)
    }
  })

  it.each(BOTH)('reads an unclosed block that starts with a key or a JSON string as a block (R2 a, final %s)', (final) => {
    expect(read('Hi <batshit-cue>goon_mood: hap', final)).toEqual([['unclosed', '<batshit-cue>goon_mood: hap']])
    expect(read('Hi <batshit-cue>"{\\"goon_mood', final)).toEqual([['unclosed', '<batshit-cue>"{\\"goon_mood']])
  })

  it.each(BOTH)('reads words that only contain a key later as a mention (final %s)', (final) => {
    // The parser alone would read a mood here (its key form may sit anywhere in the payload);
    // R2 asks for the payload to START the block, so a sentence that names the tag stays text.
    expect(extractBatshitCuePayload(' to set the mood: happy').mood).toBe('happy')
    expect(read('Use <batshit-cue> to set the mood: happy', final)).toEqual([])
  })

  it('holds a key still being written', () => {
    expect(read('Hi <batshit-cue>goon_mo', false)).toEqual([['held-start', '<batshit-cue>goon_mo']])
    expect(read('Hi <batshit-cue>mood ', false)).toEqual([['held-start', '<batshit-cue>mood ']])
    // At the end it is text: a full name followed by anything but spaces (R4 strict).
    expect(read('Hi <batshit-cue>goon_mo', true)).toEqual([])
  })
})

describe('removeControlBlocks', () => {
  it('removes the union of the ranges, in order', () => {
    const text = 'a<batshit-memory>{}</batshit-memory>b<batshit-cue>{}'
    const blocks = findControlBlocks(text, { final: true })
    expect(removeControlBlocks(text, blocks)).toBe('ab')
    expect(removeControlBlocks(text, [])).toBe(text)
  })
})

describe('findControlBlocks: cost (BL-640)', () => {
  it.each(CONTROL_TAGS.map((spec) => [spec.tag, spec] as const))(
    'reads 50,000 unclosed <%s> tags in about 1 MB in one pass',
    (_name, spec) => {
      const unit = `x ${open(spec)}{"a":1} `
      const text = unit.repeat(50_000)
      const started = performance.now()
      const blocks = findControlBlocks(text, { final: true })
      const elapsed = performance.now() - started
      expect(blocks).toHaveLength(1)
      expect(blocks[0].kind).toBe('unclosed')
      expect(elapsed).toBeLessThan(3_000)
    }
  )

  it('reads 50,000 mentions and 50,000 complete blocks in one pass', () => {
    const text = 'the <batshit-memory> tag and <batshit-memory>{"a":1}</batshit-memory> '.repeat(50_000)
    const started = performance.now()
    const blocks = findControlBlocks(text, { final: false })
    const elapsed = performance.now() - started
    expect(blocks).toHaveLength(50_000)
    expect(elapsed).toBeLessThan(3_000)
  })
})

describe('stripEmoteTags and stripIncompleteEmoteTag: the emote regexes, in one pass', () => {
  // The lazy regexes BL-442 retired from the registry, kept here as the reference.
  const emoteRegex = new RegExp(
    String.raw`<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*\/>[ \t]*|<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*>[\s\S]*?<\/(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?>[ \t]*`,
    'gi'
  )
  const incompleteRegex = new RegExp(String.raw`<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*$`, 'i')
  const pieces = [
    '<emote',
    '<goon-emote',
    '<EMOTE',
    '<emote-wave',
    '<goon-emote-smile-2',
    '</emote>',
    '</goon-emote>',
    '</emote-wave>',
    '</Goon-Emote-x>',
    '</emote-',
    '</emotex>',
    '>',
    '/>',
    ' name="smile"',
    'x',
    '_',
    '-',
    ' ',
    '\t',
    '\n',
    'text ',
    '<',
    '<b>',
    'İ'
  ]

  it('matches the regexes on 5,000 generated texts', () => {
    let state = 128
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
    for (let sample = 0; sample < 5000; sample += 1) {
      let text = ''
      const length = Math.floor(random() * 14)
      for (let part = 0; part < length; part += 1) text += pieces[Math.floor(random() * pieces.length)]
      expect(stripEmoteTags(text), JSON.stringify(text)).toBe(text.replace(emoteRegex, ''))
      expect(stripIncompleteEmoteTag(text), JSON.stringify(text)).toBe(text.replace(incompleteRegex, ''))
    }
  })

  it('strips 50,000 unclosed emote tags in about 1 MB in one pass', () => {
    const text = 'x <emote name="wave"> y '.repeat(50_000)
    const started = performance.now()
    expect(stripEmoteTags(text)).toBe(text)
    expect(stripIncompleteEmoteTag(`${text}<emote`)).toBe(text)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('one pass even when no `>` is near (BL-640)', () => {
  // Without the remembered `>`, each opening tag searched to the end: 0.5 s at 50,000 tags and
  // 2 s at 100,000 (it grows with the square); with it, 20 to 40 ms (measured 2026-09-27).
  it('reads 150,000 opening tags still being written, with one `>` at the very end', () => {
    for (const unit of ['<batshit-memory ', '<batshit-tool-notes x', 'a <batshit-cue\n']) {
      const text = `${unit.repeat(150_000)}>`
      const started = performance.now()
      findControlBlocks(text, { final: true })
      findControlBlocks(text, { final: false })
      expect(performance.now() - started).toBeLessThan(1_500)
    }
  })

  it('strips 150,000 emote openings with one `>` at the very end', () => {
    const text = `${'<emote a '.repeat(150_000)}>`
    const started = performance.now()
    stripEmoteTags(text)
    stripIncompleteEmoteTag(text)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('R4, strict (Faye, 2026-09-27): no tag has attributes; finished words are never cut', () => {
  const REVIEW_INPUTS = [
    "The memory prompt says so.\nWrap it in a <batshit-memory tag and it's saved.",
    'Use <batshit-memory with a "content" key.',
    'Write <batshit-memory then an object, e.g. f = () => {"content":"x"} and it works.\nMore text after.'
  ]

  it.each(BOTH)('keeps every word of the three review inputs (final %s)', (final) => {
    for (const text of REVIEW_INPUTS) expect(read(text, final)).toEqual([])
  })

  it('hides a bare cut start at the very end, streaming and finished', () => {
    for (const tail of ['<batshit-', '<batshit-mem', '<batshit-memory ']) {
      expect(read(`The answer. ${tail}`, false)).toEqual([['held-start', tail]])
      expect(read(`The answer. ${tail}`, true)).toEqual([['held-start', tail]])
    }
  })

  it('reads an opening tag only as its name, spaces or nothing, then `>`', () => {
    expect(read('<batshit-memory >{"lane":"ltm"}</batshit-memory>', true)).toEqual([
      ['paired', '<batshit-memory >{"lane":"ltm"}</batshit-memory>']
    ])
    expect(read('<batshit-memory lane="ltm">{"lane":"ltm"}</batshit-memory>', true)).toEqual([])
  })
})

describe('BL-701: a lone backtick in a block never shifts the code pairings after it, at any depth', () => {
  const BT = '`'
  /** A real block whose payload holds one lone backtick. */
  const lone = (spec: ControlTagSpec, word: string) => `${open(spec)}{"a":"quote ${BT}${word}"}${close(spec)}`
  /** An inline-code example of a block: code, never a block. */
  const example = (spec: ControlTagSpec) => `${BT}${realBlock(spec)}${BT}`

  it.each(CONTROL_TAGS.flatMap((spec) => BOTH.map((final) => [spec.tag, final, spec] as const)))(
    "reads Faye's probe (block A, inline code, block B, an inline-code example) as A and B: <%s> (final %s)",
    (_name, final, spec) => {
      const a = lone(spec, 'all')
      const b = lone(spec, 'more')
      const text = `${a} say ${BT}code one${BT} and ${b} then ${example(spec)} is the syntax.`
      expect(read(text, final)).toEqual([
        ['paired', a],
        ['paired', b]
      ])
    }
  )

  it('reads a chain of 1,000 blocks, each with a lone backtick and an inline-code example after it, as the 1,000 real blocks', () => {
    const blocks = CONTROL_TAGS.map((spec, index) => ({ spec, index }))
    const units = Array.from({ length: 1_000 }, (_, index) => {
      const spec = blocks[index % blocks.length].spec
      return { block: lone(spec, `q${index}`), text: `${lone(spec, `q${index}`)} then ${example(spec)} ok.` }
    })
    const text = units.map((unit) => unit.text).join(' ')
    expect(read(text, true)).toEqual(units.map((unit) => ['paired', unit.block]))
    // The probe's shape, chained: every block also has an inline code span after it.
    const probeUnits = Array.from({ length: 1_000 }, (_, index) => lone(CONTROL_TAGS[2], `p${index}`))
    const probeText = probeUnits.map((block) => `${block} say ${BT}code${BT} and`).join(' ') + ` ${example(CONTROL_TAGS[2])} end.`
    expect(read(probeText, true)).toEqual(probeUnits.map((block) => ['paired', block]))
  })

  it('reads a 1.5 MB chain in one pass: no rescan per block', () => {
    const memory = CONTROL_TAGS.find((spec) => spec.id === 'memory')!
    const unit = `${lone(memory, 'x')} then ${example(memory)} ok. `
    const count = Math.ceil(1_500_000 / unit.length)
    const text = unit.repeat(count)
    const started = performance.now()
    const blocks = findControlBlocks(text, { final: true })
    const elapsed = performance.now() - started
    expect(blocks).toHaveLength(count)
    expect(blocks.every((block) => text.slice(block.start, block.end) === lone(memory, 'x'))).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
  })

  it.each(BOTH)('still reads the BL-700 inputs as before (final %s)', (final) => {
    const notes = '<batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"no target `all\'"}]}</batshit-tool-notes>'
    const inlineExample = '`<batshit-memory>{"lane":"ltm","content":"x"}</batshit-memory>`'
    const memory = '<batshit-memory>{"lane":"ltm","content":"real"}</batshit-memory>'
    expect(read(`${notes} and the syntax is ${inlineExample} ok`, final)).toEqual([['paired', notes]])
    expect(read(`${notes} and the syntax is ${inlineExample} ok. ${memory}`, final)).toEqual([
      ['paired', notes],
      ['paired', memory]
    ])
  })

  it.each(BOTH)('reads ahead for a mention without moving the scan: a block in inline code inside it stays code (final %s)', (final) => {
    expect(
      read('<batshit-memory> see `<batshit-zip-control>{"a":1}</batshit-zip-control>` and `</batshit-memory>`', final)
    ).toEqual([])
  })

  it.each(CONTROL_TAGS.flatMap((spec) => BOTH.map((final) => [spec.tag, final, spec] as const)))(
    'reads a mention whose only closing tag is in a fenced code block as text: <%s> (final %s)',
    (_name, final, spec) => {
      expect(read(`The ${open(spec)} tag is closed like this:\n\n\`\`\`\n${close(spec)}\n\`\`\`\n`, final)).toEqual([])
    }
  )

  it.each(BOTH)('judges a bad-payload block without the backtick of a real block inside it (the one rescan, final %s)', (final) => {
    const bad = '<batshit-memory> tag <batshit-zip-control>{"a":"q `"}</batshit-zip-control></batshit-memory>'
    expect(read(`${bad}\`<batshit-cue>{"x":1}</batshit-cue>\``, final)).toEqual([['paired', bad]])
  })

  it.each(BOTH)('reads a ~~~ line inside a payload as payload, and the block after it (final %s)', (final) => {
    const memory = '<batshit-memory>{"a":1,\n~~~\n"b":2}</batshit-memory>'
    const notes = '<batshit-tool-notes>{"hold":["a.ts"]}</batshit-tool-notes>'
    expect(read(`Saved.\n${memory}\n${notes}`, final)).toEqual([
      ['paired', memory],
      ['paired', notes]
    ])
  })

  it('still reads a backtick fence line inside a payload as payload (the one rescan BL-700 kept for fences)', () => {
    const block = '<batshit-memory>{"content":"x",\n```\n"y":1}</batshit-memory>'
    const text = `Saved.\n${block}\nThe syntax:\n\n\`\`\`\n<batshit-memory>{"content":"x"}</batshit-memory>\n\`\`\`\n`
    expect(read(text, true)).toEqual([['paired', block]])
  })
})

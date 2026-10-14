import { describe, expect, it } from 'vitest'
import {
  REPLY_CONTROL_FINALIZED_FLAG,
  buildReplyControlMetadata,
  extractReplyControl,
  resolveZipToolNotesEnabled,
  stripReplyControlBlocks
} from './replyControl'
import { CONTROL_TAGS } from './controlTags'
import { stripZipControlBlocks, TOOL_NOTES_BLOCK_LIMIT } from './zipControl'

// SA-129 P2 (DL-08): a finished reply's control blocks, read in one place for the server's
// reply-end step and for `/api/sse`'s `end` rebuild.

const NOTES = '<batshit-tool-notes>\n{"notes":[{"toolName":"read_file","summary":"port is 5620"}],"hold":["src/app.ts"],"release":["docs/old.md"]}\n</batshit-tool-notes>'
const MEMORY = '<batshit-memory>\n{"lane":"ltm","content":"Josh likes short replies","importance":6}\n</batshit-memory>'
const ZIP_CONTROL = '<batshit-zip-control>\n{"unzip":["tool_result_1"],"zip":["cool_tool_1_abcde"]}\n</batshit-zip-control>'

describe('extractReplyControl', () => {
  it('reads notes, holds, releases, memory saves, and zip actions, and leaves only the prose', () => {
    const extraction = extractReplyControl(`Done. The port is 5620.\n\n${NOTES}\n${MEMORY}\n${ZIP_CONTROL}`)
    expect(extraction.cleaned).toBe('Done. The port is 5620.')
    expect(extraction.hadNotesBlock).toBe(true)
    expect(extraction.notes).toEqual([{ toolName: 'read_file', summary: 'port is 5620', toolCallId: undefined }])
    expect(extraction.hold).toEqual(['src/app.ts'])
    expect(extraction.release).toEqual(['docs/old.md'])
    expect(extraction.memoryBlocks).toHaveLength(1)
    expect(extraction.memoryBlocks[0].payload).toMatchObject({ lane: 'ltm', content: 'Josh likes short replies' })
    expect(extraction.hadZipControlBlock).toBe(true)
    expect(extraction.unzip).toEqual(['tool_result_1'])
    expect(extraction.zip).toEqual(['cool_tool_1_abcde'])
  })

  it('keeps the memory saves of a reply that also carries a zip-control block (the page lost them)', () => {
    // The page ran zip control before memory, and the zip-control cleaner strips every bulky
    // block, so this reply's save vanished without a word.
    const extraction = extractReplyControl(`Saved.\n${ZIP_CONTROL}\n${MEMORY}`)
    expect(extraction.memoryBlocks).toHaveLength(1)
    expect(extraction.memoryBlocks[0].payload?.content).toBe('Josh likes short replies')
    expect(extraction.cleaned).toBe('Saved.')
  })

  it('reads a block with only a hold', () => {
    const extraction = extractReplyControl('Holding the spec.\n<batshit-tool-notes>{"hold":["docs/spec.md"]}</batshit-tool-notes>')
    expect(extraction.notesParseError).toBeUndefined()
    expect(extraction.hold).toEqual(['docs/spec.md'])
    expect(extraction.notes).toEqual([])
  })

  it('reads a trailing bare payload with hold and release (the malformed-output recovery)', () => {
    const extraction = extractReplyControl('Done.\n{"notes":[],"hold":["a.ts"],"release":["b.ts"]}')
    expect(extraction.cleaned).toBe('Done.')
    expect(extraction.hold).toEqual(['a.ts'])
    expect(extraction.release).toEqual(['b.ts'])
  })

  it('never hides ordinary JSON that merely has a hold key', () => {
    const content = 'The config is:\n{"hold":"yes","name":"x"}'
    expect(extractReplyControl(content).cleaned).toBe(content)
  })

  it('reports unknown keys and entries that are not paths, and still applies the rest', () => {
    const extraction = extractReplyControl('<batshit-tool-notes>{"hold":["a.ts", 7, ""],"unzip":["x"]}</batshit-tool-notes>')
    expect(extraction.hold).toEqual(['a.ts'])
    expect(extraction.unknownNotesKeys).toEqual(['unzip'])
    expect(extraction.invalidHoldEntries).toEqual([
      { key: 'hold', value: '7' },
      { key: 'hold', value: '' }
    ])
  })

  it('reads a 1 MB reply of 50,000 unclosed Tool Notes tags and a zip-control block in one pass (BL-543)', () => {
    // A closed zip-control block sends the reply through `stripZipControlBlocks`, whose lazy Tool
    // Notes regex took about 15 s here (the review's measurement, 2026-09-27).
    const content = `Answer.\n${'<batshit-tool-notes>x'.repeat(50_000)}\n${ZIP_CONTROL}`

    const started = performance.now()
    const extraction = extractReplyControl(content)
    const elapsed = performance.now() - started

    expect(extraction.hadZipControlBlock).toBe(true)
    expect(extraction.unzip).toEqual(['tool_result_1'])
    expect(extraction.cleaned).not.toContain('batshit-zip-control')
    expect(extraction.cleaned.startsWith('Answer.\n<batshit-tool-notes>x')).toBe(true)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('is what `/api/sse` strips, and stripping twice changes nothing', () => {
    const raw = `Done.\n${NOTES}\n${MEMORY}`
    const once = stripReplyControlBlocks(raw)
    expect(once).toBe('Done.')
    expect(stripReplyControlBlocks(once)).toBe(once)
  })

  it('leaves a reply with no block as it is', () => {
    const content = 'Just an answer with `<code>` in it.'
    const extraction = extractReplyControl(content)
    expect(extraction.cleaned).toBe(content)
    expect(extraction.hadNotesBlock).toBe(false)
    expect(extraction.memoryBlocks).toEqual([])
  })
})

describe('buildReplyControlMetadata', () => {
  it('stores notes, holds, and releases at metadata.zipControl, as the page did', () => {
    const metadata = buildReplyControlMetadata(extractReplyControl(`Ok.\n${NOTES}`), { toolNotesEnabled: true })
    expect(metadata.zipControl).toEqual({
      unzip: [],
      zip: [],
      toolResultsSummary: [{ toolName: 'read_file', summary: 'port is 5620', toolCallId: undefined }],
      hold: ['src/app.ts'],
      release: ['docs/old.md']
    })
    expect(metadata.controlErrors).toEqual([])
  })

  it('drops the notes when Tool Notes are off for the agent, and keeps the holds', () => {
    const metadata = buildReplyControlMetadata(extractReplyControl(`Ok.\n${NOTES}`), { toolNotesEnabled: false })
    expect(metadata.zipControl?.toolResultsSummary).toEqual([])
    expect(metadata.zipControl?.hold).toEqual(['src/app.ts'])
  })

  it('turns every malformed part into a loud control error', () => {
    const metadata = buildReplyControlMetadata(
      extractReplyControl('<batshit-tool-notes>{not json</batshit-tool-notes>\n<batshit-zip-control>{"toolResultsSummary":[]}</batshit-zip-control>'),
      { toolNotesEnabled: true }
    )
    expect(metadata.controlErrors.map((error) => error.tag)).toEqual(['batshit-zip-control', 'batshit-tool-notes'])
    expect(metadata.controlErrors[0].error).toBe('Tool Notes fields inside the zip-control block were dropped.')
    expect(metadata.zipControl).toBeDefined()
  })

  it('is loud about a reply with more than one Tool Notes block, and keeps what every block asked (BL-357)', () => {
    const extraction = extractReplyControl(
      'Two notes blocks.\n<batshit-tool-notes>{"hold":["src/a.ts"]}</batshit-tool-notes>\n<batshit-tool-notes>{"notes":[{"summary":"later"}]}</batshit-tool-notes>'
    )
    expect(extraction.notesBlockCount).toBe(2)
    expect(extraction.hold).toEqual(['src/a.ts'])
    const metadata = buildReplyControlMetadata(extraction, { toolNotesEnabled: true })
    expect(metadata.zipControl?.hold).toEqual(['src/a.ts'])
    expect(metadata.zipControl?.toolResultsSummary).toEqual([{ summary: 'later', toolName: undefined, toolCallId: undefined }])
    expect(metadata.controlErrors).toHaveLength(1)
    expect(metadata.controlErrors[0]).toMatchObject({ tag: 'batshit-tool-notes' })
    expect(metadata.controlErrors[0].error).toContain('had 2 Tool Notes blocks. Batshit read them all')
    expect(metadata.controlErrors[0].hint).toMatch(/^Write one Tool Notes block, at the end of the reply\./)
  })

  it(`says which blocks it did not read when a reply has more than ${TOOL_NOTES_BLOCK_LIMIT} (BL-543)`, () => {
    const count = TOOL_NOTES_BLOCK_LIMIT + 3
    const extraction = extractReplyControl(
      `Many blocks.\n${'<batshit-tool-notes>{"notes":[{"summary":"s"}]}</batshit-tool-notes>\n'.repeat(count)}`
    )
    expect(extraction.notesBlockCount).toBe(count)
    expect(extraction.cleaned).toBe('Many blocks.')
    const metadata = buildReplyControlMetadata(extraction, { toolNotesEnabled: true })
    expect(metadata.zipControl?.toolResultsSummary).toHaveLength(TOOL_NOTES_BLOCK_LIMIT)
    expect(metadata.controlErrors).toHaveLength(1)
    expect(metadata.controlErrors[0].error).toContain(
      `had ${count} Tool Notes blocks. Batshit read the first ${TOOL_NOTES_BLOCK_LIMIT} and ignored the other 3`
    )
    expect(metadata.controlErrors[0].hint).toMatch(/^Write one Tool Notes block, at the end of the reply\./)
  })

  it('hands the hold step each block\'s holds and releases in order (BL-538)', () => {
    const extraction = extractReplyControl(
      'Two.\n<batshit-tool-notes>{"hold":["src/a.ts"]}</batshit-tool-notes>\n<batshit-tool-notes>{"notes":[{"summary":"n"}]}</batshit-tool-notes>\n<batshit-tool-notes>{"release":["./src/a.ts"]}</batshit-tool-notes>'
    )
    expect(extraction.holdBlocks).toEqual([
      { hold: ['src/a.ts'], release: [] },
      { hold: [], release: ['./src/a.ts'] }
    ])
  })

  it('a single block is one hold block, and a reply that asks nothing has none (BL-538)', () => {
    expect(
      extractReplyControl('<batshit-tool-notes>{"release":["a.ts"],"hold":["a.ts"]}</batshit-tool-notes>').holdBlocks
    ).toEqual([{ hold: ['a.ts'], release: ['a.ts'] }])
    expect(extractReplyControl('<batshit-tool-notes>{"notes":[{"summary":"n"}]}</batshit-tool-notes>').holdBlocks).toEqual([])
    expect(extractReplyControl('Plain.').holdBlocks).toEqual([])
  })

  it('says which keys it did not know', () => {
    const metadata = buildReplyControlMetadata(
      extractReplyControl('<batshit-tool-notes>{"notes":[],"keep":["a.ts"]}</batshit-tool-notes>'),
      { toolNotesEnabled: true }
    )
    expect(metadata.controlErrors[0].error).toBe('The Tool Notes block does not know "keep"; it was ignored.')
  })

  it('writes nothing for a reply with no block', () => {
    expect(buildReplyControlMetadata(extractReplyControl('Plain.'), { toolNotesEnabled: true })).toEqual({ controlErrors: [] })
  })

  it('names the flag `/api/sse` reads', () => {
    expect(REPLY_CONTROL_FINALIZED_FLAG).toBe('replyControlFinalized')
  })
})

describe('resolveZipToolNotesEnabled', () => {
  it('reads the agent, then the global setting, and is ON with nothing saved', () => {
    expect(resolveZipToolNotesEnabled({}, {})).toBe(true)
    expect(resolveZipToolNotesEnabled({}, { zip_tool_notes_enabled: false })).toBe(false)
    expect(resolveZipToolNotesEnabled({ zip_tool_notes_enabled: true }, { zip_tool_notes_enabled: false })).toBe(true)
    expect(resolveZipToolNotesEnabled({ zip_tool_notes_enabled: false }, undefined)).toBe(false)
  })
})

describe('BL-442: what the reply end saves', () => {
  const memory = '<batshit-memory>{"lane":"ltm","content":"Josh likes tea"}</batshit-memory>'

  it('saves nothing from an example in a code block, and keeps the example', () => {
    const reply = [
      'Here is how I save a memory:',
      '```',
      '<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>',
      '```',
      'That is all.'
    ].join('\n')
    const extraction = extractReplyControl(reply)
    expect(extraction.memoryBlocks).toEqual([])
    expect(extraction.cleaned).toBe(reply)
  })

  it('keeps a reply that names a tag in a sentence whole, with no error (BL-473)', () => {
    const reply = 'I write a <batshit-memory> block when you ask me to remember something, and `<batshit-tool-notes>` for notes.'
    const extraction = extractReplyControl(reply)
    expect(extraction.memoryBlocks).toEqual([])
    expect(extraction.hadNotesBlock).toBe(false)
    expect(extraction.cleaned).toBe(reply)
  })

  it('keeps a lone < and a reply that ends in one (BL-477, BL-577)', () => {
    for (const reply of ['If the count is < 5, retry the upload.', 'x < 5 and y > 3', 'The last one is <']) {
      expect(extractReplyControl(reply).cleaned).toBe(reply)
    }
  })

  it('still saves a correct block after all four, and a mention never pairs with its closing tag (trap 1)', () => {
    const reply = [
      '```',
      '<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>',
      '```',
      'I use `<batshit-memory>` and the <batshit-memory> tag; if x < 5 it waits.',
      memory,
      'The end <'
    ].join('\n')
    const extraction = extractReplyControl(reply)
    expect(extraction.memoryBlocks).toHaveLength(1)
    expect(extraction.memoryBlocks[0].payload?.content).toBe('Josh likes tea')
    expect(extraction.cleaned).toContain('I use `<batshit-memory>` and the <batshit-memory> tag; if x < 5 it waits.')
    expect(extraction.cleaned).toContain('<batshit-memory>{"lane":"ltm","content":"example"}</batshit-memory>')
    expect(extraction.cleaned.endsWith('The end <')).toBe(true)
  })

  it('hides a Tool Notes or zip-control block the reply was cut inside, and says so (BL-480)', () => {
    const notes = extractReplyControl('The answer.\n\n<batshit-tool-notes>{"notes":[{"toolName":"read","sum')
    expect(notes.cleaned).toBe('The answer.')
    expect(notes.notesParseError).toBe('Unclosed <batshit-tool-notes> block (missing </batshit-tool-notes>).')
    const zip = extractReplyControl('The answer.\n<batshit-zip-control>{"unzip":["tool_re')
    expect(zip.cleaned).toBe('The answer.')
    expect(zip.zipControlParseError).toBe('Unclosed <batshit-zip-control> block (missing </batshit-zip-control>).')
  })

  it('reads a later block of another kind after a broken one', () => {
    const extraction = extractReplyControl(
      'Answer.\n<batshit-memory>{"lane":"ltm"\n<batshit-tool-notes>{"hold":["a.ts"]}</batshit-tool-notes>'
    )
    expect(extraction.hold).toEqual(['a.ts'])
    expect(extraction.memoryBlocks.map((block) => block.parseError)).toEqual([
      'Unclosed <batshit-memory> block (missing </batshit-memory>).'
    ])
    expect(extraction.cleaned).toBe('Answer.')
  })

  it('reads at most 20 memory blocks, removes every one, and says how many were not read', () => {
    const reply = `Saved.\n${Array.from({ length: 25 }, (_, index) => `<batshit-memory>{"lane":"ltm","content":"fact ${index + 1}"}</batshit-memory>`).join('\n')}`
    const extraction = extractReplyControl(reply)
    expect(extraction.memoryBlocks.filter((block) => block.payload)).toHaveLength(20)
    expect(extraction.memoryBlocks[0]?.parseError).toBe(
      'This reply had 25 memory save blocks. Batshit read only the first 20; the other 5 were removed from the reply and not saved.'
    )
    expect(extraction.cleaned).toBe('Saved.')
  })

  it('keeps a cue block in the saved reply, and strips bare payloads at the edges when a zip-control block is there', () => {
    const cue = '<batshit-cue>{"goon_mood":"happy"}</batshit-cue>'
    expect(extractReplyControl(`${cue} Hi.`).cleaned).toBe(`${cue} Hi.`)
    const extraction = extractReplyControl(
      'Hi.\n<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>\n{"goon_mood":"happy"}'
    )
    expect(extraction.unzip).toEqual(['tool_result_1'])
    expect(extraction.cleaned).toBe('Hi.')
  })

  it.each(CONTROL_TAGS.map((spec) => [spec.tag] as const))(
    'reads a reply of 50,000 unclosed <%s> tags through the reply end and the compile strip in one pass (BL-640)',
    (tag) => {
      // The lazy regexes took 9 to 34 s of the one Node process on replies like this (measured
      // 2026-09-27); every compile paid it again, since the tags stay in the stored reply.
      const reply = `Answer.\n${`x <${tag}>{"a":1} `.repeat(50_000)}`
      expect(reply.length).toBeGreaterThan(1_000_000)
      let started = performance.now()
      extractReplyControl(reply)
      expect(performance.now() - started).toBeLessThan(2_000)
      started = performance.now()
      stripZipControlBlocks(reply)
      expect(performance.now() - started).toBeLessThan(2_000)
    }
  )
})

describe('BL-442 review: a backtick inside one block never makes the next real block code', () => {
  const notes =
    '<batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"make: No rule to make target `all\'"}]}</batshit-tool-notes>'
  const memory = '<batshit-memory>{"lane":"ltm","content":"Josh builds with `make release`","importance":6}</batshit-memory>'
  const zip = '<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>'

  it('reads a memory block right after a Tool Notes block whose payload holds a lone backtick', () => {
    const extraction = extractReplyControl(`Done.\n${notes}\n${memory}`)
    expect(extraction.notes).toEqual([{ toolName: 'bash', summary: "make: No rule to make target `all'" }])
    expect(extraction.memoryBlocks).toHaveLength(1)
    expect(extraction.memoryBlocks[0].payload?.content).toBe('Josh builds with `make release`')
    expect(extraction.cleaned).toBe('Done.')
  })

  it('reads a zip-control block after such a Tool Notes block, with inline code after it', () => {
    const extraction = extractReplyControl(`Done.\n${notes}\n${zip}\nThen run \`make\`.`)
    expect(extraction.unzip).toEqual(['tool_result_1'])
    expect(extraction.cleaned).toBe('Done.\n\nThen run `make`.')
  })

  it('reads a later block of another kind when a broken block before it holds a lone backtick', () => {
    const extraction = extractReplyControl(
      'Done.\n<batshit-memory>{"lane":"ltm","content":"a ` b\n<batshit-tool-notes>{"hold":["a.ts"]}</batshit-tool-notes>\nThen `x`.'
    )
    expect(extraction.hold).toEqual(['a.ts'])
  })

  it('reads two memory blocks when the first holds a lone backtick', () => {
    const first = '<batshit-memory>{"lane":"ltm","content":"the shell prompt ends in `"}</batshit-memory>'
    const extraction = extractReplyControl(`Saved.\n${first}\n${memory}`)
    expect(extraction.memoryBlocks.map((block) => block.payload?.content)).toEqual([
      'the shell prompt ends in `',
      'Josh builds with `make release`'
    ])
    expect(extraction.cleaned).toBe('Saved.')
  })
})

describe('R4, strict: the reply end never cuts finished words and hides a bare cut start (Faye, 2026-09-27)', () => {
  it('keeps every word of the three review inputs, with no error', () => {
    for (const reply of [
      "The memory prompt says so.\nWrap it in a <batshit-memory tag and it's saved.",
      'Use <batshit-memory with a "content" key.',
      'Write <batshit-memory then an object, e.g. f = () => {"content":"x"} and it works.\nMore text after.'
    ]) {
      const extraction = extractReplyControl(reply)
      expect(extraction.cleaned).toBe(reply)
      expect(extraction.memoryBlocks).toEqual([])
    }
  })

  it('hides a bare cut start at the very end, with no error', () => {
    for (const tail of ['<batshit-', '<batshit-mem', '<batshit-memory ']) {
      const extraction = extractReplyControl(`The answer. ${tail}`)
      expect(extraction.cleaned).toBe('The answer.')
      expect(extraction.memoryBlocks).toEqual([])
    }
  })
})

describe('a payload backtick never pairs with a later backtick in the same paragraph (BL-700)', () => {
  const notes = '<batshit-tool-notes>{"notes":[{"toolName":"bash","summary":"no target `all\'"}]}</batshit-tool-notes>'
  const example = '`<batshit-memory>{"lane":"ltm","content":"x"}</batshit-memory>`'

  it('reads an inline-code example after a Tool Notes block as code, and saves nothing', () => {
    const extraction = extractReplyControl(`${notes} and the syntax is ${example} ok`)
    expect(extraction.memoryBlocks).toEqual([])
    expect(extraction.notes).toEqual([{ toolName: 'bash', summary: "no target `all'" }])
    expect(extraction.cleaned).toBe(`and the syntax is ${example} ok`)
  })

  it('reads a chain of blocks that each hold a lone backtick (the one rescan and the payload rule together)', () => {
    const memory = '<batshit-memory>{"lane":"ltm","content":"prompt ends in `"}</batshit-memory>'
    const zip = '<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>'
    const extraction = extractReplyControl(`Done.\n${notes}\n${memory}\n${zip}\nThen run \`make\`.`)
    expect(extraction.memoryBlocks.map((block) => block.payload?.content)).toEqual(['prompt ends in `'])
    expect(extraction.unzip).toEqual(['tool_result_1'])
    expect(extraction.cleaned).toBe('Done.\n\nThen run `make`.')
  })

  it('still reads a real block after the example', () => {
    const memory = '<batshit-memory>{"lane":"ltm","content":"real"}</batshit-memory>'
    const extraction = extractReplyControl(`${notes} and the syntax is ${example} ok. ${memory}`)
    expect(extraction.memoryBlocks.map((block) => block.payload?.content)).toEqual(['real'])
    expect(extraction.cleaned).toBe(`and the syntax is ${example} ok.`)
  })
})

describe('a lone backtick in a block never shifts the code pairings after it, at any depth (BL-701)', () => {
  const blockA = '<batshit-memory>{"lane":"ltm","content":"quote `all"}</batshit-memory>'
  const blockB = '<batshit-memory>{"lane":"ltm","content":"quote `more"}</batshit-memory>'
  const example = '`<batshit-memory>{"lane":"ltm","content":"x"}</batshit-memory>`'

  it("saves the two real blocks of Faye's probe and keeps the inline-code example", () => {
    const extraction = extractReplyControl(`${blockA} say \`code one\` and ${blockB} then ${example} is the syntax.`)
    expect(extraction.memoryBlocks.map((block) => block.payload?.content)).toEqual(['quote `all', 'quote `more'])
    expect(extraction.cleaned).toBe(`say \`code one\` and  then ${example} is the syntax.`)
  })
})

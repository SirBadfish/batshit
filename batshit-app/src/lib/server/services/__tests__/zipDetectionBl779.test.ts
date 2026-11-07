/**
 * BL-779: the zip detector's leftovers after BL-489.
 *
 * (a) A pair whose opening tag sits after a stray backtick run in its paragraph is held until the
 *     run's reading is settled, so a watched reply saves what the full-reply pass saves.
 * (d) A closing tag inside a fence that opened in the block does not end it, on the server and on
 *     the page alike (`findErrorBlockClose` in `structuredTagScan.ts`).
 *
 * The zip store here is a stand-in that keeps each zip's words, so two saves are compared by the
 * words they zipped, not by their zip ids.
 */
import { describe, expect, it, vi } from 'vitest'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import { findStructuredElements } from '$lib/utils/structuredTagScan'

const store = vi.hoisted(() => ({ temp: new Map<string, string>(), zips: new Map<string, string>(), next: 0 }))

vi.mock('$lib/server/redisStreamService', () => ({
  redisStreamService: {
    trackConcurrentBlock: async () => store.next++,
    createTempStorageKey: (sessionId: string, messageId: string, type: string, index: number) =>
      `${sessionId}:${messageId}:${type}:${index}`,
    appendChunk: async (key: string, chunk: string) => {
      store.temp.set(key, (store.temp.get(key) ?? '') + chunk)
    }
  }
}))

vi.mock('$lib/server/zipService', () => ({
  createPermanentZip: async (sessionId: string, messageId: string, type: string, index: number) => {
    const key = `${sessionId}:${messageId}:${type}:${index}`
    const content = store.temp.get(key)
    store.temp.delete(key)
    if (!content) return null
    const zipId = `error_${1790000000000 + index}_t${index}`
    store.zips.set(zipId, content)
    return { zipId, reference: `{{batshit-zip:${zipId}:::Error output}}` }
  }
}))

const ZIP_REFERENCE = /\{\{batshit-zip:(error_[^:{}\n]+):::Error output\}\}/g
let run = 0

/** A saved reply with each zip reference replaced by the words it zipped. */
function words(saved: string): string {
  return saved.replace(ZIP_REFERENCE, (_reference, zipId: string) => `⟦${store.zips.get(zipId)}⟧`)
}

/** The words each zip of a saved reply holds, in order. */
function zippedWords(saved: string): string[] {
  return [...saved.matchAll(ZIP_REFERENCE)].map((match) => store.zips.get(match[1]) ?? '')
}

/** A watched reply: its chunks one by one, then the held words taken at its end. */
async function watched(chunks: string[]) {
  const service = new ZipDetectionService()
  const id = `w${++run}`
  let saved = ''
  for (const chunk of chunks) saved += (await service.processChunk(id, id, chunk)).content
  return saved + (await service.takeHeldText(id, id))
}

/** The full-reply pass (send-routed's, when no events were recorded). */
async function fullPass(text: string) {
  return (await new ZipDetectionService().processFullContent(`f${++run}`, 'm', text)).content
}

/** The Error cards the chat view draws from a text's own `<error>` pairs (not the compiled form). */
function viewErrorCards(text: string): string[] {
  return findStructuredElements(text)
    .filter((element) => element.name === 'error' && !element.partial)
    .map((element) => text.substring(element.openEnd ?? element.start, element.end - '</error>'.length))
}

describe('zipDetection: a pair after a stray backtick waits for the backtick to settle (BL-779 a)', () => {
  it('saves the same words watched and unwatched when a later backtick makes the pair code', async () => {
    const chunks = ['Use `<error>boom</error>', ' and `x` later.']

    const watchedSave = await watched(chunks)
    const unwatchedSave = await fullPass(chunks.join(''))

    expect(unwatchedSave).toBe('Use `<error>boom</error> and `x` later.')
    expect(watchedSave).toBe(unwatchedSave)
  })

  it('holds the pair and the words after it, then zips it at the reply end when no backtick came', async () => {
    const service = new ZipDetectionService()
    const id = 'bl779-a-end'

    expect((await service.processChunk(id, id, 'Use `<error>boom</error>')).content).toBe('Use `')
    expect((await service.processChunk(id, id, ' and more.')).content).toBe('')
    const tail = await service.takeHeldText(id, id)

    const [reference] = service.getMessageReferences(id, id)
    expect(tail).toBe(`${reference.reference} and more.`)
    expect(words('Use `' + tail)).toBe(words(await fullPass('Use `<error>boom</error> and more.')))
  })

  it('zips a held pair as soon as a blank line ends its paragraph', async () => {
    const service = new ZipDetectionService()
    const id = 'bl779-a-blank'

    expect((await service.processChunk(id, id, 'Use `<error>boom</error> and')).content).toBe('Use `')
    const next = await service.processChunk(id, id, ' more.\n\nNext `x` paragraph.')

    const [reference] = service.getMessageReferences(id, id)
    expect(next.content).toBe(`${reference.reference} and more.\n\nNext \`x\` paragraph.`)
    expect(await service.takeHeldText(id, id)).toBe('')
  })

  it('zips a held pair as soon as a list item, a heading, a fence, a quote, an HTML block or a `---` ends its paragraph', async () => {
    // A later backtick can no longer pair with the stray one: it is in another block.
    for (const line of ['- item', '1. item', '# Heading', '```', '~~~', '> quote', '---', '<div>']) {
      const service = new ZipDetectionService()
      const id = `bl779-a-ends-${line}`
      expect((await service.processChunk(id, id, 'Use `<error>boom</error> then')).content).toBe('Use `')
      const next = await service.processChunk(id, id, `\n${line}\n`)
      const [reference] = service.getMessageReferences(id, id)
      expect(reference?.reference, line).toBeTruthy()
      expect(next.content, line).toBe(`${reference.reference} then\n${line}\n`)

      const chunks = ['Use `<error>boom</error> then', `\n${line}\n`, 'and `x` later']
      expect(words(await watched(chunks)), line).toBe(words(await fullPass(chunks.join(''))))
    }
  })

  it('keeps a held pair held while a whole line goes on with its paragraph', async () => {
    // A table's delimiter row would make the line before it a table's header, and a later setext
    // underline takes a `***` rule into its heading's words: held, to be safe.
    for (const line of ['plain words', '    indented words', '<error>', '2. item', '#nohash', '|-|', '***', '___']) {
      const service = new ZipDetectionService()
      const id = `bl779-a-goes-on-${line}`
      await service.processChunk(id, id, 'Use `<error>boom</error> then')
      const next = await service.processChunk(id, id, `\n${line}\n`)
      expect(service.getMessageReferences(id, id), line).toEqual([])
      expect(next.content, line).toBe('')

      const chunks = ['Use `<error>boom</error> then', `\n${line}\n`, 'and `x` later']
      expect(words(await watched(chunks)), line).toBe(words(await fullPass(chunks.join(''))))
    }
  })

  it('keeps a held pair held at a setext underline its paragraph does not take (review S1\')', async () => {
    // Marked makes no setext heading of a paragraph with a line that starts an HTML block (an
    // `<error>` or a `<span>` alone on its line): `===` is then the paragraph's words, and the
    // backtick after it still pairs with the stray one over the tag. A rule (`---`) ends it either way.
    const byThree = (text: string) => Array.from({ length: Math.ceil(text.length / 3) }, (_, at) => text.slice(at * 3, at * 3 + 3))
    for (const text of [
      'a ` b\n<error>\nboom</error> c\n===\nd `',
      'a ` b\n<span>\n<error>boom</error> c\n===\nd `',
      'a ` b\n<error>\nboom</error> c\n  ===  \nd `',
      'a ` b <error>boom\n<error>\n</error> c\n===\nd `'
    ]) {
      const unwatched = await fullPass(text)
      expect(zippedWords(unwatched), text).toEqual([])
      for (const chunks of [text.split(/(?<=\n)/), [...text], byThree(text)]) {
        expect(words(await watched(chunks)), JSON.stringify(chunks)).toBe(words(unwatched))
      }
    }
    // A rule after such a paragraph does end it: the pair is zipped then, watched and unwatched.
    const rule = 'a ` b\n<error>\nboom</error> c\n---\nd `'
    expect(zippedWords(await fullPass(rule))).toEqual(['\nboom'])
    expect(words(await watched(rule.split(/(?<=\n)/)))).toBe(words(await fullPass(rule)))
    // A `-` still being written splits such a paragraph as an underline; when it turns out to be a
    // list item the paragraph is whole again, and its two backticks, both written already, pair over
    // the tag: the pair is read again then, with no new backtick run of the stray one's length.
    const regrouped = ['a `\n<error>\n</error> b`\n-', ' ````item\nmore']
    expect(await fullPass(regrouped.join(''))).toBe(regrouped.join(''))
    expect(words(await watched(regrouped))).toBe(words(await fullPass(regrouped.join(''))))
    // A `***` rule does not end the paragraph for good: a later `- ` underline makes one heading of
    // the lines before it, the rule among them, and its two ``-runs pair over the tag.
    const absorbed = ['``<error></err</error>\n***\n', '<ERROR>`` ~~~ \n- \n<error>']
    expect(zippedWords(await fullPass(absorbed.join('')))).toEqual([])
    expect(words(await watched(absorbed))).toBe(words(await fullPass(absorbed.join(''))))
    // The same for a block that has not closed yet and closes later (review N-a): read again then.
    const regroupedOpen = ['a `\n<error>\nb`\n-', ' ````item\n', 'x</error> done']
    expect(await fullPass(regroupedOpen.join(''))).toBe(regroupedOpen.join(''))
    expect(words(await watched(regroupedOpen))).toBe(words(await fullPass(regroupedOpen.join(''))))
    // Review S3: a backtick that comes while an unfinished `-` is the last line is read again once
    // the line ends: as a list item, it makes the paragraph whole again, and the backtick pairs.
    const readAgain = ['a `\n<span>\n<error>x</error> b\n', 'c `\n-', ' item\nd']
    expect(zippedWords(await fullPass(readAgain.join('')))).toEqual([])
    expect(words(await watched(readAgain))).toBe(words(await fullPass(readAgain.join(''))))
    // A tag above an unfinished `-` waits for the line: read as an underline, the line splits the
    // paragraph at the `<span>` line and the backticks around the tag pair; as a list item, not.
    const tagWaits = ['a `\n<span>\nb ` <error>x</error> `\n-', ' item\nmore']
    expect(zippedWords(await fullPass(tagWaits.join('')))).toEqual(['x'])
    expect(words(await watched(tagWaits))).toBe(words(await fullPass(tagWaits.join(''))))
    // So does the choice to hold a pair or zip it: read as an underline, the line would hide the
    // single backtick before the tag (paired over by ``-runs), whose later partner makes it code.
    const holdWaits = ['``\n<span>\n`` ` `` <error>x', '</error> b\n-', 'y then ` end']
    expect(zippedWords(await fullPass(holdWaits.join('')))).toEqual([])
    expect(words(await watched(holdWaits))).toBe(words(await fullPass(holdWaits.join(''))))
    // And a reply that ends on such a line reads it as written then (a tag already sent as words
    // before the line came stays words: the setext class, BL-1781).
    const endsOnMarker = ['a `\n', '<error>\nboom</error> c`\n-']
    const endsOnMarkerSave = await fullPass(endsOnMarker.join(''))
    expect(zippedWords(endsOnMarkerSave)).toEqual(['\nboom'])
    expect(words(await watched(endsOnMarker))).toBe(words(endsOnMarkerSave))
    expect(viewErrorCards(endsOnMarkerSave)).toEqual([])
    // Any other setext underline (`- `, `-`) only waits for a blank line, which is safe either way.
    for (const text of ['Use `<error>boom</error> then\n- \nand `x` later', 'a ` b\n<span>\n<error>boom</error> c\n-\nd `']) {
      expect(words(await watched(text.split(/(?<=\n)/))), text).toBe(words(await fullPass(text)))
    }
  })

  it('reads the lines of a paragraph inside a quote or a list item as its own, not as ending it', async () => {
    // Inside a quote a `> ` line goes on with the paragraph (read alone it would start a quote), so a
    // later backtick in the quote still pairs with the stray one.
    for (const chunks of [
      ['> a `<error>x</error> b', '\n> c ` d\n', 'e'],
      ['> a `<error>x</error> b', '\n> c d\n', '> e ` f'],
      ['- a `<error>x</error> b', '\n  c d\n', '  e ` f']
    ]) {
      const unwatchedSave = await fullPass(chunks.join(''))
      expect(unwatchedSave).toBe(chunks.join(''))
      expect(words(await watched(chunks))).toBe(words(unwatchedSave))
    }
  })

  it('zips a held pair at a tool card (the held words are taken before the card)', async () => {
    const service = new ZipDetectionService()
    const id = 'bl779-a-card'

    expect((await service.processChunk(id, id, 'Use `<error>boom</error> and')).content).toBe('Use `')
    const beforeCard = await service.takeHeldText(id, id)

    const [reference] = service.getMessageReferences(id, id)
    expect(beforeCard).toBe(`${reference.reference} and`)
  })

  it('keeps the one residual difference: a backtick after a tool card pairs across it only in the full pass', async () => {
    const service = new ZipDetectionService()
    const id = 'bl779-a-residual'
    const card = '{{batshit-zip:cool_tool_1790500000000_abcde:::Tool execution: read}}'

    let saved = (await service.processChunk(id, id, 'Use `<error>boom</error> and ')).content
    saved += await service.takeHeldText(id, id)
    saved += card
    saved += (await service.processChunk(id, id, ' then `x later.')).content
    saved += await service.takeHeldText(id, id)

    expect(zippedWords(saved)).toEqual(['boom'])
    expect(await fullPass(`Use \`<error>boom</error> and ${card} then \`x later.`)).toBe(
      `Use \`<error>boom</error> and ${card} then \`x later.`
    )
  })

  it('keeps a held pair\'s later pairs in order once it settles', async () => {
    const chunks = ['A `<error>one</error> b <error>two</error>', ' c\n\nd']

    const watchedSave = await watched(chunks)

    expect(zippedWords(watchedSave)).toEqual(['one', 'two'])
    expect(words(watchedSave)).toBe(words(await fullPass(chunks.join(''))))
  })

  it('hands a held pair back as words, with no zip, when the reply ended after its save', async () => {
    // `complete` or `error` after the finalize: a zip made now would be named by no saved reply.
    const service = new ZipDetectionService()
    const id = 'bl779-a-release'
    const zipsBefore = store.zips.size
    await service.processChunk(id, id, 'Use `<error>boom</error> and more')

    expect(service.releaseEndedReply(id, id)).toBe('<error>boom</error> and more')
    expect(service.getMessageReferences(id, id)).toEqual([])
    expect(store.zips.size).toBe(zipsBefore)
    expect(await service.takeHeldText(id, id)).toBe('')
  })

  it('reads a tag at a chunk\'s end only once the backtick run that ends the chunk is whole', async () => {
    // "`<error>`" alone reads the tag as code; the next backtick makes the run "``", which closes nothing.
    const chunks = ['Use `<error>`', '` boom</error> here.']
    const unwatchedSave = await fullPass(chunks.join(''))

    expect(zippedWords(unwatchedSave)).toEqual(['`` boom'])
    expect(words(await watched(chunks))).toBe(words(unwatchedSave))
  })

  it('lets an open block wait when a backtick run that ends the chunk would make its tag code', async () => {
    const grows = ['Use `<error>boom', ' `', '` and</error> more.']
    const stays = ['Use `<error>boom', ' `', ' and</error> more.']
    const unwatchedSave = await fullPass(grows.join(''))

    expect(zippedWords(unwatchedSave)).toEqual(['boom `` and'])
    expect(words(await watched(grows))).toBe(words(unwatchedSave))
    expect(await watched(stays)).toBe('Use `<error>boom ` and</error> more.')
    expect(await fullPass(stays.join(''))).toBe('Use `<error>boom ` and</error> more.')
  })

  it('reads a fence line at a chunk\'s end only once the line ends', async () => {
    // Right after a paragraph, "```..." with no newline yet is the paragraph's words; with it, a fence.
    const closeOnFenceLine = ['A <error>\n```</error>', '\ncode\n```\n</error> B']
    const tagOnFenceLine = ['A\n```js <error>x</error>', '\n```\nB']

    for (const chunks of [closeOnFenceLine, tagOnFenceLine]) {
      expect(words(await watched(chunks))).toBe(words(await fullPass(chunks.join(''))))
    }
    expect(zippedWords(await fullPass(closeOnFenceLine.join('')))).toEqual(['\n```</error>\ncode\n```\n'])
    expect(await fullPass(tagOnFenceLine.join(''))).toBe(tagOnFenceLine.join(''))
  })

})

describe('zipDetection: a closing tag inside a fence that opened in the block does not end it (BL-779 d)', () => {
  it('saves a block whose only closing tag is inside its own fence as words, watched and unwatched', async () => {
    const text = '<error>\n```\ncode </error> more\n```\nafter'

    expect(await watched([text])).toBe(text)
    expect(await watched(['<error>\n``', '`\ncode </er', 'ror> more\n``', '`\nafter'])).toBe(text)
    expect(await fullPass(text)).toBe(text)
    expect(viewErrorCards(text)).toEqual([])
  })

  it('ends the block at the first closing tag after the fence closes', async () => {
    const text = 'See <error>\n```\ncode </error> more\n```\nafter </error> tail'
    const blockWords = '\n```\ncode </error> more\n```\nafter '

    const unwatchedSave = await fullPass(text)
    const watchedSave = await watched(['See <error>\n```\ncode </err', 'or> more\n```\naf', 'ter </error> tail'])

    expect(zippedWords(unwatchedSave)).toEqual([blockWords])
    expect(unwatchedSave.endsWith('}} tail')).toBe(true)
    expect(words(watchedSave)).toBe(words(unwatchedSave))
    expect(viewErrorCards(text)).toEqual([blockWords])
  })

  it('keeps an Error tag inside the fence of a block that never closes as words, in the save and the view', async () => {
    // The tag on its own line would open an HTML block for the Markdown reader and hide the fence;
    // the close rule reads each `<error>` tag as words, so the fence is a fence.
    const text = '<error>\n```\n<error>y</error>\n```\nafter'

    expect(await fullPass(text)).toBe(text)
    expect(await watched(['<error>\n```\n<err', 'or>y</error>\n```\nafter'])).toBe(text)
    expect(viewErrorCards(text)).toEqual([])
  })

  it('reads a fence inside a list item or a quote as the chat view does', async () => {
    for (const text of [
      '- item <error>\n  ```\n  code </error>\n  ```\n- next',
      '> quote <error>\n> ```\n> code </error>\n> ```\n> after'
    ]) {
      expect(await fullPass(text)).toBe(text)
      expect(viewErrorCards(text)).toEqual([])
    }
  })

  it('decides a closing tag on a fence\'s opening line only once the line is whole', async () => {
    // A backtick later on the line means it never opened a fence: the closing tag then ends the block.
    const text = '<error>\n```js </error> `x`\nmore'
    const unwatchedSave = await fullPass(text)

    expect(zippedWords(unwatchedSave)).toEqual(['\n```js '])
    expect(words(await watched(['<error>\n```js </error>', ' `x`\nmore']))).toBe(words(unwatchedSave))

    // A zip reference after such a closing tag waits for the line too: the tag is not words yet.
    const withReference = ['A <error>x\n\n```</error>{{batshit-zip:cool_tool_1790500000000_abcde:::read}}', '`` tail\nmore']
    const referenceSave = await fullPass(withReference.join(''))
    expect(zippedWords(referenceSave)).toEqual(['x\n\n```'])
    expect(words(await watched(withReference))).toBe(words(referenceSave))

    // A reference the block waited on stays in its words: a closing tag after it, later, still spans it.
    const keptReference = ['A <error>x\n\n```</error>{{batshit-zip:cool_tool_1790500000000_abcde:::read}}', '\nmore</error>', '\n```\nok</error> end']
    expect(await fullPass(keptReference.join(''))).toBe(keptReference.join(''))
    expect(await watched(keptReference)).toBe(keptReference.join(''))

    // After a blank line the unfinished line is a fence at once; the closing tag on it is read again
    // when the backtick comes.
    const chunks = ['<error>\n\n```js </error>', ' `x`\nmore']
    const afterBlank = await fullPass(chunks.join(''))
    expect(zippedWords(afterBlank)).toEqual(['\n\n```js '])
    expect(words(await watched(chunks))).toBe(words(afterBlank))
    // Still read again when words with no fence mark come on that line first.
    const longer = ['<error>\n\n```js </error>', ' more', ' `x`\nmore']
    expect(zippedWords(await fullPass(longer.join('')))).toEqual(['\n\n```js '])
    expect(words(await watched(longer))).toBe(words(await fullPass(longer.join(''))))
  })
})

// Generated replies: watched (random chunks) vs the full pass vs the chat view, and, with tool cards
// between their parts, one chunking of a reply vs another. Known outside this proof, and absent from
// this seed's replies: the Markdown reader can still change how a paragraph
// reads from a later line with no backtick in it (a setext underline next to an `<error>` line, a
// list marker or indentation still being written), and an empty pair drops its tags, which can glue
// the words beside it into a new tag or a longer backtick run.
function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = [
  'a', 'word', ' ', ' ', ' ', '\n', '\n', '\n\n', '`', '`', '``', '\\`', '```', '\n```\n', '\n~~~\n',
  '\n```js\n', '\n    ', '\n> ', '\n- ', '<error>', '<error>', '<error>', '</error>', '</error>', '</error>',
  '<ERROR>', '</Error>', '\n<error>\n', '<', '<err', '</err', 'or>', '<errors>',
  // Review N4: CRLF, fences of four backticks (a fence inside a fence), a mid-line ~~~, a zip
  // reference in the words, and the lines that end a paragraph without a blank line (review S1).
  '\r\n', '\r\n\r\n', '\n````\n', '````', '\n````md\n', ' ~~~ ', '{{batshit-zip:cool_tool_1790500000000_abcde:::read}}',
  '\n# h\n', '\n1. ', '\n* ', '\n---\n', '\n***\n', '\n<div>\n',
  // Review S1': a setext underline, which a paragraph with an HTML-start line does not take.
  '\n===\n', '\n  ===  \n', '\n<span>\n'
]

function generateReply(random: () => number): string {
  const count = 3 + Math.floor(random() * 22)
  let text = ''
  for (let piece = 0; piece < count; piece += 1) text += PIECES[Math.floor(random() * PIECES.length)]
  return text
}

function cutIntoChunks(random: () => number, text: string): string[] {
  const chunks: string[] = []
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(random() * 10)
    chunks.push(text.slice(at, at + size))
    at += size
  }
  return chunks
}

describe('zipDetection: generated replies save the same words watched, unwatched, and in the view (BL-779)', () => {
  it('agrees three ways on replies with stray backticks, fences, and Error tags', async () => {
    const random = seededRandom(779)
    const failures: string[] = []
    const replies = 2000
    for (let index = 0; index < replies; index += 1) {
      const text = generateReply(random)
      const unwatchedSave = await fullPass(text)
      for (let chunking = 0; chunking < 2; chunking += 1) {
        const chunks = cutIntoChunks(random, text)
        const watchedSave = await watched(chunks)
        if (words(watchedSave) !== words(unwatchedSave)) {
          failures.push(`watched != full: ${JSON.stringify(chunks)}\n  watched ${JSON.stringify(words(watchedSave))}\n  full    ${JSON.stringify(words(unwatchedSave))}`)
        }
      }
      // The view of the saved reply draws no card from a pair the save kept as words.
      if (viewErrorCards(unwatchedSave).length > 0) {
        failures.push(`view draws a saved pair: ${JSON.stringify(unwatchedSave)}`)
      }
      // No words are lost (an empty pair drops its tags; a zip keeps its words).
      if (!/<error><\/error>/i.test(text)) {
        const rebuilt = unwatchedSave.replace(ZIP_REFERENCE, (_reference, zipId: string) => `<error>${store.zips.get(zipId)}</error>`)
        if (rebuilt.toLowerCase() !== text.toLowerCase()) failures.push(`words lost: ${JSON.stringify(text)} -> ${JSON.stringify(rebuilt)}`)
      }
    }
    expect(failures.slice(0, 10).join('\n')).toBe('')
  }, 120_000)
})

/**
 * A tool card's reference: placed in the saved reply by the rebuild, never read by the detector. So
 * the view of a saved reply with cards is not compared here: a reference can change how the lines
 * around it read (a line of spaces before it is no longer blank, a ` ~~~ ` after it no longer a
 * fence line), which the detector, reading without it, does not see.
 */
const card = (index: number) => `{{batshit-zip:cool_tool_179050000000${index}_card${index}:::read}}`

/** A watched reply with a tool card between its parts: each card takes the held words, settled, first. */
async function watchedWithCards(parts: string[][]): Promise<string> {
  const service = new ZipDetectionService()
  const id = `wc${++run}`
  let saved = ''
  for (const [index, chunks] of parts.entries()) {
    for (const chunk of chunks) saved += (await service.processChunk(id, id, chunk)).content
    saved += await service.takeHeldText(id, id)
    if (index < parts.length - 1) saved += card(index)
  }
  return saved
}

describe('zipDetection: generated replies with tool cards save the same words however they are chunked (BL-779, review N4)', () => {
  it('saves the same words for every chunking of the words before and after each card settle', async () => {
    const random = seededRandom(7790)
    const failures: string[] = []
    const replies = 800
    for (let index = 0; index < replies; index += 1) {
      const parts = Array.from({ length: 2 + Math.floor(random() * 3) }, () => generateReply(random))
      const whole = await watchedWithCards(parts.map((part) => [part]))
      for (let chunking = 0; chunking < 2; chunking += 1) {
        const chunked = await watchedWithCards(parts.map((part) => cutIntoChunks(random, part)))
        if (words(chunked) !== words(whole)) {
          failures.push(`chunking changed the save: ${JSON.stringify(parts)}\n  chunked ${JSON.stringify(words(chunked))}\n  whole   ${JSON.stringify(words(whole))}`)
        }
      }
    }
    expect(failures.slice(0, 10).join('\n')).toBe('')
  }, 120_000)
})

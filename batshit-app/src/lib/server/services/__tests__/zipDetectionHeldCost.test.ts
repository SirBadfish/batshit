/**
 * BL-779 (a), review S1: what a held pair costs while it is held. A closed `<error>` pair after a
 * stray backtick is held while a later backtick run could still pair with that one over its tag.
 * Only a new run of the length of such a backtick can (a run that is still growing is the chunk
 * end's own wait), so the reply is read again for code only then, never for every chunk with any
 * backtick; and a paragraph ended by a list item, a heading, a fence or a quote ends the hold, as a
 * blank line does. Measured here as the characters handed to the code reader per chunk, in the
 * spirit of the BL-489 search-cost pin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZipDetectionService } from '$lib/server/services/zipDetection'

const read = vi.hoisted(() => ({ characters: 0 }))
const store = vi.hoisted(() => ({ temp: new Map<string, string>(), next: 0 }))

vi.mock('$lib/utils/markdownCodeRegions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/markdownCodeRegions')>()
  return {
    ...actual,
    findCodeRegions: (text: string) => {
      read.characters += text.length
      return actual.findCodeRegions(text)
    },
    readCodeLayout: (text: string) => {
      read.characters += text.length
      return actual.readCodeLayout(text)
    }
  }
})

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
    const zipId = `error_${1790000000000 + index}_c${index}`
    return { zipId, reference: `{{batshit-zip:${zipId}:::Error output}}` }
  }
}))

beforeEach(() => {
  read.characters = 0
})

/** Streams `count` copies of `chunk` after `opening`; answers the most characters read for one chunk and what streamed. */
async function streamAfterHeldPair(id: string, opening: string, chunk: string, count: number) {
  const service = new ZipDetectionService()
  let streamed = (await service.processChunk(id, id, opening)).content
  let most = 0
  let total = 0
  for (let index = 0; index < count; index += 1) {
    read.characters = 0
    streamed += (await service.processChunk(id, id, chunk)).content
    most = Math.max(most, read.characters)
    total += read.characters
  }
  return { most, total, streamed, service }
}

describe('zipDetection: a held pair costs no rereading of the reply per chunk (BL-779 a, review S1)', () => {
  it('lets a list item end the held pair\'s paragraph, then streams every chunk at once and reads no code', async () => {
    const opening = 'Use `<error>boom</error> then\n'
    const chunk = '- use `x` ok\n'

    const { most, streamed, service } = await streamAfterHeldPair('cost-list', opening, chunk, 1000)

    const [reference] = service.getMessageReferences('cost-list', 'cost-list')
    expect(reference?.reference).toBeTruthy()
    expect(streamed).toBe(`Use \`${reference.reference} then\n${chunk.repeat(1000)}`)
    // One read of the short reply at the first list item; none after it.
    expect(most).toBeLessThan(200)
  })

  it('reads the reply for code only when a new backtick run could pair with the stray one', async () => {
    // The paragraph never ends, so the pair stays held; the new runs are two backticks long, and
    // only a single one could pair with the stray single backtick before the tag.
    const opening = 'Use `<error>boom</error> then'
    const chunk = ' and ``y`` more'

    const { most, streamed } = await streamAfterHeldPair('cost-runs', opening, chunk, 1000)

    expect(streamed).toBe('Use `')
    expect(most).toBe(0)
  })
})

// Review N-a (BL-1803): an `<error>` block that has not closed is held too, and its tag can still
// turn out to be code the same way, so the same rule reads the reply again for it.
describe('zipDetection: an open block costs no rereading of the reply per chunk (BL-779 a, review N-a, BL-1803)', () => {
  it('stops reading for code once a list item ends the open tag\'s paragraph', async () => {
    const { total, streamed } = await streamAfterHeldPair('open-list', 'Use `<error>boom then\n', '- use `x` ok\n', 4000)

    expect(streamed).toBe('Use `')
    // One read of the short reply at the first list item (its backtick could have paired); none after.
    expect(total).toBeLessThan(200)
  })

  it('reads the reply for code only when a new backtick run could pair with the stray one', async () => {
    const { most, streamed } = await streamAfterHeldPair('open-runs', 'Use `<error>boom then', ' and ``y`` more', 4000)

    expect(streamed).toBe('Use `')
    expect(most).toBe(0)
  })
})

/** Streams `count` list items after `opening`, each sent as its marker, then the rest of its line. */
async function streamSplitItems(id: string, opening: string, count: number) {
  const service = new ZipDetectionService()
  let streamed = (await service.processChunk(id, id, opening)).content
  let total = 0
  for (let index = 0; index < count; index += 1) {
    for (const chunk of ['  -', ' use x ok\n']) {
      read.characters = 0
      streamed += (await service.processChunk(id, id, chunk)).content
      total += read.characters
    }
  }
  return { total, streamed }
}

// Review S3: inside a list item (or a quote) only a blank line ends the hold, and a later list item
// whose chunk ends right after its marker looks, for that moment, like an unfinished setext
// underline. Such a line is counted only once it is whole; a whole `- use x ok` is a list item.
describe('zipDetection: list items sent marker first cost no rereading of the reply (BL-779 a, review S3)', () => {
  it('for a held pair inside a list item', async () => {
    const { total, streamed } = await streamSplitItems('split-held', '- Use `<error>boom</error> then\n', 4000)

    expect(streamed).toBe('- Use `')
    expect(total).toBeLessThan(200)
  })

  it('for an open block inside a list item', async () => {
    const { total, streamed } = await streamSplitItems('split-open', '- Use `<error>boom then\n', 4000)

    expect(streamed).toBe('- Use `')
    expect(total).toBeLessThan(200)
  })
})

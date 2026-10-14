import { describe, expect, it } from 'vitest'
import { ZipDetectionService } from '$lib/server/services/zipDetection'

describe('zipDetection', () => {
  it('leaves XML-style code tags alone instead of creating code content zips', async () => {
    const service = new ZipDetectionService()
    const content = 'Before <code language="html">&lt;main&gt;Hi&lt;/main&gt;</code> after.'

    const result = await service.processChunk('session-code-ignored', 'message-code-ignored', content)

    expect(result.shouldStream).toBe(true)
    expect(result.content).toBe(content)
    expect(service.getMessageReferences('session-code-ignored', 'message-code-ignored')).toEqual([])
  })

  it('does not drop prose or wedge the buffer when an empty error block cannot create a zip', async () => {
    const service = new ZipDetectionService()

    const result = await service.processChunk(
      'session-empty-error',
      'message-empty-error',
      'Before <error></error> after.'
    )

    expect(result.shouldStream).toBe(true)
    expect(result.content).toBe('Before  after.')
    expect(service.getMessageReferences('session-empty-error', 'message-empty-error')).toEqual([])

    const next = await service.processChunk(
      'session-empty-error',
      'message-empty-error',
      ' Next chunk.'
    )

    expect(next).toEqual({
      shouldStream: true,
      content: ' Next chunk.'
    })
  })

  it('keeps the closing-chunk content when an open error block cannot create a zip', async () => {
    const service = new ZipDetectionService()

    const opening = await service.processChunk(
      'session-open-error',
      'message-open-error',
      'Before <error>'
    )
    expect(opening).toEqual({
      shouldStream: true,
      content: 'Before '
    })

    const closing = await service.processChunk(
      'session-open-error',
      'message-open-error',
      '</error> after.'
    )

    expect(closing).toEqual({
      shouldStream: true,
      content: ' after.'
    })
    expect(service.getMessageReferences('session-open-error', 'message-open-error')).toEqual([])
  })
})

// BL-489: an Error zip is made only from a matched pair outside code and outside a zip
// reference; an opening tag with no closing tag stays text, in order, in both paths.
describe('zipDetection: only a matched pair becomes an Error zip (BL-489)', () => {
  async function stream(service: ZipDetectionService, id: string, chunks: string[]) {
    const out: string[] = []
    for (const chunk of chunks) {
      const result = await service.processChunk(id, id, chunk)
      out.push(result.shouldStream ? result.content : '')
    }
    return out
  }

  it('keeps every word in order when an opening tag has no closing tag (full-reply pass)', async () => {
    const service = new ZipDetectionService()
    const text = 'Intro words. Here <error> is where it went wrong, and then more words after it.'

    const result = await service.processFullContent('bl489-full-unclosed', 'm1', text)

    expect(result.content).toBe(text)
    expect(result.references).toEqual([])
  })

  it('keeps every word in order when an opening tag has no closing tag (chunk path)', async () => {
    const service = new ZipDetectionService()
    const chunks = ['Intro words. Here <error> is where', ' it went wrong,', ' and then more.']

    const out = await stream(service, 'bl489-stream-unclosed', chunks)
    const flushed = service.takeUnclosedText('bl489-stream-unclosed', 'bl489-stream-unclosed')

    expect(out.join('') + flushed).toBe(chunks.join(''))
    expect(out[0]).toBe('Intro words. Here ')
    expect(await service.finalizeOpenBlocks('bl489-stream-unclosed', 'bl489-stream-unclosed')).toEqual([])
  })

  it('still makes an Error zip from a matched pair, in place', async () => {
    const service = new ZipDetectionService()

    const result = await service.processFullContent(
      'bl489-pair',
      'm1',
      'Before <error>Trace line one\nTrace line two</error> after.'
    )

    expect(result.references).toHaveLength(1)
    const [ref] = result.references
    expect(result.content).toBe(`Before ${ref.reference} after.`)
    expect(ref.zipId).toMatch(/^error_/)
  })

  it('pairs the tags whatever their case', async () => {
    const service = new ZipDetectionService()

    const result = await service.processFullContent('bl489-case', 'm1', 'A <ERROR>trace</ERROR> B')

    expect(result.references).toHaveLength(1)
    expect(result.content).toBe(`A ${result.references[0].reference} B`)
  })

  it('leaves a tag inside fenced code as text', async () => {
    const service = new ZipDetectionService()
    const text = 'Example:\n\n```html\n<error>trace</error>\n```\n\nDone.'

    const result = await service.processFullContent('bl489-fence', 'm1', text)

    expect(result.content).toBe(text)
    expect(result.references).toEqual([])
  })

  it('leaves a tag inside an open fence as text while the reply streams', async () => {
    const service = new ZipDetectionService()
    const chunks = ['Example:\n\n```\n<error>', 'trace</error>\n', '```\nDone.']

    const out = await stream(service, 'bl489-stream-fence', chunks)

    expect(out).toEqual(chunks)
    expect(service.getMessageReferences('bl489-stream-fence', 'bl489-stream-fence')).toEqual([])
  })

  it('leaves a tag inside inline code as text', async () => {
    const service = new ZipDetectionService()
    const text = 'Wrap it in `<error>` tags and close with `</error>`.'

    const result = await service.processFullContent('bl489-inline', 'm1', text)

    expect(result.content).toBe(text)
    expect(result.references).toEqual([])
  })

  it('lets go of held words when a later chunk shows the tag was inline code', async () => {
    const service = new ZipDetectionService()
    const chunks = ['Wrap it in `<error>', '` tags. Then keep going.']

    const out = await stream(service, 'bl489-stream-inline', chunks)

    expect(out.join('')).toBe(chunks.join(''))
    expect(service.takeUnclosedText('bl489-stream-inline', 'bl489-stream-inline')).toBe('')
  })

  it('leaves a tag inside a zip reference label as text', async () => {
    const service = new ZipDetectionService()
    const text = 'See {{batshit-zip:cool_tool_1700000000000_abcde:::grep <error> log}} and read on </error> here.'

    const result = await service.processFullContent('bl489-ref', 'm1', text)

    expect(result.content).toBe(text)
    expect(result.references).toEqual([])
  })

  it('never lets a block swallow a zip reference', async () => {
    const service = new ZipDetectionService()
    const text = 'A <error> x {{batshit-zip:cool_tool_1700000000000_abcde:::Read}} y </error> z'

    const result = await service.processFullContent('bl489-span-ref', 'm1', text)

    expect(result.content).toBe(text)
    expect(result.references).toEqual([])
  })

  it('closes a block whose closing tag is split across two chunks', async () => {
    const service = new ZipDetectionService()

    const out = await stream(service, 'bl489-split-close', ['A <error>trace</err', 'or> B'])

    const refs = service.getMessageReferences('bl489-split-close', 'bl489-split-close')
    expect(refs).toHaveLength(1)
    expect(out).toEqual(['A ', `${refs[0].reference} B`])
  })

  it('streams text after a closed block at once', async () => {
    const service = new ZipDetectionService()

    const out = await stream(service, 'bl489-after', [
      'A <error>one</error> middle <error>two</error> tail',
      ' next words.'
    ])

    const refs = service.getMessageReferences('bl489-after', 'bl489-after')
    expect(refs).toHaveLength(2)
    expect(out).toEqual([`A ${refs[0].reference} middle ${refs[1].reference} tail`, ' next words.'])
  })
})

describe('zipDetection: split opening tags, rescan cost, and end-of-reply cleanup (BL-489 review)', () => {
  async function stream(service: ZipDetectionService, id: string, chunks: string[]) {
    const out: string[] = []
    for (const chunk of chunks) {
      const result = await service.processChunk(id, id, chunk)
      out.push(result.shouldStream ? result.content : '')
    }
    return out
  }

  it('holds a trailing partial opening tag until the next chunk decides, then zips the pair', async () => {
    const service = new ZipDetectionService()

    const out = await stream(service, 'bl489-split-open', ['A <Err', 'or>trace</error> B'])

    const refs = service.getMessageReferences('bl489-split-open', 'bl489-split-open')
    expect(refs).toHaveLength(1)
    expect(out).toEqual(['A ', `${refs[0].reference} B`])
  })

  it('saves the same thing for a split opener whether a tab watched or not', async () => {
    const chunks = ['Intro <er', 'ror> unclosed words.']
    const watched = new ZipDetectionService()
    const out = await stream(watched, 'bl489-split-same', chunks)
    const watchedText = out.join('') + watched.takeUnclosedText('bl489-split-same', 'bl489-split-same')

    const unwatched = await new ZipDetectionService().processFullContent('bl489-split-same-full', 'm1', chunks.join(''))

    expect(watchedText).toBe(chunks.join(''))
    expect(unwatched.content).toBe(watchedText)
  })

  it('releases a held partial opener as text when the next chunk does not finish the tag', async () => {
    const service = new ZipDetectionService()

    const out = await stream(service, 'bl489-held-release', ['a < b <e', 'x and more'])

    expect(out).toEqual(['a < b ', '<ex and more'])
  })

  it('hands back a held partial opener at the end of the reply', async () => {
    const service = new ZipDetectionService()

    const out = await stream(service, 'bl489-held-end', ['Ends with <err'])
    const tail = service.takeUnclosedText('bl489-held-end', 'bl489-held-end', { endOfReply: true })

    expect(out.join('') + tail).toBe('Ends with <err')
  })

  it('searches only the new text (plus a closing-tag overlap) for the closing tag while a block is held', async () => {
    const service = new ZipDetectionService()
    const id = 'bl489-rescan'
    await service.processChunk(id, id, 'x <error>' + 'a'.repeat(5000))

    const seen: number[] = []
    const realExec = RegExp.prototype.exec
    const spy = function (this: RegExp, input: string) {
      if (this.source === '<\\/error>') seen.push(this.lastIndex)
      return realExec.call(this, input)
    }
    RegExp.prototype.exec = spy as typeof RegExp.prototype.exec
    try {
      await service.processChunk(id, id, 'bbbb')
    } finally {
      RegExp.prototype.exec = realExec
    }

    expect(seen.length).toBeGreaterThan(0)
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(5000 - '</error>'.length + 1)
  })

  it('lets go of a reply\'s zip references and context when it ends without end', async () => {
    const service = new ZipDetectionService()
    const id = 'bl489-leak'
    service.setContext(id, id, { messagesFromEnd: 0 })
    await service.processChunk(id, id, 'A <error>trace</error> then <error> never closed')
    expect(service.getMessageReferences(id, id)).toHaveLength(1)

    service.takeUnclosedText(id, id, { endOfReply: true })

    expect(service.getMessageReferences(id, id)).toEqual([])
    expect((service as any).messageContexts.has(`${id}:${id}`)).toBe(false)
  })
})

/**
 * BL-759: a lane can take back a segment of a reply (a Codex message that dropped and was
 * started again). The detector reads each chunk after everything it handed back so far, and can
 * hold words across chunks, so the segment's words must leave its scan state too: what it handed
 * back, a block it opened, the start of a tag it held, and a zip it closed.
 */
describe('zipDetection: a segment taken back leaves no trace (BL-759)', () => {
  it('forgets a block the segment opened: its words are not held any more', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-open'
    expect((await service.processChunk(id, id, 'Intro. ')).content).toBe('Intro. ')
    expect((await service.processChunk(id, id, 'Partial <error>held', 'msg_1')).content).toBe('Partial ')
    expect((await service.processChunk(id, id, ' words', 'msg_1')).content).toBe('')

    expect(service.discardSegment(id, id, 'msg_1')).toEqual({ outcome: 'rewound', zipReferences: [] })
    expect(service.takeUnclosedText(id, id)).toBe('')
  })

  it('forgets what the segment handed back, so a fence it opened does not make later words code', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-fence'
    expect((await service.processChunk(id, id, 'Partial:\n\n```\n', 'msg_1')).content).toBe('Partial:\n\n```\n')
    expect(service.discardSegment(id, id, 'msg_1').outcome).toBe('rewound')

    const next = await service.processChunk(id, id, 'Hello <error>trace</error> done.', 'msg_2')
    const [ref] = service.getMessageReferences(id, id)
    expect(ref?.zipId).toMatch(/^error_/)
    expect(next.content).toBe(`Hello ${ref.reference} done.`)
  })

  it('gives back the zip a segment closed and reopens the block an earlier segment began', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-close'
    expect((await service.processChunk(id, id, 'A <error>trace ', 'msg_1')).content).toBe('A ')
    const closed = await service.processChunk(id, id, 'more</error> after', 'msg_2')
    const [fragmentRef] = service.getMessageReferences(id, id)
    expect(closed.content).toBe(`${fragmentRef.reference} after`)

    expect(service.discardSegment(id, id, 'msg_2')).toEqual({ outcome: 'rewound', zipReferences: [fragmentRef] })
    expect(service.getMessageReferences(id, id)).toEqual([])

    // msg_1's open block is back, with msg_1's words only.
    const again = await service.processChunk(id, id, 'again</error>!', 'msg_3')
    const refs = service.getMessageReferences(id, id)
    expect(refs).toHaveLength(1)
    expect(refs[0].reference).not.toBe(fragmentRef.reference)
    expect(again.content).toBe(`${refs[0].reference}!`)
  })

  it('holds again the start of a tag an earlier segment held', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-held'
    expect((await service.processChunk(id, id, 'x <err', 'msg_1')).content).toBe('x ')
    expect((await service.processChunk(id, id, 'and more', 'msg_2')).content).toBe('<errand more')
    expect(service.discardSegment(id, id, 'msg_2').outcome).toBe('rewound')
    await service.processChunk(id, id, 'or>y</error>', 'msg_3')
    expect(service.getMessageReferences(id, id)).toHaveLength(1)
  })

  it('rewinds only the last segment it read, and says so', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-order'
    await service.processChunk(id, id, 'a', 'msg_1')
    await service.processChunk(id, id, 'b', 'msg_2')
    expect(service.discardSegment(id, id, 'msg_1').outcome).toBe('superseded')
    expect(service.discardSegment(id, id, 'msg_9').outcome).toBe('unknown')

    // Words with no segment after it, or a flush of held words before a tool card, end it too.
    await service.processChunk(id, id, 'c', 'msg_3')
    await service.processChunk(id, id, ' Batshit words')
    expect(service.discardSegment(id, id, 'msg_3').outcome).toBe('superseded')
    await service.processChunk(id, id, '<error>open', 'msg_4')
    expect(service.takeUnclosedText(id, id)).toBe('<error>open')
    expect(service.discardSegment(id, id, 'msg_4').outcome).toBe('superseded')

    expect(service.discardSegment(id, id, 'msg_2').outcome).toBe('superseded')
    await service.processChunk(id, id, 'd', 'msg_5')
    expect(service.discardSegment(id, id, 'msg_5').outcome).toBe('rewound')
    expect(service.discardSegment(id, id, 'msg_5').outcome).toBe('unknown')
  })
})

// BL-759 review: the adapter hands on a retract before any other words reach the stream (a steer
// marker included), so the fragment is the detector's last run when it is taken back. Two
// unfinished messages are taken back newest first. Anything else (a segment read in two runs, or
// words read after it) is `superseded`: the detector changes nothing and the caller treats the
// reply's record as a gap (send-routed then saves its own copy).
describe('zipDetection: the runs a retract can rewind (BL-759 review)', () => {
  it('rewinds two unfinished segments newest first, each to where it began', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-stack'
    await service.processChunk(id, id, 'Intro ')
    await service.processChunk(id, id, 'A <error>held-a', 'msg_a')
    await service.processChunk(id, id, ' more-b', 'msg_b')

    expect(service.discardSegment(id, id, 'msg_b').outcome).toBe('rewound')
    expect(service.discardSegment(id, id, 'msg_a').outcome).toBe('rewound')
    expect(service.takeUnclosedText(id, id)).toBe('')
    const next = await service.processChunk(id, id, 'Hello <error>t</error>', 'msg_c')
    const [ref] = service.getMessageReferences(id, id)
    expect(next.content).toBe(`Hello ${ref.reference}`)
  })

  it('gives an earlier segment\'s held start of a tag back to it when the fragment that read it in goes (case B)', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-held-in'
    expect((await service.processChunk(id, id, 'x <err', 'msg_r')).content).toBe('x ')
    expect((await service.processChunk(id, id, 'or>trace', 'msg_s')).content).toBe('')
    expect(service.discardSegment(id, id, 'msg_s').outcome).toBe('rewound')
    expect((await service.processChunk(id, id, 'Hello', 'msg_t')).content).toBe('<errHello')
  })

  it('a segment read in two runs is superseded, and the detector changes nothing', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-split'
    await service.processChunk(id, id, 'A <error>z</error> first ', 'msg_x')
    const refs = service.getMessageReferences(id, id)
    await service.processChunk(id, id, 'mid ')
    await service.processChunk(id, id, 'second <error>held', 'msg_x')

    expect(service.discardSegment(id, id, 'msg_x')).toEqual({ outcome: 'superseded', zipReferences: [] })
    expect(service.getMessageReferences(id, id)).toEqual(refs)
    expect(service.takeUnclosedText(id, id)).toBe('<error>held')
  })

  it('a segment with words read after it is superseded, and the detector changes nothing (cases A and C)', async () => {
    const service = new ZipDetectionService()
    const id = 'bl759-after'
    await service.processChunk(id, id, '<error>r-words ', 'msg_r')
    await service.processChunk(id, id, 'x</error> y <err', 'msg_s')
    const refs = service.getMessageReferences(id, id)
    await service.processChunk(id, id, 'or>steer')

    expect(service.discardSegment(id, id, 'msg_s')).toEqual({ outcome: 'superseded', zipReferences: [] })
    expect(service.getMessageReferences(id, id)).toEqual(refs)
    expect(service.takeUnclosedText(id, id)).toBe('<error>steer')
  })
})

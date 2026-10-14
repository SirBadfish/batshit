import { describe, expect, it } from 'vitest'
import { isTagStillBeingWritten, splitRealtimeSpeechBuffer } from './realtimeSpeechChunker'

describe('isTagStillBeingWritten', () => {
  it.each([
    ['<', true],
    ['</', true],
    ['<span', true],
    ['</span ', true],
    ['<span/', true],
    ['<span /', true],
    ['<span data-name', true],
    ['<span _:name.2-', true],
    ['<span data-name =', true],
    ['<span data-name = ', true],
    ['<span data-name="unfinished', true],
    ["<span data-name='unfinished", true],
    ['<span data-name="done" next=', true],
    ['<span data-name=value/ ', true],
    ['<span a= b=ok', true],
    ['<span a= b = c= ', true],
    ['<span a= b c=ok', true],
    ['<span a=""/', true],
    ['<span a="line\nbreak', true],
    ['<span\u00a0data-name=ok', true],
    ['', false],
    ['span', false],
    ['< 5', false],
    ['</ ', false],
    ['<1span', false],
    ['<_span', false],
    ['<span.', false],
    ['<span/ ', false],
    ['<span =', false],
    ['<span 2name', false],
    ['<span a=b=c', false],
    ['<span a=`value', false],
    ['<span a="done"next', false],
    ['<span a="done"/ ', false],
    ['<span a="nested<', false],
    ['<span a="closed>', false],
    ["<batshit-memory tag and it's saved", false],
    ['<span>', false]
  ] as const)('recognizes the existing incomplete-tag grammar for %j', (text, expected) => {
    expect(isTagStillBeingWritten(text)).toBe(expected)
  })

  it('matches the former grammar on bounded combinations and every prefix of complete tags', () => {
    // Comparison inputs stay short: never send the long malformed regression to this regex.
    const formerGrammar =
      /^<\/?(?:[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*(?:"[^"<>]*"?|'[^'<>]*'?|[^\s"'=<>`]*))?)*\s*\/?)?$/
    const completeTags = [
      '<span title="hello" disabled />',
      "<x:y _a.2='hello' b=word/>",
      '<tag a= b = c= />',
      '</tag >',
      '<tag\tdata-name = "line\nbreak">'
    ]
    const candidates = new Set<string>()
    for (const tag of completeTags) {
      for (let end = 0; end <= tag.length; end += 1) candidates.add(tag.slice(0, end))
    }
    const parts = ['a', '_:', ' ', '\t', '=', '"', "'", '/', '.', '`', '<', '>']
    for (const first of parts) {
      for (const second of parts) {
        for (const third of parts) {
          candidates.add(`<t ${first}${second}${third}`)
          candidates.add(`<t a= ${first}${second}${third}`)
          candidates.add(`</${first}${second}${third}`)
        }
      }
    }
    for (const text of candidates) {
      expect(isTagStillBeingWritten(text), JSON.stringify(text)).toBe(formerGrammar.test(text))
    }
  })

  it('rejects the long malformed CodeQL attribute tails without retrying their possible values (BL-1508)', () => {
    const cases = [
      `<A :=${'  :='.repeat(25_000)}\``,
      `<A :="${'  :="'.repeat(25_000)}"\``,
      `<A :='${"  :='".repeat(25_000)}'\``
    ]
    for (const text of cases) {
      expect(isTagStillBeingWritten(text)).toBe(false)
      expect(isTagStillBeingWritten(text.slice(0, -1))).toBe(true)
    }
  })
})

describe('splitRealtimeSpeechBuffer', () => {
  it('flushes stable sentence chunks and keeps unfinished text pending', () => {
    const result = splitRealtimeSpeechBuffer(
      'First sentence is ready. Second sentence is still being written'
    )

    expect(result.chunks).toEqual(['First sentence is ready.'])
    expect(result.remainder).toBe('Second sentence is still being written')
  })

  it('waits for short unfinished text instead of sending jittery fragments', () => {
    const result = splitRealtimeSpeechBuffer('This is still')

    expect(result.chunks).toEqual([])
    expect(result.remainder).toBe('This is still')
  })

  it('flushes the remaining speakable text at the final event', () => {
    const result = splitRealtimeSpeechBuffer('This is the last partial thought', { final: true })

    expect(result.chunks).toEqual(['This is the last partial thought'])
    expect(result.remainder).toBe('')
  })

  it('uses Markdown-stripped text when deciding whether a chunk is speakable', () => {
    const result = splitRealtimeSpeechBuffer('**Bold update:** this part is ready.')

    expect(result.chunks).toEqual(['**Bold update:** this part is ready.'])
    expect(result.remainder).toBe('')
  })

  it('flushes past a lone < in a sentence instead of holding speech to the reply end (BL-477)', () => {
    const result = splitRealtimeSpeechBuffer('If the count is < 5, retry the upload. Then it goes on')
    expect(result.chunks).toEqual(['If the count is < 5, retry the upload.'])
    expect(result.remainder).toBe('Then it goes on')
  })

  it('does not flush across incomplete control markup', () => {
    const result = splitRealtimeSpeechBuffer('Visible text is ready. <batshit-cue')

    expect(result.chunks).toEqual([])
    expect(result.remainder).toBe('Visible text is ready. <batshit-cue')
  })

  it('can force-flush enough stable text for latency-sensitive realtime playback', () => {
    const result = splitRealtimeSpeechBuffer(
      'This clause has enough stable words to start speaking even before punctuation',
      { force: true, minSpeakableChars: 40 }
    )

    expect(result.chunks).toEqual([
      'This clause has enough stable words to start speaking even before punctuation'
    ])
    expect(result.remainder).toBe('')
  })

  it('does not force-flush unstable markup', () => {
    const result = splitRealtimeSpeechBuffer(
      'This clause would be long enough, but a control tag is starting <batshit-cue',
      { force: true, minSpeakableChars: 40 }
    )

    expect(result.chunks).toEqual([])
    expect(result.remainder).toBe(
      'This clause would be long enough, but a control tag is starting <batshit-cue'
    )
  })

  it('holds partial attribute values for normal and forced flushes, then resumes stable sentences', () => {
    const partial = 'Visible text is ready. <span title="still arriving'
    for (const force of [false, true]) {
      expect(splitRealtimeSpeechBuffer(partial, { force })).toEqual({ chunks: [], remainder: partial })
    }
    const completed = `${partial}">More speech is ready.</span>`
    expect(splitRealtimeSpeechBuffer(completed)).toEqual({
      chunks: ['Visible text is ready.'],
      remainder: '<span title="still arriving">More speech is ready.</span>'
    })
    expect(splitRealtimeSpeechBuffer(partial, { final: true })).toEqual({
      chunks: [partial],
      remainder: ''
    })
  })

  it('keeps a long unfinished tag pending before the hard chunk boundary', () => {
    const buffer = `Visible text is ready. <tag${' a= '.repeat(25_000)}`
    expect(splitRealtimeSpeechBuffer(buffer, { force: true })).toEqual({ chunks: [], remainder: buffer })
  })

  it('reads a long malformed tag inside an unfinished fence without hanging (BL-1508)', () => {
    // The existing fence hold avoids invoking the separate final-speech sanitizer on this tail.
    const buffer = `Visible text is ready. \`\`\`\n<A :=${'  :='.repeat(25_000)}\``
    expect(splitRealtimeSpeechBuffer(buffer, { force: true })).toEqual({ chunks: [], remainder: buffer })
  })

  it('waits for unfinished italic narration when italics are silent', () => {
    const result = splitRealtimeSpeechBuffer('*She looks away before speaking.', {
      speakableTextOptions: { italicBehavior: 'silent' },
      force: true,
      minSpeakableChars: 12
    })

    expect(result.chunks).toEqual([])
    expect(result.remainder).toBe('*She looks away before speaking.')
  })

  it('drops all-italic final text when italics are silent', () => {
    const result = splitRealtimeSpeechBuffer('*She looks away.*', {
      final: true,
      speakableTextOptions: { italicBehavior: 'silent' }
    })

    expect(result.chunks).toEqual([])
    expect(result.remainder).toBe('*She looks away.*')
  })

  it('can flush visible narration plus spoken text once the italic marker closes', () => {
    const result = splitRealtimeSpeechBuffer('*She looks away.* Hello there.', {
      speakableTextOptions: { italicBehavior: 'silent' }
    })

    expect(result.chunks).toEqual(['*She looks away.* Hello there.'])
    expect(result.remainder).toBe('')
  })
})

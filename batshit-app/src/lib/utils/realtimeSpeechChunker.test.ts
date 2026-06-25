import { describe, expect, it } from 'vitest'
import { splitRealtimeSpeechBuffer } from './realtimeSpeechChunker'

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

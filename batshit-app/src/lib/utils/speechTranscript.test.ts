import { describe, expect, it } from 'vitest'
import { cleanSpeechTranscript } from './speechTranscript'

describe('speech transcript cleanup', () => {
  it('removes provider non-speech markers from otherwise valid transcript text', () => {
    expect(cleanSpeechTranscript('Hello there [BLANK_AUDIO]')).toBe('Hello there')
    expect(cleanSpeechTranscript('[NO_AUDIO] Hello there (silence)')).toBe('Hello there')
  })

  it('treats marker-only transcripts as empty speech', () => {
    expect(cleanSpeechTranscript('[BLANK_AUDIO]')).toBe('')
    expect(cleanSpeechTranscript('<|nospeech|>')).toBe('')
  })
})

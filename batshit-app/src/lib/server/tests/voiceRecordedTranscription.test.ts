import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRecordedTranscription, recordedTranscriptionForm, recordedTranscriptionResult } from '../services/voiceRecordedTranscription'

describe('recorded transcription contracts', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
  it('sends gpt-transcribe a WAV upload with a plural language hint', () => {
    const form = recordedTranscriptionForm('openai', new Uint8Array([1, 2]), 'gpt-transcribe', 'en')
    expect(form.get('model')).toBe('gpt-transcribe')
    expect(form.get('file')).toMatchObject({ name: 'speech.wav', type: 'audio/wav' })
    expect(form.getAll('languages[]')).toEqual(['en'])
    expect(form.get('language')).toBeNull()
    expect(form.get('response_format')).toBeNull()
  })

  it('sends Async its upload and language without inventing output features', () => {
    const form = recordedTranscriptionForm('async', new Uint8Array([1]), 'async_asr_v1.0', 'fr')
    expect(form.get('model_id')).toBe('async_asr_v1.0')
    expect(form.get('file')).toMatchObject({ name: 'speech.wav', type: 'audio/wav' })
    expect(form.get('language')).toBe('fr')
    expect(recordedTranscriptionResult('async', { text: 'bonjour' })).toEqual({ text: 'bonjour' })
    expect(() => recordedTranscriptionForm('async', new Uint8Array([1]), 'async_asr_v1.0', 'en-US')).toThrow(/ISO language code/)
    expect(() => recordedTranscriptionForm('async', new Uint8Array([1]), 'async_asr_v1.0', 'sv')).toThrow(/ISO language code/)
  })

  it('reports only a single reliably detected language and rejects malformed responses', () => {
    expect(recordedTranscriptionResult('openai', { text: 'bonjour', languages: [{ code: 'fr' }] })).toEqual({ text: 'bonjour', language: 'fr' })
    expect(recordedTranscriptionForm('openai', new Uint8Array([1]), 'gpt-transcribe', 'zh-tw').get('languages[]')).toBe('zh-tw')
    expect(recordedTranscriptionResult('openai', { text: '你好', languages: [{ code: 'zh-tw' }] }).language).toBe('zh-tw')
    expect(recordedTranscriptionResult('openai', { text: 'hello', languages: [] }).language).toBeUndefined()
    expect(recordedTranscriptionResult('openai', { text: 'hello', languages: [{ code: 'en' }, { code: 'fr' }] }).language).toBeUndefined()
    expect(() => recordedTranscriptionResult('openai', { text: 'hello', languages: [null] })).toThrow(/invalid detected languages/)
    expect(() => recordedTranscriptionResult('openai', { languages: [] })).toThrow(/invalid response/)
    expect(() => recordedTranscriptionResult('async', null)).toThrow(/invalid response/)
  })

  it('bounds successful bodies and sanitizes failure bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('private provider detail', { status: 429 }))
      .mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1))))
    const form = recordedTranscriptionForm('async', new Uint8Array([1]), 'async_asr_v1.0')
    await expect(fetchRecordedTranscription('async', 'key', form)).rejects.toMatchObject({ message: 'Async transcription failed.', status: 429 })
    await expect(fetchRecordedTranscription('async', 'key', form)).rejects.toThrow('invalid or oversized response')
  })

  it('times out while waiting for the provider without exposing its error', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const pending = fetchRecordedTranscription('async', 'key', recordedTranscriptionForm('async', new Uint8Array([1]), 'async_asr_v1.0'))
    const assertion = expect(pending).rejects.toThrow('Async transcription timed out.')
    await vi.advanceTimersByTimeAsync(120_000)
    await assertion
  })
})

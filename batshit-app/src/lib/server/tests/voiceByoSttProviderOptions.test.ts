import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribeByoSpeechForRecord } from '$lib/server/services/voiceService'
import type { VoiceEngineRecord } from '$lib/types/voice'

function buildPcmWavBytes(): Uint8Array {
  // Minimal RIFF/WAVE magic so normalizeUploadedAudioToPcmWav passes it through untouched.
  const bytes = new Uint8Array(44)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  return bytes
}

function buildRecord(overrides: Partial<VoiceEngineRecord> = {}): VoiceEngineRecord {
  return {
    id: 'test-stt-engine',
    name: 'Test STT Engine',
    enabled: true,
    supportsTts: false,
    supportsStt: true,
    supportsClone: false,
    baseUrl: 'http://127.0.0.1:9999',
    sttPath: '/transcribe',
    requestFormat: 'openai-compatible',
    sttDefaults: {
      modelId: 'test-model',
      language: 'en',
      providerOptions: {
        chunk_ms: '1120',
        word_boost: 'n8n, Batshit',
        temperature: 0.2,
        verbose: true
      }
    },
    ...overrides
  } as VoiceEngineRecord
}

describe('BYO STT provider options threading', () => {
  let capturedForm: FormData | null

  beforeEach(() => {
    capturedForm = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedForm = init?.body instanceof FormData ? init.body : null
        return new Response(JSON.stringify({ text: 'hello world', language: 'en' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('appends sttDefaults providerOptions as form fields (openai-compatible)', async () => {
    const result = await transcribeByoSpeechForRecord({
      record: buildRecord(),
      audio: buildPcmWavBytes(),
      contentType: 'audio/wav'
    })

    expect(result.text).toBe('hello world')
    expect(capturedForm).not.toBeNull()
    expect(capturedForm!.get('chunk_ms')).toBe('1120')
    expect(capturedForm!.get('word_boost')).toBe('n8n, Batshit')
    expect(capturedForm!.get('temperature')).toBe('0.2')
    expect(capturedForm!.get('verbose')).toBe('true')
  })

  it('appends sttDefaults providerOptions as form fields (batshit-byo)', async () => {
    await transcribeByoSpeechForRecord({
      record: buildRecord({ requestFormat: 'batshit-byo' }),
      audio: buildPcmWavBytes(),
      contentType: 'audio/wav'
    })

    expect(capturedForm).not.toBeNull()
    expect(capturedForm!.get('chunk_ms')).toBe('1120')
    expect(capturedForm!.get('word_boost')).toBe('n8n, Batshit')
  })

  it('never lets providerOptions override reserved form fields', async () => {
    await transcribeByoSpeechForRecord({
      record: buildRecord({
        sttDefaults: {
          modelId: 'test-model',
          providerOptions: {
            model: 'sneaky-override',
            file: 'sneaky-file',
            language: 'xx',
            chunk_ms: '560'
          }
        }
      }),
      audio: buildPcmWavBytes(),
      contentType: 'audio/wav',
      language: 'en'
    })

    expect(capturedForm).not.toBeNull()
    expect(capturedForm!.getAll('model')).toEqual(['test-model'])
    expect(capturedForm!.getAll('language')).toEqual(['en'])
    // The reserved "file" slot stays the audio blob, never a string override.
    expect(typeof capturedForm!.get('file')).not.toBe('string')
    expect(capturedForm!.get('chunk_ms')).toBe('560')
  })

  it('fails loudly on non-scalar providerOption values', async () => {
    await expect(
      transcribeByoSpeechForRecord({
        record: buildRecord({
          sttDefaults: {
            modelId: 'test-model',
            providerOptions: {
              bad_option: { nested: true } as unknown as string
            }
          }
        }),
        audio: buildPcmWavBytes(),
        contentType: 'audio/wav'
      })
    ).rejects.toThrow('BYO STT provider option "bad_option" must be a string, number, or boolean.')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), key: vi.fn(), settings: vi.fn(), engine: vi.fn(), admission: vi.fn() }))
vi.mock('$lib/server/redis', () => ({ redis: { getUserSettings: mocks.settings } }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve: mocks.key }, normalizeApiKeyServiceName: (service: string) => service.toLowerCase(), isUserFacingApiKeyService: () => true }))
vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  getVoiceEngineRecordByProviderId: mocks.engine, listVoiceEngineRecords: vi.fn(), listVoiceEngineSummaries: vi.fn(), listVoiceEngineManagerView: vi.fn(),
  VoiceEngineRecordUnreadableError: class extends Error {}, getVoiceEngineSuiteId: vi.fn(), getVoiceEngineSuiteRole: vi.fn(), isVoiceEngineHidden: vi.fn()
}))
vi.mock('$lib/server/services/builtinVoiceCatalog', () => ({ assertBuiltinVoiceCatalogModel: mocks.admission, readBuiltinVoiceCatalog: vi.fn(), refreshBuiltinVoiceCatalog: vi.fn() }))

describe('speech follow-up dispatch with admitted profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('fetch', mocks.fetch)
    mocks.settings.mockResolvedValue({ voice_settings: { schemaVersion: 2 } }); mocks.engine.mockResolvedValue(null); mocks.key.mockResolvedValue('test-key')
    mocks.admission.mockResolvedValue(null)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps Flash delivery inapplicable and sends StepAudio 3 instructions with a compatible voice', async () => {
    const { synthesizeSpeech } = await import('../services/voiceService')
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ audioContent: Buffer.from('audio').toString('base64') })))
      .mockResolvedValueOnce(new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }))
    await synthesizeSpeech({ userId: 'test', provider: 'inworld', model: 'inworld-tts-2-flash', voiceId: 'Dennis', text: 'Hello', options: { providerOptions: { deliveryMode: 'CREATIVE', audioEncoding: 'MP3' } } })
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).not.toHaveProperty('deliveryMode')
    await expect(synthesizeSpeech({ userId: 'test', provider: 'stepfun', model: 'stepaudio-3-tts', voiceId: 'lively-girl', text: 'Hello' })).rejects.toThrow('compatible voice')
    await expect(synthesizeSpeech({ userId: 'test', provider: 'stepfun', model: 'stepaudio-3-tts', voiceId: 'zixinnansheng', text: 'Hello', options: { common: { instructions: 'x'.repeat(501) } } })).rejects.toThrow('500 characters')
    await synthesizeSpeech({ userId: 'test', provider: 'stepfun', model: 'stepaudio-3-tts', voiceId: 'zixinnansheng', text: 'Hello', options: { common: { instructions: 'x'.repeat(500) } } })
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toMatchObject({ model: 'stepaudio-3-tts', voice: 'zixinnansheng', instruction: 'x'.repeat(500) })
  })

  it('enforces the StepAudio 2.5 instruction limit on resolved saved settings before key or request', async () => {
    const { synthesizeSpeech } = await import('../services/voiceService')
    const saved = { voice_settings: { schemaVersion: 2, ttsEngineSettings: { stepfun: { common: { instructions: 'x'.repeat(201) } } } } }
    mocks.settings.mockResolvedValue(saved)
    const input = { userId: 'test', provider: 'stepfun' as const, model: 'stepaudio-2.5-tts', voiceId: 'lively-girl', text: 'Hello' }
    await expect(synthesizeSpeech(input)).rejects.toThrow('accepts at most 200 instruction characters')
    expect(mocks.key).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(saved.voice_settings.ttsEngineSettings.stepfun.common.instructions).toHaveLength(201)
    mocks.fetch.mockResolvedValueOnce(new Response('audio'))
    await synthesizeSpeech({ ...input, options: { common: { instructions: 'y'.repeat(200) } } })
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ model: 'stepaudio-2.5-tts', instruction: 'y'.repeat(200) })
    mocks.fetch.mockResolvedValueOnce(new Response('audio'))
    await synthesizeSpeech({ ...input, options: { common: { instructions: '😀'.repeat(200) } } })
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).instruction).toBe('😀'.repeat(200))
    await expect(synthesizeSpeech({ ...input, options: { common: { instructions: '😀'.repeat(201) } } })).rejects.toThrow('200 instruction characters')
    mocks.fetch.mockResolvedValueOnce(new Response('audio'))
    await synthesizeSpeech({ ...input, model: 'step-tts-2' })
    expect(JSON.parse(mocks.fetch.mock.calls[2][1].body)).not.toHaveProperty('instruction')
  })

  it('uses only supported Eleven v4 voice settings', async () => {
    const { synthesizeSpeech } = await import('../services/voiceService')
    mocks.fetch.mockImplementation(async () => new Response('audio'))
    await synthesizeSpeech({ userId: 'test', provider: 'elevenlabs', model: 'eleven_v4', voiceId: 'voice', text: 'Hello', options: { common: { speed: 1.2 }, providerOptions: { stability: 0.5, similarityBoost: 0.7, style: 0.2, speakerBoost: true } } })
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ text: 'Hello', model_id: 'eleven_v4', voice_settings: { stability: 0.5, similarity_boost: 0.7 } })
  })

  it('uses the admitted Cartesia version and complete format while preserving legacy serializer', async () => {
    const { synthesizeSpeech } = await import('../services/voiceService')
    mocks.admission.mockResolvedValueOnce({ compatibilityProfileId: 'cartesia.bytes-20260814.v1' }).mockResolvedValueOnce({ compatibilityProfileId: 'cartesia.bytes-20260301.v1' })
    mocks.fetch.mockImplementation(async () => new Response('audio'))
    await synthesizeSpeech({ userId: 'test', provider: 'cartesia', model: 'sonic-3.6', voiceId: 'voice', text: 'Hello', options: { common: { speed: 1.2, volume: 1 } } })
    expect(mocks.fetch.mock.calls[0][1].headers['Cartesia-Version']).toBe('2026-08-14')
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ voice: 'voice', output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 }, generation_config: { speed: 1.2, volume: 1 } })
    await synthesizeSpeech({ userId: 'test', provider: 'cartesia', model: 'sonic-3.5', voiceId: 'voice', text: 'Hello' })
    expect(mocks.fetch.mock.calls[1][1].headers['Cartesia-Version']).toBe('2026-03-01')
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toMatchObject({ voice: { mode: 'id', id: 'voice' }, output_format: { container: 'mp3' } })
  })

  it('sends Google and Qwen admitted requests through their own serializers', async () => {
    const { synthesizeSpeech } = await import('../services/voiceService')
    const wav = Buffer.from('RIFF0000WAVEtest')
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64') }] }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { finish_reason: 'stop', audio: { url: 'http://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/pre/result.wav?OSSAccessKeyId=test&Expires=123&Signature=abc%2Bdef' } } })))
      .mockResolvedValueOnce(new Response(wav, { headers: { 'content-type': 'audio/wav' } }))
    await synthesizeSpeech({ userId: 'test', provider: 'google', model: 'gemini-3.8-flash-lite-tts', voiceId: 'Kore', text: 'Hello' })
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ model: 'gemini-3.8-flash-lite-tts', response_format: { type: 'audio', mime_type: 'audio/wav' } })
    const endpoint = 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    await synthesizeSpeech({ userId: 'test', provider: 'alibaba', model: 'qwen-audio-3.1-tts-flash', voiceId: 'longanhuan_v3.1', text: 'Hello', options: { common: { endpoint, language: 'ja', instructions: 'Speak softly.' } } })
    expect(mocks.fetch.mock.calls[1][0]).toBe(endpoint)
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toMatchObject({ model: 'qwen-audio-3.1-tts-flash', input: { text: 'Hello', voice: 'longanhuan_v3.1', format: 'wav', sample_rate: 24000, language_hints: ['ja'], instruction: 'Speak softly.' } })
    expect(mocks.fetch.mock.calls[2][0]).toMatch(/^https:\/\/dashscope-result-sg\.oss-ap-southeast-1\.aliyuncs\.com\//)
  })
})

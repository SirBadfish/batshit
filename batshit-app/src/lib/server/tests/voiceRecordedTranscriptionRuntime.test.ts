import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), key: vi.fn(), settings: vi.fn(), engine: vi.fn() }))
vi.mock('$lib/server/redis', () => ({ redis: { getUserSettings: mocks.settings } }))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: mocks.key },
  normalizeApiKeyServiceName: (service: string) => service.toLowerCase(),
  isUserFacingApiKeyService: () => true
}))
vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  getVoiceEngineRecordByProviderId: mocks.engine,
  listVoiceEngineRecords: vi.fn(), listVoiceEngineSummaries: vi.fn(), listVoiceEngineManagerView: vi.fn(),
  VoiceEngineRecordUnreadableError: class extends Error {},
  getVoiceEngineSuiteId: vi.fn(), getVoiceEngineSuiteRole: vi.fn(), isVoiceEngineHidden: vi.fn()
}))
vi.mock('$lib/server/services/builtinVoiceCatalog', () => ({
  assertBuiltinVoiceCatalogModel: vi.fn(async () => null), readBuiltinVoiceCatalog: vi.fn(), refreshBuiltinVoiceCatalog: vi.fn()
}))

describe('recorded STT provider dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mocks.fetch)
    mocks.settings.mockResolvedValue({ voice_settings: { schemaVersion: 2 } })
    mocks.engine.mockResolvedValue(null)
    mocks.key.mockResolvedValue('test-key')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the selected OpenAI model with plural hint and consumes detected output', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ text: 'bonjour', languages: [{ code: 'fr' }] })))
    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({ audio: new Uint8Array([1]), provider: 'openai', model: 'gpt-transcribe', language: 'zh-tw', userId: 'test', contentType: 'audio/wav' })
    expect(result).toEqual({ text: 'bonjour', language: 'fr' })
    const [url, options] = mocks.fetch.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer test-key' } })
    expect(options.body.get('model')).toBe('gpt-transcribe')
    expect(options.body.get('languages[]')).toBe('zh-tw')
    expect(options.body.get('language')).toBeNull()
  })

  it('uses Async upload credentials, leaves language unknown and reports provider failure', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ text: 'hello' })))
      .mockResolvedValueOnce(new Response('limit reached', { status: 429 }))
    const { transcribeAudio } = await import('../services/voiceService')
    const input = { audio: new Uint8Array([1]), provider: 'async' as const, model: 'async_asr_v1.0', language: 'en', userId: 'test', contentType: 'audio/wav' }
    expect(await transcribeAudio(input)).toEqual({ text: 'hello' })
    const [url, options] = mocks.fetch.mock.calls[0]
    expect(url).toBe('https://api.async.com/speech_to_text')
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-api-key': 'test-key', version: 'v1' } })
    expect(options.body.get('model_id')).toBe('async_asr_v1.0')
    expect(options.body.get('language')).toBe('en')
    await expect(transcribeAudio(input)).rejects.toThrow('Async transcription failed.')
  })
})

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries } from '$lib/utils/builtinVoiceCatalogProjection'
import { voiceCatalogRevision } from '$lib/utils/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot, BuiltinVoiceProviderId, BuiltinVoiceLane } from '$lib/types/builtinVoiceCatalog'

const fixture = vi.hoisted(() => ({ raw: null as string | null, key: vi.fn(), http: vi.fn(), speech: vi.fn(), transcription: vi.fn() }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/redis', () => ({ redis: {
  getUserSettings: async () => ({ voice_settings: { schemaVersion: 2, tts: { providerId: 'browser' }, stt: { providerId: 'browser' } } }),
  getVoiceProfile: async () => null,
  execute: async (operation: any) => operation({ type: async () => fixture.raw === null ? 'none' : 'string', get: async () => fixture.raw })
} }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve: (...args: unknown[]) => fixture.key(...args) }, normalizeApiKeyServiceName: (id: string) => id, isUserFacingApiKeyService: () => true }))
vi.mock('$lib/server/services/voiceEngineRegistry', () => ({ getVoiceEngineRecordByProviderId: async () => null, listVoiceEngineRecords: async () => [],
  listVoiceEngineManagerView: async () => ({ engines: [], unreadableEngines: [] }), getVoiceEngineSuiteId: (record: any) => record.id,
  getVoiceEngineSuiteRole: () => 'primary', isVoiceEngineHidden: () => false, VoiceEngineRecordUnreadableError: class extends Error {} }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => ({ speech: (modelId: string) => ({ modelId }), transcription: (modelId: string) => ({ modelId }) }) }))
vi.mock('ai', async original => ({ ...await original<typeof import('ai')>(), generateSpeech: (...args: unknown[]) => fixture.speech(...args), transcribe: (...args: unknown[]) => fixture.transcription(...args) }))

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); fixture.raw = null
  fixture.key.mockResolvedValue('synthetic-fixture-key')
  fixture.http.mockRejectedValue(Error('Unexpected provider or registry request'))
  fixture.speech.mockResolvedValue({ audio: { uint8Array: new Uint8Array([1, 2, 3]) } })
  vi.stubGlobal('fetch', fixture.http)
})
afterEach(() => { vi.unstubAllGlobals() })

async function localCatalog(update: (snapshot: BuiltinVoiceCatalogSnapshot, at: string) => void) {
  const at = new Date().toISOString()
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, id === 'browser'
    ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries: [] }
    : { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries: bundledVoiceCatalogEntries(id) }])) as BuiltinVoiceCatalogSnapshot['providers']
  const snapshot: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence: 2, revision: '0'.repeat(64), generatedAt: at, providers }
  update(snapshot, at)
  snapshot.revision = await voiceCatalogRevision(snapshot)
  fixture.raw = JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot })
}

async function restricted(providerId: BuiltinVoiceProviderId, lane: BuiltinVoiceLane, modelId: string, kind: 'blocked' | 'unknown-profile') {
  await localCatalog(snapshot => {
    const entry = snapshot.providers[providerId].entries.find(entry => entry.lane === lane && entry.modelId === modelId)!
    Object.assign(entry, kind === 'blocked' ? { admission: 'blocked', blockedReason: 'contract-changed' } : { admission: 'candidate', compatibilityProfileId: 'future.unknown.v2', blockedReason: 'qualification-required' })
  })
}

const mistral3 = 'voxtral-mini-transcribe-3-0'
async function mistralRecordedCatalog(admitted = true) {
  await localCatalog((snapshot, at) => {
    snapshot.providers.mistral.entries.push({ modelId: mistral3, label: mistral3, lane: 'stt-recorded',
      compatibilityProfileId: 'mistral.recorded-segments.v2', qualificationRuleId: 'mistral.transcribe-segments.v2',
      admission: admitted ? 'qualified' : 'candidate', qualifiedAt: admitted ? at : null, provenance: 'qualified-source',
      evidenceUrls: ['https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files.md'], release: 'unknown' })
  })
}

describe('actual speech dispatch consumes only admitted local compatibility', () => {
  it('returns a known412 from the actual batch route before provider or audio issue', async () => {
    await restricted('openai', 'tts-batch', 'gpt-4o-mini-tts', 'blocked')
    const { POST } = await import('../../../routes/api/voice/synthesize/+server')
    const response = await POST({ locals: { user: { id: 'u' } }, request: new Request('http://local/api/voice/synthesize', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'probe', provider: 'openai', model: 'gpt-4o-mini-tts', voiceId: 'alloy' }) }) } as never)
    expect(response.status).toBe(412)
    expect(await response.json()).toMatchObject({ fallback: false, setupHint: expect.stringContaining('Refresh the model list') })
    expect(fixture.key).not.toHaveBeenCalled(); expect(fixture.speech).not.toHaveBeenCalled(); expect(fixture.http).not.toHaveBeenCalled()
  })

  it('refuses blocked Direct TTS before the Fish stream or registry is contacted', async () => {
    await restricted('fish', 'tts-direct-stream', 's2.1-pro', 'blocked')
    const { streamSpeechRealtime } = await import('../services/voiceService')
    await expect(streamSpeechRealtime({ text: 'probe', userId: 'u', provider: 'fish', model: 's2.1-pro', voiceId: 'public-fixture-voice' })).rejects.toMatchObject({ code: 'voice_model_compatibility_unavailable', status: 412 })
    expect(fixture.key).not.toHaveBeenCalled(); expect(fixture.http).not.toHaveBeenCalled()
  })

  it('refuses an unknown recorded-STT profile before audio conversion or provider request', async () => {
    await restricted('fish', 'stt-recorded', 'transcribe-1', 'unknown-profile')
    const { transcribeAudio } = await import('../services/voiceService')
    await expect(transcribeAudio({ audio: new Uint8Array([1, 2]), userId: 'u', provider: 'fish', model: 'transcribe-1' })).rejects.toMatchObject({ code: 'voice_model_compatibility_unavailable', status: 412 })
    expect(fixture.key).not.toHaveBeenCalled(); expect(fixture.transcription).not.toHaveBeenCalled(); expect(fixture.http).not.toHaveBeenCalled()
  })

  it('returns the existing realtime setup refusal before Deepgram credentials/token/provider issue', async () => {
    await restricted('deepgram', 'stt-direct-realtime', 'flux-general-en', 'blocked')
    const { createRealtimeSttSessionContract } = await import('../services/voiceRealtimeSttRuntime')
    await expect(createRealtimeSttSessionContract('u', { provider: 'deepgram', model: 'flux-general-en' })).rejects.toMatchObject({ status: 412, setupHint: expect.stringContaining('Refresh the model list') })
    expect(fixture.key).not.toHaveBeenCalled(); expect(fixture.http).not.toHaveBeenCalled()
  })

  it('preserves an explicit custom-unlisted model under its existing adapter without a registry read', async () => {
    const { synthesizeSpeech } = await import('../services/voiceService')
    const result = await synthesizeSpeech({ text: 'probe', userId: 'u', provider: 'openai', model: 'custom-openai-tts', voiceId: 'alloy' })
    expect(result.model).toBe('custom-openai-tts')
    expect(fixture.speech).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: { modelId: 'custom-openai-tts' } }))
    expect(fixture.http).not.toHaveBeenCalled()
  })

  it('dispatches an admitted Mistral3 profile with the exact segment field and preserves overlapping provider segments', async () => {
    await mistralRecordedCatalog()
    const segments = [
      { type: 'transcription_segment', text: ' first', start: 1, end: 3, speaker_id: 'speaker_1' },
      { type: 'transcription_segment', text: ' overlapping', start: 0.5, end: 2, speaker_id: 'speaker_2' },
      { type: 'transcription_segment', text: ' continuation', start: 2.5, end: 4, speaker_id: 'speaker_1' }
    ]
    fixture.http.mockResolvedValueOnce(Response.json({ text: 'first overlapping continuation', language: null, segments }))
    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({ audio: new Uint8Array([1, 2, 3]), userId: 'u', provider: 'mistral', model: mistral3, contentType: 'audio/wav' })
    expect(fixture.http).toHaveBeenCalledTimes(1)
    const [url, request] = fixture.http.mock.calls[0]
    expect(url).toBe('https://api.mistral.ai/v1/audio/transcriptions')
    expect(request.headers).toEqual({ Authorization: 'Bearer synthetic-fixture-key' })
    expect(request.body.get('model')).toBe(mistral3)
    expect(request.body.get('file')).toBeInstanceOf(Blob)
    expect(request.body.get('timestamp_granularities')).toBe('segment')
    expect(request.body.get('timestamp_granularities[]')).toBeNull()
    expect(request.body.get('language')).toBeNull()
    expect(result.text).toBe('first overlapping continuation')
    expect(result.language).toBeUndefined()
    expect(result.segments).toEqual(segments)
    expect(fixture.transcription).not.toHaveBeenCalled()
  })

  it.each([{ language: null }, {}])('does not invent returned Mistral3 language from the requested hint for %j', async returnedLanguage => {
    await mistralRecordedCatalog()
    fixture.http.mockResolvedValueOnce(Response.json({ text: 'bonjour', ...returnedLanguage }))
    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({ audio: new Uint8Array([1, 2, 3]), userId: 'u', provider: 'mistral', model: mistral3, language: 'fr', contentType: 'audio/wav' })
    const request = fixture.http.mock.calls[0][1]
    expect(request.body.get('language')).toBe('fr')
    expect(request.body.get('timestamp_granularities')).toBeNull()
    expect(request.body.get('timestamp_granularities[]')).toBeNull()
    expect(result).toEqual({ text: 'bonjour', language: undefined, segments: undefined })
  })

  it.each(['caller-options', 'http-body'])('does not grant a candidate Mistral3 profile through %s flags', async source => {
    await mistralRecordedCatalog(false)
    const profile = 'mistral.recorded-segments.v2'
    if (source === 'caller-options') {
      const { transcribeAudio } = await import('../services/voiceService')
      await expect(transcribeAudio({ audio: new Uint8Array([1, 2, 3]), userId: 'u', provider: 'mistral', model: mistral3,
        compatibilityProfileId: profile, options: { compatibilityProfileId: profile, providerOptions: { compatibilityProfileId: profile } } } as never))
        .rejects.toMatchObject({ code: 'voice_model_compatibility_unavailable', status: 412 })
    } else {
      const { POST } = await import('../../../routes/api/voice/transcribe/+server')
      const form = new FormData()
      form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'speech.wav')
      form.append('provider', 'mistral'); form.append('model', mistral3)
      form.append('compatibilityProfileId', profile)
      form.append('options', JSON.stringify({ compatibilityProfileId: profile, providerOptions: { compatibilityProfileId: profile } }))
      const response = await POST({ locals: { user: { id: 'u' } }, request: new Request('http://local/api/voice/transcribe', { method: 'POST', body: form }) } as never)
      expect(response.status).toBe(412)
      expect(await response.json()).toMatchObject({ fallback: false, setupHint: expect.stringContaining('Refresh the model list') })
    }
    expect(fixture.key).not.toHaveBeenCalled(); expect(fixture.http).not.toHaveBeenCalled()
  })

  it.each([
    { model: undefined, language: undefined },
    { model: 'voxtral-mini-2602', language: 'fr' },
    { model: 'custom-mistral-model', language: undefined }
  ])('preserves Mistral default, v1 and custom behavior for %j despite caller profile hints', async ({ model, language }) => {
    fixture.http.mockResolvedValueOnce(Response.json({ text: 'legacy transcript', language: null }))
    const { transcribeAudio } = await import('../services/voiceService')
    const result = await transcribeAudio({ audio: new Uint8Array([1, 2, 3]), userId: 'u', provider: 'mistral', model, language, contentType: 'audio/wav',
      compatibilityProfileId: 'mistral.recorded-segments.v2', options: { compatibilityProfileId: 'mistral.recorded-segments.v2' } } as never)
    const request = fixture.http.mock.calls[0][1]
    expect(request.body.get('model')).toBe(model ?? 'voxtral-mini-latest')
    expect(request.body.get('timestamp_granularities')).toBeNull()
    expect(request.body.get('timestamp_granularities[]')).toBe(language ? null : 'segment')
    expect(result.language).toBe(language)
  })
})

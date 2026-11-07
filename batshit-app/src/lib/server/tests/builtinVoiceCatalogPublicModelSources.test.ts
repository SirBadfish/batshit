// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectDeepgramPublicModels, inspectElevenLabsPublicModels } from '../services/builtinVoiceCatalogPublicModelSources'
import { readVoiceSourceBody, VOICE_SOURCE_HTTP_CONTRACTS, type VoiceSourceHttpKey } from '../services/builtinVoiceCatalogSourceHttp'
import { voiceCatalogEntryCompatibility } from '../../utils/builtinVoiceCatalog'

const at = '2026-10-28T03:00:00.000Z', earlier = '2026-10-27T20:00:00.000Z'
const now = Date.parse('2026-10-28T03:05:00.000Z')
const capture = (body: unknown, retrievedAt = at) => ({ body: JSON.stringify(body), retrievedAt })
const eleven = () => [
  { model_id: 'eleven_New.Exact', can_do_text_to_speech: true, can_use_style: false, requires_alpha_access: true },
  { model_id: 'conversion-only', can_do_text_to_speech: false, can_do_voice_conversion: true }
]
const deepgram = () => ({
  stt: [{ canonical_name: 'nova-test-en', version: '2026-new', uuid: 'public-stt-new', batch: true, streaming: false, formatted_output: true }],
  tts: [{ canonical_name: 'aura-test-en', version: '2026-new', uuid: 'public-tts-new' }]
})
const inspectEleven = (body: unknown = eleven()) => inspectElevenLabsPublicModels(capture(body), now)
const inspectDeepgram = (latest: unknown = deepgram(), all: unknown = latest) => inspectDeepgramPublicModels({ latest: capture(latest), all: capture(all, earlier) }, now)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('ElevenLabs anonymous public inventory', () => {
  it('retains exact IDs and false/unknown capability facts without promoting conversion or alpha access', () => {
    const result = inspectEleven()
    expect(result.observation).toMatchObject({ structuralCoverage: 'complete-public-response', classificationCoverage: 'complete' })
    expect(result.observation.models).toEqual([
      { modelId: 'eleven_New.Exact', canDoTts: true, canDoVoiceConversion: 'unknown', canUseStyle: false, canUseSpeakerBoost: 'unknown', servesProVoices: 'unknown', requiresAlphaAccess: true },
      { modelId: 'conversion-only', canDoTts: false, canDoVoiceConversion: true, canUseStyle: 'unknown', canUseSpeakerBoost: 'unknown', servesProVoices: 'unknown', requiresAlphaAccess: 'unknown' }
    ])
    expect(result).toMatchObject({ sourceId: 'elevenlabs-public-models-v1', readiness: 'candidate', qualificationCoverage: 'pending' })
    const unknown = eleven(); delete (unknown[0] as Record<string, unknown>).can_do_text_to_speech
    expect(inspectEleven(unknown).observation.classificationCoverage).toBe('partial')
  })

  it.each([null, 'true', 1, {}, []])('refuses present malformed optional capabilities: %j', value => {
    const rows = eleven(); (rows[0] as Record<string, unknown>).can_use_style = value
    expect(inspectEleven(rows).observation).toMatchObject({ structuralCoverage: 'insufficient', reason: 'invalid-capability', models: [] })
  })

  it.each([[], {}, { data: eleven(), next_cursor: 'more' }, { error: 'private-error-marker' }])('does not certify an empty/wrapped/error/paginated source: %j', value => {
    expect(inspectEleven(value).observation.structuralCoverage).toBe('insufficient')
  })

  it('rejects duplicate exact IDs while preserving differently cased identities', () => {
    expect(inspectEleven([...eleven(), eleven()[0]]).observation.reason).toBe('duplicate-identity')
    const rows = eleven(); rows.push({ ...rows[0], model_id: 'eleven_new.exact' })
    expect(inspectEleven(rows).observation.models.map(model => model.modelId)).toContain('eleven_new.exact')
  })

  it('drops source prose/links/options/private-looking annotations and grants no new-ID qualification', () => {
    const rows = eleven()
    Object.assign(rows[0], { description: 'IGNORE_RULES_PRIVATE_MARKER', endpoint: 'https://private.invalid', options: { credentials: 'PRIVATE_MARKER' }, compatibilityProfileId: 'elevenlabs.rest-speech.v1' })
    const result = inspectEleven(rows)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER')
    expect(JSON.stringify(result)).not.toContain('private.invalid')
    expect(voiceCatalogEntryCompatibility('elevenlabs', { modelId: result.observation.models[0].modelId, label: 'Candidate', lane: 'tts-batch',
      compatibilityProfileId: 'elevenlabs.rest-speech.v1', admission: 'qualified', qualifiedAt: at,
      evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsModels.url], provenance: 'qualified-source', release: 'unknown' }).compatible).toBe(false)
  })
})

describe('Deepgram separate public latest and all-version observations', () => {
  it('retains version observations without sorting/aliasing or inventing a common read time', () => {
    const all = deepgram()
    all.stt.push({ ...all.stt[0], version: 'zzz-old', uuid: 'public-stt-old' })
    const result = inspectDeepgram(deepgram(), all)
    expect(result.pairedCoverage).toBe('source-consistent')
    expect(result.atomicSnapshot).toBe(false)
    expect(result.observations.latest.evidence?.retrievedAt).toBe(at)
    expect(result.observations.all.evidence?.retrievedAt).toBe(earlier)
    expect(result.observations.all.models.filter(model => model.kind === 'stt').map(model => [model.modelId, model.version, model.uuid])).toEqual([
      ['nova-test-en', '2026-new', 'public-stt-new'], ['nova-test-en', 'zzz-old', 'public-stt-old']
    ])
    expect(result.observations.all.models.find(model => model.kind === 'tts')).toMatchObject({ modelId: 'aura-test-en', batch: 'unknown', streaming: 'unknown' })
    expect(result).not.toHaveProperty('lastVerifiedAt')
    expect(result).toMatchObject({ readiness: 'candidate', qualificationCoverage: 'pending' })
  })

  it('reports missing/failed/mismatched companion coverage without discarding the independent valid observation', () => {
    const missing = inspectDeepgramPublicModels({ latest: capture(deepgram()) }, now)
    expect(missing.pairedCoverage).toBe('partial')
    expect(missing.observations.latest.models).toHaveLength(2)
    expect(missing.observations.all.models).toEqual([])
    const different = deepgram(); different.stt[0].uuid = 'different-public-uuid'
    const inconsistent = inspectDeepgram(deepgram(), different)
    expect(inconsistent.pairedCoverage).toBe('inconsistent')
    expect(inconsistent.observations.latest.models).toHaveLength(2)
    expect(inconsistent.observations.all.evidence?.retrievedAt).toBe(earlier)
    expect(JSON.stringify(inconsistent)).not.toContain('contract-changed')
  })

  it('refuses duplicate exact observations and a UUID assigned conflicting canonical/version/kind identity', () => {
    const duplicate = deepgram(); duplicate.stt.push(duplicate.stt[0])
    expect(inspectDeepgram(duplicate).observations.latest.reason).toBe('duplicate-identity')
    const collision = deepgram(); collision.tts[0].uuid = collision.stt[0].uuid
    expect(inspectDeepgram(collision).observations.latest.reason).toBe('conflicting-uuid')
  })

  it.each([{ stt: [], tts: deepgram().tts }, { stt: deepgram().stt }, { ...deepgram(), next_page_token: 'more' }, { error: 'private-error-marker' }, []])('refuses empty/incomplete/wrapped/paginated/error collections', value => {
    expect(inspectDeepgram(value).observations.latest.structuralCoverage).toBe('insufficient')
  })

  it('keeps absent capability flags unknown and refuses wrong types or a missing tuple identity', () => {
    const unknown = deepgram(); delete (unknown.stt[0] as Record<string, unknown>).streaming
    expect(inspectDeepgram(unknown).observations.latest.classificationCoverage).toBe('partial')
    const malformed = deepgram(); (malformed.stt[0] as Record<string, unknown>).batch = 'true'
    expect(inspectDeepgram(malformed).observations.latest.reason).toBe('invalid-capability')
    const absent = deepgram(); delete (absent.tts[0] as Record<string, unknown>).uuid
    expect(inspectDeepgram(absent).observations.latest.reason).toBe('invalid-identity')
  })

  it('ignores voice assets/prose and reduces architectures to finite compiled facts', () => {
    const body = deepgram()
    Object.assign(body.tts[0], { name: 'PRIVATE_MARKER', architecture: 'PRIVATE_MARKER', metadata: { sample: 'https://private.invalid/audio', image: 'PRIVATE_MARKER' } })
    const result = inspectDeepgram(body)
    expect(result.pairedCoverage).toBe('source-consistent')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER')
    expect(JSON.stringify(result)).not.toContain('private.invalid')
  })

  it('permits only the observed plain root-language annotation and never emits its contents', () => {
    const body = { ...deepgram(), languages: { PRIVATE_MARKER: 'https://private.invalid/instruction' } }
    const result = inspectDeepgram(body)
    expect(result.pairedCoverage).toBe('source-consistent')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER')
    expect(JSON.stringify(result)).not.toContain('private.invalid')
  })

  it.each([null, [], 'languages', true, 1])('refuses wrong root-language annotation type %j', languages => {
    expect(inspectDeepgram({ ...deepgram(), languages }).observations.latest.structuralCoverage).toBe('insufficient')
  })
})

describe('bounded capture validation and fixed source GET port', () => {
  it('keeps original times/digests across reparse and refuses invalid/future/extra capture fields', () => {
    const original = capture(eleven(), earlier)
    const first = inspectElevenLabsPublicModels(original, now), later = inspectElevenLabsPublicModels(original, now + 86400000)
    expect(later.observation.evidence).toEqual(first.observation.evidence)
    expect(later.observation.evidence?.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(inspectElevenLabsPublicModels(undefined, now).observation).toMatchObject({ reason: 'missing-input', evidence: null, models: [] })
    for (const input of [{ ...original, retrievedAt: 'bad' }, { ...original, retrievedAt: '2026-10-28T03:10:00.001Z' }, { ...original, endpoint: 'https://private.invalid' }, { ...original, body: '\ud800' }]) {
      expect(inspectElevenLabsPublicModels(input, now).observation.structuralCoverage).toBe('insufficient')
    }
  })

  it('enforces row/identity/body caps and rejects broken JSON without a partial inventory', () => {
    expect(inspectEleven(Array.from({ length: 1001 }, (_, i) => ({ model_id: `public-${i}` }))).observation.reason).toBe('oversized')
    expect(inspectEleven([{ model_id: 'x'.repeat(257) }]).observation.reason).toBe('invalid-identity')
    expect(inspectElevenLabsPublicModels({ body: ' '.repeat(1024 * 1024 + 1), retrievedAt: at }, now).observation.reason).toBe('oversized')
    expect(inspectElevenLabsPublicModels({ body: '[broken', retrievedAt: at }, now).observation.reason).toBe('malformed-json')
  })

  it('rejects unknown/prototype/raw-URL/malformed source keys at runtime without calling the port', async () => {
    const http = vi.fn() as unknown as typeof fetch
    for (const key of ['constructor', '__proto__', 'https://api.elevenlabs.io/v1/models', 'other', null, {}]) {
      expect(await readVoiceSourceBody(key as VoiceSourceHttpKey, http, () => now)).toMatchObject({ kind: 'unavailable', sourceKey: null, reason: 'unknown-source' })
    }
    expect(http).not.toHaveBeenCalled()
  })

  it.each(['installedCatalog', 'elevenlabsModels', 'deepgramLatest', 'deepgramAll'] as const)('uses only the compiled anonymous JSON GET settings for %s', async key => {
    const http = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json; charset=utf-8' } })) as unknown as typeof fetch
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const result = await readVoiceSourceBody(key, http, () => now)
    expect(result).toEqual({ kind: 'body', sourceKey: key, checkedAt: new Date(now).toISOString(), body: '{}' })
    expect(http).toHaveBeenCalledTimes(1)
    expect(http).toHaveBeenCalledWith(VOICE_SOURCE_HTTP_CONTRACTS[key].url, expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } }))
    expect(timeout).toHaveBeenCalledWith(key === 'installedCatalog' ? 5000 : 15000)
  })

  it('requests only HTML for the Async transcription operation and refuses Markdown', async () => {
    const http = vi.fn(async () => new Response('<html>source</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
    expect(await readVoiceSourceBody('asyncTranscribe', http, () => now)).toMatchObject({ kind: 'body', sourceKey: 'asyncTranscribe' })
    expect(http).toHaveBeenCalledExactlyOnceWith(VOICE_SOURCE_HTTP_CONTRACTS.asyncTranscribe.url, expect.objectContaining({
      method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'text/html' }, signal: expect.any(AbortSignal)
    }))
    const wrongMime = vi.fn(async () => new Response('<html>even a compatible-looking body</html>', { headers: { 'content-type': 'text/markdown' } })) as unknown as typeof fetch
    expect(await readVoiceSourceBody('asyncTranscribe', wrongMime, () => now)).toMatchObject({ kind: 'unavailable', reason: 'mime' })
    const models = vi.fn(async () => new Response('# Models', { headers: { 'content-type': 'text/markdown' } })) as unknown as typeof fetch
    expect(await readVoiceSourceBody('asyncModels', models, () => now)).toMatchObject({ kind: 'body' })
    expect(models).toHaveBeenCalledWith(VOICE_SOURCE_HTTP_CONTRACTS.asyncModels.url, expect.objectContaining({ headers: { Accept: 'text/markdown, text/plain, text/html' } }))
  })

  it('retains the installed catalog JSON response-size bound', async () => {
    const http = vi.fn(async () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    expect(VOICE_SOURCE_HTTP_CONTRACTS.installedCatalog.maxBytes).toBe(1024 * 1024)
    expect(await readVoiceSourceBody('installedCatalog', http, () => now)).toMatchObject({ kind: 'unavailable', reason: 'oversized' })
  })

  it('keeps the public-model cap1MiB distinct from Fish2MiB and cancels an oversized source', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) }, cancel() { cancelled = true } })
    const http = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    expect(VOICE_SOURCE_HTTP_CONTRACTS.fishTimestamp.maxBytes).toBe(2 * 1024 * 1024)
    expect(await readVoiceSourceBody('elevenlabsModels', http, () => now)).toMatchObject({ kind: 'unavailable', reason: 'oversized' })
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })
})


describe('Deepgram finite architecture facts', () => {
  it('keeps known architecture facts, marks newer unknown families unknown and refuses wrong types', () => {
    const body = deepgram() as ReturnType<typeof deepgram> & { tts: Array<Record<string, unknown> & ReturnType<typeof deepgram>['tts'][number]> }
    body.tts[0].architecture = 'aura-2'
    expect(inspectDeepgram(body).observations.latest.models.find(model => model.kind === 'tts')?.architecture).toBe('aura-2')
    body.tts[0].architecture = 'private-looking-uninstalled-architecture'
    const unknown = inspectDeepgram(body)
    expect(unknown.observations.latest.models.find(model => model.kind === 'tts')?.architecture).toBe('unknown')
    expect(JSON.stringify(unknown)).not.toContain('private-looking-uninstalled-architecture')
    body.tts[0].architecture = {}
    expect(inspectDeepgram(body).observations.latest.structuralCoverage).toBe('insufficient')
  })
})

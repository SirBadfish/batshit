// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot, VoiceCatalogRecoveryAnchor } from '$lib/types/builtinVoiceCatalog'
import { runVoiceCatalogCasAttempt, voiceCatalogCompatibilityFacts, voiceCatalogEntryCompatibility, voiceCatalogRestrictionFacts, voiceCatalogRevision } from '$lib/utils/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries, projectBuiltinVoiceCatalog, selectedVoiceCatalogCompatibility } from '$lib/utils/builtinVoiceCatalogProjection'
import { createBuiltinVoiceCatalogCollector, publishFreshBuiltinVoiceCatalog } from '../services/builtinVoiceCatalogCollector'
import { createBuiltinVoiceCatalogReader } from '../services/builtinVoiceCatalogCache'
import { VOICE_SOURCE_HTTP_CONTRACTS, type VoiceSourceHttpKey } from '../services/builtinVoiceCatalogSourceHttp'
import type { VoiceCatalogStringStore } from '../services/builtinVoiceCatalogStore'

const at = '2026-10-28T18:00:00.000Z', oldAt = '2026-10-27T18:00:00.000Z', now = Date.parse(at)
const sourceKeys = Object.keys(VOICE_SOURCE_HTTP_CONTRACTS).filter(key => key !== 'installedCatalog') as VoiceSourceHttpKey[]
const keyByUrl = new Map(sourceKeys.map(key => [VOICE_SOURCE_HTTP_CONTRACTS[key].url, key]))
const jsonKeys = new Set<VoiceSourceHttpKey>(['fishTimestamp','elevenlabsModels','deepgramLatest','deepgramAll'])
function httpFor(sources: Partial<Record<VoiceSourceHttpKey, string>> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const key = keyByUrl.get(String(input)), body = key === undefined ? undefined : sources[key]
    if (body === undefined) return new Response('Unavailable', { status: 404 })
    return new Response(body, { headers: { 'Content-Type': jsonKeys.has(key!) ? 'application/json' : key === 'mistralApi' ? 'application/yaml' : body.trimStart().startsWith('<') ? 'text/html' : 'text/markdown' } })
  }) as unknown as typeof fetch
}
function deepgram() {
  return {
    stt: [{ canonical_name: 'nova-3', version: 'current-stt', uuid: 'stt-current', architecture: 'nova-3', batch: true, streaming: true, formatted_output: true }],
    tts: [{ canonical_name: 'Exact.New-Aura', version: 'current-tts', uuid: 'tts-current', architecture: 'aura-2' }]
  }
}
const deepgramHttp = () => {
  const latest = deepgram()
  const all = structuredClone(latest)
  all.tts.push({ canonical_name: 'Outdated.Only', version: 'zzzz-lexically-higher', uuid: 'outdated-only', architecture: 'aura-2' })
  return httpFor({ deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(all) })
}
async function predecessor(mutate?: (value: BuiltinVoiceCatalogSnapshot) => void, sequence = 1) {
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, id === 'browser' ? {
    sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: oldAt, sourceUrls: [], entries: []
  } : { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: oldAt,
    lastVerifiedAt: oldAt, sourceUrls: [], entries: bundledVoiceCatalogEntries(id), failure: 'incomplete' }])) as BuiltinVoiceCatalogSnapshot['providers']
  const value: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence, generatedAt: oldAt, revision: '0'.repeat(64), providers }
  mutate?.(value)
  value.revision = await voiceCatalogRevision(value)
  return value
}
function memoryStore(initial: string | null = null) {
  let raw = initial
  const store: VoiceCatalogStringStore = {
    read: vi.fn(async () => raw === null ? { state: 'absent' } : { state: 'present', raw }),
    compareAndSet: vi.fn(async (before, next) => { if (raw !== before) return false; raw = next; return true })
  }
  return { store, raw: () => raw, replace(next: string) { raw = next } }
}
const blockedNova = (value: BuiltinVoiceCatalogSnapshot) => {
  Object.assign(value.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!, {
    admission: 'blocked', blockedReason: 'contract-changed', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url]
  })
  value.providers.deepgram.qualificationCoverage = 'blocked'
}
const mistralApi = (changedSpeech: boolean) => JSON.stringify({
  openapi: '3.1.0', servers: [{ url: 'https://api.mistral.ai' }], paths: {
    '/v1/audio/speech': { post: { ...(changedSpeech ? { servers: [{ url: 'https://changed.invalid' }] } : {}) } },
    '/v1/audio/transcriptions': { post: {} }
  }
})

describe('one finite anonymous collector episode', () => {
  it.skipIf(!process.env.VOICE_RECORDING_CAPTURE_ROOT)('qualifies Async ASR only from the fresh HTML operation and rejects the same body under the wrong MIME', async () => {
    const dir = process.env.VOICE_RECORDING_CAPTURE_ROOT as string
    const models = readFileSync(join(dir, 'async-live-models-source.txt'), 'utf8')
    const operation = readFileSync(join(dir, 'async-live-operation-explicit-html.txt'), 'utf8')
    const sources = { asyncModels: models, asyncTranscribe: operation }
    const collector = createBuiltinVoiceCatalogCollector({ http: httpFor(sources), now: () => now })
    const observed = await collector.collect(null)
    const qualified = observed.async.entries.find(entry => entry.modelId === 'async_asr_v1.0')!
    expect(qualified).toMatchObject({ admission: 'qualified', lane: 'stt-recorded', compatibilityProfileId: 'async.recorded-upload.v1', qualificationRuleId: 'async.asr-docs.v1' })
    expect(collector.admitEvaluatedEntry('async', structuredClone(qualified))).toBe(true)

    const before = await predecessor(), io = memoryStore(JSON.stringify(before))
    const published = await publishFreshBuiltinVoiceCatalog({ store: io.store, http: httpFor(sources), now: () => now })
    expect(published.snapshot.providers.async.entries.find(entry => entry.modelId === 'async_asr_v1.0')).toMatchObject({ admission: 'qualified', qualificationRuleId: 'async.asr-docs.v1' })
    for (const previous of before.providers.async.entries.filter(entry => entry.lane === 'tts-batch')) expect(published.snapshot.providers.async.entries).toContainEqual(previous)

    const fallback = httpFor(sources)
    const wrongMime = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === VOICE_SOURCE_HTTP_CONTRACTS.asyncTranscribe.url
      ? new Response(operation, { headers: { 'content-type': 'text/markdown' } }) : fallback(input, init)) as unknown as typeof fetch
    const refused = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: wrongMime, now: () => now })
    expect(refused.snapshot.providers.async.entries.find(entry => entry.modelId === 'async_asr_v1.0')?.admission).toBe('candidate')
  })

  it.skipIf(!process.env.VOICE_SOURCE_PROOF_DIR)('qualifies only canonical Small 3 from its exact captured sources and retains unqualified aliases', async () => {
    const dir = process.env.VOICE_SOURCE_PROOF_DIR as string
    const read = (key: string) => readFileSync(join(dir, `small3-${key}.source`), 'utf8')
    const sources = { mistralSmallModel: read('mistralSmallModel'), mistralChangelog: read('mistralChangelog'),
      mistralTranscribe: read('mistralTranscribe'), mistralApi: read('mistralApi') }
    const before = await predecessor(), result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor(sources), now: () => now })
    expect(result.snapshot.providers.mistral.entries.find(row => row.modelId === 'voxtral-small-transcribe-3-0')).toMatchObject({
      admission: 'qualified', compatibilityProfileId: 'mistral.recorded-segments.v2', qualificationRuleId: 'mistral.small-transcribe-docs.v1', release: 'preview' })
    for (const alias of ['voxtral-small-transcribe-3', 'voxtral-small-transcribe-latest']) expect(result.snapshot.providers.mistral.entries.find(row => row.modelId === alias)?.admission).toBe('candidate')
    for (const altered of [{ ...sources, mistralSmallModel: '' }, { ...sources, mistralChangelog: sources.mistralChangelog.replace('2026-10-20', '2026-10-21') }]) {
      const held = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor(altered), now: () => now })
      expect(held.snapshot.providers.mistral.entries.find(row => row.modelId === 'voxtral-small-transcribe-3-0')?.admission).toBe('candidate')
    }
  })

  it('keeps a positive recorded API contradiction when Small identity and inventory are unavailable', async () => {
    const before = await predecessor(value => {
      const entry = value.providers.mistral.entries.find(row => row.modelId === 'voxtral-small-transcribe-3-0')!
      Object.assign(entry, { admission: 'qualified', compatibilityProfileId: 'mistral.recorded-segments.v2', qualificationRuleId: 'mistral.small-transcribe-docs.v1', qualifiedAt: oldAt, provenance: 'qualified-source', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.mistralApi.url] })
    })
    const api = JSON.stringify({ openapi: '3.1.0', servers: [{ url: 'https://api.mistral.ai' }], paths: {
      '/v1/audio/speech': { post: {} }, '/v1/audio/transcriptions': { post: { servers: [{ url: 'https://changed.invalid' }] } }
    } })
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor({ mistralApi: api }), now: () => now })
    expect(result.snapshot.providers.mistral.entries.find(row => row.modelId === 'voxtral-small-transcribe-3-0')).toMatchObject({ admission: 'blocked', blockedReason: 'contract-changed' })
  })
  it('attempts all15 providers through the fixed anonymous GETs, at most4 at once, with no private or installed-route request', async () => {
    let active = 0, peak = 0
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init }); active++; peak = Math.max(peak, active)
      await Promise.resolve(); active--
      return new Response('Unavailable', { status: 404 })
    }) as unknown as typeof fetch
    const collector = createBuiltinVoiceCatalogCollector({ http, now: () => now })
    const result = await collector.collect(null)
    expect(Object.keys(result)).toEqual([...BUILTIN_VOICE_PROVIDER_IDS])
    expect(collector.getReport()).toHaveLength(15)
    expect(requests.map(request => request.url).sort()).toEqual(sourceKeys.map(key => VOICE_SOURCE_HTTP_CONTRACTS[key].url).sort())
    expect(requests).toHaveLength(39); expect(peak).toBe(4)
    for (const { init } of requests) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) })
      expect(Object.keys(init!.headers!)).toEqual(['Accept'])
    }
    expect(result.browser).toMatchObject({ sourceStatus: 'runtime-owned', entries: [], discoveryCoverage: 'not-applicable' })
    expect(Object.values(result).filter(provider => provider.sourceStatus === 'blocked')).toHaveLength(14)
    await expect(collector.collect(null)).rejects.toThrow('episode_already_used')
    expect(http).toHaveBeenCalledTimes(39)
  })

  it('blocks only the prior Cartesia 3.6 profile on an explicit version contradiction even when model inventory fails', async () => {
    const before = await predecessor(value => {
      const entry = value.providers.cartesia.entries.find(row => row.modelId === 'sonic-3.6')!
      Object.assign(entry, { admission: 'qualified', compatibilityProfileId: 'cartesia.bytes-20260814.v1', qualificationRuleId: 'cartesia.sonic-36-docs.v1', qualifiedAt: oldAt, provenance: 'qualified-source', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.cartesiaBytes.url] })
    })
    const changed = '```yaml latest.yml POST /tts/bytes\n' + JSON.stringify({ components: { parameters: { CartesiaVersionHeader: { schema: { enum: ['2026-09-01'] } } }, schemas: {} } }) + '\n```\n'
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor({ cartesiaBytes: changed }), now: () => now })
    expect(result.snapshot.providers.cartesia.entries.find(row => row.modelId === 'sonic-3.6')).toMatchObject({ admission: 'blocked', blockedReason: 'contract-changed' })
    expect(result.snapshot.providers.cartesia.entries.find(row => row.modelId === 'sonic-3.5')).toEqual(before.providers.cartesia.entries.find(row => row.modelId === 'sonic-3.5'))
    const insufficient = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor({ cartesiaBytes: '# incomplete' }), now: () => now })
    expect(insufficient.snapshot.providers.cartesia.entries).toEqual(before.providers.cartesia.entries)
  })

  it('retains an independently proved Eleven v4 operation block when metadata and documentation inventory are malformed', async () => {
    const before = await predecessor(value => {
      const entry = value.providers.elevenlabs.entries.find(row => row.modelId === 'eleven_v4')!
      Object.assign(entry, { admission: 'qualified', compatibilityProfileId: 'elevenlabs.rest-speech-v4.v1', qualificationRuleId: 'elevenlabs.speech-v4-docs.v1', qualifiedAt: oldAt, provenance: 'qualified-source', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsSpeechApi.url] })
    })
    const latest = deepgram()
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, now: () => now, http: httpFor({
      elevenlabsModels: '{bad', elevenlabsDocs: '# malformed inventory', elevenlabsSpeechApi: 'POST https://api.elevenlabs.io/v1/changed/{voice_id}\n\n## Servers\n',
      deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(latest)
    }) })
    expect(result.snapshot.providers.elevenlabs.entries.find(row => row.modelId === 'eleven_v4')).toMatchObject({ admission: 'blocked', blockedReason: 'contract-changed' })
    expect(result.snapshot.providers.elevenlabs.entries.find(row => row.modelId === 'scribe_v2')).toEqual(before.providers.elevenlabs.entries.find(row => row.modelId === 'scribe_v2'))
    expect(result.snapshot.providers.deepgram.entries.find(row => row.modelId === 'Exact.New-Aura')).toMatchObject({ admission: 'qualified' })
  })

  it('keeps independent Google/OpenAI lanes visible when their companion source fails', async () => {
    const http = httpFor({
      googleTranscribe: '<div class="devsite-article-body"><p>Files use <code>Exact.Recorded</code>.</p><p>Upload to <code>Exact.Recorded</code>.</p></div>',
      openaiSpeech: 'The `Exact.Speech` models are deprecated and will shut down on **January 6, 2027**. Migrate to `Realtime.Other`.\n\n### Text-to-speech models\n\nUse `Exact.Speech`.\n\n### Voices\n\n`voice`\n'
    })
    const collector = createBuiltinVoiceCatalogCollector({ http, now: () => now })
    const providers = await collector.collect(null)
    expect(providers.google).toMatchObject({ sourceStatus: 'verified', discoveryCoverage: 'partial', entries: [{ modelId: 'Exact.Recorded', lane: 'stt-recorded', admission: 'candidate', qualifiedAt: null }] })
    expect(providers.openai.entries).toMatchObject([{ modelId: 'Exact.Speech', lane: 'tts-batch', admission: 'candidate', release: 'deprecated', shutdownAt: '2027-01-06T00:00:00.000Z' }])
    expect(providers.google.sourceUrls).toEqual([VOICE_SOURCE_HTTP_CONTRACTS.googleTranscribe.url])
    expect(collector.getReport().find(row => row.providerId === 'google')?.followUp).toBe('source-incomplete')
  })

  it('preserves prior exact choices and verification date when HTTP200 has unsupported document structure', async () => {
    const before = await predecessor(), io = memoryStore(JSON.stringify(before))
    const result = await publishFreshBuiltinVoiceCatalog({ store: io.store, http: httpFor({ stepfunSpeech: '<main><article>stepaudio-3-tts</article></main>' }), now: () => now, dryRun: false })
    expect(result.snapshot.providers.stepfun).toMatchObject({ sourceStatus: 'blocked', discoveryCoverage: 'unknown', lastVerifiedAt: oldAt })
    expect(result.snapshot.providers.stepfun.entries).toEqual(before.providers.stepfun.entries)
    expect(result.report.find(row => row.providerId === 'stepfun')).toMatchObject({ status: 'blocked', followUp: 'source-incomplete' })
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
  })

  it('keeps the Mistral inventory and independent lane candidates when a companion STT document is missing', async () => {
    const heading = (id: string, level = 2) => `<SectionTab as="h${level}" sectionId="${id}">${id}</SectionTab>`
    const source = [heading('meet-the-models'), heading('models-speech-to-text', 3), '<ModelCards group="stt" />', heading('models-text-to-speech', 3),
      '| Model | Use it to | Key numbers |\n| --- | --- | --- |\n| Voxtral TTS 3 (`Exact.TTS`) | Generate speech from text with preset or cloned voices | |\n| Voxtral Mini Transcribe 3 (`Exact.Recorded`) | Transcribe recorded files, with speaker labels, segment timestamps, and custom vocabulary | |', heading('concepts')].join('\n\n')
    const collector = createBuiltinVoiceCatalogCollector({ http: httpFor({ mistralInventory: source }), now: () => now })
    const provider = (await collector.collect(null)).mistral
    expect(provider.sourceStatus).toBe('verified')
    expect(provider.entries).toMatchObject([{ modelId: 'Exact.TTS', lane: 'tts-batch', admission: 'candidate' }, { modelId: 'Exact.Recorded', lane: 'stt-recorded', admission: 'candidate' }])
    expect(provider.sourceUrls).toEqual([VOICE_SOURCE_HTTP_CONTRACTS.mistralInventory.url])
  })

  it.each(['missing','malformed'] as const)('publishes positive Mistral affected-lane blocks independently of %s inventory', async inventory => {
    const before = await predecessor(value => {
      const speech = value.providers.mistral.entries.find(entry => entry.lane === 'tts-batch')!
      Object.assign(speech, { qualifiedAt: oldAt, provenance: 'qualified-source', qualificationRuleId: 'mistral.speech-docs.v1', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.mistralApi.url] })
      if (inventory === 'malformed') delete value.providers.mistral.lastVerifiedAt
    })
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, now: () => now,
      http: httpFor({ mistralApi: mistralApi(true), ...(inventory === 'malformed' ? { mistralInventory: '# Unsupported inventory\n\n`Invented.New-ID`' } : {}) }) })
    const provider = result.snapshot.providers.mistral
    expect(provider).toMatchObject({ sourceStatus: 'verified', discoveryCoverage: 'unknown', qualificationCoverage: 'blocked', lastVerifiedAt: at,
      sourceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.mistralApi.url] })
    expect(provider.entries.find(entry => entry.lane === 'tts-batch')).toMatchObject({ admission: 'blocked', blockedReason: 'contract-changed', qualifiedAt: oldAt })
    expect(provider.entries.filter(entry => entry.lane === 'stt-recorded')).toEqual(before.providers.mistral.entries.filter(entry => entry.lane === 'stt-recorded'))
    expect(provider.entries.map(entry => [entry.lane, entry.modelId])).toEqual(before.providers.mistral.entries.map(entry => [entry.lane, entry.modelId]))
    expect(result.report.find(row => row.providerId === 'mistral')).toMatchObject({ status: 'blocked', discovery: 'unknown', followUp: 'adapter-contract' })
  })

  it('retains Mistral entries and dates when inventory is unavailable and API evidence is missing or insufficient', async () => {
    const before = await predecessor()
    for (const http of [httpFor(), httpFor({ mistralApi: mistralApi(false) })]) {
      const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http, now: () => now })
      expect(result.snapshot.providers.mistral).toMatchObject({ sourceStatus: 'blocked', lastVerifiedAt: oldAt, entries: before.providers.mistral.entries })
      expect(result.report.find(row => row.providerId === 'mistral')).toMatchObject({ status: 'blocked', followUp: 'source-incomplete' })
    }
  })

  it.each(['duplicate','oversized'] as const)('contains %s provider inventory while healthy Deepgram advances', async fault => {
    const rows = fault === 'duplicate' ? ['same','same'] : Array.from({ length: 501 }, (_, index) => `source-model-${index}`)
    const source = '| Name | Model ID | Description | Supported languages |\n| --- | --- | --- | --- |\n'+rows.map(id => `| Model | \`${id}\` | Speech | en |`).join('\n')
    const latest = deepgram(), before = await predecessor(), io = memoryStore(JSON.stringify(before))
    const result = await publishFreshBuiltinVoiceCatalog({ store: io.store, http: httpFor({ inworldModels: source, deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(latest) }), now: () => now, dryRun: false })
    expect(result.status).toBe('stored')
    expect(result.snapshot.providers.inworld).toMatchObject({ sourceStatus: 'blocked', failure: 'incomplete', lastVerifiedAt: oldAt, entries: before.providers.inworld.entries })
    expect(result.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')).toMatchObject({ admission: 'qualified', qualificationRuleId: 'deepgram.aura-metadata.v1' })
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
  })

  it('blocks MiniMax prior bindings only on a positive changed contract, retaining them for insufficient evidence', async () => {
    const source = (server: string) => '```yaml api-reference/speech/t2a/api/openapi.json POST /v1/t2a_v2\n'+JSON.stringify({
      openapi: '3.1.0', servers: [{ url: server }], paths: { '/v1/t2a_v2': { post: { requestBody: { content: { 'application/json': { schema: {
        type: 'object', properties: { model: { type: 'string', enum: ['speech-2.8-hd'] } }
      } } } } } } }
    })+'\n```\n'
    const before = await predecessor()
    const changed = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor({ minimaxSpeech: source('https://changed.invalid') }), now: () => now })
    expect(changed.snapshot.providers.minimax.entries.every(entry => entry.admission === 'blocked' && entry.blockedReason === 'contract-changed')).toBe(true)
    expect(changed.report.find(row => row.providerId === 'minimax')).toMatchObject({ status: 'blocked', followUp: 'adapter-contract' })
    const insufficient = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor({ minimaxSpeech: source('https://api.minimax.io') }), now: () => now })
    expect(insufficient.snapshot.providers.minimax.entries).toEqual(before.providers.minimax.entries)
    expect(insufficient.report.find(row => row.providerId === 'minimax')).toMatchObject({ status: 'current', pending: 0 })
  })

  it('never touches a source or CAS after an unreadable predecessor or mismatched exact recovery target', async () => {
    const http = httpFor(), io = memoryStore('bad-json')
    await expect(publishFreshBuiltinVoiceCatalog({ store: io.store, http, now: () => now })).rejects.toThrow('malformed_json')
    expect(http).not.toHaveBeenCalled(); expect(io.store.compareAndSet).not.toHaveBeenCalled()
    const before = await predecessor(), collector = createBuiltinVoiceCatalogCollector({ http, now: () => now,
      requalify: [{ providerId: 'deepgram', lane: 'stt-recorded', modelId: 'nova-3', previousCompatibility: 'wrong-predecessor' }] })
    await expect(collector.collect(before)).rejects.toThrow('predecessor_changed')
    expect(http).not.toHaveBeenCalled()
  })

  it('qualifies only exact latest kind/canonical members under compiled architectures, never outdated-only or name-shaped rows', async () => {
    const latest = deepgram()
    latest.tts.push({ canonical_name: 'aura-name-is-not-authority', version: 'new', uuid: 'flux-row', architecture: 'flux' })
    latest.stt.push({ canonical_name: 'nova-name-is-not-authority', version: 'new', uuid: 'future-row', architecture: 'unknown-api', batch: true, streaming: true, formatted_output: true })
    const all = structuredClone(latest)
    all.tts.push({ canonical_name: 'Outdated.Only', version: 'zzzz-lexically-higher', uuid: 'outdated-only', architecture: 'aura-2' })
    const collector = createBuiltinVoiceCatalogCollector({ http: httpFor({ deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(all) }), now: () => now })
    const observed = (await collector.collect(null)).deepgram.entries
    expect(observed.find(entry => entry.modelId === 'Exact.New-Aura')).toMatchObject({ admission: 'qualified', qualificationRuleId: 'deepgram.aura-metadata.v1' })
    expect(observed.find(entry => entry.modelId === 'nova-3')).toMatchObject({ admission: 'qualified', qualificationRuleId: 'deepgram.recorded-metadata.v1' })
    for (const id of ['aura-name-is-not-authority','nova-name-is-not-authority','Outdated.Only']) expect(observed.find(entry => entry.modelId === id)?.admission).toBe('candidate')
    expect(observed.some(entry => entry.modelId === 'outdated-only' || entry.modelId === 'tts-current')).toBe(false)
  })

  it('binds a new ready entry to the actual episode ledger and delivers one representative through the real projection', async () => {
    const collector = createBuiltinVoiceCatalogCollector({ http: deepgramHttp(), now: () => now })
    const observed = await collector.collect(null), evaluated = observed.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')!
    expect(collector.admitEvaluatedEntry('deepgram', structuredClone(evaluated))).toBe(true)
    expect(collector.admitEvaluatedEntry('deepgram', { ...evaluated, modelId: 'Forged.New' })).toBe(false)
    expect(collector.admitEvaluatedEntry('fish', evaluated)).toBe(false)
    const asserted = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'absent' }), collect: async () => observed, compareAndSet: async () => true }, { nowMs: now, initializeAbsent: true })
    expect(asserted.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')?.admission).toBe('candidate')
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore().store, http: deepgramHttp(), now: () => now, initializeAbsent: true })
    const projected = projectBuiltinVoiceCatalog({ snapshot: result.snapshot, source: 'remote', checkedAt: at }, now).find(row => row.providerId === 'deepgram')!
    expect(projected.models['tts-batch']).toContain('Exact.New-Aura')
    expect(projected.models['tts-batch']).not.toContain('Outdated.Only')
    expect(projected.compatibilityProfiles['tts-batch']['Exact.New-Aura']).toBe('deepgram.aura-rest.v1')
  })

  it('does not clear known blocks or unknown mappings during ordinary fresh discovery, and reports retained restrictions', async () => {
    const before = await predecessor(value => {
      blockedNova(value)
      value.providers.deepgram.entries.push({ modelId: 'Exact.New-Aura', label: 'Exact.New-Aura', lane: 'tts-batch', admission: 'qualified', compatibilityProfileId: 'future.profile.v99',
        qualifiedAt: oldAt, qualificationRuleId: 'future.rule.v99', provenance: 'qualified-source', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url], release: 'unknown' })
    })
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: deepgramHttp(), now: () => now })
    expect(result.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')?.admission).toBe('blocked')
    expect(result.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')?.compatibilityProfileId).toBe('future.profile.v99')
    expect(result.report.find(row => row.providerId === 'deepgram')).toMatchObject({ status: 'blocked', pending: 3, followUp: 'adapter-contract' })
  })

  it('recovers only an exact approved target after fresh evaluation and one CAS against original raw bytes', async () => {
    const before = await predecessor(blockedNova), raw = '\n'+JSON.stringify(before, null, 2)+'\n', io = memoryStore(raw)
    const old = before.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!
    const result = await publishFreshBuiltinVoiceCatalog({ store: io.store, http: deepgramHttp(), now: () => now, dryRun: false,
      requalify: [{ providerId: 'deepgram', lane: 'stt-recorded', modelId: 'nova-3', previousCompatibility: voiceCatalogRestrictionFacts('deepgram', old) }] })
    expect(result.status).toBe('stored')
    expect(result.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')).toMatchObject({ admission: 'qualified', requalifiedFrom: [{ compatibility: voiceCatalogRestrictionFacts('deepgram', old), order: { generation: before.generation, sequence: before.sequence, revision: before.revision } }] })
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
    expect(vi.mocked(io.store.compareAndSet).mock.calls[0][0]).toBe(raw)
  })

  it('keeps missed recovery usable through normal refresh while a later identical block needs fresh order-bound recovery', async () => {
    const first = await predecessor(value => {
      blockedNova(value)
      Object.assign(value.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!, { provenance: 'qualified-source', qualificationRuleId: 'deepgram.recorded-metadata.v1',
        qualifiedAt: oldAt, evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url] })
    })
    const latest = deepgram(), http = () => httpFor({ deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(latest) })
    const target = (cut: BuiltinVoiceCatalogSnapshot) => ({ providerId: 'deepgram' as const, lane: 'stt-recorded' as const, modelId: 'nova-3',
      previousCompatibility: voiceCatalogRestrictionFacts('deepgram', cut.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!) })
    const second = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(first)).store, http: http(), now: () => now, requalify: [target(first)] })
    const third = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(second.snapshot)).store, http: http(), now: () => now + 60_000 })
    expect(third.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!.requalifiedFrom).toEqual(second.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!.requalifiedFrom)
    const cacheRaw = (cut: BuiltinVoiceCatalogSnapshot) => JSON.stringify({ schemaVersion: 1, checkedAt: oldAt, snapshot: cut })
    const missed = createBuiltinVoiceCatalogReader({ store: memoryStore(cacheRaw(first)).store, fetchSnapshot: async () => JSON.stringify(third.snapshot), now: () => now + 60_000 })
    expect(selectedVoiceCatalogCompatibility(await missed.refresh(true), 'deepgram', 'stt-recorded', 'nova-3').state).toBe('compatible')
    const observed = structuredClone(third.snapshot.providers), nova = observed.deepgram.entries.find(entry => entry.modelId === 'nova-3')!
    Object.assign(nova, { admission: 'blocked', blockedReason: 'contract-changed' }); observed.deepgram.qualificationCoverage = 'blocked'
    const fourth = (await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: JSON.stringify(third.snapshot) }), collect: async () => observed, compareAndSet: async () => true }, { nowMs: now + 60_000 })).snapshot
    expect(target(fourth).previousCompatibility).toBe(target(first).previousCompatibility)
    const ordinary = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(fourth)).store, http: http(), now: () => now + 60_000 })
    expect(ordinary.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!.admission).toBe('blocked')
    const staleReady = structuredClone(third.snapshot); staleReady.sequence = 6; staleReady.revision = await voiceCatalogRevision(staleReady)
    let remote = JSON.stringify(staleReady)
    const held = createBuiltinVoiceCatalogReader({ store: memoryStore(cacheRaw(fourth)).store, fetchSnapshot: async () => remote, now: () => now + 60_000 })
    const refused = await held.refresh(true)
    expect(refused.warning).toBe('cache-unavailable')
    expect(selectedVoiceCatalogCompatibility(refused, 'deepgram', 'stt-recorded', 'nova-3').state).toBe('blocked')
    const io = memoryStore(JSON.stringify(fourth))
    const fifth = await publishFreshBuiltinVoiceCatalog({ store: io.store, http: http(), now: () => now + 60_000, requalify: [target(fourth)], dryRun: false })
    expect(fifth.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!.requalifiedFrom).toEqual([{ compatibility: target(fourth).previousCompatibility,
      order: { generation: fourth.generation, sequence: fourth.sequence, revision: fourth.revision } }])
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1)
    remote = JSON.stringify(fifth.snapshot)
    expect(selectedVoiceCatalogCompatibility(await held.refresh(true), 'deepgram', 'stt-recorded', 'nova-3').state).toBe('compatible')
  })

  it('keeps full recovery history and the affected block at capacity while another evaluated model advances', async () => {
    const before = await predecessor(value => {
      blockedNova(value)
      const old = value.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!
      const variants = [{ ...old, blockedReason: 'profile-unavailable' as const }, { ...old, blockedReason: 'qualification-required' as const },
        { ...old, provenance: 'qualified-source' as const, qualificationRuleId: 'deepgram.recorded-metadata.v1' },
        { ...old, provenance: 'qualified-source' as const, qualificationRuleId: 'deepgram.recorded-metadata.v1', blockedReason: 'profile-unavailable' as const }]
      old.requalifiedFrom = variants.map((entry, index): VoiceCatalogRecoveryAnchor => ({ compatibility: voiceCatalogRestrictionFacts('deepgram', entry),
        order: { generation: 1, sequence: index + 1, revision: String(index + 1).repeat(64) } }))
    }, 5)
    const old = before.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!, latest = deepgram()
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, now: () => now,
      http: httpFor({ deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(latest) }),
      requalify: [{ providerId: 'deepgram', lane: 'stt-recorded', modelId: 'nova-3', previousCompatibility: voiceCatalogRestrictionFacts('deepgram', old) }] })
    const retained = result.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!
    expect(retained.admission).toBe('blocked'); expect(retained.requalifiedFrom).toEqual(old.requalifiedFrom)
    expect(voiceCatalogEntryCompatibility('deepgram', result.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')!).compatible).toBe(true)
    expect(result.report.find(row => row.providerId === 'deepgram')).toMatchObject({ status: 'blocked', pending: 1, followUp: 'adapter-contract' })
  })

  it('never recollects or retries after a losing CAS, and reports the winning restriction rather than proposed recovery', async () => {
    const before = await predecessor(), winner = await predecessor(blockedNova, 2)
    Object.assign(winner.providers.deepgram, { sourceStatus: 'verified', discoveryCoverage: 'complete', lastVerifiedAt: at, sourceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url] })
    delete winner.providers.deepgram.failure
    winner.revision = await voiceCatalogRevision(winner)
    const io = memoryStore(JSON.stringify(before)), http = deepgramHttp()
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async () => { io.replace(JSON.stringify(winner)); return false })
    const result = await publishFreshBuiltinVoiceCatalog({ store: io.store, http, now: () => now, dryRun: false })
    expect(result.status).toBe('conflict'); expect(result.winner?.revision).toBe(winner.revision)
    expect(io.store.compareAndSet).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(39)
    expect(result.report.find(row => row.providerId === 'deepgram')).toMatchObject({ status: 'blocked', pending: 1, followUp: 'adapter-contract' })
    expect(io.raw()).toBe(JSON.stringify(winner))
  })

  it('reports source-derived deprecation and shutdown changes without changing retained eligibility', async () => {
    const before = await predecessor(), source = (day: number) => `The \`tts-1\` models are deprecated and will shut down on **January ${day}, 2027**.\n\n### Text-to-speech models\n\n\`tts-1\`\n`
    const first = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: httpFor({ openaiSpeech: source(6) }), now: () => now })
    const priorEntry = before.providers.openai.entries.find(entry => entry.modelId === 'tts-1')!, currentEntry = first.snapshot.providers.openai.entries.find(entry => entry.modelId === 'tts-1')!
    expect(voiceCatalogCompatibilityFacts('openai', currentEntry)).toBe(voiceCatalogCompatibilityFacts('openai', priorEntry))
    expect(currentEntry).toMatchObject({ release: 'deprecated', shutdownAt: '2027-01-06T00:00:00.000Z' })
    expect(first.report.find(row => row.providerId === 'openai')?.status).toBe('changed')
    const repeated = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(first.snapshot)).store, http: httpFor({ openaiSpeech: source(6) }), now: () => now + 60_000 })
    expect(repeated.report.find(row => row.providerId === 'openai')?.status).toBe('current')
    const rescheduled = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(first.snapshot)).store, http: httpFor({ openaiSpeech: source(7) }), now: () => now + 60_000 })
    expect(rescheduled.report.find(row => row.providerId === 'openai')?.status).toBe('changed')
  })

  it('reports restored and lost installed eligibility when admission and profile stay the same', async () => {
    const before = await predecessor(value => value.providers.deepgram.entries.push({ modelId: 'Exact.New-Aura', label: 'Exact.New-Aura', lane: 'tts-batch', admission: 'qualified', compatibilityProfileId: 'deepgram.aura-rest.v1',
      provenance: 'qualified-source', qualifiedAt: oldAt, evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url], release: 'unknown' }))
    const latest = deepgram(), http = () => httpFor({ deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(latest) })
    expect(voiceCatalogEntryCompatibility('deepgram', before.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')!).compatible).toBe(false)
    const restored = await publishFreshBuiltinVoiceCatalog({ store: memoryStore(JSON.stringify(before)).store, http: http(), now: () => now })
    expect(voiceCatalogEntryCompatibility('deepgram', restored.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')!).compatible).toBe(true)
    expect(restored.report.find(row => row.providerId === 'deepgram')?.status).toBe('changed')
    const winner = structuredClone(restored.snapshot); winner.sequence++
    delete winner.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')!.qualificationRuleId
    winner.revision = await voiceCatalogRevision(winner)
    const io = memoryStore(JSON.stringify(restored.snapshot))
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async () => { io.replace(JSON.stringify(winner)); return false })
    const lost = await publishFreshBuiltinVoiceCatalog({ store: io.store, http: http(), now: () => now, dryRun: false })
    expect(lost.status).toBe('conflict')
    expect(voiceCatalogEntryCompatibility('deepgram', lost.snapshot.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')!).compatible).toBe(true)
    expect(voiceCatalogEntryCompatibility('deepgram', lost.winner!.providers.deepgram.entries.find(entry => entry.modelId === 'Exact.New-Aura')!).compatible).toBe(false)
    expect(lost.report.find(row => row.providerId === 'deepgram')).toMatchObject({ status: 'changed', pending: 1 })
  })

  it('reports the winner current across equivalent issuer, source-date and order changes despite changed loser observations', async () => {
    const before = await predecessor(value => {
      for (const id of ['deepgram','openai'] as const) {
        Object.assign(value.providers[id], { sourceStatus: 'verified', discoveryCoverage: 'partial', lastVerifiedAt: oldAt,
          sourceUrls: [id === 'deepgram' ? VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url : VOICE_SOURCE_HTTP_CONTRACTS.openaiSpeech.url] })
        delete value.providers[id].failure
      }
    })
    const winner = structuredClone(before); winner.sequence++; winner.generatedAt = at
    for (const id of ['deepgram','openai'] as const) { winner.providers[id].entries.reverse(); winner.providers[id].lastAttemptAt = at; winner.providers[id].lastVerifiedAt = at }
    Object.assign(winner.providers.deepgram.entries.find(entry => entry.modelId === 'nova-3')!, { qualificationRuleId: 'deepgram.recorded-metadata.v1', provenance: 'qualified-source', qualifiedAt: at, evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.deepgramLatest.url] })
    winner.revision = await voiceCatalogRevision(winner)
    const io = memoryStore(JSON.stringify(before)), latest = deepgram()
    vi.mocked(io.store.compareAndSet).mockImplementationOnce(async () => { io.replace(JSON.stringify(winner)); return false })
    const result = await publishFreshBuiltinVoiceCatalog({ store: io.store, now: () => now, dryRun: false, http: httpFor({ deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(latest),
      openaiSpeech: 'The `tts-1` models are deprecated and will shut down on **January 6, 2027**.\n\n### Text-to-speech models\n\n`tts-1`\n' }) })
    expect(result.status).toBe('conflict')
    expect(result.snapshot.providers.openai.entries.find(entry => entry.modelId === 'tts-1')?.release).toBe('deprecated')
    expect(result.winner!.providers.openai.entries.find(entry => entry.modelId === 'tts-1')?.release).toBe('unknown')
    expect(result.report.find(row => row.providerId === 'openai')?.status).toBe('current')
    expect(result.report.find(row => row.providerId === 'deepgram')?.status).toBe('current')
  })

  it('bounds a derived Unicode display label without changing a valid256-byte source ID or poisoning another provider', async () => {
    const longId = 'A'+'😀'.repeat(63)+'xyz'
    expect(Buffer.byteLength(longId, 'utf8')).toBe(256)
    const latest = deepgram(); latest.tts[0].canonical_name = longId
    const result = await publishFreshBuiltinVoiceCatalog({ store: memoryStore().store, http: httpFor({ deepgramLatest: JSON.stringify(latest), deepgramAll: JSON.stringify(latest),
      openaiSpeech: '### Text-to-speech models\n\n`Another.Provider`\n' }), now: () => now, initializeAbsent: true, dryRun: false })
    expect(result.status).toBe('stored')
    const entry = result.snapshot.providers.deepgram.entries.find(entry => entry.modelId === longId)!
    expect(entry.modelId).toBe(longId); expect(entry.label.isWellFormed()).toBe(true)
    expect(Buffer.byteLength(entry.label, 'utf8')).toBeLessThanOrEqual(200)
    expect(entry.label).toBe('A'+'😀'.repeat(49))
    expect(result.snapshot.providers.openai.entries.find(entry => entry.modelId === 'Another.Provider')?.admission).toBe('candidate')
  })

  it('keeps a synthetic Azure REST contract check separate from backend discovery', async () => {
    const collector = createBuiltinVoiceCatalogCollector({ http: httpFor({ azureSpeech: '## Convert text to speech\n\napplication/ssml+xml X-Microsoft-OutputFormat cognitiveservices/v1\n' }), now: () => now })
    const result = await collector.collect(null)
    expect(result.azure.entries).toEqual(bundledVoiceCatalogEntries('azure'))
    expect(result.azure.entries.map(entry => entry.modelId)).toEqual(['azure-neural-tts'])
    expect(result.azure.discoveryCoverage).toBe('complete')
    expect(collector.admitEvaluatedEntry('azure', result.azure.entries[0])).toBe(false)
  })
})

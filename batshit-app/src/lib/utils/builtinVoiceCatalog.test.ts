// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BUILTIN_VOICE_CATALOG_BASELINE, BUILTIN_VOICE_CATALOG_CONTEXT, BUILTIN_VOICE_CATALOG_PROFILES,
  BUILTIN_VOICE_CATALOG_SOURCES, BUILTIN_VOICE_PROVIDER_IDS
} from '../data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogEntry, BuiltinVoiceCatalogSnapshot, BuiltinVoiceProviderCatalog, VoiceCatalogRecoveryAnchor } from '../types/builtinVoiceCatalog'
import {
  assertVoiceCatalogBlockConservation, canRequalifyVoiceCatalogEntry, compareVoiceCatalogAdmission, mergeVoiceCatalogRecoveryAnchors, nextVoiceCatalogOrder, parseBuiltinVoiceCatalog,
  retainVoiceProviderEntries, runVoiceCatalogCasAttempt, verifyBuiltinVoiceCatalog, voiceCatalogCompatibilityFacts,
  voiceCatalogEntryCompatibility, voiceCatalogEntryIdentity, voiceCatalogRevision, voiceCatalogEvaluatedEntryFacts, voiceCatalogRestrictionFacts
} from './builtinVoiceCatalog'

const at = '2026-10-27T12:00:00.000Z'
const now = Date.parse(at)
const emptyRevision = '0'.repeat(64)
const fishSource = BUILTIN_VOICE_CATALOG_SOURCES.find(value => value.providerId === 'fish')!.urls[0]

function fishEntry(overrides: Partial<BuiltinVoiceCatalogEntry> = {}): BuiltinVoiceCatalogEntry {
  return { modelId: 's2.1-pro', label: 's2.1-pro', lane: 'tts-direct-stream', admission: 'qualified',
    compatibilityProfileId: 'fish.timestamp-sse.v1', qualifiedAt: null, provenance: 'bundled-legacy',
    evidenceUrls: [], release: 'stable', ...overrides }
}
function provider(overrides: Partial<BuiltinVoiceProviderCatalog> = {}): BuiltinVoiceProviderCatalog {
  return { sourceStatus: 'verified', discoveryCoverage: 'complete', qualificationCoverage: 'complete',
    lastAttemptAt: at, lastVerifiedAt: at, sourceUrls: [fishSource], entries: [fishEntry()], ...overrides }
}
function snapshot(): BuiltinVoiceCatalogSnapshot {
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => {
    const source = BUILTIN_VOICE_CATALOG_SOURCES.find(value => value.providerId === id)!
    const entries: BuiltinVoiceCatalogEntry[] = BUILTIN_VOICE_CATALOG_BASELINE.filter(binding => binding.providerId === id).map(binding => ({
      modelId: binding.modelId, label: binding.modelId, lane: binding.lane, admission: binding.admission,
      ...(binding.compatibilityProfileId ? { compatibilityProfileId: binding.compatibilityProfileId } : {}),
      qualifiedAt: null, provenance: 'bundled-legacy', evidenceUrls: [], release: 'unknown'
    }))
    return [id, id === 'browser'
      ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries: [] }
      : { sourceStatus: 'verified', discoveryCoverage: 'complete', qualificationCoverage: entries.some(entry => entry.admission === 'candidate') ? 'pending' : 'complete', lastAttemptAt: at, lastVerifiedAt: at, sourceUrls: [source.urls[0]], entries }]
  })) as BuiltinVoiceCatalogSnapshot['providers']
  return { schemaVersion: 1, generation: 1, sequence: 1, revision: emptyRevision, generatedAt: at, providers }
}
async function seal(value = snapshot()): Promise<BuiltinVoiceCatalogSnapshot> {
  value.revision = await voiceCatalogRevision(value)
  return value
}
function parse(value: BuiltinVoiceCatalogSnapshot): BuiltinVoiceCatalogSnapshot { return parseBuiltinVoiceCatalog(JSON.stringify(value), now) }
const recoveryAnchor = (cut: BuiltinVoiceCatalogSnapshot, entry = cut.providers.fish.entries[0]): VoiceCatalogRecoveryAnchor => ({
  compatibility: voiceCatalogRestrictionFacts('fish', entry), order: { generation: cut.generation, sequence: cut.sequence, revision: cut.revision }
})

describe('built-in voice catalog finite data boundary', () => {
  it('keeps the provider roster and immutable provider/lane bindings', () => {
    expect(BUILTIN_VOICE_PROVIDER_IDS).toHaveLength(15)
    expect(BUILTIN_VOICE_CATALOG_SOURCES).toHaveLength(15)
    expect(BUILTIN_VOICE_CATALOG_PROFILES).toHaveLength(36)
    expect(new Set(BUILTIN_VOICE_CATALOG_PROFILES.map(value => JSON.stringify([value.providerId, value.lane, value.id]))).size).toBe(36)
    expect(BUILTIN_VOICE_CATALOG_BASELINE).toHaveLength(105)
    expect(BUILTIN_VOICE_CATALOG_BASELINE.filter(value => value.admission === 'candidate')).toHaveLength(21)
    expect(Object.isFrozen(BUILTIN_VOICE_CATALOG_PROFILES[0])).toBe(true)
    expect(Object.isFrozen(BUILTIN_VOICE_CATALOG_SOURCES[0].urls)).toBe(true)
  })

  it('conserves every exact provider/lane/model/profile/admission from the current owning source arrays', () => {
    const source = readFileSync(new URL('../server/services/voiceService.ts', import.meta.url), 'utf8')
      + '\n' + readFileSync(new URL('../data/builtinVoiceProviderBaseline.ts', import.meta.url), 'utf8')
      + '\n' + readFileSync(new URL('../data/openaiVoiceModelCatalog.ts', import.meta.url), 'utf8')
    const scalars = Object.fromEntries([...source.matchAll(/(?:export )?const (\w+) = '([^']*)'/g)].map(match => [match[1], match[2]]))
    const array = (name: string): string[] => {
      const match = source.match(new RegExp(`(?:export )?const ${name} = \\[(.*?)\\](?: as const)?\\n`, 's'))
      if (!match) throw new Error(`Missing owning model array: ${name}`)
      return match[1].split(',').map(value => value.trim()).filter(Boolean).map(value => {
        if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
        if (Object.hasOwn(scalars, value)) return scalars[value]
        throw new Error(`Unsupported owning literal in ${name}: ${value}`)
      })
    }
    const groups = [
      ['google','tts-batch','GEMINI_TTS_MODELS','google.generate-content.v1'],
      ['google','stt-recorded','GEMINI_STT_MODELS','google.interactions-transcribe.v1'],
      ['openai','stt-recorded','OPENAI_STT_MODELS','openai.file-transcription.v1'],
      ['elevenlabs','tts-batch','ELEVENLABS_TTS_MODELS','elevenlabs.rest-speech.v1'],
      ['elevenlabs','stt-recorded','ELEVENLABS_STT_MODELS','elevenlabs.scribe-upload.v1'],
      ['deepgram','stt-recorded','DEEPGRAM_STT_MODELS','deepgram.recorded-listen.v1'],
      ['deepgram','stt-direct-realtime','DEEPGRAM_REALTIME_STT_MODELS','deepgram.flux-websocket.v1'],
      ['fish','tts-direct-stream','FISH_TTS_MODELS','fish.timestamp-sse.v1'],
      ['fish','stt-recorded','FISH_STT_MODELS','fish.upload-asr.v1'],
      ['mistral','tts-batch','MISTRAL_TTS_MODELS','mistral.audio-speech-json.v1'],
      ['mistral','stt-recorded','MISTRAL_STT_MODELS','mistral.recorded-segments.v1'],
      ['minimax','tts-batch','MINIMAX_TTS_MODELS','minimax.http-hex.v1'],
      ['mimo','tts-batch','MIMO_TTS_MODELS','mimo.chat-audio.v1'],
      ['mimo','stt-recorded','MIMO_STT_MODELS','mimo.chat-asr.v1'],
      ['alibaba','tts-batch','ALIBABA_TTS_MODELS','alibaba.multimodal-tts.v1'],
      ['inworld','tts-batch','INWORLD_TTS_MODELS','inworld.voice-json.v1'],
      ['inworld','tts-direct-stream','INWORLD_TTS_MODELS','inworld.voice-stream.v1'],
      ['cartesia','tts-batch','CARTESIA_TTS_MODELS','cartesia.bytes-20260301.v1'],
      ['async','tts-batch','ASYNC_TTS_MODELS','async.bytes-v1.v1'],
      ['stepfun','tts-batch','STEPFUN_TTS_MODELS','stepfun.audio-speech.v1'],
      ['azure','tts-batch','AZURE_TTS_MODELS','azure.ssml-rest.v1']
    ]
    const expected = groups.flatMap(([provider,lane,name,profile]) => array(name).map(model => [provider,lane,model,profile,'qualified']))
    for (const item of expected) if (item[0] === 'mimo' && item[1] === 'tts-batch') {
      if (item[2] === 'mimo-v2.5-tts-voicedesign') item[3] = 'mimo.chat-voice-design.v1'
      if (item[2] === 'mimo-v2.5-tts-voiceclone') item[3] = 'mimo.chat-voice-clone.v1'
    }
    expected.push(...array('OPENAI_TTS_MODELS').map(model => ['openai','tts-batch',model,model === 'gpt-4o-mini-tts' ? 'openai.speech-mini.v1' : 'openai.speech-legacy.v1','qualified']))
    expected.push(['deepgram','tts-batch',scalars.DEFAULT_DEEPGRAM_TTS_MODEL,'deepgram.aura-rest.v1','qualified'],
      ['deepgram','tts-batch',scalars.DEFAULT_DEEPGRAM_FLUX_TTS_MODEL,'deepgram.flux-rest.v1','qualified'])
    for (const [provider,name] of [['openai','OPENAI_REALTIME_STT_MODELS'],['elevenlabs','ELEVENLABS_REALTIME_STT_MODELS'],['mistral','MISTRAL_REALTIME_STT_MODELS']]) {
      expected.push(...array(name).map(model => [provider,'stt-direct-realtime',model,'','candidate']))
    }
    for (const [provider, lane, model] of [
      ['google','tts-batch','gemini-3.8-flash-tts'], ['google','tts-batch','gemini-3.8-flash-lite-tts'],
      ['openai','stt-recorded','gpt-transcribe'], ['elevenlabs','tts-batch','eleven_v4'], ['elevenlabs','stt-recorded','scribe_v2_medical'],
      ...['qwen-audio-3.1-tts-plus','qwen-audio-3.1-tts-flash','qwen-audio-3.0-tts-plus','qwen-audio-3.0-tts-flash'].map(model => ['alibaba','tts-batch',model]),
      ['inworld','tts-batch','inworld-tts-2-flash'], ['inworld','tts-direct-stream','inworld-tts-2-flash'],
      ['cartesia','tts-batch','sonic-3.6'], ['cartesia','tts-batch','sonic-3.6-2026-08-27'],
      ['async','stt-recorded','async_asr_v1.0'], ['stepfun','tts-batch','stepaudio-3-tts'],
      ['mistral','stt-recorded','voxtral-small-transcribe-3-0'], ['mistral','stt-recorded','voxtral-small-transcribe-3'], ['mistral','stt-recorded','voxtral-small-transcribe-latest']
    ]) expected.push([provider,lane,model,'','candidate'])
    const actual = BUILTIN_VOICE_CATALOG_BASELINE.map(value => [value.providerId,value.lane,value.modelId,value.compatibilityProfileId ?? '',value.admission])
    expect(actual.map(value => JSON.stringify(value)).sort()).toEqual(expected.map(value => JSON.stringify(value)).sort())
  })

  it('admits unknown legacy qualification dates without inventing today', async () => {
    const value = await seal()
    const result = await verifyBuiltinVoiceCatalog(JSON.stringify(value), now)
    expect(result.providers.fish.entries[0].qualifiedAt).toBeNull()
    expect(voiceCatalogEntryCompatibility('fish', result.providers.fish.entries[0])).toEqual({ compatible: true })
    expect(Object.isFrozen(result.providers.fish.entries[0])).toBe(true)
  })

  it.each(['endpoint', 'headers', 'prompt', 'instructions', 'options', 'grants', 'voiceId', 'accountId'])('refuses remote %s fields', key => {
    const value = snapshot()
    Object.assign(value.providers.fish.entries[0], { [key]: 'untrusted' })
    expect(() => parse(value)).toThrow('unexpected_or_missing_field')
  })

  it('refuses missing providers and duplicate identities despite unchanged totals', () => {
    const missing = snapshot()
    delete (missing.providers as Partial<typeof missing.providers>).azure
    expect(() => parse(missing)).toThrow('unexpected_or_missing_field')
    const duplicate = snapshot()
    duplicate.providers.fish.entries.push(fishEntry({ label: 'different label' }))
    expect(() => parse(duplicate)).toThrow('duplicate_entry')
  })

  it('validates UTF8 byte bounds and fixed official provenance rather than character count/host lookalikes', () => {
    const value = snapshot()
    value.providers.fish.entries[0].modelId = '音'.repeat(86)
    expect(() => parse(value)).toThrow('invalid_string')
    value.providers.fish.entries[0] = fishEntry({ evidenceUrls: ['https://docs.fish.audio.attacker.invalid/model'] })
    expect(() => parse(value)).toThrow('unapproved_evidence_url')
    expect(() => parseBuiltinVoiceCatalog(' '.repeat(1024 * 1024 + 1), now)).toThrow('snapshot_too_large')
  })

  it('permits sourced future shutdown warnings but refuses future observed facts and invalid calendar dates', () => {
    const value = snapshot()
    value.providers.fish.entries[0].shutdownAt = '2027-01-06T00:00:00.000Z'
    expect(parse(value).providers.fish.entries[0].shutdownAt).toBe('2027-01-06T00:00:00.000Z')
    value.providers.fish.lastAttemptAt = '2027-01-06T00:00:00.000Z'
    expect(() => parse(value)).toThrow('future_fact')
    value.providers.fish.lastAttemptAt = '2026-02-30T00:00:00.000Z'
    expect(() => parse(value)).toThrow('invalid_timestamp')
  })

  it('separates verified source coverage from pending qualification and runtime-owned browser facts', () => {
    const value = snapshot()
    value.providers.fish.entries.push(fishEntry({ modelId: 'drama-3', admission: 'candidate', compatibilityProfileId: undefined }))
    expect(() => parse(value)).toThrow('qualification_coverage_incomplete')
    value.providers.fish.qualificationCoverage = 'pending'
    expect(parse(value).providers.fish.sourceStatus).toBe('verified')
    value.providers.browser.entries.push(fishEntry())
    expect(() => parse(value)).toThrow('browser_is_runtime_owned')
  })

  it('requires real new qualification evidence and cannot forge bundled legacy provenance', () => {
    expect(() => parse(Object.assign(snapshot(), { providers: { ...snapshot().providers, fish: provider({ entries: [fishEntry({ modelId: 'drama-3', provenance: 'qualified-source' })] }) } }))).toThrow('qualification_evidence_required')
    expect(voiceCatalogEntryCompatibility('fish', fishEntry({ modelId: 'drama-3' }))).toEqual({ compatible: false, reason: 'legacy-binding-unavailable' })
    expect(voiceCatalogEntryCompatibility('fish', fishEntry({ modelId: 'drama-3', provenance: 'qualified-source', qualifiedAt: at, evidenceUrls: [fishSource] }))).toEqual({ compatible: false, reason: 'qualification-rule-unavailable' })
  })

  it('binds a recognized profile to its exact provider AND lane, with unknown versions unavailable', () => {
    expect(voiceCatalogEntryCompatibility('openai', fishEntry())).toEqual({ compatible: false, reason: 'profile-unavailable' })
    expect(voiceCatalogEntryCompatibility('fish', fishEntry({ lane: 'tts-batch' }))).toEqual({ compatible: false, reason: 'profile-unavailable' })
    expect(voiceCatalogEntryCompatibility('fish', fishEntry({ compatibilityProfileId: 'fish.timestamp-sse.v2' }))).toEqual({ compatible: false, reason: 'profile-unavailable' })
    expect(voiceCatalogEntryCompatibility('fish', fishEntry({ admission: 'blocked', blockedReason: 'contract-changed' }))).toEqual({ compatible: false, reason: 'contract-changed' })
  })
})

describe('voice catalog ordering and custody', () => {
  it('defaults to a dry proposal, seeds the exact baseline and never qualifies new source claims', async () => {
    const compareAndSet = vi.fn(async () => true)
    const observed = snapshot().providers
    observed.fish.entries.push(fishEntry({ modelId: 'drama-3', provenance: 'qualified-source', qualifiedAt: at, evidenceUrls: [fishSource] }))
    const result = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'absent' }), collect: async () => observed, compareAndSet }, { nowMs: now, initializeAbsent: true })
    expect(result.status).toBe('proposed')
    expect(compareAndSet).not.toHaveBeenCalled()
    const all = Object.entries(result.snapshot.providers).flatMap(([id, value]) => value.entries.map(entry => voiceCatalogEntryIdentity(id as keyof typeof result.snapshot.providers, entry)))
    for (const binding of BUILTIN_VOICE_CATALOG_BASELINE) expect(all).toContain(voiceCatalogEntryIdentity(binding.providerId, binding))
    const candidate = result.snapshot.providers.fish.entries.find(value => value.modelId === 'drama-3')!
    expect(candidate.admission).toBe('candidate')
    expect(candidate.qualifiedAt).toBeNull()
    expect(result.snapshot.providers.google.entries[0].release).toBe('unknown')
  })

  it('refuses corrupt prior state and implicit initialization before source collection or CAS', async () => {
    const collect = vi.fn(async () => snapshot().providers)
    const compareAndSet = vi.fn(async () => true)
    await expect(runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: '{broken' }), collect, compareAndSet }, { nowMs: now })).rejects.toThrow('malformed_json')
    await expect(runVoiceCatalogCasAttempt({ read: async () => ({ state: 'absent' }), collect, compareAndSet }, { nowMs: now })).rejects.toThrow('initialization_required')
    expect(collect).not.toHaveBeenCalled()
    expect(compareAndSet).not.toHaveBeenCalled()
  })

  it('captures prior before source collection and a CAS loser never republishes stale ready facts over a winner block', async () => {
    const prior = await seal()
    const priorRaw = JSON.stringify(prior)
    const winner = structuredClone(prior)
    winner.sequence = 2
    winner.providers.fish.entries[0].admission = 'blocked'
    winner.providers.fish.entries[0].blockedReason = 'contract-changed'
    winner.providers.fish.qualificationCoverage = 'blocked'
    await seal(winner)
    const events: string[] = []
    let reads = 0
    const read = vi.fn(async () => {
      events.push('read')
      return { state: 'present' as const, raw: reads++ ? JSON.stringify(winner) : priorRaw }
    })
    const collect = vi.fn(async (held: BuiltinVoiceCatalogSnapshot | null) => {
      events.push('collect')
      expect(held?.revision).toBe(prior.revision)
      expect(Object.isFrozen(held?.providers.fish.entries)).toBe(true)
      return structuredClone(prior.providers)
    })
    const compareAndSet = vi.fn(async (expected: string | null) => {
      events.push('cas')
      expect(expected).toBe(priorRaw)
      return false
    })
    const result = await runVoiceCatalogCasAttempt({ read, collect, compareAndSet }, { nowMs: now, dryRun: false })
    expect(result.status).toBe('conflict')
    expect(result.winner?.providers.fish.entries[0].admission).toBe('blocked')
    expect(events).toEqual(['read', 'collect', 'cas', 'read'])
    expect(collect).toHaveBeenCalledTimes(1)
    expect(compareAndSet).toHaveBeenCalledTimes(1)
    expect(result.snapshot.sequence).toBe(2) // No rebuilt seq3 publication from stale evidence.
  })

  it('fails visibly when the winner cannot be read instead of treating it as absence', async () => {
    const prior = await seal()
    let reads = 0
    await expect(runVoiceCatalogCasAttempt({
      read: async () => reads++ ? { state: 'absent' } : { state: 'present', raw: JSON.stringify(prior) },
      collect: async () => structuredClone(prior.providers), compareAndSet: async () => false
    }, { nowMs: now, dryRun: false })).rejects.toThrow('winner_unavailable')
  })

  it.each([undefined, null, '0', 'false', 0, 1])('keeps malformed CAS acknowledgement %s unconfirmed without a winner read', async acknowledgement => {
    const prior = await seal()
    const read = vi.fn(async () => ({ state: 'present' as const, raw: JSON.stringify(prior) }))
    const collect = vi.fn(async () => structuredClone(prior.providers))
    const compareAndSet = vi.fn(async () => acknowledgement as unknown as boolean)
    await expect(runVoiceCatalogCasAttempt({ read, collect, compareAndSet }, { nowMs: now, dryRun: false })).rejects.toThrow('publication_unconfirmed')
    expect(read).toHaveBeenCalledTimes(1)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(compareAndSet).toHaveBeenCalledTimes(1)
  })

  it('validates actual canonical digest, not only an opaque revision string', async () => {
    const value = await seal()
    value.providers.fish.entries[0].label = 'changed under same revision'
    await expect(verifyBuiltinVoiceCatalog(JSON.stringify(value), now)).rejects.toThrow('revision_content_mismatch')
  })

  it('never replaces a newer same-ID block with an older CDN snapshot', async () => {
    const older = await seal()
    const newer = structuredClone(older)
    newer.sequence = 2
    newer.providers.fish.entries[0].admission = 'blocked'
    newer.providers.fish.entries[0].blockedReason = 'contract-changed'
    newer.providers.fish.qualificationCoverage = 'blocked'
    await seal(newer)
    expect(compareVoiceCatalogAdmission(newer, older)).toBe('stale')
    expect(voiceCatalogEntryCompatibility('fish', newer.providers.fish.entries[0]).compatible).toBe(false)
  })

  it('refuses equal-order different content and admits only identical same-order content', async () => {
    const first = await seal()
    const changed = structuredClone(first)
    changed.providers.fish.entries[0].label = 'different'
    await seal(changed)
    expect(() => compareVoiceCatalogAdmission(first, changed)).toThrow('equal_order_different_content')
    expect(compareVoiceCatalogAdmission(first, structuredClone(first))).toBe('same')
  })

  it('requires exact forward reset linkage and does not use timestamps as ordering', async () => {
    const first = await seal()
    const reset = await seal({ ...structuredClone(first), generation: 2, sequence: 1, resetFrom: { generation: 1, sequence: 1, revision: first.revision } })
    expect(compareVoiceCatalogAdmission(first, reset)).toBe('newer')
    expect(compareVoiceCatalogAdmission(reset, first)).toBe('stale')
    reset.resetFrom!.revision = 'f'.repeat(64)
    expect(() => compareVoiceCatalogAdmission(first, reset)).toThrow('unlinked_generation')
    expect(() => compareVoiceCatalogAdmission(first, { ...reset, generation: 3 })).toThrow('unlinked_generation')
    expect(nextVoiceCatalogOrder(first)).toEqual({ generation: 1, sequence: 2 })
    expect(first.sequence).toBe(1)
  })

  it('refuses an unlinked later generation on cold verification and before collecting from a saved head', async () => {
    const unlinked = await seal({ ...snapshot(), generation: 2, sequence: 9 })
    const raw = JSON.stringify(unlinked)
    await expect(verifyBuiltinVoiceCatalog(raw, now)).rejects.toThrow('unlinked_generation')
    const collect = vi.fn(async () => snapshot().providers)
    const compareAndSet = vi.fn(async () => true)
    await expect(runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw }), collect, compareAndSet }, { nowMs: now, dryRun: false })).rejects.toThrow('unlinked_generation')
    expect(collect).not.toHaveBeenCalled()
    expect(compareAndSet).not.toHaveBeenCalled()
    const firstWithLink = await seal({ ...snapshot(), resetFrom: { generation: 1, sequence: 1, revision: emptyRevision } })
    await expect(verifyBuiltinVoiceCatalog(JSON.stringify(firstWithLink), now)).rejects.toThrow('invalid_reset_link')
  })

  it('retains every exact absent identity during growing and failed lists without fresh verification', () => {
    const old = provider({ lastVerifiedAt: '2026-10-26T12:00:00.000Z' })
    const growing = provider({ entries: [fishEntry({ modelId: 'new-a', admission: 'candidate' }), fishEntry({ modelId: 'new-b', admission: 'candidate' })], qualificationCoverage: 'pending' })
    const merged = retainVoiceProviderEntries('fish', old, growing)
    expect(merged.entries.map(value => value.modelId)).toEqual(['s2.1-pro', 'new-a', 'new-b'])
    const failed = retainVoiceProviderEntries('fish', old, provider({ sourceStatus: 'blocked', failure: 'network', entries: [], lastVerifiedAt: at }))
    expect(failed.entries).toEqual(old.entries)
    expect(failed.lastVerifiedAt).toBe(old.lastVerifiedAt)
    failed.entries[0].label = 'mutated return'
    expect(old.entries[0].label).toBe('s2.1-pro')
  })

  it('retains proven same-binding compatibility/evidence when a partial observation merely lacks fields', () => {
    const old = provider({ entries: [fishEntry({ qualifiedAt: '2026-10-26T12:00:00.000Z', evidenceUrls: [fishSource] })] })
    const incomplete = provider({ discoveryCoverage: 'partial', qualificationCoverage: 'pending',
      entries: [fishEntry({ admission: 'candidate', qualifiedAt: null, blockedReason: 'qualification-required' })] })
    const retained = retainVoiceProviderEntries('fish', old, incomplete)
    expect(retained.entries).toEqual(old.entries)
    expect(voiceCatalogEntryCompatibility('fish', retained.entries[0]).compatible).toBe(true)
    incomplete.entries[0].compatibilityProfileId = undefined
    expect(retainVoiceProviderEntries('fish', old, incomplete).entries).toEqual(old.entries)
    incomplete.entries[0] = fishEntry({ admission: 'blocked', blockedReason: 'contract-changed', evidenceUrls: [fishSource] })
    expect(retainVoiceProviderEntries('fish', old, incomplete).entries[0].admission).toBe('blocked')
    incomplete.entries[0] = fishEntry({ admission: 'candidate', compatibilityProfileId: 'fish.timestamp-sse.v2', evidenceUrls: [fishSource] })
    expect(retainVoiceProviderEntries('fish', old, incomplete).entries[0].admission).toBe('candidate')
  })

  it('classifies a successful empty cloud list as blocked/stale while retaining old qualification', async () => {
    const old = provider({ lastVerifiedAt: '2026-10-26T12:00:00.000Z' })
    const empty = provider({ entries: [] })
    const retained = retainVoiceProviderEntries('fish', old, empty)
    expect(retained).toMatchObject({ sourceStatus: 'blocked', failure: 'incomplete', discoveryCoverage: 'unknown', lastVerifiedAt: old.lastVerifiedAt, entries: old.entries })
    const prior = await seal()
    prior.providers.fish.lastVerifiedAt = old.lastVerifiedAt
    await seal(prior)
    const observed = structuredClone(prior.providers)
    observed.fish = empty
    const result = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: JSON.stringify(prior) }),
      collect: async () => observed, compareAndSet: vi.fn(async () => true) }, { nowMs: now })
    expect(result.snapshot.providers.fish.sourceStatus).toBe('blocked')
    expect(result.snapshot.providers.fish.lastVerifiedAt).toBe(old.lastVerifiedAt)
    const invalid = snapshot()
    invalid.providers.fish = empty
    expect(() => parse(invalid)).toThrow('empty_verified_cloud_source')
  })

  it('preserves same-ID block facts/evidence through later list observations and keeps other entries progressing', () => {
    const blocked = provider({ entries: [fishEntry({ admission: 'blocked', blockedReason: 'contract-changed', evidenceUrls: [fishSource] })], qualificationCoverage: 'blocked' })
    const next = retainVoiceProviderEntries('fish', blocked, provider({ entries: [fishEntry(), fishEntry({ modelId: 'new', admission: 'candidate' })], qualificationCoverage: 'pending' }))
    expect(next.entries[0]).toEqual(blocked.entries[0])
    expect(next.entries[1].modelId).toBe('new')
    expect(next.qualificationCoverage).toBe('blocked')
    expect(voiceCatalogEntryIdentity('fish', next.entries[0])).not.toBe(voiceCatalogEntryIdentity('openai', next.entries[0]))
  })

  it('binds A10 to selected semantic compatibility while ignoring freshness, label and evidence timestamps', () => {
    const first = fishEntry()
    const changed = fishEntry({ label: 'new label', qualifiedAt: at, evidenceUrls: [fishSource], shutdownAt: '2027-01-06T00:00:00.000Z' })
    expect(voiceCatalogCompatibilityFacts('fish', first)).toBe(voiceCatalogCompatibilityFacts('fish', changed))
    changed.admission = 'blocked'
    changed.blockedReason = 'contract-changed'
    expect(voiceCatalogCompatibilityFacts('fish', first)).not.toBe(voiceCatalogCompatibilityFacts('fish', changed))
  })
})


describe('installed same-contract rules and code-owned producer authority', () => {
  const fresh = (overrides: Partial<BuiltinVoiceCatalogEntry> = {}) => fishEntry({ modelId: 'New.Exact-ID', provenance: 'qualified-source', qualifiedAt: at, evidenceUrls: [fishSource], qualificationRuleId: 'fish.timestamp-schema.v1', ...overrides })
  it('admits an installed exact rule tuple, refusing a missing, unknown or cross-lane rule', () => {
    expect(voiceCatalogEntryCompatibility('fish', fresh()).compatible).toBe(true)
    for (const entry of [fresh({ qualificationRuleId: undefined }), fresh({ qualificationRuleId: 'future.unknown.v2' }), fresh({ lane: 'tts-batch' })]) expect(voiceCatalogEntryCompatibility('fish', entry).compatible).toBe(false)
  })
  it('keeps raw stamped assertions candidate and accepts only an exact evaluated entry ledger', async () => {
    const observed = snapshot().providers, evaluated = fresh(); observed.fish.entries.push(evaluated)
    const ports = { read: async () => ({ state: 'absent' as const }), collect: async () => observed, compareAndSet: vi.fn(async () => true) }
    const raw = await runVoiceCatalogCasAttempt(ports, { nowMs: now, initializeAbsent: true })
    expect(raw.snapshot.providers.fish.entries.find(entry => entry.modelId === evaluated.modelId)?.admission).toBe('candidate')
    const ledger = new Set([voiceCatalogEvaluatedEntryFacts('fish', evaluated)])
    const accepted = await runVoiceCatalogCasAttempt({ ...ports, admitEvaluatedEntry: (id, entry) => ledger.has(voiceCatalogEvaluatedEntryFacts(id, entry)) }, { nowMs: now, initializeAbsent: true })
    expect(accepted.snapshot.providers.fish.entries.find(entry => entry.modelId === evaluated.modelId)).toEqual(evaluated)
    observed.fish.entries.at(-1)!.evidenceUrls = []
    await expect(runVoiceCatalogCasAttempt({ ...ports, admitEvaluatedEntry: () => true }, { nowMs: now, initializeAbsent: true })).rejects.toThrow('qualification_evidence_required')
    expect(ports.compareAndSet).not.toHaveBeenCalled()
  })
  it('cannot turn prior unknown-rule qualification into readiness through same-profile carry', async () => {
    const prior = snapshot(); prior.providers.fish.entries.push(fresh({ qualificationRuleId: 'future.unknown.v2' })); await seal(prior)
    const observed = structuredClone(prior.providers); observed.fish.entries.at(-1)!.qualificationRuleId = 'fish.timestamp-schema.v1'
    const result = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: JSON.stringify(prior) }), collect: async () => observed, compareAndSet: async () => true }, { nowMs: now })
    expect(result.snapshot.providers.fish.entries.at(-1)?.qualificationRuleId).toBe('future.unknown.v2')
    expect(voiceCatalogEntryCompatibility('fish', result.snapshot.providers.fish.entries.at(-1)!).compatible).toBe(false)
  })
  it('conserves an unknown-rule restriction even when its profile is missing', async () => {
    const prior = snapshot(), old = prior.providers.fish.entries[0]
    Object.assign(old, { admission: 'candidate', qualificationRuleId: 'future.unknown.v2', compatibilityProfileId: undefined }); prior.providers.fish.qualificationCoverage = 'pending'; await seal(prior)
    const result = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: JSON.stringify(prior) }), collect: async () => snapshot().providers, compareAndSet: async () => true }, { nowMs: now })
    expect(result.snapshot.providers.fish.entries[0].qualificationRuleId).toBe('future.unknown.v2')
  })
  it('recovers only an exact compiled transition with fresh evaluated authority and one CAS', async () => {
    const prior = snapshot(), old = prior.providers.fish.entries[0]
    Object.assign(old, { admission: 'blocked', blockedReason: 'contract-changed' }); prior.providers.fish.qualificationCoverage = 'blocked'; await seal(prior)
    const entry = fresh({ modelId: old.modelId, requalifiedFrom: [recoveryAnchor(prior, old)] })
    const observed = snapshot().providers; observed.fish.entries[0] = entry
    const compareAndSet = vi.fn(async (_before: string | null, _next: string) => true), ports = { read: async () => ({ state: 'present' as const, raw: JSON.stringify(prior) }), collect: async () => observed, compareAndSet }
    const raw = await runVoiceCatalogCasAttempt(ports, { nowMs: now })
    expect(raw.snapshot.providers.fish.entries[0].admission).toBe('blocked')
    const result = await runVoiceCatalogCasAttempt({ ...ports, admitEvaluatedEntry: (id, value) => voiceCatalogEvaluatedEntryFacts(id, value) === voiceCatalogEvaluatedEntryFacts('fish', entry) }, { nowMs: now, dryRun: false })
    expect(result.status).toBe('stored'); expect(result.snapshot.providers.fish.entries[0].admission).toBe('qualified')
    expect(compareAndSet).toHaveBeenCalledOnce(); expect(compareAndSet.mock.calls[0][0]).toBe(JSON.stringify(prior))
  })
})

describe('bounded order-bound recovery continuity', () => {
  const ready = (overrides: Partial<BuiltinVoiceCatalogEntry> = {}) => fishEntry({ provenance: 'qualified-source', qualifiedAt: at,
    evidenceUrls: [fishSource], qualificationRuleId: 'fish.timestamp-schema.v1', ...overrides })
  async function blocked() {
    const cut = snapshot()
    cut.providers.fish.entries[0] = ready({ admission: 'blocked', blockedReason: 'contract-changed' })
    cut.providers.fish.qualificationCoverage = 'blocked'
    return seal(cut)
  }
  async function publish(cut: BuiltinVoiceCatalogSnapshot, value: BuiltinVoiceCatalogEntry, evaluated = true) {
    const observed = structuredClone(cut.providers); observed.fish.entries[0] = value
    observed.fish.qualificationCoverage = observed.fish.entries.some(entry => entry.admission === 'blocked') ? 'blocked' : observed.fish.entries.some(entry => entry.admission === 'candidate') ? 'pending' : 'complete'
    const result = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: JSON.stringify(cut) }), collect: async () => observed,
      compareAndSet: async () => true, admitEvaluatedEntry: (id, entry) => evaluated && id === 'fish' && voiceCatalogEvaluatedEntryFacts(id, entry) === voiceCatalogEvaluatedEntryFacts('fish', value) }, { nowMs: now + 120_000 })
    return result.snapshot
  }
  const recovery = (cut: BuiltinVoiceCatalogSnapshot) => ready({ requalifiedFrom: mergeVoiceCatalogRecoveryAnchors(cut.providers.fish.entries[0].requalifiedFrom, [recoveryAnchor(cut)])! })

  it('carries approved coverage through ordinary refresh and metadata churn while later identical blocks require a new covered cut', async () => {
    const first = await blocked(), second = await publish(first, recovery(first))
    const third = await publish(second, ready({ label: 'Updated label', qualifiedAt: new Date(now + 60_000).toISOString() }))
    expect(third.providers.fish.entries[0].requalifiedFrom).toEqual(second.providers.fish.entries[0].requalifiedFrom)
    expect(() => assertVoiceCatalogBlockConservation(first, third)).not.toThrow()
    const issuerChurn = await publish(second, ready({ qualificationRuleId: undefined, qualifiedAt: new Date(now + 60_000).toISOString(), label: 'Same eligible binding' }), false)
    expect(issuerChurn.providers.fish.entries[0].requalifiedFrom).toEqual(second.providers.fish.entries[0].requalifiedFrom)
    expect(voiceCatalogCompatibilityFacts('fish', issuerChurn.providers.fish.entries[0])).toBe(voiceCatalogCompatibilityFacts('fish', second.providers.fish.entries[0]))
    const fourth = await publish(third, ready({ admission: 'blocked', blockedReason: 'contract-changed' }), false)
    expect(voiceCatalogRestrictionFacts('fish', fourth.providers.fish.entries[0])).toBe(voiceCatalogRestrictionFacts('fish', first.providers.fish.entries[0]))
    expect(fourth.providers.fish.entries[0].requalifiedFrom).toEqual(third.providers.fish.entries[0].requalifiedFrom)
    const ordinary = await publish(fourth, ready())
    expect(ordinary.providers.fish.entries[0].admission).toBe('blocked')
    const staleReady = structuredClone(third); staleReady.sequence = 6; await seal(staleReady)
    expect(() => assertVoiceCatalogBlockConservation(fourth, staleReady)).toThrow('known_block_recovery_unqualified')
    const fifth = await publish(fourth, recovery(fourth))
    expect(fifth.providers.fish.entries[0].requalifiedFrom).toEqual([recoveryAnchor(fourth)])
    expect(() => assertVoiceCatalogBlockConservation(fourth, fifth)).not.toThrow()
    expect(() => assertVoiceCatalogBlockConservation(first, fifth)).not.toThrow()
    const differentDigest = structuredClone(fourth); differentDigest.providers.fish.entries[0].label = 'Different cut'; await seal(differentDigest)
    expect(() => assertVoiceCatalogBlockConservation(differentDigest, fifth)).toThrow('known_block_recovery_unqualified')
  })

  it('keeps distinct bounded ancestor coverage and refuses a fifth restriction or conflicting equal-order digest without eviction', async () => {
    const cut = await blocked(); cut.sequence = 5
    const old = cut.providers.fish.entries[0]
    const variants = [ready({ admission: 'blocked', blockedReason: 'profile-unavailable' }), ready({ admission: 'blocked', blockedReason: 'qualification-required' }),
      fishEntry({ admission: 'blocked', blockedReason: 'contract-changed' }), fishEntry({ admission: 'blocked', blockedReason: 'profile-unavailable' })]
    old.requalifiedFrom = variants.map((entry, index) => ({ compatibility: voiceCatalogRestrictionFacts('fish', entry), order: { generation: 1, sequence: index + 1, revision: String(index + 1).repeat(64) } }))
    await seal(cut)
    const added = recoveryAnchor(cut)
    expect(mergeVoiceCatalogRecoveryAnchors(old.requalifiedFrom, [added])).toBeNull()
    const attempt = await publish(cut, ready({ requalifiedFrom: [added] }))
    expect(attempt.providers.fish.entries[0]).toEqual(old)
    const covered = old.requalifiedFrom[0]
    expect(mergeVoiceCatalogRecoveryAnchors(old.requalifiedFrom, [{ ...covered, order: { ...covered.order, sequence: 5, revision: cut.revision } }])?.length).toBe(4)
    expect(mergeVoiceCatalogRecoveryAnchors(old.requalifiedFrom, [{ ...covered, order: { ...covered.order, revision: 'f'.repeat(64) } }])).toBeNull()
  })

  it('cannot plant new anchor history in raw blocks or restore a restriction with caller-stamped anchors', async () => {
    const first = await blocked(), second = await publish(first, recovery(first))
    const forged: VoiceCatalogRecoveryAnchor = { compatibility: 'Forged restriction', order: { generation: second.generation, sequence: second.sequence, revision: second.revision } }
    const third = await publish(second, ready({ admission: 'blocked', blockedReason: 'contract-changed', requalifiedFrom: [...second.providers.fish.entries[0].requalifiedFrom!, forged] }), false)
    expect(third.providers.fish.entries[0].requalifiedFrom).toEqual(second.providers.fish.entries[0].requalifiedFrom)
    const raw = await publish(third, recovery(third), false)
    expect(raw.providers.fish.entries[0].admission).toBe('blocked')
    expect(raw.providers.fish.entries[0].requalifiedFrom).toEqual(third.providers.fish.entries[0].requalifiedFrom)
    const unknown = structuredClone(third); unknown.providers.fish.entries[0].qualificationRuleId = 'future.rule.v99'; await seal(unknown)
    const ordinary = await publish(unknown, ready(), false)
    expect(ordinary.providers.fish.entries[0].qualificationRuleId).toBe('future.rule.v99')
    expect(voiceCatalogEntryCompatibility('fish', ordinary.providers.fish.entries[0]).compatible).toBe(false)
  })

  it('conserves each named floor even when a different restriction remains on the incoming mapping', async () => {
    const mistral = (overrides: Partial<BuiltinVoiceCatalogEntry> = {}): BuiltinVoiceCatalogEntry => ({ modelId: 'voxtral-mini-latest', label: 'Voxtral', lane: 'stt-recorded', admission: 'qualified',
      compatibilityProfileId: 'mistral.recorded-segments.v2', qualificationRuleId: 'mistral.transcribe-segments.v2', provenance: 'qualified-source', qualifiedAt: at,
      evidenceUrls: ['https://docs.mistral.ai/openapi.yaml'], release: 'unknown', ...overrides })
    for (const [old, incoming] of [
      [mistral({ admission: 'blocked', blockedReason: 'contract-changed' }), mistral()],
      [mistral({ qualificationRuleId: 'future.rule.v99' }), mistral()],
      [mistral({ admission: 'blocked', blockedReason: 'profile-unavailable', compatibilityProfileId: 'future.profile.v99' }), mistral({ admission: 'blocked', blockedReason: 'contract-changed' })]
    ]) {
      const cut = snapshot(), index = cut.providers.mistral.entries.findIndex(entry => entry.modelId === old.modelId)
      cut.providers.mistral.entries[index] = old
      cut.providers.mistral.qualificationCoverage = cut.providers.mistral.entries.some(entry => entry.admission === 'blocked') ? 'blocked' : cut.providers.mistral.entries.some(entry => entry.admission === 'candidate') ? 'pending' : 'complete'; await seal(cut)
      const observed = structuredClone(cut.providers); observed.mistral.entries[index] = incoming
      observed.mistral.qualificationCoverage = observed.mistral.entries.some(entry => entry.admission === 'blocked') ? 'blocked' : observed.mistral.entries.some(entry => entry.admission === 'candidate') ? 'pending' : 'complete'
      const result = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: JSON.stringify(cut) }), collect: async () => observed, compareAndSet: async () => true,
        admitEvaluatedEntry: (id, entry) => id === 'mistral' && voiceCatalogEvaluatedEntryFacts(id, entry) === voiceCatalogEvaluatedEntryFacts('mistral', incoming) }, { nowMs: now })
      expect(result.snapshot.providers.mistral.entries[index]).toEqual(old)
      const higher = await seal({ ...structuredClone(cut), sequence: 2, providers: observed })
      expect(() => assertVoiceCatalogBlockConservation(cut, higher)).toThrow('known_block_recovery_unqualified')
      if (old.blockedReason === 'contract-changed') {
        incoming.requalifiedFrom = [{ compatibility: voiceCatalogRestrictionFacts('mistral', old), order: { generation: cut.generation, sequence: cut.sequence, revision: cut.revision } }]
        const approved = await runVoiceCatalogCasAttempt({ read: async () => ({ state: 'present', raw: JSON.stringify(cut) }), collect: async () => observed, compareAndSet: async () => true,
          admitEvaluatedEntry: (id, entry) => id === 'mistral' && voiceCatalogEvaluatedEntryFacts(id, entry) === voiceCatalogEvaluatedEntryFacts('mistral', incoming) }, { nowMs: now })
        expect(voiceCatalogEntryCompatibility('mistral', approved.snapshot.providers.mistral.entries[index]).compatible).toBe(true)
      }
    }
  })

  it('rejects malformed, duplicate and current/future anchors, retaining old-generation history without a cross-generation recovery bypass', async () => {
    const cut = await blocked(), anchor = recoveryAnchor(cut)
    const malformed: unknown[] = ['old-fingerprint-string', [], Array.from({ length: 5 }, (_, index) => ({ ...anchor, compatibility: `restriction-${index}` })),
      [{ ...anchor, extra: true }], [{ ...anchor, compatibility: 'x'.repeat(2049) }], [{ ...anchor, order: { ...anchor.order, sequence: 0 } }],
      [{ ...anchor, order: { ...anchor.order, revision: 'bad' } }], [anchor, { ...anchor, order: { ...anchor.order, sequence: 2 } }],
      [{ ...anchor, order: { ...anchor.order, sequence: 2 } }], [{ ...anchor, order: { ...anchor.order, generation: 2 } }]]
    for (const anchors of malformed) {
      const value = snapshot(); value.sequence = 2
      value.providers.fish.entries[0].requalifiedFrom = anchors as VoiceCatalogRecoveryAnchor[]
      expect(() => parse(value)).toThrow()
    }
    const recovered = await publish(cut, recovery(cut)), reset = structuredClone(recovered)
    reset.generation = 2; reset.sequence = 1; reset.resetFrom = { generation: recovered.generation, sequence: recovered.sequence, revision: recovered.revision }; await seal(reset)
    expect(parse(reset).providers.fish.entries[0].requalifiedFrom).toEqual(recovered.providers.fish.entries[0].requalifiedFrom)
    expect(() => assertVoiceCatalogBlockConservation(cut, reset)).toThrow('known_block_recovery_unqualified')
    expect(canRequalifyVoiceCatalogEntry('fish', cut.providers.fish.entries[0], recovered.providers.fish.entries[0])).toBe(false)
    const dropped = structuredClone(recovered); dropped.sequence++; delete dropped.providers.fish.entries[0].requalifiedFrom; await seal(dropped)
    expect(() => assertVoiceCatalogBlockConservation(recovered, dropped)).toThrow('known_recovery_coverage_missing')
  })
})


describe('lifecycle facts remain independent from eligibility', () => {
  it('adds a sourced future warning without changing qualification, selected dependency or saved identity', () => {
    const before = provider(), observed = provider({ qualificationCoverage: 'pending', entries: [fishEntry({ admission: 'candidate', provenance: 'qualified-source', evidenceUrls: [fishSource], shutdownAt: '2027-01-06T00:00:00.000Z', release: 'deprecated' })] })
    const next = retainVoiceProviderEntries('fish', before, observed), old = before.entries[0], entry = next.entries[0]
    expect(entry).toMatchObject({ modelId: old.modelId, admission: 'qualified', compatibilityProfileId: old.compatibilityProfileId, qualifiedAt: null, release: 'deprecated', shutdownAt: '2027-01-06T00:00:00.000Z' })
    expect(voiceCatalogCompatibilityFacts('fish', old)).toBe(voiceCatalogCompatibilityFacts('fish', entry))
    expect(before.entries[0].shutdownAt).toBeUndefined()
    const absent = retainVoiceProviderEntries('fish', next, provider())
    expect(absent.entries[0]).toMatchObject({ release: 'deprecated', shutdownAt: entry.shutdownAt, admission: 'qualified' })
  })
  it('can add warning facts to an unavailable retained binding without clearing its block', () => {
    const before = provider({ qualificationCoverage: 'blocked', entries: [fishEntry({ admission: 'blocked', blockedReason: 'contract-changed' })] })
    const observed = provider({ qualificationCoverage: 'pending', entries: [fishEntry({ admission: 'candidate', evidenceUrls: [fishSource], shutdownAt: '2027-01-06T00:00:00.000Z', release: 'deprecated' })] })
    expect(retainVoiceProviderEntries('fish', before, observed).entries[0]).toMatchObject({ admission: 'blocked', blockedReason: 'contract-changed', release: 'deprecated', shutdownAt: '2027-01-06T00:00:00.000Z' })
  })
})

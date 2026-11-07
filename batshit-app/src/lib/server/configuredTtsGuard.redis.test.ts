import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { captureSettingsLifecycle, withSettingsRestoreFence } from './services/appActions/settings/lifecycle'
import { CONFIGURED_TTS_READ_PATHS, readConfiguredTtsSnapshot, readVoiceEngineClearRecord, type ConfiguredTtsMutation, type ConfiguredTtsSnapshot } from './configuredTtsGuard'
import { readModelSelectionSnapshot } from './modelSelectionGuard'
import { readOwnedVoicePresetFallbackSources } from './services/modelPresetSelectionOwner'
import { readConfiguredVoiceProfiles, prepareVoiceProfileCleanup, deletePreparedVoiceProfiles } from './services/voiceProfileRecords'
import { readConfiguredTtsTarget } from './services/appActions/settings/configuredTtsSources'
import { planConfiguredTtsSelection } from './services/appActions/settings/configuredTtsAdapter'
import { clearDeletedVoiceEngineAgentProfiles } from './services/voiceEngineRegistry'
import { voiceCatalogSelectionGuard } from './voiceCatalogSelectionGuard'
import { LOCAL_VOICE_CATALOG_KEY } from './services/builtinVoiceCatalogStore'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries } from '$lib/utils/builtinVoiceCatalogProjection'
import { voiceCatalogRevision } from '$lib/utils/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot } from '$lib/types/builtinVoiceCatalog'
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const ID = 'a10_tts_atomic_probe', USER = 'a10_tts_atomic_user', KEY = `agent:${ID}`, PROFILE = 'a10_tts_saved_profile'
const COHORT_IDS = [PROFILE, ...Array.from({ length: 4 }, (_, i) => `${PROFILE}_${i + 2}`)]
const strict = createSettingsRedisAdmission(redis)
const admission = useRedisTestServer({ beforeCleanupAdmission: strict.beforeCleanupAdmission })
afterAll(() => strict.close())
const selection = { providerId: 'openai', modelId: null, voiceId: 'alloy', profileId: null }
async function snapshot() { admission.requireAdmission(); return redis.execute(client => readConfiguredTtsSnapshot(client, ID)) }
async function seed(voice_profile: unknown) {
  admission.requireAdmission()
  await redis.json.set(KEY, '$', { id: ID, user_id: USER, agentType: 'api', created_at: '2026-10-17', displayName: 'Probe', voice_profile })
}
function mutation(target: ConfiguredTtsSnapshot, extra: Partial<ConfiguredTtsMutation> = {}): ConfiguredTtsMutation {
  return { target, selection, sources: [], sourceLifecycle: captureSettingsLifecycle([]), signal: new AbortController().signal, deadlineAt: Date.now() + 5000,
    authority: { key: KEY, paths: [['$.user_id', JSON.stringify([USER])]] }, check() { admission.requireAdmission() }, ...extra }
}
describe.runIf(REAL)('A10 existing sparse writer on real RedisJSON', () => {
  afterEach(async () => { if (admission.isAdmitted()) for (const key of [KEY, LOCAL_VOICE_CATALOG_KEY, ...COHORT_IDS.map(id => `voice_profile:${id}`), 'voice_profile:a10_tts_mutated_profile', 'user:a10_tts_mutated_user:voice_profiles', `user:${USER}:voice_profiles`, `user:${USER}:agents`, `user:${USER}:settings`, `user:${USER}:models`, 'model:a10_tts_fallback', 'model:a10_tts_added']) await redis.del(key) })
  async function seedSelectedModel(locked: boolean) {
    for (const [id, modelId] of [['a10_tts_fallback', locked ? 'gpt-realtime-2' : 'ordinary'], ['a10_tts_added', locked ? 'ordinary' : 'gpt-realtime-2']]) {
      await redis.json.set(`model:${id}`, '$', { id, modelName: id, provider: 'openai', modelId, connection: { type: 'direct', service: 'openai' } })
      await redis.sAdd(`user:${USER}:models`, id)
    }
    for (const [field, value] of Object.entries({ primary_model_preset_id: 'a10_tts_fallback', primary_model_provider: 'openai', primary_model_name: locked ? 'gpt-realtime-2' : 'ordinary', primary_model_connection: { type: 'direct', service: 'openai' } })) await redis.json.set(KEY, `$.${field}`, value)
  }
  it.each(['unrelated', 'blocked', 'candidate-contract-changed', 'wrong-type', 'object-entries', 'duplicate', 'invalid-selected', 'unknown-rule', 'empty-rule', 'candidate-unknown-rule-no-profile', 'new-compatible', 'new-lost-rule'])('guards selected catalog facts in the physical sparse-write EVAL: %s', async change => {
    await seed({ tts: { providerId: 'browser' }, stt: { rawFuture: [0, false] }, future: { keep: 'literal' } })
    const before = await snapshot(), beforeRaw = await redis.json.getRaw(KEY, '$'), execute = redis.execute.bind(redis)
    const at = new Date().toISOString()
    const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, id === 'browser'
      ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries: [] }
      : { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries: bundledVoiceCatalogEntries(id) }])) as BuiltinVoiceCatalogSnapshot['providers']
    const catalog: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence: 2, revision: '0'.repeat(64), generatedAt: at, providers }
    const selected = catalog.providers.openai.entries.find(entry => entry.modelId === 'gpt-4o-mini-tts')!
    if (change === 'blocked') Object.assign(selected, { admission: 'blocked', blockedReason: 'contract-changed' })
    if (change === 'candidate-contract-changed') Object.assign(selected, { admission: 'candidate', blockedReason: 'contract-changed' })
    if (change === 'object-entries') Object.assign(catalog.providers.openai, { entries: { poison: selected } })
    if (change === 'duplicate') catalog.providers.openai.entries.push(structuredClone(selected))
    if (change === 'invalid-selected') delete (selected as Partial<typeof selected>).qualifiedAt
    if (change === 'unknown-rule') selected.qualificationRuleId = 'future.unknown.v2'
    if (change === 'empty-rule') selected.qualificationRuleId = ''
    if (change === 'candidate-unknown-rule-no-profile') Object.assign(selected, { admission: 'candidate', qualificationRuleId: 'future.unknown.v2', compatibilityProfileId: undefined })
    const newModel = change === 'new-compatible' || change === 'new-lost-rule'
    let heldCatalog: BuiltinVoiceCatalogSnapshot | null = null
    if (newModel) {
      catalog.providers.fish.entries.push({ modelId: 'New.Exact-ID', label: 'New', lane: 'tts-direct-stream', admission: 'qualified',
        compatibilityProfileId: 'fish.timestamp-sse.v1', qualificationRuleId: 'fish.timestamp-schema.v1', qualifiedAt: at, provenance: 'qualified-source',
        evidenceUrls: ['https://docs.fish.audio/api-reference/openapi.json'], release: 'unknown' })
      catalog.revision = await voiceCatalogRevision(catalog)
      heldCatalog = structuredClone(catalog)
      await execute(client => client.set(LOCAL_VOICE_CATALOG_KEY, JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot: heldCatalog })))
      catalog.sequence++
      if (change === 'new-lost-rule') catalog.providers.fish.entries.at(-1)!.qualificationRuleId = 'future.unknown.v2'
    }
    catalog.revision = await voiceCatalogRevision(catalog)
    const nextRaw = JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot: catalog })
    const source = heldCatalog
      ? voiceCatalogSelectionGuard({ snapshot: heldCatalog, source: 'retained', checkedAt: at }, 'fish', 'tts-direct-stream', 'New.Exact-ID')
      : voiceCatalogSelectionGuard({ snapshot: null, source: 'bundled', checkedAt: null }, 'openai', 'tts-batch', 'gpt-4o-mini-tts')
    const selectedMutation = newModel ? { ...selection, providerId: 'fish', modelId: 'New.Exact-ID', voiceId: 'public-fixture-voice' } : { ...selection, modelId: 'gpt-4o-mini-tts' }
    const onSaved = vi.fn(); let injected = false
    const wrap = (client: any): any => new Proxy(client, { get(object, property) {
      // The real writer issues through node-redis's AbortSignal view, not the original client.
      if (property === 'withAbortSignal') return (signal: AbortSignal) => wrap(object.withAbortSignal(signal))
      if (property === 'eval') return async (script: string, args: any) => {
        if (!injected && args.keys[0] === KEY && script.includes('voice_catalog_semantic_current')) {
          injected = true
          if (change === 'wrong-type') await object.hSet(LOCAL_VOICE_CATALOG_KEY, 'keep', 'proof')
          else await object.set(LOCAL_VOICE_CATALOG_KEY, nextRaw)
        }
        return object.eval(script, args)
      }
      const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
    } })
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => execute(client => operation(wrap(client))))
    try {
      const result = await redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision,
        configuredTtsMutation: mutation(before, { sources: [source], selection: selectedMutation, onSaved }) }).then(() => 'saved', error => String(error?.code ?? error?.message ?? 'unclassified'))
      expect({ injected, result }).toMatchObject({ injected: true })
      if (change === 'unrelated' || change === 'new-compatible') {
        expect(result).toBe('saved'); expect(onSaved).toHaveBeenCalledOnce()
        expect((await redis.json.get(KEY)).voice_profile).toMatchObject({ tts: { providerId: selectedMutation.providerId, modelId: selectedMutation.modelId }, stt: { rawFuture: [0, false] }, future: { keep: 'literal' } })
      } else {
        expect(result).toBe('tts_selection_changed'); expect(onSaved).not.toHaveBeenCalled()
        expect(await redis.json.getRaw(KEY, '$')).toBe(beforeRaw)
      }
    } finally { spy.mockRestore() }
  })
  it('A10 pre-fix human issued plan refuses a locked tuple even when the caller mutates its payload during the held read', async () => {
    const voice = { tts: { providerId: 'google', voiceId: 'Kore' } }
    await seed(voice); await seedSelectedModel(true)
    const before = await snapshot(), execute = redis.execute.bind(redis)
    let release = () => {}, reached = () => {}, held = false
    const gate = new Promise<void>(resolve => { release = resolve }), read = new Promise<void>(resolve => { reached = resolve })
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => execute(client => operation(new Proxy(client, { get(object, property) {
      if (property === 'eval') return async (script: string, args: any) => {
        const answer = await object.eval(script, args)
        if (!held && args.keys[0] === KEY && args.arguments.length === 1 && args.arguments[0] === JSON.stringify(CONFIGURED_TTS_READ_PATHS)) { held = true; reached(); await gate }
        return answer
      }
      const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
    } }))))
    try {
      const updates = { voice_profile: { tts: { providerId: 'browser' } } }
      const pending = redis.updateAgent(ID, updates as never, { expectedTtsSelection: before.revision }).then(() => 'saved', error => String(error?.code ?? 'unclassified'))
      await read
      updates.voice_profile = voice as never
      release()
      const outcome = await pending
      expect({ outcome, provider: (await redis.json.get(KEY)).voice_profile.tts.providerId }).toEqual({ outcome: 'tts_speech_to_speech_locked', provider: 'google' })
    } finally { release(); spy.mockRestore() }
  })
  it.each([false, true])('A10 pre-fix human issued plan follows the resulting combined model lock (initially locked: %s)', async locked => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' } }); await seedSelectedModel(locked)
    const before = await snapshot(), modelBase = await redis.execute(client => readModelSelectionSnapshot(client, ID, 'agent'))
    const outcome = await redis.updateAgent(ID, { primary_model_preset_id: 'a10_tts_added', primary_model_provider: 'openai', primary_model_name: locked ? 'ordinary' : 'gpt-realtime-2',
      primary_model_connection: { type: 'direct', service: 'openai' }, voice_profile: { tts: { providerId: 'browser' } } } as never,
      { expectedTtsSelection: before.revision, expectedModelSelection: modelBase.revision }).then(() => 'saved', error => String(error?.code ?? 'unclassified'))
    const row = await redis.json.get(KEY)
    expect({ outcome, presetId: row.primary_model_preset_id, provider: row.voice_profile.tts.providerId }).toEqual(locked
      ? { outcome: 'saved', presetId: 'a10_tts_added', provider: 'browser' }
      : { outcome: 'tts_speech_to_speech_locked', presetId: 'a10_tts_fallback', provider: 'google' })
  })
  it('writes only the tuple and preserves raw voice siblings and nested extensions', async () => {
    const profile = { schemaVersion: 19, stt: { future: [0], providerId: 'browser' }, realtimeStt: null, inputDeviceId: 'raw', voiceSessionRuntime: 'direct', custom: { keep: true },
      tts: { providerId: 'google', voiceId: 'Kore', narration: { italicBehavior: 'silent', future: 0 }, style: { raw: 'keep' }, providerOptions: { custom: { future: false } } } }
    await seed(profile)
    const before = await snapshot(), onSaved = vi.fn()
    await redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before, { onSaved }) })
    expect(onSaved).toHaveBeenCalledOnce()
    expect((await redis.json.get(KEY)).voice_profile).toEqual({ ...profile, tts: { ...profile.tts, providerId: 'openai', voiceId: 'alloy' } })
  })
  it('requires the original human base and rejects a stale whole voice block before other fields', async () => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' }, stt: { providerId: 'browser' } })
    const before = await snapshot()
    await expect(redis.updateAgent(ID, { voice_profile: { tts: { providerId: 'openai' } } })).rejects.toMatchObject({ code: 'tts_selection_base_required', status: 400 })
    await redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before) })
    await expect(redis.updateAgent(ID, { displayName: 'Must not save', voice_profile: { tts: { providerId: 'google', voiceId: 'Kore' } } }, { expectedTtsSelection: before.revision })).rejects.toMatchObject({ code: 'tts_selection_changed', status: 409 })
    expect((await redis.json.get(KEY)).displayName).toBe('Probe')
    expect((await redis.json.get(KEY)).voice_profile.tts.voiceId).toBe('alloy')
  })
  it('BL-1683 permits ordinary no-voice saves and still guards explicit whole-null deletes', async () => {
    const voice = { tts: { providerId: 'google', voiceId: 'Kore' }, stt: { future: [0] } }
    await seed(voice)
    await redis.updateAgent(ID, { displayName: 'Ordinary change' })
    expect((await redis.json.get(KEY)).voice_profile).toEqual(voice)
    expect((await redis.json.get(KEY)).displayName).toBe('Ordinary change')
    await expect(redis.updateAgent(ID, { displayName: 'Must not save', voice_profile: null } as never)).rejects.toMatchObject({ code: 'tts_selection_base_required' })
    expect((await redis.json.get(KEY)).displayName).toBe('Ordinary change')
    const original = await snapshot()
    await redis.updateAgent(ID, { voice_profile: null } as never, { expectedTtsSelection: original.revision })
    expect((await redis.json.get(KEY)).voice_profile).toBeUndefined()
  })
  it('BL-1685 enforces a raced saved-model lock for an actual human tuple change while allowing unchanged-tuple STT/runtime edits', async () => {
    const voice = { tts: { providerId: 'google', voiceId: 'Kore' }, stt: { providerId: 'browser' }, voiceSessionRuntime: 'direct' }
    await seed(voice)
    const before = await snapshot()
    await redis.json.set('model:a10_tts_fallback', '$', { id: 'a10_tts_fallback', provider: 'openai', modelId: 'gpt-realtime-2' })
    await redis.sAdd(`user:${USER}:models`, 'a10_tts_fallback')
    await redis.json.set(KEY, '$.primary_model_preset_id', 'a10_tts_fallback')
    await expect(redis.updateAgent(ID, { displayName: 'Must not save', voice_profile: { ...voice, tts: { providerId: 'browser' } } } as never, { expectedTtsSelection: before.revision })).rejects.toMatchObject({ code: 'tts_speech_to_speech_locked' })
    expect((await redis.json.get(KEY)).displayName).toBe('Probe')
    await redis.updateAgent(ID, { voice_profile: { ...voice, stt: { providerId: 'browser', future: true }, voiceSessionRuntime: 'livekit' } } as never, { expectedTtsSelection: before.revision })
    expect((await redis.json.get(KEY)).voice_profile).toEqual({ ...voice, stt: { providerId: 'browser', future: true }, voiceSessionRuntime: 'livekit' })
  })
  it('BL-1685 repeats human model-source guards at physical issue after the lock read', async () => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' } })
    await redis.json.set('model:a10_tts_fallback', '$', { id: 'a10_tts_fallback', provider: 'openai', modelId: 'ordinary' })
    await redis.sAdd(`user:${USER}:models`, 'a10_tts_fallback')
    await redis.json.set(KEY, '$.primary_model_preset_id', 'a10_tts_fallback')
    const before = await snapshot(), original = await redis.json.getRaw(KEY, '$'), execute = redis.execute.bind(redis)
    let raced = false
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => execute(client => operation(new Proxy(client, { get(object, property) {
      if (property === 'eval') return async (script: string, args: any) => {
        if (!raced && script.includes('local guard = ARGV[5]')) { raced = true; await object.json.set('model:a10_tts_fallback', '$.modelId', 'gpt-realtime-2') }
        return object.eval(script, args)
      }
      const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
    } }))))
    try {
      await expect(redis.updateAgent(ID, { voice_profile: { tts: { providerId: 'browser' } } } as never, { expectedTtsSelection: before.revision })).rejects.toMatchObject({ code: 'tts_selection_changed' })
      expect(raced).toBe(true)
      expect(await redis.json.getRaw(KEY, '$')).toBe(original)
    } finally { spy.mockRestore() }
  })
  it('checks inherited source raw preimages in the same command before any tuple write', async () => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' } })
    const source = `user:${USER}:settings`
    await redis.json.set(source, '$', { voice_settings: { tts: { voiceId: 'system' } } })
    const before = await snapshot(), original = await redis.json.getRaw(KEY, '$')
    await redis.json.set(source, '$.voice_settings.tts.voiceId', 'changed')
    await expect(redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before, { sources: [{ key: source, path: '$.voice_settings.tts.voiceId', raw: '["system"]' }] }) })).rejects.toMatchObject({ code: 'tts_selection_changed' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(original)
  })
  it.each(['metadata', 'membership'] as const)('binds the pure owned fallback %s source through final TTS command issue', async race => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' } })
    await redis.json.set('model:a10_tts_fallback', '$', { id: 'a10_tts_fallback', modelName: 'Ordinary', provider: 'openai', modelId: 'ordinary' })
    await redis.sAdd(`user:${USER}:models`, 'a10_tts_fallback')
    const fallback = await readOwnedVoicePresetFallbackSources(USER, { primary_model_provider: 'openai', primary_model_name: 'gpt-realtime-2' })
    expect(fallback.candidates).toEqual([])
    const before = await snapshot(), original = await redis.json.getRaw(KEY, '$')
    if (race === 'metadata') await redis.json.set('model:a10_tts_fallback', '$.modelId', 'gpt-realtime-2')
    else {
      await redis.json.set('model:a10_tts_added', '$', { id: 'a10_tts_added', modelName: 'Realtime', provider: 'openai', modelId: 'gpt-realtime-2' })
      await redis.sAdd(`user:${USER}:models`, 'a10_tts_added')
    }
    const sources = [{ key: fallback.indexKey, members: fallback.ids }, ...fallback.typeChecks, ...fallback.checks.flatMap(check => check.paths.map(([path, raw]) => ({ key: check.key, path, raw: raw || '[]' })))]
    await expect(redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before, { sources, sourceLifecycle: fallback.lifecycle }) })).rejects.toMatchObject({ code: 'tts_selection_changed' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(original)
  })
  it.each(['type', 'service', 'isVercelImport', 'parent'] as const)('BL-1686 guards a nonmatch fallback %s discriminator through physical issue', async race => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' } })
    const connection = race === 'type' ? { type: 'vercel-gateway', service: 'openai' } : race === 'service' ? { type: 'direct', service: 'other' } : race === 'parent' ? {} : undefined
    await redis.json.set('model:a10_tts_fallback', '$', { id: 'a10_tts_fallback', provider: 'openai', modelId: 'other', effectiveModelId: 'gpt-realtime-2', ...(connection ? { connection } : {}), ...(race === 'isVercelImport' ? { isVercelImport: true } : {}) })
    await redis.sAdd(`user:${USER}:models`, 'a10_tts_fallback')
    const source = await readOwnedVoicePresetFallbackSources(USER, { primary_model_provider: 'openai', primary_model_name: 'gpt-realtime-2', primary_model_connection: { type: 'direct', service: 'openai' } })
    expect(source.candidates).toEqual([])
    const before = await snapshot(), original = await redis.json.getRaw(KEY, '$')
    await redis.json.set('model:a10_tts_fallback', race === 'parent' ? '$.connection' : race === 'isVercelImport' ? '$.isVercelImport' : `$.connection.${race}`, race === 'parent' ? null : race === 'isVercelImport' ? false : race === 'type' ? 'direct' : 'openai')
    const sources = [{ key: source.indexKey, members: source.ids }, ...source.typeChecks, ...source.checks.flatMap(check => check.paths.map(([path, raw]) => ({ key: check.key, path, raw: raw || '[]' })))]
    await expect(redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before, { sources, sourceLifecycle: source.lifecycle }) })).rejects.toMatchObject({ code: 'tts_selection_changed' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(original)
  })
  it.each([undefined, null, ''])('retains indexed legacy profile owner %s without admitting a present foreign owner', async owner => {
    admission.requireAdmission()
    await redis.json.set(`voice_profile:${PROFILE}`, '$', { id: PROFILE, ...(owner === undefined ? {} : { user_id: owner }), name: 'Legacy saved', provider: 'openai', voiceId: 'alloy', settings: { providerOptions: { byo: { authToken: 'PRIVATE_PROFILE_KEY', ref_audio: '/PRIVATE/REFERENCE.wav' } } } })
    await redis.sAdd(`user:${USER}:voice_profiles`, PROFILE)
    const source = await readConfiguredVoiceProfiles(USER, PROFILE)
    expect(source.profiles[0]).toMatchObject({ id: PROFILE, providerId: 'openai', voiceId: 'alloy', guard: { fingerprint: expect.stringMatching(/^[a-f0-9]{40}$/) } })
    expect(JSON.stringify(source)).not.toMatch(/PRIVATE_PROFILE_KEY|REFERENCE.wav|ref_audio|authToken/)
    await redis.json.set(`voice_profile:${PROFILE}`, '$.user_id', 'another-owner')
    await expect(readConfiguredVoiceProfiles(USER, PROFILE)).rejects.toThrow('voice_profile_source_unavailable')
  })
  it('enrolls the actual profile replacement writer so repeated IDs cannot revive source validity', async () => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' } })
    const profile = { id: PROFILE, user_id: USER, name: 'Saved', provider: 'openai' as const, voiceId: 'alloy', created_at: '2026-10-17', updated_at: '2026-10-17' }
    await redis.createVoiceProfile(profile)
    const before = await snapshot(), sourceLifecycle = captureSettingsLifecycle([`voice_profile:${PROFILE}`])
    await redis.createVoiceProfile(profile)
    await expect(redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before, { sourceLifecycle }) })).rejects.toMatchObject({ code: 'SETTINGS_LIFECYCLE_CHANGED' })
    expect((await redis.json.get(KEY)).voice_profile.tts.voiceId).toBe('Kore')
  })
  it('BL-1687 captures a detached profile payload and fixed lifecycle/index IDs before its first await', async () => {
    admission.requireAdmission()
    const profile = { id: PROFILE, user_id: USER, name: 'Original', provider: 'browser' as const, voiceId: 'system', created_at: '2026-10-17', updated_at: '2026-10-17' }
    const pending = redis.createVoiceProfile(profile)
    Object.assign(profile, { id: 'a10_tts_mutated_profile', user_id: 'a10_tts_mutated_user', name: 'Changed' })
    const saved = await pending
    expect(saved).toMatchObject({ id: PROFILE, user_id: USER, name: 'Original' })
    expect(await redis.json.get(`voice_profile:${PROFILE}`)).toMatchObject({ id: PROFILE, user_id: USER, name: 'Original' })
    expect(await redis.sMembers(`user:${USER}:voice_profiles`)).toContain(PROFILE)
    expect(await redis.sMembers('user:a10_tts_mutated_user:voice_profiles')).toEqual([])
    expect(await redis.json.get('voice_profile:a10_tts_mutated_profile')).toBeNull()
  })
  it('clears deleted-engine references from one atomic current raw voice while preserving unrelated siblings', async () => {
    const voice = { schemaVersion: 19, tts: { providerId: 'byo:a10_deleted', voiceId: 'saved', custom: true }, stt: { providerId: 'browser', future: [0] }, voiceSessionRuntime: 'direct', extension: { keep: false } }
    await seed(voice); await redis.sAdd(`user:${USER}:agents`, ID)
    expect(await clearDeletedVoiceEngineAgentProfiles(USER, ['byo:a10_deleted'])).toEqual([ID])
    expect((await redis.json.get(KEY)).voice_profile).toEqual({ ...voice, tts: {} })
  })
  it('conflicts on a concurrent STT change after the engine-clear atomic read even when its TTS base is unchanged', async () => {
    await seed({ tts: { providerId: 'byo:a10_deleted' }, stt: { providerId: 'browser' } })
    const current = await redis.execute(client => readVoiceEngineClearRecord(client, USER, ID))
    await redis.json.set(KEY, '$.voice_profile.stt', { providerId: 'browser', future: true })
    expect((await snapshot()).revision).toBe(current.basis.target.revision)
    await expect(redis.updateAgent(ID, { voice_profile: null } as never, { expectedTtsSelection: current.basis.target.revision, voiceEngineClearBasis: current.basis })).rejects.toMatchObject({ code: 'tts_selection_changed' })
    expect((await redis.json.get(KEY)).voice_profile.stt).toEqual({ providerId: 'browser', future: true })
  })
  it('checks a private profile payload fingerprint without returning that payload into source evidence', async () => {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' } })
    await redis.createVoiceProfile({ id: PROFILE, user_id: USER, name: 'Saved', provider: 'browser', voiceId: 'system', settings: { providerOptions: { privateOption: 'ORIGINAL_PRIVATE_VALUE' } }, created_at: '2026-10-17', updated_at: '2026-10-17' } as never)
    const source = await readConfiguredVoiceProfiles(USER, PROFILE), before = await snapshot(), original = await redis.json.getRaw(KEY, '$')
    expect(JSON.stringify(source)).not.toContain('ORIGINAL_PRIVATE_VALUE')
    await redis.json.set(`voice_profile:${PROFILE}`, '$.settings.providerOptions.privateOption', 'CHANGED_PRIVATE_VALUE')
    await expect(redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before, { sources: [source.profiles[0].guard], sourceLifecycle: source.lifecycle }) })).rejects.toMatchObject({ code: 'tts_selection_changed' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(original)
  })

  async function qwenFixture(globalWinner = false) {
    await seed({ tts: { providerId: 'google', voiceId: 'Kore' }, stt: { providerId: 'browser', future: [0, false] }, extension: { keep: true } })
    const singapore = 'https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    const beijing = 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    const model = 'qwen-audio-3.1-tts-plus', voice = 'longanlingxin_v3.1'
    await redis.json.set(`user:${USER}:settings`, '$', { voice_settings: { tts: { providerId: 'alibaba', common: { endpoint: singapore } }, ttsEngineSettings: { alibaba: { common: { endpoint: globalWinner ? '' : beijing } } } } })
    await redis.createVoiceProfile({ id: PROFILE, user_id: USER, name: 'Saved', provider: 'alibaba', voiceId: 'longanlingxin_v3.1', model: 'qwen-audio-3.1-tts-plus', settings: { common: { endpoint: singapore } }, created_at: '2026-10-17', updated_at: '2026-10-17' } as never)
    const at = new Date().toISOString()
    const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, id === 'browser'
      ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries: [] }
      : { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries: bundledVoiceCatalogEntries(id) }])) as BuiltinVoiceCatalogSnapshot['providers']
    const entry = providers.alibaba.entries.find(item => item.modelId === model && item.lane === 'tts-batch')!
    Object.assign(entry, { admission: 'qualified', compatibilityProfileId: 'alibaba.audio-http.v1', qualificationRuleId: 'alibaba.audio-http-docs.v1', qualifiedAt: at, provenance: 'qualified-source', evidenceUrls: ['https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-voice-list'] })
    const catalog: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence: 2, revision: '0'.repeat(64), generatedAt: at, providers }
    catalog.revision = await voiceCatalogRevision(catalog)
    await redis.execute(client => client.set(LOCAL_VOICE_CATALOG_KEY, JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot: catalog })))
    const freshTarget = async () => {
      const source = await readConfiguredTtsTarget(USER, ID, PROFILE)
      expect(JSON.stringify(source)).not.toContain(singapore)
      expect(JSON.stringify(source)).not.toContain(beijing)
      const provider = source.providers.find(item => item.id === 'alibaba')!
      const currentRaw = await redis.execute(client => client.get(LOCAL_VOICE_CATALOG_KEY))
      expect(typeof currentRaw).toBe('string')
      const currentCatalog = JSON.parse(currentRaw!).snapshot as BuiltinVoiceCatalogSnapshot
      expect(currentCatalog.revision).toBe(catalog.revision)
      return { ...source, providers: source.providers.map(item => item.id === 'alibaba' ? { ...provider, configured: 'yes' as const, enabled: true, supportsTts: true, models: [model] } : item),
        catalog: { ...source.catalog, voiceCatalog: { source: 'retained' as const, checkedAt: at, snapshot: currentCatalog } } }
    }
    return { target: await freshTarget(), freshTarget, singapore, beijing, model, voice }
  }

  it.each(['global', 'engine', 'profile'] as const)('refuses a changed original Qwen %s endpoint at sparse issue', async changed => {
    const { target, freshTarget, singapore, beijing, model, voice } = await qwenFixture(changed === 'global')
    const profile = target.profiles.find(value => value.id === PROFILE)!
    expect(profile.qwenEndpointRegion).toBe('singapore')
    const plan = planConfiguredTtsSelection(target, changed === 'profile' ? { selection: 'profile', profileId: PROFILE } : { selection: 'provider', providerId: 'alibaba', modelId: model, voiceId: voice })
    expect(plan.catalogDependency?.[0].voiceCatalog).toMatchObject({ providerId: 'alibaba', modelId: model, expected: { admission: 'qualified', profile: 'alibaba.audio-http.v1', eligible: true } })
    expect(plan.selection).toMatchObject({ providerId: 'alibaba', modelId: model, voiceId: voice })
    const before = target.snapshot, original = await redis.json.getRaw(KEY, '$'), onSaved = vi.fn()
    const held = mutation(before, { selection: plan.selection, sources: plan.guards, sourceLifecycle: plan.sourceLifecycle, onSaved })
    const key = changed === 'profile' ? `voice_profile:${PROFILE}` : `user:${USER}:settings`
    const path = changed === 'profile' ? '$.settings.common.endpoint' : changed === 'global' ? '$.voice_settings.tts.common.endpoint' : '$.voice_settings.ttsEngineSettings.alibaba.common.endpoint'
    await redis.json.set(key, path, changed === 'engine' ? singapore : beijing)
    await expect(redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: held })).rejects.toMatchObject({ code: 'tts_selection_changed' })
    expect(onSaved).not.toHaveBeenCalled()
    expect(await redis.json.getRaw(KEY, '$')).toBe(original)
    // After known no-save, restore the fixture and prepare an independent new selection.
    await redis.json.set(key, path, changed === 'engine' ? beijing : singapore)
    const fresh = await freshTarget()
    const newPlan = planConfiguredTtsSelection(fresh, changed === 'profile' ? { selection: 'profile', profileId: PROFILE } : { selection: 'provider', providerId: 'alibaba', modelId: model, voiceId: voice })
    const newSaved = vi.fn()
    await redis.updateAgent(ID, {}, { expectedTtsSelection: fresh.snapshot.revision, configuredTtsMutation: mutation(fresh.snapshot, { selection: newPlan.selection, sources: newPlan.guards, sourceLifecycle: newPlan.sourceLifecycle, onSaved: newSaved }) })
    expect(onSaved).not.toHaveBeenCalled()
    expect(newSaved).toHaveBeenCalledOnce()
    expect((await redis.json.get(KEY)).voice_profile).toMatchObject({ tts: { providerId: 'alibaba', modelId: model, voiceId: voice }, stt: { providerId: 'browser', future: [0, false] }, extension: { keep: true } })
  })

  it.each(['profile', 'engine'] as const)('ignores lower-priority Qwen endpoint changes when %s wins', async winner => {
    const { target, singapore, beijing, model, voice } = await qwenFixture()
    const plan = planConfiguredTtsSelection(target, winner === 'profile' ? { selection: 'profile', profileId: PROFILE } : { selection: 'provider', providerId: 'alibaba', modelId: model, voiceId: voice })
    expect(plan.catalogDependency?.[0].voiceCatalog).toMatchObject({ providerId: 'alibaba', modelId: model, expected: { admission: 'qualified', profile: 'alibaba.audio-http.v1', eligible: true } })
    const before = target.snapshot, onSaved = vi.fn()
    await redis.json.set(`user:${USER}:settings`, winner === 'profile' ? '$.voice_settings.ttsEngineSettings.alibaba.common.endpoint' : '$.voice_settings.tts.common.endpoint', winner === 'profile' ? singapore : beijing)
    await redis.updateAgent(ID, {}, { expectedTtsSelection: before.revision, configuredTtsMutation: mutation(before, { selection: plan.selection, sources: plan.guards, sourceLifecycle: plan.sourceLifecycle, onSaved }) })
    expect(onSaved).toHaveBeenCalledOnce()
    expect((await redis.json.get(KEY)).voice_profile).toMatchObject({ tts: { providerId: 'alibaba', modelId: model, voiceId: voice }, stt: { providerId: 'browser', future: [0, false] }, extension: { keep: true } })
  })

  const cohortProvider = 'byo:cohort-engine' as const
  const cohortProfile = (id = PROFILE) => ({ id, user_id: USER, name: 'Saved cohort', provider: cohortProvider,
    voiceId: 'saved', created_at: '2026-10-23', updated_at: '2026-10-23' })
  async function seedCohort(value: Record<string, unknown>, id = String(value.id)) {
    admission.requireAdmission()
    await redis.json.set(`voice_profile:${id}`, '$', value)
    await redis.sAdd(`user:${USER}:voice_profiles`, id)
  }

  it('BL-2108 preserves the exact native whole and field guards in the A10 projection', async () => {
    await seedCohort({ ...cohortProfile(), name: 'Native \u2028 label', settings: { private: 'PRIVATE_COHORT_VALUE' } })
    const raw = await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')
    const source = await readConfiguredVoiceProfiles(USER)
    const prepared = await prepareVoiceProfileCleanup(USER, [cohortProvider])
    expect(prepared.profiles[0].raw).toBe(raw)
    expect(prepared.profiles[0].fingerprint).toBe(source.profiles[0].guard.fingerprint)
    for (const guard of source.profiles[0].metadataGuards) expect(guard.raw).toBe(await redis.json.getRaw(guard.key, guard.path))
    expect(JSON.stringify(source)).not.toMatch(/PRIVATE_COHORT_VALUE|settings/)
  })

  it('BL-2108 excludes picker-only fields and projected limits from cleanup', async () => {
    await seedCohort({ id: PROFILE, user_id: USER, provider: cohortProvider, name: 'n'.repeat(20000), model: { future: true } })
    expect((await prepareVoiceProfileCleanup(USER, [cohortProvider])).profiles.map(row => row.id)).toEqual([PROFILE])
    await expect(readConfiguredVoiceProfiles(USER)).rejects.toThrow('voice_profile_source_unavailable')
  })

  it.each([undefined, null, ''])('BL-2108 retains indexed legacy owner %s for original cleanup', async user_id => {
    await seedCohort({ id: PROFILE, ...(user_id === undefined ? {} : { user_id }), provider: cohortProvider })
    const prepared = await prepareVoiceProfileCleanup(USER, [cohortProvider])
    expect((await deletePreparedVoiceProfiles(prepared)).deletedProfileIds).toEqual([PROFILE])
    expect(await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')).toBeNull()
  })

  it.each(['missing', 'wrong-type', 'array', 'id-mismatch', 'foreign-owner'] as const)(
    'BL-2108 refuses an indexed %s row before deleting any member', async shape => {
      await seedCohort(cohortProfile())
      const id = COHORT_IDS[1], key = `voice_profile:${id}`
      await redis.sAdd(`user:${USER}:voice_profiles`, id)
      if (shape === 'wrong-type') await redis.execute(client => client.set(key, 'unsupported string'))
      if (shape === 'array') await redis.json.set(key, '$', [])
      if (shape === 'id-mismatch') await redis.json.set(key, '$', { ...cohortProfile(id), id: 'different' })
      if (shape === 'foreign-owner') await redis.json.set(key, '$', { ...cohortProfile(id), user_id: 'different-user' })
      const before = await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')
      await expect(prepareVoiceProfileCleanup(USER, [cohortProvider])).rejects.toThrow()
      expect(await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')).toBe(before)
    }
  )

  it.each(['count', 'id-bytes', 'raw-bytes', 'cohort-bytes'] as const)('BL-2108 enforces the native %s cap', async cap => {
    admission.requireAdmission()
    if (cap === 'count') await redis.execute(client => client.sAdd(`user:${USER}:voice_profiles`, Array.from({ length: 1025 }, (_, i) => `${PROFILE}_${i}`)))
    else if (cap === 'id-bytes') await redis.sAdd(`user:${USER}:voice_profiles`, 'é'.repeat(129))
    else if (cap === 'raw-bytes') await seedCohort({ ...cohortProfile(), extension: 'x'.repeat(65536) })
    else for (const id of COHORT_IDS) await seedCohort({ ...cohortProfile(id), extension: 'x'.repeat(60000) })
    await expect(prepareVoiceProfileCleanup(USER, [cohortProvider])).rejects.toThrow(/cleanup/)
  })

  it('BL-2108 refuses a native roster addition between its two original reads', async () => {
    await seedCohort(cohortProfile())
    const execute = redis.execute.bind(redis)
    let added = false
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => execute(async client => {
      const view = new Proxy(Object.create(null), { get(_target, property) {
        if (property === 'eval') return async (script: string, args: any) => {
          const answer = await client.eval(script, args)
          if (!added && script.includes('VOICE_PROFILE_RAW_INVENTORY_IDS')) {
            added = true
            await client.json.set(`voice_profile:${COHORT_IDS[1]}`, '$', cohortProfile(COHORT_IDS[1]))
            await client.sAdd(`user:${USER}:voice_profiles`, COHORT_IDS[1])
          }
          return answer
        }
        const value = Reflect.get(client, property, client)
        return typeof value === 'function' ? value.bind(client) : value
      } })
      return operation(view)
    }))
    try { await expect(prepareVoiceProfileCleanup(USER, [cohortProvider])).rejects.toThrow('complete saved profile inventory') }
    finally { spy.mockRestore() }
    expect(added).toBe(true)
    expect(await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')).not.toBeNull()
  })

  it('BL-2108 deletes both original members without whole-cohort revision reuse', async () => {
    await redis.createVoiceProfile(cohortProfile())
    await redis.createVoiceProfile(cohortProfile(COHORT_IDS[1]))
    const prepared = await prepareVoiceProfileCleanup(USER, [cohortProvider])
    expect((await deletePreparedVoiceProfiles(prepared)).deletedProfileIds).toEqual([PROFILE, COHORT_IDS[1]])
    for (const id of [PROFILE, COHORT_IDS[1]]) expect(await redis.json.getRaw(`voice_profile:${id}`, '$')).toBeNull()
  })

  it('BL-2108 refuses a byte-identical same-ID recreation by original incarnation', async () => {
    await redis.createVoiceProfile(cohortProfile())
    const prepared = await prepareVoiceProfileCleanup(USER, [cohortProvider])
    const before = await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')
    await redis.createVoiceProfile(cohortProfile())
    expect(await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')).toBe(before)
    await expect(deletePreparedVoiceProfiles(prepared)).rejects.toMatchObject({ code: 'SETTINGS_LIFECYCLE_CHANGED' })
    expect(await redis.json.getRaw(`voice_profile:${PROFILE}`, '$')).toBe(before)
  })

  it.each(['provider', 'private-path'] as const)('BL-2108 refuses changed raw %s inside the admitted owner before rm', async change => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cohort-raw-owner-')), oldHome = process.env.BATSHIT_HOME_DIR
    process.env.BATSHIT_HOME_DIR = tempRoot
    const dir = path.join(tempRoot, 'voice-profiles', PROFILE), audio = path.join(dir, 'reference.wav'), replacement = path.join(dir, 'replacement.wav')
    await mkdir(dir, { recursive: true }); await writeFile(audio, 'original sample'); await writeFile(replacement, 'replacement sample')
    try {
      await seedCohort({ ...cohortProfile(), settings: { batshitManagedReferenceAudioPath: audio } })
      const prepared = await prepareVoiceProfileCleanup(USER, [cohortProvider])
      await redis.json.set(`voice_profile:${PROFILE}`, change === 'provider' ? '$.provider' : '$.settings.batshitManagedReferenceAudioPath', change === 'provider' ? 'byo:another-engine' : replacement)
      await expect(deletePreparedVoiceProfiles(prepared)).rejects.toThrow('changed after cleanup was prepared')
      expect(await readFile(audio, 'utf8')).toBe('original sample')
      expect(await readFile(replacement, 'utf8')).toBe('replacement sample')
    } finally {
      if (oldHome === undefined) delete process.env.BATSHIT_HOME_DIR; else process.env.BATSHIT_HOME_DIR = oldHome
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('BL-2108 rechecks its admitted owner after a native raw read held across restore start', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cohort-restore-owner-')), oldHome = process.env.BATSHIT_HOME_DIR
    process.env.BATSHIT_HOME_DIR = tempRoot
    const dir = path.join(tempRoot, 'voice-profiles', PROFILE), audio = path.join(dir, 'reference.wav')
    await mkdir(dir, { recursive: true }); await writeFile(audio, 'sample must remain')
    let release!: () => void
    let deleting: Promise<unknown> | undefined, restoring: Promise<void> | undefined
    const nativeRead = redis.json.getRaw
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      await seedCohort({ ...cohortProfile(), settings: { batshitManagedReferenceAudioPath: audio } })
      const prepared = await prepareVoiceProfileCleanup(USER, [cohortProvider])
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
      spy = vi.spyOn(redis.json, 'getRaw').mockImplementation(async (key, path) => {
        const value = await nativeRead(key, path)
        if (key === `voice_profile:${PROFILE}` && path === '$') { entered(); await held }
        return value
      })
      deleting = deletePreparedVoiceProfiles(prepared).then(() => undefined, error => error)
      await started
      restoring = withSettingsRestoreFence(async () => {})
      release()
      expect(await deleting).toMatchObject({ code: 'SETTINGS_LIFECYCLE_CHANGED' })
      await restoring
      expect(await readFile(audio, 'utf8')).toBe('sample must remain')
    } finally {
      release?.(); await deleting; await restoring; spy?.mockRestore()
      if (oldHome === undefined) delete process.env.BATSHIT_HOME_DIR; else process.env.BATSHIT_HOME_DIR = oldHome
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('BL-2108 preserves a newly published profile outside the captured cohort as an explicit residual', async () => {
    await redis.createVoiceProfile(cohortProfile())
    const prepared = await prepareVoiceProfileCleanup(USER, [cohortProvider])
    await redis.createVoiceProfile(cohortProfile(COHORT_IDS[1]))
    expect((await deletePreparedVoiceProfiles(prepared)).deletedProfileIds).toEqual([PROFILE])
    expect(await redis.json.getRaw(`voice_profile:${COHORT_IDS[1]}`, '$')).not.toBeNull()
  })

})

import { describe, expect, it } from 'vitest'
import { planConfiguredTtsSelection, projectConfiguredTts } from './configuredTtsAdapter'
import { resolveConfiguredTtsEffective, type ConfiguredTtsTarget } from './configuredTtsSources'
import { captureSettingsLifecycle } from './lifecycle'
import type { HeldConfiguredFishChoice } from './configuredTtsAccountPaging'
import { bundledVoiceCatalogEntries } from '$lib/utils/builtinVoiceCatalogProjection'
const selection = { providerId: null, modelId: null, voiceId: null, profileId: null }
function target(extra: Partial<ConfiguredTtsTarget> = {}): ConfiguredTtsTarget {
  return { selection, globalSelection: selection, effective: { ...selection, providerId: 'browser' }, locked: false, guards: [], profiles: [], choices: [],
    sourceLifecycle: captureSettingsLifecycle([]), catalog: { voiceCatalog: { snapshot: null, source: 'bundled', checkedAt: null }, profileSource: { lifecycle: captureSettingsLifecycle([]) } },
    providers: [{ id: 'openai', configured: 'yes', enabled: true, supportsTts: true, models: ['gpt-4o-mini-tts', 'tts-1'], voices: ['alloy', 'marin'], guards: [], defaultModel: 'gpt-4o-mini-tts' }],
    checkEnvironment() {}, ...extra } as unknown as ConfiguredTtsTarget
}
describe('configured TTS selection authorization and projection', () => {
  const raw = '[{"encrypted":"SYNTHETIC_PRIVATE"}]', key = 'api_keys:u:fish'
  function fishTarget(extra: Partial<ConfiguredTtsTarget> = {}) {
    return target({ snapshot: { id: 'a10', record: { id: 'a10', user_id: 'u', agentType: 'api' }, paths: [], raw: [], parentType: 'object', ttsType: 'object', lifecycle: captureSettingsLifecycle(['agent:a10']), revision: `sha256:${'a'.repeat(64)}` },
      providers: [{ id: 'fish', label: 'Fish', configured: 'yes', enabled: true, supportsTts: true, models: ['s2.1-pro', 's1'], voices: [],
        guards: [{ key, path: '$', raw }], defaultModel: 's2.1-pro', defaultVoice: null, catalog: 'configured-subset' }], ...extra })
  }
  function observed(): HeldConfiguredFishChoice {
    return Object.freeze({ subject: { kind: 'primary', id: 'a10' }, choice: { source: 'provider-list', providerId: 'fish', voiceId: 'account_voice', modelId: null, profileId: null,
      label: 'Observed', labelTruncated: false, modelScope: 'unknown' }, source: { providerId: 'fish', credential: { key, path: '$', raw }, environmentStamp: 'a'.repeat(64), observedAt: '2026-10-18T12:00:00.000Z', modelScope: 'unknown' },
      observedAt: '2026-10-18T12:00:00.000Z', extent: 'credential-workspace', queryModelId: 's2.1-pro' } satisfies HeldConfiguredFishChoice)
  }
  it('offers an observed Fish voice with configured models without inventing entitlement/readiness requirements', () => {
    const held = observed(), plan = planConfiguredTtsSelection(fishTarget(), { selection: 'provider', providerId: 'fish', modelId: 's1', voiceId: 'account_voice' }, held)
    expect(plan.selection).toEqual({ providerId: 'fish', modelId: 's1', voiceId: 'account_voice', profileId: null })
    expect(plan.accountChoice).toBe(held)
    expect(plan.guards).toContainEqual({ key, path: '$', raw })
    const globalSelection = { ...selection, providerId: 'fish', modelId: 'saved_nonstatic_model' }
    expect(planConfiguredTtsSelection(fishTarget({ globalSelection }), { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'account_voice' }, held).effectiveAfter.modelId).toBe('saved_nonstatic_model')
    expect(() => planConfiguredTtsSelection(fishTarget(), { selection: 'provider', providerId: 'fish', modelId: 'invented', voiceId: 'account_voice' }, held)).toThrow('tts_model_not_configured')
    expect(() => planConfiguredTtsSelection(fishTarget({ locked: true }), { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'account_voice' }, held)).toThrow('tts_speech_to_speech_locked')
  })
  it('requires the held subject/provider/key source but leaves an independent saved choice valid when account evidence is absent or irrelevant', () => {
    const input = { selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'account_voice' }, held = observed()
    expect(() => planConfiguredTtsSelection(fishTarget(), input)).toThrow('tts_voice_catalog_source_unavailable')
    expect(() => planConfiguredTtsSelection(fishTarget(), input, { ...held, subject: { kind: 'primary', id: 'other' } })).toThrow('tts_voice_catalog_source_unavailable')
    expect(() => planConfiguredTtsSelection(fishTarget(), input, { ...held, source: { ...held.source, credential: { ...held.source.credential, raw: '["rotated"]' } } })).toThrow('tts_voice_catalog_source_unavailable')
    const local = fishTarget({ globalSelection: { ...selection, providerId: 'fish', voiceId: 'account_voice' }, choices: [{ source: 'saved-global', providerId: 'fish', modelId: null, voiceId: 'account_voice', profileId: null, label: 'Saved' }] })
    expect(planConfiguredTtsSelection(local, input).accountChoice).toBeUndefined()
    expect(planConfiguredTtsSelection(local, input, { ...held, source: { ...held.source, credential: { ...held.source.credential, key: 'foreign' } } }).accountChoice).toBeUndefined()
  })
  it('admits a configured provider without requiring an online or prepared engine', () => {
    const plan = planConfiguredTtsSelection(target(), { selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'marin' })
    expect(plan.selection).toEqual({ providerId: 'openai', modelId: null, voiceId: 'marin', profileId: null })
    expect(plan.catalogDependency?.map(source => source.voiceCatalog)).toMatchObject([{ providerId: 'openai', lane: 'tts-batch', modelId: 'gpt-4o-mini-tts' }])
  })
  it('binds effective inherited selections and keeps Browser/BYO outside cloud catalog authority', () => {
    const inherited = planConfiguredTtsSelection(target({ globalSelection: { ...selection, providerId: 'openai', modelId: 'tts-1', voiceId: 'alloy' } }), { selection: 'inherit' })
    expect(inherited.catalogDependency?.[0].voiceCatalog.modelId).toBe('tts-1')
    expect(planConfiguredTtsSelection(target(), { selection: 'inherit' }).catalogDependency).toBeNull()
  })
  it('binds Deepgram actual voice override even when its ignored model is no longer offered', () => {
    const plan = planConfiguredTtsSelection(target({ providers: [{ id: 'deepgram', label: 'Deepgram', configured: 'yes', enabled: true, supportsTts: true, models: [],
      voices: ['aura-2-thalia-en'], guards: [], defaultModel: 'aura-2-asteria-en', defaultVoice: 'aura-2-asteria-en', catalog: 'static-complete' }] }),
      { selection: 'provider', providerId: 'deepgram', modelId: 'flux-hannah-en', voiceId: 'aura-2-thalia-en' })
    expect(plan.catalogDependency?.[0].voiceCatalog).toMatchObject({ modelId: 'aura-2-thalia-en', expected: { profile: 'deepgram.aura-rest.v1' } })
  })
  it('keeps Inworld batch and Direct dependencies separate and refuses either blocked lane', () => {
    const base = target({ providers: [{ id: 'inworld', label: 'Inworld', configured: 'yes', enabled: true, supportsTts: true, models: ['inworld-tts-2'], voices: ['Alex'],
      guards: [], defaultModel: 'inworld-tts-2', defaultVoice: 'Alex', catalog: 'static-complete' }] })
    const input = { selection: 'provider', providerId: 'inworld', modelId: 'inworld-tts-2', voiceId: 'Alex' }
    expect(planConfiguredTtsSelection(base, input).catalogDependency?.map(source => source.voiceCatalog.lane)).toEqual(['tts-batch', 'tts-direct-stream'])
    const entries = bundledVoiceCatalogEntries('inworld')
    Object.assign(entries.find(entry => entry.lane === 'tts-batch' && entry.modelId === 'inworld-tts-2')!, { admission: 'blocked', blockedReason: 'contract-changed' })
    const restricted = { ...base, catalog: { ...base.catalog, voiceCatalog: { source: 'retained', checkedAt: null, snapshot: { providers: { inworld: { entries } } } } } } as unknown as ConfiguredTtsTarget
    expect(() => planConfiguredTtsSelection(restricted, input)).toThrow('tts_catalog_compatibility_unavailable')
    expect(() => planConfiguredTtsSelection({ ...base, catalog: { ...base.catalog, voiceCatalog: { snapshot: null, source: 'unavailable', checkedAt: null } } }, input)).toThrow('tts_catalog_compatibility_unavailable')
  })
  it('enforces model-specific voices, configured source membership and speech-to-speech lock', () => {
    expect(() => planConfiguredTtsSelection(target(), { selection: 'provider', providerId: 'openai', modelId: 'tts-1', voiceId: 'marin' })).toThrow()
    expect(() => planConfiguredTtsSelection(target(), { selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'invented' })).toThrow()
    expect(() => planConfiguredTtsSelection(target({ locked: true }), { selection: 'inherit' })).toThrow()
    expect(() => planConfiguredTtsSelection(target(), { selection: 'profile', profileId: 'foreign_or_missing' })).toThrow()
  })
  it('binds a proposed Qwen model to original global, engine and selected-profile region facts', () => {
    const model = 'qwen-audio-3.1-tts-plus', voice = 'longanlingxin_v3.1'
    const entries = bundledVoiceCatalogEntries('alibaba')
    Object.assign(entries.find(entry => entry.modelId === model)!, { admission: 'qualified', provenance: 'qualified-source', compatibilityProfileId: 'alibaba.audio-http.v1', qualificationRuleId: 'alibaba.audio-http-docs.v1', qualifiedAt: '2026-10-28T00:00:00.000Z', evidenceUrls: ['https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-voice-list'] })
    const globalGuard = { key: 'user:u:settings', path: '$.voice_settings.tts.common.endpoint', fingerprint: 'a'.repeat(40), byteLimit: 1024 }
    const engineGuard = { key: 'user:u:settings', path: '$.voice_settings.ttsEngineSettings.alibaba.common.endpoint', fingerprint: 'b'.repeat(40), byteLimit: 1024 }
    const profile = { id: 'qwen_profile', providerId: 'alibaba', modelId: model, voiceId: voice, name: 'Saved', qwenEndpointRegion: 'singapore' as const, guard: { key: 'voice_profile:qwen_profile', path: '$', fingerprint: 'c'.repeat(40), byteLimit: 65536 }, metadataGuards: [], membership: { key: 'user:u:voice_profiles', member: 'qwen_profile', present: true } }
    const base = target({ globalSelection: { ...selection, providerId: 'alibaba' }, profiles: [profile], providers: [{ id: 'alibaba', label: 'Alibaba', configured: 'yes', enabled: true, supportsTts: true, models: [model], voices: ['Cherry'], guards: [], defaultModel: 'qwen3-tts-flash', defaultVoice: 'Cherry', catalog: 'static-complete' }],
      catalog: { voiceCatalog: { source: 'retained', checkedAt: null, snapshot: { providers: { alibaba: { entries } } } }, profileSource: { lifecycle: captureSettingsLifecycle(['voice_profile:qwen_profile']) }, qwenWorkspace: { globalAvailable: true, engineAvailable: true, global: 'singapore', engine: 'beijing', globalGuards: [globalGuard], engineGuards: [engineGuard] } } } as never)
    const plan = planConfiguredTtsSelection(base, { selection: 'profile', profileId: profile.id })
    expect(plan.guards).toContainEqual(profile.guard)
    expect(plan.guards).not.toContainEqual(globalGuard)
    expect(plan.guards).not.toContainEqual(engineGuard)
    expect(plan.effectiveAfter).toMatchObject({ providerId: 'alibaba', modelId: model, voiceId: voice })
    expect(() => planConfiguredTtsSelection({ ...base, profiles: [{ ...profile, qwenEndpointRegion: 'invalid' }] }, { selection: 'profile', profileId: profile.id })).toThrow('tts_qwen_audio_workspace_selection_unavailable')
    expect(() => planConfiguredTtsSelection(base, { selection: 'provider', providerId: 'alibaba', modelId: model, voiceId: 'Cherry' })).toThrow('tts_profile_voice_incompatible')
    const unrelated = { ...base, globalSelection: { ...selection, providerId: 'openai' } }
    const otherPlan = planConfiguredTtsSelection(unrelated, { selection: 'provider', providerId: 'alibaba', modelId: model, voiceId: voice })
    expect(otherPlan.guards).toContainEqual(engineGuard)
    expect(otherPlan.guards).not.toContainEqual(globalGuard)
    const inheritedGlobal = { ...base, catalog: { ...base.catalog, qwenWorkspace: { ...base.catalog.qwenWorkspace, engine: null } } }
    const globalPlan = planConfiguredTtsSelection(inheritedGlobal, { selection: 'provider', providerId: 'alibaba', modelId: model, voiceId: voice })
    expect(globalPlan.guards).toEqual(expect.arrayContaining([globalGuard, engineGuard]))
  })
  it('BL-1690 validates provider and absent-model profile voices against the actual inherited model', () => {
    const globalSelection = { ...selection, providerId: 'openai', modelId: 'tts-1' }
    const base = target({ globalSelection })
    expect(() => planConfiguredTtsSelection(base, { selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'marin' })).toThrow('tts_voice_catalog_source_unavailable')
    expect(planConfiguredTtsSelection(base, { selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'alloy' }).effectiveAfter.modelId).toBe('tts-1')
    expect(planConfiguredTtsSelection(base, { selection: 'provider', providerId: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'marin' }).effectiveAfter.modelId).toBe('gpt-4o-mini-tts')
    const profile = { id: 'openai_profile', providerId: 'openai', modelId: null, voiceId: 'marin', name: 'Saved' }
    expect(() => planConfiguredTtsSelection(target({ globalSelection, profiles: [profile], providers: base.providers.map(provider => ({ ...provider, catalog: 'static-complete' })) } as never), { selection: 'profile', profileId: profile.id })).toThrow('tts_profile_voice_incompatible')
  })
  it('expands an indexed saved profile coherently while retaining its source guard', () => {
    const profile = { id: 'voice_owned', providerId: 'byo:closed', modelId: 'saved-clone-model', voiceId: 'custom_voice', name: 'Saved', guard: { key: 'voice_profile:voice_owned', path: '$', fingerprint: 'a'.repeat(40), byteLimit: 65536 }, metadataGuards: [{ key: 'voice_profile:voice_owned', path: '$.id', raw: '["voice_owned"]' }], membership: { key: 'user:u:voice_profiles', member: 'voice_owned', present: true } }
    const plan = planConfiguredTtsSelection(target({ profiles: [profile], providers: [{ id: 'byo:closed', configured: 'yes', enabled: true, supportsTts: true, models: [], voices: [], guards: [], catalog: 'configured-subset' }], choices: [{ source: 'saved-profile', providerId: profile.providerId, modelId: profile.modelId, voiceId: profile.voiceId, profileId: profile.id, label: profile.name }] } as never), { selection: 'profile', profileId: profile.id })
    expect(plan.selection).toEqual({ providerId: profile.providerId, modelId: profile.modelId, voiceId: profile.voiceId, profileId: profile.id })
    expect(plan.guards).toContain(profile.guard)
  })
  it('returns explicit unavailable rows for delegated subjects without granting a voice owner', () => {
    expect(projectConfiguredTts({ subject: { kind: 'subagent', id: 'a10' }, status: 'available', type: 'api' }, { __configuredTts: target() })).toMatchObject({ status: 'unavailable', reason: 'tts_primary_only' })
  })

  it('BL-1682 ignores an irrelevant global profile for provider planning and report projection', () => {
    const globalSelection = { ...selection, providerId: 'fish', profileId: 'missing_fish_profile' }
    const before = { ...selection, providerId: 'openai' }
    const base = target({ selection: before, globalSelection })
    const effective = resolveConfiguredTtsEffective(before, globalSelection, [], base.providers)
    expect(effective).toMatchObject({ providerId: 'openai', profileId: null, modelId: 'gpt-4o-mini-tts' })
    const plan = planConfiguredTtsSelection(base, { selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'alloy' })
    expect(plan.effectiveAfter).toMatchObject({ providerId: 'openai', profileId: null, voiceId: 'alloy' })
    expect(projectConfiguredTts({ subject: { kind: 'primary', id: 'a10' }, type: 'api', status: 'available' }, { __configuredTts: { ...base, effective } })).toMatchObject({ fields: { profileId: { effective: { state: 'unknown' }, source: 'none' } } })
  })

  it.each(['openai', null])('retains applicable profile inheritance with provider %s and guards missing applicable sources', providerId => {
    const profile = { id: 'openai_profile', providerId: 'openai', modelId: 'tts-1', voiceId: 'alloy', name: 'Saved' }
    const globalSelection = { ...selection, providerId, profileId: profile.id }
    const base = target({ globalSelection, profiles: [profile] } as never)
    const plan = planConfiguredTtsSelection(base, { selection: 'provider', providerId: 'openai', modelId: null, voiceId: null })
    expect(plan.effectiveAfter).toEqual({ providerId: 'openai', profileId: profile.id, modelId: 'tts-1', voiceId: 'alloy' })
    expect(() => planConfiguredTtsSelection(target({ globalSelection }), { selection: 'provider', providerId: 'openai', modelId: null, voiceId: null })).toThrow('tts_inherited_profile_source_unavailable')
  })
})

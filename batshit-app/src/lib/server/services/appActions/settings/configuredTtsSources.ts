import { resolveConfiguredTtsEffective } from '$lib/utils/configuredTtsEffective'
export { resolveConfiguredTtsEffective } from '$lib/utils/configuredTtsEffective'
import { readBuiltinVoiceCatalog } from '$lib/server/services/builtinVoiceCatalog'
import type { VoiceCatalogView } from '$lib/types/builtinVoiceCatalog'
import { createHash } from 'node:crypto'
import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import { redis } from '$lib/server/redis'
import { configuredBuiltinTtsCatalog } from '$lib/server/services/voiceService'
import { getOpenAITtsVoicesForModel } from '$lib/server/services/voiceModelCatalog'
import { getQwenAudioTtsVoices, isQwenAudioTtsModel, parseQwenAudioEndpoint, type QwenAudioRegion } from '$lib/data/qwenAudioTts'
import { readConfiguredVoiceEngineSelectionSource } from '$lib/server/services/voiceEngineRegistry'
import { readConfiguredVoiceProfiles } from '$lib/server/services/voiceProfileRecords'
import { isInternalDevPanelEnabled } from '$lib/server/internalDevPanel'
import { findPausedPlan } from '$lib/data/pausedPlans'
import { readAgentVoiceModelLockSource } from '$lib/server/modelVoiceSelectionSource'
import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'
import type { ConfiguredTtsSelection } from '$lib/appActions/settings/configuredTtsPreferences'
import { configuredTtsStoredSelection, readConfiguredTtsSnapshot, type TtsSourceGuard } from '$lib/server/configuredTtsGuard'
import { assertSettingsLifecycle, captureSettingsLifecycle } from './lifecycle'

type ChoiceSource = 'static' | 'saved-global' | 'saved-target' | 'saved-profile'
type Choice = Readonly<{ source: ChoiceSource; providerId: string; modelId: string | null; voiceId: string | null; profileId: string | null; label: string }>
type Provider = { id: string; label: string; configured: 'yes' | 'no' | 'unknown'; enabled: boolean; supportsTts: boolean; catalog: 'static-complete' | 'configured-subset'; models: string[]; voices: string[]; defaultModel: string | null; defaultVoice: string | null; guards: TtsSourceGuard[] }
const CREDENTIALS: Readonly<Record<string, readonly [string, readonly (keyof typeof env)[]][]>> = {
  openai: [['openai', ['OPENAI_API_KEY']]], google: [['google', ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']]],
  elevenlabs: [['elevenlabs', ['ELEVENLABS_API_KEY']]], deepgram: [['deepgram', ['DEEPGRAM_API_KEY']]], fish: [['fish', ['FISH_AUDIO_API_KEY', 'FISH_API_KEY']]],
  mistral: [['mistral', ['MISTRAL_API_KEY']]], minimax: [['minimax_token_plan', ['MINIMAX_TOKEN_PLAN_API_KEY']], ['minimax', ['MINIMAX_API_KEY']]],
  mimo: [['mimo_token_plan', ['MIMO_TOKEN_PLAN_API_KEY']], ['mimo', ['MIMO_API_KEY']]], alibaba: [['alibaba', ['ALIBABA_CLOUD_API_KEY', 'DASHSCOPE_API_KEY']]],
  inworld: [['inworld', ['INWORLD_API_KEY']]], cartesia: [['cartesia', ['CARTESIA_API_KEY']]], async: [['async', ['ASYNC_API_KEY']]],
  stepfun: [['stepfun', ['STEPFUN_API_KEY', 'STEP_API_KEY']]], azure: [['azure_speech_key', ['AZURE_SPEECH_KEY']], ['azure_speech_region', ['AZURE_SPEECH_REGION']]]
}
function environmentStamp() {
  const names = [...new Set(Object.values(CREDENTIALS).flatMap(entries => entries.flatMap(([, names]) => [...names])).concat(['BATSHIT_ENABLE_INTERNAL_DEV_PANEL', 'BATSHIT_INTERNAL_DEV_PANEL_SECRET']))].sort()
  const fingerprint = createHash('sha256')
  for (const name of names) {
    const value = env[name] ?? null
    if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16384)) throw new Error('tts_configured_environment_unavailable')
    fingerprint.update(JSON.stringify([name, value]))
  }
  return fingerprint.digest('hex')
}
const decoded = (raw: string) => { const values: unknown = JSON.parse(raw); if (!Array.isArray(values) || values.length > 1) throw new Error('tts_source_unavailable'); return values[0] }
async function fixedSource(key: string, path: string, limit = 16384) {
  const raw = await redis.json.getRaw(key, path) ?? '[]'
  if (Buffer.byteLength(raw, 'utf8') > limit) throw new Error('tts_source_unavailable')
  return { value: decoded(raw), guard: { key, path, raw } satisfies TtsSourceGuard }
}
async function globalTtsSource(userId: string) {
  const key = `user:${userId}:settings`
  const paths = ['providerId', 'provider', 'modelId', 'model', 'voiceId', 'profileId', 'providerOptions.fish.reference_id'].map(field => `$.voice_settings.tts.${field}`)
    .concat(['ttsProvider', 'ttsModel', 'ttsVoiceId'].map(field => `$.voice_settings.${field}`))
  const answer = await redis.execute(client => client.eval(`
local parent = redis.call('JSON.TYPE', KEYS[1], '$.voice_settings'); local nested = redis.call('JSON.TYPE', KEYS[1], '$.voice_settings.tts')
local out = {parent and parent[1] or '', nested and nested[1] or ''}
for _, path in ipairs(cjson.decode(ARGV[1])) do local raw = redis.call('JSON.GET', KEYS[1], path) or '[]'; if string.len(raw) > 1024 then return {'INVALID'} end; out[#out+1] = raw end
return out`, { keys: [key], arguments: [JSON.stringify(paths)] }))
  if (!Array.isArray(answer) || answer.length !== paths.length + 2 || !answer.every((value): value is string => typeof value === 'string') || !['', 'null', 'object'].includes(answer[0]) || !['', 'null', 'object'].includes(answer[1])) throw new Error('tts_global_source_unavailable')
  const settings: Record<string, unknown> = {}, tts: Record<string, unknown> = {}, guards: TtsSourceGuard[] = [
    { key, typePath: '$.voice_settings', type: answer[0] }, { key, typePath: '$.voice_settings.tts', type: answer[1] }]
  paths.forEach((path, index) => {
    const active = answer[1] === 'object' ? path.startsWith('$.voice_settings.tts.') : !path.startsWith('$.voice_settings.tts.')
    if (!active) return
    const raw = answer[index + 2], value = decoded(raw)
    guards.push({ key, path, raw })
    if (value === undefined) return
    if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error('tts_global_source_unavailable')
    if (path.endsWith('providerOptions.fish.reference_id')) tts.providerOptions = { fish: { reference_id: value } }
    else if (path.startsWith('$.voice_settings.tts.')) tts[path.slice('$.voice_settings.tts.'.length)] = value
    else settings[path.slice('$.voice_settings.'.length)] = value
  })
  if (answer[1] === 'object') settings.tts = tts
  return { settings, guards }
}
type WorkspaceRegion = QwenAudioRegion | 'invalid' | null
async function qwenWorkspaceSource(userId: string): Promise<{ globalAvailable: boolean; engineAvailable: boolean; global: WorkspaceRegion; engine: WorkspaceRegion; globalGuards: TtsSourceGuard[]; engineGuards: TtsSourceGuard[] }> {
  const key = `user:${userId}:settings`
  const paths = ['$.voice_settings.tts.common.endpoint', '$.voice_settings.ttsEngineSettings.alibaba.common.endpoint']
  const parents = ['$.voice_settings.tts.common', '$.voice_settings.ttsEngineSettings', '$.voice_settings.ttsEngineSettings.alibaba', '$.voice_settings.ttsEngineSettings.alibaba.common']
  try {
    const answer = await redis.execute(client => client.eval(`-- QWEN_TTS_ORIGINAL_WORKSPACE
local out = {}
for _, path in ipairs(cjson.decode(ARGV[1])) do local kind = redis.call('JSON.TYPE', KEYS[1], path); out[#out+1] = kind and kind[1] or '' end
for _, path in ipairs(cjson.decode(ARGV[2])) do local raw = redis.call('JSON.GET', KEYS[1], path) or '[]'; out[#out+1] = string.len(raw) > 1024 and 'INVALID' or raw end
return out`, { keys: [key], arguments: [JSON.stringify(parents), JSON.stringify(paths)] }))
    if (!Array.isArray(answer) || answer.length !== parents.length + paths.length || !answer.every((value): value is string => typeof value === 'string')) throw new Error('unavailable')
    const regions = answer.slice(parents.length).map(raw => {
      if (raw === 'INVALID') return 'invalid' as const
      const value = decoded(raw)
      if (value == null || value === '') return null
      if (typeof value !== 'string') return 'invalid' as const
      if (!value.trim()) return null
      try { return parseQwenAudioEndpoint(value).region } catch { return 'invalid' as const }
    })
    const parentGuards: TtsSourceGuard[] = parents.map((typePath, index) => ({ key, typePath, type: answer[index] }))
    const valueGuards: TtsSourceGuard[] = paths.map((path, index) => ({ key, path, fingerprint: createHash('sha1').update(answer[parents.length + index]).digest('hex'), byteLimit: 1024 }))
    return { globalAvailable: ['', 'null', 'object'].includes(answer[0]) && answer[parents.length] !== 'INVALID',
      engineAvailable: answer.slice(1, parents.length).every(value => ['', 'null', 'object'].includes(value)) && answer[parents.length + 1] !== 'INVALID',
      global: regions[0], engine: regions[1], globalGuards: [parentGuards[0], valueGuards[0]], engineGuards: [...parentGuards.slice(1), valueGuards[1]] }
  } catch { return { globalAvailable: false, engineAvailable: false, global: null, engine: null, globalGuards: [], engineGuards: [] } }
}
type ConfiguredTtsCatalog = { voiceCatalog: VoiceCatalogView; userId: string; global: Awaited<ReturnType<typeof globalTtsSource>>; qwenWorkspace: Awaited<ReturnType<typeof qwenWorkspaceSource>>; providers: Provider[]; registry: Awaited<ReturnType<typeof readConfiguredVoiceEngineSelectionSource>>; profileSource: Awaited<ReturnType<typeof readConfiguredVoiceProfiles>>; profileCount: number | null; environment: string }
export async function readConfiguredTtsTarget(userId: string, id: string, exactProfileId?: string, sharedCatalog?: ConfiguredTtsCatalog) {
  if (sharedCatalog && sharedCatalog.userId !== userId) throw new Error('tts_source_owner_changed')
  const snapshot = await redis.execute(client => readConfiguredTtsSnapshot(client, id))
  if (snapshot.record.user_id !== userId) throw new Error('tts_subject_unavailable')
  const selection = configuredTtsStoredSelection(snapshot), guards: TtsSourceGuard[] = [], environment = sharedCatalog?.environment ?? environmentStamp()
  const global = sharedCatalog?.global ?? await globalTtsSource(userId)
  const qwenWorkspace = sharedCatalog?.qwenWorkspace ?? await qwenWorkspaceSource(userId)
  const rawGlobalTts = global.settings.tts as Record<string, unknown> | undefined
  if (String(rawGlobalTts?.providerId ?? rawGlobalTts?.provider ?? global.settings.ttsProvider ?? '').trim().toLowerCase() === 'byo') throw new Error('tts_legacy_setup_not_migrated')
  const globalTts = normalizeVoiceSettings(global.settings).tts
  const globalSelection = Object.fromEntries(['providerId', 'modelId', 'voiceId', 'profileId'].map(field => [field, globalTts?.[field as keyof ConfiguredTtsSelection] ?? null])) as ConfiguredTtsSelection
  guards.push(...global.guards)
  let modelSource: Awaited<ReturnType<typeof readAgentVoiceModelLockSource>>
  try { modelSource = await redis.execute(client => readAgentVoiceModelLockSource(client, userId, id)) }
  catch (error) { throw new Error(error instanceof Error && error.message === 'tts_model_lock_ambiguous' ? error.message : 'tts_model_selection_unavailable') }
  const locked = modelSource.locked, modelLifecycles = [snapshot.lifecycle, modelSource.lifecycle]
  guards.push(...modelSource.guards)
  const voiceCatalog = sharedCatalog?.voiceCatalog ?? await readBuiltinVoiceCatalog()
  const providers: Provider[] = sharedCatalog?.providers ?? []
  for (const catalog of sharedCatalog ? [] : configuredBuiltinTtsCatalog(voiceCatalog)) {
    const evidence: TtsSourceGuard[] = [], configured: boolean[] = []
    let unreadable = false, tokenPlanSelected = false
    for (const [service, names] of CREDENTIALS[catalog.id] ?? []) {
      let saved: Awaited<ReturnType<typeof apiKeyService.readConfiguredState>>
      try { saved = await apiKeyService.readConfiguredState(service, userId) }
      catch { unreadable = true; configured.push(false); break }
      evidence.push({ key: saved.key, path: '$', raw: saved.raw })
      const present = saved.configured || names.some(name => Boolean(env[name]))
      configured.push(present); unreadable ||= !saved.readable && !names.some(name => Boolean(env[name]))
      if (service.endsWith('_token_plan') && present) tokenPlanSelected = true
      if (catalog.id !== 'azure' && present) break // Same saved/env and token-plan preference as Voice.
    }
    let present = catalog.id === 'browser' || (catalog.id === 'azure' ? configured.length === 2 && configured.every(Boolean) : configured.some(Boolean))
    if (catalog.id === 'mimo' && tokenPlanSelected && findPausedPlan('mimo_token_plan')) {
      const paused = await fixedSource('batshit:dev:paused_plans', '$.usePausedPlans', 32); evidence.push(paused.guard)
      if (!(isInternalDevPanelEnabled() && paused.value === true)) present = false
    }
    providers.push({ ...catalog, configured: present ? 'yes' : unreadable ? 'unknown' : 'no', enabled: true, supportsTts: true, guards: evidence })
  }
  let registry: Awaited<ReturnType<typeof readConfiguredVoiceEngineSelectionSource>>
  try { registry = sharedCatalog?.registry ?? await readConfiguredVoiceEngineSelectionSource(userId) }
  catch { registry = { engines: [], complete: false, guard: { key: `voice_engine_registry:${userId}`, path: '$', fingerprint: createHash('sha1').update('[]').digest('hex'), byteLimit: 262144 } } }
  for (const engine of sharedCatalog ? [] : registry.engines) providers.push({ id: engine.id, label: engine.label, configured: 'yes', enabled: engine.enabled, supportsTts: engine.supportsTts,
    catalog: 'configured-subset', models: engine.model ? [engine.model] : [], voices: engine.voices, defaultModel: engine.model, defaultVoice: engine.voice, guards: [registry.guard] })
  let profileSource: Awaited<ReturnType<typeof readConfiguredVoiceProfiles>>
  const applicableProfileId = resolveConfiguredTtsEffective(selection, globalSelection, [], []).profileId
  const usedProfileIds = [...new Set([applicableProfileId, exactProfileId].filter((value): value is string => Boolean(value)))]
  modelLifecycles.push(captureSettingsLifecycle(usedProfileIds.map(id => `voice_profile:${id}`)))
  let profileCount = sharedCatalog?.profileCount ?? null
  try { profileSource = sharedCatalog?.profileSource ?? await readConfiguredVoiceProfiles(userId, exactProfileId); profileCount = sharedCatalog ? profileCount : profileSource.count }
  catch (error) { const count = (error as { count?: unknown })?.count; profileCount = typeof count === 'number' && Number.isSafeInteger(count) ? count : null; profileSource = { profiles: [], count: 0, lifecycle: captureSettingsLifecycle([]), complete: false } }
  profileSource = { ...profileSource, profiles: [...profileSource.profiles], lifecycle: { epoch: profileSource.lifecycle.epoch, records: [...profileSource.lifecycle.records] } }
  for (const profileId of usedProfileIds) if (!profileSource.profiles.some(profile => profile.id === profileId)) {
    try {
      const exact = await readConfiguredVoiceProfiles(userId, profileId)
      profileSource.profiles.push(...exact.profiles); profileSource.lifecycle.records.push(...exact.lifecycle.records)
      profileCount = exact.count
    } catch { /* Missing/unreadable used profiles remain explicit source-unavailable at planning. */ }
  }
  const choices: Choice[] = []
  for (const provider of providers) {
    if (provider.configured !== 'yes' || !provider.enabled || !provider.supportsTts) continue
    for (const voiceId of provider.voices) choices.push({ source: 'static', providerId: provider.id, modelId: null, voiceId, profileId: null, label: voiceId })
    if (provider.defaultVoice) choices.push({ source: 'static', providerId: provider.id, modelId: provider.defaultModel, voiceId: provider.defaultVoice, profileId: null, label: provider.defaultVoice })
  }
  for (const [source, saved] of [['saved-global', globalSelection], ['saved-target', selection]] as const) if (saved.providerId && saved.voiceId) choices.push({ source, ...saved, providerId: saved.providerId, label: saved.voiceId })
  for (const profile of profileSource.profiles) choices.push({ source: 'saved-profile', providerId: profile.providerId, modelId: profile.modelId, voiceId: profile.voiceId, label: profile.name, profileId: profile.id })
  // Do not leak the private profile raw guard/membership by spreading profile objects into DTOs.
  const publicChoices: Choice[] = choices.map(choice => ({ source: choice.source, providerId: choice.providerId, modelId: choice.modelId, voiceId: choice.voiceId, profileId: choice.profileId, label: choice.label.slice(0, 200) }))
  const sourceLifecycle = { epoch: snapshot.lifecycle.epoch, records: modelLifecycles.flatMap(item => item.records) }
  sourceLifecycle.records.push(...profileSource.lifecycle.records.filter(([key]) => usedProfileIds.some(id => key === `voice_profile:${id}`)))
  modelLifecycles.forEach(assertSettingsLifecycle)
  assertSettingsLifecycle(profileSource.lifecycle)
  assertSettingsLifecycle(snapshot.lifecycle)
  const providerId = selection.providerId ?? globalSelection.providerId ?? 'browser', provider = providers.find(item => item.id === providerId)
  const effective = resolveConfiguredTtsEffective(selection, globalSelection, profileSource.profiles, providers)
  if (provider) guards.push(...provider.guards)
  for (const id of [effective.profileId]) {
    const dependency = profileSource.profiles.find(profile => profile.id === id)
    if (dependency) guards.push(dependency.guard, ...(dependency.metadataGuards ?? []), dependency.membership)
  }
  return { snapshot, selection, globalSelection, effective, locked, providers, profiles: profileSource.profiles, choices: publicChoices, guards, sourceLifecycle,
    catalog: { voiceCatalog, userId, global, qwenWorkspace, providers, registry, profileSource, profileCount, environment },
    complete: registry.complete && profileSource.complete, environment,
    checkEnvironment() { if (environmentStamp() !== environment) throw new Error('tts_configured_environment_changed'); assertSettingsLifecycle(sourceLifecycle) } }
}
export type ConfiguredTtsTarget = Awaited<ReturnType<typeof readConfiguredTtsTarget>>
export function configuredQwenWorkspace(target: ConfiguredTtsTarget, profileId: string | null): { region: QwenAudioRegion; guards: TtsSourceGuard[] } | null {
  const source = target.catalog.qwenWorkspace
  if (!source) return null
  const globalApplies = target.globalSelection.providerId === null || target.globalSelection.providerId === 'alibaba'
  const profile = profileId ? target.profiles.find(item => item.id === profileId) : undefined
  if (profileId && (!profile || profile.qwenEndpointRegion === undefined)) return null
  if (profile?.qwenEndpointRegion) return profile.qwenEndpointRegion === 'invalid' ? null : { region: profile.qwenEndpointRegion, guards: [] }
  if (!source.engineAvailable || source.engine === 'invalid') return null
  if (source.engine) return { region: source.engine, guards: source.engineGuards }
  if (!globalApplies || !source.globalAvailable || !source.global || source.global === 'invalid') return null
  return { region: source.global, guards: [...source.engineGuards, ...source.globalGuards] }
}
export function configuredTtsChoices(target: ConfiguredTtsTarget, query: { ttsProviderId?: string; ttsModelId?: string; ttsProfileId?: string; ttsOffset?: number } = {}) {
  const choices = target.choices.filter(choice => (!query.ttsProviderId || choice.providerId === query.ttsProviderId) && (!query.ttsModelId || choice.modelId === null || choice.modelId === query.ttsModelId) && (!query.ttsProfileId || choice.profileId === query.ttsProfileId) &&
    !(query.ttsModelId && choice.source === 'static' && choice.voiceId && !configuredTtsProviderVoices(target, choice.providerId, query.ttsModelId).includes(choice.voiceId)))
  if (query.ttsProviderId === 'stepfun' && query.ttsModelId === 'stepaudio-3-tts' && target.providers.some(provider => provider.id === 'stepfun' && provider.models.includes('stepaudio-3-tts')) && !query.ttsProfileId && !choices.some(choice => choice.voiceId === 'zixinnansheng')) {
    choices.push({ source: 'static', providerId: 'stepfun', modelId: 'stepaudio-3-tts', voiceId: 'zixinnansheng', profileId: null, label: 'zixinnansheng' })
  }
  if (query.ttsProviderId === 'alibaba' && query.ttsModelId && isQwenAudioTtsModel(query.ttsModelId) && !query.ttsProfileId && target.providers.some(provider => provider.id === 'alibaba' && provider.configured === 'yes' && provider.models.includes(query.ttsModelId!))) {
    const proposal = { providerId: 'alibaba', modelId: query.ttsModelId, voiceId: null, profileId: null }
    const workspace = configuredQwenWorkspace(target, resolveConfiguredTtsEffective(proposal, target.globalSelection, target.profiles, target.providers).profileId)
    if (workspace) for (const voiceId of getQwenAudioTtsVoices(query.ttsModelId, workspace.region)) if (!choices.some(choice => choice.voiceId === voiceId)) choices.push({ source: 'static', providerId: 'alibaba', modelId: query.ttsModelId, voiceId, profileId: null, label: voiceId })
  }
  const providers = target.providers.filter(provider => !query.ttsProviderId || provider.id === query.ttsProviderId).map(({ id, label, configured, enabled, supportsTts, catalog, models, defaultModel, defaultVoice }) => ({ id, label: label.slice(0, 200), configured, enabled, supportsTts, catalog, models, defaultModel, defaultVoice,
    ...(configured === 'unknown' ? { reason: 'source_unreadable' } : configured === 'no' ? { reason: 'not_configured' } : !enabled ? { reason: 'disabled' } : !supportsTts ? { reason: 'not_tts' } : {}) }))
  // One immutable finite sequence pages provider metadata and voice/profile choices together.
  const items = [...providers.map(value => ({ kind: 'provider' as const, value })), ...choices.map(value => ({ kind: 'choice' as const, value }))]
  const offset = query.ttsOffset ?? 0
  if (offset > items.length) throw new Error('tts_choice_offset_unavailable')
  const selected: typeof items = []
  const build = () => ({ providers: selected.flatMap(item => item.kind === 'provider' ? [item.value] : []), choices: selected.flatMap(item => item.kind === 'choice' ? [item.value] : []),
    unavailableSources: [...(!target.catalog.registry.complete ? ['engine_registry_incomplete'] : []), ...(!target.catalog.profileSource.complete ? ['saved_profiles_incomplete'] : [])],
    count: items.length, providerCount: providers.length, choiceCount: choices.length, savedProfileCount: target.catalog.profileCount, returned: selected.length, complete: target.complete, nextOffset: offset + selected.length < items.length ? offset + selected.length : null })
  for (const item of items.slice(offset, offset + 32)) { selected.push(item); if (Buffer.byteLength(JSON.stringify(build()), 'utf8') > 8192) { selected.pop(); break } }
  if (!selected.length && offset < items.length) throw new Error('tts_choice_row_exceeds_budget')
  return build()
}
export function configuredTtsProviderVoices(target: ConfiguredTtsTarget, providerId: string, modelId: string | null) {
  const provider = target.providers.find(provider => provider.id === providerId)
  if (providerId === 'stepfun' && modelId === 'stepaudio-3-tts') return ['zixinnansheng']
  if (providerId === 'alibaba' && modelId && isQwenAudioTtsModel(modelId)) {
    const proposal = { providerId, modelId, voiceId: null, profileId: null }
    const workspace = configuredQwenWorkspace(target, resolveConfiguredTtsEffective(proposal, target.globalSelection, target.profiles, target.providers).profileId)
    return workspace ? [...getQwenAudioTtsVoices(modelId, workspace.region)] : []
  }
  if (providerId !== 'openai') return provider?.voices ?? []
  const model = modelId ?? provider?.defaultModel
  return model && provider?.models.includes(model) ? getOpenAITtsVoicesForModel(model) : []
}

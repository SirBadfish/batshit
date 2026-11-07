import { configuredTtsCatalogDependency, checkConfiguredTtsCatalogDependency } from './configuredTtsCatalogDependency'
import { CONFIGURED_TTS_FIELDS, CONFIGURED_TTS_SEMANTIC_ID, validateConfiguredTtsChanges, type ConfiguredTtsSelection } from '$lib/appActions/settings/configuredTtsPreferences'
import type { SettingsReportValue } from '$lib/appActions/settings/reportContract'
import type { SettingsSubjectEntry } from './subjects'
import type { Group } from './scalarProjection'
import { configuredQwenWorkspace, configuredTtsProviderVoices, resolveConfiguredTtsEffective, type ConfiguredTtsTarget } from './configuredTtsSources'
import type { HeldConfiguredFishChoice } from './configuredTtsAccountPaging'
import { getQwenAudioTtsVoices, isQwenAudioTtsModel } from '$lib/data/qwenAudioTts'
export function projectConfiguredTts(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  if (entry.subject.kind !== 'primary' || entry.type !== 'api') return { id: CONFIGURED_TTS_SEMANTIC_ID, status: 'unavailable', reason: 'tts_primary_only' }
  const target = record.__configuredTts as ConfiguredTtsTarget | undefined
  if (!target) return { id: CONFIGURED_TTS_SEMANTIC_ID, status: 'unavailable', reason: typeof record.__configuredTtsUnavailable === 'string' ? record.__configuredTtsUnavailable : 'tts_source_unavailable' }
  const rawProfile = target.snapshot?.record.voice_profile as Record<string, unknown> | null | undefined
  const rawTts = rawProfile?.tts && typeof rawProfile.tts === 'object' ? rawProfile.tts as Record<string, unknown> : rawProfile ?? {}
  const provenance = (field: 'modelId' | 'voiceId') => target.selection[field] !== null ? 'agent' :
    (target.globalSelection.providerId === null || target.globalSelection.providerId === target.effective.providerId) && target.globalSelection[field] !== null ? 'global' :
    target.profiles.some(profile => profile.id === target.effective.profileId && profile[field] !== null) ? 'saved-profile' :
    target.effective[field] === null ? 'unknown' : target.effective.providerId?.startsWith('byo:') ? 'engine-default' : 'builtin-default'
  const fields: Record<string, SettingsReportValue> = Object.fromEntries(CONFIGURED_TTS_FIELDS.map(field => {
    const legacy = field === 'providerId' ? 'provider' : field === 'modelId' ? 'model' : field
    const storedKey = Object.hasOwn(rawTts, field) ? field : legacy
    const raw = rawTts[storedKey], effective = target.effective[field]
    const origin = field === 'modelId' || field === 'voiceId' ? provenance(field) : target.selection[field] !== null ? 'agent' :
      (target.globalSelection.providerId === null || target.globalSelection.providerId === target.effective.providerId) && target.globalSelection[field] !== null ? 'global' : field === 'providerId' ? 'builtin-default' : 'unknown'
    return [field, { stored: !Object.hasOwn(rawTts, storedKey) ? { state: 'unset' } : raw === null || typeof raw === 'string' ? { state: 'set', value: raw } : { state: 'invalid' },
      effective: effective === null ? { state: 'unknown', reason: 'tts_default_not_known' } : { state: 'known', value: effective },
      source: origin === 'agent' || origin === 'global' ? origin : origin === 'builtin-default' ? 'factory' : 'none' } satisfies SettingsReportValue]
  }))
  const kind = target.selection.profileId !== null ? 'profile' : CONFIGURED_TTS_FIELDS.some(field => target.selection[field] !== null) ? 'provider' : 'inherit'
  fields.selection = { stored: { state: 'unset' }, effective: { state: 'known', value: kind }, source: 'none' }
  for (const field of ['modelId', 'voiceId'] as const) fields[field === 'modelId' ? 'modelSource' : 'voiceSource'] = { stored: { state: 'unset' }, effective: { state: 'known', value: provenance(field) }, source: 'none' }
  fields.speechToSpeechLocked = { stored: { state: 'unset' }, effective: { state: 'known', value: target.locked }, source: 'none' }
  fields.configuration = { stored: { state: 'unset' }, effective: { state: 'known', value: target.providers.find(provider => provider.id === target.effective.providerId)?.configured ?? 'unknown' }, source: 'none' }
  return { id: CONFIGURED_TTS_SEMANTIC_ID, status: 'available', fields: Object.freeze(fields) }
}
export function planConfiguredTtsSelection(target: ConfiguredTtsTarget, input: unknown, heldAccount?: HeldConfiguredFishChoice) {
  const changes = validateConfiguredTtsChanges(input)
  if (target.locked) throw new Error('tts_speech_to_speech_locked')
  let selection: ConfiguredTtsSelection
  let accountChoice: HeldConfiguredFishChoice | undefined
  const guards = [...target.guards]
  if (changes.selection === 'inherit') selection = { providerId: null, modelId: null, voiceId: null, profileId: null }
  else if (changes.selection === 'profile') {
    const profile = target.profiles.find(profile => profile.id === changes.profileId)
    if (!profile) throw new Error('tts_profile_source_unavailable')
    selection = { providerId: profile.providerId, modelId: profile.modelId, voiceId: profile.voiceId, profileId: profile.id }
    guards.push(profile.guard, ...(profile.metadataGuards ?? []), profile.membership)
  } else selection = { providerId: changes.providerId, modelId: changes.modelId, voiceId: changes.voiceId, profileId: null }
  const effectiveAfter = resolveConfiguredTtsEffective(selection, target.globalSelection, target.profiles, target.providers)
  const unchanged = CONFIGURED_TTS_FIELDS.every(field => target.selection[field] === selection[field])
  const qwenModel = effectiveAfter.providerId === 'alibaba' && effectiveAfter.modelId && isQwenAudioTtsModel(effectiveAfter.modelId) ? effectiveAfter.modelId : null
  const workspace = qwenModel && !unchanged ? configuredQwenWorkspace(target, effectiveAfter.profileId) : null
  if (qwenModel && !unchanged) {
    if (!workspace) throw new Error('tts_qwen_audio_workspace_selection_unavailable')
    if (!effectiveAfter.voiceId || !getQwenAudioTtsVoices(qwenModel, workspace.region).includes(effectiveAfter.voiceId)) throw new Error('tts_profile_voice_incompatible')
    guards.push(...workspace.guards)
  }
  if (!unchanged && effectiveAfter.providerId === 'stepfun' && effectiveAfter.modelId === 'stepaudio-3-tts' && effectiveAfter.voiceId !== 'zixinnansheng') {
    throw new Error('tts_profile_voice_incompatible')
  }
  const inheritedProfile = effectiveAfter.profileId
  if (inheritedProfile && !target.profiles.some(profile => profile.id === inheritedProfile)) throw new Error('tts_inherited_profile_source_unavailable')
  const dependency = target.profiles.find(profile => profile.id === inheritedProfile)
  if (dependency) guards.push(dependency.guard, ...(dependency.metadataGuards ?? []), dependency.membership)
  const sourceLifecycle = { epoch: target.sourceLifecycle.epoch,
    records: [...target.sourceLifecycle.records, ...target.catalog.profileSource.lifecycle.records.filter(([key]) => key === `voice_profile:${inheritedProfile}`)] }
  if (selection.providerId !== null) {
    const provider = target.providers.find(provider => provider.id === selection.providerId)
    if (!provider || provider.configured !== 'yes' || !provider.enabled || !provider.supportsTts) throw new Error('tts_provider_not_configured')
    guards.push(...provider.guards)
    if (selection.modelId !== null && !(provider.id === 'deepgram' && effectiveAfter.voiceId) && !provider.models.includes(selection.modelId) && !(provider.id.startsWith('byo:') && target.choices.some(choice => choice.providerId === selection.providerId && choice.modelId === selection.modelId))) throw new Error('tts_model_not_configured')
    if (changes.selection === 'profile' && !qwenModel && provider.catalog === 'static-complete' && selection.voiceId !== null && !configuredTtsProviderVoices(target, provider.id, effectiveAfter.modelId).includes(selection.voiceId)) throw new Error('tts_profile_voice_incompatible')
    if (changes.selection === 'provider' && selection.voiceId !== null) {
      const staticMatch = qwenModel && workspace ? getQwenAudioTtsVoices(qwenModel, workspace.region).includes(selection.voiceId) : configuredTtsProviderVoices(target, selection.providerId, effectiveAfter.modelId).includes(selection.voiceId)
      const savedMatch = !qwenModel && selection.providerId !== 'openai' && target.choices.some(choice => choice.source !== 'saved-profile' && choice.providerId === selection.providerId && choice.voiceId === selection.voiceId && (choice.modelId === effectiveAfter.modelId || choice.modelId === null))
      if (!staticMatch && !savedMatch) {
        const accountMatch = selection.providerId === 'fish' && heldAccount?.subject.kind === 'primary' && heldAccount.subject.id === target.snapshot.id &&
          heldAccount.choice.providerId === 'fish' && heldAccount.choice.voiceId === selection.voiceId && heldAccount.source.providerId === 'fish' &&
          provider.guards.some(guard => 'raw' in guard && guard.key === heldAccount.source.credential.key && guard.path === '$' && guard.raw === heldAccount.source.credential.raw)
        if (!accountMatch || !heldAccount) throw new Error('tts_voice_catalog_source_unavailable')
        accountChoice = heldAccount
        guards.push({ key: heldAccount.source.credential.key, path: '$', raw: heldAccount.source.credential.raw })
      }
    }
  }
  const resultingProvider = effectiveAfter.providerId
  if (inheritedProfile && target.profiles.find(profile => profile.id === inheritedProfile)?.providerId !== resultingProvider) throw new Error('tts_inherited_profile_incompatible')
  const resultingProviderSource = target.providers.find(provider => provider.id === resultingProvider)
  if (resultingProviderSource) guards.push(...resultingProviderSource.guards)
  const catalogDependency = configuredTtsCatalogDependency(target.catalog.voiceCatalog, effectiveAfter)
  if (catalogDependency) guards.push(...catalogDependency)
  target.checkEnvironment()
  return Object.freeze({ selection: Object.freeze(selection), effectiveAfter, sourceLifecycle, guards: Object.freeze(guards), unchanged, catalogDependency,
    checkCatalog() { checkConfiguredTtsCatalogDependency(catalogDependency, effectiveAfter) },
    ...(accountChoice ? { accountChoice } : {}) })
}

import type { ConfiguredTtsSelection } from '../appActions/settings/configuredTtsPreferences'
import type { VoiceProfileRecord, VoiceProviderSummary, VoiceTtsConfig } from '../types/voice'
import { normalizeAgentVoiceProfile, normalizeVoiceProviderId, normalizeVoiceSettings, normalizeVoiceTtsConfig } from './voiceSchema'
import { resolveConfiguredTtsEffective } from './configuredTtsEffective'
import { voiceProviderModelProfile } from './builtinVoiceCatalogProjection'

/** Display the installed transport for a model; this does not grant catalog admission. */
export function voiceTtsModelStreams(provider: VoiceProviderSummary | null | undefined, modelId?: string | null): boolean {
  if (!provider) return false
  const model = modelId?.trim()
  if (provider.id === 'inworld' && model === 'inworld-tts-2-flash') return false
  if (voiceProviderModelProfile(provider, 'tts-direct-stream', model)) return true
  if (voiceProviderModelProfile(provider, 'tts-batch', model)) return false
  return provider.supports.streaming
}

/** Read-only applicability uses the same selection precedence as configured TTS, never a form write. */
export function resolveVoiceTtsDisplaySelection(agentValue: unknown, globalValue: unknown,
  profiles: readonly VoiceProfileRecord[], providers: readonly VoiceProviderSummary[]): ConfiguredTtsSelection {
  const own = normalizeAgentVoiceProfile(agentValue)?.tts
  const global = normalizeVoiceSettings(globalValue).tts
  const selection = (value?: VoiceTtsConfig): ConfiguredTtsSelection => ({ providerId: value?.providerId ?? null, modelId: value?.modelId ?? null,
    voiceId: value?.voiceId ?? null, profileId: value?.profileId ?? null })
  const providerId = own?.providerId ?? global?.providerId ?? 'browser'
  const compatibleProfiles = profiles.filter(profile => normalizeVoiceProviderId(profile.provider) === providerId).map(profile => ({
    id: profile.id, modelId: profile.model?.trim() || null, voiceId: profile.voiceId?.trim() || ''
  }))
  return resolveConfiguredTtsEffective(selection(own), selection(global), compatibleProfiles,
    providers.map(provider => ({ id: provider.id, defaultModel: provider.defaultTtsModel ?? provider.defaultModel ?? null, defaultVoice: provider.defaultVoice ?? null })))
}

/** Follow runtime endpoint precedence without saving or inventing a region. */
export function resolveVoiceTtsDisplayEndpoint(selection: ConfiguredTtsSelection, globalValue: unknown,
  profiles: readonly VoiceProfileRecord[]): string | null {
  const global = normalizeVoiceSettings(globalValue)
  if (!selection.providerId) return null
  const profile = selection.profileId ? profiles.find(item => item.id === selection.profileId && normalizeVoiceProviderId(item.provider) === selection.providerId) : undefined
  if (selection.profileId && !profile) return null
  const profileOptions = profile ? normalizeVoiceTtsConfig({ providerId: selection.providerId, common: profile.settings?.common }) : undefined
  const applicableGlobal = !global.tts?.providerId || global.tts.providerId === selection.providerId
  return profileOptions?.common?.endpoint ?? global.ttsEngineSettings?.[selection.providerId]?.common?.endpoint ??
    (applicableGlobal ? global.tts?.common?.endpoint : undefined) ?? null
}

import type { ConfiguredTtsSelection } from '../appActions/settings/configuredTtsPreferences'

export function resolveConfiguredTtsEffective(selection: ConfiguredTtsSelection, global: ConfiguredTtsSelection,
  profiles: readonly { id: string; modelId: string | null; voiceId: string }[], providers: readonly { id: string; defaultModel: string | null; defaultVoice: string | null }[]): ConfiguredTtsSelection {
  const providerId = selection.providerId ?? global.providerId ?? 'browser', provider = providers.find(provider => provider.id === providerId)
  const matches = (value: ConfiguredTtsSelection) => value.providerId === null || value.providerId === providerId
  const profileId = (matches(selection) ? selection.profileId : null) ?? (matches(global) ? global.profileId : null), profile = profiles.find(profile => profile.id === profileId)
  const profileUnknown = profileId !== null && !profile
  return { providerId, profileId, modelId: (matches(selection) ? selection.modelId : null) ?? (matches(global) ? global.modelId : null) ?? profile?.modelId ?? (profileUnknown ? null : provider?.defaultModel) ?? null,
    voiceId: (matches(selection) ? selection.voiceId : null) ?? (matches(global) ? global.voiceId : null) ?? profile?.voiceId ?? (profileUnknown ? null : provider?.defaultVoice) ?? null }
}

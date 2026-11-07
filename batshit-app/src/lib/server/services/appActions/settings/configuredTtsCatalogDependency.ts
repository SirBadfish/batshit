import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import type { BuiltinVoiceLane, BuiltinVoiceProviderId, VoiceCatalogView } from '$lib/types/builtinVoiceCatalog'
import type { ConfiguredTtsSelection } from '$lib/appActions/settings/configuredTtsPreferences'
import { effectiveVoiceCatalogModel } from '$lib/utils/builtinVoiceCatalogProjection'
import { sameVoiceCatalogSelection, voiceCatalogSelectionGuard } from '$lib/server/voiceCatalogSelectionGuard'
import { peekBuiltinVoiceCatalog } from '$lib/server/services/builtinVoiceCatalog'

export function configuredTtsCatalogDependency(view: VoiceCatalogView, selection: ConfiguredTtsSelection) {
  const providerId = selection.providerId as BuiltinVoiceProviderId
  if (!providerId || providerId === 'browser' || !BUILTIN_VOICE_PROVIDER_IDS.includes(providerId) || !selection.modelId) return null
  if (!view) throw new Error('tts_catalog_compatibility_unavailable')
  const lanes: BuiltinVoiceLane[] = providerId === 'fish' ? ['tts-direct-stream'] : providerId === 'inworld' ? ['tts-batch', 'tts-direct-stream'] : ['tts-batch']
  return lanes.map(lane => voiceCatalogSelectionGuard(view, providerId, lane, effectiveVoiceCatalogModel(providerId, selection.modelId!, selection.voiceId)))
}

export function checkConfiguredTtsCatalogDependency(expected: ReturnType<typeof configuredTtsCatalogDependency>, selection: ConfiguredTtsSelection) {
  if (!expected) return
  const current = configuredTtsCatalogDependency(peekBuiltinVoiceCatalog(), selection)
  if (!current || expected.length !== current.length || expected.some((source, index) => !sameVoiceCatalogSelection(source.voiceCatalog, current[index].voiceCatalog))) throw new Error('tts_catalog_compatibility_changed')
}

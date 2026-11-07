import { redis } from '$lib/server/redis'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import type { BuiltinVoiceLane, BuiltinVoiceProviderId } from '$lib/types/builtinVoiceCatalog'
import { effectiveVoiceCatalogModel, selectedVoiceCatalogCompatibility } from '$lib/utils/builtinVoiceCatalogProjection'
import { createBuiltinVoiceCatalogReader } from './builtinVoiceCatalogCache'
import { createLocalVoiceCatalogStore } from './builtinVoiceCatalogStore'
import { fetchPublicVoiceCatalog } from './builtinVoiceCatalogRemote'
import { VoiceCatalogCompatibilityError } from './builtinVoiceCatalogErrors'

const reader = createBuiltinVoiceCatalogReader({ store: createLocalVoiceCatalogStore(operation => redis.execute(operation)),
  fetchSnapshot: () => fetchPublicVoiceCatalog(fetch) })

export function readBuiltinVoiceCatalog() { return reader.readCurrent() }
export function peekBuiltinVoiceCatalog() { return reader.peekCurrent() }
export function refreshBuiltinVoiceCatalog(force = false) { return reader.refresh(force) }

/** Speech dispatch reads admitted local state only. Custom IDs keep their existing owner. */
export async function assertBuiltinVoiceCatalogModel(provider: string, lane: BuiltinVoiceLane, model: string | null | undefined, voice?: string | null) {
  if (provider === 'browser' || !BUILTIN_VOICE_PROVIDER_IDS.includes(provider as BuiltinVoiceProviderId) || !model) return
  const providerId = provider as BuiltinVoiceProviderId
  const selected = selectedVoiceCatalogCompatibility(await readBuiltinVoiceCatalog(), providerId, lane, effectiveVoiceCatalogModel(providerId, model, voice))
  if (selected.state === 'compatible' || selected.state === 'unlisted') {
    const facts = selected.facts ? JSON.parse(selected.facts) as { compatibilityProfileId?: string | null } : null
    return { compatibilityProfileId: facts?.compatibilityProfileId ?? null }
  }
  throw new VoiceCatalogCompatibilityError(selected.state === 'unavailable'
    ? 'Voice model compatibility could not be read. Your saved selection is kept. Refresh the voice model list before trying again.'
    : `The saved voice model "${model}" is unavailable until its compatibility is confirmed. Your selection is kept.`)
}

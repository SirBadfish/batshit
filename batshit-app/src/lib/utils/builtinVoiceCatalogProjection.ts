import { BUILTIN_VOICE_CATALOG_CONTEXT, BUILTIN_VOICE_PROVIDER_IDS } from '../data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogEntry, BuiltinVoiceLane, BuiltinVoiceProviderId, VoiceCatalogView } from '../types/builtinVoiceCatalog'
import { voiceCatalogCompatibilityFacts, voiceCatalogEntryCompatibility } from './builtinVoiceCatalog'
import type { VoiceProviderSummary } from '../types/voice'
import { isVoiceProviderLifecycleWarning } from './voiceProviderEnvelope'
import { DEEPGRAM_LEGACY_VOICE_BINDINGS } from '../data/deepgramVoiceCatalog'

export function bundledVoiceCatalogEntries(providerId: BuiltinVoiceProviderId): BuiltinVoiceCatalogEntry[] {
  return BUILTIN_VOICE_CATALOG_CONTEXT.baseline.filter(row => row.providerId === providerId).map(row => ({
    modelId: row.modelId, label: row.modelId, lane: row.lane, admission: row.admission,
    ...(row.compatibilityProfileId ? { compatibilityProfileId: row.compatibilityProfileId } : {}),
    qualifiedAt: null, provenance: 'bundled-legacy', evidenceUrls: [], release: 'unknown'
  }))
}

/** Detached metadata only: never changes provider configuration, defaults or a saved/draft tuple. */
export function projectBuiltinVoiceCatalog(view: VoiceCatalogView, nowMs: number) {
  return BUILTIN_VOICE_PROVIDER_IDS.map(providerId => {
    const provider = view.snapshot?.providers[providerId]
    const sourceStatus: NonNullable<VoiceProviderSummary['modelCatalog']>['sourceStatus'] = provider?.sourceStatus ?? (providerId === 'browser' ? 'runtime-owned' : 'bundled')
    const entries = provider?.entries ?? bundledVoiceCatalogEntries(providerId)
    const compatibilityProfiles: Record<string, Record<string, string>> = Object.create(null)
    if (view.source !== 'unavailable') for (const entry of entries) {
      if (!entry.compatibilityProfileId || !voiceCatalogEntryCompatibility(providerId, entry).compatible) continue
      const lane = compatibilityProfiles[entry.lane] ??= Object.create(null)
      lane[entry.modelId] = entry.compatibilityProfileId
    }
    const models = (lane: BuiltinVoiceLane) => view.source === 'unavailable' ? [] : entries.filter(entry =>
      entry.lane === lane && voiceCatalogEntryCompatibility(providerId, entry).compatible).map(entry => entry.modelId)
    return {
      providerId, models: { 'tts-batch': models('tts-batch'), 'tts-direct-stream': models('tts-direct-stream'),
        'stt-recorded': models('stt-recorded'), 'stt-direct-realtime': models('stt-direct-realtime') },
      entries: structuredClone(entries), compatibilityProfiles,
      lifecycleWarnings: entries.filter(entry => entry.shutdownAt || entry.release === 'deprecated').map(entry => ({
        modelId: entry.modelId, lane: entry.lane, release: entry.release, ...(entry.shutdownAt ? { shutdownAt: entry.shutdownAt } : {})
      })), source: view.source, warning: view.warning,
      sourceStatus, failure: provider?.failure,
      lastVerifiedAt: provider?.lastVerifiedAt ?? null, lastAttemptAt: provider?.lastAttemptAt ?? null,
      stale: providerId !== 'browser' && (!provider?.lastVerifiedAt || nowMs - Date.parse(provider.lastVerifiedAt) > 24 * 60 * 60_000),
      discoveryCoverage: provider?.discoveryCoverage ?? (providerId === 'browser' ? 'not-applicable' : 'unknown'),
      qualificationCoverage: provider?.qualificationCoverage ?? (providerId === 'browser' ? 'not-applicable' : 'pending'),
      unavailableCount: view.source === 'unavailable' ? entries.length : entries.filter(entry => !voiceCatalogEntryCompatibility(providerId, entry).compatible).length
    }
  })
}

/** Deepgram executes the explicit voice selector before the model selector. */
export function effectiveVoiceCatalogModel(providerId: BuiltinVoiceProviderId, modelId: string, voiceId?: string | null): string {
  return providerId === 'deepgram' && voiceId ? voiceId : modelId
}

/** Exact existing public selectors only. Deepgram voice IDs are also backend model selectors. */
export function legacyVoiceCatalogSelection(providerId: BuiltinVoiceProviderId, lane: BuiltinVoiceLane, modelId: string): BuiltinVoiceCatalogEntry | undefined {
  const bundled = bundledVoiceCatalogEntries(providerId).find(entry => entry.lane === lane && entry.modelId === modelId && entry.admission === 'qualified')
  if (bundled) return bundled
  const voice = providerId === 'deepgram' && lane === 'tts-batch' ? DEEPGRAM_LEGACY_VOICE_BINDINGS.find(row => row.modelId === modelId) : undefined
  return voice ? { modelId, label: modelId, lane, admission: 'qualified', compatibilityProfileId: voice.compatibilityProfileId,
    qualifiedAt: null, provenance: 'bundled-legacy', evidenceUrls: [], release: 'unknown' } : undefined
}

export function selectedVoiceCatalogCompatibility(view: VoiceCatalogView, providerId: BuiltinVoiceProviderId,
  lane: BuiltinVoiceLane, modelId: string) {
  if (view.source === 'unavailable') return { state: 'unavailable' as const, facts: null }
  const entries = view.snapshot?.providers[providerId].entries ?? bundledVoiceCatalogEntries(providerId)
  let entry = entries.find(entry => entry.lane === lane && entry.modelId === modelId)
  // Known changed contracts cannot use the legacy custom-ID fallback before
  // their first source-qualified publication reaches this installation.
  if (!entry) entry = bundledVoiceCatalogEntries(providerId).find(row => row.lane === lane && row.modelId === modelId && row.admission === 'candidate')
  const legacy = legacyVoiceCatalogSelection(providerId, lane, modelId)
  if (legacy && (!entry || !entry.qualificationRuleId && entry.admission === 'candidate' && (!entry.blockedReason || entry.blockedReason === 'qualification-required') &&
    (!entry.compatibilityProfileId || entry.compatibilityProfileId === legacy.compatibilityProfileId))) entry = legacy
  // Custom IDs remain saved/custom; absence does not grant a compiled profile or retire them.
  if (!entry) return { state: 'unlisted' as const, facts: null }
  const compatibility = voiceCatalogEntryCompatibility(providerId, entry)
  return { state: compatibility.compatible ? 'compatible' as const : entry.admission === 'blocked' ? 'blocked' as const : 'candidate' as const,
    reason: compatibility.reason, facts: voiceCatalogCompatibilityFacts(providerId, entry) }
}

export function projectVoiceProviderSummaries(base: readonly VoiceProviderSummary[], view: VoiceCatalogView, nowMs: number): VoiceProviderSummary[] {
  const projections = projectBuiltinVoiceCatalog(view, nowMs)
  return base.map(provider => {
    const projected = projections.find(row => row.providerId === provider.id)
    if (!projected) return structuredClone(provider)
    const { models, entries: _entries, providerId: _provider, ...modelCatalog } = projected
    return { ...structuredClone(provider), ...(provider.id === 'browser' ? {} : {
      ttsModels: [...new Set([...models['tts-batch'], ...models['tts-direct-stream']])],
      sttModels: models['stt-recorded'], realtimeSttModels: models['stt-direct-realtime'] }), modelCatalog }
  })
}

export function voiceModelCatalogNotice(provider: VoiceProviderSummary | null | undefined,
  lane?: BuiltinVoiceLane | readonly BuiltinVoiceLane[], modelId?: string | null): string | null {
  const catalog = provider?.modelCatalog
  if (!catalog || catalog.sourceStatus === 'runtime-owned') return null
  if (catalog.source === 'unavailable') return 'Voice model compatibility could not be read. Saved choices are kept.'
  const notes: string[] = []
  if (catalog.source === 'bundled') notes.push('Using the model list included with this app.')
  else if (catalog.sourceStatus === 'blocked' || catalog.warning) notes.push('The model list could not be refreshed. Previous choices are kept.')
  else if (catalog.stale) notes.push('The voice model list has not been verified in the last day.')
  if (catalog.unavailableCount) notes.push(`${catalog.unavailableCount} model ${catalog.unavailableCount === 1 ? 'update awaits' : 'updates await'} compatibility checks.`)
  const lanes: readonly BuiltinVoiceLane[] = typeof lane === 'string' ? [lane] : lane ?? []
  const selected = typeof modelId === 'string' ? modelId.trim() : ''
  const rows: unknown = catalog.lifecycleWarnings
  if (lanes.length && Array.isArray(rows) && rows.length <= 1000) {
    const warnings = [...new Set(rows.filter(isVoiceProviderLifecycleWarning).filter(row => lanes.includes(row.lane) && (!selected || row.modelId === selected)).map(row => {
      if (!row.shutdownAt) return `${row.modelId} is marked deprecated by its provider.`
      return `Provider lists ${row.shutdownAt.slice(0, 10)} as the shutdown date for ${row.modelId}.`
    }))]
    notes.push(...warnings.slice(0, 3))
    if (warnings.length > 3) notes.push(`${warnings.length - 3} more model lifecycle warnings apply to this voice lane.`)
  }
  return notes.join(' ') || null
}

export function voiceProviderModelProfile(provider: VoiceProviderSummary | null | undefined, lane: BuiltinVoiceLane, modelId?: string | null): string | null {
  const lanes = provider?.modelCatalog?.compatibilityProfiles
  const rows = lanes && Object.hasOwn(lanes, lane) ? lanes[lane] : null
  const value = rows && modelId && Object.hasOwn(rows, modelId) ? rows[modelId] : null
  return typeof value === 'string' ? value : null
}

/** The installed profile owns advertised capabilities; remote data supplies no flags. */
export function voiceSttCapabilitiesForModel(provider: VoiceProviderSummary | null | undefined, modelId?: string | null) {
  const capabilities = provider?.sttCapabilities
  if (!capabilities) return null
  const selectedModel = modelId?.trim()
  if (provider.id === 'openai' && voiceProviderModelProfile(provider, 'stt-recorded', selectedModel) === 'openai.file-transcription.v2') {
    return { ...capabilities, wordTimestamps: false, diarization: false, keyterms: false,
      notes: ['Recorded transcription returns text and detected languages without word timestamps or speaker labels.'] }
  }
  if (provider.id === 'mistral' && voiceProviderModelProfile(provider, 'stt-recorded', selectedModel) === 'mistral.recorded-segments.v2') {
    return { ...capabilities, wordTimestamps: false,
      notes: ['Recorded transcription supports segment timestamps. Overlapping segments are preserved.'] }
  }
  return capabilities
}

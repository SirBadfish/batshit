// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BUNDLED_VOICE_PROVIDER_SUMMARIES } from '../data/builtinVoiceProviderBaseline'
import { bundledVoiceCatalogEntries, projectVoiceProviderSummaries, selectedVoiceCatalogCompatibility, voiceModelCatalogNotice, voiceSttCapabilitiesForModel } from './builtinVoiceCatalogProjection'
import { BUILTIN_VOICE_PROVIDER_IDS } from '../data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot, VoiceCatalogView } from '../types/builtinVoiceCatalog'
import type { VoiceProviderSummary } from '../types/voice'

const mistral3 = 'voxtral-mini-transcribe-3-0'
function mistral(): VoiceProviderSummary {
  return { ...structuredClone(BUNDLED_VOICE_PROVIDER_SUMMARIES.find(provider => provider.id === 'mistral')!),
    modelCatalog: { source: 'retained', sourceStatus: 'verified', lastVerifiedAt: null, lastAttemptAt: null, stale: true,
      discoveryCoverage: 'partial', qualificationCoverage: 'pending', unavailableCount: 1,
      compatibilityProfiles: { 'stt-recorded': { [mistral3]: 'mistral.recorded-segments.v2', 'voxtral-mini-latest': 'mistral.recorded-segments.v1' } } } }
}

describe('selected recorded-STT capabilities', () => {
  it('reports the selected OpenAI new recorded profile without inventing word timestamps or speakers', () => {
    const provider = { ...mistral(), id: 'openai' as const }
    provider.modelCatalog!.compatibilityProfiles = { 'stt-recorded': { 'gpt-transcribe': 'openai.file-transcription.v2' } }
    expect(voiceSttCapabilitiesForModel(provider, 'gpt-transcribe')).toMatchObject({ wordTimestamps: false, diarization: false })
  })
  it('reports segment-only Mistral3 timestamps while preserving the other provider capabilities', () => {
    const provider = mistral(), original = structuredClone(provider)
    const capabilities = voiceSttCapabilitiesForModel(provider, ` ${mistral3} `)!
    expect(capabilities.wordTimestamps).toBe(false)
    expect(capabilities.notes).toEqual(['Recorded transcription supports segment timestamps. Overlapping segments are preserved.'])
    expect({ ...capabilities, wordTimestamps: provider.sttCapabilities!.wordTimestamps, notes: provider.sttCapabilities!.notes }).toEqual(provider.sttCapabilities)
    expect(provider).toEqual(original)
  })

  it('uses the same segment-only capability for the exact Small 3 profile', () => {
    const provider = mistral(), id = 'voxtral-small-transcribe-3-0'
    provider.modelCatalog!.compatibilityProfiles!['stt-recorded'][id] = 'mistral.recorded-segments.v2'
    expect(voiceSttCapabilitiesForModel(provider, id)?.wordTimestamps).toBe(false)
    expect(voiceSttCapabilitiesForModel(provider, id)?.notes).toContain('Recorded transcription supports segment timestamps. Overlapping segments are preserved.')
  })

  it('keeps v1, custom and unavailable-profile choices under their existing capability description', () => {
    const provider = mistral()
    for (const model of ['voxtral-mini-latest', 'custom-mistral-model', '', null, undefined]) {
      expect(voiceSttCapabilitiesForModel(provider, model)).toBe(provider.sttCapabilities)
    }
    delete provider.modelCatalog
    expect(voiceSttCapabilitiesForModel(provider, mistral3)).toBe(provider.sttCapabilities)
    expect(voiceSttCapabilitiesForModel(null, mistral3)).toBeNull()
  })

  it('does not invent a selected model from defaults or apply Mistral profile semantics to another provider', () => {
    const provider = mistral()
    provider.defaultSttModel = mistral3
    expect(voiceSttCapabilitiesForModel(provider, '')).toBe(provider.sttCapabilities)
    expect(voiceSttCapabilitiesForModel({ ...provider, id: 'openai' }, mistral3)).toBe(provider.sttCapabilities)
  })
})


describe('voice model lifecycle notices', () => {
  const now = Date.parse('2026-10-28T12:00:00Z')
  function view(): VoiceCatalogView {
    const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, {
      sourceStatus: id === 'browser' ? 'runtime-owned' : 'verified', discoveryCoverage: 'partial',
      qualificationCoverage: 'complete', lastAttemptAt: '2026-10-28T12:00:00Z', lastVerifiedAt: '2026-10-28T12:00:00Z',
      sourceUrls: [], entries: bundledVoiceCatalogEntries(id)
    }])) as BuiltinVoiceCatalogSnapshot['providers']
    return { source: 'retained', checkedAt: '2026-10-28T12:00:00Z', snapshot: {
      schemaVersion: 1, generation: 1, sequence: 1, revision: '0'.repeat(64), generatedAt: '2026-10-28T12:00:00Z', providers
    } }
  }

  it('projects finite model and lane warnings without changing choice, default or compatibility facts', () => {
    const before = view(), after = structuredClone(before)
    const entry = after.snapshot!.providers.openai.entries.find(row => row.lane === 'stt-recorded')!
    entry.release = 'deprecated'; entry.shutdownAt = '2027-01-15T00:00:00Z'
    const beforeProvider = projectVoiceProviderSummaries(BUNDLED_VOICE_PROVIDER_SUMMARIES, before, now).find(row => row.id === 'openai')!
    const afterProvider = projectVoiceProviderSummaries(BUNDLED_VOICE_PROVIDER_SUMMARIES, after, now).find(row => row.id === 'openai')!
    const { modelCatalog: beforeCatalog, ...beforeRest } = beforeProvider
    const { modelCatalog: afterCatalog, ...afterRest } = afterProvider
    expect(afterRest).toEqual(beforeRest)
    expect(afterCatalog!.compatibilityProfiles).toEqual(beforeCatalog!.compatibilityProfiles)
    expect(afterCatalog!.lifecycleWarnings).toEqual([{ modelId: entry.modelId, lane: entry.lane, release: 'deprecated', shutdownAt: entry.shutdownAt }])
    expect(selectedVoiceCatalogCompatibility(after, 'openai', entry.lane, entry.modelId)).toEqual(selectedVoiceCatalogCompatibility(before, 'openai', entry.lane, entry.modelId))
    expect(voiceModelCatalogNotice(afterProvider, entry.lane, entry.modelId)).toContain(`Provider lists 2027-01-15 as the shutdown date for ${entry.modelId}.`)
    expect(voiceModelCatalogNotice(afterProvider, 'tts-batch', entry.modelId)).not.toContain('shutdown date')
    expect(voiceModelCatalogNotice(afterProvider, entry.lane, 'custom-other')).not.toContain('shutdown date')
    afterProvider.defaultSttModel = 'custom-other'
    expect(voiceModelCatalogNotice(afterProvider, entry.lane, '')).toContain(entry.modelId)
    expect(voiceModelCatalogNotice(afterProvider, entry.lane, '')).not.toContain('custom-other')
  })

  it('keeps known new contracts pending when an older snapshot lacks them while retaining arbitrary custom IDs', () => {
    const older = view()
    older.snapshot!.providers.cartesia.entries = older.snapshot!.providers.cartesia.entries.filter(row => row.modelId !== 'sonic-3.6')
    expect(selectedVoiceCatalogCompatibility(older, 'cartesia', 'tts-batch', 'sonic-3.6').state).toBe('candidate')
    expect(selectedVoiceCatalogCompatibility(older, 'cartesia', 'tts-batch', 'custom-cartesia').state).toBe('unlisted')
    for (const id of ['voxtral-small-transcribe-3-0', 'voxtral-small-transcribe-3', 'voxtral-small-transcribe-latest']) {
      expect(selectedVoiceCatalogCompatibility({ source: 'bundled', snapshot: null, checkedAt: null }, 'mistral', 'stt-recorded', id).state).toBe('candidate')
      older.snapshot!.providers.mistral.entries = older.snapshot!.providers.mistral.entries.filter(row => row.modelId !== id)
      expect(selectedVoiceCatalogCompatibility(older, 'mistral', 'stt-recorded', id).state).toBe('candidate')
    }
    expect(selectedVoiceCatalogCompatibility(older, 'mistral', 'stt-recorded', 'other-custom-id').state).toBe('unlisted')
  })

  it('keeps expired and deprecated notices, preserves cache warnings and ignores malformed optional rows', () => {
    const provider = mistral()
    provider.modelCatalog!.warning = 'remote-unavailable'
    provider.modelCatalog!.lifecycleWarnings = [
      { modelId: 'older', lane: 'stt-recorded', release: 'deprecated', shutdownAt: '2025-03-04T12:30:00Z' },
      { modelId: 'retiring', lane: 'stt-recorded', release: 'deprecated' },
      { modelId: 'tts-only', lane: 'tts-batch', release: 'deprecated' },
      { modelId: 'invalid', lane: 'stt-recorded', release: 'deprecated', shutdownAt: '2027-02-30T00:00:00Z' },
      null as never
    ]
    const result = voiceModelCatalogNotice(provider, 'stt-recorded', '')!
    expect(result).toContain('could not be refreshed')
    expect(result).toContain('Provider lists 2025-03-04 as the shutdown date for older.')
    expect(result).not.toContain('12:30:00')
    expect(result).toContain('retiring is marked deprecated')
    expect(result).not.toContain('tts-only')
    expect(result).not.toContain('invalid')
    provider.modelCatalog!.lifecycleWarnings = {} as never
    expect(() => voiceModelCatalogNotice(provider, 'stt-recorded', '')).not.toThrow()
    provider.modelCatalog!.source = 'unavailable'
    expect(voiceModelCatalogNotice(provider, 'stt-recorded', '')).toBe('Voice model compatibility could not be read. Saved choices are kept.')
  })
})

import { describe, expect, it } from 'vitest'
import { BUNDLED_VOICE_PROVIDER_SUMMARIES } from '../data/builtinVoiceProviderBaseline'
import { readVoiceProviderEnvelope } from './voiceProviderEnvelope'

describe('shared voice provider response admission', () => {
  it('admits the same canonical15-provider offline baseline without changing defaults', () => {
    const rows = readVoiceProviderEnvelope({ providers: BUNDLED_VOICE_PROVIDER_SUMMARIES })
    expect(rows).toHaveLength(15)
    expect(rows.find(row => row.id === 'fish')).toMatchObject({ defaultTtsModel: 's2.1-pro', ttsModels: ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1'] })
    rows[0].label = 'local edit'
    expect(BUNDLED_VOICE_PROVIDER_SUMMARIES[0].label).toBe('Browser (Web Speech API)')
  })
  it.each([null, {}, { providers: [] }, { providers: {} }, { providers: [null] }, { providers: [{ id: 'fish' }] }])('refuses malformed success as unavailable rather than confirmed empty: %j', value => {
    expect(() => readVoiceProviderEnvelope(value)).toThrow('Previous choices are kept')
  })
  it('refuses duplicate providers and invalid model members', () => {
    expect(() => readVoiceProviderEnvelope({ providers: [BUNDLED_VOICE_PROVIDER_SUMMARIES[0], BUNDLED_VOICE_PROVIDER_SUMMARIES[0]] })).toThrow()
    expect(() => readVoiceProviderEnvelope({ providers: [{ ...BUNDLED_VOICE_PROVIDER_SUMMARIES[1], ttsModels: ['model', 1] }] })).toThrow()
  })
})


describe('lifecycle metadata response boundary', () => {
  const warning = { modelId: 'tts-1', lane: 'tts-batch', release: 'deprecated', shutdownAt: '2027-01-06T00:00:00.000Z' }
  const envelope = (lifecycleWarnings: unknown) => ({ providers: [{ ...BUNDLED_VOICE_PROVIDER_SUMMARIES[0], modelCatalog: { lifecycleWarnings } }] })
  it('admits detached finite future warning metadata without changing model/default choices', () => {
    const value = envelope([warning]), rows = readVoiceProviderEnvelope(value)
    expect(rows[0].modelCatalog?.lifecycleWarnings?.[0]).toEqual(warning)
    rows[0].modelCatalog!.lifecycleWarnings![0].modelId = 'local-edit'
    expect(warning.modelId).toBe('tts-1')
  })
  it.each([{}, [null], [{ ...warning, lane: 'new-executable-lane' }], [{ ...warning, shutdownAt: '2027-02-30T00:00:00Z' }], [{ ...warning, url: 'https://private.invalid' }], [warning, warning], [{ ...warning, modelId: '\ud800' }]])('rejects malformed/duplicate lifecycle facts rather than installing a new success: %j', value => {
    expect(() => readVoiceProviderEnvelope(envelope(value))).toThrow('Previous choices are kept')
  })
})

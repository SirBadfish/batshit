import { describe, expect, it } from 'vitest'
import { resolveVoiceTtsDisplayEndpoint, resolveVoiceTtsDisplaySelection, voiceTtsModelStreams } from './voiceTtsDisplay'
import { mimoVoiceModelNotice } from '../data/mimoVoiceProfiles'
import { voiceModelApplicabilityNotice } from '../data/voiceModelApplicability'
import { BUNDLED_VOICE_PROVIDER_SUMMARIES } from '../data/builtinVoiceProviderBaseline'
import type { VoiceProfileRecord } from '../types/voice'

describe('voice model applicability follows actual inherited/profile selection', () => {
  it('labels the installed model transport without granting admission or changing custom fallbacks', () => {
    const inworld = BUNDLED_VOICE_PROVIDER_SUMMARIES.find(provider => provider.id === 'inworld')!
    const fish = BUNDLED_VOICE_PROVIDER_SUMMARIES.find(provider => provider.id === 'fish')!
    const withProfiles = { ...inworld, modelCatalog: { compatibilityProfiles: {
      'tts-batch': { 'inworld-tts-2-flash': 'inworld.voice-json-flash.v1', 'batch-test': 'inworld.voice-json-flash.v1' },
      'tts-direct-stream': { 'inworld-tts-2': 'inworld.voice-stream.v1' }
    } } } as typeof inworld
    expect(voiceTtsModelStreams(withProfiles, 'inworld-tts-2-flash')).toBe(false)
    expect(voiceTtsModelStreams(inworld, 'inworld-tts-2-flash')).toBe(false)
    expect(voiceTtsModelStreams(withProfiles, 'inworld-tts-2')).toBe(true)
    expect(voiceTtsModelStreams(withProfiles, 'batch-test')).toBe(false)
    expect(voiceTtsModelStreams({ ...withProfiles, supports: { ...withProfiles.supports, streaming: false } }, 'inworld-tts-2')).toBe(true)
    expect(voiceTtsModelStreams(inworld, 'custom-model')).toBe(true)
    expect(voiceTtsModelStreams(fish, 's2-pro')).toBe(true)
    expect(voiceTtsModelStreams(null, 'inworld-tts-2-flash')).toBe(false)
  })
  it('states the Flash batch-only and Direct-stream boundary', () => {
    expect(voiceModelApplicabilityNotice('inworld', 'inworld-tts-2-flash')).toContain('Direct streaming is not available yet')
  })
  it('shows the 2.5 instruction limit without applying it to other Step models', () => {
    expect(voiceModelApplicabilityNotice('stepfun', 'stepaudio-2.5-tts')).toContain('200 characters')
    expect(voiceModelApplicabilityNotice('stepfun', 'step-tts-2')).toBeNull()
  })
  it('uses inherited Qwen model and the effective endpoint, including a selected profile override', () => {
    const global = { tts: { providerId: 'alibaba', modelId: 'qwen-audio-3.1-tts-flash', common: { endpoint: 'global' } },
      ttsEngineSettings: { alibaba: { common: { endpoint: 'engine' } } } }
    const inherited = resolveVoiceTtsDisplaySelection({ provider: 'alibaba' }, global, [], BUNDLED_VOICE_PROVIDER_SUMMARIES)
    expect(inherited.modelId).toBe('qwen-audio-3.1-tts-flash')
    expect(resolveVoiceTtsDisplayEndpoint(inherited, global, [])).toBe('engine')
    const profile: VoiceProfileRecord = { id: 'qwen-profile', user_id: 'u', name: 'Qwen', provider: 'alibaba', model: 'qwen-audio-3.0-tts-plus', voiceId: 'longanlingxin',
      settings: { common: { endpoint: 'profile' } }, created_at: '2026-10-28T00:00:00.000Z', updated_at: '2026-10-28T00:00:00.000Z' }
    const selected = resolveVoiceTtsDisplaySelection({ provider: 'alibaba', profileId: profile.id }, { tts: { providerId: 'openai' }, ttsEngineSettings: global.ttsEngineSettings }, [profile], BUNDLED_VOICE_PROVIDER_SUMMARIES)
    expect(selected.modelId).toBe(profile.model)
    expect(resolveVoiceTtsDisplayEndpoint(selected, global, [profile])).toBe('profile')
    expect(resolveVoiceTtsDisplayEndpoint(selected, global, [])).toBeNull()
  })
  it('shows inherited global design guidance without changing the saved form', () => {
    const own = {}, global = { schemaVersion: 2, tts: { providerId: 'mimo', modelId: 'mimo-v2.5-tts-voicedesign', voiceId: 'Chloe' } }
    const before = structuredClone(global)
    const selected = resolveVoiceTtsDisplaySelection(own, global, [], BUNDLED_VOICE_PROVIDER_SUMMARIES)
    expect(selected).toMatchObject({ providerId: 'mimo', modelId: 'mimo-v2.5-tts-voicedesign' })
    expect(mimoVoiceModelNotice(selected.providerId, selected.modelId)).toContain('Instructions')
    expect(global).toEqual(before); expect(own).toEqual({})
  })
  it('uses a selected profile model and ignores another provider’s global model/profile', () => {
    const own = { provider: 'mimo', profileId: 'configured-clone' }, global = { tts: { providerId: 'openai', modelId: 'tts-1', profileId: 'unrelated' } }
    const profile: VoiceProfileRecord = { id: 'configured-clone', user_id: 'u', name: 'Configured clone', provider: 'mimo', model: 'mimo-v2.5-tts-voiceclone',
      voiceId: 'data:audio/wav;base64,AQID', created_at: '2026-10-28T00:00:00.000Z', updated_at: '2026-10-28T00:00:00.000Z' }
    const selected = resolveVoiceTtsDisplaySelection(own, global, [profile], BUNDLED_VOICE_PROVIDER_SUMMARIES)
    expect(selected).toMatchObject({ providerId: 'mimo', modelId: profile.model, profileId: profile.id })
    expect(mimoVoiceModelNotice(selected.providerId, selected.modelId)).toContain('not a preset voice')
    expect(resolveVoiceTtsDisplaySelection({ ...own, model: 'mimo-v2.5-tts' }, global, [profile], BUNDLED_VOICE_PROVIDER_SUMMARIES).modelId).toBe('mimo-v2.5-tts')
  })
  it('does not invent settings model/voice fallbacks or a default for a missing/incompatible profile', () => {
    const global = { tts: { providerId: 'mimo', profileId: 'configured-design' } }
    const profile: VoiceProfileRecord = { id: 'configured-design', user_id: 'u', name: 'Configured design', provider: 'mimo', voiceId: 'Chloe',
      settings: { modelId: 'mimo-v2.5-tts-voicedesign', voiceId: 'not-the-actual-voice' }, created_at: '2026-10-28T00:00:00.000Z', updated_at: '2026-10-28T00:00:00.000Z' }
    expect(resolveVoiceTtsDisplaySelection({}, global, [profile], BUNDLED_VOICE_PROVIDER_SUMMARIES)).toMatchObject({ modelId: 'mimo-v2.5-tts', voiceId: 'Chloe' })
    expect(resolveVoiceTtsDisplaySelection({}, global, [], BUNDLED_VOICE_PROVIDER_SUMMARIES).modelId).toBeNull()
    expect(resolveVoiceTtsDisplaySelection({}, global, [{ ...profile, provider: 'openai' }], BUNDLED_VOICE_PROVIDER_SUMMARIES).modelId).toBeNull()
  })
})

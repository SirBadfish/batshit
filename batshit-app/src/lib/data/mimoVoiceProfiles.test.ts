import { describe, expect, it } from 'vitest'
import { MIMO_CLONE_PROFILE, MIMO_DESIGN_PROFILE, mimoVoiceModelNotice, mimoVoiceVariant } from './mimoVoiceProfiles'
import { voiceProviderModelProfile } from '$lib/utils/builtinVoiceCatalogProjection'
import type { VoiceProviderSummary } from '$lib/types/voice'

describe('MiMo compiled model applicability', () => {
  it('makes design/clone requirements visible without inventing new controls or changing saved inputs', () => {
    expect(mimoVoiceModelNotice('mimo', 'mimo-v2.5-tts-voicedesign')).toContain('saved Voice value is kept and is not sent')
    expect(mimoVoiceModelNotice('mimo', 'mimo-v2.5-tts-voiceclone')).toContain('not a preset voice')
    expect(mimoVoiceModelNotice('mimo', 'mimo-v2.5-tts')).toBeNull()
    expect(mimoVoiceModelNotice('openai', 'mimo-v2.5-tts-voicedesign')).toBeNull()
  })
  it('uses supported installed profile identities for later model data and never prototype lookup', () => {
    expect(mimoVoiceVariant('new-id', MIMO_DESIGN_PROFILE)).toBe('design')
    expect(mimoVoiceVariant('new-id', MIMO_CLONE_PROFILE)).toBe('clone')
    expect(mimoVoiceVariant('new-id', 'constructor')).toBeUndefined()
    const provider = { modelCatalog: { compatibilityProfiles: { 'tts-batch': { 'new-id': MIMO_DESIGN_PROFILE } } } } as unknown as VoiceProviderSummary
    expect(voiceProviderModelProfile(provider, 'tts-batch', 'new-id')).toBe(MIMO_DESIGN_PROFILE)
    expect(voiceProviderModelProfile(provider, 'tts-batch', 'constructor')).toBeNull()
    expect(voiceProviderModelProfile(provider, 'constructor' as never, 'new-id')).toBeNull()
  })
})

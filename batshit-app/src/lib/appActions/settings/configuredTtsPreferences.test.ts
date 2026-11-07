import { describe, expect, it } from 'vitest'
import { validateConfiguredTtsChanges, parseConfiguredFishAccountQuery, isConfiguredFishAccountCursor } from './configuredTtsPreferences'
describe('configured reply voice atomic input', () => {
  it('requires one complete union and keeps null inheritance distinct from omission', () => {
    expect(validateConfiguredTtsChanges({ selection: 'inherit' })).toEqual({ selection: 'inherit' })
    expect(validateConfiguredTtsChanges({ selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'alloy' })).toEqual({ selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'alloy' })
    expect(validateConfiguredTtsChanges({ selection: 'profile', profileId: 'voice_owned' })).toEqual({ selection: 'profile', profileId: 'voice_owned' })
    for (const bad of [null, {}, [], { selection: null }, { selection: 'provider', providerId: 'openai', voiceId: null },
      { selection: 'provider', providerId: ' openai', modelId: null, voiceId: null }, { selection: 'profile', profileId: '' },
      { selection: 'profile', profileId: 'voice', voiceId: 'override' }, { selection: 'inherit', stt: null },
      { selection: 'provider', providerId: 'openai', modelId: null, voiceId: false }, { selection: 'profile', profileId: 'x'.repeat(257) }]) expect(() => validateConfiguredTtsChanges(bad)).toThrow()
  })
  it('admits only explicit Fish account query facts without changing the tagged mutation', () => {
    expect(parseConfiguredFishAccountQuery({ ttsCatalog: 'account', ttsProviderId: 'fish', ttsModelId: 's1' })).toEqual({ ttsCatalog: 'account', ttsProviderId: 'fish', ttsModelId: 's1' })
    for (const value of [null, {}, { ttsCatalog: 'local', ttsProviderId: 'fish' }, { ttsCatalog: 'account', ttsProviderId: 'openai' },
      { ttsCatalog: 'account', ttsProviderId: 'fish', ttsOffset: 0 }, { ttsCatalog: 'account', ttsProviderId: 'fish', ttsProfileId: 'saved' },
      { ttsCatalog: 'account', ttsProviderId: 'fish', ttsModelId: null }, { ttsCatalog: 'account', ttsProviderId: 'fish', endpoint: 'private' }]) {
      expect(() => parseConfiguredFishAccountQuery(value)).toThrow()
    }
    expect(() => validateConfiguredTtsChanges({ selection: 'provider', providerId: 'fish', modelId: null, voiceId: 'voice', account: {} })).toThrow()
  })
  it('accepts only canonical finite account cursor spelling, never a provider cursor or zero/unissued alias', () => {
    expect(isConfiguredFishAccountCursor(`sv1:${'a'.repeat(64)}:1`)).toBe(true)
    for (const cursor of [`sv1:${'a'.repeat(64)}:0`, `sv1:${'a'.repeat(64)}:01`, `sv1:${'a'.repeat(64)}:100000`, `sr1:${'a'.repeat(64)}:1`, 'https://provider.invalid/next', 'sv1:raw-token:1']) {
      expect(isConfiguredFishAccountCursor(cursor)).toBe(false)
    }
  })
})

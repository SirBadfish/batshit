// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildMimoSpeechInput, MAX_MIMO_CLONE_BASE64_BYTES, MimoVoiceInputError } from './mimoVoiceInput'
import { MIMO_CLONE_PROFILE, MIMO_DESIGN_PROFILE } from '$lib/data/mimoVoiceProfiles'

const base = { text: 'Speak this', format: 'wav' as const, defaultVoiceId: 'Chloe' }
describe('MiMo exact compiled variant inputs', () => {
  it('preserves base/default/custom request behavior and optional instructions', () => {
    expect(buildMimoSpeechInput({ ...base, modelId: 'mimo-v2.5-tts' })).toMatchObject({ model: 'mimo-v2.5-tts', audio: { format: 'wav', voice: 'Chloe' }, messages: [{ role: 'assistant', content: 'Speak this' }], voiceIdForMetadata: 'Chloe' })
    expect(buildMimoSpeechInput({ ...base, modelId: 'custom-mimo', voiceId: 'saved-custom-voice', instructions: '  gently  ' })).toMatchObject({ model: 'custom-mimo', audio: { voice: 'saved-custom-voice' }, messages: [{ role: 'user', content: 'gently' }, { role: 'assistant', content: 'Speak this' }] })
  })
  it('requires real design instructions and omits the saved preset voice from design wire/metadata', () => {
    expect(() => buildMimoSpeechInput({ ...base, modelId: 'mimo-v2.5-tts-voicedesign', voiceId: 'Chloe' })).toThrow(MimoVoiceInputError)
    const result = buildMimoSpeechInput({ ...base, modelId: 'mimo-v2.5-tts-voicedesign', voiceId: 'Chloe', instructions: 'Warm low voice' })
    expect(result.audio).toEqual({ format: 'wav' })
    expect(result.voiceIdForMetadata).toBeNull()
    expect(result.messages).toEqual([{ role: 'user', content: 'Warm low voice' }, { role: 'assistant', content: 'Speak this' }])
  })
  it('lets installed private profile authority choose a future exact-model serializer but refuses known identity mismatch', () => {
    expect(buildMimoSpeechInput({ ...base, modelId: 'future-compatible-id', compatibilityProfileId: MIMO_DESIGN_PROFILE, instructions: 'Deep voice' }).audio).not.toHaveProperty('voice')
    expect(() => buildMimoSpeechInput({ ...base, modelId: 'mimo-v2.5-tts', compatibilityProfileId: MIMO_DESIGN_PROFILE, instructions: 'Deep voice' })).toThrow('request profile is unavailable')
    expect(() => buildMimoSpeechInput({ ...base, modelId: 'custom', compatibilityProfileId: 'constructor' })).toThrow('request profile is unavailable')
  })
  it.each(['audio/wav', 'audio/mpeg', 'audio/mp3'])('preserves supported padded/unpadded reference payloads without echoing them: %s', mime => {
    for (const encoded of ['AQI=', 'AQI', 'AQID']) {
      const uri = `data:${mime};base64,${encoded}`
      const result = buildMimoSpeechInput({ ...base, modelId: 'mimo-v2.5-tts-voiceclone', compatibilityProfileId: MIMO_CLONE_PROFILE, voiceId: uri })
      expect(result.audio.voice).toBe(uri)
      expect(result.voiceIdForMetadata).toBeNull()
    }
  })
  it.each([null, '', 'Chloe', 'https://example.invalid/reference.wav', 'data:audio/ogg;base64,AQI=', 'data:audio/wav;base64,', 'data:audio/wav;base64,A',
    'data:audio/wav;base64,AQI==', 'data:audio/wav;base64,AB==', 'data:audio/wav;base64,AQ I=', 'data:audio/wav;base64,AQ!I='])('refuses invalid resolved clone input without disclosing it', uri => {
    try { buildMimoSpeechInput({ ...base, modelId: 'mimo-v2.5-tts-voiceclone', voiceId: uri }); throw Error('Expected refusal') }
    catch (error) { expect(error).toBeInstanceOf(MimoVoiceInputError); if (uri) expect((error as Error).message).not.toContain(uri) }
  })
  it('prebounds decimal encoded bytes before decoding and never adds a data URI to metadata on another model', () => {
    expect(() => buildMimoSpeechInput({ ...base, modelId: 'mimo-v2.5-tts-voiceclone', voiceId: 'data:audio/wav;base64,' + 'A'.repeat(MAX_MIMO_CLONE_BASE64_BYTES + 4) })).toThrow('10,000,000')
    expect(buildMimoSpeechInput({ ...base, modelId: 'custom-mimo', voiceId: 'data:audio/wav;base64,AQI=' }).voiceIdForMetadata).toBeNull()
  })
})

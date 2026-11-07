import { describe, expect, it } from 'vitest'
import { captureConfiguredTtsBaseline } from './configuredTtsBaseline'
const token = `sha256:${'a'.repeat(64)}`
const row = (voice_profile: unknown) => ({ id: 'a10_baseline', user_id: 'u', agentType: 'api', voice_profile })
describe('original human TTS base projection', () => {
  it('requires the owned detail token and actual Primary kind before enabling selection', () => {
    expect(captureConfiguredTtsBaseline(row(null), null)).toBeNull()
    expect(captureConfiguredTtsBaseline(row(null), 'new-token')).toBeNull()
    expect(captureConfiguredTtsBaseline({ ...row(null), agentType: 'n8n' }, token)).toBeNull()
    expect(captureConfiguredTtsBaseline(row(null), token)).toEqual({ id: 'a10_baseline', token, selection: { providerId: null, modelId: null, voiceId: null, profileId: null } })
  })
  it('retains nullish legacy precedence and the Fish voice alias without reflecting other raw data', () => {
    const legacy = captureConfiguredTtsBaseline(row({ tts: null, provider: 'gemini', model: 'saved', voiceId: 'Kore', future: { authToken: 'PRIVATE' }, stt: { raw: 'STT_ONLY' } }), token)
    expect(legacy?.selection).toEqual({ providerId: 'google', modelId: 'saved', voiceId: 'Kore', profileId: null })
    const fish = captureConfiguredTtsBaseline(row({ tts: { providerId: 'fish', providerOptions: { fish: { reference_id: 'owned-reference', temperature: 0 } }, narration: { italicBehavior: 'silent' } } }), token)
    expect(fish?.selection.voiceId).toBe('owned-reference')
    expect(JSON.stringify([legacy, fish])).not.toMatch(/PRIVATE|STT_ONLY|temperature|narration|future/)
  })
  it('never revives flat legacy selectors behind an existing empty nested TTS object', () => {
    expect(captureConfiguredTtsBaseline(row({ provider: 'google', model: 'old', voiceId: 'Kore', tts: {} }), token)?.selection).toEqual({ providerId: null, modelId: null, voiceId: null, profileId: null })
  })
  it('rejects malformed relevant envelopes and leaves, while preserving unrelated extension tolerance', () => {
    for (const value of [[], 1, { tts: [] }, { tts: 1 }, { tts: { providerId: 1 } }, { tts: { voiceId: {} } }, { tts: { profileId: 'x'.repeat(257) } }]) expect(captureConfiguredTtsBaseline(row(value), token)).toBeNull()
    expect(captureConfiguredTtsBaseline(row({ tts: { providerId: 'openai' }, stt: { unknown: true }, future: [] }), token)?.selection.providerId).toBe('openai')
  })
})

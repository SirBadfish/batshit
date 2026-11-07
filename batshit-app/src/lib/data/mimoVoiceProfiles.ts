export const MIMO_PRESET_PROFILE = 'mimo.chat-audio.v1'
export const MIMO_DESIGN_PROFILE = 'mimo.chat-voice-design.v1'
export const MIMO_CLONE_PROFILE = 'mimo.chat-voice-clone.v1'
export type MimoVoiceVariant = 'preset' | 'design' | 'clone'

const models: Readonly<Record<string, MimoVoiceVariant>> = Object.freeze({
  'mimo-v2.5-tts': 'preset', 'mimo-v2.5-tts-voicedesign': 'design', 'mimo-v2.5-tts-voiceclone': 'clone'
})
const profiles: Readonly<Record<string, MimoVoiceVariant>> = Object.freeze({
  [MIMO_PRESET_PROFILE]: 'preset', [MIMO_DESIGN_PROFILE]: 'design', [MIMO_CLONE_PROFILE]: 'clone'
})

/** Compiled identities only; profile authority is supplied privately by installed admission. */
export function mimoVoiceVariant(modelId: string, compatibilityProfileId?: string | null): MimoVoiceVariant | undefined {
  const exact = Object.hasOwn(models, modelId) ? models[modelId] : undefined
  if (compatibilityProfileId) {
    const mapped = Object.hasOwn(profiles, compatibilityProfileId) ? profiles[compatibilityProfileId] : undefined
    return mapped && (!exact || exact === mapped) ? mapped : undefined
  }
  return exact ?? 'preset' // Preserve the existing owner for custom-unlisted model IDs.
}

export function mimoVoiceModelNotice(providerId?: string | null, modelId?: string | null, compatibilityProfileId?: string | null): string | null {
  if (providerId !== 'mimo' || !modelId) return null
  const variant = mimoVoiceVariant(modelId, compatibilityProfileId)
  if (variant === 'design') return 'Voice Design requires a voice description in Voice Engines → Instructions. The saved Voice value is kept and is not sent.'
  if (variant === 'clone') return 'Voice Clone requires a configured MP3 or WAV audio reference, not a preset voice. Existing Voice settings are kept.'
  return null
}

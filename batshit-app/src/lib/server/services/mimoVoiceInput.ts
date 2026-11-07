import { mimoVoiceVariant } from '$lib/data/mimoVoiceProfiles'
import { VoiceCatalogCompatibilityError } from './builtinVoiceCatalogErrors'

// Conservative decimal ceiling for the guide's10MB encoded sample limit, not the ASR10MiB ceiling.
export const MAX_MIMO_CLONE_BASE64_BYTES = 10_000_000

export class MimoVoiceInputError extends Error {
  readonly status = 400
  readonly code = 'mimo_voice_input_invalid'
  readonly setupHint = 'Check the selected MiMo model’s required inputs in Voice Settings. Preset, Voice Design and Voice Clone use different inputs.'
}

function cloneReference(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length > MAX_MIMO_CLONE_BASE64_BYTES + 64) throw new MimoVoiceInputError('A supported audio reference is required for MiMo Voice Clone (up to10,000,000 encoded bytes).')
  const match = value.match(/^data:(audio\/(?:mpeg|mp3|wav));base64,([a-z0-9+/]+={0,2})$/i)
  if (!match) throw new MimoVoiceInputError('MiMo Voice Clone requires a Base64 MP3 or WAV audio data URI.')
  const encoded = match[2]
  if (encoded.length > MAX_MIMO_CLONE_BASE64_BYTES || encoded.length % 4 === 1 || encoded.includes('=') && encoded.length % 4 !== 0) {
    throw new MimoVoiceInputError('MiMo Voice Clone audio reference has invalid Base64 padding or exceeds10,000,000 encoded bytes.')
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new MimoVoiceInputError('MiMo Voice Clone audio reference contains invalid Base64 data.')
  return value // Never rewrite the resolved/stored input or fetch a URL/file.
}

export function buildMimoSpeechInput(options: {
  modelId: string; text: string; voiceId?: string | null; instructions?: string | null
  format: 'wav' | 'pcm16'; defaultVoiceId: string; compatibilityProfileId?: string | null
}) {
  const variant = mimoVoiceVariant(options.modelId, options.compatibilityProfileId)
  if (!variant) throw new VoiceCatalogCompatibilityError('The selected MiMo voice request profile is unavailable. Your saved selection is kept.')
  const instructions = options.instructions?.trim()
  if (variant === 'design' && !instructions) throw new MimoVoiceInputError('A voice description is required in MiMo Voice Engine Instructions for Voice Design.')
  const voice = variant === 'clone' ? cloneReference(options.voiceId) : options.voiceId ?? options.defaultVoiceId
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (instructions) messages.push({ role: 'user', content: instructions })
  messages.push({ role: 'assistant', content: options.text })
  return {
    model: options.modelId, messages,
    audio: { format: options.format, ...(variant === 'design' ? {} : { voice }) },
    // A reference is provider input, not a public voice ID/header. Preserve request behavior on fallback too.
    voiceIdForMetadata: variant === 'preset' && !/^data:/i.test(voice) ? voice : null
  }
}

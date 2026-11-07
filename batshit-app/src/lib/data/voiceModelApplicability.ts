import { isQwenAudioTtsModel } from './qwenAudioTts'

/** Human-facing applicability for compiled, exact model identities. Saved values are retained. */
export function voiceModelApplicabilityNotice(providerId?: string | null, modelId?: string | null): string | null {
  if (providerId === 'inworld' && modelId === 'inworld-tts-2-flash')
    return 'Flash supports batch synthesis; Direct streaming is not available yet. Delivery mode and spoken steering instructions do not apply. Saved settings remain available for other models; non-verbal tags still work.'
  if (providerId === 'elevenlabs' && modelId === 'eleven_v4')
    return 'Eleven v4 uses Stability and Similarity. Speed, Style and Speaker Boost settings are kept but do not apply to this model.'
  if (providerId === 'stepfun' && modelId === 'stepaudio-3-tts')
    return 'StepAudio 3 needs a compatible voice. Choose zixinnansheng or a compatible custom voice; existing voice choices are kept.'
  if (providerId === 'stepfun' && modelId === 'stepaudio-2.5-tts')
    return 'StepAudio 2.5 accepts instructions up to 200 characters. Saved instructions are kept unchanged.'
  if (providerId === 'cartesia' && (modelId === 'sonic-3.6' || modelId === 'sonic-3.6-2026-08-27'))
    return 'Sonic 3.6 supports speed from 0.6 to 1.5 and volume from 0.5 to 2. Other saved values are kept and must be changed before use.'
  if (providerId === 'alibaba' && modelId && isQwenAudioTtsModel(modelId))
    return 'Qwen Audio requires the workspace endpoint for your key’s region and a voice supported by the chosen model. Language hints vary by model and voice.'
  if (providerId === 'alibaba')
    return 'The workspace endpoint setting applies to Qwen Audio models. It is kept when using other Alibaba voice models.'
  return null
}

export function voiceTranscriptionModelNotice(providerId?: string | null, modelId?: string | null): string | null {
  if (providerId === 'openai' && modelId === 'gpt-transcribe') return 'This model returns a transcript and detected languages, without word timestamps or speaker labels.'
  if (providerId === 'elevenlabs' && modelId === 'scribe_v2_medical') return 'Medical transcripts are drafts for review, not diagnoses or clinical decisions.'
  if (providerId === 'async' && modelId === 'async_asr_v1.0') return 'This model transcribes recorded audio and does not provide word timestamps or speaker labels.'
  return null
}

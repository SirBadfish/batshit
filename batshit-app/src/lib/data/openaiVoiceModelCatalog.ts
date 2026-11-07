export const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
export const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const
export const OPENAI_TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar'
] as const

export const OPENAI_LEGACY_TTS_VOICES = [
  'alloy',
  'ash',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer'
] as const

export type OpenAITTSModel = typeof OPENAI_TTS_MODELS[number]
export type OpenAITTSVoice = typeof OPENAI_TTS_VOICES[number]

export function getOpenAITtsVoicesForModel(model?: string | null): string[] {
  return model === 'tts-1' || model === 'tts-1-hd'
    ? [...OPENAI_LEGACY_TTS_VOICES]
    : [...OPENAI_TTS_VOICES]
}

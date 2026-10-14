export const MIMO_TOKEN_PLAN_OPENAI_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1'

/**
 * BL-241: `developerId` is the namespace Xiaomi's own `/models` publishes for
 * every MiMo model (`owned_by: xiaomi`, the same as the pay-as-you-go MiMo
 * connection), so these rows merge with MiMo's instead of listing each id twice.
 */
export const MIMO_TOKEN_PLAN_MODELS = [
  {
    id: 'mimo-v2.5-pro',
    developerId: 'xiaomi',
    displayName: 'MiMo V2.5 Pro',
    tags: ['chat', 'reasoning', 'code', 'vision', 'audio', 'multimodal', 'long-context'],
    contextWindow: 1_000_000,
    modelType: 'chat'
  },
  {
    id: 'mimo-v2.5',
    developerId: 'xiaomi',
    displayName: 'MiMo V2.5',
    tags: ['chat', 'reasoning', 'code', 'vision', 'audio', 'multimodal', 'long-context'],
    contextWindow: 1_000_000,
    modelType: 'chat'
  },
  {
    id: 'mimo-v2.5-asr',
    developerId: 'xiaomi',
    displayName: 'MiMo V2.5 ASR',
    tags: ['audio', 'stt', 'transcription'],
    modelType: 'audio'
  },
  {
    id: 'mimo-v2.5-tts',
    developerId: 'xiaomi',
    displayName: 'MiMo V2.5 TTS',
    tags: ['audio', 'tts'],
    modelType: 'audio'
  },
  {
    id: 'mimo-v2.5-tts-voicedesign',
    developerId: 'xiaomi',
    displayName: 'MiMo V2.5 TTS Voice Design',
    tags: ['audio', 'tts', 'voice-design'],
    modelType: 'audio'
  },
  {
    id: 'mimo-v2.5-tts-voiceclone',
    developerId: 'xiaomi',
    displayName: 'MiMo V2.5 TTS Voice Clone',
    tags: ['audio', 'tts', 'voice-clone'],
    modelType: 'audio'
  }
] as const

export const MIMO_TOKEN_PLAN_TEXT_MODEL_IDS = MIMO_TOKEN_PLAN_MODELS.filter(
  (model) => model.modelType === 'chat'
).map((model) => model.id)

export const KIMI_CODE_OPENAI_BASE_URL = 'https://api.kimi.ai/coding/v1'

export const KIMI_CODE_MODELS = [
  {
    id: 'k3',
    developerId: 'moonshotai',
    displayName: 'Kimi K3 (1M)',
    tags: ['chat', 'reasoning', 'code', 'vision', 'multimodal', 'long-context'],
    contextWindow: 1_048_576,
    modelType: 'chat'
  },
  {
    id: 'k3-256k',
    developerId: 'moonshotai',
    displayName: 'Kimi K3 (256K)',
    tags: ['chat', 'reasoning', 'code', 'vision'],
    contextWindow: 262_144,
    modelType: 'chat'
  },
  {
    id: 'kimi-for-coding',
    developerId: 'moonshotai',
    displayName: 'Kimi for Coding (K2.8 Preview)',
    tags: ['chat', 'reasoning', 'code', 'vision', 'multimodal', 'long-context'],
    contextWindow: 1_048_576,
    modelType: 'chat'
  },
  {
    id: 'kimi-for-coding-highspeed',
    developerId: 'moonshotai',
    displayName: 'Kimi for Coding HighSpeed (K2.7)',
    tags: ['chat', 'reasoning', 'code', 'vision', 'multimodal', 'fast'],
    contextWindow: 262_144,
    modelType: 'chat'
  }
] as const

export const KIMI_CODE_MODEL_IDS = KIMI_CODE_MODELS.map((model) => model.id)

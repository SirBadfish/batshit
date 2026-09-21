export const MINIMAX_TOKEN_PLAN_OPENAI_BASE_URL = 'https://api.minimax.io/v1'

export const MINIMAX_TOKEN_PLAN_TEXT_MODELS = [
  {
    id: 'MiniMax-M3',
    developerId: 'minimax',
    displayName: 'MiniMax M3',
    tags: ['chat', 'reasoning', 'code', 'vision', 'multimodal', 'long-context'],
    contextWindow: 1_048_576,
    modelType: 'chat'
  },
  {
    id: 'MiniMax-M2.7',
    developerId: 'minimax',
    displayName: 'MiniMax M2.7',
    tags: ['chat', 'reasoning', 'code', 'vision', 'multimodal', 'long-context'],
    contextWindow: 1_048_576,
    modelType: 'chat'
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    developerId: 'minimax',
    displayName: 'MiniMax M2.7 HighSpeed',
    tags: ['chat', 'reasoning', 'code', 'vision', 'multimodal', 'long-context', 'fast'],
    contextWindow: 1_048_576,
    modelType: 'chat'
  }
] as const

export const MINIMAX_TOKEN_PLAN_TEXT_MODEL_IDS = MINIMAX_TOKEN_PLAN_TEXT_MODELS.map(
  (model) => model.id
)

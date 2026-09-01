export const QWEN_TOKEN_PLAN_OPENAI_BASE_URL =
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'

export const QWEN_TOKEN_PLAN_TEXT_MODELS = [
  {
    id: 'qwen3.8-max',
    developerId: 'qwen',
    displayName: 'Qwen 3.8 Max',
    tags: ['chat', 'reasoning', 'vision']
  },
  {
    id: 'qwen3.8-flash',
    developerId: 'qwen',
    displayName: 'Qwen 3.8 Flash',
    tags: ['chat', 'reasoning', 'vision', 'fast']
  },
  {
    id: 'qwen3.7-max',
    developerId: 'qwen',
    displayName: 'Qwen 3.7 Max',
    tags: ['chat', 'reasoning']
  },
  {
    id: 'qwen3.7-plus',
    developerId: 'qwen',
    displayName: 'Qwen 3.7 Plus',
    tags: ['chat', 'reasoning', 'vision']
  },
  {
    id: 'qwen3.6-flash',
    developerId: 'qwen',
    displayName: 'Qwen 3.6 Flash',
    tags: ['chat', 'reasoning', 'vision', 'fast']
  },
  {
    id: 'deepseek-v4-pro',
    developerId: 'deepseek',
    displayName: 'DeepSeek V4 Pro',
    tags: ['chat', 'reasoning']
  },
  {
    id: 'deepseek-v4-pro-0813',
    developerId: 'deepseek',
    displayName: 'DeepSeek V4 Pro 0813',
    tags: ['chat', 'reasoning']
  },
  {
    id: 'deepseek-v4-flash-0731',
    developerId: 'deepseek',
    displayName: 'DeepSeek V4 Flash 0731',
    tags: ['chat', 'reasoning', 'fast']
  },
  {
    id: 'glm-5.2',
    developerId: 'zai',
    displayName: 'GLM-5.2',
    tags: ['chat', 'reasoning', 'code']
  }
] as const

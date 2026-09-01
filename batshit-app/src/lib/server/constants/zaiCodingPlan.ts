export const ZAI_CODING_PLAN_OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'

export const ZAI_CODING_PLAN_MODELS = [
  {
    id: 'glm-5.3',
    developerId: 'zai',
    displayName: 'GLM-5.3',
    tags: ['reasoning', 'tool-use', 'implicit-caching', 'code'],
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    modelType: 'chat'
  },
  {
    id: 'glm-5.3-flash',
    developerId: 'zai',
    displayName: 'GLM-5.3-Flash',
    tags: ['reasoning', 'tool-use', 'implicit-caching', 'code', 'vision', 'multimodal', 'fast'],
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    modelType: 'chat'
  }
] as const

export const ZAI_CODING_PLAN_MODEL_IDS = ZAI_CODING_PLAN_MODELS.map((model) => model.id)

/**
 * Older Coding Plan IDs that Z.ai currently accepts only as compatibility aliases.
 * They stay out of Batshit's catalog so users choose the actual model that will run.
 * Unknown future IDs discovered from /models are intentionally not filtered.
 */
export const ZAI_CODING_PLAN_LEGACY_MODEL_IDS = [
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5-turbo',
  'glm-5.1',
  'glm-5.2'
] as const

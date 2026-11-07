/** Existing hosted sync sources; instance-only/custom/account connections are outside this set. */
export const HOSTED_CATALOG_DIRECT_PROVIDER_IDS = [
  'openai', 'anthropic', 'google', 'mistral', 'groq', 'xai', 'deepseek', 'deepinfra',
  'moonshot', 'kimi_code', 'minimax', 'minimax_token_plan', 'mimo', 'mimo_token_plan',
  'qwencloud', 'qwen_token_plan', 'alibaba', 'stepfun', 'zai', 'zai_coding', 'togetherai', 'fireworks',
  'baseten', 'cerebras', 'fal', 'luma', 'replicate', 'elevenlabs', 'deepgram', 'assemblyai', 'cohere'
] as const

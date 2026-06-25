export type FalDeveloperKeywordOverride = {
  developerId: string
  tokens: string[]
}

export type FalDeveloperPrefixOverride = {
  prefix: string
  developerId: string
}

// Exact endpoint overrides (keys should be lower-case endpoint ids).
export const FAL_DEVELOPER_OVERRIDE_EXACT: Record<string, string> = {
}

// Prefix overrides run before keyword matching.
export const FAL_DEVELOPER_OVERRIDE_PREFIX: FalDeveloperPrefixOverride[] = [
]

// Keyword overrides fall back to detecting developer tokens in the endpoint id/display name.
export const FAL_DEVELOPER_OVERRIDE_KEYWORDS: FalDeveloperKeywordOverride[] = [
  { developerId: 'openai', tokens: ['gpt-image', 'dall-e', 'dalle'] },
  { developerId: 'openai', tokens: ['sora'] },
  { developerId: 'google', tokens: ['gemini', 'veo'] },
  { developerId: 'google', tokens: ['nano banana', 'nano-banana', 'nanobanana'] },
  { developerId: 'black-forest-labs', tokens: ['flux'] },
  { developerId: 'stability-ai', tokens: ['stable-diffusion', 'sdxl', 'stability'] },
  { developerId: 'microsoft', tokens: ['trellis'] },
  { developerId: 'minimax', tokens: ['minimax', 'hailuo'] },
  { developerId: 'ideogram', tokens: ['ideogram'] },
  { developerId: 'recraft', tokens: ['recraft'] },
  { developerId: 'bytedance', tokens: ['bytedance', 'doubao'] },
  { developerId: 'hunyuan3d', tokens: ['hunyuan3d', 'hunyuan-3d'] },
  { developerId: 'hunyuan', tokens: ['hunyuan'] },
  { developerId: 'kling', tokens: ['kling'] },
  { developerId: 'vidu', tokens: ['vidu'] },
  { developerId: 'pixverse', tokens: ['pixverse'] },
  { developerId: 'meshy', tokens: ['meshy'] },
  { developerId: 'qwen', tokens: ['qwen'] },
  { developerId: 'z-ai', tokens: ['z-ai', 'z.ai', 'zai', 'z-image'] },
  { developerId: 'longcat', tokens: ['longcat'] },
  { developerId: 'luma', tokens: ['luma'] },
  { developerId: 'elevenlabs', tokens: ['elevenlabs', 'eleven-labs'] },
  { developerId: 'deepseek', tokens: ['deepseek'] },
  { developerId: 'meta', tokens: ['sam', 'segment-anything'] },
  { developerId: 'wan', tokens: ['wan'] },
  { developerId: 'hidream', tokens: ['hidream'] },
  { developerId: 'runway', tokens: ['runway'] },
  { developerId: 'pika', tokens: ['pika'] }
]

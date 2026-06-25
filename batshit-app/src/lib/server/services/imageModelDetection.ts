/**
 * Image Model Detection Utility
 *
 * Detects whether a model is a dedicated image generation model
 * vs a multimodal LLM that can output images.
 *
 * @version 1.0.0
 * @since SA-011 Phase 1
 */

export type ImageModelType = 'dedicated' | 'multimodal' | 'text-only'

export interface ImageModelInfo {
  type: ImageModelType
  provider: 'openai' | 'luma' | 'fal' | 'replicate' | 'xai' | 'google' | 'azure' | null
  supportsN: boolean          // Can generate multiple images in one call
  maxImagesPerCall: number    // Max images per API call
  supportsAspectRatio: boolean
  supportsSize: boolean       // Dedicated image APIs may use size, not aspectRatio
  defaultAspectRatio?: string
  defaultSize?: string
}

/**
 * Known dedicated image generation models.
 * These use generateImage() from Vercel AI SDK, NOT streamText().
 */
const DEDICATED_IMAGE_MODELS: Record<string, Omit<ImageModelInfo, 'type'>> = {
  // OpenAI dedicated image models
  'dall-e-3': {
    provider: 'openai',
    supportsN: false,
    maxImagesPerCall: 1,
    supportsAspectRatio: false,
    supportsSize: true,
    defaultSize: '1024x1024'
  },
  'dall-e-2': {
    provider: 'openai',
    supportsN: true,
    maxImagesPerCall: 10,
    supportsAspectRatio: false,
    supportsSize: true,
    defaultSize: '1024x1024'
  },
  'gpt-image-1': {
    provider: 'openai',
    supportsN: true,
    maxImagesPerCall: 4,
    supportsAspectRatio: false,
    supportsSize: true,
    defaultSize: '1024x1024'
  },

  // Luma dedicated image models
  'photon-1': {
    provider: 'luma',
    supportsN: false,
    maxImagesPerCall: 1,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: '16:9'
  },
  'photon-flash-1': {
    provider: 'luma',
    supportsN: false,
    maxImagesPerCall: 1,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: '16:9'
  },

  // Fal dedicated image models (various patterns)
  'fal-ai/flux/dev': {
    provider: 'fal',
    supportsN: true,
    maxImagesPerCall: 4,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: '1:1'
  },
  'fal-ai/flux-pro': {
    provider: 'fal',
    supportsN: true,
    maxImagesPerCall: 4,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: '1:1'
  },
  'fal-ai/flux-pro/kontext': {
    provider: 'fal',
    supportsN: true,
    maxImagesPerCall: 4,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: '1:1'
  },

  // Replicate dedicated image models
  'black-forest-labs/flux-schnell': {
    provider: 'replicate',
    supportsN: true,
    maxImagesPerCall: 4,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: '16:9'
  },
  'black-forest-labs/flux-dev': {
    provider: 'replicate',
    supportsN: true,
    maxImagesPerCall: 4,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: '16:9'
  },

  // xAI / Grok Imagine dedicated image models
  'grok-imagine-image-quality': {
    provider: 'xai',
    supportsN: true,
    maxImagesPerCall: 10,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: 'auto'
  },
  'grok-imagine-image-quality-latest': {
    provider: 'xai',
    supportsN: true,
    maxImagesPerCall: 10,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: 'auto'
  },
  'grok-imagine-image-quality-20260403': {
    provider: 'xai',
    supportsN: true,
    maxImagesPerCall: 10,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: 'auto'
  },
  'grok-imagine-image-pro': {
    provider: 'xai',
    supportsN: true,
    maxImagesPerCall: 10,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: 'auto'
  },
  'grok-imagine-image': {
    provider: 'xai',
    supportsN: true,
    maxImagesPerCall: 10,
    supportsAspectRatio: true,
    supportsSize: false,
    defaultAspectRatio: 'auto'
  }
}

/**
 * Known multimodal LLMs that can output images.
 * These use streamText()/generateText() and return images in result.files[].
 */
const MULTIMODAL_IMAGE_MODELS: string[] = [
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image',
  'gemini-2.5-flash-image-preview',
  'gemini-2.0-flash-image',
  'gemini-2.0-flash-image-preview'
]

/**
 * Detect if a model is a dedicated image model, multimodal LLM, or text-only.
 *
 * @param modelId - Full model identifier, with or without a provider prefix.
 * @returns ImageModelInfo with type and capabilities
 */
export function detectImageModel(modelId: string): ImageModelInfo {
  // Normalize model ID - remove provider prefix if present
  const normalizedId = normalizeModelId(modelId)

  // Check dedicated image models first
  if (DEDICATED_IMAGE_MODELS[normalizedId]) {
    return {
      type: 'dedicated',
      ...DEDICATED_IMAGE_MODELS[normalizedId]
    }
  }

  // Check by pattern matching for fal/replicate models with various naming
  const falMatch = matchFalModel(modelId)
  if (falMatch) {
    return {
      type: 'dedicated',
      ...falMatch
    }
  }

  const openaiMatch = matchOpenAIImageModel(modelId)
  if (openaiMatch) {
    return {
      type: 'dedicated',
      ...openaiMatch
    }
  }

  const xaiMatch = matchXAIImageModel(modelId)
  if (xaiMatch) {
    return {
      type: 'dedicated',
      ...xaiMatch
    }
  }

  // Check multimodal image models
  if (isMultimodalImageModel(normalizedId)) {
    return {
      type: 'multimodal',
      provider: 'google',
      supportsN: false,
      maxImagesPerCall: 1,
      supportsAspectRatio: true,
      supportsSize: false
    }
  }

  // Default: text-only model
  return {
    type: 'text-only',
    provider: null,
    supportsN: false,
    maxImagesPerCall: 0,
    supportsAspectRatio: false,
    supportsSize: false
  }
}

/**
 * Check if a model is a dedicated image generation model.
 * Quick check for routing decisions.
 */
export function isDedicatedImageModel(modelId: string): boolean {
  const info = detectImageModel(modelId)
  return info.type === 'dedicated'
}

/**
 * Check if a model is a multimodal LLM that can output images.
 */
export function isMultimodalImageModel(modelId: string): boolean {
  const normalized = normalizeModelId(modelId)
  return MULTIMODAL_IMAGE_MODELS.some(m =>
    normalized.includes(m) || normalized === m
  )
}

/**
 * Check if a model can generate images (either dedicated or multimodal).
 */
export function canGenerateImages(modelId: string): boolean {
  const info = detectImageModel(modelId)
  return info.type !== 'text-only'
}

/**
 * Normalize model ID by removing common provider prefixes.
 */
function normalizeModelId(modelId: string): string {
  // Handle provider/model format
  if (modelId.includes('/')) {
    // Keep fal-ai/ and black-forest-labs/ prefixes as they're part of the model ID
    if (modelId.startsWith('fal-ai/') || modelId.startsWith('black-forest-labs/')) {
      return modelId
    }
    // Remove other provider prefixes
    const parts = modelId.split('/')
    return parts.slice(1).join('/')
  }
  return modelId
}

function matchXAIImageModel(modelId: string): Omit<ImageModelInfo, 'type'> | null {
  const normalized = normalizeModelId(modelId).toLowerCase()
  if (normalized.startsWith('grok-imagine-image')) {
    return {
      provider: 'xai',
      supportsN: true,
      maxImagesPerCall: 10,
      supportsAspectRatio: true,
      supportsSize: false,
      defaultAspectRatio: 'auto'
    }
  }

  return null
}

/**
 * Match Fal model patterns for flexible model naming.
 */
function matchFalModel(modelId: string): Omit<ImageModelInfo, 'type'> | null {
  const normalized = modelId.toLowerCase()

  // Match replicate flux patterns before the broader "flux" Fal catch-all.
  if (normalized.includes('black-forest-labs/') && normalized.includes('flux')) {
    return {
      provider: 'replicate',
      supportsN: true,
      maxImagesPerCall: 4,
      supportsAspectRatio: true,
      supportsSize: false,
      defaultAspectRatio: '16:9'
    }
  }

  // Match fal-ai/* patterns
  if (normalized.includes('fal-ai/') || normalized.includes('flux')) {
    return {
      provider: 'fal',
      supportsN: true,
      maxImagesPerCall: 4,
      supportsAspectRatio: true,
      supportsSize: false,
      defaultAspectRatio: '1:1'
    }
  }

  return null
}

/**
 * Match current and future OpenAI image model IDs.
 *
 * The public model catalog is the source of truth, but this fallback keeps
 * artifact routing correct when an agent passes a fresh OpenAI image ID before
 * the local catalog cache has refreshed.
 */
function matchOpenAIImageModel(modelId: string): Omit<ImageModelInfo, 'type'> | null {
  const normalized = normalizeModelId(modelId).toLowerCase()
  if (
    normalized.startsWith('gpt-image-') ||
    normalized === 'chatgpt-image-latest' ||
    normalized.startsWith('dall-e-') ||
    normalized.startsWith('dalle-')
  ) {
    return {
      provider: 'openai',
      supportsN: normalized === 'dall-e-2' || normalized === 'gpt-image-1',
      maxImagesPerCall: normalized === 'dall-e-2' ? 10 : normalized === 'gpt-image-1' ? 4 : 1,
      supportsAspectRatio: false,
      supportsSize: true,
      defaultSize: '1024x1024'
    }
  }

  return null
}

/**
 * Get the appropriate provider factory for a dedicated image model.
 * Used by the artifact completion endpoint to get the correct provider.
 */
export function getImageProviderInfo(modelId: string): {
  provider: 'openai' | 'luma' | 'fal' | 'replicate' | 'xai' | null
  factoryModel: string  // The model ID to pass to provider.image()
} {
  const info = detectImageModel(modelId)

  if (info.type !== 'dedicated' || !info.provider) {
    return { provider: null, factoryModel: modelId }
  }

  // For OpenAI, the model ID is just the model name
  if (info.provider === 'openai') {
    const normalized = normalizeModelId(modelId)
    return { provider: 'openai', factoryModel: normalized }
  }

  // For Luma, strip any prefix
  if (info.provider === 'luma') {
    const normalized = normalizeModelId(modelId)
    return { provider: 'luma', factoryModel: normalized }
  }

  // For Fal, keep the full path
  if (info.provider === 'fal') {
    return { provider: 'fal', factoryModel: modelId }
  }

  // For Replicate, keep the full path
  if (info.provider === 'replicate') {
    return { provider: 'replicate', factoryModel: modelId }
  }

  if (info.provider === 'xai') {
    const normalized = normalizeModelId(modelId)
    return { provider: 'xai', factoryModel: normalized }
  }

  return { provider: null, factoryModel: modelId }
}

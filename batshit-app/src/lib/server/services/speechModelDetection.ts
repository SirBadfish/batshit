/**
 * Speech Model Detection Utility
 *
 * Detects whether a model is a dedicated speech/TTS model supported by artifact completion.
 * Used by artifact completion to route speech requests to the correct provider.
 *
 * @version 1.0.0
 * @since SA-011 Phase 3
 */

import {
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES
} from '$lib/server/services/voiceModelCatalog'

export type SpeechModelType = 'dedicated' | 'none'
export type ArtifactSpeechProvider = 'openai' | 'fal'

export interface SpeechModelInfo {
  type: SpeechModelType
  provider: ArtifactSpeechProvider | null
  supportsVoice: boolean          // Can specify voice
  supportsLanguage: boolean       // Can specify language
  supportsInstructions: boolean   // Can provide voice instructions (e.g., OpenAI gpt-4o-mini-tts)
  defaultVoice?: string
  outputFormat?: string           // Default output format (mp3, wav, etc.)
}

const DEFAULT_OPENAI_TTS_VOICE = OPENAI_TTS_VOICES[0]

/**
 * Known dedicated speech/TTS models supported by artifact completion.
 * These use generateSpeech() from Vercel AI SDK.
 */
const DEDICATED_SPEECH_MODELS: Record<string, Omit<SpeechModelInfo, 'type'>> = {
  ...Object.fromEntries(
    OPENAI_TTS_MODELS.map((model) => [
      model,
      {
        provider: 'openai' as const,
        supportsVoice: true,
        supportsLanguage: false,
        supportsInstructions: model === 'gpt-4o-mini-tts',
        defaultVoice: DEFAULT_OPENAI_TTS_VOICE,
        outputFormat: 'mp3'
      }
    ])
  ),
  'fal-ai/minimax/speech-02-hd': {
    provider: 'fal',
    supportsVoice: true,
    supportsLanguage: false,
    supportsInstructions: false,
    outputFormat: 'mp3'
  }
}

/**
 * Detect if a model is a dedicated speech model.
 *
 * @param modelId - Full model identifier (e.g., 'tts-1', 'openai/tts-1', 'fal-ai/minimax/speech-02-hd')
 * @returns SpeechModelInfo with type and capabilities
 */
export function detectSpeechModel(modelId: string): SpeechModelInfo {
  // Normalize model ID - remove provider prefix if present
  const normalizedId = normalizeModelId(modelId)

  // Check dedicated speech models
  if (DEDICATED_SPEECH_MODELS[normalizedId]) {
    return {
      type: 'dedicated',
      ...DEDICATED_SPEECH_MODELS[normalizedId]
    }
  }

  // Check by pattern matching for fal models
  const falMatch = matchFalSpeechModel(modelId)
  if (falMatch) {
    return {
      type: 'dedicated',
      ...falMatch
    }
  }

  // Check for OpenAI pattern with provider prefix
  const openaiMatch = matchOpenAISpeechModel(modelId)
  if (openaiMatch) {
    return {
      type: 'dedicated',
      ...openaiMatch
    }
  }

  // Default: not a speech model
  return {
    type: 'none',
    provider: null,
    supportsVoice: false,
    supportsLanguage: false,
    supportsInstructions: false
  }
}

/**
 * Check if a model is a dedicated speech model.
 * Quick check for routing decisions.
 */
export function isDedicatedSpeechModel(modelId: string): boolean {
  const info = detectSpeechModel(modelId)
  return info.type === 'dedicated'
}

/**
 * Normalize model ID by removing common provider prefixes.
 */
function normalizeModelId(modelId: string): string {
  // Handle provider/model format
  if (modelId.includes('/')) {
    // Keep fal-ai/ prefix as it's part of the model ID
    if (modelId.startsWith('fal-ai/')) {
      return modelId
    }
    // Remove provider prefixes such as openai/.
    const parts = modelId.split('/')
    return parts.slice(1).join('/')
  }
  return modelId
}

/**
 * Match Fal speech model patterns.
 */
function matchFalSpeechModel(modelId: string): Omit<SpeechModelInfo, 'type'> | null {
  const normalized = modelId.toLowerCase()
  if (!normalized.startsWith('fal-ai/') && !normalized.startsWith('fal/')) {
    return null
  }
  if (
    normalized.includes('speech') ||
    normalized.includes('/speech') ||
    normalized.includes('tts') ||
    normalized.includes('/tts') ||
    normalized.includes('voice')
  ) {
    return {
      provider: 'fal',
      supportsVoice: true,
      supportsLanguage: false,
      supportsInstructions: false,
      outputFormat: 'mp3'
    }
  }
  return null
}

/**
 * Match OpenAI speech model patterns.
 */
function matchOpenAISpeechModel(modelId: string): Omit<SpeechModelInfo, 'type'> | null {
  const normalized = normalizeModelId(modelId)
  if (OPENAI_TTS_MODELS.includes(normalized as typeof OPENAI_TTS_MODELS[number])) {
    return DEDICATED_SPEECH_MODELS[normalized] || {
      provider: 'openai',
      supportsVoice: true,
      supportsLanguage: false,
      supportsInstructions: false,
      defaultVoice: DEFAULT_OPENAI_TTS_VOICE,
      outputFormat: 'mp3'
    }
  }
  return null
}

/**
 * Get the appropriate provider factory for a dedicated speech model.
 * Used by the artifact completion endpoint to get the correct provider.
 */
export function getSpeechProviderInfo(modelId: string): {
  provider: ArtifactSpeechProvider | null
  factoryModel: string  // The model ID to pass to provider.speech()
} {
  const info = detectSpeechModel(modelId)

  if (info.type !== 'dedicated' || !info.provider) {
    return { provider: null, factoryModel: modelId }
  }

  // For OpenAI, the model ID is just the model name
  if (info.provider === 'openai') {
    const normalized = normalizeModelId(modelId)
    return { provider: 'openai', factoryModel: normalized }
  }

  // For Fal, keep the full path
  if (info.provider === 'fal') {
    return { provider: 'fal', factoryModel: modelId }
  }

  return { provider: null, factoryModel: modelId }
}

import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'

export type LiveKitSpeechToSpeechProviderId = 'openai' | 'google' | 'xai'
export type LiveKitProviderKeyId = LiveKitSpeechToSpeechProviderId | 'deepgram'

type LiveKitProviderKeyConfig = {
  id: LiveKitProviderKeyId
  label: string
  service: string
  envVars: string[]
  setupHint: string
}

const PROVIDERS: Record<LiveKitProviderKeyId, LiveKitProviderKeyConfig> = {
  openai: {
    id: 'openai',
    label: 'OpenAI Realtime',
    service: 'openai',
    envVars: ['OPENAI_API_KEY'],
    setupHint: 'Add an OpenAI API key in Settings -> API Keys, or set OPENAI_API_KEY for the LiveKit sidecar.'
  },
  google: {
    id: 'google',
    label: 'Gemini Live',
    service: 'google',
    envVars: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    setupHint: 'Add a Google API key in Settings -> API Keys, or set GOOGLE_API_KEY for the LiveKit sidecar.'
  },
  xai: {
    id: 'xai',
    label: 'Grok Voice',
    service: 'xai',
    envVars: ['XAI_API_KEY'],
    setupHint: 'Add an xAI API key in Settings -> API Keys, or set XAI_API_KEY for the LiveKit sidecar.'
  },
  deepgram: {
    id: 'deepgram',
    label: 'Deepgram',
    service: 'deepgram',
    envVars: ['DEEPGRAM_API_KEY'],
    setupHint:
      'Add a Deepgram API key in Settings -> API Keys, or set DEEPGRAM_API_KEY for the LiveKit sidecar.'
  }
}

export function normalizeLiveKitProviderKeyId(value: unknown): LiveKitProviderKeyId | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (
    normalized === 'openai' ||
    normalized === 'google' ||
    normalized === 'xai' ||
    normalized === 'deepgram'
  ) {
    return normalized
  }
  if (normalized === 'grok' || normalized === 'x-ai') return 'xai'
  if (
    normalized === 'gemini' ||
    normalized === 'google-ai' ||
    normalized === 'google-generative-ai' ||
    normalized === 'google-vertex' ||
    normalized === 'vertex-ai'
  ) {
    return 'google'
  }
  return null
}

export function normalizeLiveKitSpeechToSpeechProviderId(
  value: unknown
): LiveKitSpeechToSpeechProviderId | null {
  const providerId = normalizeLiveKitProviderKeyId(value)
  return providerId === 'openai' || providerId === 'google' || providerId === 'xai'
    ? providerId
    : null
}

export function getLiveKitProviderKeyConfig(providerId: LiveKitProviderKeyId): LiveKitProviderKeyConfig {
  return PROVIDERS[providerId]
}

export function getLiveKitSpeechToSpeechProviderConfig(
  providerId: LiveKitSpeechToSpeechProviderId
): LiveKitProviderKeyConfig {
  return PROVIDERS[providerId]
}

function firstEnvValue(keys: string[]): string | null {
  const envMap = {
    ...(env as Record<string, string | undefined>),
    ...(process.env as Record<string, string | undefined>)
  }
  for (const key of keys) {
    const value = envMap[key]?.trim()
    if (value) return value
  }
  return null
}

export async function resolveLiveKitProviderKey(
  userId: string,
  providerId: LiveKitProviderKeyId
): Promise<{ apiKey: string | null; source: 'user' | 'env' | null }> {
  const config = getLiveKitProviderKeyConfig(providerId)
  const userKey = await apiKeyService.retrieve(config.service, userId).catch(() => null)
  const trimmedUserKey = userKey?.trim()
  if (trimmedUserKey) {
    return { apiKey: trimmedUserKey, source: 'user' }
  }

  const envKey = firstEnvValue(config.envVars)
  if (envKey) {
    return { apiKey: envKey, source: 'env' }
  }

  return { apiKey: null, source: null }
}

export async function resolveLiveKitSpeechToSpeechProviderKey(
  userId: string,
  providerId: LiveKitSpeechToSpeechProviderId
): Promise<{ apiKey: string | null; source: 'user' | 'env' | null }> {
  return resolveLiveKitProviderKey(userId, providerId)
}

export async function assertLiveKitSpeechToSpeechProviderReady(
  userId: string,
  providerId: LiveKitSpeechToSpeechProviderId
): Promise<void> {
  const resolved = await resolveLiveKitSpeechToSpeechProviderKey(userId, providerId)
  if (resolved.apiKey) return

  const config = getLiveKitSpeechToSpeechProviderConfig(providerId)
  throw new Error(`${config.label} API key is required for LiveKit speech-to-speech. ${config.setupHint}`)
}

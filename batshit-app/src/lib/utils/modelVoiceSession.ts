import type { SavedModel, ModelVoiceSessionConfig } from '$lib/types/savedModels'

type VoiceSessionInput = Partial<ModelVoiceSessionConfig> | null | undefined

export type LiveKitSpeechToSpeechProviderPlan = {
  providerId: string
  providerLabel: string
  adapterId: string
  defaultModelId?: string
  defaultVoiceId?: string
  supportStatus: NonNullable<ModelVoiceSessionConfig['supportStatus']>
  nodeSupport: boolean
  pythonSupport: boolean
  priority: number
  notes?: string[]
}

const DEFAULT_INCLUDED_LANES = {
  stt: true,
  llm: true,
  tts: true
} as const

export const LIVEKIT_SPEECH_TO_SPEECH_PROVIDER_PLAN: LiveKitSpeechToSpeechProviderPlan[] = [
  {
    providerId: 'openai',
    providerLabel: 'OpenAI Realtime',
    adapterId: 'livekit-openai-realtime',
    defaultModelId: 'gpt-realtime-2',
    defaultVoiceId: 'marin',
    supportStatus: 'supported',
    nodeSupport: true,
    pythonSupport: true,
    priority: 10,
    notes: ['First productized adapter because the local LiveKit spike already proved the experience.']
  },
  {
    providerId: 'google',
    providerLabel: 'Gemini Live',
    adapterId: 'livekit-gemini-live',
    defaultModelId: 'gemini-live-2.5-flash-native-audio',
    defaultVoiceId: 'Puck',
    supportStatus: 'supported',
    nodeSupport: true,
    pythonSupport: true,
    priority: 20,
    notes: ['Separate from normal Google Cloud TTS/STT. Uses the LiveKit Gemini realtime adapter.']
  },
  {
    providerId: 'xai',
    providerLabel: 'Grok Voice',
    adapterId: 'livekit-xai-grok-voice',
    defaultModelId: 'grok-voice-think-fast-1.0',
    defaultVoiceId: 'ara',
    supportStatus: 'supported',
    nodeSupport: true,
    pythonSupport: true,
    priority: 30,
    notes: ['Grok Voice support uses the LiveKit xAI realtime adapter.']
  },
  {
    providerId: 'azure-openai',
    providerLabel: 'Azure OpenAI Realtime',
    adapterId: 'livekit-azure-openai-realtime',
    supportStatus: 'watchlist',
    nodeSupport: true,
    pythonSupport: true,
    priority: 40
  },
  {
    providerId: 'phonic',
    providerLabel: 'Phonic Speech-to-speech',
    adapterId: 'livekit-phonic-speech-to-speech',
    supportStatus: 'watchlist',
    nodeSupport: true,
    pythonSupport: true,
    priority: 50
  },
  {
    providerId: 'amazon-nova-sonic',
    providerLabel: 'Amazon Nova Sonic',
    adapterId: 'livekit-amazon-nova-sonic',
    supportStatus: 'watchlist',
    nodeSupport: false,
    pythonSupport: true,
    priority: 60,
    notes: ['Python-only in current LiveKit docs.']
  },
  {
    providerId: 'ultravox',
    providerLabel: 'Ultravox Realtime',
    adapterId: 'livekit-ultravox-realtime',
    supportStatus: 'watchlist',
    nodeSupport: false,
    pythonSupport: true,
    priority: 70,
    notes: ['Python-only in current LiveKit docs.']
  },
  {
    providerId: 'nvidia-personaplex',
    providerLabel: 'NVIDIA PersonaPlex',
    adapterId: 'livekit-nvidia-personaplex',
    supportStatus: 'watchlist',
    nodeSupport: false,
    pythonSupport: true,
    priority: 80,
    notes: ['Experimental self-hosted/local research candidate, not a normal launch recommendation.']
  }
]

const PROVIDER_PLAN_BY_ID = new Map(
  LIVEKIT_SPEECH_TO_SPEECH_PROVIDER_PLAN.map((provider) => [provider.providerId, provider])
)

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeLower(value: unknown): string {
  return normalizeString(value).toLowerCase()
}

function normalizeProviderAlias(value: unknown): string {
  const normalized = normalizeLower(value)
  if (normalized === 'x-ai' || normalized === 'grok') return 'xai'
  if (
    normalized === 'gemini' ||
    normalized === 'google-ai' ||
    normalized === 'google-generative-ai' ||
    normalized === 'google-vertex' ||
    normalized === 'vertex-ai'
  ) {
    return 'google'
  }
  return normalized
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function normalizeModelVoiceSessionConfig(
  value: VoiceSessionInput
): ModelVoiceSessionConfig | undefined {
  if (!value || typeof value !== 'object') return undefined

  const runtime = normalizeLower(value.runtime)
  const mode = normalizeLower(value.mode)
  if (runtime !== 'livekit' || mode !== 'speech-to-speech') return undefined

  const providerId = normalizeProviderAlias(value.providerId)
  if (!providerId) return undefined

  const plan = PROVIDER_PLAN_BY_ID.get(providerId)
  const defaultModelId = normalizeString(value.defaultModelId) || plan?.defaultModelId
  const defaultVoiceId = normalizeString(value.defaultVoiceId) || plan?.defaultVoiceId

  return {
    runtime: 'livekit',
    mode: 'speech-to-speech',
    providerId,
    providerLabel: normalizeString(value.providerLabel) || plan?.providerLabel,
    adapterId: normalizeString(value.adapterId) || plan?.adapterId,
    defaultModelId,
    defaultVoiceId,
    includes: {
      ...DEFAULT_INCLUDED_LANES,
      ...(value.includes ?? {})
    },
    requiresLiveKit: normalizeBoolean(value.requiresLiveKit) ?? true,
    locksVoiceModeSettings: normalizeBoolean(value.locksVoiceModeSettings) ?? true,
    supportStatus: value.supportStatus ?? plan?.supportStatus ?? 'watchlist',
    nodeSupport: normalizeBoolean(value.nodeSupport) ?? plan?.nodeSupport ?? false,
    pythonSupport: normalizeBoolean(value.pythonSupport) ?? plan?.pythonSupport ?? false,
    transcriptTiming: value.transcriptTiming ?? 'provider-dependent',
    toolSupport: value.toolSupport ?? 'batshit-bridge',
    notes: Array.isArray(value.notes) ? value.notes.map(String).filter(Boolean) : plan?.notes
  }
}

export function inferLiveKitSpeechToSpeechConfig(
  provider: unknown,
  modelId: unknown
): ModelVoiceSessionConfig | undefined {
  const normalizedProvider = normalizeProviderAlias(provider)
  const normalizedModel = normalizeLower(modelId)
  if (!normalizedProvider && !normalizedModel) return undefined

  if (
    normalizedProvider === 'openai' &&
    (normalizedModel === 'gpt-realtime' || normalizedModel.startsWith('gpt-realtime-'))
  ) {
    return normalizeModelVoiceSessionConfig({
      runtime: 'livekit',
      mode: 'speech-to-speech',
      providerId: 'openai'
    })
  }

  if (
    normalizedProvider === 'google' &&
    (normalizedModel.includes('gemini') &&
      (normalizedModel.includes('live') || normalizedModel.includes('native-audio')))
  ) {
    return normalizeModelVoiceSessionConfig({
      runtime: 'livekit',
      mode: 'speech-to-speech',
      providerId: 'google',
      defaultModelId: normalizeString(modelId)
    })
  }

  if (
    normalizedProvider === 'xai' &&
    (normalizedModel.includes('voice') || normalizedModel.includes('realtime') || !normalizedModel)
  ) {
    return normalizeModelVoiceSessionConfig({
      runtime: 'livekit',
      mode: 'speech-to-speech',
      providerId: 'xai',
      defaultModelId: normalizeString(modelId) || undefined
    })
  }

  return undefined
}

export function resolveModelVoiceSessionConfig(
  model: Pick<SavedModel, 'provider' | 'modelId' | 'settings' | 'voiceSession'> | null | undefined
): ModelVoiceSessionConfig | undefined {
  if (!model) return undefined

  const explicit =
    normalizeModelVoiceSessionConfig(model.voiceSession) ??
    normalizeModelVoiceSessionConfig(
      model.settings && typeof model.settings === 'object'
        ? (model.settings.voiceSession as VoiceSessionInput)
        : undefined
    )
  if (explicit) return explicit

  return inferLiveKitSpeechToSpeechConfig(model.provider, model.modelId)
}

export function isLiveKitSpeechToSpeechModelPreset(
  model: Pick<SavedModel, 'provider' | 'modelId' | 'settings' | 'voiceSession'> | null | undefined
): boolean {
  const config = resolveModelVoiceSessionConfig(model)
  return config?.runtime === 'livekit' && config.mode === 'speech-to-speech'
}

export function shouldRouteLiveKitRemoteAudioToGoon(
  voiceSession: Pick<ModelVoiceSessionConfig, 'runtime' | 'mode'> | null | undefined
): boolean {
  return voiceSession?.runtime === 'livekit' && voiceSession.mode === 'speech-to-speech'
}

export function getVoiceModeLockLabel(
  model: Pick<SavedModel, 'modelName' | 'provider' | 'modelId' | 'settings' | 'voiceSession'> | null | undefined
): string | null {
  const config = resolveModelVoiceSessionConfig(model)
  if (!config?.locksVoiceModeSettings) return null

  const providerLabel = config.providerLabel || config.providerId
  const modelLabel = model?.modelName || config.defaultModelId || model?.modelId || providerLabel
  return `${modelLabel} is a true speech-to-speech preset. It already includes listening, reasoning, and speaking through ${providerLabel}.`
}

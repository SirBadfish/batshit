export const LIVEKIT_VOICE_RUNTIME_ID = 'livekit' as const
export const LIVEKIT_VOICE_TRANSPORT = 'webrtc' as const

export type LiveKitVoiceRuntimeId = typeof LIVEKIT_VOICE_RUNTIME_ID
export type LiveKitVoiceTransport = typeof LIVEKIT_VOICE_TRANSPORT

export type LiveKitSpeechToSpeechSessionConfig = {
  enabled?: boolean | null
  providerId?: string | null
  providerLabel?: string | null
  adapterId?: string | null
  modelId?: string | null
  voiceId?: string | null
  instructions?: string | null
}

export type LiveKitVoiceSessionRequest = {
  sessionId?: string | null
  agentId?: string | null
  groupId?: string | null
  roomName?: string | null
  participantName?: string | null
  metadata?: Record<string, string | number | boolean | null | undefined> | null
  speechToSpeech?: LiveKitSpeechToSpeechSessionConfig | null
  agentDispatch?: {
    enabled?: boolean | null
    required?: boolean | null
    agentName?: string | null
    metadata?: Record<string, string | number | boolean | null | undefined> | null
  } | null
}

export type LiveKitVoiceSessionResponse = {
  runtime: LiveKitVoiceRuntimeId
  transport: LiveKitVoiceTransport
  mode: 'room-token'
  serverUrl: string
  roomName: string
  participantIdentity: string
  participantName: string
  token: string
  expiresInSec: number
  permissions: {
    canPublish: boolean
    canSubscribe: boolean
    canPublishData: boolean
  }
  selfHosted: boolean
  createdAt: string
  agentDispatch?: {
    requested: boolean
    required: boolean
    agentName?: string
    dispatchId?: string
    metadata?: string
    warning?: string
  }
}

export type LiveKitVoiceSessionError = {
  error: string
  setupHint?: string
  runtime: LiveKitVoiceRuntimeId
  fallback: false
}

import type { VoiceModeTurnSettings, VoiceProviderId, VoiceSttTransport } from '$lib/types/voice'

export type VoiceRealtimeSttProvider =
  | 'browser'
  | 'openai'
  | 'deepgram'
  | 'elevenlabs'
  | 'byo'

export type VoiceRealtimeSttEventType =
  | 'start'
  | 'speech_start'
  | 'partial'
  | 'final'
  | 'endpoint'
  | 'speech_resume'
  | 'error'
  | 'end'

export type VoiceRealtimeSttWord = {
  word: string
  startSec?: number | null
  endSec?: number | null
  confidence?: number | null
}

export type VoiceRealtimeSttEvent = {
  type: VoiceRealtimeSttEventType
  provider: VoiceRealtimeSttProvider
  sessionId?: string | null
  transcript?: string | null
  confidence?: number | null
  language?: string | null
  words?: VoiceRealtimeSttWord[] | null
  reason?: string | null
  error?: string | null
  raw?: unknown
}

export type VoiceRealtimeSttSessionMode =
  | 'browser'
  | 'direct-provider-candidate'
  | 'livekit-candidate'
  | 'byo-local-websocket'

export type VoiceRealtimeSttSessionProvider = 'browser' | 'openai' | 'deepgram' | 'elevenlabs' | 'byo'

export type VoiceRealtimeSttRequestedMode = 'direct' | 'livekit'

export type VoiceRealtimeSttAudioContract = {
  encoding: string
  sampleRate: number
  channels: number
  chunkMs?: number
}

export type VoiceRealtimeSttProviderConnectionPlan = {
  method: 'browser-api' | 'websocket' | 'webrtc'
  endpoint?: string
  docsUrl: string
  query?: Record<string, string | number | boolean | string[]>
  headers?: string[]
  auth?: {
    kind: 'deepgram-temporary-token'
    tokenEndpoint: string
    websocketProtocol: 'bearer'
    expiresInSeconds: number
  }
  messages?: Array<Record<string, unknown>>
}

export type VoiceRealtimeSttSessionRequest = {
  provider?: VoiceProviderId
  model?: string
  language?: string
  mode?: VoiceRealtimeSttRequestedMode
  voiceMode?: VoiceModeTurnSettings
  audio?: Partial<VoiceRealtimeSttAudioContract>
}

export type VoiceRealtimeSttSessionContract = {
  provider: VoiceRealtimeSttSessionProvider
  voiceProviderId: VoiceProviderId
  mode: VoiceRealtimeSttSessionMode
  model?: string
  language?: string
  ready: boolean
  launchSupported: boolean
  launchBlockedReason?: string
  transport: VoiceSttTransport
  realtimeEvents: VoiceRealtimeSttEventType[]
  audio: VoiceRealtimeSttAudioContract
  serverBridgeRequired: boolean
  clientMayConnectDirectly: boolean
  secretsExposed: false
  providerConfig: VoiceRealtimeSttProviderConnectionPlan
  notes: string[]
}

export type VoiceRealtimeSttSessionError = {
  error: string
  setupHint?: string
  runtime: 'realtime-stt'
  fallback: false
}

export type VoiceRealtimeSttEphemeralToken = {
  provider: 'deepgram'
  accessToken: string
  tokenType: 'bearer'
  expiresIn: number
  expiresAt: string
}

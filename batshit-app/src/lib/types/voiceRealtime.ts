import type { VoiceProviderId } from './voice'

export const VOICE_REALTIME_TTS_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

export type VoiceRealtimeAudioFormat = 'pcm_s16le'

export type VoiceRealtimeTtsAlignmentSegment = {
  text: string
  startSec: number
  endSec: number
  chunkSeq?: number | null
  chunkAudioOffsetSec?: number | null
  phoneticDetails?: Array<{
    phoneSymbol?: string
    startTimeSeconds?: number
    durationSeconds?: number
    visemeSymbol?: string
  }>
}

export type VoiceRealtimeTtsStartEvent = {
  type: 'start'
  provider: VoiceProviderId
  model?: string | null
  voiceId?: string | null
  mediaType: string
  audioFormat: VoiceRealtimeAudioFormat
  sampleRate: number
  channels: number
}

export type VoiceRealtimeTtsAudioEvent = {
  type: 'audio'
  sequence: number
  audioBase64: string
  byteLength: number
  content?: string | null
  alignment?: unknown
  chunkSeq?: number | null
  chunkAudioOffsetSec?: number | null
}

export type VoiceRealtimeTtsEndEvent = {
  type: 'end'
  chunkCount: number
  audioBytes: number
  elapsedMs: number
}

export type VoiceRealtimeTtsErrorEvent = {
  type: 'error'
  error: string
  setupHint?: string
  status?: number
  fallback: false
}

export type VoiceRealtimeTtsEvent =
  | VoiceRealtimeTtsStartEvent
  | VoiceRealtimeTtsAudioEvent
  | VoiceRealtimeTtsEndEvent
  | VoiceRealtimeTtsErrorEvent

import type {
  VoiceRealtimeSttEvent,
  VoiceRealtimeSttProvider,
  VoiceRealtimeSttWord
} from '$lib/types/voiceRealtimeStt'

type NormalizerOptions = {
  sessionId?: string | null
  language?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return null
}

function normalizeWords(value: unknown): VoiceRealtimeSttWord[] | null {
  if (!Array.isArray(value)) return null
  const words: VoiceRealtimeSttWord[] = []

  for (const entry of value) {
    if (typeof entry === 'string') {
      words.push({ word: entry })
      continue
    }
    if (!isRecord(entry)) continue
    const word = pickString(entry.word, entry.text, entry.token)
    if (!word) continue
    words.push({
      word,
      startSec: pickNumber(entry.start, entry.start_sec, entry.startSec),
      endSec: pickNumber(entry.end, entry.end_sec, entry.endSec),
      confidence: pickNumber(entry.confidence)
    })
  }

  return words.length > 0 ? words : null
}

function eventBase(
  provider: VoiceRealtimeSttProvider,
  payload: Record<string, unknown>,
  options?: NormalizerOptions
): Pick<VoiceRealtimeSttEvent, 'provider' | 'sessionId' | 'language' | 'raw'> {
  return {
    provider,
    sessionId: pickString(payload.session_id, payload.sessionId, options?.sessionId),
    language: pickString(payload.language, payload.language_code, options?.language),
    raw: payload
  }
}

function buildTranscriptEvent(
  type: 'partial' | 'final',
  provider: VoiceRealtimeSttProvider,
  payload: Record<string, unknown>,
  options?: NormalizerOptions
): VoiceRealtimeSttEvent {
  return {
    ...eventBase(provider, payload, options),
    type,
    transcript: pickString(
      payload.transcript,
      payload.text,
      payload.utterance,
      payload.channel && isRecord(payload.channel) ? payload.channel.transcript : null
    ),
    confidence: pickNumber(payload.confidence),
    words: normalizeWords(payload.words)
  }
}

export function normalizeDeepgramFluxRealtimeSttEvent(
  payload: unknown,
  options?: NormalizerOptions
): VoiceRealtimeSttEvent[] {
  if (!isRecord(payload)) return []

  const messageType = pickString(payload.type, payload.message_type)?.toLowerCase()
  const eventName =
    (messageType === 'turninfo' ? pickString(payload.event) : pickString(payload.type, payload.event))?.toLowerCase()
  if (!eventName) return []

  if (eventName === 'receiveconnected' || eventName === 'open' || eventName === 'started') {
    return [{ ...eventBase('deepgram', payload, options), type: 'start' }]
  }

  if (eventName === 'receivefatalerror') {
    return [
      {
        ...eventBase('deepgram', payload, options),
        type: 'error',
        error: pickString(payload.error, payload.message, payload.reason) ?? 'Deepgram realtime STT error'
      }
    ]
  }

  if (eventName === 'update' || eventName === 'transcript' || eventName === 'partial') {
    return [buildTranscriptEvent('partial', 'deepgram', payload, options)]
  }

  if (eventName === 'startofturn' || eventName === 'speech_started') {
    const transcript = pickString(payload.transcript, payload.text, payload.utterance)
    return [
      {
        ...eventBase('deepgram', payload, options),
        type: 'speech_start',
        ...(transcript ? { transcript } : {})
      }
    ]
  }

  if (eventName === 'endofturn') {
    const finalEvent = buildTranscriptEvent('final', 'deepgram', payload, options)
    const endpointEvent: VoiceRealtimeSttEvent = {
      ...eventBase('deepgram', payload, options),
      type: 'endpoint',
      reason: 'end_of_turn'
    }
    const events: VoiceRealtimeSttEvent[] = [
      {
        ...finalEvent
      },
      endpointEvent
    ]
    return events.filter((event) => event.type !== 'final' || Boolean(event.transcript))
  }

  if (eventName === 'eagerendofturn') {
    return [
      {
        ...eventBase('deepgram', payload, options),
        type: 'endpoint',
        reason: 'eager_end_of_turn'
      }
    ]
  }

  if (eventName === 'turnresumed') {
    return [{ ...eventBase('deepgram', payload, options), type: 'speech_resume' }]
  }

  if (eventName === 'close' || eventName === 'closed') {
    return [{ ...eventBase('deepgram', payload, options), type: 'end' }]
  }

  if (eventName === 'error') {
    return [
      {
        ...eventBase('deepgram', payload, options),
        type: 'error',
        error: pickString(payload.error, payload.message, payload.reason) ?? 'Deepgram realtime STT error'
      }
    ]
  }

  return []
}

export function normalizeElevenLabsRealtimeSttEvent(
  payload: unknown,
  options?: NormalizerOptions
): VoiceRealtimeSttEvent[] {
  if (!isRecord(payload)) return []

  const messageType = pickString(payload.message_type, payload.type, payload.event)?.toLowerCase()
  if (!messageType) return []

  if (messageType === 'session_started' || messageType === 'started') {
    return [{ ...eventBase('elevenlabs', payload, options), type: 'start' }]
  }

  if (messageType === 'speech_start' || messageType === 'speech_started') {
    return [{ ...eventBase('elevenlabs', payload, options), type: 'speech_start' }]
  }

  if (messageType === 'partial_transcript' || messageType === 'partial') {
    return [buildTranscriptEvent('partial', 'elevenlabs', payload, options)]
  }

  if (
    messageType === 'committed_transcript' ||
    messageType === 'committed_transcript_with_timestamps' ||
    messageType === 'final'
  ) {
    return [buildTranscriptEvent('final', 'elevenlabs', payload, options)]
  }

  if (messageType === 'endpoint' || messageType === 'speech_end') {
    return [
      {
        ...eventBase('elevenlabs', payload, options),
        type: 'endpoint',
        reason: pickString(payload.reason) ?? 'speech_end'
      }
    ]
  }

  if (messageType === 'error') {
    return [
      {
        ...eventBase('elevenlabs', payload, options),
        type: 'error',
        error: pickString(payload.error, payload.message, payload.reason) ?? 'ElevenLabs realtime STT error'
      }
    ]
  }

  return []
}

export function normalizeOpenAIRealtimeTranscriptionEvent(
  payload: unknown,
  options?: NormalizerOptions
): VoiceRealtimeSttEvent[] {
  if (!isRecord(payload)) return []

  const eventType = pickString(payload.type, payload.event)?.toLowerCase()
  if (!eventType) return []

  if (
    eventType === 'session.created' ||
    eventType === 'session.updated' ||
    eventType === 'transcription_session.created' ||
    eventType === 'transcription_session.updated'
  ) {
    return [{ ...eventBase('openai', payload, options), type: 'start' }]
  }

  if (eventType === 'input_audio_buffer.speech_started') {
    return [{ ...eventBase('openai', payload, options), type: 'speech_start' }]
  }

  if (eventType === 'input_audio_buffer.speech_stopped') {
    return [
      {
        ...eventBase('openai', payload, options),
        type: 'endpoint',
        reason: 'speech_stopped'
      }
    ]
  }

  if (eventType === 'conversation.item.input_audio_transcription.delta') {
    return [
      {
        ...eventBase('openai', payload, options),
        type: 'partial',
        transcript: pickString(payload.delta, payload.transcript, payload.text)
      }
    ]
  }

  if (eventType === 'conversation.item.input_audio_transcription.completed') {
    return [buildTranscriptEvent('final', 'openai', payload, options)]
  }

  if (eventType === 'conversation.item.input_audio_transcription.failed') {
    const errorPayload = isRecord(payload.error) ? payload.error : {}
    return [
      {
        ...eventBase('openai', payload, options),
        type: 'error',
        error:
          pickString(errorPayload.message, payload.error, payload.message, payload.reason) ??
          'OpenAI realtime transcription error'
      }
    ]
  }

  if (eventType === 'error') {
    const errorPayload = isRecord(payload.error) ? payload.error : {}
    return [
      {
        ...eventBase('openai', payload, options),
        type: 'error',
        error:
          pickString(errorPayload.message, payload.error, payload.message, payload.reason) ??
          'OpenAI realtime STT error'
      }
    ]
  }

  return []
}

export function normalizeByoRealtimeSttEvent(
  payload: unknown,
  options?: NormalizerOptions
): VoiceRealtimeSttEvent[] {
  if (!isRecord(payload)) return []

  const eventType = pickString(payload.type, payload.event)?.toLowerCase()
  if (!eventType) return []

  if (eventType === 'start' || eventType === 'started' || eventType === 'open') {
    return [{ ...eventBase('byo', payload, options), type: 'start' }]
  }

  if (eventType === 'speech_start' || eventType === 'speech_started' || eventType === 'startofturn') {
    return [{ ...eventBase('byo', payload, options), type: 'speech_start' }]
  }

  if (eventType === 'partial' || eventType === 'transcript_partial') {
    return [buildTranscriptEvent('partial', 'byo', payload, options)]
  }

  if (eventType === 'final' || eventType === 'transcript_final' || eventType === 'endofturn') {
    return [buildTranscriptEvent('final', 'byo', payload, options)]
  }

  if (eventType === 'endpoint' || eventType === 'speech_end' || eventType === 'speech_stopped') {
    return [
      {
        ...eventBase('byo', payload, options),
        type: 'endpoint',
        reason: pickString(payload.reason) ?? 'speech_end'
      }
    ]
  }

  if (eventType === 'speech_resume' || eventType === 'turnresumed') {
    return [{ ...eventBase('byo', payload, options), type: 'speech_resume' }]
  }

  if (eventType === 'end' || eventType === 'close' || eventType === 'closed') {
    return [{ ...eventBase('byo', payload, options), type: 'end' }]
  }

  if (eventType === 'error') {
    return [
      {
        ...eventBase('byo', payload, options),
        type: 'error',
        error: pickString(payload.error, payload.message, payload.reason) ?? 'BYO realtime STT error'
      }
    ]
  }

  return []
}

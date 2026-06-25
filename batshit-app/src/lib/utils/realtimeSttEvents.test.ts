import { describe, expect, it } from 'vitest'
import {
  normalizeDeepgramFluxRealtimeSttEvent,
  normalizeElevenLabsRealtimeSttEvent,
  normalizeOpenAIRealtimeTranscriptionEvent
} from './realtimeSttEvents'

describe('realtime STT event normalizers', () => {
  it('maps Deepgram Flux turn events to Batshit realtime STT events', () => {
    expect(normalizeDeepgramFluxRealtimeSttEvent({ type: 'StartOfTurn' })).toMatchObject([
      { provider: 'deepgram', type: 'speech_start' }
    ])

    expect(
      normalizeDeepgramFluxRealtimeSttEvent({
        type: 'Update',
        transcript: 'hello',
        confidence: 0.92
      })
    ).toMatchObject([{ provider: 'deepgram', type: 'partial', transcript: 'hello', confidence: 0.92 }])

    expect(
      normalizeDeepgramFluxRealtimeSttEvent({
        type: 'EndOfTurn',
        transcript: 'hello there'
      })
    ).toMatchObject([
      { provider: 'deepgram', type: 'final', transcript: 'hello there' },
      { provider: 'deepgram', type: 'endpoint', reason: 'end_of_turn' }
    ])
  })

  it('maps real Deepgram Flux TurnInfo envelopes to Batshit events', () => {
    expect(
      normalizeDeepgramFluxRealtimeSttEvent({
        type: 'receiveConnected',
        request_id: 'request-1'
      })
    ).toMatchObject([{ provider: 'deepgram', type: 'start' }])

    expect(
      normalizeDeepgramFluxRealtimeSttEvent({
        type: 'TurnInfo',
        event: 'StartOfTurn',
        request_id: 'request-1',
        transcript: 'hello'
      })
    ).toMatchObject([{ provider: 'deepgram', type: 'speech_start', transcript: 'hello' }])

    expect(
      normalizeDeepgramFluxRealtimeSttEvent({
        type: 'TurnInfo',
        event: 'Update',
        request_id: 'request-1',
        transcript: 'hello there',
        words: [{ word: 'hello', confidence: 0.96 }]
      })
    ).toMatchObject([
      {
        provider: 'deepgram',
        type: 'partial',
        transcript: 'hello there',
        words: [{ word: 'hello', confidence: 0.96 }]
      }
    ])

    expect(
      normalizeDeepgramFluxRealtimeSttEvent({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        request_id: 'request-1',
        transcript: 'hello there'
      })
    ).toMatchObject([
      { provider: 'deepgram', type: 'final', transcript: 'hello there' },
      { provider: 'deepgram', type: 'endpoint', reason: 'end_of_turn' }
    ])
  })

  it('maps ElevenLabs committed transcripts to final STT events', () => {
    expect(
      normalizeElevenLabsRealtimeSttEvent({
        message_type: 'committed_transcript_with_timestamps',
        text: 'good morning',
        words: [{ text: 'good', start: 0, end: 0.2 }]
      })
    ).toMatchObject([
      {
        provider: 'elevenlabs',
        type: 'final',
        transcript: 'good morning',
        words: [{ word: 'good', startSec: 0, endSec: 0.2 }]
      }
    ])
  })

  it('maps OpenAI realtime transcription deltas and VAD events', () => {
    expect(
      normalizeOpenAIRealtimeTranscriptionEvent({
        type: 'input_audio_buffer.speech_started'
      })
    ).toMatchObject([{ provider: 'openai', type: 'speech_start' }])

    expect(
      normalizeOpenAIRealtimeTranscriptionEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'hello'
      })
    ).toMatchObject([{ provider: 'openai', type: 'partial', transcript: 'hello' }])

    expect(
      normalizeOpenAIRealtimeTranscriptionEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello there',
        language: 'en'
      })
    ).toMatchObject([{ provider: 'openai', type: 'final', transcript: 'hello there', language: 'en' }])

    expect(
      normalizeOpenAIRealtimeTranscriptionEvent({
        type: 'input_audio_buffer.speech_stopped'
      })
    ).toMatchObject([{ provider: 'openai', type: 'endpoint', reason: 'speech_stopped' }])
  })
})

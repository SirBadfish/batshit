import { describe, expect, it } from 'vitest'
import {
  applyRealtimeSttEventToTurnState,
  createRealtimeSttTurnState
} from './realtimeSttTurnState'

describe('realtime STT turn state', () => {
  it('turns speech start into a playback stop intent without submitting text', () => {
    const result = applyRealtimeSttEventToTurnState(createRealtimeSttTurnState(), {
      type: 'speech_start',
      provider: 'browser'
    })

    expect(result.state).toMatchObject({
      isListening: true,
      isSpeaking: true,
      endpointPending: false
    })
    expect(result.action).toMatchObject({
      stopPlayback: true,
      cancelPendingSubmit: true
    })
    expect(result.action.submitTranscript).toBeUndefined()
  })

  it('submits the final transcript only after an endpoint event', () => {
    let state = createRealtimeSttTurnState()
    state = applyRealtimeSttEventToTurnState(state, {
      type: 'partial',
      provider: 'deepgram',
      transcript: 'turn the'
    }).state
    state = applyRealtimeSttEventToTurnState(state, {
      type: 'final',
      provider: 'deepgram',
      transcript: 'turn the lights on'
    }).state

    const endpoint = applyRealtimeSttEventToTurnState(state, {
      type: 'endpoint',
      provider: 'deepgram',
      reason: 'end_of_turn'
    })

    expect(endpoint.action.submitTranscript).toBe('turn the lights on')
    expect(endpoint.state).toMatchObject({
      isSpeaking: false,
      draftTranscript: '',
      finalTranscript: '',
      endpointPending: false
    })
  })

  it('treats the first transcript text as a barge-in signal even without speech_start', () => {
    const partial = applyRealtimeSttEventToTurnState(createRealtimeSttTurnState(), {
      type: 'partial',
      provider: 'deepgram',
      transcript: 'actually'
    })

    expect(partial.action.stopPlayback).toBe(true)
    expect(partial.state).toMatchObject({
      isSpeaking: true,
      draftTranscript: 'actually'
    })
  })

  it('treats endpoint without transcript as a false start', () => {
    const endpoint = applyRealtimeSttEventToTurnState(createRealtimeSttTurnState(), {
      type: 'endpoint',
      provider: 'openai',
      reason: 'speech_stopped'
    })

    expect(endpoint.action.submitTranscript).toBeUndefined()
    expect(endpoint.state).toMatchObject({
      isSpeaking: false,
      endpointPending: true
    })
  })

  it('cancels pending submit when speech resumes', () => {
    const result = applyRealtimeSttEventToTurnState(
      {
        ...createRealtimeSttTurnState(),
        endpointPending: true,
        draftTranscript: 'wait'
      },
      {
        type: 'speech_resume',
        provider: 'deepgram'
      }
    )

    expect(result.action.cancelPendingSubmit).toBe(true)
    expect(result.state).toMatchObject({
      isSpeaking: true,
      endpointPending: false,
      draftTranscript: 'wait'
    })
  })
})

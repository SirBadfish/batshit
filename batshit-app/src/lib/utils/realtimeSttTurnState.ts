import type { VoiceRealtimeSttEvent } from '$lib/types/voiceRealtimeStt'

export type RealtimeSttTurnState = {
  isListening: boolean
  isSpeaking: boolean
  draftTranscript: string
  finalTranscript: string
  endpointPending: boolean
}

export type RealtimeSttTurnAction = {
  stopPlayback: boolean
  cancelPendingSubmit: boolean
  submitTranscript?: string
  error?: string
}

export type RealtimeSttTurnTransition = {
  state: RealtimeSttTurnState
  action: RealtimeSttTurnAction
}

export function createRealtimeSttTurnState(): RealtimeSttTurnState {
  return {
    isListening: false,
    isSpeaking: false,
    draftTranscript: '',
    finalTranscript: '',
    endpointPending: false
  }
}

const cleanTranscript = (value?: string | null) => (value ?? '').trim()

export function applyRealtimeSttEventToTurnState(
  state: RealtimeSttTurnState,
  event: VoiceRealtimeSttEvent
): RealtimeSttTurnTransition {
  const next: RealtimeSttTurnState = { ...state }
  const action: RealtimeSttTurnAction = {
    stopPlayback: false,
    cancelPendingSubmit: false
  }

  if (event.type === 'start') {
    next.isListening = true
    return { state: next, action }
  }

  if (event.type === 'speech_start') {
    next.isListening = true
    next.isSpeaking = true
    next.endpointPending = false
    action.stopPlayback = true
    action.cancelPendingSubmit = true
    const transcript = cleanTranscript(event.transcript)
    if (transcript) next.draftTranscript = transcript
    return { state: next, action }
  }

  if (event.type === 'speech_resume') {
    next.isSpeaking = true
    next.endpointPending = false
    action.stopPlayback = true
    action.cancelPendingSubmit = true
    return { state: next, action }
  }

  if (event.type === 'partial') {
    const transcript = cleanTranscript(event.transcript)
    if (transcript) {
      next.draftTranscript = transcript
      next.isSpeaking = true
      action.stopPlayback = true
    }
    next.isListening = true
    return { state: next, action }
  }

  if (event.type === 'final') {
    const transcript = cleanTranscript(event.transcript)
    if (transcript) {
      next.finalTranscript = transcript
      next.draftTranscript = transcript
      action.stopPlayback = true
    }
    next.isListening = true
    return { state: next, action }
  }

  if (event.type === 'endpoint') {
    next.isSpeaking = false
    next.endpointPending = true
    const transcript = cleanTranscript(next.finalTranscript || next.draftTranscript)
    if (transcript) {
      action.submitTranscript = transcript
      next.finalTranscript = ''
      next.draftTranscript = ''
      next.endpointPending = false
    }
    return { state: next, action }
  }

  if (event.type === 'error') {
    next.isSpeaking = false
    next.endpointPending = false
    action.error = event.error ?? 'Realtime STT error'
    return { state: next, action }
  }

  if (event.type === 'end') {
    return {
      state: createRealtimeSttTurnState(),
      action
    }
  }

  return { state: next, action }
}

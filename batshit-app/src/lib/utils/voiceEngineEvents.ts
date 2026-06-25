export const VOICE_ENGINES_UPDATED_EVENT = 'batshit:voice-engines-updated' as const

export type VoiceEnginesUpdatedDetail = {
  source?: string
  controlId?: string | null
  messageId?: string | null
  toolCallId?: string | null
}

export function dispatchVoiceEnginesUpdated(detail: VoiceEnginesUpdatedDetail = {}) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(VOICE_ENGINES_UPDATED_EVENT, { detail }))
}

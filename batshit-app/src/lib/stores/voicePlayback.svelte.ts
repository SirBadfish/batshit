export type VoicePlaybackState = {
  activeMessageId: string | null
  activeAgentId: string | null
  isPlaying: boolean
  queueByAgent: Record<string, number>
}

let playbackState = $state<VoicePlaybackState>({
  activeMessageId: null,
  activeAgentId: null,
  isPlaying: false,
  queueByAgent: {}
})

export function getPlaybackState() {
  return playbackState
}

export function setActiveSpeech(messageId: string | null, agentId: string | null) {
  playbackState = {
    ...playbackState,
    activeMessageId: messageId,
    activeAgentId: agentId,
    isPlaying: Boolean(messageId)
  }
}

export function clearActiveSpeech() {
  playbackState = {
    ...playbackState,
    activeMessageId: null,
    activeAgentId: null,
    isPlaying: false
  }
}

export function updateQueueCount(agentId: string, count: number) {
  playbackState = {
    ...playbackState,
    queueByAgent: {
      ...playbackState.queueByAgent,
      [agentId]: count
    }
  }
}

export function clearQueueCounts() {
  playbackState = {
    ...playbackState,
    queueByAgent: {}
  }
}

export type DesktopGoonActiveSpeakerSource =
  | 'audible-playback'
  | 'active-stream'
  | 'group-driver-fallback'
  | 'current-agent-fallback'

export type DesktopGoonActiveSpeaker = {
  agentId: string
  source: DesktopGoonActiveSpeakerSource
}

export type DesktopGoonActiveSpeakerInput = {
  audiblePlaybackAgentId?: string | null
  currentSessionId?: string | null
  activeStream?: {
    active: boolean
    agentId?: string | null
    sessionId?: string | null
  } | null
  groupDriverAgentId?: string | null
  groupAgentIds?: readonly string[] | null
  currentAgentId?: string | null
}

function normalizeId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function resolveDesktopGoonActiveSpeaker(
  input: DesktopGoonActiveSpeakerInput
): DesktopGoonActiveSpeaker | null {
  const audible = normalizeId(input.audiblePlaybackAgentId)
  if (audible) return { agentId: audible, source: 'audible-playback' }

  const currentSessionId = normalizeId(input.currentSessionId)
  const streamAgentId = normalizeId(input.activeStream?.agentId)
  const streamSessionId = normalizeId(input.activeStream?.sessionId)
  if (
    input.activeStream?.active === true &&
    currentSessionId &&
    streamSessionId === currentSessionId &&
    streamAgentId
  ) {
    return { agentId: streamAgentId, source: 'active-stream' }
  }

  const groupDriver = normalizeId(input.groupDriverAgentId)
  const groupMembers = new Set((input.groupAgentIds ?? []).map(normalizeId).filter(Boolean))
  if (groupDriver && groupMembers.has(groupDriver)) {
    return { agentId: groupDriver, source: 'group-driver-fallback' }
  }

  const currentAgent = normalizeId(input.currentAgentId)
  return currentAgent
    ? { agentId: currentAgent, source: 'current-agent-fallback' }
    : null
}

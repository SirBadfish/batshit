import { describe, expect, it } from 'vitest'

import { resolveDesktopGoonActiveSpeaker } from '$lib/goons/desktopGoonActiveSpeaker'

describe('resolveDesktopGoonActiveSpeaker', () => {
  it('uses audible playback before stream, group driver, and current-agent fallbacks', () => {
    expect(resolveDesktopGoonActiveSpeaker({
      audiblePlaybackAgentId: 'speaking',
      currentSessionId: 'session-1',
      activeStream: { active: true, agentId: 'streaming', sessionId: 'session-1' },
      groupDriverAgentId: 'driver',
      groupAgentIds: ['driver'],
      currentAgentId: 'current'
    })).toEqual({ agentId: 'speaking', source: 'audible-playback' })
  })

  it('uses only an active stream owned by the current session', () => {
    const base = {
      currentSessionId: 'session-1',
      groupDriverAgentId: 'driver',
      groupAgentIds: ['driver'],
      currentAgentId: 'current'
    }
    expect(resolveDesktopGoonActiveSpeaker({
      ...base,
      activeStream: { active: true, agentId: 'streaming', sessionId: 'session-1' }
    })).toEqual({ agentId: 'streaming', source: 'active-stream' })
    expect(resolveDesktopGoonActiveSpeaker({
      ...base,
      activeStream: { active: false, agentId: 'stale', sessionId: 'session-1' }
    })).toEqual({ agentId: 'driver', source: 'group-driver-fallback' })
    expect(resolveDesktopGoonActiveSpeaker({
      ...base,
      activeStream: { active: true, agentId: 'other-session', sessionId: 'session-2' }
    })).toEqual({ agentId: 'driver', source: 'group-driver-fallback' })
  })

  it('requires a valid group member before using the driver fallback', () => {
    expect(resolveDesktopGoonActiveSpeaker({
      groupDriverAgentId: 'removed-driver',
      groupAgentIds: ['agent-a'],
      currentAgentId: 'agent-a'
    })).toEqual({ agentId: 'agent-a', source: 'current-agent-fallback' })
  })
})

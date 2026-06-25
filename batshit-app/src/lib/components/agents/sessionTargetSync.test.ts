import { describe, expect, it } from 'vitest'

import {
  resolveSessionStoredAgentId,
  resolveSessionTargetAgentId,
  shouldAutoSyncSessionTarget
} from './sessionTargetSync'

describe('resolveSessionTargetAgentId', () => {
  it('only auto-syncs when the selected session changes', () => {
    expect(shouldAutoSyncSessionTarget('session-1', null)).toBe(true)
    expect(shouldAutoSyncSessionTarget('session-1', 'session-1')).toBe(false)
    expect(shouldAutoSyncSessionTarget(null, 'session-1')).toBe(false)
  })

  it('returns the saved session agent when it still exists and differs from the current target', () => {
    expect(
      resolveSessionTargetAgentId({
        session: {
          agent_id: 'mode-1',
          metadata: {}
        },
        availableAgentIds: ['mode-1', 'mode-4'],
        currentAgentId: 'mode-4'
      })
    ).toBe('mode-1')
  })

  it('reads legacy session metadata agent fields when the top-level session agent is absent', () => {
    expect(
      resolveSessionStoredAgentId({
        session: {
          metadata: {
            last_agent_id: 'mode-4'
          }
        },
        availableAgentIds: ['mode-1', 'mode-4']
      })
    ).toBe('mode-4')
  })

  it('returns null when the saved session agent no longer exists', () => {
    expect(
      resolveSessionTargetAgentId({
        session: {
          agent_id: 'deleted-agent',
          metadata: {}
        },
        availableAgentIds: ['mode-1', 'mode-4'],
        currentAgentId: 'mode-4'
      })
    ).toBeNull()
  })

  it('returns null for group sessions so group metadata stays in charge', () => {
    expect(
      resolveSessionTargetAgentId({
        session: {
          agent_id: 'mode-1',
          metadata: {
            group_chat: {
              group_id: 'group-1'
            }
          }
        },
        availableAgentIds: ['mode-1', 'mode-4'],
        currentAgentId: 'mode-4'
      })
    ).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { dmSenderLabel } from './dmSender'

describe('dmSenderLabel (PR #106 review, F-13)', () => {
  it('names each sender kind its own way, and never calls a schedule a webhook', () => {
    expect(dmSenderLabel({ kind: 'agent', agentId: 'agent-cooper', name: 'Cooper' })).toBe('Cooper')
    expect(dmSenderLabel({ kind: 'agent', agentId: 'agent-cooper', name: '' })).toBe('agent-cooper')
    expect(dmSenderLabel({ kind: 'webhook', hookId: 'whk_1', name: 'Nightly build' })).toBe('Nightly build (webhook)')
    expect(dmSenderLabel({ kind: 'schedule', scheduleId: 'sch_1', name: 'Morning standup' })).toBe(
      'Morning standup (schedule)'
    )
    expect(dmSenderLabel({ kind: 'schedule', scheduleId: 'sch_1', name: 'Morning standup' })).not.toContain('webhook')
  })
})

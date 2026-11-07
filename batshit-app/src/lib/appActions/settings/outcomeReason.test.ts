import { describe, expect, it } from 'vitest'
import { formatAppActionsOutcomeReason } from './outcomeReason'

/**
 * SA-139 R4: a Primary Agent is API only, so the one lane-only code left, `api_primary_only`, now
 * separates Primary Agents from Subagents (the server raises it for a Subagent subject). The
 * approval card and the operation review never show a raw code or an API/CLI agent type.
 */
describe('formatAppActionsOutcomeReason', () => {
  it('names the Primary-only boundary for the lane-only code, never a raw code or a type', () => {
    expect(formatAppActionsOutcomeReason('api_primary_only'))
      .toBe('This setting applies only to Primary Agents, not to Subagents.')
    expect(formatAppActionsOutcomeReason('api_primary_only')).not.toMatch(/\b(API|CLI) Primary Agents?\b|primary only/)
  })

  it('keeps an unknown code readable and a human sentence literal', () => {
    expect(formatAppActionsOutcomeReason('some_new_code')).toBe('some new code')
    expect(formatAppActionsOutcomeReason('A sentence already.')).toBe('A sentence already.')
  })
})

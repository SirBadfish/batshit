import { describe, expect, it } from 'vitest'
import { isMcpResourceOutcome } from './mcpConfiguration'

/**
 * SA-139 R4: the MCP configuration stage `claudeProfile` went with the Claude Code CLI Primary's
 * profile sync. An outcome saved in a chat before R4 still names it, and must still read (saved
 * data stays readable); a new outcome never carries it.
 */
const resource = { kind: 'mcp-gateway', gatewayId: 'assigned' } as const
const stages = { installation: 'not_started', registry: 'saved', keyReference: 'verified', dockerFile: 'not_started',
  verification: 'not_started', discoverability: 'not_started', originalTaskUse: 'not_started', zip: 'not_started' }

describe('MCP configuration outcomes saved before SA-139 R4', () => {
  it('reads a current outcome', () => {
    expect(isMcpResourceOutcome({ resource, status: 'applied', saved: 'saved', stages })).toBe(true)
  })

  it.each(['not_started', 'not_requested'])('still reads a saved outcome whose claudeProfile stage is %s', (claudeProfile) => {
    expect(isMcpResourceOutcome({ resource, status: 'applied', saved: 'saved', stages: { ...stages, claudeProfile } })).toBe(true)
  })

  it('refuses a claudeProfile stage that never existed in a saved record, and unknown stage names', () => {
    expect(isMcpResourceOutcome({ resource, status: 'applied', saved: 'saved', stages: { ...stages, claudeProfile: 'saved' } })).toBe(false)
    expect(isMcpResourceOutcome({ resource, status: 'applied', saved: 'saved', stages: { ...stages, otherStage: 'not_started' } })).toBe(false)
  })
})

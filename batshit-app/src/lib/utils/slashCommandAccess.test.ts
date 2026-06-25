import { describe, expect, it } from 'vitest'

import { isSlashCommandEnabledForAgent } from './slashCommandAccess'

describe('isSlashCommandEnabledForAgent', () => {
  it('allows commands for all agents even when the explicit allowlist is empty', () => {
    expect(
      isSlashCommandEnabledForAgent(
        {
          enabled_for_all_agents: true,
          enabled_agent_ids: []
        } as any,
        'agent-1'
      )
    ).toBe(true)
  })

  it('blocks commands with an empty allowlist when they are not globally enabled', () => {
    expect(
      isSlashCommandEnabledForAgent(
        {
          enabled_for_all_agents: false,
          enabled_agent_ids: []
        } as any,
        'agent-1'
      )
    ).toBe(false)
  })

  it('allows legacy commands that do not expose agent metadata', () => {
    expect(isSlashCommandEnabledForAgent({} as any, 'agent-1')).toBe(true)
  })

  it('matches explicit agent ids when present', () => {
    expect(
      isSlashCommandEnabledForAgent(
        {
          enabled_for_all_agents: false,
          enabled_agent_ids: ['agent-1', 'agent-2']
        } as any,
        'agent-2'
      )
    ).toBe(true)
    expect(
      isSlashCommandEnabledForAgent(
        {
          enabled_for_all_agents: false,
          enabled_agent_ids: ['agent-1', 'agent-2']
        } as any,
        'agent-3'
      )
    ).toBe(false)
  })
})

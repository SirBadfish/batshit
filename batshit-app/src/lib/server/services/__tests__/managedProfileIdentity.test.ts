import { describe, expect, it } from 'vitest'

import { buildAgentProfileId, managedProfileId } from '../managedProfileIdentity'

/**
 * The pure identity a managed CLI profile folder is named by. SA-139 R1 moved it out of the
 * retired Codex profile manager unchanged; SA-139 R5 removed the last profile writer (and with it
 * the gateway-entry names and the helper launch), so the folder deletes and the Subagent and
 * Worker slot deletes are what name folders with it now.
 */
describe('managed profile identity', () => {
  it('names a profile folder for an agent, Subagent or Worker runtime id', () => {
    expect(buildAgentProfileId('agent-1')).toBe('batshit_agent_agent-1')
    expect(buildAgentProfileId('Josh Main Agent!')).toBe('batshit_agent_josh_main_agent_')
    expect(buildAgentProfileId('subagent_cli_research-helper')).toBe('batshit_agent_subagent_cli_research-helper')
    expect(buildAgentProfileId('../..')).toBe('batshit_agent______')
    expect(buildAgentProfileId(null)).toBe('batshit_agent_unknown')
    expect(buildAgentProfileId(undefined)).toBe(managedProfileId('unknown'))
  })
})

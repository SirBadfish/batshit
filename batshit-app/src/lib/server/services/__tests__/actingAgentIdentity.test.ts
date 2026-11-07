import { describe, expect, it } from 'vitest'
import { laneCanVouchForAgentIdentity, requireActingAgentIdentity, refusePortableSkillOutsideList } from '../actingAgentIdentity'

describe('acting-agent authority', () => {
  it('accepts a signed-in user or an in-process turn, but no other lane or retired name', () => {
    for (const lane of ['session', 'in-process']) expect(laneCanVouchForAgentIdentity(lane)).toBe(true)
    for (const lane of ['service', 'unknown', 'portable-skill', 'agent', '', null, undefined]) {
      expect(laneCanVouchForAgentIdentity(lane)).toBe(false)
      expect(requireActingAgentIdentity(lane)).toMatchObject({ ok: false, code: 'AGENT_IDENTITY_REQUIRED' })
    }
  })
  it('refuses a delegated run even on an in-process lane', () => {
    expect(requireActingAgentIdentity('in-process', { delegated: true })).toMatchObject({ ok: false, code: 'AGENT_IDENTITY_REQUIRED' })
  })
  it('still applies the portable family allowlist on direct routes', () => {
    expect(refusePortableSkillOutsideList({ auth: 'portable-skill', portableSkillAllowedControlIds: [] }, 'sys.mcp.dynamic.use')).toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
    expect(refusePortableSkillOutsideList({ auth: 'portable-skill', portableSkillAllowedControlIds: ['sys.mcp.dynamic.use'] }, 'sys.mcp.dynamic.use')).toBeNull()
    expect(refusePortableSkillOutsideList({ auth: 'service' }, 'sys.mcp.dynamic.use')).toBeNull()
  })
})

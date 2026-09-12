/**
 * SA-117 P2 (DL-117-04, DL-117-05) — the two rules every route applies, tested once.
 *
 * The routes each get their own proof through the real resolver; this suite pins the RULE
 * itself, because "written once and never restated inline" is the whole point of the module.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_IDENTITY_REQUIRED_ERROR_CODE,
  AGENT_MISMATCH_ERROR_CODE,
  bindActingAgentId,
  bindActingSessionId,
  bindDispatchContextIdentity,
  boundAgentId,
  laneCanVouchForAgentIdentity,
  requireActingAgentIdentity
} from '../actingAgentIdentity'

const agentLane = {
  auth: 'agent' as const,
  agentId: 'agent-cooper',
  sessionId: 'session-1'
}

describe('DL-117-04: binding the acting agent', () => {
  it('uses the bound agent when the body says nothing', () => {
    expect(bindActingAgentId(agentLane, undefined)).toEqual({ ok: true, agentId: 'agent-cooper' })
  })

  it('accepts a body id that agrees, because agreeing is not an error', () => {
    // The managed helpers stopped sending it, but a managed profile written before this
    // story is still on disk until the agent's settings are saved again.
    expect(bindActingAgentId(agentLane, 'agent-cooper')).toEqual({
      ok: true,
      agentId: 'agent-cooper'
    })
  })

  it('refuses a body id that differs rather than silently correcting it', () => {
    const result = bindActingAgentId(agentLane, 'agent-faye')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe(AGENT_MISMATCH_ERROR_CODE)
    // The message names both, because the reader needs to know which run sent it.
    expect(result.message).toContain('agent-cooper')
    expect(result.message).toContain('agent-faye')
  })

  it('trims before comparing, so whitespace is not a mismatch', () => {
    expect(bindActingAgentId(agentLane, '  agent-cooper  ')).toEqual({
      ok: true,
      agentId: 'agent-cooper'
    })
  })

  it('passes the claim straight through on a lane with no bound agent', () => {
    // Narrowing those lanes is DL-117-05's job, not this one's: a `service`-lane caller
    // still names its own scope hints for the controls it IS allowed to run.
    expect(bindActingAgentId({ auth: 'service' }, 'agent-faye')).toEqual({
      ok: true,
      agentId: 'agent-faye'
    })
    expect(bindActingAgentId(null, 'agent-faye')).toEqual({ ok: true, agentId: 'agent-faye' })
    expect(bindActingAgentId({ auth: 'session' }, '')).toEqual({ ok: true, agentId: undefined })
  })

  it('ignores an agentId on the auth object when the lane is not `agent`', () => {
    // Only the `agent` lane's id came off a credential. Trusting the field on any other
    // lane would re-open the hole through a different door.
    expect(boundAgentId({ auth: 'service', agentId: 'agent-cooper' })).toBe('')
    expect(bindActingAgentId({ auth: 'service', agentId: 'agent-cooper' }, 'agent-faye')).toEqual({
      ok: true,
      agentId: 'agent-faye'
    })
  })
})

describe('DL-117-04: binding the session', () => {
  it('prefers the bound session and drops a differing claim without refusing', () => {
    // A session id is WHERE a call lands, not WHO is making it, and every route already
    // refuses a session the caller does not own.
    expect(bindActingSessionId(agentLane, 'some-other-session')).toBe('session-1')
  })

  it('falls back to the claim on a lane with no bound session', () => {
    expect(bindActingSessionId({ auth: 'service' }, 'session-9')).toBe('session-9')
    expect(bindActingSessionId({ auth: 'service' }, '   ')).toBeUndefined()
  })
})

describe('DL-117-04: the dispatch context', () => {
  it('binds `agent_id` for a primary actor', () => {
    const result = bindDispatchContextIdentity(agentLane, {
      session_id: 'claimed-session',
      agent_id: 'agent-cooper',
      mode: 'mode4',
      actor_type: 'primary'
    })
    expect(result).toEqual({
      ok: true,
      context: {
        session_id: 'session-1',
        agent_id: 'agent-cooper',
        mode: 'mode4',
        actor_type: 'primary'
      }
    })
  })

  it('binds `parent_agent_id` for a subagent actor, because that is the governing agent', () => {
    // `nativeTools.ts` resolves the governing agent from `parent_agent_id` when the actor is
    // a subagent, then loads THAT agent's record. Binding `agent_id` alone would leave a
    // subagent-shaped context naming any parent it liked.
    const result = bindDispatchContextIdentity(agentLane, {
      session_id: 'session-1',
      agent_id: 'subagent-7',
      parent_agent_id: 'agent-faye',
      mode: 'mode4',
      actor_type: 'subagent'
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe(AGENT_MISMATCH_ERROR_CODE)
  })

  it('leaves a subagent actor\'s own agent_id alone while binding its parent', () => {
    // The governing agent is the PARENT here. Binding `agent_id` instead would refuse a
    // perfectly good subagent call (its `agent_id` is the subagent's) and would overwrite
    // the field `nativeTools.ts` uses to load the subagent record.
    const result = bindDispatchContextIdentity(agentLane, {
      session_id: 'session-1',
      agent_id: 'subagent-7',
      parent_agent_id: 'agent-cooper',
      mode: 'mode4',
      actor_type: 'subagent'
    })

    expect(result).toEqual({
      ok: true,
      context: {
        session_id: 'session-1',
        agent_id: 'subagent-7',
        parent_agent_id: 'agent-cooper',
        mode: 'mode4',
        actor_type: 'subagent'
      }
    })
  })

  it('fills in a subagent actor\'s missing parent without clobbering its agent_id', () => {
    const result = bindDispatchContextIdentity(agentLane, {
      session_id: 'session-1',
      agent_id: 'subagent-7',
      mode: 'mode4',
      actor_type: 'subagent'
    })

    expect(result).toEqual({
      ok: true,
      context: {
        session_id: 'session-1',
        agent_id: 'subagent-7',
        parent_agent_id: 'agent-cooper',
        mode: 'mode4',
        actor_type: 'subagent'
      }
    })
  })

  it('fills in the governing agent when the context omits it', () => {
    const result = bindDispatchContextIdentity(agentLane, {
      session_id: 'session-1',
      mode: 'mode4',
      actor_type: 'primary'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.context).toMatchObject({ agent_id: 'agent-cooper' })
  })

  it('passes a malformed context through untouched rather than inventing one', () => {
    // `parseNativeAutomationContext` owns shape errors. Building an object here would turn
    // a malformed request into an authorized one.
    expect(bindDispatchContextIdentity(agentLane, null)).toEqual({ ok: true, context: null })
    expect(bindDispatchContextIdentity(agentLane, 'nonsense')).toEqual({
      ok: true,
      context: 'nonsense'
    })
    expect(bindDispatchContextIdentity(agentLane, [1, 2])).toEqual({ ok: true, context: [1, 2] })
  })

  it('leaves the context alone on a lane with no bound agent', () => {
    const context = { session_id: 's', agent_id: 'agent-faye', mode: 'mode1', actor_type: 'primary' }
    expect(bindDispatchContextIdentity({ auth: 'n8n-callback' }, context)).toEqual({
      ok: true,
      context
    })
  })
})

describe('DL-117-05: which lanes can vouch for an agent identity', () => {
  it('lets the credential lane, the in-process callers, the n8n-callback token, and the user\'s own session through', () => {
    for (const lane of ['agent', 'unknown', 'n8n-callback', 'session'] as const) {
      expect(laneCanVouchForAgentIdentity(lane)).toBe(true)
      expect(requireActingAgentIdentity(lane)).toEqual({ ok: true })
    }
  })

  it('lets a signed-in browser act as one of the user\'s own agents (F-P2-4)', () => {
    // The session lane IS the user, and the user is the authority over the user's agents:
    // `/api/dms` lists every agent's inbox and `/api/schedules` creates a schedule for any
    // agent on this same cookie, and the MegaSmoke harness drives the SA-113 DM rows and the
    // SA-115 schedule rows through `/api/controls/use` on it. Refusing it here closed nothing
    // a cookie holder could not do one route over, and broke those rows. The audit still
    // records the lane as `session`, so "the user acted as Cooper" stays readable.
    expect(requireActingAgentIdentity('session')).toEqual({ ok: true })
  })

  it('refuses the instance token and a Portable Skill Token', () => {
    for (const lane of ['service', 'portable-skill'] as const) {
      expect(laneCanVouchForAgentIdentity(lane)).toBe(false)
      const result = requireActingAgentIdentity(lane)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe(AGENT_IDENTITY_REQUIRED_ERROR_CODE)
      expect(result.message).toContain('acts as an agent')
    }
  })

  it('refuses an absent lane, so a caller that declares nothing is not treated as in-process', () => {
    expect(requireActingAgentIdentity(null).ok).toBe(false)
    expect(requireActingAgentIdentity(undefined).ok).toBe(false)
  })

  it('refuses a DELEGATED credential even though its lane is `agent` (F-P2-1)', () => {
    // A Subagent or Worker run holds a real credential, so the lane check alone passes it —
    // but the agent it names is a per-run runtime id with no inbox, no memories and no
    // schedules. The design already said "a delegated run has no identity to write from";
    // this is that sentence enforced instead of left to control-ref exposure.
    const result = requireActingAgentIdentity('agent', { delegated: true })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe(AGENT_IDENTITY_REQUIRED_ERROR_CODE)
    expect(result.message).toContain('Subagent or Worker')
  })

  it('still passes an ordinary (non-delegated) credential', () => {
    expect(requireActingAgentIdentity('agent', { delegated: false })).toEqual({ ok: true })
    expect(requireActingAgentIdentity('agent', {})).toEqual({ ok: true })
  })
})

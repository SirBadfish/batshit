import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAKE_TARGET,
  DEFAULT_WAKE_TIMEOUT_MINUTES,
  MAX_WAKE_TIMEOUT_MINUTES,
  MIN_WAKE_TIMEOUT_MINUTES,
  isDeliverableNow,
  resolveAgentDmsEnabled,
  resolveAgentWakeEnabled,
  resolveDmSenderAllowed,
  resolveDmSenderPolicy,
  resolveInstanceWakeupsEnabled,
  resolveWakeTarget,
  resolveWakeTimeoutMs,
  validateDmSenderFields,
  validateWakeTimeoutMinutes
} from '$lib/utils/dmControl'

/**
 * SA-113 P1 — the wake gates and dials. These are THE rules; every surface derives from
 * them, so each default and each rejection is pinned here.
 */

describe('resolveAgentWakeEnabled (DL-113-01)', () => {
  it('defaults ON for a real agent record with no stored value', () => {
    expect(resolveAgentWakeEnabled({ id: 'a1', displayName: 'Cooper' })).toBe(true)
  })

  it('honours an explicit false', () => {
    expect(resolveAgentWakeEnabled({ wake_enabled: false })).toBe(false)
  })

  it('honours an explicit true', () => {
    expect(resolveAgentWakeEnabled({ wake_enabled: true })).toBe(true)
  })

  it('tolerates the camelCase alias for API-shaped records', () => {
    expect(resolveAgentWakeEnabled({ wakeEnabled: false })).toBe(false)
  })

  it('returns false for a non-record, so a missing agent can never be woken', () => {
    expect(resolveAgentWakeEnabled(null)).toBe(false)
    expect(resolveAgentWakeEnabled(undefined)).toBe(false)
    expect(resolveAgentWakeEnabled('cooper')).toBe(false)
  })
})

describe('resolveInstanceWakeupsEnabled (DL-113-01)', () => {
  it('defaults ON when the admin blob is missing or has no key', () => {
    expect(resolveInstanceWakeupsEnabled(null)).toBe(true)
    expect(resolveInstanceWakeupsEnabled({})).toBe(true)
  })

  it('only an explicit false turns wake-ups off instance-wide', () => {
    expect(resolveInstanceWakeupsEnabled({ agent_wakeups_enabled: false })).toBe(false)
    expect(resolveInstanceWakeupsEnabled({ agent_wakeups_enabled: true })).toBe(true)
    expect(resolveInstanceWakeupsEnabled({ agentWakeupsEnabled: false })).toBe(false)
  })

  it('ignores a non-boolean value rather than treating it as off', () => {
    expect(resolveInstanceWakeupsEnabled({ agent_wakeups_enabled: 'no' })).toBe(true)
  })
})

describe('resolveWakeTarget (DL-113-15)', () => {
  it('defaults to Parallel', () => {
    expect(resolveWakeTarget({})).toBe('new-session')
    expect(resolveWakeTarget(null)).toBe(DEFAULT_WAKE_TARGET)
  })

  it('reads One at a time', () => {
    expect(resolveWakeTarget({ wake_target: 'current-session' })).toBe('current-session')
    expect(resolveWakeTarget({ wakeTarget: 'current-session' })).toBe('current-session')
  })

  it('tolerates surrounding whitespace', () => {
    expect(resolveWakeTarget({ wake_target: '  current-session  ' })).toBe('current-session')
  })

  it('falls back to Parallel for an unrecognised value instead of throwing', () => {
    expect(resolveWakeTarget({ wake_target: 'sideways' })).toBe('new-session')
    expect(resolveWakeTarget({ wake_target: 42 })).toBe('new-session')
  })
})

describe('validateWakeTimeoutMinutes (DL-113-01, LS-037 shape)', () => {
  it('treats blank as "use the code default"', () => {
    expect(validateWakeTimeoutMinutes(undefined)).toEqual({ ok: true, minutes: null })
    expect(validateWakeTimeoutMinutes(null)).toEqual({ ok: true, minutes: null })
    expect(validateWakeTimeoutMinutes('')).toEqual({ ok: true, minutes: null })
    expect(validateWakeTimeoutMinutes('   ')).toEqual({ ok: true, minutes: null })
  })

  it('accepts an in-range whole number, as a number or a string', () => {
    expect(validateWakeTimeoutMinutes(45)).toEqual({ ok: true, minutes: 45 })
    expect(validateWakeTimeoutMinutes('45')).toEqual({ ok: true, minutes: 45 })
    expect(validateWakeTimeoutMinutes(MIN_WAKE_TIMEOUT_MINUTES).ok).toBe(true)
    expect(validateWakeTimeoutMinutes(MAX_WAKE_TIMEOUT_MINUTES).ok).toBe(true)
  })

  it('fails loudly rather than clamping an out-of-range value', () => {
    const low = validateWakeTimeoutMinutes(MIN_WAKE_TIMEOUT_MINUTES - 1)
    const high = validateWakeTimeoutMinutes(MAX_WAKE_TIMEOUT_MINUTES + 1)
    expect(low.ok).toBe(false)
    expect(high.ok).toBe(false)
    if (!low.ok) expect(low.error).toContain(String(MIN_WAKE_TIMEOUT_MINUTES))
    if (!high.ok) expect(high.error).toContain(String(MAX_WAKE_TIMEOUT_MINUTES))
  })

  it('rejects fractions and non-numbers', () => {
    expect(validateWakeTimeoutMinutes(12.5).ok).toBe(false)
    expect(validateWakeTimeoutMinutes('half an hour').ok).toBe(false)
    expect(validateWakeTimeoutMinutes({}).ok).toBe(false)
  })
})

describe('resolveWakeTimeoutMs (DL-113-01)', () => {
  it('uses the code default when nothing is stored', () => {
    expect(resolveWakeTimeoutMs({})).toBe(DEFAULT_WAKE_TIMEOUT_MINUTES * 60 * 1000)
    expect(resolveWakeTimeoutMs(null)).toBe(DEFAULT_WAKE_TIMEOUT_MINUTES * 60 * 1000)
  })

  it('uses the stored per-agent value', () => {
    expect(resolveWakeTimeoutMs({ wake_timeout_minutes: 90 })).toBe(90 * 60 * 1000)
    expect(resolveWakeTimeoutMs({ wakeTimeoutMinutes: 5 })).toBe(5 * 60 * 1000)
  })

  it('falls back to the default for a stored value that no longer validates, so a woken turn is still bounded', () => {
    expect(resolveWakeTimeoutMs({ wake_timeout_minutes: 0 })).toBe(
      DEFAULT_WAKE_TIMEOUT_MINUTES * 60 * 1000
    )
    expect(resolveWakeTimeoutMs({ wake_timeout_minutes: 99999 })).toBe(
      DEFAULT_WAKE_TIMEOUT_MINUTES * 60 * 1000
    )
  })
})

describe('delivery modes (DL-113-03)', () => {
  it('only wait and wake can be delivered in v1; steer is reserved for SA-114', () => {
    expect(isDeliverableNow('wait')).toBe(true)
    expect(isDeliverableNow('wake')).toBe(true)
    expect(isDeliverableNow('steer')).toBe(false)
  })
})

describe('the Agent DMs gate (DL-113-01)', () => {
  it('defaults OFF — DMs are opt-in per agent, unlike the wake switch', () => {
    expect(resolveAgentDmsEnabled({})).toBe(false)
    expect(resolveAgentDmsEnabled(null)).toBe(false)
    expect(resolveAgentDmsEnabled(undefined)).toBe(false)
    expect(resolveAgentDmsEnabled('not an agent')).toBe(false)
  })

  it('reads both the stored key and its camelCase alias', () => {
    expect(resolveAgentDmsEnabled({ dms_enabled: true })).toBe(true)
    expect(resolveAgentDmsEnabled({ dmsEnabled: true })).toBe(true)
    expect(resolveAgentDmsEnabled({ dms_enabled: false })).toBe(false)
  })

  it('ignores a non-boolean value rather than treating it as truthy', () => {
    expect(resolveAgentDmsEnabled({ dms_enabled: 'yes' })).toBe(false)
    expect(resolveAgentDmsEnabled({ dms_enabled: 1 })).toBe(false)
  })
})

describe('who may DM an agent (DL-113-01)', () => {
  it('defaults to "any agent"', () => {
    expect(resolveDmSenderPolicy({})).toEqual({ scope: 'all', agentIds: [] })
    expect(resolveDmSenderAllowed({}, 'agent-faye')).toBe(true)
  })

  it('reads the flat shape (scope beside the id list)', () => {
    const agent = { dm_senders: 'selected', dm_sender_agent_ids: ['agent-faye'] }
    expect(resolveDmSenderPolicy(agent)).toEqual({
      scope: 'selected',
      agentIds: ['agent-faye']
    })
    expect(resolveDmSenderAllowed(agent, 'agent-faye')).toBe(true)
    expect(resolveDmSenderAllowed(agent, 'agent-opie')).toBe(false)
  })

  it('reads the nested shape too', () => {
    const agent = { dm_senders: { scope: 'selected', agentIds: ['agent-opie'] } }
    expect(resolveDmSenderAllowed(agent, 'agent-opie')).toBe(true)
    expect(resolveDmSenderAllowed(agent, 'agent-faye')).toBe(false)
  })

  it('an EMPTY chosen list means nobody, not everybody', () => {
    const agent = { dm_senders: 'selected', dm_sender_agent_ids: [] }
    expect(resolveDmSenderAllowed(agent, 'agent-faye')).toBe(false)
  })

  it('drops duplicates and blanks from the stored list', () => {
    const agent = {
      dm_senders: 'selected',
      dm_sender_agent_ids: ['agent-faye', ' agent-faye ', '', 42, null]
    }
    expect(resolveDmSenderPolicy(agent).agentIds).toEqual(['agent-faye'])
  })

  it('reads an unrecognised scope as "any agent" but REFUSES to store one', () => {
    // The read side must not throw mid-compile; the write side must not widen access.
    expect(resolveDmSenderPolicy({ dm_senders: 'everyone' }).scope).toBe('all')
    expect(validateDmSenderFields({ dm_senders: 'everyone' })).toMatch(
      /must be all or selected/i
    )
  })

  it('accepts the valid write shapes and rejects a malformed list', () => {
    expect(validateDmSenderFields({})).toBeNull()
    expect(validateDmSenderFields({ dm_senders: 'all' })).toBeNull()
    expect(
      validateDmSenderFields({ dm_senders: 'selected', dm_sender_agent_ids: ['a'] })
    ).toBeNull()
    expect(validateDmSenderFields({ dm_sender_agent_ids: 'agent-faye' })).toMatch(
      /list of agent ids/i
    )
    expect(validateDmSenderFields({ dm_sender_agent_ids: [1, 2] })).toMatch(
      /list of agent ids/i
    )
  })
})

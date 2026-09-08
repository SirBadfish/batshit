import { describe, expect, it } from 'vitest'
import { buildDmRosterDcmLines } from './dmRoster'
import { DM_ROSTER_MAX_LINES } from './dmControl'
import type { DmRecord } from '$lib/types/dm'

/**
 * SA-113 P2 (DL-113-04b) — the DCM roster.
 *
 * The rule Josh cares about most is the one asserted first: a closed DM leaves the roster
 * and stops costing tokens. Everything else is presentation.
 */

const NOW = Date.parse('2026-09-07T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function dm(overrides: Partial<DmRecord> = {}): DmRecord {
  return {
    id: 'dm_1',
    messageId: 'dm_1',
    userId: 'josh',
    kind: 'assignment',
    priority: 'normal',
    from: { kind: 'agent', agentId: 'agent-faye', name: 'Faye' },
    to: 'agent-cooper',
    subject: 'Verify the package',
    body: 'Run the audit.',
    deliver: 'wait',
    status: 'new',
    createdAt: '2026-09-07T11:00:00.000Z',
    createdTs: NOW - 60 * 60 * 1000,
    expiresAt: new Date(NOW + 3 * DAY).toISOString(),
    delivery: { requested: 'wait', actual: 'wait' },
    ...overrides
  } as DmRecord
}

describe('the roster is open items only', () => {
  it('returns nothing at all for an empty inbox', () => {
    expect(buildDmRosterDcmLines({ records: [], now: NOW })).toEqual({
      lines: [],
      listedIds: [],
      totalOpen: 0
    })
  })

  it('returns nothing when every item is closed or expired', () => {
    const result = buildDmRosterDcmLines({
      records: [
        dm({ id: 'dm_done', status: 'done' }),
        dm({ id: 'dm_blocked', status: 'blocked' }),
        dm({ id: 'dm_expired', status: 'expired' })
      ],
      now: NOW
    })
    expect(result.lines).toEqual([])
    expect(result.totalOpen).toBe(0)
  })

  it('lists new and working items', () => {
    const result = buildDmRosterDcmLines({
      records: [dm({ id: 'dm_new' }), dm({ id: 'dm_working', status: 'working' })],
      now: NOW
    })
    expect(result.totalOpen).toBe(2)
    expect(result.listedIds).toEqual(['dm_new', 'dm_working'])
    expect(result.lines[0]).toBe(
      'DMs (your inbox; open items only; use sys.dm.* to read, claim, and close):'
    )
  })
})

describe('line shape', () => {
  it('prints id, mark, kind, sender, subject, state, and expiry', () => {
    const result = buildDmRosterDcmLines({
      records: [dm()],
      previousUserMessageTs: NOW - 2 * 60 * 60 * 1000,
      now: NOW
    })
    expect(result.lines[1]).toBe(
      '- dm_1 ✅ assignment from Faye: "Verify the package" — new; expires in 3d'
    )
  })

  it('marks an item that was already open last turn with 🟢', () => {
    const result = buildDmRosterDcmLines({
      records: [dm()],
      // The previous user message is NEWER than the DM, so the agent already saw it.
      previousUserMessageTs: NOW - 30 * 60 * 1000,
      now: NOW
    })
    expect(result.lines[1]).toContain('🟢')
  })

  it('treats everything as new when the session has no previous user message', () => {
    const result = buildDmRosterDcmLines({ records: [dm()], now: NOW })
    expect(result.lines[1]).toContain('✅')
  })

  it('flags urgency', () => {
    const result = buildDmRosterDcmLines({
      records: [dm({ priority: 'urgent' })],
      now: NOW
    })
    expect(result.lines[1]).toContain('assignment (urgent) from Faye')
  })

  it('says where a claimed item is being handled', () => {
    const here = buildDmRosterDcmLines({
      records: [
        dm({ status: 'working', claimedBy: { agentId: 'agent-cooper', sessionId: 'sess-a' } })
      ],
      sessionId: 'sess-a',
      now: NOW
    })
    expect(here.lines[1]).toContain('claimed in this session')

    const elsewhere = buildDmRosterDcmLines({
      records: [
        dm({ status: 'working', claimedBy: { agentId: 'agent-cooper', sessionId: 'sess-b' } })
      ],
      sessionId: 'sess-a',
      now: NOW
    })
    expect(elsewhere.lines[1]).toContain('claimed in another session')
  })

  it('falls back to hours when less than a day remains', () => {
    const result = buildDmRosterDcmLines({
      records: [dm({ expiresAt: new Date(NOW + 5 * 60 * 60 * 1000).toISOString() })],
      now: NOW
    })
    expect(result.lines[1]).toContain('expires in 5h')
  })

  it('says "expired" rather than a negative number for an overdue item the reaper has not seen', () => {
    const result = buildDmRosterDcmLines({
      records: [dm({ expiresAt: new Date(NOW - 1000).toISOString() })],
      now: NOW
    })
    expect(result.lines[1]).toContain('expired')
  })

  it('survives an unparseable expiry rather than printing NaN', () => {
    const result = buildDmRosterDcmLines({
      records: [dm({ expiresAt: 'not a date' })],
      now: NOW
    })
    expect(result.lines[1]).toContain('expiry unknown')
    expect(result.lines[1]).not.toContain('NaN')
  })
})

describe('the cap', () => {
  it('lists at most the cap and summarises the rest', () => {
    const records = Array.from({ length: DM_ROSTER_MAX_LINES + 3 }, (_, index) =>
      dm({ id: `dm_${index}` })
    )
    const result = buildDmRosterDcmLines({ records, now: NOW })

    expect(result.totalOpen).toBe(DM_ROSTER_MAX_LINES + 3)
    expect(result.listedIds).toHaveLength(DM_ROSTER_MAX_LINES)
    // 1 header + cap lines + 1 "more open" line.
    expect(result.lines).toHaveLength(DM_ROSTER_MAX_LINES + 2)
    expect(result.lines.at(-1)).toBe('- More open: 3 (use sys.dm.list to see them all)')
  })

  it('adds no "more open" line when everything fits', () => {
    const records = Array.from({ length: DM_ROSTER_MAX_LINES }, (_, index) =>
      dm({ id: `dm_${index}` })
    )
    const result = buildDmRosterDcmLines({ records, now: NOW })
    expect(result.lines.at(-1)).not.toContain('More open')
  })
})

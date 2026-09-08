import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetDmInboxCountsForTests,
  applyDmInboxChanged,
  getDmInboxCounts,
  hydrateDmInboxCounts
} from '../dmInbox.svelte'

/**
 * SA-113 P4 — the header badge's counts.
 *
 * The badge is on screen the whole time, so it must never poll: the server publishes the
 * numbers on the user channel and this store just holds them. What is worth pinning is
 * that a hydrate RESETS agents it did not hear about, because a DM deleted while the tab
 * was closed would otherwise keep its badge forever.
 */

beforeEach(() => {
  __resetDmInboxCountsForTests()
})

describe('dmInbox counts', () => {
  it('answers zero for an agent it has never heard of', () => {
    expect(getDmInboxCounts('agent-cooper')).toEqual({
      openCount: 0,
      newCount: 0,
      needsUserCount: 0
    })
    expect(getDmInboxCounts(null)).toEqual({ openCount: 0, newCount: 0, needsUserCount: 0 })
  })

  it('applies a live event', () => {
    applyDmInboxChanged({ agentId: 'agent-cooper', openCount: 3, newCount: 1, needsUserCount: 2 })
    expect(getDmInboxCounts('agent-cooper')).toEqual({
      openCount: 3,
      newCount: 1,
      needsUserCount: 2
    })
  })

  it('ignores an event with no agent and clamps nonsense numbers', () => {
    applyDmInboxChanged({ openCount: 5, newCount: 5 })
    applyDmInboxChanged({
      agentId: 'agent-faye',
      openCount: -4,
      newCount: 'lots',
      needsUserCount: null
    })
    expect(getDmInboxCounts('agent-faye')).toEqual({
      openCount: 0,
      newCount: 0,
      needsUserCount: 0
    })
  })

  it('counts only OPEN rows when hydrating, per agent', () => {
    hydrateDmInboxCounts(
      [
        { to: 'agent-cooper', status: 'new' },
        {
          to: 'agent-cooper',
          status: 'working',
          // F-SEC-1b: a woken turn parked on the user. Only OPEN rows count, so a stamp on
          // a closed row must not keep the envelope orange.
          delivery: { needsUser: { reason: 'Waiting on you.', at: '2026-09-08T09:00:00.000Z' } }
        },
        {
          to: 'agent-cooper',
          status: 'done',
          delivery: { needsUser: { reason: 'stale', at: '2026-09-08T08:00:00.000Z' } }
        },
        { to: 'agent-faye', status: 'new' },
        { to: 'agent-faye', status: 'expired' }
      ],
      ['agent-cooper', 'agent-faye']
    )
    expect(getDmInboxCounts('agent-cooper')).toEqual({
      openCount: 2,
      newCount: 1,
      needsUserCount: 1
    })
    expect(getDmInboxCounts('agent-faye')).toEqual({
      openCount: 1,
      newCount: 1,
      needsUserCount: 0
    })
  })

  it('resets an agent whose DMs are all gone', () => {
    applyDmInboxChanged({ agentId: 'agent-cooper', openCount: 4, newCount: 4, needsUserCount: 1 })
    hydrateDmInboxCounts([], ['agent-cooper'])
    expect(getDmInboxCounts('agent-cooper')).toEqual({
      openCount: 0,
      newCount: 0,
      needsUserCount: 0
    })
  })
})

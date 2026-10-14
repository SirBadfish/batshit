import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetToolModelRetentionTurnBudgetsForTests,
  clearToolModelRetentionBudgetsForSession,
  reserveToolModelRetainedCopy,
  TOOL_MODEL_RETAINED_COPIES_PER_MESSAGE,
  TOOL_MODEL_RETENTION_TURN_MAX_AGE_MS,
  type ToolModelRetentionTurnKey
} from '../toolModelRetentionTurnBudget'
import {
  __resetStreamAbortRegistryForTests,
  clearSessionTurn,
  registerSessionTurn,
  releaseSessionTurn
} from '../streamAbortRegistry'

const turn: ToolModelRetentionTurnKey = {
  sessionId: 'chat', agentId: 'agent', messageId: 'reply'
}

beforeEach(() => {
  __resetToolModelRetentionTurnBudgetsForTests()
  __resetStreamAbortRegistryForTests()
})

afterEach(() => {
  vi.useRealTimers()
  __resetStreamAbortRegistryForTests()
  __resetToolModelRetentionTurnBudgetsForTests()
})

function fill(key = turn): void {
  for (let index = 0; index < TOOL_MODEL_RETAINED_COPIES_PER_MESSAGE; index += 1) {
    const reservation = reserveToolModelRetainedCopy(key)
    expect(reservation).not.toBeNull()
    reservation?.commit()
  }
}

describe('retained tool-output turn budget (BL-494 P2)', () => {
  it('admits exactly fifty synchronous reservations even when the writes run concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 51 }, async () => {
      const reservation = reserveToolModelRetainedCopy(turn)
      await Promise.resolve()
      reservation?.commit()
      return reservation !== null
    }))
    expect(results.filter(Boolean)).toHaveLength(50)
    expect(results.filter((result) => !result)).toHaveLength(1)
  })

  it('rolls back failed writes or undelivered committed copies exactly once', () => {
    const failed = reserveToolModelRetainedCopy(turn)
    failed?.rollback()
    failed?.rollback()
    const delivered = reserveToolModelRetainedCopy(turn)
    delivered?.commit()
    for (let index = 1; index < TOOL_MODEL_RETAINED_COPIES_PER_MESSAGE; index += 1) {
      expect(reserveToolModelRetainedCopy(turn)).not.toBeNull()
    }
    expect(reserveToolModelRetainedCopy(turn)).toBeNull()
    delivered?.rollback()
    delivered?.rollback()
    expect(reserveToolModelRetainedCopy(turn)).not.toBeNull()
    expect(reserveToolModelRetainedCopy(turn)).toBeNull()
  })

  it('separates replies, agents, and chats and refuses missing identity', () => {
    fill()
    expect(reserveToolModelRetainedCopy(turn)).toBeNull()
    expect(reserveToolModelRetainedCopy({ ...turn, messageId: 'next-reply' })).not.toBeNull()
    expect(reserveToolModelRetainedCopy({ ...turn, agentId: 'group-peer' })).not.toBeNull()
    expect(reserveToolModelRetainedCopy({ ...turn, sessionId: 'other-chat' })).not.toBeNull()
    expect(() => reserveToolModelRetainedCopy({ ...turn, messageId: ' ' })).toThrow('reply identity')
  })

  it('expires six hours from creation, even after later reservations, and ignores stale rollback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    const old = reserveToolModelRetainedCopy(turn)
    vi.advanceTimersByTime(3 * 60 * 60 * 1000)
    reserveToolModelRetainedCopy(turn)?.commit()
    vi.advanceTimersByTime(TOOL_MODEL_RETENTION_TURN_MAX_AGE_MS - 3 * 60 * 60 * 1000)
    const fresh = reserveToolModelRetainedCopy(turn)
    expect(fresh).not.toBeNull()
    old?.rollback()
    fresh?.commit()
    for (let index = 1; index < TOOL_MODEL_RETAINED_COPIES_PER_MESSAGE; index += 1) {
      reserveToolModelRetainedCopy(turn)?.commit()
    }
    expect(reserveToolModelRetainedCopy(turn)).toBeNull()
  })

  it('clears a group turn with no lock message id after its request ends', () => {
    const group = registerSessionTurn(turn.sessionId, 'group')
    if (!group.ok) throw new Error('group registration refused')
    fill()
    expect(reserveToolModelRetainedCopy(turn)).toBeNull()
    releaseSessionTurn(turn.sessionId, group.entry.turnId)
    expect(reserveToolModelRetainedCopy(turn)).not.toBeNull()
  })

  it('keeps an overlapping successor until the last request ends, even with the same message id', () => {
    const first = registerSessionTurn(turn.sessionId, 'single', turn.messageId)
    if (!first.ok) throw new Error('first registration refused')
    fill()
    clearSessionTurn(turn.sessionId, turn.messageId)
    const successor = registerSessionTurn(turn.sessionId, 'single', turn.messageId, { answersApproval: true })
    if (!successor.ok) throw new Error('successor registration refused')
    expect(releaseSessionTurn(turn.sessionId, first.entry.turnId)).toBe(false)
    expect(reserveToolModelRetainedCopy(turn)).toBeNull()
    expect(releaseSessionTurn(turn.sessionId, successor.entry.turnId)).toBe(true)
    expect(reserveToolModelRetainedCopy(turn)).not.toBeNull()
  })

  it('clears one chat without resetting another chat budget', () => {
    const other = { ...turn, sessionId: 'other-chat' }
    fill()
    fill(other)
    clearToolModelRetentionBudgetsForSession(turn.sessionId)
    expect(reserveToolModelRetainedCopy(turn)).not.toBeNull()
    expect(reserveToolModelRetainedCopy(other)).toBeNull()
  })
})

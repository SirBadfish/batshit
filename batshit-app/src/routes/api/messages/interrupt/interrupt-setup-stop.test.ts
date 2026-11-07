import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStreamAbortRegistryForTests,
  clearStreamAbort,
  getActiveSessionTurn,
  getActiveStream,
  registerSessionTurn,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'

const redisMock = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('$lib/server/redis', () => ({ redis: redisMock }))
vi.mock('$lib/server/services/agentWakeups', () => ({
  abortWokenTurnForInterrupt: vi.fn(() => false)
}))
const heldRuns = vi.hoisted(() => ({ ended: 0 }))
vi.mock('$lib/server/services/claudePlanRunRegistry', () => ({
  endHeldClaudePlanRuns: vi.fn(async () => ({ ended: heldRuns.ended, unsettled: 0 }))
}))

/**
 * Stop, pressed while a turn is still SETTING UP (2026-09-18).
 *
 * Setup (the compile, the snapshot, the bridge) runs before any stream is registered. The route
 * used to find only the lock, answer `stale_turn_cleared`, and delete that LIVE lock, while the
 * reply ran on to a full answer: measured in a real page, Stop 150 ms after the send, the
 * reply ran `sleep 20` and wrote "Done." (`_local/stopfix-proof/before-page-same-150b.json`).
 * Now the route stops the turn itself; send-routed carries that into the run, and the setup
 * checkpoint ends it before the provider call. The lock stays until the request lets go.
 */

async function stop(sessionId = 'session-1', messageId = 'msg-1') {
  const { POST } = await import('./+server')
  const response = await POST({
    request: new Request('http://localhost/api/messages/interrupt', {
      method: 'POST',
      body: JSON.stringify({ sessionId, messageId })
    }),
    locals: { user: { id: 'user-1' } }
  } as any)
  return (await response.json()) as Record<string, unknown>
}

describe('POST /api/messages/interrupt', () => {
  beforeEach(() => {
    __resetStreamAbortRegistryForTests()
    redisMock.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
  })

  afterEach(() => {
    __resetStreamAbortRegistryForTests()
  })

  it('stops a turn still setting up, and leaves its lock to the request', async () => {
    const turn = registerSessionTurn('session-1', 'single', 'msg-1')
    if (!turn.ok) throw new Error('registration refused')

    const answer = await stop()

    expect(answer).toMatchObject({ success: true, reason: 'setup_stopped' })
    expect(turn.entry.stop.signal.aborted).toBe(true)
    expect(turn.entry.stop.signal.reason).toBe('user')
    expect(getActiveSessionTurn('session-1')).toBe(turn.entry)
  })

  it('still aborts a running stream the way it did', async () => {
    const turn = registerSessionTurn('session-1', 'single', 'msg-1')
    if (!turn.ok) throw new Error('registration refused')
    const stream = new AbortController()
    registerStreamAbort('session-1', 'msg-1', stream)

    const answer = await stop()

    expect(answer).toMatchObject({ success: true, messageId: 'msg-1' })
    expect(answer.reason).toBe('aborted')
    expect(stream.signal.reason).toBe('user')
    expect(getActiveStream('session-1')).not.toBeNull()
  })

  it('SA-139 D6: Stop in the gap after a reply that ended at a card ends the chat\'s held Claude plan run', async () => {
    const { endHeldClaudePlanRuns } = await import('$lib/server/services/claudePlanRunRegistry')
    heldRuns.ended = 1
    const answer = await stop()
    heldRuns.ended = 0
    expect(endHeldClaudePlanRuns).toHaveBeenCalledWith({ sessionId: 'session-1' }, expect.stringContaining('approval card'))
    expect(answer).toMatchObject({ success: true, reason: 'no_active_stream', endedHeldClaudePlanRuns: 1 })
  })

  it('SA-139 D6 (review B S3): Stop while a card\'s reply is over but its request still holds the lock ends the held run too', async () => {
    const { endHeldClaudePlanRuns } = await import('$lib/server/services/claudePlanRunRegistry')
    vi.mocked(endHeldClaudePlanRuns).mockClear()
    const turn = registerSessionTurn('session-1', 'single', 'msg-1')
    if (!turn.ok) throw new Error('registration refused')
    registerStreamAbort('session-1', 'msg-1', new AbortController())
    clearStreamAbort('session-1', 'msg-1')
    heldRuns.ended = 1
    const answer = await stop()
    heldRuns.ended = 0
    expect(endHeldClaudePlanRuns).toHaveBeenCalledWith({ sessionId: 'session-1' }, expect.stringContaining('approval card'))
    expect(answer).toMatchObject({ success: true, reason: 'stale_turn_cleared', endedHeldClaudePlanRuns: 1 })
  })

  it('keeps clearing a lock whose reply is already over', async () => {
    // The reply ended (its stream cleared); the request is in its after-reply work or stuck.
    const turn = registerSessionTurn('session-1', 'single', 'msg-1')
    if (!turn.ok) throw new Error('registration refused')
    registerStreamAbort('session-1', 'msg-1', new AbortController())
    clearStreamAbort('session-1', 'msg-1')

    const answer = await stop()

    expect(answer).toMatchObject({ success: true, reason: 'stale_turn_cleared' })
    expect(turn.entry.stop.signal.aborted).toBe(false)
    expect(getActiveSessionTurn('session-1')).toBeNull()
  })
})

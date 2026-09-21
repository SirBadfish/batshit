import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetWakeRunRegistryForTests,
  registerWakeRun
} from '$lib/server/services/wakeRunRegistry'
import {
  __resetStreamAbortRegistryForTests,
  getActiveSessionTurn,
  registerSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import { buildSessionOrigin } from '$lib/utils/sessionOrigin'
import { POST as interrupt } from '../../../routes/api/messages/interrupt/+server'

/**
 * SA-113 P1 / AMD-113-02 — Stop has to cover the setup window.
 *
 * The P0 spike measured the gap: a Stop landing during a turn's 3–9 second setup finds no
 * stream controller, so the interrupt route answers `stale_turn_cleared`, clears the lock,
 * and the run finishes normally — the user pressed Stop and still got a full answer.
 *
 * The fix is that a woken turn's own request is aborted FIRST, which makes SvelteKit fire
 * `request.signal` inside send-routed. These pin that the interrupt route does it, and
 * that it stays a no-op for an ordinary browser turn.
 */

useRedisTestServer()

const USER = 'user-interrupt-wake'

function interruptRequest(sessionId: string) {
  return {
    request: new Request('http://localhost:5621/api/messages/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    }),
    locals: { user: { id: USER } }
  }
}

function startWakeRun(sessionId: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => {}, 60_000)
  registerWakeRun({
    sessionId,
    agentId: 'agent-cooper',
    userId: USER,
    origin: buildSessionOrigin({ kind: 'dm', label: 'Faye', chainDepth: 1 }),
    startedAt: Date.now(),
    controller,
    timer
  })
  return controller
}

beforeEach(async () => {
  await redis.createSession({
    id: 'sess-woken',
    user_id: USER,
    name: 'Woken',
    agent_id: 'agent-cooper',
    created_at: '2026-09-07T09:00:00.000Z',
    last_modified_at: '2026-09-07T09:00:00.000Z'
  } as any)
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetWakeRunRegistryForTests()
  // A hard reset, not `clearSessionTurn`: an id-less release no longer deletes a live
  // owned lock, so teardown cannot rely on it.
  __resetStreamAbortRegistryForTests()
})

describe('POST /api/messages/interrupt', () => {
  it('aborts a woken turn stuck in setup, where there is no stream controller yet', async () => {
    const controller = startWakeRun('sess-woken')
    registerSessionTurn('sess-woken', 'single', 'msg-1')

    const response = (await (interrupt as any)(interruptRequest('sess-woken'))) as Response
    const body = await response.json()

    expect(controller.signal.aborted).toBe(true)
    expect(body).toMatchObject({ success: true, abortedWokenTurn: true })
    // The reason now says the woken turn was really stopped, not that a stale lock was
    // swept — the old `stale_turn_cleared` answer was the misleading part.
    expect(body.reason).toBe('wake_run_aborted')
  })

  it('aborts a woken turn even before its session-turn lock exists', async () => {
    const controller = startWakeRun('sess-woken')

    const response = (await (interrupt as any)(interruptRequest('sess-woken'))) as Response
    const body = await response.json()

    expect(controller.signal.aborted).toBe(true)
    expect(body).toMatchObject({ success: true, abortedWokenTurn: true })
  })

  it('is a no-op for an ordinary browser turn with nothing running', async () => {
    const response = (await (interrupt as any)(interruptRequest('sess-woken'))) as Response
    const body = await response.json()

    expect(body).toMatchObject({
      success: false,
      reason: 'no_active_stream',
      abortedWokenTurn: false
    })
  })

  it('stops an ordinary turn with nothing registered to abort, and frees a stuck one 5 s later', async () => {
    // Nothing is registered under this lock: its request is setting up, or stuck. A Stop stops
    // the turn (2026-09-18). It used to delete the lock at once (`stale_turn_cleared`), which
    // freed a stuck chat but let a reply still setting up run on to a full answer.
    const turn = registerSessionTurn('sess-woken', 'single', 'msg-1')
    if (!turn.ok) throw new Error('registration refused')

    const response = (await (interrupt as any)(interruptRequest('sess-woken'))) as Response
    const body = await response.json()

    expect(body).toMatchObject({
      success: true,
      reason: 'setup_stopped',
      abortedWokenTurn: false
    })
    expect(turn.entry.stop.signal.aborted).toBe(true)
    expect(getActiveSessionTurn('sess-woken')).toBe(turn.entry)

    // Its request never let go: the lock goes after the aborted-stream grace.
    const stoppedAt = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(stoppedAt + 5_001)
    expect(getActiveSessionTurn('sess-woken')).toBeNull()
  })

  it('refuses a session the user does not own', async () => {
    const response = (await (interrupt as any)({
      request: new Request('http://localhost:5621/api/messages/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-woken' })
      }),
      locals: { user: { id: 'someone-else' } }
    })) as Response

    expect(response.status).toBe(404)
  })
})

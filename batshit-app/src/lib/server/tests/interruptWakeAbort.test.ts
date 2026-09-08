import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetWakeRunRegistryForTests,
  registerWakeRun
} from '$lib/server/services/wakeRunRegistry'
import {
  clearSessionTurn,
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
  __resetWakeRunRegistryForTests()
  clearSessionTurn('sess-woken')
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

  it('still clears a genuinely stale lock for an ordinary turn', async () => {
    registerSessionTurn('sess-woken', 'single', 'msg-1')

    const response = (await (interrupt as any)(interruptRequest('sess-woken'))) as Response
    const body = await response.json()

    expect(body).toMatchObject({
      success: true,
      reason: 'stale_turn_cleared',
      abortedWokenTurn: false
    })
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

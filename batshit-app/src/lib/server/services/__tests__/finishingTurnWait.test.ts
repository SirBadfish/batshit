import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStreamAbortRegistryForTests,
  clearStreamAbort,
  getActiveSessionTurn,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  FINISHING_TURN_WAIT_MS,
  waitForFinishingTurn
} from '$lib/server/services/finishingTurnWait'

/**
 * A new turn waits for the previous one to FINISH instead of being refused.
 *
 * Measured on the smoke stack on 2026-09-18 (`_local/queued-send-proof/`): a message queued in
 * the browser (it carried a Clip) goes out the moment the reply ends, reached send-routed 0.8 to
 * 1.6 s before that reply's request had finished its after-reply work, and was refused
 * `session_turn_in_progress` in 9 runs out of 9, on the Codex lane and the API lane alike. The
 * user's words were stored and never answered. These drive the REAL lock registry.
 */

const SESSION = 'session-finishing-turn'

beforeEach(() => {
  __resetStreamAbortRegistryForTests()
})

afterEach(() => {
  vi.useRealTimers()
  __resetStreamAbortRegistryForTests()
})

function finishedReply(messageId = 'msg_reply') {
  const reply = registerSessionTurn(SESSION, 'single', messageId)
  if (!reply.ok) throw new Error('registration refused')
  registerStreamAbort(SESSION, messageId, new AbortController())
  clearStreamAbort(SESSION, messageId)
  return reply.entry
}

describe('waitForFinishingTurn', () => {
  it('waits while the reply finishes its after-reply work, and ends when it lets go', async () => {
    vi.useFakeTimers()
    const reply = finishedReply()

    let outcome: string | null = null
    void waitForFinishingTurn(SESSION).then((value) => {
      outcome = value
    })
    await vi.advanceTimersByTimeAsync(1_600)
    expect(outcome).toBeNull()
    // The wait never takes or clears the lock.
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: 'msg_reply' })

    releaseSessionTurn(SESSION, reply.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(outcome).toBe('released')
    expect(getActiveSessionTurn(SESSION)).toBeNull()
  })

  it('does not wait for a turn that is still setting up or still streaming', async () => {
    registerSessionTurn(SESSION, 'single', 'msg_setup')
    const started = Date.now()
    expect(await waitForFinishingTurn(SESSION)).toBe('no_wait')

    registerStreamAbort(SESSION, 'msg_setup', new AbortController())
    expect(await waitForFinishingTurn(SESSION)).toBe('no_wait')
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('does not wait when nothing holds the chat', async () => {
    expect(await waitForFinishingTurn(SESSION)).toBe('no_wait')
  })

  it('stops waiting when the finishing request starts another run under its lock', async () => {
    // A context-exhaustion continuation or a promoted steer: a whole new reply, not after-reply
    // work. The caller's lock check refuses the send, as it did before.
    vi.useFakeTimers()
    finishedReply()

    let outcome: string | null = null
    void waitForFinishingTurn(SESSION).then((value) => {
      outcome = value
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(outcome).toBeNull()

    registerStreamAbort(SESSION, 'msg_continuation', new AbortController())
    await vi.advanceTimersByTimeAsync(150)
    expect(outcome).toBe('released')
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: 'msg_reply' })
  })

  it('gives up at the bound, fifteen seconds, and leaves the lock alone', async () => {
    vi.useFakeTimers()
    finishedReply()

    let outcome: string | null = null
    void waitForFinishingTurn(SESSION).then((value) => {
      outcome = value
    })
    await vi.advanceTimersByTimeAsync(14_800)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(400)
    expect(outcome).toBe('timed_out')
    expect(FINISHING_TURN_WAIT_MS).toBe(15_000)
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: 'msg_reply' })
  })
})

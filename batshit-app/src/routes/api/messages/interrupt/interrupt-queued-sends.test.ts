import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStreamAbortRegistryForTests,
  countQueuedSessionTurns,
  countRunnableQueuedSessionTurns,
  noteQueuedSendNotice,
  queueSessionTurn,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'

const redisMock = vi.hoisted(() => ({ getSession: vi.fn() }))
const limits = vi.hoisted(() => ({ forwardLimitMs: 5_000 }))
vi.mock('$lib/server/services/queuedSendRules', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    get QUEUED_SEND_FORWARD_LIMIT_MS() {
      return limits.forwardLimitMs
    }
  }
})
vi.mock('$lib/server/redis', () => ({ redis: redisMock }))
vi.mock('$lib/server/services/agentWakeups', () => ({
  abortWokenTurnForInterrupt: vi.fn(() => false)
}))
// Batshit's own calls (a woken turn's time limit) carry the service token; the test marks them.
vi.mock('$lib/server/services/internalRequestAuth', () => ({
  isTrustedInternalRequest: (request: Request) => request.headers.get('x-test-internal') === '1',
  internalServiceHeaders: () => ({})
}))

/**
 * BL-4 — Stop stops everything, a waiting message included (AMD-119-04).
 *
 * Sends that met the running turn wait in the chat's line. A Stop keeps every one of them: none
 * will run, and each is still handed the chat in its turn only to move its saved message to the
 * end, unanswered (`queuedSendKeeper.ts`). The route tells every tab at once, so the bubbles
 * become "Not sent" receipts without waiting for the stopped reply to let go.
 */

let sseBodies: any[] = []

/** The chat's own Stop button: the user stops the chat, waiting sends included. */
async function stop(sessionId = 'session-1', messageId = 'msg-1') {
  return post({ sessionId, messageId, stopsWaitingSends: true })
}

async function post(body: Record<string, unknown>, options: { internal?: boolean } = {}) {
  const { POST } = await import('./+server')
  const response = await POST({
    request: new Request('http://localhost/api/messages/interrupt', {
      method: 'POST',
      headers: options.internal ? { 'x-test-internal': '1' } : {},
      body: JSON.stringify(body)
    }),
    locals: options.internal ? {} : { user: { id: 'user-1' } }
  } as any)
  return (await response.json()) as Record<string, unknown>
}

describe('POST /api/messages/interrupt — sends waiting in the line (BL-4)', () => {
  beforeEach(() => {
    __resetStreamAbortRegistryForTests()
    redisMock.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    sseBodies = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        sseBodies.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      })
    )
  })

  afterEach(() => {
    limits.forwardLimitMs = 5_000
    vi.unstubAllGlobals()
    __resetStreamAbortRegistryForTests()
  })

  it('keeps every waiting send behind a running reply, and tells every tab at once', async () => {
    registerSessionTurn('session-1', 'single', 'msg-1')
    registerStreamAbort('session-1', 'msg-1', new AbortController())
    queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })

    const answer = await stop()

    expect(answer).toMatchObject({ success: true, keptQueuedSends: 2 })
    expect(countQueuedSessionTurns('session-1')).toBe(2)
    expect(countRunnableQueuedSessionTurns('session-1')).toBe(0)
    expect(sseBodies).toEqual([
      {
        type: 'queued_send_dropped',
        sessionId: 'session-1',
        userMessageIds: ['msg-b', 'msg-c'],
        reason: 'stopped'
      }
    ])
  })

  it('keeps them behind a turn that is still setting up', async () => {
    registerSessionTurn('session-1', 'single', 'msg-1')
    queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })

    const answer = await stop()

    expect(answer).toMatchObject({ success: true, reason: 'setup_stopped', keptQueuedSends: 1 })
    expect(countRunnableQueuedSessionTurns('session-1')).toBe(0)
  })

  it('keeps a line that waits while the chat is free for an approval click', async () => {
    const { holdQueueForApprovalClick } = await import('$lib/server/services/streamAbortRegistry')
    const holder = registerSessionTurn('session-1', 'single', 'msg-1')
    if (!holder.ok) throw new Error('registration refused')
    queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    const releaseClick = holdQueueForApprovalClick('session-1')
    releaseSessionTurn('session-1', holder.entry.turnId)

    const answer = await stop()
    releaseClick()

    expect(answer).toMatchObject({ keptQueuedSends: 1 })
    expect(countRunnableQueuedSessionTurns('session-1')).toBe(0)
    expect(sseBodies[0]).toMatchObject({ type: 'queued_send_dropped', userMessageIds: ['msg-b'] })
  })

  it('a woken turn’s time limit is not the user’s Stop: the waiting sends run (review finding 1)', async () => {
    // `endWokenTurn(..., 'timed_out')` posts here with the service token and names no message.
    registerSessionTurn('session-1', 'single', 'msg-wake-reply')
    registerStreamAbort('session-1', 'msg-wake-reply', new AbortController())
    queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })

    const answer = await post({ sessionId: 'session-1' }, { internal: true })

    expect(answer).toMatchObject({ success: true, keptQueuedSends: 0 })
    expect(countRunnableQueuedSessionTurns('session-1')).toBe(1)
    expect(sseBodies).toEqual([])
  })

  it('the DM drawer’s Stop of a woken run keeps nothing either: only the chat’s own Stop does', async () => {
    registerSessionTurn('session-1', 'single', 'msg-wake-reply')
    registerStreamAbort('session-1', 'msg-wake-reply', new AbortController())
    queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })

    const answer = await post({ sessionId: 'session-1' })

    expect(answer).toMatchObject({ success: true, keptQueuedSends: 0 })
    expect(countRunnableQueuedSessionTurns('session-1')).toBe(1)
    expect(sseBodies).toEqual([])
  })

  it('tells the tabs "Not sent" only after each kept send’s "Queued" bubble went out (BL-203)', async () => {
    // Arriving first, the dropped notice named a bubble no tab had yet, so it changed nothing,
    // and the late "Queued" then showed a waiting bubble for a send the Stop had kept.
    registerSessionTurn('session-1', 'single', 'msg-1')
    registerStreamAbort('session-1', 'msg-1', new AbortController())
    const b = queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    let queuedBubbleSent: () => void = () => {}
    noteQueuedSendNotice(
      'session-1',
      b.queueId,
      new Promise<void>((resolve) => {
        queuedBubbleSent = resolve
      })
    )

    const answered = stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sseBodies).toEqual([])

    queuedBubbleSent()
    expect(await answered).toMatchObject({ keptQueuedSends: 1 })
    expect(sseBodies).toEqual([
      { type: 'queued_send_dropped', sessionId: 'session-1', userMessageIds: ['msg-b'], reason: 'stopped' }
    ])
  })

  it('a "Not sent" post that never answers is given up after its time limit, and the Stop answers (review finding 2)', async () => {
    // The page waits for this answer before it clears its Stop state, and BL-203 already put up
    // to one forward limit in front of it.
    limits.forwardLimitMs = 50
    let abortedWith: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: any, init: any) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              abortedWith = init.signal.reason
              reject(init.signal.reason)
            })
          })
      )
    )
    registerSessionTurn('session-1', 'single', 'msg-1')
    registerStreamAbort('session-1', 'msg-1', new AbortController())
    queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })

    const answer = await Promise.race([
      stop(),
      new Promise((resolve) => setTimeout(() => resolve('no answer'), 2_000))
    ])

    expect(answer).toMatchObject({ keptQueuedSends: 1 })
    expect((abortedWith as { name?: string } | null)?.name).toBe('TimeoutError')
  })

  it('says nothing to the tabs when nothing was waiting', async () => {
    registerSessionTurn('session-1', 'single', 'msg-1')
    registerStreamAbort('session-1', 'msg-1', new AbortController())

    const answer = await stop()

    expect(answer).toMatchObject({ success: true, keptQueuedSends: 0 })
    expect(sseBodies).toEqual([])
  })
})

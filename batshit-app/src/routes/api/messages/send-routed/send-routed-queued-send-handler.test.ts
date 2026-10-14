import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetStreamAbortRegistryForTests,
  beginSessionDelete,
  cancelQueuedSessionTurnsOfDeletedChat,
  clearSessionTurn,
  QUEUED_HANDOVER_REQUEST_WAIT_MS,
  getActiveSessionTurn,
  isUserMessageQueued,
  queuedSendNotices,
  queueSessionTurn,
  registerSessionTurn,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import { isQueuedSendMessageHidden } from '$lib/server/services/queuedSendHiddenIds'
import {
  __resetTurnOutcomesForTests,
  watchTurnOutcome,
  type TurnOutcome
} from '$lib/server/services/turnOutcomeRegistry'

/**
 * BL-4, second review — send-routed's own handler around the chat's waiting line.
 *
 * The contract pins say WHERE the handler asks; these run the real handler, with Redis and the
 * sandbox sweep faked, to prove what happens between a send joining the line and taking the
 * chat: the handover can land while the request is still busy (it forwards the "Queued"
 * bubble to every tab with a real fetch), and a throw there must not leave the send in line.
 * The handler is stopped right after it takes the chat: the chat's re-read under the lock
 * answers "deleted" (the chat's second `getSession`), so a 404 proves the send got the chat and
 * a 409 proves it lost it.
 *
 * BL-214 / BL-242 / BL-210: under a heavily loaded machine this file timed out. The first test
 * paid for the cold import of the whole send-routed handler (7 s of transform at load 60), and
 * the timed-out test's request then ran on into the next test and read ITS mocks: it took the
 * next test's first `getSession`, so that test's own read under the lock answered "deleted" and
 * it got 404 instead of 500. So the handler is imported once, before any test, with its own
 * limit; every test has its own chat, and each chat keeps its own read count; and after each
 * test every request it started is let go of and finished (`drainRequests`) before the next test
 * starts.
 */
const USER = 'user-1'
/** The import of the whole send-routed handler, cold, on a machine at load average 60 took 7 s. */
const HANDLER_IMPORT_LIMIT_MS = 120_000
/** How long the after-test drain waits for the requests a test started. */
const DRAIN_LIMIT_MS = 10_000

const mocks = vi.hoisted(() => ({
  /** Each chat's `getSession` count: found on the way in, "deleted" on the re-read under the lock. */
  sessionReads: new Map<string, number>(),
  /** Chats whose re-read under the lock still finds them (the turn goes on past it). */
  chatsThatSurvive: new Set<string>(),
  /** What `moveMessageToEnd` answers: `null` is a message deleted while it waited. */
  movedMessage: null as Record<string, unknown> | null,
  holdWorkThrows: false,
  /** Every `/api/sse` forward waits for the test to let it through; off, each answers at once. */
  holdForwards: true,
  sseForwards: [] as Array<{ body: any; release: () => void; abortedWith: unknown }>,
  /** The forward's time limit this test runs with (BL-204). */
  forwardLimitMs: 5_000,
  /** What the handler did, in order, from the sandbox sweeps to the stop point below. */
  steps: [] as string[]
}))

// A turn that gets past its setup reads the voice settings before its model run: the stop point
// for a test that needs the handler to get further than the re-read under the lock.
vi.mock('$lib/server/services/voiceService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveVoiceConfigForMetadata: vi.fn(async () => {
    mocks.steps.push('setup done')
    throw new Error('stopped before the model run (test)')
  })
}))

vi.mock('$lib/server/services/queuedSendRules', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    get QUEUED_SEND_FORWARD_LIMIT_MS() {
      return mocks.forwardLimitMs
    }
  }
})

vi.mock('$lib/server/redis', () => ({
  redis: {
    getAgents: vi.fn(async () => [
      { id: 'agent-1', user_id: 'user-1', agentType: 'api', displayName: 'Probe' }
    ]),
    getUserSettings: vi.fn(async () => ({})),
    getSession: vi.fn(async (sessionId: string) => {
      const reads = (mocks.sessionReads.get(sessionId) ?? 0) + 1
      mocks.sessionReads.set(sessionId, reads)
      // Found on the way in; "deleted" on the re-read under the lock, which ends the turn.
      return reads === 1 || mocks.chatsThatSurvive.has(sessionId)
        ? { id: sessionId, user_id: 'user-1', metadata: {} }
        : null
    }),
    get: vi.fn(async () => null),
    moveMessageToEnd: vi.fn(async () => mocks.movedMessage),
    getRecentMessages: vi.fn(async () => []),
    execute: vi.fn(async (operation: (client: any) => Promise<unknown>) =>
      operation({
        json: {
          get: vi.fn(async (key: string) => {
            const [, sessionId, messageId] = key.split(':')
            return messageId === 'msg-b'
              ? { id: 'msg-b', role: 'user', session_id: sessionId, user_id: 'user-1', content: 'SECOND' }
              : null
          })
        },
        lRange: vi.fn(async () => []),
        lPos: vi.fn(async () => null)
      })
    )
  }
}))

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: {
    cleanupExecutionSandboxesForSession: vi.fn(async () => {
      mocks.steps.push('sandbox sweep')
      return []
    })
  }
}))

vi.mock('$lib/server/services/backupRestoreService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enterBackupRestoreHttpRequest: vi.fn(() => {
    if (mocks.holdWorkThrows) throw new Error('hold refused (test)')
    return () => {}
  })
}))

/** Every POST to /api/sse waits until the test lets it through, like a slow real fetch. */
function stubSseFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: any, init: any) => {
      if (!String(url).includes('/api/sse') || !mocks.holdForwards) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return new Promise<Response>((resolve, reject) => {
        const forward = {
          body: JSON.parse(init?.body ?? '{}'),
          release: () => resolve(new Response('{}', { status: 200 })),
          abortedWith: undefined as unknown
        }
        // A real fetch gives up when its signal aborts.
        const signal: AbortSignal | undefined = init?.signal
        signal?.addEventListener('abort', () => {
          forward.abortedWith = signal.reason
          reject(signal.reason)
        })
        mocks.sseForwards.push(forward)
      })
    })
  )
}

let POST: (event: any) => Promise<Response>
let chatCount = 0
/** This test's own chat. A request a timed-out test left behind names another one. */
let SESSION = ''
/** Every request this test started, until it has finished (its final answer, when answered early). */
let requests: Promise<unknown>[] = []

function outcomeOf(turnId: string) {
  return new Promise<TurnOutcome>((resolve) => {
    watchTurnOutcome(turnId, USER, resolve)
  })
}

function sendB(): Promise<Response> {
  const answer = POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'respond-async' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: 'agent-1',
        agentType: 'api',
        content: 'SECOND',
        messageId: 'msg-b-reply',
        userMessageId: 'msg-b',
        messages: [
          { id: 'msg-a', role: 'user', content: 'FIRST' },
          { id: 'msg-b', role: 'user', content: 'SECOND' }
        ]
      })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
  requests.push(
    answer
      .then(async (response) => {
        if (response.status !== 202) return
        const { turnId } = (await response.clone().json()) as { turnId: string }
        await outcomeOf(turnId)
      })
      .catch(() => {})
  )
  return answer
}

/**
 * Let go of everything this test started and wait for its requests to finish, so none of them
 * runs on into the next test. A send still waiting in a line is told the chat went away (the
 * registry's reset settles it), and every forward answers.
 */
async function drainRequests() {
  mocks.holdForwards = false
  for (const forward of mocks.sseForwards) forward.release()
  __resetStreamAbortRegistryForTests()
  const started = requests
  requests = []
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(started),
    new Promise((resolve) => {
      timer = setTimeout(resolve, DRAIN_LIMIT_MS)
    })
  ])
  clearTimeout(timer)
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** The turn's final answer, and whether it has come yet. */
function watchOutcome(turnId: string) {
  const watched = { final: null as TurnOutcome | null, done: null as unknown as Promise<TurnOutcome> }
  watched.done = outcomeOf(turnId).then((final) => {
    watched.final = final
    return final
  })
  return watched
}

/** B joins the line behind a running reply; its "Queued" forward is held until the test lets it go. */
async function queueBBehindAReply() {
  const holder = registerSessionTurn(SESSION, 'single', 'msg-a-reply')
  if (!holder.ok) throw new Error('registration refused')
  const accepted = await sendB()
  expect(accepted.status).toBe(202)
  const { turnId } = (await accepted.json()) as { turnId: string }
  const outcome = watchOutcome(turnId)
  await tick()
  expect(isUserMessageQueued(SESSION, 'msg-b')).toBe(true)
  const queuedNotice = mocks.sseForwards.find(
    (forward) => forward.body.type === 'steer_queued' && forward.body.sessionId === SESSION
  )
  if (!queuedNotice) throw new Error('expected the Queued forward')
  return { holder: holder.entry, outcome, queuedNotice }
}

describe('send-routed: a send in the chat’s line, through the real handler (BL-4)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, HANDLER_IMPORT_LIMIT_MS)

  beforeEach(() => {
    chatCount += 1
    SESSION = `session-bl4-handler-${chatCount}`
    __resetStreamAbortRegistryForTests()
    __resetTurnOutcomesForTests()
    mocks.sessionReads.clear()
    mocks.chatsThatSurvive.clear()
    mocks.movedMessage = null
    mocks.forwardLimitMs = 5_000
    mocks.steps = []
    mocks.holdWorkThrows = false
    mocks.holdForwards = true
    mocks.sseForwards = []
    stubSseFetch()
  })

  afterEach(async () => {
    await drainRequests()
    vi.unstubAllGlobals()
    __resetStreamAbortRegistryForTests()
    __resetTurnOutcomesForTests()
  }, DRAIN_LIMIT_MS + 5_000)

  it('takes the chat handed over while its "Queued" forward is still in flight', async () => {
    const holder = registerSessionTurn(SESSION, 'single', 'msg-a-reply')
    if (!holder.ok) throw new Error('registration refused')

    const accepted = await sendB()
    expect(accepted.status).toBe(202)
    const { turnId } = (await accepted.json()) as { turnId: string }
    const outcome = outcomeOf(turnId)
    await tick()
    expect(isUserMessageQueued(SESSION, 'msg-b')).toBe(true)
    const queuedNotice = mocks.sseForwards.find(
      (forward) => forward.body.type === 'steer_queued' && forward.body.sessionId === SESSION
    )
    expect(queuedNotice).toBeDefined()

    // The reply ahead ends while B's "Queued" forward has not come back.
    releaseSessionTurn(SESSION, holder.entry.turnId)
    await tick()
    queuedNotice?.release()

    const final = await outcome
    // B took the chat: it got as far as the re-read under its lock ("deleted" here), never
    // refused `session_turn_in_progress` after it was already answered 202.
    expect(final.status).toBe(404)
    expect(JSON.parse(final.body)).toMatchObject({ code: 'session_deleted' })
    expect(mocks.sessionReads.get(SESSION)).toBe(2)
    expect(getActiveSessionTurn(SESSION)).toBeNull()
  })

  it('a throw between joining the line and the handover takes the send out of the line; the next send runs', async () => {
    const holder = registerSessionTurn(SESSION, 'single', 'msg-a-reply')
    if (!holder.ok) throw new Error('registration refused')
    mocks.holdWorkThrows = true

    const answer = await sendB()

    expect(answer.status).toBe(500)
    expect(isUserMessageQueued(SESSION, 'msg-b')).toBe(false)
    expect(isQueuedSendMessageHidden(SESSION, 'msg-b')).toBe(false)
    const next = queueSessionTurn(SESSION, { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })
    releaseSessionTurn(SESSION, holder.entry.turnId)
    expect((await next.outcome).kind).toBe('run')
  })

  describe('its final answer comes after its "Queued" bubble, on every way out (BL-202)', () => {
    // The sending tab's `turn_over` must not overtake the `steer_queued` it answers: arriving
    // first, it left a Queued bubble on screen for a send that was already over.
    it('the chat deleted while it waited (the re-read under the lock)', async () => {
      const { holder, outcome, queuedNotice } = await queueBBehindAReply()
      releaseSessionTurn(SESSION, holder.turnId)
      await tick(50)
      expect(mocks.sessionReads.get(SESSION)).toBe(2)
      expect(outcome.final).toBeNull()

      queuedNotice.release()
      const final = await outcome.done
      expect(final.status).toBe(404)
      expect(JSON.parse(final.body)).toMatchObject({ code: 'session_deleted' })
    })

    it('its message deleted while it waited (queued_send_missing)', async () => {
      mocks.chatsThatSurvive.add(SESSION)
      const { holder, outcome, queuedNotice } = await queueBBehindAReply()
      releaseSessionTurn(SESSION, holder.turnId)
      await tick(50)
      expect(outcome.final).toBeNull()

      queuedNotice.release()
      const final = await outcome.done
      expect(final.status).toBe(404)
      expect(JSON.parse(final.body)).toMatchObject({ code: 'queued_send_missing' })
    })

    it('a delete that swept the chat and cancelled the line', async () => {
      const { outcome, queuedNotice } = await queueBBehindAReply()
      beginSessionDelete(SESSION)
      cancelQueuedSessionTurnsOfDeletedChat(SESSION)
      await tick(50)
      expect(outcome.final).toBeNull()

      queuedNotice.release()
      const final = await outcome.done
      expect(final.status).toBe(404)
      expect(JSON.parse(final.body)).toMatchObject({ code: 'session_deleted' })
    })
  })

  it('a "Queued" forward that never answers is given up after its time limit, and the send ends (BL-204)', async () => {
    // Nothing bounded the forward, and every later event of the send (and, since BL-202, its
    // final answer) waits for it: a hung forward held the chat until a Stop or the two-minute
    // orphan rule.
    mocks.forwardLimitMs = 50
    const { holder, outcome, queuedNotice } = await queueBBehindAReply()
    releaseSessionTurn(SESSION, holder.turnId)

    const final = await Promise.race([outcome.done, tick(3_000).then(() => null)])
    expect(final?.status).toBe(404)
    expect((queuedNotice.abortedWith as { name?: string } | undefined)?.name).toBe('TimeoutError')
    expect(getActiveSessionTurn(SESSION)).toBeNull()
  })

  it('keeps its "Queued" forward on its place in the line, for a Stop’s "Not sent" to follow (BL-203)', async () => {
    const { queuedNotice } = await queueBBehindAReply()
    const notices = queuedSendNotices(SESSION, ['msg-b'])
    expect(notices).toHaveLength(1)
    let sent = false
    void notices[0].then(() => {
      sent = true
    })
    await tick()
    expect(sent).toBe(false)

    queuedNotice.release()
    await tick()
    expect(sent).toBe(true)
  })

  it('the turn it runs leaves alone the sandbox of a request that still runs after its lock went (BL-198)', async () => {
    // The line hands the chat on 30 s after a lock went even if that lock's request still runs
    // (stuck behind a command). The turn's pre-run sweep removes the chat's sandboxes even while
    // a command runs in one, so it must stand aside while that request still runs.
    mocks.chatsThatSurvive.add(SESSION)
    mocks.movedMessage = { id: 'msg-b', role: 'user', session_id: SESSION, user_id: USER, content: 'SECOND' }
    const { holder, outcome, queuedNotice } = await queueBBehindAReply()
    mocks.holdForwards = false
    queuedNotice.release()
    clearSessionTurn(SESSION, 'msg-a-reply')
    // The stuck request never lets go; the line goes on after its wait (the clock moved on).
    const realNow = Date.now.bind(Date)
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + QUEUED_HANDOVER_REQUEST_WAIT_MS + 1)
    const final = await outcome.done
    now.mockRestore()

    expect(final.status).toBe(500)
    expect(JSON.parse(final.body).details).toBe('stopped before the model run (test)')
    // Its setup ran without a sweep (its own run-end sweep comes after, by the lock's rule).
    expect(mocks.steps.slice(0, mocks.steps.indexOf('setup done') + 1)).toEqual(['setup done'])
    releaseSessionTurn(SESSION, holder.turnId)
  })
})

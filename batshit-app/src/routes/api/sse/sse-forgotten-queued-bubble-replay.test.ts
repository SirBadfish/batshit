import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-903 (e) — can the running reply's replay buffer bring back a bubble `forgetSteer` removed?
 *
 * The page forgets a bubble in two places (`routes/+page.svelte`): a steer the steer route refused
 * (it was never enqueued, so no event names it), and a queued send's bubble whose Send now the
 * server answered `409 queued_send_not_waiting` (it already went, it was kept, or Batshit
 * restarted and its line is gone). `forgetSteer` does not remember the id, so any later event that
 * BUILDS an entry would put the bubble back. Only two events build one in the store:
 * `steer_queued` and `steer_delivered` (`steerInbox.svelte.ts` `upsert`); every other event only
 * updates an entry that is already there.
 *
 * This drives the real `/api/sse` route and the real browser store: a reply runs, a send waits in
 * the chat's line beside an ordinary steer in that reply, the send leaves the line, the page forgets
 * its bubble, and the tab leaves the chat and comes back while the reply still runs (the replay a
 * resubscribe gets). Every replayed event goes through the store the way the page's handler takes
 * it. The answer: no. The buffer holds nothing about a queued send: its `steer_queued` is never
 * recorded (`/api/sse`, BL-4), its `steer_promoted` names no message and so is never recorded
 * either (`recordReplyEvent`), and a queued send never reaches a transport, so no `steer_delivered`
 * names it. A joining tab's queued bubbles come from the line itself (`replayQueuedSendsForListener`),
 * which lists only sends still waiting. The discriminator: the same replay
 * DOES rebuild an ordinary steer the page forgot, because that steer's `steer_queued` is buffered;
 * so the test would see a queued send's bubble come back if its event were buffered too.
 */

const mocks = vi.hoisted(() => ({
  requireOwnedSession: vi.fn(),
  isTrustedInternalRequest: vi.fn(),
  getUserSettings: vi.fn(),
  getSession: vi.fn(),
  redisExecute: vi.fn(),
  cleanupSessionTempStorage: vi.fn(),
  getActiveZipBlocks: vi.fn(),
  initializeKeyspaceNotifications: vi.fn(),
  setupSessionMonitoring: vi.fn(),
  processChunk: vi.fn(),
  clearMessageReferences: vi.fn(),
  getMessageReferences: vi.fn(),
  setContext: vi.fn(),
  deleteSessionBuffers: vi.fn(),
  finalizeOpenBlocks: vi.fn(),
  takeHeldText: vi.fn(),
  releaseEndedReply: vi.fn(),
  discardSegment: vi.fn(),
  externalDisconnect: vi.fn(async () => undefined),
  hasRunningRequest: vi.fn((_sessionId: string) => false)
}))

vi.mock('redis', () => ({
  createClient: vi.fn(() => ({
    isOpen: true,
    connect: vi.fn(async () => undefined),
    on: vi.fn(),
    subscribe: vi.fn(async () => undefined),
    pSubscribe: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    disconnect: mocks.externalDisconnect
  }))
}))

vi.mock('$lib/server/services/streamAbortRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/streamAbortRegistry')>()),
  hasRunningRequest: mocks.hasRunningRequest
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: mocks.getUserSettings,
    getSession: mocks.getSession,
    execute: mocks.redisExecute
  }
}))

vi.mock('$lib/server/redisStreamService', () => ({
  redisStreamService: {
    cleanupSessionTempStorage: mocks.cleanupSessionTempStorage,
    getActiveZipBlocks: mocks.getActiveZipBlocks
  }
}))

vi.mock('$lib/server/services/routeSecurity', () => ({
  requireOwnedSession: mocks.requireOwnedSession
}))

vi.mock('$lib/server/services/internalRequestAuth', () => ({
  isTrustedInternalRequest: mocks.isTrustedInternalRequest
}))

vi.mock('$lib/server/visualIndicatorService', () => ({
  initializeKeyspaceNotifications: mocks.initializeKeyspaceNotifications,
  setupSessionMonitoring: mocks.setupSessionMonitoring
}))

vi.mock('$lib/server/services/zipDetection', () => ({
  ZipDetectionService: vi.fn(function ZipDetectionService(this: any) {
    this.processChunk = mocks.processChunk
    this.clearMessageReferences = mocks.clearMessageReferences
    this.getMessageReferences = mocks.getMessageReferences
    this.setContext = mocks.setContext
    this.deleteSessionBuffers = mocks.deleteSessionBuffers
    this.finalizeOpenBlocks = mocks.finalizeOpenBlocks
    this.takeHeldText = mocks.takeHeldText
    this.releaseEndedReply = mocks.releaseEndedReply
    this.discardSegment = mocks.discardSegment
    this.clearSessionReferences = vi.fn()
  })
}))

const SESSION = 'session-1'
const REPLY = 'msg-a-reply'
const QUEUED = 'msg-b'
const STEER = 'steer_x'
const locals = { user: { id: 'user-1' } }

async function readSsePayload(reader: ReadableStreamDefaultReader<Uint8Array | string>) {
  const decoder = new TextDecoder()
  let buffer = ''
  while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) return null
    buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
  }
  const eventText = buffer.slice(0, buffer.indexOf('\n\n'))
  const dataLine = eventText.split('\n').find((line) => line.startsWith('data: '))
  return dataLine ? JSON.parse(dataLine.slice(6)) : null
}

async function patchHub(route: any, body: Record<string, unknown>) {
  const response = await route.PATCH({
    request: new Request('http://localhost/api/sse', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals
  } as any)
  return { status: response.status, body: await response.json() }
}

function post(route: any, event: Record<string, unknown>) {
  // These lifecycle notices are server-produced; the signed-in tab only receives them.
  return route.POST({
    request: new Request('http://localhost/api/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-batshit-service-token': 'test-service-token' },
      body: JSON.stringify({ sessionId: SESSION, ...event })
    }),
    locals
  } as any)
}

type Store = typeof import('$lib/stores/steerInbox.svelte')
type Readers = typeof import('$lib/utils/steerControl')

/** The steer events as the chat page's SSE handler hands them to the store (`routes/+page.svelte`). */
function takeAsThePage(store: Store, readers: Readers, data: any) {
  switch (data?.type) {
    case 'steer_queued':
      store.applySteerQueued({
        sessionId: SESSION,
        messageId: typeof data.messageId === 'string' ? data.messageId : '',
        steerId: typeof data.steerId === 'string' ? data.steerId : '',
        text: typeof data.text === 'string' ? data.text : '',
        deliver: data.deliver === 'now' || data.deliver === 'end' ? data.deliver : undefined,
        queuedSend: readers.readQueuedSendNotice(data) !== null,
        heldForApprovalCard: readers.readHeldForApprovalCard(data)
      })
      return
    case 'queued_send_hold':
      store.applyQueuedSendHold({ sessionId: SESSION, heldForApprovalCard: readers.readHeldForApprovalCard(data) })
      return
    case 'queued_send_dropped':
      store.applySteerDropped({ steerIds: data.userMessageIds, reason: data.reason })
      return
    case 'steer_delivered':
      store.applySteerDelivered({ sessionId: SESSION, messageId: data.messageId, steerId: data.steerId, lane: data.lane, source: data.source })
      return
    case 'steer_promoted':
      store.applySteerPromoted({ steerIds: Array.isArray(data.steerIds) ? data.steerIds : [] })
      return
  }
}

describe('a bubble the page forgot and the running reply’s replay (BL-903 e)', () => {
  let route: any
  let registry: typeof import('$lib/server/services/streamAbortRegistry')
  let store: Store
  let readers: Readers
  let hub: { reader: ReadableStreamDefaultReader<any>; hubId: string }

  /** Subscribe this tab to the chat; everything the subscription is sent up to `until`. */
  async function subscribeAndCollect(subId: string, untilChunk: string) {
    const answer = await patchHub(route, { hubId: hub.hubId, add: [{ id: subId, scope: 'session', sessionId: SESSION }] })
    expect(answer.status).toBe(200)
    await post(route, { type: 'chunk', messageId: REPLY, content: untilChunk })
    const frames: any[] = []
    for (let i = 0; i < 40; i += 1) {
      const frame = await readSsePayload(hub.reader)
      if (!frame) break
      frames.push(frame.event)
      if (frame.event?.type === 'chunk' && frame.event?.content === untilChunk) break
    }
    return frames
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireOwnedSession.mockResolvedValue({ ok: true })
    mocks.isTrustedInternalRequest.mockImplementation((request: Request) =>
      request.headers.get('x-batshit-service-token') === 'test-service-token')
    // The reply runs the whole time: the tab leaving does not end its record.
    mocks.hasRunningRequest.mockReturnValue(true)
    mocks.getUserSettings.mockResolvedValue({ global_zip_settings: {} })
    mocks.getSession.mockResolvedValue({ id: SESSION, user_id: 'user-1' })
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({
        json: {
          get: vi.fn(async (key: string) => {
            if (key === `session:${SESSION}`) return { id: SESSION, agent_id: 'agent-1' }
            if (key === 'agent:agent-1') return { id: 'agent-1', agentType: 'api' }
            if (key === `message:${SESSION}:${QUEUED}`) return { id: QUEUED, role: 'user', content: 'SECOND' }
            return null
          })
        },
        lRange: vi.fn(async () => [])
      })
    )
    mocks.cleanupSessionTempStorage.mockResolvedValue(undefined)
    mocks.getActiveZipBlocks.mockResolvedValue([])
    mocks.initializeKeyspaceNotifications.mockResolvedValue(undefined)
    mocks.setupSessionMonitoring.mockResolvedValue(vi.fn())
    mocks.processChunk.mockImplementation(async (_s: string, _m: string, content: string) => ({ shouldStream: true, content }))
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
    mocks.takeHeldText.mockResolvedValue('')
    mocks.releaseEndedReply.mockReturnValue('')
    mocks.discardSegment.mockReturnValue({ outcome: 'rewound', zipReferences: [] })

    route = await import('./+server')
    registry = await import('$lib/server/services/streamAbortRegistry')
    store = await import('$lib/stores/steerInbox.svelte')
    readers = await import('$lib/utils/steerControl')
    registry.__resetStreamAbortRegistryForTests()
    store.clearSteerInboxForTest()

    const response = await route.GET({ url: new URL('http://localhost/api/sse?scope=hub'), locals } as any)
    hub = { reader: response.body!.getReader(), hubId: '' }
    const greeting = await readSsePayload(hub.reader)
    expect(greeting).toMatchObject({ type: 'hub_connected' })
    hub.hubId = greeting.hubId

    // The tab is on the chat; a reply runs, with an ordinary steer in it and a send waiting in the
    // chat's line behind it (a Clip, so the steer route did not take it).
    for (const frame of await subscribeAndCollect('tab-chat', 'reply going')) takeAsThePage(store, readers, frame)
    registry.registerSessionTurn(SESSION, 'single', REPLY)
    await post(route, { type: 'start', messageId: REPLY, metadata: {} })
    const queued = registry.queueSessionTurn(SESSION, { kind: 'single', messageId: `${QUEUED}-reply`, userMessageId: QUEUED })
    const live = [
      { type: 'steer_queued', messageId: REPLY, steerId: STEER, text: 'and check the logs', deliver: 'now' },
      {
        type: 'steer_queued',
        messageId: REPLY,
        steerId: QUEUED,
        text: 'SECOND',
        deliver: 'end',
        queuedSend: { userMessageId: QUEUED, assistantMessageId: `${QUEUED}-reply` }
      },
      { type: 'steer_delivered', messageId: REPLY, steerId: STEER, step: 1, lane: 'api', source: 'user' }
    ]
    for (const event of live) await post(route, event)
    for (let i = 0; i < 1 + live.length; i += 1) takeAsThePage(store, readers, (await readSsePayload(hub.reader))?.event)
    expect(store.getSteer(QUEUED)).toMatchObject({ state: 'queued', queuedSend: true })
    expect(store.getSteer(STEER)).toMatchObject({ state: 'delivered' })

    // The send leaves the line before anyone in this tab knew (it went from another tab's Send now,
    // or its request left): this tab's Send now is answered `queued_send_not_waiting`, and the page
    // forgets the stale bubble. Its promotion (when it ran) reaches the tab live, never the buffer.
    registry.abandonQueuedSessionTurn(SESSION, queued)
    expect(registry.isUserMessageQueued(SESSION, QUEUED)).toBe(false)
    store.forgetSteer(QUEUED)
    await post(route, { type: 'steer_promoted', steerIds: [QUEUED] })
    takeAsThePage(store, readers, (await readSsePayload(hub.reader))?.event)
    expect(store.getSteer(QUEUED)).toBeNull()
  })

  it('cannot: a resubscribe replays the reply, and the forgotten queued send stays gone', async () => {
    await patchHub(route, { hubId: hub.hubId, remove: ['tab-chat'] })
    const replay = await subscribeAndCollect('tab-chat-again', 'after the return')
    for (const event of replay) takeAsThePage(store, readers, event)

    // The replay is the running reply's own record: its start and the ordinary steer in it.
    expect(replay.map((event) => event.type)).toContain('start')
    expect(replay.some((event) => event.type === 'steer_queued' && event.steerId === STEER)).toBe(true)
    expect(replay.some((event) => event.type === 'steer_delivered' && event.steerId === STEER)).toBe(true)
    // Nothing in it names the queued send at all, so nothing can build its bubble again.
    expect(
      replay.filter((event) => event.steerId === QUEUED || (Array.isArray(event.steerIds) && event.steerIds.includes(QUEUED)))
    ).toEqual([])
    expect(store.getSteer(QUEUED)).toBeNull()
    expect(store.getPendingSteersForSession(SESSION).map((entry) => entry.steerId)).toEqual([STEER])
    await hub.reader.cancel()
  })

  it('discriminator: the same replay does rebuild an ordinary steer the page forgot (its steer_queued is buffered)', async () => {
    store.forgetSteer(STEER)
    expect(store.getSteer(STEER)).toBeNull()

    await patchHub(route, { hubId: hub.hubId, remove: ['tab-chat'] })
    for (const event of await subscribeAndCollect('tab-chat-again', 'after the return')) takeAsThePage(store, readers, event)

    // A steer the route accepted is the server's: its bubble comes back with the truth (delivered).
    expect(store.getSteer(STEER)).toMatchObject({ state: 'delivered', text: 'and check the logs' })
    expect(store.getSteer(QUEUED)).toBeNull()
    await hub.reader.cancel()
  })
})

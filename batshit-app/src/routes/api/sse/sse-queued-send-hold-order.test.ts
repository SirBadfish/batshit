import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-903 (b) — the tabs get the line's approval-card hold as it is when the event goes out.
 *
 * The line's hold changes in one place (`streamAbortRegistry.ts`), but its notices to the tabs come
 * from different requests, each its own forward to `/api/sse`: the request whose reply stopped at
 * the card (hold on, from its `finally`), the click that answers the card (hold off, after its
 * re-read under the lock), a new message (hold off, after its Queued bubble), Send now (hold off).
 * Forwards can arrive in any order, and `/api/sse` used to hand each tab the notice's own claim, so
 * a late "hold on" undid a newer "hold off": every tab said the send waited for the card while the
 * line went on. And a send's own Queued bubble said nothing about a hold its line already had.
 *
 * Now both events carry the hold as the registry has it at broadcast time, read in the same
 * synchronous step as the enqueue, by the rule the joining tab's replay uses (no hold while a turn
 * holds the chat). Every hold change is followed by a notice, so the last one a tab gets is the
 * truth; a late notice only repeats it. Driven through the real route, registry, and browser store.
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
const CARD = 'msg-card'
const B = 'msg-b'
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

/** The Queued bubble's notice, as send-routed forwards it when the send joins the line. */
const queuedNotice = {
  type: 'steer_queued',
  messageId: CARD,
  steerId: B,
  text: 'And summarise the file I attached.',
  deliver: 'end',
  queuedSend: { userMessageId: B, assistantMessageId: `${B}-reply` }
}

describe('the line’s hold reaches every tab as the line has it (BL-903 b)', () => {
  let route: any
  let registry: typeof import('$lib/server/services/streamAbortRegistry')
  let store: typeof import('$lib/stores/steerInbox.svelte')
  let readers: typeof import('$lib/utils/steerControl')
  let reader: ReadableStreamDefaultReader<any>

  /** The tab hears one event; return it, and hand it to the store the way the chat page does. */
  async function nextEventAsThePage() {
    const frame = await readSsePayload(reader)
    const data = frame?.event
    if (data?.type === 'steer_queued') {
      store.applySteerQueued({
        sessionId: SESSION,
        messageId: typeof data.messageId === 'string' ? data.messageId : '',
        steerId: data.steerId,
        text: data.text,
        deliver: data.deliver,
        queuedSend: readers.readQueuedSendNotice(data) !== null,
        heldForApprovalCard: readers.readHeldForApprovalCard(data)
      })
    } else if (data?.type === 'queued_send_hold') {
      store.applyQueuedSendHold({ sessionId: SESSION, heldForApprovalCard: readers.readHeldForApprovalCard(data) })
    }
    return data
  }

  /** The reply on `CARD` stopped at its card while B waited in the line: the line holds for it. */
  function lineHoldsAtCard() {
    const reply = registry.registerSessionTurn(SESSION, 'single', CARD)
    if (!reply.ok) throw new Error('expected the reply to register')
    const b = registry.queueSessionTurn(SESSION, { kind: 'single', messageId: `${B}-reply`, userMessageId: B })
    registry.releaseSessionTurn(SESSION, reply.entry.turnId, { approvalCardMessageId: CARD })
    expect(registry.getQueueCardHold(SESSION)?.messageId).toBe(CARD)
    return b
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireOwnedSession.mockResolvedValue({ ok: true })
    mocks.isTrustedInternalRequest.mockImplementation((request: Request) =>
      request.headers.get('x-batshit-service-token') === 'test-service-token')
    mocks.hasRunningRequest.mockReturnValue(false)
    mocks.getUserSettings.mockResolvedValue({ global_zip_settings: {} })
    mocks.getSession.mockResolvedValue({ id: SESSION, user_id: 'user-1' })
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({
        json: {
          get: vi.fn(async (key: string) => {
            if (key === `session:${SESSION}`) return { id: SESSION, agent_id: 'agent-1' }
            if (key === 'agent:agent-1') return { id: 'agent-1', agentType: 'api' }
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
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
    mocks.takeHeldText.mockResolvedValue('')
    mocks.releaseEndedReply.mockReturnValue('')

    route = await import('./+server')
    registry = await import('$lib/server/services/streamAbortRegistry')
    store = await import('$lib/stores/steerInbox.svelte')
    readers = await import('$lib/utils/steerControl')
    registry.__resetStreamAbortRegistryForTests()
    store.clearSteerInboxForTest()

    // The tab is on the chat before the send joins the line (no Queued replay on the way in).
    const hub = await route.GET({ url: new URL('http://localhost/api/sse?scope=hub'), locals } as any)
    reader = hub.body!.getReader()
    const greeting = await readSsePayload(reader)
    expect(greeting).toMatchObject({ type: 'hub_connected' })
    const answer = await route.PATCH({
      request: new Request('http://localhost/api/sse', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hubId: greeting.hubId, add: [{ id: 'tab-chat', scope: 'session', sessionId: SESSION }] })
      }),
      locals
    } as any)
    expect(answer.status).toBe(200)
    expect(await readSsePayload(reader)).toEqual({ sub: 'tab-chat', event: { type: 'connected', sessionId: SESSION } })
  })

  it('a late "hold on" after the click ended the hold gives every tab no hold', async () => {
    lineHoldsAtCard()
    // The tab learned of B and of the hold before the click.
    await post(route, queuedNotice)
    await nextEventAsThePage()
    // The user's click on the card ends the hold with its registration; its own notice goes out.
    const click = registry.registerSessionTurn(SESSION, 'single', CARD, { answersApproval: true })
    expect(click.ok && click.endedCardHold).toBe(true)
    await post(route, { type: 'queued_send_hold', heldForApprovalCard: null })
    expect(await nextEventAsThePage()).toMatchObject({ type: 'queued_send_hold', heldForApprovalCard: null })

    // The reply's own "hold on", forwarded before the click but arriving after it.
    await post(route, { type: 'queued_send_hold', heldForApprovalCard: { messageId: CARD } })

    expect(await nextEventAsThePage()).toMatchObject({ type: 'queued_send_hold', heldForApprovalCard: null })
    expect(store.getSteer(B)).toMatchObject({ state: 'queued', heldForApprovalCard: null })
    expect(store.steerBubbleStatusLabel(store.getSteer(B)!)).not.toBe('Waits for your answer to the approval card.')
  })

  it('a "hold on" notice while the line holds nothing gives every tab no hold', async () => {
    await post(route, { type: 'queued_send_hold', heldForApprovalCard: { messageId: CARD } })
    expect(await nextEventAsThePage()).toMatchObject({ type: 'queued_send_hold', heldForApprovalCard: null })
  })

  it('a late "hold off" while the line holds again gives every tab the card', async () => {
    lineHoldsAtCard()
    await post(route, queuedNotice)
    await nextEventAsThePage()

    // A "hold off" whose change is no longer the line's state (a refused click put the hold back).
    await post(route, { type: 'queued_send_hold', heldForApprovalCard: null })

    expect(await nextEventAsThePage()).toMatchObject({ type: 'queued_send_hold', heldForApprovalCard: { messageId: CARD } })
    expect(store.steerBubbleStatusLabel(store.getSteer(B)!)).toBe('Waits for your answer to the approval card.')
  })

  it('a send’s own Queued bubble says it waits for the card when its line holds for one', async () => {
    lineHoldsAtCard()

    await post(route, queuedNotice)

    expect(await nextEventAsThePage()).toMatchObject({
      type: 'steer_queued',
      steerId: B,
      queuedSend: { userMessageId: B },
      heldForApprovalCard: { messageId: CARD }
    })
    expect(store.getSteer(B)).toMatchObject({ state: 'queued', queuedSend: true, heldForApprovalCard: CARD })
    expect(store.steerBubbleStatusLabel(store.getSteer(B)!)).toBe('Waits for your answer to the approval card.')
  })

  it('the same rule as a joining tab’s replay: no hold while a turn holds the chat', async () => {
    lineHoldsAtCard()
    // A click on ANOTHER card takes the chat; the line still holds for this one, behind it.
    const other = registry.registerSessionTurn(SESSION, 'single', 'msg-other-card', { answersApproval: true })
    expect(other.ok).toBe(true)
    expect(registry.getQueueCardHold(SESSION)?.messageId).toBe(CARD)

    await post(route, { type: 'queued_send_hold', heldForApprovalCard: { messageId: CARD } })
    expect(await nextEventAsThePage()).toMatchObject({ type: 'queued_send_hold', heldForApprovalCard: null })
    await post(route, queuedNotice)
    expect(await nextEventAsThePage()).toMatchObject({ type: 'steer_queued', steerId: B, heldForApprovalCard: null })
  })

  it('an ordinary steer’s notice is left as it is: no hold is stamped on it', async () => {
    lineHoldsAtCard()
    await post(route, { type: 'steer_queued', messageId: CARD, steerId: 'steer_x', text: 'and check the logs', deliver: 'now' })
    const event = await nextEventAsThePage()
    expect(event).toMatchObject({ type: 'steer_queued', steerId: 'steer_x' })
    expect(event).not.toHaveProperty('heldForApprovalCard')
  })
})

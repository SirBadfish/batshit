import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireOwnedSession: vi.fn(),
  isTrustedInternalRequest: vi.fn(),
  isTrustedN8nSseCallbackRequest: vi.fn(),
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
  takeUnclosedText: vi.fn(),
  discardSegment: vi.fn(),
  externalDisconnect: vi.fn(async () => undefined),
  hasRunningRequest: vi.fn((_sessionId: string) => false),
  externalMessageHandlers: [] as Array<(message: string, channel: string) => void>
}))

vi.mock('redis', () => ({
  createClient: vi.fn(() => ({
    isOpen: true,
    connect: vi.fn(async () => undefined),
    on: vi.fn(),
    subscribe: vi.fn(async () => undefined),
    pSubscribe: vi.fn(async (_pattern: string, handler: (message: string, channel: string) => void) => {
      mocks.externalMessageHandlers.push(handler)
    }),
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

vi.mock('$lib/server/services/n8nCallbackTokens', () => ({
  isTrustedN8nSseCallbackRequest: mocks.isTrustedN8nSseCallbackRequest
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
    this.takeUnclosedText = mocks.takeUnclosedText
    this.discardSegment = mocks.discardSegment
    this.clearSessionReferences = vi.fn()
  })
}))

function buildJsonRequest(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

async function readSsePayload(reader: ReadableStreamDefaultReader<Uint8Array | string>) {
  const decoder = new TextDecoder()
  let buffer = ''

  while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) return null
    buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
  }

  const eventText = buffer.slice(0, buffer.indexOf('\n\n'))
  const dataLine = eventText
    .split('\n')
    .find((line) => line.startsWith('data: '))
  return dataLine ? JSON.parse(dataLine.slice(6)) : null
}

const HUB_URL = new URL('http://localhost/api/sse?scope=hub')

/** Open the browser's one live stream, as the SharedWorker does, and read its hub id. */
async function openHub(route: any, locals: any) {
  const response = await route.GET({ url: HUB_URL, locals } as any)
  const reader = response.body!.getReader()
  const first = await readSsePayload(reader)
  expect(first).toMatchObject({ type: 'hub_connected' })
  return { reader, hubId: first.hubId as string }
}

async function patchHub(route: any, locals: any, body: Record<string, unknown>) {
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

/** Subscribe to a chat on the hub and read the `connected` greeting it gets. */
async function subscribeChat(
  route: any,
  locals: any,
  hub: { reader: ReadableStreamDefaultReader<any>; hubId: string },
  id: string,
  sessionId = 'session-1'
) {
  const answer = await patchHub(route, locals, { hubId: hub.hubId, add: [{ id, scope: 'session', sessionId }] })
  expect(answer).toEqual({ status: 200, body: { added: [id], removed: [], refused: [] } })
  expect(await readSsePayload(hub.reader)).toEqual({ sub: id, event: { type: 'connected', sessionId } })
}

describe('/api/sse route streaming contract', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.externalMessageHandlers.length = 0

    mocks.requireOwnedSession.mockResolvedValue({ ok: true })
    mocks.isTrustedInternalRequest.mockReturnValue(false)
    mocks.isTrustedN8nSseCallbackRequest.mockResolvedValue(false)
    mocks.hasRunningRequest.mockReturnValue(false)
    mocks.getUserSettings.mockResolvedValue({ global_zip_settings: {} })
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({
        json: {
          get: vi.fn(async (key: string) => {
            if (key === 'session:session-1') return { id: 'session-1', agent_id: 'agent-1' }
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
    mocks.processChunk.mockResolvedValue({ shouldStream: true, content: 'hello' })
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
    mocks.takeUnclosedText.mockReturnValue('')
    mocks.discardSegment.mockReturnValue({ outcome: 'rewound', zipReferences: [] })
  })

  it('processes posted stream events once and broadcasts the result to every listener', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    // Two tabs of one browser on the same chat: two subscriptions, one stream.
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    await subscribeChat(route, locals, hub, 'tab-2-chat')

    const postResponse = await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'chunk',
        messageId: 'message-1',
        content: 'hello'
      }),
      locals
    } as any)

    expect(postResponse.status).toBe(200)
    expect(mocks.processChunk).toHaveBeenCalledTimes(1)
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'tab-1-chat',
      event: { type: 'chunk', content: 'hello', messageId: 'message-1' }
    })
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'tab-2-chat',
      event: { type: 'chunk', content: 'hello', messageId: 'message-1' }
    })

    await hub.reader.cancel()
  })

  it('forwards a queued send that will not be sent to every tab on the chat (BL-4)', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    await subscribeChat(route, locals, hub, 'tab-2-chat')

    const postResponse = await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'queued_send_dropped',
        userMessageIds: ['msg-b', 'msg-c'],
        reason: 'stopped'
      }),
      locals
    } as any)

    expect(postResponse.status).toBe(200)
    for (const sub of ['tab-1-chat', 'tab-2-chat']) {
      expect(await readSsePayload(hub.reader)).toMatchObject({
        sub,
        event: { type: 'queued_send_dropped', userMessageIds: ['msg-b', 'msg-c'], reason: 'stopped' }
      })
    }
    await hub.reader.cancel()
  })

  it('a tab that joins while a send waits in the line gets its bubble once, from the line (BL-4)', async () => {
    // Measured live: a tab reloaded mid-wait showed the running reply and no "Queued" bubble.
    // The live bubble was filed under that reply before it began, and the reply's own `start`
    // clears what the replay buffer held for it; a buffered bubble could also outlive its send.
    const route = await import('./+server')
    const registry = await import('$lib/server/services/streamAbortRegistry')
    registry.__resetStreamAbortRegistryForTests()
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({
        json: {
          get: vi.fn(async (key: string) => {
            if (key === 'session:session-1') return { id: 'session-1', agent_id: 'agent-1' }
            if (key === 'agent:agent-1') return { id: 'agent-1', agentType: 'api' }
            if (key === 'message:session-1:msg-b') return { id: 'msg-b', role: 'user', content: 'SECOND' }
            return null
          })
        },
        lRange: vi.fn(async () => [])
      })
    )
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    registry.registerSessionTurn('session-1', 'single', 'msg-a-reply')
    registry.queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    // Over the cap: kept from the start, so it will never run and shows no bubble.
    registry.queueSessionTurn('session-1', {
      kind: 'single',
      messageId: 'msg-c-reply',
      userMessageId: 'msg-c',
      keep: 'overflow'
    })
    const liveBubble = {
      sessionId: 'session-1',
      type: 'steer_queued',
      messageId: 'msg-a-reply',
      steerId: 'msg-b',
      text: 'SECOND',
      deliver: 'end',
      queuedSend: { userMessageId: 'msg-b', assistantMessageId: 'msg-b-reply' }
    }
    await route.POST({ request: buildJsonRequest(liveBubble), locals } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { steerId: 'msg-b' } })
    // The reply it waits for begins only now: B was sent before that reply's first event.
    await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'start', messageId: 'msg-a-reply', metadata: {} }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { type: 'start' } })

    await subscribeChat(route, locals, hub, 'tab-2-chat')
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'tab-2-chat',
      event: { type: 'start', messageId: 'msg-a-reply' }
    })
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'tab-2-chat',
      event: {
        type: 'steer_queued',
        messageId: 'msg-a-reply',
        steerId: 'msg-b',
        text: 'SECOND',
        deliver: 'end',
        queuedSend: { userMessageId: 'msg-b', assistantMessageId: 'msg-b-reply' }
      }
    })
    // Exactly once: the next thing either tab hears is the reply going on.
    await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'msg-a-reply', content: 'hello' }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { type: 'chunk' } })
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-2-chat', event: { type: 'chunk' } })
    await hub.reader.cancel()
    registry.__resetStreamAbortRegistryForTests()
  })

  it('a send that queued after its reply began is not replayed twice to a joining tab (BL-4)', async () => {
    const route = await import('./+server')
    const registry = await import('$lib/server/services/streamAbortRegistry')
    registry.__resetStreamAbortRegistryForTests()
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'start', messageId: 'msg-a-reply', metadata: {} }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { type: 'start' } })
    registry.registerSessionTurn('session-1', 'single', 'msg-a-reply')
    registry.queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'steer_queued',
        messageId: 'msg-a-reply',
        steerId: 'msg-b',
        text: 'SECOND',
        deliver: 'end',
        queuedSend: { userMessageId: 'msg-b', assistantMessageId: 'msg-b-reply' }
      }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { steerId: 'msg-b' } })

    await subscribeChat(route, locals, hub, 'tab-2-chat')
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-2-chat', event: { type: 'start' } })
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-2-chat', event: { steerId: 'msg-b' } })
    await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'msg-a-reply', content: 'hello' }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { type: 'chunk' } })
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-2-chat', event: { type: 'chunk' } })
    await hub.reader.cancel()
    registry.__resetStreamAbortRegistryForTests()
  })

  it('forwards a chat’s user_message and queued_send_dropped to every tab and never replays them (BL-4)', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'start', messageId: 'msg-a-reply', metadata: {} }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'start' } })
    // Both even when they name the running reply: they are chat facts, not parts of a reply.
    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'user_message',
        messageId: 'msg-a-reply',
        message: { id: 'msg-b', role: 'user', content: 'SECOND' }
      }),
      locals
    } as any)
    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'queued_send_dropped',
        messageId: 'msg-a-reply',
        userMessageIds: ['msg-b'],
        reason: 'stopped'
      }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'user_message', message: { id: 'msg-b' } } })
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'queued_send_dropped', userMessageIds: ['msg-b'] } })

    await subscribeChat(route, locals, hub, 'tab-2-chat')
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-2-chat', event: { type: 'start' } })
    await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'msg-a-reply', content: 'hello' }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { type: 'chunk' } })
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-2-chat', event: { type: 'chunk' } })
    await hub.reader.cancel()
  })

  it('a tab that joins while the line holds for an approval card draws the bubble as waiting for the card (BL-713)', async () => {
    const route = await import('./+server')
    const registry = await import('$lib/server/services/streamAbortRegistry')
    registry.__resetStreamAbortRegistryForTests()
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({
        json: {
          get: vi.fn(async (key: string) => {
            if (key === 'session:session-1') return { id: 'session-1', agent_id: 'agent-1' }
            if (key === 'agent:agent-1') return { id: 'agent-1', agentType: 'api' }
            if (key === 'message:session-1:msg-b') return { id: 'msg-b', role: 'user', content: 'SECOND' }
            return null
          })
        },
        lRange: vi.fn(async () => [])
      })
    )
    const reply = registry.registerSessionTurn('session-1', 'single', 'msg-card')
    if (!reply.ok) throw new Error('expected the reply to register')
    registry.queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    registry.releaseSessionTurn('session-1', reply.entry.turnId, { approvalCardMessageId: 'msg-card' })

    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    try {
      await subscribeChat(route, locals, hub, 'tab-1-chat')
      expect(await readSsePayload(hub.reader)).toMatchObject({
        sub: 'tab-1-chat',
        event: {
          type: 'steer_queued',
          steerId: 'msg-b',
          text: 'SECOND',
          queuedSend: { userMessageId: 'msg-b', assistantMessageId: 'msg-b-reply' },
          heldForApprovalCard: { messageId: 'msg-card' }
        }
      })

      // The hold's start and end reach every tab as they happen, and are never replayed.
      await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', type: 'queued_send_hold', heldForApprovalCard: null }),
        locals
      } as any)
      expect(await readSsePayload(hub.reader)).toMatchObject({
        sub: 'tab-1-chat',
        event: { type: 'queued_send_hold', heldForApprovalCard: null }
      })
    } finally {
      await hub.reader.cancel()
      registry.__resetStreamAbortRegistryForTests()
    }
  })

  it('closes active streams and external Redis resources during runtime shutdown', async () => {
    const visualCleanup = vi.fn(async () => undefined)
    mocks.setupSessionMonitoring.mockResolvedValue(visualCleanup)
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1-chat')

    await route._closeSseRuntimeResources('test')

    expect(await hub.reader.read()).toMatchObject({ done: true })
    expect(visualCleanup).toHaveBeenCalledOnce()
    expect(mocks.externalDisconnect).toHaveBeenCalledOnce()
    expect(mocks.deleteSessionBuffers).toHaveBeenCalledWith('session-1')
  })

  it('cleans up monitoring that finishes connecting after shutdown starts', async () => {
    let finishSetup!: (cleanup: () => Promise<void>) => void
    const setupPending = new Promise<() => Promise<void>>((resolve) => {
      finishSetup = resolve
    })
    const lateVisualCleanup = vi.fn(async () => undefined)
    mocks.setupSessionMonitoring.mockReturnValue(setupPending)
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    const subscribing = patchHub(route, locals, {
      hubId: hub.hubId,
      add: [{ id: 'tab-1-chat', scope: 'session', sessionId: 'session-1' }]
    })
    expect(await readSsePayload(hub.reader)).toEqual({
      sub: 'tab-1-chat',
      event: { type: 'connected', sessionId: 'session-1' }
    })
    await vi.waitFor(() => expect(mocks.setupSessionMonitoring).toHaveBeenCalledOnce())

    const closing = route._closeSseRuntimeResources('test-deferred-setup')
    finishSetup(lateVisualCleanup)
    await closing
    await subscribing

    await vi.waitFor(() => expect(lateVisualCleanup).toHaveBeenCalledOnce())
    expect(await hub.reader.read()).toMatchObject({ done: true })
  })

  it('stamps stable stream event ids on original delivery and replay', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'first')

    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'start',
        messageId: 'message-1',
        metadata: { agentId: 'agent-1' }
      }),
      locals
    } as any)

    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'chunk',
        messageId: 'message-1',
        content: 'hello'
      }),
      locals
    } as any)

    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'first',
      event: { type: 'start', messageId: 'message-1', sseEventId: 'message-1:1' }
    })
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'first',
      event: { type: 'chunk', messageId: 'message-1', content: 'hello', sseEventId: 'message-1:2' }
    })

    // A tab that subscribes mid-turn gets the live turn replayed, with the same ids.
    await subscribeChat(route, locals, hub, 'joined-later')
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'joined-later',
      event: { type: 'start', messageId: 'message-1', sseEventId: 'message-1:1' }
    })
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'joined-later',
      event: { type: 'chunk', messageId: 'message-1', content: 'hello', sseEventId: 'message-1:2' }
    })

    await hub.reader.cancel()
  })

  it('preserves flat user_message payload fields when metadata exists', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')

    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'user_message',
        message: 'voice transcript',
        metadata: { source: 'livekit' }
      }),
      locals
    } as any)

    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'chat',
      event: { type: 'user_message', message: 'voice transcript', source: 'livekit' }
    })

    await hub.reader.cancel()
  })

  it('forwards reasoning-indicator stop events even when content is empty', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')

    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'thinking',
        messageId: 'message-1',
        content: '',
        metadata: { kind: 'reasoning_indicator', op: 'stop' }
      }),
      locals
    } as any)

    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'chat',
      event: {
        type: 'thinking',
        content: '',
        metadata: { kind: 'reasoning_indicator', op: 'stop' },
        messageId: 'message-1'
      }
    })

    await hub.reader.cancel()
  })

  it('lets the stream adapter own missing tool ids while preserving metadata', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')

    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'tool_start',
        messageId: 'message-1',
        toolName: 'example_tool',
        metadata: { agentId: 'agent-1' }
      }),
      locals
    } as any)

    const frame = await readSsePayload(hub.reader)
    expect(frame).toMatchObject({
      sub: 'chat',
      event: {
        type: 'tool_start',
        toolName: 'example_tool',
        metadata: { agentId: 'agent-1' },
        messageId: 'message-1'
      }
    })
    expect(frame.event.toolCallId).toMatch(/^tool_\d+_[a-z0-9]+$/)

    await hub.reader.cancel()
  })

  it('keeps flat error text authoritative over content and metadata remaps', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')

    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'error',
        messageId: 'message-1',
        error: 'Provider rejected the request',
        content: { message: 'should not win' },
        metadata: { provider: 'openai' }
      }),
      locals
    } as any)

    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'chat',
      event: { type: 'error', error: 'Provider rejected the request' }
    })

    await hub.reader.cancel()
  })

  // BL-775: the server owns a reply's saved record. send-routed's finalize rebuilt the reply from
  // the events recorded here (`replyStreamRecord.ts`, where the rebuild's rules are tested),
  // saved it, and forwards `end` with the saved bytes. This route hands it on as it is.
  it('hands `end` to every tab exactly as the finalize saved it, and rebuilds nothing', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-saved', ...payload }),
        locals
      } as any)
      expect(response.status).toBe(200)
      return readSsePayload(hub.reader)
    }
    await post({ type: 'start' })
    await post({ type: 'chunk', content: 'Streamed words with <batshit-tool-notes>{"notes":[]}</batshit-tool-notes>' })
    const zipReferences = [{ zipId: 'cool_tool_1790000000001_abcd12', reference: '{{batshit-zip:cool_tool_1790000000001_abcd12:::x}}' }]
    const end = await post({
      type: 'end',
      content: 'The saved words.',
      zipReferences,
      intermediateSteps: [{ toolName: 'bash' }],
      metadata: { zipIds: ['cool_tool_1790000000001_abcd12'], replyControlFinalized: true },
      savedRecord: true
    })
    expect(end.event).toMatchObject({
      type: 'end',
      content: 'The saved words.',
      zipReferences,
      intermediateSteps: [{ toolName: 'bash' }],
      metadata: { zipIds: ['cool_tool_1790000000001_abcd12'], replyControlFinalized: true },
      savedRecord: true
    })
    await hub.reader.cancel()
  })

  // BL-775: every event of a chat whose request is running is recorded, listener or not, and a
  // recorded forward answers `success`; send-routed counts any other answer as a gap.
  it('records every event of a running reply with no tab, and replays it to a tab that joins', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-unwatched', ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    expect(await post({ type: 'start' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'Nobody watches ' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'this reply.' })).toEqual({ success: true })
    expect(mocks.getUserSettings).toHaveBeenCalledWith('user-1')

    const rebuilt = await record.rebuildRecordedReply({
      sessionId: 'session-1',
      messageId: 'message-unwatched',
      inlineCapable: true,
      replyControlFinalized: true
    })
    expect(rebuilt?.content).toBe('Nobody watches this reply.')

    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'joined')
    const replay = []
    for (let i = 0; i < 3; i += 1) replay.push((await readSsePayload(hub.reader))?.event)
    expect(replay.map((event: any) => event.type)).toEqual(['start', 'chunk', 'chunk'])
    await hub.reader.cancel()
  })

  // BL-775: after the finalize rebuilt a reply, a slow forward that answers late is refused before
  // the zip detection, so it neither zips into nothing nor makes a record nobody cleans up. An
  // approval resume's `start` reopens the reply.
  it('refuses a late content event of a reply the finalize already rebuilt, until its next start', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-late', ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    expect(await post({ type: 'start' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'On time.' })).toEqual({ success: true })
    record.closeReplyRecord('session-1', 'message-late')
    mocks.processChunk.mockClear()

    expect(await post({ type: 'chunk', content: ' Late.' })).toMatchObject({ success: false })
    expect(await post({ type: 'tool-result', toolCallId: 'call-1', toolName: 'bash', result: 'ok' })).toMatchObject({ success: false })
    expect(mocks.processChunk).not.toHaveBeenCalled()
    const text = record
      .listReplayEvents('session-1')
      .filter((event) => event.messageId === 'message-late')
      .map((event) => event.content ?? '')
      .join('')
    expect(text).toBe('On time.')

    expect(await post({ type: 'start' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'Resumed.' })).toEqual({ success: true })
    record.forgetChatReplyRecords('session-1')
  })

  // BL-775: a chunk can pass the arrival check and reach the zip detection after the finalize
  // closed its reply (the route awaits between the two); the second check refuses it there.
  it('checks a chunk again right before its zip detection, and records nothing of a late one', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-race', ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    expect(await post({ type: 'start' })).toEqual({ success: true })
    // The finalize closes the reply while this chunk's route loads the agent's settings.
    const load = mocks.redisExecute.getMockImplementation()!
    mocks.redisExecute.mockImplementation(async (fn: any) => {
      record.closeReplyRecord('session-1', 'message-race')
      return load(fn)
    })
    mocks.processChunk.mockClear()
    await post({ type: 'chunk', content: 'Late words.' })
    expect(mocks.processChunk).not.toHaveBeenCalled()
    const text = record
      .listReplayEvents('session-1')
      .filter((event) => event.messageId === 'message-race' && event.type === 'chunk')
    expect(text).toEqual([])
    record.forgetChatReplyRecords('session-1')
  })

  // BL-759: a managed lane names each chunk's segment (the vendor message it belongs to), so a
  // later retract can take that segment back; the zip detector and the record both keep the name.
  it('hands each chunk’s segment to the zip detector and keeps it on the recorded chunk (BL-759)', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-seg', ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    expect(await post({ type: 'start' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'Named.', segmentId: 'msg_1' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: ' Unnamed.' })).toEqual({ success: true })
    expect(mocks.processChunk).toHaveBeenNthCalledWith(1, 'session-1', 'message-seg', 'Named.', 'msg_1')
    expect(mocks.processChunk).toHaveBeenNthCalledWith(2, 'session-1', 'message-seg', ' Unnamed.', null)
    const chunks = record
      .listReplayEvents('session-1')
      .filter((event) => event.messageId === 'message-seg' && event.type === 'chunk')
      .map((event) => [event.content, event.segmentId ?? null])
    expect(chunks).toEqual([['Named.', 'msg_1'], [' Unnamed.', null]])
    record.forgetChatReplyRecords('session-1')
  })

  // BL-759: a retract takes the segment out of the record, and every tab (and one that joins later)
  // gets the reply's text as it now reads. What cannot be taken back exactly is answered without
  // success, so send-routed saves its own copy (a gap); a retract with no record to act on too.
  it('a retract sends every tab content_reset with the reply’s text so far and records it for a tab that joins (BL-759)', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'watching')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-retry', ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    expect(await post({ type: 'start' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'Before. ', segmentId: 'msg_0' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'Half a sen', segmentId: 'msg_1' })).toEqual({ success: true })
    for (let i = 0; i < 3; i += 1) await readSsePayload(hub.reader)
    expect(
      await post({ type: 'text_retract', segmentId: 'msg_1', metadata: { reason: 'retry', message: 'Reconnecting... 1/5' } })
    ).toEqual({ success: true })
    expect(mocks.discardSegment).toHaveBeenCalledWith('session-1', 'message-retry', 'msg_1')
    const reset = (await readSsePayload(hub.reader))?.event
    expect(reset).toMatchObject({
      type: 'content_reset',
      messageId: 'message-retry',
      content: 'Before. ',
      metadata: { reason: 'retry', message: 'Reconnecting... 1/5', segmentId: 'msg_1', removedText: 'Half a sen' }
    })

    const replay = record.listReplayEvents('session-1').filter((event) => event.messageId === 'message-retry')
    expect(replay.map((event) => (event.type === 'chunk' ? event.content : event.type))).toEqual([
      'start',
      'Before. ',
      'content_reset'
    ])
    const rebuilt = await record.rebuildRecordedReply({
      sessionId: 'session-1',
      messageId: 'message-retry',
      inlineCapable: true,
      replyControlFinalized: true
    })
    // The saved text is trimmed at its end, as every rebuilt reply is.
    expect(rebuilt?.content).toBe('Before.')
    await hub.reader.cancel()
    record.forgetChatReplyRecords('session-1')
  })

  it('a retract the zip detector cannot rewind, or with no record, answers without success and resets nothing (BL-759)', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (messageId: string, payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId, ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    expect(await post('message-super', { type: 'start' })).toEqual({ success: true })
    expect(await post('message-super', { type: 'chunk', content: 'Half', segmentId: 'msg_1' })).toEqual({ success: true })
    mocks.discardSegment.mockReturnValue({ outcome: 'superseded', zipReferences: [] })
    expect(await post('message-super', { type: 'text_retract', segmentId: 'msg_1' })).toMatchObject({ success: false })
    // No record for this reply at all.
    expect(await post('message-none', { type: 'text_retract', segmentId: 'msg_1' })).toMatchObject({ success: false })
    const events = record.listReplayEvents('session-1')
    expect(events.some((event) => event.type === 'content_reset' || event.type === 'text_retract')).toBe(false)
    // The record was left untouched.
    expect(events.filter((event) => event.type === 'chunk').map((event) => event.content)).toEqual(['Half'])
    record.forgetChatReplyRecords('session-1')
  })

  // BL-775: an unwatched run fills the chat's adapter and caches; they must not outlive it.
  it('drops an unwatched chat’s adapter and caches when its record empties, and when it is deleted', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (messageId: string, payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId, ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    const held = { adapter: true, agentSettings: true, subagents: false, zipSettings: true }
    const none = { adapter: false, agentSettings: false, subagents: false, zipSettings: false }

    await post('message-a', { type: 'start' })
    await post('message-a', { type: 'chunk', content: 'Nobody watches.' })
    expect(route._chatStateForTests('session-1')).toEqual(held)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await post('message-a', { type: 'complete' })
      mocks.hasRunningRequest.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(record.FINISHED_REPLY_RECORD_TTL_MS + 100)
    } finally {
      vi.useRealTimers()
    }
    expect(route._chatStateForTests('session-1')).toEqual(none)

    mocks.hasRunningRequest.mockReturnValue(true)
    await post('message-b', { type: 'start' })
    await post('message-b', { type: 'chunk', content: 'Deleted mid-reply.' })
    expect(route._chatStateForTests('session-1')).toEqual(held)
    // The delete sweep's call (`sessionDeleteTurnStop.ts`).
    record.forgetChatReplyRecords('session-1')
    expect(route._chatStateForTests('session-1')).toEqual(none)
  })

  it('an approval resume’s second start replaces the first run’s replay for a tab that joins', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'first')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-1', ...payload }),
        locals
      } as any)
      expect(response.status).toBe(200)
      return readSsePayload(hub.reader)
    }
    const resume = (version: number, content: string) => ({ version, prior: { content, metadata: {}, intermediateSteps: [] } })
    await post({ type: 'start', metadata: { approvalResume: resume(1, 'Before approval.') } })
    await post({ type: 'chunk', content: 'First continuation.' })
    await post({ type: 'start', metadata: { approvalResume: resume(2, 'Before approval.\n\nFirst continuation.') } })
    await post({ type: 'chunk', content: 'Second continuation.' })

    await subscribeChat(route, locals, hub, 'joined')
    const replay = []
    for (let i = 0; i < 2; i += 1) replay.push((await readSsePayload(hub.reader))?.event)
    expect(replay.map((event: any) => [event.type, event.content ?? event.metadata?.approvalResume?.version])).toEqual([
      ['start', 2],
      ['chunk', 'Second continuation.']
    ])
    await hub.reader.cancel()
  })

  // BL-489: the detector holds the words after an `<error>` that has not closed (the pair may
  // still close). The route sends them as an ordinary chunk before a tool card, so the reply keeps
  // every word, in order. At the reply's end the finalize's rebuild takes them (BL-775).
  it('sends the words of an unclosed error block before a tool card', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-1', ...payload }),
        locals
      } as any)
      expect(response.status).toBe(200)
    }
    await post({ type: 'start', metadata: {} })
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'start' } })
    await post({ type: 'chunk', content: 'Intro. ' })
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'chunk', content: 'Intro. ' } })
    mocks.takeUnclosedText.mockReturnValueOnce('<error> before the tool. ')
    await post({ type: 'tool_start', toolCallId: 'call-1', toolName: 'bash' })
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'chunk', content: '<error> before the tool. ' } })
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'tool_start' } })
    await hub.reader.cancel()
  })

  // BL-775 (B2): a tab that leaves while its chat's reply runs does not take the reply's stream
  // state with it; the end-to-end claim is in `send-routed-woken-turn-zips-handler.test.ts`.
  it('keeps the zip detector state when the last tab leaves while a reply runs, and only then', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')
    mocks.hasRunningRequest.mockReturnValue(true)
    await patchHub(route, locals, { hubId: hub.hubId, remove: ['chat'] })
    expect(mocks.deleteSessionBuffers).not.toHaveBeenCalled()
    expect(mocks.cleanupSessionTempStorage).not.toHaveBeenCalled()

    mocks.hasRunningRequest.mockReturnValue(false)
    await subscribeChat(route, locals, hub, 'chat-again')
    await patchHub(route, locals, { hubId: hub.hubId, remove: ['chat-again'] })
    expect(mocks.deleteSessionBuffers).toHaveBeenCalledWith('session-1')
    expect(mocks.cleanupSessionTempStorage).toHaveBeenCalledWith('session-1')
    await hub.reader.cancel()
  })
})

describe('/api/sse live hub (one stream per browser, 2026-09-18)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.externalMessageHandlers.length = 0
    mocks.requireOwnedSession.mockResolvedValue({ ok: true })
    mocks.isTrustedInternalRequest.mockReturnValue(false)
    mocks.isTrustedN8nSseCallbackRequest.mockResolvedValue(false)
    mocks.getUserSettings.mockResolvedValue({ global_zip_settings: {} })
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({ json: { get: vi.fn(async () => null) }, lRange: vi.fn(async () => []) })
    )
    mocks.cleanupSessionTempStorage.mockResolvedValue(undefined)
    mocks.getActiveZipBlocks.mockResolvedValue([])
    mocks.initializeKeyspaceNotifications.mockResolvedValue(undefined)
    mocks.setupSessionMonitoring.mockResolvedValue(vi.fn())
    mocks.processChunk.mockResolvedValue({ shouldStream: true, content: 'hello' })
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
  })

  async function postChunk(route: any, locals: any) {
    const response = await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'm1', content: 'hello' }),
      locals
    } as any)
    return response.json()
  }

  it('no longer opens a stream per tab: the old chat and user-channel URLs answer 410', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    for (const query of ['sessionId=session-1', 'scope=user']) {
      await expect(
        route.GET({ url: new URL(`http://localhost/api/sse?${query}`), locals } as any)
      ).rejects.toMatchObject({ status: 410 })
    }
  })

  it('carries the user channel on the same stream as the chats', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    const answer = await patchHub(route, locals, { hubId: hub.hubId, add: [{ id: 'tab-1-user', scope: 'user' }] })
    expect(answer.body).toEqual({ added: ['tab-1-user'], removed: [], refused: [] })
    expect(await readSsePayload(hub.reader)).toEqual({
      sub: 'tab-1-user',
      event: { type: 'connected', scope: 'user' }
    })
    await subscribeChat(route, locals, hub, 'tab-1-chat')

    const event = { type: 'session_messages_changed', sessionId: 'session-1', reason: 'message_deleted' }
    for (const handler of mocks.externalMessageHandlers) {
      handler(JSON.stringify({ userId: 'user-1', ...event }), 'batshit:sse:user:user-1')
    }
    expect(await readSsePayload(hub.reader)).toEqual({
      sub: 'tab-1-user',
      event: { userId: 'user-1', ...event }
    })

    await hub.reader.cancel()
  })

  it('refuses a chat this user does not own and never listens to it', async () => {
    // Only the subscription is refused; the event below is posted by the chat's owner.
    mocks.requireOwnedSession.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) })
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    const answer = await patchHub(route, locals, {
      hubId: hub.hubId,
      add: [{ id: 'theirs', scope: 'session', sessionId: 'session-1' }]
    })
    expect(answer).toEqual({
      status: 200,
      body: { added: [], removed: [], refused: [{ id: 'theirs', status: 403, code: 'forbidden' }] }
    })
    expect(await postChunk(route, locals)).toMatchObject({ success: false, message: 'No active SSE connection' })
    await hub.reader.cancel()
  })

  it("answers 404 for another user's hub, and 401 without a sign-in", async () => {
    const route = await import('./+server')
    const hub = await openHub(route, { user: { id: 'user-1' } })
    const theirs = await patchHub(route, { user: { id: 'user-2' } }, {
      hubId: hub.hubId,
      add: [{ id: 'u', scope: 'user' }]
    })
    expect(theirs).toEqual({ status: 404, body: { error: 'Live connection not found', code: 'hub_not_found' } })
    await expect(
      route.PATCH({
        request: new Request('http://localhost/api/sse', { method: 'PATCH', body: '{}' }),
        locals: { user: null }
      } as any)
    ).rejects.toMatchObject({ status: 401 })
    await hub.reader.cancel()
  })

  it('removing one subscription leaves the other tab listening', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    await subscribeChat(route, locals, hub, 'tab-2-chat')

    const answer = await patchHub(route, locals, { hubId: hub.hubId, remove: ['tab-1-chat'] })
    expect(answer.body).toEqual({ added: [], removed: ['tab-1-chat'], refused: [] })
    expect(mocks.cleanupSessionTempStorage).not.toHaveBeenCalled()

    expect(await postChunk(route, locals)).toEqual({ success: true })
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-2-chat', event: { type: 'chunk' } })
    await hub.reader.cancel()
  })

  it('closing the stream detaches every subscription and tears the chat down with its last listener', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    await subscribeChat(route, locals, hub, 'tab-2-chat')

    await hub.reader.cancel()

    await vi.waitFor(() => expect(mocks.cleanupSessionTempStorage).toHaveBeenCalledWith('session-1'))
    expect(mocks.deleteSessionBuffers).toHaveBeenCalledWith('session-1')
    // The chat has no listener now, so an event for it is dropped, as with no tab open.
    expect(await postChunk(route, locals)).toMatchObject({ success: false, message: 'No active SSE connection' })
    const gone = await patchHub(route, locals, { hubId: hub.hubId, add: [{ id: 'u', scope: 'user' }] })
    expect(gone.status).toBe(404)
  })
})

/**
 * A send's turn on the live hub (2026-09-18). The page's send is answered once the server owns
 * the turn (`Prefer: respond-async`), so the tab reads the turn's FINAL answer here instead of
 * holding one of the browser's six connections for the whole reply. A subscription added after
 * the turn ended gets the answer at once: that is what keeps a hub that reconnected mid-reply,
 * or a tab slow to subscribe, from waiting forever.
 */
describe('/api/sse live hub: a send’s turn (2026-09-18)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.externalMessageHandlers.length = 0
    mocks.requireOwnedSession.mockResolvedValue({ ok: true })
    mocks.isTrustedInternalRequest.mockReturnValue(false)
    mocks.isTrustedN8nSseCallbackRequest.mockResolvedValue(false)
    mocks.getUserSettings.mockResolvedValue({ global_zip_settings: {} })
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({ json: { get: vi.fn(async () => null) }, lRange: vi.fn(async () => []) })
    )
    mocks.cleanupSessionTempStorage.mockResolvedValue(undefined)
    mocks.getActiveZipBlocks.mockResolvedValue([])
    mocks.initializeKeyspaceNotifications.mockResolvedValue(undefined)
    mocks.setupSessionMonitoring.mockResolvedValue(vi.fn())
    mocks.processChunk.mockResolvedValue({ shouldStream: true, content: 'hello' })
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
  })

  const FINAL = { status: 200, contentType: 'application/json', body: '{"success":true,"messageId":"m-1"}' }

  it('hands a running turn’s final answer to the tab that subscribed, when the turn ends', async () => {
    const route = await import('./+server')
    const outcomes = await import('$lib/server/services/turnOutcomeRegistry')
    const locals = { user: { id: 'user-1' } }
    const turnId = outcomes.openTurnOutcome({ userId: 'user-1' })
    const hub = await openHub(route, locals)

    const answer = await patchHub(route, locals, { hubId: hub.hubId, add: [{ id: 'send-1', scope: 'turn', turnId }] })
    expect(answer.body).toEqual({ added: ['send-1'], removed: [], refused: [] })

    outcomes.settleTurnOutcome(turnId, FINAL)
    expect(await readSsePayload(hub.reader)).toEqual({ sub: 'send-1', event: { type: 'turn_over', turnId, ...FINAL } })
    await hub.reader.cancel()
  })

  it('hands an ended turn’s answer at once to a subscription added late', async () => {
    const route = await import('./+server')
    const outcomes = await import('$lib/server/services/turnOutcomeRegistry')
    const locals = { user: { id: 'user-1' } }
    const turnId = outcomes.openTurnOutcome({ userId: 'user-1' })
    outcomes.settleTurnOutcome(turnId, FINAL)
    const hub = await openHub(route, locals)

    const answer = await patchHub(route, locals, { hubId: hub.hubId, add: [{ id: 'send-1', scope: 'turn', turnId }] })
    expect(answer.body).toEqual({ added: ['send-1'], removed: [], refused: [] })
    expect(await readSsePayload(hub.reader)).toEqual({ sub: 'send-1', event: { type: 'turn_over', turnId, ...FINAL } })
    await hub.reader.cancel()
  })

  it('refuses another user’s turn, and one it never knew, without saying which', async () => {
    const route = await import('./+server')
    const outcomes = await import('$lib/server/services/turnOutcomeRegistry')
    const turnId = outcomes.openTurnOutcome({ userId: 'user-2' })
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)

    const answer = await patchHub(route, locals, {
      hubId: hub.hubId,
      add: [
        { id: 'theirs', scope: 'turn', turnId },
        { id: 'unknown', scope: 'turn', turnId: 'turn_0000' }
      ]
    })
    expect(answer.body).toEqual({
      added: [],
      removed: [],
      refused: [
        { id: 'theirs', status: 404, code: 'turn_not_found' },
        { id: 'unknown', status: 404, code: 'turn_not_found' }
      ]
    })
    await hub.reader.cancel()
  })

  it('a removed turn subscription hears nothing more', async () => {
    const route = await import('./+server')
    const outcomes = await import('$lib/server/services/turnOutcomeRegistry')
    const locals = { user: { id: 'user-1' } }
    const turnId = outcomes.openTurnOutcome({ userId: 'user-1' })
    const hub = await openHub(route, locals)
    await patchHub(route, locals, { hubId: hub.hubId, add: [{ id: 'send-1', scope: 'turn', turnId }] })
    await subscribeChat(route, locals, hub, 'tab-chat')

    expect(outcomes.inspectTurnOutcomes().watchers).toBe(1)
    await patchHub(route, locals, { hubId: hub.hubId, remove: ['send-1'] })
    // Let go at once, not when the turn ends: a hub that reconnects during a long reply re-adds
    // the turn as a NEW listener each time, and the old ones must not pile up behind it.
    expect(outcomes.inspectTurnOutcomes().watchers).toBe(0)
    outcomes.settleTurnOutcome(turnId, FINAL)
    await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'm1', content: 'hello' }),
      locals
    } as any)
    // The next frame on the stream is the chat's, not the removed turn's answer.
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-chat', event: { type: 'chunk' } })
    await hub.reader.cancel()
  })

  it('shutdown keeps the live stream open until a running turn ends, so its tab still hears the end', async () => {
    // A running reply's request used to be drained by adapter-node before it closed; a turn
    // answered early is no request, so the route waits for it before it closes the hubs.
    const route = await import('./+server')
    const outcomes = await import('$lib/server/services/turnOutcomeRegistry')
    const locals = { user: { id: 'user-1' } }
    const turnId = outcomes.openTurnOutcome({ userId: 'user-1' })
    const hub = await openHub(route, locals)
    await patchHub(route, locals, { hubId: hub.hubId, add: [{ id: 'send-1', scope: 'turn', turnId }] })

    let closed = false
    const closing = route._closeSseRuntimeResources('test-running-turn').then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(false)

    outcomes.settleTurnOutcome(turnId, FINAL)
    expect(await readSsePayload(hub.reader)).toEqual({ sub: 'send-1', event: { type: 'turn_over', turnId, ...FINAL } })
    await closing
    expect(await hub.reader.read()).toMatchObject({ done: true })
  })

  it('shutdown keeps every send waiting in a chat’s line, and tells its tabs before it waits (BL-4)', async () => {
    // A send waiting behind another turn will not run now. It is kept: when the turn it waits
    // for ends, its words move to the end of the chat, unanswered (`queuedSendKeeper.ts`).
    const route = await import('./+server')
    const registry = await import('$lib/server/services/streamAbortRegistry')
    registry.__resetStreamAbortRegistryForTests()
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-chat')
    registry.registerSessionTurn('session-1', 'single', 'msg-a-reply')
    registry.queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })

    const closing = route._closeSseRuntimeResources('test-queued-sends')
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'tab-chat',
      event: { type: 'queued_send_dropped', userMessageIds: ['msg-b'], reason: 'shutdown' }
    })
    expect(registry.countRunnableQueuedSessionTurns('session-1')).toBe(0)
    await closing
    registry.__resetStreamAbortRegistryForTests()
  })
})

/**
 * BL-496 — a Claude approval card is part of its reply's replay, watched or not.
 *
 * The permission helper publishes the card on the chat's Redis channel (the shapes below are
 * the ones `scripts/claude-permission-mcp.cjs` publishes), and only the server's subscriber hears
 * it. Before BL-496 the route forwarded it to the tabs listening at that moment and kept nothing:
 * a reload lost the card, and with no tab it reached nobody.
 */
describe('/api/sse and a Claude approval card (BL-496)', () => {
  const HELPER = 'mcp__batshit_gateway_claude-approvals__batshit_permission_prompt'
  const cardBase = { sessionId: 'session-1', messageId: 'reply-1', toolCallId: 'ap-1', toolName: HELPER }
  const requestedAt = new Date().toISOString()
  const toolStart = { type: 'tool_start', ...cardBase }
  const toolCall = {
    type: 'tool-call',
    ...cardBase,
    args: { approvalId: 'ap-1', toolName: 'Bash', toolInput: { command: 'touch /tmp/x' }, toolUseId: 'toolu_1' },
    requestedAt,
    expiresAt: new Date(Date.parse(requestedAt) + 600_000).toISOString()
  }
  const approved = { type: 'tool-result', ...cardBase, result: { behavior: 'allow' }, approvalStatus: 'approved' }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.externalMessageHandlers.length = 0
    mocks.requireOwnedSession.mockResolvedValue({ ok: true })
    mocks.isTrustedInternalRequest.mockReturnValue(false)
    mocks.isTrustedN8nSseCallbackRequest.mockResolvedValue(false)
    mocks.hasRunningRequest.mockReturnValue(false)
    mocks.getUserSettings.mockResolvedValue({ global_zip_settings: {} })
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    mocks.redisExecute.mockImplementation(async (fn: any) =>
      fn({
        json: {
          get: vi.fn(async (key: string) => {
            if (key === 'session:session-1') return { id: 'session-1', agent_id: 'agent-1' }
            if (key === 'agent:agent-1') return { id: 'agent-1', agentType: 'cli' }
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
    mocks.processChunk.mockImplementation(async (_s: string, _m: string, content: string) => ({
      shouldStream: true,
      content
    }))
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
    mocks.takeUnclosedText.mockReturnValue('')
    const registry = await import('$lib/server/services/claudeApprovalRegistry')
    registry.__resetClaudeApprovalRegistryForTests()
  })

  /** The helper publishing on the chat's channel, as Redis delivers it to the subscriber. */
  function publish(event: Record<string, unknown>) {
    expect(mocks.externalMessageHandlers.length).toBeGreaterThan(0)
    for (const handler of mocks.externalMessageHandlers) {
      handler(JSON.stringify(event), 'batshit:sse:session-1')
    }
  }

  async function post(route: any, locals: any, event: Record<string, unknown>) {
    const response = await route.POST({
      request: buildJsonRequest({ sessionId: 'session-1', ...event }),
      locals
    } as any)
    return response.json()
  }

  it('a tab that reloads during the wait gets the card again, in its place in the reply', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab-1')

    await post(route, locals, { type: 'start', messageId: 'reply-1' })
    await post(route, locals, { type: 'chunk', messageId: 'reply-1', content: 'Let me check.' })
    publish(toolStart)
    publish(toolCall)
    const live = []
    for (let i = 0; i < 4; i += 1) live.push((await readSsePayload(hub.reader))?.event)
    expect(live.map((event: any) => event.type)).toEqual(['start', 'chunk', 'tool_start', 'tool-call'])

    // The reload: a new subscription on the same chat.
    await subscribeChat(route, locals, hub, 'tab-1-reloaded')
    const replay = []
    for (let i = 0; i < 4; i += 1) replay.push(await readSsePayload(hub.reader))
    expect(replay.map((frame: any) => [frame.sub, frame.event.type])).toEqual([
      ['tab-1-reloaded', 'start'],
      ['tab-1-reloaded', 'chunk'],
      ['tab-1-reloaded', 'tool_start'],
      ['tab-1-reloaded', 'tool-call']
    ])
    expect(replay[3].event).toMatchObject({ args: { toolName: 'Bash' }, expiresAt: toolCall.expiresAt })
    // The same ids as the live delivery, so the page's dedupe holds.
    expect(replay[3].event.sseEventId).toBe((live[3] as any).sseEventId)

    await hub.reader.cancel()
  })

  it('with no tab open, a running reply keeps its start and its card for a tab that opens during the wait', async () => {
    const route = await import('./+server')
    const { ensureSseExternalSubscriber } = await import('$lib/server/sseExternalSubscriber')
    expect(await ensureSseExternalSubscriber()).toBe(true)
    const internal = { user: undefined }
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)

    // BL-775: every event of a running reply is recorded, the text too.
    expect(await post(route, internal, { type: 'start', messageId: 'reply-1' })).toMatchObject({ success: true })
    expect(await post(route, internal, { type: 'chunk', messageId: 'reply-1', content: 'x' })).toMatchObject({
      success: true
    })
    publish(toolStart)
    publish(toolCall)

    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'opened-later')
    const replay = []
    for (let i = 0; i < 4; i += 1) replay.push((await readSsePayload(hub.reader))?.event)
    expect(replay.map((event: any) => event.type)).toEqual(['start', 'chunk', 'tool_start', 'tool-call'])
    expect(replay[3]).toMatchObject({ messageId: 'reply-1', args: { approvalId: 'ap-1', toolName: 'Bash' } })

    await hub.reader.cancel()
  })

  it('records nothing for a chat with no running request (an n8n callback still drops)', async () => {
    const route = await import('./+server')
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(false)
    await post(route, { user: undefined }, { type: 'start', messageId: 'reply-1' })

    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab')
    await post(route, locals, { type: 'chunk', messageId: 'reply-2', content: 'first live event' })
    expect((await readSsePayload(hub.reader))?.event).toMatchObject({ type: 'chunk', messageId: 'reply-2' })

    await hub.reader.cancel()
  })

  it('a card that came before its reply’s start is still given to a joining tab, from the server’s record', async () => {
    const route = await import('./+server')
    const { ensureSseExternalSubscriber } = await import('$lib/server/sseExternalSubscriber')
    await ensureSseExternalSubscriber()
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    publish(toolStart)
    publish(toolCall)
    // The start clears the buffer's earlier events of its reply (an approval resume reuses ids).
    await post(route, { user: undefined }, { type: 'start', messageId: 'reply-1' })

    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'joined')
    const replay = []
    for (let i = 0; i < 2; i += 1) replay.push((await readSsePayload(hub.reader))?.event)
    expect(replay.map((event: any) => event.type)).toEqual(['start', 'tool-call'])
    expect(replay[1]).toMatchObject({ toolCallId: 'ap-1', args: { toolName: 'Bash' }, expiresAt: toolCall.expiresAt })

    await hub.reader.cancel()
  })

  it('the card never enters the reply’s rebuilt text; its answered card rides the saved record', async () => {
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab')

    await post(route, locals, { type: 'start', messageId: 'reply-1' })
    await post(route, locals, { type: 'chunk', messageId: 'reply-1', content: 'Done checking.' })
    publish(toolStart)
    publish(toolCall)
    publish(approved)

    // BL-775: the finalize's rebuild reads the record, which never holds the card's events; the
    // finalize writes the card into the saved record (send-routed-reply-record-handler.test.ts).
    const rebuilt = await record.rebuildRecordedReply({
      sessionId: 'session-1',
      messageId: 'reply-1',
      inlineCapable: true,
      replyControlFinalized: true
    })
    expect(rebuilt?.content).toBe('Done checking.')
    const { buildClaudeApprovalSummary } = await import('$lib/server/services/claudeApprovalEvents')
    expect(buildClaudeApprovalSummary('session-1', 'reply-1')).toMatchObject({
      source: 'claude',
      approvals: [{ approvalId: 'ap-1', status: 'approved', toolName: 'Bash', source: 'claude' }]
    })

    await hub.reader.cancel()
  })

  /** Review finding 6: a card event for a reply nobody recorded and no running request makes no state. */
  it('a late card event after its reply ended is not buffered for later tabs', async () => {
    const route = await import('./+server')
    const { ensureSseExternalSubscriber } = await import('$lib/server/sseExternalSubscriber')
    await ensureSseExternalSubscriber()
    mocks.hasRunningRequest.mockReturnValue(false)
    publish(approved)

    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'late')
    await post(route, locals, { type: 'chunk', messageId: 'reply-9', content: 'first live event' })
    expect((await readSsePayload(hub.reader))?.event).toMatchObject({ type: 'chunk', messageId: 'reply-9' })

    await hub.reader.cancel()
  })

  /** Review finding 7: the subscriber closes at shutdown even when `/api/sse` never loaded. */
  it('the subscriber registers its own shutdown close', async () => {
    const { ensureSseExternalSubscriber } = await import('$lib/server/sseExternalSubscriber')
    const { closeRegisteredRuntimeResources } = await import('$lib/server/services/runtimeShutdown')
    expect(await ensureSseExternalSubscriber()).toBe(true)
    await closeRegisteredRuntimeResources('test')
    expect(mocks.externalDisconnect).toHaveBeenCalledOnce()
  })
})

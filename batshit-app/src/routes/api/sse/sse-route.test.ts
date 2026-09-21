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
  externalDisconnect: vi.fn(async () => undefined),
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

  it('starts a same-message approval continuation from only its newest run', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({
      shouldStream: true,
      content
    }))
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
      return readSsePayload(hub.reader)
    }
    const resume = (version: number, content: string) => ({
      version,
      prior: { content, metadata: {}, intermediateSteps: [] }
    })

    await post({ type: 'start', metadata: { approvalResume: resume(1, 'Before approval.') } })
    await post({ type: 'chunk', content: 'First continuation.' })
    const firstEnd = await post({ type: 'end', content: '', metadata: { approvalResumeVersion: 1 } })
    expect(firstEnd).toMatchObject({
      sub: 'chat',
      event: { type: 'end', content: 'Before approval.\n\nFirst continuation.' }
    })

    // The terminal cleanup waits five seconds. A second approval clicked now reuses the same
    // assistant id while the first run's start/chunks are still in the replay buffer.
    await post({
      type: 'start',
      metadata: {
        approvalResume: resume(2, 'Before approval.\n\nFirst continuation.')
      }
    })
    await post({ type: 'chunk', content: 'Second continuation.' })
    const secondEnd = await post({ type: 'end', content: '', metadata: { approvalResumeVersion: 2 } })
    expect(secondEnd).toMatchObject({
      sub: 'chat',
      event: {
        type: 'end',
        content: 'Before approval.\n\nFirst continuation.\n\nSecond continuation.',
        metadata: { approvalResumeVersion: 2 }
      }
    })
    expect(secondEnd.event.content.match(/First continuation\./g)).toHaveLength(1)

    await hub.reader.cancel()
  })

  it('keeps a trusted prior zip when a resumed record has an allow-list id but no zip metadata', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'chat')

    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-zip', ...payload }),
        locals
      } as any)
      expect(response.status).toBe(200)
      return readSsePayload(hub.reader)
    }
    const zipId = 'cool_tool_1789786818581_y9csi'
    const reference = `{{batshit-zip:${zipId}}}`
    const approvalResume = {
      version: 43,
      prior: {
        content: `Before approval.\n\n${reference}`,
        metadata: { zipIds: [zipId] },
        intermediateSteps: []
      }
    }

    await post({ type: 'start', metadata: { approvalResume } })
    const end = await post({
      type: 'end',
      content: '',
      metadata: { approvalResumeVersion: 43 }
    })

    expect(end).toMatchObject({
      sub: 'chat',
      event: {
        type: 'end',
        content: `Before approval.\n\n${reference}`,
        metadata: { approvalResumeVersion: 43, zipIds: [zipId] }
      }
    })

    await hub.reader.cancel()
  })

  it('finalizes more than the replay cap of chunks and still replays the pinned start', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({
      shouldStream: true,
      content
    }))
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'first')

    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildJsonRequest({ sessionId: 'session-1', messageId: 'message-long', ...payload }),
        locals
      } as any)
      expect(response.status).toBe(200)
      return readSsePayload(hub.reader)
    }
    const approvalResume = {
      version: 42,
      prior: { content: 'Prefix.', metadata: {}, intermediateSteps: [] }
    }
    await post({ type: 'start', metadata: { approvalResume } })
    for (let index = 0; index < 2001; index += 1) {
      await post({ type: 'chunk', content: 'x' })
    }

    const end = await post({
      type: 'end',
      content: '',
      metadata: { approvalResumeVersion: 42 }
    })
    expect(end.event.content).toBe(`Prefix.\n\n${'x'.repeat(2001)}`)

    // The ordinary replay buffer evicted the original start, but the dedicated envelope is
    // still sent first to a tab joining during the terminal grace window.
    await subscribeChat(route, locals, hub, 'late')
    expect(await readSsePayload(hub.reader)).toMatchObject({
      sub: 'late',
      event: {
        type: 'start',
        messageId: 'message-long',
        metadata: { approvalResume }
      }
    })

    await hub.reader.cancel()
  }, 30_000)
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
})

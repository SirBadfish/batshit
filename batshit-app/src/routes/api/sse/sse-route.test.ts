import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireOwnedSession: vi.fn(),
  isTrustedInternalRequest: vi.fn(),
  getUserSettings: vi.fn(),
  getSession: vi.fn(),
  redisExecute: vi.fn(),
  redisGet: vi.fn(),
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
  dropMessageReferences: vi.fn(),
  removeUnclaimedZipsMadeByMessage: vi.fn(),
  saveMessage: vi.fn(),
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
    execute: mocks.redisExecute,
    get: mocks.redisGet,
    saveMessage: mocks.saveMessage,
    removeUnclaimedZipsMadeByMessage: mocks.removeUnclaimedZipsMadeByMessage
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
    this.dropMessageReferences = mocks.dropMessageReferences
    this.clearSessionReferences = vi.fn()
  })
}))

function buildInternalJsonRequest(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-batshit-service-token': 'test-service-token' },
    body: JSON.stringify(payload)
  })
}

function buildBrowserJsonRequest(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  })
}

function browserMessage(kind: 'normal' | 'quick-action' = 'normal') {
  const common = {
    client_sent: true, error_message: null, hasAttachments: false, attachmentCount: 0,
    stt: kind === 'quick-action', tts: kind === 'quick-action', voiceMode: kind === 'quick-action',
    fileReferences: [], clipIds: [], zipIds: []
  }
  return {
    id: `new-user-${kind}`, content: kind === 'normal' ? 'A new message' : 'Voice quick action',
    role: 'user', session_id: 'session-1', user_id: 'user-1', agent_id: 'selected-agent',
    created_at: '2026-10-21T00:00:00.000Z', timestamp: '2026-10-21T00:00:00.000Z', status: 'complete',
    metadata: kind === 'normal'
      ? { ...common, projectPath: '/project', subagentSnapshot: [], skillInvocation: { name: 'guide' }, interruption: { reason: 'user' } }
      : { ...common, quickAction: { type: 'mark' } }
  }
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

    mocks.requireOwnedSession.mockResolvedValue({ ok: true, value: { id: 'session-1', user_id: 'user-1' } })
    mocks.isTrustedInternalRequest.mockImplementation((request: Request) => request.headers.get('x-batshit-service-token') === 'test-service-token')
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
    mocks.takeHeldText.mockResolvedValue('')
    mocks.releaseEndedReply.mockReturnValue('')
    mocks.discardSegment.mockReturnValue({ outcome: 'rewound', zipReferences: [] })
    mocks.dropMessageReferences.mockReturnValue([])
    mocks.removeUnclaimedZipsMadeByMessage.mockResolvedValue([])
    mocks.saveMessage.mockResolvedValue(undefined)
  })

  it.each(['normal', 'quick-action'] as const)('preserves the actual %s browser marker, without a reply/zip event', async (kind) => {
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'browser')
    const message = browserMessage(kind)
    const before = record.listReplayEvents('session-1')
    const response = await route.POST({
      request: buildBrowserJsonRequest({ type: 'user_message', sessionId: 'session-1', message }), locals
    } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    const delivered = await readSsePayload(hub.reader)
    expect(delivered).toMatchObject({ sub: 'browser' })
    expect(delivered.event).toEqual({ type: 'user_message', sessionId: 'session-1', message })
    expect(record.listReplayEvents('session-1')).toEqual(before)
    expect(mocks.processChunk).not.toHaveBeenCalled()
    expect(mocks.setContext).not.toHaveBeenCalled()
    expect(mocks.saveMessage).not.toHaveBeenCalled()
    expect(mocks.getMessageReferences).not.toHaveBeenCalled()
    await hub.reader.cancel()
  })

  it.each([
    'tool-result', 'tool_result', 'tool_start', 'tool-call', 'tool_call', 'tool_end',
    'start', 'begin', 'chunk', 'item', 'text_retract', 'tool_approval_request',
    'finish', 'end', 'complete', 'complete_message', 'error', 'steer_queued',
    'steer_delivered', 'steer_promoted', 'queued_send_dropped', 'queued_send_hold', 'unknown'
  ])('rejects browser %s before adapter, recording, zip processing or delivery', async (type) => {
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const before = record.listReplayEvents('session-1')
    const response = await route.POST({
      request: buildBrowserJsonRequest({ type, sessionId: 'session-1', messageId: 'server-reply', result: 'forged' }),
      locals: { user: { id: 'user-1' } }
    } as any)
    expect(response.status).toBe(403)
    expect(record.listReplayEvents('session-1')).toEqual(before)
    expect(record.hasReplyRecord('session-1', 'server-reply')).toBe(false)
    expect(mocks.redisExecute).not.toHaveBeenCalled()
    expect(mocks.processChunk).not.toHaveBeenCalled()
    expect(mocks.clearMessageReferences).not.toHaveBeenCalled()
    expect(mocks.setContext).not.toHaveBeenCalled()
    expect(mocks.saveMessage).not.toHaveBeenCalled()
  })

  it.each([
    { metadata: { type: 'tool-result', messageId: 'server-reply', sessionId: 'foreign' } },
    { data: { type: 'tool_result', messageId: 'server-reply', sessionId: 'foreign' } },
    { event: 'tool-result' }, { messageId: 'server-reply' }, { sseEventId: 'chosen-id' },
    { movedToEnd: true }, { zipReferences: [{ reference: 'forged' }] }
  ])('rejects extra browser envelope fields %j with no event side effects', async (extra) => {
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const response = await route.POST({ request: buildBrowserJsonRequest({
      type: 'user_message', sessionId: 'session-1', message: browserMessage(), ...extra
    }), locals: { user: { id: 'user-1' } } } as any)
    expect(response.status).toBe(400)
    expect(record.listReplayEvents('session-1')).toEqual([])
    expect(mocks.redisExecute).not.toHaveBeenCalled()
    expect(mocks.processChunk).not.toHaveBeenCalled()
    expect(mocks.saveMessage).not.toHaveBeenCalled()
  })

  it.each([
    { role: 'assistant' }, { session_id: 'foreign' }, { user_id: 'foreign' }
  ])('refuses browser message identity overrides %j', async (extra) => {
    const route = await import('./+server')
    const response = await route.POST({ request: buildBrowserJsonRequest({
      type: 'user_message', sessionId: 'session-1', message: { ...browserMessage(), ...extra }
    }), locals: { user: { id: 'user-1' } } } as any)
    expect(response.status).toBe(403)
    expect(mocks.redisExecute).not.toHaveBeenCalled()
    expect(mocks.processChunk).not.toHaveBeenCalled()
    expect(mocks.saveMessage).not.toHaveBeenCalled()
  })

  it('rejects message metadata that could impersonate a server event or steer', async () => {
    const route = await import('./+server')
    for (const metadata of [{ type: 'tool-result' }, { steerPromoted: { steerIds: ['server-steer'] } }]) {
      const response = await route.POST({ request: buildBrowserJsonRequest({
        type: 'user_message', sessionId: 'session-1', message: { ...browserMessage(), metadata }
      }), locals: { user: { id: 'user-1' } } } as any)
      expect(response.status).toBe(400)
    }
    expect(mocks.redisExecute).not.toHaveBeenCalled()
    expect(mocks.processChunk).not.toHaveBeenCalled()
  })

  it('retains owned-session refusal, and rechecks ownership after the message read', async () => {
    const route = await import('./+server')
    const owned = { ok: true, value: { id: 'session-1', user_id: 'user-1' } }
    mocks.requireOwnedSession.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) })
    const post = () => route.POST({ request: buildBrowserJsonRequest({
      type: 'user_message', sessionId: 'session-1', message: browserMessage()
    }), locals: { user: { id: 'user-1' } } } as any)
    expect((await post()).status).toBe(403)
    expect(mocks.redisExecute).not.toHaveBeenCalled()
    mocks.requireOwnedSession.mockResolvedValueOnce(owned)
      .mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) })
    expect((await post()).status).toBe(403)
    expect(mocks.processChunk).not.toHaveBeenCalled()
    expect(mocks.saveMessage).not.toHaveBeenCalled()
  })

  it.each(['assistant', 'foreign-user'] as const)('does not broadcast an existing %s identity as a new user message', async (kind) => {
    const route = await import('./+server')
    mocks.redisExecute.mockImplementationOnce(async (fn: any) => fn({ json: { get: async () => ({
      id: 'new-user-normal', session_id: 'session-1', user_id: kind === 'foreign-user' ? 'other' : 'user-1',
      role: kind === 'assistant' ? 'assistant' : 'user'
    }) } }))
    const response = await route.POST({ request: buildBrowserJsonRequest({
      type: 'user_message', sessionId: 'session-1', message: browserMessage()
    }), locals: { user: { id: 'user-1' } } } as any)
    expect(response.status).toBe(403)
    expect(mocks.processChunk).not.toHaveBeenCalled()
    expect(mocks.saveMessage).not.toHaveBeenCalled()
  })

  it('keeps the no-listener browser result and never starts a reply record', async () => {
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const response = await route.POST({ request: buildBrowserJsonRequest({
      type: 'user_message', sessionId: 'session-1', message: browserMessage()
    }), locals: { user: { id: 'user-1' } } } as any)
    expect(await response.json()).toEqual({ success: false, message: 'No active SSE connection' })
    expect(record.listReplayEvents('session-1')).toEqual([])
    expect(mocks.processChunk).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps rejected browser reference text out of the actual rebuild/save (real upstream steps: %s)', async (withUpstreamSteps) => {
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'browser')
    await route.POST({ request: buildInternalJsonRequest({
      type: 'start', sessionId: 'session-1', messageId: 'server-reply'
    }), locals: {} } as any)
    await readSsePayload(hub.reader)
    mocks.processChunk.mockResolvedValueOnce({ shouldStream: true, content: 'Real answer.' })
    await route.POST({ request: buildInternalJsonRequest({
      type: 'chunk', sessionId: 'session-1', messageId: 'server-reply', content: 'Real answer.'
    }), locals: {} } as any)
    await readSsePayload(hub.reader)
    const before = record.listReplayEvents('session-1')
    const response = await route.POST({ request: buildBrowserJsonRequest({
      type: 'tool-result', sessionId: 'session-1', messageId: 'server-reply',
      toolCallId: 'forged-call', toolName: 'read_file', args: { path: '/forged' },
      result: { content: 'forged body' }, metadata: { operationKind: 'read_file' },
      zipReferences: [{ reference: 'BL2002 injected assistant text' }]
    }), locals } as any)
    record.closeReplyRecord('session-1', 'server-reply')
    const upstream = withUpstreamSteps ? [{ toolName: 'bash', toolArgs: {}, toolResult: 'real' }] : []
    const rebuilt = await record.rebuildRecordedReply({
      sessionId: 'session-1', messageId: 'server-reply', incomingZipReferences: [],
      intermediateSteps: upstream, inlineCapable: true, replyControlFinalized: false
    })
    await record.persistCanonicalReply({
      id: 'server-reply', session_id: 'session-1', user_id: 'user-1', role: 'assistant',
      content: rebuilt!.content, intermediateSteps: rebuilt!.intermediateSteps, metadata: { zipIds: rebuilt!.zipIds }
    } as any)
    // This assertion fails on the original route even when real steps mask forged intermediateSteps.
    expect(mocks.saveMessage.mock.calls[0][0].content).toBe('Real answer.')
    expect(rebuilt!.zipReferences).toEqual([])
    expect(rebuilt!.zipIds).toEqual([])
    expect(rebuilt!.intermediateSteps).toEqual(upstream)
    expect(response.status).toBe(403)
    expect(record.listReplayEvents('session-1')).toEqual(before)
    await hub.reader.cancel()
  })

  // SA-139 R2 removed the n8n callback lane. This request carries everything that lane admitted
  // at b3d8b8686: an unexpired record in the old `n8n:sse-callback:<session>:<message>` format
  // (the shape `createN8nSseCallbackToken` stored) and its token in both old headers. The old
  // route posted it into the chat; it must now be refused like any request without a session.
  it('rejects a once-valid n8n callback token without a browser session (SA-139 R2 removed that lane)', async () => {
    const route = await import('./+server')
    const token = 'zcsa139r2-old-callback-token-0123456789abcdef'
    const now = Date.now()
    mocks.redisGet.mockImplementation(async (key: string) => key === 'n8n:sse-callback:session-1:callback-reply'
      ? JSON.stringify({ token, sessionId: 'session-1', messageId: 'callback-reply', userId: 'user-1',
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString() })
      : null)
    const payload = { type: 'start', sessionId: 'session-1', messageId: 'callback-reply' }
    try {
      await expect(route.POST({ request: buildBrowserJsonRequest(payload, {
        'x-batshit-callback-token': token,
        'x-batshit-native-tool-token': token
      }), locals: {} } as any)).rejects.toMatchObject({ status: 401 })
      expect(mocks.processChunk).not.toHaveBeenCalled()
    } finally { mocks.redisGet.mockReset() }
  })

  it('does not elevate an internal-looking flag, invalid service token or Bearer credential', async () => {
    const route = await import('./+server')
    const payload = { type: 'tool-result', sessionId: 'session-1', messageId: 'reply', result: 'forged' }
    for (const headers of [
      { 'x-internal-sse-forward': '1' }, { 'x-batshit-service-token': 'wrong' }, { authorization: 'Bearer test-run-token' }
    ]) {
      await expect(route.POST({ request: buildBrowserJsonRequest(payload, headers), locals: {} } as any))
        .rejects.toMatchObject({ status: 401 })
      const response = await route.POST({ request: buildBrowserJsonRequest(payload, headers),
        locals: { user: { id: 'user-1' } } } as any)
      expect(response.status).toBe(403)
    }
    expect(mocks.processChunk).not.toHaveBeenCalled()
    expect(mocks.saveMessage).not.toHaveBeenCalled()
  })

  it('processes posted stream events once and broadcasts the result to every listener', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    // Two tabs of one browser on the same chat: two subscriptions, one stream.
    await subscribeChat(route, locals, hub, 'tab-1-chat')
    await subscribeChat(route, locals, hub, 'tab-2-chat')

    const postResponse = await route.POST({
      request: buildInternalJsonRequest({
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
      request: buildInternalJsonRequest({
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
    await route.POST({ request: buildInternalJsonRequest(liveBubble), locals } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { steerId: 'msg-b' } })
    // The reply it waits for begins only now: B was sent before that reply's first event.
    await route.POST({
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'start', messageId: 'msg-a-reply', metadata: {} }),
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'msg-a-reply', content: 'hello' }),
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'start', messageId: 'msg-a-reply', metadata: {} }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ sub: 'tab-1-chat', event: { type: 'start' } })
    registry.registerSessionTurn('session-1', 'single', 'msg-a-reply')
    registry.queueSessionTurn('session-1', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    await route.POST({
      request: buildInternalJsonRequest({
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'msg-a-reply', content: 'hello' }),
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'start', messageId: 'msg-a-reply', metadata: {} }),
      locals
    } as any)
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'start' } })
    // Both even when they name the running reply: they are chat facts, not parts of a reply.
    await route.POST({
      request: buildInternalJsonRequest({
        sessionId: 'session-1',
        type: 'user_message',
        messageId: 'msg-a-reply',
        message: { id: 'msg-b', role: 'user', content: 'SECOND' }
      }),
      locals
    } as any)
    await route.POST({
      request: buildInternalJsonRequest({
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'msg-a-reply', content: 'hello' }),
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

      // The hold's start and end reach every tab as they happen, and are never replayed. BL-903 (b):
      // a notice carries the line's hold as it is at broadcast time, so the hold ends first (Send now).
      expect(registry.sendWaitingSendNow('session-1', 'msg-b')).toMatchObject({ waiting: true, endedCardHold: true })
      await route.POST({
        request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'queued_send_hold', heldForApprovalCard: null }),
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
      request: buildInternalJsonRequest({
        sessionId: 'session-1',
        type: 'start',
        messageId: 'message-1',
        metadata: { agentId: 'agent-1' }
      }),
      locals
    } as any)

    await route.POST({
      request: buildInternalJsonRequest({
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
      request: buildInternalJsonRequest({
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
      request: buildInternalJsonRequest({
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
      request: buildInternalJsonRequest({
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
      request: buildInternalJsonRequest({
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-saved', ...payload }),
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-unwatched', ...payload }),
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
  // approval resume's `start` (a newer version, BL-871 a) reopens the reply.
  it('refuses a late content event of a reply the finalize already rebuilt, until its next start', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-late', ...payload }),
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

    const resume = { approvalResume: { version: 7, prior: { content: 'On time.', metadata: {} } } }
    expect(await post({ type: 'start', metadata: resume })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'Resumed.' })).toEqual({ success: true })
    record.forgetChatReplyRecords('session-1')
  })

  // BL-871 (a): a `start` whose forward passed its time limit can finish after the finalize closed
  // the reply. It used to be taken like an approval resume's start: the saved reply reopened, its
  // record was replaced by an empty one, every tab got a second `start`, and nothing ever ended it.
  // Now only a start that opens a newer approval resume part reopens a closed reply.
  it('refuses a late start of a closed reply unless it opens a newer approval resume part (BL-871 a)', async () => {
    mocks.processChunk.mockImplementation(async (_sessionId, _messageId, content) => ({ shouldStream: true, content }))
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab')
    const post = async (payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-start', ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    const resumeAt = (version: number) => ({
      approvalResume: { version, prior: { content: 'On time.', metadata: {} } }
    })
    const recordedText = () =>
      record
        .listReplayEvents('session-1')
        .filter((event) => event.messageId === 'message-start' && event.type === 'chunk')
        .map((event) => event.content)
        .join('')

    expect(await post({ type: 'start' })).toEqual({ success: true })
    expect(await post({ type: 'chunk', content: 'On time.' })).toEqual({ success: true })
    record.closeReplyRecord('session-1', 'message-start', 0)

    // The reply's own late start, and one of an older part, are refused and change nothing.
    expect(await post({ type: 'start' })).toMatchObject({ success: false })
    expect(await post({ type: 'start', metadata: { approvalResume: { version: 0 } } })).toMatchObject({ success: false })
    expect(record.isReplyClosed('session-1', 'message-start')).toBe(true)
    expect(recordedText()).toBe('On time.')
    expect(await post({ type: 'complete' })).toEqual({ success: true })
    // The tab got the reply and its end, and no second start.
    const seen = []
    for (let i = 0; i < 3; i += 1) seen.push((await readSsePayload(hub.reader))?.event?.type)
    expect(seen).toEqual(['start', 'chunk', 'complete'])

    // A newer approval resume part reopens it; a late start of that same part, once it is closed
    // in its turn, is refused like the first one; a still newer part reopens it again.
    expect(await post({ type: 'start', metadata: resumeAt(5) })).toEqual({ success: true })
    expect(record.isReplyClosed('session-1', 'message-start')).toBe(false)
    record.closeReplyRecord('session-1', 'message-start', 5)
    expect(await post({ type: 'start', metadata: resumeAt(5) })).toMatchObject({ success: false })
    expect(await post({ type: 'start', metadata: resumeAt(4) })).toMatchObject({ success: false })
    // A later close with an older version keeps the newest one.
    record.closeReplyRecord('session-1', 'message-start', 0)
    expect(await post({ type: 'start', metadata: resumeAt(5) })).toMatchObject({ success: false })
    expect(await post({ type: 'start', metadata: resumeAt(6) })).toEqual({ success: true })

    await hub.reader.cancel()
    record.forgetChatReplyRecords('session-1')
  })

  // BL-871 (b): a content or tool event can pass the arrival check and reach the tabs after the
  // finalize closed its reply (the route awaits in between). The record refused it at the write,
  // but every tab still got it: words or a tool card the saved reply does not hold. The tabs now
  // get exactly what the record took.
  it('sends the tabs no tool event or chunk the record refused because its reply closed mid-route (BL-871 b)', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const locals = { user: { id: 'user-1' } }
    const hub = await openHub(route, locals)
    await subscribeChat(route, locals, hub, 'tab')
    const post = async (messageId: string, payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId, ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    const recorded = (messageId: string) =>
      record.listReplayEvents('session-1').filter((event) => event.messageId === messageId).map((event) => event.type)

    // A tool call: the finalize closes the reply while the route reads the agent's settings.
    expect(await post('message-tool', { type: 'start' })).toEqual({ success: true })
    expect((await readSsePayload(hub.reader))?.event?.type).toBe('start')
    const load = mocks.redisExecute.getMockImplementation()!
    mocks.redisExecute.mockImplementation(async (fn: any) => {
      record.closeReplyRecord('session-1', 'message-tool', 0)
      return load(fn)
    })
    await post('message-tool', { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', args: { path: '/a' } })
    mocks.redisExecute.mockImplementation(load)
    expect(recorded('message-tool')).toEqual(['start'])

    // A chunk: the finalize closes the reply while the zip detector works on it.
    expect(await post('message-chunk', { type: 'start' })).toEqual({ success: true })
    mocks.processChunk.mockImplementation(async (_sessionId, messageId, content) => {
      record.closeReplyRecord('session-1', messageId, 0)
      return { shouldStream: true, content }
    })
    await post('message-chunk', { type: 'chunk', content: 'Late words.' })
    expect(recorded('message-chunk')).toEqual(['start'])

    // The tab's next events are the second reply's start and the end of the first: neither the
    // tool card nor the words.
    expect(await post('message-tool', { type: 'complete' })).toEqual({ success: true })
    const seen = []
    for (let i = 0; i < 2; i += 1) {
      const event = (await readSsePayload(hub.reader))?.event
      seen.push(`${event?.type}:${event?.messageId}`)
    }
    expect(seen).toEqual(['start:message-chunk', 'complete:message-tool'])

    await hub.reader.cancel()
    record.forgetChatReplyRecords('session-1')
  })

  // BL-871 (c): a close that lands INSIDE a chunk's zip detection. The zips that call made after the
  // close are named by no saved reply: the route takes only the call's NEW ids out of the detector's
  // list (never an older zip of the reply), and removes what it took when no message names it. An id
  // the list no longer holds (a rebuild took it; the saved reply may name it) is left to the finalize.
  it('removes only the zips a chunk made after its reply closed mid-detection, and records nothing (BL-871 c)', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.hasRunningRequest.mockReturnValue(true)
    const route = await import('./+server')
    const record = await import('$lib/server/services/replyStreamRecord')
    const post = async (messageId: string, payload: Record<string, unknown>) => {
      const response = await route.POST({
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId, ...payload }),
        locals: { user: undefined }
      } as any)
      return response.json()
    }
    const old = { zipId: 'error_old', reference: '{{batshit-zip:error_old:::Error}}' }
    const madeAndHeld = { zipId: 'error_new_held', reference: '{{batshit-zip:error_new_held:::Error}}' }

    expect(await post('message-zip', { type: 'start' })).toEqual({ success: true })
    // Before the detection the list holds an older zip; after it, that one and the call's new one.
    // (A zip a rebuild already took is no longer in the list, so it is never a candidate.)
    mocks.getMessageReferences.mockReturnValueOnce([old]).mockReturnValueOnce([old, madeAndHeld])
    mocks.dropMessageReferences.mockReturnValueOnce([madeAndHeld])
    mocks.processChunk.mockImplementationOnce(async (_sessionId, messageId, content) => {
      record.closeReplyRecord('session-1', messageId, 0)
      return { shouldStream: true, content }
    })

    expect(await post('message-zip', { type: 'chunk', content: ' at line 3</error>' })).toMatchObject({ success: false })
    expect(mocks.dropMessageReferences).toHaveBeenCalledWith('session-1', 'message-zip', ['error_new_held'])
    expect(mocks.removeUnclaimedZipsMadeByMessage).toHaveBeenCalledTimes(1)
    expect(mocks.removeUnclaimedZipsMadeByMessage).toHaveBeenCalledWith('session-1', 'message-zip', ['error_new_held'])
    const recorded = record.listReplayEvents('session-1').filter((event) => event.messageId === 'message-zip').map((event) => event.type)
    expect(recorded).toEqual(['start'])

    // A close inside a detection that made no zip removes nothing.
    expect(await post('message-none', { type: 'start' })).toEqual({ success: true })
    mocks.processChunk.mockImplementationOnce(async (_sessionId, messageId, content) => {
      record.closeReplyRecord('session-1', messageId, 0)
      return { shouldStream: true, content }
    })
    expect(await post('message-none', { type: 'chunk', content: 'Late words.' })).toMatchObject({ success: false })
    expect(mocks.removeUnclaimedZipsMadeByMessage).toHaveBeenCalledTimes(1)

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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-race', ...payload }),
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-seg', ...payload }),
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-retry', ...payload }),
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId, ...payload }),
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId, ...payload }),
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-1', ...payload }),
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
        request: buildInternalJsonRequest({ sessionId: 'session-1', messageId: 'message-1', ...payload }),
        locals
      } as any)
      expect(response.status).toBe(200)
    }
    await post({ type: 'start', metadata: {} })
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'start' } })
    await post({ type: 'chunk', content: 'Intro. ' })
    expect(await readSsePayload(hub.reader)).toMatchObject({ event: { type: 'chunk', content: 'Intro. ' } })
    mocks.takeHeldText.mockResolvedValueOnce('<error> before the tool. ')
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
    mocks.isTrustedInternalRequest.mockImplementation((request: Request) => request.headers.get('x-batshit-service-token') === 'test-service-token')
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'm1', content: 'hello' }),
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
    mocks.isTrustedInternalRequest.mockImplementation((request: Request) => request.headers.get('x-batshit-service-token') === 'test-service-token')
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', type: 'chunk', messageId: 'm1', content: 'hello' }),
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
 * BL-496 moved the chat channel's Redis subscriber out of the route, so an event published while
 * no browser had connected is heard by the server. SA-139 R4 removed the Claude approval card,
 * the one event the subscriber recorded for a reply's replay (its permission helper and the CLI
 * Primary that raised it are gone); the subscriber stays the server's one, and forwards.
 */
describe('/api/sse and the server’s chat-channel subscriber (BL-496)', () => {
  const lateEvent = { type: 'tool-result', sessionId: 'session-1', messageId: 'reply-1', toolCallId: 'call-1', result: { ok: true } }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.externalMessageHandlers.length = 0
    mocks.requireOwnedSession.mockResolvedValue({ ok: true })
    mocks.isTrustedInternalRequest.mockImplementation((request: Request) => request.headers.get('x-batshit-service-token') === 'test-service-token')
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
    mocks.processChunk.mockImplementation(async (_s: string, _m: string, content: string) => ({
      shouldStream: true,
      content
    }))
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
    mocks.takeHeldText.mockResolvedValue('')
    mocks.releaseEndedReply.mockReturnValue('')
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
      request: buildInternalJsonRequest({ sessionId: 'session-1', ...event }),
      locals
    } as any)
    return response.json()
  }

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

  /** Review finding 6: an external event for a reply nobody recorded and no running request makes no state. */
  it('a late external event after its reply ended is not buffered for later tabs', async () => {
    const route = await import('./+server')
    const { ensureSseExternalSubscriber } = await import('$lib/server/sseExternalSubscriber')
    await ensureSseExternalSubscriber()
    mocks.hasRunningRequest.mockReturnValue(false)
    publish(lateEvent)

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

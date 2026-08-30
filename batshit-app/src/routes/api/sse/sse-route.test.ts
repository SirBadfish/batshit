import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireOwnedSession: vi.fn(),
  isTrustedInternalRequest: vi.fn(),
  isTrustedN8nSseCallbackRequest: vi.fn(),
  getUserSettings: vi.fn(),
  getSession: vi.fn(),
  redisExecute: vi.fn(),
  cleanupSessionTempStorage: vi.fn(),
  initializeKeyspaceNotifications: vi.fn(),
  setupSessionMonitoring: vi.fn(),
  processChunk: vi.fn(),
  clearMessageReferences: vi.fn(),
  getMessageReferences: vi.fn(),
  setContext: vi.fn(),
  deleteSessionBuffers: vi.fn(),
  finalizeOpenBlocks: vi.fn(),
  externalDisconnect: vi.fn(async () => undefined)
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

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: mocks.getUserSettings,
    getSession: mocks.getSession,
    execute: mocks.redisExecute
  }
}))

vi.mock('$lib/server/redisStreamService', () => ({
  redisStreamService: {
    cleanupSessionTempStorage: mocks.cleanupSessionTempStorage
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

describe('/api/sse route streaming contract', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

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
    mocks.initializeKeyspaceNotifications.mockResolvedValue(undefined)
    mocks.setupSessionMonitoring.mockResolvedValue(vi.fn())
    mocks.processChunk.mockResolvedValue({ shouldStream: true, content: 'hello' })
    mocks.getMessageReferences.mockReturnValue([])
    mocks.finalizeOpenBlocks.mockResolvedValue([])
  })

  it('processes posted stream events once and broadcasts the result to every listener', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const url = new URL('http://localhost/api/sse?sessionId=session-1')

    const firstResponse = await route.GET({ url, locals } as any)
    const secondResponse = await route.GET({ url, locals } as any)
    const firstReader = firstResponse.body!.getReader()
    const secondReader = secondResponse.body!.getReader()

    expect(await readSsePayload(firstReader)).toMatchObject({ type: 'connected' })
    expect(await readSsePayload(secondReader)).toMatchObject({ type: 'connected' })

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
    expect(await readSsePayload(firstReader)).toMatchObject({
      type: 'chunk',
      content: 'hello',
      messageId: 'message-1'
    })
    expect(await readSsePayload(secondReader)).toMatchObject({
      type: 'chunk',
      content: 'hello',
      messageId: 'message-1'
    })

    await firstReader.cancel()
    await secondReader.cancel()
  })

  it('closes active streams and external Redis resources during runtime shutdown', async () => {
    const visualCleanup = vi.fn(async () => undefined)
    mocks.setupSessionMonitoring.mockResolvedValue(visualCleanup)
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const url = new URL('http://localhost/api/sse?sessionId=session-1')
    const response = await route.GET({ url, locals } as any)
    const reader = response.body!.getReader()
    expect(await readSsePayload(reader)).toMatchObject({ type: 'connected' })

    await route._closeSseRuntimeResources('test')

    expect(await reader.read()).toMatchObject({ done: true })
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
    const url = new URL('http://localhost/api/sse?sessionId=session-1')
    const response = await route.GET({ url, locals } as any)
    const reader = response.body!.getReader()
    expect(await readSsePayload(reader)).toMatchObject({ type: 'connected' })
    await vi.waitFor(() => expect(mocks.setupSessionMonitoring).toHaveBeenCalledOnce())

    const closing = route._closeSseRuntimeResources('test-deferred-setup')
    finishSetup(lateVisualCleanup)
    await closing

    await vi.waitFor(() => expect(lateVisualCleanup).toHaveBeenCalledOnce())
    expect(await reader.read()).toMatchObject({ done: true })
  })

  it('stamps stable stream event ids on original delivery and replay', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const url = new URL('http://localhost/api/sse?sessionId=session-1')

    const firstResponse = await route.GET({ url, locals } as any)
    const firstReader = firstResponse.body!.getReader()
    expect(await readSsePayload(firstReader)).toMatchObject({ type: 'connected' })

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

    const startEvent = await readSsePayload(firstReader)
    const chunkEvent = await readSsePayload(firstReader)
    expect(startEvent).toMatchObject({
      type: 'start',
      messageId: 'message-1',
      sseEventId: 'message-1:1'
    })
    expect(chunkEvent).toMatchObject({
      type: 'chunk',
      messageId: 'message-1',
      content: 'hello',
      sseEventId: 'message-1:2'
    })

    const replayResponse = await route.GET({ url, locals } as any)
    const replayReader = replayResponse.body!.getReader()
    expect(await readSsePayload(replayReader)).toMatchObject({ type: 'connected' })
    expect(await readSsePayload(replayReader)).toMatchObject({
      type: 'start',
      messageId: 'message-1',
      sseEventId: 'message-1:1'
    })
    expect(await readSsePayload(replayReader)).toMatchObject({
      type: 'chunk',
      messageId: 'message-1',
      content: 'hello',
      sseEventId: 'message-1:2'
    })

    await firstReader.cancel()
    await replayReader.cancel()
  })

  it('preserves flat user_message payload fields when metadata exists', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const url = new URL('http://localhost/api/sse?sessionId=session-1')
    const response = await route.GET({ url, locals } as any)
    const reader = response.body!.getReader()

    expect(await readSsePayload(reader)).toMatchObject({ type: 'connected' })

    await route.POST({
      request: buildJsonRequest({
        sessionId: 'session-1',
        type: 'user_message',
        message: 'voice transcript',
        metadata: { source: 'livekit' }
      }),
      locals
    } as any)

    expect(await readSsePayload(reader)).toMatchObject({
      type: 'user_message',
      message: 'voice transcript',
      source: 'livekit'
    })

    await reader.cancel()
  })

  it('forwards reasoning-indicator stop events even when content is empty', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const url = new URL('http://localhost/api/sse?sessionId=session-1')
    const response = await route.GET({ url, locals } as any)
    const reader = response.body!.getReader()

    expect(await readSsePayload(reader)).toMatchObject({ type: 'connected' })

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

    expect(await readSsePayload(reader)).toMatchObject({
      type: 'thinking',
      content: '',
      metadata: { kind: 'reasoning_indicator', op: 'stop' },
      messageId: 'message-1'
    })

    await reader.cancel()
  })

  it('lets the stream adapter own missing tool ids while preserving metadata', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const url = new URL('http://localhost/api/sse?sessionId=session-1')
    const response = await route.GET({ url, locals } as any)
    const reader = response.body!.getReader()

    expect(await readSsePayload(reader)).toMatchObject({ type: 'connected' })

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

    const event = await readSsePayload(reader)
    expect(event).toMatchObject({
      type: 'tool_start',
      toolName: 'example_tool',
      metadata: { agentId: 'agent-1' },
      messageId: 'message-1'
    })
    expect(event.toolCallId).toMatch(/^tool_\d+_[a-z0-9]+$/)

    await reader.cancel()
  })

  it('keeps flat error text authoritative over content and metadata remaps', async () => {
    const route = await import('./+server')
    const locals = { user: { id: 'user-1' } }
    const url = new URL('http://localhost/api/sse?sessionId=session-1')
    const response = await route.GET({ url, locals } as any)
    const reader = response.body!.getReader()

    expect(await readSsePayload(reader)).toMatchObject({ type: 'connected' })

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

    expect(await readSsePayload(reader)).toMatchObject({
      type: 'error',
      error: 'Provider rejected the request'
    })

    await reader.cancel()
  })
})

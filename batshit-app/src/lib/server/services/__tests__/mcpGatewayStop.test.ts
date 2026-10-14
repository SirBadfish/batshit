import { beforeEach, describe, expect, it, vi } from 'vitest'

// BL-454: a Stop reaches the gateway wrapper's MCP call, closes this call's client, and
// leaves no listener on the reply's signal once the call ends. The fake target tool
// behaves like `@ai-sdk/mcp`'s own execute: it throws on an aborted signal, rejects when the
// signal aborts mid-call, and removes its listener when the call settles.

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  discoverTools: vi.fn(),
  createClient: vi.fn(),
  createMCPClient: vi.fn(),
  httpDiscoverTools: vi.fn(),
  targetExecute: vi.fn(),
  closeClient: vi.fn()
}))

vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: mocks.createMCPClient }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class FakeStreamableHTTPClientTransport {
    constructor(
      public url: URL,
      public options?: unknown
    ) {}
  }
}))
vi.mock('../mcpGatewayService', () => ({ mcpGatewayService: { list: mocks.list } }))
vi.mock('../stdioMCPGatewayClient', () => ({
  stdioMCPGatewayClient: { discoverTools: mocks.discoverTools, createClient: mocks.createClient }
}))
vi.mock('../dockerMCPGatewayClient', () => ({ dockerMCPGatewayClient: { discoverTools: vi.fn() } }))
// A `custom` HTTP gateway is discovered through the n8n MCP client and executed by the wrapper.
vi.mock('../n8nMCPGatewayClient', () => ({
  n8nMCPGatewayClient: { discoverTools: mocks.httpDiscoverTools }
}))
vi.mock('../dockerGatewayConfig', () => ({
  buildDockerGatewayHeaders: () => ({}),
  buildDockerGatewayUrl: (path: string) => `http://localhost:8811${path}`
}))
vi.mock('../mcpGatewayPolicy', () => ({
  getBlockedBatshitServerGatewayReason: () => 'blocked',
  isBlockedBatshitServerGatewayUrl: () => false
}))
vi.mock('../runtimeUrlRewrites', () => ({ rewriteN8nGatewayUrlForRuntime: (url: string) => url }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve: vi.fn() } }))
vi.mock('../mcpGatewayStdio', () => ({
  resolveStdioGatewayProcessConfig: vi.fn(async () => ({
    command: '/usr/local/bin/node',
    args: [],
    cwd: undefined,
    env: {},
    startupTimeoutMs: 10_000,
    toolCallTimeoutMs: 60_000
  }))
}))
vi.mock('$lib/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { mcpGatewayDiscovery } from '../mcpGatewayDiscovery'
import { logger } from '$lib/utils/logger'

const TOOL_DEF = {
  name: 'remote_write',
  description: 'Writes remotely',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
}

/** Mirrors `@ai-sdk/mcp` 2.x: `execute(args, { abortSignal })` → `callTool({ options: { signal } })`. */
function sdkShapedExecute(settle: 'hang' | 'resolve') {
  return (_args: unknown, options?: { abortSignal?: AbortSignal }) => {
    const signal = options?.abortSignal
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('Request was aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      if (settle === 'resolve') {
        signal?.removeEventListener('abort', onAbort)
        resolve({ content: [{ type: 'text', text: 'done' }] })
      }
    })
  }
}

/** Every listener still registered on `signal`: added, not removed, and not a fired `once`. */
function trackListeners(signal: AbortSignal) {
  const live = new Set<unknown>()
  const once = new Set<unknown>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  add('abort', () => {
    for (const listener of once) live.delete(listener)
  })
  signal.addEventListener = ((type: string, listener: any, opts?: any) => {
    live.add(listener)
    if (typeof opts === 'object' && opts?.once) once.add(listener)
    add(type, listener, opts)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((type: string, listener: any, opts?: any) => {
    live.delete(listener)
    remove(type, listener, opts)
  }) as typeof signal.removeEventListener
  return live
}

function stdioGateway() {
  return {
    id: 'gw-stdio',
    name: 'Local',
    type: 'stdio',
    enabled: true,
    stdioConfig: { command: 'node', cwdPolicy: 'project' }
  }
}

function httpGateway() {
  return {
    id: 'gw-http',
    name: 'Remote',
    type: 'custom',
    enabled: true,
    url: 'https://mcp.example.test/mcp'
  }
}

async function loadWrapped(gateway: Record<string, unknown>) {
  mocks.list.mockResolvedValue([gateway])
  const { tools } = await mcpGatewayDiscovery.loadToolsForUser(
    'josh',
    [gateway.id as string],
    undefined,
    { skipFiltering: true }
  )
  const wrapped = tools.remote_write as any
  expect(typeof wrapped?.execute).toBe('function')
  return wrapped
}

function fakeClient() {
  return {
    tools: vi.fn(async () => ({ remote_write: { execute: mocks.targetExecute } })),
    close: mocks.closeClient
  }
}

describe('gateway wrapper Stop (BL-454)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { mcpToolListCache } = await import('../mcpToolListCache')
    mcpToolListCache.clearAll()
    mocks.closeClient.mockResolvedValue(undefined)
    mocks.discoverTools.mockResolvedValue([TOOL_DEF])
    mocks.httpDiscoverTools.mockResolvedValue([TOOL_DEF])
    mocks.createClient.mockImplementation(async () => ({
      client: fakeClient(),
      stderrChunks: [],
      toolCallTimeoutMs: 60_000
    }))
    mocks.createMCPClient.mockImplementation(async () => fakeClient())
  })

  it('hands a directly selected STDIO tool the Stop signal and closes the client on a Stop', async () => {
    mocks.targetExecute.mockImplementation(sdkShapedExecute('hang'))
    const wrapped = await loadWrapped(stdioGateway())
    const controller = new AbortController()
    const live = trackListeners(controller.signal)

    const call = wrapped.execute({ value: 'x' }, { abortSignal: controller.signal, toolCallId: 't1', messages: [] })
    await vi.waitFor(() => expect(mocks.targetExecute).toHaveBeenCalled())
    expect(mocks.targetExecute).toHaveBeenCalledWith({ value: 'x' }, { abortSignal: controller.signal })
    expect(mocks.closeClient).not.toHaveBeenCalled()

    controller.abort(new Error('stopped'))
    await expect(call).rejects.toThrow('Request was aborted')
    expect(mocks.closeClient).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(0)
  })

  it('hands an HTTP gateway tool the Stop signal, bounds its startup by it, and closes on a Stop', async () => {
    const wrapped = await loadWrapped(httpGateway())
    mocks.targetExecute.mockImplementation(sdkShapedExecute('hang'))
    const controller = new AbortController()
    const live = trackListeners(controller.signal)

    const call = wrapped.execute({ value: 'x' }, { abortSignal: controller.signal })
    await vi.waitFor(() => expect(mocks.targetExecute).toHaveBeenCalled())
    expect(mocks.createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({ initializationOptions: { signal: controller.signal } })
    )
    expect(mocks.targetExecute).toHaveBeenCalledWith({ value: 'x' }, { abortSignal: controller.signal })

    controller.abort(new Error('stopped'))
    await expect(call).rejects.toThrow('Request was aborted')
    expect(mocks.closeClient).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(0)
  })

  it('a Stop while a STDIO client is still starting rejects at once and closes the late client', async () => {
    mocks.targetExecute.mockImplementation(sdkShapedExecute('resolve'))
    const wrapped = await loadWrapped(stdioGateway())
    let finishStart!: (value: unknown) => void
    const lateClient = fakeClient()
    mocks.createClient.mockImplementationOnce(
      () => new Promise((resolve) => (finishStart = resolve))
    )
    const controller = new AbortController()
    const live = trackListeners(controller.signal)

    const call = wrapped.execute({ value: 'x' }, { abortSignal: controller.signal })
    await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'))
    controller.abort(new Error('stopped'))
    await expect(call).rejects.toThrow('stopped')

    finishStart({ client: lateClient, stderrChunks: [], toolCallTimeoutMs: 60_000 })
    await vi.waitFor(() => expect(mocks.closeClient).toHaveBeenCalledTimes(1))
    expect(mocks.targetExecute).not.toHaveBeenCalled()
    expect(live.size).toBe(0)
  })

  it('an already-stopped call opens no client', async () => {
    const wrapped = await loadWrapped(stdioGateway())
    const controller = new AbortController()
    controller.abort(new Error('stopped'))

    await expect(wrapped.execute({ value: 'x' }, { abortSignal: controller.signal })).rejects.toThrow(
      'stopped'
    )
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('a normal call returns its result, closes the client once, and leaves no listener', async () => {
    mocks.targetExecute.mockImplementation(sdkShapedExecute('resolve'))
    // STDIO returns the MCP result as is; the HTTP path unwraps its text content.
    const cases = [
      { gateway: stdioGateway(), expected: { content: [{ type: 'text', text: 'done' }] } },
      { gateway: httpGateway(), expected: 'done' }
    ]
    for (const { gateway, expected } of cases) {
      const wrapped = await loadWrapped(gateway)
      mocks.closeClient.mockClear()
      const controller = new AbortController()
      const live = trackListeners(controller.signal)

      await expect(
        wrapped.execute({ value: 'x' }, { abortSignal: controller.signal })
      ).resolves.toEqual(expected)
      expect(mocks.closeClient).toHaveBeenCalledTimes(1)
      expect(live.size).toBe(0)

      // A Stop after the call ended touches nothing.
      controller.abort()
      expect(mocks.closeClient).toHaveBeenCalledTimes(1)
    }
  })

  // Review follow-up: the STDIO SDK close waits 2 s, SIGTERMs, waits 2 s more. A stopped call
  // answers without waiting for it, and a Stop is not logged as an execution error.
  it('a stopped call answers before its slow close finishes, and a failed close is still logged', async () => {
    mocks.targetExecute.mockImplementation(sdkShapedExecute('hang'))
    const wrapped = await loadWrapped(stdioGateway())
    let failClose!: (error: Error) => void
    mocks.closeClient.mockImplementation(
      () => new Promise<void>((_, reject) => (failClose = reject))
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const controller = new AbortController()
      const call = wrapped.execute({ value: 'x' }, { abortSignal: controller.signal })
      await vi.waitFor(() => expect(mocks.targetExecute).toHaveBeenCalled())

      controller.abort(new Error('stopped'))
      await expect(call).rejects.toThrow('Request was aborted')
      expect(mocks.closeClient).toHaveBeenCalledTimes(1)
      expect(failClose).toBeTypeOf('function')

      failClose(new Error('close failed'))
      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Error closing client'),
          expect.objectContaining({ message: 'close failed' })
        )
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a Stop is logged as a Stop at debug level, not as an execution error', async () => {
    mocks.targetExecute.mockImplementation(sdkShapedExecute('hang'))
    const wrapped = await loadWrapped(httpGateway())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const controller = new AbortController()
      const call = wrapped.execute({ value: 'x' }, { abortSignal: controller.signal })
      await vi.waitFor(() => expect(mocks.targetExecute).toHaveBeenCalled())
      controller.abort(new Error('stopped'))
      await expect(call).rejects.toThrow('Request was aborted')

      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Error executing'),
        expect.anything()
      )
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Stopped remote_write'))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a failed call that was not stopped is still logged as an error', async () => {
    mocks.targetExecute.mockRejectedValue(new Error('server said no'))
    const wrapped = await loadWrapped(httpGateway())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(wrapped.execute({ value: 'x' }, { abortSignal: new AbortController().signal })).rejects.toThrow(
        'server said no'
      )
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error executing'),
        expect.objectContaining({ message: 'server said no' })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

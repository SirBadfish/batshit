import { beforeEach, describe, expect, it, vi } from 'vitest'

// BL-454: a Stop reaches the gateway wrapper's MCP call, closes this call's client, and
// leaves no listener on the reply's signal once the call ends. The fake target tool
// behaves like `@ai-sdk/mcp`'s own execute: it throws on an aborted signal, rejects when the
// signal aborts mid-call, and removes its listener when the call settles.

const mocks = vi.hoisted(() => ({
  list: vi.fn(), issueCut: vi.fn(), transportConstructed: vi.fn(), realTransport: false,
  get: vi.fn(), httpExecute: vi.fn(), httpClose: vi.fn(), httpSettlement: vi.fn(), transportClose: vi.fn(),
  discoverTools: vi.fn(),
  createClient: vi.fn(),
  createMCPClient: vi.fn(),
  httpDiscoverTools: vi.fn(),
  targetExecute: vi.fn(),
  closeClient: vi.fn()
}))

vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: mocks.createMCPClient }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>()
  return {
    StreamableHTTPClientTransport: function FakeStreamableHTTPClientTransport(url: URL, options?: ConstructorParameters<typeof actual.StreamableHTTPClientTransport>[1]) {
      mocks.transportConstructed(url, options)
      if (mocks.realTransport) return new actual.StreamableHTTPClientTransport(url, options)
      return { url, options, close: () => mocks.transportClose() }
    }
} })
vi.mock('../mcpGatewayService', () => ({ mcpGatewayService: { list: mocks.list, get: mocks.get, readMcpHttpIssueCut: mocks.issueCut } }))
vi.mock('../stdioMCPGatewayClient', () => ({
  stdioMCPGatewayClient: { discoverTools: mocks.discoverTools, createClient: mocks.createClient }
}))
vi.mock('../dockerMCPGatewayClient', () => ({ dockerMCPGatewayClient: { discoverTools: vi.fn() } }))
// A `custom` HTTP gateway is discovered through the n8n MCP client and executed by the wrapper.
vi.mock('../n8nMCPGatewayClient', () => ({
  n8nMCPGatewayClient: { discoverTools: mocks.httpDiscoverTools, executeForHeldApi: mocks.httpExecute, closeForHeldApi: mocks.httpClose, readHeldApiSettlement: mocks.httpSettlement }
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
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: {
  retrieve: vi.fn(),
  readReferenceState: vi.fn(async () => ({ key: 'api_keys:josh:synthetic-saved-http-ref', raw: 'synthetic-reference-v1', present: true, shapeValid: true })),
  withConfiguredValue: vi.fn(async (_name: string, _user: string, consume: (source: { key: string; raw: string; state: 'readable'; value: string }) => Promise<unknown>) => consume({ key: 'api_keys:josh:synthetic-saved-http-ref', raw: 'synthetic-reference-v1', state: 'readable', value: 'synthetic-http-key' }))
} }))
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

async function resetGatewayMocks() {
    vi.clearAllMocks()
    mocks.get.mockReset().mockResolvedValue(null)
    mocks.issueCut.mockReset(); mocks.realTransport = false
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    vi.mocked(apiKeyService.readReferenceState).mockReset().mockResolvedValue({ key: 'api_keys:josh:synthetic-saved-http-ref', raw: 'synthetic-reference-v1', present: true, shapeValid: true })
    vi.mocked(apiKeyService.withConfiguredValue).mockReset().mockImplementation(async (_name, _user, consume) => consume({ key: 'api_keys:josh:synthetic-saved-http-ref', raw: 'synthetic-reference-v1', state: 'readable', value: 'synthetic-http-key' }))
    mocks.httpExecute.mockReset(); mocks.httpClose.mockReset(); mocks.httpSettlement.mockReset()
    mocks.transportClose.mockReset().mockResolvedValue(undefined)
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
}

describe('gateway wrapper Stop (BL-454)', () => {
  beforeEach(resetGatewayMocks)

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


// This extends the EXISTING actual-owner fixture. HTTP/Redis observations stay
// model-free fakes; actual API/original/policy/schema/client owners are not certificates.
function heldHttpCut(gateway: Record<string, unknown>, actor: Record<string, unknown>, keyRaw: string) {
  const raw = (object: Record<string, unknown>, field: string) => Object.hasOwn(object, field) ? JSON.stringify([object[field]]) : '[]'
  const source = ['id','slug','name','type','created_at','enabled','url','authKeyName','metadata.authToken','stdioConfig','toolGroupings']
  return { gateway: { ...gateway }, actor: { ...actor }, keyRaw,
    sourceRaw: JSON.stringify(source.map(field => raw(gateway, field))),
    actorIdentityRaw: JSON.stringify(['id','user_id','agentType','created_at'].map(field => raw(actor, field))) }
}
describe('held API HTTP source/client owner', () => {
  beforeEach(resetGatewayMocks)
  async function apiContext(gateways: string[]) {
    const owner = await import('../appActions/mcp/originalTask')
    const turns = await import('../streamAbortRegistry')
    const controller = new AbortController(), sessionId = 'held-http-api-session'
    const identity = { userId: 'josh', agentId: 'agent-1', sessionId }
    const lookup = owner.captureP5OriginalLookup({ ...identity, signal: controller.signal })!
    const turn = turns.registerSessionTurn(sessionId, 'single', 'held-http-reply')
    if (!turn.ok) throw new Error('owned API turn unavailable')
    const preparation = owner.prepareP5OriginalTask(lookup, { ...identity,
      session: { id: sessionId, user_id: identity.userId }, agent: { id: identity.agentId, user_id: identity.userId }, turn: turn.entry })!
    owner.recordP5ResolvedApiScope(preparation, { gateways, tools: [], authority: { humanSelection: true } })
    const part = owner.bindP5ApiReplyPart(preparation, { replyId: 'held-http-reply', version: 0 })!
    const run = owner.associateP5ApiOriginalRun(preparation, part, { ...identity, replyId: 'held-http-reply', signal: controller.signal })!
    owner.recordP5ApiManagementIntent(run) // restrictive passage, not save/verified readiness
    return { owner, controller, run, preparation, async close() {
      await owner.sealP5OriginalPreparation(preparation); owner.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(sessionId, turn.entry.turnId)
    } }
  }

  it('refuses a genuine empty original before key/client/effect issue', async () => {
    const ctx = await apiContext([])
    try {
      const wrapped = await loadWrapped(httpGateway())
      await expect(wrapped.execute({ value: 'x' }, { p5ApiRun: ctx.run, abortSignal: ctx.controller.signal })).rejects.toThrow()
      expect(mocks.createMCPClient).not.toHaveBeenCalled(); expect(mocks.httpExecute).not.toHaveBeenCalled()
      expect(mocks.targetExecute).not.toHaveBeenCalled()
    } finally { await ctx.close() }
  })

  it('never turns missing/failed saved-reference resolution into unauthenticated HTTP issue', async () => {
    const ctx = await apiContext(['gw-http'])
    const source = { ...httpGateway(), created_at: 'synthetic-http-source', authKeyName: 'synthetic-saved-http-ref' }
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    try {
      mocks.get.mockResolvedValue(source)
      vi.mocked(apiKeyService.retrieve).mockRejectedValueOnce(new Error('synthetic key store unavailable'))
      const wrapped = await loadWrapped(source)
      vi.mocked(apiKeyService.retrieve).mockRejectedValue(new Error('synthetic key store unavailable'))
      vi.mocked(apiKeyService.withConfiguredValue).mockRejectedValue(new Error('synthetic key store unavailable'))
      await expect(wrapped.execute({ value: 'x' }, { p5ApiRun: ctx.run, abortSignal: ctx.controller.signal })).rejects.toThrow('synthetic key store unavailable')
      expect(mocks.createMCPClient).not.toHaveBeenCalled(); expect(mocks.httpExecute).not.toHaveBeenCalled()
    } finally { vi.mocked(apiKeyService.retrieve).mockReset(); await ctx.close() }
  })

  it.each([true, false])('uses the actual already-A HTTP implementation independently of setup management permission(%s), retaining actual delayed-close facts', async managementAllowed => {
    const ctx = await apiContext(['gw-http'])
    const { redis } = await import('$lib/server/redis')
    const { defaultAppActionsPolicy } = await import('$lib/appActions/settings/managementContract')
    const policy = defaultAppActionsPolicy(); policy.enabled = managementAllowed; policy.management.mcpManagement = managementAllowed ? 'allow' : 'block'
    const row: Record<string, unknown> = { id: 'agent-1', user_id: 'josh', agentType: 'api', created_at: 'synthetic-http-actor', dcmDisplaySettings: { groups: {}, tools: {} }, app_action_policy: { generation: 1, policy } }
    // Real authority parser/fences, with this owner's bounded SDK-shaped raw Redis answer.
    const originalExecute = vi.isMockFunction(redis.execute) ? vi.mocked(redis.execute).getMockImplementation() : redis.execute
    if (!originalExecute) throw new Error('The existing Redis fixture client is unavailable.')
    const execute = vi.spyOn(redis, 'execute')
    execute.mockImplementation(read => Reflect.apply(originalExecute, redis, [async (client: Parameters<Parameters<typeof redis.execute>[0]>[0]) => {
      const actual = new Proxy(client, { get(target, key) {
        if (key === 'eval') return async (_script: unknown, options: { keys: string[]; arguments: string[] }) => {
          if (options.keys[0] !== 'agent:agent-1') throw new Error('No other Redis read is admitted by this source fixture.')
          const paths = JSON.parse(options.arguments[0]) as string[]
          return ['OK', ...paths.map(path => JSON.stringify([row[path.slice(2)]]))]
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      return read(actual)
    }]))
    const originalGet = vi.isMockFunction(redis.get) ? vi.mocked(redis.get).getMockImplementation() : redis.get
    if (!originalGet) throw new Error('The existing Redis read fixture is unavailable.')
    const get = vi.spyOn(redis, 'get')
    get.mockImplementation(key => key === 'agent:agent-1' ? Promise.resolve(row) : Reflect.apply(originalGet, redis, [key]))
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    const source = { ...httpGateway(), created_at: 'synthetic-http-source', authKeyName: 'synthetic-saved-http-ref' }
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }
    let releaseClose!: () => void
    const closeHeld = new Promise<void>(resolve => { releaseClose = resolve })
    let admission: unknown
    const actual = new (await vi.importActual<typeof import('../n8nMCPGatewayClient')>('../n8nMCPGatewayClient')).N8nMCPGatewayClient()
    try {
      mocks.get.mockResolvedValue(source); mocks.issueCut.mockImplementation(async () => heldHttpCut(source, row, 'synthetic-reference-v1')); vi.mocked(apiKeyService.retrieve).mockResolvedValue('synthetic-http-key')
      mocks.httpDiscoverTools.mockResolvedValue([{ ...TOOL_DEF, inputSchema: { jsonSchema: schema } }])
      mocks.closeClient.mockImplementation(() => closeHeld)
      mocks.targetExecute.mockImplementation(sdkShapedExecute('resolve'))
      mocks.createMCPClient.mockResolvedValue({ tools: vi.fn(async () => ({ remote_write: { inputSchema: { jsonSchema: schema }, execute: mocks.targetExecute } })), close: mocks.closeClient })
      mocks.httpExecute.mockImplementation(value => { admission = value; return actual.executeForHeldApi(value) })
      mocks.httpClose.mockImplementation(value => actual.closeForHeldApi(value))
      mocks.httpSettlement.mockImplementation(value => actual.readHeldApiSettlement(value))
      const wrapped = await loadWrapped(source)
      await expect(wrapped.execute({ value: 'x' }, { p5ApiRun: ctx.run, abortSignal: ctx.controller.signal })).resolves.toBe('done')
      expect(mocks.targetExecute).toHaveBeenCalledExactlyOnceWith({ value: 'x' }, { abortSignal: ctx.controller.signal })
      expect(mocks.closeClient).toHaveBeenCalledOnce()
      expect(Reflect.apply(actual.readHeldApiSettlement, actual, [admission])).toMatchObject({ initialize: 'known', list: 'known', execute: 'known', close: 'pending' })
      releaseClose()
      await vi.waitFor(() => expect(Reflect.apply(actual.readHeldApiSettlement, actual, [admission]).close).toBe('known'))
      // Original-A use/close is not a verified-C/intended-subject continuation certificate.
      await expect(ctx.owner.takeP5ApiVerifiedContinuation(ctx.preparation)).resolves.toBeUndefined()
      if (!managementAllowed) {
        const { admitSettingsManagementActor } = await import('../appActions/settings/managementActor')
        await expect(admitSettingsManagementActor({ userId: 'josh', agentId: 'agent-1', sessionId: 'held-http-api-session', messageId: 'held-http-reply',
          actorType: 'in-process', p5ApiRun: ctx.run, abortSignal: ctx.controller.signal }, 'native')).rejects.toThrow()
      }
    } finally {
      releaseClose(); if (admission) await Reflect.apply(actual.closeForHeldApi, actual, [admission])
      get.mockRestore(); execute.mockRestore(); vi.mocked(apiKeyService.retrieve).mockReset(); await ctx.close()
    }
  })

  it('the actual HTTP owner rejects fabricated admission before any constructor', async () => {
    const actual = new (await vi.importActual<typeof import('../n8nMCPGatewayClient')>('../n8nMCPGatewayClient')).N8nMCPGatewayClient()
    await expect(Reflect.apply(actual.executeForHeldApi, actual, [Object.freeze({ ready: true, url: 'https://fake.invalid/mcp' })])).rejects.toThrow()
    expect(mocks.createMCPClient).not.toHaveBeenCalled()
  })

  it('retains real run authority and fixed physical ownership across the admission module boundary', async () => {
    const admission = Object.freeze({})
    const forgedAuthority = vi.fn(() => ({ userId: 'josh', signal: new AbortController().signal }))
    const forgedFacts = vi.fn(() => ({ constructor: 'started', requests: 'known', initialize: 'known', list: 'known', execute: 'known', close: 'known' }))
    const retain = Reflect.get(mcpGatewayDiscovery, 'retainP5McpClient')
    const held = { kind: 'use', run: Object.freeze({ ready: true }), owner: { readP5ApiMcpAuthority: forgedAuthority },
      userId: 'josh', gatewayId: 'gw-http', source: 'forged source', keyName: null, actorIdentityRaw: 'forged actor',
      url: 'https://fake.invalid/mcp', headers: {}, toolName: 'remote_write', displayName: 'remote_write', groupName: 'Ungrouped Tools',
      expectedSchema: TOOL_DEF.inputSchema, arguments: { value: 'x' }, client: { readHeldApiSettlement: forgedFacts } }
    // A DTO cannot borrow the issuer's physical owners, even through reflection.
    expect(() => Reflect.apply(retain, {}, [admission, held])).toThrow()
    // TypeScript protection is not authority. A retained unowned run still has
    // to pass the actual originalTask WeakMap, never this supplied owner object.
    Reflect.apply(retain, mcpGatewayDiscovery, [admission, held])
    const actual = new (await vi.importActual<typeof import('../n8nMCPGatewayClient')>('../n8nMCPGatewayClient')).N8nMCPGatewayClient()
    mocks.httpSettlement.mockImplementation(value => actual.readHeldApiSettlement(value))
    await expect(Reflect.apply(actual.executeForHeldApi, actual, [admission])).rejects.toMatchObject({ code: 'P5_ORIGINAL_BOOT_READ_REFUSED' })
    expect(forgedAuthority).not.toHaveBeenCalled()
    expect(mocks.createMCPClient).not.toHaveBeenCalled()
    mocks.httpSettlement.mockClear()
    const owner = await import('../mcpGatewayAdmission')
    expect(() => owner.notifyP5McpClientSettlement(admission as Parameters<typeof owner.notifyP5McpClientSettlement>[0])).toThrow()
    expect(mocks.httpSettlement).toHaveBeenCalledExactlyOnceWith(admission)
    expect(forgedFacts).not.toHaveBeenCalled()
  })

  it.each((['before-constructor', 'before-execute'] as const).flatMap(boundary =>
    (['disable', 'url', 'encrypted-reference', 'dcm-hide', 'stop'] as const).map(mutation => [boundary, mutation] as const)
  ))('rejects %s %s at the actual HTTP issue owner', async (boundary, mutation) => {
      await resetGatewayMocks()
      const ctx = await apiContext(['gw-http'])
      const source = { ...httpGateway(), created_at: 'synthetic-http-source', authKeyName: 'synthetic-saved-http-ref' }
      const actor = { id: 'agent-1', user_id: 'josh', agentType: 'api', created_at: 'synthetic-http-actor', dcmDisplaySettings: { groups: {}, tools: {} } }
      let keyRaw = 'synthetic-reference-v1', reads = 0
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }
      const actual = new (await vi.importActual<typeof import('../n8nMCPGatewayClient')>('../n8nMCPGatewayClient')).N8nMCPGatewayClient()
      let admission: unknown
      try {
        mocks.get.mockResolvedValue(source)
        mocks.issueCut.mockImplementation(async () => {
          if (++reads === 2 && boundary === 'before-constructor') { enter(); await gate }
          return heldHttpCut(source, actor, keyRaw)
        })
        mocks.httpDiscoverTools.mockResolvedValue([{ ...TOOL_DEF, inputSchema: { jsonSchema: schema } }])
        const actualSchema = { get jsonSchema() { if (boundary === 'before-execute') { enter(); return gate.then(() => schema) } return schema } }
        mocks.createMCPClient.mockResolvedValue({ tools: vi.fn(async () => ({ remote_write: { inputSchema: actualSchema, execute: mocks.targetExecute } })), close: mocks.closeClient })
        mocks.httpExecute.mockImplementation(value => { admission = value; return actual.executeForHeldApi(value) })
        mocks.httpClose.mockImplementation(value => actual.closeForHeldApi(value))
        mocks.httpSettlement.mockImplementation(value => actual.readHeldApiSettlement(value))
        const wrapped = await loadWrapped(source)
        const call = wrapped.execute({ value: 'x' }, { p5ApiRun: ctx.run, abortSignal: ctx.controller.signal })
        const rejected = expect(call).rejects.toThrow()
        await entered
        if (mutation === 'disable') source.enabled = false
        else if (mutation === 'url') source.url = 'https://changed.example.test/mcp'
        else if (mutation === 'encrypted-reference') keyRaw = 'synthetic-reference-v2-same-plaintext'
        else if (mutation === 'dcm-hide') Object.assign(actor.dcmDisplaySettings.groups, { 'gw-http::Ungrouped Tools': 'hidden' })
        else ctx.controller.abort(new Error('actual original Stop'))
        release(); await rejected
        expect(mocks.targetExecute).not.toHaveBeenCalled()
        expect(mocks.transportConstructed).toHaveBeenCalledTimes(boundary === 'before-constructor' ? 0 : 1)
        const facts = admission && Reflect.apply(actual.readHeldApiSettlement, actual, [admission])
        if (boundary === 'before-constructor') expect(facts).toMatchObject({ constructor: 'not_started', requests: 'not_started', initialize: 'not_started', execute: 'not_started' })
        else expect(facts).toMatchObject({ constructor: 'started', initialize: 'known', list: 'known', execute: 'not_started' })
        if (mutation === 'stop') await expect(ctx.owner.takeP5ApiVerifiedContinuation(ctx.preparation)).rejects.toThrow()
        else await expect(ctx.owner.takeP5ApiVerifiedContinuation(ctx.preparation)).resolves.toBeUndefined()
      } finally {
        release(); if (admission) await Reflect.apply(actual.closeForHeldApi, actual, [admission])
        await ctx.close()
      }
  })

  it.each(['source','close'] as const)('rechecks final %s after actual SDK transport/header await before any network fetch', async mutation => {
    const ctx = await apiContext(['gw-http'])
    const source = { ...httpGateway(), created_at: 'synthetic-http-source', authKeyName: 'synthetic-saved-http-ref' }
    const actor = { id: 'agent-1', user_id: 'josh', agentType: 'api', created_at: 'synthetic-http-actor', dcmDisplaySettings: { groups: {}, tools: {} } }
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }
    const sdk = await vi.importActual<typeof import('@ai-sdk/mcp')>('@ai-sdk/mcp')
    const actual = new (await vi.importActual<typeof import('../n8nMCPGatewayClient')>('../n8nMCPGatewayClient')).N8nMCPGatewayClient()
    let enter!: () => void, release!: () => void, admission: unknown
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network request is admitted by this fixture.'))
    try {
      mocks.realTransport = true
      mocks.get.mockResolvedValue(source); mocks.issueCut.mockImplementation(async () => heldHttpCut(source, actor, 'synthetic-reference-v1'))
      mocks.httpDiscoverTools.mockResolvedValue([{ ...TOOL_DEF, inputSchema: { jsonSchema: schema } }])
      mocks.createMCPClient.mockImplementation(({ transport }) => {
        const headers = Reflect.get(transport, '_commonHeaders')
        if (typeof headers !== 'function') throw new Error('The pinned actual SDK header owner changed.')
        Reflect.set(transport, '_commonHeaders', async () => { const value = await Reflect.apply(headers, transport, []); enter(); await gate; return value })
        return sdk.createMCPClient({ transport })
      })
      mocks.httpExecute.mockImplementation(value => { admission = value; return actual.executeForHeldApi(value) })
      mocks.httpClose.mockImplementation(value => actual.closeForHeldApi(value))
      mocks.httpSettlement.mockImplementation(value => actual.readHeldApiSettlement(value))
      const wrapped = await loadWrapped(source)
      const call = wrapped.execute({ value: 'x' }, { p5ApiRun: ctx.run, abortSignal: ctx.controller.signal })
      const rejected = expect(call).rejects.toThrow()
      await entered
      expect(mocks.transportConstructed).toHaveBeenCalledOnce()
      if (mutation === 'source') source.url = 'https://changed-after-headers.example.test/mcp'
      else void Reflect.apply(actual.closeForHeldApi, actual, [admission])
      release(); await rejected
      expect(network).not.toHaveBeenCalled()
      expect(mocks.targetExecute).not.toHaveBeenCalled()
      await Reflect.apply(actual.closeForHeldApi, actual, [admission])
      expect(Reflect.apply(actual.readHeldApiSettlement, actual, [admission])).toMatchObject({ constructor: 'started', requests: 'not_started', initialize: 'unknown', list: 'not_started', execute: 'not_started', close: 'known' })
    } finally {
      release(); if (admission) await Reflect.apply(actual.closeForHeldApi, actual, [admission])
      mocks.realTransport = false; network.mockRestore(); await ctx.close()
    }
  })

  it.each(['success', 'throw', 'reject'] as const)('keeps captured HTTP arguments and settlement without exposing a global receiver (%s)', async outcome => {
    const ctx = await apiContext(['gw-http'])
    const source = { ...httpGateway(), created_at: 'synthetic-http-source', authKeyName: 'synthetic-saved-http-ref' }
    const actor = { id: 'agent-1', user_id: 'josh', agentType: 'api', created_at: 'synthetic-http-actor', dcmDisplaySettings: { groups: {}, tools: {} } }
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }
    const actual = new (await vi.importActual<typeof import('../n8nMCPGatewayClient')>('../n8nMCPGatewayClient')).N8nMCPGatewayClient()
    const input = new Request('https://fake.invalid/mcp', { method: 'POST' })
    const init: RequestInit = { method: 'POST', headers: { 'x-synthetic-fixture': 'exact-input' } }
    let admission: unknown, enter!: () => void, release!: (response: Response) => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const physical = new Promise<Response>(resolve => { release = resolve })
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(function (this: unknown, actualInput, actualInit) {
      expect(this).toBeUndefined()
      expect(actualInput).toBe(input)
      expect(actualInit).toBe(init)
      enter()
      if (outcome === 'throw') throw new Error('Synthetic physical throw')
      if (outcome === 'reject') return Promise.reject(new Error('Synthetic physical rejection'))
      return physical
    })
    try {
      mocks.get.mockResolvedValue(source); mocks.issueCut.mockImplementation(async () => heldHttpCut(source, actor, 'synthetic-reference-v1'))
      mocks.httpDiscoverTools.mockResolvedValue([{ ...TOOL_DEF, inputSchema: { jsonSchema: schema } }])
      mocks.targetExecute.mockImplementation(async () => {
        const options = mocks.transportConstructed.mock.lastCall?.[1]
        expect(options?.fetch).toBeTypeOf('function')
        await options.fetch(input, init)
        return 'done'
      })
      mocks.createMCPClient.mockResolvedValue({ tools: vi.fn(async () => ({ remote_write: { inputSchema: { jsonSchema: schema }, execute: mocks.targetExecute } })), close: mocks.closeClient })
      mocks.httpExecute.mockImplementation(value => { admission = value; return actual.executeForHeldApi(value) })
      mocks.httpClose.mockImplementation(value => actual.closeForHeldApi(value))
      mocks.httpSettlement.mockImplementation(value => actual.readHeldApiSettlement(value))
      const wrapped = await loadWrapped(source)
      const call = wrapped.execute({ value: 'x' }, { p5ApiRun: ctx.run, abortSignal: ctx.controller.signal })
      const checked = outcome === 'success' ? expect(call).resolves.toBe('done') : expect(call).rejects.toThrow('Synthetic physical')
      await entered
      if (outcome === 'success') {
        expect(Reflect.apply(actual.readHeldApiSettlement, actual, [admission]).requests).toBe('pending')
        release(new Response(null, { status: 200 }))
      }
      await checked
      expect(network).toHaveBeenCalledOnce()
      await Reflect.apply(actual.closeForHeldApi, actual, [admission])
      expect(Reflect.apply(actual.readHeldApiSettlement, actual, [admission])).toMatchObject({ requests: outcome === 'success' ? 'known' : 'unknown', close: 'known' })
    } finally {
      release(new Response(null, { status: 200 }))
      if (admission) await Reflect.apply(actual.closeForHeldApi, actual, [admission])
      network.mockRestore(); await ctx.close()
    }
  })


  it.each([false, true])('joins cached OldGroup to the current first raw cut before issue (moved to hidden NewGroup=%s)', async moved => {
    const ctx = await apiContext(['gw-http'])
    const cached = { ...httpGateway(), created_at: 'synthetic-group-source', authKeyName: 'synthetic-saved-http-ref', toolGroupings: [{ mcpName: 'OldGroup', toolIds: ['remote_write'] }] }
    const source = structuredClone(cached)
    const actor = { id: 'agent-1', user_id: 'josh', agentType: 'api', created_at: 'synthetic-http-actor',
      dcmDisplaySettings: { groups: { 'gw-http::OldGroup': 'group+tools+hints', 'gw-http::NewGroup': 'hidden' }, tools: {} } }
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    const actual = new (await vi.importActual<typeof import('../n8nMCPGatewayClient')>('../n8nMCPGatewayClient')).N8nMCPGatewayClient()
    let admission: unknown
    try {
      mocks.get.mockResolvedValue(source)
      mocks.issueCut.mockImplementation(async () => heldHttpCut(source, actor, 'synthetic-reference-v1'))
      vi.mocked(apiKeyService.withConfiguredValue).mockImplementation(async (_name, _user, consume) => {
        // The cached wrapper was created from OldGroup. This actual configured
        // key await is before the FIRST joined raw admission, not a later retry.
        if (moved) source.toolGroupings = [{ mcpName: 'NewGroup', toolIds: ['remote_write'] }]
        return consume({ key: 'api_keys:josh:synthetic-saved-http-ref', raw: 'synthetic-reference-v1', state: 'readable', value: 'synthetic-http-key' })
      })
      mocks.httpDiscoverTools.mockResolvedValue([{ ...TOOL_DEF, inputSchema: { jsonSchema: schema } }])
      mocks.targetExecute.mockImplementation(sdkShapedExecute('resolve'))
      mocks.createMCPClient.mockResolvedValue({ tools: vi.fn(async () => ({ remote_write: { inputSchema: { jsonSchema: schema }, execute: mocks.targetExecute } })), close: mocks.closeClient })
      mocks.httpExecute.mockImplementation(value => { admission = value; return actual.executeForHeldApi(value) })
      mocks.httpClose.mockImplementation(value => actual.closeForHeldApi(value))
      mocks.httpSettlement.mockImplementation(value => actual.readHeldApiSettlement(value))
      const wrapped = await loadWrapped(cached)
      const call = wrapped.execute({ value: 'x' }, { p5ApiRun: ctx.run, abortSignal: ctx.controller.signal })
      if (moved) {
        await expect(call).rejects.toThrow('group changed')
        expect(mocks.issueCut).toHaveBeenCalledOnce()
        expect(mocks.transportConstructed).not.toHaveBeenCalled()
        expect(mocks.createMCPClient).not.toHaveBeenCalled()
        expect(mocks.targetExecute).not.toHaveBeenCalled()
      } else {
        await expect(call).resolves.toBe('done')
        expect(mocks.transportConstructed).toHaveBeenCalledOnce()
        expect(mocks.targetExecute).toHaveBeenCalledExactlyOnceWith({ value: 'x' }, { abortSignal: ctx.controller.signal })
      }
      expect(ctx.owner.p5ApiPreparedScope(ctx.preparation)?.gateways).toEqual(['gw-http'])
      await expect(ctx.owner.takeP5ApiVerifiedContinuation(ctx.preparation)).resolves.toBeUndefined()
    } finally {
      if (admission) await Reflect.apply(actual.closeForHeldApi, actual, [admission])
      await ctx.close()
    }
  })

})

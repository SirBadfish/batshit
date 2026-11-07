import { beforeEach, describe, expect, it, vi } from 'vitest'

// BL-454: the reply's Stop reaches an MCP gateway tool call through Batshit Tool Use, on the
// API lane (the SDK's `abortSignal`) and on the helper dispatch (the running reply's Stop),
// the same way the `cli` family already forwarded it.

const mocks = vi.hoisted(() => ({
  gatewayExecute: vi.fn(),
  loadToolsForUser: vi.fn(),
  resolveDynamicMcpGatewayScope: vi.fn()
}))

const redisMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getSession: vi.fn()
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$env/dynamic/public', () => ({ env: {} }))
vi.mock('$lib/server/redis', () => ({
  redis: {
    get: redisMocks.get,
    getSession: redisMocks.getSession,
    getUserSettings: vi.fn(async () => null),
    execute: vi.fn(async () => []),
    json: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') }
  }
}))
// `useControl` syncs artifact-backed controls; this user has none.
vi.mock('$lib/server/artifacts/artifactsService', () => ({
  ArtifactsService: vi.fn(function FakeArtifactsService(this: Record<string, unknown>) {
    Object.assign(this, { listByUser: vi.fn(async () => []) })
  })
}))
vi.mock('../mcpGatewayDiscovery', async (importOriginal) => ({
  // Preserve the real in-process original-observation owner/opaque handles. Only the actual
  // discovery/client boundary is a stand-in; this suite never opens a native/HTTP transport.
  ...(await importOriginal<typeof import('../mcpGatewayDiscovery')>()),
  mcpGatewayDiscovery: { loadToolsForUser: mocks.loadToolsForUser }
}))
vi.mock('../mcpSelectionResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcpSelectionResolver')>()),
  resolveDynamicMcpGatewayScope: mocks.resolveDynamicMcpGatewayScope
}))

import { nativeToolService } from '../nativeTools'

const nativeSettings = {
  dynamicMcpEnabled: true,
  cliToolsEnabled: false,
  artifactRuntimeEnabled: false,
  batshitToolsEnabled: false,
  fetchZipEnabled: false,
  agentBrowserEnabled: false,
  webSearchEnabled: false,
  bashEnabled: false
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.gatewayExecute.mockResolvedValue({ ok: true })
    mocks.resolveDynamicMcpGatewayScope.mockResolvedValue({
      resolvedGateways: ['gw-1'],
      defaultGateways: null,
      source: 'selected'
    })
    mocks.loadToolsForUser.mockResolvedValue({
      tools: { remote_write: { description: 'Writes remotely', execute: mocks.gatewayExecute } },
      metadata: new Map([
        [
          'remote_write',
          {
            gatewayId: 'gw-1',
            gatewayName: 'Remote',
            mcpServerName: 'Remote',
            originalToolName: 'remote_write'
          }
        ]
      ])
    })
    redisMocks.getSession.mockResolvedValue(null)
  })

describe('MCP gateway Stop signal forwarding (BL-454)', () => {
  it('hands the API broker run signal to the gateway tool, apart from the model input', async () => {
    const controller = new AbortController()
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      selectedGateways: ['gw-1'],
      providerSettings: { nativeTools: nativeSettings }
    } as any)

    const result = await (tools as any).native_batshit_tool_use.execute(
      { ref: 'mcp:remote_write', input: { value: 'from-model' } },
      { abortSignal: controller.signal }
    )

    expect(result.success).toBe(true)
    expect(mocks.gatewayExecute).toHaveBeenCalledTimes(1)
    expect(mocks.gatewayExecute).toHaveBeenCalledWith(
      { value: 'from-model' },
      { abortSignal: controller.signal }
    )
  })

  it('hands the helper dispatch reply signal to the gateway tool', async () => {
    const controller = new AbortController()
    redisMocks.get.mockResolvedValue({
      user_id: 'user-1',
      provider_specific_settings: { nativeTools: nativeSettings }
    })

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'batshit_tool_use',
      payloadInput: { ref: 'mcp:remote_write', input: { value: 'from-helper' } },
      context: {
        session_id: 'session-1',
        agent_id: 'agent-1',
        mode: 'mode4',
        actor_type: 'primary'
      },
      projectPath: '/tmp',
      actorType: 'in-process',
      abortSignal: controller.signal
    } as any)

    expect(result).toMatchObject({ success: true })
    expect(mocks.gatewayExecute).toHaveBeenCalledWith(
      { value: 'from-helper' },
      { abortSignal: controller.signal }
    )
  })

  // Review follow-up: `batshit:sys.mcp.dynamic.use` reaches the same executor through
  // `useControl`; the Stop travels in the server-owned control context, never in the body.
  const fabricSettings = { ...nativeSettings, batshitToolsEnabled: true }

  it('hands the API broker run signal to the gateway tool through batshit:sys.mcp.dynamic.use', async () => {
    const controller = new AbortController()
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      selectedGateways: ['gw-1'],
      providerSettings: { nativeTools: fabricSettings }
    } as any)

    const result = await (tools as any).native_batshit_tool_use.execute(
      {
        ref: 'batshit:sys.mcp.dynamic.use',
        input: { toolName: 'remote_write', params: { value: 'from-model' } }
      },
      { abortSignal: controller.signal }
    )

    expect(result.success).toBe(true)
    expect(mocks.gatewayExecute).toHaveBeenCalledWith(
      { value: 'from-model' },
      { abortSignal: controller.signal }
    )
  })

  it('hands the helper dispatch reply signal to the gateway tool through batshit:sys.mcp.dynamic.use', async () => {
    const controller = new AbortController()
    redisMocks.get.mockResolvedValue({
      user_id: 'user-1',
      provider_specific_settings: { nativeTools: fabricSettings }
    })

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'batshit_tool_use',
      payloadInput: {
        ref: 'batshit:sys.mcp.dynamic.use',
        input: { toolName: 'remote_write', params: { value: 'from-helper' } }
      },
      context: {
        session_id: 'session-1',
        agent_id: 'agent-1',
        mode: 'mode4',
        actor_type: 'primary'
      },
      projectPath: '/tmp',
      actorType: 'in-process',
      abortSignal: controller.signal
    } as any)

    expect(result).toMatchObject({ success: true })
    expect(mocks.gatewayExecute).toHaveBeenCalledWith(
      { value: 'from-helper' },
      { abortSignal: controller.signal }
    )
  })

  it('a body field cannot set the control context signal', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      selectedGateways: ['gw-1'],
      providerSettings: { nativeTools: fabricSettings }
    } as any)

    await (tools as any).native_batshit_tool_use.execute({
      ref: 'batshit:sys.mcp.dynamic.use',
      input: { toolName: 'remote_write', params: { value: 'x' }, abortSignal: 'from-model' },
      abortSignal: 'from-model'
    })

    expect(mocks.gatewayExecute).toHaveBeenCalledWith({ value: 'x' }, { abortSignal: undefined })
  })
})


describe('genuine private API run and Stop share the actual native/Fabric context', () => {
  it.each(['mcp:remote_write', 'batshit:sys.mcp.dynamic.use'])('forwards the registered run and original signal through %s, never model substitutes', async ref => {
    const original = await import('../appActions/mcp/originalTask')
    const turns = await import('../streamAbortRegistry')
    const identity = { userId: 'user-1', agentId: 'agent-1', sessionId: `private-stop-${ref.startsWith('mcp:') ? 'direct' : 'fabric'}` }
    const stop = new AbortController(), replyId = 'private-stop-reply'
    const registration = turns.registerSessionTurn(identity.sessionId, 'single', replyId)
    if (!registration.ok) throw new Error('Actual API turn unavailable')
    const lookup = original.captureP5OriginalLookup({ ...identity, signal: stop.signal })!
    const preparation = original.prepareP5OriginalTask(lookup, { ...identity, session: { id: identity.sessionId, user_id: identity.userId },
      agent: { id: identity.agentId, user_id: identity.userId, agentType: 'api' }, turn: registration.entry })!
    original.recordP5ResolvedApiScope(preparation, { gateways: ['gw-1'], tools: [], authority: { humanSelection: true } })
    const part = original.bindP5ApiReplyPart(preparation, { replyId, version: 0 })!
    const run = original.associateP5ApiOriginalRun(preparation, part, { ...identity, replyId, signal: stop.signal })!
    try {
      const { tools } = await nativeToolService.buildMode3NativeTools({ ...identity, messageId: replyId, p5ApiRun: run,
        abortSignal: stop.signal, selectedGateways: ['gw-1'], providerSettings: { nativeTools: { ...nativeSettings, batshitToolsEnabled: true } } })
      const input = ref.startsWith('mcp:') ? { value: 'controlled' } : { toolName: 'remote_write', params: { value: 'controlled' }, p5ApiRun: { forged: true } }
      await (tools as any).native_batshit_tool_use.execute({ ref, input, p5ApiRun: { forged: true }, abortSignal: 'model-signal' }, { abortSignal: stop.signal })
      expect(mocks.gatewayExecute).toHaveBeenCalledTimes(1)
      expect(mocks.gatewayExecute).toHaveBeenCalledWith({ value: 'controlled' }, { abortSignal: stop.signal, p5ApiRun: run })
      stop.abort(new Error('Original Stop'))
      const forwarded = mocks.gatewayExecute.mock.calls[0][1]
      expect(forwarded.abortSignal.aborted).toBe(true)
      expect(forwarded.p5ApiRun).toBe(run)
      expect(() => original.readP5ApiMcpAuthority(run, 'gw-1')).toThrow()
      // This is the genuine context/signal join; physical HTTP admission/close is a separate owner.
    } finally {
      await original.sealP5OriginalPreparation(preparation); original.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(identity.sessionId, registration.entry.turnId)
    }
  })
})

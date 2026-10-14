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
vi.mock('../mcpGatewayDiscovery', () => ({
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

describe('MCP gateway Stop signal forwarding (BL-454)', () => {
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
      actorType: 'agent',
      abortSignal: controller.signal
    } as any)

    expect(result).toMatchObject({ success: true })
    expect(mocks.gatewayExecute).toHaveBeenCalledWith(
      { value: 'from-helper' },
      { abortSignal: controller.signal }
    )
  })

  // Review follow-up: `fabric:sys.mcp.dynamic.use` reaches the same executor through
  // `useControl`; the Stop travels in the server-owned control context, never in the body.
  const fabricSettings = { ...nativeSettings, batshitToolsEnabled: true }

  it('hands the API broker run signal to the gateway tool through fabric:sys.mcp.dynamic.use', async () => {
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
        ref: 'fabric:sys.mcp.dynamic.use',
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

  it('hands the helper dispatch reply signal to the gateway tool through fabric:sys.mcp.dynamic.use', async () => {
    const controller = new AbortController()
    redisMocks.get.mockResolvedValue({
      user_id: 'user-1',
      provider_specific_settings: { nativeTools: fabricSettings }
    })

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'batshit_tool_use',
      payloadInput: {
        ref: 'fabric:sys.mcp.dynamic.use',
        input: { toolName: 'remote_write', params: { value: 'from-helper' } }
      },
      context: {
        session_id: 'session-1',
        agent_id: 'agent-1',
        mode: 'mode4',
        actor_type: 'primary'
      },
      projectPath: '/tmp',
      actorType: 'agent',
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
      ref: 'fabric:sys.mcp.dynamic.use',
      input: { toolName: 'remote_write', params: { value: 'x' }, abortSignal: 'from-model' },
      abortSignal: 'from-model'
    })

    expect(mocks.gatewayExecute).toHaveBeenCalledWith({ value: 'x' }, { abortSignal: undefined })
  })
})

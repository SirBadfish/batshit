import { beforeEach, describe, expect, it, vi } from 'vitest'

const cliMocks = vi.hoisted(() => ({
  executeCliTool: vi.fn(),
  findCliTools: vi.fn(),
  getCliTool: vi.fn(),
  resolveCliToolSelectionScope: vi.fn()
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
    json: { get: vi.fn(), set: vi.fn() }
  }
}))
vi.mock('../cliToolRegistry', () => cliMocks)

import { nativeToolService } from '../nativeTools'

const nativeSettings = {
  dynamicMcpEnabled: false,
  cliToolsEnabled: true,
  artifactRuntimeEnabled: false,
  batshitToolsEnabled: false,
  fetchZipEnabled: false,
  agentBrowserEnabled: false,
  webSearchEnabled: false,
  bashEnabled: false
}

describe('saved CLI Stop signal forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cliMocks.executeCliTool.mockResolvedValue({
      success: true,
      toolId: 'saved_cli'
    })
    cliMocks.resolveCliToolSelectionScope.mockResolvedValue({
      toolIds: ['saved_cli']
    })
    redisMocks.getSession.mockResolvedValue(null)
  })

  it('passes the API broker run signal separately from model-controlled CLI arguments', async () => {
    const controller = new AbortController()
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      selectedCliToolIds: ['saved_cli'],
      providerSettings: { nativeTools: nativeSettings }
    } as any)

    const result = await (tools as any).native_batshit_tool_use.execute(
      { ref: 'cli:saved_cli', input: { value: 'from-model' } },
      { abortSignal: controller.signal }
    )

    expect(result.success).toBe(true)
    expect(cliMocks.executeCliTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'saved_cli',
        input: { value: 'from-model' }
      }),
      { abortSignal: controller.signal }
    )
  })

  it('passes the native automation reply signal to a direct CLI action', async () => {
    const controller = new AbortController()
    cliMocks.executeCliTool.mockResolvedValue({
      success: false,
      toolId: 'saved_cli',
      code: 'EXECUTION_FAILED',
      error: 'Process timed out after 1000ms',
      stopped: false,
      timedOut: true
    })
    redisMocks.get.mockResolvedValue({
      user_id: 'user-1',
      provider_specific_settings: { nativeTools: nativeSettings }
    })

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'user-1',
      action: 'cli_tool_use',
      payloadInput: {
        toolId: 'saved_cli',
        input: { value: 'from-helper' },
        selectedToolIds: ['saved_cli']
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
    })

    expect(result).toMatchObject({
      success: true,
      data: { success: false, stopped: false, timedOut: true }
    })
    expect(cliMocks.executeCliTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'saved_cli',
        input: { value: 'from-helper' }
      }),
      { abortSignal: controller.signal }
    )
  })
})

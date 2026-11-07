import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  dispatchNativeAutomationPackAction: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveNativeToolUser
}))

vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: {
    dispatchNativeAutomationPackAction: mocks.dispatchNativeAutomationPackAction
  }
}))

import { POST } from './+server'
import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/native-tools/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('/api/native-tools/dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetStreamAbortRegistryForTests()
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'service',
      projectPath: null
    })
  })

  it('dispatches runtime_addon_prepare through the service-token native automation path', async () => {
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({
      success: true,
      action: 'runtime_addon_prepare',
      backend: 'docker_sandbox',
      context: {
        mode: 'mode2',
        actor_type: 'primary',
        agent_id: 'agent-1'
      },
      data: {
        addon: {
          id: 'fbx2vrma',
          canStartAutomatically: false,
          requiresOperator: true
        }
      }
    })

    const response = await POST({
      request: request({
        userId: 'user-1',
        action: 'runtime_addon_prepare',
        input: {
          addonId: 'fbx2vrma'
        },
        context: {
          session_id: 'session-1',
          agent_id: 'agent-1',
          mode: 'mode2',
          actor_type: 'primary'
        }
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    // SA-139 R2: the body is no longer handed to the auth resolver (only the removed n8n
    // callback lane read it).
    expect(mocks.resolveNativeToolUser).toHaveBeenCalledWith(
      expect.objectContaining({ claimedUserId: 'user-1' })
    )
    expect(mocks.resolveNativeToolUser.mock.calls[0]?.[0]).not.toHaveProperty('payload')
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      action: 'runtime_addon_prepare',
      payloadInput: {
        addonId: 'fbx2vrma'
      },
      context: {
        session_id: 'session-1',
        agent_id: 'agent-1',
        mode: 'mode2',
        actor_type: 'primary'
      },
      projectPath: null
    }))
    await expect(response.json()).resolves.toMatchObject({
      auth: 'service',
      success: true,
      action: 'runtime_addon_prepare',
      data: {
        addon: {
          id: 'fbx2vrma'
        }
      }
    })
  })

  it('sends no trusted gateway ceiling from a service-token caller', async () => {
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true, data: {} })
    await POST({
      request: request({
        action: 'batshit_tool_search', mcpGatewayScope: ['gw_other'],
        context: { session_id: 'session-1', agent_id: 'agent-1', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(
      expect.not.objectContaining({ mcpGatewayScope: expect.anything() })
    )
  })

  it('passes explicit service-token projectPath into native automation dispatch', async () => {
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({
      success: true,
      action: 'bash_execute',
      backend: 'apple_container',
      context: {
        mode: 'mode4',
        actor_type: 'primary',
        agent_id: 'agent-1'
      },
      data: {
        cwd: '/Users/example/batshit',
        workspaceRoot: '/Users/example/batshit'
      }
    })

    const response = await POST({
      request: request({
        userId: 'user-1',
        projectPath: '/Users/example/batshit',
        action: 'bash_execute',
        input: {
          command: 'pwd'
        },
        context: {
          session_id: 'session-1',
          agent_id: 'agent-1',
          mode: 'mode4',
          actor_type: 'primary'
        }
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      action: 'bash_execute',
      payloadInput: {
        command: 'pwd'
      },
      context: {
        session_id: 'session-1',
        agent_id: 'agent-1',
        mode: 'mode4',
        actor_type: 'primary'
      },
      projectPath: '/Users/example/batshit'
    }))
  })

  it('ignores body projectPath for session-authenticated dispatch requests', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'session',
      projectPath: null
    })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({
      success: true,
      action: 'bash_execute',
      backend: 'apple_container',
      context: {
        mode: 'mode4',
        actor_type: 'primary',
        agent_id: 'agent-1'
      },
      data: {
        cwd: '/Users/example/batshit',
        workspaceRoot: '/Users/example/batshit'
      }
    })

    const response = await POST({
      request: request({
        userId: 'user-1',
        projectPath: '/Users/example/batshit',
        action: 'bash_execute',
        input: {
          command: 'pwd'
        },
        context: {
          session_id: 'session-1',
          agent_id: 'agent-1',
          mode: 'mode4',
          actor_type: 'primary'
        }
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: null
      })
    )
  })

  it('dispatches runtime_addon_start through the service-token native automation path', async () => {
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({
      success: true,
      action: 'runtime_addon_start',
      backend: 'docker_sandbox',
      context: {
        mode: 'mode2',
        actor_type: 'primary',
        agent_id: 'agent-1'
      },
      data: {
        addon: {
          success: true,
          addonId: 'fbx2vrma',
          operation: 'start'
        }
      }
    })

    const response = await POST({
      request: request({
        userId: 'user-1',
        action: 'runtime_addon_start',
        input: {
          addon_id: 'fbx2vrma'
        },
        context: {
          session_id: 'session-1',
          agent_id: 'agent-1',
          mode: 'mode2',
          actor_type: 'primary'
        }
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      action: 'runtime_addon_start',
      payloadInput: {
        addon_id: 'fbx2vrma'
      },
      context: {
        session_id: 'session-1',
        agent_id: 'agent-1',
        mode: 'mode2',
        actor_type: 'primary'
      },
      projectPath: null
    }))
    await expect(response.json()).resolves.toMatchObject({
      auth: 'service',
      success: true,
      action: 'runtime_addon_start',
      data: {
        addon: {
          addonId: 'fbx2vrma',
          operation: 'start'
        }
      }
    })
  })

  it('keeps service-token native automation failures on HTTP error status', async () => {
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({
      success: false,
      action: 'batshit_tool_use',
      backend: 'apple_container',
      context: {
        mode: 'mode2',
        actor_type: 'primary',
        agent_id: 'agent-1'
      },
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid Batshit tool ref.'
      }
    })

    const response = await POST({
      request: request({
        userId: 'user-1',
        action: 'batshit_tool_use',
        input: {
          ref: 'mcp:',
          input: {}
        },
        context: {
          session_id: 'session-1',
          agent_id: 'agent-1',
          mode: 'mode2',
          actor_type: 'primary'
        }
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      auth: 'service',
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid Batshit tool ref.'
      }
    })
  })
  it('hands the dispatcher the lane it authenticated on, so the identity gate sees it (PR #106 F-1)', async () => {
    // Before this, `dispatchNativeAutomationPackAction` received no lane at all, `useControl`
    // defaulted to a vouched `'unknown'`, and a service-token caller could act as any agent
    // through `batshit_tool_use` — the exact door `/api/controls/use` had already shut.
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'service' })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    await POST({
      request: request({
        action: 'batshit_tool_use',
        input: { ref: 'fabric:sys.dm.list', input: {} },
        context: { session_id: 's', agent_id: 'agent-cooper', mode: 'mode2', actor_type: 'primary' }
      }),
      locals: {}
    } as any)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'service' })
    )


  })

  it('leaves the context alone on the service lane', async () => {
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    const context = { session_id: 's', agent_id: 'agent-faye', mode: 'mode2', actor_type: 'primary' }
    await POST({
      request: request({ action: 'bash_execute', input: { command: 'echo hi' }, context }),
      locals: {}
    } as any)

    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(
      expect.objectContaining({ context })
    )
  })

  it('hands a signed-in caller the Stop of the reply running in the chat it names', async () => {
    registerStreamAbort('session-signed-in', 'message-3', new AbortController())
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'session' })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    await POST({
      request: request({
        action: 'bash_execute',
        input: { command: 'sleep 30' },
        context: { session_id: 'session-signed-in', agent_id: 'agent-1', mode: 'mode3', actor_type: 'primary' }
      }),
      locals: {}
    } as any)

    const signal = mocks.dispatchNativeAutomationPackAction.mock.calls[0]?.[0]?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    abortStream('session-signed-in', 'user')
    expect(signal.aborted).toBe(true)
  })

  it('hands no Stop when no reply runs in the chat, so a caller with no chat keeps its time limit', async () => {
    registerStreamAbort('another-session', 'message-9', new AbortController())
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    // The service lane, a chat with no reply running.
    await POST({
      request: request({ action: 'bash_execute', input: { command: 'echo hi' }, context: { session_id: 's', agent_id: 'agent-1', mode: 'mode2', actor_type: 'primary' } }),
      locals: {}
    } as any)
    // The session lane, the same.
    mocks.resolveNativeToolUser.mockResolvedValueOnce({ userId: 'user-1', auth: 'session' })
    await POST({
      request: request({ action: 'bash_execute', input: { command: 'echo hi' }, context: { session_id: 'session-idle', agent_id: 'agent-1', mode: 'mode3', actor_type: 'primary' } }),
      locals: {}
    } as any)
    // No context at all (the dispatcher refuses it; no Stop is looked up for it).
    await POST({ request: request({ action: 'bash_execute', input: { command: 'echo hi' } }), locals: {} } as any)

    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledTimes(3)
    for (const [input] of mocks.dispatchNativeAutomationPackAction.mock.calls) {
      expect(input.abortSignal).toBeUndefined()
    }
  })
})

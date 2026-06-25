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
    expect(mocks.resolveNativeToolUser).toHaveBeenCalledWith(
      expect.objectContaining({
        claimedUserId: 'user-1',
        payload: expect.objectContaining({
          action: 'runtime_addon_prepare'
        })
      })
    )
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith({
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
    })
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
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith({
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
    })
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
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith({
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
    })
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

  it('keeps authenticated n8n tool failures as tool data instead of HTTP node errors', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'n8n-callback',
      projectPath: '/Users/example/batshit'
    })
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
        message: 'STDIO gateway requires a project directory.'
      }
    })

    const response = await POST({
      request: request({
        userId: 'user-1',
        action: 'batshit_tool_use',
        input: {
          ref: 'mcp:read_text_file',
          input: {
            path: '/Users/example/batshit/README.md'
          }
        },
        context: {
          session_id: 'session-1',
          message_id: 'message-1',
          agent_id: 'agent-1',
          mode: 'mode2',
          actor_type: 'primary'
        }
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith({
      userId: 'user-1',
      action: 'batshit_tool_use',
      payloadInput: {
        ref: 'mcp:read_text_file',
        input: {
          path: '/Users/example/batshit/README.md'
        }
      },
      context: {
        session_id: 'session-1',
        message_id: 'message-1',
        agent_id: 'agent-1',
        mode: 'mode2',
        actor_type: 'primary'
      },
      projectPath: '/Users/example/batshit'
    })
    await expect(response.json()).resolves.toMatchObject({
      auth: 'n8n-callback',
      success: false,
      action: 'batshit_tool_use',
      error: {
        code: 'INVALID_INPUT',
        message: 'STDIO gateway requires a project directory.'
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
})

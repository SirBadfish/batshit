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
    expect(mocks.resolveNativeToolUser).toHaveBeenCalledWith(
      expect.objectContaining({
        claimedUserId: 'user-1',
        payload: expect.objectContaining({
          action: 'runtime_addon_prepare'
        })
      })
    )
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

  it('passes only the run credential gateway ceiling to the native dispatcher', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'agent-1', sessionId: 'session-1',
      mcpGatewayScope: ['gw_allowed']
    })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true, data: {} })
    const response = await POST({
      request: request({
        action: 'batshit_tool_search', input: { query: 'search', selectedGateways: ['gw_other'] },
        mcpGatewayScope: ['gw_other'],
        context: { session_id: 'session-1', agent_id: 'agent-1', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(200)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(expect.objectContaining({
      mcpGatewayScope: ['gw_allowed'], actorType: 'agent',
      payloadInput: { query: 'search', selectedGateways: ['gw_other'] }
    }))
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
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(expect.objectContaining({
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
    }))
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
  /* ---------------------------------------------------------------------- *
   * SA-117 P2 (DL-117-04) — the dispatch context's agent id.
   * ---------------------------------------------------------------------- */

  const agentLaneAuth = {
    userId: 'user-1',
    auth: 'agent',
    agentId: 'agent-cooper',
    sessionId: 'session-bound',
    credentialId: 'arc_test',
    projectPath: null
  }

  it('binds the governing agent and the session from the run credential', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    await POST({
      request: request({
        action: 'bash_execute',
        input: { command: 'echo hi' },
        // The managed helper stopped sending `agent_id`; the route fills it in.
        context: { session_id: 'session-claimed', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)

    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          session_id: 'session-bound',
          agent_id: 'agent-cooper',
          mode: 'mode4',
          actor_type: 'primary'
        },
        // PR #106 review F-1: the lane travels with the call.
        actorType: 'agent',
        delegatedRun: false
      })
    )
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
      expect.objectContaining({ actorType: 'service', delegatedRun: false })
    )

    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth, delegated: true,
      processOwner: { userId: 'user-1', kind: 'agent', id: 'agent-cooper' },
      commandParentAgentId: 'agent-cooper' })
    await POST({
      request: request({
        action: 'batshit_tool_use',
        input: { ref: 'fabric:sys.dm.list', input: {} },
        context: { session_id: 'session-bound', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorType: 'agent', delegatedRun: true })
    )
  })

  it('forwards only the credential owner and rejects delegated calls without one', async () => {
    const owner = { userId: 'user-1', kind: 'subagent', id: 'stored-subagent' }
    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth,
      agentId: 'subagent_cli_runtime', delegated: true, processOwner: owner,
      commandParentAgentId: 'agent-cooper' })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })
    const body = { action: 'bash_execute', input: { command: 'echo hi' },
      processOwner: { userId: 'user-1', kind: 'agent', id: 'agent-victim' },
      context: { session_id: 'session-bound', mode: 'mode4', actor_type: 'primary' } }
    const accepted = await POST({ request: request(body), locals: {} } as any)
    expect(accepted.status).toBe(200)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(
      expect.objectContaining({ processOwner: owner,
        context: expect.objectContaining({ actor_type: 'subagent', agent_id: owner.id,
          parent_agent_id: 'agent-cooper' }) }))

    mocks.dispatchNativeAutomationPackAction.mockClear()
    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth,
      agentId: 'subagent_cli_runtime', delegated: true })
    const refused = await POST({ request: request(body), locals: {} } as any)
    expect(refused.status).toBe(400)
    expect((await refused.json()).error.code).toBe('INVALID_CONTEXT')
    expect(mocks.dispatchNativeAutomationPackAction).not.toHaveBeenCalled()
  })

  it('refuses a context agent id that differs, and dispatches nothing', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)

    const response = await POST({
      request: request({
        action: 'bash_execute',
        input: { command: 'echo hi' },
        context: {
          session_id: 'session-bound',
          agent_id: 'agent-faye',
          mode: 'mode4',
          actor_type: 'primary'
        }
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('AGENT_MISMATCH')
    expect(mocks.dispatchNativeAutomationPackAction).not.toHaveBeenCalled()
  })

  it('reads the run project path on the agent lane, as it did on the service lane', async () => {
    // The managed CLI helper moved lanes and still sends the run's project path; a route
    // that only recognised `service` would have silently dropped it.
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    await POST({
      request: request({
        action: 'bash_execute',
        input: { command: 'echo hi' },
        projectPath: '/tmp/example-project',
        context: { session_id: 'session-bound', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)

    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/tmp/example-project' })
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

  /**
   * A Stop reaches a command run through the dispatch (2026-09-18, the sweep's second round).
   *
   * The managed CLI helper's `batshit_server_bash_execute` and n8n Workflow Subagents run their
   * commands through this route, and neither request can carry a Stop: SvelteKit aborts
   * `request.signal` only when the caller leaves before the body is read. The route hands the
   * dispatch the Stop of the reply running in the chat, the chat the run credential is bound to
   * on the agent lane (the same binding as the context's `session_id`).
   */
  it('hands the dispatch the Stop of the reply running in the chat the credential is bound to', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    registerStreamAbort('session-claimed', 'message-2', new AbortController())
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    await POST({
      request: request({
        action: 'bash_execute',
        input: { command: 'sleep 30' },
        context: { session_id: 'session-claimed', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)

    const signal = mocks.dispatchNativeAutomationPackAction.mock.calls[0]?.[0]?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    // The chat the body names is not the one the credential is bound to: its Stop does not count.
    abortStream('session-claimed', 'user')
    expect(signal.aborted).toBe(false)
    abortStream('session-bound', 'user')
    expect(signal.aborted).toBe(true)
  })

  it('hands an n8n caller the Stop of the reply running in the chat it names', async () => {
    registerStreamAbort('session-n8n', 'message-3', new AbortController())
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'n8n-callback' })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })

    await POST({
      request: request({
        action: 'bash_execute',
        input: { command: 'sleep 30' },
        context: { session_id: 'session-n8n', agent_id: 'agent-1', mode: 'mode2', actor_type: 'subagent', parent_agent_id: 'agent-1' }
      }),
      locals: {}
    } as any)

    const signal = mocks.dispatchNativeAutomationPackAction.mock.calls[0]?.[0]?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    abortStream('session-n8n', 'user')
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
    // The n8n lane, the same.
    mocks.resolveNativeToolUser.mockResolvedValueOnce({ userId: 'user-1', auth: 'n8n-callback' })
    await POST({
      request: request({ action: 'bash_execute', input: { command: 'echo hi' }, context: { session_id: 'n8n-idle', agent_id: 'agent-1', mode: 'mode2', actor_type: 'primary' } }),
      locals: {}
    } as any)
    // No context at all (the dispatcher refuses it; no Stop is looked up for it).
    await POST({ request: request({ action: 'bash_execute', input: { command: 'echo hi' } }), locals: {} } as any)

    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledTimes(3)
    for (const [input] of mocks.dispatchNativeAutomationPackAction.mock.calls) {
      expect(input.abortSignal).toBeUndefined()
    }
  })

  it('BL-1321: a primary credential hears only its own reply: live exact, retired already aborted', async () => {
    const own = new AbortController()
    registerStreamAbort('session-bound', 'message-1', own)
    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth, messageId: 'message-1' })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })
    const call = () => POST({
      request: request({
        action: 'batshit_tool_use',
        input: { ref: 'mcp:slow_tool', input: {} },
        context: { session_id: 'session-bound', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)

    await call()
    expect(mocks.dispatchNativeAutomationPackAction.mock.calls[0]?.[0]?.abortSignal).toBe(own.signal)

    // A newer reply runs now. The earlier credential's call is retired (BL-1322): it is refused
    // before the dispatcher, and it never hears, or ends, the newer reply's Stop.
    const newer = new AbortController()
    registerStreamAbort('session-bound', 'message-2', newer)
    const response = await call()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ success: false, stopped: true,
      error: { code: 'CONTROL_CANCELLATION_REQUIRED' } })
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledTimes(1)
    expect(newer.signal.aborted).toBe(false)

    // Its own reply running again and then stopped: refused the same way.
    registerStreamAbort('session-bound', 'message-1', own)
    abortStream('session-bound', 'user')
    expect((await call()).status).toBe(403)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledTimes(1)
  })

  it('BL-1322: a primary credential that names no reply keeps the chat lookup, and is refused once that reply has stopped', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })
    const call = () => POST({
      request: request({
        action: 'batshit_tool_use',
        input: { ref: 'cli:repo_snapshot', input: {} },
        context: { session_id: 'session-bound', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)

    expect((await call()).status).toBe(200)
    abortStream('session-bound', 'user')
    const response = await call()
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('CONTROL_CANCELLATION_REQUIRED')
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledTimes(1)
  })

  it('BL-1321/BL-1322: a Subagent or Worker credential keeps its parent’s running reply and is not refused', async () => {
    const parent = new AbortController()
    registerStreamAbort('session-bound', 'message-parent', parent)
    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth, agentId: 'subagent_cli_runtime',
      messageId: 'subagent-helper-run', delegated: true,
      processOwner: { userId: 'user-1', kind: 'subagent', id: 'stored-subagent' }, commandParentAgentId: 'agent-cooper' })
    mocks.dispatchNativeAutomationPackAction.mockResolvedValue({ success: true })
    const call = () => POST({
      request: request({
        action: 'bash_execute',
        input: { command: 'sleep 30' },
        context: { session_id: 'session-bound', mode: 'mode4', actor_type: 'primary' }
      }),
      locals: {}
    } as any)

    await call()
    expect(mocks.dispatchNativeAutomationPackAction.mock.calls[0]?.[0]?.abortSignal).toBe(parent.signal)

    // The parent's Stop is already pressed: the dispatcher still gets the call, with that Stop,
    // and its own runner stops before anything starts (the route does not refuse delegated runs).
    abortStream('session-bound', 'user')
    expect((await call()).status).toBe(200)
    expect(mocks.dispatchNativeAutomationPackAction).toHaveBeenCalledTimes(2)
    expect(mocks.dispatchNativeAutomationPackAction.mock.calls[1]?.[0]?.abortSignal).toBe(parent.signal)
  })
})

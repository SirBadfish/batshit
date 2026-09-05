import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTrustedInternalRequest: vi.fn(),
  executeManagedSubagent: vi.fn(),
  spawnWorkers: vi.fn(),
  redisGetSession: vi.fn(),
  redisGet: vi.fn(),
  redisSMembers: vi.fn(),
}))

vi.mock('$lib/server/services/internalRequestAuth', () => ({
  isTrustedInternalRequest: mocks.isTrustedInternalRequest,
}))

vi.mock('$lib/server/services/subagentRunner', () => ({
  executeManagedSubagent: mocks.executeManagedSubagent,
}))

vi.mock('$lib/server/services/workerRunner', () => ({
  spawnWorkers: mocks.spawnWorkers,
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: mocks.redisGetSession,
    get: mocks.redisGet,
    sMembers: mocks.redisSMembers,
  },
}))

import { SubagentBusyError } from '$lib/server/services/subagentThreads'

let routeModule: typeof import('./+server')

function buildRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/subagents/managed-execute', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-batshit-service-token': 'token',
      'x-batshit-user-id': 'user-1',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/subagents/managed-execute', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.isTrustedInternalRequest.mockReturnValue(true)
    mocks.redisGetSession.mockResolvedValue({
      id: 'session-1',
      user_id: 'user-1',
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
    })
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') {
        return {
          id: 'agent-1',
          user_id: 'user-1',
          displayName: 'CLI Primary',
          agentType: 'cli',
          assignedSubagents: ['legacy-workflow-subagent'],
          assigned_subagent_ids: ['api-subagent'],
        }
      }
      if (key === 'subagent:api-subagent') {
        return {
          id: 'api-subagent',
          user_id: 'user-1',
          displayName: 'API Helper',
          subagentType: 'api',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      }
      return null
    })
    mocks.redisSMembers.mockResolvedValue([])
    mocks.executeManagedSubagent.mockResolvedValue({
      output: 'API helper answer',
      intermediateSteps: [{ toolName: 'batshit_server_read_file' }],
      subagentType: 'api',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      modelId: 'gpt-5.4',
      provider: 'openai',
      durationMs: 987,
      status: 'completed',
      thread: 'fresh',
    })
    routeModule = await import('./+server')
  })

  it('SA-111 P4: routes a workers batch to the worker runner with the parent turn context', async () => {
    // The CLI lane's `spawn_workers` reaches the same trusted internal route. Worker mode
    // is chosen by the PRESENCE of `workers`, so a subagent call can never be reinterpreted
    // as a worker batch, and the parent turn id has to travel or the 9-per-turn cap cannot
    // be enforced.
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') {
        return {
          id: 'agent-1',
          user_id: 'user-1',
          displayName: 'CLI Primary',
          agentType: 'cli',
          primary_model_provider: 'codex',
          primary_model_name: 'gpt-5.6',
          assignedSubagents: ['api-subagent'],
          defaultMCPGateways: ['gw-1'],
        }
      }
      return null
    })
    mocks.spawnWorkers.mockResolvedValue({
      kind: 'workers',
      success: true,
      requested: 1,
      completed: 1,
      workers: [{ index: 0, name: 'Worker 1', status: 'completed', output: 'done' }],
    })

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        sessionId: 'session-1',
        messageId: 'parent-msg-7',
        projectPath: '/workspace/project',
        workers: [{ task: 'Find the config file' }],
      }),
    } as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ kind: 'workers', success: true })
    expect(mocks.executeManagedSubagent).not.toHaveBeenCalled()
    expect(mocks.spawnWorkers).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: expect.objectContaining({
          userId: 'user-1',
          sessionId: 'session-1',
          parentAgentId: 'agent-1',
          parentMessageId: 'parent-msg-7',
          lane: 'cli',
          selectedGateways: ['gw-1'],
          assignedSubagents: ['api-subagent'],
        }),
        workers: [{ task: 'Find the config file' }],
      })
    )
  })

  it('SA-111 P4: refuses a workers batch when the agent has Workers turned off', async () => {
    // DL-111-11: the setting is enforced server-side. A bridge listing built before the
    // toggle changed must not be able to run a worker anyway.
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') {
        return {
          id: 'agent-1',
          user_id: 'user-1',
          displayName: 'CLI Primary',
          agentType: 'cli',
          primary_model_provider: 'codex',
          primary_model_name: 'gpt-5.6',
          workers_enabled: false,
        }
      }
      return null
    })

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        sessionId: 'session-1',
        messageId: 'parent-msg-7',
        workers: [{ task: 'Find the config file' }],
      }),
    } as any)

    await expect(response.json()).resolves.toMatchObject({
      kind: 'workers',
      success: false,
      error: 'workers_disabled',
    })
    expect(mocks.spawnWorkers).not.toHaveBeenCalled()
  })

  it('executes an assigned API Subagent through the managed runner', async () => {
    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'Inspect the repo',
        projectPath: '/Users/example/batshit',
        timeoutMs: 45000,
      }),
    } as any)

    expect(response.status).toBe(200)
    const body = await response.json()

    expect(mocks.executeManagedSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        sessionId: 'session-1',
        chatInput: 'Inspect the repo',
        parentAgentId: 'agent-1',
        projectPath: '/Users/example/batshit',
        subagent: expect.objectContaining({
          id: 'api-subagent',
          subagentType: 'api',
        }),
      })
    )
    expect(body).toMatchObject({
      success: true,
      output: 'API helper answer',
      subagentType: 'api',
      subagentId: 'api-subagent',
      subagentName: 'API Helper',
      kind: 'subagent',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      modelId: 'gpt-5.4',
      provider: 'openai',
      durationMs: 987,
      status: 'completed',
      toolSource: 'managed-api-subagent',
    })
    expect(mocks.executeManagedSubagent.mock.calls[0]?.[0]).not.toHaveProperty(
      'callTimeoutMs',
    )
  })

  it('rejects untrusted internal calls before loading runtime state', async () => {
    mocks.isTrustedInternalRequest.mockReturnValue(false)

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'hello',
      }),
    } as any)

    expect(response.status).toBe(401)
    expect(mocks.redisGetSession).not.toHaveBeenCalled()
    expect(mocks.executeManagedSubagent).not.toHaveBeenCalled()
  })

  it('rejects subagents not assigned to the CLI Primary Agent', async () => {
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') {
        return {
          id: 'agent-1',
          user_id: 'user-1',
          displayName: 'CLI Primary',
          agentType: 'cli',
          assignedSubagents: [],
        }
      }
      if (key === 'subagent:api-subagent') {
        return {
          id: 'api-subagent',
          user_id: 'user-1',
          displayName: 'API Helper',
          subagentType: 'api',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      }
      return null
    })
    mocks.redisSMembers.mockResolvedValue([])

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'hello',
      }),
    } as any)

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe('subagent_not_assigned')
    expect(mocks.executeManagedSubagent).not.toHaveBeenCalled()
  })

  it('executes an assigned n8n Workflow Subagent through the managed runner', async () => {
    mocks.executeManagedSubagent.mockResolvedValueOnce({
      output: 'Workflow helper answer',
      intermediateSteps: [],
      subagentType: 'n8n-workflow',
      usage: null,
      modelId: null,
      provider: null,
      durationMs: 55,
      status: 'completed',
      thread: 'fresh',
    })
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') {
        return {
          id: 'agent-1',
          user_id: 'user-1',
          displayName: 'CLI Primary',
          agentType: 'cli',
          assignedSubagents: ['workflow-subagent'],
          assigned_subagent_ids: ['api-subagent'],
        }
      }
      if (key === 'subagent:workflow-subagent') {
        return {
          id: 'workflow-subagent',
          user_id: 'user-1',
          displayName: 'Workflow Helper',
          subagentType: 'n8n-workflow',
          webhookUrl: 'http://localhost:5678/webhook/subagent',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      }
      return null
    })

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'workflow-subagent',
        sessionId: 'session-1',
        chatInput: 'hello',
      }),
    } as any)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      success: true,
      output: 'Workflow helper answer',
      subagentType: 'n8n-workflow',
      subagentId: 'workflow-subagent',
      subagentName: 'Workflow Helper',
      toolSource: 'workflow-webhook',
    })
    expect(mocks.executeManagedSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        subagent: expect.objectContaining({
          id: 'workflow-subagent',
          subagentType: 'n8n-workflow',
          webhookUrl: 'http://localhost:5678/webhook/subagent',
        }),
      })
    )
  })

  it('passes through the runner-owned timed-out result as model-readable tool output', async () => {
    mocks.executeManagedSubagent.mockResolvedValueOnce({
      output: 'API Helper did not return a complete result within 10 seconds.',
      intermediateSteps: [],
      subagentType: 'api',
      usage: null,
      modelId: 'gpt-5.4',
      provider: 'openai',
      durationMs: 10_002,
      status: 'timed_out',
      thread: 'fresh',
    })

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'this should time out',
      }),
    } as any)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      success: true,
      kind: 'subagent',
      status: 'timed_out',
      usage: null,
      durationMs: 10_002,
    })
  })

  it('returns clear setup failures from the managed runner', async () => {
    mocks.executeManagedSubagent.mockRejectedValueOnce(
      new Error('CLI Subagent needs a real Codex or Claude model in its native CLI defaults.')
    )

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'run without a configured model',
      }),
    } as any)

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toMatchObject({
      code: 'managed_subagent_failed',
      message: expect.stringContaining('needs a real Codex or Claude model'),
    })
  })

  it('defaults thread control to fresh and reports what the thread did', async () => {
    // SA-111 P2 (DL-111-04): a CLI agent that says nothing gets Josh's chosen default.
    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'hello',
      }),
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.executeManagedSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ thread: 'fresh' })
    )
    expect(mocks.executeManagedSubagent.mock.calls[0]?.[0]).not.toHaveProperty(
      'callTimeoutMs',
    )
    expect(await response.json()).toMatchObject({ thread: 'fresh' })
  })

  it('passes an explicit resume through and normalizes anything else to fresh', async () => {
    for (const [sent, expected] of [
      ['resume', 'resume'],
      ['RESUME', 'fresh'],
      ['continue', 'fresh'],
    ] as const) {
      mocks.executeManagedSubagent.mockClear()
      await routeModule.POST({
        request: buildRequest({
          agentId: 'agent-1',
          subagentId: 'api-subagent',
          sessionId: 'session-1',
          chatInput: 'hello',
          thread: sent,
        }),
      } as any)

      expect(mocks.executeManagedSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ thread: expected })
      )
    }
  })

  it('reports a same-subagent collision as model-readable failed delegation output', async () => {
    // DL-111-05: the bridge turns a non-ok body into readable tool content, so the CLI agent
    // reads a plain explanation and can pick a different specialist.
    mocks.executeManagedSubagent.mockRejectedValueOnce(
      new SubagentBusyError('API Helper', 120000)
    )

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'hello',
      }),
    } as any)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      success: true,
      executionSucceeded: false,
      error: 'subagent_busy',
      output: expect.stringContaining('API Helper'),
      status: 'failed',
      usage: null,
    })
  })

  it('surfaces a thread that could not be saved instead of staying quiet', async () => {
    mocks.executeManagedSubagent.mockResolvedValueOnce({
      output: 'answer',
      intermediateSteps: [],
      subagentType: 'api',
      usage: null,
      modelId: 'gpt-5.4',
      provider: 'openai',
      durationMs: 50,
      status: 'completed',
      thread: 'resumed',
      threadNote: 'This run outlived its own in-flight lock',
    })

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'hello',
      }),
    } as any)

    expect(await response.json()).toMatchObject({
      thread: 'resumed',
      threadNote: expect.stringContaining('outlived its own in-flight lock'),
    })
  })
})

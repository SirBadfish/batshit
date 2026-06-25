import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTrustedInternalRequest: vi.fn(),
  executeManagedSubagent: vi.fn(),
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

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: mocks.redisGetSession,
    get: mocks.redisGet,
    sMembers: mocks.redisSMembers,
  },
}))

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
    })
    routeModule = await import('./+server')
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
        abortSignal: expect.any(AbortSignal),
      })
    )
    expect(body).toMatchObject({
      success: true,
      output: 'API helper answer',
      subagentType: 'api',
      subagentId: 'api-subagent',
      subagentName: 'API Helper',
      toolSource: 'managed-api-subagent',
    })
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

  it('returns a timeout error and aborts slow managed subagent runs', async () => {
    let aborted = false
    mocks.executeManagedSubagent.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise(() => {
          abortSignal.addEventListener('abort', () => {
            aborted = true
          })
        })
    )

    const response = await routeModule.POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-1',
        chatInput: 'this should time out',
        timeoutMs: 1,
      }),
    } as any)

    expect(response.status).toBe(504)
    const body = await response.json()
    expect(body.error.code).toBe('managed_subagent_timeout')
    expect(aborted).toBe(true)
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
})

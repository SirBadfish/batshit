import { beforeEach, describe, expect, it, vi } from 'vitest'

const workflowSubagentMocks = vi.hoisted(() => ({
  callWorkflow: vi.fn(),
  createN8nSseCallbackToken: vi.fn(),
  apiKeyRetrieve: vi.fn(),
  redisGetUserSettings: vi.fn(),
  resolveManagedSubagentScope: vi.fn(),
  buildManagedSubagentDynamicInfo: vi.fn(),
  // SA-111 P2: the runner's thread control and in-flight lock are Redis SEMANTICS, so this
  // suite runs them against a real in-memory store rather than per-method stubs.
  redisStore: { current: null as any },
}))

vi.mock('$env/dynamic/private', () => ({
  env: {
    BATSHIT_FRONTEND_URL: 'http://localhost:5605',
  },
}))

vi.mock('$lib/server/services/workflowExecutor', () => ({
  callWorkflow: (...args: any[]) => workflowSubagentMocks.callWorkflow(...args),
}))

vi.mock('$lib/server/services/n8nCallbackTokens', () => ({
  createN8nSseCallbackToken: (...args: any[]) =>
    workflowSubagentMocks.createN8nSseCallbackToken(...args),
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: (...args: any[]) => workflowSubagentMocks.apiKeyRetrieve(...args),
  },
}))

vi.mock('$lib/server/services/codexBridge', () => ({
  CodexBridge: vi.fn(),
}))

vi.mock('$lib/server/services/claudeBridge', () => ({
  ClaudeBridge: vi.fn(),
}))

vi.mock('$lib/server/services/codexProfileManager', () => ({
  buildAgentProfileId: vi.fn((value: string) => `profile-${value}`),
  prepareManagedCodexSubagentProfile: vi.fn(),
}))

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  prepareManagedClaudeSubagentProfile: vi.fn(),
}))

vi.mock('$lib/server/redis', () => ({
  redis: new Proxy({} as Record<string, any>, {
    get(_target, prop: string) {
      if (prop === 'getUserSettings') {
        return (...args: any[]) => workflowSubagentMocks.redisGetUserSettings(...args)
      }
      return workflowSubagentMocks.redisStore.current.redis[prop]
    },
  }),
}))

vi.mock('$lib/server/services/subagentRuntimeScope', () => ({
  resolveManagedSubagentScope: (...args: any[]) =>
    workflowSubagentMocks.resolveManagedSubagentScope(...args),
  buildManagedSubagentDynamicInfo: (...args: any[]) =>
    workflowSubagentMocks.buildManagedSubagentDynamicInfo(...args),
  appendManagedSubagentDynamicInfo: (systemPrompt: string, dynamicInfo: string) =>
    dynamicInfo ? `${systemPrompt}\n\n${dynamicInfo}` : systemPrompt,
}))

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: vi.fn(),
  buildSkillsCommandsDcmLines: vi.fn(() => []),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import { buildSubagentN8nThreadIdKey } from '../subagentThreads'
import {
  DEFAULT_API_SUBAGENT_TIMEOUT_MS,
  DEFAULT_CLI_SUBAGENT_TIMEOUT_MS,
  DEFAULT_N8N_SUBAGENT_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  executeManagedSubagent,
  resolveManagedDelegationTimeoutMs,
} from '../subagentRunner'

const subagentRedis = createSubagentRedisMock()
workflowSubagentMocks.redisStore.current = subagentRedis

function workflowCall(overrides: Record<string, any> = {}) {
  return {
    userId: 'USER-1',
    sessionId: 'session-1',
    chatInput: 'Use a tool.',
    parentAgentId: 'primary-agent',
    parentModelId: 'gpt-5.4',
    subagent: {
      id: 'workflow-helper',
      user_id: 'USER-1',
      displayName: 'Workflow Helper',
      subagentType: 'n8n-workflow',
      webhookUrl: 'http://localhost:5678/webhook/workflow-helper',
      primary_model_provider: 'openai',
      primary_model_name: 'gpt-5.4',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    ...overrides,
  } as any
}

describe('executeManagedSubagent - n8n Workflow Subagents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    subagentRedis.clear()
    subagentRedis.seed('batshit:sub_system_prompt', '# Workflow subagent prompt')
    workflowSubagentMocks.redisGetUserSettings.mockResolvedValue(null)
    workflowSubagentMocks.apiKeyRetrieve.mockResolvedValue(null)
    workflowSubagentMocks.resolveManagedSubagentScope.mockResolvedValue({
      subagentType: 'n8n-workflow',
      nativeToolSettings: {},
      defaultMcpGateways: [],
      resolvedGateways: [],
      defaultCliToolIds: [],
      resolvedCliToolIds: [],
      defaultMcpToolSelections: [],
      dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
      projectPath: '/Users/example/batshit',
    })
    workflowSubagentMocks.buildManagedSubagentDynamicInfo.mockResolvedValue('')
    workflowSubagentMocks.createN8nSseCallbackToken.mockResolvedValue({
      token: 'scoped-token',
      expiresAt: '2026-05-31T07:30:00.000Z',
    })
    workflowSubagentMocks.callWorkflow.mockResolvedValue({
      success: true,
      data: {
        output: 'Workflow answer',
        intermediateSteps: [{ toolName: 'Batshit Subagent Tools' }],
      },
      workflowName: 'workflow_helper',
      executionTime: 12,
      method: 'webhook',
    })
  })

  it('resolves the policy defaults and bounded per-subagent override', () => {
    expect(resolveManagedDelegationTimeoutMs({}, 'api')).toBe(
      DEFAULT_API_SUBAGENT_TIMEOUT_MS,
    )
    expect(resolveManagedDelegationTimeoutMs({}, 'n8n-workflow')).toBe(
      DEFAULT_N8N_SUBAGENT_TIMEOUT_MS,
    )
    expect(resolveManagedDelegationTimeoutMs({}, 'cli')).toBe(
      DEFAULT_CLI_SUBAGENT_TIMEOUT_MS,
    )
    expect(resolveManagedDelegationTimeoutMs({}, 'worker')).toBe(
      DEFAULT_WORKER_TIMEOUT_MS,
    )
    expect(resolveManagedDelegationTimeoutMs({ timeout_seconds: 10 }, 'api')).toBe(10_000)
    expect(() =>
      resolveManagedDelegationTimeoutMs({ timeout_seconds: 601 }, 'api'),
    ).toThrow('whole number from 10 to 600')
  })

  it('sends scoped token and Batshit callback URLs in the workflow payload', async () => {
    const result = await executeManagedSubagent({
      userId: 'USER-1',
      sessionId: 'session-1',
      chatInput: 'Use a tool.',
      parentAgentId: 'primary-agent',
      parentModelId: 'gpt-5.4',
      projectPath: '/Users/example/batshit',
      subagent: {
        id: 'workflow-helper',
        user_id: 'USER-1',
        displayName: 'Workflow Helper',
        subagentType: 'n8n-workflow',
        webhookUrl: 'http://localhost:5678/webhook/workflow-helper',
        primary_model_provider: 'openai',
        primary_model_name: 'gpt-5.4',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })

    expect(result.output).toBe('Workflow answer')
    expect(workflowSubagentMocks.createN8nSseCallbackToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        userId: 'USER-1',
        agentId: 'primary-agent',
      }),
    )

    const workflowPayload = workflowSubagentMocks.callWorkflow.mock.calls[0]?.[1]
    expect(workflowPayload).toMatchObject({
      user_id: 'USER-1',
      session_id: 'session-1',
      agent_id: 'primary-agent',
      parent_agent_id: 'primary-agent',
      subagent_id: 'workflow-helper',
      batshit_frontend_url: 'http://127.0.0.1:5605',
      batshit_sse_endpoint: 'http://127.0.0.1:5605/api/sse',
      batshit_artifact_complete_url: 'http://127.0.0.1:5605/api/artifacts/complete',
      batshit_native_tool_token: 'scoped-token',
      batshit_native_tool_header: 'x-batshit-native-tool-token',
      batshit_sse_callback_token: 'scoped-token',
    })
    expect(workflowPayload.message_id).toMatch(/^subagent_/)
    expect(workflowSubagentMocks.callWorkflow.mock.calls[0]?.[2]).toMatchObject({
      timeout: DEFAULT_N8N_SUBAGENT_TIMEOUT_MS,
      async: false,
      abortSignal: expect.any(AbortSignal),
    })
    expect(result).toMatchObject({
      subagentType: 'n8n-workflow',
      usage: null,
      modelId: 'gpt-5.4',
      provider: 'openai',
      status: 'completed',
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('ships a Batshit-issued thread id and rotates it on the next fresh call', async () => {
    // DL-111-06. Batshit never stores the n8n conversation, only the id that names it, so
    // this field is the whole of thread control on this lane.
    const first = await executeManagedSubagent(workflowCall())
    const firstId = workflowSubagentMocks.callWorkflow.mock.calls[0]?.[1]?.subagent_thread_id

    expect(first.thread).toBe('fresh')
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/)
    expect(subagentRedis.snapshot()[buildSubagentN8nThreadIdKey('session-1', 'workflow_helper')]).toBe(
      firstId,
    )

    const resumed = await executeManagedSubagent(workflowCall({ thread: 'resume' }))
    expect(resumed.thread).toBe('resumed')
    expect(workflowSubagentMocks.callWorkflow.mock.calls[1]?.[1]?.subagent_thread_id).toBe(firstId)

    const reset = await executeManagedSubagent(workflowCall())
    expect(reset.thread).toBe('fresh')
    // A new id is exactly how "fresh resets" reaches memory Batshit does not own.
    expect(workflowSubagentMocks.callWorkflow.mock.calls[2]?.[1]?.subagent_thread_id).not.toBe(
      firstId,
    )
  })

  it('reports resumed-empty when there was no thread to resume', async () => {
    const result = await executeManagedSubagent(workflowCall({ thread: 'resume' }))

    expect(result.thread).toBe('resumed-empty')
    expect(workflowSubagentMocks.callWorkflow.mock.calls[0]?.[1]?.subagent_thread_id).toMatch(
      /^[0-9a-f-]{36}$/,
    )
  })

  it('uses the saved timeout override and normalizes optional workflow usage', async () => {
    workflowSubagentMocks.callWorkflow.mockResolvedValueOnce({
      success: true,
      data: [
        {
          output: 'Slow workflow answer',
          usage: {
            promptTokens: 140,
            completionTokens: 35,
            totalTokens: 175,
          },
        },
      ],
      executionTime: 42_000,
      method: 'webhook',
    })

    const result = await executeManagedSubagent(
      workflowCall({ subagent: { ...workflowCall().subagent, timeout_seconds: 45 } }),
    )

    expect(workflowSubagentMocks.callWorkflow.mock.calls[0]?.[2]?.timeout).toBe(45_000)
    expect(result).toMatchObject({
      output: 'Slow workflow answer',
      usage: { inputTokens: 140, outputTokens: 35, totalTokens: 175 },
      status: 'completed',
    })
  })

  it('returns an honest timed-out result without inventing usage', async () => {
    workflowSubagentMocks.callWorkflow.mockResolvedValueOnce({
      success: false,
      timeout: true,
      error: 'Workflow request timed out',
      data: null,
      executionTime: 10_000,
      method: 'webhook',
    })

    const result = await executeManagedSubagent(
      workflowCall({ subagent: { ...workflowCall().subagent, timeout_seconds: 10 } }),
    )

    expect(result).toMatchObject({
      status: 'timed_out',
      usage: null,
      durationMs: expect.any(Number),
      thread: 'fresh',
    })
    expect(result.output).toContain('Treat this call as timed out')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const workflowSubagentMocks = vi.hoisted(() => ({
  callWorkflow: vi.fn(),
  createN8nSseCallbackToken: vi.fn(),
  apiKeyRetrieve: vi.fn(),
  redisGet: vi.fn(),
  redisGetUserSettings: vi.fn(),
  redisJsonGet: vi.fn(),
  redisJsonSet: vi.fn(),
  resolveManagedSubagentScope: vi.fn(),
  buildManagedSubagentDynamicInfo: vi.fn(),
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
  redis: {
    get: (...args: any[]) => workflowSubagentMocks.redisGet(...args),
    getUserSettings: (...args: any[]) =>
      workflowSubagentMocks.redisGetUserSettings(...args),
    json: {
      get: (...args: any[]) => workflowSubagentMocks.redisJsonGet(...args),
      set: (...args: any[]) => workflowSubagentMocks.redisJsonSet(...args),
    },
  },
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

import { executeManagedSubagent } from '../subagentRunner'

describe('executeManagedSubagent - n8n Workflow Subagents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workflowSubagentMocks.redisGet.mockResolvedValue('# Workflow subagent prompt')
    workflowSubagentMocks.redisGetUserSettings.mockResolvedValue(null)
    workflowSubagentMocks.redisJsonGet.mockResolvedValue([])
    workflowSubagentMocks.redisJsonSet.mockResolvedValue('OK')
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
  })
})

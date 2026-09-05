import { beforeEach, describe, expect, it, vi } from 'vitest'

const cliSubagentMocks = vi.hoisted(() => ({
  codexStreamNativeMode: vi.fn(),
  claudeStreamNativeMode: vi.fn(),
  prepareManagedCodexSubagentProfile: vi.fn(),
  prepareManagedClaudeSubagentProfile: vi.fn(),
  buildAgentProfileId: vi.fn((value: string) => `profile-${value}`),
  redisGetUserSettings: vi.fn(),
  // SA-111 P2: the runner's thread control and in-flight lock are Redis SEMANTICS, so this
  // suite runs them against a real in-memory store rather than per-method stubs.
  redisStore: { current: null as any },
  resolveManagedSubagentScope: vi.fn(),
  buildManagedSubagentDynamicInfo: vi.fn(),
  getEnabledAgentSlashCapabilities: vi.fn(),
  buildSkillsCommandsDcmLines: vi.fn(),
}))

vi.mock('$lib/server/services/codexBridge', () => ({
  CodexBridge: vi.fn(function MockCodexBridge(this: Record<string, unknown>) {
    Object.assign(this, {
      streamNativeMode: cliSubagentMocks.codexStreamNativeMode,
    })
  }),
}))

vi.mock('$lib/server/services/claudeBridge', () => ({
  ClaudeBridge: vi.fn(function MockClaudeBridge(this: Record<string, unknown>) {
    Object.assign(this, {
      streamNativeMode: cliSubagentMocks.claudeStreamNativeMode,
    })
  }),
}))

vi.mock('$lib/server/services/codexProfileManager', () => ({
  buildAgentProfileId: cliSubagentMocks.buildAgentProfileId,
  prepareManagedCodexSubagentProfile:
    cliSubagentMocks.prepareManagedCodexSubagentProfile,
}))

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  prepareManagedClaudeSubagentProfile:
    cliSubagentMocks.prepareManagedClaudeSubagentProfile,
}))

vi.mock('$lib/server/redis', () => ({
  redis: new Proxy({} as Record<string, any>, {
    get(_target, prop: string) {
      if (prop === 'getUserSettings') {
        return (...args: any[]) => cliSubagentMocks.redisGetUserSettings(...args)
      }
      return cliSubagentMocks.redisStore.current.redis[prop]
    },
  }),
}))

vi.mock('$lib/server/services/subagentRuntimeScope', () => ({
  resolveManagedSubagentScope: (...args: any[]) =>
    cliSubagentMocks.resolveManagedSubagentScope(...args),
  buildManagedSubagentDynamicInfo: (...args: any[]) =>
    cliSubagentMocks.buildManagedSubagentDynamicInfo(...args),
  appendManagedSubagentDynamicInfo: (systemPrompt: string, dynamicInfo: string) =>
    dynamicInfo ? `${systemPrompt}\n\n${dynamicInfo}` : systemPrompt,
}))

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: (...args: any[]) =>
    cliSubagentMocks.getEnabledAgentSlashCapabilities(...args),
  buildSkillsCommandsDcmLines: (...args: any[]) =>
    cliSubagentMocks.buildSkillsCommandsDcmLines(...args),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import { buildSubagentRunLockKey, buildSubagentThreadKey } from '../subagentThreads'
import { executeManagedSubagent } from '../subagentRunner'

const subagentRedis = createSubagentRedisMock()
cliSubagentMocks.redisStore.current = subagentRedis

function streamFromChunks(chunks: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  }
}

describe('executeManagedSubagent - CLI subagents', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    subagentRedis.clear()
    subagentRedis.seed('batshit:sub_system_prompt', '# Base subagent prompt')
    cliSubagentMocks.redisGetUserSettings.mockResolvedValue(null)
    cliSubagentMocks.resolveManagedSubagentScope.mockResolvedValue({
      subagentType: 'cli',
      nativeToolSettings: {},
      defaultMcpGateways: ['gw-1'],
      resolvedGateways: ['gw-1'],
      defaultCliToolIds: ['cli-tool-1'],
      resolvedCliToolIds: ['cli-tool-1'],
      defaultMcpToolSelections: ['tool-a'],
      dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
      projectPath: '/Users/example/hello',
    })
    cliSubagentMocks.buildManagedSubagentDynamicInfo.mockResolvedValue('')
    cliSubagentMocks.getEnabledAgentSlashCapabilities.mockResolvedValue([])
    cliSubagentMocks.buildSkillsCommandsDcmLines.mockReturnValue([])
    cliSubagentMocks.prepareManagedCodexSubagentProfile.mockResolvedValue({
      profileId: 'profile-subagent_cli_builder',
      managedConfigHome: '/tmp/codex-subagent-home',
      gatewayToolMap: { 'gw-1': ['tool-a'] },
      resolvedGateways: ['gw-1'],
    })
    cliSubagentMocks.prepareManagedClaudeSubagentProfile.mockResolvedValue({
      profileId: 'profile-subagent_cli_reviewer',
      gatewayToolMap: { 'gw-1': ['tool-a'] },
      resolvedGateways: ['gw-1'],
    })
  })

  it('routes Codex CLI subagents through the managed Codex bridge', async () => {
    const abortController = new AbortController()
    cliSubagentMocks.codexStreamNativeMode.mockResolvedValue({
      stream: streamFromChunks([
        { type: 'text-delta', text: 'Codex says hi.' },
        {
          type: 'tool-result',
          toolName: 'batshit_server_read_file',
          args: { filePath: '/tmp/demo.txt' },
          result: { success: true },
          metadata: { toolProvider: 'batshit-server' },
        },
        {
          type: 'finish',
          totalUsage: {
            inputTokens: 220,
            outputTokens: 44,
            totalTokens: 264,
          },
        },
      ]),
      __detectToolSource: vi.fn(() => ({
        toolProvider: 'batshit-server',
        toolSource: 'native-tool',
      })),
    })

    const result = await executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Please inspect the repo.',
      parentAgentId: 'agent-1',
      parentModelId: 'gpt-5.4',
      projectPath: '/Users/example/hello',
      abortSignal: abortController.signal,
      subagent: {
        id: 'builder',
        user_id: 'user-1',
        displayName: 'Builder',
        subagentType: 'cli',
        primary_model_provider: 'openai-codex',
        primary_model_name: 'gpt-5.4',
        codex_settings: {
          permissionMode: 'chat',
          includeProjectInstructions: true,
          model: 'codex-mini-latest',
          streamingEffect: true,
          search: false,
          sandbox: 'read-only',
          approval: 'never',
          addDirs: [],
          enableFeatures: ['browser_use'],
          disableFeatures: [],
          configOverrides: [],
          workingDirectoryMode: 'project',
        },
        provider_specific_settings: {
          nativeTools: {
            bashAccessMode: 'agent',
            webSearchEnabled: true,
          },
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })

    expect(cliSubagentMocks.prepareManagedCodexSubagentProfile).toHaveBeenCalled()
    expect(cliSubagentMocks.codexStreamNativeMode).toHaveBeenCalled()
    expect(
      cliSubagentMocks.codexStreamNativeMode.mock.calls[0]?.[0]?.codexSettings?.model,
    ).toBe('codex-mini-latest')
    expect(cliSubagentMocks.codexStreamNativeMode.mock.calls[0]?.[0]).toMatchObject({
      assignedSubagents: [],
      abortSignal: expect.any(AbortSignal),
    })
    expect(
      cliSubagentMocks.prepareManagedCodexSubagentProfile.mock.calls[0]?.[0]?.runtimeSettings?.enableFeatures,
    ).toContain('browser_use')
    expect(result.subagentType).toBe('cli')
    expect(result.output).toBe('Codex says hi.')
    expect(result.intermediateSteps).toHaveLength(1)
    expect(result.intermediateSteps[0]).toMatchObject({
      toolName: 'batshit_server_read_file',
      toolProvider: 'batshit-server',
      toolSource: 'native-tool',
    })
    expect(result).toMatchObject({
      usage: { inputTokens: 220, outputTokens: 44, totalTokens: 264 },
      modelId: 'codex-mini-latest',
      provider: 'openai-codex',
      status: 'completed',
      thread: 'fresh',
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('treats codex-cli saved-model sentinels as lane selectors, not runnable models', async () => {
    cliSubagentMocks.codexStreamNativeMode.mockResolvedValue({
      stream: streamFromChunks([{ type: 'text-delta', text: 'Codex fixed it.' }]),
      __detectToolSource: vi.fn(() => ({})),
    })

    await executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Fix the bug.',
      parentAgentId: 'agent-1',
      projectPath: '/Users/example/hello',
      subagent: {
        id: 'codex-fixer',
        user_id: 'user-1',
        displayName: 'Codex Fixer',
        subagentType: 'cli',
        primary_model_provider: 'openai-codex',
        primary_model_name: 'codex-cli',
        codex_settings: {
          permissionMode: 'chat',
          includeProjectInstructions: true,
          model: 'gpt-5.4',
          streamingEffect: true,
          search: true,
          sandbox: 'read-only',
          approval: 'never',
          addDirs: [],
          enableFeatures: [],
          disableFeatures: [],
          configOverrides: [],
          workingDirectoryMode: 'project',
        },
        provider_specific_settings: {
          codex_model: 'gpt-5.1-codex',
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })

    expect(cliSubagentMocks.codexStreamNativeMode).toHaveBeenCalled()
    expect(cliSubagentMocks.codexStreamNativeMode.mock.calls[0]?.[0]?.model).toBe('gpt-5.4')
    expect(
      cliSubagentMocks.codexStreamNativeMode.mock.calls[0]?.[0]?.codexSettings?.model,
    ).toBe('gpt-5.4')
    expect(
      cliSubagentMocks.prepareManagedCodexSubagentProfile.mock.calls[0]?.[0]?.runtimeSettings?.model,
    ).toBe('gpt-5.4')
  })

  it('routes Claude CLI subagents through the managed Claude bridge', async () => {
    cliSubagentMocks.claudeStreamNativeMode.mockResolvedValue({
      stream: streamFromChunks([
        { type: 'text-delta', text: 'Claude reviewed it.' },
        {
          type: 'tool-result',
          toolName: 'batshit_server_search_files',
          args: { query: 'subagent' },
          result: { matches: 3 },
          metadata: { toolProvider: 'batshit-server' },
        },
      ]),
      __detectToolSource: vi.fn(() => ({
        toolProvider: 'batshit-server',
        toolSource: 'native-tool',
      })),
    })

    const result = await executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Find the related code.',
      parentAgentId: 'agent-1',
      projectPath: '/Users/example/hello',
      subagent: {
        id: 'reviewer',
        user_id: 'user-1',
        displayName: 'Reviewer',
        subagentType: 'cli',
        primary_model_provider: 'anthropic-claude-cli',
        primary_model_name: 'sonnet',
        claude_settings: {
          permissionMode: 'acceptEdits',
          includeCoreSystemPrompt: true,
          includeProjectInstructions: true,
          model: 'claude-sonnet-4-20250514',
          alwaysThinkingEnabled: true,
          maxThinkingTokens: 2048,
          addDirs: [],
          allowedTools: ['WebSearch'],
          disallowedTools: ['WebFetch'],
          configOverrides: [],
        },
        provider_specific_settings: {
          nativeTools: {
            bashAccessMode: 'dangerous',
            webSearchEnabled: true,
          },
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })

    expect(cliSubagentMocks.prepareManagedClaudeSubagentProfile).toHaveBeenCalled()
    expect(cliSubagentMocks.claudeStreamNativeMode).toHaveBeenCalled()
    expect(
      cliSubagentMocks.claudeStreamNativeMode.mock.calls[0]?.[0]?.claudeSettings?.model,
    ).toBe('claude-sonnet-4-20250514')
    expect(
      cliSubagentMocks.prepareManagedClaudeSubagentProfile.mock.calls[0]?.[0]?.runtimeSettings?.allowedTools,
    ).toContain('WebSearch')
    expect(result.subagentType).toBe('cli')
    expect(result.output).toBe('Claude reviewed it.')
    expect(result.intermediateSteps).toHaveLength(1)
    expect(result.intermediateSteps[0]).toMatchObject({
      toolName: 'batshit_server_search_files',
      toolProvider: 'batshit-server',
      toolSource: 'native-tool',
    })
  })

  it('returns failed status when the CLI bridge fails and releases the thread lock', async () => {
    cliSubagentMocks.codexStreamNativeMode.mockRejectedValueOnce(
      new Error('Codex transport failed'),
    )

    const subagent = {
      id: 'failure-helper',
      user_id: 'user-1',
      displayName: 'Failure Helper',
      subagentType: 'cli' as const,
      primary_model_provider: 'openai-codex',
      primary_model_name: 'codex-cli',
      codex_settings: { model: 'gpt-5.4' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const failed = await executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Fail clearly.',
      subagent,
    } as any)

    expect(failed).toMatchObject({
      status: 'failed',
      usage: null,
      modelId: 'gpt-5.4',
      provider: 'openai-codex',
      thread: 'fresh',
    })
    expect(failed.output).toContain('Codex transport failed')
    expect(subagentRedis.snapshot()[buildSubagentRunLockKey('session-1', 'failure_helper')])
      .toBeUndefined()
  })
})

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import type { NativeModeRequest } from '../vercelBrain'
import { buildCodexRuntimeSettings } from '../codexSettings'

const mockRedisClient = {
  json: {
    get: vi.fn().mockResolvedValue(null)
  },
  set: vi.fn().mockResolvedValue(null),
  expire: vi.fn().mockResolvedValue(true),
  del: vi.fn().mockResolvedValue(1),
  sAdd: vi.fn().mockResolvedValue(1),
  sRem: vi.fn().mockResolvedValue(1)
}

const mockRedis = {
  getProjectPreferences: vi.fn().mockResolvedValue(null),
  getAgents: vi.fn().mockResolvedValue([]),
  execute: vi.fn(async (fn: any) => fn(mockRedisClient))
}

const mockEnsureManagedCodexHome = vi.hoisted(() =>
  vi.fn().mockResolvedValue('/tmp/codex-home')
)
const mockSyncAgentCodexProfiles = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
)

vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('../codexProfileManager', () => ({
  ensureManagedCodexHome: mockEnsureManagedCodexHome,
  DOCKER_AUTH_ENV_VAR: 'BATSHIT_DOCKER_MCP_TOKEN',
  N8N_INSTANCE_MCP_TOKEN_ENV: 'BATSHIT_N8N_INSTANCE_MCP_TOKEN',
  BATSHIT_TOKEN_ENV_VAR: 'BATSHIT_TOKEN',
  syncAgentCodexProfiles: mockSyncAgentCodexProfiles
}))

let CodexBridgeClass: typeof import('../codexBridge').CodexBridge
let buildCodexPromptFromMessages: typeof import('../codexBridge').buildCodexPromptFromMessages
let buildCodexPromptPackageFromMessages: typeof import('../codexBridge').buildCodexPromptPackageFromMessages
let buildCodexCliArgs: typeof import('../codexBridge').buildCodexCliArgs
let buildManagedCodexPromptCacheKey: typeof import('../codexBridge').buildManagedCodexPromptCacheKey
let buildCodexNativeSkillDisableOverride: typeof import('../codexBridge').buildCodexNativeSkillDisableOverride
let getDefaultCodexWorkingDirectory: typeof import('../codexBridge').getDefaultCodexWorkingDirectory
let redactCodexCliArgsForLog: typeof import('../codexBridge').redactCodexCliArgsForLog
let codexCliStatusModule: typeof import('../codexCliStatus')

beforeAll(async () => {
  ;({
    CodexBridge: CodexBridgeClass,
    buildCodexPromptFromMessages,
    buildCodexPromptPackageFromMessages,
    buildCodexCliArgs,
    buildManagedCodexPromptCacheKey,
    buildCodexNativeSkillDisableOverride,
    getDefaultCodexWorkingDirectory,
    redactCodexCliArgsForLog
  } = await import('../codexBridge'))
  codexCliStatusModule = await import('../codexCliStatus')
})

function buildRequest(overrides: Partial<NativeModeRequest> = {}): NativeModeRequest {
  return {
    sessionId: 'sess-one',
    messageId: 'msg-one',
    agentId: 'agent-123',
    userId: 'user-123',
    model: 'codex/codex-cli',
    codexSettings: {
      ...buildCodexRuntimeSettings(),
      configScope: 'global'
    },
    messages: [
      {
        role: 'user',
        content: 'Hello Codex'
      }
    ],
    availableWorkflows: [],
    availableTools: [],
    assignedSubagents: [],
    defaultGateways: null,
    ...overrides
  }
}

async function collectStream(stream: AsyncGenerator<any>) {
  const chunks: any[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsureManagedCodexHome.mockResolvedValue('/tmp/codex-home')
  mockSyncAgentCodexProfiles.mockResolvedValue(undefined)
  mockRedisClient.json.get.mockResolvedValue(null)
  mockRedisClient.set.mockResolvedValue(null)
  mockRedisClient.expire.mockResolvedValue(true)
  mockRedisClient.del.mockResolvedValue(1)
  mockRedisClient.sAdd.mockResolvedValue(1)
  mockRedisClient.sRem.mockResolvedValue(1)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CodexBridge', () => {
  it('uses a Batshit-owned empty workspace as the no-project fallback', () => {
    expect(getDefaultCodexWorkingDirectory('/Users/example')).toBe(
      '/Users/example/.batshit/workspaces/default'
    )
  })

  it('streams via the CLI lane and exposes runtime metadata', async () => {
    const bridge = new CodexBridgeClass()
    let receivedRunOptions: Record<string, any> | null = null

    const runViaCliSpy = vi
      .spyOn(bridge as any, 'runViaCli')
      .mockImplementation(async (_prompt: unknown, options: unknown) => {
        receivedRunOptions = options as Record<string, any>
        return {
          transport: 'exec',
          events: (async function* () {
            yield {
              type: 'item.started',
              item: {
                id: 'reason-1',
                type: 'reasoning',
                text: 'Planning'
              }
            }
            yield {
              type: 'turn.completed',
              usage: {
                input_tokens: 3,
                output_tokens: 7
              }
            }
          })()
        }
      })

    const result = await bridge.streamNativeMode(buildRequest())
    const chunks = await collectStream(result.fullStream)

    expect(runViaCliSpy).toHaveBeenCalledTimes(1)
    expect(chunks[0]?.type).toBe('thinking')
    expect(result.__runtimeInfo?.transport).toBe('codex-exec')
    expect(result.__runtimeInfo?.sandboxMode).toBe('read-only')
    expect(result.__runtimeInfo?.providerId).toBe('openai-codex')
    expect(receivedRunOptions?.sandboxMode).toBe('read-only')
    expect(mockRedisClient.sAdd).toHaveBeenCalledWith(
      'codex_sessions:user-123:agent-123',
      'sess-one'
    )
    expect(mockRedisClient.del).toHaveBeenCalledWith('codex_session:user-123:agent-123')
    expect(mockRedisClient.sRem).toHaveBeenCalledWith(
      'codex_sessions:user-123:agent-123',
      'sess-one'
    )
  })

  it('exposes app-server runtime metadata for managed Codex runs without a duplicate profile sync', async () => {
    const bridge = new CodexBridgeClass()
    const runnerCleanup = vi.fn()

    vi.spyOn(bridge as any, 'resolveManagedStdioEnv').mockResolvedValue({})
    vi.spyOn(bridge as any, 'createRunner').mockResolvedValue({
      transport: 'app-server',
      events: (async function* () {
        yield {
          type: 'turn.completed',
          usage: {
            input_tokens: 4,
            output_tokens: 6
          }
        }
      })(),
      cleanup: runnerCleanup
    })

    const result = await bridge.streamNativeMode(
      buildRequest({
        codexSettings: {
          ...buildCodexRuntimeSettings(),
          configScope: 'managed'
        },
        projectPath: '/tmp'
      })
    )
    await collectStream(result.fullStream)

    expect(result.__runtimeInfo?.transport).toBe('codex-app-server')
    expect(mockEnsureManagedCodexHome).toHaveBeenCalledTimes(1)
    expect(mockSyncAgentCodexProfiles).not.toHaveBeenCalled()
    expect(runnerCleanup).toHaveBeenCalledTimes(1)
  })

  it('runs Codex cleanup when the native stream throws', async () => {
    const bridge = new CodexBridgeClass()
    const runnerCleanup = vi.fn()

    vi.spyOn(bridge as any, 'createRunner').mockResolvedValue({
      transport: 'exec',
      events: (async function* () {
        throw new Error('Codex stream exploded')
      })(),
      cleanup: runnerCleanup
    })

    const result = await bridge.streamNativeMode(buildRequest())

    await expect(collectStream(result.fullStream)).rejects.toThrow('Codex stream exploded')
    expect(runnerCleanup).toHaveBeenCalledTimes(1)
    expect(mockRedisClient.sRem).toHaveBeenCalledWith(
      'codex_sessions:user-123:agent-123',
      'sess-one'
    )
  })

  it('throws descriptive error when CLI is unavailable', async () => {
    const bridge = new CodexBridgeClass()

    const detectSpy = vi
      .spyOn(codexCliStatusModule, 'detectCodexCliStatus')
      .mockResolvedValue({ available: false, error: 'Codex CLI missing' })

    await expect(
      (bridge as any).runViaCli('Prompt', {
        model: undefined,
        sandboxMode: 'read-only',
        workingDirectory: process.cwd(),
        allowFileEdits: false,
        allowNetwork: false,
        managedConfigHome: '/tmp/codex-home',
        signal: undefined
      })
    ).rejects.toThrow('Codex CLI missing')

    expect(detectSpy).toHaveBeenCalledWith({ codexHome: '/tmp/codex-home' })
  })

  it('redacts data image URLs when building Codex prompts', () => {
    const rawBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    const prompt = buildCodexPromptFromMessages({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `Here is image data: data:image/png;base64,${rawBase64}` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${rawBase64}` } }
          ]
        }
      ],
      images: [{ url: `data:image/png;base64,${rawBase64}` }]
    })

    expect(prompt).toContain('data URL redacted')
    expect(prompt).not.toContain(rawBase64)
  })

  it('lifts system messages into Codex developer instructions', () => {
    const promptPackage = buildCodexPromptPackageFromMessages({
      messages: [
        { role: 'system', content: 'Stable Batshit system prompt' },
        { role: 'user', content: 'Current user payload' }
      ]
    })

    expect(promptPackage.developerInstructions).toContain(
      '==== BATSHIT PRIMARY SYSTEM PROMPT ===='
    )
    expect(promptPackage.developerInstructions).toContain('Stable Batshit system prompt')
    expect(promptPackage.staticPromptPrefix).toContain(
      '==== BATSHIT PRIMARY SYSTEM PROMPT ===='
    )
    expect(promptPackage.staticPromptPrefix).toContain('Stable Batshit system prompt')
    expect(promptPackage.prompt).toContain('Message 1 - USER')
    expect(promptPackage.prompt).toContain('Current user payload')
    expect(promptPackage.prompt).not.toContain('Stable Batshit system prompt')
  })

  it('refuses an app-server run when compiled developer instructions are empty', async () => {
    const bridge = new CodexBridgeClass()
    await expect(
      (bridge as any).runViaAppServer('Current user payload', {
        developerInstructions: '   '
      })
    ).rejects.toThrow(/compiled developer instructions are empty/)
  })

  it('uses documented JSON output and ephemeral mode when history persistence is none', () => {
    const args = buildCodexCliArgs({
      model: 'gpt-5.4',
      permissionMode: 'chat',
      sandboxMode: 'read-only',
      workingDirectory: process.cwd(),
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: 'never',
      webSearchEnabled: true,
      addDirectories: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      defaultGateways: null,
      profileName: 'batshit_agent_test',
      configScope: 'managed',
      managedConfigHome: '/tmp/codex-home',
      dockerAuthToken: null,
      n8nInstanceMcpToken: null,
      batshitToken: null,
      historyPersistence: 'none',
      serviceTier: 'standard',
      permissionOverridden: false,
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      modelSupportsReasoningSummaries: true,
      signal: undefined,
      unifiedExec: true,
      imagePaths: [],
      sessionId: 'sess-one',
      promptCacheKey: 'batshit:batshit_agent_test:sess-one:abcdef123456',
      developerInstructions: 'Stable Batshit system prompt',
      nativeSkillDisablePaths: [
        '/tmp/project/.agents/skills/story-ops/SKILL.md',
        '/tmp/codex-home/skills/.system/openai-docs/SKILL.md'
      ]
    }, {
      useProfileDefaults: true,
      shouldSkipGitCheck: false
    })

    expect(args).toContain('--json')
    expect(args).toContain('--ephemeral')
    expect(args).toContain('default_tools_enabled=false')
    expect(args).toContain('model_reasoning_summary=auto')
    expect(args).toContain('model_supports_reasoning_summaries=true')
    expect(args).toContain('prompt_cache_key="batshit:batshit_agent_test:sess-one:abcdef123456"')
    expect(args).toContain('developer_instructions="Stable Batshit system prompt"')
    expect(args).toContain(
      'skills.config=[{path="/tmp/codex-home/skills/.system/openai-docs/SKILL.md",enabled=false},{path="/tmp/project/.agents/skills/story-ops/SKILL.md",enabled=false}]'
    )
    expect(args).not.toContain('--experimental-json')
  })

  it('forces selected model and disables Codex default tools for managed config runs', () => {
    const args = buildCodexCliArgs({
      model: 'gpt-5.5',
      permissionMode: 'chat',
      sandboxMode: 'read-only',
      workingDirectory: process.cwd(),
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: 'never',
      webSearchEnabled: true,
      addDirectories: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      defaultGateways: null,
      profileName: 'batshit_agent_test',
      configScope: 'managed',
      managedConfigHome: '/tmp/codex-home',
      dockerAuthToken: null,
      n8nInstanceMcpToken: null,
      batshitToken: null,
      historyPersistence: 'none',
      serviceTier: 'standard',
      permissionOverridden: false,
      reasoningEffort: 'high',
      signal: undefined,
      unifiedExec: true,
      imagePaths: [],
      sessionId: 'sess-one',
      nativeSkillDisablePaths: []
    }, {
      useProfileDefaults: false,
      shouldSkipGitCheck: false
    })

    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.5')
    expect(args).toContain('model=gpt-5.5')
    expect(args).toContain('default_tools_enabled=false')
    expect(args).not.toContain('--profile')
  })

  it('uses explicit sandbox and approval config for agent mode without the removed full-auto flag', () => {
    const args = buildCodexCliArgs({
      model: 'gpt-5.5',
      permissionMode: 'agent',
      sandboxMode: 'workspace-write',
      workingDirectory: process.cwd(),
      allowFileEdits: true,
      allowNetwork: true,
      approvalPolicy: 'on-failure',
      webSearchEnabled: true,
      addDirectories: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      defaultGateways: null,
      profileName: 'batshit_agent_test',
      configScope: 'managed',
      managedConfigHome: '/tmp/codex-home',
      dockerAuthToken: null,
      n8nInstanceMcpToken: null,
      batshitToken: null,
      historyPersistence: 'none',
      serviceTier: 'standard',
      permissionOverridden: false,
      reasoningEffort: 'high',
      signal: undefined,
      unifiedExec: true,
      imagePaths: [],
      sessionId: 'sess-one',
      nativeSkillDisablePaths: []
    }, {
      useProfileDefaults: false,
      shouldSkipGitCheck: false
    })

    expect(args).toContain('--sandbox')
    expect(args).toContain('workspace-write')
    expect(args).toContain('sandbox_mode=workspace-write')
    expect(args).toContain('approval_policy=on-failure')
    expect(args).not.toContain('--full-auto')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('builds a native Codex skill disable config override', () => {
    expect(
      buildCodexNativeSkillDisableOverride([
        '/tmp/project/.agents/skills/story-ops/SKILL.md',
        '/tmp/project/.agents/skills/story-ops/SKILL.md',
        ' /tmp/codex-home/skills/.system/openai-docs/SKILL.md '
      ])
    ).toBe(
      'skills.config=[{path="/tmp/codex-home/skills/.system/openai-docs/SKILL.md",enabled=false},{path="/tmp/project/.agents/skills/story-ops/SKILL.md",enabled=false}]'
    )

    expect(buildCodexNativeSkillDisableOverride([])).toBeNull()
  })

  it('redacts developer instructions and native skill disable config from CLI logs', () => {
    const args = [
      'exec',
      '--json',
      '--config',
      'developer_instructions="secret system prompt"',
      '--config',
      'skills.config=[{path="/tmp/project/.agents/skills/story-ops/SKILL.md",enabled=false}]',
      '--config',
      'prompt_cache_key="visible-cache-key"'
    ]

    const redacted = redactCodexCliArgsForLog(args)

    expect(redacted).toContain('developer_instructions=<redacted>')
    expect(redacted).not.toContain('developer_instructions="secret system prompt"')
    expect(redacted).toContain('skills.config=<redacted>')
    expect(redacted).not.toContain('/tmp/project/.agents/skills/story-ops/SKILL.md')
    expect(redacted).toContain('prompt_cache_key="visible-cache-key"')
  })

  it('builds stable managed prompt cache keys without using message ids', () => {
    const first = buildManagedCodexPromptCacheKey({
      sessionId: 'sess-one',
      profileName: 'batshit_agent_codex',
      workingDirectory: '/Users/example/batshit',
      model: 'gpt-5.5',
      staticPromptPrefix: 'Stable Batshit system prompt'
    })
    const second = buildManagedCodexPromptCacheKey({
      sessionId: 'sess-two',
      profileName: 'batshit_agent_codex',
      workingDirectory: '/Users/example/batshit',
      model: 'gpt-5.5',
      staticPromptPrefix: 'Stable Batshit system prompt'
    })
    const changedProject = buildManagedCodexPromptCacheKey({
      sessionId: 'sess-one',
      profileName: 'batshit_agent_codex',
      workingDirectory: '/Users/example/hello',
      model: 'gpt-5.5',
      staticPromptPrefix: 'Stable Batshit system prompt'
    })
    const changedPrompt = buildManagedCodexPromptCacheKey({
      sessionId: 'sess-one',
      profileName: 'batshit_agent_codex',
      workingDirectory: '/Users/example/batshit',
      model: 'gpt-5.5',
      staticPromptPrefix: 'Changed Batshit system prompt'
    })

    expect(first).toBe(second)
    expect(first).toMatch(/^batshit:batshit_agent_codex:prefix:[a-f0-9]{16}$/)
    expect(changedProject).not.toBe(first)
    expect(changedPrompt).not.toBe(first)
    expect(buildManagedCodexPromptCacheKey({ sessionId: null })).toMatch(
      /^batshit:batshit_agent:prefix:[a-f0-9]{16}$/
    )
  })

  it('writes Codex web search as the current string config mode for profile defaults', () => {
    const args = buildCodexCliArgs({
      model: 'gpt-5.5',
      permissionMode: 'chat',
      sandboxMode: 'read-only',
      workingDirectory: process.cwd(),
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: 'never',
      webSearchEnabled: true,
      addDirectories: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      defaultGateways: null,
      profileName: 'batshit_agent_test',
      configScope: 'global',
      managedConfigHome: null,
      dockerAuthToken: null,
      n8nInstanceMcpToken: null,
      batshitToken: null,
      historyPersistence: 'none',
      serviceTier: 'standard',
      permissionOverridden: false,
      reasoningEffort: 'high',
      signal: undefined,
      unifiedExec: true,
      imagePaths: [],
      sessionId: 'sess-one'
    }, {
      useProfileDefaults: true,
      shouldSkipGitCheck: false
    })

    expect(args).toContain('web_search="live"')
    expect(args).not.toContain('web_search=true')
  })

  it('builds hidden compact worker args without loading managed tools or web search', () => {
    const args = buildCodexCliArgs({
      model: 'gpt-5.5',
      permissionMode: 'chat',
      sandboxMode: 'read-only',
      workingDirectory: '/tmp',
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: 'never',
      webSearchEnabled: false,
      addDirectories: ['/should-not-load'],
      enableFeatures: ['should_not_load'],
      disableFeatures: [],
      configOverrides: [{ key: 'mcp_servers.example.disabled', value: 'false' }],
      defaultGateways: null,
      profileName: 'batshit_agent_test',
      configScope: 'global',
      managedConfigHome: '/tmp/codex-home',
      dockerAuthToken: null,
      n8nInstanceMcpToken: null,
      batshitToken: null,
      historyPersistence: 'none',
      serviceTier: 'standard',
      permissionOverridden: true,
      reasoningEffort: 'xhigh',
      signal: undefined,
      unifiedExec: true,
      imagePaths: [],
      sessionId: null,
      ignoreUserConfig: true,
      ignoreRules: true
    }, {
      useProfileDefaults: false,
      shouldSkipGitCheck: true
    })

    expect(args).toContain('--ignore-user-config')
    expect(args).toContain('--ignore-rules')
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.5')
    expect(args).toContain('--sandbox')
    expect(args).toContain('read-only')
    expect(args).toContain('approval_policy=never')
    expect(args).toContain('default_tools_enabled=false')
    expect(args).toContain('web_search="disabled"')
    expect(args).toContain('--ephemeral')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).not.toContain('--profile')
    expect(args).not.toContain('--add-dir')
    expect(args).not.toContain('--enable')
    expect(args).not.toContain('mcp_servers.example.disabled=false')
  })

  it('routes hidden summary generation through the guarded app-server lane', async () => {
    const bridge = new CodexBridgeClass()
    const runViaAppServer = vi.spyOn(bridge as any, 'runViaAppServer').mockResolvedValue({
      transport: 'app-server',
      events: (async function* () {
        yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Summary' } }
        yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }
      })()
    })

    await expect(
      bridge.generateHiddenText({
        prompt: 'Summarize this transcript.',
        userId: 'user-123',
        model: 'gpt-5.5',
        codexSettings: buildCodexRuntimeSettings()
      })
    ).resolves.toMatchObject({ text: 'Summary', transport: 'cli' })

    expect(runViaAppServer).toHaveBeenCalledOnce()
    const options = runViaAppServer.mock.calls[0]?.[1]
    expect(options).toMatchObject({
      sandboxMode: 'read-only',
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: 'never',
      webSearchEnabled: false,
      historyPersistence: 'none',
      ignoreUserConfig: true,
      ignoreRules: true
    })
    expect(options.developerInstructions).toContain('hidden maintenance summarizer')
  })
})

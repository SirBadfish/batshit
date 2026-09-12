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

/**
 * SA-117 P2 — the bridge mints a run credential at run start, so this fake has to serve
 * `agentRunCredentials.ts`: `redis.get('agent:…')` for the ownership check, `json.set` +
 * `expire` for the record, `execute(sAdd)` for the index, and `del` for the revoke.
 *
 * It records what was written so the tests below can assert the credential's LIFECYCLE
 * (minted with the run's ids, revoked when the run ends) rather than only its presence.
 */
const mintedCredentialRecords: Array<{ key: string; record: any }> = []
const deletedKeys: string[] = []

const mockRedis = {
  getProjectPreferences: vi.fn().mockResolvedValue(null),
  getAgents: vi.fn().mockResolvedValue([]),
  get: vi.fn(async (key: string) =>
    key === 'agent:agent-123' ? { id: 'agent-123', user_id: 'user-123' } : null
  ),
  json: {
    get: vi.fn(async (key: string) => {
      const entry = [...mintedCredentialRecords].reverse().find((item) => item.key === key)
      if (!entry) return null
      return deletedKeys.includes(key) ? null : entry.record
    }),
    set: vi.fn(async (key: string, path: string, value: any) => {
      if (path === '$') mintedCredentialRecords.push({ key, record: value })
      return 'OK'
    }),
    numIncrBy: vi.fn().mockResolvedValue(1)
  },
  expire: vi.fn().mockResolvedValue(true),
  del: vi.fn(async (key: string) => {
    deletedKeys.push(key)
    return 1
  }),
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
  mintedCredentialRecords.length = 0
  deletedKeys.length = 0
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
  /* ------------------------------------------------------------------ *
   * SA-117 P2 (DL-117-06, DL-117-07) — the run credential's life on the Codex lane.
   * ------------------------------------------------------------------ */

  describe('SA-117: the run credential', () => {
    it('mints one for this run and hands its token to the child, never the instance token', async () => {
      const bridge = new CodexBridgeClass()
      let receivedRunOptions: Record<string, any> | null = null

      vi.spyOn(bridge as any, 'runViaCli').mockImplementation(
        async (_prompt: unknown, options: unknown) => {
          receivedRunOptions = options as Record<string, any>
          return {
            transport: 'exec',
            events: (async function* () {
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
            })()
          }
        }
      )

      const result = await bridge.streamNativeMode(buildRequest())
      await collectStream(result.fullStream)

      expect(mintedCredentialRecords).toHaveLength(1)
      const record = mintedCredentialRecords[0]!.record
      expect(record).toMatchObject({
        userId: 'user-123',
        agentId: 'agent-123',
        sessionId: 'sess-one',
        messageId: 'msg-one',
        runtime: 'codex'
      })
      // The SECRET is never stored — only its hash — and the token is `<id>.<secret>`.
      expect(record.tokenHash).toEqual(expect.any(String))
      expect(receivedRunOptions).toBeTruthy()
      expect(receivedRunOptions!.agentRunToken).toMatch(/^arc_[A-Za-z0-9_-]+\.bsac_/)
      expect(receivedRunOptions!.agentRunToken.startsWith(`${record.id}.`)).toBe(true)
      expect(receivedRunOptions).not.toHaveProperty('batshitToken')
    })

    it('revokes it when the run ends', async () => {
      const bridge = new CodexBridgeClass()

      vi.spyOn(bridge as any, 'runViaCli').mockResolvedValue({
        transport: 'exec',
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
        })()
      })

      const result = await bridge.streamNativeMode(buildRequest())
      const credentialId = mintedCredentialRecords[0]!.record.id
      expect(deletedKeys).not.toContain(`agent_run_credential:${credentialId}`)

      await collectStream(result.fullStream)

      expect(deletedKeys).toContain(`agent_run_credential:${credentialId}`)
      // F-P1-5: the bridge passes the agent it minted for, so the index member is pruned
      // even when the 24 h backstop already reaped the record.
      expect(mockRedisClient.sRem).toHaveBeenCalledWith('agent_run_credentials:agent-123', [
        credentialId
      ])
    })

    it('prunes the index by the minted agent even after the TTL reaped the record', async () => {
      // F-P1-5, at the bridge. A record the 24 h backstop already reaped cannot say which
      // agent's index it sat in, so the caller that KNOWS — this bridge, which minted it for
      // one agent — passes the hint. Without it, a crash-then-restart leaves one stale
      // member per orphaned run, and nothing in production ever lists that index to prune it.
      const bridge = new CodexBridgeClass()

      vi.spyOn(bridge as any, 'runViaCli').mockResolvedValue({
        transport: 'exec',
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
        })()
      })

      const result = await bridge.streamNativeMode(buildRequest())
      const credentialId = mintedCredentialRecords[0]!.record.id

      // The TTL reaps the record mid-run: the key is gone, the index member is not.
      deletedKeys.push(`agent_run_credential:${credentialId}`)
      mockRedisClient.sRem.mockClear()

      await collectStream(result.fullStream)

      expect(mockRedisClient.sRem).toHaveBeenCalledWith('agent_run_credentials:agent-123', [
        credentialId
      ])
    })

    it('revokes it when the stream throws, not only when it finishes', async () => {
      const bridge = new CodexBridgeClass()

      vi.spyOn(bridge as any, 'createRunner').mockResolvedValue({
        transport: 'exec',
        events: (async function* () {
          throw new Error('Codex stream exploded')
        })()
      })

      const result = await bridge.streamNativeMode(buildRequest())
      const credentialId = mintedCredentialRecords[0]!.record.id
      await expect(collectStream(result.fullStream)).rejects.toThrow('Codex stream exploded')

      expect(deletedKeys).toContain(`agent_run_credential:${credentialId}`)
    })

    it('revokes it when the spawn itself fails, which never reaches the stream cleanup', async () => {
      const bridge = new CodexBridgeClass()

      vi.spyOn(bridge as any, 'createRunner').mockRejectedValue(new Error('Codex CLI missing'))

      await expect(bridge.streamNativeMode(buildRequest())).rejects.toThrow('Codex CLI missing')

      expect(mintedCredentialRecords).toHaveLength(1)
      const credentialId = mintedCredentialRecords[0]!.record.id
      expect(deletedKeys).toContain(`agent_run_credential:${credentialId}`)
    })

    it('mints nothing when the run has no session to bind to, and says so', async () => {
      const bridge = new CodexBridgeClass()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let receivedRunOptions: Record<string, any> | null = null

      vi.spyOn(bridge as any, 'runViaCli').mockImplementation(
        async (_prompt: unknown, options: unknown) => {
          receivedRunOptions = options as Record<string, any>
          return {
            transport: 'exec',
            events: (async function* () {
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
            })()
          }
        }
      )

      const result = await bridge.streamNativeMode(buildRequest({ sessionId: undefined }))
      await collectStream(result.fullStream)

      expect(mintedCredentialRecords).toHaveLength(0)
      expect(receivedRunOptions!.agentRunToken).toBeNull()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('No run credential was minted'))
    })

    it('F-P2-1: a delegated run mints for its runtime id, with no agent record to read', async () => {
      // The live Worker spawn found this: `subagentRunner.ts` launches a Subagent or Worker
      // with `agentId = subagent_cli_<slug>`, and nothing is stored at `agent:{that id}`.
      const bridge = new CodexBridgeClass()

      vi.spyOn(bridge as any, 'runViaCli').mockResolvedValue({
        transport: 'exec',
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
        })()
      })

      const result = await bridge.streamNativeMode(
        buildRequest({ agentId: 'subagent_cli_worker_agent_123_1', delegatedRun: true } as any)
      )
      await collectStream(result.fullStream)

      expect(mintedCredentialRecords).toHaveLength(1)
      expect(mintedCredentialRecords[0]!.record).toMatchObject({
        agentId: 'subagent_cli_worker_agent_123_1',
        delegated: true
      })
    })

    it('DL-117-07: the child env drops BATSHIT_TOKEN and carries the credential', () => {
      const bridge = new CodexBridgeClass()
      const previousInstance = process.env.BATSHIT_TOKEN
      const previousGateway = process.env.MCP_GATEWAY_AUTH_TOKEN
      process.env.BATSHIT_TOKEN = 'instance-secret'
      process.env.MCP_GATEWAY_AUTH_TOKEN = 'inherited-gateway-token'

      try {
        const childEnv = (bridge as any).buildCodexChildEnv({
          agentRunToken: 'arc_abc.bsac_secret',
          dockerAuthToken: null,
          sessionId: 'sess-one',
          messageId: 'msg-one'
        }) as NodeJS.ProcessEnv

        expect(childEnv.BATSHIT_TOKEN).toBeUndefined()
        expect(childEnv.BATSHIT_AGENT_TOKEN).toBe('arc_abc.bsac_secret')
        // A run with no Docker gateway does not get the gateway's secret either, even
        // though the app's own environment carries one.
        expect(childEnv.MCP_GATEWAY_AUTH_TOKEN).toBeUndefined()
        // The honest boundary (SA-117 Scope): Redis and provider secrets still travel.
        expect(childEnv.PATH).toBe(process.env.PATH)
      } finally {
        if (previousInstance === undefined) delete process.env.BATSHIT_TOKEN
        else process.env.BATSHIT_TOKEN = previousInstance
        if (previousGateway === undefined) delete process.env.MCP_GATEWAY_AUTH_TOKEN
        else process.env.MCP_GATEWAY_AUTH_TOKEN = previousGateway
      }
    })

    it('DL-117-07: a run WITH a Docker gateway keeps the gateway token', () => {
      const bridge = new CodexBridgeClass()
      const previousInstance = process.env.BATSHIT_TOKEN
      process.env.BATSHIT_TOKEN = 'instance-secret'

      try {
        const childEnv = (bridge as any).buildCodexChildEnv({
          agentRunToken: 'arc_abc.bsac_secret',
          dockerAuthToken: 'run-gateway-token'
        }) as NodeJS.ProcessEnv

        expect(childEnv.MCP_GATEWAY_AUTH_TOKEN).toBe('run-gateway-token')
        expect(childEnv.BATSHIT_TOKEN).toBeUndefined()
      } finally {
        if (previousInstance === undefined) delete process.env.BATSHIT_TOKEN
        else process.env.BATSHIT_TOKEN = previousInstance
      }
    })
  })
})

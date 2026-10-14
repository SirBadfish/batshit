import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cliSubagentMocks = vi.hoisted(() => ({
  codexStreamNativeMode: vi.fn(),
  claudeStreamNativeMode: vi.fn(),
  prepareManagedCodexSubagentProfile: vi.fn(),
  prepareManagedClaudeSubagentProfile: vi.fn(),
  buildAgentProfileId: vi.fn((value: string) => `batshit_agent_${value.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`),
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
      // This fake never spawns Codex, so its prepared admission ends at this boundary.
      streamNativeMode: async (request: unknown, lease?: { abortBeforeSpawn: () => void }) => {
        try { return await cliSubagentMocks.codexStreamNativeMode(request, lease) }
        finally { lease?.abortBeforeSpawn() }
      },
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

// BL-287: the stopped CLI's kill grace and the run's bound, shortened per test; everything else
// is the real module.
const settleBounds = vi.hoisted(() => ({ killGraceMs: 15_000, boundMs: 25_000 }))
vi.mock('$lib/server/services/subagentRunSettle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/subagentRunSettle')>()
  return {
    ...actual,
    settleSubagentRunWork: (options: Parameters<typeof actual.settleSubagentRunWork>[0]) =>
      actual.settleSubagentRunWork({ ...options, ...settleBounds }),
  }
})

vi.mock('$lib/server/services/slashCommandCapabilities', () => ({
  getEnabledAgentSlashCapabilities: (...args: any[]) =>
    cliSubagentMocks.getEnabledAgentSlashCapabilities(...args),
  buildSkillsCommandsDcmLines: (...args: any[]) =>
    cliSubagentMocks.buildSkillsCommandsDcmLines(...args),
}))

import { createSubagentRedisMock } from '$lib/test-utils/subagent-redis-mock'
import {
  acquireSubagentRunLock,
  buildSubagentRunLockKey,
  buildSubagentThreadKey,
  releaseSubagentRunLock,
} from '../subagentThreads'
import {
  hasRunningSubagentRun,
  isSubagentDeletedError,
  stopSubagentRunsForDelete,
} from '../subagentRunRegistry'
import { executeManagedSubagent as runManagedSubagent } from '../subagentRunner'
import * as profileFolderGate from '../agentProfileFolderGate'

const subagentRedis = createSubagentRedisMock()
cliSubagentMocks.redisStore.current = subagentRedis

// BL-287: the runner refuses a Subagent whose record is gone (a turn that loaded it before its
// delete), so each call stores the record it runs first, as a real Subagent's is.
async function executeManagedSubagent(params: Parameters<typeof runManagedSubagent>[0]) {
  const id = typeof params.subagent?.id === 'string' ? params.subagent.id.trim() : ''
  if (id && params.delegationKind !== 'worker') subagentRedis.seed(`subagent:${id}`, params.subagent)
  return runManagedSubagent(params)
}

function streamFromChunks(chunks: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  }
}

const startedClis: ChildProcess[] = []

/**
 * A real process standing in for the CLI: it exits `exitAfterTermMs` after SIGTERM, or ignores
 * SIGTERM (`null`), the way a CLI that does not honour its stop does.
 */
function startCli(exitAfterTermMs: number | null): Promise<ChildProcess> {
  const onTerm =
    exitAfterTermMs === null ? '' : `setTimeout(() => process.exit(0), ${exitAfterTermMs})`
  const child = spawn(
    process.execPath,
    ['-e', `process.on('SIGTERM', () => { ${onTerm} }); console.log('up'); setInterval(() => {}, 1000)`],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  startedClis.push(child)
  return new Promise((resolve) => child.stdout!.once('data', () => resolve(child)))
}

/**
 * The Codex app-server lane's shape on a Stop: its stream ends the moment SIGTERM is SENT to
 * the process (the process exits after that, on its own time), and it hands the runner the
 * process as `__cliProcess`.
 */
function runUntilStopped(cli: ChildProcess, events: string[]) {
  return async (request: any) => ({
    stream: {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: 'working' }
        await new Promise<void>((resolve) =>
          request.abortSignal.addEventListener('abort', () => resolve(), { once: true }),
        )
        cli.kill('SIGTERM')
        events.push('CLI told to stop')
        throw Object.assign(new Error('Codex run aborted by user'), { name: 'AbortError' })
      },
    },
    __detectToolSource: vi.fn(() => null),
    __cliProcess: cli,
  })
}

async function until(condition: () => boolean) {
  for (let tries = 0; !condition() && tries < 200; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

function deletedHelper(id = 'deleted-helper') {
  return {
    id,
    user_id: 'user-1',
    displayName: 'Deleted Helper',
    subagentType: 'cli' as const,
    primary_model_provider: 'openai-codex',
    primary_model_name: 'codex-cli',
    codex_settings: { model: 'gpt-5.4' },
  }
}

describe('executeManagedSubagent - CLI subagents', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const child of startedClis.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    settleBounds.killGraceMs = 15_000
    settleBounds.boundMs = 25_000

    subagentRedis.clear()
    subagentRedis.seed('batshit:sub_system_prompt', '# Base subagent prompt')
    subagentRedis.seed('agent:agent-1', { id: 'agent-1', user_id: 'user-1' })
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
      profileId: 'batshit_agent_subagent_cli_builder',
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

  it.each([
    ['codex', 'subagent'], ['claude', 'subagent'],
    ['codex', 'worker'], ['claude', 'worker'],
  ] as const)('refuses a %s %s profile when its stored owner disappears during setup', async (runtime, kind) => {
    let reached!: () => void
    let resume!: () => void
    const atWrite = new Promise<void>((resolve) => { reached = resolve })
    const continueWrite = new Promise<void>((resolve) => { resume = resolve })
    const realAdmission = profileFolderGate.withManagedProfileRunWrite
    // Pause the actual runner at its folder admission, after Codex's host lease when
    // applicable. The real gate and its Redis read still decide whether a write is allowed.
    const admission = vi.spyOn(profileFolderGate, 'withManagedProfileRunWrite').mockImplementation(async (...args) => {
      reached()
      await continueWrite
      return realAdmission(...args)
    })
    const subagent = {
      ...deletedHelper('profile-race'),
      ...(runtime === 'claude' ? {
        primary_model_provider: 'anthropic-claude',
        primary_model_name: 'claude-cli',
        claude_settings: { model: 'claude-sonnet-4-5' },
      } : {}),
    }
    try {
      const running = executeManagedSubagent({
        userId: 'user-1', sessionId: 'profile-race-session', chatInput: 'Inspect.',
        parentAgentId: 'agent-1', parentModelId: 'gpt-5.4',
        delegationKind: kind, subagent,
      })
      await Promise.race([
        atWrite,
        running.then(() => { throw new Error('Run bypassed profile admission') }),
      ])
      await subagentRedis.redis.del(kind === 'worker' ? 'agent:agent-1' : 'subagent:profile-race')
      resume()
      await expect(running).resolves.toMatchObject({
        status: 'failed', output: expect.stringMatching(/owner was deleted|owner.*unavailable/),
      })
      expect(cliSubagentMocks.prepareManagedCodexSubagentProfile).not.toHaveBeenCalled()
      expect(cliSubagentMocks.prepareManagedClaudeSubagentProfile).not.toHaveBeenCalled()
      expect(cliSubagentMocks.codexStreamNativeMode).not.toHaveBeenCalled()
      expect(cliSubagentMocks.claudeStreamNativeMode).not.toHaveBeenCalled()
    } finally {
      resume()
      admission.mockRestore()
    }
  })

  it('routes Codex CLI subagents through the managed Codex bridge', async () => {
    const abortController = new AbortController()
    // BL-81: a real scope shape, Fetch Zip off, so the minted control scope is not trivially
    // everything or nothing.
    const scope = {
      subagentType: 'cli',
      nativeToolSettings: {
        fetchZipEnabled: false,
        dynamicMcpEnabled: true,
        cliToolsEnabled: true,
        artifactRuntimeEnabled: true,
        batshitToolsEnabled: true,
        agentBrowserEnabled: true,
      },
      defaultMcpGateways: ['gw-1'],
      resolvedGateways: ['gw-1'],
      defaultCliToolIds: ['cli-tool-1'],
      resolvedCliToolIds: ['cli-tool-1'],
      defaultMcpToolSelections: ['tool-a'],
      dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
      projectPath: '/Users/example/hello',
    }
    cliSubagentMocks.resolveManagedSubagentScope.mockResolvedValue(scope)
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
      // SA-117 F-P2-1: this run's `agentId` is `subagent_cli_<slug>`, a per-run runtime id
      // with no `agent:` record behind it. The marker is what lets the bridge mint a
      // credential for it at all, and what stops that credential acting as an agent.
      delegatedRun: true,
      processOwner: { userId: 'user-1', kind: 'subagent', id: 'builder' },
      commandParentAgentId: 'agent-1',
      // BL-75: the subagent's own id rides to the credential, so its native_skill loads are
      // checked against its own skills list, not the parent's and not the runtime id's.
      scopeAgentId: 'builder',
      // BL-81: and so does what it may use through the control routes — exactly what its DCM
      // index offers it. Fetch Zip is off here, so only the published artifact tools.
      delegatedAllowedControlIds: ['use.artifact.*'],
    })
    // The DCM that offered those tools was built from the very same resolved scope.
    expect(cliSubagentMocks.buildManagedSubagentDynamicInfo).toHaveBeenCalledWith(
      expect.objectContaining({ scope }),
    )
    expect(cliSubagentMocks.codexStreamNativeMode.mock.calls[0]?.[0]?.agentId).toMatch(
      /^subagent_cli_/,
    )
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

  // BL-759: Codex dropped the Subagent's answer mid-stream and started it again; the parent
  // gets the retried answer only, never the fragment glued in front of it.
  it('hands the parent the retried answer, without the fragment Codex took back', async () => {
    cliSubagentMocks.codexStreamNativeMode.mockResolvedValue({
      stream: streamFromChunks([
        { type: 'text-delta', text: 'Partial ', segmentId: 'msg_1' },
        { type: 'text-delta', text: 'before the drop ', segmentId: 'msg_1' },
        { type: 'text-retract', segmentId: 'msg_1', reason: 'retry', message: 'Reconnecting... 1/5' },
        { type: 'text-delta', text: 'Hello after the retry.', segmentId: 'msg_2' },
      ]),
      __detectToolSource: vi.fn(() => ({})),
    })

    const result = await executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Say hello.',
      parentAgentId: 'agent-1',
      projectPath: '/Users/example/hello',
      subagent: {
        id: 'codex-retry',
        user_id: 'user-1',
        displayName: 'Codex Retry',
        subagentType: 'cli',
        primary_model_provider: 'openai-codex',
        primary_model_name: 'codex-cli',
        codex_settings: { model: 'gpt-5.4' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })

    expect(result.status).toBe('completed')
    expect(result.output).toBe('Hello after the retry.')
  })

  it('routes Claude CLI subagents through the managed Claude bridge', async () => {
    cliSubagentMocks.resolveManagedSubagentScope.mockResolvedValue({
      subagentType: 'cli',
      // A real CLI scope: its tools come from the CLI profile, which turns Fetch Zip and Batshit
      // Tools off whatever the record says (`resolveManagedSubagentScope`, BL-81 follow-up).
      nativeToolSettings: {
        fetchZipEnabled: false,
        dynamicMcpEnabled: true,
        cliToolsEnabled: true,
        artifactRuntimeEnabled: true,
        batshitToolsEnabled: false,
        agentBrowserEnabled: true,
      },
      defaultMcpGateways: ['gw-1'],
      resolvedGateways: ['gw-1'],
      defaultCliToolIds: ['cli-tool-1'],
      resolvedCliToolIds: ['cli-tool-1'],
      defaultMcpToolSelections: ['tool-a'],
      dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
      projectPath: '/Users/example/hello',
    })
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
    // SA-117 F-P2-1, the Claude half of the same claim (and BL-75's skill scope).
    expect(cliSubagentMocks.claudeStreamNativeMode.mock.calls[0]?.[0]).toMatchObject({
      delegatedRun: true,
      processOwner: { userId: 'user-1', kind: 'subagent', id: 'reviewer' },
      commandParentAgentId: 'agent-1',
      scopeAgentId: 'reviewer',
      // BL-81, the Claude half: the published artifact tools, and no Fetch Zip on the CLI lane.
      delegatedAllowedControlIds: ['use.artifact.*'],
    })
    expect(cliSubagentMocks.claudeStreamNativeMode.mock.calls[0]?.[0]?.agentId).toMatch(
      /^subagent_cli_/,
    )
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

  const observedHelper = () => ({
    id: 'observation-helper', user_id: 'user-1', displayName: 'Observed Helper', subagentType: 'cli' as const,
    primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli', codex_settings: { model: 'gpt-5.4' },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  const observation = (counts: Record<string, number>) => ({ completeness: 'partial' as const, parts: [{ source: 'codex-app-server-progress' as const, counts }] })

  it('returns failed child observations while keeping canonical totals null', async () => {
    let requestSeen: any
    cliSubagentMocks.codexStreamNativeMode.mockImplementationOnce(async (request: any) => {
      requestSeen = request
      const getter = vi.fn(() => observation({ inputTokens: 100, outputTokens: 0, totalTokens: 100 }))
      request.registerObservedUsageSource?.(getter)
      expect(getter).not.toHaveBeenCalled()
      return { stream: { async *[Symbol.asyncIterator]() {
        try { yield { type: 'text-delta', text: 'partial helper work' }; throw new Error('helper failed after observed work') }
        finally { await request.onFinish?.({ observedUsage: getter() }) }
      } } }
    })
    const result = await executeManagedSubagent({ userId: 'user-1', sessionId: 'session-1', chatInput: 'Work', subagent: observedHelper() } as any)
    expect(result).toMatchObject({ status: 'failed', usage: null, observedUsage: observation({ inputTokens: 100, outputTokens: 0, totalTokens: 100 }) })
    expect(result.output).toContain('helper failed after observed work')
    await requestSeen.onFinish?.({ totalUsage: { inputTokens: 999, outputTokens: 999 } })
    expect(result.usage).toBeNull(); expect(result.observedUsage?.parts[0].counts.inputTokens).toBe(100)
  })

  it('freezes at the outer deadline before finalizer/cleanup and ignores their late reports', async () => {
    let finish!: () => void, entered!: () => void
    const released = new Promise<void>((resolve) => { finish = resolve })
    const atStream = new Promise<void>((resolve) => { entered = resolve })
    let requestSeen: any, finalizerRan = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cliSubagentMocks.codexStreamNativeMode.mockImplementationOnce(async (request: any) => {
      requestSeen = request
      request.registerObservedUsageSource?.(() => observation({ cacheCreationInputTokens: 0, reasoningTokens: 3 }))
      return { stream: { async *[Symbol.asyncIterator]() {
        entered()
        await released
        finalizerRan = true
        await request.onFinish?.({ totalUsage: { inputTokens: 999, outputTokens: 999 } })
        throw new Error('late lane unwound')
      } } }
    })
    const running = executeManagedSubagent({ userId: 'user-1', sessionId: 'session-1', chatInput: 'Work', subagent: { ...observedHelper(), timeout_seconds: 10 } } as any)
    await atStream
    await vi.advanceTimersByTimeAsync(10_001)
    const result = await running
    expect(finalizerRan).toBe(false)
    expect(result).toMatchObject({ status: 'timed_out', usage: null, observedUsage: observation({ cacheCreationInputTokens: 0, reasoningTokens: 3 }) })
    requestSeen.registerObservedUsageSource?.(() => observation({ inputTokens: 1000 }))
    finish()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    expect(finalizerRan).toBe(true)
    expect(result.observedUsage?.parts[0].counts).toEqual({ cacheCreationInputTokens: 0, reasoningTokens: 3 })
    expect(result.usage).toBeNull()
  })

  it('preserves consumed completion accounting when Codex thread persistence later fails', async () => {
    cliSubagentMocks.codexStreamNativeMode.mockResolvedValueOnce({ stream: streamFromChunks([{ type: 'finish', totalUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }]) })
    const write = subagentRedis.redis.json.set
    subagentRedis.redis.json.set = vi.fn(async (key: string, ...args: any[]) => {
      if (key === 'subagent_sessions:session-1:subagent:observation_helper') throw new Error('owned thread persistence failure')
      return write(key, ...args)
    })
    try {
      const result = await executeManagedSubagent({ userId: 'user-1', sessionId: 'session-1', chatInput: 'Work', subagent: observedHelper() } as any)
      expect(result).toMatchObject({ status: 'failed', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } })
      expect(result.observedUsage).toBeUndefined(); expect(result.output).toContain('owned thread persistence failure')
    } finally { subagentRedis.redis.json.set = write }
  })

  it('keeps a deadline before source registration unknown and ignores registration after returning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let entered!: () => void, finish!: () => void, requestSeen: any
    const atBridge = new Promise<void>((resolve) => { entered = resolve })
    const release = new Promise<void>((resolve) => { finish = resolve })
    cliSubagentMocks.codexStreamNativeMode.mockImplementationOnce(async (request: any) => {
      requestSeen = request; entered(); await release
      return { stream: streamFromChunks([]) }
    })
    const running = executeManagedSubagent({ userId: 'user-1', sessionId: 'session-1', chatInput: 'Work', subagent: { ...observedHelper(), timeout_seconds: 10 } } as any)
    await atBridge; await vi.advanceTimersByTimeAsync(10_001)
    const result = await running
    expect(result).toMatchObject({ status: 'timed_out', usage: null })
    expect(result.observedUsage).toBeUndefined()
    const late = vi.fn(() => observation({ inputTokens: 100 }))
    requestSeen.registerObservedUsageSource?.(late)
    finish(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers()
    expect(late).not.toHaveBeenCalled(); expect(result.observedUsage).toBeUndefined()
  })

  it('preserves parent abort as no structured result without waiting for the child finalizer', async () => {
    const controller = new AbortController()
    let entered!: () => void, finish!: () => void
    const atStream = new Promise<void>((resolve) => { entered = resolve })
    const release = new Promise<void>((resolve) => { finish = resolve })
    let finalized = false
    cliSubagentMocks.codexStreamNativeMode.mockImplementationOnce(async (request: any) => {
      request.registerObservedUsageSource?.(() => observation({ inputTokens: 100 }))
      return { stream: { async *[Symbol.asyncIterator]() {
        entered(); await release; finalized = true
        await request.onFinish?.({ observedUsage: observation({ inputTokens: 200 }) })
        throw request.abortSignal.reason
      } } }
    })
    const aborted = executeManagedSubagent({ userId: 'user-1', sessionId: 'session-1', chatInput: 'Work', subagent: observedHelper(), abortSignal: controller.signal } as any).catch((error) => error)
    await atStream
    const reason = new Error('owned parent stop')
    controller.abort(reason)
    const rejection = await aborted
    try {
      expect(rejection).toBeInstanceOf(Error)
      expect(rejection.message).toBe('Managed Subagent call was cancelled.')
      expect(rejection.usage).toBeUndefined(); expect(finalized).toBe(false)
    } finally { finish(); await vi.waitFor(() => expect(finalized).toBe(true)) }
  })

  // BL-285 (2026-09-27): a Worker ran under `subagent_cli_worker_<agent>_<n>`, the runtime id
  // (and managed profile folder) of a Subagent slugged `worker_<agent>_<n>`, so the two shared
  // one folder: concurrent runs wrote the same profile files, and the Subagent's delete took
  // the Worker's Codex logs. A Worker's runtime id now carries a "-" no Subagent slug can hold.
  it('runs a Worker slot and a Subagent of the same slug in different profile folders', async () => {
    subagentRedis.seed('batshit:worker_prompt', '# Base WORKER prompt')
    cliSubagentMocks.codexStreamNativeMode.mockImplementation(async () => ({
      stream: streamFromChunks([{ type: 'text-delta', text: 'done' }]),
      __detectToolSource: vi.fn(() => null),
    }))
    const record = {
      id: 'worker_cooper_1',
      user_id: 'user-1',
      displayName: 'Worker Cooper 1',
      subagentType: 'cli' as const,
      primary_model_provider: 'openai-codex',
      primary_model_name: 'codex-cli',
      codex_settings: { model: 'gpt-5.4' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    await executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'As the Subagent.',
      subagent: record,
    } as any)
    await executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'As the Worker.',
      subagent: { ...record, id: 'worker_4b0c' },
      parentAgentId: 'agent-1',
      delegationKind: 'worker',
      delegationSlug: 'worker_cooper_1',
    } as any)

    const [subagentRun, workerRun] = cliSubagentMocks.codexStreamNativeMode.mock.calls.map(
      (call) => call[0],
    )
    const [subagentProfile, workerProfile] =
      cliSubagentMocks.prepareManagedCodexSubagentProfile.mock.calls.map((call) => call[0])
    expect(subagentRun.agentId).toBe('subagent_cli_worker_cooper_1')
    expect(subagentProfile.runtimeId).toBe('subagent_cli_worker_cooper_1')
    expect(workerRun.agentId).toBe('subagent_cli-worker_cooper_1')
    expect(workerRun.processOwner).toEqual({ userId: 'user-1', kind: 'agent', id: 'agent-1' })
    expect(workerRun.commandParentAgentId).toBe('agent-1')
    expect(workerProfile.runtimeId).toBe('subagent_cli-worker_cooper_1')
    expect(workerProfile.profileId).not.toBe(subagentProfile.profileId)
    expect(cliSubagentMocks.buildAgentProfileId).toHaveBeenCalledWith('subagent_cli-worker_cooper_1')
  })

  // BL-287 (2026-09-27): a Subagent's delete stops its running CLI run the way a Stop does, and
  // the run counts as running until the CLI PROCESS has exited (the lane's stream ends when the
  // process is told to stop, before it exits), so the delete never removes the profile folder
  // under a CLI that can still write into it. A run that starts meanwhile is refused.
  it('a Subagent delete stops its CLI run and waits for the CLI process to exit; a new call meanwhile is refused', async () => {
    const events: string[] = []
    const cli = await startCli(150)
    cli.once('exit', () => events.push('CLI exited'))
    cliSubagentMocks.codexStreamNativeMode.mockImplementation(runUntilStopped(cli, events))
    const record = deletedHelper()

    const call = executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Run long.',
      subagent: record,
    } as any).catch((error) => error)
    await until(() => cliSubagentMocks.codexStreamNativeMode.mock.calls.length === 1)
    expect(hasRunningSubagentRun('user-1', 'deleted-helper')).toBe(true)

    const deleting = stopSubagentRunsForDelete('user-1', 'deleted-helper')
    // The record is still there while the delete waits; the mark alone refuses the new call.
    const during = await runManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-2',
      chatInput: 'Are you there?',
      subagent: record,
    } as any).catch((error) => error)
    const stop = await deleting
    events.push('delete goes on')
    stop.release()

    expect(stop.stopped).toBe(1)
    expect(events).toEqual(['CLI told to stop', 'CLI exited', 'delete goes on'])
    const outcome = await call
    expect(isSubagentDeletedError(outcome)).toBe(true)
    expect(outcome.message).toBe('Deleted Helper was deleted, so it does not run any more.')
    expect(isSubagentDeletedError(during)).toBe(true)
    expect(cliSubagentMocks.prepareManagedCodexSubagentProfile).toHaveBeenCalledTimes(1)
    expect(hasRunningSubagentRun('user-1', 'deleted-helper')).toBe(false)
  })

  // A CLI that ignores its stop kept the run registered for ever, and every later delete
  // answered 409 until a restart. It is killed at the grace, and the delete goes on.
  it('a stopped CLI that ignores its stop is killed at the grace, and the delete goes on', async () => {
    settleBounds.killGraceMs = 200
    const events: string[] = []
    const cli = await startCli(null)
    cliSubagentMocks.codexStreamNativeMode.mockImplementation(runUntilStopped(cli, events))
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const call = executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Run long.',
      subagent: deletedHelper(),
    } as any).catch((error) => error)
    await until(() => cliSubagentMocks.codexStreamNativeMode.mock.calls.length === 1)

    const stop = await stopSubagentRunsForDelete('user-1', 'deleted-helper', { timeoutMs: 3_000, pollMs: 20 })
    stop.release()
    quiet.mockRestore()

    expect(stop.stopped).toBe(1)
    expect(cli.signalCode).toBe('SIGKILL')
    expect(stop.waitedMs).toBeGreaterThanOrEqual(180)
    expect(stop.waitedMs).toBeLessThan(3_000)
    expect(isSubagentDeletedError(await call)).toBe(true)
  })

  it('a Worker is never registered: its delete-time lookup finds no run, and a built-in Worker (no record) runs', async () => {
    subagentRedis.seed('batshit:worker_prompt', '# Base WORKER prompt')
    let finish!: () => void
    const gate = new Promise<void>((resolve) => (finish = resolve))
    const workerSignals: AbortSignal[] = []
    cliSubagentMocks.codexStreamNativeMode.mockImplementation(async (request: any) => {
      workerSignals.push(request.abortSignal)
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            await gate
            yield { type: 'text-delta', text: 'worker done' }
          },
        },
        __detectToolSource: vi.fn(() => null),
      }
    })

    // A built-in Worker's record has no `subagent:` key behind it (registration would refuse it).
    const worker = executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'As a Worker.',
      subagent: { ...deletedHelper('worker_4b0c'), displayName: 'Worker 1' },
      parentAgentId: 'agent-1',
      delegationKind: 'worker',
      delegationSlug: 'worker_cooper_1',
    } as any)
    await until(() => workerSignals.length === 1)

    expect(hasRunningSubagentRun('user-1', 'worker_4b0c')).toBe(false)
    const stop = await stopSubagentRunsForDelete('user-1', 'worker_4b0c')
    stop.release()
    expect(stop.stopped).toBe(0)
    expect(workerSignals[0].aborted).toBe(false)
    finish()
    expect((await worker).status).toBe('completed')
  })

  it('a Subagent whose record is gone does not start (a turn that loaded it before its delete)', async () => {
    const outcome = await runManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Still there?',
      subagent: deletedHelper('gone-helper'),
    } as any).catch((error) => error)

    expect(isSubagentDeletedError(outcome)).toBe(true)
    expect(cliSubagentMocks.resolveManagedSubagentScope).not.toHaveBeenCalled()
    expect(cliSubagentMocks.prepareManagedCodexSubagentProfile).not.toHaveBeenCalled()
    expect(cliSubagentMocks.codexStreamNativeMode).not.toHaveBeenCalled()
  })

  it('a delete during the setup stops the call before its lane starts: no profile folder is written', async () => {
    let openScope!: () => void
    const scopeGate = new Promise<void>((resolve) => (openScope = resolve))
    const scope = await cliSubagentMocks.resolveManagedSubagentScope()
    cliSubagentMocks.resolveManagedSubagentScope.mockClear()
    cliSubagentMocks.resolveManagedSubagentScope.mockImplementation(async () => {
      await scopeGate
      return scope
    })

    const call = executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Set up slowly.',
      subagent: deletedHelper(),
    } as any).catch((error) => error)
    await until(() => cliSubagentMocks.resolveManagedSubagentScope.mock.calls.length === 1)

    const deleting = stopSubagentRunsForDelete('user-1', 'deleted-helper', { timeoutMs: 3_000, pollMs: 20 })
    openScope()
    const stop = await deleting
    stop.release()

    expect(stop.stopped).toBe(1)
    expect(isSubagentDeletedError(await call)).toBe(true)
    expect(cliSubagentMocks.prepareManagedCodexSubagentProfile).not.toHaveBeenCalled()
    expect(cliSubagentMocks.codexStreamNativeMode).not.toHaveBeenCalled()
  })

  it('a delete stops a call that queues behind another call to the same Subagent', async () => {
    const holder = await acquireSubagentRunLock({
      sessionId: 'session-1',
      slug: 'deleted_helper',
      subagentLabel: 'Deleted Helper',
      ttlMs: 60_000,
      waitBudgetMs: 0,
    })

    const call = executeManagedSubagent({
      userId: 'user-1',
      sessionId: 'session-1',
      chatInput: 'Wait for my turn.',
      subagent: deletedHelper(),
    } as any).catch((error) => error)
    await until(() => hasRunningSubagentRun('user-1', 'deleted-helper'))
    await new Promise((resolve) => setTimeout(resolve, 30))

    const stop = await stopSubagentRunsForDelete('user-1', 'deleted-helper', { timeoutMs: 3_000, pollMs: 20 })
    stop.release()
    await releaseSubagentRunLock(holder)

    expect(stop.stopped).toBe(1)
    expect(isSubagentDeletedError(await call)).toBe(true)
    expect(cliSubagentMocks.codexStreamNativeMode).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { NativeModeRequest } from '../vercelBrain'
import { buildCodexRuntimeSettings } from '../codexSettings'

// The real default-workspace resolver must only create folders in this suite's home.
const fixtureHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!fixtureHome.current) throw new Error('codexBridge.test: disposable home is unavailable')
    return fixtureHome.current
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})

/**
 * The credential index, modelled as a real SET rather than stubbed.
 *
 * SA-118 F-19 gave `mintRunCredential` a prune: it calls `listAgentRunCredentialIds`
 * before adding this run's member, so the mint now READS the index as well as writing to
 * it. Stubbing `sMembers` to `[]` would make every prune a silent no-op here, which is
 * exactly the kind of fake-versus-real disagreement the deep dive's §14.1 list is made of.
 */
const credentialIndex = new Map<string, Set<string>>()
const indexSet = (key: string) => {
  const existing = credentialIndex.get(key)
  if (existing) return existing
  const created = new Set<string>()
  credentialIndex.set(key, created)
  return created
}

const mockRedisClient = {
  json: {
    get: vi.fn().mockResolvedValue(null)
  },
  set: vi.fn().mockResolvedValue(null),
  expire: vi.fn().mockResolvedValue(true),
  del: vi.fn().mockResolvedValue(1),
  sAdd: vi.fn(async (key: string, ...members: any[]) => {
    const flattened = members.length === 1 && Array.isArray(members[0]) ? members[0] : members
    flattened.forEach((member: string) => indexSet(key).add(member))
    return flattened.length
  }),
  sMembers: vi.fn(async (key: string) => Array.from(indexSet(key))),
  sRem: vi.fn(async (key: string, ...members: any[]) => {
    const flattened = members.length === 1 && Array.isArray(members[0]) ? members[0] : members
    let removed = 0
    flattened.forEach((member: string) => {
      if (indexSet(key).delete(member)) removed += 1
    })
    return removed
  })
}

/**
 * SA-117 P2 — the bridge mints a run credential at run start, so this fake has to serve
 * `agentRunCredentials.ts`: `redis.get('agent:…')` for the ownership check, `json.set` +
 * `expire` for the record, `execute(sMembers/sAdd/sRem)` for the index — the mint prunes
 * it on the way in since SA-118 F-19 — and `del` for the revoke.
 *
 * It records what was written so the tests below can assert the credential's LIFECYCLE
 * (minted with the run's ids, revoked when the run ends) rather than only its presence.
 */
const mintedCredentialRecords: Array<{ key: string; record: any }> = []
const deletedKeys: string[] = []

const mockRedis = {
  getProjectPreferences: vi.fn().mockResolvedValue(null),
  // BL-686: the mint resolves the run's saved CLI tools; no Tool Grid list here.
  getUserSettings: vi.fn().mockResolvedValue(null),
  getAgents: vi.fn().mockResolvedValue([]),
  get: vi.fn(async (key: string) =>
    key === 'agent:agent-123' ? { id: 'agent-123', user_id: 'user-123' } : null
  ),
  json: {
    get: vi.fn(async (key: string) => {
      // Host admission reads the persisted Primary owner separately from the virtual
      // delegated runtime id. Keep that record in this RedisJSON-shaped fixture.
      if (key === 'agent:agent-123') return { id: 'agent-123', user_id: 'user-123' }
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
vi.mock('../codexProfileManager', async (importOriginal) => ({
  ensureManagedCodexHome: mockEnsureManagedCodexHome,
  // BL-152: the stand-in home has no config, so no helper launch to fill.
  readManagedCodexHelperLaunchOverrides: vi.fn(async () => []),
  readManagedCodexToolOutputTokenLimit: vi.fn(async () => null),
  DOCKER_AUTH_ENV_VAR: 'BATSHIT_DOCKER_MCP_TOKEN',
  N8N_INSTANCE_MCP_TOKEN_ENV: 'BATSHIT_N8N_INSTANCE_MCP_TOKEN',
  syncAgentCodexProfiles: mockSyncAgentCodexProfiles,
  // BL-156: the chat run's fallback profile id is the real one.
  buildAgentProfileId: (await importOriginal<typeof import('../codexProfileManager')>()).buildAgentProfileId
}))
// This suite runs Codex lanes with stand-in homes such as `/tmp/codex-home`. The managed-home
// check (BL-7 review) has its own suite on a throwaway HOME, `codexManagedHome.test.ts`. The
// fallback home would create folders under the REAL `~/.batshit/agents`, so reaching it here
// fails loudly instead.
vi.mock('../codexManagedHome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codexManagedHome')>()),
  assertBatshitManagedCodexHome: vi.fn(async () => {}),
  ensureManagedCodexFallbackHome: vi.fn(async () => {
    throw new Error('codexBridge.test reached the managed fallback home')
  })
}))

let CodexBridgeClass: typeof import('../codexBridge').CodexBridge
let buildCodexPromptFromMessages: typeof import('../codexBridge').buildCodexPromptFromMessages
let buildCodexPromptPackageFromMessages: typeof import('../codexBridge').buildCodexPromptPackageFromMessages
let buildCodexCliArgs: typeof import('../codexBridge').buildCodexCliArgs
let extractAppServerSpawnArgs: typeof import('../codexBridge').extractAppServerSpawnArgs
let buildManagedCodexPromptCacheKey: typeof import('../codexBridge').buildManagedCodexPromptCacheKey
let buildCodexNativeSkillDisableOverride: typeof import('../codexBridge').buildCodexNativeSkillDisableOverride
let getDefaultCodexWorkingDirectory: typeof import('../codexBridge').getDefaultCodexWorkingDirectory
let redactCodexCliArgsForLog: typeof import('../codexBridge').redactCodexCliArgsForLog
let codexCliStatusModule: typeof import('../codexCliStatus')

beforeAll(async () => {
  fixtureHome.current = await mkdtemp(path.join(os.tmpdir(), 'batshit-codex-bridge-test-'))
  ;({
    CodexBridge: CodexBridgeClass,
    buildCodexPromptFromMessages,
    buildCodexPromptPackageFromMessages,
    buildCodexCliArgs,
    extractAppServerSpawnArgs,
    buildManagedCodexPromptCacheKey,
    buildCodexNativeSkillDisableOverride,
    getDefaultCodexWorkingDirectory,
    redactCodexCliArgsForLog
  } = await import('../codexBridge'))
  codexCliStatusModule = await import('../codexCliStatus')
})

afterAll(async () => {
  const home = fixtureHome.current
  fixtureHome.current = ''
  if (home) await rm(home, { recursive: true, force: true })
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
  // Clear unconsumed once refusals as well as observations before the next case.
  mockEnsureManagedCodexHome.mockReset().mockResolvedValue('/tmp/codex-home')
  mockSyncAgentCodexProfiles.mockResolvedValue(undefined)
  mockRedisClient.json.get.mockResolvedValue(null)
  mockRedisClient.set.mockResolvedValue(null)
  mockRedisClient.expire.mockResolvedValue(true)
  mockRedisClient.del.mockResolvedValue(1)
  // `sAdd`/`sMembers`/`sRem` keep their implementations — they model a real SET so the
  // mint's prune (SA-118 F-19) is exercised rather than stubbed away. Only the data resets.
  credentialIndex.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CodexBridge', () => {
  it('registers the delegated snapshot source before returning without reading or finalizing it', async () => {
    const bridge = new CodexBridgeClass()
    const getter = vi.fn(() => ({ input_tokens: 100, output_tokens: 0 }))
    const cleanup = vi.fn()
    const onFinish = vi.fn()
    let take!: () => unknown
    const register = vi.fn((source) => { take = source })
    vi.spyOn(bridge as any, 'createRunner').mockResolvedValue({
      transport: 'app-server', cleanup, getObservedUsage: getter,
      events: (async function* () { throw new Error('no event read in this boundary') })(),
    })
    const result = await bridge.streamNativeMode(buildRequest({ onFinish, registerObservedUsageSource: register }))
    expect(register).toHaveBeenCalledTimes(1)
    expect(getter).not.toHaveBeenCalled(); expect(onFinish).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled()
    expect(take()).toEqual({ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } }] })
    await result.fullStream[Symbol.asyncIterator]().return!()
    expect(onFinish).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1)
  })
  it.each(['return', 'throw'])('BL-1361: finalizes once when %s precedes the first next, with accounting still readable after cleanup', async (ending) => {
    const bridge = new CodexBridgeClass()
    const cleanup = vi.fn()
    const onFinish = vi.fn()
    const getObservedUsage = vi.fn(() => {
      expect(cleanup).toHaveBeenCalledTimes(1)
      return { input_tokens: 100, output_tokens: 10, cache_write_input_tokens: 30 }
    })
    vi.spyOn(bridge as any, 'createRunner').mockResolvedValue({
      transport: 'app-server', cleanup, getObservedUsage,
      events: (async function* () { throw new Error('the event iterator should not start') })(),
    })
    const result = await bridge.streamNativeMode(buildRequest({ onFinish }))
    const iterator = result.fullStream[Symbol.asyncIterator]()
    const failure = new Error('consumer ended before reading')
    if (ending === 'return') await iterator.return!()
    else await expect(iterator.throw!(failure)).rejects.toBe(failure)
    // A second close reaches the same guarded finalizer, not a second callback writer.
    await iterator.return!()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(getObservedUsage).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish.mock.calls[0][0].usage).toBeUndefined()
    expect(onFinish.mock.calls[0][0].totalUsage).toBeUndefined()
    expect(onFinish.mock.calls[0][0].observedUsage).toEqual({ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheCreationInputTokens: 30 } }] })
  })
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
    const workspace = path.join(fixtureHome.current, '.batshit', 'workspaces', 'default')
    expect(receivedRunOptions?.workingDirectory).toBe(workspace)
    expect((await stat(workspace)).isDirectory()).toBe(true)
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
    // BL-287: the Codex process, which the Subagent runner waits for after the stream ends.
    const codexProcess = { pid: 4242 }

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
      cleanup: runnerCleanup,
      process: codexProcess
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
    expect(result.__cliProcess).toBe(codexProcess)
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

  it('returns an exec abort while uncertain cleanup remains visible for a verified retry', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { CodexRunProcesses, getCodexRunProcesses } = await import('../codexRunProcesses')
    const { pinHostCommandOwner, prepareHostCommand } = await import('../hostCommandOwnership')
    const folder = mkdtempSync(join(tmpdir(), 'bl659-codex-exec-'))
    const executable = join(folder, 'fake-codex')
    writeFileSync(executable, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"fixture"}'
IFS= read -r prompt
while :; do sleep 1; done
`, { mode: 0o700 })
    vi.spyOn(codexCliStatusModule, 'detectCodexCliStatus').mockResolvedValue({
      available: true, executable, version: '0.157.1'
    } as any)
    const realEnd = CodexRunProcesses.prototype.end
    const ending: CodexRunProcesses[] = []
    const endSpy = vi.spyOn(CodexRunProcesses.prototype, 'end')
      .mockImplementation(function (this: CodexRunProcesses) {
        ending.push(this)
        return realEnd.call(this)
      })
    const stop = new AbortController()
    const bridge = new CodexBridgeClass()
    const hostCommandLease = await prepareHostCommand(
      pinHostCommandOwner({ userId: 'user-123', kind: 'host', id: 'codex-test' }),
      { kind: 'codex', program: executable }
    )
    let runner: any
    let ownedChild: import('node:child_process').ChildProcess | undefined
    let inspection: { mockRestore: () => void } | undefined
    try {
      runner = await (bridge as any).runViaCli('Prompt', {
        model: undefined,
        sandboxMode: 'read-only',
        workingDirectory: process.cwd(),
        allowFileEdits: false,
        allowNetwork: false,
        managedConfigHome: null,
        hostCommandLease,
        signal: stop.signal
      })
      ownedChild = runner.process
      const processes = getCodexRunProcesses(ownedChild!)!
      await processes.ready
      inspection = vi.spyOn(processes as unknown as { capture: (...args: unknown[]) => Promise<void> }, 'capture')
        .mockRejectedValueOnce(new Error('process table unavailable'))
      const consuming = collectStream(runner.events)
      stop.abort('user')
      await expect(consuming).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(endSpy).toHaveBeenCalled(), { timeout: 2_000 })
      await expect(runner.cleanup()).rejects.toThrow('process table unavailable')
      expect(ownedChild!.exitCode === null && ownedChild!.signalCode === null).toBe(true)
      await vi.waitFor(() => {
        expect(hostCommandLease.pin.store.records(hostCommandLease.pin.resources)).toEqual([
          expect.objectContaining({ runId: hostCommandLease.record.runId, phase: 'unresolved' })
        ])
      })

      inspection.mockRestore()
      await expect(ending[0].retryEnd()).resolves.toBeUndefined()
      expect(hostCommandLease.pin.store.records(hostCommandLease.pin.resources)).toEqual([])
      await vi.waitFor(() => {
        expect(ownedChild!.exitCode !== null || ownedChild!.signalCode !== null).toBe(true)
      }, { timeout: 2_000 })
    } finally {
      inspection?.mockRestore()
      await runner?.cleanup?.().catch(() => {})
      if (ownedChild?.pid && ownedChild.exitCode === null && ownedChild.signalCode === null) {
        try { process.kill(-ownedChild.pid, 'SIGKILL') } catch { /* disposable test child already exited */ }
      }
      rmSync(folder, { recursive: true, force: true })
    }
  }, 10_000)

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
      approvalPolicy: 'on-request',
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
    expect(args).toContain('approval_policy=on-request')
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

  /* ------------------------------------------------------------------ *
   * BL-7 — Codex's bundled skills in a Batshit-managed home.
   *
   * Codex installs its bundled skills into `CODEX_HOME/skills/.system` by deleting the
   * folder and writing it again, with nothing that stops two processes at once. Two
   * turns of one agent that start together (the same agent in two chats, the compact
   * worker beside a turn, the Mac app beside a dev lane) race there: measured with the
   * real codex-cli 0.139.0 on a fresh home, 5 starts at once logged `Directory not empty
   * (os error 66)` in 6 of 8 rounds and left 4 of 8 homes with files missing under a
   * marker that says they are current, which Codex then never repairs. Batshit already
   * turns every one of those skills off by path after the first run, so a managed home
   * turns the bundled set off at the source instead and nothing is installed at all.
   * ------------------------------------------------------------------ */
  describe('BL-7: a Batshit-managed Codex home never installs the bundled skills', () => {
    const configValues = (args: string[]) =>
      args.flatMap((arg, index) => (arg === '--config' ? [args[index + 1]] : []))

    const baseOptions = () => ({
      model: 'gpt-5.5',
      permissionMode: 'chat' as const,
      sandboxMode: 'read-only' as const,
      workingDirectory: process.cwd(),
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: 'never' as const,
      webSearchEnabled: false,
      addDirectories: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      defaultGateways: null,
      profileName: 'batshit_agent_test',
      dockerAuthToken: null,
      n8nInstanceMcpToken: null,
      historyPersistence: 'none' as const,
      serviceTier: 'standard' as const,
      permissionOverridden: false,
      reasoningEffort: 'low' as const,
      signal: undefined,
      unifiedExec: true,
      imagePaths: [],
      sessionId: 'sess-one',
      nativeSkillDisablePaths: []
    })

    it('turns them off for a managed chat run, and the app-server lane keeps the switch', () => {
      const args = buildCodexCliArgs(
        { ...baseOptions(), configScope: 'managed', managedConfigHome: '/tmp/codex-home' } as any,
        { useProfileDefaults: false, shouldSkipGitCheck: false }
      )

      expect(configValues(args)).toContain('skills.bundled.enabled=false')
      expect(configValues(extractAppServerSpawnArgs(args))).toContain('skills.bundled.enabled=false')
    })

    it('turns them off for the hidden compact worker, which starts Codex in the same home', () => {
      const args = buildCodexCliArgs(
        {
          ...baseOptions(),
          configScope: 'global',
          managedConfigHome: '/tmp/codex-home',
          permissionOverridden: true,
          ignoreUserConfig: true,
          ignoreRules: true
        } as any,
        { useProfileDefaults: false, shouldSkipGitCheck: true }
      )

      expect(configValues(args)).toContain('skills.bundled.enabled=false')
    })

    it("an agent's own override cannot turn them back on, whatever it names", () => {
      // User overrides are emitted AFTER the switch, and Codex applies `--config` pairs in
      // order, so an override of the key, its table, or the whole `skills` table would win.
      // BL-7 review: they are managed keys, dropped before the args are built.
      for (const override of [
        { key: 'skills.bundled.enabled', value: 'true' },
        { key: 'skills.bundled', value: '{ enabled = true }' },
        { key: 'skills', value: '{ bundled = { enabled = true } }' }
      ]) {
        const settings = buildCodexRuntimeSettings({
          ...buildCodexRuntimeSettings(),
          configOverrides: [override, { key: 'project_doc_max_bytes', value: '0' }]
        } as any)
        const args = buildCodexCliArgs(
          {
            ...baseOptions(),
            configScope: 'global',
            managedConfigHome: '/tmp/codex-home',
            configOverrides: settings.configOverrides
          } as any,
          { useProfileDefaults: true, shouldSkipGitCheck: false }
        )

        const skills = configValues(args).filter((value) => value.startsWith('skills'))
        expect(skills, override.key).toEqual(['skills.bundled.enabled=false'])
        // The agent's other overrides still reach Codex.
        expect(configValues(args), override.key).toContain('project_doc_max_bytes=0')
      }
    })

    it("never touches the user's own Codex home, where Codex 0.139.0 would delete the folder", () => {
      // With no managed home the child inherits the user's CODEX_HOME (their real
      // `~/.codex`). Codex 0.139.0 answers `skills.bundled.enabled=false` by deleting
      // `skills/.system` there, which belongs to the user's own Codex app.
      const args = buildCodexCliArgs(
        { ...baseOptions(), configScope: 'global', managedConfigHome: null } as any,
        { useProfileDefaults: true, shouldSkipGitCheck: false }
      )

      expect(configValues(args).some((value) => value.startsWith('skills.bundled'))).toBe(false)
    })
  })

  /**
   * BL-9: a reply's git baseline must be complete before Codex starts, or a fast first command
   * lands before Batshit's copy and the copy is the edited file. The adapter then uses it.
   */
  describe('BL-9: every reply takes its git baseline before Codex starts', () => {
    it.each(['native', 'hidden'] as const)('does not fall back after a %s run profile admission fails', async (lane) => {
      const { ManagedProfileRunRefusedError } = await import('../agentProfileFolderGate')
      const refusal = new ManagedProfileRunRefusedError('Profile owner could not be verified')
      mockEnsureManagedCodexHome.mockRejectedValueOnce(refusal)
      const bridge = new CodexBridgeClass()
      const runner = vi.spyOn(bridge as any, 'createRunner')
      const operation = lane === 'native'
        ? bridge.streamNativeMode(buildRequest({ codexSettings: { ...buildCodexRuntimeSettings(), configScope: 'managed' } }))
        : bridge.generateHiddenText({ userId: 'user-123', agentId: 'agent-123', model: 'gpt-5.5', prompt: 'Summarize.' })
      await expect(operation).rejects.toBe(refusal)
      expect(runner).not.toHaveBeenCalled()
    })

    it('checks the stored owner again before creating a fallback home', async () => {
      const bridge = new CodexBridgeClass()
      const { ensureManagedCodexFallbackHome } = await import('../codexManagedHome')
      vi.mocked(ensureManagedCodexFallbackHome).mockClear()
      await expect((bridge as any).createRunner('prompt', {
        configScope: 'managed', managedConfigHome: null,
        profileName: 'batshit_agent_deleted',
        profileOwner: { userId: 'user-123', kind: 'agent', id: 'deleted' },
      })).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
      expect(ensureManagedCodexFallbackHome).not.toHaveBeenCalled()
    })

    it('releases the baseline even when runner cleanup fails', async () => {
      const { CodexReplyBaseline } = await import('../codexReplyBaseline')
      const baseline = CodexReplyBaseline.unavailable('fixture')
      const dispose = vi.spyOn(baseline, 'dispose')
      vi.spyOn(CodexReplyBaseline, 'take').mockResolvedValue(baseline)
      const bridge = new CodexBridgeClass()
      vi.spyOn(bridge as any, 'runViaCli').mockResolvedValue({
        transport: 'exec',
        events: (async function* () { yield { type: 'turn.completed' } })(),
        cleanup: async () => { throw new Error('runner cleanup failed') },
      })
      const result = await bridge.streamNativeMode(buildRequest())
      await collectStream(result.fullStream).catch(() => {})
      expect(dispose).toHaveBeenCalledOnce()
    })

    it('keeps the reader through the last adapter event, then releases it', async () => {
      const { CodexReplyBaseline } = await import('../codexReplyBaseline')
      const baseline = CodexReplyBaseline.unavailable('fixture')
      const dispose = vi.spyOn(baseline, 'dispose')
      vi.spyOn(CodexReplyBaseline, 'take').mockResolvedValue(baseline)
      const bridge = new CodexBridgeClass()
      vi.spyOn(bridge as any, 'runViaCli').mockImplementation(async (_prompt: unknown, options: any) => ({
        transport: 'exec',
        events: (async function* () {
          await options.onProcessesExited()
          expect(dispose).not.toHaveBeenCalled()
          yield { type: 'turn.completed' }
        })(),
      }))
      const result = await bridge.streamNativeMode(buildRequest())
      await collectStream(result.fullStream)
      expect(dispose).toHaveBeenCalledOnce()
    })

    it('records unverified reader cleanup against this reply and still clears setup', async () => {
      const { CodexReplyBaseline } = await import('../codexReplyBaseline')
      const warnings = await import('../codexCleanupWarnings')
      const warning = vi.spyOn(warnings, 'recordCodexCleanupWarning').mockResolvedValue()
      const baseline = CodexReplyBaseline.unavailable('fixture')
      vi.spyOn(baseline, 'dispose').mockRejectedValue(new Error('forced reader termination'))
      vi.spyOn(CodexReplyBaseline, 'take').mockResolvedValue(baseline)
      const bridge = new CodexBridgeClass()
      vi.spyOn(bridge as any, 'runViaCli').mockResolvedValue({
        transport: 'exec', events: (async function* () { yield { type: 'turn.completed' } })(),
      })
      const result = await bridge.streamNativeMode(buildRequest())
      await collectStream(result.fullStream)
      expect(warning).toHaveBeenCalledWith({ userId: 'user-123', sessionId: 'sess-one', messageId: 'msg-one' })
      expect([...(credentialIndex.get('codex_sessions:user-123:agent-123') ?? [])]).not.toContain('sess-one')
    })

    it('fails setup before spawning when the baseline cannot verify its cleanup', async () => {
      const { CodexReplyBaseline } = await import('../codexReplyBaseline')
      const warnings = await import('../codexCleanupWarnings')
      const warning = vi.spyOn(warnings, 'recordCodexCleanupWarning').mockResolvedValue()
      vi.spyOn(CodexReplyBaseline, 'take').mockRejectedValue(new Error('reader cleanup unverified'))
      const bridge = new CodexBridgeClass()
      const run = vi.spyOn(bridge as any, 'runViaCli')
      await expect(bridge.streamNativeMode(buildRequest())).rejects.toThrow('reader cleanup unverified')
      expect(run).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledOnce()
      expect([...(credentialIndex.get('codex_sessions:user-123:agent-123') ?? [])]).not.toContain('sess-one')
    })

    it('takes it in the project folder before the spawn, and the edit card reads from it', async () => {
      const { execFileSync } = await import('node:child_process')
      const fsSync = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const { CodexReplyBaseline } = await import('../codexReplyBaseline')
      const { codexCommandEvents } = await import('$lib/test-utils/shell-command-steps')
      const repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl9-bridge-'))
      try {
        const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
        git('init', '-q')
        git('config', 'user.email', 'test@example.com')
        git('config', 'user.name', 'test')
        fsSync.writeFileSync(path.join(repo, 'notes.md'), 'one\n')
        git('add', 'notes.md')
        git('commit', '-qm', 'init')
        fsSync.writeFileSync(path.join(repo, 'notes.md'), 'one\nan older change\n')
        vi.stubEnv('BATSHIT_TOKEN', 'codex-bridge-test-token')
        vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
          const body = JSON.parse(init?.body ?? '{}')
          const file = path.join(body?.params?.projectPath ?? '/', body?.input?.filePath ?? '')
          return fsSync.existsSync(file)
            ? { ok: true, json: async () => ({ content: fsSync.readFileSync(file, 'utf8') }) }
            : { ok: false, json: async () => ({}) }
        }))
        const order: string[] = []
        const take = CodexReplyBaseline.take.bind(CodexReplyBaseline)
        const takeSpy = vi.spyOn(CodexReplyBaseline, 'take').mockImplementation(async (options) => {
          const baseline = await take(options)
          order.push('baseline taken')
          return baseline
        })
        const bridge = new CodexBridgeClass()
        vi.spyOn(bridge as any, 'runViaCli').mockImplementation(async () => {
          order.push('spawn')
          return {
            transport: 'exec',
            events: (async function* () {
              yield* codexCommandEvents({ id: 'noop', command: `sed -i 's/zzz/yyy/' ${repo}/notes.md`, output: '', exitCode: 0, status: 'completed' }) as any
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
            })()
          }
        })

        // Review finding 3: a Stop during the baseline ends it at once.
        const stop = new AbortController()
        const result = await bridge.streamNativeMode(buildRequest({ projectPath: repo, abortSignal: stop.signal }))
        const chunks = await collectStream(result.fullStream)

        expect(takeSpy).toHaveBeenCalledWith(expect.objectContaining({ projectPath: repo, signal: stop.signal }))
        expect(order).toEqual(['baseline taken', 'spawn'])
        expect(chunks.find((chunk) => chunk.type === 'tool-result')?.result?.diff).toBe(
          `No change seen: ${repo}/notes.md matches the copy Batshit read before this command ran.`
        )
      } finally {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
        fsSync.rmSync(repo, { recursive: true, force: true })
      }
    })
  })

  /**
   * BL-161: codex-cli (0.139.0 measured, 0.155.1 in its source) syncs OpenAI's curated plugin
   * repository into `CODEX_HOME/.tmp/plugins` at startup whenever its `plugins` feature is on,
   * which it is by default: 88 MB (90,184 KB) in a fresh home within 6 s of `initialize`, and
   * every managed home is its own copy. Batshit owns the managed tool surface (apps are off
   * too), so a managed home runs with `features.plugins=false` unless the agent turned the
   * feature on itself.
   */
  describe('BL-161: a managed Codex home never downloads the curated plugin repo', () => {
    const configValues = (args: string[]) =>
      args.flatMap((arg, index) => (arg === '--config' ? [args[index + 1]] : []))
    const options = (overrides: Record<string, unknown>) => ({
      model: 'gpt-5.5',
      permissionMode: 'chat' as const,
      sandboxMode: 'read-only' as const,
      workingDirectory: process.cwd(),
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: 'never' as const,
      webSearchEnabled: false,
      addDirectories: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      defaultGateways: null,
      profileName: 'batshit_agent_test',
      historyPersistence: 'none' as const,
      serviceTier: 'standard' as const,
      unifiedExec: true,
      imagePaths: [],
      sessionId: 'sess-one',
      nativeSkillDisablePaths: [],
      ...overrides
    })

    it('turns the plugins feature off for a managed chat run, and the app-server lane keeps it', () => {
      const args = buildCodexCliArgs(
        options({ configScope: 'managed', managedConfigHome: '/tmp/codex-home' }) as any,
        { useProfileDefaults: false, shouldSkipGitCheck: false }
      )

      expect(configValues(args)).toContain('features.plugins=false')
      expect(configValues(extractAppServerSpawnArgs(args))).toContain('features.plugins=false')
    })

    it('turns it off for the hidden compact worker, which starts Codex in the same home', () => {
      const args = buildCodexCliArgs(
        options({
          configScope: 'global',
          managedConfigHome: '/tmp/codex-home',
          permissionOverridden: true,
          ignoreUserConfig: true,
          ignoreRules: true
        }) as any,
        { useProfileDefaults: false, shouldSkipGitCheck: true }
      )

      expect(configValues(args)).toContain('features.plugins=false')
    })

    it('keeps plugins for an agent that turned the feature on itself', () => {
      const args = buildCodexCliArgs(
        options({ configScope: 'managed', managedConfigHome: '/tmp/codex-home', enableFeatures: [' plugins '] }) as any,
        { useProfileDefaults: false, shouldSkipGitCheck: false }
      )

      expect(configValues(args).some((value) => value.startsWith('features.plugins'))).toBe(false)
    })

    it("never touches a run in the user's own Codex home", () => {
      const args = buildCodexCliArgs(
        options({ configScope: 'global', managedConfigHome: null }) as any,
        { useProfileDefaults: true, shouldSkipGitCheck: false }
      )

      expect(configValues(args).some((value) => value.startsWith('features.plugins'))).toBe(false)
    })
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

  describe('BL-720: hidden Compact Stop reaches the lane and waits for cleanup', () => {
    const request = (abortSignal?: AbortSignal) => ({
      prompt: 'Summarize this transcript.', userId: 'user-123', model: 'gpt-5.5', abortSignal
    })
    const answer = async function* () {
      yield { type: 'item.completed', item: { id: 'summary', type: 'agent_message', text: 'Summary' } }
      yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }
    }

    it('starts no lane for a pre-aborted Compact', async () => {
      const bridge = new CodexBridgeClass()
      const lane = vi.spyOn(bridge as any, 'runViaAppServer').mockResolvedValue({ events: answer() })
      const stop = new AbortController()
      stop.abort('stopped')
      await expect(bridge.generateHiddenText(request(stop.signal))).rejects.toMatchObject({ name: 'AbortError' })
      expect(lane).not.toHaveBeenCalled()
    })

    it('starts no lane when Stop lands during managed-home preparation', async () => {
      const bridge = new CodexBridgeClass()
      const lane = vi.spyOn(bridge as any, 'runViaAppServer').mockResolvedValue({ events: answer() })
      const stop = new AbortController()
      mockEnsureManagedCodexHome.mockImplementationOnce(async () => {
        stop.abort('stopped')
        return '/tmp/codex-home'
      })
      await expect(bridge.generateHiddenText({ ...request(stop.signal), agentId: 'agent-123' }))
        .rejects.toMatchObject({ name: 'AbortError' })
      expect(lane).not.toHaveBeenCalled()
    })

    it.each(['throw', 'normal'] as const)('rejects partial text after Stop when the lane ends %s and awaits one cleanup', async (ending) => {
      const bridge = new CodexBridgeClass()
      const stop = new AbortController()
      let releaseCleanup!: () => void
      const cleanup = vi.fn(() => new Promise<void>((resolve) => { releaseCleanup = resolve }))
      vi.spyOn(bridge as any, 'runViaAppServer').mockImplementation(async (_prompt: string, options: any) => ({
        events: (async function* () {
          yield { type: 'item.updated', item: { id: 'summary', type: 'agent_message', text: 'Partial summary' } }
          stop.abort('stopped')
          expect(options.signal.aborted).toBe(true)
          expect(options.signal.reason).toBe('stopped')
          if (ending === 'throw') throw new Error('lane stopped')
        })(),
        cleanup
      }))
      let settled = false
      const result = bridge.generateHiddenText(request(stop.signal)).then(
        (value) => { settled = true; return value },
        (error) => { settled = true; return error }
      )
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
      releaseCleanup()
      expect(await result).toMatchObject({ name: 'AbortError', message: 'Codex compact worker stopped.' })
      expect(cleanup).toHaveBeenCalledOnce()
    })

    it('rejects an answer when Stop lands during its awaited cleanup', async () => {
      const bridge = new CodexBridgeClass()
      const stop = new AbortController()
      const cleanup = vi.fn(async () => { stop.abort('stopped') })
      vi.spyOn(bridge as any, 'runViaAppServer').mockResolvedValue({ events: answer(), cleanup })
      await expect(bridge.generateHiddenText(request(stop.signal))).rejects.toMatchObject({ name: 'AbortError' })
      expect(cleanup).toHaveBeenCalledOnce()
    })

    it('keeps the internal timeout distinct from Stop even when the lane ends normally', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const bridge = new CodexBridgeClass()
      const cleanup = vi.fn(async () => {})
      let signal!: AbortSignal
      vi.spyOn(bridge as any, 'runViaAppServer').mockImplementation(async (_prompt: string, options: any) => {
        signal = options.signal
        return {
          events: (async function* () {
            yield { type: 'item.updated', item: { id: 'summary', type: 'agent_message', text: 'Partial summary' } }
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          })(), cleanup
        }
      })
      try {
        const pending = bridge.generateHiddenText({ ...request(new AbortController().signal), timeoutMs: 30_000 })
          .catch((error) => error)
        await vi.waitFor(() => expect(signal).toBeDefined())
        // The bridge's timer is now armed; filesystem setup has finished.
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await pending).toMatchObject({ message: 'Codex compact worker timed out after 30 seconds.' })
        expect(cleanup).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    })
  })
  // BL-759: the compact worker prefers the finished answer; when no answer finished, its own
  // copy of the streamed text must not keep a fragment Codex took back at a retry.
  it('keeps no fragment Codex took back in the compact worker\'s own copy of the text', async () => {
    const bridge = new CodexBridgeClass()
    vi.spyOn(bridge as any, 'runViaAppServer').mockResolvedValue({
      transport: 'app-server',
      events: (async function* () {
        yield { type: 'item.started', item: { id: 'msg_1', type: 'agent_message', text: '' } }
        yield { type: 'item.updated', item: { id: 'msg_1', type: 'agent_message', text: 'Partial summ' } }
        yield { type: 'stream.retry', message: 'Reconnecting... 1/5', details: null }
        yield { type: 'item.started', item: { id: 'msg_2', type: 'agent_message', text: '' } }
        yield { type: 'item.updated', item: { id: 'msg_2', type: 'agent_message', text: 'Whole summary' } }
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
    ).resolves.toMatchObject({ text: 'Whole summary' })
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

    it("BL-686: carries the run's saved CLI tools, never more", async () => {
      const bridge = new CodexBridgeClass()
      vi.spyOn(bridge as any, 'runViaCli').mockResolvedValue({
        transport: 'exec',
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
        })()
      })

      await collectStream((await bridge.streamNativeMode(buildRequest({
        selectedCliToolIds: ['tool_a', ' tool_a ', 'tool_b']
      }))).fullStream)
      // The agent here saved no CLI tools and the user's Tool Grid lists none.
      await collectStream((await bridge.streamNativeMode(buildRequest())).fullStream)

      expect(mintedCredentialRecords).toHaveLength(2)
      expect(mintedCredentialRecords[0]!.record.cliToolScope).toEqual(['tool_a', 'tool_b'])
      expect(mintedCredentialRecords[1]!.record.cliToolScope).toEqual([])
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
        buildRequest({
          agentId: 'subagent_cli_worker_agent_123_1',
          delegatedRun: true,
          processOwner: { userId: 'user-123', kind: 'agent', id: 'agent-123' },
          scopeAgentId: 'worker_123',
          delegatedAllowedControlIds: ['use.artifact.*']
        } as any)
      )
      await collectStream(result.fullStream)

      expect(mintedCredentialRecords).toHaveLength(1)
      expect(mintedCredentialRecords[0]!.record).toMatchObject({
        agentId: 'subagent_cli_worker_agent_123_1',
        delegated: true,
        // BL-75: the Worker whose skill access governs the run rides on its credential.
        scopeAgentId: 'worker_123',
        // BL-81: and so does exactly what its DCM index offered it.
        allowedControlIds: ['use.artifact.*']
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

    it('keeps host operator authority out of inherited and managed CLI environment', () => {
      const bridge = new CodexBridgeClass()
      const keys = [
        'BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN',
        'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN',
        'BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY',
        'BATSHIT_HOST_VOICE_RECIPE_KEY_FILE'
      ]
      const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
      try {
        for (const key of keys) process.env[key] = 'inherited-authority'
        const childEnv = (bridge as any).buildCodexChildEnv({
          managedStdioEnv: Object.fromEntries(keys.map((key) => [key, 'injected-authority']))
        }) as NodeJS.ProcessEnv
        for (const key of keys) expect(childEnv[key]).toBeUndefined()
      } finally {
        for (const key of keys) {
          if (previous[key] === undefined) delete process.env[key]
          else process.env[key] = previous[key]
        }
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

  /**
   * BL-162: a start that fails for any reason other than a Stop (a missing Codex, a refused
   * home, an agent that no longer exists) threw out of `streamNativeMode` before any stream
   * existed, so the stream's cleanup never ran: the image temp folder `prepareImages` made
   * stayed on disk, and the chat stayed in `codex_sessions:<user>:<agent>` for its hour,
   * where the Subagent bridge's fallback then saw two sessions and refused as ambiguous.
   */
  describe('BL-162: a start that fails leaves nothing behind', () => {
    const IMAGE = { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
    const sessionsKey = (agentId = 'agent-123') => `codex_sessions:user-123:${agentId}`

    // BL-312: these tests make real `batshit-codex-img-*` folders in the system temp folder and only
    // check that the bridge removed them, so a red run (a failing-test-first run, a mutation check,
    // a regression) left one 70-byte folder per failing test behind. Whatever the bridge left, the
    // test removes after its checks.
    const preparedFolders = new Set<string>()
    afterEach(async () => {
      const { rm } = await import('node:fs/promises')
      await Promise.all([...preparedFolders].map((folder) => rm(folder, { recursive: true, force: true })))
      preparedFolders.clear()
    })

    function recordPreparedImages(bridge: any) {
      const prepared: string[] = []
      const original = bridge.prepareImages.bind(bridge)
      vi.spyOn(bridge, 'prepareImages').mockImplementation(async (images: any) => {
        const result = await original(images)
        prepared.push(...result.paths)
        const { dirname } = await import('node:path')
        for (const imagePath of result.paths) preparedFolders.add(dirname(imagePath))
        return result
      })
      return prepared
    }

    it('removes the image folder and the session entry when the spawn fails', async () => {
      const { existsSync } = await import('node:fs')
      const path = await import('node:path')
      const bridge = new CodexBridgeClass()
      const prepared = recordPreparedImages(bridge)
      vi.spyOn(bridge as any, 'createRunner').mockRejectedValue(new Error('Codex CLI missing'))

      await expect(bridge.streamNativeMode(buildRequest({ images: [IMAGE] }))).rejects.toThrow('Codex CLI missing')

      expect(prepared).toHaveLength(1)
      expect(existsSync(path.dirname(prepared[0]!))).toBe(false)
      expect([...(credentialIndex.get(sessionsKey()) ?? [])]).not.toContain('sess-one')
    })

    it('refuses a deleted owner before preparing images and removes the session mapping', async () => {
      const bridge = new CodexBridgeClass()
      const prepared = recordPreparedImages(bridge)
      const createRunner = vi.spyOn(bridge as any, 'createRunner')

      await expect(
        bridge.streamNativeMode(buildRequest({ agentId: 'agent-gone', images: [IMAGE] }))
      ).rejects.toThrow()

      expect(createRunner).not.toHaveBeenCalled()
      expect(prepared).toEqual([])
      expect([...(credentialIndex.get(sessionsKey('agent-gone')) ?? [])]).not.toContain('sess-one')
    })

    it('still keeps both until the reply ends when the start succeeds', async () => {
      const { existsSync } = await import('node:fs')
      const path = await import('node:path')
      const bridge = new CodexBridgeClass()
      const prepared = recordPreparedImages(bridge)
      let seenDuringRun: { folder: boolean; session: boolean } | null = null
      vi.spyOn(bridge as any, 'runViaCli').mockResolvedValue({
        transport: 'exec',
        events: (async function* () {
          seenDuringRun = {
            folder: existsSync(path.dirname(prepared[0]!)),
            session: credentialIndex.get(sessionsKey())?.has('sess-one') ?? false
          }
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
        })()
      })

      const result = await bridge.streamNativeMode(buildRequest({ images: [IMAGE] }))
      await collectStream(result.fullStream)

      expect(seenDuringRun).toEqual({ folder: true, session: true })
      expect(existsSync(path.dirname(prepared[0]!))).toBe(false)
      expect([...(credentialIndex.get(sessionsKey()) ?? [])]).not.toContain('sess-one')
    })
  })
})

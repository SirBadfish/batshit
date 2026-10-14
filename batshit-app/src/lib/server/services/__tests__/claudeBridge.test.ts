import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { logger } from '$lib/utils/logger'
import { buildCliSubagentMcpToolReference } from '$lib/utils/cliSubagentToolNames'
import { applyClaudeContextGuard } from '../claudeContextGuard'
import { capturedClaudePrimaryEvents } from '../../tests/fixtures/claudePrimaryContext'

const mockGatewayService = {
  list: vi.fn()
}

const mockDetectClaudeCliStatus = vi.fn()
// This probe is a POSIX shell executable; Windows cannot spawn it directly.
const posixIt = process.platform === 'win32' ? it.skip : it

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: mockGatewayService
}))

// BL-496: a run with approvals waits for the server's Redis subscriber before it launches. A
// unit test must not open a real subscriber (the default CI lane has no Redis at all).
const mockWaitForSseExternalSubscriber = vi.fn(async (_timeoutMs: number) => true)
vi.mock('$lib/server/sseExternalSubscriber', () => ({
  waitForSseExternalSubscriber: mockWaitForSseExternalSubscriber
}))

vi.mock('$lib/server/services/claudeCliStatus', () => ({
  detectClaudeCliStatus: mockDetectClaudeCliStatus,
  resolveClaudeCliExecutable: vi.fn(() => '/fake/claude')
}))

/**
 * BL-179: the first import of `claudeBridge` loads its whole module graph, and under a heavy
 * lane that took longer than a test's 5 s budget, so the FIRST test timed out (it passed
 * alone). Load the module once here, with its own budget; every test's `await import(...)`
 * below then reads the cached module.
 */
beforeAll(async () => {
  await import('../claudeBridge')
}, 60_000)

describe('ClaudeBridge managed MCP scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes captured suffix/base identity through the real NDJSON reader, guard and adapter', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const { ClaudeEventAdapter } = await import('../claudeEventAdapter')
    const captured = capturedClaudePrimaryEvents()
    // Change only the reported limit to distinguish telemetry from the 1M estimate.
    captured[2].modelUsage['claude-sonnet-5-5[1m]'].contextWindow = 550_000
    async function* lines() {
      for (const event of captured) yield JSON.stringify(event)
    }
    const end = vi.fn()
    const stdin = { end, destroyed: false, writableEnded: false }
    end.mockImplementation(() => { stdin.writableEnded = true })
    const close = vi.fn()
    const reader = (new ClaudeBridge() as any).createCliEventIterator(
      { close }, lines(), Promise.resolve({ code: 0, signal: null }),
      { stdin, exitCode: 0, killed: false }, () => ''
    )
    const reports = vi.fn()
    const trip = vi.fn()
    const finish = vi.fn()
    const adapter = new ClaudeEventAdapter({ request: {} as any, transport: 'cli', onFinish: finish })
    const chunks: any[] = []
    for await (const chunk of adapter.stream(applyClaudeContextGuard(reader, {
      contextWindow: 1_000_000, model: 'sonnet[1m]', threshold: 0.8,
      onReport: reports, onTrip: trip
    }))) chunks.push(chunk)

    expect(chunks.map(chunk => chunk.type)).toEqual(['text-delta', 'finish'])
    expect(chunks[0].text).toBe('OK')
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ text: 'OK' }))
    expect(reports).toHaveBeenLastCalledWith(expect.objectContaining({
      actualModel: 'claude-sonnet-5-5', contextWindow: 550_000, evidence: 'runtime'
    }))
    expect(trip).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects packaged app runtime paths as Claude working directories', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { ClaudeBridge } = await import('../claudeBridge')
      const bridge = new ClaudeBridge()

      await expect(
        (bridge as any).ensureValidWorkingDirectory(
          '/Applications/Batshit.app/Contents/Resources/runtime'
        )
      ).resolves.toBeNull()
      await expect(
        (bridge as any).ensureValidWorkingDirectory(
          '/Applications/Batshit.app/Contents/Resources/runtime/index.js'
        )
      ).resolves.toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('uses an empty managed MCP deny-list in dynamic-only mode', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()

    const denyList = await (bridge as any).resolveManagedMcpToolDenyList({
      userId: 'josh',
      gatewayToolMap: {
        'gw-main': ['legacy_tool']
      }
    })

    expect(denyList).toEqual([])
  })

  it('builds allow-list only from canonical gatewayToolMap and excludes helper tools', async () => {
    const gateway = {
      id: 'gw-main',
      name: 'Main Gateway',
      slug: 'main_gateway',
      type: 'custom',
      url: 'https://example.test/mcp',
      enabled: true,
      discoveredTools: ['legacy_tool', 'allowed_tool', 'batshit_server_dynamic_mcp_find'],
      toolGroupings: [{ mcpName: 'Legacy Group', toolIds: ['legacy_tool', 'allowed_tool'] }],
      metadata: {},
      created_at: new Date().toISOString()
    }

    mockGatewayService.list.mockResolvedValue([gateway])

    const { ClaudeBridge } = await import('../claudeBridge')
    const { buildManagedGatewayId } = await import('../codexProfileManager')
    const bridge = new ClaudeBridge()
    const managedId = buildManagedGatewayId(gateway.id, gateway.slug)

    const allowed = await (bridge as any).resolveManagedMcpToolAllowList({
      userId: 'josh',
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool', 'batshit_server_dynamic_mcp_find']
      }
    })

    expect(allowed).toContain(`mcp__${managedId}__allowed_tool`)
    expect(allowed).not.toContain(`mcp__${managedId}__legacy_tool`)
    expect(allowed).not.toContain(`mcp__${managedId}__batshit_server_dynamic_mcp_find`)
  })

  it.each([
    ['prompt mode', 'default', 'all', true],
    ['bypass mode', 'bypassPermissions', 'off', false]
  ])('keeps the full Claude approval helper denied in %s', async (_label, permissionMode, toolApprovalMode, wantsPrompt) => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge() as any
    bridge.buildStreamJsonInput = vi.fn(async () => 'test input')
    bridge.loadAgentRecord = vi.fn(async () => null)
    bridge.resolveAgentPermissions = vi.fn(() => ({ allowNetwork: true, allowFileEdits: true }))
    bridge.resolveCliModel = vi.fn(() => 'claude-test')
    bridge.resolveWorkingDirectory = vi.fn(async () => '/tmp')
    bridge.resolveManagedMcpToolDenyList = vi.fn(async () => [])
    bridge.resolveSubagentPlanAllowTools = vi.fn(() => [])
    bridge.resolveManagedMcpToolAllowList = vi.fn(async () => [])
    bridge.resolveMode4InternalControlAllowTools = vi.fn(async () => ({ allowTools: [], disallowTools: [] }))
    bridge.resolveManagedStdioEnv = vi.fn(async () => ({}))
    bridge.resolveContextGuardConfig = vi.fn(async () => ({ contextWindow: null, threshold: null }))
    let captured: any
    bridge.runViaCli = vi.fn(async (_input: string, options: any) => {
      captured = options
      return { transport: 'cli', events: (async function* () {})(), cleanup: async () => {} }
    })

    await bridge.streamNativeMode({
      messages: [{ role: 'user', content: 'hello' }],
      claudeSettings: { configScope: 'managed', permissionMode },
      toolApprovalMode
    } as any)

    expect(captured.disallowedTools).toContain('mcp__batshit_gateway_claude-approvals__batshit_permission_prompt')
    expect(captured.permissionPromptTool).toBe(
      wantsPrompt ? 'mcp__batshit_gateway_claude-approvals__batshit_permission_prompt' : undefined
    )
  })

  it('a run that asks before tools waits for the approval listener, and is refused without it (BL-496)', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge() as any
    bridge.buildStreamJsonInput = vi.fn(async () => 'test input')
    bridge.loadAgentRecord = vi.fn(async () => null)
    bridge.resolveAgentPermissions = vi.fn(() => ({ allowNetwork: true, allowFileEdits: true }))
    bridge.resolveCliModel = vi.fn(() => 'claude-test')
    bridge.resolveWorkingDirectory = vi.fn(async () => '/tmp')
    bridge.resolveManagedMcpToolDenyList = vi.fn(async () => [])
    bridge.resolveSubagentPlanAllowTools = vi.fn(() => [])
    bridge.resolveManagedMcpToolAllowList = vi.fn(async () => [])
    bridge.resolveMode4InternalControlAllowTools = vi.fn(async () => ({ allowTools: [], disallowTools: [] }))
    bridge.resolveManagedStdioEnv = vi.fn(async () => ({}))
    bridge.resolveContextGuardConfig = vi.fn(async () => ({ contextWindow: null, threshold: null }))
    bridge.runViaCli = vi.fn(async () => ({ transport: 'cli', events: (async function* () {})(), cleanup: async () => {} }))
    const run = (toolApprovalMode: string, permissionMode = 'default') =>
      bridge.streamNativeMode({
        messages: [{ role: 'user', content: 'hello' }],
        claudeSettings: { configScope: 'managed', permissionMode },
        toolApprovalMode
      } as any)

    mockWaitForSseExternalSubscriber.mockResolvedValueOnce(false)
    await expect(run('all')).rejects.toThrow('could not start listening for approval cards')
    expect(bridge.runViaCli).not.toHaveBeenCalled()

    await run('all')
    expect(mockWaitForSseExternalSubscriber).toHaveBeenCalledTimes(2)
    expect(bridge.runViaCli).toHaveBeenCalledTimes(1)

    // A run that never asks does not wait for it.
    await run('off', 'bypassPermissions')
    expect(mockWaitForSseExternalSubscriber).toHaveBeenCalledTimes(2)
  })

  it('ends the run’s waiting Claude cards even when the runner’s own cleanup throws (BL-496 review)', async () => {
    const registry = await import('../claudeApprovalRegistry')
    registry.__resetClaudeApprovalRegistryForTests()
    const now = Date.now()
    registry.recordClaudeApprovalCard({
      sessionId: 'sess-cleanup', messageId: 'reply-cleanup', approvalId: 'ap-cleanup', toolName: 'Bash', input: {},
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString()
    })
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge() as any
    bridge.buildStreamJsonInput = vi.fn(async () => 'test input')
    bridge.loadAgentRecord = vi.fn(async () => null)
    bridge.resolveAgentPermissions = vi.fn(() => ({ allowNetwork: true, allowFileEdits: true }))
    bridge.resolveCliModel = vi.fn(() => 'claude-test')
    bridge.resolveWorkingDirectory = vi.fn(async () => '/tmp')
    bridge.resolveManagedMcpToolDenyList = vi.fn(async () => [])
    bridge.resolveSubagentPlanAllowTools = vi.fn(() => [])
    bridge.resolveManagedMcpToolAllowList = vi.fn(async () => [])
    bridge.resolveMode4InternalControlAllowTools = vi.fn(async () => ({ allowTools: [], disallowTools: [] }))
    bridge.resolveManagedStdioEnv = vi.fn(async () => ({}))
    bridge.resolveContextGuardConfig = vi.fn(async () => ({ contextWindow: null, threshold: null }))
    bridge.runViaCli = vi.fn(async () => ({
      transport: 'cli',
      events: (async function* () {})(),
      cleanup: async () => { throw new Error('cleanup failed') }
    }))
    const result = await bridge.streamNativeMode({
      messages: [{ role: 'user', content: 'hello' }],
      claudeSettings: { configScope: 'managed', permissionMode: 'default' },
      toolApprovalMode: 'all',
      sessionId: 'sess-cleanup',
      messageId: 'reply-cleanup'
    } as any)
    await expect((async () => { for await (const _ of result.stream) { /* drain */ } })()).rejects.toThrow('cleanup failed')
    expect(registry.listClaudeApprovals('sess-cleanup', 'reply-cleanup')[0]).toMatchObject({
      status: 'expired',
      expiryReason: 'run_ended'
    })
  })

  it('hands the Claude process to the caller as __cliProcess (BL-287)', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge() as any
    bridge.buildStreamJsonInput = vi.fn(async () => 'test input')
    bridge.loadAgentRecord = vi.fn(async () => null)
    bridge.resolveAgentPermissions = vi.fn(() => ({ allowNetwork: true, allowFileEdits: true }))
    bridge.resolveCliModel = vi.fn(() => 'claude-test')
    bridge.resolveWorkingDirectory = vi.fn(async () => '/tmp')
    bridge.resolveManagedMcpToolDenyList = vi.fn(async () => [])
    bridge.resolveSubagentPlanAllowTools = vi.fn(() => [])
    bridge.resolveManagedMcpToolAllowList = vi.fn(async () => [])
    bridge.resolveMode4InternalControlAllowTools = vi.fn(async () => ({ allowTools: [], disallowTools: [] }))
    bridge.resolveManagedStdioEnv = vi.fn(async () => ({}))
    bridge.resolveContextGuardConfig = vi.fn(async () => ({ contextWindow: null, threshold: null }))
    const claudeProcess = { pid: 4343 }
    bridge.runViaCli = vi.fn(async () => ({
      transport: 'cli',
      events: (async function* () {})(),
      cleanup: async () => {},
      process: claudeProcess
    }))

    const result = await bridge.streamNativeMode({
      messages: [{ role: 'user', content: 'hello' }],
      claudeSettings: { configScope: 'managed', permissionMode: 'default' },
      toolApprovalMode: 'off'
    } as any)

    expect(result.__cliProcess).toBe(claudeProcess)
  })

  it('does not synthesize allow-list entries from stale gateway metadata', async () => {
    const gateway = {
      id: 'gw-main',
      name: 'Main Gateway',
      slug: 'main_gateway',
      type: 'custom',
      url: 'https://example.test/mcp',
      enabled: true,
      discoveredTools: ['legacy_tool', 'another_legacy_tool'],
      toolGroupings: [{ mcpName: 'Legacy Group', toolIds: ['legacy_tool', 'another_legacy_tool'] }],
      metadata: {},
      created_at: new Date().toISOString()
    }

    mockGatewayService.list.mockResolvedValue([gateway])

    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()

    const allowed = await (bridge as any).resolveManagedMcpToolAllowList({
      userId: 'josh',
      gatewayToolMap: {}
    })

    expect(allowed).toEqual([])
  })

  it('only exposes Mode 4 CLI helper tools when the request has selected CLI tools', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()
    // BL-5: the helper server has one fixed name, never the agent's id or slug.
    const managedId = 'batshit_helpers'
    const searchTool = `mcp__${managedId}__batshit_tool_search`
    const useTool = `mcp__${managedId}__batshit_tool_use`
    const legacyFindTool = `mcp__${managedId}__batshit_server_cli_tool_find`
    const legacyUseTool = `mcp__${managedId}__batshit_server_cli_tool_use`
    const cliOnlySettings = {
      nativeTools: {
        fetchZipEnabled: false,
        dynamicMcpEnabled: false,
        cliToolsEnabled: true,
        batshitToolsEnabled: false,
        artifactRuntimeEnabled: false,
        agentBrowserEnabled: false,
        bashEnabled: false
      }
    }

    const withoutCliTools = await (bridge as any).resolveMode4InternalControlAllowTools({
      agentId: 'agent_cli',
      providerSettings: cliOnlySettings,
      selectedCliToolIds: []
    })

    expect(withoutCliTools.allowTools).not.toContain(searchTool)
    expect(withoutCliTools.allowTools).not.toContain(useTool)
    expect(withoutCliTools.disallowTools).toContain(searchTool)
    expect(withoutCliTools.disallowTools).toContain(useTool)
    expect(withoutCliTools.disallowTools).toContain(legacyFindTool)
    expect(withoutCliTools.disallowTools).toContain(legacyUseTool)

    const withCliTools = await (bridge as any).resolveMode4InternalControlAllowTools({
      agentId: 'agent_cli',
      providerSettings: cliOnlySettings,
      selectedCliToolIds: ['tool_alpha']
    })

    expect(withCliTools.allowTools).toContain(searchTool)
    expect(withCliTools.allowTools).toContain(useTool)
    expect(withCliTools.disallowTools).not.toContain(searchTool)
    expect(withCliTools.disallowTools).not.toContain(useTool)
    expect(withCliTools.disallowTools).toContain(legacyFindTool)
    expect(withCliTools.disallowTools).toContain(legacyUseTool)
  })

  it('includes Mode 4 Agent Browser helper tools when Agent Browser is enabled', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()
    const managedId = 'batshit_helpers'
    const searchTool = `mcp__${managedId}__batshit_tool_search`
    const useTool = `mcp__${managedId}__batshit_tool_use`
    const legacyFindTool = `mcp__${managedId}__batshit_server_agent_browser_find`
    const legacyUseTool = `mcp__${managedId}__batshit_server_agent_browser_use`

    const toolAccess = await (bridge as any).resolveMode4InternalControlAllowTools({
      agentId: 'agent_browser',
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          agentBrowserEnabled: true,
          bashEnabled: false
        }
      },
      selectedCliToolIds: []
    })

    expect(toolAccess.allowTools).toContain(searchTool)
    expect(toolAccess.allowTools).toContain(useTool)
    expect(toolAccess.disallowTools).not.toContain(searchTool)
    expect(toolAccess.disallowTools).not.toContain(useTool)
    expect(toolAccess.disallowTools).toContain(legacyFindTool)
    expect(toolAccess.disallowTools).toContain(legacyUseTool)
  })

  // BL-878 (Josh, 2026-09-28): Claude has its own Bash, so Batshit's helper is never allowed and
  // always denied by name, whether Bash is saved on, off, or absent (the shared resolver turns an
  // absent value on, which used to allow it on every managed run). A Primary, a CLI Subagent and
  // a Worker read one function, told apart only by the agent id they pass.
  it.each([true, false, undefined])(
    'BL-878: never allows the Batshit Bash helper, and denies it by name (Bash saved as %s)',
    async (bashEnabled) => {
      const { ClaudeBridge } = await import('../claudeBridge')
      const { buildCliSubagentRuntimeId, buildCliWorkerRuntimeId } = await import('$lib/utils/subagentSlug')
      const bridge = new ClaudeBridge()
      const managedId = 'batshit_helpers'
      const bashTool = `mcp__${managedId}__batshit_server_bash_execute`
      const searchTool = `mcp__${managedId}__batshit_tool_search`

      for (const [kind, agentId] of [
        ['Primary', 'agent_bash'],
        ['CLI Subagent', buildCliSubagentRuntimeId('bl878_sub')],
        ['Worker', buildCliWorkerRuntimeId('worker_bl878_1')]
      ] as const) {
        const toolAccess = await (bridge as any).resolveMode4InternalControlAllowTools({
          agentId,
          providerSettings: {
            nativeTools: {
              fetchZipEnabled: false,
              dynamicMcpEnabled: true,
              batshitToolsEnabled: false,
              agentBrowserEnabled: false,
              ...(bashEnabled === undefined ? {} : { bashEnabled })
            }
          },
          selectedCliToolIds: []
        })

        expect(toolAccess.allowTools, `${kind} allowTools`).not.toContain(bashTool)
        expect(toolAccess.disallowTools, `${kind} disallowTools`).toContain(bashTool)
        // The other helpers the settings allow are not touched.
        expect(toolAccess.allowTools, `${kind} allowTools`).toContain(searchTool)
      }
    }
  )

  it('BL-153: allow-lists the Subagent tools under the names the profile registers', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()

    // A slug over 6 characters and a subagent id over 16: both are shortened by the rule the
    // Claude profile and the DCM roster use, so the allow list must be shortened the same way.
    const allowed: string[] = (bridge as any).resolveSubagentPlanAllowTools({
      agentId: 'agent_cli',
      agentSlug: 'zbcli-claude-primary',
      assignedSubagents: [
        { id: 'zbcli-n8n-subagent-with-a-long-id', displayName: 'Long Subagent' },
        'cli-subagent'
      ]
    })

    // Literal names, so a change to the shared rule cannot move the expectation with it.
    expect(allowed).toEqual([
      'mcp__batshit_gateway_zbcli_cla_976f86__subagent_cli_subagent',
      'mcp__batshit_gateway_zbcli_cla_976f86__subagent_zbcli_n8n_cf9d85'
    ])
    expect(allowed).toEqual(
      [
        buildCliSubagentMcpToolReference(
          { id: 'agent_cli', slug: 'zbcli-claude-primary' },
          { id: 'zbcli-n8n-subagent-with-a-long-id' }
        )!.fullToolName,
        buildCliSubagentMcpToolReference(
          { id: 'agent_cli', slug: 'zbcli-claude-primary' },
          { id: 'cli-subagent' }
        )!.fullToolName
      ].sort()
    )
  })

  it('BL-153: refuses two assigned Subagents that share one tool key', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()

    expect(() =>
      (bridge as any).resolveSubagentPlanAllowTools({
        agentId: 'agent_cli',
        agentSlug: 'agent-cli',
        assignedSubagents: [{ id: 'api-subagent' }, 'api_subagent']
      })
    ).toThrow(/api_subagent/)
  })

  it('redacts system prompt payloads from CLI args logging', async () => {
    const { redactClaudeCliArgsForLog } = await import('../claudeBridge')

    const args = [
      '--print',
      '--system-prompt',
      'SECRET SYSTEM PROMPT',
      '--append-system-prompt',
      'SECRET ADDENDUM',
      '--model',
      'opus'
    ]

    expect(redactClaudeCliArgsForLog(args)).toEqual([
      '--print',
      '--system-prompt',
      '<redacted>',
      '--append-system-prompt',
      '<redacted>',
      '--model',
      'opus'
    ])
  })

  it('blocks Claude bypass permissions when the runtime is root', async () => {
    const { getClaudePermissionModeRuntimeBlockReason } = await import('../claudeBridge')

    expect(getClaudePermissionModeRuntimeBlockReason('bypassPermissions', () => 0)).toContain(
      'Claude Code blocks Bypass Permissions'
    )
    expect(getClaudePermissionModeRuntimeBlockReason('bypassPermissions', () => 1000)).toBeNull()
    expect(getClaudePermissionModeRuntimeBlockReason('plan', () => 0)).toBeNull()
  })

  posixIt('injects managed env secrets into the spawned CLI child and logs a single redacted executing line', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-bridge-spawn-test-'))
    const probePath = path.join(tempDir, 'claude-probe.sh')
    // Stands in for the claude executable: reads the prompt LINE, then reports the env it
    // received as a stream-json line so the test can assert spawn-time secret injection.
    //
    // SA-114 P2: one line, not `cat >/dev/null`. Since DL-114-08 the bridge keeps stdin
    // open for the whole run so a steer can be written to it, and the real CLI starts
    // working the moment it has a complete user line (P0 measured it streaming with stdin
    // still open). A probe that waited for EOF would be modelling a CLI Batshit does not
    // run, and would hang here forever.
    await writeFile(
      probePath,
      [
        '#!/bin/sh',
        'IFS= read -r _line',
        'printf \'{"type":"probe","headerEnv":"%s"}\\n\' "$BATSHIT_MCP_HEADER_GW_DOCKER_AUTHORIZATION"',
        'exit 0'
      ].join('\n'),
      'utf8'
    )
    await chmod(probePath, 0o755)

    mockDetectClaudeCliStatus.mockResolvedValue({
      available: true,
      executable: probePath,
      version: '0.0.0-test',
      source: 'env'
    })

    // The executing line moved from console.log to logger.debug in the Wave 1 log
    // cleanup; spy on the logger so the redaction contract stays pinned.
    const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    try {
      const { ClaudeBridge } = await import('../claudeBridge')
      const bridge = new ClaudeBridge()

      const runner = await (bridge as any).runViaCli('{"type":"user"}', {
        workingDirectory: tempDir,
        permissionMode: 'acceptEdits',
        systemPromptMode: 'replace',
        systemPrompt: 'SECRET SYSTEM PROMPT',
        managedStdioEnv: {
          BATSHIT_MCP_HEADER_GW_DOCKER_AUTHORIZATION: 'Bearer docker-secret-token'
        },
        contextGuard: null
      })

      const events: any[] = []
      for await (const event of runner.events) {
        events.push(event)
      }
      await runner.cleanup?.()

      const probe = events.find((event) => event?.type === 'probe')
      expect(probe?.headerEnv).toBe('Bearer docker-secret-token')
      // BL-287: the runner carries the process it spawned (here the probe, which exited 0).
      expect(runner.process?.pid).toBeGreaterThan(0)
      expect(runner.process?.exitCode).toBe(0)

      const executingCalls = logSpy.mock.calls.filter(
        (call) => call[0] === '[ClaudeBridge CLI] Executing claude'
      )
      expect(executingCalls).toHaveLength(1)
      const loggedPayload = String(executingCalls[0]?.[1] ?? '')
      expect(loggedPayload).toContain('<redacted>')
      expect(loggedPayload).not.toContain('SECRET SYSTEM PROMPT')
      expect(loggedPayload).toContain(probePath)
    } finally {
      logSpy.mockRestore()
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 15000)

  posixIt(
    'BL-498: always spawns Claude with an explicit --setting-sources value, never omitting it',
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-bridge-setting-sources-test-'))
      // A tiny Node probe (not the shell probes above) so it can report the exact argv it
      // received, not just an env var. Reads one stdin line first, matching the other probes'
      // "wait for the compiled user line" shape.
      const probePath = path.join(tempDir, 'claude-argv-probe.mjs')
      await writeFile(
        probePath,
        [
          '#!/usr/bin/env node',
          'process.stdin.resume()',
          'process.stdin.once("data", () => {',
          '  process.stdout.write(JSON.stringify({ type: "probe", argv: process.argv.slice(2) }) + "\\n")',
          '  process.exit(0)',
          '})'
        ].join('\n'),
        'utf8'
      )
      await chmod(probePath, 0o755)

      mockDetectClaudeCliStatus.mockResolvedValue({
        available: true,
        executable: probePath,
        version: '0.0.0-test',
        source: 'env'
      })

      const { ClaudeBridge } = await import('../claudeBridge')
      const bridge = new ClaudeBridge()

      const probeArgv = async (settingSources: string[] | undefined) => {
        const runner = await (bridge as any).runViaCli('{"type":"user"}', {
          workingDirectory: tempDir,
          permissionMode: 'acceptEdits',
          configScope: 'managed',
          settingSources,
          contextGuard: null
        })
        const events: any[] = []
        try {
          for await (const event of runner.events) events.push(event)
        } finally {
          await runner.cleanup?.()
        }
        return events.find((event) => event?.type === 'probe')?.argv as string[]
      }

      // Off case (agent.claude_settings.includeProjectInstructions = false -> settingSources
      // = []): the flag must still be present. Its value must be the exact empty string Claude
      // Code's own bundled `--setting-sources` parser accepts as "load nothing" (verified
      // against the installed 2.1.280 binary: `Fmo("")` returns `[]`, and Claude Code's own
      // `--restricted` startup path passes this same value). Omitting the flag here is the bug:
      // Claude Code then falls back to its default of loading ALL sources (user, project,
      // local), which reads the user's own ~/.claude/settings.json.
      const offArgv = await probeArgv([])
      const offIndex = offArgv.indexOf('--setting-sources')
      expect(offIndex).toBeGreaterThanOrEqual(0)
      expect(offArgv[offIndex + 1]).toBe('')

      // On case (default): unchanged behavior, still an explicit value.
      const onArgv = await probeArgv(['project'])
      const onIndex = onArgv.indexOf('--setting-sources')
      expect(onIndex).toBeGreaterThanOrEqual(0)
      expect(onArgv[onIndex + 1]).toBe('project')
    },
    15000
  )

  posixIt('uses only current-run session and message IDs in the spawned CLI child', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-bridge-id-env-test-'))
    const probePath = path.join(tempDir, 'claude-id-probe.sh')
    const previousSessionId = process.env.BATSHIT_SESSION_ID
    const previousMessageId = process.env.BATSHIT_MESSAGE_ID
    process.env.BATSHIT_SESSION_ID = 'inherited-stale-session'
    process.env.BATSHIT_MESSAGE_ID = 'inherited-stale-message'

    try {
      await writeFile(
        probePath,
        [
          '#!/bin/sh',
          'IFS= read -r _line',
          'printf \'{"type":"probe","sessionId":"%s","messageId":"%s"}\\n\' "$BATSHIT_SESSION_ID" "$BATSHIT_MESSAGE_ID"',
          'exit 0'
        ].join('\n'),
        'utf8'
      )
      await chmod(probePath, 0o755)
      mockDetectClaudeCliStatus.mockResolvedValue({
        available: true,
        executable: probePath,
        version: '0.0.0-test',
        source: 'env'
      })

      const { ClaudeBridge } = await import('../claudeBridge')
      const bridge = new ClaudeBridge()
      const probe = async (options: Record<string, unknown>) => {
        const runner = await (bridge as any).runViaCli('{"type":"user"}', {
          workingDirectory: tempDir,
          permissionMode: 'acceptEdits',
          contextGuard: null,
          ...options
        })
        const events: any[] = []
        try {
          for await (const event of runner.events) events.push(event)
        } finally {
          await runner.cleanup?.()
        }
        return events.find((event) => event?.type === 'probe')
      }

      const conflictingManagedEnv = {
        BATSHIT_SESSION_ID: 'managed-stale-session',
        BATSHIT_MESSAGE_ID: 'managed-stale-message'
      }
      expect(await probe({ managedStdioEnv: conflictingManagedEnv })).toMatchObject({
        sessionId: '',
        messageId: ''
      })
      expect(await probe({
        sessionId: 'current-session',
        messageId: 'current-message',
        managedStdioEnv: conflictingManagedEnv
      })).toMatchObject({
        sessionId: 'current-session',
        messageId: 'current-message'
      })
    } finally {
      if (previousSessionId === undefined) delete process.env.BATSHIT_SESSION_ID
      else process.env.BATSHIT_SESSION_ID = previousSessionId
      if (previousMessageId === undefined) delete process.env.BATSHIT_MESSAGE_ID
      else process.env.BATSHIT_MESSAGE_ID = previousMessageId
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 15000)

  it('passes selected MCP tools into Claude CLI allowedTools', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()

    const allowed = (bridge as any).buildCliAllowedTools({
      allowedTools: ['Read'],
      allowedMcpTools: ['mcp__batshit_gateway_demo__allowed_tool'],
      planAllowedTools: ['mcp__batshit_gateway_agent_subagents__subagent_api_helper']
    })

    expect(allowed).toEqual([
      'Read',
      'mcp__batshit_gateway_demo__allowed_tool',
      'mcp__batshit_gateway_agent_subagents__subagent_api_helper'
    ])
  })

  it('Plan pre-allows only assigned Subagents, even with ordinary user and MCP allow rules', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const bridge = new ClaudeBridge()
    const options = {
      permissionMode: 'plan',
      allowedTools: ['Bash(*)', 'Write'],
      allowedMcpTools: ['mcp__batshit_helpers__batshit_tool_use', 'mcp__user_gateway__write'],
      planAllowedTools: ['mcp__assigned_subagents__subagent_helper']
    }
    expect((bridge as any).buildCliAllowedTools(options)).toEqual(options.planAllowedTools)
    expect((bridge as any).buildCliAllowedTools({ ...options, planAllowedTools: [] })).toEqual([])
  })
})

/* -------------------------------------------------------------------------- *
 * SA-117 P2 (DL-117-07) — the Claude lane's half of the child-environment rule.
 *
 * The Codex lane's builder is asserted in `codexBridge.test.ts`. This is the same claim on
 * the other lane, and it matters MORE here: the Claude CLI merges its `env` map with the
 * inherited parent environment (that is how the permission bridge reads `REDIS_URL` with no
 * env block at all), so nothing but an explicit delete removes the instance token.
 * -------------------------------------------------------------------------- */

describe('SA-117: the Claude child environment', () => {
  const withEnv = async (
    overrides: Record<string, string | undefined>,
    run: (build: typeof import('../claudeBridge').buildClaudeRunChildEnv) => void | Promise<void>
  ) => {
    const previous: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(overrides)) {
      previous[key] = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      const { buildClaudeRunChildEnv } = await import('../claudeBridge')
      await run(buildClaudeRunChildEnv)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('drops BATSHIT_TOKEN and carries the run credential', async () => {
    await withEnv(
      { BATSHIT_TOKEN: 'instance-secret', MCP_GATEWAY_AUTH_TOKEN: 'inherited-gateway-token' },
      (buildClaudeRunChildEnv) => {
        const envVars = buildClaudeRunChildEnv({
          agentRunToken: 'arc_abc.bsac_secret',
          dockerAuthToken: null
        })

        expect(envVars.BATSHIT_TOKEN).toBeUndefined()
        expect(envVars.BATSHIT_AGENT_TOKEN).toBe('arc_abc.bsac_secret')
        expect(envVars.MCP_GATEWAY_AUTH_TOKEN).toBeUndefined()
      }
    )
  })

  it('keeps inherited host operator authority out of the Claude CLI environment', async () => {
    const authority = {
      BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN: 'operator-token',
      BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN: 'sandbox-alias',
      BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY: 'recipe-key',
      BATSHIT_HOST_VOICE_RECIPE_KEY_FILE: '/private/host/key'
    }
    await withEnv(authority, (buildClaudeRunChildEnv) => {
      const childEnv = buildClaudeRunChildEnv({ agentRunToken: null, dockerAuthToken: null })
      for (const key of Object.keys(authority)) expect(childEnv[key]).toBeUndefined()
    })
  })

  it('keeps the gateway token for a run that resolved one', async () => {
    await withEnv({ BATSHIT_TOKEN: 'instance-secret' }, (buildClaudeRunChildEnv) => {
      const envVars = buildClaudeRunChildEnv({
        agentRunToken: 'arc_abc.bsac_secret',
        dockerAuthToken: 'run-gateway-token'
      })

      expect(envVars.MCP_GATEWAY_AUTH_TOKEN).toBe('run-gateway-token')
      expect(envVars.BATSHIT_TOKEN).toBeUndefined()
    })
  })

  it('never leaves a stale credential behind for a run that minted none', async () => {
    // The app's own environment can carry `BATSHIT_AGENT_TOKEN` — a developer shell, a
    // parent Batshit run. A run that minted nothing must fail loudly in its helper, not
    // authenticate as whatever run exported one last.
    await withEnv(
      { BATSHIT_TOKEN: 'instance-secret', BATSHIT_AGENT_TOKEN: 'arc_stale.bsac_old' },
      (buildClaudeRunChildEnv) => {
        const envVars = buildClaudeRunChildEnv({ agentRunToken: null, dockerAuthToken: null })

        expect(envVars.BATSHIT_AGENT_TOKEN).toBeUndefined()
        expect(envVars.BATSHIT_TOKEN).toBeUndefined()
      }
    )
  })

  it('leaves the honest boundary alone: Redis and provider secrets still travel', async () => {
    // SA-117 Scope says this out loud rather than pretending a deny-list fences a host
    // shell. The Claude permission bridge and the Codex subagent bridge read Redis directly.
    await withEnv(
      { BATSHIT_TOKEN: 'instance-secret', REDIS_URL: 'redis://127.0.0.1:6379' },
      (buildClaudeRunChildEnv) => {
        const envVars = buildClaudeRunChildEnv({
          agentRunToken: 'arc_abc.bsac_secret',
          dockerAuthToken: null
        })

        expect(envVars.REDIS_URL).toBe('redis://127.0.0.1:6379')
      }
    )
  })
})

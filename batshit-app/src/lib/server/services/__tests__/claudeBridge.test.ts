import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { logger } from '$lib/utils/logger'

const mockGatewayService = {
  list: vi.fn()
}

const mockDetectClaudeCliStatus = vi.fn()
// This probe is a POSIX shell executable; Windows cannot spawn it directly.
const posixIt = process.platform === 'win32' ? it.skip : it

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: mockGatewayService
}))

vi.mock('$lib/server/services/claudeCliStatus', () => ({
  detectClaudeCliStatus: mockDetectClaudeCliStatus,
  resolveClaudeCliExecutable: vi.fn(() => '/fake/claude')
}))

describe('ClaudeBridge managed MCP scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    const { buildManagedGatewayId } = await import('../codexProfileManager')
    const {
      buildMode4InternalHelpersGatewayId,
      buildMode4InternalHelpersGatewaySlug
    } = await import('../mode4InternalTools')
    const bridge = new ClaudeBridge()
    const managedId = buildManagedGatewayId(
      buildMode4InternalHelpersGatewayId('agent_cli'),
      buildMode4InternalHelpersGatewaySlug('agent-cli')
    )
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
      agentSlug: 'agent-cli',
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
      agentSlug: 'agent-cli',
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
    const { buildManagedGatewayId } = await import('../codexProfileManager')
    const {
      buildMode4InternalHelpersGatewayId,
      buildMode4InternalHelpersGatewaySlug
    } = await import('../mode4InternalTools')
    const bridge = new ClaudeBridge()
    const managedId = buildManagedGatewayId(
      buildMode4InternalHelpersGatewayId('agent_browser'),
      buildMode4InternalHelpersGatewaySlug('agent-browser')
    )
    const searchTool = `mcp__${managedId}__batshit_tool_search`
    const useTool = `mcp__${managedId}__batshit_tool_use`
    const legacyFindTool = `mcp__${managedId}__batshit_server_agent_browser_find`
    const legacyUseTool = `mcp__${managedId}__batshit_server_agent_browser_use`

    const toolAccess = await (bridge as any).resolveMode4InternalControlAllowTools({
      agentId: 'agent_browser',
      agentSlug: 'agent-browser',
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

  it('includes Mode 4 Bash helper tools when Bash is enabled', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const { buildManagedGatewayId } = await import('../codexProfileManager')
    const {
      buildMode4InternalHelpersGatewayId,
      buildMode4InternalHelpersGatewaySlug
    } = await import('../mode4InternalTools')
    const bridge = new ClaudeBridge()
    const managedId = buildManagedGatewayId(
      buildMode4InternalHelpersGatewayId('agent_bash'),
      buildMode4InternalHelpersGatewaySlug('agent-bash')
    )
    const bashTool = `mcp__${managedId}__batshit_server_bash_execute`

    const toolAccess = await (bridge as any).resolveMode4InternalControlAllowTools({
      agentId: 'agent_bash',
      agentSlug: 'agent-bash',
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          agentBrowserEnabled: false,
          bashEnabled: true
        }
      },
      selectedCliToolIds: []
    })

    expect(toolAccess.allowTools).toContain(bashTool)
    expect(toolAccess.disallowTools).not.toContain(bashTool)
  })

  it('builds assigned subagent MCP tool names for Claude permission allow-listing', async () => {
    const { ClaudeBridge } = await import('../claudeBridge')
    const { buildManagedGatewayId } = await import('../codexProfileManager')
    const bridge = new ClaudeBridge()
    const managedId = buildManagedGatewayId('agent_cli-subagents', 'agent-cli-subagents')

    const allowed = (bridge as any).resolveSubagentPlanAllowTools({
      agentId: 'agent_cli',
      agentSlug: 'agent-cli',
      assignedSubagents: [
        { id: 'api-subagent', displayName: 'API Subagent' },
        'cli-subagent'
      ]
    })

    expect(allowed).toContain(`mcp__${managedId}__subagent_api_subagent`)
    expect(allowed).toContain(`mcp__${managedId}__subagent_cli_subagent`)
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
    // Stands in for the claude executable: drains stdin, then reports the env it received
    // as a stream-json line so the test can assert spawn-time secret injection.
    await writeFile(
      probePath,
      [
        '#!/bin/sh',
        'cat >/dev/null',
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
})

import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import toml from '@iarna/toml'

/**
 * BL-318 — a managed CLI agent can finish an artifact run as long as the artifact's own run
 * limit allows.
 *
 * The managed controls helper (`scripts/mode4-controls-mcp.cjs`) cut every `/api/controls/use`
 * call at 60 s, while an artifact run may take 2 minutes (10 for a Pinokio app, which runs a
 * model on this computer: `resolveArtifactRunTimeoutMs`). The CLIs cut a tool call too: Codex
 * after its `tool_timeout_sec` (60 s unless set, per the Codex MCP docs), so the helper's own
 * wait must fit inside the CLI's, and both must outlast the longest run limit.
 */

const require = createRequire(import.meta.url)
const waits = require(path.join(process.cwd(), 'scripts', 'lib', 'cli-helper-waits.cjs')) as {
  CONTROL_USE_WAIT_MS: number
  CLI_HELPER_LONGEST_WAIT_MS: number
  resolveControlUseWaitMs: (controlId: unknown) => number
}

const ORIGINAL_HOME = process.env.HOME
const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!testHome.current) throw new Error('cliHelperWaits.test: no temporary home is set')
    return testHome.current
  }
  return { ...real, homedir, default: { ...real, homedir } }
})
vi.mock('$env/dynamic/private', () => ({
  env: { BATSHIT_CODEX_PROVIDER_ENABLED: 'true', BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true', BATSHIT_TOKEN: '' }
}))
const mockRedis = vi.hoisted(() => ({
  getAgents: vi.fn(),
  // BL-745: a profile sync writes an agent's folder only while the agent's record exists.
  json: { get: vi.fn(async (key: string) => (key.startsWith('agent:') ? { id: key.slice('agent:'.length) } : null)) },
  getProjectPreferences: vi.fn(async () => null),
  getProjects: vi.fn(async () => []),
  get: vi.fn(async () => null),
  getUserSettings: vi.fn(async () => null)
}))
vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: { list: vi.fn(async () => []), update: vi.fn() }
}))
vi.mock('$lib/server/services/mcpSelectionResolver', () => ({
  resolveMCPSelections: vi.fn(async () => ({
    resolvedGateways: [],
    defaultGateways: [],
    resolvedToolSelections: [],
    tools: {},
    toolMetadata: new Map(),
    gatewayToolMap: {}
  }))
}))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn(async () => null), store: vi.fn() }
}))

const NATIVE_TOOLS = {
  nativeTools: { fetchZipEnabled: true, dynamicMcpEnabled: true, batshitToolsEnabled: true, bashEnabled: true }
}

describe('BL-318: how long the managed controls helper waits', () => {
  it('waits past the longest artifact run limit for an artifact run, and 60 s for any other control', async () => {
    // The registry reads the home folder when it loads.
    testHome.current = await mkdtemp(path.join(os.tmpdir(), 'zccli-bl318-registry-'))
    const { resolveArtifactRunTimeoutMs } = await import('../fabricRegistry')
    await rm(testHome.current, { recursive: true, force: true })
    testHome.current = ''
    const longestArtifactRun = Math.max(
      resolveArtifactRunTimeoutMs({ brain_type: 'pinokio_app' }),
      resolveArtifactRunTimeoutMs({ brain_type: 'n8n' }),
      resolveArtifactRunTimeoutMs(null)
    )
    for (const controlId of ['use.artifact.zccli-slow', 'artifact.abc123.typed.invoke', 'artifact.abc123.action.run.run']) {
      expect(waits.resolveControlUseWaitMs(controlId), controlId).toBeGreaterThan(longestArtifactRun)
    }
    for (const controlId of ['sys.zip.fetch', 'sys.memory.save', 'sys.artifact.create', '', null]) {
      expect(waits.resolveControlUseWaitMs(controlId), String(controlId)).toBe(waits.CONTROL_USE_WAIT_MS)
    }
    expect(waits.CONTROL_USE_WAIT_MS).toBe(60_000)
    expect(waits.CLI_HELPER_LONGEST_WAIT_MS).toBe(waits.resolveControlUseWaitMs('use.artifact.x'))
  })

  it('the helper itself uses that wait for /api/controls/use', async () => {
    const source = await readFile(path.join(process.cwd(), 'scripts', 'mode4-controls-mcp.cjs'), 'utf8')
    expect(source).toMatch(/postJson\('\/api\/controls\/use', payload, resolveControlUseWaitMs\(payload\.controlId\)\)/)
  })
})

describe('BL-318: each CLI lane lets a helper call run as long as the helper waits', () => {
  beforeEach(async () => {
    vi.resetModules()
    testHome.current = await mkdtemp(path.join(os.tmpdir(), 'zccli-bl318-'))
    // The Claude manager reads process.env.HOME before os.homedir(), so both point here.
    process.env.HOME = testHome.current
  })
  afterEach(async () => {
    const home = testHome.current
    testHome.current = ''
    if (ORIGINAL_HOME === undefined) delete process.env.HOME
    else process.env.HOME = ORIGINAL_HOME
    if (home) await rm(home, { recursive: true, force: true })
    // Safety net: nothing of these profiles lands in the real home.
    const realOs = await vi.importActual<typeof import('node:os')>('node:os')
    const realAgents = await readdir(path.join(realOs.homedir(), '.batshit', 'agents')).catch(() => [] as string[])
    expect(realAgents.filter((entry) => /^batshit_agent_agent-(codex|claude)$/.test(entry))).toEqual([])
  })

  it("Codex: the batshit_helpers server's tool_timeout_sec outlasts the helper's longest wait", async () => {
    mockRedis.getAgents.mockResolvedValue([
      { id: 'agent-codex', displayName: 'Probe', slug: 'zccli-codex', primary_model_provider: 'codex-cli', codex_settings: {}, provider_specific_settings: NATIVE_TOOLS, assignedSubagents: [], workers_enabled: false }
    ])
    const manager = await import('../codexProfileManager')
    await manager.syncAgentCodexProfiles('josh')
    const config = toml.parse(
      await readFile(
        path.join(testHome.current, '.batshit', 'agents', manager.buildAgentProfileId('agent-codex'), '.codex', 'config.toml'),
        'utf8'
      )
    ) as any
    const helper = config.mcp_servers.batshit_helpers
    expect(typeof helper.tool_timeout_sec).toBe('number')
    expect(helper.tool_timeout_sec * 1000).toBeGreaterThan(waits.CLI_HELPER_LONGEST_WAIT_MS)
  })

  it("Claude: the batshit_helpers server's timeout outlasts the helper's longest wait", async () => {
    mockRedis.getAgents.mockResolvedValue([
      { id: 'agent-claude', displayName: 'Probe', slug: 'zccli-claude', primary_model_provider: 'claude-cli', claude_settings: {}, provider_specific_settings: NATIVE_TOOLS, assignedSubagents: [], workers_enabled: false }
    ])
    const claude = await import('../claudeProfileManager')
    await claude.syncAgentClaudeProfiles('josh')
    const { mcpPath } = claude.getManagedClaudePaths(claude.buildClaudeProfileId('agent-claude'))
    const helper = JSON.parse(await readFile(mcpPath, 'utf8')).mcpServers.batshit_helpers
    expect(typeof helper.timeout).toBe('number')
    expect(helper.timeout).toBeGreaterThan(waits.CLI_HELPER_LONGEST_WAIT_MS)
  })
})

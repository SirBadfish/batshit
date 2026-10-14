import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import toml from '@iarna/toml'

/**
 * BL-310 — a managed CLI reaches the Docker MCP gateway at the URL the app itself uses.
 *
 * The saved Docker gateway record keeps the URL Settings wrote when it was added
 * (`http://localhost:8080/mcp`), while the app builds the gateway's address from the runtime
 * (`DOCKER_MCP_GATEWAY_PORT`, and in Docker the in-app proxy). The profile managers wrote the
 * saved URL into Codex's `config.toml` and Claude's `mcp.json`, so a lane with its own gateway
 * port (the FirstRun lane's 5648) sent its managed CLIs to another Batshit's gateway.
 *
 * Every Batshit on the Mac rewrites those shared files (BL-152), so the files carry a reference
 * and each run fills in its own process's address: Codex through a per-run `--config`
 * override read from the file, Claude Code by expanding `${VAR}` from the run's environment.
 */

const ORIGINAL_HOME = process.env.HOME
const testHome = vi.hoisted(() => ({ current: '' }))
const runtimeEnv = vi.hoisted(() => ({
  values: {} as Record<string, string | undefined>
}))

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!testHome.current) throw new Error('cliProfileDockerGatewayUrl.test: no temporary home is set')
    return testHome.current
  }
  return { ...real, homedir, default: { ...real, homedir } }
})

vi.mock('$env/dynamic/private', () => ({
  get env() {
    return runtimeEnv.values
  }
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
const mockGatewayService = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }))
const mockResolveMCPSelections = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({ mcpGatewayService: mockGatewayService }))
vi.mock('$lib/server/services/mcpSelectionResolver', () => ({
  resolveMCPSelections: mockResolveMCPSelections
}))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn(async () => null), store: vi.fn() }
}))

const dockerGateway = {
  id: 'gw-docker',
  name: 'Docker MCP Gateway',
  slug: 'docker_mcp_gateway',
  type: 'docker-catalog',
  enabled: true,
  // What Settings saves when the gateway is added (MCPSettingsPanel), whatever the lane.
  url: 'http://localhost:8080/mcp',
  created_at: new Date().toISOString()
}

function agent(overrides: Record<string, unknown>) {
  return {
    displayName: 'Probe',
    provider_specific_settings: {
      nativeTools: {
        fetchZipEnabled: false,
        dynamicMcpEnabled: false,
        batshitToolsEnabled: false,
        agentBrowserEnabled: false
      }
    },
    assignedSubagents: [],
    workers_enabled: false,
    ...overrides
  }
}

describe('BL-310: managed CLI profiles and the Docker MCP gateway URL', () => {
  beforeEach(async () => {
    vi.resetModules()
    testHome.current = await mkdtemp(path.join(os.tmpdir(), 'zccli-bl310-'))
    // The Claude manager reads process.env.HOME before os.homedir(), so both point here.
    process.env.HOME = testHome.current
    runtimeEnv.values = {
      BATSHIT_CODEX_PROVIDER_ENABLED: 'true',
      BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true',
      BATSHIT_TOKEN: '',
      MCP_GATEWAY_AUTH_TOKEN: 'zccli-gateway-token'
    }
    mockGatewayService.list.mockResolvedValue([dockerGateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [dockerGateway.id],
      defaultGateways: [dockerGateway.id],
      resolvedToolSelections: ['search'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: { [dockerGateway.id]: ['search'] }
    })
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

  async function codexGatewayUrl() {
    mockRedis.getAgents.mockResolvedValue([
      agent({ id: 'agent-codex', slug: 'zccli-codex', primary_model_provider: 'codex-cli', codex_settings: {} })
    ])
    const manager = await import('../codexProfileManager')
    await manager.syncAgentCodexProfiles('josh')
    const configPath = path.join(
      testHome.current,
      '.batshit',
      'agents',
      manager.buildAgentProfileId('agent-codex'),
      '.codex',
      'config.toml'
    )
    const serverId = manager.buildManagedGatewayId(dockerGateway.id, dockerGateway.slug)
    const parsed = toml.parse(await readFile(configPath, 'utf8')) as any
    // The shared file names no lane's address, so two Batshits write the same bytes.
    expect(parsed.mcp_servers[serverId]?.url).toBe('${BATSHIT_CLI_DOCKER_MCP_GATEWAY_URL}')
    // What this run hands Codex, read from that file right before the spawn.
    const overrides = await manager.readManagedCodexHelperLaunchOverrides(path.dirname(configPath))
    const prefix = `mcp_servers.${serverId}.url=`
    const override = overrides.find((entry) => entry.startsWith(prefix))
    return override ? JSON.parse(override.slice(prefix.length)) : undefined
  }

  async function claudeGatewayUrl() {
    mockRedis.getAgents.mockResolvedValue([
      agent({ id: 'agent-claude', slug: 'zccli-claude', primary_model_provider: 'claude-cli', claude_settings: {} })
    ])
    const claude = await import('../claudeProfileManager')
    const { buildManagedGatewayId } = await import('../codexProfileManager')
    await claude.syncAgentClaudeProfiles('josh')
    const { mcpPath } = claude.getManagedClaudePaths(claude.buildClaudeProfileId('agent-claude'))
    const parsed = JSON.parse(await readFile(mcpPath, 'utf8'))
    const url = parsed.mcpServers[buildManagedGatewayId(dockerGateway.id, dockerGateway.slug)]?.url
    expect(url).toBe('${BATSHIT_CLI_DOCKER_MCP_GATEWAY_URL}')
    // Claude Code expands the reference from the run's environment.
    const { buildClaudeRunChildEnv } = await import('../claudeBridge')
    const childEnv = buildClaudeRunChildEnv({ agentRunToken: null, dockerAuthToken: null })
    return String(url).replace('${BATSHIT_CLI_DOCKER_MCP_GATEWAY_URL}', childEnv.BATSHIT_CLI_DOCKER_MCP_GATEWAY_URL ?? '')
  }

  it("Codex: the lane's own gateway port, not the saved URL", async () => {
    runtimeEnv.values.DOCKER_MCP_GATEWAY_PORT = '5648'
    expect(await codexGatewayUrl()).toBe('http://127.0.0.1:5648/mcp')
  })

  it("Claude: the lane's own gateway port, not the saved URL", async () => {
    runtimeEnv.values.DOCKER_MCP_GATEWAY_PORT = '5648'
    expect(await claudeGatewayUrl()).toBe('http://127.0.0.1:5648/mcp')
  })

  it('Docker Batshit: both CLIs go through the in-app gateway proxy, as the app does', async () => {
    runtimeEnv.values.BATSHIT_CONTAINERIZED = '1'
    runtimeEnv.values.DOCKER_MCP_GATEWAY_PORT = '8080'
    runtimeEnv.values.PORT = '3000'
    const proxy = 'http://127.0.0.1:3000/api/mcp/gateway/proxy/mcp'
    expect(await codexGatewayUrl()).toBe(proxy)
    vi.resetModules()
    expect(await claudeGatewayUrl()).toBe(proxy)
  })

  it('the same URL as the one the app itself calls (buildDockerGatewayUrl)', async () => {
    runtimeEnv.values.DOCKER_MCP_GATEWAY_URL = 'http://127.0.0.1:9123'
    const { buildDockerGatewayUrl } = await import('../dockerGatewayConfig')
    const expected = buildDockerGatewayUrl('/mcp')
    expect(expected).toBe('http://127.0.0.1:9123/mcp')
    expect(await codexGatewayUrl()).toBe(expected)
    vi.resetModules()
    expect(await claudeGatewayUrl()).toBe(expected)
  })
})

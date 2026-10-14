import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises'
import toml from '@iarna/toml'

const { parse: parseToml } = toml

const mockRedis = {
  getAgents: vi.fn(),
  // BL-745: a profile sync writes an agent's folder only while the agent's record exists.
  json: { get: vi.fn(async (key: string) => (key.startsWith('agent:') ? { id: key.slice('agent:'.length), user_id: 'josh' } : null)) },
  getProjectPreferences: vi.fn(),
  getProjects: vi.fn(),
  get: vi.fn(),
  getUserSettings: vi.fn()
}

const mockGatewayService = {
  list: vi.fn(),
  update: vi.fn()
}

const mockResolveMCPSelections = vi.fn()
const mockApiKeyService = {
  retrieve: vi.fn(),
  store: vi.fn()
}

/**
 * BL-160: the profile managers write under the home folder, and the Codex one reads
 * `os.homedir()` when its modules load. Setting `process.env.HOME` alone moves it on the
 * default (forks) lane only: on the real-Redis (threads) lane a worker's `process.env` is a
 * copy, `os.homedir()` still answers the real home, and these tests wrote
 * `batshit_agent_agent-1` and `batshit_agent_subagent_cli_bl7_override` into the real
 * `~/.batshit/agents`. So `node:os` itself answers the temporary home, through both import
 * styles, and refuses to answer before a test has set one (the pattern of
 * `cliHelperServerParity.test.ts`).
 */
const testHome = vi.hoisted(() => ({ current: '' }))
/** The profile folders this suite's fixtures write (`batshit_agent_<fixture id>`). */
const SUITE_PROFILE_FOLDER = /^batshit_agent_(agent-|subagent_cli_bl7_override|subagent_cli_bl878|subagent_cli-worker_bl878)/
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!testHome.current) throw new Error('codexProfileManager.test: no temporary home is set')
    return testHome.current
  }
  return { ...real, homedir, default: { ...real, homedir } }
})

vi.mock('$env/dynamic/private', () => ({
  env: {
    BATSHIT_CODEX_PROVIDER_ENABLED: 'true',
    BATSHIT_CODEX_WORKDIR: '',
    BATSHIT_TOKEN: ''
  }
}))

vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({ mcpGatewayService: mockGatewayService }))
vi.mock('$lib/server/services/mcpSelectionResolver', () => ({
  resolveMCPSelections: mockResolveMCPSelections
}))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: mockApiKeyService }))
vi.mock('$lib/server/services/dockerGatewayConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/dockerGatewayConfig')>()
  return {
    ...actual,
    getDockerGatewayAuthToken: vi.fn(() => null)
  }
})

describe('codexProfileManager dynamic-only managed config', () => {
  const originalHome = process.env.HOME
  let tempHome = ''
  let realAgentsRoot = ''
  let realAgentsBefore: string[] = []

  const listRealAgents = async () => (await readdir(realAgentsRoot).catch(() => [] as string[])).sort()

  beforeAll(async () => {
    // The real home, read from the real module before any test moves HOME.
    const realOs = await vi.importActual<typeof import('node:os')>('node:os')
    realAgentsRoot = path.join(realOs.homedir(), '.batshit', 'agents')
    realAgentsBefore = await listRealAgents()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mockRedis.json.get.mockImplementation(async (key: string) =>
      key.startsWith('agent:') ? { id: key.slice('agent:'.length), user_id: 'josh' } : null
    )
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'codex-profile-test-'))
    testHome.current = tempHome
    process.env.HOME = tempHome

    mockRedis.getProjectPreferences.mockResolvedValue(null)
    mockRedis.getProjects.mockResolvedValue([])
    mockRedis.get.mockResolvedValue(null)
    mockRedis.getUserSettings.mockResolvedValue(null)
    mockApiKeyService.retrieve.mockResolvedValue(null)
    mockApiKeyService.store.mockResolvedValue(undefined)
    // BL-1371: answer as the real `update` does, the listed gateway with the change applied (a
    // function change runs on that gateway), so the token migration's caller copy is what is stored.
    mockGatewayService.update.mockImplementation(async (_userId: string, gatewayId: string, change: any) => {
      const listed = ((await mockGatewayService.list.mock.results.at(-1)?.value) ?? []) as any[]
      const stored = structuredClone(listed.find((gateway) => gateway.id === gatewayId) ?? { id: gatewayId })
      return { ...stored, ...(typeof change === 'function' ? change(stored) : change) }
    })
  })

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    testHome.current = ''
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true })
    }
    // Safety net: no test may add one of this suite's profile folders to the real home (other
    // Batshit processes may add their own there meanwhile, so only this suite's ids count).
    const added = (await listRealAgents()).filter(
      (entry) => !realAgentsBefore.includes(entry) && SUITE_PROFILE_FOLDER.test(entry)
    )
    expect(added).toEqual([])
  })

  function buildCodexAgent(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'agent-1',
      displayName: 'Managed Codex',
      slug: 'managed-codex',
      agentType: 'batshit',
      primary_model_provider: 'codex-cli',
      codex_settings: {},
      provider_specific_settings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          agentBrowserEnabled: false
        }
      },
      assignedSubagents: [],
      ...overrides
    }
  }

  function buildGateway(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'gw-main',
      name: 'Main Gateway',
      slug: 'main_gateway',
      type: 'custom',
      url: 'https://example.test/mcp',
      enabled: true,
      discoveredTools: ['legacy_tool', 'allowed_tool'],
      toolGroupings: [{ mcpName: 'Legacy Group', toolIds: ['legacy_tool', 'allowed_tool'] }],
      metadata: {},
      created_at: new Date().toISOString(),
      ...overrides
    }
  }

  it('does not fall back to stale gateway metadata when canonical gatewayToolMap is empty', async () => {
    const agent = buildCodexAgent()
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['legacy_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>
    // BL-5: one fixed helper server name, whatever the agent id or slug.
    const mode4Server = parsed.mcp_servers?.batshit_helpers

    expect(config).not.toContain('[mcp_servers.batshit_gateway_main_gateway]')
    expect(config).not.toContain('legacy_tool')
    expect(config).toContain('[mcp_servers.batshit_helpers]')
    expect(config).not.toContain('mode4-controls]')
    // BL-878: a managed Codex agent has its own Bash, so the default-on Bash setting (nothing
    // saved here) no longer puts Batshit's helper on the list; the deny list names it.
    expect(config).toContain('enabled_tools = ["native_skill"]')
    expect(mode4Server?.enabled_tools).toEqual(['native_skill'])
    expect(mode4Server?.disabled_tools).toContain('batshit_server_bash_execute')
    // BL-152: the shared file names the URL by reference; each run fills in its own process's.
    expect(mode4Server?.args).toContain('--url=${BATSHIT_CLI_HELPER_BASE_URL}')
    expect(mode4Server?.args?.[0]).toBe('${BATSHIT_CLI_HELPER_SCRIPTS_DIR}/mode4-controls-mcp.cjs')
    // SA-105 P3 (AMD-105-09): the bridge must be told which CLI consumes its
    // results, because that alone decides whether a recalled memory image can
    // ride back as MCP image content. Codex renders those blocks.
    expect(mode4Server?.args).toContain('--runtime=codex')
    expect(mode4Server?.env_vars).toEqual([
      // SA-117 DL-117-06: the helper forwards THIS run's credential, not the instance
      // token — which `codexBridge.ts` now deletes from the child environment entirely, so
      // forwarding its name here would forward nothing.
      'BATSHIT_AGENT_TOKEN',
      'BATSHIT_SESSION_ID',
      // SA-116 DL-116-07: the helper needs the assistant message id, or a risky-control
      // refusal on this lane records a pause with no card the user can click.
      'BATSHIT_MESSAGE_ID',
      'BATSHIT_PROJECT_PATH',
      'BATSHIT_FRONTEND_URL',
      'PUBLIC_BASE_URL',
      'ORIGIN'
    ])
    expect(mode4Server?.env_vars).toContain('BATSHIT_MESSAGE_ID')
    expect(mode4Server?.env_vars).not.toContain('BATSHIT_TOKEN')
    expect(mode4Server?.default_tools_approval_mode).toBe('approve')
  })

  it('emits only canonical gatewayToolMap tools into managed gateway blocks', async () => {
    const agent = buildCodexAgent()
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).toContain('[mcp_servers.batshit_gateway_main_gateway]')
    expect(config).toContain('enabled_tools = ["allowed_tool"]')
    expect(config).not.toContain('legacy_tool')
  })

  it('skips read-only n8n MCP client gateway records in managed Codex TOML', async () => {
    const agent = buildCodexAgent()
    const gateway = buildGateway({
      id: 'n8n-mcp-client:workflow:node',
      slug: 'n8n_client',
      name: 'n8n Client Node',
      type: 'n8n-mcp-client',
      url: 'n8n-mcp-client://workflow/node',
      discoveredTools: ['allowed_tool']
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).not.toContain('[mcp_servers.batshit_gateway_n8n_client]')
    expect(config).not.toContain('n8n-mcp-client://workflow/node')
    expect(config).not.toContain('allowed_tool')
  })

  it('writes managed stdio MCP blocks with env placeholders and timeout fields', async () => {
    const agent = buildCodexAgent()
    const gateway = buildGateway({
      id: 'gw-stdio',
      slug: 'stdio_gateway',
      name: 'Local STDIO',
      type: 'stdio',
      url: undefined,
      stdioConfig: {
        command: 'node',
        args: ['server.js'],
        cwdPolicy: 'fixed',
        cwdValue: '/tmp/stdio-gateway',
        envRefs: [{ envVar: 'GITHUB_TOKEN', savedKeyRef: 'github' }],
        startupTimeoutMs: 15000,
        toolCallTimeoutMs: 65000
      }
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>
    const managed = parsed.mcp_servers?.batshit_gateway_stdio_gateway

    expect(managed.command).toBe('node')
    expect(managed.args).toEqual(['server.js'])
    expect(managed.cwd).toBe('/tmp/stdio-gateway')
    expect(managed.env).toEqual({
      GITHUB_TOKEN: '${BATSHIT_MCP_STDIO_GW_STDIO_GITHUB_TOKEN}'
    })
    expect(managed.startup_timeout_sec).toBe(15)
    expect(managed.tool_timeout_sec).toBe(65)
    expect(managed.enabled_tools).toEqual(['allowed_tool'])
  })

  it('passes Batshit internal auth env vars to the shared subagent bridge', async () => {
    const agent = buildCodexAgent({
      assignedSubagents: ['subagent-1']
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const parsed = parseToml(await readFile(configPath, 'utf8')) as Record<string, any>
    const subagentServer = Object.values(parsed.mcp_servers ?? {}).find((server: any) =>
      Array.isArray(server.args) &&
      server.args.some((arg: string) => arg.includes('codex-subagent-mcp.cjs'))
    ) as Record<string, any> | undefined

    expect(subagentServer).toBeTruthy()
    // BL-152: the shared file names the URL by reference; each run fills in its own process's.
    expect(subagentServer?.args).toContain('--url=${BATSHIT_CLI_HELPER_BASE_URL}')
    expect(subagentServer?.env_vars).toEqual([
      // SA-117 DL-117-06/08: the run credential replaces `BATSHIT_TOKEN`, and
      // `MCP_GATEWAY_AUTH_TOKEN` goes with it — the subagent bridge only ever read the
      // gateway token as a fallback SPELLING of the instance token, never to reach a
      // gateway. The Redis variables stay, by explicit decision (SA-117 Scope): that bridge
      // reads Redis directly, and removing them is the follow-up story.
      'BATSHIT_AGENT_TOKEN',
      'REDIS_URL',
      'REDIS_CONNECTION_STRING',
      'REDIS_PASSWORD',
      'BATSHIT_FRONTEND_URL',
      'PUBLIC_BASE_URL',
      'ORIGIN',
      'BATSHIT_SESSION_ID',
      // SA-111 P4: the parent turn id, so the bridge can pass it to the Workers cap.
      'BATSHIT_MESSAGE_ID'
    ])
    expect(subagentServer?.env_vars).not.toContain('BATSHIT_TOKEN')
    expect(subagentServer?.default_tools_approval_mode).toBe('approve')
    // SA-111 P4: the same bridge carries the Workers batch tool; Workers default ON.
    expect(subagentServer?.enabled_tools).toEqual(['subagent_subagent_1', 'spawn_workers'])
  })

  it('SA-111 P4: a workers-disabled agent gets the bridge without the spawn tool', async () => {
    // DL-111-11: the toggle is real. An agent with Workers off must not be advertised a
    // tool it will be refused server-side — that mismatch, in reverse, is finding F1.
    const agent = buildCodexAgent({
      assigned_subagent_ids: ['subagent-1'],
      workers_enabled: false
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const parsed = parseToml(await readFile(configPath, 'utf8')) as Record<string, any>
    const subagentServer = Object.values(parsed.mcp_servers ?? {}).find((server: any) =>
      Array.isArray(server.args) &&
      server.args.some((arg: string) => arg.includes('codex-subagent-mcp.cjs'))
    ) as Record<string, any> | undefined

    expect(subagentServer).toBeTruthy()
    expect(subagentServer?.enabled_tools).toEqual(['subagent_subagent_1'])
  })

  it('writes managed profile and subagent bridge for legacy provider-specific Codex settings', async () => {
    const agent = buildCodexAgent({
      codex_settings: undefined,
      provider_specific_settings: {
        codex_model: 'gpt-5.5',
        codex_permission_mode: 'chat',
        codex_sandbox: 'read-only',
        codex_approval: 'never',
        codex_search: false
      },
      assigned_subagent_ids: ['subagent-legacy']
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>
    const subagentServer = Object.values(parsed.mcp_servers ?? {}).find((server: any) =>
      Array.isArray(server.args) &&
      server.args.some((arg: string) => arg.includes('codex-subagent-mcp.cjs'))
    ) as Record<string, any> | undefined

    expect(config).toContain('model = "gpt-5.5"')
    expect(config).toContain('web_search = "disabled"')
    expect(config).toContain('default_tools_enabled = false')
    expect(subagentServer).toBeTruthy()
    expect(subagentServer?.default_tools_approval_mode).toBe('approve')
    expect(subagentServer?.enabled_tools).toEqual(['subagent_subagent_legacy', 'spawn_workers'])
  })

  it('writes GPT-5.5 fast service tier and string web-search mode for managed Codex agents', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
        model: 'gpt-5.5',
        serviceTier: 'fast',
        streamingEffect: true,
        search: true,
        sandbox: 'read-only',
        approval: 'never',
        addDirs: [],
        enableFeatures: [],
        disableFeatures: [],
        configOverrides: [],
        workingDirectoryMode: 'project',
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).toContain('model = "gpt-5.5"')
    expect(config).toContain('web_search = "live"')
    expect(config).not.toContain('web_search = true')
    expect(config).toContain('default_tools_enabled = false')
    expect(config).toContain('service_tier = "fast"')
    expect(config).toContain('apps = false')
    expect(config).toContain('fast_mode = true')
  })

  it('sanitizes stale flex service tier settings out of managed Codex config', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
        model: 'gpt-5.5',
        serviceTier: 'flex',
        streamingEffect: true,
        search: true,
        sandbox: 'read-only',
        approval: 'never',
        addDirs: [],
        enableFeatures: [],
        disableFeatures: [],
        configOverrides: [],
        workingDirectoryMode: 'project',
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).not.toContain('service_tier = "flex"')
    expect(config).not.toContain('service_tier =')
    expect(config).not.toContain('fast_mode = true')
  })

  it('trusts the agent default project in the managed Codex config', async () => {
    const agent = buildCodexAgent({
      default_project_id: 'project-selected',
      codex_settings: {
        permissionMode: 'chat',
        model: 'gpt-5.5',
        streamingEffect: true,
        search: true,
        sandbox: 'read-only',
        approval: 'never',
        addDirs: [],
        enableFeatures: [],
        disableFeatures: [],
        configOverrides: [],
        workingDirectoryMode: 'project',
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockRedis.getProjectPreferences.mockResolvedValue({
      user_id: 'josh',
      default_workspace_path: '/Users/example/global',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    mockRedis.getProjects.mockResolvedValue([
      {
        id: 'project-selected',
        user_id: 'josh',
        name: 'Selected Project',
        root_path: '/Users/example/selected',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>

    expect(parsed.projects?.['/Users/example/selected']?.trust_level).toBe('trusted')
    expect(config).toContain('[projects."/Users/example/selected"]')
    expect(config).not.toContain('[projects."/Users/example/global"]')
  })

  it('lets a custom Codex working directory override the agent default project', async () => {
    const agent = buildCodexAgent({
      default_project_id: 'project-selected',
      codex_settings: {
        permissionMode: 'chat',
        model: 'gpt-5.5',
        streamingEffect: true,
        search: true,
        sandbox: 'read-only',
        approval: 'never',
        addDirs: [],
        enableFeatures: [],
        disableFeatures: [],
        configOverrides: [],
        workingDirectoryMode: 'custom',
        customWorkingDirectory: '/Users/example/custom-codex-workdir',
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockRedis.getProjectPreferences.mockResolvedValue({
      user_id: 'josh',
      default_workspace_path: '/Users/example/global',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    mockRedis.getProjects.mockResolvedValue([
      {
        id: 'project-selected',
        user_id: 'josh',
        name: 'Selected Project',
        root_path: '/Users/example/selected',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>

    expect(parsed.projects?.['/Users/example/custom-codex-workdir']?.trust_level).toBe('trusted')
    expect(config).not.toContain('[projects."/Users/example/selected"]')
  })

  it('does not write project_doc_max_bytes when project instructions are disabled', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
        includeProjectInstructions: false,
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
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>

    expect(parsed.project_doc_max_bytes).toBeUndefined()
    expect(config).not.toContain('model_instructions_file')
    expect(config).not.toContain('project_doc_max_bytes')

    mockRedis.getAgents.mockResolvedValue([
      buildCodexAgent({
        ...agent,
        codex_settings: {
          ...agent.codex_settings,
          includeProjectInstructions: true
        }
      })
    ])

    await syncAgentCodexProfiles('josh')
    const configWithDocs = await readFile(configPath, 'utf8')
    const parsedWithDocs = parseToml(configWithDocs) as Record<string, any>

    expect(parsedWithDocs.project_doc_max_bytes).toBeUndefined()
  })

  it('adds Mode 4 Agent Browser helper tools when Agent Browser is enabled', async () => {
    const agent = buildCodexAgent({
      provider_specific_settings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          agentBrowserEnabled: true,
          bashEnabled: false
        }
      }
    })

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).toContain('[mcp_servers.batshit_helpers]')
    expect(config).toContain(
      'enabled_tools = ["batshit_tool_search", "batshit_tool_use", "native_skill"]'
    )
    expect(config).toContain(
      'disabled_tools = ["batshit_server_agent_browser_find", "batshit_server_agent_browser_use"'
    )
  })

  // BL-878: Codex has its own Bash, so Batshit's helper is on no managed Codex run: a Primary, a
  // CLI Subagent, or a Worker, and whether the Bash setting is saved on, off, or absent (the
  // shared resolver turns an absent value on, and that used to list the helper).
  it.each([true, false, undefined])(
    'BL-878: no managed Codex Primary, CLI Subagent, or Worker lists the Batshit Bash helper (Bash saved as %s)',
    async (bashEnabled) => {
      const nativeTools = {
        fetchZipEnabled: true,
        dynamicMcpEnabled: false,
        batshitToolsEnabled: false,
        agentBrowserEnabled: false,
        ...(bashEnabled === undefined ? {} : { bashEnabled })
      }
      const bashHelper = 'batshit_server_bash_execute'
      const agent = buildCodexAgent({ provider_specific_settings: { nativeTools } })
      mockRedis.getAgents.mockResolvedValue([agent])
      mockGatewayService.list.mockResolvedValue([])
      mockResolveMCPSelections.mockResolvedValue({
        resolvedGateways: [],
        defaultGateways: [],
        resolvedToolSelections: [],
        tools: {},
        toolMetadata: new Map(),
        gatewayToolMap: {}
      })

      const { syncAgentCodexProfiles, prepareManagedCodexSubagentProfile, buildAgentProfileId } =
        await import('../codexProfileManager')
      const { buildCliSubagentRuntimeId, buildCliWorkerRuntimeId } = await import('$lib/utils/subagentSlug')
      const helperServer = async (configPath: string) => {
        const parsed = parseToml(await readFile(configPath, 'utf8')) as Record<string, any>
        return parsed.mcp_servers?.batshit_helpers as Record<string, any>
      }

      // The Primary.
      await syncAgentCodexProfiles('josh')
      const primary = await helperServer(
        path.join(tempHome, '.batshit', 'agents', buildAgentProfileId(agent.id), '.codex', 'config.toml')
      )

      // A CLI Subagent and a Worker: one profile function, two runtime id namespaces.
      const delegated: Record<string, Record<string, any>> = {}
      for (const [kind, runtimeId] of [
        ['CLI Subagent', buildCliSubagentRuntimeId('bl878_sub')],
        ['Worker', buildCliWorkerRuntimeId('worker_bl878_1')]
      ] as const) {
        const { managedConfigHome } = await prepareManagedCodexSubagentProfile({
          userId: 'josh',
          profileId: buildAgentProfileId(runtimeId),
          runtimeId,
          label: `BL-878 ${kind}`,
          displayName: `BL-878 ${kind}`,
          providerSettings: { nativeTools }
        })
        delegated[kind] = await helperServer(path.join(managedConfigHome, 'config.toml'))
      }

      for (const [kind, server] of Object.entries({ Primary: primary, ...delegated })) {
        expect(server?.enabled, `${kind} still has a helper server`).toBe(true)
        expect(server.enabled_tools, `${kind} enabled_tools`).not.toContain(bashHelper)
        expect(server.disabled_tools, `${kind} disabled_tools`).toContain(bashHelper)
        // The other helpers the settings allow are not touched.
        expect(server.enabled_tools, `${kind} enabled_tools`).toEqual(
          expect.arrayContaining(['native_skill', 'batshit_server_fetch_zip'])
        )
      }
    }
  )

  it('omits managed instructions overrides when the core Codex system prompt is enabled', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
        includeCoreSystemPrompt: true,
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
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).not.toContain('model_instructions_file =')
    expect(config).not.toContain('experimental_instructions_file =')
  })

  it('keeps Codex sessions when cleanup cannot parse an invalid config', async () => {
    const { buildAgentProfileId, cleanupCodexSessionDirs } = await import('../codexProfileManager')
    const profileId = buildAgentProfileId('agent-1')
    const codexDir = path.join(tempHome, '.batshit', 'agents', profileId, '.codex')
    const sessionsDir = path.join(codexDir, 'sessions')

    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      path.join(codexDir, 'config.toml'),
      [
        '# stale invalid config',
        'history.persistence = "none"',
        '',
        '[history]',
        'persistence = "none"'
      ].join('\n'),
      'utf8'
    )

    await cleanupCodexSessionDirs({ respectPersistence: true })

    const sessionsStat = await stat(sessionsDir)
    expect(sessionsStat.isDirectory()).toBe(true)
  })

  it('heals stale invalid managed config blocks on the next sync', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
        includeCoreSystemPrompt: false,
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
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    const profileId = buildAgentProfileId(agent.id)
    const codexDir = path.join(tempHome, '.batshit', 'agents', profileId, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(
      path.join(codexDir, 'config.toml'),
      [
        '# >>> Batshit codex config (managed) >>>',
        '# stale broken managed block',
        'history.persistence = "none"',
        '',
        '[history]',
        'persistence = "none"',
        '# <<< Batshit codex config (managed) <<<'
      ].join('\n'),
      'utf8'
    )

    await syncAgentCodexProfiles('josh')

    const configPath = path.join(codexDir, 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).not.toContain('history.persistence = "none"')
    expect(config.match(/\[history\]/g)?.length ?? 0).toBe(1)
    expect(config.match(/persistence = "none"/g)?.length ?? 0).toBe(1)
  })

  it('strips legacy manual history tables outside the managed block before rewriting config', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
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
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    const profileId = buildAgentProfileId(agent.id)
    const codexDir = path.join(tempHome, '.batshit', 'agents', profileId, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(
      path.join(codexDir, 'config.toml'),
      ['model_context_window = 1000000', '', '[history]', 'persistence = "save-all"', ''].join('\n'),
      'utf8'
    )

    await syncAgentCodexProfiles('josh')

    const configPath = path.join(codexDir, 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>

    expect(parsed.model_context_window).toBe(1000000)
    expect(config.match(/\[history\]/g)?.length ?? 0).toBe(1)
    expect(config).toContain('persistence = "none"')
    expect(() => parseToml(config)).not.toThrow()
  })

  it('preserves unrelated custom Codex config while removing only managed collisions', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
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
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    const profileId = buildAgentProfileId(agent.id)
    const codexDir = path.join(tempHome, '.batshit', 'agents', profileId, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(
      path.join(codexDir, 'config.toml'),
      [
        'custom_value = "keep-me"',
        'default_tools_enabled = true',
        'history.persistence = "save-all"',
        '',
        '[features]',
        'extra_feature = true',
        '',
        `[projects."${tempHome.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
        'trust_level = "untrusted"',
        '',
        '[projects."/tmp/custom"]',
        'trust_level = "trusted"',
        '',
        '[mcp_servers.custom_server]',
        'url = "https://custom.example/mcp"',
        'enabled = true',
        '',
        '[mcp_servers.batshit_gateway_main_gateway]',
        'enabled = false'
      ].join('\n'),
      'utf8'
    )

    await syncAgentCodexProfiles('josh')

    const configPath = path.join(codexDir, 'config.toml')
    const config = await readFile(configPath, 'utf8')
    const parsed = parseToml(config) as Record<string, any>

    expect(config).not.toContain('history.persistence = "save-all"')
    expect(config).not.toContain('default_tools_enabled = true')
    expect(config).toContain('default_tools_enabled = false')
    expect(parsed.custom_value).toBe('keep-me')
    expect(parsed.history?.persistence).toBe('none')
    expect(parsed.features?.extra_feature).toBe(true)
    expect(parsed.features?.unified_exec).toBe(true)
    expect(parsed.projects?.[tempHome]?.trust_level).toBe('trusted')
    expect(parsed.projects?.['/tmp/custom']?.trust_level).toBe('trusted')
    expect(parsed.mcp_servers?.custom_server?.url).toBe('https://custom.example/mcp')
    expect(parsed.mcp_servers?.batshit_gateway_main_gateway?.enabled).toBe(true)
  })

  it('reads the effective managed root tool limit without changing its file', async () => {
    const home = path.join(tempHome, '.batshit', 'agents', 'batshit_agent_agent-budget', '.codex')
    await mkdir(home, { recursive: true })
    const { readManagedCodexToolOutputTokenLimit } = await import('../codexProfileManager')
    for (const [contents, expected] of [
      ['tool_output_token_limit = 25000\n', 25_000],
      ['tool_output_token_limit = 0\n', 0],
      ['[profiles.unused]\ntool_output_token_limit = 75000\n', null],
      ['tool_output_token_limit = -1\n', null]
    ] as const) {
      await writeFile(path.join(home, 'config.toml'), contents)
      expect(await readManagedCodexToolOutputTokenLimit(home)).toBe(expected)
      expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toBe(contents)
    }
  })

  it('drops custom overrides that would make the managed TOML invalid', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
        model: 'gpt-5.4',
        streamingEffect: true,
        search: true,
        sandbox: 'read-only',
        approval: 'never',
        addDirs: [],
        enableFeatures: [],
        disableFeatures: [],
        configOverrides: [
          { key: 'foo', value: 'bar' },
          { key: 'foo.bar', value: 'baz' },
          { key: 'model_context_window', value: '1000000' }
        ],
        workingDirectoryMode: 'project',
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).not.toContain('foo = "bar"')
    expect(config).toContain('foo.bar = "baz"')
    expect(config).toContain('model_context_window = 1000000')
    expect(() => parseToml(config)).not.toThrow()
  })

  it('skips custom overrides that collide with Batshit-managed Codex config keys', async () => {
    const agent = buildCodexAgent({
      codex_settings: {
        permissionMode: 'chat',
        includeCoreSystemPrompt: false,
        model: 'gpt-5.4',
        streamingEffect: true,
        search: true,
        sandbox: 'read-only',
        approval: 'never',
        addDirs: [],
        enableFeatures: [],
        disableFeatures: [],
        configOverrides: [
          { key: 'history.persistence', value: '"none"' },
          { key: 'features.unified_exec', value: 'true' },
          { key: 'approval_policy', value: '"never"' },
          { key: 'project_doc_max_bytes', value: '150000' },
          { key: 'model_context_window', value: '1000000' }
        ],
        workingDirectoryMode: 'project',
        unifiedExec: true,
        historyPersistence: 'none'
      }
    })
    const gateway = buildGateway()

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([gateway])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [gateway.id],
      defaultGateways: [gateway.id],
      resolvedToolSelections: ['allowed_tool'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [gateway.id]: ['allowed_tool']
      }
    })

    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')

    const profileId = buildAgentProfileId(agent.id)
    const configPath = path.join(tempHome, '.batshit', 'agents', profileId, '.codex', 'config.toml')
    const config = await readFile(configPath, 'utf8')

    expect(config).toContain('model_context_window = 1000000')
    expect(config).not.toContain('history.persistence')
    expect(config).not.toContain('features.unified_exec')
    expect(config.match(/project_doc_max_bytes/g)?.length ?? 0).toBe(1)
    expect(config).toContain('project_doc_max_bytes = 150000')
    expect(config.match(/\[history\]/g)?.length ?? 0).toBe(1)
    expect(config.match(/persistence = "none"/g)?.length ?? 0).toBe(1)
    expect(config.match(/\[features\]/g)?.length ?? 0).toBe(1)
    expect(config.match(/approval_policy = "never"/g)?.length ?? 0).toBe(1)
    expect(config).not.toContain('web_search = true')
  })
  it("BL-7 review: a managed config.toml never takes an override of Codex's bundled-skills switch", async () => {
    // The runtime sanitizer (codexSettings) already drops these; this is the profile write's
    // own guard, for settings that reach it without going through that sanitizer.
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })
    const { prepareManagedCodexSubagentProfile, buildAgentProfileId } = await import('../codexProfileManager')
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const runtimeSettings = buildCodexRuntimeSettings(null)
    runtimeSettings.configOverrides = [
      { key: 'skills.bundled.enabled', value: 'true' },
      { key: 'skills.bundled', value: '{ enabled = true }' },
      { key: 'project_doc_max_bytes', value: '0' }
    ]
    const profileId = buildAgentProfileId('subagent_cli_bl7_override')

    const { managedConfigHome } = await prepareManagedCodexSubagentProfile({
      userId: 'josh',
      profileId,
      runtimeId: 'subagent_cli_bl7_override',
      label: 'BL-7 override probe',
      displayName: 'BL-7 override probe',
      runtimeSettings
    })

    const config = await readFile(path.join(managedConfigHome, 'config.toml'), 'utf8')
    expect(config).not.toMatch(/^skills\.bundled/m)
    expect(config).toContain('# Ignored skills.bundled.enabled: Batshit already manages this key')
    expect(config).toContain('# Ignored skills.bundled: Batshit already manages this key')
    expect(config).toContain('project_doc_max_bytes = 0')
  })

  it('BL-7: runs of one agent that start together link auth.json once and warn about nothing', async () => {
    // Two turns of one agent that start at the same moment (the agent in two chats, the
    // compact worker beside a turn) both find the credential link missing on a fresh home
    // and both create it. The second `symlink` answered EEXIST and was logged as a failed
    // link with its stack, though the link it wanted was already there. That warning is
    // the `auth.json` error the 2026-09-18 bug sweep saw next to Codex's own skills error.
    const agent = buildCodexAgent()
    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })
    const realAuth = path.join(tempHome, '.codex', 'auth.json')
    await mkdir(path.dirname(realAuth), { recursive: true })
    await writeFile(realAuth, '{}')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The folder gate serializes run starts with the sync, so the second run must wait
    // while the first creates the credential link.
    const fsPromises = await import('node:fs/promises')
    const realSymlink = fsPromises.symlink
    let arrivals = 0
    let release!: () => void
    const firstMayFinish = new Promise<void>((resolve) => { release = resolve })
    let firstArrived!: () => void
    const firstLinkStarted = new Promise<void>((resolve) => { firstArrived = resolve })
    const symlinkSpy = vi.spyOn(fsPromises.default, 'symlink').mockImplementation(
      async (target: any, linkPath: any, type?: any) => {
        if (String(linkPath).endsWith(`${path.sep}auth.json`)) {
          arrivals += 1
          if (arrivals === 1) {
            firstArrived()
            await firstMayFinish
          }
        }
        return realSymlink(target, linkPath, type)
      }
    )

    try {
      const { ensureManagedCodexHome, buildAgentProfileId } = await import('../codexProfileManager')
      const profileId = buildAgentProfileId(agent.id)
      const homesPromise = Promise.all(
        [1, 2].map(() => ensureManagedCodexHome({ userId: 'josh', profileId, owner: { userId: 'josh', kind: 'agent', id: agent.id } }))
      )
      await firstLinkStarted
      expect(arrivals).toBe(1)
      release()
      const homes = await homesPromise

      const codexDir = path.join(tempHome, '.batshit', 'agents', profileId, '.codex')
      expect(arrivals).toBe(1)
      expect(homes).toEqual([codexDir, codexDir])
      expect(await readlink(path.join(codexDir, 'auth.json'))).toBe(realAuth)
      const linkWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes('Failed to create symlink')
      )
      expect(linkWarnings).toEqual([])
    } finally {
      release()
      symlinkSpy.mockRestore()
      warn.mockRestore()
    }
  })

  it('BL-7: a link that points somewhere else is still reported', async () => {
    // The quiet EEXIST is only for a link that is already right. A link another writer
    // pointed elsewhere between our remove and our create must still be reported.
    const agent = buildCodexAgent()
    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })
    const realAuth = path.join(tempHome, '.codex', 'auth.json')
    await mkdir(path.dirname(realAuth), { recursive: true })
    await writeFile(realAuth, '{}')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const fsPromises = await import('node:fs/promises')
      const { ensureManagedCodexHome, buildAgentProfileId } = await import('../codexProfileManager')
      const profileId = buildAgentProfileId(agent.id)
      const codexDir = path.join(tempHome, '.batshit', 'agents', profileId, '.codex')
      const strayTarget = path.join(tempHome, 'somewhere-else.json')
      await writeFile(strayTarget, '{}')

      // Another writer lands a WRONG link between this run's remove and its create.
      const realSymlink = fsPromises.symlink
      const symlinkSpy = vi.spyOn(fsPromises.default, 'symlink').mockImplementation(
        async (target: any, linkPath: any, type?: any) => {
          if (String(linkPath).endsWith(`${path.sep}auth.json`)) {
            await realSymlink(strayTarget, linkPath)
          }
          return realSymlink(target, linkPath, type)
        }
      )
      try {
        await ensureManagedCodexHome({ userId: 'josh', profileId, owner: { userId: 'josh', kind: 'agent', id: agent.id } })
      } finally {
        symlinkSpy.mockRestore()
      }

      expect(await readlink(path.join(codexDir, 'auth.json'))).toBe(strayTarget)
      const linkWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes('Failed to create symlink for auth.json')
      )
      expect(linkWarnings.length).toBeGreaterThan(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('refuses a run whose agent was deleted during profile sync without remaking its home', async () => {
    const agent = buildCodexAgent()
    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [], gatewayToolMap: {}, tools: {}, toolMetadata: new Map()
    })
    const { holdAgentProfileFolder } = await import('../agentProfileFolderGate')
    const { ensureManagedCodexHome, buildAgentProfileId } = await import('../codexProfileManager')
    const profileId = buildAgentProfileId(agent.id)
    let releaseDelete!: () => void
    const mayDelete = new Promise<void>((resolve) => { releaseDelete = resolve })
    let deleteStarted!: () => void
    const began = new Promise<void>((resolve) => { deleteStarted = resolve })
    const deletion = holdAgentProfileFolder(profileId, async () => {
      deleteStarted()
      await mayDelete
      mockRedis.json.get.mockResolvedValue(null)
    })
    await began
    const start = ensureManagedCodexHome({
      userId: 'josh', profileId, owner: { userId: 'josh', kind: 'agent', id: agent.id }
    })
    releaseDelete()
    await deletion
    await expect(start).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    await expect(stat(path.join(tempHome, '.batshit', 'agents', profileId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('continues syncing another agent when a gated Redis read fails', async () => {
    const bad = buildCodexAgent({ id: 'agent-bad' })
    const good = buildCodexAgent({ id: 'agent-good' })
    mockRedis.getAgents.mockResolvedValue([bad, good])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [], gatewayToolMap: {}, tools: {}, toolMetadata: new Map()
    })
    mockRedis.json.get.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-bad') throw new Error('Redis unavailable')
      return { id: 'agent-good', user_id: 'josh' }
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    await syncAgentCodexProfiles('josh')
    expect(error.mock.calls.some((call) => String(call[0]).includes('Failed to sync agent profile'))).toBe(true)
    const goodConfig = path.join(tempHome, '.batshit', 'agents', buildAgentProfileId(good.id), '.codex', 'config.toml')
    expect(await readFile(goodConfig, 'utf8')).toContain('Batshit codex config')
  })

  it('refuses a run with a stale config when its own sync read fails, while syncing another agent', async () => {
    const own = buildCodexAgent({ id: 'agent-own' })
    const other = buildCodexAgent({ id: 'agent-other' })
    mockRedis.getAgents.mockResolvedValue([own, other])
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [], gatewayToolMap: {}, tools: {}, toolMetadata: new Map()
    })
    const { ensureManagedCodexHome, buildAgentProfileId } = await import('../codexProfileManager')
    const ownProfileId = buildAgentProfileId(own.id)
    const staleConfig = path.join(tempHome, '.batshit', 'agents', ownProfileId, '.codex', 'config.toml')
    await mkdir(path.dirname(staleConfig), { recursive: true })
    await writeFile(staleConfig, 'stale config')
    let ownReads = 0
    mockRedis.json.get.mockImplementation(async (key: string) => {
      if (key === `agent:${own.id}` && ++ownReads === 2) throw new Error('Redis unavailable')
      return { id: key.slice('agent:'.length), user_id: 'josh' }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(ensureManagedCodexHome({
      userId: 'josh', profileId: ownProfileId,
      owner: { userId: 'josh', kind: 'agent', id: own.id }
    })).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    expect(await readFile(staleConfig, 'utf8')).toBe('stale config')
    const otherConfig = path.join(tempHome, '.batshit', 'agents', buildAgentProfileId(other.id), '.codex', 'config.toml')
    expect(await readFile(otherConfig, 'utf8')).toContain('Batshit codex config')
  })

})

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import toml from '@iarna/toml'

const { parse: parseToml } = toml

const mockRedis = {
  getAgents: vi.fn(),
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

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'codex-profile-test-'))
    process.env.HOME = tempHome

    mockRedis.getProjectPreferences.mockResolvedValue(null)
    mockRedis.getProjects.mockResolvedValue([])
    mockRedis.get.mockResolvedValue(null)
    mockRedis.getUserSettings.mockResolvedValue(null)
    mockApiKeyService.retrieve.mockResolvedValue(null)
    mockApiKeyService.store.mockResolvedValue(undefined)
    mockGatewayService.update.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true })
    }
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
    const mode4Server = parsed.mcp_servers?.['batshit_gateway_managed-codex-mode4-controls']

    expect(config).not.toContain('[mcp_servers.batshit_gateway_main_gateway]')
    expect(config).not.toContain('legacy_tool')
    expect(config).toContain('[mcp_servers.batshit_gateway_managed-codex-mode4-controls]')
    expect(config).toContain('enabled_tools = ["batshit_server_bash_execute", "native_skill"]')
    expect(mode4Server?.args).toContain('--url=http://localhost:5620')
    // SA-105 P3 (AMD-105-09): the bridge must be told which CLI consumes its
    // results, because that alone decides whether a recalled memory image can
    // ride back as MCP image content. Codex renders those blocks.
    expect(mode4Server?.args).toContain('--runtime=codex')
    expect(mode4Server?.env_vars).toEqual([
      'BATSHIT_TOKEN',
      'BATSHIT_SESSION_ID',
      'BATSHIT_PROJECT_PATH',
      'BATSHIT_FRONTEND_URL',
      'PUBLIC_BASE_URL',
      'ORIGIN'
    ])
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
    expect(subagentServer?.args).toContain('--url=http://localhost:5620')
    expect(subagentServer?.env_vars).toEqual([
      'BATSHIT_TOKEN',
      'MCP_GATEWAY_AUTH_TOKEN',
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

    expect(config).toContain('[mcp_servers.batshit_gateway_managed-codex-mode4-controls]')
    expect(config).toContain(
      'enabled_tools = ["batshit_tool_search", "batshit_tool_use", "native_skill"]'
    )
    expect(config).toContain(
      'disabled_tools = ["batshit_server_agent_browser_find", "batshit_server_agent_browser_use"'
    )
  })

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
})

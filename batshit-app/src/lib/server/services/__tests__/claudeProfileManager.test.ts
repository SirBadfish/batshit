import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'

const mockRedis = {
  getAgents: vi.fn(),
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
    BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true',
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

describe('claudeProfileManager stdio config', () => {
  const originalHome = process.env.HOME
  let tempHome = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'claude-profile-test-'))
    process.env.HOME = tempHome

    mockApiKeyService.retrieve.mockResolvedValue(null)
    mockApiKeyService.store.mockResolvedValue(undefined)
    mockGatewayService.update.mockResolvedValue(undefined)
    mockRedis.get.mockResolvedValue(null)
    mockRedis.getUserSettings.mockResolvedValue(null)
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

  it('writes stdio MCP entries with env placeholders into managed mcp.json', async () => {
    const agent = {
      id: 'agent-1',
      displayName: 'Managed Claude',
      slug: 'managed-claude',
      primary_model_provider: 'claude-cli',
      provider_specific_settings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false
        }
      },
      claude_settings: {},
      assignedSubagents: []
    }
    const gateway = {
      id: 'gw-stdio',
      name: 'Local STDIO',
      slug: 'stdio_gateway',
      type: 'stdio',
      enabled: true,
      stdioConfig: {
        command: 'node',
        args: ['server.js'],
        cwdPolicy: 'fixed',
        cwdValue: '/tmp/stdio-gateway',
        envRefs: [{ envVar: 'GITHUB_TOKEN', savedKeyRef: 'github' }]
      },
      created_at: new Date().toISOString()
    }

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

    const { syncAgentClaudeProfiles, buildClaudeProfileId } = await import('../claudeProfileManager')
    await syncAgentClaudeProfiles('josh')

    const profileId = buildClaudeProfileId(agent.id)
    const mcpPath = path.join(tempHome, '.batshit', 'agents', profileId, '.claude', 'mcp.json')
    const payload = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, any>
    const managed = payload.mcpServers?.batshit_gateway_stdio_gateway
    const mode4Server = payload.mcpServers?.['batshit_gateway_managed-claude-mode4-controls']

    expect(managed).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/tmp/stdio-gateway',
      env: {
        GITHUB_TOKEN: '${BATSHIT_MCP_STDIO_GW_STDIO_GITHUB_TOKEN}'
      }
    })
    // SA-105 P3 (AMD-105-09): the symmetric half of the Codex flag. Claude Code
    // stores MCP ImageContent as text at 10-20x the token cost, so this runtime
    // deliberately receives no image blocks and the recall note says so.
    expect(mode4Server?.args).toContain('--runtime=claude')
    expect(mode4Server?.env).toEqual({
      BATSHIT_TOKEN: '${BATSHIT_TOKEN}',
      BATSHIT_SESSION_ID: '${BATSHIT_SESSION_ID}',
      BATSHIT_PROJECT_PATH: '${BATSHIT_PROJECT_PATH}',
      BATSHIT_FRONTEND_URL: '${BATSHIT_FRONTEND_URL}',
      PUBLIC_BASE_URL: '${PUBLIC_BASE_URL}',
      ORIGIN: '${ORIGIN}'
    })
  })

  it('writes gateway auth headers as env placeholders, keeps secrets out of mcp.json, and returns the spawn env map', async () => {
    const agent = {
      id: 'agent-headers',
      displayName: 'Managed Claude',
      slug: 'managed-claude-headers',
      primary_model_provider: 'claude-cli',
      provider_specific_settings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false
        }
      },
      claude_settings: {},
      assignedSubagents: []
    }
    const dockerGateway = {
      id: 'gw-docker',
      name: 'Docker Catalog',
      slug: 'docker_gateway',
      type: 'docker-catalog',
      enabled: true,
      url: 'http://localhost:5601/mcp',
      // Stale legacy token left behind: the migrated docker token must win over it.
      metadata: { authToken: 'stale-legacy-token' },
      created_at: new Date().toISOString()
    }
    const n8nGateway = {
      id: 'gw-n8n',
      name: 'n8n Instance MCP',
      slug: 'n8n_gateway',
      type: 'n8n-instance-mcp',
      enabled: true,
      url: 'http://localhost:5678/mcp',
      metadata: { authToken: 'legacy-n8n-token' },
      created_at: new Date().toISOString()
    }
    const customGateway = {
      id: 'gw-custom',
      name: 'Custom Gateway',
      slug: 'custom_gateway',
      type: 'custom',
      enabled: true,
      url: 'https://example.test/mcp',
      metadata: {
        headers: {
          'X-Api-Key': 'custom-secret-value',
          Accept: 'application/json'
        }
      },
      created_at: new Date().toISOString()
    }

    mockRedis.getAgents.mockResolvedValue([agent])
    mockGatewayService.list.mockResolvedValue([dockerGateway, n8nGateway, customGateway])
    mockApiKeyService.retrieve.mockResolvedValue('migrated-n8n-token')
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [dockerGateway.id, n8nGateway.id, customGateway.id],
      defaultGateways: [dockerGateway.id, n8nGateway.id, customGateway.id],
      resolvedToolSelections: ['tool_a', 'tool_b', 'tool_c'],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {
        [dockerGateway.id]: ['tool_a'],
        [n8nGateway.id]: ['tool_b'],
        [customGateway.id]: ['tool_c']
      }
    })

    const dockerGatewayConfig = await import('$lib/server/services/dockerGatewayConfig')
    vi.mocked(dockerGatewayConfig.getDockerGatewayAuthToken).mockReturnValue('docker-secret-token')

    const {
      syncAgentClaudeProfiles,
      buildClaudeProfileId,
      buildManagedClaudeHeaderPlaceholderName
    } = await import('../claudeProfileManager')
    const { buildManagedGatewayId } = await import('../codexProfileManager')

    const profileId = buildClaudeProfileId(agent.id)
    const mcpPath = path.join(tempHome, '.batshit', 'agents', profileId, '.claude', 'mcp.json')

    // Pre-create a loose-permission file to prove rewrite tightens it back to 0600.
    await mkdir(path.dirname(mcpPath), { recursive: true })
    await writeFile(mcpPath, '{}', 'utf8')
    await chmod(mcpPath, 0o644)

    const headerEnv = await syncAgentClaudeProfiles('josh')

    const raw = await readFile(mcpPath, 'utf8')
    for (const secret of [
      'docker-secret-token',
      'migrated-n8n-token',
      'stale-legacy-token',
      'legacy-n8n-token',
      'custom-secret-value'
    ]) {
      expect(raw).not.toContain(secret)
    }

    const dockerVar = buildManagedClaudeHeaderPlaceholderName(dockerGateway.id, 'Authorization')
    const n8nVar = buildManagedClaudeHeaderPlaceholderName(n8nGateway.id, 'Authorization')
    const customVar = buildManagedClaudeHeaderPlaceholderName(customGateway.id, 'X-Api-Key')

    const payload = JSON.parse(raw) as Record<string, any>
    const dockerEntry = payload.mcpServers?.[buildManagedGatewayId(dockerGateway.id, dockerGateway.slug)]
    const n8nEntry = payload.mcpServers?.[buildManagedGatewayId(n8nGateway.id, n8nGateway.slug)]
    const customEntry = payload.mcpServers?.[buildManagedGatewayId(customGateway.id, customGateway.slug)]

    expect(dockerEntry?.headers?.Authorization).toBe(`\${${dockerVar}}`)
    expect(n8nEntry?.headers?.Authorization).toBe(`\${${n8nVar}}`)
    expect(customEntry?.headers?.['X-Api-Key']).toBe(`\${${customVar}}`)
    // Non-secret custom headers stay literal.
    expect(customEntry?.headers?.Accept).toBe('application/json')

    // Returned spawn env map backs every placeholder, with migrated tokens winning over legacy.
    expect(headerEnv[dockerVar]).toBe('Bearer docker-secret-token')
    expect(headerEnv[n8nVar]).toBe('Bearer migrated-n8n-token')
    expect(headerEnv[customVar]).toBe('custom-secret-value')
    const referencedPlaceholders = Array.from(raw.matchAll(/\$\{(BATSHIT_MCP_HEADER_[A-Z0-9_]+)\}/g)).map(
      (match) => match[1]
    )
    expect(referencedPlaceholders.length).toBeGreaterThan(0)
    for (const placeholder of referencedPlaceholders) {
      expect(headerEnv[placeholder]).toBeDefined()
    }

    if (process.platform !== 'win32') {
      const mode = (await stat(mcpPath)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('prefers migrated and explicit headers over the legacy authToken fallback', async () => {
    const dockerGateway = {
      id: 'gw-docker',
      name: 'Docker Catalog',
      slug: 'docker_gateway',
      type: 'docker-catalog',
      enabled: true,
      url: 'http://localhost:5601/mcp',
      metadata: { authToken: 'stale-legacy-token' },
      created_at: new Date().toISOString()
    }
    const legacyOnlyGateway = {
      id: 'gw-legacy',
      name: 'Legacy Gateway',
      slug: 'legacy_gateway',
      type: 'custom',
      enabled: true,
      url: 'https://legacy.test/mcp',
      metadata: { authToken: 'legacy-only-token' },
      created_at: new Date().toISOString()
    }
    const explicitHeaderGateway = {
      id: 'gw-explicit',
      name: 'Explicit Header Gateway',
      slug: 'explicit_gateway',
      type: 'custom',
      enabled: true,
      url: 'https://explicit.test/mcp',
      metadata: {
        authToken: 'legacy-shadowed-token',
        headers: { Authorization: 'Bearer explicit-header-token' }
      },
      created_at: new Date().toISOString()
    }

    mockGatewayService.list.mockResolvedValue([dockerGateway, legacyOnlyGateway, explicitHeaderGateway])
    mockApiKeyService.retrieve.mockResolvedValue(null)

    const dockerGatewayConfig = await import('$lib/server/services/dockerGatewayConfig')
    vi.mocked(dockerGatewayConfig.getDockerGatewayAuthToken).mockReturnValue('docker-fresh-token')

    const { collectManagedClaudeGatewayHeaderEnv, buildManagedClaudeHeaderPlaceholderName } = await import(
      '../claudeProfileManager'
    )

    const headerEnv = await collectManagedClaudeGatewayHeaderEnv('josh')

    // Migrated docker token wins over the stale legacy token.
    expect(headerEnv[buildManagedClaudeHeaderPlaceholderName(dockerGateway.id, 'Authorization')]).toBe(
      'Bearer docker-fresh-token'
    )
    // Legacy fallback still applies when nothing overrides it.
    expect(headerEnv[buildManagedClaudeHeaderPlaceholderName(legacyOnlyGateway.id, 'Authorization')]).toBe(
      'Bearer legacy-only-token'
    )
    // Explicit custom Authorization header wins over the legacy fallback.
    expect(headerEnv[buildManagedClaudeHeaderPlaceholderName(explicitHeaderGateway.id, 'Authorization')]).toBe(
      'Bearer explicit-header-token'
    )
  })

  it('preserves unrelated manual Claude settings while syncing managed keys and custom overrides', async () => {
    const agent = {
      id: 'agent-2',
      displayName: 'Claude With Custom Config',
      slug: 'claude-custom',
      primary_model_provider: 'claude-cli',
      provider_specific_settings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false
        }
      },
      claude_settings: {
        permissionMode: 'acceptEdits',
        alwaysThinkingEnabled: true,
        maxThinkingTokens: 2048,
        addDirs: ['/tmp/project-a'],
        allowedTools: [],
        disallowedTools: [],
        configOverrides: [
          { key: 'cleanupPeriodDays', value: '30' },
          { key: 'env.CUSTOM_FLAG', value: '"batshit"' }
        ]
      },
      assignedSubagents: []
    }

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

    const { syncAgentClaudeProfiles, buildClaudeProfileId } = await import('../claudeProfileManager')
    const profileId = buildClaudeProfileId(agent.id)
    const settingsPath = path.join(tempHome, '.batshit', 'agents', profileId, '.claude', 'settings.json')
    await mkdir(path.dirname(settingsPath), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre-tool' }] }]
          },
          permissions: {
            preservedRule: 'keep-me'
          },
          env: {
            MANUAL_ONLY: 'yes'
          }
        },
        null,
        2
      ),
      'utf8'
    )

    await syncAgentClaudeProfiles('josh')

    const payload = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, any>
    expect(payload.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash')
    expect(payload.permissions).toMatchObject({
      defaultMode: 'acceptEdits',
      additionalDirectories: ['/tmp/project-a'],
      preservedRule: 'keep-me'
    })
    expect(payload.alwaysThinkingEnabled).toBe(true)
    expect(payload.env).toMatchObject({
      MANUAL_ONLY: 'yes',
      MAX_THINKING_TOKENS: '2048',
      CUSTOM_FLAG: 'batshit'
    })
    expect(payload.cleanupPeriodDays).toBe(30)
  })
})

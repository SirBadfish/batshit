import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'

/**
 * BL-745: the Codex and Claude profile syncs read every agent, await other setup, then write
 * each agent's profile folder. An agent deleted in that gap must not get its folder back.
 */

const agentRows = new Map<string, Record<string, unknown>>()
const jsonGetHook: { current: ((key: string) => Promise<void>) | null } = { current: null }

const mockRedis = {
  getAgents: vi.fn(),
  getProjectPreferences: vi.fn(),
  getProjects: vi.fn(),
  get: vi.fn(),
  getUserSettings: vi.fn(),
  json: {
    get: vi.fn(async (key: string) => {
      const hook = jsonGetHook.current
      if (hook) await hook(key)
      return agentRows.get(key) ?? null
    })
  }
}
const mockGatewayService = { list: vi.fn(), update: vi.fn() }
const mockResolveMCPSelections = vi.fn()
const mockApiKeyService = { retrieve: vi.fn(), store: vi.fn() }

// BL-160: `node:os` answers the temporary home, so nothing reaches the real `~/.batshit/agents`.
const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!testHome.current) throw new Error('agentProfileDeleteRace.test: no temporary home is set')
    return testHome.current
  }
  return { ...real, homedir, default: { ...real, homedir } }
})
vi.mock('$env/dynamic/private', () => ({
  env: {
    BATSHIT_CODEX_PROVIDER_ENABLED: 'true',
    BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true',
    BATSHIT_CODEX_WORKDIR: '',
    BATSHIT_TOKEN: ''
  }
}))
vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({ mcpGatewayService: mockGatewayService }))
vi.mock('$lib/server/services/mcpSelectionResolver', () => ({ resolveMCPSelections: mockResolveMCPSelections }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: mockApiKeyService }))
vi.mock('$lib/server/services/dockerGatewayConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/dockerGatewayConfig')>()
  return { ...actual, getDockerGatewayAuthToken: vi.fn(() => null) }
})
// The command ownership guard (BL-37/724) decides whether a delete may start; it is not what
// this suite tests, so the folder removal runs straight through it.
vi.mock('$lib/server/services/hostCommandOwnership', () => ({
  hostProfileResource: (profileId: string) => JSON.stringify(['profile', profileId]),
  withHostCommandDeletion: async <T>(_resources: string[], action: (notices: string[]) => Promise<T>) => action([])
}))

const SUITE_PROFILE_FOLDER = /^batshit_agent_zcprof/
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function exists(target: string) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function codexAgent() {
  return {
    id: 'zcprof-codex',
    user_id: 'josh',
    displayName: 'zcprof Codex',
    slug: 'zcprof-codex',
    agentType: 'batshit',
    primary_model_provider: 'codex-cli',
    codex_settings: {},
    provider_specific_settings: {
      nativeTools: { fetchZipEnabled: false, dynamicMcpEnabled: false, batshitToolsEnabled: false, agentBrowserEnabled: false }
    },
    assignedSubagents: []
  }
}

function claudeAgent() {
  return {
    id: 'zcprof-claude',
    user_id: 'josh',
    displayName: 'zcprof Claude',
    slug: 'zcprof-claude',
    primary_model_provider: 'claude-cli',
    provider_specific_settings: {
      nativeTools: { fetchZipEnabled: false, dynamicMcpEnabled: false, batshitToolsEnabled: false }
    },
    claude_settings: {},
    assignedSubagents: []
  }
}

describe('BL-745: a profile sync never recreates the folder of an agent deleted during it', () => {
  const originalHome = process.env.HOME
  let tempHome = ''
  let realAgentsRoot = ''
  let realAgentsBefore: string[] = []
  const listRealAgents = async () => (await readdir(realAgentsRoot).catch(() => [] as string[])).sort()
  const agentsRoot = () => path.join(tempHome, '.batshit', 'agents')

  beforeAll(async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os')
    realAgentsRoot = path.join(realOs.homedir(), '.batshit', 'agents')
    realAgentsBefore = await listRealAgents()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'zcprof-profile-race-'))
    testHome.current = tempHome
    process.env.HOME = tempHome
    agentRows.clear()
    jsonGetHook.current = null
    mockRedis.getProjectPreferences.mockResolvedValue(null)
    mockRedis.getProjects.mockResolvedValue([])
    mockRedis.get.mockResolvedValue(null)
    mockRedis.getUserSettings.mockResolvedValue(null)
    mockApiKeyService.retrieve.mockResolvedValue(null)
    mockGatewayService.list.mockResolvedValue([])
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })
    // BL-1030: prepare cold modules after the isolated HOME/mocks exist.
    // The test keeps its normal operation deadline; import/setup has its own bounded hook.
    await Promise.all([import('../codexProfileManager'), import('../claudeProfileManager')])
  }, 30_000)

  afterEach(async () => {
    jsonGetHook.current = null
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    testHome.current = ''
    if (tempHome) await rm(tempHome, { recursive: true, force: true })
    const added = (await listRealAgents()).filter(
      (entry) => !realAgentsBefore.includes(entry) && SUITE_PROFILE_FOLDER.test(entry)
    )
    expect(added).toEqual([])
  })

  function useAgent(agent: Record<string, unknown> & { id: string }) {
    agentRows.set(`agent:${agent.id}`, agent)
    mockRedis.getAgents.mockResolvedValue([agent])
  }

  describe('Codex', () => {
    it('control: a normal sync of a live agent writes its folder', async () => {
      const agent = codexAgent()
      useAgent(agent)
      const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
      await syncAgentCodexProfiles('josh')
      expect(await exists(path.join(agentsRoot(), buildAgentProfileId(agent.id), '.codex', 'config.toml'))).toBe(true)
    })

    it('an agent deleted after the sync read the agents gets no folder back', async () => {
      const agent = codexAgent()
      useAgent(agent)
      const { syncAgentCodexProfiles, deleteAgentCodexConfig, buildAgentProfileId } = await import('../codexProfileManager')
      await syncAgentCodexProfiles('josh')
      const folder = path.join(agentsRoot(), buildAgentProfileId(agent.id))
      expect(await exists(folder)).toBe(true)

      // The agent delete, in the order the route runs it, lands between the sync's read of
      // the agents and its folder write.
      mockGatewayService.list.mockImplementationOnce(async () => {
        agentRows.delete(`agent:${agent.id}`)
        await deleteAgentCodexConfig(agent.id)
        return []
      })
      await syncAgentCodexProfiles('josh')
      expect(await exists(folder)).toBe(false)
    })

    it('a removal that starts while the write is running waits for it, and the folder ends gone', async () => {
      const agent = codexAgent()
      useAgent(agent)
      const { syncAgentCodexProfiles, deleteAgentCodexConfig, buildAgentProfileId } = await import('../codexProfileManager')
      const folder = path.join(agentsRoot(), buildAgentProfileId(agent.id))
      let removal: Promise<unknown> | null = null
      // The sync's own record check passes; the delete starts right then.
      jsonGetHook.current = async (key) => {
        if (key !== `agent:${agent.id}` || removal) return
        removal = deleteAgentCodexConfig(agent.id)
        await Promise.race([removal, sleep(150)])
      }
      await syncAgentCodexProfiles('josh')
      expect(removal).not.toBeNull()
      await removal
      expect(await exists(folder)).toBe(false)
    })
  })

  describe('Claude', () => {
    it('control: a normal sync of a live agent writes its folder', async () => {
      const agent = claudeAgent()
      useAgent(agent)
      const { syncAgentClaudeProfiles, buildClaudeProfileId } = await import('../claudeProfileManager')
      await syncAgentClaudeProfiles('josh')
      expect(await exists(path.join(agentsRoot(), buildClaudeProfileId(agent.id), '.claude', 'mcp.json'))).toBe(true)
    })

    it('an agent deleted after the sync read the agents gets no folder back', async () => {
      const agent = claudeAgent()
      useAgent(agent)
      const { syncAgentClaudeProfiles, deleteAgentClaudeConfig, buildClaudeProfileId } = await import('../claudeProfileManager')
      await syncAgentClaudeProfiles('josh')
      const home = path.join(agentsRoot(), buildClaudeProfileId(agent.id), '.claude')
      expect(await exists(home)).toBe(true)

      mockGatewayService.list.mockImplementationOnce(async () => {
        agentRows.delete(`agent:${agent.id}`)
        await deleteAgentClaudeConfig(agent.id)
        return []
      })
      await syncAgentClaudeProfiles('josh')
      expect(await exists(home)).toBe(false)
    })

    it('a removal that starts while the write is running waits for it, and the folder ends gone', async () => {
      const agent = claudeAgent()
      useAgent(agent)
      const { syncAgentClaudeProfiles, deleteAgentClaudeConfig, buildClaudeProfileId } = await import('../claudeProfileManager')
      await syncAgentClaudeProfiles('josh')
      const home = path.join(agentsRoot(), buildClaudeProfileId(agent.id), '.claude')
      expect(await exists(home)).toBe(true)
      let removal: Promise<unknown> | null = null
      jsonGetHook.current = async (key) => {
        if (key !== `agent:${agent.id}` || removal) return
        removal = deleteAgentClaudeConfig(agent.id)
        await Promise.race([removal, sleep(150)])
      }
      await syncAgentClaudeProfiles('josh')
      expect(removal).not.toBeNull()
      await removal
      expect(await exists(home)).toBe(false)
    })
  })
})

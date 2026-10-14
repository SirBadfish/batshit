import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'

/**
 * BL-753: a Subagent edit saves the record, then syncs the Subagent's managed CLI profile folder
 * from the row it holds in memory. A Subagent deleted while that sync awaits other setup
 * (gateways, MCP selections) must not get its folder back, for Codex and Claude.
 */

const records = new Map<string, Record<string, unknown>>()
const sets = new Map<string, Set<string>>()

const mockRedis = {
  getProjectPreferences: vi.fn(),
  getProjects: vi.fn(),
  get: vi.fn(),
  getUserSettings: vi.fn(),
  sMembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
  json: {
    get: vi.fn(async (key: string) => records.get(key) ?? null)
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
    if (!testHome.current) throw new Error('cliSubagentProfileDeleteRace.test: no temporary home is set')
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

const USER = 'zcsubag_user'
const SUITE_PROFILE_FOLDER = /^batshit_agent_subagent_cli[-_]zcsubag/
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

function codexSubagent() {
  return {
    id: 'zcsubag_codex',
    user_id: USER,
    displayName: 'zcsubag Codex',
    slug: 'zcsubag_codex',
    subagentType: 'cli',
    primary_model_provider: 'openai-codex',
    primary_model_name: 'codex-cli',
    codex_settings: {},
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  }
}

function claudeSubagent() {
  return {
    id: 'zcsubag_claude',
    user_id: USER,
    displayName: 'zcsubag Claude',
    slug: 'zcsubag_claude',
    subagentType: 'cli',
    primary_model_provider: 'anthropic-claude-cli',
    primary_model_name: 'claude-cli',
    claude_settings: {},
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  }
}

describe('BL-753: a Subagent profile sync never recreates the folder of a Subagent deleted during it', () => {
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
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'zcsubag-profile-race-'))
    testHome.current = tempHome
    process.env.HOME = tempHome
    records.clear()
    sets.clear()
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
    await Promise.all([import('../cliSubagentProfileSync')])
  }, 30_000)

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    testHome.current = ''
    if (tempHome) await rm(tempHome, { recursive: true, force: true })
    const added = (await listRealAgents()).filter(
      (entry) => !realAgentsBefore.includes(entry) && SUITE_PROFILE_FOLDER.test(entry)
    )
    expect(added).toEqual([])
  })

  function useSubagent(subagent: Record<string, unknown> & { id: string }) {
    records.set(`subagent:${subagent.id}`, subagent)
    sets.set(`user:${USER}:subagents`, new Set([subagent.id]))
  }

  /** The Subagent delete's steps, in the route's order: the folder, then the record. */
  async function deleteSubagentAsTheRouteDoes(subagent: Record<string, unknown> & { id: string }) {
    const { deleteManagedCliSubagentProfile } = await import('../cliSubagentProfileSync')
    await deleteManagedCliSubagentProfile(USER, subagent as any)
    sets.get(`user:${USER}:subagents`)?.delete(subagent.id)
    records.delete(`subagent:${subagent.id}`)
  }

  async function profileFolder(subagent: { slug: string }) {
    const { buildAgentProfileId } = await import('../codexProfileManager')
    const { buildCliSubagentRuntimeId } = await import('$lib/utils/subagentSlug')
    return path.join(agentsRoot(), buildAgentProfileId(buildCliSubagentRuntimeId(subagent.slug)))
  }

  for (const [runtime, makeSubagent, marker] of [
    ['Codex', codexSubagent, path.join('.codex', 'config.toml')],
    ['Claude', claudeSubagent, path.join('.claude', 'mcp.json')]
  ] as const) {
    describe(runtime, () => {
      it('control: a normal sync of a live Subagent writes its folder', async () => {
        const subagent = makeSubagent()
        useSubagent(subagent)
        const { syncManagedCliSubagentProfile } = await import('../cliSubagentProfileSync')
        await syncManagedCliSubagentProfile(USER, subagent as any)
        expect(await exists(path.join(await profileFolder(subagent), marker))).toBe(true)
      })

      it('a Subagent deleted while the sync awaits its setup gets no folder back', async () => {
        const subagent = makeSubagent()
        useSubagent(subagent)
        const { syncManagedCliSubagentProfile } = await import('../cliSubagentProfileSync')
        await syncManagedCliSubagentProfile(USER, subagent as any)
        const folder = await profileFolder(subagent)
        expect(await exists(folder)).toBe(true)

        // The Subagent delete (another request) starts while the edit's sync awaits the gateway
        // list, and is given time to finish there: before BL-753 it did, and the sync then wrote
        // the folder again. Now it waits for the sync's turn, and its removal comes after.
        let deletion: Promise<void> | null = null
        mockGatewayService.list.mockImplementationOnce(async () => {
          deletion = deleteSubagentAsTheRouteDoes(subagent)
          await Promise.race([deletion, sleep(150)])
          return []
        })
        await syncManagedCliSubagentProfile(USER, subagent as any)
        expect(deletion).not.toBeNull()
        await deletion
        expect(records.has(`subagent:${subagent.id}`)).toBe(false)
        expect(await exists(folder)).toBe(false)
      })

      it('a sync queued between the delete\'s folder removal and its record deletion writes nothing', async () => {
        const subagent = makeSubagent()
        useSubagent(subagent)
        const { syncManagedCliSubagentProfile, holdManagedCliSubagentProfileFolder, deleteManagedCliSubagentProfile } =
          await import('../cliSubagentProfileSync')
        await syncManagedCliSubagentProfile(USER, subagent as any)
        const folder = await profileFolder(subagent)
        expect(await exists(folder)).toBe(true)

        let folderRemoved!: () => void
        const removed = new Promise<void>((resolve) => {
          folderRemoved = resolve
        })
        // The route's delete: the folder, then (after its other steps) the record, in one hold.
        const deletion = holdManagedCliSubagentProfileFolder(subagent as any, async () => {
          await deleteManagedCliSubagentProfile(USER, subagent as any)
          folderRemoved()
          await sleep(100)
          sets.get(`user:${USER}:subagents`)?.delete(subagent.id)
          records.delete(`subagent:${subagent.id}`)
        })
        await removed
        // The edit's sync, from the test's own context, while the record is still there.
        const sync = syncManagedCliSubagentProfile(USER, subagent as any)
        await deletion
        expect((await sync)?.written).toBe(false)
        expect(await exists(folder)).toBe(false)
      })
    })
  }
})

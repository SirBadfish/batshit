import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'

/**
 * BL-761 (2026-09-28): opening a CLI Subagent's managed config (`GET
 * /api/subagents/[id]/managed-config`) reads the record, then after several awaits (the gateway
 * list, the MCP selections) calls `prepareManaged{Codex,Claude}SubagentProfile`, which write the
 * Subagent's profile folder. A Subagent deleted while those awaits run must not get its folder
 * back. The route now runs that write through `writeSubagentProfileFolderIfSubagentExists`
 * (`agentProfileFolderGate.ts`, the same gate BL-745/753 use), which re-reads `subagent:<id>` at
 * the folder's own turn, and the low-level folder removal (`deleteAgentCodexConfig` /
 * `deleteAgentClaudeConfig`) is gated the same way, so a delete racing this viewer either finds
 * no record and writes nothing, or its removal queues behind this write and takes the folder
 * away right after.
 */

const records = new Map<string, Record<string, unknown>>()

const mockRedis = {
  get: vi.fn(async () => null),
  getUserSettings: vi.fn(async () => null),
  sMembers: vi.fn(async () => [] as string[]),
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
    if (!testHome.current) throw new Error('managed-config-delete-race.test: no temporary home is set')
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
// The command ownership guard (BL-37/724) decides whether a delete may start; not what this
// suite tests, so any folder removal it gates runs straight through it.
vi.mock('$lib/server/services/hostCommandOwnership', () => ({
  hostProfileResource: (profileId: string) => JSON.stringify(['profile', profileId]),
  withHostCommandDeletion: async <T>(_resources: string[], action: (notices: string[]) => Promise<T>) => action([])
}))

const USER = 'zcmcfg_user'
const SUITE_PROFILE_FOLDER = /^batshit_agent_subagent_cli[-_]zcmcfg/
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
    id: 'zcmcfg_codex',
    user_id: USER,
    displayName: 'zcmcfg Codex',
    slug: 'zcmcfg_codex',
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
    id: 'zcmcfg_claude',
    user_id: USER,
    displayName: 'zcmcfg Claude',
    slug: 'zcmcfg_claude',
    subagentType: 'cli',
    primary_model_provider: 'anthropic-claude-cli',
    primary_model_name: 'claude-cli',
    claude_settings: {},
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  }
}

describe('BL-761: opening a CLI Subagent managed config never recreates a deleted Subagent folder', () => {
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
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'zcmcfg-profile-race-'))
    testHome.current = tempHome
    process.env.HOME = tempHome
    records.clear()
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
  })

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
  }

  async function callGet(subagentId: string, provider: 'codex' | 'claude') {
    const { GET } = await import('./+server')
    const url = new URL(`http://test/api/subagents/${subagentId}/managed-config?provider=${provider}`)
    return (await GET({
      params: { id: subagentId },
      locals: { user: { id: USER } },
      url
    } as any)) as Response
  }

  async function profileFolder(subagent: { slug: string }) {
    const { buildAgentProfileId } = await import('$lib/server/services/codexProfileManager')
    const { buildCliSubagentRuntimeId } = await import('$lib/utils/subagentSlug')
    return path.join(agentsRoot(), buildAgentProfileId(buildCliSubagentRuntimeId(subagent.slug)))
  }

  for (const [runtime, makeSubagent, provider, marker] of [
    ['Codex', codexSubagent, 'codex', path.join('.codex', 'config.toml')],
    ['Claude', claudeSubagent, 'claude', path.join('.claude', 'mcp.json')]
  ] as const) {
    describe(runtime, () => {
      it('control: viewing a live Subagent writes its folder and answers 200', async () => {
        const subagent = makeSubagent()
        useSubagent(subagent)
        const response = await callGet(subagent.id, provider)
        expect(response.status).toBe(200)
        expect(await exists(path.join(await profileFolder(subagent), marker))).toBe(true)
      })

      it('a viewer queued behind the delete\'s hold finds no record, writes nothing, and answers 404', async () => {
        const subagent = makeSubagent()
        useSubagent(subagent)
        const folder = await profileFolder(subagent)
        // The Subagent's first, live view: creates its folder (proves the fixture works).
        expect((await callGet(subagent.id, provider)).status).toBe(200)
        expect(await exists(folder)).toBe(true)

        const { holdAgentProfileFolder } = await import('$lib/server/services/agentProfileFolderGate')
        const { buildAgentProfileId } = await import('$lib/server/services/codexProfileManager')
        const { buildCliSubagentRuntimeId } = await import('$lib/utils/subagentSlug')
        const profileId = buildAgentProfileId(buildCliSubagentRuntimeId(subagent.slug))

        let folderRemoved!: () => void
        const removed = new Promise<void>((resolve) => {
          folderRemoved = resolve
        })
        // The route's delete: the folder, then (after its other steps) the record, in one hold
        // (`holdManagedCliSubagentProfileFolder`, `+server.ts`'s `deleteStoppedSubagent`).
        const deletion = holdAgentProfileFolder(profileId, async () => {
          await rm(folder, { recursive: true, force: true })
          folderRemoved()
          await sleep(100)
          records.delete(`subagent:${subagent.id}`)
        })
        await removed
        // The viewer, from the test's own context, while the delete's hold still has the turn:
        // its write queues behind the hold and only reads the record once the hold releases.
        const response = await callGet(subagent.id, provider)
        await deletion
        expect(response.status).toBe(404)
        expect(await exists(folder)).toBe(false)
      })
    })
  }
})

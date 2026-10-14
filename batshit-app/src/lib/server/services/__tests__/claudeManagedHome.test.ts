import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'

/**
 * BL-7 review (codex7) — a managed Claude run only ever uses a Batshit-managed home.
 *
 * The Claude lane took a stored `claude_profile_id` as a folder name unchecked: `../..` made
 * the managed paths `~/.batshit/agents/../../.claude/…`, the user's own `~/.claude`, so the
 * run's `--settings`, `--mcp-config` and `--plugin-dir` pointed into it, and a CLI Subagent
 * profile write merged Batshit's keys into the user's own `settings.json` and replaced their
 * `mcp.json`. An agent folder whose `.claude` (or whose whole folder) is a symlink out of the
 * agents folder reached the same files by a valid name, and deleting that agent removed the
 * folder it pointed at. These tests build a throwaway HOME with a fake `~/.claude`.
 *
 * SAFETY: the Claude manager resolves its root from `process.env.HOME` first, then
 * `os.homedir()`. Both point at the throwaway HOME before any module under test loads, and
 * `os.homedir()` throws until it exists.
 */

const fake = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!fake.home) {
      throw new Error('claudeManagedHome.test: os.homedir() was called before the throwaway HOME existed')
    }
    return fake.home
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})

describe('managed Claude run folder admission', () => {
  it('refuses a run queued behind deletion without recreating the home', async () => {
    const profileId = manager.buildClaudeProfileId('agent-1')
    const { holdAgentProfileFolder } = await import('../agentProfileFolderGate')
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
    const start = manager.ensureManagedClaudeHome(profileId, { userId: 'josh', kind: 'agent', id: 'agent-1' })
    releaseDelete()
    await deletion
    await expect(start).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    await expect(lstat(path.join(agentsRoot, profileId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps syncing other agents after one gated Redis read fails', async () => {
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-bad'), claudeAgent('agent-good')])
    mockRedis.json.get.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-bad') throw new Error('Redis unavailable')
      return { id: 'agent-good', user_id: 'josh' }
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await manager.syncAgentClaudeProfiles('josh')
    expect(error.mock.calls.some((call) => String(call[0]).includes('Failed to sync agent profile'))).toBe(true)
    const { settingsPath } = manager.getManagedClaudePaths(manager.buildClaudeProfileId('agent-good'))
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toHaveProperty('permissions')
  })

  it('refuses the required profile when its sync read fails despite an older settings file', async () => {
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-own'), claudeAgent('agent-other')])
    const profileId = manager.buildClaudeProfileId('agent-own')
    const { settingsPath } = manager.getManagedClaudePaths(profileId)
    await mkdir(path.dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, '{"old":true}')
    mockRedis.json.get.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-own') throw new Error('Redis unavailable')
      return { id: 'agent-other', user_id: 'josh' }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(manager.syncAgentClaudeProfiles('josh', profileId)).rejects.toMatchObject({
      code: 'MANAGED_PROFILE_RUN_REFUSED'
    })
    expect(await readFile(settingsPath, 'utf8')).toBe('{"old":true}')
    const other = manager.getManagedClaudePaths(manager.buildClaudeProfileId('agent-other'))
    expect(JSON.parse(await readFile(other.settingsPath, 'utf8'))).toHaveProperty('permissions')
  })

  it('refuses the required profile when its write fails, then still writes the next agent', async () => {
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-own'), claudeAgent('agent-other')])
    const profileId = manager.buildClaudeProfileId('agent-own')
    const own = manager.getManagedClaudePaths(profileId)
    // An occupied directory at the config-file path makes the atomic rename fail.
    await mkdir(own.mcpPath, { recursive: true })
    await writeFile(path.join(own.mcpPath, 'keep'), 'user data')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(manager.syncAgentClaudeProfiles('josh', profileId)).rejects.toMatchObject({
      code: 'MANAGED_PROFILE_RUN_REFUSED'
    })
    expect(await readFile(path.join(own.mcpPath, 'keep'), 'utf8')).toBe('user data')
    const other = manager.getManagedClaudePaths(manager.buildClaudeProfileId('agent-other'))
    expect(JSON.parse(await readFile(other.mcpPath, 'utf8'))).toHaveProperty('mcpServers')
  })
})

const spawnCalls = vi.hoisted(
  () => [] as Array<{ args: string[]; env?: NodeJS.ProcessEnv; mcpConfigAtSpawn?: string | null }>
)
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { existsSync, readFileSync } = await import('node:fs')
  const spawn = (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    // BL-152: the `--mcp-config` file Claude Code would read at this moment, beside its env.
    const mcpIndex = args.indexOf('--mcp-config')
    const mcpPath = mcpIndex >= 0 ? args[mcpIndex + 1] : null
    spawnCalls.push({
      args,
      env: options.env,
      mcpConfigAtSpawn: mcpPath && existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : null
    })
    throw new Error('claudeManagedHome.test: nothing may spawn a Claude process here')
  }
  return { ...original, spawn, default: { ...((original as any).default ?? original), spawn } }
})

/* A path-based chown follows links, so none may remain: every one of them fails the test. */
const pathChownCalls = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const chown = async (target: unknown) => {
    pathChownCalls.push(String(target))
    throw new Error('claudeManagedHome.test: a path-based chown was called (it follows links)')
  }
  return { ...actual, chown, default: { ...((actual as any).default ?? actual), chown } }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const chown = async (target: unknown) => {
    pathChownCalls.push(String(target))
    throw new Error('claudeManagedHome.test: a path-based chown was called (it follows links)')
  }
  const promises = { ...actual.promises, chown }
  return { ...actual, promises, default: { ...((actual as any).default ?? actual), promises } }
})

vi.mock('$lib/server/services/claudeCliStatus', () => ({
  detectClaudeCliStatus: vi.fn(async () => ({
    available: true,
    executable: '/nonexistent/claude',
    version: '2.1.185',
    source: 'path'
  })),
  resolveClaudeCliExecutable: vi.fn(() => '/nonexistent/claude')
}))

const mockRedis = vi.hoisted(() => ({
  getAgents: vi.fn(async (_userId: string) => [] as any[]),
  // BL-745: a profile sync writes an agent's folder only while the agent's record exists.
  json: { get: vi.fn(async (key: string) => (key.startsWith('agent:') ? { id: key.slice('agent:'.length), user_id: 'josh' } : null)) },
  get: vi.fn(async () => null),
  getUserSettings: vi.fn(async () => null),
  getProjectPreferences: vi.fn(async () => null),
  execute: vi.fn(async (operation: (client: any) => Promise<any>) =>
    operation({ json: { get: async () => null }, sAdd: async () => 1, sRem: async () => 1, expire: async () => true, del: async () => 1 })
  )
}))
const mockGatewayService = vi.hoisted(() => ({ list: vi.fn(async () => []), update: vi.fn() }))
const mockResolveMCPSelections = vi.hoisted(() => vi.fn())

vi.mock('$env/dynamic/private', () => ({
  env: { BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true', BATSHIT_CODEX_PROVIDER_ENABLED: 'true', BATSHIT_TOKEN: '' }
}))
vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({ mcpGatewayService: mockGatewayService }))
vi.mock('$lib/server/services/mcpSelectionResolver', () => ({
  resolveMCPSelections: mockResolveMCPSelections
}))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn(async () => null), store: vi.fn() }
}))
vi.mock('$lib/server/services/dockerGatewayConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/dockerGatewayConfig')>()
  return { ...actual, getDockerGatewayAuthToken: vi.fn(() => null) }
})

type ClaudeProfileManager = typeof import('../claudeProfileManager')
type ClaudeBridgeModule = typeof import('../claudeBridge')

let manager: ClaudeProfileManager
let bridgeModule: ClaudeBridgeModule
let usersClaudeHome = ''
let agentsRoot = ''
const originalHome = process.env.HOME
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

const USERS_SETTINGS = '{"theme":"the user\'s own Claude settings"}'
const USERS_PLUGIN = '# the user\'s own Claude plugin\n'

beforeAll(async () => {
  const actualOs = await vi.importActual<typeof import('node:os')>('node:os')
  const tmpRoot = await realpath(actualOs.tmpdir())
  fake.home = await realpath(await mkdtemp(path.join(tmpRoot, 'bl7-claude-home-')))
  expect(fake.home).not.toBe(actualOs.homedir())
  expect(fake.home.startsWith(tmpRoot + path.sep)).toBe(true)
  process.env.HOME = fake.home
  delete process.env.CLAUDE_CONFIG_DIR

  vi.resetModules()
  manager = await import('../claudeProfileManager')
  bridgeModule = await import('../claudeBridge')
  usersClaudeHome = path.join(fake.home, '.claude')
  agentsRoot = path.join(fake.home, '.batshit', 'agents')
  // Safety net: the Claude manager sees the throwaway HOME, or nothing runs.
  expect(manager.getManagedClaudePaths('batshit_agent_probe').dir).toBe(
    path.join(agentsRoot, 'batshit_agent_probe', '.claude')
  )
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalClaudeConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  if (fake.home) await rm(fake.home, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.clearAllMocks()
  mockRedis.json.get.mockImplementation(async (key: string) =>
    key.startsWith('agent:') ? { id: key.slice('agent:'.length), user_id: 'josh' } : null
  )
  for (const entry of await readdir(fake.home)) {
    await rm(path.join(fake.home, entry), { recursive: true, force: true })
  }
  await mkdir(path.join(usersClaudeHome, 'plugins', 'mine'), { recursive: true })
  await writeFile(path.join(usersClaudeHome, 'settings.json'), USERS_SETTINGS)
  await writeFile(path.join(usersClaudeHome, 'plugins', 'mine', 'README.md'), USERS_PLUGIN)
  await mkdir(agentsRoot, { recursive: true })
  spawnCalls.length = 0
  pathChownCalls.length = 0
  mockRedis.getAgents.mockResolvedValue([])
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

afterEach(() => {
  vi.restoreAllMocks()
})

/** The user's own Claude home is exactly as the test made it. */
async function expectUsersClaudeHomeWhole() {
  expect(await readFile(path.join(usersClaudeHome, 'settings.json'), 'utf8')).toBe(USERS_SETTINGS)
  expect(await readFile(path.join(usersClaudeHome, 'plugins', 'mine', 'README.md'), 'utf8')).toBe(USERS_PLUGIN)
  expect((await readdir(usersClaudeHome)).sort()).toEqual(['plugins', 'settings.json'])
  expect(await readdir(path.join(usersClaudeHome, 'plugins'))).toEqual(['mine'])
}

function claudeAgent(id: string) {
  return {
    id,
    user_id: 'josh',
    displayName: `Agent ${id}`,
    slug: id,
    agentType: 'cli',
    primary_model_provider: 'claude-cli',
    claude_settings: {},
    provider_specific_settings: {
      nativeTools: { fetchZipEnabled: false, dynamicMcpEnabled: false, batshitToolsEnabled: false, agentBrowserEnabled: false }
    },
    assignedSubagents: []
  }
}

function subagentProfile(profileId: string) {
  return {
    userId: 'josh',
    profileId,
    runtimeId: 'subagent_cli_probe',
    label: 'BL-7 Claude probe',
    displayName: 'BL-7 Claude probe'
  }
}

describe('the managed Claude home', () => {
  it('refuses a stored profile id of ../.. before any file is written', async () => {
    await expect(manager.prepareManagedClaudeSubagentProfile(subagentProfile('../..'))).rejects.toThrow(
      /refused/
    )

    await expectUsersClaudeHomeWhole()
  })

  it('refuses ../.. before making any folder, even when the user has no ~/.claude yet', async () => {
    await rm(usersClaudeHome, { recursive: true, force: true })

    await expect(manager.ensureManagedClaudeHome('../..', { userId: 'josh', kind: 'agent', id: 'probe' })).rejects.toThrow(/refused/)

    await expect(lstat(usersClaudeHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("refuses a managed home that IS the user's own Claude home, by ~/.claude or CLAUDE_CONFIG_DIR", async () => {
    // The other direction: the user's Claude home points INTO the agents folder, so the
    // managed home and the user's home are one folder with two names.
    const twin = path.join(agentsRoot, 'batshit_agent_twin', '.claude')
    await mkdir(twin, { recursive: true })
    await rm(usersClaudeHome, { recursive: true, force: true })
    await symlink(twin, usersClaudeHome)
    await expect(manager.ensureManagedClaudeHome('batshit_agent_twin', { userId: 'josh', kind: 'agent', id: 'twin' })).rejects.toThrow(/your own Claude home/)

    await rm(usersClaudeHome)
    const configured = path.join(agentsRoot, 'batshit_agent_configured', '.claude')
    await mkdir(configured, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configured
    try {
      await expect(manager.ensureManagedClaudeHome('batshit_agent_configured', { userId: 'josh', kind: 'agent', id: 'configured' })).rejects.toThrow(
        /your own Claude home/
      )
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
    }
  })

  it('refuses an absolute path as a profile id and creates nothing for it', async () => {
    const stray = path.join(fake.home, 'stray')

    await expect(manager.prepareManagedClaudeSubagentProfile(subagentProfile(stray))).rejects.toThrow(/refused/)

    await expect(stat(path.join(agentsRoot, stray))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(stray)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => manager.getManagedClaudePaths(stray)).toThrow(/refused/)
    await expectUsersClaudeHomeWhole()
  })

  it('refuses an agent home whose .claude is a symlink to ~/.claude, and writes nothing through it', async () => {
    await mkdir(path.join(agentsRoot, 'batshit_agent_victim'), { recursive: true })
    await symlink(usersClaudeHome, path.join(agentsRoot, 'batshit_agent_victim', '.claude'))

    await expect(
      manager.prepareManagedClaudeSubagentProfile(subagentProfile('batshit_agent_victim'))
    ).rejects.toThrow(/refused/)

    await expectUsersClaudeHomeWhole()
  })

  it('refuses a profile folder that is a symlink out of the agents folder, before making anything in it', async () => {
    const outside = path.join(fake.home, 'elsewhere')
    await mkdir(outside, { recursive: true })
    await symlink(outside, path.join(agentsRoot, 'batshit_agent_linked'))

    await expect(
      manager.prepareManagedClaudeSubagentProfile(subagentProfile('batshit_agent_linked'))
    ).rejects.toThrow(/refused/)

    expect(await readdir(outside)).toEqual([])
    await expectUsersClaudeHomeWhole()
  })

  it('still prepares a real managed home and writes its files there', async () => {
    const profileId = manager.buildClaudeProfileId('subagent_cli_probe')

    await manager.prepareManagedClaudeSubagentProfile(subagentProfile(profileId))

    const { settingsPath, mcpPath, pluginsDir } = manager.getManagedClaudePaths(profileId)
    expect(settingsPath.startsWith(path.join(agentsRoot, profileId, '.claude') + path.sep)).toBe(true)
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toHaveProperty('permissions')
    expect(JSON.parse(await readFile(mcpPath, 'utf8'))).toHaveProperty('mcpServers')
    expect((await lstat(pluginsDir)).isDirectory()).toBe(true)
    await expectUsersClaudeHomeWhole()
  })

  it('one refused agent home is skipped loudly by the profile sync, and the other agents are still written', async () => {
    const victimProfile = manager.buildClaudeProfileId('victim')
    await mkdir(path.join(agentsRoot, victimProfile), { recursive: true })
    await symlink(usersClaudeHome, path.join(agentsRoot, victimProfile, '.claude'))
    mockRedis.getAgents.mockResolvedValue([claudeAgent('victim'), claudeAgent('agent-2')])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await manager.syncAgentClaudeProfiles('josh')

    const other = manager.getManagedClaudePaths(manager.buildClaudeProfileId('agent-2'))
    expect(JSON.parse(await readFile(other.mcpPath, 'utf8'))).toHaveProperty('mcpServers')
    expect(error.mock.calls.some((call) => String(call[0]).includes('refused'))).toBe(true)
    await expectUsersClaudeHomeWhole()
  })

  it('deleting an agent whose profile folder is a symlink never deletes the folder it points at', async () => {
    // `rm -rf <agents>/<profile>/.claude` resolves THROUGH a symlinked profile folder, so the
    // user's own `.claude` (a real folder there) would have gone with the agent.
    const profileId = manager.buildClaudeProfileId('victim')
    await symlink(fake.home, path.join(agentsRoot, profileId))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(manager.deleteAgentClaudeConfig('victim')).rejects.toThrow(/refused/)

    await expectUsersClaudeHomeWhole()
  })

  it('still deletes a real managed Claude home, and only the link when .claude is a symlink', async () => {
    const realProfile = manager.buildClaudeProfileId('agent-4')
    await mkdir(path.join(agentsRoot, realProfile, '.claude', 'plugins'), { recursive: true })
    const linkedProfile = manager.buildClaudeProfileId('agent-5')
    await mkdir(path.join(agentsRoot, linkedProfile), { recursive: true })
    await symlink(usersClaudeHome, path.join(agentsRoot, linkedProfile, '.claude'))

    await manager.deleteAgentClaudeConfig('agent-4')
    await manager.deleteAgentClaudeConfig('agent-5')
    // An agent that never had a Claude home (every agent delete calls this) is quietly done.
    await expect(manager.deleteAgentClaudeConfig('never-made')).resolves.toBeUndefined()

    await expect(stat(path.join(agentsRoot, realProfile, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(path.join(agentsRoot, linkedProfile, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectUsersClaudeHomeWhole()
  })
})

describe('files inside a managed Claude home and planted symlinks', () => {
  // Rule (BL-7 review): Batshit replaces a link where one of its own files belongs and never
  // touches the link's target (temp file renamed over it); a linked file's content is never
  // read or merged.
  const USER_SETTINGS_TEXT = '{"USER_MARKER":"the user\'s own settings","theme":"dark"}'
  const USER_MCP_TEXT = '{"mcpServers":{"users-own":{"command":"secret-tool"}}}'

  it('replaces symlinked settings.json, mcp.json and plugins with its own, and never writes or reads their targets', async () => {
    const userDir = path.join(fake.home, 'user-files')
    await mkdir(path.join(userDir, 'plugins', 'theirs'), { recursive: true })
    await writeFile(path.join(userDir, 'settings.json'), USER_SETTINGS_TEXT)
    await writeFile(path.join(userDir, 'mcp.json'), USER_MCP_TEXT)
    const profileId = manager.buildClaudeProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.claude')
    await mkdir(home, { recursive: true })
    await symlink(path.join(userDir, 'settings.json'), path.join(home, 'settings.json'))
    await symlink(path.join(userDir, 'mcp.json'), path.join(home, 'mcp.json'))
    await symlink(path.join(userDir, 'plugins'), path.join(home, 'plugins'))
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-1')])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await manager.syncAgentClaudeProfiles('josh')

    expect(await readFile(path.join(userDir, 'settings.json'), 'utf8')).toBe(USER_SETTINGS_TEXT)
    expect(await readFile(path.join(userDir, 'mcp.json'), 'utf8')).toBe(USER_MCP_TEXT)
    expect(await readdir(path.join(userDir, 'plugins'))).toEqual(['theirs'])
    for (const name of ['settings.json', 'mcp.json']) {
      const entry = await lstat(path.join(home, name))
      expect(entry.isFile(), name).toBe(true)
      expect(entry.mode & 0o777, name).toBe(0o600)
    }
    expect((await lstat(path.join(home, 'plugins'))).isDirectory()).toBe(true)
    const settings = await readFile(path.join(home, 'settings.json'), 'utf8')
    expect(settings).toContain('permissions')
    expect(settings).not.toContain('USER_MARKER')
    expect(await readFile(path.join(home, 'mcp.json'), 'utf8')).not.toContain('secret-tool')
    expect(warn.mock.calls.some((call) => String(call[0]).includes('symlink'))).toBe(true)
    await expectUsersClaudeHomeWhole()
  })

  // BL-291: the log named every refused read "through a symlink", a hard link included.
  it('logs a hard-linked settings.json as a hard link, never as a symlink', async () => {
    const userDir = path.join(fake.home, 'bl291-elsewhere')
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, 'settings.json'), USER_SETTINGS_TEXT)
    const profileId = manager.buildClaudeProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.claude')
    await mkdir(home, { recursive: true })
    await link(path.join(userDir, 'settings.json'), path.join(home, 'settings.json'))
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-1')])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await manager.syncAgentClaudeProfiles('josh')

    expect(await readFile(path.join(userDir, 'settings.json'), 'utf8')).toBe(USER_SETTINGS_TEXT)
    const refusals = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('Did not read a managed file'))
    expect(refusals.length).toBeGreaterThan(0)
    for (const line of refusals) {
      expect(line).toContain('hard link')
      expect(line).not.toContain('symlink')
    }
  })
})

describe('ownership, deletes, and HOME for managed Claude homes', () => {
  it('sets a run-as owner through the open file and lchown, never a path-based chown that follows links', async () => {
    // Docker runs Claude as another user: Batshit (root there) hands it the managed files.
    // A path chown after the temp file was closed could be redirected by a swapped-in link.
    const altGid = process.getgroups?.().find((gid) => gid !== process.getgid())
    const gid = altGid ?? process.getgid()
    process.env.BATSHIT_CLAUDE_RUN_AS_UID = String(process.getuid())
    process.env.BATSHIT_CLAUDE_RUN_AS_GID = String(gid)
    // Every managed file is handed over through its open handle (fchown). On macOS a new file
    // takes its folder's group anyway, so the group alone cannot tell the two apart.
    const probe = await open(path.join(fake.home, 'probe.txt'), 'w')
    const handleProto = Object.getPrototypeOf(probe)
    await probe.close()
    const handleChown = vi.spyOn(handleProto, 'chown')
    try {
      mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-1')])
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      await manager.syncAgentClaudeProfiles('josh')

      const { dir, settingsPath, mcpPath, pluginsDir } = manager.getManagedClaudePaths(
        manager.buildClaudeProfileId('agent-1')
      )
      expect(pathChownCalls).toEqual([])
      expect(handleChown.mock.calls).toEqual([
        [process.getuid(), gid],
        [process.getuid(), gid]
      ])
      for (const target of [settingsPath, mcpPath, pluginsDir, dir]) {
        expect((await lstat(target)).gid, target).toBe(gid)
      }
    } finally {
      handleChown.mockRestore()
      delete process.env.BATSHIT_CLAUDE_RUN_AS_UID
      delete process.env.BATSHIT_CLAUDE_RUN_AS_GID
    }
  })

  it('deleting an agent whose linked profile folder holds a linked .claude refuses and unlinks nothing', async () => {
    const profileId = manager.buildClaudeProfileId('victim')
    const elsewhere = path.join(fake.home, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    await symlink(usersClaudeHome, path.join(elsewhere, '.claude'))
    await symlink(elsewhere, path.join(agentsRoot, profileId))

    await expect(manager.deleteAgentClaudeConfig('victim')).rejects.toThrow(/refused/)

    expect((await lstat(path.join(elsewhere, '.claude'))).isSymbolicLink()).toBe(true)
    await expectUsersClaudeHomeWhole()
  })

  it('accepts a real managed home when HOME itself is a symlinked path, with no false refusal', async () => {
    const linkedHome = `${fake.home}-link`
    await symlink(fake.home, linkedHome)
    process.env.HOME = linkedHome
    try {
      const paths = await manager.ensureManagedClaudeHome('batshit_agent_ok', { userId: 'josh', kind: 'agent', id: 'ok' })

      expect(await realpath(paths.dir)).toBe(await realpath(path.join(linkedHome, '.batshit', 'agents', 'batshit_agent_ok', '.claude')))
      expect((await lstat(paths.pluginsDir)).isDirectory()).toBe(true)
    } finally {
      process.env.HOME = fake.home
      await rm(linkedHome, { force: true })
    }
  })
})

describe('ClaudeBridge and the managed Claude home', () => {
  function request(overrides: Record<string, unknown> = {}) {
    return {
      userId: 'josh',
      agentId: 'agent-1',
      model: 'claude-cli/claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Hello' }],
      ...overrides
    } as any
  }

  it('refuses a delegated run without a stored process owner before syncing a profile', async () => {
    const bridge = new bridgeModule.ClaudeBridge()
    const runViaCli = vi.spyOn(bridge as any, 'runViaCli')
    await expect(bridge.streamNativeMode(request({
      agentId: 'subagent_cli_one', delegatedRun: true, processOwner: null
    }))).rejects.toThrow(/owner/i)
    expect(mockRedis.getAgents).not.toHaveBeenCalled()
    expect(runViaCli).not.toHaveBeenCalled()
    await expect(lstat(path.join(agentsRoot, 'batshit_agent_subagent_cli_one'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a delegated process owner from another user before syncing a profile', async () => {
    const bridge = new bridgeModule.ClaudeBridge()
    const runViaCli = vi.spyOn(bridge as any, 'runViaCli')
    await expect(bridge.streamNativeMode(request({
      agentId: 'subagent_cli_one', delegatedRun: true,
      processOwner: { userId: 'other', kind: 'subagent', id: 'one' }
    }))).rejects.toThrow(/owner/i)
    expect(mockRedis.getAgents).not.toHaveBeenCalled()
    expect(runViaCli).not.toHaveBeenCalled()
    await expect(lstat(path.join(agentsRoot, 'batshit_agent_subagent_cli_one'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not launch with stale Claude settings when its own profile sync fails', async () => {
    const profileId = manager.buildClaudeProfileId('agent-1')
    const { settingsPath } = manager.getManagedClaudePaths(profileId)
    await mkdir(path.dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, '{"old":true}')
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-1'), claudeAgent('agent-2')])
    mockRedis.json.get.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') throw new Error('Redis unavailable')
      return { id: 'agent-2', user_id: 'josh' }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = new bridgeModule.ClaudeBridge()
    const runViaCli = vi.spyOn(bridge as any, 'runViaCli')
    await expect(bridge.streamNativeMode(request())).rejects.toMatchObject({
      code: 'MANAGED_PROFILE_RUN_REFUSED'
    })
    expect(runViaCli).not.toHaveBeenCalled()
    expect(spawnCalls).toEqual([])
    expect(await readFile(settingsPath, 'utf8')).toBe('{"old":true}')
    const other = manager.getManagedClaudePaths(manager.buildClaudeProfileId('agent-2'))
    expect(JSON.parse(await readFile(other.settingsPath, 'utf8'))).toHaveProperty('permissions')
  })

  it('refuses a stored profile id of ../.. before any file is written or any flag is built', async () => {
    // Both stored shapes: an agent's `claude_settings.profileId`, and the older
    // `provider_specific_settings.claude_profile_id`.
    for (const stored of [
      { claudeSettings: { permissionMode: 'default', profileId: '../..' } },
      { providerSettings: { claude_profile_id: '../..' } }
    ]) {
      const bridge = new bridgeModule.ClaudeBridge()
      const runViaCli = vi.spyOn(bridge as any, 'runViaCli')

      await expect(bridge.streamNativeMode(request(stored))).rejects.toThrow(/refused/)

      // Refused before the profile sync (it reads the agents first) and before any flag.
      expect(mockRedis.getAgents).not.toHaveBeenCalled()
      expect(runViaCli).not.toHaveBeenCalled()
    }
    expect(spawnCalls).toHaveLength(0)
    await expectUsersClaudeHomeWhole()
  })

  it('refuses a valid profile id whose home is a symlink to ~/.claude before any flag is built', async () => {
    await mkdir(path.join(agentsRoot, 'batshit_agent_victim'), { recursive: true })
    await symlink(usersClaudeHome, path.join(agentsRoot, 'batshit_agent_victim', '.claude'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = new bridgeModule.ClaudeBridge()
    const runViaCli = vi.spyOn(bridge as any, 'runViaCli')

    await expect(
      bridge.streamNativeMode(
        request({ claudeSettings: { permissionMode: 'default', profileId: 'batshit_agent_victim' } })
      )
    ).rejects.toThrow(/refused/)

    expect(runViaCli).not.toHaveBeenCalled()
    expect(spawnCalls).toHaveLength(0)
    await expectUsersClaudeHomeWhole()
  })
})

/* ---------------------------------------------------------------------------------------- *
 * BL-152: every Batshit on the Mac shares `~/.batshit/agents`, and each process's profile sync
 * rewrote every Claude agent's `mcp.json` with ITS OWN helper script paths and app URL, so a
 * run whose file another Batshit rewrote after the run's sync launched the other process's
 * helper, which called the other server. The file now names both by reference, and Claude
 * Code expands them from the run's own environment.
 * ---------------------------------------------------------------------------------------- */

describe('BL-152: Claude helper servers are launched with this process\'s script and URL', () => {
  const LANE_B = { cwd: '/lane-b/batshit-app', url: 'http://127.0.0.1:5999' }
  const LANE_A_URL = 'http://127.0.0.1:5111'

  async function privateEnv() {
    return (await import('$env/dynamic/private')).env as Record<string, string | undefined>
  }

  async function syncAsLaneB() {
    const env = await privateEnv()
    const previousUrl = env.BATSHIT_CLI_HELPER_BASE_URL
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(LANE_B.cwd)
    env.BATSHIT_CLI_HELPER_BASE_URL = LANE_B.url
    try {
      await manager.syncAgentClaudeProfiles('josh')
    } finally {
      cwd.mockRestore()
      env.BATSHIT_CLI_HELPER_BASE_URL = previousUrl
    }
  }

  /** Claude Code's `${VAR}` expansion of an `--mcp-config` file's args, from the run's env. */
  function launchedArgs(call: (typeof spawnCalls)[number], serverId: string): string[] {
    const server = JSON.parse(call.mcpConfigAtSpawn ?? '{}')?.mcpServers?.[serverId]
    return (server?.args ?? []).map((arg: string) =>
      arg.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
        const value = call.env?.[name]
        if (value === undefined) throw new Error(`Claude Code would find no ${name} for ${serverId}`)
        return value
      })
    )
  }

  afterEach(async () => {
    delete (await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL
  })

  it('two Batshits write the same managed mcp.json, with neither one\'s script path nor URL in it', async () => {
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-1')])
    const { mcpPath } = manager.getManagedClaudePaths(manager.buildClaudeProfileId('agent-1'))
    ;(await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL = LANE_A_URL

    await manager.syncAgentClaudeProfiles('josh')
    const writtenByA = await readFile(mcpPath, 'utf8')
    await syncAsLaneB()
    const writtenByB = await readFile(mcpPath, 'utf8')

    expect(writtenByB).toBe(writtenByA)
    for (const perProcess of [process.cwd(), LANE_A_URL, LANE_B.cwd, LANE_B.url]) {
      expect(writtenByA).not.toContain(perProcess)
    }
    expect(writtenByA).toContain('mode4-controls-mcp.cjs')
  })

  it('a run launches its own helpers even when another Batshit rewrote mcp.json after the run\'s sync', async () => {
    mockRedis.getAgents.mockResolvedValue([claudeAgent('agent-1')])
    ;(await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL = LANE_A_URL
    const { detectClaudeCliStatus } = await import('$lib/server/services/claudeCliStatus')
    vi.mocked(detectClaudeCliStatus).mockImplementationOnce(async () => {
      await syncAsLaneB()
      return { available: true, executable: '/nonexistent/claude', version: '2.1.185', source: 'path' } as any
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = new bridgeModule.ClaudeBridge()

    await expect(
      bridge.streamNativeMode({
        userId: 'josh',
        agentId: 'agent-1',
        model: 'claude-cli/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Hello' }]
      } as any)
    ).rejects.toThrow(/nothing may spawn/)

    expect(spawnCalls).toHaveLength(1)
    const call = spawnCalls[0]!
    const scripts = path.join(process.cwd(), 'scripts')
    expect(launchedArgs(call, 'batshit_helpers')).toEqual([
      path.join(scripts, 'mode4-controls-mcp.cjs'),
      '--agent=agent-1',
      '--user=josh',
      `--url=${LANE_A_URL}`,
      '--runtime=claude'
    ])
    const servers = JSON.parse(call.mcpConfigAtSpawn ?? '{}').mcpServers ?? {}
    const approvalId = Object.keys(servers).find((id) =>
      String(servers[id]?.args?.[0] ?? '').endsWith('claude-permission-mcp.cjs')
    )
    expect(approvalId).toBeTruthy()
    expect(launchedArgs(call, approvalId!)).toEqual([path.join(scripts, 'claude-permission-mcp.cjs')])
  })
})

import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import toml from '@iarna/toml'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'

/**
 * BL-7 review (codex7) — a managed Codex run only ever uses a Batshit-managed home.
 *
 * codex-cli 0.139.0 answers `skills.bundled.enabled=false` by DELETING
 * `CODEX_HOME/skills/.system`, and linking the user's `auth.json` into a folder first
 * removes whatever sits at the link's path. A stored profile id of `../..` made the managed
 * home `~/.batshit/agents/../../.codex` (the user's own `~/.codex`), and an agent folder
 * whose `.codex` is a symlink to `~/.codex` reached it by a valid name. These tests build a
 * throwaway HOME with a fake `~/.codex` (an `auth.json`, a `config.toml`, a bundled skill)
 * and prove every road there is refused and leaves that fake home whole.
 *
 * SAFETY: `node:os`'s `homedir()` is replaced before any module under test loads, and it
 * throws until the throwaway HOME exists. A `process.env.HOME` override is not enough: on
 * the threads pool it never reaches `os.homedir()`, and the old code under test deletes
 * `<HOME>/.codex/auth.json`.
 */

const fake = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!fake.home) {
      throw new Error('codexManagedHome.test: os.homedir() was called before the throwaway HOME existed')
    }
    return fake.home
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})

/* Nothing below may run a real Codex process. */
const spawnCalls = vi.hoisted(() => [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>)
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const spawn = (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    spawnCalls.push({ args, env: options.env ?? {} })
    const child = new EventEmitter() as any
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.exitCode = null
    child.signalCode = null
    child.kill = () => {
      child.killed = true
      return true
    }
    return child
  }
  return {
    ...original,
    spawn,
    default: { ...((original as any).default ?? original), spawn }
  }
})

const statusHomes = vi.hoisted(() => [] as Array<string | null | undefined>)
/** BL-152: runs between the run's own profile sync and its spawn (another Batshit's sync). */
const beforeSpawn = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }))
vi.mock('../codexCliStatus', async (importOriginal) => {
  const original = await importOriginal<typeof import('../codexCliStatus')>()
  return {
    ...original,
    detectCodexCliStatus: async (options: { codexHome?: string | null } = {}) => {
      statusHomes.push(options.codexHome)
      await beforeSpawn.run?.()
      return { available: true, executable: '/nonexistent/codex', version: 'codex-cli 0.139.0' }
    },
    resolveCodexCliExecutable: () => '/nonexistent/codex'
  }
})

const laneStarts = vi.hoisted(
  () => [] as Array<{ env: NodeJS.ProcessEnv; spawnArgs: string[]; configAtStart?: string | null }>
)
vi.mock('../codexAppServerLane', async (importOriginal) => {
  const original = await importOriginal<typeof import('../codexAppServerLane')>()
  const { existsSync, readFileSync } = await import('node:fs')
  return {
    ...original,
    startCodexAppServerRun: (input: any) => {
      // The config.toml Codex would read at this moment, beside the args it is started with.
      const configPath = input.env?.CODEX_HOME ? `${input.env.CODEX_HOME}/config.toml` : null
      laneStarts.push({
        env: input.env,
        spawnArgs: input.spawnArgs,
        configAtStart: configPath && existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
      })
      // This lane stand-in never starts an OS process; release the real admission it received.
      input.hostCommandLease?.abortBeforeSpawn()
      input.onStartupSettled?.()
      return {
        events: (async function* () {})(),
        cleanup: async () => {},
        steer: async () => ({ accepted: false, reason: 'test' })
      }
    }
  }
})

const mockRedis = vi.hoisted(() => ({
  getAgents: vi.fn(async (_userId: string) => [] as any[]),
  getProjectPreferences: vi.fn(async () => null),
  getProjects: vi.fn(async () => []),
  get: vi.fn(async () => null),
  json: {
    // The bridge's pre-spawn owner check and the profile sync's write (BL-745) read RedisJSON
    // directly. These are the persisted agents this managed-home fixture launches or deliberately refuses.
    get: vi.fn(async (key: string) =>
      ['agent:victim', 'agent:agent-1', 'agent:agent-2', 'agent:agent-3', 'agent:Agent.One', 'agent:agent-exec'].includes(key)
        ? { id: key.slice('agent:'.length), user_id: 'josh' }
        : null
    )
  },
  getUserSettings: vi.fn(async () => null),
  execute: vi.fn(async (operation: (client: any) => Promise<any>) =>
    operation({
      json: { get: async () => null },
      sAdd: async () => 1,
      sRem: async () => 1,
      sMembers: async () => [],
      expire: async () => true,
      del: async () => 1
    })
  )
}))
const mockGatewayService = vi.hoisted(() => ({ list: vi.fn(async () => []), update: vi.fn() }))
const mockResolveMCPSelections = vi.hoisted(() => vi.fn())

vi.mock('$env/dynamic/private', () => ({
  env: { BATSHIT_CODEX_PROVIDER_ENABLED: 'true', BATSHIT_CODEX_WORKDIR: '', BATSHIT_TOKEN: '' }
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

type Guard = typeof import('../codexManagedHome')
type ProfileManager = typeof import('../codexProfileManager')
type Bridge = typeof import('../codexBridge')

let guard: Guard
let profileManager: ProfileManager
let bridgeModule: Bridge
let userCodexHome = ''
let agentsRoot = ''
let workDir = ''

const REAL_AUTH = '{"auth":"the user\'s real Codex login"}'
const REAL_CREDENTIALS = '{"credentials":"real"}'
const REAL_CONFIG = 'model = "gpt-5.5"\n'
const BUNDLED_SKILL = '# the Codex app\'s bundled skill\n'

beforeAll(async () => {
  const actualOs = await vi.importActual<typeof import('node:os')>('node:os')
  const tmpRoot = await realpath(actualOs.tmpdir())
  fake.home = await realpath(await mkdtemp(path.join(tmpRoot, 'bl7-managed-home-')))
  // Safety net: the throwaway HOME is a fresh temp folder and never the real one.
  expect(fake.home).not.toBe(actualOs.homedir())
  expect(fake.home.startsWith(tmpRoot + path.sep)).toBe(true)

  vi.resetModules()
  guard = await import('../codexManagedHome')
  profileManager = await import('../codexProfileManager')
  bridgeModule = await import('../codexBridge')

  userCodexHome = path.join(fake.home, '.codex')
  agentsRoot = path.join(fake.home, '.batshit', 'agents')
  workDir = path.join(fake.home, 'work')
  // Safety net: every module under test sees the throwaway HOME, or nothing runs.
  expect(guard.USER_CODEX_HOME).toBe(userCodexHome)
  expect(guard.MANAGED_CODEX_ROOT_DIR).toBe(agentsRoot)
  expect(profileManager.getManagedCodexPaths('batshit_agent_probe').dir).toBe(
    path.join(agentsRoot, 'batshit_agent_probe', '.codex')
  )
})

afterAll(async () => {
  if (fake.home) await rm(fake.home, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.clearAllMocks()
  beforeSpawn.run = null
  for (const entry of await readdir(fake.home)) {
    await rm(path.join(fake.home, entry), { recursive: true, force: true })
  }
  await mkdir(path.join(userCodexHome, 'skills', '.system', 'openai-docs'), { recursive: true })
  await writeFile(path.join(userCodexHome, 'auth.json'), REAL_AUTH)
  await writeFile(path.join(userCodexHome, 'credentials.json'), REAL_CREDENTIALS)
  await writeFile(path.join(userCodexHome, 'config.toml'), REAL_CONFIG)
  await writeFile(path.join(userCodexHome, 'skills', '.system', 'openai-docs', 'SKILL.md'), BUNDLED_SKILL)
  await mkdir(agentsRoot, { recursive: true })
  await mkdir(workDir, { recursive: true })

  spawnCalls.length = 0
  statusHomes.length = 0
  laneStarts.length = 0
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

/** The user's own Codex home is exactly as the test made it. */
async function expectUsersCodexHomeWhole() {
  const auth = path.join(userCodexHome, 'auth.json')
  expect((await lstat(auth)).isFile()).toBe(true)
  expect(await readFile(auth, 'utf8')).toBe(REAL_AUTH)
  const credentials = path.join(userCodexHome, 'credentials.json')
  expect((await lstat(credentials)).isFile()).toBe(true)
  expect(await readFile(credentials, 'utf8')).toBe(REAL_CREDENTIALS)
  expect(await readFile(path.join(userCodexHome, 'config.toml'), 'utf8')).toBe(REAL_CONFIG)
  expect(
    await readFile(path.join(userCodexHome, 'skills', '.system', 'openai-docs', 'SKILL.md'), 'utf8')
  ).toBe(BUNDLED_SKILL)
}

/** An agent folder whose `.codex` is a symlink to the user's own Codex home. */
async function plantSymlinkedHome(profileId: string) {
  await mkdir(path.join(agentsRoot, profileId), { recursive: true })
  const home = path.join(agentsRoot, profileId, '.codex')
  await symlink(userCodexHome, home)
  return home
}

function codexAgent(id: string) {
  return {
    id,
    user_id: 'josh',
    displayName: `Agent ${id}`,
    slug: id,
    agentType: 'cli',
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
    assignedSubagents: []
  }
}

function runOptions(overrides: Record<string, unknown> = {}) {
  return {
    // Private lane tests fake the physical child; a host-owned prepared boundary lets
    // them exercise home/start behavior without inventing a persisted agent credential.
    hostCommandLease: {
      pin: { owner: { userId: 'josh', kind: 'host', id: 'managed-home-test' } },
      markSpawnAttempt: () => {}, complete: () => {}, abortBeforeSpawn: () => {},
      onCleanup: () => {}, observe: () => {}, unresolved: () => {}
    },
    model: 'gpt-5.5',
    permissionMode: 'chat',
    sandboxMode: 'read-only',
    workingDirectory: workDir,
    allowFileEdits: false,
    allowNetwork: false,
    approvalPolicy: 'never',
    webSearchEnabled: false,
    addDirectories: [],
    enableFeatures: [],
    disableFeatures: [],
    configOverrides: [],
    defaultGateways: null,
    profileName: 'batshit_agent_probe',
    profileOwner: { userId: 'josh', kind: 'agent', id: 'agent-1' },
    configScope: 'managed',
    managedConfigHome: null,
    historyPersistence: 'none',
    serviceTier: 'standard',
    unifiedExec: true,
    imagePaths: [],
    sessionId: null,
    developerInstructions: 'Stable Batshit system prompt',
    nativeSkillDisablePaths: [],
    ...overrides
  }
}

const configValues = (args: string[]) =>
  args.flatMap((arg, index) => (arg === '--config' ? [args[index + 1]] : []))

/* ---------------------------------------------------------------------------------------- *
 * The profile id rule.
 * ---------------------------------------------------------------------------------------- */

describe('the managed profile id rule', () => {
  it('accepts every profile id Batshit builds', async () => {
    const {
      buildCliSubagentRuntimeId,
      buildCliWorkerRuntimeId,
      normalizeSubagentSlugValue,
      resolveSubagentSlug
    } = await import('$lib/utils/subagentSlug')
    const { buildAgentProfileId } = profileManager
    const built = [
      // A Primary Agent's own profile (the chat run and the compact worker).
      buildAgentProfileId('agent-1'),
      buildAgentProfileId('josh_main'),
      buildAgentProfileId('Josh Main Agent!'),
      buildAgentProfileId('agent_1726000000000_AbC'),
      buildAgentProfileId('../..'),
      buildAgentProfileId(null),
      // A CLI Subagent's profile.
      buildAgentProfileId(buildCliSubagentRuntimeId(resolveSubagentSlug({ slug: 'research-helper' }))),
      buildAgentProfileId(
        buildCliSubagentRuntimeId(resolveSubagentSlug({ displayName: 'Écrit / Helper ../x' }))
      ),
      // A Worker's profile (one slot per position, scoped to the parent agent; BL-285).
      buildAgentProfileId(
        buildCliWorkerRuntimeId(`worker_${normalizeSubagentSlugValue('Josh-Main', 'agent')}_1`)
      ),
      // The bridge's own fallbacks.
      'batshit_agent_default',
      `batshit_agent_${'agent-123'}`
    ]

    for (const profileId of built) {
      expect(guard.isManagedCodexProfileId(profileId), profileId).toBe(true)
      expect(guard.assertManagedCodexProfileId(profileId)).toBe(profileId)
    }
  })

  it('refuses anything with a separator, a dot, or another shape', () => {
    const refused = [
      '../..',
      '..',
      '/Users/someone/.codex',
      path.join(fake.home, '.codex'),
      'batshit_agent_x/../..',
      'batshit_agent_x/nested',
      'batshit_agent_x\\nested',
      'batshit_agent_../..',
      'batshit_agent_..',
      'batshit_agent_x\\..\\..',
      'batshit_agent_a.b',
      'batshit_agent_',
      'batshit_agent_X',
      'batshit_agent_a b',
      ' batshit_agent_x',
      'batshit_agent_x' + String.fromCharCode(10),
      'batshit_agent_x' + String.fromCharCode(0),
      'other_prefix_x',
      '',
      null,
      undefined,
      42
    ]

    for (const profileId of refused) {
      expect(guard.isManagedCodexProfileId(profileId), String(profileId)).toBe(false)
      expect(() => guard.assertManagedCodexProfileId(profileId)).toThrow(/refused/)
    }
  })
})

/* ---------------------------------------------------------------------------------------- *
 * The positive home check.
 * ---------------------------------------------------------------------------------------- */

describe('isBatshitManagedCodexHome', () => {
  it('is true for a real managed home and false for the user\'s own Codex home', async () => {
    const home = path.join(agentsRoot, 'batshit_agent_ok', '.codex')
    await mkdir(home, { recursive: true })

    expect(await guard.isBatshitManagedCodexHome(home)).toBe(true)
    expect(await guard.isBatshitManagedCodexHome(userCodexHome)).toBe(false)
    await expect(guard.assertBatshitManagedCodexHome(userCodexHome)).rejects.toThrow(/refused/)
  })

  it('is false for an agent folder whose .codex is a symlink to the user\'s own Codex home', async () => {
    const home = await plantSymlinkedHome('batshit_agent_victim')

    expect(await guard.isBatshitManagedCodexHome(home)).toBe(false)
  })

  it('is false when the user\'s own Codex home is itself a symlink to that agent folder', async () => {
    // The other direction: `~/.codex` points INTO Batshit's agents folder, so the managed
    // home and the user's home are one folder with two names.
    const home = path.join(agentsRoot, 'batshit_agent_twin', '.codex')
    await mkdir(home, { recursive: true })
    await rm(userCodexHome, { recursive: true, force: true })
    await symlink(home, userCodexHome)

    expect(await guard.isBatshitManagedCodexHome(home)).toBe(false)
  })

  it('is false for anything that is not <agents>/<profile id>/.codex once resolved', async () => {
    const outside = path.join(fake.home, 'elsewhere')
    await mkdir(path.join(outside, '.codex'), { recursive: true })
    await symlink(outside, path.join(agentsRoot, 'batshit_agent_linked'))
    await mkdir(path.join(agentsRoot, 'batshit_agent_ok', '.codex', 'deeper'), { recursive: true })
    await mkdir(path.join(agentsRoot, 'not_a_profile', '.codex'), { recursive: true })
    await mkdir(path.join(agentsRoot, 'batshit_agent_ok', 'codex'), { recursive: true })
    await mkdir(path.join(agentsRoot, 'batshit_agent_file'), { recursive: true })
    await writeFile(path.join(agentsRoot, 'batshit_agent_file', '.codex'), 'a file, not a folder')

    for (const candidate of [
      path.join(agentsRoot, 'batshit_agent_linked', '.codex'),
      path.join(agentsRoot, 'batshit_agent_file', '.codex'),
      path.join(agentsRoot, 'batshit_agent_ok', '.codex', 'deeper'),
      path.join(agentsRoot, 'not_a_profile', '.codex'),
      path.join(agentsRoot, 'batshit_agent_ok', 'codex'),
      path.join(agentsRoot, 'batshit_agent_missing', '.codex'),
      agentsRoot,
      path.join(agentsRoot, 'batshit_agent_ok', '.codex', '..', '..', '..', '..', '.codex'),
      '',
      null
    ]) {
      expect(await guard.isBatshitManagedCodexHome(candidate), String(candidate)).toBe(false)
    }
  })
})

/* ---------------------------------------------------------------------------------------- *
 * Preparing a managed home never reaches the user's own Codex home.
 * ---------------------------------------------------------------------------------------- */

describe('ensureManagedCodexHome and the user\'s own Codex home', () => {
  it('refuses a stored profile id of ../.. and leaves ~/.codex whole', async () => {
    await expect(
      profileManager.ensureManagedCodexHome({ userId: 'josh', profileId: '../..', owner: { userId: 'josh', kind: 'agent', id: 'agent-1' } })
    ).rejects.toThrow(/refused/)

    await expectUsersCodexHomeWhole()
  })

  it('refuses an absolute path as a profile id and creates nothing for it', async () => {
    const target = path.join(fake.home, 'somewhere')

    await expect(
      profileManager.ensureManagedCodexHome({ userId: 'josh', profileId: target, owner: { userId: 'josh', kind: 'agent', id: 'agent-1' } })
    ).rejects.toThrow(/refused/)

    await expect(stat(path.join(agentsRoot, target))).rejects.toMatchObject({ code: 'ENOENT' })
    await expectUsersCodexHomeWhole()
  })

  it('refuses an agent home that is a symlink to ~/.codex, before any credential link is touched', async () => {
    await plantSymlinkedHome('batshit_agent_victim')
    mockRedis.getAgents.mockResolvedValue([codexAgent('victim')])

    await expect(
      profileManager.ensureManagedCodexHome({ userId: 'josh', profileId: 'batshit_agent_victim', owner: { userId: 'josh', kind: 'agent', id: 'victim' } })
    ).rejects.toThrow(/refused/)

    await expectUsersCodexHomeWhole()
  })

  it('still prepares a real managed home and links the credentials into it', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')

    const home = await profileManager.ensureManagedCodexHome({ userId: 'josh', profileId, owner: { userId: 'josh', kind: 'agent', id: 'agent-1' } })

    expect(home).toBe(path.join(agentsRoot, profileId, '.codex'))
    expect(await readlink(path.join(home!, 'auth.json'))).toBe(path.join(userCodexHome, 'auth.json'))
    expect(await readFile(path.join(home!, 'config.toml'), 'utf8')).toContain('Batshit codex config')
    await expectUsersCodexHomeWhole()
  })

  it('one refused agent home does not stop the other agents\' profiles, and ~/.codex/config.toml is never rewritten', async () => {
    await plantSymlinkedHome(profileManager.buildAgentProfileId('victim'))
    mockRedis.getAgents.mockResolvedValue([codexAgent('victim'), codexAgent('agent-2')])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await profileManager.syncAgentCodexProfiles('josh')

    const other = path.join(agentsRoot, profileManager.buildAgentProfileId('agent-2'), '.codex')
    expect(await readFile(path.join(other, 'config.toml'), 'utf8')).toContain('Batshit codex config')
    expect(error.mock.calls.some((call) => String(call[0]).includes('refused'))).toBe(true)
    await expectUsersCodexHomeWhole()
  })

  it('never removes a credential that IS the source file', async () => {
    // Called on the user's own Codex home, the link path and the source are one file.
    // Before, `lstat` saw a plain file, `rm` deleted the real auth.json, and a symlink to
    // itself took its place.
    await profileManager.ensureCredentialSymlinks(userCodexHome)

    await expectUsersCodexHomeWhole()
  })

  it('leaves a managed home\'s auth.json alone when it is already the same file as the source', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-3')])
    const profileId = profileManager.buildAgentProfileId('agent-3')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    await link(path.join(userCodexHome, 'auth.json'), path.join(home, 'auth.json'))
    const before = await stat(path.join(home, 'auth.json'))

    await profileManager.ensureManagedCodexHome({ userId: 'josh', profileId, owner: { userId: 'josh', kind: 'agent', id: 'agent-3' } })

    const after = await lstat(path.join(home, 'auth.json'))
    expect(after.isFile()).toBe(true)
    expect(after.ino).toBe(before.ino)
    await expectUsersCodexHomeWhole()
  })
})

/* ---------------------------------------------------------------------------------------- *
 * Files inside a managed home are never written, deleted, or read through a symlink.
 *
 * Rule (BL-7 review): Batshit REPLACES a link it finds where one of its own files belongs,
 * and never touches the link's target. Every write is a temp file renamed over the target,
 * and a rename replaces the directory entry (the link) without following it; reads that
 * merge a file's old content open it with O_NOFOLLOW, so a linked file counts as absent.
 * ---------------------------------------------------------------------------------------- */

describe('files inside a managed Codex home and planted symlinks', () => {
  // A real (unmanaged) key, so the marker survives a TOML round trip if it is ever merged.
  const USER_FILE_TEXT = 'user_marker = "USER MARKER: the user\'s own file"\n'

  async function plantUserFile(name = 'config.toml') {
    const dir = path.join(fake.home, 'user-files')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await writeFile(file, USER_FILE_TEXT)
    return file
  }

  it('replaces a symlinked config.toml with its own file, and never writes or reads the file it points at', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    const userFile = await plantUserFile()
    await symlink(userFile, path.join(home, 'config.toml'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await profileManager.syncAgentCodexProfiles('josh')

    expect(await readFile(userFile, 'utf8')).toBe(USER_FILE_TEXT)
    const managed = path.join(home, 'config.toml')
    expect((await lstat(managed)).isFile()).toBe(true)
    const contents = await readFile(managed, 'utf8')
    expect(contents).toContain('Batshit codex config')
    expect(contents).not.toContain('USER MARKER')
    expect(warn.mock.calls.some((call) => String(call[0]).includes('symlink'))).toBe(true)
    await expectUsersCodexHomeWhole()
  })

  it('never copies a legacy config.toml read through a symlinked legacy folder', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const userFile = await plantUserFile()
    await mkdir(path.join(agentsRoot, profileId), { recursive: true })
    await symlink(path.dirname(userFile), path.join(agentsRoot, profileId, 'codex'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await profileManager.syncAgentCodexProfiles('josh')

    expect(await readFile(userFile, 'utf8')).toBe(USER_FILE_TEXT)
    const contents = await readFile(path.join(agentsRoot, profileId, '.codex', 'config.toml'), 'utf8')
    expect(contents).toContain('Batshit codex config')
    expect(contents).not.toContain('USER MARKER')
  })

  it('keeps the permissions of a managed config.toml it rewrites, as an in-place write would', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'config.toml'), '', { mode: 0o600 })

    await profileManager.syncAgentCodexProfiles('josh')

    const entry = await lstat(path.join(home, 'config.toml'))
    expect(entry.mode & 0o777).toBe(0o600)
    expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toContain('Batshit codex config')
  })

  it('replaces every folder Codex writes into that is a symlink, and never touches what it pointed at', async () => {
    // With `skills.bundled.enabled=false`, codex-cli 0.139.0 deletes CODEX_HOME/skills/.system;
    // through a planted `skills` link that delete reached the user's own ~/.codex. The folders
    // are the ones Codex names in its source (sessions, archived_sessions, shell_snapshots,
    // skills) and the ones a live 0.139.0 run made (tmp, .tmp).
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    const names = ['skills', 'sessions', 'archived_sessions', 'shell_snapshots', 'tmp', '.tmp']
    for (const name of names) {
      const usersFolder = path.join(userCodexHome, name)
      await mkdir(usersFolder, { recursive: true })
      await writeFile(path.join(usersFolder, 'users-own.txt'), name)
      await symlink(usersFolder, path.join(home, name))
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await profileManager.ensureManagedCodexHome({ userId: 'josh', profileId, owner: { userId: 'josh', kind: 'agent', id: 'agent-1' } })

    for (const name of names) {
      const entry = await lstat(path.join(home, name))
      expect(entry.isSymbolicLink(), name).toBe(false)
      expect(entry.isDirectory(), name).toBe(true)
      expect(await readFile(path.join(userCodexHome, name, 'users-own.txt'), 'utf8'), name).toBe(name)
    }
    await expectUsersCodexHomeWhole()
  })

  it('replaces a symlinked skills folder in the fallback home too', async () => {
    const home = path.join(agentsRoot, 'batshit_agent_default', '.codex')
    await mkdir(home, { recursive: true })
    await symlink(path.join(userCodexHome, 'skills'), path.join(home, 'skills'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await guard.ensureManagedCodexFallbackHome('batshit_agent_default')).toBe(home)

    const entry = await lstat(path.join(home, 'skills'))
    expect(entry.isSymbolicLink()).toBe(false)
    expect(entry.isDirectory()).toBe(true)
    await expectUsersCodexHomeWhole()
  })

  it('checks a profile folder before making .codex in it', async () => {
    const outside = path.join(fake.home, 'elsewhere')
    await mkdir(outside, { recursive: true })
    await symlink(outside, path.join(agentsRoot, 'batshit_agent_linked'))

    await expect(
      profileManager.ensureManagedCodexHome({ userId: 'josh', profileId: 'batshit_agent_linked', owner: { userId: 'josh', kind: 'agent', id: 'agent-1' } })
    ).rejects.toThrow(/refused/)
    await expect(guard.ensureManagedCodexFallbackHome('batshit_agent_linked')).rejects.toThrow(/refused/)

    expect(await readdir(outside)).toEqual([])
  })

  it('hands ownership the OPEN temp file before the rename, never a path', async () => {
    const home = path.join(agentsRoot, 'batshit_agent_owner', '.codex')
    await mkdir(home, { recursive: true })
    const target = path.join(home, 'owned.txt')
    const seen: Array<{ fd: string; targetExists: boolean }> = []

    await guard.writeFileWithoutLinks(target, 'owned\n', agentsRoot, {
      prepareHandle: async (handle: any) => {
        seen.push({
          fd: typeof handle?.fd,
          targetExists: await lstat(target).then(() => true, () => false)
        })
      }
    } as any)

    expect(seen).toEqual([{ fd: 'number', targetExists: false }])
    expect(await readFile(target, 'utf8')).toBe('owned\n')
  })

  it('removes only the link of a symlinked instructions file, never the file it points at', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    const userFile = await plantUserFile('notes.md')
    await symlink(userFile, path.join(home, 'instructions.md'))

    await profileManager.syncAgentCodexProfiles('josh')

    expect(await readFile(userFile, 'utf8')).toBe(USER_FILE_TEXT)
    await expect(lstat(path.join(home, 'instructions.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads a managed file only when nothing between the agents folder and it is a symlink', async () => {
    const profileId = 'batshit_agent_reader'
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'plain.toml'), 'ok = true\n')
    const userFile = await plantUserFile()
    await symlink(userFile, path.join(home, 'linked.toml'))

    expect(await guard.readFileWithoutLinks(path.join(home, 'plain.toml'), agentsRoot)).toBe('ok = true\n')
    expect(await guard.readFileWithoutLinks(path.join(home, 'missing.toml'), agentsRoot)).toBeNull()
    await expect(guard.readFileWithoutLinks(path.join(home, 'linked.toml'), agentsRoot)).rejects.toMatchObject({
      code: 'MANAGED_FILE_IS_A_LINK'
    })
    // A folder link on the way counts too: the victim's `.codex` points at the user's own.
    await plantSymlinkedHome('batshit_agent_victim')
    await expect(
      guard.readFileWithoutLinks(path.join(agentsRoot, 'batshit_agent_victim', '.codex', 'config.toml'), agentsRoot)
    ).rejects.toMatchObject({ code: 'MANAGED_FILE_IS_A_LINK' })
    // And a write never goes through a linked folder either.
    await expect(
      guard.writeFileWithoutLinks(
        path.join(agentsRoot, 'batshit_agent_victim', '.codex', 'config.toml'),
        'written = true\n',
        agentsRoot
      )
    ).rejects.toMatchObject({ code: 'MANAGED_FILE_IS_A_LINK' })
    await expectUsersCodexHomeWhole()
  })

  // BL-163: O_NOFOLLOW stops a symbolic link, not a hard link. A hard-linked file is the same
  // file under a second name, so a `config.toml` hard-linked to a file outside the home was
  // read, merged into the managed config, and shown in the viewer.
  it('never reads a managed file that has another name on disk (a hard link)', async () => {
    const profileId = 'batshit_agent_reader'
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    const userFile = await plantUserFile()
    await link(userFile, path.join(home, 'hardlinked.toml'))

    await expect(guard.readFileWithoutLinks(path.join(home, 'hardlinked.toml'), agentsRoot)).rejects.toMatchObject({
      code: 'MANAGED_FILE_IS_A_LINK'
    })
    await expect(guard.readManagedCodexHomeFile(path.join(home, 'hardlinked.toml'))).rejects.toMatchObject({
      code: 'MANAGED_FILE_IS_A_LINK'
    })
    expect(await readFile(userFile, 'utf8')).toBe(USER_FILE_TEXT)
  })

  it('rebuilds a hard-linked config.toml from Batshit\'s settings, and never merges or touches the other file', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    const userFile = await plantUserFile()
    await link(userFile, path.join(home, 'config.toml'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await profileManager.syncAgentCodexProfiles('josh')

    expect(await readFile(userFile, 'utf8')).toBe(USER_FILE_TEXT)
    const managed = path.join(home, 'config.toml')
    const contents = await readFile(managed, 'utf8')
    expect(contents).toContain('Batshit codex config')
    expect(contents).not.toContain('USER MARKER')
    // The managed file is its own file again; the other name keeps the user's text.
    expect((await stat(managed)).nlink).toBe(1)
    expect((await stat(userFile)).nlink).toBe(1)
  })

  // BL-291: the log named every refused read "through a symlink", a hard link included.
  it('logs a hard-linked config as a hard link, never as a symlink', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    const userFile = await plantUserFile()
    await link(userFile, path.join(home, 'config.toml'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await profileManager.syncAgentCodexProfiles('josh')

    const refusals = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('Did not read a managed config'))
    expect(refusals.length).toBeGreaterThan(0)
    for (const line of refusals) {
      expect(line).toContain('hard link')
      expect(line).not.toContain('symlink')
    }
  })
})

/* ---------------------------------------------------------------------------------------- *
 * The boot session cleanup only ever deletes inside a Batshit-managed home.
 * ---------------------------------------------------------------------------------------- */

describe('cleanupCodexSessionDirs and homes that are not Batshit-managed', () => {
  it('keeps rollout logs while a recorded command survives in that profile', async () => {
    const { pinHostCommandOwner, prepareHostCommand } = await import('../hostCommandOwnership')
    const { readHostProcessTable } = await import('../hostProcessIdentity')
    const profileId = 'batshit_agent_survivor'
    const sessionsDir = path.join(agentsRoot, profileId, '.codex', 'sessions')
    const rollout = path.join(sessionsDir, 'rollout.jsonl')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(rollout, '{}')
    const pin = pinHostCommandOwner({ userId: 'josh', kind: 'agent', id: 'survivor' }, profileId)
    const lease = await prepareHostCommand(pin, { kind: 'codex', program: '/bin/codex' })
    const self = (await readHostProcessTable()).get(process.pid)
    expect(self).toBeDefined()
    lease.observe([self!])
    let cleanupCalled = false
    lease.onCleanup(async () => {
      cleanupCalled = true
      lease.complete()
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await profileManager.cleanupCodexSessionDirs({ respectPersistence: false })
      expect(await readFile(rollout, 'utf8')).toBe('{}')
      expect(cleanupCalled).toBe(false)
      expect(warn.mock.calls.some(([message]) => String(message).includes('Failed to delete Codex sessions dir'))).toBe(true)
    } finally {
      lease.complete()
    }
  })

  it('cleans a real managed home, and never follows a symlinked .codex or profile folder out of the agents folder', async () => {
    // A real managed home whose history is off: its sessions go, as before.
    const realSessions = path.join(agentsRoot, 'batshit_agent_real', '.codex', 'sessions', '2026')
    await mkdir(realSessions, { recursive: true })
    await writeFile(path.join(realSessions, 'rollout.jsonl'), '{}')
    // The user's own Codex session history, reached through a planted `.codex` symlink.
    const usersSessions = path.join(userCodexHome, 'sessions', '2026')
    await mkdir(usersSessions, { recursive: true })
    await writeFile(path.join(usersSessions, 'rollout.jsonl'), '{"the user\'s own":"history"}')
    await plantSymlinkedHome('batshit_agent_victim')
    // A profile folder that is itself a symlink to a folder outside the agents folder.
    const outside = path.join(fake.home, 'elsewhere', '.codex', 'sessions')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'rollout.jsonl'), '{}')
    await symlink(path.join(fake.home, 'elsewhere'), path.join(agentsRoot, 'batshit_agent_linked'))
    // A profile folder with no `.codex` at all is passed over quietly.
    await mkdir(path.join(agentsRoot, 'batshit_agent_empty'), { recursive: true })
    // A managed home whose config.toml is a link: its history choice cannot be read (Batshit
    // never reads through a link), so its sessions are kept.
    const keptSessions = path.join(agentsRoot, 'batshit_agent_linkedcfg', '.codex', 'sessions')
    await mkdir(keptSessions, { recursive: true })
    await writeFile(path.join(keptSessions, 'rollout.jsonl'), '{}')
    await symlink(path.join(userCodexHome, 'config.toml'), path.join(agentsRoot, 'batshit_agent_linkedcfg', '.codex', 'config.toml'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await profileManager.cleanupCodexSessionDirs({ respectPersistence: true })

    await expect(stat(path.join(agentsRoot, 'batshit_agent_real', '.codex', 'sessions'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(path.join(usersSessions, 'rollout.jsonl'), 'utf8')).toBe('{"the user\'s own":"history"}')
    expect(await readFile(path.join(outside, 'rollout.jsonl'), 'utf8')).toBe('{}')
    expect(await readFile(path.join(keptSessions, 'rollout.jsonl'), 'utf8')).toBe('{}')
    const skipped = warn.mock.calls
      .filter((call) => String(call[0]).includes('not Batshit-managed'))
      .map((call) => (call[1] as { profileId?: string })?.profileId)
      .sort()
    expect(skipped).toEqual(['batshit_agent_linked', 'batshit_agent_victim'])
    expect(warn.mock.calls.some((call) => JSON.stringify(call[1] ?? '').includes('batshit_agent_empty'))).toBe(false)
    await expectUsersCodexHomeWhole()
  })
})

/* ---------------------------------------------------------------------------------------- *
 * The bridge never hands Codex a home that is not Batshit's.
 * ---------------------------------------------------------------------------------------- */

describe('CodexBridge and the managed home check', () => {
  it('refuses a stored profile id of ../.. before anything runs, and ~/.codex stays whole', async () => {
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const bridge = new bridgeModule.CodexBridge()

    await expect(
      bridge.streamNativeMode({
        userId: 'josh',
        agentId: 'agent-1',
        sessionId: 'zbcodexseven-session',
        model: 'codex/codex-cli',
        messages: [{ role: 'user', content: 'Hello' }],
        codexSettings: { ...buildCodexRuntimeSettings(), profileId: '../..' }
      } as any)
    ).rejects.toThrow(/refused/)

    // Refused before the run wrote anything: no session mapping, no permission read, no
    // credential, no home, no Codex.
    expect(mockRedis.execute).not.toHaveBeenCalled()
    expect(mockRedis.get).not.toHaveBeenCalled()
    expect(laneStarts).toHaveLength(0)
    expect(spawnCalls).toHaveLength(0)
    expect(statusHomes).toHaveLength(0)
    await expectUsersCodexHomeWhole()
  })

  it('a refused agent home fails the chat run itself, before its credential is minted', async () => {
    // A valid profile id whose folder is a symlink to ~/.codex: the id rule passes and the
    // home check refuses. The bridge must not log that and carry on to a fallback.
    const profileId = profileManager.buildAgentProfileId('victim')
    await plantSymlinkedHome(profileId)
    mockRedis.getAgents.mockResolvedValue([codexAgent('victim')])
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const bridge = new bridgeModule.CodexBridge()

    await expect(
      bridge.streamNativeMode({
        userId: 'josh',
        agentId: 'victim',
        sessionId: 'zbcodexseven-session',
        model: 'codex/codex-cli',
        messages: [{ role: 'user', content: 'Hello' }],
        codexSettings: { ...buildCodexRuntimeSettings(), profileId }
      } as any)
    ).rejects.toThrow(/refused/)

    expect(mockRedis.get).not.toHaveBeenCalledWith('agent:victim')
    expect(laneStarts).toHaveLength(0)
    await expectUsersCodexHomeWhole()
  })

  it('refuses to start the app server in the user\'s own Codex home', async () => {
    const bridge = new bridgeModule.CodexBridge()

    await expect(
      (bridge as any).runViaAppServer('prompt', runOptions({ managedConfigHome: userCodexHome }))
    ).rejects.toThrow(/refused/)

    expect(laneStarts).toHaveLength(0)
    expect(statusHomes).toHaveLength(0)
    await expectUsersCodexHomeWhole()
  })

  it('refuses to start codex exec in an agent home that is a symlink to ~/.codex', async () => {
    const home = await plantSymlinkedHome('batshit_agent_victim')
    const bridge = new bridgeModule.CodexBridge()

    await expect(
      (bridge as any).runViaCli('prompt', runOptions({ managedConfigHome: home }))
    ).rejects.toThrow(/refused/)

    expect(spawnCalls).toHaveLength(0)
    expect(statusHomes).toHaveLength(0)
    await expectUsersCodexHomeWhole()
  })

  it('a managed run with no prepared home never falls back to a home that is not Batshit\'s', async () => {
    const bridge = new bridgeModule.CodexBridge()

    await expect(
      (bridge as any).createRunner('prompt', runOptions({ profileName: '../..' }))
    ).rejects.toThrow(/refused/)
    // An id that is a path is refused before any folder is made for it.
    const stray = path.join(fake.home, 'stray')
    await expect(
      (bridge as any).createRunner('prompt', runOptions({ profileName: stray }))
    ).rejects.toThrow(/refused/)
    await expect(stat(path.join(agentsRoot, stray))).rejects.toMatchObject({ code: 'ENOENT' })
    // A valid fallback name whose folder is a symlink to ~/.codex is refused, before anything
    // in it is touched: the user's own `tmp` link in ~/.codex must survive.
    await plantSymlinkedHome('batshit_agent_default')
    await mkdir(path.join(fake.home, 'users-tmp'), { recursive: true })
    await symlink(path.join(fake.home, 'users-tmp'), path.join(userCodexHome, 'tmp'))
    await expect(
      (bridge as any).createRunner('prompt', runOptions({ profileName: undefined }))
    ).rejects.toThrow(/refused/)
    expect((await lstat(path.join(userCodexHome, 'tmp'))).isSymbolicLink()).toBe(true)
    await rm(path.join(userCodexHome, 'tmp'))

    expect(laneStarts).toHaveLength(0)
    expect(statusHomes).toHaveLength(0)
    await expectUsersCodexHomeWhole()
  })

  it('a managed run whose fallback home cannot be made fails instead of running in the user\'s CODEX_HOME', async () => {
    // The fallback folder's parent is a FILE, so it cannot be created. Before, the run
    // logged a warning and started with no CODEX_HOME of its own: the user's.
    await writeFile(path.join(agentsRoot, 'batshit_agent_default'), 'not a folder')
    const bridge = new bridgeModule.CodexBridge()

    await expect(
      (bridge as any).createRunner('prompt', runOptions({ profileName: undefined }))
    ).rejects.toThrow(/could not create the managed Codex home/)

    expect(laneStarts).toHaveLength(0)
  })

  it('the compact worker fails loudly for an agent whose home is a symlink to ~/.codex', async () => {
    await plantSymlinkedHome(profileManager.buildAgentProfileId('victim'))
    mockRedis.getAgents.mockResolvedValue([codexAgent('victim')])
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const bridge = new bridgeModule.CodexBridge()

    await expect(
      bridge.generateHiddenText({
        prompt: 'Summarize this transcript.',
        userId: 'josh',
        agentId: 'victim',
        model: 'gpt-5.5',
        codexSettings: buildCodexRuntimeSettings()
      } as any)
    ).rejects.toThrow(/refused/)

    expect(laneStarts).toHaveLength(0)
    await expectUsersCodexHomeWhole()
  })

  it('a Stop while the chat run waits at the start gate ends the reply as a Stop, through its stream', async () => {
    // Live on the dev lane (codex7): a start stopped at the gate THREW out of streamNativeMode,
    // which send-routed treats as a failed send (500 "Failed to send message", no reply
    // stored), where every other Stop ends through the reply's stream (499, interrupted).
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const home = path.join(agentsRoot, profileId, '.codex')
    await mkdir(home, { recursive: true })
    const { acquireCodexHomeStart } = await import('../codexHomeStartGate')
    const releaseOther = await acquireCodexHomeStart(home)
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const stop = new AbortController()
    const bridge = new bridgeModule.CodexBridge()

    try {
      const pending = bridge.streamNativeMode({
        userId: 'josh',
        agentId: 'agent-1',
        model: 'codex/codex-cli',
        messages: [
          { role: 'system', content: 'Stable Batshit system prompt' },
          { role: 'user', content: 'Hello' }
        ],
        codexSettings: { ...buildCodexRuntimeSettings(), profileId },
        abortSignal: stop.signal
      } as any)
      await vi.waitFor(() => expect(statusHomes).toEqual([home]))
      await new Promise((resolve) => setTimeout(resolve, 20))
      stop.abort()

      const result = await pending
      let failure: any = null
      try {
        for await (const chunk of result.fullStream) void chunk
      } catch (error) {
        failure = error
      }
      expect(failure?.name).toBe('AbortError')
      expect(laneStarts).toHaveLength(0)
    } finally {
      releaseOther()
    }
  })

  // BL-156: the chat run's fallback profile id was `batshit_agent_${agentId}`, without the
  // lowercasing and character rule `buildAgentProfileId` applies everywhere else (the profile
  // sync, the compact worker). An agent id with a capital was refused as a chat run, and one
  // with any other outside character named a second home beside the agent's own.
  it('a chat run with no stored profile id uses the same home as the profile sync and the compact worker', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('Agent.One')])
    const expectedHome = path.join(agentsRoot, profileManager.buildAgentProfileId('Agent.One'), '.codex')
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const bridge = new bridgeModule.CodexBridge()

    const result = await bridge.streamNativeMode({
      userId: 'josh',
      agentId: 'Agent.One',
      model: 'codex/codex-cli',
      messages: [
        { role: 'system', content: 'Stable Batshit system prompt' },
        { role: 'user', content: 'Hello' }
      ],
      codexSettings: { ...buildCodexRuntimeSettings(), profileId: undefined }
    } as any)
    for await (const chunk of result.fullStream) void chunk

    await expect(
      bridge.generateHiddenText({ userId: 'josh', agentId: 'Agent.One', model: 'gpt-5.5', prompt: 'Summarize.' } as any)
    ).rejects.toThrow(/empty summary/)

    expect(laneStarts.map((start) => start.env.CODEX_HOME)).toEqual([expectedHome, expectedHome])
  })

  it('a real managed home still starts, with CODEX_HOME and the bundled-skills switch', async () => {
    const home = path.join(agentsRoot, 'batshit_agent_probe', '.codex')
    await mkdir(home, { recursive: true })
    const bridge = new bridgeModule.CodexBridge()

    await (bridge as any).runViaAppServer('prompt', runOptions({ managedConfigHome: home }))

    expect(laneStarts).toHaveLength(1)
    expect(laneStarts[0]!.env.CODEX_HOME).toBe(home)
    expect(configValues(laneStarts[0]!.spawnArgs)).toContain('skills.bundled.enabled=false')
    expect(statusHomes).toEqual([home])
  })
})

describe('BL-342 isolated managed agents root', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each(['BATSHIT_HOME_DIR', 'BATSHIT_AGENT_RUNTIME_ROOT'])('uses %s without admitting the global Codex home', async (key) => {
    const isolated = path.join(fake.home, 'first-run-home')
    vi.stubEnv(key, isolated)
    vi.resetModules()
    const freshGuard = await import('../codexManagedHome')
    expect(freshGuard.MANAGED_CODEX_ROOT_DIR).toBe(path.join(isolated, 'agents'))
    const managed = path.join(isolated, 'agents', 'batshit_agent_probe', '.codex')
    await mkdir(managed, { recursive: true })
    expect(await freshGuard.isBatshitManagedCodexHome(managed)).toBe(true)
    expect(await freshGuard.isBatshitManagedCodexHome(path.join(fake.home, '.codex'))).toBe(false)
  })
})

describe('a HOME reached through a symlink', () => {
  it('accepts a real managed home when HOME itself is a symlinked path, with no false refusal', async () => {
    const realHome = fake.home
    const linkedHome = `${realHome}-link`
    await symlink(realHome, linkedHome)
    fake.home = linkedHome
    try {
      vi.resetModules()
      const freshGuard = await import('../codexManagedHome')
      const freshManager = await import('../codexProfileManager')
      expect(freshGuard.MANAGED_CODEX_ROOT_DIR).toBe(path.join(linkedHome, '.batshit', 'agents'))
      mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
      const profileId = freshManager.buildAgentProfileId('agent-1')

      const home = await freshManager.ensureManagedCodexHome({ userId: 'josh', profileId, owner: { userId: 'josh', kind: 'agent', id: 'agent-1' } })

      expect(home).toBe(path.join(linkedHome, '.batshit', 'agents', profileId, '.codex'))
      expect(await freshGuard.isBatshitManagedCodexHome(home)).toBe(true)
      expect(await readlink(path.join(home!, 'auth.json'))).toBe(path.join(linkedHome, '.codex', 'auth.json'))
      expect(await readFile(path.join(home!, 'config.toml'), 'utf8')).toContain('Batshit codex config')
    } finally {
      fake.home = realHome
      await rm(linkedHome, { force: true })
    }
  })
})

/* ---------------------------------------------------------------------------------------- *
 * BL-152: every Batshit on the Mac shares `~/.batshit/agents`, and each process's profile sync
 * rewrote every Codex agent's `config.toml` with ITS OWN helper script path and app URL. A run
 * whose config another Batshit rewrote between its sync and its start launched the other
 * process's helper and called the other server. The shared file now carries only what is the
 * same for every Batshit, and the run passes its own script and URL.
 * ---------------------------------------------------------------------------------------- */

describe('BL-152: helper servers are launched with this process\'s script and URL', () => {
  const LANE_B = { cwd: '/lane-b/batshit-app', url: 'http://127.0.0.1:5999' }
  const LANE_A_URL = 'http://127.0.0.1:5111'

  async function privateEnv() {
    return (await import('$env/dynamic/private')).env as Record<string, string | undefined>
  }

  /** Another Batshit's profile sync: its own working folder and helper URL. */
  async function syncAsLaneB() {
    const env = await privateEnv()
    const previousUrl = env.BATSHIT_CLI_HELPER_BASE_URL
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(LANE_B.cwd)
    env.BATSHIT_CLI_HELPER_BASE_URL = LANE_B.url
    try {
      await profileManager.syncAgentCodexProfiles('josh')
    } finally {
      cwd.mockRestore()
      env.BATSHIT_CLI_HELPER_BASE_URL = previousUrl
    }
  }

  /** What Codex launches: the file's server args, with this run's `--config …args=` applied. */
  function effectiveServerArgs(start: (typeof laneStarts)[number], serverId: string): string[] {
    const { parse } = toml
    let args = ((parse(start.configAtStart ?? '') as any).mcp_servers?.[serverId]?.args ?? null) as string[] | null
    const prefix = `mcp_servers.${serverId}.args=`
    for (const value of configValues(start.spawnArgs)) {
      if (value.startsWith(prefix)) args = (parse(`v = ${value.slice(prefix.length)}`) as any).v
    }
    return args ?? []
  }

  afterEach(async () => {
    delete (await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL
  })

  it('two Batshits write the same managed config.toml, with neither one\'s script path nor URL in it', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const configPath = path.join(agentsRoot, profileManager.buildAgentProfileId('agent-1'), '.codex', 'config.toml')
    ;(await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL = LANE_A_URL

    await profileManager.syncAgentCodexProfiles('josh')
    const writtenByA = await readFile(configPath, 'utf8')
    await syncAsLaneB()
    const writtenByB = await readFile(configPath, 'utf8')

    expect(writtenByB).toBe(writtenByA)
    for (const perProcess of [process.cwd(), LANE_A_URL, LANE_B.cwd, LANE_B.url]) {
      expect(writtenByA).not.toContain(perProcess)
    }
    expect(writtenByA).toContain('mode4-controls-mcp.cjs')
  })

  it('a run calls its own helper even when another Batshit rewrote the config after the run\'s sync', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    ;(await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL = LANE_A_URL
    beforeSpawn.run = syncAsLaneB
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const bridge = new bridgeModule.CodexBridge()

    const result = await bridge.streamNativeMode({
      userId: 'josh',
      agentId: 'agent-1',
      model: 'codex/codex-cli',
      messages: [
        { role: 'system', content: 'Stable Batshit system prompt' },
        { role: 'user', content: 'Hello' }
      ],
      codexSettings: { ...buildCodexRuntimeSettings(), profileId: undefined }
    } as any)
    for await (const chunk of result.fullStream) void chunk

    expect(laneStarts).toHaveLength(1)
    const scripts = path.join(process.cwd(), 'scripts')
    expect(effectiveServerArgs(laneStarts[0]!, 'batshit_helpers')).toEqual([
      path.join(scripts, 'mode4-controls-mcp.cjs'),
      '--agent=agent-1',
      '--user=josh',
      `--url=${LANE_A_URL}`,
      '--runtime=codex'
    ])
    // Workers are on by default, so the delegation bridge is registered too.
    const subagentServer = Object.keys((toml.parse(laneStarts[0]!.configAtStart ?? '') as any).mcp_servers ?? {})
      .find((id) => id !== 'batshit_helpers')
    expect(subagentServer).toBeTruthy()
    expect(effectiveServerArgs(laneStarts[0]!, subagentServer!)).toEqual([
      path.join(scripts, 'codex-subagent-mcp.cjs'),
      '--agent=agent-1',
      '--user=josh',
      `--url=${LANE_A_URL}`
    ])
  })

  async function runAgentOne(extra: Record<string, unknown> = {}) {
    const { buildCodexRuntimeSettings } = await import('../codexSettings')
    const bridge = new bridgeModule.CodexBridge()
    // A start that fails throws out of `streamNativeMode` (a failed send); a run that started
    // and failed ends through its stream. Either way, the error.
    try {
      const result = await bridge.streamNativeMode({
        userId: 'josh',
        agentId: 'agent-1',
        model: 'codex/codex-cli',
        messages: [
          { role: 'system', content: 'Stable Batshit system prompt' },
          { role: 'user', content: 'Hello' }
        ],
        codexSettings: { ...buildCodexRuntimeSettings(), profileId: undefined },
        ...extra
      } as any)
      for await (const chunk of result.fullStream) void chunk
      return null
    } catch (error) {
      return error
    }
  }

  // BL-754: a failed sync cannot launch from an older config, even when that file still has
  // valid BL-152 helper references.
  it('refuses a run when its profile sync fails instead of launching with the older config', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    ;(await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL = LANE_A_URL
    await profileManager.syncAgentCodexProfiles('josh')
    // This run's own sync fails with something other than a refused home.
    mockRedis.getAgents.mockRejectedValue(new Error('Redis went away'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const failure = await runAgentOne()

    expect(failure).toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    expect(laneStarts).toHaveLength(0)
  })

  // BL-152 review findings 1 and 2: read right before the spawn, from the bytes Codex will read;
  // a config that turns unreadable in the meantime fails the run instead of launching helpers
  // with a literal reference.
  it('reads the helpers right before the spawn, and fails the run loudly when it cannot', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const configPath = path.join(agentsRoot, profileManager.buildAgentProfileId('agent-1'), '.codex', 'config.toml')
    beforeSpawn.run = async () => {
      // After the run's own sync and CLI check: the file gets a second name (BL-163's rule).
      await link(configPath, path.join(fake.home, 'second-name.toml'))
    }

    const failure = await runAgentOne()

    expect(laneStarts).toHaveLength(0)
    expect(String((failure as Error | null)?.message ?? failure)).toMatch(/hard link|did not read/)
    const { countCodexHomeStartsInFlight } = await import('../codexHomeStartGate')
    expect(countCodexHomeStartsInFlight()).toBe(0)
  })

  it('fills the helpers on the exec lane too', async () => {
    // Its own home: the stand-in child never exits, so this start holds its home's gate.
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-exec')])
    ;(await privateEnv()).BATSHIT_CLI_HELPER_BASE_URL = LANE_A_URL
    await profileManager.syncAgentCodexProfiles('josh')
    const home = path.join(agentsRoot, profileManager.buildAgentProfileId('agent-exec'), '.codex')
    const bridge = new bridgeModule.CodexBridge()

    const runner = await (bridge as any).runViaCli('prompt', runOptions({ managedConfigHome: home }))
    await runner.cleanup?.()

    expect(spawnCalls).toHaveLength(1)
    expect(configValues(spawnCalls[0]!.args)).toContain(
      `mcp_servers.batshit_helpers.args=${JSON.stringify([
        path.join(process.cwd(), 'scripts', 'mode4-controls-mcp.cjs'),
        '--agent=agent-exec',
        '--user=josh',
        `--url=${LANE_A_URL}`,
        '--runtime=codex'
      ]).replace(/","/g, '", "')}`
    )
  })

  // `--ignore-user-config` (the compact worker) reads no config file, so it has no helpers,
  // and an override for a server Codex did not load is an invalid table that stops Codex.
  it('passes no helper override to a run that ignores the managed config', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    await profileManager.syncAgentCodexProfiles('josh')
    const home = path.join(agentsRoot, profileManager.buildAgentProfileId('agent-1'), '.codex')
    const bridge = new bridgeModule.CodexBridge()

    await (bridge as any).runViaAppServer('prompt', runOptions({
      managedConfigHome: home,
      configScope: 'global',
      ignoreUserConfig: true,
      profileName: undefined
    }))

    expect(laneStarts).toHaveLength(1)
    expect(configValues(laneStarts[0]!.spawnArgs).some((value) => value.startsWith('mcp_servers.'))).toBe(false)
  })

  it('refuses the run when the managed config cannot be read to set its helpers, never starting them wrong', async () => {
    mockRedis.getAgents.mockResolvedValue([codexAgent('agent-1')])
    const profileId = profileManager.buildAgentProfileId('agent-1')
    const configPath = path.join(agentsRoot, profileId, '.codex', 'config.toml')
    await profileManager.syncAgentCodexProfiles('josh')
    // A second name for the file appears after the sync (BL-163's rule): not Batshit's to read.
    await link(configPath, path.join(fake.home, 'second-name.toml'))

    await expect(profileManager.readManagedCodexHelperLaunchOverrides(path.dirname(configPath))).rejects.toMatchObject({
      code: 'MANAGED_FILE_IS_A_LINK'
    })
  })
})

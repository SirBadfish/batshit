import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'

/**
 * BL-7 review (codex7) — the delete of a managed Claude home never reaches the user's own.
 *
 * A stored `claude_profile_id` was once taken as a folder name unchecked, and an agent folder
 * whose `.claude` (or whose whole folder) is a symlink out of the agents folder reached the
 * user's own `~/.claude` by a valid name: deleting that agent removed the folder it pointed at.
 * SA-139 R5 removed every writer of a managed Claude profile (the CLI Subagent's went last), so
 * what stays is the delete-only core (`deleteAgentClaudeConfig`): a leftover agent, Subagent or
 * Worker slot can still have a folder, and its delete keeps every check below. These tests build
 * a throwaway HOME with a fake `~/.claude`.
 *
 * SAFETY: the Claude manager resolves the user's Claude home from `process.env.HOME` and its
 * agents folder from `os.homedir()`. Both point at the throwaway HOME before any module under
 * test loads, and `os.homedir()` throws until it exists.
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

vi.mock('$env/dynamic/private', () => ({ env: { BATSHIT_TOKEN: '' } }))

type ClaudeProfileManager = typeof import('../claudeProfileManager')

let manager: ClaudeProfileManager
let usersClaudeHome = ''
let agentsRoot = ''
const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  BATSHIT_HOME_DIR: process.env.BATSHIT_HOME_DIR,
  BATSHIT_AGENT_RUNTIME_ROOT: process.env.BATSHIT_AGENT_RUNTIME_ROOT
}

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
  delete process.env.BATSHIT_HOME_DIR
  delete process.env.BATSHIT_AGENT_RUNTIME_ROOT

  vi.resetModules()
  manager = await import('../claudeProfileManager')
  usersClaudeHome = path.join(fake.home, '.claude')
  agentsRoot = path.join(fake.home, '.batshit', 'agents')
  // Safety net: the delete sees the throwaway HOME's agents folder, or nothing runs.
  const { getManagedAgentRootDir } = await import('../batshitHome')
  expect(getManagedAgentRootDir()).toBe(agentsRoot)
})

afterAll(async () => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (fake.home) await rm(fake.home, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.clearAllMocks()
  for (const entry of await readdir(fake.home)) {
    await rm(path.join(fake.home, entry), { recursive: true, force: true })
  }
  await mkdir(path.join(usersClaudeHome, 'plugins', 'mine'), { recursive: true })
  await writeFile(path.join(usersClaudeHome, 'settings.json'), USERS_SETTINGS)
  await writeFile(path.join(usersClaudeHome, 'plugins', 'mine', 'README.md'), USERS_PLUGIN)
  await mkdir(agentsRoot, { recursive: true })
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

describe('deleting a managed Claude home', () => {
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

  it("refuses to delete a managed home that IS the user's own Claude home, by ~/.claude or CLAUDE_CONFIG_DIR", async () => {
    // The other direction: the user's Claude home points INTO the agents folder, so the managed
    // home and the user's home are one folder with two names, and its delete would take theirs.
    const twin = path.join(agentsRoot, manager.buildClaudeProfileId('twin'), '.claude')
    await mkdir(twin, { recursive: true })
    await writeFile(path.join(twin, 'settings.json'), USERS_SETTINGS)
    await rm(usersClaudeHome, { recursive: true, force: true })
    await symlink(twin, usersClaudeHome)
    await expect(manager.deleteAgentClaudeConfig('twin')).rejects.toThrow(/your own Claude home/)
    expect(await readFile(path.join(twin, 'settings.json'), 'utf8')).toBe(USERS_SETTINGS)

    await rm(usersClaudeHome)
    const configured = path.join(agentsRoot, manager.buildClaudeProfileId('configured'), '.claude')
    await mkdir(configured, { recursive: true })
    await writeFile(path.join(configured, 'settings.json'), USERS_SETTINGS)
    process.env.CLAUDE_CONFIG_DIR = configured
    try {
      await expect(manager.deleteAgentClaudeConfig('configured')).rejects.toThrow(/your own Claude home/)
      expect(await readFile(path.join(configured, 'settings.json'), 'utf8')).toBe(USERS_SETTINGS)
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
    }
  })

  it('deletes a real managed home when HOME itself is a symlinked path, with no false refusal', async () => {
    const realProfile = manager.buildClaudeProfileId('agent-ok')
    await mkdir(path.join(agentsRoot, realProfile, '.claude', 'plugins'), { recursive: true })
    const realHome = fake.home
    const linkedHome = `${realHome}-link`
    await symlink(realHome, linkedHome)
    fake.home = linkedHome
    process.env.HOME = linkedHome
    try {
      await manager.deleteAgentClaudeConfig('agent-ok')

      await expect(stat(path.join(realHome, '.batshit', 'agents', realProfile, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      fake.home = realHome
      process.env.HOME = realHome
      await rm(linkedHome, { force: true })
    }
    await expectUsersClaudeHomeWhole()
  })
})

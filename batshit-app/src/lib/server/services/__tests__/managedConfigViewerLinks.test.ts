import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'

/**
 * BL-7 review (codex7) — the managed-config viewers never show a file through a symlink.
 *
 * `GET /api/agents/[id]/managed-config` and `GET /api/subagents/[id]/managed-config` show an
 * agent's managed `config.toml` (Codex) or `settings.json` (Claude). A link planted in the
 * managed home (the file itself, or the home folder) made them read and return whatever the
 * link pointed at, such as the user's own config. The profile sync/prepare that normally runs
 * first is stubbed here, so the planted link is still there when the viewer reads.
 *
 * SAFETY: `os.homedir()` and `process.env.HOME` both point at a throwaway HOME, and
 * `os.homedir()` throws until it exists.
 */

const fake = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!fake.home) {
      throw new Error('managedConfigViewerLinks.test: os.homedir() was called before the throwaway HOME existed')
    }
    return fake.home
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})

const SUBAGENT = vi.hoisted(() => ({
  id: 'sub-1',
  user_id: 'josh',
  displayName: 'Viewer probe',
  slug: 'viewer-probe',
  subagentType: 'cli',
  created_at: '2026-09-22T00:00:00.000Z',
  updated_at: '2026-09-22T00:00:00.000Z'
}))
const mockRedis = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => (key === 'agent:agent-1' ? { id: 'agent-1', user_id: 'josh' } : null)),
  json: { get: vi.fn(async (key: string) => (key === 'subagent:sub-1' ? { ...SUBAGENT } : null)) },
  getAgents: vi.fn(async () => []),
  getUserSettings: vi.fn(async () => null),
  getProjectPreferences: vi.fn(async () => null),
  getProjects: vi.fn(async () => [])
}))

vi.mock('$env/dynamic/private', () => ({
  env: { BATSHIT_CODEX_PROVIDER_ENABLED: 'true', BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true', BATSHIT_TOKEN: '' }
}))
vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: { list: vi.fn(async () => []), update: vi.fn() }
}))
vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: vi.fn(async () => null), store: vi.fn() }
}))
vi.mock('$lib/server/services/codexProfileManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/codexProfileManager')>()),
  syncAgentCodexProfiles: vi.fn(async () => {}),
  prepareManagedCodexSubagentProfile: vi.fn(async () => ({}))
}))
vi.mock('$lib/server/services/claudeProfileManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/claudeProfileManager')>()),
  syncAgentClaudeProfiles: vi.fn(async () => ({})),
  prepareManagedClaudeSubagentProfile: vi.fn(async () => ({}))
}))

type Route = { GET: (event: any) => Promise<Response> }

let agentRoute: Route
let subagentRoute: Route
let agentsRoot = ''
let userFiles = ''
let codexProfileId = ''
let subagentProfileId = ''
const originalHome = process.env.HOME
const USER_TEXT = 'USER MARKER: the user\'s own file'

beforeAll(async () => {
  const actualOs = await vi.importActual<typeof import('node:os')>('node:os')
  const tmpRoot = await realpath(actualOs.tmpdir())
  fake.home = await realpath(await mkdtemp(path.join(tmpRoot, 'bl7-viewer-home-')))
  expect(fake.home).not.toBe(actualOs.homedir())
  process.env.HOME = fake.home

  vi.resetModules()
  agentRoute = (await import('../../../../routes/api/agents/[id]/managed-config/+server')) as unknown as Route
  subagentRoute = (await import('../../../../routes/api/subagents/[id]/managed-config/+server')) as unknown as Route
  const { buildAgentProfileId, getManagedCodexPaths } = await import('$lib/server/services/codexProfileManager')
  const { buildCliSubagentRuntimeId, resolveSubagentSlug } = await import('$lib/utils/subagentSlug')
  agentsRoot = path.join(fake.home, '.batshit', 'agents')
  codexProfileId = buildAgentProfileId('agent-1')
  subagentProfileId = buildAgentProfileId(buildCliSubagentRuntimeId(resolveSubagentSlug(SUBAGENT)))
  // Safety net: the managers see the throwaway HOME, or nothing runs.
  expect(getManagedCodexPaths(codexProfileId).dir.startsWith(agentsRoot + path.sep)).toBe(true)
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (fake.home) await rm(fake.home, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const entry of await readdir(fake.home)) {
    await rm(path.join(fake.home, entry), { recursive: true, force: true })
  }
  userFiles = path.join(fake.home, 'user-files')
  await mkdir(userFiles, { recursive: true })
  await writeFile(path.join(userFiles, 'config.toml'), `# ${USER_TEXT}\n`)
  await writeFile(path.join(userFiles, 'settings.json'), JSON.stringify({ note: USER_TEXT }))
  await mkdir(path.join(fake.home, '.codex'), { recursive: true })
  await writeFile(path.join(fake.home, '.codex', 'config.toml'), `# ${USER_TEXT}\n`)
})

async function view(route: Route, id: string, provider: 'codex' | 'claude') {
  const response = await route.GET({
    params: { id },
    locals: { user: { id: 'josh' } },
    url: new URL(`http://127.0.0.1/api/x/${id}/managed-config?provider=${provider}`)
  })
  return { status: response.status, body: await response.json() }
}

async function linkFile(profileId: string, dirName: '.codex' | '.claude', name: string, target: string) {
  const home = path.join(agentsRoot, profileId, dirName)
  await mkdir(home, { recursive: true })
  await symlink(target, path.join(home, name))
}

describe('the managed-config viewers and planted symlinks', () => {
  it('shows a managed file that is a plain file inside its managed home', async () => {
    const home = path.join(agentsRoot, codexProfileId, '.codex')
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'config.toml'), '# Batshit codex config\n')

    const { status, body } = await view(agentRoute, 'agent-1', 'codex')

    expect(status).toBe(200)
    expect(body.contents).toBe('# Batshit codex config\n')
  })

  it('refuses a symlinked file in every viewer, and never returns what it points at', async () => {
    await linkFile(codexProfileId, '.codex', 'config.toml', path.join(userFiles, 'config.toml'))
    await linkFile(buildClaudeId(), '.claude', 'settings.json', path.join(userFiles, 'settings.json'))
    await linkFile(subagentProfileId, '.codex', 'config.toml', path.join(userFiles, 'config.toml'))
    await linkFile(subagentProfileId, '.claude', 'settings.json', path.join(userFiles, 'settings.json'))

    for (const [route, id, provider] of [
      [agentRoute, 'agent-1', 'codex'],
      [agentRoute, 'agent-1', 'claude'],
      [subagentRoute, 'sub-1', 'codex'],
      [subagentRoute, 'sub-1', 'claude']
    ] as const) {
      const { status, body } = await view(route, id, provider)
      const label = `${id} ${provider}`
      expect(status, label).toBe(409)
      expect(String(body.error), label).toMatch(/link/)
      expect(JSON.stringify(body), label).not.toContain('USER MARKER')
    }
  })

  it("refuses a managed home that IS the user's own Codex home (the user's ~/.codex links into it)", async () => {
    const home = path.join(agentsRoot, codexProfileId, '.codex')
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'config.toml'), `# ${USER_TEXT}\n`)
    await rm(path.join(fake.home, '.codex'), { recursive: true, force: true })
    await symlink(home, path.join(fake.home, '.codex'))

    const { status, body } = await view(agentRoute, 'agent-1', 'codex')

    expect(status).toBe(409)
    expect(JSON.stringify(body)).not.toContain('USER MARKER')
  })

  it("refuses a managed home folder that is a symlink to the user's own Codex home", async () => {
    await mkdir(path.join(agentsRoot, codexProfileId), { recursive: true })
    await symlink(path.join(fake.home, '.codex'), path.join(agentsRoot, codexProfileId, '.codex'))

    const { status, body } = await view(agentRoute, 'agent-1', 'codex')

    expect(status).toBe(409)
    expect(JSON.stringify(body)).not.toContain('USER MARKER')
  })
})

function buildClaudeId() {
  // The Claude lane builds its profile ids with the same builder.
  return codexProfileId
}

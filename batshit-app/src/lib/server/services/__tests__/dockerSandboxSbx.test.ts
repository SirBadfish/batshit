import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import {
  SBX_ABANDONED_AFTER_MS,
  buildSbxSandboxName,
  buildSbxSessionMarker,
  classifySbxFailure,
  describeSbxFailure,
  isAbandonedSbxSandbox,
  isReusableSbxSandbox,
  parseSbxSandboxList,
  sbxCommandEndArgs,
  sbxCreateArgs,
  sbxDenyAllNetworkArgs,
  sbxExecArgs,
  sbxSandboxHasWorkspace,
  toSbxSandboxPath,
  type SbxSandboxEntry
} from '../dockerSandboxSbx'
import { sandboxCommandEndArgv } from '../commandEnd'

// Output captured from sbx v0.43.0 on 2026-09-18.
const REAL_LIST = `{
  "sandboxes": [
    {
      "name": "sbx1-probe-shell",
      "id": "24c9af98-9b76-460f-b47e-4af61fce97c5",
      "agent": "shell",
      "status": "running",
      "last_used_at": "2026-09-18T08:55:17.75025Z",
      "workspaces": [
        "/private/tmp/sbx-ws"
      ]
    }
  ]
}`

// The Windows build when the call started sbx's daemon (docker/sbx-releases#201).
const WINDOWS_LIST_AFTER_DAEMON_START = `Starting sandboxd daemon...
Daemon started (PID: 55276, socket: \\\\.\\pipe\\docker_kaname_sandboxd)
Logs: C:\\Users\\user\\AppData\\Local\\DockerSandboxes\\sandboxes\\state\\sandboxd\\daemon.log
{
  "sandboxes": [
    {
      "name": "copilot-test",
      "agent": "copilot",
      "status": "stopped",
      "workspaces": [
        "C:\\\\Users\\\\user\\\\Git\\\\copilot-test"
      ]
    }
  ]
}`

const entry = (overrides: Partial<SbxSandboxEntry> = {}): SbxSandboxEntry => ({
  name: 'batshit-josh-s12345678-abcdef0123',
  status: 'running',
  workspaces: ['/Users/example/project'],
  lastUsedAt: '2026-09-18T08:00:00.000Z',
  ...overrides
})

describe('dockerSandboxSbx', () => {
  it('reads the sandbox list sbx prints, and an empty one', () => {
    expect(parseSbxSandboxList(REAL_LIST)).toEqual([
      {
        name: 'sbx1-probe-shell',
        status: 'running',
        workspaces: ['/private/tmp/sbx-ws'],
        lastUsedAt: '2026-09-18T08:55:17.75025Z'
      }
    ])
    expect(parseSbxSandboxList('{\n  "sandboxes": []\n}')).toEqual([])
  })

  it('reads the list after the daemon-start lines the Windows build prints to stdout', () => {
    expect(parseSbxSandboxList(WINDOWS_LIST_AFTER_DAEMON_START)).toEqual([
      {
        name: 'copilot-test',
        status: 'stopped',
        workspaces: ['C:\\Users\\user\\Git\\copilot-test'],
        lastUsedAt: null
      }
    ])
  })

  it('refuses list output it cannot read instead of treating it as no sandboxes', () => {
    expect(() => parseSbxSandboxList('SANDBOX   AGENT   STATUS')).toThrow('printed no JSON')
    expect(() => parseSbxSandboxList('Starting sandboxd daemon...')).toThrow('printed no JSON')
    expect(() => parseSbxSandboxList('{"items": []}')).toThrow('sandboxes list')
  })

  it('builds names sbx accepts: no underscores, same session marker as before', () => {
    const name = buildSbxSandboxName({
      userId: 'Josh_Alt.',
      workspaceRoot: '/Users/example/project',
      sessionId: 'session_1'
    })
    expect(name).toMatch(/^batshit-josh-alt-s[0-9a-f]{8}-m4-[0-9a-f]{10}$/)
    expect(name).toContain(buildSbxSessionMarker('session_1'))
    const oldHash = createHash('sha256').update('/Users/example/project').digest('hex').slice(0, 10)
    expect(name.endsWith(oldHash)).toBe(false)
    const previousMountHash = createHash('sha256').update('managed-mounts-v2:/Users/example/project').digest('hex').slice(0, 10)
    expect(name.endsWith(previousMountHash)).toBe(false)
    // BL-1277: an m3 VM may have been made for a folder that is protected now; m4 never reuses one.
    const m3Hash = createHash('sha256').update('managed-mounts-v3:/Users/example/project').digest('hex').slice(0, 10)
    expect(name.endsWith(m3Hash)).toBe(false)
    expect(buildSbxSandboxName({ userId: '__', workspaceRoot: '/w' })).toMatch(/^batshit-user-m4-[0-9a-f]{10}$/)
  })

  it('names agree with the Docker host operator, so both lanes leave the same m3 sandboxes behind (BL-1277)', () => {
    // The operator's twin (plain JavaScript beside the app, loaded by Node).
    const operatorCli = createRequire(import.meta.url)(path.resolve(process.cwd(), '../tools/docker/sbx-cli.mjs')) as {
      buildSbxSandboxName: (options: { userId?: string; workspaceRoot: string; sessionId?: string }) => string
    }
    for (const options of [
      { userId: 'josh', workspaceRoot: '/Users/example/project' },
      { userId: 'Josh_Alt.', workspaceRoot: '/w', sessionId: 'session_1' },
      { userId: '', workspaceRoot: path.join(os.homedir(), '.batshit', 'workspaces') }
    ]) {
      const name = buildSbxSandboxName(options)
      expect(name).toContain('-m4-')
      expect(operatorCli.buildSbxSandboxName(options)).toBe(name)
    }
  })

  it('creates a plain shell sandbox with all network denied from the start', () => {
    expect(
      sbxCreateArgs({
        sandboxName: 'batshit-josh-abc',
        workspaceRoot: '/Users/example/project',
        extraWorkspaces: ['/Users/example/.batshit']
      })
    ).toEqual([
      'create',
      '--name',
      'batshit-josh-abc',
      '--deny-network',
      '**',
      'shell',
      '/Users/example/project',
      '/Users/example/.batshit/installs',
      '/Users/example/.batshit/tools',
      '/Users/example/.batshit/skills',
      '/Users/example/.batshit/portable-skills',
      '/Users/example/.batshit/voice-profiles',
      '/Users/example/.batshit/workspaces',
      '/Users/example/.batshit/ab-profile'
    ])
  })

  it.each(['runtime', 'pinokio', 'pinokio.admission'])('refuses protected %s as a direct workspace or extra mount', (name) => {
    const home = path.join(os.homedir(), '.batshit')
    for (const root of [path.join(home, name), path.join(home, name, 'nested')]) {
      expect(() => sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot: root })).toThrow(/protected runtime/)
      expect(() => sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot: '/w', extraWorkspaces: [root] })).toThrow(/protected runtime/)
    }
  })

  it('keeps ordinary mounts permitted beside the protected admission folder (BL-1277)', () => {
    const home = path.join(os.homedir(), '.batshit')
    for (const root of [path.join(home, 'workspaces', 'project'), path.join(home, 'pinokio.admission-notes'), path.join(home, 'pinokio-notes')]) {
      expect(sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot: '/w', extraWorkspaces: [root] })).toContain(root)
    }
  })

  it('refuses a workspace that exposes managed agent homes', () => {
    expect(() => sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot: '/Users/example', extraWorkspaces: ['/Users/example/.batshit'] })).toThrow(/managed agent homes/)
    expect(() => sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot: '/w', extraWorkspaces: ['/Users/example/.batshit/agents'] })).toThrow(/managed agent homes/)
  })

  it.each(['agents', 'runtime', 'pinokio', 'pinokio.admission'])('refuses a workspace alias that resolves into protected %s', async (protectedName) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-sbx-mount-test-'))
    try {
      const home = path.join(root, '.batshit')
      const agents = path.join(home, protectedName)
      await mkdir(agents, { recursive: true })
      const alias = path.join(root, 'workspace-alias')
      await symlink(agents, alias)
      expect(() => sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot: alias, extraWorkspaces: [home] })).toThrow(/managed agent homes/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an agents root under a configured home with any folder name', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'batshit-custom-home-'))
    const home = path.join(temp, 'first-run-home')
    vi.stubEnv('BATSHIT_HOME_DIR', home)
    try {
      await mkdir(path.join(home, 'agents'), { recursive: true })
      const alias = path.join(temp, 'alias')
      await symlink(path.join(home, 'agents'), alias)
      for (const workspaceRoot of [home, path.join(home, 'agents'), alias]) {
        expect(() => sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot })).toThrow(/managed agent homes/)
      }
    } finally {
      vi.unstubAllEnvs()
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('scopes the deny-all rule to one sandbox with --sandbox', () => {
    expect(sbxDenyAllNetworkArgs('batshit-josh-abc')).toEqual([
      'policy',
      'deny',
      'network',
      '--sandbox',
      'batshit-josh-abc',
      '**'
    ])
  })

  it('runs a command through bash in the given folder with only valid env entries, and its tag', () => {
    expect(
      sbxExecArgs({
        sandboxName: 'batshit-josh-abc',
        cwd: '/Users/example/project/src',
        env: { A: 'one', '': 'skipped', BATSHIT_COMMAND_ID: 'forged' },
        command: 'git status',
        tag: 'tag-1'
      })
    ).toEqual([
      'exec',
      '--workdir',
      '/Users/example/project/src',
      '--env',
      'A=one',
      // Last, so a caller's env cannot replace it: a Stop or timeout ends what carries it.
      '--env',
      'BATSHIT_COMMAND_ID=tag-1',
      'batshit-josh-abc',
      '/bin/bash',
      '-lc',
      'git status'
    ])
  })

  it('ends a stopped or timed-out command with one short command in the same sandbox', () => {
    expect(sbxCommandEndArgs({ sandboxName: 'batshit-josh-abc', tag: 'tag-1' })).toEqual([
      'exec',
      'batshit-josh-abc',
      ...sandboxCommandEndArgv('tag-1')
    ])
  })

  it('finds a Windows folder where sbx mounts it inside the sandbox: /<drive>/…', () => {
    expect(toSbxSandboxPath('C:\\Users\\me\\work')).toBe('/c/Users/me/work')
    // Seen inside a real sandbox in docker/sbx-releases#449.
    expect(toSbxSandboxPath('C:\\c\\Users\\aua\\Documents\\repos')).toBe('/c/c/Users/aua/Documents/repos')
    expect(toSbxSandboxPath('D:/data/ws/')).toBe('/d/data/ws')
    expect(toSbxSandboxPath('C:\\')).toBe('/c')
    expect(toSbxSandboxPath('/Users/example/project')).toBe('/Users/example/project')
    expect(toSbxSandboxPath('C:relative')).toBe('C:relative')
    expect(
      sbxExecArgs({ sandboxName: 'batshit-x', cwd: 'C:\\Users\\me\\work\\src', command: 'pwd', tag: 't' }).slice(0, 3)
    ).toEqual(['exec', '--workdir', '/c/Users/me/work/src'])
  })

  it('treats a stopped sandbox as idle and reusable, and an unknown state as not', () => {
    expect(isReusableSbxSandbox(entry({ status: 'running' }))).toBe(true)
    expect(isReusableSbxSandbox(entry({ status: 'stopped' }))).toBe(true)
    expect(isReusableSbxSandbox(entry({ status: 'error' }))).toBe(false)
  })

  it('matches the workspace by exact path, because sbx mounts the path it was given', () => {
    expect(sbxSandboxHasWorkspace(entry(), '/Users/example/project')).toBe(true)
    expect(sbxSandboxHasWorkspace(entry(), '/private/Users/example/project')).toBe(false)
  })

  it('matches a Windows workspace whatever its letter case or slashes', () => {
    const windows = entry({ workspaces: ['C:\\Users\\Example\\batshit\\workspace'] })
    expect(sbxSandboxHasWorkspace(windows, 'c:\\users\\example\\batshit\\workspace\\')).toBe(true)
    expect(sbxSandboxHasWorkspace(windows, 'C:/Users/Example/batshit/workspace')).toBe(true)
    expect(sbxSandboxHasWorkspace(windows, 'C:\\Users\\Example\\batshit\\other')).toBe(false)
  })

  it('calls a sandbox abandoned only when it is not running and unused for an hour', () => {
    const now = Date.parse('2026-09-18T12:00:00.000Z')
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
    expect(isAbandonedSbxSandbox(entry({ status: 'stopped', lastUsedAt: minutesAgo(5) }), now)).toBe(false)
    expect(
      isAbandonedSbxSandbox(
        entry({ status: 'stopped', lastUsedAt: minutesAgo(SBX_ABANDONED_AFTER_MS / 60_000 + 1) }),
        now
      )
    ).toBe(true)
    expect(isAbandonedSbxSandbox(entry({ status: 'running', lastUsedAt: minutesAgo(600) }), now)).toBe(false)
    expect(isAbandonedSbxSandbox(entry({ status: 'stopped', lastUsedAt: null }), now)).toBe(true)
  })

  it('names the setup step for each failure sbx reports, keeping sbx’s own words', () => {
    const notSignedIn = 'ERROR: Not authenticated to Docker\n\nSign in with: sbx login'
    const noPreset =
      'ERROR: global network policy has not been initialized\n\nInitialize it with:\n  sbx policy init <allow-all|balanced|deny-all>'
    expect(classifySbxFailure(notSignedIn)).toBe('not_signed_in')
    expect(classifySbxFailure(noPreset)).toBe('network_policy_not_initialized')
    expect(classifySbxFailure('sbx is not installed (spawn sbx ENOENT).')).toBe('not_installed')
    expect(classifySbxFailure('ERROR: request failed: 409 Conflict: sandbox "x" already exists')).toBe(
      'already_exists'
    )
    expect(classifySbxFailure("ERROR: sandbox 'x' not found")).toBe('not_found')

    expect(describeSbxFailure(notSignedIn, 'fallback')).toBe(
      'Docker Sandbox is not signed in. Run `sbx login` on this computer (a free Docker account works), then try again. (sbx: ERROR: Not authenticated to Docker)'
    )
    expect(describeSbxFailure(noPreset, 'fallback')).toContain('Run `sbx policy init balanced`')
    expect(describeSbxFailure('sbx is not installed (spawn sbx ENOENT).', 'fallback')).toContain(
      'brew install docker/tap/sbx'
    )
    expect(describeSbxFailure('ERROR: something new', 'fallback')).toBe('ERROR: something new')
    expect(describeSbxFailure('', 'Creating failed.')).toBe('Creating failed.')
  })
})

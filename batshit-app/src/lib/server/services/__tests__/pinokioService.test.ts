// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  __setPinokioDepsForTests,
  classifyPtermFailure,
  detectPinokio,
  getPinokioAppLogs,
  getPinokioAppStatus,
  parsePinokioAppStatus,
  parsePinokioLogs,
  parsePinokioSearch,
  parsePtermJson,
  parsePtermVersion,
  parseScriptRequires,
  pinokioAppIdProblem,
  pinokioVersionAtLeast,
  ptermChildEnv,
  realPinokioDepsForTests,
  searchPinokioApps,
  startPinokioApp,
  stripAnsi,
  type PinokioDeps,
  type PinokioSpawnedRun,
  type PtermResult
} from '../pinokioService'

/**
 * SA-072 P1. The parser is held to every real `pterm` 0.0.25 answer P0 captured on Pinokio 8.2.0
 * (DL-11); the service to the P1 run rules, through fake file-system, socket, and process seams;
 * and the real process plumbing to its two promises: a secret-free environment and SIGKILL only.
 */

const FIXTURE_DIR = fileURLToPath(new URL('../../tests/fixtures/pinokio/', import.meta.url))

type Fixture = PtermResult & { case: string; argv: string[] }

function fixture(name: string): Fixture {
  const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'))
  return {
    case: raw.case,
    argv: raw.argv,
    exitCode: raw.exitCode,
    signal: raw.signal,
    stdout: raw.stdout,
    stderr: raw.stderr,
    timedOut: raw.timedOut,
    durationMs: raw.durationMs
  }
}

describe('the pterm parser against every P0 fixture (DL-11)', () => {
  const expectations: Record<string, (result: Fixture) => void> = {
    'home': (result) => {
      // A bare path is not JSON: the service always asks for --json, and a non-JSON answer is refused.
      const parsed = parsePtermJson(result)
      expect(parsed).toMatchObject({ ok: false, kind: 'error' })
    },
    'home-json': (result) => {
      expect(parsePtermJson(result)).toEqual({ ok: true, value: { path: '/Users/tester/pinokio' } })
    },
    'logs-before-run': (result) => {
      const json = parsePtermJson(result)
      expect(json.ok).toBe(true)
      if (!json.ok) return
      const logs = parsePinokioLogs(json.value)
      expect(logs).toMatchObject({ ok: true, value: { appId: 'comfy.git' } })
    },
    'logs-tail-50': (result) => {
      const json = parsePtermJson(result)
      expect(json.ok).toBe(true)
      if (!json.ok) return
      const logs = parsePinokioLogs(json.value)
      expect(logs.ok).toBe(true)
      if (!logs.ok) return
      expect(logs.value).toMatchObject({ appId: 'comfy.git', script: 'start.js', lineCount: 80 })
      expect(logs.value.lines).toHaveLength(50)
      expect(logs.value.lines.join('\n')).toContain('To see the GUI go to: http://127.0.0.1:8188')
    },
    'offline-home-json': (result) => {
      expect(parsePtermJson(result)).toMatchObject({ ok: false, kind: 'unavailable', reason: 'not_running' })
    },
    'offline-status': (result) => {
      const parsed = parsePtermJson(result)
      expect(parsed).toMatchObject({ ok: false, kind: 'unavailable', reason: 'not_running' })
      // The 17 KB AxiosError dump never reaches the agent.
      if (!parsed.ok) expect(parsed.message).toBe('Pinokio is installed but not running. Open Pinokio, then try again.')
    },
    'offline-version-pinokio': (result) => {
      expect(result.exitCode).toBe(0)
      expect(parsePtermVersion(result.stdout, 'pinokio')).toBeNull()
    },
    'run-already-online': (result) => {
      expect(stripAnsi(result.stdout)).toContain('http://localhost:8188')
    },
    'run-foreground': (result) => {
      const clean = stripAnsi(result.stdout)
      expect(result.stdout).toContain('\u001b[32m')
      expect(clean).not.toContain('\u001b')
      expect(clean).toContain('[INFO]')
    },
    'search-comfyui': (result) => {
      const json = parsePtermJson(result)
      expect(json.ok).toBe(true)
      if (!json.ok) return
      const search = parsePinokioSearch(json.value)
      expect(search).toMatchObject({
        ok: true,
        value: { query: 'comfyui', skippedRemote: 0, apps: [{ appId: 'comfy.git', title: 'Comfyui', state: 'offline', ready: false }] }
      })
    },
    'search-empty-query': (result) => {
      const json = parsePtermJson(result)
      expect(json.ok).toBe(true)
      if (!json.ok) return
      const search = parsePinokioSearch(json.value)
      expect(search.ok && search.value.apps.map((app) => app.appId)).toEqual(['comfy.git'])
    },
    'search-no-match': (result) => {
      const json = parsePtermJson(result)
      expect(json.ok).toBe(true)
      if (!json.ok) return
      expect(parsePinokioSearch(json.value)).toMatchObject({ ok: true, value: { apps: [], skippedRemote: 0 } })
    },
    'status-offline': (result) => expectStatus(result, { state: 'offline', ready: false, probe: null }),
    // Pinokio does not probe an offline app: --probe still answers probe null (P0 capture).
    'status-offline-probe': (result) => expectStatus(result, { state: 'offline', ready: false, probe: null }),
    'status-offline-by-ref': (result) => expectStatus(result, { state: 'offline', ready: false, probe: null }),
    'status-starting': (result) => expectStatus(result, { state: 'starting', ready: false, probe: null }),
    'status-online': (result) => expectStatus(result, { state: 'online', ready: true, probe: null }),
    'status-online-probe': (result) =>
      expectStatus(result, { state: 'online', ready: true, probe: true, readyUrl: 'http://localhost:8188' }),
    'status-unknown-app': (result) => {
      const parsed = parsePtermJson(result)
      expect(parsed).toMatchObject({ ok: false, kind: 'not_found' })
      if (!parsed.ok) expect(parsed.message).toContain('App not found')
    },
    'version-pinokio': (result) => expect(parsePtermVersion(result.stdout, 'pinokio')).toBe('8.2.0'),
    'version-pinokiod': (result) => expect(parsePtermVersion(result.stdout, 'pinokiod')).toBe('8.2.0'),
    'version-script': (result) => expect(result.stdout.trim()).toBe('8.0.0'),
    'version-terminal': (result) => expect(parsePtermVersion(result.stdout, 'pterm')).toBe('0.0.25'),
    'which-git': (result) => expect(parsePtermJson(result)).toMatchObject({ ok: false, kind: 'error' }),
    'which-git-json': (result) => {
      const parsed = parsePtermJson(result)
      expect(parsed.ok).toBe(true)
    },
    'which-missing': (result) => {
      const parsed = classifyPtermFailure(result)
      expect(parsed).toMatchObject({ ok: false, kind: 'error' })
      if (!parsed.ok) expect(parsed.raw).toContain('command not found: no-such-command-p0')
    }
  }

  function expectStatus(
    result: Fixture,
    expected: { state: string; ready: boolean; probe: boolean | null; readyUrl?: string }
  ) {
    const json = parsePtermJson(result)
    expect(json.ok).toBe(true)
    if (!json.ok) return
    const status = parsePinokioAppStatus(json.value)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value).toMatchObject({ appId: 'comfy.git', title: 'Comfyui', ...expected })
    expect(status.value.path).toBe('/Users/tester/pinokio/api/comfy.git')
  }

  const files = readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort()

  it('has an expectation for every captured fixture, and no more', () => {
    expect(files).toHaveLength(26)
    expect(Object.keys(expectations).sort()).toEqual(files)
  })

  for (const name of files) {
    it(`reads ${name}`, () => {
      const expectation = expectations[name]
      expect(expectation).toBeDefined()
      expectation(fixture(name))
    })
  }

  it('turns an unrecognised JSON shape into a visible error carrying the raw text, never a guess', () => {
    const parsed = parsePinokioAppStatus({ app_id: 'comfy.git', state: 'sleeping', running: false, ready: false })
    expect(parsed).toMatchObject({ ok: false, kind: 'error' })
    if (!parsed.ok) expect(parsed.raw).toContain('sleeping')
    const notJson = parsePtermJson({ exitCode: 0, signal: null, stdout: 'hello', stderr: '', timedOut: false, durationMs: 1 })
    expect(notJson).toMatchObject({ ok: false, kind: 'error', raw: 'hello' })
  })

  it('leaves out apps another Pinokio machine reports (DL-07)', () => {
    const search = parsePinokioSearch({
      q: '',
      apps: [
        { app_id: 'comfy.git', title: 'Comfyui', state: 'online', running: true, ready: true, source: { local: true } },
        { app_id: 'peer.git', title: 'Peer', state: 'online', running: true, ready: true, source: { local: false } }
      ]
    })
    expect(search).toMatchObject({ ok: true, value: { skippedRemote: 1, apps: [{ appId: 'comfy.git' }] } })
  })
})

describe('small rules', () => {
  it('compares versions against the 8.2.0 floor (DL-13)', () => {
    expect(pinokioVersionAtLeast('8.2.0')).toBe(true)
    expect(pinokioVersionAtLeast('8.10.0')).toBe(true)
    expect(pinokioVersionAtLeast('9.0.0')).toBe(true)
    expect(pinokioVersionAtLeast('8.1.9')).toBe(false)
    expect(pinokioVersionAtLeast('7.2.6')).toBe(false)
    expect(pinokioVersionAtLeast('nonsense')).toBe(false)
    expect(pinokioVersionAtLeast(null)).toBe(false)
  })

  it('accepts an installed folder id and refuses URLs, refs, other machines, and paths', () => {
    expect(pinokioAppIdProblem('comfy.git')).toBeNull()
    expect(pinokioAppIdProblem('LightOnOCR-2-1B-Pinokio.git')).toBeNull()
    expect(pinokioAppIdProblem('https://github.com/x/y')).toContain('never installs')
    expect(pinokioAppIdProblem('pinokio://192.168.1.10:42000/api/comfy.git')).toContain('not a URL')
    expect(pinokioAppIdProblem('comfy.git@peer')).toContain('another machine')
    expect(pinokioAppIdProblem('../secrets')).not.toBeNull()
    expect(pinokioAppIdProblem('api/comfy.git')).not.toBeNull()
    expect(pinokioAppIdProblem('.hidden')).not.toBeNull()
    expect(pinokioAppIdProblem('')).not.toBeNull()
  })

  it('reads PINOKIO_SCRIPT_REQUIRES the way Pinokio documents it', () => {
    expect(parseScriptRequires('PINOKIO_SCRIPT_REQUIRES=comfyui.git,ollama\nOTHER=1')).toEqual(['comfyui.git', 'ollama'])
    expect(parseScriptRequires('PINOKIO_SCRIPT_REQUIRES=\nPINOKIO_SCRIPT_AUTOLAUNCH=')).toEqual([])
    expect(parseScriptRequires(null)).toEqual([])
  })

  it('gives pterm only an allowlisted environment: no Batshit token, key, or secret (DL-06)', () => {
    const saved = { ...process.env }
    try {
      process.env.BATSHIT_TOKEN = 'secret-token'
      process.env.ENCRYPTION_KEY = 'secret-key'
      process.env.OPENAI_API_KEY = 'sk-secret'
      process.env.TYPESAFE_API_KEY = 'ts-secret'
      process.env.PATH = '/usr/bin:/bin'
      process.env.HOME = '/Users/tester'
      const env = ptermChildEnv()
      expect(env.PATH).toBe('/usr/bin:/bin')
      expect(env.HOME).toBe('/Users/tester')
      expect(env.NO_COLOR).toBe('1')
      for (const key of Object.keys(env)) {
        expect(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'NO_COLOR', 'FORCE_COLOR']).toContain(key)
      }
      expect(JSON.stringify(env)).not.toMatch(/secret|sk-/)
    } finally {
      process.env = saved
    }
  })
})

/* ------------------------------------------------------------------ *
 * The service, through fake seams
 * ------------------------------------------------------------------ */

const HOME = '/Users/tester/pinokio'
const PTERM = `${HOME}/bin/npm/bin/pterm`

function ok(stdout: string): PtermResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 5 }
}

function statusJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    app_id: 'comfy.git',
    title: 'Comfyui',
    path: `${HOME}/api/comfy.git`,
    state: 'offline',
    running: false,
    ready: false,
    ready_url: null,
    probe: null,
    last_error: null,
    source: { host: '192.168.1.10', local: true },
    ...overrides
  })
}

interface FakeWorld {
  files: Map<string, string>
  reachable: boolean
  calls: string[][]
  kills: number
  spawned: string[][]
  statusSequence: Array<Record<string, unknown>>
  pinokioVersion: string
  runExitsEarly?: boolean
}

function makeWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    files: new Map([
      [path.join('/Users/tester', '.pinokio', 'config.json'), JSON.stringify({ home: HOME, version: '8.2.0' })],
      [PTERM, '#!/usr/bin/env node']
    ]),
    reachable: true,
    calls: [],
    kills: 0,
    spawned: [],
    statusSequence: [{}],
    pinokioVersion: '8.2.0',
    ...overrides
  }
}

function install(world: FakeWorld, extra: Partial<PinokioDeps> = {}) {
  let clock = 0
  let statusIndex = 0
  const deps: Partial<PinokioDeps> = {
    platform: 'darwin',
    containerized: () => false,
    homedir: () => '/Users/tester',
    readFile: async (file) => world.files.get(file) ?? null,
    isFile: async (file) => world.files.has(file),
    realpath: async (file) => file,
    tcpReachable: async () => world.reachable,
    fetchJson: async () => {
      throw new Error('no control plane lookup in this world')
    },
    pathEnv: () => '',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    runPterm: async (_pterm, args) => {
      world.calls.push(args)
      const [command] = args
      if (command === 'version') return ok(args[1] === 'pinokio' ? `pinokio@${world.pinokioVersion}\n` : 'pterm@0.0.25\n')
      if (command === 'status') {
        const step = world.statusSequence[Math.min(statusIndex, world.statusSequence.length - 1)]
        if (!args.includes('--probe')) statusIndex += 1
        const probe = args.includes('--probe') ? (step.state === 'online' ? true : false) : null
        return ok(statusJson({ probe, ...step }))
      }
      if (command === 'search') {
        return ok(JSON.stringify({ q: 'x', apps: [JSON.parse(statusJson())] }))
      }
      if (command === 'logs') {
        return ok(JSON.stringify({ app_id: 'comfy.git', script: 'start.js', line_count: 2, lines: ['a', '\u001b[32mb\u001b[0m'] }))
      }
      throw new Error(`unexpected pterm ${args.join(' ')}`)
    },
    spawnPtermRun: async (_pterm, args): Promise<PinokioSpawnedRun> => {
      world.spawned.push(args)
      let resolveExit: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void = () => {}
      const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        resolveExit = resolve
      })
      if (world.runExitsEarly) resolveExit({ exitCode: 1, signal: null })
      return {
        pid: 4242,
        exited,
        outputTail: () => 'installing\n\u001b[31mError: boom\u001b[0m\n',
        kill: () => {
          world.kills += 1
          resolveExit({ exitCode: null, signal: 'SIGKILL' })
        }
      }
    },
    ...extra
  }
  __setPinokioDepsForTests(deps)
}

afterEach(() => {
  __setPinokioDepsForTests(null)
})

describe('detection (DL-01: a specific, quiet answer)', () => {
  it('names Docker, where the app container cannot reach a host Pinokio', async () => {
    install(makeWorld(), { containerized: () => true })
    expect(await detectPinokio({ fresh: true })).toMatchObject({ available: false, reason: 'containerized' })
  })

  it('says "not detected" when Pinokio was never installed', async () => {
    const world = makeWorld()
    world.files.clear()
    install(world)
    expect(await detectPinokio({ fresh: true })).toMatchObject({
      available: false,
      reason: 'not_installed',
      message: 'Pinokio not detected.'
    })
    expect(world.calls).toEqual([])
  })

  it('names a Pinokio older than 8.2.0 as unsupported, from its config, without calling pterm', async () => {
    const world = makeWorld()
    world.files.set(path.join('/Users/tester', '.pinokio', 'config.json'), JSON.stringify({ home: HOME, version: '7.2.6' }))
    install(world)
    const detection = await detectPinokio({ fresh: true })
    expect(detection).toMatchObject({ available: false, reason: 'unsupported_version', version: '7.2.6' })
    expect(detection.message).toBe('Pinokio 7.2.6 found; Batshit needs 8.2.0 or newer.')
    expect(world.calls).toEqual([])
  })

  it('says "not running" when the control plane refuses on loopback, and never calls pterm (rule 6)', async () => {
    const world = makeWorld({ reachable: false })
    install(world)
    expect(await detectPinokio({ fresh: true })).toMatchObject({ available: false, reason: 'not_running', ptermPath: PTERM })
    expect(world.calls).toEqual([])
  })

  it('says pterm is missing when no resolution step finds it', async () => {
    const world = makeWorld()
    world.files.delete(PTERM)
    install(world)
    expect(await detectPinokio({ fresh: true })).toMatchObject({ available: false, reason: 'pterm_missing' })
  })

  it('falls back to the control plane lookup, then PATH (DL-02 order)', async () => {
    const world = makeWorld()
    world.files.delete(PTERM)
    world.files.set('/opt/pinokio/pterm', '#!/usr/bin/env node')
    install(world, { fetchJson: async () => ({ path: '/opt/pinokio/pterm' }) })
    expect(await detectPinokio({ fresh: true })).toMatchObject({ available: true, ptermPath: '/opt/pinokio/pterm' })

    const second = makeWorld()
    second.files.delete(PTERM)
    second.files.set('/usr/local/bin/pterm', '#!/usr/bin/env node')
    install(second, { pathEnv: () => '/usr/bin:/usr/local/bin' })
    expect(await detectPinokio({ fresh: true })).toMatchObject({ available: true, ptermPath: '/usr/local/bin/pterm' })
  })

  it('reports version, home, and pterm when Pinokio 8.2.0 runs', async () => {
    const world = makeWorld()
    install(world)
    expect(await detectPinokio({ fresh: true })).toEqual({
      available: true,
      reason: null,
      message: `Pinokio 8.2.0 detected at ${HOME}.`,
      version: '8.2.0',
      versionFloor: '8.2.0',
      home: HOME,
      ptermPath: PTERM,
      ptermVersion: '0.0.25',
      controlPlaneReachable: true
    })
  })

  it('checks the version pterm reports, not only the config', async () => {
    install(makeWorld({ pinokioVersion: '8.1.9' }))
    expect(await detectPinokio({ fresh: true })).toMatchObject({ available: false, reason: 'unsupported_version', version: '8.1.9' })
  })
})

describe('the read controls', () => {
  it('reads again for "not running" when Pinokio closed after a cached detection', async () => {
    const world = makeWorld()
    install(world)
    await detectPinokio({ fresh: true })
    world.reachable = false
    world.calls.length = 0
    expect(await searchPinokioApps({ query: 'comfy' })).toMatchObject({ ok: false, kind: 'unavailable', reason: 'not_running' })
    expect(world.calls).toEqual([])
  })

  it('searches with --q and --limit and returns local apps', async () => {
    const world = makeWorld()
    install(world)
    const result = await searchPinokioApps({ query: 'image generation', limit: 5 })
    expect(result).toMatchObject({ ok: true, value: { apps: [{ appId: 'comfy.git' }] } })
    expect(world.calls.at(-1)).toEqual(['search', '--q=image generation', '--limit=5'])
  })

  it('refuses an app another machine answered for (DL-07)', async () => {
    install(makeWorld({ statusSequence: [{ source: { local: false } }] }))
    expect(await getPinokioAppStatus({ appId: 'comfy.git' })).toMatchObject({ ok: false, kind: 'refused' })
  })

  it('refuses a URL before calling pterm', async () => {
    const world = makeWorld()
    install(world)
    expect(await getPinokioAppStatus({ appId: 'https://x.test/app' })).toMatchObject({ ok: false, kind: 'refused' })
    expect(world.calls).toEqual([])
  })

  it('probes by default for app status', async () => {
    const world = makeWorld({ statusSequence: [{ state: 'online', running: true, ready: true, ready_url: 'http://localhost:8188' }] })
    install(world)
    const status = await getPinokioAppStatus({ appId: 'comfy.git' })
    expect(status).toMatchObject({ ok: true, value: { state: 'online', probe: true, readyUrl: 'http://localhost:8188' } })
    expect(world.calls.at(-1)).toEqual(['status', 'comfy.git', '--probe'])
  })

  it('vouches for the app with status before reading its logs, and strips colour codes', async () => {
    const world = makeWorld()
    install(world)
    const logs = await getPinokioAppLogs({ appId: 'comfy.git', tail: 20 })
    expect(logs).toMatchObject({ ok: true, value: { appId: 'comfy.git', lines: ['a', 'b'] } })
    const commands = world.calls.map((args) => args[0]).filter((command) => command !== 'version')
    expect(commands).toEqual(['status', 'logs'])
    expect(world.calls.at(-1)).toEqual(['logs', 'comfy.git', '--tail', '20'])
  })
})

describe('starting an app (the P1 run rules)', () => {
  it('rule 1: never runs pterm run on an app that is online and ready', async () => {
    const world = makeWorld({ statusSequence: [{ state: 'online', running: true, ready: true, ready_url: 'http://localhost:8188' }] })
    install(world)
    const result = await startPinokioApp({ appId: 'comfy.git' })
    expect(result).toMatchObject({ ok: true, value: { alreadyRunning: true, ready: true, readyUrl: 'http://localhost:8188' } })
    expect(world.spawned).toEqual([])
    expect(world.kills).toBe(0)
  })

  it('rules 2-4: runs the absolute path, polls, confirms with --probe, then SIGKILLs the child', async () => {
    const world = makeWorld({
      statusSequence: [{}, { state: 'starting', running: true }, { state: 'online', running: true, ready: true, ready_url: 'http://localhost:8188' }]
    })
    install(world)
    const result = await startPinokioApp({ appId: 'comfy.git' })
    expect(result).toMatchObject({
      ok: true,
      value: { alreadyRunning: false, ready: true, state: 'online', readyUrl: 'http://localhost:8188', alsoStarted: [] }
    })
    expect(world.spawned).toEqual([['run', `${HOME}/api/comfy.git`]])
    expect(world.calls.some((args) => args[0] === 'status' && args.includes('--probe'))).toBe(true)
    expect(world.kills).toBe(1)
  })

  it('rule 2: refuses an app folder outside <home>/api/', async () => {
    const world = makeWorld({ statusSequence: [{ path: '/Users/tester/elsewhere/comfy.git' }] })
    install(world)
    expect(await startPinokioApp({ appId: 'comfy.git' })).toMatchObject({ ok: false, kind: 'refused' })
    expect(world.spawned).toEqual([])
  })

  it('rule 2: refuses an app whose status came from another machine', async () => {
    const world = makeWorld({ statusSequence: [{ source: { local: false } }] })
    install(world)
    expect(await startPinokioApp({ appId: 'comfy.git' })).toMatchObject({ ok: false, kind: 'refused' })
    expect(world.spawned).toEqual([])
  })

  it('rule 5: names every app the start also starts, recursively, before anything runs', async () => {
    // Three calls each read one offline status first; the third start then polls it online.
    const world = makeWorld({
      statusSequence: [{}, {}, {}, { state: 'online', running: true, ready: true, ready_url: 'http://localhost:8188' }]
    })
    world.files.set(`${HOME}/api/comfy.git/ENVIRONMENT`, 'PINOKIO_SCRIPT_REQUIRES=ollama,b.git\n')
    world.files.set(`${HOME}/api/b.git/ENVIRONMENT`, 'PINOKIO_SCRIPT_REQUIRES=c.git,comfy.git\n')
    install(world)

    const refused = await startPinokioApp({ appId: 'comfy.git' })
    expect(refused).toMatchObject({ ok: false, kind: 'refused' })
    if (!refused.ok) expect(refused.message).toContain('alsoStarts: ["b.git","c.git","ollama"]')
    expect(world.spawned).toEqual([])

    const partial = await startPinokioApp({ appId: 'comfy.git', alsoStarts: ['ollama'] })
    expect(partial).toMatchObject({ ok: false, kind: 'refused' })
    expect(world.spawned).toEqual([])

    const started = await startPinokioApp({ appId: 'comfy.git', alsoStarts: ['ollama', 'c.git', 'b.git'] })
    expect(started).toMatchObject({ ok: true, value: { ready: true, alsoStarted: ['b.git', 'c.git', 'ollama'] } })
    expect(world.spawned).toHaveLength(1)
  })

  it('rule 5: refuses alsoStarts for an app that starts no other app, so the card never overstates', async () => {
    const world = makeWorld()
    install(world)
    expect(await startPinokioApp({ appId: 'comfy.git', alsoStarts: ['ollama'] })).toMatchObject({ ok: false, kind: 'refused' })
    expect(world.spawned).toEqual([])
  })

  it('answers "still starting" when the wait ends, and leaves the app starting in Pinokio', async () => {
    const world = makeWorld({ statusSequence: [{}, { state: 'starting', running: true }] })
    install(world)
    const result = await startPinokioApp({ appId: 'comfy.git', waitSeconds: 10 })
    expect(result).toMatchObject({ ok: true, value: { ready: false, state: 'starting', alreadyRunning: false } })
    if (result.ok) {
      expect(result.value.message).toContain('check again with sys.pinokio.app_status')
      expect(result.value.outputTail).toEqual(['installing', 'Error: boom'])
    }
    expect(world.kills).toBe(1)
  })

  it('says the app did not start when pterm run ends and the app is still offline', async () => {
    const world = makeWorld({ statusSequence: [{}, { state: 'offline', last_error: 'script exited' }], runExitsEarly: true })
    install(world)
    const result = await startPinokioApp({ appId: 'comfy.git' })
    expect(result).toMatchObject({ ok: false, kind: 'error' })
    if (!result.ok) {
      expect(result.message).toContain('did not start')
      expect(result.message).toContain('script exited')
      expect(result.raw).toContain('Error: boom')
    }
  })

  it('shares one start between parallel calls for the same app', async () => {
    const world = makeWorld({
      statusSequence: [{}, { state: 'online', running: true, ready: true, ready_url: 'http://localhost:8188' }]
    })
    install(world)
    const [first, second] = await Promise.all([startPinokioApp({ appId: 'comfy.git' }), startPinokioApp({ appId: 'comfy.git' })])
    expect(first).toEqual(second)
    expect(world.spawned).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * The real process plumbing, with a stand-in `pterm`
 * ------------------------------------------------------------------ */

describe('real pterm processes (a stand-in script)', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'batshit-pterm-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs pterm with Batshit\'s own Node and an allowlisted environment', async () => {
    const script = path.join(dir, 'pterm')
    writeFileSync(script, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(Object.keys(process.env).sort()))\n")
    chmodSync(script, 0o755)
    const saved = process.env.BATSHIT_TOKEN
    process.env.BATSHIT_TOKEN = 'secret-token'
    try {
      const result = await realPinokioDepsForTests.runPterm(script, [], { cwd: dir, timeoutMs: 10_000 })
      expect(result.exitCode).toBe(0)
      const keys = JSON.parse(result.stdout) as string[]
      expect(keys).not.toContain('BATSHIT_TOKEN')
      expect(keys).toContain('NO_COLOR')
    } finally {
      if (saved === undefined) delete process.env.BATSHIT_TOKEN
      else process.env.BATSHIT_TOKEN = saved
    }
  })

  it('ends a hung pterm with SIGKILL at its timeout', async () => {
    const script = path.join(dir, 'pterm.js')
    writeFileSync(script, 'setInterval(() => {}, 1000)\n')
    const result = await realPinokioDepsForTests.runPterm(script, [], { cwd: dir, timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
  })

  it('never sends pterm run a SIGTERM or SIGINT: its kill is SIGKILL, which pterm cannot catch', async () => {
    const script = path.join(dir, 'pterm.js')
    const marker = path.join(dir, 'caught-signal')
    const pidFile = path.join(dir, 'pid')
    writeFileSync(
      script,
      [
        "const fs = require('node:fs')",
        `for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { fs.writeFileSync(${JSON.stringify(marker)}, signal); process.exit(0) })`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
        "process.stdout.write('pterm-ready\\n')",
        'setInterval(() => {}, 1000)'
      ].join('\n')
    )
    const run = await realPinokioDepsForTests.spawnPtermRun(script, [], { cwd: dir })
    try {
      let ready = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (existsSync(pidFile) && run.outputTail().includes('pterm-ready')) {
          ready = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(ready, 'pterm must arm signal handlers and announce readiness before it is killed').toBe(true)
      run.kill()
      const exit = await run.exited
      expect(exit.signal).toBe('SIGKILL')
      expect(existsSync(marker)).toBe(false)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      expect(spawnSync('kill', ['-0', String(pid)]).status).not.toBe(0)
      expect(run.outputTail()).toContain('pterm-ready')
    } finally {
      run.kill()
      await run.exited
    }
  })
})

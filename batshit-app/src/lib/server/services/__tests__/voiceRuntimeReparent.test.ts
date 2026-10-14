// BL-1252 and BL-1258 with real processes. A local runtime started through
// `spawnReparentedRuntime` must lead its own process group, must not have the app as its parent
// once it is handed over, and must belong to its launcher, which stops it, in every window before
// its launch record exists. The engines here are tiny Node and shell fakes; every one of them is
// logged when it is born and when it is seen gone, and none may outlive the file.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { spawnReparentedRuntime } from '../voiceRuntimeReparent'

const MODULE_PATH = path.resolve(process.cwd(), 'src/lib/server/services/voiceRuntimeReparent.ts')

// A fake engine: notes its birth (pid, parent, group, what sits in fd 3, what its environment
// carries) in the ledger, prints one line to its log, then runs until stopped.
const FAKE_ENGINE = String.raw`
import { appendFileSync, fstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const [ledger] = process.argv.slice(2)
let fd3 = 'closed'
try { fd3 = fstatSync(3).isCharacterDevice() ? 'null-device' : 'other' } catch {}
const pgid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
// Node takes NODE_CHANNEL_FD out of the environment when it opens a channel, so a leaked channel
// shows as process.send, not as the variable.
appendFileSync(ledger, JSON.stringify({
  event: 'born', role: 'engine', pid: process.pid, ppid: process.ppid, pgid, fd3,
  ipc: typeof process.send === 'function', secret: process.env.FIXTURE_SECRET ?? null
}) + '\n')
console.log('fake engine says hello')
setInterval(() => {}, 1000)
`

// A fake app: launches a fake engine the way the mode says, notes it, and then stays alive (as the
// app does) until the test ends it.
const FAKE_APP = String.raw`
import { appendFileSync, openSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const [modulePath, mode, dir, ledger] = process.argv.slice(2)
const log = openSync(dir + '/app-engine.log', 'a')
const note = (entry) => appendFileSync(ledger, JSON.stringify({ ...entry, app: process.pid }) + '\n')
const engine = { command: process.execPath, args: [dir + '/fake-engine.mjs', ledger], cwd: dir, env: { PATH: '/usr/bin:/bin' } }
if (mode === 'direct') {
  // Before BL-1252: the engine is this process's own detached child.
  const child = spawn(engine.command, engine.args, { cwd: dir, env: engine.env, detached: true, stdio: ['ignore', log, log] })
  child.once('spawn', () => { child.unref(); note({ event: 'launched', engine: child.pid }) })
} else {
  const { spawnReparentedRuntime } = await import(modulePath)
  if (mode === 'reparented') {
    const pid = await spawnReparentedRuntime({ ...engine, stdoutFd: log, stderrFd: log }, async () => {})
    note({ event: 'launched', engine: pid })
  } else if (mode === 'dies-while-recording') {
    spawnReparentedRuntime({ ...engine, stdoutFd: log, stderrFd: log }, async (pid) => {
      note({ event: 'recording', engine: pid })
      process.exit(0)
    })
  } else if (mode === 'dies-before-started') {
    // A shell engine writes its pid at once, then becomes a Node sleeper (same pid); this app
    // dies as soon as it sees that line, well inside the launcher's 200 ms window.
    const shellBorn = dir + '/shell-born.txt'
    spawnReparentedRuntime({
      command: '/bin/sh',
      args: ['-c', 'echo "$$" >> "$1"; exec "$2" -e "setInterval(() => {}, 1000)" "$1"', 'engine', shellBorn, process.execPath],
      cwd: dir, env: { PATH: '/usr/bin:/bin' }, stdoutFd: log, stderrFd: log
    }, async () => { note({ event: 'recorded-too-late' }) })
    const poll = setInterval(() => {
      let text = ''
      try { text = readFileSync(shellBorn, 'utf8') } catch {}
      if (text.trim()) {
        clearInterval(poll)
        note({ event: 'shell-engine-born', engine: Number(text.trim()) })
        process.exit(0)
      }
    }, 2)
  }
}
setInterval(() => {}, 1000)
`

let dir = ''
let ledger = ''
const apps: ChildProcess[] = []
const openFds: number[] = []

function note(entry: Record<string, unknown>) {
  appendFileSync(ledger, `${JSON.stringify({ ...entry, by: 'test' })}\n`)
}

function ledgerEntries(): Array<Record<string, unknown>> {
  if (!existsSync(ledger)) return []
  return readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function bornEngine(pid: number) {
  return ledgerEntries().find((entry) => entry.event === 'born' && entry.pid === pid) as
    | { pid: number; ppid: number; pgid: number; fd3: string; ipc: boolean; secret: string | null }
    | undefined
}

// Running means present and not a zombie waiting for its parent.
function isRunning(pid: number): boolean {
  try {
    const stat = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat.length > 0 && !stat.startsWith('Z')
  } catch {
    return false
  }
}

function parentOf(pid: number): number | null {
  try {
    return Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  } catch {
    return null
  }
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return check()
}

async function expectGone(pid: number, what: string) {
  const gone = await waitFor(() => !isRunning(pid))
  if (gone) note({ event: 'gone', pid, what })
  expect(gone, `${what} (pid ${pid}) still runs`).toBe(true)
}

// Engine pids the launcher wrote to a log ("engine launcher started process N" once the engine ran,
// "stopped engine process N" when it stopped one it had not handed over).
function launchedPids(logPath: string): number[] {
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf8').matchAll(/(?:engine launcher started|stopped engine) process (\d+)/g)
  return [...new Set([...lines].map((match) => Number(match[1])))]
}

// Fakes whose command line carries this tag.
function runningWithTag(tag: string) {
  return fixturesStillRunning().filter(({ command }) => command.includes(tag))
}

// Every process whose command line names this file's folder: the fakes, and only them.
function fixturesStillRunning(): Array<{ pid: number; command: string }> {
  return execFileSync('/bin/ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => !match[2].startsWith('Z') && match[3].includes(dir))
    .map((match) => ({ pid: Number(match[1]), command: match[3] }))
}

function stopFixtures() {
  for (const { pid, command } of fixturesStillRunning()) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {}
    }
    note({ event: 'cleanup-killed', pid, command })
  }
}

function logFile(name: string) {
  const logPath = path.join(dir, `${name}.log`)
  const fd = openSync(logPath, 'a')
  openFds.push(fd)
  return { logPath, fd }
}

function engineLaunch(fd: number, args: string[] = []) {
  return {
    command: process.execPath,
    args: [path.join(dir, 'fake-engine.mjs'), ledger, ...args],
    cwd: dir,
    env: { PATH: '/usr/bin:/bin', FIXTURE_SECRET: 'fixture-secret' },
    stdoutFd: fd,
    stderrFd: fd
  }
}

function startApp(mode: string): ChildProcess {
  const err = openSync(path.join(dir, `app-${mode}.err`), 'a')
  openFds.push(err)
  const app = spawn(process.execPath, [path.join(dir, 'fake-app.mjs'), MODULE_PATH, mode, dir, ledger], {
    cwd: dir,
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'ignore', err]
  })
  apps.push(app)
  note({ event: 'spawned', role: 'app', mode, pid: app.pid })
  return app
}

async function appNote(app: ChildProcess, event: string) {
  let found: Record<string, unknown> | undefined
  await waitFor(() => {
    found = ledgerEntries().find((entry) => entry.app === app.pid && entry.event === event)
    return found !== undefined
  }, 5_000)
  expect(found, `the fake app noted no "${event}"`).toBeDefined()
  return found as Record<string, unknown> & { engine: number }
}

// kill-sync 1.0.4's tree mode, which Pinokio 8.2's Stop runs on a script's shell: one
// `ps -A -o pid=,ppid=` snapshot, every descendant found by parent links, SIGKILL to each, then
// to the root. Process groups and sessions play no part.
function killSyncTree(root: number) {
  const children = new Map<number, number[]>()
  for (const line of execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const match = /\s*(\d+)\s*(\d+)/.exec(line)
    if (!match) continue
    const [pid, ppid] = [Number(match[1]), Number(match[2])]
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const victims: number[] = []
  const walk = (pid: number) => {
    for (const kid of children.get(pid) ?? []) {
      victims.push(kid)
      walk(kid)
    }
  }
  walk(root)
  for (const pid of [...victims, root]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'bs-reparent-'))
  ledger = path.join(dir, 'ledger.jsonl')
  await writeFile(path.join(dir, 'fake-engine.mjs'), FAKE_ENGINE)
  await writeFile(path.join(dir, 'fake-app.mjs'), FAKE_APP)
  expect(existsSync(MODULE_PATH)).toBe(true)
})

afterEach(() => {
  stopFixtures()
  for (const app of apps.splice(0)) {
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  }
  for (const fd of openFds.splice(0)) {
    try {
      closeSync(fd)
    } catch {}
  }
})

afterAll(async () => {
  const survivors = fixturesStillRunning()
  stopFixtures()
  const entries = ledgerEntries()
  const count = (event: string) => entries.filter((entry) => entry.event === event).length
  // The run's receipt: every fake that was born, seen gone, or had to be killed by the cleanup.
  console.info(
    `[fixture ledger] apps spawned ${count('spawned')}, node engines born ${count('born')}, ` +
      `shell engines born ${count('shell-engine-born')}, seen gone ${count('gone')}, ` +
      `cleanup kills ${count('cleanup-killed')}, survivors ${survivors.length}`
  )
  expect(survivors).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

describe('spawnReparentedRuntime with real processes', () => {
  it('starts the engine in its own group, records it while its launcher still owns it, then leaves it to launchd or init', async () => {
    const { logPath, fd } = logFile('handover')
    let parentWhileRecording: number | null = null
    let recordedPid: number | null = null

    const pid = await spawnReparentedRuntime(engineLaunch(fd), async (launched) => {
      recordedPid = launched
      parentWhileRecording = parentOf(launched)
    })

    expect(recordedPid).toBe(pid)
    expect(await waitFor(() => bornEngine(pid) !== undefined)).toBe(true)
    const born = bornEngine(pid)!
    const launcher = born.ppid
    // While the record was written, the launcher was its parent; by the answer, it is gone.
    expect(parentWhileRecording).toBe(launcher)
    expect(launcher).not.toBe(process.pid)
    expect(isRunning(launcher)).toBe(false)
    expect(born.pgid).toBe(pid)
    const parentNow = parentOf(pid)
    expect(parentNow).not.toBe(process.pid)
    expect(parentNow).not.toBe(launcher)
    if (process.platform === 'darwin') expect(parentNow).toBe(1)
    // The environment arrived whole and only over the channel; the channel itself did not.
    expect(born.secret).toBe('fixture-secret')
    expect(born.ipc).toBe(false)
    expect(born.fd3).toBe('null-device')
    expect(await waitFor(() => readFileSync(logPath, 'utf8').includes('fake engine says hello'))).toBe(true)
    expect(launchedPids(logPath)).toEqual([pid])
    expect(isRunning(pid)).toBe(true)
  })

  it("fails with today's words when the engine ends inside its first 200 ms", async () => {
    const { fd } = logFile('exits')
    let recorded = false
    await expect(
      spawnReparentedRuntime(
        { command: '/bin/sh', args: ['-c', 'exit 3'], cwd: dir, env: { PATH: '/usr/bin:/bin' }, stdoutFd: fd, stderrFd: fd },
        async () => {
          recorded = true
        }
      )
    ).rejects.toThrow('Local engine launch exited immediately (code 3).')
    expect(recorded).toBe(false)
  })

  it('keeps the words of an engine that cannot start', async () => {
    const { fd } = logFile('missing')
    await expect(
      spawnReparentedRuntime(
        { command: path.join(dir, 'no-such-engine'), args: [], cwd: dir, env: { PATH: '/usr/bin:/bin' }, stdoutFd: fd, stderrFd: fd },
        async () => undefined
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops the engine through its launcher when the answer comes too late', async () => {
    const { logPath, fd } = logFile('late')
    let recorded = false

    const failure = await spawnReparentedRuntime(
      engineLaunch(fd, ['late-answer']),
      async () => {
        recorded = true
      },
      { startedTimeoutMs: 150 }
    ).catch((error: Error) => error)

    // The launcher confirmed the stop (exit 3), so nothing is reported as possibly still running.
    expect((failure as Error).message).toBe('The local engine launcher did not report the engine within 0.15 seconds.')
    expect(recorded).toBe(false)
    // On a slow start the abort can arrive before the engine's `spawn` event, so the engine may be
    // stopped before it printed anything: what matters is that no engine of this launch runs.
    for (const pid of launchedPids(logPath)) await expectGone(pid, 'engine whose answer came too late')
    expect(await waitFor(() => runningWithTag('late-answer').length === 0)).toBe(true)
  })

  it("finds a bare command on the engine's PATH, not on its launcher's", async () => {
    const { fd } = logFile('bare-command')
    const bin = path.join(dir, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(path.join(bin, 'bs-bare-engine'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 })

    const pid = await spawnReparentedRuntime(
      {
        ...engineLaunch(fd),
        command: 'bs-bare-engine',
        args: [path.join(dir, 'fake-engine.mjs'), ledger],
        env: { PATH: `${bin}:/usr/bin:/bin`, FIXTURE_SECRET: 'fixture-secret' }
      },
      async () => undefined
    )

    expect(await waitFor(() => bornEngine(pid) !== undefined)).toBe(true)
  })

  it('stops the engine through its launcher when the record cannot be written', async () => {
    const { logPath, fd } = logFile('record-fails')

    const failure = await spawnReparentedRuntime(engineLaunch(fd), async () => {
      throw new Error('the launch record could not be written')
    }).catch((error: Error) => error)

    expect((failure as Error).message).toBe('the launch record could not be written')
    const launched = launchedPids(logPath)
    expect(launched).toHaveLength(1)
    await expectGone(launched[0], 'engine whose record failed')
  })

  it('stops the engine when its launcher is told to stop while the record is written', async () => {
    const { logPath, fd } = logFile('launcher-stopped')

    const failure = await spawnReparentedRuntime(engineLaunch(fd), async (launched) => {
      expect(await waitFor(() => bornEngine(launched) !== undefined)).toBe(true)
      const launcher = bornEngine(launched)!.ppid
      process.kill(launcher, 'SIGTERM')
      expect(await waitFor(() => !isRunning(launcher))).toBe(true)
    }).catch((error: Error) => error)

    expect((failure as Error).message).toContain('stopped the engine before it was handed over')
    const launched = launchedPids(logPath)
    expect(launched).toHaveLength(1)
    await expectGone(launched[0], 'engine whose launcher got SIGTERM')
  })

  it('stops the engine when the app dies inside the 200 ms window', async () => {
    const app = startApp('dies-before-started')
    const born = await appNote(app, 'shell-engine-born')

    await expectGone(born.engine, 'shell engine of an app that died before the answer')
    expect(ledgerEntries().some((entry) => entry.event === 'recorded-too-late')).toBe(false)
  })

  it('stops the engine when the app dies while the record is written', async () => {
    const app = startApp('dies-while-recording')
    const recording = await appNote(app, 'recording')

    await expectGone(recording.engine, 'engine of an app that died while recording')
  })

  it("Pinokio's Stop (kill-sync's tree mode) ends a direct launch's engine, not a handed-over one", async () => {
    const direct = startApp('direct')
    const reparented = startApp('reparented')
    const directEngine = (await appNote(direct, 'launched')).engine
    const handedOver = (await appNote(reparented, 'launched')).engine
    expect(isRunning(directEngine) && isRunning(handedOver)).toBe(true)

    killSyncTree(direct.pid!)
    killSyncTree(reparented.pid!)

    await expectGone(directEngine, 'direct engine after the tree kill')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(isRunning(handedOver), 'the handed-over engine survives the tree kill').toBe(true)
  })
})

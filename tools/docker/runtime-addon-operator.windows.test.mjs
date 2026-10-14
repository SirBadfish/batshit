// Real Windows process proof for Docker's host voice operator. Run on the PC with
// `node --test tools/docker/runtime-addon-operator.windows.test.mjs`.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  localRuntimeProcessTreeFromWindows,
  parseWindowsLocalRuntimeProcesses,
  readWindowsLocalRuntimeProcesses,
  withLocalRuntimeRecordLock
} from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs'

const OPERATOR = fileURLToPath(new URL('./runtime-addon-operator.mjs', import.meta.url))
const PROCESS_TABLE_HOOK = fileURLToPath(new URL('./test-fixtures/windows-process-table-hook.cjs', import.meta.url))
const TOKEN = 'windows-voice-test-only'
const VOICE_RECIPE_SIGNING_KEY = 'a'.repeat(64)
const windowsTest = process.platform === 'win32' ? test : test.skip

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function eventually(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  do {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < until)
  return Boolean(await predicate())
}

async function identity(pid) {
  const processes = await readWindowsLocalRuntimeProcesses()
  return processes?.find((entry) => entry.pid === pid) ?? null
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/F'], { timeout: 3000, windowsHide: true }, () => resolve())
  })
}

async function fixture(t, { tableHook = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-win-voice-'))
  const installRoot = path.join(root, 'installs', 'fake-engine')
  const stateDir = path.join(root, 'runtime', 'runtime-addon-operator', 'voice-engines')
  await mkdir(installRoot, { recursive: true })
  await mkdir(path.join(root, 'runtime'), { recursive: true })
  const keyFile = path.join(root, 'voice-recipe.key')
  await writeFile(keyFile, `${VOICE_RECIPE_SIGNING_KEY}\n`)
  const command = process.execPath
  const script = path.join(installRoot, 'engine.mjs')
  await writeFile(script, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
if (process.argv[2] === '--parent') {
  const children = []
  for (let index = 0; index < Number(process.argv[4] || 1); index += 1) {
    const child = spawn(process.execPath, [process.argv[1], '--child'], { stdio: 'ignore', detached: true, windowsHide: true })
    child.unref()
    children.push(child.pid)
  }
  writeFileSync(process.argv[3], children.join(','))
}
setInterval(() => {}, 1000)
`)
  const owned = new Map()
  t.after(async () => {
    for (const [pid, startedAtMs] of owned) {
      if ((await identity(pid))?.startedAtMs === startedAtMs) await taskkill(pid)
    }
    await rm(root, { recursive: true, force: true })
  })
  const port = await freePort()
  const child = spawn(process.execPath, tableHook ? ['--require', PROCESS_TABLE_HOOK, OPERATOR] : [OPERATOR], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    detached: true,
    env: {
      ...process.env,
      BATSHIT_RUNTIME_ADDON_OPERATOR_WATCH: '0',
      BATSHIT_RUNTIME_ADDON_OPERATOR_ROOT: root,
      BATSHIT_RUNTIME_ADDON_OPERATOR_ENV_FILE: path.join(root, 'absent.env'),
      BATSHIT_RUNTIME_ADDON_OPERATOR_HOST: '127.0.0.1',
      BATSHIT_RUNTIME_ADDON_OPERATOR_PORT: String(port),
      BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN: TOKEN,
      BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN: '',
      BATSHIT_HOST_RUNTIME_ROOT: root,
      BATSHIT_HOST_VOICE_RECIPE_KEY_FILE: keyFile,
      BATSHIT_HOST_VOICE_ALLOWED_ROOTS: [path.join(root, 'installs'), path.join(root, 'runtime'), path.dirname(command), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter),
      BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR: stateDir,
      BATSHIT_TEST_WINDOWS_TABLE_HOOK_ROOT: tableHook ? root : ''
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  t.after(() => child.kill())
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  assert.ok(await eventually(() => output.includes('operator listening on'), 10000), output)
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { status: response.status, body: await response.json() }
  }
  const startVoice = (recipe) => {
    const issuedAt = Date.now()
    const nonce = randomUUID()
    const signature = createHmac('sha256', Buffer.from(VOICE_RECIPE_SIGNING_KEY, 'hex'))
      .update('batshit-host-voice-start-v1\0')
      .update(`${issuedAt}\0${nonce}\0${JSON.stringify(recipe)}`)
      .digest('hex')
    return call('/v1/voice-engines/start', { ...recipe, proof: { issuedAt, nonce, signature } })
  }
  const start = async (engineId, { parent = false, children = 1, owner = 'docker:test', stopOnShutdown = true } = {}) => {
    const childPidFile = path.join(installRoot, `${engineId}-child.pid`)
    const answer = await startVoice({
      engineId,
      installRoot,
      launch: { command, args: [script, ...(parent ? ['--parent', childPidFile, String(children)] : ['--child'])] },
      endpoint: `http://127.0.0.1:${engineId === 'one' ? 8111 : 8222}`,
      owner,
      stopOnShutdown
    })
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    assert.equal(answer.body.recorded, true, JSON.stringify(answer.body))
    assert.ok(await eventually(async () => Boolean(await identity(answer.body.pid))), 'engine started')
    const rootIdentity = await identity(answer.body.pid)
    owned.set(answer.body.pid, rootIdentity.startedAtMs)
    let childPid = null
    let childPids = []
    if (parent) {
      assert.ok(await eventually(async () => Boolean(await readFile(childPidFile, 'utf8').catch(() => ''))))
      childPids = (await readFile(childPidFile, 'utf8')).split(',').map(Number)
      childPid = childPids[0]
      for (const pid of childPids) {
        const childIdentity = await identity(pid)
        assert.ok(childIdentity?.startedAtMs >= rootIdentity.startedAtMs, 'child belongs to live parent')
        owned.set(pid, childIdentity.startedAtMs)
      }
    }
    return { pid: answer.body.pid, childPid, childPids }
  }
  const armProcessTable = async (mode) => {
    assert.ok(tableHook, 'the operator fixture must have its process-table hook enabled')
    await writeFile(path.join(root, 'table-hook-armed'), mode)
    return {
      markerPath: path.join(root, 'table-hook-called'),
      injectedPath: path.join(root, 'table-hook-injected')
    }
  }
  return { root, stateDir, installRoot, command, script, call, startVoice, start, owned, armProcessTable }
}

test('Windows process parser handles PowerShell dates and rejects ambiguous parent identity', () => {
  const processes = parseWindowsLocalRuntimeProcesses(JSON.stringify([
    { ProcessId: 40, ParentProcessId: 1, CreationDate: '/Date(1000)/', CommandLine: 'root' },
    { ProcessId: 41, ParentProcessId: 40, CreationDate: '/Date(2000)/', CommandLine: 'child' },
    { ProcessId: 42, ParentProcessId: 40, CreationDate: '/Date(500)/', CommandLine: 'old child' }
  ]))
  const tree = localRuntimeProcessTreeFromWindows(processes, 40)
  assert.deepEqual(tree.members.map((entry) => entry.pid), [40, 41])
  assert.equal(tree.unsafeDescendants, true)
  assert.equal(tree.leaderStartedAtMs, 1000)
})

windowsTest('the operator stamps a launch before awaiting its first process-table read', async (t) => {
  const host = await fixture(t, { tableHook: true })
  const { markerPath } = await host.armProcessTable('delay')
  await host.start('timestamp')
  const recordPath = path.join(host.stateDir, 'timestamp', '.batshit-local-runtime-launch.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const readStartedAt = Number(await readFile(markerPath, 'utf8'))
  assert.ok(Number.isFinite(readStartedAt))
  assert.ok(Date.parse(record.launchedAt) <= readStartedAt,
    `launch stamp ${record.launchedAt} must precede process-table read ${new Date(readStartedAt).toISOString()}`)
})

windowsTest('the operator records its verified root when the launch snapshot has an ambiguous child', async (t) => {
  const host = await fixture(t, { tableHook: true })
  const { injectedPath } = await host.armProcessTable('ambiguous')
  const engine = await host.start('ambiguous', { parent: true })
  assert.equal(Number(await readFile(injectedPath, 'utf8')), engine.pid)
  const recordPath = path.join(host.stateDir, 'ambiguous', '.batshit-local-runtime-launch.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  assert.ok(record.windowsMembers.some((member) => member.pid === engine.pid), 'verified root must remain recorded')
  assert.ok(!record.windowsMembers.some((member) => member.pid === 2_147_000_000), 'ambiguous child is never recorded')
})

windowsTest('a failed choices table read cannot stop a shared runtime against a keep choice', async (t) => {
  const host = await fixture(t, { tableHook: true })
  const engine = await host.start('one')
  const { markerPath } = await host.armProcessTable('fail')
  const answer = await host.call('/v1/voice-engines/stop', {
    owner: 'docker:test',
    engines: [{ engineId: 'shared', endpoint: 'http://127.0.0.1:8111', stopOnShutdown: false }]
  })
  assert.equal(answer.status, 500)
  assert.match(answer.body.error, /Windows process table could not be read.*no host voice engines were stopped/)
  assert.ok(await readFile(markerPath, 'utf8'), 'the failed read reached the operator choices pass')
  assert.ok(await identity(engine.pid), 'the shared runtime must remain alive')
  assert.ok(await readFile(path.join(host.stateDir, 'one', '.batshit-local-runtime-launch.json'), 'utf8'))
})

windowsTest('Windows operator keeps on request, then stops a verified parent and child', async (t) => {
  const host = await fixture(t)
  const health = await host.call('/health')
  assert.equal(health.body.sandboxRevision, 12)
  assert.ok(health.body.hostVoiceControls.includes('stop'))
  const engine = await host.start('one', { parent: true })
  const keep = await host.call('/v1/voice-engines/stop', {
    owner: 'docker:test', engines: [{ engineId: 'one', endpoint: 'http://127.0.0.1:8111', stopOnShutdown: false }]
  })
  assert.deepEqual(keep.body.keptRunning.map((entry) => entry.pid), [engine.pid])
  assert.ok(await identity(engine.childPid))
  // Old records without a launch timestamp use the command fallback. Windows
  // paths and quoting must not make a live engine look like a reused PID.
  const recordPath = path.join(host.stateDir, 'one', '.batshit-local-runtime-launch.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  delete record.launchedAt
  record.command = record.command.toUpperCase()
  record.cwd = record.cwd.toUpperCase()
  record.args = record.args.map((arg) => arg.toUpperCase())
  await writeFile(recordPath, JSON.stringify(record))
  const stopStarted = Date.now()
  const stop = await host.call('/v1/voice-engines/stop', {
    owner: 'docker:test', engines: [{ engineId: 'one', endpoint: 'http://127.0.0.1:8111', stopOnShutdown: true }]
  })
  assert.deepEqual(stop.body.stopped, [{ pid: engine.pid, engineIds: ['one'] }])
  t.diagnostic(`Windows parent+child stop completed in ${Date.now() - stopStarted} ms`)
  assert.ok(await eventually(async () => !(await identity(engine.pid)) && !(await identity(engine.childPid))))
})

windowsTest('Windows operator respects owner, refuses a reused PID, and rejects batch launches', async (t) => {
  const host = await fixture(t)
  const engine = await host.start('two', { owner: 'docker:other' })
  const other = await host.call('/v1/voice-engines/stop', { owner: 'docker:mine', engines: [] })
  assert.deepEqual(other.body.stopped, [])
  assert.ok(await identity(engine.pid))

  // A process born after the launch timestamp cannot be the recorded launch, even
  // if its command line is exactly the same. The record is stale and must not kill it.
  const recordPath = path.join(host.stateDir, 'two', '.batshit-local-runtime-launch.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  record.launchedAt = new Date((await identity(engine.pid)).startedAtMs - 1000).toISOString()
  await writeFile(recordPath, JSON.stringify(record))
  const reused = await host.call('/v1/voice-engines/stop', { owner: 'docker:other', engines: [] })
  assert.deepEqual(reused.body.stopped, [])
  assert.match(reused.body.notStopped[0].reason, /reused pid/)
  assert.ok(await identity(engine.pid))

  const batch = path.join(host.installRoot, 'bad.cmd')
  await writeFile(batch, '@echo off\r\n')
  const rejected = await host.startVoice({
    engineId: 'batch', installRoot: host.installRoot, launch: { command: batch }
  })
  assert.equal(rejected.status, 500)
  assert.match(rejected.body.error, /must name a regular \.exe/)
  const extensionless = path.join(host.installRoot, 'no-extension')
  await writeFile(extensionless, '')
  const noExtension = await host.startVoice({
    engineId: 'extensionless', installRoot: host.installRoot, launch: { command: extensionless }
  })
  assert.equal(noExtension.status, 500)
  assert.match(noExtension.body.error, /must name a regular \.exe/)
  for (const flag of ['-e', '--eval=0', '-p', '--print=0', '-pe']) {
    const evalRejected = await host.startVoice({
      engineId: 'eval', installRoot: host.installRoot, launch: { command: host.command, args: [flag] }
    })
    assert.equal(evalRejected.status, 500)
    assert.match(evalRejected.body.error, /Inline eval-style/)
  }
  for (const args of [
    ['--import=data:text/javascript,console.log(1)'],
    ['--loader', 'data:text/javascript,console.log(1)'],
    ['-rdata:text/javascript,console.log(1)']
  ]) {
    const rejected = await host.startVoice({
      engineId: 'eval', installRoot: host.installRoot, launch: { command: host.command, args }
    })
    assert.equal(rejected.status, 500)
    assert.match(rejected.body.error, /Inline eval-style/)
  }
  for (const key of ['NODE_OPTIONS', 'pythonpath']) {
    const rejected = await host.startVoice({
      engineId: 'env', installRoot: host.installRoot,
      launch: { command: host.command, env: { [key]: '--import=data:text/javascript,console.log(1)' } }
    })
    assert.equal(rejected.status, 500)
    assert.match(rejected.body.error, /Launch env name/)
  }
  for (const name of ['cmd.exe', 'wscript.exe', 'mshta.exe']) {
    const blocked = await host.startVoice({
      engineId: 'shell', installRoot: host.installRoot,
      launch: { command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name) }
    })
    assert.equal(blocked.status, 500)
    assert.match(blocked.body.error, /is not allowed/)
  }
})

windowsTest('Windows record lock reaps a reused owner PID but preserves a live owner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-win-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const startedAtMs = (await identity(process.pid)).startedAtMs
  assert.ok(Number.isFinite(startedAtMs))
  const lockPath = path.join(root, '.batshit-local-runtime-launch.lock')
  const oldTime = new Date(Date.now() - 20_000)
  await writeFile(lockPath, `v2:${process.pid}:${startedAtMs - 10_000}:old`)
  await utimes(lockPath, oldTime, oldTime)
  assert.equal(await withLocalRuntimeRecordLock(root, async () => 'reaped', { waitMs: 500 }), 'reaped')

  await writeFile(lockPath, `v2:${process.pid}:${startedAtMs}:live`)
  await utimes(lockPath, oldTime, oldTime)
  await assert.rejects(
    withLocalRuntimeRecordLock(root, async () => 'stole live lock', { waitMs: 100 }),
    /timed out waiting for the launch record lock/
  )
  assert.equal(await readFile(lockPath, 'utf8'), `v2:${process.pid}:${startedAtMs}:live`)
})

windowsTest('two Windows launch-record writers serialize through the same lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-win-lock-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const order = []
  let firstEntered
  const entered = new Promise((resolve) => { firstEntered = resolve })
  const first = withLocalRuntimeRecordLock(root, async () => {
    order.push('first enters')
    firstEntered()
    await new Promise((resolve) => setTimeout(resolve, 200))
    order.push('first exits')
  })
  await entered
  const second = withLocalRuntimeRecordLock(root, async () => { order.push('second enters') })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first enters', 'first exits', 'second enters'])
})

windowsTest('an exited root leaves its known child visible and stops it', async (t) => {
  const host = await fixture(t)
  const engine = await host.start('handoff', { parent: true })
  await taskkill(engine.pid)
  assert.ok(await eventually(async () => !(await identity(engine.pid)), 4000), 'root exited')
  assert.ok(await identity(engine.childPid), 'child survived the root')
  const answer = await host.call('/v1/voice-engines/stop', { owner: 'docker:test', engines: [] })
  assert.deepEqual(answer.body.stopped, [{ pid: engine.pid, engineIds: ['handoff'] }], JSON.stringify(answer.body))
  assert.ok(await eventually(async () => !(await identity(engine.childPid))), 'known child stopped')
  await assert.rejects(readFile(path.join(host.stateDir, 'handoff', '.batshit-local-runtime-launch.json'), 'utf8'), /ENOENT/)
})

windowsTest('an engine that crashed before Stop releases its launch record', async (t) => {
  const host = await fixture(t)
  const engine = await host.start('crash')
  await taskkill(engine.pid)
  assert.ok(await eventually(async () => !(await identity(engine.pid))), 'engine crashed')
  const answer = await host.call('/v1/voice-engines/stop', { owner: 'docker:test', engines: [] })
  assert.deepEqual(answer.body.notStopped, [])
  assert.deepEqual(answer.body.stopped, [])
  await assert.rejects(readFile(path.join(host.stateDir, 'crash', '.batshit-local-runtime-launch.json'), 'utf8'), /ENOENT/)
})

windowsTest('a launch with no recorded identity reports once after its root exits', async (t) => {
  const host = await fixture(t)
  const engine = await host.start('unidentified')
  const recordPath = path.join(host.stateDir, 'unidentified', '.batshit-local-runtime-launch.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  record.windowsMembers = []
  await writeFile(recordPath, JSON.stringify(record))
  const live = await host.call('/v1/voice-engines/stop', { owner: 'docker:test', engines: [] })
  assert.deepEqual(live.body.stopped, [])
  assert.match(live.body.notStopped[0].reason, /no process identity was recorded at launch; left running/)
  assert.ok(await identity(engine.pid))

  await taskkill(engine.pid)
  assert.ok(await eventually(async () => !(await identity(engine.pid))))
  const gone = await host.call('/v1/voice-engines/stop', { owner: 'docker:test', engines: [] })
  assert.deepEqual(gone.body.stopped, [])
  assert.match(gone.body.notStopped[0].reason, /root is no longer running/)
  await assert.rejects(readFile(recordPath, 'utf8'), /ENOENT/)
  const again = await host.call('/v1/voice-engines/stop', { owner: 'docker:test', engines: [] })
  assert.deepEqual(again.body.notStopped, [])
})

windowsTest('a live child preserves the old launch record and a shared keep choice after parent handoff', async (t) => {
  const host = await fixture(t)
  const old = await host.start('handoff', { parent: true })
  await taskkill(old.pid)
  assert.ok(await eventually(async () => !(await identity(old.pid)), 4000))
  assert.ok(await identity(old.childPid))
  const keep = await host.call('/v1/voice-engines/stop', {
    owner: 'docker:test',
    engines: [{ engineId: 'shared', endpoint: 'http://127.0.0.1:8222', stopOnShutdown: false }]
  })
  assert.ok(keep.body.keptRunning.some((entry) => entry.pid === old.pid))
  assert.ok(await identity(old.childPid))

  const next = await host.start('handoff')
  const movedPath = path.join(host.stateDir, 'handoff', `.batshit-local-runtime-launch.${old.pid}.json`)
  assert.equal(JSON.parse(await readFile(movedPath, 'utf8')).pid, old.pid)
  assert.ok(await identity(next.pid))
  const attachedPath = path.join(host.stateDir, 'shared', '.batshit-local-runtime-launch.json')
  const attached = JSON.parse(await readFile(attachedPath, 'utf8'))
  assert.equal(attached.pid, old.pid)
})

windowsTest('three simultaneous Windows engines include a three-process stop timing proof', async (t) => {
  const host = await fixture(t)
  const engines = [
    await host.start('one', { parent: true, children: 2 }),
    await host.start('two'),
    await host.start('three')
  ]
  const started = performance.now()
  const answer = await host.call('/v1/voice-engines/stop', { owner: 'docker:test', engines: [] })
  const elapsedMs = Math.round(performance.now() - started)
  t.diagnostic(`three-engine Windows stop: ${elapsedMs} ms; app shutdown limit: 5000 ms; stopped=${answer.body.stopped.length}; notStopped=${answer.body.notStopped.length}`)
  assert.deepEqual(answer.body.notStopped, [])
  assert.deepEqual(answer.body.stopped.map((entry) => entry.pid).sort(), engines.map((entry) => entry.pid).sort())
  assert.ok(await eventually(async () => (await Promise.all(engines.flatMap((entry) => [entry.pid, ...entry.childPids]).map(identity))).every((entry) => !entry)))
})

windowsTest('an old record with a reused root PID cannot block the new engine', async (t) => {
  const host = await fixture(t)
  const engine = await host.start('reused')
  const current = await identity(engine.pid)
  const currentPath = path.join(host.stateDir, 'reused', '.batshit-local-runtime-launch.json')
  const stale = JSON.parse(await readFile(currentPath, 'utf8'))
  stale.engineId = 'stale'
  stale.launchedAt = new Date(current.startedAtMs - 9_000).toISOString()
  stale.windowsMembers = [{ pid: engine.pid, startedAtMs: current.startedAtMs - 10_000 }]
  const stalePath = path.join(host.stateDir, 'stale', '.batshit-local-runtime-launch.json')
  await mkdir(path.dirname(stalePath), { recursive: true })
  await writeFile(stalePath, JSON.stringify(stale))
  const answer = await host.call('/v1/voice-engines/stop', { owner: 'docker:test', engines: [] })
  assert.deepEqual(answer.body.notStopped, [])
  assert.deepEqual(answer.body.stopped.map((entry) => entry.engineIds), [['reused']])
  assert.ok(await eventually(async () => !(await identity(engine.pid))), 'new engine stopped')
  await assert.rejects(readFile(currentPath, 'utf8'), /ENOENT/)
  await assert.rejects(readFile(stalePath, 'utf8'), /ENOENT/)
})

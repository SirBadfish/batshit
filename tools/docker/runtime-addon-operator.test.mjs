// Black-box proof for the Docker host operator's sandbox lane: start the real operator
// against the shared fake `sbx` (`test-fixtures/fake-sbx.mjs`, sbx v0.43.0 behavior) and
// drive it over HTTP. Run with `node --test tools/docker/*.test.mjs`.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const OPERATOR_SCRIPT = fileURLToPath(new URL('./runtime-addon-operator.mjs', import.meta.url))
const FAKE_SBX = fileURLToPath(new URL('./test-fixtures/fake-sbx.mjs', import.meta.url))
const TOKEN = 'test-runtime-addon-operator-token'

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

function waitForListening(child) {
  let output = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Operator did not start:\n${output}`))
    }, 15_000)
    const onData = (chunk) => {
      output += String(chunk)
      if (output.includes('operator listening on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Operator exited with ${code}:\n${output}`))
    })
  })
}

async function startOperator(t, extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-operator-sbx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const bin = path.join(root, 'bin')
  const stateDir = path.join(root, 'sbx-state')
  await mkdir(workspace)
  await mkdir(bin)
  await mkdir(stateDir)
  const sbx = path.join(bin, 'sbx')
  await writeFile(sbx, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SBX}" "$@"\n`)
  await chmod(sbx, 0o755)

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_SBX_STATE: stateDir,
    BATSHIT_RUNTIME_ADDON_OPERATOR_ROOT: root,
    BATSHIT_RUNTIME_ADDON_OPERATOR_ENV_FILE: path.join(root, 'absent.env'),
    BATSHIT_RUNTIME_ADDON_OPERATOR_HOST: '127.0.0.1',
    BATSHIT_RUNTIME_ADDON_OPERATOR_PORT: String(await freePort()),
    BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN: TOKEN,
    BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN: '',
    BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT: workspace,
    BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT: '/workspace',
    ...extraEnv
  }
  const child = spawn(process.execPath, [OPERATOR_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  await waitForListening(child)
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

  const base = `http://127.0.0.1:${env.BATSHIT_RUNTIME_ADDON_OPERATOR_PORT}`
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    stateDir,
    url: base,
    call,
    // Resolves with the operator's exit `{ code, signal }`, however it ends.
    exited,
    // Ends this operator the way a restart does; what it started keeps running.
    stop: async () => {
      child.kill()
      await exited
    },
    // A request the test can give up on, as the app does on a Stop.
    startExecute: (body) => {
      const controller = new AbortController()
      const response = fetch(`${base}/v1/sandbox/execute`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'josh', workspaceRoot: '/workspace', cwd: '/workspace', ...body }),
        signal: controller.signal
      }).then(
        async (answer) => ({ status: answer.status, body: await answer.json() }),
        (error) => ({ aborted: error?.name === 'AbortError', error })
      )
      return { controller, response }
    },
    sbx: (...args) => execFileSync(sbx, args, { env }),
    execute: (command, sessionId) =>
      call('POST', '/v1/sandbox/execute', {
        userId: 'josh',
        ...(sessionId ? { sessionId } : {}),
        workspaceRoot: '/workspace',
        cwd: '/workspace',
        command
      }),
    status: () => call('GET', '/v1/sandbox/status'),
    health: () => call('GET', '/health'),
    events: async () =>
      (await readFile(path.join(stateDir, 'events.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean),
    sandboxNames: async () =>
      (await readdir(path.join(stateDir, 'sandboxes')).catch(() => []))
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace(/\.json$/, ''))
        .sort(),
    seedSandbox: async ({ name, status, lastUsedAt }) => {
      await mkdir(path.join(stateDir, 'sandboxes'), { recursive: true })
      await writeFile(
        path.join(stateDir, 'sandboxes', `${name}.json`),
        JSON.stringify({ name, agent: 'shell', status, last_used_at: lastUsedAt, workspaces: ['/elsewhere'], denyNetwork: ['**'] })
      )
    }
  }
}

test('parallel execute requests for one chat create its sandbox once, with all network denied', async (t) => {
  const operator = await startOperator(t, { FAKE_SBX_CREATE_MS: '300' })

  const responses = await Promise.all(
    ['pwd', 'ls', 'git status'].map((command) => operator.execute(command, 'session-parallel-first-calls'))
  )

  assert.deepEqual(
    responses.map((response) => response.body.error ?? response.body.run?.stdout),
    ['sbx ok\n', 'sbx ok\n', 'sbx ok\n']
  )
  const names = new Set(responses.map((response) => response.body.sandboxName))
  assert.equal(names.size, 1)
  const [name] = names
  const events = await operator.events()
  const creates = events.filter((event) => event.startsWith('create '))
  assert.equal(creates.length, 1)
  assert.match(creates[0], new RegExp(`^create --name ${name} --deny-network \\*\\* shell /`))
  assert.ok(events.includes(`policy deny network --sandbox ${name} **`))
  assert.equal(events.filter((event) => event.startsWith('exec ')).length, 3)
  assert.deepEqual(events.filter((event) => event.startsWith('rm ')), [])
})

test('a sandbox sbx stopped while idle is reused, not replaced', async (t) => {
  const operator = await startOperator(t)
  const first = await operator.execute('pwd', 'session-idle')
  operator.sbx('stop', first.body.sandboxName)

  const second = await operator.execute('ls', 'session-idle')

  assert.equal(second.body.run?.stdout, 'sbx ok\n')
  assert.equal(second.body.sandboxName, first.body.sandboxName)
  const events = await operator.events()
  assert.equal(events.filter((event) => event.startsWith('create ')).length, 1)
  assert.deepEqual(events.filter((event) => event.startsWith('rm ')), [])
})

test('only Batshit sandboxes left unused for an hour are pruned', async (t) => {
  const operator = await startOperator(t)
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString()
  await operator.seedSandbox({ name: 'batshit-josh-sdeadbeef-0000000001', status: 'stopped', lastUsedAt: hoursAgo(2) })
  await operator.seedSandbox({ name: 'batshit-josh-sfeedface-0000000002', status: 'stopped', lastUsedAt: hoursAgo(0.02) })
  await operator.seedSandbox({ name: 'someone-elses-sandbox', status: 'stopped', lastUsedAt: hoursAgo(5) })

  const oneShot = await operator.execute('pwd')

  assert.equal(oneShot.body.run?.stdout, 'sbx ok\n')
  assert.deepEqual(
    (await operator.events()).filter((event) => event.startsWith('rm ')),
    [`rm --force ${oneShot.body.sandboxName}`, 'rm --force batshit-josh-sdeadbeef-0000000001']
  )
  assert.deepEqual(await operator.sandboxNames(), ['batshit-josh-sfeedface-0000000002', 'someone-elses-sandbox'])
})

test('status says what to set up, and health reports the sandbox revision', async (t) => {
  const operator = await startOperator(t)
  const ready = await operator.status()
  assert.equal(ready.body.available, true)
  assert.equal(ready.body.cli, 'sbx')
  const revision = (await operator.health()).body.sandboxRevision
  assert.equal(revision, 6)
  // `start-docker` replaces an operator that reports less than it requires, so the two move
  // together or users keep the old operator after an update.
  const launcher = await readFile(fileURLToPath(new URL('./start-docker.mjs', import.meta.url)), 'utf8')
  assert.match(launcher, new RegExp(`const REQUIRED_OPERATOR_SANDBOX_REVISION = ${revision}\\n`))

  await writeFile(path.join(operator.stateDir, '.not-signed-in'), '')
  const signedOut = await operator.status()
  assert.equal(signedOut.body.available, false)
  assert.match(signedOut.body.reason, /Run `sbx login`/)
  const refused = await operator.execute('pwd', 'session-signed-out')
  assert.equal(refused.status, 500)
  assert.match(refused.body.error, /Run `sbx login`/)

  await rm(path.join(operator.stateDir, '.not-signed-in'))
  await writeFile(path.join(operator.stateDir, '.policy-not-initialized'), '')
  const noPreset = await operator.status()
  assert.equal(noPreset.body.available, false)
  assert.match(noPreset.body.reason, /Run `sbx policy init balanced`/)
})

// A Stop or a timeout also ends what the command left running INSIDE the sandbox (2026-09-18).
// The app ends its request to the operator at once on a Stop; the operator used to run its
// `sbx exec` on regardless, and real sbx does not pass a SIGTERM into the sandbox (measured: the
// whole command ran on inside, and the client exited 28.9 s after its SIGTERM). The fake plays
// the command's program inside as a real process (`inside/<tag>.pid`).
async function whenInsideRuns(stateDir) {
  for (let tries = 0; tries < 200; tries += 1) {
    const [file] = (await readdir(path.join(stateDir, 'inside')).catch(() => [])).filter((name) =>
      name.endsWith('.pid')
    )
    if (file) {
      return {
        tag: file.replace(/\.pid$/, ''),
        pid: Number(await readFile(path.join(stateDir, 'inside', file), 'utf8'))
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the fake sbx never started the command inside its sandbox')
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return Boolean(await check())
}

function killLeftovers(t, stateDir) {
  t.after(async () => {
    for (const file of await readdir(path.join(stateDir, 'inside')).catch(() => [])) {
      const pid = Number(await readFile(path.join(stateDir, 'inside', file), 'utf8').catch(() => ''))
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  })
}

test('a request the app gives up on (a Stop) ends the command and what it left running inside', async (t) => {
  const operator = await startOperator(t, { FAKE_SBX_EXEC_MS: '5000' })
  killLeftovers(t, operator.stateDir)
  const request = operator.startExecute({ command: 'sleep 20', sessionId: 'session-operator-stop' })
  const inside = await whenInsideRuns(operator.stateDir)

  request.controller.abort()
  assert.equal((await request.response).aborted, true)

  const exec = (await operator.events()).find((event) => event.includes(`BATSHIT_COMMAND_ID=${inside.tag}`))
  assert.ok(exec, 'the command carried its tag')
  const name = / BATSHIT_COMMAND_ID=\S+ (\S+) \/bin\/bash /.exec(exec)?.[1]
  assert.ok(
    await waitFor(async () => (await operator.events()).includes(`end ${name} ${inside.tag}`), 1_500),
    'the end ran in the same sandbox with the same tag'
  )
  assert.ok(await waitFor(() => !isRunning(inside.pid), 1_500), 'the program inside is gone')
})

test('the operator’s own timeout ends the command and what it left running inside, the same way', async (t) => {
  // The end takes longer than the client's second to its SIGKILL, so the answer must wait for it.
  const operator = await startOperator(t, { FAKE_SBX_EXEC_MS: '5000', FAKE_SBX_END_MS: '1500' })
  killLeftovers(t, operator.stateDir)
  const started = Date.now()
  const request = operator.startExecute({ command: 'sleep 20', sessionId: 'session-operator-timeout', timeoutMs: 1_000 })
  const inside = await whenInsideRuns(operator.stateDir)

  const answer = await request.response

  assert.equal(answer.status, 200)
  assert.equal(answer.body.run.timedOut, true)
  assert.ok(Date.now() - started < 4_500)
  assert.ok((await operator.events()).includes(`end-done ${answer.body.sandboxName} ${inside.tag}`))
  assert.ok(await waitFor(() => !isRunning(inside.pid), 1_000), 'the program inside is gone')
})

test('a command that finishes by itself needs no end command', async (t) => {
  const operator = await startOperator(t, { FAKE_SBX_EXEC_MS: '200' })
  killLeftovers(t, operator.stateDir)

  const answer = await operator.execute('sleep 0.2', 'session-operator-finishes')

  assert.equal(answer.body.run.stdout, 'sbx ok\n')
  assert.deepEqual((await operator.events()).filter((event) => event.startsWith('end ')), [])
})

test('a request given up while its sandbox starts lets the start finish and never runs the command', async (t) => {
  const operator = await startOperator(t, { FAKE_SBX_CREATE_MS: '800' })
  const request = operator.startExecute({ command: 'touch ran', sessionId: 'session-operator-stop-starting' })
  assert.ok(await waitFor(async () => (await operator.events()).some((event) => event.startsWith('create ')), 3_000))

  request.controller.abort()
  await request.response
  // The create finishes, and nothing runs after it.
  assert.ok(await waitFor(async () => (await operator.sandboxNames()).length === 1, 3_000))
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.deepEqual((await operator.events()).filter((event) => event.startsWith('exec ')), [])
})

// ---- "Stop with Batshit" for host voice engines (revision 5, 2026-09-18) ---------------------
// The operator starts host-native voice engines for containerized Batshit, which cannot reach
// host processes itself. It records what it starts, in its own folder, and stops it on request
// with the same shared decision the Mac supervisor uses (`local-voice-runtime-stop.mjs`).

async function voiceHost(t) {
  const hostRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-operator-voice-'))
  const stateDir = path.join(hostRoot, 'runtime', 'runtime-addon-operator', 'voice-engines')
  // A real host has these once any engine is installed; the operator resolves them up front.
  await mkdir(path.join(hostRoot, 'runtime'), { recursive: true })
  const started = new Set()
  t.after(async () => {
    for (const pid of started) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL')
        } catch {}
      }
    }
    await rm(hostRoot, { recursive: true, force: true })
  })
  // An "engine" whose command line carries its install path, like a real one.
  const install = async (engineId) => {
    const installRoot = path.join(hostRoot, 'installs', engineId)
    await mkdir(installRoot, { recursive: true })
    const command = path.join(installRoot, 'fake-voice-engine')
    await writeFile(command, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`)
    await chmod(command, 0o755)
    return { installRoot, command }
  }
  return {
    hostRoot,
    stateDir,
    started,
    install,
    env: { BATSHIT_HOST_RUNTIME_ROOT: hostRoot, BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR: stateDir }
  }
}

async function startVoiceEngine(operator, host, engineId, { port, stopOnShutdown } = {}) {
  const { installRoot, command } = await host.install(engineId)
  const answer = await operator.call('POST', '/v1/voice-engines/start', {
    engineId,
    installRoot,
    launch: { command, args: ['--port', String(port)] },
    endpoint: `http://127.0.0.1:${port}`,
    ...(stopOnShutdown === undefined ? {} : { stopOnShutdown })
  })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  host.started.add(answer.body.pid)
  assert.ok(await waitFor(() => isRunning(answer.body.pid), 2_000), `${engineId} is running`)
  return answer.body
}

async function recordFiles(host, engineId) {
  return (await readdir(path.join(host.stateDir, engineId)).catch(() => [])).sort()
}

async function readRecord(host, engineId) {
  return JSON.parse(await readFile(path.join(host.stateDir, engineId, '.batshit-local-runtime-launch.json'), 'utf8'))
}

test('health offers the voice-engine stop', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const health = (await operator.health()).body
  assert.deepEqual(health.hostVoiceControls, ['start', 'stop', 'write-reference-audio'])
  assert.equal(health.hostVoice.stateDir, host.stateDir)
})

test('the operator records what it starts, and stops it as the engine’s choice says', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const started = await startVoiceEngine(operator, host, 'kokoro', { port: 8010, stopOnShutdown: true })

  assert.equal(started.recorded, true)
  const record = await readRecord(host, 'kokoro')
  assert.deepEqual(
    { pid: record.pid, command: record.command, endpoint: record.endpoint, stop: record.stopOnShutdown },
    { pid: started.pid, command: started.command, endpoint: 'http://127.0.0.1:8010', stop: true }
  )

  // Keep running: the process and its record both stay, with the choice the app sent.
  const kept = await operator.call('POST', '/v1/voice-engines/stop', {
    engines: [{ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: false }]
  })
  assert.equal(kept.status, 200)
  assert.deepEqual(kept.body.keptRunning.map((entry) => entry.engineIds), [['kokoro']])
  assert.equal(isRunning(started.pid), true)
  assert.equal((await readRecord(host, 'kokoro')).stopOnShutdown, false)

  const stopped = await operator.call('POST', '/v1/voice-engines/stop', {
    engines: [{ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: true }]
  })
  assert.deepEqual(stopped.body.stopped, [{ pid: started.pid, engineIds: ['kokoro'] }])
  assert.ok(await waitFor(() => !isRunning(started.pid), 3_000), 'kokoro is gone')
  assert.deepEqual(await recordFiles(host, 'kokoro'), [])
})

test('a runtime two engines share stops only when both say stop', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const started = await startVoiceEngine(operator, host, 'chatterbox-turbo', { port: 8012 })
  const choices = (qwenStops) => ({
    engines: [
      { engineId: 'chatterbox-turbo', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true },
      // Uses the same runtime (same port), which it did not start.
      { engineId: 'qwen3-tts', endpoint: 'http://localhost:8012/', stopOnShutdown: qwenStops }
    ]
  })

  const kept = await operator.call('POST', '/v1/voice-engines/stop', choices(false))
  assert.match(kept.body.keptRunning[0].reason, /Stop with Batshit is off for "qwen3-tts"/)
  assert.equal(isRunning(started.pid), true)
  assert.equal((await readRecord(host, 'qwen3-tts')).startedBy, 'chatterbox-turbo')

  const stopped = await operator.call('POST', '/v1/voice-engines/stop', choices(true))
  assert.deepEqual(stopped.body.stopped.map((entry) => entry.engineIds.sort()), [['chatterbox-turbo', 'qwen3-tts']])
  assert.ok(await waitFor(() => !isRunning(started.pid), 3_000))
  assert.deepEqual([...(await recordFiles(host, 'chatterbox-turbo')), ...(await recordFiles(host, 'qwen3-tts'))], [])
})

test('an engine whose interpreter re-executes itself under another path still stops (BL-60)', async (t) => {
  // The python.org framework Python re-executes itself as `…/Python.app/Contents/MacOS/Python`,
  // so a venv engine's live command line holds no path inside the operator's roots. The launch
  // time the operator recorded names the process instead.
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const installRoot = path.join(host.hostRoot, 'installs', 'dots-tts-mf')
  await mkdir(installRoot, { recursive: true })
  const command = path.join(installRoot, 'python')
  await writeFile(command, `#!/bin/sh\nexec "${process.execPath}" -e "setInterval(() => {}, 1000)"\n`)
  await chmod(command, 0o755)
  const answer = await operator.call('POST', '/v1/voice-engines/start', {
    engineId: 'dots-tts-mf',
    installRoot,
    launch: { command, args: ['-m', 'uvicorn', 'server:app', '--port', '8122'] },
    endpoint: 'http://127.0.0.1:8122'
  })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  host.started.add(answer.body.pid)
  assert.ok(await waitFor(() => isRunning(answer.body.pid), 2_000))

  const stopped = await operator.call('POST', '/v1/voice-engines/stop', { engines: [] })

  assert.deepEqual(stopped.body.stopped, [{ pid: answer.body.pid, engineIds: ['dots-tts-mf'] }])
  assert.ok(await waitFor(() => !isRunning(answer.body.pid), 3_000))
  assert.deepEqual(await recordFiles(host, 'dots-tts-mf'), [])
})

// ---- The operator stops with Docker Batshit (2026-09-21, BL-59) ----------------------------
//
// It used to run from login forever. Now it asks Docker whether any `app` container holding its
// token is up, and stops what it started, then exits cleanly, once none has been for a while. A
// fake `docker` answers `ps` from a list of containers and `inspect` with each one's environment,
// or fails like a Docker that is not running.

async function fakeDocker(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-fake-docker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  await mkdir(bin)
  await writeFile(
    path.join(bin, 'docker'),
    `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const root = ${JSON.stringify(root)}
fs.appendFileSync(path.join(root, 'calls.log'), process.argv.slice(2).join(' ') + '\\n')
if (fs.existsSync(path.join(root, 'down'))) {
  process.stderr.write('failed to connect to the docker API\\n')
  process.exit(1)
}
const containers = fs.existsSync(path.join(root, 'containers.json'))
  ? JSON.parse(fs.readFileSync(path.join(root, 'containers.json'), 'utf8'))
  : []
const [command, ...rest] = process.argv.slice(2)
if (command === 'ps') {
  for (const container of containers) console.log(container.id)
} else if (command === 'inspect') {
  for (const id of rest.slice(2)) console.log(JSON.stringify((containers.find((c) => c.id === id) || {}).env || []))
} else {
  process.exit(2)
}
`
  )
  await chmod(path.join(bin, 'docker'), 0o755)
  const launchAgent = path.join(root, 'ai.batshit.sandbox-operator.plist')
  await writeFile(launchAgent, '<plist/>\n')
  return {
    launchAgent,
    // Containers `docker ps` lists as up (the filters are Docker's to apply), each with its env.
    up: (containers) => writeFile(path.join(root, 'containers.json'), JSON.stringify(containers)),
    down: () => writeFile(path.join(root, 'down'), ''),
    calls: async () => (await readFile(path.join(root, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean),
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      BATSHIT_RUNTIME_ADDON_OPERATOR_WATCH_MS: '100',
      BATSHIT_RUNTIME_ADDON_OPERATOR_GONE_AFTER_MS: '600',
      BATSHIT_RUNTIME_ADDON_OPERATOR_UNREACHABLE_AFTER_MS: '2000',
      BATSHIT_RUNTIME_ADDON_OPERATOR_LAUNCH_AGENT: launchAgent,
      XPC_SERVICE_NAME: '0'
    }
  }
}

const ours = { id: 'app-ours', env: ['PATH=/usr/bin', `BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN=${TOKEN}`] }
const within = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still running'), ms))])

test('the operator keeps running while a Docker Batshit that holds its token is up', async (t) => {
  const docker = await fakeDocker(t)
  await docker.up([ours])
  const operator = await startOperator(t, docker.env)

  assert.equal(await within(operator.exited, 1_500), 'still running')
  const health = (await operator.health()).body
  assert.deepEqual(health.watch, { enabled: true, launchAgent: docker.launchAgent, startedByOldLoginItem: false })
  const calls = await docker.calls()
  assert.ok(calls.some((call) => call.startsWith('ps --filter label=com.docker.compose.service=app --filter status=running --filter status=paused --filter status=restarting')))
  assert.ok(calls.some((call) => call === 'inspect --format {{json .Config.Env}} app-ours'))
})

test('once Docker Batshit is stopped, the operator stops what it started, removes its login item, and exits', async (t) => {
  const docker = await fakeDocker(t)
  await docker.up([ours])
  const host = await voiceHost(t)
  const operator = await startOperator(t, { ...host.env, ...docker.env })
  const stops = await startVoiceEngine(operator, host, 'kokoro', { port: 8010 })
  const keeps = await startVoiceEngine(operator, host, 'whisper-cpp', { port: 8077, stopOnShutdown: false })

  // Another Docker Batshit (another token) is still up: it is not this operator's client.
  await docker.up([{ id: 'app-other', env: ['BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN=someone-elses-token'] }])
  const exit = await within(operator.exited, 5_000)

  assert.deepEqual(exit, { code: 0, signal: null })
  assert.ok(await waitFor(() => !isRunning(stops.pid), 3_000), 'kokoro stopped')
  assert.equal(isRunning(keeps.pid), true, 'an engine set to keep running keeps running')
  assert.deepEqual(await recordFiles(host, 'kokoro'), [])
  assert.deepEqual(await recordFiles(host, 'whisper-cpp'), ['.batshit-local-runtime-launch.json'])
  await assert.rejects(readFile(docker.launchAgent, 'utf8'), { code: 'ENOENT' })
})

test('while Docker does not answer, the operator waits; it gives up only much later, keeping its login item', async (t) => {
  const docker = await fakeDocker(t)
  await docker.down()
  const operator = await startOperator(t, docker.env)

  // Past the ten minutes (600 ms here) Docker Batshit gets when Docker answers: still waiting.
  assert.equal(await within(operator.exited, 1_200), 'still running')
  const exit = await within(operator.exited, 5_000)

  assert.deepEqual(exit, { code: 0, signal: null })
  assert.equal(await readFile(docker.launchAgent, 'utf8'), '<plist/>\n')
})

test('an operator an older login item started keeps running, so launchd does not restart it in a loop', async (t) => {
  const docker = await fakeDocker(t)
  await docker.up([])
  const { BATSHIT_RUNTIME_ADDON_OPERATOR_LAUNCH_AGENT: _unused, ...withoutLoginItem } = docker.env
  const operator = await startOperator(t, { ...withoutLoginItem, XPC_SERVICE_NAME: 'ai.batshit.sandbox-operator' })

  assert.equal(await within(operator.exited, 1_500), 'still running')
  assert.deepEqual((await operator.health()).body.watch, { enabled: false, launchAgent: null, startedByOldLoginItem: true })
})

test('the operator records the sbx daemon its own call started (BL-61)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, { ...host.env, FAKE_SBX_STARTS_DAEMON: '1' })

  const before = Date.now()
  assert.equal((await operator.status()).body.available, true)

  const record = JSON.parse(
    await readFile(
      path.join(host.hostRoot, 'runtime', 'runtime-addon-operator', 'sbx-daemon', '.batshit-sbx-daemon-launch.json'),
      'utf8'
    )
  )
  assert.match(record.launchedBy, /^docker-operator:/)
  assert.ok(Date.parse(record.callStartedAt) >= before)
  assert.ok(Date.parse(record.callEndedAt) >= Date.parse(record.callStartedAt))
})

test('a restarted operator still stops what the first one started', async (t) => {
  const host = await voiceHost(t)
  const first = await startOperator(t, host.env)
  const started = await startVoiceEngine(first, host, 'whisper-cpp', { port: 8077 })
  await first.stop()
  assert.equal(isRunning(started.pid), true, 'an operator restart leaves the engine running')

  const second = await startOperator(t, host.env)
  // The app names no engine: a recorded engine with no saved choice stops (absent means stop).
  const stopped = await second.call('POST', '/v1/voice-engines/stop', { engines: [] })
  assert.deepEqual(stopped.body.stopped, [{ pid: started.pid, engineIds: ['whisper-cpp'] }])
  assert.ok(await waitFor(() => !isRunning(started.pid), 3_000))
})

test('the operator never stops what it did not start, and refuses a pid that changed hands', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { command } = await host.install('someone-elses')
  const stranger = spawn(command, [], { detached: true, stdio: 'ignore' })
  stranger.unref()
  host.started.add(stranger.pid)
  assert.ok(await waitFor(() => isRunning(stranger.pid), 2_000))

  // A record naming the stranger's pid with another command: what a reused pid looks like.
  await mkdir(path.join(host.stateDir, 'whisper-cpp'), { recursive: true })
  await writeFile(
    path.join(host.stateDir, 'whisper-cpp', '.batshit-local-runtime-launch.json'),
    JSON.stringify({ engineId: 'whisper-cpp', pid: stranger.pid, command: '/opt/whisper/bin/whisper-server', args: ['--port', '8077'] })
  )
  // Launch args come from the app container, the less trusted side of this boundary. A record
  // whose args (or command, or cwd) are paths outside the operator's own roots, `/` above all,
  // must not match a process that later took its pid: only paths the operator validated count.
  const { command: strangerTwoCommand } = await host.install('someone-elses-too')
  const strangerTwo = spawn(strangerTwoCommand, [], { detached: true, stdio: 'ignore' })
  strangerTwo.unref()
  host.started.add(strangerTwo.pid)
  assert.ok(await waitFor(() => isRunning(strangerTwo.pid), 2_000))
  await mkdir(path.join(host.stateDir, 'kokoro'), { recursive: true })
  await writeFile(
    path.join(host.stateDir, 'kokoro', '.batshit-local-runtime-launch.json'),
    JSON.stringify({ engineId: 'kokoro', pid: strangerTwo.pid, command: '/', cwd: '/', args: ['/', '--port', '8010'] })
  )

  const answer = await operator.call('POST', '/v1/voice-engines/stop', {
    // An engine whose endpoint no operator launch serves gets no record and stops nothing.
    engines: [{ engineId: 'connected-tts', endpoint: 'http://127.0.0.1:9100', stopOnShutdown: true }]
  })

  assert.equal(answer.body.notStopped.length, 2)
  for (const refused of answer.body.notStopped) assert.match(refused.reason, /no longer matches its launch record/)
  assert.deepEqual(answer.body.stopped, [])
  assert.equal(isRunning(stranger.pid), true)
  assert.equal(isRunning(strangerTwo.pid), true)
  assert.deepEqual(await recordFiles(host, 'connected-tts'), [])
})

test('the voice-engine stop needs the operator token', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const answer = await fetch(`${operator.url}/v1/voice-engines/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engines: [] })
  })
  assert.equal(answer.status, 401)
})

test('a runtime’s log can never be pointed into the operator’s own records', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { installRoot, command } = await host.install('kokoro')
  const answer = await operator.call('POST', '/v1/voice-engines/start', {
    engineId: 'kokoro',
    installRoot,
    launch: { command, logPath: path.join(host.stateDir, 'kokoro', '.batshit-local-runtime-launch.json') }
  })
  assert.equal(answer.status, 500)
  assert.match(answer.body.error, /must not be inside the operator's own state folder/)
})

test('a record naming a live pid that leads no process group is dropped, and nothing is killed', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { command, installRoot } = await host.install('non-leader')
  const child = spawn(command, [], { stdio: 'ignore' }) // not detached: it leads no group
  child.unref()
  host.started.add(child.pid)
  assert.ok(await waitFor(() => isRunning(child.pid), 2_000))
  await mkdir(path.join(host.stateDir, 'reused'), { recursive: true })
  await writeFile(
    path.join(host.stateDir, 'reused', '.batshit-local-runtime-launch.json'),
    JSON.stringify({ engineId: 'reused', pid: child.pid, command, cwd: installRoot, args: [] })
  )

  const answer = await operator.call('POST', '/v1/voice-engines/stop', { engines: [] })

  assert.match(answer.body.notStopped[0].reason, /no longer matches its launch record/)
  assert.equal(isRunning(child.pid), true)
  assert.deepEqual(await recordFiles(host, 'reused'), [])
})

test('an engine the app no longer names (deleted, or moved to another port) stops holding a shared runtime up', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const deleted = await startVoiceEngine(operator, host, 'chatterbox-turbo', { port: 8012 })
  const choices = (qwen) => ({
    engines: [{ engineId: 'chatterbox-turbo', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true }, ...qwen]
  })

  // qwen3-tts shares the runtime and says keep running: kept.
  await operator.call('POST', '/v1/voice-engines/stop', choices([{ engineId: 'qwen3-tts', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false }]))
  assert.equal(isRunning(deleted.pid), true)
  // Moved to another port: its old attach record no longer counts.
  const moved = await operator.call('POST', '/v1/voice-engines/stop', choices([{ engineId: 'qwen3-tts', endpoint: 'http://127.0.0.1:8013', stopOnShutdown: false }]))
  assert.deepEqual(moved.body.stopped, [{ pid: deleted.pid, engineIds: ['chatterbox-turbo'] }])
  assert.ok(await waitFor(() => !isRunning(deleted.pid), 3_000))
  assert.deepEqual(await recordFiles(host, 'qwen3-tts'), [])

  // An engine the app no longer names at all (deleted) no longer holds its own launch up either.
  const own = await startVoiceEngine(operator, host, 'kokoro', { port: 8010, stopOnShutdown: false })
  await operator.call('POST', '/v1/voice-engines/stop', { engines: [{ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: false }] })
  assert.equal(isRunning(own.pid), true)
  const gone = await operator.call('POST', '/v1/voice-engines/stop', { engines: [] })
  assert.deepEqual(gone.body.stopped, [{ pid: own.pid, engineIds: ['kokoro'] }])
})

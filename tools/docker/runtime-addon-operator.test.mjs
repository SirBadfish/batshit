// Black-box proof for the Docker host operator's sandbox lane: start the real operator
// against the shared fake `sbx` (`test-fixtures/fake-sbx.mjs`, sbx v0.43.0 behavior) and
// drive it over HTTP. Run with `node --test tools/docker/*.test.mjs`.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const OPERATOR_SCRIPT = fileURLToPath(new URL('./runtime-addon-operator.mjs', import.meta.url))
const FAKE_SBX = fileURLToPath(new URL('./test-fixtures/fake-sbx.mjs', import.meta.url))
const TOKEN = 'test-runtime-addon-operator-token'
const VOICE_RECIPE_SIGNING_KEY = 'a'.repeat(64)

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
  const keyDir = path.join(root, 'host-private')
  await mkdir(keyDir, { mode: 0o700 })
  const keyFile = path.join(keyDir, 'voice-recipe.key')
  await writeFile(keyFile, `${VOICE_RECIPE_SIGNING_KEY}\n`, { mode: 0o600 })
  const sbx = path.join(bin, 'sbx')
  await writeFile(sbx, `#!/bin/sh
if [ "$1" = "exec" ]; then
  case "$*" in
    *__batshit_output_limit__*)
      exec "${process.execPath}" -e "process.stdout.write('x'.repeat(Number(process.env.FAKE_SBX_STDOUT_CHARS || 0))); process.stderr.write('y'.repeat(Number(process.env.FAKE_SBX_STDERR_CHARS || 0)))"
      ;;
  esac
fi
exec "${process.execPath}" "${FAKE_SBX}" "$@"
`)
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
    BATSHIT_HOST_VOICE_RECIPE_KEY_FILE: keyFile,
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
  const signedVoiceRecipe = (recipe, { issuedAt = Date.now() } = {}) => {
    const nonce = randomUUID()
    const signature = createHmac('sha256', Buffer.from(VOICE_RECIPE_SIGNING_KEY, 'hex'))
      .update('batshit-host-voice-start-v1\0')
      .update(`${issuedAt}\0${nonce}\0${JSON.stringify(recipe)}`)
      .digest('hex')
    return { ...recipe, proof: { issuedAt, nonce, signature } }
  }
  const startVoice = (recipe) => call('POST', '/v1/voice-engines/start', signedVoiceRecipe(recipe))
  return {
    stateDir,
    keyFile,
    url: base,
    call,
    startVoice,
    signedVoiceRecipe,
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
    execute: (command, sessionId, maxOutputChars) =>
      call('POST', '/v1/sandbox/execute', {
        userId: 'josh',
        ...(sessionId ? { sessionId } : {}),
        workspaceRoot: '/workspace',
        cwd: '/workspace',
        command,
        ...(maxOutputChars ? { maxOutputChars } : {})
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

test('the sbx client never inherits host operator authority', async (t) => {
  const operator = await startOperator(t, {
    FAKE_SBX_ASSERT_NO_AUTHORITY: '1',
    BATSHIT_TOKEN: 'app-service-secret',
    BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY: VOICE_RECIPE_SIGNING_KEY
  })
  const answer = await operator.execute('pwd')
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  assert.equal(answer.body.run?.stdout, 'sbx ok\n')
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
  assert.equal(revision, 12)
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

test('sandbox output at the exact per-stream limit is not marked cut', async (t) => {
  const operator = await startOperator(t, {
    FAKE_SBX_STDOUT_CHARS: '120000',
    FAKE_SBX_STDERR_CHARS: '120000'
  })

  const answer = await operator.execute('__batshit_output_limit__', 'session-exact-output')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.run.truncated, false)
  assert.equal(answer.body.run.stdout, 'x'.repeat(120_000))
  assert.equal(answer.body.run.stderr, 'y'.repeat(120_000))
})

test('sandbox output uses the requested lower limit and marks both cut streams', async (t) => {
  const operator = await startOperator(t, {
    FAKE_SBX_STDOUT_CHARS: '120001',
    FAKE_SBX_STDERR_CHARS: '120001'
  })

  const defaultLimit = await operator.execute('__batshit_output_limit__', 'session-default-cut-output')
  assert.equal(defaultLimit.status, 200)
  assert.equal(defaultLimit.body.run.truncated, true)
  for (const output of [defaultLimit.body.run.stdout, defaultLimit.body.run.stderr]) {
    assert.ok(output.length <= 120_000)
    assert.ok(output.endsWith('[Output cut here by Batshit: the command printed more than 120,000 characters.]'))
  }

  const answer = await operator.execute('__batshit_output_limit__', 'session-cut-output', 1_000)
  assert.equal(answer.status, 200)
  assert.equal(answer.body.run.truncated, true)
  for (const output of [answer.body.run.stdout, answer.body.run.stderr]) {
    assert.ok(output.length <= 1_000)
    assert.ok(output.endsWith('[Output cut here by Batshit: the command printed more than 1,000 characters.]'))
  }
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

async function startVoiceEngine(operator, host, engineId, { port, stopOnShutdown, owner } = {}) {
  const { installRoot, command } = await host.install(engineId)
  const answer = await operator.startVoice({
    engineId,
    installRoot,
    launch: { command, args: ['--port', String(port)] },
    endpoint: `http://127.0.0.1:${port}`,
    ...(stopOnShutdown === undefined ? {} : { stopOnShutdown }),
    ...(owner === undefined ? {} : { owner })
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

test('a missing recipe key disables host launch visibly while other controls remain available', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, { ...host.env, BATSHIT_HOST_VOICE_RECIPE_KEY_FILE: path.join(host.hostRoot, 'missing-key') })
  const health = (await operator.health()).body
  assert.equal(health.hostVoiceControls.includes('start'), false)
  assert.equal(health.hostVoiceControls.includes('write-reference-audio'), true)
  const { installRoot, command } = await host.install('missing-key')
  const answer = await operator.startVoice({ engineId: 'missing-key', installRoot, launch: { command } })
  assert.equal(answer.status, 500)
  assert.match(answer.body.error, /signing key is not configured/i)
})

test('an operator token alone cannot launch a caller-chosen host program', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { installRoot, command } = await host.install('unapproved')
  const answer = await operator.call('POST', '/v1/voice-engines/start', {
    engineId: 'unapproved', installRoot, launch: { command, args: ['--arbitrary'] }
  })
  if (answer.body.pid) host.started.add(answer.body.pid)
  assert.equal(answer.status, 500)
  assert.match(answer.body.error, /saved voice launch recipe|proof/i)
  assert.deepEqual(await recordFiles(host, 'unapproved'), [])
})

test('reference audio rejects executable extensions and non-audio content types', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const profileId = 'voice_security_test'
  for (const [filename, contentType] of [
    ['sample.cmd', 'audio/wav'],
    ['sample.wav', 'application/octet-stream'],
    ['sample.mp3', 'audio/wav']
  ]) {
    const answer = await operator.call('POST', '/v1/voice-profiles/reference-audio', {
      profileId, filename, contentType, audioBase64: Buffer.from('RIFF audio').toString('base64')
    })
    assert.equal(answer.status, 500, `${filename} ${contentType}: ${JSON.stringify(answer.body)}`)
  }
  assert.deepEqual(await readdir(path.join(host.hostRoot, 'voice-profiles', profileId)).catch(() => []), [])
})

test('a saved recipe proof binds args and can be used only once', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { installRoot, command } = await host.install('proof-check')
  const signed = operator.signedVoiceRecipe({
    engineId: 'proof-check', installRoot, launch: { command, args: ['--port', '8020'] }
  })
  const changed = structuredClone(signed)
  changed.launch.args[1] = '8021'
  const tampered = await operator.call('POST', '/v1/voice-engines/start', changed)
  assert.equal(tampered.status, 500)
  assert.match(tampered.body.error, /proof is invalid/i)

  const stale = await operator.call(
    'POST', '/v1/voice-engines/start',
    operator.signedVoiceRecipe({ engineId: 'proof-check', installRoot, launch: { command } }, {
      issuedAt: Date.now() - 60_000
    })
  )
  assert.equal(stale.status, 500)
  assert.match(stale.body.error, /fresh saved voice launch recipe proof/i)

  const accepted = await operator.call('POST', '/v1/voice-engines/start', signed)
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  host.started.add(accepted.body.pid)
  const replay = await operator.call('POST', '/v1/voice-engines/start', signed)
  assert.equal(replay.status, 500)
  assert.match(replay.body.error, /already used/i)

  await operator.stop()
  const restarted = await startOperator(t, {
    ...host.env,
    BATSHIT_HOST_VOICE_RECIPE_KEY_FILE: operator.keyFile
  })
  // The replacement test process has a new private fixture key. Point it to the first
  // process's key and nonce receipts to prove the receipt survives its lifetime.
  const replayAfterRestart = await restarted.call('POST', '/v1/voice-engines/start', signed)
  assert.equal(replayAfterRestart.status, 500)
  assert.match(replayAfterRestart.body.error, /already used/i)
})

test('saved voice recipes cannot smuggle inline code through interpreter flags or launch env', { skip: process.platform === 'win32' }, async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const installRoot = path.join(host.hostRoot, 'installs', 'interpreter-check')
  await mkdir(installRoot, { recursive: true })
  for (const [name, args] of [
    ['pythonw3.12', ['-Ic', 'print(1)']],
    ['pypy3', ['-uc', 'print(1)']],
    ['node', ['--import=data:text/javascript,console.log(1)']],
    ['node', ['--loader', 'data:text/javascript,console.log(1)']],
    ['node', ['-rdata:text/javascript,console.log(1)']]
  ]) {
    const command = path.join(installRoot, name)
    await writeFile(command, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`)
    await chmod(command, 0o755)
    const answer = await operator.startVoice({ engineId: 'interpreter-check', installRoot, launch: { command, args } })
    assert.equal(answer.status, 500, `${name} ${args.join(' ')}: ${JSON.stringify(answer.body)}`)
    assert.match(answer.body.error, /Inline eval-style/)
  }
  const command = path.join(installRoot, 'node')
  for (const key of ['NODE_OPTIONS', 'node_options', 'PYTHONPATH', 'pythonstartup']) {
    const answer = await operator.startVoice({
      engineId: 'interpreter-check', installRoot,
      launch: { command, env: { [key]: '--import=data:text/javascript,console.log(1)' } }
    })
    assert.equal(answer.status, 500, `${key}: ${JSON.stringify(answer.body)}`)
    assert.match(answer.body.error, /Launch env name/)
  }
})

test('voice profiles cannot be launched even if a saved recipe points there', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const profileDir = path.join(host.hostRoot, 'voice-profiles', 'voice_launch_check')
  await mkdir(profileDir, { recursive: true })
  const command = path.join(profileDir, 'reference.wav')
  await writeFile(command, Buffer.from('arbitrary uploaded bytes are not an executable launch recipe'))
  await chmod(command, 0o755)
  const answer = await operator.startVoice({
    engineId: 'profile-launch-check', installRoot: profileDir, launch: { command }
  })
  if (answer.body.pid) host.started.add(answer.body.pid)
  assert.equal(answer.status, 500)
  assert.match(answer.body.error, /voice profiles/i)
})

test('a launched voice process never inherits operator or recipe credentials', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, { ...host.env, BATSHIT_TOKEN: 'service-test-token' })
  const installRoot = path.join(host.hostRoot, 'installs', 'credential-check')
  await mkdir(installRoot, { recursive: true })
  const command = path.join(installRoot, 'check-credentials')
  const output = path.join(installRoot, 'received.json')
  await writeFile(command, `#!${process.execPath}\nconst fs = require('fs')\nfs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ operator: process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN, recipe: process.env.BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY, service: process.env.BATSHIT_TOKEN }))\nsetInterval(() => {}, 1000)\n`)
  await chmod(command, 0o755)
  const answer = await operator.startVoice({
    engineId: 'credential-check', installRoot,
    launch: { command, env: { BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY: 'injected' } }
  })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  host.started.add(answer.body.pid)
  assert.ok(await waitFor(async () => Boolean(await readFile(output).catch(() => null)), 2_000))
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {})
})

test('a supported reference audio filename and content type save to the profile root', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const audio = Buffer.alloc(32 * 1024, 0)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  const answer = await operator.call('POST', '/v1/voice-profiles/reference-audio', {
    profileId: 'voice_valid_audio', filename: 'sample.wav', contentType: 'audio/wav',
    audioBase64: audio.toString('base64')
  })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  assert.deepEqual(await readFile(answer.body.audioPath), audio)
})

test('reference audio refuses an oversized HTTP body without writing a file', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const profileId = 'voice_oversized_audio'
  const status = await new Promise((resolve, reject) => {
    const request = http.request(`${operator.url}/v1/voice-profiles/reference-audio`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': String(4 * Math.ceil((100 * 1024 * 1024 + 1) / 3) + 16_384 + 1)
      }
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.write(JSON.stringify({ profileId, filename: 'sample.wav', contentType: 'audio/wav', audioBase64: 'AA==' }))
    request.end()
  })
  assert.equal(status, 413)
  assert.deepEqual(await readdir(path.join(host.hostRoot, 'voice-profiles', profileId)).catch(() => []), [])
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

// The live command line of one process, as `ps` prints it ('' once it is gone).
function commandLineOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

test('an engine whose interpreter re-executes itself under another path still stops (BL-60, BL-17)', async (t) => {
  // The python.org framework Python re-executes itself as `…/Python.app/Contents/MacOS/Python`,
  // so a venv engine's live command line holds no path inside the operator's roots. The launch
  // time the operator recorded names the process instead. BL-17 is the general case: a recipe that
  // `exec`s into a program with no in-root path on its command line. The operator's command match
  // counts only paths it vouched for and has no base-name fallback, so it alone would refuse this
  // process; the start-time rule is what stops it.
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const installRoot = path.join(host.hostRoot, 'installs', 'dots-tts-mf')
  await mkdir(installRoot, { recursive: true })
  const command = path.join(installRoot, 'python')
  await writeFile(command, `#!/bin/sh\nexec "${process.execPath}" -e "setInterval(() => {}, 1000)"\n`)
  await chmod(command, 0o755)
  const answer = await operator.startVoice({
    engineId: 'dots-tts-mf',
    installRoot,
    launch: { command, args: ['-m', 'uvicorn', 'server:app', '--port', '8122'] },
    endpoint: 'http://127.0.0.1:8122'
  })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  host.started.add(answer.body.pid)
  assert.ok(await waitFor(() => isRunning(answer.body.pid), 2_000))
  // The premise, checked rather than assumed: once the script has `exec`ed, the live command line
  // names no path the operator recorded (its command and cwd are the only in-root candidates).
  const holdsNoRecordedPath = () => {
    const line = commandLineOf(answer.body.pid)
    return Boolean(line) && ![answer.body.command, answer.body.cwd, installRoot].some((recorded) => line.includes(recorded))
  }
  assert.ok(
    await waitFor(holdsNoRecordedPath, 2_000),
    `the engine's live command line still names a recorded path: ${commandLineOf(answer.body.pid)}`
  )

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

test('a cut Docker inspect response cannot make the operator decide Batshit stopped', async (t) => {
  const docker = await fakeDocker(t)
  await docker.up([{ id: 'app-ours', env: [`FILLER=${'x'.repeat(130_000)}`, ...ours.env] }])
  const operator = await startOperator(t, docker.env)

  // A cut inspect response is unknown, not proof that the client's token disappeared.
  assert.equal(await within(operator.exited, 1_200), 'still running')
  await operator.stop()
})

test('once Docker Batshit is stopped, the operator stops what it started, removes its login item, and exits', async (t) => {
  const docker = await fakeDocker(t)
  await docker.up([ours])
  const host = await voiceHost(t)
  const operator = await startOperator(t, { ...host.env, ...docker.env })
  // Named by the Docker Batshit that asked (BL-18): with no client left, the operator's own stop
  // still stops it, whichever Batshit launched it.
  const stops = await startVoiceEngine(operator, host, 'kokoro', { port: 8010, owner: 'docker:aaaa' })
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
  const answer = await operator.startVoice({
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

test('a launch record the operator cannot read is kept and reported as not stopped, never removed (BL-1264)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  await mkdir(path.join(host.stateDir, 'garbled'), { recursive: true })
  await writeFile(path.join(host.stateDir, 'garbled', '.batshit-local-runtime-launch.json'), '{ "pid": ')
  await mkdir(path.join(host.stateDir, 'blank'), { recursive: true })
  await writeFile(path.join(host.stateDir, 'blank', '.batshit-local-runtime-launch.json'), '')

  const answer = await operator.call('POST', '/v1/voice-engines/stop', {
    engines: [{ engineId: 'garbled', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: true }]
  })

  assert.equal(answer.status, 200)
  const byEngine = Object.fromEntries(answer.body.notStopped.map((outcome) => [outcome.engineIds.join(','), outcome]))
  assert.match(byEngine.garbled.reason, /the launch record .* is not valid JSON; it was kept/)
  assert.match(byEngine.blank.reason, /the launch record .* is empty; it was kept/)
  assert.deepEqual(answer.body.stopped, [])
  assert.deepEqual(await recordFiles(host, 'garbled'), ['.batshit-local-runtime-launch.json'])
  assert.deepEqual(await recordFiles(host, 'blank'), ['.batshit-local-runtime-launch.json'])
})

// Every live process whose command line holds `fragment`, from one whole-table `ps`.
function pidsRunning(fragment) {
  return execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(fragment))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => pid > 0 && pid !== process.pid)
}

test('a start whose launch record cannot be read is refused before anything starts (BL-1267)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { installRoot, command } = await host.install('kokoro')
  await mkdir(path.join(host.stateDir, 'kokoro'), { recursive: true })
  const garbled = '{ "pid": 4242, "stopOnShutdown": fal'
  await writeFile(path.join(host.stateDir, 'kokoro', '.batshit-local-runtime-launch.json'), garbled)

  const answer = await operator.startVoice({ engineId: 'kokoro', installRoot, launch: { command }, endpoint: 'http://127.0.0.1:8010' })

  assert.equal(answer.status, 409)
  assert.equal(answer.body.ok, false)
  assert.match(
    answer.body.error,
    /^Did not start host voice engine "kokoro": the launch record .* is not valid JSON\. Batshit did not write over it: it may belong to a voice engine that is still running\. Once that engine has stopped \(restarting the computer stops it\), repair or remove the file and try again\.$/
  )
  assert.deepEqual(pidsRunning(command), [], 'nothing was started')
  assert.equal(await readFile(path.join(host.stateDir, 'kokoro', '.batshit-local-runtime-launch.json'), 'utf8'), garbled)
  assert.deepEqual(await recordFiles(host, 'kokoro'), ['.batshit-local-runtime-launch.json'])
})

test('a launch the operator started but could not record is stopped again, and only that launch (BL-1267)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  // A runtime another engine's launch started, which the failed launch must never touch.
  const shared = await startVoiceEngine(operator, host, 'chatterbox-turbo', { port: 8012 })
  const { installRoot, command } = await host.install('kokoro')
  // The record is readable (absent) when the start checks, and its write is refused afterwards:
  // here the folder cannot be written, so its lock cannot be taken.
  const dir = path.join(host.stateDir, 'kokoro')
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o555)
  t.after(() => chmod(dir, 0o755).catch(() => {}))

  const answer = await operator.startVoice({ engineId: 'kokoro', installRoot, launch: { command }, endpoint: 'http://127.0.0.1:8010' })

  assert.equal(answer.status, 500)
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.recorded, false)
  assert.equal(answer.body.stopped, true)
  assert.match(answer.body.error, /^Started host voice engine "kokoro" but could not record it, so it stopped it again: /)
  assert.ok(Number.isInteger(answer.body.pid) && answer.body.pid > 0)
  host.started.add(answer.body.pid)
  assert.ok(await waitFor(() => !isRunning(answer.body.pid), 3_000), 'the unrecorded launch is gone')
  assert.deepEqual(pidsRunning(command), [])
  assert.equal(isRunning(shared.pid), true, 'the runtime another launch started is untouched')
  await chmod(dir, 0o755)
  assert.deepEqual(await recordFiles(host, 'kokoro'), [])
})

test('a start whose process cannot be spawned fails visibly, and the operator keeps running', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { installRoot, command } = await host.install('not-executable')
  await chmod(command, 0o644) // spawn fails (EACCES): no pid, and an 'error' the operator must hear

  const answer = await operator.startVoice({ engineId: 'not-executable', installRoot, launch: { command }, endpoint: 'http://127.0.0.1:8010' })

  assert.equal(answer.status, 500)
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.error, 'Did not start host voice engine "not-executable": its process did not start.')
  assert.deepEqual(await recordFiles(host, 'not-executable'), [])
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await operator.health()).status, 200, 'the child\'s error did not end the operator')
})

test('while one launch record cannot be read, the operator stops no engine and removes no record (BL-1269)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const good = await startVoiceEngine(operator, host, 'chatterbox-turbo', { port: 8012, stopOnShutdown: true })
  // Could be qwen3-tts's "keep running" attach record for the same runtime.
  await mkdir(path.join(host.stateDir, 'qwen3-tts'), { recursive: true })
  await writeFile(path.join(host.stateDir, 'qwen3-tts', '.batshit-local-runtime-launch.json'), '{ "pid": ')
  await mkdir(path.join(host.stateDir, 'no-process'), { recursive: true })
  await writeFile(path.join(host.stateDir, 'no-process', '.batshit-local-runtime-launch.json'), JSON.stringify({ command: '/bin/nothing' }))
  const choices = { engines: [{ engineId: 'chatterbox-turbo', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true }] }

  // While held, the app's choices change no record either (they come again with its next stop).
  const held = await operator.call('POST', '/v1/voice-engines/stop', {
    engines: [{ engineId: 'chatterbox-turbo', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false }]
  })

  assert.equal(held.status, 200)
  assert.deepEqual(held.body.stopped, [])
  const byEngine = Object.fromEntries(held.body.notStopped.map((outcome) => [outcome.engineIds.join(','), outcome]))
  assert.equal(byEngine['chatterbox-turbo'].pid, good.pid)
  assert.match(
    byEngine['chatterbox-turbo'].reason,
    /^stopped no voice engine and removed no launch record: .*qwen3-tts.* could not be read and may hold an engine's "keep running" choice\. Once the voice engines have stopped \(restarting the computer stops them\), repair or remove that file or folder$/
  )
  assert.match(byEngine['qwen3-tts'].reason, /is not valid JSON; it was kept/)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(isRunning(good.pid), true, 'held, not stopped')
  assert.deepEqual(await recordFiles(host, 'chatterbox-turbo'), ['.batshit-local-runtime-launch.json'])
  assert.equal((await readRecord(host, 'chatterbox-turbo')).stopOnShutdown, true, 'no record is changed while one is held')
  assert.deepEqual(await recordFiles(host, 'no-process'), ['.batshit-local-runtime-launch.json'], 'no record is removed while one is held')

  // Repaired (here: removed once nothing it names runs), the next stop decides with every record.
  await rm(path.join(host.stateDir, 'qwen3-tts'), { recursive: true, force: true })
  const stopped = await operator.call('POST', '/v1/voice-engines/stop', choices)
  assert.deepEqual(stopped.body.stopped, [{ pid: good.pid, engineIds: ['chatterbox-turbo'] }])
  assert.ok(await waitFor(() => !isRunning(good.pid), 3_000))
  assert.deepEqual(await recordFiles(host, 'no-process'), [])
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

// ---- Two Docker Batshits sharing one operator (revision 7, BL-18) ---------------------------
// Several Docker Batshits can use one operator (two Compose projects started from one
// `.env.docker`, which holds its token, or a copied one), and its voice records are one folder.
// Each app names itself (`owner`: `docker:` and its Compose project, from compose.yaml) at every
// start and stop, and an app's stop touches only its own launches. Before, one app's stop named
// only its own engines, so the other app's had "no choice" and were stopped.

test('two Docker Batshits sharing one operator stop only their own voice engines (BL-18)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const mine = await startVoiceEngine(operator, host, 'kokoro', { port: 8010, owner: 'docker:aaaa' })
  const theirs = await startVoiceEngine(operator, host, 'whisper-cpp', { port: 8077, owner: 'docker:bbbb' })

  // A's container stops: it names only its own engines. One of them uses the runtime B launched
  // (same port): A did not start it, so A gets no say over it (as with Connect Existing).
  const first = await operator.call('POST', '/v1/voice-engines/stop', {
    owner: 'docker:aaaa',
    engines: [
      { engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: true },
      { engineId: 'qwen3-tts', endpoint: 'http://127.0.0.1:8077', stopOnShutdown: false }
    ]
  })

  assert.ok(await waitFor(() => !isRunning(mine.pid), 3_000), 'A’s engine is gone')
  assert.equal(isRunning(theirs.pid), true, 'B’s engine keeps running')
  assert.deepEqual(await recordFiles(host, 'qwen3-tts'), [], 'no record ties A’s engine to B’s runtime')
  assert.deepEqual(first.body.stopped, [{ pid: mine.pid, engineIds: ['kokoro'] }])
  // B's engine is B's alone: A's stop neither decides it nor reports it.
  const mentioned = [...first.body.stopped, ...first.body.keptRunning, ...first.body.notStopped].map((entry) => entry.pid)
  assert.equal(mentioned.includes(theirs.pid), false)
  const record = await readRecord(host, 'whisper-cpp')
  assert.equal(record.launchedBy, 'docker:bbbb')
  assert.equal(record.stopOnShutdown, undefined, 'no choice of A’s landed on B’s record')

  // B's container stops later: its engine stops then.
  const second = await operator.call('POST', '/v1/voice-engines/stop', {
    owner: 'docker:bbbb',
    engines: [{ engineId: 'whisper-cpp', endpoint: 'http://127.0.0.1:8077', stopOnShutdown: true }]
  })
  assert.deepEqual(second.body.stopped, [{ pid: theirs.pid, engineIds: ['whisper-cpp'] }])
  assert.ok(await waitFor(() => !isRunning(theirs.pid), 3_000))
})

test('the same engine in two Docker Batshits: each app’s choice reaches only its own launch (BL-18)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const a = await startVoiceEngine(operator, host, 'kokoro', { port: 8010, owner: 'docker:aaaa' })
  const b = await startVoiceEngine(operator, host, 'kokoro', { port: 8011, owner: 'docker:bbbb' })
  // B's launch moved A's still-running record aside; both are in one engine folder.
  assert.deepEqual(await recordFiles(host, 'kokoro'), [
    `.batshit-local-runtime-launch.${a.pid}.json`,
    '.batshit-local-runtime-launch.json'
  ])

  // A says keep running; B's copy of the same engine is B's to decide.
  await operator.call('POST', '/v1/voice-engines/stop', {
    owner: 'docker:aaaa',
    engines: [{ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: false }]
  })
  // B says stop: only B's launch stops.
  const stopped = await operator.call('POST', '/v1/voice-engines/stop', {
    owner: 'docker:bbbb',
    engines: [{ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8011', stopOnShutdown: true }]
  })

  assert.ok(await waitFor(() => !isRunning(b.pid), 3_000), 'B’s kokoro is gone')
  assert.equal(isRunning(a.pid), true, 'A’s kokoro keeps running, as A chose')
  assert.deepEqual(stopped.body.stopped, [{ pid: b.pid, engineIds: ['kokoro'] }])
  assert.equal(
    JSON.parse(await readFile(path.join(host.stateDir, 'kokoro', `.batshit-local-runtime-launch.${a.pid}.json`), 'utf8'))
      .stopOnShutdown,
    false
  )
})

// A record whose pid now belongs to another Batshit's live engine (the process it named exited and
// the pid was reused) puts both in one group; the stop must still keep the other Batshit's engine.
for (const caller of [
  { label: 'a named app', owner: 'docker:aaaa', launchedBy: { launchedBy: 'docker:aaaa' } },
  { label: 'an app that names no Batshit', owner: undefined, launchedBy: {} }
]) {
  test(`${caller.label}: its stale record naming another Batshit’s live engine (a reused pid) never stops it (BL-18)`, async (t) => {
    const host = await voiceHost(t)
    const operator = await startOperator(t, host.env)
    const theirs = await startVoiceEngine(operator, host, 'whisper-cpp', { port: 8077, owner: 'docker:bbbb' })
    // The caller's kokoro ran and exited long ago, and B's engine now has its pid.
    const launchedAt = new Date(Date.parse((await readRecord(host, 'whisper-cpp')).launchedAt) - 30_000).toISOString()
    const { command } = await host.install('kokoro')
    await mkdir(path.join(host.stateDir, 'kokoro'), { recursive: true })
    await writeFile(
      path.join(host.stateDir, 'kokoro', '.batshit-local-runtime-launch.json'),
      JSON.stringify({ engineId: 'kokoro', pid: theirs.pid, command, args: [], launchedAt, ...caller.launchedBy })
    )

    const answer = await operator.call('POST', '/v1/voice-engines/stop', {
      ...(caller.owner ? { owner: caller.owner } : {}),
      engines: []
    })

    assert.equal(isRunning(theirs.pid), true, 'B’s engine keeps running')
    assert.deepEqual(answer.body.stopped, [])
    assert.deepEqual(await recordFiles(host, 'kokoro'), [], 'the stale record is dropped')
    assert.deepEqual(await recordFiles(host, 'whisper-cpp'), ['.batshit-local-runtime-launch.json'])
  })
}

test('an app that names no Batshit stops only unmarked launches, never a named Batshit’s (BL-18)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const named = await startVoiceEngine(operator, host, 'kokoro', { port: 8010, owner: 'docker:aaaa' })
  // Raw Compose with no BATSHIT_VOICE_RUNTIME_OWNER, or an app from before revision 7.
  const unnamed = await startVoiceEngine(operator, host, 'whisper-cpp', { port: 8077 })

  const answer = await operator.call('POST', '/v1/voice-engines/stop', { engines: [] })

  assert.ok(await waitFor(() => !isRunning(unnamed.pid), 3_000), 'the unmarked launch stops')
  assert.equal(isRunning(named.pid), true, 'the named Batshit’s engine keeps running')
  assert.deepEqual(answer.body.stopped, [{ pid: unnamed.pid, engineIds: ['whisper-cpp'] }])
})

test('a named app still decides launches recorded before launches were named (BL-18)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  // Launched by an older app or operator: no name on the record. Unmarked records keep the old
  // rules, so the app that shuts down next decides them, as before.
  const legacy = await startVoiceEngine(operator, host, 'kokoro', { port: 8010 })

  const kept = await operator.call('POST', '/v1/voice-engines/stop', {
    owner: 'docker:aaaa',
    engines: [{ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: false }]
  })
  assert.deepEqual(kept.body.keptRunning.map((entry) => entry.pid), [legacy.pid])
  assert.equal((await readRecord(host, 'kokoro')).stopOnShutdown, false)

  const stopped = await operator.call('POST', '/v1/voice-engines/stop', { owner: 'docker:aaaa', engines: [] })
  assert.deepEqual(stopped.body.stopped, [{ pid: legacy.pid, engineIds: ['kokoro'] }])
  assert.ok(await waitFor(() => !isRunning(legacy.pid), 3_000))
})

test('a name that is not one short line is refused before anything starts or stops (BL-18)', async (t) => {
  const host = await voiceHost(t)
  const operator = await startOperator(t, host.env)
  const { installRoot, command } = await host.install('kokoro')

  const start = await operator.startVoice({
    engineId: 'kokoro',
    installRoot,
    launch: { command },
    owner: 'docker:a\nb'
  })
  assert.equal(start.status, 500)
  assert.match(start.body.error, /owner must be one line/)
  assert.deepEqual(await recordFiles(host, 'kokoro'), [])

  const stop = await operator.call('POST', '/v1/voice-engines/stop', { owner: 42, engines: [] })
  assert.equal(stop.status, 400)
  assert.match(stop.body.error, /owner must be a string/)
  // The name the operator gives an app that sends none can never be claimed.
  const reserved = await operator.call('POST', '/v1/voice-engines/stop', { owner: 'docker-app:unnamed', engines: [] })
  assert.equal(reserved.status, 400)
  assert.match(reserved.body.error, /reserved/)
})

// BL-1277: an operator still running revision 11 kept its old policy list, so it could make an m3
// sandbox for ~/.batshit/pinokio.admission once that folder existed, and reusing a usable sandbox
// skips the protected-home check. Mount version 4 gives every sandbox a new name, so such an m3
// sandbox is never found again: the request goes through the create path and its check.
test('a usable m3 sandbox made for a protected folder is never reused (BL-1277)', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'batshit-operator-m3-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const admissionFolder = path.join(home, '.batshit', 'pinokio.admission')
  await mkdir(admissionFolder, { recursive: true })
  // The operator's home is this temporary one, so its protected list names this admission folder.
  const operator = await startOperator(t, {
    HOME: home,
    BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT: admissionFolder,
    BATSHIT_HOME_DIR: '',
    BATSHIT_HOST_RUNTIME_ROOT: '',
    BATSHIT_AGENT_RUNTIME_ROOT: '',
    BATSHIT_SANDBOX_PROTECTED_HOME_DIR: ''
  })
  // The exact name a revision-11, mount-version-3 operator gave this workspace (default home layout).
  const hostWorkspaceRoot = await realpath(admissionFolder)
  const m3Name = `batshit-josh-m3-${createHash('sha256').update(`managed-mounts-v3:${hostWorkspaceRoot}`).digest('hex').slice(0, 10)}`
  await mkdir(path.join(operator.stateDir, 'sandboxes'), { recursive: true })
  await writeFile(
    path.join(operator.stateDir, 'sandboxes', `${m3Name}.json`),
    JSON.stringify({ name: m3Name, agent: 'shell', status: 'stopped', last_used_at: new Date().toISOString(), workspaces: [hostWorkspaceRoot], denyNetwork: ['**'] })
  )

  const answer = await operator.execute('pwd')

  assert.notEqual(answer.status, 200, JSON.stringify(answer.body))
  assert.match(JSON.stringify(answer.body), /protected runtime\/Pinokio data/)
  const events = await operator.events()
  assert.deepEqual(events.filter((event) => event.startsWith('exec ')), [], 'a command ran in a sandbox')
  assert.deepEqual(events.filter((event) => event.startsWith('create ')), [], 'a sandbox was created for a protected folder')
  // The old sandbox is left as it was: it was never used, and it is fresh, so the hourly prune of
  // abandoned sandboxes does not take it yet.
  assert.ok((await operator.sandboxNames()).includes(m3Name))
})

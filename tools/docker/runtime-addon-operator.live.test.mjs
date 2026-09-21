// Live proof of the Docker host operator against Docker's real `sbx` CLI. Skipped unless run
// deliberately on a computer with sbx installed, signed in (`sbx login`), and set up
// (`sbx policy init …`):
//
//   BATSHIT_LIVE_DOCKER_SANDBOX=1 node --test tools/docker/runtime-addon-operator.live.test.mjs
//
// It creates one throwaway session sandbox and removes it through the cleanup endpoint.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const LIVE = process.env.BATSHIT_LIVE_DOCKER_SANDBOX === '1'
const OPERATOR_SCRIPT = fileURLToPath(new URL('./runtime-addon-operator.mjs', import.meta.url))
const TOKEN = 'operator-live-sbx-token'

const sandboxes = () => JSON.parse(execFileSync('sbx', ['ls', '--json'], { encoding: 'utf8' })).sandboxes ?? []

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

async function startOperator(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-operator-live-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'marker.txt'), 'from the host\n')
  const port = await freePort()
  const child = spawn(process.execPath, [OPERATOR_SCRIPT], {
    env: {
      ...process.env,
      BATSHIT_RUNTIME_ADDON_OPERATOR_ROOT: root,
      BATSHIT_RUNTIME_ADDON_OPERATOR_ENV_FILE: path.join(root, 'absent.env'),
      BATSHIT_RUNTIME_ADDON_OPERATOR_HOST: '127.0.0.1',
      BATSHIT_RUNTIME_ADDON_OPERATOR_PORT: String(port),
      BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN: TOKEN,
      BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN: '',
      BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT: root,
      BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT: '/workspace'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`Operator did not start:\n${output}`)), 15_000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes('operator listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  const call = async (method, route, body, signal) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal
    })
    return await response.json()
  }
  return { call }
}

test('the operator runs a chat’s parallel first commands in one real sbx sandbox', { skip: !LIVE }, async (t) => {
  const { call } = await startOperator(t)
  const sessionId = `operator-live-${Date.now()}`
  const execute = (command) =>
    call('POST', '/v1/sandbox/execute', {
      userId: 'live-proof',
      sessionId,
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      command,
      timeoutMs: 120_000
    })

  const status = await call('GET', '/v1/sandbox/status')
  assert.equal(status.available, true, status.reason)

  try {
    const results = await Promise.all([execute('echo one'), execute('echo two'), execute('cat marker.txt')])
    assert.deepEqual(
      results.map((result) => result.error ?? result.run?.stdout.trim()),
      ['one', 'two', 'from the host']
    )
    const names = new Set(results.map((result) => result.sandboxName))
    assert.equal(names.size, 1)
    const [name] = names
    assert.equal(sandboxes().filter((sandbox) => sandbox.name === name).length, 1)

    const network = await execute(
      'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/ || echo blocked'
    )
    assert.notEqual(network.run?.stdout.trim(), '200')
  } finally {
    const cleanup = await call('POST', '/v1/sandbox/cleanup', { sessionId })
    assert.deepEqual(cleanup.warnings, [])
    assert.equal(sandboxes().some((sandbox) => sandbox.name.includes('live-proof')), false)
  }
})

// A Stop and a timeout end what the command started inside the sandbox (2026-09-18). Before, the
// operator ran its `sbx exec` on after the app ended its request, and sbx passes no signal into
// the sandbox, so the command ran on until the chat's run-end cleanup removed the sandbox.
test('a Stop and a timeout end everything the command started inside a real sbx sandbox', { skip: !LIVE }, async (t) => {
  const { call } = await startOperator(t)
  const sessionId = `operator-live-end-${Date.now()}`
  const execute = (command, extra = {}, signal) =>
    call(
      'POST',
      '/v1/sandbox/execute',
      { userId: 'live-proof', sessionId, workspaceRoot: '/workspace', cwd: '/workspace', command, timeoutMs: 120_000, ...extra },
      signal
    )
  let name = ''
  const sleepsWith = (nonce) => {
    try {
      return execFileSync('sbx', ['exec', name, 'ps', '-eo', 'args'], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.trim().startsWith('sleep ') && line.includes(nonce)).length
    } catch {
      return -1
    }
  }
  const waitFor = async (check, ms) => {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    return check()
  }

  try {
    // The sandbox is up first, so the Stop lands on the command and not on the start.
    const warm = await execute('true')
    name = warm.sandboxName
    assert.match(name, /^batshit-live-proof-/)

    const stopNonce = String(Date.now() % 100_000).padStart(5, '0')
    const stop = new AbortController()
    const stopping = execute(`sleep 61.${stopNonce} & sleep 62.${stopNonce}`, {}, stop.signal).catch((error) => ({ aborted: error?.name === 'AbortError' }))
    assert.ok(await waitFor(() => sleepsWith(stopNonce) === 2, 30_000), 'the command runs')
    const stoppedAt = Date.now()
    stop.abort()
    assert.equal((await stopping).aborted, true)

    // The operator ends it on its own once the app's request is gone.
    assert.ok(await waitFor(() => sleepsWith(stopNonce) === 0, 3_000), 'both parts are gone')
    const goneMs = Date.now() - stoppedAt
    assert.ok(goneMs < 3_000, `gone ${goneMs} ms after the Stop`)
    assert.ok(sandboxes().some((sandbox) => sandbox.name === name), 'the sandbox is still there: the end did it, not the cleanup')

    const timeoutNonce = String((Date.now() + 1) % 100_000).padStart(5, '0')
    const timedOut = await execute(`sleep 63.${timeoutNonce} & sleep 64.${timeoutNonce}`, { timeoutMs: 2_000 })

    assert.equal(timedOut.run?.timedOut, true)
    assert.equal(sleepsWith(timeoutNonce), 0)
  } finally {
    const cleanup = await call('POST', '/v1/sandbox/cleanup', { sessionId })
    assert.deepEqual(cleanup.warnings, [])
    assert.equal(sandboxes().some((sandbox) => sandbox.name.includes('live-proof')), false)
  }
})

// Black-box proof for the Docker Agent Browser sidecar (2026-09-18, the bug sweep's second
// round): start the real sidecar with a fake `agent-browser` on its PATH and drive it over HTTP.
// Run with `node --test tools/docker/*.test.mjs`.
//
// Before: the sidecar ignored the time limit the app sent (every run got 45 s), and it did not
// notice the app hanging up, so a Stop could not reach an Agent Browser call in Docker.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SIDECAR_SCRIPT = fileURLToPath(new URL('./agent-browser-sidecar/server.mjs', import.meta.url))
const TOKEN = 'test-agent-browser-sidecar-token'

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

function waitForListening(child) {
  let output = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`The sidecar did not start:\n${output}`))
    }, 15_000)
    const onData = (chunk) => {
      output += String(chunk)
      if (output.includes('sidecar listening on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`The sidecar exited with ${code}:\n${output}`))
    })
  })
}

/**
 * A fake `agent-browser`, as the real 0.37.1 behaves: `--version` answers at once; a command
 * starts the daemon once (its own process group, output on /dev/null), writes its own pid, and
 * works for 30 s, or answers at once when its last argument is `quick`.
 */
function fakeCli(stateDir) {
  const at = (name) => JSON.stringify(path.join(stateDir, name))
  return [
    "import { spawn } from 'node:child_process'",
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "if (args[0] === '--version') { console.log('agent-browser 0.37.1'); process.exit(0) }",
    `appendFileSync(${at('calls.log')}, JSON.stringify(args) + '\\n')`,
    `if (!existsSync(${at('daemon.pid')})) {`,
    "  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
    '  daemon.unref()',
    `  writeFileSync(${at('daemon.pid')}, String(daemon.pid))`,
    '}',
    `writeFileSync(${at('cli.pid')}, String(process.pid))`,
    "if (args.at(-1) === 'quick') { console.log(JSON.stringify({ success: true, data: { title: 'Example' } })); process.exit(0) }",
    "setTimeout(() => console.log(JSON.stringify({ success: true, data: { title: 'late' } })), 30_000)"
  ].join('\n')
}

async function startSidecar(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-ab-sidecar-'))
  const bin = path.join(root, 'bin')
  const state = path.join(root, 'state')
  await mkdir(bin)
  await mkdir(state)
  const script = path.join(root, 'fake-agent-browser.mjs')
  await writeFile(script, fakeCli(state))
  const cli = path.join(bin, 'agent-browser')
  await writeFile(cli, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  await chmod(cli, 0o755)

  const port = await freePort()
  const child = spawn(process.execPath, [SIDECAR_SCRIPT], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      BATSHIT_AGENT_BROWSER_HOST: '127.0.0.1',
      BATSHIT_AGENT_BROWSER_PORT: String(port),
      BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN: TOKEN,
      BATSHIT_AGENT_BROWSER_TMP_DIR: path.join(root, 'tmp')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const pidOf = async (name) => Number((await readFile(path.join(state, name), 'utf8').catch(() => '')).trim())
  t.after(async () => {
    child.kill()
    for (const name of ['cli.pid', 'daemon.pid']) {
      const pid = await pidOf(name)
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
    await rm(root, { recursive: true, force: true })
  })
  await waitForListening(child)

  const base = `http://127.0.0.1:${port}`
  return {
    pidOf,
    /** Wait until the fake CLI of the current call has written its pid. */
    cliPid: async () => {
      let pid = 0
      await waitFor(async () => (pid = await pidOf('cli.pid')) > 0, 5_000)
      return pid
    },
    health: async () => (await fetch(`${base}/health`)).json(),
    run: (body, signal) =>
      fetch(`${base}/v1/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {})
      })
  }
}

test('health says what the sidecar does: revision 2 keeps the time limit and hears a hang-up', { timeout: 20_000 }, async (t) => {
  const sidecar = await startSidecar(t)
  const health = await sidecar.health()
  assert.equal(health.sidecarRevision, 2)
})

test('a run keeps the time limit the app sends, and it ends only the CLI call', { timeout: 20_000 }, async (t) => {
  const sidecar = await startSidecar(t)
  const started = Date.now()
  const response = await sidecar.run({ args: ['--json', 'get', 'title'], timeoutMs: 1_000 })
  const body = await response.json()

  assert.ok(Date.now() - started < 3_000, `answered after ${Date.now() - started} ms`)
  assert.equal(body.run.timedOut, true)
  const cliPid = await sidecar.pidOf('cli.pid')
  assert.ok(await waitFor(() => !isRunning(cliPid), 1_000), 'the CLI call is gone')
  assert.ok(isRunning(await sidecar.pidOf('daemon.pid')), 'the daemon keeps running')
})

test('a time limit is bounded: below 1 s it is 1 s, as in the app', { timeout: 20_000 }, async (t) => {
  const sidecar = await startSidecar(t)
  const response = await sidecar.run({ args: ['--json', 'get', 'title'], timeoutMs: 10 })
  const body = await response.json()

  assert.equal(body.run.timedOut, true)
  assert.ok(body.run.durationMs >= 900, `ran ${body.run.durationMs} ms`)
})

test('the app hanging up (a Stop) ends the CLI call at once, and never the daemon', { timeout: 20_000 }, async (t) => {
  const sidecar = await startSidecar(t)
  const stop = new AbortController()
  const call = sidecar.run({ args: ['--json', 'get', 'title'], timeoutMs: 60_000 }, stop.signal).catch((error) => error)
  const cliPid = await sidecar.cliPid()

  const stoppedAt = Date.now()
  stop.abort()
  await call

  assert.ok(await waitFor(() => !isRunning(cliPid), 1_500), 'the CLI call is gone')
  assert.ok(Date.now() - stoppedAt < 1_500)
  assert.ok(isRunning(await sidecar.pidOf('daemon.pid')), 'the daemon keeps running')
})

test('a run the app waits for answers as before', { timeout: 20_000 }, async (t) => {
  const sidecar = await startSidecar(t)
  const response = await sidecar.run({ args: ['--json', 'get', 'title', 'quick'], timeoutMs: 10_000 })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.run.exitCode, 0)
  assert.match(body.run.stdout, /Example/)
  assert.equal(body.run.stopped, undefined)
})

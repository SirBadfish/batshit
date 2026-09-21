#!/usr/bin/env node
// A fake `sbx` for tests of Batshit's Docker Sandbox lanes. It keeps the behaviors Batshit
// depends on, as measured against sbx v0.43.0 on 2026-09-18:
// - `version` works before sign-in; every other command needs it.
// - create/policy commands need the one-time global network preset.
// - `ls --json` prints { sandboxes: [{ name, agent, status, last_used_at, workspaces }] }.
// - A second create of a name fails at once with "409 Conflict … already exists", and the
//   new sandbox is not listed until it runs.
// - Names reject underscores; the policy command rejects a positional sandbox name.
// - `exec` starts a stopped sandbox and refreshes last_used_at.
// - `exec` does not pass a SIGTERM into the sandbox: the command runs on inside after its client
//   is killed, and the client itself ignores the SIGTERM (measured: it exited 28.9 s after one).
//   So an `exec` that carries Batshit's command tag (`--env BATSHIT_COMMAND_ID=<tag>`) and runs
//   for $FAKE_SBX_EXEC_MS also starts a real, detached `sleep` that stands for its program inside
//   the sandbox, with its pid in `inside/<tag>.pid`; only Batshit's end command
//   (`exec <name> sh -c <script> batshit-command-end <tag>`, logged as `end <name> <tag>` and, once
//   done, `end-done <name> <tag>`; $FAKE_SBX_END_MS makes it take that long) ends it.
// State lives in $FAKE_SBX_STATE. Touch `.not-signed-in` or `.policy-not-initialized` there
// to play those setups; $FAKE_SBX_CREATE_MS slows a create (default 150 ms),
// $FAKE_SBX_EXEC_MS makes an `exec` run that long (default 0; it logs `exec-done` if it ends on
// its own), $FAKE_SBX_CREATED_ELSEWHERE=<name> makes a create of that name lose to another
// process, and $FAKE_SBX_STARTS_DAEMON=1 makes the first command say it started the daemon.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const STATE = process.env.FAKE_SBX_STATE
if (!STATE) {
  process.stderr.write('fake sbx: FAKE_SBX_STATE is not set\n')
  process.exit(2)
}
const SANDBOXES = path.join(STATE, 'sandboxes')
const CLAIMS = path.join(STATE, 'claims')
const INSIDE = path.join(STATE, 'inside')
const EVENTS = path.join(STATE, 'events.log')
fs.mkdirSync(SANDBOXES, { recursive: true })
fs.mkdirSync(CLAIMS, { recursive: true })
fs.mkdirSync(INSIDE, { recursive: true })

const [command, ...args] = process.argv.slice(2)
const event = (line) => fs.appendFileSync(EVENTS, `${line}\n`)
const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
const sandboxFile = (name) => path.join(SANDBOXES, `${name}.json`)
const readSandbox = (name) =>
  fs.existsSync(sandboxFile(name)) ? JSON.parse(fs.readFileSync(sandboxFile(name), 'utf8')) : null
const writeSandbox = (sandbox) => {
  const temp = `${sandboxFile(sandbox.name)}.${process.pid}`
  fs.writeFileSync(temp, JSON.stringify(sandbox))
  fs.renameSync(temp, sandboxFile(sandbox.name))
}
const takeFlag = (list, flag) => {
  const values = []
  for (let index = 0; index < list.length; ) {
    if (list[index] === flag) {
      values.push(list[index + 1])
      list.splice(index, 2)
    } else index += 1
  }
  return values
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

if (command === 'version') {
  process.stdout.write('sbx version: v0.43.0-fake\n')
  process.exit(0)
}
event(`${command} ${args.join(' ')}`.trim())
// $FAKE_SBX_STARTS_DAEMON=1: the first command after `version` starts the daemon and says so on
// stderr, as a Mac build does (no daemon process is played here; `batshit-mac/scripts/test-fixtures/
// fake-sbx-daemon.mjs` plays one).
if (process.env.FAKE_SBX_STARTS_DAEMON === '1' && !fs.existsSync(path.join(STATE, '.daemon-started'))) {
  fs.writeFileSync(path.join(STATE, '.daemon-started'), '')
  process.stderr.write('Starting sandboxd daemon...\n')
}
if (fs.existsSync(path.join(STATE, '.not-signed-in'))) {
  fail('ERROR: Not authenticated to Docker\n\nSign in with: sbx login')
}
const policyMissing = () => fs.existsSync(path.join(STATE, '.policy-not-initialized'))
const policyMissingMessage =
  'ERROR: global network policy has not been initialized\n\nInitialize it with:\n  sbx policy init <allow-all|balanced|deny-all>'

if (command === 'ls') {
  if (args[0] !== '--json') fail('fake sbx: only `ls --json` is supported')
  const sandboxes = fs
    .readdirSync(SANDBOXES)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(SANDBOXES, file), 'utf8')))
  process.stdout.write(`${JSON.stringify({ sandboxes }, null, 2)}\n`)
  process.exit(0)
}

if (command === 'create') {
  if (policyMissing()) fail(policyMissingMessage)
  const rest = [...args]
  const [name] = takeFlag(rest, '--name')
  const denied = takeFlag(rest, '--deny-network')
  const [kit, workspace, ...extra] = rest
  if (!name) fail('fake sbx: create needs --name')
  if (name.includes('_')) fail(`ERROR: sandbox name cannot contain underscores: ${name}`)
  const conflict = () => fail(`ERROR: request failed: 409 Conflict: sandbox "${name}" already exists`)
  // Plays another process that finished creating this name first.
  if (process.env.FAKE_SBX_CREATED_ELSEWHERE === name) {
    writeSandbox({
      name,
      agent: kit,
      status: 'running',
      last_used_at: new Date().toISOString(),
      workspaces: [workspace, ...extra].filter(Boolean),
      denyNetwork: []
    })
    conflict()
  }
  try {
    fs.closeSync(fs.openSync(path.join(CLAIMS, name), 'wx'))
  } catch {
    conflict()
  }
  sleep(Number(process.env.FAKE_SBX_CREATE_MS ?? 150))
  writeSandbox({
    name,
    agent: kit,
    status: 'running',
    last_used_at: new Date().toISOString(),
    workspaces: [workspace, ...extra].filter(Boolean),
    denyNetwork: denied
  })
  process.stdout.write(`Created sandbox ${name}\n`)
  process.exit(0)
}

if (command === 'policy') {
  if (policyMissing()) fail(policyMissingMessage)
  if (args[0] === 'ls') {
    process.stdout.write('POLICY         SOURCE   APPLIES TO   SUMMARY\n')
    process.exit(0)
  }
  if (args[0] === 'deny' && args[1] === 'network') {
    const rest = args.slice(2)
    const [scope] = takeFlag(rest, '--sandbox')
    if (rest.length > 1) {
      fail(`ERROR: unexpected second argument "${rest[1]}": the sandbox name is no longer positional.`)
    }
    const sandbox = scope ? readSandbox(scope) : null
    if (scope && !sandbox) fail(`ERROR: sandbox '${scope}' not found`)
    if (sandbox && !sandbox.denyNetwork.includes(rest[0])) {
      sandbox.denyNetwork.push(rest[0])
      writeSandbox(sandbox)
    }
    process.stdout.write(`Rule added (scope: ${scope ? `sandbox:${scope}` : 'all'}): ${rest[0]}\n`)
    process.exit(0)
  }
  fail(`fake sbx: unsupported policy command: ${args.join(' ')}`)
}

if (command === 'exec') {
  const rest = [...args]
  takeFlag(rest, '--workdir')
  const envs = takeFlag(rest, '--env')
  const [name, ...commandArgv] = rest
  const sandbox = readSandbox(name)
  if (!sandbox) fail(`ERROR: sandbox '${name}' not found (run 'sbx ls' to see your sandboxes)`)
  sandbox.status = 'running'
  sandbox.last_used_at = new Date().toISOString()
  writeSandbox(sandbox)

  // Batshit's end command after a Stop or timeout. It plays the script: it ends the program the
  // tagged command left running inside.
  if (commandArgv[0] === 'sh' && commandArgv[1] === '-c' && commandArgv[3] === 'batshit-command-end') {
    const endTag = commandArgv[4]
    event(`end ${name} ${endTag}`)
    // $FAKE_SBX_END_MS: an end that takes that long (the real one takes 0.4-0.9 s).
    sleep(Number(process.env.FAKE_SBX_END_MS ?? 0))
    const pidFile = path.join(INSIDE, `${endTag}.pid`)
    let ended = 0
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM')
        ended = 1
      } catch {}
      fs.rmSync(pidFile, { force: true })
    }
    event(`end-done ${name} ${endTag}`)
    process.stdout.write(`batshit-command-end: ${ended} ended\n`)
    process.exit(0)
  }

  const tag = envs.map((entry) => /^BATSHIT_COMMAND_ID=(.+)$/.exec(entry)?.[1]).find(Boolean)
  const execMs = Number(process.env.FAKE_SBX_EXEC_MS ?? 0)
  if (execMs > 0) {
    let inside = null
    if (tag) {
      inside = spawn('sleep', [String(Math.ceil(execMs / 1000) + 30)], {
        detached: true,
        stdio: 'ignore'
      })
      inside.unref()
      fs.writeFileSync(path.join(INSIDE, `${tag}.pid`), String(inside.pid))
    }
    // The real client ignores a SIGTERM and waits for the command.
    process.on('SIGTERM', () => {})
    sleep(execMs)
    event(`exec-done ${name}`)
    // The command ended on its own, and its program with it.
    if (inside) {
      try {
        process.kill(inside.pid, 'SIGTERM')
      } catch {}
      fs.rmSync(path.join(INSIDE, `${tag}.pid`), { force: true })
    }
  }
  process.stdout.write('sbx ok\n')
  process.exit(0)
}

if (command === 'rm') {
  const names = args.filter((arg) => arg !== '--force' && arg !== '-f')
  for (const name of names) {
    if (!readSandbox(name)) fail(`ERROR: sandbox '${name}' not found (run 'sbx ls' to see your sandboxes)`)
    fs.rmSync(sandboxFile(name), { force: true })
    fs.rmSync(path.join(CLAIMS, name), { force: true })
  }
  process.exit(0)
}

if (command === 'stop') {
  for (const name of args) {
    const sandbox = readSandbox(name)
    if (!sandbox) fail(`ERROR: sandbox '${name}' not found`)
    sandbox.status = 'stopped'
    writeSandbox(sandbox)
  }
  process.exit(0)
}

fail(`fake sbx: unsupported command: ${command}`)

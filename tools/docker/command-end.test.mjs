// The sandbox end command, run for real (2026-09-18). It reads `/proc`, so it runs where a
// sandbox does: Linux (CI's Guardrails job, or a Linux container on a Mac). Elsewhere it skips.
// Run with `node --test tools/docker/*.test.mjs`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  SANDBOX_COMMAND_TAG_ENV,
  newSandboxCommandTag,
  sandboxCommandEndArgv
} from './command-end.mjs'

const HAS_PROC = existsSync('/proc/self/environ')

// `/proc/<pid>/stat` after the command name: state, parent, process group, …
function statFields(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  } catch {
    return null
  }
}

// A process that ended but is not yet reaped (state Z) is not running.
function isRunning(pid) {
  const fields = statFields(pid)
  return Boolean(fields) && fields[0] !== 'Z'
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

function pidsOf(group) {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => isRunning(pid) && Number(statFields(pid)?.[2]) === group)
}

// A command as a sandbox `exec` starts it: the leader of its own session, with the tag in its
// environment.
function startCommand(script, tag) {
  const env = { ...process.env }
  if (tag) env[SANDBOX_COMMAND_TAG_ENV] = tag
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore', env })
  child.unref()
  return child.pid
}

function runEnd(tag) {
  const [program, ...args] = sandboxCommandEndArgv(tag)
  return spawnSync(program, args, { encoding: 'utf8', timeout: 10_000 })
}

test(
  'ends every process carrying the tag, and the groups they lead, and nothing else',
  { skip: !HAS_PROC && 'needs /proc (Linux)' },
  async (t) => {
    const tag = newSandboxCommandTag()
    // A background program, one that ignores the polite signal, one that cleared its
    // environment (it keeps the group), and the command's own foreground program.
    const leader = startCommand(
      "sleep 61 & (trap '' TERM; exec sleep 62) & env -i sleep 63 & sleep 64",
      tag
    )
    const bystander = startCommand('sleep 65', newSandboxCommandTag())
    const untagged = startCommand('sleep 66', null)
    t.after(() => {
      for (const group of [leader, bystander, untagged]) {
        try {
          process.kill(-group, 'SIGKILL')
        } catch {}
      }
    })
    // Four or five processes: busybox and dash run the last `sleep` in the shell's own place.
    assert.ok(await waitFor(() => pidsOf(leader).length >= 4, 3_000), 'the command started')
    const members = pidsOf(leader)

    const started = Date.now()
    const end = runEnd(tag)

    assert.equal(end.status, 0, end.stderr)
    // The one that ignores SIGTERM needs the SIGKILL.
    assert.match(end.stdout, /batshit-command-end: [34] ended, 1 killed/)
    assert.ok(Date.now() - started < 3_000)
    for (const pid of members) {
      assert.ok(await waitFor(() => !isRunning(pid), 1_000), `pid ${pid} still runs`)
    }
    assert.ok(isRunning(bystander), 'another command with its own tag is untouched')
    assert.ok(isRunning(untagged), 'a process without a tag is untouched')
  }
)

test(
  'finds the tag wherever it sits in a process’s environment',
  { skip: !HAS_PROC && 'needs /proc (Linux)' },
  async (t) => {
    const tag = newSandboxCommandTag()
    // One process alone in its group, with the tag as the LAST entry of its environment: only
    // reading every entry finds it (busybox `grep` stops at the first NUL of an unsplit file).
    const child = spawn('sleep', ['69'], {
      detached: true,
      stdio: 'ignore',
      env: { FIRST: 'one', ...process.env, [SANDBOX_COMMAND_TAG_ENV]: tag }
    })
    child.unref()
    t.after(() => {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {}
    })
    const environ = readFileSync(`/proc/${child.pid}/environ`, 'utf8').split('\0').filter(Boolean)
    assert.equal(environ.at(-1), `${SANDBOX_COMMAND_TAG_ENV}=${tag}`)

    const end = runEnd(tag)

    assert.equal(end.status, 0, end.stderr)
    assert.match(end.stdout, /batshit-command-end: 1 ended$/m)
    assert.ok(await waitFor(() => !isRunning(child.pid), 1_000))
  }
)

test(
  'gives a program that cleans up on SIGTERM its moment before any SIGKILL',
  { skip: !HAS_PROC && 'needs /proc (Linux)' },
  async (t) => {
    const tag = newSandboxCommandTag()
    // It takes 150 ms to leave after SIGTERM, inside the 400 ms the end allows.
    const leader = startCommand("trap 'sleep 0.15; exit 0' TERM; sleep 60 & wait", tag)
    t.after(() => {
      try {
        process.kill(-leader, 'SIGKILL')
      } catch {}
    })
    assert.ok(await waitFor(() => pidsOf(leader).length === 2, 3_000), 'the command started')

    const end = runEnd(tag)

    assert.equal(end.status, 0, end.stderr)
    assert.match(end.stdout, /batshit-command-end: 2 ended$/m)
    assert.ok(await waitFor(() => pidsOf(leader).length === 0, 1_000))
  }
)

// A process of the command in process group 1 must never turn into `kill -- -1`, which means
// every process there is. It happens where the caller itself is in group 1, as in a container
// whose first process runs the test.
function ownGroup() {
  return Number(statFields(process.pid)?.[2])
}

test(
  'never signals process group 1, which would reach every process',
  { skip: (!HAS_PROC || ownGroup() !== 1) && 'needs /proc and to run in process group 1 (a container)' },
  async (t) => {
    const tag = newSandboxCommandTag()
    // Not detached: this command is in the caller's group, 1.
    const child = spawn('sh', ['-c', 'sleep 67'], {
      stdio: 'ignore',
      env: { ...process.env, [SANDBOX_COMMAND_TAG_ENV]: tag }
    })
    const bystander = startCommand('sleep 68', null)
    t.after(() => {
      child.kill('SIGKILL')
      try {
        process.kill(-bystander, 'SIGKILL')
      } catch {}
    })
    assert.ok(await waitFor(() => isRunning(child.pid), 3_000))

    const end = runEnd(tag)

    assert.equal(end.status, 0, end.stderr)
    assert.ok(await waitFor(() => !isRunning(child.pid), 1_000), 'the tagged process itself is ended')
    assert.ok(isRunning(bystander), 'nothing else is')
  }
)

test(
  'says so and succeeds when nothing with the tag runs any more',
  { skip: !HAS_PROC && 'needs /proc (Linux)' },
  () => {
    const end = runEnd(newSandboxCommandTag())
    assert.equal(end.status, 0, end.stderr)
    assert.match(end.stdout, /batshit-command-end: nothing running/)
  }
)

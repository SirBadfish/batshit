import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  SANDBOX_COMMAND_END_NAME,
  SANDBOX_COMMAND_END_SCRIPT,
  SANDBOX_COMMAND_END_TIMEOUT_MS,
  SANDBOX_COMMAND_TAG_ENV,
  endLiveCommandGroups,
  liveCommandGroups,
  newSandboxCommandTag,
  sandboxCommandEndArgv,
  trackCommandGroup
} from '../commandEnd'

/**
 * How Batshit ends what a command started, on a Stop and on a timeout (2026-09-18). The local
 * shell's half runs real processes here; the sandbox half's script runs for real in
 * `tools/docker/command-end.test.mjs` (Linux) and in the live sandbox tests.
 */

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function goneWithin(pid: number, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isRunning(pid)
}

describe('ending a command inside a sandbox', () => {
  it('runs one short command in the same sandbox that ends everything carrying the tag', () => {
    const tag = newSandboxCommandTag()
    expect(sandboxCommandEndArgv(tag)).toEqual([
      'sh',
      '-c',
      SANDBOX_COMMAND_END_SCRIPT,
      SANDBOX_COMMAND_END_NAME,
      tag
    ])
    expect(SANDBOX_COMMAND_END_NAME).toBe('batshit-command-end')
    expect(SANDBOX_COMMAND_TAG_ENV).toBe('BATSHIT_COMMAND_ID')
    // The tag is an argument of the end command, never its environment: the end command must
    // not find itself.
    expect(SANDBOX_COMMAND_END_SCRIPT).toContain(`${SANDBOX_COMMAND_TAG_ENV}=$1`)
  })

  it('gives every command its own tag, in characters any shell passes through untouched', () => {
    const tags = new Set(Array.from({ length: 50 }, () => newSandboxCommandTag()))
    expect(tags.size).toBe(50)
    for (const tag of tags) expect(tag).toMatch(/^[A-Za-z0-9-]{16,}$/)
  })

  it('is the same rule in the Docker host operator’s copy', () => {
    // Vitest runs from batshit-app; the operator's copy sits beside it in tools/docker. Node
    // loads it directly (it is plain JavaScript outside the app).
    const twin = createRequire(import.meta.url)(
      path.resolve(process.cwd(), '../tools/docker/command-end.mjs')
    ) as {
      SANDBOX_COMMAND_END_NAME: string
      SANDBOX_COMMAND_END_SCRIPT: string
      SANDBOX_COMMAND_END_TIMEOUT_MS: number
      SANDBOX_COMMAND_TAG_ENV: string
      sandboxCommandEndArgv: (tag: string) => string[]
    }
    expect(twin.SANDBOX_COMMAND_END_SCRIPT).toBe(SANDBOX_COMMAND_END_SCRIPT)
    expect(twin.SANDBOX_COMMAND_END_NAME).toBe(SANDBOX_COMMAND_END_NAME)
    expect(twin.SANDBOX_COMMAND_TAG_ENV).toBe(SANDBOX_COMMAND_TAG_ENV)
    expect(twin.SANDBOX_COMMAND_END_TIMEOUT_MS).toBe(SANDBOX_COMMAND_END_TIMEOUT_MS)
    expect(twin.sandboxCommandEndArgv('t-1')).toEqual(sandboxCommandEndArgv('t-1'))
  })
})

describe('the local shell’s command groups when Batshit quits', () => {
  const started: number[] = []

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
  })

  // A command as the local shell runs it: the leader of its own process group, here with a
  // background program and one that ignores the polite signal.
  function startGroup(script: string) {
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
    const pid = child.pid as number
    started.push(pid)
    trackCommandGroup(pid)
    return pid
  }

  it('ends every live command group: politely first, then for good', async () => {
    const plain = startGroup('sleep 30 & sleep 31')
    const stubborn = startGroup("trap '' TERM; sleep 32 & wait")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(isRunning(plain) && isRunning(stubborn)).toBe(true)

    const ended = await endLiveCommandGroups()

    expect(ended).toBeGreaterThanOrEqual(2)
    expect(await goneWithin(plain, 1_000)).toBe(true)
    expect(await goneWithin(stubborn, 1_000)).toBe(true)
  })

  it('kills any command group still left when the app server exits', async () => {
    // A crash or `process.exit` never runs the SIGTERM shutdown task. A real Node process
    // loads this module, starts a command group, and exits.
    const moduleFile = path.resolve(process.cwd(), 'src/lib/server/services/commandEnd.ts')
    const script = [
      "import { spawn } from 'node:child_process'",
      `import { trackCommandGroup } from ${JSON.stringify(moduleFile)}`,
      "const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 31'], { detached: true, stdio: 'ignore' })",
      'trackCommandGroup(child.pid)',
      'console.log(child.pid)',
      'setTimeout(() => process.exit(0), 200)'
    ].join('\n')
    const tsx = path.resolve(process.cwd(), 'node_modules/.bin/tsx')
    const output = await new Promise<string>((resolve, reject) => {
      const app = spawn(tsx, ['--eval', script], { stdio: ['ignore', 'pipe', 'inherit'] })
      let text = ''
      app.stdout.on('data', (chunk) => (text += String(chunk)))
      app.on('error', reject)
      app.on('exit', () => resolve(text))
    })
    const pid = Number(output.trim())
    started.push(pid)

    expect(pid).toBeGreaterThan(0)
    expect(await goneWithin(pid, 1_000)).toBe(true)
  }, 20_000)

  it('forgets a group once nothing in it runs', async () => {
    const pid = startGroup('sleep 0.3')
    expect(liveCommandGroups()).toContain(pid)
    await goneWithin(pid, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // A finished group is never signalled again, so a later process that happens to get its
    // number is never touched.
    expect(liveCommandGroups()).not.toContain(pid)
  })
})

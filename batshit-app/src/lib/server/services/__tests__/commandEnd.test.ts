import { afterEach, describe, expect, it } from 'vitest'
import { inspectTestProcessState, isTestProcessRunning } from '$lib/test-utils/process-state'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  SANDBOX_COMMAND_END_NAME,
  SANDBOX_COMMAND_END_SCRIPT,
  SANDBOX_COMMAND_END_TIMEOUT_MS,
  SANDBOX_COMMAND_TAG_ENV,
  newSandboxCommandTag,
  sandboxCommandEndArgv
} from '../commandEnd'
import { spawnOwnedCommandGroup, endLiveOwnedCommandGroups, liveOwnedCommandCount } from '../ownedCommandGroup'

/**
 * How Batshit ends what a command started, on a Stop and on a timeout (2026-09-18). The local
 * shell's half runs real processes here; the sandbox half's script runs for real in
 * `tools/docker/command-end.test.mjs` (Linux) and in the live sandbox tests.
 */


async function stoppedWithin(pid: number, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isTestProcessRunning(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isTestProcessRunning(pid)
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
  afterEach(async () => { await endLiveOwnedCommandGroups() })

  async function startGroup(script: string) {
    const child = spawnOwnedCommandGroup('/bin/sh', ['-c', script], { env: {} })
    child.stdout.resume()
    child.stderr.resume()
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    return child.pid as number
  }

  it('ends every live command group: politely first, then for good', async () => {
    const plain = await startGroup('sleep 30 & sleep 31')
    const stubborn = await startGroup("trap '' TERM; sleep 32 & wait")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(inspectTestProcessState(plain)).toBe('live')
    expect(inspectTestProcessState(stubborn)).toBe('live')

    const ended = await endLiveOwnedCommandGroups()

    expect(ended).toBeGreaterThanOrEqual(2)
    expect(await stoppedWithin(plain, 1_000)).toBe(true)
    expect(await stoppedWithin(stubborn, 1_000)).toBe(true)
  })

  it('kills any command group still left when the app server exits', async () => {
    // A crash or `process.exit` never runs the SIGTERM shutdown task. A real Node process
    // loads this module, starts a command group, and exits.
    const moduleFile = path.resolve(process.cwd(), 'src/lib/server/services/ownedCommandGroup.ts')
    const script = [
      `import { spawnOwnedCommandGroup } from ${JSON.stringify(moduleFile)}`,
      "const child = spawnOwnedCommandGroup('/bin/sh', ['-c', 'sleep 30 & sleep 31'], { env: {} })",
      'child.stdout.resume(); child.stderr.resume()',
      'child.once("spawn", () => { console.log(child.pid); setTimeout(() => process.exit(0), 200) })'
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

    expect(pid).toBeGreaterThan(0)
    expect(await stoppedWithin(pid, 1_000)).toBe(true)
  }, 20_000)

  it('forgets a group once nothing in it runs', async () => {
    const pid = await startGroup('sleep 0.3')
    expect(liveOwnedCommandCount()).toBeGreaterThan(0)
    await stoppedWithin(pid, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // A finished group is never signalled again, so a later process that happens to get its
    // number is never touched.
    expect(liveOwnedCommandCount()).toBe(0)
  })
})

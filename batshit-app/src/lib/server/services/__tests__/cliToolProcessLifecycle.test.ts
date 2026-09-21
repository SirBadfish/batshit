// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runCliProcess } from '../cliToolRegistry'

const createdGroups = new Set<number>()
const createdDirs = new Set<string>()

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 3_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for process evidence')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitUntilGone(pids: number[], timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (pids.some(processRuns) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(pids.filter(processRuns)).toEqual([])
}

async function startProcessTree(options: {
  timeoutMs: number
  abortSignal?: AbortSignal
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-cli-lifecycle-'))
  createdDirs.add(dir)
  const evidencePath = path.join(dir, 'pids.json')
  const stubbornChild = [
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1_000)'
  ].join(';')
  const root = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(stubbornChild)}], { stdio: 'ignore' })`,
    `writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify([process.pid, child.pid]))`,
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1_000)'
  ].join(';')
  const run = runCliProcess({
    executable: process.execPath,
    args: ['-e', root],
    env: {},
    timeoutMs: options.timeoutMs,
    abortSignal: options.abortSignal
  })
  const pids = await waitFor(async () => {
    const raw = await readFile(evidencePath, 'utf8').catch(() => null)
    return raw ? (JSON.parse(raw) as number[]) : null
  })
  createdGroups.add(pids[0])
  return { run, pids }
}

afterEach(async () => {
  for (const pgid of createdGroups) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // The lifecycle under test should already have ended this owned group.
    }
  }
  createdGroups.clear()
  await Promise.all(
    [...createdDirs].map((dir) => rm(dir, { recursive: true, force: true }))
  )
  createdDirs.clear()
})

describe.runIf(process.platform !== 'win32')(
  'saved CLI process lifecycle',
  () => {
    it('Stop ends the CLI process and its stubborn descendant', async () => {
      const controller = new AbortController()
      const { run, pids } = await startProcessTree({
        timeoutMs: 30_000,
        abortSignal: controller.signal
      })

      controller.abort()
      const result = await run

      expect(result.exitCode).toBeNull()
      expect(result.stderr).toContain('The command was stopped.')
      expect(result.stopped).toBe(true)
      expect(result.timedOut).toBe(false)
      expect(result.durationMs).toBeLessThan(2_000)
      await waitUntilGone(pids)
    })

    it('timeout ends the CLI process and its stubborn descendant', async () => {
      const { run, pids } = await startProcessTree({ timeoutMs: 500 })

      const result = await run

      expect(result.exitCode).toBeNull()
      expect(result.stderr).toContain('Process timed out after 500ms')
      expect(result.stopped).toBe(false)
      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(2_000)
      await waitUntilGone(pids)
    })
  }
)

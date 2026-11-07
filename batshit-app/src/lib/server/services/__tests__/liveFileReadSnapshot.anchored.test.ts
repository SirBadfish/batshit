// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LiveReadAdmission } from '../liveFileReadSnapshot.server'

/**
 * SA-137 (D5, V1/V3): a read that runs out of time, and a Stop, end the real native reader child:
 * the outcome is `deadline` (static) or `LiveFileReadStoppedError` only after the child has exited.
 * Only the test build has scheduling barriers; the file read itself runs unchanged.
 */

// Hold a barrier for `hold` ms before answering it, so a read is still running when its time ends.
const hooks = vi.hoisted(() => ({
  stage: null as null | ((stage: string) => number | void),
  children: [] as any[]
}))
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>()
  const spawn = (file: string, args: string[], options: any) => {
    const child = actual.spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    hooks.children.push(child)
    let buffered = ''
    child.stdio[3]!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const stage = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        const hold = hooks.stage?.(stage)
        const answer = () => { if (!child.killed && child.exitCode === null) (child.stdio[3] as NodeJS.WritableStream).write('+') }
        if (typeof hold === 'number' && hold > 0) setTimeout(answer, hold)
        else answer()
      }
    })
    child.stdio[3]!.on('error', () => {})
    return child
  }
  return { ...actual, spawn, default: { ...((actual as any).default ?? actual), spawn } }
})

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('live file reads settle the real reader child', () => {
  let buildRoot = ''
  let root = ''
  let admission: LiveReadAdmission
  let snapshot: typeof import('../liveFileReadSnapshot.server')

  beforeAll(async () => {
    buildRoot = mkdtempSync(path.join(os.tmpdir(), 'sa137-reader-build-'))
    const executable = path.join(buildRoot, 'reader')
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DBL320_TEST_BARRIERS',
      'scripts/anchored-project-reader.c', '-o', executable], { timeout: 30_000 })
    vi.stubEnv('BATSHIT_TEST_ANCHORED_READER', executable)
    vi.resetModules()
    snapshot = await import('../liveFileReadSnapshot.server')
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(buildRoot, { recursive: true, force: true })
  })
  beforeEach(() => {
    snapshot.resetLiveFileReadPermitsForTests()
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa137-reader-root-')))
    writeFileSync(path.join(root, 'a.js'), 'const a = 1\n')
    writeFileSync(path.join(root, 'b.js'), 'const b = 2\n')
    const details = statSync(root, { bigint: true })
    admission = { userId: 'u', agentId: 'a', sessionId: 's', root, rootIdentity: `${details.dev}:${details.ino}` }
  })
  afterEach(() => {
    hooks.stage = null
    for (const child of hooks.children.splice(0) as ChildProcess[]) {
      // Every reader child this module started has ended by the time its call returned.
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('a read still running when its time ends is deadline, and the child has exited', async () => {
    hooks.stage = (stage) => (stage === 'file-held' ? 600 : undefined)
    const outcomes = await snapshot.readLiveFiles(admission, ['a.js', 'b.js'], { fileMs: 80 })
    expect([...outcomes.values()]).toEqual([
      { status: 'static', reason: 'deadline' },
      { status: 'static', reason: 'deadline' }
    ])
    expect(hooks.children).toHaveLength(1)
    expect(snapshot.liveFileReadPermitsInUseForTests()).toBe(0)
  }, 20_000)

  it('a Stop during a read throws after the child has exited, and frees the permit', async () => {
    const stop = new AbortController()
    hooks.stage = (stage) => {
      if (stage === 'file-held') {
        stop.abort()
        return 300
      }
    }
    await expect(snapshot.readLiveFiles(admission, ['a.js', 'b.js'], { signal: stop.signal, fileMs: 2_000, phaseMs: 5_000 }))
      .rejects.toBeInstanceOf(snapshot.LiveFileReadStoppedError)
    expect(hooks.children).toHaveLength(1)
    const [child] = hooks.children as ChildProcess[]
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(snapshot.liveFileReadPermitsInUseForTests()).toBe(0)
  }, 20_000)

  it('without a hold the same reads succeed through the test build', async () => {
    const outcomes = await snapshot.readLiveFiles(admission, ['a.js', 'b.js'])
    expect([...outcomes.values()].map((outcome) => outcome.status)).toEqual(['read', 'read'])
  }, 20_000)
})

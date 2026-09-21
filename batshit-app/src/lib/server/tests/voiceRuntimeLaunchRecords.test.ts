import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  attachLocalRuntimeLaunchRecord,
  launchRecordNamesLeader,
  normalizeLocalRuntimeEndpoint,
  parsePsStartTimeUtc,
  pruneLocalRuntimeLaunchRecords,
  removeLocalRuntimeRecordLockIf,
  resolveVoiceRuntimeRegistryIdentity,
  stopDeletedEngineRuntimes,
  withLocalRuntimeRecordLock,
  writeLocalRuntimeLaunchRecord
} from '../services/voiceRuntimeLaunchRecords'
import { syncLocalRuntimeStopPreference } from '../services/voiceRuntimeStopPreference'

// Launch records are what the Mac supervisor and the native launcher stop runtimes from. These
// tests write real files under a throwaway BATSHIT_VOICE_RUNTIME_STATE_ROOT (never the real
// ~/.batshit) and use real pids: this test process is a live one, and an exited child is a dead one.
const PRIMARY = '.batshit-local-runtime-launch.json'
const MLX = {
  command: '/Users/x/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
  args: ['--host', '127.0.0.1', '--port', '8012'],
  cwd: '/Users/x/.batshit/installs/chatterbox-turbo',
  launchedAt: '2026-09-17T01:00:03.000Z'
}

// BL-63: `ps -o lstart=` answers in the user's language unless it runs in C and UTC. This fake
// `ps` answers in English only when both are passed, so a reader that forgets them sees French.
// August, because `Date.parse` happens to read some French months (`sept.`) but not `août`.
const FAKE_PS_STARTED_AT = Date.UTC(2026, 7, 21, 13, 4, 39)
async function withFrenchPs<T>(run: () => Promise<T>): Promise<T> {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'batshit-fake-ps-'))
  await writeFile(
    path.join(bin, 'ps'),
    [
      '#!/bin/sh',
      'if [ "$LC_ALL" = "C" ] && [ "$TZ" = "UTC0" ]; then',
      "  echo 'Fri Aug 21 13:04:39 2026'",
      'else',
      "  echo 'ven. 21 août 13:04:39 2026'",
      'fi',
      ''
    ].join('\n')
  )
  await chmod(path.join(bin, 'ps'), 0o755)
  const saved = { PATH: process.env.PATH, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ }
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  process.env.LC_ALL = 'fr_FR.UTF-8'
  process.env.TZ = 'Europe/Paris'
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(bin, { recursive: true, force: true })
  }
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid as number
}

describe('voice runtime launch records', () => {
  let stateRoot: string
  const originalStateRoot = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-launch-records-'))
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
  })

  afterEach(async () => {
    if (originalStateRoot === undefined) delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    else process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalStateRoot
    await rm(stateRoot, { recursive: true, force: true })
  })

  const files = async (engineId: string) =>
    (await readdir(path.join(stateRoot, engineId)).catch(() => [] as string[])).sort()
  const read = async (engineId: string, name = PRIMARY) =>
    JSON.parse(await readFile(path.join(stateRoot, engineId, name), 'utf8'))

  it('a new launch never discards the record of a process that still runs', async () => {
    // The 2026-09-16 orphan: another Batshit's launch of chatterbox-turbo (8010) overwrote the
    // record of the one still running on 8012, and nothing could stop that one again.
    const stillRunning = process.pid
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: stillRunning, ...MLX })
    await writeLocalRuntimeLaunchRecord({
      engineId: 'chatterbox-turbo',
      pid: 84894,
      ...MLX,
      args: ['--port', '8010']
    })

    expect(await files('chatterbox-turbo')).toEqual([
      `.batshit-local-runtime-launch.${stillRunning}.json`,
      PRIMARY
    ])
    expect((await read('chatterbox-turbo')).pid).toBe(84894)
    expect((await read('chatterbox-turbo', `.batshit-local-runtime-launch.${stillRunning}.json`)).pid).toBe(
      stillRunning
    )
  })

  it('a record whose process is gone is simply replaced', async () => {
    const gone = await deadPid()
    await writeLocalRuntimeLaunchRecord({ engineId: 'whisper-cpp', pid: gone, command: '/bin/whisper-server' })
    await writeLocalRuntimeLaunchRecord({ engineId: 'whisper-cpp', pid: 19339, command: '/bin/whisper-server' })

    expect(await files('whisper-cpp')).toEqual([PRIMARY])
    expect((await read('whisper-cpp')).pid).toBe(19339)
  })

  it('one listener has one spelling', () => {
    for (const spelling of ['http://127.0.0.1:8012', 'http://localhost:8012/', 'http://LOCALHOST:8012/v1']) {
      expect(normalizeLocalRuntimeEndpoint(spelling)).toBe('http://127.0.0.1:8012')
    }
    expect(normalizeLocalRuntimeEndpoint('http://127.0.0.1:8010')).not.toBe('http://127.0.0.1:8012')
    expect(normalizeLocalRuntimeEndpoint('')).toBeNull()
  })

  it('an engine that uses a runtime another launch started records its own choice beside it', async () => {
    await writeLocalRuntimeLaunchRecord({
      engineId: 'chatterbox-turbo',
      pid: process.pid,
      ...MLX,
      endpoint: 'http://127.0.0.1:8012'
    })

    expect(
      await attachLocalRuntimeLaunchRecord({
        engineId: 'kokoro',
        endpoint: 'http://localhost:8012',
        stopOnShutdown: false
      })
    ).toBe(true)
    expect(await read('kokoro')).toMatchObject({
      engineId: 'kokoro',
      pid: process.pid,
      command: MLX.command,
      // The process's own launch time, so the native launcher's ownership window is not fooled.
      launchedAt: MLX.launchedAt,
      startedBy: 'chatterbox-turbo',
      stopOnShutdown: false
    })
  })

  it('no record for a runtime Batshit did not start, a gone one, or the starter itself', async () => {
    // Nothing Batshit launched serves 8013: a server the user runs, or Connect Existing.
    expect(
      await attachLocalRuntimeLaunchRecord({ engineId: 'qwen3-tts', endpoint: 'http://127.0.0.1:8013', stopOnShutdown: true })
    ).toBe(false)

    await writeLocalRuntimeLaunchRecord({
      engineId: 'chatterbox-turbo',
      pid: await deadPid(),
      ...MLX,
      endpoint: 'http://127.0.0.1:8012'
    })
    expect(
      await attachLocalRuntimeLaunchRecord({ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
    ).toBe(false)

    await writeLocalRuntimeLaunchRecord({
      engineId: 'chatterbox-turbo',
      pid: process.pid,
      ...MLX,
      endpoint: 'http://127.0.0.1:8012'
    })
    expect(
      await attachLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
    ).toBe(false)
    expect((await readdir(stateRoot)).sort()).toEqual(['chatterbox-turbo'])
  })

  it('the switch reaches every record of the engine, a moved-aside launch included', async () => {
    await mkdir(path.join(stateRoot, 'chatterbox-turbo'), { recursive: true })
    await writeFile(path.join(stateRoot, 'chatterbox-turbo', PRIMARY), JSON.stringify({ pid: 84894, ...MLX }))
    await writeFile(
      path.join(stateRoot, 'chatterbox-turbo', '.batshit-local-runtime-launch.10778.json'),
      JSON.stringify({ pid: 10778, ...MLX })
    )

    expect(await syncLocalRuntimeStopPreference('chatterbox-turbo', false)).toBe(true)
    expect((await read('chatterbox-turbo')).stopOnShutdown).toBe(false)
    expect((await read('chatterbox-turbo', '.batshit-local-runtime-launch.10778.json')).stopOnShutdown).toBe(false)
  })

  it('the switch on an engine that shares a runtime it did not start records that choice', async () => {
    await writeLocalRuntimeLaunchRecord({
      engineId: 'chatterbox-turbo',
      pid: process.pid,
      ...MLX,
      endpoint: 'http://127.0.0.1:8012'
    })

    expect(
      await syncLocalRuntimeStopPreference('kokoro', false, { endpoint: 'http://127.0.0.1:8012' })
    ).toBe(true)
    expect(await read('kokoro')).toMatchObject({ startedBy: 'chatterbox-turbo', stopOnShutdown: false })

    // Without an endpoint (or with one nothing Batshit started serves) there is nothing to record.
    expect(await syncLocalRuntimeStopPreference('qwen3-tts', false)).toBe(false)
    expect(
      await syncLocalRuntimeStopPreference('qwen3-tts', false, { endpoint: 'http://127.0.0.1:8013' })
    ).toBe(false)
    expect(await files('qwen3-tts')).toEqual([])
  })

  // ---- 2026-09-18 review of 22aa935de: atomic writes, no resurrection, attach clean-up ------

  it('a record is replaced whole (temp file, then rename), never rewritten in place', async () => {
    // A quit reading a record mid-write used to see half of it and drop it as corrupt. A rename
    // swaps the whole file in at once, which shows as a new file (a new inode) every write.
    const gone = await deadPid()
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: gone, ...MLX })
    const first = (await stat(path.join(stateRoot, 'chatterbox-turbo', PRIMARY))).ino
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: gone, ...MLX, stopOnShutdown: false })
    const second = (await stat(path.join(stateRoot, 'chatterbox-turbo', PRIMARY))).ino
    await syncLocalRuntimeStopPreference('chatterbox-turbo', true)
    const third = (await stat(path.join(stateRoot, 'chatterbox-turbo', PRIMARY))).ino

    expect(second).not.toBe(first)
    expect(third).not.toBe(second)
    expect(await read('chatterbox-turbo')).toMatchObject({ pid: gone, stopOnShutdown: true })
    // No temp file or lock is left behind, and neither ever reads as a record.
    expect(await files('chatterbox-turbo')).toEqual([PRIMARY])
  })

  it('a writer removes only its own lock, never one a waiter took over', async () => {
    const dir = path.join(stateRoot, 'kokoro')
    const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
    await withLocalRuntimeRecordLock(dir, async () => {
      await rm(lock, { recursive: true, force: true })
      await mkdir(lock)
      await writeFile(path.join(lock, 'owner'), 'the-waiter')
    })
    expect(await readFile(path.join(lock, 'owner'), 'utf8')).toBe('the-waiter')
    expect(await readdir(dir)).toEqual(['.batshit-local-runtime-launch.lock'])
  })

  it('a stale lock is taken over, whether its time is far in the past or in the future', async () => {
    for (const offsetMs of [-60_000, 60_000]) {
      const dir = path.join(stateRoot, `engine${offsetMs}`)
      const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
      await mkdir(lock, { recursive: true })
      await writeFile(path.join(lock, 'owner'), 'v2:999999999:0:a-writer-that-died')
      const when = new Date(Date.now() + offsetMs)
      await utimes(lock, when, when)
      let ran = false
      await withLocalRuntimeRecordLock(dir, async () => {
        ran = true
      })
      expect(ran).toBe(true)
      const names = await readdir(dir)
      expect(names).toHaveLength(1)
      expect(names[0]).toMatch(/^\.batshit-local-runtime-launch\.reaped-/)
    }
  })

  it('a stale lock whose owner pid was reused is reaped on a French Mac', async () => {
    // The owner pid is alive (this process) but started at another time: the pid was reused.
    const dir = path.join(stateRoot, 'kokoro')
    const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
    await mkdir(dir, { recursive: true })
    await writeFile(lock, `v2:${process.pid}:${FAKE_PS_STARTED_AT - 3_600_000}:an-earlier-owner`)
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    let ran = false
    await withFrenchPs(() =>
      withLocalRuntimeRecordLock(
        dir,
        async () => {
          ran = true
        },
        { waitMs: 500 }
      )
    )
    expect(ran).toBe(true)
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^\.batshit-local-runtime-launch\.reaped-/)
  })

  it('a stale lock whose owner still runs is kept on a French Mac', async () => {
    // Same pid, same start instant: the owner is alive, so its lock is never taken.
    const dir = path.join(stateRoot, 'kokoro')
    const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
    const owner = `v2:${process.pid}:${FAKE_PS_STARTED_AT}:the-live-owner`
    await mkdir(dir, { recursive: true })
    await writeFile(lock, owner)
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    let ran = false
    await withFrenchPs(() =>
      expect(
        withLocalRuntimeRecordLock(
          dir,
          async () => {
            ran = true
          },
          { waitMs: 300 }
        )
      ).rejects.toThrow(/timed out waiting for the launch record lock/)
    )
    expect(ran).toBe(false)
    expect(await readFile(lock, 'utf8')).toBe(owner)
  })

  it('an ownerless or malformed stale lock fails visibly instead of spinning or being deleted', async () => {
    for (const [name, owner] of [
      ['ownerless', null],
      ['malformed', 'not-a-process-identity']
    ] as const) {
      const dir = path.join(stateRoot, name)
      const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
      await mkdir(lock, { recursive: true })
      if (owner) await writeFile(path.join(lock, 'owner'), owner)
      const old = new Date(Date.now() - 60_000)
      await utimes(lock, old, old)
      let ran = false

      await expect(
        withLocalRuntimeRecordLock(dir, async () => {
          ran = true
        })
      ).rejects.toThrow('has no valid owner; refusing unsafe takeover')
      expect(ran).toBe(false)
      expect(await stat(lock)).toBeTruthy()
    }
  })

  it('fails visibly when another dead-owner reaper already claimed the tombstone', async () => {
    const dir = path.join(stateRoot, 'interrupted-reaper')
    const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
    const owner = 'v2:999999999:0:dead-writer'
    await mkdir(dir, { recursive: true })
    await writeFile(lock, owner)
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    const hash = createHash('sha256').update(owner).digest('hex').slice(0, 16)
    await link(lock, path.join(dir, `.batshit-local-runtime-launch.reaped-${hash}`))
    let ran = false

    await expect(
      withLocalRuntimeRecordLock(dir, async () => {
        ran = true
      }, { waitMs: 50 })
    ).rejects.toThrow('has an incomplete prior reap; refusing unsafe takeover')
    expect(ran).toBe(false)
    expect(await readFile(lock, 'utf8')).toBe(owner)
  })

  it('a waiter retries while the winning dead-owner reaper is between claim and unlink', async () => {
    const dir = path.join(stateRoot, 'paused-reaper')
    const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
    const owner = 'v2:999999999:0:dead-writer-paused'
    await mkdir(dir, { recursive: true })
    await writeFile(lock, owner)
    const hash = createHash('sha256').update(owner).digest('hex').slice(0, 16)
    await link(lock, path.join(dir, `.batshit-local-runtime-launch.reaped-${hash}`))
    setTimeout(() => void rm(lock, { force: true }), 30)
    let ran = false

    await withLocalRuntimeRecordLock(dir, async () => {
      ran = true
    }, { waitMs: 500 })
    expect(ran).toBe(true)
  })

  it('waiters never evict a live writer whose lock has aged past the stale threshold', async () => {
    const dir = path.join(stateRoot, 'live-writer')
    const lock = path.join(dir, '.batshit-local-runtime-launch.lock')
    let release!: () => void
    let held!: () => void
    const heldPromise = new Promise<void>((resolve) => (held = resolve))
    const releasePromise = new Promise<void>((resolve) => (release = resolve))
    let waiterEntered = false

    const writer = withLocalRuntimeRecordLock(dir, async () => {
      const old = new Date(Date.now() - 60_000)
      await utimes(lock, old, old)
      held()
      await releasePromise
    })
    await heldPromise
    const waiter = withLocalRuntimeRecordLock(dir, async () => {
      waiterEntered = true
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(waiterEntered).toBe(false)
    release()
    await Promise.all([writer, waiter])
    expect(waiterEntered).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })

  it('taking over a stale lock never removes a fresh one', async () => {
    const lock = path.join(stateRoot, '.batshit-local-runtime-launch.lock')
    await mkdir(lock)
    await writeFile(path.join(lock, 'owner'), 'the-first-waiter')
    const isStale = async (moved: string) => Date.now() - (await stat(moved)).mtimeMs > 10_000
    expect(await removeLocalRuntimeRecordLockIf(lock, isStale)).toBe(false)
    expect(await readFile(path.join(lock, 'owner'), 'utf8')).toBe('the-first-waiter')
    expect(await readdir(stateRoot)).toEqual(['.batshit-local-runtime-launch.lock'])
  })

  it('a toggle save never writes back a record that a launch moved aside', async () => {
    // Launch 1 is running and recorded; a toggle save starts while a new launch holds the lock.
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: process.pid, ...MLX })
    let syncing: Promise<boolean> | null = null
    let syncDoneEarly = false
    await withLocalRuntimeRecordLock(path.join(stateRoot, 'chatterbox-turbo'), async () => {
      syncing = syncLocalRuntimeStopPreference('chatterbox-turbo', false)
      syncing.then(() => (syncDoneEarly = true))
      await new Promise((resolve) => setTimeout(resolve, 100))
      // The new launch, as `writeLocalRuntimeLaunchRecord` does it under the lock: move aside, write.
      const dir = path.join(stateRoot, 'chatterbox-turbo')
      await writeFile(
        path.join(dir, `.batshit-local-runtime-launch.${process.pid}.json`),
        await readFile(path.join(dir, PRIMARY), 'utf8')
      )
      await writeFile(path.join(dir, PRIMARY), JSON.stringify({ engineId: 'chatterbox-turbo', pid: 84894, ...MLX }))
    })
    expect(syncDoneEarly).toBe(false)
    await syncing

    // The new launch keeps its record, and both launches carry the new choice.
    expect(await read('chatterbox-turbo')).toMatchObject({ pid: 84894, stopOnShutdown: false })
    expect(await read('chatterbox-turbo', `.batshit-local-runtime-launch.${process.pid}.json`)).toMatchObject({
      pid: process.pid,
      stopOnShutdown: false
    })
  })

  it('an attach record carries the launching Batshit of the process it names', async () => {
    await writeLocalRuntimeLaunchRecord({
      engineId: 'chatterbox-turbo',
      pid: process.pid,
      ...MLX,
      endpoint: 'http://127.0.0.1:8012',
      launchedBy: 'mac-app:/Users/x/Library/Application Support/Batshit'
    })
    await attachLocalRuntimeLaunchRecord({ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })
    expect((await read('kokoro')).launchedBy).toBe('mac-app:/Users/x/Library/Application Support/Batshit')
  })

  it('a launch immediately reaps a fresh lock whose owner is proven dead', async () => {
    // Giving up would leave the engine running with no record: the orphan records exist to prevent.
    const lock = path.join(stateRoot, 'kokoro', '.batshit-local-runtime-launch.lock')
    await mkdir(lock, { recursive: true })
    await writeFile(path.join(lock, 'owner'), 'v2:999999999:0:a-writer-that-died')

    const startedAt = Date.now()
    await writeLocalRuntimeLaunchRecord({ engineId: 'kokoro', pid: await deadPid(), ...MLX })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect((await files('kokoro')).filter((name) => name === PRIMARY)).toEqual([PRIMARY])
  }, 20_000)

  it('records carry the registry that wrote them', async () => {
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: process.pid, ...MLX, endpoint: 'http://127.0.0.1:8012' })
    await attachLocalRuntimeLaunchRecord({ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })
    const mine = await resolveVoiceRuntimeRegistryIdentity()
    expect(mine).toMatch(/^redis-[0-9a-f]{16}$/)
    expect((await read('chatterbox-turbo')).registry).toBe(mine)
    expect((await read('kokoro')).registry).toBe(mine)
  })

  it('an attach record goes when its engine is deleted or points elsewhere, never another registry\'s', async () => {
    const recipe = { launch: { command: '/opt/mlx/bin/mlx_audio.server' } }
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: process.pid, ...MLX, endpoint: 'http://127.0.0.1:8012' })
    await attachLocalRuntimeLaunchRecord({ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })
    await attachLocalRuntimeLaunchRecord({ engineId: 'qwen3-tts', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })
    // Another Batshit (another registry) recorded its own engine's choice for the same runtime.
    await mkdir(path.join(stateRoot, 'dots-tts'), { recursive: true })
    await writeFile(
      path.join(stateRoot, 'dots-tts', PRIMARY),
      JSON.stringify({ engineId: 'dots-tts', pid: process.pid, ...MLX, startedBy: 'chatterbox-turbo', registry: 'redis-0000000000000000', stopOnShutdown: false })
    )

    await pruneLocalRuntimeLaunchRecords([
      { id: 'chatterbox-turbo', baseUrl: 'http://127.0.0.1:8012', localRuntime: recipe },
      // kokoro was deleted; qwen3-tts now points at another port.
      { id: 'qwen3-tts', baseUrl: 'http://localhost:8013', localRuntime: recipe }
    ])

    expect(await files('kokoro')).toEqual([])
    expect(await files('qwen3-tts')).toEqual([])
    expect(await files('dots-tts')).toEqual([PRIMARY])
    expect(await files('chatterbox-turbo')).toEqual([PRIMARY])
  })

  it('a deleted engine\'s own launch loses its keep-running, so nothing runs on with no switch left', async () => {
    await writeLocalRuntimeLaunchRecord({ engineId: 'whisper-cpp', pid: process.pid, ...MLX, stopOnShutdown: false })

    await pruneLocalRuntimeLaunchRecords([])

    const record = await read('whisper-cpp')
    expect(record.pid).toBe(process.pid)
    expect(record.stopOnShutdown).toBeUndefined()
  })

  // ---- The leader's start time names the launch (2026-09-21, BL-60) -------------------------

  const running: number[] = []
  afterEach(() => {
    for (const pid of running.splice(0)) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL')
        } catch {}
      }
    }
  })

  // A detached "engine" started through a launcher that re-executes into another program, as the
  // python.org framework Python does: its live command line holds no recorded path.
  async function startReexecutingEngine(engineId: string) {
    const installRoot = path.join(stateRoot, 'installs', engineId)
    await mkdir(path.join(installRoot, '.venv', 'bin'), { recursive: true })
    const launcher = path.join(installRoot, '.venv', 'bin', 'python')
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" -e "setInterval(() => {}, 1000)"\n`, { mode: 0o755 })
    const args = ['-m', 'uvicorn', 'server:app', '--port', '8122']
    const child = spawn(launcher, args, { cwd: installRoot, detached: true, stdio: 'ignore' })
    child.unref()
    running.push(child.pid as number)
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { pid: child.pid as number, command: launcher, args, cwd: installRoot }
  }

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('reads ps start times only in the C locale and UTC', () => {
    expect(parsePsStartTimeUtc('Sun Sep 20 09:01:05 2026')).toBe(Date.parse('2026-09-20T09:01:05.000Z'))
    expect(parsePsStartTimeUtc('Sun Sep  6 09:01:05 2026')).toBe(Date.parse('2026-09-06T09:01:05.000Z'))
    expect(parsePsStartTimeUtc('lun. 21 sept. 13:04:39 2026')).toBeNull()
  })

  it('a leader that started by the launch time is that launch; one that started later is a reused pid', () => {
    const record = { ...MLX, pid: 4242 }
    expect(launchRecordNamesLeader(record, Date.parse(MLX.launchedAt) - 1_000)).toBe(true)
    expect(launchRecordNamesLeader(record, Date.parse(MLX.launchedAt) + 1_000)).toBe(false)
    expect(launchRecordNamesLeader(record, null)).toBeNull()
    // Started long before any launch could be recorded (a clock set back since): proves nothing.
    expect(launchRecordNamesLeader(record, Date.parse(MLX.launchedAt) - 120_000)).toBeNull()
    expect(launchRecordNamesLeader({ ...record, launchedAt: undefined }, Date.parse(MLX.launchedAt))).toBeNull()
  })

  it('Delete local files too stops an engine whose interpreter re-executed itself (BL-60)', async () => {
    const engine = await startReexecutingEngine('dots-tts-mf')
    await writeLocalRuntimeLaunchRecord({ engineId: 'dots-tts-mf', ...engine, launchedAt: new Date().toISOString() })

    const result = await stopDeletedEngineRuntimes('dots-tts-mf')

    expect(result).toEqual({ stopped: [engine.pid], keptForOtherEngines: [], notStopped: [] })
    expect(isAlive(engine.pid)).toBe(false)
  })

  it('Delete local files too leaves a process that took a recorded pid later, even one that looks the same', async () => {
    const stranger = await startReexecutingEngine('stranger')
    // Its command line matches this record (it IS node), but it started after the record was written.
    await writeLocalRuntimeLaunchRecord({
      engineId: 'whisper-cpp',
      ...stranger,
      command: process.execPath,
      launchedAt: new Date(Date.now() - 60_000).toISOString()
    })

    const result = await stopDeletedEngineRuntimes('whisper-cpp')

    expect(result).toEqual({ stopped: [], keptForOtherEngines: [], notStopped: [] })
    expect(isAlive(stranger.pid)).toBe(true)
  })
})

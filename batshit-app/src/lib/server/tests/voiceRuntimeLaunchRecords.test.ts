import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  attachLocalRuntimeLaunchRecord,
  isLocalRuntimeProcessAlive,
  launchArgsForAttach,
  launchRecordNamesLeader,
  listLocalRuntimeLaunchRecords,
  normalizeLocalRuntimeEndpoint,
  parsePsStartTimeUtc,
  pruneLocalRuntimeLaunchRecords,
  readRuntimeUseState,
  recordVerifiedRuntimeUse,
  removeDeletedEngineFiles,
  removeLocalRuntimeRecordLockIf,
  resolveVoiceRuntimeRegistryIdentity,
  setLocalRuntimeStopChoice,
  stopDeletedEngineRuntimes,
  stopSolelyOwnedLaunchForRestart,
  verifyOwnLaunchServes,
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
  // The Docker host operator's records folder (BL-1292): never the real one under ~/.batshit.
  let operatorRoot: string
  const originalStateRoot = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
  const originalOperatorRoot = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-launch-records-'))
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
    operatorRoot = `${stateRoot}-operator`
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR = operatorRoot
  })

  afterEach(async () => {
    if (originalStateRoot === undefined) delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    else process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalStateRoot
    if (originalOperatorRoot === undefined) delete process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR
    else process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR = originalOperatorRoot
    await rm(stateRoot, { recursive: true, force: true })
    await rm(operatorRoot, { recursive: true, force: true })
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

  it('the switch reaches every record of the engine this Batshit wrote, a moved-aside launch included', async () => {
    const registry = await resolveVoiceRuntimeRegistryIdentity()
    await mkdir(path.join(stateRoot, 'chatterbox-turbo'), { recursive: true })
    await writeFile(path.join(stateRoot, 'chatterbox-turbo', PRIMARY), JSON.stringify({ pid: 84894, ...MLX, registry }))
    await writeFile(
      path.join(stateRoot, 'chatterbox-turbo', '.batshit-local-runtime-launch.10778.json'),
      JSON.stringify({ pid: 10778, ...MLX, registry })
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
      await writeFile(
        path.join(dir, PRIMARY),
        JSON.stringify({ engineId: 'chatterbox-turbo', pid: 84894, ...MLX, registry: await resolveVoiceRuntimeRegistryIdentity() })
      )
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

  it('an attach copies no secret flag or its value, even one that starts with "/", and only the paths (BL-1332)', () => {
    // Every form LiveKit takes: the value next, or after "=", with one or two dashes; and a key or
    // secret that begins with "/", which a path filter alone would keep.
    expect(launchArgsForAttach(['--dev', '--bind', '127.0.0.1', '--keys', '/devkey: /a-secret', '/opt/livekit/serve.yaml'])).toEqual([
      '/opt/livekit/serve.yaml'
    ])
    expect(launchArgsForAttach(['--keys=/devkey: /a-secret', '/opt/livekit/serve.yaml'])).toEqual(['/opt/livekit/serve.yaml'])
    expect(launchArgsForAttach(['-keys', '/devkey: /a-secret', '-keys=/devkey: /a-secret', '/opt/a'])).toEqual(['/opt/a'])
    expect(launchArgsForAttach(['--config-body', 'keys:\n  /devkey: /a-secret', '--config-body=keys: {k: /s}', '/opt/a'])).toEqual(['/opt/a'])
    // A flag at the end with no value drops nothing else; non-strings and plain words are left out.
    expect(launchArgsForAttach(['/opt/a', 7, '--port', '8012', '--keys'])).toEqual(['/opt/a'])
    expect(launchArgsForAttach(undefined)).toBeUndefined()
    // Windows paths stay (the Docker operator's identity check reads them); a key that looks like
    // one, as a drive path or a share, still goes.
    expect(
      launchArgsForAttach(['C:\\Batshit\\installs\\x\\serve.py', '--keys', 'C:\\devkey: s', '--keys', '\\\\host\\share: s', 'serve.py'])
    ).toEqual(['C:\\Batshit\\installs\\x\\serve.py'])
  })

  it('an attach to a launch whose record still holds its keys copies neither them nor anything but paths (BL-1332)', async () => {
    // A record written before BL-1332: the LiveKit server's keys on its args.
    await writeLocalRuntimeLaunchRecord({
      engineId: 'chatterbox-turbo',
      pid: process.pid,
      ...MLX,
      args: ['--port', '8012', '--keys', '/devkey: /a-secret', '/Users/x/.batshit/installs/chatterbox-turbo/serve.py'],
      endpoint: 'http://127.0.0.1:8012'
    })
    expect(await attachLocalRuntimeLaunchRecord({ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })).toBe(true)

    expect((await read('kokoro')).args).toEqual(['/Users/x/.batshit/installs/chatterbox-turbo/serve.py'])
    expect(await readFile(path.join(stateRoot, 'kokoro', PRIMARY), 'utf8')).not.toContain('a-secret')
    // The starter's own record is not this change's to rewrite.
    expect((await read('chatterbox-turbo')).args).toContain('/devkey: /a-secret')
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

  // Cleanup signals only a child of this test that Node has not yet seen exit: until Node reaps
  // it, its pid cannot be anyone else's. One the code under test stopped is left alone.
  const running: ChildProcess[] = []
  afterEach(() => {
    for (const child of running.splice(0)) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
      for (const target of [-child.pid, child.pid]) {
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
    running.push(child)
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

    expect(result).toEqual({ stopped: [engine.pid], keptForOtherEngines: [], notStopped: [], unreadable: [] })
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

    expect(result).toEqual({ stopped: [], keptForOtherEngines: [], notStopped: [], unreadable: [] })
    expect(isAlive(stranger.pid)).toBe(true)
  })

  // ---- A record that cannot be read (BL-1267, BL-1268) ------------------------------------
  //
  // The app's reader treated "could not be read" as "no record" and its writer read it as missing
  // or replaceable, so a launch wrote over it, and "Delete local files too" could remove an
  // engine's folder under a process that record named.

  // Each shape that is not a readable record, made in `dir`; `unlock` gets what a test must chmod back.
  const UNREADABLE: Record<string, { make: (dir: string, unlock: string[]) => Promise<unknown>; reason: RegExp }> = {
    'record-is-folder': { make: (dir) => mkdir(path.join(dir, PRIMARY), { recursive: true }), reason: /could not be read \(EISDIR\)/ },
    'record-no-permission': {
      make: async (dir, unlock) => {
        await writeFile(path.join(dir, PRIMARY), JSON.stringify({ pid: 12, command: '/bin/x', stopOnShutdown: false }))
        await chmod(path.join(dir, PRIMARY), 0o000)
        unlock.push(path.join(dir, PRIMARY))
      },
      reason: /could not be read \(EACCES\)/
    },
    empty: { make: (dir) => writeFile(path.join(dir, PRIMARY), ''), reason: /is empty/ },
    malformed: { make: (dir) => writeFile(path.join(dir, PRIMARY), '{ "pid": 12, "stopOnShutdown": fal'), reason: /is not valid JSON/ },
    array: { make: (dir) => writeFile(path.join(dir, PRIMARY), '[{ "pid": 12 }]'), reason: /is not a JSON object/ },
    null: { make: (dir) => writeFile(path.join(dir, PRIMARY), 'null'), reason: /is not a JSON object/ }
  }

  // What is in an engine folder now: each entry's name and, for a file, its bytes.
  async function snapshot(engineId: string) {
    const out: Record<string, string> = {}
    for (const name of await files(engineId)) {
      const entry = path.join(stateRoot, engineId, name)
      if ((await stat(entry)).isDirectory()) out[name] = 'folder'
      else {
        await chmod(entry, 0o644)
        out[name] = await readFile(entry, 'utf8')
      }
    }
    return out
  }

  const WRITE_REFUSAL =
    /Batshit did not write over it: it may belong to a voice engine that is still running\. Once that engine has stopped \(restarting the computer stops it\), repair or remove the file and try again\.$/

  it('the reader lists a record it cannot read as an unreadable entry, and the writer never writes over one (BL-1267, BL-1268)', async () => {
    const unlock: string[] = []
    try {
      for (const [engineId, shape] of Object.entries(UNREADABLE)) {
        await mkdir(path.join(stateRoot, engineId), { recursive: true })
        await shape.make(path.join(stateRoot, engineId), unlock)
      }
      const entries = await listLocalRuntimeLaunchRecords()
      for (const [engineId, shape] of Object.entries(UNREADABLE)) {
        const entry = entries.find((candidate) => candidate.engineId === engineId)
        expect(entry, engineId).toMatchObject({ unreadable: true, invalid: true, recordPath: path.join(stateRoot, engineId, PRIMARY) })
        expect(entry?.reason, engineId).toMatch(shape.reason)
        await expect(
          writeLocalRuntimeLaunchRecord({ engineId, pid: process.pid, ...MLX }),
          engineId
        ).rejects.toThrow(WRITE_REFUSAL)
      }
      for (const target of unlock) await chmod(target, 0o644)
      for (const engineId of Object.keys(UNREADABLE)) {
        expect(Object.keys(await snapshot(engineId)), `${engineId}: no temp file, moved-aside record or lock left`).toEqual([PRIMARY])
      }
      expect((await snapshot('malformed'))[PRIMARY]).toBe('{ "pid": 12, "stopOnShutdown": fal')
      expect((await snapshot('record-no-permission'))[PRIMARY]).toBe(
        JSON.stringify({ pid: 12, command: '/bin/x', stopOnShutdown: false })
      )
      // A folder that cannot be read, and a state root that cannot be read, are entries too.
      await mkdir(path.join(stateRoot, 'locked-folder'), { recursive: true })
      await chmod(path.join(stateRoot, 'locked-folder'), 0o000)
      unlock.push(path.join(stateRoot, 'locked-folder'))
      expect(await listLocalRuntimeLaunchRecords('locked-folder')).toEqual([
        expect.objectContaining({ engineId: 'locked-folder', unreadable: true, reason: expect.stringMatching(/the folder .* could not be read \(EACCES\)/) })
      ])
      await writeFile(path.join(stateRoot, 'not-a-folder'), '')
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = path.join(stateRoot, 'not-a-folder')
      expect(await listLocalRuntimeLaunchRecords()).toEqual([
        expect.objectContaining({ engineId: null, unreadable: true, reason: expect.stringMatching(/records folder .* could not be read \(ENOTDIR\)/) })
      ])
    } finally {
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
      for (const target of unlock) await chmod(target, 0o755).catch(() => {})
    }
  })

  // BL-1275: two live fakes with their own pids (this test process is one live pid; a shared
  // runtime and a second one need two more), and a way to write as another Batshit (registry).
  async function liveFake(): Promise<{ pid: number; stop: () => void }> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise((resolve) => child.once('spawn', resolve))
    return { pid: child.pid as number, stop: () => child.kill('SIGKILL') }
  }

  async function asRegistry<T>(db: number, run: () => Promise<T>): Promise<T> {
    const saved = process.env.REDIS_URL
    process.env.REDIS_URL = `redis://127.0.0.1:6379/${db}`
    try {
      return await run()
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = saved
    }
  }

  const COLLISION =
    /already holds a launch record for process \d+ \(the runtime of engine "[^"]+"(, started by [^)]+)?\), so Batshit did not move .+ onto it: both records are kept\. Try again once that runtime has stopped \(restarting the computer stops it\)\.$/

  it('a running launch is never moved onto a moved-aside name that already holds a readable record (BL-1275)', async () => {
    const live = await liveFake()
    try {
      await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: live.pid, ...MLX })
      const aside = `.batshit-local-runtime-launch.${live.pid}.json`
      // A readable earlier record of the same process with another choice and another registry.
      await writeFile(
        path.join(stateRoot, 'chatterbox-turbo', aside),
        JSON.stringify({ engineId: 'chatterbox-turbo', pid: live.pid, ...MLX, startedBy: 'kokoro', registry: 'redis-0000000000000000', stopOnShutdown: false })
      )
      const before = await snapshot('chatterbox-turbo')

      await expect(writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: 19339, ...MLX })).rejects.toThrow(COLLISION)
      expect(await snapshot('chatterbox-turbo')).toEqual(before)
    } finally {
      live.stop()
    }
  })

  it('a moved-aside name of another pid is no collision: the running launch moves aside as before (BL-1275)', async () => {
    const live = await liveFake()
    try {
      await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: live.pid, ...MLX })
      const other = `.batshit-local-runtime-launch.${process.pid}.json`
      await writeFile(path.join(stateRoot, 'chatterbox-turbo', other), JSON.stringify({ engineId: 'chatterbox-turbo', pid: process.pid, ...MLX }))
      const otherBytes = await readFile(path.join(stateRoot, 'chatterbox-turbo', other), 'utf8')

      await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: 19339, ...MLX })

      expect(await files('chatterbox-turbo')).toEqual([`.batshit-local-runtime-launch.${live.pid}.json`, other, PRIMARY].sort())
      expect((await read('chatterbox-turbo')).pid).toBe(19339)
      expect(await readFile(path.join(stateRoot, 'chatterbox-turbo', other), 'utf8')).toBe(otherBytes)
    } finally {
      live.stop()
    }
  })

  it("three Batshits sharing one engine folder: a re-attach never erases another's keep-running (BL-1275, BL-1286)", async () => {
    const p = await liveFake()
    const q = await liveFake()
    try {
      // Starters: P serves :8012 and its own record says stop; Q serves :8013.
      await writeLocalRuntimeLaunchRecord({ engineId: 'starter-p', pid: p.pid, ...MLX, endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
      await writeLocalRuntimeLaunchRecord({ engineId: 'starter-q', pid: q.pid, ...MLX, endpoint: 'http://127.0.0.1:8013', stopOnShutdown: true })
      // Batshit A: its E uses P and keeps it running.
      await asRegistry(1, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false }))
      // Batshit C: its E uses Q (A's record of P moves aside).
      await asRegistry(3, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8013', stopOnShutdown: true }))
      // Batshit B: its E uses P and says stop (C's record of Q moves aside).
      await asRegistry(2, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true }))
      const asideP = `.batshit-local-runtime-launch.${p.pid}.json`
      const asideQ = `.batshit-local-runtime-launch.${q.pid}.json`
      expect((await read('e', asideP)).stopOnShutdown).toBe(false)
      const before = await snapshot('e')

      // Batshit C re-attaches Q: its own record of Q (moved aside) is refreshed where it lies, so
      // nothing moves, nothing is refused, and every record keeps its bytes.
      expect(
        await asRegistry(3, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8013', stopOnShutdown: true }))
      ).toBe(false)
      expect(await snapshot('e')).toEqual(before)
      // Its choice changes only its own record.
      expect(
        await asRegistry(3, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8013', stopOnShutdown: false }))
      ).toBe(true)
      const after = await snapshot('e')
      expect(JSON.parse(after[asideQ]).stopOnShutdown).toBe(false)
      expect(after[asideP]).toBe(before[asideP])
      expect(after[PRIMARY]).toBe(before[PRIMARY])
      // A's "keep running" for P is still there, so every stopper keeps P.
      const recordsOfP = (await listLocalRuntimeLaunchRecords()).filter((record) => !record.unreadable && record.pid === p.pid)
      expect(recordsOfP.some((record) => record.stopOnShutdown === false)).toBe(true)
    } finally {
      p.stop()
      q.stop()
    }
  })

  // BL-1275 S1: two Batshits, and a restart of one, no longer make the other's next launch refuse.
  it('two Batshits: a restart re-attaches in place, so the other Batshit can launch again and both choices stay (BL-1275)', async () => {
    const p = await liveFake()
    const q = await liveFake()
    try {
      await writeLocalRuntimeLaunchRecord({ engineId: 'starter-p', pid: p.pid, ...MLX, endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
      // A: its E uses P and keeps it running. B: launches its own E as Q (A's record moves aside).
      await asRegistry(1, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false }))
      await asRegistry(2, () => writeLocalRuntimeLaunchRecord({ engineId: 'e', pid: q.pid, ...MLX, launchedAt: new Date().toISOString() }))
      const asideP = `.batshit-local-runtime-launch.${p.pid}.json`
      expect(await files('e')).toEqual([asideP, PRIMARY].sort())
      // A restarts; P kept running. A's boot re-attach refreshes its record where it lies.
      expect(
        await asRegistry(1, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false }))
      ).toBe(false)
      expect(await files('e')).toEqual([asideP, PRIMARY].sort())
      expect((await read('e')).pid).toBe(q.pid)
      // B quits (Q stops) and launches E again: nothing is refused, and A's choice stays.
      q.stop()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await asRegistry(2, () => writeLocalRuntimeLaunchRecord({ engineId: 'e', pid: 19339, ...MLX }))
      expect((await read('e')).pid).toBe(19339)
      expect((await read('e', asideP)).stopOnShutdown).toBe(false)
    } finally {
      p.stop()
      q.stop()
    }
  })

  it('a re-attach never refreshes an older attachment whose pid a newer launch took: it records the new launch (BL-1286)', async () => {
    const p = await liveFake()
    try {
      // The starter's current launch is pid P, launched now; this Batshit's attach record names an
      // older launch that had the same pid (its launch time is earlier), as after a crash.
      const now = new Date().toISOString()
      await writeLocalRuntimeLaunchRecord({ engineId: 'starter-p', pid: p.pid, ...MLX, launchedAt: now, endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
      await mkdir(path.join(stateRoot, 'e'), { recursive: true })
      await writeFile(
        path.join(stateRoot, 'e', PRIMARY),
        JSON.stringify({
          engineId: 'e',
          pid: p.pid,
          ...MLX,
          launchedAt: '2026-09-01T00:00:00.000Z',
          endpoint: 'http://127.0.0.1:8012',
          startedBy: 'starter-p',
          registry: await resolveVoiceRuntimeRegistryIdentity(),
          stopOnShutdown: true
        })
      )

      expect(await attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })).toBe(true)

      // The record now names the current launch, so a stopper reads it as this process's, and holds the choice.
      expect(await read('e')).toMatchObject({ pid: p.pid, launchedAt: now, stopOnShutdown: false })
      expect(await files('e')).toEqual([PRIMARY])
    } finally {
      p.stop()
    }
  })

  it("another Batshit's record of the same process is kept beside, never replaced, and only its own Batshit changes it (BL-1286)", async () => {
    const p = await liveFake()
    try {
      await writeLocalRuntimeLaunchRecord({ engineId: 'starter-p', pid: p.pid, ...MLX, endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
      // A: its E uses P and keeps it running (E's current record).
      await asRegistry(1, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false }))
      const aBytes = await readFile(path.join(stateRoot, 'e', PRIMARY), 'utf8')
      // B saves its E (any update syncs it): A's live record must not stand in for B's own, and
      // B's choice must not reach A's record. B gets its own record of P; A's moves aside intact.
      expect(await asRegistry(2, () => syncLocalRuntimeStopPreference('e', true, { endpoint: 'http://127.0.0.1:8012' }))).toBe(true)
      const asideP = `.batshit-local-runtime-launch.${p.pid}.json`
      expect(await readFile(path.join(stateRoot, 'e', asideP), 'utf8')).toBe(aBytes)
      expect(await read('e')).toMatchObject({ pid: p.pid, stopOnShutdown: true, registry: await asRegistry(2, () => resolveVoiceRuntimeRegistryIdentity()) })
      // B's boot re-attach and its next toggle touch only B's record.
      await asRegistry(2, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true }))
      await asRegistry(2, () => syncLocalRuntimeStopPreference('e', true, { endpoint: 'http://127.0.0.1:8012' }))
      expect(await readFile(path.join(stateRoot, 'e', asideP), 'utf8')).toBe(aBytes)
      // A's toggle reaches A's record (moved aside) and leaves B's alone.
      await asRegistry(1, () => syncLocalRuntimeStopPreference('e', false, { endpoint: 'http://127.0.0.1:8012' }))
      expect((await read('e', asideP)).stopOnShutdown).toBe(false)
      expect((await read('e')).stopOnShutdown).toBe(true)
      // Shutdown: one "keep running" for P keeps P.
      const recordsOfP = (await listLocalRuntimeLaunchRecords()).filter((record) => !record.unreadable && record.pid === p.pid)
      expect(recordsOfP.some((record) => record.stopOnShutdown === false)).toBe(true)
    } finally {
      p.stop()
    }
  })

  it('a record with no registry is not this Batshit\'s: the switch leaves it, and it never stands in for an attachment (BL-1286)', async () => {
    const p = await liveFake()
    try {
      await writeLocalRuntimeLaunchRecord({ engineId: 'starter-p', pid: p.pid, ...MLX, endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
      // An attach record whose owner cannot be established (no registry), saying keep running.
      await mkdir(path.join(stateRoot, 'e'), { recursive: true })
      const legacy = JSON.stringify({ engineId: 'e', pid: p.pid, ...MLX, endpoint: 'http://127.0.0.1:8012', startedBy: 'starter-p', stopOnShutdown: false })
      await writeFile(path.join(stateRoot, 'e', PRIMARY), legacy)

      await syncLocalRuntimeStopPreference('e', true, { endpoint: 'http://127.0.0.1:8012' })

      const asideP = `.batshit-local-runtime-launch.${p.pid}.json`
      expect(await readFile(path.join(stateRoot, 'e', asideP), 'utf8')).toBe(legacy)
      expect(await read('e')).toMatchObject({ pid: p.pid, stopOnShutdown: true, registry: await resolveVoiceRuntimeRegistryIdentity() })
    } finally {
      p.stop()
    }
  })

  it("an attachment refused because the moved-aside name is taken stops nothing and keeps every record's bytes (BL-1286)", async () => {
    const p = await liveFake()
    try {
      await writeLocalRuntimeLaunchRecord({ engineId: 'starter-p', pid: p.pid, ...MLX, endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true })
      await asRegistry(1, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false }))
      // The moved-aside name of P is already taken by a third Batshit's record of P.
      const asideP = `.batshit-local-runtime-launch.${p.pid}.json`
      await writeFile(
        path.join(stateRoot, 'e', asideP),
        JSON.stringify({ engineId: 'e', pid: p.pid, ...MLX, startedBy: 'starter-p', registry: 'redis-0000000000000000', stopOnShutdown: false })
      )
      const before = await snapshot('e')

      await expect(
        asRegistry(2, () => attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true }))
      ).rejects.toThrow(COLLISION)
      expect(await snapshot('e')).toEqual(before)
      // P is another engine's runtime: a refused attachment never stops it.
      expect(isLocalRuntimeProcessAlive(p.pid)).toBe(true)
    } finally {
      p.stop()
    }
  })

  it('a running launch is never moved onto a moved-aside name that cannot be read (BL-1267)', async () => {
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: process.pid, ...MLX })
    const aside = `.batshit-local-runtime-launch.${process.pid}.json`
    await writeFile(path.join(stateRoot, 'chatterbox-turbo', aside), '{ "pid": 1, "stopOnShutdown": fal')
    const before = await snapshot('chatterbox-turbo')

    await expect(writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: 19339, ...MLX })).rejects.toThrow(
      /is not valid JSON\. Batshit did not write over it/
    )
    expect(await snapshot('chatterbox-turbo')).toEqual(before)
  })

  it('an attach and the switch never write over a record that cannot be read (BL-1267, BL-1268)', async () => {
    // chatterbox-turbo's launch started the runtime (this test process stands in for it).
    await writeLocalRuntimeLaunchRecord({ engineId: 'chatterbox-turbo', pid: process.pid, ...MLX, endpoint: 'http://127.0.0.1:8012' })
    await mkdir(path.join(stateRoot, 'kokoro'), { recursive: true })
    const garbled = '{ "pid": 1, "startedBy": "chatterbox-turbo", "stopOnShutdown": fal'
    await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), garbled)
    await expect(
      attachLocalRuntimeLaunchRecord({ engineId: 'kokoro', endpoint: 'http://localhost:8012', stopOnShutdown: true })
    ).rejects.toThrow(WRITE_REFUSAL)
    // The toggle's sync tries the same attach, says so in the log, and writes nothing.
    expect(await syncLocalRuntimeStopPreference('kokoro', true, { endpoint: 'http://localhost:8012' })).toBe(false)
    expect(await snapshot('kokoro')).toEqual({ [PRIMARY]: garbled })

    // The switch reaches the readable records and leaves the unreadable one as it is.
    const aside = `.batshit-local-runtime-launch.${process.pid}.json`
    await writeFile(path.join(stateRoot, 'chatterbox-turbo', aside), '')
    const result = await setLocalRuntimeStopChoice('chatterbox-turbo', false)
    expect(result.changed).toBe(true)
    expect(result.live).toBe(true)
    expect(result.unreadable).toEqual([expect.stringMatching(new RegExp(`${aside.replaceAll('.', '\\.')} is empty`))])
    expect((await read('chatterbox-turbo')).stopOnShutdown).toBe(false)
    expect((await snapshot('chatterbox-turbo'))[aside]).toBe('')

    // The prune never touches one either.
    await pruneLocalRuntimeLaunchRecords([])
    expect(await snapshot('kokoro')).toEqual({ [PRIMARY]: garbled })
  })

  it('Delete local files too stops nothing while a record it cannot read could name the engine (BL-1268)', async () => {
    const engine = await startReexecutingEngine('dots-tts-mf')
    await writeLocalRuntimeLaunchRecord({ engineId: 'dots-tts-mf', ...engine, launchedAt: new Date().toISOString() })

    // Its own folder: an earlier launch's record, moved aside and now malformed.
    const aside = path.join(stateRoot, 'dots-tts-mf', '.batshit-local-runtime-launch.4242.json')
    await writeFile(aside, '{ "pid": 4242')
    const own = await stopDeletedEngineRuntimes('dots-tts-mf')
    expect(own.stopped).toEqual([])
    expect(own.unreadable).toEqual([{ recordPath: aside, reason: expect.stringMatching(/\.4242\.json is not valid JSON/) }])
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(isAlive(engine.pid)).toBe(true)
    await rm(aside)

    // Another engine's folder, one that is not being deleted: it may be that engine's attach record.
    await mkdir(path.join(stateRoot, 'kokoro'), { recursive: true })
    await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), '')
    const other = await stopDeletedEngineRuntimes('dots-tts-mf')
    expect(other.stopped).toEqual([])
    expect(other.unreadable).toEqual([{ recordPath: path.join(stateRoot, 'kokoro', PRIMARY), reason: expect.stringMatching(/is empty/) }])
    expect(isAlive(engine.pid)).toBe(true)

    // An engine with no launch of its own still running has nothing an attach could name.
    expect(await stopDeletedEngineRuntimes('whisper-cpp')).toEqual({ stopped: [], keptForOtherEngines: [], notStopped: [], unreadable: [] })

    // A state root that cannot be read holds it as well: nothing in it can be read.
    await writeFile(path.join(stateRoot, 'not-a-folder'), '')
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = path.join(stateRoot, 'not-a-folder')
    try {
      const root = await stopDeletedEngineRuntimes('dots-tts-mf')
      expect(root.stopped).toEqual([])
      expect(root.unreadable).toEqual([
        { recordPath: path.join(stateRoot, 'not-a-folder'), reason: expect.stringMatching(/records folder .* could not be read \(ENOTDIR\)/) }
      ])
      // The switch says it could not reach that engine's records, and writes nothing.
      expect(await setLocalRuntimeStopChoice('dots-tts-mf', false)).toEqual({
        changed: false,
        live: false,
        unreadable: [expect.stringMatching(/the folder .* could not be read \(ENOTDIR\)/)]
      })
    } finally {
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
    }
    expect(isAlive(engine.pid)).toBe(true)

    // When that other engine is being deleted too, its record has no say over this one.
    const both = await stopDeletedEngineRuntimes('dots-tts-mf', new Set(['dots-tts-mf', 'kokoro']))
    expect(both).toEqual({ stopped: [engine.pid], keptForOtherEngines: [], notStopped: [], unreadable: [] })
    expect(isAlive(engine.pid)).toBe(false)
  })

  // BL-1293: Batshit B uses Batshit A's running launch of the same engine id (B's boot finds it
  // already answering and does not launch its own). B's choice used to be recorded nowhere.
  it("another Batshit's launch of the same engine gets this Batshit's own attachment and choice (BL-1293)", async () => {
    const p = await liveFake()
    try {
      const endpoint = 'http://127.0.0.1:8012'
      // A launched E and says stop.
      await asRegistry(2, () => writeLocalRuntimeLaunchRecord({ engineId: 'e', pid: p.pid, ...MLX, endpoint, stopOnShutdown: true }))
      const aBytes = await readFile(path.join(stateRoot, 'e', PRIMARY), 'utf8')
      const asideP = `.batshit-local-runtime-launch.${p.pid}.json`

      // B (this registry) keeps it running: its own attach record, A's launch kept beside intact.
      expect(await attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint, stopOnShutdown: false })).toBe(true)
      expect(await readFile(path.join(stateRoot, 'e', asideP), 'utf8')).toBe(aBytes)
      expect(await read('e')).toMatchObject({ engineId: 'e', pid: p.pid, startedBy: 'e', stopOnShutdown: false, registry: await resolveVoiceRuntimeRegistryIdentity() })

      // B's switch reaches B's record only; A's reaches A's only.
      expect(await syncLocalRuntimeStopPreference('e', true, { endpoint })).toBe(true)
      expect((await read('e')).stopOnShutdown).toBe(true)
      expect(await readFile(path.join(stateRoot, 'e', asideP), 'utf8')).toBe(aBytes)
      await syncLocalRuntimeStopPreference('e', false, { endpoint })
      await asRegistry(2, () => syncLocalRuntimeStopPreference('e', true, { endpoint }))
      expect((await read('e')).stopOnShutdown).toBe(false)
      expect((await read('e', asideP)).stopOnShutdown).toBe(true)

      // A's delete honors B's use: it does not stop P.
      const deleted = await asRegistry(2, () => stopDeletedEngineRuntimes('e'))
      expect(deleted).toEqual({ stopped: [], keptForOtherEngines: [p.pid], notStopped: [], unreadable: [] })
      expect(isAlive(p.pid)).toBe(true)
      // A's quit: one "keep running" for P keeps P (decideLocalRuntimeGroupStop sees every record of it).
      const recordsOfP = (await listLocalRuntimeLaunchRecords()).filter((record) => !record.unreadable && record.pid === p.pid)
      expect(recordsOfP.some((record) => record.stopOnShutdown === false)).toBe(true)
    } finally {
      p.stop()
    }
  })

  it('a launch of the same engine whose owner is unknown (no registry) gets this Batshit\'s own attachment too (BL-1293)', async () => {
    const p = await liveFake()
    try {
      await mkdir(path.join(stateRoot, 'e'), { recursive: true })
      const unknown = JSON.stringify({ engineId: 'e', pid: p.pid, ...MLX, endpoint: 'http://127.0.0.1:8012' })
      await writeFile(path.join(stateRoot, 'e', PRIMARY), unknown)

      expect(await attachLocalRuntimeLaunchRecord({ engineId: 'e', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })).toBe(true)
      expect(await readFile(path.join(stateRoot, 'e', `.batshit-local-runtime-launch.${p.pid}.json`), 'utf8')).toBe(unknown)
      expect(await read('e')).toMatchObject({ startedBy: 'e', stopOnShutdown: false })
    } finally {
      p.stop()
    }
  })

  // ---- "Delete local files too" with several Batshits on one computer (BL-1289) --------------
  //
  // Every Batshit that keeps the default folders shares `~/.batshit/installs/<id>` and the engine's
  // state folder. Deleting the engine in one never stops another's launch of the same engine id,
  // never removes its records, and never removes the folders that other one still uses.

  type LaunchRecord = Parameters<typeof writeLocalRuntimeLaunchRecord>[0]
  const OTHER_OWNERS: Array<[string, (record: LaunchRecord) => Promise<unknown>]> = [
    ['another Batshit', (record) => asRegistry(2, () => writeLocalRuntimeLaunchRecord(record))],
    [
      'an unknown owner (no registry)',
      async (record) => {
        await mkdir(path.join(stateRoot, record.engineId), { recursive: true })
        await writeFile(path.join(stateRoot, record.engineId, PRIMARY), JSON.stringify(record))
      }
    ]
  ]

  for (const [owner, recordTheirs] of OTHER_OWNERS) {
    it(`Delete local files too never stops a launch of the same engine by ${owner} (BL-1289)`, async () => {
      const theirs = await startReexecutingEngine('dots-tts-mf')
      await recordTheirs({ engineId: 'dots-tts-mf', ...theirs, launchedAt: new Date().toISOString() })
      const mine = await startReexecutingEngine('dots-tts-mf')
      await writeLocalRuntimeLaunchRecord({ engineId: 'dots-tts-mf', ...mine, launchedAt: new Date().toISOString() })
      const theirAside = `.batshit-local-runtime-launch.${theirs.pid}.json`
      const before = (await snapshot('dots-tts-mf'))[theirAside]

      const result = await stopDeletedEngineRuntimes('dots-tts-mf')

      expect(result).toEqual({ stopped: [mine.pid], keptForOtherEngines: [], notStopped: [], unreadable: [] })
      expect(isAlive(mine.pid)).toBe(false)
      expect(isAlive(theirs.pid)).toBe(true)
      expect((await snapshot('dots-tts-mf'))[theirAside]).toBe(before)
    })
  }

  for (const [owner, foreign] of [['another Batshit', { registry: 'redis-0000000000000000' }], ['an unknown owner (no registry)', {}]] as const) {
    it(`an attach to this Batshit's launch by ${owner} keeps it running, even when this one deletes that engine too (BL-1289)`, async () => {
      const mine = await startReexecutingEngine('dots-tts-mf')
      await writeLocalRuntimeLaunchRecord({ engineId: 'dots-tts-mf', ...mine, launchedAt: new Date().toISOString() })
      // The other Batshit's kokoro uses this runtime: its attach record names it.
      await mkdir(path.join(stateRoot, 'kokoro'), { recursive: true })
      await writeFile(
        path.join(stateRoot, 'kokoro', PRIMARY),
        JSON.stringify({ engineId: 'kokoro', ...mine, startedBy: 'dots-tts-mf', ...foreign, stopOnShutdown: false })
      )

      const result = await stopDeletedEngineRuntimes('dots-tts-mf', new Set(['dots-tts-mf', 'kokoro']))

      expect(result).toEqual({ stopped: [], keptForOtherEngines: [mine.pid], notStopped: [], unreadable: [] })
      expect(isAlive(mine.pid)).toBe(true)
    })
  }

  describe('the files, under the record lock (BL-1289)', () => {
    let installRoot: string
    beforeEach(async () => {
      installRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'batshit-delete-install-')), 'kokoro')
      await mkdir(path.join(installRoot, 'models'), { recursive: true })
      await mkdir(path.join(stateRoot, 'kokoro', 'logs'), { recursive: true })
      await writeFile(path.join(stateRoot, 'kokoro', 'logs', 'local-engine-runtime.log'), 'log')
    })
    afterEach(async () => {
      await rm(path.dirname(installRoot), { recursive: true, force: true })
    })

    async function deadPid() {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('exit', resolve))
      return child.pid as number
    }
    const exists = (target: string) => stat(target).then(() => true, () => false)

    it('with only its own records, removes the install folder and the state folder', async () => {
      await writeLocalRuntimeLaunchRecord({ engineId: 'kokoro', pid: await deadPid(), ...MLX })

      expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({ removed: true, installRootRemoved: true, stateRootRemoved: true })
      expect(await exists(installRoot)).toBe(false)
      expect(await exists(path.join(stateRoot, 'kokoro'))).toBe(false)
    })

    for (const [label, foreign] of [
      ["another Batshit's record", { registry: 'redis-0000000000000000' }],
      ['a record of unknown owner (no registry)', {}]
    ] as const) {
      it(`keeps the shared folders and ${label} byte-identical, and removes only its own finished records`, async () => {
        const live = await liveFake()
        try {
          const theirs = JSON.stringify({ engineId: 'kokoro', pid: live.pid, ...MLX, ...foreign, stopOnShutdown: false })
          await writeFile(path.join(stateRoot, 'kokoro', `.batshit-local-runtime-launch.${live.pid}.json`), theirs)
          // This Batshit's own record of a process that still runs stays too; its finished one goes.
          const mineLive = JSON.stringify({ engineId: 'kokoro', pid: process.pid, ...MLX, registry: await resolveVoiceRuntimeRegistryIdentity() })
          await writeFile(path.join(stateRoot, 'kokoro', `.batshit-local-runtime-launch.${process.pid}.json`), mineLive)
          await writeLocalRuntimeLaunchRecord({ engineId: 'kokoro', pid: await deadPid(), ...MLX })

          const outcome = await removeDeletedEngineFiles('kokoro', installRoot)

          expect(outcome).toEqual({
            removed: false,
            sharedRecordPaths: [path.join(stateRoot, 'kokoro', `.batshit-local-runtime-launch.${live.pid}.json`)],
            unreadable: []
          })
          expect(await snapshot('kokoro')).toEqual({
            [`.batshit-local-runtime-launch.${live.pid}.json`]: theirs,
            [`.batshit-local-runtime-launch.${process.pid}.json`]: mineLive,
            logs: 'folder'
          })
          expect(await exists(path.join(installRoot, 'models'))).toBe(true)
        } finally {
          live.stop()
        }
      })
    }

    it("keeps the files of a launch that still runs while another engine's record names it (an attach, of any Batshit)", async () => {
      const mine = JSON.stringify({ engineId: 'kokoro', pid: process.pid, ...MLX, registry: await resolveVoiceRuntimeRegistryIdentity() })
      await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), mine)
      await mkdir(path.join(stateRoot, 'whisper'), { recursive: true })
      const attach = JSON.stringify({ engineId: 'whisper', pid: process.pid, ...MLX, startedBy: 'kokoro', registry: 'redis-0000000000000000' })
      await writeFile(path.join(stateRoot, 'whisper', PRIMARY), attach)

      expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({
        removed: false,
        sharedRecordPaths: [path.join(stateRoot, 'whisper', PRIMARY)],
        unreadable: []
      })
      expect(await snapshot('kokoro')).toEqual({ [PRIMARY]: mine, logs: 'folder' })
      expect(await snapshot('whisper')).toEqual({ [PRIMARY]: attach })
      expect(await exists(path.join(installRoot, 'models'))).toBe(true)
    })

    it('still removes the files of an engine that only attached to another engine\'s runtime: that runtime runs from its own files', async () => {
      const registry = await resolveVoiceRuntimeRegistryIdentity()
      // This engine's attach to whisper's runtime, and whisper's own launch of it.
      await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), JSON.stringify({ engineId: 'kokoro', pid: process.pid, ...MLX, startedBy: 'whisper', registry }))
      await mkdir(path.join(stateRoot, 'whisper'), { recursive: true })
      const starter = JSON.stringify({ engineId: 'whisper', pid: process.pid, ...MLX, registry })
      await writeFile(path.join(stateRoot, 'whisper', PRIMARY), starter)

      expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({ removed: true, installRootRemoved: true, stateRootRemoved: true })
      expect(await exists(path.join(stateRoot, 'kokoro'))).toBe(false)
      expect(await snapshot('whisper')).toEqual({ [PRIMARY]: starter })
    })

    it("leaves the lock's own files, and then the folder they are in, to the lock", async () => {
      // A waiter's claim in progress and an earlier reap's tombstone.
      await writeFile(path.join(stateRoot, 'kokoro', '.batshit-local-runtime-launch.lock.candidate-1-aa'), 'v2:1')
      await writeFile(path.join(stateRoot, 'kokoro', '.batshit-local-runtime-launch.reaped-1'), 'v2:1')
      await writeLocalRuntimeLaunchRecord({ engineId: 'kokoro', pid: await deadPid(), ...MLX })

      expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({ removed: true, installRootRemoved: true, stateRootRemoved: false })
      expect(await snapshot('kokoro')).toEqual({
        '.batshit-local-runtime-launch.lock.candidate-1-aa': 'v2:1',
        '.batshit-local-runtime-launch.reaped-1': 'v2:1'
      })
      expect(await exists(installRoot)).toBe(false)
    })

    // ---- The Docker host operator's engines (BL-1292) ------------------------------------
    //
    // The operator keeps the records of what it started in its own folder. Batshit only reads
    // them: they can keep these files, and Batshit never writes, locks or removes one.

    async function operatorRecord(engineId: string, contents: string) {
      const dir = path.join(operatorRoot, engineId)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, PRIMARY), contents)
      return path.join(dir, PRIMARY)
    }
    const operatorFolder = async (engineId: string) => (await readdir(path.join(operatorRoot, engineId))).sort()

    it('keeps the files while the Docker host operator runs this engine, and never touches its record', async () => {
      const contents = JSON.stringify({ engineId: 'kokoro', pid: process.pid, command: '/opt/elsewhere/serve', launchedBy: 'batshit-docker' })
      const recordPath = await operatorRecord('kokoro', contents)

      expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({ removed: false, sharedRecordPaths: [recordPath], unreadable: [] })
      expect(await readFile(recordPath, 'utf8')).toBe(contents)
      expect(await operatorFolder('kokoro')).toEqual([PRIMARY])
      expect(await exists(path.join(installRoot, 'models'))).toBe(true)
    })

    // Each path field on its own, the folder itself and a path inside it, in either folder.
    for (const [field, value] of [
      ['command', () => ({ command: path.join(installRoot, 'serve') })],
      ['cwd (the install folder itself)', () => ({ command: '/opt/python', cwd: installRoot })],
      ['logPath (in the state folder)', () => ({ command: '/opt/python', logPath: path.join(stateRoot, 'kokoro', 'logs', 'local-engine-runtime.log') })],
      ['an argument', () => ({ command: '/opt/python', args: ['--model', path.join(installRoot, 'models')] })]
    ] as const) {
      it(`keeps the files while an operator engine of another id runs from them (its ${field})`, async () => {
        const contents = JSON.stringify({ engineId: 'kokoro-docker', pid: process.pid, ...value() })
        const recordPath = await operatorRecord('kokoro-docker', contents)

        expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({ removed: false, sharedRecordPaths: [recordPath], unreadable: [] })
        expect(await readFile(recordPath, 'utf8')).toBe(contents)
      })
    }

    it('an operator record whose process is gone does not keep them, and stays as it is', async () => {
      const contents = JSON.stringify({ engineId: 'kokoro', pid: await deadPid(), command: path.join(installRoot, 'serve'), cwd: installRoot })
      const recordPath = await operatorRecord('kokoro', contents)

      expect((await removeDeletedEngineFiles('kokoro', installRoot)).removed).toBe(true)
      expect(await readFile(recordPath, 'utf8')).toBe(contents)
    })

    it('an operator record, or its folder, that cannot be read keeps them', async () => {
      const recordPath = await operatorRecord('whisper', '{ "pid": 12')

      expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({
        removed: false,
        sharedRecordPaths: [],
        unreadable: [expect.stringMatching(/is not valid JSON/)]
      })
      expect(await readFile(recordPath, 'utf8')).toBe('{ "pid": 12')

      await rm(operatorRoot, { recursive: true, force: true })
      await writeFile(operatorRoot, '')
      expect(await removeDeletedEngineFiles('kokoro', installRoot)).toEqual({
        removed: false,
        sharedRecordPaths: [],
        unreadable: [expect.stringMatching(/the Docker host operator's voice records folder .* could not be read \(ENOTDIR\)/)]
      })
      expect(await exists(path.join(installRoot, 'models'))).toBe(true)
    })

    it('keeps everything while a record cannot be read', async () => {
      await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), '{ "pid": 12')

      const outcome = await removeDeletedEngineFiles('kokoro', installRoot)

      expect(outcome).toEqual({ removed: false, sharedRecordPaths: [], unreadable: [expect.stringMatching(/is not valid JSON/)] })
      expect(await snapshot('kokoro')).toEqual({ [PRIMARY]: '{ "pid": 12', logs: 'folder' })
      expect(await exists(path.join(installRoot, 'models'))).toBe(true)
    })

    it('decides on the records as they are once it holds the lock: a record a writer added meanwhile keeps the files', async () => {
      const theirs = JSON.stringify({ engineId: 'kokoro', pid: process.pid, ...MLX, registry: 'redis-0000000000000000' })
      let removal: ReturnType<typeof removeDeletedEngineFiles> | undefined
      await withLocalRuntimeRecordLock(path.join(stateRoot, 'kokoro'), async () => {
        removal = removeDeletedEngineFiles('kokoro', installRoot)
        await new Promise((resolve) => setTimeout(resolve, 150))
        // Another Batshit's launch, recorded while it held the lock.
        await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), theirs)
      })

      expect((await removal)?.removed).toBe(false)
      expect((await snapshot('kokoro'))[PRIMARY]).toBe(theirs)
      expect(await exists(path.join(installRoot, 'models'))).toBe(true)
    })
  })

  // ---- Recording a use of a process found already running (BL-1298) -----------------------

  describe('recordVerifiedRuntimeUse', () => {
    const ENDPOINT = 'http://127.0.0.1:7880'
    const SERVER = { command: '/Users/x/.batshit/installs/livekit-server/livekit-server', launchedAt: '2026-10-11T08:00:00.000Z' }

    async function foreignLaunch(pid: number, fields: Record<string, unknown> = { endpoint: ENDPOINT }, registry = 'redis-0000000000000000') {
      await mkdir(path.join(stateRoot, 'livekit-server'), { recursive: true })
      const contents = JSON.stringify({ engineId: 'livekit-server', pid, ...SERVER, ...fields, registry })
      await writeFile(path.join(stateRoot, 'livekit-server', PRIMARY), contents)
      return contents
    }
    const use = (listeners: number[], stopOnShutdown = false) =>
      recordVerifiedRuntimeUse({ engineId: 'livekit-server', endpoint: 'ws://localhost:7880', stopOnShutdown, listeners })

    it('a listener no Batshit record names is external: nothing is recorded or owned', async () => {
      const p = await liveFake()
      try {
        expect(await use([p.pid])).toEqual({ outcome: 'external' })
        expect(await readdir(stateRoot)).toEqual([])
      } finally {
        p.stop()
      }
    })

    it("this Batshit's own launch is \"own\" and writes nothing", async () => {
      const p = await liveFake()
      try {
        await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: p.pid, ...SERVER, endpoint: ENDPOINT })
        const before = await snapshot('livekit-server')
        expect(await use([p.pid])).toEqual({ outcome: 'own' })
        expect(await snapshot('livekit-server')).toEqual(before)
      } finally {
        p.stop()
      }
    })

    it("another Batshit's launch gets this Batshit's attach with its choice, beside it intact; again is \"own\"", async () => {
      const p = await liveFake()
      try {
        const theirs = await foreignLaunch(p.pid)
        expect(await use([p.pid], false)).toEqual({ outcome: 'recorded' })
        expect(await readFile(path.join(stateRoot, 'livekit-server', `.batshit-local-runtime-launch.${p.pid}.json`), 'utf8')).toBe(theirs)
        expect(await read('livekit-server')).toMatchObject({
          pid: p.pid,
          startedBy: 'livekit-server',
          stopOnShutdown: false,
          registry: await resolveVoiceRuntimeRegistryIdentity()
        })
        const after = await snapshot('livekit-server')
        expect(await use([p.pid], false)).toEqual({ outcome: 'own' })
        expect(await snapshot('livekit-server')).toEqual(after)
      } finally {
        p.stop()
      }
    })

    it('a launch whose record carries no address (from before this change) is unrecordable, and nothing is written', async () => {
      const p = await liveFake()
      try {
        const theirs = await foreignLaunch(p.pid, {})
        expect(await use([p.pid])).toEqual({ outcome: 'unrecordable', reason: expect.stringMatching(/carries no address for http:\/\/127\.0\.0\.1:7880/) })
        expect(await snapshot('livekit-server')).toEqual({ [PRIMARY]: theirs })
      } finally {
        p.stop()
      }
    })

    it('a record whose pid does not listen is never adopted: the listener is external', async () => {
      const p = await liveFake()
      const q = await liveFake()
      try {
        const theirs = await foreignLaunch(p.pid)
        expect(await use([q.pid])).toEqual({ outcome: 'external' })
        expect(await snapshot('livekit-server')).toEqual({ [PRIMARY]: theirs })
        // The attach itself, told who listens, refuses that starter too.
        expect(await attachLocalRuntimeLaunchRecord({ engineId: 'livekit-server', endpoint: ENDPOINT, stopOnShutdown: false, listeners: [q.pid] })).toBe(false)
      } finally {
        p.stop()
        q.stop()
      }
    })

    it('a records folder that cannot be read at all is unrecordable, and readRuntimeUseState says so', async () => {
      const p = await liveFake()
      try {
        await writeFile(path.join(stateRoot, 'not-a-folder'), '')
        process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = path.join(stateRoot, 'not-a-folder')
        expect(await use([p.pid])).toEqual({ outcome: 'unrecordable', reason: expect.stringMatching(/records folder .* could not be read/) })
        expect(await readRuntimeUseState('livekit-server', [p.pid])).toBe('unreadable')
      } finally {
        process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
        p.stop()
      }
    })

    it('readRuntimeUseState tells a recorded use from an unrecorded one', async () => {
      const p = await liveFake()
      try {
        expect(await readRuntimeUseState('livekit-server', [p.pid])).toBe('external')
        await foreignLaunch(p.pid)
        expect(await readRuntimeUseState('livekit-server', [p.pid])).toBe('unrecorded')
        await use([p.pid])
        expect(await readRuntimeUseState('livekit-server', [p.pid])).toBe('recorded')
      } finally {
        p.stop()
      }
    })

    it('a record in its folder that cannot be read, or a taken moved-aside name, is unrecordable', async () => {
      const p = await liveFake()
      try {
        await foreignLaunch(p.pid)
        await writeFile(path.join(stateRoot, 'livekit-server', '.batshit-local-runtime-launch.4242.json'), '{ "pid"')
        expect(await use([p.pid])).toEqual({ outcome: 'unrecordable', reason: expect.stringMatching(/is not valid JSON/) })
        await rm(path.join(stateRoot, 'livekit-server', '.batshit-local-runtime-launch.4242.json'))

        // A third Batshit already holds the moved-aside name: the attach is refused (BL-1275).
        await writeFile(
          path.join(stateRoot, 'livekit-server', `.batshit-local-runtime-launch.${p.pid}.json`),
          JSON.stringify({ engineId: 'livekit-server', pid: p.pid, ...SERVER, startedBy: 'livekit-server', registry: 'redis-1111111111111111' })
        )
        const before = await snapshot('livekit-server')
        expect(await use([p.pid])).toEqual({ outcome: 'unrecordable', reason: expect.stringMatching(COLLISION) })
        expect(await snapshot('livekit-server')).toEqual(before)
      } finally {
        p.stop()
      }
    })
  })

  // ---- What serves only its own Batshit: verify its own current launch (BL-1311) -----------

  describe('verifyOwnLaunchServes', () => {
    const ENDPOINT = 'http://127.0.0.1:7899'
    const verify = (listeners: number[]) => verifyOwnLaunchServes({ engineId: 'livekit-sidecar', endpoint: ENDPOINT, listeners })

    it('verifies its own current launch that records this address', async () => {
      const engine = await startReexecutingEngine('livekit-sidecar')
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-sidecar', ...engine, endpoint: ENDPOINT, launchedAt: new Date().toISOString() })
      expect(await verify([engine.pid])).toMatchObject({ verified: true, record: { pid: engine.pid } })
    })

    it('refuses a process no record names (unknown), and one only another Batshit, or only an attach, names (foreign)', async () => {
      const engine = await startReexecutingEngine('livekit-sidecar')
      expect(await verify([engine.pid])).toMatchObject({ verified: false, refusal: 'unknown' })

      await asRegistry(2, () =>
        writeLocalRuntimeLaunchRecord({ engineId: 'livekit-sidecar', ...engine, endpoint: ENDPOINT, launchedAt: new Date().toISOString() })
      )
      expect(await verify([engine.pid])).toMatchObject({ verified: false, refusal: 'foreign' })

      // This Batshit's own historical attachment is not its launch either.
      await writeFile(
        path.join(stateRoot, 'livekit-sidecar', `.batshit-local-runtime-launch.${engine.pid}.json`),
        JSON.stringify({ engineId: 'livekit-sidecar', ...engine, endpoint: ENDPOINT, startedBy: 'livekit-sidecar', registry: await resolveVoiceRuntimeRegistryIdentity() })
      )
      expect(await verify([engine.pid])).toMatchObject({ verified: false, refusal: 'foreign' })
    })

    it('refuses its own launch that records no address, or whose process is no longer that launch', async () => {
      const engine = await startReexecutingEngine('livekit-sidecar')
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-sidecar', ...engine, launchedAt: new Date().toISOString() })
      expect(await verify([engine.pid])).toMatchObject({ verified: false, refusal: 'unaddressed', reason: expect.stringMatching(/records no address/) })

      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-sidecar', ...engine, endpoint: ENDPOINT, launchedAt: new Date(Date.now() - 30_000).toISOString() })
      expect(await verify([engine.pid])).toMatchObject({ verified: false, refusal: 'unverified', reason: expect.stringMatching(/process id was reused/) })
    })

    it('refuses while a record in its folder cannot be read', async () => {
      const engine = await startReexecutingEngine('livekit-sidecar')
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-sidecar', ...engine, endpoint: ENDPOINT, launchedAt: new Date().toISOString() })
      await writeFile(path.join(stateRoot, 'livekit-sidecar', '.batshit-local-runtime-launch.4242.json'), '{ "pid"')
      expect(await verify([engine.pid])).toMatchObject({ verified: false, refusal: 'unreadable' })
    })
  })

  // ---- A restart stops only what this Batshit alone started (BL-1296) -------------------------

  describe('stopSolelyOwnedLaunchForRestart', () => {
    const LAUNCH = { command: '/Users/x/.batshit/installs/livekit-server/livekit-server', launchedAt: '2026-10-11T08:00:00.000Z' }
    const stops: number[] = []
    const stop = async (record: { pid?: number }) => {
      stops.push(record.pid as number)
    }
    afterEach(() => {
      stops.splice(0)
    })

    // This Batshit's launch: a real detached process that leads its own group, recorded after it
    // started, as a launch is.
    async function ownLaunch(launchedAt = new Date().toISOString()) {
      const engine = await startReexecutingEngine('livekit-server')
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', ...engine, launchedAt })
      return engine.pid
    }

    it('stops its own launch when no other record names that process', async () => {
      const pid = await ownLaunch()
      // Records of other processes, of this Batshit and another, have no say.
      await writeLocalRuntimeLaunchRecord({ engineId: 'kokoro', pid: 4242, ...MLX })
      await asRegistry(2, () => writeLocalRuntimeLaunchRecord({ engineId: 'whisper', pid: 4343, ...MLX }))

      expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [pid], stop)).toMatchObject({
        stopped: true,
        record: { engineId: 'livekit-server', pid }
      })
      expect(stops).toEqual([pid])
    })

    it('a listener that is a child of its own launch counts through its process group (BL-1297)', async () => {
      // A detached launch that leads its group and runs the listener as its child, as the LiveKit
      // sidecar's tsx launcher does.
      const parent = spawn(
        process.execPath,
        ['-e', `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); setInterval(() => {}, 1000)`],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      running.push(parent)
      const childPid = Number(await new Promise((resolve) => parent.stdout?.once('data', (chunk) => resolve(String(chunk)))))
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-sidecar', pid: parent.pid as number, command: process.execPath, launchedAt: new Date().toISOString() })

      expect(childPid).not.toBe(parent.pid)
      expect(await stopSolelyOwnedLaunchForRestart('livekit-sidecar', [childPid], stop)).toMatchObject({
        stopped: true,
        record: { pid: parent.pid }
      })
      expect(stops).toEqual([parent.pid])
    })

    it('refuses when its own record names a pid a later process took (a reused pid)', async () => {
      // Recorded as launched before the live process started: that process is not this launch.
      const pid = await ownLaunch(new Date(Date.now() - 30_000).toISOString())

      expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [pid], stop)).toEqual({
        stopped: false,
        refusal: 'unverified',
        pid,
        reason: expect.stringMatching(/its process id was reused/)
      })
      expect(stops).toEqual([])
    })

    it('its own launch of a process that does not listen is not the listener: "not-started"', async () => {
      await ownLaunch()

      expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [999_999], stop)).toEqual({
        stopped: false,
        refusal: 'not-started',
        pids: [999_999]
      })
      expect(stops).toEqual([])
    })

    for (const [label, other] of [
      ["another Batshit's record of it beside", { engineId: 'livekit-server', registry: 'redis-0000000000000000' }],
      ['a record of it with no registry', { engineId: 'livekit-server' }],
      ["an attach to it (this Batshit's own engine)", { engineId: 'kokoro', startedBy: 'livekit-server', own: true }]
    ] as const) {
      it(`refuses, signals nothing and changes no record with ${label}`, async () => {
        await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: process.pid, ...LAUNCH })
        const { own, ...fields } = other as typeof other & { own?: boolean }
        const otherPath = path.join(stateRoot, fields.engineId, `.batshit-local-runtime-launch.${process.pid}.json`)
        await mkdir(path.dirname(otherPath), { recursive: true })
        await writeFile(
          otherPath,
          JSON.stringify({ ...fields, pid: process.pid, ...LAUNCH, ...(own ? { registry: await resolveVoiceRuntimeRegistryIdentity() } : {}) })
        )
        const before = { livekit: await snapshot('livekit-server'), other: await snapshot(fields.engineId) }

        expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [process.pid], stop)).toEqual({
          stopped: false,
          refusal: 'shared',
          pid: process.pid,
          recordPaths: [otherPath]
        })
        expect(stops).toEqual([])
        expect({ livekit: await snapshot('livekit-server'), other: await snapshot(fields.engineId) }).toEqual(before)
      })
    }

    it("refuses a process only another Batshit recorded as \"shared\", and one nobody recorded as \"not-started\"", async () => {
      await asRegistry(2, () => writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: process.pid, ...LAUNCH }))
      expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [process.pid], stop)).toEqual({
        stopped: false,
        refusal: 'shared',
        pid: process.pid,
        recordPaths: [path.join(stateRoot, 'livekit-server', PRIMARY)]
      })
      expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [999_999], stop)).toEqual({
        stopped: false,
        refusal: 'not-started',
        pids: [999_999]
      })
      expect(stops).toEqual([])
    })

    it("an attach record in the engine's own folder is not its launch, even this Batshit's", async () => {
      const attach = path.join(stateRoot, 'livekit-server', PRIMARY)
      await mkdir(path.dirname(attach), { recursive: true })
      await writeFile(attach, JSON.stringify({ engineId: 'livekit-server', pid: process.pid, ...LAUNCH, startedBy: 'kokoro', registry: await resolveVoiceRuntimeRegistryIdentity() }))

      expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [process.pid], stop)).toEqual({
        stopped: false,
        refusal: 'shared',
        pid: process.pid,
        recordPaths: [attach]
      })
      expect(stops).toEqual([])
    })

    it('refuses while any record cannot be read, since it could name that process', async () => {
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: process.pid, ...LAUNCH })
      await mkdir(path.join(stateRoot, 'kokoro'), { recursive: true })
      await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), '{ "pid": 12')

      expect(await stopSolelyOwnedLaunchForRestart('livekit-server', [process.pid], stop)).toEqual({
        stopped: false,
        refusal: 'unreadable',
        reasons: [expect.stringMatching(/is not valid JSON/)]
      })
      expect(stops).toEqual([])
    })

    it('decides under the folder lock: a record another Batshit wrote while holding it refuses the stop', async () => {
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: process.pid, ...LAUNCH })
      let decision: ReturnType<typeof stopSolelyOwnedLaunchForRestart> | undefined
      await withLocalRuntimeRecordLock(path.join(stateRoot, 'livekit-server'), async () => {
        decision = stopSolelyOwnedLaunchForRestart('livekit-server', [process.pid], stop)
        await new Promise((resolve) => setTimeout(resolve, 150))
        await writeFile(
          path.join(stateRoot, 'livekit-server', `.batshit-local-runtime-launch.${process.pid}.json`),
          JSON.stringify({ engineId: 'livekit-server', pid: process.pid, ...LAUNCH, registry: 'redis-0000000000000000' })
        )
      })

      expect(await decision).toMatchObject({ stopped: false, refusal: 'shared' })
      expect(stops).toEqual([])
    })

    it('a stop that throws releases the lock', async () => {
      const pid = await ownLaunch()
      await expect(
        stopSolelyOwnedLaunchForRestart('livekit-server', [pid], async () => {
          throw new Error('not managed')
        })
      ).rejects.toThrow('not managed')
      expect(await files('livekit-server')).toEqual([PRIMARY])
      expect((await stopSolelyOwnedLaunchForRestart('livekit-server', [pid], stop)).stopped).toBe(true)
    })
  })

  it('only the reader decides what could not be read: a record\'s own unreadable or invalid field is not a verdict', async () => {
    await mkdir(path.join(stateRoot, 'kokoro'), { recursive: true })
    await writeFile(path.join(stateRoot, 'kokoro', PRIMARY), JSON.stringify({ pid: 10778, ...MLX, unreadable: true, invalid: true }))
    const [entry] = await listLocalRuntimeLaunchRecords()
    expect(entry).toMatchObject({ engineId: 'kokoro', pid: 10778 })
    expect(entry.unreadable).toBeUndefined()
    expect('invalid' in entry).toBe(false)
  })
})

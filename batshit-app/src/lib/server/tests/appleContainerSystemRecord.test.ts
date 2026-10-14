import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  APPLE_CONTAINER_SYSTEM_RECORD_NAME,
  recordAppleContainerSystemStart,
  resolveAppleContainerStateDir
} from '../services/appleContainerSystemRecord'

// BL-62 part 2 (2026-09-22): the record that lets quitting stop Apple's container system when
// Batshit's own `system start` started it. Twin of the writer in
// `batshit-mac/scripts/apple-container-system-stop.mjs`, whose tests stop a system from it.
describe('the Apple Container system record', () => {
  let root = ''
  const saved: Record<string, string | undefined> = {}
  const keys = ['BATSHIT_APPLE_CONTAINER_STATE_DIR', 'BATSHIT_VOICE_RUNTIME_OWNER', 'PATH']

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-container-record-'))
    for (const key of keys) saved[key] = process.env[key]
  })

  afterEach(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await rm(root, { recursive: true, force: true })
  })

  it('lives in the folder the Mac supervisor and the native launcher read', () => {
    process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = path.join(root, 'state')
    expect(resolveAppleContainerStateDir()).toBe(path.join(root, 'state'))
    delete process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR
    expect(resolveAppleContainerStateDir()).toBe(path.join(os.homedir(), '.batshit', 'runtime', 'apple-container'))
  })

  it('records which Batshit started it and when that call ran, in the shape the stop reads', async () => {
    process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = path.join(root, 'state')
    process.env.BATSHIT_VOICE_RUNTIME_OWNER = 'native:4242:1758459739000'
    process.env.PATH = path.join(root, 'nothing-here')

    await recordAppleContainerSystemStart(Date.parse('2026-09-22T13:02:19.600Z'), Date.parse('2026-09-22T13:02:21.950Z'))

    const written = JSON.parse(await readFile(path.join(root, 'state', APPLE_CONTAINER_SYSTEM_RECORD_NAME), 'utf8'))
    expect(written).toEqual({
      launchedBy: 'native:4242:1758459739000',
      callStartedAt: '2026-09-22T13:02:19.600Z',
      callEndedAt: '2026-09-22T13:02:21.950Z'
    })

    // The shutdown side reads it the same way (plain JavaScript beside the app, loaded by Node).
    const twin = createRequire(import.meta.url)(
      path.resolve(process.cwd(), '../batshit-mac/scripts/apple-container-system-stop.mjs')
    ) as {
      APPLE_CONTAINER_SYSTEM_RECORD_NAME: string
      readAppleContainerSystemRecord: (dir: string) => Promise<unknown>
      registeredByRecordedCall: (record: unknown, registeredAtMs: number) => boolean
    }
    expect(twin.APPLE_CONTAINER_SYSTEM_RECORD_NAME).toBe(APPLE_CONTAINER_SYSTEM_RECORD_NAME)
    const read = await twin.readAppleContainerSystemRecord(path.join(root, 'state'))
    expect(read).toEqual(written)
    expect(twin.registeredByRecordedCall(read, Date.parse('2026-09-22T13:02:20.000Z'))).toBe(true)
  })

  it('replaces the record whole: a new file renamed over the old, never rewritten in place', async () => {
    const stateDir = path.join(root, 'state')
    process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = stateDir
    const recordPath = path.join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME)
    await recordAppleContainerSystemStart(Date.parse('2026-09-22T13:02:19.600Z'), Date.parse('2026-09-22T13:02:21.950Z'))
    const first = await stat(recordPath)
    await recordAppleContainerSystemStart(Date.parse('2026-09-22T14:00:00.000Z'), Date.parse('2026-09-22T14:00:02.350Z'))
    const second = await stat(recordPath)

    expect(second.ino).not.toBe(first.ino)
    expect(await readdir(stateDir)).toEqual([APPLE_CONTAINER_SYSTEM_RECORD_NAME])

    const before = await readFile(recordPath, 'utf8')
    await chmod(stateDir, 0o555)
    try {
      await expect(recordAppleContainerSystemStart(Date.now(), Date.now())).rejects.toThrow()
    } finally {
      await chmod(stateDir, 0o755)
    }
    expect(await readFile(recordPath, 'utf8')).toBe(before)
    expect(await readdir(stateDir)).toEqual([APPLE_CONTAINER_SYSTEM_RECORD_NAME])
  })
  it('writes under the record folder\'s lock, the same lock the shutdown side takes (BL-1257)', async () => {
    const stateDir = path.join(root, 'state')
    process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = stateDir
    process.env.BATSHIT_VOICE_RUNTIME_OWNER = 'native:4242:1758459739000'
    process.env.PATH = path.join(root, 'nothing-here')
    // The shutdown side's lock (plain JavaScript beside the app, loaded by Node), held while the app writes.
    const twin = createRequire(import.meta.url)(
      path.resolve(process.cwd(), '../batshit-mac/scripts/local-voice-runtime-stop.mjs')
    ) as { withLocalRuntimeRecordLock: (dir: string, work: () => Promise<void>) => Promise<void> }
    let held!: () => void
    const acquired = new Promise<void>((done) => (held = done))
    const released = twin.withLocalRuntimeRecordLock(stateDir, async () => {
      held()
      await new Promise((done) => setTimeout(done, 400))
    })
    await acquired
    const startedAt = Date.now()
    await recordAppleContainerSystemStart(Date.now(), Date.now())
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300)
    await released
    expect(await readdir(stateDir)).toEqual(['.batshit-apple-container-system.json'])
  })
})

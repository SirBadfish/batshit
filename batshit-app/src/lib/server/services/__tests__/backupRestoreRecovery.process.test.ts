import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ensureBackupRestoreRecovery } from '../backupRestoreService'

// The ordinary test launches two fresh Vitest processes so the second recovery
// has no module state from the first. The child phases are never the only proof:
// the ordinary parent test must observe SIGKILL and verify the shared files.
const phase = process.env.BL260_PROCESS_PHASE
const sharedRoot = process.env.BL260_PROCESS_ROOT
const stageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const storageKey = createHash('sha256').update(stageId).digest('hex')
const originalNames = ['a.txt', 'b.txt', 'folder'] as const

useRedisTestServer()

function paths(root: string) {
  const uploads = path.join(root, 'uploads')
  const staging = path.join(root, 'staging')
  return {
    uploads,
    staging,
    oldRoot: path.join(uploads, `.restore-old-${storageKey}`),
    newRoot: path.join(uploads, `.restore-new-${storageKey}`),
    journal: path.join(staging, `${storageKey}.restore-journal.json`),
    marker: path.join(staging, 'goon-asset-restore.json'),
    plan: path.join(staging, `${storageKey}.plan.ndjson`),
    rollback: path.join(staging, `${storageKey}.rollback.ndjson`),
    lock: path.join(staging, 'active-restore.lock')
  }
}

async function identity(target: string) {
  const stat = await fs.lstat(target, { bigint: true })
  return { device: String(stat.dev), inode: String(stat.ino) }
}

async function missing(target: string) {
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
}

function stubFileService(root: string) {
  const { marker } = paths(root)
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const action = url.split('/').at(-1)
    expect(['begin', 'end']).toContain(action)
    const persisted = JSON.parse(await fs.readFile(marker, 'utf8'))
    const { token } = JSON.parse(String(init.body))
    expect(token).toBe(persisted.token)
    calls.push(action!)
    return Response.json({ success: true, token, activeOperations: 0,
      state: action === 'begin' ? 'existing' : 'released' })
  }))
  return calls
}

describe('BL-260 process crash during upload-tree rollback', () => {
  it.runIf(!phase)('recovers originals after an actual process death between per-entry moves', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bl260-restart-'))
    const p = paths(root)
    let childTerminationVerified = true
    try {
      await fs.mkdir(p.oldRoot, { recursive: true })
      await fs.mkdir(p.staging)
      await fs.mkdir(p.newRoot)
      await fs.writeFile(path.join(p.oldRoot, 'a.txt'), 'original a')
      await fs.writeFile(path.join(p.oldRoot, 'b.txt'), 'original b')
      await fs.mkdir(path.join(p.oldRoot, 'folder'))
      await fs.writeFile(path.join(p.oldRoot, 'folder', 'keep.bin'), 'original nested')
      await fs.writeFile(path.join(p.uploads, 'a.txt'), 'replacement a')
      await fs.writeFile(path.join(p.uploads, 'b.txt'), 'replacement b')
      await fs.mkdir(path.join(p.uploads, 'folder'))
      await fs.writeFile(path.join(p.uploads, 'folder', 'keep.bin'), 'replacement nested')
      await fs.writeFile(path.join(p.uploads, 'new-only.txt'), 'new-only')
      await fs.writeFile(path.join(p.newRoot, 'staged-only.txt'), 'staged')
      await fs.writeFile(p.plan, 'disposable plan\n')
      await fs.writeFile(p.rollback, 'disposable rollback\n')
      await fs.writeFile(p.lock, 'disposable lock')
      const originalUploadEntries = await Promise.all(originalNames.map(async (name) => ({
        name, ...await identity(path.join(p.oldRoot, name))
      })))
      const restoreToken = randomUUID()
      await fs.writeFile(p.marker, JSON.stringify({ contract: 'goon-asset-restore/v1', token: restoreToken }))
      await fs.writeFile(p.journal, JSON.stringify({
        contract: 'batshit-backup-restore-journal/v2', stageId, userId: 'target',
        phase: 'files-swapped', hadOriginalUploads: true, originalUploadEntries,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }))

      const vitestCli = path.resolve(process.cwd(), 'node_modules/vitest/vitest.mjs')
      const testFile = fileURLToPath(import.meta.url)
      // BL-1078: SIGKILL prevents the crash child's global-setup teardown. Keep
      // those roots inside this parent's fixture, including on the recovery run.
      const childTemp = path.join(root, 'child-temporary')
      await fs.mkdir(childTemp)
      const childEnv = { ...process.env, VITEST_USE_REAL_REDIS: 'false',
        TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp,
        BL260_PROCESS_ROOT: root, UPLOADS_DIR: p.uploads,
        BATSHIT_BACKUP_STAGING_DIR: p.staging,
        BATSHIT_TOKEN: 'disposable-bl260-test-token' }
      const runChild = (childPhase: 'crash' | 'recover') => {
        childTerminationVerified = false
        const child = spawnSync(process.execPath, [
          vitestCli, 'run', '--pool=threads', '--maxWorkers=1', testFile
        ], { cwd: process.cwd(), env: { ...childEnv, BL260_PROCESS_PHASE: childPhase },
          encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })
        childTerminationVerified = !child.error && (child.status !== null || child.signal !== null)
        return child
      }

      const crashed = runChild('crash')
      expect(crashed.error, crashed.stderr).toBeUndefined()
      expect(crashed.signal, crashed.stderr).toBe('SIGKILL')
      // The kill happened after the production rename, with no finally path.
      expect(await identity(path.join(p.uploads, 'a.txt'))).toEqual({
        device: originalUploadEntries[0].device, inode: originalUploadEntries[0].inode
      })
      await missing(path.join(p.oldRoot, 'a.txt'))
      expect(await fs.readFile(path.join(p.oldRoot, 'b.txt'), 'utf8')).toBe('original b')
      expect(await fs.readFile(p.journal, 'utf8')).toContain('files-swapped')
      expect(JSON.parse(await fs.readFile(p.marker, 'utf8')).token).toBe(restoreToken)

      const recovered = runChild('recover')
      expect(recovered.error, recovered.stderr).toBeUndefined()
      expect(recovered.status, recovered.stderr).toBe(0)
      for (const entry of originalUploadEntries) {
        expect(await identity(path.join(p.uploads, entry.name))).toEqual({
          device: entry.device, inode: entry.inode
        })
      }
      expect(await fs.readFile(path.join(p.uploads, 'a.txt'), 'utf8')).toBe('original a')
      expect(await fs.readFile(path.join(p.uploads, 'b.txt'), 'utf8')).toBe('original b')
      expect(await fs.readFile(path.join(p.uploads, 'folder', 'keep.bin'), 'utf8')).toBe('original nested')
      for (const removed of [p.journal, p.marker, p.plan, p.rollback, p.lock, p.oldRoot, p.newRoot,
        path.join(p.uploads, 'new-only.txt'), path.join(p.uploads, 'staged-only.txt')]) {
        await missing(removed)
      }
    } finally {
      if (childTerminationVerified) {
        await fs.rm(root, { recursive: true, force: true })
      } else {
        console.error(`Crash fixture retained because child termination was not verified: ${root}`)
      }
    }
    await missing(root)
  }, 50_000)

  it.runIf(phase === 'crash')('child crashes immediately after returning one original', async () => {
    if (!sharedRoot) throw new Error('Missing disposable crash fixture root.')
    const p = paths(sharedRoot)
    stubFileService(sharedRoot)
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target)
      if (source === path.join(p.oldRoot, 'a.txt') && target === path.join(p.uploads, 'a.txt')) {
        process.kill(process.pid, 'SIGKILL')
        throw new Error('SIGKILL did not terminate the crash child.')
      }
    })
    await ensureBackupRestoreRecovery()
    throw new Error('Recovery unexpectedly completed before the crash point.')
  })

  it.runIf(phase === 'recover')('fresh child completes production recovery', async () => {
    if (!sharedRoot) throw new Error('Missing disposable recovery fixture root.')
    const calls = stubFileService(sharedRoot)
    await ensureBackupRestoreRecovery()
    expect(calls).toEqual(['begin', 'end'])
  })
})

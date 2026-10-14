import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createBackupBundle, ensureBackupRestoreRecovery, restoreBackupBundle } from '../backupRestoreService'

useRedisTestServer()
let root: string
let uploads: string
let staging: string
const stageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const storageKey = createHash('sha256').update(stageId).digest('hex')
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-recovery-fault-'))
  uploads = path.join(root, 'uploads')
  staging = path.join(root, 'staging')
  await fs.mkdir(uploads)
  await fs.mkdir(staging)
  vi.stubEnv('UPLOADS_DIR', uploads)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', staging)
  vi.stubEnv('BATSHIT_TOKEN', 'disposable-restore-recovery-test-token')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/\/asset-maintenance\/(begin|end)$/)
    const { token } = JSON.parse(String(init.body))
    return Response.json({ success: true, token, activeOperations: 0, state: url.endsWith('/begin') ? 'created' : 'released' })
  }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

async function interruptedSwap() {
  const oldRoot = path.join(uploads, `.restore-old-${storageKey}`)
  await fs.mkdir(oldRoot)
  const originalUploadEntries = []
  for (const name of ['a.txt', 'b.txt']) {
    await fs.writeFile(path.join(oldRoot, name), `original ${name}`)
    await fs.writeFile(path.join(uploads, name), `replacement ${name}`)
    const stat = await fs.lstat(path.join(oldRoot, name), { bigint: true })
    originalUploadEntries.push({ name, device: String(stat.dev), inode: String(stat.ino) })
  }
  await fs.writeFile(path.join(uploads, 'new-only.txt'), 'new-only')
  const journalPath = path.join(staging, `${storageKey}.restore-journal.json`)
  await fs.writeFile(journalPath, JSON.stringify({
    contract: 'batshit-backup-restore-journal/v2', stageId, userId: 'target',
    phase: 'files-swapped', hadOriginalUploads: true, originalUploadEntries,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }))
  return { oldRoot, journalPath }
}

describe('backup upload-tree crash recovery', () => {
  it.each(['before', 'after'])('leaves final commit-journal failure %s rename to disk-authoritative recovery', async (timing) => {
    await redis.json.set('user:target:settings', '$', { marker: 'backup' })
    const bundle = await createBackupBundle('target')
    await redis.json.set('user:target:settings', '$', { marker: 'original' })
    await fs.writeFile(path.join(uploads, 'original.txt'), 'original bytes')
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      const finalJournal = String(target).endsWith('.restore-journal.json') &&
        JSON.parse(await fs.readFile(source, 'utf8')).phase === 'redis-complete'
      if (finalJournal && timing === 'before') throw new Error('injected commit-journal failure')
      await rename(source, target)
      if (finalJournal && timing === 'after') throw new Error('injected commit-journal failure')
    })
    await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true }))
      .rejects.toThrow('injected commit-journal failure')
    spy.mockRestore()
    const journals = (await fs.readdir(staging)).filter((name) => name.endsWith('.restore-journal.json'))
    expect(journals).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path.join(staging, journals[0]), 'utf8')).phase)
      .toBe(timing === 'before' ? 'redis-replacing' : 'redis-complete')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'backup' })
    expect(await fs.readFile(path.join(staging, 'goon-asset-restore.json'), 'utf8')).toContain('goon-asset-restore/v1')
    await ensureBackupRestoreRecovery()
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: timing === 'before' ? 'original' : 'backup' })
    if (timing === 'before') expect(await fs.readFile(path.join(uploads, 'original.txt'), 'utf8')).toBe('original bytes')
    else await expect(fs.stat(path.join(uploads, 'original.txt'))).rejects.toThrow()
    expect((await fs.readdir(staging)).filter((name) => name.endsWith('.restore-journal.json'))).toEqual([])
    await expect(fs.stat(path.join(staging, 'goon-asset-restore.json'))).rejects.toThrow()
  })

  it('preserves an original already returned before an interrupted rollback retries', async () => {
    const { oldRoot, journalPath } = await interruptedSwap()
    const rename = fs.rename.bind(fs)
    let interrupted = false
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target)
      if (!interrupted && source === path.join(oldRoot, 'a.txt')) {
        interrupted = true
        throw new Error('simulated process exit after original rename')
      }
    })
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('simulated process exit')
    spy.mockRestore()
    expect(await fs.readFile(path.join(uploads, 'a.txt'), 'utf8')).toBe('original a.txt')
    await ensureBackupRestoreRecovery()
    for (const name of ['a.txt', 'b.txt']) {
      expect(await fs.readFile(path.join(uploads, name), 'utf8')).toBe(`original ${name}`)
    }
    await expect(fs.stat(path.join(uploads, 'new-only.txt'))).rejects.toThrow()
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  it.each(['remove-extra', 'remove-replacement', 'return-first', 'return-last'].flatMap((step) =>
    ['before', 'after'].map((timing) => ({ step, timing }))))('retries $timing $step without losing originals', async ({ step, timing }) => {
    const { oldRoot } = await interruptedSwap()
    let failed = false
    const rm = fs.rm.bind(fs)
    const rename = fs.rename.bind(fs)
    const inject = async (matches: boolean, operation: () => Promise<void>) => {
      if (matches && !failed && timing === 'before') { failed = true; throw new Error('injected operation interruption') }
      await operation()
      if (matches && !failed && timing === 'after') { failed = true; throw new Error('injected operation interruption') }
    }
    const removeSpy = vi.spyOn(fs, 'rm').mockImplementation((target, options) => inject(
      (step === 'remove-extra' && target === path.join(uploads, 'new-only.txt')) ||
      (step === 'remove-replacement' && target === path.join(uploads, 'a.txt')),
      () => rm(target, options)))
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((source, target) => inject(
      (step === 'return-first' && source === path.join(oldRoot, 'a.txt')) ||
      (step === 'return-last' && source === path.join(oldRoot, 'b.txt')),
      () => rename(source, target)))
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('injected operation interruption')
    removeSpy.mockRestore()
    renameSpy.mockRestore()
    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(uploads, 'a.txt'), 'utf8')).toBe('original a.txt')
    expect(await fs.readFile(path.join(uploads, 'b.txt'), 'utf8')).toBe('original b.txt')
  })

  it('keeps originals that never left the live tree during a partially started swap', async () => {
    const { oldRoot, journalPath } = await interruptedSwap()
    await fs.rm(path.join(uploads, 'a.txt'))
    await fs.rename(path.join(oldRoot, 'a.txt'), path.join(uploads, 'a.txt'))
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.phase = 'prepared'
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(uploads, 'a.txt'), 'utf8')).toBe('original a.txt')
    expect(await fs.readFile(path.join(uploads, 'b.txt'), 'utf8')).toBe('original b.txt')
  })

  it('does not treat unreadable directories as empty or delete recovery authority', async () => {
    const { oldRoot, journalPath } = await interruptedSwap()
    const readdir = fs.readdir.bind(fs)
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((directory: string, options?: any) => {
      if (directory === oldRoot) return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      return readdir(directory, options)
    }) as typeof fs.readdir)
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('permission denied')
    spy.mockRestore()
    expect(await fs.readFile(path.join(uploads, 'new-only.txt'), 'utf8')).toBe('new-only')
    expect(await fs.readFile(path.join(oldRoot, 'a.txt'), 'utf8')).toBe('original a.txt')
    expect(await fs.readFile(journalPath, 'utf8')).toContain('files-swapped')
    await ensureBackupRestoreRecovery()
  })

  it('refuses a missing original rather than accepting its same-named replacement', async () => {
    const { oldRoot, journalPath } = await interruptedSwap()
    await fs.rm(path.join(oldRoot, 'a.txt'))
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('could not be verified')
    expect(await fs.readFile(path.join(uploads, 'a.txt'), 'utf8')).toBe('replacement a.txt')
    expect(await fs.readFile(path.join(oldRoot, 'b.txt'), 'utf8')).toBe('original b.txt')
    expect(await fs.readFile(journalPath, 'utf8')).toContain('files-swapped')
  })

  it('keeps an older incomplete journal for explicit recovery instead of guessing original identities', async () => {
    const { oldRoot, journalPath } = await interruptedSwap()
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.contract = 'batshit-backup-restore-journal/v1'
    delete journal.originalUploadEntries
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('manual recovery is required')
    expect(await fs.readFile(path.join(oldRoot, 'a.txt'), 'utf8')).toBe('original a.txt')
    expect(await fs.readFile(path.join(uploads, 'new-only.txt'), 'utf8')).toBe('new-only')
  })

  it('refuses missing Redis rollback data before deleting any target records', async () => {
    const { journalPath } = await interruptedSwap()
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.phase = 'redis-replacing'
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await redis.json.set('user:target:settings', '$', { marker: 'keep until recovery can complete' })
    await fs.writeFile(path.join(staging, `${storageKey}.plan.ndjson`), JSON.stringify({ key: 'user:target:settings' }) + '\n')
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('rollback data is missing')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'keep until recovery can complete' })
  })

  it.each(['truncated-json', 'valid-prefix', 'same-size-change', 'malformed-matching-identity'])('refuses %s rollback evidence before changing either store', async (damage) => {
    const { journalPath, oldRoot } = await interruptedSwap()
    const record = (key: string, marker: string) => ({ key, type: 'json', value: { marker }, ttlSeconds: null, groupId: 'settings' })
    const plan = JSON.stringify(record('user:target:settings', 'target')) + '\n'
    const rollback = ['user:target:settings', 'user:target:settings:second']
      .map((key) => JSON.stringify(record(key, 'original')) + '\n').join('')
    const malformed = '{"key":\n'
    const identity = (value: string) => ({ bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') })
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.phase = 'redis-replacing'
    journal.redisRecoveryFiles = { plan: identity(plan), rollback: identity(damage === 'malformed-matching-identity' ? malformed : rollback) }
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await fs.writeFile(path.join(staging, `${storageKey}.plan.ndjson`), plan)
    const damaged = damage === 'valid-prefix' ? rollback.split('\n')[0] + '\n' :
      damage === 'same-size-change' ? rollback.replace('original', 'tampered') :
      damage === 'malformed-matching-identity' ? malformed : rollback.slice(0, -4)
    await fs.writeFile(path.join(staging, `${storageKey}.rollback.ndjson`), damaged)
    await redis.json.set('user:target:settings', '$', { marker: 'target' })
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow()
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'target' })
    expect(await fs.readFile(path.join(oldRoot, 'a.txt'), 'utf8')).toBe('original a.txt')
    expect(await fs.readFile(path.join(uploads, 'a.txt'), 'utf8')).toBe('replacement a.txt')
    expect(await fs.readFile(journalPath, 'utf8')).toContain('redis-replacing')
  })
})

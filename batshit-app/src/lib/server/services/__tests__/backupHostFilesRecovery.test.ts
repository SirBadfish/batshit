/**
 * BL-373 / BL-369: journal v4 recovery of skill and voice folders after a restore stopped
 * partway (a process that died, not a caught error). The journal records each replaced folder's
 * original and replacement identities; recovery puts the originals back only when every folder
 * is exactly where one of its two identities says, and keeps the journal otherwise.
 *
 * SAFETY: `node:os` answers a temporary home (see backupHostFiles.test.ts), and the last test
 * checks the real home's skill and voice folders gained nothing.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const nodePath = await import('node:path')
  if (!testHome.current) {
    testHome.current = nodePath.join(real.tmpdir(), `batshit-backup-host-recovery-home-${process.pid}-${Date.now()}`)
  }
  const homedir = () => testHome.current
  return { ...real, homedir, default: { ...real, homedir } }
})

import os from 'node:os'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { snapshotRealHomeTree } from '$lib/test-utils/realHomeSnapshot'
import { redis } from '$lib/server/redis'
import {
  createBackupBundle,
  ensureBackupRestoreRecovery,
  preflightStagedBackupRestore,
  restoreBackupBundle,
  restoreStagedBackup
} from '../backupRestoreService'

useRedisTestServer()

const stageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const storageKey = createHash('sha256').update(stageId).digest('hex')
const SKILLS = () => path.join(testHome.current, '.batshit', 'skills')
let root = ''
let uploads = ''
let staging = ''
let realHomeBefore: Record<string, string[]> = {}
let realHomeRoots: string[] = []

const listDir = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).sort()

beforeAll(async () => {
  const realOs = await vi.importActual<typeof import('node:os')>('node:os')
  realHomeRoots = ['skills', 'voice-profiles'].map((name) => path.join(realOs.homedir(), '.batshit', name))
  for (const dir of realHomeRoots) realHomeBefore[dir] = await snapshotRealHomeTree(dir)
  expect(os.homedir()).toBe(testHome.current)
})

afterAll(async () => {
  await fs.rm(testHome.current, { recursive: true, force: true })
})

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-host-recovery-'))
  uploads = path.join(root, 'uploads')
  staging = path.join(root, 'staging')
  await fs.mkdir(uploads)
  await fs.mkdir(staging)
  await fs.rm(path.join(testHome.current, '.batshit'), { recursive: true, force: true })
  // `systemSlashCommands.resolveUserSkillDir` reads `process.env.HOME`, not `os.homedir()`.
  vi.stubEnv('HOME', testHome.current)
  vi.stubEnv('UPLOADS_DIR', uploads)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', staging)
  vi.stubEnv('BATSHIT_TOKEN', 'disposable-host-recovery-test-token')
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

async function identity(target: string) {
  const stat = await fs.lstat(target, { bigint: true })
  return { device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
}

/**
 * The state a restore leaves when its process dies after `files-swapped`: `zc_kept` had an
 * original (now in the rollback folder, its replacement live) and `zc_new` had none (its
 * replacement live).
 */
async function interruptedHostSwap(overrides: { rootPath?: string } = {}) {
  const oldDir = path.join(SKILLS(), `.restore-old-${storageKey}`)
  await fs.mkdir(path.join(oldDir, 'zc_kept'), { recursive: true })
  await fs.writeFile(path.join(oldDir, 'zc_kept', 'SKILL.md'), '# original kept\n')
  await fs.mkdir(path.join(SKILLS(), 'zc_kept'), { recursive: true })
  await fs.writeFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), '# replacement kept\n')
  await fs.mkdir(path.join(SKILLS(), 'zc_new'), { recursive: true })
  await fs.writeFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), '# replacement new\n')
  await fs.mkdir(path.join(SKILLS(), 'zc_untouched'), { recursive: true })
  await fs.writeFile(path.join(SKILLS(), 'zc_untouched', 'SKILL.md'), '# never in the restore\n')
  const rootPath = overrides.rootPath ?? SKILLS()
  const journalPath = path.join(staging, `${storageKey}.restore-journal.json`)
  await fs.writeFile(journalPath, JSON.stringify({
    contract: 'batshit-backup-restore-journal/v4', stageId, userId: 'target',
    phase: 'files-swapped', hadOriginalUploads: false, originalUploadEntries: [],
    hostEntries: [
      { root: 'skills', rootPath, name: 'zc_kept', original: await identity(path.join(oldDir, 'zc_kept')), replacement: await identity(path.join(SKILLS(), 'zc_kept')) },
      { root: 'skills', rootPath, name: 'zc_new', original: null, replacement: await identity(path.join(SKILLS(), 'zc_new')) }
    ],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }))
  return { oldDir, journalPath }
}

describe('skill and voice folder recovery (journal v4)', () => {
  it('puts the originals back, removes the replacements, and leaves other folders alone', async () => {
    const { oldDir, journalPath } = await interruptedHostSwap()
    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    await expect(fs.stat(path.join(SKILLS(), 'zc_new'))).rejects.toThrow()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_untouched', 'SKILL.md'), 'utf8')).toBe('# never in the restore\n')
    await expect(fs.stat(oldDir)).rejects.toThrow()
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  it.each(['before', 'after'])('retries an interruption %s the original returns without losing it', async (timing) => {
    const { oldDir, journalPath } = await interruptedHostSwap()
    const rename = fs.rename.bind(fs)
    let failed = false
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      const matches = !failed && source === path.join(oldDir, 'zc_kept')
      if (matches && timing === 'before') { failed = true; throw new Error('simulated process exit') }
      await rename(source, target)
      if (matches && timing === 'after') { failed = true; throw new Error('simulated process exit') }
    })
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('simulated process exit')
    spy.mockRestore()
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8')).phase).toBe('files-swapped')
    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    await expect(fs.stat(path.join(SKILLS(), 'zc_new'))).rejects.toThrow()
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  it('leaves alone a folder another Batshit replaced after the crash, and still finishes (review 2)', async () => {
    const { journalPath } = await interruptedHostSwap()
    // Another Batshit on the computer took zc_new's place after the crash: it is not this
    // restore's replacement, so recovery must not remove it, and must not stay stuck on it.
    await fs.rm(path.join(SKILLS(), 'zc_new'), { recursive: true })
    await fs.mkdir(path.join(SKILLS(), 'zc_new'))
    await fs.writeFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), '# someone else\n')
    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), 'utf8')).toBe('# someone else\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  it('keeps a different creation even when the filesystem reuses the recorded device and inode', async () => {
    const { journalPath } = await interruptedHostSwap()
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    const recorded = journal.hostEntries.find((entry: { name: string }) => entry.name === 'zc_new').replacement
    const livePath = path.join(SKILLS(), 'zc_new')
    await fs.rm(livePath, { recursive: true })
    await fs.mkdir(livePath)
    await fs.writeFile(path.join(livePath, 'SKILL.md'), '# different creation\n')
    const lstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (target: any, options: any) => {
      const stat = await lstat(target, options)
      return String(target) === livePath && options?.bigint
        ? Object.assign(stat, { dev: BigInt(recorded.device), ino: BigInt(recorded.inode), birthtimeNs: BigInt(recorded.birthtimeNs) + 1n })
        : stat
    })

    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(livePath, 'SKILL.md'), 'utf8')).toBe('# different creation\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  it.each(['redis-replacing', 'redis-complete', 'rollback-complete'])('keeps every copy and journal for legacy host identities at %s', async (phase) => {
    const { oldDir, journalPath } = await interruptedHostSwap()
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.contract = 'batshit-backup-restore-journal/v3'
    journal.phase = phase
    for (const entry of journal.hostEntries) {
      if (entry.original) delete entry.original.birthtimeNs
      delete entry.replacement.birthtimeNs
    }
    await fs.writeFile(journalPath, JSON.stringify(journal))
    const journalBefore = await fs.readFile(journalPath, 'utf8')
    await redis.json.set('user:target:settings', '$', { marker: 'before' })
    await fs.writeFile(path.join(uploads, 'unchanged.txt'), 'upload before')

    await expect(ensureBackupRestoreRecovery()).rejects.toThrow(/creation identities.*manual recovery/)
    expect(await fs.readFile(journalPath, 'utf8')).toBe(journalBefore)
    expect(await fs.readFile(path.join(oldDir, 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# replacement kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), 'utf8')).toBe('# replacement new\n')
    expect(await fs.readFile(path.join(uploads, 'unchanged.txt'), 'utf8')).toBe('upload before')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
  })

  it.each([undefined, '0'])('refuses a journal without a positive creation timestamp (%s) before replay', async (birthtimeNs) => {
    const { oldDir, journalPath } = await interruptedHostSwap()
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    if (birthtimeNs === undefined) delete journal.hostEntries[0].original.birthtimeNs
    else journal.hostEntries[0].original.birthtimeNs = birthtimeNs
    journal.phase = 'redis-replacing'
    await fs.writeFile(journalPath, JSON.stringify(journal))
    const before = await fs.readFile(journalPath, 'utf8')
    await redis.json.set('user:target:settings', '$', { marker: 'before' })

    await expect(ensureBackupRestoreRecovery()).rejects.toThrow(/creation inventory.*Manual recovery/)
    expect(await fs.readFile(journalPath, 'utf8')).toBe(before)
    expect(await fs.readFile(path.join(oldDir, 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# replacement kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), 'utf8')).toBe('# replacement new\n')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
  })

  it.each([undefined, 0n])('refuses unavailable filesystem creation time (%s) before changing any copy', async (birthtimeNs) => {
    const { oldDir, journalPath } = await interruptedHostSwap()
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.phase = 'redis-replacing'
    await fs.writeFile(journalPath, JSON.stringify(journal))
    const before = await fs.readFile(journalPath, 'utf8')
    await redis.json.set('user:target:settings', '$', { marker: 'before' })
    const originalPath = path.join(oldDir, 'zc_kept')
    const lstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (target: any, options: any) => {
      const stat = await lstat(target, options)
      return String(target) === originalPath && options?.bigint ? Object.assign(stat, { birthtimeNs }) : stat
    })

    await expect(ensureBackupRestoreRecovery()).rejects.toThrow(/cannot safely identify.*manual recovery/)
    expect(await fs.readFile(journalPath, 'utf8')).toBe(before)
    expect(await fs.readFile(path.join(originalPath, 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# replacement kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), 'utf8')).toBe('# replacement new\n')
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'before' })
  })

  it('accepts valid positive creation time equal to ctime and retains rename recovery', async () => {
    const { journalPath } = await interruptedHostSwap()
    const lstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (target: any, options: any) => {
      const stat = await lstat(target, options)
      return options?.bigint ? Object.assign(stat, { ctimeNs: (stat as any).birthtimeNs }) : stat
    })
    await ensureBackupRestoreRecovery()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    await expect(fs.stat(path.join(SKILLS(), 'zc_new'))).rejects.toThrow()
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  it('stops with the journal and every folder intact when an original is lost and the replacement is live', async () => {
    const { oldDir, journalPath } = await interruptedHostSwap()
    // zc_kept's original is gone from the rollback folder while this restore's replacement is live.
    await fs.rm(path.join(oldDir, 'zc_kept'), { recursive: true })
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('could not be verified')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# replacement kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), 'utf8')).toBe('# replacement new\n')
    expect(await fs.readFile(journalPath, 'utf8')).toContain('files-swapped')
  })

  it('a completed restore recovered at startup keeps the folders it replaced (review 1)', async () => {
    const { oldDir, journalPath } = await interruptedHostSwap()
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.phase = 'redis-complete'
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await ensureBackupRestoreRecovery()
    const kept = (await listDir(SKILLS())).filter((name) => name.startsWith('.replaced-'))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(path.join(SKILLS(), kept[0], 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# original kept\n')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_kept', 'SKILL.md'), 'utf8')).toBe('# replacement kept\n')
    await expect(fs.stat(oldDir)).rejects.toThrow()
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })

  describe('while a restore holds the lock (re-review)', () => {
    /** A restore that is extracting: its lock is taken and its folder filled, no journal yet. */
    async function restoreMidExtraction() {
      const lock = path.join(staging, 'active-restore.lock')
      const extracting = path.join(uploads, `.restore-new-${'c'.repeat(64)}`)
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, stageId: 'zc-other', startedAt: new Date().toISOString() }))
      await fs.mkdir(extracting, { recursive: true })
      await fs.writeFile(path.join(extracting, 'part-1.png'), 'extracted so far')
      return { lock, extracting }
    }

    it("a second Inspect refuses and leaves the running restore's folder and lock alone", async () => {
      const { lock, extracting } = await restoreMidExtraction()
      await expect(preflightStagedBackupRestore('target', stageId)).rejects.toMatchObject({
        status: 409,
        message: 'Another backup restore is already running.'
      })
      expect(await fs.readFile(path.join(extracting, 'part-1.png'), 'utf8')).toBe('extracted so far')
      expect(await fs.readFile(lock, 'utf8')).toContain('zc-other')
    })

    it("a second restore refuses and leaves the running restore's folder and lock alone", async () => {
      const { lock, extracting } = await restoreMidExtraction()
      await expect(restoreStagedBackup('target', stageId, { confirmReplace: true })).rejects.toMatchObject({
        status: 409,
        message: 'Another backup restore is already running.'
      })
      await expect(restoreBackupBundle('target', new Uint8Array([1, 2, 3]), { confirmReplace: true })).rejects.toMatchObject({
        status: 409
      })
      expect(await fs.readFile(path.join(extracting, 'part-1.png'), 'utf8')).toBe('extracted so far')
      expect(await fs.readFile(lock, 'utf8')).toContain('zc-other')
    })

    it('an Inspect whose check passed just before another restore began still cleans up nothing', async () => {
      // The Inspect found no lock; while it resolves journals, another restore takes the lock
      // and starts extracting. The Inspect must not sweep that folder or clear that lock.
      const readdir = fs.readdir.bind(fs)
      let started = false
      const lock = path.join(staging, 'active-restore.lock')
      const extracting = path.join(uploads, `.restore-new-${'d'.repeat(64)}`)
      const spy = vi.spyOn(fs, 'readdir').mockImplementation(async (target: any, ...rest: any[]) => {
        if (!started && String(target) === staging) {
          started = true
          await fs.writeFile(lock, JSON.stringify({ pid: process.pid, stageId: 'zc-racing' }))
          await fs.mkdir(extracting, { recursive: true })
          await fs.writeFile(path.join(extracting, 'part-1.png'), 'extracted so far')
        }
        return (readdir as any)(target, ...rest)
      })
      try {
        await expect(preflightStagedBackupRestore('target', stageId)).rejects.toThrow()
      } finally {
        spy.mockRestore()
      }
      expect(started).toBe(true)
      expect(await fs.readFile(path.join(extracting, 'part-1.png'), 'utf8')).toBe('extracted so far')
      expect(await fs.readFile(lock, 'utf8')).toContain('zc-racing')
    })

    it('an Inspect during a real restore’s extraction is refused and changes nothing', async () => {
      await redis.json.set('user:target:settings', '$', { marker: 'backup' })
      await fs.writeFile(path.join(uploads, 'zc-a.png'), 'a')
      await redis.json.set('upload:images:zc-a.png', '$', {
        filename: 'zc-a.png', uploadType: 'images', storage: 'filesystem', relativePath: 'zc-a.png', size: 1,
        filePath: path.join(uploads, 'zc-a.png')
      })
      const bundle = await createBackupBundle('target')
      const mkdir = fs.mkdir.bind(fs)
      let inspected: unknown = 'not run'
      let extractingSeen: string[] = []
      const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (target: any, options?: any) => {
        const result = await mkdir(target, options)
        if (inspected === 'not run' && /\.restore-new-[0-9a-f]{64}$/.test(String(target)) && String(target).startsWith(uploads)) {
          inspected = 'running'
          inspected = await preflightStagedBackupRestore('target', stageId).catch((error) => error)
          extractingSeen = await fs.readdir(uploads)
        }
        return result
      })
      try {
        await restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })
      } finally {
        spy.mockRestore()
      }
      expect(inspected).toMatchObject({ status: 409 })
      expect(extractingSeen.some((name) => name.startsWith('.restore-new-'))).toBe(true)
      expect(await fs.readFile(path.join(uploads, 'zc-a.png'), 'utf8')).toBe('a')
      await expect(fs.stat(path.join(staging, 'active-restore.lock'))).rejects.toThrow()
    })
  })

  it('removes an upload extraction folder a restore left before writing its journal, never an old one (review 3)', async () => {
    const orphan = path.join(uploads, `.restore-new-${'a'.repeat(64)}`)
    const originals = path.join(uploads, `.restore-old-${'b'.repeat(64)}`)
    await fs.mkdir(orphan, { recursive: true })
    await fs.writeFile(path.join(orphan, 'copy.png'), 'copy')
    await fs.mkdir(originals, { recursive: true })
    await fs.writeFile(path.join(originals, 'original.png'), 'original')
    await ensureBackupRestoreRecovery()
    await expect(fs.stat(orphan)).rejects.toThrow()
    expect(await fs.readFile(path.join(originals, 'original.png'), 'utf8')).toBe('original')
  })

  it('stops for manual recovery when the skills folder moved since the crash', async () => {
    const { journalPath } = await interruptedHostSwap({ rootPath: '/Users/someone-else/.batshit/skills' })
    await expect(ensureBackupRestoreRecovery()).rejects.toThrow('manual recovery is required')
    expect(await fs.readFile(path.join(SKILLS(), 'zc_new', 'SKILL.md'), 'utf8')).toBe('# replacement new\n')
    expect(await fs.readFile(journalPath, 'utf8')).toContain('files-swapped')
  })

  it('a restore that dies while replacing Redis is undone in both stores at the next start', async () => {
    await fs.mkdir(path.join(SKILLS(), 'zc_notes'), { recursive: true })
    await fs.writeFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), '# from the backup\n')
    await redis.json.set('skill:target:zc_notes', '$', { id: 'zc_notes', user_id: 'target', name: 'zc_notes', source: 'custom', is_system: false })
    await redis.json.set('user:target:settings', '$', { marker: 'backup' })
    const bundle = await createBackupBundle('target')
    await fs.writeFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), '# on this computer\n')
    await redis.json.set('user:target:settings', '$', { marker: 'original' })

    // The final journal write fails before its rename: the persisted phase stays
    // `redis-replacing`, so the next start must undo Redis AND the skill folder.
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).endsWith('.restore-journal.json') &&
          JSON.parse(await fs.readFile(source, 'utf8')).phase === 'redis-complete') {
        throw new Error('injected commit-journal failure')
      }
      await rename(source, target)
    })
    await expect(restoreBackupBundle('target', bundle.bytes, { confirmReplace: true })).rejects.toThrow('injected commit-journal failure')
    spy.mockRestore()
    expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), 'utf8')).toBe('# from the backup\n')
    const journals = (await fs.readdir(staging)).filter((name) => name.endsWith('.restore-journal.json'))
    expect(journals).toHaveLength(1)
    const journal = JSON.parse(await fs.readFile(path.join(staging, journals[0]), 'utf8'))
    expect(journal.contract).toBe('batshit-backup-restore-journal/v4')
    expect(journal.hostEntries.map((entry: { name: string }) => entry.name)).toEqual(['zc_notes'])

    await ensureBackupRestoreRecovery()
    expect(await redis.json.get('user:target:settings')).toEqual({ marker: 'original' })
    expect(await fs.readFile(path.join(SKILLS(), 'zc_notes', 'SKILL.md'), 'utf8')).toBe('# on this computer\n')
    expect((await listDir(SKILLS())).filter((name) => name.startsWith('.restore-'))).toEqual([])
  })

  it('wrote nothing into the real home folder', async () => {
    for (const dir of realHomeRoots) expect(await snapshotRealHomeTree(dir)).toEqual(realHomeBefore[dir])
  })
})

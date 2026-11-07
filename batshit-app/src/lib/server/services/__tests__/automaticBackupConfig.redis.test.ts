/** Real Redis owns config CAS; default runs skip these bodies rather than fake EVAL. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
const fixture = vi.hoisted(() => ({ root: '' }))
// The real skill owner fixes its root when its process module loads. This fixture
// changes homes between cases, so bind that owner boundary to the disposable root.
vi.mock('../skillRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skillRegistry')>()
  const { join } = await import('node:path')
  return { ...actual, getSkillCacheRoot: () => {
    if (!fixture.root) throw new Error('Disposable skill root is not ready.')
    return join(fixture.root, 'home', 'skills')
  } }
})
import { automaticBackupPaths, AUTOMATIC_BACKUP_CONFIG_KEY, readAutomaticBackupConfig,
  saveAutomaticBackupConfig, validateAutomaticBackupFolder, resolveAutomaticBackupDestination } from '../automaticBackupConfig'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
useRedisTestServer()
let root = ''
describe.runIf(REAL)('automatic backup configuration on real RedisJSON and disk', () => {
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-auto-config-')))
    fixture.root = root
    vi.stubEnv('BATSHIT_RUNTIME_DATA_DIR', root)
    vi.stubEnv('BATSHIT_HOME_DIR', path.join(root, 'home'))
    vi.stubEnv('UPLOADS_DIR', path.join(root, 'uploads'))
    vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', path.join(root, 'staging'))
  })
  afterEach(async () => { vi.unstubAllEnvs(); if (root) await fs.rm(root, { recursive: true, force: true }) })
  const body = (expectedRevision = 'none', extra = {}) => ({ expectedRevision, enabled: true, cadence: 'daily', folder: null, afterUpdates: false, ...extra })
  it('reads absent consent as off, creates only the default destination when explicitly enabled', async () => {
    expect((await readAutomaticBackupConfig('admin')).enabled).toBe(false)
    await expect(fs.stat(automaticBackupPaths().defaultFolder)).rejects.toThrow()
    const saved = await saveAutomaticBackupConfig('admin', body())
    expect(saved).toMatchObject({ enabled: true, cadence: 'daily', afterUpdates: false, ownerUserId: 'admin' })
    expect((await fs.stat(automaticBackupPaths().defaultFolder)).isDirectory()).toBe(true)
    expect(await readAutomaticBackupConfig('admin')).toEqual(saved)
    expect(await resolveAutomaticBackupDestination(saved)).toBe(await fs.realpath(automaticBackupPaths().defaultFolder))
  })
  it('atomically accepts only one simultaneous original revision, preserving unrelated settings', async () => {
    await redis.json.set('user:admin:settings', '$', { admin_settings: { sentinel: 'keep' } })
    const results = await Promise.allSettled([
      saveAutomaticBackupConfig('admin', body('none', { cadence: 'daily' })),
      saveAutomaticBackupConfig('admin', body('none', { cadence: 'weekly' }))
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(await redis.json.get('user:admin:settings')).toEqual({ admin_settings: { sentinel: 'keep' } })
  })
  it('refuses invalid input, another owner and stale/unknown saves without replacement', async () => {
    const saved = await saveAutomaticBackupConfig('admin', body())
    await expect(saveAutomaticBackupConfig('admin', body('none', { cadence: 'weekly' }))).rejects.toThrow('changed')
    await expect(readAutomaticBackupConfig('other')).rejects.toThrow('different account')
    await expect(saveAutomaticBackupConfig('admin', body(saved.revision, { keep: 20 }))).rejects.toThrow('Invalid')
    expect(await readAutomaticBackupConfig('admin')).toEqual(saved)
    await redis.json.set(AUTOMATIC_BACKUP_CONFIG_KEY, '$', { enabled: true } as never)
    await expect(readAutomaticBackupConfig('admin')).rejects.toThrow('could not be read')
  })
  it('rejects input/staging/state folders, follows a chosen canonical destination and never recreates it on execution', async () => {
    for (const folder of [path.join(root, 'uploads'), path.join(root, 'staging'), path.join(root, 'home/skills/x'), path.join(root, 'automatic-backup-state')]) {
      await expect(validateAutomaticBackupFolder(folder, true)).rejects.toThrow('outside')
    }
    const chosen = path.join(root, 'chosen'); await fs.mkdir(chosen)
    const saved = await saveAutomaticBackupConfig('admin', body('none', { folder: chosen }))
    expect(saved.folder).toBe(await fs.realpath(chosen))
    await fs.rmdir(chosen)
    await expect(validateAutomaticBackupFolder(saved.folder!)).rejects.toThrow()
    await expect(fs.stat(chosen)).rejects.toThrow()
  })
})

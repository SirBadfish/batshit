import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomaticBackupConfig } from '$lib/types/automaticBackup'

const fake = vi.hoisted(() => ({
  config: null as AutomaticBackupConfig | null, status: null as any, ledger: null as any,
  create: vi.fn(), recover: vi.fn(), save: vi.fn(), validate: vi.fn(), ownerRead: vi.fn(), maintenance: false, releases: 0,
  shutdown: null as null | (() => Promise<void>)
}))
vi.mock('$lib/server/redis', () => ({ redis: { execute: (fn: any) => fn({
  get: () => fake.ownerRead(), json: { get: async (key: string) => key.endsWith('_config') ? fake.config : fake.status,
    set: async (_: string, __: string, value: unknown) => { fake.status = value } }
}) } }))
vi.mock('../automaticBackupConfig', () => ({
  AUTOMATIC_BACKUP_CONFIG_KEY: 'batshit:automatic_backup_config', AUTOMATIC_BACKUP_STATUS_KEY: 'batshit:automatic_backup_status',
  AutomaticBackupError: class extends Error {}, automaticBackupPaths: () => ({ defaultFolder: '/owned/backups', ledgerPath: '/owned/state/ledger.json' }),
  readAutomaticBackupConfig: async () => fake.config,
  resolveAutomaticBackupDestination: async (config: AutomaticBackupConfig) => config.folder ?? '/owned/backups',
  saveAutomaticBackupConfig: (...args: any[]) => fake.save(...args),
  validateAutomaticBackupFolder: (...args: any[]) => fake.validate(...args)
}))
vi.mock('../automaticBackupStorage', () => ({ createAutomaticBackup: (...args: any[]) => fake.create(...args),
  recoverAutomaticBackups: (...args: any[]) => fake.recover(...args), readAutomaticBackupLedger: async () => fake.ledger }))
vi.mock('../backupRestoreActivity', () => ({ enterBackupRestoreHttpRequest: () => fake.maintenance ? null : () => { fake.releases++ } }))
vi.mock('../runtimeShutdown', () => ({ registerRuntimeShutdownTask: (_: string, fn: any) => { fake.shutdown = fn } }))

let service: typeof import('../automaticBackupService')
const NOW = new Date('2026-10-23T12:00:00Z')
function receipt(at = '2026-10-22T10:00:00Z', buildId = 'old-build') {
  return { createdAt: at, folder: '/owned/backups', path: '/owned/backups/one.zip', bytes: 100, provenance: { buildId, dataGeneration: 'v1', reason: 'scheduled' } }
}
beforeEach(async () => {
  vi.resetModules()
  fake.config = { revision: 'rev1', ownerUserId: 'admin', enabled: true, cadence: 'daily', folder: null, afterUpdates: false, enabledAt: '2026-10-20T00:00:00Z' }
  fake.status = null; fake.ledger = null; fake.maintenance = false; fake.releases = 0; fake.shutdown = null
  fake.create.mockReset().mockResolvedValue({}); fake.save.mockReset().mockResolvedValue({}); fake.validate.mockReset().mockResolvedValue('/owned/backups')
  fake.recover.mockReset().mockImplementation(async () => { fake.ledger.pendingPublication = null; fake.ledger.pendingRetirement = null })
  fake.ownerRead.mockReset().mockResolvedValue('admin')
  service = await import('../automaticBackupService')
  service.setAutomaticBackupStartup({ ready: true, buildId: 'new-build', dataGeneration: 'migration-v1' })
})
afterEach(async () => { await fake.shutdown?.(); vi.useRealTimers() })

describe('automatic backup clock and custody (archive IO proven by storage suite)', () => {
  it('is off until a human enables it and waits for actual startup success', async () => {
    fake.config!.enabled = false; await service.runAutomaticBackupSweep(NOW); expect(fake.create).not.toHaveBeenCalled()
    fake.config!.enabled = true; service.setAutomaticBackupStartup({ ready: false, buildId: 'new', dataGeneration: '', error: 'Migration failed' })
    await service.runAutomaticBackupSweep(NOW); expect(fake.create).not.toHaveBeenCalled()
    expect((await service.getAutomaticBackupView('admin')).startup.error).toBe('Migration failed')
  })
  it('collapses many overdue daily intervals to one backup with completed provenance', async () => {
    fake.ledger = { userId: 'admin', backups: [receipt('2026-09-01T00:00:00Z')], cleanupFailures: [] }
    await service.runAutomaticBackupSweep(NOW)
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect(fake.create.mock.calls[0][0]).toMatchObject({ userId: 'admin', folder: '/owned/backups', provenance: { buildId: 'new-build', dataGeneration: 'migration-v1', reason: 'scheduled' } })
    expect(fake.releases).toBe(1)
  })
  it('uses weekly cadence from last verified completion, never attempts', async () => {
    fake.config!.cadence = 'weekly'; fake.ledger = { userId: 'admin', backups: [receipt('2026-10-22T00:00:00Z')], cleanupFailures: [] }
    await service.runAutomaticBackupSweep(NOW); expect(fake.create).not.toHaveBeenCalled()
    expect((await service.getAutomaticBackupView('admin')).nextDueAt).toBe('2026-10-29T00:00:00.000Z')
  })
  it('coalesces update with the schedule, and a same-build restart is not another update', async () => {
    fake.config!.afterUpdates = true; fake.ledger = { userId: 'admin', backups: [receipt()], cleanupFailures: [] }
    await service.runAutomaticBackupSweep(NOW)
    expect(fake.create.mock.calls[0][0].provenance.reason).toBe('scheduled-and-update')
    fake.create.mockClear(); fake.ledger.backups = [receipt(NOW.toISOString(), 'new-build')]
    await service.runAutomaticBackupSweep(NOW); expect(fake.create).not.toHaveBeenCalled()
  })
  it('backs up a successful new build even when its schedule is not due', async () => {
    fake.config!.afterUpdates = true; fake.ledger = { userId: 'admin', backups: [receipt(NOW.toISOString())], cleanupFailures: [] }
    await service.runAutomaticBackupSweep(NOW)
    expect(fake.create.mock.calls[0][0].provenance.reason).toBe('update')
  })

  it('settles recent interrupted publication before cadence without a second export', async () => {
    fake.ledger = { userId: 'admin', backups: [receipt(NOW.toISOString(), 'new-build')], cleanupFailures: [], pendingPublication: { retained: true } }
    await service.runAutomaticBackupSweep(NOW)
    expect(fake.recover).toHaveBeenCalledTimes(1); expect(fake.create).not.toHaveBeenCalled()
    await service.runAutomaticBackupSweep(NOW)
    expect(fake.recover).toHaveBeenCalledTimes(1); expect(fake.create).not.toHaveBeenCalled()
  })

  it('does not let permanent preserved/unavailable notices starve a later due backup', async () => {
    fake.ledger = { userId: 'admin', backups: [receipt()], cleanupFailures: [{ path: '/foreign', message: 'changed' }],
      preservedFiles: [{ path: '/foreign', originalPath: '/foreign', message: 'kept' }],
      unavailableReceipts: [{ receipt: receipt(), path: '/foreign', state: 'changed', message: 'left untouched' }] }
    await service.runAutomaticBackupSweep(NOW)
    expect(fake.recover).not.toHaveBeenCalled(); expect(fake.create).toHaveBeenCalledTimes(1)
    expect((await service.getAutomaticBackupView('admin')).unavailableCopies).toEqual([{ path: '/foreign', state: 'changed', message: 'left untouched' }])
  })
  it('holds one actual flight, refuses concurrent config save and releases only at settlement', async () => {
    let finish!: () => void; fake.create.mockImplementation(() => new Promise<void>(r => { finish = r }))
    const first = service.runAutomaticBackupSweep(NOW)
    await vi.waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))
    const second = service.runAutomaticBackupSweep(NOW)
    expect(second).toBe(first); expect(fake.releases).toBe(0)
    await expect(service.updateAutomaticBackupConfig('admin', {})).rejects.toThrow('still finishing')
    finish(); await first; expect(fake.releases).toBe(1)
  })
  it('does not enter during restore or advance success after disk/export failure', async () => {
    fake.maintenance = true; await service.runAutomaticBackupSweep(NOW); expect(fake.create).not.toHaveBeenCalled(); expect(fake.status).toBeNull()
    fake.maintenance = false; fake.create.mockRejectedValue(new Error('Drive disconnected'))
    await service.runAutomaticBackupSweep(NOW)
    expect(fake.status.error).toBe('Drive disconnected'); expect(fake.ledger).toBeNull(); expect(fake.releases).toBe(1)
    await service.runAutomaticBackupSweep(new Date(NOW.getTime() + 60_000)); expect(fake.create).toHaveBeenCalledTimes(1)
    await service.runAutomaticBackupSweep(new Date(NOW.getTime() + 15 * 60_000)); expect(fake.create).toHaveBeenCalledTimes(2)
  })
  it('uses the selected folder without fallback and preserves known old-folder copies in status', async () => {
    fake.config!.folder = '/selected/drive'; fake.ledger = { userId: 'admin', backups: [receipt()], cleanupFailures: [] }
    fake.validate.mockRejectedValue(new Error('Destination missing'))
    await service.runAutomaticBackupSweep(NOW); expect(fake.create).not.toHaveBeenCalled()
    const view = await service.getAutomaticBackupView('admin')
    expect(view.error).toBe('Destination missing'); expect(view.preservedFolders).toEqual([{ folder: '/owned/backups', backupCount: 1 }]); expect(view.retainedCount).toBe(0)
  })
  it('drains real owned work and stops the timer when the app closes', async () => {
    vi.useFakeTimers()
    fake.create.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
    service.startAutomaticBackupScheduler()
    await vi.waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))
    await fake.shutdown!(); expect(fake.releases).toBe(1)
    await vi.advanceTimersByTimeAsync(2 * 60_000); expect(fake.create).toHaveBeenCalledTimes(1)
  })

  it('does not begin an export when shutdown arrives during asynchronous preparation', async () => {
    let resolveOwner!: (owner: string) => void
    fake.ownerRead.mockImplementationOnce(() => new Promise<string>(resolve => { resolveOwner = resolve }))
    service.startAutomaticBackupScheduler()
    await vi.waitFor(() => expect(fake.ownerRead).toHaveBeenCalledTimes(1))
    const stopped = fake.shutdown!()
    resolveOwner('admin')
    await stopped
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.recover).not.toHaveBeenCalled(); expect(fake.releases).toBe(0)
  })
})

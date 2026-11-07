import { redis } from '$lib/server/redis'
import type { AutomaticBackupStartup, AutomaticBackupView, AutomaticBackupConfig } from '$lib/types/automaticBackup'
import {
  AUTOMATIC_BACKUP_CONFIG_KEY, AUTOMATIC_BACKUP_STATUS_KEY, AutomaticBackupError,
  automaticBackupPaths, readAutomaticBackupConfig, saveAutomaticBackupConfig, validateAutomaticBackupFolder,
  resolveAutomaticBackupDestination
} from './automaticBackupConfig'
import { createAutomaticBackup, readAutomaticBackupLedger, recoverAutomaticBackups } from './automaticBackupStorage'
import { enterBackupRestoreHttpRequest } from './backupRestoreActivity'
import { registerRuntimeShutdownTask } from './runtimeShutdown'

const DAY = 24 * 60 * 60 * 1000
const RETRY_MS = 15 * 60 * 1000
let startup: AutomaticBackupStartup = { ready: false, buildId: '', dataGeneration: '', error: 'Waiting for successful startup and data checks.' }
let timer: ReturnType<typeof setInterval> | null = null
let flight: Promise<void> | null = null
let abort: AbortController | null = null
let stopping = false
let configSaving = false

interface Attempt { lastAttemptAt: string | null; error: string | null; retryAt: string | null }
const emptyAttempt = (): Attempt => ({ lastAttemptAt: null, error: null, retryAt: null })

function boundedFailure(error: unknown) {
  return (error instanceof Error ? error.message : 'Automatic backup failed. Existing backups were kept.').slice(0, 800)
}

export function setAutomaticBackupStartup(value: AutomaticBackupStartup) {
  startup = { ...value }
}

async function attemptStatus(): Promise<Attempt> {
  const value = await redis.execute(client => client.json.get(AUTOMATIC_BACKUP_STATUS_KEY)) as Attempt | null
  if (value === null) return emptyAttempt()
  if (typeof value !== 'object' || Array.isArray(value) ||
    ![value.lastAttemptAt, value.retryAt].every(v => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)))) ||
    !(value.error === null || typeof value.error === 'string')) throw new AutomaticBackupError('Automatic backup status could not be read. Existing files were kept.')
  return value
}

async function writeAttempt(value: Attempt) {
  await redis.execute(client => client.json.set(AUTOMATIC_BACKUP_STATUS_KEY, '$', value as never))
}

export function automaticBackupDueAt(config: AutomaticBackupConfig, last: { createdAt: string; folder: string } | undefined,
  folder = config.folder ?? automaticBackupPaths().defaultFolder) {
  if (!config.enabled) return null
  if (!last || last.folder !== folder || (config.enabledAt && Date.parse(last.createdAt) < Date.parse(config.enabledAt))) return config.enabledAt ?? new Date(0).toISOString()
  return new Date(Date.parse(last.createdAt) + (config.cadence === 'weekly' ? 7 : 1) * DAY).toISOString()
}

export async function getAutomaticBackupView(userId: string): Promise<AutomaticBackupView> {
  const config = await readAutomaticBackupConfig(userId)
  const paths = automaticBackupPaths()
  const ledger = await readAutomaticBackupLedger(paths.ledgerPath)
  if (ledger && ledger.userId !== userId) throw new AutomaticBackupError('The automatic backup ledger belongs to a different account.', 409)
  const folder = await resolveAutomaticBackupDestination(config)
  const retained = ledger?.backups.filter(b => b.folder === folder) ?? []
  const last = retained[0]
  const attempt = await attemptStatus()
  return {
    config, defaultFolder: paths.defaultFolder, startup: { ...startup }, running: flight !== null,
    lastSuccess: last ? { createdAt: last.createdAt, path: last.path, bytes: last.bytes } : null,
    retainedCount: retained.length, nextDueAt: automaticBackupDueAt(config, last, folder), lastAttemptAt: attempt.lastAttemptAt,
    error: attempt.error, cleanupFailures: ledger?.cleanupFailures ?? [],
    preservedFiles: ledger?.preservedFiles ?? [],
    unavailableCopies: (ledger?.unavailableReceipts ?? []).map(item => ({ path: item.path, state: item.state, message: item.message })),
    preservedFolders: Object.entries((ledger?.backups ?? []).filter(b => b.folder !== folder).reduce<Record<string, number>>((m, b) => {
      m[b.folder] = (m[b.folder] ?? 0) + 1; return m
    }, {})).map(([folder, backupCount]) => ({ folder, backupCount }))
  }
}

export async function updateAutomaticBackupConfig(userId: string, body: unknown) {
  if (flight || configSaving) throw new AutomaticBackupError('A backup or settings save is still finishing. Wait for it to finish before changing these settings.', 409)
  configSaving = true
  try {
    const saved = await saveAutomaticBackupConfig(userId, body)
    await writeAttempt(emptyAttempt())
    // Apply on the next existing tick. Reading settings never starts a backup.
    return { ...await getAutomaticBackupView(userId), config: saved }
  } finally { configSaving = false }
}

async function performSweep(now: Date) {
  if (stopping || !startup.ready) return
  const owner = await redis.execute(async client => {
    const value = await client.json.get(AUTOMATIC_BACKUP_CONFIG_KEY) as unknown as AutomaticBackupConfig | null
    if (!value?.enabled) return null
    const adminId = await client.get('user:admin')
    if (!adminId || value.ownerUserId !== adminId) throw new AutomaticBackupError('Automatic backups no longer match the current administrator. Existing files were kept.')
    return adminId
  })
  if (!owner) return
  const config = await readAutomaticBackupConfig(owner)
  if (!config.enabled) return
  const attempt = await attemptStatus()
  if (attempt.retryAt && Date.parse(attempt.retryAt) > now.getTime()) return
  const paths = automaticBackupPaths()
  const ledger = await readAutomaticBackupLedger(paths.ledgerPath)
  if (ledger && ledger.userId !== owner) throw new AutomaticBackupError('Automatic backup ownership could not be confirmed.')
  const folder = await resolveAutomaticBackupDestination(config)
  const last = ledger?.backups.find(b => b.folder === folder)
  const dueAt = automaticBackupDueAt(config, last, folder)
  const scheduled = dueAt !== null && Date.parse(dueAt) <= now.getTime()
  const update = config.afterUpdates && !!last && last.provenance.buildId !== startup.buildId
  const recovery = !!(ledger?.pendingPublication || ledger?.pendingRetirement ||
    (ledger?.backups.filter(b => b.folder === folder).length ?? 0) > 2)
  // Preservation notices alone are not work; they must not starve later backups.
  if (!recovery && !scheduled && !update) return
  // Shutdown may have begun while the preparation reads were pending. Install
  // cancellation synchronously with admission, never start fresh work after it.
  if (stopping || !startup.ready) return
  const release = enterBackupRestoreHttpRequest()
  if (!release) return // Maintenance has not admitted work. Nothing attempted or advanced.
  abort = new AbortController()
  try {
    await writeAttempt({ lastAttemptAt: now.toISOString(), error: null, retryAt: null })
    await validateAutomaticBackupFolder(folder)
    if (recovery) {
      await recoverAutomaticBackups({ folder, ledgerPath: paths.ledgerPath, userId: owner, signal: abort.signal })
      const recovered = await readAutomaticBackupLedger(paths.ledgerPath)
      const pending = !!(recovered?.pendingPublication || recovered?.pendingRetirement ||
        (recovered?.backups.filter(b => b.folder === folder).length ?? 0) > 2)
      await writeAttempt({ lastAttemptAt: now.toISOString(), error: null,
        retryAt: pending ? new Date(now.getTime() + RETRY_MS).toISOString() : null })
      return // Cadence is re-evaluated next tick, never a duplicate recovery export.
    }
    await createAutomaticBackup({
      folder, ledgerPath: paths.ledgerPath, userId: owner,
      provenance: { buildId: startup.buildId, dataGeneration: startup.dataGeneration,
        reason: scheduled && update ? 'scheduled-and-update' : update ? 'update' : 'scheduled' },
      signal: abort.signal
    })
    await writeAttempt({ lastAttemptAt: now.toISOString(), error: null, retryAt: null })
  } catch (error) {
    await writeAttempt({ lastAttemptAt: now.toISOString(), error: boundedFailure(error), retryAt: new Date(now.getTime() + RETRY_MS).toISOString() })
  } finally {
    abort = null
    release()
  }
}

/** One due backup covers all missed intervals and any coincident update. Never queues. */
export function runAutomaticBackupSweep(now = new Date()): Promise<void> {
  if (configSaving || stopping) return Promise.resolve()
  if (flight) return flight
  flight = performSweep(now).catch(async error => {
    console.error('[automatic-backup] failed:', boundedFailure(error))
    await writeAttempt({ lastAttemptAt: now.toISOString(), error: boundedFailure(error), retryAt: new Date(now.getTime() + RETRY_MS).toISOString() })
  }).finally(() => { flight = null })
  return flight
}

export function startAutomaticBackupScheduler() {
  if (timer || stopping) return
  timer = setInterval(() => { void runAutomaticBackupSweep().catch(error => console.error('[automatic-backup] status write failed:', boundedFailure(error))) }, 60_000)
  timer.unref?.()
  registerRuntimeShutdownTask('automatic-backups', async () => {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
    abort?.abort(new Error('Batshit is closing. The unfinished backup was not accepted.'))
    await flight
  })
  void runAutomaticBackupSweep().catch(error => console.error('[automatic-backup] status write failed:', boundedFailure(error)))
}

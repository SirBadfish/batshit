import { randomUUID, createHash } from 'node:crypto'
import { constants, createReadStream, type BigIntStats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBackupBundleStream, verifyAutomaticBackupArchive } from './backupRestoreService'
import { resolveHostFileRoot } from './backupHostFiles'

/** Instance-local custody; never exported, restored, scanned, or inferred from filenames. */
const CONTRACT = 'batshit-automatic-backup-ledger/v1'
const LEDGER_MAX_BYTES = 4 * 1024 * 1024
const flights = new Set<string>()

export interface AutomaticBackupProvenance {
  buildId: string
  dataGeneration: string
  reason: 'scheduled' | 'update' | 'scheduled-and-update'
}
export interface AutomaticBackupIdentity {
  device: string
  inode: string
  birthtimeNs: string
}
export interface AutomaticBackupReceipt {
  id: string
  path: string
  folder: string
  createdAt: string
  bytes: number
  sha256: string
  identity: AutomaticBackupIdentity
  provenance: AutomaticBackupProvenance
}
export interface AutomaticBackupCleanupFailure { path: string; message: string }
export interface AutomaticBackupUnavailableReceipt {
  receipt: AutomaticBackupReceipt
  path: string
  state: 'missing' | 'changed' | 'unreadable'
  message: string
}
class BackupIdentityChangedError extends Error {}
interface Publication { receipt: AutomaticBackupReceipt; temporaryPath: string }
interface Retirement { receipt: AutomaticBackupReceipt; quarantinePath: string; directoryIdentity: AutomaticBackupIdentity; archiveRemoved?: true }
export interface AutomaticBackupLedger {
  contract: typeof CONTRACT
  ownerId: string
  userId: string
  backups: AutomaticBackupReceipt[]
  pendingPublication: Publication | null
  pendingRetirement: Retirement | null
  cleanupFailures: AutomaticBackupCleanupFailure[]
  unavailableReceipts: AutomaticBackupUnavailableReceipt[]
  /** Foreign/replaced files are kept, including their recovery path if their old name is busy. */
  preservedFiles: { path: string; originalPath: string; message: string }[]
}
export interface AutomaticBackupStorageResult {
  receipt: AutomaticBackupReceipt
  /** Newest first; includes additional known copies when retirement could not finish. */
  retained: AutomaticBackupReceipt[]
  cleanupFailures: AutomaticBackupCleanupFailure[]
  preservedFolders: { folder: string; backupCount: number }[]
}
export type AutomaticBackupRecoveryResult = Omit<AutomaticBackupStorageResult, 'receipt'> & { receipt?: AutomaticBackupReceipt }

function code(error: unknown) { return (error as NodeJS.ErrnoException)?.code }
function message(error: unknown) { return error instanceof Error ? error.message : 'The filesystem operation failed.' }
function absolute(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value
}
function identity(stat: BigIntStats): AutomaticBackupIdentity {
  if (!stat.isFile() || stat.birthtimeNs <= 0n) throw new Error('Backup files require a regular file with a positive creation identity.')
  return { device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
}
function directoryIdentity(stat: BigIntStats): AutomaticBackupIdentity {
  if (!stat.isDirectory() || stat.birthtimeNs <= 0n) throw new Error('Backup retirement requires a plain directory with a positive creation identity.')
  return { device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
}
function validIdentity(value: AutomaticBackupIdentity) {
  return value && [value.device, value.inode, value.birthtimeNs].every((part) => typeof part === 'string' && /^\d+$/.test(part)) && BigInt(value.birthtimeNs) > 0n
}
function sameIdentity(left: AutomaticBackupIdentity, right: AutomaticBackupIdentity) {
  return left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs
}
function validProvenance(value: AutomaticBackupProvenance) {
  return value && typeof value.buildId === 'string' && value.buildId.length > 0 && value.buildId.length <= 512 &&
    typeof value.dataGeneration === 'string' && value.dataGeneration.length > 0 && value.dataGeneration.length <= 512 &&
    ['scheduled', 'update', 'scheduled-and-update'].includes(value.reason)
}
function validReceipt(value: AutomaticBackupReceipt) {
  return value && /^[0-9a-f-]{36}$/.test(value.id) && absolute(value.folder) && absolute(value.path) &&
    path.dirname(value.path) === value.folder && path.basename(value.path) === `batshit-automatic-backup-${value.id}.zip` &&
    Number.isFinite(Date.parse(value.createdAt)) && Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
    /^[0-9a-f]{64}$/.test(value.sha256) && validIdentity(value.identity) && validProvenance(value.provenance)
}
function validateLedger(value: AutomaticBackupLedger): AutomaticBackupLedger {
  if (!value || value.contract !== CONTRACT || !/^[0-9a-f-]{36}$/.test(value.ownerId) || typeof value.userId !== 'string' || !value.userId ||
    !Array.isArray(value.backups) || !value.backups.every(validReceipt) ||
    new Set(value.backups.map((item) => item.path)).size !== value.backups.length ||
    !Array.isArray(value.cleanupFailures) || !value.cleanupFailures.every((item) => absolute(item.path) && typeof item.message === 'string') ||
    !Array.isArray(value.preservedFiles) || !value.preservedFiles.every((item) => absolute(item.path) && absolute(item.originalPath) && typeof item.message === 'string') ||
    !Array.isArray(value.unavailableReceipts) || !value.unavailableReceipts.every((item) => validReceipt(item.receipt) && absolute(item.path) && ['missing', 'changed', 'unreadable'].includes(item.state) && typeof item.message === 'string')) {
    throw new Error('The automatic backup ledger is unreadable or invalid. Existing files were kept.')
  }
  if (value.pendingPublication !== null) {
    const pending = value.pendingPublication
    if (!pending || !validReceipt(pending.receipt) || pending.temporaryPath !== `${pending.receipt.path}.${value.ownerId}.tmp`) {
      throw new Error('The pending automatic backup publication is invalid. Existing files were kept.')
    }
  }
  if (value.pendingRetirement !== null) {
    const pending = value.pendingRetirement
    if (!pending || !validReceipt(pending.receipt) || !absolute(pending.quarantinePath) || !validIdentity(pending.directoryIdentity) ||
      path.dirname(path.dirname(pending.quarantinePath)) !== pending.receipt.folder ||
      !/^\.batshit-retire-[0-9a-f-]{36}$/.test(path.basename(path.dirname(pending.quarantinePath))) ||
      path.basename(pending.quarantinePath) !== path.basename(pending.receipt.path) ||
      (pending.archiveRemoved !== undefined && pending.archiveRemoved !== true) ||
      (!pending.archiveRemoved && !value.backups.some((item) => item.path === pending.receipt.path && item.sha256 === pending.receipt.sha256))) {
      throw new Error('The pending automatic backup retirement is invalid. Existing files were kept.')
    }
  }
  return value
}

async function syncDirectory(folder: string) {
  const handle = await fs.open(folder, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function checkedOpen(file: string) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) throw new Error('Automatic backup file identity checks are unavailable on this platform.')
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    identity(await handle.stat({ bigint: true }))
    return handle
  } catch (error) { await handle.close(); throw error }
}
async function digestHandle(handle: FileHandle, signal?: AbortSignal) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream('', { fd: handle.fd, start: 0, autoClose: false })) {
    signal?.throwIfAborted()
    hash.update(chunk); bytes += chunk.length
  }
  signal?.throwIfAborted()
  return { sha256: hash.digest('hex'), bytes }
}
async function inspect(file: string, expected?: AutomaticBackupReceipt, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const handle = await checkedOpen(file)
  try {
    const before = await handle.stat({ bigint: true })
    const foundIdentity = identity(before)
    const digest = await digestHandle(handle, signal)
    const after = await handle.stat({ bigint: true })
    const named = await fs.lstat(file, { bigint: true })
    if (!sameIdentity(foundIdentity, identity(after)) || !sameIdentity(foundIdentity, identity(named)) ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || digest.bytes !== Number(after.size) ||
      (expected && (!sameIdentity(foundIdentity, expected.identity) || digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256))) {
      throw new BackupIdentityChangedError('The backup file identity or contents changed. It was left untouched.')
    }
    return { identity: foundIdentity, ...digest }
  } finally { await handle.close() }
}
async function exists(file: string) {
  try { await fs.lstat(file); return true }
  catch (error) { if (code(error) === 'ENOENT') return false; throw error }
}

export async function readAutomaticBackupLedger(ledgerPath: string): Promise<AutomaticBackupLedger | null> {
  if (!absolute(ledgerPath)) throw new Error('The automatic backup ledger path is invalid.')
  let handle: FileHandle
  try { handle = await checkedOpen(ledgerPath) }
  catch (error) { if (code(error) === 'ENOENT') return null; throw error }
  try {
    if ((await handle.stat()).size > LEDGER_MAX_BYTES) throw new Error('The automatic backup ledger is too large to read safely.')
    const bytes = await handle.readFile()
    if (bytes.length > LEDGER_MAX_BYTES) throw new Error('The automatic backup ledger is too large to read safely.')
    return validateLedger(JSON.parse(bytes.toString('utf8')) as AutomaticBackupLedger)
  } finally { await handle.close() }
}
async function saveLedger(ledgerPath: string, ledger: AutomaticBackupLedger) {
  validateLedger(ledger)
  const encoded = Buffer.from(`${JSON.stringify(ledger)}\n`)
  if (encoded.length > LEDGER_MAX_BYTES) throw new Error('The automatic backup ledger is too large to save safely.')
  const temporary = `${ledgerPath}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  let created: AutomaticBackupIdentity | null = null
  try {
    try {
      created = identity(await handle.stat({ bigint: true }))
      await handle.writeFile(encoded)
      await handle.sync()
    } finally { await handle.close() }
    await fs.rename(temporary, ledgerPath)
    await syncDirectory(path.dirname(ledgerPath))
  } finally {
    const named = await fs.lstat(temporary, { bigint: true }).catch((error) => { if (code(error) === 'ENOENT') return null; throw error })
    if (created && named?.isFile() && sameIdentity(created, identity(named))) await fs.unlink(temporary)
  }
}
function under(candidate: string, root: string) { return candidate === root || candidate.startsWith(`${root}${path.sep}`) }
async function canonicalFolder(folder: string) {
  if (!absolute(folder)) throw new Error('The selected automatic backup folder is invalid.')
  // A selected missing folder is an error. The configuration owner alone creates the default.
  const stat = await fs.lstat(folder)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The selected automatic backup folder is not a plain directory.')
  const canonical = await fs.realpath(folder)
  const roots = [
    path.resolve(process.env.UPLOADS_DIR?.trim() || '../batshit-server/server/uploads'),
    path.resolve(process.env.BATSHIT_BACKUP_STAGING_DIR?.trim() || (process.env.BATSHIT_RUNTIME_DATA_DIR?.trim() ? path.join(process.env.BATSHIT_RUNTIME_DATA_DIR.trim(), 'backup-restore-staging') : '../batshit-server/server/data/backup-restore-staging')),
    resolveHostFileRoot('skills'), resolveHostFileRoot('voice-profiles')
  ]
  for (const root of roots) {
    const realRoot = await fs.realpath(root).catch((error) => { if (code(error) === 'ENOENT') return path.resolve(root); throw error })
    if (under(canonical, realRoot)) throw new Error('Automatic backups must be outside upload, skill, voice and restore-staging folders.')
  }
  return canonical
}
async function verifyFile(file: string, receipt: AutomaticBackupReceipt, userId: string, signal?: AbortSignal) {
  await inspect(file, receipt, signal)
  await verifyAutomaticBackupArchive(file, userId, signal)
  await inspect(file, receipt, signal)
}

async function reconcilePublication(ledgerPath: string, ledger: AutomaticBackupLedger, signal?: AbortSignal) {
  const pending = ledger.pendingPublication
  if (!pending) return
  const { receipt, temporaryPath } = pending
  if (await exists(receipt.path)) {
    await verifyFile(receipt.path, receipt, ledger.userId, signal)
  } else {
    await verifyFile(temporaryPath, receipt, ledger.userId, signal)
    signal?.throwIfAborted()
    // Hard-link publication is atomic and never overwrites a file, unlike rename().
    await fs.link(temporaryPath, receipt.path)
    await syncDirectory(receipt.folder)
    await inspect(receipt.path, receipt, signal)
  }
  await syncDirectory(receipt.folder)
  signal?.throwIfAborted()
  if (!ledger.backups.some((item) => item.path === receipt.path)) ledger.backups.unshift(receipt)
  // Keep the pending identity through temporary-link removal: a crash at either side of
  // this ledger write can reconcile the same two exact names without a directory scan.
  await saveLedger(ledgerPath, ledger)
  if (await exists(temporaryPath)) {
    await inspect(temporaryPath, receipt, signal)
    await fs.unlink(temporaryPath)
    await syncDirectory(receipt.folder)
  }
  ledger.pendingPublication = null
  await saveLedger(ledgerPath, ledger)
}

async function preservePreviousPublication(ledgerPath: string, ledger: AutomaticBackupLedger, folder: string) {
  const pending = ledger.pendingPublication
  if (!pending || pending.receipt.folder === folder) return
  const warning = 'An unfinished publication in the previous backup folder was left untouched after the folder changed; this recorded path may not have been published.'
  for (const namedPath of [pending.receipt.path, pending.temporaryPath]) {
    ledger.preservedFiles.push({ path: namedPath, originalPath: pending.receipt.path, message: warning })
  }
  ledger.pendingPublication = null
  await saveLedger(ledgerPath, ledger)
}

async function inspectActiveReceipt(ledgerPath: string, ledger: AutomaticBackupLedger, receipt: AutomaticBackupReceipt, signal?: AbortSignal) {
  let observedPath = receipt.path
  try {
    const pending = ledger.pendingRetirement
    if (pending?.receipt.id === receipt.id && await exists(pending.quarantinePath)) observedPath = pending.quarantinePath
    await inspect(observedPath, receipt, signal)
    return true
  } catch (error) {
    signal?.throwIfAborted()
    const state = code(error) === 'ENOENT' ? 'missing' : error instanceof BackupIdentityChangedError || ['ELOOP', 'ENOTDIR'].includes(code(error) ?? '') ? 'changed' : 'unreadable'
    const failure = state === 'missing' ? 'This previously completed backup is missing.' : state === 'changed' ? 'This previously completed backup changed and was left untouched.' : `This previously completed backup could not be verified and was left untouched: ${message(error)}`
    ledger.backups = ledger.backups.filter((item) => item.id !== receipt.id)
    ledger.unavailableReceipts.push({ receipt, path: observedPath, state, message: failure })
    if (ledger.pendingRetirement?.receipt.id === receipt.id) ledger.pendingRetirement = null
    ledger.cleanupFailures.push({ path: observedPath, message: failure })
    await saveLedger(ledgerPath, ledger)
    return false
  }
}

async function recoverUnexpectedRetirement(ledgerPath: string, ledger: AutomaticBackupLedger, pending: Retirement, failure: unknown) {
  const { receipt, quarantinePath } = pending
  let preservedPath = quarantinePath
  // Never overwrite an occupied original name, even when the quarantined file is foreign.
  try {
    await fs.link(quarantinePath, receipt.path)
    await syncDirectory(receipt.folder)
    await fs.unlink(quarantinePath)
    await syncDirectory(path.dirname(quarantinePath))
    preservedPath = receipt.path
  } catch { /* The exact quarantine name remains an explicit recovery path. */ }
  ledger.backups = ledger.backups.filter((item) => item.path !== receipt.path)
  ledger.preservedFiles.push({ path: preservedPath, originalPath: receipt.path, message: message(failure) })
  ledger.pendingRetirement = null
  ledger.cleanupFailures.push({ path: preservedPath, message: `A changed file was preserved: ${message(failure)}` })
  await saveLedger(ledgerPath, ledger)
}
async function checkQuarantineDirectory(pending: Retirement) {
  const stat = await fs.lstat(path.dirname(pending.quarantinePath), { bigint: true })
  if (!sameIdentity(directoryIdentity(stat), pending.directoryIdentity) || (Number(stat.mode) & 0o777) !== 0o700) {
    throw new Error('The private backup retirement directory changed. All remaining files were preserved.')
  }
}
async function finishRetirement(ledgerPath: string, ledger: AutomaticBackupLedger, signal?: AbortSignal) {
  const pending = ledger.pendingRetirement
  if (!pending) return
  const { receipt, quarantinePath } = pending
  signal?.throwIfAborted()
  if (!await exists(quarantinePath) && !await exists(receipt.path) && !pending.archiveRemoved) {
    // A crash may have followed unlink. Make that removal durable before forgetting its
    // custody; keep the separate directory-cleanup journal until the empty folder settles.
    if (await exists(path.dirname(quarantinePath))) {
      await checkQuarantineDirectory(pending)
      await syncDirectory(path.dirname(quarantinePath))
    }
    await syncDirectory(receipt.folder)
    pending.archiveRemoved = true
    ledger.backups = ledger.backups.filter((item) => item.path !== receipt.path)
    await saveLedger(ledgerPath, ledger)
  }
  if (pending.archiveRemoved) {
    if (await exists(quarantinePath)) throw new Error('A file appeared in a completed retirement location. It was preserved.')
    if (await exists(path.dirname(quarantinePath))) {
      await checkQuarantineDirectory(pending)
      await fs.rmdir(path.dirname(quarantinePath))
    }
    await syncDirectory(receipt.folder)
    ledger.pendingRetirement = null
    await saveLedger(ledgerPath, ledger)
    return
  }
  await checkQuarantineDirectory(pending)
  if (!await exists(quarantinePath)) {
    // The owned quarantine folder was created before the journal, on this same volume.
    await inspect(receipt.path, receipt, signal)
    await checkQuarantineDirectory(pending)
    signal?.throwIfAborted()
    await fs.rename(receipt.path, quarantinePath)
    await syncDirectory(receipt.folder)
    await syncDirectory(path.dirname(quarantinePath))
  }
  try { await inspect(quarantinePath, receipt, signal) }
  catch (error) { signal?.throwIfAborted(); await recoverUnexpectedRetirement(ledgerPath, ledger, pending, error); return }
  await checkQuarantineDirectory(pending)
  signal?.throwIfAborted()
  await fs.unlink(quarantinePath)
  await syncDirectory(path.dirname(quarantinePath))
  pending.archiveRemoved = true
  ledger.backups = ledger.backups.filter((item) => item.path !== receipt.path)
  await saveLedger(ledgerPath, ledger)
  await finishRetirement(ledgerPath, ledger, signal)
}

async function prune(ledgerPath: string, ledger: AutomaticBackupLedger, folder: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  ledger.cleanupFailures = [...ledger.preservedFiles.map((item) => ({ path: item.path, message: item.message })),
    ...ledger.unavailableReceipts.map((item) => ({ path: item.path, message: item.message }))]
  const previousUnavailableCount = ledger.unavailableReceipts.length
  for (const receipt of ledger.backups.filter((item) => item.folder === folder)) {
    if (ledger.pendingRetirement?.receipt.id === receipt.id && ledger.pendingRetirement.archiveRemoved) continue
    await inspectActiveReceipt(ledgerPath, ledger, receipt, signal)
  }
  // An I/O failure is uncertainty, not permission to rotate any existing recovery copy.
  if (ledger.unavailableReceipts.slice(previousUnavailableCount).some((item) => item.receipt.folder === folder && item.state === 'unreadable')) {
    await saveLedger(ledgerPath, ledger)
    return
  }
  if (ledger.pendingRetirement) {
    // Only the current configured folder is ever retired. A folder change preserves the old one.
    if (ledger.pendingRetirement.receipt.folder !== folder) {
      const pending = ledger.pendingRetirement
      const preservedPath = pending.archiveRemoved ? path.dirname(pending.quarantinePath) : await exists(pending.quarantinePath) ? pending.quarantinePath : pending.receipt.path
      const preserved = { path: preservedPath, originalPath: pending.receipt.path, message: 'An unfinished cleanup in the previous backup folder was preserved after the folder changed.' }
      ledger.preservedFiles.push(preserved)
      ledger.cleanupFailures.push({ path: preserved.path, message: preserved.message })
      ledger.backups = ledger.backups.filter((item) => item.path !== pending.receipt.path)
      ledger.pendingRetirement = null
      await saveLedger(ledgerPath, ledger)
    } else {
      try {
        if (!ledger.pendingRetirement.archiveRemoved && ledger.backups.filter((item) => item.folder === folder && item.id !== ledger.pendingRetirement!.receipt.id).length < 2) {
          ledger.cleanupFailures.push({ path: ledger.pendingRetirement.quarantinePath, message: 'Retirement is held because two other recovery copies could not be verified. The recorded copy remains at its current path.' })
          await saveLedger(ledgerPath, ledger)
          return
        }
        for (const kept of ledger.backups.filter((item) => item.folder === folder && item.id !== ledger.pendingRetirement!.receipt.id).slice(0, 2)) {
          if (!await inspectActiveReceipt(ledgerPath, ledger, kept, signal)) return
        }
        await finishRetirement(ledgerPath, ledger, signal)
      } catch (error) {
        signal?.throwIfAborted()
        ledger.cleanupFailures.push({ path: ledger.pendingRetirement?.quarantinePath ?? folder, message: message(error) })
        await saveLedger(ledgerPath, ledger)
        return
      }
    }
  }
  const current = ledger.backups.filter((item) => item.folder === folder)
  for (const receipt of current.slice(2)) {
    try {
      // Verify the two replacements again before any deletion, including a restart retry.
      for (const kept of ledger.backups.filter((item) => item.folder === folder).slice(0, 2)) {
        if (!await inspectActiveReceipt(ledgerPath, ledger, kept, signal)) return
      }
      if (!await inspectActiveReceipt(ledgerPath, ledger, receipt, signal)) return
      signal?.throwIfAborted()
      const quarantineFolder = path.join(folder, `.batshit-retire-${randomUUID()}`)
      await fs.mkdir(quarantineFolder, { mode: 0o700 })
      await syncDirectory(folder)
      ledger.pendingRetirement = { receipt, quarantinePath: path.join(quarantineFolder, path.basename(receipt.path)), directoryIdentity: directoryIdentity(await fs.lstat(quarantineFolder, { bigint: true })) }
      await saveLedger(ledgerPath, ledger)
      await finishRetirement(ledgerPath, ledger, signal)
    } catch (error) {
      signal?.throwIfAborted()
      ledger.cleanupFailures.push({ path: receipt.path, message: message(error) })
      await saveLedger(ledgerPath, ledger)
      break
    }
  }
  await saveLedger(ledgerPath, ledger)
}

function resultFor(ledger: AutomaticBackupLedger, receipt: AutomaticBackupReceipt, folder: string): AutomaticBackupStorageResult
function resultFor(ledger: AutomaticBackupLedger, receipt: AutomaticBackupReceipt | undefined, folder: string): AutomaticBackupRecoveryResult
function resultFor(ledger: AutomaticBackupLedger, receipt: AutomaticBackupReceipt | undefined, folder: string): AutomaticBackupRecoveryResult {
  const preserved = new Map<string, number>()
  for (const item of ledger.backups) if (item.folder !== folder) preserved.set(item.folder, (preserved.get(item.folder) ?? 0) + 1)
  return {
    ...(receipt ? { receipt } : {}),
    retained: ledger.backups.filter((item) => item.folder === folder),
    cleanupFailures: [...ledger.cleanupFailures],
    preservedFolders: Array.from(preserved, ([preservedFolder, backupCount]) => ({ folder: preservedFolder, backupCount }))
  }
}

/**
 * Settle named interrupted work before cadence/update decisions. This never exports a new
 * archive: a recent active receipt may still have pending publication/directory cleanup,
 * and recovering it must not rotate the pre-update copy with a second same-update export.
 */
export async function recoverAutomaticBackups(options: {
  folder: string
  ledgerPath: string
  userId: string
  signal?: AbortSignal
}): Promise<AutomaticBackupRecoveryResult> {
  if (!absolute(options.ledgerPath) || !options.userId) throw new Error('Automatic backup recovery ownership is invalid.')
  if (flights.has(options.ledgerPath)) throw new Error('An automatic backup is already running.')
  flights.add(options.ledgerPath)
  try {
    options.signal?.throwIfAborted()
    const folder = await canonicalFolder(options.folder)
    const ledger = await readAutomaticBackupLedger(options.ledgerPath)
    if (!ledger) return { retained: [], cleanupFailures: [], preservedFolders: [] }
    if (ledger.userId !== options.userId) throw new Error('This automatic backup ledger belongs to another user. Existing files were kept.')
    const physicalLedgerPath = path.join(await fs.realpath(path.dirname(options.ledgerPath)), path.basename(options.ledgerPath))
    if (under(physicalLedgerPath, folder)) throw new Error('Automatic backup custody must be outside the backup destination.')
    await preservePreviousPublication(options.ledgerPath, ledger, folder)
    await reconcilePublication(options.ledgerPath, ledger, options.signal)
    await prune(options.ledgerPath, ledger, folder, options.signal)
    options.signal?.throwIfAborted()
    return resultFor(ledger, ledger.backups.find((item) => item.folder === folder), folder)
  } finally { flights.delete(options.ledgerPath) }
}

/** One caller owns cadence/update coalescing; this extra guard refuses same-ledger overlap. */
export async function createAutomaticBackup(options: {
  folder: string
  ledgerPath: string
  userId: string
  provenance: AutomaticBackupProvenance
  signal?: AbortSignal
}): Promise<AutomaticBackupStorageResult> {
  if (!absolute(options.ledgerPath) || !options.userId || !validProvenance(options.provenance)) throw new Error('Automatic backup ownership or provenance is invalid.')
  if (flights.has(options.ledgerPath)) throw new Error('An automatic backup is already running.')
  flights.add(options.ledgerPath)
  let temporaryPath: string | null = null
  let temporaryIdentity: AutomaticBackupIdentity | null = null
  let journaled = false
  try {
    options.signal?.throwIfAborted()
    const folder = await canonicalFolder(options.folder)
    if (under(options.ledgerPath, folder)) throw new Error('Automatic backup custody must be outside the backup destination.')
    const createdStateFolder = await fs.mkdir(path.dirname(options.ledgerPath), { recursive: true, mode: 0o700 })
    if (createdStateFolder) await syncDirectory(path.dirname(createdStateFolder))
    const physicalLedgerPath = path.join(await fs.realpath(path.dirname(options.ledgerPath)), path.basename(options.ledgerPath))
    if (under(physicalLedgerPath, folder)) throw new Error('Automatic backup custody must be outside the backup destination.')
    let ledger = await readAutomaticBackupLedger(options.ledgerPath)
    if (ledger && ledger.userId !== options.userId) throw new Error('This automatic backup ledger belongs to another user. Existing files were kept.')
    ledger ??= { contract: CONTRACT, ownerId: randomUUID(), userId: options.userId, backups: [], pendingPublication: null, pendingRetirement: null, cleanupFailures: [], preservedFiles: [], unavailableReceipts: [] }
    await preservePreviousPublication(options.ledgerPath, ledger, folder)
    const recovered = ledger.pendingPublication?.receipt
    await reconcilePublication(options.ledgerPath, ledger, options.signal)
    if (recovered?.folder === folder) {
      // An interrupted run already captured its scheduled/update data. Creating another
      // archive here could rotate away the pre-update copy during this same catch-up.
      await prune(options.ledgerPath, ledger, folder, options.signal)
      if (!ledger.backups.some((item) => item.id === recovered.id)) throw new Error('The recovered automatic backup could not remain verified. Existing recovery copies were kept.')
      return resultFor(ledger, recovered, folder)
    }
    const id = randomUUID()
    const finalPath = path.join(folder, `batshit-automatic-backup-${id}.zip`)
    temporaryPath = `${finalPath}.${ledger.ownerId}.tmp`
    const handle = await fs.open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    temporaryIdentity = identity(await handle.stat({ bigint: true }))
    let bundle: Awaited<ReturnType<typeof createBackupBundleStream>> | null = null
    let streamFailed = false
    try {
      bundle = await createBackupBundleStream(options.userId, { includeSecrets: false, strictInventory: true })
      // The stream owns this FileHandle, including failure cleanup. flush waits for fsync
      // before close; pipeline waits for both. Never hand a bare fd to a failing stream:
      // it can close behind FileHandle and let a later close mask the primary error.
      await pipeline(Readable.fromWeb(bundle.stream as import('node:stream/web').ReadableStream<Uint8Array>), handle.createWriteStream({ autoClose: true, flush: true }), { signal: options.signal })
    } catch (error) {
      streamFailed = true
      if (bundle && !bundle.stream.locked) await bundle.stream.cancel().catch(() => undefined)
      throw error
    } finally {
      try { await handle.close() }
      catch (error) { if (!streamFailed) throw error }
    }
    options.signal?.throwIfAborted()
    await verifyAutomaticBackupArchive(temporaryPath, options.userId, options.signal)
    const checked = await inspect(temporaryPath, undefined, options.signal)
    options.signal?.throwIfAborted()
    if (!sameIdentity(checked.identity, temporaryIdentity)) throw new Error('The temporary automatic backup was replaced. Existing files were kept.')
    const receipt: AutomaticBackupReceipt = { id, path: finalPath, folder, createdAt: new Date().toISOString(), ...checked, provenance: { ...options.provenance } }
    await syncDirectory(folder)
    options.signal?.throwIfAborted()
    ledger.pendingPublication = { receipt, temporaryPath }
    journaled = true
    try { await saveLedger(options.ledgerPath, ledger) }
    catch (error) {
      // Filesystem calls have settled. A lost rename answer can still have published this
      // exact pending receipt; read back once before deciding whether the full temp is ours
      // to discard. Unreadable/uncertain custody retains the bytes and names their path.
      try {
        const settled = await readAutomaticBackupLedger(options.ledgerPath)
        if (!settled?.backups.some((item) => item.id === receipt.id) && settled?.pendingPublication?.receipt.id !== receipt.id) journaled = false
      } catch { /* Unknown custody is not deletion authority. */ }
      if (journaled) throw new Error(`${message(error)} Unconfirmed automatic backup data was kept at ${temporaryPath}.`, { cause: error })
      throw error
    }
    await reconcilePublication(options.ledgerPath, ledger, options.signal)
    await prune(options.ledgerPath, ledger, folder, options.signal)
    options.signal?.throwIfAborted()
    if (!ledger.backups.some((item) => item.id === receipt.id)) throw new Error('The new automatic backup could not remain verified. Existing recovery copies were kept.')
    return resultFor(ledger, receipt, folder)
  } finally {
    if (!journaled && temporaryPath && temporaryIdentity) {
      // Remove only the temporary inode this call created, never a replacement at its name.
      const stat = await fs.lstat(temporaryPath, { bigint: true }).catch(() => null)
      if (stat?.isFile() && sameIdentity(identity(stat), temporaryIdentity)) await fs.unlink(temporaryPath).catch(() => undefined)
    }
    flights.delete(options.ledgerPath)
  }
}

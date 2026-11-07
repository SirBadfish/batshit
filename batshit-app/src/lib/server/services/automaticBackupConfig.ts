import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { getBatshitHomeDir } from './batshitHome'
import { resolveHostFileRoot } from './backupHostFiles'
import type { AutomaticBackupConfig } from '$lib/types/automaticBackup'

/** Instance consent/status never travel in an archive, import or rollback. Restore keeps this
 * instance's settings and files. There is no account-delete API; deleting the lane deletes them.
 * Owner: this service; human Admin route is the only writer. */
export const AUTOMATIC_BACKUP_CONFIG_KEY = 'batshit:automatic_backup_config'
export const AUTOMATIC_BACKUP_STATUS_KEY = 'batshit:automatic_backup_status'

export class AutomaticBackupError extends Error {
  constructor(message: string, readonly status = 500) { super(message) }
}

export function automaticBackupPaths() {
  const runtime = process.env.BATSHIT_RUNTIME_DATA_DIR?.trim()
  const container = process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
  const root = runtime ? path.resolve(runtime) : container ? getBatshitHomeDir() : path.resolve(process.cwd(), '../batshit-server/server/data')
  return {
    defaultFolder: path.join(root, 'automatic-backups'),
    ledgerPath: path.join(root, 'automatic-backup-state', 'ledger.json')
  }
}

export function defaultAutomaticBackupConfig(userId: string): AutomaticBackupConfig {
  return { revision: 'none', ownerUserId: userId, enabled: false, cadence: 'daily', folder: null, afterUpdates: false, enabledAt: null }
}

function validConfig(value: unknown): value is AutomaticBackupConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as AutomaticBackupConfig
  return typeof v.revision === 'string' && typeof v.ownerUserId === 'string' &&
    typeof v.enabled === 'boolean' && (v.cadence === 'daily' || v.cadence === 'weekly') &&
    (v.folder === null || (typeof v.folder === 'string' && path.isAbsolute(v.folder))) &&
    typeof v.afterUpdates === 'boolean' && (v.enabledAt === null || (typeof v.enabledAt === 'string' && Number.isFinite(Date.parse(v.enabledAt))))
}

export async function readAutomaticBackupConfig(userId: string): Promise<AutomaticBackupConfig> {
  return redis.execute(async client => {
    const value = await client.json.get(AUTOMATIC_BACKUP_CONFIG_KEY)
    if (value === null) return defaultAutomaticBackupConfig(userId)
    if (!validConfig(value)) throw new AutomaticBackupError('Automatic backup settings could not be read. Existing backup files were kept.')
    if (value.ownerUserId !== userId) throw new AutomaticBackupError('Automatic backup settings belong to a different account on this instance.', 409)
    return value
  })
}

function overlaps(left: string, right: string) {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep)
}

async function canonicalExistingOrParent(folder: string): Promise<string> {
  try { return await fs.realpath(folder) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(folder)
    if (parent === folder) throw error
    return path.join(await canonicalExistingOrParent(parent), path.basename(folder))
  }
}

export function resolveAutomaticBackupDestination(config: AutomaticBackupConfig): Promise<string> {
  return canonicalExistingOrParent(config.folder ?? automaticBackupPaths().defaultFolder)
}

/** Validate again at execution. A removed chosen folder is a failure, never a default fallback. */
export async function validateAutomaticBackupFolder(folder: string, allowCreate = false) {
  if (!path.isAbsolute(folder) || folder.includes('\0') || folder.length > 4096) {
    throw new AutomaticBackupError('Choose an absolute folder path on the computer running Batshit.', 400)
  }
  const selected = await canonicalExistingOrParent(path.resolve(folder))
  const paths = automaticBackupPaths()
  const uploads = path.resolve(process.env.UPLOADS_DIR?.trim() || '../batshit-server/server/uploads')
  const staging = path.resolve(process.env.BATSHIT_BACKUP_STAGING_DIR?.trim() ||
    (process.env.BATSHIT_RUNTIME_DATA_DIR ? path.join(process.env.BATSHIT_RUNTIME_DATA_DIR, 'backup-restore-staging') : '../batshit-server/server/data/backup-restore-staging'))
  for (const input of [uploads, staging, resolveHostFileRoot('skills'), resolveHostFileRoot('voice-profiles'), path.dirname(paths.ledgerPath)]) {
    if (overlaps(selected, await canonicalExistingOrParent(input))) {
      throw new AutomaticBackupError('Keep automatic backups outside Batshit upload, skill, voice, restore and backup-state folders.', 400)
    }
  }
  if (allowCreate) await fs.mkdir(selected, { recursive: true, mode: 0o700 })
  const node = await fs.lstat(selected)
  if (!node.isDirectory() || node.isSymbolicLink()) throw new AutomaticBackupError('The backup destination must be a folder.', 400)
  await fs.access(selected, fs.constants.W_OK | fs.constants.R_OK)
  return selected
}

/** Raw JSON equality is checked atomically; a stale/unknown save never overwrites a newer choice. */
export const SAVE_AUTOMATIC_BACKUP_CONFIG = `
local current = redis.call('JSON.GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
return 1
`

export async function saveAutomaticBackupConfig(userId: string, body: unknown): Promise<AutomaticBackupConfig> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AutomaticBackupError('Invalid automatic backup settings.', 400)
  const b = body as Record<string, unknown>
  if (Object.keys(b).some(k => !['expectedRevision', 'enabled', 'cadence', 'folder', 'afterUpdates'].includes(k)) ||
    typeof b.expectedRevision !== 'string' || typeof b.enabled !== 'boolean' ||
    (b.cadence !== 'daily' && b.cadence !== 'weekly') || typeof b.afterUpdates !== 'boolean' ||
    !(b.folder === null || typeof b.folder === 'string')) throw new AutomaticBackupError('Invalid automatic backup settings.', 400)
  let folder = typeof b.folder === 'string' ? b.folder.trim() : null
  if (folder !== null && (!folder || !path.isAbsolute(folder) || folder.includes('\0'))) {
    throw new AutomaticBackupError('Choose an absolute folder path, or use the default folder.', 400)
  }
  const previous = await readAutomaticBackupConfig(userId)
  if (previous.revision !== b.expectedRevision) throw new AutomaticBackupError('Automatic backup settings changed. Load the saved settings before saving again.', 409)
  if (b.enabled) {
    const selected = await validateAutomaticBackupFolder(folder ?? automaticBackupPaths().defaultFolder,
      folder === null && (!previous.enabled || previous.folder !== null))
    if (folder !== null) folder = selected
  }
  return redis.execute(async client => {
    const raw = await client.sendCommand(['JSON.GET', AUTOMATIC_BACKUP_CONFIG_KEY]) as string | null
    const current = raw === null ? defaultAutomaticBackupConfig(userId) : JSON.parse(raw)
    if (!validConfig(current) || current.ownerUserId !== userId) throw new AutomaticBackupError('Automatic backup settings could not be confirmed.', 409)
    if (current.revision !== b.expectedRevision) throw new AutomaticBackupError('Automatic backup settings changed in another window. Load the saved settings before saving again.', 409)
    const next: AutomaticBackupConfig = {
      revision: randomUUID(), ownerUserId: userId, enabled: b.enabled as boolean,
      cadence: b.cadence as 'daily' | 'weekly', folder, afterUpdates: b.afterUpdates as boolean,
      enabledAt: b.enabled && (!current.enabled || current.folder !== folder) ? new Date().toISOString() : current.enabledAt
    }
    const saved = await client.eval(SAVE_AUTOMATIC_BACKUP_CONFIG, {
      keys: [AUTOMATIC_BACKUP_CONFIG_KEY], arguments: [raw ?? '', JSON.stringify(next)]
    })
    if (saved !== 1) throw new AutomaticBackupError('Automatic backup settings changed. Load the saved settings before saving again.', 409)
    return next
  })
}

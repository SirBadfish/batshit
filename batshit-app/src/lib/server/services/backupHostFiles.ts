import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

import { getSkillCacheRoot } from '$lib/server/services/skillRegistry'
import { getManagedVoiceProfileStorageRoot } from '$lib/server/services/voiceProfileRecords'

/**
 * BL-373 / BL-369: host files in the backup archive.
 *
 * Two kinds of user data live outside Redis and outside the upload store, in folders under the
 * Batshit home folder: a user skill's files (`~/.batshit/skills/{skillId}/`, the ONLY copy of its
 * text: Redis keeps metadata) and a clone voice's reference recording
 * (`~/.batshit/voice-profiles/{profileId}/`). A backup carries them as
 * `files/host/{root}/{folder}/{path}`.
 *
 * What is carried follows the exported records and never walks a whole root, and the roots
 * come from their owners' own resolvers, so a later home-folder override (BL-342) changes one
 * place. A folder that cannot be carried whole (missing, a symbolic link inside, over a limit)
 * is left out whole and listed in the manifest, never half-carried, and it never stops the
 * backup (unlike a missing upload, BL-378): the rest of the user's data still gets saved.
 */

export const HOST_FILE_ZIP_ROOT = 'files/host/'

const MIB = 1024 * 1024

/**
 * The one place the host-file limits live (UserDocs `admin/backup-and-restore.md` quotes them).
 * A folder over a limit is not carried at export and is refused at restore: a backup Batshit
 * made never carries one, so an archive that does was not made by Batshit.
 */
export const HOST_FILE_LIMITS = Object.freeze({
  maxFileBytes: 100 * MIB,
  maxFolderBytes: 500 * MIB,
  maxFolderFiles: 2000
})

export const HOST_FILE_ROOT_IDS = ['skills', 'voice-profiles'] as const
export type HostFileRootId = (typeof HOST_FILE_ROOT_IDS)[number]

export type HostFolderNotCarriedReason =
  | 'missing'
  | 'unreadable'
  | 'changed'
  | 'recording-missing'
  | 'symlink'
  | 'not-a-regular-file'
  | 'unsafe-name'
  | 'too-large'
  | 'too-many-files'
  | 'outside-root'
  | 'host-only'

export interface HostFolderRef {
  root: HostFileRootId
  folder: string
  /** The Redis record the folder belongs to (`skill:{userId}:{id}` or `voice_profile:{id}`). */
  ownerKey: string
  label: string
  /** A file the folder must hold for the owner to work (a clone voice's recording). */
  requiredFile?: string
}

export interface HostFolderNotCarried {
  root: HostFileRootId
  folder: string
  ownerKey: string
  label: string
  reason: HostFolderNotCarriedReason
}

export interface HostFileExportAsset {
  root: HostFileRootId
  folder: string
  /** POSIX path inside the folder. */
  relativePath: string
  zipPath: string
  sourcePath: string
  byteLength: number
  /** The file the walk saw (lstat); the export streams it only if the opened file is the same one. */
  device: string
  inode: string
}

export interface HostFolderExport extends HostFolderRef {
  files: HostFileExportAsset[]
}

export function isHostFileRootId(value: unknown): value is HostFileRootId {
  return typeof value === 'string' && (HOST_FILE_ROOT_IDS as readonly string[]).includes(value)
}

export function resolveHostFileRoot(root: HostFileRootId): string {
  return path.resolve(root === 'skills' ? getSkillCacheRoot() : getManagedVoiceProfileStorageRoot())
}

/**
 * A folder name is one plain path segment: letters, digits, `_`, `-`, `.`, never starting with
 * a dot (the restore's own `.restore-new-*` / `.restore-old-*` folders sit beside them).
 */
export function isSafeHostFolderName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/.test(name)
}

export function hostFolderKey(root: HostFileRootId, folder: string) {
  return `${root}/${folder}`
}

export function hostFileZipPath(root: HostFileRootId, folder: string, relativePath: string) {
  return `${HOST_FILE_ZIP_ROOT}${root}/${folder}/${relativePath}`
}

/** `files/host/{root}/{folder}/{path}` split into its parts, or null for a malformed name. */
export function parseHostFileZipPath(name: string): { root: string; folder: string; relativePath: string } | null {
  if (!name.startsWith(HOST_FILE_ZIP_ROOT)) return null
  const parts = name.slice(HOST_FILE_ZIP_ROOT.length).split('/')
  if (parts.length < 3) return null
  const [root, folder, ...rest] = parts
  return { root, folder, relativePath: rest.join('/') }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function labelOf(value: Record<string, unknown>, fallback: string) {
  for (const field of ['displayName', 'name']) {
    const candidate = value[field]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return fallback
}

/** A skill that is not built into Batshit keeps its only copy of its text in its folder. */
export function isUserSkillRecordValue(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && value.is_system !== true && value.source !== 'system'
}

export function managedReferenceAudioPathOf(value: unknown): string | null {
  if (!isPlainObject(value) || !isPlainObject(value.settings)) return null
  const candidate = value.settings.batshitManagedReferenceAudioPath
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

/**
 * The host folders a backup of these records should carry. Skills: every exported user skill.
 * Voice: every exported clone voice whose managed recording sits in `{voiceRoot}/{profileId}/`.
 */
export function hostFolderRefsFromRecords(
  records: ReadonlyArray<{ key: string; value: unknown }>,
  userId: string,
  options: { containerized: boolean }
): { refs: HostFolderRef[]; notCarried: HostFolderNotCarried[] } {
  const refs: HostFolderRef[] = []
  const notCarried: HostFolderNotCarried[] = []
  const skillPrefix = `skill:${userId}:`

  for (const record of records) {
    if (record.key.startsWith(skillPrefix)) {
      if (!isUserSkillRecordValue(record.value)) continue
      // The registry keys a skill by its id and names its folder by the same id; a record whose
      // id disagrees with its key is not carried (a restore checks the folder against the key).
      const folder = record.key.slice(skillPrefix.length)
      const ref = { root: 'skills' as const, folder, ownerKey: record.key, label: labelOf(record.value, folder) }
      const idMatches = record.value.id === undefined || record.value.id === folder
      if (!isSafeHostFolderName(folder) || !idMatches) notCarried.push({ ...ref, reason: 'unsafe-name' })
      else refs.push(ref)
      continue
    }

    if (record.key.startsWith('voice_profile:')) {
      const audioPath = managedReferenceAudioPathOf(record.value)
      if (!audioPath || !isPlainObject(record.value)) continue
      const folder = record.key.slice('voice_profile:'.length)
      const ref = {
        root: 'voice-profiles' as const,
        folder,
        ownerKey: record.key,
        label: labelOf(record.value, folder)
      }
      // In Docker the recording is on the HOST, written there by the host operator, and the
      // app container cannot read it (round 2 with the operator's owner).
      if (options.containerized) {
        notCarried.push({ ...ref, reason: 'host-only' })
        continue
      }
      if (!isSafeHostFolderName(folder)) {
        notCarried.push({ ...ref, reason: 'unsafe-name' })
        continue
      }
      const relative = path.relative(resolveHostFileRoot('voice-profiles'), path.resolve(audioPath))
      const segments = relative.split(path.sep)
      if (path.isAbsolute(relative) || segments.length !== 2 || segments[0] !== folder || !segments[1]) {
        notCarried.push({ ...ref, reason: 'outside-root' })
        continue
      }
      refs.push({ ...ref, requiredFile: segments[1] })
    }
  }

  return { refs, notCarried }
}

type FolderWalk =
  | { ok: true; files: HostFileExportAsset[] }
  | { ok: false; reason: HostFolderNotCarriedReason }

async function walkFolder(ref: HostFolderRef, rootPath: string): Promise<FolderWalk> {
  const folderPath = path.join(rootPath, ref.folder)
  let folderStat
  try {
    folderStat = await fs.lstat(folderPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' }
    throw error
  }
  if (folderStat.isSymbolicLink()) return { ok: false, reason: 'symlink' }
  if (!folderStat.isDirectory()) return { ok: false, reason: 'not-a-regular-file' }

  const files: HostFileExportAsset[] = []
  let totalBytes = 0
  const pending: string[] = ['']
  while (pending.length > 0) {
    const relativeDir = pending.pop()!
    const entries = await fs.readdir(path.join(folderPath, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.name.includes('\\') || entry.name === '.' || entry.name === '..') {
        return { ok: false, reason: 'unsafe-name' }
      }
      const absolutePath = path.join(folderPath, relativePath)
      // lstat, never stat: a symbolic link is refused, not followed.
      const stat = await fs.lstat(absolutePath, { bigint: true })
      if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' }
      if (stat.isDirectory()) {
        pending.push(relativePath)
        continue
      }
      if (!stat.isFile()) return { ok: false, reason: 'not-a-regular-file' }
      const size = Number(stat.size)
      if (size > HOST_FILE_LIMITS.maxFileBytes) return { ok: false, reason: 'too-large' }
      totalBytes += size
      if (totalBytes > HOST_FILE_LIMITS.maxFolderBytes) return { ok: false, reason: 'too-large' }
      if (files.length + 1 > HOST_FILE_LIMITS.maxFolderFiles) return { ok: false, reason: 'too-many-files' }
      files.push({
        root: ref.root,
        folder: ref.folder,
        relativePath,
        zipPath: hostFileZipPath(ref.root, ref.folder, relativePath),
        sourcePath: absolutePath,
        byteLength: size,
        device: String(stat.dev),
        inode: String(stat.ino)
      })
    }
  }

  // The walk never follows a link, but a parent folder of the root could still resolve
  // elsewhere; each file must stay inside the folder's real path.
  const realFolder = await fs.realpath(folderPath)
  for (const file of files) {
    const realFile = await fs.realpath(file.sourcePath)
    if (!realFile.startsWith(`${realFolder}${path.sep}`)) return { ok: false, reason: 'symlink' }
  }

  if (ref.requiredFile && !files.some((file) => file.relativePath === ref.requiredFile)) {
    return { ok: false, reason: 'recording-missing' }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { ok: true, files }
}

/**
 * Walk each referenced folder. A folder is carried whole or not at all; one that cannot be
 * carried is reported with its reason and never stops the export.
 */
export async function collectHostFolderFiles(refs: HostFolderRef[]): Promise<{
  folders: HostFolderExport[]
  notCarried: HostFolderNotCarried[]
}> {
  const folders: HostFolderExport[] = []
  const notCarried: HostFolderNotCarried[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = hostFolderKey(ref.root, ref.folder)
    if (seen.has(key)) continue
    seen.add(key)
    let walk: FolderWalk
    try {
      walk = await walkFolder(ref, resolveHostFileRoot(ref.root))
    } catch (error) {
      // A folder Batshit cannot read (permissions, a folder that changed under the walk) is
      // reported like a missing one: one bad folder must not stop every backup (BL-378).
      if (typeof (error as NodeJS.ErrnoException)?.code !== 'string') throw error
      walk = { ok: false, reason: 'unreadable' }
    }
    if (walk.ok) folders.push({ ...ref, files: walk.files })
    else notCarried.push({ root: ref.root, folder: ref.folder, ownerKey: ref.ownerKey, label: ref.label, reason: walk.reason })
  }
  return { folders, notCarried }
}

/** The export ran out of file handles: an environment problem, never a folder's fault. */
export class HostFileHandlesExhaustedError extends Error {
  constructor(cause: unknown) {
    super(
      `Batshit ran out of open files while backing up skill and voice folders (${
        (cause as NodeJS.ErrnoException)?.code ?? 'unknown'
      }). Close other programs or raise the open-file limit, then export again.`
    )
    this.name = 'HostFileHandlesExhaustedError'
  }
}

function sameAsWalked(stat: import('node:fs').BigIntStats, file: HostFileExportAsset) {
  return (
    stat.isFile() &&
    Number(stat.size) === file.byteLength &&
    String(stat.dev) === file.device &&
    String(stat.ino) === file.inode
  )
}

/**
 * Open one host file with O_NOFOLLOW and check it is the plain file the walk saw (same device,
 * inode and size), or throw. The caller closes the handle. Running out of file handles throws
 * `HostFileHandlesExhaustedError`, never a "changed" folder.
 */
export async function openWalkedHostFile(file: HostFileExportAsset): Promise<FileHandle> {
  let handle: FileHandle
  try {
    handle = await fs.open(file.sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EMFILE' || code === 'ENFILE') throw new HostFileHandlesExhaustedError(error)
    throw error
  }
  try {
    if (!sameAsWalked(await handle.stat({ bigint: true }), file)) throw new Error('changed since the walk')
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/**
 * BL-373 review: before the first file of a folder is written, check every file in it is still
 * the plain file the walk saw, opening each with O_NOFOLLOW and closing it again (one handle at a
 * time, so a folder of 2,000 files never holds 2,000 handles). Answers null when the folder can be
 * carried, or the real reason it cannot: 'changed' (a file vanished, changed, or turned into a
 * link since the walk) or 'unreadable' (permissions). Running out of file handles throws.
 */
export async function checkHostFolderFiles(folder: HostFolderExport): Promise<HostFolderNotCarriedReason | null> {
  for (const file of folder.files) {
    try {
      const handle = await openWalkedHostFile(file)
      await handle.close()
    } catch (error) {
      if (error instanceof HostFileHandlesExhaustedError) throw error
      const code = (error as NodeJS.ErrnoException).code
      return code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'changed'
    }
  }
  return null
}

const REASON_TEXT: Record<HostFolderNotCarriedReason, string> = {
  missing: 'its folder was missing when the backup was made',
  unreadable: 'Batshit could not read its folder when the backup was made',
  changed: 'its files changed while the backup was being made',
  'recording-missing': 'its reference recording was missing when the backup was made',
  symlink: 'its folder holds a symbolic link, which a backup never follows',
  'not-a-regular-file': 'its folder holds something that is not a plain file',
  'unsafe-name': 'its folder or a file in it has a name a backup cannot carry safely',
  'too-large': `a file in it is over ${HOST_FILE_LIMITS.maxFileBytes / MIB} MiB or the folder is over ${HOST_FILE_LIMITS.maxFolderBytes / MIB} MiB`,
  'too-many-files': `its folder holds more than ${HOST_FILE_LIMITS.maxFolderFiles} files`,
  'outside-root': 'its recording is not in the voice profiles folder Batshit manages',
  'host-only': 'this backup came from Docker, where the recording lives on the host computer and Batshit cannot read it yet'
}

export function describeNotCarriedHostFolder(entry: HostFolderNotCarried) {
  const what = entry.root === 'skills' ? `Skill "${entry.label}"` : `Clone voice "${entry.label}"`
  const consequence =
    entry.root === 'skills'
      ? 'The skill comes back with its settings but without its files.'
      : 'The voice comes back without its recording.'
  return `${what} is not fully in this backup: ${REASON_TEXT[entry.reason]}. ${consequence}`
}

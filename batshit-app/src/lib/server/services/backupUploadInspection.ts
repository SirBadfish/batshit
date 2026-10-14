import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

/**
 * BL-378: the one read-only check of the upload files a backup must carry. The export, the
 * Admin "Check Upload Files" audit and (later) a partial backup all ask this function, so
 * they can never disagree about which files are missing. It only runs `stat`: it never
 * creates, moves, or deletes a file, and it never logs. It never opens a file either, so a
 * "found" file is a regular file at its path, not one proven readable: the export reads each
 * one as it streams it and fails if it cannot (BL-1384).
 */

/** How many problems one answer lists in full. Counts are always exact. */
export const UPLOAD_PROBLEM_LIST_LIMIT = 10_000
/** How many paths the export error's sentence names before "and N more". */
export const UPLOAD_PROBLEM_MESSAGE_PATHS = 5
const MESSAGE_PATH_MAX_CHARS = 160

/**
 * `missing` is ENOENT on the file itself and nothing else. Every other stat error is
 * `unreadable` with its code (EACCES, EIO, ELOOP, ENOTDIR, ...): calling those "missing"
 * sends the user looking for a file that may be right there (BL-1373). `unsupported-record`
 * is a record a backup cannot carry whatever the file's state (BL-1380): it is never stat'ed.
 */
export type UploadFileProblemKind = 'missing' | 'unreadable' | 'not-a-file' | 'unsupported-record'

export type UploadRootProblemKind = 'root-missing' | 'root-not-directory' | 'root-unreadable'

export interface UploadInspectionTarget {
  key: string
  relativePath: string
  /** The record still holds a legacy Base64 copy, which the export uses when `stat` cannot find the file. */
  hasLegacyBase64: boolean
  /**
   * BL-1380: the record names a file but is stored in a shape the export only copies as it is
   * (a Redis string), so its file would never reach the backup. It is reported, never checked.
   */
  unsupportedRecord?: boolean
  size: number | null
  uploadedAt: string | null
  originalName: string | null
  sha256: string | null
}

export interface UploadFileProblem {
  key: string
  relativePath: string
  kind: UploadFileProblemKind
  /** The stat error's code, for `unreadable`; null otherwise. */
  code: string | null
  size: number | null
  uploadedAt: string | null
  originalName: string | null
  sha256: string | null
}

export interface UploadRootProblem {
  kind: UploadRootProblemKind
  code: string | null
}

export interface UploadInspection<T extends UploadInspectionTarget = UploadInspectionTarget> {
  uploadRoot: string
  /**
   * Upload records that name a file in the upload folder and whose file the check looks for.
   * An unsupported record (BL-1380) is never looked for, so it counts only as its problem.
   */
  fileBackedCount: number
  /** Of those, the ones whose path `stat` finds as a regular file (not read; see above). */
  foundCount: number
  /** Of those, the ones `stat` could not find but whose legacy Base64 copy will be used. */
  legacyCopyCount: number
  /** The distinct files among them (BL-378 Phase 1b: files and records are never added together). */
  legacyCopyFileCount: number
  found: Array<{ target: T; sourcePath: string; byteLength: number }>
  /** Every problem, in record order (never truncated here). */
  problems: UploadFileProblem[]
  /** Set when the upload folder itself is unusable; then no file was checked. */
  rootProblem: UploadRootProblem | null
}

export interface UploadInspectionFailure {
  status: 409 | 500
  message: string
  details: Record<string, unknown>
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((field) => `${JSON.stringify(field)}:${canonicalJson(record[field])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * sha256 of the stored upload record (key and value, keys sorted), as read now. Any later
 * change to the record changes it, so an exact-list acknowledgement can bind to it.
 */
export function uploadRecordFingerprint(key: string, value: unknown): string {
  return createHash('sha256').update(canonicalJson({ key, value })).digest('hex')
}

/**
 * BL-378 Phase 1b: sha256 of an archived record (keys sorted) as the archive carries it: an entry
 * of `redis/records/` is the record's JSON, so the export hashes its record after a JSON round
 * trip and a restore hashes the record it parsed from that entry. Both see the same JSON.
 */
export function archivedRecordSha256(record: object): string {
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(record)))).digest('hex')
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : null
}

function problemFrom(target: UploadInspectionTarget, kind: UploadFileProblemKind, code: string | null): UploadFileProblem {
  return {
    key: target.key,
    relativePath: target.relativePath,
    kind,
    code,
    size: target.size,
    uploadedAt: target.uploadedAt,
    originalName: target.originalName,
    sha256: target.sha256
  }
}

async function inspectUploadRoot(uploadRoot: string): Promise<UploadRootProblem | null> {
  let stat
  try {
    stat = await fs.stat(uploadRoot)
  } catch (error) {
    const code = errorCode(error)
    return { kind: code === 'ENOENT' ? 'root-missing' : 'root-unreadable', code }
  }
  return stat.isDirectory() ? null : { kind: 'root-not-directory', code: null }
}

/**
 * Checks every target's file, in order, and collects every problem instead of stopping at
 * the first one. The upload folder is checked only when some record needs a file from it (a
 * record with a legacy Base64 copy does not), so an instance with no file-backed uploads
 * backs up without an uploads folder. `resolvePath` must refuse a path outside the folder.
 */
export async function inspectUploadFiles<T extends UploadInspectionTarget>(input: {
  uploadRoot: string
  targets: readonly T[]
  resolvePath: (relativePath: string) => string
}): Promise<UploadInspection<T>> {
  const { uploadRoot, targets } = input
  const result: UploadInspection<T> = {
    uploadRoot,
    fileBackedCount: targets.filter((target) => !target.unsupportedRecord).length,
    foundCount: 0,
    legacyCopyCount: 0,
    legacyCopyFileCount: 0,
    found: [],
    problems: [],
    rootProblem: null
  }

  if (targets.some((target) => !target.hasLegacyBase64 && !target.unsupportedRecord)) {
    result.rootProblem = await inspectUploadRoot(uploadRoot)
    if (result.rootProblem) return result
  }

  const legacyCopyPaths = new Set<string>()
  for (const target of targets) {
    if (target.unsupportedRecord) {
      result.problems.push(problemFrom(target, 'unsupported-record', null))
      continue
    }
    const sourcePath = input.resolvePath(target.relativePath)
    let stat
    try {
      stat = await fs.stat(sourcePath)
    } catch (error) {
      // The legacy Base64 copy is the record's own data: the export streams it instead.
      if (target.hasLegacyBase64) {
        result.legacyCopyCount += 1
        legacyCopyPaths.add(target.relativePath)
        result.legacyCopyFileCount = legacyCopyPaths.size
        continue
      }
      const code = errorCode(error)
      result.problems.push(problemFrom(target, code === 'ENOENT' ? 'missing' : 'unreadable', code === 'ENOENT' ? null : code))
      continue
    }
    if (!stat.isFile()) {
      result.problems.push(problemFrom(target, 'not-a-file', null))
      continue
    }
    result.foundCount += 1
    result.found.push({ target, sourcePath, byteLength: stat.size })
  }

  return result
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many
}

function shortPath(value: string) {
  return value.length > MESSAGE_PATH_MAX_CHARS ? `${value.slice(0, MESSAGE_PATH_MAX_CHARS - 1)}…` : value
}

function describeProblemPath(problem: UploadFileProblem) {
  const path = shortPath(problem.relativePath)
  if (problem.kind === 'missing') return path
  if (problem.kind === 'not-a-file') return `${path} (not a file)`
  if (problem.kind === 'unsupported-record') return `${path} (unsupported record)`
  return `${path} (unreadable${problem.code ? `: ${problem.code}` : ''})`
}

/** Why legacy copies beside a folder that holds none of the files do not show the folder is right. */
function legacyCopyNote(legacyCopyCount: number) {
  if (legacyCopyCount === 0) return ''
  return legacyCopyCount === 1
    ? ' (1 older upload is saved inside its record and does not need the folder)'
    : ` (${legacyCopyCount} older uploads are saved inside their records and do not need the folder)`
}

/** Distinct files among the problems: several records may name the same path. */
export function countUploadProblemFiles(problems: readonly UploadFileProblem[]) {
  return new Set(problems.map((problem) => problem.relativePath)).size
}

/**
 * BL-1388 (rev 4 [C1]): not one file the check looked for was in the upload folder, and every
 * problem is a missing file, so the folder itself may be the wrong one. It holds only while a
 * missing problem remains (at least one problem, every one `missing`); a root problem leaves
 * no problems, so it never holds then. Legacy Base64 copies do not change it: a record that
 * falls back to the copy in its record never needed the folder, so it says nothing about
 * whether the folder is right; it changes only the words. The export sentence, the Check
 * Upload Files hint (through the audit's answer) and a later partial backup all ask this.
 */
export function uploadFolderFoundNothing(inspection: Pick<UploadInspection, 'foundCount' | 'problems'>): boolean {
  return (
    inspection.foundCount === 0 &&
    inspection.problems.length > 0 &&
    inspection.problems.every((problem) => problem.kind === 'missing')
  )
}

/** Problem records by kind (records, not distinct files). */
export function countUploadProblems(problems: readonly UploadFileProblem[]) {
  const counts = { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 0 }
  for (const problem of problems) {
    if (problem.kind === 'missing') counts.missing += 1
    else if (problem.kind === 'unreadable') counts.unreadable += 1
    else if (problem.kind === 'not-a-file') counts.notAFile += 1
    else counts.unsupportedRecord += 1
  }
  return counts
}

/**
 * The export's one error for an inspection that cannot be backed up, or null when it can.
 * A normal export always stops here. 500 when the folder or a file could not be read (the
 * state of the data is unknown); 409 when files are missing or are not files (the saved
 * records disagree with the folder), or a record is one the backup cannot carry. The sentence
 * is bounded; `details` carries every
 * problem up to `listLimit` and says when the list is cut.
 */
export function describeUploadInspectionFailure(
  inspection: UploadInspection,
  options: { listLimit?: number } = {}
): UploadInspectionFailure | null {
  const listLimit = options.listLimit ?? UPLOAD_PROBLEM_LIST_LIMIT
  const { uploadRoot, fileBackedCount } = inspection

  if (inspection.rootProblem) {
    const { kind, code } = inspection.rootProblem
    const what =
      kind === 'root-missing'
        ? 'was not found'
        : kind === 'root-not-directory'
          ? 'is not a folder'
          : `could not be read${code ? ` (${code})` : ''}`
    return {
      status: 500,
      message:
        `Backup stopped: Batshit's upload folder ${uploadRoot} ${what}, so none of the ` +
        `${fileBackedCount} uploaded ${plural(fileBackedCount, 'file', 'files')} could be checked. ` +
        'batshit-server creates this folder when it starts, so the app and batshit-server may be using ' +
        'different upload folders (UPLOADS_DIR), or a drive or Docker volume is not connected.',
      details: {
        code: 'BACKUP_UPLOAD_ROOT_UNAVAILABLE',
        uploadRoot,
        rootProblem: { kind, code },
        fileBackedCount
      }
    }
  }

  const { problems } = inspection
  if (problems.length === 0) return null

  const counts = countUploadProblems(problems)
  // Two records can name one file (an avatar saved under both key forms): count files, not records.
  const fileCount = countUploadProblemFiles(problems)
  const what =
    fileCount === problems.length
      ? `${fileCount} uploaded ${plural(fileCount, 'file', 'files')}`
      : `${fileCount} uploaded ${plural(fileCount, 'file', 'files')} (${problems.length} upload records)`
  const parts = [
    counts.missing > 0 ? `${counts.missing} missing` : null,
    counts.unreadable > 0 ? `${counts.unreadable} unreadable` : null,
    counts.notAFile > 0 ? `${counts.notAFile} not a file` : null,
    counts.unsupportedRecord > 0
      ? `${counts.unsupportedRecord} ${plural(counts.unsupportedRecord, 'unsupported record', 'unsupported records')}`
      : null
  ].filter(Boolean)
  const named = problems.slice(0, UPLOAD_PROBLEM_MESSAGE_PATHS).map(describeProblemPath)
  const more = problems.length > named.length ? `, and ${problems.length - named.length} more` : ''
  const truncated = problems.length > listLimit
  // When no file was looked for at all (every upload record naming a file is an unsupported one, BL-1380).
  const looked = fileBackedCount > 0 ? `; ${inspection.foundCount} of ${fileBackedCount} found in ${uploadRoot}` : ''
  const message =
    `Backup stopped: ${what} cannot be backed up ` +
    `(${parts.join(', ')}${looked}): ` +
    `${named.join(', ')}${more}. ` +
    'Settings → Admin → Backup and Restore → Check Upload Files lists each one with what it belongs to and how to fix it.' +
    // BL-1388: only when every problem is a missing file and nothing was found (an unreadable
    // path may still hold its file). A legacy copy does not count either way: it only adds words.
    (uploadFolderFoundNothing(inspection)
      ? ` None of the files were found${legacyCopyNote(inspection.legacyCopyCount)}: ` +
        'if the upload folder moved, or a drive or Docker volume is not connected, fix that first.'
      : '') +
    (truncated ? ` That list shows the first ${listLimit} of ${problems.length}.` : '')

  return {
    status: counts.unreadable > 0 ? 500 : 409,
    message,
    details: {
      code: 'BACKUP_UPLOAD_FILES_UNAVAILABLE',
      uploadRoot,
      fileBackedCount,
      foundCount: inspection.foundCount,
      legacyCopyCount: inspection.legacyCopyCount,
      problemCount: problems.length,
      problemFileCount: fileCount,
      counts,
      problems: problems.slice(0, listLimit),
      truncated,
      listLimit
    }
  }
}

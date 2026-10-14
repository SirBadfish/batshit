import type { BackupUploadCheck, BackupUploadProblem } from '$lib/types/backupUploadCheck'

/** BL-378: the Backup card's read-only "Check Upload Files" request. It never sends a body. */
export async function fetchBackupUploadCheck(): Promise<BackupUploadCheck> {
  const response = await fetch('/api/admin/backup/missing-uploads', { method: 'GET' })
  let payload: { audit?: BackupUploadCheck; error?: unknown } | null = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || !payload?.audit) {
    const message = typeof payload?.error === 'string' && payload.error ? payload.error : null
    throw new Error(message ?? `Checking upload files failed (HTTP ${response.status}).`)
  }
  return payload.audit
}

/**
 * BL-1388: the card's wrong-folder hint, shown only when the server's shared predicate holds
 * (`uploadFolderFoundNothing`), never worked out again from the card's own counts. Every
 * problem is then a missing file, so the problem counts are the missing files and records.
 * Legacy copies only add a sentence: they never needed the folder.
 */
export function describeUploadFolderHint(check: BackupUploadCheck): string | null {
  if (!check.uploadFolderFoundNothing) return null
  const records = check.problemCount !== check.problemFileCount ? ` (${check.problemCount} upload records)` : ''
  const notFound =
    check.problemFileCount === 1
      ? `The uploaded file${records} was not found in ${check.uploadRoot}.`
      : `None of the ${check.problemFileCount} uploaded files${records} were found in ${check.uploadRoot}.`
  const legacy =
    check.legacyCopyCount === 0
      ? ''
      : check.legacyCopyCount === 1
        ? ' 1 older upload is saved inside its record and does not need the folder.'
        : ` ${check.legacyCopyCount} older uploads are saved inside their records and do not need the folder.`
  return `${notFound}${legacy} If the upload folder moved, or a drive or Docker volume is not connected, fix that first.`
}

/**
 * BL-378 Phase 1b §1: a partial backup is offered only beside a full list (not cut) whose every
 * row is a missing file. An unreadable file, a folder in a file's place, an unsupported record or
 * an upload folder problem is never something a partial backup can leave out.
 */
export function canMakePartialBackup(check: BackupUploadCheck | null): check is BackupUploadCheck {
  return (
    check !== null &&
    check.rootProblem === null &&
    !check.truncated &&
    check.problems.length > 0 &&
    check.problems.length === check.problemCount &&
    check.problems.every((problem) => problem.kind === 'missing')
  )
}

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

export interface PartialBackupConfirmation {
  title: string
  description: string[]
  /** The second box, only when the server's predicate says the folder held none of the files. */
  checkbox: { label: string } | null
}

/**
 * The confirmation for "Make a Partial Backup" ([C4] [B1]). Files first, records when they
 * differ. When not one file was found in the folder (`uploadFolderFoundNothing`, the server's
 * one predicate), a second paragraph and a second box: the folder may be the wrong one, and
 * older uploads saved inside their records never needed it, so they prove nothing about it.
 */
export function describePartialBackupConfirmation(check: BackupUploadCheck): PartialBackupConfirmation {
  const files = check.problemFileCount
  const records = check.problemCount !== files ? ` (${counted(check.problemCount, 'upload record', 'upload records')})` : ''
  const description = [
    `Batshit did not find ${counted(files, 'upload file', 'upload files')}${records} where it expects ${files === 1 ? 'it' : 'them'} in ${check.uploadRoot}. ` +
      'A partial backup contains the upload files and records that are available and names each missing file; it cannot contain the missing files. ' +
      'Skill and voice folders it cannot carry are still listed, as in any backup.'
  ]
  if (!check.uploadFolderFoundNothing) return { title: 'Make a Partial Backup?', description, checkbox: null }
  const none = files === 1
    ? `The upload file Batshit expects is not in ${check.uploadRoot}.`
    : `None of the ${files} upload files Batshit expects are in ${check.uploadRoot}.`
  const legacy = check.legacyCopyFileCount
  const holds = legacy === 0
    ? 'this partial backup would contain no upload files at all.'
    : `this partial backup would contain only the ${counted(legacy, 'older upload file', 'older upload files')} saved inside ${legacy === 1 ? 'its record' : 'their records'}, and none from the folder.`
  description.push(
    `${none} If your upload folder moved, or a drive or Docker volume is not connected, cancel and fix that first: ${holds}`
  )
  return {
    title: 'Make a Partial Backup?',
    description,
    checkbox: { label: 'The upload folder is the right one. Make the partial backup anyway.' }
  }
}

export function describeUploadProblemKind(problem: BackupUploadProblem): string {
  if (problem.kind === 'missing') return 'Missing'
  if (problem.kind === 'not-a-file') return 'Not a file'
  if (problem.kind === 'unsupported-record') return 'Unsupported record'
  return problem.code ? `Unreadable (${problem.code})` : 'Unreadable'
}

/**
 * BL-378 Phase 1b: the shape of a partial backup's request, and of the one bounded summary that
 * says how its acknowledged entries ended. The server writes the summary in the export's
 * `X-Batshit-Backup-Missing-Uploads` header; the packaged Mac export hands the same header
 * string back in its result. The Admin panel reads both with ONE strict parser: anything but the
 * exact shape is "unavailable", never a zero and never a claim that nothing is missing.
 *
 * Pure: no server import and no browser API, so the server, the panel and the tests share it.
 */

export const BACKUP_MISSING_UPLOADS_HEADER = 'X-Batshit-Backup-Missing-Uploads'

/** Acknowledged entries per request: the same bound as the upload check's list (`UPLOAD_PROBLEM_LIST_LIMIT`). */
export const BACKUP_PARTIAL_ENTRY_LIMIT = 10_000

/**
 * A key or path in a partial request or manifest: at most this many UTF-16 code units
 * (`string.length`), the measure the packaged Mac export already applies to a path.
 */
export const BACKUP_PARTIAL_STRING_MAX = 4096

/**
 * The export request is read through this byte cap before it is parsed; a larger body is a 413.
 * The staged restore reader reads `manifest.json` only up to the same 2 MiB.
 */
export const BACKUP_EXPORT_REQUEST_MAX_BYTES = 2 * 1024 * 1024

/** One problem record of the upload check, as the check listed it. */
export interface BackupPartialAcknowledgement {
  key: string
  relativePath: string
  /** The record's fingerprint from the check (64 lowercase hex characters). */
  fingerprint: string
}

/** The export's `partial` option. There is no generic skip flag. */
export interface BackupPartialRequest {
  acknowledged: BackupPartialAcknowledgement[]
  /** Only when the user ticked the second box: nothing the check looked for was in the upload folder. */
  confirmAllMissing?: true
}

export type BackupCompleteness = 'complete' | 'partial'

/**
 * How the acknowledged entries ended. Files and records are never added together:
 * `missingFiles` and `foundAgainFiles` count distinct paths, the rest count records.
 */
export interface BackupMissingUploadsSummary {
  completeness: BackupCompleteness
  missingFiles: number
  missingRecords: number
  foundAgainFiles: number
  goneRecords: number
  otherRecords: number
}

const SUMMARY_KEYS = [
  'completeness',
  'missingFiles',
  'missingRecords',
  'foundAgainFiles',
  'goneRecords',
  'otherRecords'
] as const
const COUNT_KEYS = ['missingFiles', 'missingRecords', 'foundAgainFiles', 'goneRecords', 'otherRecords'] as const
/** The real header is about 130 characters; anything much longer is not one. */
const SUMMARY_MAX_CHARS = 512

/** Compact JSON with the keys in one fixed order. */
export function encodeMissingUploadsSummary(summary: BackupMissingUploadsSummary): string {
  return JSON.stringify({
    completeness: summary.completeness,
    missingFiles: summary.missingFiles,
    missingRecords: summary.missingRecords,
    foundAgainFiles: summary.foundAgainFiles,
    goneRecords: summary.goneRecords,
    otherRecords: summary.otherRecords
  })
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= BACKUP_PARTIAL_ENTRY_LIMIT
}

/**
 * The summary, or null ("unavailable") for anything that is not exactly it: no header, invalid
 * JSON, an extra or missing key, a wrong type, a fraction, a negative, a count above the bound,
 * or counts that disagree with the completeness. `complete` has nothing missing and accounts for
 * at least one acknowledged entry; `partial` has at least one missing file; a file count never
 * exceeds its record count.
 */
export function parseMissingUploadsSummary(value: unknown): BackupMissingUploadsSummary | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > SUMMARY_MAX_CHARS) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== SUMMARY_KEYS.length || !SUMMARY_KEYS.every((key) => Object.hasOwn(record, key))) return null
  const completeness = record.completeness
  if (completeness !== 'complete' && completeness !== 'partial') return null
  if (!COUNT_KEYS.every((key) => isCount(record[key]))) return null
  const summary: BackupMissingUploadsSummary = {
    completeness,
    missingFiles: record.missingFiles as number,
    missingRecords: record.missingRecords as number,
    foundAgainFiles: record.foundAgainFiles as number,
    goneRecords: record.goneRecords as number,
    otherRecords: record.otherRecords as number
  }
  if (summary.missingFiles > summary.missingRecords) return null
  if (completeness === 'complete') {
    if (summary.missingFiles !== 0 || summary.missingRecords !== 0) return null
    if (summary.foundAgainFiles + summary.goneRecords + summary.otherRecords === 0) return null
  } else if (summary.missingFiles === 0) {
    return null
  }
  return summary
}

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

/** Entries the export found no longer missing, as parts of one sentence; zero parts are left out. */
function resolvedParts(summary: BackupMissingUploadsSummary) {
  return [
    summary.foundAgainFiles > 0 ? `${counted(summary.foundAgainFiles, 'file', 'files')} found again` : null,
    summary.goneRecords > 0
      ? `${counted(summary.goneRecords, 'record', 'records')} no longer ${summary.goneRecords === 1 ? 'exists' : 'exist'}`
      : null,
    summary.otherRecords > 0 ? `${counted(summary.otherRecords, 'record', 'records')} changed` : null
  ].filter((part): part is string => part !== null)
}

/**
 * The export's sentence for a partial request that finished downloading. It says only what the
 * summary says: a missing or malformed summary gives a sentence that claims neither a count nor
 * that nothing is missing. A complete result never says the backup is complete, only that no
 * upload files remain missing.
 */
export function describeBackupExportSummary(summary: BackupMissingUploadsSummary | null): string {
  if (!summary) {
    return (
      'Backup exported, but Batshit could not read its missing-upload summary, so it cannot say which upload files are in it. ' +
      'Run Check Upload Files to see which are missing now.'
    )
  }
  const parts = resolvedParts(summary)
  if (summary.completeness === 'partial') {
    const records =
      summary.missingRecords !== summary.missingFiles ? ` (${counted(summary.missingRecords, 'upload record', 'upload records')})` : ''
    const notIn = summary.missingFiles === 1 ? 'is not in it' : 'are not in it'
    return (
      `Partial backup exported: ${counted(summary.missingFiles, 'upload file', 'upload files')}${records} Batshit did not find ${notIn}.` +
      (parts.length > 0 ? ` Since the check: ${parts.join(', ')}.` : '')
    )
  }
  if (summary.goneRecords === 0 && summary.otherRecords === 0) {
    const files = summary.foundAgainFiles
    return `Backup exported. The ${counted(files, 'upload file', 'upload files')} marked as missing ${files === 1 ? 'was' : 'were'} found again, so no upload files remain missing.`
  }
  if (summary.foundAgainFiles === 0 && summary.otherRecords === 0) {
    const records = summary.goneRecords
    return `Backup exported. The ${counted(records, 'upload record', 'upload records')} marked as missing no longer ${records === 1 ? 'exists' : 'exist'}, so no upload files remain missing.`
  }
  return `Backup exported. No upload files remain missing: ${parts.join(', ')}.`
}

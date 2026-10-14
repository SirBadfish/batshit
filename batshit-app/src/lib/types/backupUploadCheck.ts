/**
 * BL-378: the answer of `GET /api/admin/backup/missing-uploads`, the read-only Admin check of
 * the upload files a backup must carry. Shared by the server and the Backup card.
 */

/** `unsupported-record`: a record a backup cannot carry (a Redis string naming a file, BL-1380). */
export type BackupUploadProblemKind = 'missing' | 'unreadable' | 'not-a-file' | 'unsupported-record'

export type BackupUploadOwnerKind =
  | 'clip'
  | 'clip-original'
  | 'avatar'
  | 'memory-media'
  | 'goon'
  | 'goon-scene'
  | 'hair-import'
  | 'unknown'

export interface BackupUploadOwner {
  kind: BackupUploadOwnerKind
  /**
   * `found`: a current saved record points at this file. `not-found`: none was found. This is
   * current-only evidence: it never proves the file is unused and never permits deleting it.
   * `lookup-failed`: reading the owners failed; the label gives the reason.
   */
  state: 'found' | 'not-found' | 'lookup-failed'
  /** What the file belongs to, in words. */
  label: string
  /** Where and how to fix it with the owner's own controls. */
  repair: string
  /** Something the user notices right now (a standing Awareness image fails every send). */
  urgent: boolean
}

export interface BackupUploadProblem {
  key: string
  relativePath: string
  kind: BackupUploadProblemKind
  code: string | null
  size: number | null
  uploadedAt: string | null
  originalName: string | null
  sha256: string | null
  /** sha256 of the stored record as read now, for a later exact-list acknowledgement. */
  fingerprint: string
  owner: BackupUploadOwner
}

export interface BackupUploadCheck {
  checkedAt: string
  uploadRoot: string
  fileBackedCount: number
  foundCount: number
  legacyCopyCount: number
  /** The distinct files among the legacy copies (BL-378 Phase 1b: files and records are never added together). */
  legacyCopyFileCount: number
  /** Problem upload records. */
  problemCount: number
  /** Distinct files among them: two records can name one file (an avatar under both key forms). */
  problemFileCount: number
  /** Problem records by kind. */
  counts: { missing: number; unreadable: number; notAFile: number; unsupportedRecord: number }
  /** The first `listLimit` problems; `truncated` says when there are more. */
  problems: BackupUploadProblem[]
  truncated: boolean
  listLimit: number
  rootProblem: { kind: 'root-missing' | 'root-not-directory' | 'root-unreadable'; code: string | null } | null
  /**
   * BL-1388: the shared `uploadFolderFoundNothing` answer for this check: not one file was found
   * in the folder and every problem is a missing file (legacy copies do not change it). The card
   * shows its folder hint from this, never from its own counts.
   */
  uploadFolderFoundNothing: boolean
  /**
   * The export's own sentence for this state, or null when the check found no problem. The
   * check only stats each path; the export still reads every file and stops if one cannot be
   * read (BL-1384).
   */
  exportBlockedMessage: string | null
}

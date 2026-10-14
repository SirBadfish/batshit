import { json, type RequestHandler } from '@sveltejs/kit'

import {
  BackupRestoreError,
  auditBackupUploadFiles,
  summarizeBackupError
} from '$lib/server/services/backupRestoreService'
import { requireAdmin } from '$lib/server/services/routeSecurity'

/**
 * BL-378: the read-only Admin "Check Upload Files" audit. It lists each upload file that `stat`
 * cannot find as a regular file (missing, unreadable, or not a file) with what it belongs to now
 * and where to fix it. It opens no file and writes nothing (BL-1384).
 */
export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response

  try {
    const audit = await auditBackupUploadFiles(admin.value.id)
    return json({ audit })
  } catch (error) {
    // The message only: an error object here can carry stored record details.
    console.error(
      '[backup-upload-check] failed:',
      error instanceof BackupRestoreError || error instanceof Error ? error.message : 'unknown error'
    )
    const result = summarizeBackupError(error)
    return json(result.body, { status: result.status })
  }
}

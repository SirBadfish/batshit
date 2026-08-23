import { json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import {
  beginBackupRestoreMaintenance,
  restoreStagedBackup,
  summarizeBackupError
} from '$lib/server/services/backupRestoreService'

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  try {
    const body = await request.json().catch(() => null)
    const stageId = typeof body?.stageId === 'string' ? body.stageId : ''
    const confirmReplace = body?.confirmReplace === true
    const endMaintenance = await beginBackupRestoreMaintenance()
    try {
      const result = await restoreStagedBackup(locals.user.id, stageId, { confirmReplace })
      return json(result)
    } finally {
      endMaintenance()
    }
  } catch (err) {
    console.error('[backup-restore] failed', err)
    const result = summarizeBackupError(err)
    return json(result.body, { status: result.status })
  }
}

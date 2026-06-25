import { json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import {
  BackupRestoreError,
  restoreBackupBundle,
  summarizeBackupError
} from '$lib/server/services/backupRestoreService'

type UploadedBackupFile = {
  arrayBuffer: () => Promise<ArrayBuffer>
}

function isUploadedBackupFile(value: unknown): value is UploadedBackupFile {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  )
}

async function readRestoreRequest(request: Request) {
  const form = await request.formData().catch(() => null)
  const file = form?.get('backup') ?? form?.get('file')
  if (!isUploadedBackupFile(file)) {
    throw new BackupRestoreError('Upload a Batshit backup zip file.', 400)
  }

  const confirmReplace = form?.get('confirmReplace') === 'true'
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    confirmReplace
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  try {
    const { bytes, confirmReplace } = await readRestoreRequest(request)
    const result = await restoreBackupBundle(locals.user.id, bytes, { confirmReplace })
    return json(result)
  } catch (err) {
    console.error('[backup-restore] failed', err)
    const result = summarizeBackupError(err)
    return json(result.body, { status: result.status })
  }
}

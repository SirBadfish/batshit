import { json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import { createBackupBundleStream, summarizeBackupError } from '$lib/server/services/backupRestoreService'

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  const body = await request.json().catch(() => ({}))
  const includeSecrets = body?.includeSecrets === true
  if (includeSecrets && body?.confirmIncludeSecrets !== true) {
    return json(
      {
        error:
          'Export with secrets requires explicit confirmation because the backup may contain saved credentials.'
      },
      { status: 400 }
    )
  }

  try {
    const bundle = await createBackupBundleStream(locals.user.id, { includeSecrets })
    return new Response(bundle.stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${bundle.filename}"`,
        'X-Batshit-Backup-Schema': String(bundle.manifest.schemaVersion),
        'X-Batshit-Backup-Includes-Secrets': includeSecrets ? 'true' : 'false'
      }
    })
  } catch (err) {
    console.error('[backup-export] failed', err)
    const result = summarizeBackupError(err)
    return json(result.body, { status: result.status })
  }
}

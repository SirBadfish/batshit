import { json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'

import {
  BackupRestoreError,
  createBackupBundleStream,
  encodeNotCarriedHeader,
  parseBackupPartialRequest,
  summarizeBackupError,
  type BackupBundleStream
} from '$lib/server/services/backupRestoreService'
import {
  BACKUP_EXPORT_REQUEST_MAX_BYTES,
  BACKUP_MISSING_UPLOADS_HEADER,
  encodeMissingUploadsSummary,
  type BackupPartialRequest
} from '$lib/utils/backupPartialSummary'

class ExportBodyTooLarge extends Error {}

/**
 * BL-378 Phase 1b §2a row 1a: the body is read through a 2 MiB byte cap BEFORE it is parsed, so a
 * partial request's list is bounded by bytes, never by the app's 1 GB `BODY_SIZE_LIMIT`. The
 * declared length is only the early refusal for an honest caller; the streamed count is the cap
 * (a chunked request carries no Content-Length). An empty body is an empty request, as before.
 */
async function readBoundedExportBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > BACKUP_EXPORT_REQUEST_MAX_BYTES) throw new ExportBodyTooLarge()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > BACKUP_EXPORT_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ExportBodyTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return apiError('Unauthorized', 401)
  }
  if (!locals.user.is_admin) {
    return apiError('Forbidden', 403)
  }

  let text: string
  try {
    text = await readBoundedExportBody(request)
  } catch (error) {
    if (error instanceof ExportBodyTooLarge) {
      return json(
        { error: 'That backup request is too large.', details: { limitBytes: BACKUP_EXPORT_REQUEST_MAX_BYTES } },
        { status: 413 }
      )
    }
    return json({ error: 'The backup request could not be read.', details: null }, { status: 400 })
  }
  // As before, a body that is not JSON asks for an ordinary backup with the default options. A
  // partial backup is asked for only by a `partial` option, and that option is checked whole.
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = text ? JSON.parse(text) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
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

  let bundle: BackupBundleStream | null = null
  try {
    const partial: BackupPartialRequest | null = Object.hasOwn(body, 'partial') ? parseBackupPartialRequest(body.partial) : null
    bundle = await createBackupBundleStream(locals.user.id, { includeSecrets, partial })
    return new Response(bundle.stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${bundle.filename}"`,
        'X-Batshit-Backup-Schema': String(bundle.manifest.schemaVersion),
        'X-Batshit-Backup-Includes-Secrets': includeSecrets ? 'true' : 'false',
        // BL-373/BL-369: the skill and voice folders this backup could not carry whole. The
        // export still completes; the Admin toast and the restore's Inspect name them.
        'X-Batshit-Backup-Not-Carried': encodeNotCarriedHeader(bundle.manifest.hostFiles?.notCarried ?? []),
        // BL-378 Phase 1b: only for a partial request, how its acknowledged entries ended.
        ...(bundle.missingUploads
          ? { [BACKUP_MISSING_UPLOADS_HEADER]: encodeMissingUploadsSummary(bundle.missingUploads) }
          : {})
      }
    })
  } catch (err) {
    // BL-1401: the stream holds the restore gate until it is over. One built before a failure
    // here is never read, so cancel it: that ends the hold once its cleanup has finished.
    if (bundle) await bundle.stream.cancel().catch(() => undefined)
    // BL-378: a backup error's details list every problem upload record; log its sentence only.
    if (err instanceof BackupRestoreError) console.error('[backup-export] failed:', err.status, err.message)
    else console.error('[backup-export] failed', err)
    const result = summarizeBackupError(err)
    return json(result.body, { status: result.status })
  }
}

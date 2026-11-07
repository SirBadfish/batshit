import { json, type RequestHandler } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/services/routeSecurity'
import { getAutomaticBackupView, updateAutomaticBackupConfig } from '$lib/server/services/automaticBackupService'
import { AutomaticBackupError } from '$lib/server/services/automaticBackupConfig'

function failure(error: unknown) {
  return json({ code: error instanceof AutomaticBackupError && error.status < 500 ? 'automatic_backup_refused' : 'automatic_backup_unavailable',
    error: error instanceof AutomaticBackupError ? error.message : 'Automatic backup settings could not be confirmed. Existing backup files were kept.' },
    { status: error instanceof AutomaticBackupError ? error.status : 500 })
}

/** Only cookie-authenticated Admin locals; no service token, agent or App Action admission. */
export const GET: RequestHandler = async ({ locals }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response
  try { return json(await getAutomaticBackupView(admin.value.id), { headers: { 'Cache-Control': 'no-store' } }) }
  catch (error) { return failure(error) }
}

export const PUT: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdmin(locals)
  if (!admin.ok) return admin.response
  // This fixed small body cannot become a generic path/command execution interface.
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 16_384) {
          void reader.cancel().catch(() => undefined)
          return json({ error: 'Automatic backup settings are too large.' }, { status: 413 })
        }
        chunks.push(chunk.value)
      }
    } catch { return json({ error: 'Automatic backup settings could not be read.' }, { status: 400 }) }
    finally { reader.releaseLock() }
  }
  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  let body: unknown
  try { body = JSON.parse(text) } catch { return json({ error: 'Invalid automatic backup settings.' }, { status: 400 }) }
  try { return json(await updateAutomaticBackupConfig(admin.value.id, body)) }
  catch (error) { return failure(error) }
}

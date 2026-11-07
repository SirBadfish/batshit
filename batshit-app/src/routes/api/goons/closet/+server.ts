import { json, type RequestHandler } from '@sveltejs/kit'
import { deleteGoonUploadAssetDisposition } from '$lib/server/services/goonAssetCleanupService'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  resolveUploadUrlsForBrowserInPayload,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const form = await request.formData()
  const fileValue = form.get('file')
  const file = fileValue instanceof File ? fileValue : null

  if (!file) {
    return json({ error: 'No file uploaded' }, { status: 400 })
  }

  const uploadForm = new FormData()
  uploadForm.append('file', file, file.name)

  const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon-closet`, {
    method: 'POST',
    headers: getInternalBatshitServerAuthHeaders(),
    body: uploadForm
  })

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => '')
    return json({ error: text || 'Closet upload failed' }, { status: uploadResponse.status })
  }

  const payload = rewriteInternalBatshitServerUrlsInPayload(await uploadResponse.json())
  return json(resolveUploadUrlsForBrowserInPayload(payload))
}

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const filename = typeof body?.filename === 'string' ? body.filename : ''
  if (!filename || /[/\\\0]/.test(filename)) {
    return json({ error: 'Filename is required' }, { status: 400 })
  }

  try {
    // The app owns reservation and fresh borrower audit. A browser-supplied
    // token or upload type is never authority for physical file deletion.
    const disposition = await deleteGoonUploadAssetDisposition('goon_closet', filename)
    return json({ success: true, disposition, deleted: disposition === 'deleted',
      retained: disposition === 'retained', missing: disposition === 'missing' })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Closet delete failed' }, { status: 500 })
  }
}

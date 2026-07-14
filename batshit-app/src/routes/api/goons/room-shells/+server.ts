import { json, type RequestHandler } from '@sveltejs/kit'
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

  const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon-room-shell`, {
    method: 'POST',
    headers: getInternalBatshitServerAuthHeaders(),
    body: uploadForm
  })

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => '')
    return json({ error: text || 'Room shell upload failed' }, { status: uploadResponse.status })
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
  if (!filename) {
    return json({ error: 'Filename is required' }, { status: 400 })
  }

  const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon-room-shell`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
    body: JSON.stringify({ filename })
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return json({ error: text || 'Room shell delete failed' }, { status: response.status })
  }

  return json({ success: true })
}

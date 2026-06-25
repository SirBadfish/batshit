import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonRecord } from '$lib/types/goons'

async function readUploadError(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text) return 'DUF clothes upload failed'

  try {
    const payload = JSON.parse(text) as { error?: string; details?: string }
    if (typeof payload.error === 'string' && typeof payload.details === 'string') {
      return `${payload.error}: ${payload.details}`
    }
    if (typeof payload.error === 'string') {
      return payload.error
    }
  } catch {
    // Fall through to HTML/plain-text cleanup.
  }

  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'DUF clothes upload failed'
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!params.id) {
    return json({ error: 'Goon id is required' }, { status: 400 })
  }

  const goonId = params.id

  try {
    const goon = await redis.execute(async (client) => {
      const existing = (await client.json.get(`goon:${goonId}`)) as GoonRecord | null
      if (!existing) return null
      if (existing.user_id !== locals.user!.id) return null
      return existing
    })

    if (!goon) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }

    if (goon.sourceProfile !== 'guided-custom-vrm') {
      return json(
        { error: 'Only Advanced/Blender Goons accept DUF clothes imports.' },
        { status: 400 }
      )
    }

    const form = await request.formData()
    const fileValue = form.get('file')
    const file = fileValue instanceof File ? fileValue : null

    if (!file) {
      return json({ error: 'DUF clothes import requires a .vrm file.' }, { status: 400 })
    }

    if (!file.name.toLowerCase().endsWith('.vrm')) {
      return json({ error: 'DUF clothes import requires a .vrm file.' }, { status: 400 })
    }

    const uploadForm = new FormData()
    uploadForm.append('file', file, file.name)

    const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: uploadForm
    })

    if (!uploadResponse.ok) {
      const error = await readUploadError(uploadResponse)
      return json({ error }, { status: uploadResponse.status || 500 })
    }

    const uploadPayload = rewriteInternalBatshitServerUrlsInPayload(
      await uploadResponse.json()
    )
    const fileInfo = uploadPayload?.file || null

    if (!fileInfo?.url) {
      return json({ error: 'DUF clothes upload failed to return a URL.' }, { status: 500 })
    }

    return json({ file: fileInfo })
  } catch (error) {
    console.error('Error uploading DUF clothes VRM:', error)
    return json({ error: 'Failed to upload DUF clothes VRM' }, { status: 500 })
  }
}

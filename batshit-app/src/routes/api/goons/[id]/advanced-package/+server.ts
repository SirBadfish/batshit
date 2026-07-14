import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  resolveUploadUrlsForBrowserInPayload,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonRecord } from '$lib/types/goons'

async function readUploadError(response: Response, fallback: string) {
  const text = await response.text().catch(() => '')
  if (!text) return fallback

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

  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || fallback
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

    const profile =
      goon.sourceProfile === 'guided-custom-vrm'
        ? 'guided-custom-vrm'
        : goon.sourceProfile === 'expert-custom-glb'
          ? 'expert-custom-glb'
          : null

    if (!profile) {
      return json(
        { error: 'Only Advanced/Blender and Advanced/GLB Goons accept Goon File Package updates.' },
        { status: 400 }
      )
    }

    const packageLabel =
      profile === 'guided-custom-vrm' ? 'Advanced/Blender Goon File Package' : 'Advanced/GLB Goon File Package'

    const form = await request.formData()
    const fileValue = form.get('file')
    const file = fileValue instanceof File ? fileValue : null

    if (!file) {
      return json({ error: 'Goon File Package is required.' }, { status: 400 })
    }

    const lowerName = file.name.toLowerCase()
    if (!lowerName.endsWith('.bgoon') && !lowerName.endsWith('.zip')) {
      return json({ error: 'Goon File Package must be a .bgoon or .zip archive.' }, { status: 400 })
    }

    const uploadForm = new FormData()
    uploadForm.append('file', file, file.name)

    const uploadPath =
      profile === 'guided-custom-vrm'
        ? '/api/upload/goon-guided-package'
        : '/api/upload/goon-custom-package'

    const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}${uploadPath}`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: uploadForm
    })

    if (!uploadResponse.ok) {
      const error = await readUploadError(uploadResponse, `${packageLabel} upload failed`)
      return json({ error }, { status: uploadResponse.status || 500 })
    }

    const uploadPayload = rewriteInternalBatshitServerUrlsInPayload(
      await uploadResponse.json()
    )
    const files = uploadPayload?.files ?? null

    const unpackedComplete =
      profile === 'guided-custom-vrm'
        ? Boolean(files?.package?.url && files?.vrm?.url && files?.manifest?.url)
        : Boolean(files?.package?.url && files?.model?.url && files?.manifest?.url)

    if (!unpackedComplete) {
      return json(
        { error: 'Goon File Package upload failed to return unpacked files.' },
        { status: 500 }
      )
    }

    return json({
      profile,
      files: resolveUploadUrlsForBrowserInPayload(files),
      manifestData: uploadPayload?.manifestData ?? null
    })
  } catch (error) {
    console.error('Error uploading Goon File Package:', error)
    return json({ error: 'Failed to upload Goon File Package' }, { status: 500 })
  }
}

import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import { loadGoonFacialArtworkDefinition } from '$lib/server/services/facialArtwork.server'
import {
  collectGoonUploadReferencesForClient,
  deleteGoonUploadAsset,
  hasGoonUploadReference
} from '$lib/server/services/goonAssetCleanupService'
import type { GoonRecord } from '$lib/types/goons'

async function readUploadError(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text) return 'Facial artwork upload failed.'
  try {
    const payload = JSON.parse(text) as { error?: string; details?: string }
    if (payload.error && payload.details) return `${payload.error}: ${payload.details}`
    if (payload.error) return payload.error
  } catch {
    // Plain-text errors are returned below after light cleanup.
  }
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'Facial artwork upload failed.'
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!params.id) return json({ error: 'Goon id is required' }, { status: 400 })

  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return json({ error: 'Facial artwork PNG is required.' }, { status: 400 })
    }

    const goon = await redis.execute(async (client) => {
      const current = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
      if (!current || current.user_id !== locals.user!.id) return null
      const definition = await loadGoonFacialArtworkDefinition(client as any, current)
      return { current, definition }
    })
    if (!goon) return json({ error: 'Goon not found' }, { status: 404 })
    if (!goon.definition) {
      return json({ error: 'This Goon package does not support facial artwork.' }, { status: 400 })
    }

    const expectedHash = String(form.get('definitionSha256') ?? '')
    if (expectedHash !== goon.definition.definitionSha256) {
      return json(
        { error: 'The Goon package changed. Reopen Facial Artwork before uploading.' },
        { status: 409 }
      )
    }

    const forward = new FormData()
    forward.append('file', file, file.name)
    for (const field of [
      'role',
      'definitionSha256',
      'templateId',
      'templateVersion',
      'orientation',
      'guideSha256',
      'maskSha256',
      'provenance'
    ]) {
      const value = form.get(field)
      if (typeof value === 'string') forward.append(field, value)
    }

    const response = await fetch(
      `${getInternalBatshitServerUrl()}/api/upload/goon-facial-artwork`,
      {
        method: 'POST',
        headers: getInternalBatshitServerAuthHeaders(),
        body: forward
      }
    )
    if (!response.ok) {
      return json({ error: await readUploadError(response) }, { status: response.status || 500 })
    }

    const payload = rewriteInternalBatshitServerUrlsInPayload(await response.json())
    const filePayload = payload?.file
    const artwork = payload?.artwork
    if (!filePayload?.url || !filePayload?.filename || !artwork?.sha256) {
      return json({ error: 'Facial artwork storage returned an incomplete record.' }, { status: 500 })
    }
    return json({
      artwork: {
        role: artwork.role,
        url: filePayload.url,
        filename: filePayload.filename,
        size: filePayload.size,
        mimeType: 'image/png',
        sha256: artwork.sha256,
        template: artwork.template,
        provenance: artwork.provenance
      }
    })
  } catch (error) {
    console.error('Error uploading facial artwork:', error)
    if (error instanceof Error && error.message.startsWith('[facial-artwork/v6]')) {
      return json({ error: error.message }, { status: 400 })
    }
    return json({ error: 'Failed to upload facial artwork' }, { status: 500 })
  }
}

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!params.id) return json({ error: 'Goon id is required' }, { status: 400 })

  try {
    const body = (await request.json()) as { filename?: unknown }
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      return json({ error: 'A valid artwork filename is required.' }, { status: 400 })
    }

    const result = await redis.execute(async (client) => {
      const goon = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
      if (!goon || goon.user_id !== locals.user!.id) return 'missing' as const
      const references = await collectGoonUploadReferencesForClient(client as any, locals.user!.id)
      if (hasGoonUploadReference(references, 'goon_facial_artwork', filename)) {
        return 'referenced' as const
      }
      return 'delete' as const
    })
    if (result === 'missing') return json({ error: 'Goon not found' }, { status: 404 })
    if (result === 'referenced') {
      return json({ error: 'Saved facial artwork cannot be deleted while it is in use.' }, { status: 409 })
    }
    await deleteGoonUploadAsset('goon_facial_artwork', filename)
    return json({ success: true })
  } catch (error) {
    console.error('Error deleting draft facial artwork:', error)
    return json({ error: 'Failed to delete draft facial artwork' }, { status: 500 })
  }
}

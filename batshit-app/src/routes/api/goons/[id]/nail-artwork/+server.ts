import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import { loadGoonNailSurfaceDefinition } from '$lib/server/services/nailSurface.server'
import {
  collectGoonUploadReferencesForClient,
  deleteGoonUploadAsset,
  hasGoonUploadReference
} from '$lib/server/services/goonAssetCleanupService'
import type { NailFamily } from '$lib/goons/nailSurface'
import type { GoonRecord } from '$lib/types/goons'

const NAIL_FAMILIES = new Set<NailFamily>(['fingers', 'toes'])

async function readUploadError(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text) return 'Nail Artwork upload failed.'
  try {
    const payload = JSON.parse(text) as { error?: string; details?: string }
    if (payload.error && payload.details) return `${payload.error}: ${payload.details}`
    if (payload.error) return payload.error
  } catch {
    // Plain-text errors are returned below after light cleanup.
  }
  return (
    text
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Nail Artwork upload failed.'
  )
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!params.id) return json({ error: 'Goon id is required' }, { status: 400 })
  try {
    const form = await request.formData()
    const file = form.get('file')
    const family = String(form.get('family') ?? '') as NailFamily
    if (!(file instanceof File)) {
      return json({ error: 'Nail Artwork PNG is required.' }, { status: 400 })
    }
    if (!NAIL_FAMILIES.has(family)) {
      return json({ error: 'Nail family must be fingers or toes.' }, { status: 400 })
    }
    const goon = await redis.execute(async (client) => {
      const current = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
      if (!current || current.user_id !== locals.user!.id) return null
      const definition = await loadGoonNailSurfaceDefinition(client as any, current)
      return { definition }
    })
    if (!goon) return json({ error: 'Goon not found' }, { status: 404 })
    if (!goon.definition) {
      return json({ error: 'This Goon package does not support Nail Surface.' }, { status: 400 })
    }
    const expectedHash = String(form.get('definitionSha256') ?? '')
    if (expectedHash !== goon.definition.definitionSha256) {
      return json(
        { error: 'The Goon package changed. Reopen Nails before uploading.' },
        { status: 409 }
      )
    }

    const template = goon.definition.templates[family]
    const forward = new FormData()
    forward.append('file', file, file.name)
    forward.append('family', family)
    forward.append('definitionSha256', goon.definition.definitionSha256)
    forward.append('templateId', template.id)
    forward.append('templateVersion', template.version)
    forward.append('guideSha256', template.guide.sha256)
    forward.append('slotMaskSha256', template.slotMask.sha256)
    forward.append('baseArtworkSha256', template.baseArtwork.sha256)
    forward.append('width', String(template.dimensions[0]))
    forward.append('height', String(template.dimensions[1]))
    const provenance = form.get('provenance')
    if (typeof provenance === 'string') forward.append('provenance', provenance)

    const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon-nail-artwork`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: forward
    })
    if (!response.ok) {
      return json({ error: await readUploadError(response) }, { status: response.status || 500 })
    }
    const payload = rewriteInternalBatshitServerUrlsInPayload(await response.json())
    const filePayload = payload?.file
    const artwork = payload?.artwork
    if (!filePayload?.url || !filePayload?.filename || !artwork?.sha256) {
      return json({ error: 'Nail Artwork storage returned an incomplete record.' }, { status: 500 })
    }
    return json({
      artwork: {
        schemaVersion: 'nail-artwork/v1',
        family,
        url: filePayload.url,
        filename: filePayload.filename,
        size: filePayload.size,
        mimeType: 'image/png',
        sha256: artwork.sha256,
        definitionSha256: artwork.definitionSha256,
        template: artwork.template,
        provenance: artwork.provenance
      }
    })
  } catch (error) {
    console.error('Error uploading Nail Artwork:', error)
    if (
      error instanceof Error &&
      (error.message.startsWith('[nail-surface/v1]') ||
        error.message.startsWith('[nail-artwork/v1]'))
    ) {
      return json({ error: error.message }, { status: 400 })
    }
    return json({ error: 'Failed to upload Nail Artwork' }, { status: 500 })
  }
}

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!params.id) return json({ error: 'Goon id is required' }, { status: 400 })
  try {
    const body = (await request.json()) as { filename?: unknown }
    const filename = typeof body.filename === 'string' ? body.filename.trim() : ''
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      return json({ error: 'A valid artwork filename is required.' }, { status: 400 })
    }
    const result = await redis.execute(async (client) => {
      const goon = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
      if (!goon || goon.user_id !== locals.user!.id) return 'missing' as const
      const references = await collectGoonUploadReferencesForClient(client as any, locals.user!.id)
      return hasGoonUploadReference(references, 'goon_nail_artwork', filename)
        ? ('referenced' as const)
        : ('delete' as const)
    })
    if (result === 'missing') return json({ error: 'Goon not found' }, { status: 404 })
    if (result === 'referenced') {
      return json(
        { error: 'Saved Nail Artwork cannot be deleted while it is in use.' },
        { status: 409 }
      )
    }
    await deleteGoonUploadAsset('goon_nail_artwork', filename)
    return json({ success: true })
  } catch (error) {
    console.error('Error deleting draft Nail Artwork:', error)
    return json({ error: 'Failed to delete draft Nail Artwork' }, { status: 500 })
  }
}

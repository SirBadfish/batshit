import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import { loadGoonSkinAppearanceDefinition } from '$lib/server/services/skinAppearance.server'
import {
  collectGoonUploadReferencesForClient,
  deleteGoonUploadAsset,
  hasGoonUploadReference
} from '$lib/server/services/goonAssetCleanupService'
import {
  SKIN_SURFACE_MAP_ROLES,
  type SkinSurfaceMapRole
} from '$lib/goons/skinSurface'
import type { GoonRecord } from '$lib/types/goons'

function parseRole(value: FormDataEntryValue | null): SkinSurfaceMapRole | null {
  return typeof value === 'string' &&
    SKIN_SURFACE_MAP_ROLES.includes(value as SkinSurfaceMapRole)
    ? (value as SkinSurfaceMapRole)
    : null
}

function roleLabel(role: SkinSurfaceMapRole) {
  return role === 'baseColor'
    ? 'Base Color'
    : role[0].toUpperCase() + role.slice(1)
}

async function readUploadError(response: Response, role: SkinSurfaceMapRole) {
  const text = await response.text().catch(() => '')
  if (!text) return `${roleLabel(role)} upload failed.`
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
      .trim() || `${roleLabel(role)} upload failed.`
  )
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!params.id) return json({ error: 'Goon id is required' }, { status: 400 })
  try {
    const form = await request.formData()
    const role = parseRole(form.get('map'))
    if (!role) return json({ error: 'A valid Skin Surface map role is required.' }, { status: 400 })
    const file = form.get('file')
    if (!(file instanceof File)) {
      return json({ error: `${roleLabel(role)} PNG is required.` }, { status: 400 })
    }
    const goon = await redis.execute(async (client) => {
      const current = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
      if (!current || current.user_id !== locals.user!.id) return null
      const definition = await loadGoonSkinAppearanceDefinition(client as any, current)
      return { definition }
    })
    if (!goon) return json({ error: 'Goon not found' }, { status: 404 })
    if (!goon.definition) {
      return json(
        { error: 'This Goon package does not support Skin Surface Artwork.' },
        { status: 400 }
      )
    }
    const expectedHash = String(form.get('definitionSha256') ?? '')
    if (expectedHash !== goon.definition.definitionSha256) {
      return json(
        { error: `The Goon package changed. Reopen ${roleLabel(role)} before uploading.` },
        { status: 409 }
      )
    }

    const forward = new FormData()
    forward.append('file', file, file.name)
    forward.append('map', role)
    forward.append('definitionSha256', goon.definition.definitionSha256)
    const provenance = form.get('provenance')
    if (typeof provenance === 'string') forward.append('provenance', provenance)

    const response = await fetch(
      `${getInternalBatshitServerUrl()}/api/upload/goon-skin-surface-artwork`,
      {
        method: 'POST',
        headers: getInternalBatshitServerAuthHeaders(),
        body: forward
      }
    )
    if (!response.ok) {
      return json(
        { error: await readUploadError(response, role) },
        { status: response.status || 500 }
      )
    }
    const payload = rewriteInternalBatshitServerUrlsInPayload(
      await response.json()
    )
    const filePayload = payload?.file
    const artwork = payload?.artwork
    if (
      !filePayload?.url ||
      !filePayload?.filename ||
      !artwork?.sha256 ||
      artwork.map !== role
    ) {
      return json(
        { error: `${roleLabel(role)} storage returned an incomplete record.` },
        { status: 500 }
      )
    }
    return json({
      artwork: {
        schemaVersion: 'skin-surface-artwork/v1',
        map: role,
        url: filePayload.url,
        filename: filePayload.filename,
        size: filePayload.size,
        mimeType: 'image/png',
        sha256: artwork.sha256,
        definitionSha256: artwork.definitionSha256,
        canvas: artwork.canvas,
        provenance: artwork.provenance
      },
      preparation: payload?.preparation
    })
  } catch (error) {
    console.error('Error uploading Skin Surface Artwork:', error)
    if (
      error instanceof Error &&
      (error.message.startsWith('[skin-appearance/v2]') ||
        error.message.startsWith('[skin-surface-artwork/v1]'))
    ) {
      return json({ error: error.message }, { status: 400 })
    }
    return json({ error: 'Failed to upload Skin Surface Artwork' }, { status: 500 })
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
      const references = await collectGoonUploadReferencesForClient(
        client as any,
        locals.user!.id
      )
      return hasGoonUploadReference(references, 'goon_skin_artwork', filename)
        ? ('referenced' as const)
        : ('delete' as const)
    })
    if (result === 'missing') return json({ error: 'Goon not found' }, { status: 404 })
    if (result === 'referenced') {
      return json(
        { error: 'Saved Skin Surface Artwork cannot be deleted while it is in use.' },
        { status: 409 }
      )
    }
    await deleteGoonUploadAsset('goon_skin_artwork', filename)
    return json({ success: true })
  } catch (error) {
    console.error('Error deleting draft Skin Surface Artwork:', error)
    return json({ error: 'Failed to delete draft Skin Surface Artwork' }, { status: 500 })
  }
}

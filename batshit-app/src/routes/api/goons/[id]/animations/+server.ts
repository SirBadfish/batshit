import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonFileRef, GoonRecord } from '$lib/types/goons'
import {
  collectGoonUploadReferencesForClient,
  deleteGoonUploadAsset,
  hasGoonUploadReference
} from '$lib/server/services/goonAssetCleanupService'

const ANIMATION_EXTENSIONS = new Set(['.glb', '.gltf', '.vrma'])

function isAnimationExtension(filename: string) {
  const lower = filename.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return false
  return ANIMATION_EXTENSIONS.has(lower.slice(dot))
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const form = await request.formData()
    const fileValue = form.get('file')
    const file = fileValue instanceof File ? fileValue : null

    if (!file) {
      return json({ error: 'No file uploaded.' }, { status: 400 })
    }

    if (!isAnimationExtension(file.name)) {
      return json({ error: 'Goon animation files must be .glb, .gltf, or .vrma.' }, { status: 400 })
    }

    const goon = await redis.execute(async (client) => {
      const existing = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
      if (!existing || existing.user_id !== locals.user!.id) return null
      return existing
    })

    if (!goon) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }

    const uploadForm = new FormData()
    uploadForm.append('file', file, file.name)

    const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon-animation`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: uploadForm
    })

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => '')
      throw new Error(text || 'Goon animation upload failed')
    }

    const uploadPayload = rewriteInternalBatshitServerUrlsInPayload(
      await uploadResponse.json()
    )
    const fileInfo = uploadPayload?.file

    if (!fileInfo?.url || !fileInfo?.filename) {
      return json({ error: 'Goon animation upload failed to return a URL.' }, { status: 500 })
    }

    const animationFile: GoonFileRef = {
      url: fileInfo.url,
      filename: fileInfo.filename,
      originalName: fileInfo.originalName || file.name,
      size: fileInfo.size ?? file.size,
      mimeType: fileInfo.mimetype ?? file.type,
      uploadedAt: fileInfo.uploadedAt ?? new Date().toISOString()
    }

	    const updated = await redis.execute(async (client) => {
	      const existing = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
	      if (!existing || existing.user_id !== locals.user!.id) return null

      const currentAnimations = Array.isArray(existing.files?.animations)
        ? existing.files?.animations ?? []
        : []

      const nextAnimations = currentAnimations.some((entry) => entry.filename === animationFile.filename)
        ? currentAnimations
        : [...currentAnimations, animationFile]

      const updatedGoon: GoonRecord = {
        ...existing,
        files: {
          ...(existing.files ?? {}),
          animations: nextAnimations
        },
        updated_at: new Date().toISOString()
      }

      await client.json.set(`goon:${params.id}`, '$', updatedGoon as any)
      return updatedGoon
    })

    if (!updated) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }

    return json({ goon: updated, animation: animationFile })
  } catch (error) {
    console.error('Error uploading goon animation:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to upload goon animation' },
      { status: 500 }
    )
  }
}

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = await request.json().catch(() => ({}))
    const filename = typeof payload?.filename === 'string' ? payload.filename : ''
    if (!filename) {
      return json({ error: 'Missing filename.' }, { status: 400 })
    }

    const updated = await redis.execute(async (client) => {
      const existing = (await client.json.get(`goon:${params.id}`)) as GoonRecord | null
      if (!existing || existing.user_id !== locals.user!.id) return null

      const currentAnimations = Array.isArray(existing.files?.animations)
        ? existing.files?.animations ?? []
        : []

      const nextAnimations = currentAnimations.filter((entry) => entry.filename !== filename)

      const updatedGoon: GoonRecord = {
        ...existing,
        files: {
          ...(existing.files ?? {}),
          animations: nextAnimations
        },
        updated_at: new Date().toISOString()
      }

	      await client.json.set(`goon:${params.id}`, '$', updatedGoon as any)
	      return updatedGoon
	    })

	    if (!updated) {
	      return json({ error: 'Goon not found' }, { status: 404 })
	    }

	    const stillReferenced = await redis.execute(async (client) => {
	      const references = await collectGoonUploadReferencesForClient(client as any, locals.user!.id)
	      return hasGoonUploadReference(references, 'goon_animations', filename)
	    })

	    if (!stillReferenced) {
	      await deleteGoonUploadAsset('goon_animations', filename)
	    }

	    return json({ goon: updated })
  } catch (error) {
    console.error('Error deleting goon animation:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to delete goon animation' },
      { status: 500 }
    )
  }
}

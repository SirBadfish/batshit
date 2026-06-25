import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonAnimationLibrary, GoonFileRef } from '$lib/types/goons'
import { deleteGoonUploadAsset } from '$lib/server/services/goonAssetCleanupService'

function normalizePreviewVideo(value: unknown): GoonFileRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === 'string' ? raw.url : ''
  const filename = typeof raw.filename === 'string' ? raw.filename : ''
  if (!url || !filename) return null
  return {
    url,
    filename,
    originalName:
      typeof raw.originalName === 'string'
        ? raw.originalName
        : typeof raw.originalname === 'string'
          ? raw.originalname
          : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    mimeType:
      typeof raw.mimeType === 'string'
        ? raw.mimeType
        : typeof raw.mimetype === 'string'
          ? raw.mimetype
          : undefined,
    uploadedAt:
      typeof raw.uploadedAt === 'string'
        ? raw.uploadedAt
        : typeof raw.uploaded_at === 'string'
          ? raw.uploaded_at
          : undefined
  }
}

function normalizeLibrary(value: unknown): GoonAnimationLibrary {
  if (!value || typeof value !== 'object') {
    return { vrma: [] }
  }
  const record = value as GoonAnimationLibrary
  return {
    ...record,
    vrma: Array.isArray(record.vrma) ? record.vrma : []
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const form = await request.formData()
    const animationFilenameValue = form.get('animationFilename')
    const fileValue = form.get('file')

    const animationFilename =
      typeof animationFilenameValue === 'string' ? animationFilenameValue.trim() : ''
    const file = fileValue instanceof File ? fileValue : null

    if (!animationFilename) {
      return json({ error: 'Missing animation filename.' }, { status: 400 })
    }

    if (!file) {
      return json({ error: 'No preview file uploaded.' }, { status: 400 })
    }

    const uploadForm = new FormData()
    uploadForm.append('file', file, file.name)

    const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon-animation-preview`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: uploadForm
    })

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => '')
      throw new Error(text || 'Animation preview upload failed')
    }

    const uploadPayload = rewriteInternalBatshitServerUrlsInPayload(
      await uploadResponse.json()
    )
    const previewVideo = normalizePreviewVideo(uploadPayload?.file)
    if (!previewVideo) {
      return json({ error: 'Animation preview upload failed to return a URL.' }, { status: 500 })
    }

	    let previousPreviewFilename: string | undefined
	    const updated = await redis.execute(async (client) => {
	      const key = `user:${locals.user!.id}:goons_animation_library`
	      const existing = (await client.json.get(key)) as GoonAnimationLibrary | null
      const library = normalizeLibrary(existing)
      const current = Array.isArray(library.vrma) ? library.vrma : []
      const existingEntry = current.find((entry) => entry.filename === animationFilename) ?? null

	      if (!existingEntry) {
	        return null
	      }

	      previousPreviewFilename = existingEntry.previewVideo?.filename
	      const next = current.map((entry) =>
        entry.filename === animationFilename
          ? {
              ...entry,
              previewVideo
            }
          : entry
      )

      const nextLibrary: GoonAnimationLibrary = {
        ...library,
        vrma: next,
        updated_at: new Date().toISOString()
      }

	      await client.json.set(key, '$', nextLibrary as any)
	      return nextLibrary
	    })

	    if (!updated) {
	      await deleteGoonUploadAsset('goon_animation_previews', previewVideo.filename)
	      return json({ error: 'Animation not found.' }, { status: 404 })
	    }

	    if (previousPreviewFilename && previousPreviewFilename !== previewVideo.filename) {
	      await deleteGoonUploadAsset('goon_animation_previews', previousPreviewFilename)
	    }

	    return json({ library: updated, previewVideo })
  } catch (error) {
    console.error('Error uploading animation preview:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to upload animation preview' },
      { status: 500 }
    )
  }
}

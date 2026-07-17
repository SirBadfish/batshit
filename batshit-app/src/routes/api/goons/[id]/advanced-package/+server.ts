import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  resolveUploadUrlsForBrowserInPayload,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonRecord } from '$lib/types/goons'
import {
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  createRecipeArchiveContainmentReceipt,
  verifyRecipeArchiveContainmentReceipt,
  type RecipeArchiveContainmentReceipt
} from '$lib/goons/recipe'
import { deleteGoonUploadAsset } from '$lib/server/services/goonAssetCleanupService'

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

async function cleanupCustomPackageFiles(files: Record<string, any> | null) {
  const assets = [
    ['goon_custom_packages', files?.package?.filename],
    ['goon_custom_models', files?.model?.filename],
    ['goon_custom_manifests', files?.manifest?.filename]
  ] as const
  await Promise.all(
    assets.map(async ([uploadType, filename]) => {
      if (!filename) return
      await deleteGoonUploadAsset(uploadType, filename).catch((error) => {
        console.error('[Recipe archive] Failed to clean rejected staged asset:', error)
      })
    })
  )
}

async function buildArchiveReceipt(
  extraction: any,
  files: Record<string, any>
): Promise<RecipeArchiveContainmentReceipt> {
  if (
    extraction?.contract !== 'recipe-archive-extraction/v1' ||
    extraction?.extractor?.id !== 'batshit-server-recipe-archive' ||
    extraction?.extractor?.version !== 1
  ) {
    throw new Error('batshit-server did not return a trusted Recipe archive extraction result')
  }
  const receipt = await createRecipeArchiveContainmentReceipt({
    contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    archiveFormat: 'zip',
    extractor: extraction.extractor,
    archive: extraction.archive,
    entryCount: extraction.entryCount,
    totalUncompressedBytes: extraction.totalUncompressedBytes,
    members: extraction.members
  })
  const expectedRefs = [
    `/uploads/goon_custom_packages/${files.package.filename}`,
    `/uploads/goon_custom_models/${files.model.filename}`,
    `/uploads/goon_custom_manifests/${files.manifest.filename}`
  ]
  const actualRefs = [
    receipt.archive.ref,
    receipt.members.find((member) => member.role === 'model')?.extracted.ref,
    receipt.members.find((member) => member.role === 'manifest')?.extracted.ref
  ]
  if (expectedRefs.some((ref) => !actualRefs.includes(ref))) {
    throw new Error('Recipe archive extraction refs do not match the stored upload assets')
  }
  return verifyRecipeArchiveContainmentReceipt(receipt)
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

    let archiveReceipt: RecipeArchiveContainmentReceipt | null = null
    if (profile === 'expert-custom-glb') {
      try {
        archiveReceipt = await buildArchiveReceipt(uploadPayload?.archiveExtraction, files)
      } catch (error) {
        await cleanupCustomPackageFiles(files)
        throw error
      }
    }

    return json({
      profile,
      files: resolveUploadUrlsForBrowserInPayload(files),
      manifestData: uploadPayload?.manifestData ?? null,
      archiveReceipt
    })
  } catch (error) {
    console.error('Error uploading Goon File Package:', error)
    return json({ error: 'Failed to upload Goon File Package' }, { status: 500 })
  }
}

import { json, type RequestHandler } from '@sveltejs/kit'

import { verifyRecipeArchiveContainmentReceipt } from '$lib/goons/recipe'
import { redis } from '$lib/server/redis'
import {
  collectGoonUploadReferencesForClient,
  deleteGoonUploadAsset,
  deleteUnreferencedGoonUploadReferences,
  type GoonAssetReferenceMap,
  type GoonUploadType
} from '$lib/server/services/goonAssetCleanupService'
import type { GoonRecord } from '$lib/types/goons'

function candidateReference(
  candidates: GoonAssetReferenceMap,
  uploadType: GoonUploadType,
  ref: string
) {
  const prefix = `/uploads/${uploadType}/`
  if (!ref.startsWith(prefix)) {
    throw new Error(`Recipe cleanup asset is outside ${uploadType}.`)
  }
  const filename = decodeURIComponent(ref.slice(prefix.length))
  if (!filename || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`Recipe cleanup asset has an invalid ${uploadType} filename.`)
  }
  candidates.set(`${uploadType}/${filename}`, new Set(['Rejected Recipe package upload']))
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user?.id
  const goonId = params.id
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!goonId) return json({ error: 'Goon id is required' }, { status: 400 })

  try {
    const receipt = await verifyRecipeArchiveContainmentReceipt(
      (await request.json()).archiveReceipt
    )
    const goon = await redis.json.get(`goon:${goonId}`) as GoonRecord | null
    if (!goon || goon.user_id !== userId) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }

    const model = receipt.members.find((member) => member.role === 'model')
    const manifest = receipt.members.find((member) => member.role === 'manifest')
    if (!model || !manifest) throw new Error('Recipe archive receipt is incomplete.')

    const candidates: GoonAssetReferenceMap = new Map()
    candidateReference(candidates, 'goon_custom_packages', receipt.archive.ref)
    candidateReference(candidates, 'goon_custom_models', model.extracted.ref)
    candidateReference(candidates, 'goon_custom_manifests', manifest.extracted.ref)

    const remainingReferences = await redis.execute((client) =>
      collectGoonUploadReferencesForClient(client as any, userId)
    )
    const deleted = await deleteUnreferencedGoonUploadReferences(
      candidates,
      remainingReferences,
      deleteGoonUploadAsset
    )
    const retained = Array.from(candidates.keys())
      .filter((key) => !deleted.includes(key))
      .sort((left, right) => left.localeCompare(right))

    return json({ deleted, retained })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: message }, { status: 500 })
  }
}

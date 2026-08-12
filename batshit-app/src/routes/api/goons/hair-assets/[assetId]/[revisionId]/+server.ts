import { json, type RequestHandler } from '@sveltejs/kit'

import {
  HairAssetRepositoryError,
  deleteUserHairAssetRevision
} from '$lib/server/services/hairAssetRepository.server'
import { requireUser } from '$lib/server/services/routeSecurity'

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  if (!params.assetId || !params.revisionId) {
    return json({ error: 'Hair Asset identity is required.' }, { status: 400 })
  }
  try {
    const asset = await deleteUserHairAssetRevision(
      user.value.id,
      params.assetId,
      params.revisionId
    )
    return json({ deleted: true, asset })
  } catch (error) {
    console.error('[hair-assets] immutable revision deletion failed:', error)
    if (error instanceof HairAssetRepositoryError) {
      return json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status }
      )
    }
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to delete Hair Asset revision.'
      },
      { status: 500 }
    )
  }
}

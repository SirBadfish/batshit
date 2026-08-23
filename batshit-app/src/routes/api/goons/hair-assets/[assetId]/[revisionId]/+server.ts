import { json, type RequestHandler } from '@sveltejs/kit'

import {
  HairAssetRepositoryError,
  deleteUserHairAssetRevision,
  resolveHairAssetRevision
} from '$lib/server/services/hairAssetRepository.server'
import { requireUser } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  if (!params.assetId || !params.revisionId) {
    return json({ error: 'Hair Asset identity is required.' }, { status: 400 })
  }
  const revisionSha256 = url.searchParams.get('sha256')
  if (!revisionSha256 || !/^[a-f0-9]{64}$/.test(revisionSha256)) {
    return json({ error: 'Exact Hair Asset revision sha256 is required.' }, { status: 400 })
  }
  try {
    const asset = await resolveHairAssetRevision(user.value.id, {
      assetId: params.assetId,
      assetRevisionId: params.revisionId,
      assetRevisionSha256: revisionSha256
    })
    return json({ asset })
  } catch (error) {
    console.error('[hair-assets] immutable revision lookup failed:', error)
    if (error instanceof HairAssetRepositoryError) {
      return json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status }
      )
    }
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load Hair Asset revision.' },
      { status: 500 }
    )
  }
}

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

import { json, type RequestHandler } from '@sveltejs/kit'

import {
  HairAssetRepositoryError,
  listHairAssets,
  listHairRefitSources,
  putUserHairAssetRevision
} from '$lib/server/services/hairAssetRepository.server'
import { requireUser } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const [assets, refitSources] = await Promise.all([
      listHairAssets(user.value.id),
      listHairRefitSources(user.value.id)
    ])
    return json({ assets, refitSources })
  } catch (error) {
    console.error('[hair-assets] list failed:', error)
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to load Hair Assets.'
      },
      { status: 500 }
    )
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const payload = await request.json()
    return json({ asset: await putUserHairAssetRevision(user.value.id, payload) }, { status: 201 })
  } catch (error) {
    console.error('[hair-assets] immutable revision registration failed:', error)
    if (error instanceof HairAssetRepositoryError) {
      return json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status }
      )
    }
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to register Hair Asset revision.'
      },
      { status: 400 }
    )
  }
}

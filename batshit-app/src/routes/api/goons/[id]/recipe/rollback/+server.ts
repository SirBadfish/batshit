import { json, type RequestHandler } from '@sveltejs/kit'
import {
  getPreviousRecipeRevisionPreview,
  restorePreviousRecipeRevision
} from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const GET: RequestHandler = async ({ params, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    return json(await getPreviousRecipeRevisionPreview(owner))
  } catch (error) {
    return recipeRouteError(error)
  }
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    return json(await restorePreviousRecipeRevision({
      userId: owner.userId,
      goonId: owner.goonId,
      expectedWriteVersion: body.expectedWriteVersion
    }))
  } catch (error) {
    return recipeRouteError(error)
  }
}

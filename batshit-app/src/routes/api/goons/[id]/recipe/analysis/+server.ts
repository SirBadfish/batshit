import { json, type RequestHandler } from '@sveltejs/kit'
import {
  discardRecipePackageAnalysis,
  getRecipePackageAnalysis
} from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const GET: RequestHandler = async ({ params, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    return json(await getRecipePackageAnalysis({ userId: owner.userId, goonId: owner.goonId }))
  } catch (error) {
    return recipeRouteError(error)
  }
}

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    return json(await discardRecipePackageAnalysis({
      userId: owner.userId,
      goonId: owner.goonId,
      expectedWriteVersion: body.expectedWriteVersion,
      analysisId: body.analysisId,
      confirmed: body.confirmed
    }))
  } catch (error) {
    return recipeRouteError(error)
  }
}
